/**
 * GigList — Setlist.fm Sync Module
 * =================================
 * Single home for all setlist.fm connectivity: fetching, searching,
 * transforming, and writing to Supabase.
 *
 * Writes:
 *   journals        — user's own rows (RLS: user can only write their own)
 *   performances    — shared table (source = setlist.fm, trusted)
 *   venues          — shared table (source = setlist.fm, trusted)
 *
 * Does NOT write venues/performances for manually-added shows — those go
 * through the pending_venues queue instead (handled in editor.js).
 *
 * ─── Fetch API ────────────────────────────────────────────────────────────
 *   fetchUserSetlistPage(username, page)
 *       → { setlists, total } | null (null = user not found or end of pages)
 *         Throws { code: 'user_not_found' } on page 1 with no results.
 *         Throws { code: 'rate_limited' } on 429.
 *
 *   // searchArtists(query)  — see artist-sync.js
 *       → [{ mbid, name, disambiguation }] — ordered by relevance
 *         Used by Gig Search to resolve a typed name before fetching setlists.
 *
 *   fetchArtistSetlists(mbid, page)
 *       → { setlists, total } | null
 *         Fetches setlists for a specific artist (by MusicBrainz ID).
 *         Used by Gig Search to show a pick list for a given artist.
 *
 *   fetchSetlistById(setlistId)
 *       → raw setlist object | null
 *         Used by editor.js for single-show setlist.fm lookup.
 *
 * ─── Transform helpers ────────────────────────────────────────────────────
 *   toUKDate(eventDate)
 *   parseSetlist(sets)   — structured sets/songs (tape, info, cover, with, encore)
 *   parseSongs(sets)     — flat pipe-separated string of PERFORMED songs only
 *   pickSetlist(list, venue) — choose the right setlist when a date has several
 *   groupByShow(setlists)
 *   buildJournalRow(userId, show)
 *   buildVenueRow(venueRaw)
 *
 * ─── Supabase writes ──────────────────────────────────────────────────────
 *   upsertVenues(venueRows)
 *   upsertPerformances(perfRows)
 *   upsertJournals(journalRows)
 *
 * ─── One show (shared by editor.js and setlist-catchup.js) ────────────────
 *   findArtistMbid(name)                 — artist-search → MBID | null
 *   findShowSetlist(mbid, dateUK, venue) — find-show for one date → setlist | null
 *   findFestivalSetlists(lineup, dateUK) — each act over a 3-day window
 *   saveShowSetlists(setlists, opts)     — performances + venue + links for ONE journal
 *   linkJournalVenue / linkJournalToSetlistVenue / linkPerformancesToVenue
 *
 * ─── Full user sync ───────────────────────────────────────────────────────
 *   runSetlistSync(username, { onProgress, onComplete, onError })
 *
 * ─── UI helpers ───────────────────────────────────────────────────────────
 *   showNoSetlistTip()          — called by "I don't have a setlist.fm account" buttons
 *   handleZeroSyncResult(opts)  — called by app.js syncSetlistFm() when 0 rows inserted
 *       opts.userNotFound       — true when the username wasn't found on setlist.fm
 */


import { supabase, authedFetch } from './supabase.js';
import { parseActList } from './utils.js';


export const WORKER_URL = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';


// Venues with any of these keywords in the name are treated as festival sites.
// Matches the logic in onboard_user.py.
const FESTIVAL_KEYWORDS = [
    'worthy farm', 'richfield avenue', 'bramham park', 'hatfield house',
    'little john', 'victoria park', 'hyde park', 'phoenix park',
    'bellahouston', 'finsbury park', 'knebworth', 'milton keynes bowl',
];


// ─── Worker fetch helpers ─────────────────────────────────────────────────────


/**
 * Shared low-level fetch with consistent error handling.
 * Returns the parsed JSON body, or null on 404.
 * Throws a typed error object on 429 or other failures.
 */
async function _workerFetch(params) {
    const qs  = new URLSearchParams(params).toString();
    const res = await authedFetch(`${WORKER_URL}/?${qs}`);

    if (res.status === 404) return null;
    if (res.status === 429) throw Object.assign(new Error('Rate limited by setlist.fm'), { code: 'rate_limited' });
    if (!res.ok)            throw new Error(`setlist.fm proxy returned ${res.status}`);

    return res.json();
}


/**
 * Fetches one page of a user's attended setlists.
 *
 * Returns { setlists, total } when results exist.
 * Returns null when the page is beyond the end of results (404 on page > 1).
 * Throws { code: 'user_not_found' } on page 1 with a 404 — the user doesn't exist.
 * Throws { code: 'rate_limited' } on 429.
 */
export async function fetchUserSetlistPage(username, page = 1) {
    const data = await _workerFetch({ endpoint: 'user-setlists', username, page });

    if (!data) {
        // 404 on page 1 = user doesn't exist; on subsequent pages = end of results
        if (page === 1) throw Object.assign(new Error(`User "${username}" not found on setlist.fm`), { code: 'user_not_found' });
        return null;
    }

    const setlists = data?.setlist || [];
    if (!setlists.length) return null;  // empty page = done

    return { setlists, total: data.total ?? null };
}


/**
 * Searches for artists by name.
 * Returns an array of { mbid, name, disambiguation } objects ordered by
 * setlist.fm's relevance score. Empty array if nothing found.
 *
 * Used by the future Gig Search feature to resolve a typed name to an
 * artist before fetching their setlists.
 *
 * @param {string} query — artist name (partial match is fine)
 */

// searchArtists — see artist-sync.js (canonical home for artist search + archive requests)

/**
 * Fetches one page of setlists for a specific artist (identified by MusicBrainz ID).
 * Returns { setlists, total } or null at end of results.
 *
 * Used by the future Gig Search feature — after the user picks an artist from
 * searchArtists(), call this to get a paginated pick list of their shows.
 *
 * @param {string} mbid  — MusicBrainz artist ID from searchArtists()
 * @param {number} page  — 1-based page number
 */
export async function fetchArtistSetlists(mbid, page = 1) {
    if (!mbid) return null;

    const data = await _workerFetch({ endpoint: 'artist-setlists', mbid, page });
    const setlists = data?.setlist || [];

    if (!setlists.length) return null;

    return { setlists, total: data.total ?? null };
}


/**
 * Fetches a single setlist by its setlist.fm ID.
 * Returns the raw setlist object, or null if not found.
 *
 * Used by editor.js for the "look up this show on setlist.fm" flow.
 *
 * @param {string} setlistId — setlist.fm setlist ID (e.g. "4b193d11")
 */
export async function fetchSetlistById(setlistId) {
    if (!setlistId) return null;

    const data = await _workerFetch({ endpoint: 'setlist', id: setlistId });
    return data || null;
}


// ─── Transform helpers ────────────────────────────────────────────────────────


/**
 * setlist.fm date format: "DD-MM-YYYY" → GigList canonical: "DD/MM/YYYY"
 */
export function toUKDate(eventDate) {
    return eventDate.replace(/-/g, '/');
}


/**
 * Parse the nested sets structure into a compact structured form, keeping
 * the per-song and per-set detail setlist.fm provides:
 *
 *   [{ name?, encore?, songs: [{ name, tape?, info?, cover?, with? }] }]
 *
 *   tape   — true when the track was played over the PA (setlist.fm's
 *            cassette icon), NOT performed live
 *   info   — free-text note, e.g. 'With "X" as intro'
 *   cover  — { name, mbid } of the original artist
 *   with   — { name, mbid } of a guest who joined for the song
 *
 * Optional keys are only present when set, to keep the stored JSON small.
 * Stored in performances.setlist_data.
 */
export function parseSetlist(sets) {
    const out = [];
    for (const set of sets?.set || []) {
        const songs = [];
        for (const s of set?.song || []) {
            if (!s?.name) continue;
            const song = { name: s.name };
            if (s.tape === true || s.tape === 'true') song.tape = true;
            if (s.info)       song.info  = s.info;
            if (s.cover?.name) song.cover = { name: s.cover.name, mbid: s.cover.mbid || null };
            if (s.with?.name)  song.with  = { name: s.with.name,  mbid: s.with.mbid  || null };
            songs.push(song);
        }
        if (!songs.length) continue;
        const entry = { songs };
        if (set.name)   entry.name   = set.name;
        if (set.encore) entry.encore = set.encore;
        out.push(entry);
    }
    return out;
}


/**
 * Parse songs from the nested sets structure into a pipe-separated string.
 * Matches the format used in performances.csv and sync_shared_data.py.
 *
 * Only songs that were actually PERFORMED are included: tape tracks (played
 * over the PA — setlist.fm's cassette icon) are excluded, so this string
 * stays safe to count, search and display as "the setlist". Tape tracks
 * live in setlist_data (see parseSetlist).
 */
export function parseSongs(sets) {
    return parseSetlist(sets)
        .flatMap(set => set.songs.filter(s => !s.tape).map(s => s.name))
        .join(' | ');
}


function isFestivalVenue(venueName) {
    const lower = venueName.toLowerCase();
    return FESTIVAL_KEYWORDS.some(kw => lower.includes(kw));
}


const _haversineKm = (lat1, lon1, lat2, lon2) => {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
};

/**
 * Chooses ONE setlist from the candidates setlist.fm returns for an
 * artist + date. Usually there is exactly one, but an artist can play two
 * shows in a day (a radio session and the arena show, a matinee and an
 * evening, two festival stages), and the API order is arbitrary.
 *
 * Ranking, best first:
 *   1. venue match   — setlist venue id === venue.place_id (setlist.fm id)
 *   2. nearest city  — haversine distance from the journal venue's lat/long
 *                      to the setlist's CITY coords (setlist.fm only gives
 *                      city-level coords, so same-city candidates tie here)
 *   3. most songs    — breaks same-city ties; a 2-song radio session loses
 *                      to a full 21-song arena set
 *
 * Name matching is deliberately NOT used: venues get renamed ("Wembley
 * Arena" vs "The SSE Arena, Wembley") and carry different setlist.fm ids.
 *
 * @param candidates  array of raw setlist.fm setlist objects
 * @param venue       optional { place_id, latitude, longitude } of the
 *                    journal's venue (a venues table row)
 */
export function pickSetlist(candidates, venue = null) {
    const list = (candidates || []).filter(Boolean);
    if (list.length <= 1) return list[0] || null;

    const songCount = sl => parseSongs(sl.sets).split(' | ').filter(Boolean).length;
    const rank = sl => {
        const v = sl.venue || {};
        if (venue?.place_id && v.id === venue.place_id) return { tier: 0, dist: 0 };
        const c = v.city?.coords;
        if (venue?.latitude != null && venue?.longitude != null
            && c?.lat != null && c?.long != null) {
            return { tier: 1, dist: _haversineKm(venue.latitude, venue.longitude, c.lat, c.long) };
        }
        return { tier: 2, dist: 0 };
    };

    const ranked = list
        .map(sl => ({ sl, ...rank(sl), songs: songCount(sl) }))
        .sort((a, b) => a.tier - b.tier
                     || a.dist - b.dist
                     || b.songs - a.songs);

    if (list.length > 1) {
        console.log('pickSetlist: %d candidates for one date, chose %s (%d songs)',
            list.length, ranked[0].sl.venue?.name, ranked[0].songs);
    }
    return ranked[0].sl;
}


/**
 * Groups raw setlist.fm setlists by journal key (date + venue).
 * A single night at a multi-act show produces one journal row but
 * multiple performance rows — same logic as onboard_user.py.
 */
export function groupByShow(setlists) {
    const grouped = new Map();

    for (const sl of setlists) {
        const venue     = sl.venue || {};
        const venueName = venue.name || 'Unknown Venue';
        const dateUK    = toUKDate(sl.eventDate);
        const key       = `${dateUK}${venueName}`;
        const [d, m, y] = dateUK.split('/');

        const artist     = sl.artist?.name || 'Unknown Artist';
        const songs      = parseSongs(sl.sets);
        const structured = parseSetlist(sl.sets);
        // Only store setlist_data when there's something beyond the flat
        // string worth keeping (any sets, or a show-level note)
        const setlistData = (structured.length || sl.info)
            ? { info: sl.info || null, sets: structured }
            : null;

        if (!grouped.has(key)) {
            grouped.set(key, {
                journalKey:   key,
                dateUK,
                d, m, y,
                venueName,
                venueRaw:     venue,         // full setlist.fm venue object
                artists:      [],
                performances: [],
            });
        }

        const show = grouped.get(key);
        show.artists.push(artist);
        show.performances.push({
            journal_key:    key,
            artist,
            role:           'Headline',     // refined below after grouping
            setlist:        songs || null,
            setlist_data:   setlistData,
            setlist_fm_id:  sl.id          || null,
            setlist_version: sl.versionId  || null,
            tour:           sl.tour?.name  || null,
            setlist_url:    sl.url         || null,
            official_venue: venueName,
            date:           dateUK,
            year:           parseInt(y),
            month:          parseInt(m),
            day:            parseInt(d),
        });
    }

    return grouped;
}


/**
 * Builds a journals row from a grouped show.
 * Mirrors the Band/Festival/Support logic in onboard_user.py.
 */
export function buildJournalRow(userId, show) {
    const { journalKey, dateUK, venueName, artists } = show;
    const isFest = isFestivalVenue(venueName);

    let band, notableSupport, festivalLineups, festival;

    if (artists.length === 1) {
        band            = artists[0];
        notableSupport  = null;
        festival        = false;
        festivalLineups = null;
    } else if (isFest) {
        band            = venueName;   // festival name as headliner
        notableSupport  = null;
        festival        = true;
        festivalLineups = artists.join(' / ');
    } else {
        band            = artists[0];  // first = headliner
        notableSupport  = artists.slice(1).join(' / ');
        festival        = false;
        festivalLineups = null;
    }

    // Assign roles to performances now that we know who headlined
    show.performances.forEach(p => {
        p.role = (p.artist === band) ? 'Headline' : 'Support';
    });

    return {
        user_id:          userId,
        journal_key:      journalKey,
        date:             dateUK,
        band,
        official_venue:   venueName,
        venue:            venueName,   // display name — same until user edits
        festival,
        festival_lineups: festivalLineups,
        notable_support:  notableSupport,
        went_with:        null,
        comments:         'Imported from setlist.fm',
        photos:           null,
        price:            null,
    };
}


/**
 * Builds a venues row from a setlist.fm venue object.
 * Geocoding (city/country) is skipped here — a nightly Cloudflare cron
 * Worker will reverse-geocode rows that have lat/lng but no city/country.
 */
export function buildVenueRow(venueRaw) {
    const city   = venueRaw.city   || {};
    const coords = city.coords     || {};

    return {
        official_name:     venueRaw.name,
        place_id:          venueRaw.id          || null,   // setlist.fm venue ID
        district:          city.state           || null,
        city:              city.name            || null,   // raw city name from setlist.fm
        country:           city.country?.name   || null,
        latitude:          coords.lat           ?? null,
        longitude:         coords.long          ?? null,
        capacity:          null,
        alternative_names: null,
    };
}


// ─── Supabase writes ──────────────────────────────────────────────────────────


/**
 * Upserts venues that don't already exist.
 * official_name is the unique key — we never overwrite existing enriched data.
 */
export async function upsertVenues(venueRows) {
    if (!venueRows.length) return { inserted: 0 };

    // Fetch existing venue names to avoid clobbering geocoded city/country data
    const names = venueRows.map(v => v.official_name);
    const { data: existing } = await supabase
        .from('venues')
        .select('official_name')
        .in('official_name', names);

    const existingSet = new Set((existing || []).map(v => v.official_name));
    const newVenues   = venueRows.filter(v => !existingSet.has(v.official_name));

    if (!newVenues.length) return { inserted: 0 };

    const { error } = await supabase.from('venues').insert(newVenues);
    if (error) console.warn('venues insert error:', error.message);

    return { inserted: newVenues.length };
}


/**
 * Upserts performances. Uses upsert on (journal_key, artist) so that
 * re-running the sync enriches setlist data without duplicating rows.
 * Returns how many rows were written (failed batches are logged, not thrown).
 */
export async function upsertPerformances(perfRows) {
    if (!perfRows.length) return 0;

    let written = 0;
    // Batch into 100s to stay within Supabase request limits
    for (let i = 0; i < perfRows.length; i += 100) {
        const batch = perfRows.slice(i, i + 100);
        const { error } = await supabase
            .from('performances')
            .upsert(batch, { onConflict: 'journal_key,artist', ignoreDuplicates: false });
        if (error) console.warn('performances upsert error:', error.message);
        else written += batch.length;
    }
    return written;
}


/**
 * Upserts journal rows for the authenticated user.
 * Skips rows that already exist (ignoreDuplicates: true) so re-syncing
 * never overwrites user edits like went_with, comments, or price.
 */
export async function upsertJournals(journalRows) {
    if (!journalRows.length) return { inserted: 0, skipped: 0 };

    let inserted = 0;
    let skipped  = 0;

    for (let i = 0; i < journalRows.length; i += 100) {
        const batch = journalRows.slice(i, i + 100);
        const { data, error } = await supabase
            .from('journals')
            .upsert(batch, { onConflict: 'user_id,journal_key', ignoreDuplicates: true })
            .select('journal_key');

        if (error) {
            console.warn('journals upsert error:', error.message);
            skipped += batch.length;
        } else {
            inserted += data?.length || 0;
            skipped  += batch.length - (data?.length || 0);
        }
    }

    return { inserted, skipped };
}


// ─── One show: lookup + save ──────────────────────────────────────────────────
// Used by the editor when a past show is saved, and by setlist-catchup.js when a
// show logged in advance has since happened. Both write the same rows the same way.


const _rateLimited = () => Object.assign(new Error('Rate limited by setlist.fm'), { code: 'rate_limited' });

/** Polite gap between setlist.fm calls (the API allows ~2/s per key, shared by everyone). */
export const politePause = (ms = 1100) => new Promise(r => setTimeout(r, ms));


/**
 * setlist.fm artist search → the best MBID, or null.
 * Throws { code: 'rate_limited' } on 429.
 */
export async function findArtistMbid(artistName) {
    const name = (artistName || '').trim();
    if (!name) return null;
    const res = await authedFetch(`${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(name)}`);
    if (res.status === 429) throw _rateLimited();
    if (!res.ok) return null;
    const data = await res.json();
    return data?.artist?.[0]?.mbid || null;
}


/**
 * The setlist for one artist (MBID) on one date, via the proxy's find-show
 * endpoint. dateUK is DD/MM/YYYY. When the artist played twice that day,
 * pickSetlist chooses by venue, then by song count.
 *
 * Returns the setlist, or null when setlist.fm has nothing for that date.
 * Throws { code: 'rate_limited' } on 429 and { code: 'proxy_error' } on any
 * other failure, so callers can tell "not there" from "couldn't check".
 */
export async function findShowSetlist(mbid, dateUK, venue = null) {
    if (!mbid || !dateUK) return null;
    const fmDate = dateUK.replace(/\//g, '-'); // DD/MM/YYYY → DD-MM-YYYY
    const res = await authedFetch(`${WORKER_URL}/?endpoint=find-show&mbid=${encodeURIComponent(mbid)}&eventDate=${encodeURIComponent(fmDate)}`);

    if (res.status === 404) return null;
    if (res.status === 429) throw _rateLimited();
    if (!res.ok) throw Object.assign(new Error(`setlist.fm proxy returned ${res.status}`), { code: 'proxy_error' });

    const data = await res.json();
    return pickSetlist(data.setlist, venue);
}


/**
 * The start date plus the next (windowDays - 1) days, as DD/MM/YYYY strings.
 * A festival journal only records its first day; acts play across all of them.
 */
export function festivalDateWindow(dateStr, windowDays = 3) {
    const [d, m, y] = dateStr.split('/').map(Number);
    const base = new Date(y, m - 1, d);
    const dates = [];
    for (let i = 0; i < windowDays; i++) {
        const dt = new Date(base);
        dt.setDate(base.getDate() + i);
        dates.push(`${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`);
    }
    return dates;
}


/**
 * For a festival: look each act up on setlist.fm across a 3-day window from
 * the start date and return every setlist found (one per act at most).
 * A failure for one act is logged and skipped — except a rate limit, which
 * stops the run (the remaining acts would fail too) unless swallowRateLimit.
 *
 * @param lineup  array of names, or a stored "A / B" string
 * @param opts.mbidFor  optional async (name) => mbid, to reuse stored MBIDs
 *                      before falling back to an artist search
 */
export async function findFestivalSetlists(lineup, dateStr, { mbidFor = null, swallowRateLimit = true } = {}) {
    const bands = Array.isArray(lineup)
        ? lineup.map(b => (b || '').trim()).filter(Boolean)
        : parseActList(lineup, { splitCommas: false });

    const dateWindow = festivalDateWindow(dateStr, 3);
    const allMatches = [];

    for (const bandName of bands) {
        try {
            const mbid = (mbidFor && await mbidFor(bandName)) || await findArtistMbid(bandName);
            if (!mbid) continue;

            await politePause();

            let match = null;
            for (const tryDate of dateWindow) {
                match = await findShowSetlist(mbid, tryDate);
                if (match) break;
                await politePause();
            }

            if (match) allMatches.push(match);
        } catch (e) {
            if (e.code === 'rate_limited' && !swallowRateLimit) throw e;
            console.warn(`Festival setlist lookup failed for ${bandName}:`, e.message);
        }
        await politePause();
    }

    return allMatches;
}


/** Link a journal row to a venue. Only fills an EMPTY venue_id, never overwrites. */
export async function linkJournalVenue(journalKey, writeUserId, venueId) {
    let q = supabase.from('journals').update({ venue_id: venueId }).eq('journal_key', journalKey).is('venue_id', null);
    q = writeUserId ? q.eq('user_id', writeUserId) : q.is('user_id', null);
    const { error } = await q;
    if (error) console.warn('journal venue link failed:', error.message);
}


/**
 * setlist.fm found the show, and upsertVenues saved its venue under setlist.fm's
 * name (keyed by place_id = setlist.fm venue id). The name the user typed can
 * differ ("Borde Hill" vs "Borde Hill Garden"), so link by that id instead.
 */
export async function linkJournalToSetlistVenue(journalKey, writeUserId, venueRow) {
    if (!venueRow?.place_id) return;
    try {
        const { data } = await supabase.from('venues').select('id').eq('place_id', venueRow.place_id).limit(2);
        if (data?.length === 1) await linkJournalVenue(journalKey, writeUserId, data[0].id);
    } catch (err) {
        console.warn('setlist venue link failed:', err.message);
    }
}


/** Fill venue_id on this show's performances that don't have one yet (never overwrites). */
export async function linkPerformancesToVenue(journalKey, venueId) {
    if (!venueId) return;
    try {
        const { error } = await supabase
            .from('performances').update({ venue_id: venueId })
            .eq('journal_key', journalKey).is('venue_id', null);
        if (error) console.warn('performance venue link failed:', error.message);
    } catch (err) {
        console.warn('performance venue link error:', err.message);
    }
}


/**
 * Saves setlists found for ONE journal row.
 *
 * Performances are written under THIS journal's key and venue name, not
 * setlist.fm's: data.js loads performances by exact journal_key, so when the
 * journal names the venue differently ("Wembley Arena" vs "The SSE Arena,
 * Wembley") a setlist.fm-keyed row would never be seen. For a festival every
 * act's row also takes the festival's key, even when that act played on day 2.
 *
 * @param setlists         raw setlist.fm setlist objects
 * @param opts.journalKey  the journal's key
 * @param opts.venue       the journal's official_venue
 * @param opts.writeUserId journal owner (null for band-archive rows)
 * @param opts.venueId     the journal's venue_id, if it has one
 * @param opts.role        override the role groupByShow assigns ('Festival')
 * @param opts.artistIdFor (setlistFmArtistName) => artists.id | null
 * @returns number of performance rows written
 */
export async function saveShowSetlists(setlists, { journalKey, venue, writeUserId, venueId = null, role = null, artistIdFor = () => null }) {
    const list = (setlists || []).filter(Boolean);
    if (!list.length) return 0;

    const perfRows = [];
    const venueRows = [];
    for (const show of groupByShow(list).values()) {
        perfRows.push(...show.performances.map(p => ({
            ...p,
            journal_key:    journalKey,
            official_venue: venue,
            ...(role ? { role } : {}),
            artist_id:      artistIdFor(p.artist) ?? null,
        })));
        venueRows.push(buildVenueRow(show.venueRaw));
    }

    const [, written] = await Promise.all([upsertVenues(venueRows), upsertPerformances(perfRows)]);
    if (!venueId) await linkJournalToSetlistVenue(journalKey, writeUserId, venueRows[0]);
    await linkPerformancesToVenue(journalKey, venueId);
    return written;
}


// ─── Full user sync ───────────────────────────────────────────────────────────


/**
 * runSetlistSync
 * --------------
 * Fetches all pages for the given setlist.fm username and syncs to Supabase.
 *
 * @param {string} setlistUsername   — setlist.fm username (not necessarily GigList username)
 * @param {object} callbacks
 *   @param {function} onProgress({ page, fetched, journalInserted, journalSkipped, status })
 *   @param {function} onComplete({ journalInserted, journalSkipped, newVenues, pages })
 *   @param {function} onError(errorMessage, { userNotFound })
 */
export async function runSetlistSync(setlistUsername, { onProgress, onComplete, onError } = {}) {
    // Must be called while the user is authenticated
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
        onError?.('Not authenticated. Please sign in before syncing.', { userNotFound: false });
        return;
    }

    const userId = session.user.id;

    let page           = 1;
    let totalInserted  = 0;
    let totalSkipped   = 0;
    let totalNewVenues = 0;
    let totalFetched   = 0;
    let hasMore        = true;

    try {
        while (hasMore) {
            onProgress?.({ page, fetched: totalFetched, journalInserted: totalInserted, journalSkipped: totalSkipped, status: 'fetching' });

            let result;
            try {
                result = await fetchUserSetlistPage(setlistUsername, page);
            } catch (err) {
                if (err.code === 'user_not_found') {
                    // Surface as a clean error — not a crash
                    onError?.(err.message, { userNotFound: true });
                    return;
                }
                if (err.code === 'rate_limited') {
                    onProgress?.({ page, fetched: totalFetched, journalInserted: totalInserted, journalSkipped: totalSkipped, status: 'rate_limited' });
                    await new Promise(r => setTimeout(r, 20000));
                    result = await fetchUserSetlistPage(setlistUsername, page);
                } else {
                    throw err;
                }
            }

            // null = end of pages
            if (!result) { hasMore = false; break; }

            const { setlists } = result;
            totalFetched += setlists.length;

            // Group into shows, then build rows
            const grouped     = groupByShow(setlists);
            const journalRows = [];
            const perfRows    = [];
            const venueRows   = [];
            const seenVenues  = new Set();

            for (const show of grouped.values()) {
                journalRows.push(buildJournalRow(userId, show));
                perfRows.push(...show.performances);

                if (!seenVenues.has(show.venueName)) {
                    seenVenues.add(show.venueName);
                    venueRows.push(buildVenueRow(show.venueRaw));
                }
            }

            // Write to Supabase — journals first: performances may only be
            // written by someone who has a journal for that show (RLS), so the
            // journal rows must exist before the performances upsert runs.
            const [venueResult, journalResult] = await Promise.all([
                upsertVenues(venueRows),
                upsertJournals(journalRows),
            ]);
            await upsertPerformances(perfRows);

            totalInserted  += journalResult.inserted;
            totalSkipped   += journalResult.skipped;
            totalNewVenues += venueResult.inserted || 0;

            onProgress?.({
                page,
                fetched:         totalFetched,
                journalInserted: totalInserted,
                journalSkipped:  totalSkipped,
                status:          'synced',
            });

            page++;

            // Polite delay — setlist.fm rate limit is 1 req/sec
            await new Promise(r => setTimeout(r, 1100));
        }

        onComplete?.({
            journalInserted: totalInserted,
            journalSkipped:  totalSkipped,
            newVenues:       totalNewVenues,
            pages:           page - 1,
        });

    } catch (err) {
        console.error('Setlist sync error:', err);
        onError?.(err.message || 'Sync failed — please try again.', { userNotFound: false });
    }
}


// ─── UI helpers ───────────────────────────────────────────────────────────────


/**
 * Detects which sync surface is currently visible and returns the relevant DOM IDs.
 * Profile screen (#view-profile) takes priority; falls back to the legacy
 * onboarding modal (#settingsModal).
 */
function _getSyncContext() {
    const profileVisible = !document.getElementById('view-profile')?.classList.contains('hidden');
    if (profileVisible) {
        return {
            statusId:    'sync-status',
            noSetlistBtn: 'btn-no-setlist-account-profile',
            helpBlockId: 'no-setlist-help-profile',
        };
    }
    return {
        statusId:    'sync-status-legacy',
        noSetlistBtn: 'btn-no-setlist-account',
        helpBlockId: 'no-setlist-help',
    };
}


/**
 * Shows the "no setlist.fm account" help block in whichever sync surface is active.
 * Called by both "I don't have a setlist.fm account" buttons in vault.html.
 * Also exposed on window for inline onclick handlers.
 */
export function showNoSetlistTip() {
    const ctx = _getSyncContext();

    const triggerBtn = document.getElementById(ctx.noSetlistBtn);
    if (triggerBtn) triggerBtn.classList.add('hidden');

    const helpBlock = document.getElementById(ctx.helpBlockId);
    if (helpBlock) {
        helpBlock.classList.remove('hidden');
        helpBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

window.showNoSetlistTip = showNoSetlistTip;


/**
 * Called by app.js syncSetlistFm() onError/onComplete when 0 journal rows were inserted.
 * Writes a contextual message into the status element, then reveals the help block.
 *
 * @param {object} opts
 *   @param {boolean} opts.userNotFound  — true when the username wasn't found on setlist.fm at all
 */
export function handleZeroSyncResult({ userNotFound = false } = {}) {
    const ctx  = _getSyncContext();
    const hint = document.getElementById(ctx.statusId);

    if (hint) {
        if (userNotFound) {
            hint.innerHTML = `
                <span class="text-red-500 font-black not-italic">✗ Username not found on setlist.fm.</span><br><br>
                Check your setlist.fm profile URL — your username is the part after
                <code class="font-mono bg-slate-100 px-1 rounded">setlist.fm/user/</code>
            `;
        } else {
            hint.innerHTML = `
                <span class="text-indigo-500 font-black not-italic">✗ No shows found for that username.</span><br><br>
                <strong class="not-italic text-slate-700">Wrong username?</strong>
                Check your setlist.fm profile URL — it's the part after
                <code class="font-mono bg-slate-100 px-1 rounded">setlist.fm/user/</code>
            `;
        }
        hint.className = 'text-sm mt-3 leading-relaxed text-slate-600 not-italic';
    }

    showNoSetlistTip();
}
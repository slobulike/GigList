/**
 * GigList — Setlist.fm Sync Module
 * =================================
 * Fetches a user's attended shows from setlist.fm via the Cloudflare Worker
 * proxy, transforms them into GigList's canonical schema, and upserts directly
 * into Supabase using the authenticated user's session token.
 *
 * Writes:
 *   journals        — user's own rows (RLS: user can only write their own)
 *   performances    — shared table (source = setlist.fm, trusted)
 *   venues          — shared table (source = setlist.fm, trusted)
 *
 * Does NOT write venues/performances for manually-added shows — those go
 * through the pending_venues queue instead (handled in editor.js).
 *
 * Usage:
 *   import { runSetlistSync } from './modules/setlist-sync.js';
 *
 *   await runSetlistSync('TragicGurl', {
 *       onProgress: ({ page, inserted, total, status }) => { ... },
 *       onComplete: ({ inserted, skipped, newVenues }) => { ... },
 *       onError:    (err) => { ... },
 *   });
 *
 * Named exports (also used by editor.js for single-show setlist.fm lookup):
 *   toUKDate, parseSongs, groupByShow, buildJournalRow, buildVenueRow,
 *   upsertVenues, upsertPerformances, upsertJournals
 */


import { supabase } from './supabase.js';


const WORKER_URL = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';


// Venues with any of these keywords in the name are treated as festival sites.
// Matches the logic in onboard_user.py.
const FESTIVAL_KEYWORDS = [
    'worthy farm', 'richfield avenue', 'bramham park', 'hatfield house',
    'little john', 'victoria park', 'hyde park', 'phoenix park',
    'bellahouston', 'finsbury park', 'knebworth', 'milton keynes bowl',
];


// ─── Worker fetch ─────────────────────────────────────────────────────────────


async function fetchPage(username, page) {
    const url = `${WORKER_URL}/?endpoint=user-setlists&username=${encodeURIComponent(username)}&page=${page}`;
    const res = await fetch(url);


    if (res.status === 404) return null;          // no more pages
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error(`setlist.fm returned ${res.status}`);


    const data = await res.json();
    return data?.setlist?.length ? data : null;   // null = last page
}


// ─── Transform helpers ────────────────────────────────────────────────────────


/**
 * setlist.fm date format: "DD-MM-YYYY" → GigList canonical: "DD/MM/YYYY"
 */
export function toUKDate(eventDate) {
    return eventDate.replace(/-/g, '/');
}


/**
 * Parse songs from the nested sets structure into a pipe-separated string.
 * Matches the format used in performances.csv and sync_shared_data.py.
 */
export function parseSongs(sets) {
    const songs = [];
    for (const set of sets?.set || []) {
        for (const song of set?.song || []) {
            if (song.name) songs.push(song.name);
        }
    }
    return songs.join(' | ');
}


function isFestivalVenue(venueName) {
    const lower = venueName.toLowerCase();
    return FESTIVAL_KEYWORDS.some(kw => lower.includes(kw));
}


/**
 * Groups raw setlist.fm setlists by journal key (date + venue).
 * A single night at a multi-act show produces one journal row but
 * multiple performance rows — same logic as onboard_user.py.
 */
export function groupByShow(setlists) {
    const grouped = new Map();


    for (const sl of setlists) {
        const venue    = sl.venue || {};
        const venueName = venue.name || 'Unknown Venue';
        const dateUK   = toUKDate(sl.eventDate);
        const key      = `${dateUK}${venueName}`;
        const [d, m, y] = dateUK.split('/');


        const artist = sl.artist?.name || 'Unknown Artist';
        const songs  = parseSongs(sl.sets);


        if (!grouped.has(key)) {
            grouped.set(key, {
                journalKey:  key,
                dateUK,
                d, m, y,
                venueName,
                venueRaw:    venue,         // full setlist.fm venue object
                artists:     [],
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
    const { journalKey, dateUK, d, m, y, venueName, artists } = show;
    const isFest = isFestivalVenue(venueName);


    let band, notableSupport, festivalLineups, festival;


    if (artists.length === 1) {
        band           = artists[0];
        notableSupport = null;
        festival       = false;
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
    show.performances.forEach((p, i) => {
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
    const city = venueRaw.city || {};
    const coords = city.coords || {};


    return {
        official_name:     venueRaw.name,
        place_id:          venueRaw.id   || null,   // setlist.fm venue ID
        district:          city.state    || null,
        city:              city.name     || null,   // raw city name from setlist.fm
        country:           city.country?.name || null,
        latitude:          coords.lat    ?? null,
        longitude:         coords.long   ?? null,
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
    if (!venueRows.length) return;


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
 */
export async function upsertPerformances(perfRows) {
    if (!perfRows.length) return;


    // Batch into 100s to stay within Supabase request limits
    for (let i = 0; i < perfRows.length; i += 100) {
        const batch = perfRows.slice(i, i + 100);
        const { error } = await supabase
            .from('performances')
            .upsert(batch, { onConflict: 'journal_key,artist', ignoreDuplicates: false });
        if (error) console.warn('performances upsert error:', error.message);
    }
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


// ─── Main export ──────────────────────────────────────────────────────────────


/**
 * runSetlistSync
 * --------------
 * Fetches all pages for the given setlist.fm username and syncs to Supabase.
 *
 * @param {string} setlistUsername   — setlist.fm username (not necessarily GigList username)
 * @param {object} callbacks
 *   @param {function} onProgress({ page, fetched, journalInserted, journalSkipped, status })
 *   @param {function} onComplete({ journalInserted, journalSkipped, newVenues, pages })
 *   @param {function} onError(errorMessage)
 */
export async function runSetlistSync(setlistUsername, { onProgress, onComplete, onError } = {}) {
    // Must be called while the user is authenticated
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
        onError?.('Not authenticated. Please sign in before syncing.');
        return;
    }


    const userId = session.user.id;


    let page             = 1;
    let totalInserted    = 0;
    let totalSkipped     = 0;
    let totalNewVenues   = 0;
    let totalFetched     = 0;
    let hasMore          = true;


    try {
        while (hasMore) {
            onProgress?.({ page, fetched: totalFetched, journalInserted: totalInserted, journalSkipped: totalSkipped, status: 'fetching' });


            let data;
            // Simple retry on rate limit — wait 20s and try again once
            try {
                data = await fetchPage(setlistUsername, page);
            } catch (err) {
                if (err.message === 'rate_limited') {
                    onProgress?.({ page, fetched: totalFetched, journalInserted: totalInserted, journalSkipped: totalSkipped, status: 'rate_limited' });
                    await new Promise(r => setTimeout(r, 20000));
                    data = await fetchPage(setlistUsername, page);
                } else {
                    throw err;
                }
            }


            // null means setlist.fm returned an empty page — we're done
            if (!data) { hasMore = false; break; }


            const setlists = data.setlist;
            totalFetched += setlists.length;


            // Group into shows, then build rows
            const grouped      = groupByShow(setlists);
            const journalRows  = [];
            const perfRows     = [];
            const venueRows    = [];
            const seenVenues   = new Set();


            for (const show of grouped.values()) {
                journalRows.push(buildJournalRow(userId, show));
                perfRows.push(...show.performances);


                if (!seenVenues.has(show.venueName)) {
                    seenVenues.add(show.venueName);
                    venueRows.push(buildVenueRow(show.venueRaw));
                }
            }


            // Write to Supabase — venues and performances first (shared tables),
            // then journals (user-scoped)
            const [venueResult, , journalResult] = await Promise.all([
                upsertVenues(venueRows),
                upsertPerformances(perfRows),
                upsertJournals(journalRows),
            ]);


            totalInserted  += journalResult.inserted;
            totalSkipped   += journalResult.skipped;
            totalNewVenues += venueResult.inserted || 0;


            onProgress?.({
                page,
                fetched:          totalFetched,
                journalInserted:  totalInserted,
                journalSkipped:   totalSkipped,
                status:           'synced',
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
        onError?.(err.message || 'Sync failed — please try again.');
    }
}
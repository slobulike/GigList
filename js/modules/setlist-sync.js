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
 *   parseSongs(sets)
 *   groupByShow(setlists)
 *   buildJournalRow(userId, show)
 *   buildVenueRow(venueRaw)
 *
 * ─── Supabase writes ──────────────────────────────────────────────────────
 *   upsertVenues(venueRows)
 *   upsertPerformances(perfRows)
 *   upsertJournals(journalRows)
 *
 * ─── Full user sync ───────────────────────────────────────────────────────
 *   runSetlistSync(username, { onProgress, onComplete, onError })
 *
 * ─── UI helpers ───────────────────────────────────────────────────────────
 *   showNoSetlistTip()          — called by "I don't have a setlist.fm account" buttons
 *   handleZeroSyncResult(opts)  — called by app.js syncSetlistFm() when 0 rows inserted
 *       opts.userNotFound       — true when the username wasn't found on setlist.fm
 */


import { supabase } from './supabase.js';


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
    const res = await fetch(`${WORKER_URL}/?${qs}`);

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
        const venue     = sl.venue || {};
        const venueName = venue.name || 'Unknown Venue';
        const dateUK    = toUKDate(sl.eventDate);
        const key       = `${dateUK}${venueName}`;
        const [d, m, y] = dateUK.split('/');

        const artist = sl.artist?.name || 'Unknown Artist';
        const songs  = parseSongs(sl.sets);

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
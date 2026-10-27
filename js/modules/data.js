/**
 * GigList - Data Module
 */
import { parseDate, isFestivalRow, getOwnFestivalLineup, normalizeArtist, scopeFestivalPerformances } from './utils.js';
import { supabase } from './supabase.js';
import { loadArtistImages, artistImageCandidates } from './artist-images.js';
import { cacheGet, cachePut, cacheDelete, CACHE_VERSION } from './app-cache.js';

/**
 * Helper to determine show type based on keywords
 */
export const deriveType = (gig) => {
    if (gig.Type && gig.Type !== "nan" && gig.Type.trim() !== "") return gig.Type;

    const venueLower = (gig.OfficialVenue || "").toLowerCase();

    const tvKeywords = ['jimmy', 'top of the pops', 'snl', 'letterman', 'tonight show', 'tiringo', 'mtv'];
    if (tvKeywords.some(key => venueLower.includes(key))) return "TV";

    const festKeywords = ['fest', 'park', 'field', 'weekend', 'glastonbury', 'reading', 'leeds'];
    if (festKeywords.some(key => venueLower.includes(key))) return "Festival";

    return "Headline";
};

/**
 * Companion list for a single journal row — the one place every
 * companion-counting feature (dashboard chart, achievement buddy count,
 * Squad share card) should read from, instead of each independently
 * checking field names and re-implementing the "nan"/"Alone" exclusion
 * and comma/slash/ampersand splitting rules.
 *
 * Prefers structured gig_companions tags (attached as row.ResolvedCompanions
 * by loadAppData) when present, so a confirmed tag also carries a real
 * userId for avatar/profile lookups. Falls back to splitting the legacy
 * free-text 'Went With' field when there's no structured tag for this row,
 * so pre-migration journal entries still count toward the same totals.
 *
 * Returns an array of { name, userId } — userId is null for untagged or
 * unconfirmed legacy-text companions.
 */
export const getCompanionsForGig = (row) => {
    if (row.ResolvedCompanions?.length) {
        return row.ResolvedCompanions.map(c => ({
            name:   c.name,
            userId: c.isConfirmed ? c.userId : null,
        }));
    }

    const raw = row['Went With'] || row.went_with || '';
    if (!raw || raw === 'nan' || raw === 'Alone') return [];

    return raw.split(/[,/&]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(name => ({ name, userId: null }));
};

/**
 * Sorts an array of gig objects
 */
export const sortGigs = (data, column, ascending = true) => {
    return [...data].sort((a, b) => {
        let valA = a[column] || "";
        let valB = b[column] || "";

        if (window.isBandMode && column === 'Band') {
            valA = deriveType(a);
            valB = deriveType(b);
        }

        if (column === 'Date') {
            valA = parseDate(valA) || new Date(0);
            valB = parseDate(valB) || new Date(0);
        } else {
            valA = valA.toString().toLowerCase();
            valB = valB.toString().toLowerCase();
        }

        if (valA < valB) return ascending ? -1 : 1;
        if (valA > valB) return ascending ? 1 : -1;
        return 0;
    });
};

/**
 * Data Loading — reads from Supabase.
 *
 * Phase 3 note: this replaces the CSV fetch/Papa.parse approach.
 * The shape of the returned data is identical to the old CSV version
 * so nothing else in the app needs to change.
 *
 * Phase 4 perf note: both performances and venues are now scoped to the
 * user's journal rather than fetching entire tables.
 *
 * Load order:
 *   1. Journals (must come first — we need journal_keys + venue names to scope steps 2 & 3)
 *   2. Performances + Venues in parallel (both scoped to journal content)
 *
 * This recovers the parallel fetch benefit while keeping payloads minimal:
 *   - performances: filtered by .in('journal_key', journalKeys)  [index: performances_journal_key_idx]
 *   - venues:       filtered by .in('official_name', journalVenues) [index: venues_official_name_idx]
 *
 * Performances are scoped by journal_key (not artist) so that festival shows
 * return all acts on the lineup regardless of whether those artists appear
 * elsewhere in the user's personal journal.
 *
 * A user with no shows gets 0 bytes for both. A heavy user gets only their
 * relevant slice rather than the entire global dataset.
 */
// ── Venue identity ────────────────────────────────────────────────────────────
// Venue NAMES aren't unique ('The Garage', 'House of Blues'…). Rows linked to a
// venue (journals.venue_id / performances.venue_id, filled by the setlist.fm
// backfill) resolve by id; unlinked rows fall back to the name as before.
const _venueInfo = (v) => ({
    id:       v.id,
    name:     v.official_name,
    lat:      parseFloat(v.latitude)  || null,
    lng:      parseFloat(v.longitude) || null,
    city:     v.city     || 'Unknown City',
    country:  v.country  || 'Unknown Country',
    capacity: v.capacity || 'Unknown',
});

/** The venue record for a row: by venue_id when linked, else by name. */
export const resolveVenue = (row) =>
    (row.venue_id != null && window.venuesById?.[row.venue_id])
    || (window.allVenues || {})[row.OfficialVenue || row.official_venue]
    || null;

/**
 * Stable identity of the venue a row is at (for grouping/counting). Uses the id of the
 * venue the row RESOLVES to, so a row linked by venue_id and an unlinked row that falls
 * back to the same venue by name share one key (otherwise they'd draw two pins).
 */
export const venueKey = (row) => {
    const v = resolveVenue(row);
    if (v?.id != null) return `id:${v.id}`;
    if (row.venue_id)  return `id:${row.venue_id}`;
    return `name:${row.OfficialVenue || row.official_venue || row.Venue || ''}`;
};

window.venueKey     = venueKey;
window.resolveVenue = resolveVenue;

// Latest artist lookup built by loadAppData: { [bandName]: { id, spotify_artist_id, spotify_image_url } }
let _artistLookup = {};

/**
 * Loads the per-artist image sets and rebuilds row.ArtistImages in place.
 *
 * Runs AFTER first paint (loadAppData starts it fire-and-forget) because it
 * only refines which of an artist's images a gig shows — the artist's current
 * image (SpotifyImageUrl) is already on every row without it. Rows are
 * mutated in place, so window.journalData picks the result up with no
 * re-render needed; anything drawn after it resolves uses the full set.
 * Non-fatal: on failure rows simply keep their first-paint ArtistImages.
 */
export const hydrateArtistImages = async (rows) => {
    const lookup = _artistLookup;
    const ids = Object.values(lookup).map(a => a.id).filter(Boolean);
    if (!ids.length || !rows?.length) return;
    try {
        await loadArtistImages(ids);
    } catch (e) {
        console.warn('hydrateArtistImages: failed, keeping first-paint images:', e?.message || e);
        return;
    }
    rows.forEach(row => {
        const a = lookup[row.band];
        if (a) {
            row.ArtistImages = artistImageCandidates(a, {
                strategy: 'stable',
                seed: row.journal_key || row['Journal Key'],
            });
        }
    });
};

/**
 * NETWORK PHASE — fetches the raw Supabase rows. No normalising here, so the
 * result is exactly what gets cached (see loadAppData / loadCachedStart).
 */
const fetchRawAppData = async (user, { skipPerformances = false } = {}) => {
    // ── Step 1: Journals ──────────────────────────────────────────────────────
    // Must resolve first so we can extract bands + venue names for scoped fetches.
    // Band mode: fetch by band name (null user_id rows)
    // Individual mode: fetch by authenticated user's id
    let journalQuery;
    if (user.Type === 'Band') {
        journalQuery = supabase
            .from('journals')
            .select('*')
            .is('user_id', null)
            .eq('band', user.Subject || user.UserName)
            .range(0, 19999);
    } else if (user.Type === 'Friend') {
        // Viewing a friend's journal — query by their user id (RLS allows this via follows policy)
        journalQuery = supabase
            .from('journals')
            .select('*')
            .eq('user_id', user.friendId)
            .range(0, 9999);
    } else {
        journalQuery = supabase
            .from('journals')
            .select('*')
            .eq('user_id', user.id)
            .range(0, 9999);
    }

    const journalRes = await journalQuery;
    if (journalRes.error) throw new Error(`Failed to load journals: ${journalRes.error.message}`);

    let journalData = journalRes.data || [];

    // Derive scoping sets from the raw journal rows (pre-normalisation, snake_case keys)
    // journal_key is used to scope performances so that festival shows return all acts
    // on the lineup, not just acts that happen to appear elsewhere in the user's journal.
    const journalKeys   = [...new Set(journalData.map(r => r.journal_key).filter(Boolean))];
    // Rows already linked to a venue are fetched by id; only unlinked rows need a name lookup.
    const journalVenues   = [...new Set(journalData.filter(r => !r.venue_id).map(r => r.official_venue).filter(Boolean))];
    const journalVenueIds = [...new Set(journalData.map(r => r.venue_id).filter(Boolean))];

// ── Steps 1b / 1c / 2: everything that depends only on the journal rows ──────
    // These used to run one after another (artists → artist images → companions →
    // venues), so each added a full network round trip before first paint.
    // None of them depends on another, so they now go out together and the
    // slowest one sets the pace.
    //
    // Artist *images* (the per-artist image picker) are no longer on this path:
    // they only refine which image a gig shows, so they load after first paint
    // (see hydrateArtistImages below).
    const CHUNK_SIZE = 100;

    const chunked = (arr) => {
        const chunks = [];
        for (let i = 0; i < arr.length; i += CHUNK_SIZE) chunks.push(arr.slice(i, i + CHUNK_SIZE));
        return chunks;
    };

    // Artist lookup (spotify IDs for deep links + current artist image)
    const journalBands = [...new Set(journalData.map(r => r.band).filter(Boolean))];

    async function fetchArtistLookup() {
        const lookup = {};
        if (!journalBands.length) return lookup;
        const results = await Promise.all(
            chunked(journalBands).map(chunk =>
                supabase.from('artists').select('id, name, spotify_artist_id, spotify_image_url').in('name', chunk)
            )
        );
        results.flatMap(r => r.data || []).forEach(a => {
            lookup[a.name] = {
                id: a.id,
                spotify_artist_id: a.spotify_artist_id,
                spotify_image_url: a.spotify_image_url,
            };
        });
        return lookup;
    }

    // Companion tags (gig_companions)
    // Bulk-fetch structured companion tags for these journal rows so every
    // companion-counting feature (dashboard chart, achievement buddy count,
    // Squad share card) can read one merged source via getCompanionsForGig
    // below, instead of each independently falling back to the legacy
    // free-text 'Went With' field. Scoped to the same owner as the journals
    // query above — own id, the friend being viewed, or skipped entirely for
    // band mode, where per-gig companions aren't a meaningful concept.
    const companionOwnerId = user.Type === 'Band' ? null : (user.Type === 'Friend' ? user.friendId : user.id);
    const journalIds = [...new Set(journalData.map(r => r.id).filter(v => v != null))];

    async function fetchCompanionsByJournalId() {
        const byJournalId = {};
        if (!journalIds.length || !companionOwnerId) return byJournalId;
        const { data: companionRows, error: companionErr } = await supabase
            .from('gig_companions')
            .select('journal_id, companion_name, companion_user_id, status')
            .eq('owner_id', companionOwnerId)
            .in('journal_id', journalIds);

        if (companionErr) {
            console.warn('loadAppData: companion tag fetch failed:', companionErr.message);
        } else {
            (companionRows || []).forEach(c => {
                if (!c.companion_name) return;
                (byJournalId[c.journal_id] = byJournalId[c.journal_id] || []).push({
                    name:        c.companion_name,
                    userId:      c.companion_user_id || null,
                    isConfirmed: c.status === 'confirmed',
                });
            });
        }
        return byJournalId;
    }

    // Performances + Venues
    // Both are scoped to the user's journal content to keep payloads minimal.
    // Performances are scoped by journal_key (not artist) so festival shows
    // return all acts on the lineup regardless of whether those artists appear
    // elsewhere in the user's personal journal.
    // Both fetches are batched in chunks of 100 to avoid URL length limits.
    async function fetchPerformancesInBatches(keys) {
        if (!keys.length) return [];
        const results = await Promise.all(
            chunked(keys).map(chunk => supabase.from('performances').select('*').in('journal_key', chunk))
        );
        const errors = results.filter(r => r.error);
        if (errors.length) throw new Error(`Failed to load performances: ${errors[0].error.message}`);
        return results.flatMap(r => r.data || []);
    }

    async function fetchVenuesInBatches(venueNames) {
        if (!venueNames.length) return [];
        const results = await Promise.all(
            chunked(venueNames).map(chunk => supabase.from('venues').select('*').in('official_name', chunk))
        );
        const errors = results.filter(r => r.error);
        if (errors.length) throw new Error(`Failed to load venues: ${errors[0].error.message}`);
        return results.flatMap(r => r.data || []);
    }

    async function fetchVenuesByIds(ids) {
        if (!ids.length) return [];
        const results = await Promise.all(
            chunked(ids).map(chunk => supabase.from('venues').select('*').in('id', chunk))
        );
        const errors = results.filter(r => r.error);
        if (errors.length) throw new Error(`Failed to load venues: ${errors[0].error.message}`);
        return results.flatMap(r => r.data || []);
    }

    async function fetchAllVenues() {
        const [byName, byId] = await Promise.all([
            fetchVenuesInBatches(journalVenues),
            fetchVenuesByIds(journalVenueIds),
        ]);
        return [...byName, ...byId];
    }

    const [artistLookup, companionsByJournalId, perfRows, venueRows] = await Promise.all([
        fetchArtistLookup(),
        fetchCompanionsByJournalId(),
        skipPerformances ? Promise.resolve([]) : fetchPerformancesInBatches(journalKeys),
        fetchAllVenues(),
    ]);

    return { journalRows: journalData, artistLookup, companionsByJournalId, venueRows, perfRows };
};

/**
 * BUILD PHASE — pure, synchronous: turns raw rows (fresh from the network OR
 * read back from the cache) into the shapes the rest of the app uses. Also
 * sets window.allVenues / window.venuesById.
 */
const buildAppData = (user, raw) => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const { artistLookup, companionsByJournalId, venueRows, perfRows } = raw;
    let journalData = raw.journalRows;

    // Remembered so the post-paint image pass (hydrateArtistImages) can rebuild ArtistImages
    _artistLookup = artistLookup;

    const venueRes = { data: venueRows };

    // Build venue lookup from scoped results and stash on window for map/editor use
    const venueLookup = {};
    const venuesById  = {};
    (venueRes.data || []).forEach(v => {
        const info = _venueInfo(v);
        if (v.id != null) venuesById[v.id] = info;
        if (v.official_name) venueLookup[v.official_name] = info;
    });
    window.allVenues  = venueLookup;
    window.venuesById = venuesById;

    let performanceData = perfRows;

    // Normalise column names from Supabase snake_case to the app's expected format
    // Supabase returns lowercase column names; the app expects the original CSV casing
    journalData = journalData.map(row => ({
        ...row,
        Band:               row.band             || row.Band             || '',
        OfficialVenue:      row.official_venue   || row.OfficialVenue    || '',
        'Journal Key':      row.journal_key      || row['Journal Key']   || '',
        'Festival?':        row.festival ? 'Y' : 'N',
        'Festival Lineups': row.festival_lineups || row['Festival Lineups'] || '',
        'Notable Support':  row.notable_support  || row['Notable Support']  || '',
        'Went With':        row.went_with        || row['Went With']     || '',
        Comments:           row.comments         || row.Comments         || '',
        Photos:             row.photos           || row.Photos           || '',
        'Review URL':       row.review_url       || row['Review URL']    || '',
        Price:              row.price            || row.Price            || '',
        Date:               row.date             || row.Date             || '',
        Year:               row.year             || row.Year             || '',
        Month:              row.month            || row.Month            || '',
        Day:                row.day              || row.Day              || '',
         // Artist enrichment from canonical artists table
        SpotifyArtistId:    artistLookup[row.band]?.spotify_artist_id || null,
        SpotifyImageUrl:    artistLookup[row.band]?.spotify_image_url || null,
        // Ordered images to try for this gig: a per-gig pick first (stable, so a gig always
        // shows the same one), then the rest. SpotifyImageUrl stays the artist's current image.
        ArtistImages:       artistLookup[row.band]
            ? artistImageCandidates(artistLookup[row.band], { strategy: 'stable', seed: row.journal_key || row['Journal Key'] })
            : [],
        // Structured companion tags for this row, if any — see
        // getCompanionsForGig below for how this merges with the legacy
        // free-text 'Went With' field. null (not []) when there's no
        // companion_id fetch at all (e.g. band mode) vs genuinely tagged
        // with zero companions, though in practice gig_companions rows
        // are never created empty.
        ResolvedCompanions: companionsByJournalId[row.id] || null,
    }));

    performanceData = performanceData.map(p => ({
        ...p,
        'Journal Key':  p.journal_key    || p['Journal Key'] || '',
        Artist:         p.artist         || p.Artist         || '',
        Role:           p.role           || p.Role           || '',
        Setlist:        p.setlist        || p.Setlist        || '',
        OfficialVenue:  p.official_venue || p.OfficialVenue  || '',
        SetlistURL:     p.setlist_url    || p.SetlistURL      || '',
    }));

    // Enrich journal rows
    journalData.forEach(row => {
        row.Band = row.Band || row.Artist || '';
        const gigDate = parseDate(row.Date);
        row.type    = (gigDate && gigDate >= now) ? 'future' : 'past';

        const venueInfo = resolveVenue(row);
        if (venueInfo) {
            row.City    = venueInfo.city    || '';
            row.Country = venueInfo.country || '';
            // A show with no venue name in the journal can still show its linked venue
            if (!row.OfficialVenue && row.venue_id && venueInfo.name) row.OfficialVenue = venueInfo.name;
        }
    });

    // Enrich performance rows
    performanceData.forEach(perf => {
        const venueInfo = resolveVenue(perf);
        if (venueInfo) {
            perf.City    = venueInfo.city    || '';
            perf.Country = venueInfo.country || '';
        }
    });

    return { journalData, performanceData, user };
};

// ── Cache-first startup ──────────────────────────────────────────────────────
// Personal-mode home loads and band pages are cached (friend views always hit the
// network). What's stored is the RAW rows from fetchRawAppData, keyed per user
// (or per band), so a cached start runs through exactly the same buildAppData as
// a network one.
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const dataCacheKey    = (userId) => `data:${userId}`;
const profileCacheKey = (userId) => `profile:${userId}`;
const isCacheable = (user, skipPerformances) =>
    user?.Type === 'Personal' && !!user.id && skipPerformances;

// ── Band pages ───────────────────────────────────────────────────────────────
// A band page caches the same raw payload plus its `bands` row, keyed by the
// lower-cased band name, so a repeat visit paints from IndexedDB with no network
// wait. A small LRU keeps the store bounded (a big band is several MB of rows).
const MAX_CACHED_BANDS = 6;
const BAND_INDEX_KEY   = 'bandidx';
const bandKey     = (name) => String(name || '').trim().toLowerCase();
const bandRowKey  = (k) => `bandrow:${k}`;
const bandDataKey = (k) => `banddata:${k}`;
const isBandCacheable = (user, skipPerformances) =>
    user?.Type === 'Band' && !!skipPerformances && !!bandKey(user.UserName);

/** Marks a band as most-recently used and evicts the oldest beyond the cap. Best effort. */
async function rememberBand(k) {
    try {
        const idx = ((await cacheGet(BAND_INDEX_KEY)) || []).filter(x => x !== k);
        idx.push(k);
        while (idx.length > MAX_CACHED_BANDS) {
            const old = idx.shift();
            await Promise.all([cacheDelete(bandRowKey(old)), cacheDelete(bandDataKey(old))]);
        }
        await cachePut(BAND_INDEX_KEY, idx);
    } catch { /* best effort */ }
}

async function putBandData(name, raw) {
    const k = bandKey(name);
    // Never cache an empty result: it can be a wrong guess, and an empty band is cheap to refetch anyway.
    if (!k || !raw?.journalRows?.length) return;
    await cachePut(bandDataKey(k), { v: CACHE_VERSION, savedAt: Date.now(), raw });
    rememberBand(k);
}

const _hash = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h;
};

/**
 * Order-independent fingerprint of a raw payload, used to tell whether the
 * network data actually differs from what the cache painted (so an unchanged
 * background refresh doesn't trigger a pointless re-render).
 */
export const rawSignature = (raw) => {
    const byId = (a, b) => (a.id > b.id) - (a.id < b.id);
    const parts = [
        JSON.stringify([...(raw.journalRows || [])].sort(byId)),
        JSON.stringify((raw.venueRows || []).map(v =>
            [v.id, v.official_name, v.latitude, v.longitude, v.city, v.country, v.capacity].join('|')).sort()),
        JSON.stringify(Object.entries(raw.artistLookup || {}).map(([n, a]) =>
            [n, a.id, a.spotify_artist_id, a.spotify_image_url].join('|')).sort()),
        JSON.stringify(Object.entries(raw.companionsByJournalId || {}).map(([k, v]) =>
            k + ':' + v.map(c => `${c.name}|${c.userId}|${c.isConfirmed}`).sort().join(',')).sort()),
    ];
    return parts.map(p => `${p.length}:${_hash(p)}`).join('/');
};

/**
 * Loads the user's journal and everything built from it, from the network.
 * Successful personal-mode loads also refresh the cache (fire-and-forget).
 * Result includes `signature` (see rawSignature).
 */
export const loadAppData = async (user, { skipPerformances = false, cacheGate = true } = {}) => {
    const raw = await fetchRawAppData(user, { skipPerformances });

    if (isCacheable(user, skipPerformances)) {
        cachePut(dataCacheKey(user.id), { v: CACHE_VERSION, savedAt: Date.now(), raw });
    } else if (isBandCacheable(user, skipPerformances)) {
        // cacheGate lets a caller that started this load on a guess (before the
        // band row arrived) say later whether the guess was right.
        Promise.resolve(cacheGate).then(ok => { if (ok) putBandData(user.UserName, raw); }).catch(() => {});
    }

    const result = buildAppData(user, raw);

    // Post-paint: per-artist image sets (not awaited — see hydrateArtistImages)
    hydrateArtistImages(result.journalData);

    return { ...result, signature: rawSignature(raw) };
};

/**
 * Reads the cached profile + raw journal data for a user, or null if there is
 * no usable cache (missing, wrong version, older than 30 days, or IndexedDB
 * unavailable). Resolves in a few ms; never rejects.
 */
export const loadCachedStart = async (userId) => {
    if (!userId) return null;
    const [p, d] = await Promise.all([
        cacheGet(profileCacheKey(userId)),
        cacheGet(dataCacheKey(userId)),
    ]);
    if (!p?.profile || !d?.raw) return null;
    if (p.v !== CACHE_VERSION || d.v !== CACHE_VERSION) return null;
    if (Date.now() - (d.savedAt || 0) > MAX_CACHE_AGE_MS) return null;
    return { profile: p.profile, home: p.home || null, raw: d.raw, savedAt: d.savedAt };
};

/**
 * Cached band page: the `bands` row plus raw journal rows, or null if there is no
 * usable cache. Resolves in a few ms; never rejects.
 */
export const loadCachedBand = async (name) => {
    const k = bandKey(name);
    if (!k) return null;
    const [r, d] = await Promise.all([cacheGet(bandRowKey(k)), cacheGet(bandDataKey(k))]);
    if (!r?.row || !d?.raw) return null;
    if (r.v !== CACHE_VERSION || d.v !== CACHE_VERSION) return null;
    if (Date.now() - (d.savedAt || 0) > MAX_CACHE_AGE_MS) return null;
    return { bandRow: r.row, raw: d.raw, savedAt: d.savedAt };
};

/** Stores the `bands` row for a band page (name / subject). */
export const cacheBandRow = (name, row) => {
    const k = bandKey(name);
    if (!k || !row) return;
    cachePut(bandRowKey(k), { v: CACHE_VERSION, savedAt: Date.now(), row });
    rememberBand(k);
};

/**
 * Fills the band cache ahead of a visit (used for favourite bands, in idle time).
 * Skips bands cached within maxAgeMs. Resolves true if it fetched, false if skipped.
 * Never touches live app state.
 */
export const warmBandCache = async (name, { maxAgeMs = 12 * 60 * 60 * 1000 } = {}) => {
    const k = bandKey(name);
    if (!k) return false;
    const [r, d] = await Promise.all([cacheGet(bandRowKey(k)), cacheGet(bandDataKey(k))]);
    const fresh = r?.row && d?.raw && r.v === CACHE_VERSION && d.v === CACHE_VERSION
        && Date.now() - (d.savedAt || 0) < maxAgeMs;
    if (fresh) return false;

    const { data: row } = await supabase.from('bands').select('*').ilike('name', name).single();
    if (!row) return false;
    const user = { Type: 'Band', UserName: row.name, Subject: row.subject || row.name };
    const raw  = await fetchRawAppData(user, { skipPerformances: true });
    cacheBandRow(row.name, row);
    await putBandData(row.name, raw);
    return true;
};

/** Builds app data from cached raw rows (same pipeline as a network load, minus the network). */
export const buildAppDataFromRaw = (user, raw) => ({
    ...buildAppData(user, raw),
    signature: rawSignature(raw),
});

/** Stores the profile (+ private home location) used to paint the next cached start. */
export const cacheStartProfile = (userId, profile, home) =>
    cachePut(profileCacheKey(userId), { v: CACHE_VERSION, savedAt: Date.now(), profile, home: home || null });

/**
 * Re-fetches the raw data and refreshes the cache without touching any live
 * state. Called after the user saves something so the NEXT cached start isn't stale.
 */
export const refreshAppCache = async (user) => {
    if (!isCacheable(user, true)) return;
    try {
        const raw = await fetchRawAppData(user, { skipPerformances: true });
        await cachePut(dataCacheKey(user.id), { v: CACHE_VERSION, savedAt: Date.now(), raw });
    } catch (e) {
        console.warn('refreshAppCache failed:', e?.message || e);
    }
};

/**
 * Loads, normalises, and enriches performance data for the given journal keys.
 * Called lazily after first paint (personal mode) or on Summary tab open (band mode).
 * Uses the same normalisation pipeline as loadAppData so window.performanceData
 * has an identical shape regardless of which path populated it.
 *
 * @param {string[]} journalKeys  - Array of journal_key values to fetch performances for
 * @param {object}   venueLookup  - window.allVenues — used to enrich City/Country on each row
 * @returns {Promise<object[]>}   - Normalised, enriched performance rows
 */
export const loadPerformances = async (journalKeys, venueLookup = {}) => {
    if (!journalKeys.length) return [];

    const CHUNK_SIZE = 100;
    const chunks = [];
    for (let i = 0; i < journalKeys.length; i += CHUNK_SIZE) {
        chunks.push(journalKeys.slice(i, i + CHUNK_SIZE));
    }

    const results = await Promise.all(
        chunks.map(chunk => supabase.from('performances').select('*').in('journal_key', chunk))
    );

    const errors = results.filter(r => r.error);
    if (errors.length) throw new Error(`Failed to load performances: ${errors[0].error.message}`);

    let rows = results.flatMap(r => r.data || []);

    // Normalise snake_case → app-expected casing (mirrors loadAppData)
    rows = rows.map(p => ({
        ...p,
        'Journal Key': p.journal_key    || p['Journal Key'] || '',
        Artist:        p.artist         || p.Artist         || '',
        Role:          p.role           || p.Role           || '',
        Setlist:       p.setlist        || p.Setlist        || '',
        OfficialVenue: p.official_venue || p.OfficialVenue  || '',
        SetlistURL:    p.setlist_url    || p.SetlistURL      || '',
    }));

    // Enrich with venue City/Country (mirrors loadAppData)
    rows.forEach(perf => {
        const venueInfo = resolveVenue(perf) || venueLookup[perf.OfficialVenue];
        if (venueInfo) {
            perf.City    = venueInfo.city    || '';
            perf.Country = venueInfo.country || '';
        }
    });

    return rows;
};


 /*
 * @param {string[]|null} officialVenues - Optional list of venue names to scope the fetch.
 *   Pass null (default) to fetch all venues — used by the editor's venue search and
 *   any other caller that needs the full table. loadAppData passes the user's journal
 *   venues here to keep the payload minimal on app load.
 *
 * Falls back to the CSV file if Supabase is unavailable.
 */
export const loadVenues = async (officialVenues = null) => {
    // Try Supabase first — scope to provided names if given
    let venueQuery = supabase.from('venues').select('*');
    if (officialVenues && officialVenues.length > 0) {
        venueQuery = venueQuery.in('official_name', officialVenues);
    }
    const { data, error } = await venueQuery;

    if (!error && data && data.length > 0) {
        const lookup = {};
        const byId   = {};
        data.forEach(v => {
            const info = _venueInfo(v);
            if (v.id != null) byId[v.id] = info;
            if (v.official_name) lookup[v.official_name] = info;
        });
        window.allVenues  = lookup;
        window.venuesById = { ...(window.venuesById || {}), ...byId };
        return lookup;
    }

    // Fallback to CSV if Supabase unavailable
    console.warn('Venues: Supabase unavailable, falling back to CSV');
    return new Promise((resolve, reject) => {
        Papa.parse('data/venues.csv', {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const lookup = {};
                results.data.forEach(v => {
                    if (v.OfficialName) {
                        lookup[v.OfficialName] = {
                            lat:      parseFloat(v.Latitude),
                            lng:      parseFloat(v.Longitude),
                            city:     v.City_y || v.City_x || v.District || 'Unknown City',
                            country:  v.Country  || 'Unknown Country',
                            capacity: v.Capacity || 'Unknown'
                        };
                    }
                });
                window.allVenues = lookup;
                resolve(lookup);
            },
            error: (err) => reject(err)
        });
    });
};


export const getUniqueSongCount = (filteredGigs) => {
    const perfs = window.performanceData || [];
    if (perfs.length === 0) return 0;

    const currentArtist = (window.currentArtist || '').toLowerCase();

    const gigsByKey = new Map(
        filteredGigs.map(g => [(g['Journal Key'] || g['JournalKey'] || "").trim(), g])
    );

    const uniqueSongs = new Set();

    perfs.forEach(perf => {
        const perfKey    = (perf['Journal Key'] || perf['JournalKey'] || "").trim();
        const perfArtist = (perf['Artist'] || perf['Band'] || "").toLowerCase();
        const row        = gigsByKey.get(perfKey);

        if (!row || perfArtist !== currentArtist) return;

        // At a festival, performanceData is a pool shared with every other
        // user who logged the same Journal Key — only count this artist's
        // songs if the row's own attendee logged seeing them (see utils.js).
        if (isFestivalRow(row)) {
            const ownLineup = getOwnFestivalLineup(row);
            if (ownLineup.size > 0 && !ownLineup.has(normalizeArtist(perfArtist))) return;
        }

        const setlistStr = perf['Setlist'] || "";
        if (setlistStr) {
            setlistStr.split('|').forEach(s => {
                const clean = s.trim();
                if (clean) uniqueSongs.add(clean);
            });
        }
    });

    return uniqueSongs.size;
};

/**
 * Filter Logic.
 *
 * Performance note: performanceData is pre-indexed by Journal Key so that
 * song/support searches are O(1) per row instead of O(n*m).
 */
export const filterGigs = (query, data, includeFuture = false) => {
    const q = query ? query.toLowerCase().trim() : "";
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // Pre-index performance data once per filter call rather than scanning
    // the full array for every journal row. Converts O(rows * perfs) to O(rows + perfs).
    const perfByKey = new Map();
    if (q.length > 2) {
        (window.performanceData || []).forEach(p => {
            const key = p['Journal Key'];
            if (!perfByKey.has(key)) perfByKey.set(key, []);
            perfByKey.get(key).push(p);
        });
    }

    return data.map(row => {
        const band        = (row.Band || row.Artist || "").toLowerCase();
        const lineup      = (row['Festival Lineups'] || "").toLowerCase();
        const notableSupp = (row['Notable Support'] || "").toLowerCase();
        const journalKey  = row['Journal Key'];
        // At a festival, perfByKey is pooled across every user who logged the
        // same Journal Key — scope it to this row's own Festival Lineups so
        // a search doesn't match on (or surface setlists from) a band another
        // attendee saw but this row's own user didn't (see utils.js).
        const perfsForKey = scopeFestivalPerformances(row, perfByKey.get(journalKey) || []);

        const hasSongMatch = q.length > 2 && perfsForKey.some(p =>
            (p['Setlist'] || "").toLowerCase().includes(q)
        );

        const isFestivalMatch = q.length > 2 && !band.includes(q) && lineup.includes(q);

        // Support match checks both the performances table (setlist-tracked shows)
        // AND the journal row's own free-text "Notable Support" field, since not
        // every support act logged there has a matching performances row.
        const isSupportMatch = q.length > 2 && !isFestivalMatch && (
            notableSupp.includes(q) ||
            perfsForKey.some(p =>
                (p.Artist || "").toLowerCase().includes(q) &&
                band !== (p.Artist || "").toLowerCase()
            )
        );

        const gigDate     = parseDate(row.Date);
        const matchFuture = includeFuture ? true : (gigDate && gigDate <= now);

        const basicMatch = [
            row.Date          || "",
            band,
            row.OfficialVenue || "",
            getCompanionsForGig(row).map(c => c.name).join(" "),
            row.City          || "",
            row.Country       || ""
        ].join(" ").toLowerCase().includes(q);

        const isVisible = (basicMatch || hasSongMatch || isFestivalMatch || isSupportMatch) && matchFuture;

        return {
            ...row,
            _isSongMatch:    hasSongMatch,
            _isFestMatch:    isFestivalMatch,
            _isSupportMatch: isSupportMatch,
            _visible:        isVisible
        };
    }).filter(r => r._visible);
};

/**
 * Aggregates band appearance stats (headline vs support) across attended shows.
 */
export const getBandAppearanceStats = (journalData, performanceData) => {
    // Keyed by normalized (trimmed, lowercased) artist name so that casing
    // differences between the journal's Band field and the performances
    // table's Artist field (e.g. "Weezer" vs "weezer") don't cause a show
    // to be miscounted as support instead of headline, and so this maps
    // cleanly onto the same normalized keys used in charts.js.
    const stats = {};
    const attendedShowsMap = new Map();

    journalData.forEach(j => {
        const key = j['Journal Key'];
        if (key) attendedShowsMap.set(key, (j['Band'] || '').trim().toLowerCase());
    });

    const processedPairs = new Set();

    performanceData.forEach(perf => {
        const key            = perf['journal_key'] || perf['Journal Key'];
        const artistNameRaw  = (perf['Artist'] || '').trim();
        const artistNameNorm = artistNameRaw.toLowerCase();

        if (!attendedShowsMap.has(key) || !artistNameNorm) return;

        const uniqueKey = `${key}|${artistNameNorm}`;
        if (processedPairs.has(uniqueKey)) return;
        processedPairs.add(uniqueKey);

        if (!stats[artistNameNorm]) {
            stats[artistNameNorm] = { display: artistNameRaw, headline: 0, support: 0, total: 0 };
        }

        if (attendedShowsMap.get(key) === artistNameNorm) {
            stats[artistNameNorm].headline++;
        } else {
            stats[artistNameNorm].support++;
        }
        stats[artistNameNorm].total++;
    });

    return stats;
};

/**
 * Checks the user's gig-photos storage bucket and sets window._gigPhotoCount.
 * Used by achievements.js for the Photographer badge.
 * A single list() call with limit:1 is enough — we only need to know if *any* files exist.
 */
export const loadGigPhotoStats = async (userId) => {
    if (!userId) { window._gigPhotoCount = 0; return; }
    const { data, error } = await supabase.storage
        .from('gig-photos')
        .list(userId, { limit: 1000 });
    window._gigPhotoCount = (!error && data) ? data.length : 0;
};

/**
 * Counts laminate items in collection_items for the current user.
 * Sets window._laminateCount — used by achievements.js for the VIP badge.
 */
export const loadCollectionStats = async (userId) => {
    if (!userId) { window._laminateCount = 0; return; }
    const { count, error } = await supabase
        .from('collection_items')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('subtype', 'laminate');
    window._laminateCount = (!error && count) ? count : 0;
};
/**
 * GigList - Data Module
 */
import { parseDate } from './utils.js';
import { supabase } from './supabase.js';

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
export const loadAppData = async (user, { skipPerformances = false } = {}) => {
    const escapeHTMLAttr = (str) => {
        if (!str) return '';
        return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    };

    const now = new Date();
    now.setHours(0, 0, 0, 0);

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
    const journalVenues = [...new Set(journalData.map(r => r.official_venue).filter(Boolean))];

// ── Step 1b: Artist lookup (spotify IDs for deep links) ──────────────────────
const journalBands = [...new Set(journalData.map(r => r.band).filter(Boolean))];
const artistLookup = {};

if (journalBands.length) {
    const ARTIST_CHUNK = 100;
    const artistChunks = [];
    for (let i = 0; i < journalBands.length; i += ARTIST_CHUNK) {
        artistChunks.push(journalBands.slice(i, i + ARTIST_CHUNK));
    }
    const artistResults = await Promise.all(
        artistChunks.map(chunk =>
            supabase.from('artists').select('name, spotify_artist_id, spotify_image_url').in('name', chunk)
        )
    );
    artistResults.flatMap(r => r.data || []).forEach(a => {
        artistLookup[a.name] = {
            spotify_artist_id: a.spotify_artist_id,
            spotify_image_url: a.spotify_image_url,
        };
    });
}

    // ── Step 2: Performances + Venues in parallel ─────────────────────────────
    // Both are scoped to the user's journal content to keep payloads minimal.
    // Performances are scoped by journal_key (not artist) so festival shows
    // return all acts on the lineup regardless of whether those artists appear
    // elsewhere in the user's personal journal.
    // Both fetches are batched in chunks of 100 to avoid URL length limits.
    const CHUNK_SIZE = 100;

    async function fetchPerformancesInBatches(keys) {
        if (!keys.length) return [];
        const chunks = [];
        for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
            chunks.push(keys.slice(i, i + CHUNK_SIZE));
        }
        const results = await Promise.all(
            chunks.map(chunk => supabase.from('performances').select('*').in('journal_key', chunk))
        );
        const errors = results.filter(r => r.error);
        if (errors.length) throw new Error(`Failed to load performances: ${errors[0].error.message}`);
        return results.flatMap(r => r.data || []);
    }

    async function fetchVenuesInBatches(venueNames) {
        if (!venueNames.length) return [];
        const chunks = [];
        for (let i = 0; i < venueNames.length; i += CHUNK_SIZE) {
            chunks.push(venueNames.slice(i, i + CHUNK_SIZE));
        }
        const results = await Promise.all(
            chunks.map(chunk => supabase.from('venues').select('*').in('official_name', chunk))
        );
        const errors = results.filter(r => r.error);
        if (errors.length) throw new Error(`Failed to load venues: ${errors[0].error.message}`);
        return results.flatMap(r => r.data || []);
    }

    const [perfRows, venueRows] = skipPerformances
        ? [[], await fetchVenuesInBatches(journalVenues)]
        : await Promise.all([
            fetchPerformancesInBatches(journalKeys),
            fetchVenuesInBatches(journalVenues),
          ]);

    const venueRes = { data: venueRows };

    // Build venue lookup from scoped results and stash on window for map/editor use
    const venueLookup = {};
    (venueRes.data || []).forEach(v => {
        if (v.official_name) {
            venueLookup[v.official_name] = {
                lat:      parseFloat(v.latitude)  || null,
                lng:      parseFloat(v.longitude) || null,
                city:     v.city     || 'Unknown City',
                country:  v.country  || 'Unknown Country',
                capacity: v.capacity || 'Unknown',
            };
        }
    });
    window.allVenues = venueLookup;

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
        row.safeKey = escapeHTMLAttr(row['Journal Key'] || '');

        const venueInfo = venueLookup[row.OfficialVenue];
        if (venueInfo) {
            row.City    = venueInfo.city    || '';
            row.Country = venueInfo.country || '';
        }
    });

    // Enrich performance rows
    performanceData.forEach(perf => {
        const venueInfo = venueLookup[perf.OfficialVenue];
        if (venueInfo) {
            perf.City    = venueInfo.city    || '';
            perf.Country = venueInfo.country || '';
        }
    });

    return { journalData, performanceData, user };
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
        const venueInfo = venueLookup[perf.OfficialVenue];
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
        data.forEach(v => {
            if (v.official_name) {
                lookup[v.official_name] = {
                    lat:      parseFloat(v.latitude)  || null,
                    lng:      parseFloat(v.longitude) || null,
                    city:     v.city     || 'Unknown City',
                    country:  v.country  || 'Unknown Country',
                    capacity: v.capacity || 'Unknown'
                };
            }
        });
        window.allVenues = lookup;
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

    const activeKeys = new Set(
        filteredGigs.map(g => (g['Journal Key'] || g['JournalKey'] || "").trim())
    );

    const uniqueSongs = new Set();

    perfs.forEach(perf => {
        const perfKey    = (perf['Journal Key'] || perf['JournalKey'] || "").trim();
        const perfArtist = (perf['Artist'] || perf['Band'] || "").toLowerCase();

        if (activeKeys.has(perfKey) && perfArtist === currentArtist) {
            const setlistStr = perf['Setlist'] || "";
            if (setlistStr) {
                setlistStr.split('|').forEach(s => {
                    const clean = s.trim();
                    if (clean) uniqueSongs.add(clean);
                });
            }
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
        const perfsForKey = perfByKey.get(journalKey) || [];

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
            row.Companion     || row['Went With'] || "",
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
    const stats = {};
    const attendedShowsMap = new Map();

    journalData.forEach(j => {
        const key = j['Journal Key'];
        if (key) attendedShowsMap.set(key, j['Band']);
    });

    const processedPairs = new Set();

    performanceData.forEach(perf => {
        const key        = perf['journal_key'] || perf['Journal Key'];
        const artistName = perf['Artist'];

        if (!attendedShowsMap.has(key) || !artistName) return;

        const uniqueKey = `${key}|${artistName}`;
        if (processedPairs.has(uniqueKey)) return;
        processedPairs.add(uniqueKey);

        if (!stats[artistName]) stats[artistName] = { headline: 0, support: 0, total: 0 };

        if (attendedShowsMap.get(key) === artistName) {
            stats[artistName].headline++;
        } else {
            stats[artistName].support++;
        }
        stats[artistName].total++;
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
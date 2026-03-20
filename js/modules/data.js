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
 */
export const loadAppData = async (user) => {
    const escapeHTMLAttr = (str) => {
        if (!str) return '';
        return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    };

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // Load venues first — needed to enrich journal and performance rows
    const venueLookup = await loadVenues();

    // Load journal rows
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
    } else {
        journalQuery = supabase
            .from('journals')
            .select('*')
            .eq('user_id', user.id)
            .range(0, 9999);
    }

    // Load performances in parallel with journals
    const [journalRes, perfRes] = await Promise.all([
        journalQuery,
        supabase.from('performances').select('*').range(0, 99999)
    ]);

    if (journalRes.error) throw new Error(`Failed to load journals: ${journalRes.error.message}`);
    if (perfRes.error)   throw new Error(`Failed to load performances: ${perfRes.error.message}`);

    let journalData     = journalRes.data || [];
    let performanceData = perfRes.data    || [];

    // Normalise column names from Supabase snake_case to the app's expected format
    // Supabase returns lowercase column names; the app expects the original CSV casing
    journalData = journalData.map(row => ({
        ...row,
        Band:              row.band             || row.Band             || '',
        OfficialVenue:     row.official_venue   || row.OfficialVenue    || '',
        'Journal Key':     row.journal_key      || row['Journal Key']   || '',
        'Festival?':       row.festival ? 'Y' : 'N',
        'Festival Lineups': row.festival_lineups || row['Festival Lineups'] || '',
        'Notable Support': row.notable_support  || row['Notable Support']  || '',
        'Went With':       row.went_with        || row['Went With']     || '',
        Comments:          row.comments         || row.Comments         || '',
        Photos:            row.photos           || row.Photos           || '',
        Price:             row.price            || row.Price            || '',
        Date:              row.date             || row.Date             || '',
        Year:              row.year             || row.Year             || '',
        Month:             row.month            || row.Month            || '',
        Day:               row.day              || row.Day              || '',
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
 * Loads the venue lookup from Supabase.
 * Falls back to the CSV file if Supabase is unavailable.
 */
export const loadVenues = async () => {
    // Try Supabase first
    const { data, error } = await supabase.from('venues').select('*');

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
        const journalKey  = row['Journal Key'];
        const perfsForKey = perfByKey.get(journalKey) || [];

        const hasSongMatch = q.length > 2 && perfsForKey.some(p =>
            (p['Setlist'] || "").toLowerCase().includes(q)
        );

        const isFestivalMatch = q.length > 2 && !band.includes(q) && lineup.includes(q);

        const isSupportMatch = q.length > 2 && !isFestivalMatch && perfsForKey.some(p =>
            (p.Artist || "").toLowerCase().includes(q) &&
            band !== (p.Artist || "").toLowerCase()
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
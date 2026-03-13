/**
 * GigList - Data Module
 */
import { parseDate } from './utils.js';

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
 * Data Loading
 */
export const loadAppData = async (user) => {
    const version = new Date().getTime();
    const journalUrl = `data/${user.JournalFile}?v=${version}`;
    const perfUrl = `data/performances.csv?v=${version}`;

    const escapeHTMLAttr = (str) => {
        if (!str) return '';
        return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    };

    // Fetch all sources in parallel. loadVenues is called once here — app.js
    // stores the result as window.venueLookup so it does not need to call it again.
    const [journalRes, perfRes, venueLookup] = await Promise.all([
        fetch(journalUrl),
        fetch(perfUrl),
        loadVenues()
    ]);

    // Guard against failed fetches (e.g. missing CSV files returning 404 HTML)
    if (!journalRes.ok) throw new Error(`Failed to load journal: ${journalRes.status} ${journalUrl}`);
    if (!perfRes.ok)    throw new Error(`Failed to load performances: ${perfRes.status} ${perfUrl}`);

    const [journalResult, performanceResult] = await Promise.all([
        journalRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true })),
        perfRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true }))
    ]);

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let journalData = journalResult.data;
    let performanceData = performanceResult.data;

    // Standardize and enrich journal rows
    journalData.forEach(row => {
        row.Band = row.Band || row.Artist;
        // Tag future vs past correctly so downstream code can rely on this
        const gigDate = parseDate(row.Date);
        row.type = (gigDate && gigDate >= now) ? 'future' : 'past';
        row.safeKey = escapeHTMLAttr(row['Journal Key'] || "");

        const venueInfo = venueLookup[row.OfficialVenue];
        if (venueInfo) {
            row.City    = venueInfo.city    || "";
            row.Country = venueInfo.country || "";
        }
    });

    // Enrich performance rows with geography
    performanceData.forEach(perf => {
        const venueInfo = venueLookup[perf.OfficialVenue];
        if (venueInfo) {
            perf.City    = venueInfo.city    || "";
            perf.Country = venueInfo.country || "";
        }
    });

    return { journalData, performanceData, user };
};

/**
 * Calculates unique songs for the current band in band mode.
 */
export const getUniqueSongCount = (filteredGigs) => {
    const perfs = window.performanceData || [];
    if (perfs.length === 0) return 0;

    const user = JSON.parse(localStorage.getItem('gv_user'));
    const currentArtist = (user?.UserName || user?.user_name || "").toLowerCase();

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
 * Loads and indexes the venue database.
 * Called once inside loadAppData; the result is also stored as window.venueLookup
 * by app.js so subsequent calls are not needed.
 */
export const loadVenues = async () => {
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
                            city:     v.City_y || v.City_x || v.District || "Unknown City",
                            country:  v.Country  || "Unknown Country",
                            capacity: v.Capacity || "Unknown"
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
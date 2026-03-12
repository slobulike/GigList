/**
 * GigList - Data Module
 */
import { formatDate, parseDate } from './utils.js';

export let journalData = [];
export let performanceData = [];


/**
 * Helper to determine show type based on keywords
 */
export const deriveType = (gig) => {
    if (gig.Type && gig.Type !== "nan" && gig.Type.trim() !== "") return gig.Type;

    const venueLower = (gig.OfficialVenue || "").toLowerCase();

    // Keywords for TV
    const tvKeywords = ['jimmy', 'top of the pops', 'snl', 'letterman', 'tonight show', 'tiringo', 'mtv'];
    if (tvKeywords.some(key => venueLower.includes(key))) return "TV";

    // Keywords for Festivals
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
 * GigList - Data Loading Logic
 */
export const loadAppData = async (user) => {
    const version = new Date().getTime();
    const journalUrl = `data/${user.JournalFile}?v=${version}`;
    const perfUrl = `data/performances.csv?v=${version}`;

    const escapeHTMLAttr = (str) => {
        if (!str) return '';
        return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    };

    // 1. Fetch all three data sources in parallel
    const [journalRes, perfRes, venueLookup] = await Promise.all([
        fetch(journalUrl),
        fetch(perfUrl),
        loadVenues() // This is your existing function that returns the lookup object
    ]);

    const [journalResult, performanceResult] = await Promise.all([
        journalRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true })),
        perfRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true }))
    ]);

    let journalData = journalResult.data;
    let performanceData = performanceResult.data;

    // 2. Standardize and Enrich Journal Data
    journalData.forEach(row => { // Ensure this says 'row'
        row.Band = row.Band || row.Artist;
        row.type = 'past';
        row.safeKey = escapeHTMLAttr(row['Journal Key'] || "");

        // Match geography from the venueLookup
        const venueInfo = venueLookup[row.OfficialVenue];
        if (venueInfo) {
            row.City = venueInfo.city || "";
            row.Country = venueInfo.country || "";
        }
    });

    // 3. Enrich Performance Data
    performanceData.forEach(perf => {
        const venueInfo = venueLookup[perf.OfficialVenue];
        if (venueInfo) {
            perf.City = venueInfo.city || "";
            perf.Country = venueInfo.country || "";
        }
    });

    return { journalData, performanceData, user };
};

/**
 * Calculates unique songs based on passed performance data
 */
export const getUniqueSongCount = (filteredGigs) => {
    const perfs = window.performanceData || [];
    if (perfs.length === 0) return 0;

    // 1. Get the current Band Name from the user profile
    const user = JSON.parse(localStorage.getItem('gv_user'));
    const currentArtist = (user?.UserName || user?.user_name || "").toLowerCase();

    // 2. Build the Set of keys for the gigs currently on screen
    const activeKeys = new Set(filteredGigs.map(g => (g['Journal Key'] || g['JournalKey'] || "").trim()));

    const uniqueSongs = new Set();

    perfs.forEach(perf => {
        const perfKey = (perf['Journal Key'] || perf['JournalKey'] || "").trim();
        const perfArtist = (perf['Artist'] || perf['Band'] || "").toLowerCase();

        // 3. Handshake: Must match the Date/Venue key AND the Artist
        if (activeKeys.has(perfKey) && perfArtist === currentArtist) {
            // 4. Your CSV uses "Setlist" with songs separated by "|"
            const setlistStr = perf['Setlist'] || "";
            if (setlistStr) {
                const songs = setlistStr.split('|');
                songs.forEach(s => {
                    const cleanSong = s.trim();
                    if (cleanSong) uniqueSongs.add(cleanSong);
                });
            }
        }
    });

    console.log(`📊 Stats: Found ${uniqueSongs.size} unique songs for ${currentArtist}`);
    return uniqueSongs.size;
};

/**
 * Filter Logic
 */
export const filterGigs = (query, data, includeFuture = false) => {
    const q = query ? query.toLowerCase().trim() : "";
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    return data.map(row => {
        const band = (row.Band || row.Artist || "").toLowerCase();
        const lineup = (row['Festival Lineups'] || "").toLowerCase();
        const journalKey = row['Journal Key'];

        // 1. Calculate the Deep Match Flags
        const hasSongMatch = q.length > 2 && (window.performanceData || []).some(p =>
            p['Journal Key'] === journalKey && (p['Setlist'] || "").toLowerCase().includes(q)
        );

        const isFestivalMatch = q.length > 2 && !band.includes(q) && lineup.includes(q);

        const isSupportMatch = q.length > 2 && !isFestivalMatch && (window.performanceData || []).some(p =>
            p['Journal Key'] === journalKey &&
            p.Artist.toLowerCase().includes(q) &&
            band !== p.Artist.toLowerCase()
        );

        // 2. Determine Visibility
        const gigDate = parseDate(row.Date);
        const matchFuture = includeFuture ? true : (gigDate && gigDate <= now);

        // --- UPDATED: Added row.City and row.Country to basicMatch ---
        const basicMatch = `
            ${band}
            ${row.OfficialVenue || ""}
            ${row.Companion || row['Went With'] || ""}
            ${row.City || ""}
            ${row.Country || ""}
        `.toLowerCase().includes(q);

        const isVisible = (basicMatch || hasSongMatch || isFestivalMatch || isSupportMatch) && matchFuture;

        // 3. Return the enriched object
        return {
            ...row,
            _isSongMatch: hasSongMatch,
            _isFestMatch: isFestivalMatch,
            _isSupportMatch: isSupportMatch,
            _visible: isVisible
        };
    }).filter(r => r._visible);
};

/**
 * Loads the Venue database for mapping coordinates
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
                    // Using OfficialName as our primary key
                    if (v.OfficialName) {
                        lookup[v.OfficialName] = {
                            lat: parseFloat(v.Latitude),
                            lng: parseFloat(v.Longitude),
                            // Handle the Pandas merge suffixes
                            city: v.City_y || v.City_x || v.District || "Unknown City",
                            country: v.Country || "Unknown Country",
                            capacity: v.Capacity || "Unknown"
                        };
                    }
                });
                window.allVenues = lookup; // Store globally for Achievements
                console.log(`Loaded ${Object.keys(lookup).length} enriched venues.`);
                resolve(lookup);
            },
            error: (err) => reject(err)
        });
    });
};

/**
 * Aggregates band appearance statistics across headline and performance data.
 * Updated to filter against the user's actual journal keys.
 */
export const getBandAppearanceStats = (journalData, performanceData) => {
    const stats = {};
    const attendedShowsMap = new Map();

    journalData.forEach(j => {
        const key = j['Journal Key'];
        const headlineBand = j['Band'];
        if (key) attendedShowsMap.set(key, headlineBand);
    });

    // Track processed artist-key pairs to prevent double-counting per show
    const processedPairs = new Set();

    performanceData.forEach(perf => {
        const key = perf['journal_key'] || perf['Journal Key'];
        const artistName = perf['Artist'];

        if (!attendedShowsMap.has(key) || !artistName) return;

        // Unique identifier for this artist at this specific show
        const uniqueKey = `${key}|${artistName}`;
        if (processedPairs.has(uniqueKey)) return;

        processedPairs.add(uniqueKey);

        if (!stats[artistName]) {
            stats[artistName] = { headline: 0, support: 0, total: 0 };
        }

        if (attendedShowsMap.get(key) === artistName) {
            stats[artistName].headline++;
        } else {
            stats[artistName].support++;
        }
        stats[artistName].total++;
    });

    return stats;
};
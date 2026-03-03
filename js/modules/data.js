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

    const [journalRes, perfRes] = await Promise.all([
        fetch(journalUrl),
        fetch(perfUrl)
    ]);

    const [journalResult, performanceResult] = await Promise.all([
        journalRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true })),
        perfRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true }))
    ]);

    journalData = journalResult.data;
    performanceData = performanceResult.data;

    journalData.forEach(g => {
        g.Band = g.Band || g.Artist;
        g.type = 'past';
        g.safeKey = escapeHTMLAttr(g['Journal Key'] || "");
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

    // 1. Find all Journal Keys matching the song search
    const matchingKeysBySong = q ? (window.performanceData || [])
        .filter(p => p.Setlist && p.Setlist.toLowerCase().includes(q))
        .map(p => p['Journal Key']) : [];

    return data.filter(g => {
        // 2. Use the standard parseDate from utils.js
        const gigDate = parseDate(g.Date);
        if (!includeFuture && gigDate && gigDate > now) return false;

        if (!q) return true;

        const band = (g.Band || g.Artist || "").toLowerCase();
        const venue = (g.OfficialVenue || "").toLowerCase();
        const companion = (g.Companion || g['Went With'] || "").toLowerCase();
        const role = (g.Role || "").toLowerCase(); // Restore Support search
        const type = (g.Type || "").toLowerCase(); // Restore Festival search
        const dateStr = (g.Date || "");
        const journalKey = g['Journal Key'];

        // 3. The Match Logic (Cumulative & Deep)
        return (
            band.includes(q) ||
            venue.includes(q) ||
            companion.includes(q) ||
            role.includes(q) ||
            type.includes(q) ||
            dateStr.includes(q) ||
            matchingKeysBySong.includes(journalKey)
        );
    });
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
                    if (v.OfficialName) {
                        lookup[v.OfficialName] = {
                            lat: parseFloat(v.Latitude),
                            lng: parseFloat(v.Longitude)
                        };
                    }
                });
                console.log(`Loaded ${Object.keys(lookup).length} venues for mapping.`);
                resolve(lookup);
            },
            error: (err) => {
                console.error("Error loading venues.csv:", err);
                reject(err);
            }
        });
    });
};
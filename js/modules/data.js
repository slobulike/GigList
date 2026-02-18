/**
 * GigList - Data Module
 */
import { formatDate, parseDate } from './utils.js';

export let journalData = [];
export let performanceData = [];

/**
 * Sorts an array of gig objects based on column and direction
 */
export const sortGigs = (data, column, ascending = true) => {
    return [...data].sort((a, b) => {
        let valA = a[column] || "";
        let valB = b[column] || "";

        // Use the imported parseDate from utils.js
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

    // 1. Fetch both in parallel
    const [journalRes, perfRes] = await Promise.all([
        fetch(journalUrl),
        fetch(perfUrl)
    ]);

    // 2. Extract text and parse concurrently
    // This is faster because parsing starts as soon as the text is ready
    const [journalResult, performanceResult] = await Promise.all([
        journalRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true })),
        perfRes.text().then(text => Papa.parse(text, { header: true, skipEmptyLines: true }))
    ]);

    journalData = journalResult.data;
    performanceData = performanceResult.data;

    // 3. Normalization (Efficient loop)
    journalData.forEach(g => {
        g.Band = g.Band || g.Artist;
        g.type = 'past';
        g.safeKey = escapeHTMLAttr(g['Journal Key'] || "");
    });

    return { journalData, performanceData };
};

export const filterGigs = (query, data, includeFuture = false) => {

if (!query) return data;

const q = query.toLowerCase().trim();
const now = new Date();

// 1. First, find all Journal Keys that contain this song in performanceData

const matchingKeysBySong = performanceData

.filter(p => p.Setlist && p.Setlist.toLowerCase().includes(q))

.map(p => p['Journal Key']);



// 2. Filter the main journal data

return data.filter(g => {

// Date check

const gigDate = new Date(g.Date || "");

if (!includeFuture && gigDate > now) return false;



const band = (g.Band || g.Artist || "").toLowerCase();

const venue = (g.OfficialVenue || "").toLowerCase();

const companion = (g.Companion || g['Went With'] || "").toLowerCase();

const dateStr = (g.Date || "");

const journalKey = g['Journal Key'];



// 3. The Match Logic:

return (

band.includes(q) ||

venue.includes(q) ||

companion.includes(q) ||

dateStr.includes(q) ||

matchingKeysBySong.includes(journalKey) // This catches the song titles!

);

});

};





/**

* Loads the Venue database for mapping coordinates

*/

export const loadVenues = async () => {

return new Promise((resolve, reject) => {

Papa.parse('data/venues.csv', { // Updated path to include data/ folder

download: true,

header: true,

skipEmptyLines: true,

complete: (results) => {

const lookup = {};

results.data.forEach(v => {

// Use 'OfficialName' as the key to match your venues.csv header

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
/**
 * GigList - Utilities Module
 */

/**
 * Cleans artist names to match filenames produced by the Python script.
 * e.g. "Frank Turner" -> "frank_turner", "AC/DC" -> "ac_dc"
 */
export const cleanNameForFile = (name) => {
    if (!name) return 'default';
    return name.toLowerCase()
               .replace(/\s+/g, '_')
               .replace(/'/g, '')
               .replace(/\//g, '_');
};

/**
 * Parses DD/MM/YYYY strings into JS Date objects.
 * Returns null for missing or "nan" values.
 * Falls back to native Date parsing for ISO-format strings (YYYY-MM-DD).
 */
export const parseDate = (dateStr) => {
    if (!dateStr || dateStr === "nan") return null;
    const parts = dateStr.split('/');
    if (parts.length !== 3) return new Date(dateStr);
    return new Date(parts[2], parts[1] - 1, parts[0]);
};

/**
 * Formats a date string for display, e.g. "5 Mar 2024"
 */
export const formatDate = (dateStr) => {
    const d = parseDate(dateStr);
    if (!d || isNaN(d)) return "Date TBC";
    return d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
};

/**
 * Converts an artist name to an underscore slug for asset filenames.
 * e.g. "Frank Turner" -> "frank_turner"
 */
export const slugifyArtist = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^\w]+/g, '')
        .replace(/__+/g, '_')
        .replace(/^_|_$/g, '');
};

/**
 * Converts a venue name to a hyphen slug for asset filenames.
 * e.g. "O2 Academy Leeds" -> "o2-academy-leeds"
 */
export const slugify = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-')
        .replace(/^-+|-+$/g, '');
};

/**
 * Counts how many times a band appears in a dataset.
 * Note: ui.js filters to past-only before calling this for future carousel cards.
 */
export const getGlobalSeenCount = (bandName, data) => {
    if (!bandName || !data) return 0;
    return data.filter(g => (g.Band || "").toLowerCase() === bandName.toLowerCase()).length;
};

/**
 * Builds the image fallback chain for a gig:
 * 1. Personal scrapbook photo  2. Artist stock photo  3. Unsplash default
 */
export const getGigImage = (gig) => {
    const venueSafe  = gig.OfficialVenue
        ? gig.OfficialVenue.replace(/[^a-z0-9]/gi, '_').toLowerCase()
        : 'unknown';
    const date       = gig.Date || '0000-00-00';
    const artistSafe = cleanNameForFile(gig.Band || gig.Artist);

    const scrapbookPath = `assets/scrapbook/${date}-${venueSafe}.jpg`;
    const stockPath     = `assets/scrapbook/artists/${artistSafe}_stock_photo.jpg`;

    const defaultImages = [
        'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=800&q=75',
        'https://images.unsplash.com/photo-1459749411177-042180ce673c?auto=format&fit=crop&w=800&q=75',
        'https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=800&q=75'
    ];
    const hash          = (gig.Band || gig.Artist || "").length;
    const fallbackImage = defaultImages[hash % defaultImages.length];

    return { scrapbookPath, stockPath, fallbackImage };
};
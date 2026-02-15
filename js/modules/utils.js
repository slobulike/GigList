/**
 * GigList - Utilities Module
 */

// Clean artist names to match the files from your Python script
export const cleanNameForFile = (name) => {
    if (!name) return 'default';
    return name.toLowerCase()
               .replace(/\s+/g, '_')
               .replace(/'/g, '')
               .replace(/\//g, '_');
};

/**
 * Standardizes DD/MM/YYYY into a JS Date Object
 */
export const parseDate = (dateStr) => {
    if (!dateStr || dateStr === "nan") return null;
    const parts = dateStr.split('/');
    if (parts.length !== 3) return new Date(dateStr); // Fallback
    // Note: months are 0-indexed in JS
    return new Date(parts[2], parts[1] - 1, parts[0]);
};

/**
 * Formats a date for UI display
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
 * Converts strings to filesystem-friendly slugs
 * Example: "Little John's Farm" -> "little-johns-farm"
 */
export const slugifyArtist = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '_')           // Use underscores for artists
        .replace(/[^\w\_]+/g, '')       // Keep only alphanumeric and underscores
        .replace(/\_\_+/g, '_')         // No double underscores
        .replace(/^_Local-/, '')        // Clean up start/end
        .replace(/_$/, '');
};

// Keep the standard one for Venues if they use hyphens
export const slugify = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
};

export const getGlobalSeenCount = (bandName, data) => {
    if (!bandName || !data) return 0;
    return data.filter(g => g.Band.toLowerCase() === bandName.toLowerCase()).length;
};

// The Fallback Chain: Personal -> Spotify Stock -> Default Placeholder
export const getGigImage = (gig) => {
    const venueSafe = gig.OfficialVenue ? gig.OfficialVenue.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'unknown';
    const date = gig.Date || '0000-00-00';

    // 1. Personal scrapbook image
    const scrapbookPath = `assets/scrapbook/${date}-${venueSafe}.jpg`;

    // 2. Spotify stock image (from your fetch_artists.py)
    const artistSafe = cleanNameForFile(gig.Band || gig.Artist);
    const stockPath = `assets/scrapbook/artists/${artistSafe}_stock_photo.jpg`;

    // 3. Random default selection logic
    const defaultImages = [
        'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=800&q=75',
        'https://images.unsplash.com/photo-1459749411177-042180ce673c?auto=format&fit=crop&w=800&q=75',
        'https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=800&q=75'
    ];
    const hash = (gig.Band || gig.Artist || "").length;
    const fallbackImage = defaultImages[hash % defaultImages.length];

    return { scrapbookPath, stockPath, fallbackImage };
};
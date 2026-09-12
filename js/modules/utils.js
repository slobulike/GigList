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
 * Escapes HTML special characters so untrusted strings (item titles,
 * usernames, band names, anything that came from a user, not just "the
 * current user") can be safely interpolated into innerHTML template text.
 *
 * This is the ONE canonical HTML escaper for the app — collection.js,
 * collection-editor.js, and onboarding.js each used to define their own
 * local `_esc()`, and two of the three only escaped quote characters
 * (fine for JS-string-literal contexts, not safe for HTML text/attributes).
 * Import this instead of writing a new one.
 *
 * NOT sufficient by itself inside inline event-handler attributes like
 * onclick="fn('${...}')" — that's a JS string literal nested inside an
 * HTML attribute, and needs escaping for both layers. Prefer the
 * data-attribute + delegated-listener pattern (see collection.js) over
 * inline onclick handlers so this doesn't come up.
 */
export const escapeHtml = (val) => {
    if (val == null) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/**
 * Normalizes an artist name for case/whitespace-insensitive comparison.
 */
export const normalizeArtist = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * True if a journal row is a festival show. Accepts either the raw
 * Supabase boolean (`row.festival`) or the CSV/export-style 'Y'/'N' string
 * (`row['Festival?']`).
 */
export const isFestivalRow = (row) => {
    const raw = row?.['Festival?'] ?? row?.festival;
    return typeof raw === 'boolean' ? raw : (raw || '').toString().trim().toUpperCase().startsWith('Y');
};

/**
 * The set of artists a festival row's own attendee logged as seeing, from
 * its 'Festival Lineups' field (bands joined with '/', see editor.js).
 * Also tolerates '|' as a separator for older/imported rows.
 */
export const getOwnFestivalLineup = (row) => {
    const raw = row?.['Festival Lineups'] || row?.FestivalLineups || '';
    return new Set(raw.split(/[/|]/).map(normalizeArtist).filter(Boolean));
};

/**
 * Scopes a shared pool of synced performances down to a festival journal
 * row's own lineup. `performanceData` is pooled across every user who
 * logged the same festival Journal Key (see loadPerformances in data.js) —
 * without this, every attendee sees the union of everyone's logged
 * festival bands, not just the ones they personally recorded seeing.
 *
 * Non-festival rows are returned unfiltered (the headline/support acts are
 * the same fact for every attendee, so there's nothing to scope). A
 * festival row with no recorded lineup (e.g. a legacy row) also falls back
 * to unfiltered, rather than silently filtering everything out.
 *
 * @param row    the journal row the performances are being scoped to
 * @param perfs  array of performance-like objects to filter
 * @param getArtist  extracts the artist name from one entry of `perfs`
 */
export const scopeFestivalPerformances = (row, perfs, getArtist = (p) => p.Artist || p.artist) => {
    if (!isFestivalRow(row)) return perfs;
    const ownLineup = getOwnFestivalLineup(row);
    if (ownLineup.size === 0) return perfs;
    return perfs.filter(p => ownLineup.has(normalizeArtist(getArtist(p))));
};

/**
 * Same scoping as scopeFestivalPerformances, but for a Map<normalizedArtist,
 * displayName> (the shape charts.js builds its per-show artist lookups in).
 */
export const scopeFestivalArtistMap = (row, artistMap) => {
    if (!isFestivalRow(row)) return artistMap;
    const ownLineup = getOwnFestivalLineup(row);
    if (ownLineup.size === 0) return artistMap;
    const scoped = new Map();
    artistMap.forEach((display, key) => {
        if (ownLineup.has(key)) scoped.set(key, display);
    });
    return scoped;
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
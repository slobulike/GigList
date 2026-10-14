/**
 * GigList — Artist Images
 * =======================
 * Picks which image to show for an artist when we have more than one.
 *
 *   await loadArtistImages(artists.map(a => a.id));   // once per screen
 *   const url = pickArtistImage(artist, { strategy: 'stable', seed: gig.id });
 *
 * Strategies:
 *   'latest' — artists.spotify_image_url (today's behaviour; the default)
 *   'stable' — varies by `seed` (e.g. gig id): same card always gets the same
 *              image, different cards for the same artist can differ
 *   'daily'  — one image per artist per day, changing at midnight (UTC)
 *   'random' — new pick on every render (use sparingly; it flickers)
 *
 * Always falls back to the current image, so it's safe to use before
 * loadArtistImages has finished or for artists with only one image.
 */

import { supabase } from './supabase.js';

const _cache = new Map();   // artist id -> [{ url, is_current }] (stable order)
const CHUNK = 100;

export async function loadArtistImages(artistIds) {
    const missing = [...new Set(artistIds)].filter(id => id != null && !_cache.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
        const ids = missing.slice(i, i + CHUNK);
        const { data, error } = await supabase
            .from('artist_images')
            .select('artist_id, url, is_current, first_seen_at')
            .in('artist_id', ids);
        if (error) { console.warn('[images] load failed:', error); return; }

        ids.forEach(id => _cache.set(id, []));
        data.forEach(row => _cache.get(row.artist_id).push(row));
        // Stable order so an index always means the same image.
        ids.forEach(id => _cache.get(id).sort((a, b) =>
            a.first_seen_at.localeCompare(b.first_seen_at) || a.url.localeCompare(b.url)));
    }
}

export function pickArtistImage(artist, { strategy = 'latest', seed = '' } = {}) {
    const latest = artist.spotify_image_url || null;
    if (strategy === 'latest') return latest;

    const images = _cache.get(artist.id);
    if (!images || images.length < 2) return latest;

    let i;
    if (strategy === 'random') {
        i = Math.floor(Math.random() * images.length);
    } else {
        const day = new Date().toISOString().slice(0, 10);
        i = _hash(`${artist.id}:${strategy === 'daily' ? day : seed}`) % images.length;
    }
    return images[i].url;
}

/**
 * Ordered list of images to try for an artist: the picked one first, then the
 * current image, then every other image we have. Lets a dead URL fall through
 * to another photo of the same artist instead of a stock fallback.
 */
export function artistImageCandidates(artist, opts) {
    const first = pickArtistImage(artist, opts);
    const rest  = [artist.spotify_image_url, ...(_cache.get(artist.id) || []).map(i => i.url)];
    return [...new Set([first, ...rest].filter(Boolean))];
}

// FNV-1a — small, fast, and good enough for spreading picks evenly.
function _hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
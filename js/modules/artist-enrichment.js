/**
 * GigList — Artist Enrichment Module
 * =====================================
 * Single source of truth for hydrating a newly-created (or under-enriched)
 * artist row with an MBID (setlist.fm) and Spotify metadata (id, image, url).
 *
 * Call enrichNewArtist(name) right after any code path creates or resolves
 * an artist — editor.js (saveGig), collection-editor.js, wishlist.js. This
 * replaces three near-identical inline copies of the same two API calls
 * that had drifted out of sync (one of editor.js's copies even referenced
 * a function that no longer existed and was silently dead code).
 *
 * Not gated by show date. That gate only ever made sense for the setlist.fm
 * *setlist* lookup — a future show has no setlist yet — but an artist's
 * MBID and Spotify metadata exist independent of when any particular show
 * happens, so enrichment always fires as soon as the artist exists.
 *
 * Fire-and-forget by design: callers don't need to await the Spotify half,
 * and every write is guarded with `.is(column, null)` so calling this
 * against an already-enriched artist is a safe no-op, not a clobber.
 */

import { supabase } from './supabase.js';
import { WORKER_URL } from './setlist-sync.js';

/**
 * @param {string} artistName
 * @returns {Promise<string|null>} the mbid if one was found, else null.
 *   Callers that need to chain a setlist lookup (saveGig) can reuse this
 *   return value instead of re-fetching the same thing themselves.
 */
export async function enrichNewArtist(artistName) {
    const name = artistName?.trim();
    if (!name) return null;

    const mbid = await _hydrateMbid(name);
    _hydrateSpotify(name); // independent of mbid result, always attempted
    return mbid;
}

// ─── MBID (setlist.fm) ──────────────────────────────────────────────────────

async function _hydrateMbid(name) {
    try {
        const searchUrl = `${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(name)}`;
        const res = await fetch(searchUrl);
        if (!res.ok) return null;

        const data = await res.json();
        const mbid = data.artist?.[0]?.mbid;
        if (!mbid) return null;

        // Non-blocking write — caller doesn't need to wait on this to proceed.
        supabase
            .from('artists')
            .update({ mbid })
            .eq('name', name)
            .is('mbid', null)
            .then(() => console.log(`[enrich] mbid set for ${name}`))
            .catch(e => console.warn('[enrich] mbid write failed:', e));

        return mbid;
    } catch (e) {
        console.warn(`[enrich] setlist.fm lookup failed for ${name}:`, e);
        return null;
    }
}

// ─── Spotify ──────────────────────────────────────────────────────────────────

function _hydrateSpotify(name) {
    fetch(`${WORKER_URL}/?endpoint=spotify-artist&name=${encodeURIComponent(name)}`)
        .then(r => r.json())
        .then(async spotifyData => {
            if (!spotifyData.id) return;
            await supabase.from('artists').update({
                spotify_artist_id: spotifyData.id,
                spotify_image_url: spotifyData.image_url || null,
                spotify_url:       spotifyData.url || null,
            }).eq('name', name).is('spotify_artist_id', null);
        })
        .catch(e => console.warn('[enrich] spotify hydration failed for', name, e));
}
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
 *
 * Image history: `artists.spotify_image_url` stays as the *current* image
 * (everything else in the app reads it), while `artist_images` keeps every
 * image we've ever seen for an artist. See refreshArtistImage() below.
 */

import { supabase, authedFetch } from './supabase.js';
import { WORKER_URL } from './setlist-sync.js';

/**
 * Artists that keep an image history. Weezer only for now — widen this set
 * (or drop the check entirely) once the approach has proven itself.
 */
const IMAGE_HISTORY_ARTISTS = new Set(['Weezer']);

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

/**
 * Re-check Spotify for an artist's current image and record it in
 * `artist_images`. If it's new, it becomes the current image and
 * `artists.spotify_image_url` is updated to match; the previous image is
 * kept in the table (is_current = false), never deleted.
 *
 * Only runs for artists in IMAGE_HISTORY_ARTISTS. Safe to call repeatedly.
 *
 * @param {string} artistName
 * @returns {Promise<string|null>} the current image URL, or null.
 */
export async function refreshArtistImage(artistName) {
    const name = artistName?.trim();
    if (!name || !IMAGE_HISTORY_ARTISTS.has(name)) return null;

    try {
        const res = await authedFetch(`${WORKER_URL}/?endpoint=spotify-artist&name=${encodeURIComponent(name)}`);
        if (!res.ok) return null;
        const spotify = await res.json();
        const latest = spotify.image_url;
        if (!spotify.id || !latest) return null;

        const { data: artist, error: artistErr } = await supabase
            .from('artists')
            .select('id, spotify_image_url')
            .eq('name', name)
            .maybeSingle();
        if (artistErr || !artist) return null;

        // Nothing new — the stored image is already the latest.
        if (artist.spotify_image_url === latest) return latest;

        // 1. Record both images (no-op for any already in the table). Rows
        //    are inserted as non-current; the flip happens below so the
        //    one-current-per-artist index is never violated.
        const rows = [artist.spotify_image_url, latest]
            .filter(Boolean)
            .map(url => ({ artist_id: artist.id, url, source: 'spotify' }));
        const { error: insErr } = await supabase
            .from('artist_images')
            .upsert(rows, { onConflict: 'artist_id,url', ignoreDuplicates: true });
        if (insErr) throw insErr;

        // 2. Flip the current flag: clear the old one first, then set the new one.
        await supabase.from('artist_images')
            .update({ is_current: false })
            .eq('artist_id', artist.id).eq('source', 'spotify').eq('is_current', true);
        await supabase.from('artist_images')
            .update({ is_current: true })
            .eq('artist_id', artist.id).eq('url', latest);

        // 3. Keep the denormalised "current" column everything else reads in sync.
        await supabase.from('artists')
            .update({ spotify_image_url: latest })
            .eq('id', artist.id);

        console.log(`[enrich] image updated for ${name}`);
        return latest;
    } catch (e) {
        console.warn(`[enrich] image refresh failed for ${name}:`, e);
        return null;
    }
}

// ─── MBID (setlist.fm) ──────────────────────────────────────────────────────

async function _hydrateMbid(name) {
    try {
        const searchUrl = `${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(name)}`;
        const res = await authedFetch(searchUrl);
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
    authedFetch(`${WORKER_URL}/?endpoint=spotify-artist&name=${encodeURIComponent(name)}`)
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
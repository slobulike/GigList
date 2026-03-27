/**
 * GigList — Artist Sync Module
 * =============================
 * Two responsibilities:
 *
 * 1. searchArtists(name) — searches setlist.fm for artists matching a name,
 *    returns candidates with MBID for the user to confirm. Used in the gig
 *    modal "Add to Archive" flow and the admin dashboard.
 *
 * 2. submitArchiveRequest(artistName, mbid) — inserts a row into band_requests
 *    for admin review. Used by regular users from the gig modal.
 *
 * Admin approval (running the actual sync) is handled directly in
 * admin_dashboard.html via the band-archive-cron Worker's manual trigger,
 * so no full sync logic lives here — that keeps the service key server-side.
 */

import { supabase } from './supabase.js';

const WORKER_URL = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';

// ─── Artist search ────────────────────────────────────────────────────────────

/**
 * Search setlist.fm for artists matching a name.
 * Returns an array of { name, mbid, url, disambiguation } candidates.
 */
export async function searchArtists(name) {
    if (!name?.trim()) return [];

    const url = `${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(name.trim())}`;
    const res  = await fetch(url);

    if (!res.ok) throw new Error(`Artist search failed: ${res.status}`);

    const data = await res.json();
    const artists = data?.artist || [];

    const mapped = artists.map(a => ({
        name:           a.name,
        mbid:           a.mbid,
        disambiguation: a.disambiguation || null,
        url:            a.url || null,
    }));

    // Sort: exact name matches first, then starts-with, then rest.
    // This pushes tribute bands, collaborations, and fan accounts to the bottom.
    const q = name.trim().toLowerCase();
    mapped.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aExact = aName === q;
        const bExact = bName === q;
        if (aExact !== bExact) return aExact ? -1 : 1;
        const aStarts = aName.startsWith(q);
        const bStarts = bName.startsWith(q);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return 0;
    });

    return mapped.slice(0, 8);
}

// ─── Archive status check ─────────────────────────────────────────────────────

/**
 * Check whether a band is already in the archive or has a pending request.
 * Returns: 'archived' | 'pending' | 'none'
 */
export async function getArchiveStatus(artistName) {
    const nameLower = artistName.toLowerCase();

    // Check bands table
    const inArchive = (window._switcherBands || []).some(
        b => b.name.toLowerCase() === nameLower
    );
    if (inArchive) return 'archived';

    // Check band_requests for a pending request from this user
    const { data: session } = await supabase.auth.getSession();
    if (!session?.session?.user) return 'none';

    const { data } = await supabase
        .from('band_requests')
        .select('status')
        .eq('requested_by', session.session.user.id)
        .ilike('artist_name', artistName)
        .eq('status', 'pending')
        .maybeSingle();

    return data ? 'pending' : 'none';
}

// ─── Submit request ───────────────────────────────────────────────────────────

/**
 * Submit a band archive request for admin review.
 * Returns { ok: true } or { ok: false, error: string }
 */
export async function submitArchiveRequest(artistName, mbid) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return { ok: false, error: 'Not authenticated' };

    const { error } = await supabase.from('band_requests').insert({
        requested_by: session.user.id,
        artist_name:  artistName,
        mbid,
        status:       'pending',
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
}
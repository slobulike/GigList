/**
 * spotify.js — Playlist generation for GigList
 * ---------------------------------------------
 * Relive the Show: creates a Spotify playlist from a past gig's own setlist.
 * Get Gig Ready:   creates a Spotify playlist from an artist's most recent
 *                  setlist.fm setlist, for upcoming shows.
 */

import { supabase } from './supabase.js';
import {
    checkSpotifyConnection,
    isSpotifyConnected,
    renderConnectPrompt,
} from './spotify-auth.js';

const SPOTIFY_WORKER  = 'https://giglist-spotify.richard-lipscombe.workers.dev';
const SETLISTFM_PROXY = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';

// Session cache: keyed by journal entry id. Populated on first successful
// playlist creation or DB lookup so subsequent modal opens within the same
// page load restore button state synchronously, with no Supabase round-trip.
window._gigReadyPlaylists ??= {};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Escape a value for safe use inside an inline onclick attribute string.
const escAttr = s => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// setlist.fm/our own backfill jobs write these sentinel strings when a show
// genuinely has no known setlist — they're truthy strings, not empty, so a
// plain `if (!setlist)` check misses them and lets a doomed playlist request
// through to the worker (which then fails with a generic error).
const NO_SETLIST_SENTINELS = new Set(['NOT_FOUND', 'NO_SONGS_LISTED', 'NO_SETLIST_FOUND']);
const hasUsableSetlist = (setlist) => {
    const trimmed = (setlist || '').trim();
    return trimmed.length > 0 && !NO_SETLIST_SENTINELS.has(trimmed.toUpperCase());
};

// ─── ARTIST/PLAYLIST EMBED (on demand) ─────────────────────────────────────────
// Home and the gig modal both render a tap-to-load row rather than mounting
// an iframe immediately, so browsing several gigs in one session never
// loads more than one Spotify iframe at a time (see paintAudioSlot below,
// and window.loadSpotifyEmbed which mounts the real iframe on tap).

// Swaps a placeholder for the real iframe. embedPath is whatever comes after
// open.spotify.com/embed/ — e.g. 'artist/{id}' or 'playlist/{id}'. Kept as a
// separate on-demand step so opening a modal, or loading Home, never costs
// an iframe load until the person actually wants to listen.
window.loadSpotifyEmbed = (wrapId, embedPath) => {
    const el = document.getElementById(wrapId);
    if (!el) return;
    el.innerHTML = `
        <iframe src="https://open.spotify.com/embed/${embedPath}?utm_source=generator&theme=0"
                width="100%" height="152" frameborder="0"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                loading="lazy"
                class="rounded-xl"></iframe>`;
};

// ─── HOME AUDIO ACTION (On This Day / Next show cards) ─────────────────────
// Mirrors the gig modal's Relive/Get Gig Ready flow, but renders straight
// into a Home banner: an existing playlist becomes a tap-to-load embed, and
// a missing one becomes a generate CTA — both without leaving the app.
// Deliberately does NOT reuse the modal's relive-btn-{key}/gig-ready-btn-{key}
// element ids, since the same gig can be showing on Home and open in the
// gig modal at once; a shared id would mean two elements in the DOM racing
// for the same lookup. createRelivePlaylist/createGigReadyPlaylist are
// id-lookup-safe (every DOM update is behind an `if (el)` guard) and always
// write the resulting playlist to Supabase, so calling them with no matching
// element in the DOM still creates the playlist correctly — only the
// visual button-state update no-ops, which is fine since we re-render from
// Supabase ourselves once they resolve.

const playlistIdFromUrl = (url) => (url || '').match(/playlist\/([a-zA-Z0-9]+)/)?.[1] || null;

// Home's two slots and the gig modal's slot all sit on different
// backgrounds — amber-50 (OTD), indigo/slate (countdown card), and white
// (modal). Derived from slotId rather than threaded through every call site.
// Spotify's own green so these read as "the Spotify action" at a glance,
// regardless of which banner/modal background they're sitting on.
const MODAL_THEME   = { action: 'bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700', icon: 'text-emerald-600', loading: 'text-emerald-600' };
const OTD_THEME     = { action: 'bg-white hover:bg-emerald-50 border border-emerald-200 text-emerald-700', icon: 'text-emerald-600', loading: 'text-emerald-700' };
const TICKER_THEME  = { action: 'bg-white/10 hover:bg-white/15 text-white', icon: 'text-emerald-400', loading: 'text-emerald-300' };
const slotTheme = (slotId) => {
    if (slotId === 'otd-spotify-slot') return OTD_THEME;
    if (slotId === 'countdown-spotify-slot') return TICKER_THEME;
    return MODAL_THEME;
};

// Figures out what a gig has to offer, without touching the DOM: an
// existing playlist to embed, a CTA to generate one, a generic artist embed
// (modal only — see allowGenericFallback), or nothing. Kept separate from
// painting so syncHomeAudioSlots can check OTD's content before committing
// to it, and fall back to the ticker gig if OTD comes up empty.
//
// allowGenericFallback exists only for the gig modal: a past show with no
// setlist can never generate a Relive playlist, but the modal still wants
// to offer *something* to listen to (the artist's generic Spotify page)
// rather than an empty slot. Home deliberately does NOT set this — an OTD
// banner with nothing to offer should hand the slot to the ticker's gig
// instead of settling for a generic artist embed (see syncHomeAudioSlots).
const resolveAudioContent = async (entry, gigIsPast, { allowGenericFallback = false } = {}) => {
    if (!entry?.id || !window.currentUser?.isAuthUser) return null;

    const sourceType = gigIsPast ? 'own_setlist' : 'recent_artist_setlist';
    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', sourceType)
        .maybeSingle();

    const playlistId = playlistIdFromUrl(existing?.playlist_url);
    if (playlistId) return { kind: 'embed', playlistId, entry, gigIsPast, allowGenericFallback };

    // A past show with no usable setlist can never generate a Relive
    // playlist (Get Gig Ready doesn't need one — it pulls a live setlist.fm
    // lookup instead), so don't invite a tap that's guaranteed to fail.
    if (gigIsPast) {
        const performance = (window.performanceData || []).find(p =>
            p['Journal Key'] === entry['Journal Key'] &&
            (p.Artist || '').toLowerCase() === (entry.Band || '').toLowerCase()
        );
        if (!hasUsableSetlist(performance?.Setlist)) {
            if (allowGenericFallback && entry.SpotifyArtistId) {
                return { kind: 'generic', entry, gigIsPast, allowGenericFallback };
            }
            return null;
        }
    }

    return { kind: 'cta', entry, gigIsPast, allowGenericFallback };
};

const paintAudioSlot = (slotId, content) => {
    const slot = document.getElementById(slotId);
    if (!slot) return;
    if (!content) { slot.innerHTML = ''; return; }

    const theme = slotTheme(slotId);
    const { kind, entry, gigIsPast, allowGenericFallback } = content;

    if (kind === 'embed') {
        const wrapId = `${slotId}-embed`;
        slot.innerHTML = `
            <div id="${wrapId}" class="mt-3">
                <button onclick="window.loadSpotifyEmbed('${wrapId}', 'playlist/${content.playlistId}')"
                        class="w-full flex items-center gap-2.5 ${theme.action} rounded-xl px-3 py-2.5 transition-colors text-left">
                    <i data-lucide="play-circle" class="w-4 h-4 ${theme.icon} flex-shrink-0" aria-hidden="true"></i>
                    <span class="text-[10px] font-black uppercase tracking-widest">Play ${gigIsPast ? 'relive the show' : 'get gig ready'} playlist</span>
                </button>
            </div>`;
    } else if (kind === 'generic') {
        const wrapId = `${slotId}-embed`;
        slot.innerHTML = `
            <div id="${wrapId}" class="mt-3">
                <button onclick="window.loadSpotifyEmbed('${wrapId}', 'artist/${entry.SpotifyArtistId}')"
                        class="w-full flex items-center gap-2.5 ${theme.action} rounded-xl px-3 py-2.5 transition-colors text-left">
                    <span class="w-8 h-8 rounded-md bg-emerald-100 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                        <i data-lucide="play-circle" class="w-4 h-4 ${theme.icon}"></i>
                    </span>
                    <span class="flex-1 min-w-0">
                        <span class="block text-[11px] font-bold truncate">${(entry.Band || 'Listen on Spotify').replace(/</g, '&lt;')}</span>
                        <span class="block text-[9px] uppercase tracking-widest opacity-70">No setlist yet &middot; tap to play artist</span>
                    </span>
                </button>
            </div>`;
    } else {
        slot.innerHTML = `
            <button onclick="window.generateSlotPlaylist('${slotId}', '${escAttr(entry['Journal Key'])}', '${escAttr(entry.Band)}', '${escAttr(entry.Date)}', '${escAttr(entry.OfficialVenue)}', ${gigIsPast}, ${!!allowGenericFallback})"
                    class="mt-3 w-full flex items-center justify-center gap-1.5 ${theme.action} text-[10px] font-black uppercase tracking-widest rounded-xl px-3 py-2.5 transition-colors">
                <i data-lucide="${gigIsPast ? 'list-music' : 'zap'}" class="w-3.5 h-3.5 ${theme.icon}" aria-hidden="true"></i>
                ${gigIsPast ? 'Generate relive playlist' : 'Get gig ready'}
            </button>`;
    }
    if (window.lucide) lucide.createIcons();
};

// Coordinates the single shared Home audio slot. otdCandidate/tickerCandidate
// are `{ entry, gigIsPast } | null`. OTD gets first refusal on the slot, but
// only if it actually has something to show — if its gig has no playlist
// and no usable setlist, we fall through to the ticker's gig instead, so
// there's always a playlist/CTA presented somewhere rather than a dead OTD
// banner with nothing underneath it.
export const syncHomeAudioSlots = async (otdCandidate, tickerCandidate) => {
    const otdContent = otdCandidate ? await resolveAudioContent(otdCandidate.entry, otdCandidate.gigIsPast) : null;

    let winner = otdContent ? 'otd' : null;
    let tickerContent = null;
    if (!winner && tickerCandidate) {
        tickerContent = await resolveAudioContent(tickerCandidate.entry, tickerCandidate.gigIsPast);
        if (tickerContent) winner = 'ticker';
    }

    paintAudioSlot('otd-spotify-slot', winner === 'otd' ? otdContent : null);
    paintAudioSlot('countdown-spotify-slot', winner === 'ticker' ? tickerContent : null);
};

// Gig modal's single audio slot — same resolve/paint pipeline as Home, but
// with the generic-artist fallback enabled (see resolveAudioContent) since
// there's no second banner to hand off to when a past show has no setlist.
export const initModalAudioAction = async (journalKey, gigIsPast) => {
    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;
    const slotId = `modal-spotify-slot-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
    paintAudioSlot(slotId, await resolveAudioContent(entry, gigIsPast, { allowGenericFallback: true }));
};

window.generateSlotPlaylist = async (slotId, journalKey, artistName, gigDate, venueName, gigIsPast, allowGenericFallback = false) => {
    const slot = document.getElementById(slotId);
    if (slot) {
        const theme = slotTheme(slotId);
        slot.innerHTML = `
            <div class="mt-3 flex items-center justify-center gap-1.5 ${theme.loading} text-[10px] font-black uppercase tracking-widest py-2.5">
                <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin" aria-hidden="true"></i> Generating…
            </div>`;
        if (window.lucide) lucide.createIcons();
    }

    if (gigIsPast) {
        await window.createRelivePlaylist(journalKey, artistName, gigDate, venueName, slotId);
    } else {
        await window.createGigReadyPlaylist(journalKey, artistName, gigDate, venueName, slotId);
    }

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (entry) paintAudioSlot(slotId, await resolveAudioContent(entry, gigIsPast, { allowGenericFallback }));
};

// ─── RELIVE THE SHOW ──────────────────────────────────────────────────────────

window.createRelivePlaylist = async (journalKey, artistName, gigDate, venueName, targetId) => {
    // targetId lets callers point this at whatever element actually exists in
    // the DOM for their context (e.g. the slot-based CTA passes its slotId,
    // since it never renders a relive-btn-{key} element). Falls back to the
    // legacy id for callers that do render one (e.g. refreshGigReadyPlaylist's
    // idle button, initReliveButton's admin-only OPEN PLAYLIST swap).
    const btnId = targetId || `relive-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
    const btn = document.getElementById(btnId);

    const toReadyState = (url) => {
        const el = document.getElementById(btnId);
        if (el) {
            el.outerHTML = `
                <a id="${btnId}" href="${url}" target="_blank" rel="noopener"
                   class="bg-indigo-500 hover:bg-indigo-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                    <i data-lucide="check-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> OPEN PLAYLIST
                </a>`;
            if (window.lucide) lucide.createIcons();
        }
    };

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;

    // Check Spotify connection before doing anything else
    const connected = await checkSpotifyConnection(window.currentUser.id);
    if (!connected) {
        renderConnectPrompt(btnId, window.currentUser.id, () =>
            window.createRelivePlaylist(journalKey, artistName, gigDate, venueName, targetId)
        );
        return;
    }

    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', 'own_setlist')
        .maybeSingle();

    if (existing?.playlist_url) {
        toReadyState(existing.playlist_url);
        window.open(existing.playlist_url, '_blank');
        return;
    }

    if (btn) {
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin" aria-hidden="true"></i> CREATING…';
        btn.disabled = true;
        if (window.lucide) lucide.createIcons();
    }

    const performance = (window.performanceData || []).find(p =>
        p['Journal Key'] === journalKey &&
        (p.Artist || '').toLowerCase() === artistName.toLowerCase()
    );

    if (!hasUsableSetlist(performance?.Setlist)) {
        window.showToast('No setlist data found for this show.', 'error');
        if (btn) {
            btn.innerHTML = '<i data-lucide="list-music" class="w-3.5 h-3.5" aria-hidden="true"></i> RELIVE';
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
        return;
    }

    const { data: artistRow } = await supabase
        .from('artists')
        .select('spotify_artist_id')
        .ilike('name', artistName)
        .maybeSingle();

    try {
        const response = await fetch(SPOTIFY_WORKER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                setlist:          performance.Setlist,
                artistName,
                artistSpotifyId:  artistRow?.spotify_artist_id || null,
                gigDate,
                venueName,
                mode:             'relive',
                userId:           window.currentUser.id,
            }),
        });

        const result = await response.json();
        if (!result.playlistUrl) throw new Error(result.error || 'No playlist URL returned');

        const { error } = await supabase.from('spotify_playlists').insert({
            journal_id:     entry.id,
            performance_id: performance.id,
            user_id:        window.currentUser.id,
            playlist_url:   result.playlistUrl,
            playlist_id:    result.playlistId,
            setlist_source: 'own_setlist',
        });
        if (error) console.warn('[GigList] Failed to persist relive playlist:', error);

        toReadyState(result.playlistUrl);
        window.showToast('Playlist created — relive the show! 🎶', 'success');

        if (result.notFound?.length) {
            console.info(`[GigList] ${result.notFound.length} tracks not found on Spotify:`, result.notFound);
        }

    } catch (err) {
        console.error('[GigList] createRelivePlaylist failed:', err);
        if (btn) {
            btn.innerHTML = '<i data-lucide="list-music" class="w-3.5 h-3.5" aria-hidden="true"></i> RELIVE';
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
        window.showToast('Could not create playlist. Please try again.', 'error');
    }
};

window.initReliveButton = async (journalKey) => {
    if (!window.currentUser?.is_admin) return;

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;

    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', 'own_setlist')
        .maybeSingle();

    if (!existing?.playlist_url) return;

    const btnId = `relive-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.outerHTML = `
        <a id="${btnId}" href="${existing.playlist_url}" target="_blank" rel="noopener"
           class="bg-indigo-500 hover:bg-indigo-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
            <i data-lucide="check-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> OPEN PLAYLIST
        </a>`;
    if (window.lucide) lucide.createIcons();
};

// ─── GET GIG READY ────────────────────────────────────────────────────────────

// Renders the OPEN PLAYLIST + refresh button pair for a given URL.
const renderGigReadyReadyState = (btnId, url, journalKey, artistName, gigDate, venueName) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    el.outerHTML = `
        <div id="${btnId}" class="flex items-center gap-1">
            <a href="${url}" target="_blank" rel="noopener"
               class="bg-green-500 hover:bg-green-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                <i data-lucide="check-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> OPEN PLAYLIST
            </a>
            <button onclick="window.refreshGigReadyPlaylist('${escAttr(journalKey)}','${escAttr(artistName)}','${escAttr(gigDate)}','${escAttr(venueName)}')"
                    title="Refresh with latest setlist"
                    class="text-green-400 hover:text-white transition-colors p-1 rounded-full active:scale-95">
                <i data-lucide="refresh-cw" class="w-3 h-3" aria-hidden="true"></i>
            </button>
        </div>`;
    if (window.lucide) lucide.createIcons();
};

window.createGigReadyPlaylist = async (journalKey, artistName, gigDate, venueName, targetId) => {
    // See createRelivePlaylist's targetId comment — same reasoning applies here.
    const btnId = targetId || `gig-ready-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;

    const toIdleState = () => {
        const el = document.getElementById(btnId);
        if (el) {
            el.innerHTML = '<i data-lucide="zap" class="w-3.5 h-3.5" aria-hidden="true"></i> GET READY';
            el.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    };

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;

    // ── Cache check: synchronous, no await. Restores button state immediately.
    const cached = window._gigReadyPlaylists[entry.id];
    if (cached) {
        renderGigReadyReadyState(btnId, cached, journalKey, artistName, gigDate, venueName);
        return;
    }

    // ── Spotify connection check
    const connected = await checkSpotifyConnection(window.currentUser.id);
    if (!connected) {
        renderConnectPrompt(btnId, window.currentUser.id, () =>
            window.createGigReadyPlaylist(journalKey, artistName, gigDate, venueName, targetId)
        );
        return;
    }

    // ── DB check: first open after a page refresh
    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', 'recent_artist_setlist')
        .maybeSingle();

    if (existing?.playlist_url) {
        window._gigReadyPlaylists[entry.id] = existing.playlist_url;
        renderGigReadyReadyState(btnId, existing.playlist_url, journalKey, artistName, gigDate, venueName);
        return;
    }

    // ── No existing playlist — create one
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin" aria-hidden="true"></i> PREPARING…';
        btn.disabled = true;
        if (window.lucide) lucide.createIcons();
    }

    const { data: artistRow } = await supabase
        .from('artists')
        .select('mbid, spotify_artist_id')
        .ilike('name', artistName)
        .maybeSingle();

    const mbid = artistRow?.mbid;
    if (!mbid) {
        window.showToast('No MusicBrainz ID found for this artist.', 'error');
        toIdleState();
        return;
    }

    try {
        const slRes = await fetch(
            `${SETLISTFM_PROXY}/?endpoint=artist-setlists&mbid=${encodeURIComponent(mbid)}&page=1`
        );
        if (!slRes.ok) throw new Error(`setlist.fm proxy returned ${slRes.status}`);

        const slData = await slRes.json();
        const setlists = slData.setlist || [];

        // Require at least 3 playable tracks to skip TV/promo appearances
        const MIN_SONGS = 3;
        const recentSetlist = setlists.find(sl => {
            const count = (sl.sets?.set || [])
                .flatMap(s => s.song || [])
                .filter(s => s.name && !s.tape)
                .length;
            return count >= MIN_SONGS;
        });

        if (!recentSetlist) {
            window.showToast('No recent full setlist found for this artist.', 'error');
            toIdleState();
            return;
        }

        const songs = recentSetlist.sets.set
            .flatMap(s => s.song || [])
            .filter(s => s.name && !s.tape)
            .map(s => s.name);

        const response = await fetch(SPOTIFY_WORKER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                setlist:         songs.join(' | '),
                artistName,
                artistSpotifyId: artistRow?.spotify_artist_id || null,
                gigDate,
                venueName,
                mode:            'gig_ready',
                userId:          window.currentUser.id,
            }),
        });

        const result = await response.json();
        if (!result.playlistUrl) throw new Error(result.error || 'No playlist URL returned');

        const performance = (window.performanceData || []).find(p =>
            p['Journal Key'] === journalKey &&
            (p.Artist || '').toLowerCase() === artistName.toLowerCase()
        );

        const { error: dbError } = await supabase.from('spotify_playlists').insert({
            journal_id:     entry.id,
            performance_id: performance?.id || null,
            user_id:        window.currentUser.id,
            playlist_url:   result.playlistUrl,
            playlist_id:    result.playlistId,
            setlist_source: 'recent_artist_setlist',
        });
        if (dbError) {
            console.warn('[GigList] Failed to persist gig-ready playlist:', dbError);
            window.showToast('Playlist created but could not be saved. Try refreshing.', 'warning');
        }

        // Populate cache so future modal opens are instant
        window._gigReadyPlaylists[entry.id] = result.playlistUrl;

        renderGigReadyReadyState(btnId, result.playlistUrl, journalKey, artistName, gigDate, venueName);
        window.showToast('Playlist ready — time to get gig ready! 🎸', 'success');

        if (result.notFound?.length) {
            console.info(`[GigList] ${result.notFound.length} tracks not found on Spotify:`, result.notFound);
        }

    } catch (err) {
        console.error('[GigList] createGigReadyPlaylist failed:', err);
        toIdleState();
        window.showToast('Could not create playlist. Please try again.', 'error');
    }
};

window.initGigReadyButton = async (journalKey) => {
    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;

    const btnId      = `gig-ready-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
    const artistName = entry.Band;
    const gigDate    = entry.Date;
    const venueName  = entry.OfficialVenue;

    // ── Cache hit: synchronous render, nothing can interleave
    const cached = window._gigReadyPlaylists[entry.id];
    if (cached) {
        renderGigReadyReadyState(btnId, cached, journalKey, artistName, gigDate, venueName);
        return;
    }

    // ── Check Spotify connection first
    const connected = await checkSpotifyConnection(window.currentUser.id);
    if (!connected) {
        renderConnectPrompt(btnId, window.currentUser.id, () =>
            window.createGigReadyPlaylist(journalKey, artistName, gigDate, venueName)
        );
        return;
    }

    // ── Cache miss: query Supabase (first open after page refresh)
    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', 'recent_artist_setlist')
        .maybeSingle();

    if (!existing?.playlist_url) return;

    // Populate cache for the remainder of this session
    window._gigReadyPlaylists[entry.id] = existing.playlist_url;
    renderGigReadyReadyState(btnId, existing.playlist_url, journalKey, artistName, gigDate, venueName);
};

// ─── REFRESH GIG READY ────────────────────────────────────────────────────────

window.refreshGigReadyPlaylist = async (journalKey, artistName, gigDate, venueName) => {
    const btnId = `gig-ready-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (!entry) return;

    const { error } = await supabase
        .from('spotify_playlists')
        .delete()
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', 'recent_artist_setlist');

    if (error) {
        console.warn('[GigList] Failed to delete existing gig-ready playlist:', error);
        window.showToast('Could not refresh playlist. Please try again.', 'error');
        return;
    }

    // Clear session cache so the next call hits the network for a fresh setlist
    delete window._gigReadyPlaylists[entry.id];

    const el = document.getElementById(btnId);
    if (el) {
        el.outerHTML = `
            <button id="${btnId}"
                    onclick="window.createGigReadyPlaylist('${escAttr(journalKey)}','${escAttr(artistName)}','${escAttr(gigDate)}','${escAttr(venueName)}')"
                    class="bg-green-500 hover:bg-green-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                <i data-lucide="zap" class="w-3.5 h-3.5" aria-hidden="true"></i> GET READY
            </button>`;
        if (window.lucide) lucide.createIcons();
    }
};

// ─── DISPATCHER ───────────────────────────────────────────────────────────────

export const initPlaylistButton = async (journalKey, gigIsPast) => {
    if (gigIsPast) {
        await window.initReliveButton(journalKey);
    } else {
        await window.initGigReadyButton(journalKey);
    }
};
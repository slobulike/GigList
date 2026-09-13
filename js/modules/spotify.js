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

// ─── ARTIST EMBED (gig modal, on demand) ───────────────────────────────────────
// Renders a compact tap-to-load row rather than mounting an iframe immediately.
// Browsing several gigs in one session should never load more than one
// Spotify iframe at a time.

export const renderSpotifyEmbedPlaceholder = (journalKey, spotifyArtistId, artistName) => {
    if (!spotifyArtistId) return '';
    const wrapId = `spotify-embed-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
    return `
        <div id="${wrapId}" class="mt-3">
            <button onclick="window.loadSpotifyEmbed('${wrapId}', 'artist/${escAttr(spotifyArtistId)}')"
                    class="w-full flex items-center gap-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl px-3 py-2.5 transition-colors text-left">
                <span class="w-8 h-8 rounded-md bg-slate-200 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                    <i data-lucide="play-circle" class="w-4 h-4 text-slate-500"></i>
                </span>
                <span class="flex-1 min-w-0">
                    <span class="block text-[11px] font-bold text-slate-700 truncate">${(artistName || 'Listen on Spotify').replace(/</g, '&lt;')}</span>
                    <span class="block text-[9px] text-slate-400 uppercase tracking-widest">Tap to load player</span>
                </span>
            </button>
        </div>`;
};

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

// The two Home slots sit on very different backgrounds — the amber-50 OTD
// banner needs dark-on-light styling, the indigo/slate countdown card needs
// the white-on-dark styling. Derived from slotId rather than threaded through
// every call site since there are only ever these two slots.
const homeSlotTheme = (slotId) => slotId === 'otd-spotify-slot'
    ? { action: 'bg-white hover:bg-amber-50 border border-amber-200 text-amber-800', icon: 'text-amber-600', loading: 'text-amber-700' }
    : { action: 'bg-white/10 hover:bg-white/15 text-white', icon: 'text-white', loading: 'text-white/70' };

export const renderHomeAudioAction = async (slotId, entry, gigIsPast) => {
    const slot = document.getElementById(slotId);
    if (!slot || !entry?.id || !window.currentUser?.isAuthUser) return;
    const theme = homeSlotTheme(slotId);

    const sourceType = gigIsPast ? 'own_setlist' : 'recent_artist_setlist';
    const { data: existing } = await supabase
        .from('spotify_playlists')
        .select('playlist_url')
        .eq('journal_id', entry.id)
        .eq('user_id', window.currentUser.id)
        .eq('setlist_source', sourceType)
        .maybeSingle();

    const playlistId = playlistIdFromUrl(existing?.playlist_url);

    if (playlistId) {
        const wrapId = `${slotId}-embed`;
        slot.innerHTML = `
            <div id="${wrapId}" class="mt-3">
                <button onclick="window.loadSpotifyEmbed('${wrapId}', 'playlist/${playlistId}')"
                        class="w-full flex items-center gap-2.5 ${theme.action} rounded-xl px-3 py-2.5 transition-colors text-left">
                    <i data-lucide="play-circle" class="w-4 h-4 ${theme.icon} flex-shrink-0" aria-hidden="true"></i>
                    <span class="text-[10px] font-black uppercase tracking-widest">Play ${gigIsPast ? 'relive the show' : 'get gig ready'} playlist</span>
                </button>
            </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    // A past show with no usable setlist can never generate a Relive
    // playlist (Get Gig Ready doesn't need one — it pulls a live setlist.fm
    // lookup instead), so don't invite a tap that's guaranteed to fail.
    if (gigIsPast) {
        const performance = (window.performanceData || []).find(p =>
            p['Journal Key'] === entry['Journal Key'] &&
            (p.Artist || '').toLowerCase() === (entry.Band || '').toLowerCase()
        );
        if (!hasUsableSetlist(performance?.Setlist)) {
            slot.innerHTML = '';
            return;
        }
    }

    slot.innerHTML = `
        <button onclick="window.generateHomePlaylist('${slotId}', '${escAttr(entry['Journal Key'])}', '${escAttr(entry.Band)}', '${escAttr(entry.Date)}', '${escAttr(entry.OfficialVenue)}', ${gigIsPast})"
                class="mt-3 w-full flex items-center justify-center gap-1.5 ${theme.action} text-[10px] font-black uppercase tracking-widest rounded-xl px-3 py-2.5 transition-colors">
            <i data-lucide="${gigIsPast ? 'list-music' : 'zap'}" class="w-3.5 h-3.5 ${theme.icon}" aria-hidden="true"></i>
            ${gigIsPast ? 'Generate relive playlist' : 'Get gig ready'}
        </button>`;
    if (window.lucide) lucide.createIcons();
};

window.generateHomePlaylist = async (slotId, journalKey, artistName, gigDate, venueName, gigIsPast) => {
    const slot = document.getElementById(slotId);
    if (slot) {
        const theme = homeSlotTheme(slotId);
        slot.innerHTML = `
            <div class="mt-3 flex items-center justify-center gap-1.5 ${theme.loading} text-[10px] font-black uppercase tracking-widest py-2.5">
                <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin" aria-hidden="true"></i> Generating…
            </div>`;
        if (window.lucide) lucide.createIcons();
    }

    if (gigIsPast) {
        await window.createRelivePlaylist(journalKey, artistName, gigDate, venueName);
    } else {
        await window.createGigReadyPlaylist(journalKey, artistName, gigDate, venueName);
    }

    const entry = (window.journalData || []).find(g => g['Journal Key'] === journalKey);
    if (entry) await renderHomeAudioAction(slotId, entry, gigIsPast);
};

// ─── RELIVE THE SHOW ──────────────────────────────────────────────────────────

window.createRelivePlaylist = async (journalKey, artistName, gigDate, venueName) => {
    const btnId = `relive-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;
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
            window.createRelivePlaylist(journalKey, artistName, gigDate, venueName)
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

window.createGigReadyPlaylist = async (journalKey, artistName, gigDate, venueName) => {
    const btnId = `gig-ready-btn-${journalKey.replace(/[^a-z0-9]/gi, '_')}`;

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
            window.createGigReadyPlaylist(journalKey, artistName, gigDate, venueName)
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
/**
 * mix-playlist.js — "Your GigList playlist" (Home card)
 * -----------------------------------------------------
 * One rolling Spotify playlist per user: 25 songs from random artists they've
 * seen live. The Worker (POST /mix) does the picking and the Spotify calls;
 * this module is only the card.
 *
 * Design in one breath: a slim "mini player" row (artists, title, Play, Remix)
 * that expands for the details: who's in the mix, the embed, and the opt-in
 * to refresh automatically. Before the first mix it's a single-line invitation.
 *
 * Usage (from Home init, once the journal data has loaded):
 *   import { initMixPlaylistCard } from './mix-playlist.js';
 *   initMixPlaylistCard('home-mix-slot');
 * Call it again to reset the card, e.g. after switching mode. It clears
 * itself for anyone who shouldn't see it.
 *
 * Relies on window.loadSpotifyEmbed (spotify.js), window.showToast and
 * window.lucide, like the rest of the app.
 */

import { supabase, authedFetch } from './supabase.js';
import { checkSpotifyConnection, renderConnectPrompt } from './spotify-auth.js';
import { escapeHtml, safeUrl } from './utils.js';

const SPOTIFY_WORKER = 'https://giglist-spotify.richard-lipscombe.workers.dev';
const REFRESH_DAYS   = 3;
const MIN_ARTISTS    = 5;   // don't offer the feature until there's something to mix
const DISMISS_KEY    = 'giglist_mix_autoprompt_dismissed';
const EMBED_ID       = 'mix-embed';
const STAGES = [
    'Picking artists from your gigs…',
    'Finding the songs they played…',
    'Building your playlist…',
];

// emerald-700 on white is 5.5:1; emerald-600 would fail AA for small text.
const SOLID = 'bg-emerald-700 hover:bg-emerald-800 text-white';
const SOFT  = 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200';
const ROUND = 'w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-60';

let expanded    = false;
let artistCache = { key: '', list: [] };
let stageTimer  = null;

// ─── small helpers ────────────────────────────────────────────────────────────

const icons = () => { if (window.lucide) window.lucide.createIcons(); };
const toast = (message, type) => window.showToast?.(message, type);

const playlistIdFromUrl = (url) => (url || '').match(/playlist\/([a-zA-Z0-9]+)/)?.[1] || null;

const shortDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

const promptDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };
const dismissPrompt   = () => { try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage blocked: fine */ } };

const distinctArtists = () =>
    new Set((window.journalData || []).map(g => (g.Band || '').trim().toLowerCase()).filter(Boolean)).size;

const injectStyles = () => {
    if (document.getElementById('mix-playlist-styles')) return;
    const style = document.createElement('style');
    style.id = 'mix-playlist-styles';
    style.textContent = `
        @keyframes mixIn { from { opacity: 0; transform: translateY(6px) scale(.85); } to { opacity: 1; transform: none; } }
        .mix-animate .mix-avatar { animation: mixIn .45s cubic-bezier(.2,.8,.2,1) both; }
        .mix-animate .mix-avatar:nth-child(2) { animation-delay: .08s; }
        .mix-animate .mix-avatar:nth-child(3) { animation-delay: .16s; }
        @media (prefers-reduced-motion: reduce) {
            .mix-animate .mix-avatar { animation: none; }
            #mix-card .animate-spin { animation-duration: 2.4s; }
        }`;
    document.head.appendChild(style);
};

// ─── data ─────────────────────────────────────────────────────────────────────

const fetchMix = async () => {
    const { data } = await supabase
        .from('user_mix_playlists')
        .select('*')
        .eq('user_id', window.currentUser.id)
        .maybeSingle();
    return data;
};

// Who's in the current mix, in the order the Worker used them. The card still
// works without this (it only adds the faces and names), so any failure
// quietly returns an empty list.
const fetchArtists = async (ids) => {
    const list = (ids || []).slice(0, 12);
    if (!list.length) return [];
    const key = list.join(',');
    if (artistCache.key === key) return artistCache.list;

    const { data, error } = await supabase
        .from('artists')
        .select('id, name, spotify_image_url')
        .in('id', list);
    if (error || !data) return [];

    const byId = new Map(data.map(a => [a.id, a]));
    const ordered = list.map(id => byId.get(id)).filter(Boolean);
    artistCache = { key, list: ordered };
    return ordered;
};

// ─── markup ───────────────────────────────────────────────────────────────────

const avatar = (artist) => {
    const url = artist.spotify_image_url ? safeUrl(artist.spotify_image_url) : '';
    const inner = url
        ? `<img src="${escapeHtml(url)}" alt="" class="w-full h-full object-cover">`
        : escapeHtml((artist.name || '?').trim().charAt(0).toUpperCase());
    return `<span class="mix-avatar flex-shrink-0 w-9 h-9 -ml-3 first:ml-0 rounded-full ring-2 ring-white bg-slate-200 overflow-hidden flex items-center justify-center text-xs font-black text-slate-600">${inner}</span>`;
};

const fallbackAvatar = `<span class="flex-shrink-0 w-9 h-9 rounded-full bg-emerald-50 flex items-center justify-center" aria-hidden="true"><i data-lucide="music" class="w-4 h-4 text-emerald-700"></i></span>`;

const autoHtml = (mix) => {
    if (mix.status === 'needs_reconnect') {
        return `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">Spotify needs reconnecting before this can refresh. Tap Remix to reconnect.</p>`;
    }
    if (mix.refresh_every_days) {
        const next = mix.next_refresh_at ? new Date(mix.next_refresh_at) : null;
        const when = next && next > new Date() ? `next mix around ${shortDate(mix.next_refresh_at)}` : 'next mix due soon';
        return `
            <div class="flex items-center justify-between gap-3 text-xs text-slate-600">
                <span>Refreshes every ${Number(mix.refresh_every_days)} days · ${escapeHtml(when)}</span>
                <button id="mix-auto-off" class="font-bold text-slate-700 underline underline-offset-2 min-h-[44px] px-1">Turn off</button>
            </div>`;
    }
    if (!promptDismissed()) {
        return `
            <div class="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                <p class="text-xs font-bold text-slate-800">Want a fresh mix every ${REFRESH_DAYS} days?</p>
                <p class="text-xs text-slate-600 mt-0.5">We'll swap in different artists from your gigs. No need to open the app.</p>
                <div class="flex items-center gap-2 mt-2">
                    <button id="mix-auto-on" class="${SOLID} min-h-[44px] px-4 rounded-full text-[11px] font-black uppercase tracking-wide transition-colors">Yes please</button>
                    <button id="mix-auto-skip" class="min-h-[44px] px-3 text-xs font-bold text-slate-600">Not now</button>
                </div>
            </div>`;
    }
    return `<button id="mix-auto-on" class="text-xs font-bold text-emerald-700 underline underline-offset-2 min-h-[44px]">Refresh automatically every ${REFRESH_DAYS} days</button>`;
};

const emptyHtml = () => `
    <div id="mix-card" role="region" aria-label="Your GigList playlist" class="bg-white border border-emerald-100 rounded-[1.5rem] shadow-sm p-4">
        <div class="flex items-center gap-3">
            <span class="w-11 h-11 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0" aria-hidden="true">
                <i data-lucide="shuffle" class="w-5 h-5 text-emerald-700"></i>
            </span>
            <div class="min-w-0 flex-1">
                <p class="text-[10px] font-black uppercase tracking-widest text-emerald-700">Your GigList playlist</p>
                <p id="mix-sub" class="text-xs text-slate-600 leading-snug mt-0.5">25 songs from artists you've seen live</p>
            </div>
            <button id="mix-make" class="${SOLID} min-h-[44px] px-4 rounded-full text-[11px] font-black uppercase tracking-widest flex items-center gap-1.5 flex-shrink-0 transition-colors disabled:opacity-60">Make it</button>
        </div>
        <div id="mix-connect-area"></div>
        <span id="mix-sr" class="sr-only" role="status"></span>
    </div>`;

const readyHtml = (mix, artists, animate) => {
    const total    = (mix.last_artist_ids || []).length || artists.length;
    const featured = artists.slice(0, 3).map(a => `<span class="font-bold text-slate-800">${escapeHtml(a.name)}</span>`);
    const more     = Math.max(0, total - featured.length);
    const featuring = featured.length
        ? `Featuring ${featured.join(', ')}${more ? ` and ${more} more` : ''}`
        : '';
    const faces = artists.slice(0, 3).map(avatar).join('') || fallbackAvatar;
    const sub   = `${Number(mix.track_count)} songs · mixed ${shortDate(mix.last_refreshed_at)}`;

    return `
    <div id="mix-card" role="region" aria-label="Your GigList playlist" class="bg-white border border-emerald-100 rounded-[1.5rem] shadow-sm">
        <div class="flex items-center gap-2 p-3">
            <button id="mix-toggle" aria-expanded="${expanded}" aria-controls="mix-panel"
                    class="flex items-center gap-3 flex-1 min-w-0 text-left rounded-xl">
                <span class="flex flex-shrink-0 pl-1 ${animate ? 'mix-animate' : ''}" aria-hidden="true">${faces}</span>
                <span class="min-w-0 flex-1">
                    <span class="block text-[10px] font-black uppercase tracking-widest text-emerald-700">Your GigList playlist</span>
                    <span id="mix-sub" class="block text-sm font-bold text-slate-800 truncate">${escapeHtml(sub)}</span>
                </span>
                <i data-lucide="chevron-down" class="w-4 h-4 text-slate-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}" id="mix-chevron" aria-hidden="true"></i>
            </button>
            <button id="mix-play" aria-label="Play your GigList playlist" class="${ROUND} ${SOLID}">
                <i data-lucide="play" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button id="mix-remix" aria-label="Remix: make a new mix" class="${ROUND} ${SOFT}">
                <i data-lucide="shuffle" class="w-4 h-4" aria-hidden="true"></i>
            </button>
        </div>
        <div id="mix-panel" class="${expanded ? '' : 'hidden'} px-4 pb-4 pt-3 border-t border-slate-100 space-y-3">
            ${featuring ? `<p class="text-xs text-slate-600 leading-relaxed">${featuring}</p>` : ''}
            <div id="${EMBED_ID}"></div>
            ${autoHtml(mix)}
            <a href="${escapeHtml(safeUrl(mix.playlist_url))}" target="_blank" rel="noopener"
               class="inline-flex items-center gap-1.5 min-h-[44px] text-xs font-bold text-emerald-700 underline underline-offset-2">
                Open in Spotify <i data-lucide="external-link" class="w-3.5 h-3.5" aria-hidden="true"></i>
            </a>
            <div id="mix-connect-area"></div>
        </div>
        <span id="mix-sr" class="sr-only" role="status"></span>
    </div>`;
};

// ─── behaviour ────────────────────────────────────────────────────────────────

const setExpanded = (root, on) => {
    const panel = root.querySelector('#mix-panel');
    if (!panel) return;            // empty state has no panel
    expanded = on;
    panel.classList.toggle('hidden', !on);
    root.querySelector('#mix-toggle')?.setAttribute('aria-expanded', String(on));
    root.querySelector('#mix-chevron')?.classList.toggle('rotate-180', on);
};

// While the Worker builds the mix (a few seconds), show it working: spinner
// on the buttons and a cycling status line. The cycling text is not announced
// to screen readers (it would chatter); one polite message covers it instead.
const setBusy = (root, on) => {
    clearInterval(stageTimer);
    root.querySelector('#mix-card')?.setAttribute('aria-busy', String(on));
    const sr = root.querySelector('#mix-sr');
    if (sr) sr.textContent = on ? 'Mixing your playlist' : '';

    const make  = root.querySelector('#mix-make');
    const remix = root.querySelector('#mix-remix');
    const play  = root.querySelector('#mix-play');
    [make, remix, play].forEach(b => { if (b) b.disabled = on; });

    if (make) {
        make.innerHTML = on
            ? '<i data-lucide="loader-2" class="w-4 h-4 animate-spin" aria-hidden="true"></i> Mixing'
            : 'Make it';
    }
    if (remix) {
        remix.innerHTML = `<i data-lucide="${on ? 'loader-2' : 'shuffle'}" class="w-4 h-4 ${on ? 'animate-spin' : ''}" aria-hidden="true"></i>`;
    }

    const sub = root.querySelector('#mix-sub');
    if (on && sub) {
        let i = 0;
        sub.textContent = STAGES[0];
        stageTimer = setInterval(() => { i = (i + 1) % STAGES.length; sub.textContent = STAGES[i]; }, 2500);
    }
    icons();
};

const showConnect = (root) => {
    setExpanded(root, true);
    const area = root.querySelector('#mix-connect-area');
    if (!area) return;
    area.innerHTML = `
        <button id="mix-connect-btn" class="mt-3 w-full flex items-center justify-center gap-1.5 ${SOFT} text-[11px] font-black uppercase tracking-widest rounded-xl px-3 min-h-[44px]">
            Connect Spotify
        </button>`;
    renderConnectPrompt('mix-connect-btn', window.currentUser.id, () => build(root));
};

const setAuto = async (root, days) => {
    const { error } = await supabase.rpc('set_mix_auto_refresh', { p_days: days });
    if (error) {
        toast('Could not update that setting. Please try again.', 'error');
        return;
    }
    dismissPrompt();   // they've answered the question either way
    toast(days ? `Done. A fresh mix every ${days} days.` : 'Automatic refresh is off.', 'success');
    await render(root);
};

const build = async (root) => {
    const wasEmpty = !!root.querySelector('#mix-make');

    if (!(await checkSpotifyConnection(window.currentUser.id))) {
        showConnect(root);
        return;
    }

    setBusy(root, true);
    let ok = false;
    try {
        const response = await authedFetch(`${SPOTIFY_WORKER}/mix`, { method: 'POST', body: JSON.stringify({}) });
        const result = await response.json().catch(() => ({}));

        // 409 = the Spotify connection is missing or was revoked.
        if (response.status === 409) {
            setBusy(root, false);
            showConnect(root);
            return;
        }
        if (!result.playlistUrl) throw new Error(result.error || 'No playlist URL returned');

        ok = true;
        toast(result.partial ? 'Playlist ready. A shorter mix this time.' : 'Your GigList playlist is ready 🎶', 'success');
    } catch (err) {
        console.error('[GigList] mix playlist failed:', err);
        toast(err.message || 'Could not make your playlist. Please try again.', 'error');
    }

    setBusy(root, false);
    // First mix: open the card so the reveal (faces, names, the auto-refresh
    // question) lands while they're looking at it.
    if (ok && wasEmpty) expanded = true;
    await render(root, { animate: ok });
};

const wire = (root, mix) => {
    root.querySelector('#mix-make')?.addEventListener('click', () => build(root));
    root.querySelector('#mix-remix')?.addEventListener('click', () => build(root));
    root.querySelector('#mix-toggle')?.addEventListener('click', () => setExpanded(root, !expanded));

    root.querySelector('#mix-play')?.addEventListener('click', () => {
        setExpanded(root, true);
        const id = playlistIdFromUrl(mix?.playlist_url);
        if (window.loadSpotifyEmbed && id) window.loadSpotifyEmbed(EMBED_ID, `playlist/${id}`);
        else if (mix?.playlist_url) window.open(safeUrl(mix.playlist_url), '_blank', 'noopener');
    });

    root.querySelector('#mix-auto-on')?.addEventListener('click', () => setAuto(root, REFRESH_DAYS));
    root.querySelector('#mix-auto-off')?.addEventListener('click', () => setAuto(root, null));
    root.querySelector('#mix-auto-skip')?.addEventListener('click', async () => {
        dismissPrompt();
        await render(root);
    });
};

const render = async (root, { animate = false } = {}) => {
    const mix = await fetchMix();
    if (!mix) {
        root.innerHTML = emptyHtml();
    } else {
        const artists = await fetchArtists(mix.last_artist_ids);
        root.innerHTML = readyHtml(mix, artists, animate);
    }
    wire(root, mix);
    icons();
};

// ─── public ───────────────────────────────────────────────────────────────────

export const initMixPlaylistCard = async (rootId) => {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.innerHTML = '';                                   // (re)start empty so `empty:hidden` applies
    if (!window.currentUser?.isAuthUser) return;

    injectStyles();
    expanded = false;

    const mix = await fetchMix();
    if (!mix && distinctArtists() < MIN_ARTISTS) return;   // too early to offer
    await render(root);
};
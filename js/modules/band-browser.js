/**
 * GigList — Band Browser Module
 * v1.0.0 — 2026-10-22
 * -------------------------------------------------------------------
 * Full-screen sheet (mobile) / large modal (desktop) for browsing every
 * band page: artist image, headline stats, favourites, search and sort.
 * Opened from the mode switcher ("All bands"); selecting a band hands off
 * to window._switchToBand (defined in switcher.js).
 *
 * Exports:
 *   openBandBrowser()
 *   closeBandBrowser()
 *
 * Dispatches window event 'giglist:favourites-changed' with
 * detail = [bandName, ...] (in the order they were favourited) so the
 * switcher can rebuild its short list.
 *
 * Needs (see band_browser.sql):
 *   user_favourite_bands table
 *   get_band_browser_stats() RPC  (falls back to a plain bands query)
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';

const OVERLAY_ID = 'band-browser';

// Custom dropdown arrow for the sort <select> (native arrow hugs the right edge)
const SELECT_ARROW = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>";

// ─── STATE ────────────────────────────────────────────────────────────────────

let _bands      = [];        // [{ name, rank, image_url, shows, fans, catalogue_items, my_shows }]
let _favourites = [];        // band names, in favourited order
let _loaded     = false;     // stats cached for the session
let _query      = '';
let _sort       = 'az';      // 'az' | 'shows' | 'fans'
let _isOpen     = false;
let _pushed     = false;     // did we push a history entry?
let _returnFocus = null;

const _canFavourite = () => !!window.currentUser?.isAuthUser;
const _currentBand  = () => window.currentUser?.Type === 'Band' ? window.currentUser.UserName : null;

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function openBandBrowser() {
    if (_isOpen) return;
    _isOpen = true;
    _query = '';
    _returnFocus = document.activeElement;

    _buildShell();
    document.body.style.overflow = 'hidden';

    // Back button closes the sheet rather than leaving the app.
    history.pushState({ giglistBandBrowser: true }, '');
    _pushed = true;
    window.addEventListener('popstate', _onPopState);
    document.addEventListener('keydown', _onKeyDown);

    await _load();
    if (_isOpen) _render();
}

export function closeBandBrowser() {
    if (!_isOpen) return;
    if (_pushed) {
        history.back();          // popstate → _teardown()
    } else {
        _teardown();
    }
}

window.openBandBrowser  = openBandBrowser;
window.closeBandBrowser = closeBandBrowser;

// ─── DATA ─────────────────────────────────────────────────────────────────────

async function _load() {
    const [statsRes, favRes] = await Promise.all([
        _loaded ? Promise.resolve(null) : supabase.rpc('get_band_browser_stats'),
        _canFavourite()
            ? supabase.from('user_favourite_bands').select('band_name').order('created_at')
            : Promise.resolve({ data: [] }),
    ]);

    if (statsRes) {
        if (!statsRes.error && statsRes.data?.length) {
            _bands = statsRes.data;
        } else {
            // RPC not deployed yet (or failed): fall back to names only.
            if (statsRes.error) console.warn('[band-browser] stats RPC failed, using fallback', statsRes.error);
            const { data } = await supabase.from('bands').select('name, rank').order('name');
            _bands = (data || []).map(b => ({ ...b, image_url: null, shows: null, fans: null, catalogue_items: null, my_shows: 0 }));
        }
        _loaded = true;
    }

    _favourites = (favRes.data || []).map(r => r.band_name);
}

async function _toggleFavourite(name) {
    if (!_canFavourite()) return;
    const wasFav  = _favourites.includes(name);
    const before  = [..._favourites];

    // Optimistic update
    _favourites = wasFav ? _favourites.filter(n => n !== name) : [..._favourites, name];
    _render();

    const { error } = wasFav
        ? await supabase.from('user_favourite_bands').delete().eq('band_name', name)
        : await supabase.from('user_favourite_bands').insert({ band_name: name });

    if (error) {
        console.warn('[band-browser] favourite toggle failed', error);
        _favourites = before;
        _render();
        return;
    }
    window.dispatchEvent(new CustomEvent('giglist:favourites-changed', { detail: [..._favourites] }));
}

// ─── SHELL ────────────────────────────────────────────────────────────────────

function _buildShell() {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'fixed inset-0 z-[300] flex items-end md:items-center justify-center bg-slate-900/60 backdrop-blur-sm';

    overlay.innerHTML = `
        <div id="band-browser-panel" role="dialog" aria-modal="true" aria-labelledby="band-browser-title"
             class="bg-white w-full md:max-w-3xl h-[92dvh] md:h-[82vh] rounded-t-[2rem] md:rounded-[2rem] shadow-2xl flex flex-col overflow-hidden">

            <div class="px-5 pt-5 pb-3 border-b border-slate-100 flex-shrink-0">
                <div class="flex items-center justify-between mb-3">
                    <h2 id="band-browser-title" class="text-2xl font-black text-slate-900 tracking-tight">Band Pages</h2>
                    <button id="band-browser-close" type="button" aria-label="Close band pages"
                            class="w-10 h-10 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600">
                        <svg viewBox="0 0 24 24" class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                    </button>
                </div>
                <div class="flex items-center gap-2">
                    <input id="band-browser-search" type="search" placeholder="Search bands" autocomplete="off"
                           aria-label="Search bands"
                           class="flex-1 min-w-0 px-4 py-2.5 rounded-full bg-slate-100 text-sm font-bold text-slate-900 placeholder-slate-400 outline-none focus:ring-2 focus:ring-indigo-300">
                    <select id="band-browser-sort" aria-label="Sort bands"
                            class="appearance-none pl-4 pr-9 py-2.5 rounded-full bg-slate-100 text-xs font-black text-slate-600 outline-none focus:ring-2 focus:ring-indigo-300 cursor-pointer">
                        <option value="az">A–Z</option>
                        <option value="shows">Most shows</option>
                        <option value="fans">Most fans</option>
                    </select>
                </div>
            </div>

            <div id="band-browser-body" class="flex-1 overflow-y-auto px-5 py-4" style="overscroll-behavior:contain;">
                <p class="text-sm font-bold text-slate-400 py-10 text-center">Loading bands…</p>
            </div>

            <p class="px-5 py-2 text-[10px] text-slate-400 font-bold border-t border-slate-100 flex-shrink-0">Artist images from Spotify</p>
        </div>`;

    // Backdrop click closes; clicks inside the panel don't.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBandBrowser(); });

    const body = overlay.querySelector('#band-browser-body');
    body.addEventListener('click', _onBodyClick);
    // Broken/blocked artist images fall back to the gradient + initial.
    body.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

    overlay.querySelector('#band-browser-close').addEventListener('click', closeBandBrowser);
    overlay.querySelector('#band-browser-search').addEventListener('input', (e) => { _query = e.target.value; _render(); });
    const sortSelect = overlay.querySelector('#band-browser-sort');
    sortSelect.style.cssText = `background-image:url("${SELECT_ARROW}");background-repeat:no-repeat;background-position:right 14px center;background-size:12px 12px;`;
    sortSelect.addEventListener('change', (e) => { _sort = e.target.value; _render(); });

    document.body.appendChild(overlay);

    // Don't auto-focus search on touch devices: the on-screen keyboard would
    // cover the band images. Focus the dialog itself instead (keeps Escape and
    // the focus trap working); desktop users with a mouse still get search.
    const panel = overlay.querySelector('#band-browser-panel');
    panel.setAttribute('tabindex', '-1');
    panel.classList.add('outline-none');
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        overlay.querySelector('#band-browser-search').focus({ preventScroll: true });
    } else {
        panel.focus({ preventScroll: true });
    }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function _sorted(list) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const arr = [...list];
    if (_sort === 'shows') return arr.sort((a, b) => (b.shows ?? 0) - (a.shows ?? 0) || byName(a, b));
    if (_sort === 'fans')  return arr.sort((a, b) => (b.fans  ?? 0) - (a.fans  ?? 0) || byName(a, b));
    return arr.sort(byName);
}

function _render() {
    const body = document.getElementById('band-browser-body');
    if (!body) return;
    const scrollTop = body.scrollTop;

    const q = _query.trim().toLowerCase();
    const matches = q ? _bands.filter(b => b.name.toLowerCase().includes(q)) : _bands;

    let html = '';
    if (q) {
        html = matches.length
            ? _grid(_sorted(matches))
            : `<p class="text-sm font-bold text-slate-400 py-10 text-center">No bands match “${escapeHtml(_query.trim())}”.</p>`;
    } else {
        const favSet = new Set(_favourites);
        const favs   = _sorted(_bands.filter(b => favSet.has(b.name)));
        const rest   = _sorted(_bands.filter(b => !favSet.has(b.name)));

        if (favs.length) {
            html += `<h3 class="text-sm font-black text-slate-900 mb-2">Your bands</h3>${_grid(favs)}`;
            if (rest.length) html += `<h3 class="text-sm font-black text-slate-900 mt-6 mb-2">More bands</h3>`;
        }
        if (rest.length) {
            html += _grid(rest);
        } else if (!favs.length) {
            html = '<p class="text-sm font-bold text-slate-400 py-10 text-center">No band pages yet.</p>';
        }
        if (!favs.length && rest.length && _canFavourite()) {
            html = `<p class="text-xs text-slate-400 font-bold mb-3">Tap the heart on a band to pin it here and in your menu.</p>` + html;
        }
    }

    body.innerHTML = html;
    body.scrollTop = scrollTop;
}

function _grid(bands) {
    return `<div class="grid grid-cols-2 md:grid-cols-3 gap-3">${bands.map(_card).join('')}</div>`;
}

function _plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : many}`; }

function _card(b) {
    const isFav     = _favourites.includes(b.name);
    const isCurrent = b.name === _currentBand();
    const name      = escapeHtml(b.name);

    const stats = [];
    if (b.shows != null)           stats.push(_plural(Number(b.shows), 'show', 'shows'));
    if (b.fans != null)            stats.push(_plural(Number(b.fans), 'fan', 'fans'));
    if (b.catalogue_items != null && Number(b.catalogue_items) > 0)
                                   stats.push(_plural(Number(b.catalogue_items), 'item', 'items'));
    const seen = Number(b.my_shows);
    const mine = seen > 0 ? (seen === 1 ? 'You’ve seen once' : `You’ve seen ${seen.toLocaleString()} times`) : '';

    const img = b.image_url
        ? `<img src="${escapeHtml(b.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
                class="absolute inset-0 w-full h-full object-cover">`
        : '';

    return `
        <div class="relative aspect-[4/5] rounded-[1.5rem] overflow-hidden bg-gradient-to-br from-indigo-600 to-slate-800 ${isCurrent ? 'ring-2 ring-indigo-400 ring-offset-2' : ''}">
            <span class="absolute inset-0 flex items-center justify-center text-6xl font-black text-white/20" aria-hidden="true">${escapeHtml(b.name.charAt(0).toUpperCase())}</span>
            ${img}
            <div class="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/20 to-transparent pointer-events-none"></div>

            <button type="button" data-open-band="${name}" aria-label="Open ${name} band page${isCurrent ? ' (current)' : ''}"
                    class="absolute inset-0 w-full h-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-[1.5rem]">
                <span class="absolute left-3 right-3 bottom-3 block">
                    <span class="block font-display text-2xl font-black leading-tight text-white" style="font-family:'Barlow Condensed',sans-serif;">${name}</span>
                    ${stats.length ? `<span class="block text-[11px] font-bold text-white/80 mt-0.5">${stats.join(' · ')}</span>` : ''}
                    ${mine ? `<span class="inline-block mt-1.5 px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-black text-white">${mine}</span>` : ''}
                </span>
            </button>

            ${_canFavourite() ? `
            <button type="button" data-fav-band="${name}" aria-pressed="${isFav}"
                    aria-label="${isFav ? 'Remove' : 'Add'} ${name} ${isFav ? 'from' : 'to'} your favourite bands"
                    class="absolute top-2.5 right-2.5 w-9 h-9 rounded-full bg-slate-900/40 backdrop-blur-sm flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                <svg viewBox="0 0 24 24" class="w-5 h-5 pointer-events-none" fill="${isFav ? '#f43f5e' : 'none'}" stroke="${isFav ? '#f43f5e' : '#fff'}" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 2.9 5 6.3 5c2 0 3.5 1.1 4.2 2.4h3C14.2 6.1 15.7 5 17.7 5c3.4 0 5.3 3.6 3.9 6.8C19.5 16.4 12 21 12 21z"/>
                </svg>
            </button>` : ''}
        </div>`;
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────

function _onBodyClick(e) {
    const fav = e.target.closest('[data-fav-band]');
    if (fav) { _toggleFavourite(fav.dataset.favBand); return; }

    const open = e.target.closest('[data-open-band]');
    if (open) {
        const name = open.dataset.openBand;
        if (name === _currentBand()) { closeBandBrowser(); return; }
        _teardown();                              // we're navigating away; skip history.back()
        window._switchToBand?.(name);
    }
}

function _onKeyDown(e) {
    if (!_isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeBandBrowser(); return; }

    // Simple focus trap
    if (e.key === 'Tab') {
        const panel = document.getElementById('band-browser-panel');
        const items = panel ? [...panel.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled) : [];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
}

function _onPopState() {
    // Back button (or our own history.back()) closes the sheet.
    _pushed = false;
    _teardown();
}

function _teardown() {
    if (!_isOpen) return;
    _isOpen = false;
    window.removeEventListener('popstate', _onPopState);
    document.removeEventListener('keydown', _onKeyDown);
    document.getElementById(OVERLAY_ID)?.remove();
    document.body.style.overflow = '';
    _pushed = false;
    if (_returnFocus && document.contains(_returnFocus)) _returnFocus.focus({ preventScroll: true });
    _returnFocus = null;
}
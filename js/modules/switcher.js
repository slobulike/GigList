/**
 * GigList — Switcher Module
 * v1.1.0 — 2026-10-22
 * -------------------------------------------------------------------
 * Mode switcher panel: Personal / Band Pages / Want to See / Clashfinder / Sign Out.
 * Extracted from app.js.
 *
 * v1.1.0: the Band Pages accordion is replaced by a short list (your
 * favourites, or the top bands by rank with Weezer pinned) plus an
 * "All bands" row that opens the Band Browser modal (band-browser.js).
 *
 * Exports:
 *   initModeSwitcher(currentUser, supabaseClient)
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';

const PINNED_BAND   = 'Weezer';   // always in the default (no favourites) short list
const DEFAULT_COUNT = 3;          // default short list size
const MAX_FAVS      = 4;          // max favourites shown in the switcher

// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initModeSwitcher(currentUser) {
    if (!currentUser?.isAuthUser) return;

    // Never let a failed fetch stop the logo handler below from attaching:
    // without it the logo keeps its href and a tap reloads the whole app.
    // NB: keep .order('rank') — the default short list is "top bands by rank".
    // A–Z ordering lives in the Band Browser.
    try {
        const [bandsRes, favsRes] = await Promise.all([
            supabase.from('bands').select('name, rank').order('rank'),
            supabase.from('user_favourite_bands').select('band_name').order('created_at'),
        ]);
        window._switcherBands = bandsRes.data || [];
        // If the favourites table isn't deployed yet this errors; fall back to no favourites.
        window._switcherFavs  = favsRes.error ? [] : (favsRes.data || []).map(r => r.band_name);
    } catch (err) {
        console.warn('[switcher] could not load bands/favourites', err);
        window._switcherBands = window._switcherBands || [];
        window._switcherFavs  = window._switcherFavs  || [];
    }

    const logoLink = document.getElementById('header-logo-link');
    if (!logoLink) return;

    logoLink.removeAttribute('href');
    logoLink.style.cursor = 'pointer';
    logoLink.setAttribute('role', 'button');
    logoLink.setAttribute('aria-label', 'Switch mode');
    logoLink.setAttribute('aria-expanded', 'false');
    logoLink.setAttribute('aria-controls', 'mode-switcher-panel');

    logoLink.querySelectorAll('*').forEach(el => el.style.pointerEvents = 'none');

    logoLink.addEventListener('click', (e) => {
        e.preventDefault();
        _toggleSwitcher();
    });

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('mode-switcher-panel');
        if (panel && !panel.classList.contains('hidden') &&
            !panel.contains(e.target) && !logoLink.contains(e.target)) {
            closeSwitcher();
        }
    });

    // Band Browser tells us when favourites change; drop the stale panel so
    // it rebuilds with the new short list next time it opens.
    window.addEventListener('giglist:favourites-changed', (e) => {
        window._switcherFavs = e.detail || [];
        document.getElementById('mode-switcher-panel')?.remove();
    });
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────

function _toggleSwitcher() {
    const panel = document.getElementById('mode-switcher-panel');
    if (!panel) { _buildSwitcherPanel(); return; }
    if (panel.classList.contains('hidden')) {
        _openSwitcher();
    } else {
        closeSwitcher();
    }
}

function _openSwitcher() {
    let panel = document.getElementById('mode-switcher-panel');
    if (!panel) panel = _buildSwitcherPanel();
    panel.classList.remove('hidden');
    document.getElementById('header-logo-link')?.setAttribute('aria-expanded', 'true');
    if (window.lucide) lucide.createIcons();
}

function closeSwitcher() {
    const panel = document.getElementById('mode-switcher-panel');
    if (panel) panel.classList.add('hidden');
    document.getElementById('header-logo-link')?.setAttribute('aria-expanded', 'false');
}

// Exposed on window so social.js navigation functions (_switchToFriend etc.) can close the panel
window._closeSwitcher = closeSwitcher;

// ─── SHORT LIST ───────────────────────────────────────────────────────────────

/**
 * Which bands appear directly in the switcher.
 *  - With favourites: up to MAX_FAVS of them, in the order they were favourited.
 *  - Without: the top DEFAULT_COUNT by rank, with PINNED_BAND guaranteed.
 * The band you're currently viewing is always included so you can see where you are.
 * Returns band names.
 */
function _shortlist(bands, favs, currentBand) {
    const known = new Set(bands.map(b => b.name));
    let picked;

    const validFavs = favs.filter(n => known.has(n));
    if (validFavs.length) {
        picked = validFavs.slice(0, MAX_FAVS);
    } else {
        picked = bands.slice(0, DEFAULT_COUNT).map(b => b.name);   // bands arrive ordered by rank
        if (known.has(PINNED_BAND) && !picked.includes(PINNED_BAND) && picked.length) {
            picked[picked.length - 1] = PINNED_BAND;
        }
    }

    if (currentBand && known.has(currentBand) && !picked.includes(currentBand)) {
        picked.push(currentBand);
    }
    return picked;
}

// ─── BUILD PANEL ──────────────────────────────────────────────────────────────

function _buildSwitcherPanel() {
    const currentUser   = window.currentUser;
    const isPersonal    = currentUser.Type === 'Personal';
    const isBand        = currentUser.Type === 'Band';
    const bands         = window._switcherBands || [];
    const favs          = window._switcherFavs  || [];
    const currentBand   = isBand ? currentUser.UserName : null;
    const shortlist     = _shortlist(bands, favs, currentBand);

    const panel = document.createElement('div');
    panel.id        = 'mode-switcher-panel';
    panel.className = 'absolute top-full left-0 mt-2 w-64 bg-white rounded-[1.5rem] shadow-2xl border border-slate-100 overflow-hidden z-[200]';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Switch mode');

    // onclick is only ever a fixed string; band names travel in dataAttrs
    // (data-switch-band) and are dispatched by the panel listener below,
    // since they come from user-submitted band requests.
    const row = (label, sublabel, active, onclick, icon = 'check', dataAttrs = '') => `
        <button ${onclick ? `onclick="${onclick}"` : ''} ${dataAttrs} role="menuitem"
                class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors ${active ? 'opacity-50 cursor-default pointer-events-none' : ''}">
            <span class="w-5 flex-shrink-0 flex items-center justify-center">
                ${active ? `<i data-lucide="${icon}" class="w-4 h-4 text-indigo-600"></i>` : ''}
            </span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-black text-slate-900 truncate">${escapeHtml(label)}</span>
                ${sublabel ? `<span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">${escapeHtml(sublabel)}</span>` : ''}
            </span>
        </button>`;

    const favSet = new Set(favs);

    panel.innerHTML = `
        ${row(window.authDisplayName || 'My Gig List',
              'Personal Archive',
              isPersonal,
              isPersonal ? '' : "window._switchToPersonal()")}

        <div class="border-t border-slate-100">
            <p class="px-4 pt-3 pb-1 text-sm font-black text-slate-900">Band Pages</p>
            <div id="switcher-band-list" class="bg-slate-50/50">
                ${shortlist.map(name => row(
                    name,
                    favSet.has(name) ? 'Favourite' : 'Band Page',
                    currentBand === name,
                    '', 'check',
                    `data-switch-band="${escapeHtml(name)}"`
                )).join('')}
                ${bands.length === 0 ? '<p class="px-4 py-3 text-xs text-slate-400">No band pages yet.</p>' : ''}
            </div>
            ${bands.length ? `
            <button onclick="window._closeSwitcher(); window.openBandBrowser();" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                <span class="w-5 flex-shrink-0 flex items-center justify-center">
                    <i data-lucide="layout-grid" class="w-4 h-4 text-indigo-400"></i>
                </span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-black text-slate-900">All bands</span>
                    <span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">${bands.length} band page${bands.length === 1 ? '' : 's'}</span>
                </span>
            </button>` : ''}
        </div>

        <div class="border-t border-slate-100">
            <button id="menu-wishlist" onclick="window._closeSwitcher(); window.openWishlistModal();" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                <span class="w-5 flex-shrink-0 flex items-center justify-center">
                    <i data-lucide="heart" class="w-4 h-4 text-indigo-400"></i>
                </span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-black text-slate-900">Want to See</span>
                    <span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">Your wishlist</span>
                </span>
            </button>
        </div>

        <div class="border-t border-slate-100">
            <button onclick="window.location.href='clashfinder.html'" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                <span class="w-5 flex-shrink-0 flex items-center justify-center">
                    <i data-lucide="calendar-clock" class="w-4 h-4 text-indigo-400"></i>
                </span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-black text-slate-900">Clashfinder</span>
                    <span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">Slam Dunk 2026</span>
                </span>
            </button>
        </div>

        <div class="border-t border-slate-100">
            <button onclick="window.signOut()" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-red-50 transition-colors group">
                <span class="w-5 flex-shrink-0 flex items-center justify-center">
                    <i data-lucide="log-out" class="w-4 h-4 text-slate-400 group-hover:text-red-500"></i>
                </span>
                <span class="text-sm font-black text-slate-500 group-hover:text-red-600">Sign Out</span>
            </button>
        </div>
    `;

    panel.style.position = 'fixed';
    panel.style.top = '64px';
    panel.style.left = '12px';
    panel.classList.remove('absolute', 'top-full');
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-switch-band]');
        if (btn) window._switchToBand(btn.dataset.switchBand);
    });
    document.body.appendChild(panel);

    if (window.lucide) lucide.createIcons();
    return panel;
}

// ─── BAND BROWSER (lazy) ──────────────────────────────────────────────────────
// Loaded on first use so it adds nothing to initial app load.

window.openBandBrowser = async () => {
    const mod = await import('./band-browser.js');
    mod.openBandBrowser();
};

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

window._switchToPersonal = () => {
    closeSwitcher();
    window.location.href = 'vault.html';
};

window._switchToBand = (bandName) => {
    closeSwitcher();
    window.location.href = `vault.html?band=${encodeURIComponent(bandName)}`;
};

// _switchToFriend retired — buddy navigation now uses window.openProfile(userId)
// See switcher panel Buddies section above.
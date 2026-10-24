/**
 * GigList — Switcher Module
 * v1.2.2 — 2026-10-24
 * -------------------------------------------------------------------
 * Mode switcher panel: Personal / Band Pages / Want to See / Clashfinder / Sign Out.
 * Extracted from app.js.
 *
 * v1.2.0: the Band Pages accordion is replaced by your favourite bands
 * plus an "All bands" row that opens the Band Browser modal
 * (band-browser.js). With no favourites yet, a placeholder below the
 * "All bands" row explains the list fills once one is added.
 *
 * Exports:
 *   initModeSwitcher(currentUser, supabaseClient)
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';

const MAX_FAVS = 4;   // max favourites shown in the switcher

// ─── INIT ─────────────────────────────────────────────────────────────────────

let _dataPromise = null;

// ─── EARLY TAP GUARD ──────────────────────────────────────────────────────────
// app.js calls initModeSwitcher at the very end of boot, so for the first few
// seconds the logo is still a plain <a href> and a tap reloads the whole app
// (worse right after a deploy, when boot is slower). This guard runs as soon
// as this module loads: it swallows early taps and, once the switcher is
// wired, opens the panel for the person who tapped. If boot never finishes
// (something threw), after BOOT_GRACE_MS the logo goes back to behaving like a
// normal link, so it can't be left permanently dead.

const BOOT_GRACE_MS = 20000;
const _moduleLoadedAt = Date.now();
let _settled     = false;   // initModeSwitcher has wired the logo (or decided not to)
let _pendingOpen = false;   // user tapped the logo before it was wired

document.addEventListener('click', (e) => {
    const link = e.target.closest?.('#header-logo-link');
    if (!link || _settled) return;
    if (Date.now() - _moduleLoadedAt > BOOT_GRACE_MS) return;
    e.preventDefault();
    _pendingOpen = true;
}, true);

// Auth-less / no-logo case: nothing to wire. Replay a swallowed tap as a normal link.
function _settleWithoutSwitcher(logoLink) {
    _settled = true;
    if (_pendingOpen) {
        _pendingOpen = false;
        const href = logoLink?.getAttribute('href');
        if (href) window.location.href = href;
    }
}

// Fetch the bands + favourites that feed the panel. Never throws.
function _loadSwitcherData() {
    return (async () => {
        try {
            const [bandsRes, favsRes] = await Promise.all([
                supabase.from('bands').select('name, rank').order('name'),
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
    })();
}

export async function initModeSwitcher(currentUser) {
    const logoLink = document.getElementById('header-logo-link');
    if (!currentUser?.isAuthUser || !logoLink) {
        _settleWithoutSwitcher(logoLink);
        return;
    }

    // Guard against double init (duplicate listeners would open then instantly close the panel).
    if (logoLink.dataset.switcherInit === '1') return;
    logoLink.dataset.switcherInit = '1';

    // Wire the logo FIRST, before any network work. Until this runs the logo is
    // still a plain link, so a tap reloads the whole app. The data fetch below
    // can be slow (or fail) without leaving that window open.
    logoLink.removeAttribute('href');
    logoLink.style.cursor = 'pointer';
    logoLink.setAttribute('role', 'button');
    logoLink.setAttribute('aria-label', 'Switch mode');
    logoLink.setAttribute('aria-expanded', 'false');
    logoLink.setAttribute('aria-controls', 'mode-switcher-panel');

    logoLink.querySelectorAll('*').forEach(el => el.style.pointerEvents = 'none');

    _dataPromise = _loadSwitcherData();

    logoLink.addEventListener('click', async (e) => {
        e.preventDefault();
        await _dataPromise;      // usually already resolved; only waits if data is still loading
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

    // Logo is wired: stop swallowing taps, and open the panel for anyone who
    // tapped while the app was still booting.
    _settled = true;
    if (_pendingOpen) {
        _pendingOpen = false;
        _dataPromise.then(_toggleSwitcher);
    }

    await _dataPromise;
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
 * Which bands appear directly in the switcher: up to MAX_FAVS favourites, in the
 * order they were favourited. The band you're currently viewing is always
 * included so you can see where you are. Returns band names (empty if none).
 */
function _shortlist(bands, favs, currentBand) {
    const known  = new Set(bands.map(b => b.name));
    const picked = favs.filter(n => known.has(n)).slice(0, MAX_FAVS);

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

    const favSet     = new Set(favs);
    const hasFavs    = favs.some(n => bands.some(b => b.name === n));

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
            ${bands.length && !hasFavs ? `
            <p class="px-4 pb-3 pl-12 text-xs text-slate-400 font-bold">Your favourite bands will appear here once you add one.</p>` : ''}
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
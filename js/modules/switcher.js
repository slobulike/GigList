/**
 * GigList — Switcher Module
 * v1.0.0 — 2026-04-19
 * -------------------------------------------------------------------
 * Mode switcher panel: Personal / Gig Buddies / Band Archives / Sign Out.
 * Extracted from app.js.
 *
 * Exports:
 *   initModeSwitcher(currentUser, supabaseClient)
 */

import { supabase } from './supabase.js';

// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initModeSwitcher(currentUser) {
    if (!currentUser?.isAuthUser) return;

    const { data: bands } = await supabase.from('bands').select('name, rank').order('rank');
    window._switcherBands = bands || [];

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

// ─── BUILD PANEL ──────────────────────────────────────────────────────────────

function _buildSwitcherPanel() {
    const currentUser   = window.currentUser;
    const isPersonal    = currentUser.Type === 'Personal';
    const isBand        = currentUser.Type === 'Band';
    const bands         = window._switcherBands || [];
    const currentBand   = isBand ? currentUser.UserName : null;
    const bandsExpanded     = isBand;

    const panel = document.createElement('div');
    panel.id        = 'mode-switcher-panel';
    panel.className = 'absolute top-full left-0 mt-2 w-64 bg-white rounded-[1.5rem] shadow-2xl border border-slate-100 overflow-hidden z-[200]';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Switch mode');

    const row = (label, sublabel, active, onclick, icon = 'check') => `
        <button onclick="${onclick}" role="menuitem"
                class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors ${active ? 'opacity-50 cursor-default pointer-events-none' : ''}">
            <span class="w-5 flex-shrink-0 flex items-center justify-center">
                ${active ? `<i data-lucide="${icon}" class="w-4 h-4 text-indigo-600"></i>` : ''}
            </span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-black text-slate-900 truncate">${label}</span>
                ${sublabel ? `<span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">${sublabel}</span>` : ''}
            </span>
        </button>`;

    panel.innerHTML = `
        ${row(window.authDisplayName || 'My Gig List',
              'Personal Archive',
              isPersonal,
              isPersonal ? '' : "window._switchToPersonal()")}

        <div class="border-t border-slate-100">
            <button onclick="window._toggleBandSection(this)" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                    aria-expanded="${bandsExpanded}" aria-controls="switcher-band-list">
                <span class="w-5 flex-shrink-0"></span>
                <span class="flex-1 text-sm font-black text-slate-900">Band Archives</span>
                <i data-lucide="chevron-${bandsExpanded ? 'up' : 'down'}" class="w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true"></i>
            </button>
            <div id="switcher-band-list" class="${bandsExpanded ? '' : 'hidden'} bg-slate-50/50">
                ${bands.map(b => row(
                    b.name, 'Band Archive',
                    currentBand === b.name,
                    `window._switchToBand('${b.name.replace(/'/g, "\\'")}')`
                )).join('')}
                ${bands.length === 0 ? '<p class="px-4 py-3 text-xs text-slate-400">No band archives yet.</p>' : ''}
            </div>
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
    document.body.appendChild(panel);

    if (window.lucide) lucide.createIcons();
    return panel;
}

// ─── SECTION TOGGLES ─────────────────────────────────────────────────────────

window._toggleBandSection = (btn) => {
    const list = document.getElementById('switcher-band-list');
    if (!list) return;
    const expanding = list.classList.contains('hidden');
    list.classList.toggle('hidden');
    if (btn) {
        btn.setAttribute('aria-expanded', expanding ? 'true' : 'false');
        const chevron = btn.querySelector('[data-lucide^="chevron"]');
        if (chevron) {
            chevron.setAttribute('data-lucide', expanding ? 'chevron-up' : 'chevron-down');
            if (window.lucide) lucide.createIcons();
        }
    }
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
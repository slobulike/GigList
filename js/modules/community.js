/**
 * GigList — community.js
 * Community mode shell: a nav (Feed / Gigs / Stats / Fans), a gate for low
 * data, and an empty state that invites people to share GigList.
 *
 * Only profiles with is_public = true feed the community views. Counts come
 * from the get_community_summary() RPC (see community-summary.sql).
 *
 * Deep link: vault.html?community=<feed|gigs|stats|fans>. vault.html's <head>
 * adds the `community-boot` class before first paint so the personal home never
 * flashes; app.js calls openCommunity() as soon as the profile is known. The URL
 * follows the active tab while Community is open, and the param is removed on exit.
 *
 * Exports (also attached to window):
 *   initCommunity(currentUser)       — builds the shell; safe to call more than once
 *   openCommunity()                  — enter Community
 *   closeCommunity()                 — back to the user's own GigList
 *   showCommunityTab(tab)            — 'feed' | 'gigs' | 'stats' | 'fans'
 *   registerCommunityPane(tab, fn)   — fn(el, ctx) renders a tab's content
 *
 * Pane contract: a pane renders only into the element it's given and may return
 * a disposer (sync or via a promise). The disposer is called on tab change and
 * on leaving Community, so anything that needs cleanup (Leaflet map, Chart,
 * timer, listener, in-flight request) is released. Pane modules are loaded
 * lazily via _paneLoaders and register themselves when they load.
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// Below this many public profiles the tabs show the invite state instead.
// Admins always see the full shell so it can be built and tested.
const MIN_PUBLIC_USERS = 5;

const TABS = [
    { id: 'feed',  label: 'Feed',  icon: 'sparkles',
      stub: 'Highlights from across GigList: the bands and venues the community is logging right now.' },
    { id: 'gigs',  label: 'Gigs',  icon: 'ticket',
      stub: 'Venues and shows the community has been to, with upcoming dates at the places people go.' },
    { id: 'stats', label: 'Stats', icon: 'bar-chart-2',
      stub: 'Community-wide charts: most-seen bands, shows per year, and a map of busy venues.' },
    { id: 'fans',  label: 'Fans',  icon: 'users',
      stub: 'Public profiles you can browse and add as gig buddies.' },
];

const CARD = 'bg-white rounded-[2rem] border border-slate-100 shadow-sm p-5';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _user       = null;
let _active     = false;
let _tab        = 'feed';
let _summary    = null;        // { public_users, public_shows, public_venues }
let _deepLinkRead = false;
let _origSwitchView = null;
const _panes    = {};          // tab id → render fn
let _disposePane = null;       // disposer returned by the pane currently showing
let _renderSeq   = 0;          // bumped on every tab render / leave; guards stale async work

// Pane modules load on first use. Each calls registerCommunityPane() when it loads.
const _paneLoaders = {
    feed: () => import('./community-feed.js'),
    gigs: () => import('./community-gigs.js'),
    stats: () => import('./community-stats.js'),
    feed: () => import('./community-feed.js'),
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

export function initCommunity(currentUser) {
    _user = currentUser || _user;
    if (!_user?.isAuthUser || window.isBandMode) return;

    _injectShell();

    // Leaving Community by any other route (profile, a nav tap) must restore
    // the main nav, so wrap switchView once.
    if (!_origSwitchView && typeof window.switchView === 'function') {
        _origSwitchView = window.switchView;
        window.switchView = (viewId) => {
            if (_active) _leave();
            return _origSwitchView(viewId);
        };
    }
}

// ─── SHELL ────────────────────────────────────────────────────────────────────

function _injectShell() {
    // vault.html ships the Community section and nav as static markup (so a
    // shared link can show them before any JS runs). Build them only if absent.
    if (!document.getElementById('view-community')) {
        const host = document.querySelector('.view-section')?.parentElement
            || document.querySelector('main') || document.body;
        const section = document.createElement('section');
        section.id = 'view-community';
        section.className = 'view-section hidden space-y-4 pb-4';
        section.setAttribute('role', 'region');
        section.setAttribute('aria-label', 'Community');
        section.setAttribute('aria-hidden', 'true');
        section.innerHTML = `
            <div class="flex justify-between items-end mb-2">
                <div>
                    <h2 class="font-display text-5xl italic tracking-tight text-slate-900">Community</h2>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">Everyone on GigList</p>
                </div>
                <button type="button" id="community-share-btn"
                        class="w-10 h-10 rounded-full bg-white border border-slate-100 shadow-sm flex items-center justify-center text-slate-500 hover:text-indigo-600 active:scale-95 transition-all"
                        aria-label="Share this page">
                    <i data-lucide="share-2" class="w-4 h-4" aria-hidden="true"></i>
                </button>
            </div>
            <div id="community-body" class="space-y-4" aria-live="polite"></div>`;
        host.appendChild(section);
    }

    const mainNav = document.getElementById('main-nav');
    if (mainNav && !document.getElementById('community-nav')) {
        const nav = document.createElement('nav');
        nav.id = 'community-nav';
        nav.className = mainNav.className;
        nav.classList.add('hidden');
        nav.setAttribute('aria-label', 'Community navigation');
        nav.innerHTML = TABS.map(t => `
            <button type="button" id="community-nav-${t.id}" data-community-tab="${t.id}"
                    class="nav-item text-slate-400 flex flex-col items-center gap-1 flex-1"
                    aria-current="false" aria-label="${t.label}">
                <i data-lucide="${t.icon}" class="w-6" aria-hidden="true"></i>
                <span class="text-[9px] font-black uppercase">${t.label}</span>
            </button>`).join('');
        mainNav.insertAdjacentElement('afterend', nav);
    }

    // Wire once, whether the markup was static or built above.
    const share = document.getElementById('community-share-btn');
    if (share && !share._wired) { share._wired = true; share.addEventListener('click', _sharePage); }
    const nav = document.getElementById('community-nav');
    if (nav && !nav._wired) {
        nav._wired = true;
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-community-tab]');
            if (btn) showCommunityTab(btn.dataset.communityTab);
        });
    }

    if (window.lucide) lucide.createIcons();
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────

export async function openCommunity() {
    if (_active) return;
    initCommunity(_user || window.currentUser);          // idempotent
    if (!_user?.isAuthUser || window.isBandMode) return;  // signed-out visitors and band pages never get Community

    // First open: honour ?community=<tab> from a shared link.
    if (!_deepLinkRead) {
        _deepLinkRead = true;
        const t = new URLSearchParams(window.location.search).get('community');
        if (TABS.some(x => x.id === t)) _tab = t;
    }

    _showShell();
    _active = true;
    window.isCommunityMode = true;
    _dropSwitcherPanel();
    window.scrollTo(0, 0);


    await _loadSummary();
    await showCommunityTab(_tab);
}
window.openCommunity = openCommunity;

function _showShell() {
    document.querySelectorAll('.view-section').forEach(s => {
        s.classList.add('hidden');
        s.setAttribute('aria-hidden', 'true');
    });
    document.getElementById('main-nav')?.classList.add('hidden');
    document.getElementById('community-nav')?.classList.remove('hidden');

    const section = document.getElementById('view-community');
    section?.classList.remove('hidden');
    section?.setAttribute('aria-hidden', 'false');
}

export function closeCommunity() {
    _leave();
    if (_origSwitchView) _origSwitchView('home');
}
window.closeCommunity = closeCommunity;

function _leave() {
    _active = false;
    window.isCommunityMode = false;
    document.getElementById('community-nav')?.classList.add('hidden');
    document.getElementById('main-nav')?.classList.remove('hidden');
    const section = document.getElementById('view-community');
    section?.classList.add('hidden');
    section?.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('community-boot');
    _syncUrl(null);
    _dropSwitcherPanel();
    _renderSeq++;          // anything still loading must not render or keep resources
    _runDisposer();
}

function _runDisposer() {
    const d = _disposePane;
    _disposePane = null;
    if (typeof d !== 'function') return;
    try { d(); } catch (err) { console.warn('community: pane disposer failed', err); }
}

// The switcher caches its panel; drop it so it rebuilds with the right row
// marked as current next time it opens.
function _dropSwitcherPanel() {
    document.getElementById('mode-switcher-panel')?.remove();
}

// Keep the address bar on the shareable URL for the active tab.
function _syncUrl(tab) {
    try {
        const u = new URL(window.location.href);
        if (tab) u.searchParams.set('community', tab);
        else u.searchParams.delete('community');
        window.history.replaceState(window.history.state, '', u);
    } catch (_) { /* non-critical */ }
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

export async function showCommunityTab(tab) {
    if (!TABS.some(t => t.id === tab)) tab = 'feed';
    _tab = tab;
    _syncUrl(tab);

    // Same active-state classes switchView applies to the main nav.
    TABS.forEach(t => {
        const btn = document.getElementById(`community-nav-${t.id}`);
        if (!btn) return;
        const on = t.id === tab;
        btn.classList.toggle('active', on);
        btn.classList.toggle('text-indigo-600', on);
        btn.classList.toggle('bg-white', on);
        btn.classList.toggle('shadow-sm', on);
        btn.classList.toggle('text-slate-400', !on);
        btn.setAttribute('aria-current', on ? 'page' : 'false');
    });

    const body = document.getElementById('community-body');
    if (!body) return;

    // Release whatever the previous pane created before anything new renders.
    const seq = ++_renderSeq;
    _runDisposer();

    if (!_hasEnoughData()) {
        _renderInviteState(body);
    } else {
        const def = TABS.find(t => t.id === tab);
        body.innerHTML = '';

        // Lazy-load the pane module the first time its tab opens.
        if (!_panes[tab] && _paneLoaders[tab]) {
            try { await _paneLoaders[tab](); }
            catch (err) { console.error(`community: ${tab} pane failed to load`, err); }
            if (seq !== _renderSeq) return;
        }

        if (_panes[tab]) {
            // Each render gets its own host so a slow, stale pane can never write into the next tab.
            const host = document.createElement('div');
            host.className = 'space-y-4';
            body.replaceChildren(host);
            try {
                const disposer = await _panes[tab](host, { user: _user, summary: _summary });
                if (typeof disposer === 'function') {
                    if (seq === _renderSeq) _disposePane = disposer;
                    else { try { disposer(); } catch (_) { /* already stale */ } }
                }
            } catch (err) {
                console.error(`community: ${tab} pane failed`, err);
                if (seq === _renderSeq) {
                    body.innerHTML = `<p class="text-sm text-slate-500">Couldn't load ${def.label.toLowerCase()}. Please try again.</p>`;
                }
            }
        } else {
            body.innerHTML = `
                <div class="${CARD}">
                    <h3 class="text-sm font-black text-slate-900 mb-1">${def.label}</h3>
                    <p class="text-sm text-slate-500">${escapeHtml(def.stub)}</p>
                </div>`;
        }
    }
    if (window.lucide) lucide.createIcons();
}
window.showCommunityTab = showCommunityTab;

export function registerCommunityPane(tab, renderFn) {
    if (TABS.some(t => t.id === tab) && typeof renderFn === 'function') _panes[tab] = renderFn;
}
window.registerCommunityPane = registerCommunityPane;

// ─── DATA GATE ────────────────────────────────────────────────────────────────

async function _loadSummary() {
    try {
        const { data, error } = await supabase.rpc('get_community_summary');
        if (error) throw error;
        _summary = data || { public_users: 0, public_shows: 0, public_venues: 0 };
    } catch (err) {
        console.warn('community: summary failed', err);
        _summary = { public_users: 0, public_shows: 0, public_venues: 0 };
    }
}

function _hasEnoughData() {
    if (_user?.is_admin) return true;
    return (_summary?.public_users || 0) >= MIN_PUBLIC_USERS;
}

// ─── EMPTY / INVITE STATE ─────────────────────────────────────────────────────

function _renderInviteState(el) {
    const have = Math.min(_summary?.public_users || 0, MIN_PUBLIC_USERS);
    const pct  = Math.round((have / MIN_PUBLIC_USERS) * 100);
    const isPublic = !!_user?.is_public;

    el.innerHTML = `
        <div class="${CARD} space-y-4">
            <div>
                <h3 class="text-base font-black text-slate-900">Community unlocks when more people join</h3>
                <p class="text-sm text-slate-500 mt-1">
                    See where other GigList users go to shows and which bands they've seen.
                    It fills in as people set their profiles to public, and it's better with your friends in it.
                </p>
            </div>
            <div>
                <div class="flex items-center justify-between text-xs font-bold text-slate-500 mb-1">
                    <span>Public profiles</span>
                    <span>${have} of ${MIN_PUBLIC_USERS}</span>
                </div>
                <div class="h-2 rounded-full bg-slate-100 overflow-hidden"
                     role="progressbar" aria-valuemin="0" aria-valuemax="${MIN_PUBLIC_USERS}" aria-valuenow="${have}">
                    <div class="h-full bg-indigo-600 rounded-full" style="width:${pct}%"></div>
                </div>
            </div>
            <div class="flex flex-wrap gap-2">
                <button type="button" id="community-invite-btn"
                        class="bg-indigo-600 text-white text-xs font-black px-4 py-2 rounded-full hover:bg-indigo-700 active:scale-95 transition-all">
                    Invite friends to GigList
                </button>
                ${isPublic ? '' : `
                <button type="button" id="community-public-btn"
                        class="bg-slate-100 text-slate-700 text-xs font-black px-4 py-2 rounded-full hover:bg-slate-200 active:scale-95 transition-all">
                    Make my profile public
                </button>`}
            </div>
        </div>`;

    el.querySelector('#community-invite-btn')?.addEventListener('click', _shareInvite);
    el.querySelector('#community-public-btn')?.addEventListener('click', () => {
        _leave();
        window.switchView?.('profile');
    });
}

// ─── SHARING ──────────────────────────────────────────────────────────────────

async function _share(title, text, url) {
    try {
        if (navigator.share) {
            await navigator.share({ title, text, url });
        } else {
            await navigator.clipboard.writeText(`${text} ${url}`);
            window.showToast?.('Link copied!', 'success');
        }
    } catch (err) {
        if (err?.name !== 'AbortError') console.warn('community: share failed', err);
    }
}

// Share the Community page itself, on the tab currently showing.
function _sharePage() {
    const u = new URL(window.location.href);
    u.search = '';
    u.hash   = '';
    u.searchParams.set('community', _tab);
    _share('GigList Community', "See what's happening across GigList:", u.toString());
}

// Invite someone who isn't on GigList yet.
function _shareInvite() {
    const base = window.location.pathname.replace(/\/[^/]*$/, '');
    const url  = `${window.location.origin}${base}/index.html`;
    _share('Join me on GigList',
        "I've been logging my gigs on GigList and the community view is coming together. Join me!", url);
}
/**
 * GigList — community-fans.js
 * Community > Fans pane: public profiles you can browse and add as gig buddies.
 * Community-wide version of band mode's Fans tab, without the band filter.
 *
 * Pane contract (see community.js):
 *   - renders only into the host element it is given
 *   - returns a disposer (aborts requests, clears the search debounce, blocks
 *     late renders, removes listeners)
 *   - fetches via the get_community_fans() SECURITY DEFINER RPC (public
 *     profiles only); no window.* data globals, no reliance on personal stores
 *
 * Adding a buddy goes through window.followUser (social.js), NOT a direct
 * insert into `buddies`. followUser builds the pair in the order the table
 * requires (requester_id < addressee_id), sets initiator_id, auto-accepts
 * public profiles and keeps the switcher in step.
 */

import { supabase } from './supabase.js';
import { escapeHtml, safeUrl } from './utils.js';
import { registerCommunityPane } from './community.js';

const PAGE_SIZE   = 40;
const SEARCH_WAIT = 300;
const CARD = 'bg-white rounded-[2rem] border border-slate-100 shadow-sm p-5';

// ─── BUDDY STATUS ─────────────────────────────────────────────────────────────
// Own lookup, so this works even when personal stores (window._following) were
// never loaded, e.g. a shared Community link as the first page view.

async function _loadBuddyStatus(userId, signal) {
    const map = {};
    if (!userId) return map;
    try {
        const { data } = await supabase
            .from('buddies')
            .select('requester_id, addressee_id, status')
            .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
            .abortSignal(signal);
        (data || []).forEach(b => {
            const other = b.requester_id === userId ? b.addressee_id : b.requester_id;
            map[other] = b.status;
        });
    } catch (_) { /* aborted or failed: tiles just show Connect */ }
    return map;
}

// ─── TILES ────────────────────────────────────────────────────────────────────

function _cta(fan, viewer, status) {
    if (fan.id === viewer?.id) {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">You</span>`;
    }
    if (!viewer?.isAuthUser) return '';
    if (status === 'accepted') {
        return `<span class="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-600">
                    <i data-lucide="check" class="w-3 h-3" aria-hidden="true"></i> Buddies
                </span>`;
    }
    if (status === 'pending') {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Requested</span>`;
    }
    // Name is user-controlled text: data-* attributes + delegated listener, never inline onclick.
    return `<button type="button" data-cf-connect="${escapeHtml(fan.id)}"
                    data-cf-name="${escapeHtml(fan.username || fan.display_name || 'this fan')}"
                    class="text-[9px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 active:scale-95 transition-all px-3 py-1.5 rounded-full">
                Connect
            </button>`;
}

function _tile(fan, viewer, status) {
    const name     = fan.display_name || fan.username || 'GigList Fan';
    const initials = (fan.display_name || fan.username) ? name.slice(0, 2).toUpperCase() : '♪';
    const src      = safeUrl(fan.avatar_url);
    const avatar   = src
        ? `<img src="${escapeHtml(src)}" alt="" class="w-12 h-12 rounded-full object-cover ring-2 ring-white flex-shrink-0">`
        : `<div class="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-black flex-shrink-0">${escapeHtml(initials)}</div>`;

    const shows = `${fan.show_count} show${fan.show_count !== 1 ? 's' : ''}`;
    const since = fan.first_year ? ` · Gigging since ${fan.first_year}` : '';

    return `
        <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 flex items-center gap-4">
            ${avatar}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-slate-900 truncate">${escapeHtml(name)}</p>
                <p class="text-[10px] font-bold text-slate-400 mt-0.5">${escapeHtml(shows + since)}</p>
            </div>
            <div class="flex-shrink-0">${_cta(fan, viewer, status)}</div>
        </div>`;
}

function _empty(searching) {
    return `
        <div class="text-center py-12 space-y-2">
            <p class="text-4xl" aria-hidden="true">🎸</p>
            <p class="text-sm font-black text-slate-700">${searching ? 'No one matches that search' : 'No public profiles yet'}</p>
            <p class="text-[11px] text-slate-400">${searching
                ? 'Try a different name or username.'
                : 'Fans appear here when people set their profile to public.'}</p>
        </div>`;
}

// ─── PANE ─────────────────────────────────────────────────────────────────────

async function renderFansPane(el, ctx) {
    const viewer = ctx?.user || null;
    const ctrl   = new AbortController();
    let disposed = false;
    let timer    = null;

    // Per-render state, never shared on window.
    let query = '', offset = 0, total = 0, loading = false, seq = 0;
    let buddyMap = {};

    el.innerHTML = `
        <div class="${CARD} space-y-3">
            <label for="cf-fans-search" class="sr-only">Search fans</label>
            <input id="cf-fans-search" type="search" placeholder="Search by name or username"
                   autocomplete="off"
                   class="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-100 rounded-full px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-300">
            <p id="cf-fans-count" class="text-[10px] font-black uppercase tracking-widest text-slate-400" aria-live="polite"></p>
        </div>
        <div id="cf-fans-list" class="space-y-2"></div>
        <div id="cf-fans-more" class="text-center"></div>`;

    const listEl  = el.querySelector('#cf-fans-list');
    const moreEl  = el.querySelector('#cf-fans-more');
    const countEl = el.querySelector('#cf-fans-count');
    const inputEl = el.querySelector('#cf-fans-search');

    const refreshIcons = () => { if (window.lucide) lucide.createIcons(); };

    async function load(reset) {
        if (loading && !reset) return;
        const mySeq = ++seq;            // a newer search supersedes this call
        loading = true;
        if (reset) { offset = 0; listEl.innerHTML = `<div class="${CARD} animate-pulse h-20" aria-hidden="true"></div>`; moreEl.innerHTML = ''; }

        try {
            const { data, error } = await supabase
                .rpc('get_community_fans', { p_search: query || null, p_limit: PAGE_SIZE, p_offset: offset })
                .abortSignal(ctrl.signal);
            if (error) throw error;
            if (disposed || mySeq !== seq) return;

            const fans = data?.fans || [];
            total = data?.total || 0;
            if (reset) listEl.innerHTML = '';
            if (reset && !fans.length) {
                listEl.innerHTML = _empty(!!query);
            } else {
                listEl.insertAdjacentHTML('beforeend', fans.map(f => _tile(f, viewer, buddyMap[f.id])).join(''));
            }
            offset += fans.length;
            countEl.textContent = `${total} public profile${total !== 1 ? 's' : ''}`;
            moreEl.innerHTML = offset < total
                ? `<button type="button" data-cf-more
                           class="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800 px-4 py-2">
                       Show more
                   </button>`
                : '';
            refreshIcons();
        } catch (err) {
            if (disposed || mySeq !== seq) return;
            console.warn('community-fans: load failed', err);
            listEl.innerHTML = `<p class="text-sm text-slate-500">Couldn't load fans. Please try again.</p>`;
        } finally {
            if (mySeq === seq) loading = false;
        }
    }

    // Buddy status first (small query), then the first page so CTAs are right.
    if (viewer?.isAuthUser) buddyMap = await _loadBuddyStatus(viewer.id, ctrl.signal);
    if (disposed) return () => {};
    await load(true);

    // ── events ──
    const onInput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { query = inputEl.value.trim(); load(true); }, SEARCH_WAIT);
    };

    const onClick = async (e) => {
        if (e.target.closest('[data-cf-more]')) { load(false); return; }

        const btn = e.target.closest('[data-cf-connect]');
        if (!btn) return;
        if (typeof window.followUser !== 'function') {
            window.showToast?.('Buddy requests aren\u2019t available right now', 'warning');
            return;
        }
        btn.disabled = true;
        await window.followUser(btn.dataset.cfConnect, btn.dataset.cfName, btn);   // swaps the button itself
        if (disposed) return;
        if (viewer?.isAuthUser) buddyMap = await _loadBuddyStatus(viewer.id, ctrl.signal);
        refreshIcons();
    };

    inputEl.addEventListener('input', onInput);
    el.addEventListener('click', onClick);

    // Disposer: called on tab change and on leaving Community.
    return () => {
        disposed = true;
        clearTimeout(timer);
        ctrl.abort();
        inputEl.removeEventListener('input', onInput);
        el.removeEventListener('click', onClick);
    };
}

registerCommunityPane('fans', renderFansPane);
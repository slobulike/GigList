/**
 * GigList — community-feed.js
 * Community > Feed pane (v1, fully anonymous).
 *
 * Shows aggregate highlights across public profiles. No names, avatars,
 * venues-per-person or exact dates ever reach this module: the
 * get_community_feed() RPC (community-feed.sql) returns aggregates only.
 *
 * Pane contract (see community.js):
 *   - renders only into the host element it is given
 *   - returns a disposer (aborts the in-flight request, blocks late renders)
 *   - fetches via a SECURITY DEFINER RPC; cache is module-scoped, not window.*
 *   - never touches personal stores (journalData, _following, ...)
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';
import { registerCommunityPane } from './community.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const CARD = 'bg-white rounded-[2rem] border border-slate-100 shadow-sm p-5';
const EYEBROW = 'text-[10px] font-black text-slate-400 uppercase tracking-widest';

// Community-only cache. Module scope on purpose: not a window.* data global.
let _cache = null;   // { at: number, data: object }

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _recency(days) {
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7)  return 'this week';
    if (days < 14) return 'last week';
    if (days < 31) return 'this month';
    return 'a while ago';
}

const _plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── CARDS ────────────────────────────────────────────────────────────────────

function _hotCard(rows) {
    if (!rows?.length) return '';
    return `
        <section class="${CARD}" aria-labelledby="cf-hot">
            <p class="${EYEBROW}">Hot list</p>
            <h3 id="cf-hot" class="text-xl font-black italic uppercase tracking-tighter text-slate-900 mb-3">
                Just seen on GigList
            </h3>
            <ol class="space-y-2">
                ${rows.map((r, i) => `
                <li class="flex items-center gap-3">
                    <span class="w-6 text-right text-[11px] font-black text-slate-300">${i + 1}</span>
                    <span class="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                    <span class="text-[10px] font-black uppercase tracking-widest text-slate-400">${escapeHtml(_recency(r.days_ago))}</span>
                </li>`).join('')}
            </ol>
        </section>`;
}

function _trendingCard(rows) {
    if (!rows?.length) return '';
    return `
        <section class="${CARD}" aria-labelledby="cf-trending">
            <p class="${EYEBROW}">Last 30 days</p>
            <h3 id="cf-trending" class="text-xl font-black italic uppercase tracking-tighter text-slate-900 mb-3">
                Trending bands
            </h3>
            <ul class="space-y-2">
                ${rows.map(r => `
                <li class="flex items-center gap-3">
                    <span class="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                    <span class="bg-indigo-50 text-indigo-600 text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                        ${escapeHtml(_plural(r.people, 'fan', 'fans'))}
                    </span>
                </li>`).join('')}
            </ul>
        </section>`;
}

function _venuesAheadCard(rows) {
    if (!rows?.length) return '';
    return `
        <section class="${CARD}" aria-labelledby="cf-venues">
            <p class="${EYEBROW}">Next 30 days</p>
            <h3 id="cf-venues" class="text-xl font-black italic uppercase tracking-tighter text-slate-900 mb-3">
                Busy venues ahead
            </h3>
            <ul class="space-y-2">
                ${rows.map(r => `
                <li>
                    <button type="button" data-cf-venue
                            class="w-full flex items-center gap-3 text-left rounded-xl px-2 py-1.5 hover:bg-slate-50 active:scale-[0.99] transition-all">
                        <span class="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">${escapeHtml(r.venue)}</span>
                        <span class="bg-emerald-50 text-emerald-600 text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                            ${escapeHtml(_plural(r.people, 'person', 'people'))} going
                        </span>
                    </button>
                </li>`).join('')}
            </ul>
        </section>`;
}

function _onThisDayCard(rows) {
    if (!rows?.length) return '';
    const thisYear = new Date().getFullYear();
    return `
        <section class="${CARD}" aria-labelledby="cf-otd">
            <p class="${EYEBROW}">On this day</p>
            <h3 id="cf-otd" class="text-xl font-black italic uppercase tracking-tighter text-slate-900 mb-3">
                Community throwbacks
            </h3>
            <ul class="space-y-2">
                ${rows.map(r => {
                    const ago = thisYear - r.year;
                    return `
                <li class="flex items-center gap-3">
                    <span class="w-10 text-right text-[11px] font-black text-slate-300">${escapeHtml(String(r.year))}</span>
                    <span class="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                    <span class="text-[10px] font-black uppercase tracking-widest text-slate-400">${escapeHtml(_plural(ago, 'year', 'years'))} ago</span>
                </li>`;
                }).join('')}
            </ul>
        </section>`;
}

function _emptyCard() {
    return `
        <div class="${CARD} text-center space-y-2">
            <h3 class="text-base font-black text-slate-900">Nothing to show yet</h3>
            <p class="text-sm text-slate-500">
                The feed fills in as people log shows with public profiles.
                Invite a friend to GigList and it will get busier.
            </p>
        </div>`;
}

// ─── PANE ─────────────────────────────────────────────────────────────────────

async function renderFeedPane(el /*, ctx */) {
    let disposed = false;
    const ctrl = new AbortController();
    const disposer = () => { disposed = true; ctrl.abort(); };

    // Cold start: light skeleton so the tab doesn't flash empty.
    el.innerHTML = `<div class="${CARD} animate-pulse h-40" aria-hidden="true"></div>`;

    let data = (_cache && Date.now() - _cache.at < CACHE_TTL_MS) ? _cache.data : null;

    if (!data) {
        try {
            const { data: res, error } = await supabase
                .rpc('get_community_feed')
                .abortSignal(ctrl.signal);
            if (error) throw error;
            data = res || {};
            _cache = { at: Date.now(), data };
        } catch (err) {
            if (disposed) return disposer;   // left the tab; nothing to render
            console.warn('community-feed: load failed', err);
            el.innerHTML = `<p class="text-sm text-slate-500">Couldn't load the feed. Please try again.</p>`;
            return disposer;
        }
    }
    if (disposed) return disposer;

    const html = [
        _hotCard(data.hot),
        _trendingCard(data.trending),
        _venuesAheadCard(data.venues_ahead),
        _onThisDayCard(data.on_this_day),
    ].join('');

    el.innerHTML = html.trim() ? html : _emptyCard();

    // One delegated listener on the host; removed with the host on tab change,
    // and explicitly in the disposer for good measure.
    const onClick = (e) => {
        if (e.target.closest('[data-cf-venue]')) window.showCommunityTab?.('gigs');
    };
    el.addEventListener('click', onClick);
    const dispose = () => { el.removeEventListener('click', onClick); disposer(); };

    if (window.lucide) lucide.createIcons();
    return dispose;
}

registerCommunityPane('feed', renderFeedPane);
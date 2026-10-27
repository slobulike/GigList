/**
 * GigList — community-shared.js
 * Pieces every Community pane (Gigs, Stats, ...) shares, so they filter and
 * cache identically:
 *   - rpc(): SECURITY DEFINER RPC calls with a Community-only cache
 *   - filterBarHtml() / createCommunityQuery(): the search box, filter button and
 *     "N shows · 2024 · festivals — Clear all" strip, plus the state behind them
 *     (search text, drawer filters, drawer options) and the debounce
 *   - ensureChart(): lazy Chart.js
 *
 * createCommunityQuery() borrows the shared filter drawer from filters.js via
 * attachFilterSource() (see that file): options come from the community facets,
 * changes come back here, and the personal filter state is restored on dispose.
 * args() is what every RPC receives, so every view in a pane is always
 * describing the same set of gigs.
 *
 * Like the panes, nothing here touches personal stores or window data globals.
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';
import {
    initFilters, attachFilterSource, refreshFilterOptions, buildSummaryLine,
    openFilterDrawer, closeFilterDrawer, clearAllFilters,
} from './filters.js';

const SEARCH_DEBOUNCE = 300;
const CACHE_TTL_MS    = 5 * 60 * 1000;
const CACHE_MAX       = 60;

export const fmt    = (n) => Number(n || 0).toLocaleString('en-GB');
export const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

// ─── COMMUNITY-ONLY CACHE ─────────────────────────────────────────────────────
// Survives tab changes inside Community so revisiting a tab is instant. It is
// not on window and nothing outside Community reads it.

const _cache = new Map();

export async function rpc(name, args, signal) {
    const key = name + JSON.stringify(args);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

    let q = supabase.rpc(name, args);
    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q;
    if (error) throw error;

    _cache.set(key, { v: data, t: Date.now() });
    while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    return data;
}

/** For Phase 2 to call when leaving Community or after the user's data changes. */
export function clearCommunityCache() { _cache.clear(); }

// ─── CHART.JS ─────────────────────────────────────────────────────────────────
// Uses the app's own lazy loader (app.js) when it's there, else loads the same
// bare UMD bundle itself, so a shared Community link works either way.

let _chartPromise = null;

export function ensureChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (_chartPromise) return _chartPromise;

    _chartPromise = (typeof window.ensureChartJs === 'function'
        ? Promise.resolve(window.ensureChartJs())
        : new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('Chart.js failed to load'));
            document.head.appendChild(s);
        })
    ).then(() => {
        if (!window.Chart) throw new Error('Chart.js failed to load');
        return window.Chart;
    }).catch((err) => { _chartPromise = null; throw err; });

    return _chartPromise;
}

// ─── SEARCH + FILTER BAR ──────────────────────────────────────────────────────

export const filterBarHtml = ({ ariaLabel, placeholder }) => `
    <div class="flex gap-2">
        <div class="relative flex-1">
            <i data-lucide="search" class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden="true"></i>
            <input type="search" data-role="search" autocomplete="off"
                   aria-label="${escapeHtml(ariaLabel)}"
                   placeholder="${escapeHtml(placeholder)}"
                   class="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all shadow-sm">
        </div>
        <button type="button" data-role="open-filters" aria-label="Filter gigs"
                class="relative flex-shrink-0 px-4 bg-white border border-slate-200 rounded-2xl shadow-sm text-slate-500 hover:text-indigo-600 hover:border-indigo-300 active:scale-95 transition-all">
            <i data-lucide="sliders-horizontal" class="w-4 h-4" aria-hidden="true"></i>
            <span data-role="filter-badge"
                  class="hidden absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-black items-center justify-center"></span>
        </button>
    </div>

    <div data-role="filter-summary"
         class="hidden items-center justify-between gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-2.5">
        <p data-role="filter-summary-text" class="text-[11px] font-bold text-indigo-700 truncate"></p>
        <button type="button" data-role="clear-filters"
                class="text-[11px] font-black text-indigo-600 hover:text-indigo-800 flex-shrink-0">Clear all</button>
    </div>`;

/**
 * Wires the bar rendered by filterBarHtml() inside `el`.
 *   signal    AbortSignal — removes the listeners when the pane is disposed
 *   onChange  called (no args) whenever the effective query changes; the initial
 *             state doesn't call it, the pane does its own first load
 */
export function createCommunityQuery(el, { signal, onChange }) {
    const $ = (sel) => el.querySelector(sel);

    let search = '';
    let filters = { years: [], venue: '', festival: 'all' };
    let total = null;                 // filtered gig total, for the summary strip
    let timer = null;
    let disposed = false;
    const facets = { years: [], venues: [] };      // drawer options, unfiltered

    // Only filters that are actually set are included, so an unfiltered pane
    // sends exactly what it always has. p_search is always sent.
    function args() {
        const a = { p_search: search || null };
        if (filters.years.length)       a.p_years    = filters.years;
        if (filters.venue)              a.p_venue    = filters.venue;
        if (filters.festival !== 'all') a.p_festival = filters.festival === 'festival';
        return a;
    }
    const key = () => JSON.stringify(args());
    let lastKey = key();

    const activeFilterCount = () =>
        (filters.years.length ? 1 : 0) + (filters.venue ? 1 : 0) + (filters.festival !== 'all' ? 1 : 0);
    const hasFilters = () => activeFilterCount() > 0;

    function renderChrome() {
        const n = activeFilterCount();
        const strip = $('[data-role="filter-summary"]');
        if (strip) {
            strip.classList.toggle('hidden', n === 0);
            strip.classList.toggle('flex', n > 0);
            if (n) $('[data-role="filter-summary-text"]').textContent = buildSummaryLine(total ?? '…', 0);
        }
        const badge = $('[data-role="filter-badge"]');
        if (badge) {
            badge.textContent = String(n);
            badge.classList.toggle('hidden', n === 0);
            badge.classList.toggle('flex', n > 0);
        }
    }

    function changed() {
        const k = key();
        renderChrome();
        if (k === lastKey) return;
        lastKey = k;
        onChange();
    }

    function onFiltersChanged(fs) {
        filters = { years: fs.years.map(Number), venue: fs.venue || '', festival: fs.festival || 'all' };
        changed();
    }

    // Drawer options. Unfiltered, so the drawer always offers every year/venue.
    async function loadFacets() {
        try {
            const f = await rpc('get_community_gig_facets', {}, signal);
            if (disposed) return;
            facets.years = [...new Set((f?.years || []).map(Number).filter(Boolean))].sort((a, b) => b - a);
            // value = venue_key (names aren't unique), label = "Name · City"
            const byKey = new Map();
            (f?.venues || []).forEach(v => {
                if (v?.key && !byKey.has(v.key)) {
                    byKey.set(v.key, { value: v.key, label: v.city ? `${v.name} · ${v.city}` : v.name });
                }
            });
            facets.venues = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
            refreshFilterOptions();
        } catch (err) {
            if (!disposed) console.warn('community: filter options failed', err);
        }
    }

    // Search box (debounced) and the filter button / strip, delegated from the pane
    el.addEventListener('input', (e) => {
        if (!e.target.matches('[data-role="search"]')) return;
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(() => { search = value.trim(); changed(); }, SEARCH_DEBOUNCE);
    }, { signal });

    el.addEventListener('click', (e) => {
        if (e.target.closest('[data-role="open-filters"]'))  openFilterDrawer();
        if (e.target.closest('[data-role="clear-filters"]')) clearAllFilters();
    }, { signal });

    // The drawer is injected once by initFilters(); a shared Community link may
    // land here before anything else has done that.
    if (!document.getElementById('filter-drawer')) initFilters();
    const detach = attachFilterSource({
        supports:   ['years', 'venue', 'festival'],
        years:      () => facets.years,
        venues:     () => facets.venues,
        venueLabel: (k) => facets.venues.find(v => v.value === k)?.label ?? k,
        onChange:   onFiltersChanged,
    });
    loadFacets();

    return {
        args,
        hasSearch:  () => !!search,
        hasFilters,
        /** The filtered gig total, shown in the summary strip once a filter is set. */
        setTotal(n) { total = Number.isFinite(Number(n)) ? Number(n) : null; renderChrome(); },
        /** Programmatic search (e.g. clicking an artist in a chart). */
        setSearch(text) {
            const input = $('[data-role="search"]');
            if (input) input.value = text;
            clearTimeout(timer);
            search = String(text || '').trim();
            changed();
        },
        dispose() {
            disposed = true;
            clearTimeout(timer);
            closeFilterDrawer();
            detach();                      // hands the drawer back to personal mode
        },
    };
}
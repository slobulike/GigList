/**
 * GigList — community-gigs.js
 * The Community → Gigs pane. Mirrors the personal Gigs tab (headline stats,
 * search, List / Calendar / Map) but over every journal.
 *
 * Contract (see the mode-switch performance notes):
 *   - Registered with registerCommunityPane('gigs', fn); community.js loads this
 *     module lazily the first time the tab is opened.
 *   - Renders only into the element it is given. No ids, so nothing can collide
 *     with the personal Gigs markup that lives in the same page.
 *   - Returns a disposer that tears down the Leaflet map, the search debounce,
 *     every listener and any request still in flight.
 *   - Data comes from the SECURITY DEFINER RPCs in community-gigs.sql and lives in
 *     the pane (state) or the Community-only cache in community-shared.js, never on window.*.
 *   - Doesn't touch the personal stores (journalData, venueLookup,
 *     window.viewGigDetails...), so a shared Community link works with no
 *     personal data loaded. Rows deliberately don't use [data-view-gig-key],
 *     which ui.js handles globally by opening a personal gig.
 *   - Search + filters: community-shared.js owns the search box, the filter
 *     drawer hookup and the cache (shared with the Stats pane). query.args() goes
 *     to every RPC, so the list, calendar, map and headline stats always
 *     describe the same set of gigs.
 */

import { escapeHtml } from './utils.js';
import { registerCommunityPane } from './community.js';
import { rpc, clearCommunityCache, fmt, plural, filterBarHtml, createCommunityQuery } from './community-shared.js';
import { openExpanded } from './community-expand.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PAGE_SIZE       = 50;
const MONTH_LIMIT     = 100;         // matches the RPC's cap

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PILL_ON  = ['bg-white', 'shadow-sm', 'text-indigo-600'];
const PILL_OFF = ['text-slate-400'];

// The Community-only cache lives in community-shared.js (shared with Stats).
/** For Phase 2 to call when leaving Community or after the user's data changes. */
export function clearGigsCache() { clearCommunityCache(); }

// ─── LEAFLET ──────────────────────────────────────────────────────────────────
// ui.js's loader is private, so this mirrors it (same URLs) and tolerates the
// personal map having already loaded, or started loading, Leaflet.

let _leafletPromise = null;

function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (_leafletPromise) return _leafletPromise;

    _leafletPromise = new Promise((resolve, reject) => {
        const fail = () => reject(new Error('Leaflet failed to load'));
        if (!document.querySelector('link[href*="leaflet.css"]')) {
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet/dist/leaflet.css';
            document.head.appendChild(link);
        }
        const existing = document.querySelector('script[src*="leaflet"]');
        const script = existing || Object.assign(document.createElement('script'), {
            src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
        });
        script.addEventListener('load',  () => (window.L ? resolve() : fail()), { once: true });
        script.addEventListener('error', fail, { once: true });
        if (!existing) document.head.appendChild(script);
    }).catch((err) => { _leafletPromise = null; throw err; });

    return _leafletPromise;
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

const TILE = 'bg-slate-50 p-4 rounded-2xl border border-slate-100 text-center';

const SHELL = `
<div class="space-y-4">
    ${filterBarHtml({ ariaLabel: 'Search community gigs by artist, venue or city', placeholder: 'Search artists, venues or cities...' })}

    <div class="grid grid-cols-3 gap-4">
        <div class="${TILE}">
            <p class="text-xs text-slate-500 uppercase tracking-widest font-bold">Gigs</p>
            <h3 data-stat="gigs" class="text-2xl font-black text-indigo-600">…</h3>
        </div>
        <div class="${TILE}">
            <p class="text-xs text-slate-500 uppercase tracking-widest font-bold">Venues</p>
            <h3 data-stat="venues" class="text-2xl font-black text-indigo-600">…</h3>
        </div>
        <div class="${TILE}">
            <p class="text-xs text-slate-500 uppercase tracking-widest font-bold">Artists</p>
            <h3 data-stat="artists" class="text-2xl font-black text-indigo-600">…</h3>
        </div>
    </div>

    <div class="flex items-center justify-between gap-4">
        <div class="flex bg-slate-100 p-1 rounded-2xl shadow-inner w-fit" aria-label="Gigs view">
            ${['list', 'calendar', 'map'].map(v => `
            <button type="button" data-view="${v}" aria-pressed="false"
                    class="px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">${v}</button>`).join('')}
        </div>
        <p data-role="count" aria-live="polite"
           class="text-[10px] font-black uppercase tracking-widest text-slate-400 text-right"></p>
    </div>

    <div data-pane="list"></div>
    <div data-pane="calendar" class="hidden space-y-8"></div>
    <div data-pane="map" class="hidden">
        <div class="relative w-full rounded-[2.5rem] overflow-hidden border-4 border-white shadow-2xl bg-white">
            <div data-role="map-canvas" style="height: 450px; width: 100%; z-index: 1;"></div>
            <button type="button" data-expand="map" aria-label="Expand map"
                    class="absolute top-4 right-4 z-[500] w-10 h-10 inline-flex items-center justify-center rounded-full bg-white text-slate-500 shadow-lg hover:text-indigo-600 active:scale-95 transition-all">
                <i data-lucide="maximize-2" class="w-4 h-4" aria-hidden="true"></i>
            </button>
        </div>
        <p data-role="map-note" class="text-[10px] text-slate-400 text-center mt-3"></p>
    </div>

    <p data-role="foot" class="text-[10px] text-slate-400 text-center pt-2"></p>
</div>`;

const skeleton = () => `
    <div class="animate-pulse space-y-3" aria-hidden="true">
        ${'<div class="h-14 bg-slate-100 rounded-2xl"></div>'.repeat(6)}
    </div>`;

const emptyHtml = (title, body) => `
    <div class="text-center py-16 space-y-3">
        <div class="text-5xl" aria-hidden="true">🎟️</div>
        <p class="text-sm font-black text-slate-700">${escapeHtml(title)}</p>
        <p class="text-[11px] text-slate-400 leading-relaxed max-w-xs mx-auto">${escapeHtml(body)}</p>
    </div>`;

const errorHtml = (what, view) => `
    <div class="text-center py-12 space-y-3">
        <p class="text-sm text-slate-500">Couldn't load ${escapeHtml(what)}.</p>
        <button type="button" data-retry="${escapeHtml(view)}"
                class="bg-slate-100 text-slate-700 text-xs font-black px-4 py-2 rounded-full hover:bg-slate-200 active:scale-95 transition-all">
            Try again
        </button>
    </div>`;

// ─── PANE ─────────────────────────────────────────────────────────────────────

export function renderGigsPane(el, ctx = {}) {
    let disposed = false;
    const ac = new AbortController();
    let map = null;
    let markerLayer = null;
    let mapBounds = [];
    let lastVenues = [];
    let lastUnmapped = 0;
    let expandedMap = null;           // expanded-map overlay handle (community-expand.js)
    let bigMap = null;                // its Leaflet instance

    const state = {
        view:   'list',
        sort:   'date_desc',
        rows:   [],
        total:  0,
    };
    const loaded = { list: false, calendar: false, map: false };
    const seq    = { list: 0, calendar: 0, map: 0, month: 0, stats: 0 };

    el.innerHTML = SHELL;
    const $    = (sel) => el.querySelector(sel);
    const pane = (name) => el.querySelector(`[data-pane="${name}"]`);
    const alive = (view, id) => !disposed && id === seq[view];
    const query = createCommunityQuery(el, { signal: ac.signal, onChange: onQueryChange });
    const icons = () => { if (window.lucide) lucide.createIcons(); };

    const emptyFor = () => (query.hasSearch() || query.hasFilters())
        ? emptyHtml('No gigs match', 'Try a different search, or clear the filters.')
        : emptyHtml('No gigs yet', 'Gigs from all profiles will appear here.');

       const users = ctx.summary?.total_users;
       if (users) {
           $('[data-role="foot"]').textContent =
               `From ${plural(users, 'GigList user', 'GigList users')}. Gigs up to today only.`;  // stats keeps its festivals sentence
       }

    // ── headline stats (follow search + filters, like every other view) ──────
    async function loadStats() {
        const id = ++seq.stats;
        const tiles = el.querySelectorAll('[data-stat]');
        tiles.forEach(n => n.classList.add('opacity-40'));
        try {
            const s = await rpc('get_community_gig_stats', query.args(), ac.signal);
            if (!alive('stats', id)) return;
            ['gigs', 'venues', 'artists'].forEach(k => {
                const node = $(`[data-stat="${k}"]`);
                if (node) node.textContent = fmt(s?.[k]);
            });
            query.setTotal(s?.gigs);
        } catch (err) {
            if (!alive('stats', id)) return;
            console.warn('community gigs: stats failed', err);
            tiles.forEach(n => { n.textContent = '–'; });
            query.setTotal(null);
        }
        if (!alive('stats', id)) return;
        tiles.forEach(n => n.classList.remove('opacity-40'));
    }

    // Each view keeps its own count line; only the visible view's is shown.
    const counts = { list: '', calendar: '', map: '' };
    const showCount = () => { const n = $('[data-role="count"]'); if (n) n.textContent = counts[state.view] || ''; };
    const setCount = (view, text) => { counts[view] = text; showCount(); };

    // ── list ─────────────────────────────────────────────────────────────────
    async function loadList(reset) {
        const id = ++seq.list;
        if (reset) {
            state.rows = [];
            state.total = 0;
            pane('list').innerHTML = skeleton();
        }
        try {
            const res = await rpc('get_community_gigs', {
                ...query.args(), p_sort: state.sort,
                p_limit: PAGE_SIZE, p_offset: state.rows.length,
            }, ac.signal);
            if (!alive('list', id)) return;
            state.rows  = state.rows.concat(res?.rows || []);
            state.total = res?.total || 0;
            loaded.list = true;
            renderList();
        } catch (err) {
            if (!alive('list', id)) return;
            console.warn('community gigs: list failed', err);
            pane('list').innerHTML = errorHtml('gigs', 'list');
        }
    }

    function sortArrow(col) {
        if (!state.sort.startsWith(col + '_')) return '<span class="opacity-20 ml-1 text-[8px]">↕</span>';
        return `<span class="ml-1 text-indigo-600">${state.sort.endsWith('_asc') ? '↑' : '↓'}</span>`;
    }
    const ariaSort = (col) => !state.sort.startsWith(col + '_') ? 'none'
        : (state.sort.endsWith('_asc') ? 'ascending' : 'descending');

    function renderList() {
        const host = pane('list');
        setCount('list', state.total ? plural(state.total, 'gig', 'gigs') : '');

        if (!state.rows.length) {
            host.innerHTML = emptyFor();
            return;
        }

        const th = (col, label, cls) => `
            <th aria-sort="${ariaSort(col)}" class="${cls} p-0">
                <button type="button" data-sort="${col}"
                        class="w-full text-left p-4 hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                    ${label}${sortArrow(col)}
                </button>
            </th>`;

        const rows = state.rows.map(g => `
            <tr class="hover:bg-indigo-50/30 transition-all">
                <td class="p-4 text-xs font-medium text-slate-500 font-mono tracking-tighter">${escapeHtml(g.date)}</td>
                <td class="p-4 leading-tight">
                    <div class="flex flex-col gap-1">
                        <span class="text-sm font-bold text-slate-900">${escapeHtml(g.band || 'Unknown artist')}</span>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="inline-flex items-center gap-1 text-[10px] font-black text-slate-500"
                                  title="GigList users who were there">
                                <i data-lucide="users" class="w-3 h-3" aria-hidden="true"></i>${fmt(g.attendees)}
                            </span>
                            ${g.festival ? '<span class="text-[9px] bg-amber-500/10 text-amber-600 font-black uppercase px-2 py-0.5 rounded-full">Festival</span>' : ''}
                        </div>
                    </div>
                </td>
                <td class="p-4 text-xs text-slate-600 font-medium">
                    <div class="flex flex-col">
                        <span>${escapeHtml(g.venue || '')}</span>
                        <span class="text-[10px] text-slate-400 font-normal uppercase">${escapeHtml(g.city || '')}</span>
                    </div>
                </td>
            </tr>`).join('');

        host.innerHTML = `
            <div class="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden font-sans">
                <table class="w-full text-left table-fixed">
                    <thead><tr class="bg-slate-50/50">
                        ${th('date', 'Date', 'w-24')}
                        ${th('artist', 'Artist', 'w-40')}
                        ${th('venue', 'Venue', '')}
                    </tr></thead>
                    <tbody class="divide-y divide-slate-50">${rows}</tbody>
                </table>
            </div>
            ${state.rows.length < state.total ? `
            <div class="text-center pt-4">
                <button type="button" data-more
                        class="bg-slate-100 text-slate-700 text-xs font-black px-5 py-2.5 rounded-full hover:bg-slate-200 active:scale-95 transition-all">
                    Show more (${fmt(state.total - state.rows.length)} left)
                </button>
            </div>` : ''}`;
        icons();
    }

    // ── calendar ─────────────────────────────────────────────────────────────
    async function loadCalendar() {
        const id = ++seq.calendar;
        pane('calendar').innerHTML = skeleton();
        try {
            const years = await rpc('get_community_gig_calendar', query.args(), ac.signal);
            if (!alive('calendar', id)) return;
            loaded.calendar = true;
            renderCalendar(years || []);
        } catch (err) {
            if (!alive('calendar', id)) return;
            console.warn('community gigs: calendar failed', err);
            pane('calendar').innerHTML = errorHtml('the calendar', 'calendar');
        }
    }

    function yearCard(y) {
        const yr = escapeHtml(y.year);
        const byMonth = new Map((y.months || []).map(m => [m.month, m.gigs]));
        const busiest = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
        const maxCount = Math.max(...byMonth.values(), 1);

        const cells = MONTHS.map((name, i) => {
            const n = byMonth.get(i + 1) || 0;
            return `
            <button type="button" ${n ? `data-cal-month="${yr}-${i + 1}"` : 'disabled aria-disabled="true"'}
                    aria-label="${name} ${yr}: ${plural(n, 'gig', 'gigs')}"
                    class="flex flex-col items-center justify-center h-16 rounded-2xl border transition-all ${n
                        ? 'bg-indigo-50/50 border-indigo-100 cursor-pointer hover:border-indigo-400 hover:shadow-md active:scale-95'
                        : 'bg-transparent border-slate-50 opacity-10 select-none'}">
                <span class="text-[10px] font-black ${n ? 'text-indigo-900' : 'text-slate-400'} uppercase tracking-tighter leading-none mb-1.5">${name.toUpperCase()}</span>
                <span class="text-[10px] font-black text-indigo-500 leading-none">${n ? fmt(n) : ''}</span>
            </button>`;
        }).join('');

        const bars = [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([m, c]) => `
            <div class="flex items-center gap-2 mb-1.5">
                <span class="text-[9px] text-white/50 w-6 flex-shrink-0">${MONTHS[m - 1]}</span>
                <div class="flex-1 bg-white/10 rounded h-1.5 overflow-hidden">
                    <div class="h-full bg-emerald-300 rounded" style="width:${Math.round((c / maxCount) * 100)}%"></div>
                </div>
                <span class="text-[9px] text-white font-bold w-8 text-right">${fmt(c)}</span>
            </div>`).join('');

        const stat = (label, value, sub) => `
            <div class="bg-white/10 rounded-xl px-3 py-2.5">
                <p class="text-[8px] text-indigo-300 font-extrabold uppercase tracking-wider mb-1">${label}</p>
                <p class="text-2xl font-black text-white leading-none">${value}</p>
                ${sub ? `<p class="text-[9px] text-indigo-200 font-semibold mt-1">${sub}</p>` : ''}
            </div>`;

        return `
        <section data-cal-year="${yr}" aria-labelledby="cg-year-${yr}"
                 class="relative bg-white rounded-[2.5rem] p-8 mb-12 shadow-sm border border-slate-100">
            <div data-role="grid">
                <div class="flex justify-between items-center mb-8">
                    <h3 id="cg-year-${yr}" class="text-5xl font-black text-slate-900 tracking-tighter italic">${yr}</h3>
                    <button type="button" data-cal-panel="${yr}:summary"
                            class="bg-amber-400 text-[10px] font-black px-5 py-2.5 rounded-full shadow-sm hover:scale-105 transition-all uppercase tracking-widest active:scale-95">
                        ✨ View Summary
                    </button>
                </div>
                <div class="grid grid-cols-3 sm:grid-cols-4 gap-3">${cells}</div>
            </div>

            <div data-role="summary" class="hidden bg-indigo-600 text-white rounded-2xl p-5 space-y-2">
                <div class="flex justify-between items-center mb-1">
                    <div>
                        <p class="text-[9px] font-black text-indigo-300 uppercase tracking-widest">${yr}</p>
                        <h3 class="text-xl font-black italic uppercase tracking-tighter leading-none">Community Year</h3>
                    </div>
                    <button type="button" data-cal-panel="${yr}:grid" aria-label="Close ${yr} summary"
                            class="bg-white/10 p-2 rounded-xl hover:bg-white/20 transition-colors">
                        <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
                    </button>
                </div>
                ${y.top_artist ? `
                <div class="bg-white/10 rounded-2xl p-3.5">
                    <p class="text-[8px] text-indigo-300 font-extrabold uppercase tracking-wider mb-1">Most-seen artist</p>
                    <p class="text-xl font-black leading-tight">${escapeHtml(y.top_artist)}</p>
                    <p class="text-[10px] text-indigo-200 font-semibold mt-1">${plural(y.top_artist_count, 'gig', 'gigs')} this year</p>
                </div>` : ''}
                <div class="grid grid-cols-2 gap-1.5">
                    ${stat('Total gigs', fmt(y.gigs))}
                    ${stat('Artists', fmt(y.artists))}
                    ${stat('Venues', fmt(y.venues))}
                    ${busiest ? stat('Busiest month', MONTHS[busiest[0] - 1], plural(busiest[1], 'gig', 'gigs')) : ''}
                </div>
                ${bars ? `<div class="bg-white/10 rounded-xl px-3 py-2.5">
                    <p class="text-[8px] text-indigo-300 font-extrabold uppercase tracking-wider mb-2">Gigs by month</p>${bars}</div>` : ''}
            </div>

            <div data-role="month" class="hidden bg-slate-900 text-white rounded-2xl p-6">
                <div class="flex justify-between items-center mb-6">
                    <h3 data-role="month-title" class="text-2xl font-black italic uppercase tracking-tighter text-amber-400">Month</h3>
                    <button type="button" data-cal-panel="${yr}:grid" aria-label="Close month detail"
                            class="bg-white/10 p-2.5 rounded-xl hover:bg-white/20 transition-colors">
                        <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
                    </button>
                </div>
                <div data-role="month-list" class="space-y-4" role="list"></div>
            </div>
        </section>`;
    }

    function renderCalendar(years) {
        const host = pane('calendar');
        if (!years.length) {
            setCount('calendar', '');
            host.innerHTML = emptyFor();
            return;
        }
        const total = years.reduce((n, y) => n + (y.gigs || 0), 0);
        setCount('calendar', `${plural(total, 'gig', 'gigs')} · ${plural(years.length, 'year', 'years')}`);
        host.innerHTML = years.map(yearCard).join('');
        icons();
    }

    function showCalPanel(yearSection, which) {
        ['grid', 'summary', 'month'].forEach(p => {
            yearSection.querySelector(`[data-role="${p}"]`)?.classList.toggle('hidden', p !== which);
        });
        if (which !== 'grid') yearSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        icons();
    }

    async function openMonth(year, month) {
        const section = el.querySelector(`[data-cal-year="${CSS.escape(String(year))}"]`);
        if (!section) return;
        const id = ++seq.month;
        section.querySelector('[data-role="month-title"]').textContent = `${MONTHS[month - 1]} ${year}`;
        const list = section.querySelector('[data-role="month-list"]');
        list.innerHTML = '<p class="text-sm text-white/50">Loading…</p>';
        showCalPanel(section, 'month');
        try {
            const res = await rpc('get_community_gigs', {
                ...query.args(), p_year: year, p_month: month,
                p_sort: 'date_asc', p_limit: MONTH_LIMIT, p_offset: 0,
            }, ac.signal);
            if (!alive('month', id)) return;
            const rows = res?.rows || [];
            list.innerHTML = rows.map(g => `
                <div role="listitem" class="border-b border-white/10 pb-3">
                    <div class="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-1">${escapeHtml(g.date)}</div>
                    <div class="text-lg font-bold">${escapeHtml(g.band || 'Unknown artist')}</div>
                    <div class="flex items-center justify-between gap-3 mt-1">
                        <span class="text-xs opacity-50 uppercase tracking-[0.15em]">${escapeHtml([g.venue, g.city].filter(Boolean).join(' · '))}</span>
                        <span class="inline-flex items-center gap-1 text-[10px] font-black text-white/60 flex-shrink-0" title="GigList users who were there">
                            <i data-lucide="users" class="w-3 h-3" aria-hidden="true"></i>${fmt(g.attendees)}
                        </span>
                    </div>
                </div>`).join('')
                + ((res?.total || 0) > rows.length
                    ? `<p class="text-[11px] text-white/50 pt-1">Showing the first ${fmt(rows.length)} of ${fmt(res.total)}. Use search or filters to narrow it down.</p>` : '');
            icons();
        } catch (err) {
            if (!alive('month', id)) return;
            console.warn('community gigs: month failed', err);
            list.innerHTML = '<p class="text-sm text-white/60">Couldn\'t load this month. Close it and try again.</p>';
        }
    }

    // ── map ──────────────────────────────────────────────────────────────────
    async function loadMap() {
        const id = ++seq.map;
        const note = $('[data-role="map-note"]');
        note.textContent = 'Loading map…';
        try {
            const [res] = await Promise.all([
                rpc('get_community_gig_venues', query.args(), ac.signal),
                ensureLeaflet(),
            ]);
            if (!alive('map', id)) return;
            loaded.map = true;
            drawMap(res || {});
        } catch (err) {
            if (!alive('map', id)) return;
            console.warn('community gigs: map failed', err);
            note.innerHTML = errorHtml('the map', 'map');
        }
    }

    // One pin per venue, sized by gig count, popup of the latest gigs. The card map
    // and the expanded map share this; `big` only widens the popup.
    function plotVenues(layer, venues, big) {
        const L = window.L;
        layer.clearLayers();
        const bounds = [];
        venues.forEach(v => {
            const lat = Number(v.lat), lng = Number(v.lng);
            if (!isFinite(lat) || !isFinite(lng)) return;
            const shown = v.recent || [];
            const recent = shown.map(r => `
                <div class="p-2 border-b border-slate-100 last:border-0 mb-1">
                    <p class="text-[10px] font-black text-indigo-500 uppercase leading-none">${escapeHtml(r.date)}</p>
                    <p class="text-[12px] font-bold text-slate-800 leading-tight">${escapeHtml(r.band || '')}</p>
                </div>`).join('');
            const more = v.gigs > shown.length
                ? `<p class="text-[10px] text-slate-400 text-center">+ ${fmt(v.gigs - shown.length)} earlier</p>` : '';

            L.circleMarker([lat, lng], {
                radius: Math.min(5 + Math.sqrt(v.gigs || 1) * 2.2, 22),
                fillColor: '#4f46e5', color: '#fff', weight: 2, fillOpacity: 0.9,
            }).bindPopup(`
                <div class="p-1 ${big ? 'max-h-64' : 'max-h-48'} overflow-y-auto min-w-[180px]">
                    <h4 class="text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">
                        ${escapeHtml(v.name || '')}${v.city ? ' · ' + escapeHtml(v.city) : ''}
                    </h4>
                    ${recent}${more}
                    <div class="pt-2 text-center">
                        <span class="bg-indigo-50 text-indigo-600 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                            ${plural(v.gigs, 'gig', 'gigs')}
                        </span>
                    </div>
                </div>`, { maxWidth: big ? 320 : 250, className: 'gig-map-popup' }).addTo(layer);
            bounds.push([lat, lng]);
        });
        return bounds;
    }

    function drawMap(res) {
        const L = window.L;
        const venues = res.venues || [];
        lastVenues = venues;
        lastUnmapped = res.unmapped || 0;

        if (!map) {
            map = L.map($('[data-role="map-canvas"]'), {
                zoomControl: false, minZoom: 1, worldCopyJump: true, preferCanvas: true,
            });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors', subdomains: 'abc',
            }).addTo(map);
            markerLayer = L.layerGroup().addTo(map);
        }

        const bounds = plotVenues(markerLayer, venues, false);

        mapBounds = bounds;
        map.invalidateSize();
        if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
        else map.setView([20, 0], 2);

        setCount('map', plural(res.total || 0, 'venue', 'venues'));
        $('[data-role="map-note"]').textContent = res.unmapped
            ? `${plural(res.unmapped, 'venue has', 'venues have')} no map location yet.` : '';
    }

    // Expanded map: the same pins in a large overlay, like the personal Explorer
    // (ui.js openMapModal). Its own Leaflet instance, removed when it closes.
    function expandMap() {
        if (!loaded.map || !window.L) return;
        expandedMap?.close();
        expandedMap = openExpanded({
            title: 'Community map',
            subtitle: plural(lastVenues.length, 'venue', 'venues')
                + (lastUnmapped ? ` · ${plural(lastUnmapped, 'venue has', 'venues have')} no map location yet` : ''),
            onOpen(body) {
                const L = window.L;
                body.innerHTML = '<div data-role="big-map" class="rounded-2xl overflow-hidden border border-slate-100" style="height:70vh; width:100%; position:relative; z-index:1;"></div>';
                bigMap = L.map(body.querySelector('[data-role="big-map"]'), {
                    zoomControl: false, minZoom: 1, worldCopyJump: true, preferCanvas: true,
                });
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors', subdomains: 'abc',
                }).addTo(bigMap);
                const layer = L.layerGroup().addTo(bigMap);
                const bounds = plotVenues(layer, lastVenues, true);
                // Let the overlay lay out before measuring, then fit
                setTimeout(() => {
                    if (!bigMap) return;
                    bigMap.invalidateSize();
                    if (bounds.length) bigMap.fitBounds(bounds, { padding: [80, 80], maxZoom: 9 });
                    else bigMap.setView([20, 0], 2);
                }, 50);
            },
            onClose() {
                try { bigMap?.remove(); } catch (_) { /* already gone */ }
                bigMap = null;
                expandedMap = null;
            },
        });
    }

    // ── view switching / search ──────────────────────────────────────────────
    function ensureView() {
        if (loaded[state.view]) {
            // Count line belongs to whichever view is showing
            if (state.view === 'list') renderList();
            if (state.view === 'map' && map) {
                // Drawn while hidden (or the window resized): re-measure and refit
                map.invalidateSize();
                if (mapBounds.length) map.fitBounds(mapBounds, { padding: [40, 40], maxZoom: 7 });
            }
            return;
        }
        if (state.view === 'list')     loadList(true);
        if (state.view === 'calendar') loadCalendar();
        if (state.view === 'map')      loadMap();
    }

    function setView(view) {
        state.view = view;
        ['list', 'calendar', 'map'].forEach(v => pane(v).classList.toggle('hidden', v !== view));
        el.querySelectorAll('[data-view]').forEach(btn => {
            const on = btn.dataset.view === view;
            btn.classList.remove(...PILL_ON, ...PILL_OFF);
            btn.classList.add(...(on ? PILL_ON : PILL_OFF));
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        showCount();
        ensureView();
    }

    // Search text and drawer filters both end up here (community-shared.js has
    // already debounced and de-duplicated): drop every view's data, refresh the
    // stats and reload the visible view.
    function onQueryChange() {
        expandedMap?.close();             // its pins are about to be stale
        loaded.list = loaded.calendar = loaded.map = false;
        counts.list = counts.calendar = counts.map = '';
        showCount();
        loadStats();
        ensureView();
    }

    // ── events (one delegated set, removed together by the abort signal) ─────
    const opts = { signal: ac.signal };

    el.addEventListener('click', (e) => {
        const t = e.target;

        if (t.closest('[data-expand="map"]')) { expandMap(); return; }

        const viewBtn = t.closest('[data-view]');
        if (viewBtn) { setView(viewBtn.dataset.view); return; }

        const sortBtn = t.closest('[data-sort]');
        if (sortBtn) {
            const col = sortBtn.dataset.sort;
            state.sort = state.sort === `${col}_asc` ? `${col}_desc`
                       : state.sort === `${col}_desc` ? `${col}_asc`
                       : (col === 'date' ? 'date_desc' : `${col}_asc`);
            loadList(true);
            return;
        }

        if (t.closest('[data-more]')) { loadList(false); return; }

        const retry = t.closest('[data-retry]');
        if (retry) { loaded[retry.dataset.retry] = false; ensureView(); return; }

        const month = t.closest('[data-cal-month]');
        if (month) {
            const [y, m] = month.dataset.calMonth.split('-').map(Number);
            openMonth(y, m);
            return;
        }

        const panel = t.closest('[data-cal-panel]');
        if (panel) {
            const [year, which] = panel.dataset.calPanel.split(':');
            const section = el.querySelector(`[data-cal-year="${CSS.escape(year)}"]`);
            if (section) showCalPanel(section, which);
        }
    }, opts);

    // ── go ───────────────────────────────────────────────────────────────────
    loadStats();
    setView('list');
    icons();

    return function dispose() {
        disposed = true;
        expandedMap?.close();             // overlay lives on <body>, outside this pane
        query.dispose();                  // closes the drawer and hands it back to personal mode
        ac.abort();                       // removes every listener, cancels in-flight RPCs
        if (map) {
            try { map.remove(); } catch (_) { /* already gone */ }
            map = null;
            markerLayer = null;
        }
    };
}

registerCommunityPane('gigs', renderGigsPane);
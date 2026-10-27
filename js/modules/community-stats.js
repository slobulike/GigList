/**
 * GigList — community-stats.js
 * The Community → Stats pane. Mirrors the personal Stats tab's look (cards of
 * Chart.js charts plus a list) but over every public journal, and follows the
 * same search + filter drawer as Community → Gigs (community-shared.js).
 *
 * Cards:
 *   - Gigs per year        (click a bar → year filter, as in personal Stats)
 *   - When we go           (gigs by month of the year, and by weekday)
 *   - Top artists          (most-seen headliners; click → search that artist)
 *   - Trending             (most-seen artists over the last 12 months)
 *   - Busiest venues       (click → venue filter)
 *   - Busiest cities       (click → search that city)
 *   - Hot list             (the ten most recently seen artists; click → search)
 *   - Most-shared shows    (gigs with the most GigList users there; counts only)
 *
 * Same pane contract as community-gigs.js: registered with
 * registerCommunityPane('stats', fn), renders only into the element it's given
 * (no ids), returns a disposer (charts, listeners, in-flight requests), data
 * comes from a SECURITY DEFINER RPC (get_community_gig_charts) and never touches
 * personal stores or window data globals.
 *
 * Options a pane can offer back to the page: if ctx.openGigs(search) exists,
 * list rows link through to Community → Gigs filtered to that artist.
 */

import { escapeHtml } from './utils.js';
import { registerCommunityPane } from './community.js';
import {
    rpc, fmt, plural, ensureChart, filterBarHtml, createCommunityQuery,
} from './community-shared.js';
import { setYearFilter, setFilters } from './filters.js';

// Same palette as the personal charts
const COLORS = { year: '#6366f1', artists: '#1D3557', venues: '#8b5cf6', cities: '#06b6d4', months: '#10b981', weekdays: '#f59e0b' };

const CARD = 'relative bg-white rounded-[2rem] p-6 border border-slate-100 shadow-sm';
const CARD_TITLE = 'text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4';

const SHELL = `
<div class="space-y-4">
    ${filterBarHtml({ ariaLabel: 'Search community stats by artist, venue or city', placeholder: 'Search artists, venues or cities...' })}

    <div data-role="error" class="hidden text-center py-8 space-y-3">
        <p class="text-sm text-slate-500">Couldn't load the stats.</p>
        <button type="button" data-retry
                class="bg-slate-100 text-slate-700 text-xs font-black px-4 py-2 rounded-full hover:bg-slate-200 active:scale-95 transition-all">
            Try again
        </button>
    </div>

    <div data-role="cards" class="space-y-4">
        <section class="${CARD}" aria-labelledby="cs-years">
            <h3 id="cs-years" class="${CARD_TITLE}">Gigs per year</h3>
            <div data-card="years" class="relative h-48"><canvas></canvas>${placeholder()}</div>
        </section>

        <div class="grid sm:grid-cols-2 gap-4">
            <section class="${CARD}" aria-labelledby="cs-months">
                <h3 id="cs-months" class="${CARD_TITLE}">Gigs by month</h3>
                <div data-card="months" class="relative h-44"><canvas></canvas>${placeholder()}</div>
            </section>
            <section class="${CARD}" aria-labelledby="cs-weekdays">
                <h3 id="cs-weekdays" class="${CARD_TITLE}">Gigs by weekday</h3>
                <div data-card="weekdays" class="relative h-44"><canvas></canvas>${placeholder()}</div>
            </section>
        </div>

        <section class="${CARD}" aria-labelledby="cs-artists">
            <h3 id="cs-artists" class="${CARD_TITLE}">Top artists</h3>
            <div data-card="artists" class="relative h-72"><canvas></canvas>${placeholder()}</div>
        </section>

        <section class="${CARD}" aria-labelledby="cs-trending">
            <h3 id="cs-trending" class="${CARD_TITLE}">Trending · last 12 months</h3>
            <div data-card="trending" class="relative min-h-[6rem]"></div>
        </section>

        <section class="${CARD}" aria-labelledby="cs-venues">
            <h3 id="cs-venues" class="${CARD_TITLE}">Busiest venues</h3>
            <div data-card="venues" class="relative h-72"><canvas></canvas>${placeholder()}</div>
        </section>

        <section class="${CARD}" aria-labelledby="cs-cities">
            <h3 id="cs-cities" class="${CARD_TITLE}">Busiest cities</h3>
            <div data-card="cities" class="relative h-72"><canvas></canvas>${placeholder()}</div>
        </section>

        <section class="${CARD}" aria-labelledby="cs-recent">
            <h3 id="cs-recent" class="${CARD_TITLE}">Hot list · latest artists seen</h3>
            <div data-card="recent" class="relative min-h-[6rem]"></div>
        </section>

        <section class="${CARD}" aria-labelledby="cs-shared">
            <h3 id="cs-shared" class="${CARD_TITLE}">Most-shared shows</h3>
            <div data-card="shared" class="relative min-h-[6rem]"></div>
        </section>
    </div>

    <p data-role="foot" class="text-[10px] text-slate-400 text-center pt-2"></p>
</div>`;

// "Nothing to chart" overlay, same idea as setChartEmptyState in charts.js
function placeholder() {
    return `<div data-empty class="hidden absolute inset-0 flex items-center justify-center text-xs font-bold text-slate-300 uppercase tracking-widest bg-white/80 rounded-2xl px-4 text-center pointer-events-none"></div>`;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function renderStatsPane(el, ctx = {}) {
    let disposed = false;
    let seq = 0;
    const ac = new AbortController();
    const charts = {};                       // name → Chart instance

    el.innerHTML = SHELL;
    const $ = (sel) => el.querySelector(sel);
    const card = (name) => el.querySelector(`[data-card="${name}"]`);
    const icons = () => { if (window.lucide) lucide.createIcons(); };

    const query = createCommunityQuery(el, { signal: ac.signal, onChange: load });

    const publicUsers = ctx.summary?.public_users;
    if (publicUsers) {
        $('[data-role="foot"]').textContent =
            `From ${plural(publicUsers, 'public profile', 'public profiles')}. Gigs up to today only. Festivals count towards years and venues, not artists.`;
    }

    const emptyText = () => (query.hasSearch() || query.hasFilters())
        ? 'No gigs match your search'
        : 'No gigs yet';

    // Shows/hides the overlay on a chart card; returns true when empty
    function setEmpty(name, isEmpty) {
        const node = card(name).querySelector('[data-empty]');
        if (node) {
            node.textContent = emptyText();
            node.classList.toggle('hidden', !isEmpty);
        }
        card(name).querySelector('canvas')?.classList.toggle('invisible', isEmpty);
        if (isEmpty && charts[name]) { charts[name].destroy(); delete charts[name]; }
        return isEmpty;
    }

    function build(name, config) {
        charts[name]?.destroy();
        charts[name] = new window.Chart(card(name).querySelector('canvas'), config);
    }

    // ── charts ───────────────────────────────────────────────────────────────
    function renderYears(rows) {
        if (setEmpty('years', !rows.length)) return;
        // Fill the gaps between the first year and this year, like the personal chart
        const byYear = new Map(rows.map(r => [Number(r.year), r.gigs]));
        const start = Math.min(...byYear.keys());
        const end = Math.max(new Date().getFullYear(), ...byYear.keys());
        const labels = [], data = [];
        for (let y = start; y <= end; y++) { labels.push(String(y)); data.push(byYear.get(y) || 0); }

        build('years', {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Gigs', data, backgroundColor: COLORS.year, borderRadius: 4 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: true } },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { grid: { display: false }, ticks: { font: { size: 8 } } },
                },
                onClick: (_evt, els) => {
                    if (els.length) setYearFilter(parseInt(labels[els[0].index], 10));
                },
            },
        });
    }

    // Draws the gig count at the end of each bar (scoped to the chart instance)
    const countLabels = (values) => ({
        id: 'countLabel',
        afterDatasetsDraw(chart) {
            const { ctx: c } = chart;
            const meta = chart.getDatasetMeta(0);
            c.save();
            c.font = '700 11px sans-serif';
            c.fillStyle = '#475569';
            c.textAlign = 'left';
            c.textBaseline = 'middle';
            values.forEach((v, i) => { const b = meta.data[i]; if (b) c.fillText(fmt(v), b.x + 6, b.y); });
            c.restore();
        },
    });

    function horizontalBar(name, labels, values, color, extra = {}) {
        build(name, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Gigs', data: values, backgroundColor: color, borderRadius: 4 }] },
            plugins: [countLabels(values)],
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                layout: { padding: { right: 28 } },
                plugins: { legend: { display: false }, tooltip: { enabled: true, ...(extra.tooltip || {}) } },
                scales: {
                    x: { display: false },
                    y: {
                        grid: { display: false }, border: { display: false },
                        ticks: {
                            crossAlign: 'far', color: '#64748b', font: { weight: '800', size: 12 },
                            callback(v) { return truncate(this.getLabelForValue(v), 24); },
                        },
                    },
                },
                onClick: (_evt, els) => { if (els.length) extra.onClick?.(els[0].index); },
            },
        });
    }

    function renderArtists(rows) {
        if (setEmpty('artists', !rows.length)) return;
        horizontalBar('artists', rows.map(r => r.band), rows.map(r => r.gigs), COLORS.artists, {
            tooltip: { callbacks: { afterLabel: (i) => `${fmt(rows[i.dataIndex].attendees)} attendances` } },
            onClick: (i) => query.setSearch(rows[i].band),
        });
    }

    function renderVenues(rows) {
        if (setEmpty('venues', !rows.length)) return;
        horizontalBar('venues', rows.map(r => r.name), rows.map(r => r.gigs), COLORS.venues, {
            tooltip: { callbacks: { afterLabel: (i) => rows[i.dataIndex].city || '' } },
            onClick: (i) => setFilters({ venue: rows[i].key }),
        });
    }

    const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAY_LABELS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    // Plain vertical bars over a fixed set of labels (no click-through: there's no
    // month or weekday filter to hand off to)
    function fixedBars(name, labels, byIndex, color) {
        const data = labels.map((_, i) => byIndex.get(i + 1) || 0);
        if (setEmpty(name, data.every(n => n === 0))) return;
        build(name, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Gigs', data, backgroundColor: color, borderRadius: 4 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: true } },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } },
                    x: { grid: { display: false }, ticks: { font: { size: 9 } } },
                },
            },
        });
    }

    function renderMonths(rows)   { fixedBars('months',   MONTH_LABELS, new Map(rows.map(r => [Number(r.month), r.gigs])), COLORS.months); }
    function renderWeekdays(rows) { fixedBars('weekdays', DAY_LABELS,   new Map(rows.map(r => [Number(r.day),   r.gigs])), COLORS.weekdays); }

    function renderCities(rows) {
        if (setEmpty('cities', !rows.length)) return;
        horizontalBar('cities', rows.map(r => r.city), rows.map(r => r.gigs), COLORS.cities, {
            tooltip: { callbacks: { afterLabel: (i) => rows[i.dataIndex].country || '' } },
            onClick: (i) => query.setSearch(rows[i].city),     // search already covers city
        });
    }

    // Ranked list with proportional bars, like the personal Hot List
    function renderTrending(rows) {
        const host = card('trending');
        if (!rows.length) {
            host.innerHTML = `<p class="text-xs text-slate-400 text-center py-6">${escapeHtml(emptyText())}</p>`;
            return;
        }
        const max = rows[0].gigs || 1;
        host.innerHTML = rows.map((r, i) => `
            <button type="button" data-band="${escapeHtml(r.band)}"
                    class="w-full text-left flex items-center gap-3 py-2 px-1 hover:bg-slate-50 rounded-xl transition-colors">
                <span class="text-xs font-black text-slate-300 w-5 text-right flex-shrink-0">${i + 1}</span>
                <span class="flex-1 min-w-0">
                    <span class="flex items-center justify-between gap-2">
                        <span class="text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                        <span class="text-xs font-black text-indigo-500 flex-shrink-0">${fmt(r.gigs)}</span>
                    </span>
                    <span class="block w-full bg-slate-100 rounded-full h-1.5 mt-1">
                        <span class="block bg-indigo-500 h-1.5 rounded-full" style="width:${Math.round((r.gigs / max) * 100)}%"></span>
                    </span>
                </span>
            </button>`).join('');
    }

    // Gigs where several GigList users were in the room. Counts only, no names.
    function renderShared(rows) {
        const host = card('shared');
        if (!rows.length) {
            host.innerHTML = `<p class="text-xs text-slate-400 text-center py-6">${escapeHtml(
                (query.hasSearch() || query.hasFilters()) ? 'No shared shows match your search' : 'No shows with more than one GigList user yet')}</p>`;
            return;
        }
        host.innerHTML = rows.map(r => `
            <button type="button" data-band="${escapeHtml(r.band)}"
                    class="w-full text-left flex items-center gap-3 py-2 px-1 hover:bg-slate-50 rounded-xl transition-colors">
                <span class="inline-flex items-center gap-1 text-sm font-black text-indigo-600 w-12 flex-shrink-0" title="GigList users who were there">
                    <i data-lucide="users" class="w-3.5 h-3.5" aria-hidden="true"></i>${fmt(r.attendees)}
                </span>
                <span class="flex-1 min-w-0">
                    <span class="flex items-center gap-2">
                        <span class="text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                        ${r.festival ? '<span class="text-[9px] bg-amber-500/10 text-amber-600 font-black uppercase px-2 py-0.5 rounded-full flex-shrink-0">Festival</span>' : ''}
                    </span>
                    <span class="block text-[10px] text-slate-400 uppercase truncate">${escapeHtml([r.date, r.venue, r.city].filter(Boolean).join(' · '))}</span>
                </span>
            </button>`).join('');
        icons();
    }

    function renderRecent(rows) {
        const host = card('recent');
        if (!rows.length) {
            host.innerHTML = `<p class="text-xs text-slate-400 text-center py-6">${escapeHtml(emptyText())}</p>`;
            return;
        }
        host.innerHTML = rows.map(r => `
            <button type="button" data-band="${escapeHtml(r.band)}"
                    class="w-full text-left flex items-center gap-3 py-2 px-1 hover:bg-slate-50 rounded-xl transition-colors">
                <span class="text-[10px] font-black text-indigo-500 font-mono tracking-tighter w-[4.5rem] flex-shrink-0">${escapeHtml(r.date)}</span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                    <span class="block text-[10px] text-slate-400 uppercase truncate">${escapeHtml([r.venue, r.city].filter(Boolean).join(' · '))}</span>
                </span>
                <span class="inline-flex items-center gap-1 text-[10px] font-black text-slate-500 flex-shrink-0" title="GigList users who were there">
                    <i data-lucide="users" class="w-3 h-3" aria-hidden="true"></i>${fmt(r.attendees)}
                </span>
            </button>`).join('');
        icons();
    }

    // ── load ─────────────────────────────────────────────────────────────────
    async function load() {
        const id = ++seq;
        const cards = $('[data-role="cards"]');
        cards.classList.add('opacity-50');
        $('[data-role="error"]').classList.add('hidden');
        try {
            // One RPC for all four cards; Chart.js loads in parallel
            const [res] = await Promise.all([
                rpc('get_community_gig_charts', query.args(), ac.signal),
                ensureChart(),
            ]);
            if (disposed || id !== seq) return;

            const years = res?.years || [];
            query.setTotal(years.reduce((n, y) => n + (y.gigs || 0), 0));
            renderYears(years);
            renderArtists(res?.artists || []);
            renderVenues(res?.venues || []);
            renderRecent(res?.recent || []);
            renderMonths(res?.months || []);
            renderWeekdays(res?.weekdays || []);
            renderCities(res?.cities || []);
            renderTrending(res?.trending || []);
            renderShared(res?.shared || []);
            cards.classList.remove('opacity-50');
        } catch (err) {
            if (disposed || id !== seq) return;
            console.warn('community stats: load failed', err);
            cards.classList.remove('opacity-50');
            $('[data-role="error"]').classList.remove('hidden');
        }
    }

    // ── events ───────────────────────────────────────────────────────────────
    el.addEventListener('click', (e) => {
        if (e.target.closest('[data-retry]')) { load(); return; }

        const row = e.target.closest('[data-band]');
        if (row) {
            // Prefer jumping to the Gigs tab when the shell offers it; otherwise
            // narrow this pane to that artist.
            if (typeof ctx.openGigs === 'function') ctx.openGigs(row.dataset.band);
            else query.setSearch(row.dataset.band);
        }
    }, { signal: ac.signal });

    icons();
    load();

    return function dispose() {
        disposed = true;
        query.dispose();
        ac.abort();
        Object.values(charts).forEach(c => { try { c.destroy(); } catch (_) { /* already gone */ } });
    };
}

registerCommunityPane('stats', renderStatsPane);
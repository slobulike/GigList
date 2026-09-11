/**
 * GigList - Charts Module
 */
import { isFestivalRow, getOwnFestivalLineup, scopeFestivalArtistMap, normalizeArtist } from './utils.js';

let modalChartInstance      = null;
let dashboardYearChart      = null;
let dashboardCompanionChart = null;
let dashboardTopBandsChart  = null;
let dashboardSongsChart     = null;
let dashboardBandFrequencyChart = null;
let dashboardAverageMetricsChart = null;

const getChartColors = (count) => {
    const colors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
        '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#4f46e5',
        '#a855f7', '#d946ef', '#fb7185', '#fb923c', '#facc15'
    ];
    return colors.slice(0, count);
};

/**
 * 1. COMPANION CHART (Doughnut)
 */
export const renderCompanionChart = (data, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // Single cleanup path — Chart.getChart covers all cases
    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const limit = isModal ? 15 : 7;
    const companionCounts = {};

    data.forEach(gig => {
        const val = gig.Companion || gig['Went With'] || "";
        if (val && val !== "nan" && val !== "Alone") {
            val.split(/[,\/&]/).map(c => c.trim()).forEach(c => {
                if (c) companionCounts[c] = (companionCounts[c] || 0) + 1;
            });
        }
    });

    const sortedCompanions = Object.entries(companionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

    const labels = sortedCompanions.map(c => c[0]);
    const counts = sortedCompanions.map(c => c[1]);

    const newChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: counts,
                backgroundColor: getChartColors(labels.length),
                borderWidth: 0,
                hoverOffset: 15
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: isModal,
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { size: 10, weight: 'bold' } }
                },
                tooltip: { enabled: true }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    window._filtersModule?.setFilters({ companion: labels[elements[0].index] });
                    if (isModal) window.closeChartModal();
                }
            }
        }
    });

    if (!isModal) dashboardCompanionChart = newChart;
};

/**
 * 2. YEAR CHART (Bar)
 */
export const renderYearChart = (data, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    // Count gigs per year in a single O(n) pass instead of O(n * years)
    const yearCounts = {};
    data.forEach(g => {
        if (!g.Date) return;
        const parts = g.Date.includes('/') ? g.Date.split('/') : g.Date.split('-');
        if (parts.length !== 3) return;
        const year = parts[2].length === 4 ? parts[2] : parts[0];
        if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
    });

    const allYears = Object.keys(yearCounts).map(Number).filter(y => !isNaN(y));
    if (allYears.length === 0) return;

    const startYear = Math.min(...allYears);
    const endYear   = new Date().getFullYear();

    const yearLabels = [];
    const yearData   = [];
    for (let y = startYear; y <= endYear; y++) {
        yearLabels.push(y.toString());
        yearData.push(yearCounts[y.toString()] || 0);
    }

    const newChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: yearLabels,
            datasets: [{
                label: 'Gigs',
                data: yearData,
                backgroundColor: '#6366f1',
                borderRadius: isModal ? 8 : 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    display: isModal,
                    ticks: { precision: 0 }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: isModal ? 12 : 8 } }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const year = yearLabels[elements[0].index];
                    if (isModal) {
                        renderMonthDrillDown(data, year);
                    } else {
                        window._filtersModule?.setYearFilter(parseInt(year, 10));
                    }
                }
            }
        }
    });

    if (isModal) modalChartInstance = newChart;
    else dashboardYearChart = newChart;

    return newChart;
};

/**
 * 3. MONTH DRILL-DOWN (sub-view of Year Chart modal)
 */
const renderMonthDrillDown = (data, year) => {
    const modal    = document.getElementById('chartModal');
    const subtitle = modal?.querySelector('p.text-slate-400');

    document.getElementById('modalChartTitle').innerText = `${year}: Monthly Breakdown`;

    if (subtitle) {
        subtitle.innerHTML = `<span class="flex items-center gap-1 cursor-pointer text-indigo-600 font-bold"><i data-lucide="chevron-left" class="w-4 h-4"></i> Back to Yearly</span>`;
        subtitle.onclick = () => {
            document.getElementById('modalChartTitle').innerText = "Yearly Breakdown";
            subtitle.innerHTML = "Interactive Data View";
            subtitle.onclick = null;
            renderYearChart(data, 'modalChartCanvas', true);
            if (window.lucide) lucide.createIcons();
        };
        if (window.lucide) lucide.createIcons();
    }

    // Count gigs per month for the selected year
    const monthlyCounts = new Array(12).fill(0);
    data.forEach(gig => {
        const dateStr = gig.Date || "";
        const parts   = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
        if (parts.length !== 3) return;
        // Month is always parts[1] for both DD/MM/YYYY and YYYY-MM-DD
        const gYear  = parts[2].length === 4 ? parts[2] : parts[0];
        const mIndex = parseInt(parts[1]) - 1;
        if (gYear === year.toString() && mIndex >= 0 && mIndex < 12) {
            monthlyCounts[mIndex]++;
        }
    });

    if (modalChartInstance) modalChartInstance.destroy();

    const ctx = document.getElementById('modalChartCanvas');
    modalChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
            datasets: [{
                label: 'Gigs',
                data: monthlyCounts,
                backgroundColor: '#10b981',
                hoverBackgroundColor: '#059669',
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0, color: '#94a3b8' },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    // Intentionally left on the old search-box bridge — filters.js's
                    // state only has year-level granularity (a Set of years), no
                    // month dimension, so there's nothing to migrate this onto yet.
                    // Extending filters.js's model to cover month would be a real
                    // feature addition, not a like-for-like swap like the others.
                    window.applyChartFilter('month', { year: year.toString(), month: elements[0].index });
                    window.closeChartModal();
                }
            }
        }
    });
};

/**
 * 4. TOP BANDS CHART (Horizontal Stacked Bar)
 */
export const renderTopBandsChart = (journalData, performanceData, canvasId, isModal = false) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    const topLimit = isModal ? 20 : 10;

    // Per show, we prefer synced performance data (verified against
    // setlist.fm) over the free-text journal fields when it's available —
    // see the merge logic below. Keyed by normalized (trimmed, lowercased)
    // band name so casing variants like "Bowling for Soup" / "bowling for
    // soup" don't get split into two separate entries and dilute the count.
    const bandCounts = {};

    const addBand = (name, role) => {
        const raw = (name || '').trim();
        if (!raw || raw.toLowerCase() === 'nan') return;
        const key = raw.toLowerCase();
        if (!bandCounts[key]) {
            bandCounts[key] = { display: raw, headline: 0, support: 0, total: 0 };
        }
        // Prefer the casing used when the band appears as a headline act —
        // that's the "canonical" spelling the user typed for that band's own show.
        if (role === 'headline') bandCounts[key].display = raw;
        bandCounts[key][role]++;
        bandCounts[key].total++;
    };

    // Group synced performances by show (journal_key), deduped per artist per
    // show. This is the verified, setlist.fm-sourced record of who actually
    // performed at a given show — more complete than the free-text
    // "Notable Support" field, which can only hold a single name and is
    // often left blank on shows with several openers.
    const perfArtistsByKey = new Map();
    (performanceData || []).forEach(perf => {
        const key    = perf['journal_key'] || perf['Journal Key'];
        const artist = (perf['Artist'] || '').trim();
        if (!key || !artist) return;
        if (!perfArtistsByKey.has(key)) perfArtistsByKey.set(key, new Map());
        // dedupe by normalized name, keep original casing for display
        perfArtistsByKey.get(key).set(artist.toLowerCase(), artist);
    });

    journalData.forEach(g => {
        const key          = g['Journal Key'] || g['JournalKey'];
        const headlineBand = (g.Band || g.band || '').trim();
        // Scoped to this row's own Festival Lineups when it's a festival —
        // otherwise perfArtistsByKey is a pool shared with every other user
        // who logged the same festival Journal Key (see utils.js).
        const perfArtists  = key ? scopeFestivalArtistMap(g, perfArtistsByKey.get(key) || new Map()) : null;

        if (perfArtists && perfArtists.size) {
            // Synced performance data exists for this show — trust it
            // completely instead of the free-text fields below. Every artist
            // it lists gets counted exactly once; headline vs support is
            // determined by matching against the journal's own Band field.
            perfArtists.forEach(artist => {
                const role = artist.toLowerCase() === headlineBand.toLowerCase() ? 'headline' : 'support';
                addBand(artist, role);
            });
        } else {
            // No synced performance data for this show — fall back to
            // whatever was manually entered in the journal fields.
            const isFest = (g['Festival?'] || g['festival'] || '').toString().toUpperCase().startsWith('Y');
            if (!isFest) addBand(headlineBand, 'headline');

            if (g['Notable Support']) {
                addBand(g['Notable Support'], 'support');
            }

            const lineups = g['Festival Lineups'] || g['FestivalLineups'] || '';
            if (lineups && lineups !== 'nan') {
                lineups.split(/[\/|]/).forEach(artist => addBand(artist.trim(), 'support'));
            }
        }
    });

    const topBands = Object.values(bandCounts)
        .sort((a, b) => (b.headline + b.support) - (a.headline + a.support))
        .slice(0, topLimit);

    if (topBands.length === 0) return;

    const labels = topBands.map(t => t.display);

    // Draws the actual count (headline + support) at the end of each bar.
    // Scoped to this chart instance via the `plugins` array (not registered
    // globally), so it won't affect other charts.
    const totalCountPlugin = {
        id: 'totalCountLabel',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            const supportMeta = chart.getDatasetMeta(1); // 'Support/Festival' — drawn last, so its x is the right edge of the full stack
            ctx.save();
            ctx.font = '700 11px sans-serif';
            ctx.fillStyle = '#475569';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            topBands.forEach((band, i) => {
                const el = supportMeta?.data?.[i];
                if (!el) return;
                const total = band.headline + band.support;
                ctx.fillText(String(total), el.x + 6, el.y);
            });
            ctx.restore();
        }
    };

    const newChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Headline',
                    data: topBands.map(t => t.headline),
                    backgroundColor: '#1D3557',
                    stack: 'Stack 0',
                    borderRadius: 4
                },
                {
                    label: 'Support/Festival',
                    data: topBands.map(t => t.support),
                    backgroundColor: '#A8DADC',
                    stack: 'Stack 0',
                    borderRadius: 4
                }
            ]
        },
        plugins: [totalCountPlugin],
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                // Leave room on the right for the count label so it doesn't clip
                padding: { right: 28 }
            },
            plugins: {
                legend: {
                    display: isModal,
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 11, weight: 'bold' } }
                },
                tooltip: { enabled: true }
            },
            scales: {
                x: { stacked: true, display: false },
                y: {
                    stacked: true,
                    grid: { display: false },
                    border: { display: false },
                    ticks: { crossAlign: 'far', font: { weight: '800', size: 12 }, color: '#64748b' }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const bandName = labels[elements[0].index];
                    window._filtersModule?.setFilters({ artist: bandName });
                    if (typeof window.closeChartModal === 'function') window.closeChartModal();
                }
            }
        }
    });

    if (isModal) dashboardTopBandsChart = newChart;
    else dashboardTopBandsChart = newChart;

    return newChart;
};

/**
 * 5. TOP SONGS CHART (Horizontal Bar) — Band Mode only
 */
export const renderTopSongsChart = (filteredJournal, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const journalByKey = new Map();
    filteredJournal.forEach(g => {
        const k = (g['Journal Key'] || g['JournalKey'] || "").toString().trim().toLowerCase();
        if (k) journalByKey.set(k, g);
    });

    const EXCLUDED   = new Set(['nan', 'not_found', 'unknown', 'null', '']);
    const songCounts = {};

    (window.performanceData || []).forEach(perf => {
        const pKey = (perf['Journal Key'] || perf['JournalKey'] || "").toString().trim().toLowerCase();
        const row  = journalByKey.get(pKey);
        if (!row) return;

        // At a festival, performanceData is a pool shared with every other
        // user who logged the same Journal Key — only count songs from acts
        // this row's own attendee logged as seeing (see utils.js).
        if (isFestivalRow(row)) {
            const ownLineup = getOwnFestivalLineup(row);
            if (ownLineup.size > 0 && !ownLineup.has(normalizeArtist(perf.Artist))) return;
        }

        const setlistRaw = perf.Setlist || "";
        if (!setlistRaw || setlistRaw === "nan" || setlistRaw === "NOT_FOUND") return;

        setlistRaw.split(/[|,\n;]/).forEach(song => {
            const clean = song.trim();
            if (clean && !EXCLUDED.has(clean.toLowerCase())) {
                songCounts[clean] = (songCounts[clean] || 0) + 1;
            }
        });
    });

    const limit       = isModal ? 25 : 12;
    const sortedSongs = Object.entries(songCounts).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const labels      = sortedSongs.map(s => s[0]);
    const counts      = sortedSongs.map(s => s[1]);

    const colors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b',
        '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7'
    ];

    const newChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: counts,
                backgroundColor: colors,
                borderRadius: 4,
                barThickness: isModal ? 12 : 10
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    callbacks: { label: (ctx) => ` Played ${ctx.raw} times` }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { display: false },
                    ticks: { color: '#94a3b8', font: { size: 10 } }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#475569', font: { size: isModal ? 10 : 9, weight: 'bold' } }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    // Intentionally left on the old search-box bridge — filters.js
                    // only filters journalData fields (artist/venue/companion/etc.),
                    // it has no concept of an individual song, which lives in the
                    // separate performances/setlist data. Nothing to migrate this
                    // onto without extending filters.js's data model.
                    const songName    = labels[elements[0].index];
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        searchInput.value = songName;
                        if (window.refreshUI) window.refreshUI();
                        if (isModal && typeof window.closeChartModal === 'function') window.closeChartModal();
                    }
                }
            }
        }
    });

    if (!isModal) dashboardSongsChart = newChart;
};

/**
 * 6. BAND FREQUENCY OVER TIME (Scatter)
 *
 * One point per show, per top artist — date on the x-axis, artist on the
 * y-axis (category scale, one row per band). Which bands qualify is based
 * on total shows attended (top N), but the rows are then ordered
 * chronologically by first-seen date — earliest-discovered artist at the
 * top, most recent discovery at the bottom — so the chart reads as a
 * timeline of how your taste developed, rather than duplicating the
 * Top Bands leaderboard. Reuses the same synced-performance-preferred /
 * free-text-fallback attribution logic as the Top Bands chart (see
 * renderTopBandsChart) to decide who counts as "seen" at a given show.
 *
 * No Chart.js date adapter is loaded (see ensureChartJs in app.js — it
 * fetches the bare chart.js UMD bundle), so dates are plotted as plain
 * millisecond timestamps on a linear x-axis rather than a 'time' scale,
 * with a tick/tooltip callback formatting them back to readable dates.
 */
export const renderBandFrequencyChart = (journalData, performanceData, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const topLimit = isModal ? 20 : 8;

    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
        if (parts.length !== 3) return null;
        const isISO = parts[0].length === 4;
        const [y, m, d] = isISO ? parts : [parts[2], parts[1], parts[0]];
        // Require a real 4-digit year — anything shorter (a mistyped or
        // truncated year field) falls through to JS's legacy non-standard
        // 2-digit-year parsing, which is inconsistent (e.g. '33' -> 2033,
        // '23' -> NaN) and is how bad rows have produced bogus far-future
        // points on this chart before. Reject rather than guess.
        if (y.length !== 4) return null;
        const ts = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).getTime();
        return isNaN(ts) ? null : ts;
    };

    // Per show, prefer synced performance data over free-text journal
    // fields — same merge approach as renderTopBandsChart.
    const perfArtistsByKey = new Map();
    (performanceData || []).forEach(perf => {
        const key    = perf['journal_key'] || perf['Journal Key'];
        const artist = (perf['Artist'] || '').trim();
        if (!key || !artist) return;
        if (!perfArtistsByKey.has(key)) perfArtistsByKey.set(key, new Map());
        perfArtistsByKey.get(key).set(artist.toLowerCase(), artist);
    });

    const bandPoints = {}; // key -> { display, points: [{x}], total }

    const addPoint = (name, dateStr) => {
        const raw = (name || '').trim();
        if (!raw || raw.toLowerCase() === 'nan') return;
        const ts = parseDate(dateStr);
        if (ts === null) return;
        const key = raw.toLowerCase();
        if (!bandPoints[key]) bandPoints[key] = { display: raw, points: [], total: 0 };
        bandPoints[key].points.push({ x: ts });
        bandPoints[key].total++;
    };

    journalData.forEach(g => {
        const key          = g['Journal Key'] || g['JournalKey'];
        const dateStr       = g.Date;
        const headlineBand = (g.Band || g.band || '').trim();
        // Scoped to this row's own Festival Lineups — see renderTopBandsChart.
        const perfArtists  = key ? scopeFestivalArtistMap(g, perfArtistsByKey.get(key) || new Map()) : null;

        if (perfArtists && perfArtists.size) {
            perfArtists.forEach(artist => addPoint(artist, dateStr));
        } else {
            const isFest = (g['Festival?'] || g['festival'] || '').toString().toUpperCase().startsWith('Y');
            if (!isFest) addPoint(headlineBand, dateStr);
            if (g['Notable Support']) addPoint(g['Notable Support'], dateStr);
            const lineups = g['Festival Lineups'] || g['FestivalLineups'] || '';
            if (lineups && lineups !== 'nan') {
                lineups.split(/[\/|]/).forEach(artist => addPoint(artist.trim(), dateStr));
            }
        }
    });

    const topBands = Object.values(bandPoints)
        .sort((a, b) => b.total - a.total)   // selection: most-attended bands qualify
        .slice(0, topLimit)
        .map(band => ({ ...band, firstSeen: Math.min(...band.points.map(p => p.x)) }))
        .sort((a, b) => a.firstSeen - b.firstSeen); // display order: earliest-discovered at the top

    if (topBands.length === 0) return;

    const bandLabels = topBands.map(b => b.display);
    const colors      = getChartColors(topBands.length);

    const datasets = topBands.map((band, i) => ({
        label: band.display,
        data: band.points.map(p => ({ x: p.x, y: band.display })),
        backgroundColor: colors[i % colors.length],
        pointRadius: isModal ? 6 : 4,
        pointHoverRadius: isModal ? 8 : 6
    }));

    // Chart.js's linear scale auto-generates "nice" round tick intervals
    // from the data range, which can overshoot well past the actual max
    // data point (e.g. ticks landing on 2033 when the latest real show is
    // in 2027) rather than stopping at it. Pin min/max explicitly to the
    // real data range instead of letting the axis guess.
    const allTimestamps = topBands.flatMap(b => b.points.map(p => p.x));
    const dataMin = Math.min(...allTimestamps);
    const dataMax = Math.max(...allTimestamps);
    const padMs   = (dataMax - dataMin) * 0.04 || (1000 * 60 * 60 * 24 * 30); // ~4% padding, or 30 days if a single date

    const newChart = new Chart(ctx, {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => items[0]?.raw?.y || '',
                        label: (item) => new Date(item.raw.x).toLocaleDateString('en-GB', {
                            day: 'numeric', month: 'short', year: 'numeric'
                        })
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: dataMin - padMs,
                    max: dataMax + padMs,
                    grid: { display: false },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: isModal ? 12 : 10 },
                        callback: (val) => new Date(val).getFullYear()
                    }
                },
                y: {
                    type: 'category',
                    labels: bandLabels,
                    grid: { color: 'rgba(148, 163, 184, 0.1)' },
                    ticks: { color: '#64748b', font: { weight: '800', size: 12 } }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const el       = elements[0];
                    const bandName = datasets[el.datasetIndex].label;
                    window._filtersModule?.setFilters({ artist: bandName });
                    if (isModal && typeof window.closeChartModal === 'function') window.closeChartModal();
                }
            }
        }
    });

    if (!isModal) dashboardBandFrequencyChart = newChart;

    return newChart;
};

/**
 * 7. HOT LIST — most-seen bands in the last 5 years (ranked list, not a
 * canvas chart — rendered into a plain container, see hotListBody in
 * vault.html). Time-boxes the same synced-performance-preferred
 * attribution logic used by Top Bands, so it reflects who you're actually
 * into right now rather than all-time favourites.
 */
export const renderHotList = (journalData, performanceData, containerId, isModal = false) => {
    const container = document.getElementById(containerId);
    if (!container) return;

    const limit = isModal ? 25 : 8;

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 5);

    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
        if (parts.length !== 3) return null;
        const isISO = parts[0].length === 4;
        const [y, m, d] = isISO ? parts : [parts[2], parts[1], parts[0]];
        // Same 4-digit-year guard as renderBandFrequencyChart's parseDate —
        // see comment there. Without this, a bad row's year could parse via
        // JS's legacy 2-digit-year fallback and wrongly land inside the
        // "last 5 years" window this chart filters on.
        if (y.length !== 4) return null;
        const dt = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
        return isNaN(dt.getTime()) ? null : dt;
    };

    const recentJournal = journalData.filter(g => {
        const dt = parseDate(g.Date);
        return dt && dt >= cutoff;
    });

    const perfArtistsByKey = new Map();
    (performanceData || []).forEach(perf => {
        const key    = perf['journal_key'] || perf['Journal Key'];
        const artist = (perf['Artist'] || '').trim();
        if (!key || !artist) return;
        if (!perfArtistsByKey.has(key)) perfArtistsByKey.set(key, new Map());
        perfArtistsByKey.get(key).set(artist.toLowerCase(), artist);
    });

    const bandCounts = {};
    const addBand = (name) => {
        const raw = (name || '').trim();
        if (!raw || raw.toLowerCase() === 'nan') return;
        const key = raw.toLowerCase();
        if (!bandCounts[key]) bandCounts[key] = { display: raw, count: 0 };
        bandCounts[key].count++;
    };

    recentJournal.forEach(g => {
        const key          = g['Journal Key'] || g['JournalKey'];
        const headlineBand = (g.Band || g.band || '').trim();
        // Scoped to this row's own Festival Lineups — see renderTopBandsChart.
        const perfArtists  = key ? scopeFestivalArtistMap(g, perfArtistsByKey.get(key) || new Map()) : null;

        if (perfArtists && perfArtists.size) {
            perfArtists.forEach(artist => addBand(artist));
        } else {
            const isFest = (g['Festival?'] || g['festival'] || '').toString().toUpperCase().startsWith('Y');
            if (!isFest) addBand(headlineBand);
            if (g['Notable Support']) addBand(g['Notable Support']);
            const lineups = g['Festival Lineups'] || g['FestivalLineups'] || '';
            if (lineups && lineups !== 'nan') {
                lineups.split(/[\/|]/).forEach(artist => addBand(artist.trim()));
            }
        }
    });

    const ranked = Object.values(bandCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    if (ranked.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 text-center py-6">No shows in the last 5 years yet.</p>`;
        return;
    }

    const maxCount = ranked[0].count;
    const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    container.innerHTML = ranked.map((band, i) => `
        <div class="hotlist-row flex items-center gap-3 py-2 px-1 cursor-pointer hover:bg-slate-50 rounded-xl transition-colors"
             data-band="${escapeHtml(band.display)}">
            <span class="text-xs font-black text-slate-300 w-5 text-right flex-shrink-0">${i + 1}</span>
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                    <p class="text-sm font-bold text-slate-800 truncate">${escapeHtml(band.display)}</p>
                    <p class="text-xs font-black text-indigo-500 flex-shrink-0">${band.count}</p>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-1.5 mt-1">
                    <div class="bg-indigo-500 h-1.5 rounded-full" style="width:${(band.count / maxCount) * 100}%"></div>
                </div>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.hotlist-row').forEach(row => {
        row.addEventListener('click', () => window._applyHotListFilter(row.dataset.band));
    });
};

window._applyHotListFilter = function(bandName) {
    window._filtersModule?.setFilters({ artist: bandName });
    if (typeof window.closeChartModal === 'function') window.closeChartModal();
};

/**
 * 8. AVERAGES OVER TIME (Line, multi-series)
 *
 * Four per-year averages plotted together — avg ticket price for standard
 * gigs, avg ticket price for festivals (split out separately, since
 * festival pricing sits on a different scale and blending it in spikes/
 * distorts the "normal gig" price trend), avg miles travelled per show,
 * and avg buddies per show. Rather than juggling four separate y-axes on
 * a small dashboard card, each series is independently min-max normalised
 * to a shared 0-100 range for its *line shape only* — the y-axis itself is
 * hidden, and the tooltip reports the real value with its proper unit via
 * each dataset's stashed `_raw`/`_unit`. A year with no data for a metric
 * (e.g. no festivals attended that year) leaves that point as null rather
 * than plotting a false 0; `spanGaps` bridges the line across it.
 *
 * Ticket price comes from journals.price, which is stored as free-text
 * (e.g. "£25.50", "30", "Free") rather than numeric, so it's parsed with
 * parsePrice below rather than a bare parseFloat.
 *
 * Distance needs venue coordinates plus an estimated home location,
 * neither of which live in journalData. Pass venuesData as a lookup keyed
 * by venues.official_name -> { latitude, longitude } (build it from the
 * shared venues table — same shape as its columns, no renaming needed),
 * and homeLocation as { lat, lng }. The join uses journals.official_venue
 * first (the canonical name, matches venues.official_name reliably) and
 * falls back to journals.venue (free text, which per the known venue-name
 * mismatch issue — e.g. "Hatfield Park" vs canonical "Hatfield House" —
 * won't always resolve). A show that doesn't resolve to a venue simply
 * doesn't contribute a distance sample for that year, rather than erroring.
 */
const parsePrice = (raw) => {
    if (!raw) return NaN;
    const cleaned = String(raw).replace(/[^0-9.]/g, '');
    return cleaned ? parseFloat(cleaned) : NaN;
};

const haversineMiles = (lat1, lng1, lat2, lng2) => {
    // Matches the haversineMiles implementation already used in the push
    // worker (index.js) — same formula, atan2 form for consistency.
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 3958.8; // Earth radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const renderAverageMetricsChart = (journalData, venuesData = {}, homeLocation = null, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const yearBuckets = {}; // year -> { pricesGig: [], pricesFestival: [], distances: [], buddies: [] }

    journalData.forEach(g => {
        if (!g.Date) return;
        const parts = g.Date.includes('/') ? g.Date.split('/') : g.Date.split('-');
        if (parts.length !== 3) return;
        const year = parts[2].length === 4 ? parts[2] : parts[0];
        if (!year) return;
        if (!yearBuckets[year]) yearBuckets[year] = { pricesGig: [], pricesFestival: [], distances: [], buddies: [] };

        // Festival vs standard gig — journals.festival is a bool, but this
        // file's existing convention (see renderBandFrequencyChart) also
        // tolerates a 'Y'/'N'-style string coming through the app layer.
        const festivalRaw = g['Festival?'] ?? g.festival;
        const isFestival = typeof festivalRaw === 'boolean'
            ? festivalRaw
            : (festivalRaw || '').toString().toUpperCase().startsWith('Y');

        // Ticket price — journals.price is text (currency symbols, commas,
        // "Free", blanks all possible), so strip down to a bare number.
        // Split by festival vs standard gig — festival prices are on a
        // different scale entirely and blending them spikes/distorts the
        // "normal gig" trend.
        const price = parsePrice(g.Price ?? g.price);
        if (!isNaN(price) && price > 0) {
            (isFestival ? yearBuckets[year].pricesFestival : yearBuckets[year].pricesGig).push(price);
        }

        // Distance travelled — official_venue (canonical) preferred over
        // the free-text venue field, since only the former reliably
        // matches venues.official_name.
        const venueName = g['Official Venue'] || g.official_venue || g.Venue || g.venue;
        const venue = venueName ? venuesData[venueName] : null;
        // Tolerant of either field naming — venuesData is aliased from
        // window.allVenues (app.js), whose per-record shape isn't visible
        // from this file, so this doesn't bet on latitude/longitude vs lat/lng.
        const lat = venue ? parseFloat(venue.latitude ?? venue.lat) : NaN;
        const lng = venue ? parseFloat(venue.longitude ?? venue.lng) : NaN;
        if (homeLocation && !isNaN(lat) && !isNaN(lng)) {
            const miles = haversineMiles(homeLocation.lat, homeLocation.lng, lat, lng);
            yearBuckets[year].distances.push(miles);
        }

        // Buddies — same companion parsing as renderCompanionChart
        const companionVal = g.Companion || g['Went With'] || g.went_with || "";
        let buddyCount = 0;
        if (companionVal && companionVal !== "nan" && companionVal !== "Alone") {
            buddyCount = companionVal.split(/[,\/&]/).map(c => c.trim()).filter(Boolean).length;
        }
        yearBuckets[year].buddies.push(buddyCount);
    });

    const allYears = Object.keys(yearBuckets).map(Number).filter(y => !isNaN(y));
    if (allYears.length === 0) return;

    const startYear = Math.min(...allYears);
    const endYear   = new Date().getFullYear();

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const yearLabels        = [];
    const rawPricesGig      = [];
    const rawPricesFestival = [];
    const rawDistances      = [];
    const rawBuddies        = [];

    for (let y = startYear; y <= endYear; y++) {
        const bucket = yearBuckets[y.toString()];
        yearLabels.push(y.toString());
        rawPricesGig.push(bucket ? avg(bucket.pricesGig) : null);
        rawPricesFestival.push(bucket ? avg(bucket.pricesFestival) : null);
        rawDistances.push(bucket ? avg(bucket.distances) : null);
        rawBuddies.push(bucket ? avg(bucket.buddies) : null);
    }

    // Normalise each series independently to 0-100 so very different units
    // (£, miles, headcount) can share one axis and be compared by trend
    // shape. Real values are reported via the tooltip, not this scale.
    const normalise = (arr) => {
        const values = arr.filter(v => v !== null);
        if (!values.length) return arr.map(() => null);
        const min = Math.min(...values), max = Math.max(...values);
        const range = max - min;
        return arr.map(v => v === null ? null : (range === 0 ? 50 : ((v - min) / range) * 100));
    };

    const series = [
        { label: 'Avg ticket price (gigs)',      raw: rawPricesGig,      unit: (v) => `£${v.toFixed(2)}`, color: '#22c55e' },
        { label: 'Avg ticket price (festivals)', raw: rawPricesFestival, unit: (v) => `£${v.toFixed(2)}`, color: '#f59e0b' },
        { label: 'Avg miles / show',             raw: rawDistances,      unit: (v) => `${v.toFixed(0)} mi`, color: '#3b82f6' },
        { label: 'Avg buddies / show',           raw: rawBuddies,        unit: (v) => v.toFixed(1), color: '#ec4899' }
    ];

    const datasets = series.map(s => ({
        label: s.label,
        data: normalise(s.raw),
        borderColor: s.color,
        backgroundColor: s.color,
        tension: 0.3,
        spanGaps: true,
        pointRadius: isModal ? 4 : 3,
        pointHoverRadius: isModal ? 6 : 5,
        _raw: s.raw,
        _unit: s.unit
    }));

    const newChart = new Chart(ctx, {
        type: 'line',
        data: { labels: yearLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { size: isModal ? 11 : 9, weight: 'bold' }, boxWidth: 10 }
                },
                tooltip: {
                    callbacks: {
                        label: (item) => {
                            const ds  = item.dataset;
                            const raw = ds._raw[item.dataIndex];
                            return raw === null ? `${ds.label}: no data` : `${ds.label}: ${ds._unit(raw)}`;
                        }
                    }
                }
            },
            scales: {
                y: { display: false, min: 0, max: 100 },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: isModal ? 12 : 8 } }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length === 0) return;
                const el   = elements[0];
                const year = parseInt(yearLabels[el.index], 10);

                // Price lines (0 = gigs, 1 = festivals) set year + festival
                // together via filters.js's real filter state. Miles/buddies
                // (2, 3) are year-only, same as everything else clicks to.
                if (el.datasetIndex === 0 || el.datasetIndex === 1) {
                    window._filtersModule?.setYearFilter(year, el.datasetIndex === 1 ? 'festival' : 'headline');
                } else {
                    window._filtersModule?.setYearFilter(year, 'all');
                }

                if (isModal && typeof window.closeChartModal === 'function') window.closeChartModal();
            }
        }
    });

    if (!isModal) dashboardAverageMetricsChart = newChart;
};

/**
 * Modal Controller — called by HTML onclick="openChartModal('year')" etc.
 */
window.openChartModal = async function(chartType) {
    // Ensure Chart.js is available before doing anything — it's loaded lazily
    await window.ensureChartJs();

    const modal    = document.getElementById('chartModal');
    const canvas   = document.getElementById('modalChartCanvas');
    const listBody = document.getElementById('modalChartListBody');
    if (!modal || !canvas) return;

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    // Reset subtitle state left over from any drill-down
    const subtitle = modal.querySelector('p.text-slate-400');
    if (subtitle) { subtitle.innerHTML = 'Interactive Data View'; subtitle.onclick = null; }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    const dataToUse = (window.filteredResults && window.filteredResults.length > 0)
        ? window.filteredResults
        : window.journalData;

    const titleEl = document.getElementById('modalChartTitle');

    // List-type expansions (currently just Hot List) render into a
    // scrollable div instead of the canvas — toggle which one shows.
    const isListType = chartType === 'hotlist';
    canvas.classList.toggle('hidden', isListType);
    if (listBody) {
        listBody.classList.toggle('hidden', !isListType);
        if (isListType) listBody.innerHTML = '';
    }

    if (chartType === 'companion') {
        if (titleEl) titleEl.innerText = "Companion Analysis";
        renderCompanionChart(dataToUse, 'modalChartCanvas', true);
    } else if (chartType === 'year') {
        if (titleEl) titleEl.innerText = "Yearly Breakdown";
        renderYearChart(dataToUse, 'modalChartCanvas', true);
    } else if (chartType === 'songs') {
        if (titleEl) titleEl.innerText = "Top Songs Leaderboard";
        renderTopSongsChart(dataToUse, 'modalChartCanvas', true);
    } else if (chartType === 'topbands') {
        if (titleEl) titleEl.innerText = "Top Bands Leaderboard";
        renderTopBandsChart(dataToUse, window.performanceData, 'modalChartCanvas', true);
    } else if (chartType === 'bandfrequency') {
        if (titleEl) titleEl.innerText = "Band Frequency Over Time";
        renderBandFrequencyChart(dataToUse, window.performanceData, 'modalChartCanvas', true);
    } else if (chartType === 'hotlist') {
        if (titleEl) titleEl.innerText = "Hot List — Last 5 Years";
        renderHotList(dataToUse, window.performanceData, 'modalChartListBody', true);
    } else if (chartType === 'averagemetrics') {
        if (titleEl) titleEl.innerText = "Averages Over Time";
        renderAverageMetricsChart(dataToUse, window.venuesData, window.homeLocation, 'modalChartCanvas', true);
    }

    if (window.lucide) lucide.createIcons();
};

/**
 * Renders all dashboard charts. Called by app.js once Chart.js has been
 * lazy-loaded (via ensureChartJs). Safe to call multiple times — each
 * chart function destroys any existing instance before re-rendering.
 */
export const renderDashboardCharts = (results, performanceData) => {
    const companionContainer = document.getElementById('companionChartContainer');
    const songContainer      = document.getElementById('songChartContainer');
    const topBandsContainer  = document.getElementById('topBandsChartContainer');

    if (window.isBandMode) {
        if (songContainer) {
            songContainer.classList.remove('hidden');
            renderTopSongsChart(results, 'topSongsChart');
        }
        if (companionContainer) companionContainer.classList.add('hidden');
        if (topBandsContainer)  topBandsContainer.classList.add('hidden');
    } else {
        if (songContainer) songContainer.classList.add('hidden');

        if (companionContainer) {
            companionContainer.classList.remove('hidden');
            renderCompanionChart(results, 'dashboardCompanionChart');
        }

        if (topBandsContainer) {
            topBandsContainer.classList.remove('hidden');
            renderTopBandsChart(results, performanceData, 'topBandsChart');
        }
    }

    renderYearChart(results, 'dashboardYearChart');

    // Stats tab additions. Guarded by container existence since these live
    // in view-stats, which doesn't exist in band mode — the checks are
    // simple no-ops there rather than an isBandMode branch.
    if (document.getElementById('bandFrequencyScatterChart')) {
        renderBandFrequencyChart(results, performanceData, 'bandFrequencyScatterChart');
    }
    if (document.getElementById('hotListBody')) {
        renderHotList(results, performanceData, 'hotListBody');
    }
    // Needs venuesData/homeLocation exposed globally the same way
    // performanceData already is — see renderAverageMetricsChart's doc
    // comment for what shape those need to be in.
    if (document.getElementById('averageMetricsChart')) {
        renderAverageMetricsChart(results, window.venuesData, window.homeLocation, 'averageMetricsChart');
    }
};

window.closeChartModal = function() {
    const modal  = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');

    if (canvas) {
        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();
    }

    if (modal) {
        // Move focus out of the modal before hiding it — prevents the
        // "aria-hidden on element with focused descendant" console warning
        if (modal.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }

    document.body.style.overflow = 'auto';
};
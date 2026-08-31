/**
 * GigList - Charts Module
 */

let modalChartInstance      = null;
let dashboardYearChart      = null;
let dashboardCompanionChart = null;
let dashboardTopBandsChart  = null;
let dashboardSongsChart     = null;
let dashboardBandFrequencyChart = null;

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
                    window.applyChartFilter('companion', labels[elements[0].index]);
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
                        window.applyChartFilter('year', year);
                    }
                }
            }
        }
    });

    if (isModal) modalChartInstance = newChart;
    else dashboardYearChart = newChart;
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
        const perfArtists  = key ? perfArtistsByKey.get(key) : null;

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
                    const bandName    = labels[elements[0].index];
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        searchInput.value = bandName;
                        if (window.refreshUI) window.refreshUI();
                        if (typeof window.closeChartModal === 'function') window.closeChartModal();
                    }
                }
            }
        }
    });

    if (isModal) dashboardTopBandsChart = newChart;
    else dashboardTopBandsChart = newChart;
};

/**
 * 5. TOP SONGS CHART (Horizontal Bar) — Band Mode only
 */
export const renderTopSongsChart = (filteredJournal, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const currentKeys = new Set(
        filteredJournal
            .map(g => (g['Journal Key'] || g['JournalKey'] || "").toString().trim().toLowerCase())
            .filter(k => k !== "")
    );

    const EXCLUDED   = new Set(['nan', 'not_found', 'unknown', 'null', '']);
    const songCounts = {};

    (window.performanceData || []).forEach(perf => {
        const pKey = (perf['Journal Key'] || perf['JournalKey'] || "").toString().trim().toLowerCase();
        if (!currentKeys.has(pKey)) return;

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
        const perfArtists  = key ? perfArtistsByKey.get(key) : null;

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
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        searchInput.value = bandName;
                        if (window.refreshUI) window.refreshUI();
                        if (isModal && typeof window.closeChartModal === 'function') window.closeChartModal();
                    }
                }
            }
        }
    });

    if (!isModal) dashboardBandFrequencyChart = newChart;
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
        const perfArtists  = key ? perfArtistsByKey.get(key) : null;

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
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = bandName;
        if (window.refreshUI) window.refreshUI();
        if (typeof window.closeChartModal === 'function') window.closeChartModal();
    }
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
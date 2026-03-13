/**
 * GigList - Charts Module
 */

import * as Data from './data.js';

let modalChartInstance      = null;
let dashboardYearChart      = null;
let dashboardCompanionChart = null;
let dashboardTopBandsChart  = null;
let dashboardSongsChart     = null;

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

    const stats    = Data.getBandAppearanceStats(journalData, performanceData);
    const topLimit = isModal ? 20 : 10;
    const topBands = Object.entries(stats)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, topLimit);

    if (topBands.length === 0) return;

    const labels = topBands.map(t => t[0]);

    const newChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Headline',
                    data: topBands.map(t => t[1].headline),
                    backgroundColor: '#1D3557',
                    stack: 'Stack 0',
                    borderRadius: 4
                },
                {
                    label: 'Support/Festival',
                    data: topBands.map(t => t[1].support),
                    backgroundColor: '#A8DADC',
                    stack: 'Stack 0',
                    borderRadius: 4
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
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
 * Modal Controller — called by HTML onclick="openChartModal('year')" etc.
 */
window.openChartModal = function(chartType) {
    const modal  = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');
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
    }

    if (window.lucide) lucide.createIcons();
};

window.closeChartModal = function() {
    const modal  = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');

    if (canvas) {
        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();
    }

    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }

    document.body.style.overflow = 'auto';
};
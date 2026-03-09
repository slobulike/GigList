/**
 * GigList - Charts Module
 */

import * as Data from './data.js';

let modalChartInstance = null;
let dashboardYearChart = null;
let dashboardCompanionChart = null;
let dashboardTopBandsChart = null;

// Helper to get color palette
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

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    if (!isModal && dashboardCompanionChart) {
        dashboardCompanionChart.destroy();
    }
    if (!isModal && dashboardCompanionChart) dashboardCompanionChart.destroy();

    // Requirement 1: Limit logic
    const limit = isModal ? 15 : 7;

    const companionCounts = {};
    data.forEach(gig => {
        // Checking multiple possible keys from CSV
        const val = gig.Companion || gig['Went With'] || "";
        if (val && val !== "nan" && val !== "Alone") {
            const list = val.split(/[,\/&]/).map(c => c.trim());
            list.forEach(c => {
                if (c) companionCounts[c] = (companionCounts[c] || 0) + 1;
            });
        }
    });

    const sortedCompanions = Object.entries(companionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

    const labels = sortedCompanions.map(c => c[0]);
    const counts = sortedCompanions.map(c => c[1]);

    const chartConfig = {
        type: 'doughnut',
        data: {
            labels: labels, // Requirement 4: Labels are names
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
                // Requirement: Legend only in expanded view
                legend: {
                    display: isModal,
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { size: 10, weight: 'bold' } }
                },
                tooltip: { enabled: true }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const companion = labels[index];
                    window.applyChartFilter('companion', companion);
                    if (isModal) window.closeChartModal();
                }
            }
        }
    };

    const newChart = new Chart(ctx, chartConfig);

    if (!isModal) {
        dashboardCompanionChart = newChart;
    }
};

/**
 * 2. YEAR CHART (Bar)
 */
export const renderYearChart = (data, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (isModal && modalChartInstance) modalChartInstance.destroy();
    if (!isModal && dashboardYearChart) dashboardYearChart.destroy();

    // Helper to get year from "DD/MM/YYYY" or "YYYY-MM-DD"
    const getYear = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');
        // If it's DD/MM/YYYY, year is index 2. If YYYY-MM-DD, year is index 0.
        const year = parts.length === 3 ? (parts[2].length === 4 ? parts[2] : parts[0]) : null;
        return year ? parseInt(year) : null;
    };

    // Requirement 6: Get the actual range from the data
    const allYears = data.map(g => getYear(g.Date)).filter(y => y !== null);
    if (allYears.length === 0) return;

    const startYear = Math.min(...allYears);
    const endYear = new Date().getFullYear();

    const yearLabels = [];
    const yearCounts = [];

    // Requirement 7: Iterate through every year, even if count is 0
    for (let y = startYear; y <= endYear; y++) {
        yearLabels.push(y.toString());
        const count = data.filter(g => getYear(g.Date) === y).length;
        yearCounts.push(count);
    }

    const chartConfig = {
        type: 'bar',
        data: {
            labels: yearLabels,
            datasets: [{
                label: 'Gigs',
                data: yearCounts,
                backgroundColor: '#6366f1',
                borderRadius: isModal ? 8 : 4 // Slightly sleeker bars for dashboard
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                // Requirement: No legend even in modal view
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    // Requirement: Hide Y-axis labels and lines on small version
                    display: isModal,
                    ticks: { precision: 0 }
                },
                x: {
                    // We keep X labels so you can see the years,
                    // but we can hide the grid lines for a cleaner look
                    grid: { display: false },
                    ticks: {
                        font: { size: isModal ? 12 : 8 } // Smaller font for dashboard
                    }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const year = yearLabels[index]; // Use the labels array defined in renderYearChart
                    if (isModal) {
                        renderMonthDrillDown(data, year);
                    } else {
                        window.applyChartFilter('year', year);
                    }
                }
            }
        }
    };

    const newChart = new Chart(ctx, chartConfig);
    if (isModal) modalChartInstance = newChart;
    else dashboardYearChart = newChart;
};

/**
 * 3. MONTH DRILL-DOWN (The sub-view for Year Chart)
 */
const renderMonthDrillDown = (data, year) => {
    const modal = document.getElementById('chartModal');
    const subtitle = modal.querySelector('p.text-slate-400');

    // 1. Update UI for Drill-Down State
    document.getElementById('modalChartTitle').innerText = `${year}: Monthly Breakdown`;

    // Requirement 3: The "Back" button logic
    if (subtitle) {
        subtitle.innerHTML = `<span class="flex items-center gap-1 cursor-pointer text-indigo-600 font-bold"><i data-lucide="chevron-left" class="w-4 h-4"></i> Back to Yearly</span>`;
        subtitle.onclick = () => {
            document.getElementById('modalChartTitle').innerText = "Yearly Breakdown";
            renderYearChart(data, 'modalChartCanvas', true);
            subtitle.innerHTML = "Interactive Data View";
            subtitle.onclick = null;
            if (window.lucide) lucide.createIcons();
        };
        if (window.lucide) lucide.createIcons();
    }

    // 2. Calculate Monthly Data
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyCounts = new Array(12).fill(0);

    data.forEach(gig => {
        const dateStr = gig.Date || "";
        const parts = dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-');

        // Ensure we are looking at the correct year and extract month
        const gYear = parts.length === 3 ? (parts[2].length === 4 ? parts[2] : parts[0]) : null;
        const gMonth = parts.length === 3 ? (parts[2].length === 4 ? parts[1] : parts[1]) : null;

        if (gYear === year.toString()) {
            const mIndex = parseInt(gMonth) - 1; // Convert 01-12 to 0-11
            if (mIndex >= 0 && mIndex < 12) {
                monthlyCounts[mIndex]++;
            }
        }
    });

    // 3. Render the Monthly Chart
    if (modalChartInstance) modalChartInstance.destroy();

    const ctx = document.getElementById('modalChartCanvas');
    modalChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: monthNames,
            datasets: [{
                label: 'Gigs',
                data: monthlyCounts,
                backgroundColor: '#10b981', // Distinct Emerald Green for Monthly view
                hoverBackgroundColor: '#059669',
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false } // Also removed from monthly view
            },
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
                    const monthIndex = elements[0].index;
                    // Apply filter and close modal
                    window.applyChartFilter('month', { year: year.toString(), month: monthIndex });
                    window.closeChartModal();
                }
            }
        }
    });
};

/**
 * 4. Top Bands Horizontal Bar Chart
 */

export const renderTopBandsChart = (journalData, performanceData, canvasId, isModal = false) => {
    // 1. RE-ADD LOGGING
    console.log("renderTopBandsChart START", canvasId);

    const canvas = document.getElementById(canvasId);
    console.log("Canvas element found:", canvas);

    if (!canvas) {
        console.error("CRITICAL: Canvas not found in DOM:", canvasId);
        return;
    }

    // 2. THE COLLAPSE FIX
    // We removed the manual width/height overrides that caused the 0px bug.
    // Instead, we ensure the canvas is visible before Chart.js touches it.

    // 3. CLEANUP (Using the most reliable method)
    const existingChart = Chart.getChart(canvas);
    console.log("Existing chart on this canvas:", existingChart);

    if (existingChart) {
        console.log("Destroying existing chart instance...");
        existingChart.destroy();
    }

    // Secondary cleanup for the global tracker
    if (isModal && window.modalChartInstance) {
        console.log("Destroying global modalChartInstance...");
        window.modalChartInstance.destroy();
        window.modalChartInstance = null;
    }

    // 4. DATA PROCESSING
    console.log("Processing band stats...");
    const stats = Data.getBandAppearanceStats(journalData, performanceData);
    const topLimit = isModal ? 20 : 10;

    const topTen = Object.entries(stats)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, topLimit);

    if (topTen.length === 0) {
        console.warn("No data found to render chart.");
        return;
    }

    const labels = topTen.map(t => t[0]);

    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Headline',
                    data: topTen.map(t => t[1].headline),
                    backgroundColor: '#1D3557',
                    stack: 'Stack 0',
                    borderRadius: 4
                },
                {
                    label: 'Support/Festival',
                    data: topTen.map(t => t[1].support),
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
                    ticks: {
                        crossAlign: 'far',
                        font: { weight: '800', size: 12 },
                        color: '#64748b'
                    }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const bandName = labels[index];
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        searchInput.value = bandName;
                        if (window.refreshUI) window.refreshUI();
                        if (typeof window.closeChartModal === 'function') {
                            window.closeChartModal();
                        }
                    }
                }
            }
        }
    };

    console.log("Initializing new Chart.js instance...");
    try {
        const newChart = new Chart(canvas, chartConfig);
        if (isModal) {
            window.modalChartInstance = newChart;
        } else {
            dashboardTopBandsChart = newChart;
        }
        console.log("Chart rendered successfully.");
    } catch (err) {
        console.error("Chart.js Initialization Error:", err);
    }
};
/**
 * Global Modal Controller (Fixes Requirement 3)
 */
window.openChartModal = function(chartType) {
    const modal = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');
    if (!modal || !canvas) return;

    // Always destroy any existing chart on this canvas
    const existingChart = Chart.getChart(canvas);
    if (existingChart) {
        existingChart.destroy();
    }

    // Reset subtitle in case a drill-down left it in "Back to Yearly" state
    const subtitle = modal.querySelector('p.text-slate-400');
    if (subtitle) { subtitle.innerHTML = 'Interactive Data View'; subtitle.onclick = null; }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    const dataToUse = (window.filteredResults && window.filteredResults.length > 0)
        ? window.filteredResults
        : window.journalData;

    if (chartType === 'companion') {

        document.getElementById('modalChartTitle').innerText = "Companion Analysis";
        renderCompanionChart(dataToUse, 'modalChartCanvas', true);

    } else if (chartType === 'year') {

        document.getElementById('modalChartTitle').innerText = "Yearly Breakdown";
        renderYearChart(dataToUse, 'modalChartCanvas', true);

    } else if (chartType === 'songs') {

        document.getElementById('modalChartTitle').innerText = "Top Songs Leaderboard";
        renderTopSongsChart(dataToUse, 'modalChartCanvas', true);

    } else if (chartType === 'topbands') {

        document.getElementById('modalChartTitle').innerText = "Top Bands Leaderboard";
        renderTopBandsChart(
            dataToUse,
            window.performanceData,
            'modalChartCanvas',
            true
        );
    }

    if (window.lucide) lucide.createIcons();
};

window.closeChartModal = function() {

    const modal = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');

    // Destroy any chart attached to the canvas
    if (canvas) {
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }
    }

    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }

    document.body.style.overflow = 'auto';
};

/**
 * 4. TOP SONGS CHART (Horizontal Bar)
 */
let dashboardSongsChart = null;

export const renderTopSongsChart = (filteredJournal, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // 1. Precise Instance Management
    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    // 1. Create a cleaned set of keys from the active journal (the 1,622 entries)
    const currentKeys = new Set(
        filteredJournal
            .map(g => (g['Journal Key'] || g['JournalKey'] || "").toString().trim().toLowerCase())
            .filter(k => k !== "")
    );

    const songCounts = {};

    // 2. Scan performance data
    (window.performanceData || []).forEach(perf => {
        // Normalize the key in the performance row
        const pKey = (perf['Journal Key'] || perf['JournalKey'] || "").toString().trim().toLowerCase();

        // Only count if this performance belongs to the current "User" (Weezer)
        if (currentKeys.has(pKey)) {
            const setlistRaw = perf.Setlist || "";

            if (setlistRaw && setlistRaw !== "nan" && setlistRaw !== "NOT_FOUND") {
                // Split by Pipe, Comma, or Newline
                const songs = setlistRaw.split(/[|,\n;]/);

                songs.forEach(song => {
                    const cleanSong = song.trim();
                    const excludes = ['nan', 'not_found', 'unknown', 'null', ''];

                    if (cleanSong && !excludes.includes(cleanSong.toLowerCase())) {
                        songCounts[cleanSong] = (songCounts[cleanSong] || 0) + 1;
                    }
                });
            }
        }
    });

    // 3. Proper Limits (12 for small, 25 for modal)
    const limit = isModal ? 25 : 12;
    const sortedSongs = Object.entries(songCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

    const labels = sortedSongs.map(s => s[0]);
    const counts = sortedSongs.map(s => s[1]);

    // 4. Vibrant Color Palette
    const colors = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b',
        '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7'
    ];

    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: counts,
                backgroundColor: colors, // Chart.js will cycle through these
                borderRadius: 4,
                barThickness: isModal ? 12 : 10
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }, // RE-REMOVED: Legend gone
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
                    ticks: {
                        color: '#475569',
                        font: { size: isModal ? 10 : 9, weight: 'bold' }
                    }
                }
            },
            // 5. Interactive Filter
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const songName = labels[index];
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput) {
                        searchInput.value = songName;
                        if (window.refreshUI) window.refreshUI();
                        if (isModal && typeof window.closeChartModal === 'function') {
                            window.closeChartModal();
                        }
                    }
                }
            }
        }
    };

    new Chart(ctx, chartConfig);
};
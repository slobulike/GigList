/**
 * GigList — Collection Charts Module
 * -------------------------------------------------------------------
 * Stats-tab charts for the Collection view. Reads directly from
 * collection.js's own filter state via getFilteredItems()/hasActiveFilters()
 * rather than a separate filter module — collection.js already owns
 * curation/band/search/disposed filtering for the Collection tab itself,
 * so Stats just asks it what's currently visible.
 */
import { getChartColors, setChartEmptyState } from './charts.js';
import { getFilteredItems, hasActiveFilters, ensureLoaded } from './collection.js';

let dashboardItemTypeChart    = null;
let dashboardTopArtistsChart  = null;
let dashboardItemsVsGigsChart = null;

/**
 * 1. ITEM TYPE (Doughnut) — collection_items.type breakdown.
 */
export const renderItemTypeChart = (items, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const typeCounts = {};
    items.forEach(item => {
        const label = item.subtype || 'Other';
        typeCounts[label] = (typeCounts[label] || 0) + 1;
    });

    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);

    if (!isModal) {
        setChartEmptyState('itemTypeChartContainer', sorted.length === 0, {
            emptyMessage:    'No items in your collection yet',
            filteredMessage: 'No items match your current view',
            filtersActive:   hasActiveFilters(),
        });
    }
    if (sorted.length === 0) return;

    const labels = sorted.map(t => t[0]);
    const counts = sorted.map(t => t[1]);

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
            }
        }
    });

    if (!isModal) dashboardItemTypeChart = newChart;
};

/**
 * 2. TOP ARTISTS BY ITEM COUNT (Horizontal Bar) — collection_items.band_name
 * / band_id, denormalized directly onto each row so no join is needed.
 * Clicking a bar sets the Collection tab's own band filter (window._colSetBand),
 * matching how the Top Bands chart on Gigs Stats sets filters.js's artist filter.
 */
export const renderTopCollectionArtistsChart = (items, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const counts = {}; // band_id (or lowercased name if no id) -> { display, bandId, count }
    items.forEach(item => {
        const name = (item.band_name || '').trim();
        if (!name) return;
        const key = item.band_id ?? name.toLowerCase();
        counts[key] = counts[key] || { display: name, bandId: item.band_id ?? null, count: 0 };
        counts[key].count++;
    });

    const limit  = isModal ? 20 : 8;
    const sorted = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, limit);

    if (!isModal) {
        setChartEmptyState('topCollectionArtistsChartContainer', sorted.length === 0, {
            emptyMessage:    'No items in your collection yet',
            filteredMessage: 'No items match your current view',
            filtersActive:   hasActiveFilters(),
        });
    }
    if (sorted.length === 0) return;

    const labels = sorted.map(s => s.display);

    const newChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: sorted.map(s => s.count),
                backgroundColor: '#6366f1',
                borderRadius: isModal ? 8 : 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
                x: { beginAtZero: true, display: isModal, ticks: { precision: 0 } },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: { crossAlign: 'far', font: { weight: '800', size: 12 }, color: '#64748b' }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const bandId = sorted[elements[0].index].bandId;
                    if (bandId != null) window._colSetBand(bandId);
                    if (isModal) window.closeCollectionChartModal();
                }
            }
        }
    });

    if (!isModal) dashboardTopArtistsChart = newChart;
};

/**
 * 3. ITEMS VS GIGS PER ARTIST (Diverging Horizontal Bar).
 * Gigs seen (journalData) on the left, collection items owned on the
 * right, for the top-N artists by combined total. Matched on lowercased
 * band name rather than band_id, since journal rows have no band_id.
 */
export const renderItemsVsGigsChart = (collectionItems, journalData, canvasId, isModal = false) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    const gigCounts = {};
    (journalData || []).forEach(g => {
        const name = (g.Band || g.band || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        gigCounts[key] = gigCounts[key] || { display: name, count: 0 };
        gigCounts[key].count++;
    });

    const itemCounts = {};
    (collectionItems || []).forEach(item => {
        const name = (item.band_name || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        itemCounts[key] = itemCounts[key] || { display: name, count: 0 };
        itemCounts[key].count++;
    });

    const allKeys = new Set([...Object.keys(gigCounts), ...Object.keys(itemCounts)]);
    const combined = [...allKeys].map(key => ({
        display: gigCounts[key]?.display || itemCounts[key]?.display,
        gigs:  gigCounts[key]?.count || 0,
        items: itemCounts[key]?.count || 0,
    }));

    const limit = isModal ? 20 : 12;
    const top = combined
        .sort((a, b) => (b.gigs + b.items) - (a.gigs + a.items))
        .slice(0, limit);

    if (!isModal) {
        setChartEmptyState('itemsVsGigsChartContainer', top.length === 0, {
            emptyMessage:    'Log some shows or items to see this chart',
            filteredMessage: 'No artists match your current view',
            filtersActive:   hasActiveFilters() || (window._filtersModule?.hasActiveFilters?.() ?? false),
        });
    }
    if (top.length === 0) return;

    const labels = top.map(t => t.display);

    const newChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Gigs seen',
                    data: top.map(t => -t.gigs), // negative so it draws to the left
                    backgroundColor: '#1D3557',
                    borderRadius: 4
                },
                {
                    label: 'Items owned',
                    data: top.map(t => t.items),
                    backgroundColor: '#A8DADC',
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
                    display: true,
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 11, weight: 'bold' } }
                },
                tooltip: {
                    callbacks: {
                        label: (item) => `${item.dataset.label}: ${Math.abs(item.raw)}`
                    }
                }
            },
            scales: {
                x: { display: isModal, ticks: { callback: (val) => Math.abs(val) } },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: { crossAlign: 'far', font: { weight: '800', size: 12 }, color: '#64748b' }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const artistName = labels[elements[0].index];
                    // Sets the Gigs-side artist filter (filters.js). The
                    // Collection tab has no free-text artist filter — only
                    // band_id via window._colSetBand — and this chart matches
                    // on band name rather than band_id, so there's no reliable
                    // id to hand it here.
                    window._filtersModule?.setFilters({ artist: artistName });
                    if (isModal) window.closeCollectionChartModal();
                }
            }
        }
    });

    if (!isModal) dashboardItemsVsGigsChart = newChart;
};

/**
 * Modal controller for the Collection stats charts — mirrors charts.js's
 * window.openChartModal, reusing the same #chartModal markup since only
 * one chart modal is ever open at a time regardless of which Stats mode
 * is active.
 */
window.openCollectionChartModal = async function(chartType) {
    await window.ensureChartJs();

    const modal  = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');
    if (!modal || !canvas) return;

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    const subtitle = modal.querySelector('p.text-slate-400');
    if (subtitle) { subtitle.innerHTML = 'Interactive Data View'; subtitle.onclick = null; }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    const itemsToUse = getFilteredItems();
    const journalToUse = (window.filteredResults && window.filteredResults.length > 0)
        ? window.filteredResults
        : window.journalData;

    const titleEl = document.getElementById('modalChartTitle');

    if (chartType === 'itemtype') {
        if (titleEl) titleEl.innerText = "Collection by Type";
        renderItemTypeChart(itemsToUse, 'modalChartCanvas', true);
    } else if (chartType === 'topcollectionartists') {
        if (titleEl) titleEl.innerText = "Top Artists by Item Count";
        renderTopCollectionArtistsChart(itemsToUse, 'modalChartCanvas', true);
    } else if (chartType === 'itemsvsgigs') {
        if (titleEl) titleEl.innerText = "Items vs Gigs by Artist";
        renderItemsVsGigsChart(itemsToUse, journalToUse, 'modalChartCanvas', true);
    }

    if (window.lucide) lucide.createIcons();
};

window.closeCollectionChartModal = function() {
    window.closeChartModal?.();
};

/**
 * Renders all Collection dashboard charts using collection.js's current
 * filtered view. Called whenever the Stats tab switches to Collection
 * mode, and whenever collectionViewChanged fires while that mode is
 * active (see stats-switcher.js). Takes currentUser rather than an items
 * array since it needs to call ensureLoaded() itself for the case where
 * Stats is opened before the Collection tab ever has been.
 */
export const renderCollectionCharts = async (currentUser) => {
    await ensureLoaded(currentUser.id);
    const items = getFilteredItems();

    const journalToUse = (window.filteredResults && window.filteredResults.length > 0)
        ? window.filteredResults
        : (window.journalData || []);

    if (document.getElementById('itemTypeChart')) {
        renderItemTypeChart(items, 'itemTypeChart');
    }
    if (document.getElementById('topCollectionArtistsChart')) {
        renderTopCollectionArtistsChart(items, 'topCollectionArtistsChart');
    }
    if (document.getElementById('itemsVsGigsChart')) {
        renderItemsVsGigsChart(items, journalToUse, 'itemsVsGigsChart');
    }
};

window._collectionChartsModule = { renderCollectionCharts };
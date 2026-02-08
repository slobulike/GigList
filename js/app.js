/**
 * Gig List Core Engine

 V1.1.2 - Release Date 2026-02-08
 * -------------------------------------------------------------------
  * [FEATURE] Intelligent Countdown: Dynamic ticker with last or next gig logic
  * [FEATURE] Data Lab Expansion: Enable view of upcoming shows in data tab
  * [FEATURE] Home Carousel Update: New cards added for upcoming shows and festivals
  * [FIX] Seen Count: Ensures that all appearances across headline, support and festivals are included
  * [FIX] Scroll-Lock Fix: Resolved issue where scroll on data tab was not enabled after viewing details
  * [FIX] Leaflet (Map) initial load: Improvement to page load for map to improve load time and first load
  * [A11Y] ARIA labels: Future Toggle and Carousel cards


 V1.1.1 - Release Date 2026-02-07
 * -------------------------------------------------------------------
 * [FEATURE] Calendar Drill-Down: Interactive month detail "flip" cards
 * added to the year view, enabling direct modal access.
 * [FEATURE] Dynamic Ticket Variants: Implemented deterministic pastel
 * color-ways (Pink, Green, Yellow) and portrait/landscape
 * layouts for the "Mosh-Pit" ticket generator.
 * [A11Y]    Accessibility Gold Standard: Managed focus on modal open,
 * ARIA roles for charts/tickets, and screen-reader labels
 * for the calendar grid.
 * [FIX]     Cumulative Search: Search and companion-chart filters
 * now correctly query "Went With" data.
 * [FIX]     Home Page Baseline: Restored "Throwback" memory triggers
 * within the UI refresh router.
 * [CORE]    Automated Versioning: Linked UI build number to APP_VERSION
 * variable to eliminate hardcoding.

 V1.1.0 - Release Date 2026-02-05
 * -------------------------------------------------------------------
 Feature: "Mosh-Pit" Ticket Generation (Automatic fallback for missing photos).
 Feature: High-Res Chart Overlays (Interactive full-screen analytics).
 Feature: YouTube "Watch Clips" integration (Contextual live video search).
 Logic: Enhanced Festival Mode layout for multi-band days.
 Bugfix: Standardized "Festival?" field detection and chart legend labels.

 */

const APP_VERSION = "1.1.2";

let currentUser = JSON.parse(localStorage.getItem('gv_user'));
let journalData = [], performanceData = [], venueData = [];
let activeArtist = null, activeYear = null;
let yearChart, companionChart;
let homeCarousel = [];
let filteredResults = [];
let currentView = 'list';
let currentCarouselIndex = 0;

function getGlobalSeenCount(artistName) {
    const today = new Date();
    today.setHours(0,0,0,0);
    const searchName = artistName.toLowerCase();

    // 1. Check Journal (Headlines + Festival Lineups)
    const journalMatches = journalData.filter(g => {
        const isPast = parseDate(g.Date) < today;
        const isHeadline = g.Band.toLowerCase() === searchName;
        const isFest = g['Festival Lineups'] && g['Festival Lineups'].toLowerCase().includes(searchName);
        return isPast && (isHeadline || isFest);
    });

    // 2. Check Performance Data (Support slots / Notable Roles)
    // We filter for the artist name but exclude shows already counted as headliners
    const supportMatches = performanceData.filter(p => {
        const isPast = parseDate(p.Date) < today; // Assuming Date is in performanceData too
        const nameMatch = p.Artist.toLowerCase() === searchName;
        const alreadyCounted = journalMatches.some(j => j['Journal Key'] === p['Journal Key']);
        return isPast && nameMatch && !alreadyCounted;
    });

    return journalMatches.length + supportMatches.length;
}

async function loadData() {
    if (!currentUser) {
        window.location.href = 'index.html';
        return;
    }

    setDynamicFavicon();

    const identityEl = document.getElementById('userIdentity');
    if (identityEl) {
        identityEl.innerText = currentUser.UserName;
        const versionDisplay = document.getElementById('app-version-display');
        if (versionDisplay) versionDisplay.innerText = APP_VERSION;
        identityEl.style.cursor = 'pointer';
        identityEl.onclick = openSettings;
    }

    try {
        // Cache busting the fetches to ensure new CSV data appears immediately
        const cb = `?v=${new Date().getTime()}`;
        const [venues, perfs, journal, users] = await Promise.all([
            parseCSV('data/venues.csv' + cb),
            parseCSV('data/performances.csv' + cb),
            parseCSV(`data/${currentUser.JournalFile}${cb}`),
            parseCSV('data/users.csv' + cb)
        ]);

        venueData = venues;
        performanceData = perfs;
        journalData = journal.sort((a, b) => {
            const dateA = a.Date.split('/').reverse().join('');
            const dateB = b.Date.split('/').reverse().join('');
            return dateB.localeCompare(dateA);
        });

        const fullUser = users.find(u => u.UserID === currentUser.UserID);
        if (fullUser) {
            const rankEl = document.getElementById('stat-rank');
            if (rankEl) rankEl.innerText = fullUser.Rank || 'N/A';
        }

        updateDashboardStats();
        initMap();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.addEventListener('input', refreshUI);

        const card = document.getElementById('now-card');
        if (card) {
            card.addEventListener('click', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                rotateCarousel(x > rect.width / 2 ? 1 : -1);
            });
        }

        refreshUI();

    } catch (error) {
        console.error("Data Load Error:", error);
    }
}

function setDynamicFavicon() {
    const link = document.querySelector("link[rel~='icon']") || document.createElement('link');
    link.rel = 'icon';
    link.href = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎸</text></svg>";
    document.getElementsByTagName('head')[0].appendChild(link);
}

function updateDashboardStats() {
    const now = new Date();
    const dateOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    const dateHeader = document.querySelector('#view-home p.text-slate-400');
    if (dateHeader) dateHeader.innerText = now.toLocaleDateString('en-US', dateOptions);

    const totalGigs = journalData.length;
    const uniqueVenues = new Set(journalData.map(g => g.OfficialVenue)).size;
    const uniqueArtists = new Set(journalData.map(g => g.Band)).size;

    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = totalGigs;
    if (document.getElementById('stat-venues')) document.getElementById('stat-venues').innerText = uniqueVenues;
    if (document.getElementById('stat-artists')) document.getElementById('stat-artists').innerText = uniqueArtists;
}

function parseCSV(url) {
    return new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (err) => reject(err)
        });
    });
}

function updateDataCentreStats(filteredData) {
    const elGigs = document.getElementById('dc-stat-gigs');
    const elVenues = document.getElementById('dc-stat-venues');
    const elArtists = document.getElementById('dc-stat-artists');

    if (elGigs) elGigs.innerText = filteredData.length;
    if (elVenues) elVenues.innerText = new Set(filteredData.map(item => item.OfficialVenue)).size;
    if (elArtists) elArtists.innerText = new Set(filteredData.map(item => item.Band)).size;
}

function refreshUI() {
    // --- START SCROLL FIX ---
    // If we are in 'list' view, we almost certainly want to be able to scroll
    if (currentView === 'list' || currentView === 'home') {
        document.body.style.overflow = 'auto';
        document.body.style.height = 'auto';
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const toggleEl = document.getElementById('toggleFuture');
    const includeFuture = toggleEl?.checked || false;
    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

    // 1. Accessibility
    if (toggleEl) toggleEl.setAttribute('aria-checked', includeFuture);

    // 2. Filter Logic
const filtered = journalData.map(row => {
        const band = (row['Band'] || "").toLowerCase();
        const venue = (row['OfficialVenue'] || "").toLowerCase();
        const lineup = (row['Festival Lineups'] || "").toLowerCase();
        // Ensure we grab the companion column - typically 'Went With' in your CSV
        const companion = (row['Went With'] || "").toLowerCase();
        const journalKey = row['Journal Key'];

        // 1. Existing Match Logics
        const hasSongMatch = query.length > 2 && performanceData.some(p =>
            p['Journal Key'] === journalKey && (p['Setlist'] || "").toLowerCase().includes(query)
        );

        const isFestivalMatch = query.length > 2 && !band.includes(query) && lineup.includes(query);

        const isSupportMatch = query.length > 2 && !isFestivalMatch && performanceData.some(p =>
            p['Journal Key'] === journalKey &&
            p.Artist.toLowerCase().includes(query) &&
            band !== p.Artist.toLowerCase()
        );

        // 2. RE-FIX: The Master Search Match
        // We combine all searchable text fields into one string for the query to check
        const matchSearch = `${band} ${venue} ${lineup} ${companion}`.includes(query) ||
                            hasSongMatch ||
                            isSupportMatch;

        // 3. Keep existing Artist/Year/Future filters
        const matchArtist = !activeArtist || band === activeArtist.toLowerCase() || lineup.includes(activeArtist.toLowerCase()) || isSupportMatch;
        const matchYear = !activeYear || row.Date.endsWith(activeYear);
        const gigDate = parseDate(row.Date);
        const matchFuture = includeFuture ? true : gigDate < today;

        return {
            ...row,
            _isSongMatch: hasSongMatch,
            _isFestMatch: isFestivalMatch,
            _isSupportMatch: isSupportMatch,
            _visible: matchSearch && matchArtist && matchYear && matchFuture
        };
    }).filter(r => r._visible);

    // 3. Visual Styling for Toggles
    // Future Toggle Style
    const toggleBg = document.querySelector('.toggle-bg');
    const toggleDot = document.querySelector('.toggle-dot');
    const toggleText = document.getElementById('toggleText');

    if (toggleBg && toggleDot) {
        if (includeFuture) {
            toggleBg.className = 'toggle-bg w-10 h-5 rounded-full transition-colors duration-300 bg-emerald-500';
            toggleDot.style.transform = 'translateX(20px)';
            if (toggleText) {
                toggleText.innerText = "Future Included";
                toggleText.className = "text-[10px] font-black uppercase tracking-wider text-emerald-600";
            }
        } else {
            toggleBg.className = 'toggle-bg w-10 h-5 rounded-full transition-colors duration-300 bg-slate-200';
            toggleDot.style.transform = 'translateX(0px)';
            if (toggleText) {
                toggleText.innerText = "Include Future";
                toggleText.className = "text-[10px] font-black uppercase tracking-wider text-slate-500";
            }
        }
    }

    // View Switcher Style (List vs Calendar)
    const btnList = document.getElementById('btn-list');
    const btnCal = document.getElementById('btn-calendar');
    if (btnList && btnCal) {
        if (currentView === 'list') {
            btnList.className = "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider bg-white text-indigo-600 shadow-sm";
            btnCal.className = "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider text-slate-400";
        } else {
            btnCal.className = "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider bg-white text-indigo-600 shadow-sm";
            btnList.className = "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider text-slate-400";
        }
    }

    filteredResults = filtered;
    if (typeof renderCharts === "function") renderCharts(filtered);
    filteredResults.sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    updateDataCentreStats(filtered);

    // ROUTING
    if (currentView === 'list') {
        if (document.getElementById('gigTable')) renderTable(filtered, query);
    } else {
        renderCalendarView();
    }

    if (typeof window.loadThrowback === "function") window.loadThrowback(journalData);
    if (typeof renderCharts === "function") renderCharts(filtered);
    if (window.leafletMap && typeof updateMap === "function") updateMap(filtered, venueData);
    if (window.lucide) lucide.createIcons();
}

window.openChartModal = function(chartType) {
    const modal = document.getElementById('chartModal');
    const canvas = document.getElementById('modalChartCanvas');
    if (!modal || !canvas) return;

    // 1. Open the UI and lock scroll
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // 2. Kill any old chart sitting in the modal
    if (window.modalChartInstance) window.modalChartInstance.destroy();

    // 3. Get the data currently visible in your table
    const data = (typeof filteredResults !== 'undefined' && filteredResults.length > 0)
                 ? filteredResults
                 : journalData;

    // 4. Draw the high-res version
    const ctx = canvas.getContext('2d');

    // Logic branches based on your two specific charts
    if (chartType === 'companion') {
        renderCompanionChart(data, 'modalChartCanvas', true);
        document.getElementById('modalChartTitle').innerText = "Companion Analysis";
    } else if (chartType === 'year') {
        renderYearChart(data, 'modalChartCanvas', true);
        document.getElementById('modalChartTitle').innerText = "Yearly Breakdown";
    }

    if (window.lucide) lucide.createIcons();
};

window.closeChartModal = function() {
    document.getElementById('chartModal').classList.add('hidden');
    document.body.style.overflow = 'auto'; // Unlock scroll
    if (window.modalChartInstance) window.modalChartInstance.destroy();
};

window.renderCompanionChart = function(data, canvasId = 'companionChart', isModal = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Process Data
    const companionCounts = {};
    data.forEach(row => {
        const friends = (row['Went With'] || "").split(/[,\/&]/).map(f => f.trim()).filter(f => f && f !== "Alone" && f !== "nan");
        friends.forEach(f => { companionCounts[f] = (companionCounts[f] || 0) + 1; });
    });

    const sorted = Object.entries(companionCounts).sort((a, b) => b[1] - a[1]).slice(0, 7);

    const chart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: sorted.map(x => x[0]),
            datasets: [{
                data: sorted.map(x => x[1]),
                backgroundColor: ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#06b6d4'],
                borderWidth: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: isModal, // Legend only shows in the big modal
                    position: 'bottom'
                }
            }
        }
    });

    // If this is for the modal, save it so we can destroy it later
    if (isModal) window.modalChartInstance = chart;
};

window.renderYearChart = function(data, canvasId = 'yearChart', isModal = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // 1. Group gigs by year
    const yearCounts = {};
    data.forEach(row => {
        if (row.Date) {
            const year = row.Date.split('/').pop();
            yearCounts[year] = (yearCounts[year] || 0) + 1;
        }
    });

    const sortedYears = Object.keys(yearCounts).sort();

    // 2. Create the Chart
    const chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedYears,
            datasets: [{
                label: 'Gigs',
                data: sortedYears.map(y => yearCounts[y]),
                backgroundColor: '#6366f1',
                borderRadius: 6
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { display: false }, ticks: { font: { weight: 'bold' } } },
                x: { grid: { display: false }, ticks: { font: { weight: 'bold' } } }
            },
            plugins: {
                legend: { display: false } // We don't need a legend for a single-bar chart
            }
        }
    });

    if (isModal) window.modalChartInstance = chart;
};

function renderYearChart(data, canvasId = 'yearChart', isModal = false) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    // If we are drawing in the modal, we save the instance to a specific variable
    const chart = new Chart(ctx, {
        // ... your existing chart config
        options: {
            maintainAspectRatio: false,
            // You can use isModal to make text bigger for the expanded view
            plugins: {
                legend: { display: isModal ? true : false }
            }
        }
    });

    if (isModal) window.modalChartInstance = chart;
}

function renderArtistChart(data, canvasId, isModal = false) {
    // ... logic to count artists ...

    const ctx = document.getElementById(canvasId).getContext('2d');
    window.modalChartInstance = new Chart(ctx, {
        type: 'bar',
        data: { /* ... */ },
        options: {
            maintainAspectRatio: false,
            responsive: true,
            // Increase font size if isModal is true
            scales: {
                x: { ticks: { font: { size: isModal ? 14 : 10 } } }
            }
        }
    });
}

function renderTable(data, query) {
    const tbody = document.getElementById('gigTable');
    if (!tbody) return;

    tbody.innerHTML = data.map(row => {
        const photos = row.Photos && row.Photos !== "nan" && row.Photos !== "" ?
            `<a href="${row.Photos}" target="_blank" onclick="event.stopPropagation()" aria-label="View photo album">
                <i data-lucide="camera" class="w-4 h-4"></i>
            </a>` : '';

        const safeKey = row['Journal Key'].replace(/'/g, "\\'");

        // Build Badge Labels
// Build Badge Labels
        let matchLabels = '';

        // SUPPORT MATCH (Blue)
        if (row._isSupportMatch) {
            matchLabels += `
                <span class="inline-flex items-center gap-1 text-[9px] bg-blue-500/10 text-blue-600 font-black uppercase px-2 py-0.5 rounded-full" role="note" aria-label="Matches support artist">
                    <i data-lucide="mic-2" class="w-2.5 h-2.5"></i> Support Match
                </span>`;
        }

        // FESTIVAL LINEUP MATCH (Amber)
        if (row._isFestMatch) {
            matchLabels += `
                <span class="inline-flex items-center gap-1 text-[9px] bg-amber-500/10 text-amber-600 font-black uppercase px-2 py-0.5 rounded-full" role="note" aria-label="Matches festival lineup">
                    <i data-lucide="users" class="w-2.5 h-2.5"></i> Lineup Match
                </span>`;
        }

        // SONG/SETLIST MATCH (Emerald)
        if (row._isSongMatch) {
            matchLabels += `
                <span class="inline-flex items-center gap-1 text-[9px] bg-emerald-500/10 text-emerald-600 font-black uppercase px-2 py-0.5 rounded-full" role="note" aria-label="Matches song in setlist">
                    <i data-lucide="music" class="w-2.5 h-2.5"></i> Setlist Match
                </span>`;
        }

        return `
            <tr class="hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors"
                onclick="openModal('${safeKey}')" role="button" tabindex="0"
                aria-label="View details for ${row.Band} at ${row.OfficialVenue}">
                <td class="px-4 py-4 text-[10px] font-bold text-slate-500 font-mono w-24">${row.Date}</td>
                <td class="px-4 py-4 w-1/2">
                    <div class="font-bold text-slate-700 text-sm">${row.Band}</div>
                    <div class="flex flex-wrap gap-1 mt-1">${matchLabels}</div>
                </td>
                <td class="px-4 py-4 text-xs text-slate-600">${row.OfficialVenue}</td>
                <td class="px-4 py-4 text-center w-12">${photos}</td>
            </tr>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

/**
 * BADGE SYSTEM LOGIC
 */
function renderBadges() {
    const badgeContainer = document.getElementById('badges-grid');
    if (!badgeContainer) return;

    badgeContainer.setAttribute('role', 'region');
    badgeContainer.setAttribute('aria-label', 'Achievement trophies');

    const totalGigs = journalData.length;
    const artistCounts = {};
    const venueCounts = {};

    journalData.forEach(entry => {
        artistCounts[entry.Band] = (artistCounts[entry.Band] || 0) + 1;
        venueCounts[entry.OfficialVenue] = (venueCounts[entry.OfficialVenue] || 0) + 1;
    });

    const maxArtistShows = Math.max(...Object.values(artistCounts), 0);
    const maxVenueVisits = Math.max(...Object.values(venueCounts), 0);
    const uniqueVenues = new Set(journalData.map(j => j.OfficialVenue)).size;

    const badgeDefs = [
        { id: 'first-gig', name: 'The Beginning', desc: 'Attended your first show', icon: 'ticket', earned: totalGigs >= 1 },
        { id: 'fifty-gigs', name: 'Gig Regular', desc: 'Reached 50 lifetime gigs', icon: 'star', earned: totalGigs >= 50 },
        { id: 'century-club', name: 'Century Club', desc: 'Reached 100 lifetime gigs', icon: 'award', earned: totalGigs >= 100 },
        { id: 'superfan', name: 'Superfan', desc: 'Seen the same artist 10+ times', icon: 'heart', earned: maxArtistShows >= 10, sub: `Max: ${maxArtistShows} shows` },
        { id: 'regular', name: 'Home from Home', desc: 'Visited the same venue 5+ times', icon: 'home', earned: maxVenueVisits >= 5, sub: `Max: ${maxVenueVisits} visits` },
        { id: 'explorer', name: 'Venue Explorer', desc: 'Visited 10+ different venues', icon: 'map-pin', earned: uniqueVenues >= 10, sub: `${uniqueVenues} venues found` },
        { id: 'obsessed', name: 'Officially Obsessed', desc: 'Seen the same artist 25+ times', icon: 'crown', earned: maxArtistShows >= 25, sub: maxArtistShows > 0 ? `Max: ${maxArtistShows} shows` : '' },
        { id: 'monthly-resident', name: 'Local Hero', desc: 'Attended a gig in 3 consecutive months', icon: 'calendar-days', earned: checkConsecutiveMonths(journalData) >= 3 },
        {
            id: 'festival-pro',
            name: 'Mud & Music',
            desc: 'Attended 3+ Festivals',
            icon: 'tent',
            earned: journalData.filter(g => {
                const festValue = g['Festival?'] || g['Festival? Y/N'] || "";
                return festValue.trim().toUpperCase() === 'Y';
            }).length >= 3
        }
    ];

    badgeContainer.innerHTML = badgeDefs.map(badge => `
        <div class="relative group p-6 rounded-3xl border-2 transition-all duration-500 ${badge.earned ? 'bg-white border-indigo-100 shadow-xl shadow-indigo-50/50' : 'bg-slate-50/50 border-slate-100 opacity-60'}"
             role="img" aria-label="${badge.earned ? 'Earned' : 'Locked'} Achievement: ${badge.name}. ${badge.desc}">
            <div class="flex flex-col items-center text-center space-y-4" aria-hidden="true">
                <div class="w-16 h-16 rounded-2xl flex items-center justify-center ${badge.earned ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 rotate-3 group-hover:rotate-0' : 'bg-slate-200 text-slate-400'} transition-transform">
                    <i data-lucide="${badge.earned ? badge.icon : 'lock'}" class="w-8 h-8"></i>
                </div>
                <div>
                    <h3 class="font-black text-slate-900 uppercase tracking-tighter">${badge.name}</h3>
                    <p class="text-xs text-slate-500 font-medium leading-tight mt-1">${badge.desc}</p>
                </div>
                ${badge.earned && badge.sub ? `<div class="text-[10px] font-black text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full uppercase">${badge.sub}</div>` : ''}
            </div>
            ${badge.earned ? `<div class="absolute -top-2 -right-2 bg-emerald-500 text-white p-1 rounded-full shadow-lg" aria-hidden="true"><i data-lucide="check" class="w-3 h-3"></i></div>` : ''}
        </div>
    `).join('');

    if (window.lucide) lucide.createIcons();
}

function checkConsecutiveMonths(data) {
    if (!data || data.length === 0) return 0;
    const activeMonths = [...new Set(data.map(g => {
        const parts = g.Date.split('/');
        return `${parts[2]}-${parts[1].padStart(2, '0')}`;
    }))].sort();

    let maxStreak = 0, currentStreak = 0, lastMonth = null;
    activeMonths.forEach(monthStr => {
        const current = new Date(monthStr + "-01");
        if (lastMonth) {
            const diff = (current.getFullYear() - lastMonth.getFullYear()) * 12 + (current.getMonth() - lastMonth.getMonth());
            currentStreak = (diff === 1) ? currentStreak + 1 : 1;
        } else {
            currentStreak = 1;
        }
        lastMonth = current;
        maxStreak = Math.max(maxStreak, currentStreak);
    });
    return maxStreak;
}

function renderCharts(filtered) {
    const yearCanvas = document.getElementById('yearChart');
    if (!yearCanvas) return;

    const allYears = journalData.map(r => r.Date.split('/')[2]).filter(Boolean);
    const minYear = Math.min(...allYears);
    const maxYear = Math.max(...allYears);
    const fullTimelineLabels = [];
    for (let i = minYear; i <= maxYear; i++) { fullTimelineLabels.push(i.toString()); }

    const filteredCounts = {};
    filtered.forEach(r => {
        const y = r.Date.split('/')[2];
        if(y) filteredCounts[y] = (filteredCounts[y] || 0) + 1;
    });

    if (yearChart) yearChart.destroy();
    yearChart = new Chart(yearCanvas, {
        type: 'bar',
        data: {
            labels: fullTimelineLabels,
            datasets: [{
                data: fullTimelineLabels.map(y => filteredCounts[y] || 0),
                backgroundColor: '#4f46e5',
                borderRadius: 4
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { display: false },
                x: { grid: { display: false }, ticks: { font: { size: 8 }, autoSkip: true } }
            },
            onClick: (e, el) => {
                if(el.length) {
                    const selectedYear = fullTimelineLabels[el[0].index];
                    activeYear = (activeYear === selectedYear) ? null : selectedYear;
                    refreshUI();
                }
            }
        }
    });

    const compCanvas = document.getElementById('companionChart');
    if (!compCanvas) return;

    const companions = {};
    filtered.forEach(r => {
        (r['Went With'] || "").split(/[,\/&]/).forEach(n => {
            const name = n.trim();
            if(name && name !== "nan" && name !== "Alone") companions[name] = (companions[name] || 0) + 1;
        });
    });
    const topComps = Object.entries(companions).sort((a,b) => b[1]-a[1]).slice(0, 10);

    if (companionChart) companionChart.destroy();
    companionChart = new Chart(compCanvas, {
        type: 'doughnut',
        data: {
            labels: topComps.map(c => c[0]),
            datasets: [{
                data: topComps.map(c => c[1]),
                backgroundColor: ['#4f46e5', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#06b6d4', '#84cc16', '#ef4444', '#f97316'],
                borderWeight: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            cutout: '70%',
            onClick: (e, activeElements) => {
                if (activeElements.length > 0) {
                    const clickedName = companionChart.data.labels[activeElements[0].index];
                    document.getElementById('searchInput').value = clickedName;
                    refreshUI();
                }
            }
        }
    });
}

window.switchView = function(viewId) {
    // 1. SCROLL FIX: Wrap in setTimeout to ensure it happens AFTER the DOM update
    setTimeout(() => {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0; // For Safari
        document.documentElement.scrollTop = 0; // For Chrome, Firefox, IE and Opera
    }, 0);

    // 2. VIEW TOGGLING
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));

    if (viewId === 'home') {
        renderCarouselItem(0);
    }

    const targetView = document.getElementById(`view-${viewId}`);
    if (targetView) targetView.classList.remove('hidden');

    // 3. NAV HIGHLIGHTING
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active', 'text-indigo-600');
        n.classList.add('text-slate-400');
    });

    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) activeNav.classList.add('active', 'text-indigo-600');

    // 4. MAP FIXES
    if (viewId === 'map' && window.leafletMap) {
        window.leafletMap.invalidateSize({ animate: false });
        setTimeout(() => {
            window.leafletMap.invalidateSize();
            window.leafletMap.eachLayer(layer => {
                if (layer.options && layer.options.layers || layer._url) {
                    layer.redraw();
                }
            });
        }, 100);
    }

    // 5. ACHIEVEMENTS
    if (viewId === 'achievements') {
        renderBadges();
    }
};

window.loadThrowback = function(gigs) {
    if (homeCarousel.length > 0) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    // 1. DEFINE BASE DATA ARRAYS (Used for Ticker AND Carousel)
    const upcomingGigs = gigs.filter(g => parseDate(g.Date) >= today)
                         .sort((a, b) => parseDate(a.Date) - parseDate(b.Date));

    const pastGigs = gigs.filter(g => parseDate(g.Date) < today)
                         .sort((a, b) => parseDate(b.Date) - parseDate(a.Date)); // Newest first

    // 2. TICKER LOGIC (Now using the arrays defined above)
const tickerEl = document.getElementById('global-ticker');
    if (tickerEl) {
        if (upcomingGigs.length > 0) {
            const next = upcomingGigs[0];
            const diff = parseDate(next.Date) - today;
            const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
            tickerEl.innerHTML = `
                <div class="flex flex-col items-center w-full">
                    <div class="flex items-center text-[12px] tracking-[0.2em] mb-1 opacity-70">
                        <span class="text-emerald-500 animate-pulse mr-2 text-xs">●</span>
                        ${days} ${days === 1 ? 'DAY' : 'DAYS'} UNTIL
                    </div>
                    <div class="text-slate-900 leading-tight break-words px-4">
                        ${next.Band.toUpperCase()}
                    </div>
                </div>
            `;
        } else if (pastGigs.length > 0) {
            const last = pastGigs[0];
            const diff = today - parseDate(last.Date);
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            tickerEl.innerHTML = `
                <div class="flex flex-col items-center w-full">
                    <div class="flex items-center text-[12px] tracking-[0.2em] mb-1 opacity-70">
                        <span class="text-slate-300 mr-2 text-xs">○</span>
                        ${days} ${days === 1 ? 'DAY' : 'DAYS'} SINCE
                    </div>
                    <div class="text-slate-600 leading-tight break-words px-4">
                        ${last.Band.toUpperCase()}
                    </div>
                </div>
            `;
        }
    }

    // 3. CAROUSEL: FUTURE GIGS
    const futureItems = upcomingGigs.map(g => ({ ...g, type: 'upcoming' }));

    // 4. CAROUSEL: ANNIVERSARY GIGS
    const anniversaries = pastGigs.filter(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        return d === currentDay && m === currentMonth;
    }).map(g => ({ ...g, type: 'anniversary' }));

    // 5. CAROUSEL: MONTH MEMORIES
    const monthMemories = pastGigs.filter(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        return m === currentMonth && d !== currentDay;
    }).sort(() => Math.random() - 0.5).map(g => ({ ...g, type: 'memory' }));

    // 6. COMBINE (All Upcoming + 3 Historical)
    const historicalPool = [...anniversaries, ...monthMemories].slice(0, 3);
    const combined = [...futureItems, ...historicalPool].map(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        const yearsAgo = today.getFullYear() - y;

        let badge = "";
        if (g.type === 'upcoming') badge = "Upcoming Show";
        else if (g.type === 'anniversary') badge = `${yearsAgo} Year Anniversary`;
        else badge = `Memory from ${today.toLocaleString('default', { month: 'long' })}`;

        const cleanVenue = g.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const formattedDate = `${y}-${m < 10 ? '0'+m : m}-${d < 10 ? '0'+d : d}`;

        return {
            ...g,
            band: g.Band,
            details: `${g.OfficialVenue} • ${g.Date}`,
            badge: badge,
            image: g.type === 'upcoming' ? `https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&q=80` : `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`,
            isCTA: false,
            isFuture: g.type === 'upcoming'
        };
    });

    // 7. THE CTA CARD
    combined.push({
        band: "Ready for more?",
        details: "Tap here to delve deeper into the Data Lab.",
        badge: "Next Step",
        image: "https://images.unsplash.com/photo-1514525253361-b83f859b73c0?auto=format&fit=crop&q=80",
        isCTA: true,
        isFuture: false
    });

    homeCarousel = combined;
    renderCarouselItem(0);
};
// --- NEW: Default Image Pool ---
const defaultImages = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800", // Stage Lights
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800", // Crowd/Hands
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800"  // Deep Atmosphere
];

function renderCarouselItem(index) {
    const card = document.getElementById('now-card');
    if (!card || !homeCarousel[index]) return;

    const item = homeCarousel[index];
    currentCarouselIndex = index;
    const fallbackImage = defaultImages[index % defaultImages.length];

    const getOptimizedUrl = (url) => {
        if (!url) return '';
        if (url.includes('unsplash.com')) {
            const baseUrl = url.split('?')[0];
            return `${baseUrl}?auto=format&fit=crop&w=800&q=75`;
        }
        return url;
    };

    const displayImage = getOptimizedUrl(item.image);

    // 1. DYNAMIC COLOR & STATS FOR FUTURE GIGS
    const accentClass = item.isFuture ? 'bg-emerald-600' : 'bg-indigo-600';
    const hoverClass = item.isFuture ? 'group-hover:text-emerald-400' : 'group-hover:text-indigo-400';

let historicalSubtext = item.details;
if (item.isFuture) {
        // Use the new global helper
        const count = getGlobalSeenCount(item.band);

        const isFest = item['Festival?'] && item['Festival?'].trim().toUpperCase().startsWith('Y');
        const verb = isFest ? "Been" : "Seen";

        historicalSubtext = count > 0
            ? `🔥 ${verb} ${count} times before`
            : `✨ First time ${isFest ? 'going' : 'seeing them'}!`;
    }

    // 2. ACCESSIBILITY LABEL
    const a11yLabel = item.isCTA
        ? "Ready for more? Tap right for Data Lab, tap left for previous memory."
        : `${item.badge}: ${item.band}. ${item.isFuture ? 'Upcoming show.' : ''} Tap right for next, left for previous.`;

    // 3. RENDER BLOCK
    card.innerHTML = `
        <div class="relative h-full w-full overflow-hidden rounded-[2.5rem] bg-slate-900"
             role="region" aria-label="Gig Carousel">

            <img src="${displayImage}"
                 class="absolute inset-0 w-full h-full object-cover shadow-inner opacity-60"
                 loading="lazy"
                 alt="" aria-hidden="true"
                 onerror="this.src='${fallbackImage}'">

            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-950/40 to-transparent" aria-hidden="true"></div>

            <div class="absolute inset-0 z-20 flex">
                <div onclick="event.stopPropagation(); rotateCarousel(-1)"
                     class="h-full w-1/2 cursor-w-resize"
                     role="button" aria-label="Previous card"></div>

                <div onclick="event.stopPropagation(); rotateCarousel(1)"
                     class="h-full w-1/2 cursor-e-resize"
                     role="button" aria-label="Next card"></div>
            </div>

            <div class="absolute inset-0 z-30 p-8 flex flex-col justify-end pointer-events-none">
                <div class="pointer-events-auto max-w-[85%]">
                    <div onclick="event.stopPropagation(); ${item.isCTA ? "toggleView('list')" : (item.isFuture ? "" : "openModal('" + item['Journal Key'] + "')")}"
                         class="cursor-pointer group"
                         role="button" tabindex="0" aria-label="${a11yLabel}">

                        <span class="inline-block ${accentClass} text-white text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-3">
                            ${item.badge}
                        </span>

                        <h3 class="text-3xl font-black text-white italic tracking-tighter leading-none mb-1 ${hoverClass} transition-colors">
                            ${item.band}
                        </h3>

                        <p class="text-slate-300 font-bold text-sm">
                            ${item.details}
                        </p>

                        ${item.isFuture ? `<p class="text-emerald-400 font-black text-[10px] uppercase mt-2 tracking-widest">${historicalSubtext}</p>` : ''}
                    </div>

                    <div class="flex gap-1.5 mt-6">
                        ${homeCarousel.map((_, i) => `
                            <div onclick="event.stopPropagation(); renderCarouselItem(${i})"
                                 class="h-1 rounded-full transition-all duration-300 ${i === index ? 'w-8 ' + (item.isFuture ? 'bg-emerald-500' : 'bg-indigo-500') : 'w-2 bg-white/30 hover:bg-white/50'}"
                                 role="button" aria-label="Slide ${i + 1}">
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function rotateCarousel(direction) {
    const isLastCard = currentCarouselIndex === homeCarousel.length - 1;

    // 1. Handle Right Click on the last card
    if (isLastCard && direction === 1) {
        switchView('data');
        return;
    }

    // 2. Handle Left Click on the first card (stay on first)
    if (currentCarouselIndex === 0 && direction === -1) {
        return;
    }

    // 3. Normal Step
    const nextIndex = currentCarouselIndex + direction;

    // Safety check to ensure we stay within the 4 cards
    if (nextIndex >= 0 && nextIndex < homeCarousel.length) {
        renderCarouselItem(nextIndex);
    }
}

async function openModal(journalKey) {
// RESET MODAL SCROLL FIRST
    const modalBody = document.querySelector('#gigModal .overflow-y-auto');
    if (modalBody) modalBody.scrollTop = 0;
    const entry = journalData.find(j => j['Journal Key'] === journalKey);
    const sets = performanceData.filter(p => p['Journal Key'] === journalKey);

    // 1. FESTIVAL DETECTION
    // Check the dedicated field. We'll check for "Y" or "Yes" just in case.
    const isFestival = entry['Festival?'] && entry['Festival?'].trim().toUpperCase().startsWith('Y');

    // 2. COMPANIONS
    const companionList = entry['Went With'] && entry['Went With'] !== "nan" && entry['Went With'] !== "Alone"
        ? entry['Went With'].split(/[,\/&]/).map(n =>
            `<span class="bg-indigo-500/20 text-white text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider">${n.trim()}</span>`
          ).join('')
        : `<span class="text-[9px] opacity-60 italic text-indigo-200">Solo Mission</span>`;

// 3. HEADER & BUTTONS
const ytQuery = encodeURIComponent(`${entry.Band} live ${entry.OfficialVenue} ${entry.Date}`);
const youtubeLink = `https://www.youtube.com/results?search_query=${ytQuery}`;

// Define the buttons/badges area
const headerActions = `
    <div class="flex items-center gap-2 mb-2">
        <a href="${youtubeLink}" target="_blank" class="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-[9px] font-black px-3 py-1.5 rounded-full transition-all transform hover:scale-105 shadow-md">
             <i data-lucide="play-circle" class="w-3"></i> WATCH CLIPS
        </a>
        ${isFestival ? '<span class="bg-amber-400 text-black text-[8px] font-black px-2 py-1 rounded uppercase tracking-widest">Festival</span>' : ''}
    </div>
`;

document.getElementById('mTitleArea').innerHTML = `
    ${headerActions}

    <h2 class="text-3xl font-black italic uppercase leading-tight pr-8">${entry.Band}</h2>

    <div class="flex flex-wrap items-center gap-3 mt-3">
        <div class="text-[10px] font-bold uppercase tracking-widest opacity-70" aria-label="Show Date"><i data-lucide="calendar" class="w-3 inline mr-1"></i>${entry.Date}</div>
        <div class="text-[10px] font-bold uppercase tracking-widest opacity-70" aria-label="Venue"><i data-lucide="map-pin" class="w-3 inline mr-1"></i>${entry.OfficialVenue}</div>
    </div>

    <div class="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-white/10">
        <i data-lucide="users" class="w-3 text-indigo-300"></i>
        ${companionList}
    </div>
`;

// 4. PHOTO & TICKET LOGIC
    const dateParts = entry.Date.split('/');
    const formattedDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    const cleanVenue = entry.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const imagePath = `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`;

    let imageHTML = '';

    try {
        const response = await fetch(imagePath, { method: 'HEAD' });
        if (response.ok) {
            imageHTML = `
                <div class="md:col-span-full flex justify-center py-6" role="img" aria-label="Photo of memorabilia from ${entry.Band}">
                    <div class="polaroid">
                        <img src="${imagePath}" alt="Gig Memorabilia">
                        <p class="mt-4 font-handwriting text-slate-500 text-center text-2xl" aria-hidden="true">${entry.Band}</p>
                    </div>
                </div>`;
        } else {
            // Get Support Acts and Style
            const supportActs = sets
                .filter(s => s.Artist.toLowerCase() !== entry.Band.toLowerCase())
                .map(s => s.Artist)
                .join(' + ');

            const displayPrice = entry.Price && entry.Price !== "nan" ? entry.Price : `£${(Math.random() * (15 - 8) + 8).toFixed(2)}`;
            const style = getTicketStyle(entry['Journal Key']);
            const isLandscape = style.type === 'landscape';

imageHTML = `
            <div class="md:col-span-full flex justify-center py-6 px-4" role="region" aria-label="Digital Souvenir Ticket">
                <div class="mock-ticket transform ${isLandscape ? 'max-w-md w-full' : 'w-64'} -rotate-1 shadow-2xl ${style.color} ${style.border} border-2 p-6 transition-all hover:rotate-0">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-[9px] font-black border border-current px-1 uppercase ${style.accent}">General Admission</span>
                        <span class="text-[9px] font-black italic uppercase tracking-widest ${style.accent} opacity-40">Gig List</span>
                    </div>
                    <div class="thermal-text text-2xl mb-0.5 leading-none ${style.accent}">${entry.Band}</div>
                    ${supportActs ? `<div class="text-[10px] font-bold mb-2 uppercase tracking-tight opacity-70 ${style.accent}">+ ${supportActs}</div>` : '<div class="mb-2"></div>'}
                    <div class="thermal-text text-sm mb-4 opacity-80 ${style.accent}">${entry.OfficialVenue}</div>
                    <div class="flex justify-between text-[11px] font-bold mb-2 border-t border-b border-black/10 py-2 ${style.accent}">
                        <span>DATE: ${entry.Date}</span>
                        <span>PRICE: ${displayPrice}</span>
                    </div>
                    <div class="mt-4 ${isLandscape ? 'h-10' : 'h-8'} bg-black w-full" style="background: repeating-linear-gradient(90deg, #000, #000 2px, transparent 2px, transparent 4px); opacity: 0.15;"></div>
                </div>
            </div>`;
    }
    } catch (e) {
        console.error("Ticket generation failed", e);
    }

    // 5. NOTES
    const notesHTML = entry.Comments && entry.Comments !== "nan" ?
        `<div class="md:col-span-full p-6 bg-amber-50 border-l-4 border-amber-400 italic text-slate-700 text-sm rounded-r-2xl shadow-sm mb-4">"${entry.Comments}"</div>` : '';

    // 6. SETLIST GRID
    const gridClass = isFestival ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'flex flex-col gap-6';

const setlistHTML = sets.map(s => `
        <div class="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm" role="article" aria-label="Setlist for ${s.Artist}">
            <div class="flex justify-between items-center mb-3 border-b border-slate-50 pb-3">
                <div class="font-black text-indigo-600 text-sm">${s.Artist}</div>
                <span class="text-[7px] font-black px-2 py-0.5 bg-slate-100 rounded-lg uppercase text-slate-400">${s.Role}</span>
            </div>
            <div class="text-[10px] text-slate-500 leading-relaxed font-medium">
                ${(s.Setlist || "No setlist found").replace(/\|/g, '<br>')}
            </div>
        </div>
    `).join('');

    // 7. RENDER
    document.getElementById('mSetlists').innerHTML = `
        ${notesHTML}
        ${imageHTML}
        <div class="${gridClass} md:col-span-full">
            ${setlistHTML || '<p class="text-center py-10 text-slate-300 font-bold uppercase">No setlist data</p>'}
        </div>
    `;

// UI & Accessibility: Show modal and move focus
    document.getElementById('modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Move focus to the Band Name for screen readers
    const title = document.querySelector('#mTitleArea h2');
    if (title) title.focus();

    if (window.lucide) lucide.createIcons();
}

window.closeModal = function() {
    document.getElementById('modal').classList.add('hidden');
    // RESTORE SCROLLING HERE:
    document.body.style.overflow = 'auto';
};

window.onload = loadData;

window.openSettings = function() {
    document.getElementById('settingsModal').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
};

window.closeSettings = function() {
    document.getElementById('settingsModal').classList.add('hidden');
};

window.syncComingSoon = function() {
    const id = document.getElementById('setlistIdInput').value;
    if(id) alert(`Syncing for ${id} coming soon! Using the Python bridge for now.`);
};

// Update loadData to make the identity clickable
// Inside loadData()...
const identityEl = document.getElementById('userIdentity');
if (identityEl) {
    identityEl.innerText = currentUser.UserName;
    identityEl.style.cursor = 'pointer';
    identityEl.onclick = openSettings;
}

let modalChartInstance = null;

function expandChart(chartId, title) {
    const modal = document.getElementById('chartModal');
    const modalCanvas = document.getElementById('modalChartCanvas');
    const originalChart = Chart.getChart(chartId); // Find the existing chart instance

    if (!originalChart) return;

    // Set the title
    document.getElementById('modalChartTitle').innerText = title;

    // Destroy previous modal chart if it exists
    if (modalChartInstance) modalChartInstance.destroy();

    // Show modal
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Prevent scrolling

    // Create a new chart in the modal using a copy of the original data/options
modalChartInstance = new Chart(modalCanvas, {
        type: originalChart.config.type,
        data: {
            ...JSON.parse(JSON.stringify(originalChart.config.data)),
            datasets: originalChart.config.data.datasets.map(ds => ({
                ...ds,
                label: ds.label || 'Gigs' // Fixes the "undefined" bug
            }))
        },
        options: {
    ...originalChart.config.options,
    maintainAspectRatio: false,
    plugins: {
        ...originalChart.config.options.plugins,
        legend: {
            display: true,
            position: 'bottom',
            labels: {
                color: '#64748b', // Slate-500
                font: { weight: 'bold', size: 12 },
                padding: 20
            }
        }
    },
    scales: originalChart.config.options.scales ? {
        x: {
            ticks: { color: '#64748b', font: { weight: '600' } },
            grid: { display: false }
        },
        y: {
            ticks: { color: '#64748b', font: { weight: '600' } },
            grid: { color: '#f1f5f9' }
        }
    } : {}
}
    });

    lucide.createIcons();
}

function closeChartModal() {
    document.getElementById('chartModal').classList.add('hidden');
    document.body.style.overflow = 'auto';
    if (modalChartInstance) modalChartInstance.destroy();
}

/**
 * CALENDAR & WRAPPED MODULE
 */
window.toggleView = function(view) {
    currentView = view;
    const isList = view === 'list';

    // Toggle container visibility
    document.getElementById('tableView').classList.toggle('hidden', !isList);
    const calView = document.getElementById('calendarView');
    calView.classList.toggle('hidden', isList);

    // Accessibility: Announce view change to screen readers
    calView.setAttribute('aria-live', 'polite');

    // Update Button Styling and ARIA states
    const listBtn = document.getElementById('listViewBtn');
    const calBtn = document.getElementById('calendarViewBtn');

    if (listBtn && calBtn) {
        listBtn.setAttribute('aria-pressed', isList);
        calBtn.setAttribute('aria-pressed', !isList);

        listBtn.className = isList ? 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all bg-white shadow-sm text-indigo-600' : 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-slate-400';
        calBtn.className = !isList ? 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all bg-white shadow-sm text-indigo-600' : 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-slate-400';
    }
    refreshUI();
};

function renderCalendarView() {
    const container = document.getElementById('calendarView');
    if (!container) return;
    container.innerHTML = '';

    const years = {};
    filteredResults.forEach(entry => {
        const year = entry.Date.split('/')[2];
        if (year) {
            if (!years[year]) years[year] = [];
            years[year].push(entry);
        }
    });

    const sortedYears = Object.keys(years).sort((a, b) => b - a);
    if (sortedYears.length === 0) {
        container.innerHTML = `<div class="py-20 text-center font-bold text-slate-400 uppercase tracking-widest text-xs">No gigs found</div>`;
        return;
    }

    sortedYears.forEach(year => {
        const totalGigs = years[year].length;
        const topArtist = getTopStat(years[year], 'Band');
        const topVenue = getTopStat(years[year], 'OfficialVenue');

        const div = document.createElement('div');
        div.className = "bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100 overflow-hidden relative mb-4";
        div.innerHTML = `
            <div id="calendar-side-${year}" class="transition-all duration-500">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-3xl font-black italic tracking-tighter text-slate-800">${year}</h3>
                    <button onclick="toggleWrapped('${year}')" class="bg-amber-400 hover:bg-amber-500 text-[9px] font-black uppercase px-4 py-2 rounded-full shadow-sm"> ✨ View Summary </button>
                </div>
                <div class="grid grid-cols-4 md:grid-cols-6 gap-3 mb-2">${generateMiniMonths(years[year])}</div>
            </div>
            <div id="wrapped-side-${year}" class="hidden opacity-0 transition-all duration-500 bg-indigo-600 text-white p-8 rounded-[2rem] -m-2">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-2xl font-black italic uppercase tracking-tighter">${year}  Summary</h3>
                    <button onclick="toggleWrapped('${year}')" class="text-white/60 hover:text-white"><i data-lucide="x" class="w-6 h-6"></i></button>
                </div>
                <div class="space-y-4">
                    <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">Total Gigs</p><p class="text-3xl font-black">${totalGigs}</p></div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">MVP Artist</p><p class="text-xs font-black truncate">${topArtist}</p></div>
                        <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">Home Base</p><p class="text-xs font-black truncate">${topVenue}</p></div>
                    </div>
                </div>
            </div>`;
        container.appendChild(div);
    });
    if (window.lucide) lucide.createIcons();
}

function toggleWrapped(year) {
    const cal = document.getElementById(`calendar-side-${year}`);
    const wrap = document.getElementById(`wrapped-side-${year}`);
    if (wrap.classList.contains('hidden')) {
        cal.classList.add('opacity-0', 'scale-95');
        setTimeout(() => { cal.classList.add('hidden'); wrap.classList.remove('hidden'); setTimeout(() => wrap.classList.replace('opacity-0', 'opacity-100'), 10); }, 300);
    } else {
        wrap.classList.replace('opacity-100', 'opacity-0');
        setTimeout(() => { wrap.classList.add('hidden'); cal.classList.remove('hidden'); setTimeout(() => cal.classList.remove('opacity-0', 'scale-95'), 10); }, 300);
    }
}

function generateMiniMonths(entries, year) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months.map((month, idx) => {
        const monthNum = (idx + 1).toString().padStart(2, '0');
        const monthGigs = entries.filter(e => e.Date.split('/')[1] === monthNum);
        const count = monthGigs.length;

        // Only make clickable if there are gigs
        const clickAttr = count > 0 ? `onclick="showMonthDetail('${year}', '${monthNum}', '${month}')" style="cursor:pointer;"` : "";

        return `<div class="flex flex-col items-center p-2 rounded-xl transition-all hover:bg-indigo-100/50 ${count > 0 ? 'bg-indigo-50 border border-indigo-100' : 'opacity-20'}"
                     ${clickAttr} role="gridcell" aria-label="${count} gigs in ${month} ${year}">
                <span class="text-[8px] font-black uppercase text-slate-400 mb-1" aria-hidden="true">${month}</span>
                <div class="flex gap-0.5 flex-wrap justify-center">
                    ${Array(Math.min(count, 5)).fill(0).map(() => `<div class="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div>`).join('')}
                </div>
        </div>`;
    }).join('');
}

function getTopStat(entries, key) {
    const counts = {};
    entries.forEach(e => counts[e[key]] = (counts[e[key]] || 0) + 1);
    return Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0] || 'N/A';
}

window.showMonthDetail = function(year, monthNum, monthName) {
    const monthGigs = filteredResults.filter(e => {
        const parts = e.Date.split('/');
        return parts[2] === year && parts[1] === monthNum;
    });

    const listContainer = document.getElementById(`month-list-${year}`);
    const titleContainer = document.getElementById(`month-title-${year}`);

    titleContainer.innerText = `${monthName} ${year}`;

    listContainer.innerHTML = monthGigs.map(g => `
        <div onclick="openModal('${g['Journal Key']}')" class="group cursor-pointer border-b border-white/10 pb-2 hover:border-amber-400 transition-colors">
            <div class="text-[10px] font-black text-amber-400 uppercase mb-0.5">${g.Date}</div>
            <div class="text-sm font-bold truncate group-hover:text-amber-200">${g.Band}</div>
            <div class="text-[10px] opacity-60 truncate">${g.OfficialVenue}</div>
        </div>
    `).join('');

    // Flip Animation
    const cal = document.getElementById(`calendar-side-${year}`);
    const monthSide = document.getElementById(`month-side-${year}`);

    cal.classList.add('opacity-0', 'scale-95');
    setTimeout(() => {
        cal.classList.add('hidden');
        monthSide.classList.remove('hidden');
        setTimeout(() => monthSide.classList.replace('opacity-0', 'opacity-100'), 10);
    }, 300);

    if (window.lucide) lucide.createIcons();
};

window.closeMonthDetail = function(year) {
    const cal = document.getElementById(`calendar-side-${year}`);
    const monthSide = document.getElementById(`month-side-${year}`);

    monthSide.classList.replace('opacity-100', 'opacity-0');
    setTimeout(() => {
        monthSide.classList.add('hidden');
        cal.classList.remove('hidden');
        setTimeout(() => cal.classList.remove('opacity-0', 'scale-95'), 10);
    }, 300);
};

/**
 * GIG LIST CALENDAR MODULE
 * Includes: Calendar Grid, Year Wrapped, and Month Detail Flip
 */

window.toggleView = function(view) {
    currentView = view;
    const isList = view === 'list';
    document.getElementById('tableView').classList.toggle('hidden', !isList);
    const calView = document.getElementById('calendarView');
    calView.classList.toggle('hidden', isList);
    calView.setAttribute('aria-live', 'polite');

    const listBtn = document.getElementById('listViewBtn');
    const calBtn = document.getElementById('calendarViewBtn');
    if (listBtn && calBtn) {
        listBtn.setAttribute('aria-pressed', isList);
        calBtn.setAttribute('aria-pressed', !isList);
        listBtn.className = isList ? 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all bg-white shadow-sm text-indigo-600' : 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-slate-400';
        calBtn.className = !isList ? 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all bg-white shadow-sm text-indigo-600' : 'px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-slate-400';
    }
    refreshUI();
};

function renderCalendarView() {
    const container = document.getElementById('calendarView');
    if (!container) return;
    container.innerHTML = '';

    const years = {};
    filteredResults.forEach(entry => {
        const year = entry.Date.split('/')[2];
        if (year) {
            if (!years[year]) years[year] = [];
            years[year].push(entry);
        }
    });

    const sortedYears = Object.keys(years).sort((a, b) => b - a);
    sortedYears.forEach(year => {
        const div = document.createElement('div');
        div.className = "bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100 overflow-hidden relative mb-4";

        // Stats for Side 2 (Wrapped)
        const totalGigs = years[year].length;
        const topArtist = getTopStat(years[year], 'Band');
        const topVenue = getTopStat(years[year], 'OfficialVenue');

        div.innerHTML = `
            <div id="calendar-side-${year}" class="transition-all duration-500">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-3xl font-black italic tracking-tighter text-slate-800">${year}</h3>
                    <button onclick="toggleWrapped('${year}')" class="bg-amber-400 hover:bg-amber-500 text-[9px] font-black uppercase px-4 py-2 rounded-full shadow-sm"> ✨ View Summary </button>
                </div>
                <div class="grid grid-cols-4 md:grid-cols-6 gap-3 mb-2">${generateMiniMonths(years[year], year)}</div>
            </div>

            <div id="wrapped-side-${year}" class="hidden opacity-0 transition-all duration-500 bg-indigo-600 text-white p-8 rounded-[2rem] -m-2">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-2xl font-black italic uppercase tracking-tighter">${year}  Summary</h3>
                    <button onclick="toggleWrapped('${year}')" class="text-white/60 hover:text-white"><i data-lucide="x" class="w-6 h-6"></i></button>
                </div>
                <div class="space-y-4">
                    <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">Total Gigs</p><p class="text-3xl font-black">${totalGigs}</p></div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">MVP Artist</p><p class="text-xs font-black truncate">${topArtist}</p></div>
                        <div class="bg-white/10 p-4 rounded-2xl"><p class="text-[9px] font-bold uppercase opacity-60">Home Base</p><p class="text-xs font-black truncate">${topVenue}</p></div>
                    </div>
                </div>
            </div>

            <div id="month-side-${year}" class="hidden opacity-0 transition-all duration-500 bg-slate-900 text-white p-8 rounded-[2rem] -m-2">
                <div class="flex justify-between items-center mb-4">
                    <h3 id="month-title-${year}" class="text-xl font-black italic uppercase tracking-tighter text-amber-400">Month Detail</h3>
                    <button onclick="closeMonthDetail('${year}')" class="text-white/40 hover:text-white"><i data-lucide="chevron-left" class="w-6 h-6"></i></button>
                </div>
                <div id="month-list-${year}" class="space-y-3 max-h-[220px] overflow-y-auto pr-2 custom-scrollbar"></div>
            </div>`;
        container.appendChild(div);
    });
    if (window.lucide) lucide.createIcons();
}

function generateMiniMonths(entries, year) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months.map((month, idx) => {
        const monthNum = (idx + 1).toString().padStart(2, '0');
        const count = entries.filter(e => e.Date.split('/')[1] === monthNum).length;
        const clickAttr = count > 0 ? `onclick="showMonthDetail('${year}', '${monthNum}', '${month}')" style="cursor:pointer;"` : "";
        return `<div class="flex flex-col items-center p-2 rounded-xl transition-all hover:bg-indigo-100/50 ${count > 0 ? 'bg-indigo-50 border border-indigo-100' : 'opacity-20'}"
                     ${clickAttr} role="gridcell" aria-label="${count} gigs in ${month} ${year}">
                <span class="text-[8px] font-black uppercase text-slate-400 mb-1" aria-hidden="true">${month}</span>
                <div class="flex gap-0.5 flex-wrap justify-center">
                    ${Array(Math.min(count, 5)).fill(0).map(() => `<div class="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div>`).join('')}
                </div>
        </div>`;
    }).join('');
}

window.showMonthDetail = function(year, monthNum, monthName) {
    const monthGigs = filteredResults.filter(e => {
        const parts = e.Date.split('/');
        return parts[2] === year && parts[1] === monthNum;
    });

    document.getElementById(`month-title-${year}`).innerText = `${monthName} ${year}`;
    document.getElementById(`month-list-${year}`).innerHTML = monthGigs.map(g => `
        <div onclick="openModal('${g['Journal Key'].replace(/'/g, "\\'")}')" class="group cursor-pointer border-b border-white/10 pb-2 hover:border-amber-400 transition-colors">
            <div class="text-[10px] font-black text-amber-400 uppercase mb-0.5">${g.Date}</div>
            <div class="text-sm font-bold truncate group-hover:text-amber-200">${g.Band}</div>
            <div class="text-[10px] opacity-60 truncate">${g.OfficialVenue}</div>
        </div>
    `).join('');

    const cal = document.getElementById(`calendar-side-${year}`);
    const monthSide = document.getElementById(`month-side-${year}`);
    cal.classList.add('opacity-0', 'scale-95');
    setTimeout(() => {
        cal.classList.add('hidden');
        monthSide.classList.remove('hidden');
        setTimeout(() => monthSide.classList.replace('opacity-0', 'opacity-100'), 10);
    }, 300);
};

window.closeMonthDetail = function(year) {
    const cal = document.getElementById(`calendar-side-${year}`);
    const monthSide = document.getElementById(`month-side-${year}`);
    monthSide.classList.replace('opacity-100', 'opacity-0');
    setTimeout(() => {
        monthSide.classList.add('hidden');
        cal.classList.remove('hidden');
        setTimeout(() => cal.classList.remove('opacity-0', 'scale-95'), 10);
    }, 300);
};

function toggleWrapped(year) {
    const cal = document.getElementById(`calendar-side-${year}`);
    const wrap = document.getElementById(`wrapped-side-${year}`);
    if (wrap.classList.contains('hidden')) {
        cal.classList.add('opacity-0', 'scale-95');
        setTimeout(() => { cal.classList.add('hidden'); wrap.classList.remove('hidden'); setTimeout(() => wrap.classList.replace('opacity-0', 'opacity-100'), 10); }, 300);
    } else {
        wrap.classList.replace('opacity-100', 'opacity-0');
        setTimeout(() => { wrap.classList.add('hidden'); cal.classList.remove('hidden'); setTimeout(() => cal.classList.remove('opacity-0', 'scale-95'), 10); }, 300);
    }
}

function getTopStat(entries, key) {
    const counts = {};
    entries.forEach(e => counts[e[key]] = (counts[e[key]] || 0) + 1);
    return Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0] || 'N/A';
}

function getTicketStyle(key) {
    const styles = [
        { color: 'bg-[#ffd1dc]', border: 'border-pink-400', accent: 'text-pink-950', type: 'portrait' },
        { color: 'bg-[#d1ffd6]', border: 'border-green-400', accent: 'text-green-950', type: 'landscape' },
        { color: 'bg-[#fffcd1]', border: 'border-yellow-400', accent: 'text-yellow-950', type: 'portrait' }
    ];
    // Create a stable index based on the key
    const index = key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return styles[index % styles.length];
}

function parseDate(dateStr) {
    if (!dateStr) return new Date(0);
    const [d, m, y] = dateStr.split('/').map(Number);
    return new Date(y, m - 1, d);
}

window.openChartModal = function(chartType) {
    console.log("Button clicked! Type:", chartType);

    const modal = document.getElementById('chartModal');
    if (!modal) {
        console.error("CRITICAL: Could not find 'chartModal'");
        return;
    }

    // FORCE VISIBILITY: Remove the 'hidden' class which has !important
    modal.classList.remove('hidden');
    // Ensure the display is flex so it centers correctly
    modal.style.setProperty('display', 'flex', 'important');

    console.log("Modal class list after change:", modal.classList);

    document.body.style.overflow = 'hidden';

    if (window.modalChartInstance) window.modalChartInstance.destroy();

    const dataToUse = (typeof filteredResults !== 'undefined' && filteredResults.length > 0)
                      ? filteredResults
                      : journalData;

    if (chartType === 'companion') {
        renderCompanionChart(dataToUse, 'modalChartCanvas', true);
        const titleEl = document.getElementById('modalChartTitle');
        if (titleEl) titleEl.innerText = "Companion Analysis";
    }
    else if (chartType === 'year') {
        renderYearChart(dataToUse, 'modalChartCanvas', true);
        document.getElementById('modalChartTitle').innerText = "Yearly Breakdown";
    }
    if (window.lucide) lucide.createIcons();
};

window.closeChartModal = function() {
    const modal = document.getElementById('chartModal');
    if (!modal) return;

    // 1. COMPLETELY HIDE THE MODAL
    // We must use 'none !important' to override the 'flex !important' we used to open it
    modal.style.setProperty('display', 'none', 'important');
    modal.classList.add('hidden');

    // 2. UNLOCK THE APP SCROLL
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';

    // 3. CLEAN UP THE CHART
    if (window.modalChartInstance) {
        window.modalChartInstance.destroy();
        window.modalChartInstance = null;
    }

    console.log("Modal closed and app unlocked.");
};
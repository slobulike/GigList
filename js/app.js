/**
 * Gig List Core Engine
 V2.6.3 - Release Date 2026-03-10
          * -------------------------------------------------------------------
  [FEATURE] Added new band specific achievements.
  [UI/UX] Moved Search box to top of Data tab

 V2.6.2 - Release Date 2026-03-09
         * -------------------------------------------------------------------
  [FIX] Fixed top bands modal that would only open once.
  N.B - moved to using Claude having failed to resolve the issue after many attempts with Gemini and ChatGPT.

*/

import * as Data from './modules/data.js';
import * as Charts from './modules/charts.js';
import * as Utils from './modules/utils.js';
import * as UI from './modules/ui.js';
import { parseDate } from './modules/utils.js';
import { renderBadges, renderBandBadges } from './modules/achievements.js';
import { renderCalendar } from './modules/calendar.js';
import './modules/quiz.js';
import * as Games from './modules/games.js';


let currentUser = JSON.parse(localStorage.getItem('gv_user'));
let homeCarousel = [];
let currentCarouselIndex = 0;

const APP_VERSION = "2.6.2";

window.toggleListView = UI.toggleListView;
window.activeView = window.activeView || 'list';
window.journalData = window.journalData || [];
window.openGigModal = UI.openGigModal;
window.renderMap = UI.renderMap;
window.currentSort = { column: 'Date', ascending: false };
window.switchGame = Games.switchGame;
window.startNewPuzzle = Games.startNewPuzzle;

export async function initApp() {
    if (!currentUser) {
        window.location.href = 'index.html';
        return;
    }

    // 1. Load Data
    const data = await Data.loadAppData(currentUser);
    window.journalData = data.journalData;
    window.performanceData = data.performanceData;
    window.filteredResults = [...data.journalData];

    // Set Mode Flags
    window.isBandMode = data.user.Type === 'Band';
    window.currentArtist = data.user.UserName; // Using UserName as the primary ID
    console.log("Band Mode Active:", window.isBandMode);

    // 2. Apply Band Mode Branding (Top Header Specific)
        if (window.isBandMode) {
            document.body.classList.add('band-mode');

            const topHeader = document.querySelector('header');

            if (topHeader) {
                topHeader.style.position = 'relative';
                topHeader.classList.add('bg-[#189BCC]', 'text-white', 'border-b-2', 'border-black/10');

                // 1. COMPLETELY HIDE the "Gig List" text on ALL screens
                const logoText = topHeader.querySelector('h1');
                if (logoText) {
                    // !important ensures it wins against any Tailwind responsive classes (md:flex, etc.)
                    logoText.setAttribute('style', 'display: none !important');
                }

                // 2. Style the User Badge
                const badge = document.getElementById('userIdentity');
                    if (badge) {
                        badge.style.color = 'white';
                        badge.style.backgroundColor = 'rgba(255,255,255,0.2)';
                    }

                // 3. Inject "Archive Mode" in the absolute center
                const oldIndicator = document.getElementById('archive-indicator');
                if (oldIndicator) oldIndicator.remove();

                const indicator = document.createElement('div');
                indicator.id = 'archive-indicator';
                // Absolute center with standard font weight/style
                indicator.className = "... text-white ...";
                indicator.innerText = "⚡ ARTIST ARCHIVE ⚡";

                topHeader.appendChild(indicator);
            }
        }

    // 3. Metadata & Identity
    const versionEl = document.getElementById('app-version-display');
    if (versionEl) versionEl.innerText = APP_VERSION;

    const identityEl = document.getElementById('userIdentity');
    if (identityEl) {
        identityEl.innerText = currentUser.UserName || "User";
        identityEl.style.cursor = 'pointer';
        identityEl.setAttribute('role', 'button');
        identityEl.setAttribute('aria-label', 'Open User Settings');
        identityEl.onclick = window.openSettings;
    }

    window.venueLookup = await Data.loadVenues();

    // 4. Initial Render & Listeners
    refreshUI();
    initEventListeners();
}

function refreshUI() {
    // 1. Get the current filter/search state
    const includeFuture = document.getElementById('upcoming-toggle')?.checked;
    const searchVal = document.getElementById('searchInput')?.value || "";

    // 2. Filter the data using the Data module logic
    const results = Data.filterGigs(
        searchVal,
        window.journalData,
        includeFuture
    );

    // Store globally for other modules to access if needed
    window.filteredResults = results;

    // 3. Create a sorted version specifically for the table/map
    const sortedResults = Data.sortGigs(results, window.currentSort.column, window.currentSort.ascending);

    // 4. Update UI Text Components
    UI.updateCurrentDate();
    UI.updateStats(results);
    UI.updateRank(results);
    UI.updateTicker(results);
    UI.renderCarousel(results);

    // Render the Table with the sorted data
    UI.renderTable(sortedResults);

    // 5. CHART LOGIC
    // Grab all chart containers
    const companionContainer = document.getElementById('companionChartContainer');
    const songContainer = document.getElementById('songChartContainer');
    const topBandsContainer = document.getElementById('topBandsChartContainer');

    if (window.isBandMode) {
        // --- BAND MODE VIEW ---
        // Show Song stats, hide personal stats (Companion & Top Bands)
        if (songContainer) {
            songContainer.classList.remove('hidden');
            Charts.renderTopSongsChart(results, 'topSongsChart');
        }
        if (companionContainer) companionContainer.classList.add('hidden');
        if (topBandsContainer) topBandsContainer.classList.add('hidden');


    } else {
        // --- INDIVIDUAL MODE VIEW ---
        // Hide Song stats, show personal stats
        if (songContainer) songContainer.classList.add('hidden');

        // Render Companion Chart
        if (companionContainer) {
            companionContainer.classList.remove('hidden');
            Charts.renderCompanionChart(results, 'dashboardCompanionChart');
        }

        // Render NEW Top Bands Chart (using the broad net logic)
        if (topBandsContainer) {
            topBandsContainer.classList.remove('hidden');
            // We pass journalData and performanceData to get the full count
            Charts.renderTopBandsChart(results, window.performanceData, 'topBandsChart');
        }
    }

    // Always render the Year Chart at the bottom (Universal)
    Charts.renderYearChart(results, 'dashboardYearChart');

    // 6. Map Logic
    const mapContainer = document.getElementById('mapContainer');
    if (mapContainer && !mapContainer.classList.contains('hidden')) {
        UI.renderMap(sortedResults);
    }

    // 7. Refresh Icons
    if (window.lucide) lucide.createIcons();

    // 8. Band achievements
    const badgeGrid = document.getElementById('badges-grid');

    if (badgeGrid) {
        if (window.isBandMode) {
            console.log("Forcing Band Badge Render...");
            renderBandBadges(window.performanceData || []);
        } else {
            // Calling the original version
            renderBadges(window.filteredResults || window.journalData);
        }
    }
}

// Ensure the checkbox triggers the refresh
window.refreshUI = refreshUI;

window.loadThrowback = (gigs) => {
    const today = new Date();
    today.setHours(0,0,0,0);
    const upcomingGigs = gigs.filter(g => parseDate(g.Date) >= today).sort((a,b) => parseDate(a.Date)-parseDate(b.Date));
    const pastGigs = gigs.filter(g => parseDate(g.Date) < today);

    const futureItems = upcomingGigs.map(g => ({
            ...g,
            type: 'upcoming',
            isFuture: true,
            badge: 'Upcoming Show' // Added this explicitly
        }));
const anniversaries = pastGigs.filter(g => {
        const [d, m] = g.Date.split('/').map(Number);
        return d === currentDay && m === currentMonth;
    }).map(g => ({ ...g, type: 'anniversary' }));

    const monthMemories = pastGigs.filter(g => {
        const [d, m] = g.Date.split('/').map(Number);
        return m === currentMonth && d !== currentDay;
    }).sort(() => Math.random() - 0.5);

    const historicalPool = [...anniversaries, ...monthMemories].slice(0, 3).map(g => {
        const [, , y] = g.Date.split('/').map(Number);
        const yearsAgo = today.getFullYear() - y;
        return {
            ...g,
            band: g.Band,
            details: `${g.OfficialVenue} • ${g.Date}`,
            // Ensure this logic is preserved
            badge: g.type === 'anniversary' ? `${yearsAgo} Year Anniversary` : `Memory from ${today.toLocaleString('default', { month: 'long' })}`,
            isFuture: false
        };
    });

    homeCarousel = [...futureItems, ...historicalPool].map(g => ({
            ...g,
            band: g.Band || g.band,
            details: g.details || `${g.OfficialVenue} • ${g.Date}`,
            badge: g.badge, // Pass the badge through
            isCTA: false
        }));

    currentCarouselIndex = 0;
    UI.renderCarouselItem(currentCarouselIndex, homeCarousel, gigs);
};

window.rotateCarousel = (dir) => {
    const next = currentCarouselIndex + dir;
    if (next >= 0 && next < homeCarousel.length) {
        currentCarouselIndex = next;
        UI.renderCarouselItem(currentCarouselIndex, homeCarousel, window.journalData);
    }
};

window.currentSort = {
    column: 'Date',
    ascending: false // Default to newest first
};

function initEventListeners() {
    // SEARCH
    const search = document.getElementById('searchInput');
    if (search) {
        search.addEventListener('input', (e) => {
            refreshUI(); // refreshUI now handles the filter check
        });
    }

    // FUTURE TOGGLE
    const toggle = document.getElementById('toggleFuture');
    if (toggle) {
        toggle.addEventListener('change', () => {
            refreshUI();
        });
    }
    // LIST / CALENDAR / MAP TOGGLES
        const listBtn = document.getElementById('listToggleBtn');
        const calBtn = document.getElementById('calToggleBtn');
        const mapBtn = document.getElementById('mapToggleBtn'); // If you added this ID to the map button

        if (listBtn) {
            listBtn.onclick = () => {
                window.toggleListView('list');
            };
        }

    if (calBtn) {
        calBtn.onclick = () => {
            console.log("Calendar Toggle Clicked"); // This should now show up!
            window.toggleListView('calendar');
        };
    }
}

// Global functions for HTML onClick attributes
window.viewGigDetails = (key) => {
    UI.openGigModal(key, window.journalData, window.performanceData);
};

// Map openGigModal to the same logic for the Calendar view
window.openGigModal = window.viewGigDetails;

window.closeModal = () => {
    const modal = document.getElementById('modal');
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = 'auto'; // Restore scrolling
    }
};


/* SWITCH VIEW LOGIC */

/**
 * MAIN VIEW SWITCHER
 * Handles navigation, UI state, and view-specific rendering
 */
window.switchView = (viewId) => {
    console.log("Switching to view:", viewId); // Debug logging

    // 1. Toggle visibility of main sections
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
    const targetSection = document.getElementById(`view-${viewId}`);

    if (targetSection) {
        targetSection.classList.remove('hidden');
    } else {
        console.error(`Section view-${viewId} not found in HTML!`);
    }

    // 2. Update Navigation UI
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active', 'text-indigo-600', 'bg-white', 'shadow-sm');
        n.classList.add('text-slate-400');
    });

    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) {
        activeNav.classList.add('active', 'text-indigo-600', 'bg-white', 'shadow-sm');
        activeNav.classList.remove('text-slate-400');
    }

    // 3. TRIGGER RENDERING
        if (viewId === 'calendar') {
            console.log("Rendering Calendar...");
            renderCalendar(window.journalData);
        }

        if (viewId === 'achievements') {
            // --- ADD THE TOGGLE HERE ---
            if (window.isBandMode) {
                console.log("Rendering BAND Achievements...");
                renderBandBadges(window.performanceData);
            } else {
                console.log("Rendering PERSONAL Achievements...");
                renderBadges(window.journalData);
            }
        }

    window.scrollTo(0, 0);
};
/**
 * BRIDGE: Apply Chart Filters
 * This allows charts.js to trigger a data refresh in app.js
 */
window.applyChartFilter = (type, value) => {
    const searchInput = document.getElementById('searchInput');

    // For Month Drill-down, we need a specific format
    if (type === 'month') {
        const monthNames = ["/01/", "/02/", "/03/", "/04/", "/05/", "/06/", "/07/", "/08/", "/09/", "/10/", "/11/", "/12/"];
        const searchVal = `${monthNames[value.month]}${value.year}`; // e.g., "/05/2024"
        if (searchInput) searchInput.value = searchVal;
    } else {
        // For Year or Companion, just put the string in the search bar
        if (searchInput) searchInput.value = value;
    }

    // Trigger the existing refresh logic
    refreshUI();

    // Crucial: Call refreshUI to update Table and Stats
    if (typeof refreshUI === 'function') {
        refreshUI();
    } else {
        // Fallback if refreshUI isn't in scope
        window.dispatchEvent(new CustomEvent('dataRefresh'));
    }
};

/**
 * Global View Toggles (List vs Calendar)
 * Attached to window to fix 'toggleView is not defined' error
 */
window.toggleView = (viewType) => {
    const tableContainer = document.getElementById('tableContainer');

    // Safety check: if the HTML ID is missing or misspelled, exit gracefully
    if (!tableContainer) {
        console.warn("Could not find 'tableContainer' in the DOM. Check your HTML IDs.");
        return;
    }

    const isCurrentlyCalendar = tableContainer.classList.contains('hidden');

    // BREAK THE LOOP: If we are already in the requested view, stop.
    if (viewType === 'calendar' && isCurrentlyCalendar) return;
    if (viewType === 'list' && !isCurrentlyCalendar) return;

    // 1. Update the UI layout
    UI.toggleListView(viewType);

    // 2. Only render if necessary
    if (viewType === 'calendar') {
        UI.renderCalendar(window.filteredResults || window.journalData);
    }
};

/**
 * Load Throwback Carousel
 */

/**
 * Restored loadThrowback with exact historical card logic
 */
window.loadThrowback = (gigs) => {
    // Prevent double loading
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    const upcomingGigs = gigs.filter(g => parseDate(g.Date) >= today).sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
    const pastGigs = gigs.filter(g => parseDate(g.Date) < today).sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    // 1. Update the Ticker
    UI.updateTicker(gigs);

    // 2. Prepare Carousel Data
    const futureItems = upcomingGigs.map(g => ({ ...g, type: 'upcoming', isFuture: true }));

    const anniversaries = pastGigs.filter(g => {
        const [d, m] = g.Date.split('/').map(Number);
        return d === currentDay && m === currentMonth;
    }).map(g => ({ ...g, type: 'anniversary' }));

    const monthMemories = pastGigs.filter(g => {
        const [d, m] = g.Date.split('/').map(Number);
        return m === currentMonth && d !== currentDay;
    }).sort(() => Math.random() - 0.5);

    const historicalPool = [...anniversaries, ...monthMemories].slice(0, 3).map(g => {
        const [, , y] = g.Date.split('/').map(Number);
        const yearsAgo = today.getFullYear() - y;
        return {
            ...g,
            band: g.Band,
            details: `${g.OfficialVenue} • ${g.Date}`,
            badge: g.type === 'anniversary' ? `${yearsAgo} Year Anniversary` : `Memory from ${today.toLocaleString('default', { month: 'long' })}`,
            isFuture: false
        };
    });

    // 3. Assemble and Add CTA
    homeCarousel = [...futureItems, ...historicalPool].map(g => ({
        ...g,
        band: g.Band || g.band,
        details: g.details || `${g.OfficialVenue} • ${g.Date}`,
        isCTA: false
    }));

    homeCarousel.push({
        band: "Ready for more?",
        details: "Tap here to delve deeper into the Data Lab.",
        badge: "Next Step",
        isCTA: true,
        isFuture: false
    });

    // Reset index and render
    currentCarouselIndex = 0;
    UI.renderCarouselItem(currentCarouselIndex, homeCarousel, gigs);
};

/**
 * 50/50 Navigation Logic
 */
window.rotateCarousel = (direction) => {
    const isLastCard = currentCarouselIndex === homeCarousel.length - 1;

    // Last card + Right click = Data Tab
    if (isLastCard && direction === 1) {
        if (typeof window.switchView === 'function') window.switchView('data');
        return;
    }

    const nextIndex = currentCarouselIndex + direction;
    if (nextIndex >= 0 && nextIndex < homeCarousel.length) {
        currentCarouselIndex = nextIndex;
        // Re-render using the modular UI function
        UI.renderCarouselItem(currentCarouselIndex, homeCarousel, window.journalData);
    }
};

/* --- SETTINGS MODAL LOGIC --- */

window.openSettings = function() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');

        // 1. Locate the button specifically by ID (preferred) or by its common text
        const switchUserBtn = document.getElementById('settings-switch-user') ||
                             modal.querySelector('button[onclick*="index.html"]');

        if (switchUserBtn) {
            // 2. We use 'Individual' for the URL parameter because our index logic
            // now knows to map 'Individual' requests to 'Personal' CSV data.
            const mode = window.isBandMode ? 'Band' : 'Individual';

            // 3. Wipe any existing inline onclick to prevent conflicts
            switchUserBtn.onclick = null;

            // 4. Assign the precise new navigation logic
            switchUserBtn.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = `index.html?mode=${mode}`;
            }, { once: true }); // 'once' ensures no memory leaks if modal opens/closes often
        }

        // WCAG focus management
        document.getElementById('setlistIdInput')?.focus();

        if (window.lucide) lucide.createIcons();
    }
};

window.closeSettings = function() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
};

window.syncComingSoon = function() {
    const id = document.getElementById('setlistIdInput')?.value;
    if(id) {
        alert(`Syncing for ${id} coming soon! Using the Python bridge for now.`);
    } else {
        alert("Please enter a Setlist.fm username.");
    }
};

window.handleUpcomingToggle = () => {
    const showUpcoming = document.getElementById('upcoming-toggle').checked;

    // 1. Get the current search text from the input
    const searchEl = document.getElementById('searchInput');
    const currentSearch = searchEl ? searchEl.value : "";

    // 2. Use your central filter function (this handles both the text AND the date toggle)
    // IMPORTANT: Make sure Data.filterGigs is imported/available here
    window.filteredResults = Data.filterGigs(currentSearch, window.journalData, showUpcoming);

    // 3. Apply the current SORT to the results
    const currentData = Data.sortGigs(
        window.filteredResults,
        window.currentSort.column,
        window.currentSort.ascending
    );

    // 4. Refresh the active view
    if (window.activeView === 'calendar') {
        renderCalendar(currentData);
    } else if (window.activeView === 'map') {
        if (window.renderMap) window.renderMap(currentData);
    } else {
        UI.renderTable(currentData);
    }

    // Always update stats with the final data
    UI.updateStats(currentData);
};

window.handleSort = (column) => {
    // 1. Update State
    if (window.currentSort.column === column) {
        window.currentSort.ascending = !window.currentSort.ascending;
    } else {
        window.currentSort.column = column;
        window.currentSort.ascending = (column !== 'Date'); // Dates default Desc, others Asc
    }

    // 2. Sort and Render
    const baseData = window.filteredResults || window.journalData;
    const sorted = Data.sortGigs(baseData, window.currentSort.column, window.currentSort.ascending);
    UI.renderTable(sorted);
};

window.openTopBandsModal = () => {
    // Delegate to the charts.js modal controller, exactly like the year/companion buttons do
    window.openChartModal('topbands');
};

import { GigPuzzle } from './modules/puzzle.js';
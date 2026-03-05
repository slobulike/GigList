/**
 * Gig List Core Engine
  V2.6.0 - Release Date 2026-03-04
        * -------------------------------------------------------------------
 [FEATURE] "Top Bands" leaderboard added to Individual Mode.
 [FIX] Successfully joined Journal and Performance data (Headline vs. Support).
 [FIX] Eliminated Weezer double-counting (31 reduced back to 20).
 [UI/UX] Added interactive filtering and "clean" hover-only expand buttons.

  V2.5.5 - Release Date 2026-03-04
        * -------------------------------------------------------------------
    [FIX] Upcoming toggle no longer resets filter
    [UI/UX] Deep Search Labels: Restored the "Support," "Festival," and "Setlist" badges.
    [A11Y] Silenced the IDE warnings and kept the app WCAG-compliant with aria-labels

  V2.5.4 - Release Date 2026-03-03
       * -------------------------------------------------------------------
     [UI/UX] Band mode quiz questions re-written
     [FIX] Prevented duplicate questions in quiz
     [FIX] Made sure song search results were returned

 V2.5.3 - Release Date 2026-02-26
      * -------------------------------------------------------------------
    [UI/UX] Band mode styling changes
    [UI/UX] Song data now shown in band mode including new song chart
    [FIX] Corrected calendar view to show tiles in grid instead of row
    [FIX] Correct performances data (using python script) to align to journal key

 V2.5.2 - Release Date 2026-02-26
     * -------------------------------------------------------------------
     [UI/UX] Added "Show Type" to the Band mode to show festival, tv, or headline.
     [UI/UX] Made data view table dynamic so columns are responsive depending on the view mode

  V2.5.1 - Release Date 2026-02-25
    * -------------------------------------------------------------------
    [UI/UX] Switch labels to show song count instead of artist count when in band mode
    [UI/UX] Make wording dynamic based on band mode to ensure this makes sense e.g x days since {venue} instead of x days since {band name}

  V2.5.0 - Release Date 2026-02-24
   * -------------------------------------------------------------------
   [FEATURE] Added "Band Mode" with Weezer data loaded and available via the user list
   [UI/UX] Added expanded map modal to allow full screen map display

  V2.4.3 - Release Date 2026-02-19
   * -------------------------------------------------------------------
   [FIX] Map and venue coordinate updates

  V2.4.2 - Release Date 2026-02-17
  * -------------------------------------------------------------------
  [UI/UX] Added album art from Cover Art Archive
  [FEATURE] Slide puzzle game

  V2.4.1 - Release Date 2026-02-17
 * -------------------------------------------------------------------
    * [FIX] Small UI improvements to add back Camera icon for photo galleries
    * [UI/UX] Improved Achievements logic
    * [REFACTOR] Changed loading approach with delay to assist in initial load speed

 V2.4.0 - Release Date 2026-02-15
 * -------------------------------------------------------------------
    * [REFACTOR] Re-write to use ES6 multiple JS files
    * [UI/UX] Design System Standardization: Unified all section headers (Home, Data, Games)
    * [UI/UX] Updated Calendar grid to a high-density 3-column layout for mobile (up to 12-column for desktop).
    * [FEATURE] The Arena (Games Tab): Initial launch of the "Games" section.
    * [FEATURE] Flashback Quiz: A high-speed memory game using personalized venue, date, and frequency data.
    * [FEATURE] Integrated local high-score tracking via localStorage.
    * [FEATURE] Performance "Wrapped" Overhaul: Completely redesigned the summary cards into high-fidelity "Wrapped" style visuals.
        Added granular venue, year, and "Frequent Flyer" loyalty statistics.
    * [FIX] Data Engine & Sorting: Fixed "Sticky Sort" regression: Reverse-chronological order now persists when switching between List, Map, and Calendar views.
        Hardened date parsing logic to eliminate "NaN" errors in the Quiz and Stats modules.
    * [FIX] Accessibility (WCAG):
        Refined button contrast and ARIA states across the new navigation and game arena.
    * [FIX] Layout Stability:
        Resolved "Summary Card" overflow bugs on mobile devices.
        Optimized container toggling in ui.js for smoother view transitions.


 V1.1.3 - Release Date 2026-02-09 PM
 * -------------------------------------------------------------------
   * [FEATURE] Year chart expanded modal: Added monthly drill down

 V1.1.3 - Release Date 2026-02-09
 * -------------------------------------------------------------------
  * [FIX] Companion chart modal: Updated large view with correct labels and count
  * [FIX] User Settings modal: Updated format to fix layout

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

import * as Data from './modules/data.js';
import * as Charts from './modules/charts.js';
import * as Utils from './modules/utils.js';
import * as UI from './modules/ui.js';
import { parseDate } from './modules/utils.js';
import { renderBadges } from './modules/achievements.js';
import { renderCalendar } from './modules/calendar.js';
import './modules/quiz.js';
import * as Games from './modules/games.js';


let currentUser = JSON.parse(localStorage.getItem('gv_user'));
let homeCarousel = [];
let currentCarouselIndex = 0;

const APP_VERSION = "2.6.0";

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
        renderBadges(window.journalData);
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
        // Trap focus for ARIA (Optional but good practice)
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
    // This calls your existing UI.js modal logic
    UI.openChartModal('Top Bands Seen', (canvasId) => {
        // Pass 'true' so the chart module knows to use the modal settings
        Charts.renderTopBandsChart(window.journalData, window.performanceData, canvasId, true);
    });
};

import { GigPuzzle } from './modules/puzzle.js';




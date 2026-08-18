/**
 * GigList Core Engine
 * v8.1.5 — 2026-08-18
 * ------------------------------------------------------------------
 * ✅ Improved accuracy of counts for Top Band charts
 */

import * as Data from './modules/data.js';
import * as Charts from './modules/charts.js';
import { renderDashboardCharts } from './modules/charts.js';
import * as UI from './modules/ui.js';
import { initArchiveButton } from './modules/ui.js';
import { parseDate } from './modules/utils.js';
// achievements.js import retained — renderBadges/renderBandBadges used by Profile screen (future)
import { renderCalendar } from './modules/calendar.js';
import './modules/quiz.js';
import * as Games from './modules/games.js';
import { GigPuzzle } from './modules/puzzle.js';
import { initEditor, exportCSV } from './modules/editor.js';
import { supabase } from './modules/supabase.js';
import { runSetlistSync } from './modules/setlist-sync.js';
import { runOnboarding, checkCompanionTags } from './modules/onboarding.js';
import { handleZeroSyncResult } from './modules/setlist-sync.js';
import { initSocial, checkGigOverlap, rebuildSwitcherPanel, resolveCompanionTags } from './modules/social.js';
import { initModeSwitcher } from './modules/switcher.js';
import * as Feed from './modules/feed.js';
import { initBuddies } from './modules/buddies.js';
import { initProfile } from './modules/profile.js';
import { initBandMode } from './modules/band.js';
import { applyFilters, buildSummaryLine, hasActiveFilters } from './modules/filters.js';
import { initDeepLink, markAppReady } from './modules/deep-link.js';
import { initPlaylistButton } from './modules/spotify.js';
import { teardownModalTips } from './modules/modal-tips.js';
import { checkNudgeTrigger, initExploreCard } from './modules/tip-nudges.js';
import { openPhotoCropModal } from './modules/photo-crop.js';


// Expose on window so profile.js can call it without a direct import
window.checkNudgeTrigger = checkNudgeTrigger;

const APP_VERSION = "8.1.5";

// ─── TOAST NOTIFICATIONS ──────────────────────────────────────────────────────

window.showToast = (message, type = 'info', duration = 3500) => {
    const container = document.getElementById('toast-container');
    if (!container) { console.warn(message); return; }

    const colours = {
        info:    'bg-slate-800 text-white',
        success: 'bg-emerald-600 text-white',
        error:   'bg-red-500 text-white',
        warning: 'bg-amber-500 text-white',
    };

    const icons = {
        info:    'info',
        success: 'check-circle',
        error:   'alert-circle',
        warning: 'alert-triangle',
    };

    const toast = document.createElement('div');
    toast.className = `pointer-events-auto flex items-center gap-2.5 px-5 py-3 rounded-2xl shadow-xl text-sm font-bold max-w-xs text-center transition-all duration-300 translate-y-2 opacity-0 ${colours[type] || colours.info}`;
    toast.innerHTML = `<i data-lucide="${icons[type] || 'info'}" class="w-4 h-4 flex-shrink-0" aria-hidden="true"></i><span>${message}</span>`;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-2', 'opacity-0');
        });
    });

    setTimeout(() => {
        toast.classList.add('translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, duration);
};

// ─── SPINNER OVERLAY ──────────────────────────────────────────────────────────

window.showSpinner = (message = '') => {
    const overlay = document.getElementById('spinner-overlay');
    const msg     = document.getElementById('spinner-message');
    if (!overlay) return;
    if (msg) msg.textContent = message;
    overlay.classList.remove('hidden');
};

window.hideSpinner = () => {
    document.getElementById('spinner-overlay')?.classList.add('hidden');
};

/**
 * Wraps an async function with spinner show/hide.
 * Always hides the spinner even if the function throws.
 * Usage: await window.withSpinner('Saving…', () => someAsyncFn())
 */
window.withSpinner = async (message, fn) => {
    window.showSpinner(message);
    try {
        return await fn();
    } finally {
        window.hideSpinner();
    }
};

// ─── CHART.JS LAZY LOADER ─────────────────────────────────────────────────────

/**
 * Ensures Chart.js is loaded before any chart is rendered.
 * The <script> tag for chart.js is removed from <head> so it no longer blocks
 * first paint. This function injects it on demand and resolves once ready.
 * Subsequent calls are instant (window.Chart already exists).
 */
let _chartJsPromise = null;
window.ensureChartJs = () => {
    if (window.Chart) return Promise.resolve();
    if (_chartJsPromise) return _chartJsPromise;

    _chartJsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load Chart.js'));
        document.head.appendChild(script);
    });
    return _chartJsPromise;
};

let currentUser = null;
let homeCarousel = [];
let currentCarouselIndex = 0;

window.toggleListView = UI.toggleListView;
window.activeView = window.activeView || 'list';
window.renderMap = UI.renderMap;
window.currentSort = { column: 'Date', ascending: false };


// Games modules are dormant — kept in place for future revival
// window.switchGame and window.startNewPuzzle removed from global scope

export async function initApp() {
    // Check URL params FIRST
    const params      = new URLSearchParams(window.location.search);
    const bandParam   = params.get('band');
    const friendParam = params.get('friend');
    const friendName  = params.get('friendName') || 'Friend';
    const isNewUser   = params.get('new') === 'true';

    // 1. Check Supabase auth session
    const { data: { session } } = await supabase.auth.getSession();

    // TODO: Re-enable once Profile screens exist. Friend mode (persona-swap via ?friend= URL param)
    // has been retired in favour of the buddy filter bar in the Data tab. Keep this block so it's
    // easy to restore when we build profile pages — at that point ?friend= will navigate to a
    // profile screen rather than loading someone else's journal data as your own.
    //
    // if (friendParam && session) {
    //     currentUser = {
    //         ...( (await supabase.from('profiles').select('*').eq('id', session.user.id).single()).data || {} ),
    //         UserName:    decodeURIComponent(friendName),
    //         Type:        'Friend',
    //         friendId:    friendParam,
    //         id:          session.user.id,
    //         isAuthUser:  true
    //     };
    // } else if (bandParam) {
    if (bandParam) {
        const { data: bandRow } = await supabase            .from('bands')
            .select('*')
            .ilike('name', bandParam)
            .single();

        if (!bandRow) {
            window.location.href = 'index.html';
            return;
        }
        currentUser = {
            UserName:    bandRow.name,
            Type:        'Band',
            Subject:     bandRow.subject || bandRow.name,
            id:          session?.user?.id || null,
            isAuthUser:  !!session
        };
    } else if (!session) {
        window.location.href = 'index.html';
        return;
    } else {
        const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

        if (!profile) {
            window.location.href = 'index.html';
            return;
        }
        currentUser = {
            ...profile,
            UserName:   profile.username,
            Type:       'Personal',
            id:         session.user.id,
            isAuthUser: true
        };
    }

    document.addEventListener('filtersChanged', _applyFiltersAndRender);

    // 1. Load Data
    // Performances are skipped here and loaded lazily after first paint (see deferred
    // section below) so the home screen becomes interactive as fast as possible.
    // Band mode: performances are also skipped here and loaded on-demand in band.js
    // when the Summary tab is opened (the only consumer of performance data there).
    const data = await Data.loadAppData(currentUser, { skipPerformances: true });

    // Load achievement stats in parallel — personal mode only
    if (currentUser?.Type === 'Personal') {
        await Promise.all([
            Data.loadGigPhotoStats(currentUser.id),
            Data.loadCollectionStats(currentUser.id),
        ]);
    }

    window.currentUser = currentUser;
    window.journalData = data.journalData;
    window.performanceData = [];          // populated below once page is interactive
    window.filteredResults = [...data.journalData];

    // Set Mode Flags
    window.isBandMode   = data.user.Type === 'Band';
    window.isFriendMode  = false; // Friend mode retired — buddy journal overlay is in the Data tab filter bar
    window.currentArtist = data.user.UserName;

    // 2. Apply Band Mode / Friend Mode Branding
    // TODO: isFriendMode branding removed — re-enable if Friend mode is restored for profile pages
    // if (window.isFriendMode) { ... }

    if (window.isBandMode) {
        document.body.classList.add('band-mode');

        const topHeader = document.querySelector('header');
        if (topHeader) {
            topHeader.classList.add('bg-[#189BCC]', 'border-b-2', 'border-black/10');
            topHeader.classList.remove('bg-white/80', 'backdrop-blur-xl');

            const logoIcon = document.getElementById('header-logo-icon');
            if (logoIcon) {
                logoIcon.style.backgroundColor = 'rgba(255,255,255,0.2)';
                logoIcon.style.boxShadow = 'none';
            }

            const titleEl = document.getElementById('header-page-title');
            if (titleEl) {
                titleEl.textContent = window.currentArtist || 'Artist Archive';
                titleEl.style.color = 'white';
            }

            const dateEl = document.getElementById('header-date-display');
            if (dateEl) dateEl.style.color = 'rgba(255,255,255,0.7)';

            // Auth display: show avatar if signed in, tint sign-in pill if not
            const signinPill   = document.getElementById('userIdentity-signin');
            const avatarCircle = document.getElementById('userIdentity-avatar');

            if (currentUser.isAuthUser) {
                // Avatar is hidden in band mode (see below) — just hide the sign-in pill
                if (signinPill) signinPill.classList.add('hidden');
            } else {
                // Unauthenticated — tint the sign-in pill for visibility on blue header
                if (signinPill) {
                    signinPill.style.color = 'white';
                    signinPill.style.backgroundColor = 'rgba(255,255,255,0.2)';
                }
            }
        }

        // Hide personal nav, show band nav
        document.getElementById('main-nav')?.classList.add('hidden');
        document.getElementById('band-nav')?.classList.remove('hidden');

        // Hide all personal view sections so band views start clean
        document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
    }

    // 3. Metadata & Identity
    const versionEl = document.getElementById('app-version-display');
    if (versionEl) versionEl.innerText = APP_VERSION;

    let authDisplayName = 'User';
    if (currentUser.isAuthUser) {
        if (currentUser.Type === 'Band') {
            const { data: authProfile, error: profileErr } = await supabase
                .from('profiles')
                .select('username, is_admin')
                .eq('id', currentUser.id)
                .single();
            if (profileErr) {
                const { data: basicProfile } = await supabase
                    .from('profiles')
                    .select('username')
                    .eq('id', currentUser.id)
                    .single();
                authDisplayName = basicProfile?.username || 'User';
                window.authUserProfile = basicProfile;
                currentUser.is_admin = false;
            } else {
                authDisplayName = authProfile?.username || 'User';
                window.authUserProfile = authProfile;
                currentUser.is_admin = authProfile?.is_admin || false;
            }
        } else {
            authDisplayName = currentUser.UserName || currentUser.username || 'User';
        }
    }
    window.authDisplayName = authDisplayName;

    // In band mode, hide the avatar — the profile data fetch breaks in band context
    // and clicking it would open an empty profile screen. No meaningful action here.
    if (window.isBandMode) {
        document.getElementById('userIdentity-avatar')?.classList.add('hidden');
    }

    // Header avatar + onclick wiring handled by profile.js initProfile() in Personal mode
    // (previously set innerText / onclick directly here)

    window.venueLookup = window.allVenues;
    window.track('app_load', {
        mode:     currentUser.Type,
        is_admin: currentUser.is_admin || false
    });

    const isReadOnly = (window.isBandMode && !currentUser?.is_admin) || window.isFriendMode;
    window.isReadOnly = isReadOnly;
    if (isReadOnly) {
        document.getElementById('btn-add-show')?.classList.add('hidden');
        document.getElementById('unsaved-banner')?.classList.add('hidden');
    }

    // 4. Initial Render & Listeners
    refreshUI();
    initEventListeners();
    initEditor();

    // ── Tip nudge triggers ────────────────────────────────────────────────────
    // Listen for gig save events dispatched by editor.js.
    // Each event checks gig counts and artist repeat thresholds.
    window.addEventListener('giglist:gigSaved', () => {
        const journal = window.journalData || [];
        const count   = journal.length;
        if (count === 1) checkNudgeTrigger('first_gig_saved');
        if (count === 5) checkNudgeTrigger('fifth_gig_saved');

        // same_artist_3x — check if the most-recently-saved gig tips the artist to 3
        const latest = journal[journal.length - 1];
        if (latest) {
            const artist      = (latest.Band || latest.Artist || '').toLowerCase();
            const artistCount = journal.filter(g =>
                (g.Band || g.Artist || '').toLowerCase() === artist
            ).length;
            if (artistCount === 3) checkNudgeTrigger('same_artist_3x');
        }
    });

    // Collection item added
    window.addEventListener('giglist:collectionItemSaved', () => {
        checkNudgeTrigger('collection_item_added');
    });

    // Register deep-link listeners (URL params + SW postMessage)
    initDeepLink();

    // Load social data FIRST so _following is ready when the switcher panel builds
        if (currentUser?.isAuthUser && currentUser?.Type === 'Personal') {
            await initSocial(currentUser);
            resolveCompanionTags(currentUser); // fire-and-forget, no await needed
        }

    initModeSwitcher(currentUser);

    // Band mode — initialise tabs and fan data.
    // Performances are fetched on-demand in band.js when the Summary tab is opened.
    if (currentUser?.Type === 'Band') {
        await initBandMode(currentUser, data.journalData, []);
    }

    // Buddies tab — personal mode only
    // initBuddies and initProfile have no dependency on each other so run in parallel
    if (currentUser?.Type === 'Personal') {
        await Promise.all([
            initBuddies(currentUser),
            initProfile(currentUser),
        ]);
    }

    // App is fully ready — flush any queued deep-link intent
    markAppReady();

    // ── Onboarding & companion notifications ─────────────────────────────────
    if (currentUser?.Type === 'Personal') {
        if (isNewUser) {
            // New user: run the full onboarding flow (companion claim panel + settings modal).
            // checkCompanionTags is intentionally skipped here — runOnboarding handles
            // companion matching for new users via the claim panel, and we don't want
            // the returning-user banner racing with the claim modal.
            setTimeout(() => runOnboarding(currentUser), 400);
        } else {
            // Returning user: check whether anyone has tagged them in a show since
            // they last dismissed the notification. Delayed so the page settles first.
            setTimeout(() => checkCompanionTags(currentUser), 2000);
        }
    }

    // ── Eager collection fetch ────────────────────────────────────────────────
    // Fetch full collection items so the Items stat tile AND collection-based
    // achievements are populated on first load, before the user visits the
    // Collection tab. Fire-and-forget.
    if (currentUser?.isAuthUser && currentUser?.Type === 'Personal') {
        supabase
            .from('collection_items')
            .select('id, type, subtype, band_name, band_id, item_date, body, signed_by, photos, labels')
            .eq('user_id', currentUser.id)
            .then(({ data }) => {
                if (data) {
                    window._collectionItems = data;
                    window._collectionCount = data.length;
                    UI.updateRank();
                }
            });
    }
    // ── Deferred performance load + chart render ──────────────────────────────
    // Performances are not needed for first paint. In personal mode we load them
    // after the page is interactive via Data.loadPerformances() — the same
    // normalise+enrich pipeline used inside loadAppData, so window.performanceData
    // always has the correct shape for the gig modal, search, and charts.
    //
    // Chart.js and performances load in parallel; charts render once both resolve.
    // Band mode: performances are handled entirely in band.js (on Summary tab open).
    if (!window.isBandMode) {
        const journalKeys = (data.journalData || [])
            .map(g => g['Journal Key'])
            .filter(Boolean);

        const perfPromise = journalKeys.length
            ? Data.loadPerformances(journalKeys, window.allVenues || {})
                .then(rows => { window.performanceData = rows; })
                .catch(err => console.warn('app.js: deferred performances load failed', err))
            : Promise.resolve();

        Promise.all([window.ensureChartJs(), perfPromise])
            .then(() => {
                const results = window.filteredResults || window.journalData || [];
                renderDashboardCharts(results, window.performanceData || []);
            })
            .catch(err => console.warn('app.js: chart/performance load failed:', err));
    } else {
        // Band mode: still lazy-load Chart.js for any charts on the Shows tab
        window.ensureChartJs()
            .then(() => {
                const results = window.filteredResults || window.journalData || [];
                renderDashboardCharts(results, []);
            })
            .catch(err => console.warn('Chart.js failed to load:', err));
    }

    // ── Clashfinder prefill ───────────────────────────────────────────────────
    const prefillType = params.get('prefill');
    if (prefillType === 'festival' && currentUser?.Type === 'Personal') {
        const prefillDate     = params.get('date')     || '';
        const prefillVenue    = params.get('venue')    || '';
        const prefillFestival = params.get('festival') || '';
        const prefillBands    = (params.get('bands') || '').split('|').map(b => b.trim()).filter(Boolean);

        if (prefillBands.length > 0) {
            const cleanUrl = new URL(window.location.href);
            ['prefill','date','venue','festival','bands'].forEach(k => cleanUrl.searchParams.delete(k));
            window.history.replaceState({}, '', cleanUrl);

            window.switchView('data');

            setTimeout(() => {
                if (window.openFestivalPrefillModal) {
                    window.openFestivalPrefillModal({
                        date:     prefillDate,
                        venue:    prefillVenue,
                        festival: prefillFestival,
                        bands:    prefillBands,
                    });
                }
            }, 800);
        }
    }
}

function _applyFiltersAndRender() {
  refreshUI();

  // Update summary line
  const filtered = window.filteredResults;
  const summaryLine = document.getElementById('filter-summary-line');
  const summaryText = document.getElementById('filter-summary-text');
  if (summaryLine && summaryText) {
    const active = hasActiveFilters();
    summaryLine.classList.toggle('hidden', !active);
    if (active) {
      summaryText.textContent = buildSummaryLine(filtered.length, window.journalData.length);
    }
  }

  // Update filter button active state
  const filterBtn = document.getElementById('filter-drawer-btn');
  if (filterBtn) {
    filterBtn.classList.toggle('border-indigo-400', hasActiveFilters());
    filterBtn.classList.toggle('text-indigo-600', hasActiveFilters());
  }
}

function refreshUI() {
    const includeFuture = document.getElementById('upcoming-toggle')?.checked;
    const searchVal = document.getElementById('searchInput')?.value || '';

    const searchResults = Data.filterGigs(searchVal, window.journalData, includeFuture);
    const results = applyFilters(searchResults);
    window.filteredResults = results;

    const sortedResults = Data.sortGigs(results, window.currentSort.column, window.currentSort.ascending);

    UI.updateCurrentDate();
    UI.updateStats(results);
    UI.updateRank(results);
    UI.updateTicker(results);
    UI.renderOTDBanner(results);
    UI.renderCarousel(results);

    // ── Tip explore card ──────────────────────────────────────────────────────
    // Shown on home screen below carousel for new/low-engagement users.
    if (currentUser?.Type === 'Personal' && !window.isBandMode) {
        const exploreContainer = document.getElementById('tip-explore-container');
        if (exploreContainer) {
            initExploreCard(exploreContainer, currentUser?.created_at || null);
        }
    }
    if (currentUser?.Type === 'Personal' && !window.isBandMode) {
            import('./modules/capture.js').then(m => m.loadPendingCaptureReminder());
        }

    UI.renderTable(sortedResults);

    const companionContainer = document.getElementById('companionChartContainer');
    const songContainer = document.getElementById('songChartContainer');
    const topBandsContainer = document.getElementById('topBandsChartContainer');

    // Dashboard charts are deferred until Chart.js is loaded.
    // On first page load Chart.js hasn't been fetched yet — charts will render
    // once ensureChartJs() resolves (triggered by first openChartModal call or
    // explicit chart container visibility). On subsequent refreshUI calls after
    // Chart.js is loaded, charts render synchronously as before.
    if (window.Chart) {
        if (window.isBandMode) {
            if (songContainer) {
                songContainer.classList.remove('hidden');
                Charts.renderTopSongsChart(results, 'topSongsChart');
            }
            if (companionContainer) companionContainer.classList.add('hidden');
            if (topBandsContainer) topBandsContainer.classList.add('hidden');
        } else {
            if (songContainer) songContainer.classList.add('hidden');

            if (companionContainer) {
                companionContainer.classList.remove('hidden');
                Charts.renderCompanionChart(results, 'dashboardCompanionChart');
            }

            if (topBandsContainer) {
                topBandsContainer.classList.remove('hidden');
                Charts.renderTopBandsChart(results, window.performanceData, 'topBandsChart');
            }
        }

        Charts.renderYearChart(results, 'dashboardYearChart');
    }

    const mapContainer = document.getElementById('mapContainer');
    if (mapContainer && !mapContainer.classList.contains('hidden')) {
        UI.renderMap(sortedResults);
    }

    if (window.lucide) lucide.createIcons();
}

window.refreshUI = refreshUI;

// ─── CAROUSEL ────────────────────────────────────────────────────────────────
//
// Auto-rotate: advances every 5 s. Pauses on hover. Any manual interaction
// (tap/click on the half-tap zones or dots) resets the timer so the slide
// doesn't immediately jump after a manual swipe.
//
// aria-live is set to 'off' by default so screen readers aren't spammed on
// every auto-advance. It switches to 'polite' only while the carousel wrapper
// has focus, so keyboard users get announcements when they navigate manually.
// ─────────────────────────────────────────────────────────────────────────────

const _carousel = {
    intervalId:  null,
    INTERVAL_MS: 4000,

    start() {
        this.stop();
        this.intervalId = setInterval(() => {
            // Don't auto-advance past the CTA card
            if (currentCarouselIndex < homeCarousel.length - 1) {
                currentCarouselIndex++;
                UI.renderCarouselItem(currentCarouselIndex, homeCarousel, window.journalData);
            } else {
                this.stop(); // reached end — no point looping to the CTA
            }
        }, this.INTERVAL_MS);
    },

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    },

    reset() {
        this.start(); // stop + restart = reset timer
    },
};

window.loadThrowback = (gigs) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    const upcomingGigs = gigs.filter(g => parseDate(g.Date) >= today)
        .sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
    const pastGigs = gigs.filter(g => parseDate(g.Date) < today)
        .sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    UI.updateTicker(gigs);
    UI.renderOTDBanner(gigs);

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
            badge: g.type === 'anniversary'
                ? `${yearsAgo} Year Anniversary`
                : `Memory from ${today.toLocaleString('default', { month: 'long' })}`,
            isFuture: false
        };
    });

    homeCarousel = [...futureItems, ...historicalPool].map(g => ({
        ...g,
        band: g.Band || g.band,
        details: g.details || `${g.OfficialVenue} • ${g.Date}`,
        isCTA: false
    }));

    homeCarousel.push({
        band: 'Ready for more?',
        details: 'Tap here to delve deeper into the Data Lab.',
        badge: 'Next Step',
        isCTA: true,
        isFuture: false
    });

    currentCarouselIndex = 0;
    UI.renderCarouselItem(currentCarouselIndex, homeCarousel, gigs);

    // ── Auto-rotate setup ────────────────────────────────────────────────────
    // Only start if there's more than one real slide
    if (homeCarousel.length > 1) {
        _carousel.start();

        // Pause on hover — the carousel card is the `now-card` element.
        // We attach once; if loadThrowback is called again (filter change etc.)
        // the element is replaced so we re-attach naturally.
        const card = document.getElementById('now-card');
        if (card) {
            card.addEventListener('mouseenter', () => _carousel.stop(),  { passive: true });
            card.addEventListener('mouseleave', () => _carousel.start(), { passive: true });

            // Accessibility: switch aria-live to polite while keyboard-focused
            // so screen reader users hear slide changes when they navigate manually.
            card.addEventListener('focusin',  () => {
                card.setAttribute('aria-live', 'polite');
                _carousel.stop();
            }, { passive: true });
            card.addEventListener('focusout', () => {
                card.setAttribute('aria-live', 'off');
                _carousel.start();
            }, { passive: true });
        }
    }
};

window.rotateCarousel = (direction) => {
    const isLastCard = currentCarouselIndex === homeCarousel.length - 1;

    if (isLastCard && direction === 1) {
        if (typeof window.switchView === 'function') window.switchView('data');
        return;
    }

    const nextIndex = currentCarouselIndex + direction;
    if (nextIndex >= 0 && nextIndex < homeCarousel.length) {
        currentCarouselIndex = nextIndex;
        UI.renderCarouselItem(currentCarouselIndex, homeCarousel, window.journalData);
        _carousel.reset();
    }
};

window.resetCarousel = () => {
    if (!homeCarousel || homeCarousel.length === 0) return;
    currentCarouselIndex = 0;
    UI.renderCarouselItem(currentCarouselIndex, homeCarousel, window.journalData);
    if (homeCarousel.length > 1) _carousel.start();
};

// ─── VIEW SWITCHING ───────────────────────────────────────────────────────────

window.switchView = (viewId) => {
    if (viewId === 'profile') {
        window.openProfile?.(null);
        return;
    }

    document.querySelectorAll('.view-section').forEach(s => {
        s.classList.add('hidden');
        s.setAttribute('aria-hidden', 'true');
    });

    const targetSection = document.getElementById(`view-${viewId}`);
    if (targetSection) {
        targetSection.classList.remove('hidden');
        targetSection.setAttribute('aria-hidden', 'false');
    }

    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active', 'text-indigo-600', 'bg-white', 'shadow-sm');
        n.classList.add('text-slate-400');
        n.setAttribute('aria-current', 'false');
    });

    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) {
        activeNav.classList.add('active', 'text-indigo-600', 'bg-white', 'shadow-sm');
        activeNav.classList.remove('text-slate-400');
        activeNav.setAttribute('aria-current', 'page');
    }

    if (viewId === 'home') {
        window.resetCarousel?.();
    }

    if (viewId === 'feed') {
        Feed.init(window.journalData || [], window.performanceData || []);
    }

    if (viewId === 'collection') {
        if (window._initCollection && window.currentUser) {
            window._initCollection(window.currentUser);
            const colInitials = document.getElementById('col-avatar-initials');
            if (colInitials) colInitials.textContent = (window.authDisplayName || 'U').slice(0, 2).toUpperCase();
        }
    }

    window.scrollTo(0, 0);
};

// ─── CHART FILTER BRIDGE ──────────────────────────────────────────────────────

window.applyChartFilter = (type, value) => {
    const searchInput = document.getElementById('searchInput');

    if (type === 'month') {
        const monthPrefixes = ['/01/','/02/','/03/','/04/','/05/','/06/','/07/','/08/','/09/','/10/','/11/','/12/'];
        if (searchInput) searchInput.value = `${monthPrefixes[value.month]}${value.year}`;
    } else {
        if (searchInput) searchInput.value = value;
    }

    refreshUI();
};

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

function initEventListeners() {
    const search = document.getElementById('searchInput');
    if (search) {
        search.addEventListener('input', () => {
            refreshUI();
        });
    }

    // ── Carousel swipe (touch + mouse drag) ──────────────────────────────────
    // Fixes the tap-only limitation — users can now swipe left/right on the
    // home screen carousel cards. Same pattern used for Collection shelves.
    const carouselEl = document.getElementById('now-card');
    if (carouselEl) {
        let touchStartX = 0;
        let touchStartY = 0;
        let isDragging  = false;
        let dragStartX  = 0;

        // Touch (mobile)
        carouselEl.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        carouselEl.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = e.changedTouches[0].clientY - touchStartY;
            // Only treat as horizontal swipe if x movement dominates
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
                window.rotateCarousel(dx < 0 ? 1 : -1);
            }
        }, { passive: true });

        // Mouse drag (desktop / PWA on tablet)
        carouselEl.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragStartX = e.clientX;
            carouselEl.style.cursor = 'grabbing';
        });

        carouselEl.addEventListener('mouseup', (e) => {
            if (!isDragging) return;
            isDragging = false;
            carouselEl.style.cursor = '';
            const dx = e.clientX - dragStartX;
            if (Math.abs(dx) > 40) {
                window.rotateCarousel(dx < 0 ? 1 : -1);
            }
        });

        carouselEl.addEventListener('mouseleave', () => {
            isDragging = false;
            carouselEl.style.cursor = '';
        });
    }
}

// ─── GIG MODAL ────────────────────────────────────────────────────────────────

window.viewGigDetails = async (key) => {
    if (window.isBandMode) {
        const alreadyLoaded = (window.performanceData || []).some(p => p['Journal Key'] === key);
        if (!alreadyLoaded) {
            try {
                const perfs = await Data.loadPerformances([key], window.allVenues || {});
                window.performanceData = [...(window.performanceData || []), ...perfs];
            } catch (err) {
                console.warn('viewGigDetails: performance fetch failed for', key, err);
            }
        }
    }

    UI.openGigModal(key, window.journalData, window.performanceData);

    const entry = (window.journalData || []).find(g => g['Journal Key'] === key);
    const gigIsPast = entry ? new Date(entry.Date.split('/').reverse().join('-')) < new Date() : true;

    if (currentUser?.isAuthUser && !window.isBandMode) {
        setTimeout(() => window.loadGigAttendees(key, entry?.id), 100);
        if (entry) setTimeout(() => initArchiveButton(entry), 150);
    }

    setTimeout(() => initPlaylistButton(key, gigIsPast), 100);

    window.track('gig_modal_open', {
        band:  entry?.Band,
        venue: entry?.OfficialVenue,
        key,
    });
};

// openGigModal — called by deep-link.js when a push notification is tapped.
// Accepts either a Journal Key (normal UI path) or a Supabase row id (deep-link
// path), plus an options object for special modes like Weezer Wednesday.
window.openGigModal = async (keyOrId, options = {}) => {
    const { weezerWednesday = false } = options;

    // Resolve the Journal Key from either a key or a numeric/UUID row id.
    // journalData entries have both 'Journal Key' (the share key) and 'id' (the
    // Supabase row id). Deep-links arrive with the row id.
    let key = keyOrId;
    const byId = (window.journalData || []).find(g => String(g.id) === String(keyOrId));
    if (byId) {
        key = byId.journal_key ?? byId['Journal Key'];
    }

    if (!key) {
        console.warn('[openGigModal] could not resolve Journal Key for:', keyOrId);
        return;
    }

    await window.viewGigDetails(key);

    if (weezerWednesday) {
        // Weezer Wednesday canvas — wired up in the next PR.
        console.log('[openGigModal] Weezer Wednesday mode for key:', key);
        window.openWeezerWednesdayCanvas(key);
    }
};

window.closeModal = () => {
    // ── Layer B: clean up modal tips before closing ──
    const modalContent = document.getElementById('modal-content');
    if (modalContent) teardownModalTips(modalContent);

    const modal = document.getElementById('modal');
    if (modal) {
        if (modal.contains(document.activeElement)) document.activeElement.blur();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = 'auto';
    }
    // Restore read-only state based on actual mode, not buddy overlay
    window.isReadOnly = (window.isBandMode && !currentUser?.is_admin);
};

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────

window.openSettings = function() {
    // ONBOARDING USE ONLY — this modal is no longer accessible via normal UI.
    // The profile screen (view-profile) is the canonical home for settings.
    // This function is retained because onboarding.js calls it to surface
    // the setlist.fm sync step. See vault.html legacy modal comment for full context.
    window.track('settings_open');
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    // Focus the (legacy-suffixed) setlist input inside this modal
    document.getElementById('setlistIdInput-legacy')?.focus();

    if (window.lucide) lucide.createIcons();
};

window.closeSettings = function() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        if (modal.contains(document.activeElement)) document.activeElement.blur();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
};

window.syncSetlistFm = async function() {
    const username = document.getElementById('setlistIdInput')?.value?.trim();
    if (!username) {
        window.showToast('Please enter your setlist.fm username.', 'warning');
        return;
    }

    const btn        = document.querySelector('[onclick="window.syncSetlistFm()"]');
    const statusEl   = document.getElementById('sync-status');
    const progressEl = document.getElementById('sync-progress');

    const setStatus = (msg, type = 'info') => {
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.className = `text-[10px] mt-3 italic leading-relaxed ${
                type === 'error'   ? 'text-red-500' :
                type === 'success' ? 'text-emerald-600 font-black not-italic' :
                'text-slate-400'
            }`;
        }
    };

    const setProgress = (val) => {
        if (progressEl) {
            progressEl.style.width = val + '%';
            progressEl.parentElement?.classList.toggle('hidden', val === 0);
        }
    };

    if (btn) { btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); }
    setProgress(5);
    setStatus('Connecting to setlist.fm\u2026');
    window.track('setlist_sync_start', { username });

    await runSetlistSync(username, {
        onProgress({ page, fetched, journalInserted, status }) {
            const msg = status === 'rate_limited'
                ? 'Rate limited \u2014 waiting 20s before page ' + page + '\u2026'
                : 'Page ' + page + ' \u2014 ' + fetched + ' shows fetched, ' + journalInserted + ' added\u2026';
            setStatus(msg);
            setProgress(Math.min(90, 5 + page * 8));
        },

        onComplete({ journalInserted, journalSkipped, newVenues, pages }) {
            setProgress(100);
            if (journalInserted > 0) {
                const parts = [journalInserted + ' shows added'];
                if (journalSkipped)  parts.push(journalSkipped + ' already in your list');
                if (newVenues)       parts.push(newVenues + ' new venues discovered');
                setStatus('\u2713 Sync complete \u2014 ' + parts.join(', ') + '.', 'success');
            }
            if (btn) { btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); }

            window.track('setlist_sync_complete', { journalInserted, journalSkipped, newVenues, pages });

            if (journalInserted > 0) {
                setTimeout(async () => {
                    const data = await Data.loadAppData(currentUser, { skipPerformances: true });
                    window.journalData     = data.journalData;
                    window.performanceData = [];
                    window.filteredResults = [...data.journalData];
                    refreshUI();

                    // Re-fetch performances for the updated journal (fire-and-forget)
                    const newKeys = (data.journalData || [])
                        .map(g => g['Journal Key'])
                        .filter(Boolean);
                    if (newKeys.length) {
                        Data.loadPerformances(newKeys, window.allVenues || {})
                            .then(rows => { window.performanceData = rows; })
                            .catch(err => console.warn('app.js: post-sync performance reload failed', err));
                    }

                    window.showToast(journalInserted + ' shows synced from setlist.fm!', 'success');
                }, 800);
            }

            if (journalInserted === 0) {
                handleZeroSyncResult();
            }

            // Always check for gig overlap after a sync (surface other GigList users at same shows)
            if (journalInserted > 0) {
                setTimeout(() => checkGigOverlap(currentUser), 1500);
            }
        },

        onError(msg, { userNotFound = false } = {}) {
            setProgress(0);
            if (btn) { btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); }
            handleZeroSyncResult({ userNotFound });
            window.track('setlist_sync_error', { username, msg });
        },
    });
};

// ─── GIG OVERLAP ─────────────────────────────────────────────────────────────
// Moved to js/modules/social.js

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

window.track = (event, properties = {}) => {
    const userId = window.currentUser?.id;
    if (!userId) return;
    supabase.from('events').insert({ user_id: userId, event, properties })
        .then(({ error }) => { if (error) console.debug('track:', error.message); });
};

// ─── SOCIAL / SWITCHER ───────────────────────────────────────────────────────
// Moved to js/modules/social.js and js/modules/switcher.js




// ─── SCRAPBOOK PHOTO UPLOAD ───────────────────────────────────────────────────

window.uploadScrapbookPhoto = (input, journalKey, formattedDate, cleanVenue, isBandMode = false) => {
    const file = input.files?.[0];
    if (!file) return;

    // Open the crop/frame modal first. The actual upload only fires once the
    // user confirms their framing, via _uploadCroppedScrapbookPhoto below.
    openPhotoCropModal(file, (croppedFile) => {
        _uploadCroppedScrapbookPhoto(croppedFile, journalKey, formattedDate, cleanVenue, isBandMode);
    });

    // Reset so selecting the same file again still fires onchange next time.
    input.value = '';
};

async function _uploadCroppedScrapbookPhoto(file, journalKey, formattedDate, cleanVenue, isBandMode = false) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const userId = session.user.id;
    const bucket = isBandMode ? 'band-photos' : 'gig-photos';
    const storagePath = isBandMode
        ? `${(window.currentArtist || 'band').toLowerCase().replace(/[^a-z0-9]/g, '-')}/${formattedDate}-${cleanVenue}.jpg`
        : `${userId}/${formattedDate}-${cleanVenue}.jpg`;

    const btn = document.getElementById('h-camera-btn');
    const originalHTML = btn?.innerHTML;
    if (btn) btn.innerHTML = `<svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

    try {
        const compressed = await compressImage(file, 1920, 0.85);

        const { error } = await supabase.storage
            .from(bucket)
            .upload(storagePath, compressed, {
                contentType: 'image/jpeg',
                upsert: true
            });

        if (error) throw error;

        const { data: signedData, error: signedError } = isBandMode
            ? await supabase.storage.from('band-photos').getPublicUrl(storagePath)
            : await supabase.storage.from('gig-photos').createSignedUrl(storagePath, 3600);

        const imgUrl = isBandMode ? signedData?.publicUrl : signedData?.signedUrl;
        if (imgUrl) {
            const imgSupabase = document.getElementById('h-supabase');
            if (imgSupabase) {
                document.getElementById('h-scrapbook')?.classList.add('hidden');
                document.getElementById('h-artist')?.classList.add('hidden');
                const ticket = document.getElementById('h-ticket');
                if (ticket) { ticket.classList.add('hidden'); ticket.style.display = ''; }

                imgSupabase.onload = () => imgSupabase.classList.remove('hidden');
                imgSupabase.src = imgUrl;
            }
        }

        if (btn) {
            btn.innerHTML = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>`;
            setTimeout(() => { if (btn) btn.innerHTML = originalHTML; if (window.lucide) lucide.createIcons(); }, 2000);
        }

    } catch (err) {
        console.error('Photo upload failed:', err);
        if (btn && originalHTML) btn.innerHTML = originalHTML;
        if (window.lucide) lucide.createIcons();
        window.showToast('Photo upload failed — try again', 'error');
    }
}

async function compressImage(file, maxDimension, quality) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (width > maxDimension || height > maxDimension) {
                if (width > height) {
                    height = Math.round((height / width) * maxDimension);
                    width  = maxDimension;
                } else {
                    width  = Math.round((width / height) * maxDimension);
                    height = maxDimension;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width  = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            canvas.toBlob(resolve, 'image/jpeg', quality);
        };
        img.src = url;
    });
}

// ─── MODE SWITCHER ───────────────────────────────────────────────────────────
// Moved to js/modules/switcher.js

window.signOut = async function() {
    window.track('sign_out');
    await supabase.auth.signOut();
    window.location.href = 'index.html';
};

window.browseBandMode = function() {
    window.closeSettings();
    window.location.href = 'index.html?mode=Band';
};

/**
 * Triggers the native share sheet or copies link to clipboard
 * @param {Object} gig - The gig object from journalData
 */
window.shareGig = async (gig) => {
    if (!gig) return;

    // Matches your local data key
    const rawKey = gig['Journal Key'] || gig.JournalKey;
    const safeKey = btoa(rawKey);

    // Clean slugs for aesthetics
    const bandName = gig.Band || "Gig";
    const venueName = gig.OfficialVenue || gig.Venue || "Venue";
    const prettySlug = `${bandName}-${venueName}`.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    const shareUrl = `${window.location.origin}${window.location.pathname.replace('vault.html', 'show.html')}?k=${safeKey}&s=${prettySlug}`;

    const shareData = {
        title: `${bandName} at ${venueName}`,
        text: `Check out this show on GigList!`,
        url: shareUrl
    };

    try {
        if (navigator.share) {
            await navigator.share(shareData);
        } else {
            await navigator.clipboard.writeText(shareUrl);
            window.showToast("Link copied to clipboard!", "success");
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error("Share failed:", err);
    }
};

// ─── DATA CONTROLS ────────────────────────────────────────────────────────────

window.handleUpcomingToggle = () => {
    const showUpcoming = document.getElementById('upcoming-toggle')?.checked;
    const currentSearch = document.getElementById('searchInput')?.value || '';

    window.filteredResults = Data.filterGigs(currentSearch, window.journalData, showUpcoming);
    const currentData = Data.sortGigs(
        window.filteredResults,
        window.currentSort.column,
        window.currentSort.ascending
    );

    if (window.activeView === 'calendar') {
        renderCalendar(currentData);
    } else if (window.activeView === 'map') {
        if (window.renderMap) window.renderMap(currentData);
    } else {
        UI.renderTable(currentData);
    }

    UI.updateStats(currentData);
};


window.handleSort = (column) => {
    if (window.currentSort.column === column) {
        window.currentSort.ascending = !window.currentSort.ascending;
    } else {
        window.currentSort.column = column;
        window.currentSort.ascending = (column !== 'Date');
    }

    const baseData = window.filteredResults || window.journalData;
    const sorted = Data.sortGigs(baseData, window.currentSort.column, window.currentSort.ascending);
    UI.renderTable(sorted);
};

// ─── CHART MODALS ─────────────────────────────────────────────────────────────

window.openTopBandsModal = () => {
    window.openChartModal('topbands');
};
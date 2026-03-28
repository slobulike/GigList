/**
 * GigList Core Engine
 * v3.5.1 — 2026-03-28
 * -------------------------------------------------------------------
 * [FIX] Band archive now runs successfully (manual trigger pulls 60 entries, overnight cron job pulls everything)
 */

import * as Data from './modules/data.js';
import * as Charts from './modules/charts.js';
import * as UI from './modules/ui.js';
import { initArchiveButton } from './modules/ui.js';
import { parseDate } from './modules/utils.js';
import { renderBadges, renderBandBadges } from './modules/achievements.js';
import { renderCalendar } from './modules/calendar.js';
import './modules/quiz.js';
import * as Games from './modules/games.js';
import { GigPuzzle } from './modules/puzzle.js';
import { initEditor, exportCSV } from './modules/editor.js';
import { supabase } from './modules/supabase.js';
import { runSetlistSync } from './modules/setlist-sync.js';

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

    // Animate in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-2', 'opacity-0');
        });
    });

    // Auto-dismiss
    setTimeout(() => {
        toast.classList.add('translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, duration);
};


let currentUser = null;
let homeCarousel = [];
let currentCarouselIndex = 0;

const APP_VERSION = "3.5.1";

window.toggleListView = UI.toggleListView;
window.activeView = window.activeView || 'list';
window.journalData = window.journalData || [];
window.renderMap = UI.renderMap;
window.currentSort = { column: 'Date', ascending: false };
window.switchGame = Games.switchGame;
window.startNewPuzzle = Games.startNewPuzzle;

export async function initApp() {
    // Check URL params FIRST
    const params      = new URLSearchParams(window.location.search);
    const bandParam   = params.get('band');
    const friendParam = params.get('friend');
    const friendName  = params.get('friendName') || 'Friend';

    // 1. Check Supabase auth session
    const { data: { session } } = await supabase.auth.getSession();

    if (friendParam && session) {
        // Viewing a friend's journal — must be authenticated
        currentUser = {
            ...( (await supabase.from('profiles').select('*').eq('id', session.user.id).single()).data || {} ),
            UserName:    decodeURIComponent(friendName),
            Type:        'Friend',
            friendId:    friendParam,
            id:          session.user.id,
            isAuthUser:  true
        };
    } else if (bandParam) {
        // Band archive — accessible with or without auth
        const { data: bandRow } = await supabase
            .from('bands')
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
            isAuthUser:  !!session   // track whether viewer is logged in for switcher
        };
    } else if (!session) {
        window.location.href = 'index.html';
        return;
    } else {
        // Authenticated personal user
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

    // 1. Load Data
    const data = await Data.loadAppData(currentUser);
    window.currentUser = currentUser; // expose for modules that need user context
    window.journalData = data.journalData;
    window.performanceData = data.performanceData;
    window.filteredResults = [...data.journalData];

    // Set Mode Flags
    window.isBandMode   = data.user.Type === 'Band';
    window.isFriendMode  = data.user.Type === 'Friend';
    window.currentArtist = data.user.UserName;

    // 2. Apply Band Mode / Friend Mode Branding
    if (window.isFriendMode) {
        document.body.classList.add('band-mode'); // reuse band-mode styles
        const topHeader = document.querySelector('header');
        if (topHeader) {
            topHeader.classList.add('bg-indigo-600', 'border-b-2', 'border-black/10');
            topHeader.classList.remove('bg-white/80', 'backdrop-blur-xl');
            const logoIcon = document.getElementById('header-logo-icon');
            if (logoIcon) { logoIcon.style.backgroundColor = 'rgba(255,255,255,0.2)'; logoIcon.style.boxShadow = 'none'; }
            const titleEl = document.getElementById('header-page-title');
            if (titleEl) { titleEl.textContent = `${currentUser.UserName}'s Gig List`; titleEl.style.color = 'white'; }
            const dateEl = document.getElementById('header-date-display');
            if (dateEl) dateEl.style.color = 'rgba(255,255,255,0.7)';
            const badge = document.getElementById('userIdentity');
            if (badge) { badge.style.color = 'white'; badge.style.backgroundColor = 'rgba(255,255,255,0.2)'; badge.innerText = '...'; }
        }
    }

    if (window.isBandMode) {
        document.body.classList.add('band-mode');

        const topHeader = document.querySelector('header');
        if (topHeader) {
            // Do NOT override position — header must stay fixed in both modes
            topHeader.classList.add('bg-[#189BCC]', 'border-b-2', 'border-black/10');
            // Remove the white/blur default so the band colour shows through cleanly
            topHeader.classList.remove('bg-white/80', 'backdrop-blur-xl');

            // Tint the logo icon to match
            const logoIcon = document.getElementById('header-logo-icon');
            if (logoIcon) {
                logoIcon.style.backgroundColor = 'rgba(255,255,255,0.2)';
                logoIcon.style.boxShadow = 'none';
            }

            // Update the merged title to show the band name
            const titleEl = document.getElementById('header-page-title');
            if (titleEl) {
                titleEl.textContent = window.currentArtist || 'Artist Archive';
                titleEl.style.color = 'white';
            }

            // Date line in white too
            const dateEl = document.getElementById('header-date-display');
            if (dateEl) dateEl.style.color = 'rgba(255,255,255,0.7)';

            // Style the user badge for the band colour header
            const badge = document.getElementById('userIdentity');
            if (badge) {
                badge.style.color = 'white';
                badge.style.backgroundColor = 'rgba(255,255,255,0.2)';
                badge.innerText = '...'; // placeholder until profile fetch resolves
            }
        }
    }

    // 3. Metadata & Identity
    const versionEl = document.getElementById('app-version-display');
    if (versionEl) versionEl.innerText = APP_VERSION;

    // Resolve the authenticated user's real display name.
    // In band mode currentUser is the band, so fetch the real profile separately.
    let authDisplayName = 'User';
    if (currentUser.isAuthUser) {
        if (currentUser.Type === 'Band') {
            // Select only username first — is_admin column may not exist yet
            const { data: authProfile, error: profileErr } = await supabase
                .from('profiles')
                .select('username, is_admin')
                .eq('id', currentUser.id)
                .single();
            if (profileErr) {
                // Fallback: try without is_admin in case column not yet added
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
    // Expose for switcher and other modules
    window.authDisplayName = authDisplayName;

    const identityEl = document.getElementById('userIdentity');
    if (identityEl) {
        if (!currentUser.isAuthUser) {
            identityEl.innerText = 'Sign In';
            identityEl.onclick = () => window.location.href = 'index.html';
        } else {
            identityEl.innerText = authDisplayName;
            identityEl.style.cursor = 'pointer';
            identityEl.setAttribute('role', 'button');
            identityEl.setAttribute('aria-label', 'Open User Settings');
            identityEl.setAttribute('tabindex', '0');
            identityEl.onclick = window.openSettings;
            identityEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') window.openSettings(); };
        }
    }

    // loadVenues is called inside loadAppData and its result stored as window.allVenues.
    // Alias it here under the name the rest of the app expects.
    window.venueLookup = window.allVenues;
    window.track('app_load', {
        mode:     currentUser.Type,
        is_admin: currentUser.is_admin || false
    });

    // Enforce read-only for non-admin band mode visitors
    // Admin check relies on is_admin from profiles table — run SQL:
    //   alter table profiles add column is_admin boolean default false;
    //   update profiles set is_admin = true where username = 'Rich';
    const isReadOnly = (window.isBandMode && !currentUser?.is_admin) || window.isFriendMode;
    window.isReadOnly = isReadOnly;
    if (isReadOnly) {
        // Hide edit controls — they'll also be hidden in the gig modal via window.isReadOnly
        document.getElementById('btn-add-show')?.classList.add('hidden');
        document.getElementById('unsaved-banner')?.classList.add('hidden');
    }

    // 4. Initial Render & Listeners
    refreshUI();
    initEventListeners();
    initEditor();

    // Load social data FIRST so _following is ready when the switcher panel builds
    if (currentUser?.isAuthUser && (currentUser?.Type === 'Personal' || currentUser?.Type === 'Friend')) {
        await initSocial(); // populates _following before switcher is built
    }

    initModeSwitcher(); // build the logo dropdown switcher (uses _following)

    // New user onboarding — open settings modal pre-focused on setlist.fm sync
    const isNewUser = new URLSearchParams(window.location.search).get('new') === 'true';
    if (isNewUser && currentUser?.Type === 'Personal') {
        setTimeout(() => {
            window.openSettings();
            const input = document.getElementById('setlistIdInput');
            const hint  = document.getElementById('sync-status');
            if (input) input.focus();
            if (hint) {
                hint.textContent = 'Welcome! Enter your setlist.fm username to import your gig history.';
                hint.className = 'text-[10px] mt-3 leading-relaxed text-indigo-500 font-black not-italic';
            }
        }, 600);
    }
}

function refreshUI() {
    const includeFuture = document.getElementById('upcoming-toggle')?.checked;
    const searchVal = document.getElementById('searchInput')?.value || '';

    const results = Data.filterGigs(searchVal, window.journalData, includeFuture);
    window.filteredResults = results;

    const sortedResults = Data.sortGigs(results, window.currentSort.column, window.currentSort.ascending);

    UI.updateCurrentDate();
    UI.updateStats(results);
    UI.updateRank(results);
    UI.updateFavouriteButton(); // async — fetches fan count and favourite state
    UI.updateTicker(results);
    UI.renderOTDBanner(results);
    UI.renderCarousel(results);
    UI.renderTable(sortedResults);

    // Chart visibility by mode
    const companionContainer = document.getElementById('companionChartContainer');
    const songContainer = document.getElementById('songChartContainer');
    const topBandsContainer = document.getElementById('topBandsChartContainer');

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

    // Map (only re-render if currently visible)
    const mapContainer = document.getElementById('mapContainer');
    if (mapContainer && !mapContainer.classList.contains('hidden')) {
        UI.renderMap(sortedResults);
    }

    if (window.lucide) lucide.createIcons();
}

window.refreshUI = refreshUI;

// ─── CAROUSEL ────────────────────────────────────────────────────────────────

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
    }
};

// ─── VIEW SWITCHING ───────────────────────────────────────────────────────────

window.switchView = (viewId) => {
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

    if (viewId === 'achievements') {
        if (window.isBandMode) {
            renderBandBadges(window.performanceData);
        } else {
            renderBadges(window.journalData);
        }
    }

    window.scrollTo(0, 0);
};

// ─── CHART FILTER BRIDGE ──────────────────────────────────────────────────────

// Called by charts.js when a bar is clicked — maps chart clicks to search filters
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
        search.addEventListener('input', () => refreshUI());
    }
}

// ─── GIG MODAL ────────────────────────────────────────────────────────────────

window.viewGigDetails = (key) => {
    UI.openGigModal(key, window.journalData, window.performanceData);
    if (currentUser?.isAuthUser && !window.isBandMode) {
        setTimeout(() => window.loadGigAttendees(key), 100);
        // Async — renders archive status button into placeholder span
        const entry = (window.journalData || []).find(g => g['Journal Key'] === key);
        if (entry) setTimeout(() => initArchiveButton(entry), 150);
    }
    const entry = (window.journalData || []).find(g => g['Journal Key'] === key);
    window.track('gig_modal_open', { band: entry?.Band, venue: entry?.OfficialVenue, key });
};
window.openGigModal = window.viewGigDetails;

window.closeModal = () => {
    const modal = document.getElementById('modal');
    if (modal) {
        if (modal.contains(document.activeElement)) document.activeElement.blur();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = 'auto';
    }
};

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────

window.openSettings = function() {
    window.track('settings_open');
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    // Settings always relates to the authenticated user, not the archive being viewed.
    // Only hide personal sections for unauthenticated band archive visitors.
    const isUnauthenticated = !window.currentUser?.isAuthUser;
    const exportSection  = document.getElementById('settings-export-section');
    const setlistSection = document.getElementById('setlistIdInput')?.closest('.bg-slate-50');
    const friendsSection = document.getElementById('settings-friends-section');
    const privacySection = document.getElementById('settings-privacy-section');

    if (exportSection)  exportSection.classList.toggle('hidden', isUnauthenticated);
    if (setlistSection) setlistSection.classList.toggle('hidden', isUnauthenticated);
    if (friendsSection) friendsSection.classList.toggle('hidden', isUnauthenticated);
    if (privacySection) privacySection.classList.toggle('hidden', isUnauthenticated);

    // Refresh the following list and privacy toggle whenever settings opens
    if (!isUnauthenticated) {
        renderFollowingList?.();
        loadPrivacySetting?.();
    }

    document.getElementById('setlistIdInput')?.focus();

    // Wire Enter key on friend search (safe to add multiple times — same handler)
    const friendInput = document.getElementById('friend-search-input');
    if (friendInput && !friendInput._enterWired) {
        friendInput._enterWired = true;
        friendInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') window.searchFriends();
        });
    }

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

    // UI elements in the settings modal
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

    // Disable button while running
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
            const parts = [journalInserted + ' shows added'];
            if (journalSkipped)  parts.push(journalSkipped + ' already in your list');
            if (newVenues)       parts.push(newVenues + ' new venues discovered');
            setStatus('\u2713 Sync complete \u2014 ' + parts.join(', ') + '.', 'success');
            if (btn) { btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); }

            window.track('setlist_sync_complete', { journalInserted, journalSkipped, newVenues, pages });

            if (journalInserted > 0) {
                setTimeout(async () => {
                    const data = await Data.loadAppData(currentUser);
                    window.journalData     = data.journalData;
                    window.performanceData = data.performanceData;
                    window.filteredResults = [...data.journalData];
                    refreshUI();
                    window.showToast(journalInserted + ' shows synced from setlist.fm!', 'success');
                }, 800);
            }

            // If this is a new user (?new=true), trigger the connections banner
            const isNewUser = new URLSearchParams(window.location.search).get('new') === 'true';
            if (isNewUser && journalInserted > 0) {
                setTimeout(() => checkGigOverlap(), 1500);
            }
        },

        onError(msg) {
            setProgress(0);
            setStatus('Sync failed: ' + msg, 'error');
            if (btn) { btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); }
            window.showToast('Sync failed \u2014 see settings for details.', 'error');
            window.track('setlist_sync_error', { username, msg });
        },
    });
};

// ─── SOCIAL / FRIENDS ────────────────────────────────────────────────────────

// ─── GIG OVERLAP / CONNECTIONS BANNER ────────────────────────────────────────

async function checkGigOverlap() {
    if (!currentUser?.isAuthUser || currentUser?.Type !== 'Personal') return;

    const banner = document.getElementById('connections-banner');
    if (!banner) return;

    // Don't re-show if dismissed this session
    if (sessionStorage.getItem('connections_dismissed')) return;

    const { data: myJournals, error: myErr } = await supabase
        .from('journals')
        .select('journal_key')
        .eq('user_id', currentUser.id);

    if (myErr || !myJournals?.length) return;

    const myKeys = myJournals.map(j => j.journal_key);

    const { data: matches, error: matchErr } = await supabase
        .from('journals')
        .select('user_id, journal_key, band, official_venue, date')
        .in('journal_key', myKeys)
        .neq('user_id', currentUser.id)
        .not('user_id', 'is', null);

    if (matchErr || !matches?.length) return;

    // Group by user_id and count shared shows
    const byUser = new Map();
    for (const row of matches) {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, { userId: row.user_id, shows: [] });
        byUser.get(row.user_id).shows.push(row);
    }
    if (!byUser.size) return;

    const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', [...byUser.keys()]);

    if (!profiles?.length) return;

    const connections = profiles.map(p => ({
        ...p,
        shows: byUser.get(p.id)?.shows || [],
        count: byUser.get(p.id)?.shows.length || 0,
    })).sort((a, b) => b.count - a.count);

    const followingSet = new Set((window._following || []).map(f => f.id));
    const list = document.getElementById('connections-list');
    if (!list) return;

    list.innerHTML = connections.map(c => {
        const alreadyFollowing = followingSet.has(c.id);
        const ex = c.shows[0];
        const example = ex ? ex.band + ' at ' + ex.official_venue : '';
        return `
        <div class="flex items-start justify-between gap-3" data-user-id="${c.id}">
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-indigo-900">${c.username}</p>
                <p class="text-[10px] text-indigo-500 mt-0.5">
                    ${c.count} show${c.count !== 1 ? 's' : ''} in common${example ? ' &mdash; incl. ' + example : ''}
                </p>
            </div>
            ${alreadyFollowing
                ? '<span class="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex-shrink-0 pt-0.5">Following</span>'
                : `<button onclick="window.followUser('${c.id}', '${c.username}', this.closest('[data-user-id]'))"
                          class="flex-shrink-0 bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                       Follow
                   </button>`
            }
        </div>`;
    }).join('');

    banner.classList.remove('hidden');
    window.track('connections_banner_shown', { count: connections.length });
}

window.dismissConnectionsBanner = function() {
    document.getElementById('connections-banner')?.classList.add('hidden');
    sessionStorage.setItem('connections_dismissed', '1');
    window.track('connections_banner_dismissed');
};

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

window.track = (event, properties = {}) => {
    const userId = window.currentUser?.id;
    if (!userId) return;
    // Fire and forget — never blocks UI
    supabase.from('events').insert({ user_id: userId, event, properties })
        .then(({ error }) => { if (error) console.debug('track:', error.message); });
};

// ─── PRIVACY TOGGLE ──────────────────────────────────────────────────────────

window.togglePrivacy = async () => {
    const btn   = document.getElementById('privacy-toggle');
    const knob  = document.getElementById('privacy-knob');
    const isNowPublic = btn?.getAttribute('aria-checked') !== 'true';

    const { error } = await supabase
        .from('profiles')
        .update({ is_public: isNowPublic })
        .eq('id', currentUser.id);

    if (error) { window.showToast('Could not update privacy setting', 'error'); return; }

    btn?.setAttribute('aria-checked', String(isNowPublic));
    if (btn)  btn.classList.toggle('bg-indigo-600', isNowPublic);
    if (btn)  btn.classList.toggle('bg-slate-200',  !isNowPublic);
    if (knob) knob.style.transform = isNowPublic ? 'translateX(1.5rem)' : 'translateX(0)';

    window.showToast(
        isNowPublic ? 'Profile set to public — anyone can follow you' : 'Profile set to private — follows need your approval',
        'info', 4000
    );
};

async function loadPrivacySetting() {
    const { data } = await supabase
        .from('profiles')
        .select('is_public')
        .eq('id', currentUser.id)
        .single();

    const isPublic = data?.is_public || false;
    const btn  = document.getElementById('privacy-toggle');
    const knob = document.getElementById('privacy-knob');
    if (btn)  btn.setAttribute('aria-checked', String(isPublic));
    if (btn)  btn.classList.toggle('bg-indigo-600', isPublic);
    if (btn)  btn.classList.toggle('bg-slate-200',  !isPublic);
    if (knob) knob.style.transform = isPublic ? 'translateX(1.5rem)' : 'translateX(0)';
}

let _following = []; // cache: [{id, username}] of users I follow
let _followers = []; // cache: [{id, username}] of users who follow me

async function initSocial() {
    // Step 1: get raw follow IDs (accepted only for the journal-access list)
    const [followingRes, followersRes, pendingRes] = await Promise.all([
        supabase.from('follows').select('following_id').eq('follower_id', currentUser.id).eq('status', 'accepted'),
        supabase.from('follows').select('follower_id').eq('following_id', currentUser.id).eq('status', 'accepted'),
        supabase.from('follows').select('follower_id').eq('following_id', currentUser.id).eq('status', 'pending')
    ]);

    const followingIds = (followingRes.data || []).map(r => r.following_id).filter(Boolean);
    const followerIds  = (followersRes.data || []).map(r => r.follower_id).filter(Boolean);

    // Step 2: look up usernames from profiles (no join ambiguity)
    const [followingProfiles, followerProfiles] = await Promise.all([
        followingIds.length
            ? supabase.from('profiles').select('id, username').in('id', followingIds)
            : Promise.resolve({ data: [] }),
        followerIds.length
            ? supabase.from('profiles').select('id, username').in('id', followerIds)
            : Promise.resolve({ data: [] })
    ]);

    _following = (followingProfiles.data || []).map(r => ({ id: r.id, username: r.username }));
    _followers = (followerProfiles.data  || []).map(r => ({ id: r.id, username: r.username }));

    window._following = _following;
    window._followers = _followers;

    // Pending requests — people who want to follow me but I haven't accepted yet
    const pendingRequestIds = (pendingRes.data || []).map(r => r.follower_id).filter(Boolean);
    let pendingRequestProfiles = [];
    if (pendingRequestIds.length) {
        const { data: pp } = await supabase.from('profiles').select('id, username').in('id', pendingRequestIds);
        pendingRequestProfiles = pp || [];
    }
    window._pendingRequests = pendingRequestProfiles;

    // Show follow-back prompt for accepted followers I don't follow back
    const followingSet = new Set(_following.map(f => f.id));
    const pendingFollowBack = _followers.filter(f => !followingSet.has(f.id));

    const allPrompts = [
        ...pendingRequestProfiles.map(f => ({ ...f, type: 'request' })),
        ...pendingFollowBack.map(f => ({ ...f, type: 'followback' }))
    ];

    if (allPrompts.length > 0) {
        const banner = document.getElementById('follow-back-banner');
        const list   = document.getElementById('follow-back-list');
        if (banner && list) {
            list.innerHTML = allPrompts.map(f => f.type === 'request' ? `
                <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-black text-indigo-900">${f.username} wants to follow you</span>
                    <div class="flex gap-2 flex-shrink-0">
                        <button onclick="window.acceptFollowRequest('${f.id}', '${f.username}', this.closest('.flex'))"
                                class="bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                            Accept
                        </button>
                        <button onclick="window.declineFollowRequest('${f.id}', this.closest('.flex'))"
                                class="text-slate-400 text-[10px] font-black px-3 py-1.5 rounded-full hover:text-slate-600 transition-colors uppercase tracking-widest">
                            Decline
                        </button>
                    </div>
                </div>` : `
                <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-black text-indigo-900">${f.username} is following you</span>
                    <div class="flex gap-2 flex-shrink-0">
                        <button onclick="window.followUser('${f.id}', '${f.username}', this.closest('div[data-user]'))"
                                data-user="${f.id}"
                                class="bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                            Follow Back
                        </button>
                        <button onclick="this.closest('[data-dismiss]').remove()"
                                data-dismiss="${f.id}"
                                class="text-slate-400 text-[10px] font-black px-3 py-1.5 rounded-full hover:text-slate-600 transition-colors uppercase tracking-widest">
                            Not Now
                        </button>
                    </div>
                </div>
            `).join('');
            banner.classList.remove('hidden');
        }
    }

    // Populate following list in settings
    renderFollowingList();
    loadPrivacySetting();
}

function renderFollowingList() {
    const container = document.getElementById('following-users');
    if (!container) return;

    if (_following.length === 0) {
        container.innerHTML = '<p class="text-xs text-slate-400 italic">Not following anyone yet — search above to find friends.</p>';
        return;
    }

    container.innerHTML = _following.map(f => `
        <div class="flex items-center justify-between gap-2">
            <button onclick="window._switchToFriend('${f.id}', '${f.username}')"
                    class="text-sm font-black text-slate-700 hover:text-indigo-600 transition-colors text-left">
                ${f.username}
            </button>
            <button onclick="window.unfollowUser('${f.id}', '${f.username}')"
                    class="text-[10px] font-bold text-slate-400 hover:text-red-500 transition-colors uppercase tracking-widest">
                Unfollow
            </button>
        </div>
    `).join('');
}

// Search for users by username
window.searchFriends = async () => {
    const input   = document.getElementById('friend-search-input');
    const results = document.getElementById('friend-search-results');
    const q       = input?.value.trim();
    if (!q || !results) return;

    results.innerHTML = '<p class="text-xs text-slate-400 italic">Searching…</p>';
    results.classList.remove('hidden');

    const { data, error } = await supabase
        .from('profiles')
        .select('id, username')
        .ilike('username', `%${q}%`)
        .neq('id', currentUser.id)
        .limit(8);

    if (error || !data?.length) {
        results.innerHTML = '<p class="text-xs text-slate-400 italic">No users found.</p>';
        return;
    }

    const followingIds = new Set(_following.map(f => f.id));

    results.innerHTML = data.map(u => {
        const isFollowing = followingIds.has(u.id);
        return `
        <div class="flex items-center justify-between gap-2 py-1">
            <span class="text-sm font-black text-slate-700">${u.username}</span>
            ${isFollowing
                ? `<span class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Following</span>`
                : `<button onclick="window.followUser('${u.id}', '${u.username}', this)"
                          class="bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                       Follow
                   </button>`
            }
        </div>`;
    }).join('');
};

window.followUser = async (userId, username, btn) => {
    // Check if target user has a public profile (auto-accept) or private (pending)
    const { data: targetProfile } = await supabase
        .from('profiles')
        .select('is_public')
        .eq('id', userId)
        .single();

    const followStatus = targetProfile?.is_public ? 'accepted' : 'pending';

    const { error } = await supabase.from('follows').insert({
        follower_id:  currentUser.id,
        following_id: userId,
        status:       followStatus
    });
    if (error) {
        const msg = error.code === '23505'
            ? `You're already following ${username}`
            : `Couldn't follow ${username} — try again`;
        window.showToast(msg, 'warning');
        if (error.code === '23505' && !_following.find(f => f.id === userId)) {
            _following.push({ id: userId, username });
            window._following = _following;
            renderFollowingList();
            rebuildSwitcherPanel();
        }
        return;
    }

    window.track('follow_user', { target: username, status: followStatus });
    if (followStatus === 'pending') {
        window.showToast(`Follow request sent to ${username}`, 'info');
        // Update button to show pending state
        if (btn) {
            const el = btn.tagName === 'BUTTON' ? btn : btn.querySelector('button');
            if (el) el.outerHTML = `<span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Requested</span>`;
        }
        return; // Don't add to _following yet — not accepted
    }

    // Update cache
    _following.push({ id: userId, username });
    window._following = _following;

    // Update button to "Following"
    if (btn) {
        const el = btn.tagName === 'BUTTON' ? btn : btn.querySelector('button');
        if (el) {
            el.outerHTML = `<span class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Following</span>`;
        }
    }

    renderFollowingList();
    rebuildSwitcherPanel();

    // Remove from follow-back banner if present
    const bannerRow = document.querySelector(`[data-user="${userId}"]`);
    bannerRow?.closest('[data-dismiss]')?.remove() ||
    bannerRow?.closest('.flex')?.remove();

    // Update any +follow buttons in the currently open gig modal
    document.querySelectorAll(`button[onclick*="followUser('${userId}"]`).forEach(b => {
        b.outerHTML = `<span class="text-indigo-300 text-[9px] font-black">✓</span>`;
    });
};

window.unfollowUser = async (userId, username) => {
    // Show inline confirmation toast instead of blocking confirm()
    const confirmed = await new Promise(resolve => {
        const container = document.getElementById('toast-container');
        if (!container) { resolve(window.confirm('Unfollow ' + username + '?')); return; }
        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'toast-yes-' + Date.now();
        const noId  = 'toast-no-'  + Date.now();
        toast.innerHTML =
            '<span class="flex-1">Unfollow <strong>' + username + '</strong>?</span>' +
            '<button id="' + yesId + '" class="bg-red-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-colors">Yes</button>' +
            '<button id="' + noId  + '" class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">No</button>';
        container.appendChild(toast);
        document.getElementById(yesId).onclick = () => { toast.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { toast.remove(); resolve(false); };
    });
    if (!confirmed) return;
    const { error } = await supabase.from('follows')
        .delete()
        .eq('follower_id', currentUser.id)
        .eq('following_id', userId);
    if (error) { window.showToast(`Couldn't unfollow ${username} — try again`, 'error'); return; }

    _following = _following.filter(f => f.id !== userId);
    window._following = _following;
    renderFollowingList();
    rebuildSwitcherPanel();
};

window.acceptFollowRequest = async (userId, username, rowEl) => {
    const { error } = await supabase.from('follows')
        .update({ status: 'accepted' })
        .eq('follower_id', userId)
        .eq('following_id', currentUser.id);
    if (error) { window.showToast('Could not accept request', 'error'); return; }
    rowEl?.remove();
    window.showToast(`You're now connected with ${username}`, 'success');
    // Hide banner if no more prompts
    const list = document.getElementById('follow-back-list');
    if (list && !list.children.length) {
        document.getElementById('follow-back-banner')?.classList.add('hidden');
    }
};

window.declineFollowRequest = async (userId, rowEl) => {
    const { error } = await supabase.from('follows')
        .delete()
        .eq('follower_id', userId)
        .eq('following_id', currentUser.id);
    if (error) { window.showToast('Could not decline request', 'error'); return; }
    rowEl?.remove();
    const list = document.getElementById('follow-back-list');
    if (list && !list.children.length) {
        document.getElementById('follow-back-banner')?.classList.add('hidden');
    }
};

// Rebuild the switcher panel after follow state changes
function rebuildSwitcherPanel() {
    const existing = document.getElementById('mode-switcher-panel');
    if (existing) existing.remove();
    window._switcherPanelBuilt = false;
}

// Switch to a friend's journal
window._switchToFriend = (userId, username) => {
    closeSwitcher();
    window.location.href = `vault.html?friend=${userId}&friendName=${encodeURIComponent(username)}`;
};

// Load GigList attendees for a show — called from openGigModal
window.loadGigAttendees = async (journalKey) => {
    if (!currentUser?.isAuthUser) return;

    const safeKey   = journalKey.replace(/[^a-z0-9]/gi, '_');
    const container = document.getElementById(`modal-giglist-attendees-${safeKey}`);
    const list      = document.getElementById(`modal-giglist-attendees-list-${safeKey}`);
    if (!container || !list) return;

    // Query the show_attendance view (exposes only user_id + journal_key, no private data)
    const { data: attendees, error } = await supabase
        .from('show_attendance')
        .select('user_id')
        .eq('journal_key', journalKey)
        .neq('user_id', currentUser.id);

    if (error) { console.warn('loadGigAttendees:', error.message); return; }
    if (!attendees?.length) return;

    const otherIds = attendees.map(r => r.user_id);

    // Look up usernames from profiles
    const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', otherIds);

    if (!profiles?.length) return;

    const followingIds = new Set((_following || []).map(f => f.id));

    list.innerHTML = profiles.map(p => {
        const isFollowing = followingIds.has(p.id);
        return `
            <span class="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-black uppercase tracking-wider">
                <i data-lucide="music" class="w-2.5 h-2.5" aria-hidden="true"></i>
                ${p.username}
                ${!isFollowing
                    ? `<button onclick="window.followUser('${p.id}', '${p.username}', this)" class="ml-0.5 text-indigo-400 hover:text-indigo-700 font-black transition-colors">+follow</button>`
                    : ''}
            </span>`;
    }).join('');

    container.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
};

// ─── BAND FAVOURITE TOGGLE ────────────────────────────────────────────────────

window.toggleFavourite = async () => {
    if (!window.isBandMode) return;

    if (!currentUser?.isAuthUser) {
        window.location.href = 'index.html';
        return;
    }

    const bandName = window.currentArtist;
    const userId   = currentUser.id;
    const btn      = document.getElementById('btn-favourite');
    const label    = document.getElementById('btn-favourite-label');
    const countEl  = document.getElementById('btn-favourite-count');
    const rankEl   = document.getElementById('stat-rank');

    // Optimistic UI — update immediately, sync with server after
    const wasFavourite = window._isFavourite;
    window._isFavourite = !wasFavourite;

    const currentCount = parseInt(rankEl?.textContent || '0', 10) || 0;
    const newCount     = wasFavourite ? Math.max(0, currentCount - 1) : currentCount + 1;
    if (rankEl)  rankEl.textContent  = newCount;
    if (countEl) countEl.textContent = newCount ? `· ${newCount} fan${newCount !== 1 ? 's' : ''}` : '';

    if (window._isFavourite) {
        if (label) label.textContent = `Favourited ${bandName}`;
        btn?.classList.add('border-pink-400', 'text-pink-500', 'bg-pink-50');
        const icon = btn?.querySelector('[data-lucide]');
        if (icon) icon.style.fill = 'currentColor';
    } else {
        if (label) label.textContent = `Add ${bandName} to Favourites`;
        btn?.classList.remove('border-pink-400', 'text-pink-500', 'bg-pink-50');
        const icon = btn?.querySelector('[data-lucide]');
        if (icon) icon.style.fill = 'none';
    }

    // Sync with server
    if (wasFavourite) {
        await supabase.from('band_fans').delete()
            .eq('band_name', bandName).eq('user_id', userId);
    } else {
        await supabase.from('band_fans')
            .insert({ band_name: bandName, user_id: userId });
    }
};

// ─── SCRAPBOOK PHOTO UPLOAD ───────────────────────────────────────────────────

window.uploadScrapbookPhoto = async (input, journalKey, formattedDate, cleanVenue, isBandMode = false) => {
    const file = input.files?.[0];
    if (!file) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const userId = session.user.id;
    const bucket = isBandMode ? 'band-photos' : 'gig-photos';
    const storagePath = isBandMode
        ? `${(window.currentArtist || 'band').toLowerCase().replace(/[^a-z0-9]/g, '-')}/${formattedDate}-${cleanVenue}.jpg`
        : `${userId}/${formattedDate}-${cleanVenue}.jpg`;

    // Show uploading state on the camera button
    const btn = document.getElementById('h-camera-btn');
    const originalHTML = btn?.innerHTML;
    if (btn) btn.innerHTML = `<svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

    try {
        // Convert to JPEG at reasonable quality to keep file sizes sensible
        const compressed = await compressImage(file, 1920, 0.85);

        const { error } = await supabase.storage
            .from(bucket)
            .upload(storagePath, compressed, {
                contentType: 'image/jpeg',
                upsert: true   // replace if photo already exists for this show
            });

        if (error) throw error;

        // Get a signed URL and update the modal image immediately
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

        // Restore camera button with a success tick briefly
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

    // Reset the file input so the same file can be re-selected if needed
    input.value = '';
};

/**
 * Compresses an image file to a JPEG at the given max dimension and quality.
 * Keeps aspect ratio. Returns a Blob.
 */
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

async function initModeSwitcher() {
    if (!currentUser?.isAuthUser) return;

    const { data: bands } = await supabase.from('bands').select('name, rank').order('rank');
    window._switcherBands = bands || [];

    const logoLink = document.getElementById('header-logo-link');
    if (!logoLink) return;

    logoLink.removeAttribute('href');
    logoLink.style.cursor = 'pointer';
    logoLink.setAttribute('role', 'button');
    logoLink.setAttribute('aria-label', 'Switch mode');
    logoLink.setAttribute('aria-expanded', 'false');
    logoLink.setAttribute('aria-controls', 'mode-switcher-panel');

    // Make all child elements pass clicks through to the <a>
    logoLink.querySelectorAll('*').forEach(el => el.style.pointerEvents = 'none');

    logoLink.addEventListener('click', (e) => {
        e.preventDefault();
        toggleSwitcher();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('mode-switcher-panel');
        if (panel && !panel.classList.contains('hidden') &&
            !panel.contains(e.target) && !logoLink.contains(e.target)) {
            closeSwitcher();
        }
    });
}

function toggleSwitcher() {
    const panel = document.getElementById('mode-switcher-panel');
    if (!panel) { buildSwitcherPanel(); return; }
    if (panel.classList.contains('hidden')) {
        openSwitcher();
    } else {
        closeSwitcher();
    }
}

function openSwitcher() {
    let panel = document.getElementById('mode-switcher-panel');
    if (!panel) panel = buildSwitcherPanel();
    panel.classList.remove('hidden');
    document.getElementById('header-logo-link')?.setAttribute('aria-expanded', 'true');
    if (window.lucide) lucide.createIcons();
}

function closeSwitcher() {
    const panel = document.getElementById('mode-switcher-panel');
    if (panel) panel.classList.add('hidden');
    document.getElementById('header-logo-link')?.setAttribute('aria-expanded', 'false');
}

function buildSwitcherPanel() {
    const isPersonal  = currentUser.Type === 'Personal';
    const isBand      = currentUser.Type === 'Band';
    const bands       = window._switcherBands || [];
    const currentBand = isBand ? currentUser.UserName : null;

    const panel = document.createElement('div');
    panel.id        = 'mode-switcher-panel';
    panel.className = 'absolute top-full left-0 mt-2 w-64 bg-white rounded-[1.5rem] shadow-2xl border border-slate-100 overflow-hidden z-[200]';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Switch mode');

    const row = (label, sublabel, active, onclick, icon = 'check') => `
        <button onclick="${onclick}" role="menuitem"
                class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors ${active ? 'opacity-50 cursor-default pointer-events-none' : ''}">
            <span class="w-5 flex-shrink-0 flex items-center justify-center">
                ${active ? `<i data-lucide="${icon}" class="w-4 h-4 text-indigo-600"></i>` : ''}
            </span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-black text-slate-900 truncate">${label}</span>
                ${sublabel ? `<span class="block text-[10px] text-slate-400 font-bold uppercase tracking-widest">${sublabel}</span>` : ''}
            </span>
        </button>`;

    const isFriend      = currentUser.Type === 'Friend';
    const currentFriend = isFriend ? currentUser.friendId : null;
    const following     = window._following || [];
    // Section toggle states — start expanded if currently in that mode
    const bandsExpanded     = isBand;
    const followingExpanded = isFriend || (following.length > 0 && !isBand);

    panel.innerHTML = `
        ${row(isFriend ? 'My Gig List' : (window.authDisplayName || 'My Gig List'),
              'Personal Archive',
              isPersonal,
              isPersonal ? '' : "window._switchToPersonal()")}

        ${following.length > 0 ? `
        <div class="border-t border-slate-100">
            <button onclick="window._toggleFollowingSection(this)" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                    aria-expanded="${followingExpanded}" aria-controls="switcher-following-list">
                <span class="w-5 flex-shrink-0"></span>
                <span class="flex-1 text-sm font-black text-slate-900">Following</span>
                <i data-lucide="chevron-${followingExpanded ? 'up' : 'down'}" class="w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true"></i>
            </button>
            <div id="switcher-following-list" class="${followingExpanded ? '' : 'hidden'} bg-slate-50/50">
                ${following.map(f => row(
                    f.username, 'Personal Archive',
                    f.id === currentFriend,
                    f.id === currentFriend ? '' : `window._switchToFriend('${f.id}', '${f.username.replace(/'/g, "\'")}')`
                )).join('')}
            </div>
        </div>` : ''}

        <div class="border-t border-slate-100">
            <button onclick="window._toggleBandSection(this)" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                    aria-expanded="${bandsExpanded}" aria-controls="switcher-band-list">
                <span class="w-5 flex-shrink-0"></span>
                <span class="flex-1 text-sm font-black text-slate-900">Band Archives</span>
                <i data-lucide="chevron-${bandsExpanded ? 'up' : 'down'}" class="w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true"></i>
            </button>
            <div id="switcher-band-list" class="${bandsExpanded ? '' : 'hidden'} bg-slate-50/50">
                ${bands.map(b => row(
                    b.name, 'Band Archive',
                    currentBand === b.name,
                    `window._switchToBand('${b.name.replace(/'/g, "\\'")}')`
                )).join('')}
                ${bands.length === 0 ? '<p class="px-4 py-3 text-xs text-slate-400">No band archives yet.</p>' : ''}
            </div>
        </div>

        <div class="border-t border-slate-100">
            <button onclick="window.signOut()" role="menuitem"
                    class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-red-50 transition-colors group">
                <span class="w-5 flex-shrink-0 flex items-center justify-center">
                    <i data-lucide="log-out" class="w-4 h-4 text-slate-400 group-hover:text-red-500"></i>
                </span>
                <span class="text-sm font-black text-slate-500 group-hover:text-red-600">Sign Out</span>
            </button>
        </div>
    `;

    // Insert panel into body as fixed-position element anchored below the logo
    panel.style.position = 'fixed';
    panel.style.top = '64px'; // height of header — adjust if header height changes
    panel.style.left = '12px';
    panel.classList.remove('absolute', 'top-full');
    document.body.appendChild(panel);

    if (window.lucide) lucide.createIcons();
    return panel;
}

window._toggleBandSection = (btn) => {
    const list = document.getElementById('switcher-band-list');
    if (!list) return;
    const expanding = list.classList.contains('hidden');
    list.classList.toggle('hidden');
    if (btn) {
        btn.setAttribute('aria-expanded', expanding ? 'true' : 'false');
        const chevron = btn.querySelector('[data-lucide^="chevron"]');
        if (chevron) {
            chevron.setAttribute('data-lucide', expanding ? 'chevron-up' : 'chevron-down');
            if (window.lucide) lucide.createIcons();
        }
}
};

window._toggleFollowingSection = (btn) => {
    const list = document.getElementById('switcher-following-list');
    if (!list) return;
    const expanding = list.classList.contains('hidden');
    list.classList.toggle('hidden');
    if (btn) {
        btn.setAttribute('aria-expanded', expanding ? 'true' : 'false');
        const chevron = btn.querySelector('[data-lucide^="chevron"]');
        if (chevron) {
            chevron.setAttribute('data-lucide', expanding ? 'chevron-up' : 'chevron-down');
            if (window.lucide) lucide.createIcons();
        }
    }
};

window._switchToPersonal = () => {
    closeSwitcher();
    window.location.href = 'vault.html';
};

window._switchToBand = (bandName) => {
    closeSwitcher();
    window.location.href = `vault.html?band=${encodeURIComponent(bandName)}`;
};

window.signOut = async function() {
    window.track('sign_out');
    await supabase.auth.signOut();
    window.location.href = 'index.html';
};

// Keep for backward compatibility — settings modal sign out
window.browseBandMode = function() {
    window.closeSettings();
    window.location.href = 'index.html?mode=Band';
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
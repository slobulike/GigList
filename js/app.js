/**
 * Gig List Core Engine
  V3.2.3 - Release Date 2026-03-21
          * -------------------------------------------------------------------
  ✅ Add "Favourite" to band archive
  ✅ Added concert, setlist.fm and weezerpedia links to band modal
  ✅ Fixed admin access to allow edit of photos
*/


import * as Data from './modules/data.js';
import * as Charts from './modules/charts.js';
import * as UI from './modules/ui.js';
import { parseDate } from './modules/utils.js';
import { renderBadges, renderBandBadges } from './modules/achievements.js';
import { renderCalendar } from './modules/calendar.js';
import './modules/quiz.js';
import * as Games from './modules/games.js';
import { GigPuzzle } from './modules/puzzle.js';
import { initEditor, exportCSV } from './modules/editor.js';
import { supabase } from './modules/supabase.js';

let currentUser = null;
let homeCarousel = [];
let currentCarouselIndex = 0;

const APP_VERSION = "3.0.0";

window.toggleListView = UI.toggleListView;
window.activeView = window.activeView || 'list';
window.journalData = window.journalData || [];
window.renderMap = UI.renderMap;
window.currentSort = { column: 'Date', ascending: false };
window.switchGame = Games.switchGame;
window.startNewPuzzle = Games.startNewPuzzle;

export async function initApp() {
    // Check for band param FIRST — authenticated users can browse band archives too
    const params    = new URLSearchParams(window.location.search);
    const bandParam = params.get('band');

    // 1. Check Supabase auth session
    const { data: { session } } = await supabase.auth.getSession();

    if (bandParam) {
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
    window.isBandMode = data.user.Type === 'Band';
    window.currentArtist = data.user.UserName;

    // 2. Apply Band Mode Branding
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

    // Enforce read-only for non-admin band mode visitors
    // Admin check relies on is_admin from profiles table — run SQL:
    //   alter table profiles add column is_admin boolean default false;
    //   update profiles set is_admin = true where username = 'Rich';
    const isReadOnly = window.isBandMode && !currentUser?.is_admin;
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
    initModeSwitcher(); // build the logo dropdown switcher
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
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    // Settings always relates to the authenticated user, not the archive being viewed.
    // Only hide personal sections for unauthenticated band archive visitors.
    const isUnauthenticated = !window.currentUser?.isAuthUser;
    const exportSection  = document.getElementById('settings-export-section');
    const setlistSection = document.getElementById('setlistIdInput')?.closest('.bg-slate-50');

    if (exportSection)  exportSection.classList.toggle('hidden', isUnauthenticated);
    if (setlistSection) setlistSection.classList.toggle('hidden', isUnauthenticated);

    document.getElementById('setlistIdInput')?.focus();
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

window.syncComingSoon = function() {
    const id = document.getElementById('setlistIdInput')?.value;
    alert(id
        ? `Syncing for ${id} coming soon! Using the Python bridge for now.`
        : 'Please enter a Setlist.fm username.'
    );
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
        alert(`Upload failed: ${err.message}`);
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

    // Band section toggle state
    const bandsExpanded = isBand; // start expanded if currently in band mode

    panel.innerHTML = `
        ${row(window.authDisplayName || 'My Gig List',
              'Personal Archive',
              isPersonal,
              isPersonal ? '' : "window._switchToPersonal()")}

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

window._switchToPersonal = () => {
    closeSwitcher();
    window.location.href = 'vault.html';
};

window._switchToBand = (bandName) => {
    closeSwitcher();
    window.location.href = `vault.html?band=${encodeURIComponent(bandName)}`;
};

window.signOut = async function() {
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
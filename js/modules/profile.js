/**
 * GigList — profile.js
 * Handles own profile screen, buddy profile view, avatar upload,
 * music identity editing, and header avatar population.
 *
 * Public API (attached to window):
 *   window.openProfile(userId)       — null = own profile, uuid = buddy's
 *   window.closeProfileView()        — back button for buddy profile view
 *   window.handleAvatarUpload(e)     — file input change handler
 *   window.toggleIdentityEdit()      — toggle edit mode for music identity
 *   window.saveIdentity()            — persist music identity fields
 *   window.toggleHomeLocationEdit()  — toggle edit mode for home location
 *   window.saveHomeLocation()        — geocode postcode via postcodes.io, persist
 *
 * Called from app.js:
 *   initProfile(currentUser)     — populates header avatar, wires privacy toggle
 */

import { supabase } from './supabase.js';
import { renderBadges, renderBadgeStrip, buildBadgeDefs, deriveFanType } from './achievements.js';
import { initPushUI } from './push.js';
import { initTips, syncSeenState, getSeenCount, getTotalCount, TIP_GROUPS, getGroupProgress } from './tips-registry.js';
import { initTipsHub } from './tips-hub.js';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _currentUser   = null;  // own profile, set on initProfile
let _profileUserId = null;  // null = own, uuid = viewing a buddy

// ─── INIT ─────────────────────────────────────────────────────────────────────

/**
 * Called once on app load (personal mode only).
 * Populates the header avatar and sets initial privacy toggle state.
 */
export async function initProfile(currentUser) {
    _currentUser = currentUser;

    // Initialise tips seen state — must run before _renderOwnProfile
        // so getSeenCount() is correct when the strip label renders.
        if (currentUser?.id) {
            initTips(currentUser.id);
            syncSeenState(); // fire-and-forget background Supabase sync
        }

    _populateHeaderAvatar(currentUser);
    _initPrivacyToggle(currentUser);
    _setHomeLocationGlobal(currentUser);
    // renderDashboardCharts may have already run once (e.g. the Stats tab
    // pre-rendering while hidden) before this async initProfile() call
    // resolved, in which case the Averages chart's miles-per-show line
    // would have found window.homeLocation still unset and silently
    // skipped every distance sample. Trigger one refresh now that it's
    // guaranteed to be correct — cheap, and a no-op if nothing changed.
    window.refreshUI?.();
    initPushUI(supabase);
}

// ─── HOME LOCATION ────────────────────────────────────────────────────────────

/**
 * Exposes window.homeLocation for renderAverageMetricsChart's distance calc
 * (charts.js). Runs on every app load, not just when the profile view is
 * opened, since Stats can be viewed without ever visiting the profile page.
 *
 * Uses the saved override (home_lat/home_lng, set via the postcode field
 * below) if present. Otherwise falls back to a guess: the most-visited
 * venue's coordinates, via the same _topValue() helper already used for
 * the favourite-venue default elsewhere in this file.
 */
function _setHomeLocationGlobal(user) {
    if (user?.home_lat != null && user?.home_lng != null) {
        window.homeLocation = { lat: parseFloat(user.home_lat), lng: parseFloat(user.home_lng) };
        return;
    }

    const topVenueName = _topValue(window.journalData || [], 'OfficialVenue');
    const venue = topVenueName ? (window.venuesData || {})[topVenueName] : null;
    const lat = venue ? parseFloat(venue.latitude ?? venue.lat) : NaN;
    const lng = venue ? parseFloat(venue.longitude ?? venue.lng) : NaN;

    window.homeLocation = (!isNaN(lat) && !isNaN(lng)) ? { lat, lng } : null;
}

/** Display text for the home-location settings row — saved label if set,
 *  otherwise names the venue the guess is based on so it's clear it's an
 *  estimate rather than something the user entered. */
function _renderHomeLocationDisplay(profile) {
    const hasOverride = profile.home_lat != null && profile.home_lng != null;
    if (hasOverride) {
        _setText('profile-home-location', profile.home_label || 'Set');
        return;
    }

    const gigs = profile.id === _currentUser?.id ? (window.journalData || []) : null;
    const guessedVenue = gigs ? _topValue(gigs, 'OfficialVenue') : null;
    _setText('profile-home-location', guessedVenue ? `Estimated near ${guessedVenue}` : 'Not set');
}

window.toggleHomeLocationEdit = function() {
    const display = document.getElementById('profile-home-display');
    const edit    = document.getElementById('profile-home-edit');
    const btn     = document.getElementById('profile-home-edit-btn');
    if (!display || !edit) return;

    const isEditing = !edit.classList.contains('hidden');
    if (isEditing) {
        edit.classList.add('hidden');
        display.classList.remove('hidden');
        if (btn) btn.textContent = 'Edit';
    } else {
        edit.classList.remove('hidden');
        display.classList.add('hidden');
        if (btn) btn.textContent = 'Cancel';
        const input = document.getElementById('profile-edit-postcode');
        if (input) {
            input.value = _currentUser?.home_label || '';
            input.focus();
        }
    }
};

window.saveHomeLocation = async function() {
    if (!_currentUser?.id) return;

    const input    = document.getElementById('profile-edit-postcode');
    const postcode = input?.value.trim();
    if (!postcode) return;

    const saveBtn = document.getElementById('profile-home-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Checking…'; }

    // postcodes.io — free, no API key, UK-only (matches this app's audience)
    let result;
    try {
        const res  = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const json = await res.json();
        if (json.status !== 200 || !json.result) throw new Error('not found');
        result = json.result;
    } catch (err) {
        window.showToast("Couldn't find that postcode — please check and try again", 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        return;
    }

    const home_lat   = result.latitude;
    const home_lng   = result.longitude;
    const home_label = result.postcode; // postcodes.io's formatted form, e.g. "SW1A 1AA"

    const { error } = await supabase
        .from('profiles')
        .update({ home_lat, home_lng, home_label })
        .eq('id', _currentUser.id);

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }

    if (error) {
        window.showToast('Could not save — please try again', 'error');
        return;
    }

    _currentUser.home_lat   = home_lat;
    _currentUser.home_lng   = home_lng;
    _currentUser.home_label = home_label;
    if (window.currentUser) {
        window.currentUser.home_lat   = home_lat;
        window.currentUser.home_lng   = home_lng;
        window.currentUser.home_label = home_label;
    }
    window.homeLocation = { lat: parseFloat(home_lat), lng: parseFloat(home_lng) };

    _renderHomeLocationDisplay(_currentUser);
    window.toggleHomeLocationEdit();
    window.showToast('Home location saved', 'success');
};


// ─── HEADER AVATAR ────────────────────────────────────────────────────────────

function _populateHeaderAvatar(user) {
    const wrap     = document.getElementById('userIdentity-avatar');
    const signinEl = document.getElementById('userIdentity-signin');
    const imgEl    = document.getElementById('userIdentity-avatar-img');
    const initialsEl = document.getElementById('userIdentity-avatar-initials');
    const identityEl = document.getElementById('userIdentity');

    if (!wrap) return;

    if (!user?.isAuthUser) {
        // Signed-out: show text pill, wire to sign-in page
        signinEl?.classList.remove('hidden');
        wrap.classList.add('hidden');
        if (identityEl) {
            identityEl.onclick = () => window.location.href = 'index.html';
        }
        return;
    }

    // Signed-in: show avatar circle
    signinEl?.classList.add('hidden');
    wrap.classList.remove('hidden');

    if (identityEl) {
        identityEl.onclick = () => window.openProfile(null);
        identityEl.setAttribute('aria-label', 'Open your profile');
        identityEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') window.openProfile(null); };
    }

    _setAvatarCircle(
        imgEl,
        initialsEl,
        wrap,
        user.avatar_url,
        user.display_name || user.username || user.UserName
    );
}

/**
 * Shared helper — sets either an image or initials on any avatar circle.
 * @param {HTMLImageElement} imgEl
 * @param {HTMLElement} initialsEl
 * @param {HTMLElement} wrapEl       — the coloured circle container
 * @param {string|null} avatarUrl
 * @param {string} name
 */
function _setAvatarCircle(imgEl, initialsEl, wrapEl, avatarUrl, name) {
    if (avatarUrl) {
        if (imgEl) {
            imgEl.src = avatarUrl;
            imgEl.alt = name || '';
            imgEl.classList.remove('hidden');
        }
        if (initialsEl) initialsEl.classList.add('hidden');
    } else {
        if (imgEl) imgEl.classList.add('hidden');
        if (initialsEl) {
            initialsEl.classList.remove('hidden');
            initialsEl.textContent = _initials(name);
        }
        // Apply stable colour based on name
        if (wrapEl) {
            wrapEl.style.backgroundColor = _stableColour(name);
        }
    }
}

// ─── OPEN / CLOSE PROFILE VIEW ────────────────────────────────────────────────

window.openProfile = async function(userId) {
    _profileUserId = userId;  // null = own profile

    // Switch to profile view without touching nav active state
    document.querySelectorAll('.view-section').forEach(s => {
        s.classList.add('hidden');
        s.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active', 'text-indigo-600');
        n.classList.add('text-slate-400');
        n.setAttribute('aria-current', 'false');
    });

    const section = document.getElementById('view-profile');
    if (section) {
        section.classList.remove('hidden');
        section.setAttribute('aria-hidden', 'false');
    }

    window.scrollTo(0, 0);

    if (!userId || userId === _currentUser?.id) {
        await _renderOwnProfile();
    } else {
        await _renderBuddyProfile(userId);
    }

    if (window.lucide) lucide.createIcons();
};

window.closeProfileView = function() {
    // Return to own profile (Buddies content now lives inside view-profile,
    // so switching to 'buddies' would show an empty shell)
    _profileUserId = null;
    window.openProfile(null);
};

// ─── OWN PROFILE ─────────────────────────────────────────────────────────────

async function _renderOwnProfile() {
    const user = _currentUser;

    // Back button — hidden for own profile
    const backBtn = document.getElementById('profile-back-btn');
    if (backBtn) backBtn.classList.add('hidden');

    // Tips Hub strip — visible for own profile; drawer starts hidden
        document.getElementById('profile-tips-hub-strip')?.classList.remove('hidden');
            document.getElementById('view-profile-tips-hub')?.classList.add('hidden');

    // Avatar edit button — visible for own profile
    document.getElementById('profile-avatar-edit-btn')?.classList.remove('hidden');

    // Settings section — visible for own profile
    document.getElementById('profile-settings-section')?.classList.remove('hidden');

    // Buddies section — visible for own profile
    document.getElementById('profile-buddies-section')?.classList.remove('hidden');

    // Buddy strip — visible for own profile (full list stays hidden until opened)
    document.getElementById('profile-buddy-strip')?.closest('.bg-white')?.classList.remove('hidden');
    document.getElementById('view-profile-buddies')?.classList.add('hidden');

    // Achievement strip — visible for own profile (full list stays hidden until opened)
    document.getElementById('profile-badge-strip')?.closest('.bg-white')?.classList.remove('hidden');
    document.getElementById('view-profile-achievements')?.classList.add('hidden');

    // Shared callout — hidden for own profile
    const callout = document.getElementById('profile-shared-callout');
    if (callout) callout.classList.add('hidden');

    // Music identity edit button — visible for own profile
    document.getElementById('profile-identity-edit-btn')?.classList.remove('hidden');

    // Home location edit button — visible for own profile
    document.getElementById('profile-home-edit-btn')?.classList.remove('hidden');

    // ── Header ──
    _setText('profile-display-name', user.display_name || user.username || '—');
    _setText('profile-username', '@' + (user.username || '—'));
    _setText('profile-member-since', '');

    // Profile avatar (large)
    _setAvatarCircle(
        document.getElementById('profile-avatar-img'),
        document.getElementById('profile-avatar-initials'),
        document.getElementById('profile-avatar-wrap'),
        user.avatar_url,
        user.display_name || user.username
    );

    // ── Music identity ──
    _renderIdentityDisplay(user);

    // ── Home location ──
    _renderHomeLocationDisplay(user);

    // Pre-fill identity edit inputs with saved values
    const editBand  = document.getElementById('profile-edit-band');
    const editVenue = document.getElementById('profile-edit-venue');
    if (editBand)  editBand.value  = user.favourite_band  || '';
    if (editVenue) editVenue.value = user.favourite_venue || '';
    const editSong = document.getElementById('profile-edit-song');
    if (editSong)  editSong.value  = user.favourite_song  || '';

    // Favourite show — look up the journal key to get a human-readable label
    const editShow = document.getElementById('profile-edit-show');
    if (editShow && user.favourite_show_key) {
        const match = (window.journalData || []).find(g => g['Journal Key'] === user.favourite_show_key);
        editShow.value = match ? `${match.Band} – ${match.OfficialVenue} (${match.Date})` : user.favourite_show_key;
    }

    _wireShowSearch();

    // ── Stats ──
    _renderStats(window.journalData || []);

    // ── Privacy toggle initial state ──
    _setPrivacyToggleState(user.is_public);
    await initPushUI(supabase);

    // ── Achievements ──
    _renderAchievements(window.journalData || []);

    // ── Buddy strip ──
        renderBuddyStrip(window._following || []);

// ── Tips Hub strip label ──
    _updateTipsStripLabel();

    _renderMusicIdentityPrompt();

    // ── Achievement close nudge ──
    _checkAchievementCloseNudge(window.journalData || []);
}

// ─── MUSIC IDENTITY PROMPT ───────────────────────────────────────────────────

function _renderMusicIdentityPrompt() {
    const promptContainer = document.getElementById('music-identity-prompt');
    if (!promptContainer) return;

    const p = _currentUser;
    const hasIdentity = p?.favourite_band || p?.favourite_venue || p?.favourite_song || p?.favourite_show_key;

    if (hasIdentity) {
        promptContainer.innerHTML = '';
        return;
    }

    promptContainer.innerHTML = `
        <div class="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-3">
            <p class="text-sm font-bold text-indigo-900 mb-1">Your music identity is blank</p>
            <p class="text-xs text-indigo-600 mb-3">Tell us what shaped you. It takes 30 seconds.</p>
            <button onclick="window.toggleIdentityEdit()"
                    class="text-[11px] font-black text-indigo-600 flex items-center gap-1 hover:opacity-70 transition-opacity">
                Fill it in
                <i data-lucide="arrow-right" class="w-3 h-3" aria-hidden="true"></i>
            </button>
        </div>`;
    if (window.lucide) lucide.createIcons({ scope: promptContainer });
}

// ─── ACHIEVEMENT CLOSE NUDGE ─────────────────────────────────────────────────

function _checkAchievementCloseNudge(gigs) {
    try {
        const { groups } = buildBadgeDefs(gigs);
        const isClose = Object.values(groups).some(badgeGroup =>
            badgeGroup.some(b => !b.earned && b.goal && b.current > 0 && (b.goal - b.current) <= 5)
        );
        if (isClose && window.checkNudgeTrigger) {
            window.checkNudgeTrigger('achievement_close');
        }
    } catch (e) {
        // Non-fatal — nudge is best-effort
    }
}

// ─── BUDDY PROFILE (read-only) ────────────────────────────────────────────────

async function _renderBuddyProfile(userId) {
    // Back button — shown for buddy profiles
    const backBtn = document.getElementById('profile-back-btn');
    if (backBtn) {
        backBtn.classList.remove('hidden');
        backBtn.classList.add('flex');
    }
    // Tips Hub — hidden for buddy profile
        document.getElementById('profile-tips-hub-strip')?.classList.add('hidden');
        document.getElementById('view-profile-tips-hub')?.classList.add('hidden');


    // Avatar edit button — hidden for buddy profile
    document.getElementById('profile-avatar-edit-btn')?.classList.add('hidden');

    // Settings section — hidden for buddy profile
    document.getElementById('profile-settings-section')?.classList.add('hidden');

    // Buddies section (Find Buddies search + own tile list) — hidden for buddy profile
    document.getElementById('profile-buddies-section')?.classList.add('hidden');

    // Buddy strip + full buddy list — hidden for buddy profile
    document.getElementById('profile-buddy-strip')?.closest('.bg-white')?.classList.add('hidden');
    document.getElementById('view-profile-buddies')?.classList.add('hidden');

    // Achievement strip + full achievements — hidden for buddy profile
    document.getElementById('profile-badge-strip')?.closest('.bg-white')?.classList.add('hidden');
    document.getElementById('view-profile-achievements')?.classList.add('hidden');

    // Music identity edit button — hidden for buddy profile
    document.getElementById('profile-identity-edit-btn')?.classList.add('hidden');
    // Ensure edit mode is closed
    document.getElementById('profile-identity-edit')?.classList.add('hidden');
    document.getElementById('profile-identity-display')?.classList.remove('hidden');

    // Home location edit button — hidden for buddy profile, same treatment
    document.getElementById('profile-home-edit-btn')?.classList.add('hidden');
    document.getElementById('profile-home-edit')?.classList.add('hidden');
    document.getElementById('profile-home-display')?.classList.remove('hidden');

    // ── Fetch buddy's profile ──
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, is_public, favourite_band, favourite_venue, favourite_song, favourite_show_key, home_lat, home_lng, home_label')
        .eq('id', userId)
        .single();

    if (error || !profile) {
        window.showToast('Could not load profile', 'error');
        window.closeProfileView();
        return;
    }

    // ── Header ──
    _setText('profile-display-name', profile.display_name || profile.username || '—');
    _setText('profile-username', '@' + (profile.username || '—'));
    _setText('profile-member-since', '');

    _setAvatarCircle(
        document.getElementById('profile-avatar-img'),
        document.getElementById('profile-avatar-initials'),
        document.getElementById('profile-avatar-wrap'),
        profile.avatar_url,
        profile.display_name || profile.username
    );

    // ── Shared shows callout ──
    const callout = document.getElementById('profile-shared-callout');
    const ownKeys = new Set((window.journalData || []).map(g => g['Journal Key']));
    const buddyKeySet = window._buddyJournalKeys?.get?.(userId);
    const sharedCount = buddyKeySet ? [...buddyKeySet].filter(k => ownKeys.has(k)).length : null;
    if (callout) {
        if (sharedCount !== null && sharedCount > 0) {
            callout.textContent = `You've been to ${sharedCount} show${sharedCount !== 1 ? 's' : ''} together`;
            callout.classList.remove('hidden');
        } else {
            callout.classList.add('hidden');
        }
    }

    // ── Music identity ──
    _renderIdentityDisplay(profile);

    // ── Home location ──
    _renderHomeLocationDisplay(profile);

    // ── Stats — fetch buddy's journal (two-step, safe pattern) ──
    let buddyData = [];
    const { data: buddyIds } = await supabase
        .from('journals')
        .select('id')
        .eq('user_id', userId);

    if (buddyIds?.length) {
        const ids = buddyIds.map(r => r.id);
        const { data: rows } = await supabase
            .from('journals')
            .select('date, band, official_venue, festival')
            .in('id', ids);
        buddyData = rows || [];
    }

    _renderStats(buddyData);

    // ── Achievements — hidden for buddy profiles for now ──
    const achSection = document.getElementById('profile-achievements-section');
    if (achSection) achSection.classList.add('hidden');
}

// ─── MUSIC IDENTITY ──────────────────────────────────────────────────────────

function _renderIdentityDisplay(profile) {
    const gigs = profile.id === _currentUser?.id ? (window.journalData || []) : null;

    // Compute defaults from journal data if available and no saved value
    const defaultBand  = gigs ? _topValue(gigs, 'Band') : null;
    const defaultVenue = gigs ? _topValue(gigs, 'OfficialVenue') : null;

    const band  = profile.favourite_band  || defaultBand  || '—';
    const venue = profile.favourite_venue || defaultVenue || '—';
    const song  = profile.favourite_song  || '—';

    _setText('profile-fav-band',  band);
    _setText('profile-fav-venue', venue);
    _setText('profile-fav-song',  song);

    if (profile.favourite_show_key) {
        const match = (window.journalData || []).find(g => g['Journal Key'] === profile.favourite_show_key);
        _setText('profile-fav-show', match
            ? `${match.Band} – ${match.OfficialVenue} (${match.Date})`
            : profile.favourite_show_key
        );
    } else {
        _setText('profile-fav-show', '—');
    }
}

window.toggleIdentityEdit = function() {
    const display = document.getElementById('profile-identity-display');
    const edit    = document.getElementById('profile-identity-edit');
    const btn     = document.getElementById('profile-identity-edit-btn');
    if (!display || !edit) return;

    const isEditing = !edit.classList.contains('hidden');
    if (isEditing) {
        edit.classList.add('hidden');
        display.classList.remove('hidden');
        if (btn) btn.textContent = 'Edit';
    } else {
        edit.classList.remove('hidden');
        display.classList.add('hidden');
        if (btn) btn.textContent = 'Cancel';
        document.getElementById('profile-edit-band')?.focus();
    }
};

window.saveIdentity = async function() {
    if (!_currentUser?.id) return;

    const band     = document.getElementById('profile-edit-band')?.value.trim() || null;
    const venue    = document.getElementById('profile-edit-venue')?.value.trim() || null;
    const song     = document.getElementById('profile-edit-song')?.value.trim() || null;
    const showKey  = document.getElementById('profile-edit-show')?._selectedKey || null;

    const { error } = await supabase
        .from('profiles')
        .update({
            favourite_band:       band,
            favourite_venue:      venue,
            favourite_song:       song,
            favourite_show_key:   showKey,
        })
        .eq('id', _currentUser.id);

    if (error) {
        window.showToast('Could not save — please try again', 'error');
        return;
    }

    // Update local user object
    _currentUser.favourite_band      = band;
    _currentUser.favourite_venue     = venue;
    _currentUser.favourite_song      = song;
    _currentUser.favourite_show_key  = showKey;
    if (window.currentUser) {
        window.currentUser.favourite_band     = band;
        window.currentUser.favourite_venue    = venue;
        window.currentUser.favourite_song     = song;
        window.currentUser.favourite_show_key = showKey;
    }

    _renderIdentityDisplay(_currentUser);
    window.toggleIdentityEdit();
    window.showToast('Music identity saved', 'success');
};

/**
 * Wire the favourite show typeahead against window.journalData.
 * Stores the selected journal_key on the input element as _selectedKey.
 */
function _wireShowSearch() {
    const input    = document.getElementById('profile-edit-show');
    const listbox  = document.getElementById('profile-edit-show-list');
    if (!input || !listbox) return;
    if (input._showSearchWired) return;
    input._showSearchWired = true;

    // Initialise _selectedKey from current saved value
    if (_currentUser?.favourite_show_key && !input._selectedKey) {
        input._selectedKey = _currentUser.favourite_show_key;
    }

    input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        if (!q) { listbox.classList.add('hidden'); return; }

        const matches = (window.journalData || [])
            .filter(g => g.Band?.toLowerCase().includes(q) || g.OfficialVenue?.toLowerCase().includes(q))
            .slice(0, 8);

        listbox.innerHTML = matches.map(g =>
            `<li role="option"
                 data-key="${g['Journal Key']}"
                 class="px-4 py-3 text-sm font-bold text-slate-800 hover:bg-indigo-50 cursor-pointer">
                ${g.Band} <span class="font-normal text-slate-400">– ${g.OfficialVenue} (${g.Date})</span>
             </li>`
        ).join('');

        listbox.classList.toggle('hidden', matches.length === 0);

        listbox.querySelectorAll('li').forEach(li => {
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = li.textContent.trim().replace(/\s+/g, ' ');
                input._selectedKey = li.dataset.key;
                listbox.classList.add('hidden');
            });
        });
    });

    input.addEventListener('blur', () => {
        setTimeout(() => listbox.classList.add('hidden'), 150);
    });
}

// ─── STATS ────────────────────────────────────────────────────────────────────

function _renderStats(gigs) {
    const total   = gigs.length;
    const venues  = new Set(gigs.map(g => g.official_venue || g.OfficialVenue).filter(Boolean)).size;
    const dates   = gigs.map(g => g.date || g.Date).filter(Boolean);
    const years   = new Set(dates.map(d => d.split('/')[2])).size;
    const firstShow = dates.length
        ? dates.reduce((earliest, d) => {
            const [dd, mm, yyyy] = d.split('/');
            const ts = new Date(`${yyyy}-${mm}-${dd}`);
            return (!earliest || ts < earliest.ts) ? { ts, label: d } : earliest;
          }, null)?.label || '—'
        : '—';

    _setText('profile-stat-gigs',       String(total));
    _setText('profile-stat-venues',     String(venues));
    _setText('profile-stat-years',      String(years));
    _setText('profile-stat-first-show', firstShow);
}
// ─── ACHIEVEMENTS ─────────────────────────────────────────────────────────────

function _renderAchievements(gigs) {
    const section = document.getElementById('profile-achievements-section');
    if (!section) return;
    section.classList.remove('hidden');
    renderBadges(gigs);
    renderBadgeStrip(gigs);
    _renderFanType(gigs);
}

// ─── BUDDY STRIP ──────────────────────────────────────────────────────────────

export function renderBuddyStrip(buddies) {
    const stripContainer = document.getElementById('profile-buddy-strip');
    const listContainer  = document.getElementById('profile-buddy-list');
    if (!stripContainer && !listContainer) return;

    if (!buddies?.length) {
        if (stripContainer) stripContainer.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Gig Buddies</span>
            </div>
            <p class="text-xs text-slate-400 italic">No gig buddies yet — search above to find friends.</p>`;
        return;
    }

    // Sort by shared gigs descending, then alphabetically
    const sorted = [...buddies].sort((a, b) => {
        const diff = (b.sharedGigs ?? 0) - (a.sharedGigs ?? 0);
        if (diff !== 0) return diff;
        return (a.display_name || a.username).localeCompare(b.display_name || b.username);
    });

    const totalBuddies = sorted.length;

    // ── Strip (compact preview — top 4 + find slot, matching achievements strip) ─
    if (stripContainer) {
        const preview = sorted.slice(0, 5);
        const showFindSlot = sorted.length < 5;

        const chips = preview.map(f => {
            const shared   = f.sharedGigs ?? 0;
            const name     = f.display_name || f.username;
            const safeName = name.replace(/'/g, "\\'");
            const avatarHtml = f.avatar_url
                ? `<img src="${f.avatar_url}" alt="${name}" class="w-12 h-12 rounded-full object-cover">`
                : `<div class="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-black"
                        style="background:${_stableColour(name)}">${_initials(name)}</div>`;
            return `
            <button onclick="window.openBuddyDrillIn('${f.id}', '${safeName}')"
                    class="flex flex-col items-center gap-1.5 hover:opacity-80 transition-opacity">
                ${avatarHtml}
                <span class="text-[8px] font-black text-slate-500 text-center leading-tight truncate">${name}</span>
                ${shared > 0
                    ? `<span class="text-[8px] font-black text-indigo-500">${shared} shared</span>`
                    : `<span class="text-[8px] text-slate-300 font-bold">no shows yet</span>`}
            </button>`;
        }).join('');

        const findSlot = showFindSlot ? `
            <button onclick="document.getElementById('friend-search-input')?.scrollIntoView({behavior:'smooth'});document.getElementById('friend-search-input')?.focus();"
                    class="flex flex-col items-center gap-1.5 hover:opacity-80 transition-opacity">
                <div class="w-12 h-12 rounded-full flex items-center justify-center border-2 border-dashed border-slate-200 bg-slate-50">
                    <i data-lucide="plus" class="w-5 h-5 text-slate-300"></i>
                </div>
                <span class="text-[8px] font-black text-slate-300 text-center leading-tight">Find</span>
                <span class="text-[8px] text-transparent select-none">·</span>
            </button>` : '';

        stripContainer.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Gig Buddies</span>
                <button onclick="window.openBuddyList()"
                        class="text-[10px] font-black text-indigo-500 uppercase tracking-widest hover:text-indigo-700 transition-colors">
                    ${totalBuddies} ${totalBuddies === 1 ? 'buddy' : 'buddies'} · View all ›
                </button>
            </div>
            <div class="grid grid-cols-5 gap-2">
                            ${chips}${findSlot}
                        </div>`;

        if (window.lucide) lucide.createIcons();
    }
    // ── Full list ─────────────────────────────────────────────────────────────
    if (listContainer) {
        listContainer.innerHTML = sorted.map(f => {
            const shared    = f.sharedGigs ?? 0;
            const last      = f.lastSharedShow ?? null;
            const lastDate  = f.lastSharedDate ?? null;
            const name      = f.display_name || f.username;
            const safeName  = name.replace(/'/g, "\\'");
            const totalGigs = f.totalGigs ?? '—';
            const avatarHtml = f.avatar_url
                ? `<img src="${f.avatar_url}" alt="${name}" class="w-11 h-11 rounded-full object-cover">`
                : `<div class="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-black"
                        style="background:${_stableColour(name)}">${_initials(name)}</div>`;

            return `
            <div class="flex items-center gap-3 pb-6 mb-6 border-b border-slate-100 last:border-0 last:mb-0 last:pb-0">
                <!-- Avatar → profile screen -->
                <button onclick="window.openProfile('${f.id}')"
                        class="flex-shrink-0 rounded-full overflow-hidden hover:ring-2 hover:ring-indigo-400 hover:ring-offset-1 transition-all active:scale-95"
                        aria-label="View ${name}'s profile">
                    ${avatarHtml}
                </button>
                <!-- Rest of row → buddy drill-in -->
                <button onclick="window.openBuddyDrillIn('${f.id}', '${safeName}')"
                        class="flex-1 min-w-0 flex items-center gap-2 text-left hover:opacity-80 transition-opacity active:scale-[0.99]"
                        aria-label="View ${name}'s shows">
                    <div class="flex-1 min-w-0">
                        <span class="text-sm font-black text-slate-800">${name}</span>
                        <div class="flex gap-2 mt-1.5">
                            <span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">${totalGigs} gigs</span>
                            ${shared > 0
                                ? `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">${shared} together</span>`
                                : `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-50 text-slate-300">no shows yet</span>`}
                        </div>
                        ${last
                            ? (() => {
                                const isUpcoming = lastDate
                                    ? (() => { const [dd,mm,yy] = lastDate.split('/'); return new Date(`${yy}-${mm}-${dd}`) >= new Date(); })()
                                    : false;
                                const label = isUpcoming ? 'Next together:' : 'Last together:';
                                return `<p class="text-[9px] text-slate-400 italic mt-1 truncate">${label} ${last}</p>`;
                              })()
                            : `<p class="text-[9px] text-slate-300 italic mt-1">Plan your first show together →</p>`}
                    </div>
                    <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 flex-shrink-0"></i>
                </button>
            </div>`;
        }).join('');

        if (window.lucide) lucide.createIcons();
    }
}

// wire up the drill-in:
window.openAchievements = () => {
    document.getElementById('profile-badge-strip')?.closest('.bg-white')?.classList.add('hidden');
    document.getElementById('view-profile-achievements')?.classList.remove('hidden');
};

window.closeAchievements = () => {
    document.getElementById('view-profile-achievements')?.classList.add('hidden');
    document.getElementById('profile-badge-strip')?.closest('.bg-white')?.classList.remove('hidden');
};

// ── Tips Hub ──────────────────────────────────────────────────

const TIP_GROUP_ICONS = {
    your_shows:   'mic',
    your_history: 'bar-chart-2',
    your_feed:    'sparkles',
    achievements: 'trophy',
    buddies:      'users',
    collection:   'disc',
    band_pages:   'search',
};

const TIP_GROUP_SHORT_LABELS = {
    your_shows:   'Shows',
    your_history: 'History',
    your_feed:    'Feed',
    achievements: 'Badges',
    buddies:      'Buddies',
    collection:   'Collection',
    band_pages:   'Band Pages',
};

function _updateTipsStripLabel() {
    const seen  = getSeenCount();
    const total = getTotalCount();

    const progressEl = document.getElementById('tips-hub-strip-progress');
    if (progressEl) progressEl.textContent = `${seen} of ${total} features discovered`;

    const countEl = document.getElementById('tips-hub-strip-count');
    if (countEl) countEl.textContent = `${seen}/${total} ·`;

    const circlesEl = document.getElementById('tips-hub-strip-circles');
    if (!circlesEl) return;

    const progress = getGroupProgress();

    circlesEl.innerHTML = TIP_GROUPS.map(group => {
        const gp       = progress[group.id] ?? { total: 0, seen: 0 };
        const complete = gp.total > 0 && gp.seen === gp.total;
        const icon     = TIP_GROUP_ICONS[group.id] ?? 'star';
        const label    = TIP_GROUP_SHORT_LABELS[group.id] ?? group.label;

        const ringClass  = complete ? 'border-2 border-amber-400 bg-white' : 'border-2 border-slate-200 bg-white';
        const iconClass  = complete ? 'text-indigo-500' : 'text-slate-300';
        const labelClass = complete ? 'text-slate-600'  : 'text-slate-300';

        return `
                    <div class="flex flex-col items-center gap-1.5 cursor-pointer flex-shrink-0"
                         onclick="window.openTipsHub()"
                         role="button"
                         aria-label="${label}: ${gp.seen} of ${gp.total} tips discovered">
                      <div class="w-14 h-14 rounded-full flex items-center justify-center ${ringClass}">
                        <i data-lucide="${icon}" class="w-6 h-6 ${iconClass}"></i>
                      </div>
                      <span class="text-[10px] font-medium text-center leading-tight ${labelClass}"
                            style="max-width:52px">${label}</span>
                    </div>`;
    }).join('');

    if (window.lucide) lucide.createIcons({ scope: circlesEl });
}

window.openTipsHub = () => {
    document.getElementById('profile-tips-hub-strip')?.classList.add('hidden');

    const drawer = document.getElementById('view-profile-tips-hub');
    drawer?.classList.remove('hidden');

    const container = document.getElementById('tips-hub-container');
    if (container) {
        initTipsHub(container, {
            accountCreatedAt: _currentUser?.created_at || null,
            hideHeader: true,
            onCtaNavigate: (url) => {
                window.closeTipsHub();
                setTimeout(() => _navigateTipLink(url), 80);
            },
        });
    }

    if (window.lucide) lucide.createIcons();
};

window.closeTipsHub = () => {
    document.getElementById('view-profile-tips-hub')?.classList.add('hidden');
    document.getElementById('profile-tips-hub-strip')?.classList.remove('hidden');
    _updateTipsStripLabel();
};

/**
 * Translate a hubDeepLink value into the correct in-app navigation call.
 * Handles vault.html#data, vault.html#feed, vault.html#collection, vault.html (home),
 * vault.html#profile — all without a full page reload.
 */
function _navigateTipLink(url) {
    if (!url) return;
    // Strip leading path so we only look at the hash/fragment
    const hash = url.includes('#') ? url.split('#')[1] : null;
    switch (hash) {
        case 'data':       window.switchView('data');       break;
        case 'feed':       window.switchView('feed');       break;
        case 'collection': window.switchView('collection'); break;
        case 'profile':    window.switchView('profile');    break;
        case 'social':     window.switchView('social');     break;
        default:
            // vault.html with no hash → home tab
            window.switchView('home');
            break;
    }
}

window.openBuddyList = () => {
    document.getElementById('profile-buddy-strip')?.closest('.bg-white')?.classList.add('hidden');
    document.getElementById('view-profile-buddies')?.classList.remove('hidden');
};

window.closeBuddyList = () => {
    document.getElementById('view-profile-buddies')?.classList.add('hidden');
    document.getElementById('profile-buddy-strip')?.closest('.bg-white')?.classList.remove('hidden');
};

function _renderFanType(gigs) {
    const el = document.getElementById('profile-fan-type');
    if (!el) return;

    const { groups, statsData } = buildBadgeDefs(gigs);
    const fanType = deriveFanType(groups, statsData);

    if (!fanType) {
        el.classList.add('hidden');
        return;
    }

    el.classList.remove('hidden');
    el.innerHTML = `
        <i data-lucide="${fanType.icon}" class="w-3.5 h-3.5 text-indigo-500 flex-shrink-0 mt-0.5" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
                <span class="text-sm font-black text-slate-900">${fanType.label}</span>
                <button onclick="this.nextElementSibling.classList.toggle('hidden')"
                        class="text-[9px] font-black text-indigo-400 hover:text-indigo-600 uppercase tracking-widest transition-colors">
                    why?
                </button>
                <span class="hidden text-[10px] text-slate-500 font-bold italic">${fanType.desc}</span>
            </div>
        </div>`;
    if (window.lucide) lucide.createIcons();
}

// ─── AVATAR UPLOAD ────────────────────────────────────────────────────────────

window.handleAvatarUpload = async function(event) {
    const file = event.target.files?.[0];
    if (!file || !_currentUser?.id) return;

    const editBtn = document.getElementById('profile-avatar-edit-btn');
    if (editBtn) editBtn.innerHTML = `<svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

    try {
        const compressed = await _compressAvatar(file, 400);
        const path = `${_currentUser.id}/avatar.jpg`;

        const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(path, compressed, { contentType: 'image/jpeg', upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
        // Bust cache with timestamp
        const avatarUrl = urlData.publicUrl + '?t=' + Date.now();

        const { error: dbError } = await supabase
            .from('profiles')
            .update({ avatar_url: avatarUrl })
            .eq('id', _currentUser.id);

        if (dbError) throw dbError;

        // Update local state
        _currentUser.avatar_url = avatarUrl;
        if (window.currentUser) window.currentUser.avatar_url = avatarUrl;

        // Refresh profile large avatar
        _setAvatarCircle(
            document.getElementById('profile-avatar-img'),
            document.getElementById('profile-avatar-initials'),
            document.getElementById('profile-avatar-wrap'),
            avatarUrl,
            _currentUser.display_name || _currentUser.username
        );

        // Refresh header avatar
        _setAvatarCircle(
            document.getElementById('userIdentity-avatar-img'),
            document.getElementById('userIdentity-avatar-initials'),
            document.getElementById('userIdentity-avatar'),
            avatarUrl,
            _currentUser.display_name || _currentUser.username
        );

        window.showToast('Avatar updated', 'success');

    } catch (err) {
        console.error('Avatar upload failed:', err);
        window.showToast('Upload failed — please try again', 'error');
    } finally {
        if (editBtn) {
            editBtn.innerHTML = `<i data-lucide="camera" class="w-3.5 h-3.5" aria-hidden="true"></i>`;
            if (window.lucide) lucide.createIcons();
        }
        event.target.value = '';
    }
};

async function _compressAvatar(file, maxDimension) {
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
            canvas.toBlob(resolve, 'image/jpeg', 0.85);
        };
        img.src = url;
    });
}

// ─── PRIVACY TOGGLE ──────────────────────────────────────────────────────────

function _initPrivacyToggle(user) {
    _setPrivacyToggleState(user?.is_public || false);
}

function _setPrivacyToggleState(isPublic) {
    const toggle = document.getElementById('privacy-toggle');
    const knob   = document.getElementById('privacy-knob');
    if (!toggle || !knob) return;

    toggle.setAttribute('aria-checked', String(!!isPublic));
    toggle.classList.toggle('bg-indigo-600', !!isPublic);
    toggle.classList.toggle('bg-slate-200',  !isPublic);
    knob.style.transform = isPublic ? 'translateX(1.5rem)' : 'translateX(0)';
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _memberSince(createdAt) {
    if (!createdAt) return '';
    const d = new Date(createdAt);
    return 'Member since ' + d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Returns initials (up to 2 chars) from a display name */
function _initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable colour from a string — matches the hash used in buddies.js */
function _stableColour(str) {
    const palette = [
        '#6366f1','#8b5cf6','#ec4899','#f59e0b',
        '#10b981','#3b82f6','#ef4444','#14b8a6',
    ];
    if (!str) return palette[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
}

/** Returns the most frequent value for a given field in a gigs array */
function _topValue(gigs, field) {
    const counts = {};
    for (const g of gigs) {
        const v = g[field];
        if (v) counts[v] = (counts[v] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
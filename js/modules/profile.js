/**
 * GigList — profile.js
 * Handles own profile screen, buddy profile view, avatar upload,
 * music identity editing, and header avatar population.
 *
 * Public API (attached to window):
 *   window.openProfile(userId)   — null = own profile, uuid = buddy's
 *   window.closeProfileView()    — back button for buddy profile view
 *   window.handleAvatarUpload(e) — file input change handler
 *   window.toggleIdentityEdit()  — toggle edit mode for music identity
 *   window.saveIdentity()        — persist music identity fields
 *
 * Called from app.js:
 *   initProfile(currentUser)     — populates header avatar, wires privacy toggle
 */

import { supabase } from './supabase.js';
import { renderBadges, renderBadgeStrip, buildBadgeDefs, deriveFanType } from './achievements.js';
import { initPushUI } from './push.js';

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
    _populateHeaderAvatar(currentUser);
    _initPrivacyToggle(currentUser);
    // initPushUI involves serviceWorker.ready + a Supabase query — fire without
    // awaiting so it doesn't block initProfile returning or the Promise.all in app.js
    initPushUI(supabase);
}

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

    // Avatar edit button — visible for own profile
    document.getElementById('profile-avatar-edit-btn')?.classList.remove('hidden');

    // Settings section — visible for own profile
    document.getElementById('profile-settings-section')?.classList.remove('hidden');

    // Buddies section — visible for own profile
    document.getElementById('profile-buddies-section')?.classList.remove('hidden');

    // Shared callout — hidden for own profile
    const callout = document.getElementById('profile-shared-callout');
    if (callout) callout.classList.add('hidden');

    // Music identity edit button — visible for own profile
    document.getElementById('profile-identity-edit-btn')?.classList.remove('hidden');

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
}

// ─── BUDDY PROFILE (read-only) ────────────────────────────────────────────────

async function _renderBuddyProfile(userId) {
    // Back button — shown for buddy profiles
    const backBtn = document.getElementById('profile-back-btn');
    if (backBtn) {
        backBtn.classList.remove('hidden');
        backBtn.classList.add('flex');
    }

    // Avatar edit button — hidden for buddy profile
    document.getElementById('profile-avatar-edit-btn')?.classList.add('hidden');

    // Settings section — hidden for buddy profile
    document.getElementById('profile-settings-section')?.classList.add('hidden');

    // Buddies section (Find Buddies search + own tile list) — hidden for buddy profile
    document.getElementById('profile-buddies-section')?.classList.add('hidden');

    // Music identity edit button — hidden for buddy profile
    document.getElementById('profile-identity-edit-btn')?.classList.add('hidden');
    // Ensure edit mode is closed
    document.getElementById('profile-identity-edit')?.classList.add('hidden');
    document.getElementById('profile-identity-display')?.classList.remove('hidden');

    // ── Fetch buddy's profile ──
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, is_public, favourite_band, favourite_venue, favourite_song, favourite_show_key')
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

// ─── ACHIEVEMENTS ─────────────────────────────────────────────────────────────

function _renderAchievements(gigs) {
    const section = document.getElementById('profile-achievements-section');
    if (!section) return;
    section.classList.remove('hidden');
    renderBadges(gigs);          // full page
    renderBadgeStrip(gigs);      // profile strip
    _renderFanType(gigs);        // fan type row (remove from identity section)
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
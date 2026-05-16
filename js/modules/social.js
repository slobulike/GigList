/**
 * GigList — Social Module
 * v1.0.0 — 2026-04-19
 * -------------------------------------------------------------------
 * Gig buddy relationships, discovery, and attendee features.
 * Extracted from app.js. Uses the symmetric `buddies` table.
 *
 * Exports:
 *   initSocial(currentUser)      — call after auth, before switcher
 *   rebuildSwitcherPanel()       — call after buddy state changes
 */

import { supabase } from './supabase.js';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _currentUser = null;
let _following   = [];
let _followers   = [];

// ─── BUDDY HELPERS ────────────────────────────────────────────────────────────
// buddies table enforces requester_id < addressee_id (UUID string comparison).
// Always use these helpers to build the correct pair ordering.

function _buddyPair(idA, idB, initiatorId) {
    const pair = idA < idB
        ? { requester_id: idA, addressee_id: idB }
        : { requester_id: idB, addressee_id: idA };
    if (initiatorId) pair.initiator_id = initiatorId;
    return pair;
}

function _buddyFilter(q, myId, otherId) {
    const pair = _buddyPair(myId, otherId);
    return q.eq('requester_id', pair.requester_id).eq('addressee_id', pair.addressee_id);
}

// ─── SWITCHER REBUILD ─────────────────────────────────────────────────────────
// Imported by social functions that mutate buddy state so the switcher
// panel stays in sync. Resolved at call-time via window to avoid circular
// import between social.js and switcher.js.

export function rebuildSwitcherPanel() {
    const existing = document.getElementById('mode-switcher-panel');
    if (existing) existing.remove();
    window._switcherPanelBuilt = false;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initSocial(currentUser) {
    _currentUser = currentUser;
    const myId = currentUser.id;

    // Single query: all buddy rows involving me (both directions)
    const { data: allBuddyRows } = await supabase
        .from('buddies')
        .select('requester_id, addressee_id, initiator_id, status')
        .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);

    const rows = allBuddyRows || [];

    // Resolve the "other" user id from each row
    const otherUserId = r => r.requester_id === myId ? r.addressee_id : r.requester_id;

    const acceptedIds        = rows.filter(r => r.status === 'accepted').map(otherUserId);
    // Inbound pending: rows where I am the addressee and status is pending
    const pendingInboundIds  = rows.filter(r => r.status === 'pending' && r.initiator_id !== myId).map(r => r.initiator_id);
    // Outbound pending: rows where I am the requester and status is pending
    const pendingOutboundIds = new Set(
        rows.filter(r => r.status === 'pending' && r.initiator_id === myId)
            .map(r => r.requester_id === myId ? r.addressee_id : r.requester_id)
    );

    // Fetch profiles for accepted buddies and inbound pending requesters
    const allNeededIds = [...new Set([...acceptedIds, ...pendingInboundIds])];
    let profileMap = {};
    if (allNeededIds.length) {
        const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url')
            .in('id', allNeededIds);
        (profileRows || []).forEach(p => { profileMap[p.id] = p; });
    }

    // Buddies is symmetric — accepted buddies populate both _following and _followers
    _following = acceptedIds.map(id => profileMap[id]).filter(Boolean).map(p => ({
        id:           p.id,
        username:     p.username,
        display_name: p.display_name || p.username,
        avatar_url:   p.avatar_url || null,
    }));
    _followers = _following;

    window._following = _following;
    window._followers = _followers;

    const pendingRequestProfiles = pendingInboundIds.map(id => profileMap[id]).filter(Boolean);
    window._pendingRequests = pendingRequestProfiles;

    // Show pending buddy requests banner
    if (pendingRequestProfiles.length > 0) {
        const banner = document.getElementById('follow-back-banner');
        const list   = document.getElementById('follow-back-list');
        if (banner && list) {
            list.innerHTML = pendingRequestProfiles.map(f => `
                <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-black text-indigo-900">${f.username} wants to be gig buddies</span>
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
                </div>`).join('');
            banner.classList.remove('hidden');
        }
    }

    _renderBuddyList();
    _loadPrivacySetting();
}

// ─── PRIVACY ──────────────────────────────────────────────────────────────────

async function _loadPrivacySetting() {
    const { data } = await supabase
        .from('profiles')
        .select('is_public')
        .eq('id', _currentUser.id)
        .single();

    const isPublic = data?.is_public || false;
    const btn  = document.getElementById('privacy-toggle');
    const knob = document.getElementById('privacy-knob');
    if (btn)  btn.setAttribute('aria-checked', String(isPublic));
    if (btn)  btn.classList.toggle('bg-indigo-600', isPublic);
    if (btn)  btn.classList.toggle('bg-slate-200',  !isPublic);
    if (knob) knob.style.transform = isPublic ? 'translateX(1.5rem)' : 'translateX(0)';
}

window.togglePrivacy = async () => {
    const btn  = document.getElementById('privacy-toggle');
    const knob = document.getElementById('privacy-knob');
    const isNowPublic = btn?.getAttribute('aria-checked') !== 'true';

    const { error } = await supabase
        .from('profiles')
        .update({ is_public: isNowPublic })
        .eq('id', _currentUser.id);

    if (error) { window.showToast('Could not update privacy setting', 'error'); return; }

    btn?.setAttribute('aria-checked', String(isNowPublic));
    if (btn)  btn.classList.toggle('bg-indigo-600', isNowPublic);
    if (btn)  btn.classList.toggle('bg-slate-200',  !isNowPublic);
    if (knob) knob.style.transform = isNowPublic ? 'translateX(1.5rem)' : 'translateX(0)';

    window.showToast(
        isNowPublic
            ? 'Profile set to public — anyone can add you as a gig buddy'
            : 'Profile set to private — buddy requests need your approval',
        'info', 4000
    );
};

// ─── BUDDY LIST (SETTINGS PANEL) ─────────────────────────────────────────────

function _renderBuddyList() {
    const container = document.getElementById('following-users');
    if (!container) return;

    if (_following.length === 0) {
        container.innerHTML = '<p class="text-xs text-slate-400 italic">No gig buddies yet — search above to find friends.</p>';
        return;
    }

    // Enrich each buddy with shared show count and last show together
    const myJournal   = window.journalData || [];
    const buddyKeys   = window._buddyJournalKeys || {};

    const enriched = _following.map(f => {
        const sharedKeys = buddyKeys[f.id] ? [...buddyKeys[f.id]] : [];
        const sharedCount = sharedKeys.length;

        // Find most recent shared show from journal data
        const sharedShows = myJournal
            .filter(g => sharedKeys.includes(g['Journal Key']))
            .sort((a, b) => {
                const [ad, am, ay] = a.Date.split('/');
                const [bd, bm, by] = b.Date.split('/');
                return new Date(by, bm-1, bd) - new Date(ay, am-1, ad);
            });
        const lastShow = sharedShows[0];
        const lastTogether = lastShow
            ? `${lastShow.Band} at ${lastShow.OfficialVenue}`
            : null;

        return { ...f, sharedCount, lastTogether };
    }).sort((a, b) => b.sharedCount - a.sharedCount);

    // ── Strip (top 4, shown on profile page) ─────────────────────────────────
    const tileColours = [
        { bg: 'bg-indigo-100', text: 'text-indigo-700' },
        { bg: 'bg-emerald-100', text: 'text-emerald-700' },
        { bg: 'bg-amber-100', text: 'text-amber-700' },
        { bg: 'bg-rose-100', text: 'text-rose-700' },
        { bg: 'bg-sky-100', text: 'text-sky-700' },
    ];

    const stripContainer = document.getElementById('profile-buddy-strip');
    if (stripContainer) {
        const preview = enriched.slice(0, 4);
        const stripChips = preview.map(f => {
            const hash    = f.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const colour  = tileColours[hash % tileColours.length];
            const initials = (f.display_name || f.username).slice(0, 2).toUpperCase();
            const avatarEl = f.avatar_url
                ? `<img src="${f.avatar_url}" alt="${f.display_name || f.username}"
                        class="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm"
                        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                : '';
            const initialsEl = `<div class="w-12 h-12 rounded-full flex items-center justify-center text-sm font-black ${colour.bg} ${colour.text} ${f.avatar_url ? 'hidden' : ''}">${initials}</div>`;

            return `
            <button onclick="window.openProfile('${f.id}')"
                    class="flex flex-col items-center gap-1.5 flex-shrink-0">
                <div class="relative">
                    ${avatarEl}${initialsEl}
                </div>
                <span class="text-[8px] font-black text-slate-500 text-center leading-tight max-w-[48px]">${f.display_name || f.username}</span>
                ${f.sharedCount > 0
                    ? `<span class="text-[8px] font-black text-indigo-500">${f.sharedCount} shared</span>`
                    : `<span class="text-[8px] text-slate-300 font-bold">no shows yet</span>`}
            </button>`;
        }).join('');

        const findBuddySlot = `
            <div class="flex flex-col items-center gap-1.5 flex-shrink-0">
                <div class="w-12 h-12 rounded-full flex items-center justify-center border border-dashed border-slate-200 bg-slate-50">
                    <i data-lucide="user-plus" class="w-4 h-4 text-slate-300"></i>
                </div>
                <span class="text-[8px] font-black text-slate-300 text-center leading-tight max-w-[48px]">Find buddies</span>
            </div>`;

        stripContainer.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Gig Buddies</span>
                <button onclick="window.openBuddyList()"
                        class="text-[10px] font-black text-indigo-500 uppercase tracking-widest hover:text-indigo-700 transition-colors">
                    ${enriched.length} buddies · View all ›
                </button>
            </div>
            <div class="flex gap-4 justify-between">
                ${stripChips}
                ${enriched.length < 5 ? findBuddySlot : ''}
            </div>`;

        if (window.lucide) lucide.createIcons();
    }

    // ── Full list (shown in drill-in view) ────────────────────────────────────
    container.innerHTML = enriched.map(f => {
        const hash    = f.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const colour  = tileColours[hash % tileColours.length];
        const initials = (f.display_name || f.username).slice(0, 2).toUpperCase();
        const myCount = myJournal.length;
        const buddyGigCount = (buddyKeys[f.id]?.size ?? 0); // approximate from shared data

        const avatarEl = f.avatar_url
            ? `<img src="${f.avatar_url}" alt="${f.display_name || f.username}"
                    class="w-11 h-11 rounded-full object-cover border-2 border-white shadow-sm flex-shrink-0"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : '';
        const initialsEl = `<div class="w-11 h-11 rounded-full flex items-center justify-center text-sm font-black flex-shrink-0 ${colour.bg} ${colour.text} ${f.avatar_url ? 'hidden' : ''}">${initials}</div>`;

        const lastLine = f.lastTogether
            ? `<span class="text-[9px] text-slate-400 italic mt-0.5">Last together: ${f.lastTogether}</span>`
            : `<span class="text-[9px] text-indigo-400 italic mt-0.5">No shows together yet — change that! 🎸</span>`;

        return `
        <div class="flex items-center gap-3 py-3 border-b border-slate-50 last:border-0">
            <button onclick="window.openProfile('${f.id}')" class="flex-shrink-0">
                ${avatarEl}${initialsEl}
            </button>
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                    <button onclick="window.openProfile('${f.id}')"
                            class="text-sm font-black text-slate-800 hover:text-indigo-600 transition-colors">
                        ${f.display_name || f.username}
                    </button>
                    <button onclick="window.unfollowUser('${f.id}', '${f.username}')"
                            class="text-[9px] font-bold text-slate-300 hover:text-red-400 transition-colors uppercase tracking-widest ml-2 flex-shrink-0">
                        Remove
                    </button>
                </div>
                <div class="flex gap-1.5 mt-1 flex-wrap">
                    ${f.sharedCount > 0
                        ? `<span class="text-[9px] font-black bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">${f.sharedCount} together</span>`
                        : `<span class="text-[9px] font-black bg-slate-50 text-slate-400 px-2 py-0.5 rounded-full">0 together</span>`}
                </div>
                ${lastLine}
            </div>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 flex-shrink-0"></i>
        </div>`;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

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
        .neq('id', _currentUser.id)
        .limit(8);

    if (error || !data?.length) {
        const base    = window.location.pathname.replace(/\/[^/]*$/, '');
        const url     = `${window.location.origin}${base}/index.html`;
        const name    = q; // use whatever they searched for as the invitee name
        const message = `${name}, I've been tracking my gig history on GigList — come join so I can add you as a Gig Buddy!`;

        results.innerHTML = `
            <div class="flex items-center justify-between gap-2 py-1">
                <p class="text-xs text-slate-400 italic">No users found for "${q}".</p>
                <button id="buddy-invite-btn"
                        class="flex items-center gap-1.5 bg-slate-100 border border-slate-200 text-slate-600 text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 transition-all active:scale-95 uppercase tracking-widest">
                    <i data-lucide="share-2" class="w-3 h-3"></i>
                    Invite
                </button>
            </div>`;

        if (window.lucide) lucide.createIcons();

        document.getElementById('buddy-invite-btn').addEventListener('click', async () => {
            try {
                if (navigator.share) {
                    await navigator.share({ title: 'Join me on GigList', text: message, url });
                } else {
                    await navigator.clipboard.writeText(`${message} ${url}`);
                    if (window.showToast) window.showToast('Invite link copied!', 'success');
                }
            } catch (err) {
                if (err.name !== 'AbortError') console.warn('Share failed:', err);
            }
        });

        return;
    }

    const buddyIds = new Set(_following.map(f => f.id));

    results.innerHTML = data.map(u => {
        const isBuddy = buddyIds.has(u.id);
        return `
        <div class="flex items-center justify-between gap-2 py-1">
            <span class="text-sm font-black text-slate-700">${u.username}</span>
            ${isBuddy
                ? `<span class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Gig Buddy</span>`
                : `<button onclick="window.followUser('${u.id}', '${u.username}', this)"
                          class="bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                       Add Gig Buddy
                   </button>`
            }
        </div>`;
    }).join('');
};

// ─── ADD GIG BUDDY ────────────────────────────────────────────────────────────

window.followUser = async (userId, username, btn) => {
    const { data: targetProfile } = await supabase
        .from('profiles')
        .select('is_public')
        .eq('id', userId)
        .single();

    const buddyStatus = targetProfile?.is_public ? 'accepted' : 'pending';
    const pair = _buddyPair(_currentUser.id, userId, _currentUser.id);

    console.log('[buddy insert]', {
      currentUser: _currentUser?.id,
      pair: _buddyPair(_currentUser.id, userId),
      status: buddyStatus
    });

    const { error } = await supabase.from('buddies').insert({
        ...pair,
        status: buddyStatus
    });

    if (error) {
        let msg = `Couldn't send buddy request to ${username} — try again`;
        if (error.code === '23505') {
            let q = supabase.from('buddies').select('status');
            q = _buddyFilter(q, _currentUser.id, userId);
            const { data: existingBuddy } = await q.single();
            msg = existingBuddy?.status === 'pending'
                ? `Buddy request to ${username} is still pending`
                : `You're already gig buddies with ${username}`;
            // Repair local state if accepted but not reflected
            if (existingBuddy?.status === 'accepted' && !_following.find(f => f.id === userId)) {
                _following.push({ id: userId, username });
                window._following = _following;
                _renderBuddyList();
                rebuildSwitcherPanel();
            }
        }
        window.showToast(msg, 'warning');
        return;
    }

    window.track('follow_user', { target: username, status: buddyStatus });

    if (buddyStatus === 'pending') {
        window.showToast(`Gig buddy request sent to ${username}`, 'info');
        if (btn) {
            const el = btn.tagName === 'BUTTON' ? btn : btn.querySelector('button');
            if (el) el.outerHTML = `<span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Requested</span>`;
        }
        return;
    }

    _following.push({ id: userId, username });
    window._following = _following;

    if (btn) {
        const el = btn.tagName === 'BUTTON' ? btn : btn.querySelector('button');
        if (el) el.outerHTML = `<span class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Gig Buddy</span>`;
    }

    _renderBuddyList();
    rebuildSwitcherPanel();

    const bannerRow = document.querySelector(`[data-user="${userId}"]`);
    bannerRow?.closest('[data-dismiss]')?.remove() ||
    bannerRow?.closest('.flex')?.remove();

    document.querySelectorAll(`button[onclick*="followUser('${userId}"]`).forEach(b => {
        b.outerHTML = `<span class="text-indigo-300 text-[9px] font-black">✓</span>`;
    });
};

// ─── REMOVE GIG BUDDY ─────────────────────────────────────────────────────────

window.unfollowUser = async (userId, username) => {
    const confirmed = await new Promise(resolve => {
        const container = document.getElementById('toast-container');
        if (!container) { resolve(window.confirm(`Remove ${username} as a gig buddy?`)); return; }
        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'toast-yes-' + Date.now();
        const noId  = 'toast-no-'  + Date.now();
        toast.innerHTML =
            '<span class="flex-1">Remove <strong>' + username + '</strong> as a gig buddy?</span>' +
            '<button id="' + yesId + '" class="bg-red-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-colors">Yes</button>' +
            '<button id="' + noId  + '" class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">No</button>';
        container.appendChild(toast);
        document.getElementById(yesId).onclick = () => { toast.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { toast.remove(); resolve(false); };
    });
    if (!confirmed) return;

    const pair = _buddyPair(_currentUser.id, userId);
    const { error } = await supabase.from('buddies')
        .delete()
        .eq('requester_id', pair.requester_id)
        .eq('addressee_id', pair.addressee_id);
    if (error) { window.showToast(`Couldn't remove ${username} — try again`, 'error'); return; }

    _following = _following.filter(f => f.id !== userId);
    window._following = _following;
    _renderBuddyList();
    rebuildSwitcherPanel();
};

// ─── ACCEPT / DECLINE BUDDY REQUEST ──────────────────────────────────────────

window.acceptFollowRequest = async (userId, username, rowEl) => {
    let q = supabase.from('buddies').update({ status: 'accepted' });
    q = _buddyFilter(q, _currentUser.id, userId);
    const { error } = await q;
    if (error) { window.showToast('Could not accept request', 'error'); return; }

    window._pendingRequests = (window._pendingRequests || []).filter(f => f.id !== userId);
    if (!_following.find(f => f.id === userId)) {
        _following.push({ id: userId, username });
        window._following = _following;
        _followers = _following;
        window._followers = _followers;
    }

    rowEl?.remove();
    window.showToast(`You're now gig buddies with ${username}!`, 'success');
    _renderBuddyList();
    rebuildSwitcherPanel();

    const list = document.getElementById('follow-back-list');
    if (list && !list.children.length) {
        document.getElementById('follow-back-banner')?.classList.add('hidden');
    }
};

window.declineFollowRequest = async (userId, rowEl) => {
    const pair = _buddyPair(_currentUser.id, userId);
    const { error } = await supabase.from('buddies')
        .delete()
        .eq('requester_id', pair.requester_id)
        .eq('addressee_id', pair.addressee_id);
    if (error) { window.showToast('Could not decline request', 'error'); return; }
    window._pendingRequests = (window._pendingRequests || []).filter(f => f.id !== userId);
    rowEl?.remove();
    const list = document.getElementById('follow-back-list');
    if (list && !list.children.length) {
        document.getElementById('follow-back-banner')?.classList.add('hidden');
    }
};

window.dismissFollowBack = (userId) => {
    const dismissed = new Set(JSON.parse(sessionStorage.getItem('followback_dismissed') || '[]'));
    dismissed.add(userId);
    sessionStorage.setItem('followback_dismissed', JSON.stringify([...dismissed]));
    const row = document.querySelector(`[data-followback="${userId}"]`);
    row?.remove();
    const list = document.getElementById('follow-back-list');
    if (list && !list.children.length) {
        document.getElementById('follow-back-banner')?.classList.add('hidden');
    }
};

// ─── GIG OVERLAP / CONNECTIONS BANNER ────────────────────────────────────────

export async function checkGigOverlap(currentUser) {
    if (!currentUser?.isAuthUser || currentUser?.Type !== 'Personal') return;

    const banner = document.getElementById('connections-banner');
    if (!banner) return;
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

    const buddySet = new Set((_following || []).map(f => f.id));
    const list = document.getElementById('connections-list');
    if (!list) return;

    list.innerHTML = connections.map(c => {
        const isBuddy = buddySet.has(c.id);
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
            ${isBuddy
                ? '<span class="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex-shrink-0 pt-0.5">Gig Buddy</span>'
                : `<button onclick="window.followUser('${c.id}', '${c.username}', this.closest('[data-user-id]'))"
                          class="flex-shrink-0 bg-indigo-600 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-indigo-700 transition-all active:scale-95 uppercase tracking-widest">
                       Add Gig Buddy
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

// ─── GIG ATTENDEES (MODAL) ────────────────────────────────────────────────────

window.loadGigAttendees = async (journalKey, journalId) => {
    if (!_currentUser?.isAuthUser) return;

    const safeKey   = journalKey.replace(/[^a-z0-9]/gi, '_');
    const container = document.getElementById(`modal-companions-${safeKey}`);
    if (!container) return;

    const buddyIds = new Set((_following || []).map(f => f.id));

    // ── 1. Companions for this gig ──────────────────────────────────────────
    const { data: companionRows } = await supabase
        .from('gig_companions')
        .select('companion_name, companion_user_id, status')
        .eq('journal_id', journalId);

    // ── 2. Other GigList users who also logged this show ────────────────────
    const { data: attendeeRows } = await supabase
        .from('show_attendance')
        .select('user_id')
        .eq('journal_key', journalKey)
        .neq('user_id', _currentUser.id);

    // Collect all user IDs we need profiles for
    const companionUserIds = (companionRows || [])
        .map(r => r.companion_user_id).filter(Boolean);
    const attendeeUserIds  = (attendeeRows  || [])
        .map(r => r.user_id).filter(id => id !== _currentUser.id);
    const allUserIds = [...new Set([...companionUserIds, ...attendeeUserIds])];

    let profileMap = {};
    if (allUserIds.length) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, username, is_public')
            .in('id', allUserIds);
        (profiles || []).forEach(p => { profileMap[p.id] = p; });
    }

    // ── 3. Build unified chip list ──────────────────────────────────────────
    // Track rendered user IDs to avoid duplicates
    const rendered = new Set();
    const chips    = [];

    // Process tagged companions first (they have a name to show)
    for (const row of (companionRows || [])) {
        const name    = row.companion_name?.trim();
        if (!name) continue;

        const userId  = row.companion_user_id;
        const profile = userId ? profileMap[userId] : null;
        const isBuddy = userId ? buddyIds.has(userId) : false;

        if (userId) rendered.add(userId);

        if (!userId) {
            // State 1: named companion, not on GigList → share/invite chip
            const inviteMsg = `${name}, I've been tracking my gig history on GigList — come join so I can add you as a Gig Buddy!`;
            const inviteUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/index.html');
            chips.push(`
                <span class="inline-flex items-center gap-1.5 bg-slate-100 border border-slate-200 text-slate-600 text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider">
                    ${name}
                    <button onclick="(async()=>{try{if(navigator.share){await navigator.share({title:'Join me on GigList',text:'${inviteMsg.replace(/'/g,"\\'")}',url:'${inviteUrl}'});}else{await navigator.clipboard.writeText('${inviteMsg.replace(/'/g,"\\'")} ${inviteUrl}');window.showToast('Invite link copied!','success');}}catch(e){}})()"
                            class="text-slate-400 hover:text-indigo-600 transition-colors" title="Invite ${name} to GigList">
                        <i data-lucide="share-2" class="w-2.5 h-2.5"></i>
                    </button>
                </span>`);

        } else if (isBuddy) {
            // State 3: companion + confirmed buddy → tappable name
            chips.push(`
                <button onclick="window._openProfileFromModal('${userId}')"
                        class="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-black uppercase tracking-wider hover:bg-indigo-100 transition-colors">
                    <i data-lucide="music" class="w-2.5 h-2.5"></i>
                    ${name}
                </button>`);

        } else {
            // State 2: companion + on GigList, not yet a buddy
            const isPublic = profile?.is_public;
            const nameEl = isPublic
                ? `<button onclick="window._openProfileFromModal('${userId}')" class="hover:underline">${name}</button>`
                : `<span>${name}</span>`;
            chips.push(`
                <span class="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider">
                    <i data-lucide="music" class="w-2.5 h-2.5"></i>
                    ${nameEl}
                    <button onclick="window.followUser('${userId}', '${profile?.username || name}', this)"
                            class="text-indigo-400 hover:text-indigo-700 font-black transition-colors" title="Add ${name} as Gig Buddy">
                        <i data-lucide="user-plus" class="w-2.5 h-2.5"></i>
                    </button>
                </span>`);
        }
    }

    // Process GigList attendees not already rendered (not tagged as companions)
    for (const userId of attendeeUserIds) {
        if (rendered.has(userId)) continue;
        const profile = profileMap[userId];
        if (!profile) continue;

        const isBuddy    = buddyIds.has(userId);
        const isPublic   = profile.is_public;
        const username   = profile.username;

        if (isBuddy) {
            // State 3: at the show, confirmed buddy
            chips.push(`
                <button onclick="window._openProfileFromModal('${userId}')"
                        class="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-black uppercase tracking-wider hover:bg-indigo-100 transition-colors">
                    <i data-lucide="music" class="w-2.5 h-2.5"></i>
                    ${username}
                </button>`);
        } else {
            // State 2: at the show, not a buddy
            const nameEl = isPublic
                ? `<button onclick="window._openProfileFromModal('${userId}')" class="hover:underline">${username}</button>`
                : `<span>${username}</span>`;
            chips.push(`
                <span class="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider">
                    <i data-lucide="music" class="w-2.5 h-2.5"></i>
                    ${nameEl}
                    <button onclick="window.followUser('${userId}', '${username}', event.currentTarget)"
                            class="text-indigo-400 hover:text-indigo-700 font-black transition-colors" title="Add ${username} as Gig Buddy">
                        <i data-lucide="user-plus" class="w-2.5 h-2.5"></i>
                    </button>
                </span>`);
        }
    }

    // ── 4. Render ───────────────────────────────────────────────────────────
    if (chips.length) {
        container.innerHTML = chips.join('');
    } else {
        container.innerHTML = `<span class="text-[9px] opacity-60 italic text-slate-400">Solo Mission</span>`;
    }

    if (window.lucide) lucide.createIcons();
};

// ─── LEGACY COMPANION RESOLUTION ─────────────────────────────────────────────

/**
 * On sign-in, promote any gig_companions rows where companion_name matches
 * this user's display_name (case-insensitive) from 'legacy' to 'confirmed'.
 * This fires once per session — silent, no UI impact if nothing matches.
 */
export async function resolveCompanionTags(user) {
    if (!user?.id || !user?.display_name) return;

    const { data: matches, error } = await supabase
        .from('gig_companions')
        .select('id')
        .ilike('companion_name', user.display_name)
        .eq('status', 'legacy')
        .neq('owner_id', user.id); // don't match self-tags

    if (error) { console.warn('resolveCompanionTags:', error.message); return; }
    if (!matches?.length) return;

    const ids = matches.map(r => r.id);

    const { error: updateError } = await supabase
        .from('gig_companions')
        .update({
            companion_user_id: user.id,
            status: 'confirmed',
            updated_at: new Date().toISOString(),
        })
        .in('id', ids);

    if (updateError) {
        console.warn('resolveCompanionTags update:', updateError.message);
        return;
    }

    console.log(`resolveCompanionTags: promoted ${ids.length} legacy companion row(s) for ${user.display_name}`);
}

// ─── MANAGE PROFILE SCREEN DISPLAY ─────────────────────────────────────────────

window._openProfileFromModal = (userId) => {
    window.closeModal();
    window.openProfile(userId);
};
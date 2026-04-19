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

function _buddyPair(idA, idB) {
    return idA < idB
        ? { requester_id: idA, addressee_id: idB }
        : { requester_id: idB, addressee_id: idA };
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
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);

    const rows = allBuddyRows || [];

    // Resolve the "other" user id from each row
    const otherUserId = r => r.requester_id === myId ? r.addressee_id : r.requester_id;

    const acceptedIds        = rows.filter(r => r.status === 'accepted').map(otherUserId);
    // Inbound pending: rows where I am the addressee and status is pending
    const pendingInboundIds  = rows.filter(r => r.status === 'pending' && r.addressee_id === myId).map(r => r.requester_id);
    // Outbound pending: rows where I am the requester and status is pending
    const pendingOutboundIds = new Set(
        rows.filter(r => r.status === 'pending' && r.requester_id === myId).map(r => r.addressee_id)
    );

    // Fetch profiles for accepted buddies and inbound pending requesters
    const allNeededIds = [...new Set([...acceptedIds, ...pendingInboundIds])];
    let profileMap = {};
    if (allNeededIds.length) {
        const { data: profileRows } = await supabase
            .from('profiles')
            .select('id, username')
            .in('id', allNeededIds);
        (profileRows || []).forEach(p => { profileMap[p.id] = p; });
    }

    // Buddies is symmetric — accepted buddies populate both _following and _followers
    _following = acceptedIds.map(id => profileMap[id]).filter(Boolean).map(p => ({ id: p.id, username: p.username }));
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

    container.innerHTML = _following.map(f => `
        <div class="flex items-center justify-between gap-2">
            <button onclick="window._switchToFriend('${f.id}', '${f.username}')"
                    class="text-sm font-black text-slate-700 hover:text-indigo-600 transition-colors text-left">
                ${f.username}
            </button>
            <button onclick="window.unfollowUser('${f.id}', '${f.username}')"
                    class="text-[10px] font-bold text-slate-400 hover:text-red-500 transition-colors uppercase tracking-widest">
                Remove
            </button>
        </div>
    `).join('');
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
        results.innerHTML = '<p class="text-xs text-slate-400 italic">No users found.</p>';
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
    const pair = _buddyPair(_currentUser.id, userId);

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

window.loadGigAttendees = async (journalKey) => {
    if (!_currentUser?.isAuthUser) return;

    const safeKey   = journalKey.replace(/[^a-z0-9]/gi, '_');
    const container = document.getElementById(`modal-giglist-attendees-${safeKey}`);
    const list      = document.getElementById(`modal-giglist-attendees-list-${safeKey}`);
    if (!container || !list) return;

    const { data: attendees, error } = await supabase
        .from('show_attendance')
        .select('user_id')
        .eq('journal_key', journalKey)
        .neq('user_id', _currentUser.id);

    if (error) { console.warn('loadGigAttendees:', error.message); return; }
    if (!attendees?.length) return;

    const otherIds = attendees.map(r => r.user_id);

    const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', otherIds);

    if (!profiles?.length) return;

    const buddyIds = new Set((_following || []).map(f => f.id));

    list.innerHTML = profiles.map(p => {
        const isBuddy = buddyIds.has(p.id);
        return `
            <span class="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] px-2 py-1 rounded-md font-black uppercase tracking-wider">
                <i data-lucide="music" class="w-2.5 h-2.5" aria-hidden="true"></i>
                ${p.username}
                ${!isBuddy
                    ? `<button onclick="window.followUser('${p.id}', '${p.username}', this)" class="ml-0.5 text-indigo-400 hover:text-indigo-700 font-black transition-colors">+add</button>`
                    : ''}
            </span>`;
    }).join('');

    container.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
};
/**
 * GigList — Onboarding & Companion Tags Module
 * v1.1.0 — 2026-04-14
 * -------------------------------------------------------------------
 * Handles two related but distinct flows:
 *
 * A) NEW USER ONBOARDING (?new=true)
 *    Step 1 — Companion matching: show a claim panel for shows where other
 *             users have tagged this new user in their went_with field.
 *    Step 2 — Open settings modal pre-focused on setlist.fm sync field.
 *
 * B) RETURNING USER COMPANION NOTIFICATIONS
 *    On every personal login, check whether anyone has newly tagged this
 *    user in a went_with field since they last acknowledged. If so, show
 *    a banner on the home screen so they can view or claim those shows.
 *
 * Both flows use the get_companion_matches SECURITY DEFINER RPC which
 * bypasses RLS — so follow relationships are irrelevant to visibility.
 *
 * Exports:
 *   runOnboarding(currentUser)         — called by initApp when ?new=true
 *   checkCompanionTags(currentUser)    — called by initApp on every personal login
 *   showNoSetlistTip()                 — called by vault.html "no account" button
 *   handleZeroSyncResult()             — called by syncSetlistFm on 0 results
 *   acknowledgeCompanionTag(userId, journalKey)
 *                                       — called by editor.js after a companion-
 *                                         prefilled show is saved, to mark that
 *                                         tag resolved
 *   clearCompanionTagFromBanner(journalKey)
 *                                       — called by editor.js alongside the above,
 *                                         so the banner updates immediately instead
 *                                         of persisting until dismiss/refresh
 */

import { supabase } from './supabase.js';
import { escapeHtml } from './utils.js';

// ─── A) NEW USER ONBOARDING ───────────────────────────────────────────────────

/**
 * Entry point for ?new=true flow.
 * Runs companion claim panel first, then opens settings for setlist sync.
 */
export async function runOnboarding(currentUser) {
    const claimed = await runCompanionMatching(currentUser);

    // Open settings modal slightly later if claim panel was shown, so the
    // two modals don't fight for attention
    setTimeout(() => {
        window.openSettings?.();
        const input = document.getElementById('setlistIdInput-legacy');
        const hint  = document.getElementById('sync-status-legacy');
        if (input) input.focus();
        if (hint) {
            hint.textContent = 'Welcome! Enter your setlist.fm username to import your full gig history.';
            hint.className = 'text-[10px] mt-3 leading-relaxed text-indigo-500 font-black not-italic';
        }
    }, claimed > 0 ? 1200 : 600);
}

async function runCompanionMatching(currentUser) {
    const username = currentUser.username || currentUser.UserName;
    if (!username) return 0;

    const { data: matches, error } = await supabase.rpc('get_companion_matches', {
        p_username: username,
    });

    if (error) {
        console.warn('companion matching RPC failed:', error.message);
        return 0;
    }
    if (!matches?.length) return 0;

    // Deduplicate by journal_key — multiple people may have tagged this user
    // in the same show. Keep the first match per key but collect all tagger names.
    const byKey = new Map();
    for (const row of matches) {
        if (!byKey.has(row.journal_key)) {
            byKey.set(row.journal_key, { ...row, taggers: [row.owner_username] });
        } else {
            byKey.get(row.journal_key).taggers.push(row.owner_username);
        }
    }

    const dedupedMatches = [...byKey.values()];
    renderClaimPanel(currentUser, dedupedMatches);
    return dedupedMatches.length;
}

function renderClaimPanel(currentUser, matches) {
    document.getElementById('companion-claim-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'companion-claim-panel';
    panel.className = 'fixed inset-0 z-[120] bg-slate-900/70 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'claim-panel-title');

    const showRows = matches.map(row => {
        const displayBand = row.festival ? (row.band || 'Festival') : row.band;
        const subline = row.festival && row.festival_lineups
            ? row.festival_lineups.split('/').map(s => s.trim()).slice(0, 3).join(', ') +
              (row.festival_lineups.split('/').length > 3 ? '…' : '')
            : (row.notable_support ? `Support: ${row.notable_support}` : row.official_venue);
        const viaLabel = row.taggers.join(', ');

        return `
        <div class="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0"
             data-key="${escapeHtml(row.journal_key)}">
            <input type="checkbox" checked
                   id="claim-${escapeHtml(row.journal_key)}"
                   class="mt-1 w-4 h-4 rounded accent-indigo-600 flex-shrink-0 cursor-pointer">
            <label for="claim-${escapeHtml(row.journal_key)}" class="flex-1 min-w-0 cursor-pointer">
                <span class="block text-sm font-black text-slate-900 truncate">${escapeHtml(displayBand)}</span>
                <span class="block text-[10px] text-slate-400 font-bold mt-0.5 truncate">
                    ${escapeHtml(row.date)} · ${escapeHtml(row.official_venue)}
                </span>
                ${subline ? `<span class="block text-[10px] text-indigo-400 font-bold truncate">${escapeHtml(subline)}</span>` : ''}
            </label>
            <span class="text-[9px] font-black text-slate-300 uppercase tracking-widest flex-shrink-0 pt-1 text-right">
                via ${escapeHtml(viaLabel)}
            </span>
        </div>`;
    }).join('');

    panel.innerHTML = `
        <div class="bg-white w-full sm:max-w-lg max-h-[92vh] rounded-t-[2.5rem] sm:rounded-[2.5rem] flex flex-col overflow-hidden shadow-2xl">
            <div class="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
                <div>
                    <h2 id="claim-panel-title" class="text-xl font-black tracking-tight text-slate-900 uppercase italic">
                        You've been spotted!
                    </h2>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
                        ${matches.length} show${matches.length !== 1 ? 's' : ''} other GigList users say you attended
                    </p>
                </div>
            </div>
            <div class="overflow-y-auto flex-grow px-6 py-4">
                <p class="text-xs text-slate-500 font-bold mb-4 leading-relaxed">
                    Tick the shows you actually went to and we'll add them to your archive.
                    You can always edit or remove them later.
                </p>
                <div class="space-y-0">${showRows}</div>
            </div>
            <div class="flex flex-col gap-3 px-6 py-5 border-t border-slate-100 flex-shrink-0">
                <button id="btn-claim-selected"
                        onclick="window._claimSelectedShows()"
                        class="w-full py-3 text-sm font-black text-white bg-indigo-600 hover:bg-indigo-700 rounded-2xl transition-all active:scale-95 uppercase tracking-widest">
                    Add Selected Shows
                </button>
                <button onclick="window._dismissClaimPanel()"
                        class="w-full py-2.5 text-[11px] font-black text-slate-400 hover:text-slate-600 rounded-2xl transition-all uppercase tracking-widest">
                    None of these — skip
                </button>
            </div>
        </div>`;

    document.body.appendChild(panel);

    // Store the deduped matches for the claim handler
    window._companionMatchData = matches;
}

window._dismissClaimPanel = () => {
    document.getElementById('companion-claim-panel')?.remove();
    window._companionMatchData = null;
};

window._claimSelectedShows = async () => {
    const btn = document.getElementById('btn-claim-selected');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const newUserId   = session.user.id;
    const newUsername = window.currentUser?.username || window.currentUser?.UserName || '';
    const allMatches  = window._companionMatchData || [];

    const checkedKeys = new Set(
        [...document.querySelectorAll('#companion-claim-panel input[type="checkbox"]:checked')]
            .map(cb => cb.id.replace('claim-', ''))
    );

    if (!checkedKeys.size) {
        window._dismissClaimPanel();
        return;
    }

    const toInsert = allMatches.filter(row => checkedKeys.has(row.journal_key));
    let inserted = 0;
    let failed   = 0;

    for (const row of toInsert) {
        const newRow = {
            user_id:          newUserId,
            journal_key:      row.journal_key,
            date:             row.date,
            band:             row.band,
            official_venue:   row.official_venue,
            venue:            row.official_venue,
            festival:         row.festival ?? false,
            festival_lineups: row.festival_lineups ?? null,
            notable_support:  row.notable_support ?? null,
            went_with:        row.taggers.join(' / '),
            comments:         null,
            price:            null,
            photos:           null,
            review_url:       null,
        };

        const { error } = await supabase.from('journals').insert(newRow);

        if (error) {
            if (error.code === '23505') {
                inserted++; // already exists — count as success
            } else {
                console.warn('claim insert failed:', error.message, row.journal_key);
                failed++;
            }
        } else {
            inserted++;
            await _addCompanionToOwnerRow(row, newUsername);
        }
    }

    window._dismissClaimPanel();

    if (inserted > 0) {
        window.showToast?.(`${inserted} show${inserted !== 1 ? 's' : ''} added to your archive!`, 'success', 5000);
        setTimeout(async () => {
            const { loadAppData } = await import('./data.js');
            const data = await loadAppData(window.currentUser);
            window.journalData     = data.journalData;
            window.performanceData = data.performanceData;
            window.filteredResults = [...data.journalData];
            window.refreshUI?.();
        }, 500);
    }

    if (failed > 0) {
        window.showToast?.(`${failed} show${failed !== 1 ? 's' : ''} couldn't be added — you can add them manually.`, 'warning', 5000);
    }

    return inserted;
};

async function _addCompanionToOwnerRow(row, newUsername) {
    if (!newUsername || !row.owner_user_id) return;

    const { data: ownerRow } = await supabase
        .from('journals')
        .select('went_with')
        .eq('user_id', row.owner_user_id)
        .eq('journal_key', row.journal_key)
        .single();

    if (!ownerRow) return;

    const existing = (ownerRow.went_with || '').split('/').map(s => s.trim()).filter(Boolean);
    if (existing.some(n => n.toLowerCase() === newUsername.toLowerCase())) return;

    const updated = [...existing, newUsername].join(' / ');
    await supabase
        .from('journals')
        .update({ went_with: updated })
        .eq('user_id', row.owner_user_id)
        .eq('journal_key', row.journal_key);
}

// ─── B) RETURNING USER COMPANION NOTIFICATIONS ───────────────────────────────

/**
 * Called on every personal login (not just ?new=true).
 * Shows a home-screen banner for shows where the user has been tagged
 * that they don't yet own and haven't previously acknowledged.
 *
 * Acknowledgement happens only when the user explicitly dismisses the banner,
 * NOT on mere display — so the banner persists across logins until acted on.
 */
export async function checkCompanionTags(currentUser) {
    if (!currentUser?.isAuthUser || currentUser?.Type !== 'Personal') return;

    // Don't re-show within the same browser session (tab refresh etc.)
    if (sessionStorage.getItem('companion_tags_dismissed')) return;

    const username = currentUser.UserName || currentUser.username;
    if (!username) return;

    // Fetch already-acknowledged journal keys
    const { data: profile } = await supabase
        .from('profiles')
        .select('companion_acknowledged_keys')
        .eq('id', currentUser.id)
        .single();

    const acknowledged = new Set(profile?.companion_acknowledged_keys || []);

    // Fetch the user's own journal keys to exclude shows they already own
    const { data: myJournals } = await supabase
        .from('journals')
        .select('journal_key')
        .eq('user_id', currentUser.id);

    const myKeys = new Set((myJournals || []).map(j => j.journal_key));

    // Call the SECURITY DEFINER RPC — bypasses RLS, no follow relationship needed
    const { data: matches, error } = await supabase
        .rpc('get_companion_matches', { p_username: username });

    if (error) { console.warn('checkCompanionTags:', error.message); return; }

    // Log BEFORE any filtering so we see the raw state
    console.log('companion check — raw', {
        username,
        matchCount: matches?.length,
        myKeyCount: myKeys.size,
        acknowledgedCount: acknowledged.size,
        acknowledged: [...acknowledged],
        myKeys: [...myKeys],
        matches,
    });

    if (!matches?.length) return;

    const newMatches = matches.filter(m =>
        !myKeys.has(m.journal_key) && !acknowledged.has(m.journal_key)
    );

    console.log('companion check — filtered', {
        newMatchCount: newMatches.length,
        newMatches,
    });

    if (!newMatches.length) return;

    _renderCompanionTagsBanner(newMatches, currentUser);
    window.track?.('companion_tags_shown', { count: newMatches.length });
}

/**
 * A show is "future" if its date is today or later. Used purely to pick
 * the right decline label ("Not going" vs "Didn't go") — has no bearing
 * on matching or acknowledgement logic.
 */
function _isFutureShow(dateStr) {
    if (!dateStr) return false;
    const [d, m, y] = dateStr.split('/').map(Number);
    if (!d || !m || !y) return false;
    const showDate = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return showDate >= today;
}

function _renderCompanionTagsBanner(matches, currentUser) {
    const banner = document.getElementById('companion-tags-banner');
    const list   = document.getElementById('companion-tags-list');
    if (!banner || !list) return;

    list.innerHTML = matches.map(m => {
        const declineLabel = _isFutureShow(m.date) ? 'Not going' : "Didn't go";

        return `
        <div class="flex items-start justify-between gap-3 py-2 border-b border-slate-100 last:border-0"
             data-journal-key="${escapeHtml(m.journal_key)}">
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-slate-900 truncate">${escapeHtml(m.band)}</p>
                <p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                    ${escapeHtml(m.official_venue)}${m.date ? ' &mdash; ' + escapeHtml(m.date) : ''}
                    &mdash; added by <strong class="text-slate-700">${escapeHtml(m.owner_username)}</strong>
                </p>
            </div>
            <div class="flex flex-col items-end gap-1.5 flex-shrink-0 ml-2">
                <button data-companion-view-id="${escapeHtml(m.journal_id)}" data-companion-view-username="${escapeHtml(m.owner_username)}"
                        class="bg-slate-900 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-slate-700 transition-all active:scale-95 uppercase tracking-widest">
                    View
                </button>
                <button data-companion-decline-key="${escapeHtml(m.journal_key)}"
                        class="text-[9px] font-bold text-slate-300 hover:text-red-400 transition-colors uppercase tracking-widest">
                    ${declineLabel}
                </button>
            </div>
        </div>`;
    }).join('');

    // One delegated listener instead of onclick="fn('${...}')" strings — a
    // username or journal key containing a quote used to break out of the
    // inline handler (HTML-attribute entity decoding happens before the
    // browser compiles onclick="..." as JS, so escaping quotes as entities
    // doesn't protect this context; data attributes sidestep it entirely).
    if (!list._companionClickWired) {
        list._companionClickWired = true;
        list.addEventListener('click', (e) => {
            const viewBtn = e.target.closest('[data-companion-view-id]');
            if (viewBtn) {
                window.openCompanionPrefillModal(viewBtn.dataset.companionViewId, viewBtn.dataset.companionViewUsername);
                return;
            }
            const declineBtn = e.target.closest('[data-companion-decline-key]');
            if (declineBtn) {
                window.declineCompanionTag(declineBtn.dataset.companionDeclineKey, declineBtn.closest('[data-journal-key]'));
            }
        });
    }

    banner.classList.remove('hidden');

    // Store currentUser.id on the banner so the dismiss handler can access it
    // without closing over a stale variable
    banner.dataset.userId = currentUser.id;
}

// Called from vault.html via onclick — must be on window
//
// IMPORTANT: closing the banner is a "not now" action, not a "reviewed and
// resolved" action. It must NOT write to companion_acknowledged_keys — doing
// so previously caused shows the user never actually looked at to be
// silently and permanently suppressed from future banners. Acknowledgement
// should only ever happen against a specific journal_key as a result of an
// explicit per-show action (e.g. viewing/claiming or declining that show).
window.dismissCompanionTagsBanner = function() {
    const banner = document.getElementById('companion-tags-banner');
    if (!banner) return;

    banner.classList.add('hidden');
    sessionStorage.setItem('companion_tags_dismissed', '1');
    window.track?.('companion_tags_dismissed');

    // No acknowledgement here — dismiss only hides the banner for this
    // session. Anything not individually resolved will reappear on the
    // next login (as long as it isn't already in companion_acknowledged_keys).
};

/**
 * Removes a single row from the companion-tags banner (by journal_key) and
 * hides the whole banner if that was the last row. Shared by decline and
 * by the "accepted via save" path so the banner never sits stale until
 * a manual dismiss or page refresh.
 */
function _removeCompanionRowFromBanner(journalKey) {
    const banner = document.getElementById('companion-tags-banner');
    const list   = document.getElementById('companion-tags-list');
    if (!banner || !list) return;

    const row = list.querySelector(`[data-journal-key="${CSS.escape(journalKey)}"]`);
    row?.remove();

    if (!list.children.length) banner.classList.add('hidden');
}

/**
 * Public version of the above. Called by editor.js once a companion-
 * prefilled show has been genuinely saved, so the banner updates
 * immediately instead of persisting until dismiss or refresh.
 */
export function clearCompanionTagFromBanner(journalKey) {
    _removeCompanionRowFromBanner(journalKey);
}

// Called from the per-row "Not going" / "Didn't go" button in the banner.
// This is an explicit, single-show decision — unlike the old dismiss-all
// behaviour, it only ever acknowledges the one journal_key involved.
window.declineCompanionTag = async (journalKey, rowEl) => {
    const banner = document.getElementById('companion-tags-banner');
    const userId = banner?.dataset.userId;
    if (!userId) return;

    const btn = rowEl?.querySelector('button:last-child');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    await _acknowledgeCompanionTags(userId, [journalKey]);
    window.track?.('companion_tag_declined', { journal_key: journalKey });

    _removeCompanionRowFromBanner(journalKey);
};

/**
 * Public single-key acknowledge helper. Used by editor.js after a
 * companion-prefilled show is actually saved, so the tag is marked
 * resolved by a genuine user action rather than a banner dismiss.
 */
export async function acknowledgeCompanionTag(userId, journalKey) {
    if (!userId || !journalKey) return;
    return _acknowledgeCompanionTags(userId, [journalKey]);
}

async function _acknowledgeCompanionTags(userId, journalKeys) {
    const { data: profile } = await supabase
        .from('profiles')
        .select('companion_acknowledged_keys')
        .eq('id', userId)
        .single();

    const existing = profile?.companion_acknowledged_keys || [];
    const merged   = [...new Set([...existing, ...journalKeys])];

    await supabase
        .from('profiles')
        .update({ companion_acknowledged_keys: merged })
        .eq('id', userId);
}

// ─── SETLIST.FM TIPS ─────────────────────────────────────────────────────────

/**
 * Shows the email search tip in the settings modal.
 * Called by the "I don't have a setlist.fm account →" button in vault.html,
 * and automatically when sync returns 0 results.
 */

/**
 * Called from app.js syncSetlistFm onComplete when journalInserted === 0.
 * Shows a "wrong username?" hint in the status area, then reveals the shared
 * no-setlist-help block (same UI as clicking "I don't have a setlist.fm account").
 */
export function handleZeroSyncResult() {
    // app.js guards setStatus() behind journalInserted > 0, so by the time this runs
    // the status element is clear and we own it completely — no setTimeout needed.
    const hint = document.getElementById('sync-status-legacy') || document.getElementById('sync-status');
    if (hint) {
        hint.innerHTML = `
            <span class="text-indigo-500 font-black not-italic">✗ No shows found for that username.</span><br><br>
            <strong class="not-italic text-slate-700">Wrong username?</strong>
            Check your setlist.fm profile URL — it's the part after
            <code class="font-mono bg-slate-100 px-1 rounded">setlist.fm/user/</code>
        `;
        hint.className = 'text-sm mt-3 leading-relaxed text-slate-600 not-italic';
    }

    // Reveal the shared no-account help block (email search tip + CTAs)
    showNoSetlistTip();
}

// ─── FIRST GIG ACHIEVEMENT NOTIFICATION ──────────────────────────────────────

/**
 * Call this after a new journal entry is saved when the user's total gig count
 * transitions from 0 → 1. Shows an achievement unlock toast.
 * Safe to call unconditionally — it checks the count itself.
 */
export function maybeShowFirstGigToast(journalData) {
    if (!journalData || journalData.length !== 1) return;
    // Small delay so the save toast clears first
    setTimeout(() => {
        window.showToast?.(
            '🏆 Achievement unlocked: The Beginning — you logged your first gig!',
            'success',
            6000
        );
    }, 1800);
}

window.maybeShowFirstGigToast = maybeShowFirstGigToast;
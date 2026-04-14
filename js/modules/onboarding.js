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
 */

import { supabase } from './supabase.js';

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
        const input = document.getElementById('setlistIdInput');
        const hint  = document.getElementById('sync-status');
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
             data-key="${_esc(row.journal_key)}">
            <input type="checkbox" checked
                   id="claim-${_esc(row.journal_key)}"
                   class="mt-1 w-4 h-4 rounded accent-indigo-600 flex-shrink-0 cursor-pointer">
            <label for="claim-${_esc(row.journal_key)}" class="flex-1 min-w-0 cursor-pointer">
                <span class="block text-sm font-black text-slate-900 truncate">${_esc(displayBand)}</span>
                <span class="block text-[10px] text-slate-400 font-bold mt-0.5 truncate">
                    ${_esc(row.date)} · ${_esc(row.official_venue)}
                </span>
                ${subline ? `<span class="block text-[10px] text-indigo-400 font-bold truncate">${_esc(subline)}</span>` : ''}
            </label>
            <span class="text-[9px] font-black text-slate-300 uppercase tracking-widest flex-shrink-0 pt-1 text-right">
                via ${_esc(viaLabel)}
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
    if (!matches?.length) return;

    // Only surface matches that:
    //   (a) the user doesn't already have in their own journal
    //   (b) haven't been explicitly acknowledged/dismissed before
    const newMatches = matches.filter(m =>
        !myKeys.has(m.journal_key) && !acknowledged.has(m.journal_key)
    );

    if (!newMatches.length) return;

    console.log('companion check', {
        username,
        matchCount: matches?.length,
        myKeyCount: myKeys.size,
        acknowledgedCount: acknowledged.size,
        newMatchCount: newMatches?.length,
        matches,
        newMatches
    });

    _renderCompanionTagsBanner(newMatches, currentUser);
    window.track?.('companion_tags_shown', { count: newMatches.length });
}

function _renderCompanionTagsBanner(matches, currentUser) {
    const banner = document.getElementById('companion-tags-banner');
    const list   = document.getElementById('companion-tags-list');
    if (!banner || !list) return;

    list.innerHTML = matches.map(m => `
        <div class="flex items-start justify-between gap-3 py-2 border-b border-slate-100 last:border-0"
             data-journal-key="${_esc(m.journal_key)}">
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-slate-900 truncate">${_esc(m.band)}</p>
                <p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                    ${_esc(m.official_venue)}${m.date ? ' &mdash; ' + _esc(m.date) : ''}
                    &mdash; added by <strong class="text-slate-700">${_esc(m.owner_username)}</strong>
                </p>
            </div>
            <button onclick="window.viewGigDetails('${m.journal_key.replace(/'/g, "\\'")}')"
                    class="flex-shrink-0 bg-slate-900 text-white text-[10px] font-black px-3 py-1.5 rounded-full hover:bg-slate-700 transition-all active:scale-95 uppercase tracking-widest ml-2">
                View
            </button>
        </div>
    `).join('');

    banner.classList.remove('hidden');

    // Store currentUser.id on the banner so the dismiss handler can access it
    // without closing over a stale variable
    banner.dataset.userId = currentUser.id;
}

// Called from vault.html via onclick — must be on window
window.dismissCompanionTagsBanner = async function() {
    const banner = document.getElementById('companion-tags-banner');
    if (!banner) return;

    // Collect all journal keys currently displayed
    const keys = Array.from(
        banner.querySelectorAll('[data-journal-key]')
    ).map(el => el.dataset.journalKey).filter(Boolean);

    banner.classList.add('hidden');
    sessionStorage.setItem('companion_tags_dismissed', '1');
    window.track?.('companion_tags_dismissed');

    // Only acknowledge on explicit dismiss — not on mere display.
    // This means if the tab is closed without dismissing, the banner
    // will reappear next login until the user actively deals with it.
    if (keys.length) {
        const userId = banner.dataset.userId;
        if (userId) await _acknowledgeCompanionTags(userId, keys);
    }
};

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
export function showNoSetlistTip() {
    const hint = document.getElementById('sync-status');
    if (!hint) return;

    hint.innerHTML = `
        No setlist.fm account? Search your email inbox for ticket confirmations
        to find the shows you've been to, then add them manually.<br><br>
        <span class="font-black text-slate-600 not-italic">Try searching:</span><br>
        <code class="block mt-1 bg-slate-100 text-slate-700 font-mono text-[10px] px-2 py-1 rounded-lg leading-relaxed">
            subject:(ticket OR confirmation OR "order confirmed") (gig OR concert OR festival OR live)
        </code>
    `;
    hint.className = 'text-[10px] mt-3 leading-relaxed text-slate-500 not-italic';
    hint.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.showNoSetlistTip = showNoSetlistTip;

/**
 * Called from app.js syncSetlistFm onComplete when journalInserted === 0.
 */
export function handleZeroSyncResult() {
    const hint = document.getElementById('sync-status');
    if (!hint) return;

    hint.innerHTML = `
        ✗ No shows found for that username.<br><br>
        <strong class="not-italic text-slate-600">Wrong username?</strong>
        Check your setlist.fm profile URL — it's the part after
        <code class="font-mono bg-slate-100 px-1 rounded">setlist.fm/user/</code><br><br>
        <strong class="not-italic text-slate-600">No setlist.fm account?</strong>
        Search your email for ticket confirmations to find your shows:
        <code class="block mt-1 bg-slate-100 text-slate-700 font-mono text-[10px] px-2 py-1 rounded-lg leading-relaxed">
            subject:(ticket OR confirmation OR "order confirmed") (gig OR concert OR festival OR live)
        </code>
    `;
    hint.className = 'text-[10px] mt-3 leading-relaxed text-amber-600 not-italic';
}

// ─── HELPER ──────────────────────────────────────────────────────────────────

function _esc(val) {
    if (val == null) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
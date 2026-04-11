/**
 * GigList — Onboarding Module
 * Handles the full new-user onboarding flow triggered by ?new=true:
 *
 * Step 1 — Companion matching: check if other users have tagged this new user
 *           in their went_with field, show a claim panel, write correct journal
 *           rows when claimed.
 * Step 2 — Setlist.fm sync: settings modal opens pre-focused on sync field.
 *           If sync returns 0 results, show the email search tip automatically.
 *
 * Also exports showNoSetlistTip() which is called by the vault.html button
 * "I don't have a setlist.fm account →"
 */

import { supabase } from './supabase.js';

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

/**
 * Called from app.js initApp() when ?new=true and user type is Personal.
 * Runs companion matching first, then opens the settings modal for sync.
 */
export async function runOnboarding(currentUser) {
    // Step 1: companion matching — show claim panel if matches found
    const claimed = await runCompanionMatching(currentUser);

    // Step 2: open settings modal for setlist.fm sync
    // Small delay so the page has settled, slightly longer if claim panel was shown
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

// ─── COMPANION MATCHING ───────────────────────────────────────────────────────

async function runCompanionMatching(currentUser) {
    const username = currentUser.username || currentUser.UserName;
    if (!username) return 0;

    // Find journal rows from other users where went_with contains this username.
    // Uses the SECURITY DEFINER RPC to bypass RLS on other users' rows.
    const { data: matches, error } = await supabase.rpc('get_companion_matches', {
        p_username: username,
    });

    if (error) {
        console.warn('companion matching RPC failed:', error.message);
        return 0;
    }
    if (!matches?.length) return 0;

    // Group matches by the owner (the person who tagged this user)
    const byOwner = new Map();
    for (const row of matches) {
        const key = row.owner_username;
        if (!byOwner.has(key)) byOwner.set(key, []);
        byOwner.get(key).push(row);
    }

    renderClaimPanel(currentUser, byOwner);
    return matches.length;
}

function renderClaimPanel(currentUser, byOwner) {
    // Remove any existing panel
    document.getElementById('companion-claim-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'companion-claim-panel';
    panel.className = 'fixed inset-0 z-[120] bg-slate-900/70 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'claim-panel-title');

    const owners = [...byOwner.entries()];
    const totalShows = [...byOwner.values()].reduce((n, arr) => n + arr.length, 0);

    const showRows = owners.map(([ownerUsername, rows]) => {
        return rows.map(row => {
            const displayBand = row.festival
                ? (row.band || 'Festival')
                : row.band;
            const subline = row.festival && row.festival_lineups
                ? row.festival_lineups.split('/').map(s => s.trim()).slice(0, 3).join(', ') + (row.festival_lineups.split('/').length > 3 ? '…' : '')
                : (row.notable_support ? `Support: ${row.notable_support}` : row.official_venue);

            return `
            <div class="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0"
                 data-key="${_esc(row.journal_key)}"
                 data-owner="${_esc(ownerUsername)}">
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
                <span class="text-[9px] font-black text-slate-300 uppercase tracking-widest flex-shrink-0 pt-1">
                    via ${_esc(ownerUsername)}
                </span>
            </div>`;
        }).join('');
    }).join('');

    panel.innerHTML = `
        <div class="bg-white w-full sm:max-w-lg max-h-[92vh] rounded-t-[2.5rem] sm:rounded-[2.5rem] flex flex-col overflow-hidden shadow-2xl">
            <div class="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
                <div>
                    <h2 id="claim-panel-title" class="text-xl font-black tracking-tight text-slate-900 uppercase italic">
                        You've been spotted!
                    </h2>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
                        ${totalShows} show${totalShows !== 1 ? 's' : ''} other GigList users say you attended
                    </p>
                </div>
            </div>

            <div class="overflow-y-auto flex-grow px-6 py-4">
                <p class="text-xs text-slate-500 font-bold mb-4 leading-relaxed">
                    Tick the shows you actually went to and we'll add them to your archive.
                    You can always edit or remove them later.
                </p>
                <div class="space-y-0">
                    ${showRows}
                </div>
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

    // Store matches data for the claim handler to access
    window._companionMatchData = [...byOwner.values()].flat();
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

    const newUserId  = session.user.id;
    const newUsername = window.currentUser?.username || window.currentUser?.UserName || '';
    const allMatches  = window._companionMatchData || [];

    // Find which checkboxes are ticked
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
        // Build the new user's journal row from the SOURCE row's data.
        // This is the critical fix — we copy band, festival, festival_lineups,
        // notable_support from the owner's row rather than leaving them blank.
        const newRow = {
            user_id:          newUserId,
            journal_key:      row.journal_key,
            date:             row.date,
            band:             row.band,             // correctly "Glastonbury Festival" not "Semisonic"
            official_venue:   row.official_venue,
            venue:            row.official_venue,
            festival:         row.festival ?? false,
            festival_lineups: row.festival_lineups ?? null,
            notable_support:  row.notable_support ?? null,
            went_with:        row.owner_username,   // the person who tagged them is their companion
            comments:         null,
            price:            null,
            photos:           null,
            review_url:       null,
        };

        const { error } = await supabase
            .from('journals')
            .insert(newRow);

        if (error) {
            if (error.code === '23505') {
                // Already exists — skip silently
                inserted++;
            } else {
                console.warn('claim insert failed:', error.message, row.journal_key);
                failed++;
            }
        } else {
            inserted++;

            // Also update the owner's went_with to include the new user's username
            // if it isn't already there, so the link is mutual.
            await _addCompanionToOwnerRow(row, newUsername);
        }
    }

    window._dismissClaimPanel();

    if (inserted > 0) {
        window.showToast?.(`${inserted} show${inserted !== 1 ? 's' : ''} added to your archive!`, 'success', 5000);

        // Reload journal data so the new shows appear
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
}

/**
 * Appends newUsername to the owner's went_with field for the given journal row,
 * if they aren't already listed there.
 */
async function _addCompanionToOwnerRow(row, newUsername) {
    if (!newUsername || !row.owner_user_id) return;

    // Fetch the current went_with value for the owner's row
    const { data: ownerRow } = await supabase
        .from('journals')
        .select('went_with')
        .eq('user_id', row.owner_user_id)
        .eq('journal_key', row.journal_key)
        .single();

    if (!ownerRow) return;

    const existing = (ownerRow.went_with || '').split('/').map(s => s.trim()).filter(Boolean);

    // Already listed — nothing to do
    if (existing.some(n => n.toLowerCase() === newUsername.toLowerCase())) return;

    const updated = [...existing, newUsername].join(' / ');

    await supabase
        .from('journals')
        .update({ went_with: updated })
        .eq('user_id', row.owner_user_id)
        .eq('journal_key', row.journal_key);
}

// ─── SETLIST.FM TIP ───────────────────────────────────────────────────────────

/**
 * Shows the email search tip in the settings modal.
 * Called by the "I don't have a setlist.fm account →" button in vault.html,
 * and automatically by app.js when sync completes with 0 results.
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

    // Scroll the hint into view inside the settings modal
    hint.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Make it available globally for the vault.html inline onclick
window.showNoSetlistTip = showNoSetlistTip;

// ─── LOW SYNC RESULT TIP ─────────────────────────────────────────────────────

/**
 * Called from app.js syncSetlistFm onComplete when journalInserted === 0.
 * Shows the email tip automatically so the user isn't left stranded.
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

// HTML-escape a value for safe injection into innerHTML
function _esc(val) {
    if (val == null) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
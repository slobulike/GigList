/**
 * GigList - Editor Module
 * Handles add/edit gig form, combobox autocomplete, CSV export,
 * and unsaved-changes tracking.
 *
 * Phase 1: writes to window.journalData in memory.
 * Phase 3: swap saveGig() to call supabase.from('journals').upsert() instead.
 */

import { parseDate } from './utils.js';
import { supabase } from './supabase.js';
import {
    groupByShow, buildJournalRow, buildVenueRow,
    upsertVenues, upsertPerformances, upsertJournals,
} from './setlist-sync.js';

const WORKER_URL = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';

// ─── STATE ────────────────────────────────────────────────────────────────────

let isDirty = false;   // true when in-memory data differs from last-loaded CSV
let editingKey = null; // Journal Key of the gig being edited, null for new gig

// ─── DIRTY-STATE TRACKING ────────────────────────────────────────────────────

const setDirty = (dirty) => {
    isDirty = dirty;
    const banner = document.getElementById('unsaved-banner');
    if (banner) banner.classList.toggle('hidden', !dirty);
};

// ─── AUTOCOMPLETE COMBOBOX ───────────────────────────────────────────────────

/**
 * Wires up a combobox: an <input> + a hidden <ul> dropdown.
 * Suggestions come from `getOptions()` which is called lazily so the
 * list is always current (journalData may not be loaded at module init time).
 *
 * Allows free-text entry — if nothing is selected from the list the typed
 * value is used as-is, so new artists/venues can be added.
 */
const wireCombobox = (inputId, listId, getOptions) => {
    const input = document.getElementById(inputId);
    const list  = document.getElementById(listId);
    if (!input || !list) return;

    let activeIndex = -1;

    const show = (items) => {
        list.innerHTML = items.map((item, i) =>
            `<li role="option" aria-selected="false"
                 class="px-4 py-2.5 text-sm font-bold text-slate-800 cursor-pointer hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                 data-value="${item.replace(/"/g, '&quot;')}">${item}</li>`
        ).join('');
        list.classList.toggle('hidden', items.length === 0);
        activeIndex = -1;
    };

    const hide = () => {
        list.classList.add('hidden');
        activeIndex = -1;
    };

    const selectItem = (value) => {
        input.value = value;
        hide();
        input.dispatchEvent(new Event('change'));
    };

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 1) { hide(); return; }

        const matches = getOptions()
            .filter(opt => opt.toLowerCase().includes(q))
            .sort((a, b) => {
                // Exact prefix matches first
                const aStart = a.toLowerCase().startsWith(q);
                const bStart = b.toLowerCase().startsWith(q);
                if (aStart && !bStart) return -1;
                if (!aStart && bStart) return 1;
                return a.localeCompare(b);
            })
            .slice(0, 8);

        show(matches);
    });

    input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('li');
        if (list.classList.contains('hidden') || items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, -1);
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            selectItem(items[activeIndex].dataset.value);
            return;
        } else if (e.key === 'Escape') {
            hide(); return;
        }

        items.forEach((li, i) => {
            const active = i === activeIndex;
            li.classList.toggle('bg-indigo-50', active);
            li.classList.toggle('text-indigo-700', active);
            li.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    });

    list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (li) selectItem(li.dataset.value);
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !list.contains(e.target)) hide();
    });
};

// ─── OPTION GETTERS (lazy — called at input time) ────────────────────────────

const getArtistOptions = () => {
    const data = window.journalData || [];
    return [...new Set(data.map(g => g.Band).filter(Boolean))].sort();
};

const getVenueOptions = () => {
    const lookup = window.venueLookup || {};
    const fromData = (window.journalData || []).map(g => g.OfficialVenue).filter(Boolean);
    return [...new Set([...Object.keys(lookup), ...fromData])].sort();
};

const getSupportOptions = () => getArtistOptions();

// ─── JOURNAL KEY GENERATION ───────────────────────────────────────────────────

// Convert DD/MM/YYYY → YYYY-MM-DD for native date input
const toInputDate = (ddmmyyyy) => {
    if (!ddmmyyyy) return '';
    const parts = ddmmyyyy.split('/');
    if (parts.length !== 3) return '';
    return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
};

// Convert YYYY-MM-DD (native date input) → DD/MM/YYYY (app format)
const fromInputDate = (yyyymmdd) => {
    if (!yyyymmdd) return '';
    const parts = yyyymmdd.split('-');
    if (parts.length !== 3) return '';
    return `${parts[2].padStart(2,'0')}/${parts[1].padStart(2,'0')}/${parts[0]}`;
};

const buildJournalKey = (dateStr, officialVenue) => {
    // Format: DD/MM/YYYYOfficialVenue  e.g. "27/08/1999Little John's Farm"
    return `${dateStr}${officialVenue}`;
};

// ─── OPEN MODAL ───────────────────────────────────────────────────────────────

export const openAddGigModal = () => {
    editingKey = null;
    renderEditorModal({});
};

export const openEditGigModal = (key) => {
    const entry = (window.journalData || []).find(
        g => (g['Journal Key'] || '').toString().trim() === key?.toString().trim()
    );
    if (!entry) { console.error('Editor: entry not found for key', key); return; }
    editingKey = key;
    renderEditorModal(entry);
};

// ─── RENDER THE MODAL ────────────────────────────────────────────────────────

const renderEditorModal = (entry) => {
    const modal = document.getElementById('editor-modal');
    if (!modal) { console.error('Editor: #editor-modal not found in DOM'); return; }

    const isEdit  = !!editingKey;
    const isBandWrite = window.isBandMode && window.currentUser?.is_admin;
    const context = isBandWrite ? ` · ${window.currentArtist || 'Band'} Archive` : '';
    const title   = (isEdit ? 'Edit Show' : 'Add Show') + context;
    const festVal = (entry['Festival?'] || entry['Festival? Y/N'] || 'N').toString().trim().toUpperCase();
    const isFest  = festVal === 'Y';

    document.getElementById('editor-modal-title').textContent = title;

    // Show delete button only when editing an existing show
    const deleteBtn = document.getElementById('btn-delete-show');
    if (deleteBtn) deleteBtn.classList.toggle('hidden', !isEdit);

    // Populate fields
    _val('editor-date',       toInputDate(entry.Date || ''));
    _val('editor-band',       entry.Band       || '');
    _val('editor-venue',      entry.OfficialVenue || '');
    _val('editor-went-with',  entry['Went With'] || '');
    _val('editor-support',    entry['Notable Support'] || '');
    _val('editor-lineups',    entry['Festival Lineups'] || '');
    _val('editor-comments',   entry.Comments   || '');
    _val('editor-price',      entry.Price      || '');
    _val('editor-photos',     entry.Photos     || '');
    _val('editor-review',     entry['Review URL'] || entry.review_url || '');
    _check('editor-festival', isFest);

    toggleFestivalFields(isFest);

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.getElementById('editor-date')?.focus();

    if (window.lucide) lucide.createIcons();
};

// ─── CLOSE ────────────────────────────────────────────────────────────────────

export const closeEditorModal = () => {
    const modal = document.getElementById('editor-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'auto';
};

window.closeEditorModal = closeEditorModal;

// ─── FESTIVAL FIELD TOGGLE ────────────────────────────────────────────────────

const toggleFestivalFields = (show) => {
    const section = document.getElementById('editor-festival-section');
    if (section) section.classList.toggle('hidden', !show);
};

window.editorToggleFestival = () => {
    const checked = document.getElementById('editor-festival')?.checked;
    toggleFestivalFields(checked);
};

// ─── SETLIST.FM LOOKUP (new shows only) ───────────────────────────────────────

/**
 * Search setlist.fm for an artist by name and return the best MBID match.
 */
async function lookupMbid(artistName) {
    const url = `${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(artistName)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const artists = data?.artist || [];
    return artists[0]?.mbid || null;
}

/**
 * Fetch the setlist for a specific MBID + date using the find-show endpoint,
 * which passes `date=DD-MM-YYYY` to setlist.fm's search/setlists API.
 * Returns the first matching setlist object, or null if not found.
 *
 * dateUK is DD/MM/YYYY (GigList format) — converted to DD-MM-YYYY for the API.
 */
async function lookupSetlistsByDate(mbid, dateUK) {
    const fmDate = dateUK.replace(/\//g, '-'); // DD/MM/YYYY → DD-MM-YYYY

    const url = `${WORKER_URL}/?endpoint=find-show&mbid=${encodeURIComponent(mbid)}&eventDate=${fmDate}`;
    const res = await fetch(url);

    if (res.status === 404) return null; // no show found for this date — expected
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) return null;

    const data = await res.json();
    return (data.setlist || [])[0] || null;
}

/**
 * Returns an array of Date objects for the start date plus the next
 * (windowDays - 1) days, to cover multi-day festivals where the journal
 * entry only records the first day.
 */
function festivalDateWindow(dateStr, windowDays = 3) {
    const [d, m, y] = dateStr.split('/').map(Number);
    const base = new Date(y, m - 1, d);
    const dates = [];
    for (let i = 0; i < windowDays; i++) {
        const dt = new Date(base);
        dt.setDate(base.getDate() + i);
        const dd = String(dt.getDate()).padStart(2, '0');
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const yyyy = dt.getFullYear();
        dates.push(`${dd}/${mm}/${yyyy}`);
    }
    return dates;
}

/**
 * For a festival show: parse the lineup string, look up each band on
 * setlist.fm using the date-filtered find-show endpoint, and return all
 * setlist objects found.
 *
 * Because the journal entry only records the festival start date, we check
 * a 3-day window for each band (start date + 2 following days) and take the
 * first match. This handles multi-day festivals where different acts play on
 * different days.
 *
 * Returns an array of raw setlist objects, one per band that was found.
 */
async function lookupFestivalSetlists(lineupStr, dateStr) {
    const bands = lineupStr
        .split('/')
        .map(b => b.trim())
        .filter(Boolean);

    const dateWindow = festivalDateWindow(dateStr, 3);
    const allMatches = [];

    for (const bandName of bands) {
        try {
            const mbid = await lookupMbid(bandName);
            if (!mbid) continue;

            // Polite delay between MBID lookup and first setlist fetch
            await new Promise(r => setTimeout(r, 1100));

            // Try each date in the window until we find a match
            let match = null;
            for (const tryDate of dateWindow) {
                match = await lookupSetlistsByDate(mbid, tryDate);
                if (match) break;
                // Polite delay between date attempts
                await new Promise(r => setTimeout(r, 1100));
            }

            if (match) allMatches.push(match);
        } catch (e) {
            console.warn(`Festival setlist lookup failed for ${bandName}:`, e.message);
        }
        // Polite delay between bands
        await new Promise(r => setTimeout(r, 1100));
    }

    return allMatches;
}

/**
 * Renders the setlist.fm confirmation panel inside the editor modal.
 * Resolves with the chosen setlist object, or null if the user skips.
 */
function showSetlistConfirmation(setlists) {
    return new Promise((resolve) => {
        document.getElementById('setlist-confirm-panel')?.remove();

        const panel = document.createElement('div');
        panel.id = 'setlist-confirm-panel';
        panel.className = 'mx-0 mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4';

        const rows = setlists.map((sl, i) => {
            const venueName = sl.venue?.name || 'Unknown Venue';
            const city      = sl.venue?.city?.name || '';
            const country   = sl.venue?.city?.country?.name || '';
            const location  = [city, country].filter(Boolean).join(', ');
            const dateUK    = sl.eventDate.replace(/-/g, '/');
            return `
                <div class="flex items-center justify-between gap-3 py-2 ${i < setlists.length - 1 ? 'border-b border-indigo-100' : ''}">
                    <div class="min-w-0">
                        <div class="text-sm font-bold text-slate-800 truncate">${venueName}</div>
                        <div class="text-xs text-slate-500">${location} · ${dateUK}</div>
                    </div>
                    <button
                        class="flex-shrink-0 rounded-xl bg-indigo-600 px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-white hover:bg-indigo-700 transition-colors"
                        data-idx="${i}">
                        This one ✓
                    </button>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="mb-2 text-xs font-black uppercase tracking-widest text-indigo-600">
                Found on setlist.fm — is this your show?
            </div>
            ${rows}
            <button id="setlist-confirm-none"
                class="mt-3 w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50 transition-colors">
                None of these — save without setlist data
            </button>`;

        // Insert just above the error div so it sits inside the modal form area
        const errorEl = document.getElementById('editor-error');
        if (errorEl) {
            errorEl.parentNode.insertBefore(panel, errorEl);
        } else {
            document.getElementById('editor-modal')?.appendChild(panel);
        }

        panel.querySelectorAll('button[data-idx]').forEach(btn => {
            btn.addEventListener('click', () => {
                panel.remove();
                resolve(setlists[parseInt(btn.dataset.idx)]);
            });
        });
        document.getElementById('setlist-confirm-none').addEventListener('click', () => {
            panel.remove();
            resolve(null);
        });
    });
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────

window.saveGig = async () => {
    // Helper to get values
    const _get = (id) => document.getElementById(id)?.value || '';

    const dateStr = fromInputDate(_get('editor-date').trim());
    const band = _get('editor-band').trim();
    const venue = _get('editor-venue').trim();

    // 1. Validation
    if (!dateStr || !band || !venue) {
        _showError('Date, Artist and Venue are required.');
        return;
    }

    const journalKey = buildJournalKey(dateStr, venue);
    const isFest = document.getElementById('editor-festival')?.checked ? 'Y' : 'N';
    const [d, m, y] = dateStr.split('/');

    // 2. Auth Check
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        _showError('You must be signed in to save.');
        return;
    }

    const isBandWrite = window.isBandMode && window.currentUser?.is_admin;
    const writeUserId = isBandWrite ? null : session.user.id;

    const supabaseRow = {
        user_id: writeUserId,
        journal_key: journalKey,
        date: dateStr,
        band: isBandWrite ? (window.currentArtist || band) : band,
        official_venue: venue,
        venue: venue,
        festival: isFest === 'Y',
        festival_lineups: _get('editor-lineups').trim(),
        notable_support: _get('editor-support').trim(),
        went_with: _get('editor-went-with').trim(),
        comments: isBandWrite ? 'Historical Artist Entry' : _get('editor-comments').trim(),
        price: _get('editor-price').trim(),
        photos: _get('editor-photos').trim(),
        review_url: _get('editor-review').trim(),
    };

    try {
        console.log("Saving to Supabase...");

        // 3. Save Journal Entry (Upsert handles both New and Edit)
        const { error: dbError } = await supabase
            .from('journals')
            .upsert(supabaseRow, { onConflict: 'journal_key, user_id' });

        if (dbError) throw dbError;

        // 4. Trigger Setlist Lookup (personal users only, not band archive writes)
        if (!isBandWrite) {
            const saveBtn = document.querySelector('#editor-modal button[onclick="saveGig()"]');
            const origLabel = saveBtn?.textContent;

            try {
                if (isFest === 'Y') {
                    // ── Festival path ──────────────────────────────────────────
                    const lineups = _get('editor-lineups').trim();
                    if (lineups) {
                        if (saveBtn) saveBtn.textContent = 'Searching Lineup...';
                        const matches = await lookupFestivalSetlists(lineups, dateStr);
                        if (matches.length > 0) {
                            const grouped = groupByShow(matches);
                            const perfRows = [];
                            const venueRows = [];
                            for (const show of grouped.values()) {
                                // Each band's setlist may have its own eventDate (different
                                // day of a multi-day festival). Rewrite the journal_key on
                                // every performance row to match the festival journal entry,
                                // which is keyed to the start date + venue the user entered.
                                // Without this, performances are orphaned under band-specific
                                // keys that no journal row points to.
                                const fixedPerfs = show.performances.map(p => ({
                                    ...p,
                                    journal_key:    journalKey,
                                    official_venue: venue,
                                }));
                                perfRows.push(...fixedPerfs);
                                venueRows.push(buildVenueRow(show.venueRaw));
                            }
                            await Promise.all([upsertVenues(venueRows), upsertPerformances(perfRows)]);
                        }
                    }
                } else {
                    // ── Single artist path ─────────────────────────────────────
                    if (saveBtn) saveBtn.textContent = 'Searching setlist.fm...';

                    try {
                        // Step 1: Get MBID
                        const searchUrl = `${WORKER_URL}/?endpoint=artist-search&name=${encodeURIComponent(band)}`;
                        const artistRes = await fetch(searchUrl);
                        const artistData = await artistRes.json();
                        const mbid = artistData.artist?.[0]?.mbid;

                        if (!mbid) {
                            // No MBID found — queue for admin review, but don't
                            // return early; fall through to UI update below.
                            await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                        } else {
                            // Step 2: Polite delay before second API call
                            console.log("MBID found. Waiting for API cooldown...");
                            await new Promise(resolve => setTimeout(resolve, 1100));

                            // Step 3: Date-filtered setlist lookup via find-show
                            // workerDate is DD-MM-YYYY — the format find-show passes
                            // to setlist.fm's `date` parameter.
                            const workerDate = dateStr.replace(/\//g, '-');
                            const setlistUrl = `${WORKER_URL}/?endpoint=find-show&mbid=${mbid}&eventDate=${workerDate}`;
                            const setlistRes = await fetch(setlistUrl);

                            if (setlistRes.status === 429) {
                                throw new Error("Setlist.fm rate limit reached. Please wait a moment and try again.");
                            }

                            if (setlistRes.status === 404) {
                                // setlist.fm has no record of this show — queue for review
                                await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                            } else if (setlistRes.ok) {
                                const data = await setlistRes.json();
                                // find-show returns results filtered by date so just take [0]
                                const matchingSetlist = (data.setlist || [])[0];

                                if (matchingSetlist) {
                                    const grouped = groupByShow([matchingSetlist]);
                                    const perfRows = [];
                                    const venueRows = [];
                                    for (const show of grouped.values()) {
                                        perfRows.push(...show.performances);
                                        venueRows.push(buildVenueRow(show.venueRaw));
                                    }
                                    await Promise.all([upsertVenues(venueRows), upsertPerformances(perfRows)]);
                                } else {
                                    await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Setlist lookup failed:", err);
                        window.showToast?.(err.message, 'error');
                    }
                }
            } catch (lookupErr) {
                console.warn('Setlist lookup background process failed:', lookupErr);
            } finally {
                if (saveBtn) saveBtn.textContent = origLabel;
            }
        }

        // 5. Update Local State and UI
        if (window.refreshData) {
            await window.refreshData();
        } else {
            // Manual local update if refreshData isn't available
            const gigRow = { ...supabaseRow, 'Journal Key': journalKey, 'Band': band, 'Date': dateStr };
            if (editingKey) {
                const idx = window.journalData.findIndex(g => g['Journal Key'] === editingKey);
                if (idx !== -1) window.journalData[idx] = gigRow;
            } else {
                window.journalData.push(gigRow);
            }
        }

        closeEditorModal();
        if (window.showToast) window.showToast('Show Saved ✓', 'success');
        if (window.refreshUI) window.refreshUI();

    } catch (err) {
        console.error('Final Save Error:', err);
        _showError(err.message || 'Could not save show.');
    }
};

// ─── PENDING VENUE SUBMIT ─────────────────────────────────────────────────────

/**
 * Inserts a row into pending_venues when a new show's venue couldn't be
 * matched or confirmed via setlist.fm. Best-effort — never blocks the save.
 */
async function _submitPendingVenue({ session, journalKey, band, dateStr, venue }) {
    try {
        const { error } = await supabase.from('pending_venues').insert({
            submitted_by: session.user.id,
            journal_key:  journalKey,
            venue_name:   venue,
            band:         band,
            date:         dateStr,
            status:       'pending',
        });
        if (error) console.warn('pending_venues insert failed:', error.message);
    } catch (e) {
        console.warn('pending_venues insert error:', e.message);
    }
}

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

/**
 * Downloads window.journalData as a CSV matching the canonical Phil-format schema.
 * Column order matches journal_phil.csv exactly so the file is a drop-in replacement.
 *
 * Phase 3 note: replace this with supabase.from('journals').select('*').csv()
 */
export const exportCSV = () => {
    const data = window.journalData;
    if (!data || data.length === 0) {
        if (window.showToast) window.showToast('No data to export.', 'warning');
        else alert('No data to export.');
        return;
    }

    const columns = [
        'Date', 'Band', 'Notable Support', 'Venue', 'Price',
        'Comments', 'Went With', 'Festival?', 'Festival Lineups',
        'Photos', 'Review URL', 'Journal Key', 'OfficialVenue', 'Year', 'Month', 'Day'
    ];

    const escape = (val) => {
        if (val === null || val === undefined) return '';
        const str = val.toString();
        // Wrap in quotes if value contains comma, newline, or double-quote
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const rows = [
        columns.join(','),
        ...data.map(g => columns.map(col => escape(g[col] ?? '')).join(','))
    ];

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;

    // Filename includes today's date so you always know which version you downloaded
    const today = new Date().toISOString().slice(0, 10);
    const user  = window.currentUser;
    const name  = user?.username || user?.UserName || user?.JournalFile?.replace('.csv', '') || 'journal';
    a.download  = `journal_${name.toLowerCase()}_${today}.csv`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Once exported the in-memory state matches the file — mark clean
    setDirty(false);
};

window.exportCSV      = exportCSV;

// ─── DELETE GIG ───────────────────────────────────────────────────────────────

window.deleteGig = async () => {
    if (!editingKey) return;

    // Toast-based confirmation
    const confirmed = await new Promise(resolve => {
        const container = document.getElementById('toast-container');
        if (!container) { resolve(window.confirm('Remove this show permanently?')); return; }
        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'del-yes-' + Date.now();
        const noId  = 'del-no-'  + Date.now();
        toast.innerHTML =
            '<span class="flex-1">Remove this show permanently?</span>' +
            '<button id="' + yesId + '" class="bg-red-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-colors">Remove</button>' +
            '<button id="' + noId  + '" class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">Cancel</button>';
        container.appendChild(toast);
        document.getElementById(yesId).onclick = () => { toast.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { toast.remove(); resolve(false); };
    });

    if (!confirmed) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const isBandWrite = window.isBandMode && window.currentUser?.is_admin;

    let dbError;
    if (isBandWrite) {
        const { error } = await supabase
            .from('journals')
            .delete()
            .is('user_id', null)
            .eq('journal_key', editingKey);
        dbError = error;
    } else {
        const { error } = await supabase
            .from('journals')
            .delete()
            .eq('user_id', session.user.id)
            .eq('journal_key', editingKey);
        dbError = error;
    }

    if (dbError) {
        if (window.showToast) window.showToast('Delete failed: ' + dbError.message, 'error');
        return;
    }

    // Remove from in-memory data
    window.journalData = (window.journalData || []).filter(
        g => g['Journal Key'] !== editingKey
    );

    closeEditorModal();
    if (window.closeModal) window.closeModal(); // also close the gig detail modal behind it
    if (window.showToast) window.showToast('Show removed', 'info');
    if (window.refreshUI) window.refreshUI();
};
window.openAddGigModal  = openAddGigModal;
window.openEditGigModal = openEditGigModal;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const _val   = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
const _get   = (id)        => document.getElementById(id)?.value || '';
const _check = (id, bool)  => { const el = document.getElementById(id); if (el) el.checked = bool; };

const _showError = (msg) => {
    const el = document.getElementById('editor-error');
    if (el) {
        el.textContent = msg;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 4000);
    } else if (window.showToast) {
        window.showToast(msg, 'error');
    }
};

// ─── INIT (wire comboboxes once DOM is ready) ─────────────────────────────────

export const initEditor = () => {
    wireCombobox('editor-band',    'editor-band-list',    getArtistOptions);
    wireCombobox('editor-venue',   'editor-venue-list',   getVenueOptions);
    wireCombobox('editor-support', 'editor-support-list', getSupportOptions);
};

// ─── FESTIVAL PREFILL MODAL ───────────────────────────────────────────────────

/**
 * Opens the editor modal for each "did see" band in sequence.
 * After saving (or skipping), advances to the next band automatically.
 *
 * @param {{ date: string, venue: string, festival: string, bands: string[] }} prefill
 */
export const openFestivalPrefillModal = ({ date, venue, festival, bands }) => {
    if (!bands || bands.length === 0) return;

    editingKey = null;
    renderEditorModal({
        Date:               date,
        Band:               festival,
        OfficialVenue:      venue,
        'Festival?':        'Y',
        'Festival Lineups': bands.join(' / '),
        'Notable Support':  '',
        'Went With':        '',
        Comments:           '',
        Price:              '',
        Photos:             '',
        'Review URL':       '',
    });

    const title = document.getElementById('editor-modal-title');
    if (title) title.textContent = `Add Show · ${festival} (${bands.length} acts)`;
};

// Expose on window so app.js can call it
window.openFestivalPrefillModal = openFestivalPrefillModal;
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
import { enrichNewArtist } from './artist-enrichment.js';
import { acknowledgeCompanionTag, clearCompanionTagFromBanner } from './onboarding.js';

const WORKER_URL = 'https://setlistfm-proxy.richard-lipscombe.workers.dev';

// ─── STATE ────────────────────────────────────────────────────────────────────

let isDirty = false;   // true when in-memory data differs from last-loaded CSV
let editingKey = null; // Journal Key of the gig being edited, null for new gig
// Companion selector state — array of { name, userId, status, avatarUrl }
let _companions = [];
// Set only by openCompanionPrefillModal — the journal_key of the ORIGINAL
// (tagger's) show that this modal was opened from. If the user goes on to
// save, that companion tag is acknowledged so it stops reappearing in the
// "You Were There Too" banner. Reset on every modal open/close so it never
// leaks into an unrelated add/edit flow.
let _pendingCompanionAckKey = null;

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
export const wireCombobox = (inputId, listId, getOptions) => {
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

let artistCache = null;
export const invalidateArtistCache = () => { artistCache = null; };

export const loadArtistOptions = async () => {
    if (artistCache) return artistCache;
    const { data, error } = await supabase
        .from('artists')
        .select('name')
        .order('name');
    if (error) {
        console.error('Failed to load artists:', error);
        // Fall back to journal data if query fails
        return [...new Set((window.journalData || []).map(g => g.Band).filter(Boolean))].sort();
    }
    artistCache = data.map(a => a.name);
    return artistCache;
};

export const getArtistOptions = () => artistCache ||
    [...new Set((window.journalData || []).map(g => g.Band).filter(Boolean))].sort();

let venueCache = null;
let venueLoadInFlight = false;
export const invalidateVenueCache = () => { venueCache = null; };

const loadVenueOptions = async () => {
    if (venueCache) return venueCache;
    const { data, error } = await supabase
        .from('venues')
        .select('official_name')
        .order('official_name');
    if (error) {
        console.error('Failed to load venues:', error);
        // Fall back to journal data if query fails
        const lookup = window.venueLookup || {};
        const fromData = (window.journalData || []).map(g => g.OfficialVenue).filter(Boolean);
        return [...new Set([...Object.keys(lookup), ...fromData])].sort();
    }
    venueCache = data.map(v => v.official_name).filter(Boolean);
    return venueCache;
};

const getVenueOptions = () => {
    if (venueCache) return venueCache;
    // Cache cold — fire a single background fetch (guard prevents re-entrancy),
    // then re-trigger the input event so the dropdown refreshes with full data.
    if (!venueLoadInFlight) {
        venueLoadInFlight = true;
        loadVenueOptions().then(() => {
            venueLoadInFlight = false;
            const input = document.getElementById('editor-venue');
            if (input && input.value.trim().length >= 1) {
                input.dispatchEvent(new Event('input'));
            }
        });
    }
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

// ─── FESTIVAL LINEUP POOL ─────────────────────────────────────────────────────
// `performances` is a SHARED pool keyed only by journal_key — many users
// logging the same festival on the same date+venue key contribute to (and
// benefit from) the same pool of already-resolved bands. This section lets
// the editor show that pool as a tick-list instead of making every user
// retype every band name (which both duplicates setlist.fm lookups and risks
// naming drift — e.g. one user typing "Beauty School" for a band setlist.fm
// resolves as "Beauty School Dropout" — that the display-side match in
// ui.js's openGigModal then silently fails to reconcile).
//
// NOTE: normalizeArtist/artistNamesMatch are duplicated in ui.js's
// openGigModal for the same reason. Worth promoting both to utils.js if we
// ever consolidate — not done here since utils.js wasn't in scope for this change.

const normalizeArtist = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/** Loose match: exact, or one name is a prefix of the other (handles cases
 *  like "Beauty School" vs setlist.fm's "Beauty School Dropout"). */
const artistNamesMatch = (a, b) => {
    const na = normalizeArtist(a), nb = normalizeArtist(b);
    if (!na || !nb) return false;
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
};

/**
 * Fetches the distinct set of artists already logged in `performances`
 * for a given journal_key — i.e. everyone's contributions to this festival's
 * pool so far, regardless of who added them.
 */
async function fetchLineupPool(journalKey) {
    if (!journalKey) return [];
    const { data, error } = await supabase
        .from('performances')
        .select('artist')
        .eq('journal_key', journalKey);
    if (error) {
        console.error('Failed to load festival lineup pool:', error.message);
        return [];
    }
    // Dedupe case-insensitively, keeping the first-seen casing as canonical.
    const seen = new Map();
    for (const row of data || []) {
        const name = (row.artist || '').trim();
        if (!name) continue;
        const key = normalizeArtist(name);
        if (!seen.has(key)) seen.set(key, name);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const _currentJournalKeyFromForm = () => {
    const dateStr = fromInputDate(document.getElementById('editor-date')?.value || '');
    const venue = document.getElementById('editor-venue')?.value.trim() || '';
    return (dateStr && venue) ? buildJournalKey(dateStr, venue) : null;
};

/** Renders the tick-list. Checkbox state lives purely in the DOM from here
 *  on — saveGig() and _getLineupSelections() read it directly, no separate
 *  tracked state to keep in sync. */
function _renderLineupPool(poolNames, checkedKeys) {
    const container = document.getElementById('editor-lineup-pool');
    if (!container) return;

    if (poolNames.length === 0) {
        container.innerHTML = `<p class="text-[11px] text-slate-400 italic px-1">No bands logged yet for this festival — add them below.</p>`;
        return;
    }

    container.innerHTML = poolNames.map(name => {
        const id = `lineup-pool-${name.replace(/[^a-z0-9]/gi, '_')}`;
        const checked = checkedKeys.has(normalizeArtist(name));
        return `
            <label for="${id}"
                   class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-700 cursor-pointer hover:bg-indigo-50 hover:border-indigo-200 transition-colors">
                <input type="checkbox" id="${id}" data-artist="${name.replace(/"/g, '&quot;')}"
                       class="lineup-pool-checkbox w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                       ${checked ? 'checked' : ''}>
                ${name}
            </label>`;
    }).join('');
}

/**
 * Re-fetches the pool for the current date+venue, seeds checkbox state from
 * whatever's currently in the free-text textarea (covers opening an existing
 * festival entry, or a user who typed a name that's since been added to the
 * pool by someone else), then strips matched names out of the textarea so it
 * only ever shows genuinely new, unresolved names.
 */
async function refreshLineupPool() {
    const poolContainer = document.getElementById('editor-lineup-pool');
    const textarea = document.getElementById('editor-lineups');
    if (!poolContainer || !textarea) return;

    const journalKey = _currentJournalKeyFromForm();
    if (!journalKey) {
        poolContainer.innerHTML = `<p class="text-[11px] text-slate-400 italic px-1">Enter a date and venue first.</p>`;
        return;
    }

    poolContainer.innerHTML = `<p class="text-[11px] text-slate-400 italic px-1">Loading known lineup…</p>`;
    const pool = await fetchLineupPool(journalKey);

    const currentNames = textarea.value.split('/').map(s => s.trim()).filter(Boolean);
    const checkedKeys = new Set();
    const leftoverNames = [];
    for (const name of currentNames) {
        const poolMatch = pool.find(p => artistNamesMatch(p, name));
        if (poolMatch) checkedKeys.add(normalizeArtist(poolMatch));
        else leftoverNames.push(name);
    }
    textarea.value = leftoverNames.join(' / ');

    _renderLineupPool(pool, checkedKeys);
}

/**
 * Reads the final lineup selection directly from the DOM at save time.
 * `newNames` (typed extras not matched to any ticked pool item) is the
 * subset that actually needs a fresh setlist.fm lookup — ticked pool items
 * already have performances rows for this journal_key.
 */
function _getLineupSelections() {
    const poolChecked = [...document.querySelectorAll('#editor-lineup-pool .lineup-pool-checkbox:checked')]
        .map(cb => cb.dataset.artist);
    const extra = (document.getElementById('editor-lineups')?.value || '')
        .split('/').map(s => s.trim()).filter(Boolean);
    const newNames = extra.filter(name => !poolChecked.some(p => artistNamesMatch(p, name)));
    return { fullLineup: [...poolChecked, ...newNames], newNames };
}

// ─── OPEN MODAL ───────────────────────────────────────────────────────────────

export const openAddGigModal = () => {
    editingKey = null;
    renderEditorModal({});
};

export const openEditGigModal = (key) => {
    // In band mode, only admins may edit — non-admin viewers should never
    // reach this path (the edit button should be hidden), but guard here too.
    if (window.isBandMode && !window.currentUser?.is_admin) return;

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

    // Only openCompanionPrefillModal sets this, and it does so AFTER this
    // call — resetting here guarantees every other entry point starts clean.
    _pendingCompanionAckKey = null;

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
// Companions loaded async after modal opens — see _loadCompanionsForModal
    _companions = [];
    _renderCompanionPills();
    setTimeout(() => _loadCompanionsForModal(entry), 0);
    _val('editor-support',    entry['Notable Support'] || '');
    _val('editor-lineups',    entry['Festival Lineups'] || '');
    _val('editor-comments',   entry.Comments   || '');
    _val('editor-price',      entry.Price      || '');
    _val('editor-photos',     entry.Photos     || '');
    _val('editor-review',     entry['Review URL'] || entry.review_url || '');
    _check('editor-festival', isFest);

    toggleFestivalFields(isFest);
    if (isFest) refreshLineupPool();

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const scrollY = window.scrollY;
    document.body.classList.add('modal-open');
    document.body.dataset.scrollY = scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
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
    const scrollY = parseInt(document.body.dataset.scrollY || '0');
    document.body.classList.remove('modal-open');
    editingKey = null;
    _pendingCompanionAckKey = null;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, scrollY);
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
    if (checked) refreshLineupPool();
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

// ── Prevent double-submission ─────────────────────────────────────────────────
const saveBtn = document.querySelector('#editor-modal button[onclick="saveGig()"]');
if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
}
window.showSpinner?.('Saving show…');

    const journalKey = buildJournalKey(dateStr, venue);
    const isFest = document.getElementById('editor-festival')?.checked ? 'Y' : 'N';
    const [d, m, y] = dateStr.split('/');

    // Combine ticked pool selections with any genuinely new free-text names.
    // `newNames` is what still needs a setlist.fm lookup below — anything
    // ticked from the pool already has performances rows for this journal_key.
    const { fullLineup, newNames } = isFest === 'Y'
        ? _getLineupSelections()
        : { fullLineup: [], newNames: [] };

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
        festival_lineups: fullLineup.join(' / '),
        notable_support: _get('editor-support').trim(),
        went_with: _companions.map(c => c.name).join(' / '),
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

        // Ensure artist exists and fetch their id for the journal FK
        let artistId = null;
        const { data: existingArtist } = await supabase
            .from('artists')
            .select('id')
            .eq('name', band)
            .maybeSingle();

        if (existingArtist) {
            artistId = existingArtist.id;
        } else {
            const { data: newArtist } = await supabase
                .from('artists')
                .insert({ name: band })
                .select('id')
                .single();
            if (newArtist) artistId = newArtist.id;
            invalidateArtistCache();
        }

        // Patch artist_id onto the journal row now we have it
        if (artistId) {
            await supabase
                .from('journals')
                .update({ artist_id: artistId })
                .eq('journal_key', journalKey)
                .eq('user_id', writeUserId ?? session.user.id);
        }

        // 4a. Save companions to gig_companions
        if (!isBandWrite && _companions.length > 0) {
            // Re-fetch the journal row to get its id
            const { data: journalRow } = await supabase
                .from('journals')
                .select('id')
                .eq('journal_key', journalKey)
                .eq('user_id', session.user.id)
                .single();

            if (journalRow?.id) {
                await _saveCompanions(journalRow.id, session.user.id);
            }
        }

        // 4b. If this save originated from a companion-tag "View" action,
        // mark that tag resolved now — the user has actively saved their
        // own entry for it, which is the real signal, not just closing
        // a banner. Runs regardless of whether the venue/date text was
        // edited from the original.
        if (_pendingCompanionAckKey) {
            try {
                await acknowledgeCompanionTag(session.user.id, _pendingCompanionAckKey);
                clearCompanionTagFromBanner(_pendingCompanionAckKey);
            } catch (err) {
                console.warn('companion tag acknowledge failed:', err.message);
            }
            _pendingCompanionAckKey = null;
        }

        // 4. Trigger Setlist Lookup (personal users only, not band archive writes)
        if (!isBandWrite) {
            const origLabel = 'Save'; // button already relabelled above

            try {
                if (isFest === 'Y') {
                    // ── Festival path ──────────────────────────────────────────
                    // Only the names NOT ticked from the pool need a fresh
                    // setlist.fm lookup — ticked ones already have performances
                    // rows for this journal_key, so re-searching them would
                    // just waste API calls (and rate-limit budget) for nothing.
                    if (newNames.length > 0) {
                        if (saveBtn) saveBtn.textContent = 'Searching Lineup...';
                        const matches = await lookupFestivalSetlists(newNames.join(' / '), dateStr);
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
                        // Enrichment (mbid + Spotify) always fires on artist creation —
                        // it's basic artist metadata, not a setlist, so it doesn't
                        // depend on whether this particular show is past or future.
                        const mbid = await enrichNewArtist(band);

                        // Future shows will never exist on setlist.fm yet — skip the
                        // setlist lookup entirely. The venue was confirmed by the user
                        // at entry time so no pending review is needed either.
                        const showDate = new Date(y, m - 1, d);
                        if (showDate > new Date()) {
                            console.log('Future show — skipping setlist.fm lookup.');
                        } else {
                            // Check once whether this venue is already in our venues table.
                            // If it is, the user picked it from the dropdown and it needs no
                            // admin review — skip all pending_venues inserts regardless of
                            // what setlist.fm says.
                            const { data: knownVenue } = await supabase
                                .from('venues')
                                .select('id')
                                .ilike('name', venue)
                                .maybeSingle();
                            const venueIsKnown = !!knownVenue;

                            if (!mbid) {
                                // No MBID found — queue for admin review if venue is unknown
                                if (!venueIsKnown) await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                            } else {
                                // Polite delay before second API call
                                console.log("MBID found. Waiting for API cooldown...");
                                await new Promise(resolve => setTimeout(resolve, 1100));

                                // Date-filtered setlist lookup via find-show
                                const workerDate = dateStr.replace(/\//g, '-');
                                const setlistUrl = `${WORKER_URL}/?endpoint=find-show&mbid=${mbid}&eventDate=${workerDate}`;
                                const setlistRes = await fetch(setlistUrl);

                                if (setlistRes.status === 429) {
                                    throw new Error("Setlist.fm rate limit reached. Please wait a moment and try again.");
                                }

                                if (setlistRes.status === 404) {
                                    if (!venueIsKnown) await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                                } else if (setlistRes.ok) {
                                    const data = await setlistRes.json();
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
                                        if (!venueIsKnown) await _submitPendingVenue({ session, journalKey, band, dateStr, venue });
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error('Final Save Error:', err);
                        _showError(err.message || 'Could not save show.');
                    } finally {
                        window.hideSpinner?.();
                        if (saveBtn) {
                            saveBtn.disabled = false;
                            saveBtn.textContent = 'Save';
                        }
                    }
                }
            } catch (lookupErr) {
                console.warn('Setlist lookup background process failed:', lookupErr);

            }
        }

       // 5. Update local journalData in memory with CSV-format keys
       const gigRow = {
           'Journal Key':      journalKey,
           'Date':             dateStr,
           'Band':             supabaseRow.band,
           'OfficialVenue':    supabaseRow.official_venue,
           'Venue':            supabaseRow.venue,
           'Went With':        supabaseRow.went_with,
           'Notable Support':  supabaseRow.notable_support,
           'Festival?':        isFest,
           'Festival Lineups': supabaseRow.festival_lineups,
           'Comments':         supabaseRow.comments,
           'Price':            supabaseRow.price,
           'Photos':           supabaseRow.photos,
           'Review URL':       supabaseRow.review_url,
           // Enrichment fields normally set by loadAppData
           safeKey:            journalKey.replace(/'/g, "\\'").replace(/"/g, "&quot;"),
           type:               'past',
           // Snake_case mirrors
           journal_key:        journalKey,
           official_venue:     supabaseRow.official_venue,
           band:               supabaseRow.band,
           date:               dateStr,
       };

       if (editingKey) {
           const idx = (window.journalData || []).findIndex(g =>
               (g['Journal Key'] || '').toString().trim() === editingKey.toString().trim()
           );
           if (idx !== -1) {
               window.journalData[idx] = gigRow;
           } else {
               // Key changed (venue/date edited) — remove old, add new
               window.journalData = (window.journalData || []).filter(
                   g => (g['Journal Key'] || '').toString().trim() !== editingKey.toString().trim()
               );
               window.journalData.push(gigRow);
           }
       } else {
           (window.journalData = window.journalData || []).push(gigRow);
       }

       window.filteredResults = [...window.journalData];

       closeEditorModal();
              if (window.showToast) window.showToast('Show Saved ✓', 'success');
              window.hideSpinner?.();           // ← hide here on success
              // Dispatch gig saved event for tip nudge triggers
              window.dispatchEvent(new CustomEvent('giglist:gigSaved'));
              if (window.refreshUI) window.refreshUI();

    } catch (err) {
        console.error('Final Save Error:', err);
        window.hideSpinner?.();       // ← hide here on error too
        _showError(err.message || 'Could not save show.');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
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

    // Capture key immediately — closeEditorModal() sets editingKey = null,
    // so any await gap (including the confirmation prompt below) would
    // otherwise cause the Supabase delete to run with a null key.
    const keyToDelete = editingKey;

    // Confirmation overlay — rendered as a fixed layer on document.body so it
    // always appears above the editor modal regardless of stacking context.
    const confirmed = await new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:10000;background:rgba(15,23,42,0.45)';

        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'del-yes-' + Date.now();
        const noId  = 'del-no-'  + Date.now();
        toast.innerHTML =
            '<span class="flex-1">Remove this show permanently?</span>' +
            '<button id="' + yesId + '" class="bg-red-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-colors">Remove</button>' +
            '<button id="' + noId  + '" class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">Cancel</button>';

        overlay.appendChild(toast);
        document.body.appendChild(overlay);
        document.getElementById(yesId).onclick = () => { overlay.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { overlay.remove(); resolve(false); };
    });

    if (!confirmed) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const isBandWrite = window.isBandMode && window.currentUser?.is_admin;

    // ── Save button feedback ──────────────────────────────────────────────────────
    const saveBtn = document.querySelector('#editor-modal button[onclick="saveGig()"]');
    const saveBtnOrigLabel = saveBtn?.textContent;
    const setSaveBtnLabel = (label, disabled = true) => {
        if (!saveBtn) return;
        saveBtn.textContent = label;
        saveBtn.disabled = disabled;
        saveBtn.classList.toggle('opacity-50', disabled);
    };
    setSaveBtnLabel('Saving…');

    let dbError;
    if (isBandWrite) {
        const { error } = await supabase
            .from('journals')
            .delete()
            .is('user_id', null)
            .eq('journal_key', keyToDelete);
        dbError = error;
    } else {
        const { error } = await supabase
            .from('journals')
            .delete()
            .eq('user_id', session.user.id)
            .eq('journal_key', keyToDelete);
        dbError = error;
    }

    if (dbError) {
        if (window.showToast) window.showToast('Delete failed: ' + dbError.message, 'error');
        return;
    }

    // Remove from in-memory data
    window.journalData = (window.journalData || []).filter(
        g => g['Journal Key'] !== keyToDelete
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

// ─── COMPANION SELECTOR ───────────────────────────────────────────────────────

/**
 * Renders the current _companions array as pills in #companion-pills.
 */
function _renderCompanionPills() {
    const container = document.getElementById('companion-pills');
    if (!container) return;

    container.innerHTML = _companions.map((c, i) => {
        const colours = {
            confirmed: 'bg-emerald-50 border-emerald-200 text-emerald-800',
            legacy:    'bg-slate-100 border-slate-200 text-slate-700',
            pending:   'bg-amber-50 border-amber-200 text-amber-800',
        };
        const cls = colours[c.status] || colours.legacy;
        const initial = (c.name || '?')[0].toUpperCase();

        // Share button for legacy (unmatched) companions
        const shareBtn = c.status === 'legacy'
            ? `<button type="button"
                       data-share="${i}"
                       title="Invite ${c.name} to GigList"
                       class="ml-0.5 text-slate-400 hover:text-indigo-500 transition-colors">
                   <i data-lucide="share-2" class="w-3 h-3 inline-block"></i>
               </button>`
            : '';

        const statusDot = c.status === 'confirmed'
            ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"></span>`
            : c.status === 'pending'
            ? `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></span>`
            : '';

        return `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold ${cls}">
            <span class="w-5 h-5 rounded-full bg-white/60 flex items-center justify-center text-[10px] font-black flex-shrink-0">${initial}</span>
            ${statusDot}
            ${c.name}
            ${shareBtn}
            <button type="button"
                    data-remove="${i}"
                    aria-label="Remove ${c.name}"
                    class="ml-0.5 opacity-50 hover:opacity-100 transition-opacity">
                <i data-lucide="x" class="w-3 h-3 inline-block"></i>
            </button>
        </span>`;
    }).join('');

    // Wire remove buttons
    container.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
            _companions.splice(parseInt(btn.dataset.remove), 1);
            _renderCompanionPills();
        });
    });

    // Wire share buttons
    container.querySelectorAll('[data-share]').forEach(btn => {
        btn.addEventListener('click', () => {
            const companion = _companions[parseInt(btn.dataset.share)];
            if (!companion) return;
            _shareInvite(companion.name);
        });
    });

    if (window.lucide) lucide.createIcons();
}

/**
 * Loads companions for the modal.
 * Edit mode: reads from gig_companions for this journal entry.
 * New gig with prefill (e.g. festival): parses legacy went_with string.
 */
async function _loadCompanionsForModal(entry) {
    // Edit mode — load from gig_companions
    if (entry.id) {
        const { data: rows } = await supabase
            .from('gig_companions')
            .select('*')
            .eq('journal_id', entry.id)
            .eq('owner_id', (await supabase.auth.getSession()).data.session?.user?.id);

        if (rows?.length) {
            _companions = rows.map(r => ({
                name:      r.companion_name,
                userId:    r.companion_user_id || null,
                status:    r.status || 'legacy',
                avatarUrl: null,
            }));
            _renderCompanionPills();
            return;
        }
    }

    // New gig or no gig_companions rows yet — fall back to went_with free text
    const wentWith = entry['Went With'] || entry.went_with || '';
    if (wentWith) {
        _companions = wentWith.split('/').map(n => n.trim()).filter(Boolean).map(name => ({
            name,
            userId: null,
            status: 'legacy',
            avatarUrl: null,
        }));
        _renderCompanionPills();
    }
}

/**
 * Searches for companion suggestions.
 * Returns { buddies: [...], others: [...] } — profiles array with match metadata.
 */
async function _searchCompanions(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { buddies: [], others: [] };

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { buddies: [], others: [] };

    const userId = session.user.id;

    // Get accepted buddy ids
    const { data: buddyRows } = await supabase
        .from('buddies')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

    const buddyIds = new Set(
        (buddyRows || []).map(r => r.requester_id === userId ? r.addressee_id : r.requester_id)
    );

    // Search profiles by display_name
    const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, username, avatar_url')
        .ilike('display_name', `%${q}%`)
        .neq('id', userId)
        .limit(10);

    const results = (profiles || []).filter(p => p.display_name);
    const buddies = results.filter(p => buddyIds.has(p.id));
    const others  = results.filter(p => !buddyIds.has(p.id));

    return { buddies, others };
}

/**
 * Renders the companion dropdown with buddy and other sections.
 */
function _renderCompanionDropdown(query, buddies, others, rawName) {
    const dropdown = document.getElementById('companion-dropdown');
    if (!dropdown) return;

    const alreadyAdded = new Set(_companions.map(c => c.name.toLowerCase()));

    const makeItem = (profile, isBuddy) => {
        const name = profile.display_name;
        if (alreadyAdded.has(name.toLowerCase())) return '';
        const initial = name[0].toUpperCase();
        const badge = isBuddy
            ? `<span class="text-[9px] font-black uppercase tracking-widest text-emerald-600">Gig Buddy</span>`
            : `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">GigList</span>`;
        return `<li role="option"
                    class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-indigo-50 transition-colors"
                    data-name="${name}"
                    data-userid="${profile.id}"
                    data-status="${isBuddy ? 'confirmed' : 'pending'}">
            <span class="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-black text-indigo-600 flex-shrink-0">${initial}</span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-bold text-slate-800">${name}</span>
                ${badge}
            </span>
        </li>`;
    };

    let html = '';

    if (buddies.length) {
        html += `<li class="px-4 pt-2.5 pb-1 text-[9px] font-black uppercase tracking-widest text-indigo-400 pointer-events-none">Gig Buddies</li>`;
        html += buddies.map(p => makeItem(p, true)).join('');
    }

    if (others.length) {
        html += `<li class="px-4 pt-2.5 pb-1 text-[9px] font-black uppercase tracking-widest text-slate-400 pointer-events-none">On GigList</li>`;
        html += others.map(p => makeItem(p, false)).join('');
    }

    // Always offer "add as-is" if the typed name isn't already added
    if (rawName.trim() && !alreadyAdded.has(rawName.trim().toLowerCase())) {
        html += `<li role="option"
                     class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors border-t border-slate-100"
                     data-name="${rawName.trim()}"
                     data-userid=""
                     data-status="legacy">
            <span class="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-xs font-black text-slate-500 flex-shrink-0">+</span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-bold text-slate-700">Add "${rawName.trim()}"</span>
                <span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Not on GigList yet</span>
            </span>
        </li>`;
    }

    if (!html) {
        dropdown.classList.add('hidden');
        return;
    }

    dropdown.innerHTML = html;
    dropdown.classList.remove('hidden');

    // Wire item clicks
    dropdown.querySelectorAll('li[data-name]').forEach(li => {
        li.addEventListener('mousedown', (e) => {
            e.preventDefault(); // prevent input blur before click fires
            _addCompanion({
                name:   li.dataset.name,
                userId: li.dataset.userid || null,
                status: li.dataset.status,
            });
        });
    });
}

/**
 * Adds a companion pill and, if status is 'pending' (GigList user but not buddy),
 * fires a background buddy request.
 */
function _addCompanion({ name, userId, status }) {
    const input = document.getElementById('companion-input');
    const dropdown = document.getElementById('companion-dropdown');

    // Prevent duplicates
    if (_companions.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        if (input) input.value = '';
        if (dropdown) dropdown.classList.add('hidden');
        return;
    }

    _companions.push({ name, userId: userId || null, status: status || 'legacy', avatarUrl: null });
    _renderCompanionPills();

    if (input) input.value = '';
    if (dropdown) dropdown.classList.add('hidden');

    // Background buddy request for GigList users who aren't buddies yet
    if (status === 'pending' && userId) {
        _requestBuddyInBackground(userId, name);
    }
}

/**
 * Fires a buddy request in the background when adding a GigList user
 * who isn't yet a buddy. Silent — no modal, just a toast.
 */
async function _requestBuddyInBackground(targetUserId, displayName) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const [a, b] = [session.user.id, targetUserId].sort();
    const { error } = await supabase.from('buddies').upsert(
        { requester_id: a, addressee_id: b, status: 'pending' },
        { onConflict: 'requester_id,addressee_id', ignoreDuplicates: true }
    );

    if (!error && window.showToast) {
        window.showToast(`Gig buddy request sent to ${displayName}`, 'info');
    }
}

/**
 * Upserts all current _companions to gig_companions for the given journal.
 * Deletes any existing rows for this journal/owner first to handle removals.
 */
async function _saveCompanions(journalId, ownerId) {
    // Delete existing rows for this journal entry owned by this user
    await supabase
        .from('gig_companions')
        .delete()
        .eq('journal_id', journalId)
        .eq('owner_id', ownerId);

    if (_companions.length === 0) return;

    const rows = _companions.map(c => ({
        journal_id:         journalId,
        owner_id:           ownerId,
        companion_name:     c.name,
        companion_user_id:  c.userId || null,
        status:             c.status || 'legacy',
    }));

    const { error } = await supabase.from('gig_companions').insert(rows);
    if (error) console.error('gig_companions save failed:', error.message);
}

/**
 * Shares an invite link for a legacy (unmatched) companion via Web Share API.
 */
async function _shareInvite(name) {
    const base = window.location.pathname.replace(/\/[^/]*$/, '');
    const url  = `${window.location.origin}${base}/index.html`;
    const shareData = {
        title: 'Join me on GigList',
        text:  `${name}, I've been adding our gig memories to GigList — come join so I can tag you properly!`,
        url,
    };
    try {
        if (navigator.share) {
            await navigator.share(shareData);
        } else {
            await navigator.clipboard.writeText(`${shareData.text} ${url}`);
            if (window.showToast) window.showToast('Invite link copied!', 'success');
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.warn('Share failed:', err);
    }
}

/**
 * Wires up the companion typeahead input.
 */
function initCompanionSelector() {
    const input    = document.getElementById('companion-input');
    const dropdown = document.getElementById('companion-dropdown');
    if (!input || !dropdown) return;

    let _searchTimer = null;

    input.addEventListener('input', () => {
        const val = input.value.trim();
        if (val.length < 2) { dropdown.classList.add('hidden'); return; }

        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(async () => {
            const { buddies, others } = await _searchCompanions(val);
            _renderCompanionDropdown(val, buddies, others, val);
        }, 250);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            e.preventDefault();
            // If dropdown has a highlighted item, let mousedown handle it.
            // Otherwise add the typed name as legacy.
            const first = dropdown.querySelector('li[data-name]');
            if (first && !dropdown.classList.contains('hidden')) {
                _addCompanion({
                    name:   first.dataset.name,
                    userId: first.dataset.userid || null,
                    status: first.dataset.status,
                });
            } else {
                _addCompanion({ name: input.value.trim(), userId: null, status: 'legacy' });
            }
        }
        if (e.key === 'Escape') dropdown.classList.add('hidden');
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// ─── INIT (wire comboboxes once DOM is ready) ─────────────────────────────────

export const initEditor = () => {
    loadArtistOptions(); // pre-fetch so cache is warm before first keystroke
    loadVenueOptions();  // pre-fetch venues from global table, not just user's own
    wireCombobox('editor-band',    'editor-band-list',    getArtistOptions);
    wireCombobox('editor-venue',   'editor-venue-list',   getVenueOptions);
    wireCombobox('editor-support', 'editor-support-list', getSupportOptions);
    initCompanionSelector();

    // The lineup pool is keyed on date+venue — if either changes while the
    // festival section is open, the journal_key (and therefore the pool)
    // may have changed too, so refresh. wireCombobox's selectItem() fires a
    // 'change' event on venue selection, so this covers picking from the
    // dropdown as well as manually typing + blurring either field.
    const _onDateVenueChange = () => {
        const section = document.getElementById('editor-festival-section');
        if (section && !section.classList.contains('hidden')) refreshLineupPool();
    };
    document.getElementById('editor-date')?.addEventListener('change', _onDateVenueChange);
    document.getElementById('editor-venue')?.addEventListener('change', _onDateVenueChange);
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


// Pre-filled add gig modal logic when clicking "View" from companion match notification

export const openCompanionPrefillModal = async (journalId, taggedByUsername) => {
    const { data: row, error } = await supabase
        .from('journals')
        .select('journal_key, date, band, official_venue, festival, festival_lineups, notable_support')
        .eq('id', journalId)
        .single();

    if (error || !row) {
        window.showToast?.('Could not load show details — try again', 'error');
        return;
    }

    editingKey = null;
    renderEditorModal({
        Date:               row.date,
        Band:               row.band,
        OfficialVenue:      row.official_venue,
        'Festival?':        row.festival ? 'Y' : 'N',
        'Festival Lineups': row.festival_lineups || '',
        'Notable Support':  row.notable_support  || '',
        'Went With':        '',
        Comments:           '',
        Price:              '',
        Photos:             '',
        'Review URL':       '',
    });

    // Set AFTER renderEditorModal, which resets this to null on every open.
    // Tracks the ORIGINAL show's journal_key so a successful save can
    // acknowledge the companion tag regardless of whether the user edits
    // the venue/date text before saving their own copy.
    _pendingCompanionAckKey = row.journal_key;

    if (taggedByUsername) {
        _addCompanion({ name: taggedByUsername, userId: null, status: 'legacy' });
    }
};

window.openCompanionPrefillModal = openCompanionPrefillModal;

/**
 * Opens the editor modal pre-filled with data from a pending_captures row.
 * matched_date arrives as YYYY-MM-DD (not DD/MM/YYYY), so we convert it
 * before passing to renderEditorModal which calls toInputDate (DD/MM/YYYY → YYYY-MM-DD).
 *
 * @param {{ matched_artist?: string, matched_venue?: string, matched_date?: string, notes?: string }} capture
 */
export const openCaptureGigModal = (capture) => {
    editingKey = null;

    // Derive date from captured_at (ISO timestamp) — matched_date may be null
        // for no-match captures. Parse via Date() to handle the timestamp safely.
        let dateForEditor = '';
        const rawDate = capture.matched_date || capture.captured_at;
        if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d)) {
                const dd   = String(d.getUTCDate()).padStart(2, '0');
                const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
                const yyyy = d.getUTCFullYear();
                dateForEditor = `${dd}/${mm}/${yyyy}`;
            }
        }

    renderEditorModal({
        Date:          dateForEditor,
        Band:          capture.matched_artist || '',
        OfficialVenue: capture.matched_venue  || '',
        Comments:      capture.notes          || '',
    });
};

window.openCaptureGigModal = openCaptureGigModal;
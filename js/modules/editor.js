/**
 * GigList - Editor Module
 * Handles add/edit gig form, combobox autocomplete, CSV export,
 * and unsaved-changes tracking.
 *
 * Phase 1: writes to window.journalData in memory.
 * Phase 3: swap saveGig() to call supabase.from('journals').upsert() instead.
 */

import { parseDate } from './utils.js';

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
    const title   = isEdit ? 'Edit Show' : 'Add Show';
    const festVal = (entry['Festival?'] || entry['Festival? Y/N'] || 'N').toString().trim().toUpperCase();
    const isFest  = festVal === 'Y';

    document.getElementById('editor-modal-title').textContent = title;

    // Populate fields
    _val('editor-date',       entry.Date       || '');
    _val('editor-band',       entry.Band       || '');
    _val('editor-venue',      entry.OfficialVenue || '');
    _val('editor-went-with',  entry['Went With'] || '');
    _val('editor-support',    entry['Notable Support'] || '');
    _val('editor-lineups',    entry['Festival Lineups'] || '');
    _val('editor-comments',   entry.Comments   || '');
    _val('editor-price',      entry.Price      || '');
    _val('editor-photos',     entry.Photos     || '');
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

// ─── SAVE ─────────────────────────────────────────────────────────────────────

window.saveGig = () => {
    const dateStr    = _get('editor-date').trim();
    const band       = _get('editor-band').trim();
    const venue      = _get('editor-venue').trim();

    // Basic validation
    if (!dateStr || !band || !venue) {
        _showError('Date, Artist and Venue are required.');
        return;
    }

    // Validate date format DD/MM/YYYY
    const dateParts = dateStr.split('/');
    if (dateParts.length !== 3 || dateParts[2].length !== 4) {
        _showError('Date must be in DD/MM/YYYY format.');
        return;
    }

    const journalKey = buildJournalKey(dateStr, venue);
    const isFest     = document.getElementById('editor-festival')?.checked ? 'Y' : 'N';
    const [d, m, y]  = dateParts;

    const gigRow = {
        'Date':              dateStr,
        'Band':              band,
        'OfficialVenue':     venue,
        'Venue':             venue,
        'Journal Key':       journalKey,
        'Festival?':         isFest,
        'Festival Lineups':  _get('editor-lineups').trim(),
        'Notable Support':   _get('editor-support').trim(),
        'Went With':         _get('editor-went-with').trim(),
        'Comments':          _get('editor-comments').trim(),
        'Price':             _get('editor-price').trim(),
        'Photos':            _get('editor-photos').trim(),
        'Year':              y,
        'Month':             m,
        'Day':               d,
        // safeKey is used in table onClick attributes — pre-escape apostrophes
        'safeKey':           journalKey.replace(/'/g, "\\'").replace(/"/g, '&quot;'),
    };

    const journal = window.journalData || [];

    if (editingKey) {
        // Replace existing entry
        const idx = journal.findIndex(
            g => (g['Journal Key'] || '').toString().trim() === editingKey.toString().trim()
        );
        if (idx !== -1) {
            journal[idx] = { ...journal[idx], ...gigRow };
        } else {
            journal.push(gigRow);
        }
    } else {
        // Check for duplicate key
        if (journal.some(g => g['Journal Key'] === journalKey)) {
            _showError(`A show already exists with this date and venue.\nJournal Key: ${journalKey}`);
            return;
        }
        journal.push(gigRow);
    }

    window.journalData = journal;
    setDirty(true);
    closeEditorModal();

    // If the saved show is in the future, make sure the upcoming toggle is on
    // so the user can immediately see the show they just added
    const savedDate = parseDate(dateStr);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (savedDate && savedDate >= now) {
        const toggle = document.getElementById('upcoming-toggle');
        if (toggle && !toggle.checked) toggle.checked = true;
    }

    // Refresh the UI so the new/edited gig appears immediately
    if (window.refreshUI) window.refreshUI();
};

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
        alert('No data to export.');
        return;
    }

    const columns = [
        'Date', 'Band', 'Notable Support', 'Venue', 'Price',
        'Comments', 'Went With', 'Festival?', 'Festival Lineups',
        'Photos', 'Journal Key', 'OfficialVenue', 'Year', 'Month', 'Day'
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
    const user  = JSON.parse(localStorage.getItem('gv_user'));
    a.download  = `${user?.JournalFile?.replace('.csv', '') || 'journal'}_${today}.csv`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Once exported the in-memory state matches the file — mark clean
    setDirty(false);
};

window.exportCSV      = exportCSV;
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
    }
};

// ─── INIT (wire comboboxes once DOM is ready) ─────────────────────────────────

export const initEditor = () => {
    wireCombobox('editor-band',    'editor-band-list',    getArtistOptions);
    wireCombobox('editor-venue',   'editor-venue-list',   getVenueOptions);
    wireCombobox('editor-support', 'editor-support-list', getSupportOptions);
};
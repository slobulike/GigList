/**
 * GigList — Collection Editor Module
 * v1.0.0 — April 2026
 *
 * Add / edit collection_items (artefacts and memories).
 *
 * Public API:
 *   initCollectionEditor()              — wire up once DOM is ready (called from app.js)
 *
 * Window helpers (called from inline HTML / other modules):
 *   window.openCollectionEditor(type?, itemId?)
 *   window.closeCollectionEditor()
 *   window.saveCollectionItem()
 *   window.deleteCollectionItem()
 *   window.colEditorSetType(type)       — artefact | memory
 *   window.colEditorSetSubtype(subtype)
 *   window.colEditorPhotoChange(input)  — file input onChange
 *   window.colEditorRemovePhoto(index)
 *   window.colEditorAddLabel(label)
 *   window.colEditorRemoveLabel(index)
 */

import { supabase } from './supabase.js';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _editingId    = null;   // uuid of item being edited, null for new
let _selectedType    = 'artefact';
let _selectedSubtype = 'cd';
let _pendingPhotos   = [];  // Array of { file, previewUrl } — not yet uploaded
let _existingPhotos  = [];  // Array of storage URL strings — already in DB
let _labels          = [];  // Current label array

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SUBTYPES = {
    artefact: [
        { value: 'cd',        label: 'CD',         icon: '💿' },
        { value: 'vinyl',     label: 'Vinyl',       icon: '🖤' },
        { value: 'tape',      label: 'Tape',        icon: '📼' },
        { value: 'minidisc',  label: 'MiniDisc',    icon: '💽' },
        { value: 'apparel',   label: 'Apparel',     icon: '👕' },
        { value: 'poster',    label: 'Poster',      icon: '🗒' },
        { value: 'magazine',  label: 'Magazine',    icon: '🗞' },
        { value: 'book',      label: 'Book',        icon: '📖' },
        { value: 'tab_book',  label: 'Tab Book',    icon: '🎸' },
        { value: 'ticket',    label: 'Ticket',      icon: '🎟' },
        { value: 'laminate',  label: 'Laminate',    icon: '🪪' },
        { value: 'other',     label: 'Other',       icon: '✦'  },
    ],
    memory: [
        { value: 'first_listen',    label: 'First listen',    icon: '🎧' },
        { value: 'live_experience', label: 'Live experience', icon: '🎤' },
        { value: 'community',       label: 'Community',       icon: '🤝' },
        { value: 'encounter',       label: 'Encounter',       icon: '✨' },
        { value: 'other',           label: 'Other',           icon: '📝' },
    ],
};

const FORMAT_SUGGESTIONS = {
    cd:       ['Album', 'CD single', 'Promo', 'Box set', 'EP', 'Digipak', 'Picture disc'],
    vinyl:    ['LP', '7"', '12"', 'EP', 'Picture disc', 'Coloured vinyl', 'Box set'],
    tape:     ['Cassette album', 'Cassette single', 'Demo tape'],
    minidisc: ['Album', 'Single'],
    apparel:  ['T-shirt', 'Hoodie', 'Hat', 'Jacket', 'Polo'],
    poster:   ['Tour poster', 'Album promo', 'Signed print', 'Lithograph'],
    magazine: ['Feature', 'Cover story', 'Review', 'Interview'],
    book:     ['Biography', 'Coffee table book', 'Photobook'],
    tab_book: ['Guitar tab', 'Bass tab', 'Piano/vocal'],
    ticket:   ['Ticket stub', 'E-ticket printout', 'Wristband'],
    laminate: ['AAA laminate', 'Guest pass', 'Crew laminate'],
};

// CONDITION_OPTIONS defined below alongside _wireConditionSuggestions

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const _get  = (id)        => document.getElementById(id)?.value?.trim() || '';
const _val  = (id, v)     => { const el = document.getElementById(id); if (el) el.value = v; };
const _esc  = (str)       => (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

function _showError(msg) {
    const el = document.getElementById('col-editor-error');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function _hideError() {
    const el = document.getElementById('col-editor-error');
    if (el) el.classList.add('hidden');
}

function _setBusy(busy) {
    const btn = document.getElementById('col-editor-save-btn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Saving…' : (_editingId ? 'Save changes' : 'Add to collection');
}

// ─── LABEL AUTOCOMPLETE ───────────────────────────────────────────────────────

/**
 * Returns all unique label values across the current user's collection.
 * Used for autocomplete — fetches once per editor open then caches.
 */
let _labelCache = null;
async function _getLabelOptions() {
    if (_labelCache) return _labelCache;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return [];
    const { data } = await supabase
        .from('collection_items')
        .select('labels')
        .eq('user_id', session.user.id);
    const all = new Set();
    (data || []).forEach(row => (row.labels || []).forEach(l => all.add(l)));
    _labelCache = [...all].sort();
    return _labelCache;
}

function _renderLabels() {
    const container = document.getElementById('col-editor-labels');
    if (!container) return;
    container.innerHTML = _labels.map((l, i) => `
        <span class="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
            ${l}
            <button type="button" onclick="window.colEditorRemoveLabel(${i})" aria-label="Remove label ${l}" class="hover:text-red-500 transition-colors leading-none">×</button>
        </span>`).join('');
}

function _wireLabelInput() {
    const input    = document.getElementById('col-editor-label-input');
    const dropdown = document.getElementById('col-editor-label-dropdown');
    if (!input || !dropdown) return;

    let _timer = null;

    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 1) { dropdown.classList.add('hidden'); return; }
        clearTimeout(_timer);
        _timer = setTimeout(async () => {
            const opts = await _getLabelOptions();
            const matches = opts
                .filter(o => o.toLowerCase().includes(q) && !_labels.includes(o))
                .slice(0, 6);

            const addNew = !opts.find(o => o.toLowerCase() === q) && !_labels.includes(input.value.trim());

            dropdown.innerHTML = [
                ...matches.map(m => `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-amber-50 transition-colors"
                                         onmousedown="event.preventDefault();window.colEditorAddLabel('${_esc(m)}')">${m}</li>`),
                addNew ? `<li class="px-4 py-2.5 text-sm font-bold text-amber-600 cursor-pointer hover:bg-amber-50 transition-colors"
                              onmousedown="event.preventDefault();window.colEditorAddLabel('${_esc(input.value.trim())}')"
                              >+ Add "${input.value.trim()}"</li>` : '',
            ].join('');

            dropdown.classList.toggle('hidden', !matches.length && !addNew);
        }, 200);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            e.preventDefault();
            const first = dropdown.querySelector('li');
            if (first && !dropdown.classList.contains('hidden')) {
                first.dispatchEvent(new MouseEvent('mousedown'));
            } else if (input.value.trim()) {
                window.colEditorAddLabel(input.value.trim());
            }
        }
        if (e.key === 'Escape') dropdown.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// ─── FORMAT SUGGESTIONS ───────────────────────────────────────────────────────

function _wireFormatSuggestions(subtype) {
    const input    = document.getElementById('col-editor-format');
    const dropdown = document.getElementById('col-editor-format-list');
    if (!input || !dropdown) return;

    const opts = FORMAT_SUGGESTIONS[subtype] || [];

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const matches = q
            ? opts.filter(o => o.toLowerCase().includes(q)).slice(0, 6)
            : opts.slice(0, 6);
        dropdown.innerHTML = matches.map(m =>
            `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors"
                 onmousedown="event.preventDefault();document.getElementById('col-editor-format').value='${_esc(m)}';document.getElementById('col-editor-format-list').classList.add('hidden')">${m}</li>`
        ).join('');
        dropdown.classList.toggle('hidden', !matches.length);
    });

    input.addEventListener('focus', () => {
        if (!input.value) {
            dropdown.innerHTML = opts.slice(0, 6).map(m =>
                `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors"
                     onmousedown="event.preventDefault();document.getElementById('col-editor-format').value='${_esc(m)}';document.getElementById('col-editor-format-list').classList.add('hidden')">${m}</li>`
            ).join('');
            dropdown.classList.toggle('hidden', !opts.length);
        }
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// ─── CONDITION SUGGESTIONS ───────────────────────────────────────────────────

const CONDITION_OPTIONS = [
    'Mint', 'Near Mint', 'Very Good Plus', 'Very Good', 'Good Plus', 'Good', 'Fair', 'Poor',
];

function _wireConditionSuggestions() {
    const input    = document.getElementById('col-editor-condition');
    const dropdown = document.getElementById('col-editor-condition-list');
    if (!input || !dropdown || input._condWired) return;
    input._condWired = true;

    const _show = (opts) => {
        dropdown.innerHTML = opts.map(m =>
            `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors"
                 onmousedown="event.preventDefault();document.getElementById('col-editor-condition').value='${_esc(m)}';document.getElementById('col-editor-condition-list').classList.add('hidden')">${m}</li>`
        ).join('');
        dropdown.classList.toggle('hidden', !opts.length);
    };

    input.addEventListener('focus', () => {
        const q = input.value.trim().toLowerCase();
        _show(q ? CONDITION_OPTIONS.filter(o => o.toLowerCase().includes(q)) : CONDITION_OPTIONS);
    });
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        _show(q ? CONDITION_OPTIONS.filter(o => o.toLowerCase().includes(q)) : CONDITION_OPTIONS);
    });
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.add('hidden');
    });
}

// ─── PHOTO HANDLING ───────────────────────────────────────────────────────────
// Add this helper to your global script scope once
window.togglePhotoMenu = (e) => {
    if (e) e.stopPropagation();
    const menu = document.getElementById('photoMenu');
    if (!menu) return;

    const isHidden = menu.classList.contains('hidden');

    // Close any other open menus first
    document.querySelectorAll('.photo-menu').forEach(m => m.classList.add('hidden'));

    if (isHidden) {
        menu.classList.remove('hidden');
        const closeMenu = (event) => {
            if (!menu.contains(event.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);
        if (window.lucide) lucide.createIcons();
    }
};

function _renderPhotoPreviews() {
    const container = document.getElementById('col-editor-photo-previews');
    if (!container) return;

    // 1. Generate HTML for photos already saved in the database
    const existingHtml = (_existingPhotos || []).map((url, i) => `
        <div class="relative w-16 h-16 rounded-xl overflow-hidden border border-slate-200 flex-shrink-0">
            <img src="${url}" alt="Photo ${i + 1}" class="w-full h-full object-cover">
            ${i === 0 ? `<span class="absolute bottom-0 left-0 right-0 text-center text-[8px] font-black uppercase bg-black/50 text-white py-0.5">Hero</span>` : ''}
            <button type="button"
                    onclick="window.colEditorRemovePhoto('existing-${i}')"
                    aria-label="Remove photo"
                    class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-red-500 transition-colors">×</button>
        </div>`).join('');

    // 2. Generate HTML for photos currently being uploaded (pending)
    const pendingHtml = (_pendingPhotos || []).map((p, i) => `
        <div class="relative w-16 h-16 rounded-xl overflow-hidden border border-amber-200 flex-shrink-0">
            <img src="${p.previewUrl}" alt="New photo ${i + 1}" class="w-full h-full object-cover">
            <span class="absolute bottom-0 left-0 right-0 text-center text-[8px] font-black uppercase bg-amber-500/80 text-white py-0.5">New</span>
            <button type="button"
                    onclick="window.colEditorRemovePhoto('pending-${i}')"
                    aria-label="Remove photo"
                    class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-red-500 transition-colors">×</button>
        </div>`).join('');

    const totalPhotos = (_existingPhotos?.length || 0) + (_pendingPhotos?.length || 0);

    // 3. Small "+" Button: Specialized for Photo Library/Bulk Upload
    // Added 'ml-1' for that requested white space between existing photos and the add button
    const addMore = totalPhotos < 8 ? `
        <label class="ml-1 w-16 h-16 rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center cursor-pointer hover:border-amber-400 transition-colors flex-shrink-0 text-slate-400 hover:text-amber-500">
            <span class="text-lg">+</span>
            <span class="text-[8px] font-black uppercase">Library</span>
            <input type="file"
                   accept="image/*"
                   multiple
                   class="hidden"
                   onchange="window.colEditorPhotoChange(this)">
        </label>` : '';

    // 4. Update the container
    container.innerHTML = `<div class="flex gap-2 flex-wrap items-center">${existingHtml}${pendingHtml}${addMore}</div>`;

    // Re-initialize icons if necessary
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

async function _uploadPhotos(userId, itemId) {
    const uploadedUrls = [];
    for (const p of _pendingPhotos) {
        const ext  = p.file.name.split('.').pop() || 'jpg';
        // Using a more collision-resistant path for multiple uploads
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 7);
        const path = `${userId}/${itemId}-${timestamp}-${randomString}.${ext}`;

        const { error } = await supabase.storage
            .from('collection-photos')
            .upload(path, p.file, {
                upsert: true,
                contentType: p.file.type,
                cacheControl: '3600'
            });

        if (error) {
            console.error('[ColEditor] photo upload failed:', error.message);
        } else {
            uploadedUrls.push(path);
        }
    }
    return uploadedUrls;
}

/**
 * Sample dominant colour from an image file using Canvas API.
 * Returns a hex string e.g. "#1e3a5f", or null on failure.
 */
async function _sampleHeroColor(file) {
    return new Promise((resolve) => {
        try {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = 50; canvas.height = 50;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, 50, 50);
                    const d = ctx.getImageData(0, 0, 50, 50).data;
                    let r = 0, g = 0, b = 0, count = 0;
                    for (let i = 0; i < d.length; i += 16) { // sample every 4th pixel
                        r += d[i]; g += d[i+1]; b += d[i+2]; count++;
                    }
                    r = Math.round(r / count);
                    g = Math.round(g / count);
                    b = Math.round(b / count);
                    // Darken slightly so spine text is always legible
                    r = Math.round(r * 0.6);
                    g = Math.round(g * 0.6);
                    b = Math.round(b * 0.6);
                    resolve(`#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`);
                } catch { resolve(null); }
                finally { URL.revokeObjectURL(url); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        } catch { resolve(null); }
    });
}
// Add this function near _sampleHeroColor:
async function _compressImage(file, maxPx = 1600, quality = 0.82) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
            const w = Math.round(img.width  * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            canvas.toBlob(
                blob => resolve(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file),
                'image/jpeg',
                quality
            );
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
    });
}

// ─── SUBTYPE SELECTOR ─────────────────────────────────────────────────────────

function _renderSubtypeSelector() {
    const container = document.getElementById('col-editor-subtype-grid');
    if (!container) return;
    const options = SUBTYPES[_selectedType] || [];
    container.innerHTML = options.map(o => `
        <button type="button"
                onclick="window.colEditorSetSubtype('${o.value}')"
                class="flex items-center gap-2 p-3 rounded-2xl border-2 transition-all text-left
                       ${o.value === _selectedSubtype
                            ? 'border-amber-400 bg-amber-50'
                            : 'border-slate-100 bg-white hover:border-slate-200'}">
            <span class="text-xl w-7 text-center flex-shrink-0">${o.icon}</span>
            <span class="text-[11px] font-black text-slate-700 leading-tight">${o.label}</span>
        </button>`).join('');
}

function _renderTypeToggle() {
    ['artefact', 'memory'].forEach(t => {
        const btn = document.getElementById(`col-type-btn-${t}`);
        if (!btn) return;
        const on = t === _selectedType;
        btn.className = `flex-1 py-2.5 text-[11px] font-black uppercase tracking-widest rounded-xl transition-all
            ${on ? 'text-[#111008]' : 'bg-transparent text-slate-400 hover:text-slate-600'}`;
        if (on) btn.style.background = '#c8a050';
        else btn.style.background = '';
    });
}

// ─── POPULATE FORM (for editing) ─────────────────────────────────────────────

async function _populateForm(item) {
    _selectedType    = item.type    || 'artefact';
    _selectedSubtype = item.subtype || 'cd';
    _labels          = [...(item.labels || [])];
    _existingPhotos  = [];
    _pendingPhotos   = [];

    _renderTypeToggle();
    _renderSubtypeSelector();
    _wireFormatSuggestions(_selectedSubtype);
    _wireConditionSuggestions();

    // Resolve signed URLs for existing photos
    for (const path of (item.photos || [])) {
        const { data } = await supabase.storage
            .from('collection-photos')
            .createSignedUrl(path, 3600);
        if (data?.signedUrl) _existingPhotos.push(data.signedUrl);
    }

    _val('col-editor-title',      item.title            || '');
    _val('col-editor-date',       item.item_date         || '');
    _val('col-editor-artist-ctx', item.artist_context    || '');
    _val('col-editor-body',       item.body              || '');
    _val('col-editor-label',      item.label             || '');
    _val('col-editor-cat-no',     item.catalogue_number  || '');
    _val('col-editor-format',     item.format            || '');
    _val('col-editor-signed-by',  item.signed_by         || '');
    _val('col-editor-provenance', item.provenance        || '');

    const condEl = document.getElementById('col-editor-condition');
    if (condEl) condEl.value = item.condition || '';

    // Band combobox — pre-fill with stored band_name
    const bandInput = document.getElementById('col-editor-band-input');
    if (bandInput) bandInput.value = item.band_name || '';

    _renderLabels();
    _renderPhotoPreviews();
    _updateFieldVisibility();
}

// ─── FIELD VISIBILITY ─────────────────────────────────────────────────────────

/**
 * Memories only need title, date, body and photos.
 * Artefacts show the full catalogue fields.
 */
function _updateFieldVisibility() {
    const catalogueFields = document.getElementById('col-editor-catalogue-fields');
    if (catalogueFields) {
        catalogueFields.classList.toggle('hidden', _selectedType === 'memory');
    }
    const subtypeLabel = document.getElementById('col-editor-subtype-label');
    if (subtypeLabel) {
        subtypeLabel.textContent = _selectedType === 'memory' ? 'Memory type' : 'Item type';
    }
    // Update placeholder on body field
    const bodyEl = document.getElementById('col-editor-body');
    if (bodyEl) {
        bodyEl.placeholder = _selectedType === 'memory'
            ? 'Tell the story…'
            : 'Any notes or the story behind this item…';
    }
}

// ─── BAND COMBOBOX ────────────────────────────────────────────────────────────

let _bandOptions = []; // Cached band name list for this editor session

async function _populateBandSelector() {
    const input    = document.getElementById('col-editor-band-input');
    const dropdown = document.getElementById('col-editor-band-dropdown');
    if (!input || !dropdown) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Fetch bands the user has gigs for
    const { data } = await supabase
        .from('journals')
        .select('band')
        .eq('user_id', session.user.id)
        .order('band');

    _bandOptions = [...new Set((data || []).map(r => r.band).filter(Boolean))].sort();

    // If in band mode, pre-fill
    if (window.isBandMode && window.currentArtist) {
        input.value = window.currentArtist;
    }

    _wireBandCombobox();
}

function _wireBandCombobox() {
    const input    = document.getElementById('col-editor-band-input');
    const dropdown = document.getElementById('col-editor-band-dropdown');
    if (!input || !dropdown || input._bandWired) return;
    input._bandWired = true;

    const _showDropdown = (matches) => {
        dropdown.innerHTML = [
            `<li class="px-4 py-2.5 text-sm font-bold text-slate-400 cursor-pointer hover:bg-slate-50 transition-colors italic"
                 onmousedown="event.preventDefault();document.getElementById('col-editor-band-input').value='';document.getElementById('col-editor-band-dropdown').classList.add('hidden')">
                 — No band —</li>`,
            ...matches.map(m =>
                `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-amber-50 transition-colors"
                     onmousedown="event.preventDefault();document.getElementById('col-editor-band-input').value='${_esc(m)}';document.getElementById('col-editor-band-dropdown').classList.add('hidden')">${m}</li>`
            ),
        ].join('');
        if (matches.length > 0 || !input.value.trim()) {
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    };

    input.addEventListener('focus', () => {
        const q = input.value.trim().toLowerCase();
        const matches = q
            ? _bandOptions.filter(b => b.toLowerCase().includes(q))
            : _bandOptions;
        _showDropdown(matches);
    });

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const matches = _bandOptions.filter(b => b.toLowerCase().includes(q));
        _showDropdown(matches);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') dropdown.classList.add('hidden');
        if (e.key === 'Enter') {
            e.preventDefault();
            const first = dropdown.querySelector('li:not(.italic)');
            if (first && !dropdown.classList.contains('hidden')) {
                first.dispatchEvent(new MouseEvent('mousedown'));
            } else {
                dropdown.classList.add('hidden');
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────

export const openCollectionEditor = async (type = null, itemId = null) => {
    _editingId       = itemId || null;
    _pendingPhotos   = [];
    _existingPhotos  = [];
    _labels          = [];
    _labelCache      = null; // refresh label suggestions on each open
    _selectedType    = type || 'artefact';
    _selectedSubtype = 'cd';
    _hideError();

    const modal = document.getElementById('col-editor-modal');
    if (!modal) { console.error('[ColEditor] #col-editor-modal not found'); return; }

    const titleEl = document.getElementById('col-editor-modal-title');
    if (titleEl) titleEl.textContent = itemId ? 'Edit item' : 'Add to collection';

    const deleteBtn = document.getElementById('col-editor-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('hidden', !itemId);

    const saveBtn = document.getElementById('col-editor-save-btn');
    if (saveBtn) saveBtn.textContent = itemId ? 'Save changes' : 'Add to collection';

    // Populate band selector
    await _populateBandSelector();

    if (itemId) {
        // Edit mode — fetch existing item
        const { data: item, error } = await supabase
            .from('collection_items')
            .select('*')
            .eq('id', itemId)
            .single();

        if (error || !item) {
            console.error('[ColEditor] fetch item failed:', error?.message);
            return;
        }
        await _populateForm(item);
    } else {
        // Add mode — reset form
        _renderTypeToggle();
        _renderSubtypeSelector();
        _wireFormatSuggestions(_selectedSubtype);
        _renderLabels();
        _renderPhotoPreviews();
        _updateFieldVisibility();

        ['col-editor-title','col-editor-date','col-editor-artist-ctx',
         'col-editor-body','col-editor-label','col-editor-cat-no',
         'col-editor-format','col-editor-signed-by','col-editor-provenance'].forEach(id => _val(id, ''));
        const condEl = document.getElementById('col-editor-condition');
        if (condEl) condEl.value = '';
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.getElementById('col-editor-title')?.focus();

    if (window.lucide) lucide.createIcons();
};

export const closeCollectionEditor = () => {
    const modal = document.getElementById('col-editor-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'auto';
    // Revoke any pending photo preview URLs
    _pendingPhotos.forEach(p => URL.revokeObjectURL(p.previewUrl));
    _pendingPhotos = [];
};

// ─── SAVE ─────────────────────────────────────────────────────────────────────

window.saveCollectionItem = async () => {
    _hideError();

    const title = _get('col-editor-title') ||
        SUBTYPES[_selectedType]?.find(s => s.value === _selectedSubtype)?.label ||
        _selectedSubtype;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { _showError('You must be signed in to save.'); return; }

    _setBusy(true);

    try {
        const itemId = _editingId || crypto.randomUUID();

        // Upload any pending photos
        const newPhotoUrls = await _uploadPhotos(session.user.id, itemId);

        // All photo paths (existing + new)
        // _existingPhotos are signed URLs — we store the raw path in DB.
        // For existing items, we re-fetch the raw paths from the DB rather than
        // trying to reverse-engineer them from signed URLs.
        let allPhotoPaths = newPhotoUrls;
        if (_editingId && _existingPhotos.length > 0) {
            const { data: existing } = await supabase
                .from('collection_items')
                .select('photos')
                .eq('id', _editingId)
                .single();
            const existingPaths = existing?.photos || [];
            // Keep only the paths that still have a signed URL (user didn't remove them)
            // We use count: signed URLs correspond 1:1 to existingPaths in order
            const keepCount = _existingPhotos.length;
            allPhotoPaths = [...existingPaths.slice(0, keepCount), ...newPhotoUrls];
        }

        // Sample hero colour from first pending photo if no existing photos
        let heroColor = null;
        if (_pendingPhotos.length > 0 && _existingPhotos.length === 0) {
            heroColor = await _sampleHeroColor(_pendingPhotos[0].file);
        }

        // Read band name directly from combobox input (free-text or lookup selection)
        const bandInput = document.getElementById('col-editor-band-input');
        const bandName = bandInput?.value.trim() || null;

        const row = {
            id:               itemId,
            user_id:          session.user.id,
            type:             _selectedType,
            subtype:          _selectedSubtype,
            title,
            // band_name requires the column to exist in collection_items.
            // Run: ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS band_name text;
            ...(bandName !== null && { band_name: bandName }),
            item_date:        _get('col-editor-date')       || null,
            artist_context:   _get('col-editor-artist-ctx') || null,
            body:             _get('col-editor-body')       || null,
            label:            _get('col-editor-label')      || null,
            catalogue_number: _get('col-editor-cat-no')     || null,
            format:           _get('col-editor-format')     || null,
            condition:        document.getElementById('col-editor-condition')?.value || null,
            signed_by:        _get('col-editor-signed-by')  || null,
            provenance:       _get('col-editor-provenance') || null,
            photos:           allPhotoPaths,
            labels:           _labels,
            ...(heroColor && { hero_color: heroColor }),
        };

        const { error } = await supabase
            .from('collection_items')
            .upsert(row, { onConflict: 'id' });

        if (error) throw error;

        closeCollectionEditor();
        if (window.showToast) window.showToast(
            _editingId ? 'Item updated ✓' : 'Added to collection ✓',
            'success'
        );
        // Refresh collection view
        if (window._refreshCollection) window._refreshCollection();

    } catch (err) {
        console.error('[ColEditor] save failed:', err);
        _showError(err.message || 'Could not save item.');
    } finally {
        _setBusy(false);
    }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────

window.deleteCollectionItem = async () => {
    if (!_editingId) return;

    // Toast-based confirmation — matches editor.js pattern
    const confirmed = await new Promise(resolve => {
        const container = document.getElementById('toast-container');
        if (!container) { resolve(window.confirm('Remove this item permanently?')); return; }
        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'col-del-yes-' + Date.now();
        const noId  = 'col-del-no-'  + Date.now();
        toast.innerHTML =
            '<span class="flex-1">Remove this item permanently?</span>' +
            `<button id="${yesId}" class="bg-red-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-red-600 transition-colors">Remove</button>` +
            `<button id="${noId}"  class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors">Cancel</button>`;
        container.appendChild(toast);
        document.getElementById(yesId).onclick = () => { toast.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { toast.remove(); resolve(false); };
    });

    if (!confirmed) return;

    const { error } = await supabase
        .from('collection_items')
        .delete()
        .eq('id', _editingId);

    if (error) {
        if (window.showToast) window.showToast('Could not delete item.', 'error');
        return;
    }

    closeCollectionEditor();
    if (window.showToast) window.showToast('Item removed.', 'success');
    if (window._refreshCollection) window._refreshCollection();
};

// ─── WINDOW HELPERS ──────────────────────────────────────────────────────────

window.openCollectionEditor  = openCollectionEditor;
window.closeCollectionEditor = closeCollectionEditor;

window.colEditorSetType = (type) => {
    _selectedType    = type;
    _selectedSubtype = SUBTYPES[type]?.[0]?.value || 'other';
    _renderTypeToggle();
    _renderSubtypeSelector();
    _wireFormatSuggestions(_selectedSubtype);
    _updateFieldVisibility();
};

window.colEditorSetSubtype = (subtype) => {
    _selectedSubtype = subtype;
    _renderSubtypeSelector();
    _wireFormatSuggestions(subtype);
};

window.colEditorPhotoChange = async (input) => {
    const files = Array.from(input.files || []);
    for (const file of files) {
        if (_pendingPhotos.length + _existingPhotos.length >= 8) break;
        const compressed = await _compressImage(file);
        _pendingPhotos.push({ file: compressed, previewUrl: URL.createObjectURL(compressed) });
    }
    input.value = '';
    _renderPhotoPreviews();
};

window.colEditorRemovePhoto = (key) => {
    if (key.startsWith('existing-')) {
        const i = parseInt(key.replace('existing-', ''));
        _existingPhotos.splice(i, 1);
    } else {
        const i = parseInt(key.replace('pending-', ''));
        URL.revokeObjectURL(_pendingPhotos[i]?.previewUrl);
        _pendingPhotos.splice(i, 1);
    }
    _renderPhotoPreviews();
};

window.colEditorAddLabel = (label) => {
    const input    = document.getElementById('col-editor-label-input');
    const dropdown = document.getElementById('col-editor-label-dropdown');
    const trimmed  = label.trim();
    if (!trimmed || _labels.includes(trimmed)) return;
    _labels.push(trimmed);
    if (input)    input.value = '';
    if (dropdown) dropdown.classList.add('hidden');
    _renderLabels();
    // Add to cache immediately so it autocompletes in the same session
    if (_labelCache && !_labelCache.includes(trimmed)) _labelCache.push(trimmed);
};

window.colEditorRemoveLabel = (i) => {
    _labels.splice(i, 1);
    _renderLabels();
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

export const initCollectionEditor = () => {
    _wireLabelInput();
    _wireConditionSuggestions();
    // Close modal on backdrop click
    const modal = document.getElementById('col-editor-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCollectionEditor();
        });
    }
};
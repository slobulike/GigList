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
 *   window.colEditorRecropPhoto(index)  — reopen crop tool on an already-added photo
 *   window.colEditorSetHeroPhoto(index) — move a photo to the front (hero) slot
 *   window.colEditorAddLabel(label)
 *   window.colEditorRemoveLabel(index)
 *   window.colEditorAddLinkFromInput()
 *   window.colEditorRemoveLink(index)
 *   window.colEditorToggleDisposed(checked)
 *   window.colEditorLookupDiscogs()     — fetch + autofill from a pasted Discogs link
 */

import { supabase } from './supabase.js';
import { enrichNewArtist } from './artist-enrichment.js';
import { escapeHtml } from './utils.js';
import { openPhotoCropModal } from './photo-crop.js';

// Collection cards render hero photos in a square tile (see collection.js
// _renderGridCard's aspect-square container) — not the gig modal's 16:9 —
// so items get their own crop ratio.
const COLLECTION_PHOTO_CROP_ASPECT_RATIO = 1;
const PUSH_WORKER_URL = 'https://giglist-push.richard-lipscombe.workers.dev';
const IMPORT_WORKER_URL = 'https://collection-image-import.richard-lipscombe.workers.dev';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _editingId    = null;   // uuid of item being edited, null for new
let _selectedType    = 'artefact';
let _selectedSubtype = 'cd';
// Single ordered list of photo slots — index 0 is always the hero.
// Each entry is one of:
//   { kind: 'existing', path, url }             — already in DB (path = storage key, url = signed URL)
//   { kind: 'pending',  file, previewUrl }       — new or re-cropped, not yet uploaded
let _photos          = [];
let _labels          = [];  // Current label array
let _links           = [];  // Current reference-URL array (Discogs, Weezerpedia, etc.)
let _taggedBuddies   = [];  // Array of { id, name } — buddies tagged in this memory
let _extendedOpen    = false; // Whether the "Extended Details" section is expanded
let _discogsId       = null; // Set once a Discogs lookup has populated this item
let _discogsData     = null; // { genres, styles, tracklist, discogs_uri } — read-only snapshot

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
        { value: 'video',       label: 'Video',        icon: '📀' },
        { value: 'game',         label: 'Game',          icon: '🎮' },
        { value: 'memorabilia',  label: 'Memorabilia',   icon: '🎁' },
        { value: 'ephemera',     label: 'Ephemera',      icon: '📰' },
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
    video:       ['DVD', 'VHS', 'Blu-ray', 'DVD-R'],
    game:        ['Cartridge', 'Disc', 'Digital code'],
    memorabilia: ['Keychain', 'Pin', 'Toy', 'Bag', 'Instrument', 'Gift card'],
    ephemera:    ['Flyer', 'Postcard', 'Press kit', 'Setlist', 'Zine', 'Sticker'],
};

// CONDITION_OPTIONS defined below alongside _wireConditionSuggestions

// Which extended-detail fields are relevant for each subtype. Drives both
// per-field visibility (below) and whole-card visibility — a card whose
// fields are all irrelevant for the current subtype collapses away instead
// of showing an empty shell. Memories never use this (whole catalogue
// section is hidden for type === 'memory').
const SUBTYPE_FIELD_RULES = {
    cd:          ['format', 'label', 'catalogue_number', 'country', 'condition'],
    vinyl:       ['format', 'label', 'catalogue_number', 'country', 'condition'],
    tape:        ['format', 'label', 'catalogue_number', 'condition'],
    minidisc:    ['format', 'label', 'catalogue_number', 'condition'],
    apparel:     ['size', 'condition', 'signed_by', 'provenance'],
    poster:      ['size', 'condition', 'signed_by', 'provenance'],
    magazine:    ['format', 'condition', 'provenance'],
    book:        ['format', 'condition', 'signed_by'],
    tab_book:    ['format', 'condition', 'signed_by'],
    ticket:      ['provenance', 'condition'],
    laminate:    ['provenance', 'condition'],
    video:       ['format', 'condition', 'signed_by'],
    game:        ['format', 'condition'],
    memorabilia: ['size', 'condition', 'signed_by', 'provenance'],
    ephemera:    ['condition', 'provenance'],
    other:       ['format', 'label', 'catalogue_number', 'country', 'size', 'condition', 'signed_by', 'provenance'],
};

// Which card each subtype-gated field lives in — used to collapse a whole
// card when none of its fields apply to the current subtype.
const FIELD_CARD = {
    format: 'specs', label: 'specs', catalogue_number: 'specs', country: 'specs', size: 'specs',
    condition: 'condition', signed_by: 'condition', provenance: 'condition',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const _get  = (id)        => document.getElementById(id)?.value?.trim() || '';
const _val  = (id, v)     => { const el = document.getElementById(id); if (el) el.value = v; };

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
            ${escapeHtml(l)}
            <button type="button" onclick="window.colEditorRemoveLabel(${i})" aria-label="Remove label ${escapeHtml(l)}" class="hover:text-red-500 transition-colors leading-none">×</button>
        </span>`).join('');
}

function _renderLinks() {
    const container = document.getElementById('col-editor-links');
    if (!container) return;
    container.innerHTML = _links.map((url, i) => `
        <span class="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-slate-100 border border-slate-200 text-slate-600 max-w-full">
            <span class="truncate" style="max-width:180px">${escapeHtml(url)}</span>
            <button type="button" onclick="window.colEditorRemoveLink(${i})" aria-label="Remove link" class="hover:text-red-500 transition-colors leading-none flex-shrink-0">×</button>
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
                                         data-add-label="${escapeHtml(m)}">${escapeHtml(m)}</li>`),
                addNew ? `<li class="px-4 py-2.5 text-sm font-bold text-amber-600 cursor-pointer hover:bg-amber-50 transition-colors"
                              data-add-label="${escapeHtml(input.value.trim())}"
                              >+ Add "${escapeHtml(input.value.trim())}"</li>` : '',
            ].join('');

            dropdown.classList.toggle('hidden', !matches.length && !addNew);
        }, 200);
    });

    // One delegated listener for every dropdown item (label text comes from
    // this user's saved labels, but those get shown to buddies elsewhere —
    // treat as untrusted the same as any other stored field).
    if (!dropdown._addLabelWired) {
        dropdown._addLabelWired = true;
        dropdown.addEventListener('mousedown', (e) => {
            const li = e.target.closest('[data-add-label]');
            if (!li) return;
            e.preventDefault();
            window.colEditorAddLabel(li.dataset.addLabel);
        });
    }

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

// ─── DISCOGS LOOKUP / PREFILL ─────────────────────────────────────────────────
// Autofill is all-or-nothing by design (per product decision): every
// mapped field gets overwritten with whatever Discogs returned, and the
// user edits from there afterwards. This is simpler than a per-field
// keep/discard step and matches how the rest of this form already works
// (e.g. selecting a band from the combobox just overwrites the input).

function _setDiscogsStatus(msg, isError = false) {
    const el = document.getElementById('col-editor-discogs-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.classList.toggle('text-red-500', isError);
    el.classList.toggle('text-slate-400', !isError);
}

window.colEditorLookupDiscogs = async () => {
    const input = document.getElementById('col-editor-discogs-input');
    const discogsUrl = input?.value?.trim();
    if (!discogsUrl) return;

    const btn = document.getElementById('col-editor-discogs-fetch-btn');
    if (btn) btn.disabled = true;
    _setDiscogsStatus('Looking up release…');
    // Reuses the app-wide spinner from app.js rather than a bespoke one here —
    // if that isn't the actual global name/signature, swap this pair for
    // whatever app.js exports. Both are optional-chained so a mismatch just
    // means no spinner shows, not a broken lookup.
    window.showSpinner?.();

    try {
        const res = await fetch(`${IMPORT_WORKER_URL}/lookup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discogsUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `lookup failed (${res.status})`);

        await _applyDiscogsLookup(data);
        _setDiscogsStatus('Filled in from Discogs — edit anything below as needed.');
    } catch (err) {
        console.error('[ColEditor] Discogs lookup failed:', err.message);
        _setDiscogsStatus("Couldn't find that release — you can still fill the form in yourself.", true);
    } finally {
        if (btn) btn.disabled = false;
        window.hideSpinner?.();
    }
};

async function _applyDiscogsLookup(data) {
    // Core fields — same inputs a manual entry would fill in.
    _val('col-editor-title', data.title || '');
    _val('col-editor-date',  data.year ? String(data.year) : '');
    _val('col-editor-label',      data.label            || '');
    _val('col-editor-cat-no',     data.catalogue_number || '');
    _val('col-editor-format',     data.format           || '');
    _val('col-editor-country',    data.country          || '');

    const bandInput = document.getElementById('col-editor-band-input');
    if (bandInput && data.artist) bandInput.value = data.artist;

    // Adding the Discogs page itself to the links chips means it's still
    // there even if the discogs_data snapshot below ever falls out of sync.
    if (data.discogs_uri && !_links.includes(data.discogs_uri)) {
        _links.push(data.discogs_uri);
        _renderLinks();
    }

    // Reveal the specs fields that were just populated (they live in the
    // Extended section) and open the read-only Discogs card underneath them.
    _discogsId   = data.discogs_id || null;
    _discogsData = {
        genres:      data.genres || [],
        styles:      data.styles || [],
        tracklist:   data.tracklist || [],
        discogs_uri: data.discogs_uri || null,
    };
    _renderDiscogsCard();
    window.colEditorToggleExtended(true);

    // Cover image comes back as base64 from the worker (it downloads
    // i.discogs.com server-side) rather than a URL the browser fetches
    // itself — that host sends no CORS allowance, so a direct fetch()
    // from here would fail silently every time. From here on it's
    // treated exactly like a user-picked photo, same upload/crop/reorder
    // path as everything else in _photos.
    if (data.image_base64 && _photos.length === 0) {
        try {
            const file = _base64ToFile(
                data.image_base64,
                data.image_content_type || 'image/jpeg',
                `discogs-${data.discogs_id}.jpg`
            );
            const compressed = await _compressImage(file);
            _photos.push({ kind: 'pending', file: compressed, previewUrl: URL.createObjectURL(compressed) });
            _renderPhotoPreviews();
        } catch (err) {
            console.log('[ColEditor] could not decode Discogs cover image:', err.message);
        }
    }
}

function _renderDiscogsCard() {
    const card = document.getElementById('col-editor-discogs-card');
    if (!card) return;

    if (!_discogsData) { card.classList.add('hidden'); return; }

    const genresStyles = [..._discogsData.genres, ..._discogsData.styles];
    const tagsHtml = genresStyles.length
        ? `<div class="flex flex-wrap gap-1.5 mb-3">${genresStyles.map(g => `
            <span class="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">${escapeHtml(g)}</span>`).join('')}</div>`
        : '';

    const tracklistHtml = _discogsData.tracklist.length
        ? `<ol class="space-y-1">${_discogsData.tracklist.map(t => `
            <li class="flex justify-between gap-3 text-[12px] text-slate-600">
                <span class="flex-1 truncate"><span class="font-black text-slate-400 mr-1.5">${escapeHtml(t.position)}</span>${escapeHtml(t.title)}</span>
                ${t.duration ? `<span class="flex-shrink-0 text-slate-400 tabular-nums">${escapeHtml(t.duration)}</span>` : ''}
            </li>`).join('')}</ol>`
        : '<p class="text-[12px] text-slate-400 italic">No tracklist available.</p>';

    card.innerHTML = `
        <p class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">From Discogs</p>
        ${tagsHtml}
        ${tracklistHtml}`;
    card.classList.remove('hidden');
}

function _wireLinkInput() {
    const input = document.getElementById('col-editor-link-input');
    if (!input || input._linkWired) return;
    input._linkWired = true;
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            window.colEditorAddLinkFromInput();
        }
    });
}

// Decodes a base64 string (from the worker's /lookup response) into a File,
// the same shape colEditorPhotoChange produces for a user-picked file — so
// everything downstream (compress, crop, upload) treats it identically.
function _base64ToFile(base64, contentType, filename) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: contentType });
}

function _wireDiscogsInput() {
    const input = document.getElementById('col-editor-discogs-input');
    if (!input || input._discogsWired) return;
    input._discogsWired = true;
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            window.colEditorLookupDiscogs();
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
                 onmousedown="event.preventDefault();document.getElementById('col-editor-format').value='${escapeHtml(m)}';document.getElementById('col-editor-format-list').classList.add('hidden')">${m}</li>`
        ).join('');
        dropdown.classList.toggle('hidden', !matches.length);
    });

    input.addEventListener('focus', () => {
        if (!input.value) {
            dropdown.innerHTML = opts.slice(0, 6).map(m =>
                `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors"
                     onmousedown="event.preventDefault();document.getElementById('col-editor-format').value='${escapeHtml(m)}';document.getElementById('col-editor-format-list').classList.add('hidden')">${m}</li>`
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
                 onmousedown="event.preventDefault();document.getElementById('col-editor-condition').value='${escapeHtml(m)}';document.getElementById('col-editor-condition-list').classList.add('hidden')">${m}</li>`
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

// Auto-fetched source images are tagged in their storage path as
// "-src-<name>-" by the collection-image-import Worker (e.g.
// ".../abc-src-discogs-172938-x9f2k.jpg"). Pure filename convention —
// no schema/state-shape change — so existing photos with no tag are
// just untagged user uploads.
const SOURCE_LABELS = { discogs: 'Discogs', weezerpedia: 'Weezerpedia', coverart: 'Cover Art' };
function _photoSource(path) {
    const m = /-src-([a-z]+)-/.exec(path || '');
    return m ? m[1] : null;
}

function _renderPhotoPreviews() {
    const container = document.getElementById('col-editor-photo-previews');
    if (!container) return;

    // Render every photo slot in order — index 0 is always the hero.
    const photosHtml = (_photos || []).map((p, i) => {
        const isHero  = i === 0;
        const isNew   = p.kind === 'pending';
        const src     = isNew ? p.previewUrl : p.url;
        const source  = p.kind === 'existing' ? _photoSource(p.path) : null;
        const badge   = isHero
            ? `<span class="absolute bottom-0 left-0 right-0 text-center text-[8px] font-black uppercase bg-black/50 text-white py-0.5">Hero</span>`
            : (isNew
                ? `<span class="absolute bottom-0 left-0 right-0 text-center text-[8px] font-black uppercase bg-amber-500/80 text-white py-0.5">New</span>`
                : (source
                    ? `<span class="absolute bottom-0 left-0 right-0 text-center text-[8px] font-black uppercase bg-slate-700/80 text-white py-0.5">${escapeHtml(SOURCE_LABELS[source] || source)}</span>`
                    : ''));
        // "Set as hero" star — only shown on non-hero slots
        const heroBtn = !isHero ? `
            <button type="button"
                    onclick="window.colEditorSetHeroPhoto(${i})"
                    aria-label="Set as hero photo"
                    title="Set as hero"
                    class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-amber-500 transition-colors">★</button>` : '';
        return `
        <div class="relative w-16 h-16 rounded-xl overflow-hidden border ${isNew ? 'border-amber-200' : 'border-slate-200'} flex-shrink-0 group">
            <img src="${src}" alt="Photo ${i + 1}" class="w-full h-full object-cover">
            ${badge}
            ${heroBtn}
            <button type="button"
                    onclick="window.colEditorRecropPhoto(${i})"
                    aria-label="Edit crop"
                    title="Re-crop"
                    class="absolute bottom-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[9px] flex items-center justify-center hover:bg-amber-500 transition-colors">✎</button>
            <button type="button"
                    onclick="window.colEditorRemovePhoto(${i})"
                    aria-label="Remove photo"
                    class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-red-500 transition-colors">×</button>
        </div>`;
    }).join('');

    const totalPhotos = _photos?.length || 0;

    // Small "+" Button: Specialized for Photo Library/Bulk Upload
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

    // Update the container
    container.innerHTML = `<div class="flex gap-2 flex-wrap items-center">${photosHtml}${addMore}</div>`;

    // Re-initialize icons if necessary
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Uploads every pending slot in _photos (in place) and stamps each one with
// the storage path it was uploaded to (p.uploadedPath). Order is preserved —
// callers build the final photos[] column by walking _photos afterwards.
async function _uploadPhotos(userId, itemId) {
    for (const p of _photos) {
        if (p.kind !== 'pending') continue;

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
            p.uploadedPath = path;
        }
    }
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

                    // Convert to HSL to boost saturation and control lightness
                    const rn = r / 255, gn = g / 255, bn = b / 255;
                    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
                    let h, s, l = (max + min) / 2;

                    if (max === min) {
                        h = s = 0;
                    } else {
                        const d = max - min;
                        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                        switch (max) {
                            case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
                            case gn: h = ((bn - rn) / d + 2) / 6; break;
                            default: h = ((rn - gn) / d + 4) / 6; break;
                        }
                    }

                    // Boost saturation, clamp lightness to a usable dark-mid range for spine
                    s = Math.min(1, s * 2.2);          // Boost saturation significantly
                    l = Math.min(0.45, Math.max(0.18, l * 0.75)); // Keep it mid-dark

                    // Convert back to RGB
                    const hue2rgb = (p, q, t) => {
                        if (t < 0) t += 1;
                        if (t > 1) t -= 1;
                        if (t < 1/6) return p + (q - p) * 6 * t;
                        if (t < 1/2) return q;
                        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                        return p;
                    };
                    let fr, fg, fb;
                    if (s === 0) {
                        fr = fg = fb = l;
                    } else {
                        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                        const p = 2 * l - q;
                        fr = hue2rgb(p, q, h + 1/3);
                        fg = hue2rgb(p, q, h);
                        fb = hue2rgb(p, q, h - 1/3);
                    }
                    r = Math.round(fr * 255);
                    g = Math.round(fg * 255);
                    b = Math.round(fb * 255);
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
    _links           = [...(item.links || [])];
    _photos          = [];
    _discogsId       = item.discogs_id || null;
    _discogsData     = item.discogs_data || null;
    _renderDiscogsCard();
    _setDiscogsStatus('');
    const discogsInput = document.getElementById('col-editor-discogs-input');
    if (discogsInput) discogsInput.value = '';

    _renderTypeToggle();
    _renderSubtypeSelector();
    _wireFormatSuggestions(_selectedSubtype);
    _wireConditionSuggestions();

    // Resolve signed URLs for existing photos, preserving stored order
    // (index 0 stays the hero).
    for (const path of (item.photos || [])) {
        const { data } = await supabase.storage
            .from('collection-photos')
            .createSignedUrl(path, 3600);
        if (data?.signedUrl) _photos.push({ kind: 'existing', path, url: data.signedUrl });
    }

    _val('col-editor-title',      item.title            || '');
    _val('col-editor-date',       item.item_date         || '');
    _val('col-editor-artist-ctx', item.artist_context    || '');

    // Populate acquired_date — stored as "YYYY-MM" or "YYYY"
    const acqYear  = document.getElementById('col-editor-acquired-year');
    const acqMonth = document.getElementById('col-editor-acquired-month');
    if (item.acquired_date) {
        const parts = item.acquired_date.split('-');
        if (acqYear)  acqYear.value  = parts[0] || '';
        if (acqMonth) acqMonth.value = parts[1] || '';
    } else {
        if (acqYear)  acqYear.value  = '';
        if (acqMonth) acqMonth.value = '';
    }
    _val('col-editor-body',       item.body              || '');
    _val('col-editor-notes',      item.notes             || '');
    _val('col-editor-label',      item.label             || '');
    _val('col-editor-cat-no',     item.catalogue_number  || '');
    _val('col-editor-format',     item.format            || '');
    _val('col-editor-signed-by',  item.signed_by         || '');
    _val('col-editor-provenance', item.provenance        || '');
    _val('col-editor-country',    item.country            || '');
    _val('col-editor-size',       item.size               || '');

    const condEl = document.getElementById('col-editor-condition');
    if (condEl) condEl.value = item.condition || '';

    // "No longer owned" — still_owned defaults true for rows that predate
    // this field. disposed_date follows the same "YYYY-MM"/"YYYY" convention
    // as acquired_date.
    const notOwnedEl   = document.getElementById('col-editor-not-owned');
    const disposedFields = document.getElementById('col-editor-disposed-fields');
    const stillOwned = item.still_owned !== false;
    if (notOwnedEl) notOwnedEl.checked = !stillOwned;
    if (disposedFields) disposedFields.classList.toggle('hidden', stillOwned);
    const dispMonthEl = document.getElementById('col-editor-disposed-month');
    const dispYearEl  = document.getElementById('col-editor-disposed-year');
    if (item.disposed_date) {
        const dParts = item.disposed_date.split('-');
        if (dispYearEl)  dispYearEl.value  = dParts[0] || '';
        if (dispMonthEl) dispMonthEl.value = dParts[1] || '';
    } else {
        if (dispYearEl)  dispYearEl.value  = '';
        if (dispMonthEl) dispMonthEl.value = '';
    }
    _val('col-editor-disposal-reason', item.disposal_reason || '');

    // Band combobox — pre-fill with stored band_name
    const bandInput = document.getElementById('col-editor-band-input');
    if (bandInput) bandInput.value = item.band_name || '';

    // Tagged buddies — resolve user IDs back to names from _buddyOptions
    _taggedBuddies = [];
    if (item.tagged_user_ids?.length) {
        for (const uid of item.tagged_user_ids) {
            const match = _buddyOptions.find(b => b.id === uid);
            if (match) {
                _taggedBuddies.push(match);
            } else {
                // Fallback: fetch profile name if not in buddy list
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('username, display_name')
                    .eq('id', uid)
                    .maybeSingle();
                if (profile) {
                    _taggedBuddies.push({
                        id:   uid,
                        name: profile.display_name || profile.username || uid,
                    });
                }
            }
        }
    }

    _renderLabels();
    _renderLinks();
    _renderBuddyTags();
    _renderPhotoPreviews();
    _updateFieldVisibility();

    // Auto-expand Extended Details when editing an item that already has
    // data in any extended field — otherwise editors would silently hide
    // existing values behind a collapsed "+ Add more details" toggle.
    const hasExtendedData = Boolean(
        item.format || item.catalogue_number || item.label || item.country || item.size ||
        item.condition || item.signed_by || item.provenance || item.notes ||
        item.acquired_date || item.still_owned === false ||
        (item.labels && item.labels.length) || (item.links && item.links.length)
    );
    window.colEditorToggleExtended(hasExtendedData);
}

// ─── BUDDY TAGGING ───────────────────────────────────────────────────────────

let _buddyOptions = []; // { id, name } — fetched once per editor open

async function _populateBuddySelector() {
    const input    = document.getElementById('col-editor-buddy-input');
    const dropdown = document.getElementById('col-editor-buddy-dropdown');
    if (!input || !dropdown) return;

    // window._following is populated by app.js from the buddies table
    // (same source buddies.js uses — { id, display_name, username })
    const following = window._following || [];

    if (following.length) {
        _buddyOptions = following.map(b => ({
            id:   b.id,
            name: b.display_name || b.username || b.id,
        })).sort((a, b) => a.name.localeCompare(b.name));
        _wireBuddyCombobox();
        return;
    }

    // Fallback: _following not yet populated — query buddies table directly
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data: rows } = await supabase
        .from('buddies')
        .select(`
            requester_id,
            addressee_id,
            requester:profiles!buddies_requester_id_fkey(id, username, display_name),
            addressee:profiles!buddies_addressee_id_fkey(id, username, display_name)
        `)
        .or(`requester_id.eq.${session.user.id},addressee_id.eq.${session.user.id}`)
        .eq('status', 'accepted');

    _buddyOptions = (rows || []).map(row => {
        // The buddy is whichever side isn't the current user
        const isBuddy = row.requester_id === session.user.id ? row.addressee : row.requester;
        return {
            id:   isBuddy.id,
            name: isBuddy.display_name || isBuddy.username || isBuddy.id,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));

    _wireBuddyCombobox();
}

function _renderBuddyTags() {
    const container = document.getElementById('col-editor-buddy-tags');
    if (!container) return;
    container.innerHTML = _taggedBuddies.map((b, i) => `
        <span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700">
            <span>👤</span>${b.name}
            <button type="button"
                    onclick="window._colEditorRemoveBuddy(${i})"
                    aria-label="Remove ${b.name}"
                    class="hover:text-red-500 transition-colors leading-none ml-0.5">×</button>
        </span>`).join('');
}

function _wireBuddyCombobox() {
    const input    = document.getElementById('col-editor-buddy-input');
    const dropdown = document.getElementById('col-editor-buddy-dropdown');
    if (!input || !dropdown || input._buddyWired) return;
    input._buddyWired = true;

    const _show = (matches) => {
        // Filter out already-tagged buddies
        const available = matches.filter(b => !_taggedBuddies.find(t => t.id === b.id));
        if (!available.length) { dropdown.classList.add('hidden'); return; }
        dropdown.innerHTML = available.map(b => `
            <li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-indigo-50 transition-colors flex items-center gap-2"
                onmousedown="event.preventDefault();window._colEditorTagBuddy('${b.id}','${b.name.replace(/'/g,"\\'")}')">
                <span class="text-base">👤</span>${b.name}
            </li>`).join('');
        dropdown.classList.remove('hidden');
    };

    input.addEventListener('focus', () => {
        const q = input.value.trim().toLowerCase();
        _show(q ? _buddyOptions.filter(b => b.name.toLowerCase().includes(q)) : _buddyOptions);
    });

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        _show(q ? _buddyOptions.filter(b => b.name.toLowerCase().includes(q)) : _buddyOptions);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') dropdown.classList.add('hidden');
        if (e.key === 'Enter') {
            e.preventDefault();
            const first = dropdown.querySelector('li');
            if (first && !dropdown.classList.contains('hidden')) {
                first.dispatchEvent(new MouseEvent('mousedown'));
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

window._colEditorTagBuddy = (id, name) => {
    if (_taggedBuddies.find(b => b.id === id)) return;
    _taggedBuddies.push({ id, name });
    const input = document.getElementById('col-editor-buddy-input');
    if (input) input.value = '';
    const dropdown = document.getElementById('col-editor-buddy-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    _renderBuddyTags();
};

window._colEditorRemoveBuddy = (i) => {
    _taggedBuddies.splice(i, 1);
    _renderBuddyTags();
};

// ─── FIELD VISIBILITY ─────────────────────────────────────────────────────────

/**
 * Memories only need title, date, body and photos.
 * Artefacts show the full catalogue fields.
 */
// Container element IDs for each subtype-gated field. Matches the markup
// in the modal template — each wraps a label + input as one toggle unit.
const FIELD_CONTAINER_ID = {
    format:           'col-editor-format-container',
    label:            'col-editor-label-container',
    catalogue_number: 'col-editor-catno-container',
    country:          'col-editor-country-container',
    size:             'col-editor-size-container',
    condition:        'col-editor-condition-container',
    signed_by:        'col-editor-signed-by-container',
    provenance:       'col-editor-provenance-container',
};

function _setHidden(id, hidden) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', hidden);
}

function _updateFieldVisibility() {
    const isMemory = _selectedType === 'memory';

    // Whole catalogue/extended-details section only applies to artefacts.
    const catalogueFields = document.getElementById('col-editor-catalogue-fields');
    if (catalogueFields) catalogueFields.classList.toggle('hidden', isMemory);

    // Buddy tag field is only meaningful on memories.
    _setHidden('col-editor-buddy-tag-field', !isMemory);

    const subtypeLabel = document.getElementById('col-editor-subtype-label');
    if (subtypeLabel) subtypeLabel.textContent = isMemory ? 'Memory type' : 'Item type';

    // Update placeholder on the main story/body field.
    const bodyEl = document.getElementById('col-editor-body');
    if (bodyEl) {
        bodyEl.placeholder = isMemory
            ? 'Tell the story…'
            : 'How you got it, what it means to you…';
    }

    if (isMemory) return; // nothing below applies to memories

    // Per-field visibility, driven by SUBTYPE_FIELD_RULES for the active subtype.
    const activeFields = SUBTYPE_FIELD_RULES[_selectedSubtype] || [];
    Object.entries(FIELD_CONTAINER_ID).forEach(([field, containerId]) => {
        _setHidden(containerId, !activeFields.includes(field));
    });

    // Whole-card visibility — collapse a card if none of its fields apply
    // to this subtype, so switching to e.g. "Ticket" doesn't leave an
    // empty Specs & Catalogue card sitting in the Extended view.
    const cardsWithVisibleFields = new Set(activeFields.map(f => FIELD_CARD[f]).filter(Boolean));
    _setHidden('col-editor-specs-card',     !cardsWithVisibleFields.has('specs'));
    _setHidden('col-editor-condition-card', !cardsWithVisibleFields.has('condition'));

    _updateExtendedToggleVisibility();
}

// If every field in the Extended section is irrelevant for this subtype AND
// there's nothing already filled in, hide the "Add more details" toggle
// itself rather than opening onto a mostly-empty extended view. Ownership
// and Tags & Links cards are always potentially useful, so the toggle only
// ever fully hides in the rare case those are also suppressed — in
// practice this just keeps the button from being visually misleading; it
// still always shows for now since Ownership/Tags & Links are universal.
function _updateExtendedToggleVisibility() {
    const toggleBtn = document.getElementById('col-editor-extended-toggle');
    if (toggleBtn) toggleBtn.classList.remove('hidden');
}

// Expand/collapse the Extended Details section. Called by the toggle
// button; also called with an explicit `open` value when populating an
// existing item so editors land on the right state (see _populateForm).
window.colEditorToggleExtended = (open) => {
    _extendedOpen = typeof open === 'boolean' ? open : !_extendedOpen;
    const section = document.getElementById('col-editor-extended-section');
    const btn     = document.getElementById('col-editor-extended-toggle');
    if (section) section.classList.toggle('hidden', !_extendedOpen);
    if (btn) btn.textContent = _extendedOpen ? '– Show less details' : '+ Add more details';
};

// ─── BAND COMBOBOX ────────────────────────────────────────────────────────────

let _bandOptions = []; // Cached band name list for this editor session

async function _populateBandSelector() {
    const input    = document.getElementById('col-editor-band-input');
    const dropdown = document.getElementById('col-editor-band-dropdown');
    if (!input || !dropdown) return;

    // Fetch from canonical artists table (shared across all users)
    const { data, error } = await supabase
        .from('artists')
        .select('name')
        .order('name');

    if (error) {
        console.error('Failed to load artists:', error);
        // Fall back to user's own journals if query fails
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            const { data: journalData } = await supabase
                .from('journals')
                .select('band')
                .eq('user_id', session.user.id)
                .order('band');
            _bandOptions = [...new Set((journalData || []).map(r => r.band).filter(Boolean))].sort();
        }
    } else {
        _bandOptions = data.map(a => a.name);
    }

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
                 data-band-name="">
                 — No band —</li>`,
            ...matches.map(m =>
                `<li class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-amber-50 transition-colors"
                     data-band-name="${escapeHtml(m)}">${escapeHtml(m)}</li>`
            ),
        ].join('');
        if (matches.length > 0 || !input.value.trim()) {
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    };

    // One delegated listener — band names come from the shared `artists`
    // table (Ticketmaster/setlist.fm sync, band-request approvals), so
    // unlike the format/condition suggestion lists above this is real
    // cross-user data and needs the same quote-safe handling as item titles.
    if (!dropdown._bandSelectWired) {
        dropdown._bandSelectWired = true;
        dropdown.addEventListener('mousedown', (e) => {
            const li = e.target.closest('[data-band-name]');
            if (!li) return;
            e.preventDefault();
            input.value = li.dataset.bandName;
            dropdown.classList.add('hidden');
        });
    }

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
    _photos          = [];
    _labels          = [];
    _links           = [];
    _taggedBuddies   = [];
    _labelCache      = null; // refresh label suggestions on each open
    _discogsId       = null;
    _discogsData     = null;
    _selectedType    = type || 'artefact';
    _selectedSubtype = 'cd';
    _extendedOpen    = false; // always start collapsed to Quick Add; _populateForm reopens it for edits with existing extended data
    window.colEditorToggleExtended(false);
    _hideError();

    const modal = document.getElementById('col-editor-modal');
    if (!modal) { console.error('[ColEditor] #col-editor-modal not found'); return; }

    const titleEl = document.getElementById('col-editor-modal-title');
    if (titleEl) titleEl.textContent = itemId ? 'Edit item' : 'Add to collection';

    const deleteBtn = document.getElementById('col-editor-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('hidden', !itemId);

    const saveBtn = document.getElementById('col-editor-save-btn');
    if (saveBtn) saveBtn.textContent = itemId ? 'Save changes' : 'Add to collection';

    // Populate band selector + buddy selector
    await Promise.all([_populateBandSelector(), _populateBuddySelector()]);

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
        _wireConditionSuggestions(); // idempotent (guarded by input._condWired) — must run
        // here too, not just in _populateForm/initCollectionEditor, in case the modal's
        // markup wasn't in the DOM yet when initCollectionEditor() ran on page load.
        _renderLabels();
        _links = [];
        _renderLinks();
        _wireLinkInput();
        _wireDiscogsInput();
        _renderPhotoPreviews();
        _updateFieldVisibility();
        _renderDiscogsCard();
        _setDiscogsStatus('');
        const discogsInput = document.getElementById('col-editor-discogs-input');
        if (discogsInput) discogsInput.value = '';

        ['col-editor-title','col-editor-date','col-editor-artist-ctx',
         'col-editor-body','col-editor-notes','col-editor-label','col-editor-cat-no',
         'col-editor-format','col-editor-signed-by','col-editor-provenance',
         'col-editor-country','col-editor-size','col-editor-disposal-reason',
         'col-editor-acquired-year','col-editor-disposed-year'].forEach(id => _val(id, ''));
        const condEl = document.getElementById('col-editor-condition');
        if (condEl) condEl.value = '';
        const acqMonthEl = document.getElementById('col-editor-acquired-month');
        if (acqMonthEl) acqMonthEl.value = '';
        const dispMonthEl = document.getElementById('col-editor-disposed-month');
        if (dispMonthEl) dispMonthEl.value = '';
        const notOwnedEl = document.getElementById('col-editor-not-owned');
        if (notOwnedEl) notOwnedEl.checked = false;
        const disposedFields = document.getElementById('col-editor-disposed-fields');
        if (disposedFields) disposedFields.classList.add('hidden');
        _taggedBuddies = [];
        _renderBuddyTags();
        const buddyInput = document.getElementById('col-editor-buddy-input');
        if (buddyInput) buddyInput.value = '';
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // Do NOT auto-focus the title field — on mobile this opens the keyboard immediately,
    // which is jarring. The photo tile is naturally the first tap on add.
    // document.getElementById('col-editor-title')?.focus();

    if (window.lucide) lucide.createIcons();
};

export const closeCollectionEditor = () => {
    const modal = document.getElementById('col-editor-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'auto';
    // Revoke any pending photo preview URLs (new or re-cropped, not yet uploaded)
    _photos.forEach(p => { if (p.kind === 'pending' && p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    _photos = [];
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

        // Read band name directly from combobox input
        const bandInput = document.getElementById('col-editor-band-input');
        const bandName = bandInput?.value.trim() || null;

        // 1. Resolve or Create artist_id BEFORE saving the collection item
        let artistId = null;
        if (bandName) {
            const { data: existingArtist } = await supabase
                .from('artists')
                .select('id')
                .ilike('name', bandName)
                .maybeSingle();

            if (existingArtist) {
                artistId = existingArtist.id;
            } else {
                // Insert new artist and retrieve returned ID
                const { data: newArtist, error: insertErr } = await supabase
                    .from('artists')
                    .insert({ name: bandName })
                    .select('id')
                    .single();

                if (!insertErr && newArtist) {
                    artistId = newArtist.id;
                    enrichNewArtist(bandName); // Hydrate MBID / Spotify metadata
                    _bandOptions = []; // Invalidate band cache
                }
            }
        }

        // Upload any pending photos (new adds or re-crops) in place, then walk
        // _photos in its current, user-controlled order — this is what makes
        // "set as hero" and re-cropping an existing photo just work, since the
        // final photos[] column always mirrors _photos' order directly rather
        // than assuming existing photos are an untouched prefix.
        await _uploadPhotos(session.user.id, itemId);
        const allPhotoPaths = _photos
            .map(p => p.kind === 'existing' ? p.path : p.uploadedPath)
            .filter(Boolean);

        // Only resample the spine colour when the hero slot is a new/re-cropped
        // file we have local pixels for. If the hero is unchanged, or was
        // reordered to an existing (already-uploaded) photo, leave hero_color
        // as-is rather than fetching the remote image back down.
        let heroColor = null;
        const heroPhoto = _photos[0];
        if (heroPhoto?.kind === 'pending') {
            heroColor = await _sampleHeroColor(heroPhoto.file);
        }

        const acquiredYear  = document.getElementById('col-editor-acquired-year')?.value?.trim() || '';
        const acquiredMonth = document.getElementById('col-editor-acquired-month')?.value || '';
        const acquiredDate  = acquiredYear
            ? (acquiredMonth ? `${acquiredYear}-${acquiredMonth}` : acquiredYear)
            : null;

        const notOwned      = document.getElementById('col-editor-not-owned')?.checked || false;
        const disposedYear  = document.getElementById('col-editor-disposed-year')?.value?.trim() || '';
        const disposedMonth = document.getElementById('col-editor-disposed-month')?.value || '';
        const disposedDate  = notOwned && disposedYear
            ? (disposedMonth ? `${disposedYear}-${disposedMonth}` : disposedYear)
            : null;

        const taggedUserIds = _taggedBuddies.map(b => b.id);

        // 2. Include artist_id in the row payload
        const row = {
            id:               itemId,
            user_id:          session.user.id,
            type:             _selectedType,
            subtype:          _selectedSubtype,
            title,
            artist_id:        artistId, // Ensures footer queries link correctly
            ...(bandName !== null && { band_name: bandName }),
            item_date:        _get('col-editor-date')       || null,
            acquired_date:    acquiredDate,
            artist_context:   _get('col-editor-artist-ctx') || null,
            body:             _get('col-editor-body')       || null,
            notes:            _get('col-editor-notes')      || null,
            label:            _get('col-editor-label')      || null,
            catalogue_number: _get('col-editor-cat-no')     || null,
            format:           _get('col-editor-format')     || null,
            condition:        document.getElementById('col-editor-condition')?.value || null,
            signed_by:        _get('col-editor-signed-by')  || null,
            provenance:       _get('col-editor-provenance') || null,
            country:          _get('col-editor-country')    || null,
            size:             _get('col-editor-size')       || null,
            still_owned:      !notOwned,
            disposed_date:    disposedDate,
            disposal_reason:  notOwned ? (_get('col-editor-disposal-reason') || null) : null,
            photos:           allPhotoPaths,
            labels:           _labels,
            links:            _links,
            tagged_user_ids:  taggedUserIds.length ? taggedUserIds : null,
            ...(heroColor && { hero_color: heroColor }),
            discogs_id:       _discogsId,
            discogs_data:     _discogsData,
        };

        const { error } = await supabase
            .from('collection_items')
            .upsert(row, { onConflict: 'id' });

        if (error) throw error;

        // Fire push notifications to each tagged buddy
        if (taggedUserIds.length && _selectedType === 'memory') {
            _notifyTaggedBuddies(session.user.id, itemId, title, taggedUserIds);
        }

        closeCollectionEditor();
        if (window.showToast) window.showToast(
            _editingId ? 'Item updated ✓' : 'Added to collection ✓',
            'success'
        );

        if (!_editingId) {
            window.dispatchEvent(new CustomEvent('giglist:collectionItemSaved'));
        }

        if (window._refreshCollection) window._refreshCollection();

        // Fire-and-forget: resolve any Discogs/Weezerpedia cover art for this
        // item in the background. The Worker is idempotent (skips sources it's
        // already fetched), so it's safe to call on every save rather than
        // only when links change. Never blocks the save or surfaces errors —
        // a failed image fetch shouldn't make the user think their save failed.
        _maybeImportSourceImages(itemId, session.user.id, _links);

    } catch (err) {
        console.error('[ColEditor] save failed:', err);
        _showError(err.message || 'Could not save item.');
    } finally {
        _setBusy(false);
    }
};

// ─── COVER ART IMPORT ────────────────────────────────────────────────────────

/**
 * Kicks off the collection-image-import Worker for this item, non-blocking.
 * Only fires when there's a Discogs or Weezerpedia link to work with — the
 * Worker itself also no-ops if it has nothing new to fetch, but skipping the
 * network call entirely here avoids a pointless request on every save of an
 * item with no such links.
 */
function _maybeImportSourceImages(itemId, userId, links) {
    const relevant = (links || []).filter(
        l => l.includes('discogs.com') || l.includes('weezerpedia.com')
    );
    if (!relevant.length) return;

    fetch(`${IMPORT_WORKER_URL}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userId, links: relevant }),
    }).catch(err => {
        console.warn('[ColEditor] cover art import failed (non-fatal):', err);
    });
}

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────

/**
 * Sends a push notification to each tagged buddy after saving a memory.
 * Delegates to the Cloudflare Worker (/push/webhook/memory-tag) so the Worker
 * handles subscription lookup and delivery — matching the buddy-request pattern.
 * Runs non-blocking — failures are logged but don't surface to the user.
 */
async function _notifyTaggedBuddies(taggerUserId, itemId, memoryTitle, buddyIds) {
    try {
        await fetch(`${PUSH_WORKER_URL}/push/webhook/memory-tag`, {
            method:  'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-webhook-secret':  'CLIENT_TRIGGER',   // ← see note below
            },
            body: JSON.stringify({
                record: {
                    tagger_id:    taggerUserId,
                    item_id:      itemId,
                    title:        memoryTitle,
                    buddy_ids:    buddyIds,
                },
            }),
        });
    } catch (e) {
        console.warn('[ColEditor] _notifyTaggedBuddies error:', e.message);
    }
}

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
    _updateFieldVisibility(); // subtype now drives which extended fields/cards show
};

// Opens the shared crop modal for one file and resolves with the cropped
// File, or null if the user cancels that photo (e.g. skip and move on to
// the next file rather than aborting the whole batch).
function _cropPhoto(file) {
    return new Promise((resolve) => {
        openPhotoCropModal(
            file,
            (croppedFile) => resolve(croppedFile),
            COLLECTION_PHOTO_CROP_ASPECT_RATIO,
            () => resolve(null),
        );
    });
}

window.colEditorPhotoChange = async (input) => {
    const files = Array.from(input.files || []);
    input.value = ''; // reset up front — the crop flow below can take a while

    for (const file of files) {
        if (_photos.length >= 8) break;
        const cropped = await _cropPhoto(file);
        if (!cropped) continue; // user cancelled this photo — skip to the next
        const compressed = await _compressImage(cropped);
        _photos.push({ kind: 'pending', file: compressed, previewUrl: URL.createObjectURL(compressed) });
        _renderPhotoPreviews();
    }
    _renderPhotoPreviews();
};

window.colEditorRemovePhoto = (index) => {
    const p = _photos[index];
    if (!p) return;
    if (p.kind === 'pending' && p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    _photos.splice(index, 1);
    _renderPhotoPreviews();
};

// Reopens the crop tool on a photo already in the list — existing (uploaded)
// or pending (just added this session) — and replaces that slot in place so
// its position (and hero status, if it's index 0) is preserved.
window.colEditorRecropPhoto = async (index) => {
    const entry = _photos[index];
    if (!entry) return;

    let sourceFile;
    if (entry.kind === 'pending') {
        sourceFile = entry.file;
    } else {
        try {
            const resp = await fetch(entry.url);
            if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
            const blob = await resp.blob();
            sourceFile = new File([blob], entry.path.split('/').pop() || 'photo.jpg', {
                type: blob.type || 'image/jpeg',
            });
        } catch (err) {
            console.error('[ColEditor] failed to load photo for re-crop:', err.message);
            _showError('Could not load that photo for editing — try again.');
            return;
        }
    }

    const cropped = await _cropPhoto(sourceFile);
    if (!cropped) return; // user cancelled — leave the existing slot untouched

    const compressed = await _compressImage(cropped);
    if (entry.kind === 'pending' && entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    _photos[index] = { kind: 'pending', file: compressed, previewUrl: URL.createObjectURL(compressed) };
    _renderPhotoPreviews();
};

// Moves a photo to the front of the list, making it the hero.
window.colEditorSetHeroPhoto = (index) => {
    if (index <= 0 || index >= _photos.length) return;
    const [chosen] = _photos.splice(index, 1);
    _photos.unshift(chosen);
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

// Links get no autocomplete (unlike labels, URLs aren't reused across items) —
// just trimmed, de-duped, and a light sanity check before being added.
window.colEditorAddLinkFromInput = () => {
    const input = document.getElementById('col-editor-link-input');
    if (!input) return;
    const trimmed = input.value.trim();
    if (!trimmed || _links.includes(trimmed)) { input.value = ''; return; }
    _links.push(trimmed);
    input.value = '';
    _renderLinks();
};

window.colEditorRemoveLink = (i) => {
    _links.splice(i, 1);
    _renderLinks();
};

// Shows/hides the disposed-date + reason fields when "No longer in my
// collection" is toggled. Does NOT clear their values on uncheck — if the
// user re-checks it, whatever they'd already typed is still there.
window.colEditorToggleDisposed = (checked) => {
    const fields = document.getElementById('col-editor-disposed-fields');
    if (fields) fields.classList.toggle('hidden', !checked);
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

export const initCollectionEditor = () => {
    _wireLabelInput();
    _wireLinkInput();
    _wireDiscogsInput();
    _wireConditionSuggestions();
    // Close modal on backdrop click
    const modal = document.getElementById('col-editor-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCollectionEditor();
        });
    }
};
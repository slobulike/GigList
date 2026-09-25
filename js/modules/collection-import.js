/**
 * GigList — Collection CSV Import Module
 * v1.0.0 — Sept 2026
 *
 * Bulk-imports collection_items from CSV exports of a collector's own
 * spreadsheet. Built against a real ~1,500-row collector spreadsheet with
 * 8 differently-shaped tabs (studio releases, singles, related artists,
 * memorabilia, bootlegs, a former/sold-items sheet with a date range and a
 * disposal reason instead of Comments) — so the mapping step is
 * deliberately flexible rather than assuming one fixed column layout.
 *
 * Flow: pick file(s) → map columns (per file) → review/exclude rows →
 * import. Files are processed one at a time in sequence so each gets its
 * own tailored mapping rather than forcing one merged schema across very
 * differently-shaped sheets. A CSV export flattens Google Sheets hyperlinks
 * to their display text (e.g. the literal word "Link"), so a mapped Link
 * column only keeps cells that already look like a real http(s) URL.
 *
 * Public API:
 *   initCollectionImport()   — no-op placeholder for symmetry with the
 *                              other modules' init pattern; everything
 *                              here is built fresh at open-time
 *
 * Window helpers (called from inline HTML):
 *   window.openCollectionImport()
 *   window.closeCollectionImport()
 *   window.colImportFilesChosen(input)
 *   window.colImportContinueToPreview()
 *   window.colImportBack()
 *   window.colImportSkipFile()
 *   window.colImportRunImport()
 */

import { supabase } from './supabase.js';
import { enrichNewArtist } from './artist-enrichment.js';
import { escapeHtml, normalizeArtist } from './utils.js';

// ─── TARGET FIELDS ──────────────────────────────────────────────────────────
// What a source column can be mapped to. 'subtype' and 'links' don't copy
// the cell text verbatim — 'subtype' runs it through the keyword detector
// below, 'links' is filtered down to cells that already look like a URL.
const TARGET_FIELDS = [
    { value: '',                label: 'Ignore' },
    { value: 'title',           label: 'Title' },
    { value: 'band_name',       label: 'Artist / band' },
    { value: 'format',          label: 'Format' },
    { value: 'subtype',         label: 'Item type (auto-detect)' },
    { value: 'item_date',       label: 'Year / release date' },
    { value: 'country',         label: 'Country' },
    { value: 'acquired_date',   label: 'Date acquired' },
    { value: 'acquired_range',  label: 'Date range owned (start – end)' },
    { value: 'provenance',      label: 'Where acquired' },
    { value: 'notes',           label: 'Notes (factual)' },
    { value: 'body',            label: 'Story / comments (personal)' },
    { value: 'size',            label: 'Size' },
    { value: 'disposal_reason', label: 'Reason no longer owned' },
    { value: 'links',           label: 'Link / URL' },
];

// Best-guess target field per source header, checked in order (first match
// wins) so more specific patterns are listed before their looser cousins.
const HEADER_GUESSES = [
    [/^title\s*\/?\s*item$/i, 'title'],
    [/^item$/i,               'title'],
    [/title/i,                'title'],
    [/feat\.?\s*artist/i,     'band_name'],
    [/assoc\.?\s*artist/i,    'band_name'],
    [/^artist$/i,             'band_name'],
    [/item\s*type/i,          'subtype'],
    [/^format$/i,             'format'],
    [/^type$/i,               'format'],
    [/^year$/i,               'item_date'],
    [/^country$/i,            'country'],
    [/date\s*owned/i,         'acquired_range'],
    [/date\s*acquired/i,      'acquired_date'],
    [/location\s*acquired/i,  'provenance'],
    [/^size$/i,               'size'],
    [/^notes?$/i,             'notes'],
    [/^comments?$/i,          'body'],
    [/^reason$/i,             'disposal_reason'],
    [/^links?$/i,             'links'],
];

function guessTargetField(header) {
    const h = (header || '').trim();
    for (const [re, field] of HEADER_GUESSES) {
        if (re.test(h)) return field;
    }
    return '';
}

// Keyword → subtype, checked in order (first match wins, so more specific
// keywords are listed before broader ones — e.g. 'tab book' before 'book').
// Mirrors the SUBTYPES.artefact list in collection-editor.js.
const SUBTYPE_KEYWORDS = [
    ['tab_book',    ['tab book', 'tablature', 'guitar tab']],
    ['laminate',    ['laminate', 'aaa pass', 'guest pass', 'crew pass']],
    ['ticket',      ['ticket']],
    ['minidisc',    ['minidisc', 'mini disc']],
    ['tape',        ['cassette', 'tape']],
    ['video',       ['dvd', 'vhs', 'blu-ray', 'bluray']],
    ['game',        ['xbox', 'nintendo', 'playstation', 'cartridge', 'video game']],
    ['vinyl',       ['vinyl', 'lp', '7"', '7 inch', '10"', '12"', 'picture disc', 'record']],
    ['cd',          ['cd']],
    ['apparel',     ['shirt', 'hoodie', 'sweatband', 'snuggie', ' tee', 't-shirt', 'jacket', 'cap', 'hat']],
    ['poster',      ['poster', 'table standee']],
    ['magazine',    ['magazine', 'zine']],
    ['book',        ['book', 'calendar', 'address book']],
    ['ephemera',    ['flyer', 'postcard', 'press kit', 'setlist', 'clipping', 'order sheet',
                      'wfc material', 'sticker', 'correspondence', 'paper craft']],
    ['memorabilia', ['keychain', 'kazoo', 'lollipop', 'lunchbox', 'rubik', 'tattoo', 'view-master',
                      'view master', 'bag', 'balloon', 'carrying case', 'flag', 'guitar', 'instrument',
                      'gift card', 'pocket protector', 'toy', 'fuzzy dice']],
];

function detectSubtype(text) {
    const t = (text || '').toLowerCase();
    if (!t) return 'other';
    for (const [subtype, keywords] of SUBTYPE_KEYWORDS) {
        if (keywords.some(k => t.includes(k))) return subtype;
    }
    return 'other';
}

// Some source spreadsheets/exports wrap text values in a literal quote pair
// (e.g. a title cell coming through as the 7 characters "Hash Pipe" quote
// marks included). Strip a SINGLE matching leading+trailing pair (straight
// or curly) — never touches a quote that's actually part of the text, or
// one side only (e.g. a title that's genuinely just "6'8"" — an inch mark).
function _cleanText(v) {
    let s = (v || '').toString().trim();
    if (s.length >= 2) {
        const first = s[0], last = s[s.length - 1];
        const pairs = { '"': '"', "'": "'", '\u201c': '\u201d', '\u2018': '\u2019' };
        if (pairs[first] === last) {
            const inner = s.slice(1, -1).trim();
            // Don't strip if the "pair" is really just doubled punctuation
            // with nothing between (e.g. an empty cell rendered as `""`).
            if (inner) s = inner;
        }
    }
    return s;
}

// Accepts MM/DD/YYYY (the common US/Discogs-export convention), ISO
// YYYY-MM-DD, or a bare year. Returns 'YYYY-MM' or 'YYYY' — same
// truncated-to-month convention the manual editor already uses for
// acquired_date, so imported and hand-entered items stay consistent.
function parseFlexibleDate(str) {
    if (!str) return null;
    const s = str.trim();
    if (!s) return null;
    if (/^\d{4}$/.test(s)) return s;
    const mdY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdY) return `${mdY[3]}-${mdY[1].padStart(2, '0')}`;
    const isoY = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
    if (isoY) return `${isoY[1]}-${isoY[2].padStart(2, '0')}`;
    return null;
}

// "08/24/2021 - 08/28/2021" → { start: '2021-08', end: '2021-08' }
function splitDateRange(str) {
    if (!str) return { start: null, end: null };
    const parts = str.split(/\s*[-–—]\s*/);
    return {
        start: parseFlexibleDate(parts[0]),
        end: parts.length > 1 ? parseFlexibleDate(parts[1]) : null,
    };
}

// ─── STATE ──────────────────────────────────────────────────────────────────

let _files       = [];   // [{ name, headers: [...], rows: [{header: value, ...}] }]
let _fileIndex   = 0;
let _mapping     = {};   // header -> target field, for the file currently being mapped
let _noLongerOwned = false;
let _defaultBandName = ''; // fallback band tag for the whole file, used when a row has no per-row band value (or no band column is mapped at all)
let _knownArtistNames = []; // cached for the datalist on the default-band input
let _parsedRows  = [];   // [{ raw: {...}, included: bool }] for the file in the preview step
let _importing   = false;
let _summary     = { imported: 0, skipped: 0, files: [] };

// ─── INIT ───────────────────────────────────────────────────────────────────

export const initCollectionImport = () => {
    // Nothing to pre-wire — the modal body is fully rebuilt at each step,
    // and its one delegated listener is attached lazily in _wireImportBody.
};

// ─── OPEN / CLOSE ───────────────────────────────────────────────────────────

window.openCollectionImport = () => {
    const modal = document.getElementById('col-import-modal');
    if (!modal) return;
    _files = [];
    _fileIndex = 0;
    _mapping = {};
    _noLongerOwned = false;
    _defaultBandName = '';
    _parsedRows = [];
    _importing = false;
    _summary = { imported: 0, skipped: 0, files: [] };

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    _renderStepPickFiles();

    // Fetch known artist names in the background for the default-band
    // input's autocomplete — non-blocking, fine if it lands after the
    // mapping step first renders.
    supabase.from('artists').select('name').then(({ data }) => {
        _knownArtistNames = (data || []).map(a => a.name).sort();
    });
};

window.closeCollectionImport = () => {
    const modal = document.getElementById('col-import-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = 'auto';
};

// ─── STEP: PICK FILES ───────────────────────────────────────────────────────

function _renderStepPickFiles() {
    _setTitle('Import your collection');
    _setBody(`
        <div class="space-y-4">
            <p class="text-[13px] text-slate-500 leading-relaxed">
                Export your spreadsheet as CSV — one file per tab if it has more than one —
                then pick them all here. You'll map each file's columns before anything gets imported.
            </p>
            <label class="flex flex-col items-center justify-center gap-2 py-8 rounded-2xl border-2 border-dashed cursor-pointer transition-all hover:border-amber-400 hover:bg-amber-50"
                   style="border-color:rgba(200,160,80,0.4);background:rgba(200,160,80,0.03)">
                <i data-lucide="upload" class="w-6 h-6" style="color:#c8a050" aria-hidden="true"></i>
                <span class="text-[12px] font-black" style="color:#c8a050">Choose CSV file(s)</span>
                <span class="text-[10px] text-slate-400">Multiple files OK</span>
                <input type="file" accept=".csv,text/csv" multiple class="hidden" onchange="window.colImportFilesChosen(this)">
            </label>
            <p id="col-import-error" class="text-[12px] text-red-500 font-bold hidden"></p>
        </div>
    `);
    _setFooter('');
}

window.colImportFilesChosen = async (input) => {
    const fileList = Array.from(input.files || []);
    if (!fileList.length) return;

    const errorEl = document.getElementById('col-import-error');
    if (errorEl) errorEl.classList.add('hidden');

    const parsed = [];
    for (const file of fileList) {
        const text = await file.text();
        const result = Papa.parse(text, { header: true, skipEmptyLines: true });
        const headers = result.meta.fields || [];
        // A pure prose/intro sheet (e.g. a "Wantlist" or notes tab) won't
        // have real tabular structure — skip it rather than trying to map it.
        if (headers.length < 2 || !result.data.length) continue;
        parsed.push({ name: file.name, headers, rows: result.data });
    }

    if (!parsed.length) {
        if (errorEl) {
            errorEl.textContent = "Couldn't find tabular data in those files — make sure you exported actual sheet tabs, not an overview or notes page.";
            errorEl.classList.remove('hidden');
        }
        return;
    }

    _files = parsed;
    _fileIndex = 0;
    _startFileMapping();
};

// ─── STEP: MAP COLUMNS ──────────────────────────────────────────────────────

function _startFileMapping() {
    const file = _files[_fileIndex];
    _mapping = {};
    file.headers.forEach(h => { _mapping[h] = guessTargetField(h); });
    // A sheet with a "Reason" or "Date Owned" column is very likely a
    // former/sold-items sheet rather than the current collection.
    _noLongerOwned = file.headers.some(h => /reason/i.test(h) || /date\s*owned/i.test(h));
    // Reset per-file — different tabs in the same export can be different
    // artists (e.g. a "Related Artists" sheet alongside the main one).
    _defaultBandName = '';
    _renderStepMapping();
}

function _renderStepMapping() {
    const file = _files[_fileIndex];
    const bandAlreadyMapped = Object.values(_mapping).includes('band_name');

    _setTitle(`Map columns — ${file.name}`);
    _setBody(`
        <div class="space-y-1">
            <p class="text-[11px] text-slate-400 font-bold mb-2">
                File ${_fileIndex + 1} of ${_files.length} · ${file.rows.length} rows
            </p>

            <div class="flex items-center gap-3 pb-1.5 border-b border-slate-200">
                <span class="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">Your column</span>
                <span class="text-[9px] font-black uppercase tracking-widest text-slate-400 flex-shrink-0" style="width:11.5rem">Import as</span>
            </div>

            ${file.headers.map(h => `
                <div class="flex items-center gap-3 py-2 border-b border-slate-100">
                    <span class="flex-1 text-[12px] font-black text-slate-700 truncate" title="${escapeHtml(h)}">${escapeHtml(h)}</span>
                    <select data-import-header="${escapeHtml(h)}"
                            class="text-[11px] font-bold px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-amber-400 flex-shrink-0">
                        ${TARGET_FIELDS.map(f => `<option value="${f.value}" ${_mapping[h] === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
                    </select>
                </div>
            `).join('')}

            <label class="flex items-center justify-between mt-4 p-3 rounded-2xl border border-slate-200 cursor-pointer">
                <span class="text-[11px] font-black uppercase tracking-widest text-slate-500">These are items I no longer own</span>
                <input type="checkbox" id="col-import-not-owned" ${_noLongerOwned ? 'checked' : ''}
                       class="w-5 h-5 rounded accent-[#c8a050] flex-shrink-0">
            </label>

            <div class="mt-3 p-3 rounded-2xl border border-slate-200 space-y-1.5">
                <label for="col-import-default-band" class="text-[11px] font-black uppercase tracking-widest text-slate-500">
                    Tag every item in this file with a band
                </label>
                <p class="text-[10px] text-slate-400 leading-relaxed">
                    ${bandAlreadyMapped
                        ? 'Used only for rows where the mapped Artist / band column above is blank.'
                        : "This sheet has no Artist / band column mapped — set one here so items aren't left untagged."}
                </p>
                <input type="text" id="col-import-default-band" list="col-import-artist-list"
                       value="${escapeHtml(_defaultBandName)}" placeholder="e.g. Weezer"
                       class="w-full text-[12px] font-bold px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-amber-400">
                <datalist id="col-import-artist-list">
                    ${_knownArtistNames.map(n => `<option value="${escapeHtml(n)}">`).join('')}
                </datalist>
            </div>
        </div>
    `);
    _setFooter(`
        <button onclick="window.colImportSkipFile()"
                class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">Skip this file</button>
        <button onclick="window.colImportContinueToPreview()"
                class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest text-white" style="background:#c8a050">Continue</button>
    `);
}

// ─── STEP: PREVIEW / EXCLUDE ROWS ───────────────────────────────────────────

window.colImportContinueToPreview = () => {
    const notOwnedEl = document.getElementById('col-import-not-owned');
    _noLongerOwned = notOwnedEl?.checked || false;
    const defaultBandEl = document.getElementById('col-import-default-band');
    _defaultBandName = _cleanText(defaultBandEl?.value) || '';

    const file = _files[_fileIndex];
    const mappedHeaders = file.headers.filter(h => _mapping[h]);

    _parsedRows = file.rows.map(raw => {
        const filledCount = mappedHeaders.filter(h => (raw[h] || '').toString().trim()).length;
        // A row with only one mapped field filled in is almost always a
        // section-header row (e.g. a bare "Compilations" label with every
        // other column blank) rather than a real item — pre-exclude it,
        // but leave it visible and easy to re-check if the guess is wrong.
        return { raw, included: filledCount > 1 };
    });

    _renderStepPreview();
};

function _renderStepPreview() {
    const file = _files[_fileIndex];
    const includedCount = _parsedRows.filter(r => r.included).length;
    const titleHeader = Object.keys(_mapping).find(h => _mapping[h] === 'title');
    const bandHeader  = Object.keys(_mapping).find(h => _mapping[h] === 'band_name');

    _setTitle(`Review — ${file.name}`);
    _setBody(`
        <div class="space-y-3">
            ${!titleHeader ? `<p class="text-[11px] text-amber-600 font-bold bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">No column mapped to Title — imported items will show as "Untitled".</p>` : ''}
            <label class="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-400 pb-2 border-b border-slate-100 cursor-pointer">
                <input type="checkbox" id="col-import-select-all" ${includedCount === _parsedRows.length ? 'checked' : ''} class="w-4 h-4 rounded accent-[#c8a050]">
                ${includedCount} of ${_parsedRows.length} rows will be imported
            </label>
            <p class="text-[10px] text-slate-400 leading-relaxed">
                Rows that look like section headers or blank spacer rows are unchecked automatically — scroll through and adjust anything that's wrong.
            </p>
            <div class="max-h-[42vh] overflow-y-auto divide-y divide-slate-100 -mx-1">
                ${_parsedRows.map((r, i) => `
                    <label class="flex items-center gap-3 py-2 px-1 ${r.included ? '' : 'opacity-40'}">
                        <input type="checkbox" data-import-row="${i}" ${r.included ? 'checked' : ''} class="w-4 h-4 rounded accent-[#c8a050] flex-shrink-0">
                        <span class="flex-1 min-w-0">
                            <span class="block text-[12px] font-black text-slate-700 truncate">${escapeHtml((titleHeader && r.raw[titleHeader]) || '(no title)')}</span>
                            ${(bandHeader && r.raw[bandHeader]) || _defaultBandName ? `<span class="block text-[10px] text-slate-400 truncate">${escapeHtml(_cleanText(r.raw[bandHeader]) || _defaultBandName)}</span>` : ''}
                        </span>
                    </label>
                `).join('')}
            </div>
        </div>
    `);
    _setFooter(`
        <button onclick="window.colImportBack()"
                class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">Back</button>
        <button onclick="window.colImportRunImport()"
                class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest text-white" style="background:#c8a050">Import ${includedCount} item${includedCount !== 1 ? 's' : ''}</button>
    `);
}

window.colImportBack = () => {
    _renderStepMapping();
};

window.colImportSkipFile = () => {
    _fileIndex += 1;
    if (_fileIndex < _files.length) _startFileMapping();
    else _renderStepDone();
};

// ─── ARTIST RESOLUTION (batched) ────────────────────────────────────────────

// One lookup pass + one bulk insert for every distinct name in the file,
// rather than a query per row — the same lookup-or-create the manual
// editor does for a single item, just batched.
async function _resolveArtists(names) {
    const map = new Map(); // normalizeArtist(name) -> artist id
    if (!names.length) return map;

    const { data: existing } = await supabase.from('artists').select('id, name');
    (existing || []).forEach(a => map.set(normalizeArtist(a.name), a.id));

    const missing = names.filter(n => !map.has(normalizeArtist(n)));
    if (!missing.length) return map;

    const { data: inserted, error } = await supabase
        .from('artists')
        .upsert(missing.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
        .select('id, name');

    if (!error && inserted) {
        inserted.forEach(a => map.set(normalizeArtist(a.name), a.id));
    }

    // ignoreDuplicates upserts don't reliably return pre-existing rows on
    // every PostgREST version — re-fetch anything still unresolved so a
    // race with another insert doesn't leave an item with no artist_id.
    const stillMissing = missing.filter(n => !map.has(normalizeArtist(n)));
    if (stillMissing.length) {
        const { data: refetched } = await supabase.from('artists').select('id, name').in('name', stillMissing);
        (refetched || []).forEach(a => map.set(normalizeArtist(a.name), a.id));
    }

    // Hydrate MBID/Spotify metadata for genuinely new artists in the
    // background — fire-and-forget with capped concurrency, so a big
    // import doesn't block on (or hammer) the Spotify API.
    const newlyCreatedNames = (inserted || []).map(a => a.name).filter(n => missing.includes(n));
    _enrichInBackground(newlyCreatedNames);

    return map;
}

function _enrichInBackground(names, concurrency = 3) {
    let idx = 0;
    async function worker() {
        while (idx < names.length) {
            const name = names[idx++];
            try { await enrichNewArtist(name); } catch (e) { /* best-effort — a missed Spotify image isn't worth surfacing an error for */ }
        }
    }
    Array.from({ length: Math.min(concurrency, names.length) }, worker);
}

// ─── RUN IMPORT ─────────────────────────────────────────────────────────────

window.colImportRunImport = async () => {
    if (_importing) return;
    _importing = true;

    const file = _files[_fileIndex];
    const includedRows = _parsedRows.filter(r => r.included);

    _setTitle(`Importing — ${file.name}`);
    _setBody(`<div class="py-12 text-center"><p class="text-[12px] font-bold text-slate-400">Importing ${includedRows.length} item${includedRows.length !== 1 ? 's' : ''}…</p></div>`);
    _setFooter('');

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in.');

        // Warn (don't block) on re-importing a filename that's already
        // been imported before.
        const { data: priorImports } = await supabase
            .from('collection_imports')
            .select('id, item_count')
            .eq('user_id', session.user.id)
            .eq('source_filename', file.name);

        if (priorImports?.length) {
            const total = priorImports.reduce((sum, p) => sum + (p.item_count || 0), 0);
            const proceed = await _confirmToast(
                `You've already imported "${file.name}" before (${total} item${total !== 1 ? 's' : ''}). Import it again?`,
                'Import anyway'
            );
            if (!proceed) { _importing = false; _renderStepPreview(); return; }
        }

        const headerFor = (target) => Object.keys(_mapping).find(h => _mapping[h] === target);
        const titleHeader      = headerFor('title');
        const bandHeader       = headerFor('band_name');
        const formatHeader     = headerFor('format');
        const subtypeHeader    = headerFor('subtype');
        const yearHeader       = headerFor('item_date');
        const countryHeader    = headerFor('country');
        const acquiredHeader   = headerFor('acquired_date');
        const rangeHeader      = headerFor('acquired_range');
        const provenanceHeader = headerFor('provenance');
        const notesHeader      = headerFor('notes');
        const bodyHeader       = headerFor('body');
        const sizeHeader       = headerFor('size');
        const reasonHeader     = headerFor('disposal_reason');
        const linkHeaders      = Object.keys(_mapping).filter(h => _mapping[h] === 'links');

        const namesInFile = new Set();
        includedRows.forEach(r => {
            const name = bandHeader ? _cleanText(r.raw[bandHeader]) : '';
            namesInFile.add(name || _defaultBandName || '');
        });
        namesInFile.delete('');
        const artistMap = await _resolveArtists([...namesInFile]);

        const { data: batch, error: batchErr } = await supabase
            .from('collection_imports')
            .insert({ user_id: session.user.id, source_filename: file.name, item_count: 0 })
            .select('id')
            .single();
        if (batchErr) throw batchErr;

        const rows = includedRows.map(r => {
            const raw = r.raw;
            const rowBandName = bandHeader ? _cleanText(raw[bandHeader]) || null : null;
            const bandName    = rowBandName || _defaultBandName || null;
            const formatText  = formatHeader ? _cleanText(raw[formatHeader]) : '';
            const subtypeText = subtypeHeader ? _cleanText(raw[subtypeHeader]) : '';

            let acquiredDate = null, disposedDate = null;
            if (rangeHeader) {
                const range = splitDateRange(raw[rangeHeader]);
                acquiredDate = range.start;
                disposedDate = range.end;
            } else if (acquiredHeader) {
                acquiredDate = parseFlexibleDate(raw[acquiredHeader]);
            }

            // A CSV export flattens a Google Sheets hyperlink to its
            // display text (often the literal word "Link") — only keep
            // cells that already look like a real URL.
            const links = linkHeaders
                .map(h => (raw[h] || '').trim())
                .filter(v => /^https?:\/\//i.test(v));

            return {
                id:               crypto.randomUUID(),
                user_id:          session.user.id,
                type:             'artefact',
                subtype:          detectSubtype(subtypeText || formatText),
                title:            (titleHeader && _cleanText(raw[titleHeader])) || 'Untitled',
                band_name:        bandName,
                artist_id:        bandName ? (artistMap.get(normalizeArtist(bandName)) || null) : null,
                format:           formatText || null,
                item_date:        yearHeader ? _cleanText(raw[yearHeader]) || null : null,
                country:          countryHeader ? _cleanText(raw[countryHeader]) || null : null,
                acquired_date:    acquiredDate,
                provenance:       provenanceHeader ? _cleanText(raw[provenanceHeader]) || null : null,
                notes:            notesHeader ? _cleanText(raw[notesHeader]) || null : null,
                body:             bodyHeader ? _cleanText(raw[bodyHeader]) || null : null,
                size:             sizeHeader ? _cleanText(raw[sizeHeader]) || null : null,
                still_owned:      !_noLongerOwned,
                disposed_date:    _noLongerOwned ? disposedDate : null,
                disposal_reason:  (_noLongerOwned && reasonHeader) ? _cleanText(raw[reasonHeader]) || null : null,
                links:            links.length ? links : null,
                import_batch_id:  batch.id,
            };
        });

        // Insert in chunks so one bad row's chunk doesn't sink the whole
        // import, and so the progress text has something to report.
        const CHUNK = 50;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            const { error: insertErr } = await supabase.from('collection_items').insert(chunk);
            if (insertErr) {
                console.error('[ColImport] chunk insert failed:', insertErr.message);
                continue;
            }
            inserted += chunk.length;
            _setBody(`<div class="py-12 text-center"><p class="text-[12px] font-bold text-slate-400">Importing… ${inserted} of ${rows.length}</p></div>`);
        }

        await supabase.from('collection_imports').update({ item_count: inserted }).eq('id', batch.id);

        _summary.imported += inserted;
        _summary.skipped  += (_parsedRows.length - includedRows.length) + (includedRows.length - inserted);
        _summary.files.push(file.name);

        _importing = false;
        _fileIndex += 1;
        if (_fileIndex < _files.length) _startFileMapping();
        else _renderStepDone();

    } catch (err) {
        _importing = false;
        console.error('[ColImport] import failed:', err);
        _setBody(`<div class="py-12 text-center space-y-3">
            <p class="text-[12px] font-bold text-red-500">Import failed: ${escapeHtml(err.message || 'Unknown error')}</p>
        </div>`);
        _setFooter(`<button onclick="window.colImportBack()" class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">Back</button>`);
    }
};

function _renderStepDone() {
    _setTitle('Import complete');
    _setBody(`
        <div class="py-8 text-center space-y-2">
            <div class="text-5xl">📦</div>
            <p class="text-sm font-black text-slate-700">${_summary.imported} item${_summary.imported !== 1 ? 's' : ''} added</p>
            ${_summary.skipped ? `<p class="text-[11px] text-slate-400">${_summary.skipped} row${_summary.skipped !== 1 ? 's' : ''} skipped</p>` : ''}
            <p class="text-[10px] text-slate-400">${_summary.files.length} file${_summary.files.length !== 1 ? 's' : ''} processed</p>
        </div>
    `);
    _setFooter(`<button onclick="window.closeCollectionImport()" class="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest text-white" style="background:#c8a050">Done</button>`);
    if (window._refreshCollection) window._refreshCollection();
}

// ─── MODAL CHROME HELPERS ───────────────────────────────────────────────────

function _setTitle(text) {
    const el = document.getElementById('col-import-title');
    if (el) el.textContent = text;
}

function _setBody(html) {
    const el = document.getElementById('col-import-body');
    if (el) el.innerHTML = html;
    _wireImportBody();
    if (window.lucide) lucide.createIcons();
}

function _setFooter(html) {
    const el = document.getElementById('col-import-footer');
    if (el) el.innerHTML = html;
}

// One delegated listener handles both the per-column mapping <select>s and
// the per-row checkboxes in the preview step — see utils.js's escapeHtml
// doc comment on why data-attributes are preferred over inline onclick
// handlers that would need to embed a possibly-quote-containing header string.
function _wireImportBody() {
    const body = document.getElementById('col-import-body');
    if (!body || body._importWired) return;
    body._importWired = true;

    body.addEventListener('change', (e) => {
        const mapSel = e.target.closest('[data-import-header]');
        if (mapSel) { _mapping[mapSel.dataset.importHeader] = mapSel.value; return; }

        const rowCb = e.target.closest('[data-import-row]');
        if (rowCb) {
            const idx = parseInt(rowCb.closest('[data-import-row]').dataset.importRow, 10);
            if (_parsedRows[idx]) _parsedRows[idx].included = rowCb.checked;
            const selectAll = document.getElementById('col-import-select-all');
            if (selectAll) selectAll.checked = _parsedRows.every(r => r.included);
            return;
        }

        if (e.target.id === 'col-import-select-all') {
            _parsedRows.forEach(r => { r.included = e.target.checked; });
            body.querySelectorAll('[data-import-row]').forEach(cb => { cb.checked = e.target.checked; });
        }
    });
}

function _confirmToast(message, confirmLabel = 'Confirm') {
    return new Promise(resolve => {
        const container = document.getElementById('toast-container');
        if (!container) { resolve(window.confirm(message)); return; }
        const toast = document.createElement('div');
        toast.className = 'pointer-events-auto flex items-center gap-3 bg-white border border-slate-200 shadow-xl px-5 py-3 rounded-2xl text-sm font-bold text-slate-700 max-w-xs';
        const yesId = 'col-import-yes-' + Date.now();
        const noId  = 'col-import-no-'  + Date.now();
        toast.innerHTML =
            `<span class="flex-1">${escapeHtml(message)}</span>` +
            `<button id="${yesId}" class="text-white px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex-shrink-0" style="background:#c8a050">${escapeHtml(confirmLabel)}</button>` +
            `<button id="${noId}" class="bg-slate-100 text-slate-600 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex-shrink-0">Cancel</button>`;
        container.appendChild(toast);
        document.getElementById(yesId).onclick = () => { toast.remove(); resolve(true); };
        document.getElementById(noId).onclick  = () => { toast.remove(); resolve(false); };
    });
}
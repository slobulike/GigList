/**
 * GigList - Collection Module
 * v1.0.0 — April 2026
 *
 * Renders the Collection tab — shelf view, drill-down (spine + grid),
 * curation strips, item detail bottom sheet, and buddy read support.
 *
 * Public API:
 *   init(currentUser)          — called from app.js when Collection tab activates
 *   refresh()                  — re-fetch and re-render (called after save)
 *
 * Window helpers (called from inline HTML):
 *   window._colOpenDrillDown(type)
 *   window._colCloseDrillDown()
 *   window._colSetView(view)          — 'spine' | 'grid'
 *   window._colOpenItem(id)
 *   window._colCloseItem()
 *   window._colSetCuration(key)
 *   window._colSetTypeFilter(subtype)
 *   window._colSetDrillFilter(filter)
 */

import { supabase } from './supabase.js';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _user          = null;
let _items         = [];          // All loaded collection_items
let _curations     = [];          // Saved user curations
let _bandNames     = [];          // Distinct band names for filter chips (from journals)
let _activeCuration = 'all';      // Current curation key
let _activeBandId  = null;        // null = all bands
let _drillType     = null;        // Currently open drill-down type
let _drillView     = 'spine';     // 'spine' | 'grid'
let _drillFilter   = 'all';       // Sub-filter within drill-down
let _searchQuery   = '';          // Current search string

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SUBTYPE_LABELS = {
    cd:          'CDs',
    vinyl:       'Vinyl',
    tape:        'Tapes',
    minidisc:    'MiniDisc',
    apparel:     'Apparel',
    poster:      'Posters',
    magazine:    'Magazines',
    book:        'Books',
    tab_book:    'Tab Books',
    ticket:      'Tickets',
    laminate:    'Laminates',
    other:       'Other',
};

const SUBTYPE_ICONS = {
    cd:          '💿',
    vinyl:       '🖤',
    tape:        '📼',
    minidisc:    '💽',
    apparel:     '👕',
    poster:      '🗒',
    magazine:    '🗞',
    book:        '📖',
    tab_book:    '🎸',
    ticket:      '🎟',
    laminate:    '🪪',
    other:       '✦',
};

// Colour palette for spines when no hero_color is set
// Derived consistently from title via _hashColor()
const SPINE_PALETTES = [
    ['#1e3a5f','#90b8e0'], ['#3d1a4a','#c090d8'], ['#1a3020','#80c090'],
    ['#4a2010','#d09060'], ['#1a1a3a','#9090d0'], ['#3a1a1a','#d08080'],
    ['#1a2a1a','#80b080'], ['#2a2a10','#c0c060'], ['#1a1a1a','#a0a0a0'],
    ['#2a1020','#d080a0'], ['#10202a','#60a0c0'], ['#201a10','#c0a060'],
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _hashColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return SPINE_PALETTES[h % SPINE_PALETTES.length];
}

function _esc(str) {
    return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function _yearsSpan(items) {
    const years = items
        .map(i => parseInt(i.item_date))
        .filter(y => !isNaN(y));
    if (!years.length) return 0;
    return Math.max(...years) - Math.min(...years);
}

/**
 * Formats stored acquired_date ("YYYY-MM" or "YYYY") into a readable string.
 * e.g. "1996-04" → "April 1996", "1996" → "1996"
 */
function _formatAcquiredDate(raw) {
    if (!raw) return '';
    const parts = raw.split('-');
    if (parts.length === 2 && parts[1]) {
        const months = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        const m = parseInt(parts[1], 10);
        const monthName = months[m - 1] || parts[1];
        return `${monthName} ${parts[0]}`;
    }
    return parts[0];
}

// ─── DATA FETCHING ────────────────────────────────────────────────────────────

async function _fetchItems(userId) {
    const { data, error } = await supabase
        .from('collection_items')
        .select('*')
        .eq('user_id', userId)
        .order('item_date', { ascending: true });

    if (error) {
        console.error('[Collection] fetch error:', error.message);
        return [];
    }
    const items = data || [];
    await _preloadSignedUrls(items);
    return items;
}

async function _fetchCurations(userId) {
    const { data, error } = await supabase
        .from('collection_curations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

    if (error) {
        console.debug('[Collection] curations fetch:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Derive band names from collection items only — so chips reflect what the
 * user actually has in their collection, not all their gig history.
 * Uses band_name where set; falls back to artist_context for older items.
 * No network call needed since _items is already loaded.
 */
async function _fetchBandNames(_userId) {
    const names = _items
        .map(i => i.band_name || null)
        .filter(Boolean);
    return [...new Set(names)].sort();
}

async function _fetchSignedUrl(storagePath) {
    const { data, error } = await supabase.storage
        .from('collection-photos')
        .createSignedUrl(storagePath, 3600);
    if (error) return null;
    return data?.signedUrl || null;
}

// Cache: storagePath → signedUrl. Populated once after fetch, reused across renders.
const _signedUrlCache = new Map();

/**
 * Pre-resolves signed URLs for all items that have photos.
 * Populates _signedUrlCache so synchronous render functions can use them.
 * Fires in parallel batches of 10 to avoid overwhelming storage API.
 */
async function _preloadSignedUrls(items) {
    const paths = [];
    items.forEach(item => {
        (item.photos || []).forEach(p => {
            if (p && !_signedUrlCache.has(p)) paths.push(p);
        });
    });
    if (!paths.length) return;

    // Batch in groups of 10
    for (let i = 0; i < paths.length; i += 10) {
        const batch = paths.slice(i, i + 10);
        await Promise.all(batch.map(async (path) => {
            const url = await _fetchSignedUrl(path);
            if (url) _signedUrlCache.set(path, url);
        }));
    }
}

// ─── FILTERING ────────────────────────────────────────────────────────────────

function _applyBandFilter(items) {
    if (!_activeBandId) return items;
    return items.filter(i => i.band_id === _activeBandId);
}

function _applyTypeFilter(items, type) {
    // type = 'artefact' | 'memory' | null (all)
    if (!type || type === 'all') return items;
    return items.filter(i => i.type === type);
}

function _applySubtypeFilter(items, subtype) {
    if (!subtype || subtype === 'all') return items;
    return items.filter(i => i.subtype === subtype);
}

function _applyCuration(items, curationKey) {
    if (!curationKey || curationKey === 'all') return items;

    // Band filter — key format: "band_<bandname>"
    // Matches band_name (set by the editor) or artist_context as a fallback
    // for items saved before band_name was introduced.
    if (curationKey.startsWith('band_')) {
        const name = curationKey.slice(5).toLowerCase();
        return items.filter(i =>
            (i.band_name || '').toLowerCase() === name ||
            (i.artist_context || '').toLowerCase().includes(name)
        );
    }

    // System curations
    if (curationKey === 'has_story')  return items.filter(i => i.body);
    if (curationKey === 'signed')     return items.filter(i => i.signed_by);
    if (curationKey === 'has_photos') return items.filter(i => i.photos?.length > 0);

    // Era curations — key format: "era_YYYY_YYYY"
    if (curationKey.startsWith('era_')) {
        const [, start, end] = curationKey.split('_').map(Number);
        return items.filter(i => {
            const y = parseInt(i.item_date);
            return !isNaN(y) && y >= start && y <= end;
        });
    }

    // Label curations — key format: "label_<labeltext>"
    if (curationKey.startsWith('label_')) {
        const label = curationKey.slice(6);
        return items.filter(i => i.labels?.includes(label));
    }

    // Saved curations — match by curation id
    const saved = _curations.find(c => c.id === curationKey);
    if (saved?.filter_json) {
        return _applySavedCuration(items, saved.filter_json);
    }

    return items;
}

function _applySavedCuration(items, filterJson) {
    let result = [...items];
    const f = filterJson;
    if (f.type)      result = result.filter(i => i.type === f.type);
    if (f.subtype)   result = result.filter(i => i.subtype === f.subtype);
    if (f.band_id)   result = result.filter(i => i.band_id === f.band_id);
    if (f.labels?.length) {
        result = result.filter(i => f.labels.every(l => i.labels?.includes(l)));
    }
    if (f.era) {
        const [start, end] = f.era.split('-').map(Number);
        result = result.filter(i => {
            const y = parseInt(i.item_date);
            return !isNaN(y) && y >= start && y <= end;
        });
    }
    if (f.flags?.has_story)   result = result.filter(i => i.body);
    if (f.flags?.is_signed)   result = result.filter(i => i.signed_by);
    if (f.flags?.has_photos)  result = result.filter(i => i.photos?.length > 0);
    return result;
}

// ─── CURATION CHIPS ──────────────────────────────────────────────────────────

function _buildCurationChips(items) {
    const chips = [{ key: 'all', label: 'All' }];

    // Band chips — one per unique band name, sourced from _bandNames
    // (fetched from journals + free-text band_name on items at init time).
    // These come first so they're the primary quick-filter.
    // TODO: if band count grows large (10+), consider a collapsible "By band"
    //       section or grouped curation strip rather than an ever-longer scroll.
    _bandNames.forEach(name => {
        chips.push({ key: `band_${name}`, label: name });
    });

    // System curations — only show if there's data
    if (items.some(i => i.body))       chips.push({ key: 'has_story',  label: 'Has a story' });
    if (items.some(i => i.signed_by))  chips.push({ key: 'signed',     label: 'Signed' });
    if (items.some(i => i.photos?.length > 0)) chips.push({ key: 'has_photos', label: 'With photos' });

    // Era chips — derive from item_dates
    const years = items.map(i => parseInt(i.item_date)).filter(y => !isNaN(y));
    if (years.length > 1) {
        const minY = Math.min(...years);
        const maxY = Math.max(...years);
        // Decade buckets
        const decades = new Set(years.map(y => Math.floor(y / 10) * 10));
        decades.forEach(d => {
            const end = Math.min(d + 9, maxY);
            if (items.some(i => { const y = parseInt(i.item_date); return y >= d && y <= end; })) {
                chips.push({ key: `era_${d}_${end}`, label: `${d}s` });
            }
        });
    }

    // Label chips — one per unique label value across all items
    const allLabels = new Set();
    items.forEach(i => (i.labels || []).forEach(l => allLabels.add(l)));
    allLabels.forEach(label => {
        chips.push({ key: `label_${label}`, label });
    });

    // Saved curations
    _curations.forEach(c => {
        chips.push({ key: c.id, label: c.name });
    });

    return chips;
}

function _renderCurationStrip(items, containerId, activeKey) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const chips = _buildCurationChips(items);
    el.innerHTML = chips.map(c => `
        <button onclick="window._colSetCuration('${_esc(c.key)}')"
                class="col-curation-chip flex-shrink-0 text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all whitespace-nowrap
                       ${c.key === activeKey
                            ? 'bg-[#111008] border-[#c8a050] text-[#c8a050]'
                            : 'bg-white border-slate-200 text-slate-500 hover:border-[#c8a050] hover:text-[#c8a050]'}">
            ${c.label}
        </button>
    `).join('');
}

// ─── SHELF RENDERING ─────────────────────────────────────────────────────────

/**
 * Pick items to show on a shelf for a given subtype.
 * Curated selection — not just first 5. Priority:
 *   1. Items with a story (body)
 *   2. Items with photos
 *   3. Items with signed_by
 *   4. Fill remainder randomly (seeded by day for consistency)
 */
function _curateShelf(items, max = 8) {
    const withStory  = items.filter(i => i.body);
    const withPhoto  = items.filter(i => !i.body && i.photos?.length > 0);
    const withSigned = items.filter(i => !i.body && !i.photos?.length && i.signed_by);
    const rest       = items.filter(i => !i.body && !i.photos?.length && !i.signed_by);

    // Day-seeded shuffle of remainder for variety
    const seed = new Date().getDate();
    const shuffled = [...rest].sort((a, b) =>
        ((a.title.charCodeAt(0) * seed) % 7) - ((b.title.charCodeAt(0) * seed) % 7)
    );

    return [...withStory, ...withPhoto, ...withSigned, ...shuffled].slice(0, max);
}

function _renderShelfItem(item) {
    const [bg, text] = item.hero_color
        ? [item.hero_color, '#f0deb0']
        : _hashColor(item.title);

    const isPortrait = ['poster', 'magazine', 'book', 'tab_book'].includes(item.subtype);
    const isRound    = item.subtype === 'vinyl';
    const isTape     = item.subtype === 'tape' || item.subtype === 'minidisc';

    const coverW = isPortrait ? '66px' : '88px';
    const coverH = isPortrait ? '88px' : isTape ? '60px' : '88px';
    const radius = isRound ? '50%' : '6px';

    const icon      = SUBTYPE_ICONS[item.subtype] || '✦';
    const hasStory  = item.body ? `<div class="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#c8a050]" title="Has a story"></div>` : '';
    const heroPath  = item.photos?.[0];
    const heroUrl   = heroPath ? _signedUrlCache.get(heroPath) : null;

    const coverInner = heroUrl
        ? `<img src="${heroUrl}" alt="${_esc(item.title)}"
                class="w-full h-full object-cover"
                style="border-radius:${radius}"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`+
          `<span style="font-size:22px;display:none;align-items:center;justify-content:center;width:100%;height:100%">${icon}</span>`
        : `<span style="font-size:22px">${icon}</span>`;

    return `
        <div class="flex-shrink-0 cursor-pointer" style="width:${coverW}" onclick="window._colOpenItem('${_esc(item.id)}')">
            <div class="relative flex items-center justify-center overflow-hidden"
                 style="width:${coverW};height:${coverH};border-radius:${radius};background:${bg};">
                ${coverInner}
                ${hasStory}
            </div>
            <p class="text-[11px] font-black text-slate-700 mt-1.5 leading-tight truncate" style="max-width:${coverW}">${item.title}</p>
            <p class="text-[10px] text-slate-400 truncate" style="max-width:${coverW}">${item.item_date || ''}</p>
        </div>`;
}

function _renderShelf(items, subtype) {
    const filtered  = items.filter(i => i.subtype === subtype);
    if (!filtered.length) return '';

    const curated   = _curateShelf(filtered);
    const label     = SUBTYPE_LABELS[subtype] || subtype;
    const showMore  = filtered.length > curated.length;

    return `
        <div class="mb-5">
            <div class="flex items-baseline justify-between mb-1">
                <button onclick="window._colOpenDrillDown('${subtype}')"
                        class="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-[#c8a050] transition-colors flex items-center gap-1">
                    ${label}
                    <i data-lucide="chevron-right" class="w-3 h-3" aria-hidden="true"></i>
                </button>
                <span class="text-[9px] text-slate-400">${filtered.length} item${filtered.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="col-shelf flex gap-2 overflow-x-auto pb-2 cursor-grab" style="scrollbar-width:none">
                ${curated.map(_renderShelfItem).join('')}
                ${showMore ? `
                <div class="flex-shrink-0 flex flex-col items-center justify-center cursor-pointer opacity-50 hover:opacity-100 transition-opacity"
                     style="width:66px" onclick="window._colOpenDrillDown('${subtype}')">
                    <div class="w-10 h-10 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center">
                        <i data-lucide="plus" class="w-4 h-4 text-slate-400"></i>
                    </div>
                    <p class="text-[9px] text-slate-400 mt-1 text-center">+${filtered.length - curated.length} more</p>
                </div>` : ''}
            </div>
            <div class="h-0.5 rounded-full mt-1" style="background:linear-gradient(90deg,rgba(200,160,80,0.2),rgba(200,160,80,0.04))"></div>
        </div>`;
}

// ─── MEMORIES RENDERING ──────────────────────────────────────────────────────

function _renderMemoryCard(item) {
    const dateLabel = item.acquired_date
        ? _formatAcquiredDate(item.acquired_date)
        : (item.item_date ? item.item_date.slice(0, 4) : '');
    const preview = (item.body || '').slice(0, 120) + (item.body?.length > 120 ? '…' : '');
    return `
        <div onclick="window._colOpenItem('${_esc(item.id)}')"
             class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 cursor-pointer
                    border-l-4 hover:border-l-[#c8a050] transition-all active:scale-[0.99]"
             style="border-left-color:rgba(200,160,80,0.5)">
            ${dateLabel ? `<p class="text-[9px] font-black uppercase tracking-widest mb-1" style="color:#c8a050">${dateLabel}</p>` : ''}
            <h3 class="text-sm font-black text-slate-800 leading-snug mb-1">${item.title}</h3>
            ${preview ? `<p class="text-[11px] text-slate-500 leading-relaxed italic">${preview}</p>` : ''}
            ${(item.labels || []).map(l =>
                `<span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 mr-1 mt-2">${l}</span>`
            ).join('')}
        </div>`;
}

// ─── STATS BAR ───────────────────────────────────────────────────────────────

function _renderStatsBar(items) {
    const artefacts = items.filter(i => i.type === 'artefact').length;
    const memories  = items.filter(i => i.type === 'memory').length;
    const bands     = new Set(items.map(i => i.band_id || i.band_name).filter(Boolean)).size;
    const years     = items.map(i => parseInt(i.item_date)).filter(y => !isNaN(y));
    const span      = years.length ? Math.max(...years) - Math.min(...years) : 0;

    return `
        <div class="grid grid-cols-4 gap-2 mb-4">
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Items</p>
                <p class="text-lg font-black text-[#c8a050]">${artefacts}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Memories</p>
                <p class="text-lg font-black text-slate-800">${memories}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Bands</p>
                <p class="text-lg font-black text-slate-800">${bands}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Years</p>
                <p class="text-lg font-black text-slate-800">${span || '—'}</p>
            </div>
        </div>`;
}

// ─── BAND FILTER STRIP ────────────────────────────────────────────────────────

function _renderBandStrip(items) {
    // Build unique bands from items that have a band_id
    // We don't have band names in collection_items — store band_name in item
    // For now use a Set of band_ids; label as band_id until we join.
    // In practice the editor will store band name too — see _renderBandStripFromWindow()
    const bandMap = new Map();
    items.forEach(i => {
        if (i.band_id && i.band_name) bandMap.set(i.band_id, i.band_name);
    });

    if (bandMap.size < 2) return ''; // No strip needed if only one band

    let html = `<div class="flex gap-2 overflow-x-auto pb-1 mb-4" style="scrollbar-width:none">`;
    html += `<button onclick="window._colSetBand(null)"
                     class="col-band-pill flex-shrink-0 text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all
                            ${!_activeBandId ? 'bg-[#111008] border-[#c8a050] text-[#c8a050]' : 'bg-white border-slate-200 text-slate-500'}">
                All
             </button>`;
    bandMap.forEach((name, id) => {
        html += `<button onclick="window._colSetBand(${id})"
                         class="col-band-pill flex-shrink-0 text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all
                                ${_activeBandId === id ? 'bg-[#111008] border-[#c8a050] text-[#c8a050]' : 'bg-white border-slate-200 text-slate-500'}">
                    ${name}
                 </button>`;
    });
    html += `</div>`;
    return html;
}

// ─── MAIN TAB RENDER ─────────────────────────────────────────────────────────

function _renderCollectionTab() {
    const container = document.getElementById('col-main-container');
    if (!container) return;

    const bandFiltered  = _applyBandFilter(_items);
    const curated       = _applyCuration(bandFiltered, _activeCuration);
    const searched      = _searchQuery ? curated.filter(i =>
        (i.title          || '').toLowerCase().includes(_searchQuery) ||
        (i.body           || '').toLowerCase().includes(_searchQuery) ||
        (i.label          || '').toLowerCase().includes(_searchQuery) ||
        (i.artist_context || '').toLowerCase().includes(_searchQuery) ||
        (i.provenance     || '').toLowerCase().includes(_searchQuery) ||
        (i.signed_by      || '').toLowerCase().includes(_searchQuery) ||
        (i.labels         || []).some(l => l.toLowerCase().includes(_searchQuery)) ||
        (i.band_name      || '').toLowerCase().includes(_searchQuery)
    ) : curated;
    const artefacts     = searched.filter(i => i.type === 'artefact');
    const memories      = searched.filter(i => i.type === 'memory');

    // Group artefacts by subtype — preserve a sensible display order
    const SUBTYPE_ORDER = ['vinyl', 'cd', 'tape', 'minidisc', 'apparel', 'poster', 'magazine', 'book', 'tab_book', 'ticket', 'laminate', 'other'];
    const presentSubtypes = SUBTYPE_ORDER.filter(s => artefacts.some(i => i.subtype === s));

    const emptyState = _items.length === 0 ? `
        <div class="text-center py-16 space-y-3">
            <div class="text-5xl">📦</div>
            <p class="text-sm font-black text-slate-700">Your collection starts here</p>
            <p class="text-[11px] text-slate-400 leading-relaxed max-w-xs mx-auto">Add your first item — a CD, a record, a poster, a memory. Just a photo is enough.</p>
        </div>` : '';

    container.innerHTML = `
        ${_renderStatsBar(_items)}

        ${_renderBandStrip(_items)}

        <!-- Curation strip -->
        <div id="col-curation-strip" class="flex gap-2 overflow-x-auto pb-2 mb-4" style="scrollbar-width:none"></div>

        <!-- Add buttons -->
        <div class="flex gap-3 mb-6">
            <button onclick="window.openCollectionEditor()"
                    class="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed border-slate-200 text-slate-500 text-[11px] font-black uppercase tracking-widest hover:border-[#c8a050] hover:text-[#c8a050] transition-all active:scale-95">
                <i data-lucide="plus" class="w-3.5 h-3.5" aria-hidden="true"></i>
                Add item
            </button>
            <button onclick="window.openCollectionEditor('memory')"
                    class="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed border-slate-200 text-slate-500 text-[11px] font-black uppercase tracking-widest hover:border-[#c8a050] hover:text-[#c8a050] transition-all active:scale-95">
                <i data-lucide="book-open" class="w-3.5 h-3.5" aria-hidden="true"></i>
                Add memory
            </button>
        </div>

        ${emptyState}

        <!-- Shelves by subtype -->
        ${presentSubtypes.map(s => _renderShelf(artefacts, s)).join('')}

        <!-- Memories section -->
        ${memories.length > 0 ? `
        <div class="mt-2">
            <div class="flex items-baseline justify-between mb-3">
                <p class="text-[10px] font-black uppercase tracking-widest text-slate-500">Memories</p>
                <span class="text-[9px] text-slate-400">${memories.length}</span>
            </div>
            <div class="space-y-3">
                ${memories.map(_renderMemoryCard).join('')}
            </div>
        </div>` : ''}
    `;

    // Render curation strip
    _renderCurationStrip(bandFiltered, 'col-curation-strip', _activeCuration);

    // Wire shelf swipe
    _initShelfSwipe();

    if (window.lucide) lucide.createIcons();
}

// ─── SHELF SWIPE ─────────────────────────────────────────────────────────────

function _initShelfSwipe() {
    document.querySelectorAll('.col-shelf').forEach(shelf => {
        if (shelf._swipeInit) return;
        shelf._swipeInit = true;

        let touchStartX = 0, touchScrollLeft = 0;
        shelf.addEventListener('touchstart', e => {
            touchStartX    = e.touches[0].pageX;
            touchScrollLeft = shelf.scrollLeft;
        }, { passive: true });
        shelf.addEventListener('touchmove', e => {
            shelf.scrollLeft = touchScrollLeft - (e.touches[0].pageX - touchStartX);
        }, { passive: true });

        let isDown = false, dragStartX = 0, dragScrollLeft = 0;
        shelf.addEventListener('mousedown', e => {
            isDown = true; dragStartX = e.pageX; dragScrollLeft = shelf.scrollLeft;
            shelf.style.cursor = 'grabbing';
        });
        shelf.addEventListener('mouseup',    () => { isDown = false; shelf.style.cursor = 'grab'; });
        shelf.addEventListener('mouseleave', () => { isDown = false; shelf.style.cursor = 'grab'; });
        shelf.addEventListener('mousemove', e => {
            if (!isDown) return;
            e.preventDefault();
            shelf.scrollLeft = dragScrollLeft - (e.pageX - dragStartX);
        });
    });
}

// ─── DRILL-DOWN ───────────────────────────────────────────────────────────────

function _renderSpine(item) {
    const [bg, text] = item.hero_color
        ? [item.hero_color, '#f0deb0']
        : _hashColor(item.title);

    const w = ['poster', 'magazine', 'book', 'tab_book'].includes(item.subtype) ? 14 : 18;

    return `
        <div onclick="window._colOpenItem('${_esc(item.id)}')"
             title="${item.title}"
             class="flex-shrink-0 rounded-sm cursor-pointer transition-transform hover:-translate-y-1 active:scale-95"
             style="height:120px;width:${w}px;background:${bg};">
            <span style="writing-mode:vertical-rl;transform:rotate(180deg);font-size:10px;font-weight:700;color:${text};
                         display:block;height:100%;padding:4px 2px;overflow:hidden;white-space:nowrap;
                         text-overflow:ellipsis;max-height:112px;letter-spacing:0.3px;">
                ${item.title}
            </span>
        </div>`;
}

function _renderGridCard(item) {
    const [bg] = item.hero_color ? [item.hero_color] : _hashColor(item.title);
    const icon     = SUBTYPE_ICONS[item.subtype] || '✦';
    const year     = item.item_date ? item.item_date.slice(0, 4) : '';
    const heroPath = item.photos?.[0];
    const heroUrl  = heroPath ? _signedUrlCache.get(heroPath) : null;

    const coverInner = heroUrl
        ? `<img src="${heroUrl}" alt="${_esc(item.title)}"
                class="w-full h-full object-cover absolute inset-0"
                onerror="this.style.display='none'">`
        : `<span class="text-3xl">${icon}</span>`;

    return `
        <div onclick="window._colOpenItem('${_esc(item.id)}')"
             class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm overflow-hidden cursor-pointer active:scale-[0.98] transition-all">
            <div class="w-full aspect-square flex items-center justify-center relative overflow-hidden" style="background:${bg}">
                ${coverInner}
            </div>
            <div class="p-3">
                <p class="text-[12px] font-black text-slate-800 truncate leading-tight">${item.title}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${year}${item.format ? ' · ' + item.format : ''}</p>
                ${item.body ? `<span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full mt-2" style="background:rgba(200,160,80,0.12);color:#c8a050">Story</span>` : ''}
                ${item.signed_by ? `<span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full mt-2 ml-1 bg-slate-100 text-slate-400">Signed</span>` : ''}
            </div>
        </div>`;
}

function _renderDrillDown(subtype) {
    const panel = document.getElementById('col-drill-panel');
    if (!panel) return;

    const allOfType  = _items.filter(i => i.subtype === subtype);
    const label      = SUBTYPE_LABELS[subtype] || subtype;

    // Sub-filters for this type
    const formats = [...new Set(allOfType.map(i => i.format).filter(Boolean))];

    // Apply drill filter
    let items = allOfType;
    if (_drillFilter !== 'all') {
        if (_drillFilter === 'has_story')  items = items.filter(i => i.body);
        else if (_drillFilter === 'signed') items = items.filter(i => i.signed_by);
        else items = items.filter(i => i.format === _drillFilter);
    }

    const spineHtml = items.map(_renderSpine).join('');
    const gridHtml  = items.map(_renderGridCard).join('');

    panel.innerHTML = `
        <!-- Header -->
        <div class="sticky top-0 bg-white/90 backdrop-blur-xl border-b border-slate-100 z-10 px-4 py-3 flex items-center gap-3">
            <button onclick="window._colCloseDrillDown()"
                    aria-label="Back to Collection"
                    class="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-all active:scale-95 flex-shrink-0">
                <i data-lucide="chevron-left" class="w-5 h-5" aria-hidden="true"></i>
            </button>
            <div class="flex-1 min-w-0">
                <p class="text-base font-black text-slate-900 leading-none">${label}</p>
                <p class="text-[10px] font-bold text-slate-400 mt-0.5">${allOfType.length} item${allOfType.length !== 1 ? 's' : ''}</p>
            </div>
            <!-- View toggle -->
            <div class="flex gap-1">
                <button onclick="window._colSetView('spine')"
                        aria-label="Spine view"
                        class="w-8 h-8 rounded-lg border flex items-center justify-center text-sm transition-all
                               ${_drillView === 'spine' ? 'border-[#c8a050] text-[#c8a050] bg-amber-50' : 'border-slate-200 text-slate-400'}">
                    ⫴
                </button>
                <button onclick="window._colSetView('grid')"
                        aria-label="Grid view"
                        class="w-8 h-8 rounded-lg border flex items-center justify-center text-sm transition-all
                               ${_drillView === 'grid' ? 'border-[#c8a050] text-[#c8a050] bg-amber-50' : 'border-slate-200 text-slate-400'}">
                    ⊞
                </button>
            </div>
        </div>

        <!-- Sub-filter strip -->
        <div class="flex gap-2 overflow-x-auto px-4 py-3 border-b border-slate-100" style="scrollbar-width:none">
            ${['all', 'has_story', 'signed', ...formats].map(f => {
                const flabel = f === 'all' ? 'All' : f === 'has_story' ? 'Has story' : f === 'signed' ? 'Signed' : f;
                return `<button onclick="window._colSetDrillFilter('${_esc(f)}')"
                                 class="flex-shrink-0 text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border transition-all whitespace-nowrap
                                        ${f === _drillFilter
                                            ? 'bg-[#111008] border-[#c8a050] text-[#c8a050]'
                                            : 'bg-white border-slate-200 text-slate-500'}">
                            ${flabel}
                        </button>`;
            }).join('')}
        </div>

        <!-- Content -->
        <div class="p-4 pb-32">
            <!-- Spine view -->
            <div id="col-spine-view" class="${_drillView === 'spine' ? '' : 'hidden'}">
                <div class="bg-[#0d0b07] rounded-2xl p-4 border" style="border-color:rgba(200,160,80,0.1)">
                    <p class="text-[9px] font-black uppercase tracking-widest mb-3" style="color:#5a4a28">
                        ${items.length} item${items.length !== 1 ? 's' : ''} · tap to open
                    </p>
                    <div class="flex flex-wrap gap-1">
                        ${spineHtml || '<p class="text-[11px] text-slate-500 italic">No items match this filter.</p>'}
                    </div>
                </div>
            </div>

            <!-- Grid view -->
            <div id="col-grid-view" class="${_drillView === 'grid' ? '' : 'hidden'}">
                <div class="grid grid-cols-2 gap-3">
                    ${gridHtml || '<p class="text-[11px] text-slate-500 italic col-span-2">No items match this filter.</p>'}
                </div>
            </div>
        </div>
    `;

    panel.classList.remove('translate-x-full');
    panel.setAttribute('aria-hidden', 'false');

    if (window.lucide) lucide.createIcons();
}

// ─── ITEM DETAIL BOTTOM SHEET ────────────────────────────────────────────────

function _renderItemDetail(item) {
    const sheet = document.getElementById('col-item-sheet');
    if (!sheet) return;

    const [bg] = item.hero_color ? [item.hero_color] : _hashColor(item.title);
    const icon  = SUBTYPE_ICONS[item.subtype] || '✦';
    const year  = item.item_date ? item.item_date.slice(0, 4) : '';
    const typeLabel = item.type === 'memory'
        ? (item.subtype || 'Memory')
        : (SUBTYPE_LABELS[item.subtype] || item.subtype || 'Item');

    const detailRows = [
        item.item_date     && { label: 'Released',        value: item.item_date },
        item.acquired_date && { label: 'Added to collection', value: _formatAcquiredDate(item.acquired_date) },
        item.format        && { label: 'Format',           value: item.format },
        item.label         && { label: 'Label',            value: item.label },
        item.catalogue_number && { label: 'Cat. no.',      value: item.catalogue_number },
        item.condition     && { label: 'Condition',        value: item.condition },
        item.signed_by     && { label: 'Signed by',        value: item.signed_by },
        item.provenance    && { label: 'Acquired',         value: item.provenance },
        item.artist_context && { label: 'Context',         value: item.artist_context },
    ].filter(Boolean);

    const labelsHtml = (item.labels || []).map(l =>
        `<span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 mr-1">${l}</span>`
    ).join('');

    // Tagged buddies — resolve names from _buddyOptions cache or show IDs
    const taggedIds = item.tagged_user_ids || [];
    const taggedHtml = taggedIds.length
        ? taggedIds.map(uid => {
            // Try to find a display name from the signed-in user's follows list
            const known = (window._buddyNamesCache || {})[uid];
            return `<span class="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700">
                <span aria-hidden="true">👤</span>
                <span data-buddy-id="${uid}">${known || '…'}</span>
            </span>`;
        }).join('')
        : '';

const heroPath  = item.photos?.[0];
const heroUrl   = heroPath ? _signedUrlCache.get(heroPath) : null;
const allPhotoUrls = (item.photos || []).map(p => _signedUrlCache.get(p)).filter(Boolean);

    sheet.innerHTML = `
        <div class="col-item-sheet-inner flex flex-col bg-white rounded-t-[2rem] w-full max-w-md mx-auto max-h-[85vh] overflow-hidden"
             onclick="event.stopPropagation()">

            <!-- Sticky handle + close bar — never scrolls -->
            <div class="flex-shrink-0 flex items-center justify-between px-5 pt-4 pb-3">
                <span class="text-[11px] font-black uppercase tracking-widest text-slate-400">
                    ${item.band_name || item.artist_context || typeLabel}
                </span>
                <button onclick="window._colCloseItem()"
                        aria-label="Close"
                        class="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all active:scale-95">
                    <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
                </button>
            </div>

            <!-- Scrollable body — overflow-y-auto on a plain non-rounded div so
                 the scrollbar track stays well within the card, never over the curves -->
            <div class="overflow-y-auto flex-1 pb-8">

            <!-- Header: artwork + title + edit pencil -->
            <div class="flex gap-4 px-5 mb-4 items-start">
                ${heroUrl ? `
                    <button onclick="window._colOpenLightbox('${heroUrl.replace(/'/g,"\'")}', ${allPhotoUrls.length})"
                            class="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 active:scale-95 transition-transform focus:outline-none"
                            aria-label="View photo">
                        <img src="${heroUrl}" alt="${_esc(item.title)}" class="w-full h-full object-cover">
                    </button>
                ` : `
                    <div class="w-16 h-16 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
                         style="background:${bg}">${icon}</div>
                `}

                <div class="flex-1 min-w-0">
                    <h2 class="text-lg font-black text-slate-900 leading-tight">${item.title}</h2>
                    <p class="text-[11px] text-slate-400 mt-0.5">${year}${item.label ? ' · ' + item.label : ''}</p>
                    <span class="inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full mt-1.5"
                          style="background:rgba(200,160,80,0.12);color:#c8a050">${typeLabel}</span>
                </div>
                ${window.currentUser?.id === item.user_id ? `
                <button onclick="window.openCollectionEditor(null, '${_esc(item.id)}')"
                        aria-label="Edit item"
                        class="flex-shrink-0 mt-1 w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all">
                    <i data-lucide="pencil" class="w-4 h-4" aria-hidden="true"></i>
                </button>` : ''}
            </div>

            <!-- Detail rows -->
            ${detailRows.length ? `
            <div class="px-5 divide-y divide-slate-100 mb-4">
                ${detailRows.map(r => `
                <div class="flex justify-between py-2.5">
                    <span class="text-[11px] text-slate-400 font-bold">${r.label}</span>
                    <span class="text-[12px] text-slate-800 font-bold text-right max-w-[60%]">${r.value}</span>
                </div>`).join('')}
            </div>` : ''}

            <!-- Story -->
            ${item.body ? `
            <div class="mx-5 mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-100"
                 style="border-left:3px solid rgba(200,160,80,0.5)">
                <p class="text-[9px] font-black uppercase tracking-widest mb-2" style="color:#c8a050">The story</p>
                <p class="text-[13px] text-slate-600 leading-relaxed italic">${item.body}</p>
            </div>` : ''}

            <!-- Labels -->
            ${labelsHtml ? `<div class="px-5 mb-5">${labelsHtml}</div>` : ''}

            <!-- Tagged buddies (memories) -->
            ${taggedHtml ? `
            <div class="px-5 mb-5">
                <p class="text-[9px] font-black uppercase tracking-widest mb-2 text-indigo-400">In this memory</p>
                <div class="flex flex-wrap gap-2">${taggedHtml}</div>
            </div>` : ''}

${allPhotoUrls.length > 0 ? `
<div class="px-5 mb-4">
    ${allPhotoUrls.length > 1 ? `<p class="text-[9px] font-black uppercase tracking-widest mb-2 text-slate-400">Photos</p>` : ''}
    <div class="flex gap-2 overflow-x-auto pb-1" style="scrollbar-width:none">
        ${allPhotoUrls.map((url, i) => `
            <button onclick="window._colOpenLightbox('${url.replace(/'/g,"\\'")}', ${allPhotoUrls.length})"
                    class="flex-shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-slate-100 active:scale-95 transition-transform focus:outline-none focus:ring-2 focus:ring-amber-400"
                    aria-label="View photo ${i + 1}">
                <img src="${url}" alt="Photo ${i + 1}" class="w-full h-full object-cover">
            </button>`).join('')}
    </div>
</div>` : ''}

            <!-- end scrollable body -->
            </div>
        </div>
    `;

    sheet.classList.remove('translate-y-full');
    sheet.setAttribute('aria-hidden', 'false');

    if (window.lucide) lucide.createIcons();

    // Async-resolve tagged buddy names (they may not be in cache yet)
    if (taggedIds.length) {
        _resolveBuddyNames(taggedIds, sheet);
    }
}

/**
 * Resolves display names for tagged buddy IDs and updates the rendered sheet.
 * Caches results in window._buddyNamesCache for subsequent opens.
 */
async function _resolveBuddyNames(ids, sheet) {
    if (!window._buddyNamesCache) window._buddyNamesCache = {};

    const unresolved = ids.filter(id => !window._buddyNamesCache[id]);
    if (unresolved.length) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, username')
            .in('id', unresolved);

        (profiles || []).forEach(p => {
            window._buddyNamesCache[p.id] = p.display_name || p.username || p.id;
        });
    }

    // Update any [data-buddy-id] spans still showing '…'
    ids.forEach(id => {
        const name = window._buddyNamesCache[id];
        if (!name) return;
        sheet.querySelectorAll(`[data-buddy-id="${id}"]`).forEach(el => {
            el.textContent = name;
        });
    });
}

// ─── LIGHTBOX ────────────────────────────────────────────────────────────────

/**
 * Opens a full-screen lightbox to view a photo at full size.
 * Tapping anywhere or the X button closes it.
 */
window._colOpenLightbox = (url, _total) => {
    const existing = document.getElementById('col-lightbox');
    if (existing) existing.remove();

    const lb = document.createElement('div');
    lb.id = 'col-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-label', 'Photo viewer');
    lb.className = [
        'fixed inset-0 z-[600]',
        'bg-black/90 backdrop-blur-sm',
        'flex items-center justify-center',
        'p-4',
    ].join(' ');

    lb.innerHTML = `
        <!-- X button -->
        <button onclick="document.getElementById('col-lightbox').remove()"
                aria-label="Close photo"
                class="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-all active:scale-95 z-10">
            <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
        </button>
        <!-- Photo -->
        <img src="${url}"
             alt="Full size photo"
             class="max-w-full max-h-full rounded-2xl object-contain shadow-2xl select-none"
             draggable="false">
    `;

    // Tap outside image closes
    lb.addEventListener('click', (e) => {
        if (e.target === lb) lb.remove();
    });

    document.body.appendChild(lb);
    if (window.lucide) lucide.createIcons();
};

// ─── WINDOW HELPERS ──────────────────────────────────────────────────────────

window._colOpenDrillDown = (subtype) => {
    _drillType  = subtype;
    _drillFilter = 'all';
    _renderDrillDown(subtype);
};

window._colCloseDrillDown = () => {
    const panel = document.getElementById('col-drill-panel');
    if (!panel) return;
    panel.classList.add('translate-x-full');
    panel.setAttribute('aria-hidden', 'true');
    _drillType = null;
};

window._colSetView = (view) => {
    _drillView = view;
    if (_drillType) _renderDrillDown(_drillType);
};

window._colSetDrillFilter = (filter) => {
    _drillFilter = filter;
    if (_drillType) _renderDrillDown(_drillType);
};

window._colOpenItem = (id) => {
    const item = _items.find(i => i.id === id);
    if (!item) return;
    _renderItemDetail(item);

    // Wire the sheet element itself as the dismiss backdrop.
    // The inner card stops propagation so only taps outside it trigger close.
    const sheet = document.getElementById('col-item-sheet');
    if (sheet) {
        sheet.style.display = 'flex';
        sheet.style.flexDirection = 'column';
        sheet.style.justifyContent = 'flex-end';
        if (!sheet._dismissWired) {
            sheet._dismissWired = true;
            sheet.addEventListener('click', () => window._colCloseItem());
        }
    }
};

window._colCloseItem = () => {
    const sheet = document.getElementById('col-item-sheet');
    if (!sheet) return;
    sheet.classList.add('translate-y-full');
    sheet.setAttribute('aria-hidden', 'true');
};

window._colSetCuration = (key) => {
    _activeCuration = key;
    _renderCollectionTab();
};

window._colSetBand = (bandId) => {
    _activeBandId = bandId;
    _renderCollectionTab();
};

window._colSearch = (query) => {
    _searchQuery = query.toLowerCase().trim();
    _renderCollectionTab();
};

// ─── BUDDY TAB SWITCHING ──────────────────────────────────────────────────────

/**
 * Called by buddies.js when the drill-in panel opens.
 * Resets the tab state to Gigs and clears the cached collection body
 * so it reloads fresh for the new buddy.
 */
window._buddyResetTabs = () => {
    const colBody = document.getElementById('buddy-collection-body');
    if (colBody) colBody.innerHTML = '';
    window._currentBuddyId = null;
    window._buddySwitchTab('gigs');
};

// ─── BUDDY ID RESOLVER ────────────────────────────────────────────────────────
// buddies.js sets #buddy-drill-name text content when it opens the panel, but
// doesn't expose the user_id. We watch for that text change and look up the
// profile by username so the Collection tab has the ID ready before it opens.
(function _watchBuddyPanel() {
    const nameEl = document.getElementById('buddy-drill-name');
    if (!nameEl) return;

    let _lastResolvedName = null;

    const observer = new MutationObserver(() => {
        const username = nameEl.textContent?.trim();
        if (!username || username === '--' || username === _lastResolvedName) return;
        _lastResolvedName = username;
        window._currentBuddyId = null; // clear while resolving

        // Try username first, fall back to display_name
        supabase
            .from('profiles')
            .select('id')
            .eq('username', username)
            .maybeSingle()
            .then(({ data, error }) => {
                if (!error && data?.id) return data;
                // Fallback: display_name match
                return supabase
                    .from('profiles')
                    .select('id')
                    .eq('display_name', username)
                    .maybeSingle()
                    .then(r => r.data);
            })
            .then(data => {
                if (data?.id) {
                    window._currentBuddyId = data.id;
                    const panel = document.getElementById('buddy-drill-in');
                    if (panel) panel.dataset.buddyId = data.id;
                } else {
                    console.warn('[Collection] Could not resolve buddy user_id for:', username);
                }
            })
            .catch(e => console.warn('[Collection] Buddy ID lookup error:', e.message));
    });

    observer.observe(nameEl, { childList: true, characterData: true, subtree: true });
})();

window._buddySwitchTab = (tab) => {
    const gigsPanel  = document.getElementById('buddy-panel-gigs');
    const colPanel   = document.getElementById('buddy-panel-collection');
    const gigsBtn    = document.getElementById('buddy-tab-gigs');
    const colBtn     = document.getElementById('buddy-tab-collection');

    const showGigs = tab === 'gigs';
    gigsPanel?.classList.toggle('hidden', !showGigs);
    colPanel?.classList.toggle('hidden', showGigs);

    if (gigsBtn) {
        gigsBtn.setAttribute('aria-selected', showGigs ? 'true' : 'false');
        gigsBtn.className = `flex-1 py-3 text-[11px] font-black uppercase tracking-widest border-b-2 transition-all
            ${showGigs ? 'text-indigo-600 border-indigo-600' : 'text-slate-400 border-transparent'}`;
    }
    if (colBtn) {
        colBtn.setAttribute('aria-selected', showGigs ? 'false' : 'true');
        colBtn.className = `flex-1 py-3 text-[11px] font-black uppercase tracking-widest border-b-2 transition-all
            ${!showGigs ? 'text-indigo-600 border-indigo-600' : 'text-slate-400 border-transparent'}`;
    }

    // Lazy-load collection on first open
    if (!showGigs) {
        const container = document.getElementById('buddy-collection-body');
        if (container && container.children.length === 0) {
            container.innerHTML = '<p class="text-sm text-slate-400 text-center py-16">Loading collection…</p>';
        }
        // The MutationObserver above resolves the buddy's user_id asynchronously
        // from the name set by buddies.js. Poll briefly to let it land.
        const panel = document.getElementById('buddy-drill-in');
        const _tryRender = (attemptsLeft) => {
            const buddyId = window._currentBuddyId || panel?.dataset?.buddyId;
            if (buddyId) {
                _renderBuddyCollection(buddyId, container);
            } else if (attemptsLeft > 0) {
                setTimeout(() => _tryRender(attemptsLeft - 1), 150);
            } else {
                container.innerHTML = `
                    <div class="text-center py-16 space-y-2">
                        <div class="text-4xl">🔍</div>
                        <p class="text-sm font-black text-slate-600">Couldn't load collection</p>
                        <p class="text-[11px] text-slate-400">Try closing and reopening this buddy's profile.</p>
                    </div>`;
            }
        };
        _tryRender(6); // up to ~900ms of retries
    }
};

/**
 * Renders a condensed read-only view of a buddy's collection.
 * Shows headline stats + photo grids grouped by item type.
 * No drill-down — browse only.
 */
async function _renderBuddyCollection(userId, container) {
    container.innerHTML = `<div class="animate-pulse space-y-4"><div class="h-20 bg-slate-200 rounded-2xl"></div><div class="h-48 bg-slate-200 rounded-2xl"></div></div>`;

    const { data, error } = await supabase
        .from('collection_items')
        .select('id, type, subtype, title, band_name, item_date, acquired_date, photos, hero_color, body, signed_by')
        .eq('user_id', userId)
        .order('item_date', { ascending: true });

    if (error || !data?.length) {
        container.innerHTML = `
            <div class="text-center py-16 space-y-2">
                <div class="text-4xl">📦</div>
                <p class="text-sm font-black text-slate-600">No collection yet</p>
                <p class="text-[11px] text-slate-400">This buddy hasn't added anything to their collection.</p>
            </div>`;
        return;
    }

    // Pre-load signed URLs for photos
    await _preloadSignedUrls(data);

    const artefacts = data.filter(i => i.type === 'artefact');
    const memories  = data.filter(i => i.type === 'memory');

    // Headline stats
    const bands = new Set(data.map(i => i.band_id || i.band_name).filter(Boolean)).size;
    const hasPhotos = data.filter(i => i.photos?.length > 0).length;
    const years = data.map(i => parseInt(i.item_date)).filter(y => !isNaN(y));
    const span  = years.length ? Math.max(...years) - Math.min(...years) : 0;

    const statsHtml = `
        <div class="grid grid-cols-4 gap-2 mb-5">
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Items</p>
                <p class="text-lg font-black text-[#c8a050]">${artefacts.length}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Memories</p>
                <p class="text-lg font-black text-slate-800">${memories.length}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Bands</p>
                <p class="text-lg font-black text-slate-800">${bands || '—'}</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 text-center">
                <p class="text-[8px] font-black uppercase text-slate-400">Span</p>
                <p class="text-lg font-black text-slate-800">${span ? span + 'y' : '—'}</p>
            </div>
        </div>`;

    // Photo grids by subtype — only subtypes that have items
    const SUBTYPE_ORDER = ['vinyl','cd','tape','minidisc','apparel','poster','magazine','book','tab_book','ticket','laminate','other'];
    const presentSubtypes = SUBTYPE_ORDER.filter(s => artefacts.some(i => i.subtype === s));

    const shelvesHtml = presentSubtypes.map(subtype => {
        const items = artefacts.filter(i => i.subtype === subtype);
        const label = SUBTYPE_LABELS[subtype] || subtype;
        const icon  = SUBTYPE_ICONS[subtype] || '✦';

        const photoGridHtml = items.map(item => {
            const [bg] = item.hero_color ? [item.hero_color] : _hashColor(item.title);
            const heroPath = item.photos?.[0];
            const heroUrl  = heroPath ? _signedUrlCache.get(heroPath) : null;
            const isRound  = item.subtype === 'vinyl';

            return `
                <div class="flex-shrink-0 text-center" style="width:72px">
                    <div class="w-[72px] h-[72px] flex items-center justify-center overflow-hidden text-xl"
                         style="background:${bg};border-radius:${isRound ? '50%' : '8px'}">
                        ${heroUrl
                            ? `<img src="${heroUrl}" alt="${_esc(item.title)}" class="w-full h-full object-cover" style="border-radius:${isRound ? '50%' : '8px'}">`
                            : icon}
                    </div>
                    <p class="text-[9px] font-bold text-slate-600 mt-1 leading-tight truncate">${item.title}</p>
                </div>`;
        }).join('');

        return `
            <div class="mb-5">
                <div class="flex items-baseline justify-between mb-2">
                    <p class="text-[10px] font-black uppercase tracking-widest text-slate-500">${label}</p>
                    <span class="text-[9px] text-slate-400">${items.length}</span>
                </div>
                <div class="flex gap-3 overflow-x-auto pb-2" style="scrollbar-width:none">
                    ${photoGridHtml}
                </div>
                <div class="h-0.5 rounded-full mt-1" style="background:linear-gradient(90deg,rgba(200,160,80,0.2),rgba(200,160,80,0.04))"></div>
            </div>`;
    }).join('');

    // Memories summary (no drill-in)
    const memoriesHtml = memories.length > 0 ? `
        <div class="mt-2">
            <div class="flex items-baseline justify-between mb-3">
                <p class="text-[10px] font-black uppercase tracking-widest text-slate-500">Memories</p>
                <span class="text-[9px] text-slate-400">${memories.length}</span>
            </div>
            <div class="space-y-2">
                ${memories.slice(0, 5).map(item => {
                    const year = item.item_date ? item.item_date.slice(0,4) : '';
                    return `
                    <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 border-l-4"
                         style="border-left-color:rgba(200,160,80,0.5)">
                        ${year ? `<p class="text-[9px] font-black uppercase tracking-widest mb-0.5" style="color:#c8a050">${year}</p>` : ''}
                        <p class="text-sm font-black text-slate-800">${item.title}</p>
                    </div>`;
                }).join('')}
                ${memories.length > 5 ? `<p class="text-[10px] text-slate-400 text-center">+${memories.length - 5} more memories</p>` : ''}
            </div>
        </div>` : '';

    container.innerHTML = statsHtml + shelvesHtml + memoriesHtml;
    if (window.lucide) lucide.createIcons();
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Called from app.js when the Collection tab is activated.
 * Uses sessionStorage cache keyed by user + item count to avoid
 * re-fetching on every tab switch.
 */
export async function init(currentUser) {
    _user        = currentUser;
    _searchQuery = ''; // Reset search on each tab init — stale query would hide all results

    // Also clear the search input visually if present
    const searchEl = document.getElementById('col-search-input');
    if (searchEl) searchEl.value = '';

    const container = document.getElementById('col-main-container');
    if (!container) return;

    // Show skeleton while loading
    container.innerHTML = `
        <div class="animate-pulse space-y-4 mt-4">
            <div class="h-20 bg-slate-200 rounded-2xl"></div>
            <div class="h-48 bg-slate-200 rounded-2xl"></div>
            <div class="h-48 bg-slate-200 rounded-2xl"></div>
        </div>`;

    [_items, _curations] = await Promise.all([
        _fetchItems(currentUser.id),
        _fetchCurations(currentUser.id),
    ]);

    // Fetch band names after items so _fetchBandNames can merge item band_names too
    _bandNames = await _fetchBandNames(currentUser.id);

    // Expose items globally so feed.js can build collection cards
    window._collectionItems = _items;

    _renderCollectionTab();
}

/**
 * Re-fetch and re-render — called after an item is saved or deleted.
 */
export async function refresh() {
    if (!_user) return;
    [_items, _curations] = await Promise.all([
        _fetchItems(_user.id),
        _fetchCurations(_user.id),
    ]);
    _bandNames = await _fetchBandNames(_user.id);
    // Keep window._collectionItems in sync so feed.js can read it
    window._collectionItems = _items;
    _renderCollectionTab();
    if (_drillType) _renderDrillDown(_drillType);
}
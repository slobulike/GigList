// filters.js — Data tab filter drawer
// OR logic within dimensions, AND logic across dimensions.
// Companion matching covers both gig_companions rows and legacy went_with text.
//
// The drawer is shared between modes. Personal and band mode filter
// window.journalData client-side (applyFilters). Community can't — its data
// lives server-side — so it borrows the drawer through attachFilterSource():
// options come from the source, changes go to the source's onChange, and the
// personal state is parked and restored on detach.

import { escapeHtml, normalizeArtist, parseActList } from './utils.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const _state = {
  open: false,
  years: new Set(),          // multi-select — OR within
  artist: '',                // typeahead text
  venue: '',                 // typeahead text
  companion: '',             // typeahead text
  festival: 'all',           // 'all' | 'headline' | 'festival'
  hasPhotos: 'all',          // 'all' | 'yes' | 'no'
  hasReview: 'all',          // 'all' | 'yes' | 'no'
  hasSetlist: 'all',         // 'all' | 'yes' | 'no'
};

// A view that borrows the drawer: { supports, years(), venues(), venueLabel?(value), onChange(state) }
let _source = null;
let _saved  = null;          // personal state, parked while a source is attached
let _hiddenSections = [];    // sections we hid for the source (detach un-hides only these)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initFilters() {
  _injectDrawerHTML();
  _bindEvents();
}

/**
 * Lets another view (Community) use the drawer. The drawer is reset to defaults,
 * sections the source doesn't list in `supports` are hidden, year/venue options
 * come from source.years() / source.venues(), and changes call
 * source.onChange(getFilterState()) instead of firing 'filtersChanged' (which
 * would re-render the personal table). Returns a detach function; it only acts
 * if this source is still the one attached, so a late dispose from an old pane
 * can't take the drawer away from a new one.
 */
export function attachFilterSource(source) {
  if (_source) _detach();
  _saved = { ..._state, years: new Set(_state.years) };
  _resetState();
  _source = source;
  _applySectionVisibility();
  _syncDrawerUI();
  _populateYearList();
  _populateLookupSelects();
  _syncToggleUI();
  _updateClearButton();
  return () => { if (_source === source) _detach(); };
}

function _detach() {
  _source = null;
  Object.assign(_state, _saved, { years: new Set(_saved.years), open: false });
  _saved = null;
  _hiddenSections.forEach(sec => sec.classList.remove('hidden'));
  _hiddenSections = [];
  _syncDrawerUI();
  _populateYearList();
  _populateLookupSelects();
  _syncToggleUI();
  _updateClearButton();
  // No change event: nothing personal was touched while the source was attached.
}

/** Snapshot of the current filter state (years sorted newest first). */
export function getFilterState() {
  return {
    years:      [..._state.years].sort((a, b) => b - a),
    artist:     _state.artist,
    venue:      _state.venue,
    companion:  _state.companion,
    festival:   _state.festival,
    hasPhotos:  _state.hasPhotos,
    hasReview:  _state.hasReview,
    hasSetlist: _state.hasSetlist,
  };
}

/** Re-reads the attached source's options (call after its facets load). */
export function refreshFilterOptions() {
  _populateYearList();
  _populateLookupSelects();
}

/** Returns a filtered copy of window.journalData based on current state. */
export function applyFilters(data) {
  let results = data;

  // Year — OR across selected years
  if (_state.years.size > 0) {
    results = results.filter(g => {
      const year = _parseYear(g.date);
      return year && _state.years.has(year);
    });
  }

  // Artist — matches headliner, festival lineup, or notable support.
  // A strict g.band-only match would silently exclude festival/support
  // appearances (e.g. selecting "Ash" would miss festival rows where Ash
  // played but the row's band is the festival name, not "Ash").
  if (_state.artist.trim()) {
    const q = normalizeArtist(_state.artist);
    results = results.filter(g => {
      if (normalizeArtist(g.band) === q) return true;

      // Lineup/support fields can list multiple artists — parse them with the
      // shared parser (utils.js) and check for an exact match per artist so
      // "Ash" doesn't match "Ashcroft", and "Hall & Oates" / "AC/DC" aren't
      // torn in half.
      const lineupArtists  = parseActList(g.festival_lineups, { splitCommas: false }).map(normalizeArtist);
      const supportArtists = parseActList(g.notable_support).map(normalizeArtist);

      return lineupArtists.includes(q) || supportArtists.includes(q);
    });
  }

  // Venue — exact match against official_venue or venue
  if (_state.venue.trim()) {
    const q = _state.venue.trim().toLowerCase();
    results = results.filter(g =>
      (g.official_venue || '').toLowerCase() === q ||
      (g.venue || '').toLowerCase() === q
    );
  }

  // Companion — exact match against individual entries in went_with
  if (_state.companion.trim()) {
    const q = _state.companion.trim().toLowerCase();
    results = results.filter(g => {
      const raw = (g.went_with || '').toLowerCase();
      // Split on common delimiters so "Ash" doesn't match "Dashboard Confessional"
      return raw.split(/[,;&]+/).map(s => s.trim()).includes(q);
    });
  }

  // Festival toggle
  if (_state.festival !== 'all') {
    const wantFestival = _state.festival === 'festival';
    results = results.filter(g => !!g.festival === wantFestival);
  }

  // Has photos
  if (_state.hasPhotos !== 'all') {
    const want = _state.hasPhotos === 'yes';
    results = results.filter(g => !!g.photos?.trim() === want);
  }

  // Has review URL
  if (_state.hasReview !== 'all') {
    const want = _state.hasReview === 'yes';
    results = results.filter(g => !!g.review_url?.trim() === want);
  }

  // Has setlist data. Reads both performance sources (personal mode fills
  // window._performances, band mode fills window.performanceData) and treats
  // the "no setlist" sentinels as missing — NOT_FOUND etc. used to count as
  // "has setlist". Keys are collected once per call (was a scan per row).
  if (_state.hasSetlist !== 'all') {
    const want = _state.hasSetlist === 'yes';
    const withSetlists = _journalKeysWithSetlists();
    results = results.filter(g => withSetlists.has(g.journal_key) === want);
  }

  return results;
}

const _NO_SETLIST = new Set(['', 'NOT_FOUND', 'NO_SONGS_LISTED', 'NO_SETLIST_FOUND', 'NAN', 'NONE', 'NULL']);

function _journalKeysWithSetlists() {
  const keys = new Set();
  const add = (p) => {
    const key = p.journal_key ?? p['Journal Key'];
    const sl  = String(p.setlist ?? p.Setlist ?? '').trim().toUpperCase();
    if (key && !_NO_SETLIST.has(sl)) keys.add(key);
  };
  (window._performances || []).forEach(add);
  (window.performanceData || []).forEach(add);
  return keys;
}

/** Returns true if any filter is currently active. */
export function hasActiveFilters() {
  return (
    _state.years.size > 0 ||
    _state.artist.trim() !== '' ||
    _state.venue.trim() !== '' ||
    _state.companion.trim() !== '' ||
    _state.festival !== 'all' ||
    _state.hasPhotos !== 'all' ||
    _state.hasReview !== 'all' ||
    _state.hasSetlist !== 'all'
  );
}

/**
 * Programmatically set one or more filter dimensions and clear everything
 * not explicitly passed — for chart-click "jump to this slice" interactions,
 * as distinct from the drawer's own click handlers which only ever touch
 * one dimension at a time. Treated as a fresh filter rather than additive,
 * so a stale artist/venue selection from earlier doesn't silently narrow
 * the result the user just clicked on.
 */
export function setFilters(overrides = {}) {
  _state.years      = overrides.years ? new Set(overrides.years) : new Set();
  _state.artist      = overrides.artist ?? '';
  _state.venue        = overrides.venue ?? '';
  _state.companion    = overrides.companion ?? '';
  _state.festival     = overrides.festival ?? 'all';
  _state.hasPhotos    = 'all';
  _state.hasReview    = 'all';
  _state.hasSetlist   = 'all';

  _syncDrawerUI();           // reset drawer visuals to defaults first...
  _populateYearList();       // ...then rebuild year chips so any selected year shows active
  _syncToggleUI();           // ...re-apply the toggles syncDrawerUI just reset
  _populateLookupSelects();  // ...and rebuild artist/venue/companion selects to reflect state

  _dispatchChange();
}

/** Convenience wrapper over setFilters for the year+festival case. */
export function setYearFilter(year, festivalValue = 'all') {
  setFilters({ years: [year], festival: festivalValue });
}

/** Returns a human-readable summary string for the active filters. */
export function buildSummaryLine(resultCount, totalCount) {
  if (!hasActiveFilters()) return '';

  const parts = [];

  const showCount = `${resultCount} show${resultCount !== 1 ? 's' : ''}`;
  parts.push(showCount);

  if (_state.years.size > 0) {
    const sorted = [..._state.years].sort((a, b) => b - a);
    parts.push(sorted.join(', '));
  }

  if (_state.artist.trim()) parts.push(_state.artist.trim());
  if (_state.venue.trim()) parts.push(_source?.venueLabel?.(_state.venue) ?? _state.venue.trim());
  if (_state.companion.trim()) parts.push(`with ${_state.companion.trim()}`);

  if (_state.festival === 'festival') parts.push('festivals');
  if (_state.festival === 'headline') parts.push('headline shows');

  if (_state.hasPhotos === 'yes') parts.push('with photos');
  if (_state.hasPhotos === 'no') parts.push('missing photos');

  if (_state.hasReview === 'yes') parts.push('with review');
  if (_state.hasReview === 'no') parts.push('no review');

  if (_state.hasSetlist === 'yes') parts.push('with setlist');
  if (_state.hasSetlist === 'no') parts.push('no setlist');

  return parts.join(' · ');
}

export function openFilterDrawer() {
  _state.open = true;
  _populateYearList();
  _populateLookupSelects();
  const drawer = document.getElementById('filter-drawer');
  const overlay = document.getElementById('filter-overlay');
  drawer?.classList.remove('translate-x-full');
  drawer?.classList.add('translate-x-0');
  overlay?.classList.remove('opacity-0', 'pointer-events-none');
  overlay?.classList.add('opacity-100');
}

export function closeFilterDrawer() {
  _state.open = false;
  const drawer = document.getElementById('filter-drawer');
  const overlay = document.getElementById('filter-overlay');
  drawer?.classList.remove('translate-x-0');
  drawer?.classList.add('translate-x-full');
  overlay?.classList.remove('opacity-100');
  overlay?.classList.add('opacity-0', 'pointer-events-none');
}

export function clearAllFilters() {
  _resetState();
  _syncDrawerUI();
  _dispatchChange();
}

function _resetState() {
  _state.years.clear();
  _state.artist = '';
  _state.venue = '';
  _state.companion = '';
  _state.festival = 'all';
  _state.hasPhotos = 'all';
  _state.hasReview = 'all';
  _state.hasSetlist = 'all';
}

// Hides drawer sections the attached source doesn't support
function _applySectionVisibility() {
  const supports = _source?.supports;
  if (!supports) return;
  document.querySelectorAll('#filter-drawer [data-filter-section]').forEach(sec => {
    if (supports.includes(sec.dataset.filterSection) || sec.classList.contains('hidden')) return;
    sec.classList.add('hidden');
    _hiddenSections.push(sec);
  });
}

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

function _injectDrawerHTML() {
  const html = `
    <!-- Filter drawer overlay -->
    <div id="filter-overlay"
         class="fixed inset-0 bg-black/40 z-[150] opacity-0 pointer-events-none transition-opacity duration-300"
         onclick="window._filtersModule.closeFilterDrawer()">
    </div>

    <!-- Filter drawer panel -->
    <div id="filter-drawer"
         class="fixed top-0 right-0 h-full w-full sm:w-80 bg-gray-900 border-l border-gray-700 z-[160]
                translate-x-full transition-transform duration-300 ease-in-out
                flex flex-col shadow-2xl">

      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-4 border-b border-gray-700 flex-shrink-0">
        <span class="text-sm font-semibold text-white tracking-wide uppercase">Filter Shows</span>
        <div class="flex items-center gap-3">
          <button id="filter-clear-all"
                  class="text-xs text-indigo-400 hover:text-indigo-300 hidden"
                  onclick="window._filtersModule.clearAllFilters()">
            Clear all
          </button>
          <button onclick="window._filtersModule.closeFilterDrawer()"
                  class="text-gray-400 hover:text-white transition-colors p-1 rounded">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Scrollable filter body -->
      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">

        <!-- Year -->
        <div data-filter-section="years">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Year</p>
          <div id="filter-year-list"
               class="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto pr-1">
            <!-- Populated dynamically -->
          </div>
        </div>

        <!-- Artist -->
        <div data-filter-section="artist" class="personal-only">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Artist</p>
          <select id="filter-artist-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All artists</option>
          </select>
        </div>

        <!-- Venue -->
        <div data-filter-section="venue">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Venue</p>
          <select id="filter-venue-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All venues</option>
          </select>
        </div>

        <!-- Companion -->
        <div data-filter-section="companion" class="personal-only">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Went With</p>
          <select id="filter-companion-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All companions</option>
          </select>
        </div>

        <!-- Festival toggle -->
        <div data-filter-section="festival">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Show Type</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-festival', 'all', 'All', true)}
            ${_triToggleBtn('filter-festival', 'headline', 'Headline', false)}
            ${_triToggleBtn('filter-festival', 'festival', 'Festival', false)}
          </div>
        </div>

        <!-- Has photos -->
        <div data-filter-section="photos" class="personal-only">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Photo Album</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-photos', 'all', 'All', true)}
            ${_triToggleBtn('filter-photos', 'yes', 'Has photos', false)}
            ${_triToggleBtn('filter-photos', 'no', 'Missing', false)}
          </div>
        </div>

        <!-- Has review -->
        <div data-filter-section="review" class="personal-only">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Review URL</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-review', 'all', 'All', true)}
            ${_triToggleBtn('filter-review', 'yes', 'Has review', false)}
            ${_triToggleBtn('filter-review', 'no', 'None', false)}
          </div>
        </div>

        <!-- Has setlist -->
        <div data-filter-section="setlist">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Setlist Data</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-setlist', 'all', 'All', true)}
            ${_triToggleBtn('filter-setlist', 'yes', 'Has setlist', false)}
            ${_triToggleBtn('filter-setlist', 'no', 'None', false)}
          </div>
        </div>

      </div>
    </div>
  `;

  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
}

function _triToggleBtn(group, value, label, active) {
  const activeClass = active
    ? 'bg-indigo-600 text-white'
    : 'bg-gray-800 text-gray-400 hover:bg-gray-700';
  return `<button
    data-filter-group="${group}"
    data-filter-value="${value}"
    class="flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${activeClass}"
    onclick="window._filtersModule._handleToggle('${group}', '${value}', this)">
    ${label}
  </button>`;
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function _bindEvents() {
  // Expose module on window so inline onclick handlers can reach it
  window._filtersModule = {
    openFilterDrawer,
    closeFilterDrawer,
    clearAllFilters,
    _handleToggle,
    setYearFilter,
    setFilters,
  };

  // Debounced select input handlers — wired after DOM injection
  setTimeout(() => {
    _bindSelectInput('filter-artist-input', 'artist');
    _bindSelectInput('filter-venue-input', 'venue');
    _bindSelectInput('filter-companion-input', 'companion');
  }, 0);
}

function _bindSelectInput(id, stateKey) {
  const el = document.getElementById(id);
  if (!el || el.dataset.bound) return;   // bind once — this used to stack a new listener on every drawer open
  el.dataset.bound = '1';
  el.addEventListener('change', () => {
    _state[stateKey] = el.value;
    _dispatchChange();
  });
}

// ---------------------------------------------------------------------------
// Toggle handler
// ---------------------------------------------------------------------------

function _handleToggle(group, value, btn) {
  // Update sibling button styles
  const siblings = document.querySelectorAll(`[data-filter-group="${group}"]`);
  siblings.forEach(b => {
    b.classList.remove('bg-indigo-600', 'text-white');
    b.classList.add('bg-gray-800', 'text-gray-400', 'hover:bg-gray-700');
  });
  btn.classList.remove('bg-gray-800', 'text-gray-400', 'hover:bg-gray-700');
  btn.classList.add('bg-indigo-600', 'text-white');

  // Update state
  const map = {
    'filter-festival': 'festival',
    'filter-photos':   'hasPhotos',
    'filter-review':   'hasReview',
    'filter-setlist':  'hasSetlist',
  };
  if (map[group]) _state[map[group]] = value;

  _dispatchChange();
}

// ---------------------------------------------------------------------------
// Year list
// ---------------------------------------------------------------------------

function _populateLookupSelects() {
  if (_source) {
    _fillSelect('filter-venue-input', _source.venues?.() || [], 'All venues', _state.venue);
    _bindSelectInput('filter-venue-input', 'venue');
    return;
  }

  const data = window.journalData;
  if (!data?.length) {
    // Nothing to offer (e.g. handing the drawer back with no personal data loaded)
    _fillSelect('filter-artist-input', [], 'All artists', '');
    _fillSelect('filter-venue-input', [], 'All venues', '');
    _fillSelect('filter-companion-input', [], 'All companions', '');
    return;
  }

  // Artists — unique sorted list from headliner, festival lineup, and
  // notable support fields, so artists only ever seen supporting or at
  // a festival are still selectable (matches how the Top Bands chart counts).
  const headliners = data.map(g => g.band || g.Band).filter(Boolean);
  const lineupArtists = data.flatMap(g => parseActList(g.festival_lineups, { splitCommas: false }));
  const supportArtists = data.flatMap(g => parseActList(g.notable_support));
  // De-dupe case-insensitively (first spelling wins, headliners first) so
  // "bike routes" and "Bike Routes" don't show as two options.
  const byKey = new Map();
  [...headliners, ...lineupArtists, ...supportArtists].forEach(name => {
    const key = normalizeArtist(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  });
  const artists = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  _fillSelect('filter-artist-input', artists, 'All artists', _state.artist);

  // Venues — unique sorted list from official_venue/venue
  const venues = [...new Set(data.map(g => g.official_venue || g.venue || g.OfficialVenue || g.Venue).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  _fillSelect('filter-venue-input', venues, 'All venues', _state.venue);

  // Companions — explode went_with on common delimiters, deduplicate, sort
  const companions = [...new Set(
    data.flatMap(g => (g.went_with || '').split(/[,;&]+/).map(s => s.trim()).filter(Boolean))
  )].sort((a, b) => a.localeCompare(b));
  _fillSelect('filter-companion-input', companions, 'All companions', _state.companion);

  // Re-bind change listeners (selects may have been re-rendered)
  _bindSelectInput('filter-artist-input', 'artist');
  _bindSelectInput('filter-venue-input', 'venue');
  _bindSelectInput('filter-companion-input', 'companion');
}

// options: strings, or { value, label } when the stored value differs from what's shown
function _fillSelect(id, options, placeholder, currentValue) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    options.map(o => {
      const { value, label } = typeof o === 'string' ? { value: o, label: o } : o;
      return `<option value="${escapeHtml(value)}"${value === currentValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}


function _populateYearList() {
  const container = document.getElementById('filter-year-list');
  if (!container) return;

  const years = _source
    ? (_source.years?.() || [])
    : [...new Set(
        (window.journalData || []).map(g => _parseYear(g.date)).filter(Boolean)
      )].sort((a, b) => b - a);

  container.innerHTML = years.map(year => {
    const active = _state.years.has(year);
    const activeClass = active
      ? 'bg-indigo-600 text-white border-indigo-500'
      : 'bg-gray-800 text-gray-300 border-gray-600 hover:border-gray-400';
    return `<button
      data-year="${year}"
      class="year-chip rounded-md border px-2 py-1 text-xs font-medium transition-colors ${activeClass}"
      onclick="window._filtersModule._handleYearChip(${year}, this)">
      ${year}
    </button>`;
  }).join('');

  // Expose year handler
  if (window._filtersModule) window._filtersModule._handleYearChip = _handleYearChip;
}

function _handleYearChip(year, btn) {
  if (_state.years.has(year)) {
    _state.years.delete(year);
    btn.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-500');
    btn.classList.add('bg-gray-800', 'text-gray-300', 'border-gray-600', 'hover:border-gray-400');
  } else {
    _state.years.add(year);
    btn.classList.remove('bg-gray-800', 'text-gray-300', 'border-gray-600', 'hover:border-gray-400');
    btn.classList.add('bg-indigo-600', 'text-white', 'border-indigo-500');
  }
  _dispatchChange();
}

// ---------------------------------------------------------------------------
// Sync drawer UI to state (called by clearAllFilters)
// ---------------------------------------------------------------------------

function _syncDrawerUI() {
  // Select inputs
  ['filter-artist-input', 'filter-venue-input', 'filter-companion-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Toggle groups — reset all to 'all'
  const groups = ['filter-festival', 'filter-photos', 'filter-review', 'filter-setlist'];
  groups.forEach(group => {
    document.querySelectorAll(`[data-filter-group="${group}"]`).forEach(btn => {
      const isAll = btn.dataset.filterValue === 'all';
      btn.classList.toggle('bg-indigo-600', isAll);
      btn.classList.toggle('text-white', isAll);
      btn.classList.toggle('bg-gray-800', !isAll);
      btn.classList.toggle('text-gray-400', !isAll);
      btn.classList.toggle('hover:bg-gray-700', !isAll);
    });
  });

  // Year chips
  document.querySelectorAll('.year-chip').forEach(btn => {
    btn.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-500');
    btn.classList.add('bg-gray-800', 'text-gray-300', 'border-gray-600', 'hover:border-gray-400');
  });
}

// Paints every tri-state toggle group from _state
function _syncToggleUI() {
  const stateKey = {
    'filter-festival': 'festival',
    'filter-photos':   'hasPhotos',
    'filter-review':   'hasReview',
    'filter-setlist':  'hasSetlist',
  };
  Object.entries(stateKey).forEach(([group, key]) => {
    document.querySelectorAll(`[data-filter-group="${group}"]`).forEach(btn => {
      const active = btn.dataset.filterValue === _state[key];
      btn.classList.toggle('bg-indigo-600', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('bg-gray-800', !active);
      btn.classList.toggle('text-gray-400', !active);
      btn.classList.toggle('hover:bg-gray-700', !active);
    });
  });
}

// ---------------------------------------------------------------------------
// Change dispatch — triggers re-render in app.js
// ---------------------------------------------------------------------------

function _updateClearButton() {
  // Show/hide the drawer's own internal "Clear all" button
  const clearBtn = document.getElementById('filter-clear-all');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !hasActiveFilters());
  }
}

function _dispatchChange() {
  _updateClearButton();

  // A borrowed drawer (Community): tell the owner directly. The personal
  // summary strips and the 'filtersChanged' listener in app.js work from
  // window.journalData and must not react to someone else's filters.
  if (_source) {
    _source.onChange?.(getFilterState());
    return;
  }

  // Filter-summary strip ("X of Y shows — Clear all") — driven from a
  // shared class rather than a single id, so every view that includes this
  // markup (Gigs, Stats, ...) is kept in sync from here rather than each
  // needing its own listener wired up separately in app.js.
  const active  = hasActiveFilters();
  const data    = window.journalData || [];
  const results = applyFilters(data);
  const summary = buildSummaryLine(results.length, data.length);

  document.querySelectorAll('.filter-summary-line').forEach(el => {
    el.classList.toggle('hidden', !active);
  });
  document.querySelectorAll('.filter-summary-text').forEach(el => {
    el.textContent = summary;
  });

  // Fire custom event — app.js listens and calls renderTable with filtered data
  document.dispatchEvent(new CustomEvent('filtersChanged'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _parseYear(dateStr) {
  // Expects DD/MM/YYYY
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const y = parseInt(parts[2], 10);
    return isNaN(y) ? null : y;
  }
  return null;
}
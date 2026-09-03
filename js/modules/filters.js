// filters.js — Data tab filter drawer
// OR logic within dimensions, AND logic across dimensions.
// Companion matching covers both gig_companions rows and legacy went_with text.

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initFilters() {
  _injectDrawerHTML();
  _bindEvents();
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
    const q = _state.artist.trim().toLowerCase();
    results = results.filter(g => {
      const band     = (g.band || '').toLowerCase();
      const lineup   = (g.festival_lineups || '').toLowerCase();
      const support  = (g.notable_support || '').toLowerCase();

      if (band === q) return true;

      // Lineup/support fields can list multiple artists — split and check
      // for an exact match per artist so "Ash" doesn't match "Ashcroft".
      const lineupArtists  = lineup.split(/[\/|]/).map(s => s.trim());
      const supportArtists = support.split(/[,;&/|]/).map(s => s.trim());

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

  // Has setlist data — check window._performances for matching journal_key
  if (_state.hasSetlist !== 'all') {
    const want = _state.hasSetlist === 'yes';
    results = results.filter(g => {
      const has = window._performances
        ? window._performances.some(p => p.journal_key === g.journal_key && p.setlist?.trim())
        : false;
      return has === want;
    });
  }

  return results;
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
  _syncFestivalToggleUI();   // ...re-apply the festival toggle syncDrawerUI just reset
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
  if (_state.venue.trim()) parts.push(_state.venue.trim());
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
  _state.years.clear();
  _state.artist = '';
  _state.venue = '';
  _state.companion = '';
  _state.festival = 'all';
  _state.hasPhotos = 'all';
  _state.hasReview = 'all';
  _state.hasSetlist = 'all';
  _syncDrawerUI();
  _dispatchChange();
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
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Year</p>
          <div id="filter-year-list"
               class="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto pr-1">
            <!-- Populated dynamically -->
          </div>
        </div>

        <!-- Artist -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Artist</p>
          <select id="filter-artist-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All artists</option>
          </select>
        </div>

        <!-- Venue -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Venue</p>
          <select id="filter-venue-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All venues</option>
          </select>
        </div>

        <!-- Companion -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Went With</p>
          <select id="filter-companion-input"
                  class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-indigo-500 transition-colors">
            <option value="">All companions</option>
          </select>
        </div>

        <!-- Festival toggle -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Show Type</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-festival', 'all', 'All', true)}
            ${_triToggleBtn('filter-festival', 'headline', 'Headline', false)}
            ${_triToggleBtn('filter-festival', 'festival', 'Festival', false)}
          </div>
        </div>

        <!-- Has photos -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Photo Album</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-photos', 'all', 'All', true)}
            ${_triToggleBtn('filter-photos', 'yes', 'Has photos', false)}
            ${_triToggleBtn('filter-photos', 'no', 'Missing', false)}
          </div>
        </div>

        <!-- Has review -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Review URL</p>
          <div class="flex rounded-lg overflow-hidden border border-gray-600">
            ${_triToggleBtn('filter-review', 'all', 'All', true)}
            ${_triToggleBtn('filter-review', 'yes', 'Has review', false)}
            ${_triToggleBtn('filter-review', 'no', 'None', false)}
          </div>
        </div>

        <!-- Has setlist -->
        <div>
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
  if (!el) return;
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
  const data = window.journalData;
  if (!data?.length) return;

  // Artists — unique sorted list from headliner, festival lineup, and
  // notable support fields, so artists only ever seen supporting or at
  // a festival are still selectable (matches how the Top Bands chart counts).
  const headliners = data.map(g => g.band || g.Band).filter(Boolean);
  const lineupArtists = data.flatMap(g =>
    (g.festival_lineups || '').split(/[\/|]/).map(s => s.trim()).filter(Boolean)
  );
  const supportArtists = data.flatMap(g =>
    (g.notable_support || '').split(/[,;&/|]/).map(s => s.trim()).filter(Boolean)
  );
  const artists = [...new Set([...headliners, ...lineupArtists, ...supportArtists])].sort((a, b) => a.localeCompare(b));
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

function _fillSelect(id, options, placeholder, currentValue) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    options.map(o => `<option value="${o.replace(/"/g, '&quot;')}"${o === currentValue ? ' selected' : ''}>${o}</option>`).join('');
}


function _populateYearList() {
  const container = document.getElementById('filter-year-list');
  if (!container || !window.journalData?.length) return;

  const years = [...new Set(
    window.journalData.map(g => _parseYear(g.date)).filter(Boolean)
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
  window._filtersModule._handleYearChip = _handleYearChip;
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

function _syncFestivalToggleUI() {
  document.querySelectorAll('[data-filter-group="filter-festival"]').forEach(btn => {
    const active = btn.dataset.filterValue === _state.festival;
    btn.classList.toggle('bg-indigo-600', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-gray-800', !active);
    btn.classList.toggle('text-gray-400', !active);
    btn.classList.toggle('hover:bg-gray-700', !active);
  });
}

// ---------------------------------------------------------------------------
// Change dispatch — triggers re-render in app.js
// ---------------------------------------------------------------------------

function _dispatchChange() {
  // Show/hide the drawer's own internal "Clear all" button
  const clearBtn = document.getElementById('filter-clear-all');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !hasActiveFilters());
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
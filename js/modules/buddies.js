/**
 * GigList — Buddies Module
 * Handles the Buddies tab: tile rendering, drill-in panel,
 * buddy data fetching, and read-only gig modal integration.
 */

import { supabase } from './supabase.js';
import * as Charts from './charts.js';
import * as UI from './ui.js';
import { sortGigs } from './data.js';
import { renderCalendar } from './calendar.js';

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _activeBuddyId   = null;   // uuid of the buddy currently open in drill-in
let _activeBuddyName = null;
let _buddyJournalData = null;  // full normalised rows for active buddy
let _buddyJournalKeys = {};    // { [userId]: Set<journalKey> } — keys only, pre-fetched

// ─── COLOUR PALETTE ──────────────────────────────────────────────────────────
// Stable per-buddy colour derived from their user id

const TILE_COLOURS = [
    { bg: 'bg-indigo-100',  text: 'text-indigo-700'  },
    { bg: 'bg-violet-100',  text: 'text-violet-700'  },
    { bg: 'bg-emerald-100', text: 'text-emerald-700' },
    { bg: 'bg-amber-100',   text: 'text-amber-700'   },
    { bg: 'bg-rose-100',    text: 'text-rose-700'    },
    { bg: 'bg-sky-100',     text: 'text-sky-700'     },
];

function buddyColour(userId) {
    const hash = (userId || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return TILE_COLOURS[hash % TILE_COLOURS.length];
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initBuddies(currentUser) {
    if (!currentUser?.isAuthUser || currentUser.Type !== 'Personal') return;

    const buddies = window._following || [];

    // Pre-fetch journal keys for all accepted buddies (lightweight — keys only)
    if (buddies.length) {
        const buddyIds = buddies.map(b => b.id);
        const { data: keyRows } = await supabase
            .from('journals')
            .select('user_id, journal_key')
            .in('user_id', buddyIds);

        if (keyRows) {
            for (const row of keyRows) {
                if (!_buddyJournalKeys[row.user_id]) {
                    _buddyJournalKeys[row.user_id] = new Set();
                }
                _buddyJournalKeys[row.user_id].add(row.journal_key);
            }
        }
    }

    // Expose keys globally so other modules can still use them if needed
    window._buddyJournalKeys = _buddyJournalKeys;

    // Augment each buddy in _following with pre-computed stats so profile.js
    // and other modules can read totalGigs / sharedGigs / lastSharedShow directly
    const myKeys = new Set((window.journalData || []).map(g => g['Journal Key']));
    window._following = (window._following || []).map(buddy => {
        const buddyKeys   = _buddyJournalKeys[buddy.id];
        const sharedKeys  = buddyKeys ? [...buddyKeys].filter(k => myKeys.has(k)) : [];
        const lastShared  = (window.journalData || [])
            .filter(g => sharedKeys.includes(g['Journal Key']))
            .sort((a, b) => {
                const parse = d => { const [dd,mm,yy] = d.split('/'); return new Date(`${yy}-${mm}-${dd}`); };
                return parse(b.Date) - parse(a.Date);
            })[0];
        return {
            ...buddy,
            totalGigs:       buddyKeys?.size ?? 0,
            sharedGigs:      sharedKeys.length,
            lastSharedShow:  lastShared ? `${lastShared.Band} at ${lastShared.OfficialVenue}` : null,
            lastSharedDate:  lastShared ? lastShared.Date : null,   // ← add this
        };
    });

    renderBuddyTiles(window._following);
    wireDrillInSearch();

    // Keys are now populated — re-render the table so buddy pills appear.
    // Call renderTable directly to avoid resetting search/filter state.
    if (window.filteredResults && typeof window.currentSort !== 'undefined') {
        const sorted = sortGigs(window.filteredResults, window.currentSort.column, window.currentSort.ascending);
        UI.renderTable(sorted);
    }
}

// ─── TILE RENDERING ───────────────────────────────────────────────────────────

function renderBuddyTiles(buddies) {
    const container = document.getElementById('buddy-tiles-container');
    if (!container) return;

    if (!buddies.length) {
        container.innerHTML = `
            <div class="text-center py-12 space-y-4">
                <div class="w-16 h-16 bg-indigo-50 rounded-3xl flex items-center justify-center mx-auto">
                    <i data-lucide="users" class="w-8 h-8 text-indigo-300" aria-hidden="true"></i>
                </div>
                <div class="space-y-1">
                    <p class="text-sm font-black text-slate-700">No buddies yet</p>
                    <p class="text-xs text-slate-400 leading-relaxed max-w-[220px] mx-auto">
                        Search for friends above to get started.
                    </p>
                </div>
            </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    const myKeys = new Set((window.journalData || []).map(g => g['Journal Key']));

    container.innerHTML = buddies.map(buddy => {
        const colour     = buddyColour(buddy.id);
        const initials   = (buddy.display_name || buddy.username || '?').slice(0, 2).toUpperCase();
        const totalGigs  = buddy.totalGigs  ?? _buddyJournalKeys[buddy.id]?.size ?? 0;
        const sharedGigs = buddy.sharedGigs ?? [...(_buddyJournalKeys[buddy.id] || [])].filter(k => myKeys.has(k)).length;
        const safeName   = (buddy.display_name || buddy.username || '').replace(/'/g, "\\'");
        const avatarHtml = buddy.avatar_url
            ? `<img src="${buddy.avatar_url}" alt="${buddy.display_name || buddy.username}" class="w-full h-full object-cover rounded-2xl">`
            : `<span class="font-black text-lg">${initials}</span>`;

        return `
            <div class="w-full bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 flex items-center gap-4 hover:border-indigo-200 hover:shadow-md transition-all">
                <!-- Avatar tap → profile screen -->
                <button onclick="window.openProfile('${buddy.id}')"
                        class="w-12 h-12 rounded-2xl ${colour.bg} ${colour.text} flex items-center justify-center flex-shrink-0 overflow-hidden hover:ring-2 hover:ring-indigo-400 hover:ring-offset-1 transition-all active:scale-95"
                        aria-label="View ${buddy.display_name || buddy.username}'s profile">
                    ${avatarHtml}
                </button>
                <!-- Row tap → drill-in -->
                <button onclick="window.openBuddyDrillIn('${buddy.id}', '${safeName}')"
                        class="flex-1 min-w-0 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
                        aria-label="View ${buddy.display_name || buddy.username}'s shows">
                    <div class="flex-1 min-w-0">
                        <p class="text-sm font-black text-slate-900 truncate">${buddy.display_name || buddy.username}</p>
                        <p class="text-[10px] text-slate-400 font-bold mt-0.5">
                            ${totalGigs} show${totalGigs !== 1 ? 's' : ''}
                            ${sharedGigs ? `<span class="text-indigo-500">· ${sharedGigs} in common</span>` : ''}
                        </p>
                    </div>
                    <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 flex-shrink-0" aria-hidden="true"></i>
                </button>
            </div>`;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

// ─── DRILL-IN OPEN / CLOSE ────────────────────────────────────────────────────

window.openBuddyDrillIn = async (buddyId, buddyName) => {
    _activeBuddyId   = buddyId;
    _activeBuddyName = buddyName;

    // Update header
    const nameEl = document.getElementById('buddy-drill-name');
    const metaEl = document.getElementById('buddy-drill-meta');
    if (nameEl) nameEl.textContent = buddyName;
    if (metaEl) metaEl.textContent = 'Loading…';

    // Reset shared toggle and search
    const sharedToggle = document.getElementById('buddy-drill-shared-toggle');
    const searchInput  = document.getElementById('buddy-drill-search');
    if (sharedToggle) sharedToggle.checked = false;
    if (searchInput)  searchInput.value    = '';

    // Slide the panel in
    const panel = document.getElementById('buddy-drill-in');
    if (panel) {
        panel.classList.remove('translate-x-full');
        panel.setAttribute('aria-hidden', 'false');
        panel.scrollTop = 0;
    }

    // Scroll main page to top so it's in the right place when we come back
    window.scrollTo(0, 0);

    // Fetch and render
    await _loadBuddyDrillData(buddyId, false);
};

window.closeBuddyDrillIn = () => {
    const panel = document.getElementById('buddy-drill-in');
    if (panel) {
        panel.classList.add('translate-x-full');
        panel.setAttribute('aria-hidden', 'true');
    }

    _activeBuddyId    = null;
    _activeBuddyName  = null;
    _buddyJournalData = null;

    // Destroy buddy charts so canvases are clean next time
    if (window._buddyYearChart)  { window._buddyYearChart.destroy();  window._buddyYearChart  = null; }
    if (window._buddyBandsChart) { window._buddyBandsChart.destroy(); window._buddyBandsChart = null; }
};

// ─── SHARED TOGGLE & SEARCH ───────────────────────────────────────────────────

window.handleBuddyDrillSharedToggle = () => {
    if (!_activeBuddyId) return;
    const sharedOnly = document.getElementById('buddy-drill-shared-toggle')?.checked;
    _loadBuddyDrillData(_activeBuddyId, sharedOnly);
};

function wireDrillInSearch() {
    const input = document.getElementById('buddy-drill-search');
    if (!input || input._wired) return;
    input._wired = true;

    input.addEventListener('input', () => {
        if (!_buddyJournalData) return;
        const query = input.value.toLowerCase().trim();
        const filtered = query
            ? _buddyJournalData.filter(r =>
                (r['Band'] || '').toLowerCase().includes(query) ||
                (r['OfficialVenue'] || '').toLowerCase().includes(query)
              )
            : _buddyJournalData;

        _renderDrillTable(filtered);
    });
}

// ─── DATA FETCHING ────────────────────────────────────────────────────────────

async function _loadBuddyDrillData(buddyId, sharedOnly) {
    // Two-step query — safe pattern throughout the app
    const { data: buddyRows, error } = await supabase
        .from('journals')
        .select('*')
        .eq('user_id', buddyId)
        .order('date', { ascending: false });

    if (error) {
        console.error('Buddy drill-in fetch failed:', error);
        window.showToast('Could not load shows — try again', 'error');
        return;
    }

    // Normalise to the same shape as journalData — this MUST match what
    // data.js's loadAppData produces, since these rows get passed straight
    // into Charts.renderTopBandsChart. Previously this used 'Festival'
    // (no '?', boolean value) instead of 'Festival?' ('Y'/'N' string), so
    // renderTopBandsChart's isFest check never matched and festival rows
    // got counted as if the festival name were a band. 'Notable Support'
    // and 'Festival Lineups' were also missing entirely, so no support acts
    // were ever counted for buddies.
    let rows = (buddyRows || []).map(r => ({
        'Journal Key':      r.journal_key,
        'Date':             r.date,
        'Band':             r.band,
        'OfficialVenue':    r.official_venue || '',
        'Venue':            r.venue || '',
        'Festival?':        r.festival ? 'Y' : 'N',
        'Festival Lineups': r.festival_lineups || '',
        'Notable Support':  r.notable_support || '',
        'WentWith':         r.went_with || '',
        'Comments':         r.comments || '',
        'Photos':           r.photos || '',
        'safeKey':          (r.journal_key || '').replace(/'/g, "\\'"),
    }));

    // "Shared only" — filter to journal_keys that also exist in the logged-in user's data
    if (sharedOnly) {
        const myKeys = new Set((window.journalData || []).map(g => g['Journal Key']));
        rows = rows.filter(r => myKeys.has(r['Journal Key']));
    }

    const finalRows = sortGigs(rows, window.currentSort?.column || 'Date', window.currentSort?.ascending ?? false);

    _buddyJournalData = finalRows;

    // Update header meta
    const metaEl = document.getElementById('buddy-drill-meta');
    if (metaEl) metaEl.textContent = `${finalRows.length} show${finalRows.length !== 1 ? 's' : ''}`;

    // Render stats, charts, table
    _renderDrillStats(finalRows);
    _renderDrillCharts(finalRows);
    _renderDrillTable(finalRows);

    if (window.lucide) lucide.createIcons();
}

// ─── STATS ────────────────────────────────────────────────────────────────────

function _renderDrillStats(rows) {
    const container = document.getElementById('buddy-drill-stats');
    if (!container) return;

    const totalGigs  = rows.length;
    const venues     = new Set(rows.map(r => r['OfficialVenue'])).size;
    const artists    = new Set(rows.map(r => r['Band'])).size;

    container.innerHTML = [
        { label: 'Gigs',    value: totalGigs },
        { label: 'Venues',  value: venues    },
        { label: 'Artists', value: artists   },
    ].map(({ label, value }) => `
        <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-center">
            <p class="text-xs text-slate-500 uppercase tracking-widest font-bold">${label}</p>
            <p class="text-2xl font-black text-indigo-600 mt-0.5">${value}</p>
        </div>`).join('');
}

// ─── CHARTS ───────────────────────────────────────────────────────────────────

function _renderDrillCharts(rows) {
    // Destroy previous instances so Chart.js doesn't complain about canvas reuse
    if (window._buddyYearChart)      { window._buddyYearChart.destroy();      window._buddyYearChart      = null; }
    if (window._buddyBandsChart)     { window._buddyBandsChart.destroy();     window._buddyBandsChart     = null; }
    if (window._buddyFrequencyChart) { window._buddyFrequencyChart.destroy(); window._buddyFrequencyChart = null; }

    // Year chart — reuse the existing Charts function, capture the returned instance
    window._buddyYearChart  = Charts.renderYearChart(rows, 'buddy-year-chart');

    // Top bands chart — pass empty performanceData (buddy's song data isn't loaded)
    window._buddyBandsChart = Charts.renderTopBandsChart(rows, [], 'buddy-bands-chart');

    // Band frequency scatter (Stats tab addition) — same empty-performanceData
    // caveat as Top Bands above; falls back to journal free-text fields.
    window._buddyFrequencyChart = Charts.renderBandFrequencyChart(rows, [], 'buddy-band-frequency-chart');

    // Hot list (Stats tab addition) — ranked list rendered into a plain div,
    // not a canvas chart, so there's no instance to destroy/reassign.
    Charts.renderHotList(rows, [], 'buddy-hotlist-body');
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

function _renderDrillTable(rows) {
    const container = document.getElementById('buddy-drill-table');
    if (!container) return;

    if (!rows.length) {
        container.innerHTML = `<p class="text-center text-sm text-slate-400 italic py-8">No shows found</p>`;
        return;
    }

    const myKeys = new Set((window.journalData || []).map(g => g['Journal Key']));

    container.innerHTML = `
        <div class="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
            <table class="w-full text-left table-fixed">
                <thead>
                    <tr class="bg-slate-50/50">
                        <th class="w-24 p-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Date</th>
                        <th class="w-40 p-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Artist</th>
                        <th class="p-4 text-[10px] font-black uppercase tracking-widest text-slate-400">Venue</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-50">
                    ${rows.map(gig => {
                        const isShared = myKeys.has(gig['Journal Key']);
                        return `
                        <tr onclick="window.viewBuddyGig('${gig.safeKey}')"
                            class="group hover:bg-indigo-50/30 transition-all cursor-pointer">
                            <td class="p-4 text-xs font-medium text-slate-500 font-mono tracking-tighter">${gig['Date']}</td>
                            <td class="p-4 leading-tight">
                                <div class="flex flex-col gap-1">
                                    <span class="text-sm font-bold text-slate-900">${gig['Band']}</span>
                                    ${isShared ? `<span class="inline-flex items-center gap-1 text-[9px] bg-indigo-500/10 text-indigo-600 font-black uppercase px-2 py-0.5 rounded-full w-fit">
                                        <i data-lucide="check" class="w-2.5 h-2.5"></i> You were there
                                    </span>` : ''}
                                </div>
                            </td>
                            <td class="p-4 text-xs text-slate-600 font-medium">${gig['OfficialVenue']}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    if (window.lucide) lucide.createIcons();
}

// ─── BUDDY GIG MODAL ──────────────────────────────────────────────────────────
// Opens a read-only gig modal for a buddy's show.
// Uses a temporary data source so the main journalData is never touched.

window.viewBuddyGig = (key) => {
    if (!_buddyJournalData) return;

    // Temporarily override the data sources that openGigModal reads
    const prevReadOnly   = window.isReadOnly;
    window.isReadOnly    = true;

    UI.openGigModal(key, _buddyJournalData, []);

    // Restore after the modal is open
    // closeModal() in app.js already restores isReadOnly — but set it back here
    // too so the value is correct if something reads it before the modal closes.
    window.isReadOnly = prevReadOnly;

    // Patch closeModal so it knows to restore correctly in buddy context
    const _origClose = window.closeModal;
    window.closeModal = () => {
        window.isReadOnly = (window.isBandMode && !window.currentUser?.is_admin);
        window.closeModal = _origClose;
        _origClose();
    };
};
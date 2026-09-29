/**
 * GigList — Stats Mode Switcher
 * -------------------------------------------------------------------
 * Toggles the Stats tab between the existing Gigs charts and the new
 * Collection charts, following the same pill-and-hidden-class pattern
 * as window.toggleListView on the Gigs tab.
 *
 * Assumes window.currentUser is set the same way it already is for the
 * rest of the app (see collection.js's init(currentUser) call site) —
 * needed here because renderCollectionCharts calls ensureLoaded(userId).
 */

window.toggleStatsView = function(mode) {
    const isGigs = mode === 'gigs';

    document.getElementById('stats-btn-gigs').className =
        `px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isGigs ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`;
    document.getElementById('stats-btn-collection').className =
        `px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!isGigs ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400'}`;

    document.getElementById('view-gigs-stats')?.classList.toggle('hidden', !isGigs);
    document.getElementById('view-collection-stats')?.classList.toggle('hidden', isGigs);

    // Gigs' own filter summary line only makes sense while Gigs is showing.
    document.getElementById('statsFilterSummaryLine')?.classList.toggle('hidden', !isGigs || !window._filtersModule?.hasActiveFilters?.());

    // Filter button opens the Gigs drawer only — Collection has no drawer
    // equivalent (its filtering is chips on the Collection tab itself), so
    // swap it out for a plain hint in Collection mode instead of a dead button.
    document.getElementById('statsFilterBtn')?.classList.toggle('hidden', !isGigs);
    document.getElementById('statsCollectionFilterHint')?.classList.toggle('hidden', isGigs);

    // Search placeholder + value reset — each mode searches a different
    // dataset with a different query string, so carrying one mode's text
    // into the other's box would silently search nothing. Cleared rather
    // than restored on switch — app.js owns however Gigs' own search state
    // is persisted, if you'd rather it restore the last Gigs query when
    // switching back, wire that in from whatever holds it there.
    const searchInput = document.getElementById('statsSearchInput');
    if (searchInput) {
        searchInput.placeholder = isGigs
            ? 'Search artists, venues, or songs...'
            : 'Search your collection...';
        searchInput.value = '';
    }
    if (isGigs && window._colSearch) {
        window._colSearch(''); // clear any search typed into this box while in Collection mode
    }

    window._statsMode = mode;

    if (!isGigs && window.currentUser) {
        window._collectionChartsModule?.renderCollectionCharts(window.currentUser);
    }
};

// Routes the shared Stats search box to whichever dataset is currently
// showing. Registered with capture:true so it runs before app.js's own
// 'input' listener on this same element (added later, in the bubble
// phase) and can stopImmediatePropagation() to swallow the event in
// Collection mode — otherwise both listeners would fire and app.js's
// Gigs-side handler would run against text meant for the Collection search.
document.getElementById('statsSearchInput')?.addEventListener('input', (e) => {
    if (window._statsMode === 'collection') {
        window._colSearch(e.target.value);
        e.stopImmediatePropagation();
    }
    // Gigs mode: do nothing here, let app.js's existing listener handle it.
}, { capture: true });

// Re-render the Collection stats charts whenever collection.js's own
// filter state changes (band chip, curation, search, "show disposed"
// toggle) — this is what makes a filter set on the Collection tab carry
// through to the Collection stats charts, matching how filtersChanged
// already drives Gigs stats via renderDashboardCharts. Only re-renders
// when Collection mode is the one currently showing; if it isn't, the
// next toggleStatsView('collection') call picks up the latest state anyway.
document.addEventListener('collectionViewChanged', () => {
    if (window._statsMode === 'collection' && window.currentUser) {
        window._collectionChartsModule?.renderCollectionCharts(window.currentUser);
    }
});

// Mirror for the Gigs side: when a Collection chart click sets an artist
// filter via window._filtersModule (see renderItemsVsGigsChart), the
// existing filtersChanged listener in app.js already re-renders the Gigs
// list and calls renderDashboardCharts — nothing extra needed here.
//
// The reverse case — a Gigs filter changing while Collection stats is the
// visible mode — doesn't need new wiring either: the Items vs Gigs chart
// is the only Collection chart that reads journalData, and it already
// re-reads window.filteredResults fresh each render. If you want it to
// re-render live the instant a Gigs filter changes (rather than next time
// Collection mode is opened), add the same call inside app.js's existing
// 'filtersChanged' listener:
//
//   if (window._statsMode === 'collection' && window.currentUser) {
//       window._collectionChartsModule?.renderCollectionCharts(window.currentUser);
//   }
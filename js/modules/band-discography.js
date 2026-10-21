/**
 * GigList — Band Discography Module
 * band-discography.js  (frontend: lives in modules/ next to band.js)
 * -------------------------------------------------------------------
 * The Discography tab in band mode, three levels deep:
 *   1. Tiles     — masters only (the "work"), grouped Albums / EPs / Singles /
 *                  Compilations / Other. Quiet state per tile: in your collection,
 *                  wanted. A Spotify link when we have a match.
 *   2. Master sheet — cover, tracklist, "Your copies", and the way into level 3.
 *   3. Pressings — the collector view: filter by format / country / year, see
 *                  label, catno, country and community have/want counts, and pick the
 *                  exact pressing. "I have this" opens the collection editor
 *                  prefilled with that pressing's Discogs link.
 *
 * Ownership is computed, never stored here:
 *   collection_items.discogs_id → discogs_releases.master_id  (still_owned = true)
 * with a fallback of discogs_id === a master's main release, so items whose cache
 * row predates master_id still light up.
 *
 * Wants live in discogs_wants (master-level: discogs_id null; pressing-level:
 * discogs_id set), never in collection_items.
 *
 * Browsing 80+ releases: a search box (title or year), type chips with counts, and
 * selects for collection status, promos and sort. Filters live in S.filters and
 * survive opening/closing a release; they reset when the band changes.
 *
 * Data comes from two places:
 *   - Supabase directly (RLS applies): discogs_masters, discogs_wants, collection_items
 *   - The collection-image-import Worker: /discography/master and /discography/versions
 *     (cached server-side), plus admin-only setup routes.
 *
 * Public API:
 *   renderBandDiscography()   — called by band.js each time the tab is shown
 */

import { supabase, authedFetch } from './supabase.js';
import { escapeHtml, safeUrl }   from './utils.js';

const IMPORT_WORKER_URL = 'https://collection-image-import.richard-lipscombe.workers.dev';

const SPOTIFY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

const KIND_GROUPS = [
    ['album',       'Albums'],
    ['ep',          'EPs'],
    ['single',      'Singles'],
    ['compilation', 'Compilations'],
    ['other',       'Other'],
];

// ─── STATE ────────────────────────────────────────────────────────────────────

const S = {
    bandName: null,
    artist:   null,            // { id, name, discogs_artist_id, spotify_artist_id }
    masters:  [],
    loaded:   false,
    userId:   null,
    owned:    new Map(),       // masterId -> [collection item rows]
    ownedPressings: new Set(), // discogs_id values the user owns
    wants:    new Set(),       // `${masterId}:${discogsId || 0}`
    sheet:    null,            // see _openMaster
    candidates: null,          // admin: Discogs artist search results
    filters: _defaultFilters(),
};

function _defaultFilters() {
    return { q: '', kind: 'all', own: 'all', promo: 'all', sort: 'year-asc' };
}

const _isAdmin = () => window.isReadOnly === false;
const _sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const _wantKey = (masterId, discogsId) => `${masterId}:${discogsId || 0}`;
const _spotifyUrl = (id) => /^[A-Za-z0-9]{22}$/.test(id || '') ? `https://open.spotify.com/album/${id}` : null;

async function _api(route, body) {
    try {
        const res  = await authedFetch(`${IMPORT_WORKER_URL}/discography/${route}`, {
            method: 'POST',
            body: JSON.stringify(body || {}),
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && !data?.error, status: res.status, data };
    } catch (err) {
        console.warn(`band-discography: ${route} failed`, err);
        return { ok: false, status: 0, data: { error: 'Network error' } };
    }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export async function renderBandDiscography() {
    const root = document.getElementById('band-discography-body');
    if (!root) return;

    const bandName = window.currentArtist;
    if (S.bandName !== bandName) {
        Object.assign(S, { bandName, artist: null, masters: [], loaded: false, sheet: null, candidates: null, filters: _defaultFilters() });
        root.dataset.shell = '';
        S.owned = new Map(); S.ownedPressings = new Set(); S.wants = new Set();
    }

    _bindOnce(root);

    const { data: { session } } = await supabase.auth.getSession();
    S.userId = session?.user?.id || null;
    if (!S.userId) {
        root.dataset.shell = '';
        root.innerHTML = _note('Sign in to browse this band\u2019s discography and add releases to your collection.');
        return;
    }

    if (!S.loaded) {
        root.dataset.shell = '';
        root.innerHTML = _skeleton();
        await _loadCatalogue();
    }
    await _loadMine();   // cheap; refreshes ownership after the editor has been used
    _draw();
}

// ─── DATA ─────────────────────────────────────────────────────────────────────

async function _loadCatalogue() {
    const { data: artist, error } = await supabase
        .from('artists')
        .select('id, name, discogs_artist_id, spotify_artist_id')
        .eq('name', S.bandName)
        .maybeSingle();
    if (error) console.warn('band-discography: artist lookup failed', error.message);
    S.artist = artist || null;
    S.masters = [];

    if (S.artist) {
        const { data, error: mErr } = await supabase
            .from('discogs_masters')
            .select('discogs_master_id, title, year, main_release_id, thumb, kind, classified_at, promo, spotify_album_id, hidden, pinned')
            .eq('artist_id', S.artist.id)
            .order('year', { ascending: true, nullsFirst: false });
        if (mErr) console.warn('band-discography: masters load failed', mErr.message);
        S.masters = data || [];
    }
    S.loaded = true;
}

async function _loadMine() {
    S.owned = new Map(); S.ownedPressings = new Set(); S.wants = new Set();
    if (!S.artist || !S.userId) return;

    const [itemsRes, wantsRes] = await Promise.all([
        supabase.from('collection_items')
            .select('id, title, format, label, country, item_date, discogs_id, discogs_releases(master_id)')
            .eq('user_id', S.userId)
            .eq('still_owned', true)
            .not('discogs_id', 'is', null),
        supabase.from('discogs_wants')
            .select('discogs_master_id, discogs_id')
            .eq('user_id', S.userId)
            .eq('artist_id', S.artist.id),
    ]);

    const byMain = new Map(S.masters.filter(m => m.main_release_id).map(m => [m.main_release_id, m.discogs_master_id]));
    for (const it of (itemsRes.data || [])) {
        S.ownedPressings.add(it.discogs_id);
        const rel = Array.isArray(it.discogs_releases) ? it.discogs_releases[0] : it.discogs_releases;
        const masterId = rel?.master_id || byMain.get(it.discogs_id);
        if (!masterId) continue;
        if (!S.owned.has(masterId)) S.owned.set(masterId, []);
        S.owned.get(masterId).push(it);
    }
    for (const w of (wantsRes.data || [])) S.wants.add(_wantKey(w.discogs_master_id, w.discogs_id));
}

// ─── LEVEL 1: TILES ───────────────────────────────────────────────────────────

function _note(msg) {
    return `<div class="rounded-[1.5rem] bg-white border border-slate-100 p-6 text-sm text-slate-500">${escapeHtml(msg)}</div>`;
}

function _skeleton() {
    return `<div class="animate-pulse grid grid-cols-2 gap-3">
        ${'<div class="aspect-square bg-slate-200 rounded-[1.5rem]"></div>'.repeat(4)}
    </div>`;
}

function _draw() {
    const root = document.getElementById('band-discography-body');
    if (!root) return;

    if (!S.artist) {
        root.dataset.shell = '';
        root.innerHTML = _note('This band has no artist record yet, so there is no discography to show.');
        return;
    }

    const admin = _isAdmin();
    if (!S.artist.discogs_artist_id || !S.masters.length) {
        root.dataset.shell = '';
        root.innerHTML = admin ? _adminSetupPanel() : _note('This band\u2019s discography hasn\u2019t been set up yet.');
        if (window.lucide) lucide.createIcons();
        return;
    }

    // The shell (search box, chips, results container) is built once so typing in the
    // search box never loses focus; later redraws only touch the pieces that changed.
    if (root.dataset.shell !== 'ready') {
        root.innerHTML = `
        <div id="band-disco-admin"></div>
        <div class="space-y-3 mb-4">
            <label class="block">
                <span class="sr-only">Search releases</span>
                <input id="band-disco-search" type="search" value="${escapeHtml(S.filters.q)}"
                       placeholder="Search releases or years" autocomplete="off" enterkeyhint="search"
                       class="w-full rounded-full border border-slate-200 bg-white px-5 py-3 text-sm text-slate-900 placeholder-slate-400">
            </label>
            <div id="band-disco-chips" class="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Release type"></div>
            <div id="band-disco-selects" class="grid grid-cols-3 gap-2"></div>
        </div>
        <div id="band-disco-summary" class="flex items-center justify-between text-xs text-slate-400 mb-6"></div>
        <div id="band-disco-results" class="space-y-8"></div>
        <p class="text-[10px] text-slate-400 mt-8">Release data from Discogs. Listening links open Spotify.</p>`;
        root.dataset.shell = 'ready';
    }

    const adminEl = document.getElementById('band-disco-admin');
    if (adminEl) adminEl.innerHTML = admin ? _adminToolbar() : '';
    _drawFilters();
    _drawResults();
    if (window.lucide) lucide.createIcons();
}

// ─── FILTERS ──────────────────────────────────────────────────────────────────

const _SORTS = [['year-asc', 'Oldest first'], ['year-desc', 'Newest first'], ['title', 'A\u2013Z']];
const _OWN_OPTS = [['all', 'Everything'], ['owned', 'In collection'], ['not-owned', 'Not in collection'], ['wanted', 'Wanted']];
const _PROMO_OPTS = [['all', 'Promos: include'], ['hide', 'Hide promos'], ['only', 'Promos only']];

function _baseMasters() {
    const admin = _isAdmin();
    return S.masters.filter(m => admin || !m.hidden);
}

// skipKind lets the type chips show counts for "everything else that's selected".
function _passes(m, skipKind = false) {
    const f = S.filters;
    if (!skipKind && f.kind !== 'all' && (m.kind || 'other') !== f.kind) return false;

    if (f.q) {
        const hay = `${m.title} ${m.year || ''}`.toLowerCase();
        if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))) return false;
    }

    const id = m.discogs_master_id;
    const owned = S.owned.has(id);
    if (f.own === 'owned' && !owned) return false;
    if (f.own === 'not-owned' && owned) return false;
    if (f.own === 'wanted' && (owned || !S.wants.has(_wantKey(id, null)))) return false;

    if (f.promo === 'hide' && m.promo) return false;
    if (f.promo === 'only' && !m.promo) return false;
    return true;
}

function _filtersActive() {
    const f = S.filters;
    return !!f.q || f.kind !== 'all' || f.own !== 'all' || f.promo !== 'all';
}

function _select(name, options, current, label) {
    return `
    <label class="block">
        <span class="sr-only">${escapeHtml(label)}</span>
        <select data-disco-filter="${name}" class="w-full rounded-full border border-slate-200 bg-white text-xs font-bold text-slate-600 px-3 py-2">
            ${options.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
        </select>
    </label>`;
}

function _drawFilters() {
    const chips = document.getElementById('band-disco-chips');
    const selects = document.getElementById('band-disco-selects');
    if (!chips || !selects) return;

    const pool = _baseMasters().filter(m => _passes(m, true));
    const counts = { all: pool.length };
    for (const [k] of KIND_GROUPS) counts[k] = pool.filter(m => (m.kind || 'other') === k).length;

    const chip = (kind, label) => {
        const active = S.filters.kind === kind;
        if (kind !== 'all' && !counts[kind] && !active) return '';
        return `<button type="button" data-action="filter-kind" data-kind="${kind}" aria-pressed="${active}"
            class="shrink-0 whitespace-nowrap text-xs font-black uppercase tracking-wider px-4 py-2 rounded-full border ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}">
            ${escapeHtml(label)} <span class="${active ? 'text-slate-300' : 'text-slate-400'}">${counts[kind] ?? 0}</span></button>`;
    };
    chips.innerHTML = chip('all', 'All') + KIND_GROUPS.map(([k, l]) => chip(k, l)).join('');

    // Only offer the promo filter once at least one release is known to be a promo.
    const hasPromo = S.masters.some(m => m.promo);
    selects.className = `grid gap-2 ${hasPromo ? 'grid-cols-3' : 'grid-cols-2'}`;
    selects.innerHTML =
        _select('own', _OWN_OPTS, S.filters.own, 'Collection status') +
        (hasPromo ? _select('promo', _PROMO_OPTS, S.filters.promo, 'Promos') : '') +
        _select('sort', _SORTS, S.filters.sort, 'Sort order');
}

function _sorter() {
    const by = S.filters.sort;
    return (a, b) => (b.pinned - a.pinned) || (
        by === 'title'     ? a.title.localeCompare(b.title) :
        by === 'year-desc' ? (b.year || 0) - (a.year || 0) :
                             (a.year || 9999) - (b.year || 9999));
}

function _drawResults() {
    const results = document.getElementById('band-disco-results');
    const summary = document.getElementById('band-disco-summary');
    if (!results || !summary) return;

    const all = _baseMasters();
    const shown = all.filter(m => _passes(m));

    summary.innerHTML = `<span aria-live="polite">${shown.length} of ${all.length} releases</span>
        ${_filtersActive() ? '<button type="button" data-action="clear-filters" class="font-black uppercase tracking-wider text-[#189BCC]">Clear filters</button>' : ''}`;

    if (!shown.length) {
        results.innerHTML = `<div class="rounded-[1.5rem] bg-white border border-slate-100 p-6 text-sm text-slate-500">
            Nothing matches those filters.
            <button type="button" data-action="clear-filters" class="block mt-2 text-xs font-black uppercase tracking-wider text-[#189BCC]">Clear filters</button></div>`;
        return;
    }

    let html = '';
    for (const [kind, label] of KIND_GROUPS) {
        const items = shown.filter(m => (m.kind || 'other') === kind).sort(_sorter());
        if (!items.length) continue;
        html += `
        <section class="space-y-3" aria-label="${escapeHtml(label)}">
            <h3 class="text-xs font-black uppercase tracking-widest text-slate-400">${escapeHtml(label)}</h3>
            <div class="grid grid-cols-2 gap-3">${items.map(_tile).join('')}</div>
        </section>`;
    }
    results.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function _tile(m) {
    const id      = m.discogs_master_id;
    const owned   = S.owned.has(id);
    const wanted  = !owned && S.wants.has(_wantKey(id, null));
    const thumb   = safeUrl(m.thumb || '');
    const spotify = _spotifyUrl(m.spotify_album_id);
    const admin   = _isAdmin();

    const cover = thumb
        ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" class="w-full h-full object-cover">`
        : `<div class="w-full h-full flex items-center justify-center text-slate-300"><i data-lucide="disc-3" class="w-10 h-10" aria-hidden="true"></i></div>`;

    const badge = owned
        ? `<span class="absolute top-2 right-2 bg-emerald-500 text-white text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full">In collection</span>`
        : wanted
            ? `<span class="absolute top-2 right-2 bg-amber-400 text-white text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full">Wanted</span>`
            : '';

    return `
    <div class="bg-white rounded-[1.5rem] border border-slate-100 overflow-hidden flex flex-col ${m.hidden ? 'opacity-50' : ''}">
        <button type="button" data-action="open-master" data-id="${id}"
                class="relative block w-full aspect-square bg-slate-100 text-left"
                aria-label="${escapeHtml(m.title)}${m.year ? `, ${m.year}` : ''}">
            ${cover}${badge}
        </button>
        <div class="p-3 flex-1 flex flex-col gap-1">
            <button type="button" data-action="open-master" data-id="${id}" class="text-left">
                <span class="block text-sm font-bold text-slate-900 leading-snug line-clamp-2">${escapeHtml(m.title)}</span>
                <span class="block text-xs text-slate-400">${[m.year, m.promo ? 'Promo' : ''].filter(Boolean).join(' · ')}</span>
            </button>
            <div class="mt-auto pt-2 flex items-center gap-3">
                ${spotify ? `<a href="${spotify}" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600" aria-label="Listen to ${escapeHtml(m.title)} on Spotify">${SPOTIFY_ICON}<span>Listen</span></a>` : ''}
                ${admin ? `
                <button type="button" data-action="curate-pin" data-id="${id}" class="ml-auto text-[10px] font-black uppercase ${m.pinned ? 'text-[#189BCC]' : 'text-slate-400'}">${m.pinned ? 'Pinned' : 'Pin'}</button>
                <button type="button" data-action="curate-hide" data-id="${id}" class="text-[10px] font-black uppercase text-slate-400">${m.hidden ? 'Unhide' : 'Hide'}</button>` : ''}
            </div>
        </div>
    </div>`;
}

// ─── ADMIN: SETUP + CURATION ──────────────────────────────────────────────────

function _adminToolbar() {
    const pending = S.masters.filter(m => !m.classified_at || m.promo == null).length;
    return `
    <div class="rounded-[1.5rem] bg-slate-50 border border-slate-100 p-4 flex items-center justify-between gap-3 mb-6">
        <div class="text-xs text-slate-500">
            <span class="font-black uppercase tracking-widest text-slate-400">Admin</span>
            <span id="band-disco-status" class="block">${S.masters.length} releases${pending ? ` · ${pending} to check` : ''}</span>
        </div>
        <button type="button" data-action="admin-build"
                class="shrink-0 text-xs font-black uppercase tracking-wider px-4 py-2 rounded-full bg-white border border-slate-200">Refresh from Discogs</button>
    </div>`;
}

function _adminSetupPanel() {
    const linked = !!S.artist.discogs_artist_id;
    const cands = S.candidates;
    return `
    <div class="rounded-[1.5rem] bg-white border border-slate-100 p-6 space-y-4">
        <h3 class="font-display text-2xl italic text-slate-900">Set up ${escapeHtml(S.artist.name)}</h3>
        <p id="band-disco-status" class="text-sm text-slate-500">${linked
            ? 'Linked to Discogs. Build the discography to pull the releases in.'
            : 'Link this band to the right Discogs artist first. Check the page before confirming \u2014 name matching has burned us before.'}</p>
        ${linked ? '' : `
        <button type="button" data-action="admin-search"
                class="text-xs font-black uppercase tracking-wider px-4 py-2 rounded-full bg-white border border-slate-200">Search Discogs</button>`}
        ${cands ? `<ul class="space-y-2">${cands.map(c => `
            <li class="flex items-center gap-3 rounded-2xl border border-slate-100 p-2">
                ${c.thumb ? `<img src="${escapeHtml(safeUrl(c.thumb))}" alt="" class="w-12 h-12 rounded-xl object-cover bg-slate-100">` : '<div class="w-12 h-12 rounded-xl bg-slate-100"></div>'}
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-bold text-slate-900 truncate">${escapeHtml(c.title)}</div>
                    ${c.uri ? `<a href="${escapeHtml(safeUrl(c.uri))}" target="_blank" rel="noopener noreferrer" class="text-xs text-[#189BCC]">View on Discogs</a>` : ''}
                </div>
                <button type="button" data-action="admin-confirm" data-id="${c.discogsArtistId}"
                        class="shrink-0 text-xs font-black uppercase tracking-wider px-3 py-2 rounded-full bg-[#189BCC] text-white">Use</button>
            </li>`).join('')}</ul>` : ''}
        ${linked ? `
        <button type="button" data-action="admin-build"
                class="text-xs font-black uppercase tracking-wider px-4 py-2 rounded-full bg-[#189BCC] text-white">Build discography</button>` : ''}
    </div>`;
}

function _setStatus(msg, isError = false) {
    const el = document.getElementById('band-disco-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('text-red-500', isError);
}

async function _adminSearch() {
    _setStatus('Searching Discogs…');
    const r = await _api('artist-search', { name: S.artist.name });
    if (!r.ok) { _setStatus(r.data?.error || 'Search failed', true); return; }
    S.candidates = r.data.candidates || [];
    _draw();
    if (!S.candidates.length) _setStatus('No Discogs artists found for that name.', true);
}

async function _adminConfirm(discogsArtistId) {
    _setStatus('Saving…');
    const r = await _api('artist-confirm', { artistId: S.artist.id, discogsArtistId });
    if (!r.ok) { _setStatus(r.data?.error || 'Could not save', true); return; }
    S.artist.discogs_artist_id = discogsArtistId;
    S.candidates = null;
    _draw();
}

async function _adminBuild() {
    const artistId = S.artist.id;
    _setStatus('Fetching releases from Discogs…');
    const sync = await _api('sync', { artistId });
    if (!sync.ok || sync.data?.rateLimited) {
        _setStatus(sync.data?.error || 'Discogs is rate-limiting us \u2014 try again in a minute.', true);
        return;
    }

    let remaining = sync.data.unclassified || 0;
    let pauses = 0;
    while (remaining > 0) {
        _setStatus(`Classifying releases\u2026 ${remaining} left`);
        const c = await _api('classify', { artistId, limit: 15 });
        if (!c.ok) { _setStatus(c.data?.error || 'Classification failed', true); return; }
        remaining = c.data.remaining ?? 0;
        if (c.data.rateLimited) {
            if (++pauses > 8) { _setStatus('Still rate-limited \u2014 try again later.', true); return; }
            _setStatus('Discogs rate limit hit \u2014 pausing for a minute\u2026');
            await _sleep(60000);
        } else if (!c.data.classified) {
            break; // nothing progressed and no limit flagged: don't spin
        }
    }

    _setStatus('Matching releases to Spotify\u2026');
    const sp = await _api('spotify-match', { artistId });
    if (!sp.ok) console.warn('band-discography: spotify-match failed', sp.data?.error);

    S.loaded = false;
    await renderBandDiscography();
}

async function _curate(masterId, patch) {
    const r = await _api('curate', { artistId: S.artist.id, discogsMasterId: masterId, ...patch });
    if (!r.ok) { console.warn('band-discography: curate failed', r.data?.error); return; }
    const m = S.masters.find(x => x.discogs_master_id === masterId);
    if (m) Object.assign(m, { hidden: patch.hidden ?? m.hidden, pinned: patch.pinned ?? m.pinned });
    _draw();
}

// ─── SHEET (LEVELS 2 + 3) ─────────────────────────────────────────────────────

function _sheetEls() {
    let sheet = document.getElementById('band-disco-sheet');
    if (!sheet) {
        sheet = document.createElement('div');
        sheet.id = 'band-disco-sheet';
        sheet.className = 'hidden fixed inset-0 z-[60]';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', 'Release details');
        sheet.setAttribute('aria-hidden', 'true');
        sheet.innerHTML = `
            <div data-action="close-sheet" class="absolute inset-0 bg-slate-900/50"></div>
            <div id="band-disco-sheet-body" tabindex="-1"
                 class="absolute inset-x-0 bottom-0 max-h-[90vh] overflow-y-auto bg-white rounded-t-[2rem] p-6 pb-10 outline-none"></div>`;
        document.body.appendChild(sheet);
        sheet.addEventListener('click', _onClick);
        sheet.addEventListener('change', _onChange);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeSheet(); });
    }
    return { sheet, body: sheet.querySelector('#band-disco-sheet-body') };
}

function _closeSheet() {
    const sheet = document.getElementById('band-disco-sheet');
    if (!sheet || sheet.classList.contains('hidden')) return;
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    S.sheet = null;
    _draw(); // want/own state may have changed while it was open
}

async function _openMaster(masterId) {
    const m = S.masters.find(x => x.discogs_master_id === masterId);
    if (!m) return;
    S.sheet = { masterId, m, view: 'master', detail: null, error: null,
                filters: {}, facets: {}, versions: [], page: 0, pages: 1, total: 0, loading: false };

    const { sheet, body } = _sheetEls();
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    _renderSheet();
    body.focus();

    const r = await _api('master', { masterId });
    if (!S.sheet || S.sheet.masterId !== masterId) return; // closed or switched meanwhile
    if (r.ok && !r.data?.rateLimited) S.sheet.detail = r.data;
    else S.sheet.error = r.data?.rateLimited || r.status === 202
        ? 'Discogs is busy right now \u2014 the details will load next time.'
        : (r.data?.error || 'Could not load the details.');
    _renderSheet();
}

function _renderSheet() {
    const { body } = _sheetEls();
    if (!S.sheet) return;
    body.innerHTML = S.sheet.view === 'pressings' ? _pressingsHtml() : _masterHtml();
    if (window.lucide) lucide.createIcons();
}

const _closeBtn = `<button type="button" data-action="close-sheet" aria-label="Close"
    class="absolute top-4 right-4 w-9 h-9 rounded-full bg-slate-100 text-slate-500 text-lg leading-none">&times;</button>`;

function _masterHtml() {
    const { m, detail, error, masterId } = S.sheet;
    const spotify = _spotifyUrl(m.spotify_album_id);
    const owned   = S.owned.get(masterId) || [];
    const wanted  = S.wants.has(_wantKey(masterId, null));
    const cover   = safeUrl(detail?.image_url || m.thumb || '');
    const chips   = [...(detail?.genres || []), ...(detail?.styles || [])]
        .map(g => `<span class="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full bg-slate-100 text-slate-500">${escapeHtml(g)}</span>`).join('');

    return `
    <div class="relative space-y-5">
        ${_closeBtn}
        <div class="flex gap-4 pr-10">
            <div class="w-28 h-28 shrink-0 rounded-2xl bg-slate-100 overflow-hidden">
                ${cover ? `<img src="${escapeHtml(cover)}" alt="" class="w-full h-full object-cover">` : ''}
            </div>
            <div class="min-w-0">
                <h3 class="font-display text-2xl italic text-slate-900 leading-tight">${escapeHtml(m.title)}</h3>
                <p class="text-sm text-slate-400">${m.year || ''}</p>
                ${spotify ? `<a href="${spotify}" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 mt-2 text-xs font-bold text-slate-700">${SPOTIFY_ICON}<span>Listen on Spotify</span></a>` : ''}
            </div>
        </div>
        ${chips ? `<div class="flex flex-wrap gap-1.5">${chips}</div>` : ''}
        ${error ? `<p class="text-xs text-amber-600">${escapeHtml(error)}</p>` : ''}

        ${owned.length ? `
        <div class="space-y-2">
            <h4 class="text-xs font-black uppercase tracking-widest text-slate-400">Your copies</h4>
            ${owned.map(it => `
            <button type="button" data-action="edit-item" data-id="${escapeHtml(it.id)}"
                    class="w-full text-left rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3">
                <span class="block text-sm font-bold text-slate-900">${escapeHtml(it.format || it.title || 'Release')}</span>
                <span class="block text-xs text-slate-500">${escapeHtml([it.label, it.country, it.item_date].filter(Boolean).join(' · '))}</span>
            </button>`).join('')}
        </div>` : ''}

        <div class="space-y-2">
            <button type="button" data-action="open-pressings"
                    class="w-full rounded-full bg-[#189BCC] text-white text-sm font-black uppercase tracking-wider py-3">
                ${owned.length ? 'Add another pressing' : 'Find your pressing'}
            </button>
            ${m.main_release_id ? `
            <button type="button" data-action="use-main"
                    class="w-full text-xs font-bold text-slate-500 py-2">Not sure which? Use the main release</button>` : ''}
            ${owned.length ? '' : `
            <button type="button" data-action="want-master" data-id="${masterId}"
                    class="w-full rounded-full border border-slate-200 text-sm font-black uppercase tracking-wider py-3 ${wanted ? 'text-amber-600 bg-amber-50' : 'text-slate-600'}"
                    aria-pressed="${wanted}">${wanted ? 'On your want list' : 'I want this'}</button>`}
        </div>

        ${detail?.tracklist?.length ? `
        <div class="space-y-2">
            <h4 class="text-xs font-black uppercase tracking-widest text-slate-400">Tracklist</h4>
            <ol class="text-sm text-slate-700 divide-y divide-slate-100">
                ${detail.tracklist.map(t => `
                <li class="flex gap-3 py-1.5">
                    <span class="w-8 shrink-0 text-xs text-slate-400">${escapeHtml(t.position)}</span>
                    <span class="flex-1">${escapeHtml(t.title)}</span>
                    <span class="text-xs text-slate-400">${escapeHtml(t.duration)}</span>
                </li>`).join('')}
            </ol>
        </div>` : (detail || error ? '' : '<div class="animate-pulse h-24 bg-slate-100 rounded-2xl"></div>')}
        ${detail?.uri ? `<a href="${escapeHtml(safeUrl(detail.uri))}" target="_blank" rel="noopener noreferrer" class="block text-xs text-[#189BCC]">View on Discogs</a>` : ''}
    </div>`;
}

// ─── LEVEL 3: PRESSINGS ───────────────────────────────────────────────────────

async function _openPressings() {
    S.sheet.view = 'pressings';
    S.sheet.filters = {}; S.sheet.versions = []; S.sheet.page = 0; S.sheet.pages = 1; S.sheet.error = null;
    _renderSheet();
    await _loadVersions();
}

async function _loadVersions() {
    const sh = S.sheet;
    if (!sh || sh.loading) return;
    sh.loading = true; sh.error = null;
    const masterId = sh.masterId;
    const r = await _api('versions', { masterId, page: sh.page + 1, ...sh.filters });
    if (!S.sheet || S.sheet.masterId !== masterId) return;
    sh.loading = false;

    if (r.ok && !r.data?.rateLimited) {
        sh.versions.push(...(r.data.versions || []));
        sh.page   = r.data.pagination?.page || sh.page + 1;
        sh.pages  = r.data.pagination?.pages || 1;
        sh.total  = r.data.pagination?.items ?? sh.versions.length;
        sh.truncated = !!r.data.truncated;
        sh.facets = r.data.facets || sh.facets;
    } else {
        sh.error = r.data?.rateLimited || r.status === 202
            ? 'Discogs is busy right now \u2014 give it a minute and try again.'
            : (r.data?.error || 'Could not load the pressings.');
    }
    _renderSheet();
}

function _facetSelect(name, label, facet) {
    const cur = S.sheet.filters[name] || '';
    const entries = Object.entries(facet || {});
    // Years read best chronologically; everything else by how many pressings it covers.
    if (name === 'released') entries.sort((a, b) => a[0].localeCompare(b[0]));
    else entries.sort((a, b) => b[1] - a[1]);
    entries.splice(name === 'released' ? 60 : 25);
    if (cur && !entries.some(([k]) => k === cur)) entries.unshift([cur, 0]);
    return `
    <label class="block">
        <span class="sr-only">${escapeHtml(label)}</span>
        <select data-filter="${name}" class="w-full rounded-full border border-slate-200 bg-white text-xs font-bold text-slate-600 px-3 py-2">
            <option value="">${escapeHtml(label)}</option>
            ${entries.map(([k, n]) => `<option value="${escapeHtml(k)}" ${k === cur ? 'selected' : ''}>${escapeHtml(k)}${n ? ` (${n})` : ''}</option>`).join('')}
        </select>
    </label>`;
}

function _fmtCount(n) {
    if (n == null) return '';
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function _pressingsHtml() {
    const sh = S.sheet;
    const rows = sh.versions.map(v => {
        const owned  = S.ownedPressings.has(v.id);
        const wanted = S.wants.has(_wantKey(sh.masterId, v.id));
        const meta   = [v.format, v.country, v.released].filter(Boolean).join(' · ');
        const rarity = (v.have != null || v.want != null)
            ? `${_fmtCount(v.have)} have · ${_fmtCount(v.want)} want` : '';
        return `
        <li class="py-3 flex items-center gap-3">
            <div class="min-w-0 flex-1">
                <div class="text-sm font-bold text-slate-900 truncate">${escapeHtml([v.label, v.catno].filter(Boolean).join(' \u2014 ') || v.title)}</div>
                <div class="text-xs text-slate-500">${escapeHtml(meta)}</div>
                ${rarity ? `<div class="text-[11px] text-slate-400">${escapeHtml(rarity)}</div>` : ''}
            </div>
            ${owned
                ? '<span class="shrink-0 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-full bg-emerald-50 text-emerald-600">Owned</span>'
                : `<button type="button" data-action="want-pressing" data-id="${v.id}" aria-pressed="${wanted}"
                        aria-label="${wanted ? 'Remove from' : 'Add to'} want list"
                        class="shrink-0 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-full border ${wanted ? 'border-amber-300 bg-amber-50 text-amber-600' : 'border-slate-200 text-slate-500'}">${wanted ? 'Wanted' : 'Want'}</button>
                   <button type="button" data-action="own-pressing" data-id="${v.id}"
                        class="shrink-0 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-full bg-[#189BCC] text-white">I have this</button>`}
        </li>`;
    }).join('');

    return `
    <div class="relative space-y-4">
        ${_closeBtn}
        <button type="button" data-action="back-to-master" class="text-xs font-black uppercase tracking-wider text-slate-500">&larr; ${escapeHtml(sh.m.title)}</button>
        <h3 class="font-display text-2xl italic text-slate-900">${sh.total ? `${sh.total} pressings` : 'Pressings'}</h3>
        <div class="grid grid-cols-3 gap-2">
            ${_facetSelect('format',   'Format',  sh.facets.format)}
            ${_facetSelect('country',  'Country', sh.facets.country)}
            ${_facetSelect('released', 'Year',    sh.facets.released)}
        </div>
        ${sh.error ? `<p class="text-xs text-amber-600">${escapeHtml(sh.error)}</p>` : ''}
        <ul class="divide-y divide-slate-100">${rows}</ul>
        ${sh.loading ? '<div class="animate-pulse h-16 bg-slate-100 rounded-2xl"></div>' : ''}
        ${!sh.loading && sh.page < sh.pages ? `<button type="button" data-action="more-pressings"
            class="w-full text-xs font-black uppercase tracking-wider py-3 rounded-full border border-slate-200 text-slate-600">Show more</button>` : ''}
        ${!sh.loading && !sh.versions.length && !sh.error ? '<p class="text-sm text-slate-500">No pressings match those filters.</p>' : ''}
        ${sh.truncated ? '<p class="text-[10px] text-slate-400">Very long list \u2014 showing the first 1,000 pressings.</p>' : ''}
        <p class="text-[10px] text-slate-400">Have/want counts are Discogs community numbers \u2014 a rough rarity cue.</p>
    </div>`;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

async function _toggleWant(masterId, discogsId) {
    const key = _wantKey(masterId, discogsId);
    if (S.wants.has(key)) {
        let q = supabase.from('discogs_wants').delete()
            .eq('user_id', S.userId).eq('discogs_master_id', masterId);
        q = discogsId ? q.eq('discogs_id', discogsId) : q.is('discogs_id', null);
        const { error } = await q;
        if (error) { console.warn('band-discography: want delete failed', error.message); return; }
        S.wants.delete(key);
    } else {
        const { error } = await supabase.from('discogs_wants').insert({
            user_id: S.userId, artist_id: S.artist.id,
            discogs_master_id: masterId, discogs_id: discogsId || null,
        });
        if (error) { console.warn('band-discography: want insert failed', error.message); return; }
        S.wants.add(key);
    }
    _renderSheet();
}

function _launchEditor(releaseId) {
    if (typeof window.openCollectionEditor !== 'function') {
        if (S.sheet) { S.sheet.error = 'The collection editor isn\u2019t available here.'; _renderSheet(); }
        return;
    }
    const bandName = S.bandName;
    _closeSheet();
    // Prefill: the editor fills itself from the pressing's Discogs link through its normal lookup path.
    window.openCollectionEditor(null, null, {
        discogsUrl: `https://www.discogs.com/release/${releaseId}`,
        bandName,
    });
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────

let _bound = false;
function _bindOnce(root) {
    if (_bound) return;
    _bound = true;
    root.addEventListener('click', _onClick);
    root.addEventListener('change', _onFilterChange);
    root.addEventListener('input', _onSearchInput);
}

let _searchTimer = null;
function _onSearchInput(e) {
    if (e.target.id !== 'band-disco-search') return;
    const value = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
        S.filters.q = value.trim();
        _drawFilters();
        _drawResults();
    }, 120);
}

function _onFilterChange(e) {
    const sel = e.target.closest('select[data-disco-filter]');
    if (!sel) return;
    S.filters[sel.dataset.discoFilter] = sel.value;
    _drawFilters();
    _drawResults();
}

function _onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    const id  = el.dataset.id ? Number(el.dataset.id) : null;

    switch (act) {
        case 'open-master':    return void _openMaster(id);
        case 'filter-kind':    S.filters.kind = el.dataset.kind || 'all'; _drawFilters(); return void _drawResults();
        case 'clear-filters': {
            S.filters = _defaultFilters();
            const box = document.getElementById('band-disco-search');
            if (box) box.value = '';
            _drawFilters();
            return void _drawResults();
        }
        case 'close-sheet':    return void _closeSheet();
        case 'open-pressings': return void _openPressings();
        case 'back-to-master': S.sheet.view = 'master'; return void _renderSheet();
        case 'more-pressings': return void _loadVersions();
        case 'use-main':       return void _launchEditor(S.sheet.m.main_release_id);
        case 'own-pressing':   return void _launchEditor(id);
        case 'want-master':    return void _toggleWant(S.sheet.masterId, null);
        case 'want-pressing':  return void _toggleWant(S.sheet.masterId, id);
        case 'edit-item':      { const itemId = el.dataset.id; _closeSheet(); return void window.openCollectionEditor?.(null, itemId); }
        case 'admin-search':   return void _adminSearch();
        case 'admin-confirm':  return void _adminConfirm(id);
        case 'admin-build':    return void _adminBuild();
        case 'curate-hide': {
            const m = S.masters.find(x => x.discogs_master_id === id);
            return void _curate(id, { hidden: !m?.hidden });
        }
        case 'curate-pin': {
            const m = S.masters.find(x => x.discogs_master_id === id);
            return void _curate(id, { pinned: !m?.pinned });
        }
    }
}

function _onChange(e) {
    const sel = e.target.closest('select[data-filter]');
    if (!sel || !S.sheet) return;
    const name = sel.dataset.filter;
    if (sel.value) S.sheet.filters[name] = sel.value; else delete S.sheet.filters[name];
    S.sheet.versions = []; S.sheet.page = 0;
    _renderSheet();
    _loadVersions();
}
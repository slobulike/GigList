/**
 * GigList — map-layers.js
 * The "Mine | Buddies | Everyone" switch on the personal Gigs map and the
 * full-screen map explorer. Like map vs satellite in Google Maps: the map and
 * its view stay where they are, only the pins change. A widening circle:
 *
 *   Mine      your venues (drawn by ui.js, as before)
 *   Buddies   venues your accepted gig buddies have been to, with their shows
 *             (tap one to open it). RLS only returns accepted buddies' journals.
 *   Everyone  every venue where GigList users have logged a past gig, sized by
 *             how many.
 *
 * In Buddies and Everyone, venues you've been to keep your colour, so you can
 * see where you fit in. Both follow the personal filters.
 *
 * Everyone comes from get_community_gig_venues (signed-in users only). Venue
 * counts include everyone; the dated list in a pop-up only shows gigs that 2+
 * people went to or that a public profile logged (claude review/community_privacy.sql).
 * It follows the personal filters the RPC understands: years, festival /
 * headline, and the artist (or else venue) text as its search.
 *
 * Personal mode only. Band mode has its own pins and legend (ui.js).
 */

import { supabase } from './supabase.js';
import { escapeHtml, safeUrl } from './utils.js';
import { getFilterState, applyFilters } from './filters.js';

const STORE_KEY = 'giglist.mapLayer';
const CACHE_MS  = 5 * 60 * 1000;
const COLOR = { mine: '#4f46e5', buddies: '#f59e0b', everyone: '#14b8a6' };
const LAYERS = [['mine', 'Mine'], ['buddies', 'Buddies'], ['everyone', 'Everyone']];
const _valid = (l) => LAYERS.some(([id]) => id === l) ? l : 'mine';

let _layer = (() => {
    try { return _valid(localStorage.getItem(STORE_KEY)); }
    catch { return 'mine'; }
})();
const _switches = new Set();   // switch elements on every map, kept in step
const _cache = new Map();      // rpc args → { at, data }

export const getMapLayer = () => _layer;

function _setLayer(layer) {
    _layer = _valid(layer);
    try { localStorage.setItem(STORE_KEY, _layer); } catch { /* per-viewer nicety only */ }
    _switches.forEach(_syncSwitch);
}

function _syncSwitch(el) {
    el.querySelectorAll('[data-map-layer]').forEach(btn => {
        const on = btn.dataset.mapLayer === _layer;
        btn.setAttribute('aria-pressed', String(on));
        btn.style.background = on ? '#4f46e5' : 'transparent';
        btn.style.color      = on ? '#fff' : '#475569';
    });
}

/**
 * Adds the switch to a Leaflet map once. onChange() is called after the layer
 * changes and should redraw that map's pins without moving it.
 */
export function addLayerSwitch(map, onChange) {
    if (map._layerSwitch) { _syncSwitch(map._layerSwitch.getContainer()); return; }
    const ctl = L.control({ position: 'topleft' });
    ctl.onAdd = () => {
        const el = L.DomUtil.create('div', 'gig-map-layer-switch');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', 'Whose venues to show');
        el.style.cssText = 'display:flex;gap:2px;background:rgba(255,255,255,.95);border-radius:9999px;padding:3px;box-shadow:0 1px 4px rgba(0,0,0,.2);font:900 10px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;';
        el.innerHTML = LAYERS.map(([id, label]) => `
            <button type="button" data-map-layer="${id}" aria-pressed="false"
                    style="border:0;border-radius:9999px;padding:7px 10px;cursor:pointer;">${label}</button>`).join('');
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-map-layer]');
            if (!btn || btn.dataset.mapLayer === _layer) return;
            _setLayer(btn.dataset.mapLayer);
            onChange();
        });
        _switches.add(el);
        _syncSwitch(el);
        return el;
    };
    ctl.addTo(map);
    map._layerSwitch = ctl;
}

/** Band mode reuses the same map instance: take the switch and legend off. */
export function removeLayerSwitch(map) {
    if (map._layerSwitch) {
        _switches.delete(map._layerSwitch.getContainer());
        map._layerSwitch.remove();
        map._layerSwitch = null;
    }
    _setLegend(map, null);
}

function _setLegend(map, html) {
    if (map._everyoneLegend) { map._everyoneLegend.remove(); map._everyoneLegend = null; }
    if (!html) return;
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
        const el = L.DomUtil.create('div', 'gig-map-legend');
        el.style.cssText = 'background:rgba(255,255,255,.92);border-radius:12px;padding:6px 10px;font:700 10px/1.6 system-ui,sans-serif;color:#475569;box-shadow:0 1px 4px rgba(0,0,0,.2);';
        el.innerHTML = html;
        return el;
    };
    legend.addTo(map);
    map._everyoneLegend = legend;
}

/** Call when Mine is showing, so the Buddies / Everyone legend doesn't linger. */
export const clearLayerLegend = (map) => _setLegend(map, null);

const _dot = c => `<span style="display:inline-block;width:9px;height:9px;border-radius:9999px;background:${c};margin-right:6px;vertical-align:middle;"></span>`;

function _rpcArgs() {
    const f = getFilterState();
    const args = { p_search: (f.artist || f.venue || '').trim() || null };
    if (f.years.length) args.p_years = f.years.map(Number);
    if (f.festival === 'festival') args.p_festival = true;
    else if (f.festival === 'headline') args.p_festival = false;
    return args;
}

async function _loadEveryone(args) {
    const key = JSON.stringify(args);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const { data, error } = await supabase.rpc('get_community_gig_venues', args);
    if (error) throw error;
    _cache.set(key, { at: Date.now(), data });
    return data;
}

// Community venues carry coordinates but no id, so "have I been here" matches on
// position (~100 m), which also copes with the same room under two names.
const _spot = (lat, lng) => `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;

/**
 * Draws the Everyone pins into layerGroup. myGigs (the gigs the Mine layer
 * would show) and resolveVenue (gig → { lat, lng }) decide which venues are
 * yours. Returns false if the data couldn't be loaded.
 */
export async function renderEveryonePins(map, layerGroup, myGigs, resolveVenue) {
    let res;
    try {
        res = await _loadEveryone(_rpcArgs());
    } catch (err) {
        console.warn('[map-layers] everyone venues failed', err);
        return false;
    }

    const mine = new Set();
    (myGigs || []).forEach(g => {
        const v = resolveVenue(g);
        if (v && !isNaN(v.lat)) mine.add(_spot(v.lat, v.lng));
    });

    const venues = (res?.venues || [])
        .map(v => ({ ...v, lat: Number(v.lat), lng: Number(v.lng) }))
        .filter(v => isFinite(v.lat) && isFinite(v.lng))
        .map(v => ({ ...v, isMine: mine.has(_spot(v.lat, v.lng)) }))
        .sort((a, b) => Number(a.isMine) - Number(b.isMine));   // yours drawn on top

    venues.forEach(v => {
        const gigs  = Number(v.gigs) || 0;
        const shown = v.recent || [];
        const recent = shown.map(r => `
            <div class="p-2 border-b border-slate-100 last:border-0 mb-1">
                <p class="text-[10px] font-black text-teal-600 uppercase leading-none">${escapeHtml(r.date)}</p>
                <p class="text-[12px] font-bold text-slate-800 leading-tight">${escapeHtml(r.band || '')}</p>
            </div>`).join('');
        const more = gigs > shown.length
            ? `<p class="text-[10px] text-slate-400 text-center">+ ${gigs - shown.length} more</p>` : '';

        L.circleMarker([v.lat, v.lng], {
            radius: Math.min(5 + Math.sqrt(gigs || 1) * 2.2, 22),
            fillColor: v.isMine ? COLOR.mine : COLOR.everyone,
            color: '#fff', weight: 2, fillOpacity: 0.9,
        }).bindPopup(`
            <div class="p-1 max-h-48 overflow-y-auto custom-scrollbar min-w-[180px]">
                <h4 class="text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">
                    ${escapeHtml(v.name || '')}${v.city ? ' · ' + escapeHtml(v.city) : ''}
                </h4>
                ${recent}${more}
                <div class="pt-2 text-center space-y-1">
                    <span class="inline-block bg-teal-50 text-teal-700 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                        ${gigs} ${gigs === 1 ? 'gig' : 'gigs'} by GigList users
                    </span>
                    ${v.isMine ? '<span class="block text-[10px] font-black text-indigo-600 uppercase">You’ve been here</span>' : ''}
                </div>
            </div>`, { maxWidth: 250, className: 'gig-map-popup' })
         .addTo(layerGroup);
    });

    const unmapped = Number(res?.unmapped) || 0;
    _setLegend(map,
        `${_dot(COLOR.mine)}You’ve been here<br>${_dot(COLOR.everyone)}Other GigList venues` +
        (unmapped ? `<br><span style="font-weight:600;color:#94a3b8;">${unmapped} venue${unmapped === 1 ? '' : 's'} not on the map yet</span>` : ''));
    return true;
}


// ─── BUDDIES ──────────────────────────────────────────────────────────────────

const BUDDY_COLS = 'id, user_id, journal_key, date, band, official_venue, venue, venue_id, festival, festival_lineups, notable_support, went_with, photos, review_url';
let _buddyCache = null;          // { at, ids, rows }
const _venueCoords = new Map();  // 'id:<n>' | 'name:<official_name>' → { lat, lng, name, city } | null

async function _loadBuddyRows(ids) {
    const key = ids.slice().sort().join(',');
    if (_buddyCache && _buddyCache.ids === key && Date.now() - _buddyCache.at < CACHE_MS) return _buddyCache.rows;
    const { data, error } = await supabase.from('journals').select(BUDDY_COLS).in('user_id', ids);
    if (error) throw error;
    _buddyCache = { at: Date.now(), ids: key, rows: data || [] };
    return _buddyCache.rows;
}

// Your own venue lookup only holds your venues, so look up the rest once.
async function _ensureVenueCoords(rows) {
    const byId = window.venuesById || {};
    const byName = window.allVenues || {};
    const ids = new Set(), names = new Set();
    rows.forEach(r => {
        if (r.venue_id != null) {
            if (!byId[r.venue_id] && !_venueCoords.has(`id:${r.venue_id}`)) ids.add(Number(r.venue_id));
        } else if (r.official_venue && !byName[r.official_venue] && !_venueCoords.has(`name:${r.official_venue}`)) {
            names.add(r.official_venue);
        }
    });
    const store = (v) => {
        const info = { lat: parseFloat(v.latitude), lng: parseFloat(v.longitude), name: v.official_name, city: v.city || '' };
        if (v.id != null) _venueCoords.set(`id:${v.id}`, info);
        if (v.official_name) _venueCoords.set(`name:${v.official_name}`, info);
    };
    const cols = 'id, official_name, city, latitude, longitude';
    const idList = [...ids].filter(Number.isFinite);
    for (let i = 0; i < idList.length; i += 150) {
        const { data } = await supabase.from('venues').select(cols).in('id', idList.slice(i, i + 150));
        (data || []).forEach(store);
    }
    const nameList = [...names];
    for (let i = 0; i < nameList.length; i += 50) {
        const { data } = await supabase.from('venues').select(cols).in('official_name', nameList.slice(i, i + 50));
        (data || []).forEach(store);
    }
    idList.forEach(id => { if (!_venueCoords.has(`id:${id}`)) _venueCoords.set(`id:${id}`, null); });
    nameList.forEach(n => { if (!_venueCoords.has(`name:${n}`)) _venueCoords.set(`name:${n}`, null); });
}

function _buddyVenue(r) {
    const own = (r.venue_id != null && window.venuesById?.[r.venue_id]) || (window.allVenues || {})[r.official_venue];
    if (own && !isNaN(own.lat)) return { lat: own.lat, lng: own.lng, name: own.name || r.official_venue, city: own.city || '' };
    return (r.venue_id != null ? _venueCoords.get(`id:${r.venue_id}`) : null)
        || _venueCoords.get(`name:${r.official_venue}`) || null;
}

const _ddmmyyyy = (raw) => {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw || '');
    return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : (raw || '');
};
const _sortKey = (raw) => {
    const d = _ddmmyyyy(raw).split('/');
    return d.length === 3 ? `${d[2]}${d[1]}${d[0]}` : '';
};

// Same face pin as band mode (ui.js _bandPlaceMarker): the buddy who's been
// there most (most recent on a tie), ringed in your colour if you've been too,
// with +N for the other buddies.
function _buddyIcon(shows, isMine, nameOf, avatarOf) {
    const tally = new Map();   // buddy id → { n, last }
    shows.forEach(sh => new Set(sh.who).forEach(id => {
        const t = tally.get(id) || { n: 0, last: '' };
        t.n += 1;
        if (_sortKey(sh.date) > t.last) t.last = _sortKey(sh.date);
        tally.set(id, t);
    }));
    const [topId] = [...tally.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last))[0] || [];
    const ring  = isMine ? COLOR.mine : COLOR.buddies;
    const src   = avatarOf.get(topId);
    const name  = nameOf.get(topId) || '';
    const inner = src
        ? `<img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:cover;">`
        : escapeHtml((name || '?').slice(0, 2).toUpperCase());
    const extra = tally.size > 1
        ? `<span style="position:absolute;right:-6px;bottom:-4px;background:${ring};color:#fff;font-size:9px;font-weight:900;border-radius:9999px;padding:1px 5px;border:2px solid #fff;">+${tally.size - 1}</span>`
        : '';
    const html = `<div style="position:relative;width:34px;height:34px;">
        <div style="width:34px;height:34px;border-radius:9999px;border:3px solid ${ring};background:#fef3c7;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;color:#b45309;">${inner}</div>${extra}</div>`;
    return L.divIcon({ html, className: '', iconSize: [34, 34], iconAnchor: [17, 17] });
}

let _buddyClicksWired = false;
function _wireBuddyShowClicks() {
    if (_buddyClicksWired) return;
    _buddyClicksWired = true;
    document.addEventListener('click', (e) => {
        const row = e.target.closest('[data-map-buddy-show]');
        if (!row || typeof window._feedOpenBuddyShow !== 'function') return;
        window._feedOpenBuddyShow(row.dataset.mapBuddyShow, row.dataset.mapBuddyIds || '');
    });
}

/**
 * Draws the Buddies pins into layerGroup: one pin per venue your accepted
 * buddies have been to (personal filters applied to their gigs), listing
 * their shows there. Returns false if their gigs couldn't be loaded.
 */
export async function renderBuddyPins(map, layerGroup, myGigs, resolveVenue) {
    const buddies = window._following || [];
    if (!buddies.length) {
        _setLegend(map, `${_dot(COLOR.buddies)}No gig buddies yet`);
        return true;
    }
    let rows;
    try {
        rows = applyFilters(await _loadBuddyRows(buddies.map(b => b.id)));
        await _ensureVenueCoords(rows);
    } catch (err) {
        console.warn('[map-layers] buddy gigs failed', err);
        return false;
    }

    const nameOf = new Map(buddies.map(b => [b.id, b.display_name || b.username || 'A buddy']));
    const avatarOf = new Map(buddies.map(b => [b.id, safeUrl(b.avatar_url || '')]));
    const mine = new Set();
    (myGigs || []).forEach(g => {
        const v = resolveVenue(g);
        if (v && !isNaN(v.lat)) mine.add(_spot(v.lat, v.lng));
    });

    // One pin per place; one line per show, with every buddy who logged it
    const places = new Map();
    let unmapped = 0;
    rows.forEach(r => {
        const v = _buddyVenue(r);
        if (!v || !isFinite(v.lat) || !isFinite(v.lng)) { unmapped++; return; }
        const spot = _spot(v.lat, v.lng);
        if (!places.has(spot)) places.set(spot, { ...v, shows: new Map() });
        const shows = places.get(spot).shows;
        const key = r.journal_key || `row:${r.id}`;
        if (!shows.has(key)) shows.set(key, { key: r.journal_key, date: r.date, band: r.band, who: [] });
        shows.get(key).who.push(r.user_id);
    });

    const list = [...places.values()]
        .map(p => ({ ...p, isMine: mine.has(_spot(p.lat, p.lng)) }))
        .sort((a, b) => Number(a.isMine) - Number(b.isMine));   // yours drawn on top

    list.forEach(p => {
        const shows = [...p.shows.values()].sort((a, b) => _sortKey(b.date).localeCompare(_sortKey(a.date)));
        const rowsHtml = shows.map(sh => {
            const names = [...new Set(sh.who)].map(id => nameOf.get(id) || 'A buddy').join(', ');
            const open = sh.key
                ? ` data-map-buddy-show="${escapeHtml(sh.key)}" data-map-buddy-ids="${escapeHtml([...new Set(sh.who)].join(','))}" role="button" tabindex="0"`
                : '';
            return `
            <div${open} class="${sh.key ? 'cursor-pointer hover:bg-slate-50 ' : ''}p-2 rounded transition-colors border-b border-slate-100 last:border-0 mb-1">
                <p class="text-[10px] font-black text-amber-600 uppercase leading-none">${escapeHtml(_ddmmyyyy(sh.date))}</p>
                <p class="text-[12px] font-bold text-slate-800 leading-tight">${escapeHtml(sh.band || '')}</p>
                <p class="text-[10px] text-slate-500 leading-tight">${escapeHtml(names)}</p>
            </div>`;
        }).join('');

        L.marker([p.lat, p.lng], { icon: _buddyIcon(shows, p.isMine, nameOf, avatarOf) }).bindPopup(`
            <div class="p-1 max-h-48 overflow-y-auto custom-scrollbar min-w-[180px]">
                <h4 class="text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">
                    ${escapeHtml(p.name || '')}${p.city ? ' · ' + escapeHtml(p.city) : ''}
                </h4>
                ${rowsHtml}
                <div class="pt-2 text-center space-y-1">
                    <span class="inline-block bg-amber-50 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                        ${shows.length} buddy ${shows.length === 1 ? 'show' : 'shows'}
                    </span>
                    ${p.isMine ? '<span class="block text-[10px] font-black text-indigo-600 uppercase">You’ve been here too</span>' : ''}
                </div>
            </div>`, { maxWidth: 250, className: 'gig-map-popup' })
         .addTo(layerGroup);
    });

    _wireBuddyShowClicks();
    _setLegend(map,
        `${_dot(COLOR.mine)}You’ve been here too<br>${_dot(COLOR.buddies)}Your buddies have been here` +
        (unmapped ? `<br><span style="font-weight:600;color:#94a3b8;">${unmapped} show${unmapped === 1 ? '' : 's'} not on the map yet</span>` : ''));
    return true;
}
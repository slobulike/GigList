/**
 * GigList — Band Mode Module
 * band.js
 * -------------------------------------------------------------------
 * Owns band mode navigation: Gigs, Stats, Fans.
 * Gigs and Stats are the SAME sections personal mode uses (#view-data and
 * #view-stats, rendered by app.js refreshUI / ui.js / charts.js); band.js only
 * adapts their copy, adds the band narrative + stat tiles, and owns Fans.
 * Imported and called from app.js after data load when isBandMode.
 *
 * Public API (exposed on window):
 *   window.switchBandView(tab)   — 'gigs' | 'stats' | 'fans'
 *                                   ('shows' / 'summary' still accepted)
 *   window.bandShowsSearch(val)  — sets the shared search box (back-compat)
 *
 * Data model note:
 *   journals.user_id = null  → imported via band-archive script (setlist.fm)
 *   journals.user_id = <uuid> → logged by a real GigList user
 * This distinction drives the "Shows Archived" vs "Fan Attendance" stats.
 */

import { supabase }             from './supabase.js';
import { parseDate, escapeHtml, safeUrl } from './utils.js';
import { loadPerformances }     from './data.js';

// ─── Module-level state ───────────────────────────────────────────────────────

let _journalData     = [];   // all shows for this band (archive + user-logged)
let _performanceData = [];
let _tagging         = new Set();   // journal keys with a tag request in flight
let _justCreated     = new Set();   // keys whose row we created this session (undo-able)
let _tagListenerBound = false;
const _bulk = { active: false, selected: new Set() };   // bulk "mark shows I was at" mode
window._bandBulk = _bulk;
let _currentUser     = null;
let _buddyStatus     = {};   // userId -> 'accepted' | 'pending' | null
let _fanCount          = null;  // unique fans (distinct user_ids), set by _loadBandStats
let _fanAttendance     = null;  // total attended show-instances, set by _loadBandStats
let _performancesLoaded = false; // guard so we only fetch once
// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initBandMode(currentUser, journalData, performanceData) {
    _currentUser     = currentUser;
    _journalData     = journalData     || [];
    _performanceData = performanceData || [];

    // Expose tab switcher globally (called by band nav onclick in vault.html)
    window.switchBandView  = switchBandView;
    window.bandShowsSearch = (val) => {
        const el = document.getElementById('searchInput');
        if (el) { el.value = val || ''; window.refreshUI?.(); }
    };
    window.isReadOnly = !_currentUser?.is_admin;

    // Load buddy status for the authed viewer (non-blocking)
    if (_currentUser?.isAuthUser) {
        _loadBuddyStatus().catch(err => console.warn('band.js: buddy status load failed', err));
    }

    // Load band stats for the stat strip (non-blocking)
    _loadBandStats().catch(err => console.warn('band.js: band stats load failed', err));

    // Render the band hero shown above every tab (non-blocking)
    _renderBandHero().catch(err => console.warn('band.js: hero render failed', err));

    // Band-specific copy on the shared Gigs / Stats views
    _applyBandCopy();

    // Attendance counts, buddy avatars and "I was there" (non-blocking)
    window.bandTagShow  = bandTagShow;
    window.bandUndoTag  = bandUndoTag;
    window.bandBulkStart = bandBulkStart;
    _bindTagClicks();
    _loadBandAttendance().catch(err => console.warn('band.js: attendance load failed', err));

    // Show default tab (first paint happens before setlists load)
    switchBandView('gigs');

    // Setlists feed the Songs tile, song search and Top Songs chart, so load
    // them in the background and re-render when they arrive.
    setTimeout(() => {
        _loadPerformancesIfNeeded().then(() => {
            window.refreshUI?.();
            _renderBandStory();
        });
    }, 0);
}

function _applyBandCopy() {
    const band = window.currentArtist || 'this band';
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('data-centre-title', 'Shows');
    set('data-centre-subtitle', `Every ${band} show on record`);
    set('stats-subtitle', `${band}, charted`);
    ['searchInput', 'statsSearchInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.placeholder = 'Search venues, songs, dates…';
            el.setAttribute('aria-label', 'Search venues, songs or dates');
        }
    });
}

// ─── TAB SWITCHER ─────────────────────────────────────────────────────────────

const _BAND_TAB_ALIASES = { shows: 'gigs', summary: 'stats' };
const _BAND_TAB_SECTION = { gigs: 'view-data', stats: 'view-stats', fans: 'view-band-fans' };

function switchBandView(tab) {
    tab = _BAND_TAB_ALIASES[tab] || tab;
    const targetId = _BAND_TAB_SECTION[tab];
    if (!targetId) return;
    if (_bulk.active && tab !== 'gigs') bandBulkCancel();

    // Hide every section (shared personal views + band-only ones), show target
    document.querySelectorAll('.view-section, .band-view-section').forEach(s => {
        s.classList.add('hidden');
        s.setAttribute('aria-hidden', 'true');
    });
    const target = document.getElementById(targetId);
    if (target) {
        target.classList.remove('hidden');
        target.setAttribute('aria-hidden', 'false');
    }

    // Update band nav active state
    ['gigs', 'stats', 'fans'].forEach(t => {
        const btn = document.getElementById(`band-nav-${t}`);
        if (!btn) return;
        if (t === tab) {
            btn.classList.add('active', 'text-[#189BCC]', 'bg-white', 'shadow-sm');
            btn.classList.remove('text-slate-400');
            btn.setAttribute('aria-current', 'page');
        } else {
            btn.classList.remove('active', 'text-[#189BCC]', 'bg-white', 'shadow-sm');
            btn.classList.add('text-slate-400');
            btn.setAttribute('aria-current', 'false');
        }
    });

    if (tab === 'gigs' || tab === 'stats') {
        // Shared views render from refreshUI; make sure they reflect current data
        window.refreshUI?.();
        if (tab === 'stats') _renderBandStory();
    }
    if (tab === 'fans') _renderBandFans();

    if (window.lucide) lucide.createIcons();
    window.scrollTo(0, 0);
}

// ─── HERO ─────────────────────────────────────────────────────────────────────
// Compact band card shown above every tab: image on top, name + stats on a
// coloured strip below. Image priority:
//   1. an uploaded band-photos/<slug>/hero.{jpg,png,webp}
//   2. the artist's Spotify image (artists.spotify_image_url)
//   3. a gradient with the band's initial
// Spotify's design guidelines: content from Spotify must carry the Spotify
// icon + a link back to the artist, and nothing (text or logo) may be laid over
// the artwork — so the name and the Spotify link live on the strip, not the image.
// The strip colour is sampled from the image (fallback: ui.js band colours, then
// GigList blue) and exposed as window.bandBrandColor.

const _DEFAULT_BRAND = '#189BCC';

// Spotify glyph (green on a light pill, per the guidelines' light-background use)
const _SPOTIFY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

async function _renderBandHero() {
    const container = document.getElementById('band-hero');
    const bandName  = window.currentArtist;
    if (!container || !bandName) return;

    // Paint the placeholder straight away so there's no empty gap while images load
    _paintHero(container, bandName, null, null);

    const slug = bandName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    let imageUrl = await _findUploadedHero(slug);
    let spotify  = null;
    if (!imageUrl) {
        const found = await _findSpotifyImage(bandName);
        if (found?.imageUrl) {
            imageUrl = found.imageUrl;
            spotify  = { url: found.artistId
                ? `https://open.spotify.com/artist/${encodeURIComponent(found.artistId)}`
                : `https://open.spotify.com/search/${encodeURIComponent(bandName)}` };
        }
    }
    if (!imageUrl) return;

    // Try with CORS so we can sample a colour; fall back to a plain display load
    let img = await _loadImg(imageUrl, true);
    let color = null;
    if (img) {
        try { color = _dominantColor(img); } catch (_) { /* canvas tainted */ }
    } else {
        img = await _loadImg(imageUrl, false);
    }
    if (!img) return;

    if (color) {
        window.bandBrandColor = color;
        const header = document.querySelector('header');
        if (header) header.style.backgroundColor = color;
        document.documentElement.style.setProperty('--band-accent', color);
    }
    _paintHero(container, bandName, imageUrl, spotify);
}

function _paintHero(container, bandName, imageUrl, spotify) {
    const initial = bandName.charAt(0).toUpperCase();
    const brand   = window.bandBrandColor || _DEFAULT_BRAND;
    const years   = _journalData.map(g => parseDate(g.Date)).filter(Boolean).map(d => d.getFullYear());
    const subline = years.length
        ? `${_journalData.length.toLocaleString('en-GB')} shows · ${Math.min(...years)}–${Math.max(...years)}`
        : '';

    const picture = imageUrl
        ? `<img src="${escapeHtml(safeUrl(imageUrl))}" alt="${escapeHtml(bandName)}" class="absolute inset-0 w-full h-full object-cover" style="object-position:center 25%">`
        : `<div class="absolute inset-0" style="background:linear-gradient(135deg, ${escapeHtml(brand)}, #4f46e5)"></div>
           <span class="absolute right-4 -bottom-4 text-white/10 font-black text-[8rem] leading-none select-none pointer-events-none">${escapeHtml(initial)}</span>`;

    const spotifyLink = spotify
        ? `<a href="${escapeHtml(spotify.url)}" target="_blank" rel="noopener noreferrer"
              class="flex-shrink-0 inline-flex items-center gap-1.5 bg-white text-slate-800 text-[10px] font-black uppercase tracking-wider pl-2 pr-3 py-1.5 rounded-full shadow-sm hover:bg-slate-50 active:scale-95 transition"
              aria-label="Open ${escapeHtml(bandName)} on Spotify">
              ${_SPOTIFY_ICON}<span>Open in Spotify</span>
           </a>`
        : '';

    container.innerHTML = `
        <div class="w-full overflow-hidden rounded-3xl shadow-sm">
            <div class="relative w-full h-32 bg-slate-200">${picture}</div>
            <div class="flex items-center justify-between gap-3 px-5 py-3 text-white" style="background:${escapeHtml(brand)}">
                <div class="min-w-0">
                    <p class="font-black text-xl leading-tight truncate">${escapeHtml(bandName)}</p>
                    ${subline ? `<p class="text-white/80 text-[10px] font-black uppercase tracking-widest mt-0.5">${escapeHtml(subline)}</p>` : ''}
                </div>
                ${spotifyLink}
            </div>
        </div>`;
}

async function _findUploadedHero(slug) {
    // Supabase public bucket URLs don't reliably 404 on missing objects, so test
    // each candidate by actually loading it as an image.
    for (const ext of ['jpg', 'png', 'webp']) {
        const { data } = supabase.storage.from('band-photos').getPublicUrl(`${slug}/hero.${ext}`);
        if (data?.publicUrl && await _loadImg(data.publicUrl, false)) return data.publicUrl;
    }
    return null;
}

async function _findSpotifyImage(bandName) {
    try {
        const { data } = await supabase
            .from('artists')
            .select('spotify_image_url, spotify_artist_id')
            .eq('name', bandName)
            .maybeSingle();
        return data?.spotify_image_url
            ? { imageUrl: data.spotify_image_url, artistId: data.spotify_artist_id || null }
            : null;
    } catch (err) {
        console.warn('band.js: spotify image lookup failed', err);
        return null;
    }
}

function _loadImg(url, cors) {
    return new Promise(resolve => {
        const img = new Image();
        if (cors) img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Most common saturated colour in a 40×40 downsample, darkened until white text
// stays readable on it. Throws if the canvas is tainted (no CORS) — caller catches.
function _dominantColor(img) {
    const size = 40;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 200) continue;
        const [r, g, bl] = [px[i], px[i + 1], px[i + 2]];
        const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (max < 40 || min > 225 || sat < 0.25) continue;   // too dark / light / grey
        const key = `${r >> 5},${g >> 5},${bl >> 5}`;
        const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += bl;
        buckets.set(key, e);
    }
    if (!buckets.size) return null;

    const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
    let rgb = [top.r / top.n, top.g / top.n, top.b / top.n];

    // Relative luminance ≤ 0.2 keeps white text above ~4.5:1 contrast
    const lum = ([r, g, b]) => {
        const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    for (let i = 0; i < 12 && lum(rgb) > 0.2; i++) rgb = rgb.map(c => c * 0.88);
    return `rgb(${rgb.map(Math.round).join(',')})`;
}

// ─── ATTENDANCE + "I WAS THERE" ───────────────────────────────────────────────
// window._bandAttendance feeds the shared Gigs table (ui.js renderTable):
//   byKey   Map<journal_key, { count, buddyIds[], mine }>
//   people  { [userId]: profile }   — accepted buddies only
//   canTag  boolean                 — viewer is signed in
// get_band_attendance (security definer) gives everyone the counts but returns
// only the viewer and their accepted buddies by id, so strangers' identities
// never reach the client from this feature.

async function _loadBandAttendance() {
    const bandName = window.currentArtist;
    if (!bandName) return;

    const att = {
        byKey:  new Map(),
        people: {},
        canTag: !!(_currentUser?.isAuthUser && _currentUser?.id),
        justCreated: _justCreated,   // keys tagged this session (inline Undo in the list)
    };
    window._bandAttendance = att;

    const bulkEntry = document.getElementById('band-bulk-entry');
    if (bulkEntry) bulkEntry.style.display = att.canTag ? 'flex' : 'none';

    const { data, error } = await supabase.rpc('get_band_attendance', { p_band: bandName });
    if (error) {
        // e.g. the SQL function hasn't been created yet — the table still shows
        // the tag button, just without counts.
        console.warn('band.js: get_band_attendance failed', error.message);
        window.refreshUI?.();
        return;
    }

    (data || []).forEach(r => att.byKey.set(r.journal_key, {
        count:    r.attendee_count || 0,
        buddyIds: r.buddy_ids || [],
        mine:     !!r.i_was_there,
    }));

    const ids = [...new Set((data || []).flatMap(r => r.buddy_ids || []))];
    if (ids.length) {
        const { data: profiles } = await supabase.rpc('get_profiles_by_ids', { user_ids: ids });
        (profiles || []).forEach(p => { att.people[p.id] = p; });
    }
    window.refreshUI?.();
    _refreshBandModal();
}

// Keep the open gig modal's attendance strip in step with tag / untag / reload
function _refreshBandModal(journalKey) {
    const slot = document.getElementById('band-modal-attendance');
    if (!slot || !window._bandModalAttendanceHtml) return;
    const key = journalKey || slot.dataset.key;
    if (slot.dataset.key !== key) return;
    const entry = _journalData.find(g => g['Journal Key'] === key);
    if (!entry) return;
    slot.innerHTML = window._bandModalAttendanceHtml(entry);
    if (window.lucide) lucide.createIcons();
}

function _bindTagClicks() {
    if (_tagListenerBound) return;
    _tagListenerBound = true;
    // Capture phase so the row's "open gig" handler never sees these clicks.
    document.addEventListener('click', (e) => {
        const t = e.target;

        // Bulk mode: a tap on any row selects/deselects it instead of opening it
        if (_bulk.active) {
            const row = t.closest?.('tr[data-view-gig-key]');
            if (row) {
                e.stopPropagation();
                e.preventDefault();
                _bulkToggleRow(row);
                return;
            }
        }

        const tagBtn   = t.closest?.('[data-band-tag]');
        const untagBtn = t.closest?.('[data-band-untag]');
        const mineBtn  = t.closest?.('[data-band-mine]');
        if (!tagBtn && !untagBtn && !mineBtn) return;
        e.stopPropagation();
        e.preventDefault();
        if (tagBtn)   bandTagShow(tagBtn.dataset.bandTag);
        if (untagBtn) bandUndoTag(untagBtn.dataset.bandUntag);
        if (mineBtn)  bandRemoveMine(mineBtn.dataset.bandMine);
    }, true);
}

// One journal row, same shape the editor writes, everything personal blank.
function _buildJournalRow(src, me) {
    return {
        user_id:          me,
        journal_key:      src['Journal Key'] || src.journal_key,
        date:             src.date || src.Date,
        band:             src.band || src.Band,
        official_venue:   src.official_venue || src.OfficialVenue,
        venue:            src.venue || src.official_venue || src.OfficialVenue,
        festival:         !!src.festival,
        festival_lineups: '',
        notable_support:  '',
        went_with:        '',
        comments:         '',
        photos:           '',
        price:            '',
        review_url:       '',
        artist_id:        src.artist_id ?? null,
    };
}

async function bandTagShow(journalKey) {
    const att = window._bandAttendance;
    const me  = _currentUser?.id;
    if (!att?.canTag || !me || !journalKey || _tagging.has(journalKey)) return;

    const src = _journalData.find(g => g['Journal Key'] === journalKey);
    if (!src) return;

    const info = att.byKey.get(journalKey) || { count: 0, buddyIds: [], mine: false };
    if (info.mine) return;

    _tagging.add(journalKey);
    try {
        // Same shape the editor writes, with everything personal left blank.
        // ignoreDuplicates = ON CONFLICT DO NOTHING: if the viewer already has a
        // row for this event (e.g. a festival day logged under another band) it
        // is left untouched instead of being overwritten.
        const row = _buildJournalRow(src, me);

        const { data, error } = await supabase
            .from('journals')
            .upsert(row, { onConflict: 'user_id,journal_key', ignoreDuplicates: true })
            .select('id');
        if (error) throw error;

        const created = (data || []).length > 0;
        info.mine = true;
        if (created) info.count += 1;      // an existing row was already counted
        att.byKey.set(journalKey, info);
        if (created) _justCreated.add(journalKey);
        window.refreshUI?.();
        _refreshBandModal(journalKey);

        if (created) {
            _showUndoSnackbar(journalKey);
            _loadBandStats().catch(() => {});   // refresh fan / reach numbers
        } else {
            window.showToast?.('That show is already in your journal', 'info');
        }
    } catch (err) {
        console.error('band.js: tag failed', err);
        window.showToast?.('Couldn’t add that show — try again', 'error');
    } finally {
        _tagging.delete(journalKey);
    }
}

// Deletes the viewer's own row for an event. Verifies a row was really removed
// (RLS can make a delete "succeed" with zero rows) and shows the real error.
async function _deleteOwnRow(journalKey) {
    const me = _currentUser?.id;
    if (!me) return false;
    const { data, error } = await supabase
        .from('journals').delete()
        .eq('user_id', me).eq('journal_key', journalKey)
        .select('id');
    if (error) {
        console.error('band.js: remove failed', error);
        window.showToast?.(`Couldn’t remove it: ${error.message}`, 'error', 6000);
        return false;
    }
    if (!(data || []).length) {
        console.error('band.js: remove deleted no rows', { me, journalKey });
        window.showToast?.('Couldn’t remove it — nothing was deleted', 'error', 6000);
        return false;
    }
    return true;
}

function _markNotMine(journalKey) {
    _justCreated.delete(journalKey);
    const info = window._bandAttendance?.byKey.get(journalKey);
    if (info) { info.mine = false; info.count = Math.max(0, info.count - 1); }
    window.refreshUI?.();
    _refreshBandModal(journalKey);
    _loadBandStats().catch(() => {});
}

// Undo only removes a row this session just created, so it can never delete an
// entry the viewer has since filled in.
async function bandUndoTag(journalKey) {
    if (!_justCreated.has(journalKey)) return;
    document.getElementById('band-undo-snackbar')?.remove();
    if (await _deleteOwnRow(journalKey)) _markNotMine(journalKey);
}

// Tapping "You were there" later on: safe to remove only while the entry is
// still blank. Anything the viewer added (notes, photos, companions…) is theirs.
const _DETAIL_FIELDS = ['comments', 'photos', 'went_with', 'price', 'review_url', 'festival_lineups', 'notable_support'];

async function bandRemoveMine(journalKey) {
    const me = _currentUser?.id;
    if (!me) return;

    const { data: row, error } = await supabase
        .from('journals')
        .select(['id', ..._DETAIL_FIELDS].join(', '))
        .eq('user_id', me).eq('journal_key', journalKey)
        .maybeSingle();
    if (error || !row) {
        window.showToast?.('Couldn’t find that entry in your journal', 'error');
        return;
    }

    const hasDetails = _DETAIL_FIELDS.some(f => String(row[f] ?? '').trim() !== '');
    if (hasDetails) {
        await _dialog({
            title: 'This show has your own details',
            body: 'It includes notes, photos, companions or other details you added, so it can only be removed from your personal journal.',
            confirmLabel: 'OK',
            cancelLabel: null,
        });
        return;
    }

    const ok = await _dialog({
        title: 'Remove from your journal?',
        body: 'You’ll no longer be counted as having been at this show.',
        confirmLabel: 'Remove',
        danger: true,
    });
    if (!ok) return;
    if (await _deleteOwnRow(journalKey)) _markNotMine(journalKey);
}

function _dialog({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[600] bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <div class="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl space-y-4">
                <h3 class="text-lg font-black text-slate-900">${escapeHtml(title)}</h3>
                <p class="text-sm text-slate-600">${escapeHtml(body)}</p>
                <div class="flex gap-2 justify-end">
                    ${cancelLabel ? `<button type="button" data-r="0" class="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-slate-500 hover:bg-slate-100">${escapeHtml(cancelLabel)}</button>` : ''}
                    <button type="button" data-r="1" class="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-white ${danger ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-700'}">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-r]');
            if (btn) done(btn.dataset.r === '1');
            else if (e.target === overlay) done(false);
        });
        document.body.appendChild(overlay);
        overlay.querySelector('button[data-r="1"]').focus();
    });
}

// ─── BULK "MARK SHOWS I WAS AT" ───────────────────────────────────────────────
// Select past shows in the Gigs list (combine with search/filters), then add
// them all to the viewer's journal in one go. Entries are created blank.

function _isEligible(journalKey) {
    const att = window._bandAttendance;
    if (!att?.canTag || att.byKey.get(journalKey)?.mine) return false;
    const src = _journalData.find(g => g['Journal Key'] === journalKey);
    return !!src && _isPastDate(src.Date || src.date);
}

function _isPastDate(dateStr) {
    const [d, m, y] = String(dateStr || '').split('/');
    return y ? new Date(`${y}-${m}-${d}`) <= new Date() : false;
}

function bandBulkStart() {
    if (!window._bandAttendance?.canTag) return;
    window.toggleListView?.('list');     // selection happens in the list
    _bulk.active = true;
    _bulk.selected.clear();
    document.getElementById('band-undo-snackbar')?.remove();
    const entry = document.getElementById('band-bulk-entry');
    if (entry) entry.style.display = 'none';
    _renderBulkBar();
    window.refreshUI?.();
}

function bandBulkCancel() {
    _bulk.active = false;
    _bulk.selected.clear();
    document.getElementById('band-bulk-bar')?.remove();
    const entry = document.getElementById('band-bulk-entry');
    if (entry && window._bandAttendance?.canTag) entry.style.display = 'flex';
    window.refreshUI?.();
}

function _renderBulkBar() {
    document.getElementById('band-bulk-bar')?.remove();
    const bar = document.createElement('div');
    bar.id = 'band-bulk-bar';
    bar.className = 'fixed left-3 right-3 bottom-24 z-[70] max-w-md mx-auto bg-slate-800 text-white rounded-2xl shadow-xl px-4 py-3 space-y-2';
    bar.innerHTML = `
        <div class="flex items-center justify-between gap-3">
            <span id="band-bulk-count" class="text-sm font-black">0 selected</span>
            <button type="button" data-act="all" class="text-[10px] font-black uppercase tracking-wider text-[#7dd3fc]">Select all shown</button>
        </div>
        <div class="flex gap-2">
            <button type="button" data-act="cancel" class="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-white/10 hover:bg-white/20">Cancel</button>
            <button type="button" data-act="add" id="band-bulk-add" class="flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-wider bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40" disabled>Add to my journal</button>
        </div>`;
    bar.addEventListener('click', (e) => {
        const act = e.target.closest('button[data-act]')?.dataset.act;
        if (act === 'cancel') bandBulkCancel();
        if (act === 'all')    _bulkSelectAllShown();
        if (act === 'add')    bandBulkCommit();
    });
    document.body.appendChild(bar);
    _updateBulkBar();
}

function _updateBulkBar() {
    const n = _bulk.selected.size;
    const count = document.getElementById('band-bulk-count');
    const add   = document.getElementById('band-bulk-add');
    if (count) count.textContent = `${n} selected`;
    if (add)   add.disabled = n === 0;
}

function _paintRowSelected(row, selected) {
    row.classList.toggle('bg-indigo-100/70', selected);
    const check = row.querySelector('[data-band-check]');
    if (!check) return;
    check.classList.toggle('text-indigo-700', selected);
    check.classList.toggle('text-slate-500', !selected);
    const box = check.firstElementChild;
    if (!box) return;
    box.classList.toggle('bg-indigo-600', selected);
    box.classList.toggle('border-indigo-600', selected);
    box.classList.toggle('text-white', selected);
    box.classList.toggle('border-slate-300', !selected);
    box.classList.toggle('text-transparent', !selected);
}

function _bulkToggleRow(row) {
    const key = row.dataset.viewGigKey;
    if (!_isEligible(key)) return;
    const selected = !_bulk.selected.has(key);
    if (selected) _bulk.selected.add(key); else _bulk.selected.delete(key);
    _paintRowSelected(row, selected);
    _updateBulkBar();
}

function _bulkSelectAllShown() {
    const shown = window._lastRenderedGigs || [];
    shown.forEach(g => { if (_isEligible(g['Journal Key'])) _bulk.selected.add(g['Journal Key']); });
    _updateBulkBar();
    window.refreshUI?.();      // repaint the checkboxes
}

async function bandBulkCommit() {
    const me  = _currentUser?.id;
    const att = window._bandAttendance;
    const keys = [..._bulk.selected];
    if (!me || !att || !keys.length) return;

    if (keys.length > 25) {
        const ok = await _dialog({
            title: `Add ${keys.length} shows?`,
            body: 'They’ll be added to your personal journal with no details, and you can fill them in later.',
            confirmLabel: 'Add them',
        });
        if (!ok) return;
    }

    const addBtn = document.getElementById('band-bulk-add');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding…'; }

    const created = new Set();
    try {
        for (let i = 0; i < keys.length; i += 100) {
            const rows = keys.slice(i, i + 100)
                .map(k => _journalData.find(g => g['Journal Key'] === k))
                .filter(Boolean)
                .map(src => _buildJournalRow(src, me));
            const { data, error } = await supabase
                .from('journals')
                .upsert(rows, { onConflict: 'user_id,journal_key', ignoreDuplicates: true })
                .select('journal_key');
            if (error) throw error;
            (data || []).forEach(r => created.add(r.journal_key));
        }
    } catch (err) {
        console.error('band.js: bulk add failed', err);
        window.showToast?.(`Stopped part-way: ${err.message}`, 'error', 6000);
    }

    keys.forEach(k => {
        if (!created.has(k)) return;
        const info = att.byKey.get(k) || { count: 0, buddyIds: [], mine: false };
        info.mine = true;
        info.count += 1;
        att.byKey.set(k, info);
    });

    const skipped = keys.length - created.size;
    if (created.size) {
        window.showToast?.(
            `Added ${created.size} show${created.size === 1 ? '' : 's'} to your journal` +
            (skipped > 0 ? ` (${skipped} already there or skipped)` : ''),
            'success', 5000);
    }
    bandBulkCancel();
    _loadBandStats().catch(() => {});
    _loadBandAttendance().catch(() => {});   // re-sync with the server (also picks up pre-existing rows)
}

function _showUndoSnackbar(journalKey) {
    document.getElementById('band-undo-snackbar')?.remove();
    const el = document.createElement('div');
    el.id = 'band-undo-snackbar';
    el.setAttribute('role', 'status');
    el.className = 'fixed left-1/2 -translate-x-1/2 bottom-28 z-[60] flex items-center gap-4 bg-slate-800 text-white text-sm font-bold rounded-2xl px-5 py-3 shadow-xl';
    el.innerHTML = `<span>Added to your journal</span>
        <button type="button" class="text-[#7dd3fc] font-black uppercase text-xs tracking-wider">Undo</button>`;
    el.querySelector('button').addEventListener('click', () => {
        el.remove();
        bandUndoTag(journalKey);
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 10000);
}

// ─── SHOWS TAB ────────────────────────────────────────────────────────────────

// ─── LAZY PERFORMANCE LOADER ──────────────────────────────────────────────────
// Performances are not needed for first paint, so initBandMode loads them in
// the background after the Gigs tab renders. They power the Songs tile, song
// search and the Top Songs chart. Chunked IN queries (see data.js).

async function _loadPerformancesIfNeeded() {
    if (_performancesLoaded) return;
    _performancesLoaded = true;

    const keys = _journalData.map(g => g['Journal Key']).filter(Boolean);
    if (!keys.length) return;

    try {
        _performanceData = await loadPerformances(keys, window.allVenues || {});
        // Also sync to window so the gig modal and search can read it
        window.performanceData = _performanceData;
    } catch (err) {
        console.warn('band.js: performances load failed', err);
        _performancesLoaded = false; // allow a retry on the next call
    }
}

// ─── SUMMARY TAB ──────────────────────────────────────────────────────────────

function _renderBandStory() {
    _renderSummaryNarrative();
    _renderStoryStats();
}

function _renderSummaryNarrative() {
    const container = document.getElementById('band-summary-narrative');
    if (!container) return;

    const data     = _journalData;
    const bandName = window.currentArtist || 'This band';

    if (!data.length) {
        container.innerHTML = '';
        return;
    }

    const userLoggedShows = data.filter(g => g.user_id && g.user_id !== 'null');
    const totalShows      = data.length;

    const venues     = new Set(data.filter(g => g.venue_id || g.OfficialVenue || g.Venue).map(_vkey));
    const venueCount = venues.size;

    const dates     = data.map(g => parseDate(g.Date)).filter(Boolean).sort((a, b) => a - b);
    const fmtDate   = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
    const firstDate = fmtDate(dates[0]);
    const lastDate  = fmtDate(dates[dates.length - 1]);

    // Use module-level _fanCount directly
    const fanCount = _fanCount;

    const plural      = totalShows !== 1;
    const venuePhrase = venueCount > 1 ? `, across ${venueCount} venues` : '';
    const fanPhrase   = fanCount   ? ` by ${fanCount} GigList fan${fanCount !== 1 ? 's' : ''}` : '';
    const firstPhrase = firstDate  ? ` First logged show: ${firstDate}.` : '';
    const lastPhrase  = lastDate && lastDate !== firstDate ? ` Most recent: ${lastDate}.` : '';

    const attendedCount = _fanAttendance ?? userLoggedShows.length;
    const sentence = `${bandName} ${plural ? 'have' : 'has'} ${totalShows} show${plural ? 's' : ''} archived on GigList${venuePhrase}. ${attendedCount} ${attendedCount === 1 ? 'has' : 'have'} been attended${fanPhrase}.${firstPhrase}${lastPhrase}`;

    container.innerHTML = `<p class="text-sm font-bold text-slate-600 leading-relaxed">${escapeHtml(sentence)}</p>`;
}

function _renderStoryStats() {
    const container = document.getElementById('band-story-stats');
    if (!container) return;

    const data = _journalData;
    if (!data.length) {
        container.innerHTML = `<p class="col-span-2 text-sm text-slate-400 text-center py-8">No data yet.</p>`;
        return;
    }

    // Use module-level _fanCount directly
    const fanCount = _fanCount;

    const years = data.map(g => {
        const parts = (g.Date || '').split('/');
        return parts.length === 3 ? parseInt(parts[2], 10) : null;
    }).filter(Boolean);

    const minYear    = Math.min(...years);
    const maxYear    = Math.max(...years);
    const yearsSpan  = maxYear - minYear;
    const yearsLabel = minYear === maxYear ? `${minYear}` : `${minYear} – ${maxYear}`;

    const yearCounts = {};
    years.forEach(y => { yearCounts[y] = (yearCounts[y] || 0) + 1; });
    const peakYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0];

    const venueCounts = {};
    data.forEach(g => {
        if (!(g.venue_id || g.OfficialVenue || g.Venue)) return;
        const k = _vkey(g);
        (venueCounts[k] = venueCounts[k] || { n: 0, gig: g }).n++;
    });
    const topEntry = Object.values(venueCounts).sort((a, b) => b.n - a.n)[0];
    const topVenue = topEntry
        ? [[topEntry.gig.OfficialVenue || topEntry.gig.Venue,
            window.resolveVenue?.(topEntry.gig)?.city].filter(c => c && c !== 'Unknown City').join(', '), topEntry.n]
        : null;

    const countries = new Set(data.map(g => (g.Country || '').trim()).filter(Boolean));

    const cards = [
        {
            label: 'Shows Archived',
            value: data.length,
            sub:  'in the Band Page archive',
        },
        {
            label: 'Fan Attendance',
            value: _fanAttendance ?? '--',
            sub:   _fanAttendance != null ? `show${_fanAttendance !== 1 ? 's' : ''} attended by fans` : 'loading…',
        },
        {
            label: 'GigList Reach',
            value: (_fanAttendance != null && data.length > 0)
                       ? _formatReach(_fanAttendance / data.length)
                       : '--',
            sub:   (_fanAttendance != null && data.length > 0)
                       ? 'of archived shows attended'
                       : 'loading…',
        },
        {
            label: 'GigList Fans',
            value: fanCount ?? '--',
            sub:   fanCount != null ? `fan${fanCount !== 1 ? 's' : ''} logged shows` : 'loading…',
        },
        {
            label: 'Active Since',
            value: yearsLabel,
            sub:   yearsSpan > 0 ? `${yearsSpan} year${yearsSpan !== 1 ? 's' : ''} of history` : 'First year on record',
        },
        {
            label: 'Peak Year',
            value: peakYear ? peakYear[0] : '--',
            sub:   peakYear ? `${peakYear[1]} show${peakYear[1] !== 1 ? 's' : ''}` : '',
        },
        {
            label: 'Top Venue',
            value: topVenue ? topVenue[1] : '--',
            sub:   topVenue ? _truncate(topVenue[0], 26) : '',
        },
        {
            label: 'Countries',
            value: countries.size || '--',
            sub:   countries.size ? 'played in' : '',
        },
    ];

    container.innerHTML = cards.map(c => `
        <div class="bg-white p-4 rounded-[1.5rem] border border-slate-100 shadow-sm text-center">
            <p class="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1">${escapeHtml(c.label)}</p>
            <p class="text-xl font-black text-indigo-700 leading-none">${escapeHtml(c.value)}</p>
            ${c.sub ? `<p class="text-[9px] text-slate-400 font-bold mt-1 leading-snug">${escapeHtml(c.sub)}</p>` : ''}
        </div>`).join('');
}

// ─── RLS NOTE — band mode queries ────────────────────────────────────────────
// Direct Supabase queries from the browser run as the authenticated user and
// are subject to RLS. The journals and profiles tables have user-scoped RLS
// policies, so a plain .from('journals') in band mode only returns rows the
// current viewer is permitted to see — not all fans of the band.
//
// Any band mode query that needs a cross-user view (fan lists, attendance
// counts, profile lookups by id) MUST go through a SECURITY DEFINER RPC
// function in Supabase, which runs as the function owner and bypasses RLS.
//
// Current RPCs:
//   get_band_fans(band_name)       → journals rows for a band, all users
//   get_profiles_by_ids(user_ids)  → public profile fields for an id array
//
// Do NOT replace these with direct table queries, even if they look simpler.
// ─────────────────────────────────────────────────────────────────────────────

// ─── FANS TAB ─────────────────────────────────────────────────────────────────

async function _renderBandFans() {
    const container = document.getElementById('band-fans-list');
    if (!container) return;

    const loadingEl = document.getElementById('band-fans-loading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
        const bandName = window.currentArtist;

        // Fetch all journal rows for this band that have a real user_id.
        // Rows with null user_id are band-archive imports (setlist.fm), not user accounts.
        const { data: fanRows, error: fanErr } = await supabase
            .rpc('get_band_fans', { band_name: bandName });

        if (fanErr) throw fanErr;
        if (!fanRows || !fanRows.length) {
            _renderFansEmpty(container);
            return;
        }

        // Aggregate show counts + earliest show per user
        const countMap     = {};
        const firstShowMap = {};

        fanRows.forEach(r => {
            if (!r.user_id || r.user_id === 'null') return;
            countMap[r.user_id] = (countMap[r.user_id] || 0) + 1;
            const d = parseDate(r.date);
            if (d && (!firstShowMap[r.user_id] || d < firstShowMap[r.user_id])) {
                firstShowMap[r.user_id] = d;
            }
        });

        const userIds = Object.keys(countMap);
        if (!userIds.length) {
            _renderFansEmpty(container);
            return;
        }

        // Fetch profiles.
        // Username is not a private fact — users are findable by username to send buddy
        // requests — so profiles should be publicly readable. If RLS is restricting rows,
        // the console log below will show the mismatch so it can be diagnosed in Supabase.
        const { data: profileRows, error: profileErr } = await supabase
            .rpc('get_profiles_by_ids', { user_ids: userIds });

        if (profileErr) {
            console.error('band.js: profiles query error', profileErr);
        }

        console.log(
            `band.js fans: ${userIds.length} user IDs from journals, ` +
            `${(profileRows || []).length} profiles returned by query. ` +
            `Missing: ${userIds.length - (profileRows || []).length}`
        );

        // Build a lookup of whatever came back
        const profileMap = {};
        (profileRows || []).forEach(p => { profileMap[p.id] = p; });

        // Ensure buddy status is ready before building CTAs
        if (_currentUser?.isAuthUser) {
            await _loadBuddyStatus();
        }

        // Build fan list. Any uid whose profile was RLS-filtered gets a stub entry
        // so they still appear as a tile rather than being silently dropped.
        const fans = userIds.map(uid => {
            const p = profileMap[uid] || { id: uid, display_name: null, username: null, avatar_url: null };
            return {
                ...p,
                showCount: countMap[uid] || 0,
                firstShow: firstShowMap[uid] || null,
            };
        });

        // Sort: buddies first, then show count desc, then earliest fan on tie
        fans.sort((a, b) => {
            const aIsBuddy = _buddyStatus[a.id] === 'accepted' ? 0 : 1;
            const bIsBuddy = _buddyStatus[b.id] === 'accepted' ? 0 : 1;
            if (aIsBuddy !== bIsBuddy) return aIsBuddy - bIsBuddy;
            if (b.showCount !== a.showCount) return b.showCount - a.showCount;
            if (a.firstShow && b.firstShow) return a.firstShow - b.firstShow;
            return 0;
        });

        if (loadingEl) loadingEl.classList.add('hidden');
        container.innerHTML = fans.map(fan => _fanTileHTML(fan)).join('');
        _wireBandFansClicks(container);

        if (window.lucide) lucide.createIcons();

    } catch (err) {
        console.error('band.js: _renderBandFans error', err);
        if (loadingEl) loadingEl.classList.add('hidden');
        container.innerHTML = `
            <div class="text-center py-10 text-slate-400">
                <p class="text-sm font-bold">Couldn't load fans — try refreshing.</p>
            </div>`;
    }
}

function _fanTileHTML(fan) {
    const viewerId    = _currentUser?.id;
    const isViewer    = fan.id === viewerId;
    // display_name/username may be null if the profile row was RLS-filtered
    const displayName = fan.display_name || fan.username || null;
    const label       = displayName || 'GigList Fan';
    const initials    = displayName ? displayName.slice(0, 2).toUpperCase() : '♪';

    const avatarSrc  = safeUrl(fan.avatar_url);
    const avatarHTML = avatarSrc
        ? `<img src="${escapeHtml(avatarSrc)}" alt="" class="w-12 h-12 rounded-full object-cover ring-2 ring-white flex-shrink-0">`
        : `<div class="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-black flex-shrink-0">${escapeHtml(initials)}</div>`;

    const firstShowYear  = fan.firstShow ? fan.firstShow.getFullYear() : null;
    const firstShowLabel = firstShowYear ? `Fan since ${firstShowYear}` : '';

    const ctaHTML = _buddyCTA(fan.id, isViewer, label);

    return `
        <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 flex items-center gap-4">
            ${avatarHTML}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-slate-900 truncate">${escapeHtml(label)}</p>
                <p class="text-[10px] font-bold text-slate-400 mt-0.5">
                    ${fan.showCount} show${fan.showCount !== 1 ? 's' : ''}
                    ${firstShowLabel ? ` · ${firstShowLabel}` : ''}
                </p>
            </div>
            <div class="flex-shrink-0">${ctaHTML}</div>
        </div>`;
}

function _buddyCTA(userId, isViewer, displayName) {
    if (isViewer) {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">You</span>`;
    }

    if (!_currentUser?.isAuthUser) {
        return `<a href="index.html"
                   class="text-[9px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700 transition-colors">
                    Sign in
                </a>`;
    }

    const status = _buddyStatus[userId];

    if (status === 'accepted') {
        return `<span class="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-600">
                    <i data-lucide="check" class="w-3 h-3"></i> Buddies
                </span>`;
    }

    if (status === 'pending') {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Requested</span>`;
    }

    // No relationship — show Connect button. Opened via the delegated
    // listener (_wireBandFansClicks) — display_name is user-controlled, so it
    // must not be interpolated into an inline onclick.
    return `<button
                data-band-buddy-id="${escapeHtml(userId)}" data-band-buddy-name="${escapeHtml(displayName)}"
                class="text-[9px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 active:scale-95 transition-all px-3 py-1.5 rounded-full">
                Connect
            </button>`;
}

function _wireBandFansClicks(container) {
    if (!container || container._bandFansClickWired) return;
    container._bandFansClickWired = true;
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-band-buddy-id]');
        if (btn && container.contains(btn)) {
            window._sendBandBuddyRequest(btn.dataset.bandBuddyId, btn.dataset.bandBuddyName, btn);
        }
    });
}

function _renderFansEmpty(container) {
    const loadingEl = document.getElementById('band-fans-loading');
    if (loadingEl) loadingEl.classList.add('hidden');

    const isAuthed = _currentUser?.isAuthUser;
    container.innerHTML = `
        <div class="text-center py-16 space-y-3">
            <p class="text-4xl">🎸</p>
            <p class="text-sm font-black text-slate-700">No GigList fans yet</p>
            <p class="text-[11px] text-slate-400">Be the first to log a show!</p>
            ${!isAuthed ? `<a href="index.html"
                              class="inline-block mt-2 text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 px-5 py-2.5 rounded-full transition-all">
                                Sign In / Sign Up
                            </a>` : ''}
        </div>`;
}

// ─── BUDDY REQUEST (band mode) ────────────────────────────────────────────────

window._sendBandBuddyRequest = async (addresseeId, displayName, btn) => {
    if (!_currentUser?.isAuthUser) return;

    const requesterId = _currentUser.id;
    if (requesterId === addresseeId) return;

    btn.disabled    = true;
    btn.textContent = '...';

    try {
        const { error } = await supabase
            .from('buddies')
            .insert({ requester_id: requesterId, addressee_id: addresseeId, status: 'pending' });

        if (error) throw error;

        _buddyStatus[addresseeId] = 'pending';
        btn.outerHTML = `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Requested</span>`;

        window.showToast?.(`Buddy request sent to ${displayName}!`, 'success');
    } catch (err) {
        console.error('band.js: buddy request failed', err);
        btn.disabled    = false;
        btn.textContent = 'Connect';
        window.showToast?.('Request failed — try again', 'error');
    }
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function _loadBandStats() {
    const bandName = window.currentArtist;
    if (!bandName) return;

    const { data: rows } = await supabase
        .rpc('get_band_fans', { band_name: bandName });

    if (!rows) return;

    const fanIds       = new Set(rows.map(r => r.user_id).filter(id => id && id !== 'null'));
    _fanCount          = fanIds.size;
    _fanAttendance     = rows.filter(r => r.user_id && r.user_id !== 'null').length;

    const rankEl  = document.getElementById('stat-rank');
    const labelEl = document.getElementById('stat-fourth-label');
        // Animate in the fan count now we have it
        if (rankEl) {
            const { animateStatTo } = await import('./ui.js');
            animateStatTo(rankEl, _fanCount);
        }
        if (labelEl) labelEl.textContent = 'Fans';

    _renderBandStory();
}

async function _loadBuddyStatus() {
    const id = _currentUser?.id;
    if (!id || id === 'null' || id === 'undefined') return;

    const { data: rows } = await supabase
        .from('buddies')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${id},addressee_id.eq.${id}`);

    _buddyStatus = {};
    (rows || []).forEach(b => {
        const otherId = b.requester_id === id ? b.addressee_id : b.requester_id;
        _buddyStatus[otherId] = b.status;
    });
}

// Venue identity for grouping/counting: venue_id when linked, name otherwise (data.js)
const _vkey = (g) => (window.venueKey ? window.venueKey(g) : (g.OfficialVenue || g.Venue || ''));

// 0.3% not "0%": tiny shares round to one decimal, larger ones to whole numbers.
function _formatReach(ratio) {
    const pct = ratio * 100;
    if (pct <= 0) return '0%';
    if (pct < 1)  return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
}

function _truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}
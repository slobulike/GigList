/**
 * GigList — community-feed.js
 * Community > Feed pane (v2, visual).
 *
 * The feed itself is anonymous: the get_community_feed() RPC (v1, unchanged)
 * returns aggregates only, and get_community_artist_media() returns shared
 * artist facts (image + Spotify artist id) from the `artists` table.
 *
 * ONE exception: the Spotlight hero can show fan photos. Those come from
 * get_community_artist_photos(), which returns ONLY photos from users whose
 * profile is public (is_public = true), plus that user's display name and
 * avatar. Nothing from private profiles ever reaches this pane.
 *
 * What's new in v2:
 *   - Spotlight: a daily-rotating hero card (seeded by day, so it changes
 *     every visit-day) with a Spotify artist player that loads ON DEMAND
 *     (one iframe at a time, never on page load) and a "Watch live" link.
 *   - Tap any artist anywhere in the feed to swap them into the Spotlight
 *     (the page does not scroll; only the hero changes).
 *   - The Spotlight hero is swipable: slide 1 is the artist image, then up to
 *     8 fan photos from public profiles, each captioned with its own show
 *     (venue + date) and the fan's avatar. Photos load lazily per artist.
 *   - Hot list as a swipeable rail of artist-image tiles.
 *   - Trending as image rows with proportional fan bars.
 *   - Busy venues as gradient tiles; On this day as poster tiles.
 *
 * Image chain per artist: Spotify image (artists.spotify_image_url)
 *   -> local assets/artists/<band>_stock_photo.jpg
 *   -> gradient + initials (always rendered underneath, so a miss never
 *      leaves a hole).
 *
 * Pane contract (see community.js):
 *   - renders only into the host element it is given
 *   - returns a disposer (aborts in-flight requests, blocks late renders,
 *     removes listeners)
 *   - fetches via SECURITY DEFINER RPCs; caches are module-scoped, not window.*
 *   - never touches personal stores (journalData, _following, ...)
 */

import { supabase } from './supabase.js';
import { escapeHtml, safeUrl } from './utils.js';
import { registerCommunityPane } from './community.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_NAMES = 50;                 // matches the cap inside the RPC
const PHOTO_URL_TTL_S = 15 * 60;            // signed URL lifetime for fan photos
const PHOTO_CACHE_MS = 10 * 60 * 1000;      // refetch well before those URLs expire
const CARD = 'bg-white rounded-[2rem] border border-slate-100 shadow-sm p-5';
const EYEBROW = 'text-[10px] font-black text-slate-400 uppercase tracking-widest';
const H3 = 'text-xl font-black italic uppercase tracking-tighter text-slate-900 mb-3';
const RAIL = 'flex gap-3 overflow-x-auto snap-x snap-mandatory -mx-5 px-5 pb-1 ' +
             '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

// Literal class strings so Tailwind's scanner picks them up.
const GRADIENTS = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-rose-500 to-orange-500',
    'from-sky-500 to-indigo-600',
    'from-fuchsia-500 to-purple-600',
    'from-amber-500 to-red-500',
];

// Community-only caches. Module scope on purpose: not window.* data globals.
let _cache = null;                 // { at: number, data: object }
const _media = new Map();          // lowercase band -> { image_url, spotify_artist_id }
const _mediaAsked = new Set();     // lowercase bands already requested (hit or miss)
const _photos = new Map();         // lowercase band -> { at: number, list: Array } (fan photos)

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const _key = (s) => String(s ?? '').trim().toLowerCase();
const _plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Safe for text AND quoted attributes, whatever escapeHtml does with quotes.
const _attr = (s) => escapeHtml(String(s ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function _recency(days) {
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7)  return 'this week';
    if (days < 14) return 'last week';
    if (days < 31) return 'this month';
    return 'a while ago';
}

function _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

const _grad = (name) => GRADIENTS[_hash(_key(name)) % GRADIENTS.length];

function _initials(name) {
    const parts = String(name ?? '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '♪';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Same convention the personal feed uses for local stock artist photos.
const _localArt = (band) => `assets/artists/${String(band ?? '').toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;

const _spotifyId = (band) => {
    const id = _media.get(_key(band))?.spotify_artist_id;
    return /^[A-Za-z0-9]{22}$/.test(id || '') ? id : null;
};

// Changes once a day, so the Spotlight rotates without being random per load.
const _dayNumber = () => Math.floor(Date.now() / 86400000);

function _uniqueBands(data) {
    const seen = new Set();
    const out = [];
    for (const list of [data.trending, data.hot, data.on_this_day]) {
        for (const r of list || []) {
            const k = _key(r.band);
            if (k && !seen.has(k)) { seen.add(k); out.push(r.band); }
        }
    }
    return out;
}

function _reason(band, data) {
    const k = _key(band);
    const t = (data.trending || []).find(r => _key(r.band) === k);
    if (t) return `${_plural(t.people, 'fan', 'fans')} in the last 30 days`;
    const h = (data.hot || []).find(r => _key(r.band) === k);
    if (h) return `Seen ${_recency(h.days_ago)}`;
    const o = (data.on_this_day || []).find(r => _key(r.band) === k);
    if (o) return `Seen ${_plural(new Date().getFullYear() - o.year, 'year', 'years')} ago today`;
    return 'On GigList';
}

function _pickSpotlight(data) {
    const pool = _uniqueBands(data);
    if (!pool.length) return null;
    const playable = pool.filter(b => _spotifyId(b));
    const from = playable.length ? playable : pool;
    return from[_dayNumber() % from.length];
}

// ─── FAN PHOTOS (hero slides) ────────────────────────────────────────────────

// Caption for one fan photo: the show it belongs to, never a relative "this week".
function _photoCaption(p) {
    const d = p.show_date ? new Date(`${p.show_date}T00:00:00`) : null;
    const when = d && !isNaN(d)
        ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
    return [p.venue, when].filter(Boolean).join(' · ');
}

// Slide 0 is the artist artwork; slides 1..n are fan photos.
function _slideMeta(band, data, photos, i) {
    const p = i > 0 ? photos[i - 1] : null;
    return p
        ? { eyebrow: 'Fan photo', line: _photoCaption(p) }
        : { eyebrow: 'Spotlight', line: _reason(band, data) };
}

// Update the fixed overlay text + dots in place (no repaint, so no flicker).
function _applySlide(host, band, data, photos, i) {
    const m = _slideMeta(band, data, photos, i);
    const eb = host.querySelector('[data-cf-eyebrow]');
    const ln = host.querySelector('[data-cf-line]');
    if (eb) eb.textContent = m.eyebrow;
    if (ln) ln.textContent = m.line;
    host.querySelectorAll('[data-cf-dot]').forEach((d, n) => {
        d.classList.toggle('bg-white', n === i);
        d.classList.toggle('bg-white/40', n !== i);
    });
}

function _cachedPhotos(band) {
    const hit = _photos.get(_key(band));
    return hit && Date.now() - hit.at < PHOTO_CACHE_MS ? hit.list : [];
}

// ─── ARTWORK ──────────────────────────────────────────────────────────────────

/**
 * Gradient + initials sit underneath; the <img> sits on top. If the image
 * errors, the delegated capture listener in renderFeedPane steps remote -> local
 * -> removed, revealing the initials. `cls` must supply positioning
 * ("relative", "absolute inset-0", ...) and size.
 */
function _art(band, cls = '') {
    const remote = safeUrl(_media.get(_key(band))?.image_url || '');
    const src = remote || _localArt(band);
    return `
        <div class="overflow-hidden bg-gradient-to-br ${_grad(band)} ${cls}">
            <span class="absolute inset-0 flex items-center justify-center text-2xl font-black italic text-white/80" aria-hidden="true">${escapeHtml(_initials(band))}</span>
            <img src="${_attr(src)}" alt="" loading="lazy" decoding="async"
                 data-cf-img data-stage="${remote ? 'remote' : 'local'}" data-band="${_attr(band)}"
                 class="absolute inset-0 w-full h-full object-cover">
        </div>`;
}

// ─── SPOTLIGHT ────────────────────────────────────────────────────────────────

function _spotlightSection(band, data, playing, photos = [], slide = 0) {
    if (!band) return '<div data-cf-spotlight></div>';
    const sid = _spotifyId(band);
    const q = encodeURIComponent(band);
    const btn = 'inline-flex items-center gap-2 min-h-[44px] px-5 rounded-full text-[11px] font-black uppercase tracking-widest transition-all active:scale-95';

    const player = (playing && sid) ? `
        <div class="px-4 pb-4">
            <iframe title="${_attr(`Spotify player for ${band}`)}"
                    src="https://open.spotify.com/embed/artist/${sid}?utm_source=generator&theme=0"
                    width="100%" height="152" frameborder="0" loading="lazy"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    class="rounded-2xl block"></iframe>
        </div>` : '';

    const playBtn = sid
        ? (playing
            ? `<button type="button" data-cf-stop class="${btn} bg-white/10 text-white">
                   <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i> Close player
               </button>`
            : `<button type="button" data-cf-play class="${btn} bg-white text-slate-900">
                   <i data-lucide="play" class="w-4 h-4" aria-hidden="true"></i> Listen
               </button>`)
        : `<a href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener noreferrer" class="${btn} bg-white text-slate-900">
               <i data-lucide="music" class="w-4 h-4" aria-hidden="true"></i> Find on Spotify
           </a>`;

    // Hero rail: artwork first, then one slide per fan photo.
    const total = photos.length + 1;
    const at = Math.min(Math.max(slide, 0), photos.length);
    const meta = _slideMeta(band, data, photos, at);

    const photoSlides = photos.map((p, i) => {
        const name = String(p.display_name || 'A fan');
        const av = safeUrl(p.avatar_url || '');
        const photoUrl = safeUrl(p.url || '');
        if (!photoUrl) return '';
        return `
            <div class="relative shrink-0 w-full h-full snap-center overflow-hidden bg-gradient-to-br ${_grad(band)}"
                 role="group" aria-roledescription="slide" aria-label="${_attr(`Fan photo ${i + 1} of ${photos.length}`)}">
                <img src="${_attr(photoUrl)}" alt="${_attr(`${band} at ${p.venue || 'a show'}, photo by ${name}`)}"
                     loading="lazy" decoding="async" data-cf-photo
                     class="absolute inset-0 w-full h-full object-cover">
                <div class="absolute top-4 left-4 flex items-center gap-2 max-w-[70%] bg-slate-900/60 backdrop-blur-sm rounded-full pl-1 pr-3 py-1">
                    <span class="relative shrink-0 w-7 h-7 rounded-full overflow-hidden bg-indigo-500 flex items-center justify-center text-[10px] font-black text-white">
                        ${escapeHtml(_initials(name))}
                        ${av ? `<img src="${_attr(av)}" alt="" data-cf-avatar class="absolute inset-0 w-full h-full object-cover">` : ''}
                    </span>
                    <span class="text-[11px] font-bold text-white truncate">${escapeHtml(name)}</span>
                </div>
            </div>`;
    }).join('');

    const swipable = photos.length > 0;
    const railAttrs = swipable
        ? `tabindex="0" role="region" aria-roledescription="carousel" aria-label="${_attr(`${band}: artist image and fan photos`)}"`
        : '';
    const dots = swipable ? `
                <div class="absolute top-4 right-4 flex gap-1.5 pointer-events-none" aria-hidden="true">
                    ${Array.from({ length: total }, (_, i) =>
                        `<span data-cf-dot class="block w-1.5 h-1.5 rounded-full ${i === at ? 'bg-white' : 'bg-white/40'}"></span>`).join('')}
                </div>` : '';

    return `
    <div data-cf-spotlight>
        <section class="overflow-hidden rounded-[2rem] bg-slate-900 shadow-sm" aria-labelledby="cf-spot">
            <div class="relative h-72">
                <div data-cf-hero ${railAttrs}
                     class="absolute inset-0 flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <div class="relative shrink-0 w-full h-full snap-center">
                        ${_art(band, 'absolute inset-0')}
                    </div>
                    ${photoSlides}
                </div>
                <div class="absolute inset-0 pointer-events-none bg-gradient-to-t from-slate-900 via-slate-900/50 to-transparent"></div>
                <div class="absolute inset-x-0 bottom-0 p-5 pointer-events-none">
                    <p data-cf-eyebrow class="text-[10px] font-black uppercase tracking-widest text-white/70">${escapeHtml(meta.eyebrow)}</p>
                    <h3 id="cf-spot" class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mt-1">${escapeHtml(band)}</h3>
                    <p data-cf-line aria-live="polite" class="text-sm font-bold text-white/80 mt-2 line-clamp-2">${escapeHtml(meta.line)}</p>
                </div>${dots}
            </div>
            <div class="p-4 flex flex-wrap gap-2">
                ${playBtn}
                <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(band + ' live')}"
                   target="_blank" rel="noopener noreferrer" class="${btn} bg-white/10 text-white">
                    <i data-lucide="video" class="w-4 h-4" aria-hidden="true"></i> Watch live
                </a>
            </div>
            ${player}
        </section>
    </div>`;
}

// ─── CARDS ────────────────────────────────────────────────────────────────────

function _hotCard(rows) {
    if (!rows?.length) return '';
    return `
        <section class="${CARD}" aria-labelledby="cf-hot">
            <p class="${EYEBROW}">Hot list</p>
            <h3 id="cf-hot" class="${H3}">Just seen on GigList</h3>
            <div class="${RAIL}">
                ${rows.map(r => `
                <button type="button" data-cf-artist="${_attr(r.band)}" aria-label="${_attr(`Open ${r.band} in the spotlight`)}"
                        class="relative shrink-0 snap-start w-32 h-44 rounded-3xl overflow-hidden text-left active:scale-[0.97] transition-transform">
                    ${_art(r.band, 'absolute inset-0')}
                    <div class="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/20 to-transparent"></div>
                    <span class="absolute top-2 left-2 bg-white/90 text-slate-700 text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full">${escapeHtml(_recency(r.days_ago))}</span>
                    <span class="absolute inset-x-0 bottom-0 p-3 text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(r.band)}</span>
                </button>`).join('')}
            </div>
        </section>`;
}

function _trendingCard(rows) {
    if (!rows?.length) return '';
    const max = Math.max(...rows.map(r => r.people), 1);
    return `
        <section class="${CARD}" aria-labelledby="cf-trending">
            <p class="${EYEBROW}">Last 30 days</p>
            <h3 id="cf-trending" class="${H3}">Trending bands</h3>
            <ul class="space-y-3">
                ${rows.map(r => `
                <li>
                    <button type="button" data-cf-artist="${_attr(r.band)}" aria-label="${_attr(`Open ${r.band} in the spotlight`)}"
                            class="w-full flex items-center gap-3 text-left active:scale-[0.99] transition-transform">
                        ${_art(r.band, 'relative shrink-0 w-14 h-14 rounded-2xl')}
                        <span class="flex-1 min-w-0">
                            <span class="block text-sm font-bold text-slate-800 truncate">${escapeHtml(r.band)}</span>
                            <span class="block mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
                                <span class="block h-full rounded-full bg-indigo-500" style="width:${Math.max(8, Math.round((r.people / max) * 100))}%"></span>
                            </span>
                        </span>
                        <span class="bg-indigo-50 text-indigo-600 text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                            ${escapeHtml(_plural(r.people, 'fan', 'fans'))}
                        </span>
                    </button>
                </li>`).join('')}
            </ul>
        </section>`;
}

function _venuesAheadCard(rows) {
    if (!rows?.length) return '';
    return `
        <section class="${CARD}" aria-labelledby="cf-venues">
            <p class="${EYEBROW}">Next 30 days</p>
            <h3 id="cf-venues" class="${H3}">Busy venues ahead</h3>
            <div class="${RAIL}">
                ${rows.map(r => `
                <button type="button" data-cf-venue aria-label="${_attr(`${r.venue}, ${_plural(r.people, 'person', 'people')} going. Open Gigs`)}"
                        class="relative shrink-0 snap-start w-44 h-32 rounded-3xl overflow-hidden text-left bg-gradient-to-br ${_grad(r.venue)} active:scale-[0.97] transition-transform">
                    <i data-lucide="map-pin" class="absolute top-3 right-3 w-5 h-5 text-white/70" aria-hidden="true"></i>
                    <span class="absolute inset-x-0 bottom-0 p-3">
                        <span class="block text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(r.venue)}</span>
                        <span class="inline-block mt-1.5 bg-white/90 text-slate-800 text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full">
                            ${escapeHtml(_plural(r.people, 'person', 'people'))} going
                        </span>
                    </span>
                </button>`).join('')}
            </div>
        </section>`;
}

function _onThisDayCard(rows) {
    if (!rows?.length) return '';
    const thisYear = new Date().getFullYear();
    return `
        <section class="${CARD}" aria-labelledby="cf-otd">
            <p class="${EYEBROW}">On this day</p>
            <h3 id="cf-otd" class="${H3}">Community throwbacks</h3>
            <div class="${RAIL}">
                ${rows.map(r => {
                    const ago = thisYear - r.year;
                    return `
                <button type="button" data-cf-artist="${_attr(r.band)}" aria-label="${_attr(`Open ${r.band} in the spotlight`)}"
                        class="relative shrink-0 snap-start w-36 h-48 rounded-3xl overflow-hidden text-left active:scale-[0.97] transition-transform">
                    ${_art(r.band, 'absolute inset-0')}
                    <div class="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/30 to-slate-900/40"></div>
                    <span class="absolute top-3 left-3 text-3xl font-black italic tracking-tighter text-white leading-none">${escapeHtml(String(r.year))}</span>
                    <span class="absolute inset-x-0 bottom-0 p-3">
                        <span class="block text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(r.band)}</span>
                        <span class="block mt-1 text-[10px] font-black uppercase tracking-widest text-white/80">${escapeHtml(_plural(ago, 'year', 'years'))} ago</span>
                    </span>
                </button>`;
                }).join('')}
            </div>
        </section>`;
}

function _emptyCard() {
    return `
        <div class="${CARD} text-center space-y-2">
            <h3 class="text-base font-black text-slate-900">Nothing to show yet</h3>
            <p class="text-sm text-slate-500">
                The feed fills in as people log shows.
                Invite a friend to GigList and it will get busier.
            </p>
        </div>`;
}

function _skeleton() {
    return `
        <div class="space-y-4 animate-pulse" aria-hidden="true">
            <div class="h-72 rounded-[2rem] bg-slate-200"></div>
            <div class="${CARD} h-56"></div>
        </div>`;
}

function _attribution() {
    for (const m of _media.values()) {
        if (m.image_url) {
            return '<p class="text-center text-[10px] font-bold text-slate-500 pt-1">Artist images and players from Spotify</p>';
        }
    }
    return '';
}

// ─── DATA ─────────────────────────────────────────────────────────────────────

async function _loadFeed(signal) {
    if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
    const { data: res, error } = await supabase.rpc('get_community_feed').abortSignal(signal);
    if (error) throw error;
    const data = res || {};
    _cache = { at: Date.now(), data };
    return data;
}

// Best-effort: a failure just means gradients/initials instead of photos.
async function _loadMedia(data, signal) {
    const missing = _uniqueBands(data).filter(b => !_mediaAsked.has(_key(b))).slice(0, MAX_MEDIA_NAMES);
    if (!missing.length) return;
    try {
        const { data: rows, error } = await supabase
            .rpc('get_community_artist_media', { p_names: missing })
            .abortSignal(signal);
        if (error) throw error;
        missing.forEach(b => _mediaAsked.add(_key(b)));
        for (const r of rows || []) {
            const k = _key(r.name);
            const prev = _media.get(k);
            // Duplicate artist rows can exist; keep whichever has an image.
            if (!prev || (!prev.image_url && r.image_url)) {
                _media.set(k, { image_url: r.image_url || null, spotify_artist_id: r.spotify_artist_id || null });
            }
        }
    } catch (err) {
        if (!signal.aborted) console.warn('community-feed: artist media failed', err);
    }
}

/**
 * Fan photos for one artist. The RPC only returns photos from public profiles;
 * the signed URLs work because of the storage policy that lets authenticated
 * users read gig-photos belonging to public profiles. Best-effort: any failure
 * just means the hero stays artwork-only. Returns the cached array itself on a
 * hit so callers can compare by reference.
 */
async function _loadPhotos(band, signal) {
    const cached = _photos.get(_key(band));
    if (cached && Date.now() - cached.at < PHOTO_CACHE_MS) return cached.list;
    try {
        const { data: rows, error } = await supabase
            .rpc('get_community_artist_photos', { p_band: band })
            .abortSignal(signal);
        if (error) throw error;
        let list = [];
        if (rows?.length) {
            const { data: signed, error: signErr } = await supabase.storage
                .from('gig-photos')
                .createSignedUrls(rows.map(r => r.photo_path), PHOTO_URL_TTL_S);
            if (signErr) throw signErr;
            const urls = new Map((signed || []).filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
            // Belt and braces: never show a photo dated in the future (the RPC filters too).
            const today = new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local time
            list = rows
                .filter(r => urls.has(r.photo_path) && (!r.show_date || r.show_date <= today))
                .map(r => ({ ...r, url: urls.get(r.photo_path) }));
        }
        _photos.set(_key(band), { at: Date.now(), list });
        return list;
    } catch (err) {
        if (!signal.aborted) console.warn('community-feed: fan photos failed', err);
        return [];
    }
}

// ─── PANE ─────────────────────────────────────────────────────────────────────

async function renderFeedPane(el /*, ctx */) {
    let disposed = false;
    const ctrl = new AbortController();
    const disposer = () => { disposed = true; ctrl.abort(); };

    // Cold start: skeleton so the tab doesn't flash empty.
    el.innerHTML = _skeleton();

    let data;
    try {
        data = await _loadFeed(ctrl.signal);
    } catch (err) {
        if (disposed) return disposer;   // left the tab; nothing to render
        console.warn('community-feed: load failed', err);
        el.innerHTML = `<p class="text-sm text-slate-500">Couldn't load the feed. Please try again.</p>`;
        return disposer;
    }
    if (disposed) return disposer;

    await _loadMedia(data, ctrl.signal);
    if (disposed) return disposer;

    // View state lives in this closure; nothing leaks between tab visits.
    let spotlight = _pickSpotlight(data);
    let playing = false;
    let photos = spotlight ? _cachedPhotos(spotlight) : [];   // fan photos for the current spotlight
    let slide = 0;                                            // 0 = artwork, 1..n = fan photos

    const repaintSpotlight = () => {
        const host = el.querySelector('[data-cf-spotlight]');
        if (!host) return;
        host.outerHTML = _spotlightSection(spotlight, data, playing, photos, slide);
        // Keep the swipe position across Listen / Close player repaints.
        const rail = el.querySelector('[data-cf-hero]');
        if (rail && slide > 0) rail.scrollLeft = slide * rail.clientWidth;
        if (window.lucide) lucide.createIcons();
    };

    // Lazy: runs when the spotlight changes, never blocks the feed render.
    const loadPhotosFor = async (band) => {
        if (!band) return;
        const list = await _loadPhotos(band, ctrl.signal);
        if (disposed || band !== spotlight || list === photos) return;
        photos = list;
        // Don't repaint under a playing Spotify iframe; photos appear on the next repaint.
        if (list.length && !playing) repaintSpotlight();
    };

    const html = [
        _spotlightSection(spotlight, data, false, photos, 0),
        _hotCard(data.hot),
        _trendingCard(data.trending),
        _venuesAheadCard(data.venues_ahead),
        _onThisDayCard(data.on_this_day),
    ].join('');

    const hasContent = !!(spotlight || data.hot?.length || data.trending?.length ||
                          data.venues_ahead?.length || data.on_this_day?.length);
    el.innerHTML = hasContent
        ? `<div class="space-y-4">${html}${_attribution()}</div>`
        : _emptyCard();

    // Delegated listeners on the host; removed with the host on tab change,
    // and explicitly in the disposer for good measure.
    const onClick = (e) => {
        if (e.target.closest('[data-cf-venue]')) { window.showCommunityTab?.('gigs'); return; }

        const art = e.target.closest('[data-cf-artist]');
        if (art) {
            // Swap the hero in place. No scrolling: the page stays where it is.
            spotlight = art.dataset.cfArtist;
            playing = false;
            slide = 0;
            photos = _cachedPhotos(spotlight);
            repaintSpotlight();
            loadPhotosFor(spotlight);
            return;
        }
        if (e.target.closest('[data-cf-play]')) { playing = true;  repaintSpotlight(); return; }
        if (e.target.closest('[data-cf-stop]')) { playing = false; repaintSpotlight(); }
    };

    // <img> error events don't bubble, so listen in the capture phase.
    // Chain: Spotify image -> local stock photo -> remove (initials show through).
    const onImgError = (e) => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        // Fan photo / avatar: just drop the broken image; gradient or initials show through.
        if (img.hasAttribute('data-cf-photo') || img.hasAttribute('data-cf-avatar')) { img.remove(); return; }
        if (!img.hasAttribute('data-cf-img')) return;
        if (img.dataset.stage === 'remote') {
            img.dataset.stage = 'local';
            img.src = _localArt(img.dataset.band);
        } else {
            img.remove();
        }
    };

    // Hero swipe: scroll events don't bubble, so capture. Updates the overlay
    // caption and dots in place; throttled to one update per frame.
    let raf = 0;
    const onHeroScroll = (e) => {
        const rail = e.target;
        if (!(rail instanceof Element) || !rail.hasAttribute('data-cf-hero')) return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const i = Math.round(rail.scrollLeft / (rail.clientWidth || 1));
            if (i === slide || i < 0 || i > photos.length) return;
            slide = i;
            const host = el.querySelector('[data-cf-spotlight]');
            if (host) _applySlide(host, spotlight, data, photos, slide);
        });
    };

    el.addEventListener('click', onClick);
    el.addEventListener('error', onImgError, true);
    el.addEventListener('scroll', onHeroScroll, true);
    const dispose = () => {
        cancelAnimationFrame(raf);
        el.removeEventListener('click', onClick);
        el.removeEventListener('error', onImgError, true);
        el.removeEventListener('scroll', onHeroScroll, true);
        disposer();
    };

    if (window.lucide) lucide.createIcons();
    loadPhotosFor(spotlight);
    return dispose;
}

registerCommunityPane('feed', renderFeedPane);
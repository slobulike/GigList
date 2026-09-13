/**
 * GigList — Stats Share Module
 * v1.2.0 — Sep 2026
 *
 * Generates a shareable 1080×1080 canvas stats card from the user's
 * journal data. Four variants, named to match the existing achievement
 * fan-type labels so the vocabulary stays consistent across the app:
 *
 *   • explorer — shows / venues / cities / countries + flag row, on top
 *                of a static map render of the user's venues
 *                (the Momento-passport competitor)
 *   • devotee  — top artist, times seen, first show, on top of the
 *                artist's Spotify image
 *   • geek     — gigs-per-year bar chart + busiest year, on top of the
 *                second-most-seen artist's Spotify image (kept distinct
 *                from Devotee, which already features the top artist).
 *                Year bucketing mirrors renderYearChart in charts.js so
 *                the numbers match the real Stats tab chart.
 *   • squad    — top companion + shows together, on top of their buddy
 *                avatar when one can be matched. Companion data comes from
 *                getCompanionsForGig (data.js) — the merged source shared
 *                with the dashboard's companion chart and the achievement
 *                buddy count, which prefers structured gig_companions tags
 *                over the legacy free-text 'Went With' field per row. A
 *                confirmed tag's userId is matched directly against
 *                window._following for the avatar; legacy free-text
 *                companions fall back to a case-insensitive name match
 *                (_buddyAvatarByName) — the same approach social.js's
 *                resolveCompanionTags uses to promote legacy companion
 *                tags to confirmed buddies. No match, or no avatar at all,
 *                just falls back to the flat background.
 *
 * Background images are fetched through a small Cloudflare Worker
 * (see static-map-worker.js) rather than the live Leaflet/OSM map,
 * because OSM's tile servers don't send CORS headers — drawing them
 * straight onto this canvas would taint it and break Save/Share the
 * moment someone actually uses the button. See that file's header
 * comment for the full explanation. MAP_WORKER_URL below needs to
 * point at wherever that Worker ends up deployed.
 *
 * The UK home nation flag split is parked until there's a stronger
 * signal the whole feature is a keeper — see countryToFlag in utils.js.
 *
 * Public API (window helpers), mirroring collection-collage.js:
 *   window._statsOpenShare(journalData)   — open the modal
 *   window._statsCloseShare()             — close and clean up
 *   window._statsSetVariant(variant)      — switch variant, re-render
 *   window._statsShareDownload()          — save PNG
 *   window._statsShareShare()             — Web Share API
 */

import { buildBadgeDefs, deriveFanType } from './achievements.js';
import { getCompanionsForGig } from './data.js';
import { countryToFlag } from './utils.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Palette kept in sync with collection-collage.js so share images feel like
// one family of assets rather than two competing visual styles.

const CANVAS_SIZE  = 1080;
const CANVAS_SCALE = 2;
const GOLD         = '#c8a050';
const DARK         = '#111008';
const OFF_WHITE    = '#f0deb0';
const FOOTER_H     = 96;

const VARIANTS = ['explorer', 'devotee', 'geek', 'squad'];

const MAP_WORKER_URL = 'https://static-map-worker.richard-lipscombe.workers.dev/';

// Geoapify (and URL length generally) start to strain with too many markers
// in one request, so we cap how many venue pins we send. Kept as a named
// constant so it's easy to tune later without hunting through the function.
const MAX_MAP_MARKERS = 80;

// ─── STATE ────────────────────────────────────────────────────────────────────

let _modalEl       = null;
let _canvasEl      = null;
let _activeVariant = 'explorer';
let _journalData   = [];
let _cardStats     = null;              // computed once per open — see _computeCardStats
let _bgImages      = { explorer: null, devotee: null, geek: null, squad: null };   // cached per open, null = not loaded / failed

// ─── MODAL SCAFFOLD ───────────────────────────────────────────────────────────

function _ensureModal() {
    if (document.getElementById('stats-share-modal')) return;

    const el = document.createElement('div');
    el.id = 'stats-share-modal';
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Share your stats');

    el.innerHTML = `
        <style>
            #stats-share-modal {
                position: fixed;
                inset: 0;
                z-index: 500;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: flex-end;
                padding-bottom: env(safe-area-inset-bottom, 0px);
                opacity: 0;
                transition: opacity 0.25s ease;
            }
            #stats-share-modal.visible { opacity: 1; }
            #stats-share-sheet {
                background: #111008;
                border-radius: 2rem 2rem 0 0;
                width: 100%;
                max-width: 28rem;
                max-height: 92dvh;
                overflow-y: auto;
                overflow-x: hidden;
                transform: translateY(40px);
                transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                padding-bottom: 2rem;
            }
            #stats-share-modal.visible #stats-share-sheet { transform: translateY(0); }
            #stats-share-canvas-wrap {
                margin: 0 1.25rem 1rem;
                border-radius: 1rem;
                overflow: hidden;
                aspect-ratio: 1;
                background: #000;
                position: relative;
                box-shadow: 0 8px 40px rgba(0,0,0,0.6);
            }
            #stats-share-canvas { width: 100%; height: 100%; display: block; }
            #stats-share-spinner {
                position: absolute; inset: 0;
                display: flex; align-items: center; justify-content: center;
                background: #111008;
                transition: opacity 0.3s ease;
            }
            #stats-share-spinner.hidden { opacity: 0; pointer-events: none; }
            .stats-spinner-ring {
                width: 36px; height: 36px;
                border: 3px solid rgba(200,160,80,0.2);
                border-top-color: #c8a050;
                border-radius: 50%;
                animation: stats-spin 0.8s linear infinite;
            }
            @keyframes stats-spin { to { transform: rotate(360deg); } }
            .stats-variant-btn {
                flex: 1;
                padding: 0.5rem 0;
                font-size: 10px;
                font-weight: 900;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                border-radius: 0.625rem;
                border: 1px solid transparent;
                transition: all 0.15s ease;
                cursor: pointer;
                color: #6b7280;
                background: transparent;
            }
            .stats-variant-btn.active {
                background: rgba(200,160,80,0.15);
                border-color: rgba(200,160,80,0.5);
                color: #c8a050;
            }
            .stats-action-btn {
                flex: 1;
                display: flex; align-items: center; justify-content: center; gap: 0.5rem;
                padding: 0.875rem 0;
                font-size: 11px;
                font-weight: 900;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                border-radius: 1rem;
                cursor: pointer;
                border: none;
                transition: all 0.15s ease;
                -webkit-tap-highlight-color: transparent;
            }
            .stats-action-btn:active { transform: scale(0.97); }
            .stats-action-btn.primary   { background: #c8a050; color: #111008; }
            .stats-action-btn.secondary { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.7); }
            .stats-action-btn:disabled  { opacity: 0.4; pointer-events: none; }
        </style>

        <div id="stats-share-sheet" onclick="event.stopPropagation()">

            <div style="padding: 1rem 1.25rem 0.75rem;">
                <div style="width:2.25rem;height:0.25rem;background:rgba(255,255,255,0.15);border-radius:9999px;margin:0 auto;"></div>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem 1rem;">
                <div>
                    <p style="font-size:18px;font-weight:900;color:#fff;line-height:1.1;">Share your stats</p>
                    <p style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.4);margin-top:3px;text-transform:uppercase;letter-spacing:0.08em;">
                        Pick a style
                    </p>
                </div>
                <button onclick="window._statsCloseShare()"
                        aria-label="Close"
                        style="width:2.25rem;height:2.25rem;border-radius:0.75rem;background:rgba(255,255,255,0.08);
                               border:none;color:rgba(255,255,255,0.5);cursor:pointer;display:flex;
                               align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
                    ✕
                </button>
            </div>

            <div id="stats-share-canvas-wrap">
                <canvas id="stats-share-canvas"
                        width="${CANVAS_SIZE * CANVAS_SCALE}"
                        height="${CANVAS_SIZE * CANVAS_SCALE}"></canvas>
                <div id="stats-share-spinner">
                    <div class="stats-spinner-ring"></div>
                </div>
            </div>

            <div style="display:flex;gap:0.5rem;padding:0 1.25rem 1rem;">
                <button class="stats-variant-btn active" id="stats-variant-explorer"
                        onclick="window._statsSetVariant('explorer')">Explorer</button>
                <button class="stats-variant-btn" id="stats-variant-devotee"
                        onclick="window._statsSetVariant('devotee')">Devotee</button>
                <button class="stats-variant-btn" id="stats-variant-geek"
                        onclick="window._statsSetVariant('geek')">Geek</button>
                <button class="stats-variant-btn" id="stats-variant-squad"
                        onclick="window._statsSetVariant('squad')">Squad</button>
            </div>

            <div style="display:flex;gap:0.75rem;padding:0 1.25rem;">
                <button id="stats-share-share-btn"
                        class="stats-action-btn secondary"
                        onclick="window._statsShareShare()"
                        style="display:none;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    Share
                </button>
                <button id="stats-share-download-btn"
                        class="stats-action-btn primary"
                        onclick="window._statsShareDownload()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Save Image
                </button>
            </div>

        </div>
    `;

    el.addEventListener('click', (e) => {
        if (e.target === el) window._statsCloseShare();
    });

    document.body.appendChild(el);
    _modalEl  = el;
    _canvasEl = document.getElementById('stats-share-canvas');

    if (navigator.share && navigator.canShare) {
        document.getElementById('stats-share-share-btn').style.display = 'flex';
    }
}

// ─── STATS COMPUTATION ────────────────────────────────────────────────────────

/**
 * Everything the two card variants need, computed once per open.
 * Venue enrichment (country/city) mirrors the lookup pattern used in
 * achievements.js's renderBandBadges — window.allVenues keyed by venue name.
 *
 * NOTE: renderMap() in ui.js reads lat/lng from window.venueLookup, while
 * renderBandBadges() in achievements.js reads country from window.allVenues.
 * This falls back across both in case they're not the same object — worth
 * confirming with Rich whether these are actually two names for one lookup
 * or genuinely separate, since duplicated venue lookups are an easy source
 * of drift later.
 */
function _venueLookup() {
    return window.venueLookup || window.allVenues || {};
}

function _computeCardStats(journalData) {
    const { statsData } = buildBadgeDefs(journalData);   // totalGigs, topArtist, maxArtistShows, ...
    const lookup = _venueLookup();

    const citySet    = new Set();
    const countrySet = new Set();
    const venuePoints = new Map();   // venue name -> {lat, lng, country}, deduped

    journalData.forEach(entry => {
        const vName    = entry.OfficialVenue || entry.Venue || '';
        const enriched = lookup[vName];
        if (!enriched) return;

        if (enriched.city) citySet.add(enriched.city);

        // Use the nation field once populated, falling back to country —
        // see utils.js countryToFlag for why (UK home-nation split, parked for now).
        const countryKey = enriched.nation || enriched.country;
        if (countryKey) countrySet.add(countryKey);

        if (!isNaN(enriched.lat) && !isNaN(enriched.lng) && !venuePoints.has(vName)) {
            // country falls back to a single bucket for uncategorised venues,
            // so they still get fair round-robin treatment in _selectDiverseMarkers
            // rather than silently being favoured or starved.
            venuePoints.set(vName, { lat: enriched.lat, lng: enriched.lng, country: countryKey || '__unknown__' });
        }
    });

    // First time the top artist was seen, for the Devotee card.
    const topArtistShows = journalData
        .filter(g => g.Band === statsData.topArtist)
        .sort((a, b) => (new Date(a.Date.split('/').reverse().join('-'))) - (new Date(b.Date.split('/').reverse().join('-'))));
    const firstTopArtistShow = topArtistShows[0] || null;
    const topArtistSpotifyUrl = topArtistShows.find(g => g.SpotifyImageUrl)?.SpotifyImageUrl || null;

    const { gigsPerYear, busiestYear, busiestYearCount } = _computeGigsPerYear(journalData);
    const { topCompanion, topCompanionCount, firstTopCompanionShow, topCompanionUserId } = _computeTopCompanion(journalData);
    const geekArtistUrl  = _computeSecondArtistImage(journalData, statsData.topArtist);
    const squadAvatarUrl = _squadAvatarUrl(topCompanion, topCompanionUserId);

    return {
        totalGigs:       statsData.totalGigs,
        uniqueVenues:    statsData.uniqueVenues,
        uniqueCities:    citySet.size,
        uniqueCountries: countrySet.size,
        countries:       [...countrySet],
        venuePoints:     [...venuePoints.values()],
        topArtist:       statsData.topArtist,
        maxArtistShows:  statsData.maxArtistShows,
        firstTopArtistShow,
        topArtistSpotifyUrl,
        gigsPerYear,
        busiestYear,
        busiestYearCount,
        geekArtistUrl,
        topCompanion,
        topCompanionCount,
        firstTopCompanionShow,
        squadAvatarUrl,
    };
}

/**
 * Background image for the Geek card: the second-most-seen artist (by
 * show count) with an available Spotify image, rather than reusing the
 * top artist — Devotee already puts that artist front and center, so
 * reusing it here would make the two cards look near-identical when
 * flipping between styles in the picker. Falls back to the top artist's
 * image if there's no second artist with a usable image, and to no image
 * at all (flat background) if neither does.
 */
function _computeSecondArtistImage(journalData, topArtist) {
    const artistCounts = {};
    journalData.forEach(entry => {
        if (entry.Band) artistCounts[entry.Band] = (artistCounts[entry.Band] || 0) + 1;
    });

    const ranked = Object.entries(artistCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);

    for (const name of ranked) {
        if (name === topArtist) continue;
        const withImage = journalData.find(g => g.Band === name && g.SpotifyImageUrl);
        if (withImage) return withImage.SpotifyImageUrl;
    }

    // No usable second artist — fall back to the top artist's own image.
    const topWithImage = journalData.find(g => g.Band === topArtist && g.SpotifyImageUrl);
    return topWithImage?.SpotifyImageUrl || null;
}

/**
 * Gigs-per-year buckets for the Geek card's bar chart. Deliberately mirrors
 * renderYearChart's own DD/MM/YYYY-or-YYYY-MM-DD parsing in charts.js so
 * this card's numbers can't drift from what the real Stats tab chart shows.
 */
function _computeGigsPerYear(journalData) {
    const yearCounts = {};
    journalData.forEach(g => {
        if (!g.Date) return;
        const parts = g.Date.includes('/') ? g.Date.split('/') : g.Date.split('-');
        if (parts.length !== 3) return;
        const year = parts[2].length === 4 ? parts[2] : parts[0];
        if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
    });

    const allYears = Object.keys(yearCounts).map(Number).filter(y => !isNaN(y));
    if (allYears.length === 0) {
        return { gigsPerYear: [], busiestYear: null, busiestYearCount: 0 };
    }

    const startYear = Math.min(...allYears);
    const endYear   = new Date().getFullYear();

    const gigsPerYear = [];
    for (let y = startYear; y <= endYear; y++) {
        gigsPerYear.push({ year: y, count: yearCounts[y.toString()] || 0 });
    }

    const busiest = gigsPerYear.reduce((best, cur) => (cur.count > best.count ? cur : best), gigsPerYear[0]);

    return { gigsPerYear, busiestYear: busiest.year, busiestYearCount: busiest.count };
}

/**
 * Top companion for the Squad card. Uses the same merged companion source
 * (getCompanionsForGig, from data.js) as the dashboard's companion chart
 * and the achievement buddy count, so all three agree — structured
 * gig_companions tags take priority over the legacy free-text field per
 * row, with the legacy field as a fallback for pre-migration entries.
 * Also surfaces topCompanionUserId when a confirmed tag supplies one, so
 * Squad's avatar lookup can use a real account match instead of only
 * ever guessing by name.
 */
function _computeTopCompanion(journalData) {
    const companionCounts  = {};
    const companionShows   = {};   // name -> array of shows they appear in, for first-together lookup
    const companionUserIds = {};   // name -> first confirmed userId seen for that name, if any

    journalData.forEach(gig => {
        getCompanionsForGig(gig).forEach(({ name, userId }) => {
            if (!name) return;
            companionCounts[name] = (companionCounts[name] || 0) + 1;
            (companionShows[name] = companionShows[name] || []).push(gig);
            if (userId && !companionUserIds[name]) companionUserIds[name] = userId;
        });
    });

    const sorted = Object.entries(companionCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
        return { topCompanion: null, topCompanionCount: 0, firstTopCompanionShow: null, topCompanionUserId: null };
    }

    const [topCompanion, topCompanionCount] = sorted[0];
    const firstTopCompanionShow = [...companionShows[topCompanion]]
        .sort((a, b) => (new Date(a.Date.split('/').reverse().join('-'))) - (new Date(b.Date.split('/').reverse().join('-'))))[0] || null;

    return {
        topCompanion,
        topCompanionCount,
        firstTopCompanionShow,
        topCompanionUserId: companionUserIds[topCompanion] || null,
    };
}

/**
 * Match the top companion's free-text name against accepted buddies in
 * window._following (populated by social.js's initSocial) to find an
 * avatar for Squad's background. Case-insensitive match against either
 * display_name or username — the same style of match social.js's
 * resolveCompanionTags uses to promote legacy companion tags to confirmed
 * buddy links. A miss (nickname mismatch, or the companion just isn't an
 * accepted buddy) is expected and simply means no avatar.
 *
 * This is now the fallback path — _squadAvatarUrl below prefers a direct
 * userId match (from a confirmed gig_companions tag) when one's available,
 * since that's a real account link rather than a name guess.
 */
function _buddyAvatarByName(name) {
    if (!name) return null;
    const target    = name.trim().toLowerCase();
    const following = window._following || [];

    const match = following.find(b =>
        (b.display_name || '').trim().toLowerCase() === target ||
        (b.username || '').trim().toLowerCase() === target
    );

    return match?.avatar_url || null;
}

/**
 * Squad's background image source. Prefers a direct userId match (from a
 * confirmed gig_companions tag, via _computeTopCompanion) against
 * window._following, since that's an actual account link rather than a
 * guess. Falls back to name-matching for legacy free-text companions with
 * no structured tag at all.
 */
function _squadAvatarUrl(topCompanion, topCompanionUserId) {
    if (topCompanionUserId) {
        const following = window._following || [];
        const byId = following.find(b => b.id === topCompanionUserId);
        if (byId?.avatar_url) return byId.avatar_url;
    }
    return _buddyAvatarByName(topCompanion);
}

// ─── BACKGROUND IMAGE LOADING ─────────────────────────────────────────────────

/**
 * Load an image with crossOrigin='anonymous' so canvas can read it back
 * for export. Resolves null on any failure — callers fall back to a flat
 * background rather than breaking the card. Mirrors the same pattern
 * collection-collage.js uses for collection photos.
 */
function _loadImage(url) {
    return new Promise((resolve) => {
        if (!url) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

/**
 * Cap the venue points sent to the map worker at MAX_MAP_MARKERS while
 * keeping country spread rather than whatever order journalData happened
 * to produce (which otherwise skews toward whichever country has the most
 * logged venues — typically the user's home country). Round-robins one
 * venue per country per pass, so every country gets a pin before any
 * country gets a second one. If there are more countries than the cap,
 * the countries reached last (Map iteration = first-seen order in
 * journalData) simply don't get a pin — an accepted edge case for now.
 */
function _selectDiverseMarkers(venuePoints, max = MAX_MAP_MARKERS) {
    if (venuePoints.length <= max) return venuePoints;

    const byCountry = new Map();
    venuePoints.forEach(p => {
        if (!byCountry.has(p.country)) byCountry.set(p.country, []);
        byCountry.get(p.country).push(p);
    });

    const buckets  = [...byCountry.values()];
    const selected = [];
    let round = 0;

    while (selected.length < max) {
        const before = selected.length;
        for (const bucket of buckets) {
            if (round < bucket.length) {
                selected.push(bucket[round]);
                if (selected.length >= max) break;
            }
        }
        if (selected.length === before) break;   // every bucket exhausted before hitting max
        round++;
    }

    return selected;
}

async function _loadExplorerBackground(stats) {
    if (_bgImages.explorer !== null) return _bgImages.explorer;
    if (!stats.venuePoints.length || MAP_WORKER_URL.includes('REPLACE-ME')) {
        _bgImages.explorer = false;   // false = "tried, nothing to show" (vs null = "not tried yet")
        return false;
    }

    const points  = _selectDiverseMarkers(stats.venuePoints);
    const markers = points.map(p => `${p.lat},${p.lng}`).join('|');
    const mapUrl  = `${MAP_WORKER_URL}?markers=${encodeURIComponent(markers)}&size=${CANVAS_SIZE}x${CANVAS_SIZE}`;

    const img = await _loadImage(mapUrl);
    _bgImages.explorer = img || false;
    return _bgImages.explorer;
}

async function _loadDevoteeBackground(stats) {
    if (_bgImages.devotee !== null) return _bgImages.devotee;
    const img = await _loadImage(stats.topArtistSpotifyUrl);
    _bgImages.devotee = img || false;
    return _bgImages.devotee;
}

async function _loadGeekBackground(stats) {
    if (_bgImages.geek !== null) return _bgImages.geek;
    const img = await _loadImage(stats.geekArtistUrl);
    _bgImages.geek = img || false;
    return _bgImages.geek;
}

async function _loadSquadBackground(stats) {
    if (_bgImages.squad !== null) return _bgImages.squad;
    const img = await _loadImage(stats.squadAvatarUrl);
    _bgImages.squad = img || false;
    return _bgImages.squad;
}

/**
 * Cover-fit an image into the full canvas, then lay a dark scrim over it
 * so the gold/off-white text on top stays legible regardless of what's
 * in the photo. Same cover-fit math as collection-collage.js's photo tiles.
 */
function _drawCoverImage(ctx, img, size, s) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(size / iw, size / ih);
    const dw = iw * scale, dh = ih * scale;
    const ox = (size - dw) / 2, oy = (size - dh) / 2;
    ctx.drawImage(img, ox * s, oy * s, dw * s, dh * s);

    const gradient = ctx.createLinearGradient(0, 0, 0, size * s);
    gradient.addColorStop(0,   'rgba(17,16,8,0.55)');
    gradient.addColorStop(0.5, 'rgba(17,16,8,0.72)');
    gradient.addColorStop(1,   'rgba(17,16,8,0.92)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size * s, size * s);
}

// ─── SHARED DRAW HELPERS ──────────────────────────────────────────────────────

function _drawFooterBar(ctx, size, s, label) {
    const fy = size - FOOTER_H;

    ctx.fillStyle = DARK;
    ctx.globalAlpha = 0.85;   // slightly transparent so a busy background still reads through
    ctx.fillRect(0, fy * s, size * s, FOOTER_H * s);
    ctx.globalAlpha = 1;

    ctx.fillStyle = GOLD;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, fy * s, size * s, 1.5 * s);
    ctx.globalAlpha = 1;

    const midY = fy + FOOTER_H / 2;

    ctx.fillStyle    = GOLD;
    ctx.font         = `900 ${22 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${2 * s}px`;
    ctx.fillText('GIGLIST', 28 * s, (midY - 11) * s);

    ctx.fillStyle    = OFF_WHITE;
    ctx.font         = `700 ${11 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${1.5 * s}px`;
    ctx.fillText(label.toUpperCase(), 28 * s, (midY + 13) * s);
}

function _drawFlatBackground(ctx, size, s) {
    ctx.clearRect(0, 0, size * s, size * s);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size * s, size * s);
}

// ─── VARIANT: EXPLORER ────────────────────────────────────────────────────────

function _renderExplorer(ctx, size, s, stats) {
    const contentH = size - FOOTER_H;
    const padRight = size - 72; // Anchor x-position for right alignment

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'alphabetic';

    // --- Headline: Total Shows ---
    ctx.fillStyle = OFF_WHITE;
    ctx.font      = `900 ${220 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.fillText(String(stats.totalGigs), padRight * s, (contentH * 0.36) * s);

    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${32 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('SHOWS LOGGED', padRight * s, (contentH * 0.36 + 48) * s);

    // --- Secondary Stats: Venues / Cities / Countries ---
    // Scaled up values to balance visually against the main 220px total shows text
    const statY = contentH * 0.60;
    const cols  = [
        { label: 'VENUES',    value: stats.uniqueVenues },
        { label: 'CITIES',    value: stats.uniqueCities },
        { label: 'COUNTRIES', value: stats.uniqueCountries },
    ];

    // Spread column centers back from the right margin
    const colSpacing = 280;

    cols.reverse().forEach((c, i) => {
        const cx = padRight - (colSpacing * i);

        ctx.fillStyle     = OFF_WHITE;
        ctx.font          = `900 ${100 * s}px 'Plus Jakarta Sans', sans-serif`; // Increased to 100px
        ctx.letterSpacing = '0px';
        ctx.fillText(String(c.value), cx * s, statY * s);

        ctx.fillStyle     = 'rgba(240,222,176,0.8)';
        ctx.font          = `800 ${18 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.letterSpacing = `${1.5 * s}px`;
        ctx.fillText(c.label, cx * s, (statY + 42) * s);
    });

    // --- Flag Row ---
    const flags = stats.countries.map(countryToFlag).filter(Boolean).join('  ');
    if (flags) {
        ctx.font = `${96 * s}px serif`; // Extra large flag row aligned right
        ctx.fillText(flags, padRight * s, (contentH * 0.84) * s);
    }

    _drawFooterBar(ctx, size, s, 'Explorer');
}

// ─── VARIANT: DEVOTEE ─────────────────────────────────────────────────────────

function _renderDevotee(ctx, size, s, stats) {
    const contentH = size - FOOTER_H;
    const padRight = size - 72; // Anchor x-position for right alignment

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'alphabetic';

    // --- Subtitle Header ---
    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${28 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('MOST SEEN ARTIST', padRight * s, (contentH * 0.18) * s);

    // --- Artist Name ---
    let artistSize = 96;
    ctx.font = `900 ${artistSize * s}px 'Plus Jakarta Sans', sans-serif`;
    while (ctx.measureText(stats.topArtist || '').width > (size - 144) * s && artistSize > 44) {
        artistSize -= 4;
        ctx.font = `900 ${artistSize * s}px 'Plus Jakarta Sans', sans-serif`;
    }
    ctx.fillStyle     = OFF_WHITE;
    ctx.letterSpacing = '0px';
    ctx.fillText(stats.topArtist || '—', padRight * s, (contentH * 0.30) * s);

    // --- Times Seen Stat ---
    ctx.fillStyle     = OFF_WHITE;
    ctx.font          = `900 ${220 * s}px 'Plus Jakarta Sans', sans-serif`; // Matched to Explorer's headline
    ctx.fillText(String(stats.maxArtistShows), padRight * s, (contentH * 0.62) * s);

    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${32 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('TIMES SEEN', padRight * s, (contentH * 0.62 + 48) * s);

    // --- First Seen Detail ---
    if (stats.firstTopArtistShow) {
        const venue = stats.firstTopArtistShow.OfficialVenue || stats.firstTopArtistShow.Venue || '';
        const date  = stats.firstTopArtistShow.Date || '';
        ctx.fillStyle     = 'rgba(240,222,176,0.85)';
        ctx.font          = `600 ${24 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.letterSpacing = '0px';
        ctx.fillText(`First seen ${date} — ${venue}`, padRight * s, (contentH * 0.84) * s);
    }

    _drawFooterBar(ctx, size, s, 'Devotee');
}

// ─── VARIANT: GEEK ────────────────────────────────────────────────────────────

/**
 * Draws a plain vertical bar chart into the given rect. No axis labels
 * beyond a sparse set of year ticks — this is a card decoration, not a
 * drill-down chart, so it favours legibility at small size over precision.
 */
function _drawBarChart(ctx, s, { x, y, w, h }, bars, highlightYear) {
    const maxCount = Math.max(...bars.map(b => b.count), 1);
    const gap      = bars.length > 20 ? 3 : 8;   // tighter gaps once there are a lot of years to fit
    const barW     = (w - gap * (bars.length - 1)) / bars.length;

    bars.forEach((bar, i) => {
        const barH = bar.count === 0 ? 2 : Math.max((bar.count / maxCount) * h, 4);
        const bx   = x + i * (barW + gap);
        const by   = y + h - barH;

        ctx.fillStyle = bar.year === highlightYear ? GOLD : 'rgba(240,222,176,0.35)';
        ctx.fillRect(bx * s, by * s, barW * s, barH * s);
    });

    // Sparse year ticks — first, last, and the highlighted year if it isn't
    // already one of those, so the axis stays readable without clutter.
    const tickYears = new Set([bars[0].year, bars[bars.length - 1].year, highlightYear]);
    ctx.fillStyle     = 'rgba(240,222,176,0.6)';
    ctx.font          = `700 ${16 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign     = 'center';
    ctx.letterSpacing = '0px';
    bars.forEach((bar, i) => {
        if (!tickYears.has(bar.year)) return;
        const bx = x + i * (barW + gap) + barW / 2;
        ctx.fillText(String(bar.year), bx * s, (y + h + 26) * s);
    });
}

function _renderGeek(ctx, size, s, stats) {
    const contentH = size - FOOTER_H;
    const padRight = size - 72;
    const padLeft  = 72;

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'alphabetic';

    // --- Subtitle Header ---
    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${28 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('BUSIEST YEAR', padRight * s, (contentH * 0.18) * s);

    // --- Headline: Busiest Year + Count ---
    ctx.fillStyle     = OFF_WHITE;
    ctx.font          = `900 ${140 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = '0px';
    ctx.fillText(stats.busiestYear ? String(stats.busiestYear) : '—', padRight * s, (contentH * 0.32) * s);

    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${32 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText(`${stats.busiestYearCount} SHOWS`, padRight * s, (contentH * 0.32 + 44) * s);

    // --- Gigs-per-year bar chart ---
    // Full career history, not just recent years — a 12-year cap used to be
    // applied here for bar width, but that meant a long-running journal's
    // busiest year could fall outside the visible window entirely (as
    // Rich's 2005 did). Sparse tick labels (first/last/busiest year, see
    // _drawBarChart) keep it legible even with a lot of bars.
    const bars = stats.gigsPerYear;
    if (bars.length > 0) {
        _drawBarChart(ctx, s, {
            x: padLeft,
            y: contentH * 0.52,
            w: padRight - padLeft,
            h: contentH * 0.28,
        }, bars, stats.busiestYear);
    }

    // --- Total shows footer stat ---
    ctx.textAlign     = 'right';
    ctx.fillStyle     = 'rgba(240,222,176,0.85)';
    ctx.font          = `600 ${24 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = '0px';
    ctx.fillText(`${stats.totalGigs} shows logged in total`, padRight * s, (contentH * 0.94) * s);

    _drawFooterBar(ctx, size, s, 'Geek');
}

// ─── VARIANT: SQUAD ───────────────────────────────────────────────────────────

function _renderSquad(ctx, size, s, stats) {
    const contentH = size - FOOTER_H;
    const padRight = size - 72;

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'alphabetic';

    // --- Subtitle Header ---
    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${28 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('TOP COMPANION', padRight * s, (contentH * 0.18) * s);

    // --- Companion Name (auto-shrink, same approach as Devotee's artist name) ---
    let nameSize = 96;
    ctx.font = `900 ${nameSize * s}px 'Plus Jakarta Sans', sans-serif`;
    while (ctx.measureText(stats.topCompanion || '').width > (size - 144) * s && nameSize > 44) {
        nameSize -= 4;
        ctx.font = `900 ${nameSize * s}px 'Plus Jakarta Sans', sans-serif`;
    }
    ctx.fillStyle     = OFF_WHITE;
    ctx.letterSpacing = '0px';
    ctx.fillText(stats.topCompanion || '—', padRight * s, (contentH * 0.30) * s);

    // --- Times Together Stat ---
    ctx.fillStyle     = OFF_WHITE;
    ctx.font          = `900 ${220 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.fillText(String(stats.topCompanionCount), padRight * s, (contentH * 0.62) * s);

    ctx.fillStyle     = GOLD;
    ctx.font          = `800 ${32 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('SHOWS TOGETHER', padRight * s, (contentH * 0.62 + 48) * s);

    // --- First Show Together Detail ---
    if (stats.firstTopCompanionShow) {
        const venue = stats.firstTopCompanionShow.OfficialVenue || stats.firstTopCompanionShow.Venue || '';
        const date  = stats.firstTopCompanionShow.Date || '';
        ctx.fillStyle     = 'rgba(240,222,176,0.85)';
        ctx.font          = `600 ${24 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.letterSpacing = '0px';
        ctx.fillText(`First together ${date} — ${venue}`, padRight * s, (contentH * 0.84) * s);
    }

    _drawFooterBar(ctx, size, s, 'Squad');
}

// ─── CORE RENDER ──────────────────────────────────────────────────────────────

async function _render(variant) {
    if (!_canvasEl || !_cardStats) return;

    const s    = CANVAS_SCALE;
    const ctx  = _canvasEl.getContext('2d');
    const size = CANVAS_SIZE;

    // Squad's avatar background depends on the companion matching an
    // accepted buddy by name (see _buddyAvatarByName) — no match just
    // means _loadSquadBackground resolves false and we stay flat.
    const bg = variant === 'devotee'
        ? await _loadDevoteeBackground(_cardStats)
        : variant === 'explorer'
        ? await _loadExplorerBackground(_cardStats)
        : variant === 'geek'
        ? await _loadGeekBackground(_cardStats)
        : variant === 'squad'
        ? await _loadSquadBackground(_cardStats)
        : false;

    _drawFlatBackground(ctx, size, s);
    if (bg) _drawCoverImage(ctx, bg, size, s);

    if (variant === 'devotee') {
        _renderDevotee(ctx, size, s, _cardStats);
    } else if (variant === 'geek') {
        _renderGeek(ctx, size, s, _cardStats);
    } else if (variant === 'squad') {
        _renderSquad(ctx, size, s, _cardStats);
    } else {
        _renderExplorer(ctx, size, s, _cardStats);
    }

    const spinner = document.getElementById('stats-share-spinner');
    if (spinner) spinner.classList.add('hidden');
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

window._statsOpenShare = async (journalData) => {
    _journalData = journalData || [];
    _cardStats   = _computeCardStats(_journalData);
    _bgImages    = { explorer: null, devotee: null, geek: null, squad: null };   // reset cache per open

    const { groups, statsData } = buildBadgeDefs(_journalData);
    const derived = deriveFanType(groups, statsData);
    _activeVariant = (derived && VARIANTS.includes(derived.type)) ? derived.type : 'explorer';

    _ensureModal();

    VARIANTS.forEach(v => {
        document.getElementById(`stats-variant-${v}`)?.classList.toggle('active', v === _activeVariant);
    });

    const spinner  = document.getElementById('stats-share-spinner');
    const dlBtn    = document.getElementById('stats-share-download-btn');
    const shareBtn = document.getElementById('stats-share-share-btn');
    if (spinner)  spinner.classList.remove('hidden');
    if (dlBtn)    dlBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;

    const modal = document.getElementById('stats-share-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => modal.classList.add('visible'));
    });

    await _render(_activeVariant);

    if (dlBtn)    dlBtn.disabled = false;
    if (shareBtn) shareBtn.disabled = false;
};

window._statsCloseShare = () => {
    const modal = document.getElementById('stats-share-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
};

window._statsSetVariant = (variant) => {
    _activeVariant = variant;

    VARIANTS.forEach(v => {
        document.getElementById(`stats-variant-${v}`)?.classList.toggle('active', v === variant);
    });

    const spinner = document.getElementById('stats-share-spinner');
    if (spinner) spinner.classList.remove('hidden');
    _render(variant);
};

window._statsShareDownload = () => {
    if (!_canvasEl) return;
    const date  = new Date().toISOString().slice(0, 10);
    const fname = `giglist-stats-${_activeVariant}-${date}.png`;

    const link  = document.createElement('a');
    link.download = fname;
    link.href     = _canvasEl.toDataURL('image/png');
    link.click();
};

window._statsShareShare = async () => {
    if (!_canvasEl || !navigator.share) return;

    try {
        const blob = await new Promise(resolve => _canvasEl.toBlob(resolve, 'image/png'));
        if (!blob) return;

        const date = new Date().toISOString().slice(0, 10);
        const file = new File([blob], `giglist-stats-${_activeVariant}-${date}.png`, { type: 'image/png' });

        if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'My GigList stats' });
        } else {
            await navigator.share({ title: 'My GigList stats' });
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[StatsShare] share failed:', e.message);
    }
};
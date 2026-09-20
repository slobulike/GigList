/**
 * GigList — Collection Collage Module
 * v3.0.0 — September 2026
 *
 * Generates a shareable 1080×1080 canvas collage from a filtered
 * collection drill-down. Four visual variants, plus a branding toggle
 * that applies uniformly across all of them:
 *   • grid      — photo mosaic. Its own density picker chooses how many
 *                 items are shown: '3x3' and '6x6' are the legible/browsing
 *                 densities — they cap at their grid size and fold any
 *                 excess into a "+N" tile so individual items stay
 *                 recognisable; 'all' shows every item in the filtered
 *                 set, shrinking tiles to fit rather than capping
 *   • spectrum  — every item sorted into a hue gradient using hero_color
 *   • shape     — mosaic poured into a glyph silhouette, die-cut to the
 *                 glyph's smooth outline rather than the coarse tile grid.
 *                 'star' / 'heart' are fixed symbols. 'w' is a dynamic
 *                 monogram of whichever band dominates the current filtered
 *                 set (same dominant-band logic as Superfan's hero photo):
 *                 Weezer renders their own "=w=" logo, everyone else gets
 *                 initials (Blur → "b", Mayday Parade → "mp"). Resolution
 *                 chosen per-render to use as many items as possible
 *                 without leaving the shape incomplete
 *   • superfan  — hero band photo centred, collection tiles framing it
 *
 * Branding is a separate on/off toggle, independent of variant — when on,
 * every variant reserves a footer strip at the bottom for a branding bar:
 * the single artist and/or item type when the filtered set only spans one
 * of each (else the collection label), item count, date range, who shared
 * it (when known), and the GigList wordmark. Sized for legibility on a
 * phone screen — the original fixed footer's small gold meta text tested
 * as too small to read comfortably.
 *
 * Every grid-based variant renders TRUE square tiles (fixes the old
 * "thin strip" problem on large filtered sets).
 *
 * Public API (window helpers):
 *   window._colOpenCollage(items, label)   — open the modal
 *   window._colCloseCollage()              — close and clean up
 *   window._colSetCollageVariant(variant)  — 'grid' | 'spectrum' | 'shape' | 'superfan'
 *   window._colSetGridDensity(density)     — '3x3' | '6x6' | 'all' (grid variant only)
 *   window._colSetCollageShape(shape)      — 'w' | 'star' | 'heart' (shape variant only)
 *   window._colSetBranding(on)             — toggle the branding bar for every variant
 *
 * Integration hooks (defined in collection.js):
 *   window._colResolveBandPhoto(artistId, bandName) → Promise<string|null>
 *     Looks up artists.spotify_image_url by artist_id, falling back to a
 *     name match. If it resolves to null, Superfan falls back to the
 *     highest-resolution photo already present in the filtered set.
 *   window._colUserName : string (optional)
 *     Display name for the signed-in user. When set, the branding bar
 *     shows it as a small byline. Omitted entirely if unset.
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CANVAS_SIZE   = 1080;   // Output canvas logical size (square)
const CANVAS_SCALE  = 2;      // HiDPI — actual pixel buffer is 2160×2160
const FOOTER_H      = 150;    // Branding bar height (logical px) — bumped
                               // from 96 so its text can run larger and
                               // stay legible on a phone screen
const GRID_GAP      = 6;      // Gap between photo tiles (logical px)
const MAX_TILES     = 36;     // Legacy cap, still used by Superfan's ring
                               // sizing — see _squareGridPlan
const MIN_SHAPE_RES = 8;      // Floor for the 'shape' mask sampling grid
const MAX_SHAPE_RES = 20;     // Ceiling for the 'shape' mask sampling grid
const GOLD          = '#c8a050';
const DARK          = '#111008';
const OFF_WHITE     = '#f0deb0';

// 'w' here is only the fallback glyph used when no dominant band can be
// determined (e.g. a filtered set with no band_name items at all) — see
// _resolveShapeGlyph, which normally overrides it with a per-band monogram.
const _SHAPES = {
    w:     'W',
    star:  '\u2605',
    heart: '\u2665',
};

// Fixed grid sizes for the Grid variant's density picker. 'all' has no
// entry here — it has no fixed cols/rows, see _gridDensityPlan.
const GRID_DENSITIES = {
    '3x3': { cols: 3, rows: 3 },
    '6x6': { cols: 6, rows: 6 },
};

// ─── STATE ────────────────────────────────────────────────────────────────────

let _modalEl            = null;
let _canvasEl           = null;
let _activeVariant      = 'grid';   // 'grid' | 'spectrum' | 'shape' | 'superfan'
let _activeGridDensity  = '6x6';    // '3x3' | '6x6' | 'all' — used only when _activeVariant === 'grid'
let _activeShape        = 'w';      // used only when _activeVariant === 'shape'
let _brandingOn         = true;     // applies to every variant, independent of _activeVariant
let _collageItems       = [];
let _collageLabel       = '';
let _loadedImages       = [];       // Array of { img, item } — resolved HTMLImageElements


let _heroImage      = null;        // resolved hero photo for 'superfan' variant
let _heroResolved   = false;       // avoid re-resolving on every re-render

// ─── MODAL SCAFFOLD ───────────────────────────────────────────────────────────

function _ensureModal() {
    if (document.getElementById('col-collage-modal')) return;

    const el = document.createElement('div');
    el.id = 'col-collage-modal';
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Share collection collage');

    el.innerHTML = `
        <style>
            #col-collage-modal {
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
            #col-collage-modal.visible {
                opacity: 1;
            }
            #col-collage-sheet {
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
            #col-collage-modal.visible #col-collage-sheet {
                transform: translateY(0);
            }
            #col-collage-canvas-wrap {
                margin: 0 1.25rem 1rem;
                border-radius: 1rem;
                overflow: hidden;
                aspect-ratio: 1;
                background: #000;
                position: relative;
                box-shadow: 0 8px 40px rgba(0,0,0,0.6);
            }
            #col-collage-canvas {
                width: 100%;
                height: 100%;
                display: block;
            }
            #col-collage-spinner {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #111008;
                transition: opacity 0.3s ease;
            }
            #col-collage-spinner.hidden {
                opacity: 0;
                pointer-events: none;
            }
            .collage-spinner-ring {
                width: 36px; height: 36px;
                border: 3px solid rgba(200,160,80,0.2);
                border-top-color: #c8a050;
                border-radius: 50%;
                animation: collage-spin 0.8s linear infinite;
            }
            @keyframes collage-spin {
                to { transform: rotate(360deg); }
            }
            .col-variant-btn {
                flex: 1 1 30%;
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
            .col-variant-btn.active {
                background: rgba(200,160,80,0.15);
                border-color: rgba(200,160,80,0.5);
                color: #c8a050;
            }
            .col-shape-btn {
                flex: 1;
                padding: 0.375rem 0;
                font-size: 15px;
                border-radius: 0.5rem;
                border: 1px solid transparent;
                cursor: pointer;
                color: #6b7280;
                background: transparent;
                transition: all 0.15s ease;
            }
            .col-shape-btn.active {
                background: rgba(200,160,80,0.15);
                border-color: rgba(200,160,80,0.5);
                color: #c8a050;
            }
            .col-action-btn {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 0.5rem;
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
            .col-action-btn:active { transform: scale(0.97); }
            .col-action-btn.primary {
                background: #c8a050;
                color: #111008;
            }
            .col-action-btn.secondary {
                background: rgba(255,255,255,0.07);
                color: rgba(255,255,255,0.7);
            }
            .col-action-btn:disabled {
                opacity: 0.4;
                pointer-events: none;
            }
        </style>

        <!-- Sheet -->
        <div id="col-collage-sheet" onclick="event.stopPropagation()">

            <!-- Handle -->
            <div style="padding: 1rem 1.25rem 0.75rem; display:flex; align-items:center; justify-content:space-between;">
                <div style="width:2.25rem;height:0.25rem;background:rgba(255,255,255,0.15);border-radius:9999px;margin:0 auto;"></div>
            </div>

            <!-- Header row -->
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem 1rem;">
                <div>
                    <p id="col-collage-title-label"
                       style="font-size:18px;font-weight:900;color:#fff;line-height:1.1;"></p>
                    <p id="col-collage-meta-label"
                       style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.4);margin-top:3px;text-transform:uppercase;letter-spacing:0.08em;"></p>
                </div>
                <button onclick="window._colCloseCollage()"
                        aria-label="Close"
                        style="width:2.25rem;height:2.25rem;border-radius:0.75rem;background:rgba(255,255,255,0.08);
                               border:none;color:rgba(255,255,255,0.5);cursor:pointer;display:flex;
                               align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
                    ✕
                </button>
            </div>

            <!-- Canvas preview -->
            <div id="col-collage-canvas-wrap">
                <canvas id="col-collage-canvas"
                        width="${CANVAS_SIZE * CANVAS_SCALE}"
                        height="${CANVAS_SIZE * CANVAS_SCALE}"></canvas>
                <div id="col-collage-spinner">
                    <div class="collage-spinner-ring"></div>
                </div>
            </div>

            <!-- Variant picker -->
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;padding:0 1.25rem 0.5rem;">
                <button class="col-variant-btn active" id="col-variant-grid"
                        onclick="window._colSetCollageVariant('grid')">Grid</button>
                <button class="col-variant-btn" id="col-variant-spectrum"
                        onclick="window._colSetCollageVariant('spectrum')">Spectrum</button>
                <button class="col-variant-btn" id="col-variant-shape"
                        onclick="window._colSetCollageVariant('shape')">Shape</button>
                <button class="col-variant-btn" id="col-variant-superfan"
                        onclick="window._colSetCollageVariant('superfan')">Superfan</button>
            </div>

            <!-- Grid density picker (only shown for the 'grid' variant) -->
            <div id="col-density-picker" style="display:flex;gap:0.5rem;padding:0 1.25rem 1rem;">
                <button class="col-shape-btn active" id="col-density-3x3"
                        onclick="window._colSetGridDensity('3x3')">3×3</button>
                <button class="col-shape-btn" id="col-density-6x6"
                        onclick="window._colSetGridDensity('6x6')">6×6</button>
                <button class="col-shape-btn" id="col-density-all"
                        onclick="window._colSetGridDensity('all')">All</button>
            </div>

            <!-- Shape picker (only shown for the 'shape' variant) -->
            <div id="col-shape-picker" style="display:none;gap:0.5rem;padding:0 1.25rem 1rem;">
                <button class="col-shape-btn active" id="col-shape-w"
                        onclick="window._colSetCollageShape('w')">W</button>
                <button class="col-shape-btn" id="col-shape-star"
                        onclick="window._colSetCollageShape('star')">★</button>
                <button class="col-shape-btn" id="col-shape-heart"
                        onclick="window._colSetCollageShape('heart')">♥</button>
            </div>

            <!-- Branding toggle (applies to every variant, not shown/hidden by variant) -->
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem 1rem;">
                <span style="font-size:10px;font-weight:900;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;">Branding</span>
                <div style="display:flex;gap:0.5rem;">
                    <button class="col-shape-btn active" id="col-branding-on"
                            onclick="window._colSetBranding(true)"
                            style="flex:0 0 auto;padding:0.375rem 1rem;font-size:11px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;">On</button>
                    <button class="col-shape-btn" id="col-branding-off"
                            onclick="window._colSetBranding(false)"
                            style="flex:0 0 auto;padding:0.375rem 1rem;font-size:11px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;">Off</button>
                </div>
            </div>

            <!-- Action buttons -->
            <div style="display:flex;gap:0.75rem;padding:0 1.25rem;margin-top:0.5rem;">
                <button id="col-collage-share-btn"
                        class="col-action-btn secondary"
                        onclick="window._colCollageShare()"
                        style="display:none;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    Share
                </button>
                <button id="col-collage-download-btn"
                        class="col-action-btn primary"
                        onclick="window._colCollageDownload()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Save Image
                </button>
            </div>

        </div>
    `;

    // Close on backdrop tap
    el.addEventListener('click', (e) => {
        if (e.target === el) window._colCloseCollage();
    });

    document.body.appendChild(el);
    _modalEl  = el;
    _canvasEl = document.getElementById('col-collage-canvas');

    // Show Web Share button only if API is available
    if (navigator.share && navigator.canShare) {
        document.getElementById('col-collage-share-btn').style.display = 'flex';
    }
}

// ─── IMAGE LOADING ────────────────────────────────────────────────────────────

/**
 * Load an image from a URL into an HTMLImageElement, resolving when loaded.
 * Uses crossOrigin = 'anonymous' so canvas can read pixel data from Supabase
 * signed URLs (requires the collection-photos bucket to have CORS configured
 * to allow * or your domain for GET requests).
 */
function _loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);   // null = no photo, render colour tile
        img.src = url;
    });
}

/**
 * For each item, attempt to load its hero photo.
 * Items with no photo URL resolve to null — canvas falls back to hero_color tile.
 * Uses the _signedUrlCache already populated by collection.js.
 */
async function _loadImages(items) {
    // Access the signed URL cache exported by collection.js
    const cache = window._colSignedUrlCache || new Map();

    return Promise.all(items.map(async (item) => {
        const heroPath = item.photos?.[0];
        const url      = heroPath ? cache.get(heroPath) : null;
        const img      = url ? await _loadImage(url) : null;
        return { img, item };
    }));
}

// ─── COLOUR HELPERS ───────────────────────────────────────────────────────────

/**
 * Derive a fallback background colour for items without a photo.
 * Reuses hero_color if set, otherwise cycles the same spine palette
 * used in collection.js so colours feel consistent.
 */
const _SPINE_PALETTES = [
    '#1e3a5f','#3d1a4a','#1a3020','#4a2010',
    '#1a1a3a','#3a1a1a','#1a2a1a','#2a2a10',
    '#1a1a1a','#2a1020','#10202a','#201a10',
];
function _fallbackColor(item) {
    if (item.hero_color) return item.hero_color;
    let h = 0;
    const s = item.title || '';
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return _SPINE_PALETTES[h % _SPINE_PALETTES.length];
}

/**
 * Convert a hex colour string to a hue (0–360). Used to sort tiles into a
 * spectrum for the 'spectrum' variant. Falls back to 0 on malformed input.
 */
function _hexToHue(hex) {
    if (!hex) return 0;
    const clean = hex.replace('#', '');
    const full  = clean.length === 3
        ? clean.split('').map(c => c + c).join('')
        : clean;
    const r = parseInt(full.substring(0, 2), 16) / 255;
    const g = parseInt(full.substring(2, 4), 16) / 255;
    const b = parseInt(full.substring(4, 6), 16) / 255;
    if ([r, g, b].some(Number.isNaN)) return 0;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0; // greyscale — no hue, sorts to the front
    const d = max - min;
    let h;
    switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
    }
    return h * 60;
}

/**
 * The colour that represents a loaded item, for sorting/masking purposes —
 * always its sampled hero_color / fallback, regardless of whether a photo
 * is also present (photos aren't colour-sampled live here; hero_color is
 * the value collection.js's Canvas API sampling wrote at upload time).
 */
function _itemColor({ item }) {
    return _fallbackColor(item);
}

// ─── GRID LAYOUT ──────────────────────────────────────────────────────────────

/**
 * Calculate the optimal grid layout (columns × rows) for n slots.
 * Prefers square-ish grids; always fits all slots.
 */
function _gridLayout(n) {
    if (n <= 1)  return { cols: 1, rows: 1 };
    if (n <= 2)  return { cols: 2, rows: 1 };
    if (n <= 4)  return { cols: 2, rows: 2 };
    if (n <= 6)  return { cols: 3, rows: 2 };
    if (n <= 9)  return { cols: 3, rows: 3 };
    if (n <= 12) return { cols: 4, rows: 3 };
    if (n <= 16) return { cols: 4, rows: 4 };
    if (n <= 20) return { cols: 5, rows: 4 };
    if (n <= 25) return { cols: 5, rows: 5 };
    if (n <= 30) return { cols: 6, rows: 5 };
    if (n <= 36) return { cols: 6, rows: 6 };
    // Beyond the legible cap, keep growing near-square rather than pinning
    // columns — this is what lets 'all'/'spectrum' pack 60, 100+ items in
    // as small tiles instead of stretching a fixed 6-wide grid tall and thin.
    const cols = Math.ceil(Math.sqrt(n));
    return { cols, rows: Math.ceil(n / cols) };
}

/**
 * Generic auto-square capped plan: near-square cols/rows for n slots,
 * capped at maxTiles with the excess folded into an overflow tile. Used
 * internally by Superfan for its ring sizing — NOT the Grid variant's own
 * density picker, which uses fixed 3×3/6×6 grids instead (see
 * _gridDensityPlan below).
 */
function _squareGridPlan(n, maxTiles = MAX_TILES) {
    const overflow = n > maxTiles;
    const shown    = overflow ? maxTiles - 1 : n;
    const slots    = overflow ? maxTiles : n;
    const { cols, rows } = _gridLayout(slots);
    return { cols, rows, shown, overflow, overflowCount: n - shown };
}

/**
 * Layout plan for the Grid variant's density picker. '3x3' and '6x6' are
 * fixed legible grids — items beyond the grid's capacity fold into a "+N"
 * overflow tile so individual items stay recognisable (see
 * _selectForDisplay for how the shown subset is chosen). 'all' has no cap:
 * every item gets a slot and _gridLayout grows the grid to fit, shrinking
 * tiles rather than dropping items — the point of that mode is the overall
 * image, not individual tiles.
 */
function _gridDensityPlan(n, density) {
    if (density === 'all') {
        const { cols, rows } = _gridLayout(n);
        return { cols, rows, shown: n, overflow: false, overflowCount: 0 };
    }
    const { cols, rows } = GRID_DENSITIES[density] || GRID_DENSITIES['6x6'];
    const maxTiles = cols * rows;
    const overflow = n > maxTiles;
    const shown    = overflow ? maxTiles - 1 : n;
    return { cols, rows, shown, overflow, overflowCount: n - shown };
}

/**
 * When a filtered set is larger than the grid can show, pick a
 * representative subset rather than just the first N: prioritise items
 * with real photos, then spread the selection evenly across the full
 * (already date-ordered) list so early/late items both get a look-in.
 */
function _selectForDisplay(loadedImages, count) {
    if (loadedImages.length <= count) return loadedImages;

    const withPhoto = loadedImages.filter(x => x.img);
    const withoutPhoto = loadedImages.filter(x => !x.img);
    const pickEvenly = (arr, n) => {
        if (arr.length <= n) return arr;
        const out = [];
        const step = arr.length / n;
        for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
        return out;
    };

    if (withPhoto.length >= count) return pickEvenly(withPhoto, count);

    const remaining = count - withPhoto.length;
    return [...withPhoto, ...pickEvenly(withoutPhoto, remaining)];
}

/**
 * Draw a single grid tile (photo cover-fit, or colour + subtype icon).
 * Shared by every grid-based variant and the shape mosaic.
 */
function _drawTile(ctx, { img, item }, tx, ty, tw, th, s) {
    if (img) {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const fitScale = Math.max(tw / iw, th / ih);
        const dw = iw * fitScale, dh = ih * fitScale;
        const ox = (tw - dw) / 2, oy = (th - dh) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(tx * s, ty * s, tw * s, th * s);
        ctx.clip();
        ctx.drawImage(img, (tx + ox) * s, (ty + oy) * s, dw * s, dh * s);
        ctx.restore();
    } else {
        ctx.fillStyle = _fallbackColor(item);
        ctx.fillRect(tx * s, ty * s, tw * s, th * s);

        const icon = _SUBTYPE_ICONS[item.subtype] || '✦';
        ctx.font        = `${Math.round(Math.min(tw, th) * 0.35 * s)}px serif`;
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, (tx + tw / 2) * s, (ty + th / 2) * s);
    }
}

/**
 * Draw an overflow badge tile ("+N") in GigList gold.
 */
function _drawOverflowTile(ctx, tx, ty, tw, th, s, n) {
    ctx.fillStyle = GOLD;
    ctx.fillRect(tx * s, ty * s, tw * s, th * s);
    ctx.fillStyle = DARK;
    ctx.font         = `900 ${Math.round(Math.min(tw, th) * 0.28 * s)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${n}`, (tx + tw / 2) * s, (ty + th / 2) * s);
}

/**
 * Standard square-tile grid render, TRUE square tiles derived from a single
 * tileSize (never independently stretched per axis), centred within the
 * available area with any leftover space as even matte on both sides.
 * Handles the overflow ("+N") tile when the set exceeds MAX_TILES.
 */
function _renderGrid(ctx, size, imgArea, s, images, density = '6x6') {
    const plan = _gridDensityPlan(images.length, density);
    const { cols, rows, shown, overflow, overflowCount } = plan;

    const toShow = _selectForDisplay(images, shown);

    const gapPx = GRID_GAP;
    const tileSize = Math.min(
        (size    - gapPx * (cols + 1)) / cols,
        (imgArea - gapPx * (rows + 1)) / rows
    );

    const gridW = cols * tileSize + gapPx * (cols + 1);
    const gridH = rows * tileSize + gapPx * (rows + 1);
    const offsetX = (size - gridW) / 2;
    const offsetY = (imgArea - gridH) / 2;

    const totalSlots = cols * rows;

    for (let idx = 0; idx < totalSlots; idx++) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const tx  = offsetX + gapPx + col * (tileSize + gapPx);
        const ty  = offsetY + gapPx + row * (tileSize + gapPx);

        const isOverflowSlot = overflow && idx === totalSlots - 1;
        if (isOverflowSlot) {
            _drawOverflowTile(ctx, tx, ty, tileSize, tileSize, s, overflowCount);
        } else if (toShow[idx]) {
            _drawTile(ctx, toShow[idx], tx, ty, tileSize, tileSize, s);
        }
    }
}

// ─── SHAPE MOSAIC ─────────────────────────────────────────────────────────────

/**
 * Pick the shape's mask resolution for this render: as high as possible
 * without producing more "on" cells than we have items for, so the shape
 * fills in completely instead of running out of tiles partway through
 * (e.g. a star/heart's wider lower half being left blank). Falls back to
 * MIN_SHAPE_RES if even the coarsest grid has more cells than items.
 */
function _pickShapeResolution(glyph, itemCount) {
    let best = MIN_SHAPE_RES;
    for (let res = MIN_SHAPE_RES; res <= MAX_SHAPE_RES; res++) {
        if (_buildShapeMask(glyph, res).length > itemCount) break;
        best = res;
    }
    return best;
}

/**
 * Rasterize a glyph (single character or short string, e.g. "=w=" / "mp")
 * onto a px × px canvas, centred and scaled to fill it using its measured
 * bounding box rather than a fixed baseline fudge factor. Shared by mask
 * sampling and the shape's clip overlay so both always agree on exactly
 * where the glyph sits.
 *
 * @param {boolean} transparent  false (default) fills the background black
 *   first, for use as a sampling source that getImageData thresholds
 *   against. true leaves it transparent, for use as a destination-in clip
 *   mask, where a black background would punch out the whole canvas.
 */
function _rasterizeGlyph(glyph, px, transparent = false) {
    const off = document.createElement('canvas');
    off.width = off.height = px;
    const octx = off.getContext('2d');

    if (!transparent) {
        octx.fillStyle = '#000';
        octx.fillRect(0, 0, px, px);
    }
    octx.fillStyle = '#fff';
    octx.textAlign = 'center';
    octx.textBaseline = 'alphabetic';

    // Size the glyph to the canvas using its measured bounding box rather
    // than a fixed baseline fudge factor, so star/heart/W (and now
    // multi-character monograms like "mp" or "=w=") all centre and fill
    // consistently instead of one glyph's tuning clipping another.
    let fontSize = px * 0.8;
    octx.font = `900 ${fontSize}px 'Plus Jakarta Sans', Arial, sans-serif`;
    let box = octx.measureText(glyph);
    const glyphW = box.actualBoundingBoxLeft + box.actualBoundingBoxRight;
    const glyphH = box.actualBoundingBoxAscent + box.actualBoundingBoxDescent;
    const scale = Math.min(px / (glyphW || 1), px / (glyphH || 1)) * 0.92;
    fontSize = fontSize * scale;
    octx.font = `900 ${fontSize}px 'Plus Jakarta Sans', Arial, sans-serif`;
    box = octx.measureText(glyph);
    const cx = px / 2;
    const cy = px / 2 + (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2;
    octx.fillText(glyph, cx, cy);

    return off;
}

/**
 * Sample a glyph into an on/off mask at res × res resolution. Each cell is
 * tested against a small block of points (not just its centre) and counted
 * "on" if a third or more are inside the glyph fill — this keeps thin
 * extremities (star points, the heart's lower curve) from dropping out,
 * which single-point sampling was prone to at low resolutions.
 */
function _buildShapeMask(glyph, res) {
    const px  = res * 20; // supersample for a cleaner sample
    const off = _rasterizeGlyph(glyph, px, false);
    const data = off.getContext('2d').getImageData(0, 0, px, px).data;

    const cellPx = px / res;
    const sampleOffsets = [0.25, 0.5, 0.75];
    const cells = [];

    for (let row = 0; row < res; row++) {
        for (let col = 0; col < res; col++) {
            let hits = 0;
            for (const fx of sampleOffsets) {
                for (const fy of sampleOffsets) {
                    const sx = Math.min(px - 1, Math.floor((col + fx) * cellPx));
                    const sy = Math.min(px - 1, Math.floor((row + fy) * cellPx));
                    if (data[(sy * px + sx) * 4] > 128) hits++;
                }
            }
            if (hits >= 3) cells.push({ row, col }); // ~1/3 or more of the block is inside the glyph
        }
    }
    return cells;
}

/**
 * Turn a band name into the short monogram used by the 'w' shape slot.
 * Weezer gets their own logo treatment; everyone else gets initials — one
 * letter for a single-word name, one per word for two words, and first +
 * last word for anything longer. That last case is a rough approximation
 * (e.g. "Guns N' Roses" → "gr"), which is fine — it's a rare edge case and
 * not worth more precision than that.
 */
function _letterGlyphForBand(bandName) {
    if (!bandName) return 'W';
    const trimmed = bandName.trim();
    if (/^weezer$/i.test(trimmed)) return '=w=';

    // Drop a leading "The" so "The Mars Volta" reads as "mv", not "tv" —
    // cheap enough to be worth it given how common the prefix is.
    const words = trimmed.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
    if (!words.length) return 'W';
    if (words.length === 1) return words[0][0].toLowerCase();
    if (words.length === 2) return (words[0][0] + words[1][0]).toLowerCase();
    return (words[0][0] + words[words.length - 1][0]).toLowerCase();
}

/**
 * Resolve the glyph to render for the current shape selection. 'star' and
 * 'heart' are fixed symbols; 'w' — the "letter" slot — is dynamic: it
 * reflects whichever band dominates the current filtered set, using the
 * same dominant-band logic the Superfan variant uses to pick its hero photo
 * (see _dominantBand, below).
 */
function _resolveShapeGlyph(shapeKey) {
    if (shapeKey === 'w') {
        const dominant = _dominantBand(_collageItems);
        return _letterGlyphForBand(dominant?.band_name);
    }
    return _SHAPES[shapeKey] || _SHAPES.w;
}

/**
 * Render the 'shape' variant: pours the collection into a glyph silhouette,
 * tiles sorted into a hue spectrum so the shape also reads as a little
 * rainbow of the collection's own sampled colours.
 *
 * Tiles are drawn into an offscreen buffer sized to just the grid's
 * footprint, then the glyph is rasterized again at the buffer's own
 * physical pixel size and punched out with 'destination-in'. That second,
 * high-res rasterization — independent of the coarse res × res grid used
 * to decide which cells get a tile — is what gives the shape a smooth
 * die-cut edge instead of a blocky staircase matching the sampling grid.
 */
function _renderShape(ctx, size, imgArea, s, images, glyph) {
    const res = _pickShapeResolution(glyph, images.length);
    const cells = _buildShapeMask(glyph, res);
    if (!cells.length) return;

    const sorted = [...images].sort((a, b) => _hexToHue(_itemColor(a)) - _hexToHue(_itemColor(b)));
    const toShow = _selectForDisplay(sorted, cells.length);

    const gapPx = GRID_GAP;
    const dim = Math.min(size, imgArea);
    const tileSize = (dim - gapPx * (res + 1)) / res;
    const gridDim = res * tileSize + gapPx * (res + 1);
    const offsetX = (size - gridDim) / 2;
    const offsetY = (imgArea - gridDim) / 2;

    const bufPx = Math.round(gridDim * s);
    const buf = document.createElement('canvas');
    buf.width  = bufPx;
    buf.height = bufPx;
    const bctx = buf.getContext('2d');

    // Draw tiles at buffer-local coordinates (no offsetX/offsetY — the
    // buffer *is* just the grid footprint, positioned onto the main
    // canvas afterward).
    cells.forEach((cell, idx) => {
        if (idx >= toShow.length) return;
        const tx = gapPx + cell.col * (tileSize + gapPx);
        const ty = gapPx + cell.row * (tileSize + gapPx);
        _drawTile(bctx, toShow[idx], tx, ty, tileSize, tileSize, s);
    });

    bctx.globalCompositeOperation = 'destination-in';
    bctx.drawImage(_rasterizeGlyph(glyph, bufPx, true), 0, 0);
    bctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(buf, offsetX * s, offsetY * s, bufPx, bufPx);
}

// ─── SUPERFAN LAYOUT ──────────────────────────────────────────────────────────

/**
 * Find the most-represented artist in the filtered set, so the Superfan
 * hero photo matches what's actually being shared (e.g. sharing "Vinyl"
 * filtered to one artist should show that artist, not a random one).
 * Groups by artist_id where present (the real FK into artists.spotify_image_url)
 * so items for the same artist with/without a linked id don't split into two
 * buckets; falls back to band_name for older, unlinked items.
 */
function _dominantBand(items) {
    const counts = new Map();
    items.forEach(item => {
        const key = item.artist_id || item.band_name;
        if (!key) return;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    let bestKey = null, bestCount = 0;
    counts.forEach((count, key) => {
        if (count > bestCount) { bestCount = count; bestKey = key; }
    });
    if (!bestKey) return null;
    const match = items.find(i => (i.artist_id || i.band_name) === bestKey);
    return match ? { artist_id: match.artist_id, band_name: match.band_name } : null;
}

/**
 * Resolve the Superfan hero photo, once per modal open, caching the result.
 *
 * Calls window._colResolveBandPhoto(artistId, bandName) — defined in
 * collection.js, which queries artists.spotify_image_url by artist_id
 * (falling back to a name match for older unlinked items). If the hook is
 * missing or resolves to null, we fall back to the highest-resolution real
 * photo already in the filtered set, so the variant still degrades gracefully.
 */
async function _ensureHeroImage() {
    if (_heroResolved) return _heroImage;
    _heroResolved = true;

    const dominant = _dominantBand(_collageItems);
    let url = null;
    if (dominant && typeof window._colResolveBandPhoto === 'function') {
        try {
            url = await window._colResolveBandPhoto(dominant.artist_id, dominant.band_name);
        } catch (e) {
            console.warn('[Collage] _colResolveBandPhoto failed:', e.message);
        }
    }

    if (url) {
        const img = await _loadImage(url);
        if (img) { _heroImage = img; return _heroImage; }
    }

    // Fallback — largest photo already loaded stands in as the hero
    let best = null, bestArea = 0;
    _loadedImages.forEach(({ img }) => {
        if (!img) return;
        const area = img.naturalWidth * img.naturalHeight;
        if (area > bestArea) { bestArea = area; best = img; }
    });
    _heroImage = best;
    return _heroImage;
}

/**
 * Render the 'superfan' variant: a large centred hero photo, framed by a
 * ring of square collection tiles filling the rest of the canvas.
 */
function _renderSuperfan(ctx, size, imgArea, s, images, hero) {
    const dim = Math.min(size, imgArea);
    const centerX = size / 2;
    const centerY = imgArea / 2;
    const heroRadius = dim * 0.28;

    // Ring tiles: same square-grid math as _renderGrid, but skip any cell
    // whose centre falls inside the hero's radius.
    const plan = _squareGridPlan(images.length + 12); // pad the grid a little so the ring reads full
    const { cols, rows } = plan;
    const shown = _selectForDisplay(images, Math.min(images.length, cols * rows));

    const gapPx = GRID_GAP;
    const tileSize = Math.min(
        (size    - gapPx * (cols + 1)) / cols,
        (imgArea - gapPx * (rows + 1)) / rows
    );
    const gridW = cols * tileSize + gapPx * (cols + 1);
    const gridH = rows * tileSize + gapPx * (rows + 1);
    const offsetX = (size - gridW) / 2;
    const offsetY = (imgArea - gridH) / 2;

    let cursor = 0;
    for (let row = 0; row < rows && cursor < shown.length; row++) {
        for (let col = 0; col < cols && cursor < shown.length; col++) {
            const tx = offsetX + gapPx + col * (tileSize + gapPx);
            const ty = offsetY + gapPx + row * (tileSize + gapPx);
            const cx = tx + tileSize / 2, cy = ty + tileSize / 2;
            const dist = Math.hypot(cx - centerX, cy - centerY);
            if (dist < heroRadius + tileSize * 0.4) continue; // leave room for the hero
            _drawTile(ctx, shown[cursor], tx, ty, tileSize, tileSize, s);
            cursor++;
        }
    }

    // Hero photo — circular, gold ring border
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX * s, centerY * s, heroRadius * s, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (hero) {
        const fitScale = Math.max((heroRadius * 2) / hero.naturalWidth, (heroRadius * 2) / hero.naturalHeight);
        const dw = hero.naturalWidth * fitScale, dh = hero.naturalHeight * fitScale;
        ctx.drawImage(
            hero,
            (centerX - dw / 2) * s, (centerY - dh / 2) * s,
            dw * s, dh * s
        );
    } else {
        ctx.fillStyle = DARK;
        ctx.fillRect((centerX - heroRadius) * s, (centerY - heroRadius) * s, heroRadius * 2 * s, heroRadius * 2 * s);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(centerX * s, centerY * s, heroRadius * s, 0, Math.PI * 2);
    ctx.lineWidth = 5 * s;
    ctx.strokeStyle = GOLD;
    ctx.stroke();
}

// ─── SUBTYPE ICON MAP (mirrors collection-editor.js) ─────────────────────────

const _SUBTYPE_ICONS = {
    cd: '💿', vinyl: '🖤', tape: '📼', minidisc: '💽',
    apparel: '👕', poster: '🗒', magazine: '🗞', book: '📖',
    tab_book: '🎸', ticket: '🎟', laminate: '🪪', other: '✦',
};

// ─── LOGO / FOOTER / STAMP ────────────────────────────────────────────────────

/**
 * Draw the GigList wordmark, used by the branded footer.
 */
function _drawLogo(ctx, x, y, size, scale) {
    const s  = scale;
    const cx = x * s;
    const cy = y * s;
    const sz = size * s;

    ctx.save();
    ctx.globalAlpha  = 1;
    ctx.fillStyle    = GOLD;
    ctx.font         = `900 ${Math.round(sz * 0.42)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${2 * s}px`;
    ctx.fillText('GIGLIST', cx, cy);
    ctx.restore();
}

/**
 * Display labels for the branding bar's single-item-type byline. Mirrors
 * _SUBTYPE_ICONS' keys, just pluralised for prose ("CDs" not "cd").
 */
const _SUBTYPE_LABELS = {
    cd: 'CDs', vinyl: 'Vinyl', tape: 'Tapes', minidisc: 'MiniDiscs',
    apparel: 'Apparel', poster: 'Posters', magazine: 'Magazines',
    book: 'Books', tab_book: 'Tab Books', ticket: 'Tickets',
    laminate: 'Laminates', other: 'Other',
};

/**
 * The one artist represented across every item in this filtered set, or
 * null if it spans more than one artist (or none at all). Distinct from
 * _dominantBand below — that picks the *most common* artist for Superfan's
 * hero photo even in a mixed set; this only returns a value when the whole
 * set is a single artist, for the branding bar's "Weezer" / "Blur" byline.
 */
function _singleArtist(items) {
    let normalizedKey, displayBandName;

    for (const item of items) {
        // Fall back to artist_context if band_name isn't set on the record
        const rawName = item.band_name || item.artist_context;
        const name = rawName?.trim();

        // If an item literally has no artist metadata attached, skip it rather than breaking the header match
        if (!name && !item.artist_id) continue;

        const key = name ? name.toLowerCase() : String(item.artist_id);

        if (normalizedKey === undefined) {
            normalizedKey = key;
            displayBandName = name || item.band_name;
        } else if (normalizedKey !== key) {
            // Truly distinct multiple artists found
            return null;
        }
    }

    return displayBandName || null;
}

/**
 * The one item subtype represented across every item in this filtered set,
 * as a display label (e.g. "Vinyl"), or null if it spans more than one.
 */
function _singleItemType(items) {
    let subtype;
    for (const item of items) {
        const t = item.subtype;
        if (!t) continue;
        if (subtype === undefined) subtype = t;
        else if (subtype !== t) return null;
    }
    return subtype ? (_SUBTYPE_LABELS[subtype] || null) : null;
}

/**
 * Branding bar: a dark strip across the bottom, sized and typeset for
 * legibility on a phone screen (the original fixed footer's small gold
 * meta text tested as too small to read comfortably there). Two rows:
 *   Row 1 — heading (single artist and/or item type when the filtered set
 *           only spans one of each, else the collection label) + wordmark
 *   Row 2 — item count and date range (gold) + who shared it, if known
 * Independent of which visual variant is active — called from _render
 * whenever _brandingOn is true.
 */
function _drawBrandedFooter(ctx, size, imgArea, s) {
    const fy = imgArea;
    const fh = FOOTER_H;

    ctx.fillStyle = DARK;
    ctx.fillRect(0, fy * s, size * s, fh * s);

    ctx.fillStyle = GOLD;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, fy * s, size * s, 1.5 * s);
    ctx.globalAlpha = 1;

    const padX   = 32;
    const leftX  = padX;
    const rightX = size - padX;
    const row1Y  = fy + fh * 0.38;
    const row2Y  = fy + fh * 0.76;

    // Heading — prefers the specific (single artist / single type) over
    // the generic collection label, since it's a stronger caption when
    // the filtered set narrows to exactly one of either.

    const singleArtist = _singleArtist(_collageItems);
    const singleType   = _singleItemType(_collageItems);
    const headingParts = [];

    if (singleArtist) headingParts.push(singleArtist);
    if (singleType && singleType !== singleArtist) headingParts.push(singleType);

    const heading = headingParts.length ? headingParts.join(' · ') : _collageLabel;

    // Wordmark, measured first so the heading can be truncated to leave
    // exactly enough room for it rather than a guessed fixed reserve.
    const logoSize = 34;
    ctx.font = `900 ${Math.round(logoSize * s * 0.42)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${2 * s}px`;
    const logoWidth = ctx.measureText('GIGLIST').width / s;
    ctx.letterSpacing = '0px';

    ctx.fillStyle    = '#fff';
    ctx.font         = `900 ${30 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';

    const maxTitleW = (rightX - leftX - logoWidth - 24) * s;
    let titleText = heading;
    while (ctx.measureText(titleText).width > maxTitleW && titleText.length > 4) {
        titleText = titleText.slice(0, -1);
    }
    if (titleText !== heading) titleText = titleText.trim() + '…';
    ctx.fillText(titleText, leftX * s, row1Y * s);

    // Meta — item count + date range, upsized from the original 11px,
    // which tested as too small to read comfortably on a phone screen.
    const years = _collageItems
        .map(i => parseInt(i.item_date))
        .filter(y => !isNaN(y));
    const yearStr = years.length
        ? (Math.min(...years) === Math.max(...years)
            ? String(Math.min(...years))
            : `${Math.min(...years)}–${Math.max(...years)}`)
        : '';
    const n = _collageItems.length;
    const metaParts = [`${n} item${n !== 1 ? 's' : ''}`, yearStr].filter(Boolean);

    ctx.fillStyle    = GOLD;
    ctx.font         = `700 ${15 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.letterSpacing = `${0.75 * s}px`;
    ctx.fillText(metaParts.join('  ·  ').toUpperCase(), leftX * s, row2Y * s);
    ctx.letterSpacing = '0px';

    // Byline — who shared it, right-aligned under the wordmark. Omitted
    // entirely when window._colUserName isn't set, rather than showing a
    // placeholder.
    const userName = (typeof window._colUserName === 'string' && window._colUserName.trim())
        ? window._colUserName.trim()
        : null;
    if (userName) {
        ctx.fillStyle    = 'rgba(255,255,255,0.45)';
        ctx.font         = `700 ${13 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'right';
        ctx.letterSpacing = `${0.5 * s}px`;
        ctx.fillText(userName.toUpperCase(), rightX * s, row2Y * s);
        ctx.letterSpacing = '0px';
    }

    _drawLogo(ctx, rightX - logoWidth / 2, row1Y, logoSize, s);
}

// ─── CORE RENDER ──────────────────────────────────────────────────────────────

/**
 * Core render. Draws onto _canvasEl for the given variant.
 * All coordinates are in logical px; multiplied by CANVAS_SCALE before draw.
 */
async function _render(variant) {
    if (!_canvasEl || !_loadedImages.length) return;

    const s       = CANVAS_SCALE;
    const ctx     = _canvasEl.getContext('2d');
    const size    = CANVAS_SIZE;
    const imgArea = _brandingOn ? size - FOOTER_H : size;

    ctx.clearRect(0, 0, size * s, size * s);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size * s, size * s);

    if (variant === 'shape') {
        _renderShape(ctx, size, imgArea, s, _loadedImages, _resolveShapeGlyph(_activeShape));
    } else if (variant === 'superfan') {
        const hero = await _ensureHeroImage();
        _renderSuperfan(ctx, size, imgArea, s, _loadedImages, hero);
    } else if (variant === 'spectrum') {
        const sorted = [...(_loadedImages)].sort((a, b) => _hexToHue(_itemColor(a)) - _hexToHue(_itemColor(b)));
        _renderGrid(ctx, size, imgArea, s, sorted, 'all');
    } else {
        // 'grid' — density-driven browsing grid: '3x3' / '6x6' cap with a
        // "+N" overflow tile, 'all' shows every item and shrinks to fit.
        _renderGrid(ctx, size, imgArea, s, _loadedImages, _activeGridDensity);
    }

    if (_brandingOn) {
        _drawBrandedFooter(ctx, size, imgArea, s);
    }

    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.add('hidden');
}

/**
 * Keep the 'w' shape-picker button's label in sync with what it will
 * actually render — the current set's dominant-band monogram — so the
 * button doesn't just say "W" while the shape itself renders "mp".
 */
function _updateLetterShapeLabel() {
    const btn = document.getElementById('col-shape-w');
    if (!btn) return;
    const dominant = _dominantBand(_collageItems);
    btn.textContent = _letterGlyphForBand(dominant?.band_name);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Open the collage modal for a filtered item set.
 * @param {Array}  items  - filtered collection_items array from the drill-down
 * @param {string} label  - display label, e.g. "CDs" or "All Items"
 */
window._colOpenCollage = async (items, label) => {
    _collageItems      = items || [];
    _collageLabel      = label || 'Collection';
    _activeVariant     = 'grid';
    _activeGridDensity = '6x6';
    _activeShape       = 'w';
    _brandingOn        = true;
    _loadedImages      = [];
    _heroImage         = null;
    _heroResolved      = false;

    _ensureModal();
    _updateLetterShapeLabel();

    const titleEl = document.getElementById('col-collage-title-label');
    const metaEl  = document.getElementById('col-collage-meta-label');
    if (titleEl) titleEl.textContent = label;
    if (metaEl)  metaEl.textContent  = `${items.length} item${items.length !== 1 ? 's' : ''} · shareable image`;

    ['grid','spectrum','shape','superfan'].forEach(v => {
        const btn = document.getElementById(`col-variant-${v}`);
        if (btn) btn.classList.toggle('active', v === 'grid');
    });
    const densityPicker = document.getElementById('col-density-picker');
    if (densityPicker) densityPicker.style.display = 'flex'; // 'grid' is the default variant
    ['3x3','6x6','all'].forEach(d => {
        const btn = document.getElementById(`col-density-${d}`);
        if (btn) btn.classList.toggle('active', d === '6x6');
    });
    const shapePicker = document.getElementById('col-shape-picker');
    if (shapePicker) shapePicker.style.display = 'none';
    const brandOnBtn  = document.getElementById('col-branding-on');
    const brandOffBtn = document.getElementById('col-branding-off');
    if (brandOnBtn)  brandOnBtn.classList.add('active');
    if (brandOffBtn) brandOffBtn.classList.remove('active');

    const spinner  = document.getElementById('col-collage-spinner');
    const dlBtn    = document.getElementById('col-collage-download-btn');
    const shareBtn = document.getElementById('col-collage-share-btn');
    if (spinner)  spinner.classList.remove('hidden');
    if (dlBtn)    dlBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;

    const modal = document.getElementById('col-collage-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => modal.classList.add('visible'));
    });

    _loadedImages = await _loadImages(_collageItems);
    await _render(_activeVariant);

    if (dlBtn)    dlBtn.disabled = false;
    if (shareBtn) shareBtn.disabled = false;
};

window._colCloseCollage = () => {
    const modal = document.getElementById('col-collage-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
};

window._colSetCollageVariant = (variant) => {
    _activeVariant = variant;

    ['grid','spectrum','shape','superfan'].forEach(v => {
        const btn = document.getElementById(`col-variant-${v}`);
        if (btn) btn.classList.toggle('active', v === variant);
    });

    const densityPicker = document.getElementById('col-density-picker');
    if (densityPicker) densityPicker.style.display = variant === 'grid' ? 'flex' : 'none';

    const shapePicker = document.getElementById('col-shape-picker');
    if (shapePicker) shapePicker.style.display = variant === 'shape' ? 'flex' : 'none';

    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.remove('hidden');
    requestAnimationFrame(() => {
        _render(variant);
    });
};

window._colSetGridDensity = (density) => {
    if (density !== 'all' && !GRID_DENSITIES[density]) return;
    _activeGridDensity = density;

    ['3x3','6x6','all'].forEach(d => {
        const btn = document.getElementById(`col-density-${d}`);
        if (btn) btn.classList.toggle('active', d === density);
    });

    if (_activeVariant !== 'grid') return;
    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.remove('hidden');
    requestAnimationFrame(() => {
        _render('grid');
    });
};

window._colSetCollageShape = (shape) => {
    if (!_SHAPES[shape]) return;
    _activeShape = shape;

    ['w','star','heart'].forEach(sh => {
        const btn = document.getElementById(`col-shape-${sh}`);
        if (btn) btn.classList.toggle('active', sh === shape);
    });

    if (_activeVariant !== 'shape') return;
    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.remove('hidden');
    requestAnimationFrame(() => {
        _render('shape');
    });
};

/**
 * Toggle the branding bar. Independent of _activeVariant — applies to
 * whichever visual variant is currently showing.
 */
window._colSetBranding = (on) => {
    _brandingOn = !!on;

    const onBtn  = document.getElementById('col-branding-on');
    const offBtn = document.getElementById('col-branding-off');
    if (onBtn)  onBtn.classList.toggle('active', _brandingOn);
    if (offBtn) offBtn.classList.toggle('active', !_brandingOn);

    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.remove('hidden');
    requestAnimationFrame(() => {
        _render(_activeVariant);
    });
};

/**
 * Filename fragment describing the current render config, e.g.
 * "grid-6x6-branded" or "shape-clean" — used by both download and share.
 */
function _variantSlug() {
    const variantPart = _activeVariant === 'grid' ? `grid-${_activeGridDensity}` : _activeVariant;
    return `${variantPart}-${_brandingOn ? 'branded' : 'clean'}`;
}

/**
 * Download the canvas as a PNG file.
 * Filename derived from the collection label, variant, and current date.
 */
window._colCollageDownload = () => {
    if (!_canvasEl) return;
    const slug  = _collageLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const date  = new Date().toISOString().slice(0, 10);
    const fname = `giglist-${slug}-${_variantSlug()}-${date}.png`;

    const link  = document.createElement('a');
    link.download = fname;
    link.href     = _canvasEl.toDataURL('image/png');
    link.click();
};

/**
 * Share the canvas image via the Web Share API (mobile).
 * Falls back silently if the API is not available or share is cancelled.
 */
window._colCollageShare = async () => {
    if (!_canvasEl || !navigator.share) return;

    try {
        const blob = await new Promise(resolve =>
            _canvasEl.toBlob(resolve, 'image/png')
        );
        if (!blob) return;

        const slug  = _collageLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const date  = new Date().toISOString().slice(0, 10);
        const file  = new File([blob], `giglist-${slug}-${_variantSlug()}-${date}.png`, { type: 'image/png' });

        if (navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: `${_collageLabel} — GigList`,
            });
        } else {
            await navigator.share({ title: `${_collageLabel} — GigList` });
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Collage] share failed:', e.message);
    }
};
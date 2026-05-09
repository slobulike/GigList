/**
 * GigList — Collection Collage Module
 * v1.0.0 — May 2026
 *
 * Generates a shareable 1080×1080 canvas collage from a filtered
 * collection drill-down. Three visual variants:
 *   • clean   — pure photo mosaic, black background, no text
 *   • branded — mosaic + footer with title, count, year range, wordmark
 *   • stamp   — mosaic + subtle corner logo watermark only
 *
 * Public API (window helpers):
 *   window._colOpenCollage(items, label)   — open the modal
 *   window._colCloseCollage()              — close and clean up
 *   window._colSetCollageVariant(variant)  — switch variant, re-render
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CANVAS_SIZE   = 1080;   // Output canvas logical size (square)
const CANVAS_SCALE  = 2;      // HiDPI — actual pixel buffer is 2160×2160
const FOOTER_H      = 96;     // Branded footer height (logical px)
const STAMP_SIZE    = 72;     // Stamp watermark bounding box (logical px)
const GRID_GAP      = 6;      // Gap between photo tiles (logical px)
const GOLD          = '#c8a050';
const DARK          = '#111008';
const OFF_WHITE     = '#f0deb0';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _modalEl        = null;
let _canvasEl       = null;
let _activeVariant  = 'branded';   // 'clean' | 'branded' | 'stamp'
let _collageItems   = [];
let _collageLabel   = '';
let _loadedImages   = [];          // Array of { img, item } — resolved HTMLImageElements

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
            .col-variant-btn.active {
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
            <div style="display:flex;gap:0.5rem;padding:0 1.25rem 1rem;">
                <button class="col-variant-btn active" id="col-variant-branded"
                        onclick="window._colSetCollageVariant('branded')">Branded</button>
                <button class="col-variant-btn" id="col-variant-clean"
                        onclick="window._colSetCollageVariant('clean')">Clean</button>
                <button class="col-variant-btn" id="col-variant-stamp"
                        onclick="window._colSetCollageVariant('stamp')">Stamp</button>
            </div>

            <!-- Action buttons -->
            <div style="display:flex;gap:0.75rem;padding:0 1.25rem;">
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

// ─── CANVAS RENDERING ─────────────────────────────────────────────────────────

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
 * Calculate the optimal grid layout (columns × rows) for n items.
 * Prefers square-ish grids; always fits all items.
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
    return { cols: 6, rows: Math.ceil(n / 6) };
}

/**
 * Draw the GigList "GL" monogram / wordmark into a canvas context.
 * Used by both the branded footer and the stamp variant.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x      - centre x (logical)
 * @param {number} y      - centre y (logical)
 * @param {number} size   - bounding box size (logical)
 * @param {'footer'|'stamp'} mode
 * @param {number} scale  - CANVAS_SCALE multiplier
 */
function _drawLogo(ctx, x, y, size, mode, scale) {
    const s  = scale;
    const cx = x * s;
    const cy = y * s;
    const sz = size * s;

    ctx.save();

    if (mode === 'stamp') {
        // Stamp: small pill with "GL" monogram, semi-transparent
        const pw = sz * 1.1, ph = sz * 0.5;
        const px = cx - pw / 2, py = cy - ph / 2;
        const r  = ph / 2;

        ctx.globalAlpha = 0.55;
        ctx.fillStyle   = DARK;
        _roundRect(ctx, px, py, pw, ph, r);
        ctx.fill();

        ctx.strokeStyle = GOLD;
        ctx.lineWidth   = 1 * s;
        ctx.globalAlpha = 0.4;
        _roundRect(ctx, px, py, pw, ph, r);
        ctx.stroke();

        ctx.globalAlpha = 0.8;
        ctx.fillStyle   = GOLD;
        ctx.font        = `900 ${Math.round(sz * 0.32)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = `${1.5 * s}px`;
        ctx.fillText('GIGLIST', cx, cy);
    } else {
        // Footer: inline wordmark — "GIGLIST" in gold + small star
        ctx.globalAlpha  = 1;
        ctx.fillStyle    = GOLD;
        ctx.font         = `900 ${Math.round(sz * 0.42)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = `${2 * s}px`;
        ctx.fillText('GIGLIST', cx, cy);
    }

    ctx.restore();
}

/**
 * Polyfill for ctx.roundRect — not available in all browsers.
 */
function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

/**
 * Core render. Draws onto _canvasEl for the given variant.
 * All coordinates are in logical px; multiplied by CANVAS_SCALE before draw.
 */
function _render(variant) {
    if (!_canvasEl || !_loadedImages.length) return;

    const s       = CANVAS_SCALE;
    const ctx     = _canvasEl.getContext('2d');
    const size    = CANVAS_SIZE;           // logical
    const imgArea = variant === 'branded'  // logical height for photo grid
        ? size - FOOTER_H
        : size;

    // Clear
    ctx.clearRect(0, 0, size * s, size * s);

    // Background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size * s, size * s);

    // ── Grid layout ──────────────────────────────────────────────────────────

    const n = _loadedImages.length;
    const { cols, rows } = _gridLayout(n);

    const gapPx  = GRID_GAP;
    const tileW  = (size - gapPx * (cols + 1)) / cols;
    const tileH  = (imgArea - gapPx * (rows + 1)) / rows;

    _loadedImages.forEach(({ img, item }, idx) => {
        if (idx >= cols * rows) return;  // more items than grid slots — clip

        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const tx  = gapPx + col * (tileW + gapPx);
        const ty  = gapPx + row * (tileH + gapPx);

        if (img) {
            // Photo tile — cover-fit the image into the tile rect
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const scale_w = tileW / iw, scale_h = tileH / ih;
            const fitScale = Math.max(scale_w, scale_h);
            const dw = iw * fitScale, dh = ih * fitScale;
            const ox = (tileW - dw) / 2, oy = (tileH - dh) / 2;

            ctx.save();
            ctx.beginPath();
            ctx.rect(tx * s, ty * s, tileW * s, tileH * s);
            ctx.clip();
            ctx.drawImage(img, (tx + ox) * s, (ty + oy) * s, dw * s, dh * s);
            ctx.restore();
        } else {
            // Colour fallback tile
            ctx.fillStyle = _fallbackColor(item);
            ctx.fillRect(tx * s, ty * s, tileW * s, tileH * s);

            // Subtype icon text centred in tile
            const icon = _SUBTYPE_ICONS[item.subtype] || '✦';
            ctx.font        = `${Math.round(Math.min(tileW, tileH) * 0.35 * s)}px serif`;
            ctx.textAlign   = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(icon, (tx + tileW / 2) * s, (ty + tileH / 2) * s);
        }
    });

    // ── Variant overlays ──────────────────────────────────────────────────────

    if (variant === 'branded') {
        _drawBrandedFooter(ctx, size, imgArea, s);
    } else if (variant === 'stamp') {
        _drawStamp(ctx, size, s);
    }
    // 'clean' — no overlay

    // Hide spinner
    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.add('hidden');
}

/**
 * Branded footer: dark strip across the bottom with title, meta, and wordmark.
 */
function _drawBrandedFooter(ctx, size, imgArea, s) {
    const fy = imgArea;            // logical y where footer starts
    const fh = FOOTER_H;

    // Footer background — solid dark with subtle top border in gold
    ctx.fillStyle = DARK;
    ctx.fillRect(0, fy * s, size * s, fh * s);

    // Top accent line
    ctx.fillStyle = GOLD;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, fy * s, size * s, 1.5 * s);
    ctx.globalAlpha = 1;

    // ── Left: title + meta ───────────────────────────────────────────────────
    const leftX  = 28;
    const midY   = fy + fh / 2;

    // Derive year range from items
    const years = _collageItems
        .map(i => parseInt(i.item_date))
        .filter(y => !isNaN(y));
    const yearStr = years.length
        ? (Math.min(...years) === Math.max(...years)
            ? String(Math.min(...years))
            : `${Math.min(...years)}–${Math.max(...years)}`)
        : '';

    const n     = _collageItems.length;
    const metaParts = [
        `${n} item${n !== 1 ? 's' : ''}`,
        yearStr,
    ].filter(Boolean);

    // Title
    ctx.fillStyle    = '#fff';
    ctx.font         = `900 ${24 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${0.5 * s}px`;

    // Truncate title to avoid overrunning the logo
    const maxTitleW = (size - 160) * s;   // leave room for logo on right
    let titleText   = _collageLabel;
    ctx.font = `900 ${22 * s}px 'Plus Jakarta Sans', sans-serif`;
    while (ctx.measureText(titleText).width > maxTitleW && titleText.length > 4) {
        titleText = titleText.slice(0, -1);
    }
    if (titleText !== _collageLabel) titleText = titleText.trim() + '…';

    ctx.fillText(titleText, leftX * s, (midY - 11) * s);

    // Meta line
    ctx.fillStyle    = GOLD;
    ctx.font         = `700 ${11 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.letterSpacing = `${1.5 * s}px`;
    ctx.fillText(metaParts.join('  ·  ').toUpperCase(), leftX * s, (midY + 13) * s);

    // ── Right: wordmark ───────────────────────────────────────────────────────
    _drawLogo(ctx, size - 72, fy + fh / 2, 28, 'footer', s);
}

/**
 * Stamp variant: small semi-transparent pill in the bottom-right corner.
 */
function _drawStamp(ctx, size, s) {
    const margin = 16;
    const sw     = STAMP_SIZE;
    const sh     = STAMP_SIZE * 0.45;
    const sx     = size - margin - sw;
    const sy     = size - margin - sh;
    _drawLogo(ctx, sx + sw / 2, sy + sh / 2, sw, 'stamp', s);
}

// ─── SUBTYPE ICON MAP (mirrors collection-editor.js) ─────────────────────────

const _SUBTYPE_ICONS = {
    cd: '💿', vinyl: '🖤', tape: '📼', minidisc: '💽',
    apparel: '👕', poster: '🗒', magazine: '🗞', book: '📖',
    tab_book: '🎸', ticket: '🎟', laminate: '🪪', other: '✦',
};

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Open the collage modal for a filtered item set.
 * @param {Array}  items  - filtered collection_items array from the drill-down
 * @param {string} label  - display label, e.g. "CDs" or "All Items"
 */
window._colOpenCollage = async (items, label) => {
    _collageItems  = items || [];
    _collageLabel  = label || 'Collection';
    _activeVariant = 'branded';
    _loadedImages  = [];

    _ensureModal();

    // Update header labels
    const titleEl = document.getElementById('col-collage-title-label');
    const metaEl  = document.getElementById('col-collage-meta-label');
    if (titleEl) titleEl.textContent = label;
    if (metaEl)  metaEl.textContent  = `${items.length} item${items.length !== 1 ? 's' : ''} · shareable image`;

    // Reset variant buttons
    ['branded','clean','stamp'].forEach(v => {
        const btn = document.getElementById(`col-variant-${v}`);
        if (btn) btn.classList.toggle('active', v === 'branded');
    });

    // Show spinner, disable buttons
    const spinner  = document.getElementById('col-collage-spinner');
    const dlBtn    = document.getElementById('col-collage-download-btn');
    const shareBtn = document.getElementById('col-collage-share-btn');
    if (spinner)  spinner.classList.remove('hidden');
    if (dlBtn)    dlBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;

    // Animate in
    const modal = document.getElementById('col-collage-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => modal.classList.add('visible'));
    });

    // Load images in background, then render
    _loadedImages = await _loadImages(_collageItems);
    _render(_activeVariant);

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

    // Update button states
    ['branded','clean','stamp'].forEach(v => {
        const btn = document.getElementById(`col-variant-${v}`);
        if (btn) btn.classList.toggle('active', v === variant);
    });

    // Show spinner briefly for perceived responsiveness, then re-render
    const spinner = document.getElementById('col-collage-spinner');
    if (spinner) spinner.classList.remove('hidden');
    requestAnimationFrame(() => {
        _render(variant);
    });
};

/**
 * Download the canvas as a PNG file.
 * Filename derived from the collection label and current date.
 */
window._colCollageDownload = () => {
    if (!_canvasEl) return;
    const slug  = _collageLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const date  = new Date().toISOString().slice(0, 10);
    const fname = `giglist-${slug}-${date}.png`;

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
        const file  = new File([blob], `giglist-${slug}-${date}.png`, { type: 'image/png' });

        if (navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: `${_collageLabel} — GigList`,
            });
        } else {
            // Fallback: share URL-only if file share not supported
            await navigator.share({ title: `${_collageLabel} — GigList` });
        }
    } catch (e) {
        // User cancelled or share failed — no toast needed
        if (e.name !== 'AbortError') console.warn('[Collage] share failed:', e.message);
    }
};
/**
 * GigList — Weezer Wednesday Canvas
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a shareable 1200×630 Discord-optimised image when a user taps a
 * Weezer Wednesday push notification.
 *
 * Public API:
 *   window.openWeezerWednesdayCanvas(journalKey)  — open the modal
 *   window.closeWeezerWednesdayCanvas()           — close and clean up
 *
 * Called from:
 *   gig-modal-patch.js → openGigModal() when options.weezerWednesday === true
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const WW_W      = 1200;   // logical canvas width  (Discord-optimised landscape)
const WW_H      = 630;    // logical canvas height
const WW_SCALE  = 2;      // HiDPI — actual buffer is 2400×1260

const WW_BLUE   = '#189BCC';   // Weezer blue — matches band page accent
const WW_DARK   = '#0a0a0a';
const WW_WHITE  = '#ffffff';
const WW_DIM    = 'rgba(0,0,0,0.62)';   // overlay on top of bg image

// ─── STATE ───────────────────────────────────────────────────────────────────

let _wwModal    = null;
let _wwCanvas   = null;
let _wwEntry    = null;   // the resolved journalData row

// ─── MODAL SCAFFOLD ───────────────────────────────────────────────────────────

function _ensureWWModal() {
    if (document.getElementById('ww-modal')) return;

    const el = document.createElement('div');
    el.id = 'ww-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Weezer Wednesday share card');

    el.innerHTML = `
        <style>
            #ww-modal {
                position: fixed;
                inset: 0;
                z-index: 600;
                background: rgba(0,0,0,0.88);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: flex-end;
                padding-bottom: env(safe-area-inset-bottom, 0px);
                opacity: 0;
                transition: opacity 0.25s ease;
            }
            #ww-modal.visible { opacity: 1; }

            #ww-sheet {
                background: #0f0f0f;
                border-top: 2px solid ${WW_BLUE};
                border-radius: 2rem 2rem 0 0;
                width: 100%;
                max-width: 28rem;
                max-height: 92dvh;
                overflow-y: auto;
                transform: translateY(40px);
                transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                padding-bottom: 2rem;
            }
            #ww-modal.visible #ww-sheet { transform: translateY(0); }

            #ww-canvas-wrap {
                margin: 0 1.25rem 1rem;
                border-radius: 0.875rem;
                overflow: hidden;
                /* 1200:630 ≈ 40:21 */
                aspect-ratio: 40 / 21;
                background: #000;
                position: relative;
                box-shadow: 0 8px 40px rgba(24,155,204,0.2);
            }
            #ww-canvas {
                width: 100%;
                height: 100%;
                display: block;
            }
            #ww-spinner {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #0a0a0a;
                transition: opacity 0.3s ease;
            }
            #ww-spinner.hidden { opacity: 0; pointer-events: none; }
            .ww-spinner-ring {
                width: 32px; height: 32px;
                border: 3px solid rgba(24,155,204,0.2);
                border-top-color: ${WW_BLUE};
                border-radius: 50%;
                animation: ww-spin 0.8s linear infinite;
            }
            @keyframes ww-spin { to { transform: rotate(360deg); } }

            .ww-action-btn {
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
            .ww-action-btn:active { transform: scale(0.97); }
            .ww-action-btn.primary  { background: ${WW_BLUE}; color: #fff; }
            .ww-action-btn.secondary {
                background: rgba(255,255,255,0.07);
                color: rgba(255,255,255,0.7);
            }
            .ww-action-btn:disabled { opacity: 0.4; pointer-events: none; }
        </style>

        <div id="ww-sheet" onclick="event.stopPropagation()">

            <!-- Handle + header -->
            <div style="padding:1rem 1.25rem 0.75rem;display:flex;align-items:center;justify-content:space-between;">
                <div style="width:2.25rem;height:0.25rem;background:rgba(255,255,255,0.12);border-radius:9999px;margin:0 auto;"></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem 1rem;">
                <div>
                    <p style="font-size:15px;font-weight:900;color:#fff;line-height:1.1;">
                        🎸 Weezer Wednesday
                    </p>
                    <p style="font-size:10px;font-weight:700;color:${WW_BLUE};margin-top:3px;text-transform:uppercase;letter-spacing:0.1em;">
                        Share to Discord
                    </p>
                </div>
                <button onclick="window.closeWeezerWednesdayCanvas()"
                        aria-label="Close"
                        style="width:2.25rem;height:2.25rem;border-radius:0.75rem;
                               background:rgba(255,255,255,0.08);border:none;
                               color:rgba(255,255,255,0.5);cursor:pointer;
                               display:flex;align-items:center;justify-content:center;font-size:16px;">
                    ✕
                </button>
            </div>

            <!-- Canvas preview -->
            <div id="ww-canvas-wrap">
                <canvas id="ww-canvas"
                        width="${WW_W * WW_SCALE}"
                        height="${WW_H * WW_SCALE}"></canvas>
                <div id="ww-spinner">
                    <div class="ww-spinner-ring"></div>
                </div>
            </div>

            <!-- Action buttons -->
            <div style="display:flex;gap:0.75rem;padding:0.25rem 1.25rem 0;">
                <button id="ww-share-btn"
                        class="ww-action-btn secondary"
                        onclick="window._wwShare()"
                        style="display:none;" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                        <polyline points="16 6 12 2 8 6"/>
                        <line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    Share
                </button>
                <button id="ww-download-btn"
                        class="ww-action-btn primary"
                        onclick="window._wwDownload()" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Save Image
                </button>
            </div>

        </div>
    `;

    el.addEventListener('click', (e) => {
        if (e.target === el) window.closeWeezerWednesdayCanvas();
    });

    document.body.appendChild(el);
    _wwModal  = el;
    _wwCanvas = document.getElementById('ww-canvas');

    if (navigator.share && navigator.canShare) {
        document.getElementById('ww-share-btn').style.display = 'flex';
    }
}

// ─── IMAGE LOADING ────────────────────────────────────────────────────────────

function _loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// ─── CANVAS RENDER ────────────────────────────────────────────────────────────

/**
 * Draw the full Weezer Wednesday card.
 *
 * Layout (1200×630 logical, ×2 for HiDPI):
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │  [Spotify bg image, blurred + dark overlay]        │
 *   │                                                    │
 *   │  WEEZER WEDNESDAY          ← Barlow Condensed      │
 *   │  italic, Weezer blue,                              │
 *   │  top-left                                          │
 *   │                                                    │
 *   │  [Artist name]             ← large white           │
 *   │  [Venue]  ·  [Year]        ← subdued               │
 *   │                                                    │
 *   │  [blue left stripe, 8px]                           │
 *   │                                          GIGLIST ▸ │
 *   └────────────────────────────────────────────────────┘
 */
async function _renderWW(entry) {
    if (!_wwCanvas) return;

    const s   = WW_SCALE;
    const W   = WW_W;
    const H   = WW_H;
    const ctx = _wwCanvas.getContext('2d');

    // Clear
    ctx.clearRect(0, 0, W * s, H * s);
    ctx.fillStyle = WW_DARK;
    ctx.fillRect(0, 0, W * s, H * s);

    // ── Background image (Spotify artist image) ──────────────────────────────
    const bgUrl = entry?.SpotifyImageUrl || entry?.spotify_image_url || null;
    if (bgUrl) {
        const bgImg = await _loadImage(bgUrl);
        if (bgImg) {
            // Cover-fit, right-aligned (face usually centre-right in Spotify images)
            const iw = bgImg.naturalWidth, ih = bgImg.naturalHeight;
            const fitScale = Math.max(W / iw, H / ih);
            const dw = iw * fitScale, dh = ih * fitScale;
            // Anchor right edge
            const ox = W - dw, oy = (H - dh) / 2;

            ctx.save();
            ctx.filter = 'blur(0px)';   // no blur — let the overlay do the work
            ctx.globalAlpha = 0.38;
            ctx.drawImage(bgImg, ox * s, oy * s, dw * s, dh * s);
            ctx.restore();
        }
    }

    // ── Dark gradient overlay ─────────────────────────────────────────────────
    // Strong on the left (text side), fading right
    const grad = ctx.createLinearGradient(0, 0, W * s, 0);
    grad.addColorStop(0,    'rgba(10,10,10,0.97)');
    grad.addColorStop(0.55, 'rgba(10,10,10,0.82)');
    grad.addColorStop(1,    'rgba(10,10,10,0.45)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W * s, H * s);

    // ── Left blue stripe ─────────────────────────────────────────────────────
    ctx.fillStyle = WW_BLUE;
    ctx.fillRect(0, 0, 8 * s, H * s);

    // ── Text content ─────────────────────────────────────────────────────────
    const padL = 52;   // left text margin (after stripe + breathing room)
    const padT = 52;

    // "WEEZER WEDNESDAY" — Barlow Condensed italic, Weezer blue
    // Barlow Condensed isn't guaranteed loaded on the canvas context, so we
    // specify a condensed system fallback chain. The font is already loaded
    // on the page via Google Fonts so it will be available in practice.
    ctx.save();
    ctx.fillStyle    = WW_BLUE;
    ctx.font         = `italic 900 ${38 * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${3 * s}px`;
    ctx.fillText('WEEZER WEDNESDAY', padL * s, padT * s);
    ctx.restore();

    // Artist name — large white
    const artist = entry?.Band || entry?.band || 'Weezer';
    ctx.save();
    ctx.fillStyle    = WW_WHITE;
    ctx.font         = `900 ${72 * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${1 * s}px`;

    // Truncate if somehow very long
    let artistText = artist.toUpperCase();
    const maxArtistW = (W - padL - 60) * s;
    while (ctx.measureText(artistText).width > maxArtistW && artistText.length > 2) {
        artistText = artistText.slice(0, -1);
    }
    if (artistText !== artist.toUpperCase()) artistText = artistText.trim() + '…';
    ctx.fillText(artistText, padL * s, (padT + 52) * s);
    ctx.restore();

    // Venue · Year — subdued
    const venue = entry?.OfficialVenue || entry?.official_venue || entry?.venue || '';
    const rawDate = entry?.Date || entry?.date || '';
    const year = _extractYear(rawDate);
    const venueLine = [venue, year].filter(Boolean).join('  ·  ');

    if (venueLine) {
        ctx.save();
        ctx.fillStyle    = 'rgba(255,255,255,0.55)';
        ctx.font         = `600 ${22 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${0.5 * s}px`;

        // Truncate venue line
        let venueText = venueLine;
        const maxVenueW = (W - padL - 60) * s;
        ctx.font = `600 ${22 * s}px 'Plus Jakarta Sans', sans-serif`;
        while (ctx.measureText(venueText).width > maxVenueW && venueText.length > 4) {
            venueText = venueText.slice(0, -1);
        }
        if (venueText !== venueLine) venueText = venueText.trim() + '…';

        ctx.fillText(venueText, padL * s, (padT + 140) * s);
        ctx.restore();
    }

    // ── Gig List wordmark — bottom right ─────────────────────────────────────
    const wmarkR = W - 32;
    const wmarkY = H - 36;

    ctx.save();
    ctx.fillStyle    = WW_BLUE;
    ctx.globalAlpha  = 0.9;
    ctx.font         = `900 ${14 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('GIG LIST', wmarkR * s, wmarkY * s);
    ctx.restore();

    // Small blue dot before wordmark
    ctx.save();
    ctx.fillStyle   = WW_BLUE;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    const dotX = (wmarkR - ctx.measureText('GIG LIST') / s - 12);
    // simpler: just draw a guitar emoji as a tiny icon
    ctx.font = `${13 * s}px serif`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha  = 0.7;
    ctx.fillText('🎸', (wmarkR - 66) * s, wmarkY * s);
    ctx.restore();

    // ── Hide spinner, enable buttons ─────────────────────────────────────────
    const spinner = document.getElementById('ww-spinner');
    if (spinner) spinner.classList.add('hidden');
    const dlBtn    = document.getElementById('ww-download-btn');
    const shareBtn = document.getElementById('ww-share-btn');
    if (dlBtn)    dlBtn.disabled = false;
    if (shareBtn) shareBtn.disabled = false;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _extractYear(dateStr) {
    if (!dateStr || dateStr === 'nan') return '';
    // DD/MM/YYYY
    const parts = dateStr.split('/');
    if (parts.length === 3) return parts[2];
    // YYYY-MM-DD
    if (dateStr.length >= 4) return dateStr.slice(0, 4);
    return '';
}

function _slug(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Open the Weezer Wednesday modal for a given journal key.
 * Called by openGigModal() in gig-modal-patch.js when weezerWednesday === true.
 *
 * @param {string} journalKey  — the Journal Key / journal_key for the gig
 */
window.openWeezerWednesdayCanvas = async (journalKey) => {
    // Resolve the journal entry from window.journalData
    const entry = (window.journalData || []).find(g =>
        (g['Journal Key'] || g.journal_key) === journalKey
    );

    if (!entry) {
        console.warn('[WeezerWednesday] journal entry not found for key:', journalKey);
        return;
    }

    _wwEntry = entry;

    _ensureWWModal();

    // Reset spinner + disable buttons
    const spinner = document.getElementById('ww-spinner');
    const dlBtn   = document.getElementById('ww-download-btn');
    const shareBtn = document.getElementById('ww-share-btn');
    if (spinner)  spinner.classList.remove('hidden');
    if (dlBtn)    dlBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;

    // Animate modal in
    const modal = document.getElementById('ww-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('visible')));

    // Render canvas
    await _renderWW(entry);
};

window.closeWeezerWednesdayCanvas = () => {
    const modal = document.getElementById('ww-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
};

/**
 * Download the canvas as a PNG.
 */
window._wwDownload = () => {
    if (!_wwCanvas) return;
    const artist = _wwEntry?.Band || _wwEntry?.band || 'weezer';
    const year   = _extractYear(_wwEntry?.Date || _wwEntry?.date || '');
    const fname  = `giglist-weezer-wednesday-${_slug(artist)}-${year || new Date().getFullYear()}.png`;
    const link   = document.createElement('a');
    link.download = fname;
    link.href     = _wwCanvas.toDataURL('image/png');
    link.click();
};

/**
 * Share the canvas image via Web Share API.
 */
window._wwShare = async () => {
    if (!_wwCanvas || !navigator.share) return;
    try {
        const blob = await new Promise(resolve => _wwCanvas.toBlob(resolve, 'image/png'));
        if (!blob) return;

        const artist = _wwEntry?.Band || _wwEntry?.band || 'weezer';
        const year   = _extractYear(_wwEntry?.Date || _wwEntry?.date || '');
        const fname  = `giglist-weezer-wednesday-${_slug(artist)}-${year || new Date().getFullYear()}.png`;
        const file   = new File([blob], fname, { type: 'image/png' });

        if (navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: `Weezer Wednesday 🎸 — Gig List`,
            });
        } else {
            await navigator.share({ title: `Weezer Wednesday 🎸 — Gig List` });
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[WeezerWednesday] share failed:', e.message);
    }
};
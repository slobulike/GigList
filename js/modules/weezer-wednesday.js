/**
 * GigList — Weezer Wednesday Canvas
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a shareable 1200×630 Discord-optimised image when a user taps a
 * Weezer Wednesday push notification.
 *
 * Layout: two-column
 *   LEFT  (420px)  — dark panel: headline, artist, venue/year, wordmark
 *   RIGHT (780px)  — Spotify artist image + setlist overlay (journal)
 *                                          OR collector's card (collection)
 *
 * Public API:
 *   window.openWeezerWednesdayCanvas(journalKey)
 *   window.openWeezerWednesdayCanvasCollection(collectionId)
 *   window.closeWeezerWednesdayCanvas()
 *
 * Journal path: called from openGigModal() in gig-modal-patch.js when
 *   weezerWednesday===true.
 * Collection path: called from deep-link.js when source==='collection'.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const WW_W        = 1200;
const WW_H        = 630;
const WW_SCALE    = 2;          // HiDPI — actual buffer 2400×1260

const WW_SPLIT    = 420;        // x where left panel ends / right panel begins
const WW_BLUE     = '#189BCC';
const WW_DARK     = '#0a0a0a';
const WW_WHITE    = '#ffffff';
const MAX_TRACKS  = 18;         // max setlist rows to render in the right panel

// ─── STATE ───────────────────────────────────────────────────────────────────

let _wwModal  = null;
let _wwCanvas = null;
let _wwEntry  = null;
let _wwSource = 'journal'; // 'journal' | 'collection'

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
                position: fixed; inset: 0; z-index: 600;
                background: rgba(0,0,0,0.88);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                display: flex; flex-direction: column;
                align-items: center; justify-content: flex-end;
                padding-bottom: env(safe-area-inset-bottom, 0px);
                opacity: 0; transition: opacity 0.25s ease;
            }
            #ww-modal.visible { opacity: 1; }
            #ww-sheet {
                background: #0f0f0f;
                border-top: 2px solid ${WW_BLUE};
                border-radius: 2rem 2rem 0 0;
                width: 100%; max-width: 28rem; max-height: 92dvh;
                overflow-y: auto;
                transform: translateY(40px);
                transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1);
                padding-bottom: 2rem;
            }
            #ww-modal.visible #ww-sheet { transform: translateY(0); }
            #ww-canvas-wrap {
                margin: 0 1.25rem 1rem;
                border-radius: 0.875rem; overflow: hidden;
                aspect-ratio: 40/21; background: #000;
                position: relative;
                box-shadow: 0 8px 40px rgba(24,155,204,0.2);
            }
            #ww-canvas { width: 100%; height: 100%; display: block; }
            #ww-spinner {
                position: absolute; inset: 0;
                display: flex; align-items: center; justify-content: center;
                background: #0a0a0a; transition: opacity 0.3s ease;
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
                flex: 1; display: flex; align-items: center;
                justify-content: center; gap: 0.5rem;
                padding: 0.875rem 0; font-size: 11px; font-weight: 900;
                letter-spacing: 0.08em; text-transform: uppercase;
                border-radius: 1rem; cursor: pointer; border: none;
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
            <div style="padding:1rem 1.25rem 0.75rem;">
                <div style="width:2.25rem;height:0.25rem;background:rgba(255,255,255,0.12);border-radius:9999px;margin:0 auto;"></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0 1.25rem 1rem;">
                <div>
                    <p style="font-size:15px;font-weight:900;color:#fff;line-height:1.1;">🎸 Weezer Wednesday</p>
                    <p style="font-size:10px;font-weight:700;color:${WW_BLUE};margin-top:3px;text-transform:uppercase;letter-spacing:0.1em;">Share to Discord</p>
                </div>
                <button onclick="window.closeWeezerWednesdayCanvas()" aria-label="Close"
                        style="width:2.25rem;height:2.25rem;border-radius:0.75rem;background:rgba(255,255,255,0.08);
                               border:none;color:rgba(255,255,255,0.5);cursor:pointer;
                               display:flex;align-items:center;justify-content:center;font-size:16px;">✕</button>
            </div>
            <div id="ww-canvas-wrap">
                <canvas id="ww-canvas" width="${WW_W * WW_SCALE}" height="${WW_H * WW_SCALE}"></canvas>
                <div id="ww-spinner"><div class="ww-spinner-ring"></div></div>
            </div>
            <div style="display:flex;gap:0.75rem;padding:0.25rem 1.25rem 0;">
                <button id="ww-share-btn" class="ww-action-btn secondary"
                        onclick="window._wwShare()" style="display:none;" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                        <polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    Share
                </button>
                <button id="ww-download-btn" class="ww-action-btn primary"
                        onclick="window._wwDownload()" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Save Image
                </button>
            </div>
        </div>
    `;

    el.addEventListener('click', (e) => { if (e.target === el) window.closeWeezerWednesdayCanvas(); });
    document.body.appendChild(el);
    _wwModal  = el;
    _wwCanvas = document.getElementById('ww-canvas');
    if (navigator.share && navigator.canShare) {
        document.getElementById('ww-share-btn').style.display = 'flex';
    }
}

// ─── SETLIST RESOLVER ─────────────────────────────────────────────────────────

/**
 * Get parsed setlist tracks for a journal entry.
 * Checks window.performanceData first (already loaded for this gig if the
 * modal was opened). Falls back to a direct Supabase fetch if not in memory.
 * Returns an array of track name strings, capped at MAX_TRACKS.
 */
async function _resolveSetlist(entry) {
    const key  = entry?.['Journal Key'] || entry?.journal_key;
    const band = entry?.Band || entry?.band || '';

    // 1. Try performanceData already in memory
    //    Match on journal_key AND artist — a journal entry can have multiple
    //    performances rows (headliner + openers) sharing the same journal_key,
    //    so journal_key alone isn't unique. This mirrors openGigModal's
    //    headlineSet lookup in ui.js.
    const perf = (window.performanceData || []).find(p =>
        (p['Journal Key'] || p.journal_key) === key &&
        (p.Artist || p.artist || '').toLowerCase() === band.toLowerCase()
    );
    const raw = perf?.setlist || perf?.Setlist || null;
    if (raw) return _parseTracks(raw);

    // 2. Not in memory — fetch directly from Supabase
    try {
        const { data } = await window.supabase
            .from('performances')
            .select('setlist')
            .eq('journal_key', key)
            .eq('artist', band)
            .maybeSingle();
        if (data?.setlist) return _parseTracks(data.setlist);
    } catch (err) {
        console.warn('[WeezerWednesday] setlist fetch failed:', err);
    }

    return [];
}

function _parseTracks(raw) {
    return raw.split('|').map(t => t.trim()).filter(Boolean).slice(0, MAX_TRACKS);
}

// ─── COLLECTION RESOLVER ──────────────────────────────────────────────────────

/**
 * Fetch a collection item by UUID.
 * Artist image is fetched via a second query because PostgREST implicit joins
 * require a declared FK relationship — this avoids that dependency.
 * Item photo (photos[0]) is used as background first; artist image is fallback.
 * Returns a normalised entry object shaped for _renderWW, or null on failure.
 */
async function _resolveCollectionEntry(collectionId) {
    try {
        const { data, error } = await window.supabase
            .from('collection_items')
            .select('id, title, type, subtype, format, item_date, acquired_date, condition, band_name, artist_id, photos')
            .eq('id', collectionId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        // Generate a short-lived signed URL for the item photo.
        // collection-photos is a private bucket — public URLs 404.
        // 120s TTL is enough to load and render the canvas.
        const photoPath = Array.isArray(data.photos) ? data.photos[0] : null;
        let itemPhotoUrl = null;
        if (photoPath) {
            try {
                const { data: signed } = await window.supabase.storage
                    .from('collection-photos')
                    .createSignedUrl(photoPath, 120);
                itemPhotoUrl = signed?.signedUrl || null;
            } catch (signErr) {
                console.warn('[WeezerWednesday] signed URL failed:', signErr);
            }
        }

        // Fetch artist spotify image — try artist_id first, fall back to band_name lookup
        let spotifyImageUrl = null;
        if (data.artist_id) {
            const { data: artist } = await window.supabase
                .from('artists')
                .select('name, spotify_image_url')
                .eq('id', data.artist_id)
                .maybeSingle();
            spotifyImageUrl = artist?.spotify_image_url || null;
            console.log('[WeezerWednesday] artist by id:', artist?.name, '| image:', spotifyImageUrl ? 'found' : 'null');
        }
        if (!spotifyImageUrl && data.band_name) {
            const { data: artist } = await window.supabase
                .from('artists')
                .select('spotify_image_url')
                .ilike('name', data.band_name)
                .maybeSingle();
            spotifyImageUrl = artist?.spotify_image_url || null;
            console.log('[WeezerWednesday] artist by band_name fallback:', data.band_name, '| image:', spotifyImageUrl ? 'found' : 'null');
        }

        return {
            Band: data.band_name || 'Weezer',
            // Background: artist Spotify image at low opacity (atmospheric only).
            // Item photo is rendered as a framed prop in the right panel.
            spotify_image_url: spotifyImageUrl || null,
            _collection: {
                title:         data.title         || null,
                subtype:       data.subtype       || null,  // type intentionally omitted from display
                format:        data.format        || null,
                item_date:     data.item_date     || null,
                acquired_date: data.acquired_date || null,
                condition:     data.condition     || null,
                itemPhotoUrl:  itemPhotoUrl       || null,  // signed URL for framed prop
            },
        };
    } catch (err) {
        console.warn('[WeezerWednesday] collection fetch failed:', err);
        return null;
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
 * Two-column layout:
 *
 *  0        420                              1200
 *  ┌─────────┬──────────────────────────────────┐
 *  │▌        │  [Artist image, full bleed]       │
 *  │ WEEZER  │  [Dark gradient from left edge]   │
 *  │WEDNESDAY│                                   │
 *  │         │  SETLIST (journal)                │
 *  │ WEEZER  │  01  My Name Is Jonas             │
 *  │         │  02  Undone — The Sweater Song    │
 *  │ Brixton │  ...                              │
 *  │ 2011    │                                   │
 *  │         │  COLLECTION (collection)          │
 *  │ GIG LIST│  Blue Album                       │
 *  │         │  Album · Studio · Vinyl           │
 *  │         │  RELEASED  1994                   │
 *  │         │  ADDED     12 January 2023        │
 *  │         │  CONDITION Mint                   │
 *  └─────────┴──────────────────────────────────┘
 *
 * @param {object} entry   - normalised journal or collection entry
 * @param {Array}  tracks  - setlist track strings (journal path only)
 * @param {string} source  - 'journal' | 'collection'
 */
async function _renderWW(entry, tracks, source = 'journal') {
    if (!_wwCanvas) return;

    const s   = WW_SCALE;
    const W   = WW_W;
    const H   = WW_H;
    const SP  = WW_SPLIT;
    const ctx = _wwCanvas.getContext('2d');

    ctx.clearRect(0, 0, W * s, H * s);

    // ── RIGHT PANEL: artist image ─────────────────────────────────────────────
    // Draw first so the left panel sits on top

    ctx.fillStyle = '#111';
    ctx.fillRect(SP * s, 0, (W - SP) * s, H * s);

    const bgUrl = entry?.SpotifyImageUrl || entry?.spotify_image_url || null;
    if (bgUrl) {
        const bgImg = await _loadImage(bgUrl);
        if (bgImg) {
            const iw = bgImg.naturalWidth, ih = bgImg.naturalHeight;
            const rw = W - SP;
            const fitScale = Math.max(rw / iw, H / ih);
            const dw = iw * fitScale, dh = ih * fitScale;
            const ox = SP + (rw - dw) / 2;
            const oy = (H - dh) / 2;

            ctx.save();
            // For collection, the item photo is rendered as a framed prop below.
            // The Spotify artist image sits here as subtle atmosphere only.
            // For journal, full atmospheric treatment at higher opacity.
            ctx.globalAlpha = source === 'collection' ? 0.22 : 0.72;
            ctx.drawImage(bgImg, ox * s, oy * s, dw * s, dh * s);
            ctx.restore();
        }
    }

    // Gradient over right panel: dark from left edge, transparent to right
    const rightGrad = ctx.createLinearGradient(SP * s, 0, W * s, 0);
    rightGrad.addColorStop(0,    'rgba(10,10,10,0.92)');
    rightGrad.addColorStop(0.35, 'rgba(10,10,10,0.65)');
    rightGrad.addColorStop(1,    'rgba(10,10,10,0.15)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(SP * s, 0, (W - SP) * s, H * s);

    // ── RIGHT PANEL CONTENT ───────────────────────────────────────────────────

    if (source === 'collection') {
        await _renderCollectionPanel(ctx, entry, s, SP, W, H);
    } else {
        _renderSetlistPanel(ctx, tracks, s, SP, W, H);
    }

    // ── LEFT PANEL: solid dark background ────────────────────────────────────
    ctx.fillStyle = WW_DARK;
    ctx.fillRect(0, 0, SP * s, H * s);

    // Subtle right-edge feather so the left panel blends into the image
    const leftEdgeGrad = ctx.createLinearGradient((SP - 40) * s, 0, SP * s, 0);
    leftEdgeGrad.addColorStop(0, 'rgba(10,10,10,1)');
    leftEdgeGrad.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = leftEdgeGrad;
    ctx.fillRect((SP - 40) * s, 0, 40 * s, H * s);

    // ── Blue left stripe ──────────────────────────────────────────────────────
    ctx.fillStyle = WW_BLUE;
    ctx.fillRect(0, 0, 7 * s, H * s);

    // ── Left panel text ───────────────────────────────────────────────────────
    const padL = 28;
    const padT = 48;

    // "WEEZER WEDNESDAY"
    ctx.save();
    ctx.fillStyle    = WW_BLUE;
    ctx.font         = `italic 900 ${26 * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${2 * s}px`;
    ctx.fillText('WEEZER',    padL * s, padT * s);
    ctx.fillText('WEDNESDAY', padL * s, (padT + 32) * s);
    ctx.restore();

    // Divider rule
    ctx.save();
    ctx.fillStyle   = WW_BLUE;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(padL * s, (padT + 68) * s, (SP - padL * 2) * s, 1.5 * s);
    ctx.restore();

    // Artist name
    const artist = entry?.Band || entry?.band || 'Weezer';
    ctx.save();
    ctx.fillStyle    = WW_WHITE;
    ctx.font         = `900 ${44 * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${1 * s}px`;

    const maxLW = (SP - padL - 16) * s;
    let artistText = artist.toUpperCase();
    const words = artistText.split(' ');
    if (words.length > 1 && ctx.measureText(artistText).width > maxLW) {
        const mid = Math.ceil(words.length / 2);
        ctx.fillText(words.slice(0, mid).join(' '), padL * s, (padT + 78) * s);
        ctx.fillText(words.slice(mid).join(' '),    padL * s, (padT + 124) * s);
    } else {
        let sz = 44;
        while (ctx.measureText(artistText).width > maxLW && sz > 20) {
            sz -= 2;
            ctx.font = `900 ${sz * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
        }
        ctx.fillText(artistText, padL * s, (padT + 78) * s);
    }
    ctx.restore();

    // Venue + date (journal only)
    if (source === 'journal') {
        const venue = entry?.OfficialVenue || entry?.official_venue || entry?.venue || '';
        if (venue) {
            ctx.save();
            ctx.fillStyle    = 'rgba(255,255,255,0.6)';
            ctx.font         = `600 ${13 * s}px 'Plus Jakarta Sans', sans-serif`;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'top';
            ctx.letterSpacing = `${0.3 * s}px`;
            let venueText = venue;
            while (ctx.measureText(venueText).width > maxLW && venueText.length > 4) {
                venueText = venueText.slice(0, -1);
            }
            if (venueText !== venue) venueText = venueText.trim() + '…';
            ctx.fillText(venueText, padL * s, (padT + 178) * s);
            ctx.restore();
        }

        const rawDate = entry?.Date || entry?.date || '';
        const dateFormatted = _formatDate(rawDate);
        if (dateFormatted) {
            ctx.save();
            ctx.fillStyle    = WW_BLUE;
            ctx.globalAlpha  = 0.85;
            ctx.font         = `700 ${12 * s}px 'Plus Jakarta Sans', sans-serif`;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'top';
            ctx.letterSpacing = `${0.5 * s}px`;
            ctx.fillText(dateFormatted.toUpperCase(), padL * s, (padT + 200) * s);
            ctx.restore();
        }
    }

    // ── Wordmark — bottom of left panel ──────────────────────────────────────
    ctx.save();
    ctx.fillStyle    = 'rgba(255,255,255,0.25)';
    ctx.font         = `900 ${11 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.letterSpacing = `${2.5 * s}px`;
    ctx.fillText('🎸 GIG LIST', padL * s, (H - 28) * s);
    ctx.restore();

    // ── Spinner off, buttons on ───────────────────────────────────────────────
    const spinner = document.getElementById('ww-spinner');
    if (spinner) spinner.classList.add('hidden');
    const dlBtn    = document.getElementById('ww-download-btn');
    const shareBtn = document.getElementById('ww-share-btn');
    if (dlBtn)    dlBtn.disabled = false;
    if (shareBtn) shareBtn.disabled = false;
}

// ─── RIGHT PANEL: SETLIST (journal) ───────────────────────────────────────────

function _renderSetlistPanel(ctx, tracks, s, SP, W, H) {
    if (tracks.length === 0) return;

    const listX    = SP + 36;
    const listTopY = 52;
    const lineH    = (H - listTopY - 48) / MAX_TRACKS;
    const numW     = 28;

    // "SETLIST" label
    ctx.save();
    ctx.fillStyle    = WW_BLUE;
    ctx.globalAlpha  = 0.7;
    ctx.font         = `800 ${10 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${2 * s}px`;
    ctx.fillText('SETLIST', listX * s, listTopY * s);
    ctx.restore();

    // Thin blue rule
    ctx.save();
    ctx.fillStyle   = WW_BLUE;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(listX * s, (listTopY + 16) * s, 200 * s, 1 * s);
    ctx.restore();

    const trackStartY = listTopY + 26;
    const maxTrackW   = (W - listX - numW - 32) * s;

    tracks.forEach((track, i) => {
        const y = trackStartY + i * lineH;

        // Track number
        ctx.save();
        ctx.fillStyle    = WW_BLUE;
        ctx.globalAlpha  = 0.55;
        ctx.font         = `700 ${9 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = `${0.5 * s}px`;
        ctx.fillText(String(i + 1).padStart(2, '0'), (listX + numW - 6) * s, (y + lineH / 2) * s);
        ctx.restore();

        // Track name
        ctx.save();
        ctx.fillStyle    = 'rgba(255,255,255,0.88)';
        ctx.font         = `600 ${11.5 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = `${0.2 * s}px`;

        let trackText = track;
        while (ctx.measureText(trackText).width > maxTrackW && trackText.length > 3) {
            trackText = trackText.slice(0, -1);
        }
        if (trackText !== track) trackText = trackText.trim() + '…';

        ctx.fillText(trackText, (listX + numW) * s, (y + lineH / 2) * s);
        ctx.restore();
    });

    // "+ N more" overflow indicator
    if (window._wwTotalTracks && window._wwTotalTracks > MAX_TRACKS) {
        const moreY = trackStartY + MAX_TRACKS * lineH + 4;
        ctx.save();
        ctx.fillStyle    = WW_BLUE;
        ctx.globalAlpha  = 0.6;
        ctx.font         = `700 ${10 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${1 * s}px`;
        ctx.fillText(`+ ${window._wwTotalTracks - MAX_TRACKS} MORE`, (listX + numW) * s, moreY * s);
        ctx.restore();
    }
}

// ─── RIGHT PANEL: COLLECTOR'S CARD (collection) ───────────────────────────────

/**
 * Renders collection metadata onto the right panel.
 *
 * Layout (top-to-bottom, left side of right panel):
 *   COLLECTION label + rule
 *   title (large Barlow Condensed)
 *   subtype · format (subdued)
 *   RELEASED / ADDED / CONDITION — stacked two-line rows (label above value)
 *
 * Item photo rendered as an angled framed prop, lower-right of the panel.
 * All fields optional — absent values leave no gap.
 */
async function _renderCollectionPanel(ctx, entry, s, SP, W, H) {
    const col = entry?._collection;
    if (!col) return;

    const listX  = SP + 36;
    const startY = 52;
    // Right boundary for text — leaves room for the photo prop
    const textMaxX = SP + (W - SP) * 0.52; // text occupies left ~52% of right panel
    const maxW     = (textMaxX - listX) * s;

    // ── COLLECTION section label ────────────────────────────────────────────
    ctx.save();
    ctx.fillStyle    = WW_BLUE;
    ctx.globalAlpha  = 0.7;
    ctx.font         = `800 ${10 * s}px 'Plus Jakarta Sans', sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = `${2 * s}px`;
    ctx.fillText('COLLECTION', listX * s, startY * s);
    ctx.restore();

    // Thin blue rule
    ctx.save();
    ctx.fillStyle   = WW_BLUE;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(listX * s, (startY + 16) * s, 180 * s, 1 * s);
    ctx.restore();

    let cursorY = startY + 32;

    // ── Title ─────────────────────────────────────────────────────────────────
    if (col.title) {
        ctx.save();
        ctx.fillStyle    = WW_WHITE;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${1 * s}px`;

        let sz = 36;
        ctx.font = `900 ${sz * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
        const titleText  = col.title.toUpperCase();
        const titleWords = titleText.split(' ');

        if (titleWords.length > 1 && ctx.measureText(titleText).width > maxW) {
            const mid   = Math.ceil(titleWords.length / 2);
            const line1 = titleWords.slice(0, mid).join(' ');
            const line2 = titleWords.slice(mid).join(' ');
            while (
                (ctx.measureText(line1).width > maxW || ctx.measureText(line2).width > maxW)
                && sz > 16
            ) {
                sz -= 2;
                ctx.font = `900 ${sz * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
            }
            ctx.fillText(line1, listX * s, cursorY * s);
            cursorY += sz + 5;
            ctx.fillText(line2, listX * s, cursorY * s);
            cursorY += sz + 14;
        } else {
            while (ctx.measureText(titleText).width > maxW && sz > 16) {
                sz -= 2;
                ctx.font = `900 ${sz * s}px 'Barlow Condensed', 'Arial Narrow', Impact, sans-serif`;
            }
            ctx.fillText(titleText, listX * s, cursorY * s);
            cursorY += sz + 14;
        }
        ctx.restore();
    }

    // ── Subtype · format ──────────────────────────────────────────────────────
    const typeParts = [col.subtype, col.format]
        .filter(Boolean)
        .map(v => v.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    if (typeParts.length > 0) {
        ctx.save();
        ctx.fillStyle    = 'rgba(255,255,255,0.5)';
        ctx.font         = `600 ${12 * s}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${0.3 * s}px`;
        let typeText = typeParts.join(' · ');
        while (ctx.measureText(typeText).width > maxW && typeText.length > 4) {
            typeText = typeText.slice(0, -1);
        }
        if (typeText !== typeParts.join(' · ')) typeText = typeText.trim() + '…';
        ctx.fillText(typeText, listX * s, cursorY * s);
        ctx.restore();
        cursorY += 20;
    }

    // ── Metadata rows — stacked two-line (LABEL above value) ─────────────────
    // Stacked layout avoids any overlap regardless of label or value width.
    const metaRows = [
        { label: 'RELEASED',  value: _formatDateLoose(col.item_date) },
        { label: 'ADDED',     value: _formatDateLoose(col.acquired_date) },
        { label: 'CONDITION', value: col.condition },
    ];

    cursorY += 10;

    const labelFont = `700 ${8 * s}px 'Plus Jakarta Sans', sans-serif`;
    const valueFont = `600 ${13 * s}px 'Plus Jakarta Sans', sans-serif`;

    metaRows.forEach(({ label, value }) => {
        if (!value) return;

        // Label line
        ctx.save();
        ctx.fillStyle    = WW_BLUE;
        ctx.globalAlpha  = 0.75;
        ctx.font         = labelFont;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${1.5 * s}px`;
        ctx.fillText(label, listX * s, cursorY * s);
        ctx.restore();

        cursorY += 11;

        // Value line (indented 2px for visual separation from label)
        ctx.save();
        ctx.fillStyle    = 'rgba(255,255,255,0.88)';
        ctx.font         = valueFont;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.letterSpacing = `${0.2 * s}px`;
        let valueText = value;
        while (ctx.measureText(valueText).width > maxW && valueText.length > 3) {
            valueText = valueText.slice(0, -1);
        }
        if (valueText !== value) valueText = valueText.trim() + '…';
        ctx.fillText(valueText, (listX + 2) * s, cursorY * s);
        ctx.restore();

        cursorY += 22; // gap before next row
    });

    // ── Framed item photo prop ────────────────────────────────────────────────
    // Drawn last so it sits on top of the gradient and text area.
    // Positioned lower-right of the right panel, tilted ~4° clockwise.
    if (col.itemPhotoUrl) {
        const photoImg = await _loadImage(col.itemPhotoUrl);
        if (photoImg) {
            // Polaroid: thin border on top/sides, thick on bottom
            const borderSide   = 10;  // top + left + right border
            const borderBottom = 40;  // thick polaroid bottom border
            const photoSize    = 300; // inner photo square
            const frameW       = photoSize + borderSide * 2;
            const frameH       = photoSize + borderSide + borderBottom;
            const angle        = 4 * Math.PI / 180;

            const iw = photoImg.naturalWidth, ih = photoImg.naturalHeight;
            const fitScale = Math.max(photoSize / iw, photoSize / ih);
            const pw = iw * fitScale, ph = ih * fitScale;

            // Anchor frame centre lower-right of the panel
            const cx = (W - 220) * s;
            const cy = (H - 200) * s;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);

            // Drop shadow
            ctx.shadowColor   = 'rgba(0,0,0,0.65)';
            ctx.shadowBlur    = 28 * s;
            ctx.shadowOffsetX = 5 * s;
            ctx.shadowOffsetY = 10 * s;

            // White polaroid frame
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(-(frameW / 2) * s, -(frameH / 2) * s, frameW * s, frameH * s);

            ctx.shadowColor = 'transparent';

            // Photo inside top/side borders
            const photoOffsetX = (-frameW / 2 + borderSide) * s;
            const photoOffsetY = (-frameH / 2 + borderSide) * s;

            ctx.save();
            ctx.beginPath();
            ctx.rect(photoOffsetX, photoOffsetY, photoSize * s, photoSize * s);
            ctx.clip();
            ctx.drawImage(
                photoImg,
                photoOffsetX + (photoSize - pw) / 2 * s,
                photoOffsetY + (photoSize - ph) / 2 * s,
                pw * s, ph * s
            );
            ctx.restore(); // remove clip
            ctx.restore(); // remove rotation + translate
        }
    }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _extractYear(dateStr) {
    if (!dateStr || dateStr === 'nan') return '';
    const parts = dateStr.split('/');
    if (parts.length === 3) return parts[2];
    return dateStr.length >= 4 ? dateStr.slice(0, 4) : '';
}

/**
 * Formats DD/MM/YYYY or ISO date strings to "1 January 2024".
 * Used for journal dates where the format is known.
 */
function _formatDate(dateStr) {
    if (!dateStr || dateStr === 'nan') return '';
    let d;
    const parts = dateStr.split('/');
    if (parts.length === 3) {
        d = new Date(parts[2], parts[1] - 1, parts[0]);
    } else {
        d = new Date(dateStr + 'T12:00:00');
    }
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Loose date formatter for collection fields (item_date, acquired_date).
 * Handles partial values gracefully:
 *   "1994"       → "1994"
 *   "1994-05"    → "May 1994"
 *   "1994-05-10" → "10 May 1994"
 *   anything unparseable → returned as-is
 */
function _formatDateLoose(dateStr) {
    if (!dateStr || dateStr === 'nan') return '';
    const str = dateStr.trim();

    // Year only
    if (/^\d{4}$/.test(str)) return str;

    // Year-month
    if (/^\d{4}-\d{2}$/.test(str)) {
        const d = new Date(str + '-01T12:00:00');
        if (!isNaN(d)) return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    }

    // Full ISO or other parseable
    const d = new Date(str.length === 10 ? str + 'T12:00:00' : str);
    if (!isNaN(d)) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Unparseable — return as-is rather than silently drop
    return str;
}

function _slug(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── SHARED OPEN SETUP ────────────────────────────────────────────────────────

function _openCanvas() {
    _ensureWWModal();

    const spinner  = document.getElementById('ww-spinner');
    const dlBtn    = document.getElementById('ww-download-btn');
    const shareBtn = document.getElementById('ww-share-btn');
    if (spinner)  spinner.classList.remove('hidden');
    if (dlBtn)    dlBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;

    const modal = document.getElementById('ww-modal');
    modal.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('visible')));
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/** Journal path — called from gig-modal-patch.js when weezerWednesday===true */
window.openWeezerWednesdayCanvas = async (journalKey) => {
    const entry = (window.journalData || []).find(g =>
        (g['Journal Key'] || g.journal_key) === journalKey
    );

    if (!entry) {
        console.warn('[WeezerWednesday] journal entry not found for key:', journalKey);
        return;
    }

    _wwEntry  = entry;
    _wwSource = 'journal';
    window._wwTotalTracks = 0;

    _openCanvas();

    const allTracks = await _resolveSetlist(entry);
    window._wwTotalTracks = allTracks.length;
    const tracks = allTracks.slice(0, MAX_TRACKS);

    await _renderWW(entry, tracks, 'journal');
};

/** Collection path — called from deep-link.js when source==='collection' */
window.openWeezerWednesdayCanvasCollection = async (collectionId) => {
    // Show modal + spinner immediately while we fetch
    _openCanvas();

    const entry = await _resolveCollectionEntry(collectionId);

    if (!entry) {
        console.warn('[WeezerWednesday] collection entry not found for id:', collectionId);
        // Hide spinner so user isn't left staring at it
        const spinner = document.getElementById('ww-spinner');
        if (spinner) spinner.classList.add('hidden');
        return;
    }

    _wwEntry  = entry;
    _wwSource = 'collection';

    await _renderWW(entry, [], 'collection');
};

window.closeWeezerWednesdayCanvas = () => {
    const modal = document.getElementById('ww-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
};

window._wwDownload = () => {
    if (!_wwCanvas) return;
    const artist = _wwEntry?.Band || _wwEntry?.band || 'weezer';

    let identifier;
    if (_wwSource === 'collection') {
        const title = _wwEntry?._collection?.title || artist;
        identifier  = _slug(title);
    } else {
        const year  = _extractYear(_wwEntry?.Date || _wwEntry?.date || '');
        identifier  = `${_slug(artist)}-${year || new Date().getFullYear()}`;
    }

    const fname = `giglist-weezer-wednesday-${identifier}.png`;
    const link  = document.createElement('a');
    link.download = fname;
    link.href     = _wwCanvas.toDataURL('image/png');
    link.click();
};

window._wwShare = async () => {
    if (!_wwCanvas || !navigator.share) return;
    try {
        const blob = await new Promise(resolve => _wwCanvas.toBlob(resolve, 'image/png'));
        if (!blob) return;

        const artist = _wwEntry?.Band || _wwEntry?.band || 'weezer';
        let identifier;
        if (_wwSource === 'collection') {
            const title = _wwEntry?._collection?.title || artist;
            identifier  = _slug(title);
        } else {
            const year  = _extractYear(_wwEntry?.Date || _wwEntry?.date || '');
            identifier  = `${_slug(artist)}-${year || new Date().getFullYear()}`;
        }

        const fname = `giglist-weezer-wednesday-${identifier}.png`;
        const file  = new File([blob], fname, { type: 'image/png' });

        if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Weezer Wednesday 🎸 — Gig List' });
        } else {
            await navigator.share({ title: 'Weezer Wednesday 🎸 — Gig List' });
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[WeezerWednesday] share failed:', e.message);
    }
};
// ─── PHOTO CROP / FRAME MODAL ──────────────────────────────────────────────
// Lets the user pinch-to-zoom / drag a selected photo into a fixed-aspect
// frame before it's uploaded, so portrait or oddly-composed photos don't
// get auto-cropped (e.g. heads cut off) by object-fit: cover in the modal.
//
// Drop-in replacement for the old "select file -> upload immediately" flow.
// Splices in BEFORE compressImage/upload, so everything below stays the same.

// Match this to the gig modal's hero photo container's real aspect ratio.
// Screenshots show ~16:9. Change this one constant if that's not exact.
export const PHOTO_CROP_ASPECT_RATIO = 16 / 9;

// Output render size (sets final image resolution; compressImage will
// still downscale further if needed, so this just needs to be >= maxDimension).
const PHOTO_CROP_OUTPUT_WIDTH = 1600;
const PHOTO_CROP_OUTPUT_HEIGHT = Math.round(PHOTO_CROP_OUTPUT_WIDTH / PHOTO_CROP_ASPECT_RATIO);

let _cropState = null; // holds in-progress crop session data

function _buildCropModal() {
    if (document.getElementById('photo-crop-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'photo-crop-modal';
    modal.className = 'hidden flex flex-col';
    // Inline styles used (not just Tailwind classes) so this can't lose a
    // specificity fight with any other fixed/z-indexed element in the app
    // (e.g. #mapModal is z-index: 9999 in style.css).
    modal.style.cssText = 'position:fixed; inset:0; z-index:99999; background:#000;';
    modal.innerHTML = `
        <div class="flex items-center justify-between px-4 py-3 text-white">
            <button type="button" id="photo-crop-cancel" class="text-[13px] font-bold uppercase tracking-wide opacity-80 hover:opacity-100">
                Cancel
            </button>
            <span class="text-[12px] font-black uppercase tracking-widest opacity-60">Frame Photo</span>
            <button type="button" id="photo-crop-use" class="text-[13px] font-black uppercase tracking-wide" style="color:#c8a050">
                Use Photo
            </button>
        </div>

        <div id="photo-crop-stage" class="relative flex-1 overflow-hidden touch-none select-none" style="background:#000">
            <canvas id="photo-crop-canvas" class="absolute inset-0"></canvas>
            <div id="photo-crop-frame" class="absolute pointer-events-none border-2" style="border-color:#c8a050;box-shadow:0 0 0 9999px rgba(0,0,0,0.6)"></div>
        </div>

        <div class="px-6 py-4 text-center text-white text-[11px] opacity-50">
            Drag to move &middot; Pinch or scroll to zoom
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('photo-crop-cancel').addEventListener('click', _closeCropModal);
    document.getElementById('photo-crop-use').addEventListener('click', _confirmCrop);

    const stage = document.getElementById('photo-crop-stage');
    stage.addEventListener('pointerdown', _onPointerDown);
    stage.addEventListener('pointermove', _onPointerMove);
    stage.addEventListener('pointerup', _onPointerUp);
    stage.addEventListener('pointercancel', _onPointerUp);
    stage.addEventListener('pointerleave', _onPointerUp);
    stage.addEventListener('wheel', _onWheel, { passive: false });
}

function _layoutFrame() {
    const stage = document.getElementById('photo-crop-stage');
    const frame = document.getElementById('photo-crop-frame');
    const stageRect = stage.getBoundingClientRect();

    if (stageRect.width === 0 || stageRect.height === 0) {
        console.error('[photo-crop] stage has zero size — modal may not be visible/laid out.', stageRect);
    }

    let frameW = stageRect.width * 0.92;
    let frameH = frameW / PHOTO_CROP_ASPECT_RATIO;
    const maxH = stageRect.height * 0.8;
    if (frameH > maxH) {
        frameH = maxH;
        frameW = frameH * PHOTO_CROP_ASPECT_RATIO;
    }

    const left = (stageRect.width - frameW) / 2;
    const top = (stageRect.height - frameH) / 2;

    frame.style.width = `${frameW}px`;
    frame.style.height = `${frameH}px`;
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;

    return { frameW, frameH, left, top, stageRect };
}

function _drawCrop() {
    const { img, canvas, ctx, scale, offsetX, offsetY } = _cropState;
    const stage = document.getElementById('photo-crop-stage');
    const stageRect = stage.getBoundingClientRect();

    canvas.width = stageRect.width;
    canvas.height = stageRect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2 + offsetX, canvas.height / 2 + offsetY);
    ctx.scale(scale, scale);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();
}

function _clampOffsets() {
    const { img, scale, frameLayout } = _cropState;
    const drawnW = img.width * scale;
    const drawnH = img.height * scale;

    // Max distance the image can be panned from center while still
    // fully covering the frame on each axis.
    const halfRangeX = Math.max(0, (drawnW - frameLayout.frameW) / 2);
    const halfRangeY = Math.max(0, (drawnH - frameLayout.frameH) / 2);

    _cropState.offsetX = Math.min(halfRangeX, Math.max(-halfRangeX, _cropState.offsetX));
    _cropState.offsetY = Math.min(halfRangeY, Math.max(-halfRangeY, _cropState.offsetY));
}

function _minScaleToCoverFrame(img, frameW, frameH) {
    return Math.max(frameW / img.width, frameH / img.height);
}

function _onPointerDown(e) {
    const stage = document.getElementById('photo-crop-stage');
    stage.setPointerCapture(e.pointerId);
    _cropState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (_cropState.pointers.size === 1) {
        _cropState.dragging = true;
        _cropState.dragStart = { x: e.clientX, y: e.clientY };
        _cropState.dragOffsetStart = { x: _cropState.offsetX, y: _cropState.offsetY };
    } else if (_cropState.pointers.size === 2) {
        _cropState.dragging = false;
        const pts = Array.from(_cropState.pointers.values());
        _cropState.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        _cropState.pinchStartScale = _cropState.scale;
    }
}

function _onPointerMove(e) {
    if (!_cropState.pointers.has(e.pointerId)) return;
    _cropState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (_cropState.pointers.size === 2) {
        const pts = Array.from(_cropState.pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (_cropState.pinchStartDist > 0) {
            const minScale = _minScaleToCoverFrame(_cropState.img, _cropState.frameLayout.frameW, _cropState.frameLayout.frameH);
            const newScale = Math.max(minScale, Math.min(minScale * 4, _cropState.pinchStartScale * (dist / _cropState.pinchStartDist)));
            _cropState.scale = newScale;
            _clampOffsets();
            _drawCrop();
        }
        return;
    }

    if (_cropState.dragging) {
        const dx = e.clientX - _cropState.dragStart.x;
        const dy = e.clientY - _cropState.dragStart.y;
        _cropState.offsetX = _cropState.dragOffsetStart.x + dx;
        _cropState.offsetY = _cropState.dragOffsetStart.y + dy;
        _clampOffsets();
        _drawCrop();
    }
}

function _onPointerUp(e) {
    _cropState.pointers.delete(e.pointerId);
    if (_cropState.pointers.size < 2) _cropState.pinchStartDist = 0;
    if (_cropState.pointers.size === 0) _cropState.dragging = false;
}

function _onWheel(e) {
    e.preventDefault();
    const minScale = _minScaleToCoverFrame(_cropState.img, _cropState.frameLayout.frameW, _cropState.frameLayout.frameH);
    const delta = -e.deltaY * 0.0015;
    const newScale = Math.max(minScale, Math.min(minScale * 4, _cropState.scale * (1 + delta)));
    _cropState.scale = newScale;
    _clampOffsets();
    _drawCrop();
}

export function openPhotoCropModal(file, onCropped) {
    _buildCropModal();
    const modal = document.getElementById('photo-crop-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const canvas = document.getElementById('photo-crop-canvas');
    const ctx = canvas.getContext('2d');
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
        const frameLayout = _layoutFrame();
        const minScale = _minScaleToCoverFrame(img, frameLayout.frameW, frameLayout.frameH);

        _cropState = {
            img, canvas, ctx, file, onCropped,
            scale: minScale,
            offsetX: 0,
            offsetY: 0,
            pointers: new Map(),
            dragging: false,
            dragStart: { x: 0, y: 0 },
            dragOffsetStart: { x: 0, y: 0 },
            pinchStartDist: 0,
            pinchStartScale: minScale,
            frameLayout,
            objectUrl: url,
        };

        _drawCrop();
    };
    img.onerror = (e) => {
        console.error('[photo-crop] image failed to load:', e);
    };
    img.src = url;
}

function _closeCropModal() {
    const modal = document.getElementById('photo-crop-modal');
    if (modal) modal.classList.add('hidden');
    if (_cropState?.objectUrl) URL.revokeObjectURL(_cropState.objectUrl);
    _cropState = null;
}

function _confirmCrop() {
    if (!_cropState) return;
    const { img, scale, offsetX, offsetY, frameLayout, file, onCropped } = _cropState;

    // Map the on-screen frame rect back into source-image pixel space.
    const stageCenterX = frameLayout.stageRect.width / 2 + offsetX;
    const stageCenterY = frameLayout.stageRect.height / 2 + offsetY;

    // Top-left of frame relative to the drawn (scaled) image's top-left.
    const drawnLeft = stageCenterX - (img.width * scale) / 2;
    const drawnTop = stageCenterY - (img.height * scale) / 2;

    const srcX = (frameLayout.left - drawnLeft) / scale;
    const srcY = (frameLayout.top - drawnTop) / scale;
    const srcW = frameLayout.frameW / scale;
    const srcH = frameLayout.frameH / scale;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = PHOTO_CROP_OUTPUT_WIDTH;
    outCanvas.height = PHOTO_CROP_OUTPUT_HEIGHT;
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, PHOTO_CROP_OUTPUT_WIDTH, PHOTO_CROP_OUTPUT_HEIGHT);

    outCanvas.toBlob((blob) => {
        if (!blob) {
            window.showToast?.('Could not process photo — try again', 'error');
            _closeCropModal();
            return;
        }
        const croppedFile = new File([blob], file.name || 'photo.jpg', { type: 'image/jpeg' });
        _closeCropModal();
        onCropped(croppedFile);
    }, 'image/jpeg', 0.92);
}

window.addEventListener('resize', () => {
    if (!_cropState) return;
    _cropState.frameLayout = _layoutFrame();
    const minScale = _minScaleToCoverFrame(_cropState.img, _cropState.frameLayout.frameW, _cropState.frameLayout.frameH);
    if (_cropState.scale < minScale) _cropState.scale = minScale;
    _clampOffsets();
    _drawCrop();
});
/**
 * deep-link.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles two entry paths that both end at the same destination — opening a
 * specific gig modal (and optionally the Weezer Wednesday canvas):
 *
 *   PATH A — URL params (cold start from a notification tap, or a shared link)
 *     index.html?open=<journalId>
 *     index.html?open=<journalId>&ww=1
 *
 *   PATH B — postMessage from the service worker (warm app already open)
 *     { type: 'GIGLIST_DEEP_LINK', journalId: '...', weezerWednesday: true }
 *
 * Both paths call _resolveDeepLink() which waits for the app to be ready
 * before calling window.openGigModal().
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration:
 *   In app.js, after initApp() resolves:
 *
 *     import { initDeepLink } from './modules/deep-link.js';
 *     initDeepLink();
 *
 * openGigModal() contract (implement / verify in app.js / table.js):
 *   window.openGigModal(journalId, options)
 *   options: { weezerWednesday: boolean }
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── App-ready gate ────────────────────────────────────────────────────────────
// initApp() is async; we don't want to call openGigModal before journals are
// loaded. app.js should call window._giglistReady() once data is in place.
// Until then we queue the intent and flush it when the gate opens.

let _appReady    = false;
let _pendingLink = null; // { journalId, weezerWednesday }

/** Called by app.js once the journal list has been rendered and modals are live. */
export function markAppReady() {
    _appReady = true;
    if (_pendingLink) {
        _flush(_pendingLink);
        _pendingLink = null;
    }
}

// ── Core resolver ─────────────────────────────────────────────────────────────

function _resolveDeepLink(journalId, weezerWednesday = false) {
    if (!journalId) return;

    const intent = { journalId, weezerWednesday };

    if (_appReady) {
        _flush(intent);
    } else {
        // Queue — markAppReady() will flush
        _pendingLink = intent;
    }
}

function _flush({ journalId, weezerWednesday }) {
    if (typeof window.openGigModal !== 'function') {
        console.warn('[deep-link] window.openGigModal not found — cannot open journal', journalId);
        return;
    }
    // Switch to the Gigs tab so the modal has a natural backdrop
    if (typeof window.switchView === 'function') {
        window.switchView('data');
    }
    window.openGigModal(journalId, { weezerWednesday });
}

// ── PATH A — URL params ───────────────────────────────────────────────────────

function _handleUrlParams() {
    const params    = new URLSearchParams(window.location.search);
    const journalId = params.get('open');
    const isWW      = params.get('ww') === '1';

    if (!journalId) return;

    // Clean the params from the URL bar without triggering a reload.
    // This prevents the modal re-opening on manual refresh.
    const cleanUrl = window.location.pathname;
    history.replaceState(null, '', cleanUrl);

    _resolveDeepLink(journalId, isWW);
}

// ── PATH B — postMessage from service worker ──────────────────────────────────

function _handleServiceWorkerMessage(event) {
    const msg = event.data;
    if (!msg || msg.type !== 'GIGLIST_DEEP_LINK') return;
    _resolveDeepLink(msg.journalId ?? null, msg.weezerWednesday ?? false);
}

// ── Public init — call once from app.js ───────────────────────────────────────

export function initDeepLink() {
    // PATH A: check URL params immediately
    _handleUrlParams();

    // PATH B: listen for SW postMessages going forward
    navigator.serviceWorker?.addEventListener('message', _handleServiceWorkerMessage);
}
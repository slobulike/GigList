/**
 * deep-link.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles three entry paths that all end at the same destination — opening a
 * specific gig modal or Weezer Wednesday canvas:
 *
 *   PATH A — URL params (cold start from a notification tap, or a shared link)
 *     vault.html?open=<journalId>
 *     vault.html?open=<journalId>&ww=1
 *     vault.html?open=<collectionId>&ww=1&source=collection
 *
 *   PATH B — postMessage from the service worker (warm app already open)
 *     { type: 'GIGLIST_DEEP_LINK', journalId: '...', weezerWednesday: true }
 *     { type: 'GIGLIST_DEEP_LINK', journalId: '...', weezerWednesday: true, source: 'collection' }
 *
 *   PATH C — IndexedDB mailbox (checked first, on every boot)
 *     Both iOS and Android have documented bugs where a notificationclick
 *     handler's openWindow()/navigate()/postMessage() doesn't reliably reach
 *     the page that actually loads (WebKit bug 263687; Android renderer
 *     eviction races — see idb-mailbox.js for details). The service worker
 *     writes the intent to IndexedDB before doing anything else, so we catch
 *     it here even if the browser ignored the target URL or dropped the
 *     postMessage.
 *
 * All three call _resolveDeepLink() which waits for the app to be ready
 * before dispatching to the correct handler.
 *
 * Source values:
 *   'journal'    (default, no source param)  → window.openGigModal()
 *   'collection'                              → window.openWeezerWednesdayCanvasCollection()
 *   'buddy-show'       (?buddyShow=<key>&by=<buddyId>)  → window._feedOpenBuddyShow()
 *   'buddy-collection' (?buddyCollection=<buddyId>)     → window._feedOpenBuddyCollection()
 *
 * Buddy intents carry an extra `by` field (the buddy who owns the show). It
 * rides through all three paths unchanged — the IndexedDB mailbox spreads
 * whatever intent it is given.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration:
 *   In app.js, after initApp() resolves:
 *
 *     import { initDeepLink, markAppReady } from './modules/deep-link.js';
 *     await initDeepLink();
 *     // ... after data is loaded and modals are live:
 *     markAppReady();
 *
 * openGigModal() contract (journal path):
 *   window.openGigModal(journalId, options)
 *   options: { weezerWednesday: boolean }
 *
 * openWeezerWednesdayCanvasCollection() contract (collection path):
 *   window.openWeezerWednesdayCanvasCollection(collectionId)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readAndClearPendingDeepLink } from './idb-mailbox.js';

// ── App-ready gate ────────────────────────────────────────────────────────────
// initApp() is async; we don't want to call openGigModal before journals are
// loaded. app.js should call markAppReady() once data is in place.
// Until then we queue the intent and flush it when the gate opens.

let _appReady    = false;
let _pendingLink = null; // { id, weezerWednesday, source, by }

/** Called by app.js once the journal list has been rendered and modals are live. */
export function markAppReady() {
    _appReady = true;
    if (_pendingLink) {
        _flush(_pendingLink);
        _pendingLink = null;
    }
}

// ── Core resolver ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUDDY_SOURCES = new Set(['buddy-show', 'buddy-collection']);

function _normaliseSource(source) {
    if (source === 'collection' || BUDDY_SOURCES.has(source)) return source;
    return 'journal';
}

/**
 * @param {string}  id               - journal id/key, collection item UUID, or buddy id
 * @param {boolean} weezerWednesday  - whether to open the WW canvas
 * @param {string}  source           - 'journal' (default) | 'collection' | 'buddy-show' | 'buddy-collection'
 * @param {string}  [by]             - buddy id who owns the show (buddy-show only)
 */
function _resolveDeepLink(id, weezerWednesday = false, source = 'journal', by = null) {
    if (!id) return;
    // Buddy intents are only valid with a well-formed buddy id
    if (source === 'buddy-show' && !UUID_RE.test(by || '')) return;
    if (source === 'buddy-collection' && !UUID_RE.test(String(id))) return;

    const intent = { id, weezerWednesday, source, by };

    if (_appReady) {
        _flush(intent);
    } else {
        // Queue — markAppReady() will flush
        _pendingLink = intent;
    }
}

function _waitFor(test, timeoutMs) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (test()) return resolve(true);
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(tick, 150);
        };
        tick();
    });
}

// Buddy deep links open the read-only buddy views defined in feed.js. They
// deliberately skip switchView() — the feed is where these live and the modal
// sits over whatever the user was already looking at.
async function _flushBuddy({ id, source, by }) {
    // feed.js defines the openers at import time; if app.js hasn't loaded it
    // yet, pull it in (module cache makes a second import free).
    if (typeof window._feedOpenBuddyShow !== 'function') {
        try { await import('./feed.js'); } catch (err) {
            console.warn('[deep-link] could not load feed.js for buddy link', err);
        }
    }

    if (source === 'buddy-show') {
        if (typeof window._feedOpenBuddyShow !== 'function') {
            console.warn('[deep-link] window._feedOpenBuddyShow not found — cannot open buddy show', id);
            return;
        }
        await window._feedOpenBuddyShow(id, by);
        return;
    }

    // buddy-collection: id is the buddy's id. The drill-in needs the buddy
    // list, which initBuddies fills in — give it a few seconds on a cold start.
    await _waitFor(() => (window._following || []).length > 0, 4000);
    const buddy = (window._following || []).find(b => b.id === id);
    if (!buddy || typeof window._feedOpenBuddyCollection !== 'function') {
        console.warn('[deep-link] cannot open buddy collection', id);
        window.showToast?.('That buddy isn\'t available any more', 'info');
        return;
    }
    await window._feedOpenBuddyCollection(id, buddy.display_name || buddy.username || '');
}

function _flush({ id, weezerWednesday, source, by }) {
    if (BUDDY_SOURCES.has(source)) {
        _flushBuddy({ id, source, by }).catch((err) =>
            console.warn('[deep-link] buddy deep link failed', err));
        return;
    }

        console.log('[deep-link] _flush called', { id, weezerWednesday, source });
        console.log('[deep-link] switchView:', typeof window.switchView);
        console.log('[deep-link] openGigModal:', typeof window.openGigModal);
        console.log('[deep-link] openWeezerWednesdayCanvas:', typeof window.openWeezerWednesdayCanvas);
        console.log('[deep-link] openWeezerWednesdayCanvasCollection:', typeof window.openWeezerWednesdayCanvasCollection);
        console.log('[deep-link] _appReady:', _appReady);
    // Switch to the Gigs tab so the modal has a natural backdrop.
    // Collection WW canvas is full-screen so this still makes sense as a base.
    if (typeof window.switchView === 'function') {
        window.switchView('data');
    }

    if (source === 'collection') {
        // Collection items always open the WW canvas — weezerWednesday is
        // implicit, but we guard on the function existing either way.
        if (typeof window.openWeezerWednesdayCanvasCollection !== 'function') {
            console.warn('[deep-link] window.openWeezerWednesdayCanvasCollection not found — cannot open collection item', id);
            return;
        }
        window.openWeezerWednesdayCanvasCollection(id);
        return;
    }

    // Default: journal path
    if (typeof window.openGigModal !== 'function') {
        console.warn('[deep-link] window.openGigModal not found — cannot open journal', id);
        return;
    }
    window.openGigModal(id, { weezerWednesday });
}

// ── PATH A — URL params ───────────────────────────────────────────────────────

function _handleUrlParams() {
    const params   = new URLSearchParams(window.location.search);
    const rawId    = params.get('open');
    const isWW     = params.get('ww') === '1';
    const source   = params.get('source') === 'collection' ? 'collection' : 'journal';

    // Buddy deep links (from the buddy activity push)
    const buddyShowKey = params.get('buddyShow');
    const buddyColId   = params.get('buddyCollection');
    const buddyId      = params.get('by');
    if (buddyShowKey && buddyId) {
        history.replaceState(null, '', window.location.pathname);
        _resolveDeepLink(buddyShowKey, false, 'buddy-show', buddyId);
        return;
    }
    if (buddyColId) {
        history.replaceState(null, '', window.location.pathname);
        _resolveDeepLink(buddyColId, false, 'buddy-collection');
        return;
    }

    if (!rawId) return;

    // Journal IDs are numeric; collection IDs are UUIDs (contain hyphens)
    const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

    const cleanUrl = window.location.pathname;
    history.replaceState(null, '', cleanUrl);

    _resolveDeepLink(id, isWW, source);
}

// ── PATH B — postMessage from service worker ──────────────────────────────────

function _handleServiceWorkerMessage(event) {
    const msg = event.data;
    if (!msg || msg.type !== 'GIGLIST_DEEP_LINK') return;

    const id     = msg.journalId ?? null;
    const isWW   = msg.weezerWednesday ?? false;
    const source = _normaliseSource(msg.source);

    _resolveDeepLink(id, isWW, source, msg.by ?? null);
}

// ── PATH B listener — registered immediately at module parse time ─────────────
//
// navigator.serviceWorker.addEventListener('message') is attached as soon as
// this module is imported — before initDeepLink() or markAppReady() are called.
// This closes the race window where sw.js fires client.postMessage() before
// app.js has called initDeepLink(), which was the failure mode with the
// previous BroadcastChannel approach (the channel only existed after initDeepLink
// ran, so any message sent before that moment was silently dropped).
//
// The intent is still safely queued via _resolveDeepLink → _pendingLink and
// flushed when markAppReady() is called, so warm-path taps work even if the
// app was backgrounded and data hasn't fully reloaded yet.
//
// NOTE: on mobile this path is the least reliable of the three — see PATH C
// below and idb-mailbox.js for why. Kept as-is since it still helps on desktop
// and doesn't hurt to leave attached.

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', _handleServiceWorkerMessage);
}

// ── Public init — call once from app.js ───────────────────────────────────────

export async function initDeepLink() {
    // PATH C: IndexedDB mailbox — checked first, before URL params. The
    // service worker writes the intended deep link here before calling
    // openWindow()/focus()/postMessage(), so we still catch it even if the
    // browser or OS ignored the notification's target URL or dropped the
    // postMessage (both are documented iOS/Android platform bugs, not
    // something fixable from app code alone).
    try {
        const pending = await readAndClearPendingDeepLink();
        if (pending && Date.now() - pending.ts < 5 * 60 * 1000) {
            console.log('[deep-link] resolved from IndexedDB mailbox', pending);
            _resolveDeepLink(pending.id, pending.weezerWednesday, _normaliseSource(pending.source), pending.by ?? null);
            return;
        }
    } catch (err) {
        console.warn('[deep-link] IndexedDB mailbox check failed, falling back to URL params', err);
    }

    // PATH A: check URL params (cold start / shared link)
    _handleUrlParams();

    // PATH B listener is already attached above at module parse time — nothing
    // more to do here for the warm path.
}
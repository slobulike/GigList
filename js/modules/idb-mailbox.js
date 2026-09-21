/**
 * idb-mailbox.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A tiny IndexedDB-backed "mailbox" used to hand a deep-link intent from the
 * service worker to the page, independent of whatever URL the page actually
 * ends up loading and independent of postMessage delivery.
 *
 * Why this exists:
 *   Both iOS (WebKit) and Android have documented platform bugs where a
 *   notificationclick handler's openWindow()/navigate()/focus()+postMessage()
 *   doesn't reliably deliver the deep-link target to the page that actually
 *   loads:
 *     - WebKit bug 263687: clients.openWindow(url) on an installed Home
 *       Screen PWA can open the app to its root URL instead of the URL given.
 *     - Android: a backgrounded tab's renderer can be evicted for memory
 *       while its WindowClient reference is still matched by matchAll(),
 *       so focus() causes a reload to the tab's *last* URL and any
 *       postMessage sent to it is dropped.
 *
 *   IndexedDB is shared between the service worker and every page on the
 *   same origin regardless of which URL loads, so it works around both
 *   bugs: the SW writes the intent here before doing anything else, and the
 *   page checks here on every boot in addition to reading URL params.
 *
 * Usage:
 *   import { writePendingDeepLink, readAndClearPendingDeepLink } from './idb-mailbox.js';
 *
 *   // In sw.js (service worker context):
 *   await writePendingDeepLink({ id, weezerWednesday, source });
 *
 *   // In deep-link.js (page context):
 *   const pending = await readAndClearPendingDeepLink();
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DB_NAME = 'giglist-deeplink';
const STORE   = 'pending';
const KEY     = 'pending';

function _openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Stash a deep-link intent. Overwrites any previous pending intent.
 * @param {{ id: string|number, weezerWednesday?: boolean, source?: string }} intent
 */
export async function writePendingDeepLink(intent) {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ ...intent, ts: Date.now() }, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/**
 * Read the pending intent (if any) and delete it in the same transaction,
 * so a given push notification is only ever consumed once.
 * @returns {Promise<null | { id: string|number, weezerWednesday?: boolean, source?: string, ts: number }>}
 */
export async function readAndClearPendingDeepLink() {
    const db = await _openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const getReq = store.get(KEY);
        getReq.onsuccess = () => {
            const value = getReq.result ?? null;
            store.delete(KEY);
            resolve(value);
        };
        getReq.onerror = () => reject(getReq.error);
    });
}
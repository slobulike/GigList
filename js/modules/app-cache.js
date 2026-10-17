/**
 * GigList - App Cache
 *
 * A tiny IndexedDB key-value store used for cache-first startup: the home
 * screen paints from the last session's data immediately, then refreshes from
 * Supabase in the background. See loadCachedStart() in data.js and
 * revalidateFromNetwork() in app.js.
 *
 * Every function here is best-effort and NEVER throws or rejects. If
 * IndexedDB is unavailable (private mode, quota, blocked upgrade) reads
 * resolve to null and writes are silently dropped, so the app simply behaves
 * as it did before the cache existed.
 *
 * Bump CACHE_VERSION whenever the shape of what's cached changes (the raw
 * Supabase rows built in data.js fetchRawAppData) — older entries are then
 * ignored and rebuilt from the network.
 */

export const CACHE_VERSION = 1;

const DB_NAME = 'giglist-cache';
const STORE   = 'kv';
const READ_TIMEOUT_MS = 1500;   // never let a stuck IndexedDB hold up first paint

let _dbPromise = null;

function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    // Allow a retry on the next call if opening failed
    _dbPromise.catch(() => { _dbPromise = null; });
    return _dbPromise;
}

function request(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result ?? null);
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
    }));
}

/** Resolves to the stored value, or null if missing / unavailable / slow. */
export async function cacheGet(key) {
    try {
        return await Promise.race([
            request('readonly', store => store.get(key)),
            new Promise(resolve => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
        ]);
    } catch {
        return null;
    }
}

/** Stores a structured-cloneable value. Never throws. */
export async function cachePut(key, value) {
    try {
        await request('readwrite', store => store.put(value, key));
    } catch (e) {
        console.warn('app-cache: write failed (continuing without cache):', e?.message || e);
    }
}

export async function cacheDelete(key) {
    try { await request('readwrite', store => store.delete(key)); } catch { /* best effort */ }
}

/** Removes everything — called on sign-out so no journal data lingers on the device. */
export async function cacheClear() {
    try { await request('readwrite', store => store.clear()); } catch { /* best effort */ }
}
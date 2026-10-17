/**
 * GigList - Supabase Client
 * Single initialisation point for the Supabase JS client.
 * Import `supabase` from this file anywhere you need database access.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = 'https://adlzxihwskrfcjpbtrgj.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkbHp4aWh3c2tyZmNqcGJ0cmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MTUwNDIsImV4cCI6MjA4OTE5MTA0Mn0.rSCjSNy6KvsjRTLyg6SprobSQA0PbxDHjbk8X75InpU';

/**
 * Request de-duplication.
 * If two parts of the app issue the *identical* GET while the first is still
 * in flight (same URL, same auth, same headers), they share one network
 * request instead of each hitting Supabase. Each caller gets its own clone of
 * the response, so reading the body twice is safe.
 *
 * Deliberately NOT shared: anything that isn't a plain GET (writes, RPC POSTs,
 * HEAD count queries, storage calls) and anything with an AbortSignal, so
 * cancellation semantics never change.
 */
const _inflight = new Map();

function dedupedFetch(input, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET' || init.signal) return fetch(input, init);

    const url  = typeof input === 'string' ? input : (input?.url || String(input));
    const hdrs = [...new Headers(init.headers || {}).entries()].sort().join('|');
    const key  = `${url}#${hdrs}`;

    let p = _inflight.get(key);
    if (!p) {
        p = fetch(input, init);
        _inflight.set(key, p);
        // Clear on settle so later (non-concurrent) calls always go to the network
        const clear = () => _inflight.delete(key);
        p.then(clear, clear);
    }
    return p.then(res => res.clone());
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: dedupedFetch },
});
window.supabase = supabase;

/**
 * fetch() wrapper for calls to GigList's own Cloudflare Workers.
 * Attaches the signed-in user's Supabase access token so the Worker can
 * verify who is calling — Workers must never trust a userId sent in the
 * request body or query string.
 */
export async function authedFetch(url, opts = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Please sign in again.');
    return fetch(url, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...opts.headers,
            Authorization: `Bearer ${session.access_token}`,
        },
    });
}
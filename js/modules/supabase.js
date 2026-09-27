/**
 * GigList - Supabase Client
 * Single initialisation point for the Supabase JS client.
 * Import `supabase` from this file anywhere you need database access.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = 'https://adlzxihwskrfcjpbtrgj.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkbHp4aWh3c2tyZmNqcGJ0cmdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MTUwNDIsImV4cCI6MjA4OTE5MTA0Mn0.rSCjSNy6KvsjRTLyg6SprobSQA0PbxDHjbk8X75InpU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
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

/**
 * clashfinder-sync.js
 * Handles Supabase persistence for clashfinder picks.
 *
 * Replaces localStorage for priority storage when the user is authenticated.
 * Falls back gracefully to localStorage for unauthenticated visitors so the
 * clashfinder still works without an account.
 *
 * Usage (from clashfinder.html <script> block):
 *
 *   import { initClashfinderSync } from './js/modules/clashfinder-sync.js';
 *
 *   const sync = await initClashfinderSync('slam-dunk-2026');
 *   // sync.priorities  — the live priorities object (same shape as before)
 *   // sync.setPriority(actId, level) — persist a single pick
 *   // sync.loadAll()   — reload all picks from DB
 *   // sync.isAuthed    — boolean
 *   // sync.userId      — uuid | null
 *   // sync.event       — the clashfinder_events row
 */

import { supabase } from './supabase.js';

const LS_KEY_PREFIX = 'cf_prio_'; // localStorage fallback key per event

export async function initClashfinderSync(eventSlug) {
    // ── Fetch event metadata ──────────────────────────────────────────────────
    const { data: event, error: evErr } = await supabase
        .from('clashfinder_events')
        .select('*')
        .eq('slug', eventSlug)
        .single();

    if (evErr || !event) {
        console.warn('clashfinder-sync: event not found for slug', eventSlug);
    }

    // ── Auth check ────────────────────────────────────────────────────────────
    const { data: { session } } = await supabase.auth.getSession();
    const isAuthed = !!session;
    const userId   = session?.user?.id || null;

    // ── Load existing picks ───────────────────────────────────────────────────
    let priorities = {};

    if (isAuthed) {
        const { data: rows, error: loadErr } = await supabase
            .from('clashfinder_picks')
            .select('act_id, priority')
            .eq('user_id', userId)
            .eq('event_slug', eventSlug);

        if (!loadErr && rows) {
            rows.forEach(r => { priorities[r.act_id] = r.priority; });
        }
    } else {
        // Unauthenticated: use localStorage
        try {
            priorities = JSON.parse(localStorage.getItem(LS_KEY_PREFIX + eventSlug) || '{}');
        } catch (_) {
            priorities = {};
        }
    }

    // ── Persist a single pick ─────────────────────────────────────────────────
    async function setPriority(actId, level) {
        if (level === 'none') {
            delete priorities[actId];
        } else {
            priorities[actId] = level;
        }

        if (isAuthed) {
            if (level === 'none') {
                await supabase
                    .from('clashfinder_picks')
                    .delete()
                    .eq('user_id', userId)
                    .eq('event_slug', eventSlug)
                    .eq('act_id', actId);
            } else {
                await supabase
                    .from('clashfinder_picks')
                    .upsert({
                        user_id:    userId,
                        event_slug: eventSlug,
                        act_id:     actId,
                        priority:   level,
                    }, { onConflict: 'user_id,event_slug,act_id' });
            }
        } else {
            localStorage.setItem(LS_KEY_PREFIX + eventSlug, JSON.stringify(priorities));
        }
    }

    // ── Reload all picks from DB ──────────────────────────────────────────────
    async function loadAll() {
        if (!isAuthed) return;
        const { data: rows } = await supabase
            .from('clashfinder_picks')
            .select('act_id, priority')
            .eq('user_id', userId)
            .eq('event_slug', eventSlug);

        // Replace in-place so the caller's reference stays valid
        Object.keys(priorities).forEach(k => delete priorities[k]);
        (rows || []).forEach(r => { priorities[r.act_id] = r.priority; });
    }

    // ── Build "add to archive" pre-population data ────────────────────────────
    /**
     * Returns the data needed to pre-populate the add-gig modal for post-event
     * archiving. Caller (clashfinder.html) passes in the full ACTS array so
     * this module doesn't need to know the lineup.
     *
     * @param {Array} allActs - The ACTS array from the clashfinder
     * @returns {{ festival: string, venue: string, date: string, bands: string[] }}
     */
    function getArchivePayload(allActs) {
        const seenActIds = Object.entries(priorities)
            .filter(([, p]) => p === 'did_see')
            .map(([id]) => id);

        const bands = seenActIds
            .map(id => allActs.find(a => a.id === id)?.name)
            .filter(Boolean)
            .sort();

        return {
            festival:  event?.name    || eventSlug,
            venue:     event?.venue   || '',
            date:      event?.festival_date
                           ? formatDateForApp(event.festival_date)
                           : '',
            bands,
        };
    }

    return {
        priorities,
        setPriority,
        loadAll,
        getArchivePayload,
        isAuthed,
        userId,
        event,
    };
}

/**
 * Convert ISO date (YYYY-MM-DD) to app format (DD/MM/YYYY)
 */
function formatDateForApp(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}
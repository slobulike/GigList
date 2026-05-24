/**
 * clashfinder-sync.js
 * Handles Supabase persistence for clashfinder picks, and loads
 * event/stage/act data dynamically from the database.
 *
 * Falls back gracefully to localStorage for unauthenticated visitors.
 * Falls back to a locked-in offline snapshot when the network is unavailable.
 *
 * Usage:
 *   import { initClashfinderSync } from './js/modules/clashfinder-sync.js';
 *   const sync = await initClashfinderSync('slam-dunk-2026');
 *
 *   sync.event        — clashfinder_events row
 *   sync.stages       — clashfinder_stages rows (sorted by sort_order)
 *   sync.acts         — clashfinder_acts rows (sorted by start_time)
 *   sync.priorities   — live { [act_uuid]: priority } object
 *   sync.isAuthed     — boolean
 *   sync.isOffline    — boolean: true when hydrated from snapshot, no network
 *   sync.setPriority(actId, level) — persist a single pick
 *   sync.lockIn()     — save a complete offline snapshot to localStorage
 *   sync.getArchivePayload() — returns { festival, venue, date, bands[] }
 */

import { supabase } from './supabase.js';

const LS_KEY_PREFIX      = 'cf_prio_';
const LS_SNAPSHOT_PREFIX = 'cf_snapshot_';

// ─── Offline snapshot helpers ─────────────────────────────────────────────────

function _saveSnapshot(eventSlug, { event, stages, acts, priorities }) {
    try {
        localStorage.setItem(
            LS_SNAPSHOT_PREFIX + eventSlug,
            JSON.stringify({ event, stages, acts, priorities, savedAt: Date.now() })
        );
    } catch (e) {
        console.warn('clashfinder-sync: snapshot save failed', e);
    }
}

function _loadSnapshot(eventSlug) {
    try {
        const raw = localStorage.getItem(LS_SNAPSHOT_PREFIX + eventSlug);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

// ─── Main init ────────────────────────────────────────────────────────────────

export async function initClashfinderSync(eventSlug) {

    // ── Offline path: no network → hydrate from snapshot ─────────────────────
    if (!navigator.onLine) {
        const snapshot = _loadSnapshot(eventSlug);
        if (snapshot) {
            return _buildOfflineSyncObject(eventSlug, snapshot);
        }
        // No snapshot and no network — return a minimal error object so the
        // caller can show a meaningful message rather than a blank screen.
        return { event: null, stages: [], acts: [], priorities: {}, isAuthed: false, isOffline: true, noSnapshot: true };
    }

    // ── Online path ───────────────────────────────────────────────────────────

    // 1. Load event + lineup from Supabase
    let event, stages, acts;

    try {
        const [eventRes, stagesRes, actsRes] = await Promise.all([
            supabase
                .from('clashfinder_events')
                .select('*')
                .eq('slug', eventSlug)
                .single(),
            supabase
                .from('clashfinder_stages')
                .select('*')
                .eq('event_slug', eventSlug)
                .order('sort_order'),
            supabase
                .from('clashfinder_acts')
                .select('*')
                .eq('event_slug', eventSlug)
                .order('start_time'),
        ]);

        if (eventRes.error)  console.warn('clashfinder-sync: event load failed',  eventRes.error);
        if (stagesRes.error) console.warn('clashfinder-sync: stages load failed', stagesRes.error);
        if (actsRes.error)   console.warn('clashfinder-sync: acts load failed',   actsRes.error);

        event  = eventRes.data  || null;
        stages = stagesRes.data || [];

        // Normalise acts: map DB columns → shape the renderer expects
        acts = (actsRes.data || []).map(a => ({
            id:    a.id,
            stage: a.stage_id,
            name:  a.name,
            start: a.start_time.slice(0, 5),
            end:   a.end_time.slice(0, 5),
        }));

    } catch (err) {
        // Network failed mid-flight — fall back to snapshot if available
        console.warn('clashfinder-sync: network error, trying snapshot', err);
        const snapshot = _loadSnapshot(eventSlug);
        if (snapshot) {
            return _buildOfflineSyncObject(eventSlug, snapshot);
        }
        return { event: null, stages: [], acts: [], priorities: {}, isAuthed: false, isOffline: true, noSnapshot: true };
    }

    // ── 2. Auth check ─────────────────────────────────────────────────────────
    const { data: { session } } = await supabase.auth.getSession();
    const isAuthed = !!session;
    const userId   = session?.user?.id || null;

    // ── 3. Load existing picks ────────────────────────────────────────────────
    let priorities = {};

    if (isAuthed) {
        const { data: rows, error } = await supabase
            .from('clashfinder_picks')
            .select('act_id, priority')
            .eq('user_id', userId)
            .eq('event_slug', eventSlug);

        if (!error && rows) {
            rows.forEach(r => { priorities[r.act_id] = r.priority; });
        }
    } else {
        try {
            priorities = JSON.parse(localStorage.getItem(LS_KEY_PREFIX + eventSlug) || '{}');
        } catch (_) {
            priorities = {};
        }
    }

    // ── 4. Persist a single pick ──────────────────────────────────────────────
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

    // ── 5. Lock In: write a complete offline snapshot ─────────────────────────
    function lockIn() {
        _saveSnapshot(eventSlug, { event, stages, acts, priorities });
    }

    // ── 6. Archive payload ────────────────────────────────────────────────────
    function getArchivePayload() {
        const seenIds = Object.entries(priorities)
            .filter(([, p]) => p === 'did_see')
            .map(([id]) => id);

        const bands = seenIds
            .map(id => acts.find(a => a.id === id)?.name)
            .filter(Boolean)
            .sort();

        return {
            festival: event?.name          || eventSlug,
            venue:    event?.venue         || '',
            date:     event?.festival_date ? formatDateForApp(event.festival_date) : '',
            bands,
        };
    }

    return { priorities, setPriority, lockIn, getArchivePayload, isAuthed, isOffline: false, userId, event, stages, acts };
}

// ─── Offline sync object ──────────────────────────────────────────────────────
// Returned when we're offline but have a snapshot. Picks are persisted to
// localStorage only (same as the unauthed online path). The snapshot's
// priorities object is updated in-place so the UI's live reference stays valid.

function _buildOfflineSyncObject(eventSlug, snapshot) {
    const { event, stages, acts } = snapshot;

    // Merge snapshot priorities with any local picks saved after lock-in
    let priorities;
    try {
        const local = JSON.parse(localStorage.getItem(LS_KEY_PREFIX + eventSlug) || '{}');
        // Local picks take precedence — they may have been updated after lock-in
        priorities = { ...snapshot.priorities, ...local };
    } catch {
        priorities = { ...snapshot.priorities };
    }

    function setPriority(actId, level) {
        if (level === 'none') {
            delete priorities[actId];
        } else {
            priorities[actId] = level;
        }
        localStorage.setItem(LS_KEY_PREFIX + eventSlug, JSON.stringify(priorities));
    }

    function lockIn() {
        // Re-save snapshot with latest priorities
        _saveSnapshot(eventSlug, { event, stages, acts, priorities });
    }

    function getArchivePayload() {
        const seenIds = Object.entries(priorities)
            .filter(([, p]) => p === 'did_see')
            .map(([id]) => id);

        const bands = seenIds
            .map(id => acts.find(a => a.id === id)?.name)
            .filter(Boolean)
            .sort();

        return {
            festival: event?.name          || eventSlug,
            venue:    event?.venue         || '',
            date:     event?.festival_date ? formatDateForApp(event.festival_date) : '',
            bands,
        };
    }

    return { priorities, setPriority, lockIn, getArchivePayload, isAuthed: false, isOffline: true, noSnapshot: false, userId: null, event, stages, acts };
}

function formatDateForApp(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}
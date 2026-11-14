/**
 * GigList — Setlist catch-up
 * ==========================
 * Shows logged in advance never got a setlist: the editor skips setlist.fm for
 * future dates (nothing is there yet), and nothing looked again afterwards.
 * This module does that, quietly, after the app has painted.
 *
 * On app open (personal mode, signed in, online) it looks at the user's own
 * shows dated 1–60 days ago that have no setlist yet:
 *   - a gig is missing when no performance row for its key matches its band
 *   - a festival is missing the acts in its own lineup with no performance row
 * and looks them up on setlist.fm with the same code the editor uses
 * (setlist-sync.js), writing the same rows the same way.
 *
 * Retries: setlist.fm entries often appear days after a show, so each show is
 * tried at most 5 times, no earlier than 1, 3, 7, 14 and 30 days after its
 * date, and at most once per ~day. Festivals are worked through a few acts per
 * open and resume where they left off; one full pass over the missing acts
 * counts as one attempt. State lives in localStorage per user (no schema
 * change); if storage is unavailable the catch-up doesn't run.
 *
 * Cost per open: at most CALL_BUDGET setlist.fm calls (1.1 s apart), stored
 * MBIDs are reused before any artist search, and nothing runs when there is
 * nothing to do. A localStorage lock stops two tabs running it together.
 *
 * Testing from the console (dry run by default — logs, writes nothing):
 *   giglistSetlistCatchup()                               — what would run now
 *   giglistSetlistCatchup({ key: '<Journal Key>' })       — that show, ignoring date + retry rules
 *   giglistSetlistCatchup({ key, asDate: 'DD/MM/YYYY' })  — and look up a different date
 *                                                           (e.g. treat a future show as a past one)
 *   giglistSetlistCatchup({ key, dryRun: false })         — actually write
 * Careful: dryRun:false with asDate saves THAT date's setlist under the show's key.
 */

import { supabase } from './supabase.js';
import * as Data from './data.js';
import { parseActList, normalizeArtist, isFestivalRow } from './utils.js';
import {
    findArtistMbid, findShowSetlist, festivalDateWindow, saveShowSetlists, politePause,
} from './setlist-sync.js';

const RETRY_AFTER_DAYS  = [1, 3, 7, 14, 30];   // attempt n is allowed from day RETRY_AFTER_DAYS[n]
const LOOKBACK_DAYS     = 60;
const CALL_BUDGET       = 12;                  // setlist.fm calls per app open
const MAX_ACTS_PER_OPEN = 4;                   // festival acts per app open
const MIN_GAP_MS        = 20 * 60 * 60 * 1000; // between attempts at the same show
const LOCK_MS           = 5 * 60 * 1000;
const DAY_MS            = 24 * 60 * 60 * 1000;

const LOCK_KEY  = 'giglist.setlistCatchup.lock';
const stateKey  = (uid) => `giglist.setlistCatchup.${uid}`;

// Loose match, same as the editor's: exact, or one name a prefix of the other
// ("Beauty School" vs setlist.fm's "Beauty School Dropout").
const namesMatch = (a, b) => {
    const na = normalizeArtist(a), nb = normalizeArtist(b);
    if (!na || !nb) return false;
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
};

const parseUK = (s) => {
    const [d, m, y] = String(s || '').split('/').map(Number);
    return d && m && y ? new Date(y, m - 1, d) : null;
};

const startOfDay = (ms) => { const t = new Date(ms); t.setHours(0, 0, 0, 0); return t; };

// ─── Storage ──────────────────────────────────────────────────────────────────

/** {} when empty, null when storage can't be used. */
function readState(uid) {
    try {
        const parsed = JSON.parse(localStorage.getItem(stateKey(uid)) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return null;
    }
}

function writeState(uid, state) {
    try { localStorage.setItem(stateKey(uid), JSON.stringify(state)); } catch { /* best effort */ }
}

function takeLock() {
    try {
        const now = Date.now();
        if (now - Number(localStorage.getItem(LOCK_KEY) || 0) < LOCK_MS) return false;
        localStorage.setItem(LOCK_KEY, String(now));
        return true;
    } catch {
        return false;
    }
}

function releaseLock() {
    try { localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
}

// ─── Candidates ───────────────────────────────────────────────────────────────

/**
 * Pure: which shows still need a setlist, and which of those are due now.
 * Exported for testing.
 *
 * @returns {{ due: object[], open: Set<string> }}
 *   due  — shows to try this open, most recent first
 *   open — keys of every show still missing a setlist inside the lookback
 *          window (state for anything else can be dropped)
 */
export function findCandidates({ uid, journal, performances, state, now = Date.now(), force = null }) {
    const today = startOfDay(now);

    const perfsByKey = new Map();
    for (const p of performances || []) {
        const k = p['Journal Key'] || p.journal_key;
        if (!k) continue;
        if (!perfsByKey.has(k)) perfsByKey.set(k, []);
        perfsByKey.get(k).push(p);
    }

    const due = [];
    const open = new Set();

    for (const entry of journal || []) {
        const key = entry['Journal Key'] || entry.journal_key;
        if (!key) continue;
        if (entry.user_id && entry.user_id !== uid) continue;   // own shows only
        if (force && key !== force) continue;

        const date = parseUK(entry.Date || entry.date);
        if (!date) continue;
        const days = Math.round((today - date) / DAY_MS);
        if (!force && (days < 1 || days > LOOKBACK_DAYS)) continue;

        const have = perfsByKey.get(key) || [];
        const festival = isFestivalRow(entry);
        let missing;
        if (festival) {
            missing = parseActList(entry['Festival Lineups'] || entry.festival_lineups || '', { splitCommas: false })
                .filter(act => !have.some(p => namesMatch(act, p.Artist || p.artist)));
        } else {
            const band = (entry.Band || entry.band || '').trim();
            missing = band && !have.some(p => namesMatch(band, p.Artist || p.artist)) ? [band] : [];
        }
        if (!missing.length) continue;
        open.add(key);

        const st = state[key] || { n: 0, last: 0, tried: [] };
        if (!force) {
            if (st.n >= RETRY_AFTER_DAYS.length) continue;              // given up
            const midPass = festival && (st.tried || []).length > 0;    // resume a festival straight away
            if (!midPass) {
                if (days < RETRY_AFTER_DAYS[st.n]) continue;
                if (st.last && now - st.last < MIN_GAP_MS) continue;
            }
        }
        due.push({ entry, key, date, days, festival, missing, st });
    }

    due.sort((a, b) => b.date - a.date);
    return { due, open };
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

async function venueRowFor(entry) {
    if (!entry.venue_id) return null;
    const { data } = await supabase.from('venues')
        .select('id, place_id, latitude, longitude')
        .eq('id', entry.venue_id)
        .maybeSingle();
    return data || null;
}

async function artistRowsByName(names) {
    const map = new Map();
    if (!names.length) return map;
    const { data } = await supabase.from('artists').select('id, name, mbid').in('name', names);
    (data || []).forEach(r => map.set(normalizeArtist(r.name), r));
    return map;
}

async function artistRowFor(entry, band) {
    let q = supabase.from('artists').select('id, name, mbid');
    q = entry.artist_id ? q.eq('id', entry.artist_id) : q.eq('name', band);
    const { data } = await q.limit(1);
    return data?.[0] || null;
}

// Store an MBID found by search so the next lookup skips the search (same as enrichment does).
function rememberMbid(row, mbid) {
    if (!row?.id || row.mbid || !mbid) return;
    supabase.from('artists').update({ mbid }).eq('id', row.id).is('mbid', null)
        .then(() => {}, () => {});
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/**
 * One catch-up pass. Never throws.
 * @returns {{ checked: number, saved: {key, band, acts: string[]}[], rateLimited: boolean, skipped: string|null }}
 */
export async function runSetlistCatchup({
    user, journal, performances, force = null, asDate = null, dryRun = false, now = Date.now(),
}) {
    const result = { checked: 0, saved: [], rateLimited: false, skipped: null };
    if (!user?.id) return { ...result, skipped: 'not signed in' };

    const stored = readState(user.id);
    if (stored === null) return { ...result, skipped: 'no storage' };
    // A dry run works on a copy so it can't move any show's retry schedule.
    const state = dryRun ? JSON.parse(JSON.stringify(stored)) : stored;

    if (!takeLock()) return { ...result, skipped: 'already running' };

    let calls = 0;
    let acts = 0;
    const save = () => { if (!dryRun) writeState(user.id, state); };
    const markAttempt = (key, st) => { state[key] = { n: (st.n || 0) + 1, last: now, tried: [] }; };

    try {
        const { due, open } = findCandidates({ uid: user.id, journal, performances, state, now, force });

        // Forget shows that are found, deleted or out of the window.
        if (!force) Object.keys(state).forEach(k => { if (!open.has(k)) delete state[k]; });
        save();

        // Budget checks use each unit's worst case (gig: search + 1 date; festival
        // act: search + 3 dates), so a run never goes over CALL_BUDGET.
        for (const c of due) {
            if (calls + (c.festival ? 4 : 2) > CALL_BUDGET) break;
            result.checked++;
            const venue = c.entry.OfficialVenue || c.entry.official_venue || '';
            const lookupDate = asDate || c.entry.Date || c.entry.date;

            try {
                if (!c.festival) {
                    // ── Single show ───────────────────────────────────────────
                    const band = c.missing[0];
                    const [venueRow, artist] = await Promise.all([venueRowFor(c.entry), artistRowFor(c.entry, band)]);

                    let mbid = artist?.mbid || null;
                    if (!mbid) {
                        calls++;
                        mbid = await findArtistMbid(band);
                        rememberMbid(artist, mbid);
                        await politePause();
                    }

                    let setlist = null;
                    if (mbid) {
                        calls++;
                        setlist = await findShowSetlist(mbid, lookupDate, venueRow);
                        await politePause();
                    }

                    if (setlist && dryRun) {
                        console.log('[setlist-catchup] dry run — would save', band, '@', venue, setlist.url || setlist.id);
                        result.saved.push({ key: c.key, band, acts: [band] });
                    } else if (setlist) {
                        const written = await saveShowSetlists([setlist], {
                            journalKey: c.key, venue, writeUserId: user.id,
                            venueId: c.entry.venue_id ?? null,
                            artistIdFor: () => artist?.id ?? c.entry.artist_id ?? null,
                        });
                        if (written) {
                            result.saved.push({ key: c.key, band, acts: [band] });
                            delete state[c.key];
                            save();
                            continue;
                        }
                        markAttempt(c.key, c.st);   // write refused — don't retry every open
                    } else {
                        markAttempt(c.key, c.st);
                    }
                    save();
                } else {
                    // ── Festival: a few acts per open, resumable ──────────────
                    const tried = new Set(c.st.tried || []);
                    const todo = c.missing.filter(a => !tried.has(normalizeArtist(a)));
                    const [venueRow, artists] = await Promise.all([venueRowFor(c.entry), artistRowsByName(todo)]);
                    const dates = festivalDateWindow(lookupDate, 3);
                    const found = [];

                    for (const act of todo) {
                        if (acts >= MAX_ACTS_PER_OPEN || calls + 4 > CALL_BUDGET) break;
                        acts++;
                        const row = artists.get(normalizeArtist(act)) || null;
                        try {
                            let mbid = row?.mbid || null;
                            if (!mbid) {
                                calls++;
                                mbid = await findArtistMbid(act);
                                rememberMbid(row, mbid);
                                await politePause();
                            }
                            let match = null;
                            for (const d of mbid ? dates : []) {
                                calls++;
                                match = await findShowSetlist(mbid, d, venueRow);
                                await politePause();
                                if (match) break;
                            }
                            if (match && dryRun) {
                                console.log('[setlist-catchup] dry run — would save', act, '@', venue, match.url || match.id);
                                found.push(act);
                            } else if (match) {
                                const written = await saveShowSetlists([match], {
                                    journalKey: c.key, venue, writeUserId: user.id,
                                    venueId: c.entry.venue_id ?? null,
                                    role: 'Festival',
                                    artistIdFor: () => row?.id ?? null,
                                });
                                if (written) found.push(act);
                            }
                            tried.add(normalizeArtist(act));
                        } catch (e) {
                            if (e.code === 'rate_limited') throw e;
                            console.warn('[setlist-catchup] lookup failed for', act, e.message);   // left untried
                        }
                    }

                    if (found.length) result.saved.push({ key: c.key, band: c.entry.Band || c.entry.band || venue, acts: found });

                    // One full pass over the missing acts = one attempt.
                    if (c.missing.every(a => tried.has(normalizeArtist(a)))) markAttempt(c.key, c.st);
                    else state[c.key] = { ...c.st, tried: [...tried] };
                    save();
                }
            } catch (e) {
                if (e.code === 'rate_limited') { result.rateLimited = true; break; }
                // proxy_error and the like: couldn't check, so it doesn't count as an attempt
                console.warn('[setlist-catchup] skipped', c.key, e.message);
            }
        }
    } catch (e) {
        console.warn('[setlist-catchup] failed:', e.message);
    } finally {
        save();
        releaseLock();
    }

    if (result.checked || dryRun) console.log('[setlist-catchup]', dryRun ? '(dry run)' : '', result);
    return result;
}

// ─── App hook ─────────────────────────────────────────────────────────────────

/** Reload setlists after a catch-up wrote some, and say so. */
async function _afterSave(user, saved) {
    try {
        await Data.dropPerfCache(user);
        const keys = (window.journalData || []).map(g => g['Journal Key']).filter(Boolean);
        window.performanceData = await Data.loadPerformances(keys, window.allVenues || {}, {
            cacheKey: Data.perfCacheKey(user), refresh: true,
        });
        window.refreshUI?.();
        Data.refreshAppCache?.(user);   // venue links may have been added to journal rows
    } catch (e) {
        console.warn('[setlist-catchup] reload failed:', e.message);
    }
    const msg = saved.length === 1
        ? `Setlist added: ${saved[0].band}`
        : `Setlists added for ${saved.length} recent shows`;
    window.showToast?.(`${msg} 🎶`, 'success');
}

/** Called by app.js in the background once performances have loaded. */
export async function startSetlistCatchup(user) {
    if (!user?.isAuthUser || user.Type !== 'Personal' || window.isBandMode) return;
    if (!Array.isArray(window.performanceData)) return;   // couldn't load them: everything would look missing
    if (navigator.onLine === false) return;

    const res = await runSetlistCatchup({
        user,
        journal:      window.journalData || [],
        performances: window.performanceData,
    });
    if (res.saved.length) await _afterSave(user, res.saved);
}

// Console helper for testing — dry run unless dryRun: false is passed.
window.giglistSetlistCatchup = async ({ key = null, asDate = null, dryRun = true } = {}) => {
    const user = window.currentUser;
    const res = await runSetlistCatchup({
        user,
        journal:      window.journalData || [],
        performances: window.performanceData || [],
        force: key, asDate, dryRun,
    });
    if (!dryRun && res.saved.length) await _afterSave(user, res.saved);
    return res;
};
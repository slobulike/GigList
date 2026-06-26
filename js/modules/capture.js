/**
 * GigList - Capture Module ("Grab Gig")
 *
 * Stage 2c: modal shell — open/close + state rendering (locating / matching
 * / result). Done.
 *
 * Stage 3: real geolocation — captured_at grabbed immediately, location
 * attempted with an independent ~6.5s timeout wrapper (iOS standalone-mode
 * getCurrentPosition() timeout bug), graceful non-blocking fallback on
 * denial/timeout/unavailable. Done.
 *
 * Stage 4: write the capture to pending_captures, open a Supabase Realtime
 * subscription scoped to that row's id, react live when the Worker updates
 * status/match fields, with a ~10s "still working on it" fallback if no
 * update arrives in time. Done.
 *
 * Stage 5+ (not yet built): the actual Supabase Database Webhook →
 * giglist-capture-match Worker that performs the matching and writes the
 * status update this module is listening for. Until that Worker exists,
 * rows will sit in pending_captures with status='pending' indefinitely, and
 * the modal will hit the 10s fallback every time — expected, not a bug in
 * this file.
 */

import { supabase } from './supabase.js';


// ─── MODAL FRAGMENT ─────────────────────────────────────────────────────────

const CAPTURE_MODAL_HTML = `
<div id="capture-modal-root">

    <!-- Header — consistent across all states -->
    <div class="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
        <h2 id="capture-modal-title" class="text-xl font-black tracking-tight text-slate-900 uppercase italic">Grab Gig</h2>
        <button onclick="window.closeCaptureModal()"
                aria-label="Close"
                class="bg-slate-100 hover:bg-red-50 hover:text-red-600 text-slate-500 p-2.5 rounded-xl transition-all">
            <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
        </button>
    </div>

    <div class="overflow-y-auto flex-grow px-6 py-8 overscroll-contain">

        <!-- ───────────────────────── STATE 1: LOCATING ───────────────────────── -->
        <div id="capture-state-locating" class="text-center py-10 space-y-4">
            <div class="w-16 h-16 mx-auto bg-indigo-50 rounded-full flex items-center justify-center">
                <i data-lucide="map-pin" class="w-7 h-7 text-indigo-500 animate-pulse" aria-hidden="true"></i>
            </div>
            <p id="capture-locating-text" class="text-sm font-bold text-slate-600">
                📍 Getting your location…
            </p>
        </div>

        <!-- ───────────────────────── STATE 2: MATCHING ───────────────────────── -->
        <div id="capture-state-matching" class="hidden text-center py-10 space-y-4">
            <div class="w-16 h-16 mx-auto bg-indigo-50 rounded-full flex items-center justify-center">
                <i data-lucide="search" class="w-7 h-7 text-indigo-500 animate-pulse" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-bold text-slate-600">
                🔍 Checking what's on nearby…
            </p>
            <p id="capture-location-fallback-note" class="hidden text-xs font-bold text-amber-600"></p>
        </div>

        <!-- ───────────────────────── STATE 3: RESULT ───────────────────────── -->
        <div id="capture-state-result" class="hidden space-y-6">

            <!-- High-confidence variant -->
            <div id="capture-result-high" class="hidden space-y-5">
                <div class="text-center space-y-2">
                    <div class="w-16 h-16 mx-auto bg-emerald-50 rounded-full flex items-center justify-center">
                        <i data-lucide="check" class="w-7 h-7 text-emerald-500" aria-hidden="true"></i>
                    </div>
                    <p class="text-sm font-bold text-slate-700 leading-relaxed">
                        Looks like you're at
                        <span id="capture-match-artist" class="font-black text-slate-900">{artist}</span>
                        at
                        <span id="capture-match-venue" class="font-black text-slate-900">{venue}</span>,
                        <span id="capture-match-date" class="font-black text-slate-900">{date}</span>
                        — that right?
                    </p>
                </div>

                <!-- Photo for the scrapbook (optional) -->
                <div>
                    <label class="block text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-2">
                        Add a photo <span class="text-slate-400 normal-case font-bold tracking-normal">(optional)</span>
                    </label>
                    <button id="capture-photo-trigger"
                            type="button"
                            class="w-full bg-slate-50 border border-dashed border-slate-300 rounded-2xl px-4 py-6 text-sm font-bold text-slate-500 hover:bg-slate-100 hover:border-slate-400 transition-all flex flex-col items-center gap-2">
                        <i data-lucide="camera" class="w-5 h-5" aria-hidden="true"></i>
                        For the scrapbook
                    </button>
                    <input type="file" id="capture-photo-input" accept="image/*" capture="environment" class="hidden">
                </div>

                <!-- Notes — freeform, replaces companion tagging (see build plan decisions) -->
                <div>
                    <label for="capture-notes" class="block text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-2">
                        Notes <span class="text-slate-400 normal-case font-bold tracking-normal">(optional)</span>
                    </label>
                    <textarea id="capture-notes"
                              rows="2"
                              placeholder="Jot down who you're with, etc — so you can log it properly later."
                              class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold text-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"></textarea>
                </div>

                <button id="capture-confirm-btn"
                        type="button"
                        onclick="window._confirmCapture()"
                        class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-wide text-sm rounded-2xl px-4 py-4 transition-all">
                    That's the one
                </button>

                <button type="button"
                        onclick="window._showArtistInput()"
                        class="w-full text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors py-1">
                    That's not right
                </button>
            </div>

            <!-- Artist input variant (no/wrong TM match) -->
            <div id="capture-result-artist-input" class="hidden space-y-5">
                <div class="text-center space-y-2">
                    <div class="w-16 h-16 mx-auto bg-indigo-50 rounded-full flex items-center justify-center">
                        <i data-lucide="music" class="w-7 h-7 text-indigo-500" aria-hidden="true"></i>
                    </div>
                    <p class="text-sm font-bold text-slate-700 leading-relaxed">
                        Who are you seeing?
                    </p>
                </div>

                <div>
                    <label for="capture-artist-input" class="block text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-2">
                        Artist
                    </label>
                    <input type="text"
                           id="capture-artist-input"
                           placeholder="Start typing…"
                           autocomplete="off"
                           class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold text-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                    <div id="capture-artist-suggestions"
                         class="hidden mt-1 bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden z-10"></div>
                </div>

                <div>
                    <label for="capture-artist-notes" class="block text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-2">
                        Notes <span class="text-slate-400 normal-case font-bold tracking-normal">(optional)</span>
                    </label>
                    <textarea id="capture-artist-notes"
                              rows="2"
                              placeholder="Who you're with, etc."
                              class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold text-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"></textarea>
                </div>

                <button id="capture-artist-save-btn"
                        type="button"
                        onclick="window._saveArtistCapture()"
                        class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-wide text-sm rounded-2xl px-4 py-4 transition-all">
                    Save and enjoy the show
                </button>

                <button type="button"
                        onclick="window._deferCapture()"
                        class="w-full text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors py-1">
                    I'll log it later
                </button>
            </div>

            <!-- Low/no-match variant -->
            <div id="capture-result-low" class="hidden text-center py-6 space-y-4">
                <div class="w-16 h-16 mx-auto bg-slate-100 rounded-full flex items-center justify-center">
                    <i data-lucide="music" class="w-7 h-7 text-slate-400" aria-hidden="true"></i>
                </div>
                <p class="text-sm font-bold text-slate-600 leading-relaxed px-2">
                    Not at a show, or we couldn't find it? No worries — enjoy the show,
                    we'll be here when you're ready to log it properly later.
                </p>
                <button onclick="window.closeCaptureModal()"
                        type="button"
                        class="text-xs font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700 transition-colors">
                    Got it
                </button>
            </div>

        </div>

    </div>

</div>
`;

// ─── STATE TOGGLING ─────────────────────────────────────────────────────────

/** Hides all three top-level states, then shows the one requested. */
function _showCaptureState(state) {
    const ids = ['capture-state-locating', 'capture-state-matching', 'capture-state-result'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== `capture-state-${state}`);
    });
}

/** Within the result state, shows one of: high / low / artist-input. */
function _showResultVariant(variant) {
    const high        = document.getElementById('capture-result-high');
    const low         = document.getElementById('capture-result-low');
    const artistInput = document.getElementById('capture-result-artist-input');
    if (high)        high.classList.toggle('hidden', variant !== 'high');
    if (low)         low.classList.toggle('hidden', variant !== 'low');
    if (artistInput) artistInput.classList.toggle('hidden', variant !== 'artist-input');
}

// ─── OPEN / CLOSE ───────────────────────────────────────────────────────────

/**
 * Opens the capture modal into the existing generic #modal / #modal-content
 * shell (vault.html ~line 1343) and kicks off the capture flow.
 */
export function openCapture() {
    const modal = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    if (!modal || !content) {
        console.error('openCapture: #modal / #modal-content not found in DOM');
        return;
    }

    content.innerHTML = CAPTURE_MODAL_HTML;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    if (window.lucide) lucide.createIcons();

    _showCaptureState('locating');

    _beginCapture();
}

/** Closes the capture modal and tears down any in-progress capture state. */
export function closeCaptureModal() {
    const modal = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    if (content) content.innerHTML = '';

    _teardownCaptureSubscription();
    _currentCapture = null;
}

// ─── CAPTURE FLOW (Stage 3: real geolocation) ───────────────────────────────

const GEOLOCATION_TIMEOUT_MS = 6500; // 5–8s range per build plan; splits the difference

/**
 * Holds the in-progress capture's data as it's assembled across stages.
 * Stage 4 reads from this when writing to Supabase.
 */
let _currentCapture = null;

/** The active Realtime channel for the current capture, if any. */
let _captureChannel = null;

/** Fallback timer: if no Worker update arrives within ~10s, show a
 * "still working on it" message rather than leaving the modal hanging
 * silently on the matching screen forever. */
let _captureFallbackTimer = null;
const CAPTURE_RESULT_FALLBACK_MS = 10000;

/**
 * Kicks off the real capture flow: timestamp first (always succeeds,
 * instant), then attempts geolocation with a hard timeout wrapper so a
 * slow/stalled GPS lock can never block the user past ~6.5s.
 *
 * iOS standalone-mode (home-screen PWA) has a known bug where
 * getCurrentPosition()'s own `timeout` option is unreliable — it can hang
 * well past the value given. The wrapper below uses Promise.race with an
 * independent setTimeout so we're not relying on the browser to honour its
 * own timeout option.
 */
function _beginCapture() {
    _currentCapture = {
        captured_at: new Date().toISOString(),
        latitude: null,
        longitude: null,
        location_status: null, // 'ok' | 'denied' | 'timeout' | 'unavailable'
    };

    _getLocationWithTimeout()
        .then(({ latitude, longitude }) => {
            _currentCapture.latitude = latitude;
            _currentCapture.longitude = longitude;
            _currentCapture.location_status = 'ok';
        })
        .catch((reason) => {
            // reason is one of 'denied' | 'timeout' | 'unavailable'
            _currentCapture.location_status = reason;
            _setLocationFallbackCopy(reason);
        })
        .finally(() => {
            // Always proceeds to matching, regardless of outcome — geolocation
            // failure must never block the flow (per build plan).
            _showCaptureState('matching');
            _insertPendingCapture();
        });
}

/**
 * Wraps navigator.geolocation.getCurrentPosition() in an independent
 * timeout, since the API's own `timeout` option can't be trusted in iOS
 * standalone mode. Resolves with {latitude, longitude} or rejects with a
 * reason string.
 */
function _getLocationWithTimeout() {
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) {
            reject('unavailable');
            return;
        }

        let settled = false;

        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject('timeout');
        }, GEOLOCATION_TIMEOUT_MS);

        navigator.geolocation.getCurrentPosition(
            (position) => {
                if (settled) return; // timeout already fired, ignore late success
                settled = true;
                clearTimeout(timeoutId);
                resolve({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                });
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                // GeolocationPositionError codes: 1 = PERMISSION_DENIED,
                // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
                if (error.code === 1) reject('denied');
                else if (error.code === 3) reject('timeout');
                else reject('unavailable');
            },
            {
                enableHighAccuracy: true,
                timeout: GEOLOCATION_TIMEOUT_MS, // best-effort; the wrapper above is authoritative
                maximumAge: 0,
            }
        );
    });
}

/**
 * Sets distinct, brief copy depending on why geolocation didn't resolve.
 * Denial reads as "you said no, that's fine" — timeout/unavailable reads as
 * "GPS just didn't come through in time" — different framing, same
 * non-blocking outcome.
 */
function _setLocationFallbackCopy(reason) {
    const note = document.getElementById('capture-location-fallback-note');
    if (!note) return;

    const copy = {
        denied: "No location access — that's OK, we'll still check by time.",
        timeout: "Couldn't get a location lock in time — still checking by time.",
        unavailable: "Location isn't available here — still checking by time.",
    };

    note.textContent = copy[reason] || copy.unavailable;
    note.classList.remove('hidden');
}

// ─── CAPTURE FLOW (Stage 4: Supabase insert + Realtime) ─────────────────────

/**
 * Inserts the capture into pending_captures as soon as geolocation has
 * resolved (or failed/timed out — _beginCapture's .finally() calls this
 * regardless of outcome). Opens a Realtime subscription on the new row
 * immediately after, so the modal can react live to the Worker's match
 * update without polling.
 */
async function _insertPendingCapture() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            console.warn('_insertPendingCapture: no session, cannot insert');
            _showResultVariant('low');
            _showCaptureState('result');
            return;
        }

        // The notes textarea is part of the result markup (visually hidden
        // until the result state shows) but it exists in the DOM from the
        // moment the modal opens, since the whole template is injected in
        // one shot. In practice it'll be empty here, since the user can't
        // see/reach it yet at insert time — this read just future-proofs
        // against that changing, and the value gets overwritten again on
        // confirm (Stage 4 follow-up / not yet wired) before the real save.
        const notesEl = document.getElementById('capture-notes');
        _currentCapture.notes = notesEl ? notesEl.value.trim() : '';

        const { data, error } = await supabase
            .from('pending_captures')
            .insert({
                user_id: session.user.id,
                captured_at: _currentCapture.captured_at,
                lat: _currentCapture.latitude,
                lng: _currentCapture.longitude,
                notes: _currentCapture.notes || null,
                status: 'pending',
            })
            .select('id')
            .single();

        if (error || !data) {
            console.warn('pending_captures insert failed:', error?.message);
            // Best-effort feature — if the insert itself fails, fall back to
            // the low-confidence "couldn't find it" copy rather than hanging.
            _showResultVariant('low');
            _showCaptureState('result');
            return;
        }

        _currentCapture.id = data.id;
        _subscribeToCapture(data.id);
    } catch (e) {
        console.warn('_insertPendingCapture error:', e.message);
        _showResultVariant('low');
        _showCaptureState('result');
    }
}

/**
 * Opens a Realtime subscription scoped to this specific pending_captures
 * row (by id), listening for UPDATE events. The giglist-capture-match
 * Worker (Stage 5/6/7, not yet built) is what eventually performs that
 * update — until it exists, this subscription will just sit open until
 * the ~10s fallback fires.
 */
function _subscribeToCapture(captureId) {
    _captureChannel = supabase
        .channel(`pending_captures:${captureId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'pending_captures',
                filter: `id=eq.${captureId}`,
            },
            (payload) => _handleCaptureUpdate(payload.new)
        )
        .subscribe();

    _captureFallbackTimer = setTimeout(async () => {
        // Check the actual row status rather than assuming low — the Worker
        // may have written needs_review (no TM match) which should route to
        // the artist input state, not the "couldn't find it" copy.
        if (_currentCapture?.id) {
            const { data } = await supabase
                .from('pending_captures')
                .select('status, matched_venue')
                .eq('id', _currentCapture.id)
                .single();

            if (data?.status === 'needs_review') {
                _showArtistInput({ venue: data.matched_venue || null });
                return;
            }
        }
        _showResultVariant('low');
        _showCaptureState('result');
    }, CAPTURE_RESULT_FALLBACK_MS);
}

/**
 * Called when the subscribed row updates. Reacts to status — 'matched'
 * means the Worker found a confident match and wrote match data onto this
 * pending_captures row (artist/venue/date), but has NOT yet written a real
 * journals row. That write only happens once the user confirms (see
 * _confirmCapture and the status lifecycle note above _insertPendingCapture).
 * Anything else (or a low-confidence match) surfaces the
 * couldn't-find-it copy rather than guessing at partial states.
 */
function _handleCaptureUpdate(row) {
    if (_captureFallbackTimer) {
        clearTimeout(_captureFallbackTimer);
        _captureFallbackTimer = null;
    }

    if (row.status === 'matched' && row.matched_journal_key) {
        _renderHighConfidenceResult(row);
    } else if (row.status === 'needs_review') {
        // No TM match (or low confidence) — show artist input so the user
        // can tell us who they're seeing rather than just deferring entirely.
        // matched_venue may be populated by Stage 9's resolveVenueByLocation.
        _showArtistInput({ venue: row.matched_venue || null });
    } else {
        _showResultVariant('low');
        _showCaptureState('result');
    }
}

/**
 * Populates the high-confidence result screen. artist/venue/date display
 * strings are expected on the row itself (display_artist / display_venue /
 * display_date) — the Worker is responsible for shaping those at write
 * time, since matched_journal_key alone isn't enough to render copy
 * without an extra round-trip lookup from the client.
 *
 * NOTE for Stage 6/7: confirm these display field names when the Worker is
 * written — placeholder names used here, easy to rename either side once
 * the Worker's actual update shape is decided.
 */
function _renderHighConfidenceResult(row) {
    const artistEl = document.getElementById('capture-match-artist');
    const venueEl  = document.getElementById('capture-match-venue');
    const dateEl   = document.getElementById('capture-match-date');

    if (artistEl) artistEl.textContent = row.matched_artist || 'this artist';
    if (venueEl)  venueEl.textContent  = row.matched_venue  || 'this venue';
    if (dateEl)   dateEl.textContent   = row.matched_date   || 'today';

    _showResultVariant('high');
    _showCaptureState('result');
}

/**
 * Confirm tap on the high-confidence result screen ("That's the one").
 *
 * Per the agreed status lifecycle, this does NOT write a journals row
 * itself — it just persists whatever the user typed in Notes and flips
 * status to 'confirmed'. The actual journals write happens later, in
 * Stage 7, triggered off this status change via a second Database Webhook
 * (not yet built). Keeping confirm this narrow means nothing gets logged
 * to the user's real gig history until they've explicitly said yes.
 */
async function _confirmCapture() {
    if (!_currentCapture || !_currentCapture.id) {
        console.warn('_confirmCapture: no active capture to confirm');
        return;
    }

    const btn = document.getElementById('capture-confirm-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving…';
    }

    const notesEl = document.getElementById('capture-notes');
    const notes = notesEl ? notesEl.value.trim() : '';

    try {
        const { error } = await supabase
            .from('pending_captures')
            .update({
                notes: notes || null,
                status: 'confirmed',
            })
            .eq('id', _currentCapture.id);

        if (error) {
            console.warn('_confirmCapture update failed:', error.message);
            if (btn) {
                btn.disabled = false;
                btn.textContent = "That's the one";
            }
            return;
        }

        closeCaptureModal();
    } catch (e) {
        console.warn('_confirmCapture error:', e.message);
        if (btn) {
            btn.disabled = false;
            btn.textContent = "That's the one";
        }
    }
}

/** Closes the Realtime subscription and clears the fallback timer, if open. */
function _teardownCaptureSubscription() {
    if (_captureChannel) {
        supabase.removeChannel(_captureChannel);
        _captureChannel = null;
    }
    if (_captureFallbackTimer) {
        clearTimeout(_captureFallbackTimer);
        _captureFallbackTimer = null;
    }
}

// ─── WINDOW BRIDGE (mirrors existing module convention, e.g. collection-editor.js) ──
//
// _confirmCapture keeps its underscore (module-private-by-convention,
// matching editor.js's _functionName style) but still needs a window bridge
// here specifically because the confirm button's onclick lives in injected
// HTML (CAPTURE_MODAL_HTML), not in vault.html's own markup — it can't reach
// a module-scoped function any other way.

window.openCapture       = openCapture;
window.closeCaptureModal = closeCaptureModal;
window._confirmCapture   = _confirmCapture;

// ─── CAPTURE FLOW (Stage 10: artist input + defer) ──────────────────────────

/**
 * Transitions to the artist-input state. Called from two places:
 *   1. "That's not right" tap on the high-confidence result screen
 *   2. _handleCaptureUpdate when status === 'needs_review' (no TM match)
 *
 * opts.venue — optional venue name string from matched_venue (Stage 9)
 */
function _showArtistInput(opts = {}) {
    _showResultVariant('artist-input');
    _showCaptureState('result');

    const input = document.getElementById('capture-artist-input');
    if (input) {
        input.addEventListener('input', _onArtistInputChange);
        input.focus();
    }
}

/** Debounce timer for artist autocomplete */
let _artistInputDebounce = null;

/**
 * Handles keystrokes in the artist input — debounces to avoid hammering
 * Supabase on every keypress, queries the artists table, renders suggestions.
 */
async function _onArtistInputChange(e) {
    const query = e.target.value.trim();
    const suggestionsEl = document.getElementById('capture-artist-suggestions');
    if (!suggestionsEl) return;

    if (query.length < 2) {
        suggestionsEl.classList.add('hidden');
        suggestionsEl.innerHTML = '';
        return;
    }

    clearTimeout(_artistInputDebounce);
    _artistInputDebounce = setTimeout(async () => {
        const { data } = await supabase
            .from('artists')
            .select('id, name')
            .ilike('name', `${query}%`)
            .limit(6);

        if (!data?.length) {
            suggestionsEl.classList.add('hidden');
            suggestionsEl.innerHTML = '';
            return;
        }

        suggestionsEl.innerHTML = data.map(a =>
            `<button type="button"
                     data-artist-name="${a.name.replace(/"/g, '&quot;')}"
                     data-artist-id="${a.id}"
                     class="w-full text-left px-4 py-3 text-sm font-bold text-slate-800 hover:bg-indigo-50 transition-colors border-b border-slate-100 last:border-0">
                ${a.name}
             </button>`
        ).join('');
        suggestionsEl.classList.remove('hidden');

        // Delegated listener — avoids inline onclick and apostrophe/quote escaping issues
        suggestionsEl.onclick = (e) => {
            const btn = e.target.closest('button[data-artist-name]');
            if (!btn) return;
            _selectArtistSuggestion(btn.dataset.artistName, parseInt(btn.dataset.artistId, 10));
        };
    }, 200);
}

/**
 * Called when the user taps an autocomplete suggestion.
 * Fills the input, hides the dropdown, stores the artist id for save.
 */
function _selectArtistSuggestion(name, artistId) {
    const input = document.getElementById('capture-artist-input');
    if (input) input.value = name;
    const suggestionsEl = document.getElementById('capture-artist-suggestions');
    if (suggestionsEl) suggestionsEl.classList.add('hidden');
    if (_currentCapture) _currentCapture._selectedArtistId = artistId;
}

/**
 * "Save and enjoy the show" — writes artist name onto the pending_captures
 * row and flips status to 'confirmed'. Triggers the same Stage 7 hydration
 * webhook as the happy path, creating a real journals row.
 */
async function _saveArtistCapture() {
    if (!_currentCapture?.id) {
        console.warn('_saveArtistCapture: no active capture');
        return;
    }

    const input  = document.getElementById('capture-artist-input');
    const artist = input?.value.trim();
    if (!artist) {
        if (input) input.focus();
        return;
    }

    const btn = document.getElementById('capture-artist-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const notesEl = document.getElementById('capture-artist-notes');
    const notes   = notesEl?.value.trim() || null;
    const today   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
        const { error } = await supabase
            .from('pending_captures')
            .update({
                matched_artist: artist,
                matched_date:   today,
                notes:          notes,
                status:         'confirmed',
            })
            .eq('id', _currentCapture.id);

        if (error) {
            console.warn('_saveArtistCapture update failed:', error.message);
            if (btn) { btn.disabled = false; btn.textContent = 'Save and enjoy the show'; }
            return;
        }

        closeCaptureModal();
    } catch (e) {
        console.warn('_saveArtistCapture error:', e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Save and enjoy the show'; }
    }
}

/**
 * "I'll log it later" — sets status to needs_review and closes.
 * The Stage 11 home page reminder card will surface this row to the user
 * and offer to pre-fill the editor when they're ready.
 */
async function _deferCapture() {
    if (_currentCapture?.id) {
        const { error } = await supabase
            .from('pending_captures')
            .update({ status: 'needs_review' })
            .eq('id', _currentCapture.id);
        if (error) console.warn('_deferCapture update failed:', error.message);
    }
    closeCaptureModal();
}

// Additional window bridges for Stage 10 inline onclick handlers
window._showArtistInput        = _showArtistInput;
window._saveArtistCapture      = _saveArtistCapture;
window._deferCapture           = _deferCapture;
window._selectArtistSuggestion = _selectArtistSuggestion;

// ─── Stage 11: Home page pending reminder card ────────────────────────────────

/**
 * Queries for the most recent needs_review capture for the current user and
 * renders a reminder card into #pending-capture-reminder. If none found,
 * clears the container. Called from app.js refreshUI() in personal mode.
 */
export async function loadPendingCaptureReminder() {
    const container = document.getElementById('pending-capture-reminder');
    if (!container) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { container.innerHTML = ''; return; }

    const { data: rows } = await supabase
        .from('pending_captures')
        .select('id, matched_artist, matched_venue, captured_at')
        .eq('user_id', session.user.id)
        .eq('status', 'needs_review')
        .order('captured_at', { ascending: false })
        .limit(1);

    const capture = rows?.[0] ?? null;

    if (!capture) {
        container.innerHTML = '';
        return;
    }

    // Format the captured date as a friendly string, e.g. "25 Jun"
    const capturedDate = capture.captured_at
        ? new Date(capture.captured_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : null;

    const venuePart  = capture.matched_venue  ? ` at ${capture.matched_venue}`  : '';
    const artistPart = capture.matched_artist ? ` — ${capture.matched_artist}` : '';
    const datePart   = capturedDate ? `on ${capturedDate}` : 'recently';

    container.innerHTML = `
        <div id="pending-capture-card"
             class="mx-4 mb-3 bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-4 flex items-start gap-3">
            <div class="flex-shrink-0 w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center mt-0.5">
                <i data-lucide="music" class="w-4 h-4 text-indigo-600" aria-hidden="true"></i>
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-xs font-black uppercase tracking-widest text-indigo-500 mb-0.5">Unfinished show</p>
                <p class="text-sm font-bold text-slate-800 leading-snug">
                    You were at a show ${datePart}${venuePart}${artistPart} — want to log it?
                </p>
                <div class="flex items-center gap-3 mt-3">
                    <button type="button"
                            onclick="window._openPendingCapture('${capture.id}')"
                            class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black uppercase tracking-widest rounded-xl px-3 py-2 transition-all">
                        Finish logging
                    </button>
                    <button type="button"
                            onclick="window._dismissPendingCapture('${capture.id}')"
                            class="text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors">
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * "Finish logging" tap — opens the editor pre-filled with the capture data.
 * openCaptureGigModal is implemented in Stage 12 (editor.js).
 */
async function _openPendingCapture(captureId) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data: rows } = await supabase
        .from('pending_captures')
        .select('id, matched_artist, matched_venue, matched_date, notes, captured_at')
        .eq('id', captureId)
        .eq('user_id', session.user.id)
        .limit(1);

    const capture = rows?.[0];
    if (!capture) return;

    // Stage 12: editor.js will expose this
        if (typeof window.openCaptureGigModal === 'function') {
            window.openCaptureGigModal(capture);
        } else {
            // Temporary fallback until Stage 12 — open the editor via the add button
            document.getElementById('btn-add-show')?.click();
        }
}

/**
 * "Dismiss" tap — marks the capture dismissed and removes the card from the DOM.
 */
async function _dismissPendingCapture(captureId) {
    const card = document.getElementById('pending-capture-card');
    if (card) card.closest('#pending-capture-reminder').innerHTML = '';

    const { error } = await supabase
        .from('pending_captures')
        .update({ status: 'dismissed' })
        .eq('id', captureId);
    if (error) console.warn('_dismissPendingCapture failed:', error.message);
}

window._openPendingCapture    = _openPendingCapture;
window._dismissPendingCapture = _dismissPendingCapture;
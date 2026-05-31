/**
 * spotify-auth.js — Spotify OAuth connection management for GigList
 * -----------------------------------------------------------------
 * Handles checking, initiating, and caching a user's Spotify connection.
 * Consumed by spotify.js to gate playlist creation behind auth.
 */

import { supabase } from './supabase.js';

const WORKER = 'https://giglist-spotify.richard-lipscombe.workers.dev';

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
// Avoids repeated Supabase lookups within the same page load.
// null = not yet checked, true/false = confirmed state.
let _connected = null;

// ─── CONNECTION CHECK ─────────────────────────────────────────────────────────

/**
 * Returns true if the current user has a Spotify token stored.
 * Result is cached for the session — call invalidateSpotifyCache() after
 * a successful connect or disconnect to force a fresh check.
 */
export const checkSpotifyConnection = async (userId) => {
    if (_connected !== null) return _connected;

    const { data } = await supabase
        .from('spotify_tokens')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();

    _connected = !!data;
    return _connected;
};

export const isSpotifyConnected = () => _connected === true;

export const invalidateSpotifyCache = () => { _connected = null; };

// ─── CONNECT FLOW ─────────────────────────────────────────────────────────────

/**
 * Opens a Spotify OAuth popup and returns a promise that resolves when the
 * user successfully connects, or rejects with a descriptive error.
 */
export const connectSpotify = (userId) => new Promise(async (resolve, reject) => {
    // Derive the redirect URI from the current page's location so it works
    // identically on 127.0.0.1 and GitHub Pages without hardcoding.
    const redirectUri = new URL('spotify-callback.html', window.location.href).href
        .replace('//localhost:', '//127.0.0.1:');

    let authUrl;
    try {
        const res = await fetch(
            `${WORKER}/auth-url?userId=${encodeURIComponent(userId)}&redirectUri=${encodeURIComponent(redirectUri)}`
        );
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        authUrl = data.authUrl;
    } catch (err) {
        return reject(new Error('Could not start Spotify login: ' + err.message));
    }

    // Open the Spotify authorisation screen in a centred popup
    const w = 480, h = 680;
    const left = Math.max(0, (window.screen.width  / 2) - (w / 2));
    const top  = Math.max(0, (window.screen.height / 2) - (h / 2));
    const popup = window.open(
        authUrl,
        'spotify-auth',
        `width=${w},height=${h},left=${left},top=${top},resizable=no`
    );

    if (!popup || popup.closed) {
        return reject(new Error('Popup was blocked. Please allow popups for this site and try again.'));
    }

    // Listen for the postMessage sent by spotify-callback.html
    const onMessage = (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== 'SPOTIFY_AUTH') return;

        cleanup();

        if (event.data.ok) {
            _connected = true;
            resolve();
        } else {
            const msg = event.data.error === 'access_denied'
                ? 'Spotify access was denied.'
                : (event.data.error || 'Spotify connection failed.');
            reject(new Error(msg));
        }
    };

    // Detect the user manually closing the popup before completing auth
    const pollClosed = setInterval(() => {
        if (popup.closed) {
            cleanup();
            reject(new Error('Spotify login was cancelled.'));
        }
    }, 600);

    function cleanup() {
        clearInterval(pollClosed);
        window.removeEventListener('message', onMessage);
    }

    window.addEventListener('message', onMessage);
});

// ─── CONNECT BUTTON RENDERER ──────────────────────────────────────────────────

/**
 * Replaces the element identified by btnId with a "Connect Spotify" prompt.
 * Once the user connects, calls onSuccess() so the caller can re-initialise
 * the playlist button.
 *
 * @param {string}   btnId      - ID of the element to replace
 * @param {string}   userId     - Supabase user ID
 * @param {Function} onSuccess  - callback fired after successful connection
 */
export const renderConnectPrompt = (btnId, userId, onSuccess) => {
    const el = document.getElementById(btnId);
    if (!el) return;

    const promptId = `spotify-connect-${btnId}`;

    el.outerHTML = `
        <button id="${promptId}"
                class="bg-slate-700 hover:bg-green-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95"
                title="Connect your Spotify account to use this feature">
            <i data-lucide="music-2" class="w-3.5 h-3.5" aria-hidden="true"></i>
            CONNECT SPOTIFY
        </button>`;
    if (window.lucide) lucide.createIcons();

    document.getElementById(promptId)?.addEventListener('click', async () => {
        const btn = document.getElementById(promptId);
        if (btn) {
            btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin" aria-hidden="true"></i> CONNECTING…';
            btn.disabled = true;
            if (window.lucide) lucide.createIcons();
        }

        try {
            await connectSpotify(userId);
            window.showToast('Spotify connected! 🎧', 'success');
            // Restore the original btn id so createGigReadyPlaylist can find and replace the element
            const connectEl = document.getElementById(promptId);
            if (connectEl) connectEl.id = btnId;
            onSuccess();
        } catch (err) {
            window.showToast(err.message, 'error');
            // Restore the connect button so the user can try again
            const el2 = document.getElementById(promptId);
            if (el2) {
                el2.innerHTML = '<i data-lucide="music-2" class="w-3.5 h-3.5" aria-hidden="true"></i> CONNECT SPOTIFY';
                el2.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        }
    });
};
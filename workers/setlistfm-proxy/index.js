/**
 * setlistfm-proxy — Cloudflare Worker
 * ====================================
 * Proxies requests to the setlist.fm REST API, injecting the API key
 * from environment variables so it never appears in the frontend.
 *
 * Deploy:
 *   wrangler deploy
 *
 * Environment variables (set in Cloudflare dashboard or wrangler.toml secrets):
 *   SETLISTFM_API_KEY  — your setlist.fm API key
 *
 * Supported endpoints (all via ?endpoint=<path>):
 *
 *   User attended setlists (paginated):
 *     GET /?endpoint=user-setlists&username=TragicGurl&page=1
 *     → proxies: GET /rest/1.0/user/{username}/attended?p={page}
 *
 *   Artist setlists by MBID (for band onboarding):
 *     GET /?endpoint=artist-setlists&mbid=abc-123&page=1
 *     → proxies: GET /rest/1.0/artist/{mbid}/setlists?p={page}
 *
 *   Venue lookup by setlist.fm venue ID:
 *     GET /?endpoint=venue&venueId=abc123
 *     → proxies: GET /rest/1.0/venue/{venueId}
 *
 * Response:
 *   Raw JSON from setlist.fm, with CORS headers added.
 *   Errors from setlist.fm are passed through with their original status code.
 *   Worker-level errors (missing params, missing API key) return 400/500.
 *
 * CORS:
 *   Production origin is restricted to your GitHub Pages domain.
 *   Any localhost/127.0.0.1 origin is allowed for local development (any port).
 *   Update PRODUCTION_ORIGINS in the source if your domain changes.
 */

const SETLISTFM_BASE = 'https://api.setlist.fm/rest/1.0';

const PRODUCTION_ORIGINS = [
    'https://slobulike.github.io',
];

function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (PRODUCTION_ORIGINS.includes(origin)) return true;
    // Allow any localhost/127.0.0.1 for local dev regardless of port
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch { return false; }
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function corsHeaders(requestOrigin) {
    const origin = isAllowedOrigin(requestOrigin)
        ? requestOrigin
        : PRODUCTION_ORIGINS[0]; // fall back to production origin

    return {
        'Access-Control-Allow-Origin':  origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

function jsonResponse(body, status = 200, requestOrigin = '') {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(requestOrigin),
        },
    });
}

// ─── Route builder ────────────────────────────────────────────────────────────

function buildSetlistFmUrl(params) {
    const endpoint = params.get('endpoint');

    if (endpoint === 'user-setlists') {
        const username = params.get('username');
        const page     = params.get('page') || '1';
        if (!username) return { error: 'Missing required param: username' };
        return { url: `${SETLISTFM_BASE}/user/${encodeURIComponent(username)}/attended?p=${page}` };
    }

    if (endpoint === 'artist-setlists') {
        const mbid = params.get('mbid');
        const page = params.get('page') || '1';
        if (!mbid) return { error: 'Missing required param: mbid' };
        return { url: `${SETLISTFM_BASE}/artist/${encodeURIComponent(mbid)}/setlists?p=${page}` };
    }

    if (endpoint === 'venue') {
        const venueId = params.get('venueId');
        if (!venueId) return { error: 'Missing required param: venueId' };
        return { url: `${SETLISTFM_BASE}/venue/${encodeURIComponent(venueId)}` };
    }

    return { error: `Unknown endpoint: "${endpoint}". Valid values: user-setlists, artist-setlists, venue` };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        if (request.method !== 'GET') {
            return jsonResponse({ error: 'Method not allowed' }, 405, origin);
        }

        // Validate API key is configured
        if (!env.SETLISTFM_API_KEY) {
            console.error('SETLISTFM_API_KEY is not set in Worker environment');
            return jsonResponse({ error: 'Worker misconfigured — API key missing' }, 500, origin);
        }

        const params = new URL(request.url).searchParams;
        const { url, error } = buildSetlistFmUrl(params);

        if (error) {
            return jsonResponse({ error }, 400, origin);
        }

        // Proxy the request to setlist.fm
        let setlistResponse;
        try {
            setlistResponse = await fetch(url, {
                headers: {
                    'Accept':    'application/json',
                    'x-api-key': env.SETLISTFM_API_KEY,
                },
            });
        } catch (fetchError) {
            console.error('Fetch to setlist.fm failed:', fetchError);
            return jsonResponse({ error: 'Failed to reach setlist.fm' }, 502, origin);
        }

        // Pass through the response body and status, adding our CORS headers
        const responseBody = await setlistResponse.text();
        return new Response(responseBody, {
            status: setlistResponse.status,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders(origin),
            },
        });
    },
};
/**
 * setlistfm-proxy — Cloudflare Worker
 * ====================================
 * Proxies requests to the setlist.fm REST API and Spotify Web API,
 * injecting API keys from environment variables so they never appear
 * in the frontend.
 *
 * Deploy:
 *   wrangler deploy
 *
 * Environment variables (set in Cloudflare dashboard or wrangler.toml secrets):
 *   SETLISTFM_API_KEY      — your setlist.fm API key
 *   SPOTIFY_CLIENT_ID      — your Spotify app client ID
 *   SPOTIFY_CLIENT_SECRET  — your Spotify app client secret
 *
 * Supported endpoints (all via ?endpoint=<name>):
 *
 *   ── setlist.fm ────────────────────────────────────────────────────────────
 *
 *   User attended setlists (paginated):
 *     GET /?endpoint=user-setlists&username=TragicGurl&page=1
 *     → proxies: GET /rest/1.0/user/{username}/attended?p={page}
 *
 *   Artist setlists by MBID (for band onboarding):
 *     GET /?endpoint=artist-setlists&mbid=abc-123&page=1
 *     → proxies: GET /rest/1.0/artist/{mbid}/setlists?p={page}
 *
 *   Artist search by name (returns list with MBIDs):
 *     GET /?endpoint=artist-search&name=Weezer
 *     → proxies: GET /rest/1.0/search/artists?artistName=Weezer&sort=relevance
 *
 *   Venue lookup by setlist.fm venue ID:
 *     GET /?endpoint=venue&venueId=abc123
 *     → proxies: GET /rest/1.0/venue/{venueId}
 *
 *   Single setlist by ID:
 *     GET /?endpoint=setlist&id=4b193d11
 *     → proxies: GET /rest/1.0/setlist/{id}
 *
 *   Date-filtered setlist search:
 *     GET /?endpoint=find-show&mbid=abc-123&eventDate=DD-MM-YYYY
 *     → proxies: GET /rest/1.0/search/setlists?artistMbid={mbid}&date={eventDate}
 *
 *   ── Spotify ───────────────────────────────────────────────────────────────
 *
 *   Artist lookup by name (returns id, name, url, image_url):
 *     GET /?endpoint=spotify-artist&name=Weezer
 *     → Spotify client credentials token + /v1/search?type=artist
 *
 * Response:
 *   JSON, with CORS headers added.
 *   Errors are passed through with their original status code.
 *   Worker-level errors (missing params, missing credentials) return 400/500.
 *
 * CORS:
 *   Production origin is restricted to your GitHub Pages domain.
 *   Any localhost/127.0.0.1 origin is allowed for local development (any port).
 *   Update PRODUCTION_ORIGINS in the source if your domain changes.
 */

const SETLISTFM_BASE = 'https://api.setlist.fm/rest/1.0';
const SPOTIFY_BASE   = 'https://api.spotify.com/v1';

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
        : PRODUCTION_ORIGINS[0];

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

// ─── setlist.fm route builder ─────────────────────────────────────────────────

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

    if (endpoint === 'artist-search') {
        const name = params.get('name');
        const page = params.get('page') || '1';
        if (!name) return { error: 'Missing required param: name' };
        return { url: `${SETLISTFM_BASE}/search/artists?artistName=${encodeURIComponent(name)}&sort=relevance&p=${page}` };
    }

    if (endpoint === 'find-show') {
        const mbid      = params.get('mbid');
        const eventDate = params.get('eventDate');
        const page      = params.get('p') || '1';
        if (!mbid || !eventDate) return { error: 'Missing mbid or eventDate' };
        return { url: `${SETLISTFM_BASE}/search/setlists?artistMbid=${encodeURIComponent(mbid)}&date=${eventDate}&p=${page}` };
    }

    if (endpoint === 'setlist') {
        const id = params.get('id');
        if (!id) return { error: 'Missing required param: id' };
        return { url: `${SETLISTFM_BASE}/setlist/${encodeURIComponent(id)}` };
    }

    return { error: `Unknown endpoint: "${endpoint}". Valid values: user-setlists, artist-setlists, artist-search, venue, find-show, setlist, spotify-artist` };
}

// ─── Spotify helpers ──────────────────────────────────────────────────────────

async function getSpotifyToken(env) {
    const credentials = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Spotify token request failed: ${res.status}`);
    const data = await res.json();
    return data.access_token;
}

// Normalise a name for fuzzy matching — strip punctuation, accents, case
function normaliseName(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // strip accents
        .replace(/[^a-z0-9\s]/g, '')      // strip punctuation
        .replace(/\s+/g, ' ')
        .trim();
}

async function handleSpotifyArtist(params, env, origin) {
    const name = params.get('name');
    if (!name) return jsonResponse({ error: 'Missing required param: name' }, 400, origin);

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
        console.error('Spotify credentials not configured');
        return jsonResponse({ error: 'Worker misconfigured — Spotify credentials missing' }, 500, origin);
    }

    try {
        const token = await getSpotifyToken(env);

        const res = await fetch(
            `${SPOTIFY_BASE}/search?q=${encodeURIComponent(name)}&type=artist&limit=1`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        if (!res.ok) {
            console.error(`Spotify search failed: ${res.status}`);
            return jsonResponse({ error: 'Spotify search failed' }, res.status, origin);
        }

        const data   = await res.json();
        const artist = data.artists?.items?.[0];

        if (!artist) {
            return jsonResponse({ error: 'No artist found' }, 404, origin);
        }

        // Sanity check — don't return a wildly different artist
        const normSearch = normaliseName(name);
        const normResult = normaliseName(artist.name);
        if (!normResult.includes(normSearch) && !normSearch.includes(normResult)) {
            return jsonResponse({ error: 'No confident match found' }, 404, origin);
        }

        return jsonResponse({
            id:        artist.id,
            name:      artist.name,
            url:       artist.external_urls?.spotify || null,
            image_url: artist.images?.[0]?.url       || null,
        }, 200, origin);

    } catch (err) {
        console.error('Spotify artist lookup error:', err);
        return jsonResponse({ error: 'Spotify lookup failed' }, 502, origin);
    }
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

        const params   = new URL(request.url).searchParams;
        const endpoint = params.get('endpoint');

        // ── Spotify endpoints (separate auth, handled independently) ──────────
        if (endpoint === 'spotify-artist') {
            return handleSpotifyArtist(params, env, origin);
        }

        // ── setlist.fm endpoints ──────────────────────────────────────────────
        if (!env.SETLISTFM_API_KEY) {
            console.error('SETLISTFM_API_KEY is not set in Worker environment');
            return jsonResponse({ error: 'Worker misconfigured — API key missing' }, 500, origin);
        }

        const { url, error } = buildSetlistFmUrl(params);

        if (error) {
            return jsonResponse({ error }, 400, origin);
        }

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
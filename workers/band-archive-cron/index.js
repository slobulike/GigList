/**
 * band-archive-cron — Cloudflare Worker
 * =======================================
 * Updates all band archives in the GigList Supabase database nightly.
 * For each band in the `bands` table, fetches new setlists from setlist.fm
 * and upserts performances + journals (band rows) into Supabase.
 *
 * Runs automatically on a daily cron schedule (configured in wrangler.toml).
 * Can also be triggered manually via HTTP GET — protected by a shared secret.
 *
 * Environment variables (set via `wrangler secret put`):
 *   SETLISTFM_API_KEY   — setlist.fm API key
 *   SUPABASE_URL        — your Supabase project URL
 *   SUPABASE_SERVICE_KEY — service role key (bypasses RLS for shared table writes)
 *   CRON_SECRET         — arbitrary secret to protect the manual HTTP trigger
 *
 * Manual trigger:
 *   GET https://band-archive-cron.<subdomain>.workers.dev/?secret=<CRON_SECRET>
 *   GET https://band-archive-cron.<subdomain>.workers.dev/?secret=<CRON_SECRET>&band=Weezer
 *
 * Cron trigger (set in wrangler.toml):
 *   0 2 * * *  — runs at 02:00 UTC daily
 */

const SETLISTFM_BASE = 'https://api.setlist.fm/rest/1.0';
const DELAY_MS       = 1100; // respect setlist.fm 1 req/sec rate limit

const FESTIVAL_KEYWORDS = [
    'worthy farm', 'richfield avenue', 'bramham park', 'hatfield house',
    'little john', 'victoria park', 'hyde park', 'phoenix park',
    'bellahouston', 'finsbury park', 'knebworth', 'milton keynes bowl',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toUKDate(eventDate) {
    return eventDate.replace(/-/g, '/');
}

function parseSongs(sets) {
    const songs = [];
    for (const set of sets?.set || []) {
        for (const song of set?.song || []) {
            if (song.name) songs.push(song.name);
        }
    }
    return songs.join(' | ') || null;
}

function isFestivalVenue(name) {
    const lower = name.toLowerCase();
    return FESTIVAL_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── setlist.fm fetch ─────────────────────────────────────────────────────────

async function fetchArtistPage(mbid, page, apiKey) {
    const url = `${SETLISTFM_BASE}/artist/${encodeURIComponent(mbid)}/setlists?p=${page}`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'x-api-key': apiKey },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error(`setlist.fm ${res.status} for mbid ${mbid}`);
    const data = await res.json();
    return data?.setlist?.length ? data : null;
}

// ─── Transform ────────────────────────────────────────────────────────────────

function buildRows(setlists, bandName) {
    // Group by journal key (date + venue) — same logic as setlist-sync.js
    const grouped = new Map();

    for (const sl of setlists) {
        const venue     = sl.venue || {};
        const venueName = venue.name || 'Unknown Venue';
        const dateUK    = toUKDate(sl.eventDate);
        const key       = `${dateUK}${venueName}`;
        const [d, m, y] = dateUK.split('/');
        const songs     = parseSongs(sl.sets);

        if (!grouped.has(key)) {
            grouped.set(key, {
                key, dateUK, d, m, y, venueName,
                venueCity:    sl.venue?.city?.name    || null,
                venueCountry: sl.venue?.city?.country?.name || null,
                venueLat:     sl.venue?.city?.coords?.lat   ?? null,
                venueLng:     sl.venue?.city?.coords?.long  ?? null,
                venueId:      sl.venue?.id || null,
                artists: [], perfs: [],
            });
        }

        const show = grouped.get(key);
        show.artists.push(bandName);
        show.perfs.push({
            journal_key:    key,
            artist:         bandName,
            role:           'Headline',
            setlist:        songs,
            tour:           sl.tour?.name  || null,
            setlist_url:    sl.url         || null,
            official_venue: venueName,
            date:           dateUK,
            year:           parseInt(y),
            month:          parseInt(m),
            day:            parseInt(d),
        });
    }

    const journalRows  = [];
    const perfRows     = [];
    const venueRows    = [];
    const seenVenues   = new Set();

    for (const show of grouped.values()) {
        const { key, dateUK, venueName, d, m, y } = show;
        const isFest = isFestivalVenue(venueName);

        journalRows.push({
            user_id:          null,   // band archive rows have no user_id
            journal_key:      key,
            date:             dateUK,
            band:             bandName,
            official_venue:   venueName,
            venue:            venueName,
            festival:         isFest,
            festival_lineups: null,
            notable_support:  null,
            went_with:        'The Fans',
            comments:         'Historical Artist Entry',
            photos:           null,
            price:            null,
        });

        perfRows.push(...show.perfs);

        if (!seenVenues.has(venueName)) {
            seenVenues.add(venueName);
            venueRows.push({
                official_name:     venueName,
                place_id:          show.venueId,
                city:              show.venueCity,
                country:           show.venueCountry,
                latitude:          show.venueLat,
                longitude:         show.venueLng,
                district:          null,
                capacity:          null,
                alternative_names: null,
            });
        }
    }

    return { journalRows, perfRows, venueRows };
}

// ─── Supabase writes ──────────────────────────────────────────────────────────

async function supabaseRequest(supabaseUrl, serviceKey, method, path, body = null) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method,
        headers: {
            'Content-Type':  'application/json',
            'apikey':        serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Prefer':        'return=minimal',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
    }
    return res;
}

async function upsertBatch(supabaseUrl, serviceKey, table, rows, onConflict) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'apikey':        serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
                'Prefer':        'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Supabase upsert ${table} → ${res.status}: ${text}`);
        }
    }
}

async function getExistingVenueNames(supabaseUrl, serviceKey, names) {
    if (!names.length) return new Set();
    const joined = names.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');
    const res = await fetch(
        `${supabaseUrl}/rest/v1/venues?select=official_name&official_name=in.(${encodeURIComponent(joined)})`,
        {
            headers: {
                'apikey':        serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
            },
        }
    );
    const data = await res.json();
    return new Set((data || []).map(v => v.official_name));
}

async function getExistingJournalKeys(supabaseUrl, serviceKey, keys) {
    if (!keys.length) return new Set();
    // journal_key values contain slashes and special chars — use POST body filter
    // via the "in" operator with percent-encoded list
    const joined = keys.map(k => `"${k.replace(/"/g, '\"')}"`).join(',');
    const res = await fetch(
        `${supabaseUrl}/rest/v1/journals?select=journal_key&user_id=is.null&journal_key=in.(${encodeURIComponent(joined)})`,
        {
            headers: {
                'apikey':        serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
            },
        }
    );
    const data = await res.json();
    return new Set((data || []).map(j => j.journal_key));
}

async function insertJournalsBatch(supabaseUrl, serviceKey, rows) {
    if (!rows.length) return 0;
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        await supabaseRequest(supabaseUrl, serviceKey, 'POST', 'journals', batch);
    }
    return rows.length;
}

// ─── Per-band sync ────────────────────────────────────────────────────────────

async function syncBand(band, env, log, maxPages = null, startPage = 1) {
    const { name, mbid } = band;
    log(`  → Starting ${name} (${mbid}) from page ${startPage}${maxPages ? ` (max ${maxPages} pages)` : ''}`);

    let page          = startPage;
    let totalJournals = 0;
    let totalPerfs    = 0;
    let totalVenues   = 0;
    let hasMore       = true;

    while (hasMore) {
        if (maxPages && page > maxPages) {
            log(`    reached page limit (${maxPages}) — stopping`);
            break;
        }
        let data;
        try {
            data = await fetchArtistPage(mbid, page, env.SETLISTFM_API_KEY);
        } catch (err) {
            if (err.message === 'rate_limited') {
                log(`    rate limited — waiting 30s`);
                await sleep(30000);
                data = await fetchArtistPage(mbid, page, env.SETLISTFM_API_KEY);
            } else {
                throw err;
            }
        }

        if (!data) { hasMore = false; break; }

        const { journalRows, perfRows, venueRows } = buildRows(data.setlist, name);

        // Venues — only insert new ones, never overwrite geocoded data
        const existingNames = await getExistingVenueNames(
            env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
            venueRows.map(v => v.official_name)
        );
        const newVenues = venueRows.filter(v => !existingNames.has(v.official_name));
        if (newVenues.length) {
            await upsertBatch(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
                'venues', newVenues, 'official_name');
            totalVenues += newVenues.length;
        }

        // Performances — deduplicate within the batch first.
        // setlist.fm occasionally lists the same artist twice on one show
        // (e.g. guest appearance + headline slot), which causes Postgres to
        // reject the upsert with "ON CONFLICT DO UPDATE command cannot affect
        // row a second time". Keep the last occurrence of each (journal_key, artist).
        const perfsSeen = new Map();
        for (const p of perfRows) perfsSeen.set(`${p.journal_key}||${p.artist}`, p);
        const dedupedPerfs = [...perfsSeen.values()];

        await upsertBatch(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
            'performances', dedupedPerfs, 'journal_key,artist');
        totalPerfs += perfRows.length;

        // Journals — fetch existing keys first, only insert genuinely new rows.
        // Can't use ON CONFLICT because the partial unique index (where user_id is null)
        // is not usable as a PostgREST upsert target.
        const existingKeys = await getExistingJournalKeys(
            env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
            journalRows.map(j => j.journal_key)
        );
        const newJournals = journalRows.filter(j => !existingKeys.has(j.journal_key));
        if (newJournals.length) {
            await insertJournalsBatch(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, newJournals);
        }
        totalJournals += newJournals.length;

        log(`    page ${page}: ${journalRows.length} shows, ${perfRows.length} perfs, ${newVenues.length} new venues`);

        page++;
        await sleep(DELAY_MS);
    }

    // Update last_synced on the band row
    await supabaseRequest(
        env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
        'PATCH',
        `bands?name=eq.${encodeURIComponent(name)}`,
        { last_synced: new Date().toISOString() }
    );

    log(`  ✓ ${name}: ${totalJournals} shows, ${totalPerfs} perfs, ${totalVenues} new venues across ${page - 1} pages`);
    return { name, totalJournals, totalPerfs, totalVenues, pages: page - 1 };
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run(env, bandFilter = null, maxPages = null, startPage = 1) {
    const logs    = [];
    const log     = msg => { logs.push(msg); console.log(msg); };
    const results = [];

    log(`Band archive cron started at ${new Date().toISOString()}`);
    if (maxPages) log(`  (manual trigger — limited to ${maxPages} pages per band)`);

    // Fetch all bands (or a single band if manually triggered with ?band=Name)
    const bandQuery = bandFilter
        ? `bands?select=name,mbid&name=eq.${encodeURIComponent(bandFilter)}`
        : 'bands?select=name,mbid&order=rank';

    const bandsRes = await fetch(`${env.SUPABASE_URL}/rest/v1/${bandQuery}`, {
        headers: {
            'apikey':        env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
    });

    const bands = await bandsRes.json();

    if (!bands?.length) {
        log('No bands found — nothing to sync.');
        return { logs, results };
    }

    log(`Found ${bands.length} band(s) to sync: ${bands.map(b => b.name).join(', ')}`);

    for (const band of bands) {
        if (!band.mbid) {
            log(`  ⚠ Skipping ${band.name} — no MBID set`);
            continue;
        }
        try {
            const result = await syncBand(band, env, log, maxPages, startPage);
            results.push(result);
        } catch (err) {
            log(`  ✗ ${band.name} failed: ${err.message}`);
            results.push({ name: band.name, error: err.message });
        }
        // Pause between bands to be kind to setlist.fm
        await sleep(2000);
    }

    log(`Cron complete at ${new Date().toISOString()}`);
    return { logs, results };
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
    // Manual HTTP trigger — protected by CRON_SECRET
    async fetch(request, env) {
        // Allow CORS from anywhere — the secret provides all the protection needed
        const corsHeaders = {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const params = new URL(request.url).searchParams;
        const secret = params.get('secret');

        if (!secret || secret !== env.CRON_SECRET) {
            return new Response('Unauthorized', { status: 401, headers: corsHeaders });
        }

        const bandFilter = params.get('band') || null;
        // maxPages: optional cap on pages per invocation (omit for unlimited).
        // startPage: resume a sync from a given page (default 1).
        // Example — sync Frank Turner pages 1-20:
        //   ?secret=X&band=Frank+Turner&maxPages=20
        // Example — resume from page 21:
        //   ?secret=X&band=Frank+Turner&startPage=21&maxPages=20
        const maxPagesParam = params.get('maxPages');
        const maxPages  = maxPagesParam ? parseInt(maxPagesParam, 10) : null;
        const startPage = parseInt(params.get('startPage') || '1', 10);

        try {
            const { logs, results } = await run(env, bandFilter, maxPages, startPage);
            return new Response(JSON.stringify({ ok: true, logs, results }, null, 2), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }
    },

    // Scheduled cron trigger — runs on the schedule in wrangler.toml
    async scheduled(event, env, ctx) {
        ctx.waitUntil(run(env));
    },
};
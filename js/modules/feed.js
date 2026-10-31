/**
 * GigList - Feed Module
 * v3.0.0 — Oct 2026
 *
 * Contextual feed engine. Evaluates card triggers against the user's journal
 * each time the Feed tab is activated, picks the top cards by score, and
 * renders them inline.
 *
 * v3 changes the PRESENTATION only. Card builders, scoring and selection are
 * unchanged. The top card becomes a swipable Spotlight hero; the rest are
 * grouped into image rows, a poster rail, venue tiles and an item rail, using
 * the same components as community-feed.js. See RENDERING below.
 *
 * ─── CARD TYPES ───────────────────────────────────────────────────────────────
 *
 * Personal (Phase 1):
 *   on_this_day        — exact day+month match in a past year
 *   artist_story       — artist with 3+ shows, full timeline overview.
 *                         Only surfaces in the month of the most recent show.
 *   artist_first       — first time seeing an artist (3+ shows). Only
 *                         surfaces in the month of that first show.
 *   artist_milestone   — 5th / 10th / 15th / 20th / 25th / 30th show. Only
 *                         surfaces in the month of that milestone show.
 *   artist_cities      — seen an artist in 3+ distinct cities
 *   artist_era         — densest 3-year cluster of shows for an artist
 *   venue_chapter      — 4+ visits to the same venue
 *   first_last         — artists seen exactly once or twice
 *   season_flashback   — shows from this calendar month in past years
 *
 * artist_story / artist_first / artist_milestone / first_last all check
 * isFestival() on their anchor gig and swap "seeing them" / "Show(s)" for
 * "going" / "Visit(s)" wording when the entry is a festival, not a band.
 *
 * Collection (Phase 1):
 *   collection_band_story   — band you've seen live + items in your collection
 *   collection_this_month   — items acquired this month in past years
 *
 * Social (Phase 2):
 *   buddy_recent_show   — a buddy went to a show in the last 30 days (you weren't
 *                         there). Hero is the buddy's own uploaded photo if they
 *                         have one, else the usual artist / fallback image.
 *   buddy_together      — your show today's anniversary, buddy was there too
 *   buddy_recent_collection     — buddy added something to their collection in the last
 *                         30 days (one card per buddy, newest item featured)
 *   buddy_collection_this_month — buddy added a collection item this month, in a past year
 *   buddy_on_this_day   — buddy had a solo show this month, 5+ years ago
 *   buddy_near_miss     — you + buddy same venue, current calendar month + same year, different show
 *   buddy_venue_echo    — you + buddy same venue, any month/year, different show
 *   buddy_collection_together   — buddy has collection items for a band you've seen live
 *
 * ─── SCORING REFERENCE ────────────────────────────────────────────────────────
 *
 *   100  on_this_day (personal)
 *    98  buddy_recent_show (drops 0.1/day over its 30-day window)
 *    95  buddy_together
 *    96  buddy_recent_collection (drops 0.1/day over its 30-day window)
 *    93  buddy_collection_this_month
 *    91  buddy_on_this_day
 *    90  collection_this_month
 *    75  artist_story / artist_milestone (with anniversary bonus)
 *    75  collection_band_story
 *    68  buddy_near_miss
 *    65  artist_milestone (non-anniversary)
 *    65  buddy_collection_together
 *    62  artist_first
 *    58  artist_cities
 *    55  artist_era
 *    55  buddy_venue_echo
 *    52  venue_chapter
 *    50  season_flashback
 *    47  first_last (2 shows)
 *    45  first_last (1 show)
 *
 * Scores above still decide display order (highest first) and which type
 * gets first pick each round in selectCards(), but no longer gate whether a
 * card is shown at all — see selectCards() for the round-robin selection.
 */

import { parseDate, slugify, slugifyArtist, escapeHtml, safeUrl } from './utils.js';
import { supabase } from './supabase.js';

const RECENT_SHOW_WINDOW_DAYS = 30;   // how long a buddy's show stays in the feed
const MAX_RECENT_SHOW_CARDS   = 6;    // feed-wide cap on buddy_recent_show candidates
const RECENT_COLLECTION_WINDOW_DAYS = 30;   // how long a buddy's new collection item stays in the feed
import { startNewPuzzle, setPuzzleDifficulty, resetPuzzleImage } from './games.js';
import { buildTipDiscoveryCards, renderTipDiscoveryCard } from './tip-nudges.js';
import { renderEmptyStateTips } from './tip-nudges.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CARD_LIMIT = 15;   // cap on total cards shown in one feed load

const DEFAULT_IMAGES = [
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800',
    'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800',
    'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800',
];

// ─── SEED UTILITIES ───────────────────────────────────────────────────────────

function seededRng(seed) {
    let s = seed >>> 0;
    return function () {
        s += 0x6D2B79F5;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seededShuffle(arr, seed) {
    const rng  = seededRng(seed);
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function todaySeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function gigDay(g)   { return Number(g.Date.split('/')[0]); }
function gigMonth(g) { return Number(g.Date.split('/')[1]); }
function gigYear(g)  { return Number(g.Date.split('/')[2]); }

// True for a festival gig, so wording can say "going" / "visits" instead of
// "seeing them" / "shows". Handles both the raw Supabase shape (boolean
// `festival`) and the normalised shape used elsewhere (`'Festival?': 'Y'/'N'`).
function isFestival(g) {
    if (!g) return false;
    if (typeof g.festival === 'boolean') return g.festival;
    return g['Festival?'] === 'Y';
}

// ─── BUDDY JOURNAL FETCH ──────────────────────────────────────────────────────

/**
 * Fetches a lightweight subset of every buddy's journal in a single Supabase
 * query — only the six fields the feed engine needs.
 *
 * Returns: { [userId]: [ { 'Journal Key', Date, Band, OfficialVenue, Photos } ] }
 * (`Photos` is the buddy's own photo-album link, if they added one.)
 *
 * Stored on window._buddyJournalsByUser so subsequent feed activations
 * within the same session skip the network call.
 */
// journals.date is stored as 'DD/MM/YYYY' (legacy import) OR 'YYYY-MM-DD'
// (Grab Gig / newer entries). The rest of the app, including window.journalData
// and the photo filename convention, uses DD/MM/YYYY, so normalise here —
// otherwise the newest shows (the ISO ones) silently fail every date check.
function normaliseJournalDate(raw) {
    if (!raw || raw === 'nan') return raw;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : raw;
}

async function fetchBuddyJournals() {
    const buddies = window._following || [];
    if (!buddies.length) return {};

    if (window._buddyJournalsByUser) return window._buddyJournalsByUser;

    const buddyIds = buddies.map(b => b.id);

    try {
        const { data, error } = await supabase
            .from('journals')
            .select('id, user_id, journal_key, date, band, official_venue, photos')
            .in('user_id', buddyIds);

        if (error) {
            console.warn('[Feed] buddy journal fetch failed:', error.message);
            return {};
        }

        // Normalise to the same field shape as window.journalData so all
        // card builders can use identical accessors on both datasets.
        const byUser = {};
        for (const row of (data || [])) {
            if (!byUser[row.user_id]) byUser[row.user_id] = [];
            byUser[row.user_id].push({
                JournalId:     row.id,
                'Journal Key': row.journal_key,
                Date:          normaliseJournalDate(row.date),
                Band:          row.band,
                OfficialVenue: row.official_venue,
                Photos:        row.photos,
            });
        }

        window._buddyJournalsByUser = byUser;
        return byUser;

    } catch (e) {
        console.warn('[Feed] buddy journal fetch exception:', e.message);
        return {};
    }
}

/**
 * Fetches a lightweight subset of every buddy's collection in a single
 * Supabase query. RLS already grants buddies read access to `collection_items`
 * (same pattern as fetchBuddyJournals above, just a different table).
 *
 * Returns: { [userId]: [ { id, type, title, band_name, acquired_date, photos, created_at } ] }
 *
 * Stored on window._buddyCollectionItemsByUser so subsequent feed activations
 * within the same session skip the network call.
 */
async function fetchBuddyCollectionItems() {
    const buddies = window._following || [];
    if (!buddies.length) return {};

    if (window._buddyCollectionItemsByUser) return window._buddyCollectionItemsByUser;

    const buddyIds = buddies.map(b => b.id);

    try {
        // created_at = when the item was ADDED (acquired_date is often years ago).
        // If the column isn't there the query errors, so retry without it —
        // the existing buddy collection cards keep working, and
        // buddy_recent_collection simply has nothing to show.
        let { data, error } = await supabase
            .from('collection_items')
            .select('id, user_id, type, title, band_name, acquired_date, photos, created_at')
            .in('user_id', buddyIds);

        if (error) {
            console.warn('[Feed] buddy collection fetch with created_at failed, retrying without:', error.message);
            ({ data, error } = await supabase
                .from('collection_items')
                .select('id, user_id, type, title, band_name, acquired_date, photos')
                .in('user_id', buddyIds));
        }

        if (error) {
            console.warn('[Feed] buddy collection fetch failed:', error.message);
            return {};
        }

        const byUser = {};
        for (const row of (data || [])) {
            if (!byUser[row.user_id]) byUser[row.user_id] = [];
            byUser[row.user_id].push({
                id:            row.id,
                type:          row.type,
                title:         row.title,
                band_name:     row.band_name,
                acquired_date: row.acquired_date,
                photos:        row.photos,
                created_at:    row.created_at || null,
            });
        }

        window._buddyCollectionItemsByUser = byUser;
        return byUser;

    } catch (e) {
        console.warn('[Feed] buddy collection fetch exception:', e.message);
        return {};
    }
}

// ─── PERSONAL CARD BUILDERS ───────────────────────────────────────────────────

function buildCards(journalData, performanceData) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDay   = today.getDate();
    const todayMonth = today.getMonth() + 1;
    const thisYear   = today.getFullYear();
    const thisMonth  = today.getMonth() + 1;

    const pastGigs = journalData.filter(g => {
        const d = parseDate(g.Date);
        return d && d < today;
    });

    const cards = [];

    // ── ON THIS DAY ──────────────────────────────────────────────────────────
    // One card per matching show so multiple anniversaries all surface.
    const onThisDayGigs = pastGigs.filter(g => {
        if (g.Date.split('/').length !== 3) return false;
        return gigDay(g) === todayDay && gigMonth(g) === todayMonth && gigYear(g) < thisYear;
    }).sort((a, b) => gigYear(b) - gigYear(a));

    const onThisDayArtists = new Set(onThisDayGigs.map(g => g.Band));

    onThisDayGigs.forEach((primary, idx) => {
        const yearsAgo = thisYear - gigYear(primary);
        cards.push({
            type:       'on_this_day',
            score:      100 - idx * 2,
            gig:        primary,
            allGigs:    onThisDayGigs,
            headline:   primary.Band,
            subline:    `${primary.OfficialVenue} · ${primary.Date}`,
            eyebrow:    `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago today`,
            badge:      'On This Day',
            badgeColor: 'bg-rose-500',
            journalKey: primary['Journal Key'],
        });
    });

    // ── PER-ARTIST CARDS ─────────────────────────────────────────────────────
    const showsByArtist = {};
    pastGigs.forEach(g => {
        if (!g.Band) return;
        if (!showsByArtist[g.Band]) showsByArtist[g.Band] = [];
        showsByArtist[g.Band].push(g);
    });

    Object.entries(showsByArtist)
        .sort((a, b) => b[1].length - a[1].length)
        .forEach(([artist, shows]) => {
            const sorted = [...shows].sort((a, b) => {
                const da = parseDate(a.Date) || new Date(0);
                const db = parseDate(b.Date) || new Date(0);
                return da - db;
            });

            const first    = sorted[0];
            const last     = sorted[sorted.length - 1];
            const festival = isFestival(first);

            const hasAnniversary   = sorted.some(g => gigDay(g) === todayDay && gigMonth(g) === todayMonth);
            const anniversaryBonus = hasAnniversary ? 15 : 0;

            // ARTIST STORY (3+ shows) — full timeline overview. Gated to the
            // current month (the most recent show's month) so a band's story
            // doesn't surface at a random, unrelated time of year.
            if (sorted.length >= 3 && gigMonth(last) === thisMonth) {
                const yearSpan = gigYear(last) - gigYear(first);
                const base     = onThisDayArtists.has(artist) ? 55 : 70;
                const noun     = festival ? 'visits' : 'shows';
                cards.push({
                    type:       'artist_story',
                    score:      base + anniversaryBonus,
                    gig:        last,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    yearSpan > 0
                        ? `${sorted.length} ${noun} across ${yearSpan} year${yearSpan !== 1 ? 's' : ''}`
                        : `${sorted.length} ${noun}`,
                    eyebrow:    'Your History',
                    badge:      `${sorted.length} ${festival ? 'Visits' : 'Shows'}`,
                    badgeColor: 'bg-indigo-500',
                    journalKey: last['Journal Key'],
                });
            }

            // ARTIST FIRST (3+ shows) — origin story. Gated to the current
            // month (the first show's month) for the same reason.
            if (sorted.length >= 3 && gigMonth(first) === thisMonth) {
                const yearsAgo = thisYear - gigYear(first);
                cards.push({
                    type:       'artist_first',
                    score:      62 + anniversaryBonus,
                    gig:        first,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    `${first.OfficialVenue} · ${first.Date}`,
                    eyebrow:    `First time ${festival ? 'going' : 'seeing them'} — ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago`,
                    badge:      festival ? 'First Visit' : 'First Show',
                    badgeColor: 'bg-emerald-500',
                    journalKey: first['Journal Key'],
                });
            }

            // ARTIST MILESTONE — 5th, 10th, 15th, 20th, 25th, 30th. Gated to
            // the current month (the milestone show's own month).
            [5, 10, 15, 20, 25, 30].forEach((n, nIdx) => {
                if (sorted.length >= n) {
                    const mg = sorted[n - 1];
                    if (gigMonth(mg) !== thisMonth) return;
                    const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
                    cards.push({
                        type:       'artist_milestone',
                        score:      65 + anniversaryBonus - nIdx * 3,
                        gig:        mg,
                        allGigs:    sorted,
                        headline:   artist,
                        subline:    `${mg.OfficialVenue} · ${mg.Date}`,
                        eyebrow:    `Your ${n}${suffix} time ${festival ? 'going' : 'seeing them'}`,
                        badge:      `${festival ? 'Visit' : 'Show'} #${n}`,
                        badgeColor: 'bg-violet-500',
                        journalKey: mg['Journal Key'],
                    });
                }
            });

            // ARTIST CITIES (4+ shows, 3+ distinct cities)
            if (sorted.length >= 4) {
                const cities = [...new Set(sorted.map(g => {
                    const parts = (g.OfficialVenue || '').split(',');
                    return parts.length > 1 ? parts[parts.length - 1].trim() : g.OfficialVenue;
                }))].filter(Boolean);

                if (cities.length >= 3) {
                    cards.push({
                        type:       'artist_cities',
                        score:      58 + anniversaryBonus,
                        gig:        last,
                        allGigs:    sorted,
                        headline:   artist,
                        subline:    `${festival ? 'Been to' : 'Seen in'} ${cities.length} different places`,
                        eyebrow:    festival ? 'You\u2019ve gone all over for it' : 'You followed them everywhere',
                        badge:      `${cities.length} Cities`,
                        badgeColor: 'bg-sky-500',
                        journalKey: last['Journal Key'],
                    });
                }
            }

            // ARTIST ERA — densest 3-year window
            if (sorted.length >= 4) {
                let bestStart = 0, bestCount = 0;
                for (let i = 0; i < sorted.length; i++) {
                    const wy    = gigYear(sorted[i]);
                    const count = sorted.filter(g => gigYear(g) >= wy && gigYear(g) <= wy + 2).length;
                    if (count > bestCount) { bestCount = count; bestStart = i; }
                }
                if (bestCount >= 3 && bestCount < sorted.length) {
                    const eraStart = gigYear(sorted[bestStart]);
                    const eraGigs  = sorted.filter(g => gigYear(g) >= eraStart && gigYear(g) <= eraStart + 2);
                    const rep      = eraGigs[Math.floor(eraGigs.length / 2)];
                    cards.push({
                        type:       'artist_era',
                        score:      55 + anniversaryBonus,
                        gig:        rep,
                        allGigs:    eraGigs,
                        headline:   artist,
                        subline:    `${bestCount} ${festival ? 'visits' : 'shows'} between ${eraStart} and ${eraStart + 2}`,
                        eyebrow:    'Your peak era',
                        badge:      `${eraStart}–${eraStart + 2}`,
                        badgeColor: 'bg-orange-500',
                        journalKey: rep['Journal Key'],
                    });
                }
            }

            // FIRST / LAST — artists seen exactly once or twice
            if (sorted.length === 1) {
                const gig = sorted[0];
                cards.push({
                    type:       'first_last',
                    score:      45 + anniversaryBonus,
                    gig,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    `${gig.OfficialVenue} · ${gig.Date}`,
                    eyebrow:    'The one and only time',
                    badge:      festival ? 'One Visit' : 'One Show',
                    badgeColor: 'bg-slate-500',
                    journalKey: gig['Journal Key'],
                });
            }

            if (sorted.length === 2) {
                const yearsAgo = thisYear - gigYear(last);
                cards.push({
                    type:       'first_last',
                    score:      47 + anniversaryBonus,
                    gig:        last,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    `${festival ? 'Last visited' : 'Last seen at'} ${last.OfficialVenue} · ${last.Date}`,
                    eyebrow:    `${festival ? 'Been twice' : 'Seen twice'}${yearsAgo > 0 ? `, ${yearsAgo} years ago` : ''}`,
                    badge:      festival ? 'Two Visits' : 'Two Shows',
                    badgeColor: 'bg-slate-500',
                    journalKey: last['Journal Key'],
                });
            }
        });

    // ── SEASON FLASHBACK ─────────────────────────────────────────────────────
    const seasonGigs = pastGigs.filter(g => {
        if (g.Date.split('/').length !== 3) return false;
        return gigMonth(g) === thisMonth && gigYear(g) < thisYear &&
               !(gigDay(g) === todayDay && gigMonth(g) === todayMonth);
    }).sort((a, b) => (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0));

    if (seasonGigs.length >= 2) {
        const monthName = today.toLocaleString('default', { month: 'long' });
        const featured  = seededShuffle(seasonGigs, todaySeed())[0];
        cards.push({
            type:       'season_flashback',
            score:      50,
            gig:        featured,
            allGigs:    seasonGigs,
            headline:   featured.Band,
            subline:    `${featured.OfficialVenue} · ${featured.Date}`,
            eyebrow:    `Your ${monthName} in music`,
            badge:      `${seasonGigs.length} ${monthName} Show${seasonGigs.length !== 1 ? 's' : ''}`,
            badgeColor: 'bg-amber-500',
            journalKey: featured['Journal Key'],
        });
    }

    // ── VENUE CHAPTER ─────────────────────────────────────────────────────────
    const showsByVenue = {};
    pastGigs.forEach(g => {
        if (!g.OfficialVenue) return;
        if (!showsByVenue[g.OfficialVenue]) showsByVenue[g.OfficialVenue] = [];
        showsByVenue[g.OfficialVenue].push(g);
    });

    const eligibleVenues = Object.entries(showsByVenue)
        .filter(([, shows]) => shows.length >= 4)
        .sort((a, b) => {
            const aM = a[1].some(g => gigMonth(g) === thisMonth);
            const bM = b[1].some(g => gigMonth(g) === thisMonth);
            if (aM && !bM) return -1;
            if (!aM && bM) return 1;
            return b[1].length - a[1].length;
        });

    if (eligibleVenues.length > 0) {
        const venueIdx              = Math.floor(seededRng(todaySeed())() * Math.min(eligibleVenues.length, 5));
        const [venueName, venueShows] = eligibleVenues[venueIdx];
        const venueSorted           = [...venueShows].sort((a, b) =>
            (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0)
        );
        const firstYear = gigYear(venueSorted[0]);
        const lastYear  = gigYear(venueSorted[venueSorted.length - 1]);
        const heroGig   = venueSorted[venueSorted.length - 1];

        cards.push({
            type:       'venue_chapter',
            score:      52,
            gig:        heroGig,
            allGigs:    venueSorted,
            headline:   venueName,
            subline:    lastYear > firstYear
                ? `${venueShows.length} shows · ${firstYear}–${lastYear}`
                : `${venueShows.length} shows in ${firstYear}`,
            eyebrow:    'Your favourite room',
            badge:      `${venueShows.length} Visits`,
            badgeColor: 'bg-teal-500',
            journalKey: heroGig['Journal Key'],
        });
    }

    return cards;
}

// ─── COLLECTION CARD BUILDERS ─────────────────────────────────────────────────

function buildCollectionCards(collectionItems, journalData) {
    if (!collectionItems?.length) return [];

    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth = today.getMonth() + 1;
    const thisYear  = today.getFullYear();
    const monthName = today.toLocaleString('default', { month: 'long' });
    const cards     = [];

    // COLLECTION: THIS MONTH OVER THE YEARS
    const thisMonthItems = collectionItems.filter(item => {
        if (!item.acquired_date) return false;
        const parts = item.acquired_date.split('-');
        return parseInt(parts[1] || '0', 10) === thisMonth &&
               parseInt(parts[0], 10) < thisYear;
    }).sort((a, b) => (b.acquired_date || '').localeCompare(a.acquired_date || ''));

    if (thisMonthItems.length > 0) {
        const featured = thisMonthItems[0];
        const yearsAgo = thisYear - parseInt(featured.acquired_date.split('-')[0], 10);
        cards.push({
            type:           'collection_this_month',
            score:          90,
            collectionItem: featured,
            allItems:       thisMonthItems,
            headline:       featured.title,
            subline:        `${featured.band_name ? featured.band_name + ' · ' : ''}Added ${_formatAcquiredDate(featured.acquired_date)}`,
            eyebrow:        `In your collection ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago this month`,
            badge:          `${thisMonthItems.length} ${monthName} Pick${thisMonthItems.length !== 1 ? 's' : ''}`,
            badgeColor:     'bg-amber-500',
            journalKey:     `col_month_${featured.id}`,
        });
    }

    // COLLECTION: BAND CROSSOVER
    const bandCounts = {};
    collectionItems.forEach(item => {
        if (!item.band_name) return;
        bandCounts[item.band_name] = (bandCounts[item.band_name] || 0) + 1;
    });

    const gigBands        = new Set(journalData.map(g => (g.Band || '').toLowerCase()));
    const crossoverBands  = Object.entries(bandCounts)
        .filter(([name]) => gigBands.has(name.toLowerCase()))
        .sort((a, b) => b[1] - a[1]);

    if (crossoverBands.length > 0) {
        const [bandName, itemCount] = crossoverBands[0];
        const bandItems = collectionItems.filter(i =>
            (i.band_name || '').toLowerCase() === bandName.toLowerCase()
        );
        const gigCount = journalData.filter(g =>
            (g.Band || '').toLowerCase() === bandName.toLowerCase()
        ).length;

        cards.push({
            type:           'collection_band_story',
            score:          75,
            collectionItem: bandItems[0],
            allItems:       bandItems,
            headline:       bandName,
            subline:        `${gigCount} show${gigCount !== 1 ? 's' : ''} · ${itemCount} item${itemCount !== 1 ? 's' : ''} in your collection`,
            eyebrow:        'Band deep cut',
            badge:          `${itemCount} Item${itemCount !== 1 ? 's' : ''}`,
            badgeColor:     'bg-indigo-500',
            journalKey:     `col_band_${bandName.replace(/[^a-z0-9]/gi, '_')}`,
        });
    }

    return cards;
}

function _formatAcquiredDate(raw) {
    if (!raw) return '';
    const parts  = raw.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (parts.length >= 2 && parts[1]) {
        const m = parseInt(parts[1], 10);
        return `${months[m - 1] || parts[1]} ${parts[0]}`;
    }
    return parts[0];
}

// ─── BUDDY CARD BUILDERS ──────────────────────────────────────────────────────

/**
 * Four social card types, all built from buddy journal data already in memory
 * after fetchBuddyJournals() runs.
 *
 * buddy_together:     My on-this-day show where one or more buddies' journal
 *                     keys overlap. One consolidated card per show, listing
 *                     every attending buddy — not one card per buddy.
 *                     Uses window._buddyJournalKeys — zero extra DB work.
 *
 * buddy_on_this_day:  Buddy had a solo show in this calendar month, at least
 *                     5 years ago. Matches the whole month rather than the
 *                     exact day — exact-day anniversaries are rare, and this
 *                     card exists to keep buddy content flowing frequently,
 *                     not to mark a single date.
 *
 * buddy_near_miss:    Same venue, current calendar month AND same year,
 *                     different show — "you were both in this room, weeks
 *                     apart." The tight version of a venue overlap.
 *
 * buddy_venue_echo:   Same venue, any month/year in history, different show.
 *                     The loose sibling of buddy_near_miss for when nothing
 *                     lines up as tightly.
 *
 * Neither of the last two ever fires for a show you actually both attended —
 * that's buddy_together's territory. "Same show" is detected by Journal Key
 * (date + venue), so any gig either of you logged with a matching key is
 * excluded from both sides before the venue comparison happens.
 */
function buildBuddyCards(buddyJournalsByUser, myJournalData, buddyProfiles) {
    if (!buddyProfiles?.length || !Object.keys(buddyJournalsByUser).length) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDay   = today.getDate();
    const todayMonth = today.getMonth() + 1;
    const thisYear   = today.getFullYear();

    // window._buddyJournalKeys is populated by buddies.js — it's a map of
    // { [buddyId]: Set<journalKey> } for shows they attended.
    const buddyJournalKeys = window._buddyJournalKeys || {};

    // Venue → my past gigs lookup for near-miss/echo matching
    const myVenueMap = {};
    myJournalData.forEach(g => {
        if (!g.OfficialVenue) return;
        const d = parseDate(g.Date);
        if (!d || d >= today) return;
        if (!myVenueMap[g.OfficialVenue]) myVenueMap[g.OfficialVenue] = [];
        myVenueMap[g.OfficialVenue].push(g);
    });

    const cards = [];

    // Near-miss/echo candidates are collected across ALL buddies first, then
    // deduped by venue and capped feed-wide — see MAX_NEAR_MISS_CARDS /
    // MAX_ECHO_CARDS below. Without this, a heavily-used venue (arenas,
    // festival grounds) can throw a card for every buddy who's ever played
    // it, flooding the feed with the lowest-value social card types.
    const nearMissCandidates = [];
    const echoCandidates     = [];
    const venuesClaimed      = new Set();

    // Track which of my journal keys have been claimed by buddy_together so
    // selectCards() can suppress the plain on_this_day duplicate for the same show.
    const togetherKeys = new Set();

    // ── BUDDY RECENT SHOW ─────────────────────────────────────────────────────
    // A buddy went to a show in the last RECENT_SHOW_WINDOW_DAYS days and I
    // wasn't there. One card per show (not per buddy) — if three buddies went
    // to the same gig it's one card listing all three. Shows I also logged are
    // skipped: I know about those already, and buddy_together owns them.
    // Starts the day AFTER the show (d < today), matching the planned push.
    const myJournalKeys = new Set(myJournalData.map(g => g['Journal Key']));
    const recentByKey   = new Map();

    buddyProfiles.forEach(buddy => {
        (buddyJournalsByUser[buddy.id] || []).forEach(g => {
            if (!g.Date || g.Date.split('/').length !== 3) return;
            const d = parseDate(g.Date);
            if (!d || d >= today) return;
            const daysAgo = Math.round((today - d) / 86400000);
            if (daysAgo > RECENT_SHOW_WINDOW_DAYS) return;
            const key = g['Journal Key'];
            if (!key || myJournalKeys.has(key)) return;
            if (!recentByKey.has(key)) recentByKey.set(key, { gig: g, daysAgo, buddies: [], jids: [] });
            recentByKey.get(key).buddies.push(buddy);
            recentByKey.get(key).jids.push(g.JournalId);
        });
    });

    // Used below to keep a just-happened show out of near-miss / venue-echo,
    // so one buddy show doesn't produce two cards.
    const recentKeys = new Set(recentByKey.keys());

    [...recentByKey.entries()]
        .sort((a, b) => a[1].daysAgo - b[1].daysAgo)
        .slice(0, MAX_RECENT_SHOW_CARDS)
        .forEach(([key, { gig, daysAgo, buddies, jids }]) => {
            const names = buddies.map(b => b.display_name || b.username || 'Your buddy');
            const namesJoined = names.length <= 2
                ? names.join(' and ')
                : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
            const when = daysAgo === 1 ? 'yesterday'
                       : daysAgo < 7  ? `${daysAgo} days ago`
                       : daysAgo < 14 ? 'last week'
                       :                `${Math.floor(daysAgo / 7)} weeks ago`;

            cards.push({
                type:        'buddy_recent_show',
                score:       98 - Math.min(daysAgo, RECENT_SHOW_WINDOW_DAYS) * 0.1,
                gig,
                allGigs:     [gig],
                buddies,
                buddy:       buddies[0],
                buddyName:   namesJoined,
                headline:    gig.Band,
                subline:     `${gig.OfficialVenue} · ${gig.Date}`,
                eyebrow:     `${namesJoined} · ${when}`,
                badge:       'Just Back',
                badgeColor:  'bg-emerald-500',
                journalKey:  `buddy_recent_${key}`,
                reactTargets: jids.filter(Boolean).map(id => ({ type: 'journal', id })),
            });
        });

    // ── BUDDY TOGETHER (one consolidated card per show, not per buddy) ────────
    // My on-this-day anniversaries where one or more buddies were also there.
    // A show with 5 buddies at it gets 1 card listing all 5, not 5 cards.
    const myOnThisDay = myJournalData.filter(g => {
        if (g.Date.split('/').length !== 3) return false;
        const d = parseDate(g.Date);
        return d && d < today &&
               gigDay(g) === todayDay &&
               gigMonth(g) === todayMonth &&
               gigYear(g) < thisYear;
    });

    myOnThisDay.forEach(myGig => {
        const key = myGig['Journal Key'];
        const attendingBuddies = buddyProfiles.filter(b => (buddyJournalKeys[b.id] || new Set()).has(key));
        if (!attendingBuddies.length) return;

        togetherKeys.add(key);
        // Reactions land on the BUDDIES' journal rows (they're the ones to
        // be notified), one per attending buddy.
        const togetherJids = attendingBuddies
            .map(b => (buddyJournalsByUser[b.id] || []).find(g => g['Journal Key'] === key)?.JournalId)
            .filter(Boolean);
        const yearsAgo = thisYear - gigYear(myGig);
        const names    = attendingBuddies.map(b => b.display_name || b.username || 'Your buddy');
        const namesJoined = names.length <= 2
            ? names.join(' and ')
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

        cards.push({
            type:        'buddy_together',
            score:       95,
            gig:         myGig,
            allGigs:     [myGig],
            buddies:     attendingBuddies,
            buddy:       attendingBuddies[0],
            buddyName:   namesJoined,
            headline:    myGig.Band,
            subline:     `${myGig.OfficialVenue} · ${myGig.Date}`,
            eyebrow:     `You and ${namesJoined} were there`,
            badge:       `${yearsAgo} Year${yearsAgo !== 1 ? 's' : ''} Ago`,
            badgeColor:  'bg-rose-500',
            journalKey:  `together_${key}`,
            reactTargets: togetherJids.map(id => ({ type: 'journal', id })),
            reactVariant: 'shared',
        });
    });

    buddyProfiles.forEach(buddy => {
        const buddyName    = buddy.display_name || buddy.username || 'Your buddy';
        const buddyGigs    = buddyJournalsByUser[buddy.id] || [];
        const sharedKeySet = buddyJournalKeys[buddy.id] || new Set();

        if (!buddyGigs.length) return;

        // ── BUDDY ON THIS DAY ──────────────────────────────────────────────
        // Buddy had a show in this calendar month, at least 5 years ago,
        // that I didn't share. Month-wide rather than exact-day so there's a
        // much bigger candidate pool per buddy — this is meant to keep the
        // feed full, not to mark a single anniversary date.
        const buddyOnThisDay = buddyGigs.filter(g => {
            if (!g.Date || g.Date.split('/').length !== 3) return false;
            const d = parseDate(g.Date);
            return d && d < today &&
                   gigMonth(g) === todayMonth &&
                   gigYear(g) <= thisYear - 5 &&
                   !sharedKeySet.has(g['Journal Key']);
        }).sort((a, b) => gigYear(b) - gigYear(a));

        // Up to 2 cards per buddy so a prolific buddy doesn't flood the feed
        buddyOnThisDay.slice(0, 2).forEach((bg, idx) => {
            const yearsAgo = thisYear - gigYear(bg);
            cards.push({
                type:        'buddy_on_this_day',
                score:       91 - idx * 2,
                gig:         bg,
                allGigs:     [bg],
                buddy,
                buddyName,
                headline:    bg.Band,
                subline:     `${bg.OfficialVenue} · ${bg.Date}`,
                eyebrow:     `${buddyName} · ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago this month`,
                badge:       'Throwback',
                badgeColor:  'bg-rose-400',
                journalKey:  `buddy_otd_${buddy.id}_${bg['Journal Key']}`,
                reactTargets: bg.JournalId ? [{ type: 'journal', id: bg.JournalId }] : [],
            });
        });

        // ── BUDDY NEAR MISS + VENUE ECHO ────────────────────────────────────
        // Group this buddy's past gigs by venue, then compare against my own
        // history at the same venue — excluding any gig either of us logged
        // that matches the other's Journal Key (date + venue), since that's
        // literally the same show, i.e. buddy_together territory, not a miss.
        const buddyVenueGigsByVenue = {};
        buddyGigs.forEach(g => {
            if (!g.OfficialVenue) return;
            if (recentKeys.has(g['Journal Key'])) return;   // owned by buddy_recent_show
            const d = parseDate(g.Date);
            if (!d || d >= today) return;
            if (!buddyVenueGigsByVenue[g.OfficialVenue]) buddyVenueGigsByVenue[g.OfficialVenue] = [];
            buddyVenueGigsByVenue[g.OfficialVenue].push(g);
        });

        Object.entries(buddyVenueGigsByVenue).forEach(([venueName, buddyVenueGigsAll]) => {
            const myVenueGigsAll = myVenueMap[venueName] || [];
            if (!myVenueGigsAll.length) return;
            if (venuesClaimed.has(venueName)) return; // feed-wide dedup across both types

            // Strip out any show that's actually shared between us (same
            // Journal Key = same date + venue = the same real-world show).
            // Computed as a single intersection up front, then applied to
            // BOTH sides — computing myGigsHere first and deriving
            // buddyGigsHere from its (already-filtered) keys let a shared
            // show survive on the buddy's side whenever I had other, unshared
            // gigs at the same venue, which is exactly the "three-night run,
            // shared one night" case that was slipping through.
            const myKeysAll     = new Set(myVenueGigsAll.map(g => g['Journal Key']));
            const buddyKeysAll  = new Set(buddyVenueGigsAll.map(g => g['Journal Key']));
            const sharedKeys    = new Set([...myKeysAll].filter(k => buddyKeysAll.has(k)));
            const myGigsHere    = myVenueGigsAll.filter(g => !sharedKeys.has(g['Journal Key']));
            const buddyGigsHere = buddyVenueGigsAll.filter(g => !sharedKeys.has(g['Journal Key']));

            if (!myGigsHere.length || !buddyGigsHere.length) return;

            // NEAR MISS — tight match: same venue, same month AND year as each
            // other, AND that month has to be the current calendar month —
            // otherwise a May/May match or a July/July match surfaces year
            // round instead of feeling like a timely "this month" moment.
            const nearMissGig = myGigsHere.find(mg =>
                gigMonth(mg) === todayMonth &&
                buddyGigsHere.some(bg => gigMonth(bg) === gigMonth(mg) && gigYear(bg) === gigYear(mg))
            );

            if (nearMissGig) {
                venuesClaimed.add(venueName);
                const monthName = new Date(2000, gigMonth(nearMissGig) - 1, 1)
                    .toLocaleString('default', { month: 'long' });

                nearMissCandidates.push({
                    type:        'buddy_near_miss',
                    score:       68,
                    gig:         nearMissGig,
                    allGigs:     myGigsHere,
                    buddy,
                    buddyName,
                    headline:    venueName,
                    subline:     `You and ${buddyName} · same venue, different night`,
                    eyebrow:     `${monthName} ${gigYear(nearMissGig)} · near miss`,
                    badge:       'Near Miss',
                    badgeColor:  'bg-cyan-600',
                    journalKey:  `nearmiss_${buddy.id}_${venueName.replace(/[^a-z0-9]/gi, '_')}_${gigYear(nearMissGig)}_${gigMonth(nearMissGig)}`,
                    // used only for ranking candidates below, stripped before render
                    _overlapCount: myGigsHere.length + buddyGigsHere.length,
                });
                return; // don't also throw the looser echo for the same venue/buddy
            }

            // VENUE ECHO — loose match: same venue, any month/year in history.
            venuesClaimed.add(venueName);
            const heroGig = [...myGigsHere].sort((a, b) =>
                (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0)
            )[0];

            echoCandidates.push({
                type:        'buddy_venue_echo',
                score:       55,
                gig:         heroGig,
                allGigs:     myGigsHere,
                buddy,
                buddyName,
                headline:    venueName,
                subline:     `You and ${buddyName} · same room, different night`,
                eyebrow:     'Somewhere you\u2019ve both been',
                badge:       'Venue Echo',
                badgeColor:  'bg-cyan-500',
                journalKey:  `echo_${buddy.id}_${venueName.replace(/[^a-z0-9]/gi, '_')}`,
                // used only for ranking candidates below, stripped before render
                _overlapCount: myGigsHere.length + buddyGigsHere.length,
            });
        });
    });

    // Cap both types feed-wide, favoring venues with more combined history
    // between the two of you. Left uncapped, a heavily-shared venue history
    // (or a very active buddy) could drown out the rest of the buddy cards.
    const MAX_NEAR_MISS_CARDS = 2;
    const MAX_ECHO_CARDS      = 2;

    nearMissCandidates
        .sort((a, b) => b._overlapCount - a._overlapCount)
        .slice(0, MAX_NEAR_MISS_CARDS)
        .forEach(c => { delete c._overlapCount; cards.push(c); });

    echoCandidates
        .sort((a, b) => b._overlapCount - a._overlapCount)
        .slice(0, MAX_ECHO_CARDS)
        .forEach(c => { delete c._overlapCount; cards.push(c); });

    // Expose the set of "claimed" on-this-day keys so selectCards() can filter
    // the plain duplicates.
    window._feedTogetherKeys = togetherKeys;

    return cards;
}

/**
 * Two social collection card types, built from buddy collection data already
 * in memory after fetchBuddyCollectionItems() runs. Mirrors the personal
 * collection_band_story / collection_this_month logic, but cross-referenced
 * against a buddy's collection instead of your own.
 *
 * buddy_collection_together:   Buddy has collection items for a band you've
 *                               also seen live — shared fandom discovery.
 *
 * buddy_collection_this_month: Buddy added something to their collection this
 *                               calendar month, in a past year.
 */
function buildBuddyCollectionCards(buddyCollectionItemsByUser, myJournalData, buddyProfiles) {
    if (!buddyProfiles?.length || !Object.keys(buddyCollectionItemsByUser).length) return [];

    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth = today.getMonth() + 1;
    const thisYear  = today.getFullYear();
    const monthName = today.toLocaleString('default', { month: 'long' });

    const gigBands = new Set(myJournalData.map(g => (g.Band || '').toLowerCase()));
    const cards    = [];

    buddyProfiles.forEach(buddy => {
        const buddyName  = buddy.display_name || buddy.username || 'Your buddy';
        const buddyItems = buddyCollectionItemsByUser[buddy.id] || [];
        if (!buddyItems.length) return;

        // ── BUDDY RECENT COLLECTION ──────────────────────────────────────────
        // Buddy ADDED something in the last RECENT_COLLECTION_WINDOW_DAYS days
        // (keyed off created_at, not acquired_date). One card per buddy so a
        // bulk add doesn't flood the feed: the newest item is featured and the
        // rest are counted in the badge/subline.
        const recentItems = buddyItems
            .map(item => {
                if (!item.created_at) return null;
                const added = new Date(item.created_at);
                if (isNaN(added)) return null;
                added.setHours(0, 0, 0, 0);
                const daysAgo = Math.round((today - added) / 86400000);
                return (daysAgo >= 0 && daysAgo <= RECENT_COLLECTION_WINDOW_DAYS)
                    ? { item, daysAgo, ts: new Date(item.created_at).getTime() }
                    : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.ts - a.ts);

        if (recentItems.length > 0) {
            const { item: featured, daysAgo } = recentItems[0];
            const count = recentItems.length;
            const when  = daysAgo === 0 ? 'today'
                        : daysAgo === 1 ? 'yesterday'
                        : daysAgo < 7   ? `${daysAgo} days ago`
                        : daysAgo < 14  ? 'last week'
                        :                 `${Math.floor(daysAgo / 7)} weeks ago`;

            cards.push({
                type:           'buddy_recent_collection',
                score:          96 - Math.min(daysAgo, RECENT_COLLECTION_WINDOW_DAYS) * 0.1,
                collectionItem: featured,
                allItems:       recentItems.map(r => r.item),
                buddy,
                buddyName,
                headline:       featured.title,
                subline:        `${featured.band_name ? featured.band_name + ' · ' : ''}${count > 1 ? `+${count - 1} more added recently` : 'just added to their collection'}`,
                eyebrow:        `${buddyName} · ${when}`,
                badge:          count > 1 ? `${count} New Items` : 'New Find',
                badgeColor:     'bg-orange-500',
                journalKey:     `col_buddy_recent_${buddy.id}_${featured.id}`,
                reactTargets:   [{ type: 'collection_item', id: featured.id }],
            });
        }

        // ── BUDDY COLLECTION TOGETHER ────────────────────────────────────────
        // Buddy owns collection items for a band you've also seen live.
        const bandCounts = {};
        buddyItems.forEach(item => {
            if (!item.band_name) return;
            bandCounts[item.band_name] = (bandCounts[item.band_name] || 0) + 1;
        });

        const crossoverBands = Object.entries(bandCounts)
            .filter(([name]) => gigBands.has(name.toLowerCase()))
            .sort((a, b) => b[1] - a[1]);

        if (crossoverBands.length > 0) {
            const [bandName, itemCount] = crossoverBands[0];
            const bandItems = buddyItems.filter(i =>
                (i.band_name || '').toLowerCase() === bandName.toLowerCase()
            );

            cards.push({
                type:           'buddy_collection_together',
                score:          65,
                collectionItem: bandItems[0],
                allItems:       bandItems,
                buddy,
                buddyName,
                headline:       bandName,
                subline:        `${buddyName} has ${itemCount} item${itemCount !== 1 ? 's' : ''} in their collection`,
                eyebrow:        `${buddyName} · shared fandom`,
                badge:          `${itemCount} Item${itemCount !== 1 ? 's' : ''}`,
                badgeColor:     'bg-indigo-400',
                journalKey:     `col_together_${buddy.id}_${bandName.replace(/[^a-z0-9]/gi, '_')}`,
            });
        }

        // ── BUDDY COLLECTION THIS MONTH ──────────────────────────────────────
        // Buddy acquired something this calendar month, in a past year.
        const thisMonthItems = buddyItems.filter(item => {
            if (!item.acquired_date) return false;
            const parts = item.acquired_date.split('-');
            return parseInt(parts[1] || '0', 10) === thisMonth &&
                   parseInt(parts[0], 10) < thisYear;
        }).sort((a, b) => (b.acquired_date || '').localeCompare(a.acquired_date || ''));

        if (thisMonthItems.length > 0) {
            const featured = thisMonthItems[0];
            const yearsAgo = thisYear - parseInt(featured.acquired_date.split('-')[0], 10);

            cards.push({
                type:           'buddy_collection_this_month',
                score:          93,
                collectionItem: featured,
                allItems:       thisMonthItems,
                buddy,
                buddyName,
                headline:       featured.title,
                subline:        `${featured.band_name ? featured.band_name + ' · ' : ''}${buddyName} added ${_formatAcquiredDate(featured.acquired_date)}`,
                eyebrow:        `${buddyName} · ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago this month`,
                badge:          `${monthName} Pick`,
                badgeColor:     'bg-amber-400',
                journalKey:     `col_buddy_month_${buddy.id}_${featured.id}`,
            });
        }
    });

    return cards;
}

// ─── CARD SELECTION ───────────────────────────────────────────────────────────

/**
 * Merges all pools, deduplicates, suppresses on_this_day cards superseded by
 * buddy_together, then does one round-robin pass per card type (best-scoring
 * types first each pass) so the feed has variety instead of a handful of
 * types (e.g. first_last, which tends to have far more candidates than
 * anything else) crowding everything out. Capped at CARD_LIMIT overall.
 */
function selectCards(gigCards, colCards, buddyCards) {
    const togetherKeys = window._feedTogetherKeys || new Set();

    // Suppress plain on_this_day cards where buddy_together already owns the show
    const all = [...gigCards, ...colCards, ...buddyCards].filter(c =>
        !(c.type === 'on_this_day' && togetherKeys.has(c.gig?.['Journal Key']))
    );

    // Deduplicate: keep highest-scoring card per journalKey
    const seen = new Map();
    for (const card of all) {
        const key = card.journalKey;
        if (!seen.has(key) || card.score > seen.get(key).score) {
            seen.set(key, card);
        }
    }

    // Group remaining candidates by type, best score first within each group
    const byType = new Map();
    for (const card of seen.values()) {
        if (!byType.has(card.type)) byType.set(card.type, []);
        byType.get(card.type).push(card);
    }
    for (const group of byType.values()) {
        group.sort((a, b) => b.score - a.score);
    }

    // Types ordered by their best available card, so the strongest types get
    // first pick each round. A type drops out of the rotation once its pool
    // is empty; the loop stops once CARD_LIMIT is hit or every pool is dry.
    const typeOrder = [...byType.keys()].sort(
        (a, b) => byType.get(b)[0].score - byType.get(a)[0].score
    );

    const selected = [];
    let stillHasCards = true;
    while (selected.length < CARD_LIMIT && stillHasCards) {
        stillHasCards = false;
        for (const type of typeOrder) {
            if (selected.length >= CARD_LIMIT) break;
            const group = byType.get(type);
            if (group.length) {
                selected.push(group.shift());
                stillHasCards = true;
            }
        }
    }

    return selected.sort((a, b) => b.score - a.score);
}

// ─── IMAGE RESOLUTION ─────────────────────────────────────────────────────────
// The feed's artwork pipeline (the `_art` / `hydrateArt` helpers) lives in the
// RENDERING section. This section holds the storage lookups it builds on, plus
// resolveHeroImage(), which the buddy show view still uses.

const PHOTO_INDEX_TTL_MS = 3 * 60 * 1000;   // a photo uploaded mid-session shows up within minutes
const _photoIndex      = new Map();         // ownerId -> { at, names: Promise<Set<fileName>> }
const _signedPhotoUrls = new Map();         // `${ownerId}/${fileName}` -> { url, exp }

// One listing per owner folder (cached), instead of one list() call per image.
// The feed now shows many small tiles, so per-image lookups would fan out.
function _gigPhotoNames(ownerId) {
    const hit = _photoIndex.get(ownerId);
    if (hit && Date.now() - hit.at < PHOTO_INDEX_TTL_MS) return hit.names;
    const names = (async () => {
        const out = new Set();
        try {
            for (let page = 0; page < 5; page++) {
                const { data, error } = await supabase.storage
                    .from('gig-photos')
                    .list(ownerId, { limit: 1000, offset: page * 1000 });
                if (error || !data?.length) break;
                data.forEach(f => out.add(f.name));
                if (data.length < 1000) break;
            }
        } catch (e) { /* treat as no photos */ }
        return out;
    })();
    _photoIndex.set(ownerId, { at: Date.now(), names });
    return names;
}

// Call after uploading or deleting a show photo so the feed sees it straight away.
window._feedInvalidatePhotos = () => { _photoIndex.clear(); _signedPhotoUrls.clear(); };

/**
 * Looks for a user-uploaded photo of a show in the `gig-photos` bucket, where
 * files live at `{ownerId}/{date}-{venue}.jpg`. Tries each owner in order and
 * returns the first signed URL found, or null.
 *
 * Reading a BUDDY's folder needs a buddy-read SELECT policy on storage.objects
 * for the bucket; without it list() just comes back empty and callers fall
 * through to the artist / fallback image.
 */
async function findGigPhotoUrl(ownerIds, fileName) {
    for (const ownerId of ownerIds) {
        if (!ownerId) continue;
        try {
            if (!(await _gigPhotoNames(ownerId)).has(fileName)) continue;
            const path   = `${ownerId}/${fileName}`;
            const cached = _signedPhotoUrls.get(path);
            if (cached && cached.exp > Date.now()) return cached.url;
            const { data, error } = await supabase.storage
                .from('gig-photos')
                .createSignedUrl(path, 3600);
            if (!error && data?.signedUrl) {
                _signedPhotoUrls.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
                return data.signedUrl;
            }
        } catch (e) { /* try next owner */ }
    }
    return null;
}

async function resolveHeroImage(gig, imgEl, cardIndex, ownerIds) {
    if (!gig?.Date || !gig?.OfficialVenue) {
        imgEl.src = DEFAULT_IMAGES[cardIndex % DEFAULT_IMAGES.length];
        return;
    }

    const [d, m, y]     = gig.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue    = gig.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const fileName      = `${formattedDate}-${cleanVenue}.jpg`;
    const scrapbookPath = `assets/scrapbook/${fileName}`;
    const artistPath    = `assets/artists/${(gig.Band || '').toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;
    const fallback      = DEFAULT_IMAGES[cardIndex % DEFAULT_IMAGES.length];

    const tryLocal = () => {
        const probe = new Image();
        probe.onload  = () => { imgEl.src = scrapbookPath; };
        probe.onerror = () => {
            const ap = new Image();
            ap.onload  = () => { imgEl.src = artistPath; };
            ap.onerror = () => { imgEl.src = fallback; };
            ap.src = artistPath;
        };
        probe.src = scrapbookPath;
    };

    const owners = ownerIds?.length ? ownerIds : [window.currentUser?.id];
    const photoUrl = await findGigPhotoUrl(owners, fileName);
    if (photoUrl) { imgEl.src = photoUrl; return; }

    tryLocal();
}


// ─── BUDDY AVATAR PILL ────────────────────────────────────────────────────────

/**
 * Renders a tiny inline avatar + name pill for the card eyebrow.
 * Falls back to initials if the avatar URL fails to load.
 *
 * Accepts either a single buddy or an array of buddies (buddy_together cards
 * with multiple attendees) — arrays render as a stacked, overlapping group
 * capped at 3 visible avatars plus a "+N" overflow badge.
 */
function buddyAvatarPill(buddyOrBuddies, opts = {}) {
    const buddies = (Array.isArray(buddyOrBuddies) ? buddyOrBuddies : [buddyOrBuddies]).filter(Boolean);
    if (!buddies.length) return '';

    const visible  = buddies.slice(0, 3);
    const overflow = buddies.length - visible.length;
    const stacked   = buddies.length > 1;
    const ring      = opts.ring || 'ring-slate-900';          // ring colour to match the surface behind
    const spacing   = opts.spacing ?? 'mr-1.5';

    const avatarHtml = visible.map((buddy, i) => {
        const name     = buddy.display_name || buddy.username || '';
        const initials = name.slice(0, 2).toUpperCase();
        const ringClass = (stacked || opts.ring) ? `ring-2 ${ring}` : '';
        const avatarSrc = safeUrl(buddy.avatar_url);
        const imgTag   = avatarSrc
            ? `<img src="${escapeHtml(avatarSrc)}"
                    alt="${escapeHtml(name)}"
                    class="w-5 h-5 rounded-full object-cover flex-shrink-0 ${ringClass}"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : '';
        const fallback = `<span class="w-5 h-5 rounded-full bg-indigo-200 text-indigo-700 text-[8px] font-black
                               flex items-center justify-center flex-shrink-0 ${ringClass}
                               ${avatarSrc ? 'hidden' : ''}">${escapeHtml(initials)}</span>`;
        return `<span class="inline-flex ${stacked && i > 0 ? '-ml-2' : ''}">${imgTag}${fallback}</span>`;
    }).join('');

    const overflowHtml = overflow > 0
        ? `<span class="w-5 h-5 rounded-full bg-slate-700 text-white text-[8px] font-black
                   flex items-center justify-center flex-shrink-0 ring-2 ${ring} -ml-2">+${overflow}</span>`
        : '';

    return `<span class="inline-flex items-center ${spacing}">${avatarHtml}${overflowHtml}</span>`;
}

// ─── BUDDY COLLECTION NAVIGATION ──────────────────────────────────────────────

/**
 * Tap target for buddy_recent_collection / buddy_collection_together / buddy_collection_this_month
 * cards. There's no read-only single-item viewer for a buddy's collection
 * item, so instead of trying to build one, this reuses the existing buddy
 * drill-in panel and jumps straight to its Collection tab.
 */

window._feedOpenBuddyCollection = async (buddyId, buddyName) => {
    if (!buddyId || typeof window.openBuddyDrillIn !== 'function') return;

    // Open the buddy profile modal
    window.openBuddyDrillIn(buddyId, buddyName);

    // Guarantee buddy collection items are fetched before rendering the tab
    if (typeof fetchBuddyCollectionItems === 'function') {
        await fetchBuddyCollectionItems();
    }

    // Switch to the collection tab
    if (typeof window._buddySwitchTab === 'function') {
        window._buddySwitchTab('collection');
    }
};

// ─── REACTIONS ────────────────────────────────────────────────────────────────
// A reaction is a small commitment, not engagement: seeing a buddy's show and
// tapping "Wish I was there" or "Next time, together" is the first step
// towards actually going. One reaction per person per show/item (tapping a
// different one switches it, tapping the same one removes it). Reactions are
// never counted or listed to other people — only the owner is told (phase 2).
//
// Reactions attach to the underlying row (journals.id / collection_items.id),
// not the card, so they follow the show wherever it appears. State is kept in
// window._myReactions and applied to the DOM after every render, so cached
// card HTML never holds stale state. If the `reactions` table isn't there yet
// the whole UI quietly doesn't render (window._reactionsAvailable stays false).

const REACTION_KINDS = {
    like:     { label: 'Love it',             icon: 'heart'    },
    wish:     { label: 'Wish I was there',    icon: 'sparkles' },
    together: { label: 'Next time, together', icon: 'users'    },
    again:    { label: "Let's do this again", icon: 'repeat'   },
};
// Keyed by target type, or `${type}_${variant}` when the card passes a
// reactVariant. 'shared' = a show both people attended (buddy_together):
// "Love it" / "Wish I was there" make no sense there, so it gets the single
// "Let's do this again" button instead of the tray.
const REACTION_KINDS_FOR = {
    journal:         ['like', 'wish', 'together'],
    journal_shared:  ['again'],
    collection_item: ['like'],
};
const REACT_BTN_BASE = 'inline-flex items-center justify-center w-8 h-8 rounded-full border transition-colors';
const REACT_OPT_BASE = 'flex w-full items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider whitespace-nowrap transition-colors';
const REACT_STYLES = {
    dark: {   // on photo cards: tray opens upwards
        idle: 'border-white/25 text-white/70 hover:bg-white/10',
        active: 'bg-white border-white text-slate-900',
        tray: 'bg-slate-900/95 border border-white/15 backdrop-blur',
        optIdle: 'text-white/70 hover:bg-white/10',
        optOn: 'bg-white text-slate-900',
        pos: 'bottom-full mb-2',
    },
    light: {  // in the white buddy show modal: tray opens downwards
        idle: 'border-slate-200 text-slate-500 hover:bg-slate-50',
        active: 'bg-indigo-600 border-indigo-600 text-white',
        tray: 'bg-white border border-slate-200',
        optIdle: 'text-slate-600 hover:bg-slate-50',
        optOn: 'bg-indigo-600 text-white',
        pos: 'top-full mt-2',
    },
};

const _reactKey = (type, id) => `${type === 'journal' ? 'j' : 'c'}:${id}`;

// Single-flight: concurrent callers (feed init + a cold-start deep link) share
// one request. A failed load is not cached, so the next caller retries.
let _reactionsPromise = null;
function fetchMyReactions() {
    if (window._reactionsAvailable) return Promise.resolve(window._myReactions);
    return (_reactionsPromise ??= _loadMyReactions().finally(() => { _reactionsPromise = null; }));
}

async function _loadMyReactions() {
    window._myReactions ??= new Map();
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const uid = session?.user?.id;
        if (!uid) return window._myReactions;
        const { data, error } = await supabase
            .from('reactions')
            .select('journal_id, collection_item_id, kind')
            .eq('user_id', uid);
        if (error) {
            console.warn('[Feed] reactions unavailable:', error.message);
            return window._myReactions;
        }
        window._myReactionsUid   = uid;
        window._reactionsAvailable = true;
        for (const r of (data || [])) {
            const key = r.journal_id != null
                ? _reactKey('journal', r.journal_id)
                : _reactKey('collection_item', r.collection_item_id);
            window._myReactions.set(key, r.kind);
        }
    } catch (e) {
        console.warn('[Feed] reactions fetch exception:', e.message);
    }
    return window._myReactions;
}

/**
 * One small round button. Tapping it opens a tray of labelled options
 * (shows: Love it / Wish I was there / Next time, together). Once reacted,
 * the button shows the chosen kind's icon, filled in. Items with only one
 * kind (collection) skip the tray: the button IS the reaction.
 *
 * targets: [{ type: 'journal' | 'collection_item', id }] — one per underlying row
 * align:   which edge the tray hangs from — 'right' for buttons at the right of a row
 */
function renderReactionRow(targets, theme = 'dark', variant = '', align = 'left') {
    if (window._reactionsAvailable !== true || !targets?.length) return '';
    const type  = targets[0].type;
    const kinds = REACTION_KINDS_FOR[variant ? `${type}_${variant}` : type] || [];
    const ids   = targets.map(t => t.id).filter(Boolean);
    if (!ids.length || !kinds.length) return '';
    const st = REACT_STYLES[theme] || REACT_STYLES.dark;

    const rowAttrs = `data-react-row data-react-type="${escapeHtml(type)}" data-react-ids="${escapeHtml(ids.join(','))}" data-react-theme="${escapeHtml(theme)}" data-react-default="${escapeHtml(kinds[0])}"`;
    const icon = (k) => `<span data-react-icon="${k}" class="${k === kinds[0] ? '' : 'hidden'}"><i data-lucide="${REACTION_KINDS[k].icon}" class="w-4 h-4" aria-hidden="true"></i></span>`;

    if (kinds.length === 1) {
        const k = kinds[0];
        return `
            <div class="relative" ${rowAttrs}>
                <button type="button" data-react-kind="${k}" aria-pressed="false"
                        aria-label="${escapeHtml(REACTION_KINDS[k].label)}" title="${escapeHtml(REACTION_KINDS[k].label)}"
                        class="${REACT_BTN_BASE} ${st.idle}">${icon(k)}</button>
            </div>`;
    }

    return `
        <div class="relative" ${rowAttrs}>
            <button type="button" data-react-toggle aria-haspopup="true" aria-expanded="false"
                    aria-label="React to this show" title="React"
                    class="${REACT_BTN_BASE} ${st.idle}">${kinds.map(icon).join('')}</button>
            <div data-react-tray role="group" aria-label="React"
                 class="hidden absolute ${align === 'right' ? 'right-0' : 'left-0'} ${st.pos} z-20 min-w-[12rem] rounded-2xl p-1.5 shadow-xl ${st.tray}">
                ${kinds.map(k => `
                <button type="button" data-react-kind="${k}" aria-pressed="false" class="${REACT_OPT_BASE} ${st.optIdle}">
                    <i data-lucide="${REACTION_KINDS[k].icon}" class="w-4 h-4" aria-hidden="true"></i>${escapeHtml(REACTION_KINDS[k].label)}
                </button>`).join('')}
            </div>
        </div>`;
}

function _rowReactionKind(row) {
    const type = row.dataset.reactType;
    for (const id of (row.dataset.reactIds || '').split(',')) {
        const k = window._myReactions?.get(_reactKey(type, id));
        if (k) return k;
    }
    return null;
}

function applyReactionState(root = document) {
    root.querySelectorAll('[data-react-row]').forEach(row => {
        const st      = REACT_STYLES[row.dataset.reactTheme] || REACT_STYLES.dark;
        const current = _rowReactionKind(row);

        // The round button: filled when reacted, showing the chosen kind's icon
        const main = row.querySelector('[data-react-toggle]') || row.querySelector('[data-react-kind]');
        if (main) {
            main.className = `${REACT_BTN_BASE} ${current ? st.active : st.idle}`;
            if (main.hasAttribute('data-react-kind')) main.setAttribute('aria-pressed', String(!!current));
            // Show the chosen kind's icon; fall back to the row's default if
            // the row has no icon for it (e.g. a 'like' saved elsewhere on a
            // row that only offers 'again').
            const def   = row.dataset.reactDefault || 'like';
            const shown = current && row.querySelector(`[data-react-icon="${current}"]`) ? current : def;
            main.querySelectorAll('[data-react-icon]').forEach(el =>
                el.classList.toggle('hidden', el.dataset.reactIcon !== shown));
        }

        // Tray options: highlight the one currently chosen
        row.querySelectorAll('[data-react-tray] [data-react-kind]').forEach(btn => {
            const on = btn.dataset.reactKind === current;
            btn.setAttribute('aria-pressed', String(on));
            btn.className = `${REACT_OPT_BASE} ${on ? st.optOn : st.optIdle}`;
        });
    });
}

// One save in flight per card, so a double-tap can't race an upsert against
// a delete and leave the server disagreeing with the UI.
const _reactInflight = new Set();

async function toggleReaction(row, kind) {
    if (!window._reactionsAvailable || !window._myReactionsUid) return;
    const lock = `${row.dataset.reactType}:${row.dataset.reactIds}`;
    if (_reactInflight.has(lock)) return;
    _reactInflight.add(lock);
    try { await _saveReaction(row, kind); }
    finally { _reactInflight.delete(lock); }
}

async function _saveReaction(row, kind) {
    const type = row.dataset.reactType;
    const col  = type === 'journal' ? 'journal_id' : 'collection_item_id';
    const ids  = (row.dataset.reactIds || '').split(',').filter(Boolean);
    const dbId = (id) => (type === 'journal' ? Number(id) : id);

    const current = _rowReactionKind(row);
    const next    = current === kind ? null : kind;
    const before  = ids.map(id => [id, window._myReactions.get(_reactKey(type, id)) ?? null]);
    const setLocal = (id, k) => {
        const key = _reactKey(type, id);
        if (k) window._myReactions.set(key, k); else window._myReactions.delete(key);
    };

    // Optimistic: update everywhere this show appears (card + open modal)
    ids.forEach(id => setLocal(id, next));
    applyReactionState(document);

    try {
        const uid = window._myReactionsUid;
        const { error } = next
            ? await supabase.from('reactions').upsert(
                ids.map(id => ({ user_id: uid, [col]: dbId(id), kind: next })),
                { onConflict: `user_id,${col}` })
            : await supabase.from('reactions').delete().eq('user_id', uid).in(col, ids.map(dbId));
        if (error) throw error;
    } catch (e) {
        console.warn('[Feed] reaction save failed:', e.message);
        before.forEach(([id, k]) => setLocal(id, k));
        applyReactionState(document);
        window.showToast?.('Couldn\'t save that — try again', 'error');
    }
}

function _closeReactTrays(except) {
    document.querySelectorAll('[data-react-tray]').forEach(tray => {
        if (tray === except) return;
        tray.classList.add('hidden');
        tray.parentElement?.querySelector('[data-react-toggle]')?.setAttribute('aria-expanded', 'false');
    });
}

// One delegated listener for feed cards AND the buddy show modal. Registered
// once at import time so reactions work however the view was opened.
// Tap the round button → tray opens. Tap an option → saved, tray closes.
// Tap anywhere else (or press Escape) → tray closes.
if (typeof document !== 'undefined' && !window._reactClickWired) {
    window._reactClickWired = true;

    document.addEventListener('click', (e) => {
        const kindBtn = e.target.closest?.('[data-react-kind]');
        const toggle  = e.target.closest?.('[data-react-toggle]');
        const row     = (kindBtn || toggle)?.closest('[data-react-row]');

        if (row && toggle) {
            e.preventDefault();
            e.stopPropagation();
            const tray    = row.querySelector('[data-react-tray]');
            const opening = tray.classList.contains('hidden');
            _closeReactTrays(tray);
            tray.classList.toggle('hidden', !opening);
            toggle.setAttribute('aria-expanded', String(opening));
            return;
        }
        if (row && kindBtn) {
            e.preventDefault();
            e.stopPropagation();
            _closeReactTrays();
            toggleReaction(row, kindBtn.dataset.reactKind);
            return;
        }
        _closeReactTrays();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _closeReactTrays();
    });
}

// ─── BUDDY SHOW VIEW ──────────────────────────────────────────────────────────

/**
 * Read-only view of a buddy's show, opened from buddy_recent_show cards in the
 * shared #modal shell. openGigModal() can't be used here: it only looks up
 * shows in the signed-in user's own journal, and it carries edit actions.
 *
 * Photo hierarchy matches the gig modal: the buddy's uploaded photo, then the
 * artist photo, then the default image (via resolveHeroImage). The buddy's
 * album link, support acts and setlist sit underneath.
 */
window._feedOpenBuddyShow = async (key, idsCsv) => {
    const ids     = String(idsCsv || '').split(',').filter(Boolean);
    let buddies   = (window._following || []).filter(b => ids.includes(b.id));
    let gig       = (window._buddyJournalsByUser?.[ids[0]] || []).find(g => g['Journal Key'] === key);
    const modal   = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    if (!modal || !content || !ids.length) return;

    // Cold start (e.g. opened from a push notification): the feed hasn't run,
    // so the buddy caches are empty. Fetch just this show directly. RLS only
    // returns it if the owner is an accepted buddy, so a stale or hand-edited
    // link can't expose anything.
    if (!gig) {
        try {
            const { data } = await supabase
                .from('journals')
                .select('id, journal_key, date, band, official_venue, photos')
                .eq('user_id', ids[0])
                .eq('journal_key', key)
                .limit(1);
            const row = data?.[0];
            if (row) {
                gig = {
                    JournalId:     row.id,
                    'Journal Key': row.journal_key,
                    Date:          normaliseJournalDate(row.date),
                    Band:          row.band,
                    OfficialVenue: row.official_venue,
                    Photos:        row.photos,
                };
            }
        } catch (e) { /* handled below */ }
    }
    if (!gig) {
        window.showToast?.('That show isn\'t available any more', 'info');
        return;
    }
    if (!buddies.length) {
        try {
            const { data } = await supabase
                .from('profiles')
                .select('id, display_name, username, avatar_url')
                .in('id', ids);
            buddies = data || [];
        } catch (e) { /* names fall back to "Your buddy" */ }
    }

    await fetchMyReactions();
    const reactTargets = [...new Set([
        gig.JournalId,
        ...ids.map(bid => (window._buddyJournalsByUser?.[bid] || []).find(g => g['Journal Key'] === key)?.JournalId),
    ].filter(Boolean))].map(id => ({ type: 'journal', id }));

    const names = buddies.map(b => b.display_name || b.username || 'Your buddy');
    const namesJoined = names.length <= 2
        ? names.join(' and ')
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

    const photosRaw = (gig.Photos || '').trim();
    const albumUrl  = (photosRaw && photosRaw !== 'nan') ? safeUrl(photosRaw) : '';

    content.innerHTML = `
        <div class="bg-white rounded-[2.5rem] overflow-hidden">
            <div class="relative h-40 md:h-56 w-full bg-slate-900">
                <img id="buddy-show-hero" src="" alt="" class="absolute inset-0 w-full h-full object-cover">
                <button onclick="window.closeModal()"
                        aria-label="Close details"
                        class="absolute top-4 right-4 z-10 bg-black/40 backdrop-blur-md text-white p-2 rounded-full hover:bg-black/60 transition-all focus:ring-2 focus:ring-white">
                    <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
                </button>
            </div>
            <div class="px-6 pt-4 pb-6 space-y-4">
                <div>
                    <span class="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">
                        ${buddyAvatarPill(buddies)}${escapeHtml(namesJoined)} ${buddies.length > 1 ? 'were' : 'was'} there
                    </span>
                    <h2 id="modal-title" tabindex="-1" class="text-2xl font-black italic uppercase tracking-tighter text-slate-900 leading-none mb-1">
                        ${escapeHtml(gig.Band)}
                    </h2>
                    <p class="text-sm font-bold text-slate-500">${escapeHtml(gig.OfficialVenue)} · ${escapeHtml(gig.Date)}</p>
                </div>
                ${albumUrl ? `
                <a href="${escapeHtml(albumUrl)}" target="_blank" rel="noopener"
                   class="inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800">
                    <i data-lucide="images" class="w-4 h-4" aria-hidden="true"></i>
                    See ${escapeHtml(names[0] || 'their')}${names.length > 1 ? ' &amp; co.' : ''}'s photos
                </a>` : ''}
                ${renderReactionRow(reactTargets, 'light')}
                <div id="buddy-show-details"></div>
            </div>
        </div>`;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
    applyReactionState(content);
    setTimeout(() => document.getElementById('modal-title')?.focus(), 100);

    const heroEl = document.getElementById('buddy-show-hero');
    if (heroEl) resolveHeroImage(gig, heroEl, 0, ids);

    // Support acts + setlist from the shared performances pool. Best-effort:
    // if the query fails or returns nothing the view is still complete.
    try {
        const { data, error } = await supabase
            .from('performances')
            .select('artist, role, setlist')
            .eq('journal_key', key);
        const target = document.getElementById('buddy-show-details');
        if (error || !data?.length || !target) return;
        if (data.some(r => r.role === 'Festival')) return;   // festival lineups get their own treatment

        const headliner = data.find(r => r.role === 'Headline') ||
                          data.find(r => (r.artist || '').toLowerCase() === (gig.Band || '').toLowerCase());
        const supports  = data.filter(r => r.role === 'Support').map(r => r.artist).filter(Boolean);
        const rawSet    = (headliner?.setlist || '').trim();
        const songs     = /^(NOT_FOUND|NO_SONGS_LISTED)$/i.test(rawSet)
            ? []
            : rawSet.split('|').map(x => x.trim()).filter(Boolean);

        target.innerHTML = `
            ${supports.length ? `<p class="text-xs font-bold text-slate-500 mb-3">with ${escapeHtml(supports.join(', '))}</p>` : ''}
            ${songs.length ? `
                <div>
                    <p class="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Setlist</p>
                    <ol class="list-decimal list-inside text-sm text-slate-700 space-y-0.5 max-h-64 overflow-y-auto pr-2">
                        ${songs.map(song => `<li>${escapeHtml(song)}</li>`).join('')}
                    </ol>
                </div>` : ''}`;
    } catch (e) { /* leave the basic view as is */ }
};

// ─── RENDERING ────────────────────────────────────────────────────────────────
// v3 layout. The feed is no longer a stack of identical dark cards. It reuses
// the component vocabulary of the Community feed:
//
//   Spotlight hero  → the day's strongest card. Swipe through the shows behind
//                     it (your photo of each, or the artist artwork).
//   Image rows      → buddy updates (with reactions) and artist / room stories
//                     (with a bar showing how many shows sit behind them).
//   Poster rail     → "your May in music": big year numerals over show photos.
//   Venue tiles     → rooms you and a buddy have both been to.
//   Item rail       → collection items, as photos.
//
// Card builders and scoring are unchanged: they still hold RAW text, and
// everything is escaped here at render time.
//
// Image chain for a show:   your photo → scrapbook → Spotify artist image →
//                           local stock photo → gradient + initials.
// The gradient + initials sit underneath every image, so a miss never leaves
// a hole. Names for these components match community-feed.js so the two
// modules can be merged later.

const CARD  = 'bg-white rounded-[2rem] border border-slate-100 shadow-sm p-5';
const H3    = 'text-xl font-black italic uppercase tracking-tighter text-slate-900';
const RAIL  = 'flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-px-5 -mx-5 px-5 pb-1 ' +
              '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const FOCUS      = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';
const FOCUS_DARK = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';
const HERO_BTN   = 'inline-flex items-center justify-center gap-2 min-h-[44px] rounded-full ' +
                   'text-[11px] font-black uppercase tracking-widest transition-all active:scale-95 ' + FOCUS_DARK;

// Literal class strings so Tailwind's scanner picks them up.
const GRADIENTS = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-rose-500 to-orange-500',
    'from-sky-500 to-indigo-600',
    'from-fuchsia-500 to-purple-600',
    'from-amber-500 to-red-500',
];

// The builders pick a saturated badge colour for dark photo cards. On white
// rows that fails contrast with white text, so map each to a tinted pill.
const PILL_TINT = {
    'bg-rose-500':    'bg-rose-50 text-rose-700',
    'bg-rose-400':    'bg-rose-50 text-rose-700',
    'bg-indigo-500':  'bg-indigo-50 text-indigo-700',
    'bg-indigo-400':  'bg-indigo-50 text-indigo-700',
    'bg-emerald-500': 'bg-emerald-50 text-emerald-700',
    'bg-violet-500':  'bg-violet-50 text-violet-700',
    'bg-sky-500':     'bg-sky-50 text-sky-700',
    'bg-cyan-600':    'bg-cyan-50 text-cyan-800',
    'bg-cyan-500':    'bg-cyan-50 text-cyan-800',
    'bg-orange-500':  'bg-orange-50 text-orange-700',
    'bg-amber-500':   'bg-amber-50 text-amber-800',
    'bg-amber-400':   'bg-amber-50 text-amber-800',
    'bg-teal-500':    'bg-teal-50 text-teal-700',
    'bg-slate-500':   'bg-slate-100 text-slate-700',
};
const _pill = (badgeColor) => PILL_TINT[badgeColor] || 'bg-slate-100 text-slate-700';

// Card type → section
const BUDDY_ROW_TYPES = new Set([
    'buddy_recent_show', 'buddy_recent_collection', 'buddy_together', 'buddy_on_this_day',
    'buddy_collection_this_month', 'buddy_collection_together',
]);
const VENUE_TILE_TYPES   = new Set(['buddy_near_miss', 'buddy_venue_echo']);
const HISTORY_ROW_TYPES  = new Set([
    'artist_story', 'artist_first', 'artist_milestone', 'artist_cities', 'artist_era',
    'first_last', 'venue_chapter', 'on_this_day',
]);
// Card types whose detail is a list of shows (opened from a toggle)
const LIST_TYPES = new Set([
    'artist_story', 'artist_first', 'artist_milestone', 'artist_cities', 'artist_era',
    'first_last', 'season_flashback', 'venue_chapter',
]);
const NUMBERED_TYPES = new Set([
    'artist_story', 'artist_first', 'artist_milestone', 'artist_cities', 'artist_era', 'first_last',
]);
// Hero types that swipe through more than their anchor show
const MULTI_SLIDE_TYPES = new Set([
    'on_this_day', 'artist_story', 'artist_cities', 'artist_era', 'venue_chapter', 'season_flashback',
]);
const MAX_HERO_SLIDES = 8;

// Social card types — carry a buddy avatar
const SOCIAL_TYPES = new Set([
    'buddy_recent_show', 'buddy_together', 'buddy_on_this_day', 'buddy_near_miss', 'buddy_venue_echo',
    'buddy_recent_collection', 'buddy_collection_together', 'buddy_collection_this_month',
]);

// Buddy collection cards tap through to the buddy's drill-in Collection tab
// rather than the gig modal — they have no journalKey gig to open.
const BUDDY_COLLECTION_TYPES = new Set([
    'buddy_recent_collection', 'buddy_collection_together', 'buddy_collection_this_month',
]);

// ─── RENDER HELPERS ───────────────────────────────────────────────────────────

const _key    = (s) => String(s ?? '').trim().toLowerCase();
const _plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Safe for text AND quoted attributes, whatever escapeHtml does with quotes.
const _attr   = (s) => escapeHtml(String(s ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}
const _grad = (name) => GRADIENTS[_hash(_key(name)) % GRADIENTS.length];

function _initials(name) {
    const parts = String(name ?? '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '♪';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Same convention the rest of the app uses for local stock artist photos.
const _localArt = (band) => `assets/artists/${String(band ?? '').toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;

const _cardKey = (card) => String(card.journalKey || card.type).replace(/[^a-z0-9]/gi, '_');
const _watchUrl = (band) => `https://www.youtube.com/results?search_query=${encodeURIComponent(band + ' live')}`;

function _showLine(g) {
    return [g.OfficialVenue, g.Date].filter(Boolean).join(' · ');
}

// Evenly spaced sample that always keeps the first and last item.
function _spread(arr, n) {
    if (arr.length <= n) return arr;
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))]);
    return [...new Set(out)];
}

// ─── ARTIST MEDIA (Spotify image + player id) ─────────────────────────────────
// Same shared-artist-facts RPC the Community feed uses: image + Spotify artist
// id from the `artists` table. Nothing user-specific. Best-effort: a failure
// just means local photos / gradients instead.

const MAX_MEDIA_NAMES = 50;
const _media      = new Map();   // lowercase band -> { image_url, spotify_artist_id }
const _mediaAsked = new Set();   // lowercase bands already requested (hit or miss)
let _mediaPending = Promise.resolve();

const _spotifyId = (band) => {
    const id = _media.get(_key(band))?.spotify_artist_id;
    return /^[A-Za-z0-9]{22}$/.test(id || '') ? id : null;
};

async function loadArtistMedia(bands) {
    const missing = [...new Set(bands.filter(Boolean))]
        .filter(b => !_mediaAsked.has(_key(b)))
        .slice(0, MAX_MEDIA_NAMES);
    if (!missing.length) return;
    try {
        const { data: rows, error } = await supabase.rpc('get_community_artist_media', { p_names: missing });
        if (error) throw error;
        missing.forEach(b => _mediaAsked.add(_key(b)));
        for (const r of rows || []) {
            const k    = _key(r.name);
            const prev = _media.get(k);
            // Duplicate artist rows can exist; keep whichever has an image.
            if (!prev || (!prev.image_url && r.image_url)) {
                _media.set(k, { image_url: r.image_url || null, spotify_artist_id: r.spotify_artist_id || null });
            }
        }
    } catch (err) {
        console.warn('[Feed] artist media failed', err);
    }
}

function _bandsForMedia(cards) {
    const out = [];
    for (const c of cards) {
        if (c.gig?.Band) out.push(c.gig.Band);
        (c.allGigs || []).slice(0, MAX_HERO_SLIDES).forEach(g => g?.Band && out.push(g.Band));
        if (c.collectionItem?.band_name) out.push(c.collectionItem.band_name);
        (c.allItems || []).slice(0, 10).forEach(i => i?.band_name && out.push(i.band_name));
    }
    return out;
}

// ─── ARTWORK ──────────────────────────────────────────────────────────────────
// _art() renders gradient + initials with an empty <img> on top and registers a
// job for it. After render, hydrateArt() resolves each job (4 at a time, hero
// first because it is first in the DOM) and sets src. The <img> fades in once
// it has loaded. `cls` must supply positioning ("relative", "absolute inset-0")
// and size.
//
// job: { kind: 'show' | 'item', gig?, item?, owners?, band }

let _artSeq = 0;
let _artJobs = new Map();
const _probeCache = new Map();

function _probe(url) {
    if (!_probeCache.has(url)) {
        _probeCache.set(url, new Promise(resolve => {
            const im = new Image();
            im.onload  = () => resolve(true);
            im.onerror = () => resolve(false);
            im.src = url;
        }));
    }
    return _probeCache.get(url);
}

function _gigFile(gig) {
    if (!gig?.Date || !gig?.OfficialVenue) return null;
    const [d, m, y] = gig.Date.split('/');
    const venue = gig.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    return `${y}-${m}-${d}-${venue}.jpg`;
}

function _art(name, cls, job = {}) {
    const id = `fa${++_artSeq}`;
    _artJobs.set(id, { band: name, ...job });
    return `
        <div class="overflow-hidden bg-gradient-to-br ${_grad(name)} ${cls}">
            <span class="absolute inset-0 flex items-center justify-center text-2xl font-black italic text-white/80" aria-hidden="true">${escapeHtml(_initials(name))}</span>
            <img data-feed-art="${id}" alt="" decoding="async"
                 class="absolute inset-0 w-full h-full object-cover opacity-0 transition-opacity duration-300 motion-reduce:transition-none">
        </div>`;
}

async function resolveArtUrl(job) {
    if (job.kind === 'item' && job.item?.photos?.length) {
        try {
            const { data, error } = await supabase.storage
                .from('collection-photos')
                .createSignedUrl(job.item.photos[0], 3600);
            if (!error && data?.signedUrl) return data.signedUrl;
        } catch (e) { /* fall through */ }
    }

    if (job.kind === 'show') {
        const file = _gigFile(job.gig);
        if (file) {
            const owners = job.owners?.length ? job.owners : [window.currentUser?.id];
            const own = await findGigPhotoUrl(owners, file);
            if (own) return own;
            const scrapbook = `assets/scrapbook/${file}`;
            if (await _probe(scrapbook)) return scrapbook;
        }
    }

    await _mediaPending;
    const spotify = safeUrl(job.gig?.SpotifyImageUrl || '') || safeUrl(_media.get(_key(job.band))?.image_url || '');
    if (spotify) return spotify;

    if (job.band) {
        const local = _localArt(job.band);
        if (await _probe(local)) return local;
    }
    return null;
}

function hydrateArt(root) {
    const imgs = [...root.querySelectorAll('img[data-feed-art]:not([data-art-started])')];
    let next = 0;
    const worker = async () => {
        while (next < imgs.length) {
            const img = imgs[next++];
            img.setAttribute('data-art-started', '');
            const job = _artJobs.get(img.dataset.feedArt);
            if (!job) continue;
            try {
                const url = await resolveArtUrl(job);
                if (!url || !img.isConnected) continue;
                // A remote image that errors steps down to the local stock photo.
                if (!url.startsWith('assets/') && job.band) img.dataset.fallback = _localArt(job.band);
                img.src = url;
            } catch (e) { /* initials stay */ }
        }
    };
    for (let i = 0; i < Math.min(4, imgs.length); i++) worker();
}

// <img> error/load events don't bubble, so these are wired in the capture phase.
function _onFeedImgError(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.feedArt === undefined) return;
    if (img.dataset.fallback) {
        const fb = img.dataset.fallback;
        delete img.dataset.fallback;
        img.src = fb;
    } else {
        img.remove();   // gradient + initials show through
    }
}
function _onFeedImgLoad(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.feedArt === undefined) return;
    img.classList.remove('opacity-0');
    img.classList.add('opacity-100');
}

// ─── TAP TARGETS ──────────────────────────────────────────────────────────────
// A tap target is a small descriptor, rendered into data-* attributes and
// dispatched by the one delegated listener (_handleFeedClick). Journal keys and
// buddy names are user-controlled text, so nothing goes into inline handlers.

function tapDesc(card, gig = card.gig) {
    if (card.type === 'buddy_recent_show') {
        return {
            k: 'bshow',
            key: gig?.['Journal Key'] || '',
            ids: (card.buddies || [card.buddy]).filter(Boolean).map(b => b.id).join(','),
        };
    }
    if (BUDDY_COLLECTION_TYPES.has(card.type)) {
        return card.buddy?.id ? { k: 'bcol', id: card.buddy.id, name: card.buddyName || '' } : null;
    }
    const key = gig?.['Journal Key'] || '';
    return key ? { k: 'gig', key } : null;
}

function tapAttrs(d) {
    if (!d) return '';
    if (d.k === 'gig')   return `data-feed-gig-key="${_attr(d.key)}"`;
    if (d.k === 'bshow') return `data-feed-buddy-show-key="${_attr(d.key)}" data-feed-buddy-show-ids="${_attr(d.ids)}"`;
    if (d.k === 'bcol')  return `data-feed-buddy-col-id="${_attr(d.id)}" data-feed-buddy-col-name="${_attr(d.name)}"`;
    return '';
}

function runTap(d) {
    if (!d) return;
    if (d.k === 'gig')   { if (d.key) window.viewGigDetails?.(d.key); }
    if (d.k === 'bshow') window._feedOpenBuddyShow(d.key, d.ids);
    if (d.k === 'bcol')  window._feedOpenBuddyCollection(d.id, d.name);
}

// Whose uploaded photo should be this card's image? Default is the signed-in
// user. Buddy cards look in the buddy's folder; a show you both attended
// checks yours first, then theirs.
function photoOwnerIds(card) {
    if (card.type === 'buddy_recent_show') {
        return (card.buddies || [card.buddy]).filter(Boolean).map(b => b.id);
    }
    if (card.type === 'buddy_together') {
        return [window.currentUser?.id, ...(card.buddies || [card.buddy]).filter(Boolean).map(b => b.id)];
    }
    if (card.type === 'buddy_on_this_day' && card.buddy?.id) return [card.buddy.id];
    return undefined;
}

function artJob(card) {
    const isItem = !!card.collectionItem && !card.gig;
    return {
        kind:   isItem ? 'item' : 'show',
        gig:    card.gig,
        item:   card.collectionItem,
        owners: photoOwnerIds(card),
        band:   card.gig?.Band || card.collectionItem?.band_name || card.headline,
    };
}

// ─── SECTION SHELL ────────────────────────────────────────────────────────────

function _head(id, title, sub = '') {
    return `
        <h3 id="${id}" class="${H3} ${sub ? 'mb-1' : 'mb-3'}">${escapeHtml(title)}</h3>
        ${sub ? `<p class="text-sm font-medium text-slate-500 mb-4">${escapeHtml(sub)}</p>` : ''}`;
}

// ─── SHOW LIST (expanded detail) ──────────────────────────────────────────────

function showListHtml(card, theme) {
    const dark    = theme === 'dark';
    const gigs    = card.allGigs || [];
    const byBand  = card.type === 'venue_chapter' || card.type === 'season_flashback' || card.type === 'on_this_day';
    const numbered = NUMBERED_TYPES.has(card.type);
    const hover   = dark ? 'hover:bg-white/10' : 'hover:bg-slate-50';
    const year    = dark ? 'text-white/60' : 'text-slate-500';
    const main    = dark ? 'text-white' : 'text-slate-800';
    const muted   = dark ? 'text-white/60' : 'text-slate-500';

    return `
        <div class="mt-4 pt-3 border-t ${dark ? 'border-white/20' : 'border-slate-100'} max-h-64 overflow-y-auto space-y-0.5">
            ${gigs.map((g, i) => `
            <button type="button" data-feed-gig-key="${_attr(g['Journal Key'] || '')}"
                    class="w-full flex items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors ${hover} ${dark ? FOCUS_DARK : FOCUS}">
                <span class="w-9 shrink-0 text-right text-[11px] font-black ${year}">${escapeHtml(String(gigYear(g)))}</span>
                <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-indigo-400" aria-hidden="true"></span>
                <span class="flex-1 min-w-0 text-xs font-bold truncate ${main}">
                    ${escapeHtml(byBand ? g.Band : g.OfficialVenue)}${card.type === 'season_flashback'
                        ? ` <span class="font-medium ${muted}">· ${escapeHtml(g.OfficialVenue || '')}</span>` : ''}
                </span>
                ${numbered ? `<span class="text-[11px] font-bold ${muted}">#${i + 1}</span>` : ''}
            </button>`).join('')}
        </div>`;
}

// ─── SPOTLIGHT HERO ───────────────────────────────────────────────────────────
// The strongest card of the day. Slide 0 is the card's own anchor show; for
// cards with more shows behind them (an anniversary run, an artist's story, a
// room's history) the next slides are those shows, newest first.

let _hero = null;   // { card, slides, idx, playing, playBand }

function buildSlides(card) {
    const social    = SOCIAL_TYPES.has(card.type);
    const name      = card.buddyName || '';
    const openLabel =
        card.type === 'buddy_recent_show'   ? (card.buddies?.length > 1 ? 'See the show' : `See ${name}\u2019s show`) :
        BUDDY_COLLECTION_TYPES.has(card.type) ? `See ${name}\u2019s collection` :
        social                               ? 'View your show' :
                                               'Open show';

    // Collection cards: slides are the items.
    if (!card.gig) {
        const items = (card.allItems || [card.collectionItem]).filter(Boolean);
        const list  = social ? items.slice(0, 1) : items.slice(0, MAX_HERO_SLIDES);
        const isBand = card.type === 'collection_band_story';
        return list.map((it, i) => ({
            kind: 'item', item: it, band: it.band_name || '',
            title:   (social || isBand) ? card.headline : it.title,
            eyebrow: card.eyebrow,
            line:    social ? card.subline
                   : isBand ? [it.title, _formatAcquiredDate(it.acquired_date)].filter(Boolean).join(' · ')
                            : [it.band_name, _formatAcquiredDate(it.acquired_date)].filter(Boolean).join(' · '),
            tap:     i === 0 ? tapDesc(card) : null,
            openLabel,
        }));
    }

    const gig = card.gig;
    const anchor = {
        kind: 'show', gig, band: gig.Band || '',
        title: card.headline, eyebrow: card.eyebrow, line: card.subline,
        tap: tapDesc(card), owners: photoOwnerIds(card), openLabel,
    };
    const slides = [anchor];
    if (!MULTI_SLIDE_TYPES.has(card.type)) return slides;

    const all      = card.allGigs || [];
    const noun     = isFestival(all[0] || gig) ? 'Visit' : 'Show';
    const thisYear = new Date().getFullYear();
    const monthName = new Date().toLocaleString('default', { month: 'long' });
    const byBandTitle = card.type === 'on_this_day' || card.type === 'season_flashback';

    const others = all.filter(g => g['Journal Key'] !== gig['Journal Key']);
    _spread(others, MAX_HERO_SLIDES - 1)
        .sort((a, b) => (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0))
        .forEach(g => {
            const idx = all.indexOf(g);
            const yrs = thisYear - gigYear(g);
            slides.push({
                kind: 'show', gig: g, band: g.Band || '',
                title:   byBandTitle ? g.Band : card.headline,
                eyebrow: card.type === 'on_this_day'     ? `${_plural(yrs, 'year', 'years')} ago today`
                       : card.type === 'season_flashback' ? `${monthName} ${gigYear(g)}`
                       :                                    `${noun} ${idx + 1} of ${all.length}`,
                line:    card.type === 'venue_chapter' ? [g.Band, g.Date].filter(Boolean).join(' · ') : _showLine(g),
                tap:     tapDesc(card, g),
                openLabel,
            });
        });
    return slides;
}

function heroSection(card) {
    const slides = buildSlides(card);
    const key    = _cardKey(card);
    _hero = { card, slides, idx: 0, playing: false, playBand: null };

    const s0     = slides[0];
    const n      = slides.length;
    const multi  = n > 1;
    const buddies = SOCIAL_TYPES.has(card.type) ? (card.buddies || (card.buddy ? [card.buddy] : [])) : [];
    const listCount = card.allGigs?.length || 0;
    const hasList = LIST_TYPES.has(card.type) && listCount > 1;

    const slideHtml = slides.map((s, i) => `
        <div class="relative shrink-0 w-full h-full snap-center ${s.tap ? 'cursor-pointer' : ''}" ${tapAttrs(s.tap)}
             ${multi ? `role="group" aria-roledescription="slide" aria-label="${_attr(`${i + 1} of ${n}`)}"` : ''}>
            ${_art(s.band || s.title, 'absolute inset-0',
                   { kind: s.kind, gig: s.gig, item: s.item, owners: s.owners, band: s.band })}
        </div>`).join('');

    const railAttrs = multi
        ? `tabindex="0" role="region" aria-roledescription="carousel" aria-label="${_attr(`${s0.title}: ${n} slides`)}"`
        : '';

    const chip = buddies.length ? `
        <div class="absolute top-4 left-4 flex items-center max-w-[70%] bg-slate-900/60 backdrop-blur-sm rounded-full pl-1 pr-3 py-1 pointer-events-none">
            ${buddyAvatarPill(buddies)}
            <span class="text-[11px] font-bold text-white truncate">${escapeHtml(card.buddyName || '')}</span>
        </div>` : '';

    const dots = multi ? `
        <div class="absolute top-4 right-4 flex gap-1.5 pointer-events-none" aria-hidden="true">
            ${slides.map((_, i) => `<span data-feed-dot class="block w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}"></span>`).join('')}
        </div>` : '';

    return `
    <section data-feed-hero data-card-type="${_attr(card.type)}" class="overflow-hidden rounded-[2rem] bg-slate-900 shadow-sm" aria-labelledby="feed-spot">
        <div class="relative h-72">
            <div data-feed-rail ${railAttrs}
                 class="absolute inset-0 flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                ${slideHtml}
            </div>
            <div class="absolute inset-0 pointer-events-none bg-gradient-to-t from-slate-900 via-slate-900/50 to-transparent"></div>
            ${chip}
            <div class="absolute inset-x-0 bottom-0 p-5 pointer-events-none">
                <p data-feed-eyebrow class="text-[10px] font-black uppercase tracking-widest text-white/70">${escapeHtml(s0.eyebrow)}</p>
                <h3 id="feed-spot" data-feed-title class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mt-1">${escapeHtml(s0.title)}</h3>
                <p data-feed-line aria-live="polite" class="text-sm font-bold text-white/80 mt-2 line-clamp-2">${escapeHtml(s0.line)}</p>
            </div>
            ${dots}
        </div>

        <div class="p-4 flex flex-wrap items-center gap-2">
            <button type="button" data-feed-open class="${HERO_BTN} px-5 bg-white text-slate-900 ${s0.tap ? '' : 'hidden'}">
                <span data-feed-open-label>${escapeHtml(s0.openLabel)}</span>
            </button>
            <button type="button" data-feed-play aria-pressed="false" class="${HERO_BTN} px-4 bg-white/10 text-white ${s0.band ? '' : 'hidden'}">
                <span data-feed-ico-play><i data-lucide="play" class="w-4 h-4" aria-hidden="true"></i></span>
                <span data-feed-ico-stop class="hidden"><i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i></span>
                <span data-feed-play-label>Listen</span>
            </button>
            <a data-feed-watch href="${_attr(s0.band ? _watchUrl(s0.band) : '#')}" target="_blank" rel="noopener noreferrer"
               aria-label="Watch live videos" title="Watch live videos"
               class="${HERO_BTN} w-11 bg-white/10 text-white ${s0.band ? '' : 'hidden'}">
                <i data-lucide="video" class="w-4 h-4" aria-hidden="true"></i>
            </a>
            ${hasList ? `
            <button type="button" data-feed-toggle="${_attr(key)}" data-feed-type="${_attr(card.type)}"
                    aria-expanded="false" aria-controls="feed-detail-${_attr(key)}"
                    aria-label="${_attr(`All ${listCount} shows`)}" title="${_attr(`All ${listCount} shows`)}"
                    class="${HERO_BTN} px-4 bg-white/10 text-white">
                <i data-lucide="list" class="w-4 h-4" aria-hidden="true"></i>${listCount}
            </button>` : ''}
            <div class="ml-auto">${renderReactionRow(card.reactTargets, 'dark', card.reactVariant, 'right')}</div>
        </div>

        <div data-feed-player></div>
        <div id="feed-detail-${_attr(key)}" data-theme="dark" class="hidden px-5 pb-5"></div>
    </section>`;
}

// ── Hero behaviour (module-level: one hero per feed) ─────────────────────────

const _heroHost = () => document.querySelector('[data-feed-hero]');

function applyHeroSlide(host, i) {
    const s = _hero?.slides[i];
    if (!s) return;
    _hero.idx = i;
    const set = (sel, v) => { const el = host.querySelector(sel); if (el) el.textContent = v; };
    set('[data-feed-eyebrow]', s.eyebrow);
    set('[data-feed-title]',   s.title);
    set('[data-feed-line]',    s.line);
    host.querySelectorAll('[data-feed-dot]').forEach((d, n) => {
        d.classList.toggle('bg-white',    n === i);
        d.classList.toggle('bg-white/40', n !== i);
    });
    const open = host.querySelector('[data-feed-open]');
    if (open) { open.classList.toggle('hidden', !s.tap); set('[data-feed-open-label]', s.openLabel); }
    host.querySelector('[data-feed-play]')?.classList.toggle('hidden', !s.band);
    const watch = host.querySelector('[data-feed-watch]');
    if (watch) { watch.classList.toggle('hidden', !s.band); if (s.band) watch.href = _watchUrl(s.band); }
    if (_hero.playing && _hero.playBand !== s.band) _closePlayer(host);
}

function _setPlayUi(host, on) {
    host.querySelector('[data-feed-ico-play]')?.classList.toggle('hidden', on);
    host.querySelector('[data-feed-ico-stop]')?.classList.toggle('hidden', !on);
    const label = host.querySelector('[data-feed-play-label]');
    if (label) label.textContent = on ? 'Close player' : 'Listen';
    host.querySelector('[data-feed-play]')?.setAttribute('aria-pressed', String(on));
}

function _closePlayer(host) {
    const slot = host.querySelector('[data-feed-player]');
    if (slot) slot.innerHTML = '';
    if (_hero) { _hero.playing = false; _hero.playBand = null; }
    _setPlayUi(host, false);
}

// One Spotify iframe at a time, loaded on demand, never on page load.
function _toggleHeroPlayer() {
    const host = _heroHost();
    if (!host || !_hero) return;
    if (_hero.playing) { _closePlayer(host); return; }
    const s = _hero.slides[_hero.idx];
    if (!s?.band) return;
    const sid = _spotifyId(s.band);
    if (!sid) {
        window.open(`https://open.spotify.com/search/${encodeURIComponent(s.band)}`, '_blank', 'noopener,noreferrer');
        return;
    }
    const slot = host.querySelector('[data-feed-player]');
    if (!slot) return;
    slot.innerHTML = `
        <div class="px-4 pb-4">
            <iframe title="${_attr(`Spotify player for ${s.band}`)}"
                    src="https://open.spotify.com/embed/artist/${sid}?utm_source=generator&theme=0"
                    width="100%" height="152" frameborder="0" loading="lazy"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    class="rounded-2xl block"></iframe>
        </div>`;
    _hero.playing = true;
    _hero.playBand = s.band;
    _setPlayUi(host, true);
}

function _openHeroSlide() {
    if (_hero) runTap(_hero.slides[_hero.idx]?.tap);
}

// Swipe: update caption, dots and buttons in place (no repaint, no flicker).
let _heroRaf = 0;
function _onFeedScroll(e) {
    const rail = e.target;
    if (!(rail instanceof Element) || !rail.hasAttribute('data-feed-rail') || !_hero) return;
    cancelAnimationFrame(_heroRaf);
    _heroRaf = requestAnimationFrame(() => {
        const i = Math.round(rail.scrollLeft / (rail.clientWidth || 1));
        if (i === _hero.idx || i < 0 || i >= _hero.slides.length) return;
        const host = _heroHost();
        if (host) applyHeroSlide(host, i);
    });
}

// ─── ROWS ─────────────────────────────────────────────────────────────────────

// Buddy update: thumbnail with the buddy's avatar on its corner, what happened,
// and the reaction button on the right.
function buddyRowHtml(card) {
    const buddies = card.buddies || (card.buddy ? [card.buddy] : []);
    const attrs   = tapAttrs(tapDesc(card));
    return `
        <li class="flex items-center gap-3">
            <button type="button" ${attrs}
                    class="flex-1 min-w-0 flex items-center gap-3 text-left rounded-2xl active:scale-[0.99] transition-transform ${FOCUS}">
                <span class="relative shrink-0">
                    ${_art(card.headline, 'relative block w-14 h-14 rounded-2xl', artJob(card))}
                    ${buddies.length ? `<span class="absolute -bottom-1 -right-1 flex">${buddyAvatarPill(buddies.slice(0, 1), { ring: 'ring-white', spacing: 'mr-0' })}</span>` : ''}
                </span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-bold text-slate-800 truncate">${escapeHtml(card.headline)}</span>
                    <span class="block text-xs font-semibold text-slate-600 truncate">${escapeHtml(card.eyebrow)}</span>
                    <span class="block text-xs text-slate-500 truncate">${escapeHtml(card.subline)}</span>
                </span>
            </button>
            ${renderReactionRow(card.reactTargets, 'light', card.reactVariant, 'right')}
        </li>`;
}

function buddySection(cards) {
    return `
        <section class="${CARD}" aria-labelledby="feed-buddies">
            ${_head('feed-buddies', 'Buddy updates')}
            <ul class="space-y-4">${cards.map(buddyRowHtml).join('')}</ul>
        </section>`;
}

// Artist / room story: thumbnail, the story in one line, a bar for how many
// shows sit behind it, and a pill naming the kind of story. Tap to open the list.
function historyRowHtml(card, max) {
    const key     = _cardKey(card);
    const n       = card.allGigs?.length || 1;
    const isVenue = card.type === 'venue_chapter';
    const hasList = LIST_TYPES.has(card.type) && n > 1;
    const thumb   = isVenue
        ? `<span class="relative shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br ${_grad(card.headline)} flex items-center justify-center">
               <i data-lucide="map-pin" class="w-6 h-6 text-white/80" aria-hidden="true"></i>
           </span>`
        : _art(card.headline, 'relative shrink-0 w-14 h-14 rounded-2xl', artJob(card));
    const tap     = hasList
        ? `data-feed-toggle="${_attr(key)}" data-feed-type="${_attr(card.type)}" aria-expanded="false" aria-controls="feed-detail-${_attr(key)}"`
        : tapAttrs(tapDesc(card));

    return `
        <li>
            <button type="button" ${tap}
                    class="w-full flex items-center gap-3 text-left rounded-2xl active:scale-[0.99] transition-transform ${FOCUS}">
                ${thumb}
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-bold text-slate-800 truncate">${escapeHtml(card.headline)}</span>
                    <span class="block text-xs font-medium text-slate-500 line-clamp-2">${escapeHtml(card.eyebrow)}</span>
                    <span class="block mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
                        <span class="block h-full rounded-full bg-indigo-500" style="width:${Math.max(8, Math.round((n / max) * 100))}%"></span>
                    </span>
                </span>
                <span class="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full whitespace-nowrap ${_pill(card.badgeColor)}">${escapeHtml(card.badge)}</span>
                ${hasList ? '<i data-feed-chevron data-lucide="chevron-down" class="w-4 h-4 shrink-0 text-slate-400 transition-transform" aria-hidden="true"></i>' : ''}
            </button>
            ${hasList ? `<div id="feed-detail-${_attr(key)}" data-theme="light" class="hidden ml-[4.25rem]"></div>` : ''}
        </li>`;
}

function historySection(allCards) {
    // The same artist can qualify for several stories at once (first show,
    // milestone, cities...). One row each: keep the highest-scoring story.
    const best = new Map();
    for (const c of allCards) {
        const k = `${c.type === 'venue_chapter' ? 'v' : 'a'}:${_key(c.headline)}`;
        if (!best.has(k) || c.score > best.get(k).score) best.set(k, c);
    }
    const cards = [...best.values()].sort((a, b) => b.score - a.score);
    const max = Math.max(...cards.map(c => c.allGigs?.length || 1), 1);
    return `
        <section class="${CARD}" aria-labelledby="feed-history">
            ${_head('feed-history', 'From your journal')}
            <ul class="space-y-4">${cards.map(c => historyRowHtml(c, max)).join('')}</ul>
        </section>`;
}

// ─── RAILS & TILES ────────────────────────────────────────────────────────────

// Poster tile: the year is the headline. Tap opens the show.
function posterTileHtml(g) {
    return `
        <button type="button" data-feed-gig-key="${_attr(g['Journal Key'] || '')}"
                aria-label="${_attr(`${g.Band}, ${_showLine(g)}`)}"
                class="relative shrink-0 snap-start w-36 h-48 rounded-3xl overflow-hidden text-left active:scale-[0.97] transition-transform ${FOCUS}">
            ${_art(g.Band, 'absolute inset-0', { kind: 'show', gig: g, band: g.Band })}
            <div class="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/30 to-slate-900/40"></div>
            <span class="absolute top-3 left-3 text-3xl font-black italic tracking-tighter text-white leading-none">${escapeHtml(String(gigYear(g)))}</span>
            <span class="absolute inset-x-0 bottom-0 p-3">
                <span class="block text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(g.Band)}</span>
                <span class="block mt-1 text-[11px] font-bold text-white/80 line-clamp-1">${escapeHtml(g.OfficialVenue || '')}</span>
            </span>
        </button>`;
}

function seasonSection(card) {
    const gigs = (card.allGigs || []).slice(0, 12);
    const more = (card.allGigs?.length || 0) - gigs.length;
    return `
        <section class="${CARD}" aria-labelledby="feed-season">
            ${_head('feed-season', card.eyebrow, `${_plural(card.allGigs.length, 'show', 'shows')} from past years${more > 0 ? `, ${more} more in your journal` : ''}`)}
            <ul class="${RAIL}" role="list">
                ${gigs.map(g => `<li class="shrink-0 snap-start">${posterTileHtml(g)}</li>`).join('')}
            </ul>
        </section>`;
}

// Room you and a buddy have both been to. Tap opens your show there.
function venueTileHtml(card) {
    return `
        <button type="button" ${tapAttrs(tapDesc(card))}
                aria-label="${_attr(`${card.headline}. ${card.subline}`)}"
                class="relative shrink-0 snap-start w-52 h-40 rounded-3xl overflow-hidden text-left bg-gradient-to-br ${_grad(card.headline)} active:scale-[0.97] transition-transform ${FOCUS}">
            <div class="absolute inset-0 bg-gradient-to-t from-slate-900/70 via-slate-900/10 to-transparent"></div>
            <i data-lucide="map-pin" class="absolute top-3 right-3 w-5 h-5 text-white/70" aria-hidden="true"></i>
            <span class="absolute top-3 left-3 flex items-center max-w-[75%]">
                ${buddyAvatarPill(card.buddy, { ring: 'ring-white' })}
                <span class="text-[11px] font-bold text-white truncate">${escapeHtml(card.buddyName || '')}</span>
            </span>
            <span class="absolute inset-x-0 bottom-0 p-3">
                <span class="block text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(card.headline)}</span>
                <span class="block mt-1 text-[11px] font-bold text-white/85 line-clamp-1">${escapeHtml(card.eyebrow)}</span>
            </span>
        </button>`;
}

function venueSection(cards) {
    return `
        <section class="${CARD}" aria-labelledby="feed-rooms">
            ${_head('feed-rooms', 'Rooms you share', 'Places you and your buddies have both been')}
            <div class="${RAIL}">${cards.map(venueTileHtml).join('')}</div>
        </section>`;
}

// Collection items as photo tiles. Not interactive: the old cards only listed
// items too, and there is no single-item viewer to open.
function itemTileHtml(item, showYear) {
    const year = showYear ? String(item.acquired_date || '').split('-')[0] : '';
    const kind = item.subtype || item.type || '';
    return `
        <li class="relative shrink-0 snap-start w-32 h-44 rounded-3xl overflow-hidden">
            ${_art(item.title, 'absolute inset-0', { kind: 'item', item, band: item.band_name })}
            <div class="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/30 to-slate-900/40"></div>
            ${year
                ? `<span class="absolute top-3 left-3 text-3xl font-black italic tracking-tighter text-white leading-none">${escapeHtml(year)}</span>`
                : (kind ? `<span class="absolute top-2 left-2 bg-white/90 text-slate-700 text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full">${escapeHtml(kind)}</span>` : '')}
            <span class="absolute inset-x-0 bottom-0 p-3 text-sm font-black text-white leading-tight line-clamp-2">${escapeHtml(item.title)}</span>
        </li>`;
}

function collectionSection(card) {
    const items     = (card.allItems || []).slice(0, 10);
    const isMonth   = card.type === 'collection_this_month';
    const monthName = new Date().toLocaleString('default', { month: 'long' });
    const id        = `feed-col-${_cardKey(card)}`;
    const title     = isMonth ? `Added in ${monthName}` : card.headline;
    const sub       = isMonth
        ? `${_plural(card.allItems.length, 'item', 'items')} from past years`
        : card.subline;
    return `
        <section class="${CARD}" aria-labelledby="${_attr(id)}">
            ${_head(id, title, sub)}
            <ul class="${RAIL}" role="list">${items.map(i => itemTileHtml(i, isMonth)).join('')}</ul>
        </section>`;
}

// ─── GAME TILE ────────────────────────────────────────────────────────────────

function gameCardHtml(journalData) {
    const canPlayQuiz = journalData.length >= 5;
    let gameType;
    if (!canPlayQuiz) {
        gameType = 'puzzle';
    } else {
        const last = sessionStorage.getItem('giglist_feed_last_game') || 'quiz';
        gameType   = last === 'quiz' ? 'puzzle' : 'quiz';
        sessionStorage.setItem('giglist_feed_last_game', gameType);
    }
    const isPuzzle = gameType === 'puzzle';
    const grad     = isPuzzle ? 'from-violet-600 to-fuchsia-600' : 'from-rose-600 to-red-600';
    const eyebrow  = isPuzzle ? 'Fancy a break?' : 'Test your knowledge';
    const headline = isPuzzle ? 'Slide puzzle' : 'Gig quiz';
    const subline  = isPuzzle ? 'Piece together a show from your history' : 'How well do you know your own gig history?';

    return `
        <div id="feed-game-card">
            <button type="button" onclick="window._openFeedGame('${gameType}')"
                    class="relative w-full overflow-hidden rounded-[2rem] bg-gradient-to-br ${grad} p-5 pr-16 text-left shadow-sm active:scale-[0.99] transition-transform ${FOCUS_DARK}">
                <i data-lucide="play" class="absolute top-1/2 right-5 -translate-y-1/2 w-8 h-8 text-white/80" aria-hidden="true"></i>
                <span class="block text-[10px] font-black uppercase tracking-widest text-white/80">${eyebrow}</span>
                <span class="block mt-1 text-2xl font-black italic uppercase tracking-tighter text-white leading-none">${headline}</span>
                <span class="block mt-2 text-sm font-bold text-white/90">${subline}</span>
            </button>
        </div>`;
}

// ─── STATES ───────────────────────────────────────────────────────────────────

function skeletonHtml() {
    return `
        <div class="space-y-4 animate-pulse" aria-hidden="true">
            <div class="h-72 rounded-[2rem] bg-slate-200"></div>
            <div class="${CARD} h-56"></div>
        </div>`;
}

function renderEmptyState(container) {
    container.innerHTML = `
        <div class="${CARD} text-center space-y-2 py-10">
            <div class="w-16 h-16 mx-auto bg-slate-100 rounded-[1.5rem] flex items-center justify-center">
                <i data-lucide="music-2" class="w-8 h-8 text-slate-400" aria-hidden="true"></i>
            </div>
            <h3 class="text-base font-black text-slate-900">Nothing yet</h3>
            <p class="text-sm text-slate-500">Add some shows and come back — your feed will fill up fast.</p>
        </div>
        ${renderEmptyStateTips([
            'feed_on_this_day',
            'push_notifications',
            'feed_band_deep_cut',
        ])}`;
    if (window.lucide) lucide.createIcons();
}

function _attributionHtml() {
    for (const m of _media.values()) {
        if (m.image_url) return 'Artist images and players from Spotify';
    }
    return '';
}

// ─── COMPOSITION ──────────────────────────────────────────────────────────────

const _cardsByKey = new Map();

/**
 * Turns the selected cards into the page. The top-scoring card becomes the
 * hero; the rest are grouped by component. Sections keep the old ordering
 * rule: anything at score 90+ first, then tip discovery cards, then the rest.
 */
function composeFeed(scored, tipCards, journalData) {
    _artJobs  = new Map();
    _cardsByKey.clear();
    _hero = null;
    scored.forEach(c => _cardsByKey.set(_cardKey(c), c));

    const hero = scored[0] || null;
    const heroHtml = hero ? heroSection(hero) : '';

    // An anniversary hero already swipes through every on-this-day show.
    const pool = scored.slice(hero ? 1 : 0).filter(c => !(hero?.type === 'on_this_day' && c.type === 'on_this_day'));
    const groups = { buddy: [], venue: [], history: [], season: [], collection: [] };
    for (const c of pool) {
        if (BUDDY_ROW_TYPES.has(c.type))           groups.buddy.push(c);
        else if (VENUE_TILE_TYPES.has(c.type))     groups.venue.push(c);
        else if (HISTORY_ROW_TYPES.has(c.type))    groups.history.push(c);
        else if (c.type === 'season_flashback')    groups.season.push(c);
        else if (c.type.startsWith('collection_')) groups.collection.push(c);
    }

    const top = (cards) => Math.max(...cards.map(c => c.score));
    const sections = [];
    if (groups.buddy.length)   sections.push({ score: top(groups.buddy),   html: buddySection(groups.buddy) });
    if (groups.venue.length)   sections.push({ score: top(groups.venue),   html: venueSection(groups.venue) });
    if (groups.history.length) sections.push({ score: top(groups.history), html: historySection(groups.history) });
    groups.season.forEach(c     => sections.push({ score: c.score, html: seasonSection(c) }));
    groups.collection.forEach(c => sections.push({ score: c.score, html: collectionSection(c) }));
    sections.sort((a, b) => b.score - a.score);

    const pinned = sections.filter(s => s.score >= 90);
    const rest   = sections.filter(s => s.score < 90);
    const tips   = tipCards.map(c => `<div>${renderTipDiscoveryCard(c)}</div>`);

    return [
        heroHtml,
        ...pinned.map(s => s.html),
        ...tips,
        ...rest.map(s => s.html),
        gameCardHtml(journalData),
    ].join('');
}

// ─── CLICK HANDLING ───────────────────────────────────────────────────────────

const FEED_TAP_SELECTOR = [
    '[data-feed-toggle]', '[data-feed-gig-key]', '[data-feed-buddy-col-id]',
    '[data-feed-buddy-show-key]', '[data-feed-open]', '[data-feed-play]',
].join(', ');

function _handleFeedClick(e) {
    const el = e.target.closest(FEED_TAP_SELECTOR);
    if (!el || !e.currentTarget.contains(el)) return;
    const ds = el.dataset;
    if (ds.feedToggle !== undefined)            window._feedToggleDetail(ds.feedToggle, ds.feedType);
    else if (ds.feedPlay !== undefined)         _toggleHeroPlayer();
    else if (ds.feedOpen !== undefined)         _openHeroSlide();
    else if (ds.feedGigKey !== undefined)       { if (ds.feedGigKey) window.viewGigDetails(ds.feedGigKey); }
    else if (ds.feedBuddyShowKey !== undefined) window._feedOpenBuddyShow(ds.feedBuddyShowKey, ds.feedBuddyShowIds);
    else                                        window._feedOpenBuddyCollection(ds.feedBuddyColId, ds.feedBuddyColName);
}

function _wireFeedClicks(container) {
    if (!container || container._feedClickWired) return;
    container._feedClickWired = true;
    container.addEventListener('click',  _handleFeedClick);
    container.addEventListener('scroll', _onFeedScroll,   true);
    container.addEventListener('error',  _onFeedImgError, true);
    container.addEventListener('load',   _onFeedImgLoad,  true);
}

// Expand / collapse a show list in place. Content is built from the card
// itself (not scraped from the DOM), the first time it opens.
window._feedToggleDetail = (safeKey) => {
    const card   = _cardsByKey.get(safeKey);
    const detail = document.getElementById(`feed-detail-${safeKey}`);
    if (!card || !detail) return;

    const opening = detail.classList.contains('hidden');
    if (opening && !detail.dataset.filled) {
        detail.innerHTML = showListHtml(card, detail.dataset.theme);
        detail.dataset.filled = '1';
    }
    detail.classList.toggle('hidden', !opening);

    document.querySelectorAll(`[data-feed-toggle="${safeKey}"]`).forEach(btn => {
        btn.setAttribute('aria-expanded', String(opening));
        const chev = btn.querySelector('[data-feed-chevron]');
        if (chev) chev.style.transform = opening ? 'rotate(180deg)' : '';
    });
};

// ─── GAME MODAL ───────────────────────────────────────────────────────────────

window._openFeedGame = (gameType) => {
    if (document.getElementById('feed-game-modal')) return;
    const isPuzzle = gameType === 'puzzle';

    const gameInnerHtml = isPuzzle ? `
        <div id="puzzle-section" class="flex flex-col gap-4 w-full">
            <div class="flex items-center justify-between px-1">
                <p class="text-[9px] font-black uppercase tracking-widest text-white/50">Tap a tile to move it into the empty space and reveal the show</p>
                <button id="feed-puzzle-new"
                        class="text-[9px] font-black uppercase tracking-widest text-white/40 hover:text-white transition-colors">
                    New puzzle
                </button>
            </div>
            <div class="flex gap-2 justify-center">
                        <button id="puzzle-difficulty-easy"
                                class="px-3 py-1 text-[10px] font-black uppercase rounded-full text-slate-400">Easy</button>
                        <button id="puzzle-difficulty-medium"
                                class="px-3 py-1 text-[10px] font-black uppercase rounded-full bg-indigo-500 text-white">Medium</button>
                        <button id="puzzle-difficulty-hard"
                                class="px-3 py-1 text-[10px] font-black uppercase rounded-full text-slate-400">Hard</button>
                    </div>
            <div id="puzzle-grid" class="grid gap-1 w-full aspect-square rounded-2xl overflow-hidden bg-slate-800"></div>
        </div>` : `
        <div id="quiz-container" class="flex flex-col gap-4 w-full">
            <div class="flex items-center justify-between px-1">
                <span id="quiz-score" class="text-[9px] font-black uppercase tracking-widest text-white/60">SCORE: 0</span>
                <span id="quiz-timer" class="text-[9px] font-black uppercase tracking-widest text-white/60">00:30</span>
            </div>
            <div id="game-arena" class="rounded-2xl transition-colors duration-200 p-4 bg-slate-800/50">
                <div id="quiz-body" class="flex flex-col items-center gap-4 min-h-[280px] justify-center">
                    <p class="text-white/40 text-sm font-bold">Loading…</p>
                </div>
            </div>
        </div>`;

    const modal = document.createElement('div');
    modal.id        = 'feed-game-modal';
    modal.className = 'fixed inset-0 z-[200] flex flex-col bg-slate-950/95 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', isPuzzle ? 'Slide Puzzle' : 'Gig Quiz');
    modal.innerHTML = `
        <div class="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0">
            <div>
                <p class="text-[9px] font-black uppercase tracking-widest text-white/40">
                    ${isPuzzle ? 'Fancy a break?' : 'Test your knowledge'}
                </p>
                <h2 class="text-xl font-black italic uppercase tracking-tighter text-white leading-none">
                    ${isPuzzle ? 'Slide Puzzle' : 'Gig Quiz'}
                </h2>
            </div>
            <button id="feed-game-modal-close"
                    class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                    aria-label="Close">
                <i data-lucide="x" class="w-4 h-4 text-white" aria-hidden="true"></i>
            </button>
        </div>
        <div class="flex-1 overflow-y-auto px-5 pb-8 flex flex-col">${gameInnerHtml}</div>`;

    document.body.appendChild(modal);
    if (window.lucide) lucide.createIcons();

    const close    = () => modal.remove();
    const onKeyDown = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeyDown); } };
    document.getElementById('feed-game-modal-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', onKeyDown);

    if (isPuzzle) {
        document.getElementById('feed-puzzle-new')?.addEventListener('click', () => startNewPuzzle());
        ['easy', 'medium', 'hard'].forEach(level => {
            document.getElementById(`puzzle-difficulty-${level}`)
                ?.addEventListener('click', () => setPuzzleDifficulty(level));
        });
    }

    requestAnimationFrame(() => {
        if (isPuzzle) {
            resetPuzzleImage();
            startNewPuzzle();
        }
        else window.initQuiz?.();
    });
};

// ─── PUBLIC INIT ──────────────────────────────────────────────────────────────

/**
 * Called when the Feed tab is activated.
 *
 * Fetch order:
 *   1. Collection items        — Supabase, own user
 *   2. Buddy journals          — Supabase, all buddies, 5 fields only
 *   2b. Buddy collection items — Supabase, all buddies, 6 fields only
 *   3. Build + score all card types
 *   4. Seeded selection
 *   5. Compose (hero + sections) and render
 *   6. Artist media (Spotify image / player id) loads in parallel; images
 *      resolve after render, hero first, and fade in.
 *
 * There is no longer a sessionStorage copy of the rendered HTML: the hero keeps
 * live state (slide, player), and building the cards is cheap. The expensive
 * parts (buddy data, reactions, artist media, photo listings) are cached in
 * memory for the session. Card selection is seeded by date, so the feed is
 * stable within a day.
 */
export async function init(journalData, performanceData, _ignored = []) {
    const container = document.getElementById('feed-cards-container');
    if (!container) return;
    _wireFeedClicks(container);

    // Cold start: skeleton so the tab doesn't flash empty.
    if (!container.childElementCount) container.innerHTML = skeletonHtml();

    // 1. Collection items
    let collectionItems = [];
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user?.id) {
            const { data } = await supabase
                .from('collection_items')
                .select('id, type, subtype, title, band_name, band_id, item_date, acquired_date, photos, hero_color, body')
                .eq('user_id', session.user.id);
            collectionItems = data || [];
        }
    } catch (e) {
        console.warn('[Feed] collection fetch failed:', e.message);
    }
    window._collectionItems = collectionItems;

    // 2. Buddy journals + buddy collections
    const buddyJournalsByUser        = await fetchBuddyJournals();
    const buddyCollectionItemsByUser = await fetchBuddyCollectionItems();
    const buddyProfiles              = window._following || [];
    if (buddyProfiles.length) await fetchMyReactions();   // before render: decides whether reaction buttons appear

    // 3. Build all card pools
    const gigCards   = buildCards(journalData, performanceData);
    const colCards   = buildCollectionCards(collectionItems, journalData);
    const buddyCards = [
        ...buildBuddyCards(buddyJournalsByUser, journalData, buddyProfiles),
        ...buildBuddyCollectionCards(buddyCollectionItemsByUser, journalData, buddyProfiles),
    ];

    // 4. selectCards() round-robins one card per type per pass, so every type
    // gets a fair shot. Highest score first.
    const scored   = selectCards(gigCards, colCards, buddyCards);
    const tipCards = buildTipDiscoveryCards().slice(0, 2);   // at most 2 per render

    if (scored.length === 0 && tipCards.length === 0) {
        renderEmptyState(container);
        return;
    }

    // Debug aid — full card payload + a type-count breakdown, inspectable in
    // devtools via window._feedCards. Cheap and handy for spot-checking
    // variety/scoring without digging through the DOM.
    window._feedCards = [...scored, ...tipCards];
    console.log(`[Feed] built ${window._feedCards.length} cards`);
    console.table(
        Object.entries(
            window._feedCards.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {})
        ).map(([type, count]) => ({ type, count }))
    );

    // 5. Render. Artist media is requested now and awaited only by the image
    // step that needs it, so own photos and scrapbook shots aren't held up.
    _mediaPending = loadArtistMedia(_bandsForMedia(scored));

    container.innerHTML = `
        <div class="space-y-4">
            ${composeFeed(scored, tipCards, journalData)}
            <p data-feed-attribution class="text-center text-[10px] font-bold text-slate-500 pt-1"></p>
        </div>`;

    if (window.lucide) lucide.createIcons();
    applyReactionState(container);
    hydrateArt(container);

    _mediaPending.then(() => {
        const el = container.querySelector('[data-feed-attribution]');
        if (el) el.textContent = _attributionHtml();
    });
}
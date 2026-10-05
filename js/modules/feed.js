/**
 * GigList - Feed Module
 * v2.1.0 — May 2026
 *
 * Contextual feed engine. Evaluates card triggers against the user's journal
 * each time the Feed tab is activated, picks the top cards by score, and
 * renders them inline.
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

// Bump this on every deploy that touches card-selection or card-building
// logic (selectCards, buildCards, buildCollectionCards, buildBuddyCards,
// buildBuddyCollectionCards). The sessionStorage cache key includes it, so a
// bump forces every open tab to rebuild instead of serving whatever was
// cached under the old logic for the rest of the day. Bumping unnecessarily
// just costs one extra rebuild per user per day — cheap insurance, so when
// in doubt, bump it.
// v3: card fields are now HTML-escaped at render time and taps use data-*
// attributes + a delegated listener — bumped so any previously cached,
// unescaped feed HTML is discarded rather than replayed via innerHTML.
// v4: added buddy_recent_show cards + buddy-owned hero photo resolution.
const FEED_LOGIC_VERSION = 4;
const RECENT_SHOW_WINDOW_DAYS = 30;   // how long a buddy's show stays in the feed
const MAX_RECENT_SHOW_CARDS   = 6;    // feed-wide cap on buddy_recent_show candidates
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
async function fetchBuddyJournals() {
    const buddies = window._following || [];
    if (!buddies.length) return {};

    if (window._buddyJournalsByUser) return window._buddyJournalsByUser;

    const buddyIds = buddies.map(b => b.id);

    try {
        const { data, error } = await supabase
            .from('journals')
            .select('user_id, journal_key, date, band, official_venue, photos')
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
                'Journal Key': row.journal_key,
                Date:          row.date,
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
 * Returns: { [userId]: [ { id, type, title, band_name, acquired_date, photos } ] }
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
        const { data, error } = await supabase
            .from('collection_items')
            .select('id, user_id, type, title, band_name, acquired_date, photos')
            .in('user_id', buddyIds);

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
            if (!recentByKey.has(key)) recentByKey.set(key, { gig: g, daysAgo, buddies: [] });
            recentByKey.get(key).buddies.push(buddy);
        });
    });

    // Used below to keep a just-happened show out of near-miss / venue-echo,
    // so one buddy show doesn't produce two cards.
    const recentKeys = new Set(recentByKey.keys());

    [...recentByKey.entries()]
        .sort((a, b) => a[1].daysAgo - b[1].daysAgo)
        .slice(0, MAX_RECENT_SHOW_CARDS)
        .forEach(([key, { gig, daysAgo, buddies }]) => {
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
            const { data: listed } = await supabase.storage
                .from('gig-photos')
                .list(ownerId, { search: fileName });
            if (!listed?.some(f => f.name === fileName)) continue;
            const { data, error } = await supabase.storage
                .from('gig-photos')
                .createSignedUrl(`${ownerId}/${fileName}`, 3600);
            if (!error && data?.signedUrl) return data.signedUrl;
        } catch (e) { /* try next owner */ }
    }
    return null;
}

// Whose uploaded photo should be this card's hero? Default is the signed-in
// user; buddy_recent_show cards use the buddies who were at the show.
function photoOwnerIds(card) {
    if (card.type === 'buddy_recent_show') {
        return (card.buddies || [card.buddy]).filter(Boolean).map(b => b.id);
    }
    return undefined;
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

async function resolveCollectionHeroImage(item, imgEl, cardIndex) {
    const fallback = DEFAULT_IMAGES[cardIndex % DEFAULT_IMAGES.length];

    if (item?.photos?.length > 0) {
        try {
            const { data, error } = await supabase.storage
                .from('collection-photos')
                .createSignedUrl(item.photos[0], 3600);
            if (!error && data?.signedUrl) { imgEl.src = data.signedUrl; return; }
        } catch (e) { /* fall through */ }
    }

    if (item?.band_name) {
        const artistPath = `assets/artists/${item.band_name.toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;
        const probe = new Image();
        probe.onload  = () => { imgEl.src = artistPath; };
        probe.onerror = () => { imgEl.src = fallback; };
        probe.src = artistPath;
        return;
    }

    imgEl.src = fallback;
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
function buddyAvatarPill(buddyOrBuddies) {
    const buddies = (Array.isArray(buddyOrBuddies) ? buddyOrBuddies : [buddyOrBuddies]).filter(Boolean);
    if (!buddies.length) return '';

    const visible  = buddies.slice(0, 3);
    const overflow = buddies.length - visible.length;
    const stacked   = buddies.length > 1;

    const avatarHtml = visible.map((buddy, i) => {
        const name     = buddy.display_name || buddy.username || '';
        const initials = name.slice(0, 2).toUpperCase();
        const ringClass = stacked ? 'ring-2 ring-slate-900' : '';
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
                   flex items-center justify-center flex-shrink-0 ring-2 ring-slate-900 -ml-2">+${overflow}</span>`
        : '';

    return `<span class="inline-flex items-center mr-1.5">${avatarHtml}${overflowHtml}</span>`;
}

// ─── BUDDY COLLECTION NAVIGATION ──────────────────────────────────────────────

/**
 * Tap target for buddy_collection_together / buddy_collection_this_month
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
    const buddies = (window._following || []).filter(b => ids.includes(b.id));
    const gig     = (window._buddyJournalsByUser?.[ids[0]] || []).find(g => g['Journal Key'] === key);
    const modal   = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    if (!gig || !modal || !content) return;

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
                <div id="buddy-show-details"></div>
            </div>
        </div>`;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
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

function renderEmptyState(container) {
    container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-16 text-center space-y-4">
            <div class="w-16 h-16 bg-slate-100 rounded-[1.5rem] flex items-center justify-center">
                <i data-lucide="music-2" class="w-8 h-8 text-slate-300" aria-hidden="true"></i>
            </div>
            <div class="space-y-1">
                <p class="font-black text-slate-700 text-lg uppercase italic tracking-tight">Nothing yet</p>
                <p class="text-slate-400 text-sm font-medium">
                    Add some shows and come back — your feed will fill up fast.
                </p>
            </div>
        </div>
        ${renderEmptyStateTips([
            'feed_on_this_day',
            'push_notifications',
            'feed_band_deep_cut',
        ])}`;
    if (window.lucide) lucide.createIcons();
}

// Card types that expand in-place to show a list of shows
const EXPANDABLE_TYPES = new Set([
    'artist_story', 'artist_first', 'artist_milestone', 'artist_cities',
    'artist_era', 'first_last', 'season_flashback', 'venue_chapter',
    'collection_band_story', 'collection_this_month',
]);

// Social card types — rendered with a coloured top border + buddy avatar
const SOCIAL_TYPES = new Set([
    'buddy_recent_show', 'buddy_together', 'buddy_on_this_day', 'buddy_near_miss', 'buddy_venue_echo',
    'buddy_collection_together', 'buddy_collection_this_month',
]);

// Buddy collection cards tap through to the buddy's drill-in Collection tab
// rather than the gig modal — they have no journalKey gig to open.
const BUDDY_COLLECTION_TYPES = new Set([
    'buddy_collection_together', 'buddy_collection_this_month',
]);

// ─── CARD TEMPLATE ────────────────────────────────────────────────────────────
// Card builders hold RAW text in eyebrow/headline/subline/badge (buddy names,
// band/venue names, collection titles). renderCard() is the single escaping
// layer — do not pre-escape in the builders.
//
// Taps are wired via data-* attributes + one delegated listener on the feed
// container (_handleFeedClick / _wireFeedClicks) rather than inline onclick,
// because journal keys and buddy names are user-controlled text.

function _handleFeedClick(e) {
    const el = e.target.closest('[data-feed-toggle], [data-feed-gig-key], [data-feed-buddy-col-id], [data-feed-buddy-show-key]');
    if (!el || !e.currentTarget.contains(el)) return;
    const ds = el.dataset;
    if (ds.feedToggle !== undefined)      window._feedToggleDetail(ds.feedToggle, ds.feedType);
    else if (ds.feedGigKey !== undefined) window.viewGigDetails(ds.feedGigKey);
    else if (ds.feedBuddyShowKey !== undefined) window._feedOpenBuddyShow(ds.feedBuddyShowKey, ds.feedBuddyShowIds);
    else                                  window._feedOpenBuddyCollection(ds.feedBuddyColId, ds.feedBuddyColName);
}

function _wireFeedClicks(container) {
    if (!container || container._feedClickWired) return;
    container._feedClickWired = true;
    container.addEventListener('click', _handleFeedClick);
}

function renderCard(card, index) {
    // tip_discovery cards have their own renderer
    if (card.type === 'tip_discovery') return renderTipDiscoveryCard(card);

    const safeKey   = (card.journalKey || `card-${index}`).replace(/[^a-z0-9]/gi, '_');
    const hasDetail = EXPANDABLE_TYPES.has(card.type);
    const isSocial  = SOCIAL_TYPES.has(card.type);

    // Social cards get the buddy avatar woven into the eyebrow
    const eyebrowHtml = isSocial && (card.buddies?.length || card.buddy)
        ? `<span class="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-white/60 mb-2">
               ${buddyAvatarPill(card.buddies || card.buddy)}${escapeHtml(card.eyebrow)}
           </span>`
        : `<span class="text-[9px] font-black uppercase tracking-widest text-white/60 mb-2 block">
               ${escapeHtml(card.eyebrow)}
           </span>`;

    // Top accent stripe colour for social cards
    const socialStripeClass =
        card.type === 'buddy_recent_show'           ? 'bg-emerald-500' :
        card.type === 'buddy_near_miss'             ? 'bg-cyan-600'  :
        card.type === 'buddy_venue_echo'            ? 'bg-cyan-500'  :
        card.type === 'buddy_collection_together'   ? 'bg-indigo-400' :
        card.type === 'buddy_collection_this_month' ? 'bg-amber-400'  :
                                                        'bg-rose-500';

    // Primary tap action (data-* attributes, dispatched by _handleFeedClick)
    const primaryAction = hasDetail
        ? `data-feed-toggle="${escapeHtml(safeKey)}" data-feed-type="${escapeHtml(card.type)}"`
        : `data-feed-gig-key="${escapeHtml(card.journalKey || '')}"`;

    // For gig-based social cards the tap opens the gig modal (read-only for buddy cards).
    // Buddy collection cards have no gig — they open the buddy's Collection tab instead.
    const socialAction = `data-feed-gig-key="${escapeHtml(card.gig?.['Journal Key'] || '')}"`;
    const buddyCollectionAction = `data-feed-buddy-col-id="${escapeHtml(card.buddy?.id || '')}" data-feed-buddy-col-name="${escapeHtml(card.buddyName || '')}"`;

    // buddy_recent_show opens the read-only buddy show view (the gig modal only
    // knows the signed-in user's own journal).
    const buddyShowAction = `data-feed-buddy-show-key="${escapeHtml(card.gig?.['Journal Key'] || '')}" data-feed-buddy-show-ids="${escapeHtml((card.buddies || [card.buddy]).filter(Boolean).map(b => b.id).join(','))}"`;

    const tapAction = card.type === 'buddy_recent_show'
        ? buddyShowAction
        : BUDDY_COLLECTION_TYPES.has(card.type)
            ? buddyCollectionAction
            : (isSocial ? socialAction : primaryAction);

    // CTA label
    const ctaLabel = (() => {
        if (card.type === 'buddy_recent_show') return card.buddies?.length > 1 ? 'See the show' : `See ${card.buddyName}'s show`;
        if (card.type === 'buddy_together')    return 'View your show';
        if (card.type === 'buddy_on_this_day') return `See ${card.buddyName}'s show`;
        if (card.type === 'buddy_near_miss')   return 'View your show';
        if (card.type === 'buddy_venue_echo')  return 'View your show';
        if (card.type === 'buddy_collection_together')   return `See ${card.buddyName}'s collection`;
        if (card.type === 'buddy_collection_this_month') return `See ${card.buddyName}'s collection`;
        if (card.type === 'season_flashback')  return `See all ${card.allGigs?.length} shows`;
        if (card.type === 'venue_chapter')     return `See all ${card.allGigs?.length} visits`;
        if (card.type === 'collection_band_story') return `See ${card.allItems?.length} item${card.allItems?.length !== 1 ? 's' : ''}`;
        if (card.type === 'collection_this_month') return card.allItems?.length > 1 ? `See ${card.allItems.length} items` : '';
        if (card.allGigs?.length > 1)          return `See all ${card.allGigs.length} shows`;
        return '';
    })();

    const ctaIcon     = (hasDetail && !isSocial) ? 'chevron-down' : 'arrow-right';
    const chevronAttr = (hasDetail && !isSocial) ? `id="feed-chevron-${safeKey}"` : '';

    return `
        <div class="relative overflow-hidden rounded-[2rem] bg-slate-900 shadow-xl min-h-[260px] flex flex-col"
             role="article"
             data-card-type="${escapeHtml(card.type)}">

            <!-- Hero image -->
            <img id="feed-img-${safeKey}"
                 src=""
                 class="absolute inset-0 w-full h-full object-cover ${isSocial && card.type !== 'buddy_recent_show' ? 'opacity-35' : 'opacity-50'}"
                 alt=""
                 aria-hidden="true">

            <!-- Gradient overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-900/50 to-transparent"></div>

            <!-- Social accent stripe -->
            ${isSocial ? `<div class="absolute top-0 inset-x-0 h-1 ${socialStripeClass} opacity-70"></div>` : ''}

            <!-- Content -->
            <div class="relative z-10 flex flex-col justify-end flex-1 p-6">

                ${eyebrowHtml}

                <div ${tapAction} class="cursor-pointer">
                    <h3 class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mb-1">
                        ${escapeHtml(card.headline)}
                    </h3>
                    <p class="text-sm font-bold text-white/60">${escapeHtml(card.subline)}</p>
                </div>

                <div class="flex items-center justify-between mt-4">
                    <span class="${card.badgeColor} text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                        ${escapeHtml(card.badge)}
                    </span>
                    ${ctaLabel ? `
                    <button ${tapAction}
                            class="text-[10px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        ${escapeHtml(ctaLabel)}
                        <i data-lucide="${ctaIcon}" class="w-3.5 h-3.5" ${chevronAttr} aria-hidden="true"></i>
                    </button>` : ''}
                </div>

                <!-- Expandable detail panel (personal cards only) -->
                ${hasDetail ? `<div id="feed-detail-${safeKey}" class="hidden"></div>` : ''}
            </div>
        </div>`;
}

// ─── TOGGLE HANDLER ───────────────────────────────────────────────────────────

window._feedToggleDetail = (safeKey, cardType) => {
    const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
    const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
    if (!detailEl) return;

    const isHidden = detailEl.classList.contains('hidden');

    if (isHidden) {
        const cardEl = detailEl.closest('[role="article"]');

        // ── Artist cards ──────────────────────────────────────────────────────
        const ARTIST_TYPES = new Set([
            'artist_story', 'artist_first', 'artist_milestone',
            'artist_cities', 'artist_era', 'first_last',
        ]);

        if (ARTIST_TYPES.has(cardType)) {
            const headline = cardEl?.querySelector('h3')?.textContent?.trim();
            if (headline) {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const shows = (window.journalData || [])
                    .filter(g => { const d = parseDate(g.Date); return g.Band === headline && d && d < today; })
                    .sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));

                detailEl.innerHTML = `
                    <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                        ${shows.map((g, i) => `
                        <div data-feed-gig-key="${escapeHtml(g['Journal Key'] || '')}"
                             class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                            <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                            <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0"></div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs font-bold text-white truncate">${escapeHtml(g.OfficialVenue)}</p>
                            </div>
                            <span class="text-[9px] text-white/40 font-bold">#${i + 1}</span>
                        </div>`).join('')}
                    </div>`;
            }
        }

        // ── Venue chapter ─────────────────────────────────────────────────────
        else if (cardType === 'venue_chapter') {
            const venueName = cardEl?.querySelector('h3')?.textContent?.trim();
            if (venueName) {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const shows = (window.journalData || [])
                    .filter(g => { const d = parseDate(g.Date); return g.OfficialVenue === venueName && d && d < today; })
                    .sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));

                detailEl.innerHTML = `
                    <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                        ${shows.map(g => `
                        <div data-feed-gig-key="${escapeHtml(g['Journal Key'] || '')}"
                             class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                            <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                            <div class="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0"></div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs font-bold text-white truncate">${escapeHtml(g.Band)}</p>
                            </div>
                        </div>`).join('')}
                    </div>`;
            }
        }

        // ── Season flashback ──────────────────────────────────────────────────
        else if (cardType === 'season_flashback') {
            const today     = new Date(); today.setHours(0, 0, 0, 0);
            const thisMonth = today.getMonth() + 1;
            const thisYear  = today.getFullYear();
            const todayDay  = today.getDate();

            const seasonGigs = (window.journalData || []).filter(g => {
                if (g.Date.split('/').length !== 3) return false;
                const d = parseDate(g.Date);
                return gigMonth(g) === thisMonth && gigYear(g) < thisYear &&
                       d && d < today && !(gigDay(g) === todayDay && gigMonth(g) === thisMonth);
            }).sort((a, b) => (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0));

            detailEl.innerHTML = `
                <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                    ${seasonGigs.slice(0, 8).map(g => `
                    <div data-feed-gig-key="${escapeHtml(g['Journal Key'] || '')}"
                         class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                        <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                        <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-white truncate">${escapeHtml(g.Band)}</p>
                            <p class="text-[10px] text-white/50 truncate">${escapeHtml(g.OfficialVenue)}</p>
                        </div>
                    </div>`).join('')}
                    ${seasonGigs.length > 8
                        ? `<p class="text-[10px] text-white/40 text-center pt-1">+${seasonGigs.length - 8} more</p>`
                        : ''}
                </div>`;
        }

        // ── Collection cards ──────────────────────────────────────────────────
        else if (cardType === 'collection_band_story' || cardType === 'collection_this_month') {
            const allItems  = window._collectionItems || [];
            const today     = new Date();
            const thisMonth = today.getMonth() + 1;
            const thisYear  = today.getFullYear();
            let items;

            if (cardType === 'collection_band_story') {
                const bandName = cardEl?.querySelector('h3')?.textContent?.trim() || '';
                items = allItems.filter(i =>
                    (i.band_name || '').toLowerCase() === bandName.toLowerCase()
                );
            } else {
                items = allItems.filter(item => {
                    if (!item.acquired_date) return false;
                    const parts = item.acquired_date.split('-');
                    return parseInt(parts[1] || '0', 10) === thisMonth &&
                           parseInt(parts[0], 10) < thisYear;
                }).sort((a, b) => (b.acquired_date || '').localeCompare(a.acquired_date || ''));
            }

            detailEl.innerHTML = `
                <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                    ${items.slice(0, 8).map(item => `
                    <div class="flex items-center gap-3 px-2 py-1.5">
                        <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-white truncate">${escapeHtml(item.title)}</p>
                            ${item.acquired_date
                                ? `<p class="text-[10px] text-white/50">${escapeHtml(_formatAcquiredDate(item.acquired_date))}</p>`
                                : ''}
                        </div>
                        <span class="text-[9px] text-white/40 font-bold uppercase">${escapeHtml(item.subtype || '')}</span>
                    </div>`).join('')}
                    ${items.length > 8
                        ? `<p class="text-[10px] text-white/40 text-center pt-1">+${items.length - 8} more</p>`
                        : ''}
                </div>`;
        }

        if (window.lucide) lucide.createIcons();
    }

    detailEl.classList.toggle('hidden');
    if (chevronEl) chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
};

// ─── GAME CARD ────────────────────────────────────────────────────────────────

function renderGameCard(container, journalData) {
    const canPlayQuiz = journalData.length >= 5;
    let gameType;
    if (!canPlayQuiz) {
        gameType = 'puzzle';
    } else {
        const last = sessionStorage.getItem('giglist_feed_last_game') || 'quiz';
        gameType   = last === 'quiz' ? 'puzzle' : 'quiz';
        sessionStorage.setItem('giglist_feed_last_game', gameType);
    }

    const isPuzzle   = gameType === 'puzzle';
    const eyebrow    = isPuzzle ? 'Fancy a break?' : 'Test your knowledge';
    const headline   = isPuzzle ? 'Slide Puzzle' : 'Gig Quiz';
    const subline    = isPuzzle ? 'Piece together a show from your history' : 'How well do you know your own gig history?';
    const badge      = isPuzzle ? '🧩 Puzzle' : '🎤 Quiz';
    const badgeColor = isPuzzle ? 'bg-violet-500' : 'bg-rose-500';

    const tile = document.createElement('div');
    tile.id    = 'feed-game-card';
    tile.innerHTML = `
        <div class="relative overflow-hidden rounded-[2rem] bg-slate-900 shadow-xl min-h-[200px] flex flex-col"
             role="article">
            <img src="${DEFAULT_IMAGES[1]}"
                 class="absolute inset-0 w-full h-full object-cover opacity-30"
                 alt="" aria-hidden="true">
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-900/40 to-transparent"></div>
            <div class="relative z-10 flex flex-col justify-end flex-1 p-6">
                <span class="text-[9px] font-black uppercase tracking-widest text-white/60 mb-2">${eyebrow}</span>
                <h3 class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mb-1">${headline}</h3>
                <p class="text-sm font-bold text-white/60">${subline}</p>
                <div class="flex items-center justify-between mt-4">
                    <span class="${badgeColor} text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full">${badge}</span>
                    <button onclick="window._openFeedGame('${gameType}')"
                            class="text-[10px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        Let's play
                        <i data-lucide="play" class="w-3.5 h-3.5" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        </div>`;
    container.appendChild(tile);
    if (window.lucide) lucide.createIcons();
}

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
 *   1. Collection items       — Supabase, own user
 *   2. Buddy journals         — Supabase, all buddies, 5 fields only
 *   2b. Buddy collection items — Supabase, all buddies, 6 fields only
 *   3. Build + score all card types
 *   4. Seeded selection
 *   5. Render + async image resolution
 *
 * SessionStorage cache key includes date + journal length + collection count +
 * buddy count + buddy collection item count so it invalidates correctly when
 * any data set changes.
 */
export async function init(journalData, performanceData, _ignored = []) {
    const container = document.getElementById('feed-cards-container');
    if (!container) return;
    _wireFeedClicks(container);

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

    // 3. Cache check
    const buddyCollectionCount = Object.values(buddyCollectionItemsByUser).reduce((n, items) => n + items.length, 0);
    const buddyJournalCount    = Object.values(buddyJournalsByUser).reduce((n, rows) => n + rows.length, 0);
    const cacheKey   = `giglist_feed_v${FEED_LOGIC_VERSION}_${new Date().toDateString()}_j${journalData.length}_c${collectionItems.length}_b${buddyProfiles.length}_bc${buddyCollectionCount}_bj${buddyJournalCount}`;
    // TEMP DEBUG — skip the cache entirely so every load rebuilds from scratch
    // and actually reaches the window._feedCards / console.table logging below.
    // Otherwise a same-day reload just replays the cached HTML and skips it.
    const cachedHtml = sessionStorage.getItem(cacheKey);
    const cachedJson = sessionStorage.getItem(`${cacheKey}_cards`);

    if (cachedHtml && cachedJson) {
        container.innerHTML = cachedHtml;
        if (window.lucide) lucide.createIcons();
        JSON.parse(cachedJson).forEach((card, i) => {
            const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
            const imgEl   = document.getElementById(`feed-img-${safeKey}`);
            if (!imgEl) return;
            if (card.collectionItem) resolveCollectionHeroImage(card.collectionItem, imgEl, i);
            else if (card.gig)       resolveHeroImage(card.gig, imgEl, i, photoOwnerIds(card));
        });
        renderGameCard(container, journalData);
        return;
    }

    // 4. Build all card pools
    const gigCards   = buildCards(journalData, performanceData);
    const colCards   = buildCollectionCards(collectionItems, journalData);
    const buddyCards = [
        ...buildBuddyCards(buddyJournalsByUser, journalData, buddyProfiles),
        ...buildBuddyCollectionCards(buddyCollectionItemsByUser, journalData, buddyProfiles),
    ];

    // selectCards() now round-robins one card per type per pass, so every
    // type — including buddy_on_this_day — already gets a fair shot without
    // a separate reserved-slot carve-out (the previous approach added extra
    // cards on top of CARD_LIMIT, which this replaces).
    const scored = selectCards(gigCards, colCards, buddyCards);

    // Inject tip_discovery cards — at most 2 per render, after pinned content
    const tipCards = buildTipDiscoveryCards().slice(0, 2);
    const cards    = [
        ...scored.filter(c => c.score >= 90),   // pinned tier first
        ...tipCards,                              // then tip discovery
        ...scored.filter(c => c.score < 90),     // then the rest
    ];

    if (cards.length === 0) {
        renderEmptyState(container);
        return;
    }

    // Debug aid — full card payload + a type-count breakdown, both inspectable
    // in devtools via window._feedCards. Left in permanently; cheap and handy
    // for spot-checking variety/scoring without digging through the DOM.
    window._feedCards = cards;
    console.log(`[Feed] built ${cards.length} cards`);
    console.table(
        Object.entries(
            cards.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {})
        ).map(([type, count]) => ({ type, count }))
    );

    // 5. Render
    const html = cards.map((card, i) => renderCard(card, i)).join('');
    container.innerHTML = html;
    renderGameCard(container, journalData);

    // Cache skeleton — exclude tip_discovery cards (state-driven, must re-evaluate each visit)
    const cacheableCards = cards.filter(c => c.type !== 'tip_discovery');
    sessionStorage.setItem(cacheKey, cacheableCards.map((card, i) => renderCard(card, i)).join(''));
    sessionStorage.setItem(`${cacheKey}_cards`, JSON.stringify(
        cacheableCards.map(c => ({
            journalKey:     c.journalKey,
            gig:            c.gig            || null,
            collectionItem: c.collectionItem || null,
            buddy:          c.buddy          || null,
            buddies:        c.buddies        || null,
            type:           c.type,
            buddyName:      c.buddyName      || null,
        }))
    ));

    // Resolve images async so the card skeletons appear immediately
    cards.forEach((card, i) => {
        const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
        const imgEl   = document.getElementById(`feed-img-${safeKey}`);
        if (!imgEl) return;
        if (card.collectionItem) resolveCollectionHeroImage(card.collectionItem, imgEl, i);
        else if (card.gig)       resolveHeroImage(card.gig, imgEl, i, photoOwnerIds(card));
    });

    if (window.lucide) lucide.createIcons();
}
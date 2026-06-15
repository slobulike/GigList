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
 *   artist_story       — artist with 3+ shows, full timeline overview
 *   artist_first       — first time seeing an artist (3+ shows)
 *   artist_milestone   — 5th / 10th / 15th / 20th / 25th / 30th show
 *   artist_cities      — seen an artist in 3+ distinct cities
 *   artist_era         — densest 3-year cluster of shows for an artist
 *   venue_chapter      — 4+ visits to the same venue
 *   first_last         — artists seen exactly once or twice
 *   season_flashback   — shows from this calendar month in past years
 *
 * Collection (Phase 1):
 *   collection_band_story   — band you've seen live + items in your collection
 *   collection_this_month   — items acquired this month in past years
 *
 * Social (Phase 2):
 *   buddy_together      — your show today's anniversary, buddy was there too
 *   buddy_on_this_day   — buddy had a show on today's date (you weren't there)
 *   buddy_venue_echo    — you + buddy played the same venue, different years
 *
 * ─── SCORING REFERENCE ────────────────────────────────────────────────────────
 *
 *   100  on_this_day (personal)
 *    95  buddy_together
 *    90  collection_this_month
 *    85  collection_band_story (approx)
 *    80  buddy_on_this_day
 *    75  artist_story / artist_milestone (with anniversary bonus)
 *    65  artist_milestone (non-anniversary)
 *    62  artist_first
 *    60  buddy_venue_echo
 *    58  artist_cities
 *    55  artist_era
 *    52  venue_chapter
 *    50  season_flashback
 *    47  first_last (2 shows)
 *    45  first_last (1 show)
 *
 * Cards scoring ≥ 90 are pinned (always shown). The rest are seeded-shuffled
 * daily so the feed rotates without losing genuine date-anchored moments.
 */

import { parseDate, slugify, slugifyArtist } from './utils.js';
import { supabase } from './supabase.js';
import { startNewPuzzle } from './games.js';
import { buildTipDiscoveryCards, renderTipDiscoveryCard } from './tip-nudges.js';
import { renderEmptyStateTips } from './tip-nudges.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CARD_LIMIT      = 10;
const POOL_MULTIPLIER = 2;   // Build pool 2× the limit before seeded rotation

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

// ─── BUDDY JOURNAL FETCH ──────────────────────────────────────────────────────

/**
 * Fetches a lightweight subset of every buddy's journal in a single Supabase
 * query — only the five fields the feed engine needs.
 *
 * Returns: { [userId]: [ { 'Journal Key', Date, Band, OfficialVenue } ] }
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
            .from('journal')
            .select('user_id, journal_key, date, band, official_venue')
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
            });
        }

        window._buddyJournalsByUser = byUser;
        return byUser;

    } catch (e) {
        console.warn('[Feed] buddy journal fetch exception:', e.message);
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

            const hasAnniversary   = sorted.some(g => gigDay(g) === todayDay && gigMonth(g) === todayMonth);
            const anniversaryBonus = hasAnniversary ? 15 : 0;

            // ARTIST STORY (3+ shows) — full timeline overview
            if (sorted.length >= 3) {
                const first    = sorted[0];
                const last     = sorted[sorted.length - 1];
                const yearSpan = gigYear(last) - gigYear(first);
                const base     = onThisDayArtists.has(artist) ? 55 : 70;
                cards.push({
                    type:       'artist_story',
                    score:      base + anniversaryBonus,
                    gig:        last,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    yearSpan > 0
                        ? `${sorted.length} shows across ${yearSpan} year${yearSpan !== 1 ? 's' : ''}`
                        : `${sorted.length} shows`,
                    eyebrow:    'Your History',
                    badge:      `${sorted.length} Shows`,
                    badgeColor: 'bg-indigo-500',
                    journalKey: last['Journal Key'],
                });
            }

            // ARTIST FIRST (3+ shows) — origin story
            if (sorted.length >= 3) {
                const first    = sorted[0];
                const yearsAgo = thisYear - gigYear(first);
                cards.push({
                    type:       'artist_first',
                    score:      62 + anniversaryBonus,
                    gig:        first,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    `${first.OfficialVenue} · ${first.Date}`,
                    eyebrow:    `First time seeing them — ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago`,
                    badge:      'First Show',
                    badgeColor: 'bg-emerald-500',
                    journalKey: first['Journal Key'],
                });
            }

            // ARTIST MILESTONE — 5th, 10th, 15th, 20th, 25th, 30th
            [5, 10, 15, 20, 25, 30].forEach((n, nIdx) => {
                if (sorted.length >= n) {
                    const mg     = sorted[n - 1];
                    const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
                    cards.push({
                        type:       'artist_milestone',
                        score:      65 + anniversaryBonus - nIdx * 3,
                        gig:        mg,
                        allGigs:    sorted,
                        headline:   artist,
                        subline:    `${mg.OfficialVenue} · ${mg.Date}`,
                        eyebrow:    `Your ${n}${suffix} time seeing them`,
                        badge:      `Show #${n}`,
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
                    const last = sorted[sorted.length - 1];
                    cards.push({
                        type:       'artist_cities',
                        score:      58 + anniversaryBonus,
                        gig:        last,
                        allGigs:    sorted,
                        headline:   artist,
                        subline:    `Seen in ${cities.length} different places`,
                        eyebrow:    'You followed them everywhere',
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
                        subline:    `${bestCount} shows between ${eraStart} and ${eraStart + 2}`,
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
                    badge:      'One Show',
                    badgeColor: 'bg-slate-500',
                    journalKey: gig['Journal Key'],
                });
            }

            if (sorted.length === 2) {
                const last     = sorted[sorted.length - 1];
                const yearsAgo = thisYear - gigYear(last);
                cards.push({
                    type:       'first_last',
                    score:      47 + anniversaryBonus,
                    gig:        last,
                    allGigs:    sorted,
                    headline:   artist,
                    subline:    `Last seen at ${last.OfficialVenue} · ${last.Date}`,
                    eyebrow:    `Seen twice${yearsAgo > 0 ? `, ${yearsAgo} years ago` : ''}`,
                    badge:      'Two Shows',
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
 * Three social card types, all built from buddy journal data already in memory
 * after fetchBuddyJournals() runs.
 *
 * buddy_together:     My on-this-day show where a buddy's journal key overlaps.
 *                     Uses window._buddyJournalKeys — zero extra DB work.
 *
 * buddy_on_this_day:  Buddy had a show on today's date; I wasn't there.
 *
 * buddy_venue_echo:   Same venue, same calendar month, different years.
 *                     "Same room, different night."
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

    // Venue → my past gigs lookup for echo matching
    const myVenueMap = {};
    myJournalData.forEach(g => {
        if (!g.OfficialVenue) return;
        const d = parseDate(g.Date);
        if (!d || d >= today) return;
        if (!myVenueMap[g.OfficialVenue]) myVenueMap[g.OfficialVenue] = [];
        myVenueMap[g.OfficialVenue].push(g);
    });

    const cards = [];

    // Track which of my journal keys have been claimed by buddy_together so
    // selectCards() can suppress the plain on_this_day duplicate for the same show.
    const togetherKeys = new Set();

    buddyProfiles.forEach(buddy => {
        const buddyName    = buddy.display_name || buddy.username || 'Your buddy';
        const buddyGigs    = buddyJournalsByUser[buddy.id] || [];
        const sharedKeySet = buddyJournalKeys[buddy.id] || new Set();

        if (!buddyGigs.length) return;

        // ── BUDDY TOGETHER ─────────────────────────────────────────────────
        // My on-this-day anniversaries where the buddy was also there.
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
            if (!sharedKeySet.has(key)) return;

            const yearsAgo = thisYear - gigYear(myGig);
            togetherKeys.add(key);

            cards.push({
                type:        'buddy_together',
                score:       95,
                gig:         myGig,
                allGigs:     [myGig],
                buddy,
                buddyName,
                headline:    myGig.Band,
                subline:     `${myGig.OfficialVenue} · ${myGig.Date}`,
                eyebrow:     `You and ${buddyName} were there`,
                badge:       `${yearsAgo} Year${yearsAgo !== 1 ? 's' : ''} Ago`,
                badgeColor:  'bg-rose-500',
                journalKey:  `together_${buddy.id}_${key}`,
            });
        });

        // ── BUDDY ON THIS DAY ──────────────────────────────────────────────
        // Buddy had a show on today's date that I didn't share.
        const buddyOnThisDay = buddyGigs.filter(g => {
            if (!g.Date || g.Date.split('/').length !== 3) return false;
            const d = parseDate(g.Date);
            return d && d < today &&
                   gigDay(g) === todayDay &&
                   gigMonth(g) === todayMonth &&
                   gigYear(g) < thisYear &&
                   !sharedKeySet.has(g['Journal Key']);
        }).sort((a, b) => gigYear(b) - gigYear(a));

        // Up to 2 cards per buddy so a prolific buddy doesn't flood the feed
        buddyOnThisDay.slice(0, 2).forEach((bg, idx) => {
            const yearsAgo = thisYear - gigYear(bg);
            cards.push({
                type:        'buddy_on_this_day',
                score:       80 - idx * 3,
                gig:         bg,
                allGigs:     [bg],
                buddy,
                buddyName,
                headline:    bg.Band,
                subline:     `${bg.OfficialVenue} · ${bg.Date}`,
                eyebrow:     `${buddyName} · ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago today`,
                badge:       'On This Day',
                badgeColor:  'bg-rose-400',
                journalKey:  `buddy_otd_${buddy.id}_${bg['Journal Key']}`,
            });
        });

        // ── BUDDY VENUE ECHO ───────────────────────────────────────────────
        // Same venue, same calendar month, in at least one year that differs.
        // Groups buddy gigs by venue+month then checks against my venue map.
        const buddyVenuesByMonth = {};
        buddyGigs.forEach(g => {
            if (!g.OfficialVenue) return;
            const d = parseDate(g.Date);
            if (!d || d >= today) return;
            const vmKey = `${g.OfficialVenue}::${gigMonth(g)}`;
            if (!buddyVenuesByMonth[vmKey]) buddyVenuesByMonth[vmKey] = [];
            buddyVenuesByMonth[vmKey].push(g);
        });

        const emittedVenues = new Set(); // one echo card per venue per buddy

        Object.entries(buddyVenuesByMonth).forEach(([vmKey, buddyVenueGigs]) => {
            const [venueName, monthStr] = vmKey.split('::');
            const month       = parseInt(monthStr, 10);
            const myVenueGigs = (myVenueMap[venueName] || []).filter(g => gigMonth(g) === month);

            if (!myVenueGigs.length) return;
            if (emittedVenues.has(venueName)) return;

            // Only emit if there's at least one year that differs between us
            // (purely co-attended shows are covered by buddy_together)
            const myYears    = new Set(myVenueGigs.map(g => gigYear(g)));
            const buddyYears = new Set(buddyVenueGigs.map(g => gigYear(g)));
            const hasDiff    = [...myYears].some(y => !buddyYears.has(y)) ||
                               [...buddyYears].some(y => !myYears.has(y));
            if (!hasDiff) return;

            emittedVenues.add(venueName);

            const heroGig   = myVenueGigs.sort((a, b) =>
                (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0)
            )[0];
            const monthName = new Date(2000, month - 1, 1)
                .toLocaleString('default', { month: 'long' });

            cards.push({
                type:        'buddy_venue_echo',
                score:       60,
                gig:         heroGig,
                allGigs:     myVenueGigs,
                buddy,
                buddyName,
                headline:    venueName,
                subline:     `You and ${buddyName} · same room, different night`,
                eyebrow:     `${monthName} memories`,
                badge:       'Venue Echo',
                badgeColor:  'bg-cyan-500',
                journalKey:  `echo_${buddy.id}_${venueName.replace(/[^a-z0-9]/gi, '_')}_${month}`,
            });
        });
    });

    // Expose the set of "claimed" on-this-day keys so selectCards() can filter
    // the plain duplicates.
    window._feedTogetherKeys = togetherKeys;

    return cards;
}

// ─── CARD SELECTION ───────────────────────────────────────────────────────────

/**
 * Merges all pools, deduplicates, suppresses on_this_day cards superseded by
 * buddy_together, then applies pinned + seeded rotation to pick CARD_LIMIT.
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

    const unique = [...seen.values()].sort((a, b) => b.score - a.score);

    // Pinned tier — always shown
    const pinned    = unique.filter(c => c.score >= 90);
    const rotatable = unique.filter(c => c.score < 90);

    // Seeded rotation from the rotatable pool
    const candidates = rotatable.slice(0, CARD_LIMIT * POOL_MULTIPLIER);
    const shuffled   = seededShuffle(candidates, todaySeed());
    const slotsLeft  = Math.max(0, CARD_LIMIT - pinned.length);
    const selected   = shuffled.slice(0, slotsLeft);

    return [...pinned, ...selected].sort((a, b) => b.score - a.score);
}

// ─── IMAGE RESOLUTION ─────────────────────────────────────────────────────────

async function resolveHeroImage(gig, imgEl, cardIndex) {
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

    const userId = window.currentUser?.id;
    if (userId) {
        try {
            const { data: listed } = await supabase.storage
                .from('gig-photos')
                .list(userId, { search: fileName });
            if (listed?.length) {
                const { data, error } = await supabase.storage
                    .from('gig-photos')
                    .createSignedUrl(`${userId}/${fileName}`, 3600);
                if (!error && data?.signedUrl) { imgEl.src = data.signedUrl; return; }
            }
        } catch (e) { /* fall through to local */ }
    }

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
 */
function buddyAvatarPill(buddy) {
    if (!buddy) return '';
    const name     = buddy.display_name || buddy.username || '';
    const initials = name.slice(0, 2).toUpperCase();
    const imgTag   = buddy.avatar_url
        ? `<img src="${buddy.avatar_url}"
                alt="${name}"
                class="w-5 h-5 rounded-full object-cover flex-shrink-0"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
    const fallback = `<span class="w-5 h-5 rounded-full bg-indigo-200 text-indigo-700 text-[8px] font-black
                           flex items-center justify-center flex-shrink-0
                           ${buddy.avatar_url ? 'hidden' : ''}">${initials}</span>`;
    return `<span class="inline-flex items-center gap-1 mr-1">${imgTag}${fallback}</span>`;
}

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
    'buddy_together', 'buddy_on_this_day', 'buddy_venue_echo',
]);

// ─── CARD TEMPLATE ────────────────────────────────────────────────────────────

function renderCard(card, index) {
    // tip_discovery cards have their own renderer
    if (card.type === 'tip_discovery') return renderTipDiscoveryCard(card);

    const safeKey   = (card.journalKey || `card-${index}`).replace(/[^a-z0-9]/gi, '_');
    const hasDetail = EXPANDABLE_TYPES.has(card.type);
    const isSocial  = SOCIAL_TYPES.has(card.type);

    // Social cards get the buddy avatar woven into the eyebrow
    const eyebrowHtml = isSocial && card.buddy
        ? `<span class="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-white/60 mb-2">
               ${buddyAvatarPill(card.buddy)}${card.eyebrow}
           </span>`
        : `<span class="text-[9px] font-black uppercase tracking-widest text-white/60 mb-2 block">
               ${card.eyebrow}
           </span>`;

    // Top accent stripe colour for social cards
    const socialStripeClass = card.type === 'buddy_venue_echo'
        ? 'bg-cyan-500'
        : 'bg-rose-500';

    // Primary tap action
    const primaryAction = hasDetail
        ? `window._feedToggleDetail('${safeKey}', '${card.type}')`
        : `window.viewGigDetails('${(card.journalKey || '').replace(/'/g, "\\'")}')`;

    // For social cards the tap opens the gig modal (read-only for buddy cards)
    const socialAction = `window.viewGigDetails('${(card.gig?.['Journal Key'] || '').replace(/'/g, "\\'")}')`;

    const tapAction = isSocial ? socialAction : primaryAction;

    // CTA label
    const ctaLabel = (() => {
        if (card.type === 'buddy_together')    return 'View your show';
        if (card.type === 'buddy_on_this_day') return `See ${card.buddyName}'s show`;
        if (card.type === 'buddy_venue_echo')  return 'View your show';
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
             data-card-type="${card.type}">

            <!-- Hero image -->
            <img id="feed-img-${safeKey}"
                 src=""
                 class="absolute inset-0 w-full h-full object-cover ${isSocial ? 'opacity-35' : 'opacity-50'}"
                 alt=""
                 aria-hidden="true">

            <!-- Gradient overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-900/50 to-transparent"></div>

            <!-- Social accent stripe -->
            ${isSocial ? `<div class="absolute top-0 inset-x-0 h-1 ${socialStripeClass} opacity-70"></div>` : ''}

            <!-- Content -->
            <div class="relative z-10 flex flex-col justify-end flex-1 p-6">

                ${eyebrowHtml}

                <div onclick="${tapAction}" class="cursor-pointer">
                    <h3 class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mb-1">
                        ${card.headline}
                    </h3>
                    <p class="text-sm font-bold text-white/60">${card.subline}</p>
                </div>

                <div class="flex items-center justify-between mt-4">
                    <span class="${card.badgeColor} text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                        ${card.badge}
                    </span>
                    ${ctaLabel ? `
                    <button onclick="${tapAction}"
                            class="text-[10px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        ${ctaLabel}
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
                        <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                             class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                            <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                            <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0"></div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs font-bold text-white truncate">${g.OfficialVenue}</p>
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
                        <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                             class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                            <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                            <div class="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0"></div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs font-bold text-white truncate">${g.Band}</p>
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
                    <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                         class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                        <span class="text-[9px] font-black text-white/50 w-8 text-right">${gigYear(g)}</span>
                        <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-white truncate">${g.Band}</p>
                            <p class="text-[10px] text-white/50 truncate">${g.OfficialVenue}</p>
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
                            <p class="text-xs font-bold text-white truncate">${item.title}</p>
                            ${item.acquired_date
                                ? `<p class="text-[10px] text-white/50">${_formatAcquiredDate(item.acquired_date)}</p>`
                                : ''}
                        </div>
                        <span class="text-[9px] text-white/40 font-bold uppercase">${item.subtype || ''}</span>
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
                <p class="text-[9px] font-black uppercase tracking-widest text-white/50">Slide the tiles to reveal the show</p>
                <button id="feed-puzzle-new"
                        class="text-[9px] font-black uppercase tracking-widest text-white/40 hover:text-white transition-colors">
                    New puzzle
                </button>
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
    }

    requestAnimationFrame(() => {
        if (isPuzzle) startNewPuzzle();
        else window.initQuiz?.();
    });
};

// ─── PUBLIC INIT ──────────────────────────────────────────────────────────────

/**
 * Called when the Feed tab is activated.
 *
 * Fetch order:
 *   1. Collection items  — Supabase, own user
 *   2. Buddy journals    — Supabase, all buddies, 5 fields only
 *   3. Build + score all card types
 *   4. Seeded selection
 *   5. Render + async image resolution
 *
 * SessionStorage cache key includes date + journal length + collection count +
 * buddy count so it invalidates correctly when any data set changes.
 */
export async function init(journalData, performanceData, _ignored = []) {
    const container = document.getElementById('feed-cards-container');
    if (!container) return;

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

    // 2. Buddy journals
    const buddyJournalsByUser = await fetchBuddyJournals();
    const buddyProfiles       = window._following || [];

    // 3. Cache check
    const cacheKey   = `giglist_feed_${new Date().toDateString()}_j${journalData.length}_c${collectionItems.length}_b${buddyProfiles.length}`;
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
            else if (card.gig)       resolveHeroImage(card.gig, imgEl, i);
        });
        renderGameCard(container, journalData);
        return;
    }

    // 4. Build all card pools
    const gigCards   = buildCards(journalData, performanceData);
    const colCards   = buildCollectionCards(collectionItems, journalData);
    const buddyCards = buildBuddyCards(buddyJournalsByUser, journalData, buddyProfiles);
    const scored     = selectCards(gigCards, colCards, buddyCards);

    // Inject tip_discovery cards — at most 2 per render, after pinned content
    const tipCards = buildTipDiscoveryCards().slice(0, 2);
    const cards    = [
        ...scored.filter(c => c.score >= 90),   // pinned tier first
        ...tipCards,                              // then tip discovery
        ...scored.filter(c => c.score < 90),     // then rotatable
    ];

    if (cards.length === 0) {
        renderEmptyState(container);
        return;
    }

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
        }))
    ));

    // Resolve images async so the card skeletons appear immediately
    cards.forEach((card, i) => {
        const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
        const imgEl   = document.getElementById(`feed-img-${safeKey}`);
        if (!imgEl) return;
        if (card.collectionItem) resolveCollectionHeroImage(card.collectionItem, imgEl, i);
        else if (card.gig)       resolveHeroImage(card.gig, imgEl, i);
    });

    if (window.lucide) lucide.createIcons();
}
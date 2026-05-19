/**
 * GigList - Feed Module
 * v2.0.0 — May 2026
 *
 * Contextual feed engine. Evaluates card triggers against the user's journal
 * each time the Feed tab is activated, picks the top cards by score, and
 * renders them. All logic is client-side against already-loaded journal data
 * — no extra DB queries for basic card types.
 *
 * Card types (Phase 1 — original):
 *   - on_this_day        — exact day+month match in a past year
 *   - artist_story       — artist with 3+ shows gets a timeline card
 *   - season_flashback   — shows from this calendar month in past years
 *
 * Card types (Phase 1 — new splits & additions):
 *   - artist_first       — the very first time you saw an artist (3+ shows)
 *   - artist_milestone   — 5th, 10th, 15th, 20th show with an artist
 *   - artist_cities      — saw an artist in 3+ distinct cities
 *   - artist_era         — a distinct cluster of shows within a short window
 *   - venue_chapter      — your history at a specific venue (4+ shows)
 *   - first_last         — first OR last time you saw an artist (1–2 shows only)
 *
 * Collection card types (unchanged):
 *   - collection_band_story
 *   - collection_this_month
 *
 * Scoring & selection:
 *   Cards are scored, then the top pool is seeded-shuffled so the daily
 *   selection varies without being fully random on each page load.
 */

import { parseDate, slugify, slugifyArtist } from './utils.js';
import { supabase } from './supabase.js';
import { startNewPuzzle } from './games.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CARD_LIMIT      = 10;  // Max cards to show per feed load (raised from 6)
const POOL_MULTIPLIER = 2;   // Build a pool 2× the limit, then seed-rotate to pick CARD_LIMIT

const DEFAULT_IMAGES = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800",
];

// ─── SEED UTILITIES ───────────────────────────────────────────────────────────

/**
 * Simple seeded pseudo-random number (mulberry32).
 * Returns a function that produces deterministic floats 0–1.
 */
function seededRng(seed) {
    let s = seed >>> 0;
    return function () {
        s += 0x6D2B79F5;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Seeded shuffle (Fisher–Yates). Does not mutate the original array.
 */
function seededShuffle(arr, seed) {
    const rng  = seededRng(seed);
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * Today's seed — changes daily so the feed rotates even when journal hasn't changed.
 */
function todaySeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ─── SHARED DATE HELPERS ──────────────────────────────────────────────────────

function gigDay(g)   { return Number(g.Date.split('/')[0]); }
function gigMonth(g) { return Number(g.Date.split('/')[1]); }
function gigYear(g)  { return Number(g.Date.split('/')[2]); }

// ─── CARD ENGINE ──────────────────────────────────────────────────────────────

/**
 * Evaluates all card triggers and returns a scored, sorted list of cards.
 * The pool is intentionally larger than CARD_LIMIT so the seeded rotation
 * can pick a varied daily subset.
 */
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
    // Exact day+month match in a previous year. One card per matching show
    // (up to 3) so multiple anniversaries all surface, not just the most recent.
    const onThisDayGigs = pastGigs.filter(g => {
        if (g.Date.split('/').length !== 3) return false;
        return gigDay(g) === todayDay && gigMonth(g) === todayMonth && gigYear(g) < thisYear;
    }).sort((a, b) => gigYear(b) - gigYear(a));

    const onThisDayArtists = new Set();

    onThisDayGigs.forEach((primary, idx) => {
        const yearsAgo = thisYear - gigYear(primary);
        // Score decreases slightly for older anniversaries so most-recent leads
        cards.push({
            type:     'on_this_day',
            score:    100 - idx * 2,
            gig:      primary,
            allGigs:  onThisDayGigs,
            headline: primary.Band,
            subline:  `${primary.OfficialVenue} · ${primary.Date}`,
            eyebrow:  `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago today`,
            badge:    'On This Day',
            badgeColor: 'bg-rose-500',
            journalKey: primary['Journal Key'],
        });
        onThisDayArtists.add(primary.Band);
    });

    // ── PER-ARTIST CARDS ─────────────────────────────────────────────────────
    // Build a rich set of per-artist cards. Each eligible artist can contribute
    // multiple card types; they all enter the pool and compete by score.

    const showsByArtist = {};
    pastGigs.forEach(g => {
        const artist = g.Band || '';
        if (!artist) return;
        if (!showsByArtist[artist]) showsByArtist[artist] = [];
        showsByArtist[artist].push(g);
    });

    // Sort artists by show count descending so we process the most interesting first
    const sortedArtists = Object.entries(showsByArtist)
        .sort((a, b) => b[1].length - a[1].length);

    sortedArtists.forEach(([artist, shows]) => {
        const sorted = [...shows].sort((a, b) => {
            const da = parseDate(a.Date) || new Date(0);
            const db = parseDate(b.Date) || new Date(0);
            return da - db;
        });

        const hasAnniversary = sorted.some(g =>
            gigDay(g) === todayDay && gigMonth(g) === todayMonth
        );
        // Bonus score for anniversary artists
        const anniversaryBonus = hasAnniversary ? 15 : 0;

        // ── ARTIST STORY (3+ shows) — the full timeline overview card ────────
        if (sorted.length >= 3) {
            const first     = sorted[0];
            const last      = sorted[sorted.length - 1];
            const yearSpan  = gigYear(last) - gigYear(first);
            // Don't duplicate if already shown in On This Day
            const baseScore = onThisDayArtists.has(artist) ? 55 : 70;

            cards.push({
                type:     'artist_story',
                score:    baseScore + anniversaryBonus,
                gig:      last,
                allGigs:  sorted,
                headline: artist,
                subline:  yearSpan > 0
                    ? `${sorted.length} shows across ${yearSpan} year${yearSpan !== 1 ? 's' : ''}`
                    : `${sorted.length} shows`,
                eyebrow:  'Your History',
                badge:    `${sorted.length} Shows`,
                badgeColor: 'bg-indigo-500',
                journalKey: last['Journal Key'],
            });
        }

        // ── ARTIST FIRST (3+ shows) — the origin story card ─────────────────
        if (sorted.length >= 3) {
            const first    = sorted[0];
            const firstYear = gigYear(first);
            const yearsAgo  = thisYear - firstYear;

            cards.push({
                type:     'artist_first',
                score:    62 + anniversaryBonus,
                gig:      first,
                allGigs:  sorted,
                headline: artist,
                subline:  `${first.OfficialVenue} · ${first.Date}`,
                eyebrow:  `First time seeing them — ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago`,
                badge:    'First Show',
                badgeColor: 'bg-emerald-500',
                journalKey: first['Journal Key'],
            });
        }

        // ── ARTIST MILESTONE — 5th, 10th, 15th, 20th, 25th show ─────────────
        const MILESTONES = [5, 10, 15, 20, 25, 30];
        MILESTONES.forEach(n => {
            if (sorted.length >= n) {
                const milestoneGig  = sorted[n - 1];
                const milestoneYear = gigYear(milestoneGig);
                const yearsAgo      = thisYear - milestoneYear;
                const suffix        = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';

                cards.push({
                    type:     'artist_milestone',
                    score:    65 + anniversaryBonus - (MILESTONES.indexOf(n) * 3),
                    gig:      milestoneGig,
                    allGigs:  sorted,
                    headline: artist,
                    subline:  `${milestoneGig.OfficialVenue} · ${milestoneGig.Date}`,
                    eyebrow:  `Your ${n}${suffix} time seeing them`,
                    badge:    `Show #${n}`,
                    badgeColor: 'bg-violet-500',
                    journalKey: milestoneGig['Journal Key'],
                });
            }
        });

        // ── ARTIST CITIES (3+ distinct cities, 4+ shows) ─────────────────────
        if (sorted.length >= 4) {
            const cities = [...new Set(sorted.map(g => {
                // Best-effort city extraction: venue field often has "Venue, City"
                const parts = (g.OfficialVenue || '').split(',');
                return parts.length > 1 ? parts[parts.length - 1].trim() : g.OfficialVenue;
            }))].filter(Boolean);

            if (cities.length >= 3) {
                const last = sorted[sorted.length - 1];
                cards.push({
                    type:     'artist_cities',
                    score:    58 + anniversaryBonus,
                    gig:      last,
                    allGigs:  sorted,
                    headline: artist,
                    subline:  `Seen in ${cities.length} different places`,
                    eyebrow:  'You followed them everywhere',
                    badge:    `${cities.length} Cities`,
                    badgeColor: 'bg-sky-500',
                    journalKey: last['Journal Key'],
                });
            }
        }

        // ── ARTIST ERA — a dense cluster of shows within a 3-year window ─────
        // Find the 3-year window with the most shows (sliding window).
        if (sorted.length >= 4) {
            let bestStart = 0, bestCount = 0;
            for (let i = 0; i < sorted.length; i++) {
                const windowYear = gigYear(sorted[i]);
                const count = sorted.filter(g =>
                    gigYear(g) >= windowYear && gigYear(g) <= windowYear + 2
                ).length;
                if (count > bestCount) { bestCount = count; bestStart = i; }
            }

            if (bestCount >= 3 && bestCount < sorted.length) {
                const eraStart = gigYear(sorted[bestStart]);
                const eraEnd   = eraStart + 2;
                const eraGigs  = sorted.filter(g =>
                    gigYear(g) >= eraStart && gigYear(g) <= eraEnd
                );
                const representative = eraGigs[Math.floor(eraGigs.length / 2)];

                cards.push({
                    type:     'artist_era',
                    score:    55 + anniversaryBonus,
                    gig:      representative,
                    allGigs:  eraGigs,
                    headline: artist,
                    subline:  `${bestCount} shows between ${eraStart} and ${eraEnd}`,
                    eyebrow:  'Your peak era',
                    badge:    `${eraStart}–${eraEnd}`,
                    badgeColor: 'bg-orange-500',
                    journalKey: representative['Journal Key'],
                });
            }
        }

        // ── FIRST / LAST (1–2 shows only) — bittersweet cards ────────────────
        if (sorted.length === 1) {
            const gig      = sorted[0];
            const yearsAgo = thisYear - gigYear(gig);
            cards.push({
                type:     'first_last',
                score:    45 + anniversaryBonus,
                gig,
                allGigs:  sorted,
                headline: artist,
                subline:  `${gig.OfficialVenue} · ${gig.Date}`,
                eyebrow:  `The one and only time`,
                badge:    'One Show',
                badgeColor: 'bg-slate-500',
                journalKey: gig['Journal Key'],
            });
        }

        if (sorted.length === 2) {
            const last     = sorted[sorted.length - 1];
            const yearsAgo = thisYear - gigYear(last);
            cards.push({
                type:     'first_last',
                score:    47 + anniversaryBonus,
                gig:      last,
                allGigs:  sorted,
                headline: artist,
                subline:  `Last seen at ${last.OfficialVenue} · ${last.Date}`,
                eyebrow:  `Seen twice, ${yearsAgo > 0 ? yearsAgo + ' years ago' : 'recently'}`,
                badge:    'Two Shows',
                badgeColor: 'bg-slate-500',
                journalKey: last['Journal Key'],
            });
        }
    });

    // ── SEASON FLASHBACK ─────────────────────────────────────────────────────
    // Shows from this calendar month in previous years (excluding today's date).
    const seasonGigs = pastGigs.filter(g => {
        if (g.Date.split('/').length !== 3) return false;
        return gigMonth(g) === thisMonth && gigYear(g) < thisYear &&
               !(gigDay(g) === todayDay && gigMonth(g) === todayMonth);
    }).sort((a, b) => (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0));

    if (seasonGigs.length >= 2) {
        const monthName = today.toLocaleString('default', { month: 'long' });
        const seed      = todaySeed();
        const shuffled  = seededShuffle(seasonGigs, seed);
        const featured  = shuffled[0];

        cards.push({
            type:     'season_flashback',
            score:    50,
            gig:      featured,
            allGigs:  seasonGigs,
            headline: featured.Band,
            subline:  `${featured.OfficialVenue} · ${featured.Date}`,
            eyebrow:  `Your ${monthName} in music`,
            badge:    `${seasonGigs.length} ${monthName} Show${seasonGigs.length !== 1 ? 's' : ''}`,
            badgeColor: 'bg-amber-500',
            journalKey: featured['Journal Key'],
        });
    }

    // ── VENUE CHAPTER ─────────────────────────────────────────────────────────
    // A venue the user has visited 4+ times. Prefer venues with a show this month.
    const showsByVenue = {};
    pastGigs.forEach(g => {
        const venue = g.OfficialVenue || '';
        if (!venue) return;
        if (!showsByVenue[venue]) showsByVenue[venue] = [];
        showsByVenue[venue].push(g);
    });

    const eligibleVenues = Object.entries(showsByVenue)
        .filter(([, shows]) => shows.length >= 4)
        .sort((a, b) => {
            const aThisMonth = a[1].some(g => gigMonth(g) === thisMonth);
            const bThisMonth = b[1].some(g => gigMonth(g) === thisMonth);
            if (aThisMonth && !bThisMonth) return -1;
            if (!aThisMonth && bThisMonth) return 1;
            return b[1].length - a[1].length;
        });

    if (eligibleVenues.length > 0) {
        // Seed-rotate which venue appears today so it varies daily
        const venueIdx   = Math.floor(seededRng(todaySeed())() * Math.min(eligibleVenues.length, 5));
        const [venueName, venueShows] = eligibleVenues[venueIdx];
        const venueSorted = [...venueShows].sort((a, b) =>
            (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0)
        );
        const firstYear  = gigYear(venueSorted[0]);
        const lastYear   = gigYear(venueSorted[venueSorted.length - 1]);
        const span       = lastYear - firstYear;
        const heroGig    = venueSorted[venueSorted.length - 1];

        cards.push({
            type:     'venue_chapter',
            score:    52,
            gig:      heroGig,
            allGigs:  venueSorted,
            headline: venueName,
            subline:  span > 0
                ? `${venueShows.length} shows · ${firstYear}–${lastYear}`
                : `${venueShows.length} shows in ${firstYear}`,
            eyebrow:  'Your favourite room',
            badge:    `${venueShows.length} Visits`,
            badgeColor: 'bg-teal-500',
            journalKey: heroGig['Journal Key'],
        });
    }

    // Return unsorted — caller will score-sort then seed-rotate
    return cards;
}

// ─── COLLECTION CARD BUILDERS ─────────────────────────────────────────────────

/**
 * Builds feed cards from collection items.
 *   - collection_band_story: items tied to a band the user has also seen live
 *   - collection_this_month: items acquired in this calendar month in past years
 */
function buildCollectionCards(collectionItems, journalData) {
    if (!collectionItems?.length) return [];

    const today      = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth  = today.getMonth() + 1;
    const thisYear   = today.getFullYear();
    const monthName  = today.toLocaleString('default', { month: 'long' });

    const cards = [];

    // ── COLLECTION: THIS MONTH OVER THE YEARS ────────────────────────────────
    const thisMonthItems = collectionItems.filter(item => {
        if (!item.acquired_date) return false;
        const parts = item.acquired_date.split('-');
        const year  = parseInt(parts[0], 10);
        const month = parseInt(parts[1] || '0', 10);
        return month === thisMonth && year < thisYear;
    }).sort((a, b) => (b.acquired_date || '').localeCompare(a.acquired_date || ''));

    if (thisMonthItems.length > 0) {
        const featured = thisMonthItems[0];
        const year     = parseInt(featured.acquired_date.split('-')[0], 10);
        const yearsAgo = thisYear - year;

        cards.push({
            type:          'collection_this_month',
            score:         85,
            collectionItem: featured,
            allItems:       thisMonthItems,
            headline:       featured.title,
            subline:        `${featured.band_name ? featured.band_name + ' · ' : ''}Added ${_formatAcquiredDateFeed(featured.acquired_date)}`,
            eyebrow:        `In your collection ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago this month`,
            badge:          `${thisMonthItems.length} ${monthName} Pick${thisMonthItems.length !== 1 ? 's' : ''}`,
            badgeColor:     'bg-amber-500',
            journalKey:     `col_month_${featured.id}`,
        });
    }

    // ── COLLECTION: BAND CROSSOVER ────────────────────────────────────────────
    const bandCounts = {};
    collectionItems.forEach(item => {
        if (!item.band_name) return;
        bandCounts[item.band_name] = (bandCounts[item.band_name] || 0) + 1;
    });

    const gigBands = new Set(journalData.map(g => (g.Band || '').toLowerCase()));

    const crossoverBands = Object.entries(bandCounts)
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

function _formatAcquiredDateFeed(raw) {
    if (!raw) return '';
    const parts = raw.split('-');
    if (parts.length === 2 && parts[1]) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun',
                        'Jul','Aug','Sep','Oct','Nov','Dec'];
        const m = parseInt(parts[1], 10);
        return `${months[m - 1] || parts[1]} ${parts[0]}`;
    }
    return parts[0];
}

// ─── CARD SELECTION ───────────────────────────────────────────────────────────

/**
 * Merges all card pools, deduplicates by journalKey, score-sorts,
 * then applies seeded daily rotation to pick CARD_LIMIT cards from
 * the top POOL_MULTIPLIER × CARD_LIMIT candidates.
 *
 * High-score cards (≥ 90) are always included — they represent genuine
 * date-anchored moments (On This Day, collection this month) that should
 * never be rotated out.
 */
function selectCards(gigCards, colCards) {
    const all = [...gigCards, ...colCards];

    // Deduplicate: keep highest-scoring card per journalKey
    const seen = new Map();
    for (const card of all) {
        const key = card.journalKey;
        if (!seen.has(key) || card.score > seen.get(key).score) {
            seen.set(key, card);
        }
    }

    const unique = [...seen.values()].sort((a, b) => b.score - a.score);

    // Always-include tier (score ≥ 90)
    const pinned  = unique.filter(c => c.score >= 90);
    const rotatable = unique.filter(c => c.score < 90);

    // From the rotatable pool, take up to POOL_MULTIPLIER × CARD_LIMIT candidates,
    // shuffle them with today's seed, then pick enough to fill up to CARD_LIMIT
    const poolSize    = CARD_LIMIT * POOL_MULTIPLIER;
    const candidates  = rotatable.slice(0, poolSize);
    const shuffled    = seededShuffle(candidates, todaySeed());
    const slotsLeft   = Math.max(0, CARD_LIMIT - pinned.length);
    const selected    = shuffled.slice(0, slotsLeft);

    // Re-sort the final set by score so the render order is coherent
    return [...pinned, ...selected].sort((a, b) => b.score - a.score);
}

// ─── IMAGE RESOLUTION ────────────────────────────────────────────────────────

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
            const artistProbe = new Image();
            artistProbe.onload  = () => { imgEl.src = artistPath; };
            artistProbe.onerror = () => { imgEl.src = fallback; };
            artistProbe.src = artistPath;
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
                if (!error && data?.signedUrl) {
                    imgEl.src = data.signedUrl;
                    return;
                }
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
            if (!error && data?.signedUrl) {
                imgEl.src = data.signedUrl;
                return;
            }
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

// ─── RENDERING ────────────────────────────────────────────────────────────────

function renderEmptyState(container) {
    container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div class="w-16 h-16 bg-slate-100 rounded-[1.5rem] flex items-center justify-center">
                <i data-lucide="music-2" class="w-8 h-8 text-slate-300" aria-hidden="true"></i>
            </div>
            <div class="space-y-1">
                <p class="font-black text-slate-700 text-lg uppercase italic tracking-tight">Nothing yet</p>
                <p class="text-slate-400 text-sm font-medium">Add some shows and come back — your feed will fill up fast.</p>
            </div>
        </div>`;
    if (window.lucide) lucide.createIcons();
}

// ─── GAME CARD & MODAL ────────────────────────────────────────────────────────

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
    const subline    = isPuzzle
        ? 'Piece together a show from your history'
        : 'How well do you know your own gig history?';
    const badge      = isPuzzle ? '🧩 Puzzle' : '🎤 Quiz';
    const badgeColor = isPuzzle ? 'bg-violet-500' : 'bg-rose-500';
    const imgSrc     = DEFAULT_IMAGES[1];

    const tile = document.createElement('div');
    tile.id = 'feed-game-card';
    tile.innerHTML = `
        <div class="relative overflow-hidden rounded-[2rem] bg-slate-900 shadow-xl min-h-[200px] flex flex-col"
             role="article">
            <img src="${imgSrc}"
                 class="absolute inset-0 w-full h-full object-cover opacity-30"
                 alt=""
                 aria-hidden="true">
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-900/40 to-transparent"></div>
            <div class="relative z-10 flex flex-col justify-end flex-1 p-6">
                <span class="text-[9px] font-black uppercase tracking-widest text-white/60 mb-2">
                    ${eyebrow}
                </span>
                <h3 class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mb-1">
                    ${headline}
                </h3>
                <p class="text-sm font-bold text-white/60">${subline}</p>
                <div class="flex items-center justify-between mt-4">
                    <span class="${badgeColor} text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                        ${badge}
                    </span>
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
            <div id="puzzle-grid"
                 class="grid gap-1 w-full aspect-square rounded-2xl overflow-hidden bg-slate-800">
            </div>
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
    modal.id = 'feed-game-modal';
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
        <div class="flex-1 overflow-y-auto px-5 pb-8 flex flex-col">
            ${gameInnerHtml}
        </div>`;

    document.body.appendChild(modal);
    if (window.lucide) lucide.createIcons();

    const close = () => modal.remove();
    document.getElementById('feed-game-modal-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (isPuzzle) {
        document.getElementById('feed-puzzle-new')?.addEventListener('click', () => startNewPuzzle());
    }

    const onKeyDown = (e) => {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeyDown); }
    };
    document.addEventListener('keydown', onKeyDown);
    modal.addEventListener('remove', () => document.removeEventListener('keydown', onKeyDown));

    requestAnimationFrame(() => {
        if (isPuzzle) {
            startNewPuzzle();
        } else {
            window.initQuiz?.();
        }
    });
};

// ─── DETAIL RENDERERS ─────────────────────────────────────────────────────────

/**
 * Renders the expanded detail panel inside an Artist Story / artist split card.
 * Shows a mini-timeline of all shows with that artist.
 */
function renderArtistTimeline(card) {
    const container = document.getElementById(`feed-detail-${card.journalKey?.replace(/[^a-z0-9]/gi, '_')}`);
    if (!container) return;

    const isVisible = !container.classList.contains('hidden');
    if (isVisible) {
        container.classList.add('hidden');
        return;
    }

    container.innerHTML = `
        <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
            ${card.allGigs.map((g, i) => {
                const y = gigYear(g);
                return `
                <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                     class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                    <span class="text-[9px] font-black text-white/50 w-8 text-right">${y}</span>
                    <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0"></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-white truncate">${g.OfficialVenue}</p>
                    </div>
                    <span class="text-[9px] text-white/40 font-bold">#${i + 1}</span>
                </div>`;
            }).join('')}
        </div>`;
    container.classList.remove('hidden');
}

function renderSeasonList(card) {
    const container = document.getElementById(`feed-detail-${card.journalKey?.replace(/[^a-z0-9]/gi, '_')}`);
    if (!container) return;

    const isVisible = !container.classList.contains('hidden');
    if (isVisible) {
        container.classList.add('hidden');
        return;
    }

    container.innerHTML = `
        <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
            ${card.allGigs.slice(0, 8).map(g => {
                const y = gigYear(g);
                return `
                <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                     class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                    <span class="text-[9px] font-black text-white/50 w-8 text-right">${y}</span>
                    <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-white truncate">${g.Band}</p>
                        <p class="text-[10px] text-white/50 truncate">${g.OfficialVenue}</p>
                    </div>
                </div>`;
            }).join('')}
            ${card.allGigs.length > 8 ? `<p class="text-[10px] text-white/40 text-center pt-1">+${card.allGigs.length - 8} more</p>` : ''}
        </div>`;
    container.classList.remove('hidden');
}

// ─── CARD TEMPLATE ────────────────────────────────────────────────────────────

/**
 * Cards that expand to show a list of shows on tap.
 */
const EXPANDABLE_TYPES = new Set([
    'artist_story',
    'artist_first',
    'artist_milestone',
    'artist_cities',
    'artist_era',
    'first_last',
    'season_flashback',
    'venue_chapter',
    'collection_band_story',
    'collection_this_month',
]);

function renderCard(card, index) {
    const safeKey   = (card.journalKey || `card-${index}`).replace(/[^a-z0-9]/gi, '_');
    const hasDetail = EXPANDABLE_TYPES.has(card.type);

    const detailToggle = hasDetail
        ? `window._feedToggleDetail('${safeKey}', '${card.type}')`
        : `window.viewGigDetails('${(card.journalKey || '').replace(/'/g, "\\'")}')`;

    // Detail label varies by card type
    const detailLabel = (() => {
        if (card.type === 'season_flashback')
            return `See all ${card.allGigs?.length} shows`;
        if (card.type === 'venue_chapter')
            return `See all ${card.allGigs?.length} visits`;
        if (card.type === 'collection_band_story')
            return `See ${card.allItems?.length} item${card.allItems?.length !== 1 ? 's' : ''}`;
        if (card.type === 'collection_this_month')
            return card.allItems?.length > 1 ? `See ${card.allItems.length} items` : '';
        if (card.allGigs?.length > 1)
            return `See all ${card.allGigs.length} shows`;
        return '';
    })();

    return `
        <div class="relative overflow-hidden rounded-[2rem] bg-slate-900 shadow-xl min-h-[260px] flex flex-col"
             role="article">

            <!-- Hero image -->
            <img id="feed-img-${safeKey}"
                 src=""
                 class="absolute inset-0 w-full h-full object-cover opacity-50"
                 alt=""
                 aria-hidden="true">

            <!-- Gradient overlay -->
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-900/50 to-transparent"></div>

            <!-- Content -->
            <div class="relative z-10 flex flex-col justify-end flex-1 p-6">

                <span class="text-[9px] font-black uppercase tracking-widest text-white/60 mb-2">
                    ${card.eyebrow}
                </span>

                <div onclick="${detailToggle}" class="cursor-pointer">
                    <h3 class="text-3xl font-black italic uppercase tracking-tighter text-white leading-none mb-1">
                        ${card.headline}
                    </h3>
                    <p class="text-sm font-bold text-white/60">${card.subline}</p>
                </div>

                <div class="flex items-center justify-between mt-4">
                    <span class="${card.badgeColor} text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full">
                        ${card.badge}
                    </span>
                    ${hasDetail && detailLabel ? `
                    <button onclick="${detailToggle}"
                            class="text-[10px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        ${detailLabel}
                        <i data-lucide="chevron-down" class="w-3.5 h-3.5" id="feed-chevron-${safeKey}" aria-hidden="true"></i>
                    </button>` : `
                    <button onclick="window.viewGigDetails('${(card.journalKey || '').replace(/'/g, "\\'")}')"
                            class="text-[10px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        View gig
                        <i data-lucide="arrow-right" class="w-3.5 h-3.5" aria-hidden="true"></i>
                    </button>`}
                </div>

                <!-- Expandable detail panel -->
                ${hasDetail ? `<div id="feed-detail-${safeKey}" class="hidden"></div>` : ''}
            </div>
        </div>`;
}

// ─── TOGGLE HANDLER ───────────────────────────────────────────────────────────

window._feedToggleDetail = (safeKey, cardType) => {

    // ── Artist cards (all types that show a gig timeline) ────────────────────
    const ARTIST_TYPES = new Set([
        'artist_story', 'artist_first', 'artist_milestone',
        'artist_cities', 'artist_era', 'first_last',
    ]);

    if (ARTIST_TYPES.has(cardType)) {
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden  = detailEl.classList.contains('hidden');

        if (isHidden) {
            const cardEl   = detailEl.closest('[role="article"]');
            const headline = cardEl?.querySelector('h3')?.textContent?.trim();

            if (headline) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const shows = (window.journalData || [])
                    .filter(g => {
                        const d = parseDate(g.Date);
                        return g.Band === headline && d && d < today;
                    })
                    .sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));

                detailEl.innerHTML = `
                    <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                        ${shows.map((g, i) => {
                            const y = gigYear(g);
                            return `
                            <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                                 class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                                <span class="text-[9px] font-black text-white/50 w-8 text-right">${y}</span>
                                <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0"></div>
                                <div class="flex-1 min-w-0">
                                    <p class="text-xs font-bold text-white truncate">${g.OfficialVenue}</p>
                                </div>
                                <span class="text-[9px] text-white/40 font-bold">#${i + 1}</span>
                            </div>`;
                        }).join('')}
                    </div>`;
                if (window.lucide) lucide.createIcons();
            }
        }

        detailEl.classList.toggle('hidden');
        if (chevronEl) {
            chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
        }
        return;
    }

    // ── Venue chapter ─────────────────────────────────────────────────────────
    if (cardType === 'venue_chapter') {
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden = detailEl.classList.contains('hidden');

        if (isHidden) {
            const cardEl    = detailEl.closest('[role="article"]');
            const venueName = cardEl?.querySelector('h3')?.textContent?.trim();

            if (venueName) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const shows = (window.journalData || [])
                    .filter(g => {
                        const d = parseDate(g.Date);
                        return g.OfficialVenue === venueName && d && d < today;
                    })
                    .sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));

                detailEl.innerHTML = `
                    <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                        ${shows.map(g => {
                            const y = gigYear(g);
                            return `
                            <div onclick="window.viewGigDetails('${(g['Journal Key'] || '').replace(/'/g, "\\'")}')"
                                 class="flex items-center gap-3 cursor-pointer hover:bg-white/10 rounded-xl px-2 py-1.5 transition-colors">
                                <span class="text-[9px] font-black text-white/50 w-8 text-right">${y}</span>
                                <div class="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0"></div>
                                <div class="flex-1 min-w-0">
                                    <p class="text-xs font-bold text-white truncate">${g.Band}</p>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>`;
                if (window.lucide) lucide.createIcons();
            }
        }

        detailEl.classList.toggle('hidden');
        if (chevronEl) chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
        return;
    }

    // ── Season flashback ──────────────────────────────────────────────────────
    if (cardType === 'season_flashback') {
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden = detailEl.classList.contains('hidden');

        if (isHidden) {
            const today     = new Date();
            today.setHours(0, 0, 0, 0);
            const thisMonth = today.getMonth() + 1;
            const thisYear  = today.getFullYear();
            const todayDay  = today.getDate();

            const seasonGigs = (window.journalData || []).filter(g => {
                if (g.Date.split('/').length !== 3) return false;
                const gd = parseDate(g.Date);
                return gigMonth(g) === thisMonth && gigYear(g) < thisYear &&
                       gd && gd < today && !(gigDay(g) === todayDay && gigMonth(g) === thisMonth);
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
                    ${seasonGigs.length > 8 ? `<p class="text-[10px] text-white/40 text-center pt-1">+${seasonGigs.length - 8} more</p>` : ''}
                </div>`;
            if (window.lucide) lucide.createIcons();
        }

        detailEl.classList.toggle('hidden');
        if (chevronEl) chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
        return;
    }

    // ── Collection cards ──────────────────────────────────────────────────────
    if (cardType === 'collection_band_story' || cardType === 'collection_this_month') {
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden = detailEl.classList.contains('hidden');

        if (isHidden) {
            const allItems = window._collectionItems || [];
            let items;

            if (cardType === 'collection_band_story') {
                const cardEl   = detailEl.closest('[role="article"]');
                const bandName = cardEl?.querySelector('h3')?.textContent?.trim() || '';
                items = allItems.filter(i =>
                    (i.band_name || '').toLowerCase() === bandName.toLowerCase()
                );
            } else {
                const today     = new Date();
                const thisMonth = today.getMonth() + 1;
                const thisYear  = today.getFullYear();
                items = allItems.filter(item => {
                    if (!item.acquired_date) return false;
                    const parts = item.acquired_date.split('-');
                    const year  = parseInt(parts[0], 10);
                    const month = parseInt(parts[1] || '0', 10);
                    return month === thisMonth && year < thisYear;
                }).sort((a, b) => (b.acquired_date || '').localeCompare(a.acquired_date || ''));
            }

            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const _fmtAcq = (raw) => {
                if (!raw) return '';
                const p = raw.split('-');
                if (p.length === 2) return `${months[parseInt(p[1],10)-1]||p[1]} ${p[0]}`;
                return p[0];
            };

            detailEl.innerHTML = `
                <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                    ${items.slice(0, 8).map(item => `
                    <div class="flex items-center gap-3 px-2 py-1.5">
                        <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold text-white truncate">${item.title}</p>
                            ${item.acquired_date ? `<p class="text-[10px] text-white/50">${_fmtAcq(item.acquired_date)}</p>` : ''}
                        </div>
                        <span class="text-[9px] text-white/40 font-bold uppercase">${item.subtype || ''}</span>
                    </div>`).join('')}
                    ${items.length > 8 ? `<p class="text-[10px] text-white/40 text-center pt-1">+${items.length - 8} more</p>` : ''}
                </div>`;
            if (window.lucide) lucide.createIcons();
        }

        detailEl.classList.toggle('hidden');
        if (chevronEl) chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
    }
};

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Called when the Feed tab is activated.
 * Fetches collection items directly so feed cards work regardless of whether
 * the Collection tab has ever been opened in this session.
 * Checks sessionStorage cache first — only recomputes if the date has changed
 * or data has been updated.
 */
export async function init(journalData, performanceData, _ignored = []) {
    const container = document.getElementById('feed-cards-container');
    if (!container) return;

    // Fetch collection items fresh
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
        console.warn('[Feed] Could not fetch collection items:', e.message);
    }

    window._collectionItems = collectionItems;

    // Cache key includes date + journal size + collection size
    const cacheKey        = `giglist_feed_${new Date().toDateString()}_${journalData.length}_${collectionItems.length}`;
    const cachedHtml      = sessionStorage.getItem(cacheKey);
    const cachedCardsJson = sessionStorage.getItem(`${cacheKey}_cards`);

    if (cachedHtml && cachedCardsJson) {
        container.innerHTML = cachedHtml;
        if (window.lucide) lucide.createIcons();
        const cachedCards = JSON.parse(cachedCardsJson);
        cachedCards.forEach((card, i) => {
            const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
            const imgEl   = document.getElementById(`feed-img-${safeKey}`);
            if (!imgEl) return;
            if (card.collectionItem) {
                resolveCollectionHeroImage(card.collectionItem, imgEl, i);
            } else if (card.gig) {
                resolveHeroImage(card.gig, imgEl, i);
            }
        });
        renderGameCard(container, journalData);
        return;
    }

    const gigCards = buildCards(journalData, performanceData);
    const colCards = buildCollectionCards(collectionItems, journalData);
    const cards    = selectCards(gigCards, colCards);

    if (cards.length === 0) {
        renderEmptyState(container);
        return;
    }

    const html = cards.map((card, i) => renderCard(card, i)).join('');
    container.innerHTML = html;

    renderGameCard(container, journalData);

    // Cache HTML skeleton + card metadata
    sessionStorage.setItem(cacheKey, html);
    sessionStorage.setItem(`${cacheKey}_cards`, JSON.stringify(
        cards.map(c => ({ journalKey: c.journalKey, gig: c.gig || null, collectionItem: c.collectionItem || null }))
    ));

    // Resolve images async
    cards.forEach((card, i) => {
        const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
        const imgEl   = document.getElementById(`feed-img-${safeKey}`);
        if (!imgEl) return;
        if (card.collectionItem) {
            resolveCollectionHeroImage(card.collectionItem, imgEl, i);
        } else if (card.gig) {
            resolveHeroImage(card.gig, imgEl, i);
        }
    });

    if (window.lucide) lucide.createIcons();
}
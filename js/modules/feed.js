/**
 * GigList - Feed Module
 * v1.0.0 — April 2026
 *
 * Contextual feed engine. Evaluates card triggers against the user's journal
 * each time the Feed tab is activated, picks the top cards by score, and
 * renders them. All logic is client-side against already-loaded journal data
 * — no extra DB queries for basic card types.
 *
 * Card types (Phase 1):
 *   - on_this_day     — exact day+month match in a past year
 *   - artist_story    — artist with 3+ shows gets a timeline card
 *   - season_flashback — shows from this calendar month in past years
 *
 * Card types (Phase 2, stubs ready):
 *   - venue_chapter, milestone, festival_chapter, first_last
 */

import { parseDate, slugify, slugifyArtist } from './utils.js';
import { supabase } from './supabase.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CARD_LIMIT = 6; // Max cards to show per feed load

const DEFAULT_IMAGES = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800",
];

// ─── CARD ENGINE ──────────────────────────────────────────────────────────────

/**
 * Evaluates all card triggers and returns a scored, sorted list of cards.
 */
function buildCards(journalData, performanceData) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDay   = today.getDate();
    const todayMonth = today.getMonth() + 1; // 1-indexed
    const thisYear   = today.getFullYear();
    const thisMonth  = today.getMonth() + 1;

    const pastGigs = journalData.filter(g => {
        const d = parseDate(g.Date);
        return d && d < today;
    });

    const cards = [];

    // ── ON THIS DAY ──────────────────────────────────────────────────────────
    // Exact day+month match in a previous year. Scores highest.
    const onThisDayGigs = pastGigs.filter(g => {
        const parts = g.Date.split('/');
        if (parts.length !== 3) return false;
        const [d, m, y] = parts.map(Number);
        return d === todayDay && m === todayMonth && y < thisYear;
    }).sort((a, b) => {
        const [,,ya] = a.Date.split('/').map(Number);
        const [,,yb] = b.Date.split('/').map(Number);
        return yb - ya; // Most recent anniversary first
    });

    if (onThisDayGigs.length > 0) {
        const primary = onThisDayGigs[0];
        const [,,gigYear] = primary.Date.split('/').map(Number);
        const yearsAgo = thisYear - gigYear;

        cards.push({
            type:     'on_this_day',
            score:    100,
            gig:      primary,
            allGigs:  onThisDayGigs,
            headline: primary.Band,
            subline:  `${primary.OfficialVenue} · ${primary.Date}`,
            eyebrow:  `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago today`,
            badge:    'On This Day',
            badgeColor: 'bg-rose-500',
            journalKey: primary['Journal Key'],
        });
    }

    // ── ARTIST STORY ─────────────────────────────────────────────────────────
    // Artist with 3+ shows. Prefer artists with an anniversary today, else
    // pick the one with the most shows. One card only.
    const showsByArtist = {};
    pastGigs.forEach(g => {
        const artist = g.Band || '';
        if (!artist) return;
        if (!showsByArtist[artist]) showsByArtist[artist] = [];
        showsByArtist[artist].push(g);
    });

    const eligibleArtists = Object.entries(showsByArtist)
        .filter(([, shows]) => shows.length >= 3)
        .sort((a, b) => {
            // Prefer artist with a show anniversary today
            const aHasAnniversary = a[1].some(g => {
                const parts = g.Date.split('/');
                if (parts.length !== 3) return false;
                const [d, m] = parts.map(Number);
                return d === todayDay && m === todayMonth;
            });
            const bHasAnniversary = b[1].some(g => {
                const parts = g.Date.split('/');
                if (parts.length !== 3) return false;
                const [d, m] = parts.map(Number);
                return d === todayDay && m === todayMonth;
            });
            if (aHasAnniversary && !bHasAnniversary) return -1;
            if (!aHasAnniversary && bHasAnniversary) return 1;
            return b[1].length - a[1].length; // Most shows wins
        });

    if (eligibleArtists.length > 0) {
        // Skip the artist already shown in On This Day to avoid repetition
        const onThisDayArtist = onThisDayGigs[0]?.Band;
        const [artist, shows] = eligibleArtists.find(([a]) => a !== onThisDayArtist) || eligibleArtists[0];

        const sorted = [...shows].sort((a, b) => {
            const da = parseDate(a.Date) || new Date(0);
            const db = parseDate(b.Date) || new Date(0);
            return da - db;
        });
        const first = sorted[0];
        const last  = sorted[sorted.length - 1];
        const [,,firstYear] = first.Date.split('/').map(Number);
        const [,,lastYear]  = last.Date.split('/').map(Number);
        const yearSpan = lastYear - firstYear;

        cards.push({
            type:     'artist_story',
            score:    eligibleArtists[0][0] !== onThisDayArtist ? 70 : 60,
            gig:      last, // Use most recent show for hero image
            allGigs:  sorted,
            headline: artist,
            subline:  yearSpan > 0
                ? `${shows.length} shows across ${yearSpan} year${yearSpan !== 1 ? 's' : ''}`
                : `${shows.length} shows`,
            eyebrow:  'Your History',
            badge:    `${shows.length} Shows`,
            badgeColor: 'bg-indigo-500',
            journalKey: last['Journal Key'],
        });
    }

    // ── SEASON FLASHBACK ─────────────────────────────────────────────────────
    // Shows from this calendar month in previous years (excluding today's date,
    // which is already covered by On This Day).
    const seasonGigs = pastGigs.filter(g => {
        const parts = g.Date.split('/');
        if (parts.length !== 3) return false;
        const [d, m, y] = parts.map(Number);
        return m === thisMonth && y < thisYear && !(d === todayDay && m === todayMonth);
    }).sort((a, b) => {
        const da = parseDate(a.Date) || new Date(0);
        const db = parseDate(b.Date) || new Date(0);
        return db - da; // Most recent first
    });

    if (seasonGigs.length >= 2) {
        const monthName = today.toLocaleString('default', { month: 'long' });
        // Seed-based shuffle so it's consistent within a day but changes daily
        const seed = todayDay * thisMonth;
        const shuffled = [...seasonGigs].sort((a, b) =>
            ((parseDate(a.Date)?.getFullYear() * seed) % 7) - ((parseDate(b.Date)?.getFullYear() * seed) % 7)
        );
        const featured = shuffled[0];

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

    // Sort by score descending, cap at CARD_LIMIT
    return cards.sort((a, b) => b.score - a.score).slice(0, CARD_LIMIT);
}

// ─── IMAGE RESOLUTION ────────────────────────────────────────────────────────

/**
 * Resolves the hero image for a feed card using the same waterfall as
 * the gig modal: Supabase Storage → local scrapbook → local artist → default.
 */
async function resolveHeroImage(gig, imgEl, cardIndex) {
    if (!gig?.Date || !gig?.OfficialVenue) {
        imgEl.src = DEFAULT_IMAGES[cardIndex % DEFAULT_IMAGES.length];
        return;
    }

    const [d, m, y]  = gig.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue    = gig.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const fileName      = `${formattedDate}-${cleanVenue}.jpg`;

    const scrapbookPath = `assets/scrapbook/${fileName}`;
    const artistPath    = `assets/artists/${(gig.Band || '').toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;
    const fallback      = DEFAULT_IMAGES[cardIndex % DEFAULT_IMAGES.length];

    const tryLocal = () => {
        const probe = new Image();
        probe.onload = () => { imgEl.src = scrapbookPath; };
        probe.onerror = () => {
            const artistProbe = new Image();
            artistProbe.onload = () => { imgEl.src = artistPath; };
            artistProbe.onerror = () => { imgEl.src = fallback; };
            artistProbe.src = artistPath;
        };
        probe.src = scrapbookPath;
    };

    // Try Supabase Storage first
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
        } catch (e) {
            // Fall through to local
        }
    }

    tryLocal();
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

/**
 * Renders the expanded detail panel inside an Artist Story card.
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
                const [,,y] = g.Date.split('/').map(Number);
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

/**
 * Renders the expanded detail panel for a Season Flashback card.
 * Shows a list of all shows from this month in past years.
 */
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
                const [,,y] = g.Date.split('/').map(Number);
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

function renderCard(card, index) {
    const safeKey = (card.journalKey || `card-${index}`).replace(/[^a-z0-9]/gi, '_');
    const hasDetail = card.type === 'artist_story' || card.type === 'season_flashback';

    const detailToggle = hasDetail
        ? `window._feedToggleDetail('${safeKey}', '${card.type}')`
        : `window.viewGigDetails('${(card.journalKey || '').replace(/'/g, "\\'")}')`;

    const detailLabel = card.type === 'artist_story'
        ? 'See all shows'
        : card.type === 'season_flashback'
        ? `See all ${card.allGigs?.length} shows`
        : '';

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
                    ${hasDetail ? `
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

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Called when the Feed tab is activated.
 * Checks sessionStorage cache first — only recomputes if the date has changed
 * or data has been updated.
 */
export function init(journalData, performanceData) {
    const container = document.getElementById('feed-cards-container');
    if (!container) return;

    // Check cache — keyed by date + journal size
    const cacheKey      = `giglist_feed_${new Date().toDateString()}_${journalData.length}`;
    const cachedHtml    = sessionStorage.getItem(cacheKey);
    const cachedCardsJson = sessionStorage.getItem(`${cacheKey}_cards`);

    if (cachedHtml && cachedCardsJson) {
        container.innerHTML = cachedHtml;
        if (window.lucide) lucide.createIcons();
        // Re-run the full image waterfall using the cached card metadata
        const cachedCards = JSON.parse(cachedCardsJson);
        cachedCards.forEach((card, i) => {
            const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
            const imgEl   = document.getElementById(`feed-img-${safeKey}`);
            if (imgEl) resolveHeroImage(card.gig, imgEl, i);
        });
        return;
    }

    const cards = buildCards(journalData, performanceData);

    if (cards.length === 0) {
        renderEmptyState(container);
        return;
    }

    const html = cards.map((card, i) => renderCard(card, i)).join('');
    container.innerHTML = html;

    // Cache HTML skeleton + card metadata (gig details needed to re-resolve images)
    sessionStorage.setItem(cacheKey, html);
    sessionStorage.setItem(`${cacheKey}_cards`, JSON.stringify(
        cards.map(c => ({ journalKey: c.journalKey, gig: c.gig }))
    ));

    // Resolve images async
    cards.forEach((card, i) => {
        const safeKey = (card.journalKey || `card-${i}`).replace(/[^a-z0-9]/gi, '_');
        const imgEl   = document.getElementById(`feed-img-${safeKey}`);
        if (imgEl) resolveHeroImage(card.gig, imgEl, i);
    });

    if (window.lucide) lucide.createIcons();
}

// ─── WINDOW HELPERS ──────────────────────────────────────────────────────────

window._feedToggleDetail = (safeKey, cardType) => {
    if (cardType === 'artist_story') {
        // Find the card data from the rendered DOM and toggle
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden = detailEl.classList.contains('hidden');

        // We need the card data — re-derive from the DOM headline
        const cardEl   = detailEl.closest('[role="article"]');
        const headline = cardEl?.querySelector('h3')?.textContent?.trim();

        if (isHidden && headline) {
            // Rebuild from window.journalData
            const shows = (window.journalData || [])
                .filter(g => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const d = parseDate(g.Date);
                    return g.Band === headline && d && d < today;
                })
                .sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));

            // Reuse renderArtistTimeline logic inline
            detailEl.innerHTML = `
                <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                    ${shows.map((g, i) => {
                        const [,,y] = g.Date.split('/').map(Number);
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

        detailEl.classList.toggle('hidden');
        if (chevronEl) {
            chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
        }

    } else if (cardType === 'season_flashback') {
        const detailEl  = document.getElementById(`feed-detail-${safeKey}`);
        const chevronEl = document.getElementById(`feed-chevron-${safeKey}`);
        if (!detailEl) return;

        const isHidden = detailEl.classList.contains('hidden');

        if (isHidden) {
            const today    = new Date();
            today.setHours(0, 0, 0, 0);
            const thisMonth  = today.getMonth() + 1;
            const thisYear   = today.getFullYear();
            const todayDay   = today.getDate();

            const seasonGigs = (window.journalData || []).filter(g => {
                const parts = g.Date.split('/');
                if (parts.length !== 3) return false;
                const [d, m, y] = parts.map(Number);
                const gd = parseDate(g.Date);
                return m === thisMonth && y < thisYear && gd && gd < today
                    && !(d === todayDay && m === thisMonth);
            }).sort((a, b) => (parseDate(b.Date) || 0) - (parseDate(a.Date) || 0));

            detailEl.innerHTML = `
                <div class="mt-4 pt-4 border-t border-white/20 space-y-2">
                    ${seasonGigs.slice(0, 8).map(g => {
                        const [,,y] = g.Date.split('/').map(Number);
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
                    ${seasonGigs.length > 8 ? `<p class="text-[10px] text-white/40 text-center pt-1">+${seasonGigs.length - 8} more</p>` : ''}
                </div>`;
            if (window.lucide) lucide.createIcons();
        }

        detailEl.classList.toggle('hidden');
        if (chevronEl) {
            chevronEl.style.transform = isHidden ? 'rotate(180deg)' : '';
        }
    }
};
/**
 * GigList - UI Module
 * Handles Modals, Tickets, Tables, and Accessibility
 */
/**
 * GigList - UI Module
 */
import { getGlobalSeenCount, slugify, slugifyArtist, parseDate, isFestivalRow, scopeFestivalPerformances } from './utils.js';
import { searchArtists, getArchiveStatus, submitArchiveRequest } from './artist-sync.js';
import { renderCalendar } from './calendar.js';
import { sortGigs, deriveType } from './data.js';
import { getUniqueSongCount } from './data.js';
import { initModalTips, teardownModalTips } from './modal-tips.js';
import { renderEmptyStateTips } from './tip-nudges.js';

let gigMap = null;
let markerLayer = null;
let fullMapInstance = null;
let fullMarkerLayer = null;
import * as Data from './data.js';

const defaultImages = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800"
];

// Add a timeout to any image load to prevent the 10s hang seen in production
const safelyLoadImage = (imgElement, path, fallbackFn) => {
    const timer = setTimeout(() => {
        console.warn("Image request timed out:", path);
        imgElement.src = ''; // Cancel request
        fallbackFn();
    }, 2500); // 2.5 second hard limit

    imgElement.onload = () => {
        clearTimeout(timer);
        imgElement.classList.remove('hidden');
    };
    imgElement.onerror = () => {
        clearTimeout(timer);
        fallbackFn();
    };
    imgElement.src = path;
};

// ─── STAT COUNT-UP ANIMATION ──────────────────────────────────────────────────
// Animates a numeric element from its current displayed value to `target`.
// Uses requestAnimationFrame with a Power2-out easing curve (~1.6s duration).
// Skips animation if the user prefers reduced motion, or if the delta is tiny
// (avoids flickering on filter-driven refreshes where the number barely changes).
//
// Usage: animateStatTo(element, 142)
// ─────────────────────────────────────────────────────────────────────────────

const _statAnimations = new Map(); // el -> rafId, so concurrent calls cancel cleanly

export const animateStatTo = (el, target) => {
    if (!el) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const current = parseInt(el.innerText?.replace(/,/g, ''), 10) || 0;
    const delta = Math.abs(target - current);

    // Skip animation for tiny deltas or accessibility preference
    if (prefersReduced || delta < 2) {
        el.innerText = target.toLocaleString();
        return;
    }

    // Cancel any in-flight animation on this element
    if (_statAnimations.has(el)) {
        cancelAnimationFrame(_statAnimations.get(el));
    }

    const DURATION = delta > 50 ? 1600 : 800; // shorter for small numbers
    const start = performance.now();
    const startVal = current;

    const tick = (now) => {
        const elapsed  = now - start;
        const progress = Math.min(elapsed / DURATION, 1);
        // Power2-out easing: decelerates into the final value
        const eased    = 1 - Math.pow(1 - progress, 2);
        const value    = Math.round(startVal + (target - startVal) * eased);

        el.innerText = value.toLocaleString();

        if (progress < 1) {
            _statAnimations.set(el, requestAnimationFrame(tick));
        } else {
            el.innerText = target.toLocaleString(); // lock to exact value
            _statAnimations.delete(el);
        }
    };

    _statAnimations.set(el, requestAnimationFrame(tick));
};

/* --- DASHBOARD & TICKER --- */

export const updateCurrentDate = () => {
    const dateEl = document.getElementById('header-date-display');
    if (!dateEl) return;
    const now = new Date();
    dateEl.innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

export const updateStats = (data) => {
    const headerTitle  = document.getElementById('header-page-title');
    const artistLabel    = document.getElementById('stat-artist-label');
    const dcArtistLabel  = document.getElementById('dc-stat-artists-label');

    // Per-artist brand colours used in band mode header
    const bandColors = {
        'Weezer':          '#00ADEF',
        'Frank Turner':    '#1D3557',
        'New Found Glory': '#E63946'
    };

    // Update the merged header title to reflect current mode
    if (headerTitle && !window.isBandMode) {
        // Individual mode: always show "For You" (band mode title is set once at init)
        headerTitle.textContent = 'For You';
        headerTitle.style.color = '';
    }

    // In band mode, apply the per-band header colour on every stats refresh
    if (window.isBandMode) {
        const brandColor = bandColors[window.currentArtist] || '#189BCC';
        const topHeader = document.querySelector('header');
        if (topHeader) topHeader.style.backgroundColor = brandColor;
    }

    // Labels: "Artists" in individual mode, "Songs" in band mode
    const artistText = window.isBandMode ? 'Songs' : 'Artists';
    if (artistLabel)   artistLabel.textContent   = artistText;
    if (dcArtistLabel) dcArtistLabel.textContent = artistText;

    // 3. Calculate Core Stats
    const counts = {
        total: data.length,
        venues: new Set(data.map(g => g.OfficialVenue)).size,
        artists: 0
    };

    if (window.isBandMode) {
            // Explicitly pass the global performance data
            counts.artists = getUniqueSongCount(data, window.performanceData);
            console.log(`📊 Band Mode: Found ${counts.artists} unique songs.`);
        } else {
            counts.artists = new Set(data.map(g => g.Band)).size;
        }

    // 4. Batch Update DOM Elements
        ['stat-total', 'dc-stat-gigs'].forEach(id => {
            const el = document.getElementById(id);
            if (el) animateStatTo(el, counts.total);
        });

        ['stat-venues', 'dc-stat-venues'].forEach(id => {
            const el = document.getElementById(id);
            if (el) animateStatTo(el, counts.venues);
        });

        ['stat-artists', 'dc-stat-artists', 'stat-artist-count'].forEach(id => {
            const el = document.getElementById(id);
            if (el) animateStatTo(el, counts.artists);
        });
};

export const updateRank = (data) => {
    const rankEl  = document.getElementById('stat-rank');
    const labelEl = document.getElementById('stat-fourth-label');

    if (window.isBandMode) {
            if (labelEl) labelEl.textContent = 'Fans';
            if (rankEl) rankEl.textContent = '--';   // band.js sets this async — leave as-is
        } else {
            if (labelEl) labelEl.textContent = 'Items';
            const itemCount = (window._collectionItems || []).length;
            if (rankEl) {
                if (itemCount > 0) animateStatTo(rankEl, itemCount);
                else rankEl.textContent = '--';
            }
        }
};



export const renderOTDBanner = (data) => {
    const banner   = document.getElementById('otd-banner');
    const mainEl   = document.getElementById('otd-main');
    const subEl    = document.getElementById('otd-sub');
    const yearsEl  = document.getElementById('otd-years-num');
    if (!banner) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDay   = today.getDate();
    const todayMonth = today.getMonth() + 1;
    const thisYear   = today.getFullYear();

    // Find past gigs on exactly this calendar day in a previous year
    const matches = data.filter(g => {
        if (!g.Date) return false;
        const parts = g.Date.split('/');
        if (parts.length !== 3) return false;
        const [d, m, y] = parts.map(Number);
        return d === todayDay && m === todayMonth && y < thisYear;
    }).sort((a, b) => {
        // Show the most recent anniversary (largest year) first
        const [,,ya] = a.Date.split('/').map(Number);
        const [,,yb] = b.Date.split('/').map(Number);
        return yb - ya;
    });

    if (matches.length === 0) {
        banner.classList.add('hidden');
        return;
    }

    const gig      = matches[0];
    const [,,gigYear] = gig.Date.split('/').map(Number);
    const yearsAgo = thisYear - gigYear;
    const artistName = gig.Band || gig.band || 'Unknown Artist';

    if (mainEl) mainEl.textContent = `${artistName} · ${gig.OfficialVenue}`;
    if (subEl)  subEl.textContent  = `${gig.Date} — ${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago today`;
    if (yearsEl) yearsEl.textContent = yearsAgo;

    const gigKey = gig['Journal Key']?.toString().trim();
    if (gigKey) {
        banner.classList.add('cursor-pointer');
        banner.onclick = () => window.viewGigDetails(gigKey);
    }

    banner.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
};

export const updateTicker = (data) => {
    const eyebrowEl = document.getElementById('countdown-eyebrow');
    const mainEl    = document.getElementById('countdown-main');
    const subEl     = document.getElementById('countdown-sub');
    const numEl     = document.getElementById('countdown-num');
    const unitEl    = document.getElementById('countdown-unit');
    const card      = document.getElementById('countdown-card');
    if (!card) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcomingGigs = data.filter(g => parseDate(g.Date) >= today)
        .sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
    const pastGigs = data.filter(g => parseDate(g.Date) < today)
        .sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    const nextGig = upcomingGigs[0];
    const lastGig = pastGigs[0];

    if (nextGig) {
        const days = Math.ceil((parseDate(nextGig.Date) - today) / (1000 * 60 * 60 * 24));
        const mainText = window.isBandMode ? nextGig.OfficialVenue : nextGig.Band;
        const subText  = window.isBandMode
            ? nextGig.Date
            : `${nextGig.OfficialVenue} · ${nextGig.Date}`;

        if (days === 0) {
            // ── SHOW DAY ─────────────────────────────────────────────────────
            card.className = 'relative overflow-hidden bg-gradient-to-br from-amber-400 via-orange-400 to-pink-500 rounded-[1.5rem] p-4 flex items-center justify-between cursor-pointer';
            if (eyebrowEl) { eyebrowEl.textContent = 'Tonight 🎉'; eyebrowEl.className = 'text-[9px] font-black text-amber-900/70 uppercase tracking-widest mb-1'; }
            if (mainEl)    { mainEl.textContent = mainText;  mainEl.className = 'text-lg font-black text-white leading-tight drop-shadow'; }
            if (subEl)     { subEl.textContent = subText;    subEl.className = 'text-[10px] font-bold text-amber-900/60 mt-0.5'; }
            if (numEl)     { numEl.textContent = '🎊';       numEl.className = 'text-4xl leading-none'; }
            if (unitEl)    { unitEl.textContent = 'show day'; unitEl.className = 'text-[9px] font-black text-amber-900/70 uppercase tracking-widest'; }
            const showDayKey = nextGig['Journal Key']?.toString().trim();
            if (showDayKey) card.onclick = () => window.viewGigDetails(showDayKey);

            // Fire confetti once — check flag so it only runs once per session
            if (!window._confettiFired) {
                window._confettiFired = true;
                setTimeout(() => fireConfetti(), 400);
            }
        } else {
            // ── UPCOMING ─────────────────────────────────────────────────────
            card.className = 'bg-indigo-600 rounded-[1.5rem] p-4 flex items-center justify-between';
            if (eyebrowEl) { eyebrowEl.textContent = 'Next show'; eyebrowEl.className = 'text-[9px] font-black text-indigo-300 uppercase tracking-widest mb-1'; }
            if (mainEl)    { mainEl.textContent = mainText; mainEl.className = 'text-lg font-black text-white leading-tight'; }
            if (subEl)     { subEl.textContent = subText;   subEl.className = 'text-[10px] font-bold text-indigo-300 mt-0.5'; }
            if (numEl)     { numEl.textContent = days;      numEl.className = 'text-4xl font-black text-white leading-none tracking-tighter'; }
            if (unitEl)    { unitEl.textContent = days === 1 ? 'day' : 'days'; unitEl.className = 'text-[9px] font-black text-indigo-300 uppercase tracking-widest'; }
        }

    } else if (lastGig) {
        const days = Math.floor((today - parseDate(lastGig.Date)) / (1000 * 60 * 60 * 24));
        const mainText = window.isBandMode ? lastGig.OfficialVenue : lastGig.Band;
        const subText  = window.isBandMode
            ? lastGig.Date
            : `${lastGig.OfficialVenue} · ${lastGig.Date}`;

        card.className = 'bg-slate-700 rounded-[1.5rem] p-4 flex items-center justify-between cursor-pointer';
        if (eyebrowEl) { eyebrowEl.textContent = 'Last show'; eyebrowEl.className = 'text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1'; }
        if (mainEl)    { mainEl.textContent = mainText; mainEl.className = 'text-lg font-black text-white leading-tight'; }
        if (subEl)     { subEl.textContent = subText;   subEl.className = 'text-[10px] font-bold text-slate-400 mt-0.5'; }
        if (numEl)     { numEl.textContent = days;      numEl.className = 'text-4xl font-black text-white leading-none tracking-tighter'; }
        if (unitEl)    { unitEl.textContent = days === 1 ? 'day ago' : 'days ago'; unitEl.className = 'text-[9px] font-black text-slate-400 uppercase tracking-widest'; }
        const lastGigKey = lastGig['Journal Key']?.toString().trim();
        if (lastGigKey) card.onclick = () => window.viewGigDetails(lastGigKey);
    }
};

/* --- CONFETTI ----------------------------------------------------------------
   Lightweight canvas confetti — no library, ~60 lines.
   Fires from the top of the screen, gravity + drift, fades out after 3s.
----------------------------------------------------------------------------- */

const fireConfetti = () => {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    const COLOURS = ['#f59e0b','#ef4444','#8b5cf6','#3b82f6','#10b981','#f97316','#ec4899','#facc15'];
    const SHAPES  = ['rect', 'circle', 'ribbon'];
    const COUNT   = 120;

    const pieces = Array.from({ length: COUNT }, () => ({
        x:       Math.random() * canvas.width,
        y:       -20 - Math.random() * 100,
        w:       6 + Math.random() * 8,
        h:       10 + Math.random() * 6,
        colour:  COLOURS[Math.floor(Math.random() * COLOURS.length)],
        shape:   SHAPES[Math.floor(Math.random() * SHAPES.length)],
        vx:      (Math.random() - 0.5) * 4,
        vy:      3 + Math.random() * 4,
        angle:   Math.random() * Math.PI * 2,
        spin:    (Math.random() - 0.5) * 0.3,
        opacity: 1,
    }));

    let start = null;
    const DURATION = 3000;

    const draw = (timestamp) => {
        if (!start) start = timestamp;
        const elapsed = timestamp - start;
        const progress = elapsed / DURATION;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        pieces.forEach(p => {
            p.x     += p.vx;
            p.y     += p.vy;
            p.angle += p.spin;
            p.vy    += 0.12; // gravity
            p.vx    *= 0.99; // drag
            p.opacity = Math.max(0, 1 - Math.pow(progress, 2));

            ctx.save();
            ctx.globalAlpha = p.opacity;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillStyle = p.colour;

            if (p.shape === 'circle') {
                ctx.beginPath();
                ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.shape === 'ribbon') {
                ctx.fillRect(-p.w / 2, -p.h / 4, p.w, p.h / 2);
            } else {
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            }

            ctx.restore();
        });

        if (elapsed < DURATION) {
            requestAnimationFrame(draw);
        } else {
            canvas.remove();
        }
    };

    requestAnimationFrame(draw);
};

/* --- CAROUSEL WITH 3-TIER IMAGE LOGIC --- */

export const renderCarousel = (data) => {
    if (window.loadThrowback) window.loadThrowback(data);
};

export const renderCarouselItem = (index, carouselData, fullData) => {
    const card = document.getElementById('now-card');
    if (!card || !carouselData || !carouselData[index]) return;

    const item = carouselData[index];
    const fallback = defaultImages[index % defaultImages.length];

    const [d, m, y] = item.Date ? item.Date.split('/') : ['01','01','1970'];
    const scrapbookPath = `assets/scrapbook/${y}-${m}-${d}-${slugify(item.OfficialVenue || '')}.jpg`;
    const artistPath    = `assets/artists/${slugifyArtist(item.Band || item.band || '')}_stock_photo.jpg`;

    const accentClass = item.isFuture ? 'bg-emerald-600' : 'bg-indigo-600';
    const hoverClass  = item.isFuture ? 'group-hover:text-emerald-400' : 'group-hover:text-indigo-400';

    let subtext = item.details;
    let showNumberPill = '';
    if (item.isFuture) {
        const isFest = item['Festival?']?.trim().toUpperCase().startsWith('Y');
        const verb = isFest ? 'Been' : 'Seen';

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const pastCount = fullData.filter(g =>
            (g.Band || g.band || '').toLowerCase() === (item.band || '').toLowerCase()
            && parseDate(g.Date) < today
        ).length;

        const nextCount = pastCount + 1;

        if (pastCount === 0) {
            subtext = isFest ? `✨ First time going!` : `✨ First time seeing them!`;
        } else if (nextCount === 5 || nextCount === 10 || nextCount === 25 || nextCount === 50 || nextCount === 100) {
            subtext = `🏆 This will be ${isFest ? 'visit' : 'show'} #${nextCount} — Achievement incoming!`;
        } else {
            subtext = `🔥 ${verb} ${pastCount} time${pastCount !== 1 ? 's' : ''} before`;
        }

        if (nextCount > 1) {
            showNumberPill = `<span class="bg-emerald-400/90 text-emerald-950 font-black text-[9px] uppercase tracking-widest px-3 py-1 rounded-full">${isFest ? 'Visit' : 'Show'} #${nextCount}</span>`;
        }
    }

    card.innerHTML = `
        <div class="relative h-full w-full overflow-hidden rounded-[2.5rem] bg-slate-900 shadow-2xl">
            <img id="carousel-img-${index}"
                 src="${item.isCTA ? "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&q=80" : ""}"
                 class="absolute inset-0 w-full h-full object-cover opacity-60 transition-opacity duration-500"
                 alt="">

            <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent"></div>

            <div class="absolute inset-0 z-20 flex">
                <div onclick="window.rotateCarousel(-1)" class="h-full w-1/2 cursor-w-resize" role="button" aria-label="Previous"></div>
                <div onclick="window.rotateCarousel(1)" class="h-full w-1/2 cursor-e-resize" role="button" aria-label="Next"></div>
            </div>

            <div class="absolute inset-0 z-30 p-8 flex flex-col justify-end pointer-events-none">
                <div class="pointer-events-auto">
                    <div onclick="${item.isCTA ? "window.switchView('data')" : (item.isFuture ? "" : "window.viewGigDetails('" + item['Journal Key']?.replace(/'/g, "\\'") + "')")}"
                         class="cursor-pointer group">

                        <span class="${accentClass} text-white text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-3 inline-block">
                            ${item.badge || (item.isFuture ? 'Upcoming Show' : 'Gig Memory')}
                        </span>

                        <h3 class="text-4xl font-black text-white italic tracking-tighter leading-none mb-1 transition-colors ${hoverClass}">
                            ${item.band}
                        </h3>
                        <p class="text-slate-300 font-bold text-sm">${item.details}</p>
                        ${item.isFuture ? `
                        <div class="flex items-center gap-2 mt-2 flex-wrap">
                            <span class="bg-white/15 border border-white/25 text-white font-black text-[9px] uppercase tracking-widest px-3 py-1 rounded-full">${subtext}</span>
                            ${showNumberPill}
                        </div>` : ''}
                    </div>

                    <div class="flex gap-1.5 mt-6">
                        ${carouselData.map((_, i) => `
                            <div class="h-1 rounded-full transition-all duration-300 ${i === index ? 'w-8 ' + (item.isFuture ? 'bg-emerald-500' : 'bg-indigo-500') : 'w-2 bg-white/20'}"></div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>`;

    // ── IMAGE RESOLUTION WATERFALL ────────────────────────────────────────────
        // Priority: 1. Supabase Storage (gig-photo / band-photo)
        //           2. Local assets/scrapbook/
        //           3. Spotify artist image
        //           4. Local assets/artists/ stock photo
        //           5. Fallback (default concert image)

    if (item.isCTA) return;

    const imgEl = document.getElementById(`carousel-img-${index}`);
    if (!imgEl) return;

    // Tries each src in order, resolving to the first that loads successfully.
    const tryInOrder = (sources) => {
        if (!sources.length) return;
        const [next, ...rest] = sources;
        if (!next) { tryInOrder(rest); return; }
        const probe = new Image();
        probe.onload  = () => { imgEl.src = next; };
        probe.onerror = () => { tryInOrder(rest); };
        probe.src = next;
    };

    import('./supabase.js').then(async ({ supabase }) => {
        let storageUrl = null;

        if (window.isBandMode) {
            const bandSlug     = (window.currentArtist || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
            const scrapbookFile = scrapbookPath.split('/').pop();
            const { data: listed } = await supabase.storage
                .from('band-photos')
                .list(bandSlug, { search: scrapbookFile });
            if (listed?.length) {
                const { data } = supabase.storage.from('band-photos').getPublicUrl(`${bandSlug}/${scrapbookFile}`);
                storageUrl = data.publicUrl;
            }
        } else {
            const userId = window.currentUser?.id;
            if (userId) {
                const scrapbookFile = scrapbookPath.split('/').pop();
                const { data: listed } = await supabase.storage
                    .from('gig-photos')
                    .list(userId, { search: scrapbookFile });
                if (listed?.length) {
                    const { data, error } = await supabase.storage
                        .from('gig-photos')
                        .createSignedUrl(`${userId}/${scrapbookFile}`, 3600);
                    if (!error && data?.signedUrl) storageUrl = data.signedUrl;
                }
            }
        }

        tryInOrder([
                    storageUrl,
                    scrapbookPath,
                    item.SpotifyImageUrl || null,
                    artistPath,
                    fallback,
                ]);
    });
};

/* --- TABLE & CALENDAR VIEWS --- */

export const renderTable = (data) => {
    const tableContainer = document.getElementById('tableContainer');
    if (!tableContainer) return;

    // Empty state
        if (!data.length) {
            tableContainer.innerHTML = `
                <div class="text-center py-16 space-y-3">
                    <div class="text-5xl">🎟️</div>
                    <p class="text-sm font-black text-slate-700">No shows yet</p>
                    <p class="text-[11px] text-slate-400 leading-relaxed max-w-xs mx-auto">Add your first show, or sync your setlist.fm account to import your full history.</p>
                </div>
                ${renderEmptyStateTips([
                    'share_show',
                    'companion_tag',
                    'setlistfm_link',
                ])}`;
            if (window.lucide) lucide.createIcons();
            return;
        }

    const getArrow = (col) => {
        if (!window.currentSort || window.currentSort.column !== col) {
            return '<span class="opacity-20 ml-1 text-[8px]">↕</span>';
        }
        return window.currentSort.ascending ?
            '<span class="ml-1 text-indigo-600">↑</span>' :
            '<span class="ml-1 text-indigo-600">↓</span>';
    };

    const typeColors = {
        'Headline': 'text-indigo-600 bg-indigo-50 border-indigo-100',
        'Festival': 'text-amber-600 bg-amber-50 border-amber-100',
        'Support': 'text-slate-600 bg-slate-50 border-slate-100',
        'TV': 'text-emerald-600 bg-emerald-50 border-emerald-100'
    };

    tableContainer.innerHTML = `
        <div class="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden font-sans">
            <table class="w-full text-left table-fixed">
                <thead>
                    <tr class="bg-slate-50/50">
                        <th onclick="window.handleSort('Date')" class="w-24 p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                            Date ${getArrow('Date')}
                        </th>
                        <th onclick="window.handleSort('Band')" class="w-40 p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                            ${window.isBandMode ? 'Type' : 'Artist'} ${getArrow('Band')}
                        </th>
                        <th onclick="window.handleSort('OfficialVenue')" class="p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                            Venue ${getArrow('OfficialVenue')}
                        </th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-50">
                    ${data.map(gig => {
                        const photoLink = gig.Photos || "";
                        const hasPhotoURL = photoLink.trim() !== "" && photoLink !== "nan";
                        const cameraIcon = hasPhotoURL ? `
                            <a href="${photoLink}" target="_blank" onclick="event.stopPropagation()"
                               class="flex-shrink-0 text-indigo-300 hover:text-indigo-500 transition-colors ml-auto" title="View photo album">
                                <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                            </a>` : '<span class="ml-auto w-3.5"></span>';

                        // --- MATCH LABELS LOGIC ---
                        let matchLabels = '';
                        if (gig._isSupportMatch) {
                            matchLabels = `
                                <span class="inline-flex items-center gap-1 text-[9px] bg-blue-500/10 text-blue-600 font-black uppercase px-2 py-0.5 rounded-full mt-1">
                                    <i data-lucide="mic-2" class="w-2.5 h-2.5"></i> Support Match
                                </span>`;
                        } else if (gig._isFestMatch) {
                            matchLabels = `
                                <span class="inline-flex items-center gap-1 text-[9px] bg-amber-500/10 text-amber-600 font-black uppercase px-2 py-0.5 rounded-full mt-1">
                                    <i data-lucide="users" class="w-2.5 h-2.5"></i> Lineup Match
                                </span>`;
                        } else if (gig._isSongMatch) {
                            matchLabels = `
                                <span class="inline-flex items-center gap-1 text-[9px] bg-emerald-500/10 text-emerald-600 font-black uppercase px-2 py-0.5 rounded-full mt-1">
                                    <i data-lucide="music" class="w-2.5 h-2.5"></i> Setlist Match
                                </span>`;
                        }

                        // --- BUDDY PILLS ---
                        // Show which accepted buddies also attended this show.
                        // Uses window._buddyJournalKeys (populated by initBuddies) and
                        // window._following for display names. Mirrors the stable colour
                        // hash from buddies.js so colours are consistent across the app.
                        let buddyPills = '';
                        if (!window.isBandMode) {
                            const buddyKeys   = window._buddyJournalKeys || {};
                            const buddyList   = window._following || [];
                            const _tileColours = [
                                { bg: 'bg-indigo-100',  text: 'text-indigo-700'  },
                                { bg: 'bg-violet-100',  text: 'text-violet-700'  },
                                { bg: 'bg-emerald-100', text: 'text-emerald-700' },
                                { bg: 'bg-amber-100',   text: 'text-amber-700'   },
                                { bg: 'bg-rose-100',    text: 'text-rose-700'    },
                                { bg: 'bg-sky-100',     text: 'text-sky-700'     },
                            ];
                            const gigKey = gig['Journal Key'];
                            const attending = buddyList.filter(b => buddyKeys[b.id]?.has(gigKey));
                            if (attending.length) {
                                buddyPills = '<div class="flex items-center gap-1 mt-1 flex-wrap">' +
                                    attending.map(b => {
                                        const hash    = (b.id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                                        const colour  = _tileColours[hash % _tileColours.length];
                                        const initials = (b.display_name || b.username || '?').slice(0, 2).toUpperCase();
                                        return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[8px] font-black ${colour.bg} ${colour.text}" title="${b.display_name || b.username}">${initials}</span>`;
                                    }).join('') +
                                '</div>';
                            }
                        }

                        const displayValue = window.isBandMode ? deriveType(gig) : gig.Band;
                        const badgeClass = typeColors[displayValue] || 'text-slate-600 bg-slate-50 border-slate-100';

                        const mainContent = window.isBandMode
                            ? `<span class="px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-tighter ${badgeClass}">${displayValue}</span>`
                            : `<span class="text-sm font-bold text-slate-900">${displayValue}</span>`;

                        return `
                        <tr onclick="window.viewGigDetails('${gig.safeKey}')" class="group hover:bg-indigo-50/30 transition-all cursor-pointer">
                            <td class="p-4 text-xs font-medium text-slate-500 font-mono tracking-tighter">${gig.Date}</td>
                            <td class="p-4 leading-tight">
                                <div class="flex flex-col gap-1">
                                    <div class="flex items-center gap-2 w-full">
                                        <div class="flex-1 min-w-0">${mainContent}</div>
                                        ${cameraIcon}
                                    </div>
                                    ${matchLabels}
                                    ${buddyPills}
                                </div>
                            </td>
                            <td class="p-4 text-xs text-slate-600 font-medium">
                                <div class="flex flex-col">
                                    <span>${gig.OfficialVenue}</span>
                                    <span class="text-[10px] text-slate-400 font-normal uppercase">${gig.City || ''}</span>
                                </div>
                            </td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
};

export const openChartModal = (title, renderCallback) => {
    const modal = document.getElementById('chartModal');
    const content = document.getElementById('modal-content');
    if (!modal || !content) return;

    // Set title and prepare canvas
    content.innerHTML = `
        <div class="p-8">
            <h2 id="modal-title" class="text-3xl font-black text-slate-800 uppercase italic mb-6">${title}</h2>
            <div class="h-[60vh] w-full relative">
                <canvas id="modalChartCanvas"></canvas>
            </div>
        </div>
    `;

    modal.classList.remove('hidden');

    setTimeout(() => {
        const canvas = document.getElementById('modalChartCanvas');

        if (canvas && canvas.offsetWidth > 0) {
            renderCallback('modalChartCanvas');
        } else {
            // If layout still hasn't resolved, wait one more frame
            requestAnimationFrame(() => {
                renderCallback('modalChartCanvas');
            });
        }

    }, 80);
};

/**
 * 3-Way Toggle: List | Calendar | Map
 */
export const toggleListView = (view) => {
    window.activeView = view;

    const dataToRender = window.filteredResults || window.journalData;
    const sortedData = Data.sortGigs(dataToRender, window.currentSort.column, window.currentSort.ascending);

    const containers = {
        'list': document.getElementById('tableContainer'),
        'map': document.getElementById('mapContainer'),
        'calendar': document.getElementById('calendarContainer')
    };

    // Toggle visibility
    Object.keys(containers).forEach(key => {
        if (containers[key]) {
            containers[key].classList.toggle('hidden', key !== view);
        }
    });

    if (view === 'calendar') {
        // We know the container exists now
        renderCalendar(sortedData);
    } else if (view === 'map') {
        if (window.renderMap) window.renderMap(sortedData);
    } else {
        renderTable(sortedData);
        updateStats(dataToRender);
    }

    // 4. Update Button Highlighting (Tailwind Classes)
    const btnIds = ['btn-list', 'btn-calendar', 'btn-map'];
    btnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const isActive = (id === `btn-${view}`);

        if (isActive) {
            btn.classList.add('bg-white', 'shadow-sm', 'text-indigo-600');
            btn.classList.remove('text-slate-400');
            btn.setAttribute('aria-selected', 'true');
        } else {
            btn.classList.remove('bg-white', 'shadow-sm', 'text-indigo-600');
            btn.classList.add('text-slate-400');
            btn.setAttribute('aria-selected', 'false');
        }
    });

    // Refresh Lucide icons if any were rendered in the new view
    if (window.lucide) window.lucide.createIcons();
};

/**
 * Leaflet Map Engine
 */

const getHomeBase = (venueStats, venuesLookup) => {
    let topVenue = null;
    let topVenueName = "None";
    let maxVisits = 0;

    Object.keys(venueStats).forEach(vName => {
        const visits = venueStats[vName].length;
        const coords = venuesLookup[vName];
        if (visits > maxVisits && coords && !isNaN(coords.lat)) {
            maxVisits = visits;
            topVenue = coords;
            topVenueName = vName;
        }
    });

    return topVenue ? [topVenue.lat, topVenue.lng] : [51.507, -0.127];
};

async function ensureLeaflet() {
    if (window.L) return; // already loaded

    await new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet/dist/leaflet.css';
        document.head.appendChild(link);

        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

export const renderMap = async (data) => {
    await ensureLeaflet();

    const mapCanvas = document.getElementById('map-canvas');
    if (!mapCanvas) return;

    if (!gigMap) {
        gigMap = L.map('map-canvas', {
            zoomControl: false,
            minZoom: 1,
            worldCopyJump: true
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            subdomains: 'abc'
        }).addTo(gigMap);
        markerLayer = L.layerGroup().addTo(gigMap);
    }

    markerLayer.clearLayers();
    const bounds = [];
    const venuesLookup = window.venueLookup || {};
    const venueStats = {};

    // 1. Aggregate Gigs
    data.forEach(gig => {
        const vName = gig.OfficialVenue;
        if (!venueStats[vName]) venueStats[vName] = [];
        venueStats[vName].push(gig);
    });

    // 2. Re-build Markers with Popups
    Object.keys(venueStats).forEach(vName => {
        const gigsAtVenue = venueStats[vName];
        const venueData = venuesLookup[vName];

        if (venueData && !isNaN(venueData.lat)) {
            const visitCount = gigsAtVenue.length;
            const radius = Math.min(6 + (visitCount * 2), 20);

            const marker = L.circleMarker([venueData.lat, venueData.lng], {
                radius: radius,
                fillColor: "#4f46e5",
                color: "#fff",
                weight: 2,
                fillOpacity: 0.9
            });

            // 3. GENERATE THE POPUP HTML (Restoring the click functionality)
            const gigListHTML = gigsAtVenue.map(g => {
                // Escape single quotes in Journal Key for the JS function call
                const safeKey = g['Journal Key']?.replace(/'/g, "\\'");
                return `
                    <div onclick="window.viewGigDetails('${safeKey}')"
                         class="cursor-pointer hover:bg-slate-50 p-2 rounded transition-colors border-b border-slate-100 last:border-0 mb-1">
                        <p class="text-[10px] font-black text-indigo-500 uppercase leading-none">${g.Date}</p>
                        <p class="text-[12px] font-bold text-slate-800 leading-tight">${g.Band}</p>
                    </div>
                `;
            }).join('');

            marker.bindPopup(`
                <div class="p-1 max-h-48 overflow-y-auto custom-scrollbar min-w-[180px]">
                    <h4 class="text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">${vName}</h4>
                    ${gigListHTML}
                    <div class="pt-2 text-center">
                        <span class="bg-indigo-50 text-indigo-600 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                            ${visitCount} ${visitCount > 1 ? 'Shows' : 'Show'}
                        </span>
                    </div>
                </div>
            `, { maxWidth: 250, className: 'gig-map-popup' });

            marker.addTo(markerLayer);
            bounds.push([venueData.lat, venueData.lng]);
        }
    });

    // 4. Centering Logic (Keeping our Debugged Version)
    const homeBase = getHomeBase(venueStats, venuesLookup);
    const isFiltered = data.length < (window.journalData?.length || 0);

    if (isFiltered && bounds.length > 0) {
        gigMap.fitBounds(bounds, { padding: [40, 40] });
    } else {
        gigMap.setView(homeBase, 7);
    }

    setTimeout(() => gigMap.invalidateSize(), 100);
};

/* --- EXPANDED MAP MODAL LOGIC WITH DIAGNOSTICS --- */

window.openMapModal = () => {
    console.log("🚀 EXPLORER: Launching...");
    const modal = document.getElementById('mapModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // 1. Initialize Map inside ui.js scope
    if (!fullMapInstance) {
        console.log("🏗️ Creating Full Map Instance...");
        fullMapInstance = L.map('full-map-canvas', {
            zoomControl: false,
            worldCopyJump: true
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            subdomains: 'abc'
        }).addTo(fullMapInstance);
        fullMarkerLayer = L.layerGroup().addTo(fullMapInstance);
    }

    // 2. Fetch data from the global window objects
    const data = window.filteredResults || window.journalData || [];
    const venuesLookup = window.venueLookup || {};

    // 3. Render — mirrors renderMap's aggregation: group by venue first so
    // each venue gets one pin (sized by visit count) with a popup listing
    // every show there, rather than one overlapping same-size pin per gig.
    setTimeout(() => {
        fullMapInstance.invalidateSize();
        fullMarkerLayer.clearLayers();

        const bounds = [];
        const venueStats = {};

        data.forEach(gig => {
            const vName = gig.OfficialVenue;
            if (!venueStats[vName]) venueStats[vName] = [];
            venueStats[vName].push(gig);
        });

        Object.keys(venueStats).forEach(vName => {
            const gigsAtVenue = venueStats[vName];
            const venueInfo   = venuesLookup[vName];

            if (venueInfo && !isNaN(venueInfo.lat)) {
                const visitCount = gigsAtVenue.length;
                const radius = Math.min(6 + (visitCount * 2), 20);

                const gigListHTML = gigsAtVenue.map(g => {
                    const safeKey = g['Journal Key']?.replace(/'/g, "\\'");
                    return `
                        <div onclick="window.viewGigDetails('${safeKey}')"
                             class="cursor-pointer hover:bg-slate-50 p-2 rounded transition-colors border-b border-slate-100 last:border-0 mb-1">
                            <p class="text-[10px] font-black text-indigo-500 uppercase leading-none">${g.Date}</p>
                            <p class="text-[12px] font-bold text-slate-800 leading-tight">${g.Band}</p>
                        </div>
                    `;
                }).join('');

                const m = L.circleMarker([venueInfo.lat, venueInfo.lng], {
                    radius: radius,
                    fillColor: "#4f46e5",
                    color: "#fff",
                    weight: 2,
                    fillOpacity: 0.9
                }).bindPopup(`
                    <div class="p-1 max-h-48 overflow-y-auto custom-scrollbar min-w-[180px]">
                        <h4 class="text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">${vName}</h4>
                        ${gigListHTML}
                        <div class="pt-2 text-center">
                            <span class="bg-indigo-50 text-indigo-600 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                                ${visitCount} ${visitCount > 1 ? 'Shows' : 'Show'}
                            </span>
                        </div>
                    </div>
                `, { maxWidth: 250, className: 'gig-map-popup' });

                m.addTo(fullMarkerLayer);
                bounds.push([venueInfo.lat, venueInfo.lng]);
            }
        });

        console.log(`✅ EXPLORER: Rendered ${bounds.length} pins.`);

        if (bounds.length > 0) {
            fullMapInstance.fitBounds(bounds, { padding: [80, 80] });
        } else {
            fullMapInstance.setView([20, 0], 2);
        }
    }, 400);
};

window.closeMapModal = () => {
    const modal = document.getElementById('mapModal');
    if (modal) {
        if (modal.contains(document.activeElement)) document.activeElement.blur();
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'auto';
};

/**
 * Helper to generate a consistent but random-ish style for the mosh-pit ticket
 */
const getTicketStyle = (key) => {
    const styles = [
        { color: 'bg-amber-100', border: 'border-amber-200', accent: 'text-amber-600' },
        { color: 'bg-rose-100', border: 'border-rose-200', accent: 'text-rose-600' },
        { color: 'bg-emerald-100', border: 'border-emerald-200', accent: 'text-emerald-600' },
        { color: 'bg-blue-100', border: 'border-blue-200', accent: 'text-blue-600' },
        { color: 'bg-violet-100', border: 'border-violet-200', accent: 'text-violet-600' }
    ];
    // Use the Journal Key to pick a stable style so the ticket doesn't change color on refresh
    const index = Math.abs(key.split('').reduce((a, b) => a + b.charCodeAt(0), 0)) % styles.length;
    return styles[index];
};


/**
 * GIG MODAL & MOSH-PIT TICKETS
 */
export const openGigModal = (key, journalData, performanceData) => {
    // Fallback to window globals if the arguments weren't passed
    const jData = journalData || window.journalData;
    const pData = performanceData || window.performanceData;

    if (!jData) {
        console.error("Journal data not found!");
        return;
    }

    const entry = jData.find(j => j['Journal Key']?.toString().trim() === key?.toString().trim());
    if (!entry) {
        console.error("No entry found for key:", key);
        return;
    }
    // --- added as per gemini ---
    window.currentEditingGig = entry;

    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');

    // --- DATA PREP ---
    const isFestival = isFestivalRow(entry);

    // `pData` (performances) is a SHARED pool keyed only by journal_key — at a
    // festival, other users' journal entries under the same key can add their
    // own bands to this pool via their own Festival Lineups. scopeFestivalPerformances
    // narrows it down to just the acts this entry's own attendee logged as
    // seeing (see utils.js for the full rationale; same scoping is applied to
    // charts.js and data.js's list search for the same reason).
    const sets = scopeFestivalPerformances(entry, pData.filter(p =>
        (p['Journal Key'] || '').toString().trim() === key.toString().trim()
    ));
    const [d, m, y] = entry.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue = entry.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');


    // Generate the slug
    const scrapbookPath = `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`;
    const artistPath = `assets/artists/${entry.Band.toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;
    const youtubeLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${entry.Band} live ${entry.OfficialVenue} ${entry.Date}`)}`;
    const spotifyLink = entry.SpotifyArtistId
        ? `https://open.spotify.com/artist/${entry.SpotifyArtistId}`
        : `https://open.spotify.com/search/${encodeURIComponent(entry.Band)}`;

// --- SPOTIFY PLAYLIST ---
const headlineSet = sets.find(s => (s.Artist || '').toLowerCase() === entry.Band.toLowerCase());
const hasSetlistData = headlineSet?.Setlist &&
    headlineSet.Setlist !== 'NOT_FOUND' &&
    headlineSet.Setlist.trim().length > 0;
const isAdmin = window.currentUser?.is_admin === true;
const gigIsPast = (() => {
    const [dd, mm, yy] = entry.Date.split('/');
    return new Date(`${yy}-${mm}-${dd}`) <= new Date();
})();


    // --- EXTERNAL LINKS ---
    // Photos album URL (user-supplied)
    const photosUrl = (entry.Photos || '').trim();
    const hasPhotos = photosUrl && photosUrl !== 'nan';

    // Review URL — user-supplied, or auto-generated for Weezer via Weezerpedia
    let reviewUrl = (entry.review_url || entry['Review URL'] || '').trim();
    if (!reviewUrl && window.isBandMode && (window.currentArtist || '').toLowerCase() === 'weezer') {
        // Weezerpedia uses MM/DD/YYYY — our data is DD/MM/YYYY so swap day and month
        const [dd, mm, yyyy] = entry.Date.split('/');
        reviewUrl = `https://www.weezerpedia.com/w/index.php?title=Weezer_concert:_${mm}/${dd}/${yyyy}`;
    }
    const hasReview = !!reviewUrl;

    // Setlist.fm URL — from performances data
    const setlistUrl = sets.find(s => s.SetlistURL || s.setlist_url)?.SetlistURL ||
                       sets.find(s => s.setlist_url)?.setlist_url || '';
    const hasSetlist = !!setlistUrl;

    // --- ENHANCED TICKET LOGIC ---
    const style = getTicketStyle(key);
    const isLandscape = style.type === 'landscape';
    const supportActs = sets
        .filter(s => (s.Artist || '').toLowerCase() !== entry.Band.toLowerCase())
        .map(s => s.Artist)
        .filter(Boolean)
        .join(' + ');
    // PRICE LOGIC: Prioritize journal data, fallback to random if missing
        let displayPrice;
        if (entry.Price && entry.Price !== "nan" && entry.Price.toString().trim() !== "") {
            displayPrice = entry.Price.toString().startsWith('£') ? entry.Price : `£${entry.Price}`;
        } else {
            displayPrice = `£${(Math.random() * (15 - 8) + 8).toFixed(2)}`;
        }

    const ticketHTML = `
            <div class="mock-ticket transform -rotate-1 shadow-2xl ${isLandscape ? 'max-w-md w-full' : 'w-64'} ${style.color} ${style.border} border-2 p-6 transition-all hover:rotate-0"
                 role="img"
                 aria-label="Digital Souvenir Ticket for ${entry.Band}">

                <div class="flex justify-between items-start mb-4">
                    <span class="text-[9px] font-black border border-current px-1 uppercase ${style.accent}" aria-label="Ticket Type">General Admission</span>
                    <span class="text-[9px] font-black italic uppercase tracking-widest ${style.accent} opacity-40">GigList</span>
                </div>

                <div class="text-2xl font-black mb-0.5 leading-none ${style.accent} uppercase italic" aria-label="Headlining Artist">
                    ${entry.Band}
                </div>

                ${supportActs ? `
                    <div class="text-[10px] font-bold mb-2 uppercase tracking-tight opacity-70 ${style.accent}" aria-label="Support Acts">
                        + ${supportActs}
                    </div>` : '<div class="mb-2"></div>'}

                <div class="text-sm mb-4 opacity-80 font-bold ${style.accent}" aria-label="Venue Name">
                    ${entry.OfficialVenue}
                </div>

                <div class="flex justify-between text-[11px] font-bold border-t border-b border-black/10 py-2 ${style.accent}">
                    <span aria-label="Show Date">DATE: ${entry.Date}</span>
                    <span aria-label="Ticket Price">PRICE: ${displayPrice}</span>
                </div>

                <div class="mt-4 ${isLandscape ? 'h-10' : 'h-8'} bg-black w-full"
                     style="background: repeating-linear-gradient(90deg, #000, #000 2px, transparent 2px, transparent 4px); opacity: 0.15;"
                     aria-hidden="true">
                </div>
            </div>
        `;

// --- RENDER ---
// Layout: hero image + compact title strip are pinned (position: sticky) at
// the top of the single scroll container below. Actions, Setlist, Buddies,
// and Notes are independent collapsible strips (Setlist open by default) so
// no single section gets squeezed into a tiny scrolling sliver on short
// viewports (e.g. iPhone SE). The outer #modal wrapper in vault.html already
// provides max-h-[90vh] + overflow-y-auto — that's the *only* scroll
// container; the sticky header relies on that. Note: the sticky wrapper must
// not sit inside any OTHER ancestor with overflow:hidden/auto between it and
// that real scroll container, or the browser anchors "sticky" to the wrong
// box and it silently stops working — that's why the rounding/clipping was
// moved onto the sticky wrapper itself rather than a plain parent div.
    window._gigModalOpenSections = new Set(['setlist']);
    modalContent.innerHTML = `
        <div class="bg-white">
            <div class="sticky top-0 z-30 bg-white rounded-t-[2.5rem] overflow-hidden">
            <div class="relative h-32 md:h-56 w-full bg-slate-900 flex items-center justify-center overflow-hidden">
                                <img id="h-supabase"
                                     src=""
                                     alt=""
                                     class="absolute inset-0 w-full h-full object-cover z-20 hidden">

                                <img id="h-scrapbook"
                                     src=""
                                     alt=""
                                     class="absolute inset-0 w-full h-full object-cover z-10 hidden">

                                <img id="h-artist"
                                     src=""
                                     alt=""
                                     class="absolute inset-0 w-full h-full object-cover z-10 hidden">

                                <div id="h-ticket"
                                     class="absolute inset-0 z-10 items-center justify-center p-6 bg-slate-50 hidden">
                                    ${ticketHTML}
                                </div>

                <!-- Camera upload button — personal users + band admins -->
                ${(!window.isReadOnly && (window.currentUser?.Type === 'Personal' || (window.isBandMode && window.currentUser?.is_admin))) ? `
                <label id="h-camera-btn"
                       aria-label="Add or replace photo for this show"
                       class="absolute bottom-3 right-14 z-50 bg-black/40 backdrop-blur-md text-white p-2 rounded-full hover:bg-black/60 transition-all cursor-pointer">
                    <i data-lucide="camera" class="w-5 h-5" aria-hidden="true"></i>
                    <input type="file" accept="image/*"
                           class="hidden"
                           onchange="window.uploadScrapbookPhoto(this, '${entry['Journal Key']?.replace(/'/g, "\\'")}', '${formattedDate}', '${cleanVenue}', ${window.isBandMode})">
                </label>` : ''}

                <button onclick="window.closeModal()"
                        aria-label="Close details"
                        class="absolute top-4 right-4 z-50 bg-black/40 backdrop-blur-md text-white p-2 rounded-full hover:bg-black/60 transition-all focus:ring-2 focus:ring-white">
                    <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
                </button>
            </div>

            <div class="px-6 pt-4 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <h2 id="modal-title" tabindex="-1" class="text-xl md:text-3xl font-black italic uppercase leading-tight text-slate-900 outline-none truncate">${entry.Band}</h2>
                    <div class="flex gap-3 text-slate-400 text-[9px] font-bold uppercase tracking-widest mt-1 flex-wrap">
                        <span class="flex items-center gap-1"><i data-lucide="calendar" class="w-3 h-3 text-indigo-500"></i> <time datetime="${formattedDate}">${entry.Date}</time></span>
                        <span class="flex items-center gap-1 min-w-0"><i data-lucide="map-pin" class="w-3 h-3 text-indigo-500 flex-shrink-0"></i> <span class="truncate">${entry.OfficialVenue}</span></span>
                    </div>
                </div>
                ${isFestival ? '<span class="flex-shrink-0 bg-amber-400 text-black text-[8px] font-black px-2 py-1 rounded uppercase">Festival</span>' : ''}
            </div>
            </div>

            <button type="button"
                    onclick="window._toggleGigModalSection('actions')"
                    aria-expanded="false"
                    aria-controls="gig-panel-actions"
                    class="w-full flex items-center justify-between px-6 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Actions</span>
                <i id="gig-chevron-actions" data-lucide="chevron-down" class="w-4 h-4 text-slate-400 transition-transform duration-200" aria-hidden="true"></i>
            </button>
            <div id="gig-panel-actions" class="border-b border-slate-100" style="display:grid;grid-template-rows:0fr;transition:grid-template-rows 0.25s ease">
                <div style="overflow:hidden;min-height:0">
                    <div class="px-6 py-4">
                        <div class="flex items-center gap-2 mb-3 flex-wrap">
                            <a href="${youtubeLink}" target="_blank" rel="noopener"
                                data-tip="watch_clips"
                                class="bg-red-600 hover:bg-red-700 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-transform active:scale-95 focus:ring-2 focus:ring-red-500">
                                 <i data-lucide="play-circle" class="w-4 h-4" aria-hidden="true"></i> WATCH CLIPS
                            </a>
                            <button onclick="window.openEditGigModal('${entry['Journal Key']?.replace(/'/g, "\\'")}')"
                                    data-tip="edit"
                                    ${window.isReadOnly ? 'hidden' : ''}
                                    class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                                <i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i> EDIT
                            </button>
                            <a href="${spotifyLink}" target="_blank" rel="noopener"
                               class="bg-emerald-500 hover:bg-emerald-600 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                                <i data-lucide="music-2" class="w-3.5 h-3.5" aria-hidden="true"></i> SPOTIFY
                            </a>
                            ${window.currentUser?.isAuthUser && (hasSetlistData && gigIsPast || !gigIsPast) ? `
                                <button id="${gigIsPast ? 'relive' : 'gig-ready'}-btn-${entry['Journal Key']?.replace(/[^a-z0-9]/gi,'_')}"
                                        data-tip="playlist"
                                        onclick="window.${gigIsPast ? 'createRelivePlaylist' : 'createGigReadyPlaylist'}('${entry['Journal Key']?.replace(/'/g, "\\'")}', '${entry.Band.replace(/'/g, "\\'")}', '${entry.Date}', '${entry.OfficialVenue?.replace(/'/g, "\\'")}')"
                                        class="${gigIsPast ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-green-500 hover:bg-green-600'} text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                                    <i data-lucide="${gigIsPast ? 'list-music' : 'zap'}" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                    ${gigIsPast ? 'RELIVE' : 'GET READY'}
                                </button>` : ''}
                            <button onclick="window.shareGig(window.currentEditingGig)"
                                    data-tip="share"
                                    class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                                <i data-lucide="share-2" class="w-3.5 h-3.5" aria-hidden="true"></i> SHARE
                            </button>
                            <span id="modal-archive-btn-wrap-${entry['Journal Key']?.replace(/[^a-z0-9]/gi,'_')}"></span>
                        </div>
                        ${(hasPhotos || hasReview || hasSetlist) ? `
                        <div class="flex items-center gap-4">
                            ${hasPhotos ? `<a href="${photosUrl}" target="_blank" rel="noopener"
                                class="flex items-center gap-1.5 text-[10px] font-black text-slate-400 hover:text-indigo-600 transition-colors"
                                title="View photo album">
                                <i data-lucide="camera" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                <span class="uppercase tracking-widest">Photos</span>
                            </a>` : ''}
                            ${hasReview ? `<a href="${reviewUrl}" target="_blank" rel="noopener"
                                data-tip="setlist"
                                class="flex items-center gap-1.5 text-[10px] font-black text-slate-400 hover:text-indigo-600 transition-colors"
                                title="Read review or show page">
                                <i data-lucide="newspaper" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                <span class="uppercase tracking-widest">${window.isBandMode && (window.currentArtist||'').toLowerCase() === 'weezer' ? 'Weezerpedia' : 'Review'}</span>
                            </a>` : ''}
                            ${hasSetlist ? `<a href="${setlistUrl}" target="_blank" rel="noopener"
                                class="flex items-center gap-1.5 text-[10px] font-black text-slate-400 hover:text-indigo-600 transition-colors"
                                title="View on setlist.fm">
                                <i data-lucide="list-music" class="w-3.5 h-3.5" aria-hidden="true"></i>
                                <span class="uppercase tracking-widest">Setlist.fm</span>
                            </a>` : ''}
                        </div>` : ''}
                    </div>
                </div>
            </div>

            <button type="button"
                    onclick="window._toggleGigModalSection('setlist')"
                    aria-expanded="true"
                    aria-controls="gig-panel-setlist"
                    class="w-full flex items-center justify-between px-6 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Setlist</span>
                <i id="gig-chevron-setlist" data-lucide="chevron-down" class="w-4 h-4 text-slate-400 transition-transform duration-200" style="transform:rotate(180deg)" aria-hidden="true"></i>
            </button>
            <div id="gig-panel-setlist" class="border-b border-slate-100" style="display:grid;grid-template-rows:1fr;transition:grid-template-rows 0.25s ease">
                <div style="overflow:hidden;min-height:0">
                    <div class="px-6 py-4">
                        <div class="${isFestival ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'flex flex-col gap-4'}">
                            ${sets.map(s => `
                                <div class="bg-white p-5 rounded-[1.5rem] border border-slate-100 shadow-sm">
                                    <div class="flex justify-between items-center mb-3 border-b border-slate-50 pb-2">
                                        <span class="font-black text-indigo-600 text-xs uppercase italic">${s.Artist}</span>
                                        <span class="text-[7px] font-black px-2 py-0.5 bg-slate-50 rounded text-slate-400 uppercase">${s.Role}</span>
                                    </div>
                                    <div class="text-[11px] text-slate-500 leading-relaxed font-medium">
                                        ${(s.Setlist || '').replace(/^NOT_FOUND$/i, '')
                                            ? (s.Setlist).replace(/\|/g, '<br>')
                                            : '<span class="text-slate-300 italic text-xs">No setlist recorded</span>'
                                        }
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>

            <button type="button"
                    onclick="window._toggleGigModalSection('buddies')"
                    aria-expanded="false"
                    aria-controls="gig-panel-buddies"
                    class="w-full flex items-center justify-between px-6 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Buddies</span>
                <i id="gig-chevron-buddies" data-lucide="chevron-down" class="w-4 h-4 text-slate-400 transition-transform duration-200" aria-hidden="true"></i>
            </button>
            <div id="gig-panel-buddies" class="border-b border-slate-100" style="display:grid;grid-template-rows:0fr;transition:grid-template-rows 0.25s ease">
                <div style="overflow:hidden;min-height:0">
                    <div class="px-6 py-4">
                        <div id="modal-companions-${entry['Journal Key']?.replace(/[^a-z0-9]/gi,'_')}" class="flex flex-wrap gap-1.5">
                            <span class="text-[9px] opacity-60 italic text-slate-400">Loading…</span>
                        </div>
                    </div>
                </div>
            </div>

            <button type="button"
                    onclick="window._toggleGigModalSection('notes')"
                    aria-expanded="false"
                    aria-controls="gig-panel-notes"
                    class="w-full flex items-center justify-between px-6 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Notes</span>
                <i id="gig-chevron-notes" data-lucide="chevron-down" class="w-4 h-4 text-slate-400 transition-transform duration-200" aria-hidden="true"></i>
            </button>
            <div id="gig-panel-notes" style="display:grid;grid-template-rows:0fr;transition:grid-template-rows 0.25s ease">
                <div style="overflow:hidden;min-height:0">
                    <div class="px-6 py-4">
                        ${entry.Comments && entry.Comments !== "nan"
                            ? `<div class="p-5 bg-amber-50/50 border-l-4 border-amber-400 italic text-slate-700 text-sm rounded-r-2xl">"${entry.Comments}"</div>`
                            : `<p class="text-xs text-slate-300 italic">No notes for this show.</p>`}
                    </div>
                </div>
            </div>
        </div>
    `;

// --- ASSET RESOLUTION WATERFALL ---
// Priority: 1. Supabase Storage (user's private scrapbook)
//           2. Spotify artist image (from artists table via data.js lookup)
//           3. Local assets/scrapbook/ (existing photos, .jpg then .JPG)
//           4. Local assets/artists/ stock photo (.jpg then .JPG)
//           5. Mock ticket (generated HTML)

    const imgSupabase  = document.getElementById('h-supabase');
    const imgScrapbook = document.getElementById('h-scrapbook');
    const imgArtist    = document.getElementById('h-artist');
    const divTicket    = document.getElementById('h-ticket');

    const trySpotify = () => {
                const spotifyUrl = entry.SpotifyImageUrl || null;
                if (spotifyUrl) {
                    imgArtist.onload  = () => imgArtist.classList.remove('hidden');
                    imgArtist.onerror = () => tryArtist();
                    imgArtist.src     = spotifyUrl;
                } else {
                    tryArtist();
                }
            };

        const tryLocalScrapbook = () => {
                    const jpgProbe = new Image();
                    jpgProbe.onload  = () => {
                        imgScrapbook.onload = () => imgScrapbook.classList.remove('hidden');
                        imgScrapbook.src = scrapbookPath;
                    };
                    jpgProbe.onerror = () => {
                        const jpgUpperProbe = new Image();
                        jpgUpperProbe.onload  = () => {
                            imgScrapbook.onload = () => imgScrapbook.classList.remove('hidden');
                            imgScrapbook.src = scrapbookPath.replace('.jpg', '.JPG');
                        };
                        jpgUpperProbe.onerror = () => trySpotify();
                        jpgUpperProbe.src = scrapbookPath.replace('.jpg', '.JPG');
                    };
                    jpgProbe.src = scrapbookPath;
                };

        const tryArtist = () => {
            imgArtist.onload = () => imgArtist.classList.remove('hidden');
            imgArtist.onerror = () => {
                if (imgArtist.src.endsWith('.jpg')) {
                    imgArtist.src = artistPath.replace('.jpg', '.JPG');
                } else {
                    divTicket.classList.remove('hidden');
                    divTicket.style.display = 'flex';
                }
            };
            imgArtist.src = artistPath;
        };

        // Step 1: try Supabase Storage
            const userId = window.currentUser?.id;
            import('./supabase.js').then(async ({ supabase }) => {
                if (window.isBandMode) {
                    const bandSlug = (window.currentArtist || 'band').toLowerCase().replace(/[^a-z0-9]/g, '-');
                    const fileName  = `${formattedDate}-${cleanVenue}.jpg`;
                    const { data: listed } = await supabase.storage
                        .from('band-photos')
                        .list(bandSlug, { search: fileName });
                    if (listed?.length) {
                        const { data } = supabase.storage.from('band-photos').getPublicUrl(`${bandSlug}/${fileName}`);
                        imgSupabase.onload = () => imgSupabase.classList.remove('hidden');
                        imgSupabase.onerror = () => tryLocalScrapbook();
                        imgSupabase.src = data.publicUrl;
                    } else {
                        tryLocalScrapbook();
                    }
                } else if (userId) {
                    const storagePath = `${userId}/${formattedDate}-${cleanVenue}.jpg`;
                    const { data: listed } = await supabase.storage
                        .from('gig-photos')
                        .list(userId, { search: `${formattedDate}-${cleanVenue}.jpg` });
                    if (!listed?.length) {
                        tryLocalScrapbook();
                    } else {
                        const { data, error } = await supabase.storage
                            .from('gig-photos')
                            .createSignedUrl(storagePath, 3600);
                        if (error || !data?.signedUrl) {
                            tryLocalScrapbook();
                        } else {
                            imgSupabase.onload = () => imgSupabase.classList.remove('hidden');
                            imgSupabase.onerror = () => tryLocalScrapbook();
                            imgSupabase.src = data.signedUrl;
                        }
                    }
                } else {
                    tryLocalScrapbook();
                }
            });

                modal.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                setTimeout(() => document.getElementById('modal-title')?.focus(), 100);
                if (window.lucide) lucide.createIcons();
                // ── Layer B: modal tips ──
                        if (window.currentUser?.isAuthUser) {
                            const modalEl = document.getElementById('modal-content');
                            if (modalEl) initModalTips(modalEl, { gigDate: formattedDate });
                        }
            };

// ─── GIG MODAL ACCORDION (Actions / Setlist) ─────────────────────────────────
// Each strip (Actions, Setlist, Buddies, Notes) collapses/expands independently —
// with 4 sections a strict single-open accordion would hide too much, so this
// is just a set of independent toggles, not mutually exclusive. Uses the CSS
// grid-template-rows 0fr → 1fr trick so it animates to/from arbitrary content
// height without needing scrollHeight measurement in JS.

window._gigModalOpenSections = new Set(['setlist']);

window._toggleGigModalSection = (section) => {
    const panel  = document.getElementById(`gig-panel-${section}`);
    const chev   = document.getElementById(`gig-chevron-${section}`);
    const header = panel?.previousElementSibling;
    const wasOpen = window._gigModalOpenSections.has(section);
    const isOpen  = !wasOpen;

    if (isOpen) window._gigModalOpenSections.add(section);
    else window._gigModalOpenSections.delete(section);

    if (panel) panel.style.gridTemplateRows = isOpen ? '1fr' : '0fr';
    if (chev)  chev.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
    if (header?.tagName === 'BUTTON') header.setAttribute('aria-expanded', String(isOpen));
};

// ─── BAND PAGE REQUEST BUTTON ─────────────────────────────────────────────────

/**
 * Called by openGigModal after the modal HTML is in the DOM.
 * Checks whether the band already has a Band Page, has a pending request, or
 * is new — and renders the appropriate button/link into the placeholder span.
 *
 * band_page_requests table schema (add if not exists):
 *   id          uuid primary key default gen_random_uuid()
 *   user_id     uuid references profiles(id)
 *   band_name   text not null
 *   mbid        text
 *   created_at  timestamptz default now()
 *   unique(user_id, band_name)
 */
export async function initArchiveButton(entry) {
    // Only show for authenticated personal users, not in band/friend mode
    if (!window.currentUser?.isAuthUser || window.currentUser?.Type !== 'Personal') return;

    const bandName = entry.Band || entry.band || '';
    const safeKey  = (entry['Journal Key'] || '').replace(/[^a-z0-9]/gi, '_');
    const wrap     = document.getElementById(`modal-archive-btn-wrap-${safeKey}`);
    if (!wrap) return;

    const status = await getArchiveStatus(bandName);

    if (status === 'archived') {
        // Link through to the existing Band Page
        const bandParam = encodeURIComponent(bandName);
        wrap.innerHTML = `
            <a href="vault.html?band=${bandParam}"
               class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                <i data-lucide="users" class="w-3.5 h-3.5" aria-hidden="true"></i> VIEW BAND PAGE
            </a>`;
    } else if (status === 'pending') {
        wrap.innerHTML = `
            <span class="bg-amber-50 text-amber-600 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 border border-amber-200">
                <i data-lucide="clock" class="w-3.5 h-3.5" aria-hidden="true"></i> REQUESTED ✓
            </span>`;
    } else {
        // Not archived and no pending request — show the request button
        wrap.innerHTML = `
            <div class="flex flex-col items-start gap-0.5">
                <button id="band-page-request-btn-${safeKey}"
                        onclick="window.requestBandPage('${bandName.replace(/'/g, "\\'")}', '${safeKey}')"
                        class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95"
                        data-tip="request_band_page">
                    <i data-lucide="plus-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> REQUEST BAND PAGE
                </button>
                <p class="text-[8px] text-slate-400 font-bold px-1">Get stats, history &amp; fans for this artist</p>
            </div>`;
    }
    if (window.lucide) lucide.createIcons();
}

/**
 * Single-tap Band Page request flow per spec §1.4.
 * Replaces the old multi-step setlist.fm search UI.
 * Writes directly to band_page_requests; the setlist.fm MBID lookup
 * is deferred to the admin review step so the user isn't blocked.
 */
window.requestBandPage = async function(bandName, safeKey) {
    const btn = document.getElementById(`band-page-request-btn-${safeKey}`);
    if (!btn) return;

    // Immediate disabled + spinner feedback
    btn.disabled = true;
    btn.innerHTML = `
        <svg class="w-3.5 h-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
        </svg>
        Requesting…`;

    try {
        const userId = window.currentUser?.id;
        if (!userId) throw new Error('Not signed in');

        const { error } = await supabase
            .from('band_page_requests')
            .insert({ user_id: userId, band_name: bandName });

        // Unique constraint violation (23505) = already requested — treat as success
        if (error && error.code !== '23505') throw error;

        // Success: relabel button and show sub-label
        const wrap = btn.closest('[id^="modal-archive-btn-wrap-"]');
        if (wrap) {
            wrap.innerHTML = `
                <div class="flex flex-col items-start gap-0.5">
                    <span class="bg-emerald-50 text-emerald-600 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 border border-emerald-100">
                        <i data-lucide="check-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> REQUESTED ✓
                    </span>
                    <p class="text-[8px] text-slate-400 font-bold px-1">We'll notify you when the ${bandName} page goes live</p>
                </div>`;
            if (window.lucide) lucide.createIcons();
        }

        window.showToast?.(`Request received! We'll notify you when the ${bandName} page goes live.`, 'success');

        if (typeof window.track === 'function') {
            window.track('band_page_requested', { artist: bandName });
        }

    } catch (err) {
        console.error('ui.js: band page request failed', err);
        // Re-enable button on error
        btn.disabled = false;
        btn.innerHTML = `
            <i data-lucide="plus-circle" class="w-3.5 h-3.5" aria-hidden="true"></i> REQUEST BAND PAGE`;
        if (window.lucide) lucide.createIcons();
        window.showToast?.('Something went wrong — please try again.', 'error');
    }
};

// ── LEGACY EXPORT — keep window.openArchiveRequest as a no-op redirect so any
// stale references (bookmarks, cached SW) don't throw. Remove in a future cleanup.
window.openArchiveRequest = function(bandName) {
    console.warn('openArchiveRequest() is deprecated — use requestBandPage()');
    const safeKey = bandName.replace(/[^a-z0-9]/gi, '_');
    window.requestBandPage?.(bandName, safeKey);
};
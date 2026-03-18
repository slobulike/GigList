/**
 * GigList - UI Module
 * Handles Modals, Tickets, Tables, and Accessibility
 */
/**
 * GigList - UI Module
 */
import { getGlobalSeenCount, slugify, slugifyArtist, parseDate } from './utils.js';
import { renderCalendar } from './calendar.js';
import { sortGigs, deriveType } from './data.js';
import { getUniqueSongCount } from './data.js';

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
        if(el) el.innerText = counts.total.toLocaleString();
    });

    ['stat-venues', 'dc-stat-venues'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.innerText = counts.venues.toLocaleString();
    });

    ['stat-artists', 'dc-stat-artists', 'stat-artist-count'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.innerText = counts.artists.toLocaleString();
    });
};

export const updateRank = (data) => {
    const user = window.currentUser;
    const rankEl = document.getElementById('stat-rank');
    if (rankEl && user) {
        rankEl.innerText = user.Rank || user.rank || Math.floor(data.length / 10);
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

        card.className = 'bg-indigo-600 rounded-[1.5rem] p-4 flex items-center justify-between';
        if (eyebrowEl) { eyebrowEl.textContent = 'Next show'; eyebrowEl.className = 'text-[9px] font-black text-indigo-300 uppercase tracking-widest mb-1'; }
        if (mainEl)    { mainEl.textContent = mainText; mainEl.className = 'text-lg font-black text-white leading-tight'; }
        if (subEl)     { subEl.textContent = subText;   subEl.className = 'text-[10px] font-bold text-indigo-300 mt-0.5'; }
        if (numEl)     { numEl.textContent = days;      numEl.className = 'text-4xl font-black text-white leading-none tracking-tighter'; }
        if (unitEl)    { unitEl.textContent = days === 1 ? 'day' : 'days'; unitEl.className = 'text-[9px] font-black text-indigo-300 uppercase tracking-widest'; }

    } else if (lastGig) {
        const days = Math.floor((today - parseDate(lastGig.Date)) / (1000 * 60 * 60 * 24));
        const mainText = window.isBandMode ? lastGig.OfficialVenue : lastGig.Band;
        const subText  = window.isBandMode
            ? lastGig.Date
            : `${lastGig.OfficialVenue} · ${lastGig.Date}`;

        card.className = 'bg-slate-700 rounded-[1.5rem] p-4 flex items-center justify-between';
        if (eyebrowEl) { eyebrowEl.textContent = 'Last show'; eyebrowEl.className = 'text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1'; }
        if (mainEl)    { mainEl.textContent = mainText; mainEl.className = 'text-lg font-black text-white leading-tight'; }
        if (subEl)     { subEl.textContent = subText;   subEl.className = 'text-[10px] font-bold text-slate-400 mt-0.5'; }
        if (numEl)     { numEl.textContent = days;      numEl.className = 'text-4xl font-black text-white leading-none tracking-tighter'; }
        if (unitEl)    { unitEl.textContent = days === 1 ? 'day ago' : 'days ago'; unitEl.className = 'text-[9px] font-black text-slate-400 uppercase tracking-widest'; }
    }
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

    // Build Paths based on your specific naming convention
    const [d, m, y] = item.Date ? item.Date.split('/') : ['01','01','1970'];
    const scrapbookPath = `assets/scrapbook/${y}-${m}-${d}-${slugify(item.OfficialVenue || '')}.jpg`;

    // Updated to match your "brand_new_stock_photo.jpg" format
    const artistPath = `assets/artists/${slugifyArtist(item.Band || item.band || '')}_stock_photo.jpg`;

    const accentClass = item.isFuture ? 'bg-emerald-600' : 'bg-indigo-600';
    const hoverClass = item.isFuture ? 'group-hover:text-emerald-400' : 'group-hover:text-indigo-400';

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

        // Only show the number pill from show #2 onwards
        if (nextCount > 1) {
            showNumberPill = `<span class="bg-emerald-400/90 text-emerald-950 font-black text-[9px] uppercase tracking-widest px-3 py-1 rounded-full">${isFest ? 'Visit' : 'Show'} #${nextCount}</span>`;
        }
    }

    card.innerHTML = `
        <div class="relative h-full w-full overflow-hidden rounded-[2.5rem] bg-slate-900 shadow-2xl">
            <img src="${item.isCTA ? "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&q=80" : scrapbookPath}"
                 class="absolute inset-0 w-full h-full object-cover opacity-60 transition-opacity duration-500"
                 alt=""
                 onerror="this.onerror=function(){this.src='${fallback}';this.onerror=null;}; this.src='${artistPath}';">

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
};

/* --- TABLE & CALENDAR VIEWS --- */

export const renderTable = (data) => {
    const tableContainer = document.getElementById('tableContainer');
    if (!tableContainer) return;

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
                               class="inline-flex items-center text-indigo-400 hover:text-indigo-600 transition-colors" title="View Photo">
                                <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                            </a>` : '';

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
                                    <div class="flex items-center gap-2">
                                        ${mainContent}
                                        ${cameraIcon}
                                    </div>
                                    ${matchLabels}
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

export const renderMap = (data) => {
    const mapCanvas = document.getElementById('map-canvas');
    if (!mapCanvas) return;

    if (!gigMap) {
        gigMap = L.map('map-canvas', {
            zoomControl: false,
            minZoom: 1,
            worldCopyJump: true
        });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(gigMap);
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
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(fullMapInstance);
        fullMarkerLayer = L.layerGroup().addTo(fullMapInstance);
    }

    // 2. Fetch data from the global window objects
    const data = window.filteredResults || window.journalData || [];
    const venues = window.venueLookup || {};

    // 3. Render
    setTimeout(() => {
        fullMapInstance.invalidateSize();
        fullMarkerLayer.clearLayers();

        const bounds = [];
        data.forEach(gig => {
            const venueInfo = venues[gig.OfficialVenue];

            if (venueInfo && venueInfo.lat && venueInfo.lng) {
                const m = L.circleMarker([venueInfo.lat, venueInfo.lng], {
                    radius: 7,
                    fillColor: "#4f46e5",
                    color: "#fff",
                    weight: 2,
                    fillOpacity: 0.9
                }).bindPopup(`
                    <div style="font-family: sans-serif; padding: 5px;">
                        <strong style="color: #4f46e5; font-size: 14px;">${gig.Band}</strong><br>
                        <span style="font-weight: bold;">${gig.OfficialVenue}</span><br>
                        <small style="color: #64748b;">${gig.Date}</small>
                    </div>
                `);
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

    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modal-content');

    // --- DATA PREP ---
    const sets = performanceData.filter(p => p['Journal Key'] === key);
    const isFestival = entry['Festival?'] && entry['Festival?'].trim().toUpperCase().startsWith('Y');
    const [d, m, y] = entry.Date.split('/');
    const formattedDate = `${y}-${m}-${d}`;
    const cleanVenue = entry.OfficialVenue.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');


    // Generate the slug
    const scrapbookPath = `assets/scrapbook/${formattedDate}-${cleanVenue}.jpg`;

    const artistPath = `assets/artists/${entry.Band.toLowerCase().replace(/ /g, '_')}_stock_photo.jpg`;
    const youtubeLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${entry.Band} live ${entry.OfficialVenue} ${entry.Date}`)}`;

    // --- ENHANCED TICKET LOGIC ---
    const style = getTicketStyle(key);
    const isLandscape = style.type === 'landscape';
    const supportActs = sets
        .filter(s => s.Artist.toLowerCase() !== entry.Band.toLowerCase())
        .map(s => s.Artist)
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
    modalContent.innerHTML = `
        <div class="flex flex-col h-full max-h-[90vh]">
            <div class="flex-none bg-white rounded-t-[2.5rem] overflow-hidden border-b border-slate-100 shadow-sm z-50">
                <div class="relative h-48 md:h-64 w-full bg-slate-900 flex items-center justify-center overflow-hidden">
                    <img id="h-scrapbook"
                         src="${scrapbookPath}"
                         alt=""
                         class="absolute inset-0 w-full h-full object-cover z-10 hidden">

                    <img id="h-artist"
                         src="${artistPath}"
                         alt=""
                         class="absolute inset-0 w-full h-full object-cover z-10 hidden">

                    <div id="h-ticket"
                         class="absolute inset-0 z-10 items-center justify-center p-6 bg-slate-50 hidden">
                        ${ticketHTML}
                    </div>

                    <button onclick="window.closeModal()"
                            aria-label="Close details"
                            class="absolute top-4 right-4 z-50 bg-black/40 backdrop-blur-md text-white p-2 rounded-full hover:bg-black/60 transition-all focus:ring-2 focus:ring-white">
                        <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
                    </button>
                </div>

                <div class="p-6 pb-4 bg-white">
                    <div class="flex items-center gap-2 mb-3 flex-wrap">
                        <a href="${youtubeLink}" target="_blank" rel="noopener" class="bg-red-600 hover:bg-red-700 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-transform active:scale-95 focus:ring-2 focus:ring-red-500">
                             <i data-lucide="play-circle" class="w-4 h-4" aria-hidden="true"></i> WATCH CLIPS
                        </a>
                        <button onclick="window.openEditGigModal('${entry['Journal Key']?.replace(/'/g, "\\'")}')"
                                class="bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-all active:scale-95">
                            <i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i> EDIT
                        </button>
                        ${isFestival ? '<span class="bg-amber-400 text-black text-[8px] font-black px-2 py-1 rounded uppercase">Festival</span>' : ''}
                    </div>
                    <h2 id="modal-title" tabindex="-1" class="text-4xl font-black italic uppercase leading-none text-slate-900 mb-3 outline-none">${entry.Band}</h2>
                    <div class="flex gap-4 text-slate-400 text-[10px] font-bold uppercase tracking-widest">
                        <span class="flex items-center gap-1.5"><i data-lucide="calendar" class="w-3.5 h-3.5 text-indigo-500"></i> <time datetime="${formattedDate}">${entry.Date}</time></span>
                        <span class="flex items-center gap-1.5"><i data-lucide="map-pin" class="w-3.5 h-3.5 text-indigo-500"></i> ${entry.OfficialVenue}</span>
                    </div>
                </div>
            </div>

            <div class="flex-grow overflow-y-auto custom-modal-scroll p-6 md:p-8 pt-4">
                <div class="flex items-center gap-2 mb-6 pb-4 border-b border-slate-50">
                    <i data-lucide="users" class="w-4 h-4 text-slate-300"></i>
                    <div class="flex flex-wrap gap-1.5">${
                        entry['Went With'] && entry['Went With'] !== "nan" && entry['Went With'] !== "Alone"
                        ? entry['Went With'].split(/[,\/&]/).map(n => `<span class="bg-slate-100 text-slate-600 text-[9px] px-2 py-1 rounded-md font-bold uppercase tracking-wider border border-slate-200">${n.trim()}</span>`).join('')
                        : `<span class="text-[9px] opacity-60 italic text-slate-400">Solo Mission</span>`
                    }</div>
                </div>

                ${entry.Comments && entry.Comments !== "nan" ? `<div class="p-5 bg-amber-50/50 border-l-4 border-amber-400 italic text-slate-700 text-sm rounded-r-2xl mb-8">"${entry.Comments}"</div>` : ''}

                <div class="${isFestival ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'flex flex-col gap-4'}">
                    ${sets.map(s => `
                        <div class="bg-white p-5 rounded-[1.5rem] border border-slate-100 shadow-sm">
                            <div class="flex justify-between items-center mb-3 border-b border-slate-50 pb-2">
                                <span class="font-black text-indigo-600 text-xs uppercase italic">${s.Artist}</span>
                                <span class="text-[7px] font-black px-2 py-0.5 bg-slate-50 rounded text-slate-400 uppercase">${s.Role}</span>
                            </div>
                            <div class="text-[11px] text-slate-500 leading-relaxed font-medium">
                                ${(s.Setlist || "No setlist found").replace(/\|/g, '<br>')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;

// --- ASSET RESOLUTION (The "Ext-Check" Waterfall) ---
    const imgScrapbook = document.getElementById('h-scrapbook');
    const imgArtist = document.getElementById('h-artist');
    const divTicket = document.getElementById('h-ticket');

    const tryArtist = () => {
        imgArtist.onload = () => imgArtist.classList.remove('hidden');
        imgArtist.onerror = () => {
            // If artist.jpg fails, try artist.JPG
            if (imgArtist.src.endsWith('.jpg')) {
                imgArtist.src = artistPath.replace('.jpg', '.JPG');
            } else {
                // Total failure - show the ticket
                divTicket.classList.remove('hidden');
                divTicket.style.display = 'flex';
            }
        };
        imgArtist.src = artistPath;
    };

    imgScrapbook.onload = () => imgScrapbook.classList.remove('hidden');
    imgScrapbook.onerror = () => {
        // 1. If scrapbook.jpg fails, try scrapbook.JPG
        if (imgScrapbook.src.endsWith('.jpg')) {
            imgScrapbook.src = scrapbookPath.replace('.jpg', '.JPG');
        } else {
            // 2. If both fail, move to Artist logic
            tryArtist();
        }
    };

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('modal-title')?.focus(), 100);
    if (window.lucide) lucide.createIcons();
};
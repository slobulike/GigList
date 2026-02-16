/**
 * GigList - UI Module
 * Handles Modals, Tickets, Tables, and Accessibility
 */
/**
 * GigList - UI Module
 */
import { getGlobalSeenCount, slugify, slugifyArtist, parseDate } from './utils.js';
import { renderCalendar } from './calendar.js';
let gigMap = null;
let markerLayer = null;
import * as Data from './data.js';

const defaultImages = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800",
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800"
];

/* --- DASHBOARD & TICKER --- */

export const updateCurrentDate = () => {
    const dateEl = document.getElementById('current-date-display');
    if (!dateEl) return;
    const now = new Date();
    dateEl.innerText = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

export const updateStats = (data) => {
    const counts = {
        total: data.length,
        venues: new Set(data.map(g => g.OfficialVenue)).size,
        artists: new Set(data.map(g => g.Band)).size
    };
    ['stat-total', 'dc-stat-gigs'].forEach(id => { if(document.getElementById(id)) document.getElementById(id).innerText = counts.total; });
    ['stat-venues', 'dc-stat-venues'].forEach(id => { if(document.getElementById(id)) document.getElementById(id).innerText = counts.venues; });
    ['stat-artists', 'dc-stat-artists'].forEach(id => { if(document.getElementById(id)) document.getElementById(id).innerText = counts.artists; });
};

export const updateRank = (data) => {
    const user = JSON.parse(localStorage.getItem('gv_user'));
    const rankEl = document.getElementById('stat-rank');
    if (rankEl && user) {
        rankEl.innerText = user.Rank || user.rank || Math.floor(data.length / 10);
    }
};

export const updateTicker = (data) => {
    const tickerEl = document.getElementById('global-ticker');
    if (!tickerEl) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcomingGigs = data.filter(g => parseDate(g.Date) >= today).sort((a, b) => parseDate(a.Date) - parseDate(b.Date));
    const pastGigs = data.filter(g => parseDate(g.Date) < today).sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    if (upcomingGigs.length > 0) {
        const next = upcomingGigs[0];
        const days = Math.ceil((parseDate(next.Date) - today) / (1000 * 60 * 60 * 24));
        tickerEl.innerHTML = `
            <div class="flex flex-col items-center w-full">
                <div class="flex items-center text-[11px] font-black tracking-[0.2em] mb-1 opacity-60 uppercase">
                    <span class="text-emerald-500 animate-pulse mr-2">●</span> ${days} ${days === 1 ? 'DAY' : 'DAYS'} UNTIL
                </div>
                <div class="text-slate-900 font-black italic text-sm tracking-tight">${next.Band.toUpperCase()}</div>
            </div>`;
    } else if (pastGigs.length > 0) {
        const last = pastGigs[0];
        const days = Math.floor((today - parseDate(last.Date)) / (1000 * 60 * 60 * 24));
        tickerEl.innerHTML = `
            <div class="flex flex-col items-center w-full">
                <div class="flex items-center text-[11px] font-black tracking-[0.2em] mb-1 opacity-60 uppercase">
                    <span class="text-slate-300 mr-2">○</span> ${days} ${days === 1 ? 'DAY' : 'DAYS'} SINCE
                </div>
                <div class="text-slate-600 font-black italic text-sm tracking-tight">${last.Band.toUpperCase()}</div>
            </div>`;
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
    if (item.isFuture) {
        const count = getGlobalSeenCount(item.band, fullData);
        const isFest = item['Festival?']?.trim().toUpperCase().startsWith('Y');
        subtext = count > 0 ? `🔥 ${isFest ? 'Been' : 'Seen'} ${count} times before` : `✨ First time seeing them!`;
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
                        ${item.isFuture ? `<p class="text-emerald-400 font-black text-[10px] uppercase mt-2 tracking-widest">${subtext}</p>` : ''}
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
            // Safety check: if currentSort isn't ready, show a neutral icon
            if (!window.currentSort || window.currentSort.column !== col) {
                return '<span class="opacity-20 ml-1 text-[8px]">↕</span>';
            }
            return window.currentSort.ascending ?
                '<span class="ml-1 text-indigo-600">↑</span>' :
                '<span class="ml-1 text-indigo-600">↓</span>';
        };

    tableContainer.innerHTML = `
        <div class="overflow-x-auto bg-white rounded-3xl border border-slate-100 shadow-sm">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-slate-50/50">
                        <th onclick="window.handleSort('Date')" class="p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400 min-w-[120px]">
                            Date ${getArrow('Date')}
                        </th>
                        <th onclick="window.handleSort('Band')" class="p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                            Artist ${getArrow('Band')}
                        </th>
                        <th onclick="window.handleSort('OfficialVenue')" class="p-4 cursor-pointer hover:bg-slate-100 transition-colors text-[10px] font-black uppercase tracking-widest text-slate-400">
                            Venue ${getArrow('OfficialVenue')}
                        </th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-50">
                    ${data.map(gig => `
                        <tr onclick="window.viewGigDetails('${gig['Journal Key']}')" class="group hover:bg-indigo-50/30 transition-all cursor-pointer">
                            <td class="p-4 text-xs font-medium text-slate-500 font-mono">${gig.Date}</td>
                            <td class="p-4 text-sm font-bold text-slate-900 group-hover:text-indigo-600">${gig.Band}</td>
                            <td class="p-4 text-xs text-slate-500">${gig.OfficialVenue}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
};

/**
 * 3-Way Toggle: List | Calendar | Map
 */
export const toggleListView = (view) => {
    window.activeView = view;

    // 1. Get Data
    const dataToRender = window.filteredResults || window.journalData;

    // 2. Handle Container Visibility
    const containers = {
        'list': document.getElementById('tableContainer'),
        'map': document.getElementById('mapContainer'),
        'calendar': document.getElementById('calendarContainer')
    };

    Object.keys(containers).forEach(key => {
        if (containers[key]) {
            containers[key].classList.toggle('hidden', key !== view);
        }
    });

    // 3. Trigger Renders
    if (view === 'calendar') {
        renderCalendar(dataToRender);
    } else if (view === 'map') {
        // Map should also show the sorted order for the sidebar/pins
        const sortedData = Data.sortGigs(dataToRender, window.currentSort.column, window.currentSort.ascending);
        if (window.renderMap) window.renderMap(sortedData);
    } else {
        // APPLY SORT HERE for the list view
        const sortedData = Data.sortGigs(dataToRender, window.currentSort.column, window.currentSort.ascending);
        renderTable(sortedData);
        updateStats(dataToRender); // Stats don't care about order, so raw data is fine
    }

    // 4. Update Button Highlighting
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
};
/**
 * Leaflet Map Engine
 */
export const renderMap = (data) => {
    const mapCanvas = document.getElementById('map-canvas');
    if (!mapCanvas) return;

    // 1. Initialize map if first time
    if (!gigMap) {
        gigMap = L.map('map-canvas', {
            zoomControl: false,
            minZoom: 4,         // Tightened to prevent seeing the grey "edge of the world"
            maxBounds: [[-85, -180], [85, 180]], // Keeps user within the world map
            worldCopyJump: true
        }).setView([51.3, 0.1], 9); // Centered on South East England (London/Kent/Surrey area) at Zoom 9

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '©OpenStreetMap'
        }).addTo(gigMap);
        markerLayer = L.layerGroup().addTo(gigMap);
    }

    markerLayer.clearLayers();
    const bounds = [];
    const venuesLookup = window.venueLookup || {};

    // 2. Aggregate Gigs by Venue
    const venueStats = {};
    data.forEach(gig => {
        const vName = gig.OfficialVenue;
        if (!venueStats[vName]) venueStats[vName] = [];
        venueStats[vName].push(gig);
    });

    // 3. Create Pins
    Object.keys(venueStats).forEach(vName => {
        const gigsAtVenue = venueStats[vName];
        const coords = venuesLookup[vName];

        if (coords && !isNaN(coords.lat) && !isNaN(coords.lng)) {
            const visitCount = gigsAtVenue.length;
            const radius = Math.min(6 + (visitCount * 2), 20);

            const marker = L.circleMarker([coords.lat, coords.lng], {
                radius: radius,
                fillColor: visitCount > 1 ? "#6366f1" : "#4f46e5",
                color: "#fff",
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            });

            const gigListHTML = gigsAtVenue.map(g => `
                <div onclick="window.viewGigDetails('${g['Journal Key']?.replace(/'/g, "\\'")}')"
                     class="cursor-pointer hover:bg-slate-50 p-1.5 rounded transition-colors border-b border-slate-100 last:border-0 mb-1">
                    <p class="text-[9px] font-black text-indigo-500 uppercase leading-none">${g.Date}</p>
                    <p class="text-[11px] font-bold text-slate-800 leading-tight">${g.Band}</p>
                </div>
            `).join('');

            marker.bindPopup(`
                <div class="p-1 max-h-48 overflow-y-auto custom-scrollbar min-w-[160px]">
                    <h4 class="text-[9px] font-black uppercase text-slate-400 mb-2 tracking-widest border-b pb-1">${vName}</h4>
                    ${gigListHTML}
                    <div class="pt-2 text-center">
                        <span class="bg-slate-100 text-slate-500 text-[9px] font-black px-2 py-0.5 rounded-full uppercase">
                            ${visitCount} ${visitCount > 1 ? 'Visits' : 'Visit'}
                        </span>
                    </div>
                </div>
            `, { maxWidth: 250, className: 'gig-map-popup' });

            markerLayer.addLayer(marker);
            bounds.push([coords.lat, coords.lng]);
        }
    });

    // 4. Smart Fit Logic
    // If we have data and it's a specific search/filter, zoom to the pins.
    // If it's the full library, let it stay on the South East starting view.
    const isFiltered = data.length < (window.journalData?.length || 0);

    if (bounds.length > 0 && isFiltered) {
        gigMap.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
    } else if (!isFiltered) {
        // Reset to South East default if no filter is active
        gigMap.setView([51.3, 0.1], 9);
    }

    // Always invalidate size to fix rendering issues in hidden containers
    setTimeout(() => gigMap.invalidateSize(), 50);
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

    // LOGGING: Check your console in Production (F12) to see this output
    console.group("📸 GigList Image Debugger");
    console.log("Journal Key:", key);
    console.log("Raw Venue:", entry.OfficialVenue);
    console.log("Generated Date:", formattedDate);
    console.log("Generated Path:", scrapbookPath);
    console.groupEnd();

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
                    <div class="flex items-center gap-2 mb-3">
                        <a href="${youtubeLink}" target="_blank" rel="noopener" class="bg-red-600 hover:bg-red-700 text-white text-[9px] font-black px-4 py-2 rounded-full flex items-center gap-1.5 transition-transform active:scale-95 focus:ring-2 focus:ring-red-500">
                             <i data-lucide="play-circle" class="w-4 h-4"></i> WATCH CLIPS
                        </a>
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

    // --- ASSET RESOLUTION (Fixes Production Race Condition) ---
    const imgScrapbook = document.getElementById('h-scrapbook');
    const imgArtist = document.getElementById('h-artist');
    const divTicket = document.getElementById('h-ticket');

    // Attempt logic: Scrapbook -> Artist Stock -> Ticket
    imgScrapbook.onload = () => imgScrapbook.classList.remove('hidden');
    imgScrapbook.onerror = () => {
        imgArtist.onload = () => imgArtist.classList.remove('hidden');
        imgArtist.onerror = () => {
            divTicket.classList.remove('hidden');
            divTicket.style.display = 'flex';
        };
        imgArtist.src = artistPath; // Trigger artist load only if scrapbook fails
    };

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('modal-title')?.focus(), 100);
    if (window.lucide) lucide.createIcons();
};
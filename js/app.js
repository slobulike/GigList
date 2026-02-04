/**
 * Gig List Core Engine - Updated 2026-02-03
 */

let currentUser = JSON.parse(localStorage.getItem('gv_user'));
let journalData = [], performanceData = [], venueData = [];
let activeArtist = null, activeYear = null;
let yearChart, companionChart;
let homeCarousel = [];
let currentCarouselIndex = 0;

async function loadData() {
    if (!currentUser) {
        window.location.href = 'index.html';
        return;
    }

    setDynamicFavicon();

    const identityEl = document.getElementById('userIdentity');
    if (identityEl) {
        identityEl.innerText = currentUser.UserName;
        identityEl.style.cursor = 'pointer';
        identityEl.onclick = openSettings;
    }

    try {
        // Cache busting the fetches to ensure new CSV data appears immediately
        const cb = `?v=${new Date().getTime()}`;
        const [venues, perfs, journal, users] = await Promise.all([
            parseCSV('data/venues.csv' + cb),
            parseCSV('data/performances.csv' + cb),
            parseCSV(`data/${currentUser.JournalFile}${cb}`),
            parseCSV('data/users.csv' + cb)
        ]);

        venueData = venues;
        performanceData = perfs;
        journalData = journal.sort((a, b) => {
            const dateA = a.Date.split('/').reverse().join('');
            const dateB = b.Date.split('/').reverse().join('');
            return dateB.localeCompare(dateA);
        });

        const fullUser = users.find(u => u.UserID === currentUser.UserID);
        if (fullUser) {
            const rankEl = document.getElementById('stat-rank');
            if (rankEl) rankEl.innerText = fullUser.Rank || 'N/A';
        }

        updateDashboardStats();
        initMap();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.addEventListener('input', refreshUI);

        const card = document.getElementById('now-card');
        if (card) {
            card.addEventListener('click', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                rotateCarousel(x > rect.width / 2 ? 1 : -1);
            });
        }

        refreshUI();

    } catch (error) {
        console.error("Data Load Error:", error);
    }
}

function setDynamicFavicon() {
    const link = document.querySelector("link[rel~='icon']") || document.createElement('link');
    link.rel = 'icon';
    link.href = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎸</text></svg>";
    document.getElementsByTagName('head')[0].appendChild(link);
}

function updateDashboardStats() {
    const now = new Date();
    const dateOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    const dateHeader = document.querySelector('#view-home p.text-slate-400');
    if (dateHeader) dateHeader.innerText = now.toLocaleDateString('en-US', dateOptions);

    const totalGigs = journalData.length;
    const uniqueVenues = new Set(journalData.map(g => g.OfficialVenue)).size;
    const uniqueArtists = new Set(journalData.map(g => g.Band)).size;

    if (document.getElementById('stat-total')) document.getElementById('stat-total').innerText = totalGigs;
    if (document.getElementById('stat-venues')) document.getElementById('stat-venues').innerText = uniqueVenues;
    if (document.getElementById('stat-artists')) document.getElementById('stat-artists').innerText = uniqueArtists;
}

function parseCSV(url) {
    return new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (err) => reject(err)
        });
    });
}

function updateDataCentreStats(filteredData) {
    const elGigs = document.getElementById('dc-stat-gigs');
    const elVenues = document.getElementById('dc-stat-venues');
    const elArtists = document.getElementById('dc-stat-artists');

    if (elGigs) elGigs.innerText = filteredData.length;
    if (elVenues) elVenues.innerText = new Set(filteredData.map(item => item.OfficialVenue)).size;
    if (elArtists) elArtists.innerText = new Set(filteredData.map(item => item.Band)).size;
}

function refreshUI() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

    const filtered = journalData.map(row => {
        const band = (row['Band'] || "").toLowerCase();
        const venue = (row['OfficialVenue'] || "").toLowerCase();
        const lineup = (row['Festival Lineups'] || "").toLowerCase();
        const year = (row['Date'] || "").split('/')[2];
        const journalKey = row['Journal Key'];

        // Logic for specialized matches
        const hasSongMatch = query.length > 2 && performanceData.some(p =>
            p['Journal Key'] === journalKey && (p['Setlist'] || "").toLowerCase().includes(query)
        );
        const isFestivalMatch = query.length > 2 && !band.includes(query) && lineup.includes(query);

        // Visibility Match
        const matchSearch = `${band} ${venue} ${lineup}`.includes(query) || hasSongMatch;
        const matchArtist = !activeArtist || row['Band'] === activeArtist || lineup.includes(activeArtist.toLowerCase());
        const matchYear = !activeYear || year === activeYear;

        // Attach match flags to the object for the renderer
        return { ...row, _isSongMatch: hasSongMatch, _isFestMatch: isFestivalMatch, _visible: matchSearch && matchArtist && matchYear };
    }).filter(r => r._visible);

    updateDataCentreStats(filtered);

    if (document.getElementById('gigTable')) renderTable(filtered, query);
    if (typeof renderCharts === "function") renderCharts(filtered);
    if (window.leafletMap && typeof updateMap === "function") updateMap(filtered, venueData);
    if (typeof window.loadThrowback === "function") window.loadThrowback(journalData);

    if (window.lucide) lucide.createIcons();
}

function renderTable(data, query) {
    const tbody = document.getElementById('gigTable');
    if (!tbody) return;

    tbody.innerHTML = data.map(row => {
        const photos = row.Photos && row.Photos !== "nan" && row.Photos !== "" ?
            `<a href="${row.Photos}" target="_blank" onclick="event.stopPropagation()" aria-label="View photo album">
                <i data-lucide="camera" class="w-4 h-4"></i>
            </a>` : '';

        const safeKey = row['Journal Key'].replace(/'/g, "\\'");

        // Build Badge Labels
        let matchLabels = '';
        if (row._isFestMatch) {
            matchLabels += `<span class="inline-flex items-center gap-1 text-[9px] bg-amber-500/10 text-amber-600 font-black uppercase px-2 py-0.5 rounded-full" role="note" aria-label="Matches festival lineup">
                <i data-lucide="users" class="w-2.5 h-2.5"></i> Lineup Match</span>`;
        }
        if (row._isSongMatch) {
            matchLabels += `<span class="inline-flex items-center gap-1 text-[9px] bg-emerald-500/10 text-emerald-600 font-black uppercase px-2 py-0.5 rounded-full" role="note" aria-label="Matches song in setlist">
                <i data-lucide="music" class="w-2.5 h-2.5"></i> Setlist Match</span>`;
        }

        return `
            <tr class="hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors"
                onclick="openModal('${safeKey}')" role="button" tabindex="0"
                aria-label="View details for ${row.Band} at ${row.OfficialVenue}">
                <td class="px-4 py-4 text-[10px] font-bold text-slate-500 font-mono w-24">${row.Date}</td>
                <td class="px-4 py-4 w-1/2">
                    <div class="font-bold text-slate-700 text-sm">${row.Band}</div>
                    <div class="flex flex-wrap gap-1 mt-1">${matchLabels}</div>
                </td>
                <td class="px-4 py-4 text-xs text-slate-600">${row.OfficialVenue}</td>
                <td class="px-4 py-4 text-center w-12">${photos}</td>
            </tr>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

/**
 * BADGE SYSTEM LOGIC
 */
function renderBadges() {
    const badgeContainer = document.getElementById('badges-grid');
    if (!badgeContainer) return;

    badgeContainer.setAttribute('role', 'region');
    badgeContainer.setAttribute('aria-label', 'Achievement trophies');

    const totalGigs = journalData.length;
    const artistCounts = {};
    const venueCounts = {};

    journalData.forEach(entry => {
        artistCounts[entry.Band] = (artistCounts[entry.Band] || 0) + 1;
        venueCounts[entry.OfficialVenue] = (venueCounts[entry.OfficialVenue] || 0) + 1;
    });

    const maxArtistShows = Math.max(...Object.values(artistCounts), 0);
    const maxVenueVisits = Math.max(...Object.values(venueCounts), 0);
    const uniqueVenues = new Set(journalData.map(j => j.OfficialVenue)).size;

    const badgeDefs = [
        { id: 'first-gig', name: 'The Beginning', desc: 'Attended your first show', icon: 'ticket', earned: totalGigs >= 1 },
        { id: 'fifty-gigs', name: 'Gig Regular', desc: 'Reached 50 lifetime gigs', icon: 'star', earned: totalGigs >= 50 },
        { id: 'century-club', name: 'Century Club', desc: 'Reached 100 lifetime gigs', icon: 'award', earned: totalGigs >= 100 },
        { id: 'superfan', name: 'Superfan', desc: 'Seen the same artist 10+ times', icon: 'heart', earned: maxArtistShows >= 10, sub: `Max: ${maxArtistShows} shows` },
        { id: 'regular', name: 'Home from Home', desc: 'Visited the same venue 5+ times', icon: 'home', earned: maxVenueVisits >= 5, sub: `Max: ${maxVenueVisits} visits` },
        { id: 'explorer', name: 'Venue Explorer', desc: 'Visited 10+ different venues', icon: 'map-pin', earned: uniqueVenues >= 10, sub: `${uniqueVenues} venues found` },
        { id: 'obsessed', name: 'Officially Obsessed', desc: 'Seen the same artist 25+ times', icon: 'crown', earned: maxArtistShows >= 25, sub: maxArtistShows > 0 ? `Max: ${maxArtistShows} shows` : '' },
        { id: 'monthly-resident', name: 'Local Hero', desc: 'Attended a gig in 3 consecutive months', icon: 'calendar-days', earned: checkConsecutiveMonths(journalData) >= 3 },
        {
            id: 'festival-pro',
            name: 'Mud & Music',
            desc: 'Attended 3+ Festivals',
            icon: 'tent',
            earned: journalData.filter(g => {
                const festValue = g['Festival?'] || g['Festival? Y/N'] || "";
                return festValue.trim().toUpperCase() === 'Y';
            }).length >= 3
        }
    ];

    badgeContainer.innerHTML = badgeDefs.map(badge => `
        <div class="relative group p-6 rounded-3xl border-2 transition-all duration-500 ${badge.earned ? 'bg-white border-indigo-100 shadow-xl shadow-indigo-50/50' : 'bg-slate-50/50 border-slate-100 opacity-60'}"
             role="img" aria-label="${badge.earned ? 'Earned' : 'Locked'} Achievement: ${badge.name}. ${badge.desc}">
            <div class="flex flex-col items-center text-center space-y-4" aria-hidden="true">
                <div class="w-16 h-16 rounded-2xl flex items-center justify-center ${badge.earned ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 rotate-3 group-hover:rotate-0' : 'bg-slate-200 text-slate-400'} transition-transform">
                    <i data-lucide="${badge.earned ? badge.icon : 'lock'}" class="w-8 h-8"></i>
                </div>
                <div>
                    <h3 class="font-black text-slate-900 uppercase tracking-tighter">${badge.name}</h3>
                    <p class="text-xs text-slate-500 font-medium leading-tight mt-1">${badge.desc}</p>
                </div>
                ${badge.earned && badge.sub ? `<div class="text-[10px] font-black text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full uppercase">${badge.sub}</div>` : ''}
            </div>
            ${badge.earned ? `<div class="absolute -top-2 -right-2 bg-emerald-500 text-white p-1 rounded-full shadow-lg" aria-hidden="true"><i data-lucide="check" class="w-3 h-3"></i></div>` : ''}
        </div>
    `).join('');

    if (window.lucide) lucide.createIcons();
}

function checkConsecutiveMonths(data) {
    if (!data || data.length === 0) return 0;
    const activeMonths = [...new Set(data.map(g => {
        const parts = g.Date.split('/');
        return `${parts[2]}-${parts[1].padStart(2, '0')}`;
    }))].sort();

    let maxStreak = 0, currentStreak = 0, lastMonth = null;
    activeMonths.forEach(monthStr => {
        const current = new Date(monthStr + "-01");
        if (lastMonth) {
            const diff = (current.getFullYear() - lastMonth.getFullYear()) * 12 + (current.getMonth() - lastMonth.getMonth());
            currentStreak = (diff === 1) ? currentStreak + 1 : 1;
        } else {
            currentStreak = 1;
        }
        lastMonth = current;
        maxStreak = Math.max(maxStreak, currentStreak);
    });
    return maxStreak;
}

function renderCharts(filtered) {
    const yearCanvas = document.getElementById('yearChart');
    if (!yearCanvas) return;

    const allYears = journalData.map(r => r.Date.split('/')[2]).filter(Boolean);
    const minYear = Math.min(...allYears);
    const maxYear = Math.max(...allYears);
    const fullTimelineLabels = [];
    for (let i = minYear; i <= maxYear; i++) { fullTimelineLabels.push(i.toString()); }

    const filteredCounts = {};
    filtered.forEach(r => {
        const y = r.Date.split('/')[2];
        if(y) filteredCounts[y] = (filteredCounts[y] || 0) + 1;
    });

    if (yearChart) yearChart.destroy();
    yearChart = new Chart(yearCanvas, {
        type: 'bar',
        data: {
            labels: fullTimelineLabels,
            datasets: [{
                data: fullTimelineLabels.map(y => filteredCounts[y] || 0),
                backgroundColor: '#4f46e5',
                borderRadius: 4
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { display: false },
                x: { grid: { display: false }, ticks: { font: { size: 8 }, autoSkip: true } }
            },
            onClick: (e, el) => {
                if(el.length) {
                    const selectedYear = fullTimelineLabels[el[0].index];
                    activeYear = (activeYear === selectedYear) ? null : selectedYear;
                    refreshUI();
                }
            }
        }
    });

    const compCanvas = document.getElementById('companionChart');
    if (!compCanvas) return;

    const companions = {};
    filtered.forEach(r => {
        (r['Went With'] || "").split(/[,\/&]/).forEach(n => {
            const name = n.trim();
            if(name && name !== "nan" && name !== "Alone") companions[name] = (companions[name] || 0) + 1;
        });
    });
    const topComps = Object.entries(companions).sort((a,b) => b[1]-a[1]).slice(0, 10);

    if (companionChart) companionChart.destroy();
    companionChart = new Chart(compCanvas, {
        type: 'doughnut',
        data: {
            labels: topComps.map(c => c[0]),
            datasets: [{
                data: topComps.map(c => c[1]),
                backgroundColor: ['#4f46e5', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#06b6d4', '#84cc16', '#ef4444', '#f97316'],
                borderWeight: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            cutout: '70%',
            onClick: (e, activeElements) => {
                if (activeElements.length > 0) {
                    const clickedName = companionChart.data.labels[activeElements[0].index];
                    document.getElementById('searchInput').value = clickedName;
                    refreshUI();
                }
            }
        }
    });
}

window.switchView = function(viewId) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));

	if (viewId === 'home') {
        renderCarouselItem(0); // Always reset to the first card when returning home
    }

    // This creates 'view-achievements', 'view-home', etc.
    const targetView = document.getElementById(`view-${viewId}`);
    if (targetView) targetView.classList.remove('hidden');

    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active', 'text-indigo-600');
        n.classList.add('text-slate-400');
    });

    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) activeNav.classList.add('active', 'text-indigo-600');

    if(viewId === 'map' && window.leafletMap) {
        setTimeout(() => {
            window.leafletMap.invalidateSize();
            window.leafletMap.eachLayer(layer => { if (layer._url) layer.redraw(); });
        }, 400);
    }

    // FIX: viewId is just 'achievements', so check for that
    if (viewId === 'achievements') {
        renderBadges();
    }
};

window.loadThrowback = function(gigs) {
    if (homeCarousel.length > 0) return; // Prevent re-loading on refreshUI

    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    // Anniversary Filter
    const anniversaryGigs = gigs.filter(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        return d === currentDay && m === currentMonth;
    }).sort((a,b) => b.Date.split('/')[2] - a.Date.split('/')[2]);

    // Random Month Filter
    const otherMonthGigs = gigs.filter(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        return m === currentMonth && d !== currentDay;
    }).sort(() => Math.random() - 0.5);

    // Build the 4-item list
    const memories = [...anniversaryGigs, ...otherMonthGigs].slice(0, 3).map(g => {
        const [d, m, y] = g.Date.split('/').map(Number);
        const yearsAgo = today.getFullYear() - y;
        return {
            band: g.Band,
            details: `${g.OfficialVenue} • ${g.Date}`,
            badge: d === currentDay ? `${yearsAgo} Year Anniversary` : `Memory from ${today.toLocaleString('default', { month: 'long' })}`,
            image: `assets/scrapbook/${y}-${m < 10 ? '0'+m : m}-${d < 10 ? '0'+d : d}-${g.OfficialVenue.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')}.jpg`,
            isCTA: false
        };
    });

    memories.push({
        band: "Ready for more?",
        details: "Tap here to delve deeper into the Data Lab.",
        badge: "Next Step",
        image: "https://images.unsplash.com/photo-1514525253361-b83f859b73c0?auto=format&fit=crop&q=80",
        isCTA: true
    });

    homeCarousel = memories;
    renderCarouselItem(0);
};

// --- NEW: Default Image Pool ---
const defaultImages = [
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&q=75&w=800", // Stage Lights
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=75&w=800", // Crowd/Hands
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=75&w=800"  // Deep Atmosphere
];

function renderCarouselItem(index) {
    const card = document.getElementById('now-card');
    if (!card || !homeCarousel[index]) return;

    const item = homeCarousel[index];
    currentCarouselIndex = index;
    const fallbackImage = defaultImages[index % defaultImages.length];

    // 1. HELPER: Force small sizes on Unsplash links
    const getOptimizedUrl = (url) => {
        if (!url) return '';
        if (url.includes('unsplash.com')) {
            const baseUrl = url.split('?')[0];
            return `${baseUrl}?auto=format&fit=crop&w=800&q=75`;
        }
        return url; // Local files remain unchanged as they lack an API
    };

    const displayImage = getOptimizedUrl(item.image);

    // 2. ACCESSIBILITY LABEL
    const a11yLabel = item.isCTA
        ? "Ready for more? Tap right for Data Lab, tap left for previous memory."
        : `${item.badge}: ${item.band}. Tap right for next, left for previous.`;

    // 3. SINGLE RENDER BLOCK
    card.innerHTML = `
        <div class="relative h-full w-full overflow-hidden rounded-[2.5rem] bg-slate-900"
             role="region" aria-label="Gig Memories">

            <img src="${displayImage}"
                 class="absolute inset-0 w-full h-full object-cover shadow-inner"
                 loading="lazy"
                 alt="" aria-hidden="true"
                 onerror="this.src='${fallbackImage}'">

            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-transparent" aria-hidden="true"></div>

            <div class="absolute inset-0 z-20 flex">
                <div onclick="event.stopPropagation(); rotateCarousel(-1)"
                     class="h-full w-1/2 cursor-w-resize"
                     role="button" aria-label="Previous card"></div>

                <div onclick="event.stopPropagation(); rotateCarousel(1)"
                     class="h-full w-1/2 cursor-e-resize"
                     role="button" aria-label="Next card"></div>
            </div>

            <div class="absolute inset-0 z-30 p-8 flex flex-col justify-end pointer-events-none">
                <div class="pointer-events-auto max-w-[80%]">
                    <div onclick="event.stopPropagation(); ${item.isCTA ? "switchView('data')" : "openModalFromCarousel('" + index + "')"}"
                         class="cursor-pointer group"
                         role="button" tabindex="0" aria-label="${a11yLabel}">

                        <span class="inline-block bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-3">
                            ${item.badge}
                        </span>
                        <h3 class="text-3xl font-black text-white italic tracking-tighter leading-none mb-1 group-hover:text-indigo-400 transition-colors">
                            ${item.band}
                        </h3>
                        <p class="text-slate-300 font-bold text-sm">
                            ${item.details}
                        </p>
                    </div>

                    <div class="flex gap-1.5 mt-6">
                        ${homeCarousel.map((_, i) => `
                            <div onclick="event.stopPropagation(); renderCarouselItem(${i})"
                                 class="h-1 rounded-full transition-all duration-300 ${i === index ? 'w-8 bg-indigo-500' : 'w-2 bg-white/30 hover:bg-white/50'}"
                                 role="button" aria-label="Slide ${i + 1}">
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function rotateCarousel(direction) {
    const isLastCard = currentCarouselIndex === homeCarousel.length - 1;

    // 1. Handle Right Click on the last card
    if (isLastCard && direction === 1) {
        switchView('data');
        return;
    }

    // 2. Handle Left Click on the first card (stay on first)
    if (currentCarouselIndex === 0 && direction === -1) {
        return;
    }

    // 3. Normal Step
    const nextIndex = currentCarouselIndex + direction;

    // Safety check to ensure we stay within the 4 cards
    if (nextIndex >= 0 && nextIndex < homeCarousel.length) {
        renderCarouselItem(nextIndex);
    }
}

async function openModal(journalKey) {
    const entry = journalData.find(j => j['Journal Key'] === journalKey);
    const sets = performanceData.filter(p => p['Journal Key'] === journalKey);
    if (!entry) return;

    const dateParts = entry.Date.split('/');
    const formattedDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    const cleanVenue = entry.OfficialVenue
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-') // Replace anything not a letter or number with a dash
        .replace(/-+/g, '-');        // Collapse multiple dashes into one
    const filename = `${formattedDate}-${cleanVenue}.jpg`;
    const imagePath = `assets/scrapbook/${filename}`;

    const companion = entry['Went With'] && entry['Went With'] !== "Alone" ?
        `<span class="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-[10px] font-bold">
            <i data-lucide="users" class="w-3 h-3"></i> ${entry['Went With']}
        </span>` : '';

const comments = entry.Comments && entry.Comments !== "nan" ?
    `<div class="mt-6 p-5 bg-slate-50 rounded-[2rem] border border-slate-100 relative"
          role="complementary"
          aria-label="Gig notes">
        <span class="absolute -top-3 left-6 bg-slate-900 text-[10px] text-white font-black uppercase tracking-widest px-3 py-1 rounded-full underline decoration-indigo-500 underline-offset-2">
            Notes
        </span>
        <p class="text-slate-700 text-sm font-medium leading-normal pt-1">
            ${entry.Comments}
        </p>
    </div>` : '';

    document.getElementById('mTitleArea').innerHTML = `
        <div class="flex flex-wrap items-center gap-3 mb-2">
            <h2 class="text-3xl font-black italic uppercase leading-none">${entry.Band}</h2>
            ${companion}
        </div>
        <p class="text-[10px] font-bold uppercase tracking-widest opacity-80">${entry.Date} • ${entry.OfficialVenue}</p>
        ${comments}
    `;

    const setlistHTML = sets.map(s => `
        <div class="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm mb-4">
            <div class="flex justify-between items-center mb-4 border-b pb-3">
                <div class="font-black text-indigo-600 uppercase text-sm">${s.Artist}</div>
                <span class="text-[8px] font-black px-2 py-1 bg-slate-100 rounded-lg uppercase">${s.Role}</span>
            </div>
            <div class="text-xs text-slate-500 leading-relaxed font-medium">
                ${(s.Setlist && s.Setlist !== 'NOT_FOUND') ? s.Setlist.replace(/\|/g, '<br>') : "Setlist unavailable"}
            </div>
        </div>
    `).join('');

    let imageHTML = '';
    try {
        const check = await fetch(imagePath, { method: 'HEAD' });
        if (check.ok) {
            imageHTML = `
                <div class="flex justify-center items-start">
                    <div class="bg-white p-3 pb-10 shadow-xl border border-slate-200 rotate-[-2deg] max-w-[280px]">
                        <img src="${imagePath}" alt="Memorabilia" class="w-full h-auto">
                        <p class="mt-4 font-handwriting text-slate-400 text-center text-lg" style="font-family: 'Permanent Marker', cursive;">
                            ${entry.Band}
                        </p>
                    </div>
                </div>`;
        }
    } catch (e) {}

    const gridClass = imageHTML ? "grid grid-cols-1 md:grid-cols-[300px_1fr] gap-10" : "grid grid-cols-1 gap-6";

    document.getElementById('mSetlists').innerHTML = `
        <div class="${gridClass}">
            ${imageHTML}
            <div class="space-y-4">
                ${setlistHTML || '<p class="text-center py-10 text-slate-400">No setlist data.</p>'}
            </div>
        </div>
    `;

    document.getElementById('modal').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

window.onload = loadData;

window.openSettings = function() {
    document.getElementById('settingsModal').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
};

window.closeSettings = function() {
    document.getElementById('settingsModal').classList.add('hidden');
};

window.syncComingSoon = function() {
    const id = document.getElementById('setlistIdInput').value;
    if(id) alert(`Syncing for ${id} coming soon! Using the Python bridge for now.`);
};

// Update loadData to make the identity clickable
// Inside loadData()...
const identityEl = document.getElementById('userIdentity');
if (identityEl) {
    identityEl.innerText = currentUser.UserName;
    identityEl.style.cursor = 'pointer';
    identityEl.onclick = openSettings;
}

function checkConsecutiveMonths(data) {
    if (!data || data.length === 0) return 0;

    // Get unique year-month strings (e.g., "2024-05")
    const activeMonths = [...new Set(data.map(g => {
        const parts = g.Date.split('/');
        return `${parts[2]}-${parts[1].padStart(2, '0')}`;
    }))].sort();

    let maxStreak = 0;
    let currentStreak = 0;
    let lastMonth = null;

    activeMonths.forEach(monthStr => {
        const current = new Date(monthStr + "-01");
        if (lastMonth) {
            const diff = (current.getFullYear() - lastMonth.getFullYear()) * 12 + (current.getMonth() - lastMonth.getMonth());
            if (diff === 1) {
                currentStreak++;
            } else {
                currentStreak = 1;
            }
        } else {
            currentStreak = 1;
        }
        lastMonth = current;
        maxStreak = Math.max(maxStreak, currentStreak);
    });

    return maxStreak;
}
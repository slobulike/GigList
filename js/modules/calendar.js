/**
 * CALENDAR MODULE
 * Handles the interactive year/month timeline for the Data view
 */

const getTopStat = (entries, key) => {
    const counts = {};
    entries.forEach(e => {
        const val = e[key];
        if (val && val !== "nan") counts[val] = (counts[val] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
};

export const renderCalendar = (data) => {
    const container = document.getElementById('calendarContainer') || document.getElementById('calendarView');
    if (!container) return;

    // Group data by year then month
    const grouped = data.reduce((acc, gig) => {
        if (!gig.Date) return acc;
        const dateParts = gig.Date.split('/');
        if (dateParts.length < 3) return acc;

        const year  = dateParts[2];
        const month = parseInt(dateParts[1]);
        if (!acc[year])       acc[year] = {};
        if (!acc[year][month]) acc[year][month] = [];
        acc[year][month].push(gig);
        return acc;
    }, {});

    const years      = Object.keys(grouped).sort((a, b) => b - a);
    const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

    container.innerHTML = years.map(year => {
        const allYearGigs = Object.values(grouped[year]).flat();
        const gigCount    = allYearGigs.length;
        const artistCount = new Set(allYearGigs.map(g => g.Band)).size;
        const venueCount  = new Set(allYearGigs.map(g => g.OfficialVenue)).size;

        // Top artist
        const artistFreq = {};
        allYearGigs.forEach(g => { if (g.Band) artistFreq[g.Band] = (artistFreq[g.Band] || 0) + 1; });
        const topEntry       = Object.entries(artistFreq).sort((a, b) => b[1] - a[1])[0];
        const topArtist      = topEntry ? topEntry[0] : null;
        const topArtistCount = topEntry ? topEntry[1] : 0;

        // Busiest month
        const monthFreq = {};
        allYearGigs.forEach(g => {
            if (!g.Date) return;
            const m = parseInt(g.Date.split('/')[1]);
            if (m) monthFreq[m] = (monthFreq[m] || 0) + 1;
        });
        const mn12 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const busiestEntry = Object.entries(monthFreq).sort((a, b) => b[1] - a[1])[0];
        const busiestMonth = busiestEntry ? mn12[parseInt(busiestEntry[0]) - 1] : null;
        const busiestCount = busiestEntry ? busiestEntry[1] : 0;

        // First-timers (bands seen for the first time this year across all history)
        const allHistory = window.journalData || allYearGigs;
        const firstTimerCount = new Set(
            allYearGigs.map(g => g.Band).filter(band => {
                if (!band) return false;
                const firstYear = allHistory
                    .filter(g => g.Band === band && g.Date)
                    .map(g => parseInt(g.Date.split('/')[2]))
                    .filter(y => !isNaN(y))
                    .reduce((min, y) => Math.min(min, y), Infinity);
                return firstYear === parseInt(year);
            })
        ).size;

        // Mini bar chart
        const sortedMonths = Object.entries(monthFreq).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        const maxCount = Math.max(...sortedMonths.map(e => e[1]), 1);
        const barHTML = sortedMonths.map(([m, c]) =>
            `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">` +
            `<span style="font-size:9px;color:rgba(255,255,255,0.5);width:22px;flex-shrink:0;">${mn12[parseInt(m)-1]}</span>` +
            `<div style="flex:1;background:rgba(255,255,255,0.1);border-radius:3px;height:6px;overflow:hidden;">` +
            `<div style="width:${Math.round((c/maxCount)*100)}%;height:100%;background:#6ee7b7;border-radius:3px;"></div></div>` +
            `<span style="font-size:9px;color:white;font-weight:700;width:14px;text-align:right;">${c}</span></div>`
        ).join('');

        return `
        <section class="relative bg-white rounded-[2.5rem] p-8 mb-12 shadow-sm border border-slate-100 min-h-[350px] overflow-hidden"
                 aria-labelledby="year-heading-${year}">

            <div id="calendar-grid-${year}" class="transition-all duration-300 ease-out">
                <div class="flex justify-between items-center mb-8">
                    <h3 id="year-heading-${year}" class="text-5xl font-black text-slate-900 tracking-tighter italic">${year}</h3>
                    <button onclick="window.toggleYearWrapped('${year}')"
                            id="summary-btn-${year}"
                            aria-label="View ${year} summary"
                            class="bg-amber-400 text-[10px] font-black px-5 py-2.5 rounded-full shadow-sm hover:scale-105 transition-all uppercase tracking-widest active:scale-95">
                        ✨ View Summary
                    </button>
                </div>

                <div class="grid grid-cols-3 sm:grid-cols-4 gap-3" role="grid" aria-label="${year} gig calendar">
                    ${monthNames.map((name, index) => {
                        const monthNum  = index + 1;
                        const monthGigs = grouped[year][monthNum] || [];
                        const hasGigs   = monthGigs.length > 0;

                        return `
                        <button onclick="${hasGigs ? `window.showMonthDetail('${year}', '${monthNum}', '${name}')` : ''}"
                                id="month-btn-${year}-${monthNum}"
                                aria-label="${name} ${year}: ${monthGigs.length} gig${monthGigs.length !== 1 ? 's' : ''}"
                                ${!hasGigs ? 'disabled aria-disabled="true"' : ''}
                                class="flex flex-col items-center justify-center h-16 rounded-2xl border transition-all
                                ${hasGigs ? 'bg-indigo-50/50 border-indigo-100 cursor-pointer hover:border-indigo-400 hover:shadow-md active:scale-95' : 'bg-transparent border-slate-50 opacity-10 select-none'}">
                            <span class="text-[10px] font-black ${hasGigs ? 'text-indigo-900' : 'text-slate-400'} uppercase tracking-tighter leading-none mb-1.5">${name}</span>
                            <div class="flex gap-0.5 flex-wrap justify-center px-2 max-w-[40px]" aria-hidden="true">
                                ${monthGigs.slice(0, 4).map(() => `<span class="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-sm"></span>`).join('')}
                                ${monthGigs.length > 4 ? `<span class="text-[7px] font-black text-indigo-400 leading-none">+${monthGigs.length - 4}</span>` : ''}
                            </div>
                        </button>`;
                    }).join('')}
                </div>
            </div>

            <!-- Year Wrapped overlay — richer layout -->
            <div id="year-wrapped-${year}"
                 class="hidden absolute inset-0 bg-indigo-600 text-white p-5 flex flex-col transition-all duration-300 opacity-0 translate-y-4 overflow-y-auto"
                 role="dialog" aria-modal="true" aria-label="${year} Wrapped summary"
                 aria-labelledby="wrapped-title-${year}">

                <div class="flex justify-between items-center mb-3 flex-shrink-0">
                    <div>
                        <p class="text-[9px] font-black text-indigo-300 uppercase tracking-widest">${year}</p>
                        <h3 id="wrapped-title-${year}" class="text-xl font-black italic uppercase tracking-tighter leading-none">Year in Music</h3>
                    </div>
                    <button onclick="window.toggleYearWrapped('${year}')"
                            aria-label="Close ${year} summary"
                            class="bg-white/10 p-2 rounded-xl hover:bg-white/20 transition-colors flex-shrink-0">
                        <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
                    </button>
                </div>

                ${topArtist ? `<div style="background:rgba(255,255,255,0.1);border-radius:16px;padding:14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
                    <div>
                        <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Top artist</p>
                        <p style="font-size:20px;font-weight:900;color:white;line-height:1;letter-spacing:-0.02em;">${topArtist}</p>
                        <p style="font-size:10px;color:rgba(199,210,254,1);font-weight:600;margin-top:3px;">Seen ${topArtistCount} time${topArtistCount !== 1 ? 's' : ''} this year</p>
                    </div>
                    <i data-lucide="user" style="width:20px;height:20px;stroke:rgba(255,255,255,0.4);fill:none;flex-shrink:0;" aria-hidden="true"></i>
                </div>` : ''}

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
                    <div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:10px 12px;">
                        <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Total shows</p>
                        <p style="font-size:22px;font-weight:900;color:white;line-height:1;">${gigCount}</p>
                    </div>
                    <div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:10px 12px;">
                        <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Artists seen</p>
                        <p style="font-size:22px;font-weight:900;color:white;line-height:1;">${artistCount}</p>
                        ${firstTimerCount > 0 ? `<p style="font-size:9px;color:rgba(110,231,183,1);font-weight:700;margin-top:2px;">${firstTimerCount} first-timer${firstTimerCount !== 1 ? 's' : ''}</p>` : ''}
                    </div>
                    <div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:10px 12px;">
                        <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Venues</p>
                        <p style="font-size:22px;font-weight:900;color:white;line-height:1;">${venueCount}</p>
                    </div>
                    ${busiestMonth ? `<div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:10px 12px;">
                        <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Busiest month</p>
                        <p style="font-size:22px;font-weight:900;color:white;line-height:1;">${busiestMonth}</p>
                        <p style="font-size:9px;color:rgba(199,210,254,1);font-weight:600;margin-top:2px;">${busiestCount} show${busiestCount !== 1 ? 's' : ''}</p>
                    </div>` : ''}
                </div>

                ${sortedMonths.length > 0 ? `<div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:10px 12px;">
                    <p style="font-size:8px;color:rgba(165,180,252,1);font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Shows by month</p>
                    ${barHTML}
                </div>` : ''}
            </div>

            <!-- Month detail side panel -->
            <div id="month-side-${year}"
                 class="hidden absolute inset-0 bg-slate-900 text-white p-10 flex flex-col transition-all duration-300 opacity-0 translate-y-4"
                 role="dialog" aria-modal="true" aria-labelledby="month-title-${year}">
                <div class="flex justify-between items-center mb-8">
                    <h3 id="month-title-${year}" class="text-3xl font-black italic uppercase tracking-tighter text-amber-400">Month Details</h3>
                    <button onclick="window.closeMonthDetail('${year}')"
                            id="close-month-${year}"
                            aria-label="Close month detail"
                            class="bg-white/10 p-3 rounded-2xl hover:bg-white/20 transition-colors">
                        <i data-lucide="x" class="w-6 h-6" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="month-list-${year}" class="space-y-4 overflow-y-auto pr-4 custom-scrollbar flex-grow" role="list"></div>
            </div>
        </section>`;
    }).join('');

    if (window.lucide) lucide.createIcons();
};

/* --- INTERACTIVE FUNCTIONS --- */

window.toggleYearWrapped = (year) => {
    const grid    = document.getElementById(`calendar-grid-${year}`);
    const wrapped = document.getElementById(`year-wrapped-${year}`);
    if (!grid || !wrapped) return;

    const isOpening = wrapped.classList.contains('hidden');

    if (isOpening) {
        wrapped.classList.remove('hidden');
        grid.classList.add('opacity-0', '-translate-y-4');

        setTimeout(() => {
            grid.classList.add('hidden');
            wrapped.classList.remove('opacity-0', 'translate-y-4');
            wrapped.classList.add('opacity-100', 'translate-y-0');
            if (window.lucide) lucide.createIcons();
        }, 300);
    } else {
        wrapped.classList.add('opacity-0', 'translate-y-4');
        wrapped.classList.remove('opacity-100', 'translate-y-0');

        setTimeout(() => {
            wrapped.classList.add('hidden');
            grid.classList.remove('hidden');
            setTimeout(() => {
                grid.classList.remove('opacity-0', '-translate-y-4');
            }, 10);
        }, 300);
    }
};

window.showMonthDetail = (year, monthNum, monthName) => {
    // Always use the currently filtered results so the month list
    // matches what the user sees in the table, even if filter returns 0 results.
    const dataSource = window.filteredResults ?? window.journalData;

    const monthGigs = dataSource.filter(e => {
        if (!e.Date) return false;
        const parts = e.Date.split('/');
        if (parts.length !== 3) return false;
        return parts[2] === year && parseInt(parts[1]) === parseInt(monthNum);
    });

    const titleEl = document.getElementById(`month-title-${year}`);
    const listEl  = document.getElementById(`month-list-${year}`);
    if (!titleEl || !listEl) return;

    titleEl.innerText = `${monthName} ${year}`;

    listEl.innerHTML = monthGigs.map(g => {
        // Guard against missing Journal Key to prevent crash
        const safeKey = (g['Journal Key'] || '').replace(/'/g, "\\'");
        return `
            <div onclick="window.openGigModal('${safeKey}')"
                 role="listitem"
                 tabindex="0"
                 onkeydown="if(event.key==='Enter'||event.key===' ')window.openGigModal('${safeKey}')"
                 class="group cursor-pointer border-b border-white/10 pb-4 hover:border-amber-400 transition-all active:scale-95">
                <div class="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-1">${g.Date}</div>
                <div class="text-xl font-bold group-hover:text-amber-200 transition-colors">${g.Band || 'Unknown Artist'}</div>
                <div class="text-xs opacity-50 uppercase tracking-[0.2em] mt-1">${g.OfficialVenue || ''}</div>
            </div>
        `;
    }).join('');

    const grid = document.getElementById(`calendar-grid-${year}`);
    const side = document.getElementById(`month-side-${year}`);
    if (!grid || !side) return;

    grid.classList.add('opacity-0', '-translate-y-4');

    setTimeout(() => {
        grid.classList.add('hidden');
        side.classList.remove('hidden');

        setTimeout(() => {
            // Use explicit add/remove instead of classList.replace() which silently
            // fails if the source class is not present (e.g. on second open)
            side.classList.remove('opacity-0');
            side.classList.add('opacity-100');
            side.classList.remove('translate-y-4');
            document.getElementById(`close-month-${year}`)?.focus();
        }, 50);
    }, 300);
};

window.closeMonthDetail = (year) => {
    const grid = document.getElementById(`calendar-grid-${year}`);
    const side = document.getElementById(`month-side-${year}`);
    if (!grid || !side) return;

    side.classList.remove('opacity-100');
    side.classList.add('opacity-0', 'translate-y-4');

    setTimeout(() => {
        side.classList.add('hidden');
        grid.classList.remove('hidden');
        setTimeout(() => {
            grid.classList.remove('opacity-0', '-translate-y-4');
        }, 50);
    }, 300);
};
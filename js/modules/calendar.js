/**
 * CALENDAR & WRAPPED MODULE
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
    const container = document.getElementById('calendarContainer');
    if (!container) return;

    // 1. Group Data by Year then Month
        const grouped = data.reduce((acc, gig) => {
            const dateParts = gig.Date.split('/');
            if (dateParts.length < 3) return acc; // Skip malformed dates

            const year = dateParts[2];
            const month = parseInt(dateParts[1]);

            if (!acc[year]) acc[year] = {};
            if (!acc[year][month]) acc[year][month] = []; // Fixed path

            acc[year][month].push(gig);
            return acc;
        }, {});

    const years = Object.keys(grouped).sort((a, b) => b - a);
    const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

    container.innerHTML = years.map(year => {
        const allYearGigs = Object.values(grouped[year]).flat();
        const topArtist = getTopStat(allYearGigs, 'Band');
        const topVenue = getTopStat(allYearGigs, 'OfficialVenue');

        return `
        <section class="relative bg-white rounded-[2.5rem] p-8 mb-12 shadow-sm border border-slate-100 min-h-[350px] overflow-hidden"
                 aria-labelledby="year-heading-${year}">

            <div id="calendar-grid-${year}" class="transition-all duration-300 ease-out">
                <div class="flex justify-between items-center mb-8">
                    <h3 id="year-heading-${year}" class="text-5xl font-black text-slate-900 tracking-tighter italic">${year}</h3>
                    <button onclick="window.toggleYearWrapped('${year}')"
                            id="summary-btn-${year}"
                            class="bg-amber-400 text-[10px] font-black px-5 py-2.5 rounded-full shadow-sm hover:scale-105 transition-all uppercase tracking-widest active:scale-95">
                        ✨ View Summary
                    </button>
                </div>

                <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2" role="grid">
                    ${monthNames.map((name, index) => {
                        const monthNum = index + 1;
                        const monthGigs = grouped[year][monthNum] || [];
                        const hasGigs = monthGigs.length > 0;

                        return `
                        <button onclick="${hasGigs ? `window.showMonthDetail('${year}', '${monthNum}', '${name}')` : ''}"
                              id="month-btn-${year}-${monthNum}"
                              aria-label="${name} ${year}: ${monthGigs.length} gigs"
                              ${!hasGigs ? 'disabled' : ''}
                              class="flex flex-col items-center justify-center h-16 rounded-2xl border transition-all
                              ${hasGigs ? 'bg-indigo-50/50 border-indigo-100 cursor-pointer hover:border-indigo-400 hover:shadow-md active:scale-95' : 'bg-transparent border-slate-50 opacity-10 select-none'}">

                              <span class="text-[10px] font-black ${hasGigs ? 'text-indigo-900' : 'text-slate-400'} uppercase tracking-tighter leading-none mb-1.5">${name}</span>

                              <div class="flex gap-0.5 flex-wrap justify-center px-2 max-w-[40px]">
                                ${monthGigs.slice(0, 4).map(() => `<span class="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-sm"></span>`).join('')}
                                ${monthGigs.length > 4 ? `<span class="text-[7px] font-black text-indigo-400 leading-none">+${monthGigs.length - 4}</span>` : ''}
                              </div>
                        </button>`;
                    }).join('')}
                </div>
            </div>

            <div id="year-wrapped-${year}"
                             class="hidden absolute inset-0 bg-indigo-600 text-white p-5 flex flex-col transition-all duration-300 opacity-0 translate-y-4"
                             role="dialog" aria-modal="true">

                            <div class="flex justify-between items-center mb-4">
                                <h3 class="text-xl font-black italic uppercase tracking-tighter">${year} Wrapped</h3>
                                <button onclick="window.toggleYearWrapped('${year}')"
                                        class="bg-white/10 p-2 rounded-xl hover:bg-white/20 transition-colors">
                                    <i data-lucide="x" class="w-4 h-4"></i>
                                </button>
                            </div>

                            <div class="flex flex-col gap-2.5">
                                <div class="bg-white/10 p-4 rounded-[1.5rem] border border-white/10 flex justify-between items-center">
                                    <div>
                                        <p class="text-[9px] font-bold uppercase opacity-60 tracking-widest mb-1">Total Shows</p>
                                        <p class="text-3xl font-black italic leading-none">${allYearGigs.length}</p>
                                    </div>
                                    <div class="opacity-20">
                                        <i data-lucide="ticket" class="w-8 h-8"></i>
                                    </div>
                                </div>

                                <div class="bg-white/10 p-4 rounded-[1.5rem] border border-white/10 flex justify-between items-center">
                                    <div>
                                        <p class="text-[9px] font-bold uppercase opacity-60 tracking-widest mb-1">Total Artists</p>
                                        <p class="text-2xl font-black italic leading-none">${new Set(allYearGigs.map(g => g.Band)).size}</p>
                                    </div>
                                    <div class="opacity-20">
                                        <i data-lucide="mic-2" class="w-7 h-7"></i>
                                    </div>
                                </div>

                                <div class="bg-white/10 p-4 rounded-[1.5rem] border border-white/10 flex justify-between items-center">
                                    <div>
                                        <p class="text-[9px] font-bold uppercase opacity-60 tracking-widest mb-1">Total Venues</p>
                                        <p class="text-2xl font-black italic leading-none">${new Set(allYearGigs.map(g => g.OfficialVenue)).size}</p>
                                    </div>
                                    <div class="opacity-20">
                                        <i data-lucide="map-pin" class="w-7 h-7"></i>
                                    </div>
                                </div>
                            </div>
                        </div>

            <div id="month-side-${year}"
                 class="hidden absolute inset-0 bg-slate-900 text-white p-10 flex flex-col transition-all duration-300 opacity-0 translate-y-4"
                 role="dialog" aria-modal="true" aria-labelledby="month-title-${year}">
                <div class="flex justify-between items-center mb-8">
                    <h3 id="month-title-${year}" class="text-3xl font-black italic uppercase tracking-tighter text-amber-400">Month Details</h3>
                    <button onclick="window.closeMonthDetail('${year}')"
                            id="close-month-${year}"
                            class="bg-white/10 p-3 rounded-2xl hover:bg-white/20 transition-colors">
                        <i data-lucide="x" class="w-6 h-6"></i>
                    </button>
                </div>
                <div id="month-list-${year}" class="space-y-4 overflow-y-auto pr-4 custom-scrollbar flex-grow"></div>
            </div>
        </section>`;
    }).join('');

    if (window.lucide) lucide.createIcons();
};

/* --- INTERACTIVE FUNCTIONS --- */

window.toggleYearWrapped = (year) => {
    const grid = document.getElementById(`calendar-grid-${year}`);
    const wrapped = document.getElementById(`year-wrapped-${year}`);
    if (!grid || !wrapped) return;

    const isOpening = wrapped.classList.contains('hidden');

    if (isOpening) {
        // 1. Prepare 'wrapped' overlay (keep it hidden but ready)
        wrapped.classList.remove('hidden');

        // 2. Animate Grid out
        grid.classList.add('opacity-0', '-translate-y-4');

        // 3. Micro-delay to let the grid fade before showing the wrapped card
        setTimeout(() => {
            grid.classList.add('hidden');
            // Animate wrapped card in
            wrapped.classList.remove('opacity-0', 'translate-y-4');
            wrapped.classList.add('opacity-100', 'translate-y-0');

            if (window.lucide) lucide.createIcons();
        }, 300);
    } else {
        // 1. Animate Wrapped card out
        wrapped.classList.add('opacity-0', 'translate-y-4');
        wrapped.classList.remove('opacity-100', 'translate-y-0');

        // 2. Delay to let fade finish
        setTimeout(() => {
            wrapped.classList.add('hidden');
            grid.classList.remove('hidden');

            // 3. Micro-delay to trigger the grid's entrance animation
            setTimeout(() => {
                grid.classList.remove('opacity-0', '-translate-y-4');
            }, 10);
        }, 300);
    }
};

window.showMonthDetail = (year, monthNum, monthName) => {
    const monthGigs = window.journalData.filter(e => {
        const parts = e.Date.split('/');
        const y = parts.length === 3 ? parts[2] : e.Date.split('-')[0];
        const m = parts.length === 3 ? parseInt(parts[1]) : parseInt(e.Date.split('-')[1]);
        return y === year && m === parseInt(monthNum);
    });

    const titleEl = document.getElementById(`month-title-${year}`);
    const listEl = document.getElementById(`month-list-${year}`);
    if (!titleEl || !listEl) return;

    titleEl.innerText = `${monthName} ${year}`;
    listEl.innerHTML = monthGigs.map(g => {
        // Escape single quotes to prevent JS errors in the onclick attribute
        const safeKey = g['Journal Key'].replace(/'/g, "\\'");

        return `
            <div onclick="window.openGigModal('${safeKey}')"
                 class="group cursor-pointer border-b border-white/10 pb-4 hover:border-amber-400 transition-all active:scale-95">
                <div class="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-1">${g.Date}</div>
                <div class="text-xl font-bold group-hover:text-amber-200 transition-colors">${g.Band}</div>
                <div class="text-xs opacity-50 uppercase tracking-[0.2em] mt-1">${g.OfficialVenue}</div>
            </div>
        `;
    }).join('');

    const grid = document.getElementById(`calendar-grid-${year}`);
    const side = document.getElementById(`month-side-${year}`);

    grid.classList.add('opacity-0', '-translate-y-4');
    setTimeout(() => {
        grid.classList.add('hidden');
        side.classList.remove('hidden');
        setTimeout(() => {
            side.classList.replace('opacity-0', 'opacity-100');
            side.classList.remove('translate-y-4');
            document.getElementById(`close-month-${year}`)?.focus();
        }, 50);
    }, 300);
};

window.closeMonthDetail = (year) => {
    const grid = document.getElementById(`calendar-grid-${year}`);
    const side = document.getElementById(`month-side-${year}`);
    if (!grid || !side) return;

    side.classList.add('opacity-0', 'translate-y-4');
    setTimeout(() => {
        side.classList.add('hidden');
        grid.classList.remove('hidden');
        setTimeout(() => {
            grid.classList.remove('opacity-0', '-translate-y-4');
        }, 50);
    }, 300);
};
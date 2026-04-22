import { parseDate } from './utils.js';

/**
 * Helper to calculate the max streak of consecutive months with a gig
 */
const checkConsecutiveMonths = (data) => {
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
};

/**
 * Standard Badge Renderer (Used by both modes)
 */
const drawBadges = (container, badgeDefs) => {
    container.innerHTML = badgeDefs.map(badge => {
        const progress = badge.goal ? Math.min((badge.current / badge.goal) * 100, 100) : 0;

        const rarityConfig = {
            legendary: {
                border: 'border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.15)] bg-gradient-to-br from-white to-amber-50/50',
                text: 'text-amber-600',
                bg: 'bg-amber-50',
                label: 'Legendary'
            },
            rare: {
                border: 'border-indigo-200 shadow-indigo-50',
                text: 'text-indigo-600',
                bg: 'bg-indigo-50',
                label: 'Rare'
            },
            common: {
                border: 'border-slate-100 shadow-sm',
                text: 'text-slate-400',
                bg: 'bg-slate-50',
                label: 'Common'
            }
        };

        const rarity = rarityConfig[badge.rarity] || rarityConfig.common;
        const currentStyle = badge.earned ? rarity.border : 'bg-slate-50/50 border-slate-100 opacity-70';

        return `
            <div class="relative group p-6 rounded-[2.5rem] border-2 transition-all duration-500 ${currentStyle}">

                <div class="absolute top-5 left-0 right-0 flex justify-center">
                    <span class="text-[7px] font-black uppercase tracking-[0.2em] ${badge.earned ? rarity.text : 'text-slate-300'}">
                        ${badge.earned ? rarity.label : 'Locked'}
                    </span>
                </div>

                <div class="flex flex-col items-center text-center space-y-4 pt-4">
                    <div class="w-16 h-16 rounded-2xl flex items-center justify-center
                        ${badge.earned ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-200 text-slate-400'}
                        ${badge.rarity === 'legendary' && badge.earned ? 'animate-pulse' : ''}
                        transition-transform">
                        <i data-lucide="${badge.earned ? badge.icon : 'lock'}" class="w-8 h-8"></i>
                    </div>

                    <div>
                        <h3 class="font-black text-slate-900 uppercase tracking-tighter italic">${badge.name}</h3>
                        <p class="text-[10px] text-slate-500 font-bold leading-tight mt-1 uppercase">${badge.desc}</p>
                    </div>

                    ${!badge.earned && badge.goal ? `
                    <div class="w-full mt-2">
                        <div class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                            <div class="bg-indigo-400 h-full rounded-full transition-all duration-1000" style="width: ${progress}%"></div>
                        </div>
                        <div class="flex justify-between mt-1 px-1">
                            <span class="text-[8px] font-black text-slate-400 uppercase">${badge.current}</span>
                            <span class="text-[8px] font-black text-slate-400 uppercase">Target: ${badge.goal}</span>
                        </div>
                    </div>
                    ` : ''}

                    ${badge.earned && badge.sub ? `
                    <div class="text-[9px] font-black ${rarity.text} ${rarity.bg} px-3 py-1 rounded-full uppercase tracking-widest border border-current/10">
                        ${badge.sub}
                    </div>` : ''}
                </div>

                ${badge.earned ? `
                    <div class="absolute -top-2 -right-2 ${badge.rarity === 'legendary' ? 'bg-amber-500' : 'bg-emerald-500'} text-white p-1 rounded-full shadow-lg border-2 border-white">
                        <i data-lucide="check" class="w-3 h-3"></i>
                    </div>` : ''}
            </div>
        `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();
};

/**
 * Main Journal Render Function
 */
export const renderBadges = (journalData) => {
    const badgeContainer = document.getElementById('profile-achievements-container');
    if (!badgeContainer) return;

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
    const streakCount = checkConsecutiveMonths(journalData);

    const badgeDefs = [
        {
            id: 'first-gig',
            name: 'The Beginning',
            goal: 1,
            current: totalGigs,
            rarity: 'common',
            desc: 'Attended your first show',
            icon: 'ticket',
            earned: totalGigs >= 1
        },
        {
            id: 'fifty-gigs',
            name: 'Gig Regular',
            goal: 50,
            current: totalGigs,
            rarity: 'rare',
            desc: 'Reached 50 lifetime gigs',
            icon: 'star',
            earned: totalGigs >= 50
        },
        {
            id: 'century-club',
            name: 'Century Club',
            goal: 100,
            current: totalGigs,
            rarity: 'legendary',
            desc: 'Reached 100 lifetime gigs',
            icon: 'award',
            earned: totalGigs >= 100
        },
        {
            id: 'obsessed',
            name: 'Officially Obsessed',
            goal: 25,
            current: maxArtistShows,
            rarity: 'legendary',
            desc: 'Seen the same artist 25+ times',
            icon: 'crown',
            earned: maxArtistShows >= 25
        },
        {
            id: 'superfan',
            name: 'Superfan',
            goal: 10,
            current: maxArtistShows,
            rarity: 'rare',
            desc: 'Seen the same artist 10+ times',
            icon: 'heart',
            earned: maxArtistShows >= 10,
            sub: `Max: ${maxArtistShows} shows`
        },
        {
            id: 'regular',
            name: 'Home from Home',
            goal: 5,
            current: maxVenueVisits,
            rarity: 'common',
            desc: 'Visited the same venue 5+ times',
            icon: 'home',
            earned: maxVenueVisits >= 5,
            sub: `Max: ${maxVenueVisits} visits`
        },
        {
            id: 'explorer',
            name: 'Venue Explorer',
            goal: 10,
            current: uniqueVenues,
            rarity: 'rare',
            desc: 'Visited 10+ different venues',
            icon: 'map-pin',
            earned: uniqueVenues >= 10,
            sub: `${uniqueVenues} venues found`
        },
        {
            id: 'monthly-resident',
            name: 'Local Hero',
            goal: 3,
            current: streakCount,
            rarity: 'rare',
            desc: 'Attended a gig in 3 consecutive months',
            icon: 'calendar-days',
            earned: streakCount >= 3,
            sub: `Streak: ${streakCount}`
        },
        {
            id: 'festival-pro',
            name: 'Mud & Music',
            goal: 3,
            current: journalData.filter(g => g.Festival === true || g['Festival'] === true).length,
            rarity: 'rare',
            desc: 'Attended 3+ Festivals',
            icon: 'tent',
            earned: journalData.filter(g => g.Festival === true || g['Festival'] === true).length >= 3
        }
    ];

    badgeContainer.setAttribute('role', 'region');
    badgeContainer.setAttribute('aria-label', 'Achievement trophies');
    drawBadges(badgeContainer, badgeDefs);
};

/**
 * Band Mode Render Function
 */
export const renderBandBadges = (performanceData) => {
    const badgeContainer = document.getElementById('profile-achievements-container');
    if (!badgeContainer || !performanceData) return;

    // Use window.currentArtist set by app.js — works with both localStorage (Phase 1/2) and Supabase auth (Phase 3)
    const bandName = (window.currentArtist || '').trim();

    if (!bandName) {
        badgeContainer.innerHTML = `<p class="col-span-full text-center py-10 text-slate-400 italic">User context missing.</p>`;
        return;
    }

    const bandData = performanceData.filter(p => (p.Artist || p.Band || "").toLowerCase() === bandName.toLowerCase());

    if (bandData.length === 0) {
        badgeContainer.innerHTML = `<p class="col-span-full text-center py-10 text-slate-400 italic text-xs uppercase tracking-widest">No data for ${bandName}</p>`;
        return;
    }

    const totalShows = bandData.length;
    const venueCounts = {};
    const showsPerYear = {};
    const countriesVisited = new Set();
    const venueLookup = window.allVenues || {};
    let maxSongs = 0;

    const sortedShows = [...bandData].sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));
    const firstShow = sortedShows[0];

    bandData.forEach(perf => {
        const vName = (perf.OfficialVenue || perf.Venue || "").trim() || "Unknown Venue";
        venueCounts[vName] = (venueCounts[vName] || 0) + 1;

        const enriched = venueLookup[vName];
        if (enriched && enriched.country) countriesVisited.add(enriched.country);

        const d = parseDate(perf.Date);
        if (d) {
            const year = d.getFullYear();
            showsPerYear[year] = (showsPerYear[year] || 0) + 1;
        }

        const count = (perf.Setlist || "").split('|').filter(s => s.trim().length > 0).length;
        if (count > maxSongs) maxSongs = count;
    });

    const topVenueEntry = Object.entries(venueCounts).sort((a, b) => b[1] - a[1])[0] || ["Unknown", 0];
    const topVenueName = topVenueEntry[0];
    const maxResidency = topVenueEntry[1];

    const peakYearEntry = Object.entries(showsPerYear).sort((a, b) => b[1] - a[1])[0] || ["N/A", 0];
    const bestYear = peakYearEntry[0];
    const maxYearCount = peakYearEntry[1];

    const uniqueCountriesCount = countriesVisited.size;

    const badgeDefs = [
        {
            id: 'first-show',
            name: 'The Big Bang',
            goal: 1,
            current: 1,
            rarity: 'legendary',
            desc: `First Show: ${firstShow.Date}`,
            icon: 'rocket',
            earned: true,
            sub: firstShow.Venue
        },
        {
            id: 'road-warrior',
            name: 'Road Warrior',
            goal: 100,
            current: totalShows,
            rarity: 'legendary',
            desc: 'Played 100+ lifetime shows',
            icon: 'truck',
            earned: totalShows >= 100,
            sub: `${totalShows} Gigs`
        },
        {
            id: 'marathon-set',
            name: 'Sonic Marathon',
            goal: 25,
            current: maxSongs,
            rarity: 'rare',
            desc: 'Played a 25+ song setlist',
            icon: 'mic-2',
            earned: maxSongs >= 25,
            sub: `Best: ${maxSongs} songs`
        },
        {
            id: 'local-legends',
            name: 'Residency Kings',
            goal: 10,
            current: maxResidency,
            rarity: 'common',
            desc: `Played ${topVenueName} 10+ times`,
            icon: 'building-2',
            earned: maxResidency >= 10,
            sub: `Max: ${maxResidency}`
        },
        {
            id: 'globetrotter',
            name: 'Globetrotter',
            goal: 10,
            current: uniqueCountriesCount,
            rarity: 'legendary',
            desc: 'Performed in 10+ countries',
            icon: 'globe',
            earned: uniqueCountriesCount >= 10,
            sub: `${uniqueCountriesCount} Countries`
        },
        {
            id: 'workhorse',
            name: 'The Workhorse',
            goal: 100,
            current: maxYearCount,
            rarity: 'rare',
            desc: `Most active year: ${bestYear} (${maxYearCount} shows)`,
            icon: 'calendar-days',
            earned: maxYearCount >= 100,
            sub: `${maxYearCount} in ${bestYear}`
        }
    ];

    drawBadges(badgeContainer, badgeDefs);
};
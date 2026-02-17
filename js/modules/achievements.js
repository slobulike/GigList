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
 * Main Render Function
 */
export const renderBadges = (journalData) => {
    const badgeContainer = document.getElementById('badges-grid');
    if (!badgeContainer) return;

    // 1. Calculate Stats
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

    // 2. Define Badges (Easy to add new ones here!)
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
                icon: 'map-pin', earned: uniqueVenues >= 10,
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
                current: journalData.filter(g => {
                                         const festValue = g['Festival?'] || "";
                                         return festValue.trim().toUpperCase().startsWith('Y');
                                         }).length >= 3,
                rarity: 'rare',
                desc: 'Attended 3+ Festivals',
                icon: 'tent',
                earned: journalData.filter(g => {
                const festValue = g['Festival?'] || "";
                return festValue.trim().toUpperCase().startsWith('Y');
                }).length >= 3
            }
    ];

    // 3. Render HTML
    badgeContainer.setAttribute('role', 'region');
    badgeContainer.setAttribute('aria-label', 'Achievement trophies');

badgeContainer.innerHTML = badgeDefs.map(badge => {
    const progress = badge.goal ? Math.min((badge.current / badge.goal) * 100, 100) : 0;

    // Rarity Configuration
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

    if (window.lucide) lucide.createIcons();
};
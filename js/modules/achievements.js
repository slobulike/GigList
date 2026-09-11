import { parseDate, isFestivalRow, getOwnFestivalLineup, normalizeArtist } from './utils.js';

// ─── CONSECUTIVE MONTHS STREAK ────────────────────────────────────────────────

const checkConsecutiveMonths = (data) => {
    if (!data || data.length === 0) return 0;
    const activeMonths = [...new Set(data.map(g => {
        const parts = g.Date.split('/');
        return `${parts[2]}-${parts[1].padStart(2, '0')}`;
    }))].sort();

    let maxStreak = 0, currentStreak = 0, lastMonth = null;
    activeMonths.forEach(monthStr => {
        const current = new Date(monthStr + '-01');
        if (lastMonth) {
            const diff = (current.getFullYear() - lastMonth.getFullYear()) * 12 +
                         (current.getMonth() - lastMonth.getMonth());
            currentStreak = (diff === 1) ? currentStreak + 1 : 1;
        } else {
            currentStreak = 1;
        }
        lastMonth = current;
        maxStreak = Math.max(maxStreak, currentStreak);
    });
    return maxStreak;
};

// ─── FAN TYPE DERIVATION ──────────────────────────────────────────────────────

const FAN_TYPES = {
    lifer:       { label: 'Lifer',       icon: 'ticket',   desc: (data) => `You've been to ${data.totalGigs} shows.` },
    devotee:     { label: 'Devotee',     icon: 'heart',    desc: (data) => `You've seen ${data.topArtist} ${data.maxArtistShows} times.` },
    explorer:    { label: 'Explorer',    icon: 'map-pin',  desc: (data) => `You've visited ${data.uniqueVenues} different venues.` },
    festivarian: { label: 'Festivarian', icon: 'tent',     desc: (data) => `You've been to ${data.festivalCount} festivals.` },
    socialite:   { label: 'Socialite',   icon: 'users',    desc: (data) => `You've been to shows with ${data.uniqueBuddies} different people.` },
    archivist:   { label: 'Archivist',   icon: 'archive',  desc: (data) => `You've collected ${data.collectionCount} items.` },
    streaker:    { label: 'Streaker',    icon: 'zap',      desc: (data) => `Your longest monthly streak is ${data.streakCount} months.` },
};

/**
 * Given the badge definitions grouped by type, derive the user's primary fan type.
 * Returns { type, label, icon, desc } or null if no badges earned at all.
 */
export function deriveFanType(groups, statsData) {
    let best = null;
    let bestScore = -1;

    for (const [typeKey, badges] of Object.entries(groups)) {
        const earned = badges.filter(b => b.earned).length;
        if (earned === 0) continue;
        // Score = earned count + (rarity weight bonus)
        const rarityBonus = badges.filter(b => b.earned).reduce((sum, b) => {
            return sum + (b.rarity === 'legendary' ? 0.6 : b.rarity === 'rare' ? 0.3 : 0.1);
        }, 0);
        const score = earned + rarityBonus;
        if (score > bestScore) {
            bestScore = score;
            best = typeKey;
        }
    }

    if (!best) return null;
    const fanType = FAN_TYPES[best];
    return {
        type:  best,
        label: fanType.label,
        icon:  fanType.icon,
        desc:  fanType.desc(statsData),
    };
}

// ─── BADGE DEFINITIONS ────────────────────────────────────────────────────────

export function buildBadgeDefs(journalData) {
    const totalGigs      = journalData.length;
    const artistCounts   = {};
    const venueCounts    = {};

    journalData.forEach(entry => {
        artistCounts[entry.Band]            = (artistCounts[entry.Band]            || 0) + 1;
        venueCounts[entry.OfficialVenue]    = (venueCounts[entry.OfficialVenue]    || 0) + 1;
    });

    const topArtistEntry  = Object.entries(artistCounts).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
    const topArtist       = topArtistEntry[0];
    const maxArtistShows  = topArtistEntry[1];
    const maxVenueVisits  = Math.max(...Object.values(venueCounts), 0);
    const uniqueVenues    = new Set(journalData.map(j => j.OfficialVenue)).size;
    const streakCount     = checkConsecutiveMonths(journalData);
    const festivalCount   = journalData.filter(g => g['Festival?'] === 'Y' || g.festival === true).length;

    const buddySet = new Set();
    journalData.forEach(entry => {
        const raw = entry.WentWith || entry.went_with || entry['Went With'] || '';
        if (raw && raw !== 'nan' && raw !== 'Alone') {
            raw.split(/[,\/&]/).map(s => s.trim()).filter(Boolean).forEach(n => buddySet.add(n.toLowerCase()));
        }
    });
    const uniqueBuddies   = buddySet.size;
    const collectionCount = window._collectionCount  ?? 0;
    const gigPhotoCount   = window._gigPhotoCount    ?? 0;
    const laminateCount   = window._laminateCount    ?? 0;

    // Stats object passed to fan type desc functions
    const statsData = { totalGigs, topArtist, maxArtistShows, uniqueVenues, festivalCount, uniqueBuddies, collectionCount, streakCount };

    // ── Groups — each is an array of 3 badges (common → rare → legendary) ──

    const groups = {

        lifer: [
            {
                id: 'first-gig', name: 'The Beginning', rarity: 'common',
                desc: 'Attended your first show',
                icon: 'ticket', goal: 1, current: totalGigs,
                earned: totalGigs >= 1,
            },
            {
                id: 'fifty-gigs', name: 'Gig Regular', rarity: 'rare',
                desc: '50 lifetime shows',
                icon: 'star', goal: 50, current: totalGigs,
                earned: totalGigs >= 50,
                sub: `${totalGigs} total`,
            },
            {
                id: 'century-club', name: 'Century Club', rarity: 'legendary',
                desc: '100 lifetime shows',
                icon: 'award', goal: 100, current: totalGigs,
                earned: totalGigs >= 100,
                sub: `${totalGigs} total`,
            },
        ],

        devotee: [
            {
                id: 'regular-fan', name: 'Returning Fan', rarity: 'common',
                desc: 'Seen the same artist 3+ times',
                icon: 'repeat', goal: 3, current: maxArtistShows,
                earned: maxArtistShows >= 3,
                sub: maxArtistShows >= 3 ? `${topArtist} × ${maxArtistShows}` : null,
            },
            {
                id: 'superfan', name: 'Superfan', rarity: 'rare',
                desc: 'Seen the same artist 10+ times',
                icon: 'heart', goal: 10, current: maxArtistShows,
                earned: maxArtistShows >= 10,
                sub: maxArtistShows >= 10 ? `${topArtist} × ${maxArtistShows}` : null,
            },
            {
                id: 'obsessed', name: 'Officially Obsessed', rarity: 'legendary',
                desc: 'Seen the same artist 25+ times',
                icon: 'crown', goal: 25, current: maxArtistShows,
                earned: maxArtistShows >= 25,
                sub: maxArtistShows >= 25 ? `${topArtist} × ${maxArtistShows}` : null,
            },
        ],

        explorer: [
            {
                id: 'regular', name: 'Home from Home', rarity: 'common',
                desc: 'Visited the same venue 5+ times',
                icon: 'home', goal: 5, current: maxVenueVisits,
                earned: maxVenueVisits >= 5,
                sub: maxVenueVisits >= 5 ? `Max: ${maxVenueVisits} visits` : null,
            },
            {
                id: 'explorer', name: 'Venue Explorer', rarity: 'rare',
                desc: 'Visited 10+ different venues',
                icon: 'map-pin', goal: 10, current: uniqueVenues,
                earned: uniqueVenues >= 10,
                sub: uniqueVenues >= 10 ? `${uniqueVenues} venues` : null,
            },
            {
                id: 'nomad', name: 'Nomad', rarity: 'legendary',
                desc: 'Visited 50+ different venues',
                icon: 'compass', goal: 50, current: uniqueVenues,
                earned: uniqueVenues >= 50,
                sub: uniqueVenues >= 50 ? `${uniqueVenues} venues` : null,
            },
        ],

        festivarian: [
            {
                id: 'festival-first', name: 'Festival Curious', rarity: 'common',
                desc: 'Attended your first festival',
                icon: 'sun', goal: 1, current: festivalCount,
                earned: festivalCount >= 1,
            },
            {
                id: 'festival-pro', name: 'Mud & Music', rarity: 'rare',
                desc: 'Attended 3+ festivals',
                icon: 'tent', goal: 3, current: festivalCount,
                earned: festivalCount >= 3,
                sub: festivalCount >= 3 ? `${festivalCount} festivals` : null,
            },
            {
                id: 'festival-lifer', name: 'Festival Lifer', rarity: 'legendary',
                desc: 'Attended 10+ festivals',
                icon: 'flag', goal: 10, current: festivalCount,
                earned: festivalCount >= 10,
                sub: festivalCount >= 10 ? `${festivalCount} festivals` : null,
            },
        ],

        socialite: [
            {
                id: 'first-buddy', name: 'Better Together', rarity: 'common',
                desc: 'Logged your first show with someone',
                icon: 'users', goal: 1, current: uniqueBuddies,
                earned: uniqueBuddies >= 1,
            },
            {
                id: 'crew', name: 'The Crew', rarity: 'rare',
                desc: 'Been to shows with 5+ different people',
                icon: 'users-2', goal: 5, current: uniqueBuddies,
                earned: uniqueBuddies >= 5,
                sub: uniqueBuddies >= 5 ? `${uniqueBuddies} people` : null,
            },
            {
                id: 'ringleader', name: 'Ringleader', rarity: 'legendary',
                desc: 'Been to shows with 15+ different people',
                icon: 'user-check', goal: 15, current: uniqueBuddies,
                earned: uniqueBuddies >= 15,
                sub: uniqueBuddies >= 15 ? `${uniqueBuddies} people` : null,
            },
        ],

        archivist: [
            {
                id: 'collector-first', name: 'First Artefact', rarity: 'common',
                desc: 'Added your first item to the collection',
                icon: 'package', goal: 1, current: collectionCount,
                earned: collectionCount >= 1,
            },
            {
                id: 'collector-ten', name: 'Proper Collector', rarity: 'rare',
                desc: 'Built a collection of 10+ items',
                icon: 'archive', goal: 10, current: collectionCount,
                earned: collectionCount >= 10,
                sub: collectionCount >= 10 ? `${collectionCount} items` : null,
            },
            {
                id: 'collector-twentyfive', name: 'Obsessive Collector', rarity: 'legendary',
                desc: 'Built a collection of 25+ items',
                icon: 'library', goal: 25, current: collectionCount,
                earned: collectionCount >= 25,
                sub: collectionCount >= 25 ? `${collectionCount} items` : null,
            },
            // Bonus archivist badges (don't count toward group scoring)
            {
                id: 'photographer', name: 'Photographer', rarity: 'rare',
                desc: 'Added a photo to a show',
                icon: 'camera', goal: 1, current: gigPhotoCount,
                earned: gigPhotoCount >= 1,
                sub: gigPhotoCount >= 1 ? `${gigPhotoCount} photo${gigPhotoCount === 1 ? '' : 's'}` : null,
                bonus: true,
            },
            {
                id: 'vip', name: 'VIP', rarity: 'legendary',
                desc: 'Added a laminate to the collection',
                icon: 'badge-check', goal: 1, current: laminateCount,
                earned: laminateCount >= 1,
                sub: laminateCount >= 1 ? `${laminateCount} laminate${laminateCount === 1 ? '' : 's'}` : null,
                bonus: true,
            },
        ],

        streaker: [
            {
                id: 'on-a-roll', name: 'On a Roll', rarity: 'common',
                desc: 'Gigs in 3 consecutive months',
                icon: 'flame', goal: 3, current: streakCount,
                earned: streakCount >= 3,
            },
            {
                id: 'unstoppable', name: 'Unstoppable', rarity: 'rare',
                desc: 'Gigs in 6 consecutive months',
                icon: 'zap', goal: 6, current: streakCount,
                earned: streakCount >= 6,
                sub: streakCount >= 6 ? `${streakCount} months` : null,
            },
            {
                id: 'creature-of-habit', name: 'Creature of Habit', rarity: 'legendary',
                desc: 'Gigs in 12 consecutive months',
                icon: 'infinity', goal: 12, current: streakCount,
                earned: streakCount >= 12,
                sub: streakCount >= 12 ? `${streakCount} months` : null,
            },
        ],
    };

    return { groups, statsData };
}

// ─── GROUP METADATA ───────────────────────────────────────────────────────────

const GROUP_META = {
    lifer:       { label: 'Lifer',       subtitle: 'Shows attended'       },
    devotee:     { label: 'Devotee',     subtitle: 'Artist loyalty'       },
    explorer:    { label: 'Explorer',    subtitle: 'Venues & discovery'   },
    festivarian: { label: 'Festivarian', subtitle: 'Festival life'        },
    socialite:   { label: 'Socialite',   subtitle: 'Going with people'    },
    archivist:   { label: 'Archivist',   subtitle: 'Collection & memory'  },
    streaker:    { label: 'Streaker',    subtitle: 'Consistency'          },
};

// ─── BADGE RENDERER ───────────────────────────────────────────────────────────
// Colours match the mockup palette: green=common, indigo=rare, amber=legendary

const RARITY = {
    legendary: {
        card:  'border-amber-300 bg-amber-50',
        icon:  'bg-amber-200',
        glow:  'shadow-[0_0_8px_2px_rgba(239,159,39,0.30)]',
        icolor: 'text-amber-700',
        rlabel: 'text-amber-700',
        name:   'text-amber-900',
        sub:    'text-amber-700',
        check:  'bg-amber-400 text-amber-900',
        dot:    'bg-amber-400',
    },
    rare: {
        card:  'border-indigo-200 bg-indigo-50',
        icon:  'bg-indigo-200',
        glow:  'shadow-[0_0_8px_2px_rgba(127,119,221,0.30)]',
        icolor: 'text-indigo-700',
        rlabel: 'text-indigo-600',
        name:   'text-indigo-900',
        sub:    'text-indigo-600',
        check:  'bg-indigo-500 text-white',
        dot:    'bg-indigo-400',
    },
    common: {
        card:  'border-green-200 bg-green-50',
        icon:  'bg-green-200',
        glow:  '',
        icolor: 'text-green-700',
        rlabel: 'text-green-700',
        name:   'text-green-900',
        sub:    'text-green-700',
        check:  'bg-green-500 text-white',
        dot:    'bg-green-500',
    },
};

function _badgeCard(badge) {
    const r      = RARITY[badge.rarity] || RARITY.common;
    const pct    = badge.goal ? Math.min((badge.current / badge.goal) * 100, 100) : 0;
    const left   = badge.goal ? badge.goal - badge.current : 0;
    const inProg = !badge.earned && badge.goal && badge.current > 0;

    // ── Earned ──────────────────────────────────────────────────────────────
    if (badge.earned) {
        return `
        <div class="relative flex flex-col items-center gap-1.5 p-3 rounded-2xl border ${r.card}">
            <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${r.icon} ${r.glow}">
                <i data-lucide="${badge.icon}" class="w-4 h-4 ${r.icolor}"></i>
            </div>
            <span class="text-[8px] font-black uppercase tracking-widest ${r.rlabel}">${badge.rarity}</span>
            <p class="text-[9px] font-black uppercase tracking-tight ${r.name} text-center leading-tight">${badge.name}</p>
            <p class="text-[8px] text-slate-500 text-center leading-tight">${badge.desc}</p>
            ${badge.sub ? `<p class="text-[8px] font-black ${r.sub}">${badge.sub}</p>` : ''}
            <div class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full ${r.check} flex items-center justify-center border-2 border-white">
                <i data-lucide="check" class="w-2 h-2"></i>
            </div>
        </div>`;
    }

    // ── In progress ─────────────────────────────────────────────────────────
    if (inProg) {
        return `
        <div class="flex flex-col items-center gap-1.5 p-3 rounded-2xl border border-slate-100 bg-slate-50">
            <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-slate-200">
                <i data-lucide="${badge.icon}" class="w-4 h-4 text-slate-400"></i>
            </div>
            <span class="text-[8px] font-black uppercase tracking-widest text-slate-400">${badge.rarity}</span>
            <p class="text-[9px] font-black uppercase tracking-tight text-slate-600 text-center leading-tight">${badge.name}</p>
            <p class="text-[8px] text-slate-400 text-center leading-tight">${badge.desc}</p>
            <div class="w-full bg-slate-200 h-1 rounded-full overflow-hidden mt-0.5">
                <div class="h-full rounded-full bg-indigo-400 transition-all duration-700" style="width:${pct}%"></div>
            </div>
            <p class="text-[8px] font-black text-slate-400">${left} to go</p>
        </div>`;
    }

    // ── Locked ───────────────────────────────────────────────────────────────
    return `
    <div class="flex flex-col items-center gap-1.5 p-3 rounded-2xl border border-slate-100 bg-slate-50 opacity-45">
        <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-slate-100">
            <i data-lucide="lock" class="w-4 h-4 text-slate-300"></i>
        </div>
        <span class="text-[8px] font-black uppercase tracking-widest text-slate-300">${badge.rarity}</span>
        <p class="text-[9px] font-black uppercase tracking-tight text-slate-400 text-center leading-tight">${badge.name}</p>
        <p class="text-[8px] text-slate-300 text-center leading-tight">${badge.desc}</p>
    </div>`;
}

// ─── GROUP ROW RENDERER ───────────────────────────────────────────────────────

function _groupRow(typeKey, badges) {
    const meta        = GROUP_META[typeKey];
    const coreBadges  = badges.filter(b => !b.bonus);
    const bonusBadges = badges.filter(b => b.bonus);
    const earnedCore  = coreBadges.filter(b => b.earned).length;
    const allBadges   = [...coreBadges, ...bonusBadges];

    const dots = coreBadges.map(b => {
        const r = RARITY[b.rarity] || RARITY.common;
        return `<span class="w-2 h-2 rounded-full ${b.earned ? r.dot : 'bg-slate-200'}"></span>`;
    }).join('');

    return `
    <div class="pb-6 mb-6 border-b border-slate-100 last:border-0 last:mb-0 last:pb-0">
        <div class="flex items-center justify-between mb-3">
            <div class="flex items-center justify-between mb-3">
                <span class="text-[11px] font-black uppercase tracking-widest text-slate-800">${meta.label}</span>
                <span class="text-[10px] text-slate-400 font-medium">${meta.subtitle}</span>
            </div>
            <div class="flex items-center gap-1.5">
                ${dots}
                <span class="text-[9px] font-black text-slate-400 ml-0.5">${earnedCore}/${coreBadges.length}</span>
            </div>
        </div>
        <div class="grid grid-cols-3 gap-2">
            ${allBadges.map(b => _badgeCard(b)).join('')}
        </div>
    </div>`;}


// ─── MAIN PERSONAL RENDER (full achievements page) ────────────────────────────

export const renderBadges = (journalData) => {
    const container = document.getElementById('profile-achievements-container');
    if (!container) return;

    const { groups, statsData } = buildBadgeDefs(journalData);

    container.innerHTML = Object.entries(groups)
        .map(([key, badges]) => _groupRow(key, badges))
        .join('');

    if (window.lucide) window.lucide.createIcons();
};

// ─── PROFILE STRIP (compact preview on profile page) ─────────────────────────
// Shows up to 5 earned badges as glowing circles + a "View all" tap target.
// Calls window.openAchievements() which profile.js should wire to switchView.

export const renderBadgeStrip = (journalData) => {
    const container = document.getElementById('profile-badge-strip');
    if (!container) return;

    const { groups } = buildBadgeDefs(journalData);

    const rarityWeight = { legendary: 3, rare: 2, common: 1 };
    const allBadges = Object.values(groups).flat();
    const earned  = allBadges
        .filter(b => b.earned)
        .sort((a, b) => (rarityWeight[b.rarity] || 0) - (rarityWeight[a.rarity] || 0));
    const locked  = allBadges.filter(b => !b.earned);

    const preview     = [...earned.slice(0, 4), ...locked].slice(0, 5);
    const totalEarned = earned.length;
    const totalBadges = allBadges.filter(b => !b.bonus).length;

    const glowClass = { legendary: 'shadow-[0_0_10px_2px_rgba(239,159,39,0.40)]', rare: 'shadow-[0_0_10px_2px_rgba(127,119,221,0.35)]', common: '' };
    const bgClass   = { legendary: 'bg-amber-50 border-amber-300', rare: 'bg-indigo-50 border-indigo-200', common: 'bg-green-50 border-green-200' };
    const icClass   = { legendary: 'text-amber-700', rare: 'text-indigo-700', common: 'text-green-700' };

    const chips = preview.map(b => {
        if (b.earned) {
            return `
            <div class="flex flex-col items-center gap-1.5">
                <div class="w-12 h-12 rounded-full flex items-center justify-center border ${bgClass[b.rarity]} ${glowClass[b.rarity]}">
                    <i data-lucide="${b.icon}" class="w-5 h-5 ${icClass[b.rarity]}"></i>
                </div>
                <span class="text-[8px] font-black text-slate-500 text-center leading-tight max-w-[48px]">${b.name}</span>
            </div>`;
        }
        return `
        <div class="flex flex-col items-center gap-1.5 opacity-35">
            <div class="w-12 h-12 rounded-full flex items-center justify-center border border-slate-200 bg-slate-50">
                <i data-lucide="lock" class="w-5 h-5 text-slate-300"></i>
            </div>
            <span class="text-[8px] font-black text-slate-300 text-center leading-tight max-w-[48px]">${b.name}</span>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="flex items-end justify-between mb-3">
            <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Achievements</span>
            <button onclick="window.openAchievements()"
                    class="text-[10px] font-black text-indigo-500 uppercase tracking-widest hover:text-indigo-700 transition-colors">
                ${totalEarned}/${totalBadges} · View all ›
            </button>
        </div>
        <div class="flex gap-3 justify-between">
            ${chips}
        </div>`;

    if (window.lucide) window.lucide.createIcons();
};

// ─── BAND MODE RENDERER ───────────────────────────────────────────────────────

export const renderBandBadges = (performanceData) => {
    const badgeContainer = document.getElementById('profile-achievements-container');
    if (!badgeContainer || !performanceData) return;

    const bandName = (window.currentArtist || '').trim();

    if (!bandName) {
        badgeContainer.innerHTML = `<p class="text-center py-10 text-slate-400 italic text-xs">User context missing.</p>`;
        return;
    }

    const journalByKey = new Map(
        (window.journalData || []).map(g => [g['Journal Key'] || g['JournalKey'], g])
    );

    const bandData = performanceData.filter(p => {
        if ((p.Artist || p.Band || '').toLowerCase() !== bandName.toLowerCase()) return false;

        // At a festival, performanceData is a pool shared with every other
        // user who logged the same Journal Key — only count this show if
        // this row's own attendee logged seeing the band (see utils.js).
        const row = journalByKey.get(p['Journal Key']);
        if (row && isFestivalRow(row)) {
            const ownLineup = getOwnFestivalLineup(row);
            if (ownLineup.size > 0 && !ownLineup.has(normalizeArtist(bandName))) return false;
        }
        return true;
    });

    if (bandData.length === 0) {
        badgeContainer.innerHTML = `<p class="text-center py-10 text-slate-400 italic text-xs uppercase tracking-widest">No data for ${bandName}</p>`;
        return;
    }

    const totalShows     = bandData.length;
    const venueCounts    = {};
    const showsPerYear   = {};
    const countriesVisited = new Set();
    const venueLookup    = window.allVenues || {};
    let maxSongs         = 0;

    const sortedShows = [...bandData].sort((a, b) => (parseDate(a.Date) || 0) - (parseDate(b.Date) || 0));
    const firstShow   = sortedShows[0];

    bandData.forEach(perf => {
        const vName = (perf.OfficialVenue || perf.Venue || '').trim() || 'Unknown Venue';
        venueCounts[vName] = (venueCounts[vName] || 0) + 1;

        const enriched = venueLookup[vName];
        if (enriched?.country) countriesVisited.add(enriched.country);

        const d = parseDate(perf.Date);
        if (d) {
            const year = d.getFullYear();
            showsPerYear[year] = (showsPerYear[year] || 0) + 1;
        }

        const count = (perf.Setlist || '').split('|').filter(s => s.trim().length > 0).length;
        if (count > maxSongs) maxSongs = count;
    });

    const topVenueEntry    = Object.entries(venueCounts).sort((a, b) => b[1] - a[1])[0] || ['Unknown', 0];
    const topVenueName     = topVenueEntry[0];
    const maxResidency     = topVenueEntry[1];
    const peakYearEntry    = Object.entries(showsPerYear).sort((a, b) => b[1] - a[1])[0] || ['N/A', 0];
    const bestYear         = peakYearEntry[0];
    const maxYearCount     = peakYearEntry[1];
    const uniqueCountries  = countriesVisited.size;

    // Band badges use the original large-card renderer
    const bandBadges = [
        {
            id: 'first-show', name: 'The Big Bang', rarity: 'legendary',
            desc: `First Show: ${firstShow.Date}`, icon: 'rocket',
            goal: 1, current: 1, earned: true, sub: firstShow.Venue,
        },
        {
            id: 'road-warrior', name: 'Road Warrior', rarity: 'legendary',
            desc: 'Played 100+ lifetime shows', icon: 'truck',
            goal: 100, current: totalShows, earned: totalShows >= 100,
            sub: `${totalShows} Gigs`,
        },
        {
            id: 'marathon-set', name: 'Sonic Marathon', rarity: 'rare',
            desc: 'Played a 25+ song setlist', icon: 'mic-2',
            goal: 25, current: maxSongs, earned: maxSongs >= 25,
            sub: `Best: ${maxSongs} songs`,
        },
        {
            id: 'local-legends', name: 'Residency Kings', rarity: 'common',
            desc: `Played ${topVenueName} 10+ times`, icon: 'building-2',
            goal: 10, current: maxResidency, earned: maxResidency >= 10,
            sub: `Max: ${maxResidency}`,
        },
        {
            id: 'globetrotter', name: 'Globetrotter', rarity: 'legendary',
            desc: 'Performed in 10+ countries', icon: 'globe',
            goal: 10, current: uniqueCountries, earned: uniqueCountries >= 10,
            sub: `${uniqueCountries} Countries`,
        },
        {
            id: 'workhorse', name: 'The Workhorse', rarity: 'rare',
            desc: `Most active year: ${bestYear} (${maxYearCount} shows)`, icon: 'calendar-days',
            goal: 100, current: maxYearCount, earned: maxYearCount >= 100,
            sub: `${maxYearCount} in ${bestYear}`,
        },
    ];

    // Reuse large-card renderer for band mode
    _drawBandBadges(badgeContainer, bandBadges);
};

function _drawBandBadges(container, badgeDefs) {
    const rarityConfig = {
        legendary: { border: 'border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.15)] bg-gradient-to-br from-white to-amber-50/50', text: 'text-amber-600', bg: 'bg-amber-50', label: 'Legendary' },
        rare:      { border: 'border-indigo-200 shadow-indigo-50', text: 'text-indigo-600', bg: 'bg-indigo-50', label: 'Rare' },
        common:    { border: 'border-slate-100 shadow-sm', text: 'text-slate-400', bg: 'bg-slate-50', label: 'Common' },
    };

    container.innerHTML = badgeDefs.map(badge => {
        const progress     = badge.goal ? Math.min((badge.current / badge.goal) * 100, 100) : 0;
        const rarity       = rarityConfig[badge.rarity] || rarityConfig.common;
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
                        <div class="bg-indigo-400 h-full rounded-full transition-all duration-1000" style="width:${progress}%"></div>
                    </div>
                    <div class="flex justify-between mt-1 px-1">
                        <span class="text-[8px] font-black text-slate-400 uppercase">${badge.current}</span>
                        <span class="text-[8px] font-black text-slate-400 uppercase">Target: ${badge.goal}</span>
                    </div>
                </div>` : ''}
                ${badge.earned && badge.sub ? `
                <div class="text-[9px] font-black ${rarity.text} ${rarity.bg} px-3 py-1 rounded-full uppercase tracking-widest border border-current/10">
                    ${badge.sub}
                </div>` : ''}
            </div>
            ${badge.earned ? `
            <div class="absolute -top-2 -right-2 ${badge.rarity === 'legendary' ? 'bg-amber-500' : 'bg-emerald-500'} text-white p-1 rounded-full shadow-lg border-2 border-white">
                <i data-lucide="check" class="w-3 h-3"></i>
            </div>` : ''}
        </div>`;
    }).join('');

    if (window.lucide) window.lucide.createIcons();
}
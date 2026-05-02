/**
 * GigList — Band Mode Module
 * band.js
 * -------------------------------------------------------------------
 * Owns all band mode tab behaviour: Shows, Summary, Fans.
 * Imported and called from app.js after data load when isBandMode.
 *
 * Public API (exposed on window):
 *   window.switchBandView(tab)   — switches active band tab
 *   window.bandShowsSearch(val)  — filters the Shows list
 *
 * Data model note:
 *   journals.user_id = null  → imported via band-archive script (setlist.fm)
 *   journals.user_id = <uuid> → logged by a real GigList user
 * This distinction drives the "Shows Archived" vs "Fan Attendance" stats.
 */

import { supabase }             from './supabase.js';
import { parseDate }            from './utils.js';
import * as Charts              from './charts.js';

// ─── Module-level state ───────────────────────────────────────────────────────

let _journalData     = [];   // all shows for this band (archive + user-logged)
let _performanceData = [];
let _currentUser     = null;
let _filteredShows   = [];
let _buddyStatus     = {};   // userId -> 'accepted' | 'pending' | null
let _fanCount          = null;  // unique fans (distinct user_ids), set by _loadBandStats
let _fanAttendance     = null;  // total attended show-instances, set by _loadBandStats
// ─── INIT ─────────────────────────────────────────────────────────────────────

export async function initBandMode(currentUser, journalData, performanceData) {
    _currentUser     = currentUser;
    _journalData     = journalData     || [];
    _performanceData = performanceData || [];
    _filteredShows   = [..._journalData];

    // Expose tab switcher globally (called by band nav onclick in vault.html)
    window.switchBandView  = switchBandView;
    window.bandShowsSearch = bandShowsSearch;

    // Load buddy status for the authed viewer (non-blocking)
    if (_currentUser?.isAuthUser) {
        _loadBuddyStatus().catch(err => console.warn('band.js: buddy status load failed', err));
    }

    // Load band stats for the stat strip (non-blocking)
    _loadBandStats().catch(err => console.warn('band.js: band stats load failed', err));

    // Render hero image on the shows landing tab (non-blocking)
    _renderBandHero().catch(err => console.warn('band.js: hero render failed', err));

    // Show default tab
    switchBandView('shows');
}

// ─── TAB SWITCHER ─────────────────────────────────────────────────────────────

function switchBandView(tab) {
    // Hide all band sections
    document.querySelectorAll('.band-view-section').forEach(s => {
        s.classList.add('hidden');
        s.setAttribute('aria-hidden', 'true');
    });

    // Show target section
    const target = document.getElementById(`view-band-${tab}`);
    if (target) {
        target.classList.remove('hidden');
        target.setAttribute('aria-hidden', 'false');
    }

    // Update band nav active state
    ['shows', 'summary', 'fans'].forEach(t => {
        const btn = document.getElementById(`band-nav-${t}`);
        if (!btn) return;
        if (t === tab) {
            btn.classList.add('active', 'text-[#189BCC]', 'bg-white', 'shadow-sm');
            btn.classList.remove('text-slate-400');
            btn.setAttribute('aria-current', 'page');
        } else {
            btn.classList.remove('active', 'text-[#189BCC]', 'bg-white', 'shadow-sm');
            btn.classList.add('text-slate-400');
            btn.setAttribute('aria-current', 'false');
        }
    });

    // Render the tab content
    if (tab === 'shows')   _renderBandShows();
    if (tab === 'summary') _renderBandStory();
    if (tab === 'fans')    _renderBandFans();

    window.scrollTo(0, 0);
}

// ─── HERO IMAGE ───────────────────────────────────────────────────────────────

async function _renderBandHero() {
    const container = document.getElementById('band-hero');
    if (!container) return;

    const bandName = window.currentArtist;
    if (!bandName) return;

    const slug    = bandName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const initial = bandName.charAt(0).toUpperCase();

    // Supabase public bucket URLs don't reliably 404 on missing objects —
    // use Image() load/error events to test whether a URL resolves as a real image.
    const tryLoad = (url) => new Promise(resolve => {
        const img = new Image();
        img.onload  = () => resolve(url);
        img.onerror = () => resolve(null);
        img.src = url;
    });

    let photoUrl = null;
    for (const ext of ['jpg', 'png', 'webp']) {
        const { data: urlData } = supabase.storage
            .from('band-photos')
            .getPublicUrl(`${slug}/hero.${ext}`);
        if (urlData?.publicUrl) {
            const result = await tryLoad(urlData.publicUrl);
            if (result) { photoUrl = result; break; }
        }
    }

    if (photoUrl) {
        container.innerHTML = `
            <div class="relative w-full h-52 overflow-hidden rounded-3xl shadow-sm">
                <img src="${photoUrl}" alt="${bandName}"
                     class="absolute inset-0 w-full h-full object-cover">
                <div class="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent"></div>
                <div class="absolute bottom-0 left-0 right-0 p-5">
                    <p class="text-white font-black text-2xl leading-tight drop-shadow">${bandName}</p>
                </div>
            </div>`;
    } else {
        // Styled gradient placeholder with large translucent initial
        container.innerHTML = `
            <div class="relative w-full h-36 overflow-hidden rounded-3xl shadow-sm bg-gradient-to-br from-indigo-600 to-[#189BCC]">
                <span class="absolute inset-0 flex items-center justify-center text-white/10 font-black text-[9rem] leading-none select-none pointer-events-none">${initial}</span>
                <div class="absolute bottom-0 left-0 right-0 p-5">
                    <p class="text-white font-black text-2xl leading-tight drop-shadow">${bandName}</p>
                </div>
            </div>`;
    }
}

// ─── SHOWS TAB ────────────────────────────────────────────────────────────────

function bandShowsSearch(val) {
    const q = (val || '').toLowerCase().trim();
    _filteredShows = q
        ? _journalData.filter(g =>
            (g.Date         || '').toLowerCase().includes(q) ||
            (g.OfficialVenue|| '').toLowerCase().includes(q) ||
            (g.Venue        || '').toLowerCase().includes(q) ||
            (g.Type         || '').toLowerCase().includes(q)
          )
        : [..._journalData];
    _renderBandShows();
}

function _renderBandShows() {
    const container = document.getElementById('band-shows-table');
    if (!container) return;

    const data = _filteredShows;

    if (!data.length) {
        container.innerHTML = `
            <div class="text-center py-16 text-slate-400">
                <p class="text-4xl mb-3">🎸</p>
                <p class="font-black text-sm">No shows found</p>
            </div>`;
        return;
    }

    // Sort by date descending (default)
    const sorted = [...data].sort((a, b) => {
        const da = parseDate(a.Date);
        const db = parseDate(b.Date);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db - da;
    });

    const typeColors = {
        'Headline': 'text-indigo-600 bg-indigo-50 border-indigo-100',
        'Festival': 'text-amber-600  bg-amber-50  border-amber-100',
        'Support':  'text-slate-600  bg-slate-50  border-slate-100',
        'TV':       'text-emerald-600 bg-emerald-50 border-emerald-100',
    };

    const rows = sorted.map(g => {
        const typeClass = typeColors[g.Type] || typeColors['Headline'];
        const keyAttr   = g['Journal Key'] ? `data-key="${g['Journal Key']}"` : '';
        // Shows with a real user_id were logged by a GigList user — show a subtle indicator
        const hasUser   = g.user_id && g.user_id !== 'null';
        return `
            <tr class="border-t border-slate-100 hover:bg-indigo-50/30 cursor-pointer transition-colors"
                onclick="window.viewGigDetails('${g['Journal Key']}')"
                ${keyAttr}>
                <td class="p-3 text-[11px] font-bold text-slate-500 whitespace-nowrap">${g.Date || '--'}</td>
                <td class="p-3 text-sm font-bold text-slate-800 truncate max-w-0">
                    <span class="block truncate">${g.OfficialVenue || g.Venue || '--'}</span>
                </td>
                <td class="p-3">
                    <span class="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${typeClass}">
                        ${g.Type || 'Headline'}
                    </span>
                </td>
                <td class="p-3 w-6 text-center">
                    ${hasUser ? `<span title="Attended by a GigList user" class="text-[#189BCC] text-xs">♪</span>` : ''}
                </td>
            </tr>`;
    }).join('');

    // Footer note distinguishing archive vs user-logged
    const userLoggedCount = sorted.filter(g => g.user_id && g.user_id !== 'null').length;
    const footerNote = userLoggedCount > 0
        ? `${sorted.length} show${sorted.length !== 1 ? 's' : ''} · ${userLoggedCount} attended by GigList fans`
        : `${sorted.length} show${sorted.length !== 1 ? 's' : ''}`;

    container.innerHTML = `
        <div class="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
            <table class="w-full text-left table-fixed">
                <thead>
                    <tr class="bg-slate-50/50">
                        <th class="w-24 p-3 text-[10px] font-black uppercase tracking-widest text-slate-400">Date</th>
                        <th class="p-3 text-[10px] font-black uppercase tracking-widest text-slate-400">Venue</th>
                        <th class="w-24 p-3 text-[10px] font-black uppercase tracking-widest text-slate-400">Type</th>
                        <th class="w-6 p-3"></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p class="text-center text-[10px] text-slate-400 font-bold mt-3">${footerNote}</p>`;

    if (window.lucide) lucide.createIcons();
}

// ─── SUMMARY TAB ──────────────────────────────────────────────────────────────

function _renderBandStory() {
    _renderSummaryNarrative();
    _renderStoryStats();
    _renderStoryYearChart();
    _renderStorySongsChart();
}

function _renderSummaryNarrative() {
    const container = document.getElementById('band-summary-narrative');
    if (!container) return;

    const data     = _journalData;
    const bandName = window.currentArtist || 'This band';

    if (!data.length) {
        container.innerHTML = '';
        return;
    }

    // Split archive vs user-logged
    const userLoggedShows = data.filter(g => g.user_id && g.user_id !== 'null');
    const totalShows      = data.length;

    // Unique venues
    const venues     = new Set(data.map(g => g.OfficialVenue || g.Venue).filter(Boolean));
    const venueCount = venues.size;

    // First and most recent show dates
    const dates     = data.map(g => parseDate(g.Date)).filter(Boolean).sort((a, b) => a - b);
    const fmtDate   = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
    const firstDate = fmtDate(dates[0]);
    const lastDate  = fmtDate(dates[dates.length - 1]);

    // Fan count from stat strip if already resolved
    const fanEl    = document.getElementById('stat-rank');
    const fanCount = (fanEl && fanEl.textContent && !isNaN(fanEl.textContent))
        ? parseInt(fanEl.textContent, 10) : null;

    const plural      = totalShows !== 1;
    const venuePhrase = venueCount > 1 ? `, across ${venueCount} venues` : '';
    const fanPhrase   = fanCount   ? ` by ${fanCount} GigList fan${fanCount !== 1 ? 's' : ''}` : '';
    const firstPhrase = firstDate  ? ` First logged show: ${firstDate}.` : '';
    const lastPhrase  = lastDate && lastDate !== firstDate ? ` Most recent: ${lastDate}.` : '';

    const sentence = `${bandName} ${plural ? 'have' : 'has'} ${totalShows} show${plural ? 's' : ''} archived on GigList${venuePhrase}. ${userLoggedShows.length} ${userLoggedShows.length === 1 ? 'has' : 'have'} been attended${fanPhrase}.${firstPhrase}${lastPhrase}`;

    container.innerHTML = `<p class="text-sm font-bold text-slate-600 leading-relaxed">${sentence}</p>`;
}

function _renderStoryStats() {
    const container = document.getElementById('band-story-stats');
    if (!container) return;

    const data = _journalData;
    if (!data.length) {
        container.innerHTML = `<p class="col-span-2 text-sm text-slate-400 text-center py-8">No data yet.</p>`;
        return;
    }

    // Fan count from stat strip
    const fanEl    = document.getElementById('stat-rank');
    const fanCount = (fanEl && fanEl.textContent && !isNaN(fanEl.textContent))
        ? parseInt(fanEl.textContent, 10) : null;

    // Years active
    const years = data.map(g => {
        const parts = (g.Date || '').split('/');
        return parts.length === 3 ? parseInt(parts[2], 10) : null;
    }).filter(Boolean);

    const minYear    = Math.min(...years);
    const maxYear    = Math.max(...years);
    const yearsSpan  = maxYear - minYear;
    const yearsLabel = minYear === maxYear ? `${minYear}` : `${minYear} – ${maxYear}`;

    // Peak year
    const yearCounts = {};
    years.forEach(y => { yearCounts[y] = (yearCounts[y] || 0) + 1; });
    const peakYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0];

    // Most-played venue
    const venueCounts = {};
    data.forEach(g => {
        const v = g.OfficialVenue || g.Venue;
        if (v) venueCounts[v] = (venueCounts[v] || 0) + 1;
    });
    const topVenue = Object.entries(venueCounts).sort((a, b) => b[1] - a[1])[0];

    // Longest gap between shows
    const dates = data
        .map(g => parseDate(g.Date))
        .filter(Boolean)
        .sort((a, b) => a - b);

    let longestGapDays  = 0;
    let longestGapLabel = '--';
    for (let i = 1; i < dates.length; i++) {
        const diff = Math.round((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
        if (diff > longestGapDays) {
            longestGapDays  = diff;
            const y1 = dates[i - 1].getFullYear();
            const y2 = dates[i].getFullYear();
            longestGapLabel = y1 === y2 ? `${y1}` : `${y1}–${y2}`;
        }
    }

    const cards = [
        {
            label: 'Shows Archived',
            value: data.length,
            sub:   'total on GigList',
        },
        {
            label: 'Fan Attendance',
            value: _fanAttendance ?? '--',
            sub:   (_fanAttendance != null && data.length > 0)
                       ? `${Math.round((_fanAttendance / data.length) * 100)}% of archived shows`
                       : 'loading…',
        },
        {
            label: 'GigList Fans',
            value: fanCount ?? '--',
            sub:   fanCount != null ? `fan${fanCount !== 1 ? 's' : ''} logged shows` : 'loading…',
        },
        {
            label: 'Active Since',
            value: yearsLabel,
            sub:   yearsSpan > 0 ? `${yearsSpan} year${yearsSpan !== 1 ? 's' : ''} of history` : 'First year on record',
        },
        {
            label: 'Peak Year',
            value: peakYear ? peakYear[0] : '--',
            sub:   peakYear ? `${peakYear[1]} show${peakYear[1] !== 1 ? 's' : ''}` : '',
        },
        {
            label: 'Top Venue',
            value: topVenue ? topVenue[1] : '--',
            sub:   topVenue ? _truncate(topVenue[0], 22) : '',
        },
        {
            label: 'Longest Gap',
            value: longestGapDays > 0 ? `${longestGapDays}d` : '--',
            sub:   longestGapDays > 0 ? longestGapLabel : '',
        },
    ];

    container.innerHTML = cards.map(c => `
        <div class="bg-white p-4 rounded-[1.5rem] border border-slate-100 shadow-sm text-center">
            <p class="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1">${c.label}</p>
            <p class="text-xl font-black text-indigo-700 leading-none">${c.value}</p>
            ${c.sub ? `<p class="text-[9px] text-slate-400 font-bold mt-1 leading-snug">${c.sub}</p>` : ''}
        </div>`).join('');
}

function _renderStoryYearChart() {
    const data = _journalData;
    if (!data.length) return;
    try {
        Charts.renderYearChart(data, 'band-story-year-chart');
    } catch (e) {
        console.warn('band.js: year chart render failed', e);
    }
}

function _renderStorySongsChart() {
    const wrap = document.getElementById('band-story-songs-wrap');
    if (!wrap) return;

    if (_performanceData && _performanceData.length) {
        wrap.classList.remove('hidden');
        try {
            Charts.renderTopSongsChart(_journalData, 'band-story-songs-chart');
        } catch (e) {
            console.warn('band.js: songs chart render failed', e);
            wrap.classList.add('hidden');
        }
    } else {
        wrap.classList.add('hidden');
    }
}

// ─── RLS NOTE — band mode queries ────────────────────────────────────────────
// Direct Supabase queries from the browser run as the authenticated user and
// are subject to RLS. The journals and profiles tables have user-scoped RLS
// policies, so a plain .from('journals') in band mode only returns rows the
// current viewer is permitted to see — not all fans of the band.
//
// Any band mode query that needs a cross-user view (fan lists, attendance
// counts, profile lookups by id) MUST go through a SECURITY DEFINER RPC
// function in Supabase, which runs as the function owner and bypasses RLS.
//
// Current RPCs:
//   get_band_fans(band_name)       → journals rows for a band, all users
//   get_profiles_by_ids(user_ids)  → public profile fields for an id array
//
// Do NOT replace these with direct table queries, even if they look simpler.
// ─────────────────────────────────────────────────────────────────────────────

// ─── FANS TAB ─────────────────────────────────────────────────────────────────

async function _renderBandFans() {
    const container = document.getElementById('band-fans-list');
    if (!container) return;

    const loadingEl = document.getElementById('band-fans-loading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
        const bandName = window.currentArtist;

        // Fetch all journal rows for this band that have a real user_id.
        // Rows with null user_id are band-archive imports (setlist.fm), not user accounts.
        const { data: fanRows, error: fanErr } = await supabase
            .rpc('get_band_fans', { band_name: bandName });

        if (fanErr) throw fanErr;
        if (!fanRows || !fanRows.length) {
            _renderFansEmpty(container);
            return;
        }

        // Aggregate show counts + earliest show per user
        const countMap     = {};
        const firstShowMap = {};

        fanRows.forEach(r => {
            if (!r.user_id || r.user_id === 'null') return;
            countMap[r.user_id] = (countMap[r.user_id] || 0) + 1;
            const d = parseDate(r.date);
            if (d && (!firstShowMap[r.user_id] || d < firstShowMap[r.user_id])) {
                firstShowMap[r.user_id] = d;
            }
        });

        const userIds = Object.keys(countMap);
        if (!userIds.length) {
            _renderFansEmpty(container);
            return;
        }

        // Fetch profiles.
        // Username is not a private fact — users are findable by username to send buddy
        // requests — so profiles should be publicly readable. If RLS is restricting rows,
        // the console log below will show the mismatch so it can be diagnosed in Supabase.
        const { data: profileRows, error: profileErr } = await supabase
            .rpc('get_profiles_by_ids', { user_ids: userIds });

        if (profileErr) {
            console.error('band.js: profiles query error', profileErr);
        }

        console.log(
            `band.js fans: ${userIds.length} user IDs from journals, ` +
            `${(profileRows || []).length} profiles returned by query. ` +
            `Missing: ${userIds.length - (profileRows || []).length}`
        );

        // Build a lookup of whatever came back
        const profileMap = {};
        (profileRows || []).forEach(p => { profileMap[p.id] = p; });

        // Ensure buddy status is ready before building CTAs
        if (_currentUser?.isAuthUser) {
            await _loadBuddyStatus();
        }

        // Build fan list. Any uid whose profile was RLS-filtered gets a stub entry
        // so they still appear as a tile rather than being silently dropped.
        const fans = userIds.map(uid => {
            const p = profileMap[uid] || { id: uid, display_name: null, username: null, avatar_url: null };
            return {
                ...p,
                showCount: countMap[uid] || 0,
                firstShow: firstShowMap[uid] || null,
            };
        });

        // Sort: buddies first, then show count desc, then earliest fan on tie
        fans.sort((a, b) => {
            const aIsBuddy = _buddyStatus[a.id] === 'accepted' ? 0 : 1;
            const bIsBuddy = _buddyStatus[b.id] === 'accepted' ? 0 : 1;
            if (aIsBuddy !== bIsBuddy) return aIsBuddy - bIsBuddy;
            if (b.showCount !== a.showCount) return b.showCount - a.showCount;
            if (a.firstShow && b.firstShow) return a.firstShow - b.firstShow;
            return 0;
        });

        if (loadingEl) loadingEl.classList.add('hidden');
        container.innerHTML = fans.map(fan => _fanTileHTML(fan)).join('');

        if (window.lucide) lucide.createIcons();

    } catch (err) {
        console.error('band.js: _renderBandFans error', err);
        if (loadingEl) loadingEl.classList.add('hidden');
        container.innerHTML = `
            <div class="text-center py-10 text-slate-400">
                <p class="text-sm font-bold">Couldn't load fans — try refreshing.</p>
            </div>`;
    }
}

function _fanTileHTML(fan) {
    const viewerId    = _currentUser?.id;
    const isViewer    = fan.id === viewerId;
    // display_name/username may be null if the profile row was RLS-filtered
    const displayName = fan.display_name || fan.username || null;
    const label       = displayName || 'GigList Fan';
    const initials    = displayName ? displayName.slice(0, 2).toUpperCase() : '♪';

    const avatarHTML = fan.avatar_url
        ? `<img src="${fan.avatar_url}" alt="" class="w-12 h-12 rounded-full object-cover ring-2 ring-white flex-shrink-0">`
        : `<div class="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-black flex-shrink-0">${initials}</div>`;

    const firstShowYear  = fan.firstShow ? fan.firstShow.getFullYear() : null;
    const firstShowLabel = firstShowYear ? `Fan since ${firstShowYear}` : '';

    const ctaHTML = _buddyCTA(fan.id, isViewer, label);

    return `
        <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm p-4 flex items-center gap-4">
            ${avatarHTML}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-black text-slate-900 truncate">${label}</p>
                <p class="text-[10px] font-bold text-slate-400 mt-0.5">
                    ${fan.showCount} show${fan.showCount !== 1 ? 's' : ''}
                    ${firstShowLabel ? ` · ${firstShowLabel}` : ''}
                </p>
            </div>
            <div class="flex-shrink-0">${ctaHTML}</div>
        </div>`;
}

function _buddyCTA(userId, isViewer, displayName) {
    if (isViewer) {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">You</span>`;
    }

    if (!_currentUser?.isAuthUser) {
        return `<a href="index.html"
                   class="text-[9px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700 transition-colors">
                    Sign in
                </a>`;
    }

    const status = _buddyStatus[userId];

    if (status === 'accepted') {
        return `<span class="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-600">
                    <i data-lucide="check" class="w-3 h-3"></i> Buddies
                </span>`;
    }

    if (status === 'pending') {
        return `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Requested</span>`;
    }

    // No relationship — show Connect button
    return `<button
                onclick="window._sendBandBuddyRequest('${userId}', '${displayName.replace(/'/g, "\\'")}', this)"
                class="text-[9px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 active:scale-95 transition-all px-3 py-1.5 rounded-full">
                Connect
            </button>`;
}

function _renderFansEmpty(container) {
    const loadingEl = document.getElementById('band-fans-loading');
    if (loadingEl) loadingEl.classList.add('hidden');

    const isAuthed = _currentUser?.isAuthUser;
    container.innerHTML = `
        <div class="text-center py-16 space-y-3">
            <p class="text-4xl">🎸</p>
            <p class="text-sm font-black text-slate-700">No GigList fans yet</p>
            <p class="text-[11px] text-slate-400">Be the first to log a show!</p>
            ${!isAuthed ? `<a href="index.html"
                              class="inline-block mt-2 text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 px-5 py-2.5 rounded-full transition-all">
                                Sign In / Sign Up
                            </a>` : ''}
        </div>`;
}

// ─── BUDDY REQUEST (band mode) ────────────────────────────────────────────────

window._sendBandBuddyRequest = async (addresseeId, displayName, btn) => {
    if (!_currentUser?.isAuthUser) return;

    const requesterId = _currentUser.id;
    if (requesterId === addresseeId) return;

    btn.disabled    = true;
    btn.textContent = '...';

    try {
        const { error } = await supabase
            .from('buddies')
            .insert({ requester_id: requesterId, addressee_id: addresseeId, status: 'pending' });

        if (error) throw error;

        _buddyStatus[addresseeId] = 'pending';
        btn.outerHTML = `<span class="text-[9px] font-black uppercase tracking-widest text-slate-400">Requested</span>`;

        window.showToast?.(`Buddy request sent to ${displayName}!`, 'success');
    } catch (err) {
        console.error('band.js: buddy request failed', err);
        btn.disabled    = false;
        btn.textContent = 'Connect';
        window.showToast?.('Request failed — try again', 'error');
    }
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function _loadBandStats() {
    const bandName = window.currentArtist;
    if (!bandName) return;

    const { data: rows } = await supabase
        .rpc('get_band_fans', { band_name: bandName });

    if (!rows) return;

    const fanIds       = new Set(rows.map(r => r.user_id).filter(id => id && id !== 'null'));
    _fanCount          = fanIds.size;
    _fanAttendance     = rows.filter(r => r.user_id && r.user_id !== 'null').length;

    const rankEl  = document.getElementById('stat-rank');
    const labelEl = document.getElementById('stat-fourth-label');
    if (rankEl)  rankEl.textContent  = _fanCount;
    if (labelEl) labelEl.textContent = 'Fans';
}

async function _loadBuddyStatus() {
    const id = _currentUser?.id;
    if (!id || id === 'null' || id === 'undefined') return;

    const { data: rows } = await supabase
        .from('buddies')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${id},addressee_id.eq.${id}`);

    _buddyStatus = {};
    (rows || []).forEach(b => {
        const otherId = b.requester_id === id ? b.addressee_id : b.requester_id;
        _buddyStatus[otherId] = b.status;
    });
}

function _truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}
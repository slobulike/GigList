// ─────────────────────────────────────────────────────────────────────────────
// tip-nudges.js
// Layer C — Feed Cards, Nudge Triggers & Home Explore Card
//
// Exports:
//   buildTipDiscoveryCards()  — returns tip_discovery feed card objects
//   checkNudgeTrigger(event)  — call on user actions to queue feed cards
//   initExploreCard(containerEl, accountCreatedAt) — home screen rotating card
//   dismissExploreCard()      — called on explicit ✕ tap
// ─────────────────────────────────────────────────────────────────────────────

import {
    TIPS,
    hasSeen,
    markSeen,
    getSeenCount,
    getNudgeTipsForEvent,
    getFeaturedUnseen,
} from './tips-registry.js';
import { parseDate } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// localStorage key for queued nudge tip IDs (survives page reload)
const NUDGE_QUEUE_KEY   = (uid) => `gl_tip_nudge_queue_${uid}`;
// localStorage key for permanently dismissed explore card
const EXPLORE_DISMISS_KEY = (uid) => `gl_tip_explore_dismissed_${uid}`;

// ─── Nudge queue helpers ──────────────────────────────────────────────────────

function _getUserId() {
    return window.currentUser?.id || null;
}

function _getNudgeQueue() {
    const uid = _getUserId();
    if (!uid) return [];
    try {
        return JSON.parse(localStorage.getItem(NUDGE_QUEUE_KEY(uid)) || '[]');
    } catch { return []; }
}

function _setNudgeQueue(ids) {
    const uid = _getUserId();
    if (!uid) return;
    localStorage.setItem(NUDGE_QUEUE_KEY(uid), JSON.stringify(ids));
}

/**
 * Queue tip IDs for the next feed render.
 * Only queues tips the user hasn't seen yet, and avoids duplicates.
 */
function _enqueueTips(tipIds) {
    const current = new Set(_getNudgeQueue());
    let changed   = false;
    for (const id of tipIds) {
        if (!hasSeen(id) && !current.has(id)) {
            current.add(id);
            changed = true;
        }
    }
    if (changed) _setNudgeQueue([...current]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger system
// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkNudgeTrigger(triggerEvent)
 *
 * Call this from app.js / wherever the triggering action occurs.
 * Queues matching unseen tips into localStorage for the next feed render.
 *
 * Usage:
 *   import { checkNudgeTrigger } from './tip-nudges.js';
 *
 *   // After saving a gig:
 *   if (journalData.length === 1) checkNudgeTrigger('first_gig_saved');
 *   if (journalData.length === 5) checkNudgeTrigger('fifth_gig_saved');
 *
 *   // After adding a collection item:
 *   checkNudgeTrigger('collection_item_added');
 *
 *   // After detecting user has 3+ shows for an artist:
 *   checkNudgeTrigger('same_artist_3x');
 *
 *   // After achievement progress check shows user within 5 of next badge:
 *   checkNudgeTrigger('achievement_close');
 */
export function checkNudgeTrigger(triggerEvent) {
    const tips = getNudgeTipsForEvent(triggerEvent);
    if (tips.length) _enqueueTips(tips.map(t => t.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed card builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildTipDiscoveryCards()
 *
 * Returns an array of tip_discovery card objects ready to inject into
 * the feed pipeline. Drains the nudge queue — each tip fires at most
 * once as a feed card.
 *
 * Cards have score: 70 so they appear after pinned content (score >= 90)
 * but above most rotatable cards.
 *
 * Call from feed.js init(), after selectCards() and before rendering.
 */
export function buildTipDiscoveryCards() {
    const queued = _getNudgeQueue();
    if (!queued.length) return [];

    const cards = [];
    const consumed = [];

    for (const tipId of queued) {
        const tip = TIPS.find(t => t.id === tipId);
        if (!tip || hasSeen(tipId) || !tip.nudgeTitle) continue;

        cards.push({
            type:       'tip_discovery',
            score:      70,
            journalKey: `tip_discovery_${tipId}`,
            tipId,
            headline:   tip.nudgeTitle,
            subline:    tip.nudgeBody || '',
            eyebrow:    'Discover GigList',
            badge:      'Feature Tip',
            badgeColor: 'bg-indigo-500',
            deepLink:   tip.hubDeepLink || 'vault.html#profile',
        });
        consumed.push(tipId);
    }

    // Remove consumed tip IDs from the queue
    const remaining = queued.filter(id => !consumed.includes(id));
    _setNudgeQueue(remaining);

    return cards;
}

// ─────────────────────────────────────────────────────────────────────────────
// tip_discovery card renderer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * renderTipDiscoveryCard(card)
 *
 * Returns the HTML string for a tip_discovery feed card.
 * Import and call from feed.js renderCard() when card.type === 'tip_discovery'.
 *
 * Both CTAs permanently mark the tip as seen.
 */
export function renderTipDiscoveryCard(card) {
    const tipId   = card.tipId;
    const safeId  = tipId.replace(/[^a-z0-9]/gi, '_');
    const deepLink = card.deepLink || 'vault.html#profile';

    return `
        <div class="relative overflow-hidden rounded-[2rem] bg-slate-900 shadow-xl flex flex-col"
             role="article"
             data-card-type="tip_discovery"
             id="tip-discovery-card-${safeId}">

            <!-- Indigo gradient background — no hero image needed -->
            <div class="absolute inset-0 bg-gradient-to-br from-indigo-900 via-indigo-800 to-slate-900"></div>
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/60 to-transparent"></div>

            <!-- Accent stripe -->
            <div class="absolute top-0 inset-x-0 h-1 bg-indigo-400 opacity-70"></div>

            <!-- Content -->
            <div class="relative z-10 flex flex-col p-6 gap-3">

                <!-- Eyebrow -->
                <span class="text-[9px] font-black uppercase tracking-widest text-indigo-300">
                    ✦ Discover GigList
                </span>

                <!-- Title + body -->
                <div>
                    <h3 class="text-2xl font-black italic uppercase tracking-tighter text-white leading-none mb-2">
                        ${card.headline}
                    </h3>
                    <p class="text-sm text-white/70 leading-relaxed">${card.subline}</p>
                </div>

                <!-- CTAs -->
                <div class="flex items-center gap-3 mt-1 flex-wrap">
                    <button onclick="window._tipDiscoveryTry('${tipId}', '${deepLink}')"
                            class="flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 text-white text-[11px] font-black uppercase tracking-widest px-4 py-2 rounded-full transition-colors">
                        Try it
                        <i data-lucide="arrow-right" class="w-3 h-3" aria-hidden="true"></i>
                    </button>
                    <button onclick="window._tipDiscoverySeeAll('${tipId}')"
                            class="text-[11px] font-black text-white/50 hover:text-white uppercase tracking-widest transition-colors flex items-center gap-1">
                        See all tips in Profile
                        <i data-lucide="chevron-right" class="w-3 h-3" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        </div>`;
}

// Global handlers called by the card buttons
window._tipDiscoveryTry = (tipId, deepLink) => {
    markSeen(tipId);
    document.getElementById(`tip-discovery-card-${tipId.replace(/[^a-z0-9]/gi, '_')}`)?.remove();
    // Navigate using the same deep-link router as the hub
    if (window._navigateTipLink) {
        window._navigateTipLink(deepLink);
    } else {
        window.location.href = deepLink;
    }
};

window._tipDiscoverySeeAll = (tipId) => {
    markSeen(tipId);
    document.getElementById(`tip-discovery-card-${tipId.replace(/[^a-z0-9]/gi, '_')}`)?.remove();
    // Open the tips hub drawer on the profile screen
    window.switchView?.('profile');
    setTimeout(() => window.openTipsHub?.(), 150);
};

// ─────────────────────────────────────────────────────────────────────────────
// Home screen explore card (Section 5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initExploreCard(containerEl, accountCreatedAt)
 *
 * Renders a single rotating featured tip card into containerEl.
 * Call from home screen init, after the show carousel.
 *
 * Conditions to show:
 *   - Account < 30 days old, OR seen count < 5
 *   - Card not permanently dismissed
 *   - At least one featured unseen tip exists
 *
 * @param {HTMLElement} containerEl     — element to render into (cleared first)
 * @param {string}      accountCreatedAt — DD/MM/YYYY profile created_at
 */
export function initExploreCard(containerEl, accountCreatedAt) {
    if (!containerEl) return;

    const uid = _getUserId();
    if (!uid) return;

    // Check permanent dismiss
    if (localStorage.getItem(EXPLORE_DISMISS_KEY(uid)) === 'true') {
        containerEl.innerHTML = '';
        return;
    }

    // Check conditions: account age OR seen count
    const shouldShow = (() => {
        if (getSeenCount() < 5) return true;
        if (!accountCreatedAt) return false;
        const created = parseDate(accountCreatedAt);
        if (!created) return false;
        const ageMs = Date.now() - created.getTime();
        return ageMs < 30 * 24 * 60 * 60 * 1000;
    })();

    if (!shouldShow) {
        containerEl.innerHTML = '';
        return;
    }

    // Pick today's featured tip (seeded by date so it's stable all day)
    const featured = getFeaturedUnseen();
    if (!featured.length) {
        containerEl.innerHTML = '';
        return;
    }

    const seed = todaySeed();
    const tip  = featured[seed % featured.length];

    containerEl.innerHTML = _renderExploreCard(tip);
    if (window.lucide) lucide.createIcons({ scope: containerEl });
}

/**
 * dismissExploreCard()
 * Call on explicit ✕ tap. Permanently hides for this user.
 */
export function dismissExploreCard() {
    const uid = _getUserId();
    if (uid) localStorage.setItem(EXPLORE_DISMISS_KEY(uid), 'true');
    document.getElementById('tip-explore-card')?.remove();
}

function _renderExploreCard(tip) {
    return `
        <div id="tip-explore-card"
             class="relative mx-4 mb-4 rounded-[1.5rem] bg-white border border-slate-100 shadow-sm overflow-hidden">

            <!-- Dismiss button — explicit tap only -->
            <button onclick="window._tipExploreDismiss()"
                    class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors z-10"
                    aria-label="Dismiss tip">
                <i data-lucide="x" class="w-3.5 h-3.5 text-slate-500" aria-hidden="true"></i>
            </button>

            <div class="p-4 pr-10">
                <!-- Eyebrow -->
                <p class="text-[9px] font-black uppercase tracking-widest text-indigo-500 mb-1.5">
                    ✦ Discover GigList
                </p>

                <!-- Title -->
                <p class="text-sm font-black text-slate-800 leading-snug mb-1">
                    ${tip.hubTitle}
                </p>

                <!-- Body -->
                <p class="text-xs text-slate-500 leading-relaxed mb-3">
                    ${tip.hubBody}
                </p>

                <!-- CTAs -->
                <div class="flex items-center gap-3">
                    ${tip.hubCta ? `
                    <button onclick="window._tipExploreTry('${tip.id}', '${tip.hubDeepLink}')"
                            class="text-[11px] font-black text-indigo-600 flex items-center gap-1 hover:opacity-70 transition-opacity">
                        ${tip.hubCta}
                        <i data-lucide="arrow-right" class="w-3 h-3" aria-hidden="true"></i>
                    </button>` : ''}
                    <button onclick="window._tipExploreSeeAll()"
                            class="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors">
                        See all tips in your Profile →
                    </button>
                </div>
            </div>
        </div>`;
}

window._tipExploreDismiss = () => dismissExploreCard();

window._tipExploreTry = (tipId, deepLink) => {
    markSeen(tipId);
    dismissExploreCard();
    if (window._navigateTipLink) {
        window._navigateTipLink(deepLink);
    } else {
        window.location.href = deepLink;
    }
};

window._tipExploreSeeAll = () => {
    window.switchView?.('profile');
    setTimeout(() => window.openTipsHub?.(), 150);
};

// ─── Seed helper (mirrors feed.js todaySeed) ─────────────────────────────────
function todaySeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty-state tip grid
// ─────────────────────────────────────────────────────────────────────────────

/**
 * renderEmptyStateTips(tipIds, max)
 *
 * Returns an HTML string showing up to `max` unseen tips from the given ID list.
 * Designed to be injected via innerHTML into empty-state screens (Gigs, Feed,
 * Collection). Returns empty string if all specified tips have been seen, or if
 * the tips registry hasn't initialised yet.
 *
 * @param {string[]} tipIds  — ordered tip IDs to try, in priority order
 * @param {number}   max     — max tips to show (default 3)
 * @returns {string}
 */
export function renderEmptyStateTips(tipIds, max = 3) {
    const allTips  = window.__TIPS__;
    const seenFn   = window.__hasSeen__;
    if (!allTips || !seenFn) return ''; // registry not yet ready

    const tips = allTips
        .filter(t => tipIds.includes(t.id) && !seenFn(t.id))
        .sort((a, b) => tipIds.indexOf(a.id) - tipIds.indexOf(b.id))
        .slice(0, max);

    if (!tips.length) return '';

    const rows = tips.map(t => `
        <div class="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
            <div class="w-7 h-7 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                <i data-lucide="sparkles" class="w-3.5 h-3.5 text-indigo-400" aria-hidden="true"></i>
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-[12px] font-black text-slate-700 leading-snug">${t.hubTitle}</p>
                <p class="text-[11px] text-slate-400 leading-relaxed mt-0.5">${t.hubBody}</p>
            </div>
        </div>`).join('');

    return `
        <div class="mt-8 mx-auto max-w-sm px-2">
            <p class="text-[9px] font-black uppercase tracking-widest text-indigo-400 mb-3 text-center">
                ✦ Discover GigList
            </p>
            <div class="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm px-4 py-1">
                ${rows}
            </div>
            <button onclick="window.switchView('profile'); setTimeout(() => window.openTipsHub?.(), 150)"
                    class="mt-3 w-full text-[11px] font-black text-indigo-400 hover:text-indigo-600 transition-colors text-center block">
                See all tips in your Profile →
            </button>
        </div>`;
}
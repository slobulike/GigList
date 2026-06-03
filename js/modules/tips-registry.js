// ─────────────────────────────────────────────────────────────────────────────
// tips-registry.js
// Single source of truth for all GigList feature tips.
//
// ADDING A TIP:   add one object to the TIPS array below.
// ADDING A GROUP: add one object to TIP_GROUPS below.
// No other file needs to change.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "./supabase.js";

// ─── 2.3  Hub Groups ─────────────────────────────────────────────────────────
// Ordered array — display order in Hub matches array order.

export const TIP_GROUPS = [
  { id: "your_shows",   label: "Your Shows",   emoji: "🎤" },
  { id: "your_history", label: "Your History", emoji: "📊" },
  { id: "your_feed",    label: "Your Feed",    emoji: "✨" },
  { id: "achievements", label: "Achievements", emoji: "🏆" },
  { id: "buddies",      label: "Buddies",      emoji: "👥" },
  { id: "collection",   label: "Collection",   emoji: "📀" },
  { id: "band_pages",   label: "Band Pages",   emoji: "🔍" },
  // ↑ Insert new groups here — order controls Hub display order.
];

// ─── 2.1  Tip Schema ──────────────────────────────────────────────────────────
// Required fields:  id, group, hubTitle, hubBody
// Optional fields:  hubCta, hubDeepLink, modalTip, modalButton,
//                   nudgeTitle, nudgeBody, nudgeTrigger, featured, addedVersion
//
// id          — stable unique key. NEVER rename after release.
// group       — must match a TIP_GROUPS id.
// addedVersion— used for "New" badging. Bump when you ship the tip.

export const TIPS = [

  // ── Your Shows ──────────────────────────────────────────────────────────────
  {
    id:           "share_show",
    group:        "your_shows",
    hubTitle:     "Share a show",
    hubBody:      "Every gig has a public page — tap Share on any show to copy a link or post it.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html",
    modalTip:     "Did you know you can share this show? Anyone with the link can see the public page — no account needed.",
    modalButton:  "share",
    nudgeTitle:   "Share your first show",
    nudgeBody:    "Tap Share on any gig to get a public link you can send to friends.",
    nudgeTrigger: "first_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "gig_photo",
    group:        "your_shows",
    hubTitle:     "Add a photo to a gig",
    hubBody:      "Drop a photo onto any show to make it feel like a real memory, not just a date.",
    hubCta:       "Open editor →",
    hubDeepLink:  "vault.html",
    modalTip:     "Add a photo to really bring this show to life — it'll appear on your public share page too.",
    modalButton:  "edit",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "went_with",
    group:        "your_shows",
    hubTitle:     "Tag who you went with",
    hubBody:      "Add companions to a gig — if they're on GigList too, it shows up as a shared memory for both of you.",
    hubCta:       "Edit a show →",
    hubDeepLink:  "vault.html",
    modalTip:     "Tag who came with you — if they're a GigList buddy, this show will appear in both your histories.",
    modalButton:  "edit",
    nudgeTitle:   "Who did you go with?",
    nudgeBody:    "Tag a companion on your latest gig to start building shared memories.",
    nudgeTrigger: "first_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "setlist",
    group:        "your_shows",
    hubTitle:     "View the setlist",
    hubBody:      "GigList pulls setlists from setlist.fm — tap Setlist on any show to relive every song.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html",
    modalTip:     "Tap Setlist to see every song played at this show, pulled live from setlist.fm.",
    modalButton:  "setlist",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Your History ────────────────────────────────────────────────────────────
  {
    id:           "map_view",
    group:        "your_history",
    hubTitle:     "See your gig map",
    hubBody:      "Every venue you've visited is pinned on a map — switch to Map view in your History tab.",
    hubCta:       "Go to History →",
    hubDeepLink:  "vault.html#data",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "filters",
    group:        "your_history",
    hubTitle:     "Filter your history",
    hubBody:      "Slice your gig history by year, venue, genre, companion, and more — tap the filter icon in History.",
    hubCta:       "Go to History →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "stats_chart",
    group:        "your_history",
    hubTitle:     "Explore your stats",
    hubBody:      "See your busiest years, top venues, and favourite artists charted over time.",
    hubCta:       "Go to History →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Your Feed ───────────────────────────────────────────────────────────────
  {
    id:           "on_this_day",
    group:        "your_feed",
    hubTitle:     "On This Day",
    hubBody:      "Your Feed surfaces shows you attended on today's date in past years — scroll down to find yours.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "feed_card_share",
    group:        "your_feed",
    hubTitle:     "Share a Feed card",
    hubBody:      "Tap the share icon on any Feed card to post it — great for anniversary moments.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    nudgeTitle:   "Share this memory",
    nudgeBody:    "Tap the share icon on a Feed card to post your gig anniversary.",
    nudgeTrigger: "on_this_day_shown",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Achievements ────────────────────────────────────────────────────────────
  {
    id:           "badges_overview",
    group:        "achievements",
    hubTitle:     "Earn badges",
    hubBody:      "GigList has 21 badges across 6 groups — from Common to Legendary. Check your progress on your Profile.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "legendary_badge",
    group:        "achievements",
    hubTitle:     "Legendary badges",
    hubBody:      "Three Legendary badges exist — they require serious commitment. Think decades, not months.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Buddies ──────────────────────────────────────────────────────────────────
  {
    id:           "buddy_request",
    group:        "buddies",
    hubTitle:     "Add a buddy",
    hubBody:      "Connect with friends on GigList to see shared gigs and get notified when you've been to the same show.",
    hubCta:       "Go to Buddies →",
    hubDeepLink:  "vault.html#social",
    nudgeTitle:   "Know someone on GigList?",
    nudgeBody:    "Add them as a buddy to discover shows you both attended.",
    nudgeTrigger: "first_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "buddy_feed_cards",
    group:        "buddies",
    hubTitle:     "Buddy cards in your Feed",
    hubBody:      "When a buddy logs a show you also attended, a shared memory card appears in your Feed.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "companion_match",
    group:        "buddies",
    hubTitle:     "Companion matching",
    hubBody:      "Tag a buddy as a companion on a gig and it shows up in both your histories as a shared moment.",
    hubCta:       "Edit a show →",
    hubDeepLink:  "vault.html",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Collection ──────────────────────────────────────────────────────────────
  {
    id:           "collection_add",
    group:        "collection",
    hubTitle:     "Log merch & records",
    hubBody:      "The Collection tab is for vinyl, merch, and memorabilia — anything tied to your live music life.",
    hubCta:       "Go to Collection →",
    hubDeepLink:  "vault.html#collection",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "collection_link_gig",
    group:        "collection",
    hubTitle:     "Link a collection item to a gig",
    hubBody:      "Bought a t-shirt at a show? Link the collection item to that gig for full context.",
    hubCta:       "Go to Collection →",
    hubDeepLink:  "vault.html#collection",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Band Pages ───────────────────────────────────────────────────────────────
  {
    id:           "band_page",
    group:        "band_pages",
    hubTitle:     "Explore a band page",
    hubBody:      "Every artist on GigList has a public page showing all logged shows, top fans, and tour history.",
    hubCta:       "Search an artist →",
    hubDeepLink:  "vault.html",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "band_fans_tab",
    group:        "band_pages",
    hubTitle:     "See who else has seen them",
    hubBody:      "The Fans tab on any band page shows every GigList user who's logged a show — you might spot a friend.",
    hubCta:       "Search an artist →",
    hubDeepLink:  "vault.html",
    featured:     false,
    addedVersion: "1.0",
  },

  // ↑ Add new tips above this line. Keep grouped by TIP_GROUPS id for readability.
];

// ─────────────────────────────────────────────────────────────────────────────
// 2.2  Seen State — Two-tier sync
// ─────────────────────────────────────────────────────────────────────────────

// localStorage key scoped to userId so multi-account devices work correctly.
const _lsKey = (userId) => `gl_tips_seen_${userId}`;

let _userId = null; // set by initTips()

/** Call once on app init, before any hasSeen / markSeen calls. */
export function initTips(userId) {
  _userId = userId;
}

// ── Raw localStorage accessors ───────────────────────────────────────────────

function _getLocalSeen() {
  if (!_userId) return [];
  try {
    return JSON.parse(localStorage.getItem(_lsKey(_userId)) || "[]");
  } catch {
    return [];
  }
}

function _setLocalSeen(ids) {
  if (!_userId) return;
  localStorage.setItem(_lsKey(_userId), JSON.stringify(ids));
}

// ── Public state helpers ─────────────────────────────────────────────────────

/** Returns true if the user has seen this tip. Sync — reads localStorage only. */
export function hasSeen(tipId) {
  return _getLocalSeen().includes(tipId);
}

/** Number of tips the user has seen. */
export function getSeenCount() {
  return _getLocalSeen().length;
}

/** Total number of tips in the registry. */
export function getTotalCount() {
  return TIPS.length;
}

/**
 * Mark a tip as seen.
 * — Writes to localStorage immediately (instant UI update).
 * — Fire-and-forgets an RPC to Supabase (cross-device sync, silent fail).
 */
export function markSeen(tipId) {
  const seen = _getLocalSeen();
  if (seen.includes(tipId)) return;
  seen.push(tipId);
  _setLocalSeen(seen);

  // Background sync — never blocks the UI
  supabase
    .rpc("append_tip_seen", { tip_id: tipId })
    .catch(() => {}); // local state preserved on failure
}

/**
 * Sync seen state from Supabase into localStorage.
 * Call once on login / app init, after initTips(userId).
 *
 * Strategy: merge remote + local (union), store in localStorage.
 * No write-back needed — markSeen() handles future individual syncs.
 */
export async function syncSeenState() {
  if (!_userId) return;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("tips_seen")
      .eq("id", _userId)
      .single();

    if (error || !data) return;

    const remote = Array.isArray(data.tips_seen) ? data.tips_seen : [];
    const local  = _getLocalSeen();
    const merged = [...new Set([...remote, ...local])];
    _setLocalSeen(merged);
  } catch {
    // Network failure — local state stands, re-syncs next session
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers — consumed by Hub, feed cards, modals, push system
// ─────────────────────────────────────────────────────────────────────────────

/** All tips: unseen first (in registry order), then seen. */
export function getTipsOrdered() {
  const seen    = new Set(_getLocalSeen());
  const unseen  = TIPS.filter((t) => !seen.has(t.id));
  const seenArr = TIPS.filter((t) =>  seen.has(t.id));
  return [...unseen, ...seenArr];
}

/** Tips for a specific group, unseen first. */
export function getTipsByGroup(groupId) {
  return getTipsOrdered().filter((t) => t.group === groupId);
}

/** Tips eligible for the Explore card rotation: featured + unseen. */
export function getFeaturedUnseen() {
  return TIPS.filter((t) => t.featured && !hasSeen(t.id));
}

/**
 * Find the modal tip for a given button trigger.
 * Returns the first unseen tip whose modalButton matches, or null.
 * Used by the gig modal to decide whether to show an inline tip.
 */
export function getModalTip(buttonId) {
  return (
    TIPS.find((t) => t.modalButton === buttonId && t.modalTip && !hasSeen(t.id)) ?? null
  );
}

/**
 * All unseen tips whose nudgeTrigger matches the given event.
 * Used by the push / feed nudge system to know which tips to surface.
 */
export function getNudgeTipsForEvent(triggerEvent) {
  return TIPS.filter(
    (t) => t.nudgeTrigger === triggerEvent && t.nudgeTitle && !hasSeen(t.id)
  );
}

/**
 * Hub progress rings: groupId → { total, seen }
 */
export function getGroupProgress() {
  const seen = new Set(_getLocalSeen());
  const progress = {};
  for (const group of TIP_GROUPS) {
    const groupTips = TIPS.filter((t) => t.group === group.id);
    progress[group.id] = {
      total: groupTips.length,
      seen:  groupTips.filter((t) => seen.has(t.id)).length,
    };
  }
  return progress;
}
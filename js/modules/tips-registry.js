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
// Optional fields:  hubCta, hubDeepLink, modalTip, modalButton, context,
//                   nudgeTitle, nudgeBody, nudgeTrigger, featured, addedVersion
//
// id          — stable unique key. NEVER rename after release.
// group       — must match a TIP_GROUPS id.
// context     — "past" | "future" — when set on a modal tip, restricts it to
//               gigs that are past or upcoming respectively. Omit for tips that
//               apply regardless of date (e.g. share, companion tag, setlist).
// addedVersion— used for "New" badging. Bump when you ship the tip.

export const TIPS = [

  // ── Your Shows 🎤 ────────────────────────────────────────────────────────────
  {
    id:           "share_show",
    group:        "your_shows",
    hubTitle:     "Share a show",
    hubBody:      "Every show has a public page anyone can view — even without a GigList account. Tap Share on any gig modal to copy a link or send it directly.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Did you know you can share this show? Anyone with the link can see the public page — no account needed.",
    modalButton:  "share",
    nudgeTitle:   "Share your first show",
    nudgeBody:    "Tap Share on any gig to get a public link you can send to friends.",
    nudgeTrigger: "first_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "playlist_relive",
    group:        "your_shows",
    hubTitle:     "Relive any show with a playlist",
    hubBody:      "Tap 'Relive' on a gig modal to open or generate a Spotify playlist built from that night's setlist. A permanent memento for any show in your history.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tap Relive to generate a Spotify playlist built from that night's setlist — a permanent memento of the show.",
    modalButton:  "playlist",
    context:      "past",   // only show in modals for past gigs
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "playlist_preshow",
    group:        "your_shows",
    hubTitle:     "Get ready for a show — pre-show playlist",
    hubBody:      "Got an upcoming gig? Tap 'Get Ready' before the show to build a playlist of songs likely to be played. Go in knowing every word.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tap Get Ready to build a playlist of songs likely to be played — go in knowing every word.",
    modalButton:  "playlist",
    context:      "future", // only show in modals for upcoming gigs
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "companion_tag",
    group:        "your_shows",
    hubTitle:     "Tag the people you were with",
    hubBody:      "Tap the companions area on any gig modal to tag your GigList buddies. They'll be notified, and the show will appear in both of your histories.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tag who came with you — if they're a GigList buddy, this show will appear in both your histories and they'll get a notification.",
    modalButton:  "edit",
    nudgeTitle:   "Tag who you went with",
    nudgeBody:    "Tap Edit on any gig to tag companions — buddies will be notified and see the show in their history too.",
    nudgeTrigger: "first_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "watch_clips",
    group:        "your_shows",
    hubTitle:     "Watch clips from the night",
    hubBody:     "Tap 'Watch Clips' on any gig modal to find YouTube footage from that show or the same tour. Sometimes someone filmed exactly the moment you remember.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tap Watch Clips to find YouTube footage from this show or the same tour. Someone may have filmed exactly the moment you remember.",
    modalButton:  "watch_clips",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "add_photos",
    group:        "your_shows",
    hubTitle:     "Add photos to any show",
    hubBody:      "Tap the camera icon on a gig modal to add your favourite photo. You can add more photos by linking to an external photo album when editing a gig.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "photo_album_link",
    group:        "your_shows",
    hubTitle:     "Link a photo album — one tap to open",
    hubBody:      "Add a Google Photos, iCloud, or any album URL to a show and it appears as a tap-to-open icon on the gig modal. Your whole album, always one tap away.",
    hubCta:       "Edit a show →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "setlistfm_link",
    group:        "your_shows",
    hubTitle:     "Full setlists from Setlist.fm",
    hubBody:     "Tap 'Setlist.fm' on any gig modal to see the complete set — every song, support acts included. GigList pulls this automatically for most shows.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tap Setlist.fm to see every song played at this show, including support acts — pulled automatically for most shows.",
    modalButton:  "setlist",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "request_band_page",
    group:        "your_shows",
    hubTitle:     "Request a Band Page",
    hubBody:     "Tap 'Request Band Page' on any gig modal to nominate that artist for a dedicated GigList page — full show history, stats, and a list of fellow fans. You'll get a push notification when it goes live.",
    hubCta:       "Open a show →",
    hubDeepLink:  "vault.html#data",
    modalTip:     "Tap Request Band Page to nominate this artist for a dedicated GigList page — you'll be notified when it goes live.",
    modalButton:  "request_band_page",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "collection_setlist_sync",
    group:        "collection",
    hubTitle:     "Sync with Setlist.fm",
    hubBody:      "Enter your Setlist.fm username in Profile settings to pull in your full gig history, complete with venues and setlists, in one go.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },
  // ── Your History 📊 ──────────────────────────────────────────────────────────
  {
    id:           "map_view",
    group:        "your_history",
    hubTitle:     "See all your shows on a map",
    hubBody:      "Go to Gigs → Map to see every venue you've attended plotted on a map, with bubble size showing how many times you've been. Your gigging life, at a glance.",
    hubCta:       "Go to Gigs →",
    hubDeepLink:  "vault.html#data",
    nudgeTitle:   "Your shows on a map",
    nudgeBody:    "Switch to Map view in the Gigs tab to see every venue you've attended plotted — bubble size shows how many times you've been.",
    nudgeTrigger: "fifth_gig_saved",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "companion_donut",
    group:        "your_history",
    hubTitle:     "Who do you go to gigs with?",
    hubBody:      "The donut chart at the top of the Gigs screen shows your companion breakdown — who you've attended the most shows with, colour-coded.",
    hubCta:       "Go to Gigs →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "yearly_stats",
    group:        "your_history",
    hubTitle:     "Your year in numbers — Calendar view",
    hubBody:      "Switch to the Calendar tab on the Gigs screen to see this year's stats: total shows, busiest month, first-timers, and a shows-by-month breakdown.",
    hubCta:       "Go to Gigs →",
    hubDeepLink:  "vault.html#data",
    nudgeTitle:   "Your year in numbers",
    nudgeBody:    "Switch to Calendar view in Gigs to see your shows-by-month breakdown, busiest month, and first-timers.",
    nudgeTrigger: "fifth_gig_saved",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "top_bands_chart",
    group:        "your_history",
    hubTitle:     "Your most-seen artists",
    hubBody:      "Scroll down the Gigs screen to see your Top Bands chart. The dark bar is gigs you've attended; the lighter bar is how many times you've seen them at a festival.",
    hubCta:       "Go to Gigs →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "include_upcoming",
    group:        "your_history",
    hubTitle:     "Include upcoming shows in your stats",
    hubBody:     "Toggle 'Include Upcoming' on the Gigs screen to factor your future shows into counts, the map, and the companion chart.",
    hubCta:       "Go to Gigs →",
    hubDeepLink:  "vault.html#data",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "first_timer_badge",
    group:        "your_history",
    hubTitle:     "'First time seeing them!' badge",
    hubBody:      "When you log a show with an artist you've never seen before, GigList automatically marks it with a first-timer badge on your feed and show card.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Your Feed ✨ ─────────────────────────────────────────────────────────────
  {
    id:           "feed_on_this_day",
    group:        "your_feed",
    hubTitle:     "On This Day — your gig history resurfaces",
    hubBody:      "The Feed shows cards for shows you attended on this date in previous years. Enable push notifications to get an On This Day reminder delivered to you.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "feed_band_deep_cut",
    group:        "your_feed",
    hubTitle:     "Band deep cuts in your Feed",
    hubBody:      "Feed cards surface stats about your most-seen artists — how many shows, how many items in your collection — pulling everything together in one place.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "feed_collection_anniversary",
    group:        "your_feed",
    hubTitle:     "Collection anniversaries",
    hubBody:      "When an item in your Collection was added a year ago this month, a card appears in your Feed celebrating it. A nice way to remember what you were listening to.",
    hubCta:       "Go to Feed →",
    hubDeepLink:  "vault.html#feed",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "push_notifications",
    group:        "your_feed",
    hubTitle:     "Push notifications — memories delivered to you",
    hubBody:      "Add GigList to your home screen and enable Push Notifications in your Profile to receive On This Day reminders, buddy tags, and milestone alerts.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     true,
    addedVersion: "1.0",
  },

  // ── Achievements 🏆 ──────────────────────────────────────────────────────────
  {
    id:           "achievements_hub",
    group:        "achievements",
    hubTitle:     "Track your gig milestones",
    hubBody:     "GigList awards achievements as you hit milestones: Century Club (100 shows), Nomad (50 venues), Festival Lifer, and more. Tap 'View All' on your Profile to see what's next.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    nudgeTitle:   "You're close to a milestone",
    nudgeBody:    "Check your Achievements on your Profile — you're within 5 shows of unlocking one.",
    nudgeTrigger: "achievement_close",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "achievement_progress",
    group:        "achievements",
    hubTitle:     "How close are you to your next achievement?",
    hubBody:      "Each achievement shows your current count and how many more you need. Officially Obsessed requires 25 shows with the same artist — your progress bar is right there.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Buddies 👥 ───────────────────────────────────────────────────────────────
  {
    id:           "add_buddies",
    group:        "buddies",
    hubTitle:     "Add Gig Buddies",
    hubBody:      "Search by username in your Profile to add buddies. Once connected, you'll see shared shows, their gig history, and their collection — and they'll see yours.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "buddy_shared_count",
    group:        "buddies",
    hubTitle:     "How many shows have you shared?",
    hubBody:     "Each buddy in your Profile shows a 'shared' count — the number of shows you've both attended. Tap any buddy to drill into their full gig history and collection.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "buddy_drill_in",
    group:        "buddies",
    hubTitle:     "Browse a buddy's gig history",
    hubBody:     "Tap any buddy card to see their full gig history, yearly chart, and top bands. Toggle 'Shared shows only' to filter to just the shows you both attended.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "buddy_connect_band_fans",
    group:        "buddies",
    hubTitle:     "Find new buddies via Band Pages",
    hubBody:     "On any Band Page, the Fans tab shows all GigList users who've logged shows for that artist. A 'Connect' button lets you send a buddy request directly from there.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "public_profile",
    group:        "buddies",
    hubTitle:     "Public Profile setting",
    hubBody:     "Toggle 'Public Profile' in your Profile settings to let anyone send you a buddy request without approval. Turn it off to require you to approve each request.",
    hubCta:       "Go to Profile →",
    hubDeepLink:  "vault.html#profile",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Collection 📀 ────────────────────────────────────────────────────────────
  {
    id:           "collection_what",
    group:        "collection",
    hubTitle:     "What is the Collection tab?",
    hubBody:      "Collection is your physical music world — vinyl, CDs, tapes, and more. Add items, browse by band, and build a record of everything you own.",
    hubCta:       "Go to Collection →",
    hubDeepLink:  "vault.html#collection",
    nudgeTitle:   "Log your music collection",
    nudgeBody:    "The Collection tab is for vinyl, CDs, merch — anything tied to your live music life. Add your first item and start building your shelf.",
    nudgeTrigger: "collection_item_added",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "collection_memory",
    group:        "collection",
    hubTitle:     "Add a memory to any collection item",
    hubBody:     "Tap 'Add Memory' on the Collection screen to capture a story — not everything in your collection needs to be physical. Your collection, your memories.",
    hubCta:       "Go to Collection →",
    hubDeepLink:  "vault.html#collection",
    nudgeTitle:   "Add a memory to your collection",
    nudgeBody:    "Tap any item in your Collection to add a memory — where you got it, what it means, who gave it to you.",
    nudgeTrigger: "collection_item_added",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "collection_band_filter",
    group:        "collection",
    hubTitle:     "Filter your collection by band",
    hubBody:      "Tap any artist pill at the top of the Collection screen to filter everything to just that artist's items. Useful when you want to see your full Weezer shelf.",
    hubCta:       "Go to Collection →",
    hubDeepLink:  "vault.html#collection",
    featured:     false,
    addedVersion: "1.0",
  },

  // ── Band Pages 🔍 ────────────────────────────────────────────────────────────
  {
    id:           "band_pages_what",
    group:        "band_pages",
    hubTitle:     "What are Band Pages?",
    hubBody:     "Band Pages are dedicated artist hubs on GigList — every show ever played, a written summary of their history, and a list of fans. Tap 'Browse Band Pages' on the login screen to explore without an account.",
    hubCta:       "Browse Band Pages →",
    hubDeepLink:  "vault.html",
    featured:     true,
    addedVersion: "1.0",
  },
  {
    id:           "band_pages_fans",
    group:        "band_pages",
    hubTitle:     "See who else loves your favourite bands",
    hubBody:      "Every Band Page has a Fans tab listing all GigList users who've attended their shows, with show counts. A quiet way to find people who love the same music.",
    hubCta:       "Browse Band Pages →",
    hubDeepLink:  "vault.html",
    nudgeTitle:   "Find fans of the same bands",
    nudgeBody:    "You've seen them 3 times — check the Band Page Fans tab to find other GigList users who love them too.",
    nudgeTrigger: "same_artist_3x",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "band_pages_summary",
    group:        "band_pages",
    hubTitle:     "Natural-language history of any band",
    hubBody:      "The Summary tab on a Band Page gives you a written overview of that artist's gigging life — peak years, longest gap, top venues — all generated from real show data.",
    hubCta:       "Browse Band Pages →",
    hubDeepLink:  "vault.html",
    featured:     false,
    addedVersion: "1.0",
  },
  {
    id:           "band_pages_request",
    group:        "band_pages",
    hubTitle:     "Don't see your artist? Request a Band Page",
    hubBody:     "Tap 'Request Band Page' on any gig modal to nominate an artist. Once approved, they get a full page with shows, stats, and fans.",
    hubCta:       "Open a show →",
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

  Promise.resolve(supabase.rpc("append_tip_seen", { tip_id: tipId }))
      .catch(() => {});
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

window.__TIPS__    = TIPS;
window.__hasSeen__ = hasSeen;
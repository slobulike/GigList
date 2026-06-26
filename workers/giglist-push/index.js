import { buildPushHTTPRequest } from '@pushforge/builder';

// ─── Notification Registry ────────────────────────────────────────────────────
//
// To add a new notification type:
//   1. Add an entry here defining the webhook event and payload builder
//   2. Add a Supabase Database Webhook pointing to /push/webhook/<key>
//      — OR — call /push/webhook/<key> directly from client code (for client-
//        triggered events like memory tagging that don't have a DB webhook).
//   That's it.
//
// Each entry has:
//   event:       'INSERT' | 'UPDATE' | 'CLIENT' — the source event type.
//                'CLIENT' means triggered directly by app code, not a DB webhook.
//   description: human-readable note for future you
//   shouldFire(record, oldRecord) → bool
//     Optional guard — return false to skip silently. Defaults to true if omitted.
//   getRecipientIds(record, oldRecord, env) → Promise<string[]>
//     Return the user IDs who should receive the notification.
//   buildPayload(record, oldRecord, env) → Promise<{ title, body, tag, data: { url } }>
//     Return the notification content. The deep-link URL must be nested under
//     data.url so sw.js reads it correctly from event.notification.data.url.
//
// URL convention for data.url:
//   /GigList/vault.html                                        — open the app
//   /GigList/vault.html?open=<journalId>                       — open a gig modal
//   /GigList/vault.html?open=<journalId>&ww=1                  — gig + WW canvas
//   /GigList/vault.html?open=<collectionId>&ww=1&source=collection — collection WW canvas
//
//   sw.js reads data.url on notificationclick and routes accordingly.
//   deep-link.js handles the URL param / postMessage on the client side.

const NOTIFICATIONS = {

  'buddy-request': {
    event: 'INSERT',
    description: 'Notify the recipient when someone sends them a buddy request',
    shouldFire: (record) => record.status === 'pending',
    getRecipientIds: async (record) => {
      const recipientId = record.initiator_id === record.requester_id
        ? record.addressee_id
        : record.requester_id;
      return [recipientId];
    },
    buildPayload: async (record, _old, env) => {
      const username = await getUsername(env, record.initiator_id);
      return {
        title: '🎸 New buddy request',
        body: `${username} wants to be your gig buddy!`,
        tag: 'buddy-request',
        data: { url: '/GigList/vault.html' },
      };
    },
  },

  'buddy-accepted': {
    event: 'UPDATE',
    description: 'Notify the initiator when their buddy request is accepted',
    shouldFire: (record, oldRecord) =>
      oldRecord?.status === 'pending' && record.status === 'accepted',
    getRecipientIds: async (record) => [record.initiator_id],
    buildPayload: async (record, _old, env) => {
      const acceptorId = record.initiator_id === record.requester_id
        ? record.addressee_id
        : record.requester_id;
      const username = await getUsername(env, acceptorId);
      return {
        title: '🎉 Buddy request accepted!',
        body: `${username} accepted your request — check out their gig history!`,
        tag: 'buddy-accepted',
        data: { url: '/GigList/vault.html' },
      };
    },
  },

  'memory-tag': {
    event: 'CLIENT',
    description: 'Notify buddies when they are tagged in a collection memory — triggered directly by collection-editor.js, not a DB webhook',
    getRecipientIds: async (record) => record.buddy_ids ?? [],
    buildPayload: async (record, _old, env) => {
      const username = await getUsername(env, record.tagger_id);
      return {
        title: '📼 You were tagged in a memory',
        body: `${username} added a memory and tagged you in it`,
        tag: 'memory-tag',
        data: { url: '/GigList/vault.html' },
      };
    },
  },

  // ── Future notification types go here ──────────────────────────────────────
  //
  // 'new-gig': {
  //   event: 'INSERT',
  //   description: 'Notify gig buddies when someone logs a new show',
  //   getRecipientIds: async (record, _old, env) => { ... },
  //   buildPayload: async (record, _old, env) => ({ ... }),
  // },

};

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getUsername(env, userId) {
  const rows = await supabaseFetch(env, `profiles?id=eq.${userId}&select=display_name,username`);
  const profile = rows?.[0];
  return profile?.display_name || profile?.username || 'Someone';
}

async function getSubscriptions(env, userIds) {
  if (!userIds?.length) return [];
  const clean = userIds.filter(id => id != null && id !== 'null');
  if (!clean.length) return [];
  const rows = await supabaseFetch(
    env,
    `push_subscriptions?user_id=in.(${clean.join(',')})`
  );
  return rows ?? [];
}

async function deleteStaleSubscription(env, endpoint) {
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
}

// ─── Push Helpers ─────────────────────────────────────────────────────────────

async function sendPush(env, sub, payload) {
  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK: env.VAPID_PRIVATE_KEY,
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    },
    message: {
      payload,
      adminContact: env.VAPID_SUBJECT,
    },
  });

  const res = await fetch(endpoint, { method: 'POST', headers, body });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Push failed: ${res.status}`);
    err.statusCode = res.status;
    err.body = text;
    throw err;
  }

  return res;
}

async function dispatchToUsers(env, userIds, payload) {
  const subscriptions = await getSubscriptions(env, userIds);
  if (!subscriptions.length) return { sent: 0, total: 0 };

  const results = await Promise.allSettled(
    subscriptions.map((sub) => sendPush(env, sub, payload))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.error(`[push] failed for ${subscriptions[i].user_id}:`, r.reason?.statusCode, r.reason?.body);
      if (r.reason?.statusCode === 410) {
        await deleteStaleSubscription(env, subscriptions[i].endpoint);
      }
    }
  }

  return {
    sent: results.filter((r) => r.status === 'fulfilled').length,
    total: subscriptions.length,
  };
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────

async function handleWebhook(notificationKey, request, env) {
  const sig = request.headers.get('x-webhook-secret') || '';
  if (sig !== env.WEBHOOK_SECRET) {
    console.warn(`[webhook] Unauthorized request for ${notificationKey}`);
    return new Response('Unauthorized', { status: 401 });
  }

  const definition = NOTIFICATIONS[notificationKey];
  if (!definition) {
    return new Response('Unknown notification type', { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const record = body.record;
  const oldRecord = body.old_record ?? null;

  if (definition.shouldFire && !definition.shouldFire(record, oldRecord)) {
    console.log(`[webhook] ${notificationKey} — shouldFire returned false, skipping`);
    return new Response('ok');
  }

  try {
    const [recipientIds, payload] = await Promise.all([
      definition.getRecipientIds(record, oldRecord, env),
      definition.buildPayload(record, oldRecord, env),
    ]);
    const result = await dispatchToUsers(env, recipientIds, payload);
    console.log(`[webhook] ${notificationKey} — dispatched: ${JSON.stringify(result)}`);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`[webhook] ${notificationKey} — error:`, err);
    return new Response('Internal error', { status: 500 });
  }
}

// ─── Cron: On This Day ────────────────────────────────────────────────────────

async function handleOnThisDay(env) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day   = today.getDate();

  console.log(`[cron] On This Day — checking for gigs on ${day}/${month}`);

  const allGigs = await supabaseFetch(
    env,
    `journals?select=id,band,venue,date,user_id`
  );

  console.log(`[cron] On This Day — fetched ${allGigs?.length ?? 0} total gigs from Supabase`);

  if (!allGigs?.length) {
    console.warn('[cron] On This Day — no gigs returned at all (check Supabase connectivity)');
    return;
  }

  const matches = allGigs.filter((g) => {
    if (!g.date || g.date === 'nan') return false;
    if (!g.user_id) return false;
    const parts = g.date.split('/');
    if (parts.length !== 3) return false;
    return parseInt(parts[0], 10) === day && parseInt(parts[1], 10) === month;
  });

  console.log(`[cron] On This Day — ${matches.length} match(es):`, JSON.stringify(
    matches.map(g => ({ id: g.id, band: g.band, date: g.date, user_id: g.user_id }))
  ));

  if (!matches.length) {
    console.log('[cron] On This Day — no matches today');
    return;
  }

  const byUser = matches.reduce((acc, gig) => {
    (acc[gig.user_id] ??= []).push(gig);
    return acc;
  }, {});

  const userIds       = Object.keys(byUser);
  const subscriptions = await getSubscriptions(env, userIds);

  console.log(`[cron] On This Day — ${matches.length} gig(s) for ${userIds.length} user(s), ${subscriptions.length} subscription(s)`);

  const subscribedUserIds = new Set(subscriptions.map(s => s.user_id));
  const unsubscribed = userIds.filter(id => !subscribedUserIds.has(id));
  if (unsubscribed.length) {
    console.warn(`[cron] On This Day — no subscription for user_id(s): ${unsubscribed.join(', ')}`);
  }

  for (const sub of subscriptions) {
    const userGigs = byUser[sub.user_id];
    if (!userGigs) continue;

    userGigs.sort((a, b) => parseInt(a.date.split('/')[2], 10) - parseInt(b.date.split('/')[2], 10));
    const gig      = userGigs[0];
    const yearsAgo = today.getFullYear() - parseInt(gig.date.split('/')[2], 10);
    const extra    = userGigs.length > 1 ? ` (+${userGigs.length - 1} more)` : '';

    const payload = {
      title: '🎸 On this day...',
      body:  `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago you saw ${gig.band} at ${gig.venue}${extra}`,
      tag:   'on-this-day',
      data:  { url: `/GigList/vault.html?open=${gig.id}` },
    };

    console.log(`[cron] On This Day — sending to user ${sub.user_id}: "${payload.body}"`);
    console.log(`[cron] On This Day — deep-link url: ${payload.data.url}`);

    try {
      await sendPush(env, sub, payload);
      console.log(`[cron] On This Day — push succeeded for user ${sub.user_id}`);
    } catch (err) {
      console.error(`[cron] On This Day — push failed for user ${sub.user_id}: status=${err.statusCode} body=${err.body}`);
      if (err.statusCode === 410) await deleteStaleSubscription(env, sub.endpoint);
    }
  }
}

// ─── Cron: Weezer Wednesday ───────────────────────────────────────────────────
// Runs every Wednesday at 11:00 UTC (wrangler.toml: "0 11 * * 3").
//
// Selection strategy — alternates each week between two source pools:
//   Even ISO week → gig week   (journals)
//   Odd  ISO week → collection week (collection_items)
//
// If the preferred pool is empty or all items are in cooldown, falls back to
// the other pool. If both pools are exhausted for a user, that user is skipped.
//
// Recency guard — stored in Cloudflare KV (binding: WW_HISTORY):
//   Key:   ww:{userId}:gig        Value: JSON { id, shownAt }
//   Key:   ww:{userId}:collection Value: JSON { id, shownAt }
//
//   An item shown within the last COOLDOWN_MS is excluded from selection.
//   This prevents a user with 1 collection item and 10 gigs seeing that
//   same item every collection week — it will be skipped until the cooldown
//   expires, then fall back to gigs until it clears.
//
// wrangler.toml additions required:
//   [[kv_namespaces]]
//   binding = "WW_HISTORY"
//   id      = "<your-kv-namespace-id>"

const COOLDOWN_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks

// Returns the ISO week number for a given Date.
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Read last-shown record from KV. Returns { id, shownAt } or null.
async function wwKvGet(env, userId, source) {
  if (!env.WW_HISTORY) return null;
  try {
    const raw = await env.WW_HISTORY.get(`ww:${userId}:${source}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Write last-shown record to KV (fire-and-forget on failure — non-critical).
async function wwKvSet(env, userId, source, id) {
  if (!env.WW_HISTORY) return;
  try {
    await env.WW_HISTORY.put(
      `ww:${userId}:${source}`,
      JSON.stringify({ id, shownAt: Date.now() }),
      { expirationTtl: Math.ceil(COOLDOWN_MS / 1000) * 2 } // auto-expire after 2× cooldown
    );
  } catch (err) {
    console.warn(`[cron] WW KV write failed for ${userId}/${source}:`, err.message);
  }
}

// Pick an item from a pool, excluding anything shown within COOLDOWN_MS.
// Returns the chosen item or null if the pool is empty / all on cooldown.
function wwPickItem(pool, lastShown) {
  if (!pool?.length) return null;

  const now = Date.now();
  const eligible = pool.filter(item => {
    if (!lastShown) return true;
    if (item.id !== lastShown.id) return true;                    // different item — always eligible
    return (now - lastShown.shownAt) >= COOLDOWN_MS;             // same item — only if cooled down
  });

  if (!eligible.length) return null;

  // Stable pseudo-random pick within the eligible pool, rotating weekly.
  // Using week number so the same item isn't always picked if multiple are eligible.
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return eligible[weekNumber % eligible.length];
}

async function handleWeezerWednesday(env) {
  console.log('[cron] Weezer Wednesday — starting');

  const today     = new Date();
  const weekNum   = isoWeekNumber(today);
  const gigWeek   = weekNum % 2 === 0; // even = gig week, odd = collection week
  console.log(`[cron] Weezer Wednesday — ISO week ${weekNum}, preferred source: ${gigWeek ? 'gig' : 'collection'}`);

  // ── Fetch all Weezer gigs ──────────────────────────────────────────────────
  const weezerGigs = await supabaseFetch(
    env,
    `journals?select=id,band,venue,date,user_id&band=ilike.weezer`
  );
  console.log(`[cron] Weezer Wednesday — ${weezerGigs?.length ?? 0} Weezer gig(s) found`);

  // ── Fetch Weezer artist id, then collection items ─────────────────────────
  let weezerCollectionItems = [];
  const weezerArtists = await supabaseFetch(
    env,
    `artists?select=id&name=ilike.weezer`
  );
  const weezerArtistId = weezerArtists?.[0]?.id ?? null;

  if (weezerArtistId) {
    const items = await supabaseFetch(
      env,
      `collection_items?select=id,title,type,user_id&artist_id=eq.${weezerArtistId}`
    );
    weezerCollectionItems = items ?? [];
    console.log(`[cron] Weezer Wednesday — ${weezerCollectionItems.length} Weezer collection item(s) found`);
  } else {
    console.warn('[cron] Weezer Wednesday — Weezer artist not found in artists table, collection pool empty');
  }

  // ── Group both pools by user ───────────────────────────────────────────────
  const gigsByUser = (weezerGigs ?? []).reduce((acc, g) => {
    (acc[g.user_id] ??= []).push(g);
    return acc;
  }, {});

  const collectionByUser = weezerCollectionItems.reduce((acc, item) => {
    (acc[item.user_id] ??= []).push(item);
    return acc;
  }, {});

  // ── Get subscriptions for any user who has at least one pool ──────────────
  const eligibleUserIds = [...new Set([
    ...Object.keys(gigsByUser),
    ...Object.keys(collectionByUser),
  ])].filter(id => id != null && id !== 'null');

  if (!eligibleUserIds.length) {
    console.log('[cron] Weezer Wednesday — no eligible users, skipping');
    return;
  }

  const subscriptions = await getSubscriptions(env, eligibleUserIds);
  console.log(`[cron] Weezer Wednesday — ${eligibleUserIds.length} eligible user(s), ${subscriptions.length} subscription(s)`);

  // ── Per-user dispatch ─────────────────────────────────────────────────────
  for (const sub of subscriptions) {
    const userId    = sub.user_id;
    const userGigs  = gigsByUser[userId] ?? [];
    const userItems = collectionByUser[userId] ?? [];

    // Read KV history for both pools in parallel
    const [gigHistory, collectionHistory] = await Promise.all([
      wwKvGet(env, userId, 'gig'),
      wwKvGet(env, userId, 'collection'),
    ]);

    // Attempt preferred source first, then fall back
    let chosen = null;
    let chosenSource = null;

    const primarySource    = gigWeek ? 'gig' : 'collection';
    const secondarySource  = gigWeek ? 'collection' : 'gig';
    const primaryPool      = gigWeek ? userGigs : userItems;
    const secondaryPool    = gigWeek ? userItems : userGigs;
    const primaryHistory   = gigWeek ? gigHistory : collectionHistory;
    const secondaryHistory = gigWeek ? collectionHistory : gigHistory;

    chosen = wwPickItem(primaryPool, primaryHistory);
    if (chosen) {
      chosenSource = primarySource;
    } else {
      console.log(`[cron] WW user ${userId} — preferred pool (${primarySource}) empty/on cooldown, trying fallback`);
      chosen = wwPickItem(secondaryPool, secondaryHistory);
      if (chosen) {
        chosenSource = secondarySource;
      }
    }

    if (!chosen) {
      console.log(`[cron] WW user ${userId} — both pools exhausted or on cooldown, skipping`);
      continue;
    }

    // ── Build payload ─────────────────────────────────────────────────────
    let payload;

    if (chosenSource === 'gig') {
      const year = chosen.date
        ? (chosen.date.split('/')[2] ?? chosen.date.slice(0, 4))
        : '?';
      payload = {
        title: '🎸 Weezer Wednesday',
        body:  `You saw Weezer at ${chosen.venue} in ${year} — relive it →`,
        tag:   'weezer-wednesday',
        data:  { url: `/GigList/vault.html?open=${chosen.id}&ww=1` },
      };
    } else {
      const label = chosen.title || 'a Weezer item in your collection';
      payload = {
        title: '🎸 Weezer Wednesday',
        body:  `You've got "${label}" in your collection — check it out →`,
        tag:   'weezer-wednesday',
        data:  { url: `/GigList/vault.html?open=${chosen.id}&ww=1&source=collection` },
      };
    }

    console.log(`[cron] WW user ${userId} — source=${chosenSource} id=${chosen.id} url=${payload.data.url}`);

    try {
      await sendPush(env, sub, payload);
      console.log(`[cron] WW user ${userId} — push succeeded`);
      await wwKvSet(env, userId, chosenSource, chosen.id);
    } catch (err) {
      console.error(`[cron] WW user ${userId} — push failed: status=${err.statusCode} body=${err.body}`);
      if (err.statusCode === 410) await deleteStaleSubscription(env, sub.endpoint);
    }
  }
}

// ─── Cron: Gig Hydrated Delayed Push ─────────────────────────────────────────
// Runs daily at 09:00 UTC (wrangler.toml: "0 9 * * *").
//
// Finds pending_captures rows that were hydrated 9–45 hours ago and haven't
// yet received a push. The window means:
//   - Shows confirmed late evening will get a push the following morning
//   - Shows confirmed in the morning (or by users in other timezones) catch
//     the next day's run at the latest — everyone gets exactly one push
//   - Idempotent: push_sent flipped to true after dispatch; never double-fires
//
// Also handles needs_review rows (user tapped "I'll log it later") with
// different copy — Stage 11 will add these.

async function handleGigHydratedPush(env) {
  console.log('[cron] gig-hydrated push — starting');

  const now              = new Date();
  const nineHoursAgo      = new Date(now - 9  * 60 * 60 * 1000).toISOString();
  const fortyFiveHoursAgo = new Date(now - 45 * 60 * 60 * 1000).toISOString();

  const rows = await supabaseFetch(
    env,
    `pending_captures?status=eq.hydrated&push_sent=eq.false` +
    `&hydrated_at=gte.${fortyFiveHoursAgo}&hydrated_at=lte.${nineHoursAgo}` +
    `&select=id,user_id,matched_artist,matched_venue,matched_journal_key`
  );

  console.log(`[cron] gig-hydrated push — ${rows?.length ?? 0} eligible row(s)`);

  if (!rows?.length) {
    console.log('[cron] gig-hydrated push — nothing to send');
    return;
  }

  for (const row of rows) {
    // Resolve numeric journal id for deep-link (falls back to app root)
    const journals  = await supabaseFetch(
      env,
      `journals?journal_key=eq.${row.matched_journal_key}&user_id=eq.${row.user_id}&select=id`
    );
    const journalId = journals?.[0]?.id ?? null;
    const deepLink  = journalId
      ? `/GigList/vault.html?open=${journalId}`
      : `/GigList/vault.html`;

    const payload = {
      title: '🎸 Last night is logged!',
      body:  `${row.matched_artist} at ${row.matched_venue} is in your GigList — add a photo or tag who you were with →`,
      tag:   'gig-hydrated',
      data:  { url: deepLink },
    };

    console.log(`[cron] gig-hydrated — user ${row.user_id} url=${deepLink}`);

    const result = await dispatchToUsers(env, [row.user_id], payload);
    console.log(`[cron] gig-hydrated — user ${row.user_id}: ${JSON.stringify(result)}`);

    // Mark push_sent regardless of delivery outcome — don't retry indefinitely
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/pending_captures?id=eq.${row.id}`,
      {
        method:  'PATCH',
        headers: {
          apikey:          env.SUPABASE_SERVICE_KEY,
          Authorization:   `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
          Prefer:          'return=minimal',
        },
        body: JSON.stringify({ push_sent: true }),
      }
    );
  }

  console.log('[cron] gig-hydrated push — done');

    // ── needs_review push (Stage 11) ─────────────────────────────────────────
    // Separate query: users who tapped "I'll log it later" 9–45h ago and haven't
    // yet been nudged. Uses captured_at (hydrated_at is not set for these rows).

    const needsReviewRows = await supabaseFetch(
      env,
      `pending_captures?status=eq.needs_review&push_sent=eq.false` +
      `&captured_at=gte.${fortyFiveHoursAgo}&captured_at=lte.${nineHoursAgo}` +
      `&select=id,user_id,matched_venue`
    );

    console.log(`[cron] needs-review push — ${needsReviewRows?.length ?? 0} eligible row(s)`);

    for (const row of (needsReviewRows ?? [])) {
      const venuePart = row.matched_venue ? ` at ${row.matched_venue}` : '';
      const payload = {
        title: '🎸 Didn\'t finish logging your show?',
        body:  `You were at a show${venuePart} last night — tap to finish logging it →`,
        tag:   'gig-needs-review',
        data:  { url: '/GigList/vault.html' },
      };

      console.log(`[cron] needs-review — user ${row.user_id}`);

      const result = await dispatchToUsers(env, [row.user_id], payload);
      console.log(`[cron] needs-review — user ${row.user_id}: ${JSON.stringify(result)}`);

      await fetch(
        `${env.SUPABASE_URL}/rest/v1/pending_captures?id=eq.${row.id}`,
        {
          method:  'PATCH',
          headers: {
            apikey:         env.SUPABASE_SERVICE_KEY,
            Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer:         'return=minimal',
          },
          body: JSON.stringify({ push_sent: true }),
        }
      );
    }

    console.log('[cron] needs-review push — done');
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-secret',
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  // GET /push/vapid-public-key
  if (request.method === 'GET' && url.pathname === '/push/vapid-public-key') {
    return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // POST /push/send — manual/internal trigger (testing and admin)
  if (request.method === 'POST' && url.pathname === '/push/send') {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { userIds, payload } = await request.json();
    if (!userIds?.length || !payload) {
      return new Response('Bad request', { status: 400 });
    }

    const result = await dispatchToUsers(env, userIds, payload);
    return new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // POST /push/cron/weezer-wednesday — manual trigger for testing
  // Runs the full cron handler immediately, identical to the scheduled version.
  if (request.method === 'POST' && url.pathname === '/push/cron/weezer-wednesday') {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      await handleWeezerWednesday(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[manual] weezer-wednesday error:', err);
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /push/cron/gig-hydrated — manual trigger for testing
  // Runs the full cron handler immediately, identical to the scheduled version.
  if (request.method === 'POST' && url.pathname === '/push/cron/gig-hydrated') {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      await handleGigHydratedPush(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[manual] gig-hydrated error:', err);
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /push/webhook/:type — Supabase Database Webhook entry point
  const webhookMatch = url.pathname.match(/^\/push\/webhook\/([a-z-]+)$/);
  if (request.method === 'POST' && webhookMatch) {
    return handleWebhook(webhookMatch[1], request, env);
  }

  // GET /push/debug — subscription count (remove before v1)
  if (request.method === 'GET' && url.pathname === '/push/debug') {
    const data = await supabaseFetch(env, 'push_subscriptions?select=user_id,endpoint');
    return new Response(JSON.stringify({ count: data?.length ?? 0, data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not found', { status: 404 });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env) {
    const cron = event.cron;
// "0 7 * * *"    → On This Day      (07:00 UTC daily)
// "0 9 * * *"    → Gig hydrated delayed push (09:00 UTC daily)
// "0 11 * * WED" → Weezer Wednesday (11:00 UTC every Wednesday)
    if      (cron === '0 11 * * WED') { await handleWeezerWednesday(env); }
    else if (cron === '0 9 * * *')    { await handleGigHydratedPush(env); }
    else                               { await handleOnThisDay(env); }
  },
};
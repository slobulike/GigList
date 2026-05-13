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
//   buildPayload(record, oldRecord, env) → Promise<{ title, body, url, tag }>
//     Return the notification content.

const NOTIFICATIONS = {

  'buddy-request': {
    event: 'INSERT',
    description: 'Notify the recipient when someone sends them a buddy request',
    shouldFire: (record) => record.status === 'pending',
    getRecipientIds: async (record) => {
      // Notify whoever is NOT the initiator
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
        url: '/GigList/',
        tag: 'buddy-request',
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
      // The acceptor is whoever is NOT the initiator
      const acceptorId = record.initiator_id === record.requester_id
        ? record.addressee_id
        : record.requester_id;
      const username = await getUsername(env, acceptorId);
      return {
        title: '🎉 Buddy request accepted!',
        body: `${username} accepted your request — check out their gig history!`,
        url: '/GigList/',
        tag: 'buddy-accepted',
      };
    },
  },

  'memory-tag': {
    event: 'CLIENT',
    description: 'Notify buddies when they are tagged in a collection memory — triggered directly by collection-editor.js, not a DB webhook',
    // No shouldFire guard — collection-editor only calls this when buddyIds.length > 0
    getRecipientIds: async (record) => record.buddy_ids ?? [],
    buildPayload: async (record, _old, env) => {
      const username = await getUsername(env, record.tagger_id);
      return {
        title: '📼 You were tagged in a memory',
        body: `${username} added a memory and tagged you in it`,
        url: '/GigList/',
        tag: 'memory-tag',
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
  const quoted = userIds.map(id => `"${id}"`).join(',');
  const rows = await supabaseFetch(
    env,
    `push_subscriptions?user_id=in.(${quoted})`
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

    if (!recipientIds?.length) {
      console.log(`[webhook] ${notificationKey} — no recipients, skipping`);
      return new Response('ok');
    }

    const result = await dispatchToUsers(env, recipientIds, payload);
    console.log(`[webhook] ${notificationKey} — sent ${result.sent}/${result.total}`);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`[webhook] ${notificationKey} error:`, err);
    return new Response('Internal error', { status: 500 });
  }
}

// ─── Cron: On This Day ────────────────────────────────────────────────────────

async function handleOnThisDay(env) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  console.log(`[cron] On This Day — checking for gigs on ${month}/${day}`);

  const allGigs = await supabaseFetch(
    env,
   `journals?select=id,band,venue,date,user_id`
  );

  // ADD: log total fetched so pagination truncation is visible
  console.log(`[cron] On This Day — fetched ${allGigs?.length ?? 0} total gigs from Supabase`);

  if (!allGigs?.length) {
    console.warn('[cron] On This Day — no gigs returned at all (check Supabase connectivity)');
    return;
  }

const matches = allGigs.filter((g) => {
  if (!g.date || g.date === 'nan') return false;
  if (!g.user_id) return false; // add this line
  const parts = g.date.split('/');
  if (parts.length !== 3) return false;
  return parseInt(parts[0], 10) === day && parseInt(parts[1], 10) === month;
});

  // ADD: log the actual matches so you can see which gigs were candidates
  console.log(`[cron] On This Day — ${matches.length} match(es):`, JSON.stringify(matches.map(g => ({ id: g.id, artist: g.artist, date: g.date, user_id: g.user_id }))));

  if (matches.length === 0) {
    console.log('[cron] On This Day — no matches today');
    return;
  }

  const byUser = matches.reduce((acc, gig) => {
    (acc[gig.user_id] ??= []).push(gig);
    return acc;
  }, {});

  const userIds = Object.keys(byUser);
  const subscriptions = await getSubscriptions(env, userIds);

  console.log(`[cron] On This Day — ${matches.length} gig(s) for ${userIds.length} user(s), ${subscriptions.length} subscription(s)`);

  // ADD: log which users have subscriptions vs which don't
  const subscribedUserIds = new Set(subscriptions.map(s => s.user_id));
  const unsubscribed = userIds.filter(id => !subscribedUserIds.has(id));
  if (unsubscribed.length) {
    console.warn(`[cron] On This Day — no subscription found for user_id(s): ${unsubscribed.join(', ')}`);
  }

for (const sub of subscriptions) {
  const userGigs = byUser[sub.user_id];
  if (!userGigs) continue;

  userGigs.sort((a, b) => parseInt(a.date.split('/')[2], 10) - parseInt(b.date.split('/')[2], 10));
  const gig = userGigs[0];
  const yearsAgo = today.getFullYear() - parseInt(gig.date.split('/')[2], 10);
  const extra = userGigs.length > 1 ? ` (+${userGigs.length - 1} more)` : '';

  const payload = {
    title: '🎸 On this day...',
    body: `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago you saw ${gig.band} at ${gig.venue}${extra}`,
    url: '/GigList/',
    tag: 'on-this-day',
  };

    // ADD: log the payload being sent and to which endpoint
    console.log(`[cron] On This Day — sending to user ${sub.user_id}, endpoint: ${sub.endpoint.slice(0, 60)}...`);
    console.log(`[cron] On This Day — payload: "${payload.body}"`);

    try {
      await sendPush(env, sub, payload);
      // ADD: explicit success log
      console.log(`[cron] On This Day — push succeeded for user ${sub.user_id}`);
    } catch (err) {
      // ADD: log the full error, not just the 410 handling
      console.error(`[cron] On This Day — push failed for user ${sub.user_id}: status=${err.statusCode} body=${err.body}`);
      if (err.statusCode === 410) await deleteStaleSubscription(env, sub.endpoint);
    }
  }
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

  // POST /push/webhook/:type — Supabase Database Webhook entry point
  // Also used by client-triggered notifications (event: 'CLIENT') such as memory-tag.
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

  async scheduled(_event, env) {
    await handleOnThisDay(env);
  },
};
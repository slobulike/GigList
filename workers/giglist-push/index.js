import { buildPushHTTPRequest } from '@pushforge/builder';

// ─── Notification Registry ────────────────────────────────────────────────────
//
// To add a new notification type:
//   1. Add an entry here defining the webhook event and payload builder
//   2. Add a Supabase Database Webhook pointing to /push/webhook/<key>
//   That's it.
//
// Each entry has:
//   event:       'INSERT' | 'UPDATE' — the Supabase webhook event type
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
  const rows = await supabaseFetch(
    env,
    `push_subscriptions?user_id=in.(${userIds.join(',')})`
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
    `gigs?select=id,artist,venue,date,user_id&date=gte.2000-01-01`
  );

  if (!allGigs?.length) return;

  const matches = allGigs.filter((g) => {
    const d = new Date(g.date);
    return d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
  });

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

  for (const sub of subscriptions) {
    const userGigs = byUser[sub.user_id];
    if (!userGigs) continue;

    userGigs.sort((a, b) => new Date(a.date) - new Date(b.date));
    const gig = userGigs[0];
    const yearsAgo = today.getFullYear() - new Date(gig.date).getFullYear();
    const extra = userGigs.length > 1 ? ` (+${userGigs.length - 1} more)` : '';

    const payload = {
      title: '🎸 On this day...',
      body: `${yearsAgo} year${yearsAgo !== 1 ? 's' : ''} ago you saw ${gig.artist} at ${gig.venue}${extra}`,
      url: '/GigList/',
      tag: 'on-this-day',
    };

    try {
      await sendPush(env, sub, payload);
    } catch (err) {
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
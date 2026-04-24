import { buildPushHTTPRequest } from '@pushforge/builder';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getSubscriptions(env, userIds) {
  const url = `${env.SUPABASE_URL}/rest/v1/push_subscriptions?user_id=in.(${userIds.join(',')})`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

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

async function sendToSubscriptions(env, subscriptions, payload) {
  return Promise.allSettled(
    subscriptions.map((sub) => sendPush(env, sub, payload))
  );
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

// ─── Cron: On This Day ───────────────────────────────────────────────────────

async function handleOnThisDay(env) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  const gigsRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/gigs?select=id,artist,venue,date,user_id&date=gte.2000-01-01`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!gigsRes.ok) return;
  const allGigs = await gigsRes.json();

  const matches = allGigs.filter((g) => {
    const d = new Date(g.date);
    return d.getMonth() + 1 === month && d.getDate() === day;
  });

  if (matches.length === 0) return;

  const byUser = matches.reduce((acc, gig) => {
    if (!acc[gig.user_id]) acc[gig.user_id] = [];
    acc[gig.user_id].push(gig);
    return acc;
  }, {});

  const userIds = Object.keys(byUser);
  const subscriptions = await getSubscriptions(env, userIds);

  for (const sub of subscriptions) {
    const userGigs = byUser[sub.user_id];
    if (!userGigs) continue;

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

// ─── HTTP Handler ────────────────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // GET /push/vapid-public-key — client fetches this on load
  if (request.method === 'GET' && url.pathname === '/push/vapid-public-key') {
    return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // POST /push/send — internal trigger from app logic
  if (request.method === 'POST' && url.pathname === '/push/send') {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { userIds, payload } = await request.json();

    if (!userIds?.length || !payload) {
      return new Response('Bad request', { status: 400 });
    }

    const subscriptions = await getSubscriptions(env, userIds);
    if (!subscriptions.length) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results = await sendToSubscriptions(env, subscriptions, payload);

    // Log rejections for debugging
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Push failed:', result.reason?.statusCode, result.reason?.message, result.reason?.body);
      }
    }

    // Clean up expired subscriptions (HTTP 410 = unsubscribed)
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected' && results[i].reason?.statusCode === 410) {
        await deleteStaleSubscription(env, subscriptions[i].endpoint);
      }
    }

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    return new Response(JSON.stringify({
      sent,
      total: subscriptions.length,
      results: results.map(r => r.status === 'rejected'
        ? { status: 'rejected', code: r.reason?.statusCode, message: r.reason?.message, body: r.reason?.body }
        : { status: 'fulfilled' }
      ),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // POST /push/buddy-accepted — Supabase webhook: buddies status → accepted
  if (request.method === 'POST' && url.pathname === '/push/buddy-accepted') {
    const sig = request.headers.get('x-supabase-signature') || '';
    if (sig !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

    const payload = await request.json();
    const record = payload.record;

    const profileRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${record.addressee_id}&select=username`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    const profiles = await profileRes.json();
    const username = profiles[0]?.username || 'Someone';

    const subs = await getSubscriptions(env, [record.requester_id]);
    for (const sub of subs) {
      try {
        await sendPush(env, sub, {
          title: '🎸 New Gig Buddy!',
          body: `${username} accepted your gig buddy request`,
          url: '/GigList/',
          tag: 'buddy-accepted',
        });
      } catch (err) {
        if (err.statusCode === 410) await deleteStaleSubscription(env, sub.endpoint);
      }
    }
    return new Response('ok');
  }

  // POST /push/new-gig — Supabase webhook: journals INSERT
  if (request.method === 'POST' && url.pathname === '/push/new-gig') {
    const sig = request.headers.get('x-supabase-signature') || '';
    if (sig !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

    const payload = await request.json();
    const record = payload.record;

    if (!record.user_id) return new Response('ok');

    const profileRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${record.user_id}&select=username`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    const profiles = await profileRes.json();
    const username = profiles[0]?.username || 'Your gig buddy';

    const buddiesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/buddies?or=(requester_id.eq.${record.user_id},addressee_id.eq.${record.user_id})&status=eq.accepted&select=requester_id,addressee_id`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    const buddies = await buddiesRes.json();
    if (!buddies?.length) return new Response('ok');

    const buddyIds = buddies.map(b =>
      b.requester_id === record.user_id ? b.addressee_id : b.requester_id
    );

    const subs = await getSubscriptions(env, buddyIds);
    for (const sub of subs) {
      try {
        await sendPush(env, sub, {
          title: '🎟️ New show added',
          body: `${username} just logged ${record.band} at ${record.official_venue}`,
          url: '/GigList/',
          tag: 'new-gig',
        });
      } catch (err) {
        if (err.statusCode === 410) await deleteStaleSubscription(env, sub.endpoint);
      }
    }
    return new Response('ok');
  }

  // Temporary debug route
  if (request.method === 'GET' && url.pathname === '/push/debug') {
    const testUrl = `${env.SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,endpoint`;
    const res = await fetch(testUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });
    const data = await res.json();
    return new Response(JSON.stringify({ status: res.status, data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not found', { status: 404 });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env) {
    await handleOnThisDay(env);
  },
};
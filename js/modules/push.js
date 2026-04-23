// ─── js/push.js ──────────────────────────────────────────────────────────────

const PUSH_WORKER_URL = 'https://giglist-push.richard-lipscombe.workers.dev';

// ─── VAPID public key ─────────────────────────────────────────────────────────

async function getVapidPublicKey() {
  const res = await fetch(`${PUSH_WORKER_URL}/push/vapid-public-key`);
  const { key } = await res.json();
  return key;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ─── Subscribe ────────────────────────────────────────────────────────────────

export async function subscribeToPush(supabase) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push not supported in this browser');
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const vapidKey = await getVapidPublicKey();

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    const { endpoint, keys } = subscription.toJSON();

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      { onConflict: 'user_id,endpoint' }
    );

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Push subscription failed:', err);
    return false;
  }
}

// ─── Unsubscribe ──────────────────────────────────────────────────────────────

export async function unsubscribeFromPush(supabase) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint);

    await subscription.unsubscribe();
    return true;
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
    return false;
  }
}

// ─── Check current state ──────────────────────────────────────────────────────

export async function getPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

// ─── Trigger a push (called by your app logic) ────────────────────────────────

export async function sendPushNotification({ userIds, payload, internalSecret }) {
  const res = await fetch(`${PUSH_WORKER_URL}/push/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalSecret}`,
    },
    body: JSON.stringify({ userIds, payload }),
  });
  return res.json();
}
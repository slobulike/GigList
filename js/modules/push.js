/**
 * GigList — Push Notifications Module
 * Handles subscription, unsubscription, permission state, and silent
 * self-healing of lost/stale subscriptions (e.g. after a VAPID key rotation).
 */

const PUSH_WORKER_URL = 'https://giglist-push.richard-lipscombe.workers.dev';

// Remembers that THIS browser opted in, so a subscription the browser/push
// service has dropped can be recreated silently — while a user who deliberately
// switched notifications off (flag cleared) is never resubscribed.
const OPT_IN_KEY = 'giglist_push_opted_in';

function setOptIn(on) {
  try {
    if (on) localStorage.setItem(OPT_IN_KEY, '1');
    else localStorage.removeItem(OPT_IN_KEY);
  } catch { /* storage unavailable — healing just won't cover the no-subscription case */ }
}

function getOptIn() {
  try { return localStorage.getItem(OPT_IN_KEY) === '1'; } catch { return false; }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function getVapidPublicKey() {
  const res = await fetch(`${PUSH_WORKER_URL}/push/vapid-public-key`);
  const { key } = await res.json();
  return key;
}

/**
 * True if an existing browser subscription was created with the given VAPID
 * public key. A subscription made with an old key can never receive pushes
 * signed with the new one, and pushManager.subscribe() throws if you try to
 * re-subscribe over it with a different key.
 */
function keysMatch(sub, vapidKey) {
  const current = sub.options?.applicationServerKey;
  if (!current) return true; // browser doesn't expose it — can't tell, assume OK
  const a = new Uint8Array(current);
  const b = urlBase64ToUint8Array(vapidKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ─── STATE ────────────────────────────────────────────────────────────────────

/**
 * Returns the true push state, cross-checking the browser subscription
 * against the DB to detect and clean up orphaned subscriptions.
 */
export async function getPushState(supabase = null) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return 'unsubscribed';

  // Verify DB row exists — browser may have a subscription the DB doesn't know about
  if (supabase) {
    const { data } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', sub.endpoint)
      .maybeSingle();

    if (!data) {
      // Orphaned browser subscription — clean it up
      await sub.unsubscribe();
      return 'unsubscribed';
    }
  }

  return 'subscribed';
}

// ─── SELF-HEAL ────────────────────────────────────────────────────────────────

// The in-flight sync, so a toggle tap made while it runs waits for it rather
// than racing it (both would subscribe/unsubscribe the same browser).
let _syncing = null;

/**
 * Call once per app open (personal mode, signed in). Runs in the background —
 * it needs the network (VAPID key + DB) and must never hold up the UI. Returns
 * true if it re-created the subscription, so the caller can re-run initPushUI
 * to show the healed state. Never throws and never prompts.
 *
 * Recreates the subscription silently when the user has opted in but:
 *   - the browser has no subscription any more (opt-in flag still set),
 *   - the subscription was made with a different (rotated) VAPID key, or
 *   - the DB row is missing (e.g. the Worker pruned it after a 404/410).
 * Does nothing if notifications are off, denied, or already healthy.
 */
export function syncPushSubscription(supabase) {
  _syncing = _syncPushSubscription(supabase).finally(() => { _syncing = null; });
  return _syncing;
}

async function _syncPushSubscription(supabase) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    // Resubscribing without a prompt is only possible once permission is granted
    if (Notification.permission !== 'granted') return false;

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();

    // No subscription and no record that they opted in → they're off. Leave it.
    if (!existing && !getOptIn()) return false;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false;
    const userId = session.user.id;

    const vapidKey = await getVapidPublicKey();

    if (existing && keysMatch(existing, vapidKey)) {
      const { data: row } = await supabase
        .from('push_subscriptions')
        .select('id')
        .eq('endpoint', existing.endpoint)
        .maybeSingle();

      if (row) {
        setOptIn(true); // healthy — also migrates users who subscribed before the flag existed
        return false;
      }
      // Browser subscription is fine but its DB row is gone → fall through and recreate
    }

    // Recreate: drop the old browser subscription (if any), make a fresh one
    const oldEndpoint = existing?.endpoint;
    if (existing) await existing.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const { endpoint, keys } = sub.toJSON();

    if (oldEndpoint) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', oldEndpoint);
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .insert({ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth });
    if (error) throw error;

    setOptIn(true);
    console.log('[Push] Subscription re-created');
    return true;
  } catch (err) {
    console.warn('[Push] Subscription sync failed:', err);
    return false;
  }
}

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────

export async function subscribeToPush(supabase) {
  await _syncing;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    window.showToast('Push notifications aren\'t supported in this browser', 'warning');
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    window.showToast('Notification permission denied', 'warning');
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const vapidKey = await getVapidPublicKey();

    // A leftover subscription made with an old VAPID key makes subscribe() throw
    const stale = await reg.pushManager.getSubscription();
    if (stale && !keysMatch(stale, vapidKey)) await stale.unsubscribe();

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    const { endpoint, keys } = subscription.toJSON();

    // Get authenticated user — required for user_id in the DB row
    let { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      // Try to refresh the session first
      const { data: { session } } = await supabase.auth.refreshSession();
      if (!session) {
        window.showToast('Please sign in again to enable notifications', 'warning');
        return false;
      }
      user = session.user;
    }

    // Check if already stored — avoids duplicate insert
    const { data: existing } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', endpoint)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase
        .from('push_subscriptions')
        .insert({ user_id: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth });
      console.log('[Push] insert result:', error ?? 'success');
      if (error) throw error;
    }

    setOptIn(true);
    window.showToast('Notifications enabled! 🎸', 'success');
    return true;
  } catch (err) {
    console.error('Push subscription failed:', err);
    window.showToast('Could not enable notifications — try again', 'error');
    return false;
  }
}

// ─── UNSUBSCRIBE ──────────────────────────────────────────────────────────────

export async function unsubscribeFromPush(supabase) {
  try {
    // Deliberate opt-out: let any in-flight sync finish (it may set the flag),
    // then clear it so no later sync resurrects the subscription
    await _syncing;
    setOptIn(false);

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;

    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', sub.endpoint);

    await sub.unsubscribe();
    window.showToast('Notifications disabled', 'info');
    return true;
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
    window.showToast('Could not disable notifications — try again', 'error');
    return false;
  }
}

// ─── UI INIT ─────────────────────────────────────────────────────────────────

export async function initPushUI(supabase) {
  const btn = document.getElementById('push-toggle-btn');
  const label = document.getElementById('push-toggle-label');
  if (!btn || !label) return;

  // Derive state from browser + DB — never assume
  const state = await getPushState(supabase);
  console.log('[Push] Initial state:', state, 'permission:', Notification.permission);

  if (state === 'unsupported') {
    btn.closest('[data-push-row]')?.classList.add('hidden');
    return;
  }

  const update = (el, subscribed) => {
    el.setAttribute('aria-checked', String(subscribed));
    el.classList.toggle('bg-indigo-600', subscribed);
    el.classList.toggle('bg-slate-200', !subscribed);
    const knob = el.querySelector('[data-knob]');
    if (knob) knob.style.transform = subscribed ? 'translateX(1.5rem)' : 'translateX(0)';
    label.textContent = subscribed
      ? 'Notifications on'
      : 'Get notified about gig buddies and memories.';
  };

  // iOS home screen hint
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isIos && !isStandalone) {
    document.getElementById('push-ios-hint')?.classList.remove('hidden');
  }

  // Clone to remove any previously bound listeners (initPushUI may be called twice)
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  // Set accurate initial state on the fresh button
  update(fresh, state === 'subscribed');

  fresh.addEventListener('click', async () => {
    const currentlyOn = fresh.getAttribute('aria-checked') === 'true';
    console.log('[Push] Toggle clicked, currentlyOn:', currentlyOn);
    console.log('[Push] Notification.permission:', Notification.permission);

    if (currentlyOn) {
      const ok = await window.withSpinner('Turning off notifications…', () => unsubscribeFromPush(supabase));
      if (ok) update(fresh, false);
    } else {
      console.log('[Push] Attempting to subscribe...');
      const ok = await window.withSpinner('Enabling notifications…', () => subscribeToPush(supabase));
      console.log('[Push] Subscribe result:', ok);
      if (ok) update(fresh, true);
    }
  });
}

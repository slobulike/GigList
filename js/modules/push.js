/**
 * GigList — Push Notifications Module
 * Handles subscription, unsubscription, and permission state.
 */

const PUSH_WORKER_URL = 'https://giglist-push.richard-lipscombe.workers.dev';

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

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────

export async function subscribeToPush(supabase) {
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

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    const { endpoint, keys } = subscription.toJSON();

    // Get authenticated user — required for user_id in the DB row
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        // Try to refresh the session first
        const { data: { session } } = await supabase.auth.refreshSession();
        if (!session) {
            window.showToast('Please sign in again to enable notifications', 'warning');
            return false;
        }
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
      const ok = await unsubscribeFromPush(supabase);
      if (ok) update(fresh, false);
    } else {
      console.log('[Push] Attempting to subscribe...');
      const ok = await subscribeToPush(supabase);
      console.log('[Push] Subscribe result:', ok);
      if (ok) update(fresh, true);
    }
  });
}
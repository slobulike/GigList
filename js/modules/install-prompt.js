// install-prompt.js
// Shows a one-action "install the app" banner to mobile browser visitors.
// Usage: import { initInstallPrompt } from './install-prompt.js'; initInstallPrompt();

const KEY_DISMISSED = 'installPrompt:dismissedUntil';
const KEY_VISITS = 'installPrompt:visits';
const DISMISS_DAYS = 14;
const MIN_VISITS = 2; // don't show on first visit

const ua = navigator.userAgent;
const isIOS =
  /iphone|ipad|ipod/i.test(ua) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)); // iPadOS
const isAndroid = /android/i.test(ua);
const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|Twitter|LinkedInApp|TikTok/i.test(ua);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

let deferredPrompt = null;

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function recentlyDismissed() {
  const until = Number(safeGet(KEY_DISMISSED) || 0);
  return Date.now() < until;
}

function dismiss() {
  safeSet(KEY_DISMISSED, String(Date.now() + DISMISS_DAYS * 864e5));
  document.getElementById('install-banner')?.remove();
}

function injectStyles() {
  if (document.getElementById('install-banner-styles')) return;
  const style = document.createElement('style');
  style.id = 'install-banner-styles';
  style.textContent = `
    #install-banner {
      position: fixed; left: 12px; right: 12px;
      bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      z-index: 9999; display: flex; align-items: center; gap: 12px;
      padding: 12px 14px; border-radius: 14px;
      background: #1c1c1e; color: #fff;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      font: 14px/1.35 system-ui, -apple-system, sans-serif;
    }
    #install-banner .ib-text { flex: 1; }
    #install-banner .ib-title { font-weight: 600; }
    #install-banner .ib-share { display: inline-block; vertical-align: -3px; }
    #install-banner button { font: inherit; border: 0; cursor: pointer; }
    #install-banner .ib-install {
      background: #fff; color: #000; font-weight: 600;
      padding: 8px 14px; border-radius: 999px;
    }
    #install-banner .ib-close {
      background: transparent; color: #aaa; font-size: 20px; padding: 4px 8px;
    }
  `;
  document.head.appendChild(style);
}

const SHARE_ICON = `<svg class="ib-share" width="18" height="18" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/>
  <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;

function showBanner(mode) {
  if (document.getElementById('install-banner')) return;
  injectStyles();

  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Install GigList');

  let body = '';
  if (mode === 'android') {
    body = `<div class="ib-text"><div class="ib-title">Install GigList</div>
      Add it to your home screen for quick access.</div>
      <button class="ib-install">Install</button>`;
  } else if (mode === 'ios') {
    body = `<div class="ib-text"><div class="ib-title">Install GigList</div>
      Tap ${SHARE_ICON} then <strong>Add to Home Screen</strong></div>`;
  } else if (mode === 'ios-inapp') {
    body = `<div class="ib-text"><div class="ib-title">Install GigList</div>
      Open this page in <strong>Safari</strong> to add it to your home screen.</div>`;
  }
  body += `<button class="ib-close" aria-label="Dismiss">×</button>`;
  banner.innerHTML = body;

  banner.querySelector('.ib-close').onclick = dismiss;
  const installBtn = banner.querySelector('.ib-install');
  if (installBtn) {
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      banner.remove();
    };
  }
  document.body.appendChild(banner);
}

export function initInstallPrompt() {
  if (isStandalone) return;
  if (!isIOS && !isAndroid) return;

  const visits = Number(safeGet(KEY_VISITS) || 0) + 1;
  safeSet(KEY_VISITS, String(visits));
  if (visits < MIN_VISITS || recentlyDismissed()) return;

  window.addEventListener('appinstalled', () => {
    document.getElementById('install-banner')?.remove();
  });

  if (isIOS) {
    showBanner(isInAppBrowser ? 'ios-inapp' : 'ios');
    return;
  }

  // Android: only show once the browser says the app is installable
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showBanner('android');
  });
}

// Optional: call from a "How to install" link in settings to bypass dismissal.
export function showInstallHelp() {
  if (isStandalone) return;
  if (isIOS) showBanner(isInAppBrowser ? 'ios-inapp' : 'ios');
  else if (deferredPrompt) showBanner('android');
}

// Lets other modules (e.g. the settings row in profile.js) decide whether
// to show a "How to install" link at all — true on mobile web, not already
// installed, and (Android only) once the browser has confirmed installability.
export function canShowInstallHelp() {
  if (isStandalone) return false;
  if (isIOS) return true;
  if (isAndroid) return !!deferredPrompt;
  return false;
}
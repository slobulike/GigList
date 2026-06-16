// ─────────────────────────────────────────────────────────────────────────────
// modal-tips.js
// Layer B — Gig Modal Tips
//
// Adds pulse dots to modal buttons with unseen tips, and shows a single
// slide-up toast for the first unseen tip each time a modal opens.
//
// Entry point: initModalTips(modalEl)
// Call after the gig modal has been inserted into the DOM and is visible.
// Requires initTips(userId) to have been called first (tips-registry.js).
//
// Modal button requirements:
//   Each button that maps to a tip's modalButton value needs a data-tip attribute:
//   e.g. <button data-tip="share">Share</button>
//        <button data-tip="setlist">Setlist</button>
// ─────────────────────────────────────────────────────────────────────────────

import { TIPS, hasSeen, markSeen } from "./tips-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOAST_AUTO_DISMISS_MS = 8000;
const SWIPE_DOWN_THRESHOLD  = 40; // px — swipe down distance to dismiss

// ─────────────────────────────────────────────────────────────────────────────
// Styles — injected once
// ─────────────────────────────────────────────────────────────────────────────

const MODAL_TIPS_CSS = `
/* ── Pulse dot ───────────────────────────────────────────────── */
.tip-pulse-dot {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 10px;
  height: 10px;
  pointer-events: none;
  z-index: 10;
}

/* Outer ring — provides shape distinction (not colour-only, per WCAG 4.1.1) */
.tip-pulse-dot__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--color-purple, #9b59b6);
  animation: tip-pulse-ring 1.8s ease-out infinite;
  opacity: 0;
}

/* Inner filled dot */
.tip-pulse-dot__inner {
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: var(--color-purple, #9b59b6);
}

@keyframes tip-pulse-ring {
  0%   { transform: scale(1);   opacity: 0.8; }
  80%  { transform: scale(2.2); opacity: 0;   }
  100% { transform: scale(2.2); opacity: 0;   }
}

@media (prefers-reduced-motion: reduce) {
  .tip-pulse-dot__ring { animation: none; opacity: 1; }
}

/* Button needs position:relative for the dot to anchor correctly */
.tip-pulse-host {
  position: relative;
}

/* ── Toast ───────────────────────────────────────────────────── */
.tip-toast {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 200;
  background: var(--color-surface-elevated, #1e1e2e);
  border-top: 1px solid var(--color-border, rgba(255,255,255,0.12));
  border-radius: 0 0 var(--radius-modal, 16px) var(--radius-modal, 16px);
  padding: 14px 16px 18px;
  cursor: pointer;
  /* Slide up */
  animation: tip-toast-slide-up 250ms ease-out both;
  touch-action: pan-y;
}

@keyframes tip-toast-slide-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0);    }
}

@keyframes tip-toast-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .tip-toast {
    animation: tip-toast-fade-in 150ms ease both;
  }
}

.tip-toast--dismissing {
  animation: tip-toast-slide-down 200ms ease-in both;
}

@keyframes tip-toast-slide-down {
  from { transform: translateY(0);    }
  to   { transform: translateY(100%); }
}

@media (prefers-reduced-motion: reduce) {
  .tip-toast--dismissing {
    animation: tip-toast-fade-out 120ms ease both;
  }
}

@keyframes tip-toast-fade-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}

/* Toast header row */
.tip-toast__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.tip-toast__eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--color-purple, #9b59b6);
  display: flex;
  align-items: center;
  gap: 5px;
}

/* Dismiss button — 44×44px touch target via padding */
.tip-toast__dismiss {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  margin: -10px -10px -10px 0;
  padding: 10px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted, #888);
  font-size: 18px;
  line-height: 1;
  border-radius: var(--radius-sm, 6px);
}

.tip-toast__dismiss:hover  { color: var(--color-text, #fff); }
.tip-toast__dismiss:focus-visible {
  outline: 2px solid var(--color-purple, #9b59b6);
  outline-offset: 2px;
}

/* Toast body */
.tip-toast__body {
  font-size: 14px;
  line-height: 1.45;
  color: var(--color-text, #fff);
  margin-bottom: 8px;
  /* Prevent clicks on body text propagating to the dismiss-all handler */
  pointer-events: none;
}

/* Hub link */
.tip-toast__hub-link {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-muted, #888);
  text-decoration: none;
  pointer-events: auto;
}
.tip-toast__hub-link:hover { color: var(--color-text, #fff); }
.tip-toast__hub-link:focus-visible {
  outline: 2px solid var(--color-purple, #9b59b6);
  border-radius: 2px;
}
`;

function injectStyles() {
  if (document.getElementById("modal-tips-styles")) return;
  const style = document.createElement("style");
  style.id = "modal-tips-styles";
  style.textContent = MODAL_TIPS_CSS;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pulse dots
// ─────────────────────────────────────────────────────────────────────────────

function addPulseDot(btn, tipId) {
  // Ensure the button can position the dot correctly
  btn.classList.add("tip-pulse-host");

  const dot = document.createElement("span");
  dot.className      = "tip-pulse-dot";
  dot.dataset.tipDot = tipId;
  // ARIA — announces without interrupting current focus
  dot.setAttribute("role",       "status");
  dot.setAttribute("aria-label", "Feature tip available");

  const ring  = document.createElement("span");
  ring.className = "tip-pulse-dot__ring";
  ring.setAttribute("aria-hidden", "true");

  const inner = document.createElement("span");
  inner.className = "tip-pulse-dot__inner";
  inner.setAttribute("aria-hidden", "true");

  dot.appendChild(ring);
  dot.appendChild(inner);
  btn.appendChild(dot);
}

function removePulseDot(modalEl, tipId) {
  const dot = modalEl.querySelector(`[data-tip-dot="${tipId}"]`);
  dot?.remove();
  // Also remove the host class if no more dots on that button
  const btn = modalEl.querySelector(`[data-tip]`);
  if (btn && !btn.querySelector(".tip-pulse-dot")) {
    btn.classList.remove("tip-pulse-host");
  }
}

function removeAllPulseDots(modalEl) {
  modalEl.querySelectorAll(".tip-pulse-dot").forEach(d => d.remove());
  modalEl.querySelectorAll(".tip-pulse-host").forEach(b => b.classList.remove("tip-pulse-host"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

function renderToast(tip, modalEl) {
  // Only one toast at a time
  modalEl.querySelector(".tip-toast")?.remove();

  const toast = document.createElement("div");
  toast.className = "tip-toast";
  // ARIA — polite announcement; does not trap focus
  toast.setAttribute("aria-live",   "polite");
  toast.setAttribute("aria-atomic", "true");
  toast.setAttribute("role",        "status");

  // Header row
  const header = document.createElement("div");
  header.className = "tip-toast__header";

  const eyebrow = document.createElement("span");
  eyebrow.className   = "tip-toast__eyebrow";
  eyebrow.textContent = "✨  Did you know?";

  const dismissBtn = document.createElement("button");
  dismissBtn.type      = "button";
  dismissBtn.className = "tip-toast__dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss tip");
  dismissBtn.textContent = "×";

  header.appendChild(eyebrow);
  header.appendChild(dismissBtn);

  // Body
  const body = document.createElement("p");
  body.className   = "tip-toast__body";
  body.textContent = tip.modalTip;

  // Hub link
  const hubLink = document.createElement("a");
  hubLink.className   = "tip-toast__hub-link";
  hubLink.href        = "vault.html#profile";
  hubLink.textContent = "See all tips in your Profile →";

  toast.appendChild(header);
  toast.appendChild(body);
  toast.appendChild(hubLink);

  // ── Dismiss logic ──────────────────────────────────────────────

  let autoDismissTimer = null;

  function dismiss() {
    if (!toast.isConnected) return;
    clearTimeout(autoDismissTimer);
    toast.classList.add("tip-toast--dismissing");
    const animDuration = prefersReducedMotion() ? 120 : 200;
    setTimeout(() => {
      markSeen(tip.id);
      removePulseDot(modalEl, tip.id);
      // Notify hub if it's open — update progress bar
      dispatchTipSeen(tip.id);
      toast.remove();
    }, animDuration);
  }

  // Auto-dismiss
  autoDismissTimer = setTimeout(dismiss, TOAST_AUTO_DISMISS_MS);

  // Dismiss button (keyboard + touch)
  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // prevent toast click handler also firing
    dismiss();
  });

  // Tap anywhere on toast also dismisses
  toast.addEventListener("click", dismiss);

  // Hub link click — navigate without double-dismissing
  hubLink.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
    // Navigation happens via the href naturally
  });

  // ── Swipe down to dismiss ──────────────────────────────────────
  let touchStartY = null;

  toast.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  toast.addEventListener("touchmove", (e) => {
    if (touchStartY === null) return;
    const delta = e.touches[0].clientY - touchStartY;
    if (delta > 0) {
      // Follow finger downward
      toast.style.transform = `translateY(${delta}px)`;
      toast.style.transition = "none";
    }
  }, { passive: true });

  toast.addEventListener("touchend", (e) => {
    if (touchStartY === null) return;
    const delta = e.changedTouches[0].clientY - touchStartY;
    toast.style.transform = "";
    toast.style.transition = "";
    touchStartY = null;
    if (delta >= SWIPE_DOWN_THRESHOLD) {
      dismiss();
    }
  }, { passive: true });

  // The modal must be position:relative or position:absolute for the toast
  // to anchor to its bottom edge correctly.
  modalEl.appendChild(toast);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function prefersReducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Dispatch a custom event so the Tips Hub (if open) can update its
 * progress bar without a direct module coupling.
 */
function dispatchTipSeen(tipId) {
  window.dispatchEvent(new CustomEvent("giglist:tipSeen", { detail: { tipId } }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initModalTips(modalEl, options)
 *
 * Call once each time a gig modal is opened, after its DOM is ready.
 * Adds pulse dots to all buttons with unseen tips, and shows a single
 * slide-up toast for the first unseen tip.
 *
 * @param {HTMLElement} modalEl          — the root element of the gig modal
 * @param {object}      [options]
 * @param {string|Date} [options.gigDate] — the date of the gig (any format
 *   parseable by Date, or a Date object). Used to filter contextual tips:
 *   tips with context:"past" only show for past/today gigs; tips with
 *   context:"future" only show for upcoming gigs. Tips with no context
 *   field show regardless of date. If omitted, all tips are eligible.
 */
export function initModalTips(modalEl, { gigDate } = {}) {
  if (!modalEl) return;
  injectStyles();

  // Derive context from gigDate. Treat today as "past" so the Relive tip
  // shows for same-day gigs (the show has just happened).
  let gigContext = null; // null = no filtering
  if (gigDate) {
    const d = gigDate instanceof Date ? gigDate : new Date(gigDate);
    gigContext = !isNaN(d) ? (d <= new Date() ? "past" : "future") : null;
  }

  // All tips that have a modal button + body copy, filtered by context
  const modalTips = TIPS.filter(t => {
    if (!t.modalButton || !t.modalTip) return false;
    // If the tip declares a context requirement, enforce it
    if (t.context && gigContext && t.context !== gigContext) return false;
    return true;
  });

  // Add pulse dots for every unseen tip whose button exists in this modal
  modalTips.forEach(tip => {
    if (hasSeen(tip.id)) return;
    const btn = modalEl.querySelector(`[data-tip="${tip.modalButton}"]`);
    if (btn) addPulseDot(btn, tip.id);
  });

  // Show the first unseen tip as a toast (one per modal open)
  const firstUnseen = modalTips.find(t => !hasSeen(t.id));
  if (firstUnseen) renderToast(firstUnseen, modalEl);
}

/**
 * teardownModalTips(modalEl)
 *
 * Call when the gig modal is closed/removed.
 * Cleans up any remaining toast and pulse dots, clears timers.
 */
export function teardownModalTips(modalEl) {
  if (!modalEl) return;
  modalEl.querySelector(".tip-toast")?.remove();
  removeAllPulseDots(modalEl);
}
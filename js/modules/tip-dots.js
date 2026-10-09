// ─────────────────────────────────────────────────────────────────────────────
// tip-dots.js
// Pulsing "unseen tip" dot for feature labels.
//
// USAGE
//   1. Tag any label/button:   <span data-tip-dot="wish_list_add">Wish List</span>
//      (value = a tip id from tips-registry.js). Works on elements built in JS
//      too — set el.dataset.tipDot = "wish_list_add" before calling refresh.
//   2. Call refreshTipDots() after initTips(userId), and again after any menu
//      or view that contains tagged elements is (re)rendered.
//   3. Call markTipUsed("tip_id") when the user actually uses the feature.
//      That marks the tip seen (same as tapping its Hub CTA), removes the dot,
//      and fires `giglist:tips-changed` so the Hub strip can refresh.
//
// The dot disappears whenever the tip is seen by ANY route (Hub CTA, nudge card,
// modal tip, or markTipUsed) because it simply reflects hasSeen().
// ─────────────────────────────────────────────────────────────────────────────

import { hasSeen, markSeen } from "./tips-registry.js";

const DOT_SELECTOR = "[data-tip-dot]";

export function refreshTipDots(root = document) {
  root.querySelectorAll(DOT_SELECTOR).forEach((el) => {
    const existing = el.querySelector(":scope > .tip-dot");
    if (hasSeen(el.dataset.tipDot)) {
      existing?.remove();
      return;
    }
    if (existing) return;

    const dot = document.createElement("span");
    dot.className = "tip-dot";
    dot.innerHTML =
      '<span class="tip-dot__ring" aria-hidden="true"></span>' +
      '<span class="tip-dot__core" aria-hidden="true"></span>' +
      '<span class="tip-dot__sr">New feature</span>';
    el.appendChild(dot);
  });
}

export function markTipUsed(tipId) {
  if (hasSeen(tipId)) return;
  markSeen(tipId);
  refreshTipDots();
  window.dispatchEvent(new CustomEvent("giglist:tips-changed", { detail: { tipId } }));
}

window.refreshTipDots = refreshTipDots;
window.markTipUsed    = markTipUsed;

const DOT_CSS = `
.tip-dot { position: relative; display: inline-flex; width: 8px; height: 8px;
           margin-left: 6px; vertical-align: middle; flex-shrink: 0; }
.tip-dot__core, .tip-dot__ring { position: absolute; inset: 0; border-radius: 50%;
           background: var(--color-purple, #6366f1); }
.tip-dot__ring { opacity: .6; animation: tip-dot-ping 1.4s cubic-bezier(0,0,.2,1) infinite; }
.tip-dot__sr { position: absolute; width: 1px; height: 1px; overflow: hidden;
           clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes tip-dot-ping { 75%, 100% { transform: scale(2.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .tip-dot__ring { display: none; } }
`;

(function injectDotStyles() {
  if (document.getElementById("tip-dot-styles")) return;
  const style = document.createElement("style");
  style.id = "tip-dot-styles";
  style.textContent = DOT_CSS;
  document.head.appendChild(style);
})();
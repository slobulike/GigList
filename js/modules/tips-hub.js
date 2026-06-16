// ─────────────────────────────────────────────────────────────────────────────
// tips-hub.js
// Layer A — The Tips Hub
// Renders the "WHAT GIGLIST CAN DO" section on the Profile screen.
//
// Entry point: initTipsHub(containerEl)
// Call after initTips(userId) and syncSeenState() have resolved.
// ─────────────────────────────────────────────────────────────────────────────

import {
  TIPS,
  TIP_GROUPS,
  hasSeen,
  markSeen,
  getSeenCount,
  getTotalCount,
  getTipsByGroup,
  getGroupProgress,
} from "./tips-registry.js";

import { parseDate } from "./utils.js";

// Alias for clarity in tips code — parseDate handles DD/MM/YYYY correctly.
const parseGLDate = parseDate;

// ── "NEW" badge logic ─────────────────────────────────────────────────────────
// A tip shows "NEW" for 30 days after addedVersion was shipped,
// but only if the user's account predates the addedVersion ship date.
// addedVersion is a semver string ("1.0", "1.2", etc.) — we store ship dates
// in VERSION_SHIP_DATES below. Add an entry whenever you bump addedVersion.

const VERSION_SHIP_DATES = {
  "1.0": "01/06/2026",
  // "1.1": "DD/MM/YYYY",  ← add future versions here
};
const NEW_BADGE_DAYS = 30;

function isNewTip(tip, accountCreatedAt) {
  const shipDateStr = VERSION_SHIP_DATES[tip.addedVersion];
  if (!shipDateStr) return false;
  const shipDate = parseGLDate(shipDateStr);
  if (!shipDate) return false;
  // Only badge if the user existed before this version shipped
  if (accountCreatedAt && accountCreatedAt >= shipDate) return false;
  const ageMs = Date.now() - shipDate.getTime();
  return ageMs <= NEW_BADGE_DAYS * 24 * 60 * 60 * 1000;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, cls, attrs = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function renderProgressSection() {
  const seen  = getSeenCount();
  const total = getTotalCount();
  const pct   = total > 0 ? Math.round((seen / total) * 100) : 0;

  const wrapper = el("div", "tips-hub__progress-wrapper");

  const label = el("p", "tips-hub__progress-label");
  label.innerHTML =
    `<span class="tips-hub__seen-count">${seen}</span> of ` +
    `<span class="tips-hub__total-count">${total}</span> features discovered`;

  const barTrack = el("div", "tips-hub__bar-track", { role: "progressbar",
    "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100",
    "aria-label": `${seen} of ${total} features discovered` });
  const barFill  = el("div", "tips-hub__bar-fill");
  barFill.style.width = `${pct}%`;
  barTrack.appendChild(barFill);

  wrapper.appendChild(label);
  wrapper.appendChild(barTrack);
  return wrapper;
}

// Update the progress bar in place — called after markSeen
function updateProgress(hubEl) {
  const seen  = getSeenCount();
  const total = getTotalCount();
  const pct   = total > 0 ? Math.round((seen / total) * 100) : 0;

  const countEl = hubEl.querySelector(".tips-hub__seen-count");
  if (countEl) countEl.textContent = String(seen);

  const track = hubEl.querySelector(".tips-hub__bar-track");
  if (track) {
    track.setAttribute("aria-valuenow", String(pct));
    track.querySelector(".tips-hub__bar-fill").style.width = `${pct}%`;
  }
}

// ── Tip row ───────────────────────────────────────────────────────────────────

function renderTipRow(tip, accountCreatedAt, onCtaNavigate) {
  const seen  = hasSeen(tip.id);
  const isNew = !seen && isNewTip(tip, accountCreatedAt);

  const row = el("div", `tips-hub__tip-row${seen ? " tips-hub__tip-row--seen" : ""}`);
  row.dataset.tipId = tip.id;

  // Left: tick or placeholder
  const tick = el("span", `tips-hub__tick${seen ? " tips-hub__tick--visible" : ""}`,
    { "aria-hidden": "true" });
  tick.textContent = "✓";
  row.appendChild(tick);

  // Body
  const body = el("div", "tips-hub__tip-body");

  const titleLine = el("div", "tips-hub__tip-title-line");
  const title = el("span", "tips-hub__tip-title");
  title.textContent = tip.hubTitle;
  titleLine.appendChild(title);

  if (isNew) {
    const badge = el("span", "tips-hub__new-badge", { "aria-label": "New feature" });
    badge.textContent = "NEW";
    titleLine.appendChild(badge);
  }

  const bodyText = el("p", "tips-hub__tip-body-text");
  bodyText.textContent = tip.hubBody;

  body.appendChild(titleLine);
  body.appendChild(bodyText);

  if (tip.hubCta && tip.hubDeepLink) {
    const cta = el("a", "tips-hub__cta",
      { href: tip.hubDeepLink, "data-tip-id": tip.id });
    cta.textContent = tip.hubCta;
    // Seen tips navigate without re-marking
    if (!seen) {
      cta.addEventListener("click", (e) => {
        e.preventDefault();
        _onCtaTap(tip, row, onCtaNavigate);
      });
    }
    body.appendChild(cta);
  }

  row.appendChild(body);
  return row;
}

function _onCtaTap(tip, rowEl, onCtaNavigate) {
  if (!hasSeen(tip.id)) {
    markSeen(tip.id);
    rowEl.classList.add("tips-hub__tip-row--seen");
    const tick = rowEl.querySelector(".tips-hub__tick");
    if (tick) tick.classList.add("tips-hub__tick--visible");
    const hubEl = rowEl.closest(".tips-hub");
    if (hubEl) updateProgress(hubEl);
  }
  if (onCtaNavigate) {
    onCtaNavigate(tip.hubDeepLink);
  } else {
    navigate(tip.hubDeepLink);
  }
}

// ── Group section ─────────────────────────────────────────────────────────────

function renderGroup(group, accountCreatedAt, onCtaNavigate) {
  const tips = getTipsByGroup(group.id);
  if (!tips.length) return null;

  const progress    = getGroupProgress()[group.id] ?? { total: 0, seen: 0 };
  const allSeen     = progress.seen === progress.total;

  const section = el("div", `tips-hub__group${allSeen ? " tips-hub__group--complete" : ""}`);
  section.dataset.groupId = group.id;

  // Collapsible header
  const header = el("button", "tips-hub__group-header",
    { type: "button", "aria-expanded": "true",
      "aria-controls": `tips-group-${group.id}` });

  const headerLeft = el("span", "tips-hub__group-header-left");
  const emoji = el("span", "tips-hub__group-emoji", { "aria-hidden": "true" });
  emoji.textContent = group.emoji;
  const label = el("span", "tips-hub__group-label");
  label.textContent = group.label;
  headerLeft.appendChild(emoji);
  headerLeft.appendChild(label);

  const headerRight = el("span", "tips-hub__group-header-right");
  const progressPill = el("span", "tips-hub__group-progress");
  progressPill.textContent = `${progress.seen}/${progress.total}`;
  const chevron = el("span", "tips-hub__chevron", { "aria-hidden": "true" });
  chevron.textContent = "▾";
  headerRight.appendChild(progressPill);
  headerRight.appendChild(chevron);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  // Collapsible body
  const body = el("div", "tips-hub__group-body");
  body.id = `tips-group-${group.id}`;

  tips.forEach((tip) => {
    body.appendChild(renderTipRow(tip, accountCreatedAt, onCtaNavigate));
  });

  // Toggle collapse — use a CSS class rather than the `hidden` attribute so
  // that Tailwind's [hidden] reset cannot override the collapsed state.
  header.addEventListener("click", () => {
    const expanded = header.getAttribute("aria-expanded") === "true";
    header.setAttribute("aria-expanded", String(!expanded));
    body.classList.toggle("tips-hub__group-body--collapsed", expanded);
    chevron.textContent = expanded ? "▸" : "▾";
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * initTipsHub(containerEl, options)
 *
 * Renders the full Tips Hub into containerEl.
 *
 * @param {HTMLElement} containerEl  — the element to render into (cleared first)
 * @param {object}      options
 * @param {string}      [options.accountCreatedAt]  — DD/MM/YYYY profile created_at
 *
 * Call after:
 *   await initTips(userId);
 *   await syncSeenState();
 *   initTipsHub(document.getElementById("tips-hub-container"), { accountCreatedAt });
 */
export function initTipsHub(containerEl, { accountCreatedAt, onCtaNavigate, hideHeader } = {}) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  containerEl.classList.add("tips-hub");

  // Section header — suppressed when the drawer already provides a heading
  if (!hideHeader) {
    const sectionHeader = el("div", "tips-hub__section-header");
    const sectionLabel  = el("h2", "tips-hub__section-label");
    sectionLabel.textContent = "WHAT GIGLIST CAN DO";
    sectionHeader.appendChild(sectionLabel);
    containerEl.appendChild(sectionHeader);
  }

  // Progress
  containerEl.appendChild(renderProgressSection());

  // Parsed account date for "NEW" badging
  const parsedAccountDate = accountCreatedAt ? parseGLDate(accountCreatedAt) : null;

  // Groups
  TIP_GROUPS.forEach((group) => {
    const section = renderGroup(group, parsedAccountDate, onCtaNavigate);
    if (section) containerEl.appendChild(section);
  });
}

// ── navigate helper ───────────────────────────────────────────────────────────
// Thin wrapper — swap out for your app's router if needed.

function navigate(url) {
  window.location.href = url;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS — inject once; keeps the module self-contained.
// GigList design tokens assumed: --color-purple, --color-surface, --color-text,
// --color-text-muted, --color-green, --color-border, --font-body, --radius-md
// ─────────────────────────────────────────────────────────────────────────────

const HUB_CSS = `
/* ── Tips Hub ────────────────────────────────────────────────── */
.tips-hub {
  font-family: var(--font-body, 'Plus Jakarta Sans', sans-serif);
}

/* Section header */
.tips-hub__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.tips-hub__section-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted, #888);
  margin: 0;
}

/* Progress */
.tips-hub__progress-wrapper {
  margin-bottom: 20px;
}
.tips-hub__progress-label {
  font-size: 13px;
  color: var(--color-text-muted, #64748b);
  margin: 0 0 6px;
}
.tips-hub__seen-count {
  color: var(--color-text, #1e293b);
  font-weight: 600;
}
.tips-hub__total-count {
  color: var(--color-text, #1e293b);
}
.tips-hub__bar-track {
  height: 3px;
  background: var(--color-border, #e2e8f0);
  border-radius: 99px;
  overflow: hidden;
}
.tips-hub__bar-fill {
  height: 100%;
  background: var(--color-purple, #9b59b6);
  border-radius: 99px;
  transition: width 0.4s ease;
}

/* Group sections */
.tips-hub__group {
  margin-bottom: 4px;
  border-radius: var(--radius-md, 10px);
  overflow: hidden;
  background: var(--color-surface, #f8fafc);
}
.tips-hub__group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 14px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  gap: 8px;
}
.tips-hub__group-header:focus-visible {
  outline: 2px solid var(--color-purple, #9b59b6);
  outline-offset: -2px;
}
.tips-hub__group-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tips-hub__group-emoji {
  font-size: 16px;
  line-height: 1;
}
.tips-hub__group-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #1e293b);
}
.tips-hub__group-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tips-hub__group-progress {
  font-size: 12px;
  color: var(--color-text-muted, #64748b);
}
.tips-hub__group--complete .tips-hub__group-progress {
  color: var(--color-green, #16a34a);
}
.tips-hub__chevron {
  font-size: 12px;
  color: var(--color-text-muted, #94a3b8);
  transition: transform 0.2s;
}

/* Tip rows */
.tips-hub__group-body--collapsed {
  display: none;
}
.tips-hub__group-body {
  padding: 0 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.tips-hub__tip-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--color-border, #e2e8f0);
}
.tips-hub__tip-row--seen {
  opacity: 0.6;
}

/* Tick */
.tips-hub__tick {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: transparent;
  border: 1.5px solid var(--color-border, #cbd5e1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: transparent;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
}
.tips-hub__tick--visible {
  background: var(--color-green, #16a34a);
  border-color: var(--color-green, #16a34a);
  color: #fff;
}

/* Tip content */
.tips-hub__tip-body {
  flex: 1;
  min-width: 0;
}
.tips-hub__tip-title-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 3px;
}
.tips-hub__tip-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #1e293b);
  line-height: 1.3;
}
.tips-hub__new-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-purple, #9b59b6);
  color: #fff;
  vertical-align: middle;
  flex-shrink: 0;
}
.tips-hub__tip-body-text {
  font-size: 13px;
  color: var(--color-text-muted, #64748b);
  line-height: 1.45;
  margin: 0 0 6px;
}
.tips-hub__cta {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-purple, #9b59b6);
  text-decoration: none;
  display: inline-block;
}
.tips-hub__cta:hover {
  text-decoration: underline;
}
.tips-hub__cta:focus-visible {
  outline: 2px solid var(--color-purple, #9b59b6);
  border-radius: 2px;
}
`;

(function injectHubStyles() {
  if (document.getElementById("tips-hub-styles")) return;
  const style = document.createElement("style");
  style.id = "tips-hub-styles";
  style.textContent = HUB_CSS;
  document.head.appendChild(style);
})();
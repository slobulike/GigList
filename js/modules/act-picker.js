/**
 * GigList - Multi-artist picker
 *
 * Pills + typeahead for choosing several artists (support acts, festival
 * line-ups). Pick a suggestion and it becomes a pill, the input clears and
 * stays focused so you can keep typing. Same interaction as the companion
 * ("Went With") picker.
 *
 * Names that aren't in the artists table are allowed (they're created on
 * save) but are checked first: input that looks like several acts joined in
 * one name ("A / B", "A, B", "A & B") is flagged, with a one-tap split.
 *
 * Usage:
 *   const picker = createActPicker({
 *       inputId, listId, pillsId, msgId,
 *       getOptions: () => ['Weezer', ...],   // known artist names
 *   });
 *   picker.setValues(['Bike Routes']);
 *   picker.commitPending();   // call before save; false = needs a decision
 *   picker.getValues();       // ['Bike Routes', ...]
 *   picker.getNewNames();     // the ones not in getOptions()
 */

import { escapeHtml, normalizeArtist, detectMultipleActs } from './utils.js';

const PILL_KNOWN = 'bg-indigo-50 border-indigo-200 text-indigo-800';
const PILL_NEW   = 'bg-amber-50 border-amber-200 text-amber-800';
const MAX_SUGGESTIONS = 8;

export function createActPicker({ inputId, listId, pillsId, msgId, getOptions }) {
    const input  = document.getElementById(inputId);
    const list   = document.getElementById(listId);
    const pills  = document.getElementById(pillsId);
    const msg    = document.getElementById(msgId);
    if (!input || !list || !pills) return null;

    /** @type {{name: string, isNew: boolean}[]} */
    let acts = [];
    let activeIdx = -1;
    let notice = null;   // { kind: 'multi'|'near', text, parts?, near? }

    // ── Known-artist lookup (rebuilt only when the options array changes) ──
    let _src = null, _map = new Map();
    const known = () => {
        const opts = getOptions() || [];
        if (opts !== _src) {
            _src = opts;
            _map = new Map(opts.map(o => [normalizeArtist(o), o]));
        }
        return _map;
    };
    const canonical = (name) => known().get(normalizeArtist(name)) || null;

    // ── Pills ──────────────────────────────────────────────────────────────
    function render() {
        pills.innerHTML = acts.map((a, i) => `
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold ${a.isNew ? PILL_NEW : PILL_KNOWN}">
                ${escapeHtml(a.name)}
                ${a.isNew ? '<span class="text-[9px] font-black uppercase tracking-wider opacity-70">new</span>' : ''}
                <button type="button" data-remove="${i}" aria-label="Remove ${escapeHtml(a.name)}"
                        class="ml-0.5 opacity-50 hover:opacity-100 transition-opacity text-sm leading-none">&times;</button>
            </span>`).join('');
    }

    pills.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        acts.splice(parseInt(btn.dataset.remove, 10), 1);
        render();
    });

    function add(name, isNew) {
        const clean = (name || '').trim();
        if (!clean) return;
        const key = normalizeArtist(clean);
        if (acts.some(a => normalizeArtist(a.name) === key)) return;
        acts.push({ name: clean, isNew });
        render();
    }

    function addResolved(name) {
        const c = canonical(name);
        add(c || name, !c);
    }

    // ── Messages ───────────────────────────────────────────────────────────
    function clearNotice() {
        notice = null;
        if (msg) { msg.innerHTML = ''; msg.classList.add('hidden'); }
    }

    function showNotice(n) {
        notice = n;
        if (!msg) return;
        const btn = (action, label, primary) =>
            `<button type="button" data-act="${action}"
                     class="px-2.5 py-1 rounded-full text-[11px] font-black ${primary
                        ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-300 text-slate-600'}">${label}</button>`;
        let tone, body, buttons;

        if (n.kind === 'multi') {
            const quoted = n.parts.map(p => `“${escapeHtml(p)}”`).join(', ');
            const hard = n.level === 'error';
            tone = hard ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-900';
            body = hard
                ? `That looks like <strong>${n.parts.length} acts</strong> in one box: ${quoted}. Add them separately.`
                : `Is this ${n.parts.length} acts? ${quoted}`;
            buttons = btn('split', `Add ${n.parts.length} separately`, true)
                    + (hard ? '' : btn('keep', 'Keep as one band'));
        } else {
            tone = 'bg-amber-50 border-amber-200 text-amber-900';
            body = `“${escapeHtml(n.text)}” isn't on GigList yet. Did you mean <strong>${escapeHtml(n.near)}</strong>?`;
            buttons = btn('use-near', `Use ${escapeHtml(n.near)}`, true) + btn('keep', 'Add as new');
        }
        msg.className = `mt-2 rounded-2xl border px-3 py-2.5 text-xs font-semibold space-y-2 ${tone}`;
        msg.innerHTML = `<p>${body}</p><div class="flex flex-wrap gap-2">${buttons}</div>`;
    }

    msg?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !notice) return;
        const n = notice;
        if (btn.dataset.act === 'split')    (n.parts || []).forEach(addResolved);
        if (btn.dataset.act === 'use-near') addResolved(n.near);
        if (btn.dataset.act === 'keep')     add(n.text, true);
        input.value = '';
        clearNotice();
        input.focus();
    });

    // ── Committing typed text ──────────────────────────────────────────────
    function findNear(text) {
        const key = normalizeArtist(text);
        if (key.length < 4) return null;
        for (const [k, display] of known()) {
            if (k === key) continue;
            if ((k.startsWith(key) || key.startsWith(k)) && Math.min(k.length, key.length) >= 4) return display;
        }
        return null;
    }

    /** Resolves what's typed in the input. Returns false if the user has to decide something. */
    function commitText() {
        const text = input.value.trim();
        if (!text) return true;

        const c = canonical(text);
        if (c) { add(c, false); input.value = ''; hideList(); clearNotice(); return true; }

        const knownSet = new Set(known().keys());
        const multi = detectMultipleActs(text, knownSet);
        if (multi) { hideList(); showNotice({ kind: 'multi', text, ...multi }); return false; }

        const near = findNear(text);
        if (near) { hideList(); showNotice({ kind: 'near', text, near }); return false; }

        add(text, true);
        input.value = '';
        hideList();
        clearNotice();
        return true;
    }

    // ── Suggestions dropdown ───────────────────────────────────────────────
    const hideList = () => { list.classList.add('hidden'); activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };

    function updateList() {
        const q = normalizeArtist(input.value);
        if (!q) { hideList(); return; }
        const taken = new Set(acts.map(a => normalizeArtist(a.name)));
        const starts = [], contains = [];
        for (const [k, display] of known()) {
            if (taken.has(k)) continue;
            if (k.startsWith(q)) starts.push(display);
            else if (k.includes(q)) contains.push(display);
            if (starts.length >= MAX_SUGGESTIONS) break;
        }
        const matches = [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
        activeIdx = -1;
        if (!matches.length) { hideList(); return; }

        list.innerHTML = matches.map((m, i) => `
            <li role="option" data-value="${escapeHtml(m)}" id="${listId}-opt-${i}"
                class="px-4 py-2.5 text-sm font-bold text-slate-700 cursor-pointer hover:bg-indigo-50">${escapeHtml(m)}</li>`).join('');
        list.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
    }

    function highlight(idx) {
        const items = [...list.querySelectorAll('[data-value]')];
        items.forEach((li, i) => li.classList.toggle('bg-indigo-50', i === idx));
        activeIdx = idx;
        if (items[idx]) input.setAttribute('aria-activedescendant', items[idx].id);
    }

    function pick(value) {
        add(value, false);
        input.value = '';
        hideList();
        clearNotice();
        input.focus();          // ready to type the next one
    }

    // mousedown (not click) so it fires before the input loses focus
    list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('[data-value]');
        if (!li) return;
        e.preventDefault();
        pick(li.dataset.value);
    });

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', () => { clearNotice(); updateList(); });
    input.addEventListener('focus', () => { if (input.value) updateList(); });
    input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('[data-value]');
        const open = !list.classList.contains('hidden') && items.length;
        if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight(Math.min(activeIdx + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
        else if (e.key === 'Enter') {
            e.preventDefault();               // never submit the editor form
            if (open && activeIdx >= 0) pick(items[activeIdx].dataset.value);
            else commitText();
        }
        else if (e.key === 'Escape') hideList();
    });
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !list.contains(e.target)) hideList();
    });

    // ── Public API ─────────────────────────────────────────────────────────
    return {
        getValues:   () => acts.map(a => a.name),
        getNewNames: () => acts.filter(a => a.isNew).map(a => a.name),
        setValues(names) {
            acts = [];
            (names || []).forEach(addResolved);
            render();
            input.value = '';
            hideList();
            clearNotice();
        },
        clear() { this.setValues([]); },
        focus:  () => input.focus(),
        /** Call before saving: turns any half-typed text into a pill. false = a notice is showing and needs a decision. */
        commitPending: () => commitText(),
    };
}
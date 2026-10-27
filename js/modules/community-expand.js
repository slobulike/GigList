/**
 * GigList — community-expand.js
 * Pane-local "expanded view" overlay for Community charts and the map.
 *
 * Why not reuse the personal #chartModal? The Community pane contract says no
 * ids and no dependence on personal markup/globals, so this builds its own
 * overlay, appends it to <body>, and hands back a handle the pane closes in
 * its disposer (the overlay lives outside the pane element, so dispose must
 * close it explicitly).
 *
 *   const exp = openExpanded({
 *       title: 'Top artists',
 *       subtitle: 'Most-seen headliners',
 *       onOpen: (body, api) => { ... build chart / map into body ... },
 *       onClose: () => { ... destroy chart / map ... },
 *   });
 *   exp.close();            // idempotent
 */

export const expandButtonHtml = (key, label) => `
    <button type="button" data-expand="${key}" aria-label="Expand ${label}"
            class="flex-shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-slate-300 hover:text-indigo-600 hover:bg-slate-50 active:scale-95 transition-all">
        <i data-lucide="maximize-2" class="w-4 h-4" aria-hidden="true"></i>
    </button>`;

export function openExpanded({ title, subtitle = '', wide = true, onOpen, onClose } = {}) {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    let closed = false;

    const root = document.createElement('div');
    root.className = 'fixed inset-0 z-[1000] flex items-center justify-center p-3 sm:p-8 bg-slate-900/60 backdrop-blur-sm';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', title || 'Expanded view');
    root.innerHTML = `
        <div class="bg-white rounded-[2rem] shadow-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-2xl'} max-h-full flex flex-col overflow-hidden">
            <div class="flex items-start justify-between gap-4 p-6 pb-3">
                <div class="min-w-0">
                    <h3 data-role="title" class="text-lg font-black text-slate-800 truncate"></h3>
                    <p data-role="subtitle" class="text-[10px] font-black uppercase tracking-widest text-slate-400"></p>
                </div>
                <button type="button" data-close aria-label="Close"
                        class="flex-shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 active:scale-95 transition-all">
                    <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
                </button>
            </div>
            <div data-role="body" class="flex-1 min-h-0 overflow-y-auto p-6 pt-2"></div>
        </div>`;

    root.querySelector('[data-role="title"]').textContent = title || '';
    const subEl = root.querySelector('[data-role="subtitle"]');
    subEl.textContent = subtitle;
    const body = root.querySelector('[data-role="body"]');

    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        try { onClose?.(); } catch (err) { console.warn('community expand: onClose failed', err); }
        root.remove();
        document.body.style.overflow = previousOverflow;
        try { previousFocus?.focus?.(); } catch (_) { /* element gone */ }
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key !== 'Tab') return;
        // Minimal focus trap
        const f = [...root.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')]
            .filter(n => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    root.addEventListener('click', (e) => {
        if (e.target === root || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
    root.querySelector('[data-close]').focus();

    const api = {
        body,
        close,
        setSubtitle: (t) => { subEl.textContent = t; },
        isClosed: () => closed,
    };
    Promise.resolve(onOpen?.(body, api)).catch(err => console.warn('community expand: onOpen failed', err));
    return api;
}
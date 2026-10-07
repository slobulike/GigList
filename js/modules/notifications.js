/**
 * GigList - Notifications Module
 * v1.0.0 — October 2026
 *
 * Data layer + inbox rendering for the `notifications` table (see
 * 001_notifications.sql). Rows are written by DB triggers only; the client
 * reads them, listens for new ones, and sets read_at.
 *
 * ─── WIRING ───────────────────────────────────────────────────────────────────
 *
 * 1. Dot: injected automatically onto the header avatar (#userIdentity). Any
 *    other element with [data-notif-dot] is shown/hidden too.
 *
 * 2. Inbox: call renderNotificationList(container) each time the Profile view
 *    opens. It returns how many rows it drew (0 = nothing to show, so the
 *    caller can hide the card).
 *
 * 3. Init once after sign-in:
 *      initNotifications({
 *          openShow:           ({ id, key }) => { ... },  // open the owner's own show
 *          openCollectionItem: (itemId)      => { ... },  // the viewer's own item
 *          openBuddyCollection: (buddyId, buddyName) => { ... },  // memory tags
 *      });
 *    The open* handlers are passed in because this module doesn't know how the
 *    app opens its own gig / collection modals.
 *
 * When a new notification arrives, a 'giglist:notifications-changed' event is
 * dispatched on window; whoever owns the visible inbox decides whether to
 * re-render it.
 *
 * A dot, not a count, on purpose: it says "something is waiting" without
 * turning into a number to chase.
 */

import { supabase } from './supabase.js';
import { escapeHtml, safeUrl } from './utils.js';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _uid      = null;
let _channel  = null;
let _handlers = {};
let _unread   = 0;

const CHANGED_EVENT = 'giglist:notifications-changed';

// ─── UNREAD DOT ───────────────────────────────────────────────────────────────

// The header avatar's circle clips overflow, so the dot hangs off its clickable
// parent (#userIdentity) instead. Inline styles so it doesn't depend on which
// Tailwind utilities happen to be compiled in.
function ensureHeaderDot() {
    const host = document.getElementById('userIdentity');
    if (!host || host.querySelector('[data-notif-dot]')) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const dot = document.createElement('span');
    dot.setAttribute('data-notif-dot', '');
    dot.className = 'hidden';
    dot.style.cssText = 'position:absolute;top:-2px;right:-2px;width:12px;height:12px;' +
                        'border-radius:9999px;background:#f43f5e;box-shadow:0 0 0 2px #fff;pointer-events:none;';
    host.appendChild(dot);
}

function paintDots() {
    ensureHeaderDot();
    document.querySelectorAll('[data-notif-dot]').forEach(el => {
        el.classList.toggle('hidden', _unread === 0);
        el.setAttribute('aria-hidden', String(_unread === 0));
    });
    document.getElementById('userIdentity')?.setAttribute(
        'aria-label',
        _unread ? 'Open your profile, you have new notifications' : 'Open your profile');
}

export function hasUnread() { return _unread > 0; }

async function refreshUnread() {
    if (!_uid) return 0;
    try {
        const { count, error } = await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', _uid)
            .is('read_at', null);
        if (error) throw error;
        _unread = count || 0;
    } catch (e) {
        console.warn('[Notifications] unread check failed:', e.message);
    }
    paintDots();
    return _unread;
}

// ─── INIT / TEARDOWN ──────────────────────────────────────────────────────────

export async function initNotifications(handlers = {}) {
    _handlers = handlers;
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;

    if (_uid === uid && _channel) {          // already running for this user
        await refreshUnread();
        return;
    }
    teardownNotifications();
    _uid = uid;

    await refreshUnread();

    _channel = supabase
        .channel(`notifications:${uid}`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
            async (payload) => {
                await refreshUnread();
                // Only new rows re-render an open inbox; our own mark-as-read
                // UPDATEs would otherwise trigger a pointless second render.
                if (payload.eventType === 'INSERT') window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
            })
        .subscribe();
}

export function teardownNotifications() {
    if (_channel) { supabase.removeChannel(_channel); _channel = null; }
    _uid = null;
    _unread = 0;
    paintDots();
}

// ─── READ STATE ───────────────────────────────────────────────────────────────

export async function markAllRead() {
    if (!_uid) return;
    try {
        const { error } = await supabase
            .from('notifications')
            .update({ read_at: new Date().toISOString() })
            .eq('user_id', _uid)
            .is('read_at', null);
        if (error) throw error;
        _unread = 0;
        paintDots();
    } catch (e) {
        console.warn('[Notifications] mark-all-read failed:', e.message);
    }
}

async function markOneRead(id) {
    if (!_uid || !id) return;
    try {
        await supabase
            .from('notifications')
            .update({ read_at: new Date().toISOString() })
            .eq('id', id)
            .is('read_at', null);
    } catch (e) { /* non-fatal */ }
}

// ─── FETCH + RESOLVE ──────────────────────────────────────────────────────────

/**
 * Newest first. Actors and targets are resolved at read time (ids only are
 * stored), so a renamed buddy or edited show is always current.
 */
export async function fetchNotifications(limit = 50) {
    if (!_uid) return [];
    const { data: rows, error } = await supabase
        .from('notifications')
        .select('id, actor_id, type, reaction_kind, journal_id, collection_item_id, created_at, read_at')
        .eq('user_id', _uid)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.warn('[Notifications] fetch failed:', error.message); return []; }
    if (!rows?.length) return [];

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const actorIds   = uniq(rows.map(r => r.actor_id));
    const journalIds = uniq(rows.map(r => r.journal_id));
    const itemIds    = uniq(rows.map(r => r.collection_item_id));

    const [actors, journals, items] = await Promise.all([
        actorIds.length
            ? supabase.from('profiles').select('id, display_name, username, avatar_url').in('id', actorIds)
            : { data: [] },
        journalIds.length
            ? supabase.from('journals').select('id, journal_key, band, official_venue, date').in('id', journalIds)
            : { data: [] },
        itemIds.length
            ? supabase.from('collection_items').select('id, title, band_name').in('id', itemIds)
            : { data: [] },
    ]);

    const actorById   = new Map((actors.data   || []).map(a => [a.id, a]));
    const journalById = new Map((journals.data || []).map(j => [j.id, j]));
    const itemById    = new Map((items.data    || []).map(i => [i.id, i]));

    return rows.map(r => ({
        ...r,
        actor:   actorById.get(r.actor_id) || null,
        journal: journalById.get(r.journal_id) || null,
        item:    itemById.get(r.collection_item_id) || null,
    }));
}

// ─── COPY ─────────────────────────────────────────────────────────────────────

function actorName(n) {
    return n.actor?.display_name || n.actor?.username || 'A buddy';
}

/** Returns { text, icon } — plain strings, escaped at render time. */
function describe(n) {
    const who = actorName(n);

    if (n.type === 'reaction' && n.journal) {
        const band = n.journal.band || 'your show';
        switch (n.reaction_kind) {
            case 'like':     return { icon: 'heart',    text: `${who} loved your ${band} show` };
            case 'wish':     return { icon: 'sparkles', text: `${who} wishes they'd been at your ${band} show` };
            case 'together': return { icon: 'users',    text: `${who} wants to go to a show with you next time, after seeing your ${band} show` };
            case 'again':    return { icon: 'repeat',   text: `${who} wants to do ${band} again with you` };
        }
    }
    if (n.type === 'reaction' && n.item) {
        return { icon: 'heart', text: `${who} loved your ${n.item.title || 'collection item'}` };
    }
    // A buddy tagged you in one of THEIR memories. The item isn't yours, so
    // it's described without needing the item row.
    if (n.type === 'memory_tag') {
        return { icon: 'disc', text: `${who} tagged you in a memory` };
    }
    // Reaction whose target has since been deleted, or a future type this
    // client doesn't know yet: stay quiet rather than show something wrong.
    return null;
}

function timeAgo(iso) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60)     return 'just now';
    if (secs < 3600)   return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400)  return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function avatarHtml(actor) {
    const name = actor?.display_name || actor?.username || '?';
    const src  = safeUrl(actor?.avatar_url);
    const initials = escapeHtml(name.slice(0, 2).toUpperCase());
    return src
        ? `<img src="${escapeHtml(src)}" alt="" class="w-10 h-10 rounded-full object-cover flex-shrink-0"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <span style="display:none" class="w-10 h-10 rounded-full bg-slate-200 text-slate-600 text-xs font-black items-center justify-center flex-shrink-0">${initials}</span>`
        : `<span class="w-10 h-10 rounded-full bg-slate-200 text-slate-600 text-xs font-black flex items-center justify-center flex-shrink-0">${initials}</span>`;
}

function rowHtml(n) {
    const d = describe(n);
    if (!d) return '';
    const unread = !n.read_at;
    return `
        <button type="button" data-notif-id="${escapeHtml(n.id)}"
                data-notif-journal="${escapeHtml(String(n.journal_id ?? ''))}"
                data-notif-key="${escapeHtml(n.journal?.journal_key ?? '')}"
                data-notif-type="${escapeHtml(n.type)}"
                data-notif-actor="${escapeHtml(n.actor_id ?? '')}"
                data-notif-actor-name="${escapeHtml(actorName(n))}"
                data-notif-item="${escapeHtml(String(n.collection_item_id ?? ''))}"
                class="w-full flex items-center gap-3 px-4 py-3 text-left rounded-2xl transition-colors
                       ${unread ? 'bg-indigo-50 hover:bg-indigo-100' : 'hover:bg-slate-50'}">
            ${avatarHtml(n.actor)}
            <span class="flex-1 min-w-0">
                <span class="block text-sm ${unread ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}">
                    ${escapeHtml(d.text)}
                </span>
                <span class="block text-xs text-slate-400 mt-0.5">${escapeHtml(timeAgo(n.created_at))}</span>
            </span>
            ${unread ? '<span class="w-2.5 h-2.5 rounded-full bg-indigo-600 flex-shrink-0" aria-label="Unread"></span>' : ''}
        </button>`;
}

/**
 * Renders the inbox into `container` and returns how many rows were drawn.
 * Shows the newest `initialCount`, with a button to reveal the rest. Unread
 * rows are highlighted for this view, then everything is marked read, so the
 * highlight shows once and the avatar dot clears.
 */
export async function renderNotificationList(container, { initialCount = 5 } = {}) {
    if (!container) return 0;
    container.setAttribute('aria-live', 'polite');

    const notes = await fetchNotifications();
    const rows  = notes.map(n => ({ n, html: rowHtml(n) })).filter(r => r.html);

    if (!rows.length) {
        container.innerHTML = '';
        return 0;
    }

    const head = rows.slice(0, initialCount).map(r => r.html).join('');
    const tail = rows.slice(initialCount).map(r => r.html).join('');

    container.innerHTML = `
        <div class="space-y-1">${head}</div>
        ${tail ? `
        <div data-notif-tail class="hidden space-y-1 mt-1">${tail}</div>
        <button type="button" data-notif-more
                class="mt-2 px-4 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-indigo-600 transition-colors">
            Show earlier (${rows.length - initialCount})
        </button>` : ''}`;

    if (!container._notifWired) {
        container._notifWired = true;
        container.addEventListener('click', onRowClick);
    }

    if (rows.some(r => !r.n.read_at)) await markAllRead();
    return rows.length;
}

async function onRowClick(e) {
    const more = e.target.closest('[data-notif-more]');
    if (more) {
        more.parentElement.querySelector('[data-notif-tail]')?.classList.remove('hidden');
        more.remove();
        return;
    }

    const row = e.target.closest('[data-notif-id]');
    if (!row) return;
    markOneRead(row.dataset.notifId);

    const journalId = row.dataset.notifJournal;
    const itemId    = row.dataset.notifItem;
    if (row.dataset.notifType === 'memory_tag') {
        // Someone else's collection: open it from their side, not the viewer's own.
        _handlers.openBuddyCollection?.(row.dataset.notifActor, row.dataset.notifActorName);
    } else if (journalId && _handlers.openShow) {
        _handlers.openShow({ id: Number(journalId), key: row.dataset.notifKey || null });
    } else if (itemId && _handlers.openCollectionItem) {
        _handlers.openCollectionItem(itemId);
    }
}
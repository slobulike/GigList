/**
 * GigList - Wishlist Module
 * "Want to see" list — artists the user hasn't seen live yet but wants to.
 * Lives under the "For you" menu, alongside Band Pages and Clashfinder.
 *
 * Two entry points into the same data:
 *  - openWishlistModal()      List-first view with a search-and-add flow,
 *                              wired from the "For you" menu.
 *  - addToWishlist(id, name)  One-tap add for kebab menus elsewhere in the
 *                              app (band mode, another user's profile) where
 *                              the artist is already known — no modal needed.
 *
 * Reuses the artist combobox/cache and find-or-create logic from editor.js
 * so artist search behaves identically everywhere in the app.
 */

import { supabase } from './supabase.js';
import { wireCombobox, loadArtistOptions, getArtistOptions, invalidateArtistCache } from './editor.js';

// ─── STATE ────────────────────────────────────────────────────────────────────

let _items = []; // cached wishlist rows for the current user, most-recent first

// ─── FIND-OR-CREATE ARTIST (same pattern as editor.js saveGig) ────────────────

async function _findOrCreateArtist(name) {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const { data: existing } = await supabase
        .from('artists')
        .select('id, name')
        .ilike('name', trimmed)
        .maybeSingle();

    if (existing) return existing;

    const { data: created, error } = await supabase
        .from('artists')
        .insert({ name: trimmed })
        .select('id, name')
        .single();

    if (error) {
        console.error('Wishlist: failed to create artist', error);
        return null;
    }
    invalidateArtistCache();
    return created;
}

// ─── ONE-TAP ADD (kebab menus: band mode, other profiles, etc.) ───────────────

/**
 * @param {string} artistId   - known artists.id
 * @param {string} artistName - for the toast message
 */
export async function addToWishlist(artistId, artistName) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.showToast?.('Sign in to build your want-to-see list', 'error');
        return;
    }

    const { error } = await supabase
        .from('wishlist')
        .insert({ user_id: session.user.id, artist_id: artistId })
        .select()
        .single();

    // unique(user_id, artist_id) — a duplicate insert is not an error worth surfacing
    if (error && error.code !== '23505') {
        console.error('Wishlist add failed:', error);
        window.showToast?.('Could not add to your list — try again', 'error');
        return;
    }

    window.showToast?.(`${artistName} added to your want-to-see list`, 'success');
}
window.addToWishlist = addToWishlist;

// ─── REMOVE ───────────────────────────────────────────────────────────────────

async function _removeFromWishlist(wishlistId) {
    const { error } = await supabase.from('wishlist').delete().eq('id', wishlistId);
    if (error) {
        console.error('Wishlist remove failed:', error);
        window.showToast?.('Could not remove — try again', 'error');
        return;
    }
    _items = _items.filter(i => i.id !== wishlistId);
    _renderList();
}

// ─── FETCH ────────────────────────────────────────────────────────────────────

async function _loadWishlist() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { _items = []; return; }

    const { data, error } = await supabase
        .from('wishlist')
        .select('id, added_at, note, artist:artists(id, name, spotify_image_url)')
        .eq('user_id', session.user.id)
        .order('added_at', { ascending: false });

    if (error) {
        console.error('Wishlist load failed:', error);
        _items = [];
        return;
    }
    _items = data || [];
}

// ─── RENDER: LIST ─────────────────────────────────────────────────────────────

function _renderList() {
    const container = document.getElementById('wishlist-items');
    if (!container) return;

    if (_items.length === 0) {
        container.innerHTML = `
            <div class="py-10 text-center">
                <p class="text-sm font-bold text-slate-500">Nothing on your list yet.</p>
                <p class="mt-1 text-xs text-slate-400">Think of an artist you'd love to see live — add them below.</p>
            </div>`;
        return;
    }

    container.innerHTML = _items.map(item => {
        const artist = item.artist || {};
        const img = artist.spotify_image_url
            ? `<img src="${artist.spotify_image_url}" alt="" class="h-10 w-10 rounded-full object-cover flex-shrink-0">`
            : `<div class="h-10 w-10 rounded-full bg-indigo-100 flex-shrink-0 flex items-center justify-center text-indigo-600 font-black text-sm">${(artist.name || '?').charAt(0).toUpperCase()}</div>`;

        return `
            <div class="flex items-center gap-3 py-2.5 border-b border-slate-100 last:border-0" data-wishlist-id="${item.id}">
                ${img}
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-bold text-slate-800 truncate">${artist.name || 'Unknown artist'}</div>
                </div>
                <button
                    class="flex-shrink-0 text-slate-300 hover:text-rose-500 transition-colors p-1"
                    data-remove-id="${item.id}" aria-label="Remove from list">
                    <i data-lucide="x" class="w-4 h-4"></i>
                </button>
            </div>`;
    }).join('');

    container.querySelectorAll('[data-remove-id]').forEach(btn => {
        btn.addEventListener('click', () => _removeFromWishlist(btn.dataset.removeId));
    });

    if (window.lucide) lucide.createIcons();
}

// ─── ADD FORM (search combobox, reveals on demand) ─────────────────────────────

function _showAddForm() {
    document.getElementById('wishlist-add-form')?.classList.remove('hidden');
    document.getElementById('wishlist-search')?.focus();
}

async function _submitSearchValue() {
    const input = document.getElementById('wishlist-search');
    const name = input?.value.trim();
    if (!name) return;

    const artist = await _findOrCreateArtist(name);
    if (!artist) {
        window.showToast?.('Could not add that artist — try again', 'error');
        return;
    }

    await addToWishlist(artist.id, artist.name);
    input.value = '';
    document.getElementById('wishlist-search-list')?.classList.add('hidden');
    await _loadWishlist();
    _renderList();
}

function _wireAddForm() {
    const addBtn = document.getElementById('wishlist-show-add');
    if (addBtn) addBtn.onclick = _showAddForm;

    const submitBtn = document.getElementById('wishlist-search-submit');
    if (submitBtn) submitBtn.onclick = _submitSearchValue;

    const input = document.getElementById('wishlist-search');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); _submitSearchValue(); }
        });
    }

    // Same combobox behaviour as editor.js — matches existing artists as you type,
    // free text is allowed for artists not yet in the db (handled by find-or-create).
    wireCombobox('wishlist-search', 'wishlist-search-list', getArtistOptions);
}

// ─── OPEN / CLOSE MODAL ─────────────────────────────────────────────────────────

export async function openWishlistModal() {
    const modal = document.getElementById('wishlist-modal');
    if (!modal) { console.error('Wishlist: #wishlist-modal not found in DOM'); return; }

    loadArtistOptions(); // warm the artist cache for the combobox

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const scrollY = window.scrollY;
    document.body.classList.add('modal-open');
    document.body.dataset.scrollY = scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';

    document.getElementById('wishlist-add-form')?.classList.add('hidden');
    document.getElementById('wishlist-items').innerHTML = `<p class="py-6 text-center text-xs text-slate-400">Loading…</p>`;

    await _loadWishlist();
    _renderList();

    if (window.lucide) lucide.createIcons();
}
window.openWishlistModal = openWishlistModal;

export function closeWishlistModal() {
    const modal = document.getElementById('wishlist-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    const scrollY = parseInt(document.body.dataset.scrollY || '0');
    document.body.classList.remove('modal-open');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, scrollY);
}
window.closeWishlistModal = closeWishlistModal;

// ─── INIT ─────────────────────────────────────────────────────────────────────

export const initWishlist = () => {
    _wireAddForm();
    // Switcher panel entry point wires its own onclick (built lazily on first
    // open, same as Band Pages/Clashfinder) — see switcher.js #menu-wishlist.
};
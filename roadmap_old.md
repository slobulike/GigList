# GigList — Roadmap

## Current State
Production PWA hosted on GitHub Pages. No backend. All data loaded from CSV files at runtime.

**Tech stack:**
- Frontend: Vanilla JS (ES6 modules), Tailwind CSS (CDN), Chart.js, Leaflet
- Data: CSV files (`journal_*.csv`, `venues.csv`, `performances.csv`, `users.csv`)
- Hosting: GitHub Pages (free, zero-ops, keep this)
- Auth: None — user selects their profile from a list on `index.html`

---

## Phase 1 — Add/Edit Form ✅ COMPLETE

In-memory add/edit with CSV export. No backend required.

**What was built:**
- `js/modules/editor.js` — add/edit modal, combobox autocomplete for Artist/Venue/Support, `saveGig()`, `exportCSV()`
- `normalise_journal.py` — standardises setlist.fm-sourced journals to canonical schema
- Edit button wired into gig detail modal
- Add Show button + unsaved-changes banner on Data tab
- Auto-enables upcoming toggle when a future show is saved

**How it works:** Changes write to `window.journalData` in memory. Export CSV downloads the updated file. User manually re-uploads to GitHub to persist across sessions.

**Canonical journal schema (all journals must match this):**
```
Date, Band, Notable Support, Venue, Price, Comments, Went With,
Festival?, Festival Lineups, Photos, Journal Key, OfficialVenue,
Year, Month, Day
```
Journal Key format: `DD/MM/YYYYOfficialVenue` — no separator, e.g. `27/08/1999Little John's Farm`

---

## Phase 2 — Supabase Setup (one afternoon)

> Goal: real database with all existing data imported. App still reads from CSVs — nothing changes in production yet. This phase is purely infrastructure.

**Steps:**
1. Create Supabase project at supabase.com (EU West region). Save Project URL + anon public key.
2. Run SQL schema (see below) in Supabase SQL Editor.
3. Enable Google Auth in Supabase → Authentication → Providers. Add OAuth credential in Google Developer Console with Supabase redirect URL.
4. Import CSVs via Supabase Table Editor drag-and-drop (`venues.csv`, `performances.csv`, all `journal_*.csv` files).
5. Populate `profiles` table from `users.csv` (11 rows — do by hand or use `import_users.py` TBD).
6. Write and test export function: `SELECT * FROM journals WHERE user_id = auth.uid()` → CSV download. Verify data is correct before proceeding.

**Supabase schema:**
```sql
-- Shared across all users (readable by all, writable by service role only)
create table venues (
  id                bigint generated always as identity primary key,
  official_name     text unique not null,
  place_id          text,
  district          text,
  city              text,
  country           text,
  latitude          numeric,
  longitude         numeric,
  capacity          text,
  alternative_names text
);

create table performances (
  id             bigint generated always as identity primary key,
  journal_key    text not null,
  artist         text not null,
  role           text,
  setlist        text,       -- pipe-separated songs
  tour           text,
  setlist_url    text,
  official_venue text,
  date           date,
  year           int,
  month          int,
  day            int
);

-- Per-user (row-level security: users see only their own rows)
create table journals (
  id                bigint generated always as identity primary key,
  user_id           uuid references auth.users not null,
  journal_key       text not null,
  date              date not null,
  band              text not null,
  official_venue    text,
  venue             text,
  festival          boolean default false,
  festival_lineups  text,
  notable_support   text,
  went_with         text,
  comments          text,
  photos            text,
  price             text,
  unique(user_id, journal_key)
);

-- One profile per authenticated user
create table profiles (
  id       uuid references auth.users primary key,
  username text unique not null,
  type     text not null,   -- 'Personal' or 'Band'
  subject  text,            -- band name if type = 'Band'
  rank     int
);
```

**Row Level Security policies to add:**
```sql
alter table journals enable row level security;
alter table profiles enable row level security;

create policy "Users see own journals"
  on journals for all using (auth.uid() = user_id);

create policy "Users see own profile"
  on profiles for all using (auth.uid() = id);

-- venues and performances: readable by all authenticated users
alter table venues enable row level security;
alter table performances enable row level security;

create policy "Authenticated users can read venues"
  on venues for select using (auth.role() = 'authenticated');

create policy "Authenticated users can read performances"
  on performances for select using (auth.role() = 'authenticated');
```

**Decision needed before starting Phase 2:**
Current login is username-based (pick from a list). Supabase Auth uses real email addresses.
Options:
- **Invite-based (recommended for now):** You create accounts for each user from the Supabase dashboard. They receive an invite email and set their own password. You stay in control of who's in.
- **Self-service:** Users sign up themselves. More work to wire up the UI.

---

## Phase 3 — Wire App to Supabase (a weekend)

> Goal: app reads from and writes to Supabase instead of CSVs. CSV export remains as the data portability/backup mechanism.

**Key code changes (all small, well-isolated):**

`data.js` — replace `loadAppData()`:
```js
// BEFORE
const [journalRes] = await Promise.all([fetch(journalUrl), ...]);
let journalData = Papa.parse(await journalRes.text(), {...}).data;

// AFTER
const { data: journalData } = await supabase
  .from('journals')
  .select('*')
  .eq('user_id', supabase.auth.getUser().id);
```

`editor.js` — replace `saveGig()` write (one line, marked with comment in code):
```js
// BEFORE (Phase 1)
journal.push(gigRow);           // writes to window.journalData in memory

// AFTER (Phase 3)
await supabase.from('journals').upsert(gigRow);
```

`editor.js` — replace `exportCSV()`:
```js
// The CSV export button is kept — it becomes a Supabase download
// supabase.from('journals').select('*').csv() returns the data as CSV text
```

`app.js` — replace `index.html` profile picker with Supabase Auth:
```js
// BEFORE: localStorage.getItem('gv_user') → user object from users.csv
// AFTER:  supabase.auth.getUser() → user, then fetch profile from profiles table
```

**Note:** `users.csv` `Type` column value is `'Personal'` not `'Individual'`. One check in `app.js` reads `data.user.Type === 'Band'` — this is correct. The `'Individual'` string only appears in the URL parameter on `index.html` as a mode selector; it maps to `'Personal'` in the CSV filter. Keep this mapping in Phase 3.

---

## Phase 4 — Cloudflare Worker for setlist.fm Sync (an evening)

> Goal: users can trigger their own setlist.fm sync from the settings modal. API key lives in Worker environment variables — never in the repo.

**How it works:**
1. Deploy a ~20-line Cloudflare Worker that proxies the setlist.fm REST API.
2. Worker reads `SETLISTFM_API_KEY` from its environment (set in Cloudflare dashboard, never committed).
3. Browser calls `https://your-worker.workers.dev/setlistfm?username=TragicGurl`.
4. Worker calls setlist.fm API, returns JSON to browser.
5. Browser processes JSON → normalised journal rows → upserts into Supabase.
6. The existing settings modal sync button gets wired up to trigger this flow.

**Note:** Python scripts (venue geocoding, data enrichment) don't need to change in Phase 4. In Phase 3 they write to Supabase via `supabase-py` instead of CSV files. This is an Option A decision — keep scripts local, just change the output target.

---

## Future Ideas (post Phase 4)

- **Gmail ticket search** — MCP OAuth connection to search for "ticket confirmation" emails from ticket sellers. Auto-populate the add-show form. Good for onboarding users who haven't kept records.
- **On This Day push notifications** — service worker already registered. Anniversary banner exists in app. Extend to background push.
- **Companion tagging** — when adding a show, tag companions by email. If they're a GigList user, the show appears in their timeline too.
- **Shareable memory cards** — export any gig detail as a shareable image using `html2canvas`. The ticket/card design is already well-suited for this.
- **Google Maps PlaceID integration** — `venues.csv` already has `PlaceID` column. Use Google Maps API to show real venue info in the gig detail modal.
- **Annual "Your Music Year" summary** — cinematic Wrapped-style home screen card at year-end, built on top of the existing calendar Wrapped data.

---

## Data Architecture Notes

- **The 20-year rule:** The original journal CSV must always be re-derivable from whatever database is in use. The export function is non-negotiable and ships before any other Phase 3 feature.
- **Shared vs per-user:** `venues` and `performances` are shared infrastructure — one copy, all users read it, only service-role/scripts write it. `journals` and `profiles` are per-user.
- **Python enrichment scripts** run locally. They handle venue geocoding (lat/long → city/country via Google Maps), setlist.fm performance data fetching, and cross-referencing new journal entries against existing venues. In Phase 3 they write to Supabase via `supabase-py` instead of CSV files.
- **Setlist pipe separator:** Songs in `performances.Setlist` are separated by `|` (pipe), not comma or hyphen, because song titles frequently contain hyphens and CSV uses commas.
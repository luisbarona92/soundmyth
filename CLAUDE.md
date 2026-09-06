# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SoundMyth is a mobile-first webapp that aggregates upcoming EDM events (DJ shows, festivals, club nights) scraped from Bandsintown, Songkick, Resident Advisor, and festival websites. It has two independent halves connected only through a Supabase `events` table:

1. **Frontend** — a single self-contained `index.html` (vanilla JS, no framework, no build step), deployed as a static site to Vercel at `https://soundmyth.vercel.app`. It reads events from Supabase at runtime via the CDN UMD build of `@supabase/supabase-js`.
2. **Scrapers** — Node ESM scripts in `scraper/` that run weekly via GitHub Actions, populate the `events` table using the Supabase **service** key, and commit refreshed source lists back to the repo.

The frontend never imports scraper code and vice-versa; the database row shape is the only contract between them.

## Commands

**Frontend** — there is no build, bundler, or test suite. Edit `index.html` and open it / serve it statically (e.g. `python -m http.server`). Deployment is a static push to Vercel; `index.html` is the entry point.

**Scrapers** (all run from `scraper/`):
```bash
cd scraper
npm ci                      # install deps
node scrape-extended.js     # run one pipeline step (see pipeline order below)
```
Each step is an independent `node <file>.js` invocation. Run a single step by running its file directly — that is also how the CI workflow runs them.

> ⚠️ The `scripts` block in `scraper/package.json` is **stale** — it references `scrape-all.js` / `export-excel.mjs` / `bandsintown.js` which no longer exist. Ignore `npm run scrape`; the authoritative pipeline is `.github/workflows/weekly-scrape.yml`.

Scrapers require env vars (loaded from `scraper/.env` locally, GitHub Secrets in CI):
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role — bypasses RLS to write events)
- `BIT_APP_ID` (Bandsintown app id)

**Weekly pipeline** (`.github/workflows/weekly-scrape.yml`, Sundays 02:00 UTC, manually triggerable). Order matters:
```
enrich-songkick-urls → scrape-extended → scrape-festivals-bit →
scrape-festivals-direct → enrich-clubs-ra → scrape-clubs-ra → dedupe →
discover-djs → cleanup-junk → enrich-images → validate → purge → commit data/*.json
```
`dedupe.js` MUST run after every scrape (BIT returns festival events fragmented per-DJ; dedupe consolidates them into one event with the full lineup). `purge.js` is the **only** file allowed to delete events by date (15-day retention window).

Three steps added since original docs:
- **`enrich-clubs-ra.js`** — auto-fills `ra_url` for clubs that have none (reads ra.co, no secrets). Run before `scrape-clubs-ra` so new clubs are scraped immediately.
- **`discover-djs.js`** — reads events (anon key), checks non-listed DJs against Resident Advisor, writes `data/artists_candidates.json`. Incremental: only NEW DJs hit RA (cache = committed candidates file). No secrets.
- **`cleanup-junk.js`** — deletes mislabelled events: events whose entire DJ lineup has no EDM presence (not in `artists_all.json`, not RA-verified in `artists_candidates.json`, and not in `artists_allow.json`). **Can permanently delete events** — runs after dedupe, before enrich-images. Respects `artists_allow.json` (manual rescue list) and `artists_block.json` (manual block list). Candidates with `err:true` (RA throttled, result uncertain) are treated as "keep" to avoid false positives.

## Frontend architecture (`index.html`)

Everything lives in one file: inline `<style>` (CSS-variable design system in `:root`), then one big `<script>`. Layout is locked to `max-width:430px` (mobile app shell). Tabs are show/hide `div`s toggled by `switchTab()`; each tab has a `render*()` function. State (saved events, current filters) is module-level `let`s persisted to `localStorage` under `sm_*` keys.

**Two Supabase clients (do not collapse into one):**
- `sb` — authenticated client, `flowType:'implicit'`, persists session. Used only for auth + per-user data (profiles, saved events).
- `sbPublic` — anon client with `persistSession:false`. Used for **all public event reads** so loading works even when a user's token is expired or auth calls hang. Event loading must never depend on auth state.

`loadEvents()` paginates the `events` table in 1000-row pages with retry, maps rows to the in-memory `EVENTS` shape, and caches a capped future-events subset to `localStorage` (`sm_events_cache`) as an offline fallback.

**Hardcoded lookup tables that must be kept in sync:**
- `TOP100_DJS` (Set, ~line 570) — drives "Upcoming Highlights" + DJ spotlight. Mirror of `scraper/data/artists_top100.json`; edit **both** when changing the top-100.
- `FLAGS` / `COUNTRY_ISO` — country→emoji and ISO normalization. Scrapers surface new countries constantly; `FLAGS[country]` always needs a `||'🌍'` fallback, and any ISO code must map in **both** `index.html` (`COUNTRY_ISO`) and `scraper/validate.js` (`COUNTRY_NORM`).

## `events` table shape

Key columns (see `loadEvents()` mapping and the scrapers): `id`, `name`, `venue`, `city`, `country`, `date`, `djs` (array), `genre`, `tags` (array), `price`, `ticket_url`, `img_url`, `source`, `source_id`. `source_id` is the idempotency/dedup key — it **must include the city** when an event can occur in multiple locations, and a scraper may only delete/update its own `source_id` rows (never blanket date deletes).

## Auth & email

Login is passwordless magic link via `sb.auth.signInWithOtp(...)`. Two non-negotiables (both caused real outages — see BUGS.md):
- `emailRedirectTo` must be the **hardcoded** `'https://soundmyth.vercel.app'`, never `location.href` (the link can be opened in a different browser).
- `flowType:'implicit'` (PKCE breaks cross-browser/email-client magic links).

The Supabase project's URL allowlist (Site URL + Redirect URLs) must include the production domain — configured in the Supabase dashboard, not in this repo. Auth emails are sent through a custom SMTP provider (Brevo, port 465) configured in the dashboard; the email template is `email-magic-link.html`. Marketing consent is captured at signup and stored redundantly (localStorage + `profiles` row + auth `user_metadata`) because GoTrue `updateUser` calls can hang.

## Conventions (hard-won — full list in BUGS.md)

- **`onclick` with dynamic strings**: use single outer quotes + `JSON.stringify`, e.g. `onclick='openDetail("${id}")'`. Double-quoted `onclick="fn("x")"` breaks the attribute.
- **Any element with `position:absolute` children needs an explicit `min-height`/`height`**, or it collapses to 0 when an image `onerror`-hides.
- **Form `<input>`s must be `font-size:≥16px`** and rely on `touch-action:manipulation` (on `*`) to stop iOS auto-zoom — the viewport meta tag is not enough.
- **Home sections render independently** — never chain one `render*()` inside another without try/catch, or one failure blanks the whole page.
- **All scraper string fields used with `.method()` need a `|| ''` fallback**, and name normalization strips diacritics via NFD: `.normalize('NFD').replace(/[̀-ͯ]/g,'')`.
- **After a UI translation pass**, grep for leftover Spanish strings (the UI is English; comments/alerts are often Spanish).
- **Image enrichment**: bump `CACHE_VERSION` in `scraper/enrich-images.js` when search logic improves (auto-retries past failures); JS-rendered festival sites (Tomorrowland, EDC) need entries in `FESTIVAL_IMAGE_OVERRIDES`.

## Reference files

- **`OPERATIONS.md`** — step-by-step for adding a DJ / festival / club, the data files in `scraper/data/`, and triggering a manual scrape.
- **`BUGS.md`** — full bug log with root causes and the complete 22-rule preventive table. Read it before non-trivial changes.
- `prototype.html` / `prototype-v1.html` — design prototypes (UI is iterated here before touching `index.html`). `index-pre-redesign.html` is the previous production version, kept for reference only.

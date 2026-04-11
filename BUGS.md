# SoundMyth — Bug Log & Preventive Rules

This file documents every significant bug found in the project, its root cause,
the fix applied, and a rule to avoid repeating it.

---

## BUG-001 · onclick attributes broken when using JSON.stringify
**Status:** Fixed — commit `020ee54` (partial) → `1ff2ccb` (full fix)

**Symptom:** Clicking country / city / DJ / event rows did nothing. No JS error visible.

**Root cause:**
`JSON.stringify("Spain")` returns `"Spain"` with literal double-quote characters.
When embedded inside a double-quoted HTML attribute:
```html
onclick="selectCountry("Spain")"
```
The browser closes the attribute at the first inner `"`, leaving broken JS `selectCountry(`.

**Fix:** Use single quotes for all `onclick` attributes that embed `JSON.stringify()`:
```html
onclick='selectCountry("Spain")'
onclick='openDetail("uuid-here")'
```

**Rule:** Never use double-quote `onclick="..."` when the value contains `JSON.stringify(...)`.
Always use `onclick='...'` for those cases.

---

## BUG-002 · DJ spotlight section invisible when image fails to load
**Status:** Fixed — commit `1ff2ccb`

**Symptom:** The "DJ of the Month" section was completely invisible — no photo, no text.

**Root cause:**
`.dj-spotlight` had no `min-height`. The image had `height:200px`, so the div's height
came entirely from the image. `onerror="this.style.display='none'"` hid the image, collapsing
the div to `height:0`. The text inside was `position:absolute;inset:0` — so with 0 height
on the container, everything disappeared.

**Fix:** Added `min-height:200px; background:#080808;` to `.dj-spotlight`.

**Rule:** Any container whose height depends on a child element that may be hidden/removed
must have an explicit `min-height` if it contains `position:absolute` children.

---

## BUG-003 · Magic link redirected to localhost instead of production
**Status:** Fixed — commit `1ff2ccb` / `5472b85`

**Symptom:** User received the magic link email, clicked it, landed on `localhost:xxxx`
which is not accessible, so login silently failed.

**Root cause:**
```js
emailRedirectTo: location.href   // ← evaluates to whatever URL opened the app
```
If the developer tested locally, `location.href` was `http://localhost:3000`. That URL
was burned into the Supabase token, so clicking the email link sent the user to localhost.

**Fix:** Hardcode the production URL:
```js
emailRedirectTo: 'https://soundmyth.vercel.app'
```

**Rule:** NEVER use `location.href` as `emailRedirectTo`. Always hardcode the production
URL. Store it in a constant at the top of the file:
```js
const SITE_URL = 'https://soundmyth.vercel.app';
```

---

## BUG-004 · Magic link fails when opened in different browser (PKCE cross-browser)
**Status:** Fixed — commit after BUG-003

**Symptom:** Magic link email works in desktop browser but fails when email is opened
in Gmail app / mobile mail client (different from the browser that requested the link).

**Root cause:**
Supabase JS v2 uses **PKCE flow** by default. PKCE generates a `code_verifier` and stores
it in `localStorage` of the browser/tab that called `signInWithOtp`. When the user opens
the email link in a different browser or webview, `localStorage` is empty → code exchange
fails with a cryptic auth error.

**Fix:** Configure the Supabase client to use **implicit flow**:
```js
const sb = supabase.createClient(SB_URL, SB_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true }
});
```
With implicit flow, the access token arrives directly in the URL hash
(`#access_token=...`) — no code exchange needed, works across any browser.

**Supabase Dashboard step (required — code alone is not enough):**
1. Go to https://supabase.com/dashboard/project/ekcwqesvujqsyuykqtap/auth/url-configuration
2. Set **Site URL** → `https://soundmyth.vercel.app`
3. Add to **Redirect URLs** → `https://soundmyth.vercel.app`
Without this, Supabase rejects the redirect even if the code is correct.

**Rule:** For any SPA (no server-side code), always use `flowType: 'implicit'` in the
Supabase client. PKCE is only safe when the redirect goes back to the same browser session
(e.g., mobile OAuth flows, not magic-link emails).

---

## BUG-005 · Null city / venue crashing toUpperCase()
**Status:** Fixed — commit `1ff2ccb`

**Symptom:** App crashed silently for some events; featured cards and DJ spotlight
failed to render.

**Root cause:**
Bandsintown API returns `null` for `city` and `venue` on some events.
`ev.city.toUpperCase()` threw `TypeError: Cannot read property 'toUpperCase' of null`.

**Fix:** Added null-safe fallbacks in `loadEvents()`:
```js
city: e.city || '',
venue: e.venue || '',
```

**Rule:** Always add `|| ''` fallback when mapping API data fields that are used as
strings later. Treat all API response fields as potentially null/undefined.

---

## BUG-006 · UUID event IDs not quoted in onclick handlers
**Status:** Fixed — commit `020ee54`

**Symptom:** Clicking on event rows in early versions did nothing.

**Root cause:**
```js
onclick="openDetail(${ev.id})"
// Generated: onclick="openDetail(550e8400-e29b-41d4-a716-446655440000)"
// JS sees:   openDetail(550e8400 - e29b - ...)  ← arithmetic, not a string
```

**Fix:** Wrap with `JSON.stringify`:
```js
onclick='openDetail(${JSON.stringify(ev.id)})'
// Generated: onclick='openDetail("550e8400-e29b-41d4-a716-446655440000")'
```

**Rule:** Never interpolate raw UUID/string values directly into onclick JS.
Always use `JSON.stringify()` AND single-quote the attribute.

---

## BUG-007 · Festivals showing 1 DJ instead of full lineup (Coachella, Ultra, etc.)
**Status:** Fixed — dedupe Pass 3 festival consolidation

**Symptom:** Coachella showed only "David Guetta" in the lineup. Same for Ultra, Tomorrowland — only 1 DJ per card.

**Root cause:**
Bandsintown creates **one separate event per DJ** at a festival. "David Guetta at Coachella 2026", "Anyma pres. ÆDEN at Coachella", "Heineken House Coachella" — all different `source_id`s, different `name`s, different `venue` strings. The dedupe grouped by (date, venue) but venues didn't match: "Coachella 2026" ≠ "Heineken House Coachella".

**Fix:** Added **Pass 3 (festival consolidation)** in `dedupe.js`:
1. Load known festival names from `festivals_all.json`
2. For events on same date + same city, check if names contain the same festival keyword
3. Merge all matching sub-events into one, combining all DJs

**Naming rule:** When merging, prefer the festival name ("Coachella Valley Music and Arts Festival") over "DJ at Festival" patterns ("Anyma pres. ÆDEN at Coachella").

**Rule:** Festival events from BIT are ALWAYS fragmented per DJ. The dedupe MUST run after every scrape to consolidate them. Never skip the dedupe step in the pipeline.

---

## BUG-008 · Home sections empty (FESTIVALS, CLUB NIGHTS not rendering)
**Status:** Fixed

**Symptom:** UPCOMING HIGHLIGHTS, FESTIVALS, and CLUB NIGHTS sections showed headers but zero cards.

**Root cause:**
`renderFeatured()` called `renderFestivals()` and `renderClubs()` AFTER rendering HIGHLIGHTS. If HIGHLIGHTS crashed (e.g., `ev.genre.toUpperCase()` with null genre, or `FLAGS[ev.country]` returning undefined), the error stopped execution and festivals/clubs never rendered.

**Fix:**
1. Moved `renderFestivals()` and `renderClubs()` to the TOP of `renderFeatured()` — they always execute first
2. Wrapped HIGHLIGHTS rendering in `try/catch`
3. Added null guards: `(ev.genre||'ELECTRONIC').toUpperCase()`, `FLAGS[ev.country]||'🌍'`, `(ev.city||'').toUpperCase()`

**Rule:** Never chain independent render functions inside another function without error isolation. If Section A can crash, Section B and C must not depend on Section A succeeding. Always use defensive `||` fallbacks in template literals that touch API data.

---

## BUG-009 · iOS Safari zoom on input focus
**Status:** Fixed

**Symptom:** When tapping a search box on mobile (DJ, Club, Fest), iOS zoomed in and the view didn't return to normal.

**Root cause:** iOS Safari auto-zooms when an `<input>` has `font-size < 16px`. Our `.search-input` had `font-size: 13px`.

**Fix:**
1. Changed `.search-input` font-size from 13px to **16px** (iOS threshold)
2. Added `maximum-scale=1.0, user-scalable=no` to viewport meta tag

**Rule:** All `<input>` and `<textarea>` elements MUST have `font-size: 16px` or larger to prevent iOS auto-zoom. Check every time a new input field is added.

---

## BUG-010 · Missing country flags (Taiwan, Vietnam, UK, etc.)
**Status:** Fixed

**Symptom:** Some events showed no flag emoji — just empty space or "undefined" text.

**Root cause:** `FLAGS` object was missing entries for Taiwan, Vietnam, Monaco, Bulgaria, UK (short code), USA (short code), and ~15 other countries. Also `COUNTRY_ISO` normalization map was missing `UK → United Kingdom`.

**Fix:** Added all missing countries to both `FLAGS` and `COUNTRY_ISO`.

**Rule:** When adding a new data source or scraper, always run a unique-countries query on the DB and diff against the FLAGS object:
```sql
SELECT DISTINCT country FROM events ORDER BY country;
```
Any country NOT in FLAGS needs to be added with its emoji. Do this check after every major scrape run.

---

## BUG-011 · Dedupe venue normalization breaks on diacritics
**Status:** Fixed

**Symptom:** "Ushuaïa Ibiza" and "Ushuaia Ibiza" were treated as different venues, keeping duplicates.

**Root cause:** The regex `[^a-z0-9\s]` in `normVenue()` stripped ALL non-ASCII characters including diacritics. "Ushuaïa" became "ushuaa" (the ï was removed entirely), not "ushuaia".

**Fix:**
1. Added `.normalize('NFD').replace(/[\u0300-\u036f]/g, '')` to decompose diacritics and strip combining marks BEFORE the ASCII-only regex
2. Added `venueMatch()` with substring containment check for partial venue names ("Amnesia" matches "Amnesia Ibiza")

**Rule:** Any string normalization for matching MUST include Unicode NFD normalization first. Never apply `[^a-z0-9]` directly to strings that may contain diacritics (ü, ë, ñ, é, etc.). Use this pattern:
```js
s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, '')
```

---

## BUG-012 · Multi-city festival source_id collision (Time Warp, Breakaway, etc.)
**Status:** Fixed

**Symptom:** Festivals with editions in multiple cities (Time Warp Mannheim vs Time Warp Buenos Aires) only showed one edition in DB.

**Root cause:** `scrape-festivals-direct.js` generated source_id as `direct_{name}_{year}` without including the city. All editions of the same festival produced the same key, and the last upsert overwrote the previous ones.

**Fix:** Added city to source_id: `direct_{name}_{city}_{year}`

**Rule:** Every `source_id` formula MUST include enough dimensions to make each real-world event unique. For events that can exist in multiple cities, ALWAYS include city in the key. Formula checklist: `source + name + city + date (or year)`.

---

## BUG-013 · scrape-extended.js deleted yesterday's events (breaking 15-day retention)
**Status:** Fixed

**Symptom:** Events from yesterday disappeared from the app instead of showing in grey for 15 days.

**Root cause:** `scrape-extended.js` had an aggressive purge that deleted all events with `date < yesterday` on every run, overriding the intentional 15-day retention window that `purge.js` implements.

**Fix:** Removed the inline purge from `scrape-extended.js`. All purging is now handled exclusively by `purge.js` (keeps 15-day window).

**Rule:** Only ONE file should handle purging: `purge.js`. No other scraper should delete events by date. If a scraper needs to clean up, it should only delete/update its own `source_id` rows, never do blanket date-based deletes.

---

## General Preventive Rules

| # | Rule |
|---|------|
| 1 | Use `onclick='fn(${JSON.stringify(val)})'` — single outer quotes, JSON.stringify for strings |
| 2 | Any div with `position:absolute` children must have explicit `min-height` or `height` |
| 3 | `emailRedirectTo` must always be the hardcoded production URL, never `location.href` |
| 4 | Supabase SPA auth → always `flowType:'implicit'` |
| 5 | Supabase URL allowlist must include production domain (do in dashboard on first deploy) |
| 6 | All API string fields used as `.method()` targets need `|| ''` fallback |
| 7 | Run a Spanish-string grep after any UI translation: `grep -n "VOLVER\|ENVIAR\|GUARDAR\|CANCELAR\|CERRAR"` |
| 8 | **Festival events from BIT are FRAGMENTED per DJ** — dedupe Pass 3 MUST run after every scrape to consolidate them into single events with full lineup |
| 9 | **All `<input>` elements must have `font-size: ≥16px`** to prevent iOS auto-zoom |
| 10 | **Every `source_id` must include city** when an event can exist in multiple locations |
| 11 | **String normalization must use NFD** before stripping non-ASCII: `.normalize('NFD').replace(/[\u0300-\u036f]/g, '')` |
| 12 | **Only `purge.js` deletes by date** — no other scraper may do blanket date-based deletes |
| 13 | **`FLAGS[country]` always needs `\|\|'🌍'` fallback** — new countries appear constantly from scrapers |
| 14 | **After major scrape: run `SELECT DISTINCT country FROM events`** and verify all have flags |
| 15 | **Independent home sections must render independently** — never chain renderB() inside renderA() without try/catch |
| 16 | **Festival DJ lineups are ADDITIVE** — dedupe merges DJs but never removes them. If a DJ disappears from a source, the dedupe won't delete them from the merged list. This is intentional: false positives (extra DJ) are better than false negatives (missing DJ) |

# SoundMyth — Operations Guide

## Architecture Overview

```
DATA SOURCES                    SCRAPERS                      DATABASE
─────────────                   ────────                      ────────
Bandsintown API  ──┐
                   ├──→ scrape-extended.js ────────┐
Songkick (web)   ──┘                               │
                                                    ├──→ Supabase (events table)
Bandsintown API  ──┐                               │
Songkick (web)   ──┼──→ scrape-festivals-bit.js ──┤
                   │                               │
Festival websites ──→ scrape-festivals-direct.js ──┤
                                                    │
Resident Advisor ────→ scrape-clubs-ra.js ─────────┘
                                                    │
                          dedupe.js ←───────────────┤ (consolidate duplicates)
                          enrich-images.js ←────────┤ (add DJ/festival photos)
                          purge.js ←────────────────┘ (remove >15 day old events)
```

## Data Files (scraper/data/)

| File | What | Count | Purpose |
|------|------|-------|---------|
| `artists_all.json` | DJs | 590 | Drives `scrape-extended.js` — each DJ is looked up on BIT + SK |
| `artists_top100.json` | Top 100 DJs | 100 | Used in frontend for UPCOMING HIGHLIGHTS filter + DJ of Month |
| `festivals_all.json` | Festivals | 262 | Drives `scrape-festivals-bit.js` and `scrape-festivals-direct.js` |
| `festivals_top100.json` | Top 100 festivals | 100 | Reference list |
| `clubs_all.json` | Clubs/venues | 163 | Drives `scrape-clubs-ra.js` |
| `clubs_top100.json` | Top 100 clubs | 100 | Reference list |
| `dj_images_cache.json` | DJ→photo URL | ~471 | TheAudioDB cache (v2: smart name variants + overrides) |
| `festival_images_cache.json` | Festival→og:image | ~36 | Website image cache + JS-rendered fallbacks |

---

## Weekly Pipeline (GitHub Actions — Sundays 2:00 UTC)

```
Step 0:  enrich-songkick-urls.js   (5 min)   → auto-find SK URLs for new DJs
Step 1:  scrape-extended.js        (40 min)  → 852 DJs × BIT API + Songkick cascade
Step 2:  scrape-festivals-bit.js   (10 min)  → 262 festivals × BIT + SK
Step 3:  scrape-festivals-direct.js (3 min)  → festivals without SK: fetch their website
Step 4:  enrich-clubs-ra.js        (10 min)  → auto-fill ra_url for clubs without one (ra.co only, no secrets)
Step 5:  scrape-clubs-ra.js        (10 min)  → 163+ clubs × RA GraphQL (3-strategy fallback)
Step 6:  dedupe.js                 (3 min)   → merge duplicates + festival consolidation (6 passes)
Step 7:  discover-djs.js           (15 min)  → find unlisted EDM DJs via RA verification; writes artists_candidates.json
Step 8:  cleanup-junk.js           (12 min)  → delete events whose DJs have no EDM presence; ⚠️ can permanently delete
Step 9:  enrich-images.js          (20 min)  → DJ photos (name variants + CACHE_VERSION=4) + festival og:images
Step 10: validate.js               (1 min)   → auto-fix data quality (genres, countries)
Step 11: purge.js                  (1 min)   → delete events >15 days old + orphaned saved_events rows
Step 12: Commit updated JSONs to repo
Total: ~120 minutes (timeout: 120 min)
```

> ⚠️ **cleanup-junk.js** permanently deletes events from Supabase. It keeps events whose DJ bill contains at least one artist from `artists_all.json`, an RA-verified candidate in `artists_candidates.json` (`onRA:true` or `err:true`), or `artists_allow.json`. Add DJs to `artists_allow.json` to rescue false-positive deletions.

---

## HOW TO: Add a New DJ

### Option A: Edit on GitHub (easiest)

1. Go to https://github.com/SoundMyth/soundmyth/edit/main/scraper/data/artists_all.json
2. Add a new entry at the end of the array (before the closing `]`):
```json
  {
    "ranking": 504,
    "name": "Boris Brejcha",
    "genre": "Minimal Techno",
    "subgenre": "High-Tech Minimal",
    "tags": "minimal, techno, melodic",
    "tour_web": "",
    "songkick_url": "",
    "bit_url": "",
    "ra_url": ""
  }
```
3. Commit the change
4. Go to Actions → Weekly Scrape & Purge → Run workflow
5. The scraper will auto-find the DJ on BIT and Songkick and pull all their events

### Option B: Edit locally

1. Edit `scraper/data/artists_all.json` — add the DJ entry
2. (Optional) Run `node enrich-songkick-urls.js` to auto-find their SK URL
3. Push to GitHub
4. Trigger the workflow or wait for Sunday

### What you need to provide:
- **name** (required) — exact artist name as it appears on BIT/SK
- **genre** (required) — for frontend display
- **tags** (optional) — comma-separated, used for filtering

### What gets auto-filled:
- Songkick URL (found automatically by `enrich-songkick-urls.js`)
- BIT events (searched by name automatically)
- Artist photo (fetched from TheAudioDB by `enrich-images.js`)

---

## HOW TO: Add a New Festival

1. Edit `scraper/data/festivals_all.json` — add:
```json
  {
    "ranking": 263,
    "name": "DGTL Amsterdam",
    "city": "Amsterdam",
    "country": "Netherlands",
    "website": "https://dfrn.nl/dgtl/",
    "sk_url": ""
  }
```
2. The pipeline will:
   - Search BIT for events matching the name
   - Search Songkick for the festival (auto-fills `sk_url`)
   - If no SK URL found, fetch the website directly for dates
   - Extract og:image from the website for the card photo

---

## HOW TO: Add a New Club

1. Edit `scraper/data/clubs_all.json` — add:
```json
  {
    "ranking": 164,
    "name": "Printworks",
    "city": "London",
    "country": "UK",
    "website": "https://printworkslondon.co.uk",
    "ra_url": "https://ra.co/clubs/84498"
  }
```
2. The `ra_url` is required — find it by searching on https://ra.co

---

## HOW TO: Trigger a Manual Scrape

1. Go to https://github.com/SoundMyth/soundmyth/actions
2. Click "Weekly Scrape & Purge" in the left sidebar
3. Click "Run workflow" → "Run workflow"
4. Watch the logs in real-time (~35 minutes)

---

## HOW TO: Add a DJ to the Top 100 (affects UPCOMING HIGHLIGHTS)

The Top 100 list is in TWO places:
1. `scraper/data/artists_top100.json` — reference file
2. `web/index.html` — the `TOP100_DJS` Set (hardcoded for frontend performance)

To add a DJ to HIGHLIGHTS, you must update the `TOP100_DJS` Set in `index.html`.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| DJ has 0 events | Name doesn't match BIT/SK | Check exact spelling on bandsintown.com |
| Festival shows 1 DJ | Dedupe didn't run | Trigger workflow manually (dedupe consolidates) |
| Events duplicated | Dedupe missed them | Check venue name normalization (BUG-011) |
| Workflow fails | Usually timeout or API rate limit | Check Actions log, re-run |
| Missing flag | Country not in FLAGS object | Add to index.html FLAGS + COUNTRY_ISO |
| No photo on event | DJ not on TheAudioDB | enrich-images.js v2 tries name variants; fallback to city/country |
| Festival no photo | JS-rendered site (Tomorrowland, EDC) | Add to `FESTIVAL_IMAGE_OVERRIDES` in enrich-images.js |
| Image cache stale | New search logic not applied | Bump `CACHE_VERSION` in enrich-images.js → auto-clears failed lookups |

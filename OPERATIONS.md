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
| `artists_all.json` | DJs | 503 | Drives `scrape-extended.js` — each DJ is looked up on BIT + SK |
| `artists_top100.json` | Top 100 DJs | 100 | Used in frontend for UPCOMING HIGHLIGHTS filter + DJ of Month |
| `festivals_all.json` | Festivals | 262 | Drives `scrape-festivals-bit.js` and `scrape-festivals-direct.js` |
| `festivals_top100.json` | Top 100 festivals | 100 | Reference list |
| `clubs_all.json` | Clubs/venues | 163 | Drives `scrape-clubs-ra.js` |
| `clubs_top100.json` | Top 100 clubs | 100 | Reference list |
| `dj_images_cache.json` | DJ→photo URL | ~437 | TheAudioDB cache to avoid re-fetching |
| `festival_images_cache.json` | Festival→og:image | ~28 | Website image cache |

---

## Weekly Pipeline (GitHub Actions — Sundays 2:00 UTC)

```
Step 1: scrape-extended.js      (16 min)  → 503 DJs × BIT API + Songkick
Step 2: scrape-festivals-bit.js (10 min)  → 262 festivals × BIT + SK
Step 3: scrape-festivals-direct.js (3 min) → festivals without SK: fetch their website
Step 4: scrape-clubs-ra.js      (2 min)   → 163 clubs × RA GraphQL
Step 5: dedupe.js               (3 min)   → merge duplicates + festival consolidation
Step 6: enrich-images.js        (varies)  → add DJ/festival photos
Step 7: purge.js                (1 sec)   → delete events >15 days old
Step 8: Commit updated JSONs to repo
```

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
| No photo on event | DJ not on TheAudioDB | Can't fix — fallback to city/country image |

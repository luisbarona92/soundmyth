/**
 * SoundMyth – Image Enricher
 *
 * Finds events missing img_url and enriches them with DJ artist photos
 * from TheAudioDB (free API, no key required).
 *
 * Priority: event's own img > first DJ's artist photo > leave empty (frontend uses country fallback)
 *
 * Caches DJ→image lookups to avoid repeated API calls.
 *
 * Usage: node enrich-images.js
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) { console.error('Missing Supabase env vars'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── DJ Image Cache ──────────────────────────────────────────────────────────
const CACHE_PATH = resolve(__dirname, 'data/dj_images_cache.json');
let djCache = {};
if (existsSync(CACHE_PATH)) {
  try { djCache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { djCache = {}; }
}

function saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(djCache, null, 2));
}

// ── TheAudioDB lookup ───────────────────────────────────────────────────────
async function fetchDJImage(name) {
  const key = name.toLowerCase().trim();
  if (key in djCache) return djCache[key]; // cached (could be null = not found)

  try {
    const url = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    const artist = json.artists?.[0];
    const img = artist?.strArtistThumb || artist?.strArtistFanart || artist?.strArtistBanner || null;
    djCache[key] = img;
    return img;
  } catch {
    djCache[key] = null;
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== SoundMyth – Image Enricher ===\n');

  // Fetch all future events missing img_url
  const today = new Date().toISOString().split('T')[0];
  let allEvents = [];
  let from = 0;

  while (true) {
    const { data, error } = await sb
      .from('events')
      .select('id, name, djs, img_url')
      .gte('date', today)
      .or('img_url.is.null,img_url.eq.')
      .range(from, from + 999)
      .order('date', { ascending: true });

    if (error) { console.error('Fetch error:', error.message); break; }
    allEvents = allEvents.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`Events without images: ${allEvents.length}`);

  // Filter to events that have at least one DJ
  const enrichable = allEvents.filter(e => e.djs?.length > 0);
  console.log(`Events with DJs to look up: ${enrichable.length}`);

  // Collect unique DJ names (try first DJ of each event)
  const uniqueDJs = [...new Set(enrichable.map(e => e.djs[0]))];
  console.log(`Unique DJs to look up: ${uniqueDJs.length}`);

  // Filter out already cached
  const toFetch = uniqueDJs.filter(dj => !(dj.toLowerCase().trim() in djCache));
  console.log(`New lookups needed: ${toFetch.length} (${uniqueDJs.length - toFetch.length} cached)\n`);

  // Fetch images from TheAudioDB
  let found = 0, notFound = 0;
  for (let i = 0; i < toFetch.length; i++) {
    const dj = toFetch[i];
    const pct = Math.round((i + 1) / toFetch.length * 100);
    process.stdout.write(`  [${i + 1}/${toFetch.length}] ${pct}% | ${dj.padEnd(30)}`);

    const img = await fetchDJImage(dj);
    if (img) {
      found++;
      console.log(`  found`);
    } else {
      notFound++;
      console.log(`  -`);
    }

    // Save cache every 50 lookups
    if ((i + 1) % 50 === 0) saveCache();
    await sleep(300); // rate limit
  }

  saveCache();
  console.log(`\nLookup complete: ${found} found, ${notFound} not found`);

  // Update Supabase events with DJ images
  console.log('\nUpdating events in Supabase...');
  let updated = 0, skipped = 0;
  const BATCH = 50;

  for (let i = 0; i < enrichable.length; i += BATCH) {
    const batch = enrichable.slice(i, i + BATCH);
    for (const ev of batch) {
      const dj = ev.djs[0];
      const img = djCache[dj.toLowerCase().trim()];
      if (!img) { skipped++; continue; }

      const { error } = await sb
        .from('events')
        .update({ img_url: img })
        .eq('id', ev.id);

      if (error) {
        console.error(`  Error updating ${ev.id}: ${error.message}`);
      } else {
        updated++;
      }
    }

    const pct = Math.round(Math.min(i + BATCH, enrichable.length) / enrichable.length * 100);
    process.stdout.write(`  ${pct}% (${updated} updated, ${skipped} no image)\r`);
  }

  console.log(`\n\nDone! ${updated} events enriched with DJ images, ${skipped} skipped (no image found)`);
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

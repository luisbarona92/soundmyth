/**
 * SoundMyth – Image Enricher
 *
 * Two-pass enrichment:
 *   Pass 1: Festival events → fetch og:image from festival's own website
 *   Pass 2: DJ events → fetch artist photo from TheAudioDB
 *
 * Caches both festival→image and DJ→image lookups to avoid repeated calls.
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── Caches ──────────────────────────────────────────────────────────────────
const DJ_CACHE_PATH = resolve(__dirname, 'data/dj_images_cache.json');
const FEST_CACHE_PATH = resolve(__dirname, 'data/festival_images_cache.json');

let djCache = {};
let festCache = {};
if (existsSync(DJ_CACHE_PATH)) { try { djCache = JSON.parse(readFileSync(DJ_CACHE_PATH, 'utf8')); } catch { djCache = {}; } }
if (existsSync(FEST_CACHE_PATH)) { try { festCache = JSON.parse(readFileSync(FEST_CACHE_PATH, 'utf8')); } catch { festCache = {}; } }

function saveDJCache() { writeFileSync(DJ_CACHE_PATH, JSON.stringify(djCache, null, 2)); }
function saveFestCache() { writeFileSync(FEST_CACHE_PATH, JSON.stringify(festCache, null, 2)); }

// ── Festival og:image lookup ────────────────────────────────────────────────
async function fetchFestivalImage(url) {
  const key = url.toLowerCase().replace(/\/+$/, '');
  if (key in festCache) return festCache[key];

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) { festCache[key] = null; return null; }
    const html = await res.text();

    // Try og:image first, then twitter:image
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
               || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
               || null;

    // Validate: must be a real image URL (not empty, not a tracking pixel)
    const img = ogImg && ogImg.startsWith('http') && !ogImg.includes('1x1') && !ogImg.includes('pixel')
      ? ogImg : null;

    festCache[key] = img;
    return img;
  } catch {
    festCache[key] = null;
    return null;
  }
}

// ── TheAudioDB DJ lookup ────────────────────────────────────────────────────
async function fetchDJImage(name) {
  const key = name.toLowerCase().trim();
  if (key in djCache) return djCache[key];

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
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SoundMyth – Image Enricher                  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Load festivals_all.json for website URLs
  const FESTIVALS_PATH = resolve(__dirname, 'data/festivals_all.json');
  const festivals = existsSync(FESTIVALS_PATH)
    ? JSON.parse(readFileSync(FESTIVALS_PATH, 'utf8')) : [];

  // Build festival name → website lookup (normalize name for fuzzy match)
  const festWebsite = {};
  for (const f of festivals) {
    if (f.website && !f.website.includes('facebook') && !f.website.includes('twitter')) {
      festWebsite[f.name.toLowerCase().trim()] = f.website;
    }
  }
  console.log(`Festival websites loaded: ${Object.keys(festWebsite).length}\n`);

  // Fetch all future events missing img_url
  const today = new Date().toISOString().split('T')[0];
  let allEvents = [];
  let from = 0;

  while (true) {
    const { data, error } = await sb
      .from('events')
      .select('id, name, djs, tags, img_url')
      .gte('date', today)
      .or('img_url.is.null,img_url.eq.')
      .range(from, from + 999)
      .order('date', { ascending: true });

    if (error) { console.error('Fetch error:', error.message); break; }
    allEvents = allEvents.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`Events without images: ${allEvents.length}\n`);

  // ── PASS 1: Festival images ───────────────────────────────────────────────
  const festEvents = allEvents.filter(e => e.tags?.includes('festival'));
  console.log(`── Pass 1: Festival images (${festEvents.length} events) ──`);

  // Match festival events to website URLs
  const festMatches = [];
  for (const ev of festEvents) {
    const nameKey = ev.name.toLowerCase().trim();
    // Try exact match, then partial (festival name contains event name or vice versa)
    let url = festWebsite[nameKey];
    if (!url) {
      for (const [fName, fUrl] of Object.entries(festWebsite)) {
        if (nameKey.includes(fName) || fName.includes(nameKey)) {
          url = fUrl;
          break;
        }
      }
    }
    if (url) festMatches.push({ ev, url });
  }

  console.log(`  Matched to websites: ${festMatches.length}`);

  // Fetch og:images from festival websites
  const uniqueUrls = [...new Set(festMatches.map(m => m.url))];
  const toFetchFest = uniqueUrls.filter(u => !(u.toLowerCase().replace(/\/+$/, '') in festCache));
  console.log(`  New lookups: ${toFetchFest.length} (${uniqueUrls.length - toFetchFest.length} cached)\n`);

  let festFound = 0;
  for (let i = 0; i < toFetchFest.length; i++) {
    const url = toFetchFest[i];
    const pct = Math.round((i + 1) / toFetchFest.length * 100);
    const short = url.replace(/https?:\/\/(www\.)?/, '').slice(0, 35);
    process.stdout.write(`  [${i + 1}/${toFetchFest.length}] ${pct}% | ${short.padEnd(37)}`);

    const img = await fetchFestivalImage(url);
    console.log(img ? '  found' : '  -');

    if ((i + 1) % 20 === 0) saveFestCache();
    if (img) festFound++;
    await sleep(400);
  }
  saveFestCache();
  console.log(`  Lookup: ${festFound} found\n`);

  // Update festival events in Supabase
  let festUpdated = 0;
  for (const { ev, url } of festMatches) {
    const img = festCache[url.toLowerCase().replace(/\/+$/, '')];
    if (!img) continue;

    const { error } = await sb.from('events').update({ img_url: img }).eq('id', ev.id);
    if (!error) festUpdated++;
  }
  console.log(`  Festival events updated: ${festUpdated}\n`);

  // Remove updated festivals from the remaining list
  const festUpdatedIds = new Set(festMatches.filter(m => {
    const img = festCache[m.url.toLowerCase().replace(/\/+$/, '')];
    return !!img;
  }).map(m => m.ev.id));

  const remaining = allEvents.filter(e => !festUpdatedIds.has(e.id));

  // ── PASS 2: DJ images ────────────────────────────────────────────────────
  const djEvents = remaining.filter(e => e.djs?.length > 0);
  console.log(`── Pass 2: DJ images (${djEvents.length} events) ──`);

  const uniqueDJs = [...new Set(djEvents.map(e => e.djs[0]))];
  const toFetchDJ = uniqueDJs.filter(dj => !(dj.toLowerCase().trim() in djCache));
  console.log(`  Unique DJs: ${uniqueDJs.length}, new lookups: ${toFetchDJ.length}\n`);

  let djFound = 0;
  for (let i = 0; i < toFetchDJ.length; i++) {
    const dj = toFetchDJ[i];
    const pct = Math.round((i + 1) / toFetchDJ.length * 100);
    process.stdout.write(`  [${i + 1}/${toFetchDJ.length}] ${pct}% | ${dj.padEnd(30)}`);

    const img = await fetchDJImage(dj);
    console.log(img ? '  found' : '  -');

    if ((i + 1) % 50 === 0) saveDJCache();
    if (img) djFound++;
    await sleep(300);
  }
  saveDJCache();
  console.log(`  Lookup: ${djFound} found\n`);

  // Update DJ events in Supabase
  let djUpdated = 0, djSkipped = 0;
  for (const ev of djEvents) {
    const img = djCache[ev.djs[0].toLowerCase().trim()];
    if (!img) { djSkipped++; continue; }

    const { error } = await sb.from('events').update({ img_url: img }).eq('id', ev.id);
    if (!error) djUpdated++;
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Done!                                        ║`);
  console.log(`║  Festival events enriched : ${String(festUpdated).padStart(5)}              ║`);
  console.log(`║  DJ events enriched       : ${String(djUpdated).padStart(5)}              ║`);
  console.log(`║  Skipped (no image)       : ${String(djSkipped).padStart(5)}              ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

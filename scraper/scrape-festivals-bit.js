/**
 * SoundMyth – Festival Scraper  (BIT → Songkick cascade)
 *
 * For each festival in data/festivals_all.json:
 *   1) Bandsintown API  — by festival name
 *   2) Songkick         — search + scrape /calendar  (fallback when BIT has nothing)
 *
 * Usage: node scrape-festivals-bit.js
 */

import { createClient }  from '@supabase/supabase-js';
import { readFileSync }  from 'fs';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL         = process.env.SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_KEY;
const BIT_APP_ID     = process.env.BIT_APP_ID || 'js_bandsintown';
const FESTIVALS_PATH = resolve(__dirname, 'data/festivals_all.json');

const DELAY_BIT = 650;   // ms between BIT calls
const DELAY_SK  = 900;   // ms between SK calls (more polite)
const BATCH     = 50;

if (!SB_URL || !SB_KEY) {
  console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const sb    = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().split('T')[0];

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SK_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.songkick.com/',
};

async function fetchHTML(url, ms = 12000) {
  try {
    const res = await fetch(url, { headers: SK_HEADERS, signal: AbortSignal.timeout(ms), redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

// ── ISO country → full name ───────────────────────────────────────────────────
const COUNTRY_ISO = {
  'GB':'United Kingdom','UK':'United Kingdom','DE':'Germany','FR':'France',
  'ES':'Spain','NL':'Netherlands','BE':'Belgium','IT':'Italy','PL':'Poland',
  'PT':'Portugal','CH':'Switzerland','AT':'Austria','HR':'Croatia','DK':'Denmark',
  'SE':'Sweden','CZ':'Czechia','NO':'Norway','RO':'Romania','IE':'Ireland',
  'GR':'Greece','HU':'Hungary','RS':'Serbia','TR':'Turkey','US':'United States',
  'CA':'Canada','AU':'Australia','JP':'Japan','MX':'Mexico','BR':'Brazil',
  'AR':'Argentina','CL':'Chile','CO':'Colombia','ZA':'South Africa','IN':'India',
  'CN':'China','TH':'Thailand','SG':'Singapore','ID':'Indonesia','MY':'Malaysia',
  'PH':'Philippines','VN':'Vietnam','TW':'Taiwan','KR':'South Korea',
  'AE':'United Arab Emirates','SA':'Saudi Arabia','IL':'Israel',
};
function normCountry(c) { return COUNTRY_ISO[c] || c || ''; }

// ── 1. BANDSINTOWN ────────────────────────────────────────────────────────────
async function fetchBIT(name) {
  const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(name)}/events`
            + `?app_id=${BIT_APP_ID}&date=upcoming`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function normaliseBIT(e, festName, fallbackCity, fallbackCountry) {
  const dateStr = (e.datetime || e.starts_at || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;
  if (!e.id) return null;
  const v        = e.venue || {};
  const rawTitle = (e.title || '').trim();
  const rawDesc  = (e.description || '').trim();
  const name     = rawTitle || (rawDesc.length <= 120 ? rawDesc : '') || festName;
  const lineup   = Array.isArray(e.lineup) && e.lineup.length ? e.lineup : [];
  return {
    name,
    venue:      v.name    || '',
    city:       v.city    || fallbackCity    || '',
    country:    normCountry(v.country || fallbackCountry || ''),
    date:       dateStr,
    djs:        lineup,
    genre:      'Electronic',
    tags:       ['festival', 'bandsintown'],
    price:      e.free ? 'Free' : '',
    ticket_url: e.offers?.find(o => o.type === 'Tickets')?.url || e.url || '',
    img_url:    e.artist?.image_url || '',
    source:     'bandsintown',
    source_id:  `bit_${e.id}`,
  };
}

// ── 2. SONGKICK ───────────────────────────────────────────────────────────────

/** Search Songkick festivals → return the specific edition page URL */
async function searchSongkick(name) {
  // SK has a dedicated festival search type
  const searchUrl = `https://www.songkick.com/search?utf8=%E2%9C%93&type=festival&query=${encodeURIComponent(name)}`;
  const html = await fetchHTML(searchUrl);
  if (!html) return null;

  // Festival edition URLs: /festivals/{id}-{slug}/id/{edition-id}-{edition-slug}
  const m = html.match(/href="(\/festivals\/\d+[^"?#]+\/id\/\d+[^"?#]+)"/);
  if (!m) return null;

  // Validate: slug should contain at least one significant word from the festival name
  const slug  = m[1].toLowerCase();
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && w !== 'festival');
  if (words.length > 0 && !words.some(w => slug.includes(w))) return null;

  return `https://www.songkick.com${m[1]}`;
}

/** Extract all JSON-LD MusicEvent/Event blocks from HTML */
function extractJSONLD(html) {
  if (!html) return [];
  const events = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const ld    = JSON.parse(m[1]);
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (item['@type'] === 'MusicEvent' || item['@type'] === 'Event') events.push(item);
        if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
          for (const li of item.itemListElement) {
            const inner = li.item || li;
            if (inner['@type'] === 'MusicEvent' || inner['@type'] === 'Event') events.push(inner);
          }
        }
      }
    } catch { /* skip */ }
  }
  return events;
}

/** Extract js-initial-data JSON (Songkick) */
function extractSKInitialData(html) {
  const m = html?.match(/<script id="js-initial-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function normaliseSKConcert(c, festName, fallbackCity, fallbackCountry) {
  const dateStr = (c.start?.date || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;
  const venue   = c.venue?.displayName || '';
  const city    = c.venue?.metroArea?.displayName || fallbackCity || '';
  const country = normCountry(c.venue?.metroArea?.country?.displayName || fallbackCountry || '');
  const lineup  = (c.performance || []).map(p => p.artist?.displayName).filter(Boolean);
  return {
    name:       c.displayName || `${festName} at ${venue || city}`,
    venue, city, country,
    date:       dateStr,
    djs:        lineup,
    genre:      'Electronic',
    tags:       ['festival', 'songkick'],
    price:      '',
    ticket_url: c.uri || '',
    img_url:    '',
    source:     'songkick',
    source_id:  `sk_${c.id}`,
  };
}

function normaliseJSONLD(item, festName, fallbackCity, fallbackCountry) {
  const dateStr = (item.startDate || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;
  const loc     = item.location || item.place || {};
  const addr    = loc.address   || {};
  const urlId   = (item.url || '').match(/\/concerts\/(\d+)/)?.[1]
               || (item.url || '').match(/\/events\/(\d+)/)?.[1];
  return {
    name:       item.name || festName,
    venue:      loc.name  || '',
    city:       addr.addressLocality || addr.addressRegion || fallbackCity || '',
    country:    normCountry(addr.addressCountry || fallbackCountry || ''),
    date:       dateStr,
    djs:        [],
    genre:      'Electronic',
    tags:       ['festival', 'songkick'],
    price:      item.offers?.price ? `${item.offers.price} ${item.offers.priceCurrency || ''}`.trim() : '',
    ticket_url: item.url || item.offers?.url || '',
    img_url:    item.image || '',
    source:     'songkick',
    source_id:  urlId ? `sk_${urlId}` : `sk_fest_${festName}_${dateStr}`.replace(/\W+/g,'_').toLowerCase(),
  };
}

async function scrapeSK(festName, city, country, cachedSkUrl = null) {
  // Use pre-enriched URL if available, otherwise search
  const skUrl = cachedSkUrl || await searchSongkick(festName);
  if (!skUrl) return [];

  // Festival edition page has JSON-LD MusicEvent directly — no need for /calendar
  const html = await fetchHTML(skUrl);
  if (!html || html.length < 500) return [];

  // Parse JSON-LD events from the festival page
  const events = extractJSONLD(html)
    .map(e => normaliseJSONLD(e, festName, city, country))
    .filter(Boolean);

  if (events.length) return events;

  // Fallback: try js-initial-data (older SK pages)
  const initData = extractSKInitialData(html);
  if (initData) {
    const concerts =
      initData?.gigography?.upcomingConcerts  ||
      initData?.calendarData?.upcomingConcerts ||
      initData?.upcomingConcerts               ||
      [];
    return concerts.map(c => normaliseSKConcert(c, festName, city, country)).filter(Boolean);
  }
  return [];
}

// ── UPSERT BUFFER ────────────────────────────────────────────────────────────
let buffer = [], totalUpserted = 0;

async function flushBuffer(force = false) {
  if (!force && buffer.length < BATCH) return;
  if (!buffer.length) return;
  const raw  = buffer.splice(0, buffer.length);
  const seen = new Set();
  const batch = raw.filter(e => { if (seen.has(e.source_id)) return false; seen.add(e.source_id); return true; });
  const { error } = await sb
    .from('events')
    .upsert(batch, { onConflict: 'source_id', ignoreDuplicates: false });
  if (error) console.error(`\n  ❌  Supabase: ${error.message}`);
  else totalUpserted += batch.length;
  process.stdout.write(` ✓${batch.length}`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const festivals = JSON.parse(readFileSync(FESTIVALS_PATH, 'utf8'));

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SoundMyth – Festival Scraper  BIT → SK      ║');
  console.log('║  Source 1: Bandsintown API                   ║');
  console.log('║  Source 2: Songkick (fallback)               ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n📋  ${festivals.length} festivals to process\n`);
  console.log('─'.repeat(68));

  const stats  = { bit: 0, sk: 0, none: 0 };
  const t0     = Date.now();

  for (let i = 0; i < festivals.length; i++) {
    const fest = festivals[i];
    const pct  = Math.round(((i + 1) / festivals.length) * 100);

    if (i > 0 && i % 10 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      const rem     = Math.max(0, Math.round((festivals.length - i) / ((i + 1) / elapsed) / 60));
      process.stdout.write(`\n  ⏱  ~${rem}m remaining\n`);
    }

    process.stdout.write(`\n[${String(i+1).padStart(3)}/${festivals.length}] ${pct.toString().padStart(3)}% │ ${fest.name.padEnd(40)} `);

    // ── Step 1: Bandsintown ────────────────────────────────────────────────
    const bitRaw  = await fetchBIT(fest.name);
    const bitEvts = bitRaw.map(e => normaliseBIT(e, fest.name, fest.city, fest.country)).filter(Boolean);

    if (bitEvts.length) {
      process.stdout.write(`[BIT] → ${bitEvts.length} events`);
      stats.bit++;
      buffer.push(...bitEvts);
      await flushBuffer();
      await sleep(DELAY_BIT);
      continue;
    }

    await sleep(DELAY_BIT);

    // ── Step 2: Songkick (use pre-enriched sk_url if available, else search) ──
    const skEvts = await scrapeSK(fest.name, fest.city, fest.country, fest.sk_url || null);

    if (skEvts.length) {
      process.stdout.write(`[SK]  → ${skEvts.length} events`);
      stats.sk++;
      buffer.push(...skEvts);
      await flushBuffer();
      await sleep(DELAY_SK);
      continue;
    }

    process.stdout.write(`[–]   no events`);
    stats.none++;
    await sleep(DELAY_SK);
  }

  await flushBuffer(true);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const mm = Math.floor(elapsed / 60), ss = elapsed % 60;

  console.log('\n\n╔══════════════════════════════════════════════╗');
  console.log('║  Festival scrape complete                    ║');
  console.log(`║  Time           : ${String(mm+'m'+ss+'s').padEnd(25)} ║`);
  console.log(`║  Via BIT        : ${String(stats.bit).padEnd(25)} ║`);
  console.log(`║  Via Songkick   : ${String(stats.sk).padEnd(25)} ║`);
  console.log(`║  No events      : ${String(stats.none).padEnd(25)} ║`);
  console.log(`║  Total upserted : ${String(totalUpserted).padEnd(25)} ║`);
  console.log('╚══════════════════════════════════════════════╝');
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

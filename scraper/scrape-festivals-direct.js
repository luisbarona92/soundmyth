/**
 * SoundMyth – Direct Festival Website Scraper
 *
 * For festivals NOT covered by BIT or Songkick, fetches their own website
 * and extracts date/location from:
 *   1. JSON-LD @type Festival / Event / MusicEvent
 *   2. meta tags (og:description, article dates)
 *   3. ISO date patterns in HTML
 *
 * Creates 1 Supabase event per festival (no lineup — JS-rendered sites).
 * Only processes festivals that have NO events yet in the current run list.
 *
 * Usage: node scrape-festivals-direct.js
 */

import { createClient }  from '@supabase/supabase-js';
import { readFileSync }  from 'fs';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const TODAY   = new Date().toISOString().split('T')[0];
const DELAY   = 600;   // ms between requests

if (!SB_URL || !SB_KEY) { console.error('❌  Missing Supabase env vars'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent':      UA,
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const FESTIVALS_PATH = resolve(__dirname, 'data/festivals_all.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function normCountry(c) {
  if (!c) return '';
  const map = { 'BE':'Belgium','US':'United States','GB':'United Kingdom','DE':'Germany',
    'NL':'Netherlands','ES':'Spain','FR':'France','IT':'Italy','PT':'Portugal',
    'HR':'Croatia','HU':'Hungary','AT':'Austria','CH':'Switzerland','TH':'Thailand',
    'KR':'South Korea','JP':'Japan','BR':'Brazil','MX':'Mexico','AU':'Australia',
    'CO':'Colombia','AR':'Argentina','ZA':'South Africa','RS':'Serbia','RO':'Romania' };
  return map[c] || c;
}

/** Extract festival event data from page HTML */
function extractFestivalEvent(html, fest) {
  if (!html) return null;

  // 1. JSON-LD: Festival / Event / MusicEvent
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { const j = JSON.parse(m[1]); return Array.isArray(j) ? j : [j]; } catch { return []; } })
    .flat()
    .filter(j => ['Festival','Event','MusicEvent'].includes(j?.['@type']));

  for (const ld of ldBlocks) {
    const startDate = (ld.startDate || '').split('T')[0];
    if (!startDate || startDate < TODAY) continue;

    const loc   = ld.location || {};
    const addr  = loc.address  || {};
    const city    = addr.addressLocality || addr.addressRegion || fest.city || '';
    const country = normCountry(addr.addressCountry || '') || fest.country || '';
    const img     = typeof ld.image === 'string' ? ld.image : ld.image?.url || '';

    return {
      name:       ld.name || fest.name,
      venue:      loc.name || '',
      city, country,
      date:       startDate,
      djs:        [],
      genre:      'Electronic',
      tags:       ['festival'],
      img_url:    img,
      ticket_url: ld.offers?.url || ld.url || fest.website || '',
      source:     'direct',
      source_id:  `direct_${fest.name.replace(/\W+/g,'_').toLowerCase()}_${startDate.slice(0,4)}`,
    };
  }

  // 2. Fallback: find upcoming ISO dates in HTML
  const rawDates = (html.match(/202[6-9]-\d{2}-\d{2}/g) || [])
    .filter(d => d >= TODAY)
    .sort();

  if (!rawDates.length) return null;

  // Take the earliest upcoming date
  const startDate = rawDates[0];

  // Try og:image for the festival image
  const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] || '';

  return {
    name:       fest.name,
    venue:      '',
    city:       fest.city    || '',
    country:    fest.country || '',
    date:       startDate,
    djs:        [],
    genre:      'Electronic',
    tags:       ['festival'],
    img_url:    ogImg,
    ticket_url: fest.website || '',
    source:     'direct',
    source_id:  `direct_${fest.name.replace(/\W+/g,'_').toLowerCase()}_${startDate.slice(0,4)}`,
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const festivals = JSON.parse(readFileSync(FESTIVALS_PATH, 'utf8'));

  // Only process festivals WITHOUT sk_url (already handled by BIT→SK scraper)
  // AND that have a real website (not facebook/twitter)
  const todo = festivals.filter(f =>
    !f.sk_url &&
    f.website &&
    !f.website.includes('facebook') &&
    !f.website.includes('twitter') &&
    !f.website.includes('instagram')
  );

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  SoundMyth – Direct Festival Website Scraper     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n📋  Festivals to try : ${todo.length}  (no SK URL, has website)`);
  console.log(`🗓  Cutoff date      : ${TODAY}  (only future events)\n`);
  console.log('─'.repeat(60));

  let found = 0, skipped = 0, errors = 0, upserted = 0;
  const events = [];

  for (let i = 0; i < todo.length; i++) {
    const fest = todo[i];
    const pct  = String(Math.round(((i + 1) / todo.length) * 100)).padStart(3);
    process.stdout.write(`[${String(i+1).padStart(3)}/${todo.length}] ${pct}% │ ${fest.name.padEnd(38)} `);

    const html = await fetchHTML(fest.website);
    if (!html) {
      process.stdout.write(`✗  fetch error\n`);
      errors++;
      await sleep(DELAY);
      continue;
    }

    const ev = extractFestivalEvent(html, fest);
    if (!ev) {
      process.stdout.write(`–  no upcoming date found\n`);
      skipped++;
      await sleep(DELAY);
      continue;
    }

    process.stdout.write(`✓  ${ev.date}  ${ev.city}, ${ev.country}\n`);
    found++;
    events.push(ev);

    await sleep(DELAY);
  }

  // Upsert all found events
  if (events.length) {
    // Deduplicate by source_id
    const seen = new Set();
    const batch = events.filter(e => { if (seen.has(e.source_id)) return false; seen.add(e.source_id); return true; });

    const { error } = await sb.from('events').upsert(batch, { onConflict: 'source_id', ignoreDuplicates: false });
    if (error) console.error('\n❌  Supabase:', error.message);
    else { upserted = batch.length; }
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Direct scrape complete                          ║');
  console.log(`║  Found upcoming : ${String(found).padEnd(30)}║`);
  console.log(`║  No future date : ${String(skipped).padEnd(30)}║`);
  console.log(`║  Fetch errors   : ${String(errors).padEnd(30)}║`);
  console.log(`║  Total upserted : ${String(upserted).padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (events.length) {
    console.log('\nEvents added:');
    events.forEach(e => console.log(`  ✓ ${e.name.padEnd(35)} ${e.date}  ${e.city}, ${e.country}`));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

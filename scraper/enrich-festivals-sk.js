/**
 * SoundMyth – Enrich Festivals with Songkick URLs
 *
 * Reads data/festivals_all.json, searches SK (type=festival) for each festival
 * WITHOUT a sk_url, fills it in, and saves back to the same file.
 *
 * Usage: node enrich-festivals-sk.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, resolve }            from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, 'data/festivals_all.json');

const DELAY_OK   = 1400;
const DELAY_MISS = 900;
const DELAY_ERR  = 3000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent':      UA,
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.songkick.com/',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHTML(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (res.status === 429 || res.status === 503) return { html: null, limited: true };
    if (!res.ok) return { html: null, limited: false };
    return { html: await res.text(), limited: false };
  } catch {
    return { html: null, limited: false };
  }
}

/** Score how well a SK slug matches the festival name (0–1) */
function score(slug, name) {
  const s    = slug.toLowerCase().replace(/-/g, ' ');
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && w !== 'festival');
  if (!words.length) return 0;
  const hits = words.filter(w => s.includes(w));
  return hits.length / words.length;
}

async function searchSKFestival(name) {
  const url = 'https://www.songkick.com/search?utf8=%E2%9C%93&type=festival&query=' + encodeURIComponent(name);
  const { html, limited } = await fetchHTML(url);
  if (!html) return { url: null, limited };

  // Festival edition URL: /festivals/{id}-{slug}/id/{edition-id}-{edition-slug}
  const matches = [...html.matchAll(/href="(\/festivals\/\d+[^"?#]+\/id\/\d+[^"?#]+)"/g)]
    .map(m => m[1]);

  if (!matches.length) return { url: null, limited: false };

  // Pick the best match by slug score
  const scored = matches.map(m => ({ m, s: score(m, name) })).sort((a, b) => b.s - a.s);
  if (scored[0].s < 0.3) return { url: null, limited: false };  // no reasonable match

  return { url: 'https://www.songkick.com' + scored[0].m, limited: false };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

const festivals = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const todo      = festivals.filter(f => !f.sk_url);
const total     = todo.length;

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  SoundMyth – Enrich Festivals with SK URL        ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`\n📋  Total festivals : ${festivals.length}`);
console.log(`🔍  Missing SK URL  : ${total}\n`);
console.log('─'.repeat(60));

let found = 0, notFound = 0, errors = 0;

for (let i = 0; i < todo.length; i++) {
  const fest = todo[i];
  const pct  = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  process.stdout.write(`[${String(i+1).padStart(3)}/${total}] ${pct}% │ ${fest.name.padEnd(36)} `);

  const { url, limited } = await searchSKFestival(fest.name);

  if (limited) {
    process.stdout.write('⏳ rate limited — waiting 5s\n');
    await sleep(5000);
    errors++;
    continue;
  }

  if (url) {
    // Update in the main array (find by reference)
    const orig = festivals.find(f => f.name === fest.name && f.city === fest.city);
    if (orig) orig.sk_url = url;
    process.stdout.write(`✓  ${url.slice(0, 65)}\n`);
    found++;
    await sleep(DELAY_OK);
  } else {
    process.stdout.write('–  not found on SK\n');
    notFound++;
    await sleep(DELAY_MISS);
  }

  // Save every 20 to avoid data loss
  if ((i + 1) % 20 === 0) writeFileSync(DATA_FILE, JSON.stringify(festivals, null, 2));
}

writeFileSync(DATA_FILE, JSON.stringify(festivals, null, 2));

console.log('\n╔══════════════════════════════════════════════════╗');
console.log(`║  Enrichment complete                              ║`);
console.log(`║  Found     : ${String(found).padEnd(35)}║`);
console.log(`║  Not found : ${String(notFound).padEnd(35)}║`);
console.log(`║  Saved to  : festivals_all.json                  ║`);
console.log('╚══════════════════════════════════════════════════╝');

if (notFound > 0) {
  console.log('\nFestivals NOT found on SK:');
  festivals.filter(f => !f.sk_url).forEach(f => console.log(`  - ${f.name}  (${f.city})`));
}

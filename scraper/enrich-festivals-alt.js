/**
 * SoundMyth – Festival Alternative Name Enricher
 *
 * For festivals WITHOUT a sk_url, tries multiple alternative search queries
 * on Songkick (type=festival) to find matches that the exact name missed.
 *
 * Strategies:
 *   1. Manual alias map (EDC → "Electric Daisy Carnival", etc.)
 *   2. Append/strip "Festival"
 *   3. Name + city as a single query
 *   4. Name without city suffix
 *
 * Usage: node enrich-festivals-alt.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, resolve }            from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, 'data/festivals_all.json');

const DELAY_OK   = 1000;
const DELAY_MISS = 600;
const DELAY_ERR  = 3500;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent':      UA,
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.songkick.com/',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── MANUAL ALIAS MAP ──────────────────────────────────────────────────────────
// For known abbreviations or alternate names SK uses
const ALIASES = {
  // EDC family
  'EDC Las Vegas':           ['Electric Daisy Carnival Las Vegas', 'EDC Las Vegas'],
  'EDC Thailand':            ['Electric Daisy Carnival Thailand'],
  'EDC Mexico':              ['Electric Daisy Carnival Mexico'],
  'EDC China':               ['Electric Daisy Carnival China'],
  'EDC Korea':               ['Electric Daisy Carnival Korea'],
  'EDC Japan':               ['Electric Daisy Carnival Japan'],
  'EDC Orlando':             ['Electric Daisy Carnival Orlando'],
  'EDC Sea':                 ['Electric Daisy Carnival',],
  // Ultra family
  'Ultra Music Festival':    ['Ultra Music Festival Miami', 'Ultra Miami'],
  'Ultra Peru':              ['Ultra Music Festival Peru'],
  'Ultra Buenos Aires':      ['Ultra Music Festival Buenos Aires'],
  'Ultra South Africa':      ['Ultra South Africa'],
  'Ultra Japan':             ['Ultra Japan', 'Ultra Music Festival Japan'],
  'Ultra Beach Australia':   ['Ultra Beach Australia'],
  'Ultra Brasil':            ['Ultra Music Festival Brasil', 'Ultra Brazil'],
  'Ultra Hong Kong':         ['Ultra Hong Kong'],
  'Ultra Korea':             ['Ultra Korea', 'Ultra Music Festival Korea'],
  'Ultra Taiwan':            ['Ultra Taiwan'],
  'Ultra Abu Dhabi':         ['Ultra Abu Dhabi'],
  'Ultra Singapore':         ['Ultra Singapore'],
  'Ultra Beijing China':     ['Ultra Beijing'],
  'Ultra Shanghai China':    ['Ultra Shanghai'],
  'Ultra Beach Spain':       ['Ultra Beach Spain'],
  'Ultra Beach Hvar':        ['Ultra Europe', 'Ultra Beach'],
  'Ultra Beach Bali':        ['Ultra Beach Bali'],
  'Ultra Chile':             ['Ultra Chile'],
  'Tomorrowland Brazil':     ['Tomorrowland Brazil', 'Tomorrowland Brasil'],
  'Resistance Medellin':     ['Resistance Medellin'],
  'Resistance Chile':        ['Resistance Chile'],
  'Resistance Mexico City':  ['Resistance Mexico'],
  'Resistance Peru':         ['Resistance Peru'],
  'Resistance Buenos Aires': ['Resistance Buenos Aires'],
  'Road To Ultra':           ['Road to Ultra'],
  // Specific festivals
  'Untold':                  ['Untold Festival'],
  'AMF':                     ['Amsterdam Music Festival', 'AMF Amsterdam'],
  'Sónar':                   ['Sonar Barcelona', 'Sonar Festival'],
  'Time Warp':               ['Time Warp Mannheim', 'Timewarp'],
  'Creamfields':             ['Creamfields UK', 'Creamfields Festival'],
  'Nature One':              ['Nature One Festival', 'Nature One Germany'],
  'Awakenings':              ['Awakenings Festival'],
  'Loveland':                ['Loveland Festival'],
  'Melt':                    ['Melt Festival', 'Melt Music'],
  'Fusion Festival':         ['Fusion Festival Germany'],
  'Voltage':                 ['Voltage Festival'],
  'Defqon.1':                ['Defqon 1', 'Defqon Festival'],
  'Mysteryland':             ['Mysteryland Festival'],
  'Extrema Outdoor':         ['Extrema Outdoor Festival'],
  'Summum':                  ['Summum Festival'],
  'Tribe Festival':          ['Tribe Festival'],
  'Rainbow Serpent':         ['Rainbow Serpent Festival'],
  'Burning Man':             ['Burning Man 2026'],
  'Nocturnal Wonderland':    ['Nocturnal Wonderland Festival'],
  'Escape Psycho Circus':    ['Escape Psycho Circus', 'Escape Halloween'],
  'Hard Summer':             ['Hard Summer Music Festival'],
  'Beyond Wonderland':       ['Beyond Wonderland Festival'],
  'Dreamstate':              ['Dreamstate Festival'],
  'Electric Forest':         ['Electric Forest Festival'],
  'Movement':                ['Movement Detroit', 'Movement Electronic Music Festival'],
  'Spring Awakening':        ['Spring Awakening Music Festival'],
  'North Coast':             ['North Coast Music Festival'],
  'Decibel Festival':        ['Decibel Festival Seattle'],
  'Shambhala':               ['Shambhala Music Festival'],
  'Subsonic':                ['Subsonic Music Festival'],
  'Let It Roll':             ['Let It Roll Festival'],
  'Outlook':                 ['Outlook Festival'],
  'Dimensions':              ['Dimensions Festival'],
  'Exit':                    ['Exit Festival'],
  'Sunrise Festival':        ['Sunrise Festival Poland'],
  'Sunrise Festival':        ['Sunrise'],
  'Astropolis':              ['Astropolis Festival'],
  'Dour Festival':           ['Dour'],
  'Parklife':                ['Parklife Festival Manchester'],
  'Field Day':               ['Field Day Festival'],
  'Junction 2':              ['Junction 2 Festival'],
  'Hessle Audio':            ['Hessle Audio Festival'],
  'Lovebox':                 ['Lovebox Festival'],
  'Wide Awake':              ['Wide Awake Festival'],
  'Citadel':                 ['Citadel Festival'],
  'Garden Party':            ['Garden Party Festival'],
  'Wild Life':               ['Wild Life Festival'],
  'Love Saves The Day':      ['Love Saves The Day Festival'],
  'SXM Festival':            ['SXM Festival Saint Martin'],
  'BPM Festival':            ['BPM Festival'],
  'Sunburn':                 ['Sunburn Festival'],
  'Vh1 Supersonic':          ['Vh1 Supersonic Festival', 'Supersonic India'],
  'Magnetic Fields':         ['Magnetic Fields Festival'],
  'Bacardi NH7 Weekender':   ['NH7 Weekender'],
  'Sundown Festival':        ['Sundown Festival'],
  'X-Ite Festival':          ['X-Ite'],
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (res.status === 429 || res.status === 503) return { html: null, limited: true };
    if (!res.ok) return { html: null, limited: false };
    return { html: await res.text(), limited: false };
  } catch { return { html: null, limited: false }; }
}

function score(slug, name) {
  const s     = slug.toLowerCase().replace(/-/g, ' ');
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !['festival','music','event'].includes(w));
  if (!words.length) return 0;
  return words.filter(w => s.includes(w)).length / words.length;
}

async function searchSK(query, originalName) {
  const url = `https://www.songkick.com/search?utf8=%E2%9C%93&type=festival&query=${encodeURIComponent(query)}`;
  const { html, limited } = await fetchHTML(url);
  if (!html) return { url: null, limited };

  const matches = [...html.matchAll(/href="(\/festivals\/\d+[^"?#]+\/id\/\d+[^"?#]+)"/g)].map(m => m[1]);
  if (!matches.length) return { url: null, limited: false };

  // Score by match quality to originalName
  const scored = matches.map(m => ({ m, s: score(m, originalName || query) })).sort((a, b) => b.s - a.s);
  if (scored[0].s < 0.25) return { url: null, limited: false };

  return { url: 'https://www.songkick.com' + scored[0].m, limited: false };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

const festivals = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const todo      = festivals.filter(f => !f.sk_url);

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  SoundMyth – Festival Alternative Enricher       ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`\n📋  Festivals without SK URL : ${todo.length}\n`);
console.log('─'.repeat(60));

let found = 0, notFound = 0, errors = 0;

for (let i = 0; i < todo.length; i++) {
  const fest  = todo[i];
  const pct   = String(Math.round(((i + 1) / todo.length) * 100)).padStart(3);
  process.stdout.write(`[${String(i+1).padStart(3)}/${todo.length}] ${pct}% │ ${fest.name.padEnd(36)} `);

  // Build query list to try
  const queries = new Set();
  if (ALIASES[fest.name]) ALIASES[fest.name].forEach(a => queries.add(a));
  queries.add(fest.name);                                           // original
  queries.add(fest.name + ' Festival');                             // + Festival
  queries.add(fest.name.replace(/\s+Festival$/i, ''));              // - Festival
  if (fest.city) queries.add(`${fest.name} ${fest.city}`);         // + city

  let found_url = null;
  let was_limited = false;

  for (const q of queries) {
    const { url, limited } = await searchSK(q, fest.name);
    if (limited) { was_limited = true; break; }
    if (url) { found_url = url; break; }
    await sleep(400);
  }

  if (was_limited) {
    process.stdout.write('⏳ rate limited — waiting 5s\n');
    await sleep(5000);
    errors++;
    continue;
  }

  if (found_url) {
    const orig = festivals.find(f => f.name === fest.name && f.city === fest.city);
    if (orig) orig.sk_url = found_url;
    process.stdout.write(`✓  ${found_url.slice(0, 70)}\n`);
    found++;
    await sleep(DELAY_OK);
  } else {
    process.stdout.write('–  not found\n');
    notFound++;
    await sleep(DELAY_MISS);
  }

  if ((i + 1) % 20 === 0) writeFileSync(DATA_FILE, JSON.stringify(festivals, null, 2));
}

writeFileSync(DATA_FILE, JSON.stringify(festivals, null, 2));

console.log('\n╔══════════════════════════════════════════════════╗');
console.log(`║  Alt enrichment complete                          ║`);
console.log(`║  Found     : ${String(found).padEnd(35)}║`);
console.log(`║  Not found : ${String(notFound).padEnd(35)}║`);
console.log(`║  Errors    : ${String(errors).padEnd(35)}║`);
console.log('╚══════════════════════════════════════════════════╝');

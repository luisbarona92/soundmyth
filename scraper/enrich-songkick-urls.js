/**
 * SoundMyth – Songkick URL Enricher
 *
 * Reads a DJ/artist JSON (default: data/artists_all.json), searches Songkick
 * for each artist WITHOUT a songkick_url, fills it in, and saves the result
 * back to the same file (or an output path).
 *
 * Algorithm:
 *   1. GET https://www.songkick.com/search?query={name}&type=artists
 *   2. Extract all /artists/ID-slug links from the HTML
 *   3. Score each slug against the artist name (normalised)
 *   4. Accept the best match if score ≥ 0.5
 *
 * Usage:
 *   node enrich-songkick-urls.js
 *   node enrich-songkick-urls.js data/artists_all.json          (in-place)
 *   node enrich-songkick-urls.js data/artists_all.json out.json  (separate output)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath }               from 'url';
import { dirname, resolve }            from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INPUT  = resolve(__dirname, process.argv[2] || 'data/artists_all.json');
const OUTPUT = resolve(__dirname, process.argv[3] || process.argv[2] || 'data/artists_all.json');

const DELAY_OK   = 1300;  // ms after a successful fetch
const DELAY_MISS = 800;   // ms after "not found"
const DELAY_ERR  = 2500;  // ms after a rate-limit / error

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent':      UA,
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.songkick.com/',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal:  AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (res.status === 429 || res.status === 503) return { html: null, limited: true };
    if (!res.ok) return { html: null, limited: false };
    return { html: await res.text(), limited: false };
  } catch {
    return { html: null, limited: false };
  }
}

// ── Name normalisation & scoring ──────────────────────────────────────────────

/** Convert artist name to a URL-slug-like string for comparison */
function slugify(name) {
  return name
    .toLowerCase()
    // Explicit replacements for chars that don't decompose via NFD into ASCII
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/ł/g, 'l')
    .replace(/ı/g, 'i').replace(/ñ/g, 'n')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents: ë→e, é→e
    .replace(/ß/g,  'ss')
    .replace(/\bw&w\b/g, 'ww')                       // W&W special case
    .replace(/[&+]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Score how well a Songkick URL path matches an artist name (0–1) */
function matchScore(artistName, skPath) {
  // skPath looks like  /artists/5003643-martin-garrix
  const slugRaw = skPath.replace(/^\/artists\/\d+-/, '').toLowerCase(); // e.g. "martin-garrix"
  const a = slugify(artistName);

  if (!slugRaw || !a) return 0;

  // Perfect match
  if (a === slugRaw) return 1.0;

  // One starts with the other (handles "tiesto" vs "tiesto-official")
  if (slugRaw.startsWith(a + '-') || a.startsWith(slugRaw + '-')) return 0.9;
  if (slugRaw === a.replace(/-/g, '') || slugRaw.replace(/-/g, '') === a) return 0.85;

  // Word-level overlap
  const aWords = a.split('-').filter(w => w.length > 1);
  const sWords = slugRaw.split('-').filter(w => w.length > 1);
  if (!aWords.length) return 0;
  const overlap = aWords.filter(w => sWords.includes(w)).length;
  return overlap / Math.max(aWords.length, sWords.length);
}

// ── Songkick search ───────────────────────────────────────────────────────────

async function findSongkickUrl(artistName) {
  const url = `https://www.songkick.com/search?query=${encodeURIComponent(artistName)}&type=artists`;
  const { html, limited } = await fetchHTML(url);

  if (limited) return { url: null, limited: true };
  if (!html || html.length < 500) return { url: null, limited: false };

  // Songkick returns Cloudflare challenge on heavy rate-limit
  if (/cf-challenge|just a moment|access denied/i.test(html)) {
    return { url: null, limited: true };
  }

  // Extract all unique /artists/ID-slug paths, excluding sub-pages
  const paths = [...new Set(
    [...html.matchAll(/href="(\/artists\/\d+[^"#?\/]+)"/g)]
      .map(m => m[1])
      .filter(p =>
        !p.includes('/calendar') &&
        !p.includes('/gigography') &&
        !p.includes('/similar') &&
        !p.includes('/on-your-radar')
      )
  )];

  if (!paths.length) return { url: null, limited: false };

  // Score & sort
  const scored = paths
    .map(path => ({ path, score: matchScore(artistName, path) }))
    .sort((a, b) => b.score - a.score);

  // Also try: does the HTML contain the artist name near the top result?
  const best = scored[0];

  if (best.score >= 0.5) {
    return { url: `https://www.songkick.com${best.path}`, limited: false, score: best.score };
  }

  // Low-confidence: log for manual review but don't save
  if (best.score > 0) {
    process.stdout.write(`  [low-conf ${best.score.toFixed(2)}: ${best.path}] `);
  }
  return { url: null, limited: false };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const artists = JSON.parse(readFileSync(INPUT, 'utf8'));

  const todo    = artists.filter(a =>
    !a.songkick_skip &&
    (!a.songkick_url || !a.songkick_url.includes('songkick.com'))
  );
  const skipped = artists.filter(a => a.songkick_skip).length;
  const already = artists.length - todo.length - skipped;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  SoundMyth – Songkick URL Enricher               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`   Input / Output : ${INPUT}`);
  console.log(`   Total artists  : ${artists.length}`);
  console.log(`   Already have SK: ${already}`);
  console.log(`   Skipped (flag) : ${skipped}`);
  console.log(`   To search      : ${todo.length}\n`);

  let found = 0, notFound = 0, limited = 0;

  for (let i = 0; i < todo.length; i++) {
    const artist = todo[i];
    const pct    = String(Math.round((i / todo.length) * 100)).padStart(3);
    process.stdout.write(`[${String(i + 1).padStart(3)}/${todo.length}] ${pct}% │ ${artist.name.padEnd(32)} `);

    const result = await findSongkickUrl(artist.name);

    if (result.limited) {
      limited++;
      console.log('⏸  rate-limited – waiting 8s');
      await sleep(8000);
      i--;  // retry same artist
      continue;
    }

    if (result.url) {
      const idx = artists.findIndex(a => a.name === artist.name);
      artists[idx].songkick_url = result.url;
      found++;
      console.log(`✓  ${result.url}  [score: ${result.score?.toFixed(2)}]`);
      await sleep(DELAY_OK);
    } else {
      notFound++;
      console.log('–  not found');
      await sleep(DELAY_MISS);
    }

    // Save progress every 10 artists (in case script is interrupted)
    if ((i + 1) % 10 === 0) {
      writeFileSync(OUTPUT, JSON.stringify(artists, null, 2));
      console.log(`\n  💾 Progress saved (${i + 1}/${todo.length})\n`);
    }
  }

  // Final save
  writeFileSync(OUTPUT, JSON.stringify(artists, null, 2));

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Enrichment complete                             ║');
  console.log(`║  Found:      ${String(found).padEnd(37)}║`);
  console.log(`║  Not found:  ${String(notFound).padEnd(37)}║`);
  console.log(`║  Saved to:   ${OUTPUT.split(/[\\/]/).pop().padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (notFound > 0) {
    console.log('Artists NOT found on Songkick (review manually):');
    artists
      .filter(a => !a.songkick_skip && (!a.songkick_url || !a.songkick_url.includes('songkick.com')))
      .forEach(a => console.log(`  - ${a.name}  (tour_web: ${a.tour_web || '—'})`));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

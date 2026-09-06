/**
 * SoundMyth – discover EDM DJs that are NOT yet in our curated list.
 *
 * Our list (data/artists_all.json) is the gate, but scraping (festival line-ups,
 * club bills) surfaces electronic DJs we don't track yet. Instead of silently
 * dropping their events, we collect them here for manual review.
 *
 * For every DJ that appears on a future event but is NOT in artists_all.json we:
 *   1. count events + which sources mention them + a sample event,
 *   2. verify on Resident Advisor (electronic-only catalogue) → onRA = is-EDM signal.
 *      An EXACT artist match on RA means it's a real electronic act (Shiba San,
 *      Vicetone…). No match → likely off-genre (Gorillaz, MGMT…) → not kept.
 *
 * Output: data/artists_candidates.json — a reviewable list. cleanup-junk.js keeps
 * events whose bill has a DJ from artists_all.json OR an onRA candidate from here,
 * so EDM-but-unlisted DJs are NOT lost; you promote the good ones into
 * artists_all.json by hand whenever you like.
 *
 * Read-only on the DB (anon key from ../index.html). Incremental: previously
 * verified DJs are cached, only new ones hit RA. Set LIMIT_NEW=N to cap RA calls.
 *
 * Usage: node discover-djs.js
 */
import { createClient }            from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath }           from 'url';
import { dirname, resolve }        from 'path';
import { pickCanon }               from './normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readJ = p => { try { return JSON.parse(readFileSync(resolve(__dirname, p), 'utf8')); } catch { return []; } };

// Anon read of the public events table.
// Prefer env vars (SUPABASE_URL + SUPABASE_ANON_KEY, set as GitHub Secrets) so this
// script doesn't depend on parsing index.html. Falls back to the regex if the env
// vars are absent (local runs, or before the secret is added to the repo).
let SB_URL = process.env.SUPABASE_URL;
let SB_KEY = process.env.SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) {
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  SB_URL = SB_URL || (html.match(/SB_URL\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  SB_KEY = SB_KEY || (html.match(/SB_KEY\s*=\s*['"]([^'"]+)['"]/) || [])[1];
}
if (!SB_URL || !SB_KEY) { console.error('❌  Could not resolve SUPABASE_URL / SUPABASE_ANON_KEY (set env vars or check index.html)'); process.exit(1); }
const sb    = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const TODAY = new Date().toISOString().split('T')[0];

const djKey = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
                              .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');

const LIST     = new Set(readJ('data/artists_all.json').map(a => djKey(a.name)));
// Manual EDM allow-list — DJs RA doesn't index but we know are electronic
// (Major Lazer, GRiZ…). Forced onRA:true so they're never dropped/stripped.
const ALLOW    = new Set(readJ('data/artists_allow.json').map(djKey));
// Manual block-list — RA false-positives that are NOT EDM (Florence and The
// Machine…). Forced onRA:false so they're dropped/stripped from line-ups.
const BLOCK    = new Set(readJ('data/artists_block.json').map(djKey));
const CAND_PATH = resolve(__dirname, 'data/artists_candidates.json');
const prev      = readJ('data/artists_candidates.json');
const cache     = new Map(prev.map(c => [c.key || djKey(c.name), c]));   // djKey → previous entry

// ── pull every future event (paged) ────────────────────────────────────────────
let rows = [], from = 0;
while (true) {
  const { data, error } = await sb.from('events').select('name,djs,source,city,date').gte('date', TODAY).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows = rows.concat(data); if (data.length < 1000) break; from += 1000;
}

// ── collect DJs that are NOT in our list ─────────────────────────────────────────
const disc = new Map();   // key → { variants:{disp:count}, events, sources:Set, sample }
for (const e of rows) for (const d of (e.djs || [])) {
  const k = djKey(d); if (!k || LIST.has(k)) continue;
  let o = disc.get(k);
  if (!o) { o = { variants: {}, events: 0, sources: new Set(), sample: null }; disc.set(k, o); }
  o.variants[d] = (o.variants[d] || 0) + 1;
  o.events++; o.sources.add(e.source || '?');
  if (!o.sample) o.sample = `${e.name || ''}${e.city ? ' · ' + e.city : ''}`.slice(0, 70);
}
console.log(`Scanned ${rows.length} future events · ${disc.size} DJs not in our list`);

// ── verify EDM via Resident Advisor (exact artist match), with cache ─────────────
const RA = 'https://ra.co/graphql';
const HRA = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/122 Safari/537.36',
              Referer: 'https://ra.co/', Origin: 'https://ra.co', 'ra-content-language': 'en' };
const AQ = 'query A($s:String!){search(searchTerm:$s,indices:[ARTIST],limit:5){searchType value}}';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// RA has no API key; its GraphQL is rate-limited and — crucially — a throttle returns
// HTTP 200 with an EMPTY search array (not a 429), indistinguishable from a real
// "this artist isn't on RA". If we trusted those empties we'd cache real EDM DJs as
// off-genre and later drop their events. So: an empty result is only trusted once a
// CANARY (an artist certainly on RA) confirms RA is actually answering; otherwise we
// back off and retry, and give up as `null` (re-checked next run) rather than `false`.
const CANARY = 'Charlotte de Witte';
let lastCanaryOk = 0;

async function raArtistHits(name) {
  try {
    const r = await fetch(RA, { method: 'POST', headers: HRA,
      body: JSON.stringify({ query: AQ, variables: { s: name } }), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;                               // transport / HTTP error
    const j = await r.json();
    if (!j || !j.data) return null;
    return (j.data.search || []).filter(x => x.searchType === 'ARTIST');
  } catch { return null; }
}

async function raHealthy() {
  if (Date.now() - lastCanaryOk < 20000) return true;     // trust a recent canary (≤20s)
  const c = await raArtistHits(CANARY);
  if (c && c.length) { lastCanaryOk = Date.now(); return true; }
  return false;
}

async function onRA(name) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const hits = await raArtistHits(name);
    if (hits === null) { await sleep(800 * (attempt + 1)); continue; }   // error → retry
    if (hits.some(x => djKey(x.value) === djKey(name))) return true;     // exact match → EDM
    if (hits.length) return false;                                       // answered, no match → real "not on RA"
    if (await raHealthy()) return false;                                 // empty but RA healthy → real
    await sleep(Math.min(60000, 4000 * 2 ** attempt));                   // empty + throttled → back off
  }
  return null;   // persistent throttle/error → unknown (NOT cached false; re-checked next run)
}

const entries = [...disc.entries()].sort((a, b) => b[1].events - a[1].events);
const LIMIT_NEW = Number(process.env.LIMIT_NEW || 0);   // 0 = no cap
let verified = 0, reused = 0, cap = false;
const out = [];

// small concurrency pool to keep RA polite but finish the first full run in minutes
const POOL = 5;
for (let i = 0; i < entries.length; i += POOL) {
  const batch = entries.slice(i, i + POOL);
  await Promise.all(batch.map(async ([k, o]) => {
    const name = pickCanon(o.variants);
    const c = cache.get(k);
    let ra, err = false;
    if (BLOCK.has(k)) { ra = false; reused++; }  // manual off-genre — RA false-positive
    else if (ALLOW.has(k)) { ra = true; reused++; }   // manual EDM rescue — never hits RA
    else if (c && typeof c.onRA === 'boolean' && !c.err) { ra = c.onRA; reused++; }
    else if (LIMIT_NEW && verified >= LIMIT_NEW) { ra = c?.onRA ?? false; err = true; cap = true; }
    else { ra = await onRA(name); verified++; if (ra === null) { ra = false; err = true; } }
    out.push({ name, key: k, events: o.events, sources: [...o.sources].sort(), onRA: ra, allow: ALLOW.has(k) || undefined, sample: o.sample, err: err || undefined });
  }));
  if (verified && verified % 200 === 0) console.log(`  …verified ${verified} new DJs`);
}

out.sort((a, b) => (b.onRA - a.onRA) || (b.events - a.events) || a.name.localeCompare(b.name));
writeFileSync(CAND_PATH, JSON.stringify(out, null, 2) + '\n');

const edm = out.filter(c => c.onRA).length;
console.log(`✓ artists_candidates.json: ${out.length} DJs · EDM(onRA) ${edm} · off-genre ${out.length - edm}` +
            ` · verified ${verified} new, reused ${reused}${cap ? ` (capped at LIMIT_NEW=${LIMIT_NEW})` : ''}`);
console.log('Top EDM candidates to review:');
out.filter(c => c.onRA).slice(0, 15).forEach(c => console.log(`  ${String(c.events).padStart(3)}×  ${c.name}  [${c.sources.join(',')}]`));
process.exit(0);

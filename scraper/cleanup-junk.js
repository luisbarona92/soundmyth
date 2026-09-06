/**
 * SoundMyth – one-shot / recurring cleanup of mislabelled junk events.
 *
 * Removes future events that are tagged 'festival' but are clearly NOT festivals:
 *   a) the "venue" only repeats the event title (Bandsintown artist listings, e.g.
 *      "Tomorrowland and Dimitri Vegas & Like Mike"), with ≤1 act, or
 *   b) store / merch listings ("Tomorrowland Store").
 *
 * The scrapers now skip creating (a) at the source; this also clears rows that were
 * ingested before that fix. Runs in CI after dedupe. Set DRY=1 to preview only.
 *
 * Usage: node cleanup-junk.js   (DRY=1 node cleanup-junk.js to preview)
 */
import { createClient }  from '@supabase/supabase-js';
import { readFileSync }  from 'fs';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { canonCity, canonCountry, canonStyle, djNorm, buildDjCanon } from './normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) { console.error('❌  Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const sb    = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const TODAY = new Date().toISOString().split('T')[0];

// Our DJ list is THE gate. An event belongs in SoundMyth only if an EDM DJ we
// recognise is on the bill — OR it's a festival (curated festivals may list their
// line-up later). The club/venue being "ours" is NOT a criterion.
//
// "EDM DJ we recognise" = curated list (data/artists_all.json) ∪ discovered DJs that
// verified as electronic on Resident Advisor (data/artists_candidates.json, onRA:true,
// produced by discover-djs.js). That way EDM DJs we don't track yet are kept (and stay
// reviewable in the candidates file) while genuine off-genre acts (rock/jazz) are dropped.
const readJ = p => { try { return JSON.parse(readFileSync(resolve(__dirname, p), 'utf8')); } catch { return []; } };
const djKey  = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');
const ALLOW  = new Set(readJ('data/artists_allow.json').map(djKey));            // manual EDM rescue
const BLOCK  = new Set(readJ('data/artists_block.json').map(djKey));            // manual off-genre (RA false-positives)
const DJ_SET = new Set(readJ('data/artists_all.json').map(a => djKey(a.name)));
for (const c of readJ('data/artists_candidates.json')) if (c.onRA || c.err) DJ_SET.add(c.key || djKey(c.name));
for (const k of ALLOW) DJ_SET.add(k);
for (const k of BLOCK) DJ_SET.delete(k);   // block always wins over keep
// Off-genre acts (rock/pop/jazz that did NOT verify on RA: Gorillaz, The Cure…) —
// stripped from kept line-ups so the app only shows EDM names. ALLOW > BLOCK > onRA.
const OFF = new Set(readJ('data/artists_candidates.json').filter(c => c.onRA === false).map(c => c.key || djKey(c.name)));
for (const k of BLOCK) OFF.add(k);
for (const k of ALLOW) OFF.delete(k);

// Off-scope = not a festival AND no EDM DJ we recognise on the bill (rock/jazz/random
// parties). SoundMyth is EDM-only, driven by the list + RA-verified discoveries.
function offGenre(e) {
  if ((e.tags || []).includes('festival')) return false;
  if ((e.djs || []).some(d => DJ_SET.has(djKey(d)))) return false;
  return true;
}

function isJunk(e) {
  const name = (e.name || '').trim(), venue = (e.venue || '').trim();
  const djs = e.djs || [], tags = e.tags || [];
  if (!tags.includes('festival')) return false;   // only ever touch festival-tagged rows
  if (djs.length > 1) return false;                // real festivals have many acts
  if (venue && venue === name) return true;        // a) venue just repeats the title
  if (/\bstore\b/i.test(name) || /\bstore\b/i.test(venue)) return true;  // b) store listing
  return false;
}

let rows = [], from = 0;
while (true) {
  const { data, error } = await sb.from('events')
    .select('id,name,venue,djs,tags,city,date,img_url,source').gte('date', TODAY).order('date').range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows = rows.concat(data); if (data.length < 1000) break; from += 1000;
}

const junkCount = rows.filter(isJunk).length, ogCount = rows.filter(offGenre).length;
const toRemove = rows.filter(e => isJunk(e) || offGenre(e));
console.log(`Scanned ${rows.length} future events · to remove: ${toRemove.length} (mislabelled ${junkCount} + off-scope/no-DJ ${ogCount})`);
toRemove.slice(0, 40).forEach(e => console.log(`  - ${e.date} ${JSON.stringify((e.name||'').slice(0,46))} [${e.source}] @ ${JSON.stringify(e.venue)}`));

if (process.env.DRY === '1') { console.log('DRY run — nothing deleted.'); process.exit(0); }

let deleted = 0;
for (let i = 0; i < toRemove.length; i += 100) {
  const ids = toRemove.slice(i, i + 100).map(e => e.id);
  const { error } = await sb.from('events').delete().in('id', ids);
  if (error) console.error('  ❌ delete:', error.message); else deleted += ids.length;
}
console.log(`✓ Deleted ${deleted} events.`);

const removedIds = new Set(toRemove.map(e => e.id));
const live = rows.filter(e => !removedIds.has(e.id));

// ── Canonicalize existing rows in ONE pass (one parallel-batched update per row) ──
// City + country canon, DJ-name canon + off-genre line-up trim, image back-fill and
// genre stamping are all computed together so each row is written at most once, and the
// writes run in small parallel batches — keeping the step well within its time budget
// even when thousands of rows change on the first run (was 5 separate sequential passes).
const djCanon = buildDjCanon(live);
const djImg = {};
for (const e of live) { if (!e.img_url) continue; for (const d of (e.djs || [])) { const k = djNorm(d); if (k && !djImg[k]) djImg[k] = e.img_url; } }
const djStyle = {};
for (const a of readJ('data/artists_all.json')) { const k = djKey(a.name); if (k && !djStyle[k]) djStyle[k] = canonStyle(a.genre, a.subgenre); }
const GENERIC = new Set(['', 'electronic', 'edm', 'unknown', 'various', 'multi-genre', 'multigenre']);

let cityFixed = 0, countryFixed = 0, djFixed = 0, trimmed = 0, imgFixed = 0, genreFixed = 0;
const patches = [];
for (const e of live) {
  const patch = {};
  const nc  = canonCity(e.city);       if (nc  && nc  !== e.city)    { patch.city = nc;     cityFixed++; }     // Eivissa→Ibiza, accents, Provincia Di X→X…
  const nco = canonCountry(e.country); if (nco && nco !== e.country) { patch.country = nco; countryFixed++; }  // United States of America→United States…
  const djs = e.djs || [];
  if (djs.length) {
    let nd = [...new Set(djs.map(d => djCanon[djNorm(d)] || d))];   // canonical spelling
    const edm = nd.filter(d => !OFF.has(djKey(d)));                 // drop off-genre acts
    if (edm.length && edm.length !== nd.length) { trimmed++; nd = edm; }   // never blank the bill
    if (JSON.stringify(nd) !== JSON.stringify(djs)) { patch.djs = nd; djFixed++; }
  }
  if (!e.img_url) { for (const d of (e.djs || [])) { const c = djImg[djNorm(d)]; if (c) { patch.img_url = c; imgFixed++; break; } } }   // reuse artist photo
  const cur = (e.genre || '').trim();
  let g = null;
  if (GENERIC.has(cur.toLowerCase())) { for (const d of (e.djs || [])) { const s = djStyle[djKey(d)]; if (s && s !== 'Electronic') { g = s; break; } } }   // fill generic from head-liner style
  else { const cs = canonStyle(cur); if (cs !== 'Electronic') g = cs; }   // fold verbose label → clean bucket (unknown → untouched)
  if (g && g !== e.genre) { patch.genre = g; genreFixed++; }
  if (Object.keys(patch).length) patches.push({ id: e.id, patch });
}
let rowsUpdated = 0;
for (let i = 0; i < patches.length; i += 12) {
  await Promise.all(patches.slice(i, i + 12).map(p =>
    sb.from('events').update(p.patch).eq('id', p.id).then(({ error }) => { if (error) console.error(`  ❌ update ${p.id}:`, error.message); else rowsUpdated++; })));
}
console.log(`✓ Updated ${rowsUpdated}/${patches.length} rows · city ${cityFixed} · country ${countryFixed} · djs ${djFixed} (trimmed ${trimmed}) · img ${imgFixed} · genre ${genreFixed}.`);
process.exit(0);

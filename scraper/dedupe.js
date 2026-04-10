/**
 * SoundMyth – Event Deduplicator
 *
 * Problem 1: same BIT event scrapped twice under different source_ids
 *   (bit_12345  vs  bit_fest_12345 — now fixed upstream, but clean existing)
 *
 * Problem 2: multiple DJs at same venue on same day → separate rows per DJ
 *   BIT creates one booking per artist; same party appears N times.
 *
 * Fix:
 *   1. Delete orphaned bit_fest_* rows where a bit_* row with same (date+venue+city) exists
 *   2. Group events by (date, venue_norm, city_norm) — keep the richest, merge djs[], tags[]
 *
 * Usage: node dedupe.js
 */

import { createClient } from '@supabase/supabase-js';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) { console.error('❌  Missing Supabase env vars'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// Normalise venue name for comparison: lowercase, strip punctuation, collapse spaces
function normVenue(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function normCity(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Score richness of an event (higher = more info = prefer to keep)
function richness(e) {
  return (e.djs?.length || 0) * 10
       + (e.ticket_url ? 5 : 0)
       + (e.img_url    ? 3 : 0)
       + (e.price      ? 2 : 0)
       + (e.name?.length || 0) * 0.01;
}

// Source priority (lower = better)
const SRC_PRIO = { ra: 0, songkick: 1, bandsintown: 2, direct: 3, website: 4 };

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SoundMyth – Deduplicator                    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── Step 1: Remove bit_fest_* orphans ─────────────────────────────────────
  // These were created by the old festival scraper; the new one uses bit_* instead.
  // If a bit_* row already exists for the same event, delete the bit_fest_* one.
  console.log('Step 1: Remove legacy bit_fest_* duplicates...');
  const { data: bitFest, error: bfe } = await sb
    .from('events')
    .select('id, source_id, date, venue, city')
    .like('source_id', 'bit_fest_%');

  if (bfe) { console.error('  ❌', bfe.message); }
  else {
    console.log(`  Found ${bitFest.length} bit_fest_* rows`);
    let removed = 0;
    for (const row of bitFest) {
      // Derive the canonical bit_* id: bit_fest_12345 → bit_12345
      const canonId = row.source_id.replace('bit_fest_', 'bit_');
      // Check if a row with that canonical id exists
      const { data: canon } = await sb
        .from('events')
        .select('id')
        .eq('source_id', canonId)
        .maybeSingle();
      if (canon) {
        // Canonical row exists → delete the bit_fest_* row
        await sb.from('events').delete().eq('id', row.id);
        removed++;
        process.stdout.write('.');
      } else {
        // No canonical row — rename bit_fest_* → bit_* to fix for future
        await sb.from('events').update({ source_id: canonId }).eq('id', row.id);
        process.stdout.write('r');
      }
    }
    console.log(`\n  Removed: ${removed}  Renamed: ${bitFest.length - removed}\n`);
  }

  // ── Step 2: Merge duplicate events at same venue+date (or same name+date) ──
  console.log('Step 2: Find duplicate events...');

  const PAGE = 1000;
  let allEvents = [];
  let from = 0;
  const today = new Date().toISOString().split('T')[0];

  while (true) {
    const { data, error } = await sb
      .from('events')
      .select('id, name, venue, city, country, date, djs, tags, source, source_id, ticket_url, img_url, price, genre')
      .gte('date', today)
      .range(from, from + PAGE - 1)
      .order('date', { ascending: true });

    if (error) { console.error('  ❌', error.message); break; }
    allEvents = allEvents.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`  Loaded ${allEvents.length} total events`);

  // Normalise name for comparison
  function normName(s) {
    return (s || '').toLowerCase()
      .replace(/\b(festival|fest|presents|pres\.?)\b/g, '')
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Group by composite key:
  //   A) Events WITH venue:  (date, venue_norm, city_norm)
  //   B) Events WITHOUT venue (festivals): (date, name_norm, city_norm)
  const groups = new Map();
  for (const ev of allEvents) {
    const venue = normVenue(ev.venue);
    let key;
    if (venue.length >= 3) {
      // Club/venue event: group by date+venue+city
      key = `venue|${ev.date}|${venue}|${normCity(ev.city)}`;
    } else {
      // Festival / no-venue event: group by date+name+city
      const nn = normName(ev.name);
      if (!nn) continue; // skip if no usable name
      key = `name|${ev.date}|${nn}|${normCity(ev.city)}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const dupeGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`  Groups with duplicates: ${dupeGroups.length}`);

  if (!dupeGroups.length) {
    console.log('  ✅  No duplicates found!\n');
  }

  let merged = 0, deleted = 0;
  for (const group of dupeGroups) {
    // Sort: best source first, then richness
    group.sort((a, b) => {
      const sp = (SRC_PRIO[a.source] ?? 9) - (SRC_PRIO[b.source] ?? 9);
      if (sp !== 0) return sp;
      return richness(b) - richness(a);
    });

    const keeper = group[0];
    const rest   = group.slice(1);

    // Merge djs (union, deduplicated, case-insensitive)
    const djSet = new Set((keeper.djs || []).map(d => d.trim()));
    for (const dup of rest) {
      for (const dj of (dup.djs || [])) {
        const norm = dj.trim();
        if (![...djSet].some(d => d.toLowerCase() === norm.toLowerCase())) {
          djSet.add(norm);
        }
      }
    }

    // Merge tags
    const tagSet = new Set(keeper.tags || []);
    for (const dup of rest) for (const t of (dup.tags || [])) tagSet.add(t);

    // Prefer better ticket_url, img_url, price from any row
    const ticket_url = keeper.ticket_url || rest.find(r => r.ticket_url)?.ticket_url || '';
    const img_url    = keeper.img_url    || rest.find(r => r.img_url)?.img_url || '';
    const price      = keeper.price      || rest.find(r => r.price)?.price || '';

    // Pick best name: prefer the longest non-generic one
    let bestName = keeper.name;
    for (const dup of rest) {
      if (dup.name && dup.name.length > bestName.length && !dup.name.match(/^.+ at .+$/i)) {
        bestName = dup.name;
      }
    }

    const djs  = [...djSet];
    const tags = [...tagSet];

    // Only update if something actually changed
    const djsChanged   = JSON.stringify(djs.sort()) !== JSON.stringify((keeper.djs || []).slice().sort());
    const tagsChanged  = JSON.stringify(tags.sort()) !== JSON.stringify((keeper.tags || []).slice().sort());
    const nameChanged  = bestName !== keeper.name;
    const urlChanged   = ticket_url !== keeper.ticket_url;
    const imgChanged   = img_url !== keeper.img_url;

    if (djsChanged || tagsChanged || nameChanged || urlChanged || imgChanged) {
      await sb.from('events').update({ djs, tags, name: bestName, ticket_url, img_url, price }).eq('id', keeper.id);
      merged++;
    }

    // Delete the duplicates
    const idsToDelete = rest.map(r => r.id);
    const { error: delErr } = await sb.from('events').delete().in('id', idsToDelete);
    if (delErr) console.error(`  ❌  Delete error: ${delErr.message}`);
    else deleted += idsToDelete.length;

    const venueTrunc = (keeper.venue || '').slice(0, 30).padEnd(30);
    console.log(`  ✓ ${keeper.date} │ ${venueTrunc} │ kept ${keeper.source_id.slice(0,18)} │ merged ${djs.length} DJs │ deleted ${idsToDelete.length}`);
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Dedup complete                              ║`);
  console.log(`║  Groups merged   : ${String(merged).padEnd(25)} ║`);
  console.log(`║  Rows deleted    : ${String(deleted).padEnd(25)} ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

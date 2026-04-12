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
import { readFileSync, existsSync } from 'fs';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) { console.error('❌  Missing Supabase env vars'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// Normalise: lowercase, strip diacritics (NFD), strip punctuation, collapse spaces
function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
const normVenue = norm;
const normCity  = norm;

// Check if two venue names are similar enough to be the same place
// Handles "Ushuaia Ibiza" vs "Ushuaia Ibiza Beach Hotel", "DC-10" vs "DC 10",
// "Brunch Electronik France" vs "Brunch Electronik Bordeaux"
function venueMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return na === nb;
  if (na === nb) return true;
  // One contains the other (for "Amnesia" vs "Amnesia Ibiza")
  if (na.includes(nb) || nb.includes(na)) return true;
  // Common prefix match: if both share a long prefix (≥10 chars and ≥50% of shorter)
  // they're likely the same venue with different city/country suffix
  const shorter = Math.min(na.length, nb.length);
  let prefix = 0;
  for (let i = 0; i < shorter; i++) {
    if (na[i] !== nb[i]) break;
    prefix++;
  }
  if (prefix >= 10 && prefix >= shorter * 0.5) return true;
  return false;
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
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/\b(festival|fest|presents|pres\.?)\b/g, '')
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Extract the real venue from "DJ at Venue" / "DJ @ Venue" patterns
  // BIT creates entries like "Amelie Lens @ Brunch Electronik Bordeaux"
  // where both name AND venue fields contain the DJ prefix.
  function extractRealVenue(name, venue) {
    // Try extracting venue from name: "DJ at X", "DJ @ X", "DJ pres. X"
    const nm = (name || '').match(/^.+?\s+(?:at|@|pres\.?)\s+(.+)$/i);
    // Try cleaning venue field if it also has "DJ @ X" pattern
    const vm = (venue || '').match(/^.+?\s+(?:at|@|pres\.?)\s+(.+)$/i);
    return norm(nm ? nm[1] : (vm ? vm[1] : venue));
  }

  // ── Pass 1: Exact key grouping ──
  //   A) Events WITH venue:  (date, venue_norm, city_norm)
  //   B) Events WITHOUT venue (festivals): (date, name_norm, city_norm)
  //   Also tries extracting "real venue" from "DJ at/@ Venue" patterns
  const groups = new Map();
  for (const ev of allEvents) {
    const rawVenue = normVenue(ev.venue);
    const realVenue = extractRealVenue(ev.name, ev.venue);
    // Use the real venue (stripped of DJ prefix) if it's shorter/cleaner
    const venue = (realVenue && realVenue.length >= 3 && realVenue.length < rawVenue.length)
      ? realVenue : rawVenue;
    let key;
    if (venue.length >= 3) {
      key = `venue|${ev.date}|${venue}|${normCity(ev.city)}`;
    } else {
      const nn = normName(ev.name);
      if (!nn) continue;
      key = `name|${ev.date}|${nn}|${normCity(ev.city)}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  // ── Pass 2: Fuzzy venue merge ──
  // Merge groups with same date+city where venues are similar ("Ushuaia" vs "Ushuaia Ibiza Beach Hotel")
  const keys = [...groups.keys()].filter(k => k.startsWith('venue|'));
  for (let i = 0; i < keys.length; i++) {
    const [, dateA, venueA, cityA] = keys[i].split('|');
    if (!groups.has(keys[i])) continue; // already merged away
    for (let j = i + 1; j < keys.length; j++) {
      if (!groups.has(keys[j])) continue;
      const [, dateB, venueB, cityB] = keys[j].split('|');
      if (dateA !== dateB || cityA !== cityB) continue;
      if (venueMatch(venueA, venueB)) {
        // Merge j into i
        groups.get(keys[i]).push(...groups.get(keys[j]));
        groups.delete(keys[j]);
      }
    }
  }

  // ── Pass 3: Festival consolidation ──
  // BIT creates separate entries per DJ at a festival ("Anyma pres. ÆDEN at Coachella",
  // "Heineken House Coachella", etc). Consolidate: same date + same city + name/venue
  // contains a known festival BASE name → merge into one event.
  console.log('\n  Pass 3: Festival consolidation...');
  const FESTIVALS_PATH = resolve(__dirname, 'data/festivals_all.json');
  let festBaseNames = [];
  if (existsSync(FESTIVALS_PATH)) {
    const fests = JSON.parse(readFileSync(FESTIVALS_PATH, 'utf8'));
    // Build BOTH full names and base names (strip city/country suffixes)
    // "Brunch Electronik Barcelona" → base: "brunch electronik"
    // "Tomorrowland Belgium" → base: "tomorrowland"
    const fullNames = fests.map(f => norm(f.name)).filter(n => n.length >= 5);
    const baseNames = new Set();
    for (const fn of fullNames) {
      baseNames.add(fn);
      // Strip last word if it looks like a city/country (≤15 chars, fest name > 8 chars after strip)
      const words = fn.split(' ');
      if (words.length >= 2) {
        const base = words.slice(0, -1).join(' ');
        if (base.length >= 8) baseNames.add(base);
        // Also try stripping last 2 words: "brunch electronik bcn" → "brunch electronik"
        if (words.length >= 3) {
          const base2 = words.slice(0, -2).join(' ');
          if (base2.length >= 8) baseNames.add(base2);
        }
      }
    }
    festBaseNames = [...baseNames].sort((a, b) => b.length - a.length); // longest first
  }

  if (festBaseNames.length) {
    // Index events by date+city
    const byDateCity = new Map();
    for (const [key, evs] of groups) {
      for (const ev of evs) {
        const dc = `${ev.date}|${normCity(ev.city)}`;
        if (!byDateCity.has(dc)) byDateCity.set(dc, []);
        byDateCity.get(dc).push({ key, ev });
      }
    }

    let festMerged = 0;
    for (const [dc, entries] of byDateCity) {
      if (entries.length < 2) continue;
      // For each known festival name (base or full), check if multiple events reference it
      for (const fest of festBaseNames) {
        const matching = entries.filter(({ ev }) => {
          const n = norm(ev.name);
          const v = norm(ev.venue);
          return n.includes(fest) || v.includes(fest);
        });
        if (matching.length < 2) continue;

        // Merge all matching into the first group
        const targetKey = matching[0].key;
        for (let m = 1; m < matching.length; m++) {
          const srcKey = matching[m].key;
          if (srcKey === targetKey) continue;
          if (!groups.has(srcKey)) continue;
          groups.get(targetKey).push(...groups.get(srcKey));
          groups.delete(srcKey);
          festMerged++;
        }
      }
    }
    console.log(`  Festival groups consolidated: ${festMerged}`);
  }

  // ── Pass 4: Consecutive-day DJ dedup ──
  // Same DJ + same venue + same city on consecutive days → merge into one event
  console.log('\n  Pass 4: Consecutive-day DJ dedup...');
  let consecMerged = 0;

  // Flatten all remaining events from groups
  const allGrouped = [];
  for (const [key, evs] of groups) {
    for (const ev of evs) allGrouped.push({ key, ev });
  }

  // Build index: for each DJ, find all events they appear in
  const djEvents = new Map(); // dj_lower → [{key, ev}, ...]
  for (const entry of allGrouped) {
    const djs = entry.ev.djs || [];
    for (const dj of djs) {
      const djLow = dj.trim().toLowerCase();
      if (!djEvents.has(djLow)) djEvents.set(djLow, []);
      djEvents.get(djLow).push(entry);
    }
  }

  const alreadyMergedKeys = new Set();

  for (const [djName, entries] of djEvents) {
    if (entries.length < 2) continue;

    // Group by venue+city
    const byVenueCity = new Map();
    for (const entry of entries) {
      const vc = `${normVenue(entry.ev.venue)}|${normCity(entry.ev.city)}`;
      if (!byVenueCity.has(vc)) byVenueCity.set(vc, []);
      byVenueCity.get(vc).push(entry);
    }

    for (const [vc, vcEntries] of byVenueCity) {
      if (vcEntries.length < 2) continue;

      // Sort by date
      vcEntries.sort((a, b) => a.ev.date.localeCompare(b.ev.date));

      // Find consecutive-day chains
      for (let i = 0; i < vcEntries.length - 1; i++) {
        const curr = vcEntries[i];
        const next = vcEntries[i + 1];

        if (alreadyMergedKeys.has(next.key) && !groups.has(next.key)) continue;
        if (curr.key === next.key) continue; // already in same group

        const d1 = new Date(curr.ev.date);
        const d2 = new Date(next.ev.date);
        const diffDays = (d2 - d1) / (1000 * 60 * 60 * 24);

        if (diffDays === 1) {
          // Consecutive days — merge next into curr's group
          if (groups.has(curr.key) && groups.has(next.key) && curr.key !== next.key) {
            groups.get(curr.key).push(...groups.get(next.key));
            groups.delete(next.key);
            alreadyMergedKeys.add(next.key);
            consecMerged++;
          }
        }
      }
    }
  }
  console.log(`  Consecutive-day merges: ${consecMerged}`);

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

    // Pick best name: prefer festival/venue name over "DJ at Festival" pattern
    let bestName = keeper.name;
    for (const dup of rest) {
      if (!dup.name) continue;
      // Skip "DJ at Festival" or "DJ @ Festival" patterns — prefer the full festival name
      const isGenericDJat = /^.+\s+(at|@|pres\.?)\s+.+$/i.test(dup.name);
      const keeperIsGeneric = /^.+\s+(at|@|pres\.?)\s+.+$/i.test(bestName);
      if (keeperIsGeneric && !isGenericDJat) { bestName = dup.name; continue; }
      if (!keeperIsGeneric && isGenericDJat) continue;
      if (dup.name.length > bestName.length) bestName = dup.name;
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

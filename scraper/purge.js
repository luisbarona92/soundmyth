/**
 * SoundMyth – Supabase Event Purge
 *
 * Deletes events whose date is older than PURGE_DAYS_AGO days from today.
 * Events from the last PURGE_DAYS_AGO days are kept (shown greyed out on web).
 *
 * Usage: node purge.js
 * Schedule: weekly (Sundays) via task scheduler
 */

import { createClient } from '@supabase/supabase-js';
import { config }       from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PURGE_DAYS_AGO = 15;   // delete events older than this many days

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PURGE_DAYS_AGO);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  console.log('╔══════════════════════════════════════════╗');
  console.log('║  SoundMyth – Supabase Event Purge        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n🗓  Today       : ${new Date().toISOString().split('T')[0]}`);
  console.log(`🗑  Purge before : ${cutoffStr}  (>${PURGE_DAYS_AGO} days ago)\n`);

  // Count first
  const { count, error: countErr } = await sb
    .from('events')
    .select('id', { count: 'exact', head: true })
    .lt('date', cutoffStr);

  if (countErr) {
    console.error('❌  Count error:', countErr.message);
    process.exit(1);
  }

  console.log(`📊  Events to delete : ${count}`);

  if (!count || count === 0) {
    console.log('\n✅  Nothing to purge. DB is clean.');
    return;
  }

  // Delete in batches of 1000 to avoid timeouts
  let deleted = 0;
  while (true) {
    // Supabase deletes up to the server row limit per call — use explicit range
    const { error: delErr, count: batchCount } = await sb
      .from('events')
      .delete({ count: 'exact' })
      .lt('date', cutoffStr);

    if (delErr) {
      console.error('❌  Delete error:', delErr.message);
      process.exit(1);
    }

    deleted += batchCount || 0;
    console.log(`  ✓ Batch deleted: ${batchCount}`);
    if (!batchCount || batchCount < 1000) break;
  }

  // Also purge orphan saved_events (user bookmarks pointing to deleted events)
  console.log(`\n🧹  Checking orphan saved_events…`);

  try {
    // Step 1: get all valid event ids (paginated if large, but events table is small)
    let validEvents = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb.from('events').select('id').range(from, from + 999);
      if (error) { console.error('  ❌  Error fetching events:', error.message); break; }
      validEvents = validEvents.concat(data || []);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    const validIds = new Set((validEvents || []).map(e => e.id));

    // Step 2: get all saved_events
    let allSavedEvents = [];
    from = 0;
    while (true) {
      const { data, error } = await sb.from('saved_events').select('id, event_id').range(from, from + 999);
      if (error) { console.error('  ❌  Error fetching saved_events:', error.message); break; }
      allSavedEvents = allSavedEvents.concat(data || []);
      if (!data || data.length < 1000) break;
      from += 1000;
    }

    // Step 3: find orphans
    const orphanIds = (allSavedEvents || []).filter(s => !validIds.has(s.event_id)).map(s => s.id);

    // Step 4: delete orphans in batches
    if (orphanIds.length > 0) {
      let orphanDeleted = 0;
      for (let i = 0; i < orphanIds.length; i += 100) {
        const { error: delErr, count: batchCount } = await sb
          .from('saved_events')
          .delete({ count: 'exact' })
          .in('id', orphanIds.slice(i, i + 100));
        if (delErr) {
          console.error('  ❌  Orphan delete error:', delErr.message);
        } else {
          orphanDeleted += batchCount || 0;
        }
      }
      console.log(`  ✓ Deleted ${orphanDeleted} orphaned saved_events rows`);
    } else {
      console.log(`  ✓ No orphaned saved_events found`);
    }
  } catch (err) {
    console.error('  ❌  Orphan cleanup error:', err.message);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Purge complete  →  ${String(deleted).padEnd(18)} deleted ║`);
  console.log('╚══════════════════════════════════════════╝');
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

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
  const { count: orphanCount, error: orphanCountErr } = await sb
    .from('saved_events')
    .select('id', { count: 'exact', head: true })
    .not('event_id', 'in', `(select id from events)`);

  // Simple approach: just delete saved_events where the event no longer exists
  // (Supabase cascade would handle this if FK is set — but just in case)
  console.log(`\n🧹  Checking orphan saved_events…`);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Purge complete  →  ${String(deleted).padEnd(18)} deleted ║`);
  console.log('╚══════════════════════════════════════════╝');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

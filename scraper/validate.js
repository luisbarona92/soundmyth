/**
 * SoundMyth – Event Data Validator & Auto-Fixer
 *
 * Connects to Supabase and validates the quality of future events data.
 * Reports issues (missing fields, duplicates, normalization problems)
 * and auto-fixes what it can (genre defaults, country normalization,
 * city extraction from venue).
 *
 * Usage: node validate.js
 */

import { createClient } from '@supabase/supabase-js';
import { config }       from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── Known country normalization map ─────────────────────────────────────────
const COUNTRY_NORM = {
  'UK':                        'United Kingdom',
  'US':                        'United States',
  'USA':                       'United States',
  'United States of America':  'United States',
};

// Countries we consider valid (no normalization needed)
const VALID_COUNTRIES = new Set([
  'United Kingdom', 'United States', 'Spain', 'Germany', 'France', 'Italy',
  'Netherlands', 'Belgium', 'Portugal', 'Greece', 'Croatia', 'Serbia',
  'Romania', 'Bulgaria', 'Austria', 'Switzerland', 'Sweden', 'Norway',
  'Denmark', 'Finland', 'Ireland', 'Poland', 'Czech Republic', 'Czechia',
  'Hungary', 'Turkey', 'Australia', 'Japan', 'South Korea', 'Thailand',
  'Indonesia', 'India', 'Brazil', 'Argentina', 'Colombia', 'Mexico',
  'Canada', 'South Africa', 'Morocco', 'Egypt', 'Israel', 'Lebanon',
  'United Arab Emirates', 'Georgia', 'Ukraine', 'Russia', 'China',
  'Singapore', 'Malaysia', 'Philippines', 'Vietnam', 'New Zealand',
  'Chile', 'Peru', 'Costa Rica', 'Jamaica', 'Dominican Republic',
  'Puerto Rico', 'Iceland', 'Estonia', 'Latvia', 'Lithuania', 'Slovenia',
  'Slovakia', 'Malta', 'Cyprus', 'Luxembourg', 'Montenegro', 'Albania',
  'North Macedonia', 'Bosnia and Herzegovina',
]);

// Known cities that might appear inside venue names
const KNOWN_CITIES = [
  'Ibiza', 'Barcelona', 'Madrid', 'Berlin', 'Amsterdam', 'London',
  'Paris', 'Manchester', 'Liverpool', 'Bristol', 'Glasgow', 'Edinburgh',
  'Leeds', 'Birmingham', 'Dublin', 'Lisbon', 'Porto', 'Rome', 'Milan',
  'Athens', 'Belgrade', 'Zagreb', 'Bucharest', 'Budapest', 'Prague',
  'Vienna', 'Zurich', 'Copenhagen', 'Stockholm', 'Oslo', 'Helsinki',
  'Warsaw', 'Krakow', 'Bangkok', 'Tokyo', 'Sydney', 'Melbourne',
  'New York', 'Los Angeles', 'Miami', 'Chicago', 'Detroit', 'Las Vegas',
  'San Francisco', 'Brooklyn', 'Denver', 'Austin', 'Atlanta', 'Toronto',
  'Montreal', 'Mexico City', 'Sao Paulo', 'Buenos Aires', 'Bogota',
  'Tulum', 'Cancun', 'Mykonos', 'Split', 'Zrce', 'Tisno',
  'Marrakech', 'Cape Town', 'Tel Aviv', 'Beirut', 'Dubai', 'Tbilisi',
  'Singapore', 'Bali', 'Seoul', 'Shanghai', 'Hong Kong',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEmpty(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') return val.trim().length === 0;
  return false;
}

function isDJatVenuePattern(name) {
  if (!name) return false;
  return /^.+\s+(at|@)\s+.+$/i.test(name.trim());
}

function extractCityFromVenue(venue) {
  if (!venue) return null;
  const venueLower = venue.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (venueLower.includes(city.toLowerCase())) {
      return city;
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('==================================================');
  console.log('  SoundMyth - Event Data Validator');
  console.log('==================================================\n');

  const today = new Date().toISOString().split('T')[0];
  console.log(`Date        : ${today}`);
  console.log(`Fetching future events (date >= ${today})...\n`);

  // ── Fetch all future events (paginated) ──────────────────────────────────
  const PAGE = 1000;
  let allEvents = [];
  let from = 0;

  while (true) {
    const { data, error } = await sb
      .from('events')
      .select('id, name, venue, city, country, date, djs, tags, source, source_id, genre, ticket_url, img_url, price')
      .gte('date', today)
      .range(from, from + PAGE - 1)
      .order('date', { ascending: true });

    if (error) { console.error('  Fetch error:', error.message); break; }
    allEvents = allEvents.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`Total future events: ${allEvents.length}\n`);

  if (allEvents.length === 0) {
    console.log('No future events found. Nothing to validate.');
    return;
  }

  // ── Validation checks ────────────────────────────────────────────────────
  const issues = {
    missingCity:        [],
    missingCountry:     [],
    missingGenre:       [],
    garbageEvents:      [],
    djAtVenuePattern:   [],
    duplicateSourceIds: [],
    unknownCountries:   [],
  };

  const sourceIdCount = new Map();

  for (const ev of allEvents) {
    // Missing city
    if (isEmpty(ev.city)) {
      issues.missingCity.push(ev);
    }

    // Missing country
    if (isEmpty(ev.country)) {
      issues.missingCountry.push(ev);
    }

    // Missing genre
    if (isEmpty(ev.genre)) {
      issues.missingGenre.push(ev);
    }

    // Garbage events: no DJs AND no venue
    const hasDjs = Array.isArray(ev.djs) && ev.djs.length > 0;
    if (!hasDjs && isEmpty(ev.venue)) {
      issues.garbageEvents.push(ev);
    }

    // DJ at Venue pattern (potential dedup candidates)
    if (isDJatVenuePattern(ev.name)) {
      issues.djAtVenuePattern.push(ev);
    }

    // Track source_id duplicates
    if (ev.source_id) {
      sourceIdCount.set(ev.source_id, (sourceIdCount.get(ev.source_id) || 0) + 1);
    }

    // Unknown country values
    if (!isEmpty(ev.country)) {
      const country = ev.country.trim();
      const isKnown = VALID_COUNTRIES.has(country);
      const isNormalizable = country in COUNTRY_NORM;
      if (!isKnown && !isNormalizable) {
        issues.unknownCountries.push(ev);
      }
    }
  }

  // Collect actual duplicates
  for (const [srcId, count] of sourceIdCount) {
    if (count > 1) {
      const dupes = allEvents.filter(e => e.source_id === srcId);
      issues.duplicateSourceIds.push({ source_id: srcId, count, events: dupes });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('--------------------------------------------------');
  console.log('  VALIDATION REPORT');
  console.log('--------------------------------------------------\n');

  console.log(`[1] Missing city           : ${issues.missingCity.length}`);
  for (const ev of issues.missingCity.slice(0, 10)) {
    console.log(`     - ${ev.date} | ${(ev.name || '').slice(0, 40)} | venue: ${(ev.venue || 'N/A').slice(0, 30)}`);
  }
  if (issues.missingCity.length > 10) console.log(`     ... and ${issues.missingCity.length - 10} more`);

  console.log(`\n[2] Missing country        : ${issues.missingCountry.length}`);
  for (const ev of issues.missingCountry.slice(0, 10)) {
    console.log(`     - ${ev.date} | ${(ev.name || '').slice(0, 40)} | city: ${ev.city || 'N/A'}`);
  }
  if (issues.missingCountry.length > 10) console.log(`     ... and ${issues.missingCountry.length - 10} more`);

  console.log(`\n[3] Missing genre          : ${issues.missingGenre.length}`);
  for (const ev of issues.missingGenre.slice(0, 10)) {
    console.log(`     - ${ev.date} | ${(ev.name || '').slice(0, 40)} | source: ${ev.source || 'N/A'}`);
  }
  if (issues.missingGenre.length > 10) console.log(`     ... and ${issues.missingGenre.length - 10} more`);

  console.log(`\n[4] Garbage (no DJs + no venue): ${issues.garbageEvents.length}`);
  for (const ev of issues.garbageEvents.slice(0, 10)) {
    console.log(`     - ${ev.date} | ${(ev.name || '').slice(0, 50)} | src: ${ev.source_id || 'N/A'}`);
  }
  if (issues.garbageEvents.length > 10) console.log(`     ... and ${issues.garbageEvents.length - 10} more`);

  console.log(`\n[5] "DJ at Venue" pattern  : ${issues.djAtVenuePattern.length}`);
  for (const ev of issues.djAtVenuePattern.slice(0, 10)) {
    console.log(`     - ${ev.date} | ${(ev.name || '').slice(0, 50)}`);
  }
  if (issues.djAtVenuePattern.length > 10) console.log(`     ... and ${issues.djAtVenuePattern.length - 10} more`);

  console.log(`\n[6] Duplicate source_ids   : ${issues.duplicateSourceIds.length}`);
  for (const d of issues.duplicateSourceIds.slice(0, 10)) {
    console.log(`     - ${d.source_id} (x${d.count})`);
  }
  if (issues.duplicateSourceIds.length > 10) console.log(`     ... and ${issues.duplicateSourceIds.length - 10} more`);

  // Collect unique unknown countries
  const unknownCountryValues = [...new Set(issues.unknownCountries.map(e => e.country.trim()))];
  console.log(`\n[7] Unknown country values : ${unknownCountryValues.length} distinct`);
  for (const c of unknownCountryValues.slice(0, 20)) {
    const count = issues.unknownCountries.filter(e => e.country.trim() === c).length;
    console.log(`     - "${c}" (${count} events)`);
  }
  if (unknownCountryValues.length > 20) console.log(`     ... and ${unknownCountryValues.length - 20} more`);

  // ── Auto-fixes ───────────────────────────────────────────────────────────
  console.log('\n--------------------------------------------------');
  console.log('  AUTO-FIXES');
  console.log('--------------------------------------------------\n');

  let fixedGenre = 0;
  let fixedCity = 0;
  let fixedCountry = 0;

  // Fix 1: Set genre to 'Electronic' where missing
  console.log('Fix 1: Default genre to "Electronic" where missing...');
  for (const ev of issues.missingGenre) {
    const { error } = await sb
      .from('events')
      .update({ genre: 'Electronic' })
      .eq('id', ev.id);

    if (error) {
      console.error(`  Error fixing genre for ${ev.id}: ${error.message}`);
    } else {
      fixedGenre++;
    }
  }
  console.log(`  Fixed: ${fixedGenre}\n`);

  // Fix 2: Extract city from venue name where city is missing
  console.log('Fix 2: Extract city from venue name where city is missing...');
  for (const ev of issues.missingCity) {
    const extracted = extractCityFromVenue(ev.venue);
    if (extracted) {
      const { error } = await sb
        .from('events')
        .update({ city: extracted })
        .eq('id', ev.id);

      if (error) {
        console.error(`  Error fixing city for ${ev.id}: ${error.message}`);
      } else {
        fixedCity++;
        console.log(`  ${ev.date} | "${(ev.venue || '').slice(0, 30)}" -> city: ${extracted}`);
      }
    }
  }
  console.log(`  Fixed: ${fixedCity} (${issues.missingCity.length - fixedCity} could not be resolved)\n`);

  // Fix 3: Normalize country values
  console.log('Fix 3: Normalize country values...');
  for (const ev of allEvents) {
    if (isEmpty(ev.country)) continue;
    const raw = ev.country.trim();
    const normalized = COUNTRY_NORM[raw];
    if (normalized) {
      const { error } = await sb
        .from('events')
        .update({ country: normalized })
        .eq('id', ev.id);

      if (error) {
        console.error(`  Error normalizing country for ${ev.id}: ${error.message}`);
      } else {
        fixedCountry++;
        if (fixedCountry <= 20) {
          console.log(`  "${raw}" -> "${normalized}" (${ev.source_id})`);
        }
      }
    }
  }
  if (fixedCountry > 20) console.log(`  ... and ${fixedCountry - 20} more`);
  console.log(`  Fixed: ${fixedCountry}\n`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('==================================================');
  console.log('  SUMMARY');
  console.log('==================================================');
  console.log(`  Total future events       : ${allEvents.length}`);
  console.log('  ---');
  console.log(`  Missing city              : ${issues.missingCity.length}`);
  console.log(`  Missing country           : ${issues.missingCountry.length}`);
  console.log(`  Missing genre             : ${issues.missingGenre.length}`);
  console.log(`  Garbage (no DJs+venue)    : ${issues.garbageEvents.length}`);
  console.log(`  "DJ at Venue" patterns    : ${issues.djAtVenuePattern.length}`);
  console.log(`  Duplicate source_ids      : ${issues.duplicateSourceIds.length}`);
  console.log(`  Unknown countries         : ${unknownCountryValues.length}`);
  console.log('  ---');
  console.log(`  Auto-fixed genre          : ${fixedGenre}`);
  console.log(`  Auto-fixed city           : ${fixedCity}`);
  console.log(`  Auto-fixed country        : ${fixedCountry}`);
  console.log('==================================================\n');
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

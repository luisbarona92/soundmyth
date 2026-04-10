/**
 * SoundMyth – Enrich clubs with RA URL
 *
 * For clubs in clubs_all.json that have no ra_url (or empty),
 * searches Resident Advisor's GraphQL API by club name + city
 * and fills in the ra_url field.
 *
 * Usage: node enrich-clubs-ra.js
 * Output: writes back to data/clubs_all.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve }  from 'path';
import { config }            from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const CLUBS_PATH = resolve(__dirname, 'data/clubs_all.json');
const DELAY      = 1200;   // ms between RA requests
const RA_GQL     = 'https://ra.co/graphql';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── RA GraphQL search ────────────────────────────────────────────────────────
const SEARCH_QUERY = `
query SEARCH($query: String!) {
  searchResults: listing(
    filters: { query: $query, type: CLUB }
    pageSize: 5
  ) {
    data {
      ... on Club {
        id
        name
        area { name }
        urlName
      }
    }
  }
}`;

/** Fuzzy name match — require at least one significant word in common */
function nameMatches(result, searchName) {
  const rName   = (result.name || '').toLowerCase();
  const sName   = searchName.toLowerCase();
  // Accept if result name contains the first word of search (min 4 chars)
  const words   = sName.split(/\s+/).filter(w => w.length >= 4);
  return words.length > 0 && words.some(w => rName.includes(w));
}

async function searchRAClub(name, city) {
  // Try RA search API (undocumented but stable)
  const searchUrl = `https://ra.co/api/search?query=${encodeURIComponent(name)}&type=club`;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://ra.co/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Only accept if name actually matches — never use data[0] as blind fallback
        const match = data.find(r => nameMatches(r, name) && (r.contentUrl || r.slug));
        if (match?.contentUrl) return `https://ra.co${match.contentUrl}`;
        if (match?.slug)       return `https://ra.co/clubs/${match.slug}`;
      }
    }
  } catch { /* ignore */ }

  // Fallback: RA GraphQL search
  try {
    const res = await fetch(RA_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://ra.co/',
      },
      body: JSON.stringify({
        query: `
          query Search($q: String!) {
            search(query: $q) {
              clubs {
                id
                name
                urlName
                area { name }
              }
            }
          }
        `,
        variables: { q: name },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = await res.json();
      const clubs = json?.data?.search?.clubs || [];
      if (clubs.length > 0) {
        // Only accept if name genuinely matches — no blind fallback
        const best = clubs.find(c => nameMatches(c, name));
        if (best?.urlName) return `https://ra.co/clubs/${best.urlName}`;
        if (best?.id)      return `https://ra.co/clubs/${best.id}`;
      }
    }
  } catch { /* ignore */ }

  // HTML fallback removed — too unreliable (always returns same popular club)
  // If APIs don't return a confident name match, this club is not on RA
  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const clubs = JSON.parse(readFileSync(CLUBS_PATH, 'utf8'));
  const missing = clubs.filter(c => !c.ra_url || c.ra_url.trim() === '');

  console.log('╔══════════════════════════════════════════╗');
  console.log('║  SoundMyth – Enrich Clubs with RA URL    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n📋  Total clubs  : ${clubs.length}`);
  console.log(`🔍  Missing RA   : ${missing.length}\n`);
  console.log('─'.repeat(58));

  let found = 0, notFound = 0;

  for (let i = 0; i < missing.length; i++) {
    const club = missing[i];
    const pct  = Math.round(((i + 1) / missing.length) * 100);
    process.stdout.write(`[${String(i+1).padStart(2)}/${missing.length}] ${pct.toString().padStart(3)}% │ ${club.name.padEnd(30)} `);

    const raUrl = await searchRAClub(club.name, club.city);

    if (raUrl) {
      // Update in original array
      const idx = clubs.findIndex(c => c.name === club.name && c.city === club.city);
      if (idx !== -1) clubs[idx].ra_url = raUrl;
      console.log(`✓  ${raUrl}`);
      found++;
    } else {
      console.log(`–  not found on RA`);
      notFound++;
    }

    await sleep(DELAY);
  }

  // Save back
  writeFileSync(CLUBS_PATH, JSON.stringify(clubs, null, 2), 'utf8');

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Enrichment complete                     ║`);
  console.log(`║  Found    : ${String(found).padEnd(29)} ║`);
  console.log(`║  Not found: ${String(notFound).padEnd(29)} ║`);
  console.log(`║  Saved to : clubs_all.json               ║`);
  console.log('╚══════════════════════════════════════════╝');

  if (notFound > 0) {
    console.log('\nClubs NOT found on RA (likely not listed there):');
    missing.filter((c,i) => {
      const idx = clubs.findIndex(x => x.name === c.name && x.city === c.city);
      return idx !== -1 && (!clubs[idx].ra_url || clubs[idx].ra_url === '');
    }).forEach(c => console.log(`  - ${c.name}  (${c.city}, ${c.country})`));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

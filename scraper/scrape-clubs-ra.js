/**
 * SoundMyth – Resident Advisor Club Scraper
 *
 * Reads data/clubs_all.json, queries the RA GraphQL API for each club's
 * upcoming events (with full lineup), and upserts into Supabase.
 *
 * RA GraphQL: https://ra.co/graphql (no auth required)
 * Club IDs extracted from ra_url: ra.co/clubs/{id} or ra.co/promoters/{id}
 *
 * Usage: node scrape-clubs-ra.js
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { config }        from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const TODAY   = new Date().toISOString().split('T')[0];
const BATCH   = 50;
const DELAY   = 900;   // ms between club requests – be polite

if (!SB_URL || !SB_KEY) {
  console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const sb    = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── RA GraphQL ────────────────────────────────────────────────────────────────

const RA_GQL = 'https://ra.co/graphql';
const RA_HEADERS = {
  'Content-Type':  'application/json',
  'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer':       'https://ra.co/',
  'Origin':        'https://ra.co',
  'Accept':        'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Use year filter to get only upcoming events — also include next year in Q4
const THIS_YEAR  = new Date().getFullYear();
const NEXT_YEAR  = THIS_YEAR + 1;
const FETCH_NEXT = new Date().getMonth() >= 9;  // Oct–Dec: also fetch next year

const VENUE_EVENTS_QUERY = `
query GetVenueEvents($id: ID!, $year: Int!) {
  venue(id: $id) {
    id name
    area { name country { name } }
    events(type: FROMDATE, year: $year) {
      id title startTime endTime lineup
      artists { name contentUrl }
      flyerFront contentUrl
    }
  }
}`;

const PROMOTER_EVENTS_QUERY = `
query GetPromoterEvents($id: ID!, $year: Int!) {
  promoter(id: $id) {
    id name
    area { name country { name } }
    events(type: FROMDATE, year: $year) {
      id title startTime endTime lineup
      artists { name contentUrl }
      venue { name area { name country { name } } }
      flyerFront contentUrl
    }
  }
}`;

// Listing-based query: searches upcoming events at a specific venue by area.
// This is a fallback when the venue.events(year) query returns 0 events,
// which happens for some clubs where RA indexes events via listings instead.
const VENUE_LISTING_QUERY = `
query GetVenueListings($id: ID!, $pageSize: Int) {
  venue(id: $id) {
    id name
    area { name country { name } }
    eventListings(pageSize: $pageSize) {
      id title startTime endTime lineup
      artists { name contentUrl }
      flyerFront contentUrl
    }
  }
}`;

const PROMOTER_LISTING_QUERY = `
query GetPromoterListings($id: ID!, $pageSize: Int) {
  promoter(id: $id) {
    id name
    area { name country { name } }
    eventListings(pageSize: $pageSize) {
      id title startTime endTime lineup
      artists { name contentUrl }
      venue { name area { name country { name } } }
      flyerFront contentUrl
    }
  }
}`;

async function gqlFetch(query, variables, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RA_GQL, {
        method:  'POST',
        headers: RA_HEADERS,
        body:    JSON.stringify({ query, variables }),
        signal:  AbortSignal.timeout(14000),
      });
      if (!res.ok) {
        if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
        return null;
      }
      const json = await res.json();
      // Return partial data even if there are errors — GraphQL may return the
      // entity but error on a specific field (e.g. eventListings not supported).
      // Callers check for null fields themselves.
      if (json.data) return json.data;
      if (json.errors?.length) return null;
      return null;
    } catch {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      return null;
    }
  }
  return null;
}

async function fetchRAClubEvents(raId, isPromoter) {
  const query = isPromoter ? PROMOTER_EVENTS_QUERY : VENUE_EVENTS_QUERY;
  const key   = isPromoter ? 'promoter' : 'venue';
  const today = new Date().toISOString().split('T')[0];

  // ── Strategy 1: year-based events query ────────────────────────────────────
  const d1    = await gqlFetch(query, { id: raId, year: THIS_YEAR });
  let entity  = d1?.[key] ?? null;

  // In Q4, also fetch next year and merge
  if (entity && FETCH_NEXT) {
    const dN = await gqlFetch(query, { id: raId, year: NEXT_YEAR });
    const nextEvts = dN?.[key]?.events || [];
    entity = { ...entity, events: [...(entity.events || []), ...nextEvts] };
  }

  // Filter to today-onwards
  if (entity) {
    entity.events = (entity.events || []).filter(e => (e.startTime || '').slice(0, 10) >= today);
  }

  // If we got events, return early
  if (entity?.events?.length) return entity;

  // ── Strategy 2: eventListings query (no year filter, returns upcoming) ─────
  // Some clubs on RA return 0 events via the year query but have events via
  // their eventListings endpoint which returns upcoming events directly.
  const listQuery = isPromoter ? PROMOTER_LISTING_QUERY : VENUE_LISTING_QUERY;
  const dL = await gqlFetch(listQuery, { id: raId, pageSize: 50 });
  const listEntity = dL?.[key] ?? null;
  if (listEntity?.eventListings?.length) {
    // Normalise: copy eventListings into .events for uniform downstream handling
    listEntity.events = (listEntity.eventListings || [])
      .filter(e => (e.startTime || '').slice(0, 10) >= today);
    delete listEntity.eventListings;
    if (listEntity.events.length) return listEntity;
  }

  // ── Strategy 3: cross-type fallback (venue ↔ promoter) ────────────────────
  // Some clubs registered as /clubs/ also have a /promoters/ entry (and vice
  // versa) that carries the actual events. Try the opposite type.
  if (!isPromoter) {
    // Venue returned nothing → try as promoter (year query)
    const d2 = await gqlFetch(PROMOTER_EVENTS_QUERY, { id: raId, year: THIS_YEAR });
    let alt = d2?.promoter ?? null;
    if (alt) {
      alt.events = (alt.events || []).filter(e => (e.startTime || '').slice(0, 10) >= today);
      if (alt.events.length) return alt;
    }
    // Also try promoter eventListings
    const d3 = await gqlFetch(PROMOTER_LISTING_QUERY, { id: raId, pageSize: 50 });
    const altList = d3?.promoter ?? null;
    if (altList?.eventListings?.length) {
      altList.events = (altList.eventListings || [])
        .filter(e => (e.startTime || '').slice(0, 10) >= today);
      delete altList.eventListings;
      if (altList.events.length) return altList;
    }
  }

  // Return whatever entity we have (may have 0 events) so we don't lose metadata
  return entity || listEntity || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract numeric ID and type from ra.co/clubs/130160 or ra.co/promoters/2767 */
function extractRAId(raUrl) {
  const m = (raUrl || '').match(/ra\.co\/(?:clubs|promoters)\/(\d+)/i);
  return m ? m[1] : null;
}

function isPromoterUrl(raUrl) {
  return /ra\.co\/promoters\//i.test(raUrl || '');
}

/** Extract country name from ISO code (if RA returns a code) */
const COUNTRY_ISO = {
  'GB':'United Kingdom','DE':'Germany','FR':'France','ES':'Spain','NL':'Netherlands',
  'BE':'Belgium','IT':'Italy','PL':'Poland','PT':'Portugal','US':'United States',
  'CA':'Canada','AU':'Australia','JP':'Japan','BR':'Brazil','AR':'Argentina',
  'CO':'Colombia','ZA':'South Africa','MX':'Mexico','CH':'Switzerland','AT':'Austria',
  'HR':'Croatia','DK':'Denmark','SE':'Sweden','CZ':'Czechia','NO':'Norway',
  'RO':'Romania','IE':'Ireland','GR':'Greece','HU':'Hungary','RS':'Serbia',
  'TR':'Turkey','IN':'India','TH':'Thailand','SG':'Singapore','ID':'Indonesia',
  // RA full-name aliases
  'United States of America':'United States',
  'United Kingdom of Great Britain and Northern Ireland':'United Kingdom',
};
function normCountry(c) { return COUNTRY_ISO[c] || c || ''; }

/** Ticket URL: prefer a link whose title contains "ticket", fallback to first */
function ticketUrl(links) {
  if (!Array.isArray(links) || !links.length) return '';
  return (links.find(l => /ticket/i.test(l.title || '')) || links[0]).url || '';
}

/** Normalise one RA event into our Supabase schema.
 *  For promoter events, venue/city/country may come from the event's nested
 *  venue object rather than the parent entity. */
function normaliseRAEvent(e, clubName, city, country) {
  const dateStr = (e.startTime || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;

  // Accept events even without a lineup — many clubs list events before announcing DJs
  const artists = (e.artists || []).map(a => a.name).filter(Boolean);

  // Only skip if truly no useful info at all (no title AND no artists AND no id)
  if (!e.id) return null;

  // For promoter events, the venue info is on each event — prefer it over parent
  const evVenue   = e.venue?.name || '';
  const evCity    = e.venue?.area?.name || '';
  const evCountry = e.venue?.area?.country?.name || '';

  return {
    name:       e.title || `${clubName} event`,
    venue:      evVenue || clubName,
    city:       evCity  || city,
    country:    normCountry(evCountry || country),
    date:       dateStr,
    djs:        artists,
    genre:      'Electronic',
    tags:       ['ra', 'club', 'underground'],
    price:      '',
    ticket_url: ticketUrl(e.promotionalLinks),
    img_url:    e.flyerFront || '',
    source:     'ra',
    source_id:  `ra_${e.id}`,
  };
}

// ── Supabase buffer ───────────────────────────────────────────────────────────

let buffer        = [];
let bufferIds     = new Set();
let totalUpserted = 0;
let totalErrors   = 0;

async function flushBuffer() {
  if (!buffer.length) return;
  const batch = buffer.splice(0);
  bufferIds.clear();
  const { error } = await sb.from('events').upsert(batch, {
    onConflict: 'source_id', ignoreDuplicates: false,
  });
  if (error) { console.error(`\n  ⚠️  ${error.message}`); totalErrors += batch.length; }
  else        { totalUpserted += batch.length; process.stdout.write(` ✓${batch.length}`); }
}

function addEvents(evs) {
  for (const ev of evs) {
    if (!ev?.source_id) continue;
    if (!bufferIds.has(ev.source_id)) { buffer.push(ev); bufferIds.add(ev.source_id); }
  }
  if (buffer.length >= BATCH) flushBuffer();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  SoundMyth – RA Club Scraper             ║');
  console.log('║  Source: ra.co GraphQL API               ║');
  console.log('║  Mode: upsert new (source_id: ra_*)      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const clubsFile = existsSync(resolve(__dirname, 'data/clubs_all.json'))
    ? 'data/clubs_all.json' : 'data/clubs_top100.json';
  const clubs = JSON.parse(readFileSync(resolve(__dirname, clubsFile), 'utf8'));
  const withRA = clubs.filter(c => extractRAId(c.ra_url));
  console.log(`📋  ${clubs.length} clubs total | ${withRA.length} with RA URL\n`);
  console.log('─'.repeat(62));

  const stats = { ok: 0, empty: 0, noId: 0, err: 0 };

  for (let i = 0; i < clubs.length; i++) {
    const club = clubs[i];
    const raId      = extractRAId(club.ra_url);
    const promoter  = isPromoterUrl(club.ra_url);
    const pct       = String(Math.round((i / clubs.length) * 100)).padStart(3);
    process.stdout.write(`[${String(i+1).padStart(3)}/${clubs.length}] ${pct}% │ ${club.name.padEnd(32)} `);

    if (!raId) {
      stats.noId++;
      console.log(`[–] no RA URL`);
      continue;
    }

    const venue = await fetchRAClubEvents(raId, promoter);
    if (!venue) {
      stats.err++;
      console.log(`[✗] fetch error`);
      await sleep(DELAY);
      continue;
    }

    const city    = venue.area?.name    || club.city    || '';
    const country = venue.area?.country?.name || club.country || '';
    const evs = (venue.events || [])
      .map(e => normaliseRAEvent(e, club.name, city, country))
      .filter(Boolean);

    if (!evs.length) {
      stats.empty++;
      console.log(`[–] no upcoming events`);
    } else {
      stats.ok++;
      addEvents(evs);
      console.log(`[RA] → ${evs.length} events`);
    }

    await sleep(DELAY);

    if ((i + 1) % 10 === 0) {
      await flushBuffer();
      const elapsed = (Date.now() - t0) / 1000;
      const rem = Math.round((elapsed / (i + 1)) * (clubs.length - i - 1) / 60);
      console.log(`\n  ⏱  ~${rem}m remaining\n`);
    }
  }

  await flushBuffer();

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  console.log('\n\n╔══════════════════════════════════════════╗');
  console.log('║  RA scrape complete                      ║');
  console.log(`║  Time: ${mm}m${ss}s                              ║`);
  console.log(`║  Clubs with events : ${String(stats.ok).padEnd(20)}║`);
  console.log(`║  No upcoming       : ${String(stats.empty).padEnd(20)}║`);
  console.log(`║  No RA URL         : ${String(stats.noId).padEnd(20)}║`);
  console.log(`║  Fetch errors      : ${String(stats.err).padEnd(20)}║`);
  console.log(`║  Total upserted    : ${String(totalUpserted).padEnd(20)}║`);
  console.log(`║  Errors            : ${String(totalErrors).padEnd(20)}║`);
  console.log('╚══════════════════════════════════════════╝\n');
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

/**
 * SoundMyth – Extended Scraper
 *
 * DJ scraping priority (cascade – stops at first hit):
 *   1) Bandsintown API  (bit_url or artist name lookup)
 *   2) Songkick JSON-LD (songkick_url → /calendar)
 *   3) tour_web → detect Songkick embed → JSON-LD calendar
 *   4) tour_web → JSON-LD MusicEvents directly on page
 *
 * Festivals → own website → JSON-LD Event blocks
 *
 * Usage: node scrape-extended.js
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const TODAY   = new Date().toISOString().split('T')[0];
const BATCH   = 50;
const DELAY_DJ   = 800;   // ms
const DELAY_FEST = 700;   // ms per festival (one fetch)

const sb    = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP ─────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SK_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.songkick.com/',
};
const WEB_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHTML(url, headers = WEB_HEADERS, ms = 12000) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(ms),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Bandsintown API ───────────────────────────────────────────────────────────
const BIT_APP_ID = process.env.BIT_APP_ID || 'js_bandsintown';

async function fetchBIT(artistName) {
  const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(artistName)}/events`
            + `?app_id=${BIT_APP_ID}&date=upcoming`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function normaliseBIT(e, djName, genre, tags) {
  const dateStr = (e.datetime || e.starts_at || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;
  const v = e.venue || {};
  const lineup = Array.isArray(e.lineup) && e.lineup.length ? e.lineup : [djName];
  const ticketUrl = e.offers?.find(o => o.type === 'Tickets')?.url || e.url || '';
  const rawTitle = (e.title || '').trim();
  const rawDesc  = (e.description || '').trim();
  const name = rawTitle || (rawDesc.length <= 120 ? rawDesc : '') || `${djName} at ${v.name || v.city || 'TBC'}`;
  return {
    name,
    venue:      v.name     || '',
    city:       v.city     || '',
    country:    normCountry(v.country || ''),
    date:       dateStr,
    djs:        lineup,
    genre:      genre || '',
    tags:       tagArr(tags, 'bandsintown', 'dj'),
    price:      e.free ? 'Free' : '',
    ticket_url: ticketUrl,
    img_url:    e.artist?.image_url || '',
    source:     'bandsintown',
    source_id:  `bit_${e.id}`,
  };
}

async function scrapeBIT(djName, genre, tags) {
  const raw = await fetchBIT(djName);
  return raw.map(e => normaliseBIT(e, djName, genre, tags)).filter(Boolean);
}

// ── ISO country code → full name ──────────────────────────────────────────────
const COUNTRY_ISO = {
  'GB':'United Kingdom','UK':'United Kingdom',
  'DE':'Germany','FR':'France','ES':'Spain','NL':'Netherlands',
  'BE':'Belgium','IT':'Italy','PL':'Poland','PT':'Portugal',
  'CH':'Switzerland','AT':'Austria','HR':'Croatia','DK':'Denmark',
  'SE':'Sweden','CZ':'Czechia','MT':'Malta','FI':'Finland',
  'NO':'Norway','RO':'Romania','IE':'Ireland','GR':'Greece',
  'LV':'Latvia','RS':'Serbia','CY':'Cyprus','LU':'Luxembourg',
  'LT':'Lithuania','EE':'Estonia','IS':'Iceland','AL':'Albania',
  'MK':'North Macedonia','BY':'Belarus','SK':'Slovakia','RU':'Russia',
  'TR':'Turkey','HU':'Hungary','UA':'Ukraine','BG':'Bulgaria',
  'SI':'Slovenia','BA':'Bosnia and Herzegovina','XK':'Kosovo',
  'ME':'Montenegro','MD':'Moldova','AM':'Armenia','GE':'Georgia',
  'AZ':'Azerbaijan','KZ':'Kazakhstan','UZ':'Uzbekistan',
  'US':'United States','CA':'Canada','AU':'Australia','JP':'Japan',
  'MX':'Mexico','BR':'Brazil','AR':'Argentina','CL':'Chile',
  'CO':'Colombia','ZA':'South Africa','IN':'India','CN':'China',
};
function normCountry(c) { return COUNTRY_ISO[c] || c; }

// ── HTML parsers ──────────────────────────────────────────────────────────────

/** Extract js-initial-data JSON (Songkick) */
function extractSKInitialData(html) {
  const m = html?.match(/<script id="js-initial-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Find first Songkick artist URL embedded in page HTML */
function findSKArtistUrl(html) {
  const m = html?.match(/songkick\.com\/artists\/(\d+[^"'\s>?#]+)/);
  return m ? `https://www.songkick.com/artists/${m[1]}` : null;
}

/** Extract all JSON-LD MusicEvent/Event blocks from HTML */
function extractJSONLDEvents(html) {
  if (!html) return [];
  const events = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const ld    = JSON.parse(m[1]);
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (item['@type'] === 'MusicEvent' || item['@type'] === 'Event') {
          events.push(item);
        }
        if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
          for (const li of item.itemListElement) {
            const inner = li.item || li;
            if (inner['@type'] === 'MusicEvent' || inner['@type'] === 'Event') events.push(inner);
          }
        }
      }
    } catch { /* skip */ }
  }
  return events;
}

// ── Normalisers ───────────────────────────────────────────────────────────────

function tagArr(tags, ...extra) {
  const base = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  return [...new Set([...base, ...extra])];
}

/** Normalise a Songkick concert object from js-initial-data */
function normaliseSKConcert(c, name, genre, tags) {
  const dateStr = (c.start?.date || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;
  const venue   = c.venue?.displayName || '';
  const city    = c.venue?.metroArea?.displayName || '';
  const country = normCountry(c.venue?.metroArea?.country?.displayName || '');
  const lineup  = (c.performance || []).map(p => p.artist?.displayName).filter(Boolean);
  if (!lineup.length) lineup.push(name);
  return {
    name:       c.displayName || `${name} at ${venue || city}`,
    venue, city, country,
    date:       dateStr,
    djs:        lineup,
    genre:      genre || '',
    tags:       tagArr(tags, 'songkick', 'dj'),
    price:      '',
    ticket_url: c.uri || '',
    img_url:    '',
    source:     'songkick',
    source_id:  `sk_${c.id}`,
  };
}

/** Normalise a JSON-LD Event/MusicEvent.
 *  fallback{City,Country} used when JSON-LD location is missing (festival case). */
function normaliseJSONLD(item, fallbackName, genre, tags, source, fallbackCity = '', fallbackCountry = '') {
  const dateStr = (item.startDate || '').split('T')[0];
  if (!dateStr || dateStr < TODAY) return null;

  const loc     = item.location || item.place || {};
  const addr    = loc.address   || {};
  const venue   = loc.name      || '';
  const city    = addr.addressLocality || addr.addressRegion || fallbackCity || '';
  const country = normCountry(addr.addressCountry || fallbackCountry || '');

  // Use URL-based concert ID when available (Songkick /concerts/12345) — prevents duplicate
  // source_id collisions when the same artist plays the same venue on the same date.
  const urlConcertId = (item.url || '').match(/\/concerts\/(\d+)/)?.[1]
                    || (item.url || '').match(/\/events\/(\d+)/)?.[1];
  const source_id = urlConcertId
    ? `sk_${urlConcertId}`
    : `${fallbackName}_${dateStr}_${venue || city}`.replace(/\W+/g, '_').toLowerCase();

  return {
    name:       item.name || `${fallbackName} at ${venue || city}`,
    venue, city, country,
    date:       dateStr,
    djs:        [fallbackName],
    genre:      genre || '',
    tags:       tagArr(tags, source || 'website'),
    price:      item.offers?.price ? `${item.offers.price} ${item.offers.priceCurrency || ''}`.trim() : '',
    ticket_url: item.url || item.offers?.url || '',
    img_url:    item.image || '',
    source:     source || 'website',
    source_id,
  };
}

// ── Songkick artist calendar ──────────────────────────────────────────────────

async function scrapeSKArtist(skUrl, djName, genre, tags) {
  const calUrl = skUrl.replace(/\/?$/, '') + '/calendar';
  const html   = await fetchHTML(calUrl, SK_HEADERS);
  if (!html || html.length < 500) return [];
  if (/access denied|cf-challenge/i.test(html)) return [];

  // Try js-initial-data first (older pages)
  const data = extractSKInitialData(html);
  if (data) {
    const concerts =
      data?.gigography?.upcomingConcerts   ||
      data?.calendarData?.upcomingConcerts ||
      data?.upcomingConcerts               ||
      data?.concerts?.upcoming             ||
      [];
    if (Array.isArray(concerts) && concerts.length) {
      return concerts.map(c => normaliseSKConcert(c, djName, genre, tags)).filter(Boolean);
    }
  }

  // Fallback: JSON-LD (confirmed working on current SK pages)
  return extractJSONLDEvents(html)
    .map(e => normaliseJSONLD(e, djName, genre, tags, 'songkick'))
    .filter(Boolean);
}

// ── Festival website scraper ──────────────────────────────────────────────────

/** Scrape a festival's own website for JSON-LD Event blocks */
async function scrapeFestivalWebsite(websiteUrl, name, city, country) {
  const urlsToTry = [websiteUrl];

  // Also try the domain root in case the lineup URL is a SPA route
  try {
    const u = new URL(websiteUrl);
    if (u.pathname !== '/' && u.pathname !== '') {
      urlsToTry.push(u.origin + '/');
    }
  } catch { /* invalid URL */ }

  for (const url of urlsToTry) {
    const html = await fetchHTML(url);
    if (!html) continue;
    const evs = extractJSONLDEvents(html)
      .map(e => normaliseJSONLD(e, name, 'Electronic', 'festival', 'website', city, country))
      .filter(Boolean)
      .map(ev => ({ ...ev, djs: [], tags: [...new Set([...ev.tags, 'festival'])] }));
    if (evs.length) return evs;
  }
  return [];
}

// ── Supabase buffer ───────────────────────────────────────────────────────────

let buffer         = [];
let bufferIds      = new Set();   // dedup within buffer
let totalUpserted  = 0;
let totalErrors    = 0;

async function flushBuffer() {
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  bufferIds.clear();
  const { error } = await sb.from('events').upsert(batch, {
    onConflict:     'source_id',
    ignoreDuplicates: false,
  });
  if (error) { console.error(`\n  ⚠️  ${error.message}`); totalErrors += batch.length; }
  else       { totalUpserted += batch.length; process.stdout.write(` ✓${batch.length}`); }
}

function addEvents(evs) {
  for (const ev of evs) {
    if (!ev?.source_id || !ev?.date) continue;
    if (!bufferIds.has(ev.source_id)) {
      buffer.push(ev);
      bufferIds.add(ev.source_id);
    }
  }
  if (buffer.length >= BATCH) flushBuffer();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  SoundMyth – Extended Scraper            ║');
  console.log('║  DJs:       Songkick URL → JSON-LD       ║');
  console.log('║             tour_web → SK embed → LD     ║');
  console.log('║  Festivals: own website → JSON-LD        ║');
  console.log('║  Mode: purge past + upsert new           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── Purge past events ──────────────────────────────────────────────────────
  process.stdout.write('🗑  Purging past events... ');
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const { error: purgeErr, count: purgeCount } = await sb
    .from('events')
    .delete({ count: 'exact' })
    .lt('date', yesterday);
  if (purgeErr) console.warn(`⚠️  Purge error: ${purgeErr.message}`);
  else console.log(`done (${purgeCount ?? '?'} events removed)\n`);

  const artists  = JSON.parse(readFileSync(resolve(__dirname, 'data/artists_all.json'), 'utf8'));
  const festivals = JSON.parse(readFileSync(
    resolve(__dirname, existsSync(resolve(__dirname, 'data/festivals_all.json'))
      ? 'data/festivals_all.json' : 'data/festivals_top100.json'), 'utf8'));

  const stats = { dj: { bit: 0, sk: 0, webSK: 0, webLD: 0, none: 0 }, fest: { found: 0, none: 0 } };

  // ── DJs ────────────────────────────────────────────────────────────────────
  console.log(`\n📀  DJs (${artists.length})\n${'─'.repeat(60)}`);

  for (let i = 0; i < artists.length; i++) {
    const dj  = artists[i];
    const pct = String(Math.round((i / artists.length) * 100)).padStart(3);
    process.stdout.write(`[${String(i + 1).padStart(3)}/${artists.length}] ${pct}% │ ${dj.name.padEnd(28)} `);

    // ① Bandsintown API (primary source)
    {
      const evs = await scrapeBIT(dj.name, dj.genre, dj.tags);
      if (evs.length) {
        addEvents(evs); stats.dj.bit++;
        console.log(`[BIT]        → ${evs.length} events`);
        await sleep(DELAY_DJ); continue;
      }
    }

    // ② Songkick direct URL
    if (dj.songkick_url?.includes('songkick.com')) {
      const evs = await scrapeSKArtist(dj.songkick_url, dj.name, dj.genre, dj.tags);
      if (evs.length) {
        addEvents(evs); stats.dj.sk++;
        console.log(`[SK direct]  → ${evs.length} events`);
        await sleep(DELAY_DJ); continue;
      }
    }

    // ③ tour_web: look for Songkick embed
    if (dj.tour_web?.startsWith('http')) {
      const html = await fetchHTML(dj.tour_web);
      if (html) {
        const skUrl = findSKArtistUrl(html);
        if (skUrl) {
          await sleep(400);
          const evs = await scrapeSKArtist(skUrl, dj.name, dj.genre, dj.tags);
          if (evs.length) {
            addEvents(evs); stats.dj.webSK++;
            console.log(`[web→SK]     → ${evs.length} events`);
            await sleep(DELAY_DJ); continue;
          }
        }

        // ④ tour_web: JSON-LD events directly on page
        const ldEvs = extractJSONLDEvents(html)
          .map(e => normaliseJSONLD(e, dj.name, dj.genre, dj.tags, 'website'))
          .filter(Boolean);
        if (ldEvs.length) {
          addEvents(ldEvs); stats.dj.webLD++;
          console.log(`[web→LD]     → ${ldEvs.length} events`);
          await sleep(DELAY_DJ); continue;
        }
      }
    }

    stats.dj.none++;
    console.log(`[–]          no events found`);
    await sleep(300);

    if ((i + 1) % 10 === 0) {
      await flushBuffer();
      const elapsed = (Date.now() - t0) / 1000;
      const rem = Math.round((elapsed / (i + 1)) * (artists.length - i - 1) / 60);
      console.log(`\n  ⏱  ~${rem}m remaining for DJs\n`);
    }
  }
  await flushBuffer();

  // ── Festivals ──────────────────────────────────────────────────────────────
  console.log(`\n\n🎪  Festivals (${festivals.length}) – scraping own websites\n${'─'.repeat(60)}`);
  console.log('  (Note: Songkick festival search is JS-rendered; using website JSON-LD instead)\n');

  for (let i = 0; i < festivals.length; i++) {
    const fest = festivals[i];
    const pct  = String(Math.round((i / festivals.length) * 100)).padStart(3);
    process.stdout.write(`[${String(i + 1).padStart(3)}/${festivals.length}] ${pct}% │ ${fest.name.padEnd(38)} `);

    if (!fest.website?.startsWith('http')) {
      stats.fest.none++;
      console.log(`[–] no website URL`);
      continue;
    }

    const evs = await scrapeFestivalWebsite(fest.website, fest.name, fest.city, fest.country);
    if (evs.length) {
      addEvents(evs); stats.fest.found++;
      console.log(`[WEB→LD]  → ${evs.length} events`);
    } else {
      stats.fest.none++;
      console.log(`[–]       no JSON-LD events`);
    }

    await sleep(DELAY_FEST);
    if ((i + 1) % 10 === 0) {
      await flushBuffer();
      const elapsed = (Date.now() - t0) / 1000;
      const rem = Math.round((elapsed / (artists.length + i + 1)) * (festivals.length - i - 1) / 60);
      console.log(`\n  ⏱  ~${rem}m remaining for Festivals\n`);
    }
  }
  await flushBuffer();

  // ── Summary ────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  console.log('\n\n╔══════════════════════════════════════════╗');
  console.log('║  Extended scrape complete                ║');
  console.log(`║  Time: ${mm}m${ss}s                              ║`);
  console.log(`║  DJs (new events from):                  ║`);
  console.log(`║    BIT=${stats.dj.bit}  SK=${stats.dj.sk}  web→SK=${stats.dj.webSK}  web→LD=${stats.dj.webLD}  none=${stats.dj.none}  ║`);
  console.log(`║  Festivals: found=${stats.fest.found}  none=${stats.fest.none}         ║`);
  console.log(`║  Total upserted: ${String(totalUpserted).padEnd(24)}║`);
  console.log(`║  Errors: ${String(totalErrors).padEnd(32)}║`);
  console.log('╚══════════════════════════════════════════╝\n');
}

main().then(() => process.exit(0)).catch(err => { console.error('Fatal:', err); process.exit(1); });

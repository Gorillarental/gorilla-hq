// ============================================================
// GOOGLE-SCRAPER.JS — Find potential customers via Google Places
// ============================================================

import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyBCk5rBmg6ahRRxEp3bss4hPqZEYBiPkeM';
const SCRAPE_LOG       = path.join(__dirname, 'data/scrape-log.json');
const SCRAPED_IDS_FILE = path.join(__dirname, 'data/scraped-place-ids.json');

function readJSON(fp, fallback = []) {
  try {
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp, JSON.stringify(fallback, null, 2)); return fallback; }
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

// Lazy imports to avoid circular deps
async function getGHLFunctions() {
  const mod = await import('./ghl.js');
  return mod;
}
async function getLoggerFunctions() {
  const mod = await import('./logger.js');
  return mod;
}

export const BUSINESS_CATEGORIES = [
  { query: 'general contractor',               tag: 'type - general contractor',    category: 'Construction' },
  { query: 'construction company',             tag: 'type - construction',          category: 'Construction' },
  { query: 'roofing contractor',               tag: 'type - roofing',               category: 'Construction' },
  { query: 'facade contractor',                tag: 'type - facade',                category: 'Construction' },
  { query: 'concrete contractor',              tag: 'type - concrete',              category: 'Construction' },
  { query: 'painting contractor commercial',   tag: 'type - painter',               category: 'Construction' },
  { query: 'electrical contractor commercial', tag: 'type - electrical',            category: 'Construction' },
  { query: 'HVAC contractor commercial',       tag: 'type - hvac',                  category: 'Construction' },
  { query: 'framing contractor',               tag: 'type - framing',               category: 'Construction' },
  { query: 'drywall contractor',               tag: 'type - drywall',               category: 'Construction' },
  { query: 'property management company',      tag: 'type - property management',   category: 'Property' },
  { query: 'facilities management',            tag: 'type - facilities',            category: 'Property' },
  { query: 'building maintenance',             tag: 'type - building maintenance',  category: 'Property' },
  { query: 'commercial real estate',           tag: 'type - commercial real estate',category: 'Property' },
  { query: 'sign company',                     tag: 'type - signage',               category: 'Specialty' },
  { query: 'window cleaning commercial',       tag: 'type - window cleaning',       category: 'Specialty' },
  { query: 'solar panel installation',         tag: 'type - solar',                 category: 'Specialty' },
  { query: 'tree service commercial',          tag: 'type - tree service',          category: 'Specialty' },
  { query: 'event production company',         tag: 'type - events',                category: 'Events' },
  { query: 'film production company',          tag: 'type - film production',       category: 'Events' },
];

export const SEARCH_AREAS = [
  { name: 'Miami',           lat: 25.7617, lng: -80.1918, county: 'Miami-Dade',  radius: 15000 },
  { name: 'Hialeah',         lat: 25.8576, lng: -80.2781, county: 'Miami-Dade',  radius: 10000 },
  { name: 'Doral',           lat: 25.7959, lng: -80.3533, county: 'Miami-Dade',  radius: 10000 },
  { name: 'Coral Gables',    lat: 25.7215, lng: -80.2684, county: 'Miami-Dade',  radius: 8000  },
  { name: 'Miami Beach',     lat: 25.7907, lng: -80.1300, county: 'Miami-Dade',  radius: 8000  },
  { name: 'Homestead',       lat: 25.4687, lng: -80.4776, county: 'Miami-Dade',  radius: 10000 },
  { name: 'Fort Lauderdale', lat: 26.1224, lng: -80.1373, county: 'Broward',     radius: 15000 },
  { name: 'Hollywood',       lat: 26.0112, lng: -80.1495, county: 'Broward',     radius: 10000 },
  { name: 'Pompano Beach',   lat: 26.2379, lng: -80.1248, county: 'Broward',     radius: 10000 },
  { name: 'Miramar',         lat: 25.9860, lng: -80.3327, county: 'Broward',     radius: 10000 },
  { name: 'Pembroke Pines',  lat: 26.0071, lng: -80.2962, county: 'Broward',     radius: 10000 },
  { name: 'Coral Springs',   lat: 26.2712, lng: -80.2706, county: 'Broward',     radius: 10000 },
  { name: 'West Palm Beach', lat: 26.7153, lng: -80.0534, county: 'Palm Beach',  radius: 15000 },
  { name: 'Boca Raton',      lat: 26.3683, lng: -80.1289, county: 'Palm Beach',  radius: 10000 },
  { name: 'Delray Beach',    lat: 26.4615, lng: -80.0728, county: 'Palm Beach',  radius: 10000 },
  { name: 'Boynton Beach',   lat: 26.5317, lng: -80.0905, county: 'Palm Beach',  radius: 10000 },
];

async function searchGooglePlaces(query, lat, lng, radius = 10000) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
      `keyword=${encodeURIComponent(query)}&location=${lat},${lng}&radius=${radius}&type=establishment&key=${GOOGLE_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status === 'REQUEST_DENIED') throw new Error(`Google API denied: ${data.error_message}`);
    return data.results || [];
  } catch (e) {
    console.error(`[Scraper] Google Places error: ${e.message}`);
    return [];
  }
}

async function getPlaceDetails(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?` +
      `place_id=${placeId}&fields=name,formatted_phone_number,website,formatted_address,rating,user_ratings_total,business_status&key=${GOOGLE_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    return data.result || null;
  } catch { return null; }
}

async function findEmailFromWebsite(website) {
  if (!website) return null;
  try {
    const res  = await fetch(website, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(5000),
    });
    const html = await res.text();
    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatch) {
      const filtered = emailMatch.filter(e =>
        !e.includes('example.com') && !e.includes('sentry') &&
        !e.includes('schema') && !e.includes('w3.org') &&
        !e.includes('jquery') && e.length < 60
      );
      return filtered[0] || null;
    }
    return null;
  } catch { return null; }
}

export async function scrapeAndAddToGHL(options = {}) {
  const {
    categories   = BUSINESS_CATEGORIES,
    areas        = SEARCH_AREAS,
    maxPerSearch = 10,
    maxTotal     = 200,
    dryRun       = false,
  } = options;

  console.log(`[Scraper] Starting... Categories: ${categories.length} | Areas: ${areas.length} | Max: ${maxTotal}`);

  const { createContact, findContactByPhone, addNote, createOpportunity, triggerColdOutreach, normalizePhone, sendSMS } = await getGHLFunctions();

  const scrapedIds = readJSON(SCRAPED_IDS_FILE, []);
  const log        = readJSON(SCRAPE_LOG, []);
  const results    = { found: 0, added: 0, skipped: 0, errors: 0, contacts: [] };
  let totalProcessed = 0;

  for (const area of areas) {
    if (totalProcessed >= maxTotal) break;

    for (const category of categories) {
      if (totalProcessed >= maxTotal) break;

      console.log(`[Scraper] "${category.query}" in ${area.name}...`);
      const places = await searchGooglePlaces(category.query, area.lat, area.lng, area.radius);

      for (const place of places.slice(0, maxPerSearch)) {
        if (totalProcessed >= maxTotal) break;
        if (scrapedIds.includes(place.place_id)) { results.skipped++; continue; }
        if (place.business_status === 'CLOSED_PERMANENTLY') { scrapedIds.push(place.place_id); continue; }

        try {
          const details = await getPlaceDetails(place.place_id);
          if (!details) continue;

          const phone = details.formatted_phone_number?.replace(/[^\d+]/g, '') || null;
          if (!phone) { scrapedIds.push(place.place_id); continue; }

          const website = details.website || null;
          let email = null;
          if (website) { email = await findEmailFromWebsite(website); await new Promise(r => setTimeout(r, 300)); }

          const existing = await findContactByPhone(phone);
          if (existing) { scrapedIds.push(place.place_id); results.skipped++; continue; }

          results.found++;
          totalProcessed++;

          if (dryRun) {
            console.log(`[Scraper] DRY RUN: ${details.name} (${phone})`);
            results.contacts.push({ name: details.name, phone, email, county: area.county });
            scrapedIds.push(place.place_id);
            continue;
          }

          const contact = await createContact({
            name:    details.name,
            phone:   normalizePhone(phone),
            email:   email || undefined,
            website: website || undefined,
            address: details.formatted_address,
            city:    area.name,
            state:   'FL',
            company: details.name,
            source:  'Google Places Scraper',
            tags: [
              'src - cold outreach',
              category.tag,
              `county - ${area.county.toLowerCase().replace(/ /g, '-')}`,
              `city - ${area.name.toLowerCase().replace(/ /g, '-')}`,
            ],
          });

          if (!contact?.id) { results.errors++; continue; }

          await addNote(contact.id,
            `📍 Found via Google Places\nCategory: ${category.query}\nArea: ${area.name}, ${area.county}\n` +
            `Rating: ${details.rating || 'N/A'} (${details.user_ratings_total || 0} reviews)\n` +
            `Website: ${website || 'N/A'}\nAddress: ${details.formatted_address || 'N/A'}\nAdded: ${new Date().toLocaleDateString()}`
          );

          await createOpportunity({
            name: `${details.name} — ${category.category}`,
            contactId: contact.id, contactName: details.name, status: 'open', value: 0,
          });

          await triggerColdOutreach(contact.id);

          results.added++;
          results.contacts.push({ name: details.name, phone, email, county: area.county, city: area.name, ghlId: contact.id, rating: details.rating, category: category.category });
          scrapedIds.push(place.place_id);
          console.log(`[Scraper] ✅ Added: ${details.name} (${area.name})`);
          await new Promise(r => setTimeout(r, 200));

        } catch (e) {
          console.error(`[Scraper] Error: ${e.message}`);
          results.errors++;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  writeJSON(SCRAPED_IDS_FILE, scrapedIds);

  const logEntry = {
    date: new Date().toISOString(), found: results.found, added: results.added,
    skipped: results.skipped, errors: results.errors,
    areas: areas.map(a => a.name).join(', '), categories: categories.length,
  };
  log.push(logEntry);
  writeJSON(SCRAPE_LOG, log);

  try {
    const { logActivity } = await getLoggerFunctions();
    await logActivity({
      agent: 'marketing', action: 'google_scrape_complete',
      description: `Google scrape: ${results.added} new contacts added, ${results.skipped} skipped`,
      status: 'success', metadata: logEntry,
    });
  } catch {}

  if (results.added > 0) {
    try {
      await sendSMS('+15619286999',
        `🦍 GOOGLE SCRAPE COMPLETE\n✅ ${results.added} new contacts added to GHL\n⏭️ ${results.skipped} already existed\n🤖 Cold outreach automation triggered`,
        { name: 'Andrei - Gorilla Rental' }
      );
    } catch {}
  }

  console.log(`[Scraper] DONE: ${results.added} added, ${results.skipped} skipped, ${results.errors} errors`);
  return results;
}

export async function quickScrape(area, category, maxResults = 20) {
  const areaConfig = SEARCH_AREAS.find(a => a.name.toLowerCase() === area.toLowerCase()) || SEARCH_AREAS[6];
  const categoryConfig = BUSINESS_CATEGORIES.find(c =>
    c.query.toLowerCase().includes(category.toLowerCase()) ||
    c.category.toLowerCase() === category.toLowerCase()
  ) || { query: category, tag: `type - ${category.toLowerCase()}`, category: 'General' };

  return scrapeAndAddToGHL({
    areas: [areaConfig], categories: [categoryConfig],
    maxPerSearch: maxResults, maxTotal: maxResults,
  });
}

export function getScrapeHistory() {
  return readJSON(SCRAPE_LOG, []);
}

export function scraperRoutes(app) {
  app.post('/scraper/run', async (req, res) => {
    try {
      res.json({ ok: true, message: 'Scrape started in background — check /scraper/history for progress' });

      const options = {
        maxTotal: req.body.maxTotal || 100,
        maxPerSearch: req.body.maxPerSearch || 10,
        dryRun: req.body.dryRun || false,
      };

      if (req.body.areas) {
        options.areas = SEARCH_AREAS.filter(a =>
          req.body.areas.includes(a.name) || req.body.areas.includes(a.county)
        );
      }

      if (req.body.categories) {
        options.categories = BUSINESS_CATEGORIES.filter(c =>
          req.body.categories.some(cat => c.category.toLowerCase() === cat.toLowerCase())
        );
      }

      scrapeAndAddToGHL(options).catch(e => console.error('[Scraper] Background error:', e.message));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/scraper/quick', async (req, res) => {
    try {
      const { area, category, maxResults } = req.body;
      if (!area || !category) return res.status(400).json({ ok: false, error: 'area and category required' });
      const results = await quickScrape(area, category, maxResults || 20);
      res.json({ ok: true, ...results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/scraper/history', (req, res) => {
    try {
      const history = getScrapeHistory();
      res.json({ ok: true, history, total: history.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/scraper/config', (req, res) => {
    res.json({
      ok: true,
      areas: SEARCH_AREAS.map(a => ({ name: a.name, county: a.county })),
      categories: BUSINESS_CATEGORIES.map(c => ({ query: c.query, category: c.category, tag: c.tag })),
    });
  });

  console.log('[Scraper] ✅ Routes registered');
}

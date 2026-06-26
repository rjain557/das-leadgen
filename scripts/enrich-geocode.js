#!/usr/bin/env node
/**
 * enrich-geocode.js — Normalize addresses via Google Geocoding API
 *
 * Reads the latest full-run JSON, geocodes each lead's address, and writes
 * back canonical addresses + lat/lng. Improves dedup accuracy and enables
 * distance-based HOA matching.
 *
 * Usage:
 *   node scripts/enrich-geocode.js
 *   node scripts/enrich-geocode.js data/output/full-run-2026-04-01.json
 *   node scripts/enrich-geocode.js --dry-run          # preview without modifying
 *   node scripts/enrich-geocode.js --force             # re-geocode already geocoded leads
 *
 * Free tier: 40,000 requests/month (more than enough for weekly runs of ~200 leads)
 */

const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const API_KEY = process.env.GOOGLE_GEOCODING_API_KEY;
const BASE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const CACHE_PATH = path.join(OUTPUT_DIR, 'geocode-cache.json');

// Rate limit: 50 QPS allowed, we'll do 10/sec to be safe
const DELAY_MS = 100;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let dryRun = false;
  let force = false;

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (!arg.startsWith('--')) inputFile = arg;
  }

  if (!inputFile) {
    inputFile = findLatestFullRun();
  }

  return { inputFile, dryRun, force };
}

function findLatestFullRun() {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('full-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(OUTPUT_DIR, files[0]) : null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function loadCache() {
  if (fs.existsSync(CACHE_PATH)) {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { /* empty */ }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeAddress(address) {
  const params = new URLSearchParams({
    address,
    key: API_KEY,
    components: 'country:US|administrative_area:CA',
  });

  const res = await fetch(`${BASE_URL}?${params}`);
  const data = await res.json();

  if (data.status === 'OK' && data.results.length > 0) {
    const result = data.results[0];
    const components = {};

    for (const comp of result.address_components) {
      for (const type of comp.types) {
        components[type] = comp.long_name;
        components[`${type}_short`] = comp.short_name;
      }
    }

    return {
      formatted: result.formatted_address,
      line1: [
        components.street_number || '',
        components.route || '',
      ].filter(Boolean).join(' '),
      city: components.locality || components.sublocality || '',
      state: components.administrative_area_level_1_short || 'CA',
      zip: components.postal_code || '',
      county: components.administrative_area_level_2 || '',
      neighborhood: components.neighborhood || '',
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      placeId: result.place_id,
      confidence: result.geometry.location_type, // ROOFTOP, RANGE_INTERPOLATED, etc.
    };
  }

  if (data.status === 'OVER_QUERY_LIMIT') {
    throw new Error('Google Geocoding API quota exceeded');
  }

  return null; // ZERO_RESULTS or other
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error('Missing GOOGLE_GEOCODING_API_KEY in .env');
    process.exit(1);
  }

  const { inputFile, dryRun, force } = parseArgs();
  if (!inputFile) {
    console.error('No input file found. Run the pipeline first or specify a file.');
    process.exit(1);
  }

  console.log(`Reading: ${inputFile}`);
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const leads = data.leads || [];

  if (leads.length === 0) {
    console.log('No leads to geocode.');
    return;
  }

  const cache = loadCache();
  let geocoded = 0;
  let cached = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`Processing ${leads.length} leads (${dryRun ? 'DRY RUN' : 'LIVE'})...`);

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const rawAddr = lead.address?.full || lead.address?.line1 || '';

    if (!rawAddr) {
      skipped++;
      continue;
    }

    // Skip already-geocoded leads unless --force
    if (!force && lead.address?.lat && lead.address?.lng) {
      skipped++;
      continue;
    }

    // Check cache first
    const cacheKey = rawAddr.toUpperCase().trim();
    if (cache[cacheKey]) {
      const geo = cache[cacheKey];
      if (!dryRun) {
        applyGeocode(lead, geo);
      }
      cached++;
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] Would geocode: ${rawAddr}`);
      geocoded++;
      continue;
    }

    // Live geocode
    try {
      const geo = await geocodeAddress(rawAddr);

      if (geo) {
        applyGeocode(lead, geo);
        cache[cacheKey] = geo;
        geocoded++;

        if ((geocoded % 25) === 0) {
          console.log(`  Geocoded ${geocoded} leads...`);
        }
      } else {
        console.log(`  No result: ${rawAddr}`);
        failed++;
      }

      await sleep(DELAY_MS);
    } catch (err) {
      if (err.message.includes('quota exceeded')) {
        console.error(`\nQuota exceeded after ${geocoded} geocodes. Saving progress...`);
        break;
      }
      console.log(`  Error: ${rawAddr} — ${err.message}`);
      failed++;
    }
  }

  // Save results
  if (!dryRun) {
    saveCache(cache);
    fs.writeFileSync(inputFile, JSON.stringify(data, null, 2) + '\n');
    console.log(`\nUpdated: ${inputFile}`);
  }

  console.log(`\nResults:`);
  console.log(`  Geocoded:  ${geocoded}`);
  console.log(`  Cached:    ${cached}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Cache size: ${Object.keys(cache).length} entries`);
}

function applyGeocode(lead, geo) {
  // Update address with canonical data
  if (geo.line1) lead.address.line1 = geo.line1;
  if (geo.city) lead.address.city = geo.city;
  if (geo.state) lead.address.state = geo.state;
  if (geo.zip) lead.address.zip = geo.zip;
  if (geo.formatted) lead.address.full = geo.formatted;
  if (geo.neighborhood) lead.address.neighborhood = geo.neighborhood;

  // Add geo fields
  lead.address.lat = geo.lat;
  lead.address.lng = geo.lng;
  lead.address.placeId = geo.placeId;
  lead.address.geoConfidence = geo.confidence;
  lead.address.county = geo.county;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

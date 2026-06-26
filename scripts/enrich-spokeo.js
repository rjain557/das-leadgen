#!/usr/bin/env node
/**
 * enrich-spokeo.js — Spokeo name-based contact enrichment fallback
 *
 * Spokeo works best when searching by owner NAME (not address).
 * This is a FALLBACK for leads where:
 *   1. Owner name exists
 *   2. BatchData returned NO phone/email
 *   3. Lead is Tier 1 or Tier 2 (worth the extra lookup time)
 *
 * Usage (CLI):
 *   node scripts/enrich-spokeo.js --input data/output/full-run-2026-03-25.json
 *   node scripts/enrich-spokeo.js --input data/output/full-run-2026-03-25.json --tier 1,2 --headed
 *   node scripts/enrich-spokeo.js --input data/output/full-run-2026-03-25.json --dry-run
 *
 * Usage (module):
 *   const { spokeoLookup, enrichLeadsWithSpokeo } = require('./enrich-spokeo');
 *   const result = await spokeoLookup('John Smith', 'Laguna Beach', 'CA', page);
 *   const enriched = await enrichLeadsWithSpokeo(leads, page, { tiers: [1, 2] });
 */

const { launchBrowser } = require('../agents/shared/browser');
const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const CACHE_PATH = path.join(OUTPUT_DIR, 'spokeo-contacts.json');
const DEBUG_DIR = path.join(ROOT, 'artifacts', 'debug');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cacheKey(name) {
  return String(name).toUpperCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minMs = 3000, maxMs = 5000) {
  return delay(minMs + Math.random() * (maxMs - minMs));
}

async function saveDebugScreenshot(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `spokeo-${label}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(DEBUG_DIR, filename), fullPage: false });
    return filename;
  } catch {
    return null;
  }
}

/**
 * Auto-login to Spokeo using credentials from .env.
 * Falls back to manual login if auto-login fails.
 */
async function checkLoginWall(page) {
  const url = page.url();
  if (!url.includes('/login') && !url.includes('/signup') && !url.includes('/register')) {
    return true;
  }

  const email = process.env.SPOKEO_EMAIL;
  const password = process.env.SPOKEO_PASSWORD;

  if (email && password) {
    console.log(`  Auto-logging in to Spokeo as ${email}...`);
    try {
      // Navigate to login page if not already there
      if (!url.includes('/login')) {
        await page.goto('https://www.spokeo.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await delay(2000);
      }

      // Fill email
      const emailInput = page.locator('input[type="email"], input[name="email"], input[id*="email"]').first();
      await emailInput.fill(email);

      // Fill password
      const pwInput = page.locator('input[type="password"], input[name="password"]').first();
      await pwInput.fill(password);

      // Click login/submit button
      const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")').first();
      await submitBtn.click();

      // Wait for redirect away from login page
      await page.waitForURL(u => !u.toString().includes('/login') && !u.toString().includes('/signup'), {
        timeout: 30000,
      });
      console.log('  Auto-login successful.');
      await delay(2000);
      return true;
    } catch (err) {
      console.log(`  Auto-login failed: ${err.message}`);
    }
  }

  // Fallback: manual login
  console.log('\n  *** Spokeo requires login. Please log in manually in the browser window. ***');
  console.log('  *** Waiting up to 120 seconds for you to complete login... ***\n');
  try {
    await page.waitForURL(u => !u.toString().includes('/login') && !u.toString().includes('/signup'), {
      timeout: 120000,
    });
    console.log('  Login detected. Resuming...');
    await delay(2000);
    return true;
  } catch {
    console.log('  Login timeout — skipping Spokeo enrichment.');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parse Spokeo results page
// ---------------------------------------------------------------------------
function parsePhoneNumbers(text) {
  // Spokeo shows partial numbers like (XXX) XXX-1234 or full numbers
  const phoneRegex = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  const partialRegex = /\(\w{3}\)\s*\w{3}-\d{4}/g;
  const matches = text.match(phoneRegex) || text.match(partialRegex) || [];
  return [...new Set(matches.map(p => p.replace(/[^\d]/g, '')))].filter(p => p.length >= 7);
}

function parseEmails(text) {
  // Spokeo may show partial emails like j***@gmail.com or full emails
  const emailRegex = /[\w.*]+@[\w.-]+\.\w{2,}/g;
  const matches = text.match(emailRegex) || [];
  return [...new Set(matches)].filter(e => !e.includes('spokeo'));
}

// ---------------------------------------------------------------------------
// Core: single person lookup
// ---------------------------------------------------------------------------
/**
 * Look up a person on Spokeo by name + city/state.
 *
 * @param {string} name    - Full name (e.g., "John Smith")
 * @param {string} city    - City (e.g., "Laguna Beach")
 * @param {string} state   - State abbreviation (default: "CA")
 * @param {import('playwright').Page} page - Playwright page instance
 * @returns {{ phone: string[], email: string[], address: string, raw: string, cached: boolean }}
 */
async function spokeoLookup(name, city, state = 'CA', page) {
  const key = cacheKey(name);
  const cache = loadCache();

  // Return cached result if available
  if (cache[key]) {
    return { ...cache[key], cached: true };
  }

  const result = { phone: [], email: [], address: '', raw: '', cached: false };

  try {
    // Build Spokeo people-search URL with name and location
    const nameSlug = name.trim().replace(/\s+/g, '-');
    const locationSlug = `${city}-${state}`.replace(/\s+/g, '-');
    const searchUrl = `https://www.spokeo.com/${encodeURIComponent(nameSlug)}/${encodeURIComponent(locationSlug)}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // Check for login wall
    const loginOk = await checkLoginWall(page);
    if (!loginOk) {
      cache[key] = { phone: [], email: [], address: '', error: 'login-required' };
      saveCache(cache);
      return { ...cache[key], cached: false };
    }

    // Wait for results to load
    await page.waitForTimeout(2000);

    // Check for "no results" page
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/no results|didn't find|0 results|no records/i.test(bodyText)) {
      cache[key] = { phone: [], email: [], address: '', error: 'no-results' };
      saveCache(cache);
      return { ...cache[key], cached: false };
    }

    // Try to find the first result link and click into the profile
    const resultLink = await page.$('a[href*="/people/"][class*="result"], .results-list a, a[data-link*="profile"]');
    if (resultLink) {
      await resultLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await delay(2000);

      // Re-check login wall after clicking profile
      const loginOk2 = await checkLoginWall(page);
      if (!loginOk2) {
        cache[key] = { phone: [], email: [], address: '', error: 'login-required' };
        saveCache(cache);
        return { ...cache[key], cached: false };
      }
    }

    // Extract data from the page
    const pageText = await page.evaluate(() => document.body.innerText);
    result.raw = pageText.substring(0, 2000); // save first 2K for debugging

    // Parse phone numbers
    result.phone = parsePhoneNumbers(pageText);

    // Parse emails
    result.email = parseEmails(pageText);

    // Try to extract current address
    const addrMatch = pageText.match(/(?:Current Address|Lives in|Resides at)[:\s]*([^\n]{5,80})/i);
    if (addrMatch) {
      result.address = addrMatch[1].trim();
    }

    // Cache the result (without raw text to save space)
    cache[key] = {
      phone: result.phone,
      email: result.email,
      address: result.address,
      lookedUp: new Date().toISOString(),
    };
    saveCache(cache);

  } catch (err) {
    const screenshot = await saveDebugScreenshot(page, `error-${name.replace(/\s+/g, '-')}`);
    console.log(`  WARN: Spokeo lookup failed for "${name}": ${err.message}${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
    cache[key] = { phone: [], email: [], address: '', error: err.message };
    saveCache(cache);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Batch: enrich an array of leads
// ---------------------------------------------------------------------------
/**
 * Enrich an array of leads with Spokeo contact data.
 * Only processes leads that:
 *   - Have owner.name (length > 3)
 *   - Do NOT have owner.phone
 *   - Match the specified tiers
 *
 * @param {Array} leads   - Array of lead objects (same shape as full-run JSON)
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {Object} options
 * @param {number[]} options.tiers - Tiers to process (default: [1, 2])
 * @param {number} options.minScore - Minimum score to process (default: 6)
 * @param {boolean} options.dryRun - If true, just report what would be looked up
 * @returns {{ enriched: number, looked: number, cached: number, errors: number }}
 */
async function enrichLeadsWithSpokeo(leads, page, options = {}) {
  const tiers = options.tiers || [1, 2];
  const minScore = options.minScore || 6;
  const dryRun = options.dryRun || false;

  // Filter candidates: has owner name, no phone, matching tier/score
  const candidates = leads.filter(l =>
    l.owner && l.owner.name && l.owner.name.length > 3 &&
    !l.owner.phone &&
    (tiers.includes(l.tier) || l.score >= minScore)
  );

  console.log(`  Spokeo candidates: ${candidates.length} leads (Tier ${tiers.join('/')} without phone)`);

  if (dryRun) {
    for (const lead of candidates) {
      const city = lead.address?.city || '';
      console.log(`    [DRY RUN] Would look up: ${lead.owner.name} in ${city}`);
    }
    return { enriched: 0, looked: 0, cached: 0, errors: 0 };
  }

  if (candidates.length === 0) {
    return { enriched: 0, looked: 0, cached: 0, errors: 0 };
  }

  const stats = { enriched: 0, looked: 0, cached: 0, errors: 0 };

  for (let i = 0; i < candidates.length; i++) {
    const lead = candidates[i];
    const name = lead.owner.name.trim();
    const city = lead.address?.city || 'Orange County';

    process.stdout.write(`\r  Spokeo: ${i + 1}/${candidates.length} — ${name}`);

    const result = await spokeoLookup(name, city, 'CA', page);

    if (result.cached) {
      stats.cached++;
    } else {
      stats.looked++;
      // Delay between non-cached lookups to avoid rate limiting
      if (i < candidates.length - 1) {
        await randomDelay(3000, 5000);
      }
    }

    if (result.error) {
      stats.errors++;
      continue;
    }

    // Apply results to the lead
    let didEnrich = false;
    if (result.phone.length > 0 && !lead.owner.phone) {
      // Format as (XXX) XXX-XXXX if we have 10 digits
      const p = result.phone[0];
      lead.owner.phone = p.length === 10
        ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`
        : p;
      lead.owner.phoneSource = 'spokeo';
      didEnrich = true;
    }
    if (result.email.length > 0 && !lead.owner.email) {
      lead.owner.email = result.email[0];
      lead.owner.emailSource = 'spokeo';
      didEnrich = true;
    }

    if (didEnrich) stats.enriched++;
  }

  if (candidates.length > 0) console.log(''); // newline after progress

  return stats;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let tiers = [1, 2];
  let headed = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
      case '-i':
        inputPath = args[++i];
        break;
      case '--tier':
      case '--tiers':
        tiers = args[++i].split(',').map(Number);
        break;
      case '--headed':
        headed = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Spokeo Contact Enrichment — name-based fallback for leads without phone/email

Usage:
  node scripts/enrich-spokeo.js --input <full-run.json> [options]

Options:
  --input, -i    Path to full-run JSON file (required)
  --tier         Comma-separated tiers to process (default: 1,2)
  --headed       Run browser in headed mode (visible)
  --dry-run      Show what would be looked up without doing it
  --help, -h     Show this help
        `);
        process.exit(0);
    }
  }

  if (!inputPath) {
    // Try to find the latest full-run JSON
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.startsWith('full-run-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length > 0) {
      inputPath = path.join(OUTPUT_DIR, files[0]);
      console.log(`Auto-detected input: ${path.basename(inputPath)}`);
    } else {
      console.error('No input file specified and no full-run JSON found in data/output/');
      process.exit(1);
    }
  }

  // Resolve path
  if (!path.isAbsolute(inputPath)) {
    inputPath = path.resolve(ROOT, inputPath);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Load leads
  const rawData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const leads = Array.isArray(rawData) ? rawData : (rawData.leads || rawData.results || rawData.data || []);
  console.log(`Loaded ${leads.length} leads from ${path.basename(inputPath)}`);

  // Launch browser
  let browser = null;
  let page = null;

  if (!dryRun) {
    console.log(`Launching Edge browser (${headed ? 'headed' : 'headless'})...`);
    const launched = await launchBrowser({ channel: 'msedge', headed });
    browser = launched.browser;

    // Use persistent context to retain login cookies
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();
  }

  try {
    const stats = await enrichLeadsWithSpokeo(leads, page, { tiers, dryRun });

    console.log(`\nSpokeo enrichment complete:`);
    console.log(`  Enriched:  ${stats.enriched} leads with new contact info`);
    console.log(`  Looked up: ${stats.looked} new searches`);
    console.log(`  Cached:    ${stats.cached} from cache`);
    console.log(`  Errors:    ${stats.errors}`);

    // Write updated leads back
    if (stats.enriched > 0) {
      const outputPath = inputPath.replace('.json', '-spokeo.json');
      if (Array.isArray(rawData)) {
        fs.writeFileSync(outputPath, JSON.stringify(leads, null, 2));
      } else {
        rawData.leads = leads;
        rawData.spokeoEnrichment = {
          date: new Date().toISOString(),
          ...stats,
        };
        fs.writeFileSync(outputPath, JSON.stringify(rawData, null, 2));
      }
      console.log(`  Output:    ${path.basename(outputPath)}`);
    }
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { spokeoLookup, enrichLeadsWithSpokeo, loadCache, saveCache, cacheKey };

// Run CLI if invoked directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

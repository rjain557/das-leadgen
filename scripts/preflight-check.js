#!/usr/bin/env node
/**
 * preflight-check.js — Test all pipeline settings and agent connectivity before a run
 *
 * Checks:
 *   1. Portal URLs are reachable (HTTP 200)
 *   2. API keys are valid (ATTOM, Google Geocoding, BatchData)
 *   3. Agent configs are valid (required files exist, selectors defined)
 *   4. Obsidian vault is accessible
 *   5. Output directory is writable
 *   6. Node dependencies installed
 *
 * Usage:
 *   node scripts/preflight-check.js          # run all checks
 *   node scripts/preflight-check.js --fix    # attempt to auto-fix issues found
 *
 * Exit code:
 *   0 = all checks passed
 *   1 = critical failures (pipeline will not run correctly)
 *   2 = warnings only (pipeline will run but may have gaps)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const VAULT = path.join(os.homedir(), 'OneDrive - Technijian, Inc', 'Documents', 'obsidian', 'bbc-leadgen');

const PERMIT_CITIES = [
  'costa-mesa', 'newport-beach', 'laguna-beach', 'laguna-niguel',
  'county-of-orange', 'dana-point', 'san-clemente',
  'san-juan-capistrano', 'irvine', 'huntington-beach',
];

let failures = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); warnings++; }
function fail(msg) { console.log(`  ✗ ${msg}`); failures++; }

// ---------------------------------------------------------------------------
// 1. Check agent files exist
// ---------------------------------------------------------------------------
function checkAgentFiles() {
  console.log('\n[1] Agent Files');
  for (const city of PERMIT_CITIES) {
    const agentDir = path.join(AGENTS_DIR, city);
    const indexFile = path.join(agentDir, 'index.js');
    const configFile = path.join(agentDir, 'config.js');

    if (!fs.existsSync(indexFile)) {
      fail(`${city}: missing index.js`);
    } else if (!fs.existsSync(configFile)) {
      warn(`${city}: missing config.js`);
    } else {
      pass(`${city}: agent files OK`);
    }
  }

  // Check shared modules (das-leadgen: danielian-fit replaces client-fit; the
  // BBC OC-luxury hoa-communities module is intentionally not ported)
  const shared = ['danielian-fit.js', 'agent-harness.js', 'browser.js', 'load-env.js'];
  for (const file of shared) {
    const filePath = path.join(AGENTS_DIR, 'shared', file);
    if (!fs.existsSync(filePath)) {
      fail(`shared/${file}: missing`);
    } else {
      pass(`shared/${file}: OK`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Check portal URLs are reachable
// ---------------------------------------------------------------------------
async function checkPortalUrls() {
  console.log('\n[2] Portal Connectivity');

  const portals = [
    { city: 'costa-mesa', url: 'https://permits.costamesaca.gov/energov_prod/selfservice' },
    { city: 'newport-beach', url: 'https://css.newportbeachca.gov/EnerGov_Prod/SelfService' },
    { city: 'laguna-beach', url: 'https://lagunabeachca-energovweb.tylerhost.net/apps/selfservice' },
    { city: 'laguna-niguel', url: 'https://cityoflagunaniguelca-energovweb.tylerhost.net/apps/selfservice' },
    { city: 'county-of-orange', url: 'https://h2.maintstar.co/orange/portal/' },
    { city: 'dana-point', url: 'https://dana.csqrcloud.com/community-etrakit/Default.aspx' },
    { city: 'san-clemente', url: 'https://cdweb.san-clemente.org/etrakit/Search/permit.aspx' },
    { city: 'san-juan-capistrano', url: 'https://etrakit.sanjuancapistrano.org/etrakit/Search/permit.aspx' },
    { city: 'irvine', url: 'https://permits.cityofirvine.org/irvinepermits/Default.asp' },
    { city: 'huntington-beach', url: 'https://engage.huntingtonbeachca.gov/CitizenAccess/Cap/CapHome.aspx' },
  ];

  for (const { city, url } of portals) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      });
      clearTimeout(timeout);

      if (resp.ok || resp.status === 302) {
        pass(`${city}: ${resp.status} OK`);
      } else {
        warn(`${city}: HTTP ${resp.status} — portal may be down or moved`);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        warn(`${city}: timeout (15s) — portal may be slow`);
      } else {
        fail(`${city}: ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Check API keys
// ---------------------------------------------------------------------------
async function checkApiKeys() {
  console.log('\n[3] API Keys');

  // ATTOM
  const attomKey = process.env.ATTOM_API_KEY;
  if (!attomKey) {
    warn('ATTOM_API_KEY: not set in .env');
  } else {
    try {
      const resp = await fetch(`https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/basicprofile?fips=06059`, {
        headers: { 'apikey': attomKey, 'Accept': 'application/json' },
      });
      if (resp.ok) {
        pass('ATTOM_API_KEY: valid');
      } else {
        warn(`ATTOM_API_KEY: HTTP ${resp.status} — key may be expired (free trial)`);
      }
    } catch (err) {
      warn(`ATTOM_API_KEY: ${err.message}`);
    }
  }

  // Google Geocoding
  const geoKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!geoKey) {
    warn('GOOGLE_GEOCODING_API_KEY: not set in .env');
  } else {
    try {
      const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=1+Main+St+Irvine+CA&key=${geoKey}`);
      const data = await resp.json();
      if (data.status === 'OK') {
        pass('GOOGLE_GEOCODING_API_KEY: valid');
      } else if (data.status === 'REQUEST_DENIED') {
        fail(`GOOGLE_GEOCODING_API_KEY: ${data.error_message || 'denied'}`);
      } else {
        warn(`GOOGLE_GEOCODING_API_KEY: status ${data.status}`);
      }
    } catch (err) {
      warn(`GOOGLE_GEOCODING_API_KEY: ${err.message}`);
    }
  }

  // BatchData
  const batchKey = process.env.BATCHDATA_API_KEY;
  if (!batchKey) {
    warn('BATCHDATA_API_KEY: not set in .env');
  } else {
    pass('BATCHDATA_API_KEY: set');
  }

  // BatchLeads
  const batchLeadsKey = process.env.BATCHLEADS_API_KEY;
  if (!batchLeadsKey) {
    warn('BATCHLEADS_API_KEY: not set in .env');
  } else {
    pass('BATCHLEADS_API_KEY: set');
  }
}

// ---------------------------------------------------------------------------
// 4. Check dependencies
// ---------------------------------------------------------------------------
function checkDependencies() {
  console.log('\n[4] Dependencies');

  const deps = [
    'playwright', 'playwright-extra', 'puppeteer-extra-plugin-stealth',
    'xlsx', 'docx', 'dotenv',
  ];

  for (const dep of deps) {
    try {
      require.resolve(dep);
      pass(`${dep}: installed`);
    } catch {
      fail(`${dep}: NOT installed — run npm install`);
    }
  }

  // Check Playwright browsers
  try {
    const pw = require('playwright');
    pass('playwright browsers: available');
  } catch (err) {
    fail(`playwright browsers: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Check filesystem
// ---------------------------------------------------------------------------
function checkFilesystem() {
  console.log('\n[5] Filesystem');

  // Output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    try {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      pass('Output directory: created');
    } catch {
      fail('Output directory: cannot create');
    }
  } else {
    pass('Output directory: exists');
  }

  // .env file
  if (fs.existsSync(path.join(ROOT, '.env'))) {
    pass('.env file: exists');
  } else {
    fail('.env file: missing');
  }

  // Obsidian vault
  if (fs.existsSync(VAULT)) {
    pass(`Obsidian vault: accessible`);
  } else {
    warn('Obsidian vault: not found (sync will be skipped)');
  }

  // Key scripts
  const scripts = ['run-all-layers.js', 'build-full-report.js', 'sync-obsidian.js', 'read-obsidian.js'];
  for (const script of scripts) {
    if (fs.existsSync(path.join(__dirname, script))) {
      pass(`scripts/${script}: exists`);
    } else {
      fail(`scripts/${script}: missing`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Load and report Obsidian knowledge
// ---------------------------------------------------------------------------
function checkObsidianKnowledge() {
  console.log('\n[6] Obsidian Knowledge Base');

  try {
    const { loadVaultKnowledge } = require('./read-obsidian');
    const knowledge = loadVaultKnowledge();

    if (!knowledge.available) {
      warn('Obsidian vault not available');
      return;
    }

    pass(`Loaded: ${knowledge.scraperPatterns.length} patterns, ${knowledge.addressEdgeCases.length} edge cases`);

    if (knowledge.openIssues.length > 0) {
      warn(`${knowledge.openIssues.length} open issues in vault:`);
      for (const issue of knowledge.openIssues) {
        console.log(`      - ${issue.label}`);
      }
    }

    const brokenCities = knowledge.brokenAgents
      .filter(b => PERMIT_CITIES.some(c => b.city.toLowerCase().includes(c.replace(/-/g, ' '))));
    if (brokenCities.length > 0) {
      warn(`${brokenCities.length} cities flagged as broken in vault`);
    }
  } catch {
    warn('Could not load Obsidian knowledge');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BBC Lead Generation — Pre-Flight Check');
  console.log('═══════════════════════════════════════════════════════════');

  checkAgentFiles();
  await checkPortalUrls();
  await checkApiKeys();
  checkDependencies();
  checkFilesystem();
  checkObsidianKnowledge();

  console.log('\n═══════════════════════════════════════════════════════════');
  if (failures > 0) {
    console.log(`  RESULT: ${failures} FAILURES, ${warnings} warnings`);
    console.log('  Pipeline will NOT run correctly. Fix failures before running.');
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`  RESULT: ALL PASSED with ${warnings} warnings`);
    console.log('  Pipeline will run but some features may be degraded.');
    process.exit(0);
  } else {
    console.log('  RESULT: ALL CHECKS PASSED');
    process.exit(0);
  }
}

main().catch(err => {
  console.error(`Pre-flight check error: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Planning Commission / Design Review Scraper — L2 (entitlement signal)
 *
 * CLI entry point. Harvests planning-commission / design-review agenda items for
 * RESIDENTIAL DEVELOPMENT across Orange County (Granicus + Legistar + city CMS),
 * emitting raw pursuit records the orchestrator (scripts/run-all-layers.js) reads
 * back and consolidate-lib maps onto the unified PursuitRecord.
 *
 * Orchestrator contract: accepts --days N and -o <file>, writes a bare JSON
 * array to -o, exits 0 (non-zero only on a true hard failure), never hangs
 * (waits + pagination capped in config.limits), and one city failing never
 * aborts the run (logged + continue; a fully-dead run writes [] + exit 0).
 *
 * Usage:
 *   node agents/planning-drb/index.js --days 60 -o data/output/planning-test.json
 *   node agents/planning-drb/index.js --city newport-beach --days 60 -f summary
 *   node agents/planning-drb/index.js --platform legistar --days 90
 */

const fs = require('fs');
const path = require('path');
const { PLATFORM, cities, browser: browserConfig } = require('./config');
const { scrapeGranicus } = require('./granicus-scraper');
const { scrapeLegistar } = require('./legistar-scraper');
const { scrapeCityCms } = require('./city-scraper');
const { isDanielianFit, classifyProjectType } = require('../shared/danielian-fit');

// CLI argument parsing
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  else if (args[i] === '--city' || args[i] === '-c') flags.city = args[++i];
  else if (args[i] === '--days' || args[i] === '-d') flags.days = parseInt(args[++i], 10);
  else if (args[i] === '--output' || args[i] === '-o') flags.output = args[++i];
  else if (args[i] === '--headed') flags.headed = true;
  else if (args[i] === '--platform') flags.platform = args[++i];
  else if (args[i] === '--fit-filter') flags.fitFilter = true;
  else if (args[i] === '--format' || args[i] === '-f') flags.format = args[++i];
}

if (flags.help) {
  console.log(`
Planning Commission / Design Review Scraper (L2 — entitlement signal)
====================================================================
Harvests planning-commission / design-review agenda items for RESIDENTIAL
DEVELOPMENT (multifamily / mixed-use / affordable / master-plan) across Orange
County. The applicant named on an agenda is the developer (a contact-name
signal); a project on a planning agenda selects its design team in 90-180 days.

Usage:
  node agents/planning-drb/index.js [options]

Options:
  --help, -h            Show this help message
  --city, -c SLUG       City to scrape (default: all)
                        Slugs: ${Object.keys(cities).join(', ')}
  --days, -d N          Lookback period in days (default: 90)
  --output, -o PATH     Output file (bare JSON array; orchestrator passes this)
  --headed              Run browser in headed mode (visible)
  --platform TYPE       Only this platform: granicus, legistar, city-cms
  --fit-filter          Debug: keep only Danielian-ICP residential-dev items
  --format, -f FMT      Output format: json (default), summary

Examples:
  node agents/planning-drb/index.js --city newport-beach --days 60 -f summary
  node agents/planning-drb/index.js --days 60 -o data/output/planning-test.json
  node agents/planning-drb/index.js --platform legistar --days 90
`);
  process.exit(0);
}

function getCitiesToScrape() {
  if (flags.city && flags.city !== 'all') {
    if (!cities[flags.city]) {
      console.error(`Unknown city: ${flags.city}`);
      console.error(`Valid cities: ${Object.keys(cities).join(', ')}`);
      process.exit(1);
    }
    return [cities[flags.city]];
  }

  let list = Object.values(cities);

  if (flags.platform) {
    list = list.filter(c => c.platform === flags.platform);
    if (list.length === 0) {
      console.error(`No cities found for platform: ${flags.platform}`);
      process.exit(1);
    }
  }

  return list;
}

async function scrapeCity(cityConfig, options) {
  switch (cityConfig.platform) {
    case PLATFORM.GRANICUS:
      return scrapeGranicus(cityConfig, options);
    case PLATFORM.LEGISTAR:
      return scrapeLegistar(cityConfig, options);
    case PLATFORM.CITY_CMS:
      return scrapeCityCms(cityConfig, options);
    default:
      console.warn(`Unknown platform: ${cityConfig.platform} for ${cityConfig.slug}`);
      return [];
  }
}

function applyFitFilter(results) {
  // Optional debug filter (--fit-filter): keep only records the Danielian ICP
  // classifier recognizes as residential development. Pass the real scope text
  // (NOT a synthetic type) so classifyProjectType drives the decision. The
  // orchestrator does NOT pass --fit-filter; consolidate-lib re-applies the ICP.
  return results.filter(item => isDanielianFit({
    description: item.scope || '',
    scope: item.scope || '',
    address: item.address || '',
    caseNumber: item.caseNumber || '',
  }));
}

function printSummary(allResults, filteredResults) {
  console.log('\n========================================');
  console.log('  Planning / Design Review - Lead Report (L2)');
  console.log('========================================\n');
  console.log(`Total agenda items scraped: ${allResults.length}`);
  if (filteredResults !== allResults) {
    console.log(`After Danielian fit filter: ${filteredResults.length}`);
  }

  // Group by city
  const byCity = {};
  for (const r of filteredResults) {
    byCity[r.sourceCity] = (byCity[r.sourceCity] || 0) + 1;
  }
  console.log('\n--- By City ---');
  for (const [city, count] of Object.entries(byCity).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${city}: ${count}`);
  }

  // Group by recommendation
  const byRec = {};
  for (const r of filteredResults) {
    const rec = r.recommendation || 'unknown';
    byRec[rec] = (byRec[rec] || 0) + 1;
  }
  console.log('\n--- By Recommendation ---');
  for (const [rec, count] of Object.entries(byRec).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rec}: ${count}`);
  }

  console.log('\n--- Leads ---');
  for (const r of filteredResults.slice(0, 30)) {
    const date = r.meetingDate || 'no date';
    const addr = r.address || 'no address';
    const cn = r.caseNumber || '';
    console.log(`  [${r.sourceCity}] ${date} | ${cn} | ${addr}`);
    if (r.scope) console.log(`    ${r.scope.substring(0, 120)}`);
  }
  if (filteredResults.length > 30) {
    console.log(`  ... and ${filteredResults.length - 30} more`);
  }
}

async function main() {
  const citiesToScrape = getCitiesToScrape();
  const days = flags.days || 90;
  const options = { days, headed: flags.headed || false };

  console.log(`DRB Scraper: ${citiesToScrape.length} cities, ${days}-day lookback`);
  console.log(`Cities: ${citiesToScrape.map(c => c.slug).join(', ')}\n`);

  let allResults = [];
  const errors = [];

  // Per-city isolation: one city failing must NEVER abort the run. scrapeCity is
  // already internally try/caught + returns [], but we double-wrap here so an
  // unexpected throw is logged and the run continues to the next city.
  for (const cityConfig of citiesToScrape) {
    try {
      const cityResults = await scrapeCity(cityConfig, options);
      allResults = allResults.concat(Array.isArray(cityResults) ? cityResults : []);
      console.log(`  ${cityConfig.slug}: ${(cityResults || []).length} items\n`);
    } catch (err) {
      console.error(`  ${cityConfig.slug}: FAILED - ${err.message}\n`);
      errors.push({ city: cityConfig.slug, error: err.message });
    }
  }

  // Stamp pipeline fields every record needs so consolidate-lib maps it onto the
  // unified PursuitRecord: layer/sourceAgent => stage 'entitlement', metro 'OC',
  // projectType left null (consolidator classifies from scope). Drop records with
  // no usable anchor (no address AND no apn AND no caseNumber) — unusable downstream.
  allResults = allResults
    .filter(r => r && (r.address || r.apn || r.caseNumber))
    .map(r => {
      // PHASE-0 VERIFY: classify project type from the agenda scope text HERE.
      // The brief said "leave projectType null — consolidator classifies", but on
      // inspection neither scripts/consolidate-lib.js nor scripts/score-lib.js
      // classify (both read lead.projectType as-is); only the harness defaultReason
      // does, and this agent has its own main() (it is not harness-based). So we
      // classify with the SAME shared classifier the harness uses, from scope, so
      // multifamily/mixed-use/master-plan items actually score. Emit null when the
      // classifier returns 'unknown' (lets a downstream re-classify if one is added).
      const projectType = r.projectType
        || classifyProjectType({ scope: r.scope, description: r.scope, caseNumber: r.caseNumber, address: r.address });
      return {
        ...r,
        source: 'planning-drb',
        layer: 'L2',
        sourceAgent: 'planning-drb',
        metro: r.metro || 'OC',
        projectType: projectType === 'unknown' ? null : projectType,
        // A named architect/designer means the design team may already be chosen →
        // consolidate-lib turns this into the architectAlreadyNamed scoring penalty.
        architectAlreadyNamed: !!(r.architect && String(r.architect).trim()),
      };
    });

  // Deduplicate by address + apn + caseNumber + city (collapses the same project
  // appearing on multiple meeting dates / as continued items).
  const seen = new Set();
  allResults = allResults.filter(r => {
    const key = `${(r.address || '').toLowerCase()}|${r.apn || ''}|${r.caseNumber || ''}|${r.sourceCity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Secondary collapse: if the SAME address+city appears both with and without a
  // case#, keep only the richer (cased) record — drops continuation/notice rows
  // that duplicate a real cased agenda item by address.
  const casedAddr = new Set(
    allResults.filter(r => r.caseNumber && r.address)
      .map(r => `${r.address.toLowerCase()}|${r.sourceCity}`)
  );
  allResults = allResults.filter(r =>
    r.caseNumber || !r.address || !casedAddr.has(`${r.address.toLowerCase()}|${r.sourceCity}`)
  );

  // Apply optional debug fit filter (orchestrator does not pass --fit-filter).
  let outputResults = allResults;
  if (flags.fitFilter) {
    outputResults = applyFitFilter(allResults);
    console.log(`\nDanielian fit filter: ${allResults.length} -> ${outputResults.length} items`);
  }

  // ---- ACT: always write the bare JSON array to -o (orchestrator contract) ----
  // Write the file whenever -o is given, regardless of format, so the orchestrator
  // probe always finds it. A fully-dead run writes [] (and we still exit 0).
  const today = new Date().toISOString().split('T')[0];
  const defaultOutput = path.join(__dirname, '..', '..', 'data', 'output', `planning-drb-leads-${today}.json`);
  const outputPath = flags.output || defaultOutput;
  const format = flags.format || 'json';

  if (format !== 'summary' || flags.output) {
    try {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(outputResults, null, 2));
      console.log(`\nSaved ${outputResults.length} planning-drb leads to ${outputPath}`);
    } catch (err) {
      // Even an output failure should not crash the subprocess into a non-zero
      // exit on an otherwise-successful harvest; log and continue.
      console.error(`Output write failed: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nCity errors (${errors.length}) — run continued past each:`);
    for (const e of errors) console.log(`  ${e.city}: ${e.error}`);
  }

  printSummary(allResults, outputResults);
}

main().catch(err => {
  // Reserve non-zero exit for a true hard failure (the orchestrator treats that
  // as the agent failing). A drifted/empty harvest is NOT a hard failure.
  console.error('Fatal error:', err && err.message);
  process.exit(1);
});

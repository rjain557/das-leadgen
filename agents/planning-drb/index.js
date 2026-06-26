#!/usr/bin/env node

/**
 * DRB / Planning Commission Scraper — Layer 2
 *
 * CLI entry point for scraping Design Review Board and Planning Commission
 * agendas across Orange County cities.
 *
 * Usage:
 *   node agents/drb/ [options]
 *   node agents/drb/ --city laguna-beach --days 90
 *   node agents/drb/ --city all --days 60 --headed
 *   node agents/drb/ --platform granicus
 *   node agents/drb/ --fit-filter
 */

const fs = require('fs');
const path = require('path');
const { PLATFORM, cities, browser: browserConfig } = require('./config');
const { scrapeGranicus } = require('./granicus-scraper');
const { scrapeLegistar } = require('./legistar-scraper');
const { scrapeCityCms } = require('./city-scraper');
const { isDanielianFit: isBurkhartFit } = require('../shared/danielian-fit');

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
DRB / Planning Commission Scraper (Layer 2)
=============================================
Scrapes Design Review Board and Planning Commission agendas
for pre-permit residential leads across Orange County.

Usage:
  node agents/drb/ [options]

Options:
  --help, -h            Show this help message
  --city, -c SLUG       City to scrape (default: all)
                        Slugs: ${Object.keys(cities).join(', ')}
  --days, -d N          Lookback period in days (default: 90)
  --output, -o PATH     Output file path (default: data/output/drb-leads-{date}.json)
  --headed              Run browser in headed mode (visible)
  --platform TYPE       Only scrape cities on this platform: granicus, legistar, city-cms
  --fit-filter          Apply isBurkhartFit() filter to results
  --format, -f FMT      Output format: json (default), summary

Examples:
  node agents/drb/ --city laguna-beach --days 60
  node agents/drb/ --platform granicus --headed
  node agents/drb/ --city all --fit-filter
  node agents/drb/ --city newport-beach --days 30 -o drb-newport.json
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
  return results.filter(item => {
    // Build a record compatible with isBurkhartFit()
    const record = {
      type: 'Design Review',
      description: item.scope || '',
      address: item.address || '',
    };
    return isBurkhartFit(record);
  });
}

function printSummary(allResults, filteredResults) {
  console.log('\n========================================');
  console.log('  DRB / Planning Commission - Lead Report');
  console.log('========================================\n');
  console.log(`Total agenda items scraped: ${allResults.length}`);
  if (filteredResults !== allResults) {
    console.log(`After Burkhart fit filter: ${filteredResults.length}`);
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

  for (const cityConfig of citiesToScrape) {
    try {
      const cityResults = await scrapeCity(cityConfig, options);
      allResults = allResults.concat(cityResults);
      console.log(`  ${cityConfig.slug}: ${cityResults.length} items\n`);
    } catch (err) {
      console.error(`  ${cityConfig.slug}: FAILED - ${err.message}\n`);
      errors.push({ city: cityConfig.slug, error: err.message });
    }
  }

  // Deduplicate by address + meetingDate
  const seen = new Set();
  allResults = allResults.filter(r => {
    const key = `${r.address || ''}|${r.meetingDate || ''}|${r.sourceCity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Apply fit filter if requested
  let outputResults = allResults;
  if (flags.fitFilter) {
    outputResults = applyFitFilter(allResults);
    console.log(`\nBurkhart fit filter: ${allResults.length} -> ${outputResults.length} items`);
  }

  // Output
  const format = flags.format || 'json';

  if (format === 'summary') {
    printSummary(allResults, outputResults);
  } else {
    const today = new Date().toISOString().split('T')[0];
    const defaultOutput = path.join(
      __dirname, '..', '..', 'data', 'output', `drb-leads-${today}.json`
    );
    const outputPath = flags.output || defaultOutput;

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const json = JSON.stringify(outputResults, null, 2);
    fs.writeFileSync(outputPath, json);
    console.log(`\nSaved ${outputResults.length} DRB leads to ${outputPath}`);

    if (errors.length > 0) {
      console.log(`\nErrors (${errors.length}):`);
      for (const e of errors) {
        console.log(`  ${e.city}: ${e.error}`);
      }
    }

    // Also print summary
    printSummary(allResults, outputResults);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

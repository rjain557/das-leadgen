#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { searchPermits, filterPlanCheck, getTypeBreakdown, formatProperty, toCSV } = require('./search');

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  else if (args[i] === '--active-only') flags.activeOnly = true;
  else if (args[i] === '--output' || args[i] === '-o') flags.output = args[++i];
  else if (args[i] === '--format' || args[i] === '-f') flags.format = args[++i];
  else if (args[i] === '--max-pages') flags.maxPages = parseInt(args[++i], 10);
  else if (args[i] === '--headed') flags.headed = true;
  else if (args[i] === '--address') flags.address = args[++i];
  else if (args[i] === '--date-from') flags.dateFrom = args[++i];
}

if (flags.help) {
  console.log(`
Irvine Permit Portal Agent
===========================
Retrieves plan check data from the City of Irvine ASP permit portal.
(No login required - public plan check inquiry)
NOTE: Irvine selected Clariti Enterprise in Nov 2024. This agent targets
the legacy ASP portal at permits.cityofirvine.org until migration completes.

Usage:
  node index.js [options]

Options:
  --help, -h           Show this help message
  --active-only        Only return active plan check permits
  --output, -o PATH    Output file path (default: stdout as JSON)
  --format, -f FMT     Output format: json (default), csv, summary
  --max-pages N        Max pages to fetch (default: ${config.search.maxPages})
  --headed             Run browser in headed mode (visible)
  --address ADDR       Filter by street address
  --date-from DATE     Applications from date (QBE format, default: >01/01/2022)

Examples:
  node index.js --active-only --format summary
  node index.js --active-only -f csv -o plan-check-active.csv
  node index.js --address "Shady Canyon" --format summary
  node index.js --date-from ">01/01/2023" -f csv
`);
  process.exit(0);
}

async function main() {
  const browser = await chromium.launch({ headless: !flags.headed });
  const context = await browser.newContext({
    viewport: config.browser.viewport,
    userAgent: config.browser.userAgent,
  });
  const page = await context.newPage();

  try {
    const rawResults = await searchPermits(page, {
      address: flags.address || '',
      // Pass through only if user supplied --date-from; otherwise let
      // search.js compute a rolling 90-day default. The previous hardcoded
      // ">01/01/2026" floor blew past the portal's "too many records" cap
      // for rra/rbpr by April 2026 — even per-status retries hit the cap.
      ...(flags.dateFrom ? { dateFrom: flags.dateFrom } : {}),
      maxPages: flags.maxPages || config.search.maxPages,
    });

    let results = rawResults;
    if (flags.activeOnly) {
      results = filterPlanCheck(results);
      console.log(`Filtered to ${results.length} active plan check permits (from ${rawResults.length} total)`);
    }

    const properties = results.map(formatProperty);
    const format = flags.format || 'json';

    if (format === 'summary') {
      printSummary(rawResults, results, properties);
    } else if (format === 'csv') {
      const csv = toCSV(properties);
      if (flags.output) {
        fs.writeFileSync(flags.output, csv);
        console.log(`Saved ${properties.length} permits to ${flags.output}`);
      } else {
        console.log(csv);
      }
    } else {
      const json = JSON.stringify(properties, null, 2);
      if (flags.output) {
        fs.writeFileSync(flags.output, json);
        console.log(`Saved ${properties.length} permits to ${flags.output}`);
      } else {
        console.log(json);
      }
    }
  } catch (error) {
    console.error('Agent error:', error.message);
    await page.screenshot({ path: path.join(__dirname, 'error-screenshot.png'), fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

function printSummary(allResults, filteredResults, properties) {
  const allTypeBreakdown = getTypeBreakdown(allResults);

  console.log('\n========================================');
  console.log(`  ${config.portal.name} - Plan Check Report`);
  console.log('========================================\n');
  console.log(`Total permits scraped: ${allResults.length}`);
  console.log(`Active plan checks:    ${filteredResults.length}`);

  console.log('\n--- Permit Types ---');
  for (const [type, count] of Object.entries(allTypeBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\n--- Permits ---');
  for (const p of properties.slice(0, 25)) {
    console.log(`  ${p.permitNumber} | ${p.type} | ${p.address}`);
    if (p.description) console.log(`    ${p.description.substring(0, 100)}`);
  }
  if (properties.length > 25) {
    console.log(`  ... and ${properties.length - 25} more`);
  }
}

main();

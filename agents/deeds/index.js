#!/usr/bin/env node

const { launchBrowser } = require('../shared/browser');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
  searchAllDocumentTypes,
  applyFilters,
  cleanForOutput,
  debugScreenshot,
} = require('./scraper');

// CLI argument parsing
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  else if (args[i] === '--days') flags.days = parseInt(args[++i], 10);
  else if (args[i] === '--output' || args[i] === '-o') flags.output = args[++i];
  else if (args[i] === '--format' || args[i] === '-f') flags.format = args[++i];
  else if (args[i] === '--headed') flags.headed = true;
  else if (args[i] === '--no-filter') flags.noFilter = true;
  else if (args[i] === '--type' || args[i] === '-t') flags.types = (flags.types || []).concat(args[++i]);
}

if (flags.help) {
  const typeList = Object.entries(config.documentTypes)
    .map(([key, cfg]) => `  ${key.padEnd(22)} ${cfg.label} (${cfg.leadQuality} quality)`)
    .join('\n');
  console.log(`
OC Clerk-Recorder Scraper — Financial Signal Detection
========================================================
Scrapes the OC Clerk-Recorder (RecorderWorks) for construction-related
financial recordings that indicate upcoming or active construction projects.

Usage:
  node agents/clerk-recorder/ [options]

Options:
  --help, -h          Show this help message
  --days N            Lookback period in days (default: ${config.search.defaultDaysBack})
  --output, -o PATH   Output file path (default: data/output/recorder-leads-{date}.json)
  --format, -f FMT    Output format: json (default), csv, summary
  --headed            Run browser in headed mode (visible)
  --no-filter         Skip construction/trust filtering (return all results)
  --type, -t KEY      Search specific document type only (can repeat)

Document Types:
${typeList}

Examples:
  node agents/clerk-recorder/
  node agents/clerk-recorder/ --days 60 --format summary
  node agents/clerk-recorder/ --type construction-dot -o construction-loans.json
  node agents/clerk-recorder/ --type notice-completion --no-filter
`);
  process.exit(0);
}

function getDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function toCSV(results) {
  const header = 'Document Type,Recording Date,Document Number,Grantor,Grantee,APN,Amount,Lead Quality,URL\n';
  const rows = results.map(r => [
    `"${r.documentType}"`,
    r.recordingDate || '',
    `"${r.documentNumber}"`,
    `"${(r.grantor || '').replace(/"/g, '""')}"`,
    `"${(r.grantee || '').replace(/"/g, '""')}"`,
    `"${r.apn || ''}"`,
    r.amount || '',
    `"${r.leadQuality || ''}"`,
    `"${r.url || ''}"`,
  ].join(','));
  return header + rows.join('\n');
}

function printSummary(results) {
  console.log('\n========================================');
  console.log('  OC Clerk-Recorder — Financial Signals');
  console.log('========================================\n');
  console.log(`Total records: ${results.length}`);

  // By document type
  const byType = {};
  for (const r of results) {
    byType[r.documentType] = (byType[r.documentType] || 0) + 1;
  }
  console.log('\n--- By Document Type ---');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // By lead quality
  const byQuality = {};
  for (const r of results) {
    const q = r.leadQuality || 'unknown';
    byQuality[q] = (byQuality[q] || 0) + 1;
  }
  console.log('\n--- By Lead Quality ---');
  for (const [quality, count] of Object.entries(byQuality).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${quality}: ${count}`);
  }

  // High-value leads
  const highValue = results.filter(r => r.leadQuality === 'high' || (r.amount && r.amount >= 1000000));
  if (highValue.length > 0) {
    console.log(`\n--- High-Value Records (${highValue.length}) ---`);
    for (const r of highValue.slice(0, 20)) {
      const amountStr = r.amount ? `$${r.amount.toLocaleString()}` : 'N/A';
      console.log(`  ${r.documentNumber} | ${r.documentType} | ${amountStr}`);
      if (r.grantor) console.log(`    Grantor: ${r.grantor}`);
      if (r.grantee) console.log(`    Grantee: ${r.grantee}`);
      if (r.apn) console.log(`    APN: ${r.apn}`);
    }
  }

  // All records list
  console.log('\n--- All Records ---');
  for (const r of results.slice(0, 30)) {
    const amountStr = r.amount ? `$${r.amount.toLocaleString()}` : '';
    console.log(`  ${r.documentNumber || 'N/A'} | ${r.documentType} | ${r.recordingDate || 'N/A'} | ${amountStr}`);
    if (r.grantor || r.grantee) {
      console.log(`    ${r.grantor} -> ${r.grantee}`);
    }
  }
  if (results.length > 30) {
    console.log(`  ... and ${results.length - 30} more`);
  }
}

async function main() {
  const { browser } = await launchBrowser({ headed: flags.headed });
  const context = await browser.newContext({
    viewport: config.browser.viewport,
    userAgent: config.browser.userAgent,
    ignoreHTTPSErrors: true,  // cr.ocgov.com has expired SSL cert
  });
  const page = await context.newPage();

  try {
    const daysBack = flags.days || config.search.defaultDaysBack;

    console.log('OC Clerk-Recorder Scraper starting...');
    console.log(`  Portal: ${config.portal.name}`);
    console.log(`  Lookback: ${daysBack} days`);
    if (flags.types) console.log(`  Types: ${flags.types.join(', ')}`);
    console.log('');

    // Step 1: Search all document types
    let results = await searchAllDocumentTypes(page, {
      daysBack,
      types: flags.types || null,
    });

    console.log(`\nTotal raw records: ${results.length}`);

    // Step 2: Apply filters
    if (!flags.noFilter) {
      results = applyFilters(results);
      console.log(`After filtering: ${results.length} records`);
    }

    // Step 3: Clean for output
    results = cleanForOutput(results);

    // Step 4: Output
    const format = flags.format || 'json';
    const defaultOutput = path.resolve(__dirname, `../../data/output/recorder-leads-${getDateStamp()}.json`);
    const outputPath = flags.output
      ? path.resolve(flags.output)
      : defaultOutput;

    if (format === 'summary') {
      printSummary(results);
    } else if (format === 'csv') {
      const csv = toCSV(results);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const csvPath = outputPath.replace(/\.json$/, '.csv');
      fs.writeFileSync(csvPath, csv);
      console.log(`\nSaved ${results.length} recorder leads to ${csvPath}`);
    } else {
      // JSON
      const json = JSON.stringify(results, null, 2);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json);
      console.log(`\nSaved ${results.length} recorder leads to ${outputPath}`);
    }
  } catch (error) {
    console.error('Clerk-Recorder scraper error:', error.message);
    await debugScreenshot(page, 'fatal-error');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();

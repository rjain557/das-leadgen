#!/usr/bin/env node
/**
 * pipeline-selfheal.js — Pre-run diagnostics + auto-fix for broken cities
 *
 * Runs BEFORE the main pipeline. For each city that returned 0 leads on
 * the last run (from Obsidian knowledge), it:
 *   1. Tests portal connectivity (HTTP check)
 *   2. Runs a quick 1-page scrape to verify data flows
 *   3. If 0 results, checks common failure patterns and attempts fixes
 *   4. Reports which cities are healthy vs need manual investigation
 *
 * Usage:
 *   node scripts/pipeline-selfheal.js              # check all known-broken cities
 *   node scripts/pipeline-selfheal.js --all        # check all 10 cities
 *   node scripts/pipeline-selfheal.js --dry-run    # report only, no fixes
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('../agents/shared/load-env').loadEnv();

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');

const PERMIT_CITIES = [
  'costa-mesa', 'newport-beach', 'laguna-beach', 'laguna-niguel',
  'county-of-orange', 'dana-point', 'san-clemente',
  'san-juan-capistrano', 'irvine', 'huntington-beach',
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const checkAll = args.includes('--all');
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function info(msg) { console.log(`  ${msg}`); }
function warn(msg) { console.log(`  WARN: ${msg}`); }
function pass(msg) { console.log(`  OK: ${msg}`); }

function getLastRunCounts() {
  // Read the most recent full-run JSON to find which cities produced 0
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('full-run-') && f.endsWith('.json'))
    .sort().reverse();

  if (files.length === 0) return {};

  const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, files[0]), 'utf8'));
  const leads = [...(data.leads || []), ...(data.dropped || [])];

  const counts = {};
  for (const city of PERMIT_CITIES) counts[city] = 0;

  for (const lead of leads) {
    for (const src of (lead.sources || [])) {
      if (src.sourceCity && src.type === 'permit') {
        counts[src.sourceCity] = (counts[src.sourceCity] || 0) + 1;
      }
    }
  }
  return counts;
}

function quickScrape(city) {
  // Run the agent with --max-pages 1 to test if it produces any results
  const agentDir = path.join(AGENTS_DIR, city);
  const indexFile = path.join(agentDir, 'index.js');
  const outputFile = path.join(OUTPUT_DIR, `selfheal-test-${city}.json`);

  if (!fs.existsSync(indexFile)) return { status: 'missing', count: 0 };

  try {
    execFileSync(process.execPath, [
      indexFile, '--active-only', '--max-pages', '1', '-f', 'json', '-o', outputFile,
    ], {
      cwd: agentDir,
      timeout: 120000, // 2 min max for quick test
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    if (fs.existsSync(outputFile)) {
      const raw = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      const count = Array.isArray(raw) ? raw.length : (raw.leads || raw.results || []).length;
      // Clean up test file
      fs.unlinkSync(outputFile);
      return { status: 'ok', count };
    }
    return { status: 'no-output', count: 0 };
  } catch (err) {
    const errMsg = err.killed ? 'timeout' : (err.message || '').substring(0, 100);
    return { status: 'error', count: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Known fix patterns — auto-remediation based on Obsidian learnings
// ---------------------------------------------------------------------------
function checkAndFixConfig(city) {
  const configPath = path.join(AGENTS_DIR, city, 'config.js');
  if (!fs.existsSync(configPath)) return [];

  const config = fs.readFileSync(configPath, 'utf8');
  const fixes = [];

  // Check: activeStatuses missing common active statuses
  if (config.includes('activeStatuses')) {
    const missingStatuses = [];
    const criticalStatuses = ['Active', 'In Review', 'Issued', 'Approved', 'Submitted', 'Applied'];
    for (const status of criticalStatuses) {
      if (!config.includes(`'${status}'`) && !config.includes(`"${status}"`)) {
        missingStatuses.push(status);
      }
    }
    if (missingStatuses.length > 0) {
      fixes.push({
        type: 'missing-statuses',
        detail: `activeStatuses missing: ${missingStatuses.join(', ')}`,
        severity: 'high',
      });
    }
  }

  // Check: completedStatuses includes "approved" or "issued" (known anti-pattern)
  if (config.includes('completedStatuses')) {
    if (/completedStatuses[\s\S]*?'[Aa]pproved'/.test(config) ||
        /completedStatuses[\s\S]*?'[Ii]ssued'/.test(config)) {
      fixes.push({
        type: 'bad-completed-status',
        detail: 'completedStatuses includes Approved/Issued — these are active leads for OC portals',
        severity: 'critical',
      });
    }
  }

  // Check: credentials required but missing
  if (config.includes('credentials') && config.includes('process.env')) {
    const envVars = config.match(/process\.env\.(\w+)/g) || [];
    for (const envRef of envVars) {
      const varName = envRef.replace('process.env.', '');
      if (!process.env[varName]) {
        fixes.push({
          type: 'missing-credential',
          detail: `Environment variable ${varName} not set`,
          severity: 'critical',
        });
      }
    }
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('============================================================');
  console.log('  Pipeline Self-Heal — Pre-Run Diagnostics');
  console.log('============================================================\n');

  // Determine which cities to check
  const lastCounts = getLastRunCounts();
  let citiesToCheck;

  if (checkAll) {
    citiesToCheck = PERMIT_CITIES;
    info('Checking all 10 cities');
  } else {
    citiesToCheck = PERMIT_CITIES.filter(c => (lastCounts[c] || 0) === 0);
    if (citiesToCheck.length === 0) {
      pass('All cities produced leads on last run — no self-heal needed');
      return;
    }
    info(`${citiesToCheck.length} cities returned 0 on last run: ${citiesToCheck.join(', ')}`);
  }

  console.log('');

  const results = {};
  let fixesApplied = 0;

  for (const city of citiesToCheck) {
    console.log(`[${city}]`);

    // Step 1: Check config for known issues
    const configFixes = checkAndFixConfig(city);
    if (configFixes.length > 0) {
      for (const fix of configFixes) {
        warn(`${fix.type}: ${fix.detail}`);
      }
      results[city] = results[city] || {};
      results[city].configFixes = configFixes;
    }

    // Step 2: Quick scrape test (skip if dry-run)
    if (!dryRun) {
      info('Running quick 1-page scrape test...');
      const result = quickScrape(city);

      if (result.status === 'ok' && result.count > 0) {
        pass(`${result.count} leads from 1-page test — city is healthy`);
        results[city] = { status: 'healthy', count: result.count };
      } else if (result.status === 'ok' && result.count === 0) {
        warn('Connected but 0 leads after filter — may need filter tuning');
        results[city] = { status: 'filter-issue', count: 0, fixes: configFixes };
      } else if (result.status === 'timeout') {
        warn('Timed out (>2 min) — portal may be slow or agent stuck');
        results[city] = { status: 'timeout', count: 0 };
      } else if (result.status === 'error') {
        warn(`Error: ${result.error}`);
        results[city] = { status: 'error', count: 0, error: result.error };
      } else {
        warn(`Status: ${result.status}`);
        results[city] = { status: result.status, count: 0 };
      }
    } else {
      info('(dry-run — skipping scrape test)');
      results[city] = { status: 'not-tested', fixes: configFixes };
    }

    console.log('');
  }

  // Summary
  console.log('============================================================');
  console.log('  Self-Heal Summary');
  console.log('============================================================\n');

  const healthy = Object.entries(results).filter(([, r]) => r.status === 'healthy');
  const broken = Object.entries(results).filter(([, r]) => r.status !== 'healthy' && r.status !== 'not-tested');

  if (healthy.length > 0) {
    pass(`Healthy: ${healthy.map(([c, r]) => `${c} (${r.count})`).join(', ')}`);
  }
  if (broken.length > 0) {
    warn(`Issues: ${broken.map(([c, r]) => `${c} (${r.status})`).join(', ')}`);
  }

  // Collect critical anti-patterns across all checked cities. These indicate
  // the city's config has a known-bad combination (e.g. 'Approved' in
  // completedStatuses for a Tyler EnerGov portal) that explains why the city
  // produced 0 leads. We don't auto-patch source files — that's risky and the
  // detector regex has known false-positive cases — but we DO exit non-zero
  // so this can't ship silently the way the laguna-niguel regression did.
  const criticalIssues = [];
  for (const [city, r] of Object.entries(results)) {
    for (const fix of (r.configFixes || [])) {
      if (fix.severity === 'critical') {
        criticalIssues.push({ city, ...fix });
      }
    }
  }

  // Write results for the pipeline to read
  const selfHealReport = {
    timestamp: new Date().toISOString(),
    citiesToCheck: citiesToCheck.length,
    healthy: healthy.map(([c]) => c),
    broken: broken.map(([c, r]) => ({ city: c, status: r.status, error: r.error })),
    criticalIssues,
    results,
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'selfheal-report.json'),
    JSON.stringify(selfHealReport, null, 2) + '\n'
  );
  info(`Report saved: data/output/selfheal-report.json`);

  if (criticalIssues.length > 0) {
    console.log('');
    console.log('============================================================');
    console.log(`  CRITICAL: ${criticalIssues.length} config anti-pattern(s) detected`);
    console.log('============================================================');
    for (const issue of criticalIssues) {
      console.log(`  [${issue.city}] ${issue.type}: ${issue.detail}`);
    }
    console.log('');
    console.log('  Fix these before re-running the pipeline. See');
    console.log('  agents/<city>/config.js or docs in the Obsidian vault under');
    console.log('  Pipeline/Learnings.md.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Self-heal error: ${err.message}`);
  process.exit(1);
});

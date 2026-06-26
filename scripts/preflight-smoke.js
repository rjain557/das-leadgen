#!/usr/bin/env node
/**
 * preflight-smoke.js — multi-agent parallel smoke test
 *
 * Runs every per-city scraper in parallel against its live portal with
 * `--active-only --max-pages 1 --format summary --no-contacts` (where
 * `--no-contacts` is supported). Captures per-city pass/fail, lead count,
 * and a log file each. Writes a structured report to
 * data/output/smoke-report.json and exits non-zero if ANY city totally
 * failed (timeout, crash, login error).
 *
 * Why this exists:
 *   The full pipeline (npm run pipeline) takes ~75 min and runs the
 *   cities serially. A portal change in one city used to surface only
 *   AFTER 30+ min of retries. This gate finishes in ~3-5 min (parallel)
 *   and surfaces broken cities up front so the operator can fix them
 *   before paying the full pipeline cost.
 *
 * Usage:
 *   node scripts/preflight-smoke.js              # all 10 cities
 *   node scripts/preflight-smoke.js irvine       # just one
 *   node scripts/preflight-smoke.js --json       # machine-readable summary only
 *
 * Exit codes:
 *   0 — every checked city completed and returned a non-error exit
 *   1 — at least one city timed out, crashed, or failed login
 *   2 — invocation error (bad city name, missing dependency, etc.)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const RUNS_DIR = path.join(ROOT, 'runs');

const PERMIT_CITIES = [
  'costa-mesa', 'newport-beach', 'laguna-beach', 'laguna-niguel',
  'county-of-orange', 'dana-point', 'san-clemente',
  'san-juan-capistrano', 'irvine', 'huntington-beach',
];

// Cities that hydrate contacts at all (Tyler EnerGov + eTRAKiT). The smoke
// gate exercises hydration end-to-end with --contacts-limit 5 so a stalled
// detail-page navigation surfaces here instead of inside the full pipeline.
const HYDRATES_CONTACTS = new Set([
  'costa-mesa', 'newport-beach', 'laguna-beach', 'laguna-niguel',
  'dana-point', 'san-clemente', 'san-juan-capistrano',
]);

const PER_CITY_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min hard cap

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { citiesArg: [], json: false };
  for (const arg of args) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (!arg.startsWith('-')) flags.citiesArg.push(arg);
  }
  return flags;
}

function help() {
  console.log(`Usage: node scripts/preflight-smoke.js [city ...] [--json]

Runs every per-city scraper in parallel with --max-pages 1 --no-contacts and
reports which cities are healthy, broken, or producing zero leads. Writes
data/output/smoke-report.json and exits non-zero if any city failed.

Cities: ${PERMIT_CITIES.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Per-city runner
// ---------------------------------------------------------------------------
function runOne(city) {
  return new Promise((resolve) => {
    const agentDir = path.join(AGENTS_DIR, city);
    const indexPath = path.join(agentDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      resolve({ city, status: 'no-agent', errored: true });
      return;
    }
    if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
    const logPath = path.join(RUNS_DIR, `smoke-${city}.log`);
    const log = fs.openSync(logPath, 'w');

    const args = [indexPath, '--active-only', '--max-pages', '1', '--format', 'summary'];
    // Exercise the hydration code path on contact-hydrating cities, but cap
    // it at 5 cases so the smoke gate stays under its 5-min budget. A
    // hydration timeout for ANY case fails the city — exactly what we want
    // to surface before the full pipeline runs.
    if (HYDRATES_CONTACTS.has(city)) {
      args.push('--contacts-limit', '5');
    }

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', log, log],
      env: process.env,
    });

    const start = Date.now();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, PER_CITY_TIMEOUT_MS);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try { fs.closeSync(log); } catch { /* already closed */ }
      const duration = Date.now() - start;
      let logText = '';
      try { logText = fs.readFileSync(logPath, 'utf8'); } catch { /* empty log */ }

      // Extract lead counts. Each city's summary uses slightly different
      // wording; cover the patterns that exist today and fall through to
      // null when none match.
      const totalMatch =
        logText.match(/Total permits scraped:\s*(\d+)/) ||
        logText.match(/Total projects fetched:\s*(\d+)/) ||
        logText.match(/Total permits fetched:\s*(\d+)/) ||
        logText.match(/Total fetched:\s*(\d+)/);
      const filterMatch =
        logText.match(/Active plan checks?:\s*(\d+)/) ||
        logText.match(/Plan check permits?:\s*(\d+)/) ||
        logText.match(/Filtered to\s+(\d+)/);

      const total = totalMatch ? parseInt(totalMatch[1], 10) : null;
      const filtered = filterMatch ? parseInt(filterMatch[1], 10) : null;
      const timedOut = signal === 'SIGKILL';
      const crashed = !timedOut && code !== 0;
      const loginFailed = /login\s+failed/i.test(logText);

      let status;
      if (timedOut) status = 'timeout';
      else if (loginFailed) status = 'login-failed';
      else if (crashed) status = 'crashed';
      else if (total === null) status = 'no-output';
      else if (total === 0) status = 'zero-raw';
      else if (filtered === 0) status = 'zero-filtered';
      else status = 'healthy';

      const errored = ['timeout', 'login-failed', 'crashed', 'no-output'].includes(status);
      resolve({ city, status, code, signal, duration, total, filtered, errored, logPath });
    });
  });
}

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------
const STATUS_GLYPH = {
  healthy: '✓',
  'zero-filtered': '⚠',
  'zero-raw': '⚠',
  'no-output': '✗',
  'login-failed': '✗',
  crashed: '✗',
  timeout: '✗',
  'no-agent': '·',
};

function printRow(r) {
  const glyph = STATUS_GLYPH[r.status] || '?';
  const timeStr = r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '-';
  const counts = r.total === null ? '-' : `total=${r.total} filtered=${r.filtered ?? '-'}`;
  console.log(`  ${glyph} ${r.city.padEnd(22)} ${r.status.padEnd(15)} ${timeStr.padStart(7)}  ${counts}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const flags = parseArgs();
  if (flags.help) { help(); process.exit(0); }

  const cities = flags.citiesArg.length > 0 ? flags.citiesArg : PERMIT_CITIES;
  const unknown = cities.filter(c => !PERMIT_CITIES.includes(c));
  if (unknown.length > 0) {
    console.error(`Unknown city/cities: ${unknown.join(', ')}`);
    console.error(`Known: ${PERMIT_CITIES.join(', ')}`);
    process.exit(2);
  }

  if (!flags.json) {
    console.log('============================================================');
    console.log(`  Multi-agent smoke test — ${cities.length} cities in parallel`);
    console.log('============================================================');
    console.log(`  Per-city timeout: ${PER_CITY_TIMEOUT_MS / 60000} min`);
    console.log(`  Logs: runs/smoke-<city>.log`);
    console.log('');
  }

  const start = Date.now();
  const results = await Promise.all(cities.map(runOne));
  const elapsed = Date.now() - start;

  if (!flags.json) {
    console.log('  status                glyph  time     counts');
    console.log('  ----------------------------------------------');
    for (const r of results) printRow(r);
    console.log('');
    console.log(`  Total elapsed: ${(elapsed / 1000).toFixed(1)}s`);
  }

  const errored = results.filter(r => r.errored);
  const zeroFiltered = results.filter(r => r.status === 'zero-filtered');
  const healthy = results.filter(r => r.status === 'healthy');

  const report = {
    timestamp: new Date().toISOString(),
    elapsedMs: elapsed,
    citiesChecked: cities.length,
    counts: {
      healthy: healthy.length,
      zeroFiltered: zeroFiltered.length,
      errored: errored.length,
    },
    results,
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'smoke-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    if (errored.length > 0) {
      console.log(`  ✗ FAIL — ${errored.length} city/cities errored: ${errored.map(r => r.city).join(', ')}`);
      console.log(`           Inspect runs/smoke-<city>.log for each failure.`);
    } else if (zeroFiltered.length > 0) {
      console.log(`  ⚠ ${zeroFiltered.length} city/cities returned 0 leads after filter (sampling artefact on a 1-page run, or genuinely no recent activity): ${zeroFiltered.map(r => r.city).join(', ')}`);
      console.log(`  ✓ PASS — all cities completed without error.`);
    } else {
      console.log(`  ✓ PASS — all ${healthy.length} cities healthy.`);
    }
  }

  process.exit(errored.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`smoke-test error: ${err.message}`);
  process.exit(2);
});

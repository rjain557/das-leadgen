/**
 * Run Tracker — tracks each scrape/enrich/lookup/instagram/outreach run
 *
 * Usage:
 *   const { startRun, log, endRun, getLastRun } = require('./run-tracker');
 *   const run = await startRun('scrape', 'newport.beach', { source: 'plancheck' });
 *   await log(run, 'Found 42 permits in plan check phase');
 *   await endRun(run, { found: 42, qualified: 18, errors: 0 });
 */

const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(__dirname, '..', 'runs');
const INDEX_FILE = path.join(RUNS_DIR, 'run-index.json');

// Run types
const RUN_TYPES = ['scrape', 'enrich', 'lookup', 'instagram', 'outreach'];

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function isoNow() { return new Date().toISOString(); }

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { runs: [], lastUpdated: null };
  }
}

function writeIndex(index) {
  index.lastUpdated = isoNow();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n');
}

/**
 * Start a new run
 * @param {string} type - One of: scrape, enrich, lookup, instagram, outreach
 * @param {string} city - City name (e.g. 'newport.beach') or 'all'
 * @param {object} params - Run parameters (source, filters, etc.)
 * @returns {object} Run context object
 */
async function startRun(type, city, params = {}) {
  if (!RUN_TYPES.includes(type)) {
    throw new Error(`Invalid run type: ${type}. Must be one of: ${RUN_TYPES.join(', ')}`);
  }

  const ts = timestamp();
  const id = `${ts}_${type}_${city}`;
  const runDir = path.join(RUNS_DIR, id);

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });

  const run = {
    id,
    type,
    city,
    startedAt: isoNow(),
    endedAt: null,
    params,
    counts: { found: 0, qualified: 0, errors: 0 },
    status: 'running',
    dir: runDir
  };

  // Write initial run.json
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(run, null, 2) + '\n'
  );

  // Initialize log
  fs.writeFileSync(
    path.join(runDir, 'log.md'),
    `# Run Log: ${type} — ${city}\n` +
    `**Started:** ${run.startedAt}\n\n` +
    `---\n\n`
  );

  return run;
}

/**
 * Append a log entry
 * @param {object} run - Run context from startRun
 * @param {string} message - Log message
 */
async function log(run, message) {
  const entry = `- \`${isoNow().slice(11, 19)}\` ${message}\n`;
  fs.appendFileSync(path.join(run.dir, 'log.md'), entry);
}

/**
 * End a run with results
 * @param {object} run - Run context from startRun
 * @param {object} counts - { found, qualified, errors }
 * @param {object} [results] - Optional results data to save
 * @param {string[]} [observations] - Observations for memory system
 */
async function endRun(run, counts = {}, results = null, observations = []) {
  run.endedAt = isoNow();
  run.counts = { ...run.counts, ...counts };
  run.status = counts.errors > 0 ? 'completed_with_errors' : 'completed';

  // Update run.json
  const runData = { ...run };
  delete runData.dir; // Don't persist dir path
  fs.writeFileSync(
    path.join(run.dir, 'run.json'),
    JSON.stringify(runData, null, 2) + '\n'
  );

  // Write results if provided
  if (results) {
    fs.writeFileSync(
      path.join(run.dir, 'results.json'),
      JSON.stringify(results, null, 2) + '\n'
    );
  }

  // Append summary to log
  const duration = Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000);
  fs.appendFileSync(
    path.join(run.dir, 'log.md'),
    `\n---\n\n` +
    `**Completed:** ${run.endedAt} (${duration}s)\n` +
    `**Counts:** Found ${run.counts.found} | Qualified ${run.counts.qualified} | Errors ${run.counts.errors}\n` +
    `**Status:** ${run.status}\n`
  );

  // Update index
  const index = readIndex();
  index.runs.push({
    id: run.id,
    type: run.type,
    city: run.city,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    counts: run.counts,
    status: run.status
  });
  writeIndex(index);

  // Feed observations to memory system
  if (observations.length > 0) {
    try {
      const memory = require('./memory-manager');
      for (const obs of observations) {
        await memory.recordObservation(run.id, obs.text, obs.category);
      }
    } catch { /* memory system not critical */ }
  }

  return run;
}

/**
 * Get the last run of a given type/city
 * @param {string} type - Run type
 * @param {string} [city] - City filter (optional)
 * @returns {object|null} Last matching run entry
 */
function getLastRun(type, city) {
  const index = readIndex();
  const matches = index.runs.filter(r =>
    r.type === type && (!city || r.city === city)
  );
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Get run history
 * @param {string} [type] - Filter by type
 * @param {string} [city] - Filter by city
 * @param {number} [limit=10] - Max results
 * @returns {object[]} Run entries
 */
function getRunHistory(type, city, limit = 10) {
  const index = readIndex();
  let runs = index.runs;
  if (type) runs = runs.filter(r => r.type === type);
  if (city) runs = runs.filter(r => r.city === city);
  return runs.slice(-limit);
}

/**
 * Load full run data from a run ID
 * @param {string} runId - The run ID
 * @returns {object|null} Full run.json contents
 */
function loadRun(runId) {
  const runFile = path.join(RUNS_DIR, runId, 'run.json');
  try {
    return JSON.parse(fs.readFileSync(runFile, 'utf8'));
  } catch {
    return null;
  }
}

// CLI test mode
if (require.main === module) {
  (async () => {
    console.log('=== Run Tracker Test ===');
    const run = await startRun('scrape', 'test.city', { source: 'test' });
    console.log(`Started run: ${run.id}`);
    await log(run, 'Testing log entry');
    await log(run, 'Found 5 permits');
    await endRun(run, { found: 5, qualified: 2, errors: 0 });
    console.log(`Run completed: ${run.status}`);

    const last = getLastRun('scrape', 'test.city');
    console.log(`Last run: ${last.id} (${last.counts.found} found)`);

    // Clean up test
    fs.rmSync(path.join(RUNS_DIR, run.id), { recursive: true });
    const index = readIndex();
    index.runs = index.runs.filter(r => r.id !== run.id);
    writeIndex(index);
    console.log('Test cleanup done');
  })();
}

module.exports = { startRun, log, endRun, getLastRun, getRunHistory, loadRun, RUN_TYPES };

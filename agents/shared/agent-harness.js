// agent-harness.js — the 4-pillar agent backbone for das-leadgen.
//
// Every signal-layer agent (permits, planning-drb, ceqa, deeds, hcd, sb79,
// developer-news) is built on this harness so it is a real AGENT, not just a
// scraper. The harness gives each agent the same loop:
//
//   PERCEIVE → reach out to the real-world source and pull raw observations
//   REASON   → filter to Danielian's ICP, classify project type, normalize
//   ACT      → emit the result (the JSON file the orchestrator reads) + summary
//   LEARN    → record run stats, diff against the last run, leave a note in the
//              Obsidian memory vault, and surface tuning hints from the cortex
//              knowledge vault so the agent improves over time
//
// It also: (a) honors the orchestrator's subprocess CLI contract exactly
// (--active-only / --days / -o / -f / --max-pages / --headed / --help, write a
// bare JSON array to -o, exit 0/non-0); (b) wraps PERCEIVE in a self-healing
// retry loop; (c) standardizes logging. New agents declare a SKILL manifest and
// a perceive() function and get everything else for free.
//
// Usage (in agents/<name>/index.js):
//   const { defineAgent } = require('../../shared/agent-harness'); // depth varies
//   module.exports = defineAgent({
//     name: 'ceqa', layer: 'L3', displayName: 'CEQA / EIR (CEQAnet)',
//     skill: { perceives: '...', sources: ['ceqanet.opr.ca.gov'], leadTime: '12-18mo' },
//     async perceive(ctx) { /* return array of raw records */ },
//   });
//   if (require.main === module) module.exports.run();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv, MEMORY_VAULT_DIR, CORTEX_VAULT_DIR } = require('./load-env');
const fit = require('./danielian-fit');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'output');

// ---------------------------------------------------------------------------
// CLI parsing — the exact flag surface the orchestrator passes to a subprocess.
// ---------------------------------------------------------------------------
function parseCliArgs(argv = process.argv.slice(2)) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--active-only') flags.activeOnly = true;
    else if (a === '--no-filter') flags.noFilter = true;
    else if (a === '--headed') flags.headed = true;
    else if (a === '--days') flags.days = parseInt(argv[++i], 10);
    else if (a === '--max-pages') flags.maxPages = parseInt(argv[++i], 10);
    else if (a === '--output' || a === '-o') flags.output = argv[++i];
    else if (a === '--format' || a === '-f') flags.format = argv[++i];
    else if (a.startsWith('--')) { // generic --key value / --key passthrough
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { flags[key] = next; i++; } else flags[key] = true;
    } else flags._.push(a);
  }
  return flags;
}

function ts() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// LEARN pillar helpers — memory vault (per-run notes) + cortex (tuning hints).
// All best-effort: never let observability break a harvest.
// ---------------------------------------------------------------------------
function appendMemory(name, entry) {
  try {
    const dir = path.join(MEMORY_VAULT_DIR, 'agent-runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.jsonl`), JSON.stringify(entry) + '\n');
  } catch { /* vault offline — fine */ }
}

function lastRunStats(name) {
  try {
    const f = path.join(MEMORY_VAULT_DIR, 'agent-runs', `${name}.jsonl`);
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch { return null; }
}

// Read any cortex-knowledge notes tagged for this agent/source so the harvest
// can adopt newly-learned tuning (e.g. "CEQAnet added a JSON endpoint").
// Looks for files under <cortex>/das-leadgen/<name>.md and returns their text.
function cortexHints(name) {
  try {
    const candidates = [
      path.join(CORTEX_VAULT_DIR, 'das-leadgen', `${name}.md`),
      path.join(CORTEX_VAULT_DIR, 'das-leadgen', `agent-${name}.md`),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------
function defineAgent(spec) {
  const {
    name,                       // dir/layer slug, e.g. 'ceqa'
    layer = '',                 // 'L3'
    displayName = name,
    skill = {},                 // skill manifest (see docs/AGENT-ARCHITECTURE.md)
    perceive,                   // async (ctx) => rawRecords[]   (REQUIRED)
    reason,                     // optional (rawRecords, ctx) => records[]
    retries = 2,                // self-healing retry budget for perceive
    backoffMs = 5000,
    defaultDays = 90,
  } = spec;

  if (typeof perceive !== 'function') {
    throw new Error(`defineAgent(${name}): perceive() is required`);
  }

  const log = (...m) => console.log(`[${name}]`, ...m);
  const warn = (...m) => console.warn(`[${name}]`, ...m);

  // REASON default: ICP filter + project-type classification + light normalize.
  function defaultReason(rawRecords, ctx) {
    const out = [];
    for (const raw of rawRecords || []) {
      const rec = Object.assign({}, raw);
      if (!ctx.noFilter && !fit.isDanielianFit(rec)) continue;
      rec.projectType = rec.projectType || fit.classifyProjectType(rec);
      if (rec.unitCount == null) {
        const u = fit.extractUnitCount([rec.description, rec.scope, rec.scopeText, rec.title].join(' '));
        if (u != null) rec.unitCount = u;
      }
      rec.architectAlreadyNamed = fit.hasNamedArchitectOfRecord(rec);
      rec.layer = layer || rec.layer;
      rec.sourceAgent = name;
      rec.harvestedAt = rec.harvestedAt || today();
      out.push(rec);
    }
    return out;
  }

  // ACT: write the bare JSON array the orchestrator reads + a meta sidecar.
  function act(records, ctx) {
    const stamp = today();
    const outPath = ctx.flags.output
      ? path.resolve(ctx.flags.output)
      : path.join(OUTPUT_DIR, `${name}-leads-${stamp}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(records, null, 2));
    // Stable default path probe target for the orchestrator fallback.
    try {
      const stable = path.join(OUTPUT_DIR, `${name}-leads.json`);
      if (outPath !== stable) fs.writeFileSync(stable, JSON.stringify(records, null, 2));
    } catch { /* ignore */ }
    log(`Saved ${records.length} records → ${outPath}`);
    return outPath;
  }

  function printSummary(records, raw) {
    const byType = {};
    for (const r of records) byType[r.projectType || 'unknown'] = (byType[r.projectType || 'unknown'] || 0) + 1;
    console.log(`Total signals fetched: ${raw}`);
    console.log(`Filtered to ${records.length} Danielian-fit records`);
    console.log(`By project type: ${JSON.stringify(byType)}`);
  }

  // LEARN: stats + diff vs last run + memory note.
  function learn(records, raw, ctx, startedAt) {
    const prev = lastRunStats(name);
    const byType = {};
    for (const r of records) byType[r.projectType || 'unknown'] = (byType[r.projectType || 'unknown'] || 0) + 1;
    const entry = {
      ts: ts(), agent: name, layer, runDate: today(),
      raw, kept: records.length,
      keepRate: raw ? +(records.length / raw).toFixed(3) : 0,
      byType,
      days: ctx.days, maxPages: ctx.flags.maxPages || null,
      durationMs: Date.now() - startedAt,
      deltaVsLast: prev ? records.length - prev.kept : null,
      host: os.hostname(),
    };
    appendMemory(name, entry);
    if (prev && entry.deltaVsLast != null) {
      const arrow = entry.deltaVsLast > 0 ? '▲' : entry.deltaVsLast < 0 ? '▼' : '=';
      log(`learn: ${records.length} kept (${arrow}${Math.abs(entry.deltaVsLast)} vs last run on ${prev.runDate})`);
      if (prev.kept > 0 && records.length === 0) {
        warn(`learn: REGRESSION — last run kept ${prev.kept}, this run kept 0. Source may have changed.`);
      }
    }
    return entry;
  }

  function printHelp() {
    console.log(`${displayName} (${layer}) — das-leadgen signal agent "${name}"

Usage: node index.js [options]
  --days N         lookback window (default ${defaultDays})
  --active-only    only active/in-process records (where applicable)
  --no-filter      skip the Danielian ICP filter (debug)
  --max-pages N    cap pagination (smoke/self-heal)
  -o, --output F   write JSON array here (orchestrator passes this)
  -f, --format X   json | summary
  --headed         run browser headed (debug)
  -h, --help       this help

Skill: ${skill.perceives || '(perceives raw records from the source)'}
Sources: ${(skill.sources || []).join(', ') || 'see config/signal-sources.json'}`);
  }

  // The full loop with self-healing retry around PERCEIVE.
  async function run(argv) {
    loadEnv();
    const flags = parseCliArgs(argv);
    if (flags.help) { printHelp(); return; }
    const days = Number.isFinite(flags.days) ? flags.days : defaultDays;
    const hints = cortexHints(name);
    const ctx = {
      name, layer, days, flags,
      maxPages: flags.maxPages, headed: !!flags.headed,
      noFilter: !!flags.noFilter, activeOnly: !!flags.activeOnly,
      sinceDate: new Date(Date.now() - days * 86400000),
      cortexHints: hints, log, warn, OUTPUT_DIR, REPO_ROOT,
    };
    if (hints) log(`cortex: loaded ${hints.length} chars of tuning notes`);

    const startedAt = Date.now();
    let rawRecords = null, attempt = 0, lastErr;
    while (attempt <= retries) {
      try {
        log(`PERCEIVE (attempt ${attempt + 1}/${retries + 1}, days=${days})`);
        rawRecords = await perceive(ctx);
        if (!Array.isArray(rawRecords)) throw new Error('perceive() must return an array');
        break;
      } catch (err) {
        lastErr = err;
        warn(`perceive failed: ${err.message}`);
        attempt++;
        if (attempt <= retries) await new Promise(r => setTimeout(r, backoffMs * attempt));
      }
    }
    if (rawRecords == null) {
      console.error(`[${name}] FATAL after ${retries + 1} attempts: ${lastErr && lastErr.message}`);
      appendMemory(name, { ts: ts(), agent: name, error: lastErr && lastErr.message, runDate: today() });
      process.exitCode = 1;
      return;
    }

    const reasoner = typeof reason === 'function' ? reason : defaultReason;
    const records = await reasoner(rawRecords, ctx);

    if ((flags.format || 'json') === 'summary') {
      printSummary(records, rawRecords.length);
      learn(records, rawRecords.length, ctx, startedAt);
      return;
    }
    act(records, ctx);
    learn(records, rawRecords.length, ctx, startedAt);
    return records;
  }

  return { run, perceive, reason: reason || defaultReason, act, learn, skill, name, layer, displayName, parseCliArgs };
}

module.exports = { defineAgent, parseCliArgs, OUTPUT_DIR, REPO_ROOT, today };

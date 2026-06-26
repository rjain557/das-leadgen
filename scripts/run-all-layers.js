#!/usr/bin/env node
// run-all-layers.js — Danielian Pursuit Intelligence ORCHESTRATOR.
//
// The pipeline is itself a 4-pillar agent operating over the layer agents:
//   PERCEIVE → run every enabled signal-layer agent as a subprocess (the BBC
//              CLI contract: `node agents/<x>/index.js --days N -o <file>`,
//              read back the JSON array each writes)
//   REASON   → consolidate + dedup (multi-source merge) → enrich → score → tier
//   ACT      → write data/output/full-run-<date>.{json} (+ hand off to report,
//              build-brief, email via the weekly chain / npm scripts)
//   LEARN    → run stats + dedup ratio + tier counts to runs/ and the memory
//              vault; pipeline-learn diff vs last run
//
// Resilient: one failing layer never aborts the run (it is logged + retried).
// Enrichment degrades gracefully when an API key is absent (structural dry runs
// work with zero credentials).
//
// Usage: node scripts/run-all-layers.js [--layers L1,L2,...|all] [--metros OC,LA]
//        [--days N] [--no-enrich] [--brief] [--email] [--skip-preflight]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEnv, MEMORY_VAULT_DIR } = require('../agents/shared/load-env');
const score = require('./score-lib');
const { consolidate } = require('./consolidate-lib');

loadEnv();

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'output');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');
const RUNS_DIR = path.join(REPO_ROOT, 'runs');
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
const signalSources = readJson(path.join(CONFIG_DIR, 'signal-sources.json'), { layers: {} });
const jurisdictions = readJson(path.join(CONFIG_DIR, 'jurisdictions.json'), {});
const icp = readJson(path.join(CONFIG_DIR, 'das-icp.json'), { activeMetros: ['OC'], metros: {} });

// ---- CLI ------------------------------------------------------------------
function parseArgs() {
  const a = process.argv.slice(2); const f = { layers: 'all', days: 90 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--layers') f.layers = a[++i];
    else if (a[i] === '--metros') f.metros = a[++i];
    else if (a[i] === '--days') f.days = parseInt(a[++i], 10);
    else if (a[i] === '--no-enrich') f.noEnrich = true;
    else if (a[i] === '--brief') f.brief = true;
    else if (a[i] === '--email') f.email = true;
    else if (a[i] === '--skip-preflight') f.skipPreflight = true;
    else if (a[i] === '--timeout') f.timeout = parseInt(a[++i], 10);
    else if (a[i] === '--help' || a[i] === '-h') f.help = true;
  }
  return f;
}

function log(...m) { console.log(`[orchestrator]`, ...m); }
function warn(...m) { console.warn(`[orchestrator]`, ...m); }

// ---- PERCEIVE: run one layer agent as a subprocess, read its JSON back -----
function runAgent(agentDir, args, label, timeoutMs = 1200000) {
  const indexFile = path.join(agentDir, 'index.js');
  if (!fs.existsSync(indexFile)) { warn(`skip ${label}: no index.js at ${agentDir}`); return { status: 'skipped', records: [] }; }
  const stampStr = today();
  const outFile = path.join(OUTPUT_DIR, `${path.basename(agentDir)}-leads-${stampStr}.json`);
  const fullArgs = args.concat(['-o', outFile]);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  try {
    log(`PERCEIVE ${label}: node ${path.relative(REPO_ROOT, indexFile)} ${fullArgs.join(' ')}`);
    execFileSync(process.execPath, [indexFile, ...fullArgs], {
      cwd: agentDir, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    // Read back per the contract: bare array OR {leads|results|data|listings|matches}.
    const probe = [outFile, path.join(OUTPUT_DIR, `${path.basename(agentDir)}-leads.json`), path.join(agentDir, 'output.json')];
    for (const p of probe) {
      if (!fs.existsSync(p)) continue;
      const raw = readJson(p, null);
      const records = Array.isArray(raw) ? raw : (raw && (raw.leads || raw.results || raw.data || raw.listings || raw.matches)) || [];
      return { status: 'ok', records, file: p };
    }
    warn(`${label}: no output file produced`); return { status: 'no-output', records: [] };
  } catch (err) {
    warn(`${label} FAILED: ${err.message.split('\n')[0]}`);
    return { status: 'error', records: [], error: err.message };
  }
}

// Build the layer run-list from config (enabled layers + active metros).
function buildLayerPlan(flags) {
  const want = flags.layers === 'all' ? null : new Set(flags.layers.split(',').map(s => s.trim().toUpperCase()));
  const activeMetros = (flags.metros ? flags.metros.split(',') : icp.activeMetros || ['OC']).map(s => s.trim().toUpperCase());
  const plan = [];
  for (const [key, cfg] of Object.entries(signalSources.layers || {})) {
    const code = key.split('_')[0].toUpperCase(); // L1, L2, ...
    if (cfg.enabled === false) continue;
    if (want && !want.has(code) && !want.has(key.toUpperCase())) continue;
    if (key === 'L1_permits') {
      // Per-jurisdiction permit agents across active metros.
      for (const metro of activeMetros) {
        for (const j of (jurisdictions[metro] || [])) {
          if (j.verified === false && !flags.includeUnverified) continue; // skip phase-0 stubs by default
          const agentDir = j.agent ? path.join(AGENTS_DIR, j.agent) : null;
          if (agentDir && fs.existsSync(path.join(agentDir, 'index.js'))) {
            plan.push({ code, label: `L1 ${metro}/${j.city}`, agentDir, args: ['--active-only', '-f', 'json', '--days', String(flags.days)], parallel: true });
          }
        }
      }
    } else if (cfg.agent) {
      const agentDir = path.join(AGENTS_DIR, cfg.agent);
      plan.push({ code, label: `${code} ${cfg.label}`, agentDir, args: ['--days', String(flags.days)], parallel: false });
    }
  }
  return { plan, activeMetros };
}

// ---- REASON: enrichment (graceful) ----------------------------------------
async function enrich(leads, flags) {
  if (flags.noEnrich) { log('REASON enrich: skipped (--no-enrich)'); return leads; }
  // Geocode (Google) — fills geo + tightens dedup. Optional module.
  await tryModule('./enrich-geocode.js', leads, 'geocode', process.env.GOOGLE_GEOCODING_API_KEY);
  // ATTOM owner/deed by address — optional module.
  await tryModule('./enrich-leads-attom.js', leads, 'attom', process.env.ATTOM_API_KEY);
  // Developer-entity resolution (LLC → real developer) — the net-new enrichment.
  await tryModule('./resolve-developer-entity.js', leads, 'developer-entity', true);
  return leads;
}

async function tryModule(rel, leads, name, gate) {
  if (!gate) { log(`REASON enrich:${name} skipped (no key)`); return; }
  const p = path.join(__dirname, rel);
  if (!fs.existsSync(p)) { log(`REASON enrich:${name} skipped (module absent)`); return; }
  try {
    const mod = require(p);
    const fn = mod.enrichLeads || mod.enrich || mod.run;
    if (typeof fn === 'function') { await fn(leads); log(`REASON enrich:${name} applied`); }
    else log(`REASON enrich:${name} module has no enrich() export — skipped`);
  } catch (e) { warn(`REASON enrich:${name} error: ${e.message.split('\n')[0]}`); }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const flags = parseArgs();
  if (flags.help) { printHelp(); return; }
  const runId = `${stamp()}_pipeline`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const t0 = Date.now();
  log(`Danielian Pursuit Intelligence — run ${runId}`);

  // Preflight (optional, non-fatal).
  if (!flags.skipPreflight) {
    const pf = path.join(__dirname, 'preflight-check.js');
    if (fs.existsSync(pf)) { try { execFileSync(process.execPath, [pf], { stdio: 'inherit', timeout: 120000 }); } catch { warn('preflight reported warnings/failures — continuing'); } }
  }

  // ===== PERCEIVE =====
  const { plan, activeMetros } = buildLayerPlan(flags);
  log(`PERCEIVE: ${plan.length} layer agent(s); active metros: ${activeMetros.join(', ')}`);
  const layerResults = [];
  let allRaw = [];
  for (const step of plan) {
    const res = runAgent(step.agentDir, step.args, step.label, flags.timeout);
    layerResults.push({ label: step.label, code: step.code, status: res.status, count: res.records.length });
    // tag metro for permit layers
    for (const r of res.records) { if (!r.metro && /^L1 (\w+)\//.test(step.label)) r.metro = step.label.split(' ')[1].split('/')[0]; }
    allRaw = allRaw.concat(res.records);
  }
  log(`PERCEIVE complete: ${allRaw.length} raw signals from ${layerResults.filter(r => r.status === 'ok').length}/${plan.length} agents`);

  // ===== REASON: consolidate + dedup + enrich + score =====
  const { leads, stats } = consolidate(allRaw, today());
  log(`REASON consolidate: ${stats.rawCount} raw → ${stats.deduped} unique (${stats.merged} merged, multi-source corroboration)`);
  await enrich(leads, flags);
  const { tierCounts } = score.scoreAll(leads, { activeMetros });
  leads.sort((a, b) => b.score - a.score);
  log(`REASON score: T1=${tierCounts.tier1} T2=${tierCounts.tier2} T3=${tierCounts.tier3} dropped=${tierCounts.dropped}`);

  // ===== ACT: write full-run =====
  const kept = leads.filter(l => l.tier > 0);
  const dropped = leads.filter(l => l.tier === 0);
  const meta = {
    runId, runDate: today(), activeMetros, days: flags.days,
    layers: layerResults, rawCount: stats.rawCount, deduped: stats.deduped,
    merged: stats.merged, multiSource: leads.filter(l => l.multiSource).length,
    tierCounts, totalLeads: kept.length, durationMs: Date.now() - t0,
  };
  const outBase = path.join(OUTPUT_DIR, `full-run-${today()}`);
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({ meta, leads: kept, dropped }, null, 2));
  log(`ACT: wrote ${outBase}.json (${kept.length} scored pursuits)`);

  // XLSX/CSV via the reused report builder (best-effort).
  tryReport(`${outBase}.json`);

  // Optional Brief + email.
  if (flags.brief) tryScript('build-brief.js', [`${outBase}.json`], 'build-brief');
  if (flags.email) tryPwsh('email-brief.ps1');

  // ===== LEARN =====
  writeLearn(runDir, meta);
  tryScript('pipeline-learn.js', [], 'pipeline-learn'); // diff vs last run (best-effort)
  log(`LEARN: run logged to ${path.relative(REPO_ROOT, runDir)} (${Math.round(meta.durationMs / 1000)}s)`);
}

function tryReport(jsonPath) {
  const p = path.join(__dirname, 'build-full-report.js');
  if (!fs.existsSync(p)) return;
  try { execFileSync(process.execPath, [p, '--input', jsonPath], { stdio: 'inherit', timeout: 120000 }); }
  catch { warn('build-full-report failed (non-fatal)'); }
}
function tryScript(name, args, label) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) { warn(`${label}: ${name} absent`); return; }
  try { execFileSync(process.execPath, [p, ...args], { stdio: 'inherit', timeout: 300000 }); }
  catch { warn(`${label} failed (non-fatal)`); }
}
function tryPwsh(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) return;
  try { execFileSync('powershell', ['-NoProfile', '-File', p], { stdio: 'inherit', timeout: 180000 }); }
  catch { warn(`${name} failed (non-fatal)`); }
}

function writeLearn(runDir, meta) {
  try { fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta, null, 2)); } catch {}
  // Append to the Obsidian memory vault (best-effort).
  try {
    const dir = path.join(MEMORY_VAULT_DIR, 'pipeline-runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), runDate: meta.runDate, raw: meta.rawCount,
      deduped: meta.deduped, tierCounts: meta.tierCounts, durationMs: meta.durationMs,
    }) + '\n');
    // index.json for quick lookup
    const idx = path.join(RUNS_DIR, 'run-index.json');
    const arr = readJson(idx, []);
    arr.push({ runId: meta.runId, runDate: meta.runDate, totalLeads: meta.totalLeads, tierCounts: meta.tierCounts });
    fs.writeFileSync(idx, JSON.stringify(arr, null, 2));
  } catch {}
}

function printHelp() {
  console.log(`Danielian Pursuit Intelligence — orchestrator

  node scripts/run-all-layers.js [options]
    --layers L1,L2,L3,...|all   which signal layers to run (default all enabled)
    --metros OC,LA,NASHVILLE     override active metros (default config/das-icp.json)
    --days N                     lookback window (default 90)
    --no-enrich                  skip enrichment (geocode/ATTOM/entity)
    --brief                      generate the weekly Pursuit Intelligence Brief
    --email                      email the Brief (M365 Graph)
    --skip-preflight             skip the preflight gate
    --timeout MS                 per-agent timeout (default 1,200,000)

  Pillars: PERCEIVE (harvest layers) → REASON (consolidate/enrich/score) →
           ACT (full-run + Brief) → LEARN (run stats + diff vs last run).`);
}

main().catch(e => { console.error('[orchestrator] FATAL', e); process.exit(1); });

#!/usr/bin/env node
// mcp-server/index.js — Danielian Pursuit Intelligence MCP server (stdio).
// Lets Claude query the pursuit feed interactively (spec §8.2). Reuses the BBC
// pattern: tools shell out to pipeline scripts or read the latest full-run JSON.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const AGENTS_DIR = path.join(ROOT, 'agents');

function latestFullRun() {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => /^full-run-.*\.json$/.test(f)).sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, files[files.length - 1]), 'utf8'));
}
const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
function sh(file, args, timeout = 1800000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd: ROOT, timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').slice(-4000), stderr: (stderr || '').slice(-2000), error: err && err.message });
    });
  });
}

const server = new McpServer({ name: 'das-leadgen', version: '0.1.0' });

// --- run-pipeline ----------------------------------------------------------
server.tool('run-pipeline', 'Run the weekly Danielian Pursuit Intelligence pipeline (harvest → consolidate → enrich → score → Brief).',
  { layers: z.string().optional().describe('comma list e.g. L1,L3 or "all"'), metros: z.string().optional(), days: z.number().optional(), noEnrich: z.boolean().optional(), brief: z.boolean().optional() },
  async ({ layers, metros, days, noEnrich, brief }) => {
    const args = ['scripts/run-all-layers.js'];
    if (layers) args.push('--layers', layers);
    if (metros) args.push('--metros', metros);
    if (days) args.push('--days', String(days));
    if (noEnrich) args.push('--no-enrich');
    if (brief) args.push('--brief');
    const r = await sh(path.join(ROOT, 'scripts', 'run-all-layers.js'), args.slice(1));
    return text({ ok: r.ok, tail: r.stdout, error: r.error });
  });

// --- get-tier1 -------------------------------------------------------------
server.tool('get-tier1', 'Get the current Tier-1 (act-now) pursuits from the latest run.',
  { limit: z.number().optional() },
  async ({ limit }) => {
    const doc = latestFullRun();
    if (!doc) return text('No run yet — call run-pipeline first.');
    const t1 = (doc.leads || []).filter(l => l.tier === 1).slice(0, limit || 50)
      .map(l => ({ id: l.id, address: l.address, jurisdiction: l.jurisdiction, metro: l.metro, projectType: l.projectType, unitCount: l.unitCount, stage: l.stage, score: l.score, developer: l.developer && (l.developer.resolvedEntity || l.developer.rawName), sources: (l.sources || []).map(s => s.layer), knownDeveloper: !!(l.relationship && l.relationship.knownDeveloper) }));
    return text({ runDate: doc.meta && doc.meta.runDate, tier1Count: t1.length, pursuits: t1 });
  });

// --- get-dossier -----------------------------------------------------------
server.tool('get-dossier', 'Get a full dossier for one pursuit (by id or address substring) or aggregate a developer\'s active pursuits (by developer name).',
  { id: z.string().optional(), address: z.string().optional(), developer: z.string().optional() },
  async ({ id, address, developer }) => {
    const doc = latestFullRun();
    if (!doc) return text('No run yet — call run-pipeline first.');
    const leads = doc.leads || [];
    if (id) { const l = leads.find(x => x.id === id); return text(l || `No pursuit with id ${id}`); }
    if (address) { const l = leads.find(x => (x.address || '').toLowerCase().includes(address.toLowerCase())); return text(l || `No pursuit matching "${address}"`); }
    if (developer) {
      const key = developer.toLowerCase();
      const matches = leads.filter(x => x.developer && ((x.developer.resolvedEntity || '') + (x.developer.rawName || '')).toLowerCase().includes(key));
      return text({ developer, activePursuits: matches.length, relationship: matches.find(m => m.relationship && m.relationship.knownDeveloper)?.relationship || null, pursuits: matches.map(m => ({ address: m.address, projectType: m.projectType, unitCount: m.unitCount, stage: m.stage, score: m.score, tier: m.tier })) });
    }
    return text('Provide one of: id, address, or developer.');
  });

// --- search-pursuits -------------------------------------------------------
server.tool('search-pursuits', 'Search/filter the latest pursuit set by free text, metro, project type, min score, or tier.',
  { query: z.string().optional(), metro: z.string().optional(), projectType: z.string().optional(), minScore: z.number().optional(), tier: z.number().optional(), limit: z.number().optional() },
  async ({ query, metro, projectType, minScore, tier, limit }) => {
    const doc = latestFullRun();
    if (!doc) return text('No run yet — call run-pipeline first.');
    let leads = doc.leads || [];
    if (query) { const q = query.toLowerCase(); leads = leads.filter(l => JSON.stringify(l).toLowerCase().includes(q)); }
    if (metro) leads = leads.filter(l => (l.metro || '').toUpperCase() === metro.toUpperCase());
    if (projectType) leads = leads.filter(l => l.projectType === projectType);
    if (minScore != null) leads = leads.filter(l => l.score >= minScore);
    if (tier != null) leads = leads.filter(l => l.tier === tier);
    leads = leads.slice(0, limit || 50).map(l => ({ id: l.id, address: l.address, metro: l.metro, projectType: l.projectType, unitCount: l.unitCount, stage: l.stage, score: l.score, tier: l.tier }));
    return text({ count: leads.length, pursuits: leads });
  });

// --- get-latest-report -----------------------------------------------------
server.tool('get-latest-report', 'Summary metadata of the latest pipeline run (counts, tiers, layers).', {},
  async () => { const doc = latestFullRun(); return text(doc ? doc.meta : 'No run yet.'); });

// --- list-agents -----------------------------------------------------------
server.tool('list-agents', 'List the signal-layer agents available in this repo.', {},
  async () => {
    const out = [];
    const walk = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const sub = path.join(dir, e.name); if (fs.existsSync(path.join(sub, 'index.js'))) out.push(path.join(rel, e.name).replace(/\\/g, '/')); else walk(sub, path.join(rel, e.name)); } };
    if (fs.existsSync(AGENTS_DIR)) walk(AGENTS_DIR, '');
    return text({ agents: out });
  });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[das-leadgen mcp] ready on stdio');
}
main().catch(e => { console.error('[das-leadgen mcp] fatal', e); process.exit(1); });

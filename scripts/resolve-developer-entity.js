// resolve-developer-entity.js — the ONE genuinely new enrichment vs BBC
// (spec §7). A developer records a deed / files a CEQA notice under an LLC; we
// resolve that LLC to the REAL developer behind it (principal/officer) and
// cross-reference Danielian's project archive to set the "you already know this
// buyer" relationship flag — the single strongest activation signal for an ABM
// firm (spec §8.4).
//
// Sources: OpenCorporates (LLC → officers) + CA SOS bizfile (fallback). Both are
// optional/rate-limited — this module ALWAYS degrades gracefully to the raw name
// and never throws (the orchestrator calls it best-effort).
//
// Exposes enrichLeads(leads) so the orchestrator's tryModule() picks it up.
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../agents/shared/load-env');

loadEnv();
const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(REPO_ROOT, 'data', 'output', 'entity-cache.json');
const ARCHIVE_DIR = path.join(REPO_ROOT, 'data', 'archive-index');

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveCache(c) { try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch {} }

// Danielian's 6,353-project archive (Phase-0 export). Optional. When present,
// data/archive-index/developers.json = [{ developer, projects:[{project,year,location}] }]
// or a flat [{ developer, project, year, location }]. We index by normalized name.
let _archive = null;
function loadArchive() {
  if (_archive !== null) return _archive;
  _archive = new Map();
  try {
    const f = path.join(ARCHIVE_DIR, 'developers.json');
    if (fs.existsSync(f)) {
      const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const r of rows) {
        const name = normName(r.developer);
        if (!name) continue;
        const entry = _archive.get(name) || { developer: r.developer, projects: [] };
        if (Array.isArray(r.projects)) entry.projects.push(...r.projects);
        else if (r.project) entry.projects.push({ project: r.project, year: r.year, location: r.location });
        _archive.set(name, entry);
      }
    }
  } catch { /* no archive yet — relationship flags stay false */ }
  return _archive;
}

function normName(n) {
  return String(n || '').toLowerCase()
    .replace(/\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|lp|l\.p|ltd|holdings|partners|development|developments|group|properties|communities|residential|homes|builders?)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Archive cross-ref: does Danielian already know this developer?
function matchArchive(rawName, resolvedEntity) {
  const archive = loadArchive();
  if (!archive.size) return null;
  for (const cand of [resolvedEntity, rawName]) {
    const key = normName(cand);
    if (key && archive.has(key)) {
      const e = archive.get(key);
      const last = e.projects.filter(p => p.year).sort((a, b) => b.year - a.year)[0];
      return {
        knownDeveloper: true,
        lastProjectYear: last ? last.year : null,
        note: last ? `Danielian designed ${last.project || 'a project'} for this developer in ${last.year}` : 'Known Danielian developer (archive match)',
        projectCount: e.projects.length,
      };
    }
  }
  return null;
}

// OpenCorporates company search (free tier; api_token optional → higher limits).
async function resolveViaOpenCorporates(rawName) {
  const token = process.env.OPENCORPORATES_API_KEY || process.env.OPENCORPORATES_TOKEN;
  const base = 'https://api.opencorporates.com/v0.4/companies/search';
  const url = `${base}?q=${encodeURIComponent(rawName)}&jurisdiction_code=us_ca&order=score${token ? `&api_token=${token}` : ''}`;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'das-leadgen/1.0' } });
    clearTimeout(t);
    if (!res.ok) return null; // 401/403/429 → degrade silently
    const data = await res.json();
    const companies = data?.results?.companies || [];
    if (!companies.length) return null;
    const c = companies[0].company;
    return {
      resolvedEntity: c.name || rawName,
      jurisdiction: c.jurisdiction_code,
      companyNumber: c.company_number,
      incorporationDate: c.incorporation_date || null,
      officers: (c.officers || []).map(o => o.officer?.name).filter(Boolean).slice(0, 5),
      opencorporatesUrl: c.opencorporates_url || null,
      source: 'opencorporates',
    };
  } catch { return null; }
}

// CA SOS bizfile fallback (FREE, no key). bizfileonline.sos.ca.gov is a React SPA
// behind Imperva; the resolver in ./resolve-ca-sos.js drives a stealth browser to
// reach the public business-search JSON API (see that file's header for the live
// request/response shape + the login-gated-detail limitation). Here we adapt its
// result into this module's { resolvedEntity, officers, source } contract. The
// "officer" we expose is the registered agent for service of process — and ONLY
// when it's a real human (commercial registered-agent services are skipped).
// PHASE-0 VERIFY: depends on the bizfile search-response shape parsed in
// resolve-ca-sos.js (rows[].AGENT / TITLE / STATUS); that API may drift.
let _caSos = null;
function caSosModule() { if (_caSos === null) { try { _caSos = require('./resolve-ca-sos'); } catch { _caSos = false; } } return _caSos; }
async function resolveViaBizfile(rawName) {
  const m = caSosModule();
  if (!m) return null;
  let r = null;
  try { r = await m.resolveEntity(rawName); } catch { return null; }
  if (!r || !r.entityName) return null;
  const humanAgent = (r.agent && r.agent.name && (m.isHumanAgent ? m.isHumanAgent(r.agent.name) : !r.agent.isCommercial))
    ? r.agent.name : null;
  return {
    resolvedEntity: r.entityName,
    jurisdiction: r.jurisdiction || 'us_ca',
    companyNumber: r.entityNumber || null,
    incorporationDate: r.registrationDate || null,
    officers: humanAgent ? [humanAgent] : [],       // registered agent (real human only)
    registeredAgent: r.agent || null,               // { name, address, isCommercial }
    agentShielded: !!(r.agent && r.agent.isCommercial),
    status: r.status || null,
    bizfileUrl: r.sourceUrl || null,
    source: 'ca-sos',
  };
}

async function resolveOne(rawName, cache) {
  const key = normName(rawName);
  if (!key) return null;
  if (cache[key] !== undefined) return cache[key];
  let resolved = await resolveViaOpenCorporates(rawName);
  if (!resolved) resolved = await resolveViaBizfile(rawName);
  cache[key] = resolved || { resolvedEntity: null, source: 'unresolved' };
  return cache[key];
}

// Orchestrator entry point. Mutates leads in place, returns them.
async function enrichLeads(leads = []) {
  const cache = loadCache();
  let resolvedCount = 0, knownCount = 0;
  for (const lead of leads) {
    const dev = lead.developer || (lead.developer = {});
    const rawName = dev.rawName || dev.grantee || lead.applicant || '';
    if (!rawName) continue;

    // Resolve LLC → entity (only worth it for LLC/corp grantees).
    if (dev.isLLC && !dev.resolvedEntity) {
      const r = await resolveOne(rawName, cache);
      if (r && r.resolvedEntity) {
        dev.resolvedEntity = r.resolvedEntity;
        dev.officers = r.officers; dev.opencorporatesUrl = r.opencorporatesUrl;
        dev.entitySource = r.source; resolvedCount++;
      }
    }

    // Archive relationship cross-ref (the activation differentiator).
    const rel = matchArchive(rawName, dev.resolvedEntity);
    if (rel) { lead.relationship = Object.assign({}, lead.relationship, rel); knownCount++; }
  }
  saveCache(cache);
  // Release any bizfile browser session opened by resolveViaBizfile (no-op if the
  // CA SOS path never launched one, e.g. all cache hits or OpenCorporates-only).
  try { const m = caSosModule(); if (m && m.closeSession) await m.closeSession(); } catch { /* ignore */ }
  console.log(`[resolve-developer-entity] resolved ${resolvedCount} LLC entities; ${knownCount} matched the Danielian archive`);
  return leads;
}

module.exports = { enrichLeads, enrich: enrichLeads, normName, matchArchive, resolveViaOpenCorporates };

if (require.main === module) {
  // CLI: enrich the latest full-run in place (manual re-enrichment).
  const out = path.join(REPO_ROOT, 'data', 'output');
  const files = fs.existsSync(out) ? fs.readdirSync(out).filter(f => /^full-run-.*\.json$/.test(f)).sort() : [];
  if (!files.length) { console.log('No full-run-*.json to enrich.'); process.exit(0); }
  const f = path.join(out, files[files.length - 1]);
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  enrichLeads(doc.leads || []).then(() => { fs.writeFileSync(f, JSON.stringify(doc, null, 2)); console.log(`Re-enriched ${f}`); });
}

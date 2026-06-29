#!/usr/bin/env node
// build-brief.js — generates the weekly "Danielian Pursuit Intelligence" Brief
// (spec §8): an on-brand HTML email with the Tier-1 pursuit list, account
// dossiers, and relationship/legislative activation triggers.
//
// NAMING DISCIPLINE (spec §0, hard rule): everything the client sees says
// "Danielian" and "Pursuit Intelligence" — never the internal code "DAS" and
// never "lead generation." This is an ABM timing-intelligence brief, not lead-gen.
//
// Usage: node scripts/build-brief.js [path/to/full-run-YYYY-MM-DD.json]
//        (defaults to the latest full-run in data/output)
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'output');

function latestFullRun() {
  const files = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR).filter(f => /^full-run-.*\.json$/.test(f)).sort() : [];
  return files.length ? path.join(OUTPUT_DIR, files[files.length - 1]) : null;
}

function latestNews() {
  const files = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR).filter(f => /^(developer-news|news-cache).*\.json$/.test(f)).sort() : [];
  if (!files.length) return [];
  try { const raw = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, files[files.length - 1]), 'utf8')); return Array.isArray(raw) ? raw : (raw.items || []); } catch { return []; }
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtType = t => ({ 'multifamily': 'Multifamily', 'btr': 'Build-to-Rent', 'master-plan': 'Master-Planned', 'mixed-use': 'Mixed-Use', 'affordable': 'Affordable', 'adu-batch': 'ADU (batch)', 'sfr': 'Single-Family', 'unknown': 'Residential' }[t] || 'Residential');
const fmtStage = s => ({ 'land-acquired': 'Land acquired', 'ceqa-nop': 'CEQA — Notice of Preparation', 'entitlement': 'Entitlement / planning', 'permit-filed': 'Permit filed', 'unknown': 'Early signal' }[s] || 'Early signal');

// The activation hook — the one-line "why now / what to do" per pursuit.
function suggestedTrigger(lead) {
  const rel = lead.relationship || {};
  const leg = lead.legislative || {};
  const units = lead.unitCount ? `${lead.unitCount}-unit ` : '';
  const where = lead.jurisdiction || lead.metro || 'the corridor';
  if (rel.knownDeveloper) return `${rel.note}. They are active again on this ${units}${fmtType(lead.projectType).toLowerCase()} pursuit in ${where} — re-open the relationship now, pre-RFQ.`;
  if (lead.stage === 'land-acquired') return `Developer just recorded a deed on this site (${where}) — the architect-selection window is opening now. Reach out before the RFQ.`;
  if (lead.stage === 'ceqa-nop') return `Earliest possible signal: CEQA Notice of Preparation filed (12–18 mo lead). Establish the relationship long before competitors see it.`;
  if (leg.sb79) return `SB 79 transit-corridor parcel${lead.sb79Tier ? ` (tier ${lead.sb79Tier})` : ''} — a new project type the upzoning just enabled. Position as the SB 79 design expert.`;
  if (leg.densityBonus || leg.builderRemedy) return `Density-bonus / streamlining pathway — squarely a Danielian affordable/density line. Engage on the entitlement strategy.`;
  if (lead.stage === 'entitlement') return `On a planning/design-review track — design-team selection typically lands within 90–180 days. Time the outreach to the next hearing.`;
  return `Pre-RFQ ${units}${fmtType(lead.projectType).toLowerCase()} pursuit in ${where}. Surface the relationship early.`;
}

function sourceBadges(lead) {
  const layers = [...new Set((lead.sources || []).map(s => (s.layer || '').toUpperCase().split('-')[0]))].filter(Boolean);
  return layers.map(l => `<span class="badge">${esc(l)}</span>`).join(' ');
}

// Aggregate Tier-1 pursuits into per-developer dossiers (spec §5.3).
function buildDossiers(tier1, news) {
  const byDev = new Map();
  for (const lead of tier1) {
    const dev = (lead.developer && (lead.developer.resolvedEntity || lead.developer.rawName)) || 'Unidentified developer';
    const e = byDev.get(dev) || { developer: dev, pursuits: [], relationship: null, officers: [], contacts: [] };
    e.pursuits.push(lead);
    if (lead.relationship && lead.relationship.knownDeveloper) e.relationship = lead.relationship;
    if (lead.developer && lead.developer.officers) e.officers = lead.developer.officers;
    if (Array.isArray(lead.contacts)) e.contacts.push(...lead.contacts);
    byDev.set(dev, e);
  }
  for (const e of byDev.values()) {
    const key = e.developer.toLowerCase().split(/[ ,]/)[0];
    e.news = news.filter(n => (n.developerName || '').toLowerCase().includes(key)).slice(0, 3);
    // dedupe contacts by name+email
    const seen = new Set();
    e.contacts = e.contacts.filter(c => { const k = `${c.name}|${c.email}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  }
  return [...byDev.values()].sort((a, b) => b.pursuits.length - a.pursuits.length);
}

// Land & Entitlement Watch — the L2/L4 payoff. Pursuits below Tier-1 that still
// carry a real developer NAME because a deed was recorded (L4 grantee) or a
// planning/design-review item was filed (L2 applicant). These are named accounts
// acquiring/entitling land in the active markets RIGHT NOW — warm them early,
// even though they're pre-unit-count and so don't out-score the HCD/SB79 leads.
function buildWatchlist(leads) {
  const isL = (lead, code) => (lead.sources || []).some(s => new RegExp(`^${code}\\b`, 'i').test(String(s.layer || '')));
  const named = leads.filter(l => l.tier >= 2 && l.developer && l.developer.rawName && (isL(l, 'L2') || isL(l, 'L4')));
  const byDev = new Map();
  for (const lead of named) {
    const dev = lead.developer.resolvedEntity || lead.developer.rawName;
    const e = byDev.get(dev) || { developer: dev, pursuits: [], contacts: [] };
    e.pursuits.push(lead);
    if (Array.isArray(lead.contacts)) e.contacts.push(...lead.contacts);
    byDev.set(dev, e);
  }
  for (const e of byDev.values()) {
    const seen = new Set();
    e.contacts = e.contacts.filter(c => { const k = `${c.name}|${c.email}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
  }
  // Developers with a resolved contact first, then by number of signals.
  return [...byDev.values()].sort((a, b) => (b.contacts.length - a.contacts.length) || (b.pursuits.length - a.pursuits.length));
}

function renderWatchPursuit(p) {
  const isDeed = (p.sources || []).some(s => /^L4\b/i.test(String(s.layer || '')));
  const date = (p.sources && p.sources[0] && p.sources[0].date) || '';
  const what = isDeed ? 'Recorded a grant deed' : 'On a planning / design-review agenda';
  const loc = p.address ? ` — ${esc(p.address)}` : ` (${esc(p.jurisdiction || p.metro || 'OC')})`;
  return `<li>${esc(what)}${loc}${date ? ` <span class="muted">· ${esc(date)}</span>` : ''} <span class="muted">${sourceBadges(p)}</span></li>`;
}

function renderBrief(doc, news) {
  const meta = doc.meta || {};
  const leads = (doc.leads || []).filter(l => l.tier > 0);
  const tier1 = leads.filter(l => l.tier === 1);
  const tier2 = leads.filter(l => l.tier === 2);
  const runDate = meta.runDate || new Date().toISOString().slice(0, 10);
  const newT1 = tier1.filter(l => l.firstSeen === runDate);
  const dossiers = buildDossiers(tier1, news);
  const watch = buildWatchlist(leads).slice(0, 25);

  const cards = tier1.map(l => `
    <div class="card">
      <div class="card-head">
        <div class="addr">${esc(l.address || l.jurisdiction || 'Pursuit')}</div>
        <div class="score">Score ${esc(l.score)} · Tier ${esc(l.tier)}${l.firstSeen === runDate ? ' · <span class="new">NEW</span>' : ''}</div>
      </div>
      <div class="meta">
        <span>${esc(fmtType(l.projectType))}</span>
        ${l.unitCount ? `<span>· ${esc(l.unitCount)} units</span>` : ''}
        <span>· ${esc(fmtStage(l.stage))}</span>
        ${l.jurisdiction ? `<span>· ${esc(l.jurisdiction)}</span>` : ''}
      </div>
      ${l.scopeText ? `<div class="scope">${esc(String(l.scopeText).slice(0, 220))}</div>` : ''}
      <div class="trigger"><strong>Suggested trigger:</strong> ${esc(suggestedTrigger(l))}</div>
      <div class="sources">Surfaced via ${sourceBadges(l)}</div>
    </div>`).join('');

  const dossierHtml = dossiers.map(d => `
    <div class="dossier">
      <div class="dossier-head">${esc(d.developer)} <span class="muted">— ${d.pursuits.length} active pursuit${d.pursuits.length > 1 ? 's' : ''}</span></div>
      ${d.relationship ? `<div class="rel">★ ${esc(d.relationship.note)}</div>` : ''}
      ${d.officers && d.officers.length ? `<div class="muted">Principals: ${esc(d.officers.join(', '))}</div>` : ''}
      ${d.contacts && d.contacts.length ? `<div class="contacts"><strong>Decision-makers:</strong><ul>${d.contacts.map(c => `<li>${esc(c.name || '')}${c.title ? `, ${esc(c.title)}` : ''}${c.email ? ` — <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</li>`).join('')}</ul></div>` : ''}
      <ul>${d.pursuits.map(p => `<li>${esc(p.address || p.jurisdiction)} — ${esc(fmtType(p.projectType))}${p.unitCount ? `, ${esc(p.unitCount)} units` : ''} (${esc(fmtStage(p.stage))})${p.owner && p.owner.name ? ` · owner: ${esc(p.owner.name)}` : ''}</li>`).join('')}</ul>
      ${d.news && d.news.length ? `<div class="news"><strong>Recent news:</strong><ul>${d.news.map(n => `<li><a href="${esc(n.url)}">${esc(n.headline)}</a> <span class="muted">${esc(n.source || '')}</span></li>`).join('')}</ul></div>` : ''}
    </div>`).join('');

  const watchHtml = watch.map(w => `
    <div class="dossier">
      <div class="dossier-head">${esc(w.developer)} <span class="muted">— ${w.pursuits.length} signal${w.pursuits.length > 1 ? 's' : ''}</span></div>
      ${w.contacts && w.contacts.length ? `<div class="contacts"><strong>Contact:</strong><ul>${w.contacts.map(c => `<li>${esc(c.name || '')}${c.title ? `, ${esc(c.title)}` : ''}${c.email ? ` — <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.source === 'ca-sos' && !c.email ? ' <span class="muted">(registered agent — entity principal)</span>' : ''}</li>`).join('')}</ul></div>` : ''}
      <ul>${w.pursuits.map(renderWatchPursuit).join('')}</ul>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Danielian Pursuit Intelligence — ${esc(runDate)}</title>
<style>
  body{margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;line-height:1.5}
  .wrap{max-width:720px;margin:0 auto;padding:0 0 48px}
  .hero{background:#16202e;color:#fff;padding:40px 36px 32px}
  .hero h1{margin:0;font-size:22px;font-weight:600;letter-spacing:.2px}
  .hero .sub{color:#9fb3c8;font-size:13px;margin-top:6px;text-transform:uppercase;letter-spacing:1.5px}
  .exec{background:#fff;margin:0 0 0;padding:28px 36px;border-bottom:1px solid #e4e7eb}
  .exec .big{font-size:30px;font-weight:700;color:#16202e}
  .exec .label{color:#52606d;font-size:14px}
  .section{padding:28px 36px 8px}
  .section h2{font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:#52606d;margin:0 0 16px;font-weight:600}
  .card{background:#fff;border:1px solid #e4e7eb;border-left:3px solid #2bb0a6;border-radius:6px;padding:18px 20px;margin:0 0 14px}
  .card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
  .addr{font-weight:600;font-size:16px;color:#16202e}
  .score{font-size:12px;color:#52606d;white-space:nowrap}
  .new{background:#2bb0a6;color:#fff;padding:1px 6px;border-radius:3px;font-weight:700}
  .meta{color:#52606d;font-size:13px;margin:6px 0}
  .scope{font-size:13px;color:#3e4c59;margin:8px 0}
  .trigger{background:#f0f9f8;border-radius:4px;padding:10px 12px;font-size:13px;margin:10px 0 8px;color:#1f3d3a}
  .sources{font-size:12px;color:#7b8794}
  .badge{display:inline-block;background:#e3e8ef;color:#3e4c59;border-radius:3px;padding:1px 7px;font-size:11px;font-weight:600}
  .dossier{background:#fff;border:1px solid #e4e7eb;border-radius:6px;padding:16px 20px;margin:0 0 12px}
  .dossier-head{font-weight:600;color:#16202e;font-size:15px}
  .rel{background:#fff7e6;border-radius:4px;padding:8px 10px;font-size:13px;margin:8px 0;color:#7a5c00}
  .muted{color:#7b8794;font-size:12px;font-weight:400}
  ul{margin:8px 0;padding-left:20px;font-size:13px}
  a{color:#2563eb;text-decoration:none}
  .foot{padding:24px 36px;color:#7b8794;font-size:11px;border-top:1px solid #e4e7eb;margin-top:16px}
</style></head><body><div class="wrap">
  <div class="hero">
    <h1>Danielian Pursuit Intelligence</h1>
    <div class="sub">Weekly Brief · ${esc(runDate)}</div>
  </div>
  <div class="exec">
    <div class="big">${newT1.length} new Tier-1 pursuit${newT1.length === 1 ? '' : 's'} this week</div>
    <div class="label">${tier1.length} active Tier-1 · ${tier2.length} on the watchlist · ${esc((meta.activeMetros || ['OC']).join(', '))} · timing intelligence on named pursuits, ahead of the RFQ.</div>
  </div>
  <div class="section"><h2>Tier 1 — act now</h2>${cards || '<p class="muted">No Tier-1 pursuits this run.</p>'}</div>
  <div class="section"><h2>Account dossiers</h2>${dossierHtml || '<p class="muted">No dossiers this run.</p>'}</div>
  <div class="section"><h2>Land &amp; entitlement watch — named developers</h2>
    <p class="muted" style="margin:-8px 0 14px;font-size:13px">Named developers who just recorded a land deed or appeared on a planning / design-review agenda in your markets — the earliest named-account signals, ahead of the unit-count stage. Warm these relationships now.</p>
    ${watchHtml || '<p class="muted">No named-developer signals this run.</p>'}</div>
  <div class="foot">
    Generated by Danielian Pursuit Intelligence. Run ${esc(meta.runId || runDate)} ·
    ${esc(meta.rawCount || 0)} raw signals → ${esc(meta.deduped || leads.length)} unique pursuits ·
    ${esc((meta.multiSource) || 0)} multi-source corroborated ·
    sources: building permits, planning &amp; design-review agendas, CEQA filings, land transfers, HCD / density-bonus, SB 79 transit corridors, developer news.
    Full data set attached (XLSX, all tiers). Account-based; activate relationships warmly and individually.
  </div>
</div></body></html>`;
}

function buildBrief(inputPath) {
  const file = inputPath || latestFullRun();
  if (!file || !fs.existsSync(file)) { console.error('[build-brief] no full-run JSON found'); process.exitCode = 1; return null; }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const news = latestNews();
  const html = renderBrief(doc, news);
  const runDate = (doc.meta && doc.meta.runDate) || new Date().toISOString().slice(0, 10);
  const outPath = path.join(OUTPUT_DIR, `brief-${runDate}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`[build-brief] wrote ${outPath} (${(doc.leads || []).filter(l => l.tier === 1).length} Tier-1 cards)`);
  return outPath;
}

module.exports = { buildBrief, renderBrief, suggestedTrigger };

if (require.main === module) {
  buildBrief(process.argv[2]);
}

#!/usr/bin/env node
/**
 * build-full-report.js — Generate CSV and Excel reports from consolidated pipeline output
 *
 * Takes the JSON output from run-all-layers.js and produces:
 *   1. A flat CSV with ALL leads (one row per lead, all columns)
 *   2. An Excel file with auto-sized columns, frozen header, and auto-filter
 *
 * Usage:
 *   node scripts/build-full-report.js                                 # auto-detect latest full-run JSON
 *   node scripts/build-full-report.js data/output/full-run-2026-03-25.json
 *   node scripts/build-full-report.js data/output/full-run-2026-03-25.json --include-dropped
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let includeDropped = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-dropped') {
      includeDropped = true;
    } else if (!args[i].startsWith('--')) {
      inputFile = args[i];
    }
  }

  // Auto-detect latest full-run file
  if (!inputFile) {
    inputFile = findLatestFullRun();
  }

  return { inputFile, includeDropped };
}

function findLatestFullRun() {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('full-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(OUTPUT_DIR, files[0]) : null;
}

// ---------------------------------------------------------------------------
// CSV columns — flattened from unified schema
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  { header: 'City',                key: l => l.address?.city || '' },
  { header: 'Address',             key: l => l.address?.full || l.address?.line1 || '' },
  { header: 'APN',                 key: l => l.apn || '' },
  { header: 'Tier',                key: l => l.tier || 0 },
  { header: 'Score',               key: l => l.score || 0 },
  { header: 'Score Breakdown',     key: l => formatBreakdown(l.scoreBreakdown) },
  { header: 'Source',              key: l => formatSourceSummary(l) },
  { header: 'Source Detail',       key: l => formatSourceDetail(l) },
  { header: 'Source Count',        key: l => (l.sources || []).length },
  { header: 'Scope',               key: l => l.project?.scope || '' },
  { header: 'Description',         key: l => l.project?.description || '' },
  { header: 'SF',                  key: l => l.project?.squareFootage || '' },
  { header: 'Amenities',           key: l => (l.project?.amenities || []).join(', ') },
  { header: 'Owner Name',          key: l => l.owner?.name || '' },
  { header: 'Owner Phone',         key: l => l.owner?.phone || '' },
  { header: 'Owner Email',         key: l => l.owner?.email || '' },
  { header: 'Owner Mailing',       key: l => l.owner?.mailingAddress || '' },
  { header: 'Architect Name',      key: l => l.architect?.name || '' },
  { header: 'Architect Firm',      key: l => l.architect?.firmName || '' },
  { header: 'Architect Phone',     key: l => l.architect?.phone || '' },
  { header: 'Architect Email',     key: l => l.architect?.email || '' },
  { header: 'Architect License',   key: l => l.architect?.license || '' },
  { header: 'Architect Source',    key: l => formatContactSource(l, ['Architect','Designer','Professional','Engineer']) },
  { header: 'All Contacts',        key: l => formatContactsSummary(l.contacts) },
  { header: 'Applicant Name',      key: l => l.applicant?.name || '' },
  { header: 'Applicant Role',      key: l => l.applicant?.role || '' },
  { header: 'Contractor Name',     key: l => l.contractor?.name || '' },
  { header: 'Contractor Assigned', key: l => l.contractor?.isAssigned ? 'Yes' : 'No' },
  { header: 'Buyer Agent',         key: l => l.buyerAgent?.name || '' },
  { header: 'Buyer Brokerage',     key: l => l.buyerAgent?.brokerage || '' },
  { header: 'Buyer Agent Phone',   key: l => l.buyerAgent?.phone || '' },
  { header: 'Assessed Value',      key: l => formatCurrency(l.financial?.assessedTotal) },
  { header: 'Sale Price',          key: l => formatCurrency(l.financial?.salePrice) },
  { header: 'Sale Date',           key: l => l.financial?.saleDate || '' },
  { header: 'Year Built',          key: l => l.financial?.yearBuilt || '' },
  { header: 'HOA Community',       key: l => l.hoaCommunity || '' },
  { header: 'Story Poles',         key: l => l.storyPolesApproved ? 'Yes' : 'No' },
  { header: 'CDP Filed',           key: l => l.cdpFiled ? 'Yes' : 'No' },
  { header: 'Multi-Source',        key: l => l.multiSource ? 'Yes' : 'No' },
  { header: 'DRB Case',            key: l => l.drbCase || '' },
  { header: 'DRB Recommendation',  key: l => l.drbRecommendation || '' },
  { header: 'DRB Meeting Date',    key: l => l.drbMeetingDate || '' },
  { header: 'Permit Number',       key: l => l.permitNumber || '' },
  { header: 'Permit Status',       key: l => l.permitStatus || '' },
  { header: 'Applied Date',        key: l => l.appliedDate || '' },
  { header: 'Confidence',          key: l => l.confidence || '' },
  { header: 'Alt Owner',           key: l => l.altOwner || '' },
  { header: 'Owner Notes',         key: l => l.ownerNotes || '' },
  { header: 'Neighborhood',        key: l => l.address?.neighborhood || '' },
  { header: 'ZIP',                 key: l => l.address?.zip || '' },
  { header: 'Lead ID',             key: l => l.leadId || '' },
  { header: 'First Seen',          key: l => getFirstSeen(l) },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Human-readable source label */
const SOURCE_LABELS = {
  'permit': 'City Permit Portal',
  'drb': 'Design Review Board',
  'cdp': 'Coastal Development Permit',
  'just-sold': 'Redfin Just-Sold',
  'recorder': 'OC Clerk-Recorder',
  'hoa': 'HOA Community Match',
};

/** Short summary: "City Permit Portal, Redfin Just-Sold" */
function formatSourceSummary(lead) {
  const sources = lead.sources || [];
  if (!sources.length) return '';
  const types = [...new Set(sources.map(s => s.type))];
  return types.map(t => SOURCE_LABELS[t] || t).join(', ');
}

/** Compact rollup of contacts[] for the "All Contacts" CSV column. */
function formatContactsSummary(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) return '';
  return contacts.map(c => {
    const id = c.firmName && c.name ? `${c.name} / ${c.firmName}` : (c.firmName || c.name || '?');
    const ch = [c.phone, c.email, c.license].filter(Boolean).join(' · ');
    return `${c.role}: ${id}${ch ? ` (${ch})` : ''}`;
  }).join(' | ');
}

/** Source tag for the contact whose role is in the given list (used for "Architect Source"). */
function formatContactSource(lead, roles) {
  if (!Array.isArray(lead.contacts) || lead.contacts.length === 0) return '';
  const hit = lead.contacts.find(c => roles.includes(c.role));
  return hit ? (hit.source || '') : '';
}

/** Detail: "City Permit Portal (Huntington Beach, BLDG-25-001234); Redfin Just-Sold ($3.2M)" */
function formatSourceDetail(lead) {
  const sources = lead.sources || [];
  return sources.map(s => {
    const label = SOURCE_LABELS[s.type] || s.type;
    const city = formatCityName(s.sourceCity || '');
    const parts = [city];
    if (s.caseNumber) parts.push(s.caseNumber);
    if (s.url) parts.push(s.url);
    return parts.length ? `${label} (${parts.filter(Boolean).join(', ')})` : label;
  }).join('; ');
}

/** "huntington-beach" → "Huntington Beach" */
function formatCityName(slug) {
  if (!slug) return '';
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return '';
  return Object.entries(breakdown)
    .map(([k, v]) => `${k}(${v > 0 ? '+' : ''}${v})`)
    .join('; ');
}

function formatCurrency(val) {
  if (!val || val === 0) return '';
  const n = typeof val === 'string' ? parseFloat(val.replace(/[$,]/g, '')) : val;
  if (!n || isNaN(n)) return '';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function getFirstSeen(lead) {
  const dates = (lead.sources || [])
    .map(s => s.firstSeen)
    .filter(Boolean)
    .sort();
  return dates[0] || lead.appliedDate || '';
}

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------
function escapeCSV(val) {
  const str = String(val == null ? '' : val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCSV(leads) {
  const headerRow = CSV_COLUMNS.map(c => escapeCSV(c.header)).join(',');
  const dataRows = leads.map(lead =>
    CSV_COLUMNS.map(c => escapeCSV(c.key(lead))).join(',')
  );
  return [headerRow, ...dataRows].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Excel generation
// ---------------------------------------------------------------------------
function buildExcel(leads, outputPath) {
  // Build array-of-arrays for sheet
  const headers = CSV_COLUMNS.map(c => c.header);
  const rows = leads.map(lead =>
    CSV_COLUMNS.map(c => {
      const val = c.key(lead);
      // Keep numbers as numbers for Excel
      if (typeof val === 'number') return val;
      return String(val == null ? '' : val);
    })
  );

  const wsData = [headers, ...rows];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-size columns
  const colWidths = headers.map((h, i) => {
    let maxLen = h.length;
    for (const row of rows) {
      const val = String(row[i] || '');
      maxLen = Math.max(maxLen, Math.min(val.length, 50));
    }
    return { wch: Math.max(maxLen + 2, 8) };
  });
  ws['!cols'] = colWidths;

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  // Auto-filter
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rows.length, c: headers.length - 1 },
    }),
  };

  // Add sheets — All leads, then per-tier
  XLSX.utils.book_append_sheet(wb, ws, 'All Leads');

  // Tier-specific sheets
  const tiers = [
    { name: 'T1 Hot - $5M+ New Custom', filter: l => l.tier === 1 },
    { name: 'T2 Warm - Major Remodel', filter: l => l.tier === 2 },
    { name: 'T3 Watch - Early Signal', filter: l => l.tier === 3 },
  ];

  for (const t of tiers) {
    const tierLeads = leads.filter(t.filter);
    if (tierLeads.length === 0) continue;

    const tierRows = tierLeads.map(lead =>
      CSV_COLUMNS.map(c => {
        const val = c.key(lead);
        if (typeof val === 'number') return val;
        return String(val == null ? '' : val);
      })
    );

    const tierWsData = [headers, ...tierRows];
    const tierWs = XLSX.utils.aoa_to_sheet(tierWsData);
    tierWs['!cols'] = colWidths;
    tierWs['!freeze'] = { xSplit: 0, ySplit: 1 };
    tierWs['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: tierRows.length, c: headers.length - 1 },
      }),
    };
    XLSX.utils.book_append_sheet(wb, tierWs, t.name);
  }

  XLSX.writeFile(wb, outputPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { inputFile, includeDropped } = parseArgs();

  if (!inputFile) {
    console.error('No input file specified and no full-run JSON found in data/output/');
    console.error('Usage: node scripts/build-full-report.js [input.json] [--include-dropped]');
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    process.exit(1);
  }

  console.log(`Reading: ${inputFile}`);
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

  // Support both { leads: [...] } and direct array
  let leads = [];
  if (Array.isArray(data)) {
    leads = data;
  } else if (data.leads) {
    leads = data.leads;
    if (includeDropped && data.dropped) {
      leads = [...leads, ...data.dropped];
    }
  } else {
    console.error('Unexpected JSON format — expected { leads: [...] } or an array');
    process.exit(1);
  }

  console.log(`Leads loaded: ${leads.length}`);

  if (leads.length === 0) {
    console.log('No leads to report.');
    return;
  }

  // Sort by tier asc, score desc
  leads.sort((a, b) => {
    const tierA = a.tier || 99;
    const tierB = b.tier || 99;
    if (tierA !== tierB) return tierA - tierB;
    return (b.score || 0) - (a.score || 0);
  });

  // Determine output paths
  const baseName = path.basename(inputFile, '.json');
  const csvPath = path.join(path.dirname(inputFile), `${baseName}.csv`);
  const xlsxPath = path.join(path.dirname(inputFile), `${baseName}.xlsx`);

  // Build CSV
  const csvContent = buildCSV(leads);
  fs.writeFileSync(csvPath, csvContent, 'utf8');
  console.log(`CSV written: ${csvPath}`);

  // Build Excel
  buildExcel(leads, xlsxPath);
  console.log(`Excel written: ${xlsxPath}`);

  // Summary
  const meta = data.meta || {};
  console.log('\n=== Report Summary ===');
  console.log(`Run date:     ${meta.runDate || 'unknown'}`);
  console.log(`Total leads:  ${leads.length}`);
  console.log(`Tier 1 (Hot — New custom home, ground-up or demo/rebuild, $5M+ assessed): ${leads.filter(l => l.tier === 1).length}`);
  console.log(`Tier 2 (Warm — Major remodel/addition, 3000+ SF, luxury amenities): ${leads.filter(l => l.tier === 2).length}`);
  console.log(`Tier 3 (Watch — Premium location, early-stage signals): ${leads.filter(l => l.tier === 3).length}`);
  if (includeDropped) {
    console.log(`Dropped:      ${leads.filter(l => l.tier === 0 || !l.tier).length}`);
  }
  console.log(`Columns:      ${CSV_COLUMNS.length}`);
  console.log(`\nFiles:`);
  console.log(`  ${csvPath}`);
  console.log(`  ${xlsxPath}`);
}

main();

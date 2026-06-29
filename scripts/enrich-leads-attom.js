// Enrich leads CSV with owner information from ATTOM Data API
// Usage: node scripts/enrich-leads-attom.js

const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
if (!ATTOM_API_KEY) {
  console.error('ATTOM_API_KEY not set in .env');
  process.exit(1);
}
const FIPS = '06059'; // Orange County
const BASE_URL = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const CSV_PATH = path.join(__dirname, '..', 'data', 'output', 'leads-03-18-26.csv');
const RESULTS_PATH = path.join(__dirname, '..', 'data', 'output', 'attom-owner-results.json');

// Parse CSV respecting quoted fields
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function escapeCSV(val) {
  if (!val) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function lookupAPN(apn) {
  const cleanApn = apn.replace(/-/g, '');
  const url = `${BASE_URL}/property/expandedprofile?apn=${cleanApn}&fips=${FIPS}`;

  try {
    const res = await fetch(url, {
      headers: { 'apikey': ATTOM_API_KEY, 'Accept': 'application/json' }
    });

    if (res.status !== 200) {
      return { apn, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    if (!data.property || data.property.length === 0) {
      return { apn, error: 'no property found' };
    }

    const p = data.property[0];
    const owner = p.assessment?.owner || {};
    const sale = p.sale || {};
    const addr = p.address || {};
    const summary = p.summary || {};
    const building = p.building || {};

    return {
      apn,
      fullAddress: addr.oneLine || '',
      ownerName: owner.owner1?.fullName || '',
      ownerType: owner.type || owner.description || '',
      corporateIndicator: owner.corporateIndicator || '',
      mailingAddress: owner.mailingAddressOneLine || '',
      absenteeOwner: owner.absenteeOwnerStatus === 'A' ? 'Yes' : 'No',
      sellerName: sale.sellerName || '',
      saleDate: sale.saleTransDate || '',
      saleAmount: sale.amount?.saleAmt || '',
      propertyType: summary.propertyType || summary.propType || '',
      yearBuilt: summary.yearBuilt || '',
      sqft: building.size?.livingsize || building.size?.universalsize || '',
      beds: building.rooms?.beds || '',
      baths: building.rooms?.bathstotal || '',
      assessedValue: p.assessment?.assessed?.assdTtlValue || '',
    };
  } catch (e) {
    return { apn, error: e.message };
  }
}

async function main() {
  // Parse CSV
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = csvText.split('\n').filter(l => l.trim());
  const header = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCSVLine(l));

  const apnIndex = header.indexOf('APN');
  console.log(`Loaded ${rows.length} leads, APN column index: ${apnIndex}`);

  // Extract unique APNs
  const uniqueAPNs = [...new Set(
    rows.map(r => r[apnIndex]).filter(a => a && /\d{3}-\d{3}-\d{2}/.test(a))
  )];
  console.log(`Unique APNs to look up: ${uniqueAPNs.length}\n`);

  // Load existing results if available (resume support)
  let ownerMap = {};
  if (fs.existsSync(RESULTS_PATH)) {
    ownerMap = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    const existing = Object.keys(ownerMap).length;
    if (existing > 0) console.log(`Resuming: ${existing} APNs already looked up\n`);
  }

  // Lookup each unique APN
  let count = 0;
  for (const apn of uniqueAPNs) {
    if (ownerMap[apn]) {
      console.log(`[${++count}/${uniqueAPNs.length}] ${apn}: CACHED — ${ownerMap[apn].ownerName || ownerMap[apn].error}`);
      continue;
    }

    const result = await lookupAPN(apn);
    ownerMap[apn] = result;
    count++;

    if (result.error) {
      console.log(`[${count}/${uniqueAPNs.length}] ${apn}: ERROR — ${result.error}`);
    } else {
      console.log(`[${count}/${uniqueAPNs.length}] ${apn}: ${result.ownerName || 'no owner'} | ${result.fullAddress}`);
    }

    // Save progress after each lookup
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(ownerMap, null, 2));

    // Small delay to be respectful to the API
    await new Promise(r => setTimeout(r, 300));
  }

  // Update CSV with new columns
  const newColumns = ['Full Address', 'Owner Name', 'Owner Type', 'Mailing Address', 'Absentee Owner', 'Seller Name', 'Sale Date', 'Sale Amount'];
  const newHeader = header.map(escapeCSV).join(',') + ',' + newColumns.join(',');

  const newRows = rows.map(row => {
    const apn = row[apnIndex];
    const data = ownerMap[apn] || {};
    const enrichment = [
      data.fullAddress || '',
      data.ownerName || '',
      data.ownerType || '',
      data.mailingAddress || '',
      data.absenteeOwner || '',
      data.sellerName || '',
      data.saleDate || '',
      data.saleAmount || '',
    ];
    return row.map(escapeCSV).join(',') + ',' + enrichment.map(escapeCSV).join(',');
  });

  const updatedCSV = newHeader + '\n' + newRows.join('\n') + '\n';
  fs.writeFileSync(CSV_PATH, updatedCSV);

  // Summary
  const found = Object.values(ownerMap).filter(v => v.ownerName).length;
  const errors = Object.values(ownerMap).filter(v => v.error).length;
  console.log(`\n====== COMPLETE ======`);
  console.log(`Looked up: ${uniqueAPNs.length} APNs`);
  console.log(`Owner found: ${found}`);
  console.log(`Errors/no data: ${errors}`);
  console.log(`CSV updated: ${CSV_PATH}`);
  console.log(`Results JSON: ${RESULTS_PATH}`);
}

// CLI-only: guard so the orchestrator can require() this without auto-running
// main() (which would parse the orchestrator's argv / touch the CSV on import).
if (require.main === module) main().catch(console.error);

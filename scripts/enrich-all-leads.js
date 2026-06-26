// Enrich ALL leads with ATTOM Data — by APN or by address
// Handles: APN-based lookups, address-based lookups, retries
const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
if (!ATTOM_API_KEY) {
  console.error('ATTOM_API_KEY not set in .env');
  process.exit(1);
}
const FIPS = '06059';
const BASE_URL = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const CSV_PATH = path.join(__dirname, '..', 'data', 'output', 'leads-03-18-26.csv');
const RESULTS_PATH = path.join(__dirname, '..', 'data', 'output', 'attom-owner-results.json');

function parseCSVLine(line) {
  const fields = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = '';
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function extractOwnerData(p) {
  const owner = p.assessment?.owner || {};
  const sale = p.sale || {};
  const addr = p.address || {};
  const summary = p.summary || {};
  const building = p.building || {};
  return {
    fullAddress: addr.oneLine || '',
    ownerName: owner.owner1?.fullName || '',
    ownerType: owner.type || owner.description || '',
    corporateIndicator: owner.corporateIndicator || '',
    mailingAddress: owner.mailingAddressOneLine || '',
    absenteeOwner: owner.absenteeOwnerStatus === 'A' ? 'Yes' : 'No',
    buyerName: sale.buyerName || '',
    saleDate: sale.saleTransDate || '',
    saleAmount: sale.amount?.saleAmt || '',
    propertyType: summary.propertyType || summary.propType || '',
    yearBuilt: summary.yearBuilt || '',
    sqft: building.size?.livingsize || building.size?.universalsize || '',
    beds: building.rooms?.beds || '',
    baths: building.rooms?.bathstotal || '',
    assessedValue: p.assessment?.assessed?.assdTtlValue || '',
  };
}

async function attomFetch(endpoint) {
  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    headers: { 'apikey': ATTOM_API_KEY, 'Accept': 'application/json' }
  });
  return { status: res.status, data: await res.json() };
}

async function lookupByAPN(apn) {
  const formats = [apn, apn.replace(/-/g, '')];
  for (const fmt of formats) {
    try {
      const { status, data } = await attomFetch(`property/expandedprofile?apn=${encodeURIComponent(fmt)}&fips=${FIPS}`);
      if (status === 200 && data.property?.length > 0) {
        return extractOwnerData(data.property[0]);
      }
    } catch {}
  }
  return null;
}

async function lookupByAddress(address, city, state = 'CA') {
  // Parse the address - might be "22 MANN ST, IRVINE, CA 92612" or "2520, Costa Mesa, CA"
  // Extract the street part (before the city)
  let street = address;
  let lookupCity = city;

  // Handle format: "22 MANN ST, IRVINE, CA 92612"
  const parts = address.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    street = parts[0];
    // If the address contains the city, use it
    const cityPart = parts[1];
    if (cityPart && !cityPart.match(/^\s*CA\s*$/i)) {
      lookupCity = cityPart.replace(/\s+CA\s*$/i, '').trim();
    }
  }

  // Skip if street is just a number (partial address like "2520")
  if (/^\d+$/.test(street.trim())) return null;

  try {
    const addr1 = encodeURIComponent(street);
    const addr2 = encodeURIComponent(`${lookupCity}, ${state}`);
    const { status, data } = await attomFetch(`property/expandedprofile?address1=${addr1}&address2=${addr2}`);
    if (status === 200 && data.property?.length > 0) {
      return extractOwnerData(data.property[0]);
    }
  } catch {}
  return null;
}

async function main() {
  // Parse CSV
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = csvText.split('\n').filter(l => l.trim());
  const headerFields = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCSVLine(l));

  // Find column indices — handle both original and already-enriched CSV
  const cityIdx = headerFields.indexOf('City');
  const addrIdx = headerFields.indexOf('Address');
  const apnIdx = headerFields.indexOf('APN');

  // Check if CSV already has enrichment columns
  const ownerColIdx = headerFields.indexOf('Owner Name');
  const hasEnrichment = ownerColIdx !== -1;

  console.log(`Loaded ${rows.length} leads`);
  console.log(`City col: ${cityIdx}, Address col: ${addrIdx}, APN col: ${apnIdx}`);
  console.log(`Already enriched: ${hasEnrichment}`);

  // Load existing results
  let ownerMap = {};
  if (fs.existsSync(RESULTS_PATH)) {
    ownerMap = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  }

  // Build a set of unique lookup keys (APN or address)
  const lookups = [];
  const seen = new Set();

  for (const row of rows) {
    const apn = row[apnIdx] || '';
    const address = row[addrIdx] || '';
    const city = row[cityIdx] || '';
    const hasAPN = /\d{3}-\d{3}-\d{2}/.test(apn);

    if (hasAPN) {
      if (!seen.has(apn)) {
        seen.add(apn);
        // Only re-lookup if failed or missing
        if (!ownerMap[apn] || ownerMap[apn].error) {
          lookups.push({ type: 'apn', key: apn, apn, address, city });
        }
      }
    } else {
      // Use address as key
      const addrKey = `addr:${address}|${city}`;
      if (!seen.has(addrKey)) {
        seen.add(addrKey);
        if (!ownerMap[addrKey]) {
          lookups.push({ type: 'address', key: addrKey, apn, address, city });
        }
      }
    }
  }

  console.log(`\nNew lookups needed: ${lookups.length}`);
  console.log(`  APN-based: ${lookups.filter(l => l.type === 'apn').length}`);
  console.log(`  Address-based: ${lookups.filter(l => l.type === 'address').length}`);
  console.log(`  Already cached: ${Object.keys(ownerMap).length}\n`);

  // Process lookups
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < lookups.length; i++) {
    const lookup = lookups[i];
    const progress = `[${i + 1}/${lookups.length}]`;

    let result = null;
    if (lookup.type === 'apn') {
      result = await lookupByAPN(lookup.apn);
    } else {
      result = await lookupByAddress(lookup.address, lookup.city);
    }

    if (result && (result.ownerName || result.fullAddress)) {
      ownerMap[lookup.key] = { ...result, lookupType: lookup.type };
      console.log(`${progress} ${lookup.key}: ${result.ownerName || 'no owner'} | ${result.fullAddress}`);
      successCount++;
    } else {
      ownerMap[lookup.key] = { error: 'not found', lookupType: lookup.type, address: lookup.address, city: lookup.city };
      console.log(`${progress} ${lookup.key}: NOT FOUND`);
      failCount++;
    }

    // Save progress
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(ownerMap, null, 2));

    // Rate limiting
    await new Promise(r => setTimeout(r, 250));
  }

  // Rebuild CSV with enrichment columns
  // Use original columns (strip old enrichment columns if present)
  const originalCols = hasEnrichment
    ? headerFields.slice(0, headerFields.indexOf('Full Address') !== -1 ? headerFields.indexOf('Full Address') : headerFields.length)
    : headerFields;

  const newColumns = ['Full Address', 'Owner Name', 'Owner Type', 'Mailing Address', 'Absentee Owner', 'Buyer Name', 'Sale Date', 'Sale Amount'];
  const newHeader = originalCols.map(escapeCSV).join(',') + ',' + newColumns.join(',');

  const newRows = rows.map(row => {
    const apn = row[apnIdx] || '';
    const address = row[addrIdx] || '';
    const city = row[cityIdx] || '';
    const hasAPN = /\d{3}-\d{3}-\d{2}/.test(apn);

    // Find the matching owner data
    let data;
    if (hasAPN) {
      data = ownerMap[apn] || {};
    } else {
      data = ownerMap[`addr:${address}|${city}`] || {};
    }

    const originalFields = hasEnrichment
      ? row.slice(0, headerFields.indexOf('Full Address') !== -1 ? headerFields.indexOf('Full Address') : headerFields.length)
      : row;

    const enrichment = [
      data.fullAddress || '',
      data.ownerName || '',
      data.ownerType || '',
      data.mailingAddress || '',
      data.absenteeOwner || '',
      data.buyerName || '',
      data.saleDate || '',
      data.saleAmount || '',
    ];

    return originalFields.map(escapeCSV).join(',') + ',' + enrichment.map(escapeCSV).join(',');
  });

  const updatedCSV = newHeader + '\n' + newRows.join('\n') + '\n';
  fs.writeFileSync(CSV_PATH, updatedCSV);

  // Final summary
  const totalWithOwner = Object.values(ownerMap).filter(v => v.ownerName).length;
  const totalFailed = Object.values(ownerMap).filter(v => v.error).length;
  console.log(`\n====== ENRICHMENT COMPLETE ======`);
  console.log(`New lookups: ${lookups.length} (${successCount} found, ${failCount} failed)`);
  console.log(`Total cached: ${Object.keys(ownerMap).length}`);
  console.log(`Total with owner: ${totalWithOwner}`);
  console.log(`Total failed: ${totalFailed}`);
  console.log(`CSV updated: ${CSV_PATH}`);
}

main().catch(console.error);

// Skip trace all leads via BatchData API — get phone numbers and emails
// Reads leads CSV + ATTOM owner results, calls BatchData skip-trace, updates CSV
const fs = require('fs');
const path = require('path');
require('../agents/shared/load-env').loadEnv();

const BATCHDATA_API_KEY = process.env.BATCHDATA_API_KEY;
if (!BATCHDATA_API_KEY) {
  console.error('BATCHDATA_API_KEY not set in .env');
  process.exit(1);
}
const BASE_URL = 'https://api.batchdata.com/api/v1';
const CSV_PATH = path.join(__dirname, '..', 'data', 'output', 'leads-03-18-26.csv');
const ATTOM_PATH = path.join(__dirname, '..', 'data', 'output', 'attom-owner-results.json');
const SKIP_TRACE_PATH = path.join(__dirname, '..', 'data', 'output', 'skip-trace-results.json');

// BatchData allows up to 100 per request, but we'll do smaller batches for reliability
const BATCH_SIZE = 10;

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

// Parse a full address like "2520 ANDOVER PL, COSTA MESA, CA 92626" into components
function parseFullAddress(fullAddr) {
  if (!fullAddr) return null;
  const parts = fullAddr.split(',').map(s => s.trim());
  if (parts.length < 2) return null;

  const street = parts[0];
  const city = parts.length >= 3 ? parts[1] : parts[1].replace(/\s+(CA|ca)\s+\d{5}.*$/, '').trim();
  const stateZip = parts.length >= 3 ? parts[2] : parts[1];
  const zipMatch = stateZip.match(/(\d{5})/);
  const zip = zipMatch ? zipMatch[1] : '';

  return { street, city, state: 'CA', zip };
}

async function skipTraceBatch(addresses) {
  const requests = addresses.map(a => ({ propertyAddress: a }));
  const res = await fetch(`${BASE_URL}/property/skip-trace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`
    },
    body: JSON.stringify({ requests })
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`BatchData API error ${res.status}: ${text}`);
  }

  return await res.json();
}

function extractContactInfo(person) {
  if (!person || !person.meta?.matched) return null;

  // Get best phone numbers (sorted by score, prefer mobile)
  const phones = (person.phoneNumbers || [])
    .filter(p => p.number)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const mobilePhones = phones.filter(p => p.type === 'Mobile');
  const landlinePhones = phones.filter(p => p.type === 'Land Line');

  // Get emails
  const emails = (person.emails || [])
    .filter(e => e.email)
    .map(e => e.email);

  // Owner name from skip trace
  const name = person.name?.full || '';

  // Mailing address from skip trace
  const mailing = person.mailingAddress;
  const mailingStr = mailing
    ? `${mailing.street || ''}, ${mailing.city || ''}, ${mailing.state || ''} ${mailing.zip || ''}`.trim()
    : '';

  return {
    skipTraceName: name,
    phone1: phones[0]?.number || '',
    phone1Type: phones[0]?.type || '',
    phone1DNC: phones[0]?.dnc ? 'Yes' : 'No',
    phone2: phones[1]?.number || '',
    phone2Type: phones[1]?.type || '',
    phone3: phones[2]?.number || '',
    phone3Type: phones[2]?.type || '',
    email1: emails[0] || '',
    email2: emails[1] || '',
    email3: emails[2] || '',
    skipMailingAddress: mailingStr,
    litigator: person.litigator ? 'Yes' : 'No',
    deceased: person.death?.deceased ? 'Yes' : 'No',
  };
}

// Format phone number for display
function formatPhone(num) {
  if (!num || num.length !== 10) return num || '';
  return `(${num.slice(0, 3)}) ${num.slice(3, 6)}-${num.slice(6)}`;
}

async function main() {
  // Load CSV
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = csvText.split('\n').filter(l => l.trim());
  const headerFields = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCSVLine(l));

  // Column indices
  const cityIdx = headerFields.indexOf('City');
  const addrIdx = headerFields.indexOf('Address');
  const apnIdx = headerFields.indexOf('APN');
  const fullAddrIdx = headerFields.indexOf('Full Address');
  const ownerIdx = headerFields.indexOf('Owner Name');

  // Load ATTOM owner data for full addresses
  const ownerMap = fs.existsSync(ATTOM_PATH)
    ? JSON.parse(fs.readFileSync(ATTOM_PATH, 'utf8'))
    : {};

  // Load existing skip trace results (resume support)
  let skipResults = {};
  if (fs.existsSync(SKIP_TRACE_PATH)) {
    skipResults = JSON.parse(fs.readFileSync(SKIP_TRACE_PATH, 'utf8'));
    console.log(`Resuming: ${Object.keys(skipResults).length} already skip-traced\n`);
  }

  // Build list of addresses to skip trace
  const toTrace = [];
  const seen = new Set();

  for (const row of rows) {
    const apn = row[apnIdx] || '';
    const address = row[addrIdx] || '';
    const city = row[cityIdx] || '';
    const fullAddr = row[fullAddrIdx] || '';

    // Skip rows without meaningful data (like empty/duplicate rows)
    if (!city && !fullAddr && !address) continue;

    // Determine the full address to use
    let resolvedAddr = fullAddr;
    if (!resolvedAddr) {
      // Check ATTOM data
      const hasAPN = /\d{3}-\d{3}-\d{2}/.test(apn);
      const ownerData = hasAPN ? ownerMap[apn] : ownerMap[`addr:${address}|${city}`];
      resolvedAddr = ownerData?.fullAddress || '';
    }

    if (!resolvedAddr) continue;

    // Create a unique key
    const key = resolvedAddr.toUpperCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key) || skipResults[key]) continue;
    seen.add(key);

    const parsed = parseFullAddress(resolvedAddr);
    if (parsed && parsed.street) {
      toTrace.push({ key, ...parsed });
    }
  }

  console.log(`Total leads: ${rows.length}`);
  console.log(`Already skip-traced: ${Object.keys(skipResults).length}`);
  console.log(`New to skip trace: ${toTrace.length}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  if (toTrace.length === 0) {
    console.log('Nothing new to skip trace.');
  } else {
    // Process in batches
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < toTrace.length; i += BATCH_SIZE) {
      const batch = toTrace.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toTrace.length / BATCH_SIZE);

      console.log(`\n--- Batch ${batchNum}/${totalBatches} (${batch.length} addresses) ---`);

      try {
        const addresses = batch.map(b => ({
          street: b.street,
          city: b.city,
          state: b.state,
          zip: b.zip
        }));

        const response = await skipTraceBatch(addresses);
        const persons = response.results?.persons || [];

        for (let j = 0; j < batch.length; j++) {
          const entry = batch[j];
          const person = persons[j];
          const contact = extractContactInfo(person);

          if (contact && (contact.phone1 || contact.email1)) {
            skipResults[entry.key] = contact;
            console.log(`  ${entry.street}: ${contact.skipTraceName} | ${formatPhone(contact.phone1)} (${contact.phone1Type}) | ${contact.email1}`);
            successCount++;
          } else {
            skipResults[entry.key] = { error: 'no contact info', skipTraceName: person?.name?.full || '' };
            console.log(`  ${entry.street}: NO CONTACT INFO`);
            failCount++;
          }
        }
      } catch (e) {
        console.error(`  Batch error: ${e.message}`);
        // Mark all in batch as failed
        for (const entry of batch) {
          skipResults[entry.key] = { error: e.message };
          failCount++;
        }
      }

      // Save progress after each batch
      fs.writeFileSync(SKIP_TRACE_PATH, JSON.stringify(skipResults, null, 2));

      // Rate limiting between batches
      if (i + BATCH_SIZE < toTrace.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`\n====== SKIP TRACE COMPLETE ======`);
    console.log(`Found contacts: ${successCount}`);
    console.log(`No contacts: ${failCount}`);
  }

  // Rebuild CSV with skip trace columns
  // Determine original columns (strip any existing skip trace columns)
  const skipTraceStart = headerFields.indexOf('Phone 1');
  const originalCols = skipTraceStart !== -1 ? headerFields.slice(0, skipTraceStart) : headerFields;

  const newColumns = [
    'Phone 1', 'Phone 1 Type', 'Phone 1 DNC',
    'Phone 2', 'Phone 2 Type',
    'Phone 3', 'Phone 3 Type',
    'Email 1', 'Email 2', 'Email 3',
    'Skip Trace Name', 'Skip Mailing Address',
    'Litigator', 'Deceased'
  ];

  const newHeader = originalCols.map(escapeCSV).join(',') + ',' + newColumns.join(',');

  const newRows = rows.map(row => {
    const fullAddr = row[fullAddrIdx] || '';
    const apn = row[apnIdx] || '';
    const address = row[addrIdx] || '';
    const city = row[cityIdx] || '';

    // Find the full address
    let resolvedAddr = fullAddr;
    if (!resolvedAddr) {
      const hasAPN = /\d{3}-\d{3}-\d{2}/.test(apn);
      const ownerData = hasAPN ? ownerMap[apn] : ownerMap[`addr:${address}|${city}`];
      resolvedAddr = ownerData?.fullAddress || '';
    }

    const key = resolvedAddr.toUpperCase().replace(/\s+/g, ' ').trim();
    const data = skipResults[key] || {};

    const originalFields = skipTraceStart !== -1 ? row.slice(0, skipTraceStart) : row;

    const enrichment = [
      formatPhone(data.phone1),
      data.phone1Type || '',
      data.phone1DNC || '',
      formatPhone(data.phone2),
      data.phone2Type || '',
      formatPhone(data.phone3),
      data.phone3Type || '',
      data.email1 || '',
      data.email2 || '',
      data.email3 || '',
      data.skipTraceName || '',
      data.skipMailingAddress || '',
      data.litigator || '',
      data.deceased || '',
    ];

    return originalFields.map(escapeCSV).join(',') + ',' + enrichment.map(escapeCSV).join(',');
  });

  const updatedCSV = newHeader + '\n' + newRows.join('\n') + '\n';
  fs.writeFileSync(CSV_PATH, updatedCSV);

  // Final summary
  const totalWithPhone = Object.values(skipResults).filter(v => v.phone1).length;
  const totalWithEmail = Object.values(skipResults).filter(v => v.email1).length;
  const totalFailed = Object.values(skipResults).filter(v => v.error).length;
  console.log(`\nTotal with phone: ${totalWithPhone}`);
  console.log(`Total with email: ${totalWithEmail}`);
  console.log(`Total no contact: ${totalFailed}`);
  console.log(`CSV updated: ${CSV_PATH}`);
  console.log(`Results cached: ${SKIP_TRACE_PATH}`);
}

main().catch(console.error);

const path = require('path');
const config = require('./config');

const DEBUG_DIR = path.resolve(__dirname, '../../artifacts/debug');

/**
 * Take a debug screenshot on error.
 */
async function debugScreenshot(page, name) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(DEBUG_DIR, `recorder-${name}-${Date.now()}.png`),
      fullPage: true,
    });
  } catch { /* ignore screenshot errors */ }
}

/**
 * Normalize text for comparison.
 */
function normalize(text) {
  return String(text || '').toLowerCase().trim();
}

/**
 * Format a date as MM/DD/YYYY for form input.
 */
function formatDateForInput(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Parse a date to YYYY-MM-DD.
 */
function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).trim());
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Parse dollar amount from text.
 */
function parseAmount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Get cutoff date for lookback period.
 */
function getCutoffDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d;
}

/**
 * Navigate to RecorderWorks and perform a document search.
 *
 * @param {import('playwright').Page} page
 * @param {object} options
 * @param {string} options.docType - Document type search term (e.g. "DEED OF TRUST")
 * @param {Date} options.fromDate - Start date for search
 * @param {Date} options.toDate - End date for search
 * @returns {Promise<object[]>} Raw document records
 */
async function searchDocuments(page, options) {
  const { docType, fromDate, toDate } = options;
  const results = [];

  console.log(`  Searching for "${docType}" from ${formatDateForInput(fromDate)} to ${formatDateForInput(toDate)}...`);

  // Navigate to portal
  await page.goto(config.portal.searchUrl, {
    timeout: config.browser.timeout,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(config.search.waitAfterNav);

  // RecorderWorks typically has a search form with:
  // - Document type field
  // - Date range fields
  // - Name fields (grantor/grantee)
  // Try multiple approaches to fill the search form

  const filled = await fillSearchForm(page, docType, fromDate, toDate);
  if (!filled) {
    console.log(`  Could not fill search form, trying alternate approaches...`);
    await debugScreenshot(page, `form-not-found-${docType.replace(/\s+/g, '-')}`);

    // Try navigating with URL parameters if the portal supports it
    const searchParams = new URLSearchParams({
      doctype: docType,
      fromdate: formatDateForInput(fromDate),
      todate: formatDateForInput(toDate),
    });
    await page.goto(`${config.portal.searchUrl}?${searchParams.toString()}`, {
      timeout: config.browser.timeout,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.search.waitForSearch);
  }

  // Parse results from the page
  const parsed = await parseDocumentResults(page);
  results.push(...parsed);

  // Handle pagination
  let pageNum = 1;
  while (results.length < config.search.maxResults) {
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;

    pageNum++;
    await page.waitForTimeout(config.search.waitBetweenPages);
    const moreResults = await parseDocumentResults(page);
    if (moreResults.length === 0) break;

    results.push(...moreResults);
    process.stdout.write(`\r  Page ${pageNum}: ${results.length} total records`);
  }

  if (pageNum > 1) console.log('');
  return results;
}

/**
 * Try to fill the RecorderWorks search form.
 */
async function fillSearchForm(page, docType, fromDate, toDate) {
  // Approach 1: Look for named/labeled fields
  const approaches = [
    // Standard form field names
    async () => {
      const docTypeInput = page.locator(
        'input[name*="doctype" i], input[name*="doc_type" i], input[name*="DocumentType" i], ' +
        'select[name*="doctype" i], select[name*="doc_type" i], select[name*="DocumentType" i], ' +
        'input[id*="doctype" i], input[id*="DocumentType" i]'
      ).first();

      if (await docTypeInput.count() === 0) return false;

      const tagName = await docTypeInput.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        // Try to select matching option
        const options = await docTypeInput.locator('option').allTextContents();
        const matchIdx = options.findIndex(o => normalize(o).includes(normalize(docType)));
        if (matchIdx >= 0) {
          await docTypeInput.selectOption({ index: matchIdx });
        }
      } else {
        await docTypeInput.fill(docType);
      }

      // Fill date fields
      await fillDateFields(page, fromDate, toDate);

      // Submit
      await submitSearchForm(page);
      return true;
    },

    // Search by label text
    async () => {
      // Look for a label containing "Document Type" near an input
      const labels = page.locator('label');
      const labelCount = await labels.count();

      for (let i = 0; i < labelCount; i++) {
        const text = await labels.nth(i).innerText();
        if (normalize(text).includes('document type') || normalize(text).includes('doc type')) {
          const forId = await labels.nth(i).getAttribute('for');
          if (forId) {
            const input = page.locator(`#${forId}`);
            if (await input.count() > 0) {
              await input.fill(docType);
              await fillDateFields(page, fromDate, toDate);
              await submitSearchForm(page);
              return true;
            }
          }
        }
      }
      return false;
    },

    // Generic text inputs approach
    async () => {
      const inputs = page.locator('input[type="text"]:visible');
      const inputCount = await inputs.count();
      if (inputCount < 1) return false;

      // Fill first visible text input with doc type
      await inputs.first().fill(docType);
      await fillDateFields(page, fromDate, toDate);
      await submitSearchForm(page);
      return true;
    },
  ];

  for (const approach of approaches) {
    try {
      const success = await approach();
      if (success) {
        await page.waitForTimeout(config.search.waitForSearch);
        return true;
      }
    } catch { /* try next */ }
  }

  return false;
}

/**
 * Fill date range fields on the search form.
 */
async function fillDateFields(page, fromDate, toDate) {
  const fromStr = formatDateForInput(fromDate);
  const toStr = formatDateForInput(toDate);

  // Try various date field selectors
  const fromSelectors = [
    'input[name*="fromdate" i]', 'input[name*="from_date" i]',
    'input[name*="startdate" i]', 'input[name*="start_date" i]',
    'input[name*="begindate" i]', 'input[name*="DateFrom" i]',
    'input[id*="fromdate" i]', 'input[id*="startdate" i]',
    'input[type="date"]:first-of-type',
    'input[placeholder*="from" i]', 'input[placeholder*="start" i]',
  ];

  const toSelectors = [
    'input[name*="todate" i]', 'input[name*="to_date" i]',
    'input[name*="enddate" i]', 'input[name*="end_date" i]',
    'input[name*="DateTo" i]',
    'input[id*="todate" i]', 'input[id*="enddate" i]',
    'input[type="date"]:last-of-type',
    'input[placeholder*="to" i]', 'input[placeholder*="end" i]',
  ];

  for (const sel of fromSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.fill(fromStr);
        break;
      }
    } catch { /* next */ }
  }

  for (const sel of toSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.fill(toStr);
        break;
      }
    } catch { /* next */ }
  }
}

/**
 * Submit the search form.
 */
async function submitSearchForm(page) {
  const submitSelectors = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Search")', 'button:has-text("Find")',
    'input[value="Search" i]', 'input[value="Submit" i]',
    'a:has-text("Search")', '#btnSearch', '#searchButton',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        await btn.click();
        return;
      }
    } catch { /* next */ }
  }

  // Fallback: press Enter
  await page.keyboard.press('Enter');
}

/**
 * Parse document records from the current results page.
 */
async function parseDocumentResults(page) {
  const results = [];

  // Strategy 1: Table-based results (most common for recorder portals)
  const tableRows = page.locator('table tbody tr, table.results tr, .grid tr, #results tr').filter({
    hasNot: page.locator('th'),
  });
  const rowCount = await tableRows.count();

  if (rowCount > 0) {
    for (let i = 0; i < rowCount; i++) {
      try {
        const row = tableRows.nth(i);
        const cells = await row.locator('td').allTextContents();
        if (cells.length < 2) continue;

        const record = parseDocumentRow(cells);
        if (record) {
          // Try to get link from the row
          const link = row.locator('a').first();
          if (await link.count() > 0) {
            const href = await link.getAttribute('href');
            if (href) {
              record.url = href.startsWith('http') ? href : `${config.portal.baseUrl}${href}`;
            }
          }
          results.push(record);
        }
      } catch { /* skip bad rows */ }
    }
    return results;
  }

  // Strategy 2: List/card-based results
  const items = page.locator('.result-item, .document-item, .record-item, [class*="result"], [class*="record"]');
  const itemCount = await items.count();

  if (itemCount > 0) {
    for (let i = 0; i < itemCount; i++) {
      try {
        const item = items.nth(i);
        const text = await item.innerText();
        const record = parseDocumentText(text);
        if (record) results.push(record);
      } catch { /* skip */ }
    }
    return results;
  }

  // Strategy 3: Full page text scrape
  const pageText = await page.locator('body').innerText();
  // Look for recording numbers pattern (year-xxxxxxx)
  const docMatches = pageText.match(/20\d{2}[-]\d{5,9}/g) || [];
  if (docMatches.length > 0) {
    console.log(`  Found ${docMatches.length} document numbers in page text`);
    for (const docNum of [...new Set(docMatches)]) {
      results.push({
        source: 'recorder',
        documentType: 'Unknown',
        recordingDate: null,
        documentNumber: docNum,
        grantor: '',
        grantee: '',
        address: '',
        apn: '',
        amount: null,
        url: config.portal.searchUrl,
      });
    }
  }

  return results;
}

/**
 * Parse a table row into a document record.
 * Adapts to common recorder portal column layouts.
 */
function parseDocumentRow(cells) {
  if (cells.length < 2) return null;

  // Common layouts:
  // [DocNum, RecDate, DocType, Grantor, Grantee, Pages]
  // [RecDate, DocNum, DocType, Pages, Grantor, Grantee]
  // [DocNum, DocType, RecDate, Grantor, Grantee, Amount]

  // Detect layout by finding the date column and doc number column
  let docNumber = '';
  let recordingDate = null;
  let documentType = '';
  let grantor = '';
  let grantee = '';
  let amount = null;
  let apn = '';

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i].trim();
    const lower = cell.toLowerCase();

    // Document number: typically year-digits format
    if (!docNumber && /20\d{2}[-]\d{4,9}/.test(cell)) {
      docNumber = cell.match(/20\d{2}[-]\d{4,9}/)[0];
      continue;
    }

    // Date: various formats
    if (!recordingDate) {
      const d = parseDate(cell);
      if (d) {
        recordingDate = d;
        continue;
      }
    }

    // Document type: contains known keywords
    if (!documentType && (
      lower.includes('deed') || lower.includes('trust') ||
      lower.includes('notice') || lower.includes('grant') ||
      lower.includes('lien') || lower.includes('mortgage')
    )) {
      documentType = cell;
      continue;
    }

    // Amount: dollar value
    if (amount === null && /\$[\d,]+/.test(cell)) {
      amount = parseAmount(cell);
      continue;
    }

    // APN: parcel number pattern
    if (!apn && /\d{3}[-]\d{3}[-]\d{2}/.test(cell)) {
      apn = cell.match(/\d{3}[-]\d{3}[-]\d{2}/)[0];
      continue;
    }
  }

  // Assign remaining cells to grantor/grantee
  const unassigned = cells.filter(c => {
    const t = c.trim();
    return t &&
      t !== docNumber &&
      t !== recordingDate &&
      t !== documentType &&
      !(/\$[\d,]+/.test(t)) &&
      !(/\d{3}[-]\d{3}[-]\d{2}/.test(t)) &&
      !parseDate(t);
  });

  if (unassigned.length >= 2) {
    grantor = unassigned[0].trim();
    grantee = unassigned[1].trim();
  } else if (unassigned.length === 1) {
    grantor = unassigned[0].trim();
  }

  if (!docNumber && !documentType) return null;

  return {
    source: 'recorder',
    documentType: documentType || 'Unknown',
    recordingDate: recordingDate,
    documentNumber: docNumber || '',
    grantor: grantor,
    grantee: grantee,
    address: '', // Recorder records rarely have address, need APN cross-ref
    apn: apn,
    amount: amount,
    url: config.portal.searchUrl,
  };
}

/**
 * Parse a document record from free-form text.
 */
function parseDocumentText(text) {
  const docNumMatch = text.match(/(?:doc(?:ument)?\.?\s*(?:no|num|number|#)?[:\s]*)?(20\d{2}[-]\d{4,9})/i);
  if (!docNumMatch) return null;

  return {
    source: 'recorder',
    documentType: extractField(text, /(?:doc(?:ument)?\s*type|type)[:\s]+([^\n,]+)/i) || '',
    recordingDate: extractDateFromText(text),
    documentNumber: docNumMatch[1],
    grantor: extractField(text, /(?:grantor|from)[:\s]+([^\n,]+)/i) || '',
    grantee: extractField(text, /(?:grantee|to)[:\s]+([^\n,]+)/i) || '',
    address: extractField(text, /(?:address|property|location)[:\s]+([^\n]+)/i) || '',
    apn: extractApn(text) || '',
    amount: parseAmount(extractField(text, /(?:amount|consideration|\$)([\d,$]+)/i)) || null,
    url: config.portal.searchUrl,
  };
}

/**
 * Navigate to the next page of results.
 * @returns {boolean} true if navigation occurred
 */
async function goToNextPage(page) {
  const nextSelectors = [
    'a:has-text("Next")', 'a:has-text(">")', 'button:has-text("Next")',
    '.pagination a.next', '.pager a.next', 'a.next-page',
    'input[value="Next"]', '[aria-label="Next page"]',
    'a[title="Next page"]', 'a[title="Click to go to next page"]',
  ];

  for (const sel of nextSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click();
        return true;
      }
    } catch { /* next */ }
  }

  return false;
}

// --- Utility functions ---

function extractField(text, regex) {
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function extractDateFromText(text) {
  const patterns = [
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\w+\s+\d{1,2},?\s+\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return parseDate(match[1]);
  }
  return null;
}

function extractApn(text) {
  const match = text.match(/(?:APN|parcel)[:\s#]*(\d{3}[-]\d{3}[-]\d{2})/i) ||
                text.match(/(\d{3}[-]\d{3}[-]\d{2})/);
  return match ? match[1] : '';
}

/**
 * Search for all target document types across the lookback period.
 *
 * @param {import('playwright').Page} page
 * @param {object} options
 * @param {number} [options.daysBack=90]
 * @param {string[]} [options.types] - Specific doc type keys to search (default: all)
 * @returns {Promise<object[]>} All document records
 */
async function searchAllDocumentTypes(page, options = {}) {
  const { daysBack = config.search.defaultDaysBack, types } = options;
  const fromDate = getCutoffDate(daysBack);
  const toDate = new Date();
  const allResults = [];

  const typeKeys = types || Object.keys(config.documentTypes);

  for (const typeKey of typeKeys) {
    const docTypeConfig = config.documentTypes[typeKey];
    if (!docTypeConfig) {
      console.log(`  Unknown document type: ${typeKey}, skipping`);
      continue;
    }

    for (const searchTerm of docTypeConfig.searchTerms) {
      try {
        console.log(`\n--- ${docTypeConfig.label} ---`);
        const results = await searchDocuments(page, {
          docType: searchTerm,
          fromDate,
          toDate,
        });

        // Tag results with the document type category
        const tagged = results.map(r => ({
          ...r,
          documentType: r.documentType || docTypeConfig.label,
          _typeKey: typeKey,
          _leadQuality: docTypeConfig.leadQuality,
        }));

        allResults.push(...tagged);
        console.log(`  ${docTypeConfig.label}: ${results.length} records`);
      } catch (err) {
        console.error(`  Error searching ${docTypeConfig.label}: ${err.message}`);
        await debugScreenshot(page, `search-error-${typeKey}`);
      }

      // Pause between different search types
      await page.waitForTimeout(config.search.waitBetweenSearches);
    }
  }

  return allResults;
}

/**
 * Filter construction-related Deeds of Trust.
 * Most DOTs are regular mortgages; we want construction loans.
 */
function filterConstructionDOTs(results) {
  return results.filter(r => {
    if (r._typeKey !== 'construction-dot') return true; // Pass non-DOT records through

    const keywords = config.documentTypes['construction-dot'].constructionKeywords;
    const text = normalize([r.documentType, r.grantor, r.grantee].join(' '));

    // Check for construction loan indicators
    // Construction DOTs often have construction lenders or specific keywords
    return keywords.some(kw => text.includes(kw)) ||
      // High amount (>$500k) DOTs in our target cities are worth flagging
      (r.amount && r.amount >= 500000);
  });
}

/**
 * Filter trust/LLC transfers to identify wealth structuring.
 */
function filterTrustTransfers(results) {
  return results.filter(r => {
    if (r._typeKey !== 'trust-transfer') return true;

    const entityKeywords = config.documentTypes['trust-transfer'].entityKeywords;
    const granteeText = normalize(r.grantee);

    // Grantee must be a trust or LLC entity
    return entityKeywords.some(kw => granteeText.includes(kw));
  });
}

/**
 * Apply all document-type-specific filters.
 */
function applyFilters(results) {
  let filtered = filterConstructionDOTs(results);
  filtered = filterTrustTransfers(filtered);
  return filtered;
}

/**
 * Clean up internal tags from results before output.
 */
function cleanForOutput(results) {
  return results.map(({ _typeKey, _leadQuality, ...rest }) => ({
    ...rest,
    leadQuality: _leadQuality || 'unknown',
  }));
}

module.exports = {
  searchDocuments,
  searchAllDocumentTypes,
  applyFilters,
  cleanForOutput,
  debugScreenshot,
};

const config = require('./config');
const { isDanielianFit: isBurkhartFit } = require('../shared/danielian-fit');

// Keywords that indicate a residential project in agenda item text
const RESIDENTIAL_KEYWORDS = [
  'residential', 'sfr', 'single family', 'single-family',
  'addition', 'remodel', 'new home', 'new residence', 'new dwelling',
  'demolition', 'demo', 'rebuild', 'renovation', 'custom home',
  'new construction', 'second floor', '2nd floor', 'adu', 'jadu',
  'guest house', 'alteration', 'sfd',
];

/**
 * Check if agenda text looks like a residential project.
 * @param {string} text
 * @returns {boolean}
 */
function looksResidential(text) {
  const lower = (text || '').toLowerCase();
  return RESIDENTIAL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Parse a date string from a meeting page into ISO format.
 * @param {string} raw
 * @returns {string}
 */
function parseMeetingDate(raw) {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return cleaned;
}

/**
 * Extract address from agenda text. Looks for common street address patterns.
 * @param {string} text
 * @returns {string}
 */
function extractAddress(text) {
  if (!text) return '';
  // Match patterns like "123 Main St", "12345 Pacific Coast Highway"
  const match = text.match(/\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}(?:\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Rd|Road|Hwy|Highway|Cir|Circle|Ter|Terrace|Pkwy|Parkway)\.?))\b/i);
  return match ? match[1].trim() : '';
}

/**
 * Extract applicant/architect from agenda text.
 * @param {string} text
 * @param {string} label - "applicant" or "architect"
 * @returns {string}
 */
function extractNamedField(text, label) {
  if (!text) return '';
  const patterns = [
    new RegExp(`${label}[:\\s]+([^;,\\n]+)`, 'i'),
    new RegExp(`${label}\\s*[-:]\\s*([^;,\\n]+)`, 'i'),
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Extract case/project number from agenda text.
 * @param {string} text
 * @returns {string}
 */
function extractCaseNumber(text) {
  if (!text) return '';
  // Common case number patterns: DRB-2024-001, PA2024-123, CDP 24-01, etc.
  const match = text.match(/\b([A-Z]{2,5}[\s-]?\d{2,4}[\s-]\d{1,5})\b/i);
  return match ? match[1].trim() : '';
}

/**
 * Extract staff recommendation from text.
 * @param {string} text
 * @returns {string}
 */
function extractRecommendation(text) {
  if (!text) return '';
  const patterns = [
    /recommendation[:\s]+([^.;\n]+)/i,
    /staff recommends?\s+([^.;\n]+)/i,
    /recommended action[:\s]+([^.;\n]+)/i,
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) return match[1].trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
//  Granicus scraper
// ---------------------------------------------------------------------------

/**
 * Search a Granicus-based board calendar for recent meetings and extract
 * agenda items that look residential.
 *
 * @param {import('playwright').Page} page
 * @param {object} boardConfig - One entry from config.granicus[]
 * @returns {Promise<object[]>} Array of raw agenda items
 */
async function searchGranicus(page, boardConfig) {
  const { city, boardName, baseUrl, calendarUrl } = boardConfig;
  const results = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.search.lookbackDays);

  console.log(`  [Granicus] ${city} ${boardName} - navigating to calendar...`);

  try {
    await page.goto(`${baseUrl}${calendarUrl}`, {
      timeout: config.browser.timeout,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.search.waitForPage);

    // Granicus calendar pages list meetings as rows in a table or list.
    // Each meeting row typically has a date and links to the agenda/minutes.
    // We look for links that contain "Agenda" or point to meeting detail pages.
    const meetingLinks = await page.$$eval(
      'a[href*="ViewPublisher"], a[href*="MetaViewer"], a[href*="GeneratedAgendaViewer"], a[href*="AgendaViewer"], table a',
      (anchors, baseUrl) => {
        const seen = new Set();
        return anchors
          .filter(a => {
            const href = a.getAttribute('href') || '';
            const text = (a.textContent || '').trim().toLowerCase();
            // Find links to agendas or meeting clips
            const isAgendaLink = text.includes('agenda') ||
              href.includes('GeneratedAgendaViewer') ||
              href.includes('AgendaViewer') ||
              href.includes('MetaViewer');
            if (!isAgendaLink) return false;
            // Dedupe
            const full = href.startsWith('http') ? href : `${baseUrl}${href}`;
            if (seen.has(full)) return false;
            seen.add(full);
            return true;
          })
          .map(a => {
            const href = a.getAttribute('href') || '';
            const row = a.closest('tr') || a.closest('li') || a.parentElement;
            const rowText = row ? row.textContent : '';
            return {
              url: href.startsWith('http') ? href : `${baseUrl}${href}`,
              rowText: (rowText || '').trim().substring(0, 300),
            };
          })
          .slice(0, 20); // Limit to 20 most recent
      },
      baseUrl,
    );

    console.log(`  [Granicus] ${city} - found ${meetingLinks.length} agenda links`);

    for (const link of meetingLinks) {
      // Try to parse a date from the row text
      const dateStr = parseMeetingDate(link.rowText);
      const meetingDate = new Date(dateStr);
      if (!isNaN(meetingDate.getTime()) && meetingDate < cutoff) {
        continue; // Skip meetings older than lookback
      }

      try {
        await page.goto(link.url, {
          timeout: config.browser.timeout,
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(config.search.waitBetweenPages);

        // Extract all text from the agenda page
        const agendaContent = await page.evaluate(() => document.body.innerText);

        // Look for individual agenda items - split by common delimiters
        // Granicus agendas often use numbered items or sections
        const sections = agendaContent.split(/(?=\d+\.\s)|(?=ITEM\s+\d)|(?=CASE\s+)/i);

        for (const section of sections) {
          if (!looksResidential(section)) continue;

          const address = extractAddress(section);
          const caseNumber = extractCaseNumber(section);
          const applicant = extractNamedField(section, 'applicant') ||
                           extractNamedField(section, 'owner') ||
                           extractNamedField(section, 'property owner');
          const architect = extractNamedField(section, 'architect') ||
                           extractNamedField(section, 'designer') ||
                           extractNamedField(section, 'project designer');
          const recommendation = extractRecommendation(section);

          results.push({
            caseNumber: caseNumber,
            address: address,
            applicant: applicant,
            architect: architect,
            scope: section.trim().substring(0, 500),
            recommendation: recommendation,
            meetingDate: dateStr,
            boardName: boardName,
            city: city,
            staffReportUrl: '',
            platform: 'granicus',
          });
        }

        // Also look for links to staff reports (PDFs)
        const pdfLinks = await page.$$eval('a[href*=".pdf"], a[href*="MetaViewer"]', anchors =>
          anchors
            .filter(a => {
              const text = (a.textContent || '').toLowerCase();
              return text.includes('staff report') || text.includes('report') || text.includes('pdf');
            })
            .map(a => ({
              text: (a.textContent || '').trim(),
              url: a.href,
            }))
        );

        // Attach staff report URLs to results from this meeting
        if (pdfLinks.length > 0 && results.length > 0) {
          const lastBatch = results.filter(r => r.meetingDate === dateStr && r.city === city);
          for (const item of lastBatch) {
            if (!item.staffReportUrl && pdfLinks.length > 0) {
              item.staffReportUrl = pdfLinks[0].url;
            }
          }
        }
      } catch (err) {
        console.warn(`  [Granicus] ${city} - error loading agenda: ${err.message.substring(0, 120)}`);
      }
    }
  } catch (err) {
    console.error(`  [Granicus] ${city} - calendar error: ${err.message.substring(0, 150)}`);
  }

  console.log(`  [Granicus] ${city} - extracted ${results.length} residential agenda items`);
  return results;
}

// ---------------------------------------------------------------------------
//  Legistar scraper
// ---------------------------------------------------------------------------

/**
 * Search a Legistar-based board calendar for recent meetings and extract
 * agenda matters that look residential.
 *
 * @param {import('playwright').Page} page
 * @param {object} boardConfig - One entry from config.legistar[]
 * @returns {Promise<object[]>} Array of raw agenda items
 */
async function searchLegistar(page, boardConfig) {
  const { city, boardName, baseUrl, calendarUrl } = boardConfig;
  const results = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.search.lookbackDays);

  console.log(`  [Legistar] ${city} ${boardName} - navigating to calendar...`);

  try {
    await page.goto(`${baseUrl}${calendarUrl}`, {
      timeout: config.browser.timeout,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.search.waitForPage);

    // Legistar Calendar.aspx shows a list/grid of meetings.
    // Each meeting row has a date and a link to MeetingDetail.aspx.
    const meetingRows = await page.$$eval(
      'a[href*="MeetingDetail"]',
      (anchors, opts) => {
        const seen = new Set();
        return anchors
          .filter(a => {
            const href = a.getAttribute('href') || '';
            if (seen.has(href)) return false;
            seen.add(href);
            return href.includes('MeetingDetail');
          })
          .map(a => {
            const href = a.getAttribute('href') || '';
            const row = a.closest('tr') || a.closest('li') || a.parentElement;
            const rowText = row ? row.textContent : '';
            return {
              url: href.startsWith('http') ? href : `${opts.baseUrl}${href}`,
              rowText: (rowText || '').trim().substring(0, 300),
              linkText: (a.textContent || '').trim(),
            };
          })
          .slice(0, 20);
      },
      { baseUrl },
    );

    console.log(`  [Legistar] ${city} - found ${meetingRows.length} meeting links`);

    for (const meeting of meetingRows) {
      // Try to parse meeting date from row text or link text
      const dateStr = parseMeetingDate(meeting.linkText) || parseMeetingDate(meeting.rowText);
      const meetingDate = new Date(dateStr);
      if (!isNaN(meetingDate.getTime()) && meetingDate < cutoff) {
        continue; // Skip old meetings
      }

      try {
        // Navigate to MeetingDetail.aspx
        await page.goto(meeting.url, {
          timeout: config.browser.timeout,
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(config.search.waitBetweenPages);

        // MeetingDetail lists agenda items (matters). Each matter links to
        // LegislationDetail.aspx with full details.
        const matterLinks = await page.$$eval(
          'a[href*="LegislationDetail"]',
          (anchors, opts) => {
            const seen = new Set();
            return anchors
              .filter(a => {
                const href = a.getAttribute('href') || '';
                if (seen.has(href)) return false;
                seen.add(href);
                return true;
              })
              .map(a => {
                const href = a.getAttribute('href') || '';
                const row = a.closest('tr') || a.parentElement;
                const rowText = row ? row.textContent : '';
                return {
                  url: href.startsWith('http') ? href : `${opts.baseUrl}${href}`,
                  title: (a.textContent || '').trim(),
                  rowText: (rowText || '').trim().substring(0, 500),
                };
              })
              .slice(0, 30);
          },
          { baseUrl },
        );

        console.log(`  [Legistar] ${city} - meeting has ${matterLinks.length} matters`);

        for (const matter of matterLinks) {
          // Quick pre-filter on row text before loading the full detail page
          const combinedText = `${matter.title} ${matter.rowText}`;
          if (!looksResidential(combinedText)) continue;

          try {
            await page.goto(matter.url, {
              timeout: config.browser.timeout,
              waitUntil: 'domcontentloaded',
            });
            await page.waitForTimeout(config.search.waitBetweenPages);

            // Extract detail fields from LegislationDetail page
            const detail = await page.evaluate(() => {
              const getText = (label) => {
                const cells = Array.from(document.querySelectorAll('td, th'));
                for (const cell of cells) {
                  if ((cell.textContent || '').trim().toLowerCase().includes(label.toLowerCase())) {
                    const next = cell.nextElementSibling;
                    if (next) return next.textContent.trim();
                  }
                }
                return '';
              };

              return {
                title: getText('Title') || getText('Name') || '',
                matterNumber: getText('File #') || getText('File Number') || getText('Matter #') || '',
                type: getText('Type') || '',
                status: getText('Status') || '',
                bodyText: document.body.innerText.substring(0, 3000),
              };
            });

            // Look for staff report attachments
            const attachments = await page.$$eval(
              'a[href*=".pdf"], a[href*="View.ashx"], a[href*="Attachment"]',
              anchors => anchors
                .filter(a => {
                  const text = (a.textContent || '').toLowerCase();
                  return text.includes('staff report') || text.includes('report') ||
                         text.includes('attachment') || text.includes('pdf');
                })
                .map(a => ({ text: a.textContent.trim(), url: a.href }))
            );

            const fullText = `${detail.title} ${detail.bodyText}`;
            const address = extractAddress(fullText);
            const applicant = extractNamedField(fullText, 'applicant') ||
                             extractNamedField(fullText, 'owner') ||
                             extractNamedField(fullText, 'property owner');
            const architect = extractNamedField(fullText, 'architect') ||
                             extractNamedField(fullText, 'designer');
            const recommendation = extractRecommendation(fullText);

            results.push({
              caseNumber: detail.matterNumber || extractCaseNumber(fullText),
              matterNumber: detail.matterNumber,
              address: address,
              applicant: applicant,
              architect: architect,
              scope: (detail.title || combinedText).substring(0, 500),
              recommendation: recommendation,
              meetingDate: dateStr,
              boardName: boardName,
              city: city,
              staffReportUrl: attachments.length > 0 ? attachments[0].url : '',
              platform: 'legistar',
            });
          } catch (err) {
            console.warn(`  [Legistar] ${city} - error loading matter detail: ${err.message.substring(0, 120)}`);
          }
        }
      } catch (err) {
        console.warn(`  [Legistar] ${city} - error loading meeting detail: ${err.message.substring(0, 120)}`);
      }
    }
  } catch (err) {
    console.error(`  [Legistar] ${city} - calendar error: ${err.message.substring(0, 150)}`);
  }

  console.log(`  [Legistar] ${city} - extracted ${results.length} residential agenda items`);
  return results;
}

// ---------------------------------------------------------------------------
//  Filtering and formatting
// ---------------------------------------------------------------------------

/**
 * Filter results to residential projects using shared client-fit module.
 * @param {object[]} results - Raw agenda items
 * @returns {object[]} Residential-only results
 */
function filterResidential(results) {
  return results.filter(item => {
    // First check: does it pass the Burkhart residential scope filter?
    const fit = isBurkhartFit({
      planNumber: item.caseNumber || item.matterNumber || '',
      description: item.scope || '',
      address: item.address || '',
      type: item.boardName || '',
      workClass: '',
      status: '',
    });
    // If isBurkhartFit says yes, keep it. Otherwise fall back to our keyword check.
    // This is lenient: DRB items are inherently more likely to be residential targets
    // since these boards specifically review residential design.
    return fit || looksResidential(item.scope);
  });
}

/**
 * Format a raw agenda item into a clean property object.
 * @param {object} item - Raw extracted agenda item
 * @returns {object} Formatted property
 */
function formatProperty(item) {
  return {
    planNumber: item.caseNumber || item.matterNumber || '',
    address: item.address || '',
    applicant: item.applicant || '',
    architect: item.architect || '',
    scope: item.scope || '',
    staffRecommendation: item.recommendation || '',
    meetingDate: item.meetingDate || '',
    boardName: item.boardName || '',
    city: item.city || '',
    staffReportUrl: item.staffReportUrl || '',
    source: `${item.city} ${item.boardName}`,
    sourceType: 'Design Review Board',
  };
}

/**
 * Export results to CSV format.
 * @param {object[]} properties - Formatted property objects
 * @returns {string} CSV content
 */
function toCSV(properties) {
  const header = 'Case Number,Source,Source Type,City,Board,Address,Applicant,Architect,Scope,Recommendation,Meeting Date,Staff Report URL\n';
  const rows = properties.map(p => [
    `"${(p.planNumber || '').replace(/"/g, '""')}"`,
    `"${(p.source || '').replace(/"/g, '""')}"`,
    `"${(p.sourceType || '').replace(/"/g, '""')}"`,
    `"${(p.city || '').replace(/"/g, '""')}"`,
    `"${(p.boardName || '').replace(/"/g, '""')}"`,
    `"${(p.address || '').replace(/"/g, '""')}"`,
    `"${(p.applicant || '').replace(/"/g, '""')}"`,
    `"${(p.architect || '').replace(/"/g, '""')}"`,
    `"${(p.scope || '').replace(/"/g, '""').substring(0, 300)}"`,
    `"${(p.staffRecommendation || '').replace(/"/g, '""')}"`,
    `"${(p.meetingDate || '').replace(/"/g, '""')}"`,
    `"${(p.staffReportUrl || '').replace(/"/g, '""')}"`,
  ].join(','));
  return header + rows.join('\n');
}

module.exports = {
  searchGranicus,
  searchLegistar,
  filterResidential,
  formatProperty,
  toCSV,
};

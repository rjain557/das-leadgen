/**
 * Granicus Scraper — DRB Layer 2
 *
 * Scrapes Granicus meeting pages for agenda items related to residential projects.
 * Targets: Laguna Beach, Irvine, San Juan Capistrano
 */

const { chromium } = require('playwright');
const { browser: browserConfig, RESIDENTIAL_KEYWORDS, APPROVAL_KEYWORDS, DENIAL_KEYWORDS } = require('./config');

function matchesResidential(text) {
  const lower = text.toLowerCase();
  return RESIDENTIAL_KEYWORDS.some(kw => lower.includes(kw));
}

function detectRecommendation(text) {
  const lower = text.toLowerCase();
  if (APPROVAL_KEYWORDS.some(kw => lower.includes(kw))) return 'approval';
  if (DENIAL_KEYWORDS.some(kw => lower.includes(kw))) return 'denial';
  return null;
}

function extractAddress(text) {
  // Common OC address patterns: number + street name + optional city/zip
  const patterns = [
    /(\d{1,6}\s+[A-Z][A-Za-z\s.]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Trail|Trl)\.?(?:\s*,?\s*[A-Za-z\s]+,?\s*CA\s*\d{5})?)/i,
    /(\d{1,6}\s+[A-Z][A-Za-z\s.]+(?:#\s*\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractCaseNumber(text) {
  // Patterns: DR-2026-001, PA2026-001, CDP 26-001, DRP26-0001, etc.
  const patterns = [
    /\b(DR[P]?[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CDP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CUP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(VAR[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(DRC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(ZA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(SP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(MA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(TR[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(GPA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim().toUpperCase();
  }
  return null;
}

function extractApplicant(text) {
  const patterns = [
    /applicant[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,\s*(?:for|to|requesting|request))/i,
    /submitted by[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /owner[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /applicant[:\s]+([A-Z][A-Za-z\s,.'&-]{3,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractArchitect(text) {
  const patterns = [
    /architect[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /designer[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /agent[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /([A-Za-z\s.'&-]+(?:Architect|Architecture|Design|Planning)\b[A-Za-z\s.'&-]*)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Scrape a single Granicus city for DRB/Planning Commission agenda items.
 */
async function scrapeGranicus(cityConfig, options = {}) {
  const { days = 90, headed = false } = options;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const results = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      viewport: browserConfig.viewport,
      userAgent: browserConfig.userAgent,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(browserConfig.timeout);

    console.log(`[granicus] Scraping ${cityConfig.name} at ${cityConfig.granicusUrl}`);

    // Step 1: Navigate to Granicus and find the board
    await page.goto(cityConfig.granicusUrl, {
      waitUntil: 'domcontentloaded',
      timeout: browserConfig.navigationTimeout,
    });
    await page.waitForTimeout(3000);

    // Granicus sites list boards/committees. Find the matching one.
    // Try to find meeting links on the main page first
    const boardLinks = await page.$$eval('a', (links, boardNames) => {
      return links
        .filter(a => {
          const text = a.textContent.toLowerCase();
          return boardNames.some(name => text.includes(name.toLowerCase()));
        })
        .map(a => ({
          text: a.textContent.trim(),
          href: a.href,
        }));
    }, [cityConfig.boardName, cityConfig.altBoardName].filter(Boolean));

    if (boardLinks.length === 0) {
      // Fallback: try the ViewPublisher page directly for common Granicus patterns
      const viewPublisherUrl = `${cityConfig.granicusUrl}/ViewPublisher.php?view_id=1`;
      console.log(`[granicus] No board links found on main page, trying ${viewPublisherUrl}`);
      await page.goto(viewPublisherUrl, {
        waitUntil: 'domcontentloaded',
        timeout: browserConfig.navigationTimeout,
      });
      await page.waitForTimeout(2000);
    } else {
      // Navigate to the first matching board link
      console.log(`[granicus] Found board: ${boardLinks[0].text}`);
      await page.goto(boardLinks[0].href, {
        waitUntil: 'domcontentloaded',
        timeout: browserConfig.navigationTimeout,
      });
      await page.waitForTimeout(2000);
    }

    // Step 2: Find meeting rows on the page
    // Granicus typically lists meetings in table rows or list items
    const meetingData = await page.$$eval(
      'table tr, .listingTable tr, .meeting-list-item, .row-fluid',
      (rows, cutoffStr) => {
        const cutoff = new Date(cutoffStr);
        const meetings = [];

        for (const row of rows) {
          const text = row.textContent || '';
          // Look for date patterns in row text
          const dateMatch = text.match(
            /(\w+ \d{1,2},?\s*\d{4})|(\d{1,2}\/\d{1,2}\/\d{2,4})|(\d{4}-\d{2}-\d{2})/
          );
          if (!dateMatch) continue;

          const dateStr = dateMatch[0];
          const meetingDate = new Date(dateStr);
          if (isNaN(meetingDate.getTime())) continue;
          if (meetingDate < cutoff) continue;

          // Look for agenda/minutes links
          const links = row.querySelectorAll('a');
          const agendaLink = Array.from(links).find(a => {
            const t = a.textContent.toLowerCase();
            return t.includes('agenda') || t.includes('packet');
          });

          meetings.push({
            date: dateStr,
            text: text.substring(0, 500),
            agendaUrl: agendaLink ? agendaLink.href : null,
            rowLinks: Array.from(links).map(a => ({
              text: a.textContent.trim(),
              href: a.href,
            })),
          });
        }
        return meetings;
      },
      cutoffDate.toISOString()
    );

    console.log(`[granicus] Found ${meetingData.length} meetings within ${days} days for ${cityConfig.slug}`);

    // Step 3: For each meeting, try to get agenda details
    for (const meeting of meetingData) {
      // Try to visit agenda page if available
      if (meeting.agendaUrl) {
        try {
          await page.goto(meeting.agendaUrl, {
            waitUntil: 'domcontentloaded',
            timeout: browserConfig.navigationTimeout,
          });
          await page.waitForTimeout(2000);

          // Extract agenda items from the agenda page
          const agendaItems = await page.$$eval(
            '.AgendaItem, .agenda-item, .item-row, li, tr',
            (items) => {
              return items
                .map(item => ({
                  text: (item.textContent || '').trim().substring(0, 1000),
                  links: Array.from(item.querySelectorAll('a')).map(a => ({
                    text: a.textContent.trim(),
                    href: a.href,
                  })),
                }))
                .filter(item => item.text.length > 20);
            }
          );

          for (const item of agendaItems) {
            if (!matchesResidential(item.text)) continue;

            const staffReportLink = item.links.find(l => {
              const t = l.text.toLowerCase();
              return t.includes('staff report') || t.includes('attachment') || l.href.endsWith('.pdf');
            });

            results.push({
              source: 'drb',
              sourceCity: cityConfig.slug,
              sourceName: cityConfig.name,
              meetingDate: parseDate(meeting.date),
              caseNumber: extractCaseNumber(item.text),
              address: extractAddress(item.text),
              applicant: extractApplicant(item.text),
              architect: extractArchitect(item.text),
              scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
              recommendation: detectRecommendation(item.text),
              staffReportUrl: staffReportLink ? staffReportLink.href : null,
              url: meeting.agendaUrl,
            });
          }
        } catch (err) {
          console.warn(`[granicus] Error fetching agenda at ${meeting.agendaUrl}: ${err.message}`);
        }
      }

      // Also check row text itself for embedded agenda items (some Granicus pages inline them)
      if (matchesResidential(meeting.text)) {
        // Avoid duplicates if we already extracted from the agenda page
        const existingAddresses = results
          .filter(r => r.meetingDate === parseDate(meeting.date))
          .map(r => r.address)
          .filter(Boolean);

        const addr = extractAddress(meeting.text);
        if (addr && existingAddresses.includes(addr)) continue;

        const pdfLink = meeting.rowLinks.find(l => l.href && l.href.endsWith('.pdf'));

        results.push({
          source: 'drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          meetingDate: parseDate(meeting.date),
          caseNumber: extractCaseNumber(meeting.text),
          address: addr,
          applicant: extractApplicant(meeting.text),
          architect: extractArchitect(meeting.text),
          scope: meeting.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
          recommendation: detectRecommendation(meeting.text),
          staffReportUrl: pdfLink ? pdfLink.href : null,
          url: cityConfig.granicusUrl,
        });
      }
    }

    // Step 4: For Laguna Beach, also try the current-projects page
    if (cityConfig.altUrl) {
      try {
        console.log(`[granicus] Also checking alt URL: ${cityConfig.altUrl}`);
        await page.goto(cityConfig.altUrl, {
          waitUntil: 'domcontentloaded',
          timeout: browserConfig.navigationTimeout,
        });
        await page.waitForTimeout(3000);

        const projectItems = await page.$$eval(
          'table tr, .accordion-item, li, .field-items .field-item, article',
          (items) => {
            return items
              .map(item => ({
                text: (item.textContent || '').trim().substring(0, 1000),
                links: Array.from(item.querySelectorAll('a')).map(a => ({
                  text: a.textContent.trim(),
                  href: a.href,
                })),
              }))
              .filter(item => item.text.length > 30);
          }
        );

        for (const item of projectItems) {
          if (!matchesResidential(item.text)) continue;

          const addr = extractAddress(item.text);
          // Skip if we already have this address
          if (addr && results.some(r => r.address === addr && r.sourceCity === cityConfig.slug)) continue;

          results.push({
            source: 'drb',
            sourceCity: cityConfig.slug,
            sourceName: cityConfig.name + ' (Current Projects)',
            meetingDate: null,
            caseNumber: extractCaseNumber(item.text),
            address: addr,
            applicant: extractApplicant(item.text),
            architect: extractArchitect(item.text),
            scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
            recommendation: detectRecommendation(item.text),
            staffReportUrl: item.links.find(l => l.href.endsWith('.pdf'))?.href || null,
            url: cityConfig.altUrl,
          });
        }
      } catch (err) {
        console.warn(`[granicus] Error scraping alt URL ${cityConfig.altUrl}: ${err.message}`);
      }
    }

    console.log(`[granicus] ${cityConfig.slug}: extracted ${results.length} residential agenda items`);
  } catch (err) {
    console.error(`[granicus] Error scraping ${cityConfig.slug}: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

module.exports = { scrapeGranicus };

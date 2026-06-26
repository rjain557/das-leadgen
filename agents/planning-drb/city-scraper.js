/**
 * City CMS Scraper — DRB Layer 2
 *
 * Scrapes city-hosted agenda pages for planning commission/DRB meetings.
 * Uses Playwright for pages that require JS rendering.
 * Targets: San Clemente, Dana Point, Laguna Niguel, County of Orange
 */

const { chromium } = require('playwright');
const { browser: browserConfig, RESIDENTIAL_KEYWORDS, APPROVAL_KEYWORDS, DENIAL_KEYWORDS } = require('./config');

function matchesResidential(text) {
  const lower = (text || '').toLowerCase();
  return RESIDENTIAL_KEYWORDS.some(kw => lower.includes(kw));
}

function detectRecommendation(text) {
  const lower = (text || '').toLowerCase();
  if (APPROVAL_KEYWORDS.some(kw => lower.includes(kw))) return 'approval';
  if (DENIAL_KEYWORDS.some(kw => lower.includes(kw))) return 'denial';
  return null;
}

function extractAddress(text) {
  if (!text) return null;
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
  if (!text) return null;
  const patterns = [
    /\b(DR[PSC]?[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CDP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CUP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(VAR[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(ZA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(SP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim().toUpperCase();
  }
  return null;
}

function extractApplicant(text) {
  if (!text) return null;
  const patterns = [
    /applicant[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,\s*(?:for|to|requesting))/i,
    /submitted by[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,)/i,
    /applicant[:\s]+([A-Z][A-Za-z\s,.'&-]{3,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractArchitect(text) {
  if (!text) return null;
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

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/**
 * Scrape San Clemente DRS agenda page.
 * Uses folder-based agenda listing.
 */
async function scrapeSanClemente(page, cityConfig, cutoffDate) {
  const results = [];
  console.log(`[city-cms] Scraping San Clemente DRS: ${cityConfig.agendaUrl}`);

  await page.goto(cityConfig.agendaUrl, {
    waitUntil: 'domcontentloaded',
    timeout: browserConfig.navigationTimeout,
  });
  await page.waitForTimeout(3000);

  // San Clemente uses a folder-style listing with links to agenda PDFs/pages
  const agendaLinks = await page.$$eval('a', (links) => {
    return links
      .filter(a => {
        const text = a.textContent.toLowerCase();
        return (text.includes('agenda') || text.includes('packet') || /\d{4}/.test(text))
          && a.href;
      })
      .map(a => ({
        text: a.textContent.trim(),
        href: a.href,
      }));
  });

  console.log(`[city-cms] San Clemente: found ${agendaLinks.length} agenda links`);

  // Visit each agenda page to extract items
  for (const link of agendaLinks.slice(0, 10)) {
    // Try to extract a date from the link text
    const dateMatch = link.text.match(
      /(\w+ \d{1,2},?\s*\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/
    );
    const meetingDate = dateMatch ? formatDate(dateMatch[0]) : null;

    if (meetingDate && new Date(meetingDate) < cutoffDate) continue;

    // Skip PDF links, only visit HTML pages
    if (link.href.endsWith('.pdf')) {
      // Record the PDF link as a potential staff report
      results.push({
        source: 'drb',
        sourceCity: cityConfig.slug,
        sourceName: cityConfig.name,
        meetingDate,
        caseNumber: extractCaseNumber(link.text),
        address: extractAddress(link.text),
        applicant: null,
        architect: null,
        scope: link.text.substring(0, 300),
        recommendation: null,
        staffReportUrl: link.href,
        url: cityConfig.agendaUrl,
      });
      continue;
    }

    try {
      await page.goto(link.href, {
        waitUntil: 'domcontentloaded',
        timeout: browserConfig.navigationTimeout,
      });
      await page.waitForTimeout(2000);

      const items = await page.$$eval(
        'li, tr, p, .agenda-item, article',
        (elems) => elems
          .map(el => ({
            text: (el.textContent || '').trim().substring(0, 1000),
            links: Array.from(el.querySelectorAll('a')).map(a => ({
              text: a.textContent.trim(),
              href: a.href,
            })),
          }))
          .filter(item => item.text.length > 30)
      );

      for (const item of items) {
        if (!matchesResidential(item.text)) continue;

        const pdfLink = item.links.find(l => l.href && l.href.endsWith('.pdf'));
        results.push({
          source: 'drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          meetingDate,
          caseNumber: extractCaseNumber(item.text),
          address: extractAddress(item.text),
          applicant: extractApplicant(item.text),
          architect: extractArchitect(item.text),
          scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
          recommendation: detectRecommendation(item.text),
          staffReportUrl: pdfLink ? pdfLink.href : null,
          url: link.href,
        });
      }
    } catch (err) {
      console.warn(`[city-cms] Error visiting ${link.href}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Scrape Dana Point Planning Commission page.
 */
async function scrapeDanaPoint(page, cityConfig, cutoffDate) {
  const results = [];
  console.log(`[city-cms] Scraping Dana Point Planning: ${cityConfig.agendaUrl}`);

  await page.goto(cityConfig.agendaUrl, {
    waitUntil: 'domcontentloaded',
    timeout: browserConfig.navigationTimeout,
  });
  await page.waitForTimeout(3000);

  // Dana Point lists agendas as links with dates
  const agendaLinks = await page.$$eval('a', (links) => {
    return links
      .filter(a => {
        const text = a.textContent.toLowerCase();
        return (text.includes('agenda') || text.includes('meeting') || text.includes('packet'))
          && a.href;
      })
      .map(a => ({
        text: a.textContent.trim(),
        href: a.href,
      }));
  });

  console.log(`[city-cms] Dana Point: found ${agendaLinks.length} agenda links`);

  for (const link of agendaLinks.slice(0, 10)) {
    const dateMatch = link.text.match(
      /(\w+ \d{1,2},?\s*\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/
    );
    const meetingDate = dateMatch ? formatDate(dateMatch[0]) : null;

    if (meetingDate && new Date(meetingDate) < cutoffDate) continue;

    if (link.href.endsWith('.pdf')) {
      if (matchesResidential(link.text)) {
        results.push({
          source: 'drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          meetingDate,
          caseNumber: extractCaseNumber(link.text),
          address: extractAddress(link.text),
          applicant: null,
          architect: null,
          scope: link.text.substring(0, 300),
          recommendation: null,
          staffReportUrl: link.href,
          url: cityConfig.agendaUrl,
        });
      }
      continue;
    }

    try {
      await page.goto(link.href, {
        waitUntil: 'domcontentloaded',
        timeout: browserConfig.navigationTimeout,
      });
      await page.waitForTimeout(2000);

      const items = await page.$$eval(
        'li, tr, p, .agenda-item, article, div.field-item',
        (elems) => elems
          .map(el => ({
            text: (el.textContent || '').trim().substring(0, 1000),
            links: Array.from(el.querySelectorAll('a')).map(a => ({
              text: a.textContent.trim(),
              href: a.href,
            })),
          }))
          .filter(item => item.text.length > 30)
      );

      for (const item of items) {
        if (!matchesResidential(item.text)) continue;
        const pdfLink = item.links.find(l => l.href && l.href.endsWith('.pdf'));
        results.push({
          source: 'drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          meetingDate,
          caseNumber: extractCaseNumber(item.text),
          address: extractAddress(item.text),
          applicant: extractApplicant(item.text),
          architect: extractArchitect(item.text),
          scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
          recommendation: detectRecommendation(item.text),
          staffReportUrl: pdfLink ? pdfLink.href : null,
          url: link.href,
        });
      }
    } catch (err) {
      console.warn(`[city-cms] Error visiting ${link.href}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Scrape Laguna Niguel AgendaCenter page.
 * CivicPlus AgendaCenter pattern.
 */
async function scrapeLagunaNiguel(page, cityConfig, cutoffDate) {
  const results = [];
  console.log(`[city-cms] Scraping Laguna Niguel Planning: ${cityConfig.agendaUrl}`);

  await page.goto(cityConfig.agendaUrl, {
    waitUntil: 'domcontentloaded',
    timeout: browserConfig.navigationTimeout,
  });
  await page.waitForTimeout(3000);

  // CivicPlus AgendaCenter lists agendas by year with toggle sections
  // Each row has date, agenda PDF, minutes PDF, packet PDF links
  const agendaRows = await page.$$eval(
    'table tr, .Row, .AgendaRow, [class*="agenda"]',
    (rows, cutoffStr) => {
      const cutoff = new Date(cutoffStr);
      return rows
        .map(row => {
          const text = row.textContent || '';
          const dateMatch = text.match(
            /(\w+ \d{1,2},?\s*\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/
          );
          const links = Array.from(row.querySelectorAll('a')).map(a => ({
            text: a.textContent.trim(),
            href: a.href,
          }));
          return {
            text: text.substring(0, 500),
            date: dateMatch ? dateMatch[0] : null,
            links,
          };
        })
        .filter(row => {
          if (!row.date) return false;
          const d = new Date(row.date);
          return !isNaN(d.getTime()) && d >= cutoff;
        });
    },
    cutoffDate.toISOString()
  );

  console.log(`[city-cms] Laguna Niguel: found ${agendaRows.length} recent agenda rows`);

  for (const row of agendaRows) {
    const meetingDate = formatDate(row.date);
    const agendaLink = row.links.find(l => {
      const t = l.text.toLowerCase();
      return t.includes('agenda') || t.includes('packet');
    });

    if (!agendaLink) continue;

    // If it's a PDF, note it but also try to visit HTML links
    if (agendaLink.href.endsWith('.pdf')) {
      results.push({
        source: 'drb',
        sourceCity: cityConfig.slug,
        sourceName: cityConfig.name,
        meetingDate,
        caseNumber: null,
        address: null,
        applicant: null,
        architect: null,
        scope: `Planning Commission meeting agenda - ${row.date}`,
        recommendation: null,
        staffReportUrl: agendaLink.href,
        url: cityConfig.agendaUrl,
      });
      continue;
    }

    try {
      await page.goto(agendaLink.href, {
        waitUntil: 'domcontentloaded',
        timeout: browserConfig.navigationTimeout,
      });
      await page.waitForTimeout(2000);

      const items = await page.$$eval(
        'li, tr, p, .agenda-item',
        (elems) => elems
          .map(el => ({
            text: (el.textContent || '').trim().substring(0, 1000),
            links: Array.from(el.querySelectorAll('a')).map(a => ({
              text: a.textContent.trim(),
              href: a.href,
            })),
          }))
          .filter(item => item.text.length > 30)
      );

      for (const item of items) {
        if (!matchesResidential(item.text)) continue;
        const pdfLink = item.links.find(l => l.href && l.href.endsWith('.pdf'));
        results.push({
          source: 'drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          meetingDate,
          caseNumber: extractCaseNumber(item.text),
          address: extractAddress(item.text),
          applicant: extractApplicant(item.text),
          architect: extractArchitect(item.text),
          scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
          recommendation: detectRecommendation(item.text),
          staffReportUrl: pdfLink ? pdfLink.href : null,
          url: agendaLink.href,
        });
      }
    } catch (err) {
      console.warn(`[city-cms] Error visiting ${agendaLink.href}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Scrape County of Orange Planning Commission page.
 */
async function scrapeCountyOfOrange(page, cityConfig, cutoffDate) {
  const results = [];
  console.log(`[city-cms] Scraping County of Orange Planning: ${cityConfig.agendaUrl}`);

  try {
    await page.goto(cityConfig.agendaUrl, {
      waitUntil: 'domcontentloaded',
      timeout: browserConfig.navigationTimeout,
    });
    await page.waitForTimeout(3000);

    // Look for planning commission / hearing links
    const pcLinks = await page.$$eval('a', (links) => {
      return links
        .filter(a => {
          const text = a.textContent.toLowerCase();
          return (text.includes('planning') || text.includes('commission') || text.includes('hearing'))
            && a.href;
        })
        .map(a => ({
          text: a.textContent.trim(),
          href: a.href,
        }));
    });

    console.log(`[city-cms] County of Orange: found ${pcLinks.length} planning links`);

    for (const link of pcLinks.slice(0, 5)) {
      try {
        await page.goto(link.href, {
          waitUntil: 'domcontentloaded',
          timeout: browserConfig.navigationTimeout,
        });
        await page.waitForTimeout(2000);

        const items = await page.$$eval(
          'li, tr, p, .agenda-item, article',
          (elems) => elems
            .map(el => ({
              text: (el.textContent || '').trim().substring(0, 1000),
              links: Array.from(el.querySelectorAll('a')).map(a => ({
                text: a.textContent.trim(),
                href: a.href,
              })),
            }))
            .filter(item => item.text.length > 30)
        );

        for (const item of items) {
          if (!matchesResidential(item.text)) continue;

          const dateMatch = item.text.match(
            /(\w+ \d{1,2},?\s*\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/
          );
          const meetingDate = dateMatch ? formatDate(dateMatch[0]) : null;
          if (meetingDate && new Date(meetingDate) < cutoffDate) continue;

          const pdfLink = item.links.find(l => l.href && l.href.endsWith('.pdf'));
          results.push({
            source: 'drb',
            sourceCity: cityConfig.slug,
            sourceName: cityConfig.name,
            meetingDate,
            caseNumber: extractCaseNumber(item.text),
            address: extractAddress(item.text),
            applicant: extractApplicant(item.text),
            architect: extractArchitect(item.text),
            scope: item.text.substring(0, 300).replace(/\s+/g, ' ').trim(),
            recommendation: detectRecommendation(item.text),
            staffReportUrl: pdfLink ? pdfLink.href : null,
            url: link.href,
          });
        }
      } catch (err) {
        console.warn(`[city-cms] Error visiting ${link.href}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[city-cms] Error scraping County of Orange: ${err.message}`);
  }

  return results;
}

/**
 * Scrape a single city CMS site for DRB/Planning Commission agenda items.
 */
async function scrapeCityCms(cityConfig, options = {}) {
  const { days = 90, headed = false } = options;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  let browser;
  let results = [];

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      viewport: browserConfig.viewport,
      userAgent: browserConfig.userAgent,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(browserConfig.timeout);

    switch (cityConfig.slug) {
      case 'san-clemente':
        results = await scrapeSanClemente(page, cityConfig, cutoffDate);
        break;
      case 'dana-point':
        results = await scrapeDanaPoint(page, cityConfig, cutoffDate);
        break;
      case 'laguna-niguel':
        results = await scrapeLagunaNiguel(page, cityConfig, cutoffDate);
        break;
      case 'county-of-orange':
        results = await scrapeCountyOfOrange(page, cityConfig, cutoffDate);
        break;
      default:
        console.warn(`[city-cms] No scraper implemented for ${cityConfig.slug}`);
    }

    console.log(`[city-cms] ${cityConfig.slug}: extracted ${results.length} residential agenda items`);
  } catch (err) {
    console.error(`[city-cms] Error scraping ${cityConfig.slug}: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

module.exports = { scrapeCityCms };

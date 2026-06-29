/**
 * City-CMS Scraper — L2 (Dana Point, Laguna Niguel, San Clemente, County of Orange)
 *
 * These OC jurisdictions publish planning agendas on city-hosted CMSes (mostly
 * CivicPlus "AgendaCenter", some CivicEngage). Rather than one bespoke function
 * per city (the BBC approach, now drifted), this is a single generic flow:
 *
 *   1. Render the configured agendaUrl in a (stealth) browser.
 *   2. Collect agenda links. CivicPlus exposes them as
 *      /AgendaCenter/ViewFile/Agenda/_MMDDYYYY-<id>  (date is IN the URL — we
 *      filter by --days from that, no fragile row-text parsing). Other CMSes:
 *      any agenda/packet link or .pdf.
 *   3. For each recent agenda (capped at limits.maxMeetingsPerCity): prefer the
 *      HTML version (?html=true) parsed from the DOM; else download + pdf-parse.
 *   4. Keep residential-development items; extract address / applicant / APN /
 *      case# / scope.
 *
 * Graceful: a city that has drifted or blocks us returns [] (logged), never
 * throws. Waits + counts capped so the run never hangs.
 *
 * PHASE-0 VERIFY: agendaUrl per city confirmed live 2026-06 (San Clemente moved
 * to sanclemente.gov; County moved to pwds.oc.gov). Re-confirm if a city 0s out.
 */

const { launchBrowser } = require('../shared/browser');
const { browser: browserConfig, RESIDENTIAL_KEYWORDS, APPROVAL_KEYWORDS, DENIAL_KEYWORDS, limits } = require('./config');
const { parseAgendaPdfItems } = require('./pdf-parser');

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
function extractCaseNumber(text) {
  if (!text) return '';
  const patterns = [
    /\b(DR[PCS]?[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CDP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CUP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(TTM[-\s]?\d{2,5}(?:[-\s]?\d{1,4})?)\b/i,
    /\b(TPM[-\s]?\d{2,5})\b/i,
    /\b(AC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(GPA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(SP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(ZC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PLN[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim().toUpperCase(); }
  return '';
}
function extractAddressInline(text) {
  const pats = [
    /\b(?:located at|at)\s+(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)/i,
    /\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)\b/i,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return trimAddress(m[1]); }
  return '';
}
function trimAddress(s) {
  return String(s).replace(/\s+/g, ' ').trim()
    .replace(/\s+(?:IN|AT|WITHIN|LOCATED)\b.*$/i, '')
    .replace(/\s*[(,].*$/, '')
    .trim();
}
function extractApn(text) {
  const m = text.match(/\bAPN[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i)
    || text.match(/Assessor\s+Parcel\s+Number[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i);
  return m ? m[1].replace(/\s+/g, '').trim() : '';
}
function extractApplicantInline(text) {
  const pats = [
    /\(\s*Applicant[:\s]+([^)]{3,80}?)\)/i,
    /ON BEHALF OF\s+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:\.|;|$|\s{2,})/i,
    /FILED BY\s+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:,?\s+ON BEHALF OF|\.|;|$)/i,
    /Applicant[:\s]+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:\)|\.|;|\(Project)/i,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return m[1].replace(/\s+/g, ' ').trim().replace(/[,.]$/, ''); }
  return '';
}
function extractArchitectInline(text) {
  const m = text.match(/\b(?:Architect|Designer|Design Professional)[:\s]+([A-Z][A-Za-z0-9&.,'\s-]{3,60}?)(?:\)|\.|;|\(Project)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().replace(/[,.]$/, '') : '';
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Date out of a CivicPlus ViewFile URL: /Agenda/_MMDDYYYY-<id>
function dateFromCivicPlusUrl(href) {
  const m = href.match(/_(\d{2})(\d{2})(\d{4})-/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : iso;
}

// Split a block of agenda text into residential item records.
function itemsFromText(bodyText) {
  if (!bodyText || bodyText.length < 60) return [];
  const segments = bodyText.split(/(?=\n\s*(?:\d{1,2}\.\s)|(?:ITEM\s+\d)|(?:[A-D]\.\d)|(?:CASE\s+(?:NO\.?|#)))/i);
  const blocks = segments.length > 1 ? segments : [bodyText];
  const out = [];
  const seen = new Set();
  for (const seg of blocks) {
    const block = seg.replace(/\s+/g, ' ').trim();
    if (block.length < 40) continue;
    if (!matchesResidential(block)) continue;
    const address = extractAddressInline(block);
    const caseNumber = extractCaseNumber(block);
    const apn = extractApn(block);
    const isRoster = /\bChair\b[\s\S]{0,80}\bVice Chair\b[\s\S]{0,120}\bCommissioner\b/i.test(block);
    if (isRoster && !caseNumber && !apn) continue;
    const hasApplicantCue = /\(\s*Applicant[:\s]|FILED BY|ON BEHALF OF|\blocated at\b/i.test(block);
    if (!caseNumber && !apn && !(address && hasApplicantCue)) continue;
    const key = `${address}|${caseNumber}|${apn}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address, apn,
      applicant: extractApplicantInline(block),
      architect: extractArchitectInline(block),
      caseNumber,
      scope: block.slice(0, 300),
      recommendation: detectRecommendation(block),
    });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Generic city-CMS scraper.
 * @returns {Promise<object[]>}
 */
async function scrapeCityCms(cityConfig, options = {}) {
  const { days = 90, headed = false } = options;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const results = [];
  let browserHandle;

  try {
    const launched = await launchBrowser({ headed });
    browserHandle = launched.browser;
    const context = await browserHandle.newContext({
      viewport: browserConfig.viewport,
      userAgent: browserConfig.userAgent,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(browserConfig.timeout);

    console.log(`[city-cms] ${cityConfig.name} (driver=${launched.driver}) -> ${cityConfig.agendaUrl}`);
    await page.goto(cityConfig.agendaUrl, { waitUntil: 'domcontentloaded', timeout: browserConfig.navigationTimeout });
    await page.waitForTimeout(3500);

    // Collect candidate agenda links (CivicPlus ViewFile + generic agenda/packet/pdf).
    const links = await page.$$eval('a', (as) => as
      .map(a => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.href }))
      .filter(l => l.href && (/ViewFile\/Agenda|_Agenda_|\/Agenda\//i.test(l.href) || /\.pdf/i.test(l.href) || /agenda|packet/i.test(l.text))));

    // Build a deduped, date-filtered work list. Prefer CivicPlus ViewFile agendas
    // (date in URL). Drop obvious "minutes"/"packet-only" duplicates.
    const work = [];
    const seenUrl = new Set();
    for (const l of links) {
      const isCivicPlus = /ViewFile\/Agenda/i.test(l.href);
      const iso = isCivicPlus ? dateFromCivicPlusUrl(l.href) : null;
      if (iso && new Date(iso) < cutoffDate) continue;
      // Skip pure-minutes links.
      if (/minutes/i.test(l.text) && !/agenda/i.test(l.text)) continue;
      // Normalize CivicPlus to the HTML view for easy parsing.
      let url = l.href;
      if (isCivicPlus && !/html=true/i.test(url) && !/packet=true/i.test(url)) url = url + (url.includes('?') ? '&' : '?') + 'html=true';
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
      work.push({ url, iso, isCivicPlus, isPdf: /\.pdf(\?|$)/i.test(l.href) && !isCivicPlus });
      if (work.length >= limits.maxMeetingsPerCity) break;
    }

    console.log(`[city-cms] ${cityConfig.slug}: ${links.length} agenda links, ${work.length} within ${days}d (cap ${limits.maxMeetingsPerCity})`);

    for (const w of work) {
      let items = [];
      // HTML agenda (CivicPlus ?html=true, or a non-PDF agenda page): render + parse DOM.
      if (!w.isPdf) {
        try {
          await page.goto(w.url, { waitUntil: 'domcontentloaded', timeout: browserConfig.navigationTimeout });
          await page.waitForTimeout(1500);
          const bodyText = await page.evaluate(() => document.body.innerText || '');
          items = itemsFromText(bodyText);
        } catch (err) {
          // Some CivicPlus "html=true" links still stream a PDF -> goto throws
          // "Download is starting". Fall through to the PDF path.
          if (!/download/i.test(String(err.message))) {
            console.warn(`[city-cms] ${cityConfig.slug}: HTML agenda error: ${String(err.message).slice(0, 60)}`);
          }
        }
      }
      // PDF path (or HTML yielded nothing): download + pdf-parse.
      if (items.length === 0) {
        const pdfUrl = w.url.replace(/([?&])html=true(&|$)/i, '$1').replace(/[?&]$/, '');
        try {
          const pdfItems = await parseAgendaPdfItems(pdfUrl, {
            matchesResidential, extractCaseNumber, detectRecommendation, limits,
          });
          items = pdfItems.map(it => ({ ...it, apn: extractApn(it.scope || '') }));
        } catch (err) {
          console.warn(`[city-cms] ${cityConfig.slug}: PDF parse error: ${String(err.message).slice(0, 60)}`);
        }
      }

      for (const it of items) {
        results.push({
          source: 'planning-drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          metro: 'OC',
          meetingDate: w.iso || null,
          caseNumber: it.caseNumber || null,
          apn: it.apn || null,
          address: it.address || null,
          applicant: it.applicant || null,
          architect: it.architect || null,
          scope: it.scope || null,
          recommendation: it.recommendation || null,
          staffReportUrl: w.url,
          url: w.url,
          projectType: null,
        });
      }
      await sleep(limits.throttleMs);
    }

    console.log(`[city-cms] ${cityConfig.slug}: extracted ${results.length} residential agenda items`);
  } catch (err) {
    console.error(`[city-cms] ${cityConfig.slug}: FAILED - ${String(err.message).slice(0, 120)}`);
  } finally {
    if (browserHandle) { try { await browserHandle.close(); } catch { /* ignore */ } }
  }

  return results;
}

module.exports = { scrapeCityCms };

/**
 * Legistar API Scraper — DRB Layer 2
 *
 * Uses Legistar's public OData API to fetch recent meetings and agenda items.
 * No browser needed — pure HTTP/fetch.
 * Targets: Newport Beach, Costa Mesa, City of Orange
 */

const { RESIDENTIAL_KEYWORDS, APPROVAL_KEYWORDS, DENIAL_KEYWORDS, limits } = require('./config');
const { parseDRBPdf, cleanName } = require('./pdf-parser');

const LEGISTAR_API_BASE = 'https://webapi.legistar.com/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractApn(text) {
  if (!text) return '';
  const m = text.match(/\bAPN[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i)
    || text.match(/Assessor\s+Parcel\s+Number[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i);
  return m ? m[1].replace(/\s+/g, '').trim() : '';
}

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
  // Prefer an explicit site-location label (NB/CM/Orange agendas use
  // "Site Location: <addr>" / "Project Address: <addr>"); capture only up to a
  // street suffix so we don't run into "Motion by …" trailing text.
  const labeled = text.match(/(?:Site Location|Project (?:Address|Location|Site)|Property Address|Location)[:\s]+(\d{1,6}\s+[A-Za-z0-9.\s]+?\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)/i);
  if (labeled) return labeled[1].replace(/\s+/g, ' ').trim();
  // Otherwise a bare street address — REQUIRE a recognized street suffix (no
  // catch-all, which used to grab "30 units will be dist…").
  const bare = text.match(/\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)\b/i);
  return bare ? bare[1].replace(/\s+/g, ' ').trim() : null;
}

function extractCaseNumber(text) {
  if (!text) return null;
  const patterns = [
    /\b(DR[P]?[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CDP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CUP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(VAR[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(UP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(ZA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(LC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
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
    if (match) { const n = cleanName(match[1]); if (n) return n; }
  }
  return null;
}

function extractArchitect(text) {
  if (!text) return null;
  // Require an explicit Architect/Designer label, OR a clear firm form
  // ("X Architects" / "X, AIA"). The old catch-all that matched any text ending
  // in "Design"/"Planning" produced false architectAlreadyNamed penalties.
  const patterns = [
    /architect[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,|;)/i,
    /designer[:\s]+([A-Z][A-Za-z\s,.'&-]+?)(?:\.|,|;)/i,
    /\b([A-Z][A-Za-z&.\s]{2,40}\s(?:Architects?|Architecture|AIA))\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) { const n = cleanName(match[1]); if (n) return n; }
  }
  return null;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (limits && limits.fetchTimeoutMs) || 20000);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ac.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape a single Legistar-based city for planning agenda items.
 */
async function scrapeLegistar(cityConfig, options = {}) {
  const { days = 90 } = options;
  const client = cityConfig.legistarClient;
  const results = [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  console.log(`[legistar] Scraping ${cityConfig.name} (client: ${client})`);

  try {
    // Step 1: Fetch recent events (meetings) for this body
    // Filter by date, get recent meetings
    const topN = (limits && limits.legistarMaxEvents) || 40;
    const eventsUrl = `${LEGISTAR_API_BASE}/${client}/events?$filter=EventDate ge datetime'${cutoffStr}'&$orderby=EventDate desc&$top=${topN}`;
    console.log(`[legistar] Fetching events: ${eventsUrl}`);

    const events = await fetchJson(eventsUrl);

    if (!Array.isArray(events) || events.length === 0) {
      console.log(`[legistar] No events found for ${client}`);
      return results;
    }

    // Filter to planning/design review bodies
    const boardKeywords = ['planning', 'design review', 'drc', 'drb', 'zoning'];
    const relevantEvents = events.filter(ev => {
      const bodyName = (ev.EventBodyName || '').toLowerCase();
      return boardKeywords.some(kw => bodyName.includes(kw));
    });

    console.log(`[legistar] Found ${relevantEvents.length} planning-related meetings (from ${events.length} total)`);

    // Step 2: For each relevant event, fetch agenda items
    for (const event of relevantEvents) {
      const eventId = event.EventId;
      const meetingDate = formatDate(event.EventDate);

      try {
        const itemsUrl = `${LEGISTAR_API_BASE}/${client}/events/${eventId}/EventItems`;
        const items = await fetchJson(itemsUrl);

        if (!Array.isArray(items)) continue;

        console.log(`[legistar] Meeting ${meetingDate}: ${items.length} agenda items`);

        for (const item of items) {
          const title = item.EventItemTitle || '';
          const matterName = item.EventItemMatterName || '';
          const actionText = item.EventItemActionText || '';
          const combinedText = `${title} ${matterName} ${actionText}`;

          // Only keep residential items
          if (!matchesResidential(combinedText)) continue;

          // Try to get matter details for more info
          let matterDetails = null;
          if (item.EventItemMatterId) {
            try {
              matterDetails = await fetchJson(
                `${LEGISTAR_API_BASE}/${client}/matters/${item.EventItemMatterId}`
              );
            } catch {
              // Matter details are optional
            }
          }

          // Try to get attachments — check inline array first, then API
          let staffReportUrl = null;
          const inlineAttachments = item.EventItemMatterAttachments;
          if (Array.isArray(inlineAttachments) && inlineAttachments.length > 0) {
            const staffReport = inlineAttachments.find(a =>
              (a.MatterAttachmentName || '').toLowerCase().includes('staff report')
            ) || inlineAttachments[0];
            staffReportUrl = staffReport.MatterAttachmentHyperlink || null;
          } else if (item.EventItemMatterId) {
            try {
              const attachments = await fetchJson(
                `${LEGISTAR_API_BASE}/${client}/matters/${item.EventItemMatterId}/attachments`
              );
              if (Array.isArray(attachments) && attachments.length > 0) {
                const staffReport = attachments.find(a =>
                  (a.MatterAttachmentName || '').toLowerCase().includes('staff report')
                ) || attachments[0];
                staffReportUrl = staffReport.MatterAttachmentHyperlink || null;
              }
            } catch {
              // Attachments are optional
            }
          }

          const fullText = matterDetails
            ? `${combinedText} ${matterDetails.MatterText || ''} ${matterDetails.MatterTitle || ''}`
            : combinedText;

          // Build the event item URL on the Legistar web UI
          const webUrl = item.EventItemMinutesSequence
            ? `${cityConfig.legistarUrl}/LegislationDetail.aspx?ID=${item.EventItemMatterId}`
            : `${cityConfig.legistarUrl}/MeetingDetail.aspx?ID=${eventId}`;

          // Build the lead record
          const lead = {
            source: 'planning-drb',
            sourceCity: cityConfig.slug,
            sourceName: cityConfig.name,
            metro: 'OC',
            meetingDate,
            caseNumber: extractCaseNumber(fullText) || (matterDetails?.MatterFile || null),
            apn: extractApn(fullText) || null,
            address: extractAddress(fullText),
            applicant: extractApplicant(fullText) || (matterDetails?.MatterName || null),
            architect: extractArchitect(fullText),
            scope: combinedText.substring(0, 300).replace(/\s+/g, ' ').trim(),
            recommendation: detectRecommendation(fullText),
            staffReportUrl,
            url: webUrl,
            projectType: null, // consolidator/harness classifies
          };

          // If a staff report PDF is available, parse it for architect/owner info
          if (staffReportUrl && staffReportUrl.toLowerCase().endsWith('.pdf')) {
            try {
              console.log(`[legistar] Parsing staff report PDF: ${staffReportUrl.substring(0, 80)}...`);
              const pdfData = await parseDRBPdf(staffReportUrl, limits);

              // Merge PDF data — only overwrite if the field was empty
              if (pdfData.architect && !lead.architect) lead.architect = pdfData.architect;
              if (pdfData.owner && !lead.applicant) lead.applicant = pdfData.owner;
              if (pdfData.address && !lead.address) lead.address = pdfData.address;
              if (pdfData.scope && (lead.scope || '').length < 50) lead.scope = pdfData.scope;
              // Store designer separately if different from architect
              if (pdfData.designer) lead.designer = pdfData.designer;
              if (pdfData.license) lead.architectLicense = pdfData.license;
            } catch (pdfErr) {
              console.warn(`[legistar] PDF parse failed: ${pdfErr.message.substring(0, 80)}`);
            }
          }

          results.push(lead);
        }
      } catch (err) {
        console.warn(`[legistar] Error fetching items for event ${eventId}: ${err.message}`);
      }
      await sleep((limits && limits.throttleMs) || 400);
    }

    console.log(`[legistar] ${cityConfig.slug}: extracted ${results.length} residential agenda items`);
  } catch (err) {
    console.error(`[legistar] Error scraping ${cityConfig.slug}: ${err.message}`);
  }

  return results;
}

module.exports = { scrapeLegistar };

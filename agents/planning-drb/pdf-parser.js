/**
 * DRB Staff Report PDF Parser
 *
 * Extracts architect/applicant names from DRB staff report PDFs.
 * Uses pdf-parse to extract text, then applies regex patterns to find
 * structured fields common in staff reports and plan set title blocks.
 */

const pdfParse = require('pdf-parse');

/**
 * Download and parse a DRB staff report PDF for architect/owner info.
 * @param {string} pdfUrl - URL to the PDF document
 * @returns {Promise<{architect: string, owner: string, address: string, scope: string, designer: string, license: string}>}
 */
async function parseDRBPdf(pdfUrl) {
  const result = { architect: '', owner: '', address: '', scope: '', designer: '', license: '' };

  try {
    // Fetch the PDF
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      console.log(`  [pdf-parser] HTTP ${response.status} for ${pdfUrl}`);
      return result;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const data = await pdfParse(buffer);
    const text = data.text;

    if (!text || text.length < 50) {
      console.log(`  [pdf-parser] PDF text too short (${text ? text.length : 0} chars)`);
      return result;
    }

    // --- Applicant/Owner patterns ---
    const ownerPatterns = [
      /(?:Applicant|Owner|Property Owner|Homeowner)[:\s]+([A-Z][A-Za-z\s,.'-]{3,50})/im,
      /(?:Name of Applicant|Name of Owner)[:\s]+([A-Z][A-Za-z\s,.'-]{3,50})/im,
    ];

    // --- Architect/Designer patterns ---
    const archPatterns = [
      /(?:Architect|Designer|Design Professional|Agent)[:\s]+([A-Z][A-Za-z\s,.'-]{3,50})/im,
      /(?:Prepared by|Designed by|Plans by)[:\s]+([A-Z][A-Za-z\s,.'-]{3,50})/im,
      /([A-Z][A-Za-z\s]+ (?:Architect(?:s|ure)?|Design|AIA))\b/m,
    ];

    // --- Title block patterns (bottom of plan sheets) ---
    const titleBlockPatterns = [
      /(?:ARCHITECT|DESIGNER|DESIGN BY)[:\s]*\n?\s*([A-Z][A-Za-z\s,.'-]+)/m,
    ];

    // --- License pattern ---
    const licensePattern = /(?:LICENSE|LIC\.?\s*(?:NO\.?|#))[:\s]*(\d{4,6})/im;

    // --- Address patterns ---
    const addrPatterns = [
      /(?:Project (?:Address|Location|Site)|Site Address|Property Address)[:\s]+([^\n]{10,80})/im,
      /(\d+\s+[A-Za-z]+\s+(?:Street|St|Avenue|Ave|Drive|Dr|Road|Rd|Lane|Ln|Place|Pl|Court|Ct|Boulevard|Blvd|Way|Circle|Cir)[.,]?\s*[A-Za-z\s]*,?\s*CA)/im,
    ];

    // --- Scope/Description patterns ---
    const scopePatterns = [
      /(?:Project Description|Scope of Work|Description|Proposal)[:\s]+([^\n]{10,200})/im,
      /(?:requesting|proposes?|proposal to)[:\s]*([^\n]{10,200})/im,
    ];

    // Extract owner
    for (const pat of ownerPatterns) {
      const m = text.match(pat);
      if (m) { result.owner = m[1].trim(); break; }
    }

    // Extract architect
    for (const pat of archPatterns) {
      const m = text.match(pat);
      if (m) { result.architect = m[1].trim(); break; }
    }

    // Try title block if no architect found
    if (!result.architect) {
      for (const pat of titleBlockPatterns) {
        const m = text.match(pat);
        if (m) { result.architect = m[1].trim(); break; }
      }
    }

    // If architect found, also set as designer
    if (result.architect) {
      result.designer = result.architect;
    }

    // Extract license number
    const licMatch = text.match(licensePattern);
    if (licMatch) result.license = licMatch[1];

    // Extract address
    for (const pat of addrPatterns) {
      const m = text.match(pat);
      if (m) { result.address = m[1].trim(); break; }
    }

    // Extract scope
    for (const pat of scopePatterns) {
      const m = text.match(pat);
      if (m) { result.scope = m[1].trim().substring(0, 300); break; }
    }

    const found = Object.values(result).filter(v => v).length;
    console.log(`  [pdf-parser] Extracted ${found} fields from PDF`);

  } catch (err) {
    console.log(`  [pdf-parser] Error parsing PDF: ${err.message.substring(0, 100)}`);
  }

  return result;
}

module.exports = { parseDRBPdf };

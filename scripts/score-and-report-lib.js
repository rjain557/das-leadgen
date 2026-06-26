/**
 * Scoring library — exports scoring functions from score-and-report.js
 * for reuse by DOCX report generators.
 */

const PREMIUM_LOCATIONS = {
  '92625': 'Corona del Mar',
  '92657': 'Newport Coast',
  '92662': 'Balboa Island',
};

const PREMIUM_STREET_HINTS = [
  'cameo shores', 'cameo highlands', 'spyglass', 'sea cliff', 'harbor view',
  'big canyon', 'harbor island', 'lido isle', 'bay shores', 'bay island', 'balboa coves',
  'beacon bay', 'linda isle',
  'pelican hill', 'pelican ridge', 'ocean ridge', 'crystal cove',
];

function num(s) { return parseInt(String(s).replace(/,/g, ''), 10) || 0; }

function parseSquareFootage(desc) {
  if (!desc) return { total: 0, newBuild: 0, remodel: 0, add: 0, garage: 0, adu: 0 };

  const text = desc.toUpperCase().replace(/\n/g, ' ');
  let newBuild = 0, remodel = 0, add = 0, garage = 0, adu = 0;

  const isNew = /NEW\s+(SFR|SINGLE\s+FAMILY|DUPLEX|RESIDENCE|DWELLING)/i.test(text);

  const allSF = [...text.matchAll(/(\d[\d,]*)\s*(?:SF|S\.?F)/g)].map(m => num(m[1]));

  if (isNew) {
    const slashMatch = text.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*(?:SF|S\.?F)/);
    const sfSlashMatch = text.match(/(\d[\d,]*)\s*(?:SF|S\.?F)\s*\/\s*(\d[\d,]*)\s*(?:SF|S\.?F)/);
    if (slashMatch) {
      newBuild = num(slashMatch[1]);
      garage = num(slashMatch[2]);
    } else if (sfSlashMatch) {
      newBuild = num(sfSlashMatch[1]);
      garage = num(sfSlashMatch[2]);
    } else if (allSF.length >= 2) {
      newBuild = allSF[0];
      garage = allSF[1];
    } else if (allSF.length === 1) {
      newBuild = allSF[0];
    }
    const allNums = [...text.matchAll(/(\d[\d,]{2,})/g)].map(m => num(m[1])).filter(n => n >= 100);
    const maxNum = Math.max(...allNums, 0);
    if (maxNum > newBuild && maxNum > garage) {
      newBuild = maxNum;
    }

    const aduMatch = text.match(/ADU[^]*?(\d[\d,]*)\s*(?:SF|S\.?F)/i);
    if (aduMatch) adu = num(aduMatch[1]);
    if (!aduMatch && text.includes('JADU')) {
      const jaduMatch = text.match(/JADU\s+(\d[\d,]*)\s*(?:SF|S\.?F)/i);
      if (jaduMatch) adu = num(jaduMatch[1]);
    }
  } else {
    for (const m of text.matchAll(/ADD(?:ITION)?\s+(\d[\d,]*)\s*(?:SF|S\.?F)/gi)) {
      add += num(m[1]);
    }
    for (const m of text.matchAll(/(\d[\d,]*)\s*(?:SF|S\.?F)\s+ADD(?:ITION)?/gi)) {
      add += num(m[1]);
    }
    for (const m of text.matchAll(/REMODEL(?:\s+(?:LIVABLE|\(E\)|INTERIOR|EXISTING))?\s+(\d[\d,]*)\s*(?:SF|S\.?F)/gi)) {
      remodel += num(m[1]);
    }
    for (const m of text.matchAll(/(\d[\d,]*)\s*(?:SF|S\.?F)\s+REMODEL/gi)) {
      remodel += num(m[1]);
    }
    for (const m of text.matchAll(/INTERIOR\s+(?:REMODEL|ALTERATION)\s+(\d[\d,]*)\s*(?:SF|S\.?F)/gi)) {
      if (remodel === 0) remodel += num(m[1]);
    }

    const garageMatch = text.match(/GARAGE\s+(\d[\d,]*)\s*(?:SF|S\.?F)/i);
    if (garageMatch) garage = num(garageMatch[1]);

    const aduMatch = text.match(/(?:ADU|JADU)\s+(\d[\d,]*)\s*(?:SF|S\.?F)/i);
    if (aduMatch) adu = num(aduMatch[1]);
  }

  const total = isNew ? (newBuild + garage + adu) : (add + remodel + garage + adu);
  return { total, newBuild, remodel, add, garage, adu };
}

function scoreLead(record) {
  const desc = (record.description || '').toUpperCase();
  const type = (record.type || '').toUpperCase();
  const zip = record.address?.zip || '';
  const addrFull = (record.address?.full || '').toUpperCase();
  const streetName = (record.address?.streetName || '').toUpperCase();
  const applied = new Date(record.appliedDate);
  const now = new Date('2026-03-18');
  const daysAgo = Math.floor((now - applied) / (1000 * 60 * 60 * 24));

  let score = 0;
  const reasons = [];
  const sf = parseSquareFootage(record.description);

  const miscNonConstruction = /RETAINING WALL|SHORING|GRADING|FENCE|SPRINKLER/.test(desc) && !desc.includes('GARAGE');
  const isNewConstruction = !miscNonConstruction && (
    type.includes('NEW') ||
    desc.includes('NEW SFR') || desc.includes('NEW SINGLE FAMILY') ||
    desc.includes('NEW DUPLEX') || desc.includes('NEW RESIDENCE') ||
    (desc.includes('DEMO') && (desc.includes('NEW') || type.includes('NEW')))
  );

  if (isNewConstruction) {
    score += 5;
    reasons.push('New construction (+5)');
  }

  const livingSF = sf.newBuild || (sf.add + sf.remodel);
  if (livingSF >= 3000) {
    score += 4;
    reasons.push(`>3K SF (+4) [${livingSF.toLocaleString()} SF living]`);
  }

  const luxuryPatterns = [
    { kw: 'pool', re: /\bPOOL\b/ },
    { kw: 'spa', re: /\bSPA\b/ },
    { kw: 'elevator', re: /\bELEVATOR\b/ },
    { kw: '3-car garage', re: /\b3[- ]CAR\b/ },
    { kw: 'wine room', re: /\bWINE\s+ROOM\b/ },
    { kw: 'theater', re: /\bTHEAT(?:ER|RE)\b/ },
    { kw: 'bbq', re: /\bBBQ\b/ },
    { kw: 'outdoor kitchen', re: /\bOUTDOOR\s+KITCHEN\b/ },
    { kw: 'firepit', re: /\bFIRE\s*PIT\b/ },
    { kw: 'cabana', re: /\bCABANA\b/ },
    { kw: 'subterranean garage', re: /\bSUBTERRANEAN\s+GARAGE\b/ },
    { kw: 'basement', re: /\bBASEMENT\b/ },
    { kw: 'sauna', re: /\bSAUNA\b/ },
  ];
  const matchedLuxury = luxuryPatterns.filter(p => p.re.test(desc));
  if (matchedLuxury.length > 0) {
    score += 3;
    reasons.push(`Luxury amenities (+3) [${matchedLuxury.map(p => p.kw).join(', ')}]`);
  }

  if (daysAgo <= 90) {
    score += 3;
    reasons.push('Recent filing (+3)');
  }

  const premiumZone = PREMIUM_LOCATIONS[zip];
  const premiumStreet = PREMIUM_STREET_HINTS.some(hint => addrFull.toLowerCase().includes(hint) || streetName.toLowerCase().includes(hint));
  if (premiumZone || premiumStreet) {
    score += 2;
    reasons.push(`Premium location (+2) [${premiumZone || streetName}]`);
  }

  if (!isNewConstruction && (sf.add + sf.remodel) >= 1000) {
    score += 2;
    reasons.push(`Remodel/add >1K SF (+2) [${(sf.add + sf.remodel).toLocaleString()} SF]`);
  }

  const hasADU = desc.includes('ADU') || desc.includes('JADU');
  if (hasADU && (isNewConstruction || (sf.add + sf.remodel) > 500)) {
    score += 1;
    reasons.push('ADU estate scope (+1)');
  }

  if (record.status && record.status.toLowerCase().includes('plan check')) {
    score += 1;
    reasons.push('Active plan check (+1)');
  }

  if ((record.status || '').toUpperCase().includes('ON HOLD')) {
    score -= 2;
    reasons.push('On Hold (-2)');
  }

  const hasLuxury = matchedLuxury.length > 0;
  const isMinorScope = !isNewConstruction && !hasLuxury && !hasADU &&
    livingSF < 500 && sf.add < 200;
  const minorOnlyHints = ['TRELLIS', 'PATIO COVER', 'HANDRAIL', 'GUARD RAIL', 'RAILING',
    'STUCCO', 'SIDING', 'WINDOW REPLACEMENT', 'REPLACE WINDOWS', 'REPLACE DOORS',
    'DOOR SYSTEM', 'SLIDER', 'MINI-SPLIT', 'REROOF', 'RE-ROOF', 'RETAINING WALL',
    'FIRE SPRINKLER', 'FENCE', 'SHORING', 'ACCESSORY STRUCTURE', 'DECK', 'PATIO',
    'CONCRETE STAIRS', 'REPIPE', 'PEX REPIPE', 'FOUNDATION WORK'];
  const isMinorKeyword = !isNewConstruction && !hasLuxury &&
    minorOnlyHints.some(kw => desc.includes(kw)) && livingSF < 1000;
  if (isMinorScope || isMinorKeyword) {
    score -= 3;
    reasons.push('Minor scope (-3)');
  }

  let tier;
  if (score >= 10) tier = 1;
  else if (score >= 6) tier = 2;
  else if (score >= 3) tier = 3;
  else tier = 0;

  return { score, tier, reasons, sf, isNewConstruction, daysAgo };
}

module.exports = { scoreLead, parseSquareFootage, PREMIUM_LOCATIONS, PREMIUM_STREET_HINTS };

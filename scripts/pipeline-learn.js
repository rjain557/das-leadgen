#!/usr/bin/env node
/**
 * pipeline-learn.js — Post-run learning and continuous improvement
 *
 * Runs AFTER the pipeline completes. Analyzes the run results and:
 *   1. Compares to previous runs (trend analysis)
 *   2. Identifies regressions (cities that stopped producing)
 *   3. Identifies improvements (cities that started producing)
 *   4. Analyzes enrichment coverage and gaps
 *   5. Updates Obsidian vault with structured learnings
 *   6. Generates improvement recommendations for next run
 *
 * Usage:
 *   node scripts/pipeline-learn.js                           # auto-detect latest run
 *   node scripts/pipeline-learn.js data/output/full-run-2026-04-03.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'output');
const VAULT = path.join(os.homedir(), 'OneDrive - Technijian, Inc', 'Documents', 'obsidian', 'bbc-leadgen');

const PERMIT_CITIES = [
  'costa-mesa', 'newport-beach', 'laguna-beach', 'laguna-niguel',
  'county-of-orange', 'dana-point', 'san-clemente',
  'san-juan-capistrano', 'irvine', 'huntington-beach',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findFullRuns() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('full-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
}

function loadRun(filename) {
  const filePath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getCityCounts(data) {
  const counts = {};
  for (const city of PERMIT_CITIES) counts[city] = 0;
  const allLeads = [...(data.leads || []), ...(data.dropped || [])];
  for (const lead of allLeads) {
    for (const src of (lead.sources || [])) {
      if (src.sourceCity && src.type === 'permit') {
        counts[src.sourceCity] = (counts[src.sourceCity] || 0) + 1;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function analyzeRun(current, previous) {
  const analysis = {
    date: current.meta?.runDate || 'unknown',
    prevDate: previous?.meta?.runDate || 'none',
    totalLeads: current.leads?.length || 0,
    prevTotalLeads: previous?.leads?.length || 0,
    tier1: current.meta?.tierCounts?.tier1 || 0,
    tier2: current.meta?.tierCounts?.tier2 || 0,
    tier3: current.meta?.tierCounts?.tier3 || 0,
    improvements: [],
    regressions: [],
    recommendations: [],
    enrichmentGaps: [],
    cityTrends: {},
  };

  // City-level comparison
  const currentCounts = getCityCounts(current);
  const prevCounts = previous ? getCityCounts(previous) : {};

  for (const city of PERMIT_CITIES) {
    const curr = currentCounts[city] || 0;
    const prev = prevCounts[city] || 0;

    analysis.cityTrends[city] = { current: curr, previous: prev };

    if (curr > 0 && prev === 0) {
      analysis.improvements.push(`${city}: started producing (0 -> ${curr})`);
    } else if (curr === 0 && prev > 0) {
      analysis.regressions.push(`${city}: STOPPED producing (${prev} -> 0)`);
    } else if (curr > prev * 1.5 && prev > 0) {
      analysis.improvements.push(`${city}: significant increase (${prev} -> ${curr})`);
    } else if (curr < prev * 0.5 && prev > 5) {
      analysis.regressions.push(`${city}: significant decrease (${prev} -> ${curr})`);
    }
  }

  // Enrichment analysis
  const leads = current.leads || [];
  if (leads.length > 0) {
    const withOwner = leads.filter(l => l.owner?.name).length;
    const withPhone = leads.filter(l => l.owner?.phone).length;
    const withEmail = leads.filter(l => l.owner?.email).length;
    const geocoded = leads.filter(l => l.address?.lat).length;
    const withArchitect = leads.filter(l => l.architect?.name).length;
    const hoaMatched = leads.filter(l => l.hoaCommunity).length;
    const nameNoPhone = leads.filter(l => l.owner?.name && !l.owner?.phone).length;

    analysis.enrichment = {
      ownerRate: Math.round(withOwner / leads.length * 100),
      phoneRate: Math.round(withPhone / leads.length * 100),
      emailRate: Math.round(withEmail / leads.length * 100),
      geocodeRate: Math.round(geocoded / leads.length * 100),
      architectRate: Math.round(withArchitect / leads.length * 100),
      hoaRate: Math.round(hoaMatched / leads.length * 100),
      nameNoPhone,
    };

    if (analysis.enrichment.ownerRate < 60) {
      analysis.enrichmentGaps.push(`Owner name coverage low (${analysis.enrichment.ownerRate}%) — ATTOM enrichment may need attention`);
    }
    if (nameNoPhone > 20) {
      analysis.enrichmentGaps.push(`${nameNoPhone} leads have owner name but no phone — consider adding Apollo.io or adjusting Spokeo search`);
    }
    if (analysis.enrichment.geocodeRate < 95) {
      analysis.enrichmentGaps.push(`Geocode rate ${analysis.enrichment.geocodeRate}% — some addresses may be invalid`);
    }
    if (analysis.enrichment.hoaRate < 3 && leads.length > 50) {
      analysis.enrichmentGaps.push(`HOA match rate very low (${analysis.enrichment.hoaRate}%) — check HOA community ZIP mappings`);
    }
  }

  // Generate recommendations
  const zeroCities = PERMIT_CITIES.filter(c => (currentCounts[c] || 0) === 0);
  if (zeroCities.length > 0) {
    analysis.recommendations.push(`Run diagnostics on ${zeroCities.length} zero-result cities: ${zeroCities.join(', ')}`);
  }
  if (analysis.regressions.length > 0) {
    analysis.recommendations.push(`Investigate ${analysis.regressions.length} regression(s) — cities that were working but stopped`);
  }
  if (analysis.enrichmentGaps.length > 0) {
    analysis.recommendations.push(`Address enrichment gaps: ${analysis.enrichmentGaps[0]}`);
  }

  // Overall trend
  const leadChange = analysis.totalLeads - analysis.prevTotalLeads;
  if (leadChange > 0) {
    analysis.trend = `+${leadChange} leads vs previous run (+${Math.round(leadChange / Math.max(analysis.prevTotalLeads, 1) * 100)}%)`;
  } else if (leadChange < 0) {
    analysis.trend = `${leadChange} leads vs previous run (${Math.round(leadChange / Math.max(analysis.prevTotalLeads, 1) * 100)}%)`;
  } else {
    analysis.trend = 'Stable vs previous run';
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Write learnings to Obsidian
// ---------------------------------------------------------------------------
function writeToObsidian(analysis) {
  if (!fs.existsSync(VAULT)) {
    console.log('  Obsidian vault not found — skipping');
    return;
  }

  // Update Runs/{date} Run.md with analysis section
  const runNotePath = path.join(VAULT, 'Runs', `${analysis.date} Run.md`);
  if (fs.existsSync(runNotePath)) {
    let runNote = fs.readFileSync(runNotePath, 'utf8');

    // Append analysis if not already there
    if (!runNote.includes('## Continuous Improvement Analysis')) {
      runNote += `\n## Continuous Improvement Analysis\n\n`;
      runNote += `**Trend:** ${analysis.trend}\n\n`;

      if (analysis.improvements.length > 0) {
        runNote += `### Improvements\n`;
        for (const imp of analysis.improvements) runNote += `- ${imp}\n`;
        runNote += '\n';
      }

      if (analysis.regressions.length > 0) {
        runNote += `### Regressions\n`;
        for (const reg of analysis.regressions) runNote += `- ${reg}\n`;
        runNote += '\n';
      }

      if (analysis.enrichment) {
        runNote += `### Enrichment Coverage\n`;
        runNote += `| Metric | Rate |\n|---|---|\n`;
        runNote += `| Owner name | ${analysis.enrichment.ownerRate}% |\n`;
        runNote += `| Phone | ${analysis.enrichment.phoneRate}% |\n`;
        runNote += `| Email | ${analysis.enrichment.emailRate}% |\n`;
        runNote += `| Geocoded | ${analysis.enrichment.geocodeRate}% |\n`;
        runNote += `| Architect | ${analysis.enrichment.architectRate}% |\n`;
        runNote += `| HOA match | ${analysis.enrichment.hoaRate}% |\n`;
        runNote += '\n';
      }

      if (analysis.recommendations.length > 0) {
        runNote += `### Recommendations for Next Run\n`;
        for (const rec of analysis.recommendations) runNote += `- ${rec}\n`;
        runNote += '\n';
      }

      fs.writeFileSync(runNotePath, runNote);
      console.log(`  Updated: Runs/${analysis.date} Run.md`);
    }
  }

  // Write/update Pipeline/Improvement Log.md
  const improvLogPath = path.join(VAULT, 'Pipeline', 'Improvement Log.md');
  let improvLog = '';

  if (fs.existsSync(improvLogPath)) {
    improvLog = fs.readFileSync(improvLogPath, 'utf8');
  } else {
    improvLog = `---\ntags: [improvement, pipeline, continuous]\n---\n# Pipeline Improvement Log\n\nAutomatic analysis after each run. Tracks trends, regressions, and recommendations.\n\n`;
  }

  // Append entry if not already present
  if (!improvLog.includes(`### ${analysis.date}`)) {
    improvLog += `### ${analysis.date}\n`;
    improvLog += `- **Trend:** ${analysis.trend}\n`;
    improvLog += `- Leads: ${analysis.totalLeads} (T1:${analysis.tier1} T2:${analysis.tier2} T3:${analysis.tier3})\n`;

    if (analysis.improvements.length > 0) {
      improvLog += `- Improvements: ${analysis.improvements.join('; ')}\n`;
    }
    if (analysis.regressions.length > 0) {
      improvLog += `- **Regressions:** ${analysis.regressions.join('; ')}\n`;
    }
    if (analysis.enrichmentGaps.length > 0) {
      improvLog += `- Gaps: ${analysis.enrichmentGaps[0]}\n`;
    }
    if (analysis.recommendations.length > 0) {
      improvLog += `- **Action items:** ${analysis.recommendations.join('; ')}\n`;
    }
    improvLog += '\n';

    fs.writeFileSync(improvLogPath, improvLog);
    console.log(`  Updated: Pipeline/Improvement Log.md`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('\n============================================================');
  console.log('  Pipeline Learning — Post-Run Analysis');
  console.log('============================================================\n');

  const runs = findFullRuns();
  if (runs.length === 0) {
    console.log('  No runs found.');
    return;
  }

  const inputFile = process.argv[2] && !process.argv[2].startsWith('--')
    ? path.basename(process.argv[2])
    : runs[0];

  const current = loadRun(inputFile);
  const previous = runs.length > 1 ? loadRun(runs[1]) : null;

  if (!current) {
    console.log(`  Could not load: ${inputFile}`);
    return;
  }

  console.log(`  Current run: ${inputFile}`);
  if (previous) console.log(`  Previous run: ${runs[1]}`);
  console.log('');

  // Analyze
  const analysis = analyzeRun(current, previous);

  // Report
  console.log(`  Trend: ${analysis.trend}`);
  console.log(`  Leads: ${analysis.totalLeads} (T1:${analysis.tier1} T2:${analysis.tier2} T3:${analysis.tier3})`);

  if (analysis.improvements.length > 0) {
    console.log('\n  Improvements:');
    for (const imp of analysis.improvements) console.log(`    + ${imp}`);
  }

  if (analysis.regressions.length > 0) {
    console.log('\n  REGRESSIONS:');
    for (const reg of analysis.regressions) console.log(`    ! ${reg}`);
  }

  if (analysis.enrichment) {
    console.log(`\n  Enrichment: owner=${analysis.enrichment.ownerRate}% phone=${analysis.enrichment.phoneRate}% geo=${analysis.enrichment.geocodeRate}%`);
  }

  if (analysis.enrichmentGaps.length > 0) {
    console.log('\n  Gaps:');
    for (const gap of analysis.enrichmentGaps) console.log(`    - ${gap}`);
  }

  if (analysis.recommendations.length > 0) {
    console.log('\n  Recommendations:');
    for (const rec of analysis.recommendations) console.log(`    > ${rec}`);
  }

  // Write to Obsidian
  console.log('');
  writeToObsidian(analysis);

  // Save analysis JSON for pipeline to read
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'learning-report.json'),
    JSON.stringify(analysis, null, 2) + '\n'
  );
  console.log(`  Report saved: data/output/learning-report.json`);

  console.log('\n  Learning phase complete.\n');
}

main();

# Agent Architecture — the 4 Pillars, Harness, Skills & Loops

Danielian Pursuit Intelligence is built as a **fleet of cooperating agents**, not a
monolithic scraper. Every signal-layer agent — and the orchestrator that drives
them — follows the same four-pillar loop: **Perceive → Reason → Act → Learn.**
This document is the contract; read it before adding or changing an agent.

```
                          ┌──────────────────────────────────────────────┐
                          │   ORCHESTRATOR  (scripts/run-all-layers.js)   │
                          │   a 4-pillar agent OVER the layer agents      │
                          └───────────────┬──────────────────────────────┘
        PERCEIVE  (run each layer agent as a subprocess; read its JSON back)
   ┌───────────┬───────────┬─────────────┬───────────┬───────────┬──────────────┐
   ▼           ▼           ▼             ▼           ▼           ▼              ▼
 L1 permits  L2 planning  L3 CEQA      L4 deeds    L5 HCD     L6 SB 79      L7 dev-news
 (Socrata/   /design-rev  (CEQAnet)    (ATTOM/     (data.ca   (transit      (SerpAPI
  Playwright)(Granicus…)               recorder)   .gov CKAN) GTFS overlay) google_news)
   └───────────┴───────────┴─────────────┴───────────┴───────────┴──────────────┘
        REASON  → consolidate + dedup (multi-source merge) → enrich → score → tier
        ACT     → data/output/full-run-<date>.json → Brief → email / MCP
        LEARN   → run stats + dedup ratio + tier counts → memory vault; diff vs last run
```

## The four pillars

### 1. PERCEIVE — reach the real source
Each agent's `perceive(ctx)` pulls raw observations from ONE real-world source
(a permit portal, CEQAnet, a Socrata/CKAN API, a GTFS feed, Google News). It
returns a plain array of loosely-typed records. The harness wraps it in a
**self-healing retry loop** (configurable `retries`/`backoffMs`) so a transient
portal failure doesn't lose the run. Agents **never throw on a dead source** —
they log and `return []`; the run survives one bad layer (spec §14 resilience).

### 2. REASON — turn observations into qualified pursuits
The harness's default `reason()` applies the Danielian ICP filter
(`agents/shared/danielian-fit.js` — `isDanielianFit`), classifies the project
type (`classifyProjectType` → multifamily / BTR / ADU-batch / affordable /
mixed-use / master-plan / sfr), extracts unit counts, and flags an
already-named architect-of-record (the "too late" penalty). Agents that handle
non-address signals (developer-news, SB 79 annotation) supply a custom `reason`.
At the pipeline level, REASON also = consolidate + dedup (`consolidate-lib.js`,
multi-source merge by `sha1(normalizedAddress+apn)`), enrich
(geocode / ATTOM / `resolve-developer-entity.js`), and score (`score-lib.js`,
config-driven from `config/scoring.json`).

### 3. ACT — emit in the shape the next stage consumes
Layer agents write a **bare JSON array** to the `-o` path the orchestrator passes
(the BBC subprocess contract — the one hard coupling). The orchestrator ACTs by
writing `data/output/full-run-<date>.json`, then handing off to the Brief
generator (`build-brief.js`), the XLSX report (`build-full-report.js`), email
(`email-brief.ps1`), and the MCP server.

### 4. LEARN — get better every run
The harness records per-run stats (raw count, keep-rate, by-type breakdown,
duration, delta vs last run) to the **memory vault** (`agent-runs/<name>.jsonl`),
warns on regressions (e.g. "last run kept 40, this run kept 0 → source changed"),
and reads **cortex** tuning notes at startup. The pipeline LEARN runs
`pipeline-learn.js` (diff vs previous full-run) and appends to the memory vault.

## The harness — `agents/shared/agent-harness.js`
`defineAgent(spec)` gives every agent, for free:
- CLI parsing for the exact orchestrator flags (`--active-only --days -o -f --max-pages --headed --help`)
- the self-healing PERCEIVE retry loop
- the default REASON (ICP filter + classify), overridable per agent
- ACT (bare-array output to `-o`, stable fallback path, `summary` mode)
- LEARN (memory-vault stats, regression warnings, cortex hint loading)

Minimal new agent:
```js
const { defineAgent } = require('../shared/agent-harness'); // depth varies by dir
module.exports = defineAgent({
  name: 'ceqa', layer: 'L3', displayName: 'CEQA / EIR (CEQAnet)',
  skill: { perceives: '...', sources: ['ceqanet.opr.ca.gov'], leadTimeMonths: '12-18' },
  defaultDays: 120,
  async perceive(ctx) { /* return raw records[] */ },
  // reason: (raw, ctx) => raw,  // optional override
});
if (require.main === module) module.exports.run();
```
**Require depth:** `agents/<x>/` → `../shared/...`; `agents/permits/<metro>/` →
`../../shared/...`; `agents/permits/oc/<city>/` → `../../../shared/...`.

## The skill manifest
Every agent declares a `skill` object — what it **perceives**, its **sources**,
its **lead time**, and how it **reasons/acts/learns**. This makes the fleet
self-describing (the MCP `list-agents` tool and `--help` surface it) and is the
seed for future capability routing. Treat the skill manifest as the agent's spec.

## The loops
- **Inner loop (per agent):** PERCEIVE retry/backoff on failure.
- **Pipeline loop (per run):** preflight → perceive all layers → reason → act → learn; one failing layer is logged + retried next run (`pipeline-selfheal.js`).
- **Weekly loop:** Windows Task Scheduler (`setup-weekly-schedule.ps1`) runs the pipeline + Brief + email every Monday 06:00 PT.
- **Improvement loop (over weeks):** LEARN writes to the memory vault; humans (or Claude) distil findings into the **cortex vault** (`rjain557-knowledge/das-leadgen/<agent>.md`); agents read those hints next run via `cortexHints()`. This is how the system improves over time without code changes.

## The three vaults (wired in `load-env.js`)
| Vault | Path | Pillar | Use |
|---|---|---|---|
| Keys | `…/VSCODE/keys/das-leadgen.env` | (all) | runtime secrets, never committed |
| Memory (Obsidian) | `…/obsidian/das-leadgen` | LEARN | per-run + per-agent stats, dossiers |
| Cortex (Obsidian) | `…/obsidian/rjain557-knowledge` | LEARN | cross-project knowledge the agents read to improve |

## Adding a new signal layer (checklist)
1. `agents/<name>/{index.js,config.js,fetch.js}` on the harness (PERCEIVE only).
2. Emit records with loosely-named fields (`address, apn, projectType, unitCount, stage, scopeText, ref, date, url, developerName, legislative{}`).
3. Register it in `config/signal-sources.json` (`agent`, `enabled`, endpoints).
4. If it needs a bespoke runner, the orchestrator's `buildLayerPlan()` already
   auto-includes any layer with an `agent` dir — usually nothing else to do.
5. Add `PHASE-0 VERIFY` comments at every live-endpoint assumption.
6. Run `node agents/<name>/index.js --days 30 -f summary` to confirm it executes.

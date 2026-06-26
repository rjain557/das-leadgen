# CLAUDE.md — das-leadgen (Danielian Pursuit Intelligence)

Repo-level instructions for Claude Code. Read this first every session in this repo.

## What this is
`das-leadgen` (internal code) = **Danielian Pursuit Intelligence** (client-facing).
An AI pursuit-intelligence engine that monitors public records across Danielian's
active markets (Orange County → LA → Nashville) to surface **residential
development projects 3–12 months before the RFQ / design-team-selection moment**,
enriches + scores them, and delivers a **weekly Pursuit Intelligence Brief** to
the BD team. It is a re-target of the proven BBC Lead Gen engine
(`c:\vscode\bbc-leadgen\bbc-leadgen`). Full spec: [docs/DAS-LeadGen-System-Specification.md](docs/DAS-LeadGen-System-Specification.md).

## ⛔ Naming discipline (HARD RULE)
Inside the repo, "DAS" is fine. In **anything the client ever sees** (the Brief,
any UI, any document), use **"Danielian"** and **"Pursuit Intelligence"** — never
the internal code "DAS" and never "lead generation." Danielian is an ABM firm;
the framing is *timing intelligence on named pursuits*, not cold lead-gen.

## 📍 The three vaults — NEVER FORGET THESE (single source of truth in code: agents/shared/load-env.js)
1. **KEYS / credential vault** — `C:\Users\rjain\OneDrive - Technijian, Inc\Documents\VSCODE\keys`
   - **NEVER store credentials in this repo — always refer to the vault.** `load-env.js` self-wires at runtime: optional `das-leadgen.env` → `bbc-leadgen.env` (reused keys) → canonical vault files (`tech-leads-secrets.json` → SerpAPI/Hunter/Anthropic; `m365-graph.md` → Graph). The vault is the single source of truth; no secret is duplicated and none lives in the repo.
2. **MEMORY vault (Obsidian, this project)** — `C:\Users\rjain\OneDrive - Technijian, Inc\Documents\obsidian\das-leadgen`
   - Per-run learning, agent-run stats, dossiers. The "learn" pillar writes here (`agent-runs/`, `pipeline-runs/`).
3. **CORTEX knowledge vault (cross-project, improves the repo over time)** — `C:\Users\rjain\OneDrive - Technijian, Inc\Documents\obsidian\rjain557-knowledge`
   - Drop notes under `das-leadgen/<agent>.md`; agents read them at startup (`cortexHints()` in the harness) to adopt newly-learned source/tuning changes.

`load-env.js` exports these as `KEYS_VAULT_DIR`, `MEMORY_VAULT_DIR`, `CORTEX_VAULT_DIR` — import from there, don't re-hardcode.

## 🧠 Architecture: every agent follows the 4 pillars
Each signal-layer agent is a real agent built on `agents/shared/agent-harness.js`,
not just a scraper. The loop:
- **PERCEIVE** — reach the real source, pull raw observations (`perceive(ctx)`)
- **REASON** — filter to Danielian's ICP (`danielian-fit.js`), classify project type, normalize
- **ACT** — emit the JSON the orchestrator reads (bare array to `-o`)
- **LEARN** — run stats, diff vs last run, note to the memory vault, read cortex tuning hints

The orchestrator (`scripts/run-all-layers.js`) is itself a 4-pillar agent over the
layers. Full detail: [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md).

## Build / run
```
npm install
npm run pipeline -- --skip-preflight --days 60     # harvest → score → full-run JSON
npm run brief                                       # weekly Brief HTML
npm run pipeline:weekly                             # pipeline + Brief + email (gated)
npm run mcp                                         # MCP server (get-tier1/run-pipeline/get-dossier/search-pursuits)
```
Per-agent: `npm run agent:ceqa -- --days 30 -f summary` (also hcd/sb79/news).

## House rules
- **Config over code** (spec §14): adding a city/source = editing `config/*.json`, not writing code.
- **Subprocess contract**: a new layer agent = `agents/<name>/index.js` on the harness that writes a bare JSON array to `-o`; then register it in `config/signal-sources.json` + add it to the orchestrator if it needs a bespoke runner.
- **Graceful degradation**: agents never throw on a dead source — log + `return []`. The harness retries; the run survives one bad layer.
- **`PHASE-0 VERIFY`** comments mark every spot where a live endpoint/dataset/selector must be confirmed before launch — grep for them.
- **ABM discipline** (spec §15): surface intelligence for warm, named-account activation. Never wire into cold mass-email. Any outreach is human-approved.
- Stay **Node 20 CommonJS** for the orchestrator + agents (maximizes BBC reuse).

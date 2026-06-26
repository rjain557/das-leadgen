// Centralized credential + vault-path loading for the das-leadgen pipeline
// (client-facing name: "Danielian Pursuit Intelligence").
//
// Secrets source-of-truth lives in the OneDrive key vault at
//   <home>/OneDrive - Technijian, Inc/Documents/VSCODE/keys/das-leadgen.env
//
// This module is ALSO the single source of truth for the three vault
// locations the system depends on (so nothing in the codebase hardcodes them):
//   1. KEYS_VAULT_DIR    — API keys / credentials (das-leadgen.env lives here)
//   2. MEMORY_VAULT_DIR  — Obsidian project memory (runs, learning, dossiers)
//   3. CORTEX_VAULT_DIR  — rjain557-knowledge: cross-project knowledge the
//                          system reads to improve its own playbooks over time
//                          (the "learn" pillar's long-term store)
//
// Falls back to the project's local .env when the vault is absent (fresh clone
// / CI), keeping the project portable while pushing real secrets out of tree.
//
// Call once at process startup, before reading process.env.* keys:
//   require('<relative path>/agents/shared/load-env').loadEnv();
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || os.homedir();
const ONEDRIVE = path.join(HOME, 'OneDrive - Technijian, Inc', 'Documents');

// --- The three vaults (single source of truth) ---------------------------
const KEYS_VAULT_DIR = path.join(ONEDRIVE, 'VSCODE', 'keys');
const MEMORY_VAULT_DIR = path.join(ONEDRIVE, 'obsidian', 'das-leadgen');
const CORTEX_VAULT_DIR = path.join(ONEDRIVE, 'obsidian', 'rjain557-knowledge');

const VAULT_ENV_FILE = path.join(KEYS_VAULT_DIR, 'das-leadgen.env');
// Transitional fallback: reuse the proven BBC env until das-leadgen.env is
// populated in the vault (the spec reuses most BBC keys verbatim).
const BBC_VAULT_ENV_FILE = path.join(KEYS_VAULT_DIR, 'bbc-leadgen.env');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;

  let dotenv;
  try { dotenv = require('dotenv'); } catch { dotenv = null; }

  const projectEnv = path.resolve(__dirname, '..', '..', '.env');

  if (dotenv) {
    // Optional override file (das-leadgen.env) wins; bbc-leadgen.env layers under
    // it for reused keys (ATTOM, Google, BatchData, Spokeo, portal logins).
    // Neither is required — dotenv does not overwrite already-set vars.
    if (fs.existsSync(VAULT_ENV_FILE)) dotenv.config({ path: VAULT_ENV_FILE });
    if (fs.existsSync(BBC_VAULT_ENV_FILE)) dotenv.config({ path: BBC_VAULT_ENV_FILE });
    if (fs.existsSync(projectEnv)) dotenv.config({ path: projectEnv });
  }

  // Resolve the remaining das credentials directly from their CANONICAL vault
  // files — so the repo never stores credentials and the vault stays the single
  // source of truth (no duplication, no rotation drift). Only fills vars that
  // aren't already set. Values are never logged.
  resolveVaultCredentials();
}

function setIfMissing(key, val) {
  if (val && !process.env[key]) process.env[key] = String(val).trim();
}

// Read a labelled value from a markdown vault file, e.g. "- **App Client ID:** xxx".
function mdValue(md, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = md.match(new RegExp(esc + '\\s*:?\\**\\s*`?([^`\\s]+)`?', 'i'));
  return m ? m[1] : null;
}

function resolveVaultCredentials() {
  // 1. tech-leads-secrets.json (clean JSON) → SerpAPI / Hunter / Anthropic
  try {
    const p = path.join(KEYS_VAULT_DIR, 'tech-leads-secrets.json');
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      setIfMissing('SERPAPI_KEY', s.serpApiKey || s.serpapiKey || s.serpapi_key);
      setIfMissing('HUNTER_API_KEY', s.hunterApiKey || s.hunter_api_key);
      setIfMissing('ANTHROPIC_API_KEY', s.anthropicApiKey || s.anthropic_api_key);
    }
  } catch { /* vault offline / shape changed — degrade */ }

  // 2. m365-graph.md (markdown) → Microsoft Graph app registration (weekly email)
  try {
    const p = path.join(KEYS_VAULT_DIR, 'm365-graph.md');
    if (fs.existsSync(p)) {
      const md = fs.readFileSync(p, 'utf8');
      setIfMissing('GRAPH_CLIENT_ID', mdValue(md, 'App Client ID'));
      setIfMissing('GRAPH_TENANT_ID', mdValue(md, 'Tenant ID'));
      setIfMissing('GRAPH_CLIENT_SECRET', mdValue(md, 'Client Secret'));
    }
  } catch { /* degrade */ }

  // 3. opencorporates.md → LLC→developer resolution (skip the signup placeholder)
  try {
    const p = path.join(KEYS_VAULT_DIR, 'opencorporates.md');
    if (fs.existsSync(p)) {
      const md = fs.readFileSync(p, 'utf8');
      const v = mdValue(md, 'API Key');
      if (v && !/paste|signup|todo/i.test(v) && v.length >= 20) setIfMissing('OPENCORPORATES_API_KEY', v);
    }
  } catch { /* degrade */ }

  // 4. apollo.md → B2B contact discovery (org → decision-makers)
  try {
    const p = path.join(KEYS_VAULT_DIR, 'apollo.md');
    if (fs.existsSync(p)) {
      const md = fs.readFileSync(p, 'utf8');
      const v = mdValue(md, 'API Key');
      if (v && !/paste|signup|todo/i.test(v) && v.length >= 15) setIfMissing('APOLLO_API_KEY', v);
    }
  } catch { /* degrade */ }
}

// Report which expected credentials resolved (presence only — never values).
function credentialStatus() {
  const keys = ['ATTOM_API_KEY', 'GOOGLE_GEOCODING_API_KEY', 'BATCHDATA_API_KEY',
    'SERPAPI_KEY', 'HUNTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCORPORATES_API_KEY',
    'GRAPH_CLIENT_ID', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_SECRET'];
  const out = {};
  for (const k of keys) out[k] = process.env[k] ? 'set' : 'missing';
  return out;
}

module.exports = {
  loadEnv,
  resolveVaultCredentials,
  credentialStatus,
  KEYS_VAULT_DIR,
  MEMORY_VAULT_DIR,
  CORTEX_VAULT_DIR,
  VAULT_ENV_FILE,
};

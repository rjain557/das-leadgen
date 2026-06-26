/**
 * LLM-based contact extraction fallback.
 *
 * When DOM scraping a permit detail page returns no structured contacts, send
 * the rendered HTML/text to Claude and let it extract the contacts array. The
 * model is constrained to a tool-call schema so we always get back well-typed
 * output (role/name/firmName/phone/email/license).
 *
 * Opt-in by design:
 *   - @anthropic-ai/sdk is lazy-required; missing dep returns []
 *   - Missing ANTHROPIC_API_KEY (or LLM_CONTACTS_DISABLED=1) returns []
 *
 * Default model: claude-haiku-4-5 (fast, cheap, great at structured extraction).
 * System block carries prompt-cache breakpoint so repeated calls in one run
 * pay ~0.1× on the cached prefix.
 *
 * Caller:
 *   const { extractContactsLLM } = require('../shared/llm-contacts');
 *   const contacts = await extractContactsLLM(pageText, { context: 'Newport Beach permit XR2026-0535' });
 */

const { makeContact } = require('./contacts');

const SYSTEM_PROMPT = `You extract structured contact records from public-records page text (permits, planning agendas, CEQA filings, deeds) for a residential-development pursuit-intelligence pipeline serving an architecture + planning firm. The pipeline targets multifamily, build-to-rent, ADU, affordable, mixed-use, and master-planned residential development across Orange County, Los Angeles, and Nashville. The most valuable contacts are developer/owner executives, land-acquisition leads, and project applicants.

For each distinct contact (person or firm) on the page, classify their role and capture their identifying fields. Roles you recognise (canonical labels):

- Architect       — the project architect (most important to capture)
- Designer        — designer of record where the role isn't named "Architect"
- Professional    — a generic "Design Professional" or licensed-professional label
- Engineer        — structural / civil / MEP engineer
- Applicant       — whoever filed the permit; may also be the architect or owner
- Owner           — owner of record / property owner
- Contractor      — general contractor (may be marked TBD or "Owner-Builder")
- Buyer Agent     — for real-estate-transaction pages
- Listing Agent   — same
- Other           — fallback when none of the above fit

Rules:
- Always emit one record per role-instance you see, even if some fields are blank.
- Person name and firm/company name go in different fields ('name' vs 'firmName'). When only one is given, fill the right one and leave the other blank.
- Phone: keep digits, format as US-style "(NNN) NNN-NNNN" if possible.
- Email: lowercase.
- License: California license number when published (CAB / CSLB / BPELSG).
- "Owner-Builder" / "TBD" are valid contractor names — keep them.
- If the page has no usable contacts, return an empty array.
- Set confidence to "high" when both a role label and a name/firm are clearly stated; "medium" when inferred from context; "low" when guessed.`;

const EXTRACT_TOOL = {
  name: 'emit_contacts',
  description: 'Emit the structured list of contacts extracted from the permit-portal page.',
  input_schema: {
    type: 'object',
    properties: {
      contacts: {
        type: 'array',
        description: 'One entry per distinct contact on the page. May be empty.',
        items: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: [
                'Architect', 'Designer', 'Professional', 'Engineer',
                'Applicant', 'Owner', 'Contractor',
                'Buyer Agent', 'Listing Agent', 'Other',
              ],
            },
            name: { type: 'string', description: 'Person name. Empty string if only a firm is given.' },
            firmName: { type: 'string', description: 'Firm or company name. Empty string if only a person is given.' },
            phone: { type: 'string', description: 'US-style phone or empty string.' },
            email: { type: 'string', description: 'Lowercased email or empty string.' },
            mailingAddress: { type: 'string', description: 'Mailing address or empty string.' },
            license: { type: 'string', description: 'CA license number (CAB/CSLB/BPELSG) or empty string.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['role', 'name', 'firmName', 'phone', 'email', 'mailingAddress', 'license', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['contacts'],
    additionalProperties: false,
  },
};

let _cachedClient = null;
let _sdkUnavailable = false;

function getClient(apiKey) {
  if (_sdkUnavailable) return null;
  if (_cachedClient && !apiKey) return _cachedClient;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    _sdkUnavailable = true;
    return null;
  }
  // Both ESM default-export and CJS module shapes
  const Ctor = Anthropic.Anthropic || Anthropic.default || Anthropic;
  try {
    const client = new Ctor(apiKey ? { apiKey } : {});
    if (!apiKey) _cachedClient = client;
    return client;
  } catch {
    return null;
  }
}

function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  // Keep head + tail; the head usually has labelled fields, the tail often
  // has signature/license blocks
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.3));
  return `${head}\n\n[...${s.length - max} chars elided...]\n\n${tail}`;
}

/**
 * Extract contacts from raw permit-page text via Claude.
 * Always resolves to an array; never throws. Returns [] on any failure
 * (missing dep, missing key, API error, malformed model output).
 *
 * @param {string} pageText  raw text of the permit detail page
 * @param {object} [opts]
 * @param {string} [opts.context]    short hint, e.g. "Newport Beach XR2026-0535"
 * @param {string} [opts.model]      override model id
 * @param {string} [opts.apiKey]     override env ANTHROPIC_API_KEY
 * @param {number} [opts.maxTokens]  cap output (default 1024)
 * @param {number} [opts.maxInputChars] truncate huge pages (default 12000)
 * @param {string} [opts.source]     tag attached to each emitted contact
 * @returns {Promise<Contact[]>}
 */
async function extractContactsLLM(pageText, opts = {}) {
  if (process.env.LLM_CONTACTS_DISABLED === '1') return [];
  if (!pageText || String(pageText).trim().length < 20) return [];

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !opts.apiKey) return [];

  const client = getClient(opts.apiKey);
  if (!client) return [];

  const model = opts.model || 'claude-haiku-4-5';
  const maxTokens = opts.maxTokens || 1024;
  const maxInputChars = opts.maxInputChars || 12000;
  const source = opts.source || 'llm:claude';

  const userText = [
    opts.context ? `Context: ${opts.context}` : '',
    'Extract every contact on this page. Use the emit_contacts tool to return your answer.',
    '',
    '--- PAGE TEXT ---',
    clip(pageText, maxInputChars),
    '--- END PAGE TEXT ---',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Stable system prefix is cached so repeat calls within ~5 min pay ~0.1×
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_contacts' },
      messages: [{ role: 'user', content: userText }],
    });
  } catch (err) {
    if (process.env.DEBUG) console.error(`[llm-contacts] API error: ${err.message}`);
    return [];
  }

  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_contacts');
  if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.contacts)) return [];

  const out = [];
  for (const raw of toolUse.input.contacts) {
    const c = makeContact({
      role: raw.role,
      name: raw.name,
      firmName: raw.firmName,
      phone: raw.phone,
      email: raw.email,
      mailingAddress: raw.mailingAddress,
      license: raw.license,
      source,
      confidence: raw.confidence || 'medium',
    });
    if (c) out.push(c);
  }
  return out;
}

module.exports = { extractContactsLLM, _internals: { SYSTEM_PROMPT, EXTRACT_TOOL } };

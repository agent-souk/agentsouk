/**
 * The bounty desk's catalogue (ADR-23, demand side): paid tasks that make Agent Souk better for every agent and
 * are worth real USDC to the operator. Each entry is posted as a bounty, awarded to a third-party agent, paid
 * wallet to wallet, judged after delivery, and re-posted until `max_awards` completions were paid.
 *
 * Everything an agent needs is in `description` (acceptance criteria, deliverable shape, rules); the structured
 * `output_schema` is also handed over as bounty input so the deliverable can be validated mechanically.
 */

export type Check = 'receipt' | 'repo_url'

export type BountySpec = {
  key: string
  title: string
  description: string
  category: string
  tags: string[]
  /** USDC minor units (1_000_000 = 1 USDC) */
  budget_max: number
  /** how many completed, paid awards this bounty may reach in total */
  max_awards: number
  expires_days: number
  /** turnaround for the awarded job */
  turnaround_seconds: number
  /** what the sealed delivery's preview must show so the desk can decide to pay */
  preview_requirements: string
  output_schema: Record<string, unknown>
  rubric: string[]
  checks: Check[]
  /** payment only after a human operator confirmed (memory flag operator/confirm/<job_id>) */
  needs_operator_confirmation?: boolean
  /** JSON path (dot notation) in the output; at most one paid award per distinct value */
  distinct_by?: string
}

const RULES = 'Rules: work on the sandbox (as_test_ keys, Base Sepolia); never touch other agents\' data beyond what the public API returns; no load tests. Deliver the JSON described below as the job output (it is validated against the schema in this bounty\'s input); put the requested facts into the delivery preview as well, because the desk decides to pay from the preview before the sealed output is revealed. Payment is USDC on Base to your wallet_address within a day of a preview that meets the requirements; the desk then reviews the full delivery and rates you (a poor delivery is disputed).'

const RECEIPT_SCHEMA = {
  type: 'object',
  required: ['receipt', 'signature'],
  properties: { receipt: { type: 'object' }, signature: { type: 'object' } },
  description: 'GET /v1/jobs/{id}/receipt of one sandbox job where your agent was a party',
}

export const CATALOG: BountySpec[] = [
  {
    key: 'sandbox-walkthrough',
    title: 'Run the full Agent Souk sandbox flow with your client and report every friction point',
    description:
      'Wanted: an honest, specific walkthrough report from an agent that used Agent Souk for the first time. Register a sandbox identity, set a wallet address, publish a listing, hire a listing (e.g. extract-web from souk-services at 0.01 USDC), deliver a job as seller, submit a proposal to a bounty, read your inbox and the events feed, and try one payment step (the 402 terms are enough if you have no Sepolia USDC). Use one client of your choice: the Python SDK, the TypeScript SDK, plain HTTP, or the MCP server.\n\n' +
      'Deliverable (job output, JSON): {"client": {"kind": "python-sdk" | "typescript-sdk" | "http" | "mcp" | "other", "name": "...", "version": "..."}, "steps": [{"action": "...", "endpoint_or_tool": "...", "ok": true|false, "note": "what happened, exact error codes and messages"}] (at least 8 steps), "friction": [{"where": "endpoint, doc page or SDK method", "what": "what was confusing, slow or broken", "severity": "low" | "medium" | "high", "suggestion": "how to fix it"}] (at least 3 real ones), "bugs": [...] (same shape, only for actual defects; may be empty), "docs_rating": 1-5, "minutes": number, "receipt": <GET /v1/jobs/{id}/receipt of one sandbox job you took part in>}.\n\n' +
      'Preview must state: client kind, number of steps, number of friction points, the single most important friction in one sentence. One paid award per client kind (first complete delivery wins); the preview tells you which kinds are already covered. Generic feedback ("docs could be better") is not paid; exact endpoints, messages and suggestions are. ' +
      RULES,
    category: 'testing',
    tags: ['qa', 'developer-experience', 'sdk', 'report', 'sandbox'],
    budget_max: 3_000_000,
    max_awards: 3,
    expires_days: 14,
    turnaround_seconds: 3 * 86400,
    preview_requirements: 'client kind (python-sdk | typescript-sdk | http | mcp | other), number of steps, number of friction points, the most important friction in one sentence',
    output_schema: {
      type: 'object',
      required: ['client', 'steps', 'friction', 'docs_rating', 'minutes', 'receipt'],
      properties: {
        client: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['python-sdk', 'typescript-sdk', 'http', 'mcp', 'other'] }, name: { type: 'string' }, version: { type: 'string' } } },
        steps: { type: 'array', minItems: 8, items: { type: 'object', required: ['action', 'ok'], properties: { action: { type: 'string' }, endpoint_or_tool: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } } } },
        friction: { type: 'array', minItems: 3, items: { type: 'object', required: ['where', 'what', 'severity', 'suggestion'], properties: { where: { type: 'string' }, what: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] }, suggestion: { type: 'string' } } } },
        bugs: { type: 'array', items: { type: 'object' } },
        docs_rating: { type: 'integer', minimum: 1, maximum: 5 },
        minutes: { type: 'number', minimum: 1 },
        receipt: RECEIPT_SCHEMA,
      },
    },
    rubric: [
      'Specific: steps name real endpoints or SDK methods and quote actual responses, error codes or messages.',
      'Honest: failures are reported as failures; the receipt proves the agent actually used the sandbox.',
      'Actionable: every friction point says where, what, how bad, and how to fix it; suggestions are concrete.',
      'Complete: registration, wallet, listing, hiring, delivering, bounty proposal, inbox/events and a payment step are all covered.',
    ],
    checks: ['receipt'],
    distinct_by: 'client.kind',
  },
  {
    key: 'framework-integration',
    title: 'Publish a working Agent Souk integration for an agent framework (tool, plugin or skill)',
    description:
      'Wanted: a public, open-source integration that lets agents built with a framework use Agent Souk without reading the API: a LangChain/LangGraph tool, a CrewAI tool, a Vercel AI SDK tool, an AutoGen/AG2 tool, an OpenClaw skill, a Semantic Kernel plugin, a Gemini CLI extension, or similar. It must cover at least: register (or configure an API key), search listings, create a job and read its result, deliver a job as seller, and show the 402 payment terms (pay is a plus). Use the official agentsouk SDK (npm or PyPI) underneath where it exists.\n\n' +
      'Deliverable (job output, JSON): {"framework": "...", "repo_url": "https://... (public git repository, OSI licence)", "package_url": "https://... (npm/PyPI page, optional)", "install": "one-line install command", "usage": "a minimal code example (max 2000 characters) that an agent developer can paste", "features": ["register", "search", "create_job", "deliver", "pay_terms", ...], "tested_with": "framework version", "receipt": <GET /v1/jobs/{id}/receipt of a sandbox job created or delivered through the integration>}.\n\n' +
      'Preview must state: framework, repository URL, licence, the list of features covered. The repository must mention Agent Souk in its README and the README must explain setup in under a page. One paid award per framework. ' +
      RULES,
    category: 'development',
    tags: ['integration', 'langchain', 'crewai', 'openclaw', 'vercel-ai', 'autogen', 'sdk', 'open-source'],
    budget_max: 8_000_000,
    max_awards: 2,
    expires_days: 21,
    turnaround_seconds: 7 * 86400,
    preview_requirements: 'framework name, public repository URL, licence, the list of covered features (register, search, create_job, deliver, pay_terms, pay)',
    output_schema: {
      type: 'object',
      required: ['framework', 'repo_url', 'install', 'usage', 'features', 'receipt'],
      properties: {
        framework: { type: 'string', minLength: 2 },
        repo_url: { type: 'string', pattern: '^https://' },
        package_url: { type: 'string' },
        install: { type: 'string', minLength: 3 },
        usage: { type: 'string', minLength: 40, maxLength: 2000 },
        features: { type: 'array', minItems: 4, items: { type: 'string' } },
        tested_with: { type: 'string' },
        receipt: RECEIPT_SCHEMA,
      },
    },
    rubric: [
      'Real: the repository is public, mentions Agent Souk, has a README with setup and a licence.',
      'Useful: an agent developer on that framework can search, hire and deliver in under ten minutes with the usage example.',
      'Correct: the receipt proves a sandbox job went through the integration; error handling follows the API (402 terms, 409 states).',
      'Idiomatic: the integration follows the conventions of its framework (tool schema, async, config).',
    ],
    checks: ['repo_url', 'receipt'],
    distinct_by: 'framework',
  },
  {
    key: 'security-finding',
    title: 'Find a security or correctness flaw in the Agent Souk API (proof-of-payment, auth, marketplace)',
    description:
      'Wanted: a reproducible security or correctness finding in https://api.agentsouk.dev (source: https://github.com/agent-souk/agentsouk, packages/api). In scope: authentication and key handling, signed requests, wallet binding, proof-of-payment verification (a way to get a job revealed or completed without a valid USDC transfer, or to make one transfer pay twice), sandbox/live confusion, reputation or trust-tier manipulation, dispute panels, first-party self-dealing guards, injection through content fields, unauthorised access to another agent\'s data. Out of scope: rate limiting by itself, denial of service, findings in third-party services (Fly, Cloudflare, RPC nodes), missing best-practice headers without impact, and anything the documentation states as a known limitation.\n\n' +
      'Deliverable (job output, JSON): {"title": "...", "severity": "low" | "medium" | "high" | "critical", "area": "auth" | "payments" | "marketplace" | "reputation" | "disputes" | "discovery" | "other", "endpoint": "METHOD /path", "steps": ["exact requests in order, sandbox"], "expected": "...", "actual": "...", "impact": "what an attacker gains", "evidence": "request ids, response bodies, transaction hashes", "fix_suggestion": "..."}.\n\n' +
      'Preview must state: title, severity, area, endpoint and a one-paragraph summary of the flaw and its impact (no full steps needed before payment). Payment for a finding needs a human confirmation by the operator after reading the preview, usually within a day; the full report stays private until fixed, then you may disclose. One paid award per distinct flaw; duplicates of an already paid or already fixed issue are not paid. Test only on the sandbox with your own agents. ' +
      RULES,
    category: 'security',
    tags: ['security', 'bug-bounty', 'audit', 'api', 'payments'],
    budget_max: 10_000_000,
    max_awards: 2,
    expires_days: 30,
    turnaround_seconds: 5 * 86400,
    preview_requirements: 'title, severity, area, endpoint, a one-paragraph summary of the flaw and its impact',
    output_schema: {
      type: 'object',
      required: ['title', 'severity', 'area', 'endpoint', 'steps', 'expected', 'actual', 'impact', 'evidence'],
      properties: {
        title: { type: 'string', minLength: 5 },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        area: { type: 'string', enum: ['auth', 'payments', 'marketplace', 'reputation', 'disputes', 'discovery', 'other'] },
        endpoint: { type: 'string' },
        steps: { type: 'array', minItems: 2, items: { type: 'string' } },
        expected: { type: 'string' },
        actual: { type: 'string' },
        impact: { type: 'string', minLength: 10 },
        evidence: { type: 'string', minLength: 10 },
        fix_suggestion: { type: 'string' },
      },
    },
    rubric: [
      'Reproducible: the steps are exact requests on the sandbox that anyone can replay; evidence carries request ids or hashes.',
      'Real impact: an attacker gains money, data, reputation or access they should not have; not a documented limitation, not theory.',
      'In scope and honest: severity matches the impact; no exaggeration; no denial of service; no third-party issues.',
      'Useful fix: the suggestion points at the mechanism to change.',
    ],
    checks: [],
    needs_operator_confirmation: true,
  },
]

export const bountyTag = (key: string) => `souk:bounty:${key}`

/** Reads a dot path like "client.kind" from an output object. */
export function pathValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

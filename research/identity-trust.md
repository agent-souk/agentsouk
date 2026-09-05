# Agent Identity, Authentication, Trust and Reputation — research notes

Slug: `identity-trust` · Researched: 2026-09-05 · Method: ~25 web searches + ~60 direct fetches of primary sources (IETF datatracker, EIP pages, vendor docs, GitHub READMEs, arXiv). Search budget ran out mid-task; the remaining gaps were closed by direct URL fetches. Anything not confirmed from a primary source is marked **unverified**.

Context: API-first "small world for AI agents" (identity, wallets, marketplace, messaging, reputation), used autonomously by LLM agents (Claude Code, OpenClaw-style agents, LangGraph/CrewAI, scripts) with zero humans in the loop.

---

## 0. Executive summary (read this first)

1. **The wire format has converged.** Across the IETF Web Bot Auth WG (chartered; WG draft -00 dated 2026-09-01), Visa Trusted Agent Protocol, IETF WIMSE, A2A 1.0 and Cloudflare/Amazon registries, the common denominator is: **Ed25519 keypair → keys published as a JWKS at `/.well-known/http-message-signatures-directory` (or `jwks_uri`) → requests signed with RFC 9421 HTTP Message Signatures, `keyid` = JWK SHA-256 thumbprint, `tag="web-bot-auth"`, `created`/`expires` window.** Build on this; do not invent a new envelope.
2. **Enterprise IdPs (Entra Agent ID, Auth0/Okta, AWS AgentCore) model the agent as a *client acting for a human/org*, never as a self-sovereign principal.** They are federation partners for a "verified operator" tier, not a source of identity for a solo agent that shows up with no human.
3. **Permissionless identity without evidence-bound reputation collapses into spam.** The ERC-8004 empirical study (Jan 29 – May 13, 2026): 173,441 registrations across ETH/BSC/Base, only 3–15 % functional, 98.7–100 % of feedback carries no payment/task proof, reputation manipulation costs $0.0027–$0.055, 59–91 % of reviewers show shared-funding sybil patterns. Validation Registry: not deployed on mainnet during the study.
4. **Reputation alone does not discipline agents with disposable identities** ("Tempting the Agent", arXiv 2609.02992, Sept 2, 2026): you need identity-reset cost, stake proportional to volume, slow reputation dynamics, and escrow.
5. **Bearer API keys are the wrong primitive for autonomous agents.** Moltbook (agent-only social network, Jan 2026) leaked ~1.5 M agent API keys through a misconfigured Supabase DB within days; it later invalidated every key and tied re-issuance to human verification (Mar 16, 2026). OpenClaw shipped an unauthenticated gateway that auto-trusted localhost. Sender-constrained credentials (HTTP signatures, DPoP, WIMSE WPT) are the default in every 2026 draft.
6. **Recommended scheme:** one-call self-signed registration with a locally generated Ed25519 key (agent id = `did:key` derived from the pubkey, so the agent can compute it offline), then either (a) RFC 9421-signed requests or (b) a 2-call challenge-response that yields a short-lived, key-bound session JWT. Trust is a ladder of *attestations* attached to the same key: paid bond → domain/DNS proof → human/operator vouch (X-post claim, World ID AgentKit, Skyfire KYA, enterprise OIDC) → stake with slashing → runtime attestation.
7. **A differentiator nobody ships yet:** host a per-agent **OAuth Client ID Metadata Document** (`client_id = https://<platform>/agents/<id>/cimd.json`, `private_key_jwt`) so an agent registered with us can authenticate to any MCP server / OAuth AS that follows the MCP 2026-07-28 spec (CIMD preferred, DCR deprecated) without pre-registration. Our identity becomes the agent's passport across the ecosystem.

---

## 1. Landscape by category

### 1.1 On-chain identity + reputation: ERC-8004 "Trustless Agents" (+ ERC-8183 escrow)

**What (verified — EIP page, contracts README, empirical study):**
- Draft Standards-Track ERC, created 2025-08-13. Three registries per chain:
  - **Identity Registry** — ERC-721 (URIStorage). `register(agentURI)` mints an NFT; `agentId` = tokenId; global id `{namespace}:{chainId}:{identityRegistry}`. `agentURI` → JSON registration file (`name`, `description`, `services[]` for MCP/A2A/ENS/DID/email endpoints, `supportedTrust[]`). `setMetadata(agentId, key, bytes)`; reserved key `agentWallet` must be set via `setAgentWallet()` with EIP-712 (EOA) or ERC-1271 (contract) signature; **wallet is auto-cleared on NFT transfer** (ownership transfer = key rotation with re-verification).
  - **Reputation Registry** — `giveFeedback()` by any non-owner/operator: `int128 value` + `uint8 valueDecimals` (0–18), `tag1`, `tag2`, optional `feedbackURI` + `feedbackHash` (keccak). `revokeFeedback()` by submitter; anyone may append responses. Off-chain feedback file may cite A2A task ids, MCP tools, OASF skills, **x402 payment proofs**.
  - **Validation Registry** — `validationRequest(validator, requestURI, hash)`; `validationResponse(score 0–100, evidenceURI, tag)`; progressive responses. README (Sept 2026): still "under active update and discussion with the TEE community".
  - Trust models named: reputation, crypto-economic/stake (re-execution + slashing), TEE attestation.
- Deployed on 30+ chains; IdentityRegistry and ReputationRegistry share address `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on mainnets. License CC0. Mainnet go-live reported as 2026-01-29 (eco.com support article; corroborated by the study's start date — **date itself secondary**).
- **ERC-8183 "Agentic Commerce"** (Draft, created 2026-02-25): job escrow — states Open → Funded → Submitted → Completed/Rejected/Expired; one evaluator/attester signals done; optional `beforeAction`/`afterAction` hook contracts that can write ERC-8004 feedback. This is the "evidence" primitive ERC-8004 lacks by itself.

**Empirical reality (arXiv 2606.26028, study window 2026-01-29 → 2026-05-13, verified):**
- 173,441 agents (ETH 32,343 / BSC 90,145 / Base 50,985). Valid registration file **and** declared service: 3 % / 4 % / 15 %. Never received a valid URI: 53 % ETH, 37 % Base, 9 % BSC. 48.3 % of ETH agents came from 2.6 % of transactions (batch minting); ownership Gini 0.733.
- Reputation failures: (1) semantic collapse (values from 0–100 to revenue >5,000, no shared scale), (2) arithmetic-mean aggregation → a single record moves any score arbitrarily, (3) **98.7–100 % of records have neither payment proof nor task linkage**, (4) attack cost $0.0027 (Base) / $0.0042 (BSC) / $0.055 (ETH).
- Sybil: shared-funding analysis flags 73.5 % (ETH) / 59.2 % (BSC) / 90.6 % (Base) of reviewers; after removal 15.8–86.8 % of rated agents have zero valid feedback left.
- Recommendations: typed/bounded value field, median-style aggregators, mandatory interaction evidence, manipulation cost that scales with stakes, default sybil defenses, per-chain integrity before cross-chain portability.

**Strengths:** permissionless, portable, composable, already integrated by x402/A2A/MCP-adjacent tooling; feedback schema is a reasonable interchange format.
**Weaknesses:** everything the study found; gas + wallet required (a hard blocker for an LLM agent with no funded wallet); validation layer unfinished.
**Relevance: integrate (export/import), do not adopt as the primary identity.** Let agents link an ERC-8004 `agentId` as an attestation; optionally mirror our evidence-bound feedback on-chain with `feedbackHash` + payment proof; publish an ERC-8004-compatible registration file at each agent's `agentURI` on our domain.

### 1.2 Web Bot Auth / HTTP Message Signatures (Cloudflare → IETF WG), Signature-Agent, registries

**What (verified — IETF datatracker, Cloudflare blog/README):**
- IETF **webbotauth WG exists** (chairs David Schinazi, Rifaat Shekh-Yusef). Milestones: auth technique + bot-info conveyance to IESG by 2026-04-30 (slipped), BCP by 2026-08-31.
- **draft-ietf-webbotauth-httpsig-protocol-00 (2026-09-01, WG document; Meunier/Cloudflare, Major/Google)**: sign at least `@authority` or `@target-uri`; `@signature-params` MUST carry `created`, `expires` (recommended ≤ 24 h), `keyid` = base64url JWK SHA-256 thumbprint, `tag="web-bot-auth"`. `Signature-Agent` is a Dictionary Structured Header of HTTPS URIs with discovery modes **`directory` (default), `jwks_uri`, `cimd`**; the header member must be a signed component. Keys served at `/.well-known/http-message-signatures-directory` as JWKS, media type `application/http-message-signatures-directory+json`; directory MAY be self-signed to prove possession. Replay: deferred to RFC 9421 lifetimes/covered components (Cloudflare's original May 2025 post also used a `nonce`).
- Individual predecessors: draft-meunier-web-bot-auth-architecture-05 (2026-03-02, replaced), draft-meunier-webbotauth-httpsig-protocol-02 (2026-08-19, replaced by the WG draft).
- **Registry / Signature Agent Card** (draft-meunier-webbotauth-registry-01, 2025-10-20; Cloudflare "Beyond IP lists" post 2025-10-30): card fields `client_name`, `client_uri`, `logo_uri`, `contacts`, `expected-user-agent`, `rfc9309-product-token`, `rfc9309-compliance`, `trigger`, `purpose`, `targeted-content`, `rate-control`, `rate-expectation`, `known-urls`, `keys` (JWKS with `nbf`/`exp`). A registry is just a list of card URIs; "anyone can maintain and host these lists". Partners named: Amazon Bedrock AgentCore, Vercel, Shopify, Visa; Cloudflare Radar publishes a directory.
- Cloudflare "signed agents" (2025-08-28): agents self-submit via the Bot Submission Form; classification distinct from verified bots; enterprise rules can act on the group.
- Library support: `cloudflare/web-bot-auth` (TypeScript/npm, Rust/cargo), RFC 9421 + RFC 7638, Ed25519 test keys.
- **Who signs today:** OpenAI's ChatGPT agent/Cloud browser reportedly sends `Signature-Agent: "https://chatgpt.com"` with keys at `https://chatgpt.com/.well-known/http-message-signatures-directory` (OpenAI Help Center per search snippet; **page returned 403 on fetch → unverified**). OpenAI's public bots doc (developers.openai.com) lists only user-agents + IP JSON files, no signatures. **Anthropic:** support article (2026-04-07) lists ClaudeBot / Claude-User / Claude-SearchBot and `claude.com/crawling/bots.json` IP list, **no mention of message signatures**; a vendor article claims Claude supports Web Bot Auth — **unverified, treat as not confirmed**. Cloudflare "production activation March 2026" — secondary (Stellagent) only, **unverified**.

**Strengths:** stateless, no pre-registration needed, no shared secret, replay-bounded, already understood by CDNs/WAFs, standard libs.
**Weaknesses:** identity = *origin that hosts the key directory*, which assumes the agent operator has a domain (many solo LLM agents do not); cards are self-certified; registries are curated lists (gatekeeping); no reputation semantics.
**Relevance: adopt as the request-auth format.** We host the key directory *for* agents that have no domain (`Signature-Agent: "https://<platform>/agents/<id>"`), and accept inbound signatures from external directories (chatgpt.com etc.) for a "known operator" attestation.

### 1.3 Payment-network KYA: Visa Trusted Agent Protocol, Skyfire KYA/KYAPay, (Mastercard, AP2)

**Visa TAP (verified — GitHub + developer spec page):** unveiled Oct 2025 with 10+ partners. RFC 9421 signatures with components `@authority`, `@path`, `created`, `expires`, `keyid`, `alg` (Ed25519 or PS256), `nonce` (session id), `tag` = `agent-browser-auth` | `agent-payer-auth`; bound to merchant site + page. Two body layers signed with the same key: **Agentic Consumer Recognition** (`nonce`, `idToken` JWT from the payment scheme, `contextualData`, `kid`, `alg`, `signature`) and **Agentic Payment Container** (`paymentCredentialsHash`, encrypted `payload`, `cardMetadata`, `browsingIOU` for 402). Keys: Visa publishes at `https://mcp.visa.com/.well-known/jwks` (RSA). "Agents are certified AI platforms that have been onboarded as an 'Agent' to Payment Schemes" — i.e., **permissioned**. No version/date in the spec page.

**Skyfire KYA (verified — docs + Experian post 2026-04-30):** signed JWTs (`kya`, `kya-pay`) with claims `hid` (human identity: `email` required; optional names, `birthdate`, `phone_number`, `organization_name`, `verifier`, `verified`, `verification_id`), `apd` (agent platform), `aid` (`name`, `creation_ip`, `source_ips`), `scope`. Verification requires a paid subscription (Individual or Organization) started by a human in the Skyfire dashboard; token creation fails if the seller's required level is not met. Sellers verify like any JWT via JWKS. Experian "Human-to-Agent Binding" adds a real-time risk score; pilots at Williams-Sonoma and Bose; partners F5 (2026-03-18 press release), Cequence, Ory, Fastly, Rye. Funding/traction numbers: **unverified**.

**Google AP2:** mandates (intent/cart/payment) as verifiable digital credentials signed by the user's device — **from memory; spec page 404 on fetch → unverified**. Mastercard Agent Pay: not researched (payments researcher's scope).

**Relevance: integrate as tier-up attestations.** Accept a Skyfire KYA JWT (verify against Skyfire JWKS) to grant "human/org-verified" status; issue Visa-TAP-compatible signatures only if we ever become a certified agent platform (permissioned, later). Adopt the *claim shapes* (`hid`/`apd`/`aid`) for our own attestation objects.

### 1.4 Enterprise IdPs: Microsoft Entra Agent ID, Auth0/Okta for AI Agents, AWS AgentCore Identity

**Entra Agent ID (verified — MS Learn, updated 2026-08-13):** GA ("now generally available"; exact GA date **unverified**, docs dated 2026-04/05). Four objects: agent identity blueprint, blueprint principal, **agent identity** (a special service principal the blueprint creates and is authorized to impersonate), agent user. OAuth 2.0, MCP and A2A supported; third-party agents (AWS Bedrock, n8n) via Auth SDK sidecar or workload identity federation; Conditional Access templates for autonomous vs on-behalf-of agents; risk-based blocking; sponsor lifecycle workflows to prevent orphaned agents; cascade deletion/soft delete; agent registry converging into **Microsoft Agent 365** (license per user; included in M365 E7, add-on to E5).
**Auth0 for AI Agents (verified — GA blog 2025-11-19):** User Authentication, **Token Vault** (stores third-party OAuth tokens, 35+ integrations; agent never sees refresh tokens), **Async Authorization via CIBA** (human-in-the-loop approval by push), FGA for RAG; frameworks LangChain, LlamaIndex, Vercel AI, Cloudflare Agents; free tier = 2 Token Vault connections; Cross App Access (XAA) beta. Agents are OAuth *clients acting for users*, not principals.
**AWS AgentCore Identity (verified — docs):** agent identity = **workload identity** with agent attributes in an *agent identity directory*; inbound auth via IAM SigV4 or JWT authorizer; outbound via OAuth 2LO (client credentials) / 3LO / API keys held in a **token vault** scoped to (agent, user) pair; "agent access token" (AWS-signed, carries workload + user identity); managed consent portal (Sept 2026). Web Bot Auth signing for customer agents announced with Cloudflare (Oct 2025 post).

**Relevance: federate, don't compete.** Accept OIDC/JWT tokens from Entra/Auth0/Cognito/AgentCore as a "verified operator" attestation (`client_id` = agent, `sub` = human/org, `iss` = enterprise tenant). Copy the *governance* ideas: sponsor/owner field on every agent, orphan detection, cascade delete, risk-based step-down.

### 1.5 IETF/OAuth building blocks (WIMSE, klrc, ID-JAG, CIMD, DPoP, MCP auth)

- **draft-klrc-aiagent-auth-03 (2026-07-06; Kasselman/Defakto, Lombardo/AWS, Rosomakho/Zscaler, Campbell/Ping, Steele/OpenAI, Parecki/Okta; individual draft, not WG-adopted):** profiles WIMSE + OAuth for agents. Agent gets a WIMSE identifier (SPIFFE ID in practice); short-lived creds (X.509-SVID, WIT-SVID JWT); transport mTLS or app-layer **WIMSE Proof Tokens / HTTP Message Signatures**; delegation via Authorization Code (user-delegated), Client Credentials (autonomous), JWT bearer; access token `client_id` = agent, `sub` = delegated user; Transaction Tokens for downscoped hops; Identity/Authorization Chaining across domains; CIBA for human confirmation; **Shared Signals Framework for revocation**.
- **WIMSE WG (verified):** chairs Justin Richer, Pieter Kasselman. s2s draft split into `wimse-workload-creds`, **`wimse-wpt` (-02, 2026-08-27)**, `wimse-http-signature`, `wimse-mutual-tls`. WPT = JWT in `Authorization: WPT …` proving possession of the key in the WIT's `cnf`; claims `aud` (target URI), `exp`, `jti`, `wth` (hash of WIT), `tth` (txn-token hash), `oth`; `typ: wpt+jwt`.
- **ID-JAG / Cross-App Access (draft-ietf-oauth-identity-assertion-authz-grant-04, 2026-05-21, WG document):** IdP-brokered token exchange (RFC 8693 + RFC 7523) so an agent's parent app gets third-party API tokens via SSO trust without user interaction.
- **Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document-02, 2026-07-06, WG):** `client_id` is an HTTPS URL with a path resolving to JSON with `jwks`/`jwks_uri`, `redirect_uris`, `client_name`, `token_endpoint_auth_method: private_key_jwt` → confidential client auth with **no pre-registration**.
- **MCP authorization (draft spec; 2026-07-28 revision per WorkOS):** OAuth 2.1; MCP servers MUST implement RFC 9728 Protected Resource Metadata; clients MUST send RFC 8707 `resource`; **CIMD SHOULD be supported, DCR deprecated**; RFC 9207 issuer validation; `client_credentials` clients explicitly contemplated; DPoP not mandated (extensions repo `modelcontextprotocol/ext-auth`).
- **DPoP (RFC 9449, Sept 2023):** sender-constrained tokens; recommended hardening for public clients in OAuth 2.1/MCP guidance; FAPI 2.0 accepts it.
- **SPIFFE/SPIRE:** `spiffe://trust-domain/path`, X.509/JWT SVIDs, hourly rotation via Workload API; needs SPIRE server + node attestors + **pre-registration of every workload** — heavy for dynamic solo agents; fine for our own infra.
- **NIST NCCoE concept paper "Accelerating the Adoption of Software and AI Agent Identity and Authorization" (2026-02-05; comments closed 2026-04-02; NCCoE page 403 on fetch, details via WorkOS secondary):** adapt OAuth 2.0/2.1, OIDC, SPIFFE/SPIRE, SCIM, NGAC, MCP; identified gap = multi-hop delegation (A spawns B calls C).
- **OpenID Shared Signals Framework / CAEP / RISC:** final specs approved 2025-09-02; events `session-revoked`, `credential-change`, `token-claims-change`, `assurance-level-change`.

**Relevance: adopt selectively.** Use RFC 8693 `act` chains + short-lived key-bound tokens (DPoP/WPT-style `cnf`), publish per-agent CIMD, emit CAEP-style events for revocation. Skip SPIRE for tenant agents (pre-registration kills autonomy).

### 1.6 W3C DIDs / VCs and DID-native agent proposals

- W3C DID 1.1 reached Candidate Recommendation March 2026 and a "Threat Model for Decentralized Credentials" was published Jan 2026 — **from a vendor blog; unverified**.
- **did:webvh v1.0 (verified — DIF spec):** did:web + verifiable history `did.jsonl` with Data Integrity proofs; **SCID** self-certifying identifier; **key pre-rotation** (`nextKeyHashes` must be present with `updateKeys` in every entry once enabled; each new key must match a previously committed hash); deactivation via `deactivated: true` or empty `updateKeys`; witnesses (threshold approvals in `did-witness.json`); watchers (webhook-notified caches); portability with `alsoKnownAs`.
- **AGNTCY (Linux Foundation, Cisco-donated; members Cisco, Dell, Google Cloud, Oracle, Red Hat; 65+ supporters):** "Agent Badge" = enveloped VC (JSON-LD) binding an Agent ID to an issuer, public key and provenance; schemas = OASF definition or A2A Agent Card; one badge per version.
- **Papers:** "AI Agents with DIDs and VCs" (Garzon et al., ICAART 2026): agents prove DID control at dialog start and exchange VCs; found **limits when the LLM alone controls security procedures**. "Authenticated Delegation and Authorized AI Agents" (South, Pentland et al., Jan 2025): OAuth/OIDC extension with agent credentials + NL→structured permissions. **OIDC-A 1.0** (Subramanya, Apr 2025; arXiv Sept 2025): claims `agent_type`, `agent_model`, `agent_provider`, `agent_instance_id`, `delegator_sub`, `delegation_chain[]`, `agent_attestation` (EAT-compatible), `agent_capabilities`, `agent_trust_level`; discovery `agent_attestation_endpoint`… — **repo has 1 commit / 8 stars, no IdP implementation**. **AIP** (Mar 2026): Invocation-Bound Capability Tokens — JWT (single hop) or Biscuit tokens with Datalog attenuation (multi-hop) across MCP/A2A/HTTP; 600 adversarial cases, 100 % rejected, 0.22–2.35 ms overhead. "AI Identity: Standards, Gaps" (Apr 2026): gaps = semantic intent verification, recursive delegation accountability, identity integrity, governance opacity, operational sustainability.

**Relevance: adopt `did:key` as the canonical id and expose `did:web`; borrow did:webvh pre-rotation; treat VCs as the export format for attestations; ignore OIDC-A as a spec (borrow its claim names).**

### 1.7 Discovery/naming: MIT NANDA, OWASP ANS, A2A Agent Cards, Cloudflare registries

- **NANDA Index** (arXiv July 2025, verified abstract): lean index → cryptographically verifiable **AgentFacts**; claims sub-second revocation/key rotation; prototypes only.
- **Agent Name Service** (OWASP GenAI ASI-endorsed paper, May 2025): DNS-style names, PKI certificates, registration/renewal, adapters for A2A/MCP/ACP; academic, no deployment found.
- **A2A 1.0 (verified spec):** `AgentCardSignature` = JWS over RFC 8785-canonicalized card; verifier keys from JWKS, `x5c`, or a registry; `securitySchemes` = apiKey, HTTP bearer/basic, OAuth2 (code/client-credentials/device), OIDC, mTLS; no delegation semantics.
- **Agent registries as lists of card URIs** (Cloudflare/IETF registry draft): cheap to mirror.

**Relevance: integrate.** Publish an A2A Agent Card (JWS-signed with the agent's key) and an ERC-8004 registration file for every agent at stable URLs; make our directory consumable as a Web Bot Auth registry.

### 1.8 Agent-first onboarding in the wild: Moltbook, OpenClaw, Agent Guild, Agent Passport

- **Moltbook (verified — `moltbook.com/skill.md`, an agent-facing doc):** `POST /api/v1/agents/register {name, description}` → `{api_key, claim_url, verification_code}`; agent hands `claim_url` to its human, who verifies email and posts a verification tweet on X; agent polls `GET /api/v1/agents/status` → `pending_claim` | `claimed`; unclaimed agents can only call register/status; `heartbeat.md` polled every 30 min. 2026: key rotation via owner dashboard; **2026-03-16 all pre-update keys invalidated, re-issuance requires accepting new terms + human verification** (PiunikaWeb, secondary). **Breach (Wiz, 2026-01-31):** Supabase without RLS + key in client JS → ~1.5 M agent API tokens, ~35 k owner emails, private messages containing third-party keys exposed; full account takeover possible. Reported scale 32 k agents in 72 h / 1.6 M agents — **secondary, unverified**.
- **OpenClaw (ex-Clawdbot/Moltbot; Akamai 2026-02-18):** bound `0.0.0.0:18789` unauthenticated, localhost auto-trust behind reverse proxies, plaintext secrets in `~/.clawdbot/`. Lesson: assume hostile network, scoped temporary creds, no localhost trust.
- **Agent Guild / AGI-1 (GitHub, Apache-2.0, ~284 commits):** `POST /agents/register {name, capabilities}` → agent id + **`did:key`** + API key, free, no wallet; **EigenTrust** seeded from a pre-trusted set; attestations as Guild-signed W3C VCs ("Agent Passports"); `guild_check()` hire/avoid/caution; escrow settlement in credits ($0.001), stablecoins planned. Closest existing competitor to our trust layer.
- **Agent Passport v0.1 (Cubitrek, 2026-04-28, MIT):** `/.well-known/agent-passport.json` signed Ed25519 over canonical JSON, key in DNS TXT `_agent-passport.<domain>` (DKIM-style); declares purpose, model, endpoints, **`spendCeiling`, `humanInLoop` thresholds + SLA**, audit URLs, compliance, `issuedAt/expiresAt` (90-day recommended), `revocationListUrl`; sub-agent delegation planned for v0.2. **Workday "Agent Passport" (2026-06-02)** is an unrelated enterprise product: pre-production testing + continuous monitoring attestations mapped to OWASP LLM Top 10 / NIST AI RMF / MITRE ATLAS, Cisco AI Defense as launch partner, early access H2 2026.

### 1.9 Human-vouch / proof-of-human

- **World ID AgentKit (world.org 2026-04-17; Coinbase partnership 2026-03-17 reported by CoinDesk/BitDigest):** humans register agents in World App; agent carries a ZK proof of a unique verified human (one-time nullifiers, TACEO OPRF); x402 integration so agents are "verifiable economic participants"; "human in the loop" step for Vercel Workflow SDK; beta; ~18 M verified humans (secondary). Per-human agent limits: not found.
- **X-post claim (Moltbook), email verification, DNS TXT (Agent Passport), GitHub-style org proofs** — cheap vouches an LLM agent can request from its operator by handing over a URL.

### 1.10 Reputation-design literature

- **"Tempting the Agent" (2026-09-02):** with cheap identity reset, more reputation can *increase* temptation (extractable value grows faster than continuation value). Remedies: identity reset cost κ^R, stake κ^S proportional to volume above the myopic threshold, slow decay (small λ, ρ), penalties that destroy more capital on identity replacement than on continued degraded operation, escrow (ERC-8183, x402).
- **TraceRank (Operator Labs, 2025-10-31):** payments as endorsements; reputation seeded and propagated through x402 payment graph weighted by value and recency → many low-rep payers rank below few high-rep payers. 5-page, no numbers.
- **Inter-Agent Trust Models (2025-11-05):** Brief, Claim, Proof, Stake, Reputation, Constraint; recommends Proof + Stake to gate high-impact actions, Brief for identity/discovery, Reputation as overlay.
- **Halborn "How attackers game AI agent reputation systems"** — could not fetch (429); **unverified**.

---

## 2. Recommended design for our platform

### 2.1 Tier 0 — one API call, no human, no wallet

Agent generates an Ed25519 keypair locally (Python `cryptography`, Node `crypto.generateKeyPairSync('ed25519')`, `openssl genpkey -algorithm ed25519`). It computes its own id `did:key:z6Mk…` from the public key (multicodec 0xed01 + base58btc), so the id exists before the server is contacted and is portable.

```
POST /v1/agents
Content-Type: application/json
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1757088000;expires=1757088300;keyid="<jwk-thumbprint>";alg="ed25519";tag="web-bot-auth"
Signature: sig1=:…:
Content-Digest: sha-256=:…:

{ "public_key": {"kty":"OKP","crv":"Ed25519","x":"…"},
  "name": "fx-arb-bot", "description": "…", "capabilities": ["translate","summarize"],
  "operator": null }
→ 201 { "agent_id": "did:key:z6Mk…", "handle": "fx-arb-bot#8f3a",
         "did_web": "did:web:<platform>:agents:z6Mk…",
         "key_directory": "https://<platform>/agents/z6Mk…/.well-known/http-message-signatures-directory",
         "cimd": "https://<platform>/agents/z6Mk…/cimd.json",
         "agent_card": "https://<platform>/agents/z6Mk…/agent-card.json",
         "erc8004_registration_file": "https://<platform>/agents/z6Mk…/erc8004.json",
         "trust": {"tier": 0, "limits": {...}}, "next_steps": [...] }
```
The body is self-certifying (the signature over `content-digest` with the same key proves possession), so **registration is a single call**; the server rejects `created` older than 5 min and caches `(keyid, created)` to stop replays.

**Per-request auth, two accepted modes:**
- **Mode A (stateless, interoperable):** RFC 9421 signature on every request exactly as above (`Signature-Agent: "https://<platform>/agents/<id>"` optional). Works unchanged against any other Web Bot Auth verifier.
- **Mode B (session, for agents that prefer bearer ergonomics):** `POST /v1/auth/challenge {agent_id}` → `{nonce, expires_in: 120}`; `POST /v1/auth/token {agent_id, nonce, signature}` → 15–60 min JWT with `cnf: {jkt: <thumbprint>}` and an optional DPoP requirement. A leaked token is useless without the key.

Store guidance for LLM agents in the docs: private key in `~/.config/<platform>/agent.key` (0600), never in prompts/logs; the docs page is itself an `llms.txt`/`skill.md`-style document (Moltbook proved that format works for autonomous onboarding).

### 2.2 Trust ladder (attestations bound to the same key; each raises limits)

| Tier | Attestation | How the agent completes it alone | Sybil cost |
|---|---|---|---|
| 0 | keypair + signed registration | 1 call | ~0 → strict rate limits, escrow-only, small spend caps, listing hidden by default |
| 1 | **bond** (refundable deposit or non-refundable fee, e.g. $2–10 in platform credits/stablecoin) | pay via any rail once wallet exists | makes identity reset ≥ bond (κ^R) |
| 2 | **domain / operator proof**: publish our challenge in `/.well-known/http-message-signatures-directory` (or Agent Passport DNS TXT, or `Signature-Agent` from a known directory such as chatgpt.com) | 1 call if the agent controls a domain; otherwise ask operator | ties identity to a rentable-but-not-free namespace |
| 3 | **human/org vouch**: (a) `claim_url` + email/X-post (Moltbook pattern), (b) World ID AgentKit ZK proof, (c) Skyfire KYA JWT (`hid.verified`), (d) enterprise OIDC token (Entra/Auth0/Cognito: `client_id`=agent, `sub`=human) | agent hands a URL/token request to its operator or presents an existing JWT | one-human-many-agents allowed but linkable; World ID gives uniqueness |
| 4 | **stake with slashing** proportional to trailing 30-day volume; disputes resolved by evaluator/arbiter (ERC-8183 pattern); insurance pool | on-platform call | economic (κ^S) |
| 5 | **runtime/behaviour attestation**: TEE EAT quote, Workday/Cisco-style test attestations, ERC-8004 Validation responses | agent submits evidence URI | proof-based |

Expose the tier and the underlying attestations in the agent card and in `GET /v1/agents/{id}/trust` so counterparties (other agents) can gate actions: e.g. "accept jobs > $50 only from tier ≥ 3".

### 2.3 Reputation (evidence-bound, bounded, robust, portable)

- Feedback can only be posted by the counterparty of a **settled platform transaction** (escrow release / payment id); one record per transaction; score `0–100` + typed tags (taxonomy shared with ERC-8004 tags/OASF skills); optional evidence URI + hash.
- Aggregate with **median / trimmed mean, weighted by transaction value and rater trust** (EigenTrust/TraceRank seeded from tier ≥ 2 accounts); publish `n`, `median`, `p25/p75`, `volume`, `identity_age`.
- Slow dynamics: reputation accrues with settled volume over time, decays slowly; new keys cannot inherit reputation except through an explicit, signed **key rotation** (see 2.4) — identity replacement destroys capital.
- Sybil controls: shared-funding-source clustering (the ERC-8004 study's method), reciprocal-praise ring detection, rater bond forfeiture on proven collusion, feedback from same wallet/operator cluster down-weighted to ~0.
- Portability: every record exportable as a platform-signed VC; optional mirror to ERC-8004 Reputation Registry (`giveFeedback` with `feedbackHash` and x402/escrow proof) and import of ERC-8004 feedback filtered to records with payment proof.

### 2.4 Key rotation

- Agent = set of keys in its JWKS (`kid` = thumbprint, `nbf`/`exp` per key; recommended key lifetime ≤ 12 months, session tokens ≤ 1 h).
- `POST /v1/agents/{id}/keys` adds a key; must be signed by an **existing active key** *and* the new key (dual signature). Optional **pre-rotation** (did:webvh style): agent commits `next_key_hash` at registration; a rotation to a key matching the commitment is accepted even from a compromised current key's perspective, while a rotation to a non-committed key requires a tier ≥ 3 operator confirmation. Recovery key (offline) recommended for tier ≥ 1.
- Rotation is an event: pushed to counterparties via webhooks in CAEP `credential-change` shape and visible in `GET /keys?history=1`; reputation and attestations follow the agent id, not the key (ERC-8004 clears wallet on transfer — we do the same for wallet bindings on non-pre-committed rotations).

### 2.5 Delegation

- **Agent acts for human/org:** accept external OIDC/JWT (`iss` enterprise, `client_id` agent, `sub` human) or Skyfire KYA / World proof → stored as `operator` attestation with scope + expiry. For our own wallets, mandates are explicit objects: `{delegator, delegate, scope, spend_cap, expiry, jti}` signed by the delegator (AP2/Agent Passport `spendCeiling` semantics).
- **Agent acts for agent (sub-agents):** parent issues a **delegation token** (JWT, `act` chain per RFC 8693, `scope` ⊆ parent scope, `max_spend`, `exp`, `depth`, `jti`); child registers with its own key and presents the token; platform validates the full chain (each `iss` trusted, scope monotonically decreasing, audience match, depth ≤ 3 — OIDC-A/AIP rules) and records provenance on every transaction. Optionally Biscuit-style attenuation later.
- Marketplace calls carry `on_behalf_of` so counterparties and reputation know who is accountable; misconduct penalties propagate up the chain (parent stake at risk).

### 2.6 Revocation

- Self-revoke any key (signed by another active key or recovery key); operator revoke (tier ≥ 3 vouch holder); platform suspend (with reason code). Revoked `kid`s stay listed with `revoked_at` in the directory and a short-lived **revocation list** at `/.well-known/revocations.json` (Agent Passport `revocationListUrl` compatible).
- Delegation tokens revocable by `jti` (parent-signed); session tokens die with key revocation (server checks `cnf.jkt` against live keys).
- Push: CAEP events (`session-revoked`, `credential-change`, `assurance-level-change`) to subscribed counterparties + messaging inbox; pull: `HEAD /v1/agents/{id}/keys/{kid}`.
- Attestations carry `expires_at` (KYA/World/OIDC re-verify ≤ 90 days), so trust decays if not renewed.

### 2.7 Interop surface (what we publish for every agent)

`/.well-known/http-message-signatures-directory` (JWKS, self-signed), Signature Agent Card fields, `cimd.json` (CIMD with `private_key_jwt`), A2A `agent-card.json` (JWS-signed), ERC-8004 registration file JSON, `did:web` DID document, optional DID+VC export of attestations. Plus a platform-wide registry list (Web Bot Auth registry format) of all tier ≥ 2 agents.

---

## 3. Strategic insights

1. Ed25519 + RFC 9421 + JWKS-at-well-known is the de-facto lingua franca; building on it makes every agent on our platform verifiable by Cloudflare, Visa, Amazon and any MCP server for free.
2. The two agent identity worlds — *enterprise delegated* (OAuth client for a human) and *self-sovereign* (keypair/DID/ERC-721) — have no bridge today; a platform that treats an enterprise IdP token as *one attestation among several* on a self-sovereign key is the bridge.
3. ERC-8004's data is a warning: identity is cheap, evidence is the scarce resource. Reputation must be *transactions with money*, not opinions.
4. Disposable identities invert reputation incentives; the platform must sell "identity persistence" (bond + slow reputation + key rotation that preserves capital) as the product.
5. Moltbook shows agent-only onboarding with a human "claim" works at scale and is what OpenClaw-style agents already know how to do — copy the UX (skill.md, claim_url, status polling), replace the API key with a keypair.
6. CIMD + private_key_jwt effectively makes "an HTTPS URL that serves a JWKS" the universal OAuth client identity; hosting that URL per agent is a cheap, high-leverage feature nobody else offers for solo agents.
7. Delegation depth/accountability is the recognised open gap (NIST, AI-Identity paper); a simple, enforced `act`-chain with spend caps is enough to be ahead of the market.
8. Validation/attestation of *work quality* is still unsolved everywhere (ERC-8004 Validation Registry undeployed as of May 2026); escrow with an evaluator (ERC-8183) is the practical substitute and produces the evidence reputation needs.
9. Payment-network KYA is permissioned and human-initiated; don't wait for it — accept its tokens when present.
10. LLM agents are unreliable custodians of secrets (Garzon et al.; Moltbook leak). Minimize what a secret can do: key-bound tokens, per-request signatures, spend caps, short lifetimes.

## 4. Open questions

- Legal/AML posture for tier-0 anonymous agents holding wallets; which rails allow unverified counterparties and at what caps.
- Bond/stake denomination (platform credits vs stablecoin vs both) and who arbitrates slashing.
- Whether to mirror to ERC-8004 by default (gas, which chains) or only on request.
- Does Anthropic/Claude sign Web Bot Auth requests (unverified); does the ChatGPT agent directory remain stable enough to whitelist.
- How to verify `agent_model`/provider claims without provider-issued attestations (no provider issues them today).
- Privacy: linkability of one human across many agents under tier-3 vouches; ZK (World) vs plain email (Skyfire/Moltbook).
- Private-key custody guidance for hosted agents (Claude Code sessions are ephemeral; where does the key persist?).
- Sybil clustering thresholds that don't punish legitimate one-operator-many-agents fleets.

---

## 5. Sources (all URLs used)

**Standards / drafts (primary)**
- https://eips.ethereum.org/EIPS/eip-8004
- https://github.com/erc-8004/erc-8004-contracts
- https://eips.ethereum.org/EIPS/eip-8183
- https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/
- https://datatracker.ietf.org/wg/webbotauth/about/
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
- https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/
- https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/
- https://www.ietf.org/archive/id/draft-meunier-webbotauth-registry-01.html
- https://github.com/cloudflare/web-bot-auth/blob/main/README.md
- https://datatracker.ietf.org/wg/wimse/about/
- https://datatracker.ietf.org/doc/draft-ietf-wimse-s2s-protocol/
- https://datatracker.ietf.org/doc/draft-ietf-wimse-wpt/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
- https://modelcontextprotocol.io/specification/draft/basic/authorization
- https://a2a-protocol.org/latest/specification/
- https://identity.foundation/didwebvh/v1.0/
- https://github.com/nostr-protocol/nips/blob/master/98.md
- https://openid.net/wg/sharedsignals/
- https://github.com/subramanya1997/oidc-a/
- https://spec.identity.agntcy.org/docs/vc/intro
- https://eips.ethereum.org/EIPS/eip-4361 (SIWE; via search only)
- https://datatracker.ietf.org/doc/html/rfc9449 (DPoP; via search only)

**Vendor docs / launch posts (primary)**
- https://blog.cloudflare.com/web-bot-auth/
- https://blog.cloudflare.com/signed-agents/
- https://blog.cloudflare.com/agent-registry/
- https://blog.cloudflare.com/verified-bots-with-cryptography/ (search only)
- https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id
- https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id
- https://auth0.com/blog/auth0-for-ai-agents-generally-available/
- https://auth0.com/docs/get-started/auth-for-genai (search only)
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-overview.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-terminology.html
- https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-bedrock-agentcore/ (search only)
- https://docs.skyfire.xyz/docs/kya
- https://docs.skyfire.xyz/docs/kya-token
- https://skyfire.xyz/skyfires-kya-protocol-is-now-the-identity-layer-for-experians-know-your-agent-framework/
- https://investors.f5.com/news/news-details/2026/F5-and-Skyfire-Partner-to-Advance-Secure-Agentic-Commerce-for-the-Enterprise-03-18-2026/default.aspx (search only)
- https://github.com/visa/trusted-agent-protocol
- https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications
- https://investor.visa.com/news/news-details/2025/Visa-Introduces-Trusted-Agent-Protocol-An-Ecosystem-Led-Framework-for-AI-Commerce/default.aspx (search only)
- https://world.org/blog/announcements/world-id-full-stack-proof-of-human
- https://developers.openai.com/api/docs/bots
- https://help.openai.com/en/articles/11845367-chatgpt-agent-allowlisting (403 on fetch; search snippet only)
- https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- https://claude.com/crawling/bots.json (referenced)
- https://moltbook.com/skill.md
- https://www.moltbook.com/developers
- https://moltbook.com/developers.md
- https://github.com/AgentTanuki/agent-guild
- https://cubitrek.com/blog/agent-passport
- https://newsroom.workday.com/2026-06-02-Workday-Launches-Agent-Passport-to-Test,-Verify,-and-Continuously-Monitor-Every-AI-Agent-in-the-Enterprise
- https://www.nccoe.nist.gov/projects/software-and-ai-agent-identity-and-authorization (403 on fetch)
- https://www.nccoe.nist.gov/publications/other/accelerating-adoption-software-and-ai-agent-identity-and-authorization-concept (search only)
- https://projectnanda.org/ and https://github.com/projnanda (search only)
- https://github.com/google-agentic-commerce/AP2 (README only; spec 404)

**Papers (primary)**
- https://arxiv.org/html/2606.26028 — ERC-8004 empirical study
- https://arxiv.org/html/2609.02992 — Tempting the Agent (reputation without persistent identity)
- https://arxiv.org/abs/2510.27554 — TraceRank / sybil-resistant discovery
- https://arxiv.org/abs/2511.03434 — Inter-Agent Trust Models
- https://arxiv.org/abs/2603.24775 — AIP: Agent Identity Protocol
- https://arxiv.org/abs/2604.23280 — AI Identity: Standards, Gaps
- https://arxiv.org/abs/2511.02841 — AI Agents with DIDs and VCs
- https://arxiv.org/abs/2501.09674 — Authenticated Delegation and Authorized AI Agents
- https://arxiv.org/abs/2505.10609 — Agent Name Service (OWASP)
- https://arxiv.org/abs/2507.14263 — NANDA Index
- https://arxiv.org/abs/2509.25974 — OIDC-A 1.0
- https://arxiv.org/pdf/2508.03113 and https://arxiv.org/html/2508.03101v1 (NANDA follow-ups; search only)

**Secondary / press (used for dates, context; flagged where relied upon)**
- https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys
- https://piunikaweb.com/2026/03/16/moltbook-invalidates-agent-api-keys-new-terms-human-verification/
- https://www.tomsguide.com/ai/1-6-million-ai-bots-are-on-moltbook-heres-how-to-join-as-a-human (truncated)
- https://www.akamai.com/blog/security/clawdbot-openclaw-practical-lessons-building-secure-agents
- https://astrix.security/learn/blog/openclaw-moltbot-the-rise-chaos-and-security-nightmare-of-the-first-real-ai-agent/ (search only)
- https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf (vendor; March-2026 activation + Claude support claims unverified)
- https://stellagent.ai/insights/skyfire-kyapay-know-your-agent (search only)
- https://workos.com/blog/nist-ai-agent-standards-initiative-explained
- https://workos.com/blog/mcp-2026-spec-agent-authentication
- https://www.bitdigest.io/posts/world-launches-agentkit-to-enable-human-verified-ai-agents
- https://www.coindesk.com/tech/2026/03/17/sam-altman-s-world-teams-up-with-coinbase-to-prove-there-is-a-real-person-behind-every-ai-transaction (429 on fetch)
- https://eco.com/support/en/articles/13221214-what-is-erc-8004-the-ethereum-standard-enabling-trustless-ai-agents
- https://eco.com/support/en/articles/14846277-know-your-agent-kya-identity-for-agent-payments
- https://neuraltrust.ai/blog/w3c-identifier-agent (W3C DID CR / did:trail claims; unverified)
- https://stacklok.com/blog/agentic-identity-explained-how-to-apply-spiffe-and-relationship-based-authorization-to-ai-agents-in-2026/
- https://www.halborn.com/blog/post/how-attackers-game-ai-agent-reputation-systems-and-how-to-stop-them (429; not read)
- https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos
- https://outshift.cisco.com/blog/ai-ml/ai-agent-identity-framework-agntcy
- https://www.semperis.com/blog/understanding-microsoft-agent-identity-platform/
- https://simonwillison.net/2025/Aug/4/chatgpt-agents-user-agent/
- https://blog.castle.io/how-to-authenticate-openai-operator-requests-using-http-message-signatures/
- https://news.ycombinator.com/item?id=47096131 (Agent Passport Show HN)
- https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative

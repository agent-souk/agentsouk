# Agent Identity, Authentication, Trust and Reputation — research notes

Slug: `identity-trust` · Round 1 researched: 2026-09-05 (~25 web searches + ~60 direct fetches) · **Round 2 verification pass: 2026-09-06** (≈45 searches + ≈75 primary-source fetches; IETF datatracker, EIP pages, live `/.well-known/` key directories, vendor docs, arXiv). Anything not confirmed from a primary source is marked **unverified**. In-place fixes from round 2 are tagged **[corrected 2026-09-06]**; all new material is in section 6.

Context: API-first "small world for AI agents" (identity, wallets, marketplace, messaging, reputation), used autonomously by LLM agents (Claude Code, OpenClaw-style agents, LangGraph/CrewAI, scripts) with zero humans in the loop.

---

## 0. Executive summary (read this first)

1. **The wire format has converged.** Across the IETF Web Bot Auth WG (chartered; WG draft -00 dated 2026-09-01 — **verified on datatracker 2026-09-06**), Visa Trusted Agent Protocol, IETF WIMSE, A2A 1.0 and Cloudflare/Amazon registries, the common denominator is: **Ed25519 keypair → keys published as a JWKS at `/.well-known/http-message-signatures-directory` (or `jwks_uri`) → requests signed with RFC 9421 HTTP Message Signatures, `keyid` = JWK SHA-256 thumbprint, `tag="web-bot-auth"`, `created`/`expires` window.** Build on this; do not invent a new envelope. **[corrected 2026-09-06]** The WG draft now *requires* `Signature-Agent` on every signed request, in Structured-Field **Dictionary** form (signers MUST; verifiers MAY still accept the legacy bare string), and each signature must cover the `Signature-Agent` member keyed to its own label.
2. **Enterprise IdPs (Entra Agent ID, Auth0/Okta, AWS AgentCore) model the agent as a *client acting for a human/org*, never as a self-sovereign principal.** They are federation partners for a "verified operator" tier, not a source of identity for a solo agent that shows up with no human.
3. **Permissionless identity without evidence-bound reputation collapses into spam.** The ERC-8004 empirical study (Jan 29 – May 13, 2026): 173,441 registrations across ETH/BSC/Base, only 3–15 % functional, 98.7–100 % of feedback carries no payment/task proof, reputation manipulation costs $0.0027–$0.055, 59–91 % of reviewers show shared-funding sybil patterns. Validation Registry: not deployed on mainnet during the study — **all figures re-verified against arXiv 2606.26028 on 2026-09-06**; explorer 8004scan.io showed 497,148 registered agents / 567,824 feedback records on 2026-09-06 (secondary), i.e. the spam curve has not bent.
4. **Reputation alone does not discipline agents with disposable identities** ("Tempting the Agent", arXiv 2609.02992, Sept 2, 2026 — verified; Gatta, Naviglio, Tarantelli): you need identity-reset cost, stake proportional to volume, slow reputation dynamics, and escrow.
5. **Bearer API keys are the wrong primitive for autonomous agents.** Moltbook (agent-only social network, Jan 2026) leaked ~1.5 M agent API keys through a misconfigured Supabase DB within days; it later invalidated every key and tied re-issuance to human verification (Mar 16, 2026 — **six days after Meta acquired Moltbook on 2026-03-10 [corrected 2026-09-06]**). OpenClaw shipped an unauthenticated gateway that auto-trusted localhost. Sender-constrained credentials (HTTP signatures, DPoP, WIMSE WPT) are the default in every 2026 draft.
6. **Recommended scheme:** one-call self-signed registration with a locally generated Ed25519 key (agent id = `did:key` derived from the pubkey, so the agent can compute it offline), then either (a) RFC 9421-signed requests or (b) a 2-call challenge-response that yields a short-lived, key-bound session JWT. Trust is a ladder of *attestations* attached to the same key: paid bond → domain/DNS proof → human/operator vouch (X-post claim, World ID AgentKit, Skyfire KYA, enterprise OIDC) → stake with slashing → runtime attestation. **[corrected 2026-09-06]** The per-agent key directory must live on a per-agent *origin* (`<id>.agents.<platform>`), not a path, to work with the default `directory` discovery type — see 6.4.
7. **A differentiator nobody ships yet:** host a per-agent **OAuth Client ID Metadata Document** (`client_id = https://<platform>/agents/<id>/cimd.json`, `private_key_jwt`) so an agent registered with us can authenticate to any MCP server / OAuth AS that follows the MCP 2026-07-28 spec (CIMD preferred, DCR deprecated — **verified from the spec text 2026-09-06**) without pre-registration. Our identity becomes the agent's passport across the ecosystem. Closest prior art: `draft-singh-webbotauth-hosted-directories-00` (Airlock Protocol, 2026-07-19) — a design for third-party-hosted key directories; no product found (see 6.3.2).

---

## 1. Landscape by category

### 1.1 On-chain identity + reputation: ERC-8004 "Trustless Agents" (+ ERC-8183 escrow)

**What (verified — EIP page, contracts README, empirical study):**
- Draft Standards-Track ERC, created 2025-08-13 (still **Draft** on 2026-09-06; authors De Rossi/MetaMask, Crapis/EF, Ellis/Google, Reppel/Coinbase). Three registries per chain:
  - **Identity Registry** — ERC-721 (URIStorage). `register(agentURI)` mints an NFT; `agentId` = tokenId; global id `{namespace}:{chainId}:{identityRegistry}`. `agentURI` → JSON registration file (`type: …eip-8004#registration-v1`, `name`, `description`, `services[]` for MCP/A2A/ENS/DID/email endpoints, `supportedTrust[]`). `setMetadata(agentId, key, bytes)`; reserved key `agentWallet` must be set via `setAgentWallet()` with EIP-712 (EOA) or ERC-1271 (contract) signature; **wallet is auto-cleared on NFT transfer** (ownership transfer = key rotation with re-verification).
  - **Reputation Registry** — `giveFeedback()` by any non-owner/operator: `int128 value` + `uint8 valueDecimals` (0–18), `tag1`, `tag2`, optional `feedbackURI` + `feedbackHash` (keccak). `revokeFeedback()` by submitter; anyone may append responses. Off-chain feedback file may cite A2A task ids, MCP tools, OASF skills, **x402 payment proofs**.
  - **Validation Registry** — `validationRequest(validator, requestURI, hash)`; `validationResponse(score 0–100, evidenceURI, tag)`; progressive responses. README (Sept 2026): still "under active update and discussion with the TEE community"; **not deployed on mainnets** (re-confirmed 2026-09-06).
  - Trust models named: reputation, crypto-economic/stake (re-execution + slashing), TEE attestation.
- Deployed on 30+ chains. **[corrected 2026-09-06]** The two registries do *not* share an address: mainnet IdentityRegistry = `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, mainnet ReputationRegistry = `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (testnets: `0x8004A818…`/`0x8004B663…`). License CC0. Mainnet go-live 2026-01-29 (multiple secondary sources: Forbes 2026-02-05, decipherclub 2026-06-01, eco.com); a "8004 Launch Day" event on 2026-03-17 is reported (secondary, **unverified**).
- **ERC-8183 "Agentic Commerce"** (Draft, created 2026-02-25; authors Crapis, Lim, Weixiong, Zuhwa — verified): job escrow — states Open → Funded → Submitted → Completed/Rejected/Expired; only the evaluator decides Completed/Rejected; optional `IACPHook` `beforeAction`/`afterAction` hooks (KYC/allowlists pre-funding, reputation updates post-completion, fee splits). Spec text: "intentionally minimal and does not embed a reputation system … RECOMMENDED to integrate with ERC-8004". A `ReputationGateHook` gating provider funding by ERC-8004 score is reported live on Base mainnet (decipherclub, secondary). This is the "evidence" primitive ERC-8004 lacks by itself.

**Empirical reality (arXiv 2606.26028 "Can Trustless Agents Be Trusted?", Xiong, Li, Wei, Wang, Knottenbelt, Wang; v1 2026-06-24, v2 2026-07-08; study window 2026-01-29 → 2026-05-13; verified):**
- 173,441 agents (ETH 32,343 / BSC 90,145 / Base 50,985). Valid registration file **and** declared service: 3 % / 4 % / 15 %. Never received a valid URI: 53 % ETH, 37 % Base, 9 % BSC. 48.3 % of ETH agents came from 2.6 % of transactions (batch minting); ownership Gini 0.733 ETH / 0.708 Base / 0.134 BSC.
- Reputation failures: (1) semantic collapse (values from 0–100 to revenue >5,000, no shared scale), (2) arithmetic-mean aggregation → a single record moves any score arbitrarily, (3) **98.7 % (ETH) / 100.0 % (BSC) / 99.3 % (Base) of records have neither payment proof nor task linkage**, (4) attack cost $0.0027 (Base) / $0.0042 (BSC) / $0.055 (ETH).
- Sybil: shared-funding analysis flags 73.5 % (ETH) / 59.2 % (BSC) / 90.6 % (Base) of reviewers; after removal only 15.8 % (ETH) / 77.9 % (BSC) / 86.8 % (Base) of rated agents retain any valid feedback.
- Recommendations: canonical liveness predicates, typed/bounded value field, median/trimmed-mean aggregators, mandatory interaction evidence, manipulation cost that scales with stakes, default sybil defenses, per-chain integrity before cross-chain portability.

**Strengths:** permissionless, portable, composable, already integrated by x402/A2A/MCP-adjacent tooling; feedback schema is a reasonable interchange format; tooling maturing (8004scan.io, agentarena, QuickNode explorer; Azeth/Agent0 SDKs; aggregators RNWY, Verity — all secondary).
**Weaknesses:** everything the study found; gas + wallet required (a hard blocker for an LLM agent with no funded wallet); validation layer unfinished.
**Relevance: integrate (export/import), do not adopt as the primary identity.** Let agents link an ERC-8004 `agentId` as an attestation; optionally mirror our evidence-bound feedback on-chain with `feedbackHash` + payment proof; publish an ERC-8004-compatible registration file at each agent's `agentURI` on our domain.

### 1.2 Web Bot Auth / HTTP Message Signatures (Cloudflare → IETF WG), Signature-Agent, registries

**What (verified — IETF datatracker, Cloudflare blog/README):**
- IETF **webbotauth WG exists** (chairs David Schinazi, Rifaat Shekh-Yusef). Milestones: auth technique + bot-info conveyance to IESG by 2026-04-30 (slipped), BCP by 2026-08-31.
- **draft-ietf-webbotauth-httpsig-protocol-00 (2026-09-01, WG document, 44 pp.; Meunier/Cloudflare, Major/Google) — re-verified 2026-09-06**: sign at least `@authority` or `@target-uri`; `@signature-params` MUST carry `created`, `expires` (recommended ≤ 24 h), `keyid` = base64url JWK SHA-256 thumbprint, `tag="web-bot-auth"`. `Signature-Agent` is a Dictionary Structured Header of HTTPS URIs with discovery modes **`directory` (default), `jwks_uri`, `cimd`**; **[corrected 2026-09-06]** the -00 changelog adds: "Require `Signature-Agent` on every signed request, and require each signature to cover the member keyed to its own label"; signers MUST use Dictionary form, verifiers MAY accept legacy bare strings. Keys served at `/.well-known/http-message-signatures-directory` as JWKS, media type `application/http-message-signatures-directory+json`; directory SHOULD be self-signed (`tag="http-message-signatures-directory"`, covering `@authority` + `content-digest`) to prove possession. Rotation: "publish the old and the new key together, then remove the old one"; removed keys are honoured only until verifier caches expire; failed discovery negative-cached ≤ 5 min. Replay: no extra nonce requirement beyond RFC 9421 §7.2.2.
- Individual predecessors: draft-meunier-web-bot-auth-architecture-05 (2026-03-02, replaced), draft-meunier-webbotauth-httpsig-protocol-02 (2026-08-19, replaced by the WG draft), draft-meunier-webbotauth-httpsig-directory-00 (2026-06-26, merged into the protocol draft). Other WG-related individual drafts (all "I-D exists", not adopted): registry-03, nottingham-use-cases-02 (2026-04-01), illyes-cbcp-00 and illyes-jafar-00 (IP-range JSON, 2026-04-21), popov-semantic-anchor-00 (2026-06-05), **rescorla-anonymous-webbotauth-01** (2026-07-19) and **singh-hosted-directories-00** (2026-07-19) — the last two matter for us, see 6.3.2.
- **Registry / Signature Agent Card** — **[corrected 2026-09-06]** now **draft-meunier-webbotauth-registry-03 (2026-06-26; Guerreiro/Cloudflare, Kirazci/Amazon, Meunier/Cloudflare)**, restructured as an **OAuth client-metadata document** (RFC 7591 fields `client_id` = resolvable HTTPS URL, `client_name`, `client_uri`, `logo_uri`, `contacts`, `jwks` **or** `jwks_uri` — mutually exclusive, the inline field was renamed from `keys`) plus an IANA-registered **`web_bot_auth` object** with `expected-user-agent`, `rfc9309-product-token`, `rfc9309-compliance`, `trigger` (`fetcher`|`crawler`), `purpose`, `targeted-content`, `rate-control`, `rate-expectation`, `known-urls`, `ips_uri`. Card resolution: GET, 200 only, no redirects, `client_id` must string-equal the URL. Registry = plaintext list of HTTPS/data URIs, one per line, `#` comments; ETag/If-None-Match; optional push via **HTTP-Message-Signature-signed webhooks** (`action: put|delete`, `signature-agent`). The Cloudflare "Beyond IP lists" post is dated 2025-10-30 (verified); partners named: Amazon Bedrock AgentCore, Vercel, Shopify, Visa. Cloudflare Radar's bot-details API gained `signatureAgentUrl` on 2026-04-24 (verified, release notes).
- Cloudflare "signed agents" (2025-08-28): agents self-submit via the Bot Submission Form; classification distinct from verified bots; enterprise rules can act on the group. **[corrected 2026-09-06]** Since 2026-07-01 the distinction is expressed as **"Intermediary" vs "Direct"** access in BotBase (Cloudflare docs). Verification requirements (Cloudflare docs, verified): Ed25519 only, sign at least `@authority`, `tag="web-bot-auth"`, short `expires` ("a minute is often sufficient"), key rotation of a *registered* key goes through Cloudflare ("will work with you … to rotate").
- Library support: `cloudflare/web-bot-auth` (TypeScript/npm, Rust/cargo), RFC 9421 + RFC 7638, Ed25519 test keys.
- **Who signs today — [corrected 2026-09-06, verified by fetching the live directories]:**
  - **OpenAI**: `https://chatgpt.com/.well-known/http-message-signatures-directory` serves a JWKS with **one** Ed25519 key, `kid=otMqcjr17mGyruktGvJU8oojQTSMHlVm7uO-lrcqbdg`, `nbf=2025-01-01T00:00:00Z`, **`exp=2026-09-12T22:32:50Z`** (i.e. six days after this pass — expect a rotation; a single-key directory is fragile). Help-center page still 403 for us; Cloudflare's registry post cites this exact URL.
  - **Google**: `Google-Agent` signs "a subset of requests" (experimental; developers.google.com doc updated 2026-05-04) with `Signature-Agent: g="https://agent.bot.goog"` (Dictionary form) and a directory of **5 Ed25519 keys without `nbf`/`exp`** (cache per `Cache-Control`, "delete old cached keys that are missing from the file"). Googlebot itself does not sign.
  - **Anthropic**: **does not sign.** `claude.ai`, `claude.com`, `anthropic.com` `/.well-known/http-message-signatures-directory` all return 404 (2026-09-06); turva.dev ("When an agent can prove it is Claude", 2026): "Claude is not on the signed list yet". Vendor claims that Claude "is supported" (Stellagent, Security Boulevard 2026-09) are **contradicted by the primary evidence** — treat as wrong.
  - **Perplexity**: `perplexity.ai` directory 404 → not signing (claims to the contrary are unverified).
  - Others registered per turva.dev (secondary): Goose, Browserbase, Anchor Browser; Kernel (signs; key listed in Vercel's directory, Kernel blog); Amazon Bedrock AgentCore Browser (preview, Oct 2025).
  - **Verifiers in production (verified primary):** Cloudflare (Verified Bots + signed agents), **AWS WAF Bot Control** (WBA since Nov 2025; rule-group v5.0 Feb 2026; labels `web_bot_auth:verified|invalid|expired|unknown_bot`; blog 2026-07-14 — "polls these directories and maintains a valid key registry", unclear whether arbitrary directories are accepted), Vercel (verifies; Kernel blog), Akamai (edge verification, blog). The round-1 "Cloudflare production activation March 2026" claim is meaningless — Cloudflare has verified RFC 9421 signatures since May 2025; drop it.

**Strengths:** stateless, no pre-registration needed, no shared secret, replay-bounded, already understood by CDNs/WAFs, standard libs.
**Weaknesses:** identity = *origin that hosts the key directory*, which assumes the agent operator has a domain (many solo LLM agents do not); cards are self-certified; registries are curated lists (gatekeeping); no reputation semantics; **interop hazard** — Singh's draft reports "at least one major deployed verifier accepts only the earlier plain string form and rejects the Dictionary form" of `Signature-Agent`.
**Relevance: adopt as the request-auth format.** We host the key directory *for* agents that have no domain (**per-agent origin** `https://<id>.agents.<platform>` — **[corrected 2026-09-06]**, path-based `Signature-Agent` values only work with `type=jwks_uri`/`cimd`, not the default `directory` type), and accept inbound signatures from external directories (chatgpt.com, agent.bot.goog) for a "known operator" attestation.

### 1.3 Payment-network KYA: Visa Trusted Agent Protocol, Skyfire KYA/KYAPay, (Mastercard, AP2)

**Visa TAP (verified — GitHub + developer spec page):** unveiled 2025-10-14 with 10+ partners. RFC 9421 signatures with components `@authority`, `@path`, `created`, `expires`, `keyid`, `alg` (Ed25519 or PS256), `nonce` (session id), `tag` = `agent-browser-auth` | `agent-payer-auth`; bound to merchant site + page. Two body layers signed with the same key: **Agentic Consumer Recognition** (`nonce`, `idToken` JWT from the payment scheme, `contextualData`, `kid`, `alg`, `signature`) and **Agentic Payment Container** (`paymentCredentialsHash`, encrypted `payload`, `cardMetadata`, `browsingIOU` for 402). Keys: Visa publishes at `https://mcp.visa.com/.well-known/jwks` (RSA). "Agents are certified AI platforms that have been onboarded as an 'Agent' to Payment Schemes" — i.e., **permissioned**. Repo state 2026-09-06: 6 commits, no version tags, no 2026 changes documented (verified) — the spec appears stagnant while Visa reportedly folds TAP into an Intelligent Commerce SDK with AP2 compatibility (eco.com, secondary, **unverified**).

**Skyfire KYA (verified — docs updated 2026-07-14 + Experian post 2026-04-30):** signed JWTs (`kya`, `pay`, `kya-pay`) with claims `hid` (human identity: `email` required; optional names, `birthdate`, `phone_number`, `organization_name`, `verifier`, `verified`, `verification_id`), `apd` (agent platform), `aid` (`name`, `creation_ip`, `source_ips`), `scope`. Verification requires a paid subscription (Individual or Organization) started by a human in the Skyfire dashboard; token creation fails if the seller's required level is not met. Sellers verify like any JWT via JWKS — **[gap filled 2026-09-06]** issuer `https://app.skyfire.xyz`, JWKS `https://app.skyfire.xyz/.well-known/jwks.json` (sandbox `app-sandbox.…`), cache ≈1 h; tokens are presented in a **`kyapay-token`** request header; `pay` tokens carry a committed payment value the seller charges post-delivery via Skyfire API; KYAPay is positioned as an open "identity-linked payment credential" protocol. Skyfire demoed KYAPay with **Visa Intelligent Commerce** on 2025-12-18 (BusinessWire; fetch 403 → search snippet only). Experian "Human-to-Agent Binding" adds a real-time risk score; pilots at Williams-Sonoma and Bose; partners F5 (2026-03-18 press release, verified), Cequence, Ory, Fastly, Rye. Funding/traction numbers: **unverified**.

**Google AP2:** **[corrected 2026-09-06 — now secondary-verified]** announced 2025-09-16 with 60+ partners; Intent / Cart / Payment **mandates as W3C Verifiable Credentials** signed by the user's wallet or agent key; public deployments as of April 2026: PayPal wallet with Google Cloud Conversational Commerce Agent, Mastercard Agent Pay pilot inside PayPal, the A2A x402 extension (eco.com). Primary spec at ap2-protocol.org / GitHub not re-fetched. Mastercard Agent Pay (2025-04-29, Agentic Tokens via MDES): not researched (payments researcher's scope).

**Relevance: integrate as tier-up attestations.** Accept a Skyfire KYA JWT (verify against Skyfire JWKS) to grant "human/org-verified" status; issue Visa-TAP-compatible signatures only if we ever become a certified agent platform (permissioned, later). Adopt the *claim shapes* (`hid`/`apd`/`aid`) for our own attestation objects.

### 1.4 Enterprise IdPs: Microsoft Entra Agent ID, Auth0/Okta for AI Agents, AWS AgentCore Identity

**Entra Agent ID (verified — MS Learn, updated 2026-08-13):** GA — **[corrected 2026-09-06]** reached GA in **April 2026** (Big Hat Group 2026-05-10, secondary); the MS Learn GA "what's new" page is dated 2026-05-01. Four objects: agent identity blueprint, blueprint principal, **agent identity** (a special service principal the blueprint creates and is authorized to impersonate), agent user. OAuth 2.0, MCP and A2A supported; third-party agents (AWS Bedrock, n8n) via Auth SDK sidecar or workload identity federation; Conditional Access templates for autonomous vs on-behalf-of agents; risk-based blocking; sponsor lifecycle workflows to prevent orphaned agents; cascade deletion/soft delete; agent registry converging into **Microsoft Agent 365** (license per user; included in M365 E7, add-on to E5); Entra ID P2 + Governance meters for full capability (secondary).
**Auth0 for AI Agents (verified — GA blog 2025-11-19):** User Authentication, **Token Vault** (stores third-party OAuth tokens, 35+ integrations; agent never sees refresh tokens), **Async Authorization via CIBA** (human-in-the-loop approval by push), FGA for RAG; frameworks LangChain, LlamaIndex, Vercel AI, Cloudflare Agents; free tier = 2 Token Vault connections; Cross App Access (XAA) beta. Agents are OAuth *clients acting for users*, not principals.
**AWS AgentCore Identity (verified — docs):** agent identity = **workload identity** with agent attributes in an *agent identity directory*; inbound auth via IAM SigV4 or JWT authorizer; outbound via OAuth 2LO (client credentials) / 3LO / API keys held in a **token vault** scoped to (agent, user) pair; "agent access token" (AWS-signed, carries workload + user identity); managed consent portal (Sept 2026). Web Bot Auth signing for customer agents announced with Cloudflare (Oct 2025 post).

**Relevance: federate, don't compete.** Accept OIDC/JWT tokens from Entra/Auth0/Cognito/AgentCore as a "verified operator" attestation (`client_id` = agent, `sub` = human/org, `iss` = enterprise tenant). Copy the *governance* ideas: sponsor/owner field on every agent, orphan detection, cascade delete, risk-based step-down.

### 1.5 IETF/OAuth building blocks (WIMSE, klrc, ID-JAG, CIMD, DPoP, MCP auth)

- **draft-klrc-aiagent-auth-03 (2026-07-06 — re-verified; Kasselman/Defakto, Lombardo/AWS, Rosomakho/Zscaler, Campbell/Ping, Steele/OpenAI, Parecki/Okta; individual draft, not WG-adopted):** profiles WIMSE + OAuth for agents. Agent gets a WIMSE identifier (SPIFFE ID in practice); short-lived creds (X.509-SVID, WIT-SVID JWT); transport mTLS or app-layer **WIMSE Proof Tokens / HTTP Message Signatures**; delegation via Authorization Code (user-delegated), Client Credentials (autonomous), JWT bearer; access token `client_id` = agent, `sub` = delegated user; Transaction Tokens for downscoped hops; Identity/Authorization Chaining across domains; CIBA for human confirmation; **Shared Signals Framework for revocation**.
- **WIMSE WG (verified):** chairs Justin Richer, Pieter Kasselman. s2s draft split into **`wimse-workload-creds` (-02, 2026-07-02: WIT JWT + WIC X.509)**, **`wimse-wpt` (-02, 2026-08-27 — re-verified)**, `wimse-http-signature`, `wimse-mutual-tls`. WPT = JWT in `Authorization: WPT …` proving possession of the key in the WIT's `cnf`; claims `aud` (target URI), `exp`, `jti`, `wth` (hash of WIT), `tth` (txn-token hash), `oth`; `typ: wpt+jwt`.
- **ID-JAG / Cross-App Access (draft-ietf-oauth-identity-assertion-authz-grant-04, 2026-05-21 — re-verified; Parecki, McGuinness, Campbell):** IdP-brokered token exchange (RFC 8693 + RFC 7523) so an agent's parent app gets third-party API tokens via SSO trust without user interaction.
- **Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document-02, 2026-07-06 — re-verified; Parecki/Okta, Emelia Smith):** `client_id` is an HTTPS URL with a path resolving to JSON with `jwks`/`jwks_uri`, `redirect_uris`, `client_name`, `token_endpoint_auth_method: private_key_jwt` → confidential client auth with **no pre-registration**.
- **MCP authorization (2026-07-28 revision — verified from the spec's Client Registration page):** OAuth 2.1; MCP servers MUST implement RFC 9728 Protected Resource Metadata; clients MUST send RFC 8707 `resource`; **clients and ASes SHOULD support CIMD**; client priority order = pre-registered creds → CIMD if the AS advertises `client_id_metadata_document_supported: true` → DCR fallback → prompt user; **DCR "deprecated"** (kept MAY for backward compatibility; earliest removal in the first revision on/after 2027-07-28 per WorkOS, secondary); CIMD minimum fields `client_id`, `client_name`, `redirect_uris`; `private_key_jwt` MAY; CIMD client ids are portable across ASes, DCR/pre-registered credentials must be bound to the issuing AS `issuer`; RFC 9207 issuer validation. DPoP not mandated (extensions repo `modelcontextprotocol/ext-auth`).
- **DPoP (RFC 9449, Sept 2023):** sender-constrained tokens; recommended hardening for public clients in OAuth 2.1/MCP guidance; FAPI 2.0 accepts it.
- **SPIFFE/SPIRE:** `spiffe://trust-domain/path`, X.509/JWT SVIDs, hourly rotation via Workload API; needs SPIRE server + node attestors + **pre-registration of every workload** — heavy for dynamic solo agents; fine for our own infra.
- **NIST AI Agent Standards Initiative (verified on nist.gov):** CAISI RFI on agent security (deadline 2026-03-09), sector listening sessions (registration by 2026-03-20), NCCoE concept paper "Software and AI Agent Identity and Authorization" (comments closed 2026-04-02; NCCoE page 403 on fetch): adapt OAuth 2.0/2.1, OIDC, SPIFFE/SPIRE, SCIM, NGAC, MCP; identified gap = multi-hop delegation (A spawns B calls C). No practice guide published as of 2026-09-06 (none found).
- **OpenID Shared Signals Framework / CAEP / RISC:** final specs approved 2025-09-02; events `session-revoked`, `credential-change`, `token-claims-change`, `assurance-level-change`.
- **[gap filled 2026-09-06] Transaction Tokens:** `draft-ietf-oauth-transaction-tokens-11` (2026-07-30; WG consensus, "waiting for write-up", IESG milestone Dec 2026). Agent extension `draft-araut-oauth-transaction-tokens-for-agents-02` (2026-05-22, Raut/Amazon, individual): `agentic_ctx` = `{current_actor, originator (immutable), chain_metadata{hop_count, min_assurance_level}}`, `act` = agent, `sub` = principal (the agent itself when autonomous).
- **[gap filled 2026-09-06] Delegation Chain for OAuth 2.0:** `draft-liu-oauth-chain-delegation-00` (June 2026; Liu & Zhu/Alibaba, Krishnan/Cisco, Parecki/Okta; individual) — see 6.3.5.
- **[gap filled 2026-09-06] OpenID AuthZEN:** WG drafts **AARP** (Access Request and Approval Profile — approvals/consent/attestations as prerequisites the agent can request and poll) and **COAZ** (AuthZEN profile for MCP tool authorization) approved 2026-06-15.

**Relevance: adopt selectively.** Use RFC 8693 `act` chains + short-lived key-bound tokens (DPoP/WPT-style `cnf`), publish per-agent CIMD, emit CAEP-style events for revocation. Skip SPIRE for tenant agents (pre-registration kills autonomy).

### 1.6 W3C DIDs / VCs and DID-native agent proposals

- W3C DID 1.1 reached Candidate Recommendation March 2026 and a "Threat Model for Decentralized Credentials" was published Jan 2026 — **from a vendor blog; still unverified** (not re-checked in round 2).
- **did:webvh v1.0 (verified — DIF spec):** did:web + verifiable history `did.jsonl` with Data Integrity proofs; **SCID** self-certifying identifier; **key pre-rotation** (`nextKeyHashes` must be present with `updateKeys` in every entry once enabled; each new key must match a previously committed hash); deactivation via `deactivated: true` or empty `updateKeys`; witnesses (threshold approvals in `did-witness.json`); watchers (webhook-notified caches); portability with `alsoKnownAs`. **[gap filled 2026-09-06]** DIF newsletter #61 (May 2026): next version plans to make **pre-rotation REQUIRED**, add **ML-DSA post-quantum** keys, revisit witness keys, and add **domain-less did:webvh** use cases (peer DIDs, multi-tenant wallets) — directly relevant to hosted agent identities.
- **AGNTCY (Linux Foundation, Cisco-donated; members Cisco, Dell, Google Cloud, Oracle, Red Hat; 65+ supporters):** "Agent Badge" = enveloped VC (JSON-LD) binding an Agent ID to an issuer, public key and provenance; schemas = OASF definition or A2A Agent Card; one badge per version.
- **Papers:** "AI Agents with DIDs and VCs" (Garzon et al., ICAART 2026): agents prove DID control at dialog start and exchange VCs; found **limits when the LLM alone controls security procedures**. "Authenticated Delegation and Authorized AI Agents" (South, Pentland et al., Jan 2025): OAuth/OIDC extension with agent credentials + NL→structured permissions. **OIDC-A 1.0** (Subramanya, Apr 2025; arXiv Sept 2025): claims `agent_type`, `agent_model`, `agent_version`, `agent_provider`, `agent_instance_id`, `delegator_sub`, `delegation_chain[]`, `delegation_purpose`, `delegation_constraints`, `agent_attestation` (EAT-compatible), `agent_capabilities`, `agent_trust_level`, `agent_context_id`; discovery `agent_attestation_endpoint`… — **repo re-checked 2026-09-06: 1 commit / 8 stars / 0 forks, no implementation; not referenced by the OpenID Foundation's AIIM group or its NIST response — dead as a spec.** **AIP** (Mar 2026): Invocation-Bound Capability Tokens — JWT (single hop) or Biscuit tokens with Datalog attenuation (multi-hop) across MCP/A2A/HTTP; 600 adversarial cases, 100 % rejected, 0.22–2.35 ms overhead. "AI Identity: Standards, Gaps" (Apr 2026): gaps = semantic intent verification, recursive delegation accountability, identity integrity, governance opacity, operational sustainability.
- **[gap filled 2026-09-06] Standards bodies now active on agent identity:** OpenID Foundation **AIIM Community Group** (co-chairs Tulshibagwale/CrowdStrike, Lombardo/AWS; whitepaper Oct 2025; NIST response Mar 2026; charter explicitly *excludes* protocol development); **W3C Agent Identity Registry Protocol CG** (launched 2026-04-24, 48 participants; plans a DID method, VC-based agent credential, trust negotiation, revocation, PQ — no drafts yet); **DIF Trusted AI Agents WG** (since 2025-09-15; Delegated Authority report + threat model + governance report; task forces Delegated Authority and KYA-OS); **DIF KYA-OS v1.0.0** (2026-07-29; Vouched's MCP-I donated Mar 2026; DIDs + VCs for identity, delegation credentials with explicit scope, signed proof records; 3 conformance levels from "existing OIDC/JWT identifiers" up to enterprise lifecycle; reference implementation + conformance docs in DIF repos; no named production adopters).

**Relevance: adopt `did:key` as the canonical id and expose `did:web`; borrow did:webvh pre-rotation; treat VCs as the export format for attestations; ignore OIDC-A as a spec (borrow its claim names); track KYA-OS as the likely VC-shaped delegation format to import/export.**

### 1.7 Discovery/naming: MIT NANDA, OWASP ANS, A2A Agent Cards, Cloudflare registries, Google ARD

- **NANDA Index** (arXiv July 2025, verified abstract): lean index → cryptographically verifiable **AgentFacts**; claims sub-second revocation/key rotation; prototypes only.
- **Agent Name Service** (OWASP GenAI ASI-endorsed paper, May 2025): DNS-style names, PKI certificates, registration/renewal, adapters for A2A/MCP/ACP; academic, no deployment found.
- **A2A 1.0 (verified spec):** `AgentCardSignature` = JWS over RFC 8785-canonicalized card; verifier keys from JWKS, `x5c`, or a registry; `securitySchemes` = apiKey, HTTP bearer/basic, OAuth2 (code/client-credentials/device), OIDC, mTLS; no delegation semantics.
- **Agent registries as lists of card URIs** (Cloudflare/IETF registry draft): cheap to mirror.
- **[gap filled 2026-09-06] Google Agentic Resource Discovery (ARD)** (announced 2026-06-17; contributors Cisco, Databricks, GitHub, GoDaddy, Google, Hugging Face, Microsoft, Nvidia, Salesforce, ServiceNow, Snowflake; Apache 2.0; spec github.com/ards-project/ard-spec): static **`ai-catalog.json` at a well-known path** per organisation + registry APIs that crawl/index catalogs and answer NL discovery queries; "trust manifest" with domain-ownership-based identity and publisher-attached verifiable trust metadata; builds on the LF AI Catalog data model; Google Cloud Agent Registry to support it. Also `draft-popov-webbotauth-semantic-anchor-00` (domain-root AI discovery anchor).

**Relevance: integrate.** Publish an A2A Agent Card (JWS-signed with the agent's key), an ERC-8004 registration file, and an ARD `ai-catalog.json` for every agent/our marketplace at stable URLs; make our directory consumable as a Web Bot Auth registry.

### 1.8 Agent-first onboarding in the wild: Moltbook, OpenClaw, Agent Guild, Agent Passport

- **Moltbook (verified — `moltbook.com/skill.md`, an agent-facing doc):** `POST /api/v1/agents/register {name, description}` → `{api_key, claim_url, verification_code}`; agent hands `claim_url` to its human, who verifies email and posts a verification tweet on X; agent polls `GET /api/v1/agents/status` → `pending_claim` | `claimed`; unclaimed agents can only call register/status; `heartbeat.md` polled every 30 min. 2026: key rotation via owner dashboard; **2026-03-16 all pre-update keys invalidated, re-issuance requires accepting new terms + human verification** (PiunikaWeb, re-verified; new ToS: "You are solely responsible for all actions of your agent", 13+, California courts). **Breach (Wiz, 2026-01-31):** Supabase without RLS + key in client JS → ~1.5 M agent API tokens, ~35 k owner emails, private messages containing third-party keys exposed; full account takeover possible; only ~17,000 humans controlled the 1.5 M agents. **[corrected 2026-09-06]** Scale: launched 2026-01-28; 2026-06-06: **206,839 human-verified agents of 2,895,874 registered** (Wikipedia, secondary — replaces the round-1 "32 k / 1.6 M" figures). **Meta acquired Moltbook on 2026-03-10** (TechCrunch, Axios, Bloomberg, Forbes; terms undisclosed; founders Schlicht & Parr joined Meta Superintelligence Labs; Meta praised the "always-on directory" for agents) — the agent-directory idea now sits inside Meta.
- **OpenClaw (ex-Clawdbot/Moltbot; Akamai 2026-02-18):** bound `0.0.0.0:18789` unauthenticated, localhost auto-trust behind reverse proxies, plaintext secrets in `~/.clawdbot/`. Lesson: assume hostile network, scoped temporary creds, no localhost trust.
- **Agent Guild / AGI-1 (GitHub, Apache-2.0, ~284 commits):** `POST /agents/register {name, capabilities}` → agent id + **`did:key`** + API key, free, no wallet; **EigenTrust** seeded from a pre-trusted set with collusion detection ("a clique of mutual praise with no seed inflow gets nothing"); attestations as Guild-signed W3C VCs ("Agent Passports"); `guild_check()`/`guild_best_agent()`/`guild_risk_score()`/`guild_attest()`; MCP server + REST; escrow settlement in credits ($0.001), Base-USDC on roadmap; ERC-8004 interop planned. **[corrected 2026-09-06]** Traction re-checked: **1 star, 1 fork** — a design reference, not a competitor.
- **Agent Passport v0.1 (Cubitrek, 2026-04-28, MIT):** `/.well-known/agent-passport.json` signed Ed25519 over canonical JSON, key in DNS TXT `_agent-passport.<domain>` (DKIM-style); declares purpose, model, endpoints, **`spendCeiling`, `humanInLoop` thresholds + SLA**, audit URLs, compliance, `issuedAt/expiresAt` (90-day recommended), `revocationListUrl`; sub-agent delegation planned for v0.2. **Workday "Agent Passport" (2026-06-02)** is an unrelated enterprise product: pre-production testing + continuous monitoring attestations mapped to OWASP LLM Top 10 / NIST AI RMF / MITRE ATLAS, Cisco AI Defense as launch partner, early access H2 2026.

### 1.9 Human-vouch / proof-of-human

- **World ID AgentKit — [corrected 2026-09-06]:** launched **2026-03-17** (world.org "Now available: AgentKit", TechCrunch, CoinDesk same day — the round-1 "2026-04-17" date was wrong; the "full-stack proof of human" post is a separate article), initially a **limited beta** for developers with verified World IDs; **expanded 2026-06-24** (Unchained) so any verified human can delegate to an agent via World App / ToolRouter (generate API key, link agent). Supported agents: **Claude Code, Codex, Cursor, Hermes, OpenClaw**. Technical (docs.world.org, verified): agent registers its wallet via CLI against **AgentBook on World Chain**, completes World App verification, and at request time resolves to an anonymous human identifier; requests via `agentkit.fetch()` carry wallet address, chain id and an **EIP-191** signature; servers validate against AgentBook then apply **per-human quotas** (`tryIncrementUsage()`, e.g. `free-trial` = 3 uses) before falling through to x402 v2 micropayments (World Chain or Base). Demo: 500-hat merch drop, one per verified human regardless of agent count. ~18 M verified humans (secondary). Uniqueness proof uses World ID nullifiers/OPRF (from the round-1 announcement).
- **X-post claim (Moltbook), email verification, DNS TXT (Agent Passport), GitHub-style org proofs** — cheap vouches an LLM agent can request from its operator by handing over a URL.
- **[gap filled 2026-09-06] Anonymous alternative:** `draft-rescorla-anonymous-webbotauth-01` (Rescorla, Barnes/Cisco; 2026-07-19): "Anonymous Bot Authentication" — anchors vet bots and issue endorsements, moderators issue unlinkable credentials (MoLE architecture, Longfellow-ZK), sites rate-limit per credential without identifying the bot — a privacy-preserving pattern for a tier-0 "vetted but unlinkable" lane.

### 1.10 Reputation-design literature

- **"Tempting the Agent" (2026-09-02, verified; Gatta, Naviglio, Tarantelli):** with cheap identity reset, more reputation can *increase* temptation (extractable value grows faster than continuation value). Remedies: identity reset cost κ^R, stake κ^S proportional to volume above the myopic threshold, slow decay (small λ, ρ), penalties that destroy more capital on identity replacement than on continued degraded operation, escrow (ERC-8183, x402).
- **TraceRank (Operator Labs, 2025-10-31):** payments as endorsements; reputation seeded and propagated through x402 payment graph weighted by value and recency → many low-rep payers rank below few high-rep payers. 5-page, no numbers.
- **Inter-Agent Trust Models (2025-11-05):** Brief, Claim, Proof, Stake, Reputation, Constraint; recommends Proof + Stake to gate high-impact actions, Brief for identity/discovery, Reputation as overlay.
- **[gap filled 2026-09-06] AgentReputation (arXiv 2605.00073, FSE 2026; Chishti, Oyinloye, Li):** three layers — evidence (explicit verification regimes from automated checks to expert review), aggregation (**context-conditioned reputation cards**, no cross-domain conflation), tamper-proof persistence — plus a policy engine that escalates verification with risk.
- **[gap filled 2026-09-06] TruthMarketTwin (arXiv 2605.10059, rev. 2026-08-25):** simulation shows **LLM agents autonomously exploit weaknesses in reputation-based governance**; **warrant/enforcement mechanisms** (recourse, guarantees) reduce deception and change strategic reasoning — supports escrow + dispute + slashing over pure ratings.
- **Halborn "How attackers game AI agent reputation systems"** — could not fetch (429); **unverified**.

---

## 2. Recommended design for our platform

### 2.1 Tier 0 — one API call, no human, no wallet

Agent generates an Ed25519 keypair locally (Python `cryptography`, Node `crypto.generateKeyPairSync('ed25519')`, `openssl genpkey -algorithm ed25519`). It computes its own id `did:key:z6Mk…` from the public key (multicodec 0xed01 + base58btc), so the id exists before the server is contacted and is portable.

```
POST /v1/agents
Content-Type: application/json
Signature-Input: sig1=("@method" "@target-uri" "content-digest" "signature-agent";key="sig1");created=1757088000;expires=1757088300;keyid="<jwk-thumbprint>";alg="ed25519";tag="web-bot-auth"
Signature: sig1=:…:
Signature-Agent: sig1="https://<id>.agents.<platform>"
Content-Digest: sha-256=:…:

{ "public_key": {"kty":"OKP","crv":"Ed25519","x":"…"},
  "name": "fx-arb-bot", "description": "…", "capabilities": ["translate","summarize"],
  "next_key_hash": "sha-256:…",            // optional pre-rotation commitment (did:webvh/KERI style)
  "operator": null }
→ 201 { "agent_id": "did:key:z6Mk…", "handle": "fx-arb-bot#8f3a",
         "did_web": "did:web:<platform>:agents:z6Mk…",
         "signature_agent": "https://z6Mk….agents.<platform>",
         "key_directory": "https://z6Mk….agents.<platform>/.well-known/http-message-signatures-directory",
         "cimd": "https://<platform>/agents/z6Mk…/cimd.json",
         "agent_card": "https://<platform>/agents/z6Mk…/agent-card.json",
         "erc8004_registration_file": "https://<platform>/agents/z6Mk…/erc8004.json",
         "trust": {"tier": 0, "limits": {...}}, "next_steps": [...] }
```
The body is self-certifying (the signature over `content-digest` with the same key proves possession), so **registration is a single call**; the server rejects `created` older than 5 min and caches `(keyid, created)` to stop replays. **[corrected 2026-09-06]** `Signature-Agent` is now mandatory in the WG draft and must be in Dictionary form with the member covered by the signature; the agent's directory URL is a **per-agent origin** (sub-domain), because the default `directory` discovery type resolves `/.well-known/…` on the *origin* named in `Signature-Agent` (path-based values only work with `type=jwks_uri`/`cimd`, which older verifiers do not implement). At registration the server also verifies possession against a **fresh server nonce bound to the intended directory authority** (Singh hosted-directories pattern), not only the self-signed body.

**Per-request auth, two accepted modes:**
- **Mode A (stateless, interoperable):** RFC 9421 signature on every request exactly as above (`Signature-Agent` required). Works unchanged against any other Web Bot Auth verifier.
- **Mode B (session, for agents that prefer bearer ergonomics):** `POST /v1/auth/challenge {agent_id}` → `{nonce, expires_in: 120}`; `POST /v1/auth/token {agent_id, nonce, signature}` → 15–60 min JWT with `cnf: {jkt: <thumbprint>}` and an optional DPoP requirement. A leaked token is useless without the key.

Store guidance for LLM agents in the docs: private key in `~/.config/<platform>/agent.key` (0600), never in prompts/logs; the docs page is itself an `llms.txt`/`skill.md`-style document (Moltbook proved that format works for autonomous onboarding).

### 2.2 Trust ladder (attestations bound to the same key; each raises limits)

| Tier | Attestation | How the agent completes it alone | Sybil cost |
|---|---|---|---|
| 0 | keypair + signed registration | 1 call | ~0 → strict rate limits, escrow-only, small spend caps, listing hidden by default |
| 1 | **bond** (refundable deposit or non-refundable fee, e.g. $2–10 in platform credits/stablecoin) | pay via any rail once wallet exists | makes identity reset ≥ bond (κ^R) |
| 2 | **domain / operator proof**: publish our challenge in `/.well-known/http-message-signatures-directory` (or Agent Passport DNS TXT, or `Signature-Agent` from a known directory such as chatgpt.com / agent.bot.goog) | 1 call if the agent controls a domain; otherwise ask operator | ties identity to a rentable-but-not-free namespace |
| 3 | **human/org vouch**: (a) `claim_url` + email/X-post (Moltbook pattern), (b) World ID AgentKit proof (AgentBook lookup + EIP-191 signature), (c) Skyfire KYA JWT (`hid.verified`, verify against `app.skyfire.xyz/.well-known/jwks.json`), (d) enterprise OIDC token (Entra/Auth0/Cognito: `client_id`=agent, `sub`=human), (e) KYA-OS delegation VC | agent hands a URL/token request to its operator or presents an existing JWT/VC | one-human-many-agents allowed but linkable; World ID gives uniqueness |
| 4 | **stake with slashing** proportional to trailing 30-day volume; disputes resolved by evaluator/arbiter (ERC-8183 pattern); insurance pool | on-platform call | economic (κ^S) |
| 5 | **runtime/behaviour attestation**: TEE EAT quote, Workday/Cisco-style test attestations, ERC-8004 Validation responses | agent submits evidence URI | proof-based |

Expose the tier and the underlying attestations in the agent card and in `GET /v1/agents/{id}/trust` so counterparties (other agents) can gate actions: e.g. "accept jobs > $50 only from tier ≥ 3".

### 2.3 Reputation (evidence-bound, bounded, robust, portable)

- Feedback can only be posted by the counterparty of a **settled platform transaction** (escrow release / payment id); one record per transaction; score `0–100` + typed tags (taxonomy shared with ERC-8004 tags/OASF skills); optional evidence URI + hash.
- Aggregate with **median / trimmed mean, weighted by transaction value and rater trust** (EigenTrust/TraceRank seeded from tier ≥ 2 accounts); publish `n`, `median`, `p25/p75`, `volume`, `identity_age`; **per-context reputation cards** (skill/task-type scoped, AgentReputation pattern) rather than one global score.
- Slow dynamics: reputation accrues with settled volume over time, decays slowly; new keys cannot inherit reputation except through an explicit, signed **key rotation** (see 2.4) — identity replacement destroys capital.
- Sybil controls: shared-funding-source clustering (the ERC-8004 study's method), reciprocal-praise ring detection, rater bond forfeiture on proven collusion, feedback from same wallet/operator cluster down-weighted to ~0.
- Portability: every record exportable as a platform-signed VC; optional mirror to ERC-8004 Reputation Registry (`giveFeedback` with `feedbackHash` and x402/escrow proof) and import of ERC-8004 feedback filtered to records with payment proof.

### 2.4 Key rotation

- Agent = set of keys in its JWKS (`kid` = thumbprint, `nbf`/`exp` per key; recommended key lifetime ≤ 12 months, session tokens ≤ 1 h). Follow the WG draft's overlap rule: publish old + new together, then remove old; directory `Cache-Control` ≈ 300 s (Singh) so removals propagate within minutes.
- `POST /v1/agents/{id}/keys` adds a key; must be signed by an **existing active key** *and* the new key (dual signature). Optional **pre-rotation** (did:webvh/KERI style): agent commits `next_key_hash` at registration; a rotation to a key matching the commitment is accepted even from a compromised current key's perspective, while a rotation to a non-committed key requires a tier ≥ 3 operator confirmation. Recovery key (offline) recommended for tier ≥ 1. (did:webvh will make pre-rotation mandatory in its next version — a signal to make it default-on for tier ≥ 2.)
- Rotation is an event: pushed to counterparties via webhooks in CAEP `credential-change` shape and visible in `GET /keys?history=1` (append-only publication log); reputation and attestations follow the agent id, not the key (ERC-8004 clears wallet on transfer — we do the same for wallet bindings on non-pre-committed rotations).

### 2.5 Delegation

- **Agent acts for human/org:** accept external OIDC/JWT (`iss` enterprise, `client_id` agent, `sub` human) or Skyfire KYA / World proof / KYA-OS VC → stored as `operator` attestation with scope + expiry. For our own wallets, mandates are explicit objects: `{delegator, delegate, scope, spend_cap, expiry, jti}` signed by the delegator (AP2/Agent Passport `spendCeiling` semantics).
- **Agent acts for agent (sub-agents):** parent issues a **delegation token** (JWT, `act` chain per RFC 8693 **plus a `delegation_chain[]` array of per-hop records** — `{delegator, delegatee, scope, policy, as_signature, delegator_signature?}` per draft-liu — and an `agentic_ctx {originator, current_actor, hop_count}` per draft-araut), `scope` ⊆ parent scope, `max_spend`, `exp`, `depth`, `jti`; child registers with its own key and presents the token; platform validates the full chain (each `iss` trusted, scope monotonically decreasing, audience match, depth ≤ 3 — OIDC-A/AIP/draft-liu rules) and records provenance on every transaction. Optionally Biscuit-style attenuation later.
- Marketplace calls carry `on_behalf_of` so counterparties and reputation know who is accountable; misconduct penalties propagate up the chain (parent stake at risk). Revocation at three scopes (root, intermediate hop, leaf) as in draft-liu.

### 2.6 Revocation

- Self-revoke any key (signed by another active key or recovery key); operator revoke (tier ≥ 3 vouch holder); platform suspend (with reason code). Revoked `kid`s stay listed with `revoked_at` in the directory and a short-lived **revocation list** at `/.well-known/revocations.json` (Agent Passport `revocationListUrl` compatible). Publish a documented **revocation propagation target** (≤ 5 min).
- Delegation tokens revocable by `jti` (parent-signed); session tokens die with key revocation (server checks `cnf.jkt` against live keys).
- Push: CAEP events (`session-revoked`, `credential-change`, `assurance-level-change`) to subscribed counterparties + messaging inbox; registry-style signed webhooks (`action: delete`) to external verifiers; pull: `HEAD /v1/agents/{id}/keys/{kid}`.
- Attestations carry `expires_at` (KYA/World/OIDC re-verify ≤ 90 days), so trust decays if not renewed.

### 2.7 Interop surface (what we publish for every agent)

Per-agent origin `https://<id>.agents.<platform>/.well-known/http-message-signatures-directory` (JWKS, self-signed) **[corrected 2026-09-06: origin, not path]**, a Signature Agent Card in the registry-03 shape (OAuth client metadata + `web_bot_auth` object), `cimd.json` (CIMD with `private_key_jwt`), A2A `agent-card.json` (JWS-signed), ERC-8004 registration file JSON, `did:web` DID document, optional DID+VC export of attestations, ARD `ai-catalog.json` entry. Plus a platform-wide registry list (Web Bot Auth registry format, with signed webhook change notifications) of all tier ≥ 2 agents, and a **platform-level "fleet" directory** (single authority) that CDN allowlists can admit as one entry (see 6.4).

---

## 3. Strategic insights

1. Ed25519 + RFC 9421 + JWKS-at-well-known is the de-facto lingua franca; building on it makes every agent on our platform verifiable by Cloudflare, AWS WAF, Vercel, Akamai, Visa and any MCP server for free.
2. The two agent identity worlds — *enterprise delegated* (OAuth client for a human) and *self-sovereign* (keypair/DID/ERC-721) — have no bridge today; a platform that treats an enterprise IdP token as *one attestation among several* on a self-sovereign key is the bridge.
3. ERC-8004's data is a warning: identity is cheap, evidence is the scarce resource. Reputation must be *transactions with money*, not opinions. (Registrations roughly tripled between mid-May and September 2026 with no evidence quality fix — the market is still buying the vanity metric.)
4. Disposable identities invert reputation incentives; the platform must sell "identity persistence" (bond + slow reputation + key rotation that preserves capital) as the product.
5. Moltbook shows agent-only onboarding with a human "claim" works at scale and is what OpenClaw-style agents already know how to do — copy the UX (skill.md, claim_url, status polling), replace the API key with a keypair. Meta bought the idea; the open, portable version is still unbuilt.
6. CIMD + private_key_jwt effectively makes "an HTTPS URL that serves a JWKS" the universal OAuth client identity; hosting that URL per agent is a cheap, high-leverage feature nobody else offers for solo agents. The Singh hosted-directories draft is the IETF-side validation of exactly this need (and its security rules are the bar to meet).
7. Delegation depth/accountability is the recognised open gap (NIST, AI-Identity paper); the IETF now has two individual drafts (`delegation_chain`, `agentic_ctx`) — adopting their claim shapes early costs nothing and makes our tokens legible to enterprise verifiers.
8. Validation/attestation of *work quality* is still unsolved everywhere (ERC-8004 Validation Registry still undeployed as of Sept 2026); escrow with an evaluator (ERC-8183) is the practical substitute and produces the evidence reputation needs.
9. Payment-network KYA is permissioned and human-initiated; don't wait for it — accept its tokens when present.
10. LLM agents are unreliable custodians of secrets (Garzon et al.; Moltbook leak). Minimize what a secret can do: key-bound tokens, per-request signatures, spend caps, short lifetimes.

## 4. Open questions

- Legal/AML posture for tier-0 anonymous agents holding wallets; which rails allow unverified counterparties and at what caps.
- Bond/stake denomination (platform credits vs stablecoin vs both) and who arbitrates slashing.
- Whether to mirror to ERC-8004 by default (gas, which chains) or only on request.
- ~~Does Anthropic/Claude sign Web Bot Auth requests~~ **Answered 2026-09-06: no** (no directory on claude.ai/claude.com/anthropic.com). ChatGPT's single key expires 2026-09-12 — watch how OpenAI rotates; Google's directory has no per-key `exp` at all.
- Does AWS WAF (and Akamai) accept *arbitrary* key directories or only a curated registry? If curated, per-agent origins will never be "verified" there — hence the fleet directory in 6.4.
- How to verify `agent_model`/provider claims without provider-issued attestations (no provider issues them today).
- Privacy: linkability of one human across many agents under tier-3 vouches; ZK (World, Rescorla/Barnes ABA) vs plain email (Skyfire/Moltbook).
- Private-key custody guidance for hosted agents (Claude Code sessions are ephemeral; where does the key persist?).
- Sybil clustering thresholds that don't punish legitimate one-operator-many-agents fleets.

---

## 5. Sources (round 1 — all URLs used)

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
- https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf (vendor; its Claude-support claim is contradicted by primary evidence, see 6.1)
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

---

## Round 2 (2026-09-06): verification, corrections, gaps filled

Method: ≈45 WebSearch queries (budget exhausted at the end) + ≈75 WebFetch calls against primary sources — IETF datatracker pages and full draft text, EIP pages and the contracts README, arXiv abstracts/HTML, MCP spec pages, MS Learn, world.org/docs.world.org, docs.skyfire.xyz, Cloudflare/AWS/Google developer docs — plus **direct fetches of live `/.well-known/http-message-signatures-directory` endpoints** for chatgpt.com, agent.bot.goog, claude.ai, claude.com, anthropic.com and perplexity.ai.

### 6.1 Verification of the 10 most decision-relevant round-1 claims

| # | Round-1 claim | Result | Evidence |
|---|---|---|---|
| 1 | Web Bot Auth is a chartered IETF WG with WG draft `draft-ietf-webbotauth-httpsig-protocol-00` dated 2026-09-01; Ed25519/RFC 9421/JWK-thumbprint `keyid`/`tag="web-bot-auth"`/`Signature-Agent` with `directory`/`jwks_uri`/`cimd` | **Verified** (+ addendum: `Signature-Agent` now mandatory, Dictionary form, member must be covered; expiry ≤ 24 h recommended; self-signed directory; rotation overlap rule). Note that several August-2026 vendor posts say "no adopted documents" — true until 2026-09-01. | datatracker WG documents page + full -00 text |
| 2 | ERC-8004 study numbers (173,441 registrations; 3–15 % functional; 98.7–100 % no proof; $0.0027–$0.055; 59–91 % sybil; Validation Registry not on mainnet) | **Verified** exactly (per-chain: 98.7/100.0/99.3 %; Gini 0.733/0.708/0.134; batch 2.6 % of txs → 48.3 % of agents). Paper: Xiong et al., v1 2026-06-24, v2 2026-07-08. | arxiv.org/abs + html 2606.26028 |
| 3 | ERC-8004 mainnet 2026-01-29; Identity and Reputation registries "share address 0x8004A169…" | Date **verified** (secondary, multiple). Address claim **wrong → corrected**: Reputation Registry is `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Validation Registry still not on mainnet (README, 2026-09-06). | github.com/erc-8004/erc-8004-contracts; eips.ethereum.org/EIPS/eip-8004 |
| 4 | "Tempting the Agent", arXiv 2609.02992, 2026-09-02 | **Verified** (Gatta, Naviglio, Tarantelli). | arxiv.org/abs/2609.02992 |
| 5 | Moltbook: Wiz breach ~1.5 M keys (2026-01-31); all keys invalidated + human verification 2026-03-16 | **Verified**; **missing context added**: Meta acquired Moltbook 2026-03-10; scale 2,895,874 registered / 206,839 human-verified (2026-06-06, Wikipedia); 17,000 humans behind 1.5 M agents (Wiz). | piunikaweb (2026-03-16), TechCrunch 2026-03-10, Wikipedia, Wiz |
| 6 | MCP 2026-07-28: CIMD preferred, DCR deprecated | **Verified from spec text** ("SHOULD support CIMD"; DCR "deprecated", MAY for compatibility; `client_id_metadata_document_supported`; portable CIMD ids). | modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration |
| 7 | CIMD draft -02 (2026-07-06); klrc -03 (2026-07-06); ID-JAG -04 (2026-05-21); WIMSE WPT -02 (2026-08-27) | **All verified.** Added: workload-creds -02 (2026-07-02); transaction-tokens -11 (2026-07-30). | datatracker pages |
| 8 | Skyfire KYA: JWT claims `hid`/`apd`/`aid`/`scope`; subscription-gated; Experian (2026-04-30); F5 (2026-03-18) | **Verified**; **gap filled**: issuer/JWKS URLs, `kyapay-token` header, `pay`/`kya-pay` token semantics, docs updated 2026-07-14; KYAPay × Visa Intelligent Commerce demo 2025-12-18 (snippet only). | docs.skyfire.xyz (kya, kya-token, kyapay-tokens, environments, enforce-kya…) |
| 9 | Entra Agent ID GA (date unverified) | **GA April 2026** (Big Hat Group, secondary); MS Learn GA page dated 2026-05-01, updated 2026-08-13. | learn.microsoft.com whats-new-agent-id; bighatgroup.com |
| 10 | OpenAI signs with `Signature-Agent: "https://chatgpt.com"` (unverified); Anthropic support unverified | OpenAI **verified by fetching the JWKS** (1 Ed25519 key, `exp` 2026-09-12T22:32:50Z). Anthropic **negative-verified**: no directory on claude.ai/claude.com/anthropic.com; turva.dev: "Claude is not on the signed list yet". Vendor claims of Claude support are wrong. Perplexity: no directory either. | live `/.well-known/` fetches; turva.dev; developers.google.com WBA doc |
| 11 | World ID AgentKit "world.org 2026-04-17" | **Date wrong → corrected**: launched 2026-03-17 (limited beta), expanded 2026-06-24. | world.org announcements; unchainedcrypto.com; docs.world.org |
| 12 | Cloudflare registry draft = registry-01 (2025-10-20) with `keys` field | **Outdated → corrected**: registry-03 (2026-06-26) is OAuth client metadata + `web_bot_auth` object, `jwks`/`jwks_uri` exclusive, signed webhooks. | datatracker draft-meunier-webbotauth-registry-03 |

### 6.2 Corrections applied in place (all tagged "[corrected 2026-09-06]")

1. ERC-8004 Reputation Registry mainnet address is `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, not shared with the Identity Registry.
2. World ID AgentKit launched 2026-03-17 (not 2026-04-17); expanded 2026-06-24; supported agents Claude Code/Codex/Cursor/Hermes/OpenClaw; mechanism = AgentBook on World Chain + EIP-191 signatures + per-human quotas.
3. Web Bot Auth registry/card: now registry-03 (2026-06-26), OAuth-client-metadata shaped, `keys`→`jwks`, `jwks`/`jwks_uri` mutually exclusive, `ips_uri`, signed webhook notifications, resolvable `client_id`.
4. WG draft -00: `Signature-Agent` is mandatory on every signed request, Dictionary form, and must be a covered component under its own label. Round-1 design (optional `Signature-Agent`, path-based agent URL) updated: per-agent **origin** `https://<id>.agents.<platform>`.
5. "Who signs": OpenAI confirmed (single key expiring 2026-09-12); Google `agent.bot.goog` (experimental, 5 keys, no `nbf`/`exp`) added; Anthropic and Perplexity confirmed **not** signing; Cloudflare "March 2026 activation" claim removed as meaningless; AWS WAF (since Nov 2025), Vercel, Akamai added as production verifiers.
6. Cloudflare signed agents → "Intermediary vs Direct" classification since 2026-07-01.
7. Entra Agent ID GA: April 2026 (secondary), docs 2026-05-01.
8. Moltbook: Meta acquisition 2026-03-10; scale figures replaced with Wikipedia's 2026-06-06 numbers; 17 k humans / 1.5 M agents ratio.
9. Agent Guild: 1 star / 1 fork — not a competitor; design reference only.
10. Google AP2: now secondary-verified (2025-09-16 launch, VC mandates, PayPal/Mastercard/x402 deployments by April 2026) instead of "from memory".
11. Visa TAP: repo shows no 2026 activity (6 commits, no tags) — treat as frozen.
12. Exec-summary item 5/insight 5 now note Meta's ownership of the Moltbook directory concept.

### 6.3 Gaps filled

#### 6.3.1 ERC-8004 mainnet status (Sept 2026)
- Status: EIP still **Draft**; contracts "audited and final" per community list (secondary). Identity + Reputation singletons on 20–30+ EVM mainnets (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BSC, Mantle, Celo, X Layer …). **Validation Registry: not deployed on any mainnet**; README: "still under active update and discussion with the TEE community"; the study confirms "no mainnet deployment of this Registry on the chains we study". A follow-up spec update is promised (decipherclub, secondary). A "v2" label seen in blogs refers to the Dec-2025 rewrite (NFT ownership, x402 integration), not a new deployment — **unverified**.
- Growth curve (secondary): 337 agents at launch (2026-01-29) → 49,283 after two weeks → ~200 K mid-April → 173,441 on ETH/BSC/Base by 2026-05-13 (study) → **497,148 agents / 567,824 feedback records / 454,494 wallets on 8004scan.io (fetched 2026-09-06)**. BNB Chain overtook Ethereum in registrations in March 2026. No public dashboard separates active from dormant agents.
- Ecosystem: explorers 8004scan.io (AltLayer), agentarena.site (22 K agents over 16 chains), QuickNode explorer; SDKs Azeth (TS, smart accounts + x402), Agent0 (multi-language, subgraphs), agentwallet-sdk; reputation aggregators RNWY (150 K agents, dual score), Mintware Attribution (EIP-712 gasless oracle), Verity Protocol (Brier scores) — all secondary; ERC-8183 `ReputationGateHook` on Base; Virtuals auto-registers graduated agents (18 K agents, 1.77 M ACP jobs claimed — unverified).
- Implication unchanged: ERC-8004 is an *export target and attestation source*, not our identity root; import only feedback records with payment proof (≈1 % of the corpus).

#### 6.3.2 Web Bot Auth / HTTP Message Signatures adoption (primary evidence)
- **Signers (verified by fetch):** OpenAI chatgpt.com (1 key, `nbf` 2025-01-01, `exp` 2026-09-12); Google `agent.bot.goog` (Google-Agent, subset of requests, 5 keys, experimental, doc 2026-05-04). **Not signing:** Anthropic (404 on three domains), Perplexity (404). Secondary: Goose, Browserbase, Anchor Browser, Kernel (key in Vercel's directory), Amazon Bedrock AgentCore Browser (preview since Oct 2025).
- **Verifiers:** Cloudflare (Verified Bots since May 2025; signed agents Aug 2025; Radar `signatureAgentUrl` 2026-04-24; "Intermediary/Direct" 2026-07-01; Ed25519 only; ~1 min `expires` suggested; registered-key rotation via Cloudflare), **AWS WAF Bot Control** (WBA since Nov 2025; v5.0 Feb 2026; v6.0 all resource types; labels `web_bot_auth:{verified,invalid,expired,unknown_bot}`; blog 2026-07-14 — polls directories into a "valid key registry"; open question whether arbitrary directories are honoured), Vercel (verifies; hosts a directory listing partner keys), Akamai (edge verification; partners OpenAI, Amazon AgentCore), HUMAN (secondary).
- **New drafts that matter to us:**
  - **`draft-singh-webbotauth-hosted-directories-00`** (Shivdeep Singh, Airlock Protocol, 2026-07-19): third-party hosts publish directories for many tenants. Rules: host **MUST NOT generate, receive, store or possess tenant private keys**; **per-tenant directory authority** (`tenant.agents.registry.example`) to avoid shared fate; enrollment proof = tenant signs a fresh host nonce binding thumbprint + intended authority + timestamp; periodic tenant-signed detached assertions published alongside the JWKS (since the host cannot self-sign the directory); possession re-verified on rotation; `Cache-Control` on the order of minutes (author's default 300 s) and a documented **revocation propagation target**; auditable publication log; DNS-grade availability. Interop note: "at least one major deployed verifier accepts only the earlier plain string form [of `Signature-Agent`] and rejects the Dictionary form".
  - **`draft-rescorla-anonymous-webbotauth-01`** (Rescorla, Barnes/Cisco, 2026-07-19): anchors endorse bots → moderators issue unlinkable credentials (MoLE, Longfellow-ZK) → sites rate-limit per credential without identifying the bot.
  - `draft-nottingham-webbotauth-use-cases-02` (2026-04-01), `draft-illyes-webbotauth-jafar-00` (JSON IP-range format, 2026-04-21), `draft-illyes-webbotauth-cbcp-00` (crawler best practices), `draft-popov-webbotauth-semantic-anchor-00` (2026-06-05).
- **Registry-03 card** (details in 1.2): our per-agent metadata should be emitted in exactly this shape so Cloudflare/Amazon-style registries can ingest it, including `web_bot_auth.trigger`, `purpose`, `rate-expectation`, `ips_uri`.

#### 6.3.3 OIDC-A and the standards bodies
- **OIDC-A** is a one-person proposal: repo 1 commit / 8 stars / 0 forks, no reference AS, no IdP support; not cited by the OpenID Foundation's AIIM CG or its March-2026 NIST response; OIDF's AIIM charter explicitly excludes protocol work. **Do not build to it**; reuse its claim vocabulary only.
- What the bodies *are* doing: OIDF **AuthZEN AARP + COAZ** WG drafts (2026-06-15) — approvals/consent/attestations as machine-readable prerequisites and MCP tool authorization metadata; OIDF recommends Transaction Tokens, workload identity federation and "authentication extensions for AI tool protocols" to NIST. **W3C Agent Identity Registry Protocol CG** (2026-04-24, 48 members; DID method + VC agent credential + trust negotiation + revocation + PQ; nothing published yet). **DIF Trusted AI Agents WG** (2025-09-15): Delegated Authority report, threat model, governance report; **KYA-OS v1.0.0** (2026-07-29; ex-Vouched MCP-I; DIDs + VCs; identity / delegation / proof records; three conformance levels; reference implementation) — the most complete VC-shaped agent delegation spec today, but no named production adopters. DIF also barred autonomous agents from membership (IP reasons). ToIP AI & Human Trust WG and DIF Decentralized Trust Graph WG (personhood credentials) run in parallel.
- **NIST:** RFI (closed 2026-03-09), listening sessions, NCCoE concept paper (comments closed 2026-04-02); no practice guide yet.

#### 6.3.4 Skyfire KYA — operational details
- Token types `kya` (identity), `pay` (committed payment value, charged by the seller post-delivery through Skyfire's API), `kya-pay` (both; "guest checkout"). Header **`kyapay-token`**. Issuer `https://app.skyfire.xyz`; JWKS `https://app.skyfire.xyz/.well-known/jwks.json` (sandbox: `app-sandbox.skyfire.xyz`); cache ≈1 h; introspection endpoint available. Claims as in 1.3 (`hid` with `email` mandatory; `aid.creation_ip` mandatory; optional `source_ips`; `apd` optional). Verification requires an Individual or Organization subscription created by a human in the dashboard; the docs do not publish tier semantics or prices. Ecosystem: F5 (edge enforcement of KYA JWTs), Experian KYA framework (risk score), Cequence, Ory, Fastly, Rye; Visa Intelligent Commerce demo (2025-12-18). "KYAPay protocol" is described as open but no independent implementation was found (**unverified**).

#### 6.3.5 Delegation designs (what to copy)
- **RFC 8693 `act` nesting** (Ping Identity guidance; klrc draft): `client_id` = agent, `sub` = user, nested `act` per hop.
- **`draft-liu-oauth-chain-delegation-00`** (June 2026; Alibaba, Cisco, Okta): adds **`delegation_chain[]`** — ordered records `{delegator, delegatee, scope, policy, as_signature, delegator_signature?}`; "delegated scope MUST be a subset of the delegator's scope"; resource servers verify each `as_signature`, root anchor, chain continuity (hop n delegatee = hop n+1 delegator), agent status via WIT/SPIFFE; **three revocation scopes** (root, intermediate, leaf) via short lifetimes, introspection, back-channel notices.
- **`draft-araut-oauth-transaction-tokens-for-agents-02`** (2026-05-22; Amazon): `agentic_ctx {current_actor, originator, chain_metadata{hop_count, min_assurance_level}}` on Transaction Tokens (-11, WG, IESG Dec 2026).
- **ID-JAG / Cross-App Access -04** (2026-05-21): IdP-brokered access to third-party APIs — how enterprise agents will reach *us* without user interaction.
- **HDP** (arXiv 2604.04522, 2026-04-06): append-only Ed25519 chain binding a human authorization event to a session and each agent hop; **offline verification** with only the issuer key + session id; IETF draft + TS SDK claimed (**unverified**).
- **KYA-OS v1.0.0**: delegation as VCs with explicit scope; signed proof records. **World AgentKit**: human→agent delegation with per-human quotas enforced by the *verifier*. **Entra**: separate Conditional Access templates for on-behalf-of vs autonomous agents. **AuthZEN AARP**: the "ask for approval, poll, re-evaluate" loop for prerequisites.
- Design delta: our delegation token carries `act` **and** `delegation_chain[]` **and** `agentic_ctx` so it is readable by all three camps; depth ≤ 3; per-hop `max_spend`; three-scope revocation.

#### 6.3.6 Key rotation designs (what to copy)
- **WG draft -00:** add new key → publish both → remove old after its `exp`; verifiers honour removed keys only until cache expiry; negative-cache failed lookups ≤ 5 min; directory SHOULD be self-signed to bind keys to the authority.
- **Cloudflare docs:** Ed25519 only; signature `expires` ≈ 1 min; rotation of a *registered* key is a support process ("Cloudflare will work with you") — a registry-side friction we must design around (fleet directory with stable authority, per-key churn inside it).
- **Live examples:** OpenAI = one key with `nbf`/`exp` (rotation event due 2026-09-12); Google = five keys, no `nbf`/`exp`, cache-control-driven ("delete old cached keys that are missing from the file"). Two valid styles; ours should carry `nbf`/`exp` per key *and* short cache.
- **did:webvh:** two-entry pre-rotation (`nextKeyHashes` committed, then revealed); isolation of the next key is the security assumption; witnesses/watchers; next spec makes pre-rotation **required** and adds ML-DSA (DIF newsletter #61, May 2026).
- **KERI:** inception commits a digest of the next key set; rotation reveals it and commits the following set; protects against "dead" (post-compromise forgery) and "live" attacks; duplicity detection + direct propagation to witnesses.
- **Singh hosted directories:** possession re-proved on every rotation with a host nonce bound to the directory authority; publication log; 300 s cache; documented revocation target.
- **ERC-8004:** transfer clears `agentWallet` (forced re-verification on ownership change) — mirrored in our non-pre-committed rotation rule.
- **SPIFFE:** hourly SVID rotation via Workload API — the reference for our *own* service keys, not tenant agents.

#### 6.3.7 Discovery
- **Google ARD** (2026-06-17; Cisco, Databricks, GitHub, GoDaddy, Hugging Face, Microsoft, Nvidia, Salesforce, ServiceNow, Snowflake; Apache-2.0; `ai-catalog.json` at a well-known path + registry API; "trust manifest" based on domain ownership) — publish a catalog for the marketplace and per-agent entries; cheap SEO for the agentic web.
- Cloudflare Radar bots directory now exposes `signatureAgentUrl`; Radar is itself consumable as a registry.

#### 6.3.8 New reputation evidence
- AgentReputation (FSE 2026): context-conditioned reputation cards + verification regimes + tamper-proof persistence + risk-based escalation.
- TruthMarketTwin (rev. 2026-08-25): LLM agents *autonomously* game rating systems; warrants/enforcement change behaviour — supports escrow + slashing + dispute as first-class, ratings as overlay.

### 6.4 Design deltas for the platform (from round 2)

1. **Per-agent origin, not path.** Issue `https://<id>.agents.<platform>` (wildcard cert) as each agent's Signature-Agent authority; serve `/.well-known/http-message-signatures-directory` (JWKS + tenant-signed assertion, `Cache-Control: max-age=300`), the registry-03 card, and the CIMD there. Keep a path-based `type=cimd` alias for MCP.
2. **Fleet directory for CDN allowlists.** Because Cloudflare/AWS admit bots per authority via application and rotate registered keys through support, also offer an opt-in **platform-level authority** (`https://fleet.<platform>`) whose JWKS lists the keys of tier ≥ 3 agents that request CDN reach; one registry entry, many keys; abuse handling = remove key + CAEP event (shared-fate risk accepted only for vetted tiers).
3. **Host never holds private keys** (Singh MUST): keep client-side key generation; add enrollment nonce bound to `(thumbprint, authority, timestamp)`; tenant-signed detached assertions refreshed ≤ 24 h; append-only publication log exposed at `GET /keys?history=1`; published revocation propagation target ≤ 5 min.
4. **Accept both `Signature-Agent` forms inbound** (Dictionary and bare string) and emit Dictionary; document the interop hazard in the agent-facing `skill.md`.
5. **Delegation token = `act` + `delegation_chain[]` + `agentic_ctx`** (6.3.5), depth ≤ 3, per-hop spend caps, three-scope revocation.
6. **Pre-rotation default-on for tier ≥ 2** (`next_key_hash` at registration; did:webvh is making it mandatory).
7. **Attestation importers:** Skyfire KYA (JWKS above, `kyapay-token`), World AgentKit (AgentBook lookup + EIP-191), enterprise OIDC (Entra/Auth0/Cognito), KYA-OS VCs, ERC-8004 `agentId` ownership proof (EIP-712), Web Bot Auth from known directories (chatgpt.com, agent.bot.goog).
8. **Publish for discovery:** A2A card (JWS), ERC-8004 registration file, ARD `ai-catalog.json`, registry-03 card list with signed webhooks.
9. **Reputation:** per-context cards; only settled-transaction feedback; median/trimmed mean; escrow + evaluator (ERC-8183 state machine) as the evidence source; import ERC-8004 feedback only with payment proof.
10. **Watchlist:** OpenAI key rotation on/after 2026-09-12 (first real-world rotation of a major signer); WG milestones (protocol to IESG; BCP); Transaction Tokens to IESG (Dec 2026); ERC-8004 Validation Registry deployment; KYA-OS adopters; W3C AIRP CG first draft; AWS WAF directory-acceptance policy.

### 6.5 Still unverified after round 2
- W3C DID 1.1 CR (March 2026) and "Threat Model for Decentralized Credentials" (Jan 2026) — vendor blog only.
- "8004 Launch Day" 2026-03-17; ERC-8004 "v2" labelling; Virtuals 18 K agents / 1.77 M jobs; 8004scan totals (explorer, no methodology).
- Skyfire funding/traction; independent KYAPay implementations; Visa TAP → Intelligent Commerce SDK merge; Mastercard Agent Pay / AP2 native mandates (eco.com only).
- Entra Agent ID exact GA day (April 2026 per a partner blog).
- HDP's IETF draft and SDK; Airlock Protocol product behind the hosted-directories draft.
- Cloudflare/AWS: whether *any* self-hosted directory is honoured without an application (Cloudflare docs imply application required; AWS ambiguous).
- OpenAI help-center allowlisting page (403 twice); Halborn reputation-attacks post (429).

### 6.6 URLs used in round 2

**IETF / standards (primary)**
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
- https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol-00
- https://datatracker.ietf.org/wg/webbotauth/documents/
- https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-directory/
- https://datatracker.ietf.org/doc/draft-meunier-webbotauth-registry/
- https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-registry-03
- https://datatracker.ietf.org/doc/html/draft-singh-webbotauth-hosted-directories-00
- https://datatracker.ietf.org/doc/draft-rescorla-anonymous-webbotauth/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
- https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
- https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/
- https://datatracker.ietf.org/doc/draft-oauth-transaction-tokens-for-agents/
- https://datatracker.ietf.org/doc/draft-araut-oauth-transaction-tokens-for-agents/
- https://www.ietf.org/archive/id/draft-liu-oauth-chain-delegation-00.html
- https://datatracker.ietf.org/doc/draft-ietf-wimse-wpt/
- https://datatracker.ietf.org/doc/draft-ietf-wimse-workload-creds/
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- https://eips.ethereum.org/EIPS/eip-8004
- https://eips.ethereum.org/EIPS/eip-8183
- https://github.com/erc-8004/erc-8004-contracts
- https://github.com/subramanya1997/oidc-a
- https://openid.net/cg/artificial-intelligence-identity-management-community-group/
- https://openid.net/oidf-responds-to-nist-on-ai-agent-security/
- https://openid.net/openid-foundation-advances-authorization-for-the-agent-era-with-new-authzen-working-group-drafts/
- https://www.w3.org/community/agent-identity/
- https://identity.foundation/working-groups/trusted-agents.html
- https://blog.identity.foundation/kya-os/
- https://blog.identity.foundation/dif-newsletter-61/
- https://didwebvh.info/latest/implementers-guide/prerotation-keys/
- https://identity.foundation/keri/kids/kid0005Comment.html
- https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative

**Live key directories (fetched 2026-09-06)**
- https://chatgpt.com/.well-known/http-message-signatures-directory (JWKS, 1 key, exp 2026-09-12)
- https://agent.bot.goog/.well-known/http-message-signatures-directory (JWKS, 5 keys)
- https://claude.ai/.well-known/http-message-signatures-directory (404)
- https://claude.com/.well-known/http-message-signatures-directory (404)
- https://anthropic.com/.well-known/http-message-signatures-directory (404)
- https://www.perplexity.ai/.well-known/http-message-signatures-directory (404)

**Vendor docs / primary posts**
- https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth
- https://developers.googleblog.com/announcing-the-agentic-resource-discovery-specification/
- https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/bots/reference/bot-verification/web-bot-auth.mdx
- https://developers.cloudflare.com/bots/concepts/bot/signed-agents
- https://developers.cloudflare.com/radar/release-notes/
- https://blog.cloudflare.com/agent-registry/
- https://aws.amazon.com/blogs/security/authenticate-legitimate-ai-agent-traffic-with-aws-waf-bot-control/
- https://www.kernel.sh/blog/webbotauth
- https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id
- https://world.org/blog/announcements/now-available-agentkit-proof-of-human-for-the-agentic-web
- https://docs.world.org/agents/agent-kit
- https://docs.skyfire.xyz/docs/kya
- https://docs.skyfire.xyz/docs/kya-token
- https://docs.skyfire.xyz/docs/kyapay-tokens.md
- https://docs.skyfire.xyz/docs/enforce-kya-based-access-control.md
- https://docs.skyfire.xyz/reference/environments.md
- https://docs.skyfire.xyz/llms.txt
- https://skyfire.xyz/know-your-agent-kya/
- https://github.com/visa/trusted-agent-protocol
- https://github.com/AgentTanuki/agent-guild
- https://github.com/sudeepb02/awesome-erc8004
- https://8004scan.io/
- https://www.vouched.id/learn/vouched-and-the-decentralized-identity-foundation-launch-kya-os-an-open-trust-layer-for-ai-agents
- https://www.lfdecentralizedtrust.org/blog/toip-and-dif-announce-three-new-working-groups-for-trust-in-the-age-of-ai

**Papers**
- https://arxiv.org/abs/2606.26028 and https://arxiv.org/html/2606.26028 (ERC-8004 study)
- https://arxiv.org/abs/2609.02992 (Tempting the Agent)
- https://arxiv.org/abs/2604.04522 (HDP)
- https://arxiv.org/abs/2605.00073 (AgentReputation)
- https://arxiv.org/abs/2605.10059 (TruthMarketTwin)

**Secondary / press (dates and context only)**
- https://techcrunch.com/2026/03/10/meta-acquired-moltbook-the-ai-agent-social-network-that-went-viral-because-of-fake-posts/
- https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network (search only)
- https://en.wikipedia.org/wiki/Moltbook
- https://www.piunikaweb.com/2026/03/16/moltbook-invalidates-agent-api-keys-new-terms-human-verification/
- https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys (search only)
- https://www.decipherclub.com/so-what-exactly-are-trustless-agents-up-to/
- https://www.forbes.com/sites/digital-assets/2026/02/05/ai-agents-gain-trust-via-ethereum-erc-8004-on-mainnet/ (search only)
- https://www.bighatgroup.com/blog/entra-agent-id-ga-deep-dive/
- https://unchainedcrypto.com/world-expands-agentkit-as-it-bids-to-verify-the-humans-behind-ai-agents/
- https://techcrunch.com/2026/03/17/world-launches-tool-to-verify-humans-behind-ai-shopping-agents/ (search only)
- https://turva.dev/blog/verifiable-agent-identity
- https://nohacks.co/blog/ai-user-agents-landscape-2026
- https://webdecoy.com/blog/ai-agent-authentication-web-bot-auth-ard-oauth/
- https://www.infoq.com/news/2026/07/agentic-resource-discovery-spec/ (search only)
- https://workos.com/blog/mcp-2026-spec-agent-authentication (search only)
- https://www.businesswire.com/news/home/20251218520399/en/… (Skyfire × Visa demo; 403, snippet only)
- https://eco.com/support/en/articles/15192002-ap2-protocol-explained-google-s-agentic-commerce-standard-2026 (search only)
- https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared (search only)
- https://aws.amazon.com/about-aws/whats-new/2025/11/aws-waf-web-bot-auth-support (search only)
- https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf and https://securityboulevard.com/2026/09/the-honor-system-is-ending-four-places-trust-went-cryptographic/ (claims of Claude/Perplexity signing — contradicted)
- https://developer.pingidentity.com/identity-for-ai/identity/idai-token-exhange.html (404 on fetch; search snippet only)

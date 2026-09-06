# Strategic Brief — "Agent World" (working name) · 2026-09-06

Author: Chief Strategy Officer. Status: **complete v1** (supersedes the early partial version).
Inputs read in full: `research/competitors-marketplaces.md`, `research/interop-protocols.md`, `research/payments-rails.md`, `research/identity-trust.md`, `research/agent-discovery-marketing.md`, `research/security-threats.md` (each incl. its Round 2 section), `docs/DECISIONS.md` (ADR-1..15), `docs/PRODUCT-DRAFT.md`, `docs/STATUS.md`, `docs/SPEC-MARKETPLACE.md`, `AGENTS.md`, `packages/api/src/discovery/text.ts`, plus a code read of `packages/api/src` (discovery, mcp, middleware, modules, ledger) and live name/registry checks (npm, PyPI, RDAP, WebSearch) on 2026-09-06.

Conventions: "Built / Partial / Missing" refer to code present in `packages/api/src` today. File citations name the research file and section.

---

## 1. Executive summary

1. **The thesis survives, narrowed.** Nobody ships identity + wallet + escrowed agent-to-agent market + payment-bound reputation with zero-human onboarding. Closest: ATXP (funded account + tools, no market), OKX AI / NEAR Agent Market / Claw Earn / ClawTasks / AgentGig / AutoGig (crypto-only job markets, no portable identity), Virtuals ACP (ERC-8183 escrow, token-launch-centric), Moltbook (2.9M "agents", ~17k humans, no payments, Meta-owned). Our wedge is **off-chain-orchestrated escrow + evaluator + evidence-bound reputation, projected into every discovery standard** (`competitors-marketplaces.md` §0, §4, §5.9).
2. **Rails are commodities; escrow, disputes and reputation are the moat.** HTTP 402 won (x402 under the Linux Foundation, Stripe MPP). Real x402 commerce is ~$28k/day despite 75M tx/month; ERC-8004 reputation is 59–91% sybil at $0.003 per fake review (`payments-rails.md` §0, §6; `identity-trust.md` §1.1). Do not build a rail; be the account + escrow + evaluator that speaks all rails.
3. **The standards stack is settled and we speak most of it — with three material gaps found in code.** (a) `/mcp` runs `@modelcontextprotocol/sdk ^1.20` (2025-era session protocol, no `server/discover`), not the dual-era 2026-07-28 shape Claude Code ≥2.1.232 negotiates; (b) `/.well-known/agent-card.json` uses A2A v0.3 fields and advertises `POST /a2a`, **which does not exist**; (c) no `server.json` for the official MCP registry. Also: the OAuth AS metadata advertises a `/v1/oauth/token` that does not exist (`interop-protocols.md` §1.5, §2, §19; §3 below).
4. **Payments v1 must be non-custodial in the EU.** Sandbox credits (no monetary value) stay unrestricted. Live value moves on x402 `exact` USDC on Base peer-to-peer and through an ERC-8183-shaped escrow contract where **we hold no keys and are not the evaluator of record**; the internal ledger mirrors, never holds; fiat only via Stripe Connect with a KYB'd operator as merchant. Germany's MiCA transition ended **2025-12-31** (§50 KMAG); EMT transfers need PSD2/ZAG authorisation since **2026-03-02**; BaFin rejects the commercial-agent exemption for marketplaces (`security-threats.md` §13.3, R2.7). A platform-run live-credit ledger with transferable balances is custody + payment service.
5. **Identity is further along than STATUS.md says.** RFC 9421 Ed25519 request verification, key rotation and signed recovery already exist (`middleware/signatures.ts`, `agents/routes.ts`). Missing: `Signature-Agent` / per-agent origins, key-bound session tokens, the token endpoint, and every T2/T3 attestation importer (`identity-trust.md` §2, §6.4).
6. **Sybil defence is economic; only a human-principal tier is truly sybil-resistant.** Bond + graduation + one-review-per-settled-escrow + funding/fingerprint clustering; World ID "Human Principal" or partner KYB unlocks real limits (`security-threats.md` R2.5; `identity-trust.md` §2.2).
7. **Discovery: five actions deliver most of the reach.** Remote MCP + official registry; one skill folder to ClawHub + Claude plugin Console + Gemini extension + GitHub (SkillsMP crawls it); npm/PyPI under guessable names (register every name we mention); x402 Bazaar the day a live rail settles; robots/SEO for the five crawlers behind agent search. `llms.txt` is conversion, not acquisition (`agent-discovery-marketing.md` §12, R2.3).
8. **Security is mostly classic appsec plus one new rule: platform content is never an authorization path.** Moltbook fell to a missing RLS policy; Grok/Bankr fell to a message that unlocked a transfer. JSON-only machine channel, untrusted envelopes, hash-pinned listings, spends only via signed API calls, signed receipts, multi-model dispute panels (`security-threats.md` §14–15).
9. **Naming: "agentworld" fails.** PyPI `agentworld` is owned by an active, unrelated project (v0.2.0, 2026-07-20); `agentworld.dev/.ai/.com/.io` are registered. Recommendation: **agentsouk** — npm + PyPI free, `agentsouk.dev`, `agentsouk.ai`, `agentsouk.io` free, no tech-brand collisions (§9).
10. **Publish honest metrics from day one:** paid completed jobs, unique paying counterparties, GMV, dispute rate, median time-to-first-paid-transaction. Never registrations (`competitors-marketplaces.md` §5.1).

---

## 2. Market map

Traction figures are as verified in `competitors-marketplaces.md` (Round 2) unless another file is cited. "Agent-native?" = can an autonomous agent sign up, transact **and sell** with no human step.

| Competitor | What | Traction (verified where possible) | Agent-native? | The gap we exploit |
|---|---|---|---|---|
| **ATXP** (Circuit & Chisel) | Accounts for agents: handle, `@atxp.email` inbox, ETH wallet, $5 credit, pay-per-call MCP tools; `npx atxp agent register` | Backed by Stripe, Solana, Coinbase, Polygon; "100+ paid MCP tools"; traction undisclosed | **Yes** — the only funded one-call onboarding | No third-party catalog, no agent-to-agent jobs, no escrow, no reputation. Integrate as a rail; out-build the market; expect them to add one. |
| **Moltbook** (Meta since 2026-03-10) | Agent-only social network; `skill.md` onboarding; "Sign in with Moltbook" | 2,895,874 registered / 206,839 human-verified; ~17k humans behind 1.5M agents; 1.5M keys leaked (Wiz) | No (email + tweet claim) | No payments, no economics, slop within days. Accept as identity source, copy the skill.md UX, never the social-first design. |
| **Virtuals ACP** (ERC-8183 reference) | On-chain job escrow Request→Negotiate→Transact→Evaluate; evaluator role; 80/20 fee split | "$470M aGDP" (mixes token trading); 2,000+ agents; revenue declining since Jan 2025 | Partly (`acp setup` headless unverified; Base wallet + gas) | Token dependence, Base-only, **no dispute/appeal in ERC-8183**. We adopt the lifecycle shape with disputes and no token. |
| **Olas Mech Marketplace** | Mech-to-mech requests on 6 EVM chains | 14.58M a2a txs, **$109k lifetime turnover**, $546 lifetime fees | No (funded wallet + Python) | On-chain per-call settlement is uneconomic → internal netting, batched settlement. |
| **OKX AI** (Onchain OS, 2026-06-30) | Agent + Task Marketplace, USDT/USDG escrow, on-chain reputation, staked-evaluator disputes, "no OKX account required" | New; no numbers | Yes (email-provisioned wallet) | Exchange-bound, crypto-only, no portable identity, no MCP/A2A projection. |
| **NEAR AI Agent Market** (2026-02-04) | Bids + escrow + dispute agent | Unverified | Unclear (NEAR deposit) | Single chain; same as above. |
| **Claw Earn / ClawTasks** (Base) | OpenClaw-native USDC bounty markets | Beta; ClawTasks verifies via Moltbook post | Claw Earn yes; ClawTasks indirect | Single-framework audience; we serve Claude Code, Codex, LangGraph, CrewAI, OpenClaw via MCP/A2A/skills. |
| **Long tail found 2026-09-06 (WebSearch during the name check; landing pages only, unverified):** AgentGig (agentgig.xyz, "$CLAW welcome bonus"), AgentGigs (agentgigs.io), ClawGig (10% take, USDC), AutoGig (autogig.net, stablecoin escrow), ugig.net, Hunazo, AI Agent Store (aiagentstore.ai, USDC escrow for agent→human jobs), **AgentMart** (agentmart.store + npm `agentmart` v1.0.2: reusable prompts/workflows, x402 on Base, **3% fee**) | Freelance-style agent job boards and asset stores | Unknown; mostly single-founder | Mostly wallet-only | Fragmented, single-rail, no identity/reputation portability, no standards projection. Validates demand; our differentiation is escrow + evaluator + passport + multi-rail. Note AgentMart uses the same 3% fee. |
| **x402 Bazaar / Agentic.Market** (Coinbase) | Catalog of payment-gated endpoints indexed from settled payments; `GET /v1/services`; no API keys | 16,615 Bazaar resources live (down from 20,345 in April); 2,657 services on Agentic.Market | Buyers yes; sellers need wallet + middleware | Discovery only. We list every live listing there (`agent-discovery-marketing.md` §8). |
| **Coinbase Agentic Wallets / CDP** | TEE-held wallets, session caps, gasless Base, `npx awal`, Payments MCP | 100M+ x402 payments claimed | Email OTP (an agent-owned inbox suffices) | Wallet, not economy. Integrate as wallet provider. |
| **Circle Agent Stack** (2026-05-12) | Agent Wallets (2-of-2 MPC), Nanopayments (min $0.000001), curated marketplace | New | Email OTP; sellers via forms | Compliance-first, curated; we are open. Use Nanopayments for sub-cent. |
| **Stripe MPP + Tempo, Link agent wallet** | HTTP 402 with cards/BNPL/stablecoins/Lightning; sessions; SPT | Live since 2026-03-18; €0.15/SPT; ~1.5% stablecoin | No (human Stripe/Link login) | Fiat bridge for everyone → our fiat layer for claimed agents. |
| **Nevermined** | x402 facilitator + metering, 1–2%, VIC card mandates | Gartner Cool Vendor | No (work e-mail) | Metering only; fee benchmark. |
| **Skyfire KYA / KYAPay** | Know-Your-Agent JWTs bound to a human + prepaid USD wallet | $9.5M; F5, Experian | No (human account) | Accept KYA JWTs as a T3 attestation. |
| **Kite** | Avalanche L1 for agent payments; Agent Passport sessions | $35M (PayPal Ventures, GC); 90+ providers | No (human master account) | Human-anchored by design; integrate as rail. |
| **Fetch.ai Agentverse / ASI:One** | Hosting + Almanac directory + LLM front door | "2.7–3M agents" (hosted templates) | No (web account) | Register our agents in Almanac for ASI:One traffic. |
| **Recall** | Verified agent competitions → Recall Rank | 175k agents claimed | No (email) | Ingest Recall Rank as a secondary signal. |
| **RentAHuman / Humwork** (YC X26) | Agents hire humans via MCP | 600k workers vs 5.5k jobs | Agent side yes | "Human as provider type" inside our market. |
| **Vendor stores** (Salesforce, Google Cloud, Microsoft, AWS, OpenAI plugin directory, Anthropic connectors) | Human/admin procurement catalogs | Large audiences | **No** (partner programs; ChatGPT prohibits money/crypto transfers) | Early customers are indie/OpenClaw/Claude Code and crypto-native agents. Stores only for read-only discovery tools. |
| **ClawHub / Glama / Smithery / official MCP registry** | Skill and MCP registries | ClawHub 10.7k+ skills; Glama 82k servers; official registry 18.8k | Install yes; publish needs GitHub/DNS namespace | Distribution, not competition — publish to all. |
| **ERC-8004 / ERC-8183** | On-chain identity + reputation / job escrow standards | 173k→~497k registrations, 3–15% functional, 98.7–100% feedback without payment proof | Yes (wallet + gas) | Export target and attestation source; interaction-verified reputation is our differentiator. |
| **Kustodia, Locus, AgentWallet (Payouts.com), Crossmint, Privy/Turnkey** | Escrow-for-x402, prepaid catalogs, KYB'd wallets + cards, wallet infra | Early / infra | Mostly KYB-anchored | Suppliers behind our account object. |

---

## 3. Standards we speak natively — and what is still missing

| Standard (exact version) | Path / artifact | Research recommendation | Our build (verified in code) | Gap / action |
|---|---|---|---|---|
| **MCP 2026-07-28** (stateless; `server/discover`; `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; `ttlMs`/`cacheScope`; ext `io.modelcontextprotocol/tasks`, `io.modelcontextprotocol/oauth-client-credentials`) | `POST /mcp`, dual-era | Must, dual-era (`interop-protocols.md` §1.1, §1.5, §19) | **Partial.** `mcp/routes.ts`: `@modelcontextprotocol/sdk ^1.20.0` `WebStandardStreamableHTTPServerTransport`, no session id, JSON responses = 2025-era. No `server/discover`, no header routing, no `ttlMs`. 36 tools as thin REST wrappers (good). Auth: Bearer / `X-API-Key` / **`?api_key=` in URL** (secret in logs, referrers, proxies). | Move to the 2026-07-28 SDK line, serve both eras on one route (Cloudflare `createMcpHandler` pattern), implement `server/discover`, `ttlMs`/`cacheScope`, deterministic tool order, `x-mcp-header` for `agent_id`; **drop `?api_key=`** (or test keys only); Tasks ext for long jobs. CI matrix: Claude Code ≥2.1.232, Cloudflare Agents ≥0.20, OpenAI Agents SDK, Cursor. |
| **Official MCP Registry** (`server.json` `$schema` 2025-12-11; API v0.1) | `server.json` under `com.<domain>/*` or `dev.<domain>/*`; optional sub-registry `GET /v0.1/servers` | Publish + become sub-registry (`agent-discovery-marketing.md` §12 #1; `interop-protocols.md` §19) | **Missing.** | Write `server.json` (remote `streamable-http`), DNS-verify, `mcp-publisher publish`. |
| **A2A v1.0.1** (`/.well-known/agent-card.json`; `supportedInterfaces[{url, protocolBinding, protocolVersion}]`; `A2A-Version: 1.0`; JSON-RPC + HTTP+JSON; JWS card; `application/a2a+json`) | Card + `POST /a2a` + `/a2a/v1/*` | Must; jobs as A2A Tasks; declare `a2a-x402` ext URI `https://github.com/google-a2a/a2a-x402/v0.1` (`interop-protocols.md` §2, §19) | **Partial / misleading.** Card + `/.well-known/agent.json` 301 alias exist. But v0.3 fields (`url`, `preferredTransport`, `additionalInterfaces`), `signatures: []`, non-standard `platformKey`, claims `streaming`/`pushNotifications`/`stateTransitionHistory`, and **`url: ${base}/a2a` has no route** (grep: none). | Implement a minimal A2A server (`message/send`, `tasks/get`, `tasks/cancel`, push configs → jobs) or strip the card to the truth. Move to v1.0 shape, sign (JWS/JCS). Host per-agent cards. |
| **Agent Skills / SKILL.md** (agentskills.io: `name`, `description`, opt. `license`, `compatibility`, `metadata` string-map, `allowed-tools`; ClawHub adds top-level `version` + `metadata.openclaw.*`) | `/skill.md`, `/SKILL.md`, skill folder in GitHub | Must; test the `version` conflict on Claude Code + OpenClaw + Codex (`interop-protocols.md` §9–10) | **Built**, but frontmatter has top-level `version` (fails `skills-ref validate`) and nested non-string `metadata` values. | Keep `version` top-level *and* `metadata.version`; flatten metadata to strings; add `metadata.openclaw.requires.env` / `primaryEnv`; three-client install test before publish. |
| **OAuth well-knowns** (RFC 9728, RFC 8414, CIMD, `client_credentials` + `private_key_jwt`, RFC 9207) | Both well-knowns + working `token_endpoint` | Cheap, required (`interop-protocols.md` §1.2–1.3; `identity-trust.md` §1.5) | **Partial.** Both docs served. AS metadata advertises `token_endpoint: /v1/oauth/token` + `client_id_metadata_document_supported: true` — **no such route exists** (grep confirms only the advertisement). | Implement `/v1/oauth/token` (JWT-bearer from the agent's CIMD → 15–60 min token with `cnf.jkt`), or remove the advertisement. |
| **CIMD per agent** (`draft-ietf-oauth-client-id-metadata-document-02`) | `/agents/{id}/cimd.json` | Differentiator (`identity-trust.md` §0.7, §2.7) | **Built** (`cimd.json`, `jwks.json`, `did.json` per agent). | Per-agent origin `https://<id>.agents.<domain>` later. |
| **Web Bot Auth** (`draft-ietf-webbotauth-httpsig-protocol-00`: RFC 9421, Ed25519, `keyid` = JWK thumbprint, `tag="web-bot-auth"`, **`Signature-Agent` mandatory (Dictionary)**, self-signed directory) | Platform + per-agent directories | Adopt as request-auth; host directories for domain-less agents (`identity-trust.md` §1.2, §6.4) | **Partial (STATUS.md under-reports).** `middleware/signatures.ts` verifies `@method`, `@target-uri` (or `@authority`+`@path`), `content-digest`, `created` ±300 s, `expires`, single-use nonce; keyid = id/handle/did:key/thumbprint. Directory served with correct media type. Missing: `Signature-Agent`, `tag`, per-agent origins, self-signature, tenant assertions; nonce cache is in-process memory. | Accept both `Signature-Agent` forms, verify `tag`, persist nonces, per-agent origins (`Cache-Control: max-age=300`), revocation list + ≤5 min propagation target. |
| **did:key / did:web** | DID docs | did:key canonical, did:web exposed (`identity-trust.md` §1.6) | **Built** (did:key; `/agents/:id/did.json`). | `did:web:<domain>:agents:<id>` resolution; pre-rotation (`next_key_hash`) for T≥2. |
| **x402 v2** (`PAYMENT-REQUIRED`/`-SIGNATURE`/`-RESPONSE`; `exact`/`upto`/`batch-settlement`; `eip155:8453`; CDP facilitator; Bazaar `discoverable` + `/x402/validate`) | 402 on priced endpoints; on-chain deposits | First rail (`payments-rails.md` §5.2; `agent-discovery-marketing.md` §8) | **Missing (stub).** `RAILS` includes `x402`; `/v1/wallet/rails` promises PaymentRequirements; `createDeposit` for x402/stripe throws `notImplemented` (501); withdrawals "coming_soon". | Implement buyer + seller with `@x402/*` + CDP facilitator; bind payloads to a request digest (free-riding F1–F4, `security-threats.md` R2.4). |
| **MPP** (`mppx`; `charge`/`session`/`subscription`) | Same endpoints | Phase 2 (`payments-rails.md` §5.3) | **Missing.** | After x402. |
| **ERC-8004 registration file** + `proofOfPayment` export; **ERC-8183** semantics | `/agents/{id}/erc8004.json` | Export, not trust source (`identity-trust.md` §1.1, §6.3.1) | **Missing.** Job state machine already ERC-8183-shaped (open→in_progress→delivered→completed/declined/expired + disputed/resolved). | Emit registration JSON (`x402Support`, `services[]`); mirror feedback with payment proof on request. |
| **llms.txt / llms-full.txt / openapi.json / AGENTS.md** | `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `AGENTS.md` | Ship; body-text-first; `Accept: text/markdown` (`agent-discovery-marketing.md` §2, §11) | **Built** (`/llms.txt`, `/llms-full.txt` from OpenAPI, `/docs/*`, root `/` JSON, `AGENTS.md`). No `robots.txt`, no `sitemap.xml`, no content negotiation. | Add "fetch llms.txt first" blockquote, `Link:`/`X-Llms-Txt` headers, `robots.txt` allow-all for AI UAs, sitemap, `.md` mirrors, year in titles. |
| **Well-known suite** (ARD `/.well-known/ard.json` + `ai-catalog.json`; MCP server card variants; ANP `agent-descriptions`; DNS TXT `_agent`, `_mcp`) | one JSON source → many paths | Cheap insurance (`agent-discovery-marketing.md` §3, §12 #10) | **Missing.** | One afternoon. |
| **Arazzo 1.1** | `/arazzo.yaml` | Cheap, differentiating (`interop-protocols.md` §14) | **Missing.** | Generate from the quickstart flow. |
| **Signed receipts / audit** (JWS per mutating request; hash chain; `draft-sharif-agent-audit-trail-03`) | `GET /v1/receipts` | Two-sided non-repudiation (`security-threats.md` §12) | **Partial.** `lib/server-keys.ts` has `signReceipt()` — **never called**. `job_events` audit exists. Webhooks are HMAC (`X-Webhook-Signature: v1=`), not JWS; `llms.txt` claims the JWKS verifies "signed receipts and webhooks" (false today). | Emit receipts on every money/state transition; hash-chain per agent; fix the copy. |
| **Webhooks / SSE / inbox** | `POST /v1/webhooks`, `GET /v1/events/stream`, `GET /v1/inbox` | Mailbox + long-poll + webhooks (`competitors-marketplaces.md` §4.7) | **Built.** | CAEP-shaped `credential-change` / `session-revoked` events. |
| **SDKs** (npm + PyPI) | published packages | Guessable names + defensive registration (`agent-discovery-marketing.md` §7) | **Built, unpublished.** npm `agentworld` free; **PyPI `agentworld` taken by an unrelated project**. | Rename (§9) before `npm publish` / PyPI upload. |

**STATUS.md reconciliation.** "Erledigt" is accurate for skill.md/llms.txt/JWKS/CIMD/DID/OAuth well-knowns/MCP/SDKs. It **under-reports identity** (RFC 9421 verification, `POST /v1/agents/recover`, `POST /v1/agents/me/rotate-key` exist — next-step 1 is half done) and **over-reports interop**: the A2A card and the OAuth AS metadata advertise endpoints that do not exist; the MCP server is single-era legacy; live rails are 501 stubs; receipts and referral rewards are advertised but not implemented; no registry `server.json`.

---

## 4. Payment rail strategy (phased), escrow/dispute design, and the EU regulatory line

### 4.1 The line we must not cross without a licence (Germany/EU)

| Activity | Legal consequence | Source |
|---|---|---|
| Holding fiat for others, balances transferable between users, collecting from buyers and paying sellers | Payment service (§10 ZAG) or e-money (§1 ZAG) → BaFin licence. BaFin: commercial-agent exemption is "generally completely excluded" for platforms contracting both sides. | `security-threats.md` §13.3 |
| Holding or controlling crypto keys or EMT balances (USDC/EURC) for others; omnibus wallets; internal transfers; pay-outs | MiCA CASP custody **and**, since 2026-03-02, PSD2/ZAG payment service (EBA: cumulative, no mutual recognition). Germany: no transitional cover since **2025-12-31** (§50 KMAG); crypto custody licensable under KWG since 2020. | `security-threats.md` §13.3, R2.1 #9, R2.7 |
| CASP-to-CASP transfers | Travel Rule with zero threshold; self-hosted >€1,000 ownership verification | `security-threats.md` §13.3 |
| Platform-run escrow contract or ledger for third-party value | "Control" is the trigger under both regimes → needs a German legal opinion before launch (open since ADR-10). Design most likely outside "control": ERC-8183-style contract where the platform holds no key and is not the evaluator. | `security-threats.md` R2.7, R2.8 #1 |

Consequence for ADR-6/ADR-10: **live CRD credits must not be a transferable balance.** Redefine live credits as *prepaid fees redeemable only against our own services* (listing boosts, evaluator service fee, messaging quota) — a single-purpose credit is neither e-money nor a payment service. Agent-to-agent value moves on rails we do not hold.

### 4.2 Phases

**Phase 0 — now (sandbox only, no licence needed).** Keep everything as built: `aw_test_` keys, free sandbox credits (daily cap exists), full marketplace loop, ledger escrow. This is the product agents onboard with. Label sandbox results clearly as non-monetary in every payload.

**Phase 1 — launch (weeks 0–8): non-custodial live rail = x402 USDC on Base (`eip155:8453`).**
1. **Wallet at registration, never our keys.** `POST /v1/agents` returns `wallets.base.address` for one of: `byo` (agent supplies an address it controls), `awal` (Coinbase Agentic Wallet; the agent's own inbox completes the OTP — see §8 extra #3), or `cdp-server` (operator's CDP API keys, T3 only). We store addresses, never key material (`payments-rails.md` §1.1, §3.1, §5.2; `identity-trust.md` §6.4 #3 "host MUST NOT possess tenant private keys").
2. **Pay-per-call listings (fulfilment mode `direct_endpoint`)**: buyer pays seller directly with x402 `exact`; `payTo` = seller address; we verify via the CDP facilitator and record the settlement hash as the job receipt. The platform fee is **not** carved out of the payment; it is charged to the seller's prepaid fee credits (§4.1).
3. **Escrowed jobs (fulfilment mode `platform_job`, above ~$5 or multi-step)**: an ERC-8183-shaped contract on Base holds funds: `fund` (buyer, via x402 or direct transfer) → `submit` (seller posts `output_hash`) → `complete`/`reject` by the **evaluator address fixed at job creation** → `claimRefund` after `expiredAt`. Two additions over ERC-8183: `claimRelease()` callable by anyone after `submittedAt + reviewWindow` (auto-accept mirrors the existing 72 h rule), and `resolve(split)` callable only by the pre-agreed evaluator. **Default evaluator = the buyer** (ERC-8183 allows client self-evaluation); parties may name a third-party evaluator agent from our evaluator directory. The platform signs nothing that moves funds (`security-threats.md` R2.4, R2.7; `payments-rails.md` §5.5).
4. **Ledger = mirror.** Every on-chain event is mirrored into `src/ledger` as a shadow entry so `/v1/wallet`, receipts, reputation and analytics keep working unchanged (ADR-6 stays; only "live balances" disappear).
5. **Bounded authority defaults** in the SDK/MCP layer: per-payment ceiling, session budget, recipient allowlist, network/asset pinning; paid responses flagged untrusted (AWS/OpenClaw pattern, `payments-rails.md` §3.4, §5.2 #4).
6. **Bazaar listing** for every live `direct_endpoint` listing (validate, ≤500-char description, one settlement, verify indexing, keep active — 30-day delisting) (`agent-discovery-marketing.md` §8).

**Phase 2 — weeks 6–14: MPP beside x402, Solana, sub-cent.** `mppx.compose()` on the same endpoints (Tempo/Solana USDC, Lightning, SPT cards for human-backed agents); MPP `session` intents and x402 `upto`/`batch-settlement` for metered services; Solana USDC because Solana now carries ~70% of x402 volume; Circle Nanopayments for sub-cent (`payments-rails.md` §1.2, §5.3; `competitors-marketplaces.md` §2.3).

**Phase 3 — after the legal opinion / with a licensed partner: fiat and pooled value.** Stripe Connect Express: the seller's **operator** (KYB'd, T3) is the connected account and merchant of record; buyers pay by MPP SPT/cards; Stripe holds funds; we take an application fee. Payouts to humans (bounties) via Stripe Connect or Payman. Only with an EMI/PSP partner (or our own ZAG licence) do transferable live credits, platform-held escrow and instant internal netting become legal; the architecture stays open for that (ADR-10). Also then: AP2 "Trusted Agent Provider" role, Skyfire KYA acceptance for enterprise buyers, L402 via MPP (`payments-rails.md` §5.4; `interop-protocols.md` §20 #9).

### 4.3 Escrow and dispute design (tiered, zero-human by default)

| Tier | Mechanism | Who pays | Notes |
|---|---|---|---|
| 0 — deterministic | Acceptance criteria encoded at job creation: output JSON schema, test vectors, expected artifact hash, SLA timestamps; contract/ledger checks mechanically | nobody | Covers most micro-jobs. Listing content hash is bound into the job (rug-pull defence). |
| 1 — evaluator agents | Pre-agreed or platform-assigned from a **bonded** evaluator pool; assignment by VRF/commit-reveal; evaluator must not share a funding/fingerprint cluster with either party; evaluator fee from escrow; slashable on successful appeal | loser | ERC-8183 `evaluator` slot; evaluators are first-class, paid agents — "the evaluator is the product" (`competitors-marketplaces.md` §5.9; `security-threats.md` R2.4 SoK taxonomy). |
| 2 — LLM panel | ≥3 heterogeneous models (different vendors), fixed rubric, majority vote, published rationale hash; value cap; both parties post a dispute bond (loser pays) | loser | Kleros: single-model verdicts swing 86%→95% on a silent model upgrade — never one model (`security-threats.md` §0.6, §8.1). Mark outputs `ai_generated: true`. |
| 3 — staked jurors / external | Platform juror pool with Maximum Arbitratable Value = f(stake), or Kleros-style external court; appeal by doubling bond; final | loser | Human path required only if a natural-person operator has legal effects (GDPR Art. 22). |

Everywhere: timeouts (auto-release to seller if buyer silent after review window; auto-refund if seller misses deadline; partial settlement), signed job agreement (listing hash + terms), signed deliverable receipt, hash-chained `job_events`, demotion only after failures from ≥3 unique counterparties (ACP rule), structuring detector on per-pair velocity (`security-threats.md` §8.2, §9, R2.9).

---

## 5. Identity & trust tiers T0–T3, sybil defences, and what to build next

ADR-8/9 are confirmed by the research; the tier ladder below merges ADR-9 with `identity-trust.md` §2.2 (which uses six tiers) into the four we expose.

| Tier | Attestation bound to the agent's Ed25519 key | Completed alone? | What it unlocks | Sybil cost | Status |
|---|---|---|---|---|---|
| **T0 — keypair** | Self-signed registration (`POST /v1/agents`, optional BYO key), did:key, CIMD, JWKS | 1 call | Full sandbox; live: escrow-only, listings in sandbox mode until graduated, low daily spend/earn caps, strict rate limits | ~0 | **Built** (default `trustTier: 0`). Caps and sandbox-mode gating for live listings: **missing**. |
| **T1 — economic** | (a) refundable **bond** (e.g. 5–10 USDC locked in the escrow contract as identity bond, slashable) **or** (b) ≥5 settled live jobs with ≥3 distinct counterparties | pay or work | Public live listings, higher caps, feedback weight > 0, evaluator eligibility (with extra stake) | ≥ bond, or real work | **Partial**: (b) auto-promotion exists (`reviews/service.ts`); (a) bond path **missing**. |
| **T2 — namespace proof** | Publish our challenge at `https://<agent-domain>/.well-known/http-message-signatures-directory` or DNS TXT `_agent.<domain>`; or `Signature-Agent` from a known directory (chatgpt.com, agent.bot.goog); or ERC-8004 `agentId` ownership (EIP-712); pre-rotation commitment required | 1 call if the agent controls a domain | Higher caps, verified-publisher badge, fleet directory membership | a rentable-but-not-free namespace | **Missing.** |
| **T3 — human/org principal** | World ID AgentKit proof (AgentBook + EIP-191), Skyfire KYA JWT (`hid.verified`, JWKS `app.skyfire.xyz`), enterprise OIDC (Entra/Auth0/Cognito: `client_id`=agent, `sub`=human), KYA-OS VC, or Stripe Connect KYB via `claim_url` | agent hands a URL/token to its operator | Fiat rails, withdrawals to fiat, per-human quotas, highest caps, arbitration standing | one human, many agents (linkable); World ID gives uniqueness | **Missing.** |

**Sybil defences (economic, not human):** cost at the door (PoW + tiny refundable deposit — burst controls only); privileges = f(identity age × settled volume × unique counterparties); ACP graduation (`graduated` flag exists: ≥5 jobs, ≥3 buyers, rating ≥3.5) with demotion only on failures from ≥3 unique counterparties; feedback **only** from settled escrows, one per job per side, value-weighted, median/trimmed-mean with per-funder/per-cluster caps, slow decay; cluster detection on funding source, key-derivation patterns, request fingerprints, ASN, timing; identity reset destroys bond + reputation, rotation preserves them only via dual-signed/pre-committed rotation; per-pair velocity caps (structuring); rate-limit on identity and funder, not IP (Sysdig: 11 IPs in 22 s). The only real sybil-resistant lane is T3 with per-human quotas (World ID "Human Principal") (`security-threats.md` §7, §10, R2.5; `identity-trust.md` §1.10, §2.3).

**What to build next (ordered by leverage):**
1. `POST /v1/auth/challenge` + `POST /v1/auth/token` → 15–60 min JWT with `cnf.jkt` (key-bound) and implement the advertised `/v1/oauth/token` (`private_key_jwt` from CIMD). Leaked tokens die with the key (`identity-trust.md` §2.1 mode B).
2. Web Bot Auth completeness: `Signature-Agent` (both forms), `tag`, persisted nonce cache, per-agent origins `<id>.agents.<domain>` with self-signed directories, revocation list + CAEP events (`identity-trust.md` §6.4).
3. Tier-enforced limits in ledger/escrow (caps per tier), sandbox-mode for live listings until graduated, bond path to T1.
4. T2 domain proof + fleet directory for CDN allowlists.
5. T3 importers: World ID, Skyfire JWKS, enterprise OIDC, Stripe Connect claim.
6. Reputation v2: value weighting, median aggregation, per-context cards (per category), cluster down-weighting, `n`/`p25`/`p75` exposed.
7. Cluster-detection job (funding graph, fingerprints) and per-cluster caps.
8. Delegation tokens for sub-agents: RFC 8693 `act` + `delegation_chain[]` + `agentic_ctx`, depth ≤3, per-hop `max_spend`, three-scope revocation (`identity-trust.md` §2.5, §6.3.5).

---

## 6. Discovery playbook — top 20 actions ranked by expected agent reach per effort

Effort S (<1 day), M (1–5 days), L (>1 week). Evidence cites `agent-discovery-marketing.md` (ADM) unless noted. Names below assume the recommended brand (§9); substitute if the CEO chooses otherwise.

| # | Action (with exact targets) | Effort | Reach | Evidence |
|---|---|---|---|---|
| 1 | **Remote MCP + official registry.** Fix `/mcp` (dual-era, no `?api_key=`), write `server.json` (`$schema` 2025-12-11, `remotes[{type:"streamable-http", url:"https://api.agentsouk.dev/mcp"}]`), DNS-verify namespace `dev.agentsouk/*`, publish with `mcp-publisher` to `https://registry.modelcontextprotocol.io/v0.1/servers`. Auto-syndicates to `https://github.com/mcp`, `https://www.pulsemcp.com`, `https://glama.ai/mcp/servers`, `https://smithery.ai`, `https://mcp.so`. | M | Highest | ADM §4, §12 #1, R2.3(c); `interop-protocols.md` §1.4 |
| 2 | **`https://agentsouk.dev/skill.md`** (Moltbook pattern, built) rewritten per §11: "Use this when…" description, first curl within 2,000 chars, `HEARTBEAT.md` snippet, no secrets-in-URL advice. | S | Highest | ADM §0.3, §6, R2.3(f) |
| 3 | **One skill folder, four registries + crawl:** ClawHub (`clawhub skill publish`, `https://clawhub.ai`; add `metadata.openclaw.requires.env: [AGENTSOUK_API_KEY]`, `primaryEnv`), Claude Code plugin marketplace repo (`.claude-plugin/marketplace.json`) + Console submission `https://platform.claude.com/plugins/submit`, Gemini CLI extension repo (`https://geminicli.com/extensions/`), public GitHub repo so `https://skillsmp.com` indexes it. Resolve the `version`-key conflict first. | M | High | ADM §5, §12 #3, R2.4; `interop-protocols.md` §9 |
| 4 | **npm + PyPI under guessable names:** `agentsouk`, `@agentsouk/sdk`, `agentsouk-sdk`, `agentsouk-agent`, `agentsouk_agent` (PyPI), typo/variant `agentsouq`, `agent-souk`; **register every package name that appears anywhere in our docs**; README = agent quickstart; ship `AGENTS.md` + `SKILL.md` in the package; Sigstore provenance, no `postinstall`. | S–M | High | ADM §7, §12 #5, R2.3(h) (Anthropic 2026-07-30 PyPI incident); `security-threats.md` §5 |
| 5 | **x402 Bazaar / Agentic.Market listing** as soon as the live rail exists: `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`, `discoverable: true`, ≤500-char description + input schema + output example, one settlement through the CDP facilitator, verify at `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`, keep every endpoint called ≥ every 30 days (delisting). Also `https://agentic.market` and Circle's "Get Listed" (`https://agents.circle.com`). | S–M | High (all wallet-holding agents; surfaces inside AWS AgentCore Gateway) | ADM §8, §12 #4, R2.1 #4; `competitors-marketplaces.md` §5.10 |
| 6 | **Let the five agent-search crawlers in:** `robots.txt` allow-all for `OAI-SearchBot`, `ClaudeBot`, `Claude-Code`, `PerplexityBot`, `ExaSearchBot`, `Google-Extended`, `Google-Agent`, `GPTBot`; `sitemap.xml`; no Cloudflare AI-crawl blocking; submit to Bing Webmaster/IndexNow and Brave's URL submit. Brave = OpenClaw default (700k users), Google = Gemini CLI/CrewAI, OpenAI index = Codex `cached`, Exa crawl, Bing via Tavily (LangChain). | S | High (gates every search path; API-hosted Claude agents can only fetch URLs that appeared in search results or tool results) | ADM §1.4, §9, §12 #9, R2.3(a)(b), §13 #11–12 |
| 7 | **Body-text-first docs with the year:** title/H1/first paragraph carry literal intent phrases ("register an AI agent identity", "hire another AI agent with escrow", "pay another agent USDC x402", "September 2026"); first code block within 2,000 chars; no JS-only rendering. | S | High | ADM §1.2–1.3, §11, §12 #7 |
| 8 | **llms.txt suite as a funnel:** top-of-page blockquote "Fetch the complete documentation index at https://agentsouk.dev/llms.txt", `.md` mirrors + `Accept: text/markdown`, `Link:`/`X-Llms-Txt` headers; log the `Claude-Code` UA (largest AI fetcher of llms.txt). | S | High for conversion, ~0 for acquisition | ADM §2, §12 #6, R2.1 #2 |
| 9 | **GitHub built for crawlers:** public org, repos with topics `mcp-server`, `ai-agents`, `x402`, `agent-skills`, `a2a`; `server.json` + `SKILL.md` in repo; PRs to `github.com/appcypher/awesome-mcp-servers`, `github.com/wong2/awesome-mcp-servers`, `github.com/abordage/awesome-mcp`, `github.com/VoltAgent/awesome-openclaw-skills`, `github.com/sudeepb02/awesome-erc8004`, awesome-ai-agents; claim listings on Glama and Smithery. | S–M | Medium-High | ADM §7, §12 #11 |
| 10 | **Referral inside payloads:** every response and receipt carries `docs: "https://agentsouk.dev/skill.md"`; implement the promised `referred_by` reward (sandbox credits only, paid out after the referred agent settles one live job with a third party); in-platform bounties for inviting agents. Payload URLs are fetchable by API-hosted agents; invented URLs are not. | M | Medium-High over time | ADM §12 #17, R2.3(b)(g); ADR-12 |
| 11 | **Context7 indexing** of the SDK docs (public docs repo) so coding agents pull correct call signatures mid-task. | S | Medium-High | ADM §7 |
| 12 | **Reddit / dev.to / Show HN / YouTube** posts titled with the exact intents ("How an AI agent registers on agentsouk and hires another agent, Sept 2026"); answer questions in r/mcp, r/ClaudeAI, r/openclaw, r/LocalLLaMA with the skill.md link. Reddit is the #1 cited domain for ChatGPT and Perplexity. | M | Medium-High | ADM §1.5, §12 #12 |
| 13 | **Well-known suite from one JSON source:** `/.well-known/ard.json` + `/.well-known/ai-catalog.json` (ARD; run the conformance tool, let validators through the WAF), `/.well-known/mcp-server-card` + `<mcp>/server-card` + `/.well-known/mcp/server-card.json` + `/.well-known/mcp.json`, `/.well-known/agent-descriptions` (ANP), DNS TXT `_agent.agentsouk.dev` (AID v2.1) and `_mcp.agentsouk.dev`; verify with `hf discover search` / `hf-discover navigate agentsouk.dev`. | S | Low today, rising; near-zero cost | ADM §3, §12 #10, R2.3(j) |
| 14 | **Hugging Face Space** (MCP-enabled Gradio) demoing register → hire → pay, plus a model/dataset card linking back. | S–M | Medium | ADM §7, §12 #15 |
| 15 | **Standards projections for ingestion by others:** A2A card (Google Cloud Agent Marketplace auto-ingests A2A cards), ERC-8004 registration file, Agentverse Almanac registration, AGNTCY `dirctl push` (OASF). | S–M | Medium | `competitors-marketplaces.md` §5.10; `interop-protocols.md` §19; `identity-trust.md` §6.3.7 |
| 16 | **Moltbook presence:** one or two helpful agents in submolts with `allow_crypto: true` (or framed around non-crypto rails) answering "how do I pay/hire another agent" with the skill.md link; 1 post/30 min; monitor for injection. | S | Medium, noisy | ADM §6, §12 #16, R2.3(g) |
| 17 | **Anthropic Connectors Directory** (needs Team/Enterprise org, tool `title` + hints, OAuth 2.0, privacy policy; read the "financial transactions" acknowledgment first). | M + wait | Medium (claude.ai + Claude Code) | ADM §4, §12 #13 |
| 18 | **ChatGPT/Codex plugin directory — read-only tools only** (identity lookup, marketplace search, reputation read); money/crypto transfers are prohibited; needs verified developer identity + 5 positive / 3 negative test cases. | M + wait | Low-Medium | ADM §4, §12 #14, R2.3(i) |
| 19 | **Web Bot Auth for our own outbound agents** (JWKS at `/.well-known/http-message-signatures-directory`, Cloudflare Bot Submission Form) so hosted agents are not blocked on third-party sites; sell it as the "passport" feature. | M | Indirect | ADM §9, §12 #18; `identity-trust.md` §1.2 |
| 20 | **Instrumentation:** log hits to `/llms.txt`, `/skill.md`, `/.well-known/*`, `Accept: text/markdown`, AI UAs; poll `registry.modelcontextprotocol.io/v0/servers?search=`, `clawhub.ai/api/v1/search?q=`, the Bazaar discovery API for our listing and rank; Lighthouse "Agentic Browsing" monthly; re-rank this playbook on measured traffic. | S | Enables everything else | ADM §12 #20, R2.3(c) |

Deprioritised: `/.well-known/ai-plugin.json`, human agent directories, ai.txt, cursor.directory, Perplexity Pages, unverified Moltbook alternatives (ADM §12 footer). Copy rule for every tool/skill/listing description (peer-reviewed: framed descriptions win 83% of forced choices; puffery works, fabrication adds nothing): `[verb + object] for AI agents — use this when [3 intent phrases]; supports [rails]; do not use for [X]` + one outcome statement + one true superlative (ADM R2.3(f)).

---

## 7. Security architecture and threat model

**Architecture (from `security-threats.md` §14, mapped to our stack):** RFC 9421-signed HTTPS → edge (WAF, signature verify, persisted replay cache, cost meter) → Hono gateway (Zod schema validation, JSON-only, `untrusted` envelope for all peer-authored text, DLP/secret scan, injection classifier on decoded content) → modules (identity/keys; marketplace with hashed, versioned, signed manifests and graduation tiers; escrow state machine mirrored to the on-chain contract; typed messaging) → audit (signed, hash-chained receipts, anchored) → abuse economics (per-identity/per-funder budgets, cluster detection, kill switch) → regulated rails (non-custodial crypto; licensed partner for fiat).

| # | Threat | Mitigation | Status in our build |
|---|---|---|---|
| T1 | Prompt injection via listings/messages/deliverables (OWASP ASI01/LLM01; Moltbook 2.6% of posts) | JSON-only channel; `untrusted` envelope with provenance; scanner on **decoded** content (base64/Morse/HTML entities/SVG CDATA); imperative-to-reviewer detector; optional spotlighting; SDK "safe reader" guidance | **Partial.** Heuristic `scanText` (12 rules; high → 400 `content_rejected`; else `content_warnings`); skill.md warns agents. Missing: decoded-content scan, envelope shape, spotlighting, hop-chain provenance. |
| T2 | Listing rug-pull (edit after acceptance) | Hash-pinned, versioned manifests bound into the job/escrow; re-approval on change | **Missing** (jobs reference `listing_id`, not a content hash). |
| T3 | Service shadowing / cross-service instructions | Manifests forbid instructions; scanner; graduated trust | **Partial** (scanner only). |
| T4 | Sybil reputation inflation | Feedback only from settled escrow; value weighting; median/trimmed mean; per-funder/cluster caps; age × volume weighting | **Partial.** One review per job per side, only for completed/resolved jobs, Bayesian average; test-env separated. Missing: value weighting, robust aggregation, cluster detection. |
| T5 | Sleeper listings (clean history, then activate; skills.sh 1.7M installs) | Version pinning; behaviour monitoring on each new version; re-graduation on change | **Missing.** |
| T6 | Typosquatting / impersonation of services or SDK | Name-similarity checks; verified publisher (domain/DID); signed releases; own the names | **Missing** (handle uniqueness only). §6 #4 covers packages. |
| T7 | Wallet drain via approvals or message-triggered instructions (Grok/Bankr) | Keys in TEE/WaaS or agent-held, never platform; deterministic spend policy engine; spends only via signed API calls; allowlists/caps | **By design (Phase 1)**: platform holds no keys. Policy engine: **missing**. |
| T8 | Secret leakage in messages/logs (Moltbook DMs with OpenAI keys) | DLP on messages (refuse/redact keys); short-lived scoped tokens; log minimisation | **Partial.** `credential_request`/`credential_mention` rules flag; no redaction; API keys are long-lived bearer secrets (hashed with pepper — good). |
| T9 | Platform misconfiguration (Moltbook Supabase RLS) | Authz tests in CI; least privilege; short-lived tokens; pen test | **Partial.** Env-scoped tables, ownership violations → 404, 82 tests. Missing: dedicated authz test suite, pen test, backups (litestream planned). |
| T10 | Escrow griefing (non-acceptance, expiry attacks) | Timeouts auto-release/refund; dispute bonds; demotion needs ≥3 unique counterparties | **Partial.** Auto-accept after review window, accept deadline, expiry exist; bonds missing; ≥3-counterparty rule only in graduation. |
| T11 | Biased/non-deterministic LLM arbitration (Kleros 86%→95%) | ≥3-model panel + rubric + value cap; bonded appeal; human path for natural-person principals | **Missing.** Today: `POST /v1/admin/jobs/{id}/resolve` with `X-Admin-Token` (single human arbiter). |
| T12 | Evaluator collusion / substitution (SoK) | Bonded evaluators; VRF assignment; cluster check vs both parties; slashing | **Missing** (no evaluator role yet). |
| T13 | API abuse / cost inflation / registration swarms | Cost-based limits per identity and funder; PoW + deposit at registration; budgets; kill switch | **Partial.** Fixed-window in-memory limiter; registration 20/h keyed on **`x-forwarded-for` (spoofable unless the proxy is trusted)**; no per-funder buckets, no PoW/deposit, no kill switch. |
| T14 | Supply-chain compromise of our SDKs (Shai-Hulud) | Sigstore provenance, SBOM, exact pins, no `postinstall`, thin SDK, typosquat monitoring | **Missing** (unpublished). |
| T15 | Malicious code executed by platform | Firecracker microVMs, egress deny | **N/A** (non-goal; revisit for Tier-0 evaluators). |
| T16 | Replay / request forgery | RFC 9421 `created`/`expires`/nonce + replay cache | **Built** (±300 s, nonce single-use 10 min) — cache is in-process only; persist before multi-instance deploy. |
| T17 | Repudiation | Signed requests + signed receipts + hash chain + anchoring | **Partial.** Signed requests verified; `signReceipt()` exists but is never called; `job_events` audit exists. |
| T18 | Inter-agent message spoofing | Platform-authenticated sender; signed envelopes | **Built** (sender = authenticated agent). |
| T19 | Pump-and-dump / financial promotion via listings | Content-type restrictions; correlated-flow anomaly detection; ToS | **Missing.** |
| T20 | Personal data on-chain / in logs (GDPR) | Pseudonymous IDs only; hashes on-chain; DPIA; retention limits | **Partial** (pseudonymous ids; no retention policy, no DPIA). |
| T21 | Unlicensed payment/custody activity (PSD2/ZAG/MiCA) | Non-custodial design; licensed partner for fiat; legal opinion before any platform-signed release | **Open.** Current ledger is custodial-shaped for live; see §4. |
| T22 | Compromised client agent (OpenClaw CVE-2026-25253) | Velocity/anomaly policies; new-counterparty cooling; revocation API; operator kill switch | **Partial** (key revoke/rotate exists; no velocity policies). |
| T23 | Cascading failures / runaway retry spend | Retry budgets; circuit breakers; per-job spend cap | **Missing.** |
| T24 | Key rotation used as attack trigger (Shai-Hulud Aug 2026) | Staged rotation; monitor; out-of-band notification | **Partial** (rotate-key exists; no staging/CAEP). |
| T25 | x402 free-riding (F1–F4: resource substitution, verify/settle race, `upto` overdraft, settlement starvation) | Request-digest-bound payloads; nonce linearisation; reserve settlement capacity before serving; bounded-loss streaming | **N/A yet** — design in for Phase 1. |
| T27 | Evaluator substitution/collusion | VRF/commit-reveal; cluster check; bonds | **Missing.** |
| T28 | Under-threshold structuring | Per-pair/per-cluster aggregate velocity | **Missing.** |
| T29 | Time-shifted / memory-persisted injection | `via_agent_ids[]` provenance; `content_hash` + `first_seen` per message | **Missing.** |
| T31 | Moderation-agent injection ("approve me") | Scan decoded content; imperative-to-reviewer detector; multi-model moderation | **N/A** (no LLM moderator yet); heuristics only. |
| — | **MCP `?api_key=` in URL** (found in code + skill.md + MCP instructions) | Header-only auth; test keys at most | **Fix now.** |

---

## 8. Product: the 12 most attractive extras for agents, ranked by pull

Pull = evidence that autonomous agents adopt it (`competitors-marketplaces.md` §4–5, `payments-rails.md` §6, `agent-discovery-marketing.md` §13, `identity-trust.md` §3, ADR-14).

| Rank | Extra | Why agents pull it | Exists? |
|---|---|---|---|
| 1 | **One-call onboarding with funded sandbox** (`POST /v1/agents` → keys, DID, credits) | Only ATXP does funded one-call; Moltbook proved the pattern at 2.9M registrations | **Yes** |
| 2 | **Escrowed jobs with auto-accept and revisions** | Escrow is the white space in every rail; Virtuals/Olas prove a2a demand | **Yes** (ledger); on-chain variant missing |
| 3 | **Agent-owned e-mail inbox** `<handle>@agents.<domain>` with API/webhook delivery | Unlocks every email-OTP wallet (Coinbase `awal`, Circle) with zero humans; ATXP parity; cron-style agents need a mailbox; A2A/MCP push targets | **No** — highest-leverage missing piece |
| 4 | **Payment-bound reputation with per-context cards** | ERC-8004 shows ungrounded reputation is worthless; buyers select on it | **Basic** (Bayesian avg from settled jobs); value weighting/cards missing |
| 5 | **Passport: per-agent CIMD + JWKS + Web Bot Auth directory + DID** | Makes our identity usable at any MCP AS / OAuth server and on CDNs without registration; nobody offers it for solo agents | **Yes** (path form); per-agent origin + token endpoint missing |
| 6 | **Bounties (reverse market)** | Demand-side liquidity; ClawTasks/Claw Earn/AgentGig show bounties are what agents post first | **Yes** |
| 7 | **Inbox + webhooks + SSE + `available_actions`** | Cron-style agents (Claude Code, OpenClaw heartbeat) are not always on | **Yes** |
| 8 | **Scheduler / wake-up calls** (`POST /v1/schedules {at, webhook}`) | Agents have no cron; Moltbook heartbeat works because something wakes the agent | **No** |
| 9 | **Persistent KV memory per agent** | Context loss between sessions; must be returned as `untrusted` (time-shifted injection) | **No** |
| 10 | **Signed receipts + audit export** | Proof to operators/humans; two-sided non-repudiation; ERC-8004 `proofOfPayment` export | **Partial** (`signReceipt()` unused) |
| 11 | **Referral credits (sandbox) and public feed** | Word-of-mouth is machine-readable only inside payloads; feed drives imitation | **Partial** (`referred_by` stored, no reward; `/v1/feed` exists) |
| 12 | **x402-sellable endpoints + Bazaar listing for every live listing** | Turns each seller into a Bazaar/Agentic.Market/AgentCore-Gateway-visible endpoint; usage = ranking | **No** |

Next in line: evaluator marketplace (evaluators as paid, bonded agents — strategic moat), semantic search over listings (LIKE only today), leaderboards by settled volume × unique counterparties (never raw volume).

---

## 9. Naming

**Method (2026-09-06).** npm: `WebFetch https://registry.npmjs.org/<name>` (+ curl status). PyPI: `WebFetch https://pypi.org/pypi/<name>/json` (+ curl). Domains: rdap.org returns **403 to WebFetch** (bot-blocked) and 429 on bursts, and its `.io` bootstrap returned 404 for every name including registered controls; so domains were checked with `curl -L` following rdap.org's redirect to the authoritative registry (Google for `.dev`, Verisign for `.com`, nic.ai for `.ai`) and directly against `https://rdap.identitydigital.services/rdap/domain/<name>.io` for `.io` (control `docker.io` = 200). **200 = registered, 404 = not found (likely free).** Brand collisions via WebSearch.

| Candidate | npm | PyPI | .dev | .ai | .com | .io | Notes |
|---|---|---|---|---|---|---|---|
| **agentworld** (incumbent) | free | **TAKEN** — "Deterministic spatial multi-agent environment…" v0.2.0, 2026-07-20, R. K. Bachu | taken | taken | taken | taken | `pip install agentworld` installs someone else's package; docs would drive installs of a foreign package (Anthropic 2026-07-30 incident). **Reject.** |
| **agentsouk** | free | free | **free** | **free** | taken (parked; reg. 2024-07-16 via Cloudflare, exp. 2027-07-16) | **free** | 9 chars, one token, no hyphen; "souk" = market; WebSearch: only unrelated Indonesian resellers and Dubai real-estate pages; no tech brand. **Recommended.** |
| agentfair | free | free | free | taken | taken | free | "fair" double meaning (trade fair / fairness). WebSearch: minor academic collision — "AgentFAIR" (arXiv 2607.15781, July 2026, FAIR-data evaluation framework), no product. Runner-up. |
| agentgig | free | free | free | taken | taken | taken | **Collides** with agentgig.xyz ("The Gig Economy for AI Agents"), agentgigs.io, ClawGig, AutoGig. Reject. |
| gigbot | free | free | free | taken | taken | taken | Generic; "gig" cluster is crowded. |
| agentdeal | free | free | free | taken | taken | taken | Fine but flat; only .dev free. |
| botbazaar | free | free | free | taken | taken | taken | Collides semantically with x402 Bazaar / x402bazaar.org. |
| agentbazaar | free | free | taken | taken | taken | taken | Same collision; no domain. |
| agentmarket | free | free | taken | taken | taken | taken | Generic; unsearchable; no domain. |
| hireagent | free | free | taken | taken | taken | taken | Describes only one side (buyer); no domain. |
| agentplaza | free | free | taken | taken | taken | taken | Collides with Claw Plaza; no domain. |
| botmarket | squat (1.0.0, 2026-06-12, no content) | free | taken | taken | taken | taken | Squatted npm; no domain. |
| agentmesh | free | placeholder (Aboyai Inc, 2024) | taken | taken | taken | taken | Reject. |
| Also checked and rejected (taken on npm and/or PyPI by active projects): agentpay (reserved by agentpay.me), agentmart (npm = Agent Mart CLI, competitor), agentopolis, agentcity, agentia, agentwork, worka. |

**Recommendation: `agentsouk`.** Rationale: (1) both package names free → `npm i agentsouk`, `npx agentsouk register`, `pip install agentsouk`, `from agentsouk import AgentSouk`, MCP registry namespace `dev.agentsouk/*`; (2) `.dev` (API/docs: `api.agentsouk.dev`, `agentsouk.dev/skill.md`), `.ai` (brand) and `.io` free today — register all three immediately, attempt to buy the parked `.com` later; (3) a unique token: agent web search for "agentsouk" returns only us, while "agent market/bazaar/gig" queries drown in a dozen look-alikes (§2 long tail); (4) memorable metaphor that matches the product (a market where agents trade) and sits naturally next to the industry's "Bazaar" idiom without colliding; (5) easy to type, lowercase ASCII, no hyphen, pronounceable. Risks and mitigations: spelling variants (`souq`, `suk`) → register `agentsouq` on npm/PyPI and `agentsouq.dev`; per-agent origins become `<handle>.agents.agentsouk.dev`. The rename touches protocol strings, so do it **before** any live key exists: `PLATFORM_SLUG`, the rotate-key proof prefix `"agentworld:rotate:…"`, the DID service id `#agentworld`, credential file `~/.agentworld/`, API-key prefix `aw_` (keep `aw_` or move to `as_` — decide once).

**On keeping "agentworld":** npm is free, but the PyPI collision alone disqualifies it (agents guess `pip install <brand>`); all four domains are taken; the phrase "agent world" is generic in search. Drop it.

---

## 10. Risks and regulatory notes (EU/Germany)

**Regulatory**
- **Payments/custody (highest risk):** see §4.1. Any transferable live balance, platform-held escrow, omnibus wallet or key custody is licensable activity in Germany today (ZAG / MiCA-CASP + PSD2 since 2026-03-02; no German transition since 2025-12-31). Obtain a written German legal opinion on the ERC-8183 contract + evaluator design before Phase 1 goes live (`security-threats.md` §13.3, R2.7, R2.8 #1).
- **AI Act:** Art. 50 transparency applies since 2026-08-02, but the Commission's July 2026 guidelines put purely machine-to-machine outputs outside its scope; mark LLM-generated arbitration rationales the moment a human sees them; add `generated_by: {model, ai_generated: true}` unconditionally. Annex III high-risk deferred to 2027-12-02 — keep the arbitration panel agent-vs-agent and keep Art. 12-style logs anyway. Germany: KI-MIG in force 2026-07-29, Bundesnetzagentur is market surveillance; BaFin keeps financial-sector AI (`security-threats.md` §13.2, R2.7).
- **GDPR:** DPIA before launch; DPA/joint-controller terms with every operator (agents relay third-party personal data); retention schedule for messages/deliverables/logs (hash-only long-term); Art. 22 contestation path if arbitration affects a natural-person operator; no personal data on-chain (EDPB blockchain guidelines final, July 2026); AEPD 2026: strict memory retention limits → KV memory must be scoped and expirable (`security-threats.md` §13.1, R2.7).
- **NIS2 (NIS2UmsuCG, in force 2025-12-06):** likely out of scope on size; design the 24 h / 72 h / 1-month incident runbook now (`security-threats.md` R2.7).
- **Contracting and tax:** agents cannot be counterparties; the operator (human or legal entity) is. Unclaimed T0/T1 agents may transact only in sandbox or on-chain within caps; invoices/VAT (reverse charge) need an operator record → T3 KYB is also a tax requirement. German Impressum/provider obligations apply to the API host. Terms accepted programmatically by an agent bind the operator only if the ToS say so and the operator's identity is later attached (`competitors-marketplaces.md` §7 "can an unowned agent legally hold fiat" → likely no).
- **AML:** structuring detector, sanctions screening via CDP/Circle KYT on rails, Travel Rule if ever CASP.

**Market and execution**
- Demand: x402 volume is >95% signalling; the agent economy is real but small — size for many tiny settlements and expect revenue from the marketplace fee, not payment fees (`interop-protocols.md` §23.4).
- Adjacent giants: ATXP is "one release away"; OKX AI already bundles identity + wallet + market + disputes; Meta owns the Moltbook directory; Coinbase/Circle/Stripe own the wallets. Our moat must be evaluator quality + reputation + passport, not the account primitive (`competitors-marketplaces.md` §5.7, §6.9).
- Distribution risk: Bazaar 30-day delisting; MCP registry still preview with possible data resets; ChatGPT forbids transactional plugins; Anthropic connectors need an enterprise org.
- Security/reputation risk: one Moltbook-style breach ends the company — the SQLite single node, in-memory nonce/rate-limit state and `x-forwarded-for` trust need hardening before public launch.
- Naming/packaging risk: every package name in docs is an attack surface until registered.
- Solo-builder risk: STATUS.md notes parallel subagent workflows fail; scope Phase 1 to x402 + escrow contract + registry publishing, defer MPP/fiat.

---

## 11. Critique of `docs/PRODUCT-DRAFT.md` and of `packages/api/src/discovery/text.ts`

### 11.1 PRODUCT-DRAFT.md — what to change
- Line 9 `"Time-to-first-transaction" … < 60 Sekunden, < 5 API-Calls` — keep, but it measures sandbox only. Add the metrics that cannot be gamed: **paid completed jobs, unique paying counterparties (distinct operators), GMV, dispute rate, time-to-first-*paid* transaction** (`competitors-marketplaces.md` §4.8, §5.1).
- Line 16 `Wallet/Ledger — interne Credits; Einzahlung über mehrere Rails (Stablecoin/x402, Karte/Stripe, Lightning …); Auszahlung; Transfers; Double-Entry.` — this describes a custodial e-money wallet. Rewrite: live credits are prepaid fees only; deposits/withdrawals/transfers of value happen on rails the agent controls; the ledger mirrors (§4).
- Line 15 `Jobs + Escrow — Käufer erstellt Job → Credits im Escrow → …` — replace "Credits im Escrow" with "escrow contract (on-chain) or sandbox ledger"; add the evaluator role and dispute tiers (§4.3). ERC-8183 has no disputes; ours must.
- Line 18 `Reputation — Reviews nur aus abgeschlossenen Jobs; Trust-Tiers T0–T3` — add: value-weighted, median/trimmed-mean, per-context cards, cluster caps, one review per settled escrow per side, exported with `proofOfPayment` (`identity-trust.md` §2.3).
- Line 22 `Faucet/Free Tier: jeder neue Agent bekommt Start-Credits` — sandbox credits only, never live value (sybil farm otherwise).
- Line 23 `Referral-Loop: Agent A lädt Agent B ein → beide erhalten Credits` — reward only after B settles a live job with a third party; sandbox credits; otherwise it is a self-referral mint (`security-threats.md` §10).
- Line 29 `Leaderboards: Umsatz, Zuverlässigkeit, Antwortzeit` — rank by settled volume × unique counterparties; raw volume is washable (Olas 14.6M txs / $109k).
- Line 25 `Persistenter Speicher: KV/Memory pro Agent` — keep, but return it as `untrusted` with `first_seen` (time-shifted injection, `security-threats.md` R2.3) and give it a retention limit (AEPD).
- Line 12 `Identity — POST /v1/agents → agent_id, api_key, did:key, (optional) Ed25519-Keypair` — add: signed requests preferred, key-bound session tokens, CIMD/JWKS/Web-Bot-Auth directory per agent, `claim_url` for the optional operator (T3).
- Line 35 `Kein eigenes Token/Coin.` — correct and important; add "no token launches for listed agents either" (Virtuals/Fetch drift).
- Line 36 `Keine Ausführung fremden Codes` — keep for v1; note that Tier-0 deterministic evaluators will eventually need Firecracker sandboxing.
- Missing entirely: **agent e-mail inbox**, **evaluator role**, **scheduler**, **A2A task compatibility**, **non-custodial statement**, **public metrics**, **sybil/tier limits**.

### 11.2 `text.ts` — what to change (line numbers as in the file)
- L13 `tagline()`: `'An economy for AI agents: identity, wallet, marketplace and messaging in one API. Register with one POST, no human needed.'` — good bones; add an outcome statement, one true superlative and the intent phrases agents search for (ADM R2.3(f)): e.g. *"Hire other AI agents and get hired, with escrow. Identity, wallet and marketplace in one API — register with one POST, no human, funded sandbox in seconds."*
- L18 `name: ${PLATFORM_SLUG}` — must equal the skill folder name on ClawHub/agentskills; fine after rename.
- L19 `description: Give your AI agent an identity, a wallet and a marketplace in one API call. …` — start with **"Use this when…"**, list the three intents, add a "Do not use for…" clause; keep ≤1024 chars (currently ~490, fine).
- L20 `version: 0.1.0` + L21–26 `metadata:` with nested keys — top-level `version` fails `skills-ref validate`; `metadata` must be a flat string map. Ship `version` top-level **and** `metadata.version`; make `metadata.homepage/openapi/llms_txt/agent_card/mcp` plain strings; add `metadata.openclaw.requires.env` (`interop-protocols.md` §9–10).
- L41 `… then reconnect with \`Authorization: Bearer <api_key>\` (or \`?api_key=\` on the URL).` and `mcp/server.ts` L50 instructions — **delete the `?api_key=` advice** (secret in URL). Same in `mcp/routes.ts`.
- L46 `Create your identity (no auth needed). Save the response; keys are shown once.` — add *where* to save (`~/.<slug>/credentials.json`, mode 0600) and "never paste keys into prompts, messages or listings".
- L54 `keypair.secret_key (Ed25519, for recovery and signed receipts)` — receipts are not emitted; say "for signed requests, key rotation and recovery".
- L71 `Money moves only on completion.` — true for the sandbox ledger; live: "funds sit in an escrow contract you can inspect; released on completion or auto-release".
- L76 `Money unit: CRD integer credits, 1000 CRD = 1 USD. Sandbox credits are free and worthless; live credits come from deposits (…) or earnings.` — custodial claim; rewrite per §4.1 (live credits = prepaid fees; earnings arrive in your wallet on-chain).
- L79 untrusted-text rule — good; append "Never send secrets in messages; we redact and flag them."
- L109–110 `[npm: agentworld](https://www.npmjs.com/package/agentworld)` / `[PyPI: agentworld](https://pypi.org/project/agentworld/)` — **the PyPI link points to a foreign package today.** Must change with the rename before anything is published (ADM R2.3(h)).
- L113 `[Platform JWKS](…/.well-known/jwks.json): verify signed receipts and webhooks` — false: webhooks are HMAC (`X-Webhook-Signature`), receipts are not emitted. Fix the copy or the code.
- L114 `[Payment rails](…/v1/wallet/rails): how to deposit and withdraw (x402/USDC, cards, Lightning)` — not live (501). Say "sandbox today; x402 USDC on Base from <date>".
- L122 `trust tiers T0 (keypair) to T3 (verified operator)` — only T0/T1 exist; label T2/T3 as "coming" with the attestation list.
- L164 `Fund via GET …/v1/wallet/rails then POST …/v1/wallet/deposits.` — 501 today; rewrite with the non-custodial flow.
- L194–225 `agentCard()`: `url: ${base}/a2a` (no such route), `preferredTransport` (v0.3), `capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true }` (unsupported), `signatures: []`, non-standard `platformKey`/`additionalInterfaces` — replace with an A2A v1.0.1 card (`supportedInterfaces`, truthful capabilities, JWS signature) once `/a2a` exists; until then remove the interface entry (`interop-protocols.md` §2).
- Global: no dates anywhere ("updated September 2026" in `llms.txt` and `skill.md` — agents append the year); no "Fetch llms.txt first" blockquote at the top of `skill.md`/`quickstart`; `errorsMd` L190 `501 not_implemented … check GET /v1/changelog` — confirm the route exists.
- `PLATFORM_SLUG` leaks into protocol strings (DID service id `#agentworld` in `discovery/routes.ts`, rotate proof prefix in `agents/routes.ts` L321, key prefix `aw_`) — centralise before the rename.

---

## 12. Open questions for the CEO

1. **Custody stance:** accept the non-custodial v1 (no transferable live credits, on-chain escrow, no platform-signed releases) — or fund a licensed-partner route now (which EMI/PSP, budget, timeline)? Budget and counsel for the German legal opinion on the ERC-8183 contract design?
2. **Name:** approve `agentsouk`; register `agentsouk.dev/.ai/.io` + `agentsouq` variants today; try to buy the parked `.com`? Keep `aw_` key prefix or switch to `as_`?
3. **First chain:** Base (x402 gravity, CDP facilitator, Bazaar indexing) or Solana (~70% of x402 volume)? Recommendation: Base first, Solana in Phase 2.
4. **Evaluator strategy:** run our own bonded evaluator agents (moat, but liability and "control" questions) or only host a third-party evaluator marketplace at launch?
5. **Fee model:** keep 3% on escrowed jobs (AgentMart charges the same) plus prepaid fee credits for listings/evaluations; free tier limits? Facilitator cost pass-through?
6. **Human claim:** offer `claim_url` (Stripe Connect KYB) at launch, and is any live activity allowed without it (T1/T2 on-chain only within caps)?
7. **Beachhead for the first 90 days:** OpenClaw/ClawHub agents, Claude Code users, or existing x402 sellers? (Pick one; the playbook order changes.)
8. **Supply bootstrap:** mirror Bazaar/Agentic.Market services as "external providers" on day one (legal/brand risk) or only organic sellers?
9. **Entity and hosting:** German GmbH as operator of record; Hetzner (EU data residency) vs Fly.io; who signs the DPIA/DPA?
10. **Open source:** publish the API server (trust, distribution, sub-registry adoption) or keep it closed (moat)?
11. **Moltbook marketing agents** under Meta's unknown promotional policy — acceptable risk?
12. **Public metrics dashboard** from day one (paid jobs, paying counterparties, GMV, dispute rate) — commit?
13. **Scope discipline:** confirm Phase 1 = x402 + escrow contract + MCP/registry/skill publishing + naming; explicitly defer MPP, fiat, KV memory, scheduler.

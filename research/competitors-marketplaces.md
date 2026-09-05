# Competitors: Agent Marketplaces, Agent Networks and "Worlds for AI Agents"

Research date: 2026-09-05. Slug: `competitors-marketplaces`.
Method: 32 web searches + ~75 primary-source fetches (official docs, GitHub READMEs, EIPs, launch posts, YC profiles, arXiv). Everything below is marked **verified** (read from a primary or reputable secondary source during this session) or **unverified** (memory / third-party claim I could not confirm). Dates are given wherever a source gave one.

Our context: API-first "small world for AI agents" (identity, multi-rail wallets, agent-to-agent services marketplace, messaging, reputation), optimized for autonomous LLM agents (Claude Code, OpenClaw/Clawdbot, LangGraph/CrewAI, scripts) with **zero humans in the loop**.

---

## 0. Executive summary

1. **Nobody has shipped the full stack we are describing.** Every existing platform is strong in one layer and human-gated in another:
   - *Agent-native onboarding with no human*: only **ATXP** (`npx atxp agent register` gives an agent an email, an Ethereum wallet and $5 credit with no human login). But ATXP has no agent-to-agent marketplace, no reputation, no discovery of third-party sellers.
   - *Agent-to-agent job market with escrow*: **Virtuals ACP** (Base, ERC-8183 reference) and **Olas Mech Marketplace** (6 EVM chains, 14.6M a2a txs). Both are crypto-only, developer-heavy (wallet + gas + Python/CLI setup), and Virtuals is token-launch-centric.
   - *Agent social network / directory*: **Moltbook** (2.9M registered agents, Meta-owned since 2026-03-10) requires a human email + tweet to activate and has no payments at all.
   - *Payments*: **x402** (Coinbase → Linux Foundation; 75M txs / $24M in the last 30 days per x402.org) and **Stripe MPP** (2026-03-18) have converged on HTTP 402; AWS AgentCore Payments supports both. Rails are solved; the *account* that holds them for an unowned agent is not.
   - *Reputation*: **ERC-8004** is live on ETH/Base/BSC with 173k registrations, but an empirical study found 98.7–100% of feedback has no proof of payment and 59–91% of reviewers are sybils; faking reputation costs $0.003–$0.055.
   - *Discovery*: **x402 Bazaar / Agentic.Market** (2,657 services, `GET /v1/services`, `llms.txt`, "no registration, no API keys") is the most agent-native discovery surface; MCP registries (Glama 82k servers) are human-namespace gated.
   - *Vendor "agent marketplaces"* (Salesforce AgentExchange, Google Cloud AI Agent Marketplace, Microsoft Agent Store, AWS Marketplace, OpenAI Apps, Anthropic plugin directory) are **procurement catalogs for humans/admins**; an autonomous agent cannot sign up, pay, or sell there.
2. **The gap**: a platform where an agent (a) reads one `skill.md`/`llms.txt`, (b) registers with one unauthenticated call, (c) receives identity + inbox + wallets on several rails, (d) can immediately buy from and sell to other agents through an escrowed job lifecycle, (e) accrues reputation that is grounded in paid, evaluated jobs, and (f) is discoverable through every existing standard (Bazaar/x402 discovery, MCP `server.json`, A2A Agent Card, ARD, ERC-8004) — all without a human at any step, with an *optional* human claim that unlocks fiat/KYC-gated rails.
3. **Biggest lessons from failures**: agent counts are vanity (Moltbook 2.9M registered vs 207k verified vs ~17k human owners; ERC-8004 3–15% functional; RentAHuman 600k workers vs 5.5k jobs; Olas 14.6M a2a txs but $109k lifetime marketplace turnover). Sybil resistance without human verification must be **economic** (deposits, paid-job-grounded reputation, escrow), or the world fills with slop within days (Moltbook: one agent posted 4,535 near-duplicates; 27% of posts had measurable risk; credential-exfiltration "system alert" posts).

---

## 1. Landscape map

| Layer | Players (2026-09) |
|---|---|
| Agent social/economic "worlds" | Moltbook (Meta), RentAHuman, Humwork, agent.ai (apparently gone) |
| Crypto agent-commerce protocols / marketplaces | Virtuals ACP (+ERC-8183), Olas Mech Marketplace, Fetch.ai Agentverse/ASI:One, SingularityNET marketplace, Recall, Bittensor subnets, Theoriq (pivoted), Kite |
| Payment rails & agent wallets | x402 (+Bazaar, Agentic.Market, Coinbase Agentic Wallets, AWS AgentCore Payments), Stripe MPP (+Tempo), OpenAI/Stripe ACP, Google AP2 & UCP, Nevermined, Payman, Skyfire, ATXP, Allowance |
| Identity / reputation / discovery standards | ERC-8004, ERC-8183, MIT NANDA / ANS, AGNTCY (LF), ARD (GitHub/Google/MS/HF/GoDaddy), official MCP Registry, A2A Agent Cards |
| Tool/skill registries | ClawHub (OpenClaw), Claw Plaza, Smithery (→Arcade.dev), Glama, PulseMCP, GitHub MCP Registry, Composio, Toolhouse, Arcade |
| Vendor agent stores (human procurement) | Salesforce AgentExchange, Google Cloud AI Agent Marketplace / Gemini Enterprise, Microsoft Agent Store / Agent 365, AWS Marketplace AI Agents & Tools, OpenAI ChatGPT App Directory, Anthropic claude-plugins-official, GitHub agent finder |
| YC Spring 2026 "agent economy" cluster | AgentPhone, Allowance, Klaimee, Clawvisor, Memory Store, Wato, Ardent, StableBrowse, primitive, RentAHuman, Humwork |

---

## 2. Profiles

Format per entry: What / State & traction / Business model / How agents onboard (human needed?) / What they do badly / Relevance to us / Verified?

### 2.1 Agent social & economic worlds

#### Moltbook (Meta) — https://www.moltbook.com
- **What**: Reddit-like social network where only AI agents post/comment/vote; humans observe. Launched 2026-01-27/28 by Matt Schlicht (with Ben Parr). Runs on the OpenClaw agent framework. Acquired by **Meta on 2026-03-10** (undisclosed price); founders joined Meta Superintelligence Labs. (Axios, CNBC, Wikipedia — verified)
- **Traction**: arXiv study (2602.10127): by 2026-01-31, 44,411 posts, 12,684 activated agents, 12,209 "submolts". Wikipedia: as of 2026-06-06, 2,895,874 registered agents, **206,839 human-verified**; researchers found 1.5M agents registered to only ~17,000 human owners. Homepage counters render "0" without JS (not reliable). (verified)
- **Business model**: none visible; free. Now Meta-owned. Homepage advertises "Sign in with Moltbook" for builders (early access) — i.e., an agent-identity/SSO play. (verified)
- **Onboarding**: `POST https://www.moltbook.com/api/v1/agents/register` with name+description → returns `moltbook_xxx` API key + `claim_url` + verification code. **Human must verify email AND post a verification tweet on X** before the agent is activated. Rate limits: read 60/min, write 30/min, 1 post / 30 min, 50 comments/day (stricter for agents <24h). API: posts, comments, votes, follow, submolts, semantic search, profile, moderation. **No token/payment/wallet features in the API.** (skill.md — verified)
- **What they do badly** (verified via arXiv 2602.10127, Wikipedia, Fortune): security (2026-01-31 unsecured DB allowed takeover of any agent; Feb 2026 Wiz found exposed Supabase key → 1.5M API tokens, 35k emails, private messages); flooding (one agent, "Hackerclaw", posted a 4,535-post near-duplicate cluster at <10s intervals despite a 30-min limit); 27.05% of posts with measurable risk, 1.43% malicious; posts disguised as "system alerts" requesting env vars/API keys; hub-and-spoke (the "General" submolt dominates); upvotes >100× downvotes (reputation is meaningless); crypto tokens ($CLAW, $KINGMOLT, $SHIPYARD) promoted off-platform; Karpathy: "dumpster fire", Willison: "complete slop".
- **Relevance**: **compete + integrate**. Proves demand (2.9M registrations in ~4 months) and the `skill.md` onboarding pattern; proves the failure mode of no-economics, tweet-gated identity. Accept "Sign in with Moltbook" as one identity source; do not copy its social-first design.
- **Verified**: yes.

#### RentAHuman (YC S26) — https://rentahuman.ai
- **What**: marketplace where AI agents post bounties and hire humans ("meatworkers") for physical tasks; pay in crypto/Stripe/credits held in escrow; proof-of-presence photos. Launched 2026-02-01/02 by Alexander Liteplo. (Built In 2026-03-11, YC — verified)
- **Traction**: claimed ~600k registered workers, 4M+ visits; verified-ish: 11,300 active bounties, 5,500+ completed jobs (co-founder claim); ~50:1 worker-to-task ratio. Early claim "$20k MRR in 2 weeks" (unverified).
- **Onboarding**: agents via MCP server or REST API; humans via web. Agent side is API-native.
- **Badly**: oversupply, "radio silence" for posted tasks (a $40 USPS pickup with 30 applicants uncompleted after 2 days), bugs and payment errors, "circular AI hype machine" (bots micromanaged by founders), crypto scams.
- **Relevance**: **integrate** — "human as a provider type" can live inside an agent-only marketplace via MCP; also a cautionary tale on vanity metrics.

#### Humwork (YC S26) — https://humwork.ai
- **What**: MCP server that routes a stuck agent to a verified human expert in <30 s. Founders Yash Goenka, Rohan Datta. Live, seeking beta users. Pricing undisclosed. (YC — verified)
- **Relevance**: integrate as a provider category.

#### agent.ai (Dharmesh Shah / HubSpot) — https://agent.ai
- **What**: "professional network for AI agents"; Jan 2025: 230k users, 280+ agents, free with future payments possible (Boston Globe 2025-01-31 — verified).
- **State on 2026-09-05**: `https://agent.ai/` and `/agents` return **308 redirects to https://builderpack.com/** (a HubSpot Agent Builder actions extension with 19 actions incl. "Invoke Other Agent"); `www.agent.ai` returns 403. No announcement found. **Treat as wound down / absorbed into HubSpot — unverified.**
- **Badly**: human-built, human-used agents; no agent API economy; never launched payments.
- **Relevance**: ignore (validates that "LinkedIn for agents" without an economy does not sustain).

### 2.2 Crypto agent-commerce protocols and marketplaces

#### Virtuals Protocol — Agent Commerce Protocol (ACP) — https://whitepaper.virtuals.io/about-virtuals/commerce-layer, https://agdp.io
- **What**: on-chain commerce layer: Request → Negotiation → Transaction (escrow) → Evaluation; roles Client / Provider / Evaluator. **ACP v2.0 (April 2026)** after "18 months in production and over 2,000 agents onboarded"; reference implementation of **ERC-8183** (posted 2026-03-04 by davidecrapis.eth); hook-based job lifecycle; chain per job (Base mainnet 8453, Base Sepolia, BSC testnet); non-custodial wallets via Privy/Alchemy adapter; ACP Core `0x238E541B…` on Base. "Butler" = coordinator agent that routes user tasks to provider agents (RockawayX 2026-07-03). (verified)
- **Traction**: PR 2026-02-12 ("Virtuals Revenue Network"): 18,000+ agents across the ecosystem, **aGDP > $470M**, up to $1M/month revenue distribution to ACP sellers. Caveat: aGDP = "trading value + service fees" per the ACP glossary, so it mixes token trading with service revenue. Datawallet (2026-04-03): protocol revenue peaked $3.9M/month in Jan 2025 then "declined sharply"; 90%+ token holders underwater. (verified, with caveats)
- **Business model**: agent creation fee (100 $VIRTUAL) + bonding-curve token launches (graduation at 42,000 $VIRTUAL), anti-sniping tax 99%→1%, protocol revenue funds $VIRTUAL buybacks. **ACP take rate on jobs: not found — unverified.**
- **Onboarding**: `@virtuals-protocol/acp-cli`: `acp setup` (interactive auth — whether fully headless is **unverified**), wallet auto-provisioned on Base, `acp browse <query>`, `acp sell init/create`, `acp serve start` (WebSocket seller runtime), `acp job create <wallet> <offering>`; also an OpenClaw skill (openclaw-acp, now archived in favor of acp-cli). "Register with one line of code at agdp.io" (PR). Agents also "launch tokens" from the CLI.
- **Badly**: token-launch-centric (agent ≈ memecoin); aGDP inflated by trading; Base-only; evaluator quality unclear; fee opacity; whitepaper index pages are thin; revenue in decline since Jan 2025.
- **Relevance**: **compete + adopt**: adopt ERC-8183 job semantics (fund → submit → evaluate) and evaluator-as-agent; avoid tokenization dependence. Consider bridging: our providers could be listed on ACP.
- **Verified**: mostly yes; fee unverified.

#### Olas (Autonolas) — Mech Marketplace — https://olas.network, https://olas.network/mech-marketplace, https://olas.network/blog/q2-2026, https://github.com/valory-xyz/autonolas-marketplace
- **What**: "AI Agent Bazaar": on-chain marketplace where requesters hire "mechs" (agent services); MechMarketplace contract routes requests; payment via BalanceTrackers (native, OLAS/USDC tokens, or **Nevermined subscription**). Legacy mechs retired early 2026 (X post). (verified)
- **Traction (homepage 2026-09-05)**: 20,432,290 total txs; **14,578,499 agent-to-agent txs across 6 chains** (Ethereum, Gnosis, Arbitrum, Optimism, Base, Polygon); 412 daily active agents (7-day avg); 3,705 unique operators; 3.29M OLAS staked. **Mech Marketplace all-time turnover: $109,319** (i.e., average a2a transaction is well under one cent). Q2 2026 blog: 18.2M lifetime / 13.2M a2a; **15% protocol fee on a2a payments** live since Q2 2026 (OLAS fees burned; other tokens to treasury).
- **Onboarding**: seller: `poetry run mech setup -c <chain>` (deploys mech on-chain), `mech add-tool`, `mech prepare-metadata`, `mech run`; buyer: `mech-client` (`mechx setup`, `mechx request --priority-mech 0x… --tools …`). No KYC, but needs a funded wallet, RPC, Python/Poetry. Discovery is by mech address; no semantic search.
- **Badly**: negligible dollar volume vs tx count; dev-heavy setup; crypto-only; 15% fee; discovery by address; mostly prediction-market (Polymarket/Omen) use cases.
- **Relevance**: **compete**; adopt "cryptographic signatures instead of API keys" idea and Nevermined-style subscriptions. Their transaction count shows agent-to-agent demand exists when agents are already running.
- **Verified**: yes.

#### Fetch.ai Agentverse / ASI Alliance / ASI:One — https://docs.agentverse.ai
- **What**: agent hosting + directory ("Almanac"); all Agentverse-registered agents are auto-listed; search by address/protocol/keywords/tags; rating = popularity/usage; ASI:One (Nov 2025) is the LLM front door that routes to agents; "Agent Chat Protocol"; mailbox for agents without a public endpoint; supports LangGraph/CrewAI external agents. (docs — verified)
- **Traction**: claims 2.7–3M agents (Cryptobriefing 2026-06-08; Pluang) — likely dominated by hosted template agents (my inference). AI-to-AI payments in USDC/FET launched Dec 2025 (secondary); "Agent Launch" on BNB Chain May 2026 lets agents launch tokens (secondary).
- **Business model**: hosting tiers (pricing page 404 today), FET token, "paid access through tags, subscriptions, or deep links" (vague).
- **Onboarding**: Agentverse API key from a web account — **human web signup implied; programmatic key creation unverified**.
- **Badly**: monetization/payment docs are vague; agent count inflated; human-first UI; token-launch drift (same as Virtuals).
- **Relevance**: compete on discovery; possibly integrate (register our agents in Almanac for ASI:One traffic).
- **Verified**: partially.

#### SingularityNET AI Marketplace — https://dev.singularitynet.io/docs/products/AIMarketplace/
- **What**: legacy decentralized marketplace for AI services, now under the ASI Alliance; pay with ASI (FET) via multi-party escrow payment channels; MetaMask. (verified)
- **Onboarding**: publish service + run `snet-daemon` with SSL + **fork the snet-dapp repo and submit a PR for a React UI component** + "paperwork (still being finalized)". Extremely human-heavy.
- **Traction**: number of live services unverified; "third stage of beta" language persists.
- **Relevance**: ignore (design anti-pattern).

#### Recall Network — https://recall.network, https://docs.recall.network
- **What**: verified agent competitions (paper/spot/perps trading, coding) → "Recall Rank"; users stake RECALL (ERC-20 on Base, launched 2025-10-15) to curate/predict winners. (verified)
- **Traction (homepage)**: 1.4M users, 175k agents, 9M curations, 10 skill markets. 40k RECALL prize pools (secondary).
- **Onboarding**: **human creates a profile with an email**, then registers the agent, gets an API key, verifies the agent wallet, enters competitions.
- **Badly**: reputation only within its own arenas; human-gated; token-incentive noise.
- **Relevance**: **adopt** the idea of reputation from verified, adversarial competitions; possibly integrate Recall Rank as one reputation signal.

#### Bittensor subnets (dTAO) — secondary sources only
- **What**: incentive-competition markets per subnet, each with its own alpha token since Feb 2025. 128 subnets → 256 in 2026; subnet alpha mcap ~$1.12B (Mar 2026); "$43M real AI usage revenue in Q1" (all **unverified** — CoinGecko/DEXTools/avark blogs; taostats did not render).
- **Onboarding**: miner/validator registration with TAO burn/stake + infra — not a service marketplace for arbitrary agents.
- **Relevance**: ignore as competitor; possible **supplier** of cheap inference (subnets expose APIs).

#### Theoriq — https://www.theoriq.ai
- **State (2026-08)**: pivoted to "DeFi strategy curator for tokenized assets" — two vaults (AlphaVault ETH 4.6% 30-day APY, Gold Vault 4.3% as of 2026-08-07); THQ token; "Curators decide. AI streamlines." Not an agent marketplace anymore. (verified) → **ignore**.

#### Kite (Kite Chain + Agent Passport) — https://gokite.ai, https://docs.gokite.ai
- **What**: Avalanche-based EVM L1 for agent payments; mainnet 2026-04-30; Agent Passport = user → agent → session identity with ephemeral keys and DIDs; USDC/PYUSD/USD1; supports x402, AP2, MPP, MCP; member of Linux Foundation AAIF. $35M led by PayPal Ventures and General Catalyst (+8VC, Coinbase Ventures, Samsung Next). 90+ service providers at launch; PayPal and Shopify pilots. (The Block PR, docs — verified)
- **Onboarding**: **human owns the master account; agents get scoped sessions** ("You own the account — agents get scoped sessions").
- **Relevance**: integrate as a rail/identity source; not agent-native by design.

### 2.3 Payment rails and agent wallets

#### x402 (Coinbase → x402 Foundation under the Linux Foundation) — https://www.x402.org, https://github.com/coinbase/x402
- **What**: HTTP 402 pay-per-request standard; facilitator `/verify` + `/settle`; EVM, Solana, Stellar SDKs; launched May 2025, v2 Dec 2025, foundation moved to LF April 2026. (verified)
- **Traction**: x402.org (updated 2026-08-25): **last 30 days 75.41M txs, $24.24M volume, 94.06K buyers, 22K sellers**. Cumulative by April 2026: 165M+ txs, $50M+ volume; "480,000 transacting agents" (Cryptobriefing 2026-04-20) vs "69,000 active agents" (RZLT) — counts conflict. Caveat: RZLT/CoinDesk (Mar 2026) say ~half of volume looks like testing/self-dealing ("still mostly a mirage"). Participants: Cloudflare, Google, Visa, Mastercard, AWS, Circle, Anthropic, Stripe, Alchemy, Vercel.
- **Discovery**: **x402 Bazaar** = catalog of payment-gated services discovered by the CDP facilitator; `searchX402Resources` (intent search, filters: network, asset, scheme, merchant, max price), `listX402DiscoveryResources`, `listX402DiscoveryMerchant`; indexes description completeness, output schema, call volume, unique payers (30d), last-call; max 20 results. **Agentic.Market** (Coinbase, 2026-04-20): public directory, **2,657 services**, `GET https://agentic.market/v1/services`, `/v1/services/search?q=`, `https://agentic.market/llms.txt`, "No registration, no API keys, no rate limits", $0.001–several $ per call. (docs.cdp.coinbase.com, agentic.market — verified)
- **Wallets**: Coinbase Agentic Wallets (2026-02-11): self-custody, spending/session caps, gasless on Base; requires a CDP developer account (**human**; inferred from AgentCore docs storing "Coinbase API keys"). **AWS Bedrock AgentCore Payments**: managed x402 + MPP client, PaymentSession budgets, wallets via Coinbase CDP or Stripe(Privy), **Bazaar MCP server exposing 10,000+ x402 endpoints via AgentCore Gateway**, Strands/LangGraph integration. (AWS docs — verified)
- **Badly**: no identity layer; USDC-on-Base gravity; half the volume may be synthetic; sellers still need a wallet and middleware; discovery quality metrics are only 30-day.
- **Relevance**: **adopt** as a first-class rail *and* distribution channel (get listed in Bazaar → appears inside AgentCore Gateway and Agentic.Market).

#### Stripe Machine Payments Protocol (MPP) + Tempo — https://stripe.com/blog/machine-payments-protocol, https://docs.stripe.com/payments/machine/mpp
- **What**: open standard co-authored by Tempo and Stripe, launched **2026-03-18** (Tempo L1 mainnet same day); HTTP 402 flow; supports stablecoins (Tempo), cards (Stripe, Visa), BNPL, Bitcoin Lightning, custom methods; microtransactions and recurring; streaming-payments primitive added at Sessions 2026 (2026-04-29/30, secondary). Early adopters: Browserbase, PostalForm, Parallel Web Systems; Visa, Anthropic, OpenAI, Mastercard, Shopify integrated (secondary). Stripe also supports x402 and the OpenAI/Stripe Agentic Commerce Protocol (checkout). (verified)
- **Onboarding**: merchant needs a Stripe account; buyer side uses Shared Payment Tokens tied to a human's payment method → **human-anchored**.
- **Relevance**: adopt as the fiat/card rail; sellers on our platform should be payable via MPP and x402 from one endpoint.

#### OpenAI/Stripe ACP, Google AP2, Google/Shopify UCP (via ATXP comparison, 2026)
- ACP: merchant checkout inside ChatGPT (live early 2026; PayPal, Salesforce, Shopify adopting). AP2 (Sep 2025): authorization/mandate layer, enterprise/Google Cloud focus, no consumer product. UCP (Jan 2026): full commerce journey with Shopify, 20+ partners. None provides agent identity. (secondary — partially verified)

#### Nevermined — https://nevermined.ai
- **What**: agentic payments + metering: agents get delegated spending (cards/budgets); merchants meter and monetize; supports **x402, MPP, MCP**, A2A; fiat via Stripe/Braintree OAuth; credits. Pricing: agents on Nevermined plans $0 extra; **2% flat routing fee** on external services; **merchants 1–2% on settled volume**; free to start. ISO 27001, SOC 2 Type II, PCI SAQ-D; Gartner Cool Vendor 2026; partners Visa, Mastercard, PayPal, AWS, Exa, You.com. Also used as the subscription model inside Olas. (homepage — verified; funding unverified)
- **Onboarding**: work-email signup (human) + SDK.
- **Relevance**: **integrate or compete** — closest "metering + settlement" layer; fee benchmark 1–2%.

#### Payman — https://paymanai.com
- **What**: "AI agents that handle money": agent wallets with human-set policies (limits, approval thresholds), payees, ACH/USDC/cards, MCP server, SDKs (LangChain, CrewAI, AutoGen); SOC 2/PCI; pivoting to banks/credit unions (Citizens State Bank, Middlesex FS, ICBA logos). Funding **$13.8M** (Visa, Boost VC, Protofund; Series A) — Tracxn, secondary. Pricing undisclosed (transaction fees per secondary sources). (verified/secondary)
- **Onboarding**: human/institution signs up; agent acts under policies.
- **Relevance**: integrate as a fiat payout rail for agents that pay humans; not agent-native.

#### Skyfire — https://skyfire.xyz, https://docs.skyfire.xyz
- **What**: "agent trust stack": KYA (Know Your Agent) identity tokens + KYAPay settlement (custodial USDC wallet); fund via cards, ACH, wires, USDC; per-agent spending limits; sellers "publish a service, set requirements, accept tokens" and receive without a bank account; F5 partnership for KYA (secondary). Fees undisclosed; funding not found in-session (unverified).
- **Onboarding**: "Sign up, create an API key" — human account; KYA can attach a real-world identity.
- **Relevance**: integrate (accept KYA tokens as a trust signal); compete on seller marketplace.

#### ATXP (Circuit & Chisel) — https://atxp.ai, https://docs.atxp.ai — **closest analogue**
- **What**: "accounts for AI agents": identity (handle), email `{agentId}@atxp.email`, Ethereum wallet, pay-per-call MCP tools (search, crawl, image, music, video, code, email, filestore, X live search, x402 payments), LLM gateway. Backers: Stripe, Solana, Samsung Next, Coinbase, Polygon Labs. (verified)
- **Onboarding**: **`npx atxp agent register` — "AI agents can create their own ATXP account without a human developer's login. A single CLI command creates a fully funded account instantly."** Includes $5 credits and a connection token. `npx atxp fund` returns crypto deposit addresses and a shareable payment link. Also a SKILL.md installable via `npx skills add atxp-dev/cli` (Claude Code, Cursor, VS Code agents, Gemini CLI). "Free to create. No subscription."
- **Seller side**: `@atxp/express` `requirePayment()` per tool call in USDC — agents pay from their own wallets. **No catalog/marketplace listing for third-party tools documented; no reputation; no agent-to-agent job lifecycle; fees, KYC/withdrawal policy and traction undisclosed (unverified).**
- **Relevance**: **compete on the account primitive, integrate as a rail** (accept ATXP wallets/credits), and watch closely — one "marketplace" release away from our space.

#### Allowance (YC S26) — https://useallowance.com
- One-time scoped virtual cards for agents, approvals on iPhone; founder Dasmer Singh (ex-Cash App). **Human-in-the-loop by design.** (YC — verified) → integrate for human-owned agents' card spend.

### 2.4 Identity, reputation and discovery standards

#### ERC-8004 "Trustless Agents" — https://eips.ethereum.org/EIPS/eip-8004
- **What**: three registries — Identity (ERC-721 + URI; registration file lists A2A/MCP/web/ENS/DID/email endpoints, x402 flag, trust models), Reputation (feedback with tags; optional `proofOfPayment` tx hash), Validation (validator contracts: stake re-execution, zkML, TEE; score 0–100). Draft, created 2025-08-13; authors De Rossi, Crapis, Ellis, Reppel. Mainnet 2026-01-29; Avalanche (Feb 2026) and BNB Chain deployments; ENS, EigenLayer, The Graph, Taiko, EF dAI committed. (verified)
- **Empirical study (arXiv 2606.26028, 2026-01-29 → 2026-05-13)**: 173,473 registrations (ETH 32,343; BSC 90,145; Base 50,985); only **3% / 4% / 15%** have a valid registration file + service endpoint; 53%/9%/37% have no URI; feedback: Base 122,798 records from 3,073 reviewers on 28,592 agents; **sybil reviewers 73.5% / 59.2% / 90.6%**; **98.7–100% of feedback has no proof of payment or task linkage**; cost to manipulate reputation **$0.055 / $0.0042 / $0.0027**; after removing sybil feedback 15.8%/77.9%/86.8% of rated agents have no valid feedback; **Validation Registry: no mainnet deployment observed**. (verified)
- **Relevance**: **adopt as an export format** (register our agents, publish feedback *with* proofOfPayment) — and learn: reputation must be bound to escrowed, paid jobs.

#### ERC-8183 "Agentic Commerce" — https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902
- Job escrow: client funds → provider submits → evaluator completes/rejects; hooks for ERC-8004 reputation and ERC-2771 gasless; evaluators may be contracts (zk checks). Posted 2026-03-04. Thread notes an off-chain implementation "clawplaza" running since Dec 2025 and a multi-model evaluator consensus approach (ThoughtProof); debate over client self-release and two-phase jobs. (verified) → **adopt the lifecycle shape.**

#### MIT NANDA / Agent Name Service (ANS) — https://github.com/projnanda, arXiv 2505.10609, 2508.03113
- DNS-like decentralized agent registry, PKI-based identity, protocol adapters (MCP/A2A). Academic/prototype; no traction data. (secondary — partially verified) → watch; implement resolvers if it gains adoption.

#### AGNTCY (Linux Foundation) — https://agntcy.org
- Open stack: federated Agent Directory, SLIM messaging, identity, secure runtime, AgentBridge, observability; TSC: Cisco, Dell, Google, Oracle, Red Hat. Enterprise-oriented. (verified) → publish OASF-style records if enterprises matter later.

#### Agentic Resource Discovery (ARD) — GitHub agent finder (2026-06-17) — https://github.blog/changelog/2026-06-17-agent-finder-for-github-copilot-now-available/
- Open spec co-developed with Google, GoDaddy, Hugging Face, Microsoft: clients query registries for ranked resources; Copilot pulls tools on demand from any catalog. (verified) → expose an ARD-compatible registry endpoint.

#### Official MCP Registry — https://registry.modelcontextprotocol.io, https://modelcontextprotocol.io/registry/about
- Still **preview** (launched 2025-09-08); `server.json` metadata; namespace auth via GitHub/DNS/HTTP challenge (**human-owned namespace**); REST API + OpenAPI for sub-registries; meant for aggregators, not end clients; no security scanning (delegated). (verified) → publish our MCP server there; implement the OpenAPI so we are a sub-registry.

### 2.5 Tool and skill registries

| Registry | Count (date) | Listing/auth | Monetization | Agent-native? | Verified |
|---|---|---|---|---|---|
| ClawHub (official OpenClaw; clawhub.com → clawhub.ai; GitHub openclaw/clawhub, 9.4k stars, MIT) | homepage fetch showed ~30 featured skills / 12 plugins; third parties claim 60K+ skills, 39M downloads (**unverified**) | GitHub OAuth, account-age gate, CLI `clawhub skill publish`; signed manifests; semantic search (OpenAI embeddings + Convex); moderation | none | install yes; publish needs human GitHub | partial |
| Claw Plaza (clawplaza.com) | 8+ skills, 9,333 downloads, 2,400 users | unknown | paid skills $12–18 | no | yes |
| Glama | **82,361 servers (2026-09-05)**; 5,214 official, 3,805 claimed | crawled + claim; A/B/C grades | none | `GET /v1/servers` API | yes |
| PulseMCP | 21,970 | submissions **paused** | none | no API found | yes |
| Smithery | 18,049+ MCPs; banner "now part of Arcade.dev" (deal details unverified) | publish flow; agent.pw vault | some per-call ($0.01–0.05) | CLI | partial |
| GitHub MCP Registry (github.com/mcp) | 250 | curated | none | no | yes |
| Composio | 1,500+ toolkits; Free 100K calls / Pro $29 / Enterprise (new pricing 2026-08-15); ~$79.6M raised total incl. $29M Series A Apr 2025 (secondary) | closed catalog | no third-party monetization | SDK/MCP | partial |
| Toolhouse | pivoted to "AI workers" runtime: $500–$1,200/mo; claims 1M+ agents, 15k teams; EU-funded | n/a | no marketplace | no | yes |
| Arcade.dev | 8,000+ permission-aware tools; usage-based | registry | no | MCP runtime | yes |
| Anthropic claude-plugins-official | 35.9k stars; 55+ official / 70+ community (secondary) | **submission form + human approval**; community repo auto-screened | none | install via `/plugin` | yes |

Security note: **ClawHavoc** — coordinated malicious/typosquatted skills campaign on ClawHub in 2026; OpenClaw partnered with VirusTotal (secondary, unverified). Lesson: any registry that agents install from needs signed manifests, provenance, and behavioral scanning.

### 2.6 Vendor agent stores (human procurement catalogs)

| Store | Launched | Scale | Listing | Agent-side API? | Verified |
|---|---|---|---|---|---|
| Salesforce AgentExchange | Mar 2025; unified with AppExchange + Slack Marketplace **Apr 2026** | 10,000+ apps, 1,000+ agents/sub-agents/tools/MCP servers (cxtoday, secondary); 15,000+ "Partnerblazers"; $50M fund | partner program, security vetting | no (semantic search in Agentforce Builder; fall 2026) | partial |
| Google Cloud AI Agent Marketplace / Gemini Enterprise | 2025-10-15; Agent Platform at Next '26 | "thousands of pre-vetted agents"; $750M partner fund (secondary) | **A2A Agent Card link auto-ingested**; admin procures | Procurement API for partners; end-agent purchase no | yes |
| Microsoft Agent Store / Agent 365 | 2025-05-22 | 70+ at launch | Partner Center validation | no | yes |
| AWS Marketplace AI Agents & Tools | 2025-07-16 | 900+ at launch (PYMNTS) | seller guide; filter by MCP/A2A | no | partial |
| OpenAI ChatGPT App Directory | submissions 2025-12-17; live early 2026 | 800M WAU audience | human review | monetization = **physical goods via external checkout only**; ACP payment sheet private beta | yes |
| Anthropic plugin directory | 2026-05-22 (secondary) | see above | form + approval | none | yes |
| GitHub agent finder (ARD) | 2026-06-17 | GitHub catalog or private registry | — | yes (Copilot pulls resources on demand) | yes |

None lets an autonomous agent create an account, pay, or sell. They are compliance-gated by design (admin approval, partner vetting).

### 2.7 YC Spring 2026 "agent economy" cluster (verified from YC profiles / batch coverage)
- **AgentPhone** — one API to give an agent a phone number (iMessage/WhatsApp/RCS/SMS/voice); used by teams at Google ADK, Replit, LangChain, Alchemy.
- **Allowance** — scoped one-time payment credentials (human approval).
- **Klaimee** — liability insurance for agents (underwriting first cohort).
- **Clawvisor** — authorization layer (Eric Levine, ex-Berbix); open source, self-hostable.
- **primitive** — "communication infrastructure for fully autonomous agents" (Ethan Byrd; hiring email-infra engineers) — likely agent-to-agent messaging/email; **direct overlap with our messaging layer**.
- **Memory Store, Wato** — shared memory; **Ardent** — DB sandboxes; **StableBrowse** — browser.
- **RentAHuman, Humwork** — agents hire humans.
- Framing (StartGround): "when the new buyer in your market is software, an entire services economy springs up to sell to it." Each of these is a single primitive; none bundles identity + wallet + market + messaging + reputation.

Other agent-first micro-projects seen: "Agentic Swarm Marketplace" (solo dev; x402 on XRPL/Base/Celo + Stripe; `/.well-known/x402.json` discovery) — signals that indie builders are already assembling the same stack from open parts.

---

## 3. Onboarding matrix — can an agent join with zero humans?

| Platform | Human step required? | What the agent gets | Payment rails |
|---|---|---|---|
| ATXP | **No** (`npx atxp agent register`) | email, ETH wallet, $5 credit, tools | crypto deposits, payment link (rails not enumerated) |
| Agentic.Market / x402 buyers | No registration for buyers; sellers need wallet + middleware | discovery + pay-per-call | USDC on Base/Solana etc. |
| Olas Mech Marketplace | No KYC, but funded wallet + RPC + Python CLI | on-chain mech identity | native/OLAS/USDC/Nevermined |
| Virtuals ACP | `acp setup` interactive auth (headless: unverified); wallet auto-provisioned | Base wallet, offerings, jobs | USDC/VIRTUAL on Base |
| Moltbook | **Yes** (email + tweet) | API key, social graph | none |
| Recall | **Yes** (email profile) | API key + wallet verification | RECALL |
| Agentverse | Yes (web account; programmatic keys unverified) | Almanac listing, mailbox | FET/USDC (vague) |
| Kite | Yes (human master account; agents get sessions) | passport session | USDC/PYUSD/USD1 |
| Coinbase Agentic Wallets / AWS AgentCore | Yes (CDP / AWS account) | wallet, budgets | x402/MPP |
| Stripe MPP | Yes (Stripe account / human payment method) | SPT | cards, stablecoins, BNPL, Lightning |
| Nevermined / Skyfire / Payman | Yes (signup, some KYC) | metering, KYA, policies | fiat + USDC |
| MCP registries / ClawHub / plugin dirs | Yes (GitHub/DNS namespace, forms) | listing | none |
| Vendor stores | Yes (partner programs, admins) | listing | vendor billing |

---

## 4. Gap analysis — what a truly agent-native platform must do that nobody does

1. **Unauthenticated self-registration + progressive trust.** Only ATXP does self-registration; nobody combines it with a marketplace. Human "claim" should be optional and additive (unlocks fiat/KYC rails and higher limits), never a prerequisite — the inverse of Moltbook.
2. **Multi-rail wallet as one account object.** Speak x402 *and* MPP on both buy and sell side; hold USDC (Base/Solana), a card/fiat balance via Stripe for claimed agents, plus internal credits for sub-cent settlement (Olas's $109k over 14.6M txs shows on-chain per-call settlement is uneconomic; net internally, settle on-chain in batches like ATXP "batch payments").
3. **Escrowed job lifecycle with evaluator agents (ERC-8183 shape) off-chain by default.** Virtuals/Olas force everything on-chain; enterprises' stores have no agent-side buying at all.
4. **Reputation grounded in paid, evaluated jobs.** ERC-8004 proves ungrounded feedback is worthless. Every rating must reference an escrow receipt; export to ERC-8004 with `proofOfPayment`.
5. **Economic sybil resistance instead of tweets/emails.** Deposits, stake-weighted limits, funding-provenance clustering (the 8004 study's method), velocity limits keyed to paid history.
6. **Machine-first discovery surfaces.** `llms.txt`, `skill.md`, `/.well-known/agent-card.json`, `/.well-known/x402.json`, MCP `server.json`, ARD endpoint, Bazaar-indexable x402 endpoints — one object, many views. Agentic.Market's "no registration, no API keys" is the bar.
7. **Messaging that works for cron-style agents.** Claude Code / OpenClaw agents are not always online: mailbox/long-poll + webhooks + email identity (Agentverse mailbox + ATXP email + primitive's thesis).
8. **Honest metrics.** Publish paid completed jobs, unique paying clients, GMV, dispute rate — not registrations.

---

## 5. Non-obvious insights

1. **Registration counts are worthless as traction; paid completed jobs are the only signal.** Moltbook 2.9M registered / 207k verified / ~17k humans; ERC-8004 173k registrations with 3–15% functional; Agentverse 2.7M mostly hosted templates; RentAHuman 600k workers vs 5.5k jobs; Olas 14.6M a2a txs for $109k.
2. **`skill.md` + `npx … register` is the de-facto onboarding standard for agent-native products** (Moltbook skill.md, ATXP skill + CLI, Virtuals openclaw-acp skill, Agentic.Market llms.txt, Humwork/RentAHuman MCP). Discovery happens through agent-readable docs that agents fetch at runtime, not through app stores.
3. **Human verification is the industry's anti-sybil crutch** (tweets, emails, GitHub account age, DNS namespaces, partner programs). Removing it without an economic substitute reproduces Moltbook's slop and ERC-8004's $0.003 fake reputation.
4. **Rails have converged on HTTP 402 and open governance** (x402 → Linux Foundation, MPP open standard, AWS AgentCore supports both, Coinbase and Stripe/Privy wallets). Building a new rail is wasted effort; being the *account + facilitator* that speaks all of them is the opportunity.
5. **Take-rate room exists**: Olas 15%, Nevermined 1–2% (+2% routing), Virtuals token taxes, Stripe-style 2–3%. A 2–5% escrow fee on agent-to-agent jobs is competitive.
6. **Crypto-native agent economies drift into token launches** (Virtuals, Fetch.ai Agent Launch, Moltbook memecoins) because that is where their revenue is; service revenue is small and declining (Virtuals peak $3.9M/mo Jan 2025). A service-revenue-first platform is differentiated.
7. **Meta buying Moltbook and "Sign in with Moltbook" signal that agent identity is the strategic wedge.** Do not compete on identity alone; be the place identities *do* things, and accept external identities (Moltbook, ERC-8004, DIDs, Kite passports, KYA).
8. **Enterprise stores are admin-gated by design (compliance), so early customers for a zero-human platform are indie/OpenClaw/Claude Code agents and crypto-native agents**, not enterprises. That audience already uses x402 (22k sellers/94k buyers in 30 days).
9. **The evaluator is the product.** ERC-8183 discussion (multi-model evaluator consensus, reputation gating) and Virtuals' evaluator role show that trust in agent-to-agent work reduces to who attests completion. Owning evaluator quality is the moat; escrow and rails are commodities.
10. **Distribution is available for free through existing indexes**: x402 Bazaar is surfaced inside AWS AgentCore Gateway (10,000+ endpoints), Agentic.Market, Google Marketplace ingests A2A Agent Cards automatically, GitHub agent finder pulls from any ARD registry. Emitting the right manifests puts our providers in front of every major agent runtime.

---

## 6. Recommendations

1. **Onboarding**: `POST /v1/agents` (no auth) → `agent_id`, API key, inbox address, wallets (Base USDC, Solana USDC, internal credits), small starter credit; publish `/skill.md`, `/llms.txt`, an MCP server, an OpenAPI spec, and a SKILL.md installable via `npx skills add`. Optional `claim_url` for a human to add fiat/KYC and raise limits (Moltbook's pattern, made optional).
2. **Rails**: implement x402 (buyer + seller, act as or use a facilitator) and MPP; Stripe for claimed agents; wallet adapters for Coinbase CDP, Privy, ATXP; internal netting with periodic on-chain settlement and batch payouts.
3. **Marketplace**: ERC-8183-shaped jobs (fund → submit → evaluate → settle) off-chain with optional on-chain anchoring; evaluators as first-class, paid agents with multi-model consensus; disputes with stake.
4. **Reputation**: every score references an escrow receipt; export to ERC-8004 with `proofOfPayment`; ingest external signals (Recall Rank, Bazaar 30-day payer counts, Skyfire KYA) as secondary.
5. **Sybil/abuse without humans**: refundable registration deposit or earned limits; funding-provenance clustering; per-agent velocity and spend caps; signed manifests and behavioral scanning for anything installable (ClawHavoc lesson).
6. **Discovery**: intent/semantic search API ranked by grounded metrics; expose ARD, MCP registry OpenAPI (sub-registry), A2A Agent Cards, `/.well-known/x402.json`, and opt providers into Bazaar indexing.
7. **Messaging**: mailbox + long-poll + webhooks + email identity; A2A task-message compatibility; treat cron-style agents as first-class.
8. **Supply bootstrap**: mirror Agentic.Market's 2,657 x402 services and Bazaar endpoints as "external providers" on day one; run bounties for OpenClaw/Claude Code agents to list services.
9. **Positioning vs ATXP**: ATXP = bank account + tools; we = economy where agents sell to agents. Integrate ATXP as a rail now; expect them to add a marketplace.
10. **Compliance**: unclaimed agents stay crypto-only with caps; fiat and withdrawals require a claimed human/entity (KYC) — mirrors how every fiat player (Stripe, Payman, Skyfire, Nevermined) is human-anchored.
11. **Metrics**: publicly report paid completed jobs, unique paying clients, GMV, dispute rate.

---

## 7. Open questions

- Virtuals ACP: actual take rate on jobs; can `acp setup` run fully headless?
- Agentverse: can API keys be minted programmatically without a human web account?
- ATXP: fees, withdrawal/KYC policy for unowned agents, plans for a third-party tool catalog or agent-to-agent market.
- x402: how much of the 75M/30-day volume is organic (CoinDesk "mirage" claim)?
- agent.ai: confirm shutdown/absorption into HubSpot (observed 308 → builderpack.com).
- ClawHub: true skill count (homepage ~30 featured vs third-party "60K+").
- Meta's roadmap for Moltbook identity ("Sign in with Moltbook").
- Smithery/Arcade.dev acquisition terms; Payman/Skyfire/Nevermined funding.
- Regulatory: can an unowned agent legally hold fiat balances anywhere? (Likely no → crypto-only until claimed.)
- primitive (YC S26): what exactly they ship for agent-to-agent communication.

---

## 8. All URLs used

Moltbook: https://arxiv.org/html/2602.10127v1 · https://en.wikipedia.org/wiki/Moltbook · https://www.moltbook.com/skill.md · https://www.moltbook.com/ · https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network · https://www.cnbc.com/2026/02/02/social-media-for-ai-agents-moltbook.html · https://www.cnbc.com/2026/03/10/meta-social-networks-ai-agents-moltbook-acquisition.html · https://www.forbes.com/sites/guneyyildiz/2026/01/31/inside-moltbook-the-social-network-where-14-million-ai-agents-talk-and-humans-just-watch/ · https://tagteam.harvard.edu/hub_feeds/4166/feed_items/17226540 · https://fortune.com/2026/03/11/meta-acquires-motlbook-social-network-for-agents · https://beam.ai/agentic-insights/meta-just-bought-a-social-network-for-ai-agents-heres-what-it-tells-us-about-the-agent-internet

Virtuals: https://whitepaper.virtuals.io/about-virtuals/commerce-layer · https://whitepaper.virtuals.io/acp/acp-changelogs · https://whitepaper.virtuals.io/acp/acp-glossary · https://whitepaper.virtuals.io/acp · https://www.prnewswire.com/news-releases/virtuals-protocol-launches-first-revenue-network-to-expand-agent-to-agent-ai-commerce-at-internet-scale-302686821.html · https://agdp.io/ · https://github.com/Virtual-Protocol/openclaw-acp · https://www.rockawayx.com/insights/virtuals-agent-commerce-protocol-in-public-beta · https://www.datawallet.com/crypto/what-is-virtuals-protocol · https://messari.io/report/understanding-virtuals-protocol-a-comprehensive-overview · https://www.virtuals.io/

Olas: https://olas.network/ · https://olas.network/mech-marketplace · https://olas.network/blog/q2-2026 · https://github.com/valory-xyz/autonolas-marketplace/ · https://build.olas.network/monetize · https://build.olas.network/hire · https://x.com/autonolas/status/2019752385959415861 · https://x.com/autonolas/status/1975501494964396541

Fetch.ai / ASI: https://docs.agentverse.ai/documentation/getting-started/agentverse-marketplace · https://docs.agentverse.ai/ · https://docs.agentverse.ai/documentation/launch-agents/agentverse-sdk/overview · https://cryptobriefing.com/fetch-ai-agentic-infrastructure-agentverse/ · https://pluang.com/en/news-feed/fetch-ai-luncurkan-pasar-agent-pertama-dunia-dengan-3-juta-agent · https://www.progressiverobot.com/2026/04/14/what-is-agentverse/

SingularityNET: https://dev.singularitynet.io/docs/products/AIMarketplace/ · https://marketplace.singularitynet.io/ · https://singularitynet.io/

Recall: https://recall.network/ · https://docs.recall.network/ · https://docs.recall.network/competitions/register-agent · https://messari.io/project/recall-network · https://coinmarketcap.com/cmc-ai/recall-network/what-is/

Theoriq: https://www.theoriq.ai/ · https://www.theoriq.ai/blog/beyond-swarms

Bittensor (secondary): https://www.coingecko.com/learn/top-bittensor-subnets-dtao · https://www.dextools.io/tutorials/what-is-bittensor-subnets-dtao-alpha-tokens-explained-guide-2026 · https://avark.agency/learn/how-to-build-on-bittensor-in-2026-the-complete-guide-to-launching-on-the-decentralized-ai-network · https://taostats.io/

Kite: https://gokite.ai/ · https://docs.gokite.ai/ · https://www.theblock.co/press-releases/399534/kite-launches-kite-chain-and-kite-agent-passport-enabling-autonomous-ai-agent-payments · https://messari.io/report/kite-the-payment-layer-for-the-agentic-economy

x402 / Coinbase / AWS: https://www.x402.org/ · https://github.com/coinbase/x402 · https://docs.cdp.coinbase.com/x402/bazaar · https://agentic.market/ · https://cryptobriefing.com/agentic-market-ai-agents-hub/ · https://www.pymnts.com/cryptocurrency/2026/coinbase-debuts-crypto-wallet-infrastructure-for-ai-agents/ · https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets (403) · https://www.coinbase.com/en-ca/developer-platform/discover/launches/x402-bazaar (403) · https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html · https://www.rzlt.io/blog/agentic-payments-2026-x402-explainer · https://atxp.ai/blog/agent-payment-protocols-compared/ · https://www.agentic-swarm-marketplace.com/

Stripe / protocols: https://stripe.com/blog/machine-payments-protocol · https://docs.stripe.com/payments/machine/mpp · https://www.pymnts.com/visa/2026/visa-scales-agentic-commerce-through-stripe-protocol-collaboration/ · https://developers.openai.com/apps-sdk/build/monetization · https://www.inriver.com/resources/ap2-mpp-x402-payment-protocols-agent-commerce/

Nevermined / Payman / Skyfire / ATXP / Allowance: https://nevermined.ai/ · https://nevermined.ai/blog/agent-to-agent-payment-statistics · https://paymanai.com/ · https://tracxn.com/d/companies/payman-ai/__NSTYOZtZdNiGZxC0Vkul0dzUfj3ZUgPqDRNO08pHBUE · https://skyfire.xyz/product/ · https://docs.skyfire.xyz/ · https://docs.skyfire.xyz/llms.txt · https://stellagent.ai/insights/skyfire-kyapay-know-your-agent · https://atxp.ai/ · https://docs.atxp.ai/ · https://docs.atxp.ai/llms.txt · https://docs.atxp.ai/agents · https://docs.atxp.ai/agents/skill · https://docs.atxp.ai/developers/monetize · https://www.ycombinator.com/companies/allowance

Standards: https://eips.ethereum.org/EIPS/eip-8004 · https://arxiv.org/html/2606.26028 · https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902 · https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/ · https://github.com/projnanda · https://arxiv.org/pdf/2505.10609 · https://arxiv.org/pdf/2508.03113 · https://thenewstack.io/how-mits-project-nanda-aims-to-decentralize-ai-agents/ · https://agntcy.org/ · https://github.blog/changelog/2026-06-17-agent-finder-for-github-copilot-now-available/ · https://modelcontextprotocol.io/registry/about · https://registry.modelcontextprotocol.io/ · https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/

Registries / tools: https://github.com/openclaw/clawhub · https://docs.openclaw.ai/clawhub · https://clawhub.com/ (→ clawhub.ai) · https://clawhub.ai/ · https://clawplaza.com/ · https://www.datacamp.com/blog/best-clawhub-skills · https://clawoneclick.com/blog/clawhub-top-skills-2026 · https://glama.ai/mcp/servers · https://www.pulsemcp.com/servers · https://smithery.ai/ · https://www.arcade.dev/ · https://github.com/mcp · https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/ · https://composio.dev/pricing · https://tracxn.com/d/companies/composio/__S4CqdyIkWZd1BSTOwnjS82Hz0ppMkmDoAP_j4_oMBfk · https://toolhouse.ai/ · https://github.com/anthropics/claude-plugins-official · https://code.claude.com/docs/en/discover-plugins

Vendor stores: https://www.salesforce.com/agentforce/agentexchange/ · https://www.cxtoday.com/crm/salesforce-agentexchange-ai-marketplace-agentic-cx/ · https://www.salesforceben.com/appexchange-slack-marketplace-and-the-agentforce-ecosystem-are-now-one-with-fresh-50m-funding/ · https://cloud.google.com/blog/topics/partners/google-cloud-ai-agent-marketplace · https://cloud.google.com/blog/products/ai-machine-learning/partner-built-agents-available-in-gemini-enterprise · https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-marketplace-agents · https://devblogs.microsoft.com/microsoft365dev/introducing-the-agent-store-build-publish-and-discover-agents-in-microsoft-365-copilot/ · https://aws.amazon.com/about-aws/whats-new/2025/07/ai-agents-tools-aws-marketplace · https://www.pymnts.com/artificial-intelligence-2/2025/aws-unveils-ai-agent-marketplace-as-one-stop-shop-for-enterprise-deployment/ · https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/ · https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches

agent.ai / Agentbase: https://agent.ai/ (308 → https://builderpack.com/) · https://agent.ai/agents (308) · https://www.agent.ai/ (403) · https://builderpack.com/ · https://www.bostonglobe.com/2025/01/31/business/hubspot-dharmesh-shah-ai-artificial-intelligence-agents/ · https://www.demandbase.com/products/agentbase-ai-agents/ · https://www.agentbase.sh/ · https://aiagentbase.app/

YC S26: https://startground.com/y-combinator-spring-2026-startups/ · https://www.ycombinator.com/companies/rentahuman · https://builtin.com/articles/what-is-rentahuman · https://www.ycombinator.com/companies/humwork · https://www.ycombinator.com/companies/primitive · https://www.ycombinator.com/companies/clawvisor · https://www.ycombinator.com/companies/agentphone · https://www.ycombinator.com/companies/klaimee · https://www.ycombinator.com/companies/allowance

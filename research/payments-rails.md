# Payment Rails and Protocols for AI Agents — research notes (as of 2026-09-05)

Slug: `payments-rails`
Context: API-first "small world for AI agents" platform (identity, wallets, marketplace, messaging, reputation), optimized for fully autonomous LLM agents (Claude Code, OpenClaw, LangGraph/CrewAI, scripts) with zero humans in the loop.

Method: ~45 web searches + ~70 primary-source fetches (official docs, GitHub READMEs, launch posts, press releases). Search budget was exhausted mid-way; remaining verification was done by direct fetches of known URLs. Items marked **[unverified]** could not be confirmed against a primary source; items marked **[secondary]** rest on reputable secondary coverage only. All dates are as stated in the sources.

---

## 0. Executive summary

1. **HTTP 402 has won the wire format.** Two overlapping open protocols dominate machine-to-machine payments: **x402** (Coinbase/Cloudflare, now a Linux Foundation "x402 Foundation" with ~40 members incl. Visa, Mastercard, Stripe, Google, AWS, Circle) and **MPP — Machine Payments Protocol** (Stripe + Tempo, Mar 2026, multi-method: Tempo/Solana/EVM/Stellar stablecoins, Lightning, Stripe card tokens). L402 (Lightning Labs) is the Bitcoin-native sibling. Everything else (AP2, ACP, UCP, Visa TAP, Mastercard Agent Pay, PayPal) is a *human-consumer* authorization layer that assumes a human's card/wallet exists somewhere.
2. **Only stablecoin rails allow true zero-human onboarding.** Every fiat/card rail (Stripe SPT/Link, Visa Intelligent Commerce, Mastercard Agent Pay, AP2, PayPal) requires a human account/cardholder to enroll and delegate. Even Coinbase "Agentic Wallets" require an email OTP. Headless wallet issuance exists via **CDP Server Wallets (API keys)**, **Circle Agent Wallets (non-interactive auth)**, **Privy/Turnkey server wallets**, **Crossmint API wallets**, or a raw keypair — which means *our platform must issue the wallet at agent registration*.
3. **Escrow is the gap.** x402 and MPP are irreversible push payments. Escrow/refund/dispute primitives exist only as niche add-ons (x402r, Base `commerce-payments` authorize/capture/refund, Locus deadline sub-wallets, MPP session deposits). A platform-level escrow + arbitration + refund layer is a real differentiator for an agent-to-agent marketplace.
4. **Sub-cent economics need batching or a ledger.** Practical x402 floor is ~$0.01/tx on-chain (CDP facilitator $0.001/tx after 1,000 free/month + gas). Circle Nanopayments (Gateway, batched EIP-3009, min $0.000001, gas-free), MPP "session" intents (deposit + signed vouchers), and an internal credits ledger all solve this.
5. **Reputation without payment proof is being gamed.** The ERC-8004 empirical study (Jul 2026) found 59–91% of reviewers are Sybil-like and 98.7–100% of feedback carries no proof of interaction. Reputation must be anchored to settled payments (tx hash / receipt).

Recommended multi-rail order: **(1) x402 exact/USDC on Base + Solana with platform-issued CDP or Circle wallets and an internal credits ledger; (2) MPP alongside x402 on the same endpoints (sessions for metered services, SPT for card-backed agents); (3) Stripe as fiat MoR + payouts; (4) escrow via internal ledger holds, with on-chain `commerce-payments`/x402r for large tickets; (5) later: L402/Lightning via MPP method, AP2/Visa/Mastercard as "card-funded agent" adapters, Skyfire KYA tokens for enterprise buyers.**

---

## 1. Settlement-layer protocols (HTTP 402 family)

### 1.1 x402 (Coinbase → x402 Foundation / Linux Foundation) — VERIFIED

- **What:** Open protocol reviving HTTP 402. Server returns `402` with a `PAYMENT-REQUIRED` header (base64 JSON), client retries with `PAYMENT-SIGNATURE` (signed EIP-3009 `transferWithAuthorization` for USDC on EVM; SPL on Solana), server (or a *facilitator*) verifies + settles and returns `PAYMENT-RESPONSE`. v2 uses these three headers and CAIP-2 network ids (`eip155:8453`), replacing v1 `X-PAYMENT` conventions. Only the `exact` scheme ships; `upto`, `deferred` (Cloudflare proposal: HTTP Message Signatures, settle later in batch/daily by card/bank) and `session` are proposed. (GitHub README; Cloudflare blog Sep 23 2025; Stripe x402 doc shows `x402Version: 2` payload and `eip155:8453`.)
- **Governance / dates:** Coinbase + Cloudflare announced the x402 Foundation on 2025-09-23. Formalized under the Linux Foundation (announced Apr 2026) and operationally launched 2026-07-14 with ~40 members; 17 premier/board members: Adyen, AWS, American Express, Circle, Cloudflare, Coinbase, Fiserv, Google, Mastercard, Monad Foundation, MoonPay, Ripple, Shopify, Solana Foundation, Stellar Development Foundation, Stripe, Visa. Board chair Alin Dragos (AWS). Apache 2.0. **[secondary: TFTC/Zylos; Anthropic and Vercel are NOT confirmed members despite some blogs claiming so]**
- **Traction:** Coinbase disclosed 69,000 active agents, 165M transactions, ~$50M cumulative volume by late April 2026 **[secondary]**; CDP docs say "more than 100 million x402 payments" on Base + Solana (verified on docs.cdp.coinbase.com). Solana page: 35M+ tx, $10M+ volume, 400 ms finality, $0.00025/tx (undated). Circle: "99.8% of agent transaction volume on x402 is USDC".
- **Fees:** Protocol fee 0. CDP facilitator: free first 1,000 tx/month, then $0.001/tx; verification free; batch settlement on EVM spreads the fee **[secondary: wavect + eco citing CDP docs; older x402 GitBook FAQ still says "zero facilitator fee"]**. thirdweb facilitator 0.3%; PayAI facilitator $0.001/tx after 1,000 free **[secondary]**. Nevermined facilitator 1–2% (verified on nevermined.ai). Stripe as seller-side processor: 1.5% per successful charge, USDC on Base, preview **[secondary: The Block, wavect]**.
- **Chains:** CDP facilitator: Base, Polygon, Arbitrum, World (EVM) + Solana; Stellar facilitator (OpenZeppelin Relayer; USDC/PYUSD/USDY native; ~$0.00001 fee; <5 s); Monad via MPP. Token: any EIP-3009 token on Base; any SPL/Token-2022 on Solana.
- **How an agent gets a wallet without a human:**
  - *CDP Server Wallet* — `CdpX402Client` provisions a managed wallet from env vars `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`; no private key storage; testnet USDC faucet via `cdp.evm.requestFaucet(...)`. Fully headless once a developer has CDP API keys (developer KYB/ToS is on the human developer, not the agent).
  - *Coinbase Agentic Wallet* (`npx awal`) — requires email OTP → human in loop at creation.
  - *Raw key* — OpenClaw x402 skill (`EVM_PRIVATE_KEY`), second-state `payment-skill` (`create-wallet` → keystore JSON). Zero-human but the agent must be funded by someone.
- **KYC:** Protocol neutral; facilitators may add KYT/KYC (CDP facilitator includes KYT screening; Circle screens sanctions). No on-protocol KYC for buyers.
- **Settlement:** Base ~2 s, Solana ~400 ms, Stellar <5 s; synchronous within the HTTP request.
- **Escrow/refunds:** None natively ("irreversible push payments"; FAQ suggests business-logic refunds via new transfers; future HTLC/hold-invoice ideas). Add-ons: **x402r** (BackTrackCo, beta, Base/Base Sepolia, auth-capture escrow, configurable refund windows, pluggable arbiter: automated / AI / human / custom; fees set by operator contracts). **Base `commerce-payments`** (MIT, v1.1.0, Base mainnet + Sepolia, audits through Jul 2026): `authorize, capture, charge, void, reclaim, refund`; permissionless "operator" role; token collectors for ERC-3009 / Permit2 / allowance / spend permissions; configurable fee rates — powers Shopify USDC checkout.
- **Discovery:** **x402 Bazaar** — public catalog discovered by the CDP facilitator; no API key needed; TypeScript SDK (`searchX402Resources`, `listX402DiscoveryResources`, `listX402DiscoveryMerchant`), REST, and a Bazaar MCP; includes 30-day call count + unique payer count. OpenClaw skill merges CDP + PayAI Bazaars.
- **Integrations verified:** Cloudflare Agents SDK + MCP (`withX402Client`), Cloudflare Monetization Gateway (2026-07-01, waitlist), Cloudflare Wallets (2026-08-04), AWS Bedrock AgentCore Payments (preview 2026-05-07; CDP or Stripe/Privy wallets; x402 only), Stripe (x402 Base USDC → Stripe PaymentIntent `transaction_verification` mode), Circle Nanopayments (x402 v2 compatible), Locus (via `facilitator.payai.network`, Polygon + Base).
- **DX:** Seller: `paymentMiddleware({...accepts:[{scheme:"exact", price:"$0.01", network:"eip155:8453", payTo}]})` (Hono/Express/Fastify/Next). Buyer: `wrapFetchWithPayment(fetch, client)` — one call. Python (`x402`, `x402HttpxClient`), Go available.
- URLs: https://github.com/coinbase/x402 · https://docs.cdp.coinbase.com/x402/welcome · https://docs.cdp.coinbase.com/x402/quickstart-for-buyers · https://docs.cdp.coinbase.com/x402/bazaar · https://x402.gitbook.io/x402/faq · https://blog.cloudflare.com/x402/ · https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation · https://www.tftc.io/x402-foundation-operational-launch-ai-agent-payments · https://wavect.io/blog/x402-payments-comparison-2026/ · https://solana.com/x402/what-is-x402 · https://stellar.org/blog/foundation-news/x402-on-stellar · https://docs.x402r.org/ · https://www.x402r.org/ · https://github.com/base/commerce-payments · https://blockeden.xyz/blog/2026/03/05/x402-foundation-ai-payment-internet/ · https://www.coindesk.com/tech/2026/05/05/ai-agents-are-breaking-web-economics-but-cloudflare-says-x402-can-help (403 on fetch) · https://eco.com/support/en/articles/14839402-x402-protocol-explained · https://www.coinbase.com/developer-platform/discover/launches/x402facilitator-polygon (403)

### 1.2 MPP — Machine Payments Protocol (Stripe + Tempo) — VERIFIED

- **What/date:** Announced 2026-03-18 with Tempo mainnet. "Open standard for machine-to-machine payments via HTTP 402." Challenge–Credential model; transports: HTTP headers (primary), MCP/JSON-RPC, WebSocket. Receipts in `Payment-Receipt` header.
- **Intents:** `charge` (one-shot), `session` (deposit + client sends signed usage updates/vouchers; server settles accepted usage per method — "OAuth for money"), `subscription` (recurring).
- **Methods:** Tempo TIP-20 stablecoins, Stripe Shared Payment Tokens (cards, BNPL), Lightning (Lightspark), EVM stablecoins, Solana SPL, Stellar SEP-41, Monad ERC-20, NEAR Intents (cross-chain), RedotPay, custom.
- **SDKs:** `mppx` in TypeScript, Python, Rust, Go, Ruby; `npx mppx@latest validate <url>` end-to-end validator. Stripe DX: one-line for a coding agent ("Read https://docs.stripe.com/payments/machine/mpp.md ... monetize my API using MPP to charge 0.50 USD per API call").
- **Stripe seller side:** needs Stripe account + Business Profile (`profile_` id as `networkId`) → seller is KYB'd. Stablecoins: MPP on Tempo (USDC.e), MPP on Solana (USDC), x402 on Base (USDC). Minimums: 0.01 USDC stablecoin; $0.50 for SPT card payments. Availability: businesses in all US states except NY; 30+ other countries by emailing machine-payments@stripe.com. Refunds via Refunds API/Dashboard; Stripe Connect supported; settles to Stripe balance in fiat. Fee: not in docs (1.5% reported for x402 preview) **[secondary]**.
- **Buyer side (agents):** Tempo CLI — `tempo wallet login` opens a browser flow (`--no-browser` prints a URL; "if you don't have one, the flow creates it") → human-ish onboarding; `tempo wallet fund` (testnet faucet; mainnet "available funding options"; `--crypto` direct transfer; `--credits` MPP credits); `tempo request --max-spend <amt> <url>` auto-pays 402 challenges; "access keys" with independent spending limits; `--dry-run`, `-t` machine-readable output. Card side: `npx @stripe/link-cli` — requires a **human Link login**, US-only, human approves each purchase (Link app), one-time-use cards or SPTs.
- **Escrow/refunds:** session intents hold a deposit and settle only accepted usage (partial escrow semantics); no dispute mechanism in protocol; Stripe layer gives card-style refunds.
- **Tempo chain:** Stripe + Paradigm L1; stablecoin gas (no native token needed), sub-second finality, design partners Visa, Mastercard, Deutsche Bank, Standard Chartered, Revolut, Nubank, Shopify, OpenAI, Anthropic, Ramp, DoorDash; payments directory with 100+ services at launch.
- URLs: https://stripe.com/blog/machine-payments-protocol · https://mpp.dev · https://mpp.dev/intents/session · https://docs.stripe.com/payments/machine · https://docs.stripe.com/payments/machine/mpp · https://docs.stripe.com/payments/machine/x402 · https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens · https://link.com/agents · https://tempo.xyz/developers/docs/cli · https://tempo.xyz/developers/docs/cli/wallet · https://tempo.xyz/developers/docs/cli/request · https://github.com/stripe-samples/machine-payments · https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents · https://thedefiant.io/news/blockchains/tempo-launches-mainnet-unveils-machine-payments-protocol-with-stripe · https://fortune.com/2026/03/18/stripe-tempo-paradigm-mpp-ai-payments-protocol/ · https://stripe.com/use-cases/agentic-commerce · https://www.theblock.co/post/389352/stripe-adds-x402-integration-usdc-agent-payments

### 1.3 L402 (Lightning Labs) — VERIFIED

- **What:** 402 + `WWW-Authenticate` with macaroon + BOLT11 invoice; client pays, presents macaroon + preimage; stateless verification. Tooling: Aperture (reverse proxy, powers Lightning Loop/Pool for 5+ years), `lnget` (curl for paid APIs), Lightning Agent Tools (2026-02-11): 7 skills — run `lnd`, remote signer key isolation, bake scoped macaroons, pay L402 APIs, host paid endpoints, MCP node queries, buyer/seller orchestration. Dedicated site l402.tech launched ~2026-07-29. Formal spec published 2025.
- **Economics:** 1 sat minimum (~$0.001), settlement <1 s, no intermediary; wallet options: self-hosted `lnd` or Wavelength (self-custodial embedded, SDK/CLI/REST/gRPC/MCP).
- **Zero-human?** Protocol yes ("no accounts, no intermediaries, no humans involved"); practically the agent needs sats and inbound/outbound liquidity — the fiat→sats onramp is the friction. No KYC on-protocol. No escrow (hold invoices exist in Lightning generally, not surfaced in the agent tooling). Also available as an MPP method.
- URLs: https://github.com/lightninglabs/L402 · https://l402.tech/ · https://lightning.engineering/posts/2026-03-11-L402-for-agents/ · https://lightning.engineering/posts/2026-02-11-ln-agent-tools/ · https://thedefiant.io/news/infrastructure/lightning-labs-launches-site-for-l402-bitcoin-agent-payments

---

## 2. Authorization / mandate protocols (human-consumer commerce)

### 2.1 Google AP2 (Agent Payments Protocol) + UCP — VERIFIED

- Announced 2025-09-16 (60+ partners incl. PayPal, Mastercard, AmEx, Adyen, Worldpay, Coinbase). Apache 2.0. v0.2.0 shipped Apr 2026 adding **Human-Not-Present** flows **[secondary: TNW/eco]**. Mandate model: docs now describe *Checkout Mandate* (open/closed) and *Payment Mandate* (open/closed) as W3C Verifiable Digital Credentials; earlier framing was Intent/Cart/Payment mandates. Payment methods: cards; x402 extension (`a2a-x402`) for stablecoins; roadmap e-wallets, UPI/PIX, digital currencies. Integrates with A2A, ADK, MCP; samples in Python/Go/Android. **No mechanism for an agent to obtain credentials without a human** — the mandate is the human's delegation.
- **UCP (Universal Commerce Protocol)** announced 2026-01-11 with Shopify, Etsy, Wayfair, Target, Walmart, endorsed by 20+ (Visa, Mastercard, Stripe, AmEx, Adyen, Best Buy). `/.well-known/ucp` manifest; payment handlers (Google Pay, Shop Pay, mock); compatible with AP2; Universal Cart at I/O 2026; checkout expanding to Canada/Australia, UK later.
- Relevance: merchant/consumer shopping layer; useful only if our marketplace wants to sell to Gemini/Search agents. Not an agent-to-agent rail.
- URLs: https://ap2-protocol.org/ · https://github.com/google-agentic-commerce/AP2 · https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol · https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/ · https://thenextweb.com/news/google-universal-cart-agent-payments-shopping-io-2026 · https://eco.com/support/en/articles/15192002-ap2-protocol-explained-google-s-agentic-commerce-standard-2026 · https://codelabs.developers.google.com/next26/adk-agent-commerce

### 2.2 OpenAI ACP (Agentic Commerce Protocol) — VERIFIED (secondary for status)

- Co-developed with Stripe, Apache 2.0, 2025-09-29; Shared Payment Tokens hand a scoped token to the merchant who charges via any PSP. **Instant Checkout in ChatGPT was moved to merchant "Apps" in March 2026** (only ~a dozen Shopify merchants had shipped); spec 2026-04-17 adds cart, feed, orders, auth, MCP compatibility. PayPal joined as payment provider 2025-10-28; Stripe shipped "Agentic Commerce Suite" 2025-12-11. Human consumer flow only.
- URLs: https://www.digitalcommerce360.com/2026/03/06/openai-shifts-checkout-plans-agentic-commerce-strategy/ · https://eco.com/support/en/articles/14845478-acp-agentic-commerce-protocol-explained · https://www.digitalcommerce360.com/2026/02/16/openai-expands-agentic-commerce-push/

### 2.3 Visa Intelligent Commerce / Trusted Agent Protocol (TAP) — VERIFIED

- TAP (Oct 2025, developed with Cloudflare; feedback from Adyen, Checkout.com, Coinbase, Microsoft, Shopify, Stripe, Worldpay): RFC 9421 HTTP Message Signatures, merchant-specific, purpose-bound, time-limited; "Agent Registry" public-key registry; CDN proxy verifies signatures; agents pass hashed VIC credentials / tokens / PARs. Available to merchants and independent developers across NA, APAC, EU, CEMEA, LAC; "in development and deployment". No fees published.
- 2026-06-10 Visa Payments Forum: **Agent Score** (merchant readiness), **Agentic Directory** (verified agents ↔ merchants), OpenAI strategic collaboration, **CLI proof-of-concept for agents paying with tokenized credentials in the terminal**, stablecoin settlement ~$7B annualized run-rate (Mar 2026), 160+ stablecoin-linked card programs, tokenized-deposit plans. Requires a human cardholder to enroll; agent gets tokenized credential bounded by rules.
- URLs: https://developer.visa.com/capabilities/trusted-agent-protocol/overview · https://github.com/visa/trusted-agent-protocol · https://investor.visa.com/news/news-details/2025/Visa-Introduces-Trusted-Agent-Protocol-An-Ecosystem-Led-Framework-for-AI-Commerce/default.aspx · https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.22491.html · https://www.visa.com/en-us/solutions/intelligent-commerce

### 2.4 Mastercard Agent Pay / Agentic Tokens / "Agent Pay for Machines" — PARTLY VERIFIED

- Agent Pay announced Apr 2025; Agentic Tokens (MDES tokenization) bound to agent + merchant scope + consent policy + spend limit; issuers Citi, US Bank first; Verifiable Intent pilots from Feb 2026; first live agentic transaction in Hong Kong (2026, ride booking) — Mastercard press pages returned 403 on fetch **[secondary for details]**.
- **"Agent Pay for Machines" (2026-06-10)** — agents authorize/coordinate/settle across cards, bank accounts and stablecoins (Polygon, Solana, Base) with 30+ partners: Adyen, Checkout.com, Stripe, Global Payments, BVNK, Coinflow, Coinbase, OKX, MoonPay, Polygon, Solana Foundation, Aave Labs, RippleX, Anchorage, Crossmint, Turnkey, Cloudflare, Alchemy, Nevermined. Humans grant initial permissions (logged on public chains), then no per-tx approval **[secondary: Genfinity]**.
- URLs: https://www.mastercard.com/global/en/news-and-trends/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai.html · https://genfinity.io/2026/06/10/mastercard-agent-pay-for-machines-launch/ · https://www.mastercard.com/news/ap/en-hk/newsroom/press-releases/en-hk/2026/mastercard-completes-its-first-live-agentic-transaction-in-hong-kong/ (403) · https://www.mastercard.com/global/en/news-and-trends/stories/2025/agentic-commerce-momentum.html (403) · https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026

### 2.5 PayPal Agentic Commerce Services — VERIFIED (limited)

- Launched 2025-10-28: **Agent Ready** (accept payments inside AI assistants; "early 2026"), **Store Sync** (catalog/inventory to AI surfaces; partners Wix, Cymbio, BigCommerce/Feedonomics, Shopware), merchant discoverability on Perplexity; ACP payment provider; Google Cloud partnership. Access via a merchant request form. Nothing for autonomous agent wallets; buyer = human PayPal account.
- URLs: https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services-to-Power-AI-Driven-Shopping · https://developer.paypal.com/agentic-commerce-services/about · https://docs.paypal.ai/growth/agentic-commerce/overview · https://developer.paypal.com/community/blog/enabling-agentic-payments/

---

## 3. Agent wallet & payment infrastructure

### 3.1 Coinbase Developer Platform: Agentic Wallets, AgentKit, Server Wallets — VERIFIED

- **Agentic Wallets** (launched 2026-02-11): `npx skills add coinbase/agentic-wallet-skills` → `npx awal auth login <email>` → `npx awal auth verify <flowId> <otp>` (email OTP; no CDP API key). MPC key shares in AWS Nitro Enclave; gasless on Base via paymaster (agent never holds ETH); session caps, per-token allowances, per-tx limits, allowlists, activity log; KYT screening; `npx awal x402 pay <url>`; MCP `npx @coinbase/payments-mcp` (discover + pay only). Networks: Base, Base Sepolia, Solana, Solana Devnet, Polygon. Fees/onramp not documented; KYC beyond email not documented.
- **CDP Server Wallets** (headless): API-key provisioned, used by `CdpX402Client`; recommended buyer path; Base Sepolia faucet.
- **AgentKit** (Apache-2.0, 1.3k stars): wallet providers CDP, Privy, Viem (+Solana); frameworks LangChain, Vercel AI SDK, MCP, OpenAI Agents SDK, Strands; 50+ TS / 30+ Py actions; needs CDP Secret API key.
- URLs: https://docs.cdp.coinbase.com/agentic-wallet/welcome · https://docs.cdp.coinbase.com/agentic-wallet/quickstart · https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained · https://www.pymnts.com/cryptocurrency/2026/coinbase-debuts-crypto-wallet-infrastructure-for-ai-agents/ · https://github.com/coinbase/agentkit · https://docs.cdp.coinbase.com/agent-kit/core-concepts/wallet-management · https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets (403) · https://www.coinbase.com/developer-platform/products/agentic-wallets (403)

### 3.2 Circle Agent Stack (CLI, Agent Wallets, Nanopayments, Marketplace) — VERIFIED

- Announced 2026-05-11, live at agents.circle.com. Setup: `curl -sL https://agents.circle.com/skills/setup.md`; **non-interactive authentication flow for scripts/agents** (email verification "may occur"). Agent Wallets: 2-of-2 MPC, user-controlled custody ("Circle cannot unilaterally move funds"), policies (transfer limits, daily/monthly USDC caps, recipient allowlists, contract blocklists; apply to x402 payments), sanctions screening on every transfer, gas sponsored (capped), assets USDC/EURC/ERC-20/native, multichain + bridging.
- **Nanopayments via Circle Gateway:** signed EIP-3009 messages validated off-chain against a unified balance, batched on-chain "periodically throughout the day"; min $0.000001, max $1,000,000; gas-free; USDC only; x402 v2 compatible; no Circle account needed for Gateway; non-custodial.
- **Agent Marketplace:** curated, compliance-first catalog of USDC-priced services; Discovery API; "Become a Seller"/"Get Listed".
- URLs: https://www.circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy · https://www.circle.com/nanopayments · https://www.circle.com/agent-stack · https://agents.circle.com · https://developers.circle.com/agent-stack/ · https://developers.circle.com/agent-stack/agent-wallets · https://developers.circle.com/agent-stack/agent-nanopayments.md · https://developers.circle.com/agent-stack/agent-marketplace/discovery-api.md · https://www.crowdfundinsider.com/2026/05/276951-circle-launches-nanopayments-on-mainnet-enabling-usdc-micro-transactions-for-agentic-economy/

### 3.3 Cloudflare: Agents SDK x402, Monetization Gateway, Cloudflare Wallets — VERIFIED

- 2025-09-23: x402 in Agents SDK + MCP (`withX402Client`), Pay-per-crawl deferred settlement (daily card/bank charge).
- **Monetization Gateway (2026-07-01, waitlist):** charge for any Cloudflare-protected page/API/dataset/MCP tool via rules ($0.01/request etc.), x402 settlement in stablecoins (Open USD, USDC), peer-to-peer buyer→seller, fiat redemption to bank; fees undisclosed.
- **Cloudflare Wallets (2026-08-04, "coming soon"):** Virtual Wallets for agents created via API keys; human-readable handles at `*.cloudflare.pay`; allowances, allowlists, max tx size, weekly budgets; onramp/offramp in supported geographies; stablecoin self-funding for eligible users. Custody/KYC/fees not disclosed. "NET Dollar" stablecoin **[unverified — could not fetch]**.
- URLs: https://blog.cloudflare.com/x402/ · https://blog.cloudflare.com/tag/x402/ · https://blog.cloudflare.com/monetization-gateway/ · https://blog.cloudflare.com/wallets/

### 3.4 AWS Bedrock AgentCore Payments + OpenClaw plugin — VERIFIED

- Preview 2026-05-07 (us-east-1, us-west-2, eu-central-1, ap-southeast-2). Buyer-side orchestration of x402: connect a Coinbase CDP or Stripe/Privy wallet as a "payment connection", session spending limits enforced at infrastructure layer, audit via CloudWatch. x402 only; pricing not disclosed.
- **OpenClaw** (2026-08-17 AWS blog): `openclaw plugins install clawhub:@aws/aws-agents-pay`; human provisions wallet credentials via AgentCore Identity and creates a bounded payment session; runtime gets only `get_payment_session_status` / `get_paid_content`; policy = approved recipients (independently verified), network + asset contract, per-payment ceiling, cumulative budget + expiry; validates 402 challenge origin/path; responses ≤10 KiB marked `untrusted`; OpenClaw ≥2026.3.24; x402 v2 endpoints.
- URLs: https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-payments-preview/ · https://aws.amazon.com/blogs/machine-learning/build-openclaw-agents-that-transact-with-amazon-bedrock-agentcore-payments/ · https://www.coinbase.com/blog/introducing-amazon-bedrock-agentcore-payments-powered-by-x402-and-coinbase (403) · https://github.com/aws-samples/sample-agentcore-cloudfront-x402-payments · https://aws.amazon.com/blogs/industries/x402-and-agentic-commerce-redefining-autonomous-payments-in-financial-services/

### 3.5 Skyfire (KYA / KYAPay) — VERIFIED (fees not public)

- "Skyfire accounts are created by a human" (magic-link signup), one buyer agent auto-provisioned and **pre-funded**; API key in `skyfire-api-key` header ("anyone with the key can create and authorize payments"). Tokens `kya`, `pay`, `kya+pay` (JWT, JWKS-verified) scoped to seller/amount/timeframe like a prepaid debit card; expiry 10 s–24 h; seller has 24 h grace to charge; settlement within 3 h after → worst case ~51 h; charges >$1 settle sooner. Funding: card (instant, all users), USDC on Base (near-zero cost), ACH/wire (paid subscription, 1–3 days). Balance is **USD only** (USDC converts to USD). Fees: not published. KYA tokens recognized by bot managers (Akamai, F5, DataDome, HUMAN, Imperva, Fastly…); F5 partnership; KYAPay open protocol + Agent Checkout (Jun 2025); VIC purchase demo (Dec 2025). Settlement to sellers: built-in wallet, no bank account required.
- URLs: https://skyfire.xyz/ · https://skyfire.xyz/product/ · https://docs.skyfire.xyz · https://docs.skyfire.xyz/docs/buyer-guide · https://docs.skyfire.xyz/docs/wallet-funding.md · https://docs.skyfire.xyz/reference/settlement-of-payments.md · https://www.businesswire.com/news/home/20251218520399/en/Skyfire-Demonstrates-Secure-Agentic-Commerce-Purchase-Using-the-KYAPay-Protocol-and-Visa-Intelligent-Commerce · https://www.f5.com/company/news/press-releases/f5-skyfire-secure-agentic-commerce · https://www.businesswire.com/news/home/20250626772489/en/Skyfire-Launches-Open-KYAPay-Protocol-With-Agent-Checkout

### 3.6 Payman — PARTLY VERIFIED (docs unreachable, HTTP 526)

- Agent → human payouts under human-controlled policies. Wallet types: USD (ACH, US developers only), USDC (US + international), TSD test wallet (1,000 test units). KYC with government ID for real wallets. Isolated wallet per agent, owned by the developer. Fees: percentage + flat per live tx **[secondary]**. $13.8M raised (Visa, Boost VC, Protofund); selected for ICBA ThinkTECH accelerator (2026-05-20).
- URLs: https://docs.paymanai.com/dashboard-guide/wallet (526) · https://docs.paymanai.com/ (526) · https://www.businesswire.com/news/home/20260520362081/en/Payman-AI-Selected-for-ICBA-ThinkTECH-Accelerator · https://tracxn.com/d/companies/payman-ai/__NSTYOZtZdNiGZxC0Vkul0dzUfj3ZUgPqDRNO08pHBUE · https://dupple.com/tools/payman

### 3.7 Locus (paywithlocus.com, YC F25) — VERIFIED

- ERC-4337 smart wallets on Base only; dual key (user-generated key never stored + HSM "permissioned key" revocable via `revokePermissionedKey()`); deterministic CREATE2 proxies via `LocusFactory`; gasless via own paymaster; UUPS disabled. Orchestrators programmatically create sub-agent wallets with budgets; 3-layer policy engine (per-transfer limits, agent-to-agent restrictions, time-window caps); settlement <2 s, gas <$0.01. Email-send sub-wallets with `disburseBefore` deadline (time-boxed escrow-like), 100 sub-wallet cap.
- **Locus Pro:** one prepaid balance across 58 providers / 3,813 services / 15,977 endpoints via MCP + OAuth; tiers $0 (1 client), $20/mo (3), $200/mo (unlimited); enterprise per-user balances + markup. x402 top-ups via `facilitator.payai.network` on Polygon (137) or Base (8453): $6 signup credit, $1–$100 top-up, 30-day JWT; MPP on Tempo (chain 4217). Endpoint catalog: 39 providers accountless x402, 33 also on MPP **[secondary]**. No dispute product documented.
- URLs: https://paywithlocus.com/ · https://paywithlocus.com/pricing · https://paywithlocus.com/endpoints (404 on fetch) · https://paywithlocus.com/use-cases/agent-to-agent-payments · https://docs.paywithlocus.com · https://docs.paywithlocus.com/features/wallets.md · https://docs.paywithlocus.com/build/x402.md · https://docs.paywithlocus.com/wrapped-apis/mpp.md

### 3.8 Nevermined — VERIFIED

- x402 Facilitator (2026-02-06): metering per token/call/compute, prepaid credits, outcome-based pricing, cards + crypto + stablecoins + credits in one integration, ERC-4337 smart accounts, cryptographic receipts; **1–2% per tx, no minimums/monthly fees**. Supports x402, MCP, A2A, AP2; TS + Python SDKs. **VIC + x402 (2026-04-14):** cardholder enrolls Visa card, sets budget/per-purchase/merchant/time rules, agent pays 402 challenges settled on card via merchant's existing PSP (e.g., Stripe), VGS vault. Mastercard "Agent Pay for Machines" partner.
- URLs: https://nevermined.ai/blog/the-payment-layer-ai-agents-actually-need-introducing-the-nevermined-x402-facilitator · https://thepaypers.com/payments/news/nevermined-integrates-visa-intelligent-commerce-and-x402-for-autonomous-ai-agent-payments · https://nevermined.ai/blog/nevermined-unlocks-autonomous-agent-card-payments-with-x402-opening-a-new-market-for-publishers-digital-merchants · https://nevermined.ai/blog/x402-ai-agent-billing

### 3.9 Crossmint (agent wallets, Agentic Cards, World Store, GOAT, lobster.cash) — VERIFIED (pricing partial)

- Agent wallets created by API (POST), non-custodial smart-contract wallets, on-chain policy enforcement, 40+ chains (EVM, Solana, Stellar); **Agentic Cards** (virtual cards for agents); **World Store** (1B+ SKUs from Amazon/Shopify, flights); "Credentials" for owner attributes (accredited, 18+, nationality). Stablecoin fees "as low as 0.1%". CASP-licensed across 27 EU states; free tier 1,000 monthly active wallets; KYC required (per Crossmint's own comparison page). **GOAT SDK repo is archived/read-only** (250+ actions, 40+ chains, MIT). lobster.cash: dual-rail (stablecoin + Visa/Mastercard card) built with Visa, Solana, Circle, Stytch, Basis Theory; x402 support.
- URLs: https://www.crossmint.com/learn/embedded-agent-wallets · https://www.crossmint.com/learn/agent-wallets-compared · https://github.com/goat-sdk/goat · https://www.crossmint.com/products/wallet-infrastructure

### 3.10 Privy (Stripe) and Turnkey — VERIFIED (pricing secondary)

- **Privy:** acquired by Stripe June 2025; embedded + server wallets; EOA via TEE + Shamir or ERC-4337; off-chain policy engine (limits, protocols, recipients, time windows); agentic CLI; chains EVM, Solana, Bitcoin, Stellar; free ≤499 MAU, Core $299/mo ≤2,500 MAU, usage-based above **[secondary: Openfort]**; AgentCore-supported wallet.
- **Turnkey:** TEE enclaves, sub-organizations per agent with policies enforced pre-signature; chains EVM, Solana, Bitcoin, TRON; $0.10/signature PAYG (≤1,000 wallets), $0.05 on $99/mo Pro (≤2,000 wallets), ~$0.0015 enterprise **[secondary: Openfort]**; Mastercard Agent Pay for Machines partner.
- URLs: https://www.openfort.io/blog/privy-vs-turnkey · https://www.openfort.io/blog/best-agent-wallets-for-developers · https://dcpagent.com/blog/agentic-wallets-compared · https://fast.io/resources/top-crypto-wallets-autonomous-agents/

### 3.11 Solana Agent Kit (SendAI) — VERIFIED (stats secondary)

- 60+ actions, plugin architecture (token, NFT, DeFi), LangChain/Vercel AI integrations, Python port, Claude Code skill. Solana carried ~77% of x402 tx volume in Dec 2025 **[secondary: Alchemy]**. Stripe MPP supports Solana USDC; Coinbase Agentic Wallets support Solana.
- URLs: https://github.com/sendaifun/solana-agent-kit · https://kit.sendai.fun/ · https://www.alchemy.com/blog/how-to-build-solana-ai-agents-in-2026

### 3.12 ERC-8004 Trustless Agents — VERIFIED

- EIP status **Draft** (created 2025-08-13; authors De Rossi, Crapis, Ellis, Reppel). Identity (ERC-721), Reputation, Validation registries as per-chain singletons; registration file fields incl. `services` (web, A2A, MCP, OASF, ENS, DID, email), `x402Support`, `active`, `supportedTrust`. "Payments are orthogonal"; off-chain feedback may carry `proofOfPayment` (tx hash/addresses). Mainnet from 2026-01-29 **[secondary]**.
- **Empirical study (arXiv 2606.26028v2, 2026-07-08; window 2026-01-29→05-13; ETH/BSC/Base):** 173,473 registered agents (32,343 / 90,145 / 50,985) and 155,300 feedback records; only 3% / 4% / 15% expose a valid registration file + declared service; 73.5% / 59.2% / 90.6% of reviewers show Sybil-style shared funding; after filtering, 15.8% / 77.9% / 86.8% of rated agents have no valid reputation left; manipulation costs $0.055 / $0.0042 / $0.0027 per feedback; 98.7–100% of feedback has no proof of interaction; only 6.2% of Base reviewers have any x402 payment history; Validation Registry undeployed during the window.
- URLs: https://eips.ethereum.org/EIPS/eip-8004 · https://arxiv.org/html/2606.26028 · https://github.com/sudeepb02/awesome-erc8004 · https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/

### 3.13 Catena Labs — Agent Commerce Kit (ACK) — VERIFIED

- ACK (MIT, TypeScript; `ack` repo active 2026-09-03, 156 stars): **ACK-ID** (W3C DIDs + Verifiable Credentials, ownership chains, KYC/KYB-ready) and **ACK-Pay** (standardized payment requests, flexible settlement, receipts as VCs, human oversight hooks). Demo: paywalled MCP server with Claude paying on Solana **[secondary]**. Catena: $18M seed (a16z crypto, May 2025); **$30M Series A 2026-05-20** (Acrew + a16z crypto; Breyer, General Catalyst, QED); OCC accepted filing for a national trust bank charter; invite-only platform where humans set guardrails (limits, recipients, holding caps); 11 employees.
- URLs: https://www.agentcommercekit.com/overview/concepts · https://github.com/agentcommercekit · https://catenalabs.com/blog/agent-commerce-kit · https://fortune.com/2026/05/20/catena-labs-series-a-sean-neville-ai-native-bank/ · https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance

### 3.14 Paid.ai — VERIFIED (not a rail)

- London; Manny Medina (Outreach founder). Results-/outcome-based billing, margin tracking and ROI proof for agent vendors (invoicing layer on top of Stripe-style processors). €10M pre-seed (Mar 2025; EQT, Sequoia, GTMFund), $21.6M seed (Sep 2025; Lightspeed), ~$33M total, >$100M valuation. Relevance: pricing-model inspiration (per-task, per-resolution), not a settlement rail.
- URLs: https://paid.ai/blog/ai-monetization · https://techcrunch.com/2025/09/28/paid-the-ai-agent-results-based-billing-startup-from-manny-medina-raises-huge-21m-seed · https://techcrunch.com/2025/03/25/outreach-founder-manny-medina-has-a-new-startup-that-helps-ai-agents-get-paid

### 3.15 Other 2026 entrants worth noting

- **AgentWallet (Payouts.com):** `POST /agents` provisions in ~412 ms a CDP-managed USDC wallet on Base (TEE keys, gas sponsored) + a real Visa/Mastercard card + MCP endpoint per agent; KYB at company tier, KYC (gov ID, liveness, sanctions, WebAuthn passkey) for the accountable human principal; x402 over EIP-3009; fees = % of payouts/card spend + wallets above included tier. https://agentwallet.ai/faq/
- **Chimoney AI agent wallets:** Interledger/Open Payments, multi-currency, automated KYC, Amazon/Shopify spend — details **[unverified]**. https://chimoney.io/products/ai-agent-wallets/
- **second-state/payment-skill:** Claude Code / OpenClaw skill: `create-wallet` (scrypt/AES keystore), `pay` ERC-20 on Base. https://github.com/second-state/payment-skill
- **OpenClaw x402 skill (coinvest518, v0.1.0):** Bazaar discovery via CDP + PayAI; `EVM_PRIVATE_KEY`; Base + Base Sepolia. https://clawhub.ai/coinvest518/openclaw-x402-skill · https://github.com/useOttoAI/openclaw-skills
- **MCP 2026-07-28 spec:** stateless requests make payment-gated MCP tools simpler (AAIF blog 2026-08-10 on the x402 gateway pattern: discover tool → 402 → wallet checks policy → retry with proof). https://aaif.io/blog/who-told-the-agent-it-could-spend
- **Stripe Agent Skills / `stripe agent setup`** — Stripe docs are now agent-first (`.md` variants, CLI docs). https://docs.stripe.com/skills.md
- **Cobo Agentic Wallet** (MPC + guardrails, 80+ chains) **[unverified]** https://agentwallet.md/
- Landscape overviews: https://zylos.ai/research/2026-07-15-agentic-commerce-payment-protocols-ai-agents/ · https://arxiv.org/pdf/2604.15367 (SoK: security of autonomous LLM agents in agentic commerce)

---

## 4. Comparison matrix (agent-centric)

| Rail / provider | Agent gets wallet with zero humans? | KYC | Fees | Settlement | Currencies | Escrow / refunds | DX |
|---|---|---|---|---|---|---|---|
| x402 (CDP facilitator) | Yes via CDP Server Wallet API keys or raw key; Agentic Wallet needs email OTP | None on protocol; KYT by facilitator | 0 protocol; CDP $0.001/tx after 1k/mo + gas | Base ~2 s, Solana ~400 ms | USDC (any EIP-3009/SPL) | None native; x402r / commerce-payments add-ons | One wrapper call each side |
| x402 via Stripe (seller) | n/a (seller needs Stripe KYB) | Seller KYB | 1.5% [secondary] | On-chain then Stripe balance (fiat) | USDC Base/Tempo/Solana | Stripe Refunds API | Middleware + PaymentIntent |
| MPP (Tempo) | Browser login flow (`--no-browser` URL) — semi-headless; access keys w/ limits | None documented buyer-side | Tempo gas in stablecoin (tiny) | Sub-second | USDC.e/TIP-20, Solana USDC, Lightning, Stellar… | Session deposits; no disputes | `mppx.charge()`; `tempo request` |
| MPP + SPT (Stripe cards) | No — human Link account, per-purchase approval (US only) | Human | Card fees | Card | Any Stripe currency | Card refunds/disputes | link-cli / MCP |
| L402 | Yes (self-hosted lnd or Wavelength) but must acquire sats | None | ~0; 1 sat min | <1 s | BTC | None (hold invoices possible) | `lnget`, Aperture |
| Circle Agent Wallets + Nanopayments | Non-interactive auth (email verification may occur) | Sanctions screening; KYC unclear | Gas sponsored (capped); Nanopayments gas-free | ms confirm, batched on-chain | USDC (EURC in wallet) | None | CLI + skills; x402 v2 |
| Coinbase Agentic Wallet | No (email OTP) | Email; KYT | Gasless on Base | ~2 s | USDC + tokens | None | `npx awal x402 pay` |
| Cloudflare Wallets | Yes via API keys (coming soon) | Undisclosed | Undisclosed | x402 | Stablecoins | None | Workers-native |
| AWS AgentCore Payments | Human provisions CDP/Privy credentials, then autonomous | Wallet-dependent | AWS + wallet | x402 | USDC | None | Managed |
| Skyfire | No (human creates account); agent gets pre-funded wallet + API key | Human account; KYA tokens | Undisclosed | Up to ~51 h to seller | USD balance (fund by card/USDC/ACH) | Token scoping; partial charges | REST + MCP |
| Payman | No (KYC w/ ID) | Yes | % + flat [secondary] | ACH days / USDC fast | USD, USDC | Human approval policies | REST |
| Locus | Sub-agent wallets programmatically after a human/org account | Undisclosed | Gasless; catalog markup | <2 s Base | USDC Base (Polygon for x402 top-up) | Deadline sub-wallets; no disputes | MCP + REST |
| Nevermined | SDK; smart accounts | Not stated | 1–2% | Immediate | Cards, crypto, credits | Credits/metering; no escrow | npm SDK |
| Crossmint | API-created wallets | KYC required (owner) | ~0.1% stablecoin; free 1k MAW | Chain-dependent | 40+ chains + cards | None documented | REST |
| Privy / Turnkey | API-created signer wallets | Not stated | Privy free ≤499 MAU; Turnkey $0.10/sig | Chain-dependent | Multi-chain | None (signing layer) | REST/SDK |
| AgentWallet (Payouts) | `POST /agents` after company KYB + principal KYC | Yes | % on volume | Base + card | USDC + Visa/MC card | Card-style | REST + MCP |
| Visa TAP/VIC, Mastercard Agent Pay, AP2, ACP, PayPal | No — human cardholder delegates | Human | Card economics | Card | Fiat | Card disputes | Consumer-checkout SDKs |

---

## 5. Recommended multi-rail strategy for our platform

### 5.1 Principle
Own the wallet at agent registration; speak HTTP 402 (x402 **and** MPP) on every priced endpoint; keep an internal credits ledger for sub-cent metering and instant escrow; settle to public stablecoin rails for deposits/withdrawals; delegate fiat to Stripe. Never require a human for crypto-funded agents; require a human only when a fiat instrument is involved (which the rails require anyway).

### 5.2 Phase 1 — zero-friction agent onboarding (weeks 0–8)
1. **Platform-issued wallet on registration.** `POST /agents` returns an agent id + a USDC wallet on **Base** (and a Solana address) provisioned headlessly via **CDP Server Wallets** (API-key, no OTP) — alternative: **Circle Agent Wallets** (non-interactive auth, sanctions screening, sponsored gas) or **Privy server wallets** (Stripe-owned, policy engine). Sponsor gas via Base paymaster. Bind the wallet signer to the agent's identity key (also publish an ERC-8004 registration with `x402Support: true` so external agents can find/verify us).
2. **Accept x402 `exact` on every priced endpoint** (`@x402/*` middleware; CDP facilitator with PayAI/thirdweb as fallback facilitators). Publish all listings to the **x402 Bazaar**, **Circle Agent Marketplace**, and the Tempo payments directory — discovery by external agents comes for free.
3. **Internal credits ledger** (USDC-denominated, 1 credit = $1). Top-up via x402/MPP (like Locus: $1–$100 per top-up), spend via ledger for sub-cent calls, messaging, and marketplace jobs. Only deposits/withdrawals touch chain → fees near zero and escrow is instant. For agents that insist on per-call on-chain settlement, support **Circle Nanopayments** (batched EIP-3009, min $0.000001).
4. **Bounded authority defaults** (copy the AWS/OpenClaw pattern): per-payment ceiling, session budget + expiry, recipient allowlists, network/asset pinning; responses from paid resources flagged untrusted. Expose these as JSON policy objects the agent (or its owner) sets once.
5. **Agent-facing DX:** one `.md`/`llms.txt`, an MCP server with 402-gated tools (post-2026-07-28 stateless MCP), a `skills` package for Claude Code/OpenClaw (`npx skills add <us>`), and a CLI. Follow Stripe's "read this URL and integrate" one-liner style.

### 5.3 Phase 2 — MPP + metered services (weeks 6–14)
- Run **`mppx`** next to x402 on the same endpoints (`mppx.compose()` per method) so Tempo/Solana/Stellar-stablecoin, Lightning and card-backed (SPT) agents can pay. Use **MPP `session` intents** for streamed/metered services (LLM tokens, compute seconds) — deposit + signed vouchers = built-in partial escrow.
- Treat Tempo as a second settlement chain (Stripe-native offramp, stablecoin gas).

### 5.4 Fiat rails (weeks 8–16)
- **Stripe as merchant of record + payouts**: accept SPT card payments through MPP for human-backed agents (≥$0.50), settle x402/MPP stablecoin receipts into Stripe balance where fiat reporting/refunds/tax matter (accept the 1.5%), pay out sellers' owners via **Stripe Connect** (fiat) or direct USDC withdrawal (crypto). Non-US: request stablecoin access (30+ countries) by email.
- **Enterprise/KYA buyers:** accept **Skyfire `kya+pay` tokens** (USD, verified agent identity) and honor Visa TAP / Web Bot Auth request signatures as an identity signal.
- **Payouts to humans (bounties, gig work):** Payman (US ACH) or Stripe Connect; USDC everywhere else.
- Do **not** build AP2/ACP/UCP/Visa VIC/Mastercard Agent Pay buyer flows now; they require a human cardholder and target consumer shopping. Add them later as "card-funded agent" adapters via Nevermined (VIC + x402) or Stripe (SPT) — they reduce to "fund the credits ledger from a card mandate."

### 5.5 Escrow, refunds, disputes
- **Default (small tickets, < ~$5):** direct charge on the ledger or x402; no escrow; refunds by seller-initiated reversal (ledger credit or new transfer).
- **Marketplace jobs (> ~$5 or multi-step):** ledger **hold** on job acceptance → release on buyer acceptance / auto-release after N hours / partial release on milestones. For on-chain buyers who refuse custody, mirror the same states with **Base `commerce-payments`** (`authorize → capture/refund/void`, platform as operator, configurable fee) or **x402r** auth-capture escrow.
- **Disputes (three tiers):** (1) automated verification (schema/tests/hash of deliverable, receipts); (2) LLM arbiter with both parties' evidence; (3) human/committee fallback for amounts above a threshold. Publish arbiter policy per listing (x402r-style pluggable arbiter).
- **Reputation anchoring:** every rating must reference a settled payment (tx hash, MPP receipt, or ledger receipt) — this directly addresses the ERC-8004 study's 98.7–100% evidence-free feedback and Sybil problems. Weight reputation by value at stake.
- **Chargeback exposure:** only card-funded (SPT) deposits are reversible; hold card-funded credits for a cooling period before withdrawal to crypto.

### 5.6 KYC / compliance tiers
- Tier 0 (anonymous agent): stablecoin only; KYT/sanctions screening on deposits/withdrawals (CDP/Circle do this); low limits.
- Tier 1 (identified agent): KYA token (Skyfire) or signed owner credential (ACK-ID / ERC-8004 registration / Visa TAP signature); higher limits.
- Tier 2 (fiat): owner KYB/KYC through Stripe/Payman/AgentWallet-style principal verification.
- Open regulatory question (see §7): an internal ledger may constitute money transmission/custody in some jurisdictions — Catena's OCC trust-charter route and Crossmint's CASP licensing show the direction of travel.

---

## 6. Non-obvious strategic insights

1. The industry has converged on **HTTP 402 as the wire, not on one protocol**: x402 has the network (Foundation, Bazaar, AWS/Cloudflare/Circle/Stripe support); MPP has the richer model (sessions, subscriptions, multi-method incl. cards and Lightning). Supporting both costs little (same server code path) and avoids betting.
2. **"Zero humans" is only achievable with stablecoins.** Every card/fiat rail — including Coinbase's own Agentic Wallet email OTP and Stripe Link's per-purchase approval — puts a human at wallet creation or at checkout. The platform that issues wallets *at agent registration* removes the last human step and becomes the agent's bank.
3. **Escrow/dispute is white space.** No major rail ships agent-to-agent escrow; the pieces exist (commerce-payments authorize/capture, x402r arbiters, MPP session deposits) but nobody has packaged them into a marketplace. This is the differentiator for a service marketplace among agents.
4. **On-chain reputation is already Sybil-polluted** (ERC-8004 study). Payment-anchored, value-weighted reputation is the moat; publish it back to ERC-8004 feedback with `proofOfPayment`.
5. **Sub-cent is the new normal** ($0.000001 Nanopayments, 1-sat L402, MPP vouchers). Per-tx on-chain settlement is the wrong default; ledgers/batching are.
6. **Discovery is being centralized around facilitators** (CDP Bazaar, Circle Marketplace, Tempo directory, Locus catalog). Be a *publisher* into those indexes rather than only a competitor.
7. **Compliance is moving into the wallet layer** (KYT at CDP, sanctions screening at Circle, KYA tokens recognized by bot managers). Piggyback on those instead of building KYC; reserve owner-KYB for fiat.
8. **Liability is unresolved and prompt-injection theft is documented** (Zylos, arXiv SoK) — hard, infrastructure-enforced spend policies (the AWS/OpenClaw model) are becoming table stakes for any agent that holds funds.
9. **Big-tech consumer commerce is retrenching** (OpenAI moved Instant Checkout into Apps; only ~12 merchants shipped) while machine-to-machine volume is growing (165M x402 tx). B2B agent-to-agent is the nearer market.
10. **Stripe is the fiat bridge for everyone** (owns Privy, co-authored MPP/ACP, x402 seller-side, 1.5% stablecoin offramp, agent-first docs). One Stripe integration covers cards, BNPL, stablecoin offramp and payouts.

---

## 7. Open questions
- Cloudflare Wallets: custody model, KYC, fees, GA date; status of "NET Dollar".
- Will x402 absorb MPP's session/subscription intents (x402 `session`/`deferred` schemes are still proposals), or will Stripe keep both?
- Exact CDP Server Wallet developer requirements (KYB?) and current facilitator pricing (docs page was not fetchable; $0.001/tx after 1k free is secondary).
- Circle Agent Wallets: is any human email verification mandatory for non-interactive auth? Gas sponsorship caps?
- Skyfire and Cloudflare fee schedules (not public).
- Regulatory classification of a platform-run USDC credits ledger (money transmission / custody / e-money) in the US and EU (MiCA CASP); is a partner-custodied model (Circle/CDP) preferable?
- Payman's current status (docs offline at time of research).
- How much of x402's 165M transactions is real economic activity vs. sub-cent test traffic (Foundation stats say volume is "overwhelmingly USDC on Base").
- Whether Mastercard "Agent Pay for Machines" exposes a developer API for non-consumer agents (only secondary coverage found).

---

## 8. All URLs consulted (deduplicated)

https://eco.com/support/en/articles/14839402-x402-protocol-explained
https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation
https://www.coindesk.com/tech/2026/05/05/ai-agents-are-breaking-web-economics-but-cloudflare-says-x402-can-help
https://sherlock.xyz/post/x402-explained-the-http-402-payment-protocol
https://blockeden.xyz/blog/2026/03/05/x402-foundation-ai-payment-internet/
https://www.digitalapplied.com/blog/x402-payment-protocol-ai-agents-pay-coinbase-cloudflare
https://blog.cloudflare.com/tag/x402/
https://blog.cloudflare.com/x402/
https://blog.cloudflare.com/monetization-gateway/
https://blog.cloudflare.com/wallets/
https://www.nasdaq.com/articles/cloudflare-launch-x402-foundation-seamless-internet-payment
https://www.cobo.com/post/ap2-protocol-complete-guide-to-agent-payments-for-web3-developers-2026
https://eco.com/support/en/articles/15192002-ap2-protocol-explained-google-s-agentic-commerce-standard-2026
https://eco.com/support/en/articles/14845479-ap2-agent-payments-protocol-explained
https://www.everestgrp.com/googles-agent-payments-protocol-ap2-a-new-chapter-in-agentic-commerce-blog/
https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
https://ap2-protocol.org/
https://github.com/google-agentic-commerce/AP2
https://thenextweb.com/news/google-universal-cart-agent-payments-shopping-io-2026
https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/
https://codelabs.developers.google.com/next26/adk-agent-commerce
https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/
https://investor.visa.com/news/news-details/2025/Visa-Introduces-Trusted-Agent-Protocol-An-Ecosystem-Led-Framework-for-AI-Commerce/default.aspx
https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-unveils-trusted-agent-protocol-for-ai-commerce.html
https://developer.visa.com/capabilities/trusted-agent-protocol/overview
https://github.com/visa/trusted-agent-protocol
https://www.visa.com/en-us/solutions/intelligent-commerce
https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.22491.html
https://investor.visa.com/news/news-details/2026/Visa-Announces-New-AI-Stablecoin-and-Token-Innovations-to-Power-Intelligent-Programmable-Commerce-at-Visa-Payments-Forum/default.aspx
https://www.pymnts.com/visa/2026/visa-launches-ai-and-stablecoin-tools-to-power-agentic-commerce/
https://www.mastercard.com/global/en/news-and-trends/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai.html
https://eco.com/support/en/articles/15192001-what-is-mastercard-agent-pay-ai-agent-commerce-protocol-in-2026
https://www.mastercard.com/global/en/news-and-trends/stories/2025/agentic-commerce-momentum.html
https://stellagent.ai/insights/mastercard-agent-pay-agentic-tokens
https://genfinity.io/2026/06/10/mastercard-agent-pay-for-machines-launch/
https://www.mastercard.com/news/ap/en-hk/newsroom/press-releases/en-hk/2026/mastercard-completes-its-first-live-agentic-transaction-in-hong-kong/
https://stripe.com/blog/machine-payments-protocol
https://stripe.com/use-cases/agentic-commerce
https://docs.stripe.com/agentic-commerce/monetize-mcp
https://stellagent.ai/insights/stripe-shared-payment-token-spt
https://stripe.com/en-cy/sessions/2026/machine-payments-and-the
https://arxiv.org/pdf/2604.15367
https://docs.stripe.com/payments/machine/mpp
https://docs.stripe.com/payments/machine
https://docs.stripe.com/payments/machine/x402
https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
https://docs.stripe.com/skills.md
https://github.com/stripe-samples/machine-payments
https://link.com/agents
https://mpp.dev
https://mpp.dev/intents/session
https://tempo.xyz/developers/docs/cli
https://tempo.xyz/developers/docs/cli/wallet
https://tempo.xyz/developers/docs/cli/request
https://unchainedcrypto.com/tempo-mainnet-launches-with-ai-agent-payment-standard/
https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents
https://www.ledgerinsights.com/stripe-paradigm-launch-tempo-blockchain-alongside-machine-payments-standard/
https://thedefiant.io/news/blockchains/tempo-launches-mainnet-unveils-machine-payments-protocol-with-stripe
https://fortune.com/2026/03/18/stripe-tempo-paradigm-mpp-ai-payments-protocol/
https://www.theblock.co/post/389352/stripe-adds-x402-integration-usdc-agent-payments
https://eco.com/support/en/articles/14839406-stripe-link-agents-and-x402-explained
https://eco.com/support/en/articles/14846277-know-your-agent-kya-identity-for-agent-payments
https://www.f5.com/company/news/press-releases/f5-skyfire-secure-agentic-commerce
https://stellagent.ai/insights/skyfire-kyapay-know-your-agent
https://rye.com/blog/skyfire-agentic-commerce-stack
https://www.businesswire.com/news/home/20251218520399/en/Skyfire-Demonstrates-Secure-Agentic-Commerce-Purchase-Using-the-KYAPay-Protocol-and-Visa-Intelligent-Commerce
https://www.businesswire.com/news/home/20250626772489/en/Skyfire-Launches-Open-KYAPay-Protocol-With-Agent-Checkout
https://skyfire.xyz/product/
https://skyfire.xyz/
https://docs.skyfire.xyz
https://docs.skyfire.xyz/llms.txt
https://docs.skyfire.xyz/docs/buyer-guide
https://docs.skyfire.xyz/docs/wallet-funding.md
https://docs.skyfire.xyz/reference/settlement-of-payments.md
https://www.skyfireapp.com/pricing
https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained
https://www.coinbase.com/developer-platform/discover/launches
https://www.coinbase.com/developer-platform/products/agentic-wallets
https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets
https://docs.cdp.coinbase.com/agent-kit/core-concepts/wallet-management
https://docs.cdp.coinbase.com/agentic-wallet/welcome
https://docs.cdp.coinbase.com/agentic-wallet/quickstart
https://docs.cdp.coinbase.com/x402/welcome
https://docs.cdp.coinbase.com/x402/quickstart-for-buyers
https://docs.cdp.coinbase.com/x402/bazaar
https://docs.cdp.coinbase.com/llms.txt
https://github.com/coinbase/x402
https://github.com/coinbase/agentkit
https://x402.gitbook.io/x402/faq
https://www.coinbase.com/developer-platform/discover/launches/x402facilitator-polygon
https://www.pymnts.com/cryptocurrency/2026/coinbase-debuts-crypto-wallet-infrastructure-for-ai-agents/
https://eco.com/support/en/articles/14730445-erc-8004-trustless-agent-identity
https://arxiv.org/html/2606.26028
https://github.com/sudeepb02/awesome-erc8004
https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/
https://eips.ethereum.org/EIPS/eip-8004
https://www.circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy
https://www.circle.com/nanopayments
https://www.circle.com/agent-stack
https://agents.circle.com
https://developers.circle.com/agent-stack/
https://developers.circle.com/agent-stack/agent-wallets
https://developers.circle.com/agent-stack/agent-wallets.md
https://developers.circle.com/agent-stack/agent-nanopayments.md
https://developers.circle.com/llms.txt
https://www.crowdfundinsider.com/2026/05/276951-circle-launches-nanopayments-on-mainnet-enabling-usdc-micro-transactions-for-agentic-economy/
https://www.blockhead.co/2026/05/12/circle-launches-agent-stack-to-put-usdc-at-the-centre-of-machine-to-machine-payments/
https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services-to-Power-AI-Driven-Shopping
https://developer.paypal.com/agentic-commerce-services/about
https://docs.paypal.ai/growth/agentic-commerce/overview
https://developer.paypal.com/community/blog/enabling-agentic-payments/
https://dupple.com/tools/payman
https://www.businesswire.com/news/home/20260520362081/en/Payman-AI-Selected-for-ICBA-ThinkTECH-Accelerator
https://tracxn.com/d/companies/payman-ai/__NSTYOZtZdNiGZxC0Vkul0dzUfj3ZUgPqDRNO08pHBUE
https://docs.paymanai.com/dashboard-guide/wallet
https://docs.paymanai.com/
https://paywithlocus.com/pricing
https://paywithlocus.com/endpoints
https://paywithlocus.com/
https://paywithlocus.com/use-cases/ai-agent-wallet
https://paywithlocus.com/use-cases/agent-to-agent-payments
https://docs.paywithlocus.com
https://docs.paywithlocus.com/llms.txt
https://docs.paywithlocus.com/features/wallets.md
https://docs.paywithlocus.com/build/x402.md
https://nevermined.ai/blog/ai-agent-payment-systems
https://nevermined.ai/blog/x402-ai-agent-billing
https://nevermined.ai/blog/nevermined-unlocks-autonomous-agent-card-payments-with-x402-opening-a-new-market-for-publishers-digital-merchants
https://nevermined.ai/blog/the-payment-layer-ai-agents-actually-need-introducing-the-nevermined-x402-facilitator
https://thepaypers.com/payments/news/nevermined-integrates-visa-intelligent-commerce-and-x402-for-autonomous-ai-agent-payments
https://thedefiant.io/news/infrastructure/lightning-labs-launches-site-for-l402-bitcoin-agent-payments
https://github.com/lightninglabs/L402
https://lightning.engineering/posts/2026-03-11-L402-for-agents/
https://lightning.engineering/posts/2026-02-11-ln-agent-tools/
https://l402.tech/
https://www.tftc.io/x402-foundation-operational-launch-ai-agent-payments
https://www.crossmint.com/learn/embedded-agent-wallets
https://www.crossmint.com/learn/agent-wallets-compared
https://www.crossmint.com/products/wallet-infrastructure
https://github.com/goat-sdk/goat
https://www.openfort.io/blog/privy-vs-turnkey
https://www.openfort.io/blog/best-agent-wallets-for-developers
https://dcpagent.com/blog/agentic-wallets-compared
https://fast.io/resources/top-crypto-wallets-autonomous-agents/
https://www.alchemy.com/blog/how-to-build-solana-ai-agents-in-2026
https://github.com/sendaifun/solana-agent-kit
https://kit.sendai.fun/
https://solana.com/x402/what-is-x402
https://stellar.org/blog/foundation-news/x402-on-stellar
https://www.agentcommercekit.com/overview/concepts
https://github.com/agentcommercekit
https://catenalabs.com/blog/agent-commerce-kit
https://www.fintechfutures.com/fintech-start-ups/catena-labs-emerges-from-stealth-with-18m-seed-funding
https://fortune.com/2026/05/20/catena-labs-series-a-sean-neville-ai-native-bank/
https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance
https://paid.ai/blog/ai-monetization
https://techcrunch.com/2025/09/28/paid-the-ai-agent-results-based-billing-startup-from-manny-medina-raises-huge-21m-seed
https://techcrunch.com/2025/03/25/outreach-founder-manny-medina-has-a-new-startup-that-helps-ai-agents-get-paid
https://www.digitalcommerce360.com/2026/03/06/openai-shifts-checkout-plans-agentic-commerce-strategy/
https://www.digitalcommerce360.com/2026/02/16/openai-expands-agentic-commerce-push/
https://eco.com/support/en/articles/14845478-acp-agentic-commerce-protocol-explained
https://wavect.io/blog/x402-payments-comparison-2026/
https://aws.amazon.com/blogs/industries/x402-and-agentic-commerce-redefining-autonomous-payments-in-financial-services/
https://docs.x402r.org/
https://www.x402r.org/
https://github.com/base/commerce-payments
https://shopify.engineering/commerce-payments-protocol
https://www.finextra.com/blogposting/29130/deep-dive-coinbases-commerce-payments-protocol-how-to-use-it-integrate-it-and-win-with-it
https://github.com/aws-samples/sample-agentcore-cloudfront-x402-payments
https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-payments-preview/
https://www.coinbase.com/blog/introducing-amazon-bedrock-agentcore-payments-powered-by-x402-and-coinbase
https://aws.amazon.com/blogs/machine-learning/build-openclaw-agents-that-transact-with-amazon-bedrock-agentcore-payments/
https://github.com/useOttoAI/openclaw-skills
https://clawhub.ai/coinvest518/openclaw-x402-skill
https://github.com/second-state/payment-skill
https://aaif.io/blog/who-told-the-agent-it-could-spend
https://zylos.ai/research/2026-07-15-agentic-commerce-payment-protocols-ai-agents/
https://agentwallet.md/
https://agentwallet.ai/faq/
https://chimoney.io/products/ai-agent-wallets/
https://www.theasianbanker.com/press-releases/visa-expands-ai-agent-infrastructure-and-stablecoin-settlement-capabilities-at-annual-payments-forum

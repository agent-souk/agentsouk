# Agent Interoperability Protocols and Standards — Research Notes

**Slug:** interop-protocols
**Date:** 2026-09-05 (round 1) · **Round 2 verification pass: 2026-09-06**
**Author:** strategy research subagent
**Scope:** Which agent interop protocols/standards our "small world for AI agents" platform (identity, wallets/payments, agent-to-agent marketplace, messaging, reputation; zero humans in the loop) should speak natively so that Claude Code, OpenClaw, LangGraph/CrewAI, OpenAI Agents SDK, Cloudflare Agents and custom scripts can use it with zero custom code.

Everything below was verified against a primary or near-primary online source on 2026-09-05 unless marked **[unverified]**. The session web-search budget was exhausted mid-task; the final gaps were filled with direct fetches of official docs.

**Round 2 (2026-09-06):** the 10 most decision-relevant claims were re-verified online; wrong or outdated statements are fixed in place and tagged **[corrected 2026-09-06]**; additions are tagged **[added 2026-09-06]**. New material, the verification table and all round-2 URLs are in **§23**.

---

## 0. Executive summary (what is winning as of 2026-09-05)

| Tier | Protocol / format | Verdict | Why |
|---|---|---|---|
| **Must speak natively** | **MCP** (spec `2026-07-28`, plus legacy `2025-11-25`/`2025-06-18` era) | Winner for agent -> tool/data | 400M+ monthly SDK downloads (Anthropic, 2026-07-28), **~18.8k servers in the official registry (18,650 active, 2026-07-28 snapshot) [corrected 2026-09-06; round 1 said ~9.6k from a May 2026 snapshot]**, 950+ connectors in Claude directory, governed by AAIF/Linux Foundation; every framework we care about is an MCP client (OpenAI Agents SDK, LangChain/LangGraph, CrewAI, Google ADK, Cloudflare Agents SDK, OpenClaw, Claude Code). **Claude Code ≥ v2.1.232 already speaks 2026-07-28 ("v2 runtime") [added 2026-09-06].** |
| **Must speak natively** | **A2A v1.0** (Agent Card at `/.well-known/agent-card.json`, JSON-RPC + HTTP+JSON bindings) | Winner for agent <-> agent | 150+ orgs, 25.6k GitHub stars, shipped in Azure AI Foundry, Copilot Studio, Bedrock AgentCore; IBM ACP merged into it (Aug 2025); joined AAIF 2026-08-17; OpenClaw ships an A2A 1.0 channel. **Latest tag v1.0.1 (2026-05-28) [added 2026-09-06].** |
| **Must ship** | **Agent Skills (`SKILL.md`)** — Anthropic open spec at agentskills.io; OpenClaw/ClawHub follows it | Winner for "how to use us" packaging | **46 clients listed on agentskills.io on 2026-09-06 [corrected 2026-09-06; round 1 said ~45]** incl. Claude Code, Claude, ChatGPT/Codex, Cursor, Gemini CLI, GitHub Copilot, VS Code, Goose, OpenClaw, Hermes, Kiro, Spring AI. **ClawHub size depends on what is counted: 26,502 skills crawled to 2026-03-18 (arXiv), ~13.7k "published" (mid-2026, secondary), 52,652 packages / 18,358 maintainers (June 2026, Trent AI) [corrected 2026-09-06; round 1's "~12.5k / 5.3k filtered" was one curated-list snapshot].** |
| **Must ship (cheap)** | **OAuth well-knowns required by MCP** (RFC 9728 `/.well-known/oauth-protected-resource`, RFC 8414 `/.well-known/oauth-authorization-server`, CIMD, `io.modelcontextprotocol/oauth-client-credentials`) | Required for any authenticated MCP server; client-credentials ext is *the* zero-human auth path | Part of MCP 2026-07-28 core + official ext. **CIMD is now also an IETF OAuth WG draft (`draft-ietf-oauth-client-id-metadata-document`) [added 2026-09-06].** |
| **Should speak natively (wallet rails)** | **x402** (HTTP 402; x402 Foundation under Linux Foundation) + **a2a-x402** ext + **AP2** v0.2 (mandates) | Winning for agent payments — **but headline volume is mostly protocol signalling [corrected 2026-09-06]** | x402: 75.4M tx / $24.2M in last 30 days (x402.org, Aug 2026); **Artemis/CoinDesk analysis: >95% of activity is machines testing plumbing, ~$28k/day real commercial volume (Aug 2026)**. Foundation: 22 names at the 2026-04-02 announcement, **40 members at operational launch 2026-07-14 (17 premier incl. Stripe, Visa, Mastercard, AWS, Cloudflare, Shopify, Amex, Adyen, Circle, Coinbase, Fiserv, Google, Ripple, Stellar, Solana Fdn)**. AP2: 60+ orgs; **AP2 v0.2 specifies a "Human Not Present (Autonomous)" flow [added 2026-09-06]**. Cloudflare Agents SDK has native x402. |
| **Should adopt (identity)** | **Web Bot Auth** (IETF WG draft-ietf-webbotauth-httpsig-protocol-00, 2026-09-01; RFC 9421 signatures; `/.well-known/http-message-signatures-directory`) | Winning for "prove this HTTP request came from agent X" | Cloudflare Verified Bots, Akamai, AWS WAF, Vercel, Shopify verify; Claude, ChatGPT, Perplexity sign. **Caveat: the WG charter (formed 2025-10-23) explicitly scopes to bots -> human-facing websites and excludes agent-to-agent interfaces [added 2026-09-06].** |
| **Ship (trivial)** | `llms.txt`, `llms-full.txt`, `openapi.json`, `AGENTS.md` in SDK repos | Cheap, expected by coding agents | llms.txt at 8.7% of top-1k sites (June 2026), but crawlers rarely fetch it; coding agents do. AGENTS.md: 60k+ repos, AAIF-governed. |
| **Optional / watch** | AGNTCY (OASF records + Agent Directory), Arazzo 1.1, ANP (`/.well-known/agent-descriptions`), ERC-8004, UCP | Niche or early; cheap to emit a record | AGNTCY dir v1.7.0 has 184 stars; ANP repo 1.4k stars; Arazzo referenced by MCP docs; **ERC-8004 still Draft; live on Ethereum mainnet since 2026-01-29 with 173k registrations across ETH/BSC/Base, but only 3–15% have valid registration files [corrected 2026-09-06]**. |
| **Skip** | IBM ACP (merged into A2A), LangChain Agent Protocol (dormant), agents.json (Wildcard, v0.1.0, stale), Agora (academic), NLWeb (niche, Microsoft), **WebMCP (browser-side, human-present; W3C CG draft) [added 2026-09-06]** | Dead, dormant, or irrelevant to our shape | See per-protocol notes. |

**One-line answer:** Speak **MCP (dual-era Streamable HTTP) + A2A v1.0 + the OAuth well-knowns** natively, publish a **SKILL.md** to ClawHub/agentskills registries, expose payments over **x402 / a2a-x402 / AP2**, accept and emit **Web Bot Auth** signatures for agent identity, and serve **llms.txt + openapi.json**. Everything else is optional metadata export.

---

## 1. MCP — Model Context Protocol

### 1.1 Current spec: `2026-07-28` (released 2026-07-28; RC earlier in July)
Sources: https://blog.modelcontextprotocol.io/posts/2026-07-28/ , https://modelcontextprotocol.io/specification/2026-07-28/changelog , https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

Largest revision since launch. Key facts (verified from the changelog; **re-verified verbatim against the changelog on 2026-09-06 — all items below confirmed**):
- **Stateless core.** `initialize`/`notifications/initialized` handshake and `Mcp-Session-Id` header are removed (SEP-2567, SEP-2575). Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`, `_meta["io.modelcontextprotocol/clientCapabilities"]`, and SHOULD carry `_meta["io.modelcontextprotocol/clientInfo"]`. Servers identify themselves via `_meta["io.modelcontextprotocol/serverInfo"]` on results.
- **`server/discover`** RPC: servers MUST implement; returns `supportedVersions`, `capabilities` (incl. `extensions`), `ttlMs`, `cacheScope`. Clients use it as a probe.
- **Streamable HTTP**: single endpoint (e.g. `https://example.com/mcp`) accepting POST only; GET stream endpoint removed; SSE resumability (`Last-Event-ID`) removed. Required headers on every POST: `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, and `Mcp-Name: <tool|uri|prompt>` for `tools/call`, `resources/read`, `prompts/get`. Optional `x-mcp-header` schema annotation mirrors tool params into `Mcp-Param-{Name}` headers so gateways can route/rate-limit without parsing JSON. Header/body mismatch -> HTTP 400 + JSON-RPC `-32020 HeaderMismatch`. Unknown method -> 404 + `-32601`.
- **MRTR (Multi Round-Trip Requests, SEP-2322)** replaces server-initiated `elicitation/create`, `sampling/createMessage`, `roots/list`: server returns `resultType: "input_required"` with `inputRequests`; client retries the original request with `inputResponses`. All results now carry `resultType` (`"complete"` | `"input_required"` | `"task"` when the Tasks ext is used).
- **`subscriptions/listen`**: one long-lived POST response stream for opted-in change notifications (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`). **[added 2026-09-06]** Request-scoped notifications (`notifications/progress`, `notifications/message`) still flow on the originating request's response stream; log level is now per-request via `_meta["io.modelcontextprotocol/logLevel"]`; OpenTelemetry `traceparent`/`tracestate`/`baggage` keys in `_meta` are documented (SEP-414).
- **Cacheable lists**: `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` MUST return `ttlMs` and `cacheScope` (`public`|`private`). Tools SHOULD be returned in deterministic order (prompt-cache hit rates).
- **Removed**: `ping`, `logging/setLevel`, `notifications/roots/list_changed`, `tasks/list`, `notifications/elicitation/complete`.
- **Deprecated (12-month minimum window)**: Roots, Sampling, Logging features; HTTP+SSE transport (2024-11-05); OAuth Dynamic Client Registration (RFC 7591) in favour of **Client ID Metadata Documents (CIMD)**.
- **Authorization hardening**: `iss` validation per RFC 9207; `application_type` required in DCR; credentials bound to issuing AS.
- **Schema**: `inputSchema`/`outputSchema` now allow any JSON Schema 2020-12 keywords. Error-code policy: `-32020..-32099` reserved for MCP spec (`UnsupportedProtocolVersion` = `-32022`, `MissingRequiredClientCapability` = `-32021`). **[added 2026-09-06]** Resource-not-found moved from `-32002` to `-32602`.
- **Extensions framework** (`extensions` field in ClientCapabilities/ServerCapabilities; reverse-DNS ids).
- **Backward compatibility**: a 2026-07-28-only server SHOULD answer legacy GET/DELETE with `405`, ignore `Mcp-Session-Id` and `Last-Event-ID`. A dual-era client tries a modern request first; on a `400` whose body is *not* a recognised modern JSON-RPC error it falls back to `initialize`. Servers MAY treat a request without `MCP-Protocol-Version` as `2025-03-26`.
- **SDKs**: TypeScript, Python, Go, C# support 2026-07-28 at release; Rust beta. "Close to half a billion downloads a month" across Tier-1 SDKs; TS and Python each >1B total.
- **[added 2026-09-06] Next revision:** the `specification/draft/changelog` page is empty on 2026-09-06 ("Changes since the most recent release will accumulate here") — no post-2026-07-28 revision is in flight; the 2026-08-22 roadmap (§1.3) is the only forward signal.

### 1.2 Official extensions (https://modelcontextprotocol.io/extensions/overview , https://modelcontextprotocol.io/extensions/client-matrix)
| Extension | Identifier | Notes |
|---|---|---|
| Tasks | `io.modelcontextprotocol/tasks` (SEP-2663; repo `ext-tasks`) | Server returns `CreateTaskResult` (`resultType: "task"`, `taskId`, `ttlMs`, `pollIntervalMs`). Client polls `tasks/get`; supplies input via `tasks/update`; `tasks/cancel` cooperative. States: `working`, `input_required`, `completed`, `failed`, `cancelled`. Optional `notifications/tasks` over `subscriptions/listen`. Client opts in per request via `_meta.clientCapabilities.extensions`. **[clarified 2026-09-06]** Because the protocol is stateless, "opt in" = the client lists the extension in the `clientCapabilities.extensions` it sends in *every* request's `_meta`; the changelog's "without per-request opt-in" means there is no per-tool warm-up or per-call flag — the server decides per request whether to return a task, and servers MUST NOT return a task to a client that did not declare the extension. Tasks are absent from the extension client matrix on 2026-09-06 (only Apps / OAuth-CC / Enterprise Auth columns exist). |
| MCP Apps | `io.modelcontextprotocol/ui` (SEP-1865; repo `ext-apps`) | Server-rendered HTML in sandboxed iframe. Supported by Claude web/desktop, ChatGPT, Cursor, VS Code Copilot, M365 Copilot, Goose, Postman, **MCPJam, Archestra, PostHog Code [added 2026-09-06]**. Irrelevant for a zero-human platform. |
| OAuth Client Credentials | `io.modelcontextprotocol/oauth-client-credentials` (repo `ext-auth`) | **The zero-human auth path.** RFC 7523 JWT-bearer assertions (recommended) or `client_id`+`client_secret`. SDK: TS `ClientCredentialsProvider` / `PrivateKeyJwtProvider` in `@modelcontextprotocol/client`; Python `ClientCredentialsOAuthProvider` / `PrivateKeyJWTOAuthProvider`. Client matrix shows no major consumer client listing it yet (only Archestra lists EMA) — support is SDK-level, which is fine for headless agents. **[re-verified 2026-09-06: the OAuth Client Credentials column is still empty for all 11 listed clients.]** |
| Enterprise-Managed Authorization | `io.modelcontextprotocol/enterprise-managed-authorization` | Enterprise IdP; not our concern. |

### 1.3 Authorization (core)
Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery , https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- MCP servers MUST implement RFC 9728 Protected Resource Metadata: either `WWW-Authenticate: ... resource_metadata="<url>"` on 401, or well-known at `/.well-known/oauth-protected-resource[/<mcp-path>]`. Document MUST list `authorization_servers`.
- AS metadata discovery via RFC 8414 `/.well-known/oauth-authorization-server` and OIDC `/.well-known/openid-configuration` (path-insertion order defined). Clients MUST validate `issuer` matches.
- **CIMD**: `client_id` is an HTTPS URL with a path (e.g. `https://example.com/client.json`) hosting `{client_id, client_name, redirect_uris, ...}`; AS advertises `client_id_metadata_document_supported: true`. CIMD client IDs are **portable across authorization servers**. Priority: pre-registration -> CIMD -> DCR fallback -> prompt user. **[added 2026-09-06]** CIMD is referenced by the Web Bot Auth WG draft as `draft-ietf-oauth-client-id-metadata-document`, i.e. it is now an IETF OAuth working-group item, not only an MCP convention.
- Roadmap (2026-08-22, https://blog.modelcontextprotocol.io/posts/mcp-roadmap/): agent identity & enterprise security (DPoP, Workload Identity Federation, token exchange), HTTP-native transport unification, Tasks maturation, progressive discovery for large tool catalogs.

### 1.4 Registry (https://modelcontextprotocol.io/registry/about , https://github.com/modelcontextprotocol/registry , https://registry.modelcontextprotocol.io/)
- Status: **preview** since 2025-09-08; API freeze v0.1 since 2025-10-24; GA not yet announced as of 2026-09-05. **[re-verified 2026-09-06: the about page still carries the "currently in preview; breaking changes or data resets may occur before general availability" banner.]**
- API: `https://registry.modelcontextprotocol.io/v0.1/servers` (also `/v0/servers`), docs at `/docs`. OpenAPI spec published so subregistries/marketplaces can implement the same interface; host apps are expected to consume *downstream* registries, not the official one directly. **[added 2026-09-06]** Live response shape (`GET /v0.1/servers?limit=1`): `{ "servers": [...], "metadata": { "nextCursor": "<name>:<version>", "count": n } }`; each entry has `name`, `title`, `description`, `version`, `$schema` (currently the **`2025-12-11`** server.json schema, not "draft"), `remotes[{type:"streamable-http", url}]` and/or `packages[]`, plus `_meta` with `status` (active/inactive), `publishedAt`, `updatedAt`, `isLatest`.
- `server.json` schema: `docs/reference/server-json/draft/server.schema.json`. Names are reverse-DNS namespaces (`io.github.user/server`, `com.example/server`) verified via GitHub OAuth/OIDC, DNS challenge, or HTTP challenge. Supports remote servers and packages (npm, PyPI, Docker Hub...). No private servers.
- Counts: ~~9,652 latest server records / 28,959 server-version records (2026-05-24, digitalapplied snapshot)~~ **[corrected 2026-09-06]** **18,849 servers (18,650 active) in the official registry on 2026-07-28** (MCP Queen "State of the MCP Ecosystem, July 2026", 43,320 live probes): 49.9% (9,312) expose a remote endpoint, 82.8% of those are reachable, 53.1% of graded remote servers get an "A", 55.8% of remote servers need no auth, 20.2% are properly auth-gated, 6.9% reject auth incorrectly; median latency 233 ms; 102,013 tools catalogued from 5,241 servers (~19 per server; 99.7% have typed schemas). Anthropic Dec 2025: 10,000+ active public servers; 15,926 GitHub repos with `mcp-server` topic; `modelcontextprotocol/servers` repo 86k stars. Unofficial aggregators: mcp.so ~20.2k, Glama ~22.8k (May 2026, secondary).

### 1.5 Client rollout of 2026-07-28 (important for our dual-era decision)
- Anthropic (https://claude.com/blog/bringing-mcp-2026-07-28-to-claude): "Support is being rolled out across Claude products soon"; 400M+ monthly SDK downloads (4x YoY); 950+ servers in Claude connector directory. **[re-verified 2026-09-06.]**
- **[corrected 2026-09-06] Claude Code has shipped it.** The Claude Code MCP docs (https://code.claude.com/docs/en/mcp) state: "On Claude Code v2.1.232 or later, Claude Code uses the v2 runtime ... Asks HTTP and claude.ai connector servers whether they support the newer revision, and uses it with those that do. It asks stdio servers only if you set `MCP_PROTOCOL_NEGOTIATION` to `auto`." The CHANGELOG entry for v2.1.238 fixes "stdio MCP servers receiving a `server/discover` request before `initialize`". v2.1.232 shipped approximately mid-August 2026 (inferred from cadence: v2.1.248 = 2026-08-27, v2.1.261 = 2026-09-05; exact date **[unverified]**). Claude Code auth: DCR, pre-configured client id/secret, **CIMD auto-discovered**, and `headersHelper` for custom schemes; the docs do not mention the `oauth-client-credentials` extension.
- Cloudflare Agents SDK v0.20.0 (2026-07-27) supports 2026-07-28 client+server, probes `server/discover` then falls back to legacy `initialize` on the same connection; `createMcpHandler` serves both eras on one route; `isLegacyRequest()` helper. https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- **[added 2026-09-06] GitHub MCP Server** announced 2026-07-28 support on 2026-07-23 (official Go SDK; "database writes on `initialize` are gone"; reads routing values from headers; an elicitation wrapper serves both old and new clients on one endpoint). https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/
- OpenAI Agents SDK depends on `mcp>=1.19.0,<3`; with SDK v2 it probes newest protocol first then falls back. https://openai.github.io/openai-agents-python/mcp/ **[added 2026-09-06]** The OpenAI Responses API MCP tool guide still documents only "Streamable HTTP or HTTP/SSE" and a per-request `authorization` bearer token (never stored); no protocol version, DCR, CIMD or client-credentials mention. The OpenAI API changelog (through Sept 2026) has no 2026-07-28 entry. A community feature request for the Tasks extension in ChatGPT Developer Mode (late Aug 2026, page not fetchable) implies ChatGPT does not yet support it **[unverified]**. Cursor's MCP docs list stdio/SSE/Streamable HTTP, OAuth and static client id/secret, MCP Apps — no 2026-07-28 mention.
- InfoQ 2026-08: Claude Desktop/Code, ChatGPT, Cursor still could not connect to a GA remote server whose IdP lacked DCR/CIMD — i.e. auth interop, not transport, is the practical blocker. https://www.infoq.com/news/2026/08/azure-devops-remote-mcp-ga/
- **Implication:** a server we ship in Sept 2026 MUST serve both the 2026-07-28 stateless shape and the 2025-11-25 session-based shape on the same `/mcp` endpoint, and MUST support CIMD + DCR fallback + client-credentials. **[unchanged after round 2: Claude Code and Cloudflare are modern, OpenAI/ChatGPT/Cursor are unconfirmed.]**

### 1.6 How each framework consumes MCP (verified)
- **OpenAI Responses API** tool shape: `{"type":"mcp","server_label":"...","server_url":"https://.../mcp","server_description":"...","require_approval":"never"|"always"|...}`; function tools `{"type":"function","name","description","parameters"(JSON Schema, additionalProperties:false),"strict":true}`; also `tool_search`, `namespace`. https://developers.openai.com/api/docs/guides/tools
- **OpenAI Agents SDK (Python)**: `HostedMCPTool`, `MCPServerStreamableHttp`, `MCPServerSse` (deprecated), `MCPServerStdio`; static/dynamic tool filters; `require_approval`. https://openai.github.io/openai-agents-python/mcp/
- **LangChain/LangGraph**: `langchain-mcp-adapters` (3.6k stars) — `load_mcp_tools(session)`, transports stdio/sse/streamable_http/http. https://github.com/langchain-ai/langchain-mcp-adapters
- **CrewAI**: `mcps` field on agents (string refs) or `MCPServerAdapter`; stdio/SSE/Streamable HTTP. https://docs.crewai.com/en/mcp/overview
- **Google ADK**: `McpToolset` (page redirected; not re-verified this session) **[unverified]**.
- **OpenClaw**: `openclaw mcp add <name> --url ... --transport streamable-http --header ...` (stdio, SSE/HTTP, streamable-http; OAuth, mTLS); also `openclaw mcp serve` exposes OpenClaw as an MCP server. https://docs.openclaw.ai/cli/mcp
- **Cloudflare Agents SDK** (5.5k stars): act as MCP server or client (HTTP, SSE, RPC, elicitation); native x402; A2A example. https://github.com/cloudflare/agents
- **Claude Code** **[added 2026-09-06]**: transports HTTP (recommended), SSE (deprecated), stdio, WebSocket (`{"type":"ws"}`); `managedMcpServers` org setting (v2.1.259, 2026-09-03); tool search for large catalogs (`ENABLE_TOOL_SEARCH`). https://code.claude.com/docs/en/mcp

---

## 2. A2A — Agent2Agent Protocol (v1.0)

Sources: https://a2a-protocol.org/latest/specification/ , https://a2a-protocol.org/latest/topics/agent-discovery/ , https://github.com/a2aproject/A2A , https://learn.microsoft.com/en-us/agent-framework/migration-guide/agent-to-agent-sdk-v1 , https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year , https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html

- **Timeline**: announced 2025-04-09 (Google, 50+ partners); donated to Linux Foundation 2025-06-23; IBM ACP merged in 2025-08-29; **v1.0 released 2026-03-12 [corrected 2026-09-06: now confirmed by the primary a2a-protocol.org announcement, not only secondary sources]**; **v1.0.1 patch 2026-05-28** (HTTP binding now prefers `application/a2a+json`; TaskStatus and transcoding-error fixes) **[added 2026-09-06]**; 150+ orgs, 22k+ stars by 2026-04-09 (25.6k stars on 2026-09-05); **joined the Agentic AI Foundation 2026-08-17 (confirmed on aaif.io/blog/a2a-joins-aaif [re-verified 2026-09-06]; press coverage 2026-08-19/20)**; AAIF grew from 49 founding members to 250+ (secondary). TSC includes AWS, Cisco, Google, IBM Research, Microsoft, Salesforce, SAP, ServiceNow.
- **Production platforms**: Azure AI Foundry, Copilot Studio, Amazon Bedrock AgentCore Runtime, Google Agent Engine. Interop demonstrated across ADK, LangGraph, AG2, CrewAI. SDKs: Python `a2a-sdk`, Go `a2a-go`, JS `@a2a-js/sdk`, Java, .NET `A2A`, Rust `a2a-lf`.
- **Agent Card**: JSON at **`https://{domain}/.well-known/agent-card.json`** (RFC 8615). **[re-verified 2026-09-06 on the official discovery page: `https://{agent-server-domain}/.well-known/agent-card.json`; v1.0 renamed it from `agent.json`.]** Legacy `/.well-known/agent.json` was used by a2a-sdk v0.2.x and broke in v0.3.x (google/adk-python#2535); OpenClaw serves both. Only one card per origin via well-known -> per-agent cards need per-agent origins or direct URLs. v1.0 card: `protocolVersion`, `name`, `description`, `version`, `capabilities` (`streaming`, `pushNotifications`, `extensions`, `extendedAgentCard`), `skills[]`, `securitySchemes`, **`supportedInterfaces[]`** (`{url, protocolBinding: "JSONRPC"|"HTTP+JSON"|"GRPC", protocolVersion}`) replacing the old top-level `url`, `defaultInputModes/OutputModes`, optional `signatures` (**JWS, RFC 7515, with JCS canonicalization RFC 8785** — spec section 8.4). Authenticated extended card via `agent/getAuthenticatedExtendedCard` / `GetExtendedAgentCard`. (One fetch summary claimed `/.well-known/a2a`; the official discovery page and OpenClaw/Microsoft implementations say `agent-card.json` — treat `agent-card.json` as canonical.)
- **Bindings**: JSON-RPC 2.0 (`message/send`, `message/stream`, `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe` (was `resubscribe`), `tasks/pushNotificationConfig/{set,get,list,delete}`), gRPC, and HTTP+JSON/REST. **Microsoft Agent Framework now defaults to HTTP+JSON with JSON-RPC fallback** — serve both.
- **Versioning**: `A2A-Version: 1.0` request header; empty header defaults to 0.3; `VersionNotSupportedError`. **[re-verified 2026-09-06: spec §3.2.6 / §14.2.1.]**
- **Task states**: `TASK_STATE_SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`, `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`.
- **Push notifications**: client registers a webhook URL; server POSTs task updates; requires `capabilities.pushNotifications: true`.
- **Extensions**: identified by URI, declared in card and messages; required extensions error if unsupported. Family: AP2, A2UI, UCP, a2a-x402 (**URI `https://github.com/google-a2a/a2a-x402/v0.1` [added 2026-09-06]**).
- **Discovery**: (1) well-known URI, (2) **curated registries — the spec explicitly does NOT define a registry API** (opportunity for us), (3) direct configuration. **[added 2026-09-06]** The registry gap is tracked in a2aproject/A2A discussion #741 ("Agent Registry – Proposal", opened 2025-06-10 by maintainer kthota-g; proposes `GET /agents/public`, `GET /agents/entitled`, `POST /agents/search`); still an open discussion on 2026-05-26 (Apicurio's carlesarnal urged splitting a core search/resolve/snapshot spec from federation/payment extensions). Unresolved fork: "federation of catalogs" vs "federation of peers". Nothing has landed in the spec.
- **OpenClaw A2A channel** (https://docs.openclaw.ai/channels/a2a): implements A2A 1.0 JSON-RPC binding at `/a2a/v1`; serves both well-known card paths; bearer token per peer, no unauthenticated mode; outbound to configured peers.
- Ecosystem verdict (Zylos 2026-04-18): "adopt A2A for agent-to-agent communication — it has the broadest tooling, the most enterprise integration support, and the most active governance."

## 3. IBM ACP / BeeAI — merged into A2A
Sources: https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/ , https://github.com/orgs/i-am-bee/discussions/5
- ACP (REST-based, March 2025) stopped independent development 2025-08-29; BeeAI now runs on A2A. **Skip.**

## 4. ANP — Agent Network Protocol
Sources: https://github.com/agent-network-protocol/AgentNetworkProtocol , https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/08-ANP-Agent-Discovery-Protocol-Specification.md , https://agentnetworkprotocol.com/en/specs/ , https://w3c-cg.github.io/ai-agent-protocol/ , https://datatracker.ietf.org/doc/html/draft-zyyhl-agent-networks-framework-01
- 1.4k stars, 535 commits; "ANP 1.1" document set (protocol fields still `1.0.0`). Layers: `did:wba` identity + E2E encryption; Agent Description (ANP-07, JSON-LD); Agent Discovery (ANP-08: **`https://{domain}/.well-known/agent-descriptions`**, JSON-LD `CollectionPage` with `items[]` and `next` pagination); meta-protocol ANP-06 still draft. Also lists WNS handles and an "AP2 agent payment protocol" doc (not fetched) **[unverified]**.
- Standards track: W3C AI Agent Protocol Community Group *white paper* (not a spec); IETF individual draft `draft-zyyhl-agent-networks-framework-01` (expired 2026-04-23). No named commercial adopters. Predominantly Chinese ecosystem.
- **Verdict**: niche; emitting `/.well-known/agent-descriptions` is ~1 hour of work if we want coverage; do not build on it.

## 5. AGNTCY (Cisco -> Linux Foundation, 2025-07-29)
Sources: https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos , https://docs.agntcy.org/ , https://dir.agntcy.org/latest/ , https://github.com/agntcy/dir , https://github.com/agntcy/oasf , https://schema.oasf.agntcy.org/
- Components: **OASF** (Open Agentic Schema Framework; versioned records with hierarchical `skills` and `domains` taxonomies, e.g. `advanced_reasoning_planning/strategic_planning`; v0.8 taxonomy referenced), **Agent Directory Service** (federated DHT-based registry; publishes/verifies/discovers **MCP servers, A2A agents, and Agent Skills**; `dirctl` CLI; gRPC + REST; Go/Python/JS SDKs; latest release **v1.7.0**, 184 stars; claims an "ADS Internet Draft" and "ARD spec" — draft name not located **[unverified]**), SLIM messaging (pub/sub + MLS encryption), Identity (DIDs/VCs), SHADI runtime, observability. Members: Cisco, Dell, Google Cloud, Oracle, Red Hat, LangChain, Galileo.
- **Verdict**: real LF project, low developer traction; worth publishing OASF records for our marketplace agents later (they are a metadata superset of A2A cards + MCP server.json) and watching the directory as a federation peer. Not a native protocol for us. (Not re-verified in round 2.)

## 6. Agora (Oxford, Oct 2024 paper)
Sources: https://agoraprotocol.org/docs/protocol/specification , https://github.com/agora-protocol/paper-demo , https://arxiv.org/pdf/2504.16736
- Meta-protocol: agents negotiate "Protocol Documents" in natural language then converge to structured routines. Academic only; no production adopters. **Skip.**

## 7. LangChain Agent Protocol
Sources: https://github.com/langchain-ai/agent-protocol/releases , https://github.com/langchain-ai/langchain-mcp-adapters
- REST spec for Runs/Threads/Store (the LangGraph Platform API shape). Releases page shows `langchain-protocol==0.0.19` (2024-08-26) as latest; a search snippet claimed 0.2.x in April 2026 — conflicting, treat as **dormant / LangGraph-Platform-specific**. LangGraph agents reach us via MCP (`langchain-mcp-adapters`) and A2A, not via this. **Skip.**

## 8. OpenAI Agents SDK / Responses API tool formats
See 1.6. Also AGENTS.md (OpenAI-originated, now AAIF): 60k+ repos; read by Codex, Claude Code, Cursor, Copilot, Gemini CLI, Jules, Windsurf, Zed, Aider, Amp, Junie... https://agents.md/ **[re-verified 2026-09-06: agents.md still says "over 60k open-source projects" (GitHub code-search floor) and "stewarded by the Agentic AI Foundation under the Linux Foundation".]**
- **Verdict**: ship function-tool-compatible JSON Schema (strict mode: `additionalProperties:false`, all fields required) in our OpenAPI and MCP tool definitions; put `AGENTS.md` in every SDK/example repo.

## 9. OpenClaw skills (SKILL.md) and ClawHub
Sources: https://docs.openclaw.ai/clawhub/skill-format , https://docs.openclaw.ai/tools/skills , https://github.com/VoltAgent/awesome-openclaw-skills , https://en.wikipedia.org/wiki/OpenClaw , https://docs.openclaw.ai/llms.txt
- OpenClaw = Peter Steinberger's open-source, self-hosted personal agent (Warelay -> CLAWDIS -> Clawdbot -> Moltbot 2026-01-27 -> OpenClaw 2026-01-30). ~~247k stars (2026-03-02, Wikipedia); secondary sources claim 347k by April 2026 [unverified]~~ **[corrected 2026-09-06] 389k stars / 81.7k forks on github.com/openclaw/openclaw on 2026-09-06 (MIT; README: "developed in the open by the OpenClaw Foundation, a non-profit"). Milestones: 100k stars 2026-02-02, 247k 2026-03-02, >250k ~2026-03-04 (passing React).** OpenClaw Foundation announced 2026-02-14 when Steinberger joined OpenAI (Forbes 2026-02-16 confirms; OpenAI funds, MIT licence locked, elected TSC promised; governance documents not yet published as of mid-April 2026 per secondary). Notable supply-chain incidents (malicious skills, CVE-2026-25253).
- **Skill format**: folder with `SKILL.md` (YAML frontmatter + Markdown; legacy `skill.md`/`skills.md` filenames also accepted **[added 2026-09-06]**). "OpenClaw follows the AgentSkills spec." Required frontmatter on ClawHub: `name` (matches directory, 1–64 lowercase/digits/hyphens), `description`, `version`. Runtime metadata under `metadata.openclaw` (aliases `metadata.clawdbot`, `metadata.clawdis`): `requires.env[]`, `requires.bins[]`, `requires.anyBins[]`, `requires.config[]`, `primaryEnv`, `envVars[{name, required, description}]`, `install[]` (brew/node/go/uv), `emoji`, `homepage`, `os[]`, **`always` (boolean: skill perpetually active) [added 2026-09-06]**. Bundle <= 50 MB; ~40 bounded UTF-8 files embedded for search; MIT-0 licence mandatory; no paid skills. Load order: `<workspace>/skills` > `<workspace>/.agents/skills` > `~/.agents/skills` > `<state>/skills` > workshop skills > bundled/extraDirs. Install: `openclaw skills install @owner/<slug>` (or `npx clawhub install <slug>`); trust envelope verified on install; VirusTotal scanning partnership. **[added 2026-09-06]** ClawHub repo (github.com/openclaw/clawhub, 9.4k stars): `clawhub search|explore|install @owner/slug|list|update --all|skill publish|package publish`; vector search over OpenAI `text-embedding-3-small`; install telemetry; also hosts code/bundle plugins (incl. Nix); security analysis with a "suspicious" filter.
- **[added 2026-09-06] Spec-compatibility trap:** the Agent Skills reference validator (`skills-ref validate`) **errors on any frontmatter key outside `name, description, license, allowed-tools, metadata, compatibility`** ("Unexpected fields in frontmatter"), while ClawHub requires a top-level `version`. A single file cannot satisfy both validators; real clients (Claude Code etc.) ignore unknown keys, so the practical choice is: ship `version` at top level *and* under `metadata.version`, run `skills-ref` only as a warning, and test install on Claude Code + OpenClaw + Codex before publishing. **Needs a test, not more research.**
- **ClawHub scale**: ~~awesome-openclaw-skills curated 5,300+ after filtering out ~7,215 (4,065 spam, 1,040 dupes, 886 crypto/finance, 373 malicious) -> ~12.5k published total.~~ **[corrected 2026-09-06 — counts differ by definition:** 13,729 registered skills by late Feb 2026 (secondary); **26,502 public skills crawled to 2026-03-18** (arXiv 2604.13064, "Red Skills or Blue Skills"; >30% flagged suspicious/malicious by platform signals; Developer Tools >30% of skills); **52,652 packages from 18,358 maintainers, 231k total installs, median 171 downloads/package, top maintainer alone published 1,941, 65% of maintainers published exactly one** (Trent AI, June 2026 — the whole catalogue was <100 days old); ~13.7k "published community-built skills" mid-2026 (DigitalOcean, secondary). The VoltAgent curated list (5.3k after filtering) is the quality-filtered floor. Treat ClawHub as large, young and noisy: a well-named skill wins on description quality, not on being early.**

## 10. Anthropic Agent Skills (open standard, agentskills.io)
Sources: https://agentskills.io/ , https://agentskills.io/specification
- Opened as a public standard 2025-12-18 (secondary). Spec **[re-verified verbatim 2026-09-06]**: `SKILL.md` frontmatter `name` (required, 1–64, lowercase/digits/hyphens, no leading/trailing/double hyphen, must equal directory name, NFKC-normalised), `description` (required, 1–1024 chars, "what + when"), optional `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (experimental, e.g. `Bash(git:*) Read`). No `version` field in the spec (put it in `metadata`). Optional `scripts/`, `references/`, `assets/`. Progressive disclosure: metadata (~100 tokens at startup) -> body (<5k tokens, <500 lines) -> resources on demand. Validator: `skills-ref validate ./my-skill` (Python package; **rejects unknown frontmatter keys**). Repo github.com/agentskills/agentskills: 25.1k stars, 1.9k forks, 145 commits, Apache-2.0 code / CC-BY-4.0 docs **[added 2026-09-06]**.
- **Adopters listed on agentskills.io (2026-09-06, 46 — [corrected 2026-09-06; round 1 said ~45])**: Claude, Claude Code, ChatGPT & Codex, Cursor, Gemini CLI, GitHub Copilot, VS Code, Goose, OpenCode, OpenHands, Amp, Letta, Junie, Kiro, Roo Code, Factory, Spring AI, Databricks Genie Code, Snowflake Cortex Code, Tabnine, Qodo, Mistral Vibe, Hermes Agent, OpenClaw, ZeroClaw, nanobot, fast-agent, Pulumi Neo, Laravel Boost, TRAE, Mux, Emdash, Superconductor, Workshop, Piebald, Command Code, Ona, VT Code, Deep Code, Firebender, Agentman, Vita, Autohand Code CLI, bub, Google AI Edge Gallery, pi.
- **Verdict**: the de-facto "instruction manual" format. One skill = zero-custom-code onboarding for every listed client.

## 11. llms.txt
Sources: https://llmstxt.org/ , https://www.rankability.com/data/llms-txt-adoption/ , https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026
- Format: `/llms.txt` (H1 name, blockquote summary, H2 link sections, `## Optional`), plus `/llms-full.txt`. Proposal by Jeremy Howard (2024-09-03; page modified 2026-08-10). **[re-verified 2026-09-06.]**
- Adoption: 8.7% of Tranco top-1k and 5.6% of top-10k (June 2026; up from 0.3% in June 2025); ~10% of 300k domains (SE Ranking). **[re-verified/expanded 2026-09-06]** HTTP Archive study (caseyrb.com, June 2026): 5.61% of top-10k = 421 sites, ~5.4x growth from 1.04% in July 2025; ~39k sites across top-1M; Shopify 78.1% (automatic platform rollout Apr–May 2026), Contentful 22.9%, AEM 19%, WordPress 8.7%; "none of the major AI search providers have publicly confirmed they read these files". Crawlers almost never fetch it (408 requests out of 500M AI-bot hits in one 90-day study); Google says it does not use it. But coding agents *do* follow it: modelcontextprotocol.io, agentskills.io, docs.openclaw.ai, code.claude.com and ap2-protocol.org all serve `llms.txt` and WebFetch surfaces it. **Ship it; cost is trivial.**

## 12. agents.json (Wildcard AI)
Sources: https://github.com/wild-card-ai/agents-json , https://docs.wild-card.ai/agentsjson/introduction
- v0.1.0, `/.well-known/agents.json`, OpenAPI + `flows` + `links`; 1.3k stars, 75 commits. No ecosystem traction visible in 2026. **Skip** (its ideas are covered by OpenAPI + Arazzo + MCP tools).

## 13. Web Bot Auth
Sources: https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/ , https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/ , https://github.com/cloudflare/web-bot-auth , https://blog.cloudflare.com/verified-bots-with-cryptography/ , https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- Now an IETF **working-group** document: `draft-ietf-webbotauth-httpsig-protocol-00` dated **2026-09-01** (replaces individual draft -02 of 2026-08-19; expires 2027-03-05; Standards Track) **[re-verified 2026-09-06 on datatracker — note that secondary articles dated ≤2026-08-18 still say "not WG-adopted"; they are stale]**. RFC 9421 HTTP Message Signatures with `tag="web-bot-auth"`; headers `Signature`, `Signature-Input`, `Signature-Agent` (origin hosting keys); key directory (JWKS) at **`/.well-known/http-message-signatures-directory`**, media type `application/http-message-signatures-directory+json`; Ed25519 / RSA-PSS test vectors; expiry recommended <= 24 h. Cloudflare Verified Bots accepts it; Akamai, AWS WAF, Vercel, Shopify verify (secondary); Claude, ChatGPT, Perplexity sign (secondary). Libraries: TypeScript + Rust (cloudflare/web-bot-auth), Caddy plugin, Workers examples.
- **[added 2026-09-06] WG facts:** `webbotauth` WG formed 2025-10-23 (Web and Internet Transport area; chairs Rifaat Shekh-Yusef, David Schinazi). Charter milestones: Apr 2026 authentication spec(s); Apr 2026 "conveying additional information about bots" (the `draft-meunier-webbotauth-registry` / Signature-Agent card work); Aug 2026 BCP on key lifecycle/deployment. **Scope explicitly excludes agent-to-agent interfaces, end-user authentication and non-HTTP protocols** — the WG is solving "bot -> human website", not "agent -> agent API". Related: `draft-rescorla-anonymous-webbotauth-01` (2026-07-19, Rescorla/Barnes, individual): anonymous bot authorization and rate-limiting via an "Anchor" that endorses bots, MoLE architecture with Longfellow ZK proofs — sites learn "endorsed by trusted anchor" without learning which bot; "not yet seen significant security analysis".
- **Verdict**: the only standards-track answer to "prove this outbound HTTP request came from agent X". Fits our identity product directly — **with the caveat that for agent-to-agent calls inside our world we are outside the WG's charter and should treat the signature format as a reusable primitive, not as a standard that will name us.**

## 14. OpenAPI as agent contract + Arazzo
Sources: https://spec.openapis.org/arazzo/latest.html (v1.1.0) , https://spec.openapis.org/arazzo/v1.0.1.html , https://www.openapis.org/arazzo-specification
- OpenAPI 3.1 remains the universal contract (OpenAI function tools, MCP tool `inputSchema`, agents.json all derive from JSON Schema). Arazzo 1.0.1 (Jan 2025) -> **1.1.0** describes multi-step workflows across OpenAPI docs; referenced by MCP docs for multi-step flows (secondary). Adoption is tooling-level (Speakeasy, Postman), not agent-level.
- **Verdict**: serve `/openapi.json` (3.1, strict schemas) as the source of truth from which MCP tools and A2A skills are generated; publish an `arazzo.yaml` for the 3–5 canonical multi-step flows (register -> fund wallet -> list service -> accept job -> settle). Cheap, differentiating for agents that plan.

## 15. JSON-RPC conventions
- Both MCP and A2A are JSON-RPC 2.0 over HTTP POST with SSE for streaming. MCP reserves error codes `-32020..-32099`; A2A defines `VersionNotSupportedError`, task-not-found etc. Use a single JSON-RPC dispatcher with method namespaces (`tools/*`, `tasks/*`, `message/*`) and map to the same domain services.

## 16. Cloudflare Agents SDK
Sources: https://github.com/cloudflare/agents , https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- 5.5k stars; v0.20.0 (2026-07-27) = MCP 2026-07-28 client+server; `McpAgent`, `createMcpHandler` (stateless, no Durable Object required); **x402 pay-per-call built in**; A2A example directory; workflows with human-in-the-loop; email; scheduling. Cloudflare is an AAIF platinum member and x402 Foundation co-founder.
- **Verdict**: a primary *client* to test against (both MCP eras, x402).

## 17. NLWeb (Microsoft)
Sources: https://github.com/nlweb-ai/NLWeb , https://en.wikipedia.org/wiki/NLWeb , https://developers.cloudflare.com/ai-search/how-to/nlweb/
- Announced 2025-05-19 (R.V. Guha). `/ask` natural-language endpoint returning Schema.org JSON-LD; every instance is also an MCP server exposing `ask`. 6.3k stars; adopters TripAdvisor, Shopify, Eventbrite, Hearst, O'Reilly, Snowflake. No notable Build 2026 momentum found. **Skip** (an `ask`-style MCP tool over our catalog gives the same effect).

## 18. Payments and on-chain identity standards (adjacent, verified)
- **x402** (https://github.com/coinbase/x402 , https://www.x402.org/): HTTP 402 with `PAYMENT-REQUIRED` (base64 PaymentRequired), client retries with `PAYMENT-SIGNATURE`, server returns `PAYMENT-RESPONSE`; facilitator `/verify` and `/settle`; SDKs `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/stellar`. ~~x402 Foundation under Linux Foundation (formalised 2026-04-02 at MCP Dev Summit; 22 launch members incl. Adyen, AWS, Amex, Circle, Google, Mastercard, Microsoft, Shopify, Solana Foundation, Stripe, Visa).~~ **[corrected 2026-09-06 — two-step timeline:** (1) **2026-04-02** LF press release "launching the x402 Foundation" named 22 initial supporters (Adyen, AWS, Amex, Ampersend.ai, Base, Circle, Cloudflare, Coinbase, Fiserv, Google, KakaoPay, Mastercard, Merit Systems, Microsoft, Polygon Labs, PPRO, Shopify, Sierra, Solana Foundation, Stripe, thirdweb, Visa; Solana "nearly 65% of x402 volume this year"); (2) **2026-07-14** "operational launch" with **40 members** in tiers — 17 Premier (Adyen, AWS, Amex, Circle, Cloudflare, Coinbase, Fiserv, Google, Mastercard, Monad Fdn, MoonPay, Ripple, Shopify, Solana Fdn, Stellar Development Fdn, Stripe, Visa), General (Aleo, Fireblocks, KakaoPay, LayerZero, Merit Systems, NEAR Fdn, Polygon Labs, Quant, SKALE, World Liberty Financial, zerohash, ...), Associate (BSV Assoc., Cardano Fdn, Casper, OMA3, ...). Microsoft is not in the July tiered list.**] x402.org (updated 2026-08-25): last-30-day 75.41M tx, $24.24M volume, 94.06k buyers, 22k sellers **[re-verified 2026-09-06]**. **Reality check [added 2026-09-06]:** Yahoo Finance/Artemis Analytics (2026-08-04): >200M cumulative tx by June 2026 but ">95% of that activity is protocol signaling — machines testing the plumbing"; real commercial volume ≈ **$28k/day**; self-dealing/wash loops "account for a substantial portion"; gas ≈ $0.00025/tx on Solana, ~2 s settlement. Coinbase repo is now "a development fork" of the foundation repo.
- **a2a-x402** (https://github.com/google-agentic-commerce/a2a-x402): A2A extension v0.1; **URI `https://github.com/google-a2a/a2a-x402/v0.1`, declared in the card as `capabilities.extensions[{uri, description, required:true}]`; message metadata keys `x402.payment.status|required|payload|receipts|error`; states ~~payment-required -> payment-submitted -> payment-completed~~ [corrected 2026-09-06: six states — `payment-required`, `payment-submitted`, `payment-rejected`, `payment-verified`, `payment-completed`, `payment-failed`]**; 559 stars.
- **AP2** (https://ap2-protocol.org/ , https://github.com/google-agentic-commerce/AP2): v0.2 (April 2026); roles ~~shopping agent / merchant agent / credentials provider / payment processor~~ **[corrected 2026-09-06: five roles — Shopping Agent, Credential Provider, Merchant, Merchant Payment Processor, Trusted Surface]**; Checkout and Payment mandates (open/closed); cards first, wallets/UPI/PIX/crypto on roadmap; 60+ orgs (LF press); FIDO Alliance involvement; repo 3.2k stars. **[added 2026-09-06] Autonomous flow is specified:** "Human Not Present (Autonomous)" — the user signs *open* Checkout/Payment mandates with `user_sk` on a Trusted Surface (constraints + `cnf` proof-of-possession key, RFC 7800), the Shopping Agent later signs *closed* mandates with `agent_sk` (SD-JWT + key-binding JWT, `sd_hash` binds closed to open, `checkout_jwt` hash links them); merchants can return `unresolved_constraint` to escalate to a human-present flow. Two trust models: "User Credential" (external issuer via OpenID4VP `transaction_data`) and **"Trusted Agent Provider"** (the agent provider signs mandates after obtaining consent) — the latter is the slot our platform can occupy. Mandate type ids `mandate.checkout.1`, `mandate.payment.1`; new types via rDNS/URN names. Shopping-agent-to-shopping-agent delegation is "outside the scope of the current specification". AP2's own A2A extension URI could not be located in the spec/flows/authorization pages **[unverified]**.
- **UCP** (https://ucp.dev/): Google+Shopify+Amazon+Walmart+Stripe+Booking; 60+ endorsers; capability negotiation, catalog, cart, checkout, identity linking via `/.well-known/oauth-authorization-server`; integrates AP2, A2A, MCP. Announced NRF 2026-01-11. Relevant only if we sell to human-facing commerce.
- **ERC-8004 Trustless Agents** (https://eips.ethereum.org/EIPS/eip-8004): Draft (created 2025-08-13; authors De Rossi, Crapis, Ellis, Reppel) **[re-verified 2026-09-06: still Draft]**. Identity registry (ERC-721 agentId + `agentURI` registration file listing A2A/MCP/DID/web endpoints, trust models, optional x402), Reputation registry (scored feedback on-chain with evidence links), Validation registry. ~~Adoption numbers [unverified].~~ **[corrected 2026-09-06]** Live on Ethereum mainnet since 2026-01-29 (secondary). Empirical study arXiv 2606.26028 (ETH/BSC/Base through 2026-05-13): **173,473 registered agents, but valid registration files with endpoints on only 3% (ETH) / 4% (BSC) / 15% (Base)**; Base has the strongest MCP+A2A share (~50% of valid ones); x402 proof-of-payment in 0.6% of Base feedback; **98.7–100% of feedback lacks proof of interaction, 59–91% of reviewers show sybil behaviour, median attack cost $0.003–$0.055** — authors conclude on-chain reputation "cannot function as a trust signal" as designed.

---

## 19. Concrete recommendation: what our platform must expose

All paths relative to `https://<platform-domain>`; per-agent identities get their own origin `https://<agent-id>.agents.<platform-domain>` so RFC 8615 well-knowns work per agent.

### Platform-level
| Path / surface | Standard | Notes |
|---|---|---|
| `POST /mcp` | MCP Streamable HTTP, **dual-era** (2026-07-28 stateless + 2025-11-25/2025-06-18 session) | Implement `server/discover`; honour `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; return `ttlMs`/`cacheScope`; deterministic `tools/list`; extensions `io.modelcontextprotocol/tasks` (long jobs: hire, escrow, settlement) and `io.modelcontextprotocol/oauth-client-credentials`. Avoid elicitation (no humans) — make every parameter explicit in `inputSchema`; use `x-mcp-header` for `agent_id`/`tenant` so the gateway can meter per agent. **Test against Claude Code ≥2.1.232 (modern), Cloudflare Agents ≥0.20 (modern), OpenAI Agents SDK / Cursor (legacy until proven) [added 2026-09-06].** |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | RFC 9728 | `authorization_servers: ["https://auth.<platform>"]`, `scopes_supported`. |
| `GET /.well-known/oauth-authorization-server` (+ `/.well-known/openid-configuration`) | RFC 8414 / OIDC | `client_id_metadata_document_supported: true`, `registration_endpoint` (DCR fallback), `token_endpoint` supporting `client_credentials` and `urn:ietf:params:oauth:grant-type:jwt-bearer`; `iss` in auth responses (RFC 9207). |
| `GET /.well-known/agent-card.json` (+ `/.well-known/agent.json` alias) | A2A v1.0 | Platform's own card: skills `discover_agents`, `hire`, `pay`, `message`; `supportedInterfaces` with both `JSONRPC` and `HTTP+JSON`; `capabilities.pushNotifications: true`; JWS-signed. **Declare `capabilities.extensions[{uri:"https://github.com/google-a2a/a2a-x402/v0.1"}]` [added 2026-09-06].** |
| `POST /a2a` (JSON-RPC) and `/a2a/v1/*` (HTTP+JSON) | A2A v1.0 (v1.0.1: `application/a2a+json`) | `A2A-Version: 1.0`; `message/send`, `message/stream`, `tasks/*`, push-notification configs. Marketplace jobs are A2A Tasks. |
| `GET /.well-known/http-message-signatures-directory` | Web Bot Auth | Platform JWKS; per-agent directories under each agent origin. Accept `Signature`/`Signature-Input`/`Signature-Agent` as an inbound auth method too. |
| `GET /openapi.json`, `GET /arazzo.yaml` | OpenAPI 3.1, Arazzo 1.1 | Strict JSON Schema (OpenAI `strict` compatible). Generate MCP tools and A2A skills from this single source. |
| `GET /llms.txt`, `GET /llms-full.txt` | llms.txt | Point at OpenAPI, MCP endpoint, skill, quickstart-for-agents. |
| `GET /v0.1/servers` (MCP Registry OpenAPI) | MCP registry subregistry | Expose every marketplace agent's MCP surface so hosts/aggregators can ingest us; also **act as an A2A registry** (spec leaves registry API undefined — we define it and expose it as MCP tools + REST). **Mirror the live registry shape `{servers[], metadata{nextCursor,count}}` and the `server.json` `$schema` 2025-12-11; align our A2A registry with discussion #741's `GET /agents/public`, `POST /agents/search` names so a future spec is a rename, not a rewrite [added 2026-09-06].** |
| `402` responses with `PAYMENT-REQUIRED`; `POST /x402/verify`, `POST /x402/settle` | x402 | Platform wallet = facilitator; support a2a-x402 extension URI in cards for agent-to-agent paid tasks; AP2 mandates for card rails. **Position the platform as an AP2 "Trusted Agent Provider" that signs closed mandates for its agents under user-signed open mandates [added 2026-09-06].** |
| `GET /.well-known/agent-descriptions` (optional) | ANP-08 | JSON-LD CollectionPage listing agents; ~1 h of work. |
| OASF record export (optional) | AGNTCY | `dirctl push` our catalog to the LF Agent Directory. |

### Per-agent (identity product)
| Path | Standard | Purpose |
|---|---|---|
| `https://<id>.agents.<domain>/.well-known/agent-card.json` | A2A | Agent's public capabilities; signed by platform key + agent key. |
| `https://<id>.agents.<domain>/client-metadata.json` | MCP CIMD | Portable OAuth client_id for the agent usable against *any* MCP server's AS. |
| `https://<id>.agents.<domain>/.well-known/http-message-signatures-directory` | Web Bot Auth | Agent's signing keys; platform signs on the agent's behalf or agent holds its own key. |
| `https://<id>.agents.<domain>/.well-known/jwks.json` | JWKS | For `private_key_jwt` / RFC 7523 assertions. |
| Optional: ERC-8004 registration file export, `did:web` document | ERC-8004 / DID | On-chain and DID projections of the same identity. **Given the 2606.26028 findings, our off-chain, interaction-verified reputation is the differentiator; the ERC-8004 export is a marketing projection, not a trust source [added 2026-09-06].** |

### Distribution
- Publish `SKILL.md` (Agent Skills spec + `metadata.openclaw.requires.env: [PLATFORM_API_KEY]`, `primaryEnv`, `install`) to ClawHub (`openclaw skills install @<org>/<slug>`), GitHub, and the agentskills ecosystem; keep `description` <=1024 chars phrased as triggers ("Use when an agent needs to find, hire, pay, or message other agents..."). **Resolve the `version`-key conflict (§9) by testing on Claude Code, OpenClaw and Codex before publishing [added 2026-09-06].**
- Publish `server.json` to the official MCP registry under `com.<ourdomain>/*` (DNS-verified namespace) — this is how Claude, ChatGPT, Cursor and aggregators surface us.
- `AGENTS.md` in every SDK/example repo.

---

## 20. Non-obvious insights
1. **MCP CIMD turns "agent identity" into "a URL we host".** Since 2026-07-28 deprecates DCR in favour of Client ID Metadata Documents, an agent's OAuth identity is an HTTPS document. Hosting one per agent makes our identities usable against every MCP server's authorization server with no registration — a distribution channel for our identity product. **[strengthened 2026-09-06: CIMD is now an IETF OAuth WG draft and Claude Code auto-discovers it.]**
2. **Stateless MCP + header routing is a billing primitive.** `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` let us meter and rate-limit per tool per agent at the edge without parsing bodies; design tool params with `x-mcp-header` from day one. (GitHub's MCP server already uses exactly this for logging/secret scanning.)
3. **A2A explicitly leaves registries undefined; MCP's registry is "not for hosts".** Both winners want *downstream* directories. Our marketplace should present itself as an A2A registry and as an MCP subregistry implementing the official OpenAPI — that is the lane nobody owns yet (AGNTCY is trying with 184 stars; A2A discussion #741 has been open 15 months).
4. **The human-in-the-loop primitives are the dividing line.** MRTR/elicitation (MCP) and `INPUT_REQUIRED`/`AUTH_REQUIRED` (A2A) exist for humans. For a zero-human platform, all tools must be fully parameterised and long work must go through Tasks with polling/push, or agents will stall.
5. **Skills beat docs.** Agents load the `description` of every installed skill at startup (~100 tokens). One well-written SKILL.md gets us into 46 agent runtimes' selection loop; llms.txt does not.
6. **Payments converged faster than identity — but the volume is mostly noise.** x402 has an LF foundation with Visa/Mastercard/Stripe and 75M tx/month, yet >95% is protocol signalling and real commerce is ~$28k/day. **[corrected 2026-09-06]** The rails are real; the economy is not yet. Our wallet should ride x402/AP2 and our *reputation* product should be the thing that makes a 402 worth paying; agent identity is still fragmented (OAuth CIMD vs Web Bot Auth vs did:wba vs ERC-8004 vs AGNTCY badges) and ERC-8004's 173k registrations are 85–97% placeholders. Our identity layer can be the aggregator that projects one identity into all four formats.
7. **The 2026-07-28 transition is the client-compat trap.** ~~Claude/ChatGPT/Cursor were still rolling out in Aug 2026;~~ **[corrected 2026-09-06] Claude Code (v2.1.232+), Cloudflare Agents and GitHub's server are already modern; ChatGPT, Cursor and the OpenAI Responses MCP tool show no public 2026-07-28 support.** The only safe move for a Sept-2026 launch is still dual-era on one endpoint (Cloudflare's `createMcpHandler` pattern).
8. **Governance has consolidated under one roof.** MCP (Dec 2025), AGENTS.md, goose, agentgateway, A2A (Aug 2026), x402 Foundation (Apr/Jul 2026) and AGNTCY are all Linux Foundation; anything outside (ANP/W3C CG, agents.json, Agora, NLWeb, WebMCP/W3C CG) is unlikely to win in our lane.
9. **[added 2026-09-06] AP2's autonomous mode needs a "Trusted Agent Provider".** The spec's human-not-present flow requires someone to sign closed mandates with an agent key under a user-signed open mandate, or a provider on a trust list to vouch. A platform that holds agent keys, enforces spend constraints and is on merchants' trust lists *is* that provider — a role no one has claimed for headless agents.
10. **[added 2026-09-06] Web Bot Auth will not name agents for us.** Its WG charter is bot-to-website; the anonymous variant (Rescorla/Barnes) even hides bot identity behind an "Anchor". For agent-to-agent identity we should reuse RFC 9421 + the JWKS directory format as a primitive, but expect verifiers to keep vendor allowlists; our value is being the Anchor/directory that other verifiers can trust.

## 21. Open questions
- ~~When will Claude Code / ChatGPT / Cursor complete 2026-07-28 rollout,~~ **[answered 2026-09-06 for Claude Code: shipped in v2.1.232+; still open for ChatGPT/Cursor/OpenAI Responses]** and will they support `io.modelcontextprotocol/oauth-client-credentials` for headless use, or only user-delegated flows? (Still no client in the official matrix lists it.)
- Will the MCP registry reach GA with a stable subregistry contract in 2026, and will it index A2A cards or Agent Skills (AGNTCY dir already does all three)? **[still preview on 2026-09-06]**
- Does A2A v1.x standardise a registry API or card-signing key discovery (JWKS location)? Spec section 14.3 registers a well-known URI; the exact string could not be extracted from the spec page (discovery doc says `/.well-known/agent-card.json`). **[registry: still discussion #741, no spec; well-known re-confirmed 2026-09-06]**
- Will the Web Bot Auth WG define a per-agent (not per-vendor) key model suitable for millions of agents, or will verifiers keep an allowlist of big bots? **[2026-09-06: charter excludes agent-to-agent; anonymous-credential variant proposed — allowlists likely persist]**
- ~~ERC-8004 and AGNTCY identity traction numbers — unverified.~~ **[ERC-8004 answered 2026-09-06 (173k registrations, 3–15% valid); AGNTCY still unverified]**
- ~~AP2 extension URI string, and whether AP2 v0.2 mandates can be issued by an autonomous agent without a human "intent" signature~~ **[answered 2026-09-06: autonomous flow exists but is rooted in a user-signed open mandate or a Trusted Agent Provider; extension URI still not located]**
- **[new 2026-09-06]** Exact ship date of Claude Code v2.1.232 and whether the `oauth-client-credentials` extension is honoured by the v2 runtime in non-interactive (`-p`) mode.
- **[new 2026-09-06]** Does ClawHub's validator accept `version` only under `metadata`, or is top-level `version` mandatory? (Determines whether one SKILL.md can pass both validators.)

---

## 22. All URLs consulted
### MCP
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://blog.modelcontextprotocol.io/posts/mcp-roadmap/
- https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
- https://modelcontextprotocol.io/extensions/overview
- https://modelcontextprotocol.io/extensions/tasks/overview
- https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/registry/about
- https://modelcontextprotocol.io/llms.txt
- https://github.com/modelcontextprotocol/modelcontextprotocol/releases
- https://github.com/modelcontextprotocol/registry
- https://registry.modelcontextprotocol.io/
- https://claude.com/blog/bringing-mcp-2026-07-28-to-claude
- https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
- https://www.infoq.com/news/2026/08/azure-devops-remote-mcp-ga/
- https://hidekazu-konishi.com/entry/mcp_specification_version_timeline.html
- https://www.truefoundry.com/blog/mcp-2026-07-28-spec-apps-tasks-governance-revisited
- https://github.com/microsoft/mcp-for-beginners/blob/main/01-CoreConcepts/mcp-2026-07-28-release-candidate.md
### A2A / ACP / AAIF
- https://a2a-protocol.org/latest/specification/
- https://a2a-protocol.org/latest/topics/agent-discovery/
- https://github.com/a2aproject/A2A
- https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html
- https://learn.microsoft.com/en-us/agent-framework/migration-guide/agent-to-agent-sdk-v1
- https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/
- https://github.com/google/adk-python/issues/2535
- https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/ (403; search snippet only)
- https://www.axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards (403; search snippet only)
- https://aimagazine.com/news/why-did-googles-a2a-join-the-agentic-ai-foundation
- https://blog.pebblous.ai/blog/a2a-mcp-agentic-ai-foundation-authorization/en/
- https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- https://agents.md/
- https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/
- https://github.com/orgs/i-am-bee/discussions/5
- https://zylos.ai/research/2026-04-18-agent-to-agent-interoperability-protocols/
- https://en.wikipedia.org/wiki/Agent2Agent
### ANP / Agora / AGNTCY / LangChain
- https://github.com/agent-network-protocol/AgentNetworkProtocol
- https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/08-ANP-Agent-Discovery-Protocol-Specification.md
- https://agentnetworkprotocol.com/en/specs/
- https://w3c-cg.github.io/ai-agent-protocol/
- https://datatracker.ietf.org/doc/html/draft-zyyhl-agent-networks-framework-01
- https://agoraprotocol.org/docs/protocol/specification
- https://github.com/agora-protocol/paper-demo
- https://arxiv.org/pdf/2504.16736
- https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos
- https://docs.agntcy.org/
- https://dir.agntcy.org/latest/
- https://github.com/agntcy/dir
- https://github.com/agntcy/oasf
- https://schema.oasf.agntcy.org/
- https://docs.agntcy.org/oasf/open-agentic-schema-framework/
- https://github.com/langchain-ai/agent-protocol/releases
- https://github.com/langchain-ai/langchain-mcp-adapters
### OpenAI / frameworks / Cloudflare
- https://developers.openai.com/api/docs/guides/tools
- https://openai.github.io/openai-agents-python/mcp/
- https://docs.crewai.com/en/mcp/overview
- https://adk.dev/tools/mcp-tools/ (redirect page only)
- https://github.com/cloudflare/agents
- https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- https://developers.cloudflare.com/changelog/post/2026-02-25-agents-sdk-v0.6.0/
### OpenClaw / Agent Skills / AGENTS.md / llms.txt / agents.json
- https://docs.openclaw.ai/clawhub/skill-format
- https://docs.openclaw.ai/tools/skills
- https://docs.openclaw.ai/cli/mcp
- https://docs.openclaw.ai/channels/a2a
- https://docs.openclaw.ai/llms.txt
- https://github.com/VoltAgent/awesome-openclaw-skills
- https://en.wikipedia.org/wiki/OpenClaw
- https://www.jitendrazaa.com/blog/ai/clawdbot-complete-guide-open-source-ai-assistant-2026/
- https://agentskills.io/
- https://agentskills.io/specification
- https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/
- https://medium.com/@automation.labs/skill-md-is-becoming-the-rest-of-agents-nobody-told-you-yet-f5de9a5859c3
- https://llmstxt.org/
- https://www.rankability.com/data/llms-txt-adoption/
- https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026
- https://github.com/wild-card-ai/agents-json
- https://docs.wild-card.ai/agentsjson/introduction
### Web Bot Auth / OpenAPI / Arazzo / NLWeb
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
- https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/
- https://www.ietf.org/archive/id/draft-meunier-webbotauth-registry-01.html
- https://github.com/cloudflare/web-bot-auth
- https://blog.cloudflare.com/verified-bots-with-cryptography/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- https://spec.openapis.org/arazzo/latest.html
- https://spec.openapis.org/arazzo/v1.0.1.html
- https://www.openapis.org/arazzo-specification
- https://github.com/nlweb-ai/NLWeb
- https://en.wikipedia.org/wiki/NLWeb
- https://developers.cloudflare.com/ai-search/how-to/nlweb/
### Payments / on-chain identity
- https://github.com/coinbase/x402
- https://www.x402.org/
- https://github.com/google-agentic-commerce/a2a-x402
- https://github.com/google-agentic-commerce/AP2
- https://ap2-protocol.org/
- https://ucp.dev/
- https://eips.ethereum.org/EIPS/eip-8004
- https://www.cobo.com/post/ap2-protocol-complete-guide-to-agent-payments-for-web3-developers-2026
- https://cryptobriefing.com/coinbase-x402-protocol-100m-transactions-base/
- https://medium.com/@adnanmasood/agentic-payments-101-2-2-payment-standards-and-protocols-acp-ucp-ap2-and-x402-26486e6d511f

---

## Round 2 (2026-09-06): verification, corrections, gaps filled

Method: 20 targeted WebSearch queries (session budget then exhausted at 200/200) plus ~45 direct WebFetch calls against primary sources (spec pages, changelogs, GitHub repos, IETF datatracker, LF press releases, x402.org, arXiv). Secondary sources are used only for numbers that no primary source publishes and are labelled as such.

### 23.1 Verification of the 10 most decision-relevant round-1 claims

| # | Round-1 claim | Verdict | Evidence (2026-09-06) |
|---|---|---|---|
| 1 | MCP `2026-07-28` is current, stateless (no `initialize`, no `Mcp-Session-Id`), `server/discover` mandatory, `Mcp-Method`/`Mcp-Name` headers required, MRTR, DCR deprecated for CIMD | **Confirmed** | Official changelog re-read verbatim; every bullet in §1.1 matches. Draft changelog for the next revision is empty. |
| 2 | MCP registry is still preview; ~9.6k servers | **Confirmed (status) / Corrected (count)** | About page still shows the preview banner. Count is 18,849 (18,650 active) per the 2026-07-28 MCP Queen probe report; the May figure was stale. |
| 3 | A2A v1.0 released 2026-03-12; card at `/.well-known/agent-card.json`; joined AAIF 2026-08-17 | **Confirmed** | a2a-protocol.org 2026-03-12 announcement (primary); discovery page quotes the path; aaif.io blog dated 2026-08-17. Added: v1.0.1 on 2026-05-28. |
| 4 | Agent Skills spec fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`); ~45 adopters | **Confirmed / count refined to 46** | Spec page re-read; client list on agentskills.io enumerated (46). Added: validator rejects unknown keys. |
| 5 | OpenClaw SKILL.md follows Agent Skills; ClawHub requires `name`/`description`/`version`, `metadata.openclaw.*`, 50 MB, MIT-0, no paid skills | **Confirmed** | docs.openclaw.ai/clawhub/skill-format re-read. Added `always` field, legacy filenames, `clawhub` CLI. |
| 6 | OpenClaw 247k stars (Mar 2026), 347k (Apr) unverified | **Corrected** | GitHub shows 389k stars / 81.7k forks on 2026-09-06. Steinberger -> OpenAI 2026-02-14 confirmed (Forbes 2026-02-16). |
| 7 | x402: 75.4M tx / $24.2M in 30 days; LF foundation formalised 2026-04-02 with 22 members | **Confirmed (x402.org numbers) / Corrected (timeline + meaning)** | x402.org still shows 75.41M / $24.24M (updated 2026-08-25). LF: 2026-04-02 announcement (22 names) then 2026-07-14 operational launch (40 members, 3 tiers). Artemis/Yahoo (2026-08-04): >95% signalling, ~$28k/day real. |
| 8 | Web Bot Auth is WG draft `draft-ietf-webbotauth-httpsig-protocol-00` dated 2026-09-01 | **Confirmed** | Datatracker: rev 00, 2026-09-01, expires 2027-03-05, Standards Track, webbotauth WG. Added: WG formed 2025-10-23, charter excludes agent-to-agent. |
| 9 | llms.txt at 8.7% of top-1k (June 2026), 5.6% of top-10k | **Confirmed** | Rankability and caseyrb.com (HTTP Archive) both re-fetched; 421/7,504 top-10k sites. |
| 10 | MCP 400M+ monthly SDK downloads; "rolling out soon" to Claude products; Claude/ChatGPT/Cursor not yet on 2026-07-28 | **Confirmed (downloads) / Corrected (rollout)** | claude.com blog re-verified. Claude Code v2.1.232+ "v2 runtime" negotiates 2026-07-28 with HTTP servers; CHANGELOG v2.1.238 references `server/discover`. ChatGPT/Cursor/OpenAI still show no public support. |

Also re-verified without change: `A2A-Version` header; a2a-x402 repo (559 stars); AP2 v0.2; ERC-8004 still Draft; AGENTS.md 60k+ and AAIF-stewarded; OAuth Client Credentials extension listed by no client in the matrix.

### 23.2 Corrections made in place (all tagged in the body)
1. Official MCP registry count: ~9.6k (May 2026) -> **18,849 / 18,650 active (2026-07-28)**; `server.json` `$schema` in live API is `2025-12-11`.
2. Claude Code 2026-07-28 support: "rolling out" -> **shipped in v2.1.232+ (v2 runtime; `MCP_PROTOCOL_NEGOTIATION`)**; insight #7 and the open-questions list updated accordingly.
3. OpenClaw stars: 247k/347k -> **389k (2026-09-06)**; ClawHub size restated as a range by definition (26.5k skills Mar 2026; 52.7k packages Jun 2026; 13.7k "published" mid-2026; 5.3k curated).
4. Agent Skills adopters: ~45 -> **46** (full list in §10).
5. x402 Foundation: single "22 members 2026-04-02" -> **two-step: 22 names announced 2026-04-02; 40 members / 3 tiers at operational launch 2026-07-14**; Microsoft absent from the July tier list. Headline volume now carries the Artemis ">95% signalling / ~$28k per day real" caveat.
6. a2a-x402 states: 3 -> **6** (`payment-required`, `payment-submitted`, `payment-rejected`, `payment-verified`, `payment-completed`, `payment-failed`); extension URI `https://github.com/google-a2a/a2a-x402/v0.1` added.
7. AP2 roles: 4 -> **5** (adds Trusted Surface); autonomous "Human Not Present" flow documented; "outside scope" for agent-to-agent delegation.
8. ERC-8004: "adoption unverified" -> **mainnet since 2026-01-29; 173,473 registrations, 3–15% valid; reputation registry judged unusable as a trust signal (arXiv 2606.26028)**.
9. A2A v1.0 date: promoted from "secondary" to **primary-confirmed**; v1.0.1 (2026-05-28) added.
10. Tasks extension opt-in wording clarified (per-request `clientCapabilities.extensions`, no per-tool flag).

### 23.3 Gaps filled

**MCP spec and registry status.** Current = `2026-07-28` (fifth release); no successor draft has accumulated changes as of 2026-09-06; the only forward signal is the 2026-08-22 roadmap (agent identity: DPoP, workload identity federation, token exchange; transport unification; Tasks maturation; progressive discovery). Registry: preview, v0.1 API, no GA date; hosts are told to consume downstream registries — the subregistry OpenAPI is the contract we should implement. Server-side adoption of the stateless spec is real (GitHub MCP Server 2026-07-23, Cloudflare Agents 0.20.0 2026-07-27); client-side it is Claude Code and Cloudflare only, publicly.

**A2A version and card path.** v1.0.0 (2026-03-12), v1.0.1 (2026-05-28, prefers `application/a2a+json`); card at `/.well-known/agent-card.json`; `A2A-Version` header; three bindings; JWS-signed cards; registry API still undefined (discussion #741 open since 2025-06-10, last movement 2026-05-26). AAIF now hosts MCP, A2A, AGENTS.md, goose and agentgateway; platinum members AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI; board chair David Nalley (AWS), TC chair David Soria Parra (Anthropic).

**OpenClaw SKILL.md format.** As in §9 plus: `always` flag; legacy `skill.md`/`skills.md`; ClawHub CLI verbs; embeddings-based search (so the `description` and body text are literally the ranking signal); 50 MB bundle; MIT-0; no paid skills. The registry is <9 months old, has 18k+ maintainers and heavy spam (40% "suspicious" on VirusTotal; 4 confirmed malicious in the June sample; >30% flagged in the March academic crawl).

**Anthropic Agent Skills spec.** Six frontmatter keys, strict validator, progressive-disclosure budgets (~100 tokens / <5k tokens / <500 lines), 46 listed clients, repo 25.1k stars. The spec has no `version`; ClawHub requires one — a real packaging conflict to test (§9).

**llms.txt adoption.** 8.7% top-1k, 5.61% top-10k (421 sites), ~10% of 300k domains, ~39k of top-1M; Shopify's automatic rollout dominates platform stats; no major AI provider confirms reading it; growth 5.4x YoY. Verdict unchanged: ship, expect coding agents (not crawlers) to use it.

**What is winning in 2026 (synthesis of primary data + three analyses: philippdubach 2026-03, dev.to/alexmerced 2026-07-07, Zylos 2026-03/04).**
- Agent -> tool: **MCP**, settled. 400M+ monthly SDK downloads, 18.8k registry servers, every relevant client. Debate has moved to auth interop and the stateless migration, not to alternatives.
- Agent <-> agent: **A2A**, consolidated. v1.0 + AAIF + Azure/Bedrock/Copilot Studio shipping. "Different floors of the same building" is the consensus framing; no credible rival (ACP merged, ANP regional, Agora academic).
- Instructions/packaging: **Agent Skills / SKILL.md** (46 clients) for procedures, **AGENTS.md** (60k+ repos) for repos. llms.txt is a hygiene item.
- Payments: **x402** rails + **AP2** mandates have the institutions (Visa, Mastercard, Stripe, Amex, Adyen, Fiserv, AWS, Google, Cloudflare, Shopify) but not yet the commerce; UCP is human-commerce only.
- Identity: **no winner.** CIMD (OAuth client identity, now IETF OAuth WG), Web Bot Auth (bot -> website, WG scoped away from agent-to-agent), ERC-8004 (large but hollow), AGNTCY/did:wba (niche). This is the open lane for us.
- Browser-side: **WebMCP** (W3C WebML CG draft, latest 2026-09-04; editors Microsoft + Google; `document.modelContext.registerTool()`; Chrome 146 Canary Feb 2026, Chrome 149 origin trial May 2026 — secondary) is human-present and irrelevant to an API-first platform. OSI (Open Semantic Interchange, Snowflake-led, Jan 2026) is data-semantics only.

**Payments reality check.** x402.org's 75M tx/30 days is accurate as reported, but Artemis/CoinDesk-derived analysis (2026-08-04) puts real commercial volume at ~$28k/day with heavy self-dealing; Solana carries ~65% of volume. AP2 v0.2 answers the round-1 question about autonomy: human-not-present flows exist and are rooted in a user-signed open mandate (SD-JWT, `cnf` PoP key) or a **Trusted Agent Provider** that signs on the agent's behalf — the role our wallet + identity layer can occupy. Shopping-agent-to-shopping-agent delegation is explicitly out of scope, which leaves marketplace-style agent-to-agent settlement to a2a-x402 (six-state machine, URI above).

**Identity reality check.** Web Bot Auth: WG draft -00 (2026-09-01), charter milestones already slipped past April/August 2026, scope excludes agent-to-agent; an anonymous-credential variant (Rescorla/Barnes, 2026-07-19) is on the table. ERC-8004: 173k registrations but 85–97% placeholders, reputation feedback 98.7–100% unverified, sybil rate 59–91%, attack cost cents. Conclusion for our reputation product: interaction-verified, off-chain, with optional on-chain projection — the study is effectively a requirements list for what ERC-8004 lacks (proof of interaction, bounded scales, sybil resistance).

**Client rollout matrix for 2026-07-28 (public evidence only).**
| Client | 2026-07-28 core | CIMD | DCR | Client-credentials ext | Tasks ext |
|---|---|---|---|---|---|
| Claude Code ≥2.1.232 | Yes (HTTP + connectors; stdio opt-in) | Yes (auto) | Yes | not documented | not documented |
| Cloudflare Agents ≥0.20.0 | Yes (client + server) | n/a | n/a | n/a | n/a |
| GitHub MCP Server (server) | Yes (dual) | n/a | n/a | n/a | n/a |
| OpenAI Responses MCP tool | not documented (Streamable HTTP/SSE; bearer per request) | no | no | no | no |
| OpenAI Agents SDK | probes newest then falls back (SDK v2) | — | — | — | — |
| ChatGPT | not documented; Tasks feature request pending **[unverified]** | — | — | — | — |
| Cursor | not documented (MCP Apps yes; static client id/secret) | — | — | — | — |

### 23.4 Decision deltas versus round 1
- **No change to the core stack** (MCP dual-era + A2A + OAuth well-knowns + SKILL.md + x402/AP2 + Web Bot Auth + llms.txt/openapi). Round 2 strengthens every "must" and weakens nothing.
- **Raise priority of the reputation product**: the ERC-8004 study shows the on-chain approach is broken by design; a verified, interaction-bound reputation is the scarce asset.
- **Claim the AP2 "Trusted Agent Provider" role** for autonomous agents; it is specified, unclaimed, and maps to holding agent keys + spend constraints.
- **Treat x402 volume as marketing, not demand**; size the wallet for many tiny settlements (gas ~$0.00025) and expect real revenue to come from the marketplace, not from payment fees.
- **Build the A2A registry now** using discussion #741's endpoint names so it survives standardisation; also implement the MCP subregistry OpenAPI with the live `{servers, metadata}` shape.
- **Run a packaging test** (SKILL.md on Claude Code, OpenClaw, Codex) before publishing to resolve the `version` key conflict.
- **Add Claude Code v2.1.232+ to the CI compatibility matrix** as a modern client; keep legacy paths for OpenAI/Cursor.

### 23.5 Still unverified after round 2
- Exact ship date of Claude Code v2.1.232 (inferred mid-August 2026); existence/behaviour of `MCP_OAUTH_CLIENT_ID`/`MCP_OAUTH_CLIENT_SECRET` env vars (env-vars page truncated in fetch).
- AP2's A2A extension URI string (spec, flows and authorization pages fetched; none state it).
- ChatGPT / Cursor / OpenAI Responses support for 2026-07-28 (docs silent; community thread not fetchable).
- AGNTCY directory traction; ANP "AP2" doc; Google ADK `McpToolset` page.
- ClawHub validator behaviour for `metadata.version` vs top-level `version`.
- Secondary-only numbers: AAIF "250+ members", A2A "150+ orgs", ClawHub "13.7k published", WebMCP Chrome timeline, ERC-8004 mainnet date 2026-01-29.

### 23.6 URLs used in round 2 (in addition to §22)
**MCP**
- https://modelcontextprotocol.io/specification/2026-07-28/changelog (re-read)
- https://modelcontextprotocol.io/specification/draft/changelog
- https://modelcontextprotocol.io/registry/about (re-read)
- https://registry.modelcontextprotocol.io/v0.1/servers?limit=1
- https://modelcontextprotocol.io/extensions/tasks/overview (re-read)
- https://modelcontextprotocol.io/extensions/client-matrix (re-read)
- https://mcpqueen.com/reports/state-of-mcp-2026-07
- https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/
- https://techcommunity.microsoft.com/blog/appsonazureblog/mcp-just-went-stateless-%E2%80%94-what-the-2026-spec-changes-about-scaling-on-app-servic/4530222
- https://blog.wu-boy.com/2026/09/mcp-2026-07-28-spec-update-en/
- https://www.truefoundry.com/blog/best-mcp-registries
- https://tooldirectory.ai/blog/state-of-mcp-servers-2026
- https://eu.36kr.com/en/p/3916379879861638
**Claude Code / OpenAI / Cursor clients**
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/env-vars (truncated)
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://releasebot.io/updates/anthropic/claude-code
- https://www.gradually.ai/en/changelogs/claude-code/ (429)
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- https://developers.openai.com/api/docs/changelog
- https://openai.com/index/the-next-evolution-of-the-agents-sdk/ (403)
- https://community.openai.com/t/feature-request-support-mcp-tasks-extension-sep-2663-mcp-2026-07-28-in-chatgpt-developer-mode/1391486 (404)
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (403)
- https://cursor.com/docs/context/mcp
- https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/ (re-read via search)
**A2A / AAIF**
- https://a2a-protocol.org/latest/announcing-1.0/ (redirect)
- https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/
- https://a2a-protocol.org/latest/specification/ (re-read)
- https://a2a-protocol.org/latest/topics/agent-discovery/ (re-read)
- https://github.com/a2aproject/A2A/releases
- https://github.com/a2aproject/A2A/discussions/741
- https://aaif.io/blog/a2a-joins-aaif
- https://aaif.io/projects/agent2agent
- https://aaif.io/
- https://aaif.io/about
- https://tech.yahoo.com/ai/gemini/articles/google-a2a-protocol-joins-aaif-020554895.html
- https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/ (snippet)
- https://stellagent.ai/insights/a2a-protocol-google-agent-to-agent
- https://tyk.io/learning-center/a2a-protocol-architecture-and-technical-specification/
**Agent Skills / OpenClaw / ClawHub**
- https://agentskills.io/ (client list enumerated)
- https://agentskills.io/specification (re-read)
- https://github.com/agentskills/agentskills
- https://github.com/agentskills/agentskills/blob/main/skills-ref/README.md
- https://raw.githubusercontent.com/agentskills/agentskills/main/skills-ref/src/skills_ref/validator.py
- https://docs.openclaw.ai/clawhub/skill-format (re-read)
- https://github.com/openclaw/openclaw
- https://github.com/openclaw/clawhub
- https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md
- https://trent.ai/blog/clawhub-by-the-numbers/
- https://arxiv.org/html/2604.13064v1
- https://www.digitalocean.com/resources/articles/what-are-openclaw-skills
- https://www.forbes.com/sites/ronschmelzer/2026/02/16/openai-hires-openclaw-creator-peter-steinberger-and-sets-up-foundation/
- https://inbounter.com/blog/openclaw-2026-timeline
- https://agentman.ai/blog/agent-skills-ecosystem-report-2026
**llms.txt / AGENTS.md**
- https://llmstxt.org/ (re-read)
- https://www.rankability.com/data/llms-txt-adoption/ (re-read)
- https://caseyrb.com/blog/state-of-llms-txt-adoption/
- https://presenc.ai/research/state-of-llms-txt-2026
- https://agents.md/ (re-read)
**Web Bot Auth / identity**
- https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/ (re-read)
- https://mailarchive.ietf.org/arch/msg/ietf-announce/4KzSkxT7SqWCtMKcksC5dh5J1Gs/ (WG formation)
- https://datatracker.ietf.org/doc/draft-rescorla-anonymous-webbotauth/
- https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture
- https://nerdleveltech.com/web-bot-auth-ietf-standard-agent-verification (stale as of 2026-08-18)
**Payments / on-chain**
- https://www.x402.org/ (re-read)
- https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol
- https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications
- https://finance.yahoo.com/markets/crypto/articles/x402-foundation-activated-27-old-152440828.html
- https://presenc.ai/research/x402-protocol-adoption-tracker-2026
- https://raw.githubusercontent.com/google-agentic-commerce/a2a-x402/main/spec/v0.1/spec.md
- https://github.com/google-agentic-commerce/a2a-x402 (re-read)
- https://github.com/google-agentic-commerce/AP2 (re-read)
- https://raw.githubusercontent.com/google-agentic-commerce/AP2/main/README.md
- https://ap2-protocol.org/ (re-read)
- https://ap2-protocol.org/llms.txt
- https://ap2-protocol.org/ap2/specification/index.md
- https://ap2-protocol.org/ap2/agent_authorization/index.md
- https://ap2-protocol.org/ap2/flows/index.md
- https://eips.ethereum.org/EIPS/eip-8004 (re-read)
- https://arxiv.org/html/2606.26028
- https://github.com/sudeepb02/awesome-erc8004
**"What is winning" analyses / WebMCP**
- https://philippdubach.com/posts/mcp-vs-a2a-in-2026-how-the-ai-protocol-war-ends/
- https://dev.to/alexmercedcoder/the-state-of-agentic-ai-standards-in-2026-mcp-a2a-webmcp-osi-and-the-protocol-stack-taking-3o2l
- https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/
- https://www.glukhov.org/ai-systems/comparisons/a2a-protocol-2026-adoption/
- https://webmachinelearning.github.io/webmcp/
- https://www.webfuse.com/webmcp-cheat-sheet
- https://arxiv.org/pdf/2606.31498 (Governance Gaps in Agent Interoperability Protocols — not fetched)

# Agent Interoperability Protocols and Standards — Research Notes

**Slug:** interop-protocols
**Date:** 2026-09-05
**Author:** strategy research subagent
**Scope:** Which agent interop protocols/standards our "small world for AI agents" platform (identity, wallets/payments, agent-to-agent marketplace, messaging, reputation; zero humans in the loop) should speak natively so that Claude Code, OpenClaw, LangGraph/CrewAI, OpenAI Agents SDK, Cloudflare Agents and custom scripts can use it with zero custom code.

Everything below was verified against a primary or near-primary online source on 2026-09-05 unless marked **[unverified]**. The session web-search budget was exhausted mid-task; the final gaps were filled with direct fetches of official docs.

---

## 0. Executive summary (what is winning as of 2026-09-05)

| Tier | Protocol / format | Verdict | Why |
|---|---|---|---|
| **Must speak natively** | **MCP** (spec `2026-07-28`, plus legacy `2025-11-25`/`2025-06-18` era) | Winner for agent -> tool/data | 400M+ monthly SDK downloads (Anthropic, 2026-07-28), ~9.6k servers in official registry (May 2026), 950+ connectors in Claude directory, governed by AAIF/Linux Foundation; every framework we care about is an MCP client (OpenAI Agents SDK, LangChain/LangGraph, CrewAI, Google ADK, Cloudflare Agents SDK, OpenClaw, Claude Code). |
| **Must speak natively** | **A2A v1.0** (Agent Card at `/.well-known/agent-card.json`, JSON-RPC + HTTP+JSON bindings) | Winner for agent <-> agent | 150+ orgs, 25.6k GitHub stars, shipped in Azure AI Foundry, Copilot Studio, Bedrock AgentCore; IBM ACP merged into it (Aug 2025); joined AAIF 2026-08-17; OpenClaw ships an A2A 1.0 channel. |
| **Must ship** | **Agent Skills (`SKILL.md`)** — Anthropic open spec at agentskills.io; OpenClaw/ClawHub follows it | Winner for "how to use us" packaging | ~45 clients listed on agentskills.io incl. Claude Code, Claude, ChatGPT/Codex, Cursor, Gemini CLI, GitHub Copilot, VS Code, Goose, OpenClaw, Hermes, Kiro, Spring AI. ClawHub has ~12.5k published skills (5.3k after spam filtering). |
| **Must ship (cheap)** | **OAuth well-knowns required by MCP** (RFC 9728 `/.well-known/oauth-protected-resource`, RFC 8414 `/.well-known/oauth-authorization-server`, CIMD, `io.modelcontextprotocol/oauth-client-credentials`) | Required for any authenticated MCP server; client-credentials ext is *the* zero-human auth path | Part of MCP 2026-07-28 core + official ext. |
| **Should speak natively (wallet rails)** | **x402** (HTTP 402; x402 Foundation under Linux Foundation) + **a2a-x402** ext + **AP2** v0.2 (mandates) | Winning for agent payments | x402: 75.4M tx / $24.2M in last 30 days (x402.org, Aug 2026), 22 launch members incl. Stripe, Visa, Mastercard, AWS, Cloudflare, Shopify. AP2: 60+ orgs. Cloudflare Agents SDK has native x402. |
| **Should adopt (identity)** | **Web Bot Auth** (IETF WG draft-ietf-webbotauth-httpsig-protocol-00, 2026-09-01; RFC 9421 signatures; `/.well-known/http-message-signatures-directory`) | Winning for "prove this HTTP request came from agent X" | Cloudflare Verified Bots, Akamai, AWS WAF, Vercel, Shopify verify; Claude, ChatGPT, Perplexity sign. |
| **Ship (trivial)** | `llms.txt`, `llms-full.txt`, `openapi.json`, `AGENTS.md` in SDK repos | Cheap, expected by coding agents | llms.txt at 8.7% of top-1k sites (June 2026), but crawlers rarely fetch it; coding agents do. AGENTS.md: 60k+ repos, AAIF-governed. |
| **Optional / watch** | AGNTCY (OASF records + Agent Directory), Arazzo 1.1, ANP (`/.well-known/agent-descriptions`), ERC-8004, UCP | Niche or early; cheap to emit a record | AGNTCY dir v1.7.0 has 184 stars; ANP repo 1.4k stars; Arazzo referenced by MCP docs; ERC-8004 still Draft. |
| **Skip** | IBM ACP (merged into A2A), LangChain Agent Protocol (dormant), agents.json (Wildcard, v0.1.0, stale), Agora (academic), NLWeb (niche, Microsoft) | Dead, dormant, or irrelevant to our shape | See per-protocol notes. |

**One-line answer:** Speak **MCP (dual-era Streamable HTTP) + A2A v1.0 + the OAuth well-knowns** natively, publish a **SKILL.md** to ClawHub/agentskills registries, expose payments over **x402 / a2a-x402 / AP2**, accept and emit **Web Bot Auth** signatures for agent identity, and serve **llms.txt + openapi.json**. Everything else is optional metadata export.

---

## 1. MCP — Model Context Protocol

### 1.1 Current spec: `2026-07-28` (released 2026-07-28; RC earlier in July)
Sources: https://blog.modelcontextprotocol.io/posts/2026-07-28/ , https://modelcontextprotocol.io/specification/2026-07-28/changelog , https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

Largest revision since launch. Key facts (verified from the changelog):
- **Stateless core.** `initialize`/`notifications/initialized` handshake and `Mcp-Session-Id` header are removed (SEP-2567, SEP-2575). Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`, `_meta["io.modelcontextprotocol/clientCapabilities"]`, and SHOULD carry `_meta["io.modelcontextprotocol/clientInfo"]`. Servers identify themselves via `_meta["io.modelcontextprotocol/serverInfo"]` on results.
- **`server/discover`** RPC: servers MUST implement; returns `supportedVersions`, `capabilities` (incl. `extensions`), `ttlMs`, `cacheScope`. Clients use it as a probe.
- **Streamable HTTP**: single endpoint (e.g. `https://example.com/mcp`) accepting POST only; GET stream endpoint removed; SSE resumability (`Last-Event-ID`) removed. Required headers on every POST: `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, and `Mcp-Name: <tool|uri|prompt>` for `tools/call`, `resources/read`, `prompts/get`. Optional `x-mcp-header` schema annotation mirrors tool params into `Mcp-Param-{Name}` headers so gateways can route/rate-limit without parsing JSON. Header/body mismatch -> HTTP 400 + JSON-RPC `-32020 HeaderMismatch`. Unknown method -> 404 + `-32601`.
- **MRTR (Multi Round-Trip Requests, SEP-2322)** replaces server-initiated `elicitation/create`, `sampling/createMessage`, `roots/list`: server returns `resultType: "input_required"` with `inputRequests`; client retries the original request with `inputResponses`. All results now carry `resultType` (`"complete"` | `"input_required"` | `"task"` when the Tasks ext is used).
- **`subscriptions/listen`**: one long-lived POST response stream for opted-in change notifications (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`).
- **Cacheable lists**: `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` MUST return `ttlMs` and `cacheScope` (`public`|`private`). Tools SHOULD be returned in deterministic order (prompt-cache hit rates).
- **Removed**: `ping`, `logging/setLevel`, `notifications/roots/list_changed`, `tasks/list`, `notifications/elicitation/complete`.
- **Deprecated (12-month minimum window)**: Roots, Sampling, Logging features; HTTP+SSE transport (2024-11-05); OAuth Dynamic Client Registration (RFC 7591) in favour of **Client ID Metadata Documents (CIMD)**.
- **Authorization hardening**: `iss` validation per RFC 9207; `application_type` required in DCR; credentials bound to issuing AS.
- **Schema**: `inputSchema`/`outputSchema` now allow any JSON Schema 2020-12 keywords. Error-code policy: `-32020..-32099` reserved for MCP spec (`UnsupportedProtocolVersion` = `-32022`, `MissingRequiredClientCapability` = `-32021`).
- **Extensions framework** (`extensions` field in ClientCapabilities/ServerCapabilities; reverse-DNS ids).
- **Backward compatibility**: a 2026-07-28-only server SHOULD answer legacy GET/DELETE with `405`, ignore `Mcp-Session-Id` and `Last-Event-ID`. A dual-era client tries a modern request first; on a `400` whose body is *not* a recognised modern JSON-RPC error it falls back to `initialize`. Servers MAY treat a request without `MCP-Protocol-Version` as `2025-03-26`.
- **SDKs**: TypeScript, Python, Go, C# support 2026-07-28 at release; Rust beta. "Close to half a billion downloads a month" across Tier-1 SDKs; TS and Python each >1B total.

### 1.2 Official extensions (https://modelcontextprotocol.io/extensions/overview , https://modelcontextprotocol.io/extensions/client-matrix)
| Extension | Identifier | Notes |
|---|---|---|
| Tasks | `io.modelcontextprotocol/tasks` (SEP-2663; repo `ext-tasks`) | Server returns `CreateTaskResult` (`resultType: "task"`, `taskId`, `ttlMs`, `pollIntervalMs`). Client polls `tasks/get`; supplies input via `tasks/update`; `tasks/cancel` cooperative. States: `working`, `input_required`, `completed`, `failed`, `cancelled`. Optional `notifications/tasks` over `subscriptions/listen`. Client opts in per request via `_meta.clientCapabilities.extensions`. |
| MCP Apps | `io.modelcontextprotocol/ui` (SEP-1865; repo `ext-apps`) | Server-rendered HTML in sandboxed iframe. Supported by Claude web/desktop, ChatGPT, Cursor, VS Code Copilot, M365 Copilot, Goose, Postman. Irrelevant for a zero-human platform. |
| OAuth Client Credentials | `io.modelcontextprotocol/oauth-client-credentials` (repo `ext-auth`) | **The zero-human auth path.** RFC 7523 JWT-bearer assertions (recommended) or `client_id`+`client_secret`. SDK: TS `ClientCredentialsProvider` / `PrivateKeyJwtProvider` in `@modelcontextprotocol/client`; Python `ClientCredentialsOAuthProvider` / `PrivateKeyJWTOAuthProvider`. Client matrix shows no major consumer client listing it yet (only Archestra lists EMA) — support is SDK-level, which is fine for headless agents. |
| Enterprise-Managed Authorization | `io.modelcontextprotocol/enterprise-managed-authorization` | Enterprise IdP; not our concern. |

### 1.3 Authorization (core)
Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery , https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- MCP servers MUST implement RFC 9728 Protected Resource Metadata: either `WWW-Authenticate: ... resource_metadata="<url>"` on 401, or well-known at `/.well-known/oauth-protected-resource[/<mcp-path>]`. Document MUST list `authorization_servers`.
- AS metadata discovery via RFC 8414 `/.well-known/oauth-authorization-server` and OIDC `/.well-known/openid-configuration` (path-insertion order defined). Clients MUST validate `issuer` matches.
- **CIMD**: `client_id` is an HTTPS URL with a path (e.g. `https://example.com/client.json`) hosting `{client_id, client_name, redirect_uris, ...}`; AS advertises `client_id_metadata_document_supported: true`. CIMD client IDs are **portable across authorization servers**. Priority: pre-registration -> CIMD -> DCR fallback -> prompt user.
- Roadmap (2026-08-22, https://blog.modelcontextprotocol.io/posts/mcp-roadmap/): agent identity & enterprise security (DPoP, Workload Identity Federation, token exchange), HTTP-native transport unification, Tasks maturation, progressive discovery for large tool catalogs.

### 1.4 Registry (https://modelcontextprotocol.io/registry/about , https://github.com/modelcontextprotocol/registry , https://registry.modelcontextprotocol.io/)
- Status: **preview** since 2025-09-08; API freeze v0.1 since 2025-10-24; GA not yet announced as of 2026-09-05.
- API: `https://registry.modelcontextprotocol.io/v0.1/servers` (also `/v0/servers`), docs at `/docs`. OpenAPI spec published so subregistries/marketplaces can implement the same interface; host apps are expected to consume *downstream* registries, not the official one directly.
- `server.json` schema: `docs/reference/server-json/draft/server.schema.json`. Names are reverse-DNS namespaces (`io.github.user/server`, `com.example/server`) verified via GitHub OAuth/OIDC, DNS challenge, or HTTP challenge. Supports remote servers and packages (npm, PyPI, Docker Hub...). No private servers.
- Counts: 9,652 latest server records / 28,959 server-version records (2026-05-24, digitalapplied snapshot); Anthropic Dec 2025: 10,000+ active public servers; 15,926 GitHub repos with `mcp-server` topic; `modelcontextprotocol/servers` repo 86k stars.

### 1.5 Client rollout of 2026-07-28 (important for our dual-era decision)
- Anthropic (https://claude.com/blog/bringing-mcp-2026-07-28-to-claude): "Support is being rolled out across Claude products soon"; 400M+ monthly SDK downloads (4x YoY); 950+ servers in Claude connector directory.
- Cloudflare Agents SDK v0.20.0 (2026-07-27) supports 2026-07-28 client+server, probes `server/discover` then falls back to legacy `initialize` on the same connection; `createMcpHandler` serves both eras on one route; `isLegacyRequest()` helper. https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/
- OpenAI Agents SDK depends on `mcp>=1.19.0,<3`; with SDK v2 it probes newest protocol first then falls back. https://openai.github.io/openai-agents-python/mcp/
- InfoQ 2026-08: Claude Desktop/Code, ChatGPT, Cursor still could not connect to a GA remote server whose IdP lacked DCR/CIMD — i.e. auth interop, not transport, is the practical blocker. https://www.infoq.com/news/2026/08/azure-devops-remote-mcp-ga/
- **Implication:** a server we ship in Sept 2026 MUST serve both the 2026-07-28 stateless shape and the 2025-11-25 session-based shape on the same `/mcp` endpoint, and MUST support CIMD + DCR fallback + client-credentials.

### 1.6 How each framework consumes MCP (verified)
- **OpenAI Responses API** tool shape: `{"type":"mcp","server_label":"...","server_url":"https://.../mcp","server_description":"...","require_approval":"never"|"always"|...}`; function tools `{"type":"function","name","description","parameters"(JSON Schema, additionalProperties:false),"strict":true}`; also `tool_search`, `namespace`. https://developers.openai.com/api/docs/guides/tools
- **OpenAI Agents SDK (Python)**: `HostedMCPTool`, `MCPServerStreamableHttp`, `MCPServerSse` (deprecated), `MCPServerStdio`; static/dynamic tool filters; `require_approval`. https://openai.github.io/openai-agents-python/mcp/
- **LangChain/LangGraph**: `langchain-mcp-adapters` (3.6k stars) — `load_mcp_tools(session)`, transports stdio/sse/streamable_http/http. https://github.com/langchain-ai/langchain-mcp-adapters
- **CrewAI**: `mcps` field on agents (string refs) or `MCPServerAdapter`; stdio/SSE/Streamable HTTP. https://docs.crewai.com/en/mcp/overview
- **Google ADK**: `McpToolset` (page redirected; not re-verified this session) **[unverified]**.
- **OpenClaw**: `openclaw mcp add <name> --url ... --transport streamable-http --header ...` (stdio, SSE/HTTP, streamable-http; OAuth, mTLS); also `openclaw mcp serve` exposes OpenClaw as an MCP server. https://docs.openclaw.ai/cli/mcp
- **Cloudflare Agents SDK** (5.5k stars): act as MCP server or client (HTTP, SSE, RPC, elicitation); native x402; A2A example. https://github.com/cloudflare/agents

---

## 2. A2A — Agent2Agent Protocol (v1.0)

Sources: https://a2a-protocol.org/latest/specification/ , https://a2a-protocol.org/latest/topics/agent-discovery/ , https://github.com/a2aproject/A2A , https://learn.microsoft.com/en-us/agent-framework/migration-guide/agent-to-agent-sdk-v1 , https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year , https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html

- **Timeline**: announced 2025-04-09 (Google, 50+ partners); donated to Linux Foundation 2025-06-23; IBM ACP merged in 2025-08-29; **v1.0 released March 2026** (2026-03-12 per secondary sources); 150+ orgs, 22k+ stars by 2026-04-09 (25.6k stars on 2026-09-05); **joined the Agentic AI Foundation 2026-08-17** (announced ~08-20; Forbes/Axios returned 403, confirmed via AI Magazine / Pebblous coverage and AAIF membership stats: AAIF grew from <40 to 250+ members).
- **Production platforms**: Azure AI Foundry, Copilot Studio, Amazon Bedrock AgentCore Runtime, Google Agent Engine. Interop demonstrated across ADK, LangGraph, AG2, CrewAI. SDKs: Python `a2a-sdk`, Go `a2a-go`, JS `@a2a-js/sdk`, Java, .NET `A2A`, Rust `a2a-lf`.
- **Agent Card**: JSON at **`https://{domain}/.well-known/agent-card.json`** (RFC 8615). Legacy `/.well-known/agent.json` was used by a2a-sdk v0.2.x and broke in v0.3.x (google/adk-python#2535); OpenClaw serves both. Only one card per origin via well-known -> per-agent cards need per-agent origins or direct URLs. v1.0 card: `protocolVersion`, `name`, `description`, `version`, `capabilities` (`streaming`, `pushNotifications`, `extensions`), `skills[]`, `securitySchemes`, **`supportedInterfaces[]`** (`{url, protocolBinding: "JSONRPC"|"HTTP+JSON"|"GRPC", protocolVersion}`) replacing the old top-level `url`, `defaultInputModes/OutputModes`, optional `signatures` (**JWS, RFC 7515, with JCS canonicalization RFC 8785** — spec section 8.4). Authenticated extended card via `agent/getAuthenticatedExtendedCard` / `GetExtendedAgentCard`. (One fetch summary claimed `/.well-known/a2a`; the official discovery page and OpenClaw/Microsoft implementations say `agent-card.json` — treat `agent-card.json` as canonical.)
- **Bindings**: JSON-RPC 2.0 (`message/send`, `message/stream`, `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe` (was `resubscribe`), `tasks/pushNotificationConfig/{set,get,list,delete}`), gRPC, and HTTP+JSON/REST. **Microsoft Agent Framework now defaults to HTTP+JSON with JSON-RPC fallback** — serve both.
- **Versioning**: `A2A-Version: 1.0` request header; empty header defaults to 0.3; `VersionNotSupportedError`.
- **Task states**: `TASK_STATE_SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`, `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`.
- **Push notifications**: client registers a webhook URL; server POSTs task updates; requires `capabilities.pushNotifications: true`.
- **Extensions**: identified by URI, declared in card and messages; required extensions error if unsupported. Family: AP2, A2UI, UCP, a2a-x402.
- **Discovery**: (1) well-known URI, (2) **curated registries — the spec explicitly does NOT define a registry API** (opportunity for us), (3) direct configuration.
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
- **Verdict**: real LF project, low developer traction; worth publishing OASF records for our marketplace agents later (they are a metadata superset of A2A cards + MCP server.json) and watching the directory as a federation peer. Not a native protocol for us.

## 6. Agora (Oxford, Oct 2024 paper)
Sources: https://agoraprotocol.org/docs/protocol/specification , https://github.com/agora-protocol/paper-demo , https://arxiv.org/pdf/2504.16736
- Meta-protocol: agents negotiate "Protocol Documents" in natural language then converge to structured routines. Academic only; no production adopters. **Skip.**

## 7. LangChain Agent Protocol
Sources: https://github.com/langchain-ai/agent-protocol/releases , https://github.com/langchain-ai/langchain-mcp-adapters
- REST spec for Runs/Threads/Store (the LangGraph Platform API shape). Releases page shows `langchain-protocol==0.0.19` (2024-08-26) as latest; a search snippet claimed 0.2.x in April 2026 — conflicting, treat as **dormant / LangGraph-Platform-specific**. LangGraph agents reach us via MCP (`langchain-mcp-adapters`) and A2A, not via this. **Skip.**

## 8. OpenAI Agents SDK / Responses API tool formats
See 1.6. Also AGENTS.md (OpenAI-originated, now AAIF): 60k+ repos; read by Codex, Claude Code, Cursor, Copilot, Gemini CLI, Jules, Windsurf, Zed, Aider, Amp, Junie... https://agents.md/
- **Verdict**: ship function-tool-compatible JSON Schema (strict mode: `additionalProperties:false`, all fields required) in our OpenAPI and MCP tool definitions; put `AGENTS.md` in every SDK/example repo.

## 9. OpenClaw skills (SKILL.md) and ClawHub
Sources: https://docs.openclaw.ai/clawhub/skill-format , https://docs.openclaw.ai/tools/skills , https://github.com/VoltAgent/awesome-openclaw-skills , https://en.wikipedia.org/wiki/OpenClaw , https://docs.openclaw.ai/llms.txt
- OpenClaw = Peter Steinberger's open-source, self-hosted personal agent (Warelay -> CLAWDIS -> Clawdbot -> Moltbot 2026-01-27 -> OpenClaw 2026-01-30). 247k stars (2026-03-02, Wikipedia); secondary sources claim 347k by April 2026 **[unverified]**. OpenClaw Foundation announced 2026-02-14 when Steinberger joined OpenAI. Notable supply-chain incidents (malicious skills, CVE-2026-25253).
- **Skill format**: folder with `SKILL.md` (YAML frontmatter + Markdown). "OpenClaw follows the AgentSkills spec." Required frontmatter on ClawHub: `name` (matches directory, 1–64 lowercase/digits/hyphens), `description`, `version`. Runtime metadata under `metadata.openclaw` (aliases `metadata.clawdbot`, `metadata.clawdis`): `requires.env[]`, `requires.bins[]`, `requires.anyBins[]`, `requires.config[]`, `primaryEnv`, `envVars[{name, required, description}]`, `install[]` (brew/node/go/uv), `emoji`, `homepage`, `os[]`. Bundle <= 50 MB; MIT-0 licence mandatory; no paid skills. Load order: `<workspace>/skills` > `<workspace>/.agents/skills` > `~/.agents/skills` > `<state>/skills` > workshop skills > bundled/extraDirs. Install: `openclaw skills install @owner/<slug>` (or `npx clawhub install <slug>`); trust envelope verified on install; VirusTotal scanning partnership.
- **ClawHub scale**: awesome-openclaw-skills curated 5,300+ after filtering out ~7,215 (4,065 spam, 1,040 dupes, 886 crypto/finance, 373 malicious) -> ~12.5k published total.

## 10. Anthropic Agent Skills (open standard, agentskills.io)
Sources: https://agentskills.io/ , https://agentskills.io/specification
- Opened as a public standard 2025-12-18 (secondary). Spec: `SKILL.md` frontmatter `name` (required, 1–64, lowercase/digits/hyphens, no leading/trailing/double hyphen, must equal directory name), `description` (required, 1–1024 chars, "what + when"), optional `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (experimental, e.g. `Bash(git:*) Read`). Optional `scripts/`, `references/`, `assets/`. Progressive disclosure: metadata (~100 tokens at startup) -> body (<5k tokens, <500 lines) -> resources on demand. Validator: `skills-ref validate ./my-skill`.
- **Adopters listed on agentskills.io (2026-09-05)**: Claude, Claude Code, ChatGPT & Codex, Cursor, Gemini CLI, GitHub Copilot, VS Code, Goose, OpenCode, OpenHands, Amp, Letta, Junie, Kiro, Roo Code, Factory, Spring AI, Databricks Genie Code, Snowflake Cortex Code, Tabnine, Qodo, Mistral Vibe, Hermes Agent, OpenClaw, ZeroClaw, nanobot, fast-agent, Pulumi Neo, Laravel Boost, TRAE, Mux, Emdash, Superconductor, Workshop, Piebald, Command Code, Ona, VT Code, Deep Code, Firebender, Agentman, Vita, Autohand, bub, Google AI Edge Gallery, pi (~45).
- **Verdict**: the de-facto "instruction manual" format. One skill = zero-custom-code onboarding for every listed client.

## 11. llms.txt
Sources: https://llmstxt.org/ , https://www.rankability.com/data/llms-txt-adoption/ , https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026
- Format: `/llms.txt` (H1 name, blockquote summary, H2 link sections, `## Optional`), plus `/llms-full.txt`. Proposal by Jeremy Howard (2024-09-03; page modified 2026-08-10).
- Adoption: 8.7% of Tranco top-1k and 5.6% of top-10k (June 2026; up from 0.3% in June 2025); ~10% of 300k domains (SE Ranking). Crawlers almost never fetch it (408 requests out of 500M AI-bot hits in one 90-day study); Google says it does not use it. But coding agents *do* follow it: modelcontextprotocol.io, agentskills.io and docs.openclaw.ai all serve `llms.txt` and WebFetch surfaces it. **Ship it; cost is trivial.**

## 12. agents.json (Wildcard AI)
Sources: https://github.com/wild-card-ai/agents-json , https://docs.wild-card.ai/agentsjson/introduction
- v0.1.0, `/.well-known/agents.json`, OpenAPI + `flows` + `links`; 1.3k stars, 75 commits. No ecosystem traction visible in 2026. **Skip** (its ideas are covered by OpenAPI + Arazzo + MCP tools).

## 13. Web Bot Auth
Sources: https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/ , https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/ , https://github.com/cloudflare/web-bot-auth , https://blog.cloudflare.com/verified-bots-with-cryptography/ , https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- Now an IETF **working-group** document: `draft-ietf-webbotauth-httpsig-protocol-00` dated **2026-09-01** (replaces individual draft -02 of 2026-08-19). RFC 9421 HTTP Message Signatures with `tag="web-bot-auth"`; headers `Signature`, `Signature-Input`, `Signature-Agent` (origin hosting keys); key directory (JWKS) at **`/.well-known/http-message-signatures-directory`**; Ed25519 / RSA-PSS test vectors; expiry recommended <= 24 h. Cloudflare Verified Bots accepts it; Akamai, AWS WAF, Vercel, Shopify verify (secondary); Claude, ChatGPT, Perplexity sign (secondary). Libraries: TypeScript + Rust (cloudflare/web-bot-auth), Caddy plugin, Workers examples.
- **Verdict**: the only standards-track answer to "prove this outbound HTTP request came from agent X". Fits our identity product directly.

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
- **x402** (https://github.com/coinbase/x402 , https://www.x402.org/): HTTP 402 with `PAYMENT-REQUIRED` (base64 PaymentRequired), client retries with `PAYMENT-SIGNATURE`, server returns `PAYMENT-RESPONSE`; facilitator `/verify` and `/settle`; SDKs `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/stellar`. x402 Foundation under Linux Foundation (formalised 2026-04-02 at MCP Dev Summit; 22 launch members incl. Adyen, AWS, Amex, Circle, Google, Mastercard, Microsoft, Shopify, Solana Foundation, Stripe, Visa). x402.org (updated 2026-08-25): last-30-day 75.41M tx, $24.24M volume, 94k buyers, 22k sellers. Coinbase repo is now "a development fork" of the foundation repo.
- **a2a-x402** (https://github.com/google-agentic-commerce/a2a-x402): A2A extension v0.1; states payment-required -> payment-submitted -> payment-completed; 558 stars.
- **AP2** (https://ap2-protocol.org/ , https://github.com/google-agentic-commerce/AP2): v0.2 (April 2026); roles shopping agent / merchant agent / credentials provider / payment processor; Checkout and Payment mandates (open/closed); cards first, wallets/UPI/PIX/crypto on roadmap; 60+ orgs (LF press); FIDO Alliance involvement.
- **UCP** (https://ucp.dev/): Google+Shopify+Amazon+Walmart+Stripe+Booking; 60+ endorsers; capability negotiation, catalog, cart, checkout, identity linking via `/.well-known/oauth-authorization-server`; integrates AP2, A2A, MCP. Announced NRF 2026-01-11. Relevant only if we sell to human-facing commerce.
- **ERC-8004 Trustless Agents** (https://eips.ethereum.org/EIPS/eip-8004): Draft (created 2025-08-13). Identity registry (ERC-721 agentId + `agentURI` registration file listing A2A/MCP/DID/web endpoints, trust models, optional x402), Reputation registry (scored feedback on-chain with evidence links), Validation registry. Adoption numbers **[unverified]**.

---

## 19. Concrete recommendation: what our platform must expose

All paths relative to `https://<platform-domain>`; per-agent identities get their own origin `https://<agent-id>.agents.<platform-domain>` so RFC 8615 well-knowns work per agent.

### Platform-level
| Path / surface | Standard | Notes |
|---|---|---|
| `POST /mcp` | MCP Streamable HTTP, **dual-era** (2026-07-28 stateless + 2025-11-25/2025-06-18 session) | Implement `server/discover`; honour `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; return `ttlMs`/`cacheScope`; deterministic `tools/list`; extensions `io.modelcontextprotocol/tasks` (long jobs: hire, escrow, settlement) and `io.modelcontextprotocol/oauth-client-credentials`. Avoid elicitation (no humans) — make every parameter explicit in `inputSchema`; use `x-mcp-header` for `agent_id`/`tenant` so the gateway can meter per agent. |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | RFC 9728 | `authorization_servers: ["https://auth.<platform>"]`, `scopes_supported`. |
| `GET /.well-known/oauth-authorization-server` (+ `/.well-known/openid-configuration`) | RFC 8414 / OIDC | `client_id_metadata_document_supported: true`, `registration_endpoint` (DCR fallback), `token_endpoint` supporting `client_credentials` and `urn:ietf:params:oauth:grant-type:jwt-bearer`; `iss` in auth responses (RFC 9207). |
| `GET /.well-known/agent-card.json` (+ `/.well-known/agent.json` alias) | A2A v1.0 | Platform's own card: skills `discover_agents`, `hire`, `pay`, `message`; `supportedInterfaces` with both `JSONRPC` and `HTTP+JSON`; `capabilities.pushNotifications: true`; JWS-signed. |
| `POST /a2a` (JSON-RPC) and `/a2a/v1/*` (HTTP+JSON) | A2A v1.0 | `A2A-Version: 1.0`; `message/send`, `message/stream`, `tasks/*`, push-notification configs. Marketplace jobs are A2A Tasks. |
| `GET /.well-known/http-message-signatures-directory` | Web Bot Auth | Platform JWKS; per-agent directories under each agent origin. Accept `Signature`/`Signature-Input`/`Signature-Agent` as an inbound auth method too. |
| `GET /openapi.json`, `GET /arazzo.yaml` | OpenAPI 3.1, Arazzo 1.1 | Strict JSON Schema (OpenAI `strict` compatible). Generate MCP tools and A2A skills from this single source. |
| `GET /llms.txt`, `GET /llms-full.txt` | llms.txt | Point at OpenAPI, MCP endpoint, skill, quickstart-for-agents. |
| `GET /v0.1/servers` (MCP Registry OpenAPI) | MCP registry subregistry | Expose every marketplace agent's MCP surface so hosts/aggregators can ingest us; also **act as an A2A registry** (spec leaves registry API undefined — we define it and expose it as MCP tools + REST). |
| `402` responses with `PAYMENT-REQUIRED`; `POST /x402/verify`, `POST /x402/settle` | x402 | Platform wallet = facilitator; support a2a-x402 extension URI in cards for agent-to-agent paid tasks; AP2 mandates for card rails. |
| `GET /.well-known/agent-descriptions` (optional) | ANP-08 | JSON-LD CollectionPage listing agents; ~1 h of work. |
| OASF record export (optional) | AGNTCY | `dirctl push` our catalog to the LF Agent Directory. |

### Per-agent (identity product)
| Path | Standard | Purpose |
|---|---|---|
| `https://<id>.agents.<domain>/.well-known/agent-card.json` | A2A | Agent's public capabilities; signed by platform key + agent key. |
| `https://<id>.agents.<domain>/client-metadata.json` | MCP CIMD | Portable OAuth client_id for the agent usable against *any* MCP server's AS. |
| `https://<id>.agents.<domain>/.well-known/http-message-signatures-directory` | Web Bot Auth | Agent's signing keys; platform signs on the agent's behalf or agent holds its own key. |
| `https://<id>.agents.<domain>/.well-known/jwks.json` | JWKS | For `private_key_jwt` / RFC 7523 assertions. |
| Optional: ERC-8004 registration file export, `did:web` document | ERC-8004 / DID | On-chain and DID projections of the same identity. |

### Distribution
- Publish `SKILL.md` (Agent Skills spec + `metadata.openclaw.requires.env: [PLATFORM_API_KEY]`, `primaryEnv`, `install`) to ClawHub (`openclaw skills install @<org>/<slug>`), GitHub, and the agentskills ecosystem; keep `description` <=1024 chars phrased as triggers ("Use when an agent needs to find, hire, pay, or message other agents...").
- Publish `server.json` to the official MCP registry under `com.<ourdomain>/*` (DNS-verified namespace) — this is how Claude, ChatGPT, Cursor and aggregators surface us.
- `AGENTS.md` in every SDK/example repo.

---

## 20. Non-obvious insights
1. **MCP CIMD turns "agent identity" into "a URL we host".** Since 2026-07-28 deprecates DCR in favour of Client ID Metadata Documents, an agent's OAuth identity is an HTTPS document. Hosting one per agent makes our identities usable against every MCP server's authorization server with no registration — a distribution channel for our identity product.
2. **Stateless MCP + header routing is a billing primitive.** `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` let us meter and rate-limit per tool per agent at the edge without parsing bodies; design tool params with `x-mcp-header` from day one.
3. **A2A explicitly leaves registries undefined; MCP's registry is "not for hosts".** Both winners want *downstream* directories. Our marketplace should present itself as an A2A registry and as an MCP subregistry implementing the official OpenAPI — that is the lane nobody owns yet (AGNTCY is trying with 184 stars).
4. **The human-in-the-loop primitives are the dividing line.** MRTR/elicitation (MCP) and `INPUT_REQUIRED`/`AUTH_REQUIRED` (A2A) exist for humans. For a zero-human platform, all tools must be fully parameterised and long work must go through Tasks with polling/push, or agents will stall.
5. **Skills beat docs.** Agents load the `description` of every installed skill at startup (~100 tokens). One well-written SKILL.md gets us into ~45 agent runtimes' selection loop; llms.txt does not.
6. **Payments converged faster than identity.** x402 has an LF foundation with Visa/Mastercard/Stripe and 75M tx/month; agent identity is still fragmented (OAuth CIMD vs Web Bot Auth vs did:wba vs ERC-8004 vs AGNTCY badges). Our wallet should ride x402/AP2; our identity layer can be the aggregator that projects one identity into all four formats.
7. **The 2026-07-28 transition is the client-compat trap.** Claude/ChatGPT/Cursor were still rolling out in Aug 2026; the only safe move for a Sept-2026 launch is dual-era on one endpoint (Cloudflare's `createMcpHandler` pattern).
8. **Governance has consolidated under one roof.** MCP (Dec 2025), AGENTS.md, goose, A2A (Aug 2026), x402 Foundation (Apr 2026) and AGNTCY are all Linux Foundation; anything outside (ANP/W3C CG, agents.json, Agora, NLWeb) is unlikely to win.

## 21. Open questions
- When will Claude Code / ChatGPT / Cursor complete 2026-07-28 rollout, and will they support `io.modelcontextprotocol/oauth-client-credentials` for headless use, or only user-delegated flows?
- Will the MCP registry reach GA with a stable subregistry contract in 2026, and will it index A2A cards or Agent Skills (AGNTCY dir already does all three)?
- Does A2A v1.x standardise a registry API or card-signing key discovery (JWKS location)? Spec section 14.3 registers a well-known URI; the exact string could not be extracted from the spec page (discovery doc says `/.well-known/agent-card.json`).
- Will the Web Bot Auth WG define a per-agent (not per-vendor) key model suitable for millions of agents, or will verifiers keep an allowlist of big bots?
- ERC-8004 and AGNTCY identity traction numbers — unverified.
- AP2 extension URI string, and whether AP2 v0.2 mandates can be issued by an autonomous agent without a human "intent" signature (the spec centres on proving *human* authorisation).

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

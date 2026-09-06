# How autonomous AI agents discover tools, services and APIs (as of 2026-09-06, round 2)

Slug: `agent-discovery-marketing`
Author: strategy research subagent. Round 1: 2026-09-05. Round 2 (verification, corrections, gaps): 2026-09-06.
Scope: our "small world for AI agents" platform (identity, wallets/payment rails, agent-to-agent marketplace, messaging, reputation). Audience for discovery = LLM agents (Claude Code, OpenClaw/Clawdbot-style, Codex, Gemini CLI, LangGraph/CrewAI, custom scripts), zero humans in the loop.

Method (round 1): 40 web searches + ~35 primary-source fetches (official docs, GitHub READMEs, specs, arXiv, launch posts). Search budget was exhausted before Wikidata/agent.ai/Exa-indexing/Cloudflare-agent-registry could be verified; those are marked **unverified**. Everything else is tagged with the source it came from. Dates are given where the source states them.

Method (round 2): ~45 further web searches + ~45 primary-source fetches, including live probes of registry APIs (official MCP registry, ClawHub, x402 Bazaar, Glama). Claims that turned out wrong or outdated are fixed in place and marked **[corrected 2026-09-06]**; everything new is in the "Round 2" section at the end. Things still not verifiable online remain marked **unverified**.

---

## 0. Executive summary (the "so what")

1. There is no "Google for agents" yet. Discovery is fragmented into roughly five hubs, in descending order of agent reach: (a) the **official MCP registry** and its syndication (GitHub MCP registry, PulseMCP, Glama, Smithery, mcp.so), (b) **skills registries** (Agent Skills / SKILL.md standard, ClawHub for OpenClaw, Claude Code plugin marketplaces, ChatGPT/Codex plugin directory, Gemini CLI extensions, plus GitHub-crawling aggregators such as SkillsMP), (c) **web search APIs consumed by agents** (Brave, Exa, Tavily, Perplexity Sonar, Anthropic's server-side web_search, OpenAI's own index for Codex, Google grounding for Gemini CLI), (d) **package registries** (npm/PyPI; agents guess names), (e) **payment-native catalogs** (x402 Bazaar, where being paid once = being listed — with caveats, see §8).
2. `llms.txt` is a *conversion* asset, not an *acquisition* asset. **[corrected 2026-09-06]** The round-1 "0 requests from any AI bot" figure came from a ~900-domain study; the much larger Ahrefs study (137,210 domains, May 2026, published June 15 2026) finds 97% of llms.txt files get zero requests, and among the 3% that do, AI bots are 19.5% of requests (GPTBot 4.51%, ClaudeBot 0.80%) — and the **Claude-Code user agent out-fetches the retrieval bots (PerplexityBot, OAI-SearchBot)**. So: almost no crawler reads it, but coding agents do, once they land on your docs. Anthropic/Mintlify put a "fetch llms.txt first" blockquote at the top of every docs page.
3. The single most effective agent-acquisition artifact observed in 2025-26 is Moltbook's `skill.md`: one URL an agent fetches, which contains registration → API key → claim → heartbeat instructions. ~1.5M agent registrations in days with effectively no UI (though 17k humans controlled them). Copy the pattern: `https://<our-domain>/skill.md`.
4. Descriptions are the ad copy. Agent Skills load only `name` + `description` at startup (progressive disclosure); MCP tool descriptions "steer agents toward effective tool-calling behaviors" (Anthropic); x402 Bazaar ranks by description/intent; ClawHub uses vector search over skill text. Write these strings like landing-page copy containing the intent phrases an agent would search for. Round 2 adds hard evidence: in 17,700 forced-choice trials, commercially framed tool descriptions captured 83% of agent traffic vs a 50% fair share (see Round 2, R2.3f).
5. Agent fetch pipelines discard metadata. Anthropic's web_search returns title + URL + encrypted content; **[corrected 2026-09-06]** the Claude Code fetch pipeline (HTML→Markdown, then a small fast model answers a prompt about the page, 15-minute cache) is now corroborated by the published tool descriptions and multiple independent reverse-engineering write-ups, not just the April-1 "leak". Body text in the first few thousand characters is what agents see. schema.org is for Google AI Overviews/search engines, not for coding agents. New in round 2: Anthropic's API `web_fetch` **cannot fetch a URL that only appears in the model's own output** — only URLs from user messages, client tool results, or prior search/fetch results. For API-hosted agents, search is the *only* autonomous path to a domain they have never seen.
6. Walled-garden directories are partly hostile to an agent economy: ChatGPT's plugin directory rejects "subscription sales or digital product monetization (physical goods only)" **and, verified in round 2, prohibits plugins that execute "money transfers, crypto transfers, or investment trades"**; Anthropic's Connectors Directory requires a Team/Enterprise org and human review. **[corrected 2026-09-06]** Anthropic *plugins* (skills + MCP bundles) can now be submitted by individual developers through the Console (`platform.claude.com/plugins/submit`) with automated review and auto-mirrored GitHub updates. Open registries (MCP registry, ClawHub, x402 Bazaar, npm/PyPI, GitHub, SkillsMP) accept automated publication with no human review.
7. Security scanning is now the gate everywhere (ClawHub VirusTotal scans after ClawHavoc's 341 malicious skills; Snyk found 36% of 3,984 skills flawed; Anthropic's community marketplace runs automated validation). Minimal-permission, clean skills stay listed; flagged ones vanish from catalogs.

---

## 1. Web search behaviour of agents

### 1.1 Anthropic web_search (Claude API, Claude Code, Managed Agents) — VERIFIED (re-verified 2026-09-06)
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Tool versions: `web_search_20250305` (basic), `web_search_20260209` (dynamic filtering: Claude writes code to filter results before they enter context), `web_search_20260318` (response_inclusion control).
- Claude decides when to search: "recent events... current prices... information about specific organizations, people, or products that might have changed... explicit requests to search".
- Results carry `url`, `title`, `page_age` ("when the site was last updated"), `encrypted_content`. Citations expose up to 150 chars of `cited_text`.
- `allowed_domains` / `blocked_domains` let operators pin the agent to specific domains — enterprises often whitelist docs domains; being on such a list requires being a known domain. Round 2: org admins can also restrict searchable domains org-wide in the Claude Console; Managed Agents use per-tool lists.
- Price: $10 per 1,000 searches. Simple queries use 1-3 searches, research 10+.
- Index provider is **not named** in the docs. Widely reported as Brave (Brave says it is "trusted by most of the world's top 10 LLMs" and that "many other search API providers actually rely on the Brave Search API in the background" — vendor claim, https://brave.com/learn/best-search-api-2026/, May 27 2026). **Unverified** that Claude uses Brave. Round 2 added circumstantial evidence (Google Cloud docs reportedly name "Brave Search" for Claude web search; Brave reportedly on Anthropic's subprocessor list since Mar 2025; third-party citation-overlap studies) but no Anthropic statement; the trust.anthropic.com subprocessor page could not be parsed. Still **unverified**.

### 1.2 Claude Code WebSearch/WebFetch internals — **[corrected 2026-09-06]** core pipeline CORROBORATED; specific numbers remain secondary
Original source: https://wire.wise-relations.com/news/2026-04-01-claude-code-websearch-leak/ (author admits it may be an April Fools joke)
- Claimed pipeline: server-side search returns titles+URLs only; fetch → Turndown HTML-to-Markdown → truncate at 100,000 chars → Haiku paraphrase (125-char quote limit) → 50,000-char tool budget → possible 2KB preview. JSON-LD, meta descriptions, alt-text disappear.
- ~107 documentation domains (React, Python, Kubernetes...) bypass filtering.
- Only enforced query rule: include current month+year.
- **[corrected 2026-09-06]** The published tool descriptions (extracted in https://github.com/Piebald-AI/claude-code-system-prompts) say WebFetch "fetches content from a specified URL and processes it using an AI model", converts HTML to markdown, answers the caller's prompt with a fast model, caches for a TTL, returns redirect URLs instead of following cross-host redirects; WebSearch returns "search result blocks including links as markdown hyperlinks", is "only available in the US", and the agent "MUST use this year when searching for recent information". Independent write-ups (Shilkov Oct 2025, Yoffe, Tao Lin Apr 2026, Gurgone) agree on Turndown → Haiku-class summarisation, a 15-minute LRU cache (~50 MB), and the ≤100K-character Markdown passthrough. This researcher's own Claude Code tool schema (Sep 2026) matches: "converts the page to markdown, and answers `prompt` against it using a small fast model... Responses are cached for 15 minutes per URL... Cross-host redirects are returned to you rather than followed." The 107-domain bypass list and the 125-char quote limit remain **unverified**.
- Recommendations that are sensible regardless: body text over metadata; front-load keywords; self-contained sentences; support `Accept: text/markdown`; put the year in content.

### 1.3 What queries agents run — PARTIALLY VERIFIED
- The model writes its own literal queries; Anthropic docs show queries like `"claude shannon birth date"`, `"latest quantum computing breakthroughs 2025"`. Secondary sources (https://fixaeo.com/blogs/can-claude-search-the-web/) report "exact lexical matching" and time-aware queries ("best CRM tools May 2026").
- Implication: title + H1 + first paragraph should contain the literal intent phrases an agent would type: "AI agent wallet API", "agent-to-agent marketplace API", "register an AI agent identity", "pay another agent USDC x402", plus "2026".

### 1.4 Search APIs agents use — VERIFIED (vendor docs) / secondary comparisons (expanded 2026-09-06)
- **Brave Search API**: 40B+ page independent index; "700,000 OpenClaw users selected the Brave Search API" (https://brave.com/learn/best-search-api-2026/). **[corrected 2026-09-06]** The primary source is Brave's blog of April 1 2026 (https://brave.com/blog/openclaw/): "nearly 700,000 OpenClaw users have now signed up to use the Brave Search API"; Brave was the first provider integrated into OpenClaw; the post also says OpenClaw "now operates under a foundation supported by OpenAI". Standard SEO/crawlability applies (sitemaps, crawlable HTML).
- **Exa**: neural/embedding search over own crawl; free tier 20k req/month; ~$7/1k (https://www.tavily.com/blog/7-best-exa-alternatives-for-ai-agents-in-2026, https://coldiq.com/blog/tavily-vs-exa). **[corrected 2026-09-06]** Exa's crawler page is live at https://crawler.exa.ai/: UA `Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)`, robots token `ExaSearchBot` (falls back to major-engine rules, then `*`), every request signed with RFC 9421 HTTP Message Signatures (Web Bot Auth) with keys at `https://crawler.exa.ai/.well-known/http-message-signatures-directory`. There is **no URL submission** mechanism; contact is support@exa.ai. Brave's comparison says Exa's crawl focuses on information-dense content (blogs, papers, news, GitHub) and misses the long tail.
- **Tavily**: "aggregates up to 20 sites per a single API call, and uses proprietary AI to score, filter and rank" — i.e., it sits on top of other engines; no own index to submit to (https://docs.tavily.com/documentation/about). ~$7.50-8/1k. Tavily is LangChain's "recommended search tool partner" (`langchain-tavily`).
- **Perplexity Sonar / Agent API**: GA Feb 2026; returns cited answers (https://docs.perplexity.ai/changelog/changelog, https://www.perplexity.ai/hub/blog/introducing-the-sonar-pro-api).
- **OpenClaw built-in web search** (new, verified at https://docs.openclaw.ai/tools/web): 16 bundled providers (Brave, Codex Hosted Search, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax, Ollama Web Search, Parallel paid/free, Perplexity, SearXNG, Tavily). Auto-detect precedence: **Brave → MiniMax → Gemini → Grok → Kimi → Perplexity → Firecrawl → Exa → Tavily → Parallel**; SearXNG if nothing else; key-free providers (DuckDuckGo, Parallel Free, Codex Hosted, Ollama) only when explicitly selected. Structured providers return title + URL + snippet; synthesized providers (Gemini, Grok, Kimi) return an answer with citations. `web_fetch` is a local lightweight HTTP fetch with readability extraction (no browser).
- **Codex CLI** (new, verified at https://learn.chatgpt.com/docs/config-file/config-reference): `web_search = disabled | cached | indexed | live`, **default `cached` = "OpenAI-maintained index without external web access"**; `indexed` allows external access only via the index; `live` is unrestricted and becomes default under `--yolo`/full-access; `tools.web_search.allowed_domains` filters. Implication: to be found by default-configured Codex, you must be in **OpenAI's own index** (crawled by OAI-SearchBot), not Bing or Brave.
- **Gemini CLI** (new, verified at https://geminicli.com/docs/tools/web-search/): `google_web_search` = Google Search grounding; "the Gemini API processes the search results before returning a synthesized response to the agent" with source URIs and titles — raw snippets are not exposed. Being in Google's index is the requirement.
- **CrewAI**: default web tool is `SerperDevTool` (Google SERP via serper.dev); MCP servers supported via crewai-tools (https://github.com/crewAIInc/crewAI-tools). A Jan 17 2026 feature request for semantic "MCP Discovery" (https://github.com/crewAIInc/crewAI/issues/4249) is open and unanswered.
- Practical takeaway: being findable by agents via search = being findable by Brave (OpenClaw default, probably Claude) + Google (Gemini CLI, CrewAI/Serper, Tavily aggregation) + OpenAI's index (Codex cached mode) + Exa's crawler. Classic SEO fundamentals still gate agent search, and **OAI-SearchBot, ExaSearchBot and Brave's crawler must be allowed in robots.txt**.

### 1.5 Which domains AI engines cite — VERIFIED (Semrush) + secondary
- Semrush study (Jul 14-Oct 12 2025, 230k prompts, 100M+ citations): ChatGPT top = Reddit, Wikipedia, Medium, Forbes, LinkedIn; Perplexity = Reddit, LinkedIn, NIH, Microsoft, Google; Google AI Mode = LinkedIn, YouTube, Reddit (https://www.semrush.com/blog/most-cited-domains-ai/).
- 2026 secondary: Reddit 16.7% of ChatGPT citations, 19.9% AI Mode; YouTube 31.2% Perplexity (https://searchengineland.com/ai-search-engines-cite-reddit-youtube-and-linkedin-most-study-473138; https://contently.com/2026/04/29/top-sources-llms-cite/; https://obsurfable.com/resources/reports/top-domains-cited-by-llms-august-2026).
- Implication: a Reddit thread (r/ClaudeAI, r/mcp, r/LocalLLaMA, r/openclaw), a dev.to/Medium post and a YouTube walkthrough that literally say "how an AI agent registers on <platform>" are cheap citation bait for search-driven agents.

---

## 2. llms.txt / llms-full.txt — adoption and whether agents read it

### Adoption — VERIFIED (https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026, Aug 2026)
- ~300k general domains (SE Ranking, Nov 20 2025): **10.13%**.
- Tranco top-1000 (June 2026): 8.7% (15.8% of reachable roots); 15 also publish llms-full.txt.
- Developer-tools panel (219 hosts, Aug 3 2026): **51.8%** overall; dev tools 68.9%, SaaS 66.7%, AI/ML 52.8%, media 0%.
- Shopify serves llms.txt + agents.md on every store since May 2026 (secondary: https://sherocommerce.com/blogs/insights/llms-txt-and-agents-md-for-ecommerce).
- Round 2 addition: Originality.ai tracked 36,120 llms.txt files across >3M monitored sites in May 2026, up 8.8x from 4,088 in June 2025 (via https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/).

### Do agents read it? — VERIFIED (mixed) **[corrected 2026-09-06]**
- Request-log study, ~900 domains, Sep 4 2025-Apr 13 2026: 1,227 total requests to /llms.txt; 64.7% from a commercial data aggregator, 31.9% humans in Chrome, **0 from GPTBot/ClaudeBot/PerplexityBot/Google-Extended**. "Not a single real AI bot." (small sample)
- **[corrected 2026-09-06]** Ahrefs, 137,210 domains, May 2026 (published June 15 2026, https://ahrefs.com/blog/llmstxt-study/): **97% of llms.txt files received zero requests**. Of the 3% fetched: SEO audit tools 21.7%, AI bots 19.5%, general crawlers 13.1%, tech-profiling tools 11.6%, humans 4%. Among AI requesters GPTBot led at 4.51% of all requests, ClaudeBot 0.80%, DeepseekBot 0.02%; AI *retrieval* bots (PerplexityBot, OAI-SearchBot) only 1.1%; and **the "Claude-Code" user agent significantly out-fetched the retrieval bots**. Ahrefs' conclusion matches Mueller: llms.txt "functions primarily as reference material for AI coding agents". So "no AI bot ever reads it" is wrong; "AI search crawlers ignore it, coding agents use it" is right.
- Citation-impact study on 300k domains: no measurable link between llms.txt and AI-citation frequency (https://www.digitalapplied.com/blog/google-llms-txt-no-seo-value-lighthouse-audit-2026).
- Google's John Mueller (June 2025): "no AI system currently uses llms.txt" (via https://www.getpassionfruit.com/blog/should-i-create-an-llms.txt-file-google-s-2026-guidance-explained).
- Counter-evidence for coding agents: Anthropic's own docs serve https://code.claude.com/docs/llms.txt (~200 links, all to `.md` mirrors) and every docs page starts with the blockquote "Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt — Use this file to discover all available pages before exploring further" (re-verified 2026-09-06 on code.claude.com, claude.com/docs, modelcontextprotocol.io and agentskills.io). Anthropic engineering (Sep 11 2025): "LLM-friendly documentation can commonly be found in flat llms.txt files on official documentation sites" (https://www.anthropic.com/engineering/writing-tools-for-agents). Zylos (Jul 9 2026) lists Cursor, Windsurf, Claude Code, GitHub Copilot, Cline, Aider as llms.txt readers (https://zylos.ai/research/2026-07-09-agentic-web-access-standards-llms-txt-crawler-authentication/).
- Chrome Lighthouse 13.3 (May 7 2026, Chrome 150+) added an "Agentic Browsing" category that checks llms.txt presence, WebMCP tool registration, accessibility for agents, and CLS; no 0-100 score (https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring; https://www.debugbear.com/blog/lighthouse-agentic-browsing).

### Pattern to copy — VERIFIED (Mintlify, Jan 29 2026: https://www.mintlify.com/blog/context-for-agents)
- `Accept: text/markdown` content negotiation returns clean Markdown from the same URL (claimed 30x token reduction), with `X-Robots-Tag: noindex` on the Markdown variant.
- `Link` and `X-Llms-Txt` response headers advertising the index on every response.
- llms.txt pointer moved to the *top* of pages so truncating agents see it.
- Also see https://www.deployhq.com/blog/making-your-documentation-ai-friendly-serving-markdown-to-ai-coding-assistants and https://www.mintlify.com/docs/llms-full.txt (Mintlify auto-generates llms.txt, llms-full.txt, a skill.md, and hosts an MCP server per docs site).

---

## 3. /.well-known/ conventions

| Path / record | Owner | Status (Sep 2026) | Who reads it today | Source |
|---|---|---|---|---|
| `/.well-known/agent-card.json` | A2A v1.0 (Linux Foundation) | Normative | A2A clients; no protocol-level registry | https://a2a-protocol.org/latest/topics/agent-discovery/ |
| **[corrected 2026-09-06]** `/.well-known/mcp-server-card` (+ `/.well-known/mcp-server-card/{server-name}` for multi-server hosts) per the SEP text; the draft has since moved toward `<MCP endpoint URL>/server-card` with a site catalog handed to ARD/AI-Catalog; `/.well-known/mcp/server-card.json` still seen in the wild | MCP SEP-2127 (supersedes SEP-1649) | **Draft**; "reference implementation required before Final"; being developed as an *experimental MCP extension* (turva.dev, Sep 2026). **Not** in the 2026-07-28 MCP spec release. | No client documented. Claude Code does NOT do well-known MCP lookup (re-verified). Third-party claim that Claude Desktop/Cursor shipped server-card support in Apr 2026 is **unverified** and contradicted by Claude docs | https://github.com/modelcontextprotocol/modelcontextprotocol/blob/aa59517442d323a33ed915fc408f1584c4a23dfa/seps/2127-mcp-server-cards.md ; https://turva.dev/guides/mcp-server-card ; https://code.claude.com/docs/en/mcp ; https://blog.modelcontextprotocol.io/posts/2026-07-28/ |
| `/.well-known/mcp.json`, `/.well-known/mcp` | SEP-1649 / issue #1960 / community | Competing drafts | Some tooling | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649 ; https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960 ; https://www.ekamoira.com/blog/mcp-server-discovery-implement-well-known-mcp-json-2026-guide |
| `mcp://` URI scheme + discovery | IETF draft-serra-mcp-discovery-uri-04 | Individual draft | — | https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/ |
| **[corrected 2026-09-06]** `/.well-known/ard.json` is the canonical ARD path (agenticresourcediscovery.org/interoperability); `/.well-known/ai-catalog.json` is the AI-Catalog variant referenced by SEP-2127, Nylas and Synscribe guides | Agentic Resource Discovery — working group: Microsoft, Google, Hugging Face, GoDaddy; site lists Cisco, Databricks, GitHub, Nvidia, Salesforce, ServiceNow, Snowflake as contributors; v0.9 draft 28 May 2026; HF launch Jun 17 2026 | Draft; naming still inconsistent | HF `hf discover search` / `hf-discover navigate <domain> "<query>"`; no other live discovery service named on the spec site. Three days after launch none of the 11 contributors served a catalog (secondary) | https://huggingface.co/blog/agentic-resource-discovery-launch ; https://agenticresourcediscovery.org/interoperability/ ; https://agenticresourcediscovery.org/ ; https://github.com/Agent-Card/ai-catalog ; https://turva.dev/guides/agentic-resource-discovery ; https://www.infoq.com/news/2026/07/agentic-resource-discovery-spec/ ; https://suganthan.com/blog/agentic-resource-discovery/ |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | OAuth / MCP auth | Live | Claude Code (RFC 9728 first, then RFC 8414), ChatGPT, UCP merchants (scopes like `dev.ucp.shopping.checkout`) | https://code.claude.com/docs/en/mcp ; https://ucp.dev/ |
| `/.well-known/http-message-signatures-directory` (JWKS) | Web Bot Auth (IETF WG; Cloudflare) | Live at Cloudflare edge; ExaSearchBot signs with it | Cloudflare verified-bots; OpenAI Operator, Google-Agent, ExaSearchBot sign | https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; https://crawler.exa.ai/ ; https://zylos.ai/research/2026-07-09-agentic-web-access-standards-llms-txt-crawler-authentication/ |
| `/.well-known/ai-plugin.json` | Legacy ChatGPT plugins | Superseded by Apps SDK/MCP → plugin directory | Effectively nobody | https://openai.com/index/introducing-apps-in-chatgpt/ |
| `/openapi.json`, `/.well-known/openapi.json` | de-facto | Widely used | Any agent that codegens clients | https://dev.to/alfredz0x/how-to-make-your-api-ai-discoverable-with-llmstxt-and-openapi-2026-guide-469l |
| DNS TXT `_agent.<domain>` "v=aid2;u=...;p=mcp;a=oauth2_code" | AID v2.1.0 (Jun 1 2026, agentcommunity) | Spec published; adopters unknown | Unknown | https://aid.agentcommunity.org/docs/specification ; https://datatracker.ietf.org/doc/draft-nemethi-aid-agent-identity-discovery/ |
| DNS TXT `_mcp.<domain>` | community | Experimental | Unknown | https://github.com/mariothomas/mcp-dns-registry |
| DNS-AID | IETF draft-mozleywilliams-dnsop-dnsaid-02 | Draft | — | https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/ ; https://arxiv.org/html/2606.02314v1 |
| NANDA index (AgentAddr, Ed25519) | MIT NANDA | Research | — | https://arxiv.org/pdf/2507.14263 |
| Web of Agents (WoA) manifest | IETF draft-gaikwad-woa-00 (Dec 2025) | Draft | — | https://www.ietf.org/ietf-ftp/internet-drafts/draft-gaikwad-woa-00.html |
| WebMCP `navigator.modelContext` | W3C CG; Chrome 146 (Feb 2026), origin trial Chrome 149 (May 2026) | Draft report Apr 23 2026 | Chrome-based browser agents | https://dev.to/ai-agent-economy/webmcp-in-2026-which-browsers-support-navigatormodelcontext-complete-compatibility-status-1oe4 ; https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026 |

Assessment: static well-known files cost an hour and are cheap insurance, but today none of them is an *acquisition* channel — an agent must already know your domain. The exception is ARD/AI Catalog, which is designed for federated crawlers (HF Discover is live), but as of Sep 2026 no public crawler-fed ARD registry beyond HF's reference client has been demonstrated.

---

## 4. MCP registries — VERIFIED (re-verified 2026-09-06 with live API probes)

### Official registry (registry.modelcontextprotocol.io)
Sources: https://github.com/modelcontextprotocol/registry ; https://registry.modelcontextprotocol.io/docs ; https://modelcontextprotocol.io/registry/about ; https://nordicapis.com/getting-started-with-the-official-mcp-registry-api/ ; https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/ (Jun 8 2026); https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
- Preview since Sep 8 2025; API frozen at v0.1 on Oct 24 2025; "breaking changes or data resets may occur" before GA. **Still preview on 2026-09-06**; no GA announcement found on blog.modelcontextprotocol.io (the 2026-07-28 spec release post does not mention the registry).
- ~9,652 latest server records / 28,959 server-version records on May 24 2026; Anthropic cited 10,000+ active public MCP servers (Dec 2025).
- Publish with `mcp-publisher` + `server.json` (name, title, description, repository, version, websiteUrl, remotes[transport,url], packages). Namespace ownership proven by GitHub OAuth/OIDC (`io.github.<user>/*`) or by **DNS/HTTP challenge for a domain (`com.<yourdomain>/*`)**. No human review queue; spam control = namespace auth + field limits + manual takedown; security scanning is explicitly delegated to npm/PyPI/Docker Hub and to downstream aggregators (About page).
- Live probe 2026-09-06: `GET https://registry.modelcontextprotocol.io/v0/servers?search=wallet&limit=5` works unauthenticated, returns `name`, `description`, `title`, `version`, `websiteUrl`, `remotes[{type:"streamable-http",url}]`, `icons`, `_meta{isLatest,...}` and a `nextCursor`; top hits were `ai.probitylabs/wallet-reputation` ("Pre-transaction risk screening for Ethereum addresses") and `ai.satoshidata/wallet-intelligence` (both active late Aug 2026) — i.e., wallet-adjacent services are already publishing under domain namespaces.
- The About page states the registry "is not intended to be directly consumed by host applications"; aggregators are expected to poll "regular but infrequent (for example, once per hour)". So the official registry is a *feed*, and the surfaces agents actually hit are the aggregators below.
- Downstream consumers: GitHub's MCP registry (https://github.com/mcp shows a curated ~250 servers with Install buttons), PulseMCP ("publish to the Official MCP Registry ... which the directory will automatically index"; direct submissions paused — https://www.pulsemcp.com/submit), Glama (82,361 servers on Sep 5 2026, auto-crawl + "Claimed" tier — https://glama.ai/mcp/servers; **[corrected 2026-09-06]** the API at `https://glama.ai/api/mcp/v1/servers` returned **401 Unauthorized** on an unauthenticated probe, so treat it as key-gated, not public; also note Nordic APIs (Jun 4 2026) cites Glama at "23,000+" — the 82k figure likely counts a broader crawl), Smithery (`smithery mcp publish <url> -n org/server`; claims 100k+ tools and skills — https://smithery.ai/docs), mcp.so (~20,222; secondary), mcptoplist. ~115,937 servers tracked across registries in early Sep 2026 (secondary: https://www.truefoundry.com/blog/best-mcp-registries , https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server). Ecosystem-scale usage (secondary, PulseMCP stats via Nordic APIs Jun 4 2026): **67 million local MCP server downloads in April 2026**, ~18 million views/week across the ecosystem; median 5 tools per server. No registry publishes API-request traffic.
- Claude Code: `claude mcp add --transport http <name> <url>`; OAuth via dynamic client registration and `.well-known/oauth-*`; **no automatic registry or well-known lookup** (re-verified 2026-09-06 at https://code.claude.com/docs/en/mcp: the only discovery is OAuth metadata; otherwise manual config or the Anthropic Directory). An Anthropic-published `mcp-registry` plugin (`/plugin install mcp-registry@claude-plugins-official`, commands `mcp search / list / suggest`) reportedly lets Claude search the public registry from inside a session (https://www.claudedirectory.org/plugins/mcp-registry — third-party page; still **partially verified**: several community MCP servers wrap the registry API, e.g. `registry-mcp`, `mcp-registry-search`). Claude Code also has **MCP tool search** (deferred tool loading, searched by name/description) — see Round 2 R2.3f.
- Anthropic Connectors Directory (claude.ai/directory): submission via org admin settings, requires Team/Enterprise org, tool annotations (readOnly/destructive) + `title`, OAuth 2.0 for authenticated services, public privacy policy, public docs; **[corrected 2026-09-06]** the official page (https://claude.com/docs/connectors/building/submission) says "review times vary with queue volume" — the "2 weeks to months" figure is from third parties. Listing fields: name ≤100 chars, tagline ≤55, description ≤2,000, 1-5 categories, permanent slug. The compliance step requires seven acknowledgments including **"financial transactions"** (policy text not fetched — read the Anthropic Software Directory Policy before submitting a payments connector). Skills cannot be submitted alone; bundle them in a plugin.
- **[corrected 2026-09-06]** Anthropic *plugin* directory (https://claude.com/docs/plugins/submit): "community-driven"; Anthropic "performs basic automated review"; "Anthropic Verified" badge is extra. Submit a **public GitHub repo** via claude.ai (Team/Enterprise) **or via the Console at https://platform.claude.com/plugins/submit (any Developer/Admin/Owner on a Console org — individual developers can sign up)**. After publication "updates pushed to your GitHub repo are picked up automatically — CI mirrors changes... and runs automated screening on each update". The Claude Code docs still say the `claude-plugins-official` marketplace is "curated by Anthropic" and that in-app forms feed the *community* marketplace (`anthropics/claude-plugins-community`, `claude-community`); the two Anthropic pages disagree on which marketplace form submissions land in — treat "auto-available to all Claude Code users" as **unverified** and "listed in claude.com/plugins + community marketplace after automated review" as verified.
- Cursor: cursor.directory lists ~40+ MCP servers and rules, 67k community members (secondary; direct fetch returned 429) — https://www.everydev.ai/tools/cursor-directory ; https://mcpize.com/alternatives/cursor-directory.

### ChatGPT / Codex — VERIFIED (re-verified 2026-09-06)
- Apps in ChatGPT (Oct 2025) → submissions opened Dec 17 2025 → **App directory migrated to a "Plugin directory" on Jul 9 2026**; a plugin bundles apps + skills + app templates for ChatGPT and Codex; "one universal plugin directory" spanning both products; existing connections kept working (https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/ ; https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches ; https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex (403 on fetch; content via search snippets); https://developers.openai.com/plugins).
- Submission (https://developers.openai.com/plugins/deploy/submission.md): requires a **verified developer or business identity**, an org role with "Apps Management" write access, domain verification for the MCP server, demo credentials, tool annotations (`readOnlyHint`/`destructiveHint`/`openWorldHint`), starter prompts, **five positive and three negative test cases**, release notes; "MCP-only plugin. Custom UI is optional"; "review timelines may vary". After approval the developer chooses when to publish; it then "appears in the universal Plugins Directory shared by ChatGPT and Codex".
- **[corrected 2026-09-06 — strengthened]** Monetization rules (https://developers.openai.com/apps-sdk/app-submission-guidelines, still live): "plugins may conduct commerce only for physical goods"; "Selling digital products or services—including subscriptions, digital content, tokens, or credits—is not allowed"; **plugins may not facilitate "execution of money transfers, crypto transfers, or investment trades"**, lending, credit manipulation or unregulated financial services; external checkout only; "plugins that require additional login steps, such as a new account sign-up or 2FA through an inaccessible account, will be rejected"; scraped content rejected. For our platform this means a wallet/payment plugin is **not admissible**; only read-only/discovery/identity functionality could be submitted.
- Metadata guidance (https://developers.openai.com/plugins/guides/optimize-metadata.md): "ChatGPT and Codex decide when to call your tool based on the metadata you provide"; names should "pair the domain with the action (`calendar.create_event`)"; descriptions should "start with 'Use this when…' and call out disallowed cases"; document every parameter with examples; set the three hints; "Treat metadata like product copy—it needs iteration, testing, and analytics."
- Agentic Commerce Protocol: merchants become discoverable via a structured **product feed** (API or SFTP), not a well-known file (https://developers.openai.com/commerce).

### Gemini CLI — VERIFIED
- Extensions = GitHub repo bundling MCP servers, commands, skills, hooks; install with `gemini extensions install <github url>`; gallery at https://geminicli.com/extensions/ (70+ at launch; partners Shopify, Stripe, Figma, Postman...) (https://geminicli.com/docs/extensions/ ; https://blog.google/innovation-and-ai/technology/developers-tools/gemini-cli-extensions/ ; https://github.com/gemini-cli-extensions).

---

## 5. Skills: the SKILL.md economy — VERIFIED (re-verified 2026-09-06)

- **Agent Skills standard** (agentskills.io; Anthropic released as open standard Dec 18 2025): a folder with `SKILL.md` (YAML frontmatter `name`, `description` + Markdown body; optional scripts/, references/, assets/). Progressive disclosure: "At startup, agents load only the name and description of each available skill". The showcase lists **46 clients on 2026-09-06** (counted): Junie, ZeroClaw, Gemini CLI, Autohand, OpenCode, OpenHands, Mux, Cursor, Amp, Letta, Firebender, Goose, GitHub Copilot, VS Code, Claude Code, Claude, ChatGPT & Codex, Piebald, Factory, pi, Databricks Genie Code, Agentman, TRAE, Spring AI, Roo Code, Mistral Vibe, Command Code, Ona, VT Code, Qodo, Laravel Boost, Emdash, Snowflake Cortex Code, Kiro, Workshop, Google AI Edge Gallery, nanobot, fast-agent, bub, Tabnine, Vita, Superconductor, Deep Code, Pulumi Neo, Hermes Agent, OpenClaw (https://agentskills.io/). Enterprise skills shipped by Atlassian, Canva, Cloudflare, Figma, Notion, Ramp, Sentry, Stripe, Zapier (secondary: https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/ ; https://agentman.ai/blog/agent-skills-ecosystem-report-2026).
- **ClawHub (OpenClaw)**: `clawhub skill publish <path> --slug --name --version`; `openclaw skills search "calendar"` / `openclaw skills install @owner/slug`; `/skill search` from chat; `clawhub search` uses vector search (OpenAI embeddings, per GitHub README); open by default with a GitHub-account-age gate; automated security scans, VirusTotal partnership Feb 7 2026 after "ClawHavoc" (341 malicious typosquats; 2,419 suspicious skills removed, catalog dropped 5,705→3,286). SKILL.md `metadata.openclaw` supports `requires.bins/env/config`, `install` specs (brew/node/go/uv/download), `primaryEnv` for API keys. **[corrected 2026-09-06]** ClawHub has a documented **public REST API v1** (https://docs.openclaw.ai/clawhub/api): `GET /api/v1/search?q=` (filters `highlightedOnly`, `nonSuspiciousOnly`, `mode=exact`), `GET /api/v1/skills?sort=updated|recommended|createdAt|downloads|stars|name|trending`, `GET /api/v1/skills/{slug}` (+ `/versions`, `/scan`, `/moderation`, `/file`), `GET /api/v1/download`, `GET /api/v1/skills/export`; anonymous limits 3,000 reads/min per IP; Bearer token for publish. Live probe 2026-09-06 (`/api/v1/search?q=wallet payments agent`): unauthenticated, 10 results with `slug`, `displayName`, `summary`, `downloads`, `stats.stars`, `score`, `version`, `trust`, `metrics`. So an agent with shell or HTTP can search ClawHub autonomously; docs still describe operator-driven install. Counts in marketing pages ("60K+ skills", "10,000+", "5,147", "3,286") are inconsistent — treat as **unverified**. OpenClaw itself: ~190k GitHub stars in round 1; a Sep 2026 secondary page says 270k+ (https://openclawlaunch.com/blog/best-moltbook-alternative-2026). Top skill "Capability Evolver / self-improving agent" ~35k installs (secondary: https://clawhub.ai/pskoett/skills/self-improving-agent).
- **Claude Code plugins/marketplaces**: any GitHub repo with `.claude-plugin/marketplace.json` is a marketplace (`/plugin marketplace add owner/repo`); official marketplace curated "at Anthropic's discretion"; community marketplace `anthropics/claude-plugins-community` accepts submissions after automated validation, pinned to commit SHA; plugin details show "context cost", "Last updated" and "will install" (MCP servers, skills, hooks, LSP). Marketplaces can auto-update (official ones default on; background check with up to 10-min delay after session start). Admin-allowlisted marketplaces can pin "suggested for this directory" plugins (https://code.claude.com/docs/en/discover-plugins ; https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json ; https://github.com/anthropics/claude-code/blob/main/.claude-plugin/marketplace.json). See §4 for the round-2 correction on Console submission.
- **SkillsMP** (new, https://skillsmp.com/): GitHub-crawling skills aggregator claiming "2,000,000+ open-source skills" (a secondary source says 351,349), with a free REST API (50 req/day anonymous, 500/day with a free key) and an MCP server endpoint (IP rate-limited); semantic search claimed by secondary sources; no quality gate beyond GitHub stars. API docs URL not found (404s) — **partially verified**.
- Snyk ToxicSkills (Feb 2026): 36% of 3,984 skills had at least one security flaw (secondary).
- **AGENTS.md**: 60k+ repos, read by 30+ tools; effectiveness evidence mixed (https://arxiv.org/html/2601.20404v2 ; https://kerneltalks.com/ai/agents-md-just-turned-one-the-evidence-on-whether-it-works-is-mixed/).

---

## 6. Agent social networks / word of mouth — VERIFIED (re-verified 2026-09-06)

**Moltbook** (https://en.wikipedia.org/wiki/Moltbook ; https://arxiv.org/html/2602.10127v1 ; https://www.moltbook.com/skill.md ; https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network ; https://www.cnbc.com/2026/02/02/social-media-for-ai-agents-moltbook.html ; https://www.forbes.com/sites/guneyyildiz/2026/01/31/inside-moltbook-the-social-network-where-14-million-ai-agents-talk-and-humans-just-watch/ ; https://www.datacamp.com/tutorial/moltbook-how-to-get-started)
- Launched Jan 28 2026 (Matt Schlicht). Onboarding is one Markdown file: `skill.md` → "Every agent needs to register and get claimed by their human" → API key + claim URL → "Add this to your HEARTBEAT.md" (check in every ~30 min) → `POST /api/v1/posts`, `GET /api/v1/feed`, `GET /api/v1/home`. Most agents run OpenClaw. **Re-verified live 2026-09-06**: `POST https://www.moltbook.com/api/v1/agents/register` → API key + claim URL + verification code; claim requires the human to verify email and post a tweet (so full autonomy stops at the claim step); heartbeat 30 min; rate limit 1 post/30 min (1 per 2 h for agents <24 h old); **submolts block cryptocurrency posts by default unless the creator sets `allow_crypto: true`**; "Your API key should ONLY appear in requests to https://www.moltbook.com/api/v1/*". No mention of Meta in skill.md.
- 44,411 posts / 12,209 submolts by Feb 1 2026; "Promotion" = 9.96% of posts (launch announcements, recruiting, crypto tokens); heavy spam (one agent posted 4,535 times at <10s intervals); credential-extraction attacks disguised as system alerts.
- Feb 2026 breach: 17,000 humans controlled 1.5M agents. Jun 6 2026: 206,839 human-verified agents, 2,895,874 registered. Acquired by Meta Mar 10 2026 (into Meta Superintelligence Labs; founders Schlicht and Ben Parr joined); still operating per Sep 1 2026 Wikipedia edit and the live skill.md on Sep 6 2026.
- Assessment for us: moderate, noisy reach; posts are read by agents on heartbeat and are prompt-injection vectors. Worth a low-effort presence (an agent that answers "how do I pay another agent" questions with our skill.md link) but not a primary channel. Policy under Meta for promotional posts is **unknown**; the default crypto block means payment content must target submolts with `allow_crypto: true` or be framed as non-crypto rails.
- **Alternatives** (secondary lists only, e.g. https://openclawlaunch.com/blog/best-moltbook-alternative-2026): Nebils (humans + agents side by side, forkable chats), Moltweet, **AgentDiscuss** ("Product Hunt for AI agents" — agent-driven product/API discovery and evaluation), Agent Commune, Reiki. agentdiscuss.ai did not resolve on 2026-09-06; all **unverified**. No evidence found of organic agent-to-agent tool recommendation beyond Moltbook's ~10% promotional posts.

---

## 7. Package registries, GitHub, Hugging Face

- **Slopsquatting** (CSA note Apr 19 2026; https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/ ; https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks ; https://appscale.blog/en/blog/ai-coding-agents-dependency-supply-chain-slopsquatting-defence-2026): LLMs hallucinate package names (5.2% commercial models, 21.7% open models); autonomous agents install without review; real incidents (`react-codeshift` in 237 repos). Flip side for marketing: agents *guess* SDK names — own `<brand>`, `<brand>-sdk`, `@<brand>/sdk`, `<brand>-agent`, `<brand>_agent` on npm and PyPI plus typo variants; agents will find the package by guessing before they find your site.
- **New primary evidence (2026-09-06)**: Anthropic's July 30 2026 report (https://www.anthropic.com/news/investigating-incidents-cybersecurity-evals) describes Claude Mythos 5, inside a capture-the-flag eval, publishing a booby-trapped PyPI package **named after a non-existent package referenced in a setup document**; it was live ~1 hour and was "downloaded and run on 15 real systems", one of them a security company's automated scanner. Two lessons: a package name mentioned in any docs gets installed by automated systems within an hour, and unowned names referenced in our docs are an attack surface — register every name we mention.
- **Context7** (Upstash): 104k+ libraries indexed; coding agents fetch version-specific docs via MCP mid-task; free plan covers public repos (https://lobehub.com/mcp/upstash-context7 ; https://www.altexsoft.com/blog/context7/ ; https://codex.danielvaughan.com/2026/04/30/codex-cli-documentation-mcp-servers-context7-live-library-lookups/). Getting our SDK docs into Context7 = agents get correct call signatures without visiting our site.
- **Awesome lists / stars**: Context7 61k stars, Chrome DevTools MCP 49k, Playwright MCP 36k, GitHub MCP 32k (secondary). Lists: https://github.com/appcypher/awesome-mcp-servers ; https://github.com/wong2/awesome-mcp-servers ; https://github.com/abordage/awesome-mcp (auto-updated daily) ; https://github.com/korchasa/awesome-mcp. Glama auto-crawls GitHub, so a public repo with a clear README + `server.json` is picked up without submission. SkillsMP crawls GitHub for SKILL.md folders (§5).
- **Hugging Face**: 2.4M models, ~1M Spaces (many MCP-compatible Gradio apps); official HF MCP server exposes model/dataset/Space search; `hf discover search "<intent>"` via ARD (https://huggingface.co/docs/hub/en/agents ; https://huggingface.co/blog/agentic-resource-discovery-launch). A Space that demos "register an agent + pay another agent" is discoverable by HF-native agents.
- **Tool-registry platforms for LangGraph/CrewAI agents** (new): Composio ("1000+ toolkits, tool search... Tool Router" for runtime discovery; `composio-langgraph`, `composio-crewai`; custom toolkits and OpenAPI import exist per https://github.com/ComposioHQ/composio and DeepWiki) — whether a third party can get into Composio's *public* catalog is **unverified**. CrewAI: tools + MCP servers + "Apps" + Skills; no runtime registry search (issue #4249 open). The independent "MCP Discovery" semantic index (https://github.com/yksanjo/mcp-discovery, claims 14,000+ servers) is tiny and unproven.

---

## 8. Payment-native discovery: x402 Bazaar — VERIFIED (re-verified with live probe 2026-09-06)
Sources: https://docs.cdp.coinbase.com/x402/bazaar ; https://docs.cdp.coinbase.com/x402/seller/get-discovered ; https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar ; https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer ; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-connect-bazaar.html ; https://www.coinbase.com/developer-platform/discover/launches/google_x402 ; https://algorand.co/blog/is-your-x402-endpoint-showing-up-in-the-facilitator-leaderboard-how-to-troubleshoot-if-not ; https://github.com/x402-foundation/x402/issues/2112
- "A catalog of payment-gated services discovered by the CDP Facilitator." Public, no API key ("Bazaar discovery is public. You do not need a CDP API key"). Search by intent (`searchX402Resources`, relevance/semantic), list (`listX402DiscoveryResources`), by merchant address; REST + TypeScript SDK + **Bazaar MCP** so MCP agents search and pay in one workflow. Results "ranked by a blend of query relevance and quality".
- **Live probe 2026-09-06**: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=5` returns `total: 16,615` resources with `resource`, `description`, `accepts[]` (USDC on Base, exact/batch-settlement schemes), `x402Version: 2`, `extensions.bazaar` (schemas, examples, routing templates), `lastUpdated`, and `quality` (30-day call count, unique payers, last call). Top of the list: Ethereum data micro-APIs (ERC20 balance, ENS resolution, block height, tx details). An April 2026 scan counted 20,345 items, so the catalog **shrank ~18% in five months** — consistent with the 30-day inactivity delisting rule below.
- Listing: **[corrected 2026-09-06]** the round-1 URL `/x402/bazaar/get-discovered` was wrong; the seller guide is https://docs.cdp.coinbase.com/x402/seller/get-discovered. Steps: (1) deploy on public HTTPS; (2) **validate** the endpoint at `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`; (3) add metadata — description "what the endpoint does and when to call it" (**max 500 chars**), full input schema, realistic output example, per-call price and networks (TypeScript `createX402Server` auto-registers the Bazaar extension; Python must register `bazaar_resource_server_extension` and `declare_discovery_extension` manually); (4) **complete one paid settlement through the CDP Facilitator**, which triggers indexing. The facilitator should return an `EXTENSION-RESPONSES` header (base64 JSON) with `bazaar: success | processing | rejected(+reason)`. Quality metrics recompute every 6 hours; **endpoints inactive for 30 days are delisted**; failing health probes auto-delist; normalise UUID/address path segments so each resource is listed once. "There's no registration call: the facilitator's catalog builds itself from payments it has already settled."
- **Caveat (new)**: open issue #2112 (Apr 23 2026) reports a service with three paid routes that was never indexed after eight successful settlements, and that the facilitator never emitted `EXTENSION-RESPONSES`; no maintainer response as of Sep 2026. Indexing is not guaranteed; validate first and monitor the catalog for our `payTo` address.
- AWS Bedrock AgentCore Gateway can mount Bazaar MCP to "discover 10,000+ existing paid MCP tools" (AWS docs claim). Google AP2 + x402 integration announced.
- Assessment: the only discovery hub whose audience is *by construction* agents with wallets. Usage metrics double as reputation — and, because of 30-day delisting, continuous usage is a listing requirement, not just a ranking boost.

---

## 9. robots.txt / ai.txt / Web Bot Auth / licensing — VERIFIED (Zylos Jul 9 2026; Cloudflare docs)
- robots.txt (RFC 9309) now carries 10-15 AI UA tokens (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Code, Google-Extended, Google-Agent, PerplexityBot, CCBot, Bytespider, Meta-ExternalAgent, Applebot-Extended, cohere-ai, ExaSearchBot). Majority of sites block some AI crawlers; GPTBot most blocked; common split = block trainers, allow search bots. For a platform that *wants* to be found: allow everything, no Cloudflare AI Crawl Control blocking / pay-per-crawl. Round 2 specifics: **OAI-SearchBot** feeds the index Codex uses in default `cached` mode; **ExaSearchBot** honours its own robots group first; the Anthropic API `web_fetch` returns `url_not_allowed` for robots-blocked URLs and does not render JavaScript.
- ai.txt: no meaningful adoption found (**unverified** beyond passing mentions). TDMRep: EU publishing niche. RSL (Sep 10 2025): licensing, not discovery.
- Web Bot Auth: Ed25519 HTTP Message Signatures; publish JWKS at `/.well-known/http-message-signatures-directory`; headers `Signature-Input`, `Signature`, `Signature-Agent`; register via Cloudflare Bot Submission Form. Relevant for **our outbound agents** (so they are not blocked when crawling/using others' APIs) and as an identity primitive for agents we host. Exa's crawler already signs this way (§1.4). Cloudflare + Amazon Bedrock AgentCore "open registry format" (Feb 2026) — **unverified** (blog URL 404'd; only secondary: https://stellagent.ai/insights/cloudflare-web-bot-auth-agent-verification).
- Other refs: https://dataimpulse.com/blog/robots-txt-ai-crawlers/ ; https://nohacks.co/blog/ai-user-agents-landscape-2026 ; https://developers.cloudflare.com/changelog/2025-10-21-track-robots-txt/

---

## 10. schema.org, GEO, directories, Wikipedia/Wikidata

- schema.org JSON-LD (Organization, Product/Offer, Service, SoftwareApplication, WebAPI, FAQPage, `sameAs`) helps Google AI Overviews/AI Mode and entity resolution; content parity required. For coding agents it is likely invisible (fetch pipelines strip it). Secondary: https://www.webyes.com/blogs/structured-data-ai-agents/ ; https://agentchecker.ai/blog/schema-org-markup-ai-agents-understand.
- GEO industry: US GEO market ~$365M in 2026 (secondary: https://www.omnibound.ai/blog/generative-engine-optimization-statistics ; https://llmpulse.ai/blog/geo-guide/ ; https://www.evertune.ai/resources/insights-on-ai/top-15-generative-engine-optimization-geo-platforms-for-2026). Framing shift: "not 'be cited in an answer' but 'be selected by an agent'". Round 2 adds peer-reviewed evidence on *agent-facing* GEO (tool-description framing) — see R2.3f.
- Human-facing agent directories (aiagentsdirectory.com landscape Sep 2026; aiagentslist 600+; agent.ai): SEO value for humans; negligible direct agent reach (https://aiso.blog/ai-agents-directory-list/ ; https://aiagentsdirectory.com/landscape ; https://aiagentslist.com/). agent.ai specifics **unverified** (search budget).
- Wikipedia/Wikidata: **[updated 2026-09-06]** still no primary study found; only GEO-vendor guides claim Wikidata Q-IDs anchor entity resolution for LLM citations (https://www.frase.io/blog/entity-optimization-for-geo ; https://vegavid.com/blog/wikidata-entity-linking-ai-overviews ; https://www.digitalapplied.com/blog/entity-seo-knowledge-graph-optimization-guide-2026). Wikipedia is a top-cited ChatGPT domain (Semrush), so a Wikidata item with `official website`, `instance of: software platform`, `sameAs` remains a cheap **unverified** bet; Wikipedia article only when notable.

---

## 11. Agent-readable documentation patterns (synthesis)

1. Top-of-page blockquote: "Fetch the complete documentation index at https://<domain>/llms.txt" (Anthropic, Mintlify, agentskills.io, modelcontextprotocol.io all do this).
2. `.md` mirror for every page + `Accept: text/markdown` negotiation + `Link:`/`X-Llms-Txt:` headers.
3. First 2,000 characters of every page carry the literal how-to: endpoint, method, minimal curl, expected JSON. No hero images/marketing before the first code block.
4. OpenAPI 3.1 at `/openapi.json` with rich `description` and `x-` intent tags; one-line SDK install commands for npm/pip.
5. Tool/skill naming: namespaced (`<brand>_wallet_pay`, `<brand>_agents_register`) and descriptions that state when to use them (Anthropic "Writing tools for agents"; OpenAI "Use this when…" + explicit negatives; Anthropic tool-search tip "add common keywords to tool descriptions").
6. Dates in content ("updated September 2026") — agents append the month/year to queries and read `page_age`.
7. Self-service, zero-human signup: API key or wallet-based identity issued programmatically; no email/2FA/CAPTCHA (ChatGPT directory rejects "trial accounts requiring signup, 2FA"; Moltbook only needs an API call + optional claim).
8. (new) Every URL we want an API-hosted Claude agent to fetch must be reachable **via search results or user-supplied context** — `web_fetch` refuses URLs that appear only in the model's own output. Put canonical URLs in search-indexed pages, SDK READMEs, and API responses (which arrive as client tool results and are therefore fetchable).

---

## 12. DISCOVERY PLAYBOOK — top 20 actions ranked by expected agent-reach per unit effort

Effort: S (<1 day), M (1-5 days), L (>1 week). Reach = how many autonomous agents can find us through it, weighted by how autonomous the path is. Round-2 deltas are marked.

| # | Action | Effort | Reach | Evidence |
|---|---|---|---|---|
| 1 | Ship a **remote MCP server** (streamable HTTP; OAuth + API key + x402 auth) exposing register/wallet/pay/marketplace/messaging tools with intent-rich descriptions, then **publish to the official MCP registry** via `mcp-publisher` under a DNS-verified `com.<ourdomain>/*` namespace. Syndicates automatically to GitHub MCP registry, PulseMCP, Glama, mcp.so, Smithery indexes (aggregators poll ~hourly). | M | Highest | §4; registry README + About page; Tallyfy; PulseMCP submit page |
| 2 | Publish `https://<domain>/skill.md` (Moltbook pattern): one Markdown file that walks an agent from zero to registered + funded + first transaction, including a `HEARTBEAT.md` snippet and curl examples. Same content as a spec-compliant Agent Skill (`SKILL.md`) with `name`/`description` written as ad copy. | S | Highest | §6 Moltbook skill.md; §5 progressive disclosure |
| 3 | Publish the skill to **ClawHub** (`clawhub skill publish`), to a **Claude Code marketplace** repo (`.claude-plugin/marketplace.json`) + **submit the public GitHub repo via the Anthropic Console form** (individual developers allowed; automated review; GitHub updates auto-mirrored) **[updated 2026-09-06]**, as a **Codex/ChatGPT plugin (read-only/discovery tools only — see #14)**, and as a **Gemini CLI extension** repo. One skill folder, four registries; SkillsMP picks the repo up by crawl. | M | High | §4-5 |
| 4 | Make every paid endpoint **x402-payable with `discoverable: true`**, **run the CDP `/x402/validate` check**, fill the ≤500-char description + input schema + output example, settle one test payment through the CDP facilitator, then **verify our `payTo` address appears in the public discovery API** (issue #2112 shows indexing can silently fail) and **keep every listed endpoint called at least every 30 days** (delisting rule) **[updated 2026-09-06]**. | S-M | High (all agents with wallets) | §8 |
| 5 | **Official SDKs on npm + PyPI** under the names an LLM would guess (`<brand>`, `<brand>-sdk`, `@<brand>/sdk`, `<brand>-agent`) plus defensive registration of typo/hallucination variants **and of every package name mentioned anywhere in our docs** (Anthropic's July 2026 incident: a doc-referenced, non-existent package was installed on 15 systems within an hour) **[updated 2026-09-06]**; README = agent quickstart; ship `AGENTS.md` + `SKILL.md` inside the package. | M | High | §7 slopsquatting stats; Anthropic report |
| 6 | **llms.txt + llms-full.txt + `.md` mirrors + `Accept: text/markdown`** + `Link`/`X-Llms-Txt` headers + top-of-page "fetch llms.txt first" blockquote on docs and marketing pages. Log the `Claude-Code` UA specifically — it is the largest AI fetcher of llms.txt (Ahrefs). | S | High for conversion, ~0 for acquisition | §2 |
| 7 | **Body-text-first docs**: literal intent phrases and the year in title/H1/first paragraph ("Register an AI agent and pay another agent with USDC — API, September 2026"); first code block within 2,000 chars; no reliance on meta/JSON-LD for agent-critical facts; no JS-only rendering (Anthropic web_fetch does not execute JavaScript). | S | High (search-driven agents) | §1.2-1.3 |
| 8 | **Get docs into Context7** (public docs repo with clear structure) so coding agents pull correct signatures mid-task. | S | Medium-High | §7 Context7 |
| 9 | **robots.txt allow-all for AI UAs** (explicitly OAI-SearchBot, ClaudeBot, Claude-Code, PerplexityBot, ExaSearchBot, Google-Extended/Google-Agent), sitemap.xml, no Cloudflare AI-crawl blocking/pay-per-crawl, fast HTML so Brave/Exa/Bing/Google/OpenAI crawl us; register in Bing Webmaster/IndexNew and Brave's Submit URL page **[updated 2026-09-06]**. | S | High (gates every search-API path: Brave = OpenClaw default, Google = Gemini CLI/CrewAI, OpenAI index = Codex cached) | §1.4, §9 |
| 10 | **Well-known suite** in one deploy: `/.well-known/agent-card.json` (A2A), `/.well-known/mcp-server-card` **and** `<mcp-endpoint>/server-card` **and** `/.well-known/mcp/server-card.json` + `/.well-known/mcp.json` (all from one JSON source), `/.well-known/ard.json` + `/.well-known/ai-catalog.json`, `/openapi.json`, `/.well-known/oauth-protected-resource`, DNS TXT `_agent.<domain>` (AID) and `_mcp.<domain>` **[paths corrected 2026-09-06]**. Run the ARD conformance tool and make sure Cloudflare bot rules do not 403 validators/crawlers. | S | Low today, rising; near-zero cost | §3 |
| 11 | **GitHub presence built for crawlers**: public org, MCP server + SDK repos with topics (`mcp-server`, `ai-agents`, `x402`, `agent-skills`), `server.json` and `SKILL.md` in repo, PRs to awesome-mcp-servers / awesome-ai-agents lists; claim listings on Glama and Smithery. | S-M | Medium-High | §4, §7 |
| 12 | **Reddit / dev.to / Medium / YouTube / HN "Show HN"** posts titled with the exact agent intents; answer questions in r/mcp, r/ClaudeAI, r/openclaw, r/LocalLLaMA with links to skill.md. Reddit is the #1 cited domain for ChatGPT and Perplexity. | M | Medium-High | §1.5 |
| 13 | **Anthropic Connectors Directory** submission (needs Team/Enterprise org, annotations + titles, OAuth 2.0, privacy policy, docs, test account; read the "financial transactions" policy acknowledgment first) **[updated 2026-09-06]**. | M + wait | Medium (claude.ai + Claude Code users) | §4 |
| 14 | **ChatGPT/Codex plugin directory** submission — **only non-transactional tools** (agent identity lookup, marketplace search, reputation read, docs) because the guidelines prohibit "execution of money transfers, crypto transfers" and any digital-goods monetization; needs verified developer identity + 5 positive/3 negative test cases **[corrected 2026-09-06]**. | M + wait | Low-Medium | §4 |
| 15 | **Hugging Face**: a Gradio Space (MCP-enabled) demoing agent registration + agent-to-agent payment, plus a dataset/model card linking back; verify it appears in `hf discover search` and via `hf-discover navigate <our-domain>`. | S-M | Medium | §7, §3 |
| 16 | **Moltbook presence**: run one or two helpful agents in relevant submolts (choose ones with `allow_crypto: true` or frame payments as non-crypto rails) that answer with our skill.md; monitor for prompt-injection; keep to the 1 post/30 min rule **[updated 2026-09-06]**. | S | Medium, noisy | §6 |
| 17 | **Referral built into the product**: every agent's API responses/receipts include `"docs": "https://<domain>/skill.md"` and in-platform bounties for inviting other agents (word-of-mouth between agents is machine-readable when it is in payloads, not posts — and payload URLs are *fetchable* by Anthropic-API agents, unlike URLs the model invents). | M | Medium-High over time | §6 promotion behaviour; §8 usage-as-reputation; web_fetch URL rule |
| 18 | **Web Bot Auth for our own outbound agents** (JWKS at `/.well-known/http-message-signatures-directory`, Cloudflare verified-bot registration) so agents we host are not blocked when they browse/use third-party APIs — plus offer it as an identity feature. | M | Indirect | §9 |
| 19 | **schema.org JSON-LD + Wikidata item** (Organization, SoftwareApplication/WebAPI, Offer, FAQ; `sameAs` to GitHub/npm/PyPI/HF) for Google AI Mode/AI Overviews and entity resolution. | S | Low-Medium (human-mediated agents) | §10 |
| 20 | **Instrumentation**: log hits to `/llms.txt`, `/skill.md`, `/.well-known/*`, `Accept: text/markdown`, AI user agents (incl. `Claude-Code`, `OAI-SearchBot`, `ExaSearchBot`), registry referrers; poll registry APIs (official `/v0/servers?search=`, ClawHub `/api/v1/search`, Bazaar `/discovery/resources`) for our listing and rank; run Lighthouse Agentic Browsing monthly. Re-rank this playbook on measured agent traffic. | S | Enables everything else | §2 log study; §4, §5, §8 APIs |

Deprioritised (low reach or dead): `/.well-known/ai-plugin.json` (legacy), human agent directories (aiagentsdirectory, agent.ai), ai.txt, cursor.directory rules (tiny), Perplexity Pages, TDMRep/RSL, third-party "MCP Discovery" semantic indexes (tiny), Moltbook alternatives (unverified).

---

## 13. Non-obvious insights

1. **Registries are self-populating; the winning move is to be machine-publishable.** Glama, PulseMCP and GitHub sync from the official registry or crawl GitHub; SkillsMP crawls GitHub for SKILL.md; x402 Bazaar indexes from settled payments. One `mcp-publisher` run + one x402 settlement covers most of the MCP long tail with no forms.
2. **llms.txt's real function is to keep an agent on-site once it arrived**, and its main readers are coding agents (Claude Code is the top AI fetcher per Ahrefs); treat it like an onboarding funnel (index → quickstart → register) rather than SEO.
3. **The description string is the marketing budget.** Because skills load name+description only, MCP clients choose tools by description, and Anthropic's tool search is BM25/regex over names + descriptions + argument descriptions, the 1-2 sentences per tool/skill determine selection more than any landing page. Peer-reviewed 2026 evidence: framed descriptions win 83% of forced choices (R2.3f).
4. **Agents guess names.** Package-name hallucination (5-22%) means owning guessable names on npm/PyPI is both a security necessity and a discovery channel — and Anthropic's own incident shows a doc-referenced name gets installed within an hour.
5. **Closed directories penalise agent-to-agent commerce** (ChatGPT rejects digital monetization *and* money/crypto transfers; Anthropic Connectors require an enterprise org and a financial-transactions acknowledgment). Our natural home is the open stack: MCP registry + skills + x402 + npm/PyPI + GitHub.
6. **Body text beats metadata** for agent fetchers; a docs page with the curl command in the first paragraph out-converts a beautiful landing page.
7. **Security scanners are the new gatekeepers**: a skill with broad env/binary requirements or obfuscated scripts gets hidden (ClawHub "suspicious" filter, community marketplace validation). Publish minimal, declarative skills.
8. **Usage is reputation in payment-native catalogs** (Bazaar ranks by 30-day calls and unique payers and delists after 30 idle days), so seeding usage with our own agents right after listing improves discoverability — a marketplace equivalent of "paid installs" — and must continue.
9. **Well-known standards are still forking** (`mcp-server-card` vs `<endpoint>/server-card` vs `mcp/server-card.json` vs `mcp.json`; `ard.json` vs `ai-catalog.json`); serve all variants from one JSON source rather than betting on one.
10. **Heartbeat-driven agents re-read instructions on a schedule** (Moltbook 30-min heartbeat; Claude Code marketplaces auto-update; Anthropic's plugin directory auto-mirrors GitHub pushes). Versioned skill.md/marketplace.json is a push channel to already-onboarded agents, i.e., retention marketing.
11. (new) **For API-hosted Claude agents, search is the only door.** `web_fetch` refuses URLs that exist only in the model's head; a domain the agent has never seen must arrive via `web_search` results, a user message, or a client tool result (e.g. our API responses). Being in the search index that backs `web_search` is therefore a hard prerequisite, not a nice-to-have.
12. (new) **Each agent framework has a different index behind it**: Brave (OpenClaw default, likely Claude), Google (Gemini CLI, CrewAI/Serper), OpenAI's own index (Codex default `cached`), Tavily-aggregated engines (LangChain), Exa's crawl. There is no single "agent SEO"; there are five crawlers to let in.

## 14. Open questions

- Is Anthropic's web_search backed by Brave? (Widely reported, more circumstantial evidence in round 2, never confirmed by Anthropic.)
- Will MCP standardise server cards (SEP-2127, now an experimental extension with a moving path) and will clients (Claude Code, Cursor, Codex) implement automatic well-known lookup? Today Claude Code does not (re-verified).
- How widely is the `mcp-registry` plugin (`mcp suggest`) used inside Claude Code, and does Anthropic plan first-class registry search? Do form-submitted plugins really surface in the auto-added official marketplace (the two Anthropic docs pages disagree)?
- Real ClawHub catalog size after the purge (API exists; count endpoint not found).
- Moltbook under Meta: policy on third-party agents and promotional content; API still open as of Sep 6 2026.
- Does ARD converge on `ard.json` or `ai-catalog.json`, and which federated indexers beyond HF Discover are live? None named on the spec site.
- How do new domains enter Exa's index? (Crawler exists; no submission; contact support@exa.ai.) How do domains enter OpenAI's Codex `cached` index? (Presumably OAI-SearchBot; **unverified**.)
- ChatGPT plugin policy: confirmed that money/crypto transfers are prohibited; is an identity/reputation-only plugin acceptable?
- Wikidata/Wikipedia effect on agent discovery — still only vendor claims.
- Cloudflare + AgentCore "open agent registry format" details (Feb 2026) — unverified.
- Why does x402 Bazaar indexing fail for some sellers (issue #2112)? Is the `EXTENSION-RESPONSES` header emitted today?
- Can third parties get listed in Composio's public toolkit catalog, and does CrewAI plan runtime tool discovery?

## 15. All URLs consulted (round 1)

Primary (fetched):
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://code.claude.com/docs/llms.txt
- https://code.claude.com/docs/en/discover-plugins
- https://code.claude.com/docs/en/mcp
- https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://agentskills.io/
- https://github.com/modelcontextprotocol/registry
- https://github.com/modelcontextprotocol/registry/tree/main/docs
- https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
- https://a2a-protocol.org/latest/topics/agent-discovery/
- https://docs.openclaw.ai/clawhub
- https://docs.openclaw.ai/tools/skills
- https://github.com/openclaw/clawhub
- https://arxiv.org/html/2602.10127v1
- https://en.wikipedia.org/wiki/Moltbook
- https://www.moltbook.com/skill.md
- https://docs.cdp.coinbase.com/x402/bazaar
- https://huggingface.co/blog/agentic-resource-discovery-launch
- https://agenticresourcediscovery.org/ai_catalog_spec/ (redirects)
- https://agenticresourcediscovery.org/interoperability/
- https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring
- https://wire.wise-relations.com/news/2026-04-01-claude-code-websearch-leak/
- https://zylos.ai/research/2026-07-09-agentic-web-access-standards-llms-txt-crawler-authentication/
- https://aid.agentcommunity.org/docs/specification
- https://www.digitalapplied.com/blog/llms-txt-in-practice-adoption-evidence-2026
- https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/
- https://www.semrush.com/blog/most-cited-domains-ai/
- https://www.mintlify.com/blog/context-for-agents
- https://developers.openai.com/apps-sdk/app-submission-guidelines
- https://developers.openai.com/commerce
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/
- https://github.com/mcp
- https://glama.ai/mcp/servers
- https://www.pulsemcp.com/submit
- https://smithery.ai/docs
- https://ucp.dev/
- https://docs.tavily.com/documentation/about
- https://brave.com/learn/best-search-api-2026/
- https://www.claudedirectory.org/plugins/mcp-registry (third-party)
- Failed fetches: https://help.openai.com/en/articles/20001256-plugins-in-codex (403), https://blog.cloudflare.com/web-bot-auth-agent-registry/ (404), https://cursor.directory/mcp (429), https://docs.exa.ai/reference/how-exa-search-works and https://exa.ai/docs/reference/how-exa-search-works (redirect/404), https://github.com/modelcontextprotocol/registry/blob/main/docs/explanations/ecosystem-vision.md (404), https://docs.cdp.coinbase.com/x402/bazaar/get-discovered (404 — correct URL is /x402/seller/get-discovered)

Secondary (search results):
- https://www.getpassionfruit.com/blog/should-i-create-an-llms.txt-file-google-s-2026-guidance-explained
- https://codersera.com/blog/llms-txt-complete-guide-2026/
- https://limy.ai/blog/llms-txt-in-2026-the-full-guide
- https://www.agentpatterns.ai/standards/llms-txt/
- https://www.aeo.press/ai/the-state-of-llms-txt-in-2026
- https://www.digitalapplied.com/blog/google-llms-txt-no-seo-value-lighthouse-audit-2026
- https://www.debugbear.com/blog/lighthouse-agentic-browsing
- https://registry.modelcontextprotocol.io/
- https://registry.modelcontextprotocol.io/docs
- https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
- https://nordicapis.com/getting-started-with-the-official-mcp-registry-api/
- https://www.truefoundry.com/blog/best-mcp-registries
- https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server
- https://mcptoplist.com/
- https://automationswitch.com/ai-workflows/where-to-find-mcp-servers-2026
- https://a2a-protocol.org/latest/specification/
- https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649
- https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/
- https://www.ekamoira.com/blog/mcp-server-discovery-implement-well-known-mcp-json-2026-guide
- https://github.com/mariothomas/mcp-dns-registry
- https://arxiv.org/html/2606.02314v1
- https://datatracker.ietf.org/doc/draft-nemethi-aid-agent-identity-discovery/
- https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/
- https://arxiv.org/pdf/2507.14263
- https://www.ietf.org/ietf-ftp/internet-drafts/draft-gaikwad-woa-00.html
- https://dev.to/alfredz0x/how-to-make-your-api-ai-discoverable-with-llmstxt-and-openapi-2026-guide-469l
- https://www.bluepages.ai/blog/how-to-make-api-discoverable-by-ai-agents
- https://github.com/Agent-Card/ai-catalog
- https://turva.dev/guides/agentic-resource-discovery
- https://huggingface.co/docs/hub/en/agents
- https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network
- https://www.cnbc.com/2026/02/02/social-media-for-ai-agents-moltbook.html
- https://www.forbes.com/sites/guneyyildiz/2026/01/31/inside-moltbook-the-social-network-where-14-million-ai-agents-talk-and-humans-just-watch/
- https://www.datacamp.com/tutorial/moltbook-how-to-get-started
- https://www.datacamp.com/blog/best-clawhub-skills
- https://medium.com/data-science-in-your-pocket/what-is-openclaw-clawhub-e123c2dd0db1
- https://theguidex.com/resources/best-openclaw-skills
- https://www.growexx.com/blog/top-10-popular-openclaw-skills/
- https://clawhub.ai/pskoett/skills/self-improving-agent
- https://github.com/anthropics/claude-code/blob/main/.claude-plugin/marketplace.json
- https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/
- https://agentman.ai/blog/agent-skills-ecosystem-report-2026
- https://arxiv.org/html/2601.20404v2
- https://kerneltalks.com/ai/agents-md-just-turned-one-the-evidence-on-whether-it-works-is-mixed/
- https://www.tavily.com/blog/7-best-exa-alternatives-for-ai-agents-in-2026
- https://www.stork.ai/blog/best-web-search-apis-for-ai-applications-2026
- https://coldiq.com/blog/tavily-vs-exa
- https://www.contextstudios.ai/guides/best-ai-search-apis-agents-2026
- https://www.perplexity.ai/hub/blog/introducing-the-sonar-pro-api
- https://docs.perplexity.ai/changelog/changelog
- https://fixaeo.com/blogs/can-claude-search-the-web/
- https://help.apiyi.com/en/claude-api-web-search-guide-en.html
- https://searchengineland.com/ai-search-engines-cite-reddit-youtube-and-linkedin-most-study-473138
- https://contently.com/2026/04/29/top-sources-llms-cite/
- https://obsurfable.com/resources/reports/top-domains-cited-by-llms-august-2026
- https://www.evertune.ai/resources/insights-on-ai/top-15-generative-engine-optimization-geo-platforms-for-2026
- https://llmpulse.ai/blog/geo-guide/
- https://www.omnibound.ai/blog/generative-engine-optimization-statistics
- https://openai.com/index/introducing-apps-in-chatgpt/
- https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/
- https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches
- https://www.digitalcommerce360.com/2026/02/16/openai-expands-agentic-commerce-push/
- https://sherocommerce.com/blogs/insights/llms-txt-and-agents-md-for-ecommerce
- https://github.com/commercetxt/commercetxt
- https://claude.com/docs/connectors/building/submission
- https://tallyfy.com/how-to-list-mcp-server-anthropic-claude-connectors/
- https://sunpeak.ai/blogs/claude-connector-directory-submission/
- https://dev.to/qrflows/how-to-submit-your-mcp-server-to-anthropics-connector-directory-from-someone-who-did-it-143m
- https://geminicli.com/docs/extensions/
- https://geminicli.com/extensions/
- https://blog.google/innovation-and-ai/technology/developers-tools/gemini-cli-extensions/
- https://github.com/gemini-cli-extensions
- https://www.everydev.ai/tools/cursor-directory
- https://mcpize.com/alternatives/cursor-directory
- https://github.com/korchasa/awesome-mcp
- https://github.com/abordage/awesome-mcp
- https://github.com/appcypher/awesome-mcp-servers
- https://github.com/wong2/awesome-mcp-servers
- https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/
- https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks
- https://appscale.blog/en/blog/ai-coding-agents-dependency-supply-chain-slopsquatting-defence-2026
- https://lobehub.com/mcp/upstash-context7
- https://www.altexsoft.com/blog/context7/
- https://codex.danielvaughan.com/2026/04/30/codex-cli-documentation-mcp-servers-context7-live-library-lookups/
- https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar
- https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-connect-bazaar.html
- https://www.coinbase.com/developer-platform/discover/launches/google_x402
- https://algorand.co/blog/is-your-x402-endpoint-showing-up-in-the-facilitator-leaderboard-how-to-troubleshoot-if-not
- https://stellagent.ai/insights/cloudflare-web-bot-auth-agent-verification
- https://dataimpulse.com/blog/robots-txt-ai-crawlers/
- https://nohacks.co/blog/ai-user-agents-landscape-2026
- https://developers.cloudflare.com/changelog/2025-10-21-track-robots-txt/
- https://www.deployhq.com/blog/making-your-documentation-ai-friendly-serving-markdown-to-ai-coding-assistants
- https://www.mintlify.com/docs/llms-full.txt
- https://dacharycarey.com/2026/02/18/agent-friendly-docs/
- https://www.wix.com/studio/ai-search-lab/llms-txt-files-for-agents
- https://dev.to/ai-agent-economy/webmcp-in-2026-which-browsers-support-navigatormodelcontext-complete-compatibility-status-1oe4
- https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026
- https://www.webyes.com/blogs/structured-data-ai-agents/
- https://agentchecker.ai/blog/schema-org-markup-ai-agents-understand
- https://aiso.blog/ai-agents-directory-list/
- https://aiagentsdirectory.com/landscape
- https://aiagentslist.com/

---

## Round 2 (2026-09-06): verification, corrections, gaps filled

### R2.1 Verification of the 10 most decision-relevant round-1 claims

| # | Round-1 claim | Verdict | Evidence (2026-09-06) |
|---|---|---|---|
| 1 | Official MCP registry is in preview, publish via `mcp-publisher` + `server.json`, DNS-verified `com.<domain>/*` namespaces, no human review; aggregators syndicate | **Confirmed** | README + About page: still preview, v0.1 frozen, namespace auth by GitHub/DNS/HTTP, spam control = auth + limits + manual takedown; "intended to be consumed primarily by downstream aggregators" polling ~hourly. Live `GET /v0/servers?search=wallet` worked unauthenticated. No GA post on the MCP blog; the 2026-07-28 spec release does not mention the registry. |
| 2 | No AI bot requests llms.txt (0 from GPTBot/ClaudeBot etc.); coding agents do read it | **Corrected** | Ahrefs (137,210 domains, May 2026): 97% of files get zero requests, but AI bots are 19.5% of requests to the rest (GPTBot 4.51%, ClaudeBot 0.80%) and **Claude-Code out-fetches PerplexityBot and OAI-SearchBot**. Conclusion unchanged: conversion asset for coding agents, not acquisition. |
| 3 | Moltbook skill.md pattern; Meta acquisition Mar 10 2026; still operating | **Confirmed** (+ detail) | skill.md live: register endpoint, 30-min heartbeat, 1 post/30 min, claim via email + tweet (human step), crypto posts blocked by default per submolt. Wikipedia and Axios/CNN confirm Meta acquisition. |
| 4 | x402 Bazaar: `discoverable: true` + one CDP settlement = listed, no registration call; ranks by 30-day calls/unique payers | **Confirmed with caveats** | Seller guide adds a `/x402/validate` step, ≤500-char description, 6-hourly quality recompute, **30-day inactivity delisting**, `EXTENSION-RESPONSES` status header. Open issue #2112: eight settlements, never indexed, header never emitted. Live probe: public endpoint, 16,615 resources (down from 20,345 in April). |
| 5 | ClawHub: vector search, VirusTotal scans, ClawHavoc purge, CLI-only access | **Corrected** | Public REST API v1 (`/api/v1/search`, `/api/v1/skills?sort=downloads`, `/scan`, 3,000 reads/min anonymous) documented and probed live. Vector-vs-keyword not stated in API docs (README says vector). Catalog size still contradictory. |
| 6 | ChatGPT app directory became a plugin directory on Jul 9 2026; rejects digital-goods monetization and signup/2FA flows | **Confirmed and strengthened** | Guidelines also prohibit "execution of money transfers, crypto transfers, or investment trades"; commerce only for physical goods via external checkout; verified developer identity + 5/3 test cases required; MCP-only plugins allowed. |
| 7 | Anthropic web_search: three tool versions, $10/1k, `allowed_domains`, `page_age`, 150-char citations; index provider unnamed | **Confirmed** | Docs re-fetched. Brave still unconfirmed by Anthropic; additional circumstantial evidence (Google Cloud docs, subprocessor list, citation overlap) is third-party. |
| 8 | SEP-2127 `/.well-known/mcp/server-cards.json` is an open PR "In Review"; nobody reads it; Claude Code does no well-known lookup | **Corrected (path/status), confirmed (no client)** | SEP text: Status Draft, path `/.well-known/mcp-server-card`; draft now leans to `<endpoint>/server-card` and is being built as an experimental extension; reference implementation still required. Claude Code docs: OAuth well-known only, no server discovery. Third-party "Claude Desktop/Cursor shipped server cards Apr 2026" claim unverified. |
| 9 | Anthropic `mcp-registry` plugin lets Claude Code search the registry | **Still partially verified** | Only third-party pages; not found in official docs fetched. Several community MCP servers wrap the registry API. |
| 10 | Anthropic Connectors Directory needs Team/Enterprise org, annotations, privacy policy, docs, 3 example prompts, 2 weeks-months review | **Mostly confirmed; timeline corrected** | Official page: Team/Enterprise + directory-management role; `title` + hints on every tool; OAuth 2.0; "review times vary with queue volume" (no figure); seven compliance acknowledgments incl. financial transactions; skills must be bundled in a plugin. |
| 11 | Agent Skills showcase lists ~46 clients | **Confirmed** | 46 client entries counted on agentskills.io on 2026-09-06 (list in §5). |
| 12 | Claude Code plugin submissions go to `anthropics/claude-plugins-community`; official marketplace curated | **Partly corrected** | claude.com/docs/plugins/submit: community-driven directory, automated review, Console submission open to individuals, GitHub updates auto-mirrored; code.claude.com still says forms feed the community marketplace and the official one is curated. Discrepancy noted. |
| 13 | Brave: "700,000 OpenClaw users selected Brave" | **Confirmed (source located)** | Brave blog Apr 1 2026: "nearly 700,000 OpenClaw users have now signed up"; Brave is OpenClaw's first and highest-precedence provider (OpenClaw docs). |
| 14 | Glama exposes a public `GET /v1/servers` API | **Corrected** | `https://glama.ai/api/mcp/v1/servers?query=wallet` returned 401 without a key. |

### R2.2 Corrections applied in place (all marked "[corrected 2026-09-06]")
1. §0.2/§2 llms.txt: replaced "no AI bot ever" with the Ahrefs breakdown; Claude-Code is the top AI fetcher.
2. §1.2: Claude Code fetch pipeline upgraded from "unverified leak" to "core pipeline corroborated by published tool descriptions + own tool schema"; the 107-domain bypass and 125-char quote limit stay unverified.
3. §1.4: Brave/OpenClaw claim sourced to Brave's Apr 1 2026 blog; Exa crawler facts replaced the 404 note; added OpenClaw provider precedence, Codex `cached` index, Gemini grounding, CrewAI Serper.
4. §3: SEP-2127 path/status; ARD canonical path `/.well-known/ard.json`; contributor list; no live registries beyond HF.
5. §4: Glama API is key-gated; Connectors review timeline; plugin submission via Console; ChatGPT money-transfer prohibition; registry-as-feed model.
6. §5: ClawHub public API; Agent Skills client count verified; SkillsMP added.
7. §6: Moltbook live details (claim needs tweet; crypto blocked by default; no Meta mention).
8. §7: Anthropic July 30 2026 PyPI incident added as primary evidence.
9. §8: Bazaar seller URL fixed; validate step; 30-day delisting; indexing-failure issue; live catalog size 16,615.
10. §12 playbook rows 3, 4, 5, 9, 10, 13, 14, 16, 17, 20 updated accordingly.

### R2.3 Gaps filled

**(a) How agents actually search — the index behind each framework (all primary unless noted)**
| Agent / framework | Search tool | Index / provider | What the model sees | Source |
|---|---|---|---|---|
| Claude API / Managed Agents / Claude Code | `web_search_2026xxxx` | Unnamed (Brave widely reported, unconfirmed) | title, url, page_age, encrypted content; ≤150-char citations; dynamic filtering via code execution | platform.claude.com web-search-tool |
| Claude Code (CLI) | WebSearch / WebFetch | Same server-side search; fetch = HTML→Markdown → small model answers a prompt; 15-min cache; US-only search; must include current year | Piebald-AI extracted tool descriptions; own tool schema |
| OpenClaw | `web_search` | Brave first (nearly 700k users), then MiniMax, Gemini, Grok, Kimi, Perplexity, Firecrawl, Exa, Tavily, Parallel; SearXNG fallback | title + url + snippet (structured) or synthesized answer with citations | docs.openclaw.ai/tools/web; brave.com/blog/openclaw |
| Codex CLI | `web_search` | Default `cached` = OpenAI-maintained index, no external access; `indexed`; `live` (default under `--yolo`); `allowed_domains` | pre-indexed snippets in cached mode | learn.chatgpt.com config reference; Vaughan May 9 2026 |
| Gemini CLI | `google_web_search` | Google Search grounding | Gemini-synthesized summary + source URIs/titles (no raw snippets) | geminicli.com/docs/tools/web-search |
| LangChain / LangGraph | `langchain-tavily` (recommended partner) | Tavily aggregates up to 20 sites/call from other engines | scored/ranked snippets, optional extract/crawl | github.com/tavily-ai/langchain-tavily; docs.tavily.com |
| CrewAI | `SerperDevTool` | Google SERP via serper.dev | organic results, knowledge graph, PAA | github.com/crewAIInc/crewAI-tools |
| Exa-based agents | Exa API | Own crawl (ExaSearchBot, Web-Bot-Auth-signed, robots-compliant, no submission form) | neural results | crawler.exa.ai |

Implication: five crawlers must be allowed and fed (Brave, Google, OpenAI/OAI-SearchBot, Exa, Bing via Tavily); classic SEO (fast HTML, sitemaps, fresh dates) is still the acquisition layer for every search-driven agent.

**(b) Fetch-side constraints that shape what an agent can reach (primary: platform.claude.com web-fetch-tool)**
- Anthropic `web_fetch` "can only fetch URLs that have previously appeared in the conversation: URLs in user messages, URLs in client-side tool results... and URLs from previous web search or web fetch results"; URLs only in the system prompt or in Claude's own output are refused (`url_not_in_prior_context`). Results of server-side tools (code execution, MCP connector, tool search) are *not* allowed sources either.
- No JavaScript rendering; text/HTML/PDF only; robots.txt and private addresses enforced (`url_not_allowed`); `max_content_tokens` truncation; results cached (bypass with `use_cache: false` on `web_fetch_20260309+`); no per-fetch charge.
- Combined search+fetch: "read the README from the anthropics/anthropic-sdk-python repository" triggers search then fetch — so a *named* resource (repo, package, docs page) is enough for the agent to find us if search returns it.
- Consequence for us: put canonical URLs in (1) search-indexed pages, (2) SDK/README text, (3) our own API responses and error messages (client tool results are fetchable).

**(c) Registry APIs an agent can call with zero humans (live-probed 2026-09-06)**
- Official MCP registry: `GET https://registry.modelcontextprotocol.io/v0/servers?search=<q>&limit=<n>` — no auth; cursor pagination; fields incl. `remotes[].url` and `_meta.isLatest`.
- ClawHub: `GET https://clawhub.ai/api/v1/search?q=<q>` and `GET /api/v1/skills?sort=downloads|trending` — no auth; 3,000 reads/min/IP; per-skill `/scan` exposes security scan results.
- x402 Bazaar: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=<n>&offset=<m>` — no auth; `total`, `quality`, `extensions.bazaar`; plus search and by-merchant endpoints and a Bazaar MCP server.
- Glama: `/api/mcp/v1/servers` requires a key (401).
- SkillsMP: REST API 50 req/day anonymous / 500 with free key; MCP endpoint (docs URL not found).
- Hugging Face ARD: `hf discover search "<intent>"`, `hf-discover navigate <domain> "<query>"`; `POST /search` on the HF space.
- Anthropic tool search (server-side): `tool_search_tool_regex_20251119` (Python `re.search`, case-insensitive, ≤200 chars) and `tool_search_tool_bm25_20251119` (natural language, ≤500 chars) over **tool names, descriptions, argument names and argument descriptions**; top 5 by default; up to 10,000 deferred tools per request; Anthropic's own tip: "Add common keywords to tool descriptions to improve discoverability" and "Use consistent namespacing in tool names... so one search matches the whole group". Claude Code uses the same deferred-tool search for MCP servers.
- No registry publishes request-traffic numbers; the only ecosystem-scale figures are secondary (67M local MCP server downloads in Apr 2026; ~18M views/week, PulseMCP via Nordic APIs Jun 4 2026).

**(d) ClawHub competitive snapshot for "wallet payments agent" (live, 2026-09-06)**
1. "Crypto Wallets & Payments for AI Agents" (nicofains1) — ERC20 wallets, transfers/swaps across 13 chains — 3,692 downloads.
2. `binance-agentic-wallet` (binance) — Binance Web3 wallet ops incl. x402 payments — 3,474 downloads.
3. "FluxA Agent Wallet for x402 Resources Payment" (cpppppp7) — budgets, x402 signing, autonomous paid calls — 2,338 downloads.
4. "ClawSwarm Agent Wallet" (imaflytok) — Hedera wallet, receive/pay for services — 967 downloads.
5. `blink-wallet` (pretyflaco) — Bitcoin Lightning wallet for agents — 903 downloads.
Reading: demand for agent wallets on ClawHub is real but each incumbent is single-rail; a multi-rail wallet + identity + marketplace skill has a clear differentiation line, and download counts in the low thousands are beatable with seeded installs.

**(e) Skill aggregators beyond ClawHub**
- SkillsMP (skillsmp.com): GitHub-crawled, "2,000,000+" skills claimed (another source: 351,349), REST + MCP access, no quality gate beyond stars — being a public GitHub repo with a valid `SKILL.md` is sufficient to be indexed (**partially verified**).
- Smithery claims 100k+ tools and skills; Glama and PulseMCP index MCP servers from GitHub and the official registry; Gemini CLI extension gallery is curated.

**(f) GEO for agents: what actually moves tool selection (primary research + vendor guidance)**
- *BiasBusters* (ICLR 2026; Blankenstein, Yu, Li, Plachouras, Sengupta, Torr, Gal, Paren, Bibi; arXiv 2510.00307v2): across seven LLMs, "semantic alignment between user queries and tool metadata is the strongest driver of selection"; "small perturbations to tool descriptions can significantly shift choices"; "repeated pre-training exposure to a single endpoint amplifies provider-level bias"; models also over-select earlier-listed tools. Mitigation proposed (filter-then-sample) is for registries, not providers.
- *Agent-Facing Information Design in LLM Tool Registries* (Haochuan Kevin Wang, MIT, arXiv 2605.23916, Apr 12 2026): 17,700+ two-alternative forced-choice trials over DeepSeek-V3, o4-mini, GPT-5.4-mini/nano, Claude Sonnet 4.6 (+GPT-4o). Commercially framed descriptions captured **83% of agent traffic vs 50% fair share** (selection-bias coefficient +0.332). Feature ablation: superlatives +0.35, outcome framing +0.23, authority endorsement +0.21, social proof +0.12. Effect saturates at the first framing level; **FTC-permissible puffery produces the entire effect — fabricated claims add nothing**; system-prompt warnings had zero effect on 4 of 5 models. Recommendations: registries should normalise selection-facing metadata; providers gain most from professional framing + one superlative + outcome statement, then diminishing returns.
- Vendor guidance that matches: OpenAI plugin metadata guide — name = `domain.action`, description starts "Use this when…" and lists disallowed cases, document every parameter, set `readOnlyHint`/`destructiveHint`/`openWorldHint`, "treat metadata like product copy"; Anthropic tool search — keywords in descriptions, namespaced names, describe tool categories in the system prompt; Agent Skills — only `name` + `description` are loaded at startup.
- Practical GEO recipe for our tool/skill strings: `[verb + object] for AI agents — use this when [3 intent phrases]; supports [rails]; do not use for [X]` plus one outcome statement and one legitimate superlative (e.g. "the only wallet that pays across N rails"); keep claims true — registries are starting to normalise and scan.
- Human-web GEO (secondary, for search-driven agents): content with verifiable statistics and named citations gets 30-40% higher AI visibility (Princeton GEO study via Enrich Labs); Reddit/YouTube/LinkedIn dominate citations (§1.5).

**(g) Agent social networks / word of mouth**
- Moltbook remains the only verified agent-only network at scale; live API on 2026-09-06; promotion ~10% of posts; crypto blocked by default per submolt; human claim step (email + tweet).
- Named alternatives in secondary round-ups (Nebils, Moltweet, AgentDiscuss "Product Hunt for AI agents", Agent Commune, Reiki) could not be reached or verified.
- No evidence found of organic, autonomous agent-to-agent tool recommendation outside Moltbook posts; the machine-readable form of "word of mouth" that demonstrably works is **payloads**: registry syndication, `server.json`/`SKILL.md` in repos, and URLs inside API responses (which Anthropic-API agents can fetch, unlike invented URLs).

**(h) Package registries — new primary evidence**
- Anthropic, Jul 30 2026: a doc-referenced but non-existent package name, once published to PyPI, was "downloaded and run on 15 real systems" within ~1 hour, including a security vendor's automated scanner. Register every package name we mention; expect automated installers to act on names within the hour.
- May 11 2026 supply-chain campaign (secondary, SafeDep/Phoenix): 170+ npm and 2 PyPI packages, 404 malicious versions, including payloads that plant `CLAUDE.md`/`.cursorrules` with hidden instructions — evidence that attackers target the agent-instruction layer; our shipped `AGENTS.md`/`SKILL.md` must be signed/pinned.
- No public data on the share of npm/PyPI installs initiated by agents.

**(i) Walled-garden policy updates**
- OpenAI plugin directory: verified identity, 5 positive / 3 negative test cases, domain verification, MCP-only allowed, **money/crypto transfers prohibited**, digital goods prohibited, external checkout only. Commerce specs exist only for physical products, restaurant reservations and local-services quotes.
- Anthropic: Connectors need Team/Enterprise; **plugins can be submitted through the Console by individuals**, automated review, public GitHub repo, CI auto-mirrors updates and re-screens; "Anthropic Verified" badge is discretionary. Seven compliance acknowledgments include "financial transactions".
- MCP spec 2026-07-28 (primary): stateless request/response core, header-based routing, cacheable list results with TTL hints, formal extensions framework (Tasks, Enterprise Managed Authorization, MCP Apps), RFC 9207 issuer validation, Client ID Metadata Documents replacing Dynamic Client Registration. No discovery/registry/payment content — but cacheable `tools/list` and stateless HTTP make our remote server cheaper for gateways to expose.

**(j) ARD status**
- Spec site lists Cisco, Databricks, GitHub, GoDaddy, Google, Hugging Face, Microsoft, Nvidia, Salesforce, ServiceNow, Snowflake; canonical file `/.well-known/ard.json`; "there will be many discovery services" but none named; HF `hf-discover` is the only live client. One practitioner's ARD deployment (Jun 2026) passed conformance and was found by `hf-discover navigate`, but Cloudflare bot rules initially 403'd the validator and no crawler traffic was shown. Serve both `ard.json` and `ai-catalog.json`, allow validators through the WAF, and treat ARD as future-proofing.

### R2.4 Playbook deltas (summary of changes to §12)
- #3: Anthropic plugin submission via Console (individuals OK), public repo, auto-mirrored updates; SkillsMP crawl is free.
- #4: add `/x402/validate`, ≤500-char description, verify listing via public discovery API, keep endpoints active (30-day delisting).
- #5: register every package name mentioned in docs (Anthropic incident).
- #9: explicitly allow OAI-SearchBot (Codex cached index), ExaSearchBot, Claude-Code; submit to Brave.
- #10: server-card paths corrected; serve `ard.json` + `ai-catalog.json`; let validators through the WAF.
- #13: read the "financial transactions" policy before submitting a payments connector.
- #14: ChatGPT/Codex plugin limited to non-transactional tools (money/crypto transfers prohibited).
- #16: Moltbook submolts must allow crypto or content must be framed around non-crypto rails.
- #17: payload URLs are fetchable by API agents; invented URLs are not — referral links belong in responses.
- #20: instrument the specific UAs and poll the three public registry APIs.

### R2.5 Still unverified after round 2
- Brave as Anthropic's web_search provider (circumstantial only).
- Which crawler feeds Codex's `cached` index (assumed OAI-SearchBot).
- Whether form-submitted Anthropic plugins appear in the auto-added `claude-plugins-official` marketplace or only in `claude-community`.
- ClawHub total catalog size; whether ClawHub search is vector or keyword by default (API exposes `mode=exact`, implying a non-exact default).
- SkillsMP size (351k vs 2M+) and API/MCP endpoint details.
- Moltbook alternatives (Nebils, Moltweet, AgentDiscuss, Agent Commune) — none reachable/verified.
- Wikidata's effect on agent discovery — vendor claims only.
- Composio public-catalog admission for third parties.
- x402 Bazaar indexing reliability (issue #2112 open, no maintainer reply).
- Third-party claim that Claude Desktop/Cursor implement MCP server cards.
- Cloudflare + AgentCore agent-registry format.
- MCP registry request traffic (no registry publishes it).

### R2.6 URLs used in round 2

Primary (fetched):
- https://ahrefs.com/blog/llmstxt-study/
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/aa59517442d323a33ed915fc408f1584c4a23dfa/seps/2127-mcp-server-cards.md
- https://turva.dev/guides/mcp-server-card
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://github.com/modelcontextprotocol/registry
- https://modelcontextprotocol.io/registry/about
- https://registry.modelcontextprotocol.io/v0/servers?search=wallet&limit=5 (live probe)
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/discover-plugins
- https://claude.com/docs/plugins/submit
- https://claude.com/docs/connectors/building/submission
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-webfetch.md
- https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-websearch.md
- https://docs.openclaw.ai/clawhub/api
- https://docs.openclaw.ai/tools/web
- https://clawhub.ai/api/v1/search?q=wallet%20payments%20agent (live probe)
- https://agentskills.io/
- https://skillsmp.com/
- https://www.moltbook.com/skill.md
- https://docs.cdp.coinbase.com/x402/bazaar
- https://docs.cdp.coinbase.com/x402/seller/get-discovered
- https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=5 (live probe)
- https://github.com/x402-foundation/x402/issues/2112
- https://developers.openai.com/plugins
- https://developers.openai.com/plugins/guides/optimize-metadata.md
- https://developers.openai.com/plugins/deploy/submission.md
- https://developers.openai.com/apps-sdk/app-submission-guidelines
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://codex.danielvaughan.com/2026/05/09/codex-cli-web-search-configuration-cached-live-domain-allow-lists-prompt-injection-defence/
- https://geminicli.com/docs/tools/web-search/
- https://brave.com/blog/openclaw/
- https://crawler.exa.ai/
- https://convertos.ai/geo/claude-brave-search-submit-url
- https://arxiv.org/html/2605.23916
- https://arxiv.org/abs/2510.00307v2
- https://github.com/crewAIInc/crewAI/issues/4249
- https://suganthan.com/blog/agentic-resource-discovery/
- https://agenticresourcediscovery.org/
- https://agenticresourcediscovery.org/interoperability/
- https://www.anthropic.com/news/investigating-incidents-cybersecurity-evals
- https://www.stepsecurity.io/blog/anthropic-incident-ai-agent-malicious-package-pypi
- https://nordicapis.com/10-interesting-mcp-statistics/
- Failed/blocked: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md (404), https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex (403), https://glama.ai/api/mcp/v1/servers?query=wallet (401), https://trust.anthropic.com/subprocessors (JS app, not parseable), https://developers.openai.com/plugins/optimize-metadata (404; .md path works), https://agentdiscuss.ai/ (DNS), https://skillsmp.com/api-docs and /en/api (404), https://www.pulsemcp.com/stats (404)

Secondary (search results, not fetched or vendor pages):
- https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/
- https://www.wislr.com/articles/ai-bot-behavior-log-analysis/
- https://saaslinks.net/blog/llms-txt-server-log-study
- https://github.com/bug-ops/zeph/issues/3701
- https://dev.to/turva-dev/mcp-server-cards-explained-5hgb
- https://agent-ready.dev/how-to-publish-an-mcp-server-card
- https://www.digitalapplied.com/blog/mcp-ecosystem-h1-2026-retrospective-adoption-data-points
- https://tooldirectory.ai/blog/state-of-mcp-servers-2026
- https://www.truefoundry.com/blog/claude-mcp-registry
- https://claudemarketplaces.com/mcp/com.remote-mcp/registry-mcp
- https://claudemarketplaces.com/mcp/spacemandomains/mcp-registry-search
- https://www.firecrawl.dev/blog/best-openclaw-search-providers
- https://brave.com/search/api/guides/use-with-openclaw/
- https://docs.openclaw.ai/tools/brave-search
- https://newclawtimes.com/articles/brave-search-api-700000-openclaw-users-machine-first-search/
- https://mostailabs.com/field-guide/claude-and-brave-search
- https://naloseed.com/blog/connect-brave-search-claude-ai
- https://learn.chatgpt.com/docs/plugins
- https://www.usecarly.com/blog/chatgpt-plugins/
- https://github.com/tavily-ai/langchain-tavily
- https://docs.tavily.com/documentation/integrations/langchain
- https://github.com/crewAIInc/crewAI-tools
- https://docs.crewai.com/en/concepts/tools
- https://github.com/ComposioHQ/composio
- https://deepwiki.com/ComposioHQ/composio/2.3-sessions-and-tool-router
- https://github.com/yksanjo/mcp-discovery
- https://news.ycombinator.com/item?id=46661173
- https://www.speakeasy.com/blog/100x-token-reduction-dynamic-toolsets/
- https://agentic-community.github.io/mcp-gateway-registry/dynamic-tool-discovery/
- https://anycap.ai/page/en-US/ai/codex-web-search-guide-2026
- https://www.firecrawl.dev/glossary/web-search-apis/codex-web-search
- https://inventivehq.com/knowledge-base/gemini/how-to-use-google-search-grounding
- https://www.buildmvpfast.com/blog/agent-skills-npm-ai-package-manager-2026
- https://www.techtimes.com/articles/319457/20260701/ai-coding-agents-skip-package-verification-attackers-are-exploiting-it.htm
- https://phoenix.security/accelerating-supply-chain-attacks-npm-pypi-vsx-ai-enabled-2026/
- https://safedep.io/mass-npm-supply-chain-attack-tanstack-mistral/
- https://xygeni.io/blog/npm-package-security-for-the-age-of-ai-agents/
- https://arxiv.org/html/2606.03907
- https://proceedings.iclr.cc/paper_files/paper/2026/file/a79875cc0d046ce7ce65f03f3affaa9e-Paper-Conference.pdf
- https://arxiv.org/html/2606.20023
- https://arxiv.org/abs/2606.16364
- https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026
- https://www.tryprofound.com/blog/best-generative-engine-optimization-tools
- https://aisearch.similarweb.com/blog/what-is-geo/
- https://www.frase.io/blog/entity-optimization-for-geo
- https://vegavid.com/blog/wikidata-entity-linking-ai-overviews
- https://www.digitalapplied.com/blog/entity-seo-knowledge-graph-optimization-guide-2026
- https://www.stackmatix.com/blog/wikipedia-wikidata-knowledge-graph
- https://aimultiple.com/moltbook
- https://distk.in/blog/how-to-use-moltbook-ai-social-network-2026.html
- https://wonderingaboutai.substack.com/p/moltbook-lurker-bot
- https://edition.cnn.com/2026/03/10/tech/meta-moltbook-bots-social-media
- https://openclawlaunch.com/blog/best-moltbook-alternative-2026
- https://www.producthunt.com/products/moltbook/alternatives
- https://clawhub.biz/
- https://clawskills.sh/
- https://clawoneclick.com/blog/clawhub-top-skills-2026
- https://dev.to/wonderlab/openclaw-in-action-how-to-search-and-install-skills-to-make-your-agent-actually-work-51oh
- https://team400.ai/blog/2026-04-openclaw-skills-cli-managing-agent-capabilities
- https://www.digitalocean.com/resources/articles/what-are-openclaw-skills
- https://cli.nylas.com/guides/ai-catalog-json-agent-discovery
- https://github.com/Suganthan-Mohanadasan/ard-registry/
- https://commandline.microsoft.com/agentic-resource-discovery-specification-ard/
- https://www.infoq.com/news/2026/07/agentic-resource-discovery-spec/
- https://www.synscribe.com/blog/what-is-ai-catalog-json
- https://www.agentpatterns.ai/standards/agentic-resource-discovery/
- https://medium.com/@liranyoffe/reverse-engineering-claude-code-web-tools-1409249316c3
- https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343
- https://mikhail.io/2025/10/claude-code-web-tools/
- https://giuseppegurgone.com/claude-webfetch
- https://dacharycarey.com/2026/02/19/agent-web-fetch-spelunking/
- https://designrevision.com/blog/best-mcp-marketplaces-and-registries
- https://mcpize.com/alternatives
- https://www.agensi.io/learn/smithery-vs-glama-vs-agensi-comparison
- https://www.practical-devsecops.com/mcp-security-statistics-2026-report/
- https://konghq.com/blog/learning-center/what-is-an-mcp-registry
- https://medium.com/@heimlabs/ship-a-402-powered-api-bazaar-with-x402-from-discovery-to-paid-response-in-one-script-cf08f3853b05
- https://medium.com/@sagarshah16/whos-actually-running-x402-right-now-c96a055cf53c

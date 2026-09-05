# How autonomous AI agents discover tools, services and APIs (as of 2026-09-05)

Slug: `agent-discovery-marketing`
Author: strategy research subagent, 2026-09-05
Scope: our "small world for AI agents" platform (identity, wallets/payment rails, agent-to-agent marketplace, messaging, reputation). Audience for discovery = LLM agents (Claude Code, OpenClaw/Clawdbot-style, Codex, Gemini CLI, LangGraph/CrewAI, custom scripts), zero humans in the loop.

Method: 40 web searches + ~35 primary-source fetches (official docs, GitHub READMEs, specs, arXiv, launch posts). Search budget was exhausted before Wikidata/agent.ai/Exa-indexing/Cloudflare-agent-registry could be verified; those are marked **unverified**. Everything else is tagged with the source it came from. Dates are given where the source states them.

---

## 0. Executive summary (the "so what")

1. There is no "Google for agents" yet. Discovery is fragmented into roughly five hubs, in descending order of agent reach: (a) the **official MCP registry** and its syndication (GitHub MCP registry, PulseMCP, Glama, Smithery, mcp.so), (b) **skills registries** (Agent Skills / SKILL.md standard, ClawHub for OpenClaw, Claude Code plugin marketplaces, ChatGPT/Codex plugin directory, Gemini CLI extensions), (c) **web search APIs consumed by agents** (Brave, Exa, Tavily, Perplexity Sonar, Anthropic's server-side web_search), (d) **package registries** (npm/PyPI; agents guess names), (e) **payment-native catalogs** (x402 Bazaar, where being paid once = being listed).
2. `llms.txt` is a *conversion* asset, not an *acquisition* asset. No frontier crawler requests it (a 7-month log study across ~900 domains recorded 0 requests from GPTBot/ClaudeBot/PerplexityBot/Google-Extended), but coding agents (Claude Code, Cursor, Copilot, Windsurf, Cline, Aider) do follow it once they land on your docs, and Anthropic/Mintlify put a "fetch llms.txt first" blockquote at the top of every docs page.
3. The single most effective agent-acquisition artifact observed in 2025-26 is Moltbook's `skill.md`: one URL an agent fetches, which contains registration → API key → claim → heartbeat instructions. ~1.5M agent registrations in days with effectively no UI (though 17k humans controlled them). Copy the pattern: `https://<our-domain>/skill.md`.
4. Descriptions are the ad copy. Agent Skills load only `name` + `description` at startup (progressive disclosure); MCP tool descriptions "steer agents toward effective tool-calling behaviors" (Anthropic); x402 Bazaar ranks by description/intent; ClawHub uses vector search over skill text. Write these strings like landing-page copy containing the intent phrases an agent would search for.
5. Agent fetch pipelines discard metadata. Anthropic's web_search returns title + URL + encrypted content; the alleged Claude Code fetch pipeline (unverified, April 1 2026 leak) converts HTML→Markdown, truncates at 100k chars, paraphrases with Haiku and drops JSON-LD/meta/alt-text. Body text in the first few thousand characters is what agents see. schema.org is for Google AI Overviews/search engines, not for coding agents.
6. Walled-garden directories are partly hostile to an agent economy: ChatGPT's plugin directory rejects "subscription sales or digital product monetization (physical goods only)"; Anthropic's Connectors Directory requires a Team/Enterprise org and human review (2 weeks-months). Open registries (MCP registry, ClawHub, x402 Bazaar, npm/PyPI, GitHub) accept automated publication with no human review.
7. Security scanning is now the gate everywhere (ClawHub VirusTotal scans after ClawHavoc's 341 malicious skills; Snyk found 36% of 3,984 skills flawed; Anthropic's community marketplace runs automated validation). Minimal-permission, clean skills stay listed; flagged ones vanish from catalogs.

---

## 1. Web search behaviour of agents

### 1.1 Anthropic web_search (Claude API, Claude Code, Managed Agents) — VERIFIED
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Tool versions: `web_search_20250305` (basic), `web_search_20260209` (dynamic filtering: Claude writes code to filter results before they enter context), `web_search_20260318` (response_inclusion control).
- Claude decides when to search: "recent events... current prices... information about specific organizations, people, or products that might have changed... explicit requests to search".
- Results carry `url`, `title`, `page_age` ("when the site was last updated"), `encrypted_content`. Citations expose up to 150 chars of `cited_text`.
- `allowed_domains` / `blocked_domains` let operators pin the agent to specific domains — enterprises often whitelist docs domains; being on such a list requires being a known domain.
- Price: $10 per 1,000 searches. Simple queries use 1-3 searches, research 10+.
- Index provider is **not named** in the docs. Widely reported as Brave (Brave says it is "trusted by most of the world's top 10 LLMs" and that "many other search API providers actually rely on the Brave Search API in the background" — vendor claim, https://brave.com/learn/best-search-api-2026/, May 27 2026). **Unverified** that Claude uses Brave.

### 1.2 Alleged Claude Code WebSearch/WebFetch internals — UNVERIFIED (April 1, 2026 "leak")
Source: https://wire.wise-relations.com/news/2026-04-01-claude-code-websearch-leak/ (author admits it may be an April Fools joke)
- Claimed pipeline: server-side search returns titles+URLs only; fetch → Turndown HTML-to-Markdown → truncate at 100,000 chars → Haiku paraphrase (125-char quote limit) → 50,000-char tool budget → possible 2KB preview. JSON-LD, meta descriptions, alt-text disappear.
- ~107 documentation domains (React, Python, Kubernetes...) bypass filtering.
- Only enforced query rule: include current month+year.
- Recommendations that are sensible regardless of the leak's authenticity: body text over metadata; front-load keywords; self-contained sentences; support `Accept: text/markdown`; put the year in content.

### 1.3 What queries agents run — PARTIALLY VERIFIED
- The model writes its own literal queries; Anthropic docs show queries like `"claude shannon birth date"`, `"latest quantum computing breakthroughs 2025"`. Secondary sources (https://fixaeo.com/blogs/can-claude-search-the-web/) report "exact lexical matching" and time-aware queries ("best CRM tools May 2026").
- Implication: title + H1 + first paragraph should contain the literal intent phrases an agent would type: "AI agent wallet API", "agent-to-agent marketplace API", "register an AI agent identity", "pay another agent USDC x402", plus "2026".

### 1.4 Search APIs agents use — VERIFIED (vendor docs) / secondary comparisons
- **Brave Search API**: 40B+ page independent index; "700,000 OpenClaw users selected the Brave Search API" (https://brave.com/learn/best-search-api-2026/). Standard SEO/crawlability applies (sitemaps, crawlable HTML).
- **Exa**: neural/embedding search over own crawl; free tier 20k req/month; ~$7/1k (https://www.tavily.com/blog/7-best-exa-alternatives-for-ai-agents-in-2026, https://coldiq.com/blog/tavily-vs-exa). Exa "how search works" docs returned 404/redirect during this research — how new domains enter the index is **unverified**.
- **Tavily**: "aggregates up to 20 sites per a single API call, and uses proprietary AI to score, filter and rank" — i.e., it sits on top of other engines; no own index to submit to (https://docs.tavily.com/documentation/about). ~$7.50-8/1k.
- **Perplexity Sonar / Agent API**: GA Feb 2026; returns cited answers (https://docs.perplexity.ai/changelog/changelog, https://www.perplexity.ai/hub/blog/introducing-the-sonar-pro-api).
- Practical takeaway: being findable by agents via search = being findable by Brave + Bing/Google (Tavily aggregates them) + Exa's crawler. Classic SEO fundamentals still gate agent search.

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

### Do agents read it? — VERIFIED (mixed)
- Request-log study, ~900 domains, Sep 4 2025-Apr 13 2026: 1,227 total requests to /llms.txt; 64.7% from a commercial data aggregator, 31.9% humans in Chrome, **0 from GPTBot/ClaudeBot/PerplexityBot/Google-Extended**. "Not a single real AI bot."
- Citation-impact study on 300k domains: no measurable link between llms.txt and AI-citation frequency (same source; also https://www.digitalapplied.com/blog/google-llms-txt-no-seo-value-lighthouse-audit-2026).
- Google's John Mueller (June 2025): "no AI system currently uses llms.txt" (via https://www.getpassionfruit.com/blog/should-i-create-an-llms.txt-file-google-s-2026-guidance-explained).
- Counter-evidence for coding agents: Anthropic's own docs serve https://code.claude.com/docs/llms.txt (~200 links, all to `.md` mirrors) and every docs page starts with the blockquote "Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt — Use this file to discover all available pages before exploring further" (verified by fetching https://code.claude.com/docs/en/discover-plugins and https://agentskills.io/). Anthropic engineering (Sep 11 2025): "LLM-friendly documentation can commonly be found in flat llms.txt files on official documentation sites" (https://www.anthropic.com/engineering/writing-tools-for-agents). Zylos (Jul 9 2026) lists Cursor, Windsurf, Claude Code, GitHub Copilot, Cline, Aider as llms.txt readers (https://zylos.ai/research/2026-07-09-agentic-web-access-standards-llms-txt-crawler-authentication/).
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
| `/.well-known/mcp/server-cards.json` | MCP SEP-2127 | Open PR, "In Review" as of Aug 2026 | Nobody standard yet; Claude Code does NOT do well-known MCP lookup | https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127 ; https://code.claude.com/docs/en/mcp |
| `/.well-known/mcp.json`, `/.well-known/mcp` | SEP-1649 / issue #1960 / community | Competing drafts | Some tooling | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649 ; https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960 ; https://www.ekamoira.com/blog/mcp-server-discovery-implement-well-known-mcp-json-2026-guide |
| `mcp://` URI scheme + discovery | IETF draft-serra-mcp-discovery-uri-04 | Individual draft | — | https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/ |
| `/.well-known/ai-catalog.json` (AI Catalog, LF) and `/.well-known/ard.json` (ARD) | Agentic Resource Discovery — Microsoft, Google, GoDaddy, Hugging Face contributors; HF launch Jun 17 2026 | Draft; naming inconsistent between pages | HF `hf discover search`, `POST /search` on huggingface-hf-discover.hf.space; ARD says any discovery service can crawl it. As of June 2026 no named contributor served one (secondary) | https://huggingface.co/blog/agentic-resource-discovery-launch ; https://agenticresourcediscovery.org/interoperability/ ; https://github.com/Agent-Card/ai-catalog ; https://turva.dev/guides/agentic-resource-discovery |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | OAuth / MCP auth | Live | Claude Code, ChatGPT, UCP merchants (scopes like `dev.ucp.shopping.checkout`) | https://code.claude.com/docs/en/mcp ; https://ucp.dev/ |
| `/.well-known/http-message-signatures-directory` (JWKS) | Web Bot Auth (IETF WG; Cloudflare) | Live at Cloudflare edge | Cloudflare verified-bots; OpenAI Operator, Google-Agent sign | https://developers.cloudflare.com/bots/concepts/bot/verified-bots/web-bot-auth/ ; https://zylos.ai/research/2026-07-09-agentic-web-access-standards-llms-txt-crawler-authentication/ |
| `/.well-known/ai-plugin.json` | Legacy ChatGPT plugins | Superseded by Apps SDK/MCP → plugin directory | Effectively nobody | https://openai.com/index/introducing-apps-in-chatgpt/ |
| `/openapi.json`, `/.well-known/openapi.json` | de-facto | Widely used | Any agent that codegens clients | https://dev.to/alfredz0x/how-to-make-your-api-ai-discoverable-with-llmstxt-and-openapi-2026-guide-469l |
| DNS TXT `_agent.<domain>` "v=aid2;u=...;p=mcp;a=oauth2_code" | AID v2.1.0 (Jun 1 2026, agentcommunity) | Spec published; adopters unknown | Unknown | https://aid.agentcommunity.org/docs/specification ; https://datatracker.ietf.org/doc/draft-nemethi-aid-agent-identity-discovery/ |
| DNS TXT `_mcp.<domain>` | community | Experimental | Unknown | https://github.com/mariothomas/mcp-dns-registry |
| DNS-AID | IETF draft-mozleywilliams-dnsop-dnsaid-02 | Draft | — | https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/ ; https://arxiv.org/html/2606.02314v1 |
| NANDA index (AgentAddr, Ed25519) | MIT NANDA | Research | — | https://arxiv.org/pdf/2507.14263 |
| Web of Agents (WoA) manifest | IETF draft-gaikwad-woa-00 (Dec 2025) | Draft | — | https://www.ietf.org/ietf-ftp/internet-drafts/draft-gaikwad-woa-00.html |
| WebMCP `navigator.modelContext` | W3C CG; Chrome 146 (Feb 2026), origin trial Chrome 149 (May 2026) | Draft report Apr 23 2026 | Chrome-based browser agents | https://dev.to/ai-agent-economy/webmcp-in-2026-which-browsers-support-navigatormodelcontext-complete-compatibility-status-1oe4 ; https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026 |

Assessment: static well-known files cost an hour and are cheap insurance, but today none of them is an *acquisition* channel — an agent must already know your domain. The exception is ARD/AI Catalog, which is designed for federated crawlers (HF Discover is live).

---

## 4. MCP registries — VERIFIED

### Official registry (registry.modelcontextprotocol.io)
Sources: https://github.com/modelcontextprotocol/registry ; https://registry.modelcontextprotocol.io/docs ; https://nordicapis.com/getting-started-with-the-official-mcp-registry-api/ ; https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/ (Jun 8 2026); https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
- Preview since Sep 8 2025; API frozen at v0.1 on Oct 24 2025; "breaking changes or data resets may occur" before GA.
- ~9,652 latest server records / 28,959 server-version records on May 24 2026; Anthropic cited 10,000+ active public MCP servers (Dec 2025).
- Publish with `mcp-publisher` + `server.json` (name, title, description, repository, version, websiteUrl, remotes[transport,url], packages). Namespace ownership proven by GitHub OAuth/OIDC (`io.github.<user>/*`) or by **DNS/HTTP challenge for a domain (`com.<yourdomain>/*`)**. No human review queue.
- Downstream consumers: GitHub's MCP registry (https://github.com/mcp shows a curated ~250 servers with Install buttons), PulseMCP ("publish to the Official MCP Registry ... which the directory will automatically index"; direct submissions paused — https://www.pulsemcp.com/submit), Glama (82,361 servers on Sep 5 2026, auto-crawl + "Claimed" tier + public `GET /v1/servers` API — https://glama.ai/mcp/servers), Smithery (`smithery mcp publish <url> -n org/server`; claims 100k+ tools and skills — https://smithery.ai/docs), mcp.so (~20,222; secondary), mcptoplist. ~115,937 servers tracked across registries in early Sep 2026 (secondary: https://www.truefoundry.com/blog/best-mcp-registries , https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server).
- Claude Code: `claude mcp add --transport http <name> <url>`; OAuth via dynamic client registration and `.well-known/oauth-*`; **no automatic registry or well-known lookup** (https://code.claude.com/docs/en/mcp). An Anthropic-published `mcp-registry` plugin (`/plugin install mcp-registry@claude-plugins-official`, commands `mcp search / list / suggest`) reportedly lets Claude search the public registry from inside a session (https://www.claudedirectory.org/plugins/mcp-registry — third-party page; the official marketplace.json fetch was truncated before the entry, so **partially verified**).
- Anthropic Connectors Directory (claude.ai/directory): submission via org admin settings, requires Team/Enterprise org, tool annotations (readOnly/destructive), public privacy policy, public docs, 3+ example prompts; review 2 weeks to months (https://claude.com/docs/connectors/building/submission ; https://tallyfy.com/how-to-list-mcp-server-anthropic-claude-connectors/ ; https://sunpeak.ai/blogs/claude-connector-directory-submission/ ; https://dev.to/qrflows/how-to-submit-your-mcp-server-to-anthropics-connector-directory-from-someone-who-did-it-143m).
- Cursor: cursor.directory lists ~40+ MCP servers and rules, 67k community members (secondary; direct fetch returned 429) — https://www.everydev.ai/tools/cursor-directory ; https://mcpize.com/alternatives/cursor-directory.

### ChatGPT / Codex — VERIFIED
- Apps in ChatGPT (Oct 2025) → submissions opened Dec 17 2025 → **App directory migrated to a "Plugin directory" on Jul 9 2026**; a plugin bundles apps + skills + app templates for ChatGPT and Codex (https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/ ; https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches ; help-center article 403'd).
- Submission requires an MCP server with `readOnlyHint`/`destructiveHint`/`openWorldHint` annotations, privacy policy, support contact. **Rejected: "subscription sales or digital product monetization (physical goods only)", trial accounts needing signup/2FA, scraped content** (https://developers.openai.com/apps-sdk/app-submission-guidelines).
- Agentic Commerce Protocol: merchants become discoverable via a structured **product feed** (API or SFTP), not a well-known file (https://developers.openai.com/commerce).

### Gemini CLI — VERIFIED
- Extensions = GitHub repo bundling MCP servers, commands, skills, hooks; install with `gemini extensions install <github url>`; gallery at https://geminicli.com/extensions/ (70+ at launch; partners Shopify, Stripe, Figma, Postman...) (https://geminicli.com/docs/extensions/ ; https://blog.google/innovation-and-ai/technology/developers-tools/gemini-cli-extensions/ ; https://github.com/gemini-cli-extensions).

---

## 5. Skills: the SKILL.md economy — VERIFIED

- **Agent Skills standard** (agentskills.io; Anthropic released as open standard Dec 18 2025): a folder with `SKILL.md` (YAML frontmatter `name`, `description` + Markdown body; optional scripts/, references/, assets/). Progressive disclosure: "At startup, agents load only the name and description of each available skill". The showcase lists ~46 clients incl. Claude Code, Claude, ChatGPT & Codex, Cursor, GitHub Copilot, VS Code, Gemini CLI, OpenCode, OpenHands, Goose, Roo Code, Kiro, OpenClaw, Hermes Agent, Letta, Factory, Amp, Junie (https://agentskills.io/). Enterprise skills shipped by Atlassian, Canva, Cloudflare, Figma, Notion, Ramp, Sentry, Stripe, Zapier (secondary: https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/ ; https://agentman.ai/blog/agent-skills-ecosystem-report-2026).
- **ClawHub (OpenClaw)**: `clawhub skill publish <path> --slug --name --version`; `openclaw skills search "calendar"` / `openclaw skills install @owner/slug`; `clawhub search` uses vector search (OpenAI embeddings); open by default with a GitHub-account-age gate; automated security scans, VirusTotal partnership Feb 7 2026 after "ClawHavoc" (341 malicious typosquats; 2,419 suspicious skills removed, catalog dropped 5,705→3,286). SKILL.md `metadata.openclaw` supports `requires.bins/env/config`, `install` specs (brew/node/go/uv/download), `primaryEnv` for API keys. Docs describe operator-driven install; the agent has shell access so it *can* run `clawhub search`, but docs don't describe autonomous install (https://docs.openclaw.ai/clawhub ; https://docs.openclaw.ai/tools/skills ; https://github.com/openclaw/clawhub ; https://www.datacamp.com/blog/best-clawhub-skills ; https://theguidex.com/resources/best-openclaw-skills). Counts in marketing pages ("60K+ skills", "10,000+") are inconsistent — treat as **unverified**. OpenClaw itself: ~190k GitHub stars (secondary: https://www.growexx.com/blog/top-10-popular-openclaw-skills/). Top skill "Capability Evolver / self-improving agent" ~35k installs (secondary: https://clawhub.ai/pskoett/skills/self-improving-agent).
- **Claude Code plugins/marketplaces**: any GitHub repo with `.claude-plugin/marketplace.json` is a marketplace (`/plugin marketplace add owner/repo`); official marketplace curated "at Anthropic's discretion"; community marketplace `anthropics/claude-plugins-community` accepts submissions after automated validation, pinned to commit SHA; plugin details show "context cost" and "will install" (MCP servers, skills, hooks). Marketplaces can auto-update (https://code.claude.com/docs/en/discover-plugins ; https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json ; https://github.com/anthropics/claude-code/blob/main/.claude-plugin/marketplace.json).
- Snyk ToxicSkills (Feb 2026): 36% of 3,984 skills had at least one security flaw (secondary).
- **AGENTS.md**: 60k+ repos, read by 30+ tools; effectiveness evidence mixed (https://arxiv.org/html/2601.20404v2 ; https://kerneltalks.com/ai/agents-md-just-turned-one-the-evidence-on-whether-it-works-is-mixed/).

---

## 6. Agent social networks / word of mouth — VERIFIED

**Moltbook** (https://en.wikipedia.org/wiki/Moltbook ; https://arxiv.org/html/2602.10127v1 ; https://www.moltbook.com/skill.md ; https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network ; https://www.cnbc.com/2026/02/02/social-media-for-ai-agents-moltbook.html ; https://www.forbes.com/sites/guneyyildiz/2026/01/31/inside-moltbook-the-social-network-where-14-million-ai-agents-talk-and-humans-just-watch/ ; https://www.datacamp.com/tutorial/moltbook-how-to-get-started)
- Launched Jan 28 2026 (Matt Schlicht). Onboarding is one Markdown file: `skill.md` → "Every agent needs to register and get claimed by their human" → API key + claim URL → "Add this to your HEARTBEAT.md" (check in every ~30 min) → `POST /api/v1/posts`, `GET /api/v1/feed`, `GET /api/v1/home`. Most agents run OpenClaw.
- 44,411 posts / 12,209 submolts by Feb 1 2026; "Promotion" = 9.96% of posts (launch announcements, recruiting, crypto tokens); heavy spam (one agent posted 4,535 times at <10s intervals); credential-extraction attacks disguised as system alerts.
- Feb 2026 breach: 17,000 humans controlled 1.5M agents. Jun 6 2026: 206,839 human-verified agents, 2,895,874 registered. Acquired by Meta Mar 10 2026 (into Meta Superintelligence Labs); still operating per Sep 1 2026 Wikipedia edit.
- Assessment for us: moderate, noisy reach; posts are read by agents on heartbeat and are prompt-injection vectors. Worth a low-effort presence (an agent that answers "how do I pay another agent" questions with our skill.md link) but not a primary channel. Policy under Meta for promotional posts is **unknown**.

---

## 7. Package registries, GitHub, Hugging Face

- **Slopsquatting** (CSA note Apr 19 2026; https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/ ; https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks ; https://appscale.blog/en/blog/ai-coding-agents-dependency-supply-chain-slopsquatting-defence-2026): LLMs hallucinate package names (5.2% commercial models, 21.7% open models); autonomous agents install without review; real incidents (`react-codeshift` in 237 repos). Flip side for marketing: agents *guess* SDK names — own `<brand>`, `<brand>-sdk`, `@<brand>/sdk`, `<brand>-agent`, `<brand>_agent` on npm and PyPI plus typo variants; agents will find the package by guessing before they find your site.
- **Context7** (Upstash): 104k+ libraries indexed; coding agents fetch version-specific docs via MCP mid-task; free plan covers public repos (https://lobehub.com/mcp/upstash-context7 ; https://www.altexsoft.com/blog/context7/ ; https://codex.danielvaughan.com/2026/04/30/codex-cli-documentation-mcp-servers-context7-live-library-lookups/). Getting our SDK docs into Context7 = agents get correct call signatures without visiting our site.
- **Awesome lists / stars**: Context7 61k stars, Chrome DevTools MCP 49k, Playwright MCP 36k, GitHub MCP 32k (secondary). Lists: https://github.com/appcypher/awesome-mcp-servers ; https://github.com/wong2/awesome-mcp-servers ; https://github.com/abordage/awesome-mcp (auto-updated daily) ; https://github.com/korchasa/awesome-mcp. Glama auto-crawls GitHub, so a public repo with a clear README + `server.json` is picked up without submission.
- **Hugging Face**: 2.4M models, ~1M Spaces (many MCP-compatible Gradio apps); official HF MCP server exposes model/dataset/Space search; `hf discover search "<intent>"` via ARD (https://huggingface.co/docs/hub/en/agents ; https://huggingface.co/blog/agentic-resource-discovery-launch). A Space that demos "register an agent + pay another agent" is discoverable by HF-native agents.

---

## 8. Payment-native discovery: x402 Bazaar — VERIFIED
Sources: https://docs.cdp.coinbase.com/x402/bazaar ; https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar ; https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer ; https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-connect-bazaar.html ; https://www.coinbase.com/developer-platform/discover/launches/google_x402 ; https://algorand.co/blog/is-your-x402-endpoint-showing-up-in-the-facilitator-leaderboard-how-to-troubleshoot-if-not
- "A catalog of payment-gated services discovered by the CDP Facilitator." Public, no API key. Search by intent (`searchX402Resources`, relevance/semantic), list (`listX402DiscoveryResources`), by merchant address; REST + TypeScript SDK + **Bazaar MCP** so MCP agents search and pay in one workflow.
- Listing: enable the bazaar extension with `discoverable: true` and settle **one** payment through the CDP facilitator — "There's no registration call: the facilitator's catalog builds itself from payments it has already settled." Indexed metadata: description, output schema, 30-day call count, unique payer count, last-called.
- AWS Bedrock AgentCore Gateway can mount Bazaar MCP to "discover 10,000+ existing paid MCP tools" (AWS docs claim). Google AP2 + x402 integration announced.
- Assessment: the only discovery hub whose audience is *by construction* agents with wallets. Usage metrics double as reputation.

---

## 9. robots.txt / ai.txt / Web Bot Auth / licensing — VERIFIED (Zylos Jul 9 2026; Cloudflare docs)
- robots.txt (RFC 9309) now carries 10-15 AI UA tokens (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Google-Extended, Google-Agent, PerplexityBot, CCBot, Bytespider, Meta-ExternalAgent, Applebot-Extended, cohere-ai). Majority of sites block some AI crawlers; GPTBot most blocked; common split = block trainers, allow search bots. For a platform that *wants* to be found: allow everything, no Cloudflare AI Crawl Control blocking / pay-per-crawl.
- ai.txt: no meaningful adoption found (**unverified** beyond passing mentions). TDMRep: EU publishing niche. RSL (Sep 10 2025): licensing, not discovery.
- Web Bot Auth: Ed25519 HTTP Message Signatures; publish JWKS at `/.well-known/http-message-signatures-directory`; headers `Signature-Input`, `Signature`, `Signature-Agent`; register via Cloudflare Bot Submission Form. Relevant for **our outbound agents** (so they are not blocked when crawling/using others' APIs) and as an identity primitive for agents we host. Cloudflare + Amazon Bedrock AgentCore "open registry format" (Feb 2026) — **unverified** (blog URL 404'd; only secondary: https://stellagent.ai/insights/cloudflare-web-bot-auth-agent-verification).
- Other refs: https://dataimpulse.com/blog/robots-txt-ai-crawlers/ ; https://nohacks.co/blog/ai-user-agents-landscape-2026 ; https://developers.cloudflare.com/changelog/2025-10-21-track-robots-txt/

---

## 10. schema.org, GEO, directories, Wikipedia/Wikidata

- schema.org JSON-LD (Organization, Product/Offer, Service, SoftwareApplication, WebAPI, FAQPage, `sameAs`) helps Google AI Overviews/AI Mode and entity resolution; content parity required. For coding agents it is likely invisible (fetch pipelines strip it). Secondary: https://www.webyes.com/blogs/structured-data-ai-agents/ ; https://agentchecker.ai/blog/schema-org-markup-ai-agents-understand.
- GEO industry: US GEO market ~$365M in 2026 (secondary: https://www.omnibound.ai/blog/generative-engine-optimization-statistics ; https://llmpulse.ai/blog/geo-guide/ ; https://www.evertune.ai/resources/insights-on-ai/top-15-generative-engine-optimization-geo-platforms-for-2026). Framing shift: "not 'be cited in an answer' but 'be selected by an agent'".
- Human-facing agent directories (aiagentsdirectory.com landscape Sep 2026; aiagentslist 600+; agent.ai): SEO value for humans; negligible direct agent reach (https://aiso.blog/ai-agents-directory-list/ ; https://aiagentsdirectory.com/landscape ; https://aiagentslist.com/). agent.ai specifics **unverified** (search budget).
- Wikipedia/Wikidata: **not researched** (budget). Wikipedia is a top-cited ChatGPT domain (Semrush), so a Wikidata item with `official website`, `instance of: software platform`, `sameAs` is a cheap unverified bet; Wikipedia article only when notable.

---

## 11. Agent-readable documentation patterns (synthesis)

1. Top-of-page blockquote: "Fetch the complete documentation index at https://<domain>/llms.txt" (Anthropic, Mintlify, agentskills.io all do this).
2. `.md` mirror for every page + `Accept: text/markdown` negotiation + `Link:`/`X-Llms-Txt:` headers.
3. First 2,000 characters of every page carry the literal how-to: endpoint, method, minimal curl, expected JSON. No hero images/marketing before the first code block.
4. OpenAPI 3.1 at `/openapi.json` with rich `description` and `x-` intent tags; one-line SDK install commands for npm/pip.
5. Tool/skill naming: namespaced (`<brand>_wallet_pay`, `<brand>_agents_register`) and descriptions that state when to use them (Anthropic "Writing tools for agents").
6. Dates in content ("updated September 2026") — agents append the month/year to queries and read `page_age`.
7. Self-service, zero-human signup: API key or wallet-based identity issued programmatically; no email/2FA/CAPTCHA (ChatGPT directory rejects "trial accounts requiring signup, 2FA"; Moltbook only needs an API call + optional claim).

---

## 12. DISCOVERY PLAYBOOK — top 20 actions ranked by expected agent-reach per unit effort

Effort: S (<1 day), M (1-5 days), L (>1 week). Reach = how many autonomous agents can find us through it, weighted by how autonomous the path is.

| # | Action | Effort | Reach | Evidence |
|---|---|---|---|---|
| 1 | Ship a **remote MCP server** (streamable HTTP; OAuth + API key + x402 auth) exposing register/wallet/pay/marketplace/messaging tools with intent-rich descriptions, then **publish to the official MCP registry** via `mcp-publisher` under a DNS-verified `com.<ourdomain>/*` namespace. Syndicates automatically to GitHub MCP registry, PulseMCP, Glama, mcp.so, Smithery indexes. | M | Highest | §4; registry README; Tallyfy; PulseMCP submit page |
| 2 | Publish `https://<domain>/skill.md` (Moltbook pattern): one Markdown file that walks an agent from zero to registered + funded + first transaction, including a `HEARTBEAT.md` snippet and curl examples. Same content as a spec-compliant Agent Skill (`SKILL.md`) with `name`/`description` written as ad copy. | S | Highest | §6 Moltbook skill.md; §5 progressive disclosure |
| 3 | Publish the skill to **ClawHub** (`clawhub skill publish`), to a **Claude Code marketplace** repo (`.claude-plugin/marketplace.json`) + submit to `anthropics/claude-plugins-community`, as a **Codex/ChatGPT plugin**, and as a **Gemini CLI extension** repo. One skill folder, four registries. | M | High | §4-5 |
| 4 | Make every paid endpoint **x402-payable with `discoverable: true`** and settle one test payment through the CDP facilitator so we appear in **x402 Bazaar**; write descriptions/output schemas for intent search; expose Bazaar-friendly quality metrics (calls, unique payers). | S-M | High (all agents with wallets) | §8 |
| 5 | **Official SDKs on npm + PyPI** under the names an LLM would guess (`<brand>`, `<brand>-sdk`, `@<brand>/sdk`, `<brand>-agent`) plus defensive registration of typo/hallucination variants; README = agent quickstart; ship `AGENTS.md` + `SKILL.md` inside the package. | M | High | §7 slopsquatting stats |
| 6 | **llms.txt + llms-full.txt + `.md` mirrors + `Accept: text/markdown`** + `Link`/`X-Llms-Txt` headers + top-of-page "fetch llms.txt first" blockquote on docs and marketing pages. | S | High for conversion, ~0 for acquisition | §2 |
| 7 | **Body-text-first docs**: literal intent phrases and the year in title/H1/first paragraph ("Register an AI agent and pay another agent with USDC — API, September 2026"); first code block within 2,000 chars; no reliance on meta/JSON-LD for agent-critical facts. | S | High (search-driven agents) | §1.2-1.3 |
| 8 | **Get docs into Context7** (public docs repo with clear structure) so coding agents pull correct signatures mid-task. | S | Medium-High | §7 Context7 |
| 9 | **robots.txt allow-all for AI UAs**, sitemap.xml, no Cloudflare AI-crawl blocking/pay-per-crawl, fast HTML (no JS-only rendering) so Brave/Exa/Bing crawl us; register in Bing Webmaster/IndexNow. | S | High (gates every search-API path) | §1.4, §9 |
| 10 | **Well-known suite** in one deploy: `/.well-known/agent-card.json` (A2A), `/.well-known/mcp/server-cards.json` + `/.well-known/mcp.json`, `/.well-known/ai-catalog.json` + `/.well-known/ard.json`, `/openapi.json`, `/.well-known/oauth-protected-resource`, DNS TXT `_agent.<domain>` (AID) and `_mcp.<domain>`. | S | Low today, rising; near-zero cost | §3 |
| 11 | **GitHub presence built for crawlers**: public org, MCP server + SDK repos with topics (`mcp-server`, `ai-agents`, `x402`), `server.json` in repo, PRs to awesome-mcp-servers / awesome-ai-agents lists; claim listings on Glama and Smithery. | S-M | Medium-High | §4, §7 |
| 12 | **Reddit / dev.to / Medium / YouTube / HN "Show HN"** posts titled with the exact agent intents; answer questions in r/mcp, r/ClaudeAI, r/openclaw, r/LocalLLaMA with links to skill.md. Reddit is the #1 cited domain for ChatGPT and Perplexity. | M | Medium-High | §1.5 |
| 13 | **Anthropic Connectors Directory** submission (needs Team/Enterprise org, annotations, privacy policy, docs, 3 example prompts). | M + wait | Medium (claude.ai + Claude Code users) | §4 |
| 14 | **ChatGPT/Codex plugin directory** submission — position as infrastructure/tooling (payments between agents), not as selling digital goods to ChatGPT users, to avoid the "digital product monetization" rejection. | M + wait | Medium | §4 |
| 15 | **Hugging Face**: a Gradio Space (MCP-enabled) demoing agent registration + agent-to-agent payment, plus a dataset/model card linking back; verify it appears in `hf discover search`. | S-M | Medium | §7 |
| 16 | **Moltbook presence**: run one or two helpful agents in relevant submolts that answer with our skill.md; monitor for prompt-injection; keep to the 1 post/30 min rule. | S | Medium, noisy | §6 |
| 17 | **Referral built into the product**: every agent's API responses/receipts include `"docs": "https://<domain>/skill.md"` and in-platform bounties for inviting other agents (word-of-mouth between agents is machine-readable when it is in payloads, not posts). | M | Medium-High over time | §6 promotion behaviour; §8 usage-as-reputation |
| 18 | **Web Bot Auth for our own outbound agents** (JWKS at `/.well-known/http-message-signatures-directory`, Cloudflare verified-bot registration) so agents we host are not blocked when they browse/use third-party APIs — plus offer it as an identity feature. | M | Indirect | §9 |
| 19 | **schema.org JSON-LD + Wikidata item** (Organization, SoftwareApplication/WebAPI, Offer, FAQ; `sameAs` to GitHub/npm/PyPI/HF) for Google AI Mode/AI Overviews and entity resolution. | S | Low-Medium (human-mediated agents) | §10 |
| 20 | **Instrumentation**: log hits to `/llms.txt`, `/skill.md`, `/.well-known/*`, `Accept: text/markdown`, AI user agents, registry referrers; poll registry APIs (official, Glama `GET /v1/servers`, Bazaar search) for our listing and rank; run Lighthouse Agentic Browsing monthly. Re-rank this playbook on measured agent traffic. | S | Enables everything else | §2 log study; §4 APIs |

Deprioritised (low reach or dead): `/.well-known/ai-plugin.json` (legacy), human agent directories (aiagentsdirectory, agent.ai), ai.txt, cursor.directory rules (tiny), Perplexity Pages, TDMRep/RSL.

---

## 13. Non-obvious insights

1. **Registries are self-populating; the winning move is to be machine-publishable.** Glama (82k), PulseMCP and GitHub sync from the official registry or crawl GitHub; x402 Bazaar indexes from settled payments. One `mcp-publisher` run + one x402 settlement covers most of the MCP long tail with no forms.
2. **llms.txt's real function is to keep an agent on-site once it arrived**, and its main readers are coding agents; treat it like an onboarding funnel (index → quickstart → register) rather than SEO.
3. **The description string is the marketing budget.** Because skills load name+description only, and MCP clients choose tools by description, the 1-2 sentences per tool/skill determine selection more than any landing page.
4. **Agents guess names.** Package-name hallucination (5-22%) means owning guessable names on npm/PyPI is both a security necessity and a discovery channel.
5. **Closed directories penalise agent-to-agent commerce** (ChatGPT rejects digital monetization; Anthropic requires an enterprise org). Our natural home is the open stack: MCP registry + skills + x402 + npm/PyPI + GitHub.
6. **Body text beats metadata** for agent fetchers; a docs page with the curl command in the first paragraph out-converts a beautiful landing page.
7. **Security scanners are the new gatekeepers**: a skill with broad env/binary requirements or obfuscated scripts gets hidden (ClawHub "suspicious" filter, community marketplace validation). Publish minimal, declarative skills.
8. **Usage is reputation in payment-native catalogs** (Bazaar ranks by 30-day calls and unique payers), so seeding usage with our own agents right after listing improves discoverability — a marketplace equivalent of "paid installs".
9. **Well-known standards are still forking** (`server-cards.json` vs `mcp.json`; `ai-catalog.json` vs `ard.json`); serve all variants from one JSON source rather than betting on one.
10. **Heartbeat-driven agents re-read instructions on a schedule** (Moltbook 30-min heartbeat; Claude Code marketplaces auto-update). Versioned skill.md/marketplace.json is a push channel to already-onboarded agents, i.e., retention marketing.

## 14. Open questions

- Is Anthropic's web_search backed by Brave? (Widely reported, never confirmed.) Which index does Codex/Gemini CLI use?
- Will MCP standardise `/.well-known/mcp/server-cards.json` (SEP-2127) and will clients (Claude Code, Cursor, Codex) implement automatic well-known lookup? Today Claude Code does not.
- How widely is the `mcp-registry` plugin (`mcp suggest`) used inside Claude Code, and does Anthropic plan first-class registry search?
- Real ClawHub catalog size after the purge and whether a public search API exists for direct agent queries (docs show CLI only).
- Moltbook under Meta: policy on third-party agents and promotional content; is the API still open?
- Does ARD converge on `ai-catalog.json` or `ard.json`, and which federated indexers beyond HF Discover are live?
- How do new domains enter Exa's index (submission? crawl cadence?) — docs 404'd.
- ChatGPT plugin policy: is "platform-level payments between agents" treated as digital-goods monetization?
- Wikidata/Wikipedia effect on agent discovery — unresearched.
- Cloudflare + AgentCore "open agent registry format" details (Feb 2026) — unverified.

## 15. All URLs consulted

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
- Failed fetches: https://help.openai.com/en/articles/20001256-plugins-in-codex (403), https://blog.cloudflare.com/web-bot-auth-agent-registry/ (404), https://cursor.directory/mcp (429), https://docs.exa.ai/reference/how-exa-search-works and https://exa.ai/docs/reference/how-exa-search-works (redirect/404), https://github.com/modelcontextprotocol/registry/blob/main/docs/explanations/ecosystem-vision.md (404), https://docs.cdp.coinbase.com/x402/bazaar/get-discovered (404)

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

# Launch-Checkliste — Agent Souk

Stand: 2026-09-08 (Checkpoint 56). Alles, was ich nicht selbst kann, steht hier mit Link. Reihenfolge = Wirkung.

**Live:** `https://api.agentsouk.dev` (Rauchtest bestanden) · npm + PyPI `agentsouk` 0.3.3 · Repo https://github.com/agent-souk/agentsouk

---

## DEINE OFFENE LISTE (Stand 2026-09-08, 00:15 UTC)

### Erledigt am 2026-09-08 (danke)

- ~~**Glama-Claim**~~ **verifiziert**: https://glama.ai/mcp/connectors/dev.agentsouk/agentsouk — „Ownership verified",
  Status Healthy, Qualitätsscore **B 3.4/5.0**, 40 Werkzeuge, Streamable HTTP. Der HTTP-Nachweis unter
  `/.well-known/glama.json` bleibt dauerhaft veröffentlicht, sonst verfällt die Verifizierung.
- ~~**DNS-TXT-Records**~~ `_agent` (AID v2) und `_mcp` sind live und über einen öffentlichen Resolver sichtbar.
- ~~**Apex-Domain**~~ live: `https://agentsouk.dev/` und `https://www.agentsouk.dev/` antworten mit der API,
  alle drei Fly-Zertifikate stehen auf **Issued**, `skill.md`, `llms.txt` und `/mcp` funktionieren über beide Hosts.
- ~~**Anthropic-Key**~~ ausgetauscht: neuer Key gegen die API geprüft (HTTP 200), in `~/.agentsouk-ops/agents.env`
  hinterlegt, als Fly-Secret auf `agentsouk-agents` gesetzt, Maschine neu gestartet, `/health.llm.enabled` = true.
  Die Datei `md.md.md` ist gelöscht; `.gitignore` fängt jetzt auch `*.md.md`, `key.md` und `apikey.md` ab.

### Noch offen

| # | Was | Wo | Dauer | Warum es zählt |
|---|---|---|---|---|
| 0 | **Sandbox-Faucet nachfüllen, wenn er leer läuft.** Er ist seit 2026-09-08 live (danke für die 20 Sepolia-USDC) und gibt jedem Sandbox-Agent 1 Testnetz-USDC am Tag, gasfrei (kein Sepolia-ETH nötig). Stand: `https://agentsouk-agents.fly.dev/health` → `faucet.sent_today`; Guthaben auf https://sepolia.basescan.org/address/0xc6e1DfE98e3e07FcC5eE70AdA3A34669B03d4C30. Nachfüllen: Circle-Faucet, Netzwerk Base Sepolia, dieselbe Adresse. | https://faucet.circle.com | ~3 min, bei Bedarf | Ohne Testnetz-USDC kann kein Agent das Bezahlen üben (ADR-30). |
| 1 | **Glama-Abzeichen für die große MCP-Liste.** Die Betreiber wollen ein Score-Abzeichen im Format `/mcp/servers/OWNER/REPO/badges/score.svg`. Das gibt es nur für Repo-Einträge; für unseren Connector liefert jeder Badge-Pfad 404, und der Servers-Pfad zeigt für **jede** Adresse „not listed". Ich habe im Antrag nachgefragt, wie sie ferne Connectors behandeln wollen. **Optional parallel:** auf https://glama.ai/mcp/servers eingeloggt „Add Server" klicken und `agent-souk/agentsouk` einreichen; dann existiert zusätzlich ein Repo-Eintrag mit echtem Abzeichen. Im Connector-Panel lohnt auch ein Blick in den Reiter **Admin**, ob dort ein Badge-Schnipsel angeboten wird. | https://glama.ai/mcp/servers → „Add Server"; oder Connector → Reiter Admin | ~5 min | Letzter Schritt für den Eintrag in der Liste mit 94.000 Sternen. Wenn die Betreiber im Antrag antworten, brauche ich dich dafür vielleicht gar nicht. |
| 2 | **Security-Bounty bestätigen, wenn die nächste kommt** | Wenn `https://agentsouk-agents.fly.dev/health` unter `operators.live.bounties[].needs_operator` einen Job nennt: sag mir Bescheid, ich zeige dir den Fund; du entscheidest ja/nein. **Erster Fall erledigt am 2026-09-08:** Fund von `veriton` (Signaturprüfung auf dem No-op-Pfad übersprungen) bestätigt, 3,5 USDC bezahlt (Tx `0x7be562c4…ae1f1`), Lücke vorher geschlossen. | nur bei Bedarf | Bis 10 USDC gehen nur nach menschlicher Bestätigung raus. Bewusst so gebaut; auf Wunsch lockere ich das (z. B. bis 5 USDC automatisch, wenn der Judge „zahlbar“ sagt). |
| 3 | **Optional: Context7 (Doku-Index für Coding-Agents)** | https://context7.com/add-library → Reiter **GitHub** → `https://github.com/agent-souk/agentsouk` einfügen und absenden (kein Login genannt). Die `context7.json` im Repo steuert, was indexiert wird (docs, SDK, Plugin). | ~2 min | Coding-Agents (Cursor, Claude Code, Windsurf) ziehen dann korrekte SDK-Signaturen mitten in der Arbeit (Brief §6 #11). |
| 4 | **Optional: ClawHub-Login** | `npm i -g clawhub`, `clawhub login` (GitHub im Browser); danach veröffentliche ich den Skill | ~5 min | Skill-Registry der OpenClaw-Agents. Nice to have, nicht kritisch. |

**Nicht nötig:** Geld nachlegen (35,5 von 50 USDC liegen noch bereit; 3,5 USDC gingen am 2026-09-08 an `veriton` für den ersten fremden Security-Fund; am 2026-09-08 gingen die ersten 11 USDC an den ersten fremden Agent `astra-api-research-e4f7077f` für einen Sandbox-Walkthrough-Bericht und eine LangChain-Integration, beide mit Rating 4 abgenommen; ERC-8004-Minting kostete unter 0,001 USD Gas), Code anfassen, Server bedienen, Verträge.

**Zur Kenntnis (Checkpoint 56, nichts zu tun, aber bitte einmal lesen):** Deine Sorge „wir erreichen keine Käufer und Verkäufer wegen Vertrauen“ ist
jetzt öffentlich beantwortet: `https://api.agentsouk.dev/v1/commitments`. Dein Wunsch, eine geplante Treuhandlizenz anzukündigen, ist **nicht**
umgesetzt, absichtlich: eine solche Ankündigung ohne Antrag, Eigenmittel und Anwalt wäre eine irreführende geschäftliche Handlung (§ 5 UWG),
würde als „BaFin-reguliert“ gelesen, lädt die Aufsicht ein und wäre die Anbahnung einer Dienstleistung, die wir nicht erbringen dürfen
(Recherche in `research/trust-limits-2026-09-08.jsonl`, Entscheidung ADR-32). Stattdessen steht dort als Tatsache: keine Lizenz, keine beantragt,
keine geplant. Dein Ehrgeiz („noch der Anfang, geplant ist der Umschlagplatz für Agents“) steht im Abschnitt `what_we_are_building`, klar als
Absicht markiert, mit den Live-Zahlen daneben. Die eigentliche Antwort auf die Vertrauensfrage ist der Abschnitt `your_record_outlives_us`: jede
Zahlung ist eine öffentliche Base-Transaktion, jeder Beleg trägt den Prüfschlüssel in sich und ist ohne uns prüfbar, für immer. Neu außerdem: die
Operator-Wallet ist dort veröffentlicht (jede Bounty, jeder Erstkauf, jeder Faucet-Tropfen auf Basescan nachprüfbar), die Reputation trennt
„von uns bezahlt“ und „von Fremden bezahlt“, und die Rezensionen der Desk sind als maschinell erzeugt gekennzeichnet (KI-VO Art. 50). Sieben
Übertreibungen in den öffentlichen Texten wurden korrigiert (z. B. „hires every new listing within the hour“ → „most, within published caps“).

**Zur Kenntnis (Checkpoint 54, nichts zu tun):** Bezahlen braucht jetzt kein ETH mehr. Die API liefert dem Käufer die fertige
Zahlungsautorisierung zum Signieren, ein öffentlicher Facilitator sendet sie und zahlt das Gas (ADR-30). Der Rauchtest (zwei Wegwerf-Agents,
Faucet, versiegelte Lieferung, Signatur, Facilitator, Verifikation) läuft in gut 10 Sekunden ohne Menschen, auch auf der Live-Sandbox;
Faucet-Stand 16 Sepolia-USDC (jeder Rauchtest-Lauf kostet 1). Auf Base Mainnet hat der öffentliche Facilitator (PayAI) einen echten
1-Cent-Transfer zwischen unseren eigenen Wallets gesendet und das Gas bezahlt (Tx `0x836ccf23…5371`); der Weg ist also auch live belegt.

**Zur Kenntnis (Checkpoint 53, nichts zu tun):** Agent Souk ist jetzt auch als ERC-8004-Agent auf Base registriert (Plattform agentId 85415,
`souk-bounties` 85416, `souk-services` 85417; Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`). Die Tokens gehören der Operator-Wallet bzw.
der souk-services-Wallet; die Mint-Belege liegen in `~/.agentsouk-ops/erc8004-ledger.json`. Explorer: https://www.8004scan.io (Indexierung kann dauern).
**Optional, wenn du magst:** die alten Forks `awesome-mcp-servers-appcypher` und `-wong2` sowie das alte private Repo
`nickillig3-dotcom/agentsouk` löschen (mein Token darf das nicht).

---

## Entscheidungen, die ich getroffen habe

| Thema | Entscheidung | Warum |
|---|---|---|
| Recht / Geld | **Proof-of-Payment (ADR-22).** Kein Guthaben, kein Escrow für Geld, kein Facilitator-Aufruf durch uns. Käufer zahlt Verkäufer direkt in USDC auf Base und reicht den Transaktions-Hash ein; wir prüfen nur lesend auf der Kette. Echte Werte ab Tag 1, wie von dir gewünscht. | Das Guthaben-/Escrow-Modell wäre in Deutschland doppelt erlaubnispflichtig (CASP + ZAG, `docs/LEGAL-BRIEFING.md`). Auch das Auslösen des Settlements durch uns sah nach Zahlungsdienst aus (Gutachten). Reines Lesen und Speichern von Daten ist der Kernfall der Ausnahme für technische Dienstleister. |
| Gebühr | **0 %.** Eine künftige Gebühr wäre eine separate Zahlung an unsere Wallet für unsere eigene Leistung, vorher im Changelog angekündigt. | Zugargument gegenüber Virtuals ACP / AgentMart (3 %); keine Verwahrung durch eine Gebühr. |
| Sandbox | Test-Keys laufen gegen **Base Sepolia** (Testnetz-USDC gratis vom Circle-Faucet), Live-Keys gegen Base. Gleiche API. | Agents können den kompletten Zahlungsweg risikolos üben. |
| GitHub-Name | Organisation **`agent-souk`** statt `agentsouk`. | `github.com/agentsouk` ist ein fremdes Benutzerkonto. |
| Domain-Minimum | **agentsouk.dev** (gekauft, 2026-09-06). | API-Adresse *und* Namensraum `dev.agentsouk` in der MCP-Registry (TXT-Record auf genau dieser Domain). |
| Kaltstart | **ADR-23.** Eigene Agents als erste Anbieter, sichtbar als `first_party`; echte Bounties (50 USDC) an fremde Agents; **keine Selbstzahlung** zwischen eigenen Wallets. | Jede Zahlung hat einen öffentlichen Hash; Kreisverkehr wäre für alle sichtbar und würde die Vertrauenssignale entwerten, die wir verkaufen. |

---

## Schritt 1 — Domain (erledigt)

`agentsouk.dev` ist bei Cloudflare registriert, `api.agentsouk.dev` zeigt per CNAME auf die Fly-App (gesetzt 2026-09-07), Zertifikat aktiv. Der TXT-Record für die MCP-Registry steht ebenfalls (2026-09-07). Nichts mehr offen.

`agentsouk.ai` (Porkbun, ~82 $/Jahr, https://porkbun.com/checkout/search?q=agentsouk.ai) bleibt optional.

---

## Schritt 2 — Hosting (Konto erledigt, Deploy mache ich)

`fly auth login` ist erledigt (Org `personal`). Ich lege die App `agentsouk-api` in `fra` an, erzeuge die Secrets selbst (`SECRET_PEPPER`, `SERVER_SIGNING_SEED`, `ADMIN_TOKEN`) und deploye. Dann brauche ich von dir nur das DNS-Menü in Cloudflare für den CNAME.

Kosten: ~4 $/Monat (eine Maschine + 3 GB Volume).

---

## Schritt 3 — Konten für die Verbreitung (erledigt bis auf die Org)

| Dienst | Stand | Wofür |
|---|---|---|
| **npm** | `agentsouk` **0.2.0 veröffentlicht** (2026-09-07) | erledigt |
| **PyPI** | `agentsouk` **0.2.0 veröffentlicht** (2026-09-07) | erledigt |
| **GitHub** | **erledigt** (2026-09-07): Org `agent-souk` angelegt, Repo **öffentlich** unter https://github.com/agent-souk/agentsouk (saubere Historie, 17 Themen) | öffentliches Repo, Login für MCP-Registry und ClawHub |
| **MCP-Registry** | `dev.agentsouk/agentsouk` 0.2.0 **veröffentlicht** (2026-09-07, TXT-Record steht) | erledigt; `repository` folgt, wenn das Repo öffentlich ist |
| **ClawHub** | nutzt GitHub (Konto ≥ 1 Woche alt) | Skill-Registry für OpenClaw-Agents |

---

## Schritt 4 — Zahlungen: was du (nicht) brauchst

Nichts. Die Plattform hält keine Wallet und keinen Schlüssel. Es gibt kein `X402_PAY_TO` mehr und keine
Facilitator-Zugangsdaten. Die API liest die Kette über öffentliche RPC-Knoten (`mainnet.base.org`,
`sepolia.base.org`); ein bezahlter RPC-Anbieter (Alchemy, QuickNode) ist erst bei hohem Volumen nötig.

Für den Rauchtest auf Base Sepolia erzeuge ich zwei Wegwerf-Wallets, hole Testnetz-USDC vom Circle-Faucet
(https://faucet.circle.com) und spiele einen kompletten Job durch. Deine Rabby-Adresse brauchen wir nur, falls
Agent Souk selbst einmal als Verkäufer auftritt.

Für später (Anwalt, vor größerem Volumen), gesammelt in `docs/LEGAL-BRIEFING.md` §9 bis §9.2:
1. Reicht Adress-Screening gegen die OFAC-SDN-Liste (ADR-24), oder braucht es vor größerem Volumen eine Transaktionsanalyse?
2. Gilt die Transparenzpflicht aus Art. 50 KI-VO zwischen zwei automatisierten Systemen? (Desk-Rezensionen sind seit ADR-32 als `machine_generated` gekennzeichnet.)
3. Verkäufer-Pfand in einem unveränderlichen Smart Contract: Ist eine Attestierungssignatur, die fremde Mittel freigibt, Verfügungsmacht (ZAG) bzw. Kontrolle über Zugangsmittel (MiCAR)? Macht das Deployen ohne eigenen Schlüssel den Deployer zum CASP? Löst ein Pfand die GwG-Verpflichtung aus? Wer haftet für einen Vertragsfehler? **Bis zur Antwort: kein Pfand, keine Treuhand, nichts davon in öffentlichen Texten.**
4. Gilt die P2B-Verordnung (EU) 2019/1150 oder der DSA für einen Markt, auf dem beide Seiten KI-Agents sind? (Erfüllung wäre billig: AGB, Ranking-Parameter offengelegt, Beschwerdeweg, Sperrpolitik.)
5. DSGVO Art. 22, falls hinter einem Listing eine natürliche Person steht und ein automatischer Score ihr Geschäft begrenzt.
Siehe ADR-22, ADR-32 und `docs/LEGAL-BRIEFING.md`.

---

## Schritt 5 — Was ich danach ohne dich erledige

1. ~~Deploy nach Frankfurt, Rauchtest, `api.agentsouk.dev` verbinden~~ (erledigt 2026-09-07).
2. ~~`npm publish` und `twine upload`, beide Pakete auf Version 0.2.0~~ (erledigt 2026-09-07).
3. MCP-Registry-Eintrag (`packages/api/server.json`; braucht deinen TXT-Record), ClawHub-Skill (`packages/sdk/SKILL.md`), öffentliches GitHub-Repo mit README und AGENTS.md (braucht die Org).
4. Discovery-Playbook aus `research/00-STRATEGIC-BRIEF.md` §6 abarbeiten: Verzeichnisse, Suchmaschinen-Crawler, awesome-Listen.
5. ADR-23: `first_party`-Kennzeichnung, drei eigene Referenz-Dienste live, Bounty-Budget (du befüllst eine Betreiber-Wallet mit ~50 USDC auf Base; Adresse nenne ich dir).
6. ~~Sanktionsscreening~~ (ADR-24), ~~Evaluator-/Schlichtungs-Panel~~ (ADR-25, Checkpoint 43); danach semantische Suche, Reputation v2.

---

## Kosten

| Variante | Einmal/Jahr | Monatlich |
|---|---|---|
| Minimal (.dev + Fly.io) | ~12 $ | ~4 $ |
| Mit .ai dazu | ~94 $ | ~4 $ |

---

## Was ich jetzt konkret von dir brauche

1. ~~**LLM-Dienste der Referenz-Agents (ADR-23, Rest).**~~ **Key liegt vor** (2026-09-07): `ANTHROPIC_API_KEY` steht in
   `~/.agentsouk-ops/agents.env`, gegen die API geprüft (Haiku antwortet, Guthaben vorhanden). Übersetzung und
   Zusammenfassung als weitere Dienste von `souk-services` sind damit baubar. **Offen bei dir:** Der erste Key stand
   im Chat; bitte in der Konsole widerrufen, einen neuen anlegen und die Zeile in der Datei ersetzen.
2. **Betreiber-Wallet für Bounties.** Eine neue Wallet (nicht deine Rabby), mit ~50 USDC auf Base befüllt, dazu
   2–3 $ in ETH auf Base als Gasgeld. Den privaten Schlüssel als `~/.agentsouk-ops/operator-wallet.env`
   (`OPERATOR_PRIVATE_KEY=0x...`) ablegen; damit zahlen die eigenen Agents Bounties an fremde Agents aus. Alternativ
   zahlst du Bounties von Hand aus Rabby und ich reiche nur den Hash ein; dann brauche ich nichts. **Verschoben**
   (2026-09-07, Nick: "machen wir später").
3. ~~**GitHub-Organisation `agent-souk`**~~ **erledigt am 2026-09-07:** Organisation angelegt, Repo öffentlich unter
   https://github.com/agent-souk/agentsouk. Offen für dich, wenn du magst: das alte private Repo
   `nickillig3-dotcom/agentsouk` löschen, dort liegen noch die alten Objekte von vor dem Umschreiben.
   ~~Entscheidung zur Rabby-Adresse in der Historie~~ **erledigt am 2026-09-07:** Historie mit `git-filter-repo`
   umgeschrieben, die Adresse ist aus allen 60 Commits verschwunden (Platzhalter in den zwei alten Commits von
   `docs/LEGAL-BRIEFING.md`), Inhalt des aktuellen Standes unverändert, `git push --force` auf das private Repo.
   Vollsicherung der alten Historie: `~/.agentsouk-ops/backups/agentsouk-history-20260907-1639.bundle`.
   ~~CNAME `api`~~ und ~~TXT-Record~~ sind erledigt.
4. Optional, für einen Test mit echtem Testnetz-USDC: eine Wallet mit Base-Sepolia-USDC vom Circle-Faucet (https://faucet.circle.com, Netzwerk "Base Sepolia"). Ich kann die Adresse einer Wegwerf-Wallet nennen, die du dort einträgst.

---

## Neu seit Checkpoint 47 (2026-09-07)

5. **Apex-Domain `agentsouk.dev` auflösen lassen** (bisher keine Antwort unter https://agentsouk.dev/). In Cloudflare, DNS only (graue Wolke):
   `A agentsouk.dev → 66.241.124.182`, `AAAA agentsouk.dev → 2a09:8280:1::185:2f1c:0`, `CNAME www → agentsouk-api.fly.dev`.
   Die Fly-Zertifikate sind angefordert (`fly certs check agentsouk.dev -a agentsouk-api` zeigt den Stand); die API antwortet dann unter beiden Hosts.
6. **Betreiber-Wallet für Bounties (ersetzt Punkt 2):** Du musst keine Wallet mehr anlegen. Ich erzeuge die Identität `souk-bounties`
   mit eigener Wallet; die Adresse steht in `docs/STATUS.md` (Checkpoint 48). Sobald Coinbase dich freigeschaltet hat: **50 USDC auf Base**
   (Netzwerk "Base", nicht Ethereum) und **~3 USD in ETH auf Base** (Gasgeld) an diese Adresse senden. Die Runtime prüft das Guthaben
   selbst und schreibt Bounties nur aus, die sie bezahlen kann.
7. **Erledigt am 2026-09-07 (Punkt 6):** 50 USDC + Gas liegen auf der Betreiber-Wallet `0xc6e1DfE98e3e07FcC5eE70AdA3A34669B03d4C30`,
   drei Bounties sind live. `privatekey.md` ist gelöscht und in `.gitignore`; in Rabby bleiben 6,17 USDC und 0,0003 ETH.
   **Bitte künftig keine Private Keys in Dateien im Repo-Ordner ablegen**, sondern in `~/.agentsouk-ops/`.
8. **Jetzt wichtig (Sandbox-Faucet, ADR-30):** Base-Sepolia-USDC und etwas Sepolia-ETH vom Circle-Faucet (https://faucet.circle.com,
   Netzwerk "Base Sepolia"; der Faucet hat ein Captcha, deshalb kann ich das nicht selbst) an dieselbe Adresse
   `0xc6e1DfE98e3e07FcC5eE70AdA3A34669B03d4C30`. Gern an mehreren Tagen wiederholen (der Faucet gibt pro Tag nur wenig). Damit kann die
   Desk jedem Sandbox-Agent täglich 1 Testnetz-USDC schenken, sodass Agents den kompletten Zahlungsweg ohne Menschen üben können; das war
   der Schritt, an dem der erste fremde Agent hängen blieb. Nebeneffekt: die Desk schreibt dann auch auf der Sandbox aus.
9. **Security-Findings bestätigen:** wenn `https://agentsouk-agents.fly.dev/health` unter `operators.live.bounties[].needs_operator`
   einen Job nennt, Vorschau ansehen (`GET /v1/jobs/<id>` mit dem Key aus `~/.agentsouk-ops/operator.env`) und bei echtem Fund
   `PUT /v1/memory/operator%2Fconfirm%2F<job_id>` `{"value": true}` setzen; die Desk zahlt dann beim nächsten Tick.

---

## Neu seit Checkpoint 50 (2026-09-07): Discovery, Runde 2

10. **Zwei DNS-TXT-Records in Cloudflare** (beide "DNS only", 5 Minuten; damit finden Agents, die per DNS suchen, den MCP-Server):
    - Name `_agent` (also `_agent.agentsouk.dev`), Typ TXT, Inhalt genau:
      `v=aid2;p=mcp;u=https://api.agentsouk.dev/mcp;a=pat;s=Agent Souk: marketplace for AI agents;d=https://api.agentsouk.dev/llms.txt`
      (Agent Identity & Discovery v2; `a=pat` = Bearer-Key).
    - Name `_mcp` (also `_mcp.agentsouk.dev`), Typ TXT, Inhalt genau:
      `v=mcp1;registry=https://api.agentsouk.dev/.well-known/mcp.json;public=true;version=2026-09`
11. **Glama zuerst (wichtig, ~10 Minuten):** Der PR an die größte Awesome-MCP-Liste (https://github.com/punkpeye/awesome-mcp-servers/pull/13922)
    wird nur gemergt, wenn der Server auf Glama gelistet ist und ein Score-Badge hat. Auf https://glama.ai/mcp/servers mit
    GitHub (`nickillig3-dotcom`) anmelden, Server `agent-souk/agentsouk` einreichen (Remote-Server: URL `https://api.agentsouk.dev/mcp`;
    zusätzlich unter https://glama.ai/mcp/connectors als Hosted Endpoint eintragen). Sobald der Score existiert, sag Bescheid,
    dann füge ich das Badge in den PR ein. Danach optional: https://smithery.ai (Claim), https://context7.com/add-library
    (Bibliothek `agent-souk/agentsouk`, damit Coding-Agents die SDK-Doku mitten in der Arbeit ziehen).
12. **ClawHub** (Skill-Registry der OpenClaw-Agents, Konto muss ≥ 1 Woche alt sein): `npm i -g clawhub`, `clawhub login` (GitHub im
    Browser), dann aus dem Repo `clawhub skill publish plugins/agentsouk/skills/agentsouk`. Ich kann den Befehl ausführen, sobald das
    Login einmal im Browser gemacht ist.
13. **Erledigt ohne dich (2026-09-07):** MCP-Registry auf 0.3.5, IndexNow-Key gesetzt (Bing/Yandex/Naver/Seznam bekommen jede
    Sitemap-Änderung per `npx tsx packages/api/scripts/indexnow.ts`), Pull Request an die größte Awesome-MCP-Liste aus deinem
    GitHub-Konto (https://github.com/punkpeye/awesome-mcp-servers/pull/13922; appcypher ist archiviert, wong2 nimmt keine PRs von
    deinem Konto an; die Forks `awesome-mcp-servers-appcypher` und `-wong2` kannst du löschen), Claude-Code-Plugin-Marktplatz und Gemini-CLI-Extension im Repo,
    Well-known-Kataloge (`/.well-known/mcp-server-card`, `ard.json`, `ai-catalog.json`). Wer die Doku liest, siehst du in
    `GET /v1/admin/overview` → `discovery` (Header `x-admin-token`, Wert aus `~/.agentsouk-ops/agentsouk-api.env`).

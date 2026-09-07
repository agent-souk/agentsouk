# Launch-Checkliste — Agent Souk

Stand: 2026-09-07 (Checkpoint 36). Alles, was ich nicht selbst kann, steht hier mit Link. Reihenfolge = Abhängigkeit.

**Live:** `https://api.agentsouk.dev` (Rauchtest 20/20) · npm `agentsouk@0.2.0` · PyPI `agentsouk` 0.2.0.

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

Für später (Anwalt, vor größerem Volumen): Sanktionsscreening der Wallet-Adressen (bindet uns unabhängig von
einer Erlaubnis) und die Transparenzpflicht aus Art. 50 KI-VO. Siehe ADR-22 und `docs/LEGAL-BRIEFING.md` §9.

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
8. **Optional (Sandbox-Bounties):** Base-Sepolia-USDC und etwas Sepolia-ETH vom Circle-Faucet (https://faucet.circle.com,
   Netzwerk "Base Sepolia") an dieselbe Adresse `0xc6e1DfE98e3e07FcC5eE70AdA3A34669B03d4C30`; dann schreibt die Desk auch auf der Sandbox aus.
9. **Security-Findings bestätigen:** wenn `https://agentsouk-agents.fly.dev/health` unter `operators.live.bounties[].needs_operator`
   einen Job nennt, Vorschau ansehen (`GET /v1/jobs/<id>` mit dem Key aus `~/.agentsouk-ops/operator.env`) und bei echtem Fund
   `PUT /v1/memory/operator%2Fconfirm%2F<job_id>` `{"value": true}` setzen; die Desk zahlt dann beim nächsten Tick.

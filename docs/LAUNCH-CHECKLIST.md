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
| **GitHub** | Repo privat unter `nickillig3-dotcom/agentsouk`; Org `agent-souk` noch anlegen: https://github.com/account/organizations/new | öffentliches Repo, Login für MCP-Registry und ClawHub |
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
6. Danach: Sanktionsscreening, Evaluator- und Schlichtungs-Panel, semantische Suche.

---

## Kosten

| Variante | Einmal/Jahr | Monatlich |
|---|---|---|
| Minimal (.dev + Fly.io) | ~12 $ | ~4 $ |
| Mit .ai dazu | ~94 $ | ~4 $ |

---

## Was ich jetzt konkret von dir brauche

1. **Entscheidung Referenz-Agents (ADR-23, Teil 2).** Drei eigene Dienste kosten laufend Geld: ein LLM-Schlüssel für
   Übersetzung und Zusammenfassung (Anthropic-API, bei Kleinstpreisen grob 5–20 $/Monat je nach Nachfrage) und eine
   zweite kleine Fly-Maschine (~2–4 $/Monat). Wenn du das willst: einen Anthropic-API-Key anlegen
   (https://console.anthropic.com → API Keys) und mir als Datei `~/.agentsouk-ops/agents.env` (`ANTHROPIC_API_KEY=...`)
   hinlegen, nicht in den Chat. Web-Extraktion und JSON-Schema-Prüfung brauchen kein LLM; die baue ich ohnehin zuerst.
2. **Betreiber-Wallet für Bounties.** Eine neue Wallet (nicht deine Rabby), mit ~50 USDC auf Base befüllt. Den
   privaten Schlüssel als `~/.agentsouk-ops/operator-wallet.env` (`OPERATOR_PRIVATE_KEY=0x...`) ablegen; damit zahlen
   die eigenen Agents Bounties an fremde Agents aus. Alternativ zahlst du Bounties von Hand aus Rabby und ich
   reiche nur den Hash ein; dann brauche ich nichts.
3. **GitHub-Organisation `agent-souk`** anlegen (https://github.com/account/organizations/new). Vor dem Öffentlichmachen
   des Repos eine Entscheidung: deine Rabby-Adresse stand vor Commit `3667f8c` in den Docs und ist in der Git-Historie
   noch enthalten. Eine Wallet-Adresse ist öffentlich auf der Kette, aber wenn sie nicht mit dem Repo verknüpft sein
   soll, muss ich die Historie umschreiben (neues Repo mit frischer Historie ist am einfachsten). Sag, was du willst.
   ~~CNAME `api`~~ und ~~TXT-Record~~ sind erledigt.
3. Optional, für einen Test mit echtem Testnetz-USDC: eine Wallet mit Base-Sepolia-USDC vom Circle-Faucet (https://faucet.circle.com, Netzwerk "Base Sepolia"). Ich kann die Adresse einer Wegwerf-Wallet nennen, die du dort einträgst.

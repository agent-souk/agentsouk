# STATUS (bei Unterbrechung hier weiterlesen)

## Name: Agent Souk · Pakete `agentsouk` (npm, PyPI) · API `https://api.agentsouk.dev` · Keys `as_live_` / `as_test_` (ADR-19)

## Stand 2026-09-07, Checkpoint 35: Review-Findings eingebaut, 129 Tests grün

Beide Review-Agenten starben am Session-Limit, hinterließen aber 23 Kandidaten; alle geprüft, neun Punkte umgesetzt
(ADR-22-Nachtrag in `docs/DECISIONS.md`). Kern: **Wallet-Bindung nur mit EIP-191-Signatur der Wallet** (vorher
hätte ein Angreifer die Adresse eines fremden Zahlers eintragen und dessen Transfer als eigene Zahlung einreichen
können; Blocker), eingefrorene Empfängeradresse pro Job (`jobs.pay_to`), Teilzahlungen (`partial`), verwaiste
Zahlungen auch bei beendeten oder schon bezahlten Jobs (`orphaned` + `refund_due` + `refund_expected`), Netto-Betrag
(Round-Trips zählen nicht), T1-Mindestvolumen 10 USDC, Sweep-Race, robuste RPC-Antwortprüfung. Migration
`0001_payments_v2` (nur zwei neue Spalten). `wallet_address` bei der Registrierung entfällt; SDKs/CLIs/MCP/Docs
angepasst (`setWalletAddress(address, signature, proof?)`, `wallet message` / `wallet-message` Hilfsbefehle).
Neu: `packages/api/scripts/smoke.ts` (Rauchtest mit echten Signaturen: `cd packages/api && npx tsx scripts/smoke.ts <url>`).
**Checkpoint 35 ist deployt** (2026-09-07 01:29 Uhr, Migration 0001 lief auf dem bestehenden Volume), Rauchtest gegen
`https://agentsouk-api.fly.dev` 20/20 bestanden (inkl. Wallet-Bindung mit EIP-191-Signatur und Ablehnung einer
fremden Signatur).

Veröffentlichung von npm/PyPI 0.2.0 wartet bewusst auf den DNS-Eintrag: die SDKs zeigen standardmäßig auf
`https://api.agentsouk.dev`, das noch nicht auflöst. Sobald der CNAME steht: Domain umschalten, Rauchtest gegen die
Domain, dann veröffentlichen.

## Stand 2026-09-06, Checkpoint 34: Umbau auf nicht-verwahrende Zahlungen FERTIG

`npm run typecheck` grün, `npm test` grün (22 Dateien, 121 Tests). Der Code kompiliert wieder und ist deploybar.

### Die Entscheidung (ADR-22, ersetzt die Settlement-Teile von ADR-21)

**Proof-of-Payment.** Die Plattform berührt zu keinem Zeitpunkt ein Zahlungsinstrument und ruft nie einen
Facilitator auf. Der Käufer zahlt selbst on-chain (USDC auf Base; beliebige Wallet, oder gasfrei, indem er seine
x402-Autorisierung selbst bei einem öffentlichen Facilitator einreicht) und reicht nur den Transaktions-Hash ein
(`POST /v1/jobs/{id}/pay {"transaction":"0x…"}`). Wir lesen den Beleg über einen Base-JSON-RPC-Knoten
(3 Leseaufrufe) und prüfen: erfolgreich, USDC-Vertrag, von der Wallet des Käufers an die Wallet des Verkäufers,
Betrag ≥ Preis, Bestätigungen, Blockzeit nach Auftragserstellung, Hash nie zuvor verwendet, Zahler ≠ Empfänger.
Damit sind wir reine Datenverarbeitung (§ 2 Abs. 1 Nr. 9 ZAG), ohne Einwirkungsmöglichkeit auf den Zahlungsfluss,
und die Doppelzahlungsklasse aus dem mechanischen Gutachten ist konstruktionsbedingt weg (ein Hash zahlt genau
einen Job, Wiederholung ist idempotent, unklare Settlement-Ausgänge gibt es nicht mehr).

Weitere Punkte aus ADR-22: `wallet_address` statt `payout_address` (eine Adresse pro Agent, Pflicht für
Verkäufer **und** zahlende Käufer; Änderung nur mit Ed25519-Proof `agentsouk:wallet:<id>:<addr>`),
symmetrische Rückerstattung `POST /v1/jobs/{id}/refund` mit Hash, `refund_due` als Reputationsmangel,
`upfront` nur ab T1 (live), Walk-away ohne Makel, Gegenparteien nach Wallet-Adresse, T1 nur über bezahlte
Live-Jobs mit ≥ 3 Zahleradressen. Details: `docs/SPEC-PAYMENTS.md`, `docs/DECISIONS.md` ADR-22.

### Was seit Checkpoint 33 gebaut wurde

- `modules/payments/`: `chain.ts` (JSON-RPC-Reader, `verifyUsdcTransfer`, Test-Hook), `x402.ts` (Konstanten,
  Terms, nur noch Info), `service.ts` (Settlements: settled | orphaned, Unique-Index auf dem Hash), `routes.ts`
  (`GET /v1/payments`, `GET /v1/payments/settlements`). `facilitator.ts` gelöscht.
- `modules/jobs/`: `pay` (Terms als 402 ohne Header, Hash-Verifikation, Wiederbelebung nach unbezahltem
  Ablauf innerhalb 1 h Gnade, verwaiste Zahlungen → `refund_due`), `refund`, `cancel_kind`, `outcomes.ts`
  (gemeinsame Ergebnisregeln für Listing-Statistik und Reputation). Keine DB-Transaktionen mehr (SQLite-
  Single-Writer-Deadlock im Single-Thread), stattdessen Insert + bedingtes Update unter `lib/mutex.ts`.
- `modules/agents/`: `wallet_address` bei Registrierung, `POST /v1/agents/me/wallet-address`,
  `assertWalletAddress`, `assertUpfrontAllowed`.
- Listings (`payment`, USDC-Anzeige, Wallet-Pflicht, Upfront-Gate), Bounties (`payment` im Proposal),
  Reviews/Reputation (neue Felder, Zählung nach Adresse, `refunds_due` im Score), Meta (Stats aus Settlements,
  Changelog), A2A, MCP (`payment_info`, `set_wallet_address`, `my_settlements`, `job_action pay/refund`),
  Discovery-Texte komplett neu (skill.md, llms.txt, quickstart, errors, agent card), Inbox mit Zahlungsaufgaben.
- Migrationen auf eine frische `0000_init` zurückgesetzt (nichts war deployt; drizzle-kit braucht für
  Umbenennungen ein TTY). Lokale Dev-DB gelöscht.
- Tests: neue Fake-Chain (`src/test/chain.ts`), Jobs-Suite komplett neu (18 Tests inkl. Race, Orphan, Grace,
  Walk-away, Refund, x402-Header-Ablehnung, Chain-Ausfall), Payments-Unit-Tests, alle anderen Suiten angepasst.
- SDKs: npm `jobs.pay(id, hashOderSender)`, `jobs.paymentRequired`, `jobs.refund`, `payments.*`,
  `agents.setWalletAddress` (Proof wird mit `secretKey` selbst signiert), CLI `jobs terms|pay|refund`,
  `wallet set`; Python spiegelgleich (`jobs.pay`, `payment_required`, `refund`, `payments`, CLI `terms|pay|refund|wallet-address`).
  Beide auf Version 0.2.0 (noch nicht veröffentlicht; auf npm/PyPI liegt 0.0.1 als Platzhalter).
- Docs: README, AGENTS.md, SDK-READMEs/AGENTS.md, SKILL.md (aus `discovery/text.ts` generiert), `.env.example`,
  `docker-compose.yml`, `fly.toml`, `server.json`.

### Stand der Gutachten-Findings (2026-09-06)

| Finding | Status |
|---|---|
| Juristisch: wir lösen `/settle` aus → Akquisitionsgeschäft | **Erledigt** durch ADR-22 (wir lösen nichts aus, wir lesen nur) |
| Sanktionsscreening der Wallet-Adressen | **Offen** (Folgeaufgabe: EU-Liste prüfen bei `wallet_address`-Setzen) |
| KI-VO Art. 50 (Transparenz) | **Offen** (Anwalt) |
| Mechanisch: Doppelzahlung bei unklarem Settlement | **Entfällt** konstruktionsbedingt |
| `cancel`/Sweeps ohne Mutex | **Erledigt**: bedingte Updates, verwaiste Zahlung → `refund_due` + Refund-Flow |
| `upfront` ohne Vertrauensstufe | **Erledigt**: live nur ab T1 |
| Reputation nach Agent-ID farmbar | **Erledigt**: Zählung nach Adresse, Selbstzahlung abgelehnt, T1 nur mit 3 Zahleradressen (Restrisiko in ADR-22 dokumentiert) |
| Müll-Lieferung erzeugt `jobs_unpaid` | **Erledigt**: Walk-away ohne Makel, nur stilles Verstreichen zählt |
| CDP-JWT pro Aufruf | **Entfällt** (kein Facilitator-Client mehr) |

### LIVE seit 2026-09-06 ~21:00 Uhr: `https://agentsouk-api.fly.dev`

- Fly-App `agentsouk-api`, Region `fra`, eine Maschine (`shared-cpu-1x`, 512 MB), Volume `agentsouk_data` (3 GB),
  Image `deployment-01M1W1C0PZ0H1RVMWVXCWQDH9K`. Secrets gesetzt (`SECRET_PEPPER`, `SERVER_SIGNING_SEED`,
  `ADMIN_TOKEN`, `PUBLIC_BASE_URL=https://agentsouk-api.fly.dev`). Der Admin-Token liegt lokal in
  `~/.agentsouk-ops/agentsouk-api.env` (nicht im Repo).
- Rauchtest gegen die Live-Adresse bestanden (17/17): health, skill.md, /v1/payments (test + live), Registrierung
  mit Wallet, Listing, Job, versiegelte Lieferung, 402-Terms, unbekannter Hash → `transaction_not_found` über den
  **echten** Sepolia-RPC, Inbox, Walk-away, MCP, OpenAPI. Der Chain-Reader wurde außerdem lokal gegen einen echten
  USDC-Transfer auf Base Sepolia verifiziert (518 ms, 172 Bestätigungen).
- IPs: v4 (shared) `66.241.124.182`, v6 `2a09:8280:1::185:2f1c:0`. Zertifikat für `api.agentsouk.dev` ist
  angefordert, wartet auf DNS. **Nick muss in Cloudflare setzen (DNS only, graue Wolke):**
  `CNAME api → pekyl2r.agentsouk-api.fly.dev` (oder `A 66.241.124.182` + `AAAA 2a09:8280:1::185:2f1c:0`).
  Danach: `fly certs check api.agentsouk.dev -a agentsouk-api`, dann `fly secrets set PUBLIC_BASE_URL=https://api.agentsouk.dev -a agentsouk-api`
  (Neustart automatisch), Rauchtest erneut gegen die Domain.
- Noch nicht mit echtem Faucet-USDC durchgespielt (Circle-Faucet braucht Browser/Captcha): dafür braucht es zwei
  Wallets mit Sepolia-USDC; alle Prüfpfade sind mit der Fake-Chain und der echte Lesepfad mit einem realen Transfer getestet.

### Nächste Schritte (Reihenfolge)

1. Findings des adversarialen Reviews (läuft/lief am 2026-09-06 abends, Notizen im Session-Scratchpad) einbauen, Tests, Checkpoint.
2. Nick: DNS-Eintrag setzen (oben). Dann Domain umschalten und Rauchtest gegen `api.agentsouk.dev`.
3. npm/PyPI 0.2.0 veröffentlichen (`packages/sdk`: `npm publish`; `sdk-python`: `python -m build && twine upload`).
4. MCP-Registry (`packages/api/server.json`, TXT-Record auf agentsouk.dev), ClawHub-Skill, Repo öffentlich,
   Discovery-Playbook aus `research/00-STRATEGIC-BRIEF.md` §6.
5. Danach: Sanktionsscreening, Evaluator-/Schlichtungs-Panel, semantische Suche, `receiveWithAuthorization`-
   Pfad als gasfreie Zahlmethode dokumentieren (der Käufer reicht selbst beim Facilitator ein; schon im 402 erklärt).

## Setup-Stand

- **Domain: agentsouk.dev gehört Nick** (registriert 2026-09-06 15:54 UTC, Cloudflare, aktiv bis 2027-09-06,
  NS `rachel.ns.cloudflare.com` / `tony.ns.cloudflare.com`). DNS-Einträge noch nicht gesetzt.
  `.ai` verschoben (Mindestlaufzeit zwei Jahre, ~160 $), `.io` frei, `.com` geparkt.
- **npm:** angemeldet als `nickaiworld`, Token in `~/.npmrc`. Paket `agentsouk` **0.0.1 veröffentlicht** (Platzhalter).
- **PyPI:** Token in `~/.pypirc`. Paket `agentsouk` **0.0.1 veröffentlicht** (Platzhalter).
- **flyctl:** v0.4.99 unter `~/.fly/bin/flyctl.exe`, angemeldet als `nickillig3@gmail.com`, Org `personal`,
  **noch keine App angelegt**, Name `agentsouk-api` frei.
- **GitHub:** `nickillig3-dotcom`, Repo `https://github.com/nickillig3-dotcom/agentsouk`, **privat**, Branch `main`.
  Org `agent-souk` noch nicht angelegt.
- **Rabby-Adresse** liegt auskommentiert in `packages/api/.env`. Im neuen Modell wird sie nur gebraucht, falls
  Agent Souk selbst als Verkäufer auftritt (z. B. eine eigene Plattform-Leistung anbietet).
- **Base-RPC:** öffentliche Endpunkte (`mainnet.base.org`, `sepolia.base.org`) sind Standard; ein Alchemy-/
  QuickNode-Schlüssel wäre nur für höhere Ratenlimits nötig (`BASE_RPC_URL_LIVE/TEST`).

## Befehle

- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration: `cd packages/api && npx drizzle-kit generate --name <name>` (bei Tabellen-Umbenennungen interaktiv, braucht ein TTY)
- SKILL.md neu erzeugen: `cd packages/api && npx tsx -e "import { skillMd } from './src/discovery/text.ts'; process.stdout.write(skillMd('https://api.agentsouk.dev'))" > ../sdk/SKILL.md && cp ../sdk/SKILL.md ../../sdk-python/SKILL.md`
- Windows: `netstat` ist deutsch ("ABHÖREN"); Serverprozesse per
  `wmic process where "CommandLine like '%src/index.ts%'"` finden und `taskkill //F //PID` beenden; kein `python3` auf dem Pfad (Node für Skripte nehmen)
- Session-Limit: große parallele Subagent-Workflows scheitern; selbst bauen, Subagents einzeln
  (zwei Gutachter parallel gingen gut), früh auf Disk schreiben, oft committen

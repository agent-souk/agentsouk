# STATUS (bei Unterbrechung hier weiterlesen)

## Name: Agent Souk · Pakete `agentsouk` (npm, PyPI) · API `https://api.agentsouk.dev` · Keys `as_live_` / `as_test_` (ADR-19)

## ⚠️ ACHTUNG: Der Code ist mitten in einer Operation und kompiliert NICHT

Stand 2026-09-06, 17:30 Uhr. `npx tsc -p packages/api/tsconfig.json --noEmit` meldet **29 Fehler**.
Das ist kein Bug, das ist ein halbfertiger Umbau. **Nächster Schritt: den Umbau zu Ende führen.**
Wer hier weitermacht, liest zuerst `docs/DECISIONS.md` → ADR-21 und `docs/SPEC-PAYMENTS.md`.

## Was gerade umgebaut wird (ADR-21): weg vom eigenen Guthaben, hin zu Wallet-zu-Wallet

**Warum:** Das alte Modell (eigene CRD-Credits, wir halten das Geld im Escrow) ist in Deutschland
doppelt erlaubnispflichtig (MiCA/KMAG CASP **und** ZAG), Übergangsfristen abgelaufen, 125.000 € Mindestkapital,
dazu GwG-Pflichten, die "Registrierung ohne Mensch" unmöglich machen. Siehe `docs/LEGAL-BRIEFING.md`.

**Neues Modell:** Käufer zahlt Verkäufer direkt, Wallet zu Wallet, USDC auf Base, über x402.
Die Plattform fasst nie Geld an. Sie hält stattdessen die **Lieferung** zurück, bis bezahlt wurde
("versiegelte Lieferung"). Preise sind USDC-Minor-Units (1000000 = 1 USDC).

## Fertig umgebaut

- `docs/DECISIONS.md` → **ADR-21** (die vollständige Entscheidung mit Begründung)
- `docs/SPEC-PAYMENTS.md` → **neu**, die maßgebliche Spezifikation (Zustandsmaschine, Endpunkte, Wire-Format)
- `packages/api/src/db/schema.ts` → Ledger/Accounts/Deposits/Withdrawals raus, `agents.payout_address` rein
- `packages/api/src/db/schema-marketplace.ts` → `payment` (on_delivery|upfront) auf Listings/Jobs/Proposals,
  Job-Felder `paid_at`, `payment_deadline_at`, `settlement_id`, `output_hash`, `output_bytes`, `output_preview`,
  `unpaid`, `turnaround_seconds`; neue Tabelle **`settlements`**; Reputation `volume_usdc` + `jobs_unpaid`
- `packages/api/src/config.ts` → `X402_FACILITATOR_URL_LIVE/TEST`, `CDP_API_KEY_ID/SECRET`, `PAYMENT_WINDOW_*`;
  `FAUCET_CREDITS`, `PLATFORM_FEE_BPS`, `X402_PAY_TO` entfernt
- `packages/api/src/lib/ids.ts` (`stl_` statt `txn_`/`led_`/`acc_`/`dep_`/`wdr_`), `lib/errors.ts` (`insufficient_funds` raus)
- `packages/api/src/modules/payments/` → **neu**: `address.ts` (EIP-55), `x402.ts` (v1+v2 Wire-Format),
  `facilitator.ts` (verify/settle, CDP-JWT, /supported-Cache, Test-Hook), `service.ts` (Settlements), `routes.ts`
  (`GET /v1/payments`, `GET /v1/payments/settlements`)
- `packages/api/src/modules/agents/service.ts` → `payout_address` + Ed25519-Proof beim Ändern; Faucet/Referral-Credits raus
- `packages/api/src/modules/jobs/service.ts` + `routes.ts` → komplett neu: Status `awaiting_payment`,
  versiegelte Lieferung, `POST /v1/jobs/{id}/pay` (402 + x402), Per-Job-Mutex, Sweeps für unbezahlt
- **Gelöscht:** `src/ledger/*`, `src/modules/wallet/*`

## NOCH NICHT umgebaut (daher die 29 Fehler)

Ein Patch-Skript ist an einem Shell-Quoting-Fehler gescheitert; diese Dateien sind unangetastet:

1. `modules/listings/service.ts` + `routes.ts` — `volume_crd` → `volume_usdc`, `payment`-Feld,
   Payout-Adresse als Pflicht (`assertPayoutAddress`), USDC-Anzeige, `updateListing(env, agent, ...)`
2. `modules/bounties/service.ts` + `routes.ts` — `payment` im Proposal, USDC-Texte, Payout-Pflicht
3. `modules/reviews/service.ts` + `routes.ts` — `volume_usdc`, `jobs_unpaid`, neues `JobResolution.outcome`
4. `modules/agents/routes.ts` — `payout_address` in Request/Response, `POST /v1/agents/me/payout-address`
5. `app.ts` — `walletRoutes()` raus, `paymentsRoutes()` rein
6. `mcp/server.ts` — Wallet-Tools raus, `payment_info` / `set_payout_address` / `pay` rein
7. `discovery/text.ts` — der gesamte CRD-Text in skill.md, llms.txt, quickstart, errors
8. `meta/routes.ts` (Stats `volume_usdc`, Changelog), `a2a/routes.ts` (CRD in Skill-Beschreibung)
9. **Migration `0005` noch nicht erzeugt** (`cd packages/api && npx drizzle-kit generate --name payments`)
10. **Alle Tests** noch auf dem alten Modell (jobs, listings, bounties, agents, integration,
    review-regressions, sdk, mcp, discovery, meta, events, messaging) + neue Tests laut SPEC §14
11. **SDKs** (npm `packages/sdk`, `sdk-python`) — Wallet-Oberfläche raus, Payments rein
12. `README.md`, `AGENTS.md`, `docs/LAUNCH-CHECKLIST.md`, `fly.toml`, `.env.example`, `docker-compose.yml`

## Zwei Gutachten liegen vor (adversarial, 2026-09-06) — beide "ship_with_fixes"

Volltext: `.claude/projects/.../tasks/wo0t74l64.output` (Run `wf_34a3c84e-d25`).

**Juristisch (Blocker, Entscheidung nötig):** Der Gutachter widerlegt vier von fünf Angriffen — keine
MiCA-Verwahrung, kein Zahlungsauslösedienst, keine eigenständige GwG-Pflicht, Testnetz unkritisch.
**Aber:** ADR-21 prüft nur "kein Besitz an Geldern". Die BaFin hat eine zweite Hürde: wer
*Einwirkungsmöglichkeit auf den Zahlungsfluss* hat, verliert die Ausnahme für technische Dienstleister
(§ 2 Abs. 1 Nr. 9 ZAG). Weil **wir** `/settle` aufrufen — ohne uns fließt nichts —, sieht das funktional nach
Akquisitionsgeschäft (§ 1 Abs. 1 S. 2 Nr. 5 ZAG) aus; USDC ist als E-Geld-Token "Geldbetrag".
*Vorgeschlagene Lösung:* Der **Käufer-Client** löst das Settlement aus (oder der Verkäufer per
`receiveWithAuthorization`), wir prüfen nur lesend auf der Kette. Dann sind wir gar nicht in der Zahlungskette.
Das ist eine Architekturentscheidung — **Fable entscheidet, nicht Opus.**
Außerdem offen: Sanktions-Screening (bindet uns unabhängig von der Lizenz) und KI-VO Art. 50 (gilt seit 02.08.2026).

**Mechanisch (1 Blocker, 4 Major):**
- **Blocker:** Bei unklarem Settlement-Ausgang (Facilitator-Timeout nach Broadcast, `settlement_pending`,
  DB-Schreibfehler nach Settle) zahlt der Käufer zweimal, ohne Rückweg. Fix: `payer_address` + `nonce` auf der
  Settlement-Zeile speichern, `settlement_pending` als **nicht-terminal** behandeln, vor jedem neuen Settle
  erst auf eine bestehende Zeile mit `transaction != null` prüfen.
- `cancel`/Sweeps nehmen den Per-Job-Mutex nicht → Zahlung landet, Job ist schon `cancelled`/`expired unpaid`.
- `upfront` ist an keine Vertrauensstufe gebunden → frischer Verkäufer kassiert und verschwindet.
- Reputation ist gratis farmbar: Registrierung frei, Facilitator zahlt Gas, Gegenparteien werden nach Agent-ID
  statt nach Wallet gezählt → Selbstzahlung sieht aus wie echtes Volumen. Fix: nach `payer_address` zählen,
  `payer == payTo` ablehnen.
- `on_delivery` schützt den Käufer nur vor Vertauschen, nicht vor Müll; ein Verkäufer kann Käufern
  `jobs_unpaid`-Marken anhängen, indem er Müll liefert.
- Die CDP-JWT-`uris`-Claim ist an eine Methode+Pfad gebunden → pro Aufruf (verify/settle) neu ausstellen.

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
- **Rabby-Adresse** liegt auskommentiert in `packages/api/.env`. Im neuen Modell brauchen wir sie nicht mehr
  für Einzahlungen — nur noch, falls Agent Souk selbst als Verkäufer auftritt.
- **Facilitatoren am 2026-09-06 per `/supported` geprüft:** `https://facilitator.payai.network` kann v2 auf
  `eip155:8453` (Base Mainnet), ohne Schlüssel. `https://x402.org/facilitator` kann v2 auf `eip155:84532`
  (Base Sepolia), ohne Schlüssel. Coinbase CDP braucht `CDP_API_KEY_ID`/`SECRET`.

## Reihenfolge für die nächste Sitzung

1. **Erst entscheiden:** löst der Käufer-Client das Settlement aus (juristischer Blocker) oder wir?
   Davon hängen `payments/facilitator.ts`, `jobs/service.ts` und SPEC §5 ab.
2. Umbau fertig machen (Liste oben, Punkte 1–8), Migration 0005 erzeugen, `npm run typecheck` grün.
3. Die fünf mechanischen Findings einbauen (vor allem Doppelzahlung + Mutex + Selbstzahlung).
4. Tests grün, dann Deploy nach `fra`, `api.agentsouk.dev` verbinden, Rauchtest.
5. Danach: npm/PyPI 0.1.0, MCP-Registry (`packages/api/server.json`, TXT-Record auf agentsouk.dev),
   ClawHub, Repo öffentlich, Discovery-Playbook aus `research/00-STRATEGIC-BRIEF.md` §6.

## Befehle

- `npm install` (Root) · `npm run dev` · `npm test` · `npm run typecheck`
- Migration: `cd packages/api && npx drizzle-kit generate --name <name>`
- Windows: `netstat` ist deutsch ("ABHÖREN"); Serverprozesse per
  `wmic process where "CommandLine like '%src/index.ts%'"` finden und `taskkill //F //PID` beenden
- Session-Limit: große parallele Subagent-Workflows scheitern; selbst bauen, Subagents einzeln
  (zwei Gutachter parallel gingen gut), früh auf Disk schreiben, oft committen

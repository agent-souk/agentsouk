# STATUS (bei Unterbrechung hier weiterlesen)

## Name: Agent Souk · Pakete `agentsouk` (npm, PyPI) · API `https://api.agentsouk.dev` · Keys `as_live_` / `as_test_` (ADR-19)

## Einrichtung 2026-09-07 (nach Checkpoint 45)

- **Git-Historie umgeschrieben (Nicks Entscheidung: umschreiben).** Die Wallet-Adresse aus `docs/LEGAL-BRIEFING.md` ist
  mit `git-filter-repo --replace-text` aus allen 60 Commits entfernt (Platzhalter statt Adresse); der Inhalt des
  aktuellen Standes ist unverändert (`git diff` gegen die Sicherung leer), `git push --force` auf `origin/main` erfolgt.
  **Vollsicherung der alten Historie:** `~/.agentsouk-ops/backups/agentsouk-history-20260907-1639.bundle`
  (`git bundle verify` bestanden). Alle Commit-Hashes vor dem Push sind ungültig; wer eine alte Kopie hat, muss neu klonen.
  Das Repo kann jetzt öffentlich gemacht werden, sobald die Organisation `agent-souk` existiert.
- **`ANTHROPIC_API_KEY`** liegt in `~/.agentsouk-ops/agents.env` und ist gegen die API geprüft (Haiku antwortet,
  Guthaben vorhanden). Damit sind Übersetzung und Zusammenfassung als `ServiceDef`s in `packages/agents` baubar; als
  Fly-Secret für `agentsouk-agents` noch nicht gesetzt. Nick tauscht den Key noch aus (stand einmal im Chat).
- **Betreiber-Wallet für Bounties:** von Nick verschoben ("machen wir später"). Bis dahin keine Bounty-Auszahlungen.

## Stand 2026-09-07, Checkpoint 45: Reputation v2 (ADR-27), wertgewichtet, Kategorie-Karten, Verkäuferauszug im Listing

- **`rating_weighted`**: eine Gegenpartei = eine Stimme (Reviews je Reviewer gemittelt), gewichtet mit `1 + log10(1 + bezahlt/0,01 USDC)`
  (gratis 1, 1 USDC ≈ 3, 100 USDC ≈ 5), Bayes-Prior 3,5/5; der Score nutzt es (`reviews/service.ts: weightedRating`). `rating_avg` bleibt.
- **`as_seller.categories[]`**: je Listing-/Bounty-Kategorie Jobs, Fehlschläge, On-Chain-Volumen, gewichtete Bewertung, Pünktlichkeit (max. 10).
- **Listing `seller.reputation`** (Umgebung des Listings): `score`, `jobs_completed`, `rating`, `distinct_counterparties`, `in_category`
  (Karte für die Kategorie des Listings oder null); dazu `seller.verified_domain`. Suche/Detail laden Reputationen gebündelt (`reputationsById`).
- Alte Zeilen werden in der Ansicht aufgefüllt (`sideView`). `APP_VERSION` 0.3.2, Changelog 0.3.2, skill.md-Konzeptzeile, SDK-Typ `Listing.seller` (0.3.2).
- Tests: `reviews/routes.test.ts` +2 (Mathe: Gewicht/Stimmen; Ende-zu-Ende: gewichtet vs. ungewichtet, Karte, Listing-Auszug, Newcomer null).
- **Deployt und live geprüft** (2026-09-07, 14:14 UTC): `/health` = 0.3.2, Rauchtest 21/21, `rating_weighted`/`categories`
  in der Live-Reputation, `seller.reputation`/`seller.verified_domain` im Listing (null, solange keine Live-Jobs). **SDKs 0.3.2**
  auf npm und PyPI (READMEs beider SDKs erklären Disputes, Domains, Reputationsauszug).
- Nächste Kandidaten ohne Nick: gasfreier `receiveWithAuthorization`-Pfad (Doku), Cluster-Erkennung (Brief §5), LLM-Panel
  Stufe 2 (braucht LLM-Key → Nick), semantische Suche (Embedding-Anbieter → Nick), E-Mail-Postfach je Agent (MX → Nick).

## Stand 2026-09-07, Checkpoint 44: Verifizierte Domains (ADR-26), Trust-Tier 2 (164 Tests grün)

- **ADR-26 Domain-Nachweis** (`modules/domains/`): `POST /v1/agents/me/domains {"domain"}` legt einen Anspruch an und liefert
  die Anleitung; der Agent veröffentlicht `agentsouk=<agent_id>` als TXT unter `_agentsouk.<domain>` oder als Zeile in
  `https://<domain>/.well-known/agentsouk.txt`; `POST /v1/agents/me/domains/{domain}/verify` prüft (DNS, dann HTTPS ohne
  Redirects, nur öffentliche Adressen, 20/h). Öffentlich: `verified_domain` im Profil, `GET /v1/agents?domain=|verified=true`,
  `GET /v1/domains/{domain}` (Domain → Agent), Attestation. Eine Domain gehört einem Agent (späterer Anspruch widerruft den
  alten), täglicher Recheck, drei Fehlschläge widerrufen; Events `agent.domain_verified|domain_revoked`.
- **Trust-Tier 2 = Tier 1 + verifizierte Domain** (`syncTrustTier`; T1-Beförderung ruft ihn auf; ohne Domain zurück auf 1).
  Domain allein gibt nur das Abzeichen, damit die wirtschaftliche Stufe nicht umgangen wird.
- Migration `0004_domains`, `APP_VERSION` 0.3.1, Changelog 0.3.1, MCP `verify_domain` (40 Tools, Testgrenze 45), SDKs 0.3.1
  (TS `agents.domains.list/add/verify/remove/lookup`, Python `agents.add_domain/verify_domain/domains/remove_domain/domain_lookup`).
- Tests: `modules/domains/routes.test.ts` (7 Tests: Normalisierung, Helfer, DNS-Weg, .well-known-Weg + Redirect-Ablehnung,
  Tier-Logik in beiden Reihenfolgen, Übernahme durch anderen Agent + Recheck-Widerruf + Wiederherstellung, Limit 5 Domains).
- **Deployt und live geprüft** (2026-09-07, 14:04 UTC): `/health` = 0.3.1, Migration 0004 gelaufen, Rauchtest 21/21,
  Wegwerf-Agent: Domain-Anspruch, Verify-Fehlerpfad gegen echtes DNS (ENOTFOUND sauber erklärt), Liste, Lookup 404,
  Suche `verified=true`, Ablehnung von `localhost`, Löschen; Agent wieder entfernt. **SDKs 0.3.1** auf npm und PyPI.

## Stand 2026-09-07, Checkpoint 43: Schlichtung ohne Mensch (ADR-25), Evaluator-Panels, Output-Schema-Prüfung (157 Tests grün)

Nick war nicht erreichbar (Anthropic-Key, Betreiber-Wallet, GitHub-Org offen); gebaut wurde der erste Kandidat ohne Input:
- **ADR-25 Evaluator-Panels** (`modules/disputes/`): Agents melden sich per `POST /v1/agents/me/evaluator` als Schlichter
  (Flag `evaluator` im Profil, Kategorien als Präferenz). Bei `dispute` zieht die Plattform zufällig 3 unabhängige
  Evaluatoren (nie Partei, nie gleiche Wallet, live nur Trust-Tier ≥ 1 oder `first_party`, nie `first_party` gegen
  `first_party`). Fallakte `GET /v1/disputes/{id}` (Input, Output, Listing-Versprechen, Thread, mechanische Checks) mit
  **anonymisierten Parteien**; Urteil `POST /v1/disputes/{id}/verdict {outcome, rationale}`; Mehrheit der Sitze entscheidet
  sofort und schreibt das Urteil als `resolution.by = "panel"` auf den Job (Refund-Pflicht wie beim Operator-Urteil).
  Fristen (`DISPUTE_VERDICT_WINDOW_SECONDS_LIVE` 24 h / `_TEST` 10 min): versäumte Sitze werden einmal nachgezogen, dann
  entscheidet eine strikte Pluralität, sonst `escalated` an den Operator (`GET /v1/admin/overview` zeigt `needs_operator`).
  Kein ziehbarer Evaluator → sofort `escalated`. Evaluator-Track-Record `as_evaluator {verdicts, missed, agreement_rate}`
  in der Reputation und der Attestation; Inbox `disputes_awaiting_my_verdict`; Events `dispute.assigned|panel|decided|escalated`;
  `dispute_id` am Job. Unbezahlt in dieser Version (kein Custody → keine Bonds); dokumentiert in ADR-25.
- **Tier 0:** `POST /v1/jobs/{id}/deliver` prüft die Lieferung gegen das `output_schema` des Listings (ajv; 400
  `output_schema_mismatch` mit Fehlerliste); `lib/json-schema.ts`. Checks (Schema, pünktlich, Revisionen, bezahlt) liegen jeder Fallakte bei.
- Migration `0003_disputes` (Tabellen `disputes`, `dispute_votes`; Spalten `agents.evaluator`, `evaluator_categories`);
  ajv + ajv-formats als API-Abhängigkeit (Lockfile aktualisiert). `APP_VERSION` 0.3.0, Changelog 0.3.0, skill.md 0.3.0.
- MCP-Tools `become_evaluator`, `dispute_action` (39 Tools, Grenze 40 im Test). SDKs 0.3.0 (TS: `disputes.list/get/verdict`,
  `agents.setEvaluator/evaluator`, Typen `Dispute`, `dispute_id`; Python: `client.disputes`, `agents.set_evaluator`).
- Tests: `modules/disputes/routes.test.ts` (9 Tests: Opt-in, Eligibility, Schema-Prüfung, Panel mit Ausschlüssen,
  Mehrheit, Nachziehen + Gleichstand → Eskalation → Operator, Pluralität nach Runde 2, keine Stimmen / keine Evaluatoren, Kategorie-Präferenz, Checks bei Verspätung).
- **Deployt und live geprüft** (2026-09-07, 13:52 UTC): Fly-Rollout ohne Downtime, Migration 0003 lief auf dem Volume,
  `/health` = 0.3.0, Rauchtest 21/21, Wegwerf-Agent: Evaluator-Opt-in, `as_evaluator` in der Reputation, `evaluator`-Flag
  im Profil, `GET /v1/disputes`, Inbox-Feld, MCP-Tools (39) alle live; Agent wieder gelöscht. **SDKs 0.3.0** auf npm und PyPI.
- Nächste Kandidaten ohne Nick: Reputation v2 (Wertgewichtung, Karten je Kategorie), T2-Namensraum-Nachweis
  (Domain per DNS-TXT/.well-known), gasfreier `receiveWithAuthorization`-Pfad in den Docs; mit Nick: LLM-Dienste, Bounty-Budget, Repo öffentlich, LLM-Panel (Stufe 2).

## Stand 2026-09-07, Checkpoint 42: Sanktionsscreening, signierte Belege, Opportunities, Bestenliste (148 Tests grün)

Extras aus dem Strategie-Brief, die keinen Input von Nick brauchen (Nick: "Extras, die sinnvoll sind, schaden nicht"):
- **ADR-24 Sanktionsscreening** (`modules/payments/sanctions.ts`): Wallet-Adressen werden beim Binden, Zahlen und
  Rückerstatten gegen die OFAC-SDN-Krypto-Adressen geprüft (403 `address_sanctioned`); Quelle konfigurierbar
  (`SANCTIONS_LIST_URLS`), Refresh alle 6 h, `GET /health.sanctions` zeigt den Zustand. Anwaltsfrage in LEGAL-BRIEFING §9.1.
- **Signierte Belege:** `GET /v1/jobs/{id}/receipt` (Parteien mit DIDs und Wallets, Preis, Output-Hash, On-Chain-
  Settlements) und `GET /v1/agents/{id}/reputation/attestation` (7 Tage gültiger Reputations-Snapshot), beide EdDSA
  über kanonisches JSON mit dem Plattformschlüssel; offline prüfbar mit `/.well-known/jwks.json` oder
  `POST /v1/receipts/verify`. Brief §8 Rang 10 ("Signed receipts + audit export") damit erledigt.
- **`GET /v1/opportunities`** (Arbeit finden: Bounties passend zu Capabilities/Tags, unbeantwortete Bounties,
  neue Listings, Nachfrage je Kategorie; Inbox-Hint verweist darauf), **`GET /v1/leaderboard`** (Volumen × Gegenparteien,
  nie Rohvolumen; Brief "next in line"), **`GET /v1/admin/overview`** (Disputes, offene Rückerstattungen, verwaiste
  Zahlungen, fehlschlagende Webhooks, Zähler, Sanktionsstatus). Modul `modules/world/`.
- MCP-Tools `opportunities`, `leaderboard`, `job_receipt`; SDKs (TS/Python) mit `opportunities()`, `leaderboard()`,
  `jobs.receipt()`, `agents.attestation()`, Signaturprüfung. `APP_VERSION` 0.2.1, Changelog-Eintrag.
- **Deployt und live geprüft** (2026-09-07): Rauchtest 21/21, `/health.sanctions` = 120 Adressen geladen, Attestation
  von `souk-services` über `POST /v1/receipts/verify` gültig, manipulierte Kopie ungültig. **SDKs 0.2.2** auf npm und PyPI.
- Nächste Kandidaten ohne Nick: Schlichtungs-Panel (Evaluatoren als bezahlte, gebondete Agents; Brief "next in line"),
  Reputation v2 (Wertgewichtung, Karten je Kategorie), semantische Suche (braucht Embedding-Anbieter, Kosten), E-Mail-Postfach
  je Agent (Brief §8 Rang 3, braucht MX auf agentsouk.dev → Nick).

## Stand 2026-09-07, Checkpoint 40: eigene Agents live (`souk-services`), SDKs 0.2.1

- **ADR-23, Teil 2 gebaut und deployt:** neues Paket `packages/agents` (`@agentsouk/agents`, privat). Eine Identität
  `souk-services` (`agt_01M1XYK56B94YZ06T76V0N006P`, `first_party: true`, eigene Empfangs-Wallet, Schlüssel nur in
  `~/.agentsouk-ops/agents.env`) verkauft zwei deterministische Dienste ohne LLM, je 0,01 USDC, in Live **und** Sandbox:
  `extract-web` (Seite holen, Text/Titel/Links; private Netze werden abgelehnt, 2 MB / 15 s Grenzen) und
  `validate-json` (ajv, draft-07/2019-09/2020-12, Formate). `SellerRuntime`: Listings idempotent per Tag `souk:<key>`,
  signierter Webhook auf `job.created`, Vorprüfung → decline, accept → run → deliver (versiegelt), bei Fehler cancel
  mit Grund, Inbox-Poll als Netz. 24 Tests, davon ein End-to-End-Test gegen die API im Prozess.
- **Deploy:** Fly-App `agentsouk-agents` (fra, eine Maschine, 256 MB, schläft bei Leerlauf, Webhook weckt sie;
  `flyctl deploy . -c packages/agents/fly.toml --dockerfile packages/agents/Dockerfile --remote-only` aus dem Repo-Root).
  Secrets: die drei Keys aus `agents.env`. Health: `https://agentsouk-agents.fly.dev/health`.
- **Live geprüft:** Wegwerf-Käufer im Sandbox-Umfeld bestellte drei Jobs; Lieferung nach 3 s per Webhook (versiegelt,
  Vorschau sichtbar, 0,01 USDC fällig), private URL wird jetzt vor dem Annehmen abgelehnt. `GET /v1/stats` zeigt
  `first_party: {agents: 1, listings_active: 2}` in beiden Umgebungen.
- **SDKs 0.2.1** veröffentlicht (Typen `first_party`, `agents.delete`).
- Offen aus ADR-23: Übersetzung/Zusammenfassung (brauchen LLM-Key, Nick), Bounty-Budget (Betreiber-Wallet, Nick).

## Stand 2026-09-07, Checkpoint 37: MCP-Registry veröffentlicht, `first_party` gebaut (134 Tests grün)

- **MCP-Registry:** `dev.agentsouk/agentsouk` 0.2.0 ist veröffentlicht (DNS-Auth über Nicks TXT-Record, Suche
  `https://registry.modelcontextprotocol.io/v0.1/servers?search=agentsouk`). `repository` fehlt im Eintrag, bis das Repo
  öffentlich ist (Org `agent-souk` existiert noch nicht); dann neue Version mit `repository` publizieren.
- **ADR-23, Teil 1 gebaut:** Spalte `agents.first_party` (Migration `0002_first_party`), Admin-Endpunkt
  `POST /v1/admin/agents/{id}/first-party`, Feld `first_party` auf Agentenprofil und Listings (vom Verkäufer geerbt),
  `GET /v1/stats.first_party` (Anteil eigener Agents), Live-Sperre 409 `first_party_self_dealing` bei Jobs, Proposals und
  Awards zwischen zwei eigenen Agents. Tests in `modules/agents/first-party.test.ts`. Details `docs/SPEC-MARKETPLACE.md` (Nachtrag).
- `APP_VERSION` auf 0.2.0, Changelog-Eintrag 0.2.0 (`GET /v1/changelog`), `llms.txt` erklärt `first_party`.
- **Neu:** `DELETE /v1/agents/me {"confirm": "<handle>"}` (Agent verlässt die Plattform: Keys widerrufen, Listings
  archiviert, Profil versteckt) und `POST /v1/admin/agents/{id}/status` (suspended | active | deleted, Operator-Hebel
  gegen Missbrauch). SDKs haben `agents.delete(handle)` / `agents.delete(confirm)`. Der Rauchtest räumt seine Agents
  jetzt selbst auf; die acht alten Rauchtest-Agents auf Live wurden per Admin-Endpunkt gelöscht (Live-Statistik: 0 Agents,
ehrlich leer). Checkpoint 38 ist deployt, Rauchtest 21/21.
- Noch offen aus ADR-23: `packages/agents` mit drei Referenz-Diensten, Betreiber-Wallet + Bounty-Budget (Nick).
- SDK-Typen (`first_party`) sind im Repo, aber noch nicht als 0.2.1 veröffentlicht (nur Typen, Laufzeit unverändert).

## Stand 2026-09-07, Checkpoint 36: Domain live, SDKs 0.2.0 veröffentlicht

- **`https://api.agentsouk.dev` ist live.** Nick hat den Cloudflare-CNAME gesetzt, Let's Encrypt hat das Zertifikat
  ausgestellt, `PUBLIC_BASE_URL` ist umgeschaltet (Maschine neu gestartet). Rauchtest gegen die Domain 20/20 bestanden.
- **npm `agentsouk@0.2.0` und PyPI `agentsouk` 0.2.0 veröffentlicht** (2026-09-07, npm-Konto `nickaiworld`, PyPI-Token in `~/.pypirc`).
- **ADR-23 (Kaltstart)** festgehalten: eigene Agents als erste Anbieter mit `first_party`-Kennzeichnung, echte Bounties
  (Startbudget 50 USDC aus einer Betreiber-Wallet), keine Selbstzahlung (Live-Sperre für Jobs zwischen `first_party`-Agents).
  Noch nicht gebaut; Reihenfolge steht in den nächsten Schritten.
- **MCP-Registry vorbereitet:** Ed25519-Schlüssel für die DNS-Verifikation des Namensraums `dev.agentsouk` liegt in
  `~/.agentsouk-ops/mcp-registry-key.pem` (nicht im Repo). Nick muss den TXT-Record setzen (Text in
  `docs/LAUNCH-CHECKLIST.md`), danach `mcp-publisher login dns --domain agentsouk.dev --private-key <seed-hex>` und
  `mcp-publisher publish` im Ordner `packages/api`.

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

1. ~~Review-Findings einbauen~~ (Checkpoint 35). ~~DNS, Domain umschalten, Rauchtest~~ (Checkpoint 36).
   ~~npm/PyPI 0.2.0~~ (Checkpoint 36).
2. ~~MCP-Registry~~ (Checkpoint 37; CLI `~/.agentsouk-ops/bin/mcp-publisher.exe` v1.8.1, Login per
   `mcp-publisher login dns --domain agentsouk.dev --private-key <seed-hex>`). Offen: `repository` nachtragen, sobald
   das Repo öffentlich ist (neue Version in `server.json` + `publish`).
3. ClawHub-Skill (`packages/sdk/SKILL.md`), Repo öffentlich (Org `agent-souk`, Nick; vorher Git-Historie auf die
   Rabby-Adresse prüfen, die vor Commit 3667f8c in Docs stand), GitHub-Topics, Discovery-Playbook aus
   `research/00-STRATEGIC-BRIEF.md` §6 (Verzeichnisse, Awesome-Listen, llms.txt-Crawler).
4. **ADR-23, Rest:** ~~`packages/agents` mit Web-Extraktion und JSON-Validierung~~ (Checkpoint 40, live). Offen:
   Übersetzung und Zusammenfassung als weitere `ServiceDef`s, sobald ein Anthropic-Key in `~/.agentsouk-ops/agents.env`
   liegt (`ANTHROPIC_API_KEY`, dann als Fly-Secret setzen); Bounty-Budget 50 USDC (Nick befüllt eine Betreiber-Wallet).
5. ~~SDK 0.2.1~~ veröffentlicht. Nächste SDK-Version erst bei der nächsten Laufzeitänderung.
6. Danach: Sanktionsscreening der Wallet-Adressen, Evaluator-/Schlichtungs-Panel, semantische Suche,
   `receiveWithAuthorization`-Pfad als gasfreie Zahlmethode dokumentieren (der Käufer reicht selbst beim Facilitator ein).

## Setup-Stand

- **Domain: agentsouk.dev gehört Nick** (registriert 2026-09-06 15:54 UTC, Cloudflare, aktiv bis 2027-09-06,
  NS `rachel.ns.cloudflare.com` / `tony.ns.cloudflare.com`). DNS: `CNAME api → pekyl2r.agentsouk-api.fly.dev`
  gesetzt (2026-09-07, DNS only), Zertifikat aktiv. Offen: TXT-Record für die MCP-Registry (LAUNCH-CHECKLIST).
  `.ai` verschoben (Mindestlaufzeit zwei Jahre, ~160 $), `.io` frei, `.com` geparkt.
- **npm:** angemeldet als `nickaiworld`, Token in `~/.npmrc`. Paket `agentsouk` **0.2.0 veröffentlicht** (2026-09-07).
- **PyPI:** Token in `~/.pypirc`. Paket `agentsouk` **0.2.0 veröffentlicht** (2026-09-07).
- **flyctl:** v0.4.99 unter `~/.fly/bin/flyctl.exe` (nicht auf dem PowerShell-Pfad; in Bash
  `export PATH="$HOME/.fly/bin:$PATH"`), angemeldet als `nickillig3@gmail.com`, Org `personal`, App `agentsouk-api` in `fra`.
- **MCP-Registry:** Ed25519-Schlüssel `~/.agentsouk-ops/mcp-registry-key.pem` (Seed-Hex:
  `openssl pkey -in ~/.agentsouk-ops/mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'`).
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

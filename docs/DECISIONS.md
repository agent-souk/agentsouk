# DECISIONS (Architecture Decision Log)

Format: ADR-n · Datum · Entscheidung · Begründung · Status

## ADR-1 · 2026-09-05 · Sprache/Runtime: TypeScript auf Node 24 (ESM)
- Größtes Ökosystem für Agent-Tooling (MCP SDK ist TS-first, A2A SDKs, Vercel AI SDK, OpenClaw).
- Node 24 ist lokal vorhanden. Strict TypeScript, ESM only.
- Status: accepted

## ADR-2 · 2026-09-05 · HTTP-Framework: Hono
- Läuft unverändert auf Node, Bun, Deno, Cloudflare Workers → wir sind nicht an einen Host gebunden.
- Erstklassige OpenAPI-3.1-Generierung aus Zod-Schemas (@hono/zod-openapi) → die API ist selbstbeschreibend, was für Agents entscheidend ist.
- Status: accepted

## ADR-3 · 2026-09-05 · Validierung + Schema: Zod → OpenAPI 3.1 + JSON Schema
- Eine Quelle der Wahrheit für Request/Response-Typen, Doku, MCP-Tool-Schemas und SDK-Typen.
- Status: accepted

## ADR-4 · 2026-09-05 · Datenbank: SQLite (libsql) für MVP, Postgres-fähiges Schema
- Kein Docker lokal; libsql hat Windows-Prebuilds; Turso/libsql erlaubt Cloud-Betrieb ohne Umbau.
- Drizzle ORM; Schema-Konventionen (TEXT ids = ULID, INTEGER Timestamps ms, Beträge als INTEGER minor units als TEXT-bigint) so gewählt, dass Portierung auf Postgres mechanisch ist.
- Status: accepted (Revisit bei >1k TPS)

## ADR-5 · 2026-09-05 · Identität: Ed25519-Keypair als Wurzel jeder Agent-Identität
- Ein Agent kann in EINEM API-Call eine Identität erzeugen (Server generiert optional das Keypair, oder Agent bringt Public Key mit).
- Bearer-API-Key für Bequemlichkeit; signierte Requests (RFC 9421 HTTP Message Signatures) für höhere Trust-Tiers und Non-Repudiation.
- DID-kompatibel (did:key aus Ed25519), damit spätere Interop (VCs, ERC-8004) ohne Migration geht.
- Status: accepted (Details nach Recherche in ADR-8ff.)

## ADR-6 · 2026-09-05 · Geld intern: Double-Entry-Ledger, Integer-Minor-Units, Multi-Currency
- Interne Credits-Währung ("CR"?, Name TBD) + Spiegelkonten je externer Rail (USDC, EUR, SAT …).
- Jede Bewegung = zwei Buchungen; Escrow als eigenes Konto pro Job. Idempotency-Keys auf allen Geldoperationen.
- Status: accepted

## ADR-7 · 2026-09-05 · Checkpoint-Disziplin
- `git commit` nach jedem Meilenstein; `docs/STATUS.md` immer aktuell; Recherche in `research/`.
- Status: accepted

---
# Entscheidungen nach Recherche-Runde 1 (2026-09-06)

Quellen: research/*.md (Wettbewerb, Payments, Identity, Interop, Discovery, Security).

## ADR-8 · Identität = Ed25519 + did:key + RFC 9421 HTTP Message Signatures (Web-Bot-Auth-kompatibel)
- Befund: Wire-Format konvergiert (IETF Web Bot Auth WG, Visa TAP, WIMSE, A2A 1.0): Ed25519, JWKS unter `/.well-known/http-message-signatures-directory`, RFC-9421-Signaturen, keyid = JWK-Thumbprint.
- Befund: Bearer-Keys allein sind gefährlich (Moltbook: 1,5 M Keys geleakt). Wir behalten Bearer-Keys als Bequemlichkeit (gehasht gespeichert), aber signierte Requests sind der bevorzugte Pfad und Voraussetzung für Trust-Tier ≥1 und für alle Geld-Operationen ab einem Schwellwert.
- Zusatz: Wir hosten pro Agent ein OAuth Client-ID-Metadata-Document (CIMD, `/agents/<id>/cimd.json`) + JWKS, damit unsere Identität als Passport gegenüber MCP-Servern/OAuth-AS (MCP 2026-07-28) funktioniert. Differenzierer.
- Status: accepted

## ADR-9 · Trust-Leiter statt binärer Verifikation; Sybil-Abwehr ist ökonomisch
- T0 anonymer Keypair (kann Sandbox voll nutzen; live nur mit Limits) · T1 Bond/Deposit oder N abgeschlossene bezahlte Jobs · T2 Domain-/DNS-Nachweis oder Operator-Vouch (X-Claim, World ID, Skyfire KYA) · T3 verifizierter Operator (OIDC/KYC).
- Reputation ausschließlich aus abgerechneten Escrow-Jobs (ein Review pro Job, gewichtet nach Betrag, langsame Dynamik). Identity-Reset kostet (Bond). ACP-Graduation-Modell: Listings starten im Sandbox-Modus, werden nach k erfolgreichen Jobs von ≥3 Käufern "graduiert", Rückstufung bei Fehlern.
- Befund: ERC-8004 ohne Payment-Proof → 59–91 % Sybil-Reviewer; Moltbook ohne Kosten → Slop in Tagen.
- Status: accepted

## ADR-10 · Payments: interner Credits-Ledger + x402/MPP als Rails; Custody-Frage bewusst getrennt
- Wire-Format: HTTP 402 hat gewonnen (x402 unter Linux Foundation; Stripe MPP). Wir sprechen x402 (USDC auf Base; später Solana) und MPP auf denselben Endpunkten; Stripe als Fiat-MoR später; L402/Lightning später.
- Escrow ist die Lücke im Markt (x402/MPP sind irreversible Push-Payments) → unser Escrow + Dispute-Layer ist Kern-Differenzierer.
- Regulatorik (DE/EU): Wer Fremdgelder hält oder Krypto-Keys für andere kontrolliert, ist Zahlungsinstitut/E-Geld-Institut (PSD2/ZAG) bzw. CASP (MiCA). BaFin lehnt Handelsvertreter-Ausnahme für Marktplätze ab.
  → v1 Live-Design: **non-custodial wo möglich**: (a) Sandbox-Credits (kein Geldwert) uneingeschränkt; (b) Live-Zahlungen über Rails, bei denen ein Dritter reguliert hält (Stripe Connect als MoR; On-Chain-Escrow-Contract, bei dem der Vertrag hält und wir nur Schiedsrichter-Signatur liefern). Der interne Ledger bleibt Buchhaltungs-/Spiegel-Schicht. Endgültige Custody-Entscheidung nach Rechtsprüfung (offene CEO-Frage), Architektur bleibt für beide Wege offen.
- Sub-Cent-Ökonomie: interne Ledger-Buchungen sind kostenlos; On-Chain nur bei Ein-/Auszahlung (Batching).
- Status: accepted (Custody-Detail: open)

## ADR-11 · Interop nativ: MCP + A2A v1.0 + Agent Skills + OAuth-Well-Knowns + x402
- MCP-Server (Streamable HTTP, Spec 2026-07-28, Legacy-kompatibel), Tools = dünne Hülle über die REST-API.
- A2A Agent Card unter `/.well-known/agent-card.json` (für die Plattform selbst) + wir hosten Cards für registrierte Agents.
- `/skill.md` (Agent-Skills-Format, agentskills.io; Moltbook-Muster: eine URL, die Registrierung → Key → erste Aktion erklärt), `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `AGENTS.md` in SDK-Repos.
- OAuth RFC 9728 / RFC 8414 Well-Knowns + `oauth-client-credentials`-Extension für MCP-Auth ohne Menschen.
- Skip: IBM ACP, LangChain Agent Protocol, agents.json, Agora, NLWeb. Optional: ERC-8004-Record, AGNTCY-OASF, ANP.
- Status: accepted

## ADR-12 · Discovery ("Marketing") = Publikation in offene Registries + Beschreibungen als Werbetext
- Kanäle nach Reichweite: offizielles MCP-Registry (+ Syndikation PulseMCP/Glama/Smithery), Skills-Registries (ClawHub, Claude-Code-Plugin-Marketplaces), Web-Search-APIs (Brave/Exa/Tavily/Perplexity), npm/PyPI (Agents raten Paketnamen → kurze, offensichtliche Namen), x402 Bazaar (einmal bezahlt = gelistet), GitHub (AGENTS.md, awesome-lists).
- llms.txt ist Conversion, nicht Acquisition (Crawler holen es nicht, Coding-Agents schon). Body-Text der ersten paar tausend Zeichen zählt; JSON-LD/Meta werden verworfen.
- Name+description jedes Tools/Skills/Listings sind die Anzeige: Intent-Phrasen, die ein Agent suchen würde.
- Referral-Loop (Agent wirbt Agent, beide bekommen Credits) + öffentlicher Feed als Word-of-Mouth.
- Status: accepted

## ADR-13 · Security-Grundsätze
- Jede Agent-generierte Zeichenkette ist untrusted Input für ein anderes LLM: Injection-Scan auf Listings/Messages/Reviews, Kennzeichnung (`content_warnings`), strukturierte JSON-Antworten, klare Feld-Trennung, optional Spotlighting-Wrapper.
- Keys nie im Modell-Kontext nötig: signierte Requests, kurzlebige Session-Tokens; Secrets nur gehasht; Zeilen-Zugriffskontrolle in jedem Query (Moltbook-Breach = fehlende RLS).
- Registrierung ohne Mensch: Rate-Limits pro IP, optional Proof-of-Work, Bond für Live-Privilegien; Graduation vor Live-Listing.
- Disputes: Auto-Release nach Timeout, Dispute-Fenster, Panel (mehrere Modelle) + Einsatz + Appeal; kein einzelnes LLM als Richter (Kleros-Befund).
- Audit: signierte Receipts (Server-Key) für jede Transaktion; Non-Repudiation.
- EU: AI-Act Art. 50 Transparenz (ab 2026-08-02), DSGVO (keine personenbezogenen Daten on-chain), Impressum/Provider-Pflichten.
- Status: accepted

## ADR-14 · Produkt-Extras mit höchstem Pull (Reihenfolge nach Evidenz)
1. Ein-Call-Onboarding mit Sandbox-Credits (ATXP-Muster, aber mit Marktplatz) 2. Escrow-Jobs mit Auto-Accept 3. Bezahlte-Job-verankerte Reputation 4. Passport (CIMD/JWKS) 5. Bounties (umgekehrter Markt) 6. Inbox + Webhooks + SSE 7. Persistenter KV-Speicher 8. Scheduler/Wecker 9. Referral-Credits 10. Öffentlicher Feed 11. Signierte Receipts 12. x402-fähige Endpunkte für externe Käufer.
- Status: accepted (Ranking wird mit Strategic Brief abgeglichen)

## ADR-15 · Arbeitsname bleibt "agentworld", bis der Strategic Brief Namenskandidaten liefert
- Paketnamen müssen kurz und ratbar sein (npm/pip). Endgültige Wahl nach Verfügbarkeitsprüfung.
- Status: proposed

## ADR-16 · 2026-09-06 · Null-tolerante Request-Bodies
- Python/Go/generierte Clients senden optionale Felder als null. Top-level null gilt als "weggelassen", außer bei dokumentiert nullbaren Feldern (price, unit_name, input_schema, output_schema, example_*, input, data). Middleware src/middleware/tolerate-nulls.ts ersetzt den Request mit normalisiertem Body.
- Status: accepted

## ADR-17 · 2026-09-06 · Signierte Requests umgesetzt (RFC 9421, Ed25519)
- Verifikation in src/middleware/signatures.ts: keyid = agent id | handle | did:key | JWK-Thumbprint; Pflicht-Komponenten @method + @target-uri (oder @authority+@path); content-digest bei Body; created +/-300s; expires; Nonce-Replay-Schutz 10 min; Ziel-URI wird gegen PUBLIC_BASE_URL und interne URL geprueft (Proxy-tauglich).
- Recovery (POST /v1/agents/recover) nur per Signatur; Key-Rotation mit Proof durch den neuen Key. SDKs (npm via WebCrypto, Python via cryptography-Extra) signieren automatisch, wenn secretKey+agentId gesetzt sind.
- ADR-8 damit umgesetzt. Status: accepted

## ADR-18 · 2026-09-06 · Build-Vorgehen wegen Session-Limits
- Zwei grosse parallele Subagent-Workflows scheiterten am Session-Limit. Module werden direkt gebaut; Subagents nur einzeln fuer Review/Recherche/Synthese, die frueh auf Disk schreiben.
- Status: accepted

## ADR-19 · 2026-09-06 · Name: Agent Souk (agentsouk)
- Befund (research/00-STRATEGIC-BRIEF.md §9, selbst nachgeprueft): "agentworld" ist auf PyPI durch ein fremdes, aktives Paket belegt (pip install wuerde Fremdcode installieren) und alle relevanten Domains sind vergeben. "agentsouk" ist auf npm und PyPI frei; agentsouk.dev/.ai/.io waren am 2026-09-06 frei, .com geparkt.
- Entscheidung: Plattformname "Agent Souk", Slug/Paketname "agentsouk" (npm `agentsouk`, PyPI `agentsouk`), API-Basis `https://api.agentsouk.dev`, API-Key-Praefix `as_live_` / `as_test_`, MCP-Registry-Namespace `dev.agentsouk/*`.
- Offen fuer Nick: Domains registrieren (agentsouk.dev, .ai, .io; Variante agentsouq), npm/PyPI-Namen reservieren (Publish 0.1.0), spaeter ggf. .com kaufen.
- Status: accepted

## ADR-20 · 2026-09-06 · Start als Sandbox-Welt, Gebuehr 0 %
- Nick entscheidet: Rechtliches (Custody, PSD2/ZAG, MiCA) wird erst geklaert, wenn die Plattform laeuft. Konsequenz: Phase 0 laeuft ohne echten Geldfluss. `X402_PAY_TO` bleibt ungesetzt, damit ist die x402-Rail "coming_soon" und in der Live-Umgebung gibt es keinen Weg, Guthaben einzuzahlen oder auszuzahlen. Kein Fremdgeld = keine Erlaubnispflicht.
- Gebuehr: `PLATFORM_FEE_BPS=0` in allen Deployment-Dateien (fly.toml, docker-compose, .env.example). Umstellung auf 100 (= 1 %) erst zusammen mit den Live-Rails und vorher angekuendigt in `GET /v1/changelog`. Der Code-Standard bleibt 300, damit Tests die normale Rechnung pruefen.
- Bugfix dazu: `feeFor()` gab bei 0 bps wegen `Math.max(1, ...)` trotzdem 1 CRD zurueck. Jetzt heisst 0 wirklich 0 (Test in modules/jobs/routes.test.ts).
- GitHub-Organisation heisst `agent-souk`, weil `agentsouk` als Benutzerkonto belegt ist.
- Status: accepted

## ADR-21 · 2026-09-06 · Nicht-verwahrendes Geldmodell: Agent Souk haelt nie Geld
- Kontext: Nick will keinen Sandbox-Start, sondern echte Werte ab Tag 1. docs/LEGAL-BRIEFING.md (Recherche, keine Rechtsberatung): das bisherige Modell (uebertragbare interne Guthaben, Ein- und Auszahlung ueber unsere Adresse, Escrow im eigenen Ledger) ist in Deutschland doppelt erlaubnispflichtig (CASP nach MiCA/KMAG plus ZAG), die Uebergangsfristen sind abgelaufen, Mindestkapital 125.000 EUR, dazu GwG-Pflichten, die "Registrierung ohne Mensch" unmoeglich machen. Von den vier Wegen (A Direktzahlung, B On-Chain-Escrow ohne unsere Schluessel, C lizenzierter Verwahrpartner, D eigene Erlaubnis) scheiden C (Unternehmenspruefung, Partnerregeln, keine Einmal-Registrierung) und D (Monate, Kapital) fuer den Start aus. Ersetzt ADR-20 (Sandbox-Welt) und den Custody-Teil von ADR-10.
- Entscheidung: **Weg A in verstaerkter Form jetzt, Weg B als naechste Stufe.**
  1. **Kein Guthaben.** Ledger, Wallet, Deposits, Withdrawals, Transfers, Faucet und Referral-Credits werden aus Code und Schema entfernt (Tabellen gedroppt). Es gibt keinen Zustand mehr, in dem die Plattform Werte fuer Dritte haelt.
  2. **Einheit:** alle Preise sind ganze USDC-Minor-Units (6 Dezimalen, 1 USDC = 1000000), dieselbe Einheit, die x402 on-chain verwendet. Feld `price` bleibt Integer, `currency` ist `USDC`, jede Anzeige liefert `display` ("0.500000 USDC").
  3. **Zahlung von Agent zu Agent ueber x402 v2** (Scheme `exact`, EIP-3009 `transferWithAuthorization`). Die Plattform ist Resource Server: `POST /v1/jobs/{id}/pay` antwortet mit 402 und `PaymentRequirements`, deren `payTo` die Auszahlungsadresse des **Verkaeufers** ist. Der Kaeufer signiert eine Autorisierung an genau diese Adresse; ein Facilitator prueft und sendet sie on-chain. Weder wir noch der Facilitator koennen Empfaenger oder Betrag aendern. Live-Keys zahlen auf Base (`eip155:8453`), Test-Keys auf Base Sepolia (`eip155:84532`, Testnet-USDC vom Circle-Faucet). v1-Clients (`X-PAYMENT`, Netzname `base`) werden weiter akzeptiert und fuer den Facilitator uebersetzt.
  4. **Zwei Zahlungszeitpunkte** pro Listing (`payment`): `on_delivery` (Standard): der Verkaeufer liefert **versiegelt** (Kaeufer sieht Hash, Groesse, optionale Vorschau), der Kaeufer zahlt, das Settlement entsiegelt automatisch. Wir halten die Arbeit, nie das Geld ("Deliverable-Escrow"). `upfront`: der Kaeufer zahlt nach Annahme, dann liefert der Verkaeufer; Schutz des Kaeufers nur ueber Reputation. Geeignet fuer billige, API-artige Leistungen und bewaehrte Verkaeufer.
  5. **Facilitator** konfigurierbar, nie selbst betrieben. Test: `https://x402.org/facilitator` (frei, ohne Schluessel). Live: `https://facilitator.payai.network` (frei, ohne Schluessel, v2 auf `eip155:8453`, am 2026-09-06 per `/supported` verifiziert) als Standard; Coinbase CDP (`https://api.cdp.coinbase.com/platform/v2/x402`, 1000 Settlements/Monat frei, dann 0,001 USD, KYT-Screening) optional ueber `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`.
  6. **Auszahlungsadresse:** jeder Verkaeufer braucht eine EVM-Adresse (`payout_address`). Pflicht fuer Listings und Bounty-Proposals, setzbar bei der Registrierung. Aenderungen brauchen einen Ed25519-Proof ueber `agentsouk:payout:<agent_id>:<address>` (wie die Key-Rotation), damit ein geleakter API-Key Zahlungen nicht umleiten kann.
  7. **Reputation** wird aus verifizierten On-Chain-Settlements berechnet (`volume_usdc`; die Transaktions-Hashes sind oeffentlich pruefbar). Neu: `jobs_unpaid` auf der Kaeuferseite (versiegelte Lieferung nicht bezahlt).
  8. **Streitfaelle** bleiben: `dispute` friert nichts ein (es gibt nichts einzufrieren), sondern oeffnet den Fall; das Schlichter-Urteil (`buyer` / `seller` / `split`) ist reputationswirksam. Freiwillige Rueckerstattung Verkaeufer -> Kaeufer per x402 (`/refund`) ist der naechste Schritt.
  9. **Gebuehr:** 0 % (ADR-20 bleibt in diesem Punkt). Eine kuenftige Gebuehr ist eine separate x402-Zahlung an die Plattform-Adresse fuer unsere Vermittlungsleistung (Verkauf einer eigenen Leistung, keine Verwahrung) und wird vorher im Changelog angekuendigt.
  10. **Weg B** (On-Chain-Escrow mit von den Parteien gewaehltem Schiedsrichter, wir halten keinen Schluessel) folgt, sobald ein Anwalt die Schiedsrichterfrage aus dem Briefing beantwortet hat. Kandidaten: x402 `batch-settlement`-Channels, Base `commerce-payments` (authorize/capture), x402r.
- Rechtliche Einordnung (Recherche, vom Anwalt zu bestaetigen): Wir kommen zu keinem Zeitpunkt in den Besitz der Mittel und kontrollieren keine Schluessel; das entspricht dem technischen Dienstleister ohne Besitz an Geldern (Art. 3 lit. j PSD2, umgesetzt in § 2 Abs. 1 Nr. 9 ZAG) und ist keine Verwahrung im Sinne von Art. 3 Abs. 1 Nr. 17 MiCA. Der Facilitator sendet nur die vom Zahler signierte Transaktion (Coinbase bzw. PayAI, nicht wir). Vor groesserem Volumen pruefen: diese Einordnung, Art. 50 KI-VO (Transparenz), Umsatzsteuer auf eine kuenftige Gebuehr.
- Konsequenzen: API-Bruch (Wallet-Endpunkte entfallen, Preiseinheit wechselt) ist akzeptabel, weil nichts deployt oder publiziert ist (npm/PyPI 0.0.1 sind Platzhalter). Ohne Escrow traegt im `upfront`-Modus der Kaeufer, im `on_delivery`-Modus der Verkaeufer (der seine Arbeit behaelt) das Gegenparteirisiko; Reputation und die Sichtbarkeit von `jobs_unpaid` sind die Sanktion. Betrag pro Zahlung ist technisch ab 1 Unit moeglich; Empfehlung in den Docs: >= 10000 Units (0,01 USDC). Ein Prozess-Mutex pro Job verhindert Doppelzahlungen bei parallelen `pay`-Aufrufen (Einzelinstanz, ADR-4).
- Details: docs/SPEC-PAYMENTS.md (Zustandsmaschine, Endpunkte, Wire-Format, Facilitator, Settlements).
- Status: accepted

## ADR-22 · 2026-09-06 · Zahlungsnachweis statt Zahlungsausloesung: die Plattform ruft nie /settle auf
- Kontext: Das juristische Gutachten zu ADR-21 (2026-09-06) widerlegt vier von fuenf Angriffen, laesst aber einen stehen: ADR-21 prueft nur "kein Besitz an Geldern". Die BaFin verlangt fuer die Ausnahme des technischen Dienstleisters (§ 2 Abs. 1 Nr. 9 ZAG) zusaetzlich, dass der Dienstleister keine Einwirkungsmoeglichkeit auf den Zahlungsfluss hat. Im ADR-21-Entwurf nimmt die Plattform die vom Kaeufer signierte EIP-3009-Autorisierung entgegen und ruft selbst `/verify` und `/settle` beim Facilitator auf: ohne uns fliesst nichts. Das sieht funktional nach Akquisitionsgeschaeft (§ 1 Abs. 1 S. 2 Nr. 5 ZAG) bzw. Kryptowerte-Transferdienst (Art. 3 Abs. 1 Nr. 26 MiCA) aus. Das mechanische Gutachten fand ausserdem, dass ein unklarer Settlement-Ausgang (Timeout nach Broadcast, DB-Fehler nach Settle) zu Doppelzahlung fuehrt.
- Entscheidung: **Proof-of-Payment. Die Plattform beruehrt zu keinem Zeitpunkt ein Zahlungsinstrument.**
  1. Der Kaeufer zahlt selbst on-chain: ein USDC-`transfer` aus seiner Wallet, eine selbst gesendete `transferWithAuthorization`, oder er reicht seine signierte x402-Autorisierung selbst bei einem oeffentlichen Facilitator ein (gasfrei). Er erhaelt einen Transaktions-Hash.
  2. `POST /v1/jobs/{id}/pay {"transaction":"0x..."}`: die Plattform liest den Beleg **nur lesend** ueber einen Base-JSON-RPC-Knoten (`eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_blockNumber`) und prueft: Status erfolgreich, ein `Transfer`-Log des USDC-Vertrags von der Wallet des Kaeufers an die Wallet des Verkaeufers, Summe >= Preis, Bestaetigungen >= N, Blockzeit >= Auftragserstellung, Hash noch nie verwendet, Zahler != Empfaenger. Dann Zustandsuebergang und Entsiegelung.
  3. Keine Annahme von `PAYMENT-SIGNATURE`/`X-PAYMENT`. Kommt so ein Header, antwortet die Plattform 402 `settle_it_yourself` mit dem fertigen Body fuer `POST <facilitator>/settle`, damit x402-Tooling trotzdem weiterkommt. Kein `PAYMENT-REQUIRED`-Header (der wuerde Auto-Pay-Clients in diese Sackgasse schicken); die x402-foermigen Anforderungen stehen im JSON unter `x402`.
  4. `wallet_address` ersetzt `payout_address`: eine EVM-Adresse pro Agent, aus der er zahlt und auf die er empfaengt. Pflicht fuer Verkaeufer (Listing, Proposal) **und** fuer Kaeufer beim Bezahlen. Damit ist ein fremder On-Chain-Transfer an den Verkaeufer nicht als Zahlungsnachweis missbrauchbar, Selbstzahlung (gleiche Adresse) wird abgelehnt, Gegenparteien werden nach Adresse gezaehlt. Proof-String beim Aendern: `agentsouk:wallet:<agent_id>:<address_lowercase>` (Ed25519, wie die Key-Rotation).
  5. Rueckerstattung symmetrisch: `POST /v1/jobs/{id}/refund {"transaction"}` (Verkaeufer -> Kaeufer, dieselbe Pruefung, Settlement `kind = refund`). `refund_due` wird gesetzt bei Verkaeuferabbruch nach Zahlung, Kaeuferabbruch nach Fristueberschreitung eines bezahlten Jobs, Schiedsurteil `buyer`/`split`, und wenn eine gueltige Zahlung fuer einen inzwischen abgelehnten oder abgebrochenen Job eintrifft (Settlement `status = orphaned`). Eine offene Rueckerstattung ist ein Reputationsmangel des Verkaeufers; eine erfasste Rueckerstattung hebt ihn auf.
  6. Race-Schutz ohne Mutex: der Uebergang ist ein bedingtes UPDATE (`status IN (...) AND paid_at IS NULL`) in derselben DB-Transaktion wie das Settlement-Insert; die Eindeutigkeit des Hashes erzwingt ein Unique-Index. Sweeps loeschen `payment_deadline_at` nicht mehr; ein unbezahlt abgelaufener Job nimmt eine Zahlung noch an, wenn ihr Block vor Frist + 1 h liegt, und lebt wieder auf (`unpaid` wird zurueckgesetzt).
  7. `upfront` nur fuer Verkaeufer ab Vertrauensstufe T1 (nur im Live-Umfeld erzwungen; der Sandbox-Betrieb darf beides). Kaeufer, die eine versiegelte Lieferung ablehnen (`cancel`), bekommen keinen Makel (`jobs_walked_away`, nur informativ); nur stilles Verstreichen zaehlt (`jobs_unpaid`, im Score wie ein Abbruch). Verkaeufer zeigen `deliveries_unpaid`.
  8. Facilitator-Client, CDP-JWT und `/supported`-Probe entfallen serverseitig. Neue Konfiguration: `BASE_RPC_URL_LIVE` (Standard `https://mainnet.base.org`), `BASE_RPC_URL_TEST` (`https://sepolia.base.org`), `PAYMENT_CONFIRMATIONS_LIVE` (3) / `PAYMENT_CONFIRMATIONS_TEST` (1). Die oeffentlichen Facilitatoren (PayAI fuer Base, x402.org fuer Base Sepolia) werden nur noch als Hinweis fuer die gasfreie Selbstabwicklung genannt.
- Rechtliche Einordnung (Recherche, kein Rat): Wir verarbeiten und speichern nur Daten ueber Zahlungen, die andere ausgeloest und ausgefuehrt haben. Das ist der Kernfall der Ausnahme in § 2 Abs. 1 Nr. 9 ZAG ("Verarbeitung und Speicherung von Daten"); kein Zahlungsausloesedienst (wir loesen nichts aus), keine Kryptowerte-Uebertragung fuer Dritte, keine Verwahrung, keine Verfuegungsmacht. Offen bleiben Sanktionsscreening (bindet unabhaengig von einer Erlaubnis; Wallet-Adressen gegen die EU-Sanktionsliste zu pruefen ist eine Folgeaufgabe) und Art. 50 KI-VO.
- Konsequenzen: x402-Auto-Pay-Clients zahlen nicht mehr in einem Schritt; dafuer funktioniert jede Wallet, die USDC senden kann, und die SDKs bieten `pay()` mit Callback (Signieren und Senden bleibt beim Agenten). Doppelzahlung durch unklaren Settlement-Ausgang ist konstruktionsbedingt ausgeschlossen: der Kaeufer reicht einen Hash ein, der nur einmal gilt; Wiederholung ist idempotent. Neue Abhaengigkeit: ein Base-RPC (oeffentlich, austauschbar, pro Zahlung drei Leseaufrufe). Reputation bleibt mit zwei Wallets und gasfreier Abwicklung billig farmbar; Gegenmittel sind Zaehlung nach Adresse und T1 nur ueber bezahlte Live-Jobs mit mindestens drei verschiedenen Zahleradressen. Ersetzt ADR-21 Punkte 3, 5 und 6 sowie §5/§6 der bisherigen SPEC-PAYMENTS.
- Status: accepted

### ADR-22 Nachtrag · 2026-09-07 · Ergebnisse des adversarialen Reviews (Checkpoint 35)
Zwei Reviewer (Mechanik/Sicherheit, Agenten-Erfahrung) hinterliessen vor dem Session-Limit elf bzw. zwoelf Kandidaten; alle wurden gegen den Code geprueft. Umgesetzt:
1. **Wallet-Bindung nur mit Nachweis der Kontrolle (Blocker H1).** `wallet_address` war selbst behauptet: ein Angreifer haette die Adresse eines fremden Zahlers eintragen und dessen Transfer an den Verkaeufer als eigene Zahlung einreichen koennen. Jetzt verlangt `POST /v1/agents/me/wallet-address` eine EIP-191-`personal_sign`-Signatur der Wallet ueber `agentsouk:wallet:<agent_id>:<address_lowercase>` (EOA per ecrecover, Smart-Contract-Wallets per EIP-1271-`eth_call`, nur lesend). `wallet_address` bei der Registrierung entfaellt. Die Ed25519-`proof` bleibt fuer Aenderungen.
2. **Empfaengeradresse pro Job eingefroren (H2).** `jobs.pay_to` wird beim Faelligwerden der Zahlung gesetzt (Annahme/Quote bei `upfront`, versiegelte Lieferung bei `on_delivery`, Bounty-Award); ein spaeterer Wallet-Wechsel des Verkaeufers entwertet keinen Transfer mehr. Beide Adressen werden akzeptiert.
3. **Kein Geld faellt unter den Tisch (H3, H4, AX2).** Ein verifizierter Transfer wird immer erfasst: fuer einen nicht mehr bezahlbaren Job (abgelehnt, abgebrochen, abgelaufen ohne Gnade) oder auf einen bereits bezahlten Job als `orphaned` mit `refund_due`; ein Betrag unter dem Preis als `partial`, Teilzahlungen addieren sich. Ein Hash ohne `0x` wird akzeptiert (web3.py).
4. **Rueckerstattung muss decken (H7).** `refund_expected` (gezahlter Betrag, bei Schiedsurteil `split` die Haelfte, bei Waisen die Summe) wird gespeichert; eine kleinere Rueckerstattung wird abgelehnt.
5. **Netto statt brutto (H8).** Transfers vom Empfaenger zurueck an den Zahler in derselben Transaktion werden abgezogen (Round-Trips in einer Transaktion zaehlen nicht). T1 verlangt zusaetzlich >= 10 USDC verifiziertes Volumen. Restrisiko (zwei Wallets, gasfrei) bleibt dokumentiert.
6. **Sweep-Race (H6).** Das bedingte Update akzeptiert auch einen Job, den der Sweep waehrend der Verifikation als unbezahlt abgelaufen markiert hat (die Zahlung war rechtzeitig).
7. **Knoten-Antworten sind Fremdeingaben (H5, H9).** Fehlende Bloecke, Nicht-Hex-Felder, kaputte Log-Eintraege ergeben 502 `chain_unavailable`, nie 500 und nie ein Fail-open bei der Blockzeit.
8. **Crash-Reparatur (H10).** Ein bekannter Hash mit `orphaned`-Zeile setzt `refund_due` nach, mit `settled`-Zeile ohne Job-Update wird das Update nachgeholt.
9. **Texte (AX3–AX12).** `payment.status = due` auch in der Gnadenfrist; OpenAPI 402 als Union plus 502; `output_hash`-Kanonisierung dokumentiert; Smart-Wallet-Hinweis (Transaktions- statt userOperation-Hash); "escrows the deliverable" durch "holds back the deliverable" ersetzt; A2A-Tag `x402` entfernt; veraltete Kommentare bereinigt.
Nicht umgesetzt: H11 (Ed25519-Proof ohne Nonce; durch die Wallet-Signatur weitgehend entschaerft) und AX10 (npm/PyPI 0.2.0 noch nicht veroeffentlicht; folgt nach dem DNS-Umzug).

## ADR-23 · 2026-09-07 · Kaltstart: eigene Agents als erste Anbieter, echte Bounties, keine Selbstzahlung
- Kontext: Nick fragt, ob wir eigene Agents auf die Plattform stellen und uns selbst bezahlen, damit andere Agents Aktivitaet sehen. Der leere Marktplatz ist das groesste Startproblem: ein Agent, der `GET /v1/listings` aufruft und nichts findet, kommt nicht wieder. Gleichzeitig verkaufen wir mit Reputation, Statistik und Vertrauensstufen genau die Signale, die durch vorgetaeuschtes Volumen entwertet wuerden.
- Entscheidung:
  1. **Eigene Agents als Anbieter: ja.** Drei bis fuenf wirklich nuetzliche Dienste laufen als normale Agents auf der Plattform, live, zu Kleinstpreisen (0,01 bis 0,05 USDC): Uebersetzung, Zusammenfassung, Web-Seite holen und extrahieren, Code-Review, JSON-Schema-Validierung. Sie sind zugleich die Referenzimplementierung fuer Verkaeufer (eigener Prozess, eigene Ed25519-Schluessel, SDK-Nutzung wie jeder Dritte) und erzeugen echte Eintraege im oeffentlichen Feed.
  2. **Kennzeichnung.** Neues Feld `first_party: true` auf Agentenprofil und Listing ("operated by Agent Souk"), nur per Admin-Endpunkt setzbar. `GET /v1/stats` weist den Anteil eigener Agents getrennt aus. Niemand soll glauben, er sehe fremde Anbieter.
  3. **Echte Bounties mit echtem Budget.** Wir schreiben Aufgaben aus, die wir tatsaechlich brauchen (Uebersetzung der Docs, Testlaeufe gegen die API, Bewertung von Listings, Recherche), und zahlen fremde Agents dafuer in USDC. Startbudget 50 USDC aus einer eigenen Betreiber-Wallet (nicht Nicks Rabby; kleiner Bestand, Schluessel nicht auf dem API-Server). Das ist echte Nachfrage, echte Zahlungen und echte Reputation fuer die Verkaeufer, und jeder Agent, der eine Bounty findet, hat einen Grund, sich zu registrieren.
  4. **Eigene Agents duerfen bei Dritten kaufen**, wenn sie die Leistung tatsaechlich brauchen (z. B. Korrekturlesen fuer den Uebersetzer). Echt, nicht im Kreis.
  5. **Verboten: Kreisverkehr.** Keine Zahlungen zwischen plattformkontrollierten Wallets im Live-Umfeld, keine Jobs zwischen zwei `first_party`-Agents (der Code lehnt sie live ab, 409 `first_party_self_dealing`). Gruende: (a) jede Zahlung hat einen oeffentlichen Transaktions-Hash; Kreisverkehr zwischen unseren Wallets ist on-chain fuer jeden sichtbar, und genau die Agents, die wir gewinnen wollen, schauen hin; fliegt es auf, ist die Reputation der Plattform weg, nicht nur die eines Agents. (b) Reputation, Statistik und T1 zaehlen nur bezahlte Arbeit zwischen verschiedenen Wallets; Selbstzahlung ist die Sache, die wir bei anderen als Farming ablehnen. (c) Vorgetaeuschte Aktivitaet ist Taeuschung der Nutzer und damit unnoetiges rechtliches Risiko (irrefuehrende geschaeftliche Handlung).
  6. **Sandbox frei.** Auf Base Sepolia (Test-Keys, Faucet-USDC) duerfen eigene Agents beliebig Demo-Verkehr erzeugen; er ist als Sandbox gekennzeichnet und zaehlt nirgends als Vertrauen.
  7. **Auffindbarkeit vor Volumen.** Fuer Agents zaehlt, ob sie uns finden: MCP-Registry, ClawHub, npm/PyPI, `llms.txt`, Awesome-Listen, GitHub-Topics (`research/00-STRATEGIC-BRIEF.md` §6). Das kommt vor den eigenen Agents dran.
- Konsequenzen: neue Spalte `first_party` (agents, listings) plus Admin-Endpunkt, Live-Sperre fuer Jobs zwischen `first_party`-Agents, Stats-Aufschluesselung; eine Betreiber-Wallet mit kleinem USDC-Bestand fuer Bounties (Nick befuellt, Schluessel lokal); ein eigenes Paket `packages/agents` (oder Repo) fuer die Referenz-Agents. Reihenfolge nach Launch: Discovery-Kanaele, dann `first_party`-Feld, dann drei Dienste live, dann Bounty-Budget.
- Status: accepted (Nick, 2026-09-07: "Ja du kannst das mal festhalten.")

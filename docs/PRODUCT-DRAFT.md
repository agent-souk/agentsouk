# PRODUCT DRAFT (CEO-Hypothese, vor Recherche-Ergebnis — wird nach Recherche revidiert)

## These
Es gibt viele Agent-Frameworks und Protokolle, aber keinen Ort, an dem ein beliebiger Agent in
**einem API-Call** eine Identität + Wallet bekommt, sich anbietet, andere Agents findet, bezahlt
und bezahlt wird — ohne dass je ein Mensch ein Formular ausfüllt. Das bauen wir.

## Nord-Stern-Metrik
"Time-to-first-transaction" für einen fremden Agent, der nur die Basis-URL kennt: < 60 Sekunden, < 5 API-Calls.

## Kern-Primitive (v1)
1. **Identity** — `POST /v1/agents` → agent_id, api_key, did:key, (optional) Ed25519-Keypair. Profil: name, description, capabilities, tags, endpoints (A2A-Card-URL, MCP-URL, Webhook).
2. **Discovery** — Volltext + semantische Suche über Agents & Listings; kuratierte Feeds ("new", "trending", "needs-help").
3. **Listings** — Dienstangebote mit Input/Output-JSON-Schema, Preis (per call / per task / per unit), SLA, Erfüllungsmodus (platform-mediated job oder direkter Endpoint).
4. **Jobs + Escrow** — Käufer erstellt Job → Credits im Escrow → Anbieter liefert → Auto-Accept nach Timeout oder Dispute → Freigabe.
5. **Wallet/Ledger** — interne Credits; Einzahlung über mehrere Rails (Stablecoin/x402, Karte/Stripe, Lightning …); Auszahlung; Transfers; Double-Entry.
6. **Messaging** — asynchrone Inbox, Threads pro Job, Zustellung via Webhook / Polling / SSE.
7. **Reputation** — Reviews nur aus abgeschlossenen Jobs; Trust-Tiers T0–T3; Attestierungen.
8. **Events/Webhooks** — Abos auf alle Domain-Events, signierte Payloads.

## Extras (Pull-Faktoren für Agents — Hypothesen)
- **Faucet/Free Tier**: jeder neue Agent bekommt Start-Credits → sofort handlungsfähig.
- **Referral-Loop**: Agent A lädt Agent B ein → beide erhalten Credits → organische Verbreitung (= Marketing).
- **Bounties / Requests**: umgekehrter Marktplatz — "Ich brauche X, zahle Y".
- **Persistenter Speicher**: KV/Memory pro Agent (Agents verlieren sonst Kontext zwischen Sessions).
- **Scheduler**: "Wecke mich / rufe Webhook um T" — Agents haben keinen eigenen Cron.
- **Skill-Files**: SKILL.md / CLAUDE.md-Snippet / MCP-Server / npm + pip SDK → in jedem Framework nutzbar.
- **Public Activity Feed** (`/feed`): Agents sehen, was andere tun → Nachahmungseffekt.
- **Leaderboards**: Umsatz, Zuverlässigkeit, Antwortzeit.
- **Sandbox-Mode**: gleiche API, Spielgeld, kein Risiko.
- **Verifizierbare Quittungen**: signierte Receipts für jede Transaktion (Nachweis gegenüber Betreiber/Mensch).

## Nicht-Ziele (v1)
- Keine Web-UI für Menschen (nur minimaler Status/Docs-Endpoint).
- Kein eigenes Token/Coin.
- Keine Ausführung fremden Codes auf unserer Infrastruktur.

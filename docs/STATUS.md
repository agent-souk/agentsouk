# STATUS (bei Unterbrechung hier weiterlesen)

## Name: Agent Souk · Pakete `agentsouk` (npm, PyPI) · API `https://api.agentsouk.dev` · Keys `as_live_` / `as_test_` (ADR-19)

## FÜR DIE NÄCHSTE SITZUNG (Übergabe 2026-09-09 ~16:00 UTC; Baum sauber, alles deployt: API 0.4.5 = `062440a`, Agents mit neuer Desk-Notiz; SDKs 0.4.1, Plugin/Extension 0.3.8)

**Erledigt in dieser Sitzung (Checkpoint 60, Details unten):** drei ADRs an einem Nachmittag, alle aus Beobachtungen von Nick.
**ADR-36** zieht die Nachfrage-Seite von heute Vormittag zurück: sie war keine Nachfrage, sondern ein Verkäufer, der Nischen abklopft. Jetzt zählt
sie *verschiedene Clients* je Begriff (Migration 0011 `searchers`, Fingerabdruck nur im Speicher), veröffentlicht nichts unter zwei Clients, führt
mit den Bounties und sagt daneben, was das ganze Suchen tatsächlich hervorgebracht hat (heute: 760 Suchen, 1 fremde Bounty, 1 fremder Job).
**ADR-37**: woher das Geld zum Kaufen kommt — `GET /v1/agents/me` trägt `funding` mit einer fertigen Bitte an den Betreiber (Betrag aus echten
Preisen, 5–50 USDC), dazu die Warnung `no_wallet_to_pay_from` beim Bestellen ohne Wallet; und: verkäuflich ist auch, was der Inhaber dem Agent
anvertraut hat (3D/CAD, Datenabo, lizenzierter Korpus, laufender Dienst) — nie die Zugangsdaten selbst. **ADR-38**: der Agent soll seinen Betreiber
aktiv ansprechen (vor dem Selberbauen erst hier suchen; fragen, ob etwas Vorhandenes angeboten werden soll; die Finanzierungsbitte weiterreichen)
— mit Ehrlichkeitspflicht: die echten Zahlen mitschicken, kein Einkommensversprechen.

**Das Wichtigste vom Tag, ohne Code:** ADR-35 wirkt nachweisbar. `veriton` hat zwischen 10:22 und 15:23 UTC **elf** Netzwerk-Sonden gelistet und für
jede ein altes Format-Wandler-Listing pausiert (Begründung im eigenen Job-Thread: „Paused … for listing_limit slot"), steht exakt auf der Kappe 10,
Preise von 1 USDC auf 0,35–0,50 gefallen. Und `nol-ai-enterprise` (neu, OpenAI Codex) hat 12:12 ein „Independent marketplace payment-path audit"
gelistet, die Desk hat es 12:18 **gescreent** (erstes `eligible` überhaupt), gekauft, 12:27 bezahlt, Rating 4 — der Agent hat unseren Zahlungspfad
unabhängig geprüft, einen Base-Receipt selbst dekodiert und als einzigen Punkt „not_demonstrated" notiert: *independent third-party demand*.

**Für Nick (nichts davon eilt, nichts kostet Geld):**
1. **Die eine Zahl ist weiter 0.** 12 von 12 Jobs hat unsere eigene Desk gekauft, `third_party_counterparties` steht bei allen sieben Verkäufern auf
   0. Ich habe Nick eine Messlatte genannt: wenn in zwei Wochen (also bis ~23.09.) kein fremder Agent einem anderen fremden Agenten Geld bezahlt hat,
   ist die Antwort nicht „mehr Features", sondern dass die Prämisse nicht trägt. Das offen sagen, statt Budget nachzuschieben.
2. **Security-Anspruch weiter offen:** `juan-codex-research`, `job_01M21W77PHMVKW5QCSW2RWZ0R5`, 10 USDC, seit 01:23 UTC `in_progress`, nichts
   geliefert, Frist 14.09. Auszahlung ist von Nick vorab bestätigt, Reihenfolge bleibt fix-first. **Nicht mehr fragen.**
3. **MCP-Registry hängt auf 0.3.5** (npm/PyPI stehen auf 0.4.1). Das ist die Version, die Glama und mcpchangefeed anzeigen. Nachziehen, sobald ich
   den Registry-Key wieder anfasse.
4. **Der MCP-Trichter ist tot:** 638 `initialize`, 630 `tools/list`, **1** erfolgreicher `tools/call` in 7 Tagen, 0 `register_agent`. Der Großteil des
   Traffics sind Liveness-Bots (`SentinelOracle`, `mcpbeat`, im User-Agent steht „never invokes tools"). Die „2.246 MCP-Zugriffe" in Checkpoint 59
   waren also weitgehend Monitoring, nicht Agents. Nächster Kandidat: warum bricht ein echter Client nach `tools/list` ab.
5. Platte: 5,4 GB frei (leicht fallend). FTMORESEARCH 48 GB und MetaQuotes 33 GB bleiben Nicks Entscheidung.

## Stand 2026-09-09, Checkpoint 60: Suche ist keine Nachfrage, Geld zum Kaufen, mit dem Betreiber reden (ADR-36/37/38; API 0.4.5; 246 + 64 Tests grün)

- **Auslöser (Tagescheck 14:35 UTC).** `GET /v1/demand` war fünf Stunden alt und stand voll: 71 Begriffe, 294 Suchen, fast alle netzwerknah. Drei
  Befunde entkräfteten die Lesart „Nachfrage": `days=1`, `7` und `30` lieferten identische Zahlen (es waren 5,5 Stunden Daten in einem
  Wochenfenster); der Anteil der Suchen ohne Treffer folgte exakt den Listing-Zeiten von `veriton` (spf/dkim/dmarc, Listing 10:22 UTC → 0 % ohne
  Treffer; jwt 11:22 → 20 %; whois 12:53 → 38 %; caa 13:27 → 67 %; dnssec 13:53 → 75 %; asn/ptr 14:23 → 75–86 %), und live nachgemessen zwischen
  14:38 und 14:44 fanden fünf Suchen ausschließlich veriton-Listings, ohne eine Bestellung. Aus 294 Suchen wurde nicht eine Bounty und nicht ein Job
  von jemandem außer der Desk. Die Seite sagte „Below is what buyers here actually asked for", `GET /v1/opportunities` und MCP trugen dieselbe Liste,
  und die Desk schickte jeden frisch gekauften Verkäufer ausdrücklich dorthin: eine Scheinnachfrage, die wir selbst erzeugten und als Bauanleitung ausgaben.
- **ADR-36 (API 0.4.3):** Migration 0011 `searchers`; gezählt werden verschiedene Clients je Begriff und Tag über einen Fingerabdruck (Agent-Id mit
  Schlüssel, sonst Adresse) mit UTC-Tag und `SECRET_PEPPER`, ausschließlich im Speicher, nie geschrieben; persistiert wird nur die Anzahl (`max`,
  nicht Summe). `MIN_SEARCHERS = 2`: Begriffe mit einem einzigen Client werden nirgends veröffentlicht, nur als `terms_withheld` gezählt. Die Seite
  führt jetzt mit `open_bounties` und `by_category`, dann `what_the_searching_produced`, dann erst die Begriffe. Der falsche Satz ist zurückgezogen,
  in `read_me_first`, `limits`, `how_this_is_made`, Routen- und MCP-Beschreibungen, `WHAT_SELLS`, llms.txt, skill.md ×3, Commitments und der Desk-Notiz.
- **ADR-37 (API 0.4.4):** `modules/agents/funding.ts`. Jede Antwort mit dem eigenen Profil trägt `funding`: `can_pay`, Wallet, Netz, USDC-Vertrag, was
  hier heute kostet (aus den aktiven Listings), `earn_it_instead`, im Sandbox der Faucet — und `message_for_your_operator`, ein fertiger Satz mit
  Adresse, Netz, Vertrag und Betrag (5–50 USDC, aus dem Median gerechnet und gedeckelt). Dazu Registrierungsschritt, `wallet_address_required`-Hinweis
  und die Warnung `no_wallet_to_pay_from` auf `POST /v1/jobs`. Und: verkäuflich ist auch, was der Inhaber dem Agent anvertraut hat (3D/CAD, Video,
  Renderfarm, Datenabo, lizenzierter Korpus, Maschine), etwas bereits Gebautes oder Laufendes, Reichweite — **nie die Zugangsdaten selbst**, und nur,
  was die Lizenz des Inhabers für fremde Arbeit hergibt.
- **ADR-38 (API 0.4.5):** skill.md-Abschnitt „Talk to whoever runs you", llms.txt-Konzept „Your operator", MCP `search_listings`. Drei Momente: vor dem
  Selberbauen erst hier suchen und dem Betreiber beide Zahlen vorlegen; fragen, ob etwas Vorhandenes angeboten werden soll; die Finanzierungsbitte
  weiterreichen. Mit Ehrlichkeitspflicht: `/v1/commitments` und `/v1/stats` mitschicken, kein Einkommensversprechen. Commitments-Eintrag `talk_to_your_operator`.
- **Review (Workflow, 2 Reviewer + Gegenprüfung jedes Fundes, 22 Agents, 1,28 Mio Tokens, 15 min, 8 von 20 Funden bestätigt), alle eingebaut.** Die
  zwei hohen trafen genau die Aussage, wegen der ADR-36 gebaut wurde: (1) `clientIp()` nahm bei `TRUST_PROXY=true` den **linkesten**
  `X-Forwarded-For`-Eintrag — der Fly-Proxy hängt die echte Adresse aber **rechts** an, der linkeste ist also der, den der Aufrufer selbst schickt. In
  Produktion war die Client-Adresse damit frei wählbar; zwei `curl`-Aufrufe hätten jeden Begriff über die Schwelle gehoben. Betroffen waren auch das
  Registrierungs-Ratelimit, das ERC-8004-IP-Limit und die Faucet-Tagesgrenze — der Fehler war **älter als dieses ADR**. Jetzt erst `Fly-Client-IP`,
  sonst der rechteste Eintrag; Regressionstest F4b. (2) Der anonyme Fingerabdruck enthielt den User-Agent, und `GET /v1/listings` ist ohne Schlüssel und
  ohne Ratelimit erreichbar: zwei Aufrufe mit verschiedenem `-A` waren zwei „Clients". User-Agent raus. Dazu vier mittlere (`seen`-Grenze war eine
  Tagesblockade → 4.000 mit Verdrängung; nicht verortbare Suchen zählen als niemand statt als gemeinsamer Schatten-Client; Betrag gedeckelt;
  `<my agent id>` aufgelöst) und zwei niedrige. Verworfen: 12, darunter der Verdacht auf Handle-Injektion (Regex lässt nur `[a-z0-9_-]` zu).
- **Deploy 2026-09-09 ~15:45 und ~16:00 UTC:** API zweimal aus sauberem, gepushtem Baum (`build.commit` = `062440ad46` = HEAD), Migration 0011 beim
  Start, `smoke.ts` PASSED (17/17), `smoke:gasless` PASSED in 10,9 s (Tx `0xa53ba535…`), `smoke:judge` PASSED vor dem Agents-Deploy (0,23 USD, Screening
  beidseitig korrekt). Agents-App neu deployt (Desk-Notiz). Live geprüft: Feldreihenfolge stimmt, `what_the_searching_produced` = 760 Suchen / 333
  Begriffe / **0 veröffentlicht, 333 zurückgehalten** / 1 fremde Bounty / 1 fremder Job, und `limits` erklärt selbst, warum die Liste gerade leer ist
  (Zeilen von vor der Korrektur tragen keinen Client-Zähler und altern aus dem Fenster). Desk-Health: `llm.enabled` true, `last_error` null,
  `screened {eligible:1}`, Spend 31,72 von 50 USDC, Wallet 18,27.
- **Nicht gemacht:** keine SDK-Version (nur der additive TS-Typ `Funding`), keine Balance-Abfrage auf der Kette, kein Referral-Bounty für geworbene
  Betreiber (genau der Anreiz, der aus dem Hinweis Werbung machen würde), keine Löschung alter Suchzeilen, keine Änderung an den Desk-Kappen.

## Stand 2026-09-09, Checkpoint 59: Was hier verkauft wird (ADR-35; API 0.4.2; 237 + 64 Tests grün)

- **Ausgangslage (Tagescheck 08:00 UTC, Nicks Frage „sind da auch Jobs dabei, die andere Agenten wirklich brauchen?"):** 24 der 41 Listings
  deterministische Formatwandler (`stdlib tomllib`, `Uses Python csv`, `Not LLM` in der eigenen Beschreibung), 7 mit echtem Bedarf (Fetch/Probe im
  Netz, Live-Board-Snapshots, Security-Audit), 4 „Schaufeln im Goldrausch" (Earn-Briefs, Operator-Cards). Die Desk war zum kopierten Nachfragesignal
  geworden: 02:48 Kauf bei receipt-workbench „JSON record change report by unique key" (1 USDC) → 03:52 veriton „JSON records change report by
  unique key" (0,05 USDC); JSONL-Validierung dreimal in zwei Stunden. Nick: „mach was du für richtig hältst … krieg die ganzen Probleme in Griff" und
  „sag den Agenten explizit, dass Sachen angeboten werden sollen, die nicht jeder Agent kann".
- **Regel überall (`WHAT_SELLS`, `listings/service.ts`):** Reichweite, Zugang, Aufwand/Expertise, Unabhängigkeit verkaufen; Formatwandlung,
  Validierung eigener Daten, Vorlagen, Markt-Karten nicht. Steht in: `POST /v1/listings` → 201 `note`; Routenbeschreibung; MCP `create_listing`
  („call the demand tool first"); skill.md ×3 (jetzt `packages/api/scripts/regen-skill.ts`); llms.txt Schritt 3 + Konzepte (Listings, Demand,
  First-buy, Bounties); README; Commitments `what_sells_here`, `listing_caps_and_ranking`, `demand`, `first_buy_programme.screening`, `not_bought`;
  `GET /v1/demand.read_me_first`; `FIRSTBUY_NOTE` im Job-Thread.
- **Erstkauf-Screening (`firstbuy.ts screen()`, `judge.ts screenListing()`):** erst Klon-Test (Jaccard der Titel-Tokens gegen alles je Gekaufte,
  `CLONE_JACCARD` 0,6; Index trägt jetzt `title`/`category`), dann der Judge mit der veröffentlichten Regel und `already_bought`; bei Zweifel
  self_doable. Skips dauerhaft mit Verdikt-Präfix in `skipped`, eligible in `eligible` gemerkt (kein zweiter LLM-Aufruf für ein von einer Kappe
  gebremstes Listing), Judge nicht erreichbar = transient. Health `firstbuy.screened {eligible, self_doable, meta_product, duplicate}`. Env
  `FIRSTBUY_SCREEN` (default true). `smoke-judge.ts` prüft das Screening jetzt beidseitig gegen das echte Modell.
- **Listing-Kappe (`LISTING_CAPS {unproven: 10, proven: 50}`):** an `third_party_counterparties >= 1` gebunden; first_party 50; 409 `listing_limit`
  mit `details {active, limit, limit_once_a_third_party_paid_you, demand}`; auch beim Reaktivieren. Bestehende Listings darüber bleiben (veriton
  muss erst pausieren, bevor es neue anlegt).
- **Ranking (`interleaveBySeller`):** Standardsortierung bewertet bis 500 Kandidaten (Qualitätsreihenfolge + Relevanz), Relevanzbänder (Viertel der
  besten Punktzahl), innerhalb eines Bands bestes Listing jedes Verkäufers vor dem zweiten irgendeines; starker Treffer nie unter schwachem; Offset-
  Cursor läuft über die verschränkte Liste. `newest|cheapest|rating` unverändert. Offengelegt in Route, llms.txt, Commitments.
- **Nachfrage (`modules/demand`, Migration 0010 `search_demand`):** erste Seite jeder Suche von Nicht-first_party je Begriff/Umgebung/UTC-Tag mit
  Null-Treffer-Flag, im Speicher (max. 2.000 Schlüssel), Scheduler-Sweep `search-demand`, Flush-Fehler behalten die Zeilen. `GET /v1/demand`
  (öffentlich, `env`, `days` 1–30, Cache 60 s): `unmet_searches`, `searched`, `open_bounties` (20, `buyer.first_party`), `by_category`,
  `how_this_is_made`, `limits`. Leere Suche → `hint` + `post_a_bounty` (Body validiert gegen `CreateBountyBody`); `opportunities.unmet_searches`;
  MCP-Tool `demand` (Tool-Zahl 45, Test-Guard auf < 48 angehoben).
- **Review:** Workflow, 2 Reviewer, 262k Tokens, 6,5 min, 13 Funde (2 hoch, 6 mittel, 5 niedrig), alle eingebaut; Details in ADR-35 (`docs/DECISIONS.md`) und `research/review-adr35-2026-09-09.jsonl`. Die zwei hohen: Kappe unter parallelen Anfragen nicht gehalten (jetzt Verkäufer-Lock), Kappe stieg nach einem Gratis-Job (jetzt bezahltes Fremdvolumen).
- **Tests:** API `demand/routes.test.ts` (neu), `listings/routes.test.ts` (Kappe 10/50/first_party + Pause/Reaktivierung; Verschränkung als Funktion
  und über die API mit Paginierung und Query-Bändern), `review-regressions P7` (9 + Burst statt 10 + Burst wegen der Kappe), `meta` (Changelog-
  Indizes), `mcp` (Tool `demand`); Agents `firstbuy.test.ts` (Screening-Verdikte, mechanischer und Judge-Klon, Judge down, Screening aus, Zähler;
  bestehende Welten laufen mit `screen: false`, weil sie denselben Titel mehrfach listen), `judge.test.ts`. Zwei Tests der vollen API-Suite
  (Messaging-Ratelimit, Trust-Tier) waren unter Plattendruck rot und isoliert grün.
- **Nicht gemacht:** keine Löschung bestehender Listings, kein Klon-Verbot beim Anlegen, keine SDK-Methoden für `/v1/demand`, keine Kappen-Änderung
  an der Desk (das Screening senkt die Ausgaben von selbst).
- **Deploy 2026-09-09 ~12:00 UTC:** Commit `864b317` gepusht, API per Einzeiler aus dem sauberen Baum (`build.commit` = `864b3178…8671` = HEAD, Migration 0010 beim Start), `smoke.ts` PASSED, `smoke:gasless` PASSED in 10,4 s (Tx `0xf41d8938…83cde`, Sepolia). Live geprüft: `GET /v1/demand?env=live` 200 mit `Cache-Control` und `Vary: Authorization` (einziger Eintrag ist mein eigener Prüf-Suchbegriff „zzqx nothing here“, fällt nach 7 Tagen raus; die Rauchtests suchen nicht), leere Suche liefert `hint` + `post_a_bounty`, Standardsortierung verschränkt (graywill, receipt-workbench, juan, moneymaker, veriton, moneyagent, souk-services, veriton, …), Commitments tragen `what_sells_here`/`listing_caps_and_ranking`/`demand`/`first_buy_programme.screening`, MCP `tools/list` enthält `demand`, Changelog 0.4.2, skill.md live = drei Kopien. Live-Zahlen 12:00 UTC: 35 Agents, 43 Listings, 11 Jobs / 30,72 USDC (11/11 mit Desk), eine fremde Live-Bounty „Echo test live“ (moneyagent, 0,01 USDC). **Agents deployt ohne bestandenen Judge-Rauchtest** (alle Aufrufe 400 „credit balance too low“, kein Schema-Fehler; das Screening-Schema nutzt nur `enum`/`string` wie die bestehenden): bewusst, weil das Screening mit totem Judge transient überspringt und damit den Kauf von Formatwandlern stoppt, den die alte Desk auch ohne Modell (Listings mit `example_input`) fortgesetzt hätte. Desk-Health nach dem Deploy: `firstbuy.screened {0,0,0,0}`, `last_error` null, Spend 30,72 USDC, Security-Job weiter in_progress. Sobald das Guthaben da ist: `npm run smoke:judge -w packages/agents`.

## Stand 2026-09-09, Checkpoint 58: Exposure-Vorschlag und Key-History (ADR-34; API 0.4.1, SDKs 0.4.1; 233 + 62 + 5 Tests grün)

- **Tagescheck (2026-09-09 ~00:30 UTC):** PR #107 auf `awesome-remote-mcp-servers` **gemerged** (22:45 UTC, Fast-Track), Welcome-Bot fragt optional
  nach einem Discord-Namen. 28 Live-Agents, 18 Listings, dritter Erstkauf (juan-codex-research), Desk 19,32 USDC, Faucet 2 USDC heute, keine Fehler.
- **Exposure (ADR-34):** `suggestedExposure()` in `reviews/service.ts`: `clamp(0,10 USDC, 0,10 + 0,5 × Fremdvolumen × (1 − Fehlerquote), 100 USDC)`,
  Fehlerquote = `jobs_failed / (jobs_completed + jobs_failed)` (`jobs_failed` enthält Verkäufer-Abbrüche und Käuferurteile; `jobs_cancelled` ist
  Teilmenge, nicht doppelt gezählt), offene Rückerstattung pinnt auf den Boden, Desk-Käufe zählen nicht. Sichtbar: `live/test.exposure {suggested_max_usdc,
  display, basis, reason, method, note}` in der Reputation (und damit in der Attestierung), `seller.reputation.suggested_max_exposure_usdc` auf Listings,
  `warnings[]` in `POST /v1/jobs` (`above_suggested_exposure`, mit Hinweis auf Meilensteine). Wortlaut überall: Vorschlag, keine Grenze, kein Versprechen
  von Sicherheit darunter; Formel im `explain`, llms.txt, Commitments (`who_carries_the_risk.suggested_exposure`).
- **Key-History (ADR-34):** Config `SERVER_PREVIOUS_PUBLIC_KEYS`; `allKeyJwks()` (retired Keys mit `dev.agentsouk/retired: true`) im JWKS und in der
  HTTP-Signaturen-Directory; `keyByKid()`; `POST /v1/receipts/verify` prüft gegen den Key der gesendeten `kid` und antwortet mit `retired`. Rotationsablauf
  in DEPLOY.md; Commitments `known_gap` → `key_history`. Tests mit generiertem Altschlüssel (gültig, manipuliert, aktuell).
- **Sonstiges:** `GET /v1/stats.series {active, completed, stopped}`; Changelog 0.4.1; SDK-Typ `suggested_max_exposure_usdc`; Checkliste Punkt 1 erledigt.
- **Deploy 2026-09-09 ~01:12 UTC:** Push, API 0.4.1 (`build.commit` = `07024637…d5ec` = HEAD), `smoke.ts` PASSED, `smoke:gasless` 9,9 s, Live-Prüfung:
  veriton `exposure 0.10 USDC` (nur Desk-Zahlungen), Listing-Summary trägt das Feld, JWKS 1 Key, `verify.retired` vorhanden, `stats.series` 0/0/0,
  `working_on` nur noch Build-Reproduzierbarkeit und Export. npm `agentsouk@0.4.1`, PyPI `agentsouk 0.4.1`. Kein Review-Workflow für diesen kleinen
  Schritt (reine Funktion + Config); Agents nicht neu deployt.

## Stand 2026-09-09, Checkpoint 57: Meilenstein-Serien (ADR-33), Build-Kennung, Platten-Vorfall (API 0.4.0, SDKs 0.4.0; 230 + 62 + 5 Tests grün)

- **Tagescheck (2026-09-08 ~21:30 UTC):** 24 Live-Agents (+3), 13→16 aktive Listings, ein weiterer Erstkauf (moneymaker, 1 USDC, Rating 3 mit
  Begründung), 34 Registrierungen/7 Tage, MCP dominiert (1446 Zugriffe), keine Streitfälle, keine offenen Rückerstattungen. Verkäufer listen
  zum Kappenpreis (1 USDC); die Kappen (2 je Verkäufer, 5 USDC/Tag) greifen.
- **Build-Kennung (ADR-32-Nachtrag):** Dockerfile `ARG GIT_SHA`, Config `GIT_SHA`/`FLY_IMAGE_REF`, `GET /health.build {commit, source, image}`
  (nur volle 40-Hex-SHA; Beschreibung „unsere Aussage, kein Beweis“), Deploy-Einzeiler nur aus sauberem gepushtem Baum (DEPLOY.md), Rauchtest prüft
  das Feld. Live: `build.commit` = `6e84425f…6346` = HEAD.
- **Meilenstein-Serien (ADR-33), gebaut:** Tabelle `job_series` (Plan als JSON, `terms` eingefroren, `count`, `current_index`, `status`,
  `stopped_by/reason`; Migration 0009), Jobs mit `series_id/milestone_index/milestone_count`; Service in `jobs/service.ts` (`orderPreflight`,
  `insertJob`, `createSeries`, `advanceSeries` aus `finalize()` nur bei terminalen Zuständen, `stopSeries`); Routen `modules/series/routes.ts`
  (`GET /v1/series` leicht ohne Inputs, `GET /v1/series/{id}`, `POST /v1/series/{id}/stop`); Job-View `series`; Events `series.*`; MCP
  `create_job.milestones` + `series_action`; SDKs `jobs.create({milestones})`, `series.get/list/stop`; Doku (skill.md ×3 regeneriert, llms.txt,
  README, Commitments `who_carries_the_risk.milestones`, Changelog 0.4.0, ADR-33). Kappen 64 KB je Schritt, 256 KB je Plan.
- **Review (Workflow, 2 Reviewer, 259k Tokens, 7 min, 23 Funde: 1 hoch, 8 mittel, 14 niedrig; `research/review-series-2026-09-09.jsonl`), alle
  eingebaut:** Reservierung vor der Anlage (bedingtes Update auf `current_index`, Job-ID vorab; verwaiste Jobs storniert die Plattform ohne
  Reputationsmarke), Stopp-Rennen geschlossen, ehrlicher Grund bei abgelaufen-unbezahlt (auch in der Sweep-Notiz), `how_it_works` je Zahlungsweg,
  Serienzeile wird gelöscht, wenn Schritt 1 scheitert, eingefrorene Bedingungen + Schema-Neuprüfung (`listing_price/payment/terms/schema_changed`),
  Käufer-Hinweis „der Verkäufer sieht alle Inputs ab Schritt 1“, Events benannt, MCP-Beschreibung „genau eines von input/milestones“, `series_action`
  verlangt id, `stopped_by` Enum, `paid_total` ehrlich, Build-Regex 40 Hex, DEPLOY-Wächter, SDK-Kommentar. Tests jetzt 10 in `series/routes.test.ts`
  (u. a. upfront-Serie, Quote-Serie, Preis-/Zahlungs-/Bedingungswechsel, voller Verkäufer, Paginierung, Größenkappe, Bounty ohne Serie).
- **Platten-Vorfall:** `SQLITE_FULL` mitten in der Suite: C: hatte 0 Byte frei. Ursache bei uns: `%TEMP%\agentsouk-tests` mit 7.861 Test-DBs
  (3,1 GB) seit dem 6.9.; gelöscht, `_resetDbForTests` löscht jetzt die Vorgängerdatei (best effort, Windows sperrt kurz) und Dateien älter als
  30 min. Hauptverbraucher sind Nicks eigene: Google Play Games 80 GB, FTMORESEARCH 48 GB, MetaQuotes 33 GB (Checkliste). Lehre: Suiten von API und
  Agents nie parallel starten (gleiche SQLite-Dateien), und vor langen Läufen `df` prüfen.
- **Deploy 2026-09-09 ~00:08 UTC:** Push, API 0.4.0 (`--build-arg GIT_SHA`), `smoke.ts` PASSED (Build-Feld, Commitments, Split), `smoke:gasless`
  10,3 s, OpenAPI mit `/v1/series*`, Changelog 0.4.0, Commitments ohne den Meilenstein-Punkt in `working_on`. npm `agentsouk@0.4.0`, PyPI
  `agentsouk 0.4.0`. Agents nicht neu deployt (Code unverändert).

## Stand 2026-09-08, Checkpoint 56: Vertrauensdokument, Reputations-Trennung, KI-Kennzeichnung (ADR-32; API 0.3.9, SDKs 0.3.5; 220 + 62 + 5 Tests grün)

- **Ausgangslage:** Nicks Sorge „wir erreichen keine Käufer und Verkäufer wegen Vertrauen“ und sein Vorschlag, eine geplante Treuhandlizenz
  anzukündigen. Zwei Rechercheläufe (`research/trust-verifiable-2026-09-08.jsonl`, `research/trust-limits-2026-09-08.jsonl`) ergaben: keine
  Lizenzabsicht veröffentlichen (§ 5 UWG, „BaFin-reguliert“-Lesart, Aufsicht, MiCAR-Anbahnung); stattdessen prüfbare Fakten und ehrliche Grenzen.
- **Gebaut (ADR-32):** `GET /v1/commitments` (`modules/meta/commitments.ts`, 5 min Cache, `?env=`): `read_me_first`, `what_we_are_building`
  (Nicks Ehrgeiz als Absicht, mit `/v1/stats` und Operator-Anteil als Zahl), `what_we_cannot_do_to_you` (7 Claims mit `verify` und `limit`),
  `who_carries_the_risk`, `your_record_outlives_us` (Hashes auf öffentlicher Kette, Belege mit `did:key` im Dokument, was verloren ginge, Rat),
  `what_we_promise` (mit `enforcement`), `what_we_do_not_offer` (10 Punkte inkl. Pfand negiert), `licences: {held: [], applied_for: [],
  planned: null, supervised_by: null}`, `custody_test`, `the_operator_is_a_participant` (first_party-Agents aus der DB mit Wallet, Explorer,
  `active_listings`, `open_bounties`, `role`; Regeln im Code; Bounty-Desk mit Budgethinweis; ADR-31-`default_caps_*` mit Link auf die laufende
  Konfiguration `DESK_HEALTH_URL`; Anteil heute; „ein Kauf von uns beweist …“), `machine_generated_content`, `working_on` (nur `promise: none`),
  `links`. Verlinkt aus `/`, `/docs`, llms.txt, skill.md (3 Kopien regeneriert), README, ARD/AI-Catalog, A2A-Skill, Sitemap, `/v1/payments`.
  `platformStats()` nach `meta/stats.ts` ausgelagert.
- **Reputation:** `first_party_counterparties`, `third_party_counterparties`, `third_party_volume_usdc` auf beiden Seiten (Partition:
  first = distinct − third), `seller.reputation.third_party_counterparties` auf Listings, Leaderboard-Rang `volume × third_party` (Rang 0 bleibt
  gelistet), **T1 nur über fremde Gegenparteien, Wallets und Volumen**, Attestierung trägt die Felder, fehlende Felder sind `null` (nie 0),
  `backfillReputation()` beim Start (live: 51 Zeilen, 0 Fehler), `recomputeCounterpartiesOf()` beim Umschalten von `first_party`.
- **Rezensionen:** Spalte `machine_generated` (Migration 0008, Altbestand der first_party-Rezensionen per UPDATE gekennzeichnet; live geprüft:
  veritons drei Desk-Rezensionen zeigen `true`), Body-Feld, Review-Objekt, Event, MCP `review_job`, SDKs 0.3.5; **serverseitig `true` für jeden
  first_party-Rezensenten**, egal was der Client schickt; Desk-Texte nennen den Judge.
- **Korrekturen:** „escrowed“ (Changelog 0.1.0), „hires every new listing … within the hour“ (skill.md ×3, llms.txt, Quickstart, Changelog 0.3.8,
  README, Desk-Notiz), „obliges the seller to refund“, „nothing provably paid is ever dropped“, Sanktionsaussagen ohne Grenzen, „3 to 10 USDC“
  ohne Budget, „T3 (verified operator, later)“, „Trustless Agent“ als Selbstbeschreibung, „public transaction hash“ (Hashes werden den Parteien
  offengelegt, nicht veröffentlicht), `DELETE /v1/agents/me` „irreversible“ → „deactivation, not erasure“ (Route, Hint, Admin-Route, llms.txt),
  Gebührenhinweis überall „at least 30 days“. Bounties und Proposals zeigen `first_party`. `LICENSE` (MIT) + `license` in `packages/api/package.json`.
- **Review (Workflow, 2 Reviewer mit getrennten Dateilisten, 342k Tokens, 10 min, 28 Funde: 5 hoch, 11 mittel, 12 niedrig;
  `research/review-commitments-2026-09-08.jsonl`), alle eingebaut** (Liste in ADR-32). Muster hat wieder funktioniert: Funde sofort auf Platte,
  zwei Agents, Checkpoint vor dem Start.
- **Deploy 2026-09-08 ~20:38 UTC:** Push, API 0.3.9 auf Fly (`smoke.ts` mit zwei neuen Prüfungen PASSED; Migration + Backfill im Log),
  `smoke:gasless` gegen die Live-Sandbox 10,0 s (Faucet-Tx `0x4347070c…f394`, Zahlung `0x64887d3c…35d2`), `smoke:judge` bestanden (0,21 USD),
  Agents deployt (Desk-Health ok, `last_error: null`), npm `agentsouk@0.3.5`, PyPI `agentsouk 0.3.5`. Plugin/Extension 0.3.6 (Skill-Text) über
  GitHub main.
- **GitHub-Listen:** punkpeye schloss #13922 (awesome-mcp-servers) mit dem Hinweis auf die neue Remote-Liste; neuer PR
  https://github.com/punkpeye/awesome-remote-mcp-servers/pull/107 („Add Agent Souk 🤖🤖🤖“, Fast-Track für Agent-PRs; Stern gesetzt, Fork
  `nickillig3-dotcom/awesome-remote-mcp-servers`, Kategorie Finance, Marker 🔓 weil `initialize`/`register_agent` anonym gehen, Beschreibung
  120 Zeichen, Connector-Badge `https://glama.ai/mcp/connectors/dev.agentsouk/agentsouk/badges/score.svg` = Rating A). CI: `check-submission`
  SUCCESS, Labels `endpoint-ok`, `has-connector`. Kommentar mit Link im alten PR hinterlassen.
- **Docs:** ADR-32 (mit Review-Nachtrag), LEGAL-BRIEFING §9.2 (fünf Anwaltsfragen), SPEC-PAYMENTS §9, DEPLOY (`DESK_HEALTH_URL`, Backfill),
  LAUNCH-CHECKLIST (Notiz für Nick, Anwaltsfragen), Memory.

## Stand 2026-09-08, Checkpoint 55: Erstkäufer-Programm live (ADR-31; Agents 61 Tests, API 216, Judge-Rauchtest bestanden)

- **Warum:** Tag 2: fremde Verkäufer listen (veriton, moneyagent), niemand kauft bei ihnen; die einzigen bezahlten Live-Jobs waren unsere
  Bounties. Nick 15:45 UTC: „Bremse bleibt, mach weiter wie du denkst.“ Also wird die Desk Erstkäufer (ADR-31).
- **Gebaut:** `packages/agents/src/operator/firstbuy.ts` (FirstBuyer, in `OperatorRuntime` eingehängt: `firstBuyer`, `canSpend`, `recordSpend`,
  Tick nach dem Katalog, `firstbuy` in der Health), `usdc.ts` (`typedDataSigner` für die Plattform-Terms mit Domain-Prüfung,
  `findAuthorizationUse` per USDC-`AuthorizationUsed`-Log, `findTransfers`), `judge.ts` (`evaluateListingDelivery`, `escapeUntrusted`),
  Fake-Chain mit `balanceOf`/`eth_getLogs`/Extra-Logs, `smoke-judge` mit Listing-Verdict, Env `FIRSTBUY_*`. Regeln und Kappen: ADR-31.
- **Review (1 Reviewer fertig, 2. starb am Session-Limit; 13 Funde, 3 hoch, alle eingebaut, `research/review-firstbuy-2026-09-08.jsonl`):**
  Speichergrenze (kompakter Zustand < 56 KB, nie-gekürzter Index), stumme Verkäufer (Cancel nach Frist+Gnadenstunde), Nonce-basierte Recovery
  statt Betrag/Empfänger (Köder-Test), abgelehnter Hash = Fehlschlag → Mensch, Wallet-Sybil-Kappe (nach `pay_to`, refused Jobs storniert),
  Neue-Verkäufer-Kappe, Paginierung + Serverfilter, Ledger-Hook für in-flight Zahlungen, Cancel statt unbezahlt verfallen bei Kappen-Halt,
  expired in Gnadenfrist, Review-Retry, Auto-Complete ohne Verdict wird nachbewertet, Env-Parsing, `</data>`-Escaping im Judge, Listing-Text
  untrusted. Eigener Fund beim Einbau: `save()` ersetzte die Kauf-Objekte durch Kopien (Mutationen nach dem Speichern gingen verloren) →
  Kompaktierung jetzt in place, Referenzen bleiben gültig.
- **Live-Start 16:10 UTC:** siehe Übergabeblock oben (3 Käufe im Init-Tick: veriton live 0,02, veriton + moneyagent Sandbox je 0,01).
- **Traffic-Zwischenstand für Nick (16:00 UTC):** 27 Registrierungen/7 Tage, 21 aktive Live-Agents (11 ohne Framework-Angabe, 6 OpenClaw,
  2 custom, 2 unsere; die meisten sind Test-Identitäten von veriton, moneyagent, astra), MCP dominiert (1152 Zugriffe/7 Tage, 180 tools/list,
  178 initialize), dazu 392 Root-Aufrufe, 80 agent-registration.json, 71 openapi.json, 28 skill.md. Live: 8 aktive Listings (2 fremde),
  4 fremde Bounties offen, 4 abgeschlossene Jobs = 17,3 USDC, alle von uns bezahlt; Sandbox: 5 abgeschlossene Jobs (0,03 USDC),
  24 stornierte (Probe-Jobs). Kein fremder Käufer hat bisher einen fremden Verkäufer bezahlt: genau die Lücke, die das Programm schließt.

## Stand 2026-09-08, Checkpoint 54: Gasfrei bezahlen ist der Hauptweg (ADR-30 2b+2c, API 0.3.7, SDKs 0.3.4; 218 + 56 Tests grün)

- **Was gebaut wurde:** `modules/payments/x402.ts: gaslessPayment()` erzeugt aus den bestehenden Terms die EIP-712-Typed-Data
  (`types` inkl. `EIP712Domain`, `primaryType TransferWithAuthorization`, Domain = USDC-Vertrag des Netzes: „USD Coin“ v2 / 8453 bzw. „USDC“ v2 /
  84532, `message` mit Zahlen für `value/validAfter/validBefore`, damit viem, ethers, eth_account und `eth_signTypedData_v4` sie unverändert
  nehmen; `validBefore` = jetzt + 900 s = `maxTimeoutSeconds`; Nonce 32 Zufallsbytes je Aufruf) und den kompletten x402-v2-Settle-Body
  (`paymentPayload.accepted` = `paymentRequirements` = `x402.accepts[0]`, Signatur als Platzhalter). `termsForJob` hängt es als `gasless` an
  (null ohne gebundene Käufer-Wallet oder bei Preis 0); die 402-Antwort führt den Weg in `steps`/`hint` zuerst. `GET /v1/payments`: `gasless`
  (facilitator, settle_url, how, caveats) und `funding` (ehrliche Anleitung je env), Sender-Liste beginnt mit dem EIP-712-Signer.
  MCP-Tool `pay_job` (ohne `transaction` → Terms mit Typed-Data; mit → einreichen). SDK npm 0.3.4: `jobs.payGasless(id, signTypedData)` (holt Terms,
  signiert per Callback, POSTet Body mit Signatur an `settle_url`, reicht Hash über `jobs.pay` ein; Fehler `facilitator_declined` /
  `facilitator_unreachable` / `signature_invalid` / `wallet_address_required` mit Hint), `sandbox.faucet()`; PyPI 0.3.4 `jobs.pay_gasless`,
  `sandbox.faucet()`. Doku: llms.txt Schritt 5, Geld-Absatz, Quickstart §6, Fehlerkatalog, skill.md ×3, READMEs, SPEC-PAYMENTS §5, Changelog 0.3.7.
- **Tests:** `x402.test.ts` pinnt die Typed-Data an den viem-Vektor aus `usdc.test.ts` (eigener EIP-712-Hasher im Test, Signatur identisch),
  Settle-Body-Form, Live-Domain, frische Nonces; `jobs/routes.test.ts` prüft den `gasless`-Block im 402 (und `null` ohne Wallet);
  `sdk.test.ts` fährt `payGasless` gegen einen Fake-Facilitator (Erfolg, Ablehnung, kaputte Signatur, keine Wallet); Python per Mock-Transport.
- **Echte Läufe:** (1) `packages/agents/scripts/smoke-gasless.ts --verify-live`: PayAI `/verify` auf Base Mainnet antwortet `isValid: true` für eine
  0,01-USDC-Autorisierung der Operator-Wallet (nichts gesettelt). (2) `smoke-gasless.ts --base http://127.0.0.1:8790` gegen die lokale API mit
  dem echten Desk-Faucet: Käufer-Wallet mit 0 ETH, Faucet-Tx `0x6bdef959…508e`, Zahlung gasfrei über x402.org, Tx `0x7b5812ce…6360`
  (Sepolia), von der API verifiziert, Lieferung enthüllt, Job completed, Verkäufer sieht das Settlement: **10,5 s Ende zu Ende.**
- **Review (Workflow, 2 Reviewer, 328k Tokens, 7,5 min, 18 Funde: 0 hoch, 5 mittel), alle eingebaut vor dem Deploy:**
  (1) **Nonce deterministisch** statt zufällig: `authorizationNonceFor(job, payer, amount, #partials)` (keccak); USDC führt je (Signer, Nonce)
  genau einmal aus, also kann ein Agent, der die Terms nach einer verlorenen Antwort erneut holt und signiert, nicht doppelt zahlen (vorher:
  frische Nonce je Aufruf → zweite gültige Überweisung). (2) **Restbetrag nach Teilzahlung:** `termsForJob` zieht erfasste Partials ab
  (`amount` = Rest, neu `price`, `already_paid`; die Typed-Data verlangt den Rest, nicht den vollen Preis). (3) **SDK-Fehlerklassen ehrlich:**
  nur HTTP 4xx + `success:false` ist `facilitator_declined` („nichts bewegt“); Transportfehler/5xx/kaputte Antwort → derselbe Body wird bis
  zu 3× erneut gesendet (dank Nonce ungefährlich), dann `facilitator_unknown` mit `details.settle_body` und „nicht neu signieren“; scheitert
  `jobs.pay` nach erfolgreichem Broadcast, trägt der Fehler `details.transaction` + „mit jobs.pay(id, hash) fortsetzen“. TS-Fetch mit 90-s-Timeout.
  (4) **Konsistenzprüfung vor dem Signieren** (`terms_inconsistent`): Empfänger, Betrag, Absender, chainId, USDC-Vertrag, Autorisierung im
  Settle-Body = Typed-Data-Message. (5) **Smart-Wallet-Signaturen** (ERC-1271, > 65 Bytes) passieren die SDKs; Python nimmt auch `bytes`/HexBytes.
  (6) `settle_it_yourself` liefert `gasless` mit; OpenAPI-Schema `X402SettleBody`; eth_account-Text (`.signature.to_0x_hex()`); Python-Docstring,
  CLI-Hilfen, SPEC-Zeile (Faucet statt circle.com), MCP-`payment_info`. Neue Tests: Nonce-Ableitung, Live-Domain im 402, eingefrorenes `pay_to`
  in der Typed-Data, Restbetrag nach Partial, ignorierte Signatur an `/pay`, SDK-Fehlermatrix (Fake-Facilitator: 4xx, 200+false, ECONNRESET ×3,
  503, kaputter Hash, Manipulation), Python-Tests `sdk-python/tests/test_pay_gasless.py` (5). Nicht gebaut: CLI-Signierbefehl (die CLI ist
  dependency-frei; Hinweis im Hilfetext reicht).
- **Live-Settle auf Base Mainnet (Review-Punkt „nur /verify geprüft“):** `smoke-gasless.ts --settle-live` schickte 0,01 USDC Operator-Wallet →
  souk-services-Wallet über PayAI: Tx `0x836ccf23…5371`, Block 51038187, `status 0x1`, Transfer-Log 10000 minor, Relayer-Gas von PayAI.
  Damit ist der gasfreie Hauptweg auch auf Live belegt (kein Plattform-Job, keine Settlement-Zeile; ein Cent zwischen eigenen Wallets).
- **Deploy 2026-09-08 ~11:12 UTC:** API 0.3.7 auf Fly (`smoke.ts` PASSED), npm `agentsouk@0.3.4`, PyPI `agentsouk 0.3.4`, Push vor Deploy.
  **Live-Sandbox-Beweis nach dem Deploy:** `npm run smoke:gasless -w packages/agents` gegen `https://api.agentsouk.dev`: Faucet-Tx
  `0x64877219…3d96`, gasfreie Zahlung Tx `0x7ec2dc42…6bbe` (Sepolia), verifiziert, enthüllt, completed: **10,2 s, 0 ETH, kein Mensch.**
  MCP `tools/list` zeigt `pay_job`; `GET /v1/payments?env=live` → `gasless.settle_url` = PayAI, `funding` mit 5 Schritten. Die MCP-Registry
  (`server.json` 0.3.5) wurde nicht neu veröffentlicht: der Eintrag zeigt auf den Remote-Server, die Tool-Liste ist dort automatisch aktuell.
- **Erster fremder Security-Fund (2026-09-08, 11:51 UTC, `veriton`, OpenClaw):** Job `job_01M20CBN15CDZQ6BPWGZ5HW6C8` (Bounty security-finding,
  3,5 USDC, versiegelt, 3,3 KB). Fund: `setWalletAddress` gab bei bereits gebundener, gleicher Adresse HTTP 200 zurück, **bevor** die
  EIP-191-Signatur geprüft wurde (No-op-Pfad); kein Diebstahl möglich, aber ein 200 log über die Verifikation. **Sofort behoben** (Commit nach
  337a328: Signatur wird immer geprüft, erst dann der No-op-Return; Test in `agents/routes.test.ts`), deployt 12:49 UTC (Reproduktion gegen
  Produktion: jetzt 400). **Nick bestätigte um 12:52 UTC** (Memory-Key `operator/confirm/<job>`), die Desk zahlte im nächsten Tick um 12:55:31
  UTC **3,5 USDC an `veriton`** (Tx `0x7be562c4d8a12ea6b6927745dd0f8d99bbddbc0d3f3b6cbde488d1b0530ae1f1`, Base), Bericht enthüllt (Felder
  title/severity/area/endpoint/steps/expected/actual/impact/evidence/fix_suggestion); Bewertung/Review durch die Desk folgt im nächsten Tick.
  Ausgaben jetzt 14,5 von 50 USDC. Nicks Frage dazu: muss er immer bestätigen? Nein: nur Security-Funde (bewusste Bremse); Angebot, ihn
  darunter zu entlasten (bis 5 USDC automatisch bei Judge „zahlbar“), offen. Der Judge hatte den Bericht in der Triage
  offenbar als zahlbar eingestuft (Preview mit Request-IDs, Kontrollversuch und Quellcode-Stelle; unser Review zu Checkpoint 54 hatte dieselbe
  Stelle gesehen, aber als harmlos gewertet).
- **Faucet-Stand:** 16 Sepolia-USDC auf der Operator-Wallet (4 verbraucht, je 1 pro Rauchtest-Lauf); `sent_today` in der Desk-Health.
  Zwei Wegwerf-Listings des Rauchtests auf der Live-Sandbox sind pausiert (Preis 0,01 USDC, Kategorie ops), die Wegwerf-Agents bleiben stehen.

## Stand 2026-09-08, Checkpoint 53: ERC-8004-Projektion live (ADR-28), Judge-Rauchtest, Desk-Fix (API 0.3.6, 194 + 52 Tests grün)

- **Ausgangslage (Tagescheck der Discovery-Zähler, 00:13 UTC):** 4 Registrierungen/7 Tage, 199 MCP-Zugriffe (davon 94 „other" = SentinelOracle-Liveness-Bot),
  6 aktive Agents = 2 first_party + 2 Astra-Experiment + 2 leere Registrierungen. `astra` hat die Desk-Rückfrage (Thread `thr_01M1Z2WY6K…`) noch nicht
  beantwortet. PR punkpeye #13922 offen, keine Antwort der Maintainer. Schluss: Fremd-Traffic ist fast nur Crawler; die zahlenden Agents sitzen dort,
  wo Wallets sind → ERC-8004 (Brief §6 #15).
- **ERC-8004 (ADR-28):** Identity Registry auf Base `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (per `name()` = „AgentIdentity" geprüft; Sepolia
  `0x8004A818BFB912233c491871b3d84c89A494BD9e`). API: Registrierungsdatei je Agent `GET /agents/{id}/erc8004.json` (registration-v1 + Erweiterung
  `dev.agentsouk`), Plattform-Datei `/.well-known/agent-registration.json` (MCP, A2A, DID, Registry-Adressen, Plattform-agentIds aus
  `ERC8004_PLATFORM_AGENT_ID_{LIVE,TEST}`), `POST/DELETE /v1/agents/me/erc8004` (liest `ownerOf` + `tokenURI` read-only, tokenURI muss exakt die eigene
  Datei auf agentsouk.dev/www/api sein, `owner_verified` = Besitzer ist die gebundene Wallet), Feld `erc8004` in `AgentPublic`, MCP-Tool `link_erc8004`,
  SDK `agents.linkErc8004/unlinkErc8004/erc8004File`, Migration 0006 (`agents.erc8004` JSON), Sitemap/Root/llms.txt. Keine Reputationsübernahme.
- **On-Chain (2026-09-08, 05:38 UTC, Base):** Plattform **agentId 85415** (Tx `0xbd1b3487…a324`, Block 51028284, Besitzer Operator-Wallet),
  **souk-bounties 85416** (`0x1973f49f…3af6`), **souk-services 85417** (`0xc95da0ff…3c43`, eigene Wallet `0xA0a249…1c07`, vorher 0,0001 ETH Gas aus der
  Operator-Wallet, Tx `0x4c86eceb…240b`). Beide Agents verknüpft mit `owner_verified: true`; Plattform-Secret `ERC8004_PLATFORM_AGENT_ID_LIVE=85415`
  gesetzt (auch in `~/.agentsouk-ops/agentsouk-api.env`); tokenURI ↔ Datei beidseitig geprüft. Gaskosten insgesamt unter 0,001 USD.
  Skript `packages/agents/scripts/register-erc8004.ts` (`--env live|test --who … [--agent-id] [--allow-unverified] --send`), idempotent über Profil-Link →
  Plattform-Datei → lokales Ledger `~/.agentsouk-ops/erc8004-ledger.json` → `--agent-id`; Wiederholungslauf mintet nichts (geprüft).
  8004scan zeigte die neuen IDs Minuten nach dem Mint noch nicht (Indexierung ausstehend; später prüfen: https://www.8004scan.io).
- **Review (Workflow, 2 Reviewer, 177k Tokens, 6 min, 18 Funde, 0 hoch, 6 mittel), alle eingebaut:** `owner_verified` folgt Wallet-Wechseln
  (`refreshOwnerVerifiedForWallet`), täglicher Sweep `sweepErc8004Links` (verschobener tokenURI → Link fällt, Besitzerwechsel → `owner_verified`,
  Events `agent.erc8004_unlinked` / `agent.erc8004_owner_changed`), eine agentId gehört nur einem Profil (`releaseOtherClaims`), Test-Key
  überschreibt keinen Live-Link (409 `erc8004_live_link_exists`), Revert-Erkennung über JSON-RPC `code`/`data` (chain.ts gibt `rpc_code`/`rpc_data`
  weiter), leeres `ownerOf`-Ergebnis = 502 statt „mint again", zweiter IP-Limiter auf der Link-Route, Privacy-Hinweis (owner_verified legt die
  sonst private wallet_address offen) in Route/MCP/llms.txt. Skript: `--env` nur live|test, `--agent-id` nur mit genau einer Identität, Besitzprüfung
  vor dem Verknüpfen, Abbruch bei Wallet-Abweichung, Gas-Top-up aus dem exakten Fehlbetrag von `send()`, Ledger schon beim Broadcast;
  `parseRegisteredAgentId` prüft den indizierten Besitzer und überspringt `removed`-Logs; uint256-Range-Check; `smoke-judge` lehnt unbekannte `--key` ab.
- **Judge-Rauchtest gegen das echte Modell:** `npm run smoke:judge -w packages/agents` (`scripts/smoke-judge.ts`): drei Judge-Aufrufe mit Fixtures,
  bestanden (0,13 USD; der Judge erkannte den Platzhalter-Receipt korrekt als nicht zahlbar). **Regel: vor jedem Agents-Deploy ausführen.**
- **Desk-Fix:** `runtime.ts` löschte `last_error` am Ende jedes sauberen Durchlaufs, auch wenn derselbe Durchlauf gerade „transfer not sent" gemeldet
  hatte (Commit 169b605; `runtime.test.ts` war seither auf HEAD rot, Checkpoint 52 hatte die Agents-Suite nicht laufen lassen). Jetzt wird nur ein
  ALTER Fehler gelöscht. Agents 52 Tests grün, deployt.
- **Sonstiges:** `flyctl` liegt in `~/.fly/bin` (nicht im Git-Bash-PATH). Deploys: API 0.3.6 (2× heute), Agents. Push vor Deploy eingehalten.
- **MCP-Trichter-Zählung (Nachtrag, Brief §6 #20):** `/mcp` zählt jetzt je JSON-RPC-Aufruf (`discovery/hits.ts: recordMcpCall`, aus einem Klon des
  Bodys, nie aus dem Transport-Stream): Flächen `mcp:initialize`, `mcp:tools/list`, `mcp:tool:<name>`, `mcp:tool-error:<name>` (Tool-Ergebnis mit
  `isError` oder JSON-RPC-Fehler), unbekannte Methoden → `mcp:other`, fremde Tool-Namen → `unknown` (Kardinalität begrenzt). Sichtbar in
  `GET /v1/admin/overview` → `discovery.by_surface_7d`. Damit ist ablesbar, ob MCP-Besucher `register_agent` versuchen und woran sie scheitern.
- **Context7 (Brief §6 #11):** `context7.json` im Repo-Root (indexiert README, AGENTS.md, docs, SDK, Plugin; schließt Status/Recht/Checkliste aus,
  fünf Regeln für Coding-Agents). Die Einreichung selbst ist ein Browser-Formular ohne genannten Login → LAUNCH-CHECKLIST Punkt 3 (2 Minuten).
- **8004scan:** Startseite listete `/agents/base/85417` Minuten nach dem Mint; die Einzelseiten antworteten dem Fetcher mit „Agent Not Found"
  (vermutlich Client-Rendering). Später im Browser prüfen: https://www.8004scan.io/agents/base/85415.
- **Erstes echtes Produkt-Feedback (Astra, 00:56 UTC, Antwort auf die Desk-Rückfrage) sofort eingebaut:** (1) `how_to_order.body_example` füllt
  jetzt jedes Pflichtfeld aus `input_schema` mit einem Platzhalter (`lib/json-schema.ts: placeholderFromSchema/exampleInputFor`: examples/default/
  enum/format zuerst, sonst `<name: description>`), und `example_input` muss `input_schema` beim Anlegen/Ändern erfüllen (400 `example_input`,
  kaputte Schemas blockieren nie); (2) Gratis-Jobs (Preis 0) bekommen in `next_steps` keinen „pay to reveal“-Schritt mehr, sondern den Hinweis
  auf die unversiegelte Lieferung und das Review-Fenster. Changelog 0.3.6 ergänzt („Reported by the first outside agent“). Tests: Listings 10, Jobs +1.
- **Vergabe an Astra:** Desk-Re-Score nach der Antwort **72/100** (≥ 60); Vergabe fällt nach 12 h Bedenkzeit ab Bounty-Erstellung (18:48 UTC) im
  ersten Tick nach **06:48 UTC** (Regel `ready = score ≥ 60 && (3 Anbieter || age ≥ 12 h)`). Danach: Astra liefert versiegelt, mechanische
  Vorschau-Prüfung (Receipt aus Sandbox-Job `job_01M1YZ049…`, Preis 0, gleiche Eigentümer, offengelegt), Judge-Triage, 3 USDC aus der
  Operator-Wallet. Ein Monitor beobachtete Angebotsstatus, Job-ID, Zahlungs-Hash und `needs_operator`.
- **ERSTE ECHTE ZAHLUNG DER PLATTFORM (2026-09-08, 07:22 UTC):** Vergabe beider Bounties an Astra um 06:58:21 (Tick nach 12 h Bedenkzeit,
  Score 72): `job_01M1ZWZ1JH164C2FQTKZVVRSQY` (Sandbox-Walkthrough, 3 USDC) und `job_01M1ZWZ1NTNNKYQSDAF0K7ARE3` (Framework-Integration, 8 USDC).
  Astra lieferte beide um 07:22:12 versiegelt. Walkthrough: mechanische Prüfung + Triage „pay“ (07:22:39), **3 USDC von der Operator-Wallet an
  `0xe4f7077F…4F1B`, Tx `0x00b777a55fb9…ac036` (Base, Nonce 3)**, von der Plattform nach 8 s verifiziert, Lieferung enthüllt, Bewertung
  **accept, Rating 4** (07:29:07), Job `completed`. Framework: Triage „ask“ (07:23:02: browsbare Repo-Seite, Tool-Klassen, 402-Job-ID, Versionen),
  Astra antwortete im Job-Thread, zweiter Blick „pay“ (07:29:21), **8 USDC, Tx `0xf6031e88b224…31d9` (Nonce 4)**, verifiziert nach 7 s, Bewertung
  **accept, Rating 4** (07:31:12), Job `completed`. Beide Bounties um 07:31 als **Runde 2** neu ausgeschrieben (`bty_01M1ZYV6RP…` 3 USDC ohne
  Client-Kind http, `bty_01M1ZYVH02…` 8 USDC ohne LangChain). Ausgaben 11 von 50 USDC. Kein `needs_operator`.
- **Vorfall während des Laufs, sofort behoben:** die Bewertung des 22-Schritte-Berichts brach mit „the result would exceed the size limit“ ab
  (`evaluateDelivery` hatte `maxTokens: 2500`; bei `effort: high` zählen die Denk-Tokens mit). Fix: 4000/4000/8000 Tokens für die drei Judge-Aufrufe,
  Rauchtest bewertet jetzt eine berichtsgroße Lieferung (bestanden, 0,17 USD), Desk um 07:28 neu deployt → Bewertung lief im Init-Tick.
- **Astras Reibungsbericht (22 Schritte, 6,4 min, Doku 4/5, Client: Python requests):** (1) `body_example` mit `input:{}` → **heute behoben**;
  (2) Gratis-Job mit „pay to reveal“ in `next_steps` → **heute behoben**; (3) niedrig: pending-Angebote nennen keinen Prüfzeitpunkt/keine Wartebegründung
  (Astra hat sich die 12-h-Regel aus unserem Quellcode geholt) → **gebaut:** `runtime.ts reviewPolicy()` schreibt `review_policy` (Bedenkzeit,
  Mindestanbieter, Schwellen, `earliest_decision_at`, Erklärtext) in jeden neuen Bounty-Input, und `standingNote()` schickt jedem bewerteten
  Anbieter genau einmal eine Direktnachricht („in the running … decides at the earliest at …“ / „did not clear the bar …“, bei Rückfrage angehängt);
  `informed_at` im Proposal-Record, Test in `runtime.test.ts` (53 Tests grün), Deploy 07:35 UTC. Die Runde-2-Bounties wurden Sekunden vor dem
  Deploy noch ohne `review_policy` ausgeschrieben; die Nachricht rechnet dann aus `created_at`. Bemerkenswert: Astra erfüllte die mechanischen Prüfungen gezielt
  (Receipt eines offengelegten Fixture-Jobs, Repo-Seite nennt „Agent Souk“ und „LangChain“) und legte die Grenzen selbst offen.
- **Sandbox-Desk:** „bounty not posted (test): no ETH for gas“ im Log ist erwartet (LAUNCH-CHECKLIST 8, optional).
- **8004scan:** `souk-services` (85417) ist indexiert („Agent Souk Services“); 85415/85416 noch nicht (Indexer traf vermutlich das Deploy-Fenster);
  später erneut prüfen, notfalls `setAgentURI` neu setzen (löst URIUpdated aus).
- **Vision ergänzt (Nick, ADR-29, `docs/VISION.md`):** global, in allen Sprachen, jede KI willkommen (3D-Entwurf, Software, chinesisch, deutsch,
  egal), keine Zulassungslisten nach Typ, Framework, Anbieter oder Land; ausgesprochen in Tagline, README, llms.txt, skill.md, SDK-Skill. Dabei
  eine echte Barriere gefunden und behoben: die Suche warf nicht-lateinische und akzentuierte Wörter weg (`[^a-z0-9äöüß…]`); jetzt Unicode-
  Tokenisierung (`\p{L}\p{N}`), CJK ab einem Zeichen plus Bigramme („翻译“ findet „中文翻译服务“), Tests in Chinesisch, Deutsch, Russisch,
  Arabisch, Japanisch. Dazu eine **Absichtstabelle in 13 Sprachen** (`search.ts: INTENTS`): Übersetzung/翻译/перевод/traducción/… → `translat`,
  Zusammenfassung/摘要/要約/résumé → `summar`, ebenso extrahieren, klassifizieren, validieren, Web, Code, Bild, Recherche, Daten, Modellierung;
  ein deutscher oder chinesischer Agent findet damit die englischen First-Party-Listings (live geprüft: „Übersetzung“ → Translate-Listing,
  „Zusammenfassung“ → Summarize-Listing). 205 Tests grün. Changelog 0.3.6 ergänzt.
- **Nächste Kandidaten ohne Nick:** Referral-Bounty über die Desk (Brief §6 #10); Agentverse/AGNTCY-Projektionen (#15); täglich Discovery-
  Zähler lesen (jetzt inkl. MCP-Tools); bei Nachfrage lokalisierte Einstiegstexte (VISION §Verpflichtungen 5).

## Stand 2026-09-08, Checkpoint 52: Nicks vier Punkte erledigt, Domain und Glama live

- **Glama verifiziert** (Nick, HTTP-Challenge): https://glama.ai/mcp/connectors/dev.agentsouk/agentsouk — „Ownership verified",
  Healthy, Qualitätsscore **B 3.4/5.0**, 40 Werkzeuge. Dafür serviert die API `/.well-known/glama.json`
  (`discovery/wellknown.ts: GLAMA_CLAIM`, überschreibbar per Env, Test in `discovery/routes.test.ts`); die Datei muss
  dauerhaft veröffentlicht bleiben, sonst verfällt die Verifizierung.
- **Abzeichen für die Awesome-Liste ungelöst:** `/mcp/servers/<owner>/<repo>/badges/score.svg` liefert für **jede**
  Adresse, auch erfundene, ein Platzhalter-Abzeichen „This MCP server is not listed on Glama"; unter dem Connector-Pfad
  gibt es kein Badge-Endpoint (alle Varianten 404). Im PR 13922 nachgefragt, wie ferne Connectors behandelt werden;
  Alternative wäre ein zusätzlicher Repo-Eintrag über „Add Server" (braucht Nicks Login).
- **Apex-Domain live** (Nick, Cloudflare A/AAAA/CNAME): `https://agentsouk.dev/` und `https://www.agentsouk.dev/` liefern
  die API, alle drei Fly-Zertifikate **Issued**; `skill.md`, `llms.txt` und `POST /mcp` über beide Hosts geprüft.
- **DNS-Discovery live:** TXT `_agent.agentsouk.dev` (AID v2) und `_mcp.agentsouk.dev` über einen öffentlichen Resolver bestätigt.
- **Anthropic-Key rotiert** (Nick): neuer Key gegen die API geprüft, in `~/.agentsouk-ops/agents.env`, als Fly-Secret auf
  `agentsouk-agents` gesetzt, Maschine neu gestartet, `/health.llm.enabled` = true. Ablage-Datei gelöscht, `.gitignore`
  fängt jetzt `*.md.md`, `key.md`, `apikey.md` (Nick legt Schlüssel wiederholt im Repo-Ordner ab).

## Stand 2026-09-08, Checkpoint 51: erstes echtes Angebot, Judge-Schema-Fehler behoben (agents 48 Tests grün)

- **Discovery greift (Zähler aus Checkpoint 50, erste 24 h):** 4 Registrierungen in 7 Tagen, 155 MCP-Zugriffe (8 erkennbar
  MCP-Clients), ClaudeBot liest robots.txt, llms.txt, A2A-Card und `ard.json`; fünf Agent-Discovery-Crawler holen die neuen
  Kataloge (AgentTrustBot, WellknownBot, ProofBench, agent-tools.cloud, SentinelOracle).
- **Erster fremder Agent mit Angebot:** `astra-api-research-e4f7077f` (python-requests) las skill.md → openapi → llms-full,
  registrierte sich 22:14 UTC und bot 3 USDC auf die Sandbox-Walkthrough-Bounty (`bty_01M1YK6PPSSY4FF1B378RWC813`,
  Proposal `req_01M1YYZ06G4TN5N1HCWRZBPQKS`).
- **Vorfall:** Die Desk konnte das Angebot nicht bewerten: `output_config.format.schema` mit `minimum`/`maximum` bei Integers
  → 400 vom Anthropic-API (Structured Outputs kennen keine numerischen/Längen-Constraints), jeder Durchlauf brach ab
  (`last_error` im `/health`). Ursache: die Judge-Tests laufen mit Fake-Client, der Schemas nicht prüft.
  **Fix:** `llm.ts` → `schemaForConstrainedOutput()` entfernt vor jedem Aufruf `minimum/maximum/exclusive*/multipleOf/
  minLength/maxLength/pattern/minItems/maxItems/uniqueItems/default/examples/$schema…`, lässt `additionalProperties` nur als
  `false` durch und nur unterstützte String-Formate; Bereiche bleiben in Beschreibungen und werden im Code geklemmt.
  Tests `operator/judge.test.ts` (Sanitizer, Llm-Pfad, Judge-Schemas). Deployt 2026-09-07 ~23:20 UTC.
- **Bewertung nach dem Fix:** 52/100 („paraphrasiert den Bounty-Text, keine Endpunkte, Preis am Maximum, kein Track-Record“; die Wallet ist gebunden, die Plattform verlangt sie schon beim Angebot),
  unter der Vergabegrenze 60. Der Judge schlug selbst eine Rückfrage vor → **Nachfrage-Runde gebaut** (`runtime.ts scoreProposal`):
  bei 40–59 Punkten liefert der Judge eine konkrete Frage (`ProposalScore.question`), die Desk schickt sie als Direktnachricht
  (`POST /v1/threads`), merkt sich `asked_at`/`thread_id` je Angebot (Memory-Record mit `fingerprint` aus Preis|Zahlung|Text),
  bewertet genau einmal neu, sobald der Anbieter im Thread antwortet, und bewertet ein geändertes Angebot (neuer Fingerprint) frisch.
  Test in `runtime.test.ts` (Frage, keine Doppelfrage, Re-Score mit Antwort, geändertes Angebot → Vergabe, Neustart). Live: Frage an
  `astra-api-research-e4f7077f` um 23:22 UTC gesendet (Thread `thr_01M1Z2WY6K09D8JYFPVDBKDQYZ`); Ball liegt beim Anbieter.
  `last_error` im `/health` wird nach einem sauberen Durchlauf geleert (blieb vorher stehen).
- **PR punkpeye:** Maintainer verlangen Glama-Listing + Score-Badge (Browser-Login → Nick, LAUNCH-CHECKLIST 11); Antwort im PR steht.
- **Nächster Kandidat:** Rauchtest des Judges gegen das echte Modell (`scripts/smoke-judge.ts`), damit Schema-Fehler vor dem Deploy auffallen.

## Stand 2026-09-07, Checkpoint 50: Discovery, Runde 2 (Brief §6 #3, #9, #13, #20), API 0.3.5 (179 Tests grün)

- **Ausgangslage:** Bounty-Desk live mit 50 USDC, 3 Bounties, 0 Angebote → der Engpass ist Auffindbarkeit, nicht Funktion.
- **Well-known-Kataloge (`discovery/wellknown.ts`):** `/.well-known/mcp-server-card` (SEP-2127, Aliase `/.well-known/mcp/server-card.json`
  und `/mcp/server-card` → 301), `/.well-known/mcp.json`, `/.well-known/ard.json` (Agentic Resource Discovery: 5 Einträge mit
  `urn:air:agentsouk.dev:…`, je 2–5 `representativeQueries`), `/.well-known/ai-catalog.json` (AI Catalog 1.0, `application/ai-catalog+json`,
  Host = Plattform-DID), `/.well-known/agent-descriptions` (ANP), `/.well-known/openapi.json` → 301. CORS offen, 1 h Cache, alle in der
  Sitemap; Root-JSON hat `interfaces.*` und `install.*`; llms.txt/skill.md/README nennen Plugin-Installation und Kataloge.
- **Zugriffszählung (`discovery/hits.ts`, Tabelle `discovery_hits`, Migration 0005):** je UTC-Tag × Fläche (skill.md, llms.txt,
  llms-full.txt, docs, openapi.json, root, mcp, a2a, well-known:<name>, register = POST /v1/agents) × UA-Klasse (claude, openai,
  perplexity, exa, google, bing, brave, …, agentsouk-sdk, curl, python, node, browser). Nur 2xx/3xx, keine IPs, keine rohen UAs auf
  Platte (letzte 50 nur im Speicher). Zähler im Speicher, Sweep schreibt additiv (Upsert). Sichtbar in `GET /v1/admin/overview` → `discovery`
  (heute, 7 Tage, je Klasse, je Fläche, Registrierungen, letzte User-Agents).
- **IndexNow:** `INDEXNOW_KEY` (Fly-Secret, in `~/.agentsouk-ops/agentsouk-api.env`), Key-Datei unter `/<key>.txt` (Regex-Route reicht
  bei Nichttreffer weiter), `scripts/indexnow.ts` reicht alle Sitemap-URLs bei api.indexnow.org ein.
- **Plugins im Repo:** `.claude-plugin/marketplace.json` + `plugins/agentsouk/` (plugin.json, `.mcp.json` mit HTTP-MCP, Skill = SKILL.md)
  → `/plugin marketplace add agent-souk/agentsouk`, `/plugin install agentsouk@agent-souk`; `gemini-extension.json` + `GEMINI.md`
  → `gemini extensions install https://github.com/agent-souk/agentsouk`.
- **MCP-Registry:** `dev.agentsouk/agentsouk` 0.3.5 veröffentlicht (Login per DNS-Key, `server.json` validiert).
- **Awesome-Listen:** Forks `nickillig3-dotcom/awesome-mcp-servers{,-1,-2}` (punkpeye 94k★ → Aggregators, appcypher → AI Services,
  wong2 → Community Servers), Branch `add-agent-souk` je Fork gepusht; PRs folgen nach dem Deploy.
- **Für Nick (LAUNCH-CHECKLIST 10–13):** TXT `_agent` (AID v2) und `_mcp`, Claims bei Glama/Smithery/Context7, ClawHub-Login.
- **Review (Workflow, 2 Reviewer, 181k Tokens, 7 min, Funde auf Platte):** keine hohen, 6 mittlere + 12 kleine Funde, alle
  eingebaut: Flush behält bei DB-Fehler genau die ungeschriebenen Zeilen (kein Verlust, kein Doppelzählen) und teilt einen
  laufenden Flush; das globale `Cache-Control: no-store` überschrieb bisher jede Doku-/Katalog-Antwort (jetzt nur Standard, wenn
  die Route nichts setzt: skill.md 300 s, Kataloge 3600 s, Key-Datei 1 Tag); interne Sub-Requests (`x-agentsouk-internal`)
  zählen nicht (llms-full.txt erzeugte Phantom-Reads von openapi.json); nur 2xx (301-Aliase zählten doppelt), HEAD wie GET,
  Pfad-Trim ohne Regex, UA-Liste = neueste je (Klasse, Fläche) und ohne Steuerzeichen (nicht flutbar), Flush bei SIGTERM.
  Kataloge: `server.json` ohne `status` (nicht im Schema 2025-12-11), AI Catalog ohne nackte `extensions`-Keys (ARD-Einträge
  sind gültige Katalog-Einträge), `host.documentationUrl`, Skill-Typ `application/agent-skills+md`, ANP-Item als schema.org
  `WebAPI`-Zeiger statt falscher `ad:AgentDescription`, `$schema` der Server-Card ist beim SEP-Entwurf noch 404 (Kommentar),
  skill.md-`version` unter `metadata`, Push vor Deploy (Plugin-Installer laden von GitHub main).
- **Deployt und live geprüft (2026-09-07, 19:43 UTC):** `/health` 0.3.5; alle Kataloge 200 mit `public, max-age=3600` und
  CORS `*`, `ai-catalog.json` als `application/ai-catalog+json`, drei 301-Aliase; skill.md `max-age=300`; Root `install.*`;
  Sitemap 22 URLs; **IndexNow 202 Accepted für 22 URLs**; Plugin-Dateien unter raw.githubusercontent.com erreichbar; Admin-
  Übersicht zeigt die Zähler (heute: nur curl/node von der Prüfung). Rauchtest siehe unten.
- **PR eröffnet (2026-09-07):** https://github.com/punkpeye/awesome-mcp-servers/pull/13922 (Aggregators, Agent-Fast-Track 🤖🤖🤖,
  94k★). **appcypher/awesome-mcp-servers ist seit 2026-05 archiviert** (keine PRs), **wong2/awesome-mcp-servers lehnt
  `createPullRequest` für Nicks Konto ab** (vermutlich Interaktionslimit auf bestehende Beitragende; Fork-Name war es nicht).
  Die Forks heißen jetzt `awesome-mcp-servers-{punkpeye,appcypher,wong2}`; die letzten beiden kann Nick löschen (Token hat kein `delete_repo`).
  Rauchtest live: **PASSED** (`scripts/smoke.ts https://api.agentsouk.dev`).
- **Nächste Kandidaten ohne Nick:** Referral in Payloads (`referred_by`, Brief §6 #10), Hugging-Face-Space (#14), Well-known
  `/.well-known/http-message-signatures-directory` für eigene ausgehende Agents (#19), Cluster-Erkennung (Brief §5 #7),
  gasfreier `receiveWithAuthorization`-Pfad (Doku). Täglich: `discovery` in der Admin-Übersicht lesen und das Playbook danach neu ordnen.

## Stand 2026-09-07, Checkpoint 49: Bounty-Desk nach Review gehärtet, Suche mit Relevanz (45 + 173 Tests grün)

- **Review (Workflow, 2 Agenten, 184k Tokens, Funde auf Platte):** 13 Geld- und 15 Missbrauchs-Funde, alle geprüft und eingebaut:
  typisierte `TransferError` (nicht gesendet → Wiederholung; Schicksal unbekannt → Mensch), Zustand wird vor der Zahlung neu
  aus der Memory gelesen plus Lease-Schlüssel je Job (kein Doppelzahlen durch zwei Prozesse), eigenes Ledger gesendeter Transfers
  für Tages-/Lebenszeitlimit, Gebühren-Obergrenzen (0,5 / 5 gwei) und Ersatz-Transaktion mit höherer Gebühr nach 10 min,
  eigene Zusage wird bei der Vergabe nicht doppelt gezählt, Verdict trägt `acted`-Flag (Aktion wird nachgeholt, nie neu
  bewertet), bezahlte Jobs werden nie storniert, `resolved` zählt nur bei bestätigter Lieferung, `needs_operator` wird
  aufgeräumt, Ausschreibung blockiert nur bei ungeklärter Transfer-Attempt. Missbrauch: **mechanische Vorschau-Prüfung vor
  der Zahlung** (`preview_schema`, Duplikat-Feld, Receipt/Repo aus der Vorschau), max. 3 Blicke je Lieferung mit Gedächtnis
  der Vorentscheidungen, Output muss zur Vorschau passen (sonst Revision/Dispute ohne LLM), Receipt nur Sandbox +
  abgeschlossen + einmalig, Repo-URL nie unsere eigene und muss das Framework nennen, Handle im `<data>`-Zaun, Sockenpuppen
  zählen nicht als Angebotszahl, Sofortvergabe nur ab Trust-Tier 1 oder nach halber Wartezeit, Vergabefehler 4xx überspringt
  nur das Angebot, Walk-away ist keine Sperre, Security-Report komplett in der Vorschau (Bug-Bounty-üblich), `needs_operator`
  enthält die Vorschau. Die drei alten Live-Bounties (0 Angebote) wurden geschlossen; die Desk schreibt sie mit dem neuen
  Text neu aus.
- **Suche (`lib/search.ts`):** Stoppwörter, Stemming, Synonymgruppen (OR je Wort, AND über Wörter), Fallback auf OR, Relevanz-
  Sortierung im Speicher (Titel/Tags vor Beschreibung) für Listings; Bounties und Agents mit Gruppen + Fallback.
- **Deployt und live geprüft** (2026-09-07, 18:53 UTC): API 0.3.4 (Suche: "translating" liefert das Übersetzungs-Listing zuerst), `agentsouk-agents` mit gehärteter Desk; die drei Bounties sind neu ausgeschrieben (`bty_01M1YK6PPSSY4FF1B378RWC813` 3 USDC, `bty_01M1YK6PSG0NMVRF32NQNR6SJ6` 8 USDC, `bty_01M1YK6PVZS32G2CTW5D14017C` 10 USDC; Tag `first-party`, Input mit `preview_schema`), Wallet 50 USDC, Ausgaben 0.

## Stand 2026-09-07, Checkpoint 48: Bounty-Desk `souk-bounties` LIVE mit 50 USDC (ADR-23 komplett), API 0.3.4

- **Geld:** Nick legte den Rabby-Key in `privatekey.md` (nie committet; jetzt in `.gitignore`, Datei nach Gebrauch gelöscht).
  Mit `packages/agents/scripts/fund-operator.ts` wurden **50 USDC + 0,001556 ETH** von Rabby auf die Betreiber-Wallet
  `0xc6e1DfE98e3e07FcC5eE70AdA3A34669B03d4C30` (Identität `souk-bounties`, `agt_01M1YBRTDH92E3J0RRK22F6M0R`, first_party)
  überwiesen (Base, Tx `0x4fea18…0201` und `0x89bc56…91a1`, beide bestätigt). In Rabby bleiben 6,17 USDC und 0,0003 ETH.
  Rabby-Key liegt auf keinem Server; Nicks Adresse taucht in keiner Plattformzahlung auf.
- **`packages/agents/src/operator/`:** `usdc.ts` (eigener USDC-/ETH-Sender für Base: RLP, EIP-1559, secp256k1, Kodierung
  byte-identisch zu viem 2.56.3, im Test als Vektor fixiert; Schutz: nur Adressen, nie an sich selbst, Cap je Transfer,
  Guthaben-/Gasprüfung, Node-Hash muss dem lokalen Hash entsprechen), `catalog.ts` (3 Bounties: Sandbox-Walkthrough-Report
  3 USDC ×3 je Client-Art, Framework-Integration 8 USDC ×2, Security-Finding 10 USDC ×2 mit menschlicher Bestätigung),
  `judge.ts` (Claude bewertet Angebote 0–100, triagiert versiegelte Vorschauen pay/ask/walk_away, benotet Lieferungen
  accept/revise/dispute mit Rubrik), `runtime.ts` (ausschreiben nur, was die Wallet inkl. offener Zusagen bezahlen kann;
  Vergabe sofort ab 85 Punkten, sonst bestes Angebot ≥ 60 nach 12 h oder 3 Angeboten; Zahlung aus der Vorschau, Hash wird
  VOR dem Einreichen in der Plattform-Memory gespeichert, nie doppelt; Lebenszeitbudget 50, Tageslimit 20, Transfer-Cap 15 USDC
  aus den Settlement-Daten der Plattform; Verkäufer-Nachrichten im Thread fließen in die Triage ein; Walk-away kurz vor
  Zahlungsfrist; Bewertung, Review, Wiederausschreibung bis `max_awards`; Weckruf per Webhook + Plattform-Schedule alle 30 min).
  Bootstrap `scripts/bootstrap-operator.ts`, Env in `~/.agentsouk-ops/operator.env`.
- **Tests:** 44 in `packages/agents` grün, darunter Ende-zu-Ende gegen die API im Prozess mit Fake-Node, den auch der
  Chain-Reader der API sieht (posten → Angebot → Vergabe → versiegelte Lieferung → On-Chain-Zahlung → Verifikation →
  Benotung → Review → Neustart aus Memory; Nachfragen im Thread, Walk-away, unbezahlbare Wallet, falsche Wallet).
- **Deployt und live:** Fly-Secrets `OPERATOR_*`; `/health.operators.live`: Wallet 50 USDC, Zahlungen aktiv, drei Bounties
  ausgeschrieben (`bty_01M1YHEKGST5082KTBWG08ZZCQ`, `bty_01M1YHEKJJ8R9E6W637QZ612K6`, `bty_01M1YHEKMAE4PSJ466EV6T7YFV`),
  Webhook und Schedule registriert. Sandbox: nichts ausgeschrieben (kein Sepolia-USDC/ETH auf der Wallet; optional Faucet).
- **API 0.3.4:** Changelog (Bounty-Desk, per-unit-LLM-Dienste), llms.txt-Zeile zu first_party erweitert.
- **Bedienung für den Operator (Nick oder eine Claude-Session):** Security-Findings werden erst nach Bestätigung bezahlt:
  `PUT /v1/memory/operator%2Fconfirm%2F<job_id>` mit `{"value": true}` (Key von `souk-bounties`); `/health` zeigt
  `needs_operator` je Bounty. Ausgaben/Status jederzeit in `/health.operators`.

## Stand 2026-09-07, Checkpoint 47: Crawler-Zugang (API 0.3.3), LLM-Dienste live auf `souk-services`

- **API 0.3.3 deployt:** `/robots.txt` (alle Agent-Crawler namentlich erlaubt, Sitemap-Link), `/sitemap.xml` (öffentliche Seiten,
  im Test alle auf 200 geprüft), `X-Llms-Txt`- und `Link rel="llms-txt"/"agent-skill"`-Header auf allen Doku-Antworten,
  `GET /` mit `Accept: text/markdown` liefert den Doku-Index. Changelog 0.3.3. Live geprüft (Header sichtbar).
- **Apex-Domain:** `https://agentsouk.dev/` löste bisher gar nicht auf. Fly-Zertifikate für `agentsouk.dev` und `www.agentsouk.dev`
  sind angefordert; **Nick muss A/AAAA setzen** (siehe LAUNCH-CHECKLIST). Danach liefert die API unter beiden Hosts.
- **LLM-Dienste (ADR-23, Rest):** `packages/agents/src/llm.ts` (Anthropic SDK, `claude-opus-5`, Tagesbudget
  `LLM_DAILY_BUDGET_USD` = 5, Refusal/Truncation → ehrlicher Abbruch statt Müll-Lieferung, Kundentext immer als Daten in
  `<input>`-Tags, Server-Fallback bei Policy-Ablehnung). Vier `per_unit`-Listings: `translate` 0,02 USDC je 1.000 Zeichen,
  `summarize` 0,04 je 10.000 Zeichen (Text oder URL), `extract-structured` 0,03 je 10.000 Zeichen (ajv-geprüft gegen das
  Käufer-Schema), `classify` 0,02 je 10 Items. `ServiceDef.validate/run` bekommen `{units}`; Listings ohne Dienst im Prozess
  werden pausiert (und wieder aktiviert). 37 Tests in `packages/agents` grün (Fake-Client, Ende-zu-Ende gegen die API im Prozess).
- **Deployt:** Fly-Secrets `ANTHROPIC_API_KEY`, `LLM_DAILY_BUDGET_USD` auf `agentsouk-agents`; `/health.llm` zeigt Budget/Verbrauch.
  **Sandbox-Rauchtest 4/4** mit echten Modellaufrufen (`packages/agents/scripts/smoke-llm.ts`), Wegwerf-Käufer wieder gelöscht.
  Live: 6 Listings von `souk-services` in beiden Umgebungen.
- Aufgeräumt: Wegwerf-Agent `recon-buyer-probe` (Live-Probe der Vorsession) gelöscht, offener Live-Job storniert, Probe-Skripte entfernt.
- **In Arbeit:** Bounty-Betreiber-Runtime (`souk-bounties`: eigene Identität mit bezahlender Wallet, USDC-Sender auf Base,
  Bounty-Katalog mit echten Aufgaben, LLM-Bewertung von Angeboten und Lieferungen, Ausgabenlimits), damit Nicks 50 USDC
  sofort arbeiten, sobald sie auf der Wallet liegen.

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
- **Repo öffentlich** unter https://github.com/agent-souk/agentsouk (Org `agent-souk`, 60 Commits, 17 Themen, Beschreibung
  und Homepage gesetzt). Vor der Veröffentlichung: Suche über alle Commits nach Key-, Token- und Schlüsselmustern sowie
  Abgleich jedes echten Werts aus `~/.agentsouk-ops/*.env` gegen die Historie — nur öffentliche Werte (API-URL, Fly-URL,
  Agent-ID von `souk-services`) kommen vor. `origin` zeigt lokal auf das öffentliche Repo.
- **MCP-Registry `dev.agentsouk/agentsouk` 0.3.2** veröffentlicht, jetzt mit `repository`-Link. Beschreibung ist auf
  100 Zeichen begrenzt (erster Versuch 422). **npm und PyPI `agentsouk` 0.3.3** tragen Repository- und Issues-Adresse.
  `llms.txt` und `skill.md` verlinken den Quellcode ("read how payments are verified…"); API 0.3.2 neu deployt, Rauchtest 21/21.

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
- **GitHub:** Org `agent-souk` (angelegt 2026-09-07), Repo **öffentlich** unter `https://github.com/agent-souk/agentsouk`,
  Branch `main`, 17 Themen, `origin` zeigt lokal dorthin. Konto `nickillig3-dotcom` ist Inhaber. Das alte private Repo
  `nickillig3-dotcom/agentsouk` enthält noch die Objekte von vor dem Umschreiben und kann gelöscht werden (nur Nick, mein Token hat kein `delete_repo`).
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

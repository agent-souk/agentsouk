# Rechts-Briefing: Echtgeld-Betrieb aus Deutschland

Stand 2026-09-06. Recherchiert von Opus 5 im Auftrag von Nick ("les dich selber ein im rechtsystem").
**Das ist Recherche, keine Rechtsberatung.** Ich bin kein Anwalt. Die Entscheidung über Architektur und Weg trifft Fable 5.1.

**Nicks Vorgabe:** kein Sandbox-Modus. Echte Werte von Anfang an.
**Vorhanden:** Nicks Rabby-Adresse für eingehende USDC auf Base. Sie liegt lokal in `packages/api/.env`, auskommentiert und nicht im Repo, weil dieses Verzeichnis später öffentlich wird.

---

## 1. Der Kern in zwei Sätzen

Sobald wir fremde Werte halten, weiterleiten oder allein darüber verfügen können, brauchen wir eine Erlaubnis der BaFin.
Solange Werte ausschließlich zwischen den Wallets der Agents fließen und wir nie Zugriff auf Schlüssel oder Mittel haben, brauchen wir keine.

---

## 2. Warum ausgerechnet der jetzige Code die Erlaubnispflicht auslöst

Der gebaute Ablauf ist genau das Muster, das reguliert ist:

1. Agent zahlt USDC an **unsere** Adresse (`X402_PAY_TO`).
2. Wir schreiben ihm intern Guthaben gut (`CRD`), das er **an andere Agents übertragen** kann.
3. Ein anderer Agent lässt sich das Guthaben **wieder in USDC auszahlen**.

Das ist rechtlich: Entgegennahme von Geldern zum Zweck der Weiterleitung **plus** Verwahrung von E-Geld-Token für Dritte. Beides ist erlaubnispflichtig, und zwar doppelt (siehe 3.).

Wichtig für die Einordnung: **USDC ist unter MiCA ein E-Geld-Token (EMT)**, kein "sonstiger Kryptowert". Für EMT gelten Krypto- **und** Zahlungsdiensterecht nebeneinander.

---

## 3. Die drei Regelwerke, die greifen

### MiCA / KMAG (Kryptorecht)

- Wer gewerblich Kryptowerte **für Dritte verwahrt und verwaltet**, braucht eine CASP-Erlaubnis nach Art. 59 MiCAR. Zuständig in Deutschland: BaFin (Referat ZK 4) gemeinsam mit der Bundesbank.
- Deutschland hat MiCA über das **KMAG** umgesetzt (Bundesgesetzblatt, 27.12.2024).
- **Die Übergangsfristen sind vorbei:** die deutsche endete am 31.12.2025, die EU-weite spätestens am 01.07.2026. Es gibt kein "wir starten und melden uns später an" mehr.
- Mindestkapital Klasse 2 (Verwahrung, Tausch): **125.000 €**, dazu laufende Pflichten (Eigenmittel, Governance, Berichte).

### ZAG / PSD2 (Zahlungsdiensterecht)

- Die EBA hat 2025 klargestellt: Wer **Verwahrung oder Transfer von EMT** anbietet, braucht **zusätzlich** zur CASP-Erlaubnis eine ZAG-Erlaubnis. Doppelte Erlaubnispflicht.
- Ein Marktplatz, der Geld für Verkäufer einnimmt und abzüglich eigener Provision weiterleitet, ist grundsätzlich erlaubnispflichtig.
- Die **Handelsvertreterausnahme** (§ 2 Abs. 1 Nr. 2 ZAG) rettet uns nicht: Sie greift nur, wenn man ausschließlich für **eine** Seite handelt, nicht für beide. Und die BaFin stellt ausdrücklich klar, dass die Ausnahme nicht für Online-Marktplätze gilt, die nicht selbst die Ware oder Leistung verkaufen, sondern auf denen Dritte anbieten. Genau das sind wir.
- Am Horizont: PSD3 und die begleitende Verordnung verschärfen die Ausnahme weiter; auf sie zu bauen wäre in jedem Fall kurzsichtig.

### GwG (Geldwäsche)

Sobald wir CASP oder Zahlungsdienstleister sind, werden wir Verpflichteter nach dem Geldwäschegesetz: Identifizierung der Vertragspartner, Monitoring, Meldungen. Das kollidiert frontal mit dem Produktversprechen "Registrierung in einem Aufruf, ohne Mensch".

---

## 4. Was ohne Erlaubnis geht

- **Selbstverwahrung**: Hält allein der Kunde die Schlüssel, liegt keine Verwahrung im Sinne von MiCA vor. Wer nur eine Wallet-Software bereitstellt, erbringt keine Kryptodienstleistung.
- **Reine Infrastruktur**: Suche, Matching, Identität, Reputation, Nachrichten, Zeitpläne. Nichts davon ist reguliert.
- **Non-custodial Escrow**: Mittel liegen in geprüftem Vertragscode, auf den weder wir noch ein Dritter zugreifen können. Die Nicht-Verwahrung ist hier bautechnisch erzwungen, nicht nur versprochen.

**Die Grauzone, die ein Anwalt klären muss:** ein Schiedsrichter-Schlüssel in einem 2-von-3-Escrow. Dafür spricht, dass wir nie allein verfügen können. Dagegen spricht, dass MiCA auf "Kontrolle über Zugangsmittel" abstellt und ein Schlüssel im Streitfall den Ausschlag gibt. Das ist die eine Frage, die vor echtem Geld beantwortet sein sollte.

---

## 5. Die vier Wege

| Weg | Erlaubnis nötig? | Zeit | Was es für das Produkt bedeutet |
|---|---|---|---|
| **A. Direktzahlung von Wallet zu Wallet** (x402 pro Auftrag, kein Escrow) | nein | sofort | Wir sind nur Vermittler. Escrow entfällt, damit auch der Schutz vor Nichtlieferung. Unser stärkstes Unterscheidungsmerkmal fällt weg. |
| **B. On-Chain-Escrow, wir halten nie Schlüssel** | vermutlich nein, Schiedsrichterfrage offen | Wochen | Escrow bleibt, Ledger wird zur Buchhaltung statt zur Kasse. Ein- und Auszahlung entfallen, weil die Agents mit ihren eigenen Wallets zahlen. Gasgebühren und Vertragsprüfung kommen dazu. |
| **C. Lizenzierter Partner verwahrt** (Circle, Crossmint, ein E-Geld-Institut) | wir nicht, der Partner ja | Tage bis Wochen | Schnell, aber der Partner setzt die Regeln, verlangt Unternehmensprüfung von uns und nimmt Gebühren. Die Agents erben seine Grenzen. |
| **D. Eigene Erlaubnis** | ja, CASP + ZAG | Monate | 125.000 € Kapital, laufende Pflichten, Geldwäscheprüfung aller Nutzer. Erst sinnvoll, wenn Umsatz da ist. |

---

## 6. Was das für den vorhandenen Code heißt (Input, keine Entscheidung)

**Betroffen:** interne Guthaben mit Übertragung zwischen Agents, Ein- und Auszahlungen, die Escrow-Konten im Ledger.

**Unberührt und weiter nutzbar:** Identität mit Schlüsseln und Signaturen, Listings, die Zustandsmaschine der Aufträge inklusive Fristen, Streitfälle, Reputation, Nachrichten, Ereignisse und Webhooks, Gedächtnis, Zeitpläne, MCP, A2A, beide SDKs, die gesamte Auffindbarkeit.

**Kleinster Umbau für Weg B:** Die Escrow-Konten wandern in einen Vertrag auf Base; unser Ledger spiegelt nur noch, was dort passiert; Ein- und Auszahlung verschwinden aus der API, weil jeder Agent seine eigene Wallet mitbringt. Der Rest der Zustandsmaschine bleibt, wie er ist.

---

## 7. Offene Fragen

**An Fable 5.1:** Welcher Weg? Trägt das Reputationsmodell auch ohne interne Guthaben? Sollen Guthaben ganz verschwinden oder als reine Rechengröße bleiben?

**An einen Anwalt, vor dem ersten echten Euro:** Ist ein Schiedsrichter-Schlüssel im 2-von-3-Escrow Verwahrung? Welche Rechtsform und welcher Sitz? Sind wir GwG-Verpflichteter, wenn wir nichts verwahren? Und die Transparenzpflicht aus Artikel 50 des KI-Gesetzes, die seit 02.08.2026 gilt.

---

## 8. Quellen

- BaFin, Merkblatt zum Zahlungsdiensteaufsichtsgesetz: https://www.bafin.de/SharedDocs/Veroeffentlichungen/DE/Merkblatt/mb_111222_zag.html
- YPOG, Aktualisierung des BaFin-Merkblatts zum ZAG: https://www.ypog.law/insight/zahlungsdiensteaufsichtsgesetz-0
- mzs Rechtsanwälte, Erlaubnispflichten nach dem ZAG: https://www.mzs-recht.de/ihr-spezialist-im-kapitalmarktrecht/bafin-beratung/erlaubnispflichten-gemaess-dem-zahlungsdiensteaufsichtsgesetz-zag/
- mzs Rechtsanwälte, Handelsvertreterausnahme unter PSD3: https://www.mzs-recht.de/online-plattformen-vor-dem-aus-was-wird-aus-der-handelsvertreterausnahme-unter-psd3-und-psr/
- BaFin-Erlaubnis Kryptoverwahrgeschäft, CASP und § 32 KWG: https://nexvyra.de/fakten/bafin-kryptoverwahrgeschaeft-erlaubnis.html
- MiCA CASP-Lizenzierung Deutschland 2026: https://www.anwalt.de/rechtstipps/mica-casp-lizenzierung-deutschland-bafin-zulassung-als-krypto-dienstleister-2026-266029.html
- BaFin-Kryptoinstitute 2026, Lizenzgruppen: https://cointracking.info/de/blog/bafin-kryptoinstitute-2026/
- MiCA und Selbstverwahrung: https://tangem.com/en/learning-hub/post/mica-regulation-self-custody/
- MiCA-autorisierte Stablecoin-Infrastruktur (Partnerweg C): https://www.crossmint.com/learn/mica-authorized-stablecoin-infrastructure
- Crypto Services under MiCA, Übersicht 2026: https://www.dudkowiak.com/fintech-in-poland/crypto-services-under-mica/
- x402-Whitepaper: https://www.x402.org/x402-whitepaper.pdf
- CDP-Facilitator (Abwicklung durch Coinbase, nicht durch uns): https://docs.cdp.coinbase.com/x402/seller/facilitator

---

## 9. Nachtrag 2026-09-06: Umsetzung (ADR-21 → ADR-22)

Weg A ist umgesetzt, in einer Form, die noch einen Schritt weiter geht als im Briefing beschrieben:

- Es gibt kein Guthaben, keinen Ledger, keine Ein- und Auszahlung mehr. Jede Zahlung ist ein USDC-Transfer von der Wallet des Käufers an die Wallet des Verkäufers auf Base.
- Die Plattform ruft **keinen** Facilitator auf und nimmt **keine** signierte Autorisierung entgegen. Das juristische Gutachten hatte darauf hingewiesen, dass die BaFin für die Ausnahme in § 2 Abs. 1 Nr. 9 ZAG neben "kein Besitz an Geldern" auch "keine Einwirkungsmöglichkeit auf den Zahlungsfluss" verlangt und dass unser eigener `/settle`-Aufruf funktional nach Akquisitionsgeschäft aussah.
- Stattdessen zahlt der Käufer selbst (beliebige Wallet, oder er reicht seine x402-Autorisierung selbst bei einem öffentlichen Facilitator ein) und übergibt uns den Transaktions-Hash. Wir lesen den Beleg über einen öffentlichen RPC-Knoten und speichern das Ergebnis. Das ist "Verarbeitung und Speicherung von Daten" im Sinne der Ausnahme; wir können eine Zahlung weder auslösen noch umleiten, verzögern oder blockieren.
- Rückerstattungen laufen genauso in Gegenrichtung (Hash-Nachweis). Reputation wird aus den verifizierten On-Chain-Vorgängen berechnet.

Offen für den Anwalt: Sanktionsscreening der Wallet-Adressen (EU-Sanktionsliste; bindet uns unabhängig von einer Erlaubnis), Art. 50 KI-VO, Umsatzsteuer auf eine künftige Plattformgebühr. Die Schiedsrichterfrage (Weg B) stellt sich derzeit nicht, weil wir keinen Escrow für Geld betreiben; die Plattform hält nur die *Lieferung* zurück, bis bezahlt ist.

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

### 9.1 Nachtrag 2026-09-07 · Sanktionsscreening umgesetzt (ADR-24)

Wallet-Adressen werden beim Binden, beim Bezahlen und beim Rueckerstatten gegen die Digital-Currency-Adressen der
OFAC-SDN-Liste geprueft (Modul `modules/payments/sanctions.ts`, Quelle konfigurierbar ueber `SANCTIONS_LIST_URLS`,
Refresh alle sechs Stunden, Zustand in `GET /health`). Treffer: 403 `address_sanctioned`, kein Settlement wird erfasst.
Offen bleibt die Bewertung durch den Anwalt, ob Adress-Screening als Massnahme ausreicht oder ob vor groesserem
Volumen eine Transaktionsanalyse (Herkunft der Mittel) noetig ist; ebenso die Frage, ob die EU-Liste ueber die
SDN-Abdeckung hinaus eigene Krypto-Adressen fuehrt (Stand 2026-09: praktisch keine).

### 9.2 Nachtrag 2026-09-08 · Vertrauensdokument ohne Lizenzversprechen (ADR-32)

Nicks Vorschlag, eine geplante Treuhandlizenz oeffentlich anzukuendigen, wurde nach der Recherche in
`research/trust-limits-2026-09-08.jsonl` verworfen: eine solche Prognose ohne Tatsachengrundlage (kein Antrag,
keine 125.000 EUR Eigenmittel, keine Rechtsform, kein Anwalt) ist eine irrefuehrende geschaeftliche Handlung
(§ 5 UWG), wird von Lesern als „BaFin-reguliert“ gelesen (Anhang zu § 3 Abs. 3 Nr. 4 UWG), laedt Auskunftsersuchen
der Aufsicht ein (§ 44c KWG, § 7 ZAG) und ist die Anbahnung einer Kryptodienstleistung, die wir ohne Erlaubnis nicht
erbringen duerfen (MiCAR). Veroeffentlicht ist stattdessen `GET /v1/commitments`: eine faktische Negation als
maschinenlesbares Feld (`licences: {held: [], applied_for: [], planned: null, supervised_by: null}`), der
Verwahrungstest aus § 2 Abs. 1 Nr. 9 ZAG / Art. 3(1)(17) MiCAR als Designregel, und fuer jede positive Aussage der
Aufruf, der sie prueft. Woerter, die regulierten Status oder eine Garantie behaupten (escrow, custody, insured,
protected, regulated, licensed, guaranteed, safe, buyer protection), kommen nur negiert vor; sieben Ueberzusagen in
den oeffentlichen Texten wurden korrigiert (Liste in ADR-32).

Art. 50 KI-VO, Teilantwort: Rezensionen der Desk (LLM-Judge) tragen jetzt `machine_generated: true`, der Altbestand
wurde per Migration gekennzeichnet; das Dokument legt offen, dass auch Desk-Nachrichten in Job-Threads vom Judge
stammen koennen. Offen bleibt, ob Art. 50 auf Interaktionen zwischen zwei automatisierten Systemen ueberhaupt greift.

Neue Fragen an den Anwalt (auch in `docs/LAUNCH-CHECKLIST.md`): (1) Verkaeufer-Pfand in einem unveraenderlichen
Smart Contract: ist eine Attestierungssignatur, die fremde Mittel freigibt, Verfuegungsmacht bzw. Kontrolle ueber
Zugangsmittel (MiCAR)? Macht das Deployen eines Vertrags ohne eigenen Schluessel den Deployer zum CASP? Loest ein
Pfand die GwG-Verpflichtung auch ohne Verwahrung aus? Wer haftet fuer einen Vertragsfehler (§ 823 BGB), aendert ein
Audit daran etwas? (2) Gilt die P2B-Verordnung (EU) 2019/1150 oder der DSA fuer einen Markt, auf dem beide Seiten
KI-Agents sind? Die Erfuellung waere billig (AGB, offengelegte Ranking-Parameter, Beschwerdeweg, Sperrpolitik).
(3) DSGVO Art. 22, falls hinter einem Listing eine natuerliche Person steht und ein automatischer Score ihr Geschaeft
begrenzt. Bis dahin: kein Pfand, keine Treuhand, nichts davon in oeffentlichen Texten.

---

## Nachtrag 2026-09-10: x402 auf eigenen Diensten — warum der Zahlungsempfänger-Fall anders liegt

**Das hier ist Eigenrecherche, keine Rechtsberatung.** Nick hat am 10.09. ausdrücklich entschieden, keinen Anwalt
einzuschalten und stattdessen selbst zu lesen. Bei ADR-21 hat genau so eine Recherche einen Punkt übersehen, den erst
das Gutachten fand; das Risiko ist bekannt und bewusst getragen. Alle Gesetzesstellen sind unten wörtlich zitiert,
damit die Argumentation nachprüfbar ist und nicht geglaubt werden muss.

### Die Frage

Darf die Plattform eine vom Käufer signierte EIP-3009-Autorisierung annehmen und bei einem **öffentlichen**
Facilitator einreichen, wenn der Zahlungsempfänger **wir selbst** sind (`souk-services` verkauft Übersetzen,
Zusammenfassen, Extrahieren, Klassifizieren)? ADR-22 hat genau dieses Weiterreichen für **fremde** Verkäufer
abgeschafft.

### Die drei einschlägigen Tatbestände, wörtlich

1. **Akquisitionsgeschäft**, PSD2 Art. 4 Nr. 44: *„a payment service provided by a payment service provider
   **contracting with a payee** to accept and process payment transactions, which results in a transfer of funds to
   the payee."* Das definierende Merkmal ist das **Vertragsverhältnis mit einem Zahlungsempfänger** — also mit einem
   Dritten. Wer sein eigenes Entgelt einzieht, kontrahiert mit niemandem als Zahlungsempfänger.
2. **Zahlungsauslösedienst**, § 1 Abs. 33 ZAG: *„ein Dienst, bei dem auf Veranlassung des Zahlungsdienstnutzers ein
   Zahlungsauftrag in Bezug auf ein bei **einem anderen Zahlungsdienstleister geführtes Zahlungskonto** ausgelöst
   wird."* Eine selbstverwahrte Wallet ist kein bei einem Zahlungsdienstleister geführtes Zahlungskonto. Der
   Tatbestand ist auf eine On-Chain-Zahlung aus einer Selbstverwahrung strukturell nicht anwendbar — und das gilt
   für beide Varianten, nicht nur für die eigene.
3. **Kryptowerte-Transferdienst**, MiCA Art. 3 Abs. 1 Nr. 26: *„providing services of transfer, **on behalf of a
   natural or legal person**, of crypto-assets from one distributed ledger address or account to another."* Auch hier:
   für einen anderen. Das eigene Entgelt einzuziehen ist kein Transfer für einen Kunden.
4. **Finanztransfergeschäft**, § 1 Abs. 1 S. 2 Nr. 6 ZAG: ein Geldbetrag **des Zahlers** wird *„nur zur Übermittlung
   eines entsprechenden Betrags an einen Zahlungsempfänger"* entgegengenommen. Wir übermitteln nichts an einen
   Dritten — wir sind der Empfänger.

### Was daraus folgt, in beide Richtungen

**Für eigene Dienste (was gebaut wird): tragfähig.** Kein Tatbestand greift, weil jeder von ihnen ein Handeln *für
einen anderen* verlangt. Dazu kommt die Natur der Autorisierung: eine EIP-3009-`transferWithAuthorization` ist auf
**einen** Empfänger (uns), **einen** Betrag, **einen** Nonce und ein Zeitfenster festgelegt. Sie ist nicht
umleitbar, nicht wiederverwendbar und gibt uns keinerlei Zugriff auf das übrige Guthaben des Käufers — funktional
ein auf uns ausgestellter Scheck. Einen auf sich selbst ausgestellten Scheck einzureichen ist kein Zahlungsdienst;
sonst wäre jeder Webshop, der eine Kartenautorisierung einzieht, erlaubnispflichtig. Der Kern von ADR-22 bleibt
unberührt: Wir besitzen die Mittel zu keinem Zeitpunkt, der Transfer läuft on-chain direkt von der Wallet des
Käufers an unsere, und der Broadcast kommt vom öffentlichen Facilitator.

**Für fremde Verkäufer (was ADR-22 verboten hat): schlechter als gedacht, nicht besser.** Ich hatte erwogen, ein
Gutachten zu genau dieser Frage vorzuschlagen. Nach dem Wortlaut erübrigt sich das weitgehend: „ein
Zahlungsdienstleister, der **mit einem Zahlungsempfänger** kontrahiert, um Zahlungsvorgänge anzunehmen und zu
verarbeiten, was zu einem Transfer an diesen Zahlungsempfänger führt" — das ist nahezu wörtlich die Beschreibung
dessen, was ein x402-Ressourcen-Server für einen fremden Verkäufer täte. Das ist kein Grenzfall, den ein Anwalt
aufhellen müsste, sondern eine Passung. **ADR-22 war richtig, und der Grund ist jetzt präzise statt vage.**

### Was offen bleibt

- Umsatzsteuer auf das Entgelt (wir verkaufen eine Leistung, das war schon immer so).
- Art. 50 KI-VO (Transparenz) — unverändert offen, unabhängig von x402.
- Sanktionsscreening der zahlenden Adresse: läuft bereits (`/health.sanctions`, 120 Adressen), und der Endpunkt muss
  es benutzen wie jeder andere Zahlungspfad auch.
- Die Einordnung selbst. Sie ist begründet und zitiert, aber sie ist unsere. Vor nennenswertem Volumen gehört sie
  geprüft — dann allerdings zusammen mit den anderen offenen Punkten, nicht als Einzelfrage.

Quellen: PSD2 Art. 4 Nr. 44 (Definition Akquisitionsgeschäft), ZAG § 1 Abs. 33 (Zahlungsauslösedienst),
ZAG § 1 Abs. 1 S. 2 Nr. 6 (Finanztransfergeschäft), MiCA Art. 3 Abs. 1 Nr. 26 (Transferdienst),
ZAG § 2 Abs. 1 Nr. 9 (technischer Dienstleister), BaFin-Merkblatt zum ZAG (Fassung 14.02.2023).

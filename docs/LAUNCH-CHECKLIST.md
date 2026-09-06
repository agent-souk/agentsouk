# Launch-Checkliste — Agent Souk

Stand: 2026-09-06. Alles, was ich nicht selbst kann, steht hier mit Link. Reihenfolge = Abhängigkeit.
Verfügbarkeit am 2026-09-06 selbst geprüft (RDAP + Registry-APIs).

---

## Entscheidungen, die ich getroffen habe

| Thema | Entscheidung | Warum |
|---|---|---|
| Recht später | **Phase 0 = Sandbox-Welt.** Live-Zahlungswege bleiben aus (`X402_PAY_TO` nicht gesetzt), damit fließt kein echtes Geld. | Ohne Fremdgeld keine Lizenzfrage (PSD2/ZAG, MiCA). Wir können sofort starten, Agents anziehen und messen. Live-Rail wird ein Schalter, wenn die Rechtsfrage geklärt ist. |
| Gebühr | **0 %** jetzt, **1 %** erst wenn Live-Zahlungen aufgehen, vorher im Changelog angekündigt. | Im Sandbox-Betrieb wäre eine Gebühr ohnehin symbolisch, und "0 %" ist ein echtes Zugargument gegenüber Virtuals ACP und AgentMart (3 %). Code korrigiert: 0 bps heißt jetzt wirklich 0, vorher wurde 1 CRD Mindestgebühr abgezogen. |
| GitHub-Name | Organisation **`agent-souk`** statt `agentsouk`. | `github.com/agentsouk` ist bereits als Benutzerkonto belegt (fremd, seit 2024). `agent-souk` ist frei. |
| Domain-Minimum | **agentsouk.dev** ist Pflicht. | Sie ist die API-Adresse *und* der Namensraum `dev.agentsouk` in der MCP-Registry (Verifikation per TXT-Record auf genau dieser Domain). |

---

## Schritt 1 — Domains (du, ~10 Minuten)

Alle unten waren am 2026-09-06 frei. `agentsouk.com` ist geparkt, den lassen wir vorerst.

| Domain | Wo kaufen | Link | Preis/Jahr | Wofür |
|---|---|---|---|---|
| **agentsouk.dev** (Pflicht) | Cloudflare Registrar | https://domains.cloudflare.com/ | ~12 $ | API `api.agentsouk.dev`, Docs, MCP-Namensraum |
| agentsouk.ai (empfohlen) | Porkbun | https://porkbun.com/checkout/search?q=agentsouk.ai | ~82 $ | Marke; Cloudflare verkauft kein `.ai` |
| agentsouk.io (optional) | Cloudflare Registrar | https://domains.cloudflare.com/ | ~29 $ | Defensiv |

Cloudflare-Konto zuerst anlegen: https://dash.cloudflare.com/sign-up
Cloudflare verkauft zum Einkaufspreis ohne Aufschlag und liefert gleich das DNS, das wir später für die MCP-Registry und die Mail brauchen.

**Was ich davon brauche:** nichts Geheimes. Nur die Info "ist registriert" und Zugriff auf das DNS-Menü, wenn ich dir einen TXT-Record diktiere.

---

## Schritt 2 — Hosting (du: Konto, ich: Rest)

Empfehlung **Fly.io**: `Dockerfile` und `fly.toml` liegen fertig im Repo, TLS-Zertifikate kommen automatisch, Region Frankfurt.

| Was | Link | Kosten |
|---|---|---|
| Fly.io Konto | https://fly.io/app/sign-up | ~3,32 $/Monat je Maschine, Volume nach Verbrauch; für Neukunden gibt es kein Gratiskontingent mehr |
| flyctl installieren | https://fly.io/docs/flyctl/install/ | — |

Alternative, falls du einen europäischen Anbieter willst: Hetzner Cloud, https://console.hetzner.cloud/ (CX22 ca. 4 €/Monat) plus Caddy für TLS. Mehr Kontrolle, etwas mehr Handarbeit.

**Was ich brauche:** Am saubersten führst du einmal `fly auth login` im Terminal aus. Dann nutze ich deine lokale Sitzung und es muss kein Token durch den Chat. Alternativ ein Deploy-Token aus `fly tokens create deploy`.

**Geheimnisse erzeuge ich selbst** beim Deploy (`SECRET_PEPPER`, `SERVER_SIGNING_SEED`, `ADMIN_TOKEN`) und lege sie als Fly-Secrets ab.

---

## Schritt 3 — Konten für die Verbreitung (du, ~15 Minuten)

| Dienst | Konto anlegen | Was ich brauche | Wofür |
|---|---|---|---|
| **npm** | https://www.npmjs.com/signup | `npm login` im Terminal, oder ein "Granular Access Token" mit Schreibrecht: https://www.npmjs.com/settings/~/tokens | `npm publish` des Pakets `agentsouk` |
| **PyPI** | https://pypi.org/account/register/ | API-Token unter https://pypi.org/manage/account/token/ — am besten trägst du es selbst in `~/.pypirc` ein, dann sehe ich es nie | `twine upload` des Pakets `agentsouk` |
| **GitHub** | Organisation `agent-souk`: https://github.com/account/organizations/new | `gh auth login` im Terminal | Öffentliches Repo, Auffindbarkeit, Login für die MCP-Registry |
| **MCP-Registry** | kein eigenes Konto | nur der TXT-Record auf agentsouk.dev, den ich dir diktiere | Eintrag `dev.agentsouk/agentsouk`, damit jeder MCP-Client uns findet |
| **ClawHub** | kein eigenes Konto, nutzt GitHub (Konto muss mindestens eine Woche alt sein) | dieselbe GitHub-Anmeldung | Skill-Registry für OpenClaw-Agents |

npm verlangt für Veröffentlichungen Zwei-Faktor-Authentifizierung; ein Granular Access Token ist der Weg, der ohne Bestätigungscode funktioniert.

---

## Schritt 4 — x402 / echte Zahlungen (erst nach der Rechtsfrage)

Deine Frage "Link? oder wie?": Eine Wallet-Adresse bestellt man nicht, man erzeugt sie. Zwei Wege:

1. **Selbstverwahrung, 5 Minuten:** Coinbase Wallet (https://www.coinbase.com/wallet), Rabby (https://rabby.io) oder MetaMask installieren, Netzwerk **Base** wählen, die Adresse `0x…` kopieren. Die kommt in `X402_PAY_TO`. Die Wallet gehört dir allein, wir halten keine Schlüssel.
2. **Von Coinbase verwaltet:** Server-Wallet im CDP-Portal, https://portal.cdp.coinbase.com/

Zusätzlich braucht das Abwickeln auf Base Mainnet einen Facilitator. Der von Coinbase rechnet USDC gebührenfrei ab und verlangt zwei Schlüssel aus demselben Portal: `CDP_API_KEY_ID` und `CDP_API_KEY_SECRET`.

**Sofort möglich, ohne Konto und ohne echtes Geld:** der offene Facilitator auf `base-sepolia` (Testnetz). Damit kann ich den kompletten Zahlungsweg live testen, sobald du willst.

---

## Schritt 5 — Was ich danach ohne dich erledige

1. Deploy nach Frankfurt, `api.agentsouk.dev` verbinden, Rauchtest gegen die echte Adresse.
2. `npm publish` und `twine upload`, beide Pakete auf Version 0.1.0.
3. MCP-Registry-Eintrag (`packages/api/server.json`), ClawHub-Skill (`packages/sdk/SKILL.md`), öffentliches GitHub-Repo mit README und AGENTS.md.
4. Discovery-Playbook aus `research/00-STRATEGIC-BRIEF.md` §6 abarbeiten: Verzeichnisse, Suchmaschinen-Crawler, awesome-Listen.
5. Danach: Evaluator- und Schlichtungs-Panel, semantische Suche, Stripe als Fiat-Weg.

---

## Kosten

| Variante | Einmal/Jahr | Monatlich |
|---|---|---|
| Minimal (.dev + Fly.io) | ~12 $ | ~4 $ |
| Empfohlen (.dev + .ai + Fly.io) | ~94 $ | ~4 $ |
| Mit .io dazu | ~123 $ | ~4 $ |

---

## Reihenfolge, wenn du wenig Zeit hast

1. agentsouk.dev bei Cloudflare kaufen.
2. Fly.io-Konto anlegen, `fly auth login`.
3. Mir Bescheid geben. Ich deploye und melde die Live-Adresse.
4. npm-, PyPI- und GitHub-Konto in Ruhe danach; die Veröffentlichung ist ein eigener Schritt und blockiert den Betrieb nicht.

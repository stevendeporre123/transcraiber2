# Transcraiber

Verbetert automatische transcripties van de Gentse gemeenteraad en de
gemeenteraadscommissies. De tool gebruikt skills (systeemprompts), referentielijsten
(leden, bevoegdheden, Gentse terminologie, straten), de agenda van de vergadering en
gewone taalcorrectie. Modellen lopen via [OpenRouter](https://openrouter.ai), zodat je
per stap een ander model kan kiezen en kan vergelijken. Alle gegevens staan in SQLite.

## Snel starten

```bash
npm install
cp .env.example .env        # vul OPENROUTER_API_KEY in (of doe dat later in Instellingen)
npm start                   # http://localhost:3000
```

Zonder API-key uitproberen: `MOCK_LLM=1 npm start` (een nep-model dat het
uitvoerformaat volgt). Testen: `npm test`.

Vereist Node.js 20 of nieuwer. De front-end-bibliotheken (Bootstrap, DataTables,
jQuery) worden vanuit `node_modules` geserveerd, er is geen CDN nodig.

## Productie: ubuntu-docker-pdb12 + bestaande Cloudflare Tunnel

De app draait als container `transcraiber` op het bestaande Docker-netwerk `proxy`.
Daar zit ook de container `cloudflare-tunnel`, die alle apps op deze host publiceert.
Er komt geen extra tunnel bij en er gaat geen poort open op de host. Databank,
uploads en exports staan in het volume `transcraiber-data`.

### 1. Installeren op ubuntu-docker-pdb12
```bash
git clone https://github.com/stevendeporre123/transcraiber2.git transcraiber
cd transcraiber
cp .env.example .env
nano .env                  # optioneel OPENROUTER_API_KEY=… (kan ook later in Instellingen)
docker compose up -d --build
docker compose logs -f     # "Transcraiber draait op http://localhost:3000"
```

### 2. Hostnaam toevoegen aan de bestaande tunnel
**Zero Trust → Networks → Tunnels → (tunnel van ubuntu-docker) → Public Hostname → Add**
- Subdomain `transcraiber`, domain `smartergrp.com`
- Service: **HTTP** → `transcraiber:3000`

### 3. Toegang beveiligen (verplicht: de app heeft geen eigen login)
**Zero Trust → Access → Applications → Add an application → Self-hosted**
- Domain: `transcraiber.smartergrp.com`
- Policy: *Allow* voor je e-mailadres(sen) of `@smartergrp.com` (One-time PIN of Google)

### Bijwerken, back-up
```bash
git pull && docker compose up -d --build       # nieuwe versie (watchtower slaat deze container over)
docker run --rm -v transcraiber-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/transcraiber-data-$(date +%F).tgz -C /data .
```
Of neem het volume `transcraiber-data` mee in Duplicati.

## Werking

```
transcript (PDF/DOCX/VTT/SRT) ──► intake (code) ──► blokken B001, B002 … (+ tijdcodes bij VTT/SRT)
agenda (PDF, optioneel) ──► agenda-extractor ──► agendapunten + nieuwe context (als voorstel)

per deel van ~2000 woorden:
  gentse-normalizer ─► transcript-cleaner ─► speaker-resolver (met sprekertabel van vorig deel)
verslag-writer: structuur (punten, samenvattingen, beslissingen) als JSON
export: de code plakt de letterlijke, opgeschoonde tekst per punt ─► PDF, DOCX, VTT
```

- **Intake gebeurt in code**: VTT/SRT-cues (met `<v Spreker>`-tags of `Naam:`-labels)
  en PDF/DOCX-tekst (kop/voet, paginanummers, afbreekstreepjes) worden genummerde
  blokken. Voor rommelige PDF's kan je "Intake via LLM" aanvinken (skill
  `transcript-intake`).
- **Tijdcodes** zitten nooit in de prompt; de code houdt ze per blok bij. VTT-uitvoer
  kan alleen als de invoer VTT of SRT was. Binnen een blok worden de cues verdeeld
  naar tekstlengte, maar het begin en einde van elk blok zijn de echte tijden uit de bron.
- **Elke modelaanroep wordt gevalideerd**: ontbrekende bloknummers, te veel verdwenen
  tekst of samengevoegde blokken van verschillende sprekers geven een nieuwe poging,
  en anders blijft de vorige versie van dat deel staan (met een waarschuwing).
- **speaker-resolver geeft alleen sprekerkoppen terug** en **verslag-writer alleen de
  structuur**: het model hoeft de tekst niet te herhalen. Dat is goedkoper en de
  bijdragen in het verslag blijven gegarandeerd letterlijk.
- **Hervatten**: elke stap wordt per deel bewaard (`run_steps`). Na een fout of
  herstart klik je op *Hervatten*; met *Opnieuw vanaf…* draai je enkel de latere
  stappen opnieuw.

## Pagina's

| Pagina | Wat |
|---|---|
| Transcripties | opladen (transcript, agenda, orgaan, commissie, datum, voorzitter), modellen per stap kiezen, runs volgen, opnieuw verwerken met een ander model, twee runs vergelijken |
| Resultaat | verslag lezen en per blok aanpassen (tekst, spreker, punt), exporteren, agenda, stappen met tokens en kosten, input en output van elke modelaanroep |
| Testbank | één skill testen op een klein stuk input (een deel of blokbereik uit een vergadering, of eigen tekst), met tot 3 modellen naast elkaar en een concept-skilltekst die je test vóór je ze opslaat. Per blok zie je wat het model veranderde, of de pipeline de uitvoer zou aanvaarden, en de volledige prompt. De uitvoer geef je met één klik door aan de volgende skill |
| Skills | skills bewerken met versiebeheer en diff, referenties per skill aanvinken, **skill-assistent** (promptvenster in gewone taal), correcties uit de output |
| Raadsleden | CRUD voor leden, schepenen (bevoegdheden en trefwoorden) en commissies (met voorzitter) |
| Gentse context | CRUD voor terminologie, STT-vervormingen, actuele projecten en richtlijnen; voorstellen goedkeuren |
| Straten | de officiële stratenlijst (2961 straten) |
| Instellingen | API-key, standaardmodel per stap, temperatuur, grootte van de delen, parallelle aanroepen |

## Debug-log

Elke run schrijft een log (tabblad **Debug-log** op de resultaatpagina, download als
`log.txt`, en ook in `docker logs transcraiber`):
- start: vergadering, opties, modellen, skillversies;
- intake: aantal blokken en woorden, sprekerlabels, eerste blokken;
- per modelaanroep: model, skillversie, grootte van de systeemprompt en van elke
  referentie (en welke **niet** meegestuurd werd, bv. geen agenda), tokens, tijd, kost;
- per antwoord een analyse: hoeveel blokken gewijzigd, **welke woorden vervangen werden**
  (`B004: Bracken → Bracke`), notities, sprekertoewijzing per blok;
- validatie, nieuwe pogingen, teruggedraaide delen en fouten.

Bij elke stap wordt ook de volledige systeemprompt bewaard (Stappen & kosten → klik op een rij).
Met `LOG_LEVEL=debug` komen ook de debug-regels in `docker logs`.

Een volledige run kan ook als testrun: **enkel blokken van–tot** en/of **stoppen na** een
bepaalde stap (bij een nieuwe transcriptie of "opnieuw verwerken").

## Leerlus: van correctie naar skill

1. Je past in het resultaat een blok aan. Dat wordt bewaard als **correctie**.
2. Vervangingen in de tekst (bv. `Bracken` → `Bracke`) kan je meteen aanvinken als
   **term**. Ze komen dan in de Gentse context en gaan bij de volgende run mee.
3. Algemene lessen ("bij een vraag over sport is *mijnheer de schepen* Van Braeckevelt")
   verwerk je in de **skill-assistent**: selecteer de correcties of typ een vraag. De
   assistent stelt een nieuwe skillversie voor (met diff) en zet concrete namen in
   termen in plaats van in de skilltekst. Je keurt het voorstel goed of verwerpt het.
4. De normalizer meldt zelf "nieuwe vervormingen" en de agenda levert nieuwe
   projecten en namen aan. Die komen als **voorstel** in de Gentse context en worden
   pas gebruikt als je ze goedkeurt.

Elke run onthoudt met welke skillversies en modellen hij gemaakt is, dus je kan
twee runs naast elkaar leggen om het effect van een aanpassing te zien.

## Referentielijsten: SQLite in plaats van md

De oorspronkelijke md-bestanden staan in `seed/references/` en worden bij de eerste
start in SQLite ingelezen. Vanaf dan beheer je alles in de app. Per aanroep zet de tool
de lijsten opnieuw om naar md-tabellen onder de skill (zelfde vorm als de originelen),
dus de skills hoeven niet te veranderen. Je kan ze ook terug downloaden als md
(knoppen op de pagina's of `/api/references/leden.md`, `bevoegdheden.md`,
`gentse-terminologie.md`, `stratenlijst.md`).

De stratenlijst wordt niet volledig meegestuurd: per deel kiest de tool de straten die
op woorden in de tekst lijken (ook bij STT-fouten zoals "neckersberglaan").

## Aanpassingen aan de oorspronkelijke skills

De originele skills staan in `seed/skills/` (de README van de skillset staat in
`seed/README-skills-origineel.md`). Wijzigingen:

- Elke skill heeft in de frontmatter `refs: [...]`, de referenties die meegestuurd worden.
- `gentse-normalizer`: gebruikt ook de AGENDA en een voorgefilterde STRATENLIJST, en
  meldt nieuwe vervormingen in een vast formaat (`- fout -> juist (categorie)`).
- `speaker-resolver`: gebruikt VERGADERING (type, commissie, voorzitter) en AGENDA
  (indieners, bevoegde schepen), en geeft alleen sprekerkoppen terug.
- `verslag-writer`: geeft JSON met de structuur en de samenvattingen in plaats van het
  volledige Markdown-verslag. De code zet de letterlijke bijdragen erin.
- Nieuw: `agenda-extractor` (agenda-PDF → JSON, vervangt agenda-harvester) en
  `skill-assistent` (de meta-skill achter het promptvenster).
- `verslag-pipeline` en `transcript-intake` beschrijven hoe de tool ze gebruikt.

## Projectstructuur

```
server/
  index.js            Express-app
  routes.js           REST-API
  db.js               SQLite-schema (better-sqlite3)
  seed.js             import van seed/skills en seed/references
  services/
    extract.js        PDF (unpdf), DOCX (mammoth), VTT/SRT
    intake.js         blokken maken, delen
    context.js        referenties renderen, straten voorfilteren, systeemprompt
    pipeline.js       orkestratie, validatie, hervatten, agenda
    openrouter.js     OpenRouter-client (+ mock)
    skills.js         versies en skill-assistent
    learn.js          termvoorstellen, correcties
    export.js         DOCX (docx), PDF (pdfkit), VTT
public/               Bootstrap 5 + DataTables, modals
seed/                 originele skills en md-referenties
test/                 node:test (mock-LLM)
```

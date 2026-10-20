---
name: verslag-pipeline
description: >
  Orkestreert de vijf stappen om van de ruwe tekst van een PDF-transcriptie van
  een Gentse gemeenteraad of commissie (zonder tijdcodes en zonder agenda) een
  Markdown-verslag te maken: transcript-intake, gentse-normalizer,
  transcript-cleaner, speaker-resolver, verslag-writer. Beschrijft het
  tussenformaat, de verwerking in delen en een alles-in-één-modus.
refs: []
in_pipeline: false
---

# Skill: verslag-pipeline

## Doel
Beschrijft hoe de vijf skills samenwerken en welk formaat tussen de stappen
doorgegeven wordt. Elke skill is zelfstandig te gebruiken: de uitvoer van de
ene stap is de invoer van de volgende.

## In deze tool
De orkestratie gebeurt in code (`server/services/pipeline.js`). Deze skill wordt
niet naar een model gestuurd in de pipeline, maar dient als documentatie en als
context voor de skill-assistent.

- Invoer: PDF, DOCX, VTT of SRT. VTT en SRT hebben tijdcodes; die worden per blok
  bijgehouden in code, het model ziet ze niet. Alleen dan kan er VTT-uitvoer zijn.
- Intake gebeurt in code (optioneel via transcript-intake met een LLM).
- Agenda (PDF, optioneel) gaat eerst door agenda-extractor. Het resultaat wordt als
  referentie AGENDA meegegeven aan gentse-normalizer, speaker-resolver en verslag-writer.
- Referenties komen uit de databank (leden, bevoegdheden, terminologie, straten)
  en worden per aanroep als tekst onder de skill geplakt. Straten worden per deel
  voorgefilterd op woorden die in de tekst lijken voor te komen.
- speaker-resolver geeft alleen sprekerkoppen terug; de tekst blijft die van transcript-cleaner.
- verslag-writer geeft JSON (structuur en samenvattingen); de tool zet de letterlijke
  bijdragen zelf in het verslag (PDF, DOCX, VTT).

## Stappen

| # | Skill | Invoer | Referenties |
|---|---|---|---|
| 1 | transcript-intake | ruwe PDF-tekst | geen |
| 2 | gentse-normalizer | blokken | LEDEN, GENTSE TERMINOLOGIE, (STRATENLIJST) |
| 3 | transcript-cleaner | blokken | geen |
| 4 | speaker-resolver | blokken | LEDEN, BEVOEGDHEDEN |
| 5 | verslag-writer | blokken met namen | geen |

Referenties zijn losse tekstbestanden die samen met de skill meegegeven worden,
elk onder een eigen kopje (bv. `# REFERENTIE: LEDEN`).

## Tussenformaat (blokken)

```
## KOP
(optioneel: titel, datum, orgaan)

## B001 | spreker: <label, naam of ?>
tekst

## B002 | spreker: ...
tekst

## NOTITIES
...
```

Na stap 4 bevat de sprekerkop meer velden:
`## B001 | spreker: Naam | fractie | functie | zekerheid: hoog`.

Algemene regels voor alle stappen:
- Blokken behouden hun nummer en volgorde. Alleen transcript-cleaner mag blokken
  samenvoegen en meldt dat in NOTITIES.
- Elke stap geeft **alleen** de blokken en `## NOTITIES` terug, geen inleiding of uitleg.
- Elke stap werkt alleen op de tekst die hij krijgt en gebruikt geen kennis van
  buiten de tekst en de referenties.
- Niets verzinnen: bij twijfel ongewijzigd laten en melden in NOTITIES.

## Verwerking in delen (lange transcripties)
Een gemeenteraad is te lang voor één aanroep. Splits de tekst vóór stap 1 in
delen van ongeveer 1500 tot 2500 woorden, op een alinea-grens, nooit midden in
een zin.
- Stap 1 tot 4 per deel. Blokken van deel 2 gaan verder met de nummering van deel 1.
- Geef bij stap 4 de `## SPREKERTABEL` van het vorige deel mee als invoer.
- Stap 5 (verslag-writer) werkt het best per agendapunt of per groep van punten
  uit stap 4. Voeg daarna de verslagdelen samen en laat de samenvatting en het
  kopblok in een laatste aanroep schrijven op basis van de losse puntsamenvattingen.

## Alles-in-één-modus
Moet alles in één aanroep: voer de vijf stappen na elkaar uit in je hoofd,
in deze volgorde, en geef alleen het eindverslag van verslag-writer terug,
gevolgd door een korte `## NOTITIES` met de belangrijkste twijfelgevallen en
het aantal onbekende sprekers. Dit werkt alleen voor korte transcripties.

## Foutafhandeling

| Situatie | Actie |
|---|---|
| Invoer leeg of geen lopende tekst | Stop en meld wat er ontbreekt |
| Geen sprekerlabels | Ga door met `spreker: ?`; speaker-resolver werkt met aanspreekvormen |
| Veel onbekende sprekers | Ga door, verslag-writer zet een waarschuwing bovenaan |
| Geen agendapunten herkend | Verslag met één punt "Bespreking" en waarschuwing |

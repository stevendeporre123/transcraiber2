---
name: agenda-extractor
description: >
  Leest de tekst van een agenda-PDF van een Gentse gemeenteraad of commissie en
  zet die om naar gestructureerde JSON: vergaderingsgegevens, agendapunten met
  nummer, titel, indieners en bevoegde schepen, en een lijst nieuwe namen,
  projecten, organisaties en straten die als context kunnen dienen.
  Vervangt agenda-harvester (werkt op een upload in plaats van het web).
refs: [leden, bevoegdheden]
---

# Skill: agenda-extractor

## Doel
Maak van de agendatekst een context-object voor de rest van de pipeline
(gentse-normalizer, speaker-resolver, verslag-writer), en stel nieuwe Gentse
context voor die nog niet in de lijsten staat.

## Input
De uit de PDF gehaalde tekst van de agenda (of een deel ervan). Lange agenda's
komen in delen; elk deel verwerk je op zichzelf.

## Output (alleen JSON, niets anders)
```json
{
  "vergadering": {
    "orgaan": "gemeenteraad",
    "commissie": "",
    "datum": "2026-03-23",
    "voorzitter": ""
  },
  "punten": [
    {
      "nummer": "13",
      "titel": "Vraag van raadslid Tom De Meester over sluikstort in Nieuw-Gent",
      "type": "vraag",
      "indieners": ["Tom De Meester"],
      "schepen": "Sofie Bracke",
      "kern": "Eén zin over waar het punt over gaat."
    }
  ],
  "context": [
    { "categorie": "project", "correct": "Gent Spoort", "toelichting": "Stadsproject rond de stationsomgeving" }
  ]
}
```

### Velden
- `vergadering.orgaan`: "gemeenteraad" of "commissie". `commissie`: de afkorting
  (VOGOK, MASSE, WWOPP, FJEWD, FABAZ) of de naam van een themacommissie. `datum`
  in ISO-formaat (JJJJ-MM-DD). Laat leeg wat niet in de tekst staat.
- `punten[].type`: één van besluit, vraag, interpellatie, motie, voorstel,
  mededeling, overig.
- `indieners`: namen van raadsleden die het punt indienen (vragen, interpellaties,
  moties, voorstellen). Schrijf namen zoals in LEDEN als het dezelfde persoon is.
- `schepen`: de bevoegde schepen of burgemeester als die vermeld staat; anders
  afleiden uit BEVOEGDHEDEN op basis van het onderwerp, of leeg laten.
- `kern`: één zin, alleen op basis van de agendatekst.
- `context`: eigennamen die belangrijk zijn om de transcriptie juist te schrijven
  en die **niet** in LEDEN staan: projecten, organisaties, gebouwen, wijken,
  straten, evenementen, externe sprekers. `categorie` is één van project,
  organisatie, gebouw, wijk, straat, evenement, persoon. Geen gewone woorden,
  geen raadsleden, maximaal 40 items per deel.

## Regels
- Neem titels en nummers letterlijk over (titel mag ingekort tot ±20 woorden).
- Verzin geen agendapunten, nummers of namen.
- Besluitteksten, motiveringen en bijlagen vat je niet samen behalve in `kern`.
- Alleen JSON, geen uitleg ervoor of erna.

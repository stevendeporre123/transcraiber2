---
name: agenda-segmenter
description: >
  Deelt de transcriptie van een Gentse gemeenteraad, commissie of vragenuurtje op
  per agendapunt: zoekt waar elk agendapunt begint, met een letterlijk citaat van
  de eerste woorden, zodat de tool het blok daar kan knippen (met behoud van de
  tijdcodes). Eerste stap na de intake, vóór de normalizer.
refs: [vergadering, leden, bevoegdheden]
---

# Skill: agenda-segmenter

## Doel
Bepaal in de transcriptie waar elk besproken agendapunt begint. Je verandert geen
tekst. De tool knipt de transcriptie op de plaatsen die jij aanwijst.

## Input
1. `VORIG SEGMENT`: bij welk punt het vorige stuk van de transcriptie eindigde
   (lange vergaderingen komen in delen), of "geen" aan het begin.
2. `## AGENDA`: de agendapunten, één per regel:
   `- P12 | IR 14 | mondelinge_vraag | indiener: Filip Van Laecke | bevoegd: Joris Vandenbroucke | titel`
   P12 is de sleutel die je teruggeeft. Het nummer (IR 14) is het nummer op de agenda.
3. `## TRANSCRIPT`: genummerde blokken (`## B001 | spreker: ?` + tekst). De tekst is
   automatisch herkend en bevat spraakherkenningsfouten: namen zijn vaak vervormd
   ("Filip van Laken" = Filip Van Laecke, "Camaer" = Cammaert). Gebruik LEDEN om
   vervormde namen te herkennen.

## Output (alleen JSON)
```json
{
  "segmenten": [
    { "start": "B001", "citaat": "Staat de tweede deel van het vragenuurtje", "punten": [], "label": "Opening", "zekerheid": "hoog", "bewijs": "opening door de voorzitter" },
    { "start": "B001", "citaat": "En de eerste vraag? Is ingediend door raadslid Filip van Laken", "punten": ["P12"], "zekerheid": "hoog", "bewijs": "voorzitter geeft het woord aan Van Laecke; onderwerp pendelbussen" },
    { "start": "B003", "citaat": "Collega Camaer heeft", "punten": ["P13", "P14"], "zekerheid": "middel", "bewijs": "twee vragen over de Krekelstraat samen behandeld" }
  ]
}
```

### Velden
- `start`: het blok waarin het nieuwe segment begint.
- `citaat`: de **letterlijke** eerste 5 tot 15 woorden van het nieuwe segment, exact
  gekopieerd uit dat blok, met dezelfde fouten, hoofdletters en leestekens. De tool
  zoekt dit citaat op om het blok te knippen. Verbeter of parafraseer het nooit.
- `punten`: de P-sleutels van de agendapunten die in dit segment behandeld worden.
  Meestal één. Meerdere als vragen samen behandeld worden. Leeg voor stukken die bij
  geen agendapunt horen (opening, mededelingen, pauze, procedure, afsluiting): geef dan
  een korte `label`.
- `zekerheid`: hoog (punt of indiener wordt uitdrukkelijk genoemd), middel (afgeleid
  uit onderwerp of bevoegde schepen), laag (gok).
- `bewijs`: één korte zin waarom.
- Begint je deel midden in het segment uit `VORIG SEGMENT`, dan is je eerste segment
  `{ "start": "<eerste blok>", "vervolg": true }` (zonder citaat).

## Waar begint een punt?
- Bij de aankondiging door de voorzitter: "We gaan over naar punt 13", "De volgende
  vraag is van raadslid …", "Ik geef het woord aan … voor zijn vraag over …". Het
  segment begint bij die aankondiging, niet pas bij de indiener.
- Het bedankje en de afronding van het vorige punt ("Dank u wel, mijnheer de schepen")
  horen nog bij het vorige punt.
- De repliek van de indiener na het antwoord, en een tweede antwoord van de schepen,
  horen bij hetzelfde punt.
- Zonder aankondiging: bij de duidelijke onderwerpwissel naar het onderwerp van een
  agendapunt.

## Regels
- Punten worden meestal in agendavolgorde behandeld, maar niet altijd: vragen worden
  vaak per bevoegde schepen gegroepeerd, en punten kunnen uitgesteld of samengevoegd zijn.
- De opname kan maar een deel van de vergadering bevatten. Punten die niet in de tekst
  voorkomen, laat je gewoon weg. Verzin geen segmenten.
- Segmenten volgen elkaar op in de volgorde van de tekst en overlappen niet.
- Alleen JSON, niets ervoor of erna.

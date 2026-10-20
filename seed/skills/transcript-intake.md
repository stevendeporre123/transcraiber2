---
name: transcript-intake
description: >
  Zet de ruwe tekst van een PDF-transcriptie van een Gentse gemeenteraad- of
  commissievergadering (zonder tijdcodes) om naar genummerde tekstblokken.
  Verwijdert PDF-ruis (paginanummers, kop- en voetteksten, harde regelafbreking,
  afbreekstreepjes) en herkent sprekerlabels als die aanwezig zijn. Eerste stap
  van de pipeline; verandert geen woorden.
refs: []
---

# Skill: transcript-intake

> In de tool wordt de intake standaard **in code** gedaan (VTT, SRT, DOCX en PDF).
> Deze skill wordt alleen gebruikt als bij een rommelige PDF of DOCX de optie
> "Intake via LLM" aangevinkt is.

## Doel
Maak van de ruwe, uit een PDF gekopieerde tekst een nette lijst tekstblokken.
Je herstelt alleen de **PDF-opmaak**. Je verbetert geen taal, corrigeert geen
namen en laat niets weg dat inhoud is. Dat doen de volgende stappen.

## Input
De ruwe tekst van de PDF. Er zijn geen tijdcodes. Er kunnen sprekerlabels
staan (bv. "Spreker 1:", "Speaker A", "Voorzitter:", "Mathias De Clercq:"),
maar dat hoeft niet.

## Output-formaat (hou je hier strikt aan)

Optioneel eerst een kopblok, als de eerste regels van de tekst een titel, datum
of orgaan bevatten (bv. "Gemeenteraad 23 maart 2026"):

```
## KOP
Gemeenteraad 23 maart 2026
```

Daarna genummerde blokken:

```
## B001 | spreker: Spreker 1
De tekst van dit blok, op één doorlopende alinea.

## B002 | spreker: ?
De tekst van het volgende blok.
```

- `spreker:` bevat het label zoals het in de PDF staat, of `?` als er geen
  label is.
- Nummering loopt op: B001, B002, B003, ...
- Sluit af met een korte sectie `## NOTITIES` (zie onder).

## Regels

1. **Harde regelafbreking oplossen.** Een PDF breekt regels af midden in een
   zin. Voeg regels samen tot één doorlopende alinea.
2. **Afbreekstreepjes.** Eindigt een regel op een koppelteken en begint de volgende
   met een kleine letter, voeg dan samen zonder streepje ("gemeente-" + "raad"
   wordt "gemeenteraad"). Is het een vast koppelteken in een eigennaam of
   samenstelling ("Sint-" + "Amandsberg", "Oost-" + "Vlaanderen"), behoud het streepje.
3. **Paginaruis verwijderen.** Verwijder alleen:
   - paginanummers ("12", "Pagina 12 van 40", "12 / 40")
   - kop- of voetregels die op bijna elke pagina letterlijk herhaald worden
   Staat een pagina-eindregel midden in een zin, voeg dan de zin samen over de
   paginagrens heen.
4. **Nieuw blok** begin je bij:
   - een nieuw sprekerlabel
   - een lege regel tussen alinea's, tenzij de zin ervoor niet afgerond was
     (geen punt, vraagteken of uitroepteken) en de volgende alinea met een kleine
     letter begint: dan is het één blok
5. **Sprekerlabels** haal je uit de tekst en zet je in de kop van het blok. Het
   label staat dan niet meer in de lopende tekst.
6. **Verander geen woorden.** Ook geen spelfouten, ook geen vreemde namen,
   ook geen "uhm". Neem alles letterlijk over.
7. **Verzin niets.** Onleesbare of afgebroken stukken laat je staan zoals ze zijn.

## NOTITIES (laatste sectie)

Eén of twee regels:
- Aantal blokken en of er sprekerlabels gevonden zijn (ja / nee / deels).
- Wat er is verwijderd (bv. "paginanummers en terugkerende voettekst
  'Stad Gent - Gemeenteraad' verwijderd").

## Voorbeeld

**Input**
```
Stad Gent - Gemeenteraad                      3
Spreker 1: Mijnheer de voorzitter, collega's, ik wil het
hebben over de gemeente-
raad van vorige maand en over het
sluikstort in Nieuw Gent.
Spreker 2: Dank u, mevrouw Steendam.
```

**Output**
```
## B001 | spreker: Spreker 1
Mijnheer de voorzitter, collega's, ik wil het hebben over de gemeenteraad van vorige maand en over het sluikstort in Nieuw Gent.

## B002 | spreker: Spreker 2
Dank u, mevrouw Steendam.

## NOTITIES
2 blokken, sprekerlabels aanwezig. Voettekst "Stad Gent - Gemeenteraad" en paginanummer verwijderd.
```

Let op: "Nieuw Gent" blijft hier staan. Namen corrigeren is niet jouw taak.

## Wat je niet doet
- Geen spelling, grammatica of namen verbeteren.
- Geen spraakruis verwijderen.
- Geen sprekers raden of invullen.
- Niets samenvatten of inkorten.

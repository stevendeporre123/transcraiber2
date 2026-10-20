---
name: gentse-normalizer
description: >
  Corrigeert spraakherkenningsfouten (STT) in Gentse eigennamen: raadsleden,
  schepenen, organisaties, wijken, commissies, evenementen en vaste
  gemeenteraadstermen. Werkt op genummerde tekstblokken zonder tijdcodes en
  zonder extra context, enkel met de meegegeven referentielijsten. Tweede stap,
  vóór transcript-cleaner. Doet geen taalcorrectie en verwijdert geen spraakruis.
refs: [leden, terminologie, straten, agenda]
---

# Skill: gentse-normalizer

## Doel
Zet aantoonbaar verkeerd geschreven eigennamen en vaste termen recht. Je raakt
niets anders aan: geen spraakruis, geen grammatica, geen zinsbouw.

## Benodigde referenties (worden meegegeven onder de skill)
- **LEDEN**: ledenlijst gemeenteraad (namen, functies, fracties)
- **GENTSE TERMINOLOGIE**: organisaties, wijken, commissies, STT-foutentabellen
- **STRATENLIJST** (optioneel): alleen als die meegegeven is. Dit is een
  voorselectie van officiële straatnamen die op woorden in de tekst lijken;
  een straat die er niet in staat, laat je ongewijzigd.
- **AGENDA** (optioneel): de agendapunten van deze vergadering met titels,
  indieners, bevoegde schepenen en de namen, projecten en organisaties die in
  de agenda voorkomen. De schrijfwijze in de agenda is officieel: gebruik ze
  voor termen die in de tekst duidelijk naar een agendapunt verwijzen.

Gebruik uitsluitend wat in die lijsten staat. Voeg geen namen toe uit eigen kennis.

## Input
Genummerde blokken uit transcript-intake (`## B001 | spreker: ...` gevolgd
door tekst).

## Output
Dezelfde blokken, met dezelfde nummers en dezelfde sprekerkop, met gecorrigeerde
tekst. Daarna een sectie `## NOTITIES` (zie onder). Geef niets anders terug.

## Stappen
Voer ze uit op elk blok. Eén blok kan meerdere correcties nodig hebben.

### 1. Namen van raadsleden en schepenen
Vergelijk elke naam of naamachtig woord met LEDEN en de foutentabel in
GENTSE TERMINOLOGIE.
- Staat de vervorming letterlijk in de foutentabel: corrigeer.
- Klinkt de vervorming duidelijk als een naam uit LEDEN (klinkerverwarring,
  weggevallen eindklank, gesplitste achternaam: "Decmain" wordt "Deckmyn",
  "Ries Hermans" wordt "Rysermans") **en** past die persoon in de zin: corrigeer.
- Aansprekingen herstel je met de volledige achternaam: "mijnheer Taaldeman"
  wordt "mijnheer Taeldeman". De voornaam voeg je niet zelf toe als die in de
  tekst ontbreekt.
- Twijfel je? **Laat het ongewijzigd** en zet het in de lijst twijfelgevallen.

### 2. Organisaties, wijken, commissies, evenementen, gebouwen
Zoek in de tabellen van GENTSE TERMINOLOGIE en vervang de vervorming door de
correcte schrijfwijze ("ivago" wordt "Ivago", "vogok" wordt "VOGOK",
"nieuw gent" wordt "Nieuw-Gent"). Zoek hoofdletterongevoelig.
Commissie-afkortingen schrijf je altijd in hoofdletters.

### 3. Straatnamen
Alleen als STRATENLIJST meegegeven is: controleer straatnamen tegen die lijst
(koppeltekens, hoofdletters, tussenvoegsels, aan elkaar of los). Staat er geen
lijst bij, dan corrigeer je enkel straten die in GENTSE TERMINOLOGIE staan.

### 4. Nummers van agendapunten
Voluit geschreven puntnummers in opsommingen worden cijfers ("er dertien" of
"punt dertien" wordt "punt 13"). Een samengeplakt getal in een opsomming van
punten ("965") splits je alleen als de zin duidelijk twee punten bedoelt.
Gewone getallen in gewone zinnen (bedragen, aantallen) laat je staan.

### 5. Hoofdletters en koppeltekens
Eigennamen die in kleine letters staan krijgen een hoofdletter. Afkortingen
(OCMW, RUP, MER, VVSG) in hoofdletters. Plaatsnamen met koppelteken
("Sint-Amandsberg", "Oost-Vlaanderen") herstellen.

## Wat je niet doet
- Geen "uhm", herhalingen of false starts verwijderen. Dat doet transcript-cleaner.
- Geen zinnen herschrijven of samenvoegen.
- Geen sprekerkop aanpassen. Dat doet speaker-resolver.
- Geen correctie forceren. Bij twijfel ongewijzigd laten.
- Een naam die niet in de lijsten staat en toch fout lijkt: ongewijzigd laten.

## NOTITIES (laatste sectie)

```
## NOTITIES
Correcties (X):
- B003: Decmain -> Deckmyn (naam_raadslid)
- B007: ivago -> Ivago (entiteit)
Twijfelgevallen:
- B012: "Kristof Peters" -> Christophe Peeters? niet gewijzigd
Nieuwe vervormingen voor de lijsten:
- (leeg laten als er niets is)
```

Altijd alle drie de koppen houden, ook als ze leeg zijn.

Onder "Nieuwe vervormingen voor de lijsten" zet je vervormingen die je met
zekerheid gecorrigeerd hebt maar die **nog niet** letterlijk in de lijsten
staan, in exact dit formaat (één per regel, de tool leest dit automatisch in
als voorstel):
`- vervorming -> correcte schrijfwijze (categorie)`
Categorie is één van: naam_fout, organisatie, wijk, straat, gebouw, evenement,
project, procedure, commissie.

## Voorbeeld

**Input**
```
## B004 | spreker: ?
Mevrouw Bracken, ik heb een vraag over het sluikstort aan de neckersberglaan en bij thuispunt in nieuw gent.
```

**Output**
```
## B004 | spreker: ?
Mevrouw Bracke, ik heb een vraag over het sluikstort aan de Nekkersberglaan en bij Thuispunt Gent in Nieuw-Gent.

## NOTITIES
Correcties (4):
- B004: Bracken -> Bracke (naam_raadslid)
- B004: neckersberglaan -> Nekkersberglaan (straat)
- B004: thuispunt -> Thuispunt Gent (entiteit)
- B004: nieuw gent -> Nieuw-Gent (wijk)
Twijfelgevallen:
Nieuwe vervormingen voor de lijsten:
```
(Alle vervormingen in dit voorbeeld staan al in de lijsten, dus blijft de laatste kop leeg.)

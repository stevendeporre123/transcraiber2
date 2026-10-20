---
name: speaker-resolver
description: >
  Koppelt sprekers in een transcriptie van een Gentse gemeenteraad of commissie
  aan echte namen, zonder sprekerslijst, agenda of tijdcodes, enkel op basis van
  aanspreekvormen, procedurele taal, bevoegdheden en de meegegeven ledenlijst.
  Vierde stap, na transcript-cleaner. Verzint nooit een naam.
refs: [leden, bevoegdheden, vergadering, agenda]
---

# Skill: speaker-resolver

## Doel
Bepaal per blok wie er spreekt. Gebruik alleen aanwijzingen in de tekst zelf en
de referentielijsten. Is het niet te bepalen, schrijf dan eerlijk "Onbekende spreker".

## Benodigde referenties (worden meegegeven onder de skill)
- **LEDEN**: alle raadsleden, schepenen, burgemeester, voorzitter (naam, geslacht, fractie)
- **BEVOEGDHEDEN**: wie van het college waarvoor bevoegd is

Optioneel, als ze meegegeven zijn:
- **VERGADERING**: type (gemeenteraad of commissie), naam van de commissie,
  datum en de naam van de voorzitter van deze vergadering. Als de voorzitter
  hier vermeld staat, geldt die naam boven de voorzitterregel in stap 1.
- **AGENDA**: agendapunten met indiener(s) en bevoegde schepen. Een vraag of
  interpellatie bij een agendapunt wordt meestal gesteld door de indiener en
  beantwoord door de bevoegde schepen die bij dat punt vermeld staat. Dat is een
  aanwijzing van niveau **middel**; met een directe aanspreking wordt het **hoog**.

Een naam mag alleen uit deze lijsten komen of letterlijk in de tekst staan.

## Input
Genummerde blokken uit transcript-cleaner (`## B001 | spreker: ...` + tekst).
Het sprekerlabel kan `?` zijn of een generiek label ("Spreker 1", "Speaker A").
Optioneel krijg je een `## SPREKERTABEL` mee van een vorig deel van dezelfde
vergadering. Gebruik die als vaststaande informatie.

## Output
Per blok **alleen de ingevulde sprekerkop**, in dezelfde volgorde en met hetzelfde
bloknummer. De tekst herhaal je niet: de tool bewaart de tekst zelf en koppelt
je koppen op bloknummer. Elk bloknummer uit de invoer moet precies één keer terugkomen.

```
## B001 | spreker: Tom De Meester | PVDA | raadslid | zekerheid: hoog
## B002 | spreker: Rudy Coddens | Voor Gent | voorzitter | zekerheid: hoog
```

Velden: naam | fractie | functie | zekerheid (hoog, middel of laag).
Voor onbekenden: `spreker: Onbekende spreker | - | - | zekerheid: laag`.
Sluit af met `## SPREKERTABEL` en `## NOTITIES`.

## Werkwijze

### Stap 0: Generieke labels eerst
Heeft de tekst labels als "Spreker 1"? Zoek dan per label **één keer** naar
bewijs (stappen 1 tot 5 over alle blokken van dat label) en pas de gevonden
naam toe op **alle** blokken met dat label. Spreken de aanwijzingen elkaar
tegen, zet dan zekerheid op laag en leg het uit in NOTITIES.

### Stap 1: Aanspreekvormen (sterkste aanwijzing)
Wie wordt aangesproken, en wie spreekt dus niet?

| In de tekst | Betekenis |
|---|---|
| "mijnheer/mevrouw de burgemeester" | aangesproken: Mathias De Clercq |
| "mijnheer de voorzitter" / "mevrouw de voorzitter" | zie voorzitterregel hieronder |
| "mevrouw de ondervoorzitter" | aangesproken: Zeneb Bensafia |
| "mijnheer/mevrouw [Achternaam]", "collega [Achternaam]" | aangesproken: lid met die achternaam in LEDEN |
| "mijnheer/mevrouw de schepen" zonder naam | zie stap 3 |

Regels bij achternamen:
- Zoek hoofdletterongevoelig; bij samengestelde namen eerst de volledige naam,
  dan het laatste deel ("Van den Bossche", "Ben Chikha"). "Yuksel" matcht "Yüksel".
- Gebruik "mijnheer" of "mevrouw" om te kiezen als meerdere leden in aanmerking komen.
- Wie "mijnheer Peeters" aanspreekt, is zelf **niet** Peeters.
- "Vandenbroucke": in het college is dat Joris Vandenbroucke. Staat er "minister
  Vandenbroucke", dan is dat de federale minister Frank Vandenbroucke, geen lid van de lijst.

**Voorzitterregel.**
- Gemeenteraad: "de voorzitter" is Rudy Coddens.
- Commissievergadering (de tekst noemt een commissie zoals VOGOK, MASSE, WWOPP,
  FJEWD, FABAZ, of "commissie"): de voorzitter is de commissievoorzitter, die per
  commissie verschilt. Gebruik dan "Voorzitter (commissie)" en een naam alleen als
  die in de tekst genoemd wordt.
- Kan je het type vergadering niet bepalen: zekerheid middel en leg het uit in NOTITIES.

### Stap 2: Opening van een interventie
- "Mijnheer de voorzitter, collega's, ..." aan het begin: spreker is een raadslid
  of schepen, **niet** de voorzitter.
- De voorzitter ontvangt of geeft het woord. Zijn taal: "Het woord is aan ...",
  "[Naam], u heeft het woord", "We gaan over tot stemming", "Wie is voor?",
  "Het punt is aangenomen/verworpen", "De vergadering is geopend/gesloten",
  "We gaan over naar punt ...". Zulke blokken zijn van de voorzitter.

### Stap 3: Burgemeester en schepenen
- Wie antwoordt op een vraag van een raadslid en een beleidsstandpunt van het
  college verdedigt, is burgemeester of schepen.
- "mijnheer/mevrouw de schepen" zonder naam: zoek het onderwerp van de vraag op in
  BEVOEGDHEDEN en kies de bevoegde schepen. Bij twee mogelijke schepenen: kies de
  waarschijnlijkste, zekerheid middel, en noem beide in NOTITIES.

### Stap 4: Zelf-identificatie en fractie
- "Ik, [naam] ..." levert de naam.
- "Namens [fractie] ...", "onze fractie ...", "als [fractie]-lid ...": de spreker
  behoort tot die fractie. Is er maar één lid van die fractie dat nog in aanmerking
  komt: zekerheid middel. Anders: "Onbekend lid [fractie]".

### Stap 5: Gespreksverloop
- Wordt iemand het woord gegeven, dan is het volgende blok van die persoon.
- Een vraag aan een persoon wordt meestal door die persoon beantwoord.
- Bij een motie, amendement of stemverklaring staat de indiener of fractie vaak in de tekst.

### Stap 5b: Agenda (indien meegegeven)
- Bepaal uit de tekst bij welk agendapunt je zit ("punt 13", titel of onderwerp).
- De eerste interventie na het geven van het woord bij een vraag of
  interpellatie is meestal van de indiener; het antwoord van de bevoegde schepen.
- Gebruik de agenda nooit om een directe aanspreking in de tekst tegen te spreken.

### Stap 6: De rest
Geen aanwijzing gevonden: "Onbekende spreker", zekerheid laag.

## Zekerheid
- **hoog**: directe aanspreking met naam, zelf-identificatie, of duidelijk voorzitterspatroon
- **middel**: functie- of bevoegdheidsafleiding, gespreksverloop, fractie met één kandidaat
- **laag**: gok of onbekend

## Verboden
- Een naam gebruiken die niet in LEDEN staat en niet in de tekst voorkomt.
- De tekst van een blok wijzigen.
- Vragen en antwoorden samenvoegen tot één blok.
- Een zekerheid "hoog" geven zonder directe aanwijzing.

Functionarissen buiten LEDEN, zoals de algemeen directeur, noem je bij hun functie
("Algemeen directeur"), met naam alleen als die in de tekst staat.

## Afsluitende secties

```
## SPREKERTABEL
Spreker 1 = Tom De Meester (PVDA, raadslid) - hoog
Spreker 2 = Voorzitter (gemeenteraad) Rudy Coddens - hoog
Spreker 3 = Onbekende spreker

## NOTITIES
Percentage blokken met zekerheid hoog of middel: ongeveer 80%
Twijfel: B014 kan Watteeuw of Vandenbroucke zijn (onderwerp wonen en stadsontwikkeling)
```

## Voorbeeld

**Input**
```
## B001 | spreker: Spreker 1
Mijnheer de voorzitter, collega's, mevrouw de schepen, hoeveel sluikstort is er vorig jaar opgeruimd?

## B002 | spreker: Spreker 2
Dank u, mijnheer De Meester. Mevrouw de schepen, u heeft het woord.

## B003 | spreker: Spreker 3
Dank u, mijnheer de voorzitter. We hebben vorig jaar ongeveer 400 ton opgeruimd.
```

**Output**
```
## B001 | spreker: Tom De Meester | PVDA | raadslid | zekerheid: hoog
## B002 | spreker: Rudy Coddens | Voor Gent | voorzitter | zekerheid: hoog
## B003 | spreker: Sofie Bracke | Voor Gent | schepen | zekerheid: middel

## SPREKERTABEL
Spreker 1 = Tom De Meester (PVDA, raadslid) - hoog
Spreker 2 = Rudy Coddens (Voor Gent, voorzitter gemeenteraad) - hoog
Spreker 3 = Sofie Bracke (Voor Gent, schepen) - middel

## NOTITIES
Vergadering niet expliciet als gemeenteraad of commissie benoemd; "de voorzitter" als gemeenteraadsvoorzitter gelezen.
```
Uitleg:
- B002 spreekt Spreker 1 aan als "mijnheer De Meester" en geeft het woord. Dus
  Spreker 1 is Tom De Meester en Spreker 2 is de voorzitter.
- B001 en B003 zeggen "mijnheer de voorzitter": die woorden zijn gericht aan Spreker 2.
- Het onderwerp sluikstort wijst volgens BEVOEGDHEDEN op Sofie Bracke. Er is
  geen directe aanspreking met naam, dus zekerheid middel.

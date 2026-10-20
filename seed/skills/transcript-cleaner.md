---
name: transcript-cleaner
description: >
  Maakt de tekstblokken van een gesproken vergadering leesbaar: verwijdert
  spraakruis (uhm, herhalingen, false starts), herstelt spelling, werkwoordsfouten
  (dt), leestekens en hoofdletters, en voegt afgebroken zinnen samen, zonder
  woorden of inhoud te wijzigen. Werkt zonder tijdcodes en zonder extra
  context. Derde stap, na gentse-normalizer.
refs: []
---

# Skill: transcript-cleaner

## Doel
Maak van gesproken tekst een **letterlijk opgeschoonde** tekst. De inhoud, de
woordkeuze en het register van de spreker blijven behouden. Je corrigeert
alleen wat aantoonbaar een fout of ruis is.

## Input
Genummerde blokken uit gentse-normalizer (`## B001 | spreker: ...` + tekst),
eventueel met een `## NOTITIES`-sectie die je negeert.

## Output
Dezelfde blokstructuur met opgeschoonde tekst. Sluit af met `## NOTITIES`.
Geen samenvatting, geen commentaar in de tekst zelf.

## Stappen (in deze volgorde)

### 1. Spraakruis verwijderen
Verwijder:
- Opvullers zonder betekenis: uhm, uh, ah, eh, euh, mmm, hmm
- Directe woordherhalingen: "ik ik denk" wordt "ik denk"; "dat dat wil zeggen"
  wordt "dat wil zeggen"
- False starts zonder correctie: "we gaan we gaan kijken" wordt "we gaan kijken"
- Afgebroken woordaanzetten: "dat is ei- eigenlijk" wordt "dat is eigenlijk"

Bewaar:
- Inhoudelijke herhaling: "nee, nee, dat klopt niet"
- Woorden met betekenis: "kijk, eigenlijk ..."
- Zelfcorrecties: "of nee, ik bedoel ..."
- Echte uitroepen: "ah, interessant!"

**Twijfel je of iets inhoud is? Laat het staan.**

### 2. Taalcorrectie (gewone taalkundige verbetering)
Corrigeer alleen duidelijke fouten:
- spelling en typefouten
- werkwoordsvormen (dt-fouten: "hij word" wordt "hij wordt")
- woorden die door spraakherkenning onterecht uit elkaar of aan elkaar staan
  ("raads lid" wordt "raadslid")
- leestekens: punt, komma, vraagteken aan het einde van zinnen
- hoofdletter aan het begin van een zin
- dubbele spaties en dubbele leestekens

Wijzig **niet**:
- woordkeuze of zinsbouw, ook niet als je het zelf anders zou zeggen
- Vlaamse woorden en uitdrukkingen ("goesting", "ne keer", "allez")
- vakjargon en beleidstermen
- cijfers, bedragen, data en percentages
- eigennamen (die zijn al door gentse-normalizer behandeld)
- de volgorde van de zinnen

Maak de tekst niet formeler en niet korter. Voeg geen woorden toe, behalve
een ontbrekend leesteken of een evident weggevallen klein woord ("de", "het")
als de zin anders ongrammaticaal is.

### 3. Blokken samenvoegen
Voeg een blok samen met het vorige als:
- ze hetzelfde sprekerlabel hebben (of allebei `?`), **en**
- het vorige blok niet op `.`, `?`, `!` of `:` eindigt, **en**
- het volgende blok met een kleine letter begint.

Samenvoegen mag ook als een blok eindigt op een voegwoord of hulpwerkwoord
("en", "maar", "omdat", "is"). Een blok van minder dan 3 woorden voeg je samen
met het vorige blok van dezelfde spreker, behalve als het een eigen
antwoord is ("Ja.", "Akkoord.", "Dank u.").

Houd de blokken van **verschillende sprekers altijd apart**. Gebruik het
laagste blokcijfer van de samengevoegde blokken en laat de andere nummers
vervallen. Noteer dat in NOTITIES.

### 4. Controle
- Staat er na je werk nog een "uhm", "euh" of dubbel woord in?
- Eindigt elke zin met een leesteken?
- Is er geen enkel inhoudelijk woord verdwenen?

## NOTITIES (laatste sectie)
```
## NOTITIES
Samengevoegd: B005+B006 -> B005
Aantal verwijderde opvullers/herhalingen: ongeveer X
Onzeker: B009 (zin onduidelijk, ongewijzigd gelaten)
```
Laat een regel weg als ze niet van toepassing is.

## Voorbeeld

**Input**
```
## B010 | spreker: ?
Uhm, het budget voor dit project

## B011 | spreker: ?
is is vastgesteld op twintigduizend euro. Dat is inclusief eh de BTW en ik denk dat dat dat wel haalbaar is

## B012 | spreker: Spreker 2
Ja.
```

**Output**
```
## B010 | spreker: ?
Het budget voor dit project is vastgesteld op twintigduizend euro. Dat is inclusief de BTW en ik denk dat dat wel haalbaar is.

## B012 | spreker: Spreker 2
Ja.

## NOTITIES
Samengevoegd: B010+B011 -> B010
Aantal verwijderde opvullers/herhalingen: 4
```

## Wat je niet doet
- Niets samenvatten, parafraseren of inkorten.
- Geen namen of termen aanpassen.
- Geen sprekers toewijzen.
- Geen inhoud toevoegen die niet in de tekst staat.

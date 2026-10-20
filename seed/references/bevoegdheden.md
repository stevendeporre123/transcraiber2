# Bevoegdheden college van burgemeester en schepenen — Stad Gent

Gebruik dit bestand in `speaker-resolver` om "mijnheer/mevrouw de schepen"
zonder naam te koppelen aan de juiste persoon via het onderwerp van het
agendapunt of de interventie.

Bron: https://stad.gent/nl/college-burgemeester-schepenen

---

## Overzicht bevoegdheden

| Naam | Functie | Fractie | Bevoegdheden |
|---|---|---|---|
| Mathias De Clercq | Burgemeester | Voor Gent | Algemeen beleid, vertegenwoordiging stad |
| Hafsa El-Bazioui | Schepen | Groen | Participatie, Buurtwerk, Mondiale Solidariteit, Facilitair Management, Digitalisering |
| Astrid De Bruycker | Schepen | Voor Gent | Sociale Vooruitgang, Gezondheid, Ouderenbeleid, Cultuur |
| Sofie Bracke | Schepen | Voor Gent | Economie, Haven, Handel, Toerisme, Openbare netheid |
| Evita Willaert | Schepen | Groen | Onderwijs, Opvoeding, Jeugd, Gezin, Outreachend Werk |
| Joris Vandenbroucke | Schepen | Voor Gent | Mobiliteit, Ruimte, Stadsontwikkeling, Plezier |
| Bram Van Braeckevelt | Schepen | Groen | Natuur en Groen, Werk, Sociale Economie, Gelijke kansen, Sport, Dierenwelzijn |
| Burak Nalli | Schepen | Voor Gent | Personeelsbeleid, Burgerzaken, Dienstverlening |
| Filip Watteeuw | Schepen | Groen | Wonen, Milieu, Klimaat, Energie |
| Christophe Peeters | Schepen | Voor Gent | Financiën, Stedenbouw, Erfgoed, Administratieve vereenvoudiging |

---

## Bevoegdheid → schepen (voor speaker-resolver)

Gebruik deze tabel wanneer "mijnheer/mevrouw de schepen" zonder naam wordt
aangesproken. Kijk naar het onderwerp van het agendapunt of de interventie
en zoek de meest passende bevoegdheid op.

### Sofie Bracke
- sluikstort, netheid, openbare netheid, afval, zwerfvuil
- economie, handel, horeca, markt, haven
- toerisme

### Filip Watteeuw
- wonen, sociale woningbouw, huurders, sociaal wonen
- milieu, klimaat, energie, duurzaamheid, CO2, hernieuwbare energie
- renovatie, energiepremies

### Joris Vandenbroucke
- mobiliteit, verkeer, fietspaden, parkeren, LEZ, lage-emissiezone
- ruimtelijke ordening, stadsontwikkeling, vergunningen
- openbare werken, wegenwerken, infrastructuur

### Astrid De Bruycker
- sociale vooruitgang, armoede, sociale cohesie
- gezondheid, zorg, woonzorgcentra
- ouderenbeleid, senioren
- cultuur, cultureel erfgoed, musea

### Evita Willaert
- onderwijs, scholen, stedelijk onderwijs
- jeugd, jeugdbeleid, jeugdwerk
- gezin, kinderopvang, opvoeding
- outreachend werk

### Bram Van Braeckevelt
- natuur, groen, parken, bomen, groenbeleid
- werk, tewerkstelling, sociale economie, OCMW-werk
- gelijke kansen, diversiteit, discriminatie
- sport, sportinfrastructuur
- dierenwelzijn

### Hafsa El-Bazioui
- participatie, inspraak, buurtwerk
- digitalisering, e-government, IT
- facilitair management, stadspanden, gebouwen
- mondiale solidariteit, ontwikkelingssamenwerking

### Burak Nalli
- personeelsbeleid, HR, stadspersoneel
- burgerzaken, identiteitskaarten, paspoorten
- dienstverlening, stadsloket

### Christophe Peeters
- financiën, begroting, budget
- stedenbouw, bouwvergunningen, omgevingsvergunningen
- erfgoed, monumenten, beschermd erfgoed
- administratieve vereenvoudiging

### Mathias De Clercq (burgemeester)
- algemeen beleid, bestuursakkoord
- veiligheid, politie (gedeeld met college)
- internationale betrekkingen
- openbare orde

---

## Relatie tot commissies

| Commissie | Relevante schepenen (bevoegdheidsoverlap) |
|---|---|
| VOGOK (Vrije Tijd, Openbare Werken, Groen, Onderwijs, Klimaat) | Willaert, Van Braeckevelt, Watteeuw, Vandenbroucke |
| MASSE (Milieu, Arbeidsmarkt, Samenleven, Stadsontwikkeling, Economie) | Watteeuw, Van Braeckevelt, De Bruycker, Vandenbroucke, Bracke |
| WWOPP (Wonen, Welzijn, Opgroeien, Publieke ruimte, Personeel) | Watteeuw, De Bruycker, Willaert, Vandenbroucke, Nalli |
| FJEWD (Financiën, Juridische zaken, Economie, Werk, Digitalisering) | Peeters, Bracke, Van Braeckevelt, El-Bazioui |
| FABAZ (Financiën, Algemeen beleid, Bestuurszaken, Zorg) | Peeters, De Bruycker, Nalli |

---

## Toepassingsregel voor speaker-resolver

Bij een interventie over **sluikstort** en aanspreken van "mevrouw de schepen":
→ Sofie Bracke (Openbare netheid)

Bij een interventie over **sociale woningbouw** en aanspreken van "mijnheer de schepen":
→ Filip Watteeuw (Wonen) — maar let op: Joris Vandenbroucke (Stadsontwikkeling)
   kan ook betrokken zijn; gebruik aanvullende context (bv. wie antwoordt)

Bij twijfel tussen twee schepenen: wijs toe met `speaker_confidence: "medium"`
en vermeld beide kandidaten in `resolution_notes`.

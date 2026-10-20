# Gemeenteraad-skills (PDF-transcriptie, zonder tijdcodes en zonder context)

Zelfstandige versies van de VTT-transcraiber-skills, bedoeld om als
systeemprompt te gebruiken met een willekeurig model (bv. Mistral via OpenRouter).

## Inhoud

| Map | Rol |
|---|---|
| `transcript-intake/` | PDF-ruis weg, genummerde blokken (vervangt vtt-parser) |
| `gentse-normalizer/` | namen en Gentse termen rechtzetten |
| `transcript-cleaner/` | spraakruis weg en taalcorrectie |
| `speaker-resolver/` | sprekers koppelen aan namen |
| `verslag-writer/` | Markdown-verslag |
| `verslag-pipeline/` | volgorde, tussenformaat, delen, alles-in-één |
| `references/` | leden, bevoegdheden, Gentse terminologie, stratenlijst (optioneel, ~53 KB) |

Niet meegenomen: `agenda-harvester` (heeft web en agenda nodig) en het docx-uitvoer.

## Gebruik per stap

Systeemprompt = de SKILL.md-tekst (frontmatter mag weg) gevolgd door de
referenties die de skill nodig heeft, elk onder een kopje:

| Skill | Referenties toevoegen |
|---|---|
| transcript-intake | geen |
| gentse-normalizer | `leden.md`, `gentse-terminologie.md` (+ `stratenlijst.md` indien straatnamen belangrijk zijn) |
| transcript-cleaner | geen |
| speaker-resolver | `leden.md`, `bevoegdheden.md` |
| verslag-writer | geen |

Gebruikersbericht = de uitvoer van de vorige stap. Aanbevolen instellingen:
temperatuur 0 tot 0,2, geen streaming nodig. Verwerk lange transcripties in delen
(zie `verslag-pipeline`).

## Wat je kan vergelijken tussen modellen
- Stap 2: aantal correcties, fout-positieven (juiste namen onterecht gewijzigd), gemiste namen.
- Stap 3: is er inhoud verdwenen of herschreven (vergelijk met de invoer per blok)?
- Stap 4: namen buiten `leden.md` die niet in de tekst voorkomen (verzonnen), en de verdeling hoog/middel/laag.
- Stap 5: zijn de bijdragen woord voor woord gelijk aan stap 4 (diff per blok)?

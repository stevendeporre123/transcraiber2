# Director Aanwezigheden (Electron)

Desktop-app om via de **Director REST API** (Green Valley / onlinesmartcities) een vergadering
te kiezen en de aanwezigheden van de leden bij te werken.

- Electron 45 (laatste stabiele versie), Bootstrap 5, DataTables 3, jQuery 4
- OAuth2 *client credentials* (token wordt gecachet en automatisch vernieuwd)
- API-calls lopen in het main-proces via `net.fetch`: geen CORS en de systeemproxy wordt gebruikt
- Client-secret wordt versleuteld bewaard via Electron `safeStorage` (DPAPI / Keychain / libsecret)

## Starten

```bash
cd director-app
npm install
npm start
```

Bij de eerste start opent **Instellingen** vanzelf.

## Instellingen

| Tab | Veld | Uitleg |
|---|---|---|
| Verbinding | Base-URL | bv. `https://suite-release.onlinesmartcities.be` |
| | Token-URL | Keycloak-tokenendpoint (staat al ingevuld voor de testomgeving) |
| | Client-ID / secret | uit de Postman-collectie of van Green Valley |
| | Scope | optioneel |
| Organen | Orgaan-ID('s) | komma-gescheiden, of **Organen ophalen** en aanvinken |
| Vergaderingen | Statussen | filter voor `/meetings`, bv. `AGENDA_OPEN,AGENDA_CLOSED` |
| | Sortering / lijststijl | `organ=a,b` of `organ=a&organ=b` (de collectie is daar dubbelzinnig over) |
| Aanwezigheid | Statussen | `CODE=Label`. `PRESENT` staat in de collectie; `ABSENT` en `EXCUSED` zijn aannames, dus controleer die |
| | Veldnaam | sleutel in de PATCH-body (standaard `status`) |
| Geavanceerd | Extra headers | JSON of `Naam: waarde` per regel (bv. een tenant-header) |

Instellingen staan in `settings.json` in de userData-map van de app. Met de omgevingsvariabele
`DIRECTOR_USER_DATA=/pad` kies je een andere map, bijvoorbeeld voor portable gebruik.

## Gebruik

1. Klik links op een vergadering.
2. Rechts verschijnen de leden. Klik per lid op **Aanwezig / Afwezig / Verontschuldigd**: dat
   doet meteen een `PATCH`.
3. Of vink meerdere leden aan en zet ze in één keer op dezelfde status.
4. Met het potlood-icoon open je een bewerkvenster met de ruwe API-data van het lid.

De collectie bevat geen voorbeeld-responses. Daarom herkent de app de gangbare vormen
(lijst, `{content: []}`, `{data: []}`, …) en veldnamen. Als er iets niet goed getoond wordt,
klik je op het `{ }`-icoon of op *details* in een melding: dan zie je de ruwe JSON.

## Ontwikkelen

```bash
npm test          # unit-tests (API-client tegen mock-server, normalisatie)
npm run mock      # mock-API op http://127.0.0.1:4010 (token-URL /token, secret "geheim")
npm run dist:win  # portable .exe bouwen met electron-builder
```

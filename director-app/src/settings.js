'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Standaardwaarden: test-omgeving uit de Postman-collectie (zonder secret). */
const DEFAULTS = Object.freeze({
  baseUrl: 'https://suite-release.onlinesmartcities.be',
  tokenUrl: 'https://test-authenticatie.onlinesmartcities.be/auth/realms/suite-release/protocol/openid-connect/token',
  clientId: 'suite-api-client',
  clientSecret: '',
  scope: '',
  organIds: '',
  meetingStatuses: 'AGENDA_OPEN,AGENDA_CLOSED,AGENDA_PUBLISHED_INTERNAL',
  sort: '-meetingDate',
  listStyle: 'comma', // 'comma' => organ=a,b  |  'repeat' => organ=a&organ=b
  attendanceStatuses: 'PRESENT=Aanwezig,ABSENT=Afwezig,EXCUSED=Verontschuldigd',
  statusField: 'status',
  extraHeaders: '',
});

/**
 * Bewaart instellingen als JSON in de userData-map.
 * Het client-secret wordt (indien beschikbaar) versleuteld met Electron safeStorage.
 */
class SettingsStore {
  constructor(dir, safeStorage = null) {
    this.file = path.join(dir, 'settings.json');
    this.safe = safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()
      ? safeStorage : null;
  }

  load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* eerste start */ }
    const out = { ...DEFAULTS, ...raw };
    if (raw.clientSecretEnc && this.safe) {
      try { out.clientSecret = this.safe.decryptString(Buffer.from(raw.clientSecretEnc, 'base64')); } catch { out.clientSecret = ''; }
    }
    delete out.clientSecretEnc;
    return out;
  }

  save(input) {
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (input[key] !== undefined) clean[key] = String(input[key]).trim();
    }
    const merged = { ...this.load(), ...clean };
    const toDisk = { ...merged };
    if (this.safe && merged.clientSecret) {
      toDisk.clientSecretEnc = this.safe.encryptString(merged.clientSecret).toString('base64');
      delete toDisk.clientSecret;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(toDisk, null, 2));
    return merged;
  }
}

module.exports = { SettingsStore, DEFAULTS };

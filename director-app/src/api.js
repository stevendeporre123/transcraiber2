'use strict';

/**
 * Client voor de Director REST API (Green Valley / onlinesmartcities).
 * Authenticatie: OAuth2 client_credentials, client-gegevens in de body.
 * `fetchImpl` is injecteerbaar zodat we in Electron `net.fetch` (systeemproxy)
 * en in tests de gewone `fetch` kunnen gebruiken.
 */

class ApiError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new ApiError('Base-URL is niet ingesteld (zie Instellingen).');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

/** "a, b ,c" of ["a","b"] -> ["a","b","c"] */
function toList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
}

function parseExtraHeaders(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch { /* val terug op "Key: value"-regels */ }
  const out = {};
  for (const line of String(raw).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

class DirectorClient {
  constructor(settings, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.settings = settings;
    this.fetch = fetchImpl;
    this.now = now;
    this.token = null;
    this.tokenExpires = 0;
  }

  updateSettings(settings) {
    const authChanged = ['tokenUrl', 'clientId', 'clientSecret', 'scope']
      .some(k => (settings[k] || '') !== (this.settings[k] || ''));
    this.settings = settings;
    if (authChanged) this.clearToken();
  }

  clearToken() {
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken(force = false) {
    if (!force && this.token && this.now() < this.tokenExpires) return this.token;
    const s = this.settings;
    if (!s.tokenUrl) throw new ApiError('Token-URL is niet ingesteld (zie Instellingen).');
    if (!s.clientId || !s.clientSecret) throw new ApiError('Client-ID en client-secret zijn verplicht (zie Instellingen).');

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: s.clientId,
      client_secret: s.clientSecret,
    });
    if (s.scope) body.set('scope', s.scope);

    const res = await this.fetch(s.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const data = await readBody(res);
    if (!res.ok || !data || !data.access_token) {
      const detail = data && (data.error_description || data.error) ? `: ${data.error_description || data.error}` : '';
      throw new ApiError(`Token ophalen mislukt (${res.status})${detail}`, { status: res.status, body: data, url: s.tokenUrl });
    }
    const ttl = Number(data.expires_in) || 300;
    this.token = data.access_token;
    // 30 s marge zodat een token niet halverwege een request vervalt
    this.tokenExpires = this.now() + Math.max(ttl - 30, 10) * 1000;
    return this.token;
  }

  buildUrl(path, query) {
    const url = new URL(normalizeBaseUrl(this.settings.baseUrl) + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      const list = Array.isArray(value) ? value : [value];
      if (this.settings.listStyle === 'repeat') {
        for (const v of list) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, list.join(','));
      }
    }
    return url.toString();
  }

  async request(method, path, { query, body } = {}, retried = false) {
    const url = this.buildUrl(path, query);
    const token = await this.getToken();
    const headers = {
      Accept: 'application/json',
      ...parseExtraHeaders(this.settings.extraHeaders),
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Verlopen/ingetrokken token: één keer opnieuw proberen met een vers token.
    if (res.status === 401 && !retried) {
      this.clearToken();
      return this.request(method, path, { query, body }, true);
    }

    const data = await readBody(res);
    if (!res.ok) {
      const msg = {
        400: 'Ongeldige aanvraag (400)',
        401: 'Niet geauthenticeerd (401)',
        403: 'Geen toegang (403)',
        404: 'Niet gevonden (404)',
      }[res.status] || `Fout ${res.status}`;
      const detail = data && typeof data === 'object' ? (data.message || data.detail || data.error || '') : (data || '');
      throw new ApiError(`${msg}${detail ? ': ' + String(detail).slice(0, 300) : ''}`, { status: res.status, body: data, url });
    }
    return data;
  }

  async getOrgans() {
    return this.request('GET', '/api/v1/director/organs');
  }

  async getMeetings({ organs, statuses, sort } = {}) {
    const organ = toList(organs ?? this.settings.organIds);
    const status = toList(statuses ?? this.settings.meetingStatuses);
    if (!organ.length && !status.length) {
      throw new ApiError('Vul minstens één orgaan-ID of één vergaderstatus in (zie Instellingen).');
    }
    return this.request('GET', '/api/v1/director/meetings', {
      query: { organ, status, sort: sort ?? (this.settings.sort || '-meetingDate') },
    });
  }

  async getMembers(meetingId) {
    if (!meetingId) throw new ApiError('Geen vergadering gekozen.');
    return this.request('GET', `/api/v1/director/meetings/${encodeURIComponent(meetingId)}/members`);
  }

  async updateMember(meetingId, memberId, patch) {
    if (!meetingId || !memberId) throw new ApiError('Vergadering- en lid-ID zijn verplicht.');
    return this.request('PATCH',
      `/api/v1/director/meetings/${encodeURIComponent(meetingId)}/members/${encodeURIComponent(memberId)}`,
      { body: patch });
  }
}

module.exports = { DirectorClient, ApiError, normalizeBaseUrl, toList, parseExtraHeaders };

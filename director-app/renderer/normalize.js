/*
 * Normalisatie van API-antwoorden. De collectie bevat geen voorbeeld-responses,
 * dus we zijn ruim in wat we aanvaarden (lijst of {data|content|items|...}) en
 * zoeken velden onder meerdere gangbare namen.
 * Werkt zowel in de renderer (window.Normalize) als in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Normalize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WRAPPERS = ['data', 'content', 'items', 'results', 'result', 'meetings', 'members', 'organs', 'list', 'records', 'elements'];

  function asArray(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    for (const key of WRAPPERS) {
      if (Array.isArray(data[key])) return data[key];
      if (data[key] && typeof data[key] === 'object') {
        const inner = asArray(data[key]);
        if (inner.length) return inner;
      }
    }
    if (data._embedded && typeof data._embedded === 'object') {
      const first = Object.values(data._embedded).find(Array.isArray);
      if (first) return first;
    }
    return [];
  }

  function get(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function pick(obj, ...paths) {
    for (const p of paths) {
      const v = get(obj, p);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function text(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') {
      const t = pick(v, 'name', 'label', 'title', 'description', 'nl', 'value');
      return t !== undefined ? text(t) : '';
    }
    return String(v);
  }

  function personName(o) {
    if (!o || typeof o !== 'object') return text(o);
    const direct = pick(o, 'fullName', 'displayName', 'name');
    if (direct && typeof direct !== 'object') return String(direct);
    const first = pick(o, 'firstName', 'firstname', 'givenName', 'voornaam');
    const last = pick(o, 'lastName', 'lastname', 'familyName', 'surname', 'achternaam', 'naam');
    const joined = [first, last].filter(Boolean).join(' ');
    return joined || (direct ? text(direct) : '');
  }

  function organ(o) {
    return {
      id: String(pick(o, 'id', 'organId', 'uuid', 'code') ?? ''),
      name: text(pick(o, 'name', 'label', 'title', 'description', 'shortName')),
      raw: o,
    };
  }

  function meeting(m, organNames) {
    const organRaw = pick(m, 'organ', 'organId', 'body', 'committee');
    const organId = organRaw && typeof organRaw === 'object'
      ? String(pick(organRaw, 'id', 'organId') ?? '') : String(organRaw ?? '');
    let organName = organRaw && typeof organRaw === 'object' ? text(organRaw) : '';
    if (!organName) organName = text(pick(m, 'organName', 'organLabel')) || (organNames && organNames[organId]) || organId;
    return {
      id: String(pick(m, 'id', 'meetingId', 'uuid') ?? ''),
      date: pick(m, 'meetingDate', 'date', 'startDate', 'start', 'startTime', 'plannedStart') || '',
      organId,
      organName,
      title: text(pick(m, 'title', 'name', 'subject', 'description', 'label')),
      location: text(pick(m, 'location', 'place', 'room')),
      status: text(pick(m, 'status', 'state', 'meetingStatus')),
      raw: m,
    };
  }

  function member(m, statusField) {
    const person = pick(m, 'person', 'mandatary', 'mandataris', 'user', 'contact') || {};
    const name = personName(m) || personName(person);
    const statusVal = pick(m, statusField || 'status', 'status', 'attendance', 'attendanceStatus', 'presence', 'presenceStatus');
    return {
      id: String(pick(m, 'id', 'memberId', 'uuid') ?? ''),
      name: name || '(naam onbekend)',
      role: text(pick(m, 'role', 'function', 'functie', 'mandate', 'position', 'type', 'memberType', 'person.function')),
      party: text(pick(m, 'party', 'fraction', 'fractie', 'politicalParty', 'person.party')),
      status: statusVal && typeof statusVal === 'object' ? String(pick(statusVal, 'code', 'value', 'name') ?? '') : String(statusVal ?? ''),
      raw: m,
    };
  }

  /** "PRESENT=Aanwezig,ABSENT" -> [{code,label}] */
  function parseStatusList(str) {
    return String(str || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.indexOf('=');
      return i > 0 ? { code: s.slice(0, i).trim(), label: s.slice(i + 1).trim() } : { code: s, label: s };
    });
  }

  function formatDate(value, short) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d)) return String(value);
    const hasTime = /T\d|\d:\d/.test(String(value));
    if (short) {
      return d.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
        (hasTime ? ' ' + d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' }) : '');
    }
    return d.toLocaleString('nl-BE', hasTime
      ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  return { asArray, pick, text, organ, meeting, member, parseStatusList, formatDate };
});

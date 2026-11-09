// Leest Gentse agenda's in code (geen LLM): de gemeenteraadsagenda ("7. Titel … (2026_GR_00773)")
// en de bundel prerogatieven van het vragenuurtje ("IR 1 2026_MV_00773 - Mondelinge vraag van …"
// met per vraag een fiche: Nummer, Raadslid(-leden), Bevoegd, Toelichting).

const CODE = /\b(\d{4}_[A-Z]{2,5}_\d{3,6})\b/;
const TYPE_BY_CODE = {
  MV: 'mondelinge_vraag', SV: 'schriftelijke_vraag', GR: 'besluit', RMW: 'besluit', VVB: 'voorstel',
  MO: 'motie', AM: 'amendement', IP: 'interpellatie', INT: 'interpellatie',
};
const TYPE_BY_TITLE = [
  [/^mondelinge vraag/i, 'mondelinge_vraag'], [/^schriftelijke vraag/i, 'schriftelijke_vraag'], [/^voorstel tot raadsbesluit/i, 'voorstel'],
  [/^motie/i, 'motie'], [/^amendement/i, 'amendement'], [/^interpellatie/i, 'interpellatie'],
];
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

export const POINT_TYPES = ['mondelinge_vraag', 'interpellatie', 'voorstel', 'motie', 'amendement', 'besluit', 'schriftelijke_vraag', 'mededeling', 'overig'];

const isHeading = (l) => {
  const letters = l.replace(/[^A-Za-zÀ-ÿ]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && !CODE.test(l) && !/^IR\s+\d/.test(l);
};

/** Regels samenvoegen: afbreekstreepje ("PHP-" + "programmeertaal") zonder spatie. */
const joinLines = (lines) => lines.reduce((acc, l) => (!acc ? l : /\S-$/.test(acc) ? acc + l : `${acc} ${l}`), '').replace(/\s+/g, ' ').trim();

function cleanLines(text) {
  return String(text).replace(/\r/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && l !== '.' && !/^\d+\s+van\s+\d+$/i.test(l));
}

/** "Mondelinge vraag van raadslid X: Titel" → { indieners, titel } */
export function splitTitle(raw) {
  const m = raw.match(/^(Mondelinge vraag|Schriftelijke vraag|Voorstel tot raadsbesluit|Motie|Amendement|Interpellatie|Vraag)\s+van\s+(?:de\s+)?(?:raadsleden|raadslid)?\s*(.+?)\s*(?::|\s[-–]\s)\s*(.+)$/i);
  if (!m) return { indieners: [], titel: raw };
  const indieners = m[2].split(/\s*,\s*|\s+en\s+/).map((s) => s.trim()).filter(Boolean);
  return { indieners, titel: m[3].trim(), soort: m[1] };
}

function typeOf(code, titel) {
  const k = code?.split('_')[1];
  if (k && TYPE_BY_CODE[k]) return TYPE_BY_CODE[k];
  return (TYPE_BY_TITLE.find(([re]) => re.test(titel)) || [null, 'overig'])[1];
}

function parseDate(text) {
  const m = String(text).match(/(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/i);
  if (!m) return null;
  const mm = String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0');
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());

// ---------- Bundel prerogatieven (vragenuurtje) ----------
function parsePrerogatieven(lines, nameFor) {
  const points = [];
  const byCode = new Map();
  let bevoegd = null;
  let cur = null;
  let i = 0;
  // 1. Overzicht tot de eerste fiche ("IR n VRAGENUURTJE …")
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^IR\s+\d+\s+VRAGENUURTJE/i.test(l)) break;
    const m = l.match(/^IR\s+(\d+)\s+(\d{4}_[A-Z]{2,5}_\d{3,6})\s*[-–]\s*(.*)$/);
    if (m) {
      cur = { nummer: `IR ${m[1]}`, code: m[2], raw: [m[3]], bevoegd };
      points.push(cur);
      byCode.set(m[2], cur);
    } else if (isHeading(l) && l.split(/\s+/).length <= 5) {
      bevoegd = nameFor(l);
      cur = null;
    } else if (cur) {
      cur.raw.push(l);
    }
  }
  // 2. Fiches: Nummer, Raadslid(-leden), Bevoegd, Toelichting
  let fiche = null;
  let field = null;
  const flush = () => {
    if (!fiche) return;
    const p = byCode.get(fiche.code);
    if (p) {
      if (fiche.leden.length) p.indieners_fiche = fiche.leden;
      if (fiche.bevoegd) p.bevoegd = nameFor(fiche.bevoegd);
      p.toelichting = joinLines(fiche.toelichting).slice(0, 6000);
    }
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^IR\s+\d+\s+VRAGENUURTJE/i.test(l)) { flush(); fiche = { leden: [], toelichting: [] }; field = null; continue; }
    if (!fiche) continue;
    if (/^Nummer:/i.test(l)) { fiche.code = (l.match(CODE) || lines[i + 1]?.match(CODE) || [])[1]; field = null; continue; }
    if (/^Raadslid\(-leden\):/i.test(l)) { field = 'leden'; continue; }
    if (/^Bevoegd:/i.test(l)) { field = 'bevoegd'; continue; }
    if (/^(Omschrijving van de vraag|Toelichting:)/i.test(l)) { field = 'toelichting'; continue; }
    if (/^(Onderwerp:|Opschrift)/i.test(l)) { field = null; continue; }
    if (field === 'leden') {
      // "Gert Robert - N-VA": de fractie na de laatste " - " weglaten
      const cut = Math.max(l.lastIndexOf(' - '), l.lastIndexOf(' – '));
      fiche.leden.push((cut > 0 ? l.slice(0, cut) : l).trim());
    }
    else if (field === 'bevoegd') { fiche.bevoegd = l; field = null; }
    else if (field === 'toelichting') fiche.toelichting.push(l);
  }
  flush();
  return points.map((p) => {
    const raw = joinLines(p.raw);
    const { indieners, titel } = splitTitle(raw);
    return {
      nummer: p.nummer, code: p.code, type: typeOf(p.code, raw), titel, volledige_titel: raw,
      indieners: p.indieners_fiche?.length ? p.indieners_fiche : indieners, bevoegd: p.bevoegd || null,
      sectie: 'Vragenuurtje', toelichting: p.toelichting || null,
    };
  });
}

// ---------- Gemeenteraadsagenda ----------
function parseGrAgenda(lines) {
  const points = [];
  let sectie = null;
  let cur = null;
  for (const l of lines) {
    const start = l.match(/^(IR\s+)?(\d+)\.\s+(.*)$/);
    if (start && !cur) {
      cur = { nummer: `${start[1] ? 'IR ' : ''}${start[2]}`, raw: [start[3]], sectie };
    } else if (cur) {
      cur.raw.push(l);
    } else if (isHeading(l)) {
      sectie = l;
      continue;
    } else {
      continue;
    }
    const code = cur.raw[cur.raw.length - 1].match(/\((\d{4}_[A-Z]{2,5}_\d{3,6})\)\s*$/);
    if (code) {
      const raw = joinLines(cur.raw).replace(/\s*\(\d{4}_[A-Z]{2,5}_\d{3,6}\)\s*$/, '');
      const { indieners, titel } = splitTitle(raw);
      points.push({ nummer: cur.nummer, code: code[1], type: typeOf(code[1], raw), titel, volledige_titel: raw, indieners, bevoegd: null, sectie: cur.sectie, toelichting: null });
      cur = null;
    } else if (cur.raw.length > 8) {
      cur = null; // geen code gevonden: geen agendapunt
    }
  }
  return points;
}

/**
 * Parset de agendatekst. `nameFor(hoofdletters)` zet "BRAM VAN BRAECKEVELT" om naar de naam uit de ledenlijst.
 * Geeft { format, vergadering, punten } of null als er geen herkenbare punten in staan.
 */
export function parseAgenda(text, nameFor = titleCase) {
  const lines = cleanLines(text);
  const head = lines.slice(0, 6).join(' ');
  const prerog = lines.some((l) => /^IR\s+\d+\s+\d{4}_[A-Z]{2,5}_\d{3,6}/.test(l));
  const punten = (prerog ? parsePrerogatieven(lines, nameFor) : parseGrAgenda(lines)).map((p, i) => ({ ord: i + 1, ...p }));
  if (!punten.length) return null;
  // Dubbele codes (zelfde punt op twee plaatsen) één keer houden
  const seen = new Set();
  const uniek = punten.filter((p) => (seen.has(p.code) ? false : seen.add(p.code)));
  const orgaan = /commissie/i.test(lines[0] || '') ? 'commissie' : 'gemeenteraad';
  return {
    format: prerog ? 'prerogatieven' : 'gr-agenda',
    vergadering: { orgaan, datum: parseDate(head), soort: (lines[0] || '').toLowerCase() },
    punten: uniek.map((p, i) => ({ ...p, ord: i + 1 })),
  };
}

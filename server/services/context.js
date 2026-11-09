// Zet de referentiedata uit SQLite om naar tekst voor onder de skill (systeemprompt).
import { db, json } from '../db.js';

const CAT_LABELS = {
  organisatie: 'Organisaties en stadsdiensten',
  wijk: 'Wijken en gebieden',
  straat: 'Straten (aanvullingen)',
  evenement: 'Festiviteiten en evenementen',
  gebouw: 'Gebouwen en complexen',
  procedure: 'Procedures en gemeenteraadsjargon',
  regelgeving: 'Regelgeving en beleidsdocumenten',
  project: 'Actuele projecten, acties en organisaties',
  persoon: 'Externe personen',
  nummer: 'Nummers en lijsten (STT-specifieke fouten)',
  naam_fout: 'Veelvoorkomende STT-fouten bij namen',
  commissie: 'Gemeenteraadscommissies',
  vlaamse_regering: 'Vlaamse Regering',
  federale_regering: 'Federale Regering',
  aanvulling: 'Aanvullingen terminologie',
  richtlijn: 'Richtlijnen',
};
export const TERM_CATEGORIES = Object.keys(CAT_LABELS);
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n+/g, ' ').trim();

export function renderLeden() {
  const rows = db.prepare(`SELECT * FROM members WHERE actief = 1 ORDER BY
    CASE functie WHEN 'burgemeester' THEN 0 WHEN 'voorzitter' THEN 1 WHEN 'ondervoorzitter' THEN 2 WHEN 'schepen' THEN 3 ELSE 4 END, naam`).all();
  let out = '| Naam | Achternaam (match) | Gekende STT-vervormingen | Geslacht | Fractie | Functie | Aanspreekvorm | Opmerking |\n|---|---|---|---|---|---|---|---|\n';
  for (const m of rows) out += `| ${cell(m.naam)} | ${cell(m.match_namen)} | ${cell(m.varianten)} | ${cell(m.geslacht)} | ${cell(m.fractie)} | ${cell(m.functie)} | ${cell(m.aanspreekvorm)} | ${cell(m.notitie)} |\n`;
  // Dubbele voornamen automatisch signaleren
  const byFirst = new Map();
  for (const m of rows) {
    const f = m.naam.split(' ')[0];
    byFirst.set(f, [...(byFirst.get(f) || []), m]);
  }
  const dup = [...byFirst].filter(([, l]) => l.length > 1);
  if (dup.length) {
    out += '\nDubbele voornamen (onderscheid via achternaam, functie of fractie):\n';
    for (const [f, l] of dup) out += `- ${f}: ${l.map((m) => `${m.naam} (${m.functie}, ${m.fractie})`).join('; ')}\n`;
  }
  const fr = [...new Set(rows.map((m) => m.fractie).filter(Boolean))];
  out += `\nFracties: ${fr.join(', ')}\n`;
  return out;
}

export function renderBevoegdheden() {
  const rows = db.prepare(`SELECT * FROM members WHERE actief = 1 AND functie IN ('burgemeester','schepen') ORDER BY functie, naam`).all();
  let out = '| Naam | Functie | Fractie | Bevoegdheden | Trefwoorden (onderwerpen) |\n|---|---|---|---|---|\n';
  for (const m of rows) out += `| ${cell(m.naam)} | ${cell(m.functie)} | ${cell(m.fractie)} | ${cell(m.portefeuille)} | ${cell(m.trefwoorden)} |\n`;
  const comm = db.prepare('SELECT * FROM commissies ORDER BY code').all();
  if (comm.length) {
    out += '\n## Commissies\n| Commissie | Volledige naam | Relevante schepenen | Voorzitter |\n|---|---|---|---|\n';
    for (const c of comm) out += `| ${cell(c.code)} | ${cell(c.naam)} | ${cell(c.schepenen)} | ${cell(c.voorzitter)} |\n`;
  }
  return out;
}

export function renderTerminologie() {
  const rows = db.prepare(`SELECT * FROM terms WHERE status = 'actief' ORDER BY categorie, correct`).all();
  const groups = new Map();
  for (const t of rows) groups.set(t.categorie, [...(groups.get(t.categorie) || []), t]);
  let out = '';
  for (const cat of [...TERM_CATEGORIES, ...[...groups.keys()].filter((c) => !CAT_LABELS[c])]) {
    const list = groups.get(cat);
    if (!list) continue;
    out += `\n## ${CAT_LABELS[cat] || cat}\n`;
    if (cat === 'richtlijn') {
      for (const t of list) out += `\n### ${t.correct}\n${t.toelichting || ''}\n`;
      continue;
    }
    out += '| STT-vervorming | Correcte naam | Toelichting |\n|---|---|---|\n';
    for (const t of list) out += `| ${cell(t.varianten)} | ${cell(t.correct)} | ${cell(t.toelichting)} |\n`;
  }
  return out.trim();
}

// ---------- Straten: voorselectie op basis van de tekst ----------
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

let streetCache = null;
export function invalidateStreets() { streetCache = null; }
function streetIndex() {
  if (!streetCache) {
    // elke straat één keer per schrijfwijze: de officiële naam en de gekende STT-vervormingen
    streetCache = db.prepare('SELECT naam, deelgemeente, varianten FROM streets').all().flatMap((s) => [s.naam, ...String(s.varianten || '').split(',')]
      .map((v) => v.trim()).filter(Boolean).map((v) => ({ ...s, key: fold(v) })));
  }
  return streetCache;
}

/** Straten die (bijna) letterlijk in de tekst voorkomen, ook als STT ze los of fout schrijft. */
export function candidateStreets(text, limit = 120) {
  const words = String(text).split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean).map(fold).filter(Boolean);
  const grams = new Map(); // lengte → Set
  for (let i = 0; i < words.length; i++) {
    let g = '';
    for (let n = 0; n < 3 && i + n < words.length; n++) {
      g += words[i + n];
      if (g.length >= 6) {
        if (!grams.has(g.length)) grams.set(g.length, new Set());
        grams.get(g.length).add(g);
      }
    }
  }
  const hits = [];
  for (const s of streetIndex()) {
    if (s.key.length < 6) continue;
    const max = s.key.length >= 12 ? 2 : 1;
    let best = 99;
    for (let L = s.key.length - max; L <= s.key.length + max && best > 0; L++) {
      const set = grams.get(L);
      if (!set) continue;
      if (set.has(s.key)) { best = 0; break; }
      for (const g of set) {
        if (g[0] !== s.key[0]) continue;
        const d = lev(g, s.key, max);
        if (d < best) best = d;
        if (!best) break;
      }
    }
    if (best <= max) hits.push({ ...s, d: best });
  }
  hits.sort((a, b) => a.d - b.d);
  // per straat (naam + deelgemeente) enkel de beste treffer
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.naam}|${h.deelgemeente}`; return seen.has(k) ? false : seen.add(k); }).slice(0, limit);
}

export function renderStraten(text) {
  const byName = new Map();
  const vars = new Map();
  for (const s of candidateStreets(text)) {
    const deel = byName.get(s.naam) || [];
    if (!deel.includes(s.deelgemeente)) deel.push(s.deelgemeente);
    byName.set(s.naam, deel);
    if (s.varianten) vars.set(s.naam, s.varianten);
  }
  if (!byName.size) return null;
  return [...byName].map(([naam, deel]) => `- ${naam} (${deel.join(', ')})${vars.has(naam) ? ` — gekende STT-vervormingen: ${vars.get(naam)}` : ''}`).join('\n');
}

// ---------- Vergadering en agenda ----------
export function renderVergadering(meeting) {
  if (!meeting) return null;
  const lines = [`Type: ${meeting.orgaan || 'onbekend'}`];
  if (meeting.commissie) {
    const c = db.prepare('SELECT * FROM commissies WHERE code = ?').get(meeting.commissie);
    lines.push(`Commissie: ${meeting.commissie}${c?.naam ? ` (${c.naam})` : ''}`);
  }
  if (meeting.datum) lines.push(`Datum: ${meeting.datum}`);
  if (meeting.voorzitter) lines.push(`Voorzitter van deze vergadering: ${meeting.voorzitter}`);
  if (meeting.titel) lines.push(`Titel: ${meeting.titel}`);
  return lines.join('\n');
}

const TYPE_LABEL = { mondelinge_vraag: 'mondelinge vraag', voorstel: 'voorstel tot raadsbesluit', schriftelijke_vraag: 'schriftelijke vraag' };

/** Eén agendapunt uitgebreid (met toelichting) voor het stuk transcriptie dat erover gaat. */
export function renderAgendapunt(points) {
  const list = (Array.isArray(points) ? points : [points]).filter(Boolean);
  if (!list.length) return null;
  return list.map((p) => {
    const indieners = json(p.indieners, []) || [];
    const lines = [`Punt ${p.nummer || '?'}${p.code ? ` (${p.code})` : ''}: ${p.titel}`, `Type: ${TYPE_LABEL[p.type] || p.type || 'onbekend'}`];
    if (indieners.length) lines.push(`Indiener(s): ${indieners.join(', ')}`);
    if (p.bevoegd) lines.push(`Bevoegd (antwoordt): ${p.bevoegd}`);
    if (p.sectie) lines.push(`Sectie: ${p.sectie}`);
    if (p.toelichting) lines.push(`Toelichting uit de agenda:\n${p.toelichting.slice(0, 4000)}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function renderAgenda(meeting) {
  if (!meeting) return null;
  // Agendapunten uit de databank (in code ingelezen): bij een selectie enkel de geselecteerde
  let points = db.prepare('SELECT * FROM meeting_points WHERE meeting_id = ? ORDER BY ord').all(meeting.id);
  if (points.some((p) => p.selected) && points.some((p) => !p.selected)) points = points.filter((p) => p.selected);
  if (points.length) {
    return points.map((p) => {
      const ind = (json(p.indieners, []) || []).join(', ');
      return `- Punt ${p.nummer || '?'} [${TYPE_LABEL[p.type] || p.type}]: ${String(p.titel).slice(0, 140)}${ind ? ` | indiener: ${ind}` : ''}${p.bevoegd ? ` | bevoegd: ${p.bevoegd}` : ''}`;
    }).join('\n');
  }
  const a = json(meeting?.agenda_json);
  if (!a?.punten?.length) return null;
  let out = '';
  for (const p of a.punten) {
    out += `- Punt ${p.nummer || '?'} [${p.type || 'punt'}]: ${p.titel}`;
    if (p.indieners?.length) out += ` | indiener: ${p.indieners.join(', ')}`;
    if (p.schepen) out += ` | bevoegd: ${p.schepen}`;
    if (p.kern) out += `\n  ${p.kern}`;
    out += '\n';
  }
  if (a.context?.length) out += `\nNamen en termen uit de agenda: ${a.context.map((c) => c.correct).join(', ')}\n`;
  return out;
}

const REF_TITLES = {
  leden: 'LEDEN', bevoegdheden: 'BEVOEGDHEDEN', terminologie: 'GENTSE TERMINOLOGIE',
  straten: 'STRATENLIJST', agenda: 'AGENDA', agendapunt: 'AGENDAPUNT', vergadering: 'VERGADERING', pipeline: 'PIPELINE',
};
export const REF_KEYS = Object.keys(REF_TITLES);

/**
 * Systeemprompt = skilltekst (zonder frontmatter) + gevraagde referenties.
 * Geeft { system, refs } terug; refs beschrijft per referentie of en hoe groot ze meeging (voor debug).
 */
export function buildPrompt(skill, { meeting, text, points } = {}) {
  const body = skill.content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const parts = [body];
  const refs = [];
  for (const ref of json(skill.refs, [])) {
    let content = null;
    let note = '';
    if (ref === 'leden') content = renderLeden();
    else if (ref === 'bevoegdheden') content = renderBevoegdheden();
    else if (ref === 'terminologie') content = renderTerminologie();
    else if (ref === 'straten') {
      content = text ? renderStraten(text) : null;
      note = content ? `${content.split('\n').length} kandidaat-straten` : 'geen straten herkend in de tekst';
    } else if (ref === 'agenda') {
      content = renderAgenda(meeting);
      if (!content) note = meeting?.agenda_name ? `agenda niet uitgelezen (status: ${meeting.agenda_status || '?'})` : 'geen agenda opgeladen';
    } else if (ref === 'agendapunt') {
      content = renderAgendapunt(points);
      if (!content) note = 'stuk niet aan een agendapunt gekoppeld';
    } else if (ref === 'vergadering') content = renderVergadering(meeting);
    else if (ref === 'pipeline') content = db.prepare("SELECT content FROM skills WHERE naam = 'verslag-pipeline'").get()?.content;
    refs.push({ ref, included: !!content, chars: content ? content.length : 0, lines: content ? content.split('\n').length : 0, note });
    if (content) parts.push(`# REFERENTIE: ${REF_TITLES[ref] || ref.toUpperCase()}\n\n${content}`);
  }
  return { system: parts.join('\n\n---\n\n'), refs, skillChars: body.length };
}

export function buildSystemPrompt(skill, opts) {
  return buildPrompt(skill, opts).system;
}

// Leerlus: correcties uit de output → termen (referentielijsten) of skill-aanpassingen.
import { diffWordsWithSpace } from 'diff';
import { db } from '../db.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const splitVars = (s) => String(s || '').split(',').map((v) => v.trim()).filter(Boolean);
const TITLES = /^(?:de |het )?(?:schepen|raadslid|burgemeester|voorzitter|mevrouw|mijnheer|meneer|collega|minister)\s+/i;

/**
 * Hoort deze "correcte schrijfwijze" bij één raadslid of één straat?
 * "Bracke (Sofie Bracke)", "Sofie Bracke", "schepen Bracke", "De Weder" → lid; "de Nekkersberglaan" → straat.
 * Twijfelachtige vormen ("vermoedelijk …") en namen buiten de lijsten → null (blijft terminologie).
 */
export function resolveTarget(correct, categorie) {
  const c = String(correct || '').trim();
  if (!c || /vermoedelijk|\?/i.test(c)) return null;
  const paren = c.match(/^(.*?)\s*\((.*)\)\s*$/);
  const candidates = (paren ? [paren[2], paren[1]] : [c]).map((x) => x.replace(TITLES, '').trim()).filter(Boolean);
  if (categorie !== 'straat') {
    const members = db.prepare('SELECT id, naam, match_namen FROM members').all();
    for (const cand of candidates) {
      const f = fold(cand);
      const full = members.filter((m) => fold(m.naam) === f);
      if (full.length === 1) return { kind: 'lid', row: full[0] };
      const bySurname = members.filter((m) => String(m.match_namen || '').split('/').map(fold).includes(f));
      if (bySurname.length === 1) return { kind: 'lid', row: bySurname[0] };
    }
  }
  if (['straat', 'wijk', 'naam_fout', 'aanvulling', undefined, null, ''].includes(categorie)) {
    for (const cand of candidates) {
      const f = fold(cand.replace(/^(de|het)\s+/i, ''));
      const streets = db.prepare('SELECT id, naam, deelgemeente FROM streets').all().filter((s) => fold(s.naam) === f);
      // dezelfde straatnaam in meerdere deelgemeenten: overal bijschrijven
      if (streets.length) return { kind: 'straat', rows: streets, row: streets[0] };
    }
  }
  return null;
}

/** Vervormingen bijschrijven bij een lid of straat (zonder dubbels, zonder de correcte naam zelf). */
export function addVariants(kind, id, variants) {
  const table = kind === 'lid' ? 'members' : 'streets';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return 0;
  const have = splitVars(row.varianten);
  // de juiste naam en gewone achternaamvormen (match-namen) zijn geen vervorming
  const known = new Set([...have.map(norm), norm(row.naam), ...String(row.match_namen || '').split('/').map(norm)]);
  const add = splitVars(Array.isArray(variants) ? variants.join(',') : variants).filter((v) => !known.has(norm(v)) && known.add(norm(v)));
  if (add.length) db.prepare(`UPDATE ${table} SET varianten = ? WHERE id = ?`).run([...have, ...add].join(', '), id);
  return add.length;
}

/**
 * Leert een vervorming. Hoort ze bij een raadslid of straat, dan komt ze daar (bij status "actief")
 * of blijft ze een voorstel tot ze goedgekeurd wordt. Anders: terminologie.
 * Geeft een verwijzing terug: "lid:12", "straat:340", "term:55" of null.
 */
export function addTermProposal({ categorie, correct, varianten = '', toelichting = null, bron, meetingId = null, status = 'voorstel' }) {
  correct = String(correct || '').trim();
  if (!correct) return null;
  const vars = splitVars(varianten);
  const target = vars.length ? resolveTarget(correct, categorie) : null;
  if (target) {
    const table = target.kind === 'lid' ? 'members' : 'streets';
    const missing = vars.filter((v) => !(target.rows || [target.row]).every((r) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.id);
      return [...splitVars(row.varianten).map(norm), norm(row.naam), ...String(row.match_namen || '').split('/').map(norm)].includes(norm(v));
    }));
    if (!missing.length) return `${target.kind}:${target.row.id}`; // al gekend
    if (status === 'actief') {
      for (const r of target.rows || [target.row]) addVariants(target.kind, r.id, missing);
      return `${target.kind}:${target.row.id}`;
    }
    // voorstel: in de terminologie als voorstel, bij goedkeuring verhuist het naar het lid/de straat
  }
  const existing = db.prepare('SELECT * FROM terms WHERE lower(correct) = ? AND categorie != ?').all(norm(correct), 'richtlijn');
  for (const t of existing) {
    const have = splitVars(t.varianten).map(norm);
    const missing = vars.filter((v) => !have.includes(norm(v)) && norm(v) !== norm(correct));
    if (!missing.length) return `term:${t.id}`;
    if (status === 'actief' || t.status === 'voorstel') {
      db.prepare("UPDATE terms SET varianten = ?, updated_at = datetime('now') WHERE id = ?")
        .run([t.varianten, ...missing].filter(Boolean).join(', '), t.id);
      return `term:${t.id}`;
    }
  }
  // Leden staan in de ledenlijst; enkel een vervorming ervan is een nieuwe term
  if (!vars.length && db.prepare('SELECT 1 FROM members WHERE lower(naam) = ?').get(norm(correct))) return null;
  const r = db.prepare(`INSERT INTO terms (categorie, varianten, correct, toelichting, bron, status, meeting_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(categorie || 'project', vars.join(', ') || null, correct, toelichting || null, bron, status, meetingId);
  return `term:${r.lastInsertRowid}`;
}

/**
 * Een term (actief gezet of goedgekeurd) die eigenlijk een vervorming van een lid of straat is,
 * verhuist naar dat lid of die straat. Geeft "lid:ID"/"straat:ID" of null (blijft een term).
 */
export function promoteTerm(termId) {
  const t = db.prepare('SELECT * FROM terms WHERE id = ?').get(termId);
  if (!t || t.status !== 'actief' || !t.varianten || t.categorie === 'richtlijn') return null;
  const target = resolveTarget(t.correct, t.categorie);
  if (!target) return null;
  for (const r of target.rows || [target.row]) addVariants(target.kind, r.id, t.varianten);
  db.prepare('DELETE FROM terms WHERE id = ?').run(termId);
  return `${target.kind}:${target.row.id}`;
}

/** Eenmalig: bestaande naam- en straatvervormingen uit de terminologie naar leden en straten. */
export function migrateVariantsOnce() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migrated_variants_v1'").get();
  if (done) return 0;
  const ids = db.prepare("SELECT id FROM terms WHERE status = 'actief' AND varianten IS NOT NULL AND categorie IN ('naam_fout', 'aanvulling', 'wijk', 'straat')").all().map((r) => r.id);
  let moved = 0;
  db.transaction(() => { for (const id of ids) if (promoteTerm(id)) moved++; })();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_variants_v1', ?)").run(String(moved));
  return moved;
}

/**
 * Woorddiff tussen oud en nieuw: lijst van {before, after} vervangingen (voor "onthoud als term" en het log).
 * Wijzigingen die enkel door spaties gescheiden zijn, worden één vervanging ("nieuw gent" → "Nieuw-Gent").
 */
export function replacementsFromEdit(before, after) {
  const parts = diffWordsWithSpace(String(before || ''), String(after || ''));
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      const r = { before: cur.before.replace(/\s+/g, ' ').trim(), after: cur.after.replace(/\s+/g, ' ').trim() };
      if (r.before !== r.after && (r.before || r.after)) out.push(r);
    }
    cur = null;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.added || p.removed) {
      cur = cur || { before: '', after: '' };
      if (p.removed) cur.before += p.value;
      else cur.after += p.value;
    } else if (cur && /^\s+$/.test(p.value) && (parts[i + 1]?.added || parts[i + 1]?.removed)) {
      cur.before += p.value;
      cur.after += p.value;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

export function recordCorrection({ runId, blockId, field, before, after, lesson }) {
  return db.prepare('INSERT INTO corrections (run_id, block_id, field, before, after, lesson) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, blockId, field, before, after, lesson || null).lastInsertRowid;
}

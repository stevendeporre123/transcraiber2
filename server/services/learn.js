// Leerlus: correcties uit de output → termen (referentielijsten) of skill-aanpassingen.
import { diffWordsWithSpace } from 'diff';
import { db } from '../db.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/** Voegt een term toe als voorstel, tenzij hij al bestaat (als correcte naam of als variant). */
export function addTermProposal({ categorie, correct, varianten = '', toelichting = null, bron, meetingId = null, status = 'voorstel' }) {
  correct = String(correct || '').trim();
  if (!correct) return null;
  const vars = String(varianten || '').split(',').map((v) => v.trim()).filter(Boolean);
  const existing = db.prepare('SELECT * FROM terms WHERE lower(correct) = ? AND categorie != ?').all(norm(correct), 'richtlijn');
  for (const t of existing) {
    const have = String(t.varianten || '').split(',').map(norm);
    const missing = vars.filter((v) => !have.includes(norm(v)) && norm(v) !== norm(correct));
    if (!missing.length) return t.id;
    if (status === 'actief' || t.status === 'voorstel') {
      // bestaande term aanvullen met de nieuwe varianten
      db.prepare("UPDATE terms SET varianten = ?, updated_at = datetime('now') WHERE id = ?")
        .run([t.varianten, ...missing].filter(Boolean).join(', '), t.id);
      return t.id;
    }
  }
  // Leden staan in de ledenlijst; enkel een vervorming ervan is een nieuwe term
  if (!vars.length && db.prepare('SELECT 1 FROM members WHERE lower(naam) = ?').get(norm(correct))) return null;
  const r = db.prepare(`INSERT INTO terms (categorie, varianten, correct, toelichting, bron, status, meeting_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(categorie || 'project', vars.join(', ') || null, correct, toelichting || null, bron, status, meetingId);
  return r.lastInsertRowid;
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

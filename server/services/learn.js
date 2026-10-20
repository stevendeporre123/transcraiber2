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

/** Woorddiff tussen oud en nieuw: lijst van {before, after} vervangingen (voor het voorstel "onthoud als term"). */
export function replacementsFromEdit(before, after) {
  const parts = diffWordsWithSpace(String(before || ''), String(after || ''));
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.removed && parts[i + 1]?.added) {
      out.push({ before: p.value.trim(), after: parts[i + 1].value.trim() });
      i++;
    } else if (p.added && !p.removed) {
      out.push({ before: '', after: p.value.trim() });
    } else if (p.removed) {
      out.push({ before: p.value.trim(), after: '' });
    }
  }
  return out.filter((r) => r.before || r.after);
}

export function recordCorrection({ runId, blockId, field, before, after, lesson }) {
  return db.prepare('INSERT INTO corrections (run_id, block_id, field, before, after, lesson) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, blockId, field, before, after, lesson || null).lastInsertRowid;
}

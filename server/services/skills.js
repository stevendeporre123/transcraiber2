// Skillbeheer: versies, en het promptvenster (skill-assistent) dat skills aanpast via natuurlijke taal.
import { createTwoFilesPatch } from 'diff';
import { db, json } from '../db.js';
import { complete, defaultModel, parseJsonLoose } from './openrouter.js';
import { buildSystemPrompt } from './context.js';
import { parseSkillFile } from '../seed.js';

export function saveSkillVersion(skillId, content, { note, author }) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!skill) throw new Error('Skill niet gevonden');
  if (content === skill.content) return skill;
  const meta = parseSkillFile(content);
  const version = skill.version + 1;
  db.transaction(() => {
    db.prepare(`UPDATE skills SET content = ?, version = ?, beschrijving = COALESCE(?, beschrijving),
      refs = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(content, version, meta.description || null, JSON.stringify(meta.refs?.length || /^refs:/m.test(content) ? meta.refs : json(skill.refs, [])), skillId);
    db.prepare('INSERT INTO skill_versions (skill_id, version, content, note, author) VALUES (?, ?, ?, ?, ?)')
      .run(skillId, version, content, note || null, author || 'manueel');
  })();
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
}

export function skillDiff(name, oldText, newText) {
  return createTwoFilesPatch(`${name} (huidig)`, `${name} (voorstel)`, oldText, newText, '', '', { context: 3 });
}

/** Correcties die nog niet verwerkt zijn, als tekst voor de assistent. */
export function pendingCorrectionsText(ids) {
  const rows = ids?.length
    ? db.prepare(`SELECT * FROM corrections WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare('SELECT * FROM corrections WHERE processed = 0 ORDER BY id DESC LIMIT 40').all();
  return {
    ids: rows.map((r) => r.id),
    text: rows.map((r) => `- [${r.field}] run ${r.run_id} ${r.block_id}\n  VOOR: ${r.before}\n  NA:   ${r.after}${r.lesson ? `\n  UITLEG: ${r.lesson}` : ''}`).join('\n'),
  };
}

/**
 * Vraagt de skill-assistent om een aangepaste versie van een skill.
 * Geeft { content, samenvatting, termen, diff } terug; er wordt nog niets opgeslagen.
 */
export async function proposeSkillChange({ skillName, instruction, correctionIds, includeCorrections, model }) {
  const target = db.prepare('SELECT * FROM skills WHERE naam = ?').get(skillName);
  if (!target) throw new Error(`Skill ${skillName} niet gevonden`);
  const assistant = db.prepare("SELECT * FROM skills WHERE naam = 'skill-assistent'").get();
  const others = db.prepare('SELECT naam, beschrijving FROM skills WHERE naam NOT IN (?, ?)').all(skillName, 'skill-assistent');
  const corr = includeCorrections || correctionIds?.length ? pendingCorrectionsText(correctionIds) : { ids: [], text: '' };

  const user = [
    `DOELSKILL: ${target.naam}`,
    `<<<SKILL\n${target.content}\nSKILL>>>`,
    `ANDERE SKILLS:\n${others.map((o) => `- ${o.naam}: ${o.beschrijving || ''}`).join('\n')}`,
    `VRAAG:\n${instruction || '(geen extra vraag: verwerk de correcties)'}`,
    corr.text ? `CORRECTIES:\n${corr.text}` : '',
  ].filter(Boolean).join('\n\n');

  const res = await complete({ model: model || defaultModel('assistant'), system: buildSystemPrompt(assistant), user, json: true, temperature: 0.2 });
  const j = parseJsonLoose(res.text);
  if (!j.content || typeof j.content !== 'string') throw new Error('Het model gaf geen nieuwe skilltekst terug.');
  if (!/^---\n[\s\S]*?\n---/.test(j.content)) j.content = target.content.match(/^---\n[\s\S]*?\n---\n?/)?.[0] + '\n' + j.content;
  return {
    skill: target.naam,
    baseVersion: target.version,
    content: j.content,
    samenvatting: j.samenvatting || '',
    termen: Array.isArray(j.termen) ? j.termen : [],
    correctionIds: corr.ids,
    diff: skillDiff(target.naam, target.content, j.content),
    cost: res.cost,
    model: res.model,
  };
}

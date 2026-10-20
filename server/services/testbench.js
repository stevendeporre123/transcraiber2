// Testbank: één skill testen op een klein stuk input, met één of meer modellen naast elkaar.
import { db, json, getNumberSetting } from '../db.js';
import { STEPS } from '../config.js';
import { complete, defaultModel } from './openrouter.js';
import { buildPrompt } from './context.js';
import { parseBlocks, wordCount } from './blockfmt.js';
import { readInput } from './extract.js';
import { blocksFromCues, blocksFromText, chunkBlocks } from './intake.js';
import { analyzeOutput, logSummary, BLOCK_STEPS } from './analyze.js';
import { validateNormalizer, validateCleaner } from './pipeline.js';
import { log } from './logger.js';

export const TEST_STEPS = ['normalizer', 'cleaner', 'resolver', 'writer', 'intake', 'agenda'];

// Intake (code) van een vergadering, in het geheugen gecachet per bestand.
const intakeCache = new Map();
export async function meetingBlocks(meetingId, chunkWords) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!m) throw new Error('Vergadering niet gevonden');
  let blocks = intakeCache.get(m.input_file);
  if (!blocks) {
    const input = await readInput(m.input_file, m.input_type);
    blocks = input.cues ? blocksFromCues(input.cues) : blocksFromText(input.pages).blocks;
    intakeCache.set(m.input_file, blocks);
  }
  const size = Number(chunkWords) >= 200 ? Number(chunkWords) : getNumberSetting('chunk_words', 2000, 200, 20000);
  let idx = 0;
  const chunks = chunkBlocks(blocks, size).map((c, i) => {
    const from = idx + 1;
    idx += c.length;
    return { index: i, from, to: idx, first: c[0].id, last: c[c.length - 1].id, words: c.reduce((n, b) => n + wordCount(b.text_raw), 0) };
  });
  return {
    meeting: { id: m.id, titel: m.titel, orgaan: m.orgaan, datum: m.datum, input_name: m.input_name, input_type: m.input_type, agenda_status: m.agenda_status, has_agenda_text: !!m.agenda_text },
    blocks: blocks.map((b) => ({ id: b.id, speaker: b.speaker_raw, text: b.text_raw, t_start: b.t_start, t_end: b.t_end, words: wordCount(b.text_raw) })),
    chunks,
    chunkWords: size,
  };
}

export function agendaText(meetingId) {
  return db.prepare('SELECT agenda_text FROM meetings WHERE id = ?').get(meetingId)?.agenda_text || '';
}

/** Zou de pipeline deze uitvoer aanvaarden? (zelfde validatie als in een echte run) */
function pipelineValidation(step, inputBlocks, output) {
  const rows = inputBlocks.map((b) => ({ block_id: b.id, speaker_raw: b.speaker === '?' ? null : b.speaker, text_raw: b.text, text_norm: b.text }));
  try {
    if (step === 'normalizer') return { ok: true, warnings: validateNormalizer(rows)(output).warnings || [] };
    if (step === 'cleaner') return { ok: true, warnings: validateCleaner(rows)(output).warnings || [] };
    return null;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * opts: { step, input, models: [..], skillContent?, refs?, meetingId?, label? }
 * Geeft per model { id, model, output, analysis, validation, tokens, cost, ms, error }.
 */
export async function runTest({ step, input, models, skillContent, refs, meetingId, label }) {
  if (!TEST_STEPS.includes(step)) throw new Error(`Onbekende stap ${step}`);
  if (!String(input || '').trim()) throw new Error('Geen invoer');
  const skill = db.prepare('SELECT * FROM skills WHERE naam = ?').get(STEPS[step].skill);
  const draft = skillContent != null && skillContent !== skill.content;
  const used = { ...skill, content: skillContent ?? skill.content, refs: Array.isArray(refs) ? JSON.stringify(refs) : skill.refs };
  const meeting = meetingId ? db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId) : null;

  let user = String(input);
  if (step === 'writer' && !/^MODUS:/m.test(user)) user = `MODUS: PUNTEN\nVORIG PUNT: geen (begin van de vergadering)\n\n${user}`;
  const inputBlocks = parseBlocks(user).blocks;
  if (['normalizer', 'cleaner', 'resolver'].includes(step) && !inputBlocks.length) {
    throw new Error('De invoer bevat geen blokken ("## B001 | spreker: …"). Laad blokken uit een vergadering of gebruik de uitvoer van een vorige test.');
  }
  const { system, refs: refInfo, skillChars } = buildPrompt(used, { meeting, text: user });
  const list = (models?.length ? models : [defaultModel(step)]).filter(Boolean).slice(0, 4);
  const isJson = step === 'writer' || step === 'agenda';

  return Promise.all(list.map(async (model) => {
    const row = db.prepare(`INSERT INTO test_runs (meeting_id, step, model, skill_version, skill_draft, label, input, system)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(meetingId || null, step, model, skill.version, draft ? 1 : 0, label || null, user, system);
    const testId = row.lastInsertRowid;
    const L = (level, message, data) => log({ testId, level, step, message, data });
    L('info', `test ${skill.naam} v${skill.version}${draft ? ' (concept)' : ''} met ${model}`, {
      invoer_blokken: inputBlocks.length, invoer_tekens: user.length, systeemprompt_tekens: system.length, skill_tekens: skillChars,
      referenties: refInfo.map((r) => `${r.ref}: ${r.included ? `${r.chars} tekens` : 'NIET meegestuurd'}${r.note ? ` (${r.note})` : ''}`),
    });
    try {
      const res = await complete({ model, system, user, json: isJson });
      const analysis = BLOCK_STEPS.includes(step) || step === 'resolver' || isJson ? analyzeOutput(step, inputBlocks, res.text) : null;
      const validation = pipelineValidation(step, inputBlocks, res.text);
      db.prepare('UPDATE test_runs SET model = ?, output = ?, analysis = ?, tokens_in = ?, tokens_out = ?, cost = ?, ms = ? WHERE id = ?')
        .run(res.model || model, res.text, JSON.stringify({ analysis, validation, refs: refInfo, finishReason: res.finishReason }), res.tokensIn, res.tokensOut, res.cost, res.ms, testId);
      L('info', `antwoord in ${(res.ms / 1000).toFixed(1)} s, ${res.tokensIn}/${res.tokensOut} tokens, $${(res.cost || 0).toFixed(4)}`, analysis ? logSummary(analysis) : undefined);
      return { id: testId, model: res.model || model, requested: model, output: res.text, analysis, validation, refs: refInfo, finishReason: res.finishReason, tokens_in: res.tokensIn, tokens_out: res.tokensOut, cost: res.cost, ms: res.ms, system, user };
    } catch (e) {
      db.prepare('UPDATE test_runs SET error = ? WHERE id = ?').run(e.message, testId);
      L('error', e.message);
      return { id: testId, model, requested: model, error: e.message, refs: refInfo, system, user };
    }
  }));
}

export function getTest(id) {
  const t = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id);
  if (!t) return null;
  const a = json(t.analysis, {}) || {};
  return { ...t, analysis: a.analysis || null, validation: a.validation || null, refs: a.refs || [], finishReason: a.finishReason };
}

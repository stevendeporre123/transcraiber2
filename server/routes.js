import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { diffWordsWithSpace } from 'diff';
import { db, json, getSetting, setSetting } from './db.js';
import { UPLOAD_DIR, STEPS, config } from './config.js';
import { detectType, hasTimecodes, readAgendaText } from './services/extract.js';
import { runPipeline, processAgenda, isActive } from './services/pipeline.js';
import { buildReport, toDocx, toPdf, toVtt } from './services/export.js';
import { listModels, apiKey, defaultModel } from './services/openrouter.js';
import { addTermProposal, replacementsFromEdit, recordCorrection } from './services/learn.js';
import { saveSkillVersion, proposeSkillChange, skillDiff } from './services/skills.js';
import { renderLeden, renderBevoegdheden, renderTerminologie, invalidateStreets, TERM_CATEGORIES, REF_KEYS } from './services/context.js';

export const api = express.Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Express 5 vangt async fouten zelf op; we geven ze als JSON terug.
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === '' ? null : obj[k]]));
const notFound = (res) => res.status(404).json({ error: 'Niet gevonden' });

// ---------------- Generieke CRUD ----------------
function crud(route, table, fields, { order = 'id', onChange } = {}) {
  api.get(`/${route}`, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()));
  api.post(`/${route}`, (req, res) => {
    const data = pick(req.body, fields);
    const keys = Object.keys(data);
    const r = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(data);
    onChange?.();
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid));
  });
  api.put(`/${route}/:id`, (req, res) => {
    const data = pick(req.body, fields);
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'Geen velden' });
    const extra = ['members', 'terms'].includes(table) ? ", updated_at = datetime('now')" : '';
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')}${extra} WHERE id = @id`).run({ ...data, id: req.params.id });
    onChange?.();
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
  });
  api.delete(`/${route}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    onChange?.();
    res.json({ ok: true });
  });
}

crud('members', 'members', ['naam', 'match_namen', 'geslacht', 'fractie', 'functie', 'aanspreekvorm', 'portefeuille', 'trefwoorden', 'notitie', 'actief'], { order: 'actief DESC, naam' });
crud('terms', 'terms', ['categorie', 'varianten', 'correct', 'toelichting', 'bron', 'status'], { order: "status = 'voorstel' DESC, categorie, correct" });
crud('streets', 'streets', ['naam', 'deelgemeente'], { order: 'naam', onChange: invalidateStreets });
crud('commissies', 'commissies', ['code', 'naam', 'schepenen', 'voorzitter'], { order: 'code' });

api.get('/meta', (req, res) => {
  res.json({
    termCategories: TERM_CATEGORIES,
    refKeys: REF_KEYS,
    steps: STEPS,
    fracties: db.prepare('SELECT DISTINCT fractie FROM members WHERE fractie IS NOT NULL ORDER BY fractie').all().map((r) => r.fractie),
    commissies: db.prepare('SELECT code, naam, voorzitter FROM commissies ORDER BY code').all(),
    pendingTerms: db.prepare("SELECT COUNT(*) n FROM terms WHERE status = 'voorstel'").get().n,
    pendingCorrections: db.prepare('SELECT COUNT(*) n FROM corrections WHERE processed = 0').get().n,
    mock: config.mockLlm,
  });
});

api.post('/terms/bulk', (req, res) => {
  const { ids = [], action } = req.body;
  const stmt = action === 'delete'
    ? db.prepare('DELETE FROM terms WHERE id = ?')
    : db.prepare(`UPDATE terms SET status = ?, updated_at = datetime('now') WHERE id = ?`);
  db.transaction(() => ids.forEach((id) => (action === 'delete' ? stmt.run(id) : stmt.run(action === 'approve' ? 'actief' : 'inactief', id))))();
  res.json({ ok: true, count: ids.length });
});

// Referenties als md (om terug te gebruiken als skillbestand buiten de tool)
api.get('/references/:name', (req, res) => {
  const map = { 'leden.md': renderLeden, 'bevoegdheden.md': renderBevoegdheden, 'gentse-terminologie.md': renderTerminologie,
    'stratenlijst.md': () => db.prepare('SELECT naam, deelgemeente FROM streets ORDER BY deelgemeente, naam').all().reduce((s, r, i, a) => s + (i === 0 || a[i - 1].deelgemeente !== r.deelgemeente ? `\n### ${r.deelgemeente}\n\n` : '') + `- ${r.naam}\n`, '# Stratenlijst Gent\n') };
  const fn = map[req.params.name];
  if (!fn) return notFound(res);
  res.type('text/markdown').attachment(req.params.name).send(fn());
});

// ---------------- Instellingen ----------------
const SETTING_KEYS = ['model_default', ...Object.keys(STEPS).map((s) => `model_${s}`), 'temperature', 'chunk_words', 'concurrency', 'harvest_normalizer', 'timeout_s'];
api.get('/settings', (req, res) => {
  const s = Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(k)]));
  const effective = Object.fromEntries(Object.keys(STEPS).map((st) => [st, defaultModel(st)]));
  res.json({ ...s, effective, hasKey: !!apiKey(), keyFromEnv: !!process.env.OPENROUTER_API_KEY, mock: config.mockLlm });
});
api.put('/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(k, req.body[k] === '' ? null : req.body[k]);
  if (req.body.openrouter_api_key) setSetting('openrouter_api_key', req.body.openrouter_api_key.trim());
  if (req.body.clear_key) setSetting('openrouter_api_key', null);
  res.json({ ok: true });
});
api.get('/models', async (req, res) => {
  try { res.json(await listModels()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------------- Skills ----------------
api.get('/skills', (req, res) => {
  res.json(db.prepare(`SELECT id, naam, beschrijving, refs, in_pipeline, version, updated_at, length(content) AS size FROM skills
    ORDER BY CASE naam WHEN 'agenda-extractor' THEN 0 WHEN 'transcript-intake' THEN 1 WHEN 'gentse-normalizer' THEN 2 WHEN 'transcript-cleaner' THEN 3
      WHEN 'speaker-resolver' THEN 4 WHEN 'verslag-writer' THEN 5 ELSE 10 + id END`).all());
});
api.get('/skills/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res);
  s.versions = db.prepare('SELECT id, version, note, author, created_at FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(s.id);
  res.json(s);
});
api.get('/skills/:id/versions/:version', (req, res) => {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  const v = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?').get(req.params.id, req.params.version);
  if (!s || !v) return notFound(res);
  res.json({ ...v, diff: skillDiff(s.naam, v.content, s.content) });
});
api.put('/skills/:id', (req, res) => {
  const { content, note, refs } = req.body;
  let s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res);
  if (content != null) s = saveSkillVersion(s.id, content, { note: note || 'Manuele aanpassing', author: 'manueel' });
  if (Array.isArray(refs)) db.prepare('UPDATE skills SET refs = ? WHERE id = ?').run(JSON.stringify(refs), s.id);
  res.json(db.prepare('SELECT * FROM skills WHERE id = ?').get(s.id));
});
api.post('/skills/:id/restore/:version', (req, res) => {
  const v = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?').get(req.params.id, req.params.version);
  if (!v) return notFound(res);
  res.json(saveSkillVersion(Number(req.params.id), v.content, { note: `Teruggezet naar versie ${v.version}`, author: 'manueel' }));
});
api.get('/skills/:id/download', (req, res) => {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res);
  res.type('text/markdown').attachment(`${s.naam}.md`).send(s.content);
});
// Promptvenster: voorstel genereren (nog niet opslaan)
api.post('/skills/propose', async (req, res) => {
  try {
    res.json(await proposeSkillChange(req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Voorstel toepassen: nieuwe skillversie + gekozen termen + correcties als verwerkt markeren
api.post('/skills/apply', (req, res) => {
  const { skill, content, baseVersion, note, termen = [], correctionIds = [] } = req.body;
  const s = db.prepare('SELECT * FROM skills WHERE naam = ?').get(skill);
  if (!s) return notFound(res);
  if (baseVersion && s.version !== Number(baseVersion)) return res.status(409).json({ error: `De skill is intussen gewijzigd (versie ${s.version}). Genereer het voorstel opnieuw.` });
  const updated = content ? saveSkillVersion(s.id, content, { note: note || 'Aanpassing via skill-assistent', author: 'assistent' }) : s;
  const termIds = termen.map((t) => addTermProposal({ ...t, bron: 'assistent', status: 'actief' }));
  if (correctionIds.length) {
    const upd = db.prepare("UPDATE corrections SET processed = 1, learned = COALESCE(learned || ', ', '') || ? WHERE id = ?");
    for (const id of correctionIds) upd.run(`skill:${skill} v${updated.version}`, id);
  }
  res.json({ skill: updated, termIds });
});

// ---------------- Vergaderingen ----------------
const meetingFields = ['titel', 'orgaan', 'commissie', 'voorzitter', 'datum'];

api.get('/meetings', (req, res) => {
  res.json(db.prepare(`SELECT m.id, m.titel, m.orgaan, m.commissie, m.datum, m.input_name, m.input_type, m.has_timecodes, m.agenda_name, m.agenda_status, m.created_at,
    (SELECT COUNT(*) FROM runs r WHERE r.meeting_id = m.id) AS runs FROM meetings m ORDER BY m.id DESC`).all());
});
api.get('/meetings/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!m) return notFound(res);
  m.agenda = json(m.agenda_json);
  delete m.agenda_text;
  res.json(m);
});

api.post('/meetings', upload.fields([{ name: 'transcript', maxCount: 1 }, { name: 'agenda', maxCount: 1 }]), async (req, res) => {
  const tf = req.files?.transcript?.[0];
  if (!tf) return res.status(400).json({ error: 'Geen transcriptbestand opgeladen.' });
  let type;
  try { type = detectType(tf.originalname); } catch (e) { return res.status(400).json({ error: e.message }); }
  const data = pick(req.body, meetingFields);
  const r = db.prepare(`INSERT INTO meetings (titel, orgaan, commissie, voorzitter, datum, input_file, input_name, input_type, has_timecodes, agenda_status)
    VALUES (@titel, @orgaan, @commissie, @voorzitter, @datum, @file, @name, @type, @tc, 'geen')`)
    .run({ titel: null, orgaan: 'gemeenteraad', commissie: null, voorzitter: null, datum: null, ...data, file: tf.path, name: tf.originalname, type, tc: hasTimecodes(type) ? 1 : 0 });
  const id = r.lastInsertRowid;
  const af = req.files?.agenda?.[0];
  if (af) await attachAgenda(id, af);
  res.json(db.prepare('SELECT id, input_type, has_timecodes, agenda_status FROM meetings WHERE id = ?').get(id));
});

async function attachAgenda(meetingId, file) {
  const text = await readAgendaText(file.path);
  db.prepare("UPDATE meetings SET agenda_file = ?, agenda_name = ?, agenda_text = ?, agenda_json = NULL, agenda_status = 'nieuw' WHERE id = ?")
    .run(file.path, file.originalname, text, meetingId);
}

api.put('/meetings/:id', (req, res) => {
  const data = pick(req.body, meetingFields);
  if (req.body.agenda !== undefined) data.agenda_json = req.body.agenda ? JSON.stringify(req.body.agenda) : null;
  const keys = Object.keys(data);
  if (keys.length) db.prepare(`UPDATE meetings SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id: req.params.id });
  res.json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id));
});
api.post('/meetings/:id/agenda', upload.single('agenda'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen agendabestand' });
  await attachAgenda(req.params.id, req.file);
  res.json({ ok: true });
});
api.post('/meetings/:id/agenda/process', async (req, res) => {
  try { res.json(await processAgenda(Number(req.params.id), req.body?.model)); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.delete('/meetings/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!m) return notFound(res);
  if ([...db.prepare('SELECT id FROM runs WHERE meeting_id = ?').all(m.id)].some((r) => isActive(r.id))) return res.status(409).json({ error: 'Er loopt nog een verwerking.' });
  db.prepare('DELETE FROM meetings WHERE id = ?').run(m.id);
  for (const f of [m.input_file, m.agenda_file]) if (f) fs.rm(f, { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------- Runs ----------------
api.get('/runs', (req, res) => {
  const where = req.query.meeting ? 'WHERE r.meeting_id = ?' : '';
  const rows = db.prepare(`SELECT r.id, r.meeting_id, r.label, r.status, r.progress, r.options, r.cost, r.tokens_in, r.tokens_out, r.error,
      r.created_at, r.started_at, r.finished_at, m.titel, m.orgaan, m.commissie, m.datum, m.input_name, m.input_type, m.has_timecodes,
      (SELECT COUNT(*) FROM run_blocks b WHERE b.run_id = r.id AND b.merged_into IS NULL) AS blocks,
      (SELECT COUNT(*) FROM run_blocks b WHERE b.run_id = r.id AND b.edited = 1) AS edited
    FROM runs r JOIN meetings m ON m.id = r.meeting_id ${where} ORDER BY r.id DESC`).all(...(req.query.meeting ? [req.query.meeting] : []));
  res.json(rows.map((r) => ({ ...r, options: json(r.options, {}) })));
});

api.post('/runs', async (req, res) => {
  const { meeting_id, label, options = {} } = req.body;
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting_id);
  if (!m) return notFound(res);
  if (!config.mockLlm && !apiKey()) return res.status(400).json({ error: 'Stel eerst een OpenRouter API-key in (Instellingen).' });
  const r = db.prepare('INSERT INTO runs (meeting_id, label, options) VALUES (?, ?, ?)').run(m.id, label || null, JSON.stringify(options));
  startRun(r.lastInsertRowid, m, options);
  res.json({ id: r.lastInsertRowid });
});

function startRun(runId, meeting, options) {
  (async () => {
    // Agenda eerst uitlezen als dat nog niet gebeurd is
    if (meeting.agenda_text && !['klaar', 'bezig'].includes(meeting.agenda_status)) {
      db.prepare("UPDATE runs SET status = 'bezig', progress = 'Agenda uitlezen' WHERE id = ?").run(runId);
      try { await processAgenda(meeting.id, options.models?.agenda); } catch (e) {
        db.prepare('UPDATE runs SET warnings = ? WHERE id = ?').run(JSON.stringify([`Agenda kon niet uitgelezen worden: ${e.message}`]), runId);
      }
    }
    await runPipeline(runId);
  })();
}

api.post('/runs/:id/resume', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!run) return notFound(res);
  if (isActive(run.id)) return res.status(409).json({ error: 'Deze run loopt al.' });
  if (req.body?.redo) {
    // stap opnieuw: bewaarde output van die stap (en volgende stappen) wissen
    const order = ['intake', 'normalizer', 'cleaner', 'resolver', 'writer'];
    const from = order.indexOf(req.body.redo);
    if (from >= 0) {
      db.prepare(`DELETE FROM run_steps WHERE run_id = ? AND step IN (${order.slice(from).map(() => '?').join(',')})`).run(run.id, ...order.slice(from));
      if (from <= 2) db.prepare('DELETE FROM run_blocks WHERE run_id = ?').run(run.id);
    }
  }
  startRun(run.id, db.prepare('SELECT * FROM meetings WHERE id = ?').get(run.meeting_id), json(run.options, {}));
  res.json({ ok: true });
});

api.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!run) return notFound(res);
  const meeting = db.prepare('SELECT id, titel, orgaan, commissie, voorzitter, datum, input_name, input_type, has_timecodes, agenda_name, agenda_status, agenda_json FROM meetings WHERE id = ?').get(run.meeting_id);
  meeting.agenda = json(meeting.agenda_json);
  delete meeting.agenda_json;
  const steps = db.prepare('SELECT id, step, chunk, model, tokens_in, tokens_out, cost, ms, status, warnings FROM run_steps WHERE run_id = ? ORDER BY id').all(run.id);
  const blocks = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND merged_into IS NULL ORDER BY ord').all(run.id);
  res.json({ ...run, options: json(run.options, {}), report: json(run.report), warnings: json(run.warnings, []), skill_versions: json(run.skill_versions, {}), meeting, steps, blocks, active: isActive(run.id) });
});
api.get('/runs/:id/status', (req, res) => {
  const r = db.prepare('SELECT id, status, progress, error, cost FROM runs WHERE id = ?').get(req.params.id);
  r ? res.json({ ...r, active: isActive(r.id) }) : notFound(res);
});
api.get('/runs/:id/steps/:stepId', (req, res) => {
  const s = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND id = ?').get(req.params.id, req.params.stepId);
  s ? res.json(s) : notFound(res);
});
api.delete('/runs/:id', (req, res) => {
  if (isActive(Number(req.params.id))) return res.status(409).json({ error: 'Deze run loopt nog.' });
  db.prepare('DELETE FROM runs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Blok aanpassen in de output (+ optioneel leren)
api.put('/runs/:id/blocks/:blockId', (req, res) => {
  const runId = Number(req.params.id);
  const b = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND block_id = ?').get(runId, req.params.blockId);
  if (!b) return notFound(res);
  const { text_final, speaker_name, fractie, functie, point_idx, lesson, learnTerms = [], applyAll } = req.body;
  const corrections = [];
  if (text_final != null && text_final !== b.text_final) {
    corrections.push(recordCorrection({ runId, blockId: b.block_id, field: 'text', before: b.text_final, after: text_final, lesson }));
  }
  const speakerChanged = speaker_name != null && speaker_name !== b.speaker_name;
  if (speakerChanged) {
    corrections.push(recordCorrection({ runId, blockId: b.block_id, field: 'speaker', before: `${b.speaker_name} | ${b.fractie || '-'} | ${b.functie || '-'}`, after: `${speaker_name} | ${fractie || '-'} | ${functie || '-'}`, lesson }));
  }
  const upd = db.prepare(`UPDATE run_blocks SET text_final = COALESCE(?, text_final), speaker_name = COALESCE(?, speaker_name),
      fractie = COALESCE(?, fractie), functie = COALESCE(?, functie), zekerheid = CASE WHEN ? THEN 'manueel' ELSE zekerheid END,
      point_idx = COALESCE(?, point_idx), edited = 1 WHERE run_id = ? AND block_id = ?`);
  db.transaction(() => {
    upd.run(text_final ?? null, speaker_name ?? null, fractie ?? null, functie ?? null, speakerChanged ? 1 : 0, point_idx ?? null, runId, b.block_id);
    // Zelfde fout in alle blokken van deze run met dezelfde (oude) spreker
    if (speakerChanged && applyAll) {
      for (const o of db.prepare('SELECT block_id FROM run_blocks WHERE run_id = ? AND speaker_name = ? AND block_id != ? AND merged_into IS NULL').all(runId, b.speaker_name, b.block_id)) {
        upd.run(null, speaker_name, fractie ?? null, functie ?? null, 1, null, runId, o.block_id);
      }
    }
  })();
  const termIds = learnTerms.filter((t) => t.correct).map((t) => addTermProposal({ ...t, bron: 'correctie', status: 'actief', meetingId: db.prepare('SELECT meeting_id FROM runs WHERE id = ?').get(runId).meeting_id }));
  if (termIds.length) {
    for (const c of corrections) db.prepare('UPDATE corrections SET learned = ? WHERE id = ?').run(termIds.map((id) => `term:${id}`).join(', '), c);
  }
  res.json({ block: db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND block_id = ?').get(runId, b.block_id), corrections, termIds });
});

// Voorstel van vervangingen bij een tekstcorrectie (voor "onthoud als term")
api.post('/diff/replacements', (req, res) => res.json(replacementsFromEdit(req.body.before, req.body.after)));

api.put('/runs/:id/report', (req, res) => {
  const run = db.prepare('SELECT report FROM runs WHERE id = ?').get(req.params.id);
  if (!run) return notFound(res);
  const rep = { ...(json(run.report, {}) || {}), ...pick(req.body, ['titel', 'samenvatting', 'punten', 'waarschuwingen']) };
  db.prepare('UPDATE runs SET report = ? WHERE id = ?').run(JSON.stringify(rep), req.params.id);
  res.json(rep);
});

api.get('/runs/:id/export.:fmt', async (req, res) => {
  const runId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) return notFound(res);
  const r = buildReport(runId);
  const base = (r.titel || `verslag-${runId}`).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_');
  try {
    if (req.params.fmt === 'docx') return res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment(`${base}.docx`).send(await toDocx(r));
    if (req.params.fmt === 'pdf') return res.type('application/pdf').attachment(`${base}.pdf`).send(await toPdf(r));
    if (req.params.fmt === 'vtt') return res.type('text/vtt').attachment(`${base}.vtt`).send(toVtt(r));
    if (req.params.fmt === 'json') return res.json({ ...r, meeting: undefined });
  } catch (e) { return res.status(400).json({ error: e.message }); }
  notFound(res);
});

// Twee runs vergelijken (zelfde vergadering, ander model of andere skillversie)
api.get('/compare', (req, res) => {
  const { a, b } = req.query;
  const load = (id) => db.prepare('SELECT * FROM run_blocks WHERE run_id = ? ORDER BY ord').all(id);
  const ra = db.prepare('SELECT * FROM runs WHERE id = ?').get(a);
  const rb = db.prepare('SELECT * FROM runs WHERE id = ?').get(b);
  if (!ra || !rb) return notFound(res);
  if (ra.meeting_id !== rb.meeting_id) return res.status(400).json({ error: 'Runs horen bij een andere vergadering.' });
  const A = new Map(load(a).map((x) => [x.block_id, x]));
  const rows = [];
  let same = 0;
  for (const xb of load(b)) {
    const xa = A.get(xb.block_id);
    if (!xa) continue;
    // samengevoegde blokken: vergelijk op de tekst van het blok waarin ze opgingen
    const ta = xa.merged_into ? null : xa.text_final;
    const tb = xb.merged_into ? null : xb.text_final;
    const speakerDiff = (xa.speaker_name || '') !== (xb.speaker_name || '');
    if (ta === tb && !speakerDiff) { same++; continue; }
    rows.push({
      block_id: xb.block_id, raw: xb.text_raw,
      speaker_a: xa.speaker_name, speaker_b: xb.speaker_name, speakerDiff,
      merged_a: xa.merged_into, merged_b: xb.merged_into,
      diff: ta != null && tb != null ? diffWordsWithSpace(ta, tb) : null, text_a: ta, text_b: tb,
    });
  }
  const meta = (r) => ({ id: r.id, label: r.label, options: json(r.options, {}), cost: r.cost, tokens_in: r.tokens_in, tokens_out: r.tokens_out, skill_versions: json(r.skill_versions, {}) });
  res.json({ a: meta(ra), b: meta(rb), same, rows });
});

// ---------------- Correcties ----------------
api.get('/corrections', (req, res) => {
  const rows = db.prepare(`SELECT c.*, m.titel, m.datum FROM corrections c LEFT JOIN runs r ON r.id = c.run_id LEFT JOIN meetings m ON m.id = r.meeting_id ORDER BY c.id DESC`).all();
  res.json(rows.map((c) => ({ ...c, diff: c.field === 'text' ? diffWordsWithSpace(c.before || '', c.after || '') : null })));
});
api.put('/corrections/:id', (req, res) => {
  db.prepare('UPDATE corrections SET processed = COALESCE(?, processed), lesson = COALESCE(?, lesson) WHERE id = ?').run(req.body.processed ?? null, req.body.lesson ?? null, req.params.id);
  res.json({ ok: true });
});
api.delete('/corrections/:id', (req, res) => {
  db.prepare('DELETE FROM corrections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

api.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Serverfout' });
});

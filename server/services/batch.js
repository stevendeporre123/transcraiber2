// Modelvergelijking: dezelfde invoer met meerdere OpenRouter-modellen.
// - mode "step": één skill op een stuk invoer (zoals de Testbank) → rijen in test_runs
// - mode "pipeline": een volledige run per model op dezelfde vergadering → rijen in runs/run_steps
import { db, json } from '../db.js';
import { STEPS } from '../config.js';
import { prepareTest, insertTestRow, runTestModel, TEST_STEPS } from './testbench.js';
import { runPipeline, stopRun, isActive, STOP_STEPS } from './pipeline.js';
import { listSegments } from './prepare.js';
import { log } from './logger.js';

export const MAX_MODELS = 12;
const active = new Map(); // batchId → AbortController

export const isBatchActive = (id) => active.has(Number(id));

function cleanModels(models) {
  const list = [...new Set((Array.isArray(models) ? models : []).map((m) => String(m || '').trim()).filter(Boolean))];
  if (list.length < 2) throw new Error('Kies minstens twee modellen om te vergelijken.');
  if (list.length > MAX_MODELS) throw new Error(`Maximaal ${MAX_MODELS} modellen per vergelijking.`);
  return list;
}

async function pool(items, limit, fn, signal) {
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (i < items.length && !signal?.aborted) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

function finish(batchId, signal) {
  db.prepare("UPDATE model_batches SET status = ?, finished_at = datetime('now') WHERE id = ?").run(signal?.aborted ? 'gestopt' : 'klaar', batchId);
  active.delete(batchId);
}

/**
 * Start een vergelijking op de achtergrond en geeft meteen het id terug.
 * opts (step):     { mode: 'step', step, input, models, skillContent?, refs?, meetingId?, segmentId?, label?, inputDesc?, concurrency? }
 * opts (pipeline): { mode: 'pipeline', meetingId, models, stopAfter?, blockFrom?, blockTo?, segmentIds?, includeOverig?, chunkWords?, writer?, label?, concurrency? }
 */
export function startBatch(opts) {
  const models = cleanModels(opts.models);
  const concurrency = Math.min(6, Math.max(1, Number(opts.concurrency) || (opts.mode === 'pipeline' ? 2 : 3)));
  if (opts.mode === 'step') return startStepBatch({ ...opts, models, concurrency });
  if (opts.mode === 'pipeline') return startPipelineBatch({ ...opts, models, concurrency });
  throw new Error(`Onbekende modus ${opts.mode}`);
}

function startStepBatch({ step, input, models, skillContent, refs, meetingId, segmentId, label, inputDesc, concurrency, goldId, judge, judgeModel }) {
  if (!TEST_STEPS.includes(step)) throw new Error(`Onbekende stap ${step}`);
  const prep = prepareTest({ step, input, skillContent, refs, meetingId: meetingId ? Number(meetingId) : null, segmentId: segmentId ? Number(segmentId) : null });
  const desc = inputDesc || `${prep.inputBlocks.length ? `${prep.inputBlocks.length} blokken` : `${prep.user.length} tekens`}${prep.draft ? ', conceptskill' : ''}`;
  const batchId = db.prepare(`INSERT INTO model_batches (mode, step, meeting_id, label, input_desc, models, options) VALUES ('step', ?, ?, ?, ?, ?, ?)`)
    .run(step, prep.meetingId, label || null, desc, JSON.stringify(models), JSON.stringify({ concurrency, skill: prep.skill.naam, skill_version: prep.skill.version, draft: prep.draft, segmentId: segmentId || null, goldId: goldId ?? 'standaard', judge: !!judge, judgeModel: judgeModel || null }))
    .lastInsertRowid;
  // Alle rijen meteen aanmaken: de overzichtstabel toont zo ook wat nog in de wachtrij staat.
  const rows = models.map((model) => ({ model, testId: insertTestRow(prep, model, { label: label || `vergelijking #${batchId}`, batchId }) }));
  const ctrl = new AbortController();
  active.set(batchId, ctrl);
  log({ level: 'info', step, message: `modelvergelijking #${batchId} gestart: ${STEPS[step].skill} met ${models.length} modellen`, data: { modellen: models, invoer: desc } });
  (async () => {
    try {
      await pool(rows, concurrency, ({ model, testId }) => runTestModel(prep, model, { testId, signal: ctrl.signal, goldId, judge, judgeModel }), ctrl.signal);
    } finally {
      // Niet gestarte of afgebroken rijen afsluiten
      db.prepare("UPDATE test_runs SET error = 'Gestopt door gebruiker' WHERE batch_id = ? AND output IS NULL AND error IS NULL").run(batchId);
      finish(batchId, ctrl.signal);
    }
  })();
  return batchId;
}

function startPipelineBatch({ meetingId, models, stopAfter, blockFrom, blockTo, segmentIds, includeOverig, chunkWords, writer, label, concurrency }) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!m) throw new Error('Vergadering niet gevonden');
  if (m.prep_status === 'bezig') throw new Error('De voorbereiding van deze vergadering loopt nog.');
  const after = STOP_STEPS.includes(stopAfter) ? stopAfter : 'writer';
  const options = {
    stopAfter: after,
    blockFrom: Number(blockFrom) || undefined,
    blockTo: Number(blockTo) || undefined,
    chunkWords: Number(chunkWords) || undefined,
    writer: writer !== false,
    includeOverig: !!includeOverig,
  };
  let desc = m.input_name || `vergadering #${m.id}`;
  const hasPoints = db.prepare('SELECT COUNT(*) n FROM meeting_points WHERE meeting_id = ?').get(m.id).n > 0;
  if (m.prep_status === 'klaar' && hasPoints) {
    if (Array.isArray(segmentIds) && segmentIds.length) options.segmentIds = segmentIds.map(Number);
    else {
      const selected = new Set(db.prepare('SELECT id FROM meeting_points WHERE meeting_id = ? AND selected = 1').all(m.id).map((p) => p.id));
      options.segmentIds = listSegments(m.id)
        .filter((s) => (s.point_ids.length ? s.point_ids.some((id) => selected.has(id)) : options.includeOverig))
        .map((s) => s.id);
      if (!options.segmentIds.length) throw new Error('Geen enkel geselecteerd agendapunt werd in de transcriptie teruggevonden.');
    }
    desc += `, ${options.segmentIds.length} agendastuk(ken)`;
  }
  if (options.blockFrom || options.blockTo) desc += `, blokken ${options.blockFrom || 1}–${options.blockTo || 'einde'}`;
  if (after !== 'writer') desc += `, stopt na ${after}`;

  const batchId = db.prepare(`INSERT INTO model_batches (mode, step, meeting_id, label, input_desc, models, options) VALUES ('pipeline', ?, ?, ?, ?, ?, ?)`)
    .run(after, m.id, label || null, desc, JSON.stringify(models), JSON.stringify({ ...options, concurrency })).lastInsertRowid;
  // Eén run per model, met datzelfde model voor elke LLM-stap
  const runIds = models.map((model) => {
    const perStep = { intake: model, normalizer: model, cleaner: model, resolver: model, writer: model };
    return db.prepare('INSERT INTO runs (meeting_id, label, options, batch_id) VALUES (?, ?, ?, ?)')
      .run(m.id, `${label || `Vergelijking #${batchId}`}: ${model}`, JSON.stringify({ ...options, models: perStep }), batchId).lastInsertRowid;
  });
  const ctrl = new AbortController();
  active.set(batchId, ctrl);
  (async () => {
    try {
      await pool(runIds, concurrency, (runId) => runPipeline(runId), ctrl.signal);
    } finally {
      db.prepare("UPDATE runs SET status = 'gestopt', error = 'Vergelijking gestopt voor deze run begon' WHERE batch_id = ? AND status = 'wachtrij'").run(batchId);
      finish(batchId, ctrl.signal);
    }
  })();
  return batchId;
}

export function stopBatch(id) {
  id = Number(id);
  const ctrl = active.get(id);
  if (ctrl) ctrl.abort();
  const b = db.prepare('SELECT * FROM model_batches WHERE id = ?').get(id);
  if (b?.mode === 'pipeline') for (const r of db.prepare('SELECT id FROM runs WHERE batch_id = ?').all(id)) if (isActive(r.id)) stopRun(r.id);
  return !!ctrl;
}

/** Na een herstart van de server: lopende vergelijkingen afsluiten. */
export function markBatchesInterrupted() {
  db.prepare("UPDATE test_runs SET error = 'Onderbroken (server herstart)' WHERE batch_id IS NOT NULL AND output IS NULL AND error IS NULL").run();
  db.prepare("UPDATE runs SET status = 'fout', error = 'Onderbroken (server herstart) voor de run begon' WHERE batch_id IS NOT NULL AND status = 'wachtrij'").run();
  db.prepare("UPDATE model_batches SET status = 'onderbroken', finished_at = datetime('now') WHERE status = 'bezig'").run();
}

const secondsBetween = (a, b) => (a && b ? Math.max(0, (Date.parse(`${b.replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`))) : null);

/** Resultaat per model (één rij per test_run of run). */
export function batchRows(b) {
  if (b.mode === 'step') {
    const requested = json(b.models, []) || [];
    return db.prepare('SELECT id, model, tokens_in, tokens_out, cost, ms, ms_net, http_retries, error, output IS NOT NULL AS done, analysis, created_at, quality, quality_auto, quality_gold, quality_judge, judge_cost FROM test_runs WHERE batch_id = ? ORDER BY id').all(b.id)
      .map((t, i) => {
        const a = json(t.analysis, {}) || {};
        // Rijen zijn in de volgorde van de gekozen modellen aangemaakt; OpenRouter kan een andere naam teruggeven
        const model = requested[i] || t.model;
        const stats = a.analysis?.stats || {};
        const status = t.done ? 'klaar' : t.error ? (/gestopt/i.test(t.error) ? 'gestopt' : 'fout') : (isBatchActive(b.id) ? 'bezig' : 'fout');
        return {
          kind: 'test', id: t.id, model, routed: t.model && t.model !== model ? t.model : null, status, error: t.error,
          tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost: t.cost, ms: t.ms, ms_net: t.ms_net ?? t.ms,
          retries: t.http_retries || 0,
          validation: a.validation ? (a.validation.ok ? (a.validation.warnings?.length ? 'waarschuwing' : 'ok') : 'afgekeurd') : null,
          validation_detail: a.validation?.error || (a.validation?.warnings || []).join('; ') || null,
          finish_reason: a.finishReason || null,
          stats, // gewijzigd, gelijk, samengevoegd, ontbreekt, vervangingen, zekerheid, punten …
          json_error: a.analysis?.error || null,
          quality: t.quality, quality_auto: t.quality_auto, quality_gold: t.quality_gold, quality_judge: t.quality_judge, judge_cost: t.judge_cost,
        };
      });
  }
  return db.prepare(`SELECT r.id, r.label, r.status, r.progress, r.error, r.cost, r.tokens_in, r.tokens_out, r.warnings, r.options, r.started_at, r.finished_at,
      (SELECT SUM(ms) FROM run_steps s WHERE s.run_id = r.id) AS ms,
      (SELECT SUM(COALESCE(ms_net, ms)) FROM run_steps s WHERE s.run_id = r.id) AS ms_net,
      (SELECT SUM(COALESCE(attempts, 1) - 1 + COALESCE(http_retries, 0)) FROM run_steps s WHERE s.run_id = r.id) AS retries,
      (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.id) AS calls,
      (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.id AND s.status = 'fallback') AS fallbacks,
      (SELECT COUNT(*) FROM run_blocks x WHERE x.run_id = r.id AND x.merged_into IS NULL) AS blocks
    FROM runs r WHERE r.batch_id = ? ORDER BY r.id`).all(b.id).map((r) => {
    const o = json(r.options, {}) || {};
    // Tokens/kost live uit run_steps (runs.cost wordt pas aan het einde bijgewerkt)
    const t = db.prepare('SELECT SUM(cost) c, SUM(tokens_in) i, SUM(tokens_out) o FROM run_steps WHERE run_id = ?').get(r.id);
    return {
      kind: 'run', id: r.id, model: o.models?.normalizer || '', status: isActive(r.id) ? 'bezig' : r.status, progress: r.progress, error: r.error,
      tokens_in: t.i || 0, tokens_out: t.o || 0, cost: t.c || 0, ms: r.ms, ms_net: r.ms_net, retries: r.retries || 0,
      wall_ms: secondsBetween(r.started_at, r.finished_at),
      calls: r.calls, fallbacks: r.fallbacks, warnings: (json(r.warnings, []) || []).length, blocks: r.blocks,
    };
  });
}

export function listBatches() {
  return db.prepare(`SELECT b.*, m.titel, m.input_name FROM model_batches b LEFT JOIN meetings m ON m.id = b.meeting_id ORDER BY b.id DESC`).all().map((b) => {
    const rows = batchRows(b);
    return {
      ...b, models: json(b.models, []), options: json(b.options, {}), status: isBatchActive(b.id) ? 'bezig' : b.status,
      n: rows.length, done: rows.filter((r) => r.status === 'klaar').length,
      cost: rows.reduce((n, r) => n + (r.cost || 0), 0),
    };
  });
}

export function getBatch(id) {
  const b = db.prepare('SELECT b.*, m.titel, m.input_name FROM model_batches b LEFT JOIN meetings m ON m.id = b.meeting_id WHERE b.id = ?').get(id);
  if (!b) return null;
  return { ...b, models: json(b.models, []), options: json(b.options, {}), status: isBatchActive(b.id) ? 'bezig' : b.status, active: isBatchActive(b.id), rows: batchRows(b) };
}

export function deleteBatch(id) {
  if (isBatchActive(id)) throw new Error('Deze vergelijking loopt nog. Stop ze eerst.');
  const runs = db.prepare('SELECT id FROM runs WHERE batch_id = ?').all(id);
  if (runs.some((r) => isActive(r.id))) throw new Error('Er loopt nog een run van deze vergelijking.');
  const tests = db.prepare('SELECT id FROM test_runs WHERE batch_id = ?').all(id);
  db.transaction(() => {
    for (const t of tests) db.prepare('DELETE FROM run_log WHERE test_id = ?').run(t.id);
    db.prepare('DELETE FROM test_runs WHERE batch_id = ?').run(id);
    db.prepare('DELETE FROM runs WHERE batch_id = ?').run(id);
    db.prepare('DELETE FROM model_batches WHERE id = ?').run(id);
  })();
}

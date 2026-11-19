// Modelvergelijking met de mock-LLM: stap (test_runs) en pipeline (runs), netto duur en overzicht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-batch-'));
process.env.MOCK_LLM = '1';

const { db } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { startBatch, getBatch, listBatches, deleteBatch, isBatchActive } = await import('../server/services/batch.js');
seedIfEmpty();

const waitFor = async (id) => {
  for (let i = 0; i < 400 && isBatchActive(id); i++) await new Promise((r) => setTimeout(r, 25));
  return getBatch(id);
};

function makeVtt(n) {
  let s = 'WEBVTT\n\n';
  for (let i = 0; i < n; i++) {
    const t = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}.000`;
    s += `${t(i * 5)} --> ${t(i * 5 + 4)}\n<v Spreker ${(i % 2) + 1}>Zin ${i}, uhm, over nieuw gent en de begroting.\n\n`;
  }
  return s;
}

test('stapvergelijking: één test_run per model, met netto duur en analyse', async () => {
  const input = '## B001 | spreker: Spreker 1\nDit gaat over nieuw gent, uhm, en de begroting.\n\n## B002 | spreker: Spreker 2\nDank u, uhm, voorzitter.';
  const id = startBatch({ mode: 'step', step: 'normalizer', input, models: ['model/a', 'model/b', 'model/c'], label: 'test' });
  const b = await waitFor(id);
  assert.equal(b.status, 'klaar');
  assert.equal(b.rows.length, 3);
  for (const r of b.rows) {
    assert.equal(r.status, 'klaar', r.error);
    assert.ok(r.tokens_in > 0 && r.tokens_out > 0);
    assert.ok(r.ms_net != null && r.ms_net <= r.ms);
    assert.equal(r.retries, 0);
    assert.equal(r.validation, 'ok');
    assert.ok(r.stats.gewijzigd >= 1, 'normalizer wijzigde iets');
  }
  const tests = db.prepare('SELECT * FROM test_runs WHERE batch_id = ?').all(id);
  assert.equal(tests.length, 3);
  assert.ok(listBatches().some((x) => x.id === id && x.done === 3));
});

test('stapvergelijking vraagt minstens twee modellen', () => {
  assert.throws(() => startBatch({ mode: 'step', step: 'normalizer', input: '## B001 | spreker: ?\nx', models: ['een/model'] }), /minstens twee/);
});

test('pipelinevergelijking: één run per model, zelfde model voor elke stap', async () => {
  const file = path.join(process.env.DATA_DIR, 'v.vtt');
  fs.writeFileSync(file, makeVtt(20));
  const m = db.prepare("INSERT INTO meetings (orgaan, input_file, input_name, input_type, has_timecodes) VALUES ('gemeenteraad', ?, 'v.vtt', 'vtt', 1)").run(file);
  const id = startBatch({ mode: 'pipeline', meetingId: m.lastInsertRowid, models: ['model/x', 'model/y'], stopAfter: 'resolver', blockFrom: 1, blockTo: 10 });
  const b = await waitFor(id);
  assert.equal(b.status, 'klaar');
  assert.equal(b.rows.length, 2);
  for (const r of b.rows) {
    assert.equal(r.status, 'klaar', r.error);
    assert.ok(r.calls >= 3, 'normalizer, cleaner, resolver');
    assert.equal(r.blocks > 0, true);
    assert.ok(r.ms_net != null);
    const run = db.prepare('SELECT options FROM runs WHERE id = ?').get(r.id);
    const o = JSON.parse(run.options);
    assert.equal(o.models.normalizer, r.model);
    assert.equal(o.models.resolver, r.model);
    assert.equal(o.stopAfter, 'resolver');
    const steps = db.prepare('SELECT ms_net, http_retries FROM run_steps WHERE run_id = ?').all(r.id);
    assert.ok(steps.every((s) => s.ms_net != null && s.http_retries === 0));
  }
  deleteBatch(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runs WHERE batch_id = ?').get(id).n, 0);
  assert.equal(getBatch(id), null);
});

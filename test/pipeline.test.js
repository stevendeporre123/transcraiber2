// End-to-end met de mock-LLM: meerdere delen, hervatten, export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-e2e-'));
process.env.MOCK_LLM = '1';

const { db, json } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { runPipeline } = await import('../server/services/pipeline.js');
const { buildReport, toVtt, toDocx, toPdf } = await import('../server/services/export.js');
seedIfEmpty();

function makeVtt(n) {
  let s = 'WEBVTT\n\n';
  for (let i = 0; i < n; i++) {
    const t = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}.000`;
    s += `${t(i * 5)} --> ${t(i * 5 + 4)}\n<v Spreker ${(i % 3) + 1}>Dit is zin nummer ${i}, uhm, over nieuw gent en de begroting van de stad die we we bespreken.\n\n`;
  }
  return s;
}

test('volledige run in meerdere delen + exports', async () => {
  const file = path.join(process.env.DATA_DIR, 'groot.vtt');
  fs.writeFileSync(file, makeVtt(120));
  const m = db.prepare("INSERT INTO meetings (orgaan, input_file, input_name, input_type, has_timecodes) VALUES ('gemeenteraad', ?, 'groot.vtt', 'vtt', 1)").run(file);
  const r = db.prepare('INSERT INTO runs (meeting_id, options) VALUES (?, ?)').run(m.lastInsertRowid, JSON.stringify({ chunkWords: 300 }));
  await runPipeline(r.lastInsertRowid);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(r.lastInsertRowid);
  assert.equal(run.status, 'klaar', run.error);
  const steps = db.prepare('SELECT step, COUNT(*) n FROM run_steps WHERE run_id = ? GROUP BY step').all(run.id);
  assert.ok(steps.find((s) => s.step === 'normalizer').n > 1, 'meerdere delen');

  const blocks = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND merged_into IS NULL ORDER BY ord').all(run.id);
  assert.equal(blocks.length, 120);
  assert.ok(blocks.every((b) => b.text_final.includes('Nieuw-Gent')), 'normalizer toegepast');
  assert.ok(blocks.every((b) => !/\buhm\b/.test(b.text_final)), 'cleaner toegepast');
  assert.ok(blocks.every((b) => b.speaker_name), 'resolver toegepast');

  const report = json(run.report);
  assert.ok(report.punten.length >= 2);
  assert.ok(report.samenvatting);

  const rep = buildReport(run.id);
  const vtt = toVtt(rep);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:04\.000\n<v Spreker 1>/);
  assert.ok((await toDocx(rep)).length > 5000);
  assert.ok((await toPdf(rep)).subarray(0, 4).toString() === '%PDF');

  // Termvoorstel uit de normalizer-notities
  assert.ok(db.prepare("SELECT 1 FROM terms WHERE correct = 'Mockterm' AND status = 'voorstel'").get());
});

test('hervatten: manuele aanpassing blijft behouden bij opnieuw vanaf writer', async () => {
  const run = db.prepare('SELECT * FROM runs ORDER BY id DESC').get();
  db.prepare("UPDATE run_blocks SET text_final = 'MANUEEL', speaker_name = 'Tom De Meester', edited = 1 WHERE run_id = ? AND block_id = 'B001'").run(run.id);
  db.prepare("DELETE FROM run_steps WHERE run_id = ? AND step = 'writer'").run(run.id);
  await runPipeline(run.id);
  const b = db.prepare("SELECT * FROM run_blocks WHERE run_id = ? AND block_id = 'B001'").get(run.id);
  assert.equal(b.text_final, 'MANUEEL');
  assert.equal(b.speaker_name, 'Tom De Meester');
});

test('geen VTT zonder tijdcodes', () => {
  assert.throws(() => toVtt({ hasTimecodes: false, blocks: [] }), /tijdcodes/);
});

test('debug-log: elke fase en modelaanroep wordt gelogd, met systeemprompt bewaard', () => {
  const run = db.prepare('SELECT * FROM runs ORDER BY id').get();
  const rows = db.prepare('SELECT level, step, message, data FROM run_log WHERE run_id = ?').all(run.id);
  const msgs = rows.map((r) => r.message).join('\n');
  assert.match(msgs, /start run/);
  assert.match(msgs, /blokken, \d+ woorden/);
  assert.match(msgs, /aanroep mock|aanroep .* \(skill gentse-normalizer/);
  assert.match(msgs, /analyse uitvoer/);
  assert.match(msgs, /run klaar/);
  const call = rows.find((r) => r.step === 'normalizer' && /aanroep/.test(r.message));
  assert.ok(JSON.parse(call.data).referenties.some((x) => /^leden: \d+ tekens/.test(x)), 'referentiegrootte gelogd');
  const analyse = rows.find((r) => r.step === 'normalizer' && r.message === 'analyse uitvoer');
  assert.ok(JSON.parse(analyse.data).vervangingen.some((v) => /nieuw gent → Nieuw-Gent|gent → Nieuw-Gent/i.test(v)), 'vervangingen gelogd');
  const step = db.prepare("SELECT system FROM run_steps WHERE run_id = ? AND step = 'normalizer'").get(run.id);
  assert.match(step.system, /# REFERENTIE: LEDEN/);
});

test('testrun: enkel blokken 3-5 en stoppen na de normalizer', async () => {
  const m = db.prepare('SELECT * FROM meetings ORDER BY id').get();
  const r = db.prepare('INSERT INTO runs (meeting_id, options) VALUES (?, ?)').run(m.id, JSON.stringify({ blockFrom: 3, blockTo: 5, stopAfter: 'normalizer' }));
  await runPipeline(r.lastInsertRowid);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(r.lastInsertRowid);
  assert.equal(run.status, 'klaar', run.error);
  const blocks = db.prepare('SELECT block_id FROM run_blocks WHERE run_id = ?').all(run.id).map((b) => b.block_id);
  assert.deepEqual(blocks, ['B003', 'B004', 'B005']);
  const steps = db.prepare('SELECT DISTINCT step FROM run_steps WHERE run_id = ?').all(run.id).map((s) => s.step);
  assert.deepEqual(steps, ['normalizer']);
});

test('testbank: skill testen met concepttekst, analyse per blok', async () => {
  const { runTest, meetingBlocks } = await import('../server/services/testbench.js');
  const m = db.prepare('SELECT * FROM meetings ORDER BY id').get();
  const mb = await meetingBlocks(m.id, 300);
  assert.ok(mb.chunks.length > 1);
  const input = mb.blocks.slice(0, 4).map((b) => `## ${b.id} | spreker: ${b.speaker || '?'}\n${b.text}`).join('\n\n');
  const skill = db.prepare("SELECT content FROM skills WHERE naam = 'gentse-normalizer'").get().content;
  const [res] = await runTest({ step: 'normalizer', input, models: ['x/y'], skillContent: skill + '\nExtra regel.', meetingId: m.id });
  assert.equal(res.error, undefined);
  assert.equal(res.analysis.kind, 'blocks');
  assert.equal(res.analysis.stats.in, 4);
  assert.equal(res.analysis.stats.gewijzigd, 4);
  assert.ok(res.validation.ok);
  assert.match(res.system, /Extra regel\./);
  const row = db.prepare('SELECT skill_draft FROM test_runs WHERE id = ?').get(res.id);
  assert.equal(row.skill_draft, 1);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM run_log WHERE test_id = ?').get(res.id).n >= 2);
});

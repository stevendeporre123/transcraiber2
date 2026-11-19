// Nieuwe test: 3 bestanden opladen → vergadering + referentie + runs per model, met score en verbeterde SRT.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-nieuwetest-'));
process.env.MOCK_LLM = '1';

const express = (await import('express')).default;
const { db } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { api } = await import('../server/routes.js');
const { isBatchActive } = await import('../server/services/batch.js');
seedIfEmpty();

const app = express();
app.use(express.json());
app.use('/api', api);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => server.close());

const fx = (name) => new Blob([fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name))]);
function form({ transcript = 'sample.pdf', subtitles = 'sample.srt', gold = 'sample.pdf', models = ['model/a'], soort } = {}) {
  const fd = new FormData();
  if (transcript) fd.set('transcript', fx(transcript), transcript);
  if (subtitles) fd.set('subtitles', fx(subtitles), subtitles);
  if (gold) fd.set('gold', fx(gold), gold);
  fd.set('models', JSON.stringify(models));
  if (soort) fd.set('soort', soort);
  return fd;
}
const post = async (fd) => { const r = await fetch(`${base}/newtests`, { method: 'POST', body: fd }); return { status: r.status, body: await r.json() }; };
const waitFor = async (id) => {
  for (let i = 0; i < 400 && isBatchActive(id); i++) await new Promise((r) => setTimeout(r, 25));
  return (await fetch(`${base}/newtests/${id}`)).json();
};

test('ontbrekende of verkeerde bestanden worden geweigerd zonder iets aan te maken', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM meetings').get().n;
  assert.equal((await post(form({ gold: null }))).status, 400);
  assert.match((await post(form({ transcript: 'sample.srt' }))).body.error, /docx of \.pdf/);
  assert.match((await post(form({ models: [] }))).body.error, /minstens één model/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meetings').get().n, before);
});

test('één model: run tot en met sprekers, score met referentie, SRT te downloaden', async () => {
  const { status, body } = await post(form());
  assert.equal(status, 200, body.error);
  const t = await waitFor(body.id);
  assert.equal(t.status, 'klaar');
  assert.equal(t.step, 'resolver');
  assert.equal(t.rows.length, 1);
  const r = t.rows[0];
  assert.equal(r.status, 'klaar', r.error);
  assert.ok(r.tokens_in > 0 && r.cost >= 0 && r.wall_ms != null);
  assert.ok(r.quality != null, 'score berekend');
  assert.ok(r.quality_gold != null, 'referentiescore berekend');
  assert.equal(r.quality_detail.gold.soort, 'transcript');
  assert.equal(t.gold.soort, 'transcript');
  assert.equal(t.meeting.subtitle_name, 'sample.srt');

  const srt = await fetch(`${base}/meetings/${t.meeting_id}/subtitles/download?runs=${r.id}&format=srt`);
  assert.equal(srt.status, 200);
  assert.match(await srt.text(), /00:00:01,000 --> 00:00:04,000/);

  const list = await (await fetch(`${base}/newtests`)).json();
  assert.ok(list.some((b) => b.id === body.id && b.best === r.quality));

  // Opnieuw scoren geeft hetzelfde
  const again = await (await fetch(`${base}/runs/${r.id}/score`, { method: 'POST' })).json();
  assert.equal(again.quality, r.quality);

  // Verwijderen neemt de vergadering (en referentie) mee
  assert.equal((await fetch(`${base}/newtests/${body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meetings WHERE id = ?').get(t.meeting_id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM gold_refs WHERE meeting_id = ?').get(t.meeting_id).n, 0);
});

test('meerdere modellen en een verslag als referentie: volledige pipeline', async () => {
  const { body } = await post(form({ models: ['model/a', 'model/b'], soort: 'verslag' }));
  const t = await waitFor(body.id);
  assert.equal(t.step, 'writer');
  assert.equal(t.rows.length, 2);
  for (const r of t.rows) {
    assert.equal(r.status, 'klaar', r.error);
    assert.equal(r.quality_detail.gold.soort, 'verslag');
    assert.ok(r.quality != null);
  }
});

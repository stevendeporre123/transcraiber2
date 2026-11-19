// Kwaliteitsscore in de Testbank: automatisch, referentie (gold) en rechtermodel (mock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-quality-'));
process.env.MOCK_LLM = '1';

const { db } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { autoScore, goldScore, combine, judgeFromJson, backfillQuality } = await import('../server/services/quality.js');
const { analyzeOutput } = await import('../server/services/analyze.js');
const { runTest, getTest } = await import('../server/services/testbench.js');
seedIfEmpty();

const blocks = [
  { id: 'B001', speaker: 'Spreker 1', text: 'Ik wil het hebben over nieuw gent en de plannen van schepen Taaldeman voor de wijk.' },
  { id: 'B002', speaker: 'Spreker 2', text: 'Dank u voor de vraag, uhm, we we bekijken dat samen met de buurt.' },
];
const ser = (list) => list.map((b) => `## ${b.id} | spreker: ${b.speaker}\n${b.text}`).join('\n\n');
const inputText = ser(blocks);

function score(step, output, extra = {}) {
  const analysis = analyzeOutput(step, blocks, output);
  return autoScore({ step, inputText, inputBlocks: blocks, output, analysis, validation: { ok: true, warnings: [] }, finishReason: 'stop', ...extra });
}

test('automatisch: normalizer die alle vervormingen verbetert scoort 100 op namen', () => {
  const good = ser(blocks.map((b) => ({ ...b, text: b.text.replace('nieuw gent', 'Nieuw-Gent').replace('Taaldeman', 'Taeldeman') })));
  const s = score('normalizer', good);
  const names = s.parts.find((p) => p.key === 'namen');
  assert.equal(names.score, 100);
  assert.match(names.detail, /2 verbeterd, 0 gemist/);
  assert.equal(s.score, 100);
});

test('automatisch: niets verbeterd → namen 0, ontbrekend blok drukt structuur', () => {
  const s = score('normalizer', ser([blocks[0]]));
  assert.equal(s.parts.find((p) => p.key === 'namen').score, 0);
  assert.equal(s.parts.find((p) => p.key === 'structuur').score, 50);
  assert.ok(s.score < 40);
});

test('automatisch: afgekeurd door de pipeline → structuur 0', () => {
  const s = score('normalizer', ser(blocks), { validation: { ok: false, error: 'slechts 0/2 blokken' } });
  assert.equal(s.parts.find((p) => p.key === 'structuur').score, 0);
});

test('referentie: zoekt het passende stuk in een lange tekst en meet gelijkenis + namen', () => {
  const filler = Array.from({ length: 300 }, (_, i) => `woord${i}`).join(' ');
  const gold = `${filler} Ik wil het hebben over Nieuw-Gent en de plannen van schepen Taeldeman voor de wijk. Dank u voor de vraag, we bekijken dat samen met de buurt. ${filler}`;
  const fixed = ser(blocks.map((b) => ({ ...b, text: b.text.replace('nieuw gent', 'Nieuw-Gent').replace('Taaldeman', 'Taeldeman').replace('uhm, we we', 'we') })));
  const g = goldScore({ step: 'cleaner', inputText, inputBlocks: blocks, output: fixed, goldText: gold });
  assert.equal(g.parts.find((p) => p.key === 'tekst').score, 100);
  assert.equal(g.parts.find((p) => p.key === 'namen').score, 100);
  assert.match(g.method, /woorden \d+–\d+ van/);
  const raw = goldScore({ step: 'cleaner', inputText, inputBlocks: blocks, output: inputText, goldText: gold });
  assert.ok(raw.score < g.score);
});

test('referentie in blokformaat: per blok, ook sprekers voor de resolver', () => {
  const gold = '## B001 | spreker: Sven Taeldeman\nx\n\n## B002 | spreker: Mathias De Clercq\ny';
  const out = '## B001 | spreker: Sven Taeldeman | Groen | schepen | zekerheid: hoog\n## B002 | spreker: Onbekende spreker | - | - | zekerheid: laag';
  const g = goldScore({ step: 'resolver', inputText, inputBlocks: blocks, output: out, goldText: gold });
  assert.equal(g.score, 50);
  assert.match(g.method, /per blok/);
});

test('rechtermodel: scores 1-5 → 0-100, eindscore herverdeelt ontbrekende pijlers', () => {
  assert.equal(judgeFromJson({ scores: { namen: 5, terminologie: 5, trouw: 1, opschoning: 1 } }).score, 50);
  assert.throws(() => judgeFromJson({}));
  assert.equal(combine({ auto: 80 }), 80);
  assert.equal(combine({ auto: 100, gold: 50, judge: 0 }), 50);
});

test('testbank: test wordt gescoord, met referentie van de vergadering en mock-rechter', async () => {
  const m = db.prepare("INSERT INTO meetings (orgaan, input_name) VALUES ('gemeenteraad', 'q.vtt')").run().lastInsertRowid;
  db.prepare("INSERT INTO gold_refs (meeting_id, naam, text) VALUES (?, 'nagekeken', ?)").run(m, 'Ik wil het hebben over Nieuw-Gent en de plannen van schepen Taeldeman voor de wijk. Dank u voor de vraag, we bekijken dat samen met de buurt.');
  const [r] = await runTest({ step: 'normalizer', input: inputText, models: ['mock'], meetingId: m, judge: true });
  assert.ok(r.quality > 0);
  assert.ok(r.quality_auto != null && r.quality_gold != null && r.quality_judge != null);
  const t = getTest(r.id);
  assert.equal(t.quality_detail.judge.scores.namen, 4);
  assert.equal(t.quality_detail.gold.naam, 'nagekeken');
  // achteraf: score wissen en opnieuw laten berekenen bij het opstarten
  db.prepare('UPDATE test_runs SET quality_auto = NULL WHERE id = ?').run(r.id);
  assert.equal(backfillQuality(), 1);
  assert.ok(getTest(r.id).quality_auto != null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-prep-'));
process.env.MOCK_LLM = '1';

const { db } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { parseAgenda } = await import('../server/services/agenda-parse.js');
const { prepareMeeting, listSegments, loadBlocks, findQuote, splitBlock, setSegmentStart, addSegment, deleteSegment } = await import('../server/services/prepare.js');
seedIfEmpty();
const fixture = (f) => path.join(import.meta.dirname, 'fixtures', f);

test('agenda: bundel prerogatieven (vragenuurtje) in code', () => {
  const a = parseAgenda(fs.readFileSync(fixture('agenda-prerogatieven.txt'), 'utf8'));
  assert.equal(a.format, 'prerogatieven');
  assert.equal(a.vergadering.datum, '2026-10-26');
  assert.deepEqual(a.punten.map((p) => p.nummer), ['IR 14', 'IR 15', 'IR 12']);
  const p = a.punten[0];
  assert.equal(p.code, '2026_MV_00762');
  assert.equal(p.type, 'mondelinge_vraag');
  assert.deepEqual(p.indieners, ['Filip Van Laecke']);
  assert.equal(p.bevoegd, 'Joris Vandenbroucke');
  assert.equal(p.titel, 'Problematieken pendelbussen Ter Linden – Zwijnaarde');
  assert.match(p.toelichting, /Kan de schepen dit bekijken/);
  assert.equal(a.punten[2].bevoegd, 'Sofie Bracke');
});

test('agenda: gemeenteraadsagenda in code (types uit de dossiercode, paginavoet weg)', () => {
  const a = parseAgenda(fs.readFileSync(fixture('agenda-gemeenteraad.txt'), 'utf8'));
  assert.equal(a.format, 'gr-agenda');
  assert.equal(a.vergadering.datum, '2026-09-28');
  const byCode = Object.fromEntries(a.punten.map((p) => [p.code, p]));
  assert.equal(a.punten.length, 6);
  assert.equal(byCode['2026_GR_00795'].type, 'besluit');
  assert.equal(byCode['2026_GR_00832'].titel.includes('2 van 15'), false);
  assert.match(byCode['2026_GR_00832'].titel, /betaalterminals en de afhandeling/);
  assert.equal(byCode['2026_MV_00656'].type, 'mondelinge_vraag');
  assert.deepEqual(byCode['2026_MV_00656'].indieners, ['Filip Van Laecke']);
  assert.equal(byCode['2026_MV_00656'].nummer, 'IR 3');
  assert.equal(byCode['2026_MO_00005'].type, 'motie');
  assert.equal(byCode['2026_VVB_00036'].type, 'voorstel');
  assert.match(byCode['2026_VVB_00036'].sectie, /BUREAU/);
});

test('citaat zoeken en blok knippen met de echte cue-tijd', () => {
  const b = { text: 'Dank u wel. Goed, collega Camaer heeft ook een vraag.', t_start: 10, t_end: 20, cues: [[0, 10, 13], [12, 13, 16], [39, 16, 20]] };
  const pos = findQuote(b.text, 'Collega Camaer heeft');
  assert.equal(b.text.slice(pos, pos + 7), 'collega');
  const [l, r] = splitBlock(b, pos);
  assert.equal(l.text, 'Dank u wel. Goed,');
  assert.equal(r.text, 'collega Camaer heeft ook een vraag.');
  assert.equal(r.t_start, 13, 'begint op de cue waarin het citaat valt');
  assert.equal(l.t_end, 13);
  assert.deepEqual(r.cues[0], [0, 13, 16]);
  assert.equal(r.text.slice(r.cues[1][0], r.cues[1][0] + 3), 'ook');
});

function makeVtt(n) {
  let s = 'WEBVTT\n\n';
  const t = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}.000`;
  for (let i = 0; i < n; i++) s += `${t(i * 4)} --> ${t(i * 4 + 4)}\nZin ${i} gaat over de vraag van collega nummer ${i} en het antwoord van de schepen.\n\n`;
  return s;
}

test('voorbereiding: intake, agenda in code, opdelen per punt met behoud van tijdcodes', async () => {
  const file = path.join(process.env.DATA_DIR, 'vragenuurtje.vtt');
  fs.writeFileSync(file, makeVtt(60));
  const agenda = fs.readFileSync(fixture('agenda-prerogatieven.txt'), 'utf8');
  const m = db.prepare("INSERT INTO meetings (orgaan, input_file, input_name, input_type, has_timecodes, agenda_text, agenda_name) VALUES ('gemeenteraad', ?, 'vragenuurtje.vtt', 'vtt', 1, ?, 'bundel.pdf')").run(file, agenda);
  const id = m.lastInsertRowid;
  await prepareMeeting(id, { context: false });
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  assert.equal(meeting.prep_status, 'klaar', meeting.prep_error);
  assert.equal(meeting.agenda_format, 'prerogatieven');

  const points = db.prepare('SELECT * FROM meeting_points WHERE meeting_id = ? ORDER BY ord').all(id);
  assert.equal(points.length, 3);
  assert.equal(points[0].bron, 'code');

  const segs = listSegments(id);
  assert.equal(segs[0].label, 'Opening');
  const withPoint = segs.filter((s) => s.point_ids.length);
  assert.equal(withPoint.length, 3, 'drie agendapunten gevonden');
  // de mock knipt vanaf het derde woord: het segment start dus midden in een oorspronkelijk blok
  const blocks = loadBlocks(id);
  const first = blocks[withPoint[0].first_ord];
  assert.ok(!/^Zin \d+ gaat/.test(first.text), 'blok werd op het citaat geknipt');
  const prev = blocks[withPoint[0].first_ord - 1];
  assert.equal(prev.t_end, first.t_start, 'naadloos: einde vorig deel = begin nieuw deel');
  assert.ok(first.t_start % 4 === 0, 'tijd komt exact van een cue-grens uit de VTT');
  // alle blokken horen bij een segment en tijden lopen op
  assert.ok(blocks.every((b) => b.segment_id));
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].t_start >= blocks[i - 1].t_start);
  const log = db.prepare('SELECT message FROM run_log WHERE meeting_id = ?').all(id).map((r) => r.message).join('\n');
  assert.match(log, /agenda in code ingelezen \(prerogatieven\): 3 punten/);
  assert.match(log, /segmenten, 3 van 3 agendapunten teruggevonden/);
});

test('segmenten manueel aanpassen: begin verleggen met citaat, toevoegen, verwijderen', () => {
  const id = db.prepare('SELECT id FROM meetings ORDER BY id DESC').get().id;
  let segs = listSegments(id);
  const seg = segs.find((s) => s.point_ids.length);
  const before = loadBlocks(id).length;
  const all = loadBlocks(id);
  const ord = all.findIndex((b, i) => i > seg.first_ord && b.text.split(' ').length > 12);
  const target = all[ord];
  const quote = target.text.split(' ').slice(4, 9).join(' ');
  setSegmentStart(seg.id, ord, quote);
  assert.equal(loadBlocks(id).length, before + 1, 'blok geknipt');
  segs = listSegments(id);
  const moved = segs.find((s) => s.id === seg.id);
  assert.ok(loadBlocks(id)[moved.first_ord].text.startsWith(quote));
  const newId = addSegment(id, { ord: moved.first_ord + 1, label: 'Pauze' });
  assert.ok(listSegments(id).some((s) => s.id === newId && s.label === 'Pauze'));
  deleteSegment(newId);
  assert.ok(!listSegments(id).some((s) => s.id === newId));
  assert.ok(loadBlocks(id).every((b) => b.segment_id));
});

test('run per agendapunt: enkel geselecteerde segmenten, fiche als context, tijdcodes behouden', async () => {
  const { runPipeline } = await import('../server/services/pipeline.js');
  const { buildReport, toVtt } = await import('../server/services/export.js');
  const id = db.prepare('SELECT id FROM meetings ORDER BY id DESC').get().id;
  const segs = listSegments(id);
  const chosen = segs.filter((s) => s.point_ids.length).slice(0, 2);
  const r = db.prepare('INSERT INTO runs (meeting_id, options) VALUES (?, ?)').run(id, JSON.stringify({ segmentIds: chosen.map((s) => s.id), chunkWords: 200 }));
  await runPipeline(r.lastInsertRowid);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(r.lastInsertRowid);
  assert.equal(run.status, 'klaar', run.error);

  const blocks = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? AND merged_into IS NULL ORDER BY ord').all(run.id);
  assert.deepEqual([...new Set(blocks.map((b) => b.segment_id))], chosen.map((s) => s.id));
  const src = new Map(loadBlocks(id).map((b) => [b.block_id, b]));
  assert.ok(blocks.every((b) => b.t_start === src.get(b.block_id).t_start), 'tijdcodes uit de voorbereiding');

  // elk normalizer-deel bevat blokken van één segment en krijgt de fiche van dat punt
  const steps = db.prepare("SELECT input, system FROM run_steps WHERE run_id = ? AND step = 'normalizer'").all(run.id);
  assert.ok(steps.length >= 2);
  const segOf = new Map(blocks.map((b) => [b.block_id, b.segment_id]));
  for (const s of steps) {
    const ids = [...s.input.matchAll(/^## (B\d+)/gm)].map((m) => m[1]);
    assert.equal(new Set(ids.map((x) => segOf.get(x) ?? db.prepare('SELECT segment_id FROM run_blocks WHERE run_id = ? AND block_id = ?').get(run.id, x).segment_id)).size, 1);
    assert.match(s.system, /# REFERENTIE: AGENDAPUNT[\s\S]*Indiener\(s\): Filip Van Laecke|# REFERENTIE: AGENDAPUNT[\s\S]*Indiener\(s\): Safoura Zombra/);
  }

  // verslag: punten = agendapunten, met samenvatting per punt (MODUS: PUNT)
  const rep = buildReport(run.id);
  assert.equal(rep.punten.length, 2);
  assert.ok(rep.punten.every((p) => /mock/.test(p.samenvatting)), 'samenvatting per punt (MODUS: PUNT)');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_log WHERE run_id = ? AND level = 'error'").get(run.id).n, 0, 'geen fouten in het log');
  const points = db.prepare('SELECT * FROM meeting_points WHERE meeting_id = ?').all(id);
  assert.ok(points.some((p) => rep.punten[0].titel.includes(p.titel)));
  const vtt = toVtt(rep);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, new RegExp(`^${blocks[0].t_start === 0 ? '00:00:00' : ''}`, 'm'));
});

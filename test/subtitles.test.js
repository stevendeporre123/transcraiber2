// Verbeterde ondertitels: volledig bestand, originele tijdcodes, tekst van alle runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-subs-'));
process.env.MOCK_LLM = '1';

const { db } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { runPipeline } = await import('../server/services/pipeline.js');
const { buildSubtitles, parseSubtitleFile, alignWords, wrapLines } = await import('../server/services/subtitles.js');
seedIfEmpty();

const t = (x, sep = '.') => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}${sep}000`;
function makeVtt(n) {
  let s = 'WEBVTT\n\nNOTE gemaakt door test\n\n';
  for (let i = 0; i < n; i++) s += `c${i}\n${t(i * 5)} --> ${t(i * 5 + 4)} align:start\n<v Spreker ${(i % 3) + 1}>Dit is zin nummer ${i}, uhm, over nieuw gent\nen de begroting van de stad die we we bespreken.\n\n`;
  return s;
}
const cueBlocks = (s) => s.trim().split(/\n\n/);

test('uitlijnen: ankers + exacte uitlijning tussen de ankers', () => {
  const a = 'de raad keurt het punt goed met twintig stemmen voor'.split(' ');
  const b = 'uhm de raad keurt uh het punt goed met 20 stemmen voor en dan'.split(' ');
  const m = alignWords(a, b);
  assert.equal(m[0], 1);
  assert.equal(m[a.indexOf('punt')], b.indexOf('punt'));
  assert.equal(m[a.indexOf('twintig')], -1);
  assert.equal(m[a.indexOf('voor')], b.indexOf('voor'));
});

test('regels afbreken op max 42 tekens', () => {
  const lines = wrapLines('Dit is een vrij lange ondertitel die over twee regels verdeeld moet worden.');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length <= 42));
});

test('VTT: deelrun → volledig bestand, onverwerkte cues ongewijzigd, tijdcodes behouden', async () => {
  const file = path.join(process.env.DATA_DIR, 'zitting.vtt');
  const src = makeVtt(40);
  fs.writeFileSync(file, src);
  const m = db.prepare("INSERT INTO meetings (orgaan, input_file, input_name, input_type, has_timecodes) VALUES ('gemeenteraad', ?, 'zitting.vtt', 'vtt', 1)").run(file).lastInsertRowid;
  const r = db.prepare('INSERT INTO runs (meeting_id, options) VALUES (?, ?)').run(m, JSON.stringify({ blockFrom: 5, blockTo: 14 })).lastInsertRowid;
  await runPipeline(r);
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(r).status, 'klaar');

  const out = buildSubtitles(m);
  assert.equal(out.format, 'vtt');
  const orig = cueBlocks(src);
  const got = cueBlocks(out.content);
  assert.equal(got.length, orig.length, 'zelfde aantal cues + kop');
  assert.equal(got[0], 'WEBVTT');
  assert.equal(got[1], 'NOTE gemaakt door test');
  // cue i staat op got[i + 2]
  for (let i = 0; i < 40; i++) {
    const [id, timing] = got[i + 2].split('\n');
    assert.equal(id, `c${i}`);
    assert.equal(timing, `${t(i * 5)} --> ${t(i * 5 + 4)} align:start`);
  }
  // blokken 5..14 (cues 4..13) verbeterd, de rest letterlijk het origineel
  for (let i = 0; i < 40; i++) {
    const g = got[i + 2];
    if (i >= 4 && i <= 13) {
      assert.match(g, /Nieuw-Gent/, `cue ${i} verbeterd`);
      assert.doesNotMatch(g, /uhm|we we/);
      assert.match(g, /^<v Spreker \d>/m);
    } else assert.equal(g, orig[i + 2], `cue ${i} ongewijzigd`);
  }
  assert.equal(out.stats.improved, 10);
  assert.equal(out.stats.unchanged, 30);

  // SRT-uitvoer: genummerd, komma in de tijd, sprekernaam enkel bij wissel
  const srt = buildSubtitles(m, { format: 'srt' }).content;
  const s = cueBlocks(srt);
  assert.equal(s.length, 40);
  assert.equal(s[0].split('\n')[0], '1');
  assert.equal(s[0].split('\n')[1], `${t(0, ',')} --> ${t(4, ',')}`);
  assert.doesNotMatch(srt, /<v /);

  // manuele aanpassing in een oudere run wint van een nieuwere run over dezelfde cues
  const r2 = db.prepare('INSERT INTO runs (meeting_id, options) VALUES (?, ?)').run(m, JSON.stringify({ blockFrom: 10, blockTo: 20 })).lastInsertRowid;
  await runPipeline(r2);
  db.prepare("UPDATE run_blocks SET text_final = 'Dit is zin nummer 12, manueel verbeterd over Nieuw-Gent en de begroting van de stad die we bespreken.', edited = 1 WHERE run_id = ? AND block_id = 'B013'").run(r);
  const both = cueBlocks(buildSubtitles(m).content);
  assert.match(both[12 + 2], /manueel verbeterd/);
  assert.match(both[18 + 2], /Nieuw-Gent/, 'tweede run telt mee');
  assert.equal(both[25 + 2], orig[25 + 2]);
  // enkel de eerste run
  const only = cueBlocks(buildSubtitles(m, { runIds: [r] }).content);
  assert.equal(only[18 + 2], orig[18 + 2]);
});

test('transcriptie zonder tijdcodes + apart opgeladen SRT: koppeling op tekst, samengevoegde blokken', () => {
  const srt = [
    `1\n${t(1, ',')} --> ${t(3, ',')}\nSpreker 1: Goedenavond collega's, uhm, ik open`,
    `2\n${t(3, ',')} --> ${t(5, ',')}\nde zitting van de gemeenteraad.`,
    `3\n${t(6, ',')} --> ${t(8, ',')}\nHet eerste punt gaat over de over de`,
    `4\n${t(8, ',')} --> ${t(9, ',')}\nbegroting.`,
    `5\n${t(10, ',')} --> ${t(12, ',')}\nEuh.`,
    `6\n${t(12, ',')} --> ${t(15, ',')}\nSpreker 2: Dank u voorzitter, ik heb een vraag.`,
  ].join('\n\n') + '\n';
  const file = path.join(process.env.DATA_DIR, 'apart.srt');
  fs.writeFileSync(file, srt);
  const m = db.prepare("INSERT INTO meetings (orgaan, input_file, input_name, input_type, has_timecodes, subtitle_file, subtitle_name, subtitle_type) VALUES ('gemeenteraad', 'x.pdf', 'x.pdf', 'pdf', 0, ?, 'apart.srt', 'srt')").run(file).lastInsertRowid;
  const r = db.prepare("INSERT INTO runs (meeting_id, status) VALUES (?, 'klaar')").run(m).lastInsertRowid;
  const ins = db.prepare('INSERT INTO run_blocks (run_id, block_id, ord, speaker_raw, text_raw, text_final, speaker_name, merged_into) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // PDF-tekst wijkt licht af van de SRT (andere opvullers); B002 is door de cleaner in B001 samengevoegd
  ins.run(r, 'B001', 0, 'Spreker 1', "Goedenavond collega's, ik open de zitting van de gemeenteraad.", "Goedenavond collega's, ik open de zitting van de gemeenteraad. Het eerste punt gaat over de begroting.", 'Sofie Heyse', null);
  ins.run(r, 'B002', 1, 'Spreker 1', 'Het eerste punt gaat over de over de begroting. Euh.', 'Het eerste punt gaat over de over de begroting. Euh.', null, 'B001');
  ins.run(r, 'B003', 2, 'Spreker 2', 'Dank u voorzitter, ik heb een vraag.', 'Dank u, voorzitter. Ik heb een vraag.', 'Tom De Meester', null);

  const out = buildSubtitles(m);
  assert.equal(out.format, 'srt');
  const c = cueBlocks(out.content).map((x) => x.split('\n'));
  assert.equal(c.length, 5, 'cue met enkel "Euh." valt weg');
  assert.deepEqual(c.map((x) => x[0]), ['1', '2', '3', '4', '5']);
  assert.equal(c[0][1], `${t(1, ',')} --> ${t(3, ',')}`);
  assert.equal(c[0].slice(2).join(' '), "Sofie Heyse: Goedenavond collega's, ik open");
  assert.equal(c[1].slice(2).join(' '), 'de zitting van de gemeenteraad.');
  assert.equal(c[2].slice(2).join(' '), 'Het eerste punt gaat over de');
  assert.equal(c[3].slice(2).join(' '), 'begroting.');
  assert.equal(c[4][1], `${t(12, ',')} --> ${t(15, ',')}`);
  assert.equal(c[4].slice(2).join(' '), 'Tom De Meester: Dank u, voorzitter. Ik heb een vraag.');
  assert.equal(out.stats.dropped, 1);

  // zonder sprekers
  const plain = cueBlocks(buildSubtitles(m, { speakers: false }).content);
  assert.doesNotMatch(plain.join('\n'), /Sofie|Spreker/);
  assert.equal(parseSubtitleFile(out.content).cues.length, 5);
});

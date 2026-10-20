import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Aparte databank per testrun
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcraiber-test-'));
process.env.MOCK_LLM = '1';

const { parseCues, splitSpeaker, readInput, parseTime, formatTime } = await import('../server/services/extract.js');
const { blocksFromCues, blocksFromText, chunkBlocks } = await import('../server/services/intake.js');
const { parseBlocks, parseSpeakerHeader } = await import('../server/services/blockfmt.js');
const { validateCleaner, validateNormalizer } = await import('../server/services/pipeline.js');
const { replacementsFromEdit } = await import('../server/services/learn.js');
const { candidateStreets } = await import('../server/services/context.js');
const { seedIfEmpty } = await import('../server/seed.js');

const fixture = (f) => path.join(import.meta.dirname, 'fixtures', f);
seedIfEmpty();

test('tijden parsen en formatteren', () => {
  assert.equal(parseTime('01:02:03.450'), 3723.45);
  assert.equal(parseTime('02:03,5'), 123.5);
  assert.equal(formatTime(3723.45), '01:02:03.450');
});

test('VTT: sprekers uit voice-tags en blokken per spreker', () => {
  const cues = parseCues(fs.readFileSync(fixture('sample.vtt'), 'utf8'));
  assert.equal(cues.length, 5);
  const blocks = blocksFromCues(cues);
  assert.equal(blocks.length, 4);
  assert.deepEqual([blocks[0].speaker_raw, blocks[0].t_start, blocks[0].t_end], ['Spreker 1', 1, 8]);
});

test('SRT: sprekerlabel vooraan wordt overgeërfd door volgende cue', () => {
  const blocks = blocksFromCues(parseCues(fs.readFileSync(fixture('sample.srt'), 'utf8')));
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text_raw, /begroting/);
  assert.equal(blocks[1].speaker_raw, 'Spreker 2');
});

test('sprekerlabels: namen wel, gewone woorden niet', () => {
  assert.equal(splitSpeaker('Mathias De Clercq: Goedemiddag.')[0], 'Mathias De Clercq');
  assert.equal(splitSpeaker('Spreker 3: ja')[0], 'Spreker 3');
  assert.equal(splitSpeaker('Het volgende: we stemmen.')[0], null);
  assert.equal(splitSpeaker('Dus: akkoord.')[0], null);
});

test('PDF: kop/voet en paginanummers weg, afbreekstreepjes hersteld', async () => {
  const { pages } = await readInput(fixture('sample.pdf'), 'pdf');
  const { blocks, notes } = blocksFromText(pages);
  const all = blocks.map((b) => b.text_raw).join(' ');
  assert.ok(!all.includes('Stad Gent - Gemeenteraad'), 'voettekst verwijderd');
  assert.match(all, /gemeenteraad van maand 1/, 'gemeente- + raad samengevoegd');
  assert.match(all, /Sint-Amandsberg/, 'koppelteken in eigennaam behouden');
  assert.ok(notes.labels > 0);
  assert.equal(blocks[0].speaker_raw, 'Spreker 1');
});

test('blokformaat en sprekerkop', () => {
  const { blocks, sections } = parseBlocks('## B001 | spreker: Tom De Meester | PVDA | raadslid | zekerheid: hoog\nTekst\n\n## B2 | spreker: ?\nMeer\ntekst\n\n## NOTITIES\nnotitie');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].id, 'B002');
  assert.equal(blocks[1].text, 'Meer tekst');
  assert.equal(sections.NOTITIES, 'notitie');
  assert.deepEqual(parseSpeakerHeader(blocks[0].speaker), { speaker_name: 'Tom De Meester', fractie: 'PVDA', functie: 'raadslid', zekerheid: 'hoog' });
  assert.equal(parseSpeakerHeader('Onbekende spreker | - | -').zekerheid, 'laag');
});

const mk = (id, speaker, text) => ({ block_id: id, speaker_raw: speaker, text_raw: text, text_norm: text });

test('cleaner: ontbrekende blokken = samengevoegd met vorig blok', () => {
  const input = [mk('B001', 'S1', 'het budget voor dit'), mk('B002', 'S1', 'project is groot'), mk('B003', 'S2', 'Ja.')];
  const out = '## B001 | spreker: S1\nHet budget voor dit project is groot.\n\n## B003 | spreker: S2\nJa.';
  const { value } = validateCleaner(input)(out);
  assert.deepEqual(value.map((v) => [v.id, v.merged]), [['B001', ['B002']], ['B003', []]]);
});

test('cleaner: samenvoegen over verschillende sprekers wordt teruggedraaid', () => {
  const input = [mk('B001', 'S1', 'een twee drie'), mk('B002', 'S2', 'vier vijf zes')];
  const { value, warnings } = validateCleaner(input)('## B001 | spreker: S1\neen twee drie vier vijf zes');
  assert.equal(value.length, 2);
  assert.ok(warnings.length);
});

test('cleaner: te veel tekst verdwenen → fout (opnieuw vragen)', () => {
  const input = [mk('B001', 'S1', 'een twee drie vier vijf zes zeven acht negen tien')];
  assert.throws(() => validateCleaner(input)('## B001 | spreker: S1\neen twee'));
});

test('normalizer: ontbrekend of herschreven blok blijft ongewijzigd', () => {
  const input = [mk('B001', '?', 'mevrouw Bracken zegt iets'), mk('B002', '?', 'kort'), mk('B003', '?', 'nog een zin hier')];
  const { value } = validateNormalizer(input)('## B001 | spreker: ?\nmevrouw Bracke zegt iets\n\n## B003 | spreker: ?\nhelemaal iets anders en veel langer dan het origineel was');
  assert.deepEqual(value.texts, ['mevrouw Bracke zegt iets', 'kort', 'nog een zin hier']);
});

test('delen: nooit midden in een blok', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({ text_raw: 'woord '.repeat(100) + i }));
  const chunks = chunkBlocks(blocks, 250);
  assert.equal(chunks.flat().length, 10);
  assert.ok(chunks.every((c) => c.length >= 1 && c.length <= 3));
});

test('leren: vervangingen uit een correctie', () => {
  const reps = replacementsFromEdit('mevrouw Bracken en de neckersberglaan', 'mevrouw Bracke en de Nekkersberglaan');
  assert.deepEqual(reps, [{ before: 'Bracken', after: 'Bracke' }, { before: 'neckersberglaan', after: 'Nekkersberglaan' }]);
});

test('straten: voorselectie vindt STT-varianten', () => {
  const names = candidateStreets('aan de neckersberglaan en de dendermondse steenweg').map((s) => s.naam);
  assert.ok(names.includes('Nekkersberglaan'));
  assert.ok(names.includes('Dendermondsesteenweg'));
});

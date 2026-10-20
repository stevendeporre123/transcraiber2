// Vergelijkt modeluitvoer met de invoer, per blok: wat is er veranderd, wat ontbreekt.
// Gebruikt voor het debug-log van runs en voor de testbank.
import { diffWordsWithSpace } from 'diff';
import { parseBlocks, parseSpeakerHeader, wordCount } from './blockfmt.js';
import { parseJsonLoose } from './openrouter.js';
import { replacementsFromEdit } from './learn.js';

export const BLOCK_STEPS = ['intake', 'normalizer', 'cleaner'];

/**
 * input: [{ id, speaker, text }]  (de blokken die naar het model gingen)
 * output: ruwe modeluitvoer
 */
export function analyzeOutput(step, input, output) {
  if (step === 'writer' || step === 'agenda') {
    try {
      const j = parseJsonLoose(output);
      return { kind: 'json', json: j, stats: { punten: (j.punten || []).length, context: (j.context || []).length } };
    } catch (e) {
      return { kind: 'json', error: e.message, stats: {} };
    }
  }

  const { blocks: out, sections } = parseBlocks(output);
  const outMap = new Map(out.map((b) => [b.id, b]));
  const inIds = new Set(input.map((b) => b.id));

  if (step === 'resolver') {
    const rows = input.map((b) => {
      const o = outMap.get(b.id);
      const s = o ? parseSpeakerHeader(o.speaker) : null;
      return { id: b.id, text: b.text, speaker_in: b.speaker, speaker_out: o?.speaker || null, ...(s || {}), status: o ? 'ok' : 'ontbreekt' };
    });
    const zekerheid = {};
    for (const r of rows) zekerheid[r.zekerheid || 'ontbreekt'] = (zekerheid[r.zekerheid || 'ontbreekt'] || 0) + 1;
    return {
      kind: 'resolver', blocks: rows, sections,
      stats: { in: input.length, out: out.length, ontbreekt: rows.filter((r) => r.status !== 'ok').length, zekerheid, extra: out.filter((b) => !inIds.has(b.id)).length },
    };
  }

  // Blokstappen (normalizer, cleaner, intake)
  const rows = [];
  const replacements = [];
  let lastPresent = null;
  for (const b of input) {
    const o = outMap.get(b.id);
    if (!o) {
      rows.push({ id: b.id, speaker_in: b.speaker, before: b.text, after: null, status: lastPresent ? 'samengevoegd' : 'ontbreekt', into: lastPresent });
      continue;
    }
    lastPresent = b.id;
    const changed = o.text !== b.text;
    const reps = changed ? replacementsFromEdit(b.text, o.text) : [];
    for (const r of reps) replacements.push({ id: b.id, ...r });
    rows.push({
      id: b.id, speaker_in: b.speaker, speaker_out: o.speaker, before: b.text, after: o.text,
      status: changed ? 'gewijzigd' : 'gelijk',
      diff: changed ? diffWordsWithSpace(b.text, o.text) : null,
      words_in: wordCount(b.text), words_out: wordCount(o.text),
    });
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    kind: 'blocks', blocks: rows, sections, replacements,
    stats: {
      in: input.length, out: out.length,
      gewijzigd: count('gewijzigd'), gelijk: count('gelijk'), samengevoegd: count('samengevoegd'), ontbreekt: count('ontbreekt'),
      extra: out.filter((b) => !inIds.has(b.id)).length,
      woorden_in: input.reduce((n, b) => n + wordCount(b.text), 0),
      woorden_uit: out.filter((b) => inIds.has(b.id)).reduce((n, b) => n + wordCount(b.text), 0),
      vervangingen: replacements.length,
    },
  };
}

/** Compacte samenvatting voor in het log (zonder volledige teksten). */
export function logSummary(analysis) {
  if (analysis.kind === 'blocks') {
    return {
      stats: analysis.stats,
      vervangingen: analysis.replacements.slice(0, 80).map((r) => `${r.id}: ${r.before || '∅'} → ${r.after || '∅'}`),
      notities: analysis.sections?.NOTITIES?.slice(0, 3000),
    };
  }
  if (analysis.kind === 'resolver') {
    return {
      stats: analysis.stats,
      sprekers: analysis.blocks.slice(0, 200).map((r) => `${r.id}: ${r.speaker_in || '?'} → ${r.speaker_name || '∅'} (${r.zekerheid || '-'})`),
      sprekertabel: analysis.sections?.SPREKERTABEL?.slice(0, 3000),
      notities: analysis.sections?.NOTITIES?.slice(0, 3000),
    };
  }
  return { stats: analysis.stats, error: analysis.error, json: analysis.json };
}

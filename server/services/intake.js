// Deterministische intake: VTT/SRT-cues of PDF/DOCX-tekst → genummerde blokken.
import { blockId, wordCount } from './blockfmt.js';
import { splitSpeaker } from './extract.js';

const ENDS_SENTENCE = /[.?!…:]["'”’)]?$/;
const SOFT_MAX = 120; // woorden: nieuw blok bij zinseinde
const HARD_MAX = 250; // woorden: altijd nieuw blok

/** Cues (met tijdcodes) → blokken. */
export function blocksFromCues(cues) {
  const blocks = [];
  let cur = null;
  let prevEnd = 0;
  for (const c of cues) {
    const words = cur ? wordCount(cur.text) : 0;
    const speaker = c.speaker ?? cur?.speaker_raw ?? null;
    const speakerChange = cur && speaker !== cur.speaker_raw;
    const longPause = cur && c.start - prevEnd > 8 && ENDS_SENTENCE.test(cur.text);
    const tooLong = cur && (words >= HARD_MAX || (words >= SOFT_MAX && ENDS_SENTENCE.test(cur.text)));
    if (!cur || speakerChange || longPause || tooLong) {
      cur = { speaker_raw: speaker, text: c.text, t_start: c.start, t_end: c.end };
      blocks.push(cur);
    } else {
      cur.text += ' ' + c.text;
      cur.t_end = Math.max(cur.t_end, c.end);
    }
    prevEnd = c.end;
  }
  return finalize(blocks);
}

const PAGE_NUMBER = /^\s*(?:pagina|page|p\.)?\s*\d{1,4}\s*(?:(?:\/|van|of)\s*\d{1,4})?\s*$/i;
const LABEL_ONLY = /^\s*((?:Spreker|Speaker)\s*\w{1,3}|\[[^\]]{1,40}\])\s*(?:\(?\d{1,2}:\d{2}(?::\d{2})?\)?)?\s*$/i;
const LEADING_TIME = /^\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*/;
const normLine = (l) => l.trim().replace(/\d+/g, '#').toLowerCase();

/** Verwijdert kop-/voetregels die op de meeste pagina's terugkomen, en paginanummers. */
export function stripPageNoise(pages) {
  const counts = new Map();
  const pageLines = pages.map((p) => String(p).replace(/\r/g, '').split('\n'));
  if (pages.length >= 3) {
    for (const lines of pageLines) {
      const nonEmpty = lines.filter((l) => l.trim());
      const edge = new Set([...nonEmpty.slice(0, 3), ...nonEmpty.slice(-3)].map(normLine));
      for (const l of edge) counts.set(l, (counts.get(l) || 0) + 1);
    }
  }
  const removed = new Set();
  const out = pageLines.map((lines) => lines.filter((l) => {
    if (PAGE_NUMBER.test(l) && l.trim()) { removed.add('paginanummers'); return false; }
    const n = normLine(l);
    if (n && n.length <= 120 && wordCount(l) <= 12 && !ENDS_SENTENCE.test(l.trim()) && !splitSpeaker(l)[0] && (counts.get(n) || 0) >= Math.max(3, pages.length * 0.5)) { removed.add(`"${l.trim()}"`); return false; }
    return true;
  }));
  return { lines: out.flat(), removed: [...removed] };
}

/** Voegt PDF-regels samen tot alinea's (harde regelafbreking, afbreekstreepjes). */
export function joinLines(lines) {
  const paras = [];
  let cur = '';
  const lengths = lines.map((l) => l.trim().length).filter((n) => n > 20).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length * 0.7)] || 80;
  let prevLen = 0;
  const flush = () => { if (cur.trim()) paras.push(cur.trim()); cur = ''; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      // lege regel = alineagrens, tenzij de zin niet af is en de volgende met kleine letter begint (wordt hieronder hersteld)
      if (cur) { paras.push(cur.trim()); cur = ''; }
      prevLen = 0;
      continue;
    }
    if (LABEL_ONLY.test(line) || splitSpeaker(line)[0]) { flush(); cur = line; prevLen = line.length; continue; }
    if (!cur) { cur = line; prevLen = line.length; continue; }
    // Korte vorige regel die op een zin eindigt = waarschijnlijk alinea-einde
    if (ENDS_SENTENCE.test(cur) && prevLen < typical * 0.6 && /^[A-ZÀ-Ý"“(]/.test(line)) { flush(); cur = line; prevLen = line.length; continue; }
    if (/[a-zà-ÿ]-$/.test(cur) && /^[a-zà-ÿ]/.test(line)) cur = cur.slice(0, -1) + line;
    else if (/-$/.test(cur) && /^[A-ZÀ-Ý]/.test(line)) cur = cur + line;
    else cur += ' ' + line;
    prevLen = line.length;
  }
  flush();
  // Alinea's die midden in een zin gesplitst zijn weer samenvoegen
  const merged = [];
  for (const p of paras) {
    const prev = merged[merged.length - 1];
    if (prev && !ENDS_SENTENCE.test(prev) && /^[a-zà-ÿ]/.test(p) && !splitSpeaker(p)[0]) merged[merged.length - 1] = prev + ' ' + p;
    else merged.push(p);
  }
  return merged;
}

/** Tekst zonder tijdcodes (PDF/DOCX/TXT) → blokken. */
export function blocksFromText(pages) {
  const { lines, removed } = stripPageNoise(pages);
  const paras = joinLines(lines);
  const blocks = [];
  let speaker = null;
  let labels = 0;
  for (let p of paras) {
    const only = p.match(LABEL_ONLY);
    if (only) { speaker = only[1].replace(/^\[|\]$/g, ''); labels++; continue; }
    const lo = p.match(/^((?:Spreker|Speaker)\s*\w{1,3})\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s+(.*)$/i);
    if (lo) { speaker = lo[1]; p = lo[2]; labels++; }
    const [lbl, rest] = splitSpeaker(p);
    if (lbl) { speaker = lbl; p = rest; labels++; }
    p = p.replace(LEADING_TIME, '');
    for (const piece of splitLong(p)) blocks.push({ speaker_raw: speaker, text: piece, t_start: null, t_end: null });
  }
  return { blocks: finalize(blocks), notes: { labels, removed } };
}

function splitLong(text) {
  if (wordCount(text) <= HARD_MAX) return [text];
  const sentences = text.match(/[^.?!…]+[.?!…]+["'”’)]?\s*|[^.?!…]+$/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && wordCount(cur) + wordCount(s) > SOFT_MAX) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function finalize(blocks) {
  return blocks
    .map((b) => ({ ...b, text: b.text.replace(/\s+/g, ' ').trim() }))
    .filter((b) => b.text)
    .map((b, i) => ({ id: blockId(i + 1), speaker_raw: b.speaker_raw || null, text_raw: b.text, t_start: b.t_start, t_end: b.t_end }));
}

/** Splitst blokken in delen van ongeveer `target` woorden (nooit midden in een blok). */
export function chunkBlocks(blocks, target = 2000, field = 'text_raw') {
  const chunks = [];
  let cur = [];
  let words = 0;
  for (const b of blocks) {
    const w = wordCount(b[field] || '');
    if (cur.length && words + w > target) { chunks.push(cur); cur = []; words = 0; }
    cur.push(b);
    words += w;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

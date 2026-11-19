// Verbeterde ondertitels (SRT/VTT): het originele ondertitelbestand, met de tekst van alle runs
// van een vergadering erin teruggezet. Altijd het volledige bestand: cues die geen enkele run
// behandeld heeft blijven ongewijzigd, en elke cue houdt zijn originele tijdcodes.
//
// Werkwijze (op woordniveau, dus los van tijdcodes: werkt ook als de transcriptie een PDF/DOCX was):
//  1. Elke run: de ruwe tekst van al zijn blokken wordt uitgelijnd op de woorden van de cues.
//  2. Per eindblok (blok + de blokken die de cleaner erin samenvoegde) wordt de verbeterde tekst
//     uitgelijnd op die ruwe tekst. Zo krijgt elk verbeterd woord een plaats in een cue.
//  3. Een eindblok "claimt" de cue-woorden van zijn eerste tot zijn laatste teruggevonden woord.
//     Bij overlap wint een manueel aangepast blok, daarna de nieuwste run.
import fs from 'node:fs';
import { db } from '../db.js';
import { parseTime, formatTime, splitSpeaker } from './extract.js';

const LINE_MAX = 42; // tekens per ondertitelregel

// ---------------- Inlezen (met behoud van alles wat we ongewijzigd teruggeven) ----------------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** SRT/VTT-tekst → { format, header, cues: [{ id, timing, start, end, settings, lines, speaker, label, words }] } */
export function parseSubtitleFile(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const format = /^WEBVTT/.test(text.trimStart()) ? 'vtt' : 'srt';
  const chunks = text.split(/\n\s*\n/);
  const header = [];
  const cues = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) {
      // WEBVTT-kop, NOTE, STYLE, REGION: enkel vóór de eerste cue bewaren
      if (format === 'vtt' && !cues.length) header.push(lines.join('\n'));
      continue;
    }
    const [a, b] = lines[ti].split('-->');
    const [endStr, ...settings] = b.trim().split(/\s+/);
    const start = parseTime(a);
    const end = parseTime(endStr);
    if (start == null || end == null) continue;
    const id = ti > 0 ? lines.slice(0, ti).join(' ').trim() : null;
    const body = lines.slice(ti + 1);
    let speaker = null;
    let plain = body.map((l) => {
      const v = l.match(/<v(?:\.[\w.-]+)?\s+([^>]+)>/);
      if (v) speaker = v[1].trim();
      return decode(l.replace(/<[^>]+>/g, '')).trim();
    }).join(' ').replace(/\s+/g, ' ').trim();
    let label = null;
    if (!speaker) {
      const [lbl, rest] = splitSpeaker(plain);
      if (lbl) { label = lbl; plain = rest; }
    }
    plain = plain.replace(/^-\s+/, '');
    cues.push({ id, timing: lines[ti], start, end, settings: settings.join(' '), lines: body, speaker: speaker || label, words: plain ? plain.split(' ') : [] });
  }
  return { format, header: format === 'vtt' ? header : [], cues };
}

export function readSubtitleFile(file) {
  return parseSubtitleFile(fs.readFileSync(file, 'utf8'));
}

// ---------------- Uitlijnen van twee woordreeksen ----------------
const key = (w) => {
  const k = String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  return k || null;
};

const DP_MAX = 4_000_000; // cellen voor de exacte uitlijning tussen twee ankers

/**
 * Langste gemeenschappelijke deelreeks tussen a[a0..a1) en b[b0..b1), schrijft in match.
 * late = bij gelijkwaardige keuzes zo laat mogelijk in b (voor het stuk vóór het eerste anker).
 */
function lcsGap(a, b, a0, a1, b0, b1, match, late = false) {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n <= 0 || m <= 0 || n * m > DP_MAX) return;
  if (late) {
    const ra = a.slice(a0, a1).reverse();
    const rb = b.slice(b0, b1).reverse();
    const rm = new Int32Array(n).fill(-1);
    lcsGap(ra, rb, 0, n, 0, m, rm);
    for (let i = 0; i < n; i++) if (rm[i] >= 0) match[a1 - 1 - i] = b1 - 1 - rm[i];
    return;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ka = a[a0 + i];
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = ka !== null && ka === b[b0 + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] !== null && a[a0 + i] === b[b0 + j]) { match[a0 + i] = b0 + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
}

/**
 * Lijnt woordsleutels a op b uit: match[i] = index in b, of -1.
 * Eerst ankers (4 woorden die in beide reeksen precies één keer voorkomen, langste stijgende keten),
 * daarna exact tussen de ankers. Snel genoeg voor een volledige zitting (tienduizenden woorden).
 */
export function alignWords(a, b) {
  const match = new Int32Array(a.length).fill(-1);
  const N = 4;
  const grams = (arr) => {
    const m = new Map();
    for (let i = 0; i + N <= arr.length; i++) {
      if (arr[i] === null) continue;
      let g = '';
      let ok = true;
      for (let t = 0; t < N; t++) { if (arr[i + t] === null) { ok = false; break; } g += arr[i + t] + '\u0001'; }
      if (!ok) continue;
      m.set(g, m.has(g) ? -1 : i);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  const pairs = [];
  for (const [g, i] of ga) {
    const j = gb.get(g);
    if (i >= 0 && j !== undefined && j >= 0) for (let t = 0; t < N; t++) pairs.push([i + t, j + t]);
  }
  // langste keten met stijgende i én j (gelijke i: aflopende j, zodat er maar één gekozen wordt)
  pairs.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  const tails = [];
  const tailIdx = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const v = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v;
    tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const chain = [];
  for (let k = tailIdx[tails.length - 1] ?? -1; k >= 0; k = prev[k]) chain.push(pairs[k]);
  chain.reverse();
  for (const [i, j] of chain) match[i] = j;
  // gaten tussen de ankers (aan de randen enkel een venster: een run kan een klein deel van de zitting zijn)
  let pi = 0;
  let pj = 0;
  for (let k = 0; k <= chain.length; k++) {
    const [ni, nj] = k < chain.length ? chain[k] : [a.length, b.length];
    let b0 = pj;
    let b1 = nj;
    if (chain.length && k === 0) b0 = Math.max(pj, nj - (ni - pi) * 2 - 20);
    if (chain.length && k === chain.length) b1 = Math.min(nj, pj + (ni - pi) * 2 + 20);
    lcsGap(a, b, pi, ni, b0, b1, match, k === 0 && chain.length > 0);
    if (k < chain.length) { pi = ni + 1; pj = nj + 1; }
  }
  return match;
}

// ---------------- Runs → claims op cue-woorden ----------------
const splitWords = (s) => String(s || '').split(/\s+/).filter(Boolean);

/** Bron van de ondertitels: apart opgeladen bestand, anders het transcript zelf als dat VTT/SRT is. */
export function subtitleSource(meeting) {
  if (meeting.subtitle_file) return { file: meeting.subtitle_file, name: meeting.subtitle_name, type: meeting.subtitle_type, uploaded: true };
  if (['vtt', 'srt'].includes(meeting.input_type)) return { file: meeting.input_file, name: meeting.input_name, type: meeting.input_type, uploaded: false };
  return null;
}

export function subtitleRuns(meetingId) {
  return db.prepare(`SELECT r.id, r.label, r.status, r.created_at, r.finished_at,
      (SELECT COUNT(*) FROM run_blocks b WHERE b.run_id = r.id AND b.merged_into IS NULL) AS blocks,
      (SELECT COUNT(*) FROM run_blocks b WHERE b.run_id = r.id AND b.edited = 1) AS edited
    FROM runs r WHERE r.meeting_id = ? ORDER BY r.id DESC`).all(meetingId);
}

/**
 * Bouwt het verbeterde ondertitelbestand.
 * opts: { runIds (standaard alle runs met blokken die niet meer lopen), format ('srt'|'vtt', standaard = bron), speakers (bool) }
 */
export function buildSubtitles(meetingId, { runIds, format, speakers = true, sub } = {}) {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) throw new Error('Vergadering niet gevonden.');
  if (!sub) {
    const src = subtitleSource(meeting);
    if (!src) throw new Error('Geen ondertitelbestand: laad eerst de originele SRT of VTT op.');
    sub = readSubtitleFile(src.file);
  }
  if (!sub.cues.length) throw new Error('Geen ondertitels (cues) gevonden in het bestand.');
  format = format || sub.format;

  // cue-woorden als één reeks
  const words = [];
  const cueStart = [];
  sub.cues.forEach((c) => { cueStart.push(words.length); words.push(...c.words); });
  const cueKeys = words.map(key);

  const allRuns = subtitleRuns(meetingId);
  const chosen = (runIds ? allRuns.filter((r) => runIds.includes(r.id)) : allRuns.filter((r) => r.blocks > 0 && !['bezig', 'wachtrij'].includes(r.status)))
    .sort((x, y) => x.id - y.id);

  // groepen = eindblokken (met hun samengevoegde blokken), elk met claim [lo, hi] en woorden per cue-woordpositie
  const groups = [];
  const runStats = [];
  for (const run of chosen) {
    const blocks = db.prepare('SELECT * FROM run_blocks WHERE run_id = ? ORDER BY ord').all(run.id);
    const rawWords = [];
    const rawGroup = [];
    const byId = new Map();
    for (const b of blocks) {
      const gid = b.merged_into || b.block_id;
      for (const w of splitWords(b.text_raw)) { rawWords.push(w); rawGroup.push(gid); }
      if (!b.merged_into) byId.set(b.block_id, b);
    }
    const rawToCue = alignWords(rawWords.map(key), cueKeys);
    const raws = new Map(); // gid → [{ key, pos }]
    rawWords.forEach((w, i) => {
      if (!raws.has(rawGroup[i])) raws.set(rawGroup[i], []);
      raws.get(rawGroup[i]).push({ key: key(w), pos: rawToCue[i] });
    });
    let placed = 0;
    let missing = 0;
    for (const [gid, b] of byId) {
      const raw = raws.get(gid) || [];
      const fin = splitWords(b.text_final);
      const posList = raw.map((r) => r.pos).filter((p) => p >= 0);
      if (!posList.length) { if (raw.length) missing++; continue; }
      const finToRaw = alignWords(fin.map(key), raw.map((r) => r.key));
      // plaats per verbeterd woord: die van het overeenkomende ruwe woord, anders die van het vorige woord
      const pos = fin.map((_, i) => (finToRaw[i] >= 0 ? raw[finToRaw[i]].pos : -1));
      let last = -1;
      for (let i = 0; i < pos.length; i++) { if (pos[i] >= 0 && pos[i] >= last) last = pos[i]; else pos[i] = last; }
      const first = pos.find((p) => p >= 0) ?? posList[0];
      const at = new Map();
      fin.forEach((w, i) => {
        const p = pos[i] >= 0 ? pos[i] : first;
        if (!at.has(p)) at.set(p, []);
        at.get(p).push(w);
      });
      groups.push({
        run: run.id, block: gid, edited: !!b.edited, lo: Math.min(...posList), hi: Math.max(...posList), at,
        speaker: b.speaker_name && !/^onbekend/i.test(b.speaker_name) ? b.speaker_name : null,
      });
      placed++;
    }
    runStats.push({ id: run.id, label: run.label, status: run.status, placed, missing });
  }

  // claims: eerst gewone blokken, dan manueel aangepaste; binnen elk de nieuwste run laatst (wint)
  const owner = new Int32Array(words.length).fill(-1);
  const order = groups.map((g, i) => i).sort((x, y) => (groups[x].edited - groups[y].edited) || (groups[x].run - groups[y].run));
  for (const gi of order) for (let p = groups[gi].lo; p <= groups[gi].hi; p++) owner[p] = gi;

  // cue-teksten opbouwen
  const outCues = [];
  let improved = 0;
  let dropped = 0;
  let prevSpeaker = null;
  sub.cues.forEach((c, ci) => {
    const out = [];
    const owners = new Set();
    for (let p = cueStart[ci]; p < cueStart[ci] + c.words.length; p++) {
      const gi = owner[p];
      if (gi < 0) out.push(words[p]);
      else { owners.add(gi); out.push(...(groups[gi].at.get(p) || [])); }
    }
    if (!owners.size) {
      const sp = speakers ? c.speaker : null;
      outCues.push({ cue: c, original: true, speaker: sp, newSpeaker: !!sp && sp !== prevSpeaker });
      prevSpeaker = c.speaker || prevSpeaker;
      return;
    }
    const text = out.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) { dropped++; return; }
    const g = groups[[...owners][0]];
    const speaker = speakers ? (g.speaker || c.speaker) : null;
    if (text !== c.words.join(' ') || (speaker && speaker !== c.speaker)) improved++;
    outCues.push({ cue: c, text, speaker, newSpeaker: speaker && speaker !== prevSpeaker });
    prevSpeaker = speaker || prevSpeaker;
  });

  const content = render(sub, outCues, format);
  return {
    content, format,
    stats: { cues: sub.cues.length, improved, unchanged: sub.cues.length - improved - dropped, dropped, output: outCues.length, runs: runStats },
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tekst over regels van max LINE_MAX tekens, zo gelijk mogelijk verdeeld. */
export function wrapLines(text, max = LINE_MAX) {
  if (text.length <= max) return [text];
  const n = Math.ceil(text.length / max);
  const target = text.length / n;
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length > max || (cur.length >= target && lines.length < n - 1))) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

function render(sub, outCues, format) {
  const vtt = format === 'vtt';
  const parts = [];
  if (vtt) parts.push(sub.format === 'vtt' && sub.header.length ? sub.header.join('\n\n') : 'WEBVTT');
  let n = 0;
  for (const o of outCues) {
    const c = o.cue;
    n++;
    const timing = sub.format === format ? c.timing
      : vtt ? `${formatTime(c.start)} --> ${formatTime(c.end)}`
        : `${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}`;
    let body;
    if (o.original) {
      body = sub.format === format ? c.lines
        : vtt ? c.lines.map((l) => esc(l))
          : wrapLines(`${o.newSpeaker && c.lines.some((l) => /<v[\s.]/.test(l)) ? `${o.speaker}: ` : ''}${c.lines.map((l) => decode(l.replace(/<[^>]+>/g, '')).trim()).join(' ')}`);
    } else {
      const lines = wrapLines(o.text);
      if (vtt) {
        body = lines.map(esc);
        if (o.speaker) body[0] = `<v ${o.speaker.replace(/[<>]/g, '')}>${body[0]}`;
      } else {
        body = lines;
        if (o.speaker && o.newSpeaker) body = wrapLines(`${o.speaker}: ${o.text}`);
      }
    }
    const id = vtt ? (sub.format === 'vtt' && c.id ? c.id : null) : String(n);
    parts.push([id, timing, ...body].filter((x) => x != null).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}

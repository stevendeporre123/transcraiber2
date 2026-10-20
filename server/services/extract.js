import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export function detectType(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (['pdf', 'docx', 'vtt', 'srt', 'txt'].includes(ext)) return ext;
  throw new Error(`Bestandstype .${ext} wordt niet ondersteund (pdf, docx, vtt, srt, txt).`);
}

export const hasTimecodes = (type) => type === 'vtt' || type === 'srt';

/** PDF → array met tekst per pagina */
export async function pdfPages(file) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

export async function docxText(file) {
  const { value } = await mammoth.extractRawText({ path: file });
  return value;
}

/** Tijd "01:02:03.456", "02:03.456" of "01:02:03,456" → seconden */
export function parseTime(s) {
  const m = String(s).trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] || '0').padEnd(3, '0')) / 1000;
}

export function formatTime(sec, sep = '.') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

const SPEAKER_PREFIX = /^\s*(?:\[([^\]]{1,40})\]|((?:Spreker|Speaker|Voorzitter|Spk)\s*\w{0,3}|[A-ZÀ-Ý][\p{L}'’.-]+(?:\s+(?:[A-ZÀ-Ý]|de|van|den|der|el|ben|le)[\p{L}'’.-]*){1,4}))\s*:\s+/u;

/** Haalt een sprekerlabel vooraan een regel weg. Geeft [label|null, rest]. */
export function splitSpeaker(line) {
  const m = line.match(SPEAKER_PREFIX);
  if (!m) return [null, line];
  const label = (m[1] || m[2]).trim();
  // "Dus:" of "Vraag:" zijn geen namen: label moet een hoofdletter-naam, of Spreker/Speaker zijn
  if (/^(dus|vraag|antwoord|let op|opmerking|noot|punt|agendapunt|stemming|besluit)$/i.test(label)) return [null, line];
  return [label, line.slice(m[0].length)];
}

/** VTT of SRT → cues [{start, end, speaker, text}] */
export function parseCues(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r/g, '');
  const cues = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    let speaker = null;
    const body = lines.slice(ti + 1).map((l) => {
      const v = l.match(/<v(?:\.[\w.-]+)?\s+([^>]+)>/);
      if (v) speaker = v[1].trim();
      return l.replace(/<[^>]+>/g, '').trim();
    }).join(' ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    let t = body;
    if (!speaker) {
      const [lbl, rest] = splitSpeaker(body);
      if (lbl) { speaker = lbl; t = rest; }
    }
    t = t.replace(/^-\s+/, '');
    cues.push({ start, end, speaker, text: t });
  }
  return cues;
}

/** Leest het transcript-bestand in. */
export async function readInput(file, type) {
  if (type === 'pdf') return { type, pages: await pdfPages(file) };
  if (type === 'docx') return { type, pages: [await docxText(file)] };
  if (type === 'txt') return { type, pages: [fs.readFileSync(file, 'utf8')] };
  return { type, cues: parseCues(fs.readFileSync(file, 'utf8')) };
}

export async function readAgendaText(file) {
  const type = detectType(file);
  if (type === 'pdf') return (await pdfPages(file)).join('\n\n');
  if (type === 'docx') return docxText(file);
  return fs.readFileSync(file, 'utf8');
}

// Voorbereiding van een vergadering (stap 1), los van de runs:
//   intake → blokken (met tijdcodes per cue) in meeting_blocks
//   agenda → agendapunten in meeting_points (in code; de LLM levert enkel extra context)
//   segmenteren → meeting_segments: waar begint elk agendapunt (blokken worden op het citaat geknipt)
import { db, json } from '../db.js';
import { STEPS } from '../config.js';
import { complete, defaultModel, parseJsonLoose, StopError } from './openrouter.js';
import { buildPrompt } from './context.js';
import { blockId, wordCount } from './blockfmt.js';
import { readInput } from './extract.js';
import { blocksFromCues, blocksFromText } from './intake.js';
import { parseAgenda } from './agenda-parse.js';
import { processAgenda } from './pipeline.js';
import { log } from './logger.js';

const WINDOW_WORDS = 5000; // woorden transcript per segmenteer-aanroep

const active = new Map(); // meetingId → AbortController
export const isPreparing = (id) => active.has(Number(id));
export function stopPrepare(id) {
  const c = active.get(Number(id));
  if (c) c.abort();
  return !!c;
}

const L = (meetingId, level, step, message, data) => log({ meetingId, level, step, message, data });
const progress = (id, p) => db.prepare('UPDATE meetings SET prep_progress = ? WHERE id = ?').run(p, id);

// ---------------- 1. Intake ----------------
export async function intakeMeeting(meetingId) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  const input = await readInput(m.input_file, m.input_type);
  const blocks = input.cues ? blocksFromCues(input.cues) : blocksFromText(input.pages).blocks;
  if (!blocks.length) throw new Error('Geen tekst gevonden in het invoerbestand (gescande PDF zonder tekstlaag?).');
  saveBlocks(meetingId, blocks.map((b) => ({ speaker_raw: b.speaker_raw, text: b.text_raw, t_start: b.t_start, t_end: b.t_end, cues: b.cues })));
  db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId);
  const words = blocks.reduce((n, b) => n + wordCount(b.text_raw), 0);
  L(meetingId, 'info', 'intake', `${blocks.length} blokken, ${words} woorden${input.cues ? `, ${input.cues.length} cues met tijdcodes` : ' (geen tijdcodes)'}`);
  return blocks.length;
}

/** Blokken (in volgorde) opslaan met doorlopende nummering B001, B002, … */
function saveBlocks(meetingId, blocks) {
  const ins = db.prepare(`INSERT INTO meeting_blocks (meeting_id, ord, block_id, t_start, t_end, speaker_raw, text, cues, segment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM meeting_blocks WHERE meeting_id = ?').run(meetingId);
    blocks.forEach((b, i) => ins.run(meetingId, i, blockId(i + 1), b.t_start ?? null, b.t_end ?? null, b.speaker_raw ?? null, b.text,
      b.cues ? JSON.stringify(b.cues) : null, b.segment_id ?? null));
  })();
}

export function loadBlocks(meetingId) {
  return db.prepare('SELECT * FROM meeting_blocks WHERE meeting_id = ? ORDER BY ord').all(meetingId)
    .map((b) => ({ ...b, cues: json(b.cues, null) }));
}

// ---------------- 2. Agenda ----------------
/** "BRAM VAN BRAECKEVELT" → naam uit de ledenlijst */
function nameFor(upper) {
  const m = db.prepare('SELECT naam FROM members WHERE upper(naam) = upper(?)').get(upper.trim());
  if (m) return m.naam;
  return upper.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());
}

export async function agendaMeeting(meetingId, { model, signal, context = true } = {}) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!m.agenda_text) {
    L(meetingId, 'warn', 'agenda', 'geen agenda opgeladen: de hele transcriptie wordt één segment');
    return 0;
  }
  const parsed = parseAgenda(m.agenda_text, nameFor);
  let points = parsed?.punten || [];
  let bron = 'code';
  if (points.length) {
    L(meetingId, 'info', 'agenda', `agenda in code ingelezen (${parsed.format}): ${points.length} punten`, {
      types: points.reduce((a, p) => ({ ...a, [p.type]: (a[p.type] || 0) + 1 }), {}), vergadering: parsed.vergadering,
    });
    db.prepare(`UPDATE meetings SET agenda_format = ?, datum = COALESCE(NULLIF(datum, ''), ?) WHERE id = ?`).run(parsed.format, parsed.vergadering.datum, meetingId);
  }
  // LLM: context (namen, projecten) en, als de code niets vond, ook de punten
  if (context || !points.length) {
    try {
      const res = await processAgenda(meetingId, model, null, signal);
      if (!points.length) {
        bron = 'llm';
        points = (res.punten || []).map((p, i) => ({
          ord: i + 1, nummer: p.nummer || '', code: null, type: p.type === 'vraag' ? 'mondelinge_vraag' : p.type || 'overig',
          titel: p.titel || '', indieners: p.indieners || [], bevoegd: p.schepen || null, sectie: null, toelichting: p.kern || null,
        }));
        L(meetingId, 'info', 'agenda', `geen dossiercodes gevonden: ${points.length} punten via de LLM (agenda-extractor)`);
      }
    } catch (e) {
      if (e instanceof StopError || signal?.aborted) throw new StopError();
      L(meetingId, 'warn', 'agenda', `extra context uit de agenda mislukt: ${e.message}`);
    }
  }
  // Bestaande selectie (per dossiercode) behouden bij opnieuw inlezen
  const prevSel = new Map(db.prepare('SELECT code, selected FROM meeting_points WHERE meeting_id = ? AND code IS NOT NULL').all(meetingId).map((p) => [p.code, p.selected]));
  const ins = db.prepare(`INSERT INTO meeting_points (meeting_id, ord, nummer, code, type, titel, indieners, bevoegd, sectie, toelichting, selected, bron)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId);
    db.prepare('DELETE FROM meeting_points WHERE meeting_id = ?').run(meetingId);
    for (const p of points) {
      ins.run(meetingId, p.ord, p.nummer, p.code, p.type, p.titel, JSON.stringify(p.indieners || []), p.bevoegd, p.sectie, p.toelichting,
        prevSel.has(p.code) ? prevSel.get(p.code) : 1, bron);
    }
  })();
  return points.length;
}

// ---------------- 3. Segmenteren ----------------
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Zoekt het citaat in de bloktekst. Geeft de tekenpositie waar het begint, of -1.
 * Tolerant voor hoofdletters, leestekens en accenten; probeert ook een kortere aanhef.
 */
export function findQuote(text, citaat) {
  if (!citaat) return -1;
  const exact = text.indexOf(citaat.trim());
  if (exact >= 0) return exact;
  // woordposities in de originele tekst
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) words.push({ pos: m.index, w: fold(m[0]) });
  const q = fold(citaat).split(' ').filter(Boolean);
  for (const len of [q.length, 8, 5, 4, 3]) {
    if (len > q.length || len < 3) continue;
    const needle = q.slice(0, len);
    for (let i = 0; i + len <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < len && ok; k++) if (words[i + k].w !== needle[k]) ok = false;
      if (ok) return words[i].pos;
    }
  }
  return -1;
}

/**
 * Knipt een blok op tekenpositie `pos`. Het tweede deel begint op de cue waarin `pos` valt:
 * de tijd is de echte begintijd van die cue (geen schatting).
 */
export function splitBlock(b, pos) {
  const left = b.text.slice(0, pos).trim();
  const right = b.text.slice(pos).trim();
  if (!left || !right) return null;
  let cuesL = null;
  let cuesR = null;
  let t = null;
  if (b.cues?.length) {
    const idx = b.cues.reduce((best, c, i) => (c[0] <= pos ? i : best), 0);
    const c = b.cues[idx];
    t = c[1];
    cuesL = b.cues.filter((x) => x[0] < pos);
    const leading = b.text.slice(pos).length - b.text.slice(pos).trimStart().length;
    cuesR = [[0, c[1], c[2]], ...b.cues.slice(idx + 1).map((x) => [x[0] - pos - leading, x[1], x[2]])];
  }
  return [
    { ...b, text: left, t_end: t ?? b.t_end, cues: cuesL },
    { ...b, text: right, t_start: t ?? b.t_start, cues: cuesR },
  ];
}

function agendaLines(points) {
  return points.map((p) => {
    const ind = (json(p.indieners, []) || []).join(', ');
    return `- P${p.id} | ${p.nummer || '?'} | ${p.type} | indiener: ${ind || '-'} | bevoegd: ${p.bevoegd || '-'} | ${String(p.titel).slice(0, 160)}`;
  }).join('\n');
}

export async function segmentMeeting(meetingId, { model, signal } = {}) {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  let blocks = loadBlocks(meetingId);
  const points = db.prepare('SELECT * FROM meeting_points WHERE meeting_id = ? ORDER BY ord').all(meetingId);
  const pointIds = new Set(points.map((p) => p.id));
  if (!points.length) {
    db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId);
    db.prepare("INSERT INTO meeting_segments (meeting_id, start_ord, label, zekerheid, bron, point_ids) VALUES (?, 0, 'Volledige transcriptie', 'hoog', 'code', '[]')").run(meetingId);
    assignSegments(meetingId);
    return 1;
  }
  const skill = db.prepare('SELECT * FROM skills WHERE naam = ?').get(STEPS.segmenter.skill);
  const { system } = buildPrompt(skill, { meeting });
  const useModel = model || defaultModel('segmenter');
  const agenda = agendaLines(points);

  // vensters van ~WINDOW_WORDS woorden
  const windows = [];
  let cur = [];
  let words = 0;
  for (const b of blocks) {
    const w = wordCount(b.text);
    if (cur.length && words + w > WINDOW_WORDS) { windows.push(cur); cur = []; words = 0; }
    cur.push(b);
    words += w;
  }
  if (cur.length) windows.push(cur);

  const transitions = []; // { block (object), citaat, punten, label, zekerheid, bewijs }
  let prevLabel = 'geen (begin van de opname)';
  for (const [wi, win] of windows.entries()) {
    if (signal?.aborted) throw new StopError();
    progress(meetingId, `Opdelen per agendapunt: deel ${wi + 1}/${windows.length}`);
    const byId = new Map(win.map((b) => [b.block_id, b]));
    const user = `VORIG SEGMENT: ${prevLabel}\n\n## AGENDA\n${agenda}\n\n## TRANSCRIPT\n${win.map((b) => `## ${b.block_id} | spreker: ${b.speaker_raw || '?'}\n${b.text}`).join('\n\n')}`;
    L(meetingId, 'info', 'segmenter', `aanroep ${useModel} (skill ${skill.naam} v${skill.version}), deel ${wi + 1}/${windows.length}: ${win.length} blokken`, {
      systeemprompt_tekens: system.length, invoer_tekens: user.length, agendapunten: points.length,
    });
    let found = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !found; attempt++) {
      const res = await complete({ model: useModel, system, user: attempt ? `${user}\n\n---\nLET OP: je vorige antwoord was onbruikbaar (${lastErr}). Geef alleen geldige JSON volgens de skill.` : user, json: true, signal });
      L(meetingId, 'info', 'segmenter', `antwoord in ${(res.ms / 1000).toFixed(1)} s: ${res.tokensIn} tokens in, ${res.tokensOut} uit, $${(res.cost || 0).toFixed(4)}`);
      try {
        const j = parseJsonLoose(res.text);
        if (!Array.isArray(j.segmenten)) throw new Error('veld "segmenten" ontbreekt');
        found = j.segmenten;
      } catch (e) {
        lastErr = e.message;
        L(meetingId, 'warn', 'segmenter', `antwoord afgekeurd: ${e.message}`, { begin: res.text.slice(0, 1000) });
      }
    }
    if (!found) throw new Error(`Opdelen per agendapunt mislukt in deel ${wi + 1}: ${lastErr}`);
    const accepted = [];
    for (const s of found) {
      if (s.vervolg) continue;
      const b = byId.get(String(s.start || '').toUpperCase());
      if (!b) { L(meetingId, 'warn', 'segmenter', `segment met onbekend startblok ${s.start} overgeslagen`); continue; }
      const punten = (s.punten || []).map((p) => Number(String(p).replace(/\D/g, ''))).filter((id) => pointIds.has(id));
      accepted.push({ block: b, citaat: s.citaat, punten, label: s.label || null, zekerheid: s.zekerheid || 'middel', bewijs: s.bewijs || null });
    }
    transitions.push(...accepted);
    const last = accepted[accepted.length - 1];
    if (last) {
      const p = points.find((x) => x.id === last.punten[0]);
      prevLabel = p ? `P${p.id} (${p.nummer}: ${String(p.titel).slice(0, 80)})` : (last.label || 'overig');
    }
    L(meetingId, 'info', 'segmenter', `${accepted.length} overgang(en) gevonden`, {
      overgangen: accepted.map((t) => `${t.block.block_id} "${String(t.citaat || '').slice(0, 60)}" → ${t.punten.length ? t.punten.map((id) => points.find((x) => x.id === id)?.nummer).join('+') : t.label} (${t.zekerheid})`),
    });
  }

  // Blokken knippen op de citaten (in het geheugen), daarna hernummeren
  let notFound = 0;
  for (const t of transitions) {
    const idx = blocks.indexOf(t.block);
    const pos = findQuote(t.block.text, t.citaat);
    if (pos > 0) {
      const parts = splitBlock(t.block, pos);
      if (parts) {
        blocks.splice(idx, 1, parts[0], parts[1]);
        // andere overgangen in hetzelfde blok verwijzen naar het juiste deel
        for (const o of transitions) if (o !== t && o.block === t.block) o.block = findQuote(parts[1].text, o.citaat) >= 0 ? parts[1] : parts[0];
        t.block = parts[1];
        continue;
      }
    }
    if (pos < 0 && t.citaat) notFound++;
  }
  if (notFound) L(meetingId, 'warn', 'segmenter', `${notFound} citaat/citaten niet teruggevonden: die segmenten beginnen aan het begin van hun blok`);

  // Segmenten: per blok het laatste segment dat er begint
  const starts = new Map();
  for (const t of transitions) starts.set(t.block, t);
  if (!starts.has(blocks[0])) starts.set(blocks[0], { block: blocks[0], punten: [], label: 'Begin opname', zekerheid: 'hoog', bewijs: null });
  blocks.forEach((b) => { b.segment_id = null; });
  saveBlocks(meetingId, blocks);
  const ins = db.prepare('INSERT INTO meeting_segments (meeting_id, point_id, point_ids, start_ord, label, zekerheid, bewijs, bron) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId);
    for (const [b, t] of starts) {
      ins.run(meetingId, t.punten[0] ?? null, JSON.stringify(t.punten), blocks.indexOf(b), t.punten.length ? null : (t.label || 'Overig'), t.zekerheid, t.bewijs, 'model');
    }
  })();
  assignSegments(meetingId);
  const segs = listSegments(meetingId);
  const covered = new Set(segs.flatMap((s) => s.point_ids));
  L(meetingId, 'info', 'segmenter', `${segs.length} segmenten, ${covered.size} van ${points.length} agendapunten teruggevonden`, {
    niet_gevonden: points.filter((p) => !covered.has(p.id)).map((p) => `${p.nummer}: ${String(p.titel).slice(0, 60)}`).slice(0, 200),
  });
  return segs.length;
}

/** meeting_blocks.segment_id afleiden uit de startposities van de segmenten. */
export function assignSegments(meetingId) {
  const segs = db.prepare('SELECT id, start_ord FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ord, id').all(meetingId);
  const upd = db.prepare('UPDATE meeting_blocks SET segment_id = ? WHERE meeting_id = ? AND ord >= ? AND ord < ?');
  db.transaction(() => {
    db.prepare('UPDATE meeting_blocks SET segment_id = NULL WHERE meeting_id = ?').run(meetingId);
    segs.forEach((s, i) => upd.run(s.id, meetingId, s.start_ord, segs[i + 1]?.start_ord ?? 1e9));
  })();
}

/** Segmenten met afgeleide gegevens: blokbereik, tijden, woorden, punten. */
export function listSegments(meetingId) {
  const segs = db.prepare('SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ord, id').all(meetingId);
  const stats = new Map(db.prepare(`SELECT segment_id, MIN(ord) first_ord, MAX(ord) last_ord, MIN(t_start) t_start, MAX(t_end) t_end,
      COUNT(*) blocks, SUM(LENGTH(text) - LENGTH(REPLACE(text, ' ', '')) + 1) words
    FROM meeting_blocks WHERE meeting_id = ? GROUP BY segment_id`).all(meetingId).map((r) => [r.segment_id, r]));
  const ids = (ord) => blockId(ord + 1);
  return segs.map((s, i) => {
    const st = stats.get(s.id) || {};
    return {
      ...s, index: i, point_ids: json(s.point_ids, s.point_id ? [s.point_id] : []) || [],
      first_block: st.first_ord != null ? ids(st.first_ord) : null, last_block: st.last_ord != null ? ids(st.last_ord) : null,
      first_ord: st.first_ord ?? null, last_ord: st.last_ord ?? null,
      t_start: st.t_start ?? null, t_end: st.t_end ?? null, blocks: st.blocks || 0, words: st.words || 0,
    };
  });
}

// ---------------- Manuele aanpassingen ----------------
/** Laat een segment beginnen bij blok `ord` (optioneel op een citaat in dat blok: dan wordt het blok geknipt). */
export function setSegmentStart(segmentId, ord, citaat) {
  const seg = db.prepare('SELECT * FROM meeting_segments WHERE id = ?').get(segmentId);
  if (!seg) throw new Error('Segment niet gevonden');
  const start = splitAt(seg.meeting_id, Number(ord), citaat);
  db.prepare("UPDATE meeting_segments SET start_ord = ?, bron = 'manueel' WHERE id = ?").run(start, segmentId);
  assignSegments(seg.meeting_id);
}

export function addSegment(meetingId, { ord, citaat, pointIds = [], label }) {
  const start = splitAt(meetingId, Number(ord), citaat);
  const r = db.prepare("INSERT INTO meeting_segments (meeting_id, point_id, point_ids, start_ord, label, zekerheid, bron) VALUES (?, ?, ?, ?, ?, 'hoog', 'manueel')")
    .run(meetingId, pointIds[0] ?? null, JSON.stringify(pointIds), start, pointIds.length ? null : (label || 'Overig'));
  assignSegments(meetingId);
  return r.lastInsertRowid;
}

export function updateSegment(segmentId, { pointIds, label }) {
  const seg = db.prepare('SELECT * FROM meeting_segments WHERE id = ?').get(segmentId);
  if (!seg) throw new Error('Segment niet gevonden');
  const ids = Array.isArray(pointIds) ? pointIds.map(Number) : json(seg.point_ids, []);
  db.prepare("UPDATE meeting_segments SET point_ids = ?, point_id = ?, label = ?, bron = 'manueel' WHERE id = ?")
    .run(JSON.stringify(ids), ids[0] ?? null, ids.length ? null : (label ?? seg.label ?? 'Overig'), segmentId);
}

export function deleteSegment(segmentId) {
  const seg = db.prepare('SELECT * FROM meeting_segments WHERE id = ?').get(segmentId);
  if (!seg) return;
  db.prepare('DELETE FROM meeting_segments WHERE id = ?').run(segmentId);
  // het eerste blok hoort altijd bij een segment
  const first = db.prepare('SELECT MIN(start_ord) s FROM meeting_segments WHERE meeting_id = ?').get(seg.meeting_id).s;
  if (first == null || first > 0) {
    db.prepare("INSERT INTO meeting_segments (meeting_id, start_ord, label, zekerheid, bron, point_ids) VALUES (?, 0, 'Begin opname', 'hoog', 'manueel', '[]')").run(seg.meeting_id);
  }
  assignSegments(seg.meeting_id);
}

/** Knipt blok `ord` op het citaat (als dat er middenin staat) en geeft de ord van het nieuwe startblok. */
function splitAt(meetingId, ord, citaat) {
  const blocks = loadBlocks(meetingId);
  const b = blocks[ord];
  if (!b) throw new Error(`Blok ${ord + 1} bestaat niet`);
  const pos = citaat ? findQuote(b.text, citaat) : -1;
  if (citaat && pos < 0) throw new Error(`Citaat niet gevonden in ${b.block_id}`);
  if (pos <= 0) return ord;
  const parts = splitBlock(b, pos);
  if (!parts) return ord;
  blocks.splice(ord, 1, parts[0], parts[1]);
  saveBlocks(meetingId, blocks);
  // segmenten na het geknipte blok schuiven één plaats op
  db.prepare('UPDATE meeting_segments SET start_ord = start_ord + 1 WHERE meeting_id = ? AND start_ord > ?').run(meetingId, ord);
  assignSegments(meetingId);
  return ord + 1;
}

// ---------------- Alles samen ----------------
/**
 * steps: welke stappen opnieuw: ['intake', 'agenda', 'segment'] (standaard alle drie).
 */
export async function prepareMeeting(meetingId, { model, agendaModel, steps = ['intake', 'agenda', 'segment'], context = true } = {}) {
  meetingId = Number(meetingId);
  if (active.has(meetingId)) throw new Error('De voorbereiding loopt al.');
  const ctrl = new AbortController();
  active.set(meetingId, ctrl);
  const t0 = Date.now();
  db.prepare("UPDATE meetings SET prep_status = 'bezig', prep_error = NULL, prep_progress = 'Start' WHERE id = ?").run(meetingId);
  L(meetingId, 'info', null, `voorbereiding gestart: ${steps.join(', ')}`);
  try {
    if (steps.includes('intake')) { progress(meetingId, 'Intake'); await intakeMeeting(meetingId); }
    if (steps.includes('agenda')) { progress(meetingId, 'Agenda inlezen'); await agendaMeeting(meetingId, { model: agendaModel, signal: ctrl.signal, context }); }
    if (steps.includes('segment')) { progress(meetingId, 'Opdelen per agendapunt'); await segmentMeeting(meetingId, { model, signal: ctrl.signal }); }
    db.prepare("UPDATE meetings SET prep_status = 'klaar', prep_progress = 'Klaar' WHERE id = ?").run(meetingId);
    L(meetingId, 'info', null, `voorbereiding klaar in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    const stopped = e instanceof StopError || ctrl.signal.aborted;
    db.prepare('UPDATE meetings SET prep_status = ?, prep_error = ? WHERE id = ?').run(stopped ? 'gestopt' : 'fout', stopped ? 'Gestopt door gebruiker' : e.message, meetingId);
    L(meetingId, stopped ? 'warn' : 'error', null, stopped ? 'voorbereiding gestopt' : `voorbereiding mislukt: ${e.message}`);
  } finally {
    active.delete(meetingId);
  }
}

export function markPrepInterrupted() {
  db.prepare("UPDATE meetings SET prep_status = 'fout', prep_error = 'Onderbroken (server herstart)' WHERE prep_status = 'bezig'").run();
}

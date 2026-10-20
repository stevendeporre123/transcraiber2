// Orkestratie: intake → normalizer → cleaner → resolver → writer.
// Elke modelaanroep wordt per (run, stap, deel) bewaard, zodat een mislukte run hervat kan worden.
import { db, json, getSetting, getNumberSetting } from '../db.js';
import { STEPS } from '../config.js';
import { complete, defaultModel, parseJsonLoose } from './openrouter.js';
import { buildPrompt, buildSystemPrompt } from './context.js';
import { log } from './logger.js';
import { analyzeOutput, logSummary } from './analyze.js';
import { parseBlocks, serializeBlocks, parseSpeakerHeader, blockNum, blockId, wordCount } from './blockfmt.js';
import { readInput } from './extract.js';
import { blocksFromCues, blocksFromText, chunkBlocks, stripPageNoise } from './intake.js';
import { addTermProposal } from './learn.js';

const active = new Set();
export const isActive = (runId) => active.has(Number(runId));

const getSkill = (naam) => {
  const s = db.prepare('SELECT * FROM skills WHERE naam = ?').get(naam);
  if (!s) throw new Error(`Skill ${naam} niet gevonden`);
  return s;
};

function setProgress(runId, progress) {
  db.prepare('UPDATE runs SET progress = ? WHERE id = ?').run(progress, runId);
}

function addWarning(runId, w) {
  const run = db.prepare('SELECT warnings FROM runs WHERE id = ?').get(runId);
  const list = json(run.warnings, []);
  if (!list.includes(w)) list.push(w);
  db.prepare('UPDATE runs SET warnings = ? WHERE id = ?').run(JSON.stringify(list), runId);
}

/**
 * Eén stap op één deel. `validate(text)` geeft { value, warnings } of gooit een fout
 * (dan wordt één keer opnieuw gevraagd met de foutmelding erbij).
 * `logInput` (optioneel): de blokken [{id, speaker, text}] die naar het model gaan, voor het
 * debug-log (wat heeft het model per blok veranderd).
 */
async function callStep(ctx, step, chunk, { user, refText, isJson = false, validate, logInput }) {
  const { run, meeting, models } = ctx;
  const L = (level, message, data) => log({ runId: run.id, level, step, chunk, message, data });
  const cached = db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND step = ? AND chunk = ? AND status IN ('ok','fallback')").get(run.id, step, chunk);
  if (cached) {
    L('debug', `bewaarde uitvoer hergebruikt (${cached.status})`);
    if (cached.status === 'fallback') return null;
    return validate(cached.output).value;
  }
  const skill = getSkill(STEPS[step].skill);
  const { system, refs, skillChars } = buildPrompt(skill, { meeting, text: refText ?? user });
  const model = models[step] || defaultModel(step);
  L('info', `aanroep ${model} (skill ${skill.naam} v${skill.version})`, {
    model, skill: `${skill.naam} v${skill.version}`, skill_tekens: skillChars, systeemprompt_tekens: system.length,
    invoer_tekens: user.length, invoer_blokken: logInput?.length,
    referenties: refs.map((r) => `${r.ref}: ${r.included ? `${r.chars} tekens, ${r.lines} regels` : 'NIET meegestuurd'}${r.note ? ` (${r.note})` : ''}`),
  });
  for (const r of refs) if (!r.included && r.ref !== 'straten') L('warn', `referentie ${r.ref} niet meegestuurd${r.note ? `: ${r.note}` : ''}`);

  let prompt = user;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await complete({ model, system, user: prompt, json: isJson });
    } catch (e) {
      L('error', `geen antwoord van ${model}: ${e.message}`, { poging: attempt + 1 });
      // Geen antwoord van het model (timeout, netwerk, quota, onbekend model): niet stil de
      // ruwe tekst doorgeven, maar de run laten mislukken zodat hij hervat kan worden.
      throw new Error(`${STEPS[step].label} deel ${chunk + 1} (${model}): ${e.message}`);
    }
    L('info', `antwoord in ${(res.ms / 1000).toFixed(1)} s: ${res.tokensIn} tokens in, ${res.tokensOut} uit, $${(res.cost || 0).toFixed(4)}${res.finishReason && res.finishReason !== 'stop' ? `, finish_reason=${res.finishReason}` : ''}`,
      { model_gebruikt: res.model, poging: attempt + 1, finish_reason: res.finishReason, uitvoer_tekens: res.text.length });
    if (logInput) {
      try { L('info', 'analyse uitvoer', logSummary(analyzeOutput(step, logInput, res.text))); } catch (e) { L('warn', `analyse mislukt: ${e.message}`); }
    }
    const save = (status, warnings) => db.prepare(`INSERT INTO run_steps (run_id, step, chunk, model, system, input, output, tokens_in, tokens_out, cost, ms, status, warnings, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step, chunk) DO UPDATE SET model=excluded.model, system=excluded.system, input=excluded.input, output=excluded.output,
        tokens_in=run_steps.tokens_in+excluded.tokens_in, tokens_out=run_steps.tokens_out+excluded.tokens_out, cost=run_steps.cost+excluded.cost,
        ms=run_steps.ms+excluded.ms, status=excluded.status, warnings=excluded.warnings, attempts=excluded.attempts`)
      .run(run.id, step, chunk, res.model, system, prompt, res.text, res.tokensIn, res.tokensOut, res.cost, res.ms, status, JSON.stringify(warnings || []), attempt + 1);
    try {
      if (res.finishReason === 'length') throw new Error('Antwoord afgekapt (max tokens bereikt)');
      const { value, warnings } = validate(res.text);
      save('ok', warnings);
      if (warnings?.length) L('warn', `validatie: ${warnings.length} waarschuwing(en)`, { warnings });
      else L('debug', 'validatie ok');
      for (const w of warnings || []) addWarning(run.id, `${STEPS[step].label} deel ${chunk + 1}: ${w}`);
      return value;
    } catch (e) {
      lastErr = e;
      save('fout', [e.message]);
      L('warn', `uitvoer afgekeurd (poging ${attempt + 1}): ${e.message}`, { begin_uitvoer: res.text.slice(0, 1500) });
      prompt = `${user}\n\n---\nLET OP: je vorige antwoord was onbruikbaar (${e.message}). Volg het uitvoerformaat van de skill exact en geef alle bloknummers terug.`;
    }
  }
  db.prepare("UPDATE run_steps SET status = 'fallback' WHERE run_id = ? AND step = ? AND chunk = ?").run(run.id, step, chunk);
  L('error', `2 pogingen afgekeurd, invoer van dit deel ongewijzigd doorgegeven: ${lastErr?.message}`);
  addWarning(run.id, `${STEPS[step].label} deel ${chunk + 1} mislukt (${lastErr?.message}); invoer ongewijzigd doorgegeven.`);
  return null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// ---------------- Intake ----------------
async function intake(ctx) {
  const { run, meeting, options } = ctx;
  const existing = db.prepare('SELECT COUNT(*) n FROM run_blocks WHERE run_id = ?').get(run.id).n;
  if (existing) return;
  setProgress(run.id, 'Intake');
  const input = await readInput(meeting.input_file, meeting.input_type);
  let blocks;
  if (input.cues) {
    if (!input.cues.length) throw new Error('Geen ondertitels (cues) gevonden in het bestand.');
    blocks = blocksFromCues(input.cues);
  } else if (options.llmIntake) {
    blocks = await llmIntake(ctx, input.pages);
  } else {
    const r = blocksFromText(input.pages);
    blocks = r.blocks;
    log({ runId: run.id, level: 'debug', step: 'intake', message: `PDF/DOCX: ${input.pages.length} pagina's, ${r.notes.paragraphs} alinea's samengevoegd tot ${r.blocks.length} blokken`, data: { verwijderd: r.notes.removed } });
    if (r.notes.removed.length) addWarning(run.id, `Intake: verwijderd: ${r.notes.removed.slice(0, 5).join(', ')}`);
  }
  if (!blocks.length) throw new Error('Geen tekst gevonden in het invoerbestand (gescande PDF zonder tekstlaag?).');
  const total = blocks.length;
  if (options.blockFrom || options.blockTo) {
    const from = Math.max(1, Number(options.blockFrom) || 1);
    const to = Math.min(total, Number(options.blockTo) || total);
    blocks = blocks.slice(from - 1, to);
    log({ runId: run.id, level: 'info', step: 'intake', message: `testrun: enkel blokken ${from} t/m ${to} van ${total}` });
  }
  const words = blocks.map((b) => wordCount(b.text_raw));
  const labels = [...new Set(blocks.map((b) => b.speaker_raw).filter(Boolean))];
  log({ runId: run.id, level: 'info', step: 'intake', message: `${blocks.length} blokken, ${words.reduce((a, b) => a + b, 0)} woorden (${meeting.input_type}${input.cues ? `, ${input.cues.length} cues` : ''})`, data: {
    blokken: blocks.length, woorden_gemiddeld: Math.round(words.reduce((a, b) => a + b, 0) / blocks.length), woorden_max: Math.max(...words),
    sprekerlabels: labels.slice(0, 50), aantal_sprekerlabels: labels.length, tijdcodes: !!input.cues,
    eerste_blokken: blocks.slice(0, 3).map((b) => `${b.id} | ${b.speaker_raw || '?'} | ${b.text_raw.slice(0, 300)}`),
  } });
  if (!labels.length) log({ runId: run.id, level: 'warn', step: 'intake', message: 'geen sprekerlabels gevonden: speaker-resolver moet alles uit de tekst afleiden' });
  const ins = db.prepare(`INSERT INTO run_blocks (run_id, block_id, ord, t_start, t_end, speaker_raw, text_raw, text_norm, text_clean, text_final)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => blocks.forEach((b, i) => ins.run(run.id, b.id, i, b.t_start, b.t_end, b.speaker_raw, b.text_raw, b.text_raw, b.text_raw, b.text_raw)))();
}

async function llmIntake(ctx, pages) {
  const { lines } = stripPageNoise(pages);
  const text = lines.join('\n');
  // delen op alineagrens van ~12.000 tekens
  const parts = [];
  let cur = '';
  // Ondertitel-PDF's hebben vaak geen lege regels: dan per regel opdelen
  const byPara = text.includes('\n\n');
  const units = byPara ? text.split(/\n\s*\n/) : text.split('\n');
  for (const para of units) {
    if (cur && cur.length + para.length > 12000) { parts.push(cur); cur = ''; }
    cur += para + (byPara ? '\n\n' : '\n');
  }
  if (cur.trim()) parts.push(cur);
  const all = [];
  for (let i = 0; i < parts.length; i++) {
    setProgress(ctx.run.id, `Intake (LLM) deel ${i + 1}/${parts.length}`);
    const blocks = await callStep(ctx, 'intake', i, {
      user: parts[i],
      validate: (out) => {
        const { blocks: b } = parseBlocks(out);
        if (!b.length) throw new Error('geen blokken gevonden');
        return { value: b };
      },
    });
    const list = blocks || [{ speaker: '?', text: parts[i].replace(/\s+/g, ' ') }];
    for (const b of list) all.push({ speaker_raw: b.speaker && b.speaker !== '?' ? b.speaker : null, text_raw: b.text, t_start: null, t_end: null });
  }
  return all.map((b, i) => ({ ...b, id: blockId(i + 1) }));
}

// ---------------- Normalizer + cleaner ----------------
const stepDone = (runId, step, chunk) => !!db.prepare("SELECT 1 FROM run_steps WHERE run_id = ? AND step = ? AND chunk = ? AND status IN ('ok','fallback')").get(runId, step, chunk);
const loadBlocks = (runId, all = false) => db.prepare(`SELECT * FROM run_blocks WHERE run_id = ? ${all ? '' : 'AND merged_into IS NULL'} ORDER BY ord`).all(runId);
const spk = (b) => b.speaker_raw || '?';

export function validateNormalizer(input) {
  return (out) => {
    const { blocks, sections } = parseBlocks(out);
    const map = new Map(blocks.map((b) => [b.id, b]));
    const present = input.filter((b) => map.has(b.block_id)).length;
    if (present < input.length * 0.5) throw new Error(`slechts ${present}/${input.length} blokken teruggegeven`);
    const warnings = [];
    const value = input.map((b) => {
      const o = map.get(b.block_id);
      if (!o) { warnings.push(`${b.block_id} ontbrak, ongewijzigd gelaten`); return b.text_raw; }
      const ratio = wordCount(o.text) / Math.max(1, wordCount(b.text_raw));
      if (ratio < 0.75 || ratio > 1.3) { warnings.push(`${b.block_id} te sterk gewijzigd, ongewijzigd gelaten`); return b.text_raw; }
      return o.text;
    });
    return { value: { texts: value, notes: sections.NOTITIES || '' }, warnings };
  };
}

export function validateCleaner(input) {
  return (out) => {
    const { blocks } = parseBlocks(out);
    const map = new Map(blocks.map((b) => [b.id, b]));
    if (!map.has(input[0].block_id)) throw new Error(`eerste blok ${input[0].block_id} ontbreekt`);
    const inWords = input.reduce((n, b) => n + wordCount(b.text_norm), 0);
    const outWords = blocks.filter((b) => input.some((x) => x.block_id === b.id)).reduce((n, b) => n + wordCount(b.text), 0);
    if (outWords < inWords * 0.6) throw new Error(`te veel tekst verdwenen (${outWords}/${inWords} woorden)`);
    // Groepen: elk ontbrekend blok is samengevoegd met het vorige aanwezige blok
    const groups = [];
    for (const b of input) {
      if (map.has(b.block_id) || !groups.length) groups.push({ head: b, members: [b] });
      else groups[groups.length - 1].members.push(b);
    }
    const warnings = [];
    const value = [];
    for (const g of groups) {
      const o = map.get(g.head.block_id);
      const speakers = new Set(g.members.map(spk).filter((s) => s !== '?'));
      const gWords = g.members.reduce((n, b) => n + wordCount(b.text_norm), 0);
      const bad = !o || speakers.size > 1 || wordCount(o.text) < gWords * 0.5;
      if (bad && g.members.length > 1) {
        if (o && speakers.size > 1) warnings.push(`${g.head.block_id}: blokken van verschillende sprekers samengevoegd, teruggedraaid`);
        for (const m of g.members) value.push({ id: m.block_id, text: m === g.head && o && speakers.size <= 1 ? o.text : m.text_norm, merged: [] });
      } else if (bad) {
        warnings.push(`${g.head.block_id} te sterk ingekort, genormaliseerde tekst behouden`);
        value.push({ id: g.head.block_id, text: g.head.text_norm, merged: [] });
      } else {
        value.push({ id: g.head.block_id, text: o.text, merged: g.members.slice(1).map((m) => m.block_id) });
      }
    }
    return { value, warnings };
  };
}

async function normalizeAndClean(ctx) {
  const { run, options } = ctx;
  const blocks = loadBlocks(run.id, true); // alle blokken, zodat de delen bij hervatten gelijk blijven
  const chunks = chunkBlocks(blocks, options.chunkWords, 'text_raw');
  const total = chunks.length;
  let done = 0;
  await pool(chunks, options.concurrency, async (chunk, ci) => {
    // Al volledig verwerkt (bv. bij hervatten of 'opnieuw vanaf resolver'): niet opnieuw toepassen,
    // anders gaan manuele aanpassingen verloren.
    if (stepDone(run.id, 'cleaner', ci) || (ctx.options.skipCleaner && stepDone(run.id, 'normalizer', ci))) { done++; return; }
    // Normalizer
    const normIn = chunk.map((b) => ({ id: b.block_id, speaker: spk(b), text: b.text_raw }));
    const norm = await callStep(ctx, 'normalizer', ci, {
      user: serializeBlocks(normIn),
      logInput: normIn,
      validate: validateNormalizer(chunk),
    });
    if (norm) {
      const upd = db.prepare('UPDATE run_blocks SET text_norm = ?, text_clean = ?, text_final = ? WHERE run_id = ? AND block_id = ?');
      db.transaction(() => chunk.forEach((b, i) => { b.text_norm = norm.texts[i]; upd.run(b.text_norm, b.text_norm, b.text_norm, run.id, b.block_id); }))();
      harvestNormalizerNotes(ctx, norm.notes);
    }
    if (ctx.options.skipCleaner) { done++; setProgress(run.id, `Normaliseren: ${done}/${total} delen`); return; }
    // Cleaner
    const cleanIn = chunk.map((b) => ({ id: b.block_id, speaker: spk(b), text: b.text_norm }));
    const clean = await callStep(ctx, 'cleaner', ci, {
      user: serializeBlocks(cleanIn),
      logInput: cleanIn,
      validate: validateCleaner(chunk),
    });
    if (clean) applyClean(run.id, chunk, clean);
    done++;
    setProgress(run.id, `Normaliseren en opschonen: ${done}/${total} delen`);
  });
}

function applyClean(runId, chunk, clean) {
  const byId = new Map(chunk.map((b) => [b.block_id, b]));
  const upd = db.prepare('UPDATE run_blocks SET text_clean = ?, text_final = ?, t_end = COALESCE(?, t_end) WHERE run_id = ? AND block_id = ?');
  const del = db.prepare('UPDATE run_blocks SET merged_into = ? WHERE run_id = ? AND block_id = ?');
  db.transaction(() => {
    for (const c of clean) {
      const ends = c.merged.map((id) => byId.get(id)?.t_end).filter((x) => x != null);
      upd.run(c.text, c.text, ends.length ? Math.max(...ends) : null, runId, c.id);
      for (const id of c.merged) del.run(c.id, runId, id);
    }
  })();
}

/** "- vervorming -> correct (categorie)" onder "Nieuwe vervormingen" → termvoorstellen */
function harvestNormalizerNotes(ctx, notes) {
  if (getSetting('harvest_normalizer', '1') !== '1') return;
  const m = String(notes).split(/Nieuwe vervormingen[^\n]*\n/i)[1];
  if (!m) return;
  for (const line of m.split('\n')) {
    const r = line.match(/^\s*-\s*(.+?)\s*->\s*(.+?)\s*(?:\((\w+)\))?\s*$/);
    if (r) {
      addTermProposal({ varianten: r[1].replace(/^B\d+:\s*/, ''), correct: r[2], categorie: r[3] || 'naam_fout', bron: 'normalizer', meetingId: ctx.meeting.id });
      log({ runId: ctx.run.id, level: 'info', step: 'normalizer', message: `termvoorstel: ${r[1]} -> ${r[2]} (${r[3] || 'naam_fout'})` });
    }
  }
}

// ---------------- Resolver ----------------
async function resolve(ctx) {
  const { run, options } = ctx;
  const blocks = loadBlocks(run.id);
  const chunks = chunkBlocks(blocks, options.chunkWords, 'text_clean');
  let table = '';
  const upd = db.prepare('UPDATE run_blocks SET speaker_name = ?, fractie = ?, functie = ?, zekerheid = ? WHERE run_id = ? AND block_id = ?');
  for (let ci = 0; ci < chunks.length; ci++) {
    setProgress(run.id, `Sprekers koppelen: deel ${ci + 1}/${chunks.length}`);
    const chunk = chunks[ci];
    const already = stepDone(run.id, 'resolver', ci);
    const resIn = chunk.map((b) => ({ id: b.block_id, speaker: spk(b), text: b.text_clean }));
    const body = serializeBlocks(resIn);
    const res = await callStep(ctx, 'resolver', ci, {
      user: table ? `## SPREKERTABEL (vorig deel)\n${table}\n\n${body}` : body,
      logInput: resIn,
      refText: body,
      validate: (out) => {
        const { blocks: heads, sections } = parseBlocks(out);
        const map = new Map(heads.map((h) => [h.id, h]));
        const present = chunk.filter((b) => map.has(b.block_id)).length;
        if (present < chunk.length * 0.7) throw new Error(`slechts ${present}/${chunk.length} sprekerkoppen teruggegeven`);
        const warnings = present < chunk.length ? [`${chunk.length - present} blokken zonder sprekerkop`] : [];
        return { value: { map, table: sections.SPREKERTABEL || '' }, warnings };
      },
    });
    if (!already) db.transaction(() => {
      for (const b of chunk) {
        const h = res?.map.get(b.block_id);
        const s = h ? parseSpeakerHeader(h.speaker) : { speaker_name: b.speaker_raw || 'Onbekende spreker', fractie: null, functie: null, zekerheid: 'laag' };
        upd.run(s.speaker_name, s.fractie, s.functie, s.zekerheid, run.id, b.block_id);
      }
    })();
    if (res?.table) table = res.table;
  }
  const dist = db.prepare('SELECT zekerheid, COUNT(*) n FROM run_blocks WHERE run_id = ? AND merged_into IS NULL GROUP BY zekerheid').all(run.id);
  const top = db.prepare('SELECT speaker_name, COUNT(*) n FROM run_blocks WHERE run_id = ? AND merged_into IS NULL GROUP BY speaker_name ORDER BY n DESC LIMIT 25').all(run.id);
  log({ runId: run.id, level: 'info', step: 'resolver', message: `sprekers toegewezen: ${dist.map((d) => `${d.zekerheid || '?'}=${d.n}`).join(', ')}`,
    data: { sprekers: top.map((s) => `${s.speaker_name} (${s.n})`), laatste_sprekertabel: table.slice(0, 3000) } });
}

// ---------------- Writer ----------------
const header = (b) => [b.speaker_name || 'Onbekende spreker', b.fractie || '-', b.functie || '-', `zekerheid: ${b.zekerheid || 'laag'}`].join(' | ');

async function write(ctx) {
  const { run, meeting, options } = ctx;
  const blocks = loadBlocks(run.id);
  const points = [];
  const pointOf = new Map();
  const assign = (from, to, idx) => { for (let i = from; i < to; i++) pointOf.set(blocks[i].block_id, idx); };

  if (!options.writer) {
    points.push({ type: 'overig', nummer: '', titel: 'Transcript', samenvatting: '', beslissingen: [] });
    assign(0, blocks.length, 0);
  } else {
    const chunks = chunkBlocks(blocks, Math.round(options.chunkWords * 1.5), 'text_clean');
    let offset = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      setProgress(run.id, `Verslagstructuur: deel ${ci + 1}/${chunks.length}`);
      const chunk = chunks[ci];
      const prev = points[points.length - 1];
      const ids = chunk.map((b) => b.block_id);
      const res = await callStep(ctx, 'writer', ci, {
        user: `MODUS: PUNTEN\nVORIG PUNT: ${prev ? `${prev.nummer ? `punt ${prev.nummer}: ` : ''}${prev.titel}` : 'geen (begin van de vergadering)'}\n\n${serializeBlocks(chunk.map((b) => ({ id: b.block_id, speaker: header(b), text: b.text_clean })))}`,
        isJson: true,
        validate: (out) => {
          const j = parseJsonLoose(out);
          const list = (j.punten || []).filter((p) => ids.includes(String(p.start).toUpperCase()))
            .map((p) => ({ ...p, start: String(p.start).toUpperCase() }))
            .sort((a, b) => blockNum(a.start) - blockNum(b.start));
          if (!list.length) throw new Error('geen geldige punten (start moet een bloknummer uit de invoer zijn)');
          return { value: list };
        },
      }) || [{ start: ids[0], vervolg: !!prev, type: 'agendapunt', nummer: prev?.nummer || '', titel: prev?.titel || 'Bespreking', samenvatting: '', beslissingen: [] }];
      if (res[0].start !== ids[0]) res.unshift({ start: ids[0], vervolg: !!prev, nummer: prev?.nummer, titel: prev?.titel || 'Opening' });
      res.forEach((p, k) => {
        const from = offset + ids.indexOf(p.start);
        const to = k + 1 < res.length ? offset + ids.indexOf(res[k + 1].start) : offset + ids.length;
        const last = points[points.length - 1];
        const same = last && (p.vervolg || (p.nummer && String(p.nummer) === String(last.nummer) && k === 0));
        if (same) {
          if (p.samenvatting && p.samenvatting !== last.samenvatting && !p.vervolg) last.samenvatting = `${last.samenvatting} ${p.samenvatting}`.trim();
          last.beslissingen.push(...(p.beslissingen || []));
          assign(from, to, points.length - 1);
        } else {
          points.push({ type: p.type || 'agendapunt', nummer: p.nummer ? String(p.nummer) : '', titel: p.titel || 'Bespreking', samenvatting: p.samenvatting || '', beslissingen: [...(p.beslissingen || [])] });
          assign(from, to, points.length - 1);
        }
      });
      offset += ids.length;
    }
  }

  const upd = db.prepare('UPDATE run_blocks SET point_idx = ? WHERE run_id = ? AND block_id = ?');
  db.transaction(() => blocks.forEach((b) => upd.run(pointOf.get(b.block_id) ?? 0, run.id, b.block_id)))();

  const low = blocks.filter((b) => b.zekerheid === 'laag' || /onbekend/i.test(b.speaker_name || '')).length;
  const lowPct = Math.round((100 * low) / Math.max(1, blocks.length));
  const report = {
    titel: meeting.titel || defaultTitle(meeting),
    samenvatting: '',
    punten: points,
    waarschuwingen: [],
    stats: { blokken: blocks.length, laag_pct: lowPct },
  };
  if (options.writer) {
    setProgress(run.id, 'Samenvatting');
    const runWarnings = json(db.prepare('SELECT warnings FROM runs WHERE id = ?').get(run.id).warnings, []);
    const slot = await callStep(ctx, 'writer', 999, {
      user: `MODUS: SLOT\n\nPUNTEN:\n${points.map((p) => `- ${p.nummer ? `Punt ${p.nummer}: ` : ''}${p.titel} — ${p.samenvatting}${p.beslissingen.length ? ` Beslissingen: ${p.beslissingen.join(' ')}` : ''}`).join('\n')}\n\nSTATISTIEK: ${blocks.length} blokken, ${lowPct}% met zekerheid laag of onbekende spreker.\n\nTWIJFELGEVALLEN EERDERE STAPPEN:\n${runWarnings.slice(0, 30).join('\n') || 'geen'}`,
      refText: '',
      isJson: true,
      validate: (out) => ({ value: parseJsonLoose(out) }),
    });
    if (slot) {
      report.titel = slot.titel || report.titel;
      report.samenvatting = slot.samenvatting || '';
      report.waarschuwingen = slot.waarschuwingen || [];
    }
  }
  if (lowPct > 20 && !report.waarschuwingen.some((w) => /Sprekertoewijzing/i.test(w))) {
    report.waarschuwingen.unshift('Sprekertoewijzing gebaseerd op contextanalyse. Verifieer de namen voor verspreiding.');
  }
  db.prepare('UPDATE runs SET report = ? WHERE id = ?').run(JSON.stringify(report), run.id);
  log({ runId: run.id, level: 'info', step: 'writer', message: `${points.length} punt(en) in het verslag, ${lowPct}% blokken met lage zekerheid`,
    data: { punten: points.map((p) => `${p.nummer ? `${p.nummer}: ` : ''}${p.titel}`), waarschuwingen: report.waarschuwingen } });
}

export function defaultTitle(m) {
  const orgaan = m.orgaan === 'commissie' ? `Commissie ${m.commissie || ''}`.trim() : 'Gemeenteraad';
  return `Verslag ${orgaan}${m.datum ? ` ${m.datum}` : ''}`;
}

// ---------------- Run ----------------
export const STOP_STEPS = ['normalizer', 'cleaner', 'resolver', 'writer'];

export async function runPipeline(runId) {
  runId = Number(runId);
  if (active.has(runId)) return;
  active.add(runId);
  const t0 = Date.now();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(run.meeting_id);
  const opt = json(run.options, {});
  const stopAfter = STOP_STEPS.includes(opt.stopAfter) ? opt.stopAfter : 'writer';
  const options = {
    chunkWords: Number(opt.chunkWords) >= 200 ? Number(opt.chunkWords) : getNumberSetting('chunk_words', 2000, 200, 20000),
    concurrency: Number(opt.concurrency) >= 1 ? Number(opt.concurrency) : getNumberSetting('concurrency', 3, 1, 10),
    writer: opt.writer !== false && stopAfter === 'writer',
    llmIntake: !!opt.llmIntake,
    blockFrom: Number(opt.blockFrom) || null,
    blockTo: Number(opt.blockTo) || null,
    skipCleaner: stopAfter === 'normalizer',
    stopAfter,
  };
  const models = {};
  for (const step of ['intake', 'normalizer', 'cleaner', 'resolver', 'writer']) models[step] = opt.models?.[step] || defaultModel(step);
  const versions = Object.fromEntries(db.prepare('SELECT naam, version FROM skills').all().map((s) => [s.naam, s.version]));
  db.prepare("UPDATE runs SET status = 'bezig', error = NULL, started_at = COALESCE(started_at, datetime('now')), options = ?, skill_versions = COALESCE(skill_versions, ?) WHERE id = ?")
    .run(JSON.stringify({ ...opt, ...options, models }), JSON.stringify(versions), runId);
  const ctx = { run, meeting, options, models };
  log({ runId, level: 'info', message: `start run ${runId}: ${meeting.input_name} (${meeting.input_type})${stopAfter !== 'writer' ? `, stopt na ${stopAfter}` : ''}`, data: {
    vergadering: { orgaan: meeting.orgaan, commissie: meeting.commissie, datum: meeting.datum, voorzitter: meeting.voorzitter, agenda: meeting.agenda_name ? `${meeting.agenda_name} (${meeting.agenda_status})` : null },
    opties: options, modellen: models, skillversies: versions,
  } });
  const phase = async (name, fn) => {
    const ts = Date.now();
    log({ runId, level: 'info', step: name, message: `fase ${name} gestart` });
    await fn();
    log({ runId, level: 'info', step: name, message: `fase ${name} klaar in ${((Date.now() - ts) / 1000).toFixed(1)} s` });
  };
  try {
    await phase('intake', () => intake(ctx));
    await phase(options.skipCleaner ? 'normalizer' : 'normalizer+cleaner', () => normalizeAndClean(ctx));
    if (['resolver', 'writer'].includes(stopAfter)) await phase('resolver', () => resolve(ctx));
    else log({ runId, level: 'info', message: 'speaker-resolver overgeslagen (testrun)' });
    await phase('writer', () => write(ctx));
    totals(runId);
    const r = db.prepare('SELECT cost, tokens_in, tokens_out FROM runs WHERE id = ?').get(runId);
    log({ runId, level: 'info', message: `run klaar in ${((Date.now() - t0) / 1000).toFixed(0)} s, $${(r.cost || 0).toFixed(4)}, ${r.tokens_in} tokens in / ${r.tokens_out} uit` });
    db.prepare("UPDATE runs SET status = 'klaar', progress = 'Klaar', finished_at = datetime('now') WHERE id = ?").run(runId);
  } catch (e) {
    log({ runId, level: 'error', message: `run mislukt: ${e.message}`, data: { stack: e.stack?.split('\n').slice(0, 6) } });
    totals(runId);
    db.prepare("UPDATE runs SET status = 'fout', error = ?, finished_at = datetime('now') WHERE id = ?").run(e.message, runId);
  } finally {
    active.delete(runId);
  }
}

function totals(runId) {
  const t = db.prepare('SELECT SUM(cost) c, SUM(tokens_in) i, SUM(tokens_out) o FROM run_steps WHERE run_id = ?').get(runId);
  db.prepare('UPDATE runs SET cost = ?, tokens_in = ?, tokens_out = ? WHERE id = ?').run(t.c || 0, t.i || 0, t.o || 0, runId);
}

/** Na een herstart van de server: onderbroken runs als fout markeren (hervatten kan via de UI). */
export function markInterrupted() {
  db.prepare("UPDATE runs SET status = 'fout', error = 'Onderbroken (server herstart). Klik op Hervatten.' WHERE status = 'bezig'").run();
}

// ---------------- Agenda ----------------
export async function processAgenda(meetingId, model, runId = null) {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  db.prepare("UPDATE meetings SET agenda_status = 'bezig' WHERE id = ?").run(meetingId);
  try {
    const text = meeting.agenda_text || '';
    const parts = [];
    for (let i = 0; i < text.length; i += 24000) parts.push(text.slice(i, i + 24000));
    const skill = getSkill('agenda-extractor');
    const system = buildSystemPrompt(skill, { meeting });
    const merged = { vergadering: {}, punten: [], context: [] };
    log({ runId, level: 'info', step: 'agenda', message: `agenda uitlezen: ${text.length} tekens in ${parts.length} deel/delen` });
    for (const [pi, part] of parts.entries()) {
      const res = await complete({ model: model || defaultModel('agenda'), system, user: part, json: true });
      log({ runId, level: 'info', step: 'agenda', chunk: pi, message: `antwoord ${res.model} in ${(res.ms / 1000).toFixed(1)} s, ${res.tokensIn}/${res.tokensOut} tokens, $${(res.cost || 0).toFixed(4)}` });
      const j = parseJsonLoose(res.text);
      for (const [k, v] of Object.entries(j.vergadering || {})) if (v && !merged.vergadering[k]) merged.vergadering[k] = v;
      for (const p of j.punten || []) {
        if (!merged.punten.some((x) => x.nummer && x.nummer === p.nummer && x.titel === p.titel)) merged.punten.push(p);
      }
      for (const c of j.context || []) {
        if (c.correct && !merged.context.some((x) => x.correct.toLowerCase() === c.correct.toLowerCase())) merged.context.push(c);
      }
    }
    const v = merged.vergadering;
    db.prepare(`UPDATE meetings SET agenda_json = ?, agenda_status = 'klaar',
      orgaan = CASE WHEN ? != '' THEN ? ELSE orgaan END,
      commissie = COALESCE(NULLIF(commissie, ''), NULLIF(?, '')),
      datum = COALESCE(NULLIF(datum, ''), NULLIF(?, '')),
      voorzitter = COALESCE(NULLIF(voorzitter, ''), NULLIF(?, ''))
      WHERE id = ?`).run(JSON.stringify(merged), meeting.orgaan ? '' : (v.orgaan || ''), v.orgaan || '', v.commissie || '', v.datum || '', v.voorzitter || '', meetingId);
    for (const c of merged.context) {
      addTermProposal({ categorie: c.categorie || 'project', correct: c.correct, varianten: '', toelichting: c.toelichting, bron: 'agenda', meetingId });
    }
    log({ runId, level: 'info', step: 'agenda', message: `${merged.punten.length} agendapunten, ${merged.context.length} contextitems`, data: {
      vergadering: merged.vergadering, punten: merged.punten.map((p) => `${p.nummer}: ${p.titel}`), context: merged.context.map((c) => c.correct) } });
    return merged;
  } catch (e) {
    log({ runId, level: 'error', step: 'agenda', message: `agenda mislukt: ${e.message}` });
    db.prepare("UPDATE meetings SET agenda_status = 'fout' WHERE id = ?").run(meetingId);
    throw e;
  }
}

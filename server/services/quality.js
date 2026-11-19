// Kwaliteitsscore (0-100) voor een test in de Testbank. Drie pijlers:
//  - automatisch (gratis, altijd): structuur, trouw aan de bron, namen/termen uit de referentielijsten
//  - referentie (als er een geverifieerd eindresultaat is): woordgelijkenis + namen t.o.v. de referentie
//  - judge (optioneel, kost tokens): een rechtermodel scoort 1-5 per criterium
// Eindscore = gewogen gemiddelde van de beschikbare pijlers (ontbrekende worden herverdeeld).
import { diffArrays } from 'diff';
import { db, json } from '../db.js';
import { STEPS } from '../config.js';
import { parseBlocks, wordCount } from './blockfmt.js';
import { parseJsonLoose, complete, defaultModel } from './openrouter.js';
import { buildPrompt } from './context.js';
import { log } from './logger.js';

export const PILLAR_WEIGHTS = { auto: 0.3, gold: 0.4, judge: 0.3 };
const AUTO_WEIGHTS = { structuur: 0.25, trouw: 0.25, namen: 0.5 };
// Verwachte verhouding woorden uit/in per skill
const WORD_BANDS = { normalizer: [0.95, 1.05], cleaner: [0.7, 1.0], intake: [0.9, 1.05] };
export const JUDGE_CRITERIA = ['namen', 'terminologie', 'trouw', 'opschoning'];

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Gekende namen en termen (met STT-vervormingen) ----------
function entities() {
  const list = [];
  const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 4);
  // Een raadslid mag ook enkel met de achternaam genoemd worden (match_namen)
  for (const m of db.prepare('SELECT naam, match_namen, varianten FROM members WHERE actief = 1').all()) {
    list.push({ kind: 'lid', correct: m.naam, forms: [m.naam, ...String(m.match_namen || '').split('/').map((x) => x.trim()).filter((x) => x.length >= 4)], variants: split(m.varianten) });
  }
  for (const s of db.prepare("SELECT naam, varianten FROM streets WHERE varianten IS NOT NULL AND varianten != ''").all()) list.push({ kind: 'straat', correct: s.naam, variants: split(s.varianten) });
  for (const t of db.prepare("SELECT correct, varianten FROM terms WHERE status = 'actief' AND categorie != 'richtlijn'").all()) {
    if (String(t.correct).length >= 4) list.push({ kind: 'term', correct: t.correct, variants: split(t.varianten) });
  }
  for (const e of list) {
    e.forms = [...new Set(e.forms || [e.correct])].sort((a, b) => b.length - a.length);
    const lower = new Set(e.forms.map((f) => f.toLowerCase()));
    e.variants = e.variants.filter((v) => !lower.has(v.toLowerCase()));
  }
  return list;
}

const reCache = new Map();
function phraseRe(p) {
  let re = reCache.get(p);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(p).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    if (reCache.size > 20000) reCache.clear();
    reCache.set(p, re);
  }
  re.lastIndex = 0;
  return re;
}
const countIn = (text, p) => (String(text).match(phraseRe(p)) || []).length;
const without = (text, p) => String(text).replace(phraseRe(p), ' ');

/** Telt per entiteit de correcte vorm en de gekende vervormingen in een tekst. */
function entityCounts(ents, text) {
  return ents.map((e) => {
    // Correcte vormen, langste eerst ("Sven Taeldeman" telt niet ook nog als "Taeldeman")
    let rest = String(text);
    let c = 0;
    for (const f of e.forms) {
      const k = countIn(rest, f);
      if (k) { c += k; rest = without(rest, f); }
    }
    if (!e.variants.length) return { c, v: 0, vs: [] };
    // rest: zonder de correcte vormen, zodat een vervorming die deel is van de correcte naam niet meetelt
    const vs = e.variants.map((v) => [v, countIn(rest, v)]).filter(([, n]) => n);
    return { c, v: vs.reduce((n, [, k]) => n + k, 0), vs };
  });
}

// ---------- Pijler 1: automatisch ----------
function bandScore(ratio, [lo, hi]) {
  if (ratio >= lo && ratio <= hi) return 100;
  const d = ratio < lo ? lo - ratio : ratio - hi;
  return clamp(100 - (d / 0.25) * 100);
}

function namesFromLists(step, inputText, outputText) {
  const ents = entities();
  const A = entityCounts(ents, inputText);
  const B = entityCounts(ents, outputText);
  const ex = { verbeterd: [], gemist: [], verdwenen: [], toegevoegd: [] };
  let fixed = 0; let remaining = 0; let lost = 0; let introduced = 0;
  const json = step === 'writer' || step === 'agenda';
  ents.forEach((e, i) => {
    const a = A[i]; const b = B[i];
    if (!a.c && !a.v && !b.c && !b.v) return;
    if (json) {
      if (b.v) { remaining += b.v; ex.gemist.push(`${b.vs.map(([v]) => v).join(', ')} (→ ${e.correct})`); }
      if (e.kind === 'lid' && b.c && !a.c && !a.v) { introduced += 1; ex.toegevoegd.push(e.correct); }
      return;
    }
    const f = Math.max(0, Math.min(a.v - b.v, b.c - a.c));
    const r = Math.min(a.v, b.v);
    const l = Math.max(0, a.c - b.c);
    const n = Math.max(0, (b.c - a.c) - Math.max(0, a.v - b.v));
    fixed += f; remaining += r; lost += l; introduced += n;
    if (f) ex.verbeterd.push(`${a.vs.map(([v]) => v).join(', ')} → ${e.correct}${f > 1 ? ` ×${f}` : ''}`);
    if (r) ex.gemist.push(`${b.vs.map(([v]) => v).join(', ')} (→ ${e.correct})${r > 1 ? ` ×${r}` : ''}`);
    if (l) ex.verdwenen.push(`${e.correct}${l > 1 ? ` ×${l}` : ''}`);
    if (n) ex.toegevoegd.push(`${e.correct}${n > 1 ? ` ×${n}` : ''}`);
  });
  for (const k of Object.keys(ex)) ex[k] = ex[k].slice(0, 30);
  const counts = { verbeterd: fixed, gemist: remaining, verdwenen: lost, toegevoegd: introduced };
  let score = null;
  if (json) {
    const errors = remaining + 0.5 * introduced;
    score = errors || B.some((b) => b.c) ? clamp(100 - 15 * errors) : null;
  } else if (step === 'cleaner') {
    // Namen verbeteren is niet de taak van de cleaner; wel: niets verknoeien
    const errors = lost + 0.5 * introduced;
    score = errors || A.some((a) => a.c) ? clamp(100 - 20 * errors) : null;
  } else {
    const denom = fixed + remaining + lost + 0.5 * introduced;
    score = denom ? (100 * fixed) / denom : null;
  }
  return { score, counts, voorbeelden: ex };
}

/**
 * step, inputText (gebruikersbericht), inputBlocks [{id, speaker, text}], output, analysis, validation, finishReason
 * → { score, parts: [{ key, label, score, weight, detail }] }
 */
export function autoScore({ step, inputText, inputBlocks, output, analysis, validation, finishReason }) {
  const parts = [];
  const add = (key, label, score, detail) => parts.push({ key, label, score: round(score), weight: AUTO_WEIGHTS[key], detail });
  const truncated = finishReason && finishReason !== 'stop';
  const a = analysis;

  if (a?.kind === 'blocks') {
    const s = a.stats;
    const intake = step === 'intake' || !inputBlocks.length;
    let structuur;
    let detail;
    if (validation && !validation.ok) { structuur = 0; detail = `afgekeurd door de pipeline: ${validation.error}`; }
    else if (intake) { structuur = s.out ? 100 : 0; detail = `${s.out} blokken`; }
    else {
      const missing = s.ontbreekt + (step === 'cleaner' ? 0 : s.samengevoegd);
      const warn = validation?.warnings?.length || 0;
      structuur = (100 * (s.in - missing)) / Math.max(1, s.in) - Math.min(30, 10 * s.extra) - Math.min(40, 5 * warn);
      detail = `${s.in - missing}/${s.in} blokken terug${s.extra ? `, ${s.extra} extra` : ''}${warn ? `, ${warn} waarschuwing(en)` : ''}`;
    }
    if (truncated) { structuur -= 30; detail += `, afgekapt (${finishReason})`; }
    add('structuur', 'Structuur', clamp(structuur), detail);

    const wIn = intake ? wordCount(inputText) : s.woorden_in;
    const wOut = intake ? parseBlocks(output).blocks.reduce((n, b) => n + wordCount(b.text), 0) : s.woorden_uit;
    const ratio = wOut / Math.max(1, wIn);
    add('trouw', 'Trouw aan de bron', bandScore(ratio, WORD_BANDS[step] || [0.9, 1.05]), `woorden ${wIn} → ${wOut} (${Math.round(ratio * 100)}%, verwacht ${(WORD_BANDS[step] || [0.9, 1.05]).map((x) => `${Math.round(x * 100)}%`).join('–')})`);
  } else if (a?.kind === 'resolver') {
    const s = a.stats;
    let structuur = (100 * (s.in - s.ontbreekt)) / Math.max(1, s.in) - Math.min(30, 10 * s.extra);
    if (truncated) structuur -= 30;
    add('structuur', 'Structuur', clamp(structuur), `${s.in - s.ontbreekt}/${s.in} blokken met sprekerkop${truncated ? `, afgekapt (${finishReason})` : ''}`);
    const W = { hoog: 100, middel: 70, laag: 40 };
    const z = a.blocks.map((b) => (b.status === 'ok' ? W[b.zekerheid] ?? 40 : 0));
    add('trouw', 'Zekerheid', z.reduce((n, x) => n + x, 0) / Math.max(1, z.length), Object.entries(s.zekerheid || {}).map(([k, v]) => `${k}: ${v}`).join(' · '));
    const known = new Set(db.prepare('SELECT lower(naam) n FROM members').all().map((r) => r.n));
    const named = a.blocks.filter((b) => b.status === 'ok');
    const pts = named.map((b) => (known.has(String(b.speaker_name).toLowerCase()) ? 100 : /onbekend/i.test(b.speaker_name) ? 50 : 0));
    const unknown = [...new Set(named.filter((b) => !known.has(String(b.speaker_name).toLowerCase()) && !/onbekend/i.test(b.speaker_name)).map((b) => b.speaker_name))];
    add('namen', 'Namen', pts.length ? pts.reduce((n, x) => n + x, 0) / pts.length : null,
      `${pts.filter((x) => x === 100).length}/${pts.length} sprekers uit de ledenlijst${unknown.length ? `; niet in de lijst: ${unknown.slice(0, 10).join(', ')}` : ''}`);
    return finish(parts);
  } else if (a?.kind === 'json') {
    add('structuur', 'Structuur', a.error ? 0 : truncated ? 50 : step === 'writer' && !a.stats?.punten ? 50 : 100, a.error ? `geen geldige JSON: ${a.error}` : `${a.stats?.punten ?? 0} punten`);
  } else {
    add('structuur', 'Structuur', output ? (truncated ? 50 : 100) : 0, output ? '' : 'geen uitvoer');
  }

  const names = namesFromLists(step, inputText, output);
  const c = names.counts;
  add('namen', 'Namen en termen', names.score,
    names.score == null ? 'geen gekende namen of vervormingen in de tekst' : `${c.verbeterd} verbeterd, ${c.gemist} gemist, ${c.verdwenen} verdwenen, ${c.toegevoegd} toegevoegd`);
  parts[parts.length - 1].voorbeelden = names.voorbeelden;
  return finish(parts);
}

function finish(parts) {
  return { score: round(weighted(parts.map((p) => [p.score, p.weight]))), parts };
}

function weighted(pairs) {
  const ok = pairs.filter(([s]) => s != null && Number.isFinite(s));
  const w = ok.reduce((n, [, x]) => n + x, 0);
  return w ? ok.reduce((n, [s, x]) => n + s * x, 0) / w : null;
}

// ---------- Pijler 2: geverifieerd eindresultaat (gold reference) ----------
const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const words = (t) => String(t).split(/\s+/).map(normWord).filter(Boolean);

/** Tekst van de uitvoer zonder notities; voor JSON-stappen alle tekstvelden. */
function outputText(step, output) {
  if (step === 'writer' || step === 'agenda') {
    try {
      const vals = [];
      const walk = (x) => { if (typeof x === 'string') vals.push(x); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
      walk(parseJsonLoose(output));
      return vals.join(' ');
    } catch { return output; }
  }
  const { blocks } = parseBlocks(output);
  return blocks.length ? blocks.map((b) => b.text).join(' ') : output;
}

function similarity(a, b) {
  if (!a.length && !b.length) return { sim: 1, common: [] };
  let same = 0;
  const parts = diffArrays(a, b);
  for (const p of parts) if (!p.added && !p.removed) same += p.count ?? p.value.length;
  return { sim: (2 * same) / (a.length + b.length), parts };
}

/** Het stuk van een lange referentietekst dat het best bij `target` (woorden) past. */
function alignWindow(goldWords, target) {
  const n = 4;
  if (goldWords.length <= target.length * 1.2 || target.length < n) return [0, goldWords.length];
  const grams = new Set();
  for (let i = 0; i + n <= target.length; i++) grams.add(target.slice(i, i + n).join(' '));
  const hit = new Int32Array(goldWords.length + 1);
  for (let i = 0; i + n <= goldWords.length; i++) hit[i + 1] = hit[i] + (grams.has(goldWords.slice(i, i + n).join(' ')) ? 1 : 0);
  for (let i = Math.max(0, goldWords.length - n + 1); i < goldWords.length; i++) hit[i + 1] = hit[i];
  const L = Math.min(goldWords.length, Math.round(target.length * 1.15));
  let best = 0; let at = 0;
  for (let i = 0; i + L <= goldWords.length; i++) {
    const h = hit[i + L] - hit[i];
    if (h > best) { best = h; at = i; }
  }
  if (!best) return null;
  // Venster wat ruimer nemen en daarna bijsnijden tot de eerste/laatste gemeenschappelijke woorden
  const from = Math.max(0, at - Math.round(L * 0.15));
  const to = Math.min(goldWords.length, at + L + Math.round(L * 0.15));
  const parts = diffArrays(goldWords.slice(from, to), target);
  let pos = 0; let first = null; let last = null;
  for (const p of parts) {
    const k = p.count ?? p.value.length;
    if (p.added) continue;
    if (!p.removed && k >= 2) { if (first == null) first = pos; last = pos + k; }
    pos += k;
  }
  return first == null ? [from, to] : [from + first, from + last];
}

/**
 * Vergelijkt de uitvoer met een geverifieerd eindresultaat.
 * Blokformaat in de referentie → per blok-ID; anders het best passende stuk tekst.
 */
export function goldScore({ step, inputText, inputBlocks, output, goldText }) {
  if (!goldText || !output) return null;
  const goldParsed = parseBlocks(goldText);
  const ids = new Set(inputBlocks.map((b) => b.id));
  let goldPart;
  let method;
  let speakers = null;
  if (goldParsed.blocks.length && inputBlocks.length && goldParsed.blocks.some((b) => ids.has(b.id))) {
    const sel = goldParsed.blocks.filter((b) => ids.has(b.id));
    goldPart = sel.map((b) => b.text).join(' ');
    method = `per blok (${sel.length} blokken uit de referentie)`;
    if (step === 'resolver') {
      const out = new Map(parseBlocks(output).blocks.map((b) => [b.id, b.speaker.split('|')[0].trim().toLowerCase()]));
      const pairs = sel.map((g) => [g.speaker.split('|')[0].trim().toLowerCase(), out.get(g.id)]).filter(([g]) => g && g !== '?');
      if (pairs.length) speakers = { juist: pairs.filter(([g, o]) => g === o).length, totaal: pairs.length };
    }
  } else {
    const gw = String(goldText).split(/\s+/).filter(Boolean);
    const gwn = gw.map(normWord);
    const target = words(step === 'resolver' ? inputText : outputText(step, output));
    const win = alignWindow(gwn, target);
    if (!win) return { score: null, method: 'geen overeenkomend stuk gevonden in de referentie', parts: [] };
    goldPart = gw.slice(win[0], win[1]).join(' ');
    method = `woorden ${win[0] + 1}–${win[1]} van ${gw.length} in de referentie`;
  }

  const parts = [];
  if (speakers) {
    parts.push({ key: 'sprekers', label: 'Sprekers zoals referentie', score: round((100 * speakers.juist) / speakers.totaal), weight: 1, detail: `${speakers.juist}/${speakers.totaal} blokken juiste spreker` });
  } else if (step !== 'resolver') {
    const outW = words(outputText(step, output));
    const goldW = words(goldPart);
    const out = similarity(goldW, outW);
    const inp = inputText ? similarity(goldW, words(inputBlocks.length ? inputBlocks.map((b) => b.text).join(' ') : inputText)) : null;
    parts.push({
      key: 'tekst', label: 'Gelijkenis met referentie', score: round(out.sim * 100), weight: 0.6,
      detail: `${Math.round(out.sim * 100)}% gelijk${inp ? ` (invoer was ${Math.round(inp.sim * 100)}%)` : ''}`,
      invoer: inp ? round(inp.sim * 100) : null,
    });
    // Namen en termen: wat in de referentie staat, moet ook (zo vaak) in de uitvoer staan
    const ents = entities();
    const G = entityCounts(ents, goldPart);
    const O = entityCounts(ents, outputText(step, output));
    let tp = 0; let fn = 0; let fp = 0;
    const ex = { ontbreekt: [], extra: [] };
    ents.forEach((e, i) => {
      const g = G[i].c; const o = O[i].c;
      if (!g && !o) return;
      tp += Math.min(g, o);
      if (g > o) { fn += g - o; ex.ontbreekt.push(e.correct); }
      if (o > g) { fp += o - g; ex.extra.push(e.correct); }
    });
    if (tp + fn + fp) {
      const f1 = (2 * tp) / (2 * tp + fn + fp);
      parts.push({ key: 'namen', label: 'Namen zoals referentie', score: round(f1 * 100), weight: 0.4, detail: `${tp} juist, ${fn} ontbreken, ${fp} niet in referentie`, voorbeelden: { ontbreekt: ex.ontbreekt.slice(0, 20), extra: ex.extra.slice(0, 20) } });
    }
  }
  return { score: round(weighted(parts.map((p) => [p.score, p.weight]))), method, parts, excerpt: goldPart.slice(0, 20000) };
}

// ---------- Pijler 3: LLM-as-judge ----------
export function judgeFromJson(j) {
  const scores = {};
  for (const k of JUDGE_CRITERIA) {
    const v = Number(j?.scores?.[k]);
    if (Number.isFinite(v)) scores[k] = Math.max(1, Math.min(5, v));
  }
  const vals = Object.values(scores);
  if (!vals.length) throw new Error('Het rechtermodel gaf geen scores terug');
  const score = vals.reduce((n, v) => n + ((v - 1) / 4) * 100, 0) / vals.length;
  return { score: round(score), scores, fouten: Array.isArray(j.fouten) ? j.fouten.slice(0, 30) : [], samenvatting: String(j.samenvatting || '') };
}

export function combine({ auto, gold, judge }) {
  return round(weighted([[auto, PILLAR_WEIGHTS.auto], [gold, PILLAR_WEIGHTS.gold], [judge, PILLAR_WEIGHTS.judge]]));
}

// ---------- Opslag bij een test ----------
export function goldFor(id) {
  return id ? db.prepare('SELECT * FROM gold_refs WHERE id = ?').get(id) : null;
}

/** Standaardreferentie voor een vergadering: de meest recente. */
export function defaultGold(meetingId) {
  return meetingId ? db.prepare('SELECT id FROM gold_refs WHERE meeting_id = ? ORDER BY id DESC LIMIT 1').get(meetingId)?.id || null : null;
}

function testContext(t) {
  const a = json(t.analysis, {}) || {};
  const inputBlocks = parseBlocks(t.input || '').blocks;
  return { step: t.step, inputText: t.input || '', inputBlocks, output: t.output || '', analysis: a.analysis || null, validation: a.validation || null, finishReason: a.finishReason };
}

/** (Her)berekent automatische en referentiescore van een test; de judge-score blijft behouden. */
export function scoreTest(id, { goldId } = {}) {
  const t = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id);
  if (!t || !t.output) return null;
  const ctx = testContext(t);
  const detail = json(t.quality_detail, {}) || {};
  const auto = autoScore(ctx);
  const gid = goldId !== undefined ? goldId : t.gold_id;
  const gold = goldFor(gid);
  const g = gold ? goldScore({ ...ctx, goldText: gold.text }) : null;
  detail.auto = auto;
  detail.gold = g ? { ...g, id: gold.id, naam: gold.naam } : null;
  const quality = combine({ auto: auto.score, gold: g?.score, judge: t.quality_judge });
  db.prepare('UPDATE test_runs SET quality = ?, quality_auto = ?, quality_gold = ?, quality_detail = ?, gold_id = ? WHERE id = ?')
    .run(quality, auto.score, g?.score ?? null, JSON.stringify(detail), gold ? gold.id : null, id);
  return { quality, quality_auto: auto.score, quality_gold: g?.score ?? null, quality_judge: t.quality_judge, detail };
}

/** Laat een rechtermodel de test beoordelen. */
export async function judgeTest(id, { model } = {}) {
  const t = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id);
  if (!t) throw new Error('Test niet gevonden');
  if (!t.output) throw new Error('Deze test heeft geen uitvoer');
  const judgeSkill = db.prepare('SELECT * FROM skills WHERE naam = ?').get(STEPS.judge.skill);
  if (!judgeSkill) throw new Error('Skill kwaliteitsrechter ontbreekt');
  const tested = db.prepare('SELECT naam, beschrijving FROM skills WHERE naam = ?').get(STEPS[t.step]?.skill) || { naam: t.step, beschrijving: '' };
  const meeting = t.meeting_id ? db.prepare('SELECT * FROM meetings WHERE id = ?').get(t.meeting_id) : null;
  const detail = json(t.quality_detail, {}) || {};
  const { system } = buildPrompt(judgeSkill, { meeting, text: `${t.input}\n${t.output}` });
  let user = `SKILL: ${tested.naam}\n${tested.beschrijving || ''}\n\nINVOER:\n<<<\n${t.input}\n>>>\n\nUITVOER:\n<<<\n${t.output}\n>>>`;
  if (detail.gold?.excerpt) {
    user += `\n\nGEVERIFIEERD EINDRESULTAAT (referentie, door een mens nagekeken; het eindproduct na álle stappen, dus niet alles hoort al bij deze skill):\n<<<\n${detail.gold.excerpt}\n>>>`;
  }
  const m = model || defaultModel('judge');
  const res = await complete({ model: m, system, user, json: true, temperature: 0 });
  const judge = { ...judgeFromJson(parseJsonLoose(res.text)), model: res.model || m, tokens_in: res.tokensIn, tokens_out: res.tokensOut, cost: res.cost, ms: res.ms };
  detail.judge = judge;
  const quality = combine({ auto: t.quality_auto, gold: t.quality_gold, judge: judge.score });
  db.prepare('UPDATE test_runs SET quality = ?, quality_judge = ?, quality_detail = ?, judge_model = ?, judge_cost = ? WHERE id = ?')
    .run(quality, judge.score, JSON.stringify(detail), judge.model, res.cost || 0, id);
  log({ testId: id, level: 'info', step: 'judge', message: `beoordeeld door ${judge.model}: ${judge.score}/100, $${(res.cost || 0).toFixed(4)}`, data: { scores: judge.scores, fouten: judge.fouten.length } });
  return { quality, quality_judge: judge.score, detail };
}

/** Bestaande tests zonder score: automatische score achteraf berekenen (bij het opstarten). */
export function backfillQuality() {
  const ids = db.prepare('SELECT id FROM test_runs WHERE quality_auto IS NULL AND output IS NOT NULL AND error IS NULL').all();
  for (const { id } of ids) {
    try { scoreTest(id); } catch (e) { console.error(`kwaliteitsscore test ${id}: ${e.message}`); }
  }
  return ids.length;
}

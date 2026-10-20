/* global App, $ */
const SKILL_OF = { normalizer: 'gentse-normalizer', cleaner: 'transcript-cleaner', resolver: 'speaker-resolver', writer: 'verslag-writer', agenda: 'agenda-extractor', intake: 'transcript-intake' };
const NEXT_STEP = { intake: 'normalizer', normalizer: 'cleaner', cleaner: 'resolver', resolver: 'writer' };
let settings = {};
let skills = [];
let skill = null; // opgeslagen versie van de gekozen skill
let data = null; // blokken + delen van de gekozen vergadering
let history;
const results = new Map(); // id → resultaat (voor "gebruik als invoer")

const $id = (id) => document.getElementById(id);
const words = (s) => (String(s).match(/\S+/g) || []).length;

function inputStats() {
  const t = $id('t-input').value;
  const blocks = (t.match(/^##\s*B\d+/gm) || []).length;
  $id('t-input-stats').textContent = t ? `${blocks} blokken · ${words(t)} woorden · ${t.length} tekens` : '';
}

function serialize(list) {
  return list.map((b) => `## ${b.id} | spreker: ${b.speaker || '?'}\n${b.text}`).join('\n\n');
}

// ---------- invoer ----------
async function loadMeeting() {
  const id = $id('t-meeting').value;
  data = null;
  $id('t-chunk').innerHTML = '';
  for (const el of ['t-chunk', 't-load', 't-load-agenda']) $id(el).disabled = !id;
  $id('t-meeting-info').textContent = '';
  if (!id) return;
  $id('t-meeting-info').textContent = 'Intake uitvoeren…';
  try {
    data = await App.api(`/meetings/${id}/blocks`);
    $id('t-chunk').innerHTML = data.chunks.map((c) => `<option value="${c.index}">Deel ${c.index + 1} · ${c.first}–${c.last} · ${c.words} woorden</option>`).join('');
    const total = data.blocks.reduce((n, b) => n + b.words, 0);
    $id('t-meeting-info').textContent = `${data.blocks.length} blokken, ${total} woorden, ${data.chunks.length} delen van ±${data.chunkWords} woorden${data.meeting.has_agenda_text ? ' · agenda beschikbaar' : ''}`;
    $id('t-load-agenda').disabled = !data.meeting.has_agenda_text;
    pickChunk();
  } catch (e) { App.error(e); $id('t-meeting-info').textContent = e.message; }
}

function pickChunk() {
  const c = data?.chunks[Number($id('t-chunk').value)];
  if (!c) return;
  $id('t-from').value = c.from;
  $id('t-to').value = c.to;
}

function loadBlocks() {
  if (!data) return;
  const from = Math.max(1, Number($id('t-from').value) || 1);
  const to = Math.min(data.blocks.length, Number($id('t-to').value) || data.blocks.length);
  $id('t-input').value = serialize(data.blocks.slice(from - 1, to).map((b) => ({ id: b.id, speaker: b.speaker, text: b.text })));
  inputStats();
}

// ---------- skill ----------
async function loadSkill() {
  const step = $id('t-step').value;
  const s = skills.find((x) => x.naam === SKILL_OF[step]);
  skill = s ? await App.api(`/skills/${s.id}`) : null;
  $id('t-skill').value = skill?.content || '';
  $id('t-skill-version').textContent = skill ? `v${skill.version}` : '';
  const refs = JSON.parse(skill?.refs || '[]');
  $id('t-refs').innerHTML = (App.meta?.refKeys || []).map((r) => `<div class="form-check form-check-inline">
    <input class="form-check-input t-ref" type="checkbox" id="tref-${r}" value="${r}" ${refs.includes(r) ? 'checked' : ''}>
    <label class="form-check-label small" for="tref-${r}">${r}</label></div>`).join('');
  document.querySelectorAll('.t-ref').forEach((c) => c.addEventListener('change', draftState));
  const first = document.querySelector('.t-model');
  first.placeholder = settings.effective?.[step] || '';
  if (!first.value || first.dataset.auto === '1') { first.value = settings.effective?.[step] || ''; first.dataset.auto = '1'; }
  first.oninput = () => { first.dataset.auto = '0'; };
  draftState();
}

function currentRefs() { return [...document.querySelectorAll('.t-ref:checked')].map((c) => c.value); }

function draftState() {
  const changedText = skill && $id('t-skill').value !== skill.content;
  const changedRefs = skill && JSON.stringify(currentRefs()) !== JSON.stringify(JSON.parse(skill.refs || '[]'));
  $id('t-draft-badge').classList.toggle('d-none', !(changedText || changedRefs));
}

// ---------- resultaten ----------
function statusBadge(s) {
  const map = { gewijzigd: 'primary', gelijk: 'light border', samengevoegd: 'info', ontbreekt: 'danger', ok: 'success' };
  return `<span class="badge text-bg-${map[s] || 'secondary'}">${App.esc(s)}</span>`;
}

function renderAnalysis(r, key) {
  const a = r.analysis;
  if (!a) return `<pre class="io">${App.esc(r.output || '')}</pre>`;
  if (a.kind === 'json') {
    if (a.error) return `<div class="alert alert-danger py-1 small">Geen geldige JSON: ${App.esc(a.error)}</div>`;
    const j = a.json || {};
    let html = '';
    if (j.punten) {
      html += `<table class="table table-sm small"><thead><tr><th>Start</th><th>Nr</th><th>Titel</th><th>Samenvatting</th></tr></thead><tbody>${j.punten.map((p) => `<tr>
        <td>${App.esc(p.start || '')}</td><td>${App.esc(p.nummer || '')}</td><td>${App.esc(p.titel || '')}${p.vervolg ? ' <i>(vervolg)</i>' : ''}</td>
        <td>${App.esc(p.samenvatting || p.kern || '')}${(p.beslissingen || []).length ? `<div class="text-success">${p.beslissingen.map(App.esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}</tbody></table>`;
    }
    if (j.context?.length) html += `<p class="small"><b>Context:</b> ${j.context.map((c) => App.esc(`${c.correct} (${c.categorie})`)).join(', ')}</p>`;
    return html + `<details><summary class="small">JSON</summary><pre class="io">${App.esc(JSON.stringify(j, null, 2))}</pre></details>`;
  }
  if (a.kind === 'resolver') {
    const z = Object.entries(a.stats.zekerheid || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
    return `<div class="small mb-1">${z}${a.stats.ontbreekt ? ` · <span class="text-danger">${a.stats.ontbreekt} zonder kop</span>` : ''}</div>
      <table class="table table-sm small"><thead><tr><th>Blok</th><th>Label</th><th>Spreker</th><th>Zekerheid</th><th>Tekst</th></tr></thead><tbody>
      ${a.blocks.map((b) => `<tr><td>${b.id}</td><td>${App.esc(b.speaker_in || '')}</td>
        <td>${b.status === 'ok' ? `<b>${App.esc(b.speaker_name)}</b> <span class="text-body-secondary">${App.esc([b.functie, b.fractie].filter((x) => x && x !== '-').join(', '))}</span>` : statusBadge('ontbreekt')}</td>
        <td>${App.zekerheidBadge(b.zekerheid)}</td><td class="text-body-secondary">${App.esc((b.text || '').slice(0, 140))}…</td></tr>`).join('')}
      </tbody></table>${sectionsHtml(a.sections)}`;
  }
  // blokstappen
  const s = a.stats;
  const reps = new Map();
  for (const x of a.replacements || []) {
    const k = `${x.before || '∅'} → ${x.after || '∅'}`;
    reps.set(k, (reps.get(k) || 0) + 1);
  }
  const chips = [...reps].sort((x, y) => y[1] - x[1]).slice(0, 80)
    .map(([k, n]) => `<span class="badge text-bg-light border fw-normal me-1 mb-1">${App.esc(k)}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
  return `<div class="small mb-2">${s.gewijzigd} gewijzigd · ${s.gelijk} ongewijzigd${s.samengevoegd ? ` · ${s.samengevoegd} samengevoegd` : ''}${s.ontbreekt ? ` · <span class="text-danger">${s.ontbreekt} ontbreken</span>` : ''}${s.extra ? ` · ${s.extra} extra` : ''}
      · woorden ${s.woorden_in} → ${s.woorden_uit}</div>
    ${chips ? `<div class="mb-2"><div class="small fw-semibold">Vervangingen (${a.replacements.length})</div>${chips}</div>` : '<div class="small text-warning mb-2">Geen enkele woordvervanging.</div>'}
    <div class="form-check form-switch small"><input class="form-check-input t-showall" type="checkbox" id="showall-${key}" data-key="${key}">
      <label class="form-check-label" for="showall-${key}">Ook ongewijzigde blokken tonen</label></div>
    <div class="t-blocks" data-key="${key}">${a.blocks.map((b) => `<div class="border-bottom py-1 small t-b-${b.status}" ${b.status === 'gelijk' ? 'hidden' : ''}>
      <b>${b.id}</b> ${statusBadge(b.status)}${b.into ? ` → ${b.into}` : ''}
      <div>${b.diff ? App.renderWordDiff(b.diff) : `<span class="text-body-secondary">${App.esc(b.before || '')}</span>`}</div></div>`).join('')}</div>
    ${sectionsHtml(a.sections)}`;
}

function sectionsHtml(sections) {
  return Object.entries(sections || {}).filter(([, v]) => v).map(([k, v]) => `<details class="mt-2" open><summary class="small fw-semibold">${App.esc(k)}</summary><pre class="io">${App.esc(v)}</pre></details>`).join('');
}

function renderResult(r, colClass) {
  results.set(String(r.id), r);
  const key = `r${r.id}`;
  const v = r.validation;
  const validationHtml = !v ? '' : v.ok
    ? `<span class="badge text-bg-success" title="De pipeline zou deze uitvoer aanvaarden">pipeline-validatie ok</span>${v.warnings?.length ? ` <span class="badge text-bg-warning" title="${App.esc(v.warnings.join('\n'))}">${v.warnings.length} waarschuwing(en)</span>` : ''}`
    : `<span class="badge text-bg-danger" title="De pipeline zou deze uitvoer afkeuren">afgekeurd: ${App.esc(v.error)}</span>`;
  const refs = (r.refs || []).map((x) => `<li>${App.esc(x.ref)}: ${x.included ? `${x.chars} tekens` : '<b class="text-danger">niet meegestuurd</b>'}${x.note ? ` <i>(${App.esc(x.note)})</i>` : ''}</li>`).join('');
  const next = NEXT_STEP[r.step || $id('t-step').value];
  const col = document.createElement('div');
  col.className = colClass;
  col.innerHTML = `<div class="card h-100">
    <div class="card-header">
      <div class="d-flex flex-wrap gap-2 align-items-center"><code class="me-auto">${App.esc(r.model)}</code>
        ${r.error ? '' : `<span class="small">${((r.ms || 0) / 1000).toFixed(1)} s · ${r.tokens_in}/${r.tokens_out} tok · ${App.fmtCost(r.cost)}</span>`}
        <span class="small text-body-secondary">test #${r.id}</span></div>
      <div class="mt-1">${validationHtml}${r.finishReason && r.finishReason !== 'stop' ? ` <span class="badge text-bg-danger">finish: ${App.esc(r.finishReason)}</span>` : ''}</div>
    </div>
    <div class="card-body">
      ${r.error ? `<div class="alert alert-danger">${App.esc(r.error)}</div>` : `
      <ul class="nav nav-tabs nav-sm mb-2">
        <li class="nav-item"><button class="nav-link active py-1" data-bs-toggle="tab" data-bs-target="#${key}-a">Wijzigingen</button></li>
        <li class="nav-item"><button class="nav-link py-1" data-bs-toggle="tab" data-bs-target="#${key}-o">Uitvoer</button></li>
        <li class="nav-item"><button class="nav-link py-1" data-bs-toggle="tab" data-bs-target="#${key}-s">Prompt</button></li>
      </ul>
      <div class="tab-content">
        <div class="tab-pane fade show active" id="${key}-a">${renderAnalysis(r, key)}</div>
        <div class="tab-pane fade" id="${key}-o"><pre class="io">${App.esc(r.output || '')}</pre></div>
        <div class="tab-pane fade" id="${key}-s"><ul class="small">${refs}</ul>
          <details><summary class="small fw-semibold">Systeemprompt (${(r.system || '').length} tekens)</summary><pre class="io">${App.esc(r.system || '')}</pre></details>
          <details><summary class="small fw-semibold">Gebruikersbericht (${(r.user || r.input || '').length} tekens)</summary><pre class="io">${App.esc(r.user || r.input || '')}</pre></details></div>
      </div>
      ${next ? `<button class="btn btn-sm btn-outline-primary mt-2 t-next" data-id="${r.id}" data-next="${next}"><i class="bi bi-arrow-right-circle"></i> Gebruik als invoer voor ${SKILL_OF[next]}</button>` : ''}`}
    </div></div>`;
  return col;
}

function showResults(list) {
  const box = $id('t-results');
  box.innerHTML = '';
  const cls = list.length === 1 ? 'col-12' : list.length === 2 ? 'col-xl-6' : 'col-xl-4';
  for (const r of list) box.appendChild(renderResult(r, cls));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Uitvoer van een test → invoer voor de volgende skill */
function nextInput(r) {
  const a = r.analysis;
  if (!a) return r.output;
  if (a.kind === 'blocks') {
    return a.blocks.filter((b) => b.after != null).map((b) => `## ${b.id} | spreker: ${b.speaker_out || b.speaker_in || '?'}\n${b.after}`).join('\n\n');
  }
  if (a.kind === 'resolver') {
    return a.blocks.map((b) => `## ${b.id} | spreker: ${b.status === 'ok' ? b.speaker_out : `${b.speaker_in || 'Onbekende spreker'} | - | - | zekerheid: laag`}\n${b.text}`).join('\n\n');
  }
  return r.output;
}

async function run() {
  const step = $id('t-step').value;
  const input = $id('t-input').value;
  const models = [...document.querySelectorAll('.t-model')].map((i) => i.value.trim()).filter(Boolean);
  if (!models.length && settings.effective?.[step]) models.push(settings.effective[step]);
  const btn = $id('t-run');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Bezig…';
  $id('t-run-info').textContent = `${models.length} model(len), ${words(input)} woorden`;
  const t0 = Date.now();
  try {
    const res = await App.api('/test/run', {
      method: 'POST',
      body: { step, input, models, skillContent: $id('t-skill').value, refs: currentRefs(), meetingId: $id('t-meeting').value || null, label: $id('t-label').value },
    });
    res.forEach((r) => { r.step = step; });
    showResults(res);
    $id('t-run-info').textContent = `klaar in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    loadHistory();
  } catch (e) { App.error(e); $id('t-run-info').textContent = ''; } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-play-fill"></i> Test uitvoeren';
  }
}

async function loadHistory() {
  history.clear().rows.add(await App.api('/test/runs')).draw(false);
}

document.addEventListener('DOMContentLoaded', async () => {
  await App.loadMeta();
  App.modelDatalist();
  settings = await App.api('/settings').catch(() => ({}));
  skills = await App.api('/skills');
  const meetings = await App.api('/meetings');
  $id('t-meeting').innerHTML += meetings.map((m) => `<option value="${m.id}">#${m.id} ${App.esc(m.titel || m.input_name)} ${App.esc(m.datum || '')}</option>`).join('');

  $id('t-meeting').onchange = loadMeeting;
  $id('t-chunk').onchange = pickChunk;
  $id('t-load').onclick = loadBlocks;
  $id('t-load-agenda').onclick = async () => {
    const { text } = await App.api(`/meetings/${$id('t-meeting').value}/agenda-text`);
    $id('t-input').value = text;
    $id('t-step').value = 'agenda';
    await loadSkill();
    inputStats();
  };
  $id('t-input').addEventListener('input', inputStats);
  $id('t-step').onchange = loadSkill;
  $id('t-skill').addEventListener('input', draftState);
  $id('t-skill-reset').onclick = () => { loadSkill(); };
  $id('t-skill-save').onclick = async () => {
    if (!skill) return;
    try {
      await App.api(`/skills/${skill.id}`, { method: 'PUT', body: { content: $id('t-skill').value, refs: currentRefs(), note: $id('t-skill-note').value || 'Aangepast in de testbank' } });
      App.toast('Nieuwe skillversie opgeslagen');
      skills = await App.api('/skills');
      $id('t-skill-note').value = '';
      loadSkill();
    } catch (e) { App.error(e); }
  };
  $id('t-run').onclick = run;

  $('#t-results').on('change', '.t-showall', (e) => {
    document.querySelectorAll(`.t-blocks[data-key="${e.target.dataset.key}"] .t-b-gelijk`).forEach((el) => { el.hidden = !e.target.checked; });
  });
  $('#t-results').on('click', '.t-next', async (e) => {
    const r = results.get(e.currentTarget.dataset.id);
    $id('t-input').value = nextInput(r);
    $id('t-step').value = e.currentTarget.dataset.next;
    await loadSkill();
    inputStats();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    App.toast(`Invoer klaar voor ${SKILL_OF[e.currentTarget.dataset.next]}`);
  });

  history = App.table('#t-history', {
    order: [[0, 'desc']], pageLength: 10,
    columns: [
      { data: 'id' }, { data: 'created_at', className: 'small' }, { data: 'step' },
      { data: 'model', render: (m) => `<code class="small">${App.esc(m || '')}</code>` },
      { data: null, render: (r) => `v${r.skill_version}${r.skill_draft ? ' <span class="badge text-bg-warning">concept</span>' : ''}` },
      { data: 'label', render: (l) => App.esc(l || '') },
      { data: null, render: (r) => `<span class="small">${App.esc(r.input_name || 'eigen tekst')} · ${r.input_chars} tekens</span>` },
      { data: null, render: (r) => (r.error ? `<span class="text-danger small">${App.esc(r.error.slice(0, 60))}</span>` : `${r.tokens_in || 0}/${r.tokens_out || 0}`) },
      { data: 'cost', render: App.fmtCost },
      { data: 'ms', render: (ms) => (ms ? `${(ms / 1000).toFixed(1)} s` : '') },
      { data: null, orderable: false, render: (r) => `<button class="btn btn-sm btn-outline-danger t-del" data-id="${r.id}"><i class="bi bi-trash"></i></button>` },
    ],
  });
  $('#t-history').on('click', 'tbody tr', async function (e) {
    if (e.target.closest('.t-del')) return;
    const d = history.row(this).data();
    if (!d) return;
    const t = await App.api(`/test/runs/${d.id}`);
    showResults([{ ...t, user: t.input }]);
  });
  $('#t-history').on('click', '.t-del', async (e) => {
    await App.api(`/test/runs/${e.currentTarget.dataset.id}`, { method: 'DELETE' });
    loadHistory();
  });
  loadHistory();

  const q = new URLSearchParams(location.search);
  if (q.get('step')) $id('t-step').value = q.get('step');
  await loadSkill();
  if (q.get('meeting')) { $id('t-meeting').value = q.get('meeting'); await loadMeeting(); }
});

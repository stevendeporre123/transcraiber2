/* global App, $ */
const runId = Number(new URLSearchParams(location.search).get('id'));
let run = null;
let members = [];
let blocksTable;
let stepsTable;
let editing = null;

const points = () => run.report?.punten || [];
const pointLabel = (i) => {
  const p = points()[i];
  return p ? `${p.nummer ? `Punt ${p.nummer}: ` : ''}${p.titel}` : '–';
};

async function load() {
  run = await App.api(`/runs/${runId}`);
  render();
  if (run.active || run.status === 'bezig' || run.status === 'wachtrij') setTimeout(poll, 2500);
}

async function poll() {
  const s = await App.api(`/runs/${runId}/status`);
  if (s.active || s.status === 'bezig' || s.status === 'wachtrij') {
    renderStatus(s);
    setTimeout(poll, 2500);
  } else load();
}

function renderStatus(s) {
  const el = document.getElementById('r-status');
  if (s.status === 'klaar') { el.innerHTML = ''; return; }
  el.innerHTML = s.status === 'fout'
    ? `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-octagon"></i> ${App.esc(s.error)}</div>`
    : `<div class="alert alert-info py-2 mb-0 d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm"></div> ${App.esc(s.progress || 'Bezig…')} <span class="ms-auto small">${App.fmtCost(s.cost)}</span></div>`;
}

function render() {
  const m = run.meeting;
  const title = run.report?.titel || m.titel || (m.orgaan === 'commissie' ? `Commissie ${m.commissie || ''}` : 'Gemeenteraad');
  document.getElementById('r-title').textContent = title;
  document.title = `${title} · Transcraiber`;
  document.getElementById('r-meta').innerHTML = [
    `Run #${run.id}${run.label ? ` · <i>${App.esc(run.label)}</i>` : ''}`,
    App.esc(m.datum || ''),
    `${App.esc(m.input_name)} (${App.esc(m.input_type)})`,
    m.agenda_name ? `agenda: ${App.esc(m.agenda_name)} ${App.badgeStatus(m.agenda_status || '')}` : 'geen agenda',
    `kost ${App.fmtCost(run.cost)}`,
  ].filter(Boolean).join(' · ');
  for (const f of ['pdf', 'docx', 'vtt', 'json']) {
    const a = document.getElementById(`exp-${f}`);
    a.href = `/api/runs/${runId}/export.${f}`;
    a.classList.toggle('disabled', run.status !== 'klaar' || (f === 'vtt' && !m.has_timecodes));
  }
  document.getElementById('exp-vtt').title = m.has_timecodes ? 'WebVTT met de originele tijdcodes' : 'Geen tijdcodes in de invoer: VTT niet mogelijk';
  renderStatus(run);

  const warnings = [...(run.report?.waarschuwingen || []), ...(run.warnings || [])];
  document.getElementById('r-warnings').innerHTML = warnings.length ? `<div class="alert alert-warning py-2">
      <details><summary><i class="bi bi-exclamation-triangle"></i> ${warnings.length} waarschuwing(en)</summary>
      <ul class="mb-0 mt-2 small">${warnings.map((w) => `<li>${App.esc(w)}</li>`).join('')}</ul></details></div>` : '';

  renderReport();
  blocksTable.clear().rows.add(run.blocks).draw(false);
  stepsTable.clear().rows.add(run.steps).draw(false);
  renderAgenda();
  document.getElementById('skillversions').textContent = `Skillversies: ${Object.entries(run.skill_versions || {}).map(([k, v]) => `${k} v${v}`).join(', ')}`;
}

function renderReport() {
  const el = document.getElementById('report');
  if (!run.blocks.length) { el.innerHTML = '<p class="text-body-secondary">Nog geen resultaat.</p>'; return; }
  const r = run.report || {};
  const byPoint = new Map();
  for (const b of run.blocks) byPoint.set(b.point_idx ?? 0, [...(byPoint.get(b.point_idx ?? 0) || []), b]);
  const decisions = points().flatMap((p) => (p.beslissingen || []).map((d) => (p.nummer ? `Punt ${p.nummer}: ${d}` : d)));
  let html = '';
  if (r.samenvatting) {
    html += `<h2 class="h5">Samenvatting</h2><p>${App.esc(r.samenvatting)}</p>
      <p class="fw-semibold mb-1">Beslissingen en stemmingen</p>
      ${decisions.length ? `<ul>${decisions.map((d) => `<li>${App.esc(d)}</li>`).join('')}</ul>` : '<p class="fst-italic">Geen beslissingen of stemmingen vermeld in de transcriptie.</p>'}`;
  }
  const idxs = points().length ? points().map((_, i) => i) : [0];
  for (const i of idxs) {
    const list = byPoint.get(i) || [];
    if (!list.length) continue;
    const p = points()[i] || { titel: 'Transcript' };
    html += `<h2 class="h5 mt-4">${App.esc(pointLabel(i) === '–' ? p.titel : pointLabel(i))}
        ${points()[i] ? `<button class="btn btn-sm btn-link edit-point" data-idx="${i}"><i class="bi bi-pencil"></i></button>` : ''}</h2>`;
    if (p.samenvatting) html += `<p class="point-summary">${App.esc(p.samenvatting)}</p>`;
    let prev = null;
    for (const b of list) {
      const who = b.speaker_name || b.speaker_raw || 'Onbekende spreker';
      const extra = [b.functie, b.fractie].filter((x) => x && x !== '-').join(', ');
      const showWho = who !== prev;
      prev = who;
      html += `<div class="contribution clickable px-1" data-block="${b.block_id}">
          ${run.meeting.has_timecodes ? `<span class="ts">${App.fmtTime(b.t_start)}</span> ` : ''}
          ${showWho ? `<span class="who">${App.esc(who)}${extra ? ` (${App.esc(extra)})` : ''}:</span> ` : ''}
          ${b.zekerheid === 'laag' && showWho ? '<i class="bi bi-question-circle text-danger" title="zekerheid laag"></i> ' : ''}
          ${App.esc(b.text_final)} ${b.edited ? '<i class="bi bi-pencil-fill text-info small" title="manueel aangepast"></i>' : ''}
          <button type="button" class="btn btn-sm btn-link edit-btn p-0"><i class="bi bi-pencil-square"></i></button></div>`;
    }
  }
  el.innerHTML = html;
}

function renderAgenda() {
  const a = run.meeting.agenda;
  const el = document.getElementById('agenda');
  if (!a?.punten?.length) { el.innerHTML = '<p class="text-body-secondary">Geen agenda (of nog niet uitgelezen).</p>'; return; }
  el.innerHTML = `<table class="table table-sm"><thead><tr><th>Nr</th><th>Titel</th><th>Type</th><th>Indiener(s)</th><th>Bevoegd</th></tr></thead><tbody>
    ${a.punten.map((p) => `<tr><td>${App.esc(p.nummer)}</td><td>${App.esc(p.titel)}<div class="small text-body-secondary">${App.esc(p.kern || '')}</div></td>
      <td>${App.esc(p.type || '')}</td><td>${App.esc((p.indieners || []).join(', '))}</td><td>${App.esc(p.schepen || '')}</td></tr>`).join('')}
    </tbody></table>
    ${a.context?.length ? `<p class="small">Context uit agenda (staat als <a href="termen.html">voorstel</a> klaar): ${a.context.map((c) => App.esc(c.correct)).join(', ')}</p>` : ''}`;
}

// ---------- Blok bewerken ----------
function openBlock(blockId) {
  const b = run.blocks.find((x) => x.block_id === blockId);
  if (!b) return;
  editing = b;
  const f = document.getElementById('f-block');
  App.fillForm(f, { ...b, applyAll: 0, lesson: '' });
  f.point_idx.innerHTML = (points().length ? points() : [{ titel: 'Transcript' }]).map((p, i) => `<option value="${i}">${App.esc(pointLabel(i) === '–' ? p.titel : pointLabel(i))}</option>`).join('');
  f.point_idx.value = b.point_idx ?? 0;
  document.getElementById('b-id').textContent = b.block_id;
  document.getElementById('b-time').textContent = b.t_start != null ? `${App.fmtTime(b.t_start)} – ${App.fmtTime(b.t_end)}` : '';
  document.getElementById('b-oldspeaker').textContent = b.speaker_name || '';
  document.getElementById('b-raw').textContent = b.text_raw;
  document.getElementById('b-rawspk').textContent = b.speaker_raw ? `(${b.speaker_raw})` : '';
  document.getElementById('b-norm').textContent = b.text_norm;
  document.getElementById('b-clean').textContent = b.text_clean;
  document.getElementById('b-learn').innerHTML = '<div class="small text-body-secondary">Pas de tekst aan om vervangingen te zien.</div>';
  App.modal('m-block').show();
}

let learnTimer;
async function refreshLearn() {
  const f = document.getElementById('f-block');
  const reps = (await App.api('/diff/replacements', { method: 'POST', body: { before: editing.text_final, after: f.text_final.value } }))
    .filter((r) => r.before && r.after && r.before.split(' ').length <= 6).slice(0, 12);
  const cats = App.meta?.termCategories || ['naam_fout'];
  document.getElementById('b-learn').innerHTML = reps.length ? `<table class="table table-sm mb-0"><thead><tr><th>Onthoud</th><th>Fout (STT-vervorming)</th><th>Juist</th><th>Categorie</th></tr></thead><tbody>
    ${reps.map((r) => `<tr class="learn-row"><td><input type="checkbox" class="form-check-input l-on"></td>
      <td><input class="form-control form-control-sm l-before" value="${App.esc(r.before.replace(/[.,;:!?]+$/, ''))}"></td>
      <td><input class="form-control form-control-sm l-after" value="${App.esc(r.after.replace(/[.,;:!?]+$/, ''))}"></td>
      <td><select class="form-select form-select-sm l-cat">${cats.map((c) => `<option ${c === 'naam_fout' ? 'selected' : ''}>${c}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table>` : '<div class="small text-body-secondary">Geen woordvervangingen gevonden (enkel toevoegingen/weglatingen).</div>';
}

async function saveBlock(e) {
  e.preventDefault();
  const f = e.target;
  const d = App.readForm(f);
  const learnTerms = [...document.querySelectorAll('#b-learn .learn-row')].filter((tr) => tr.querySelector('.l-on').checked).map((tr) => ({
    varianten: tr.querySelector('.l-before').value, correct: tr.querySelector('.l-after').value, categorie: tr.querySelector('.l-cat').value,
  }));
  try {
    const res = await App.api(`/runs/${runId}/blocks/${editing.block_id}`, {
      method: 'PUT',
      body: { text_final: d.text_final, speaker_name: d.speaker_name, fractie: d.fractie, functie: d.functie, point_idx: Number(d.point_idx), lesson: d.lesson, applyAll: !!d.applyAll, learnTerms },
    });
    App.modal('m-block').hide();
    App.toast(`Opgeslagen${res.termIds?.length ? ` · ${res.termIds.length} term(en) toegevoegd aan de Gentse context` : ''}${res.corrections?.length ? ' · correctie bewaard voor de skill-assistent' : ''}`);
    await load();
    App.loadMeta();
  } catch (err) { App.error(err); }
}

async function saveReport(patch) {
  run.report = await App.api(`/runs/${runId}/report`, { method: 'PUT', body: patch });
  render();
}

document.addEventListener('DOMContentLoaded', async () => {
  await App.loadMeta();
  members = await App.api('/members');
  document.getElementById('speaker-list').innerHTML = ['Onbekende spreker', 'Voorzitter (commissie)', 'Algemeen directeur'].map((n) => `<option value="${n}">`).join('')
    + members.filter((m) => m.actief).map((m) => `<option value="${App.esc(m.naam)}">${App.esc(m.functie)} · ${App.esc(m.fractie || '')}</option>`).join('');
  document.getElementById('fractie-list').innerHTML = App.meta.fracties.map((f) => `<option value="${App.esc(f)}">`).join('');

  blocksTable = App.table('#blocks', {
    pageLength: 50,
    columns: [
      { data: 'block_id' },
      { data: 't_start', render: (t) => `<span class="ts">${App.fmtTime(t)}</span>` },
      { data: null, render: (b) => `${App.esc(b.speaker_name || b.speaker_raw || '')}<div class="small text-body-secondary">${App.esc([b.functie, b.fractie].filter((x) => x && x !== '-').join(', '))}</div>` },
      { data: 'zekerheid', render: App.zekerheidBadge },
      { data: 'point_idx', render: (i) => `<span class="small">${App.esc(pointLabel(i ?? 0))}</span>` },
      { data: null, className: 'cell-text', render: (b) => `${App.esc(b.text_final)}${b.edited ? ' <i class="bi bi-pencil-fill text-info small"></i>' : ''}` },
      { data: null, orderable: false, render: () => '<button class="btn btn-sm btn-outline-primary"><i class="bi bi-pencil"></i></button>' },
    ],
  });
  $('#blocks').on('click', 'tbody tr', function () { const d = blocksTable.row(this).data(); if (d) openBlock(d.block_id); });

  stepsTable = App.table('#steps', {
    order: [],
    columns: [
      { data: 'step' }, { data: 'chunk', render: (c) => (c === 999 ? 'slot' : c + 1) }, { data: 'model', render: (m) => `<code class="small">${App.esc(m)}</code>` },
      { data: 'status', render: (s) => App.badgeStatus(s === 'ok' ? 'klaar' : s) },
      { data: null, render: (s) => `${s.tokens_in || 0} / ${s.tokens_out || 0}` },
      { data: 'cost', render: App.fmtCost }, { data: 'ms', render: (ms) => `${((ms || 0) / 1000).toFixed(1)} s` },
      { data: 'warnings', render: (w) => `<span class="small">${App.esc((JSON.parse(w || '[]') || []).join('; '))}</span>` },
    ],
  });
  $('#steps').on('click', 'tbody tr', async function () {
    const d = stepsTable.row(this).data();
    if (!d) return;
    const s = await App.api(`/runs/${runId}/steps/${d.id}`);
    document.getElementById('s-title').textContent = `${s.step} · deel ${s.chunk === 999 ? 'slot' : s.chunk + 1} · ${s.model}`;
    document.getElementById('s-in').textContent = s.input;
    document.getElementById('s-out').textContent = s.output;
    App.modal('m-step').show();
  });

  $('#report').on('click', '.contribution', function () { openBlock(this.dataset.block); });
  $('#report').on('click', '.edit-point', function (e) {
    e.stopPropagation();
    const i = Number(this.dataset.idx);
    const p = points()[i];
    App.fillForm(document.getElementById('f-point'), { ...p, idx: i, beslissingen: (p.beslissingen || []).join('\n') });
    App.modal('m-point').show();
  });
  document.getElementById('f-point').onsubmit = async (e) => {
    e.preventDefault();
    const d = App.readForm(e.target);
    const punten = points().map((p, i) => (i === Number(d.idx) ? { ...p, nummer: d.nummer, titel: d.titel, samenvatting: d.samenvatting, beslissingen: d.beslissingen.split('\n').map((x) => x.trim()).filter(Boolean) } : p));
    try { await saveReport({ punten }); App.modal('m-point').hide(); } catch (err) { App.error(err); }
  };
  document.getElementById('btn-edit-report').onclick = () => {
    const r = run.report || {};
    App.fillForm(document.getElementById('f-report'), { titel: r.titel, samenvatting: r.samenvatting, waarschuwingen: (r.waarschuwingen || []).join('\n') });
    App.modal('m-report').show();
  };
  document.getElementById('f-report').onsubmit = async (e) => {
    e.preventDefault();
    const d = App.readForm(e.target);
    try { await saveReport({ titel: d.titel, samenvatting: d.samenvatting, waarschuwingen: d.waarschuwingen.split('\n').map((x) => x.trim()).filter(Boolean) }); App.modal('m-report').hide(); } catch (err) { App.error(err); }
  };

  const fb = document.getElementById('f-block');
  fb.onsubmit = saveBlock;
  fb.text_final.addEventListener('input', () => { clearTimeout(learnTimer); learnTimer = setTimeout(refreshLearn, 500); });
  fb.speaker_name.addEventListener('change', () => {
    const m = members.find((x) => x.naam === fb.speaker_name.value);
    if (m) { fb.fractie.value = m.fractie || ''; fb.functie.value = m.functie || ''; }
  });

  document.querySelectorAll('.redo').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const step = a.dataset.step;
    if (!(await App.confirm(`Opnieuw verwerken vanaf "${step}"? ${step === 'normalizer' ? 'Manuele aanpassingen in de blokken gaan verloren.' : 'Bewaarde output van deze en volgende stappen wordt opnieuw berekend.'}`))) return;
    try { await App.api(`/runs/${runId}/resume`, { method: 'POST', body: { redo: step } }); setTimeout(load, 500); } catch (err) { App.error(err); }
  }));
  document.getElementById('resume').onclick = async (e) => {
    e.preventDefault();
    try { await App.api(`/runs/${runId}/resume`, { method: 'POST', body: {} }); setTimeout(load, 500); } catch (err) { App.error(err); }
  };

  load().catch(App.error);
});

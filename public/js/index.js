/* global App, $ */
let settings = {};
let runsTable;
const selected = new Set();

const runOptionsHtml = (prefix, opts) => App.runOptionsHtml(prefix, opts, settings);
const readRunOptions = (form) => App.readRunOptions(form);

function modelsSummary(opt) {
  const m = opt?.models || {};
  const uniq = [...new Set(Object.entries(m).filter(([k]) => ['normalizer', 'cleaner', 'resolver', 'writer'].includes(k)).map(([, v]) => v))];
  return uniq.map((x) => `<code class="small">${App.esc(x)}</code>`).join('<br>') || '<span class="text-body-secondary">standaard</span>';
}

let meetingsTable;
async function loadMeetings() {
  const rows = await App.api('/meetings');
  meetingsTable.clear().rows.add(rows).draw(false);
  if (rows.some((m) => m.prep_status === 'bezig')) setTimeout(loadMeetings, 3000);
}

async function loadRuns() {
  const rows = await App.api('/runs');
  runsTable.clear().rows.add(rows).draw(false);
  if (rows.some((r) => r.status === 'bezig' || r.status === 'wachtrij')) setTimeout(loadRuns, 3000);
}

function updateCompareBtn() {
  document.getElementById('btn-compare').disabled = selected.size !== 2;
}

document.addEventListener('DOMContentLoaded', async () => {
  settings = await App.api('/settings').catch(() => ({}));
  App.modelDatalist();
  const meta = await App.loadMeta();
  document.getElementById('commissie-list').innerHTML = meta.commissies.map((c) => `<option value="${App.esc(c.code)}">${App.esc(c.naam || '')}</option>`).join('');
  App.api('/members').then((ms) => {
    document.getElementById('leden-list').innerHTML = ms.filter((m) => m.actief).map((m) => `<option value="${App.esc(m.naam)}">${App.esc(m.functie)} · ${App.esc(m.fractie || '')}</option>`).join('');
  });

  runsTable = App.table('#runs', {
    order: [[1, 'desc']],
    columns: [
      { data: null, orderable: false, render: (r) => `<input type="checkbox" class="form-check-input sel" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''}>` },
      { data: 'id' },
      { data: null, render: (r) => `<a href="run.html?id=${r.id}" class="fw-semibold">${App.esc(r.titel || (r.orgaan === 'commissie' ? `Commissie ${r.commissie || ''}` : 'Gemeenteraad'))}</a>
          <div class="small text-body-secondary">${App.esc(r.datum || '')}${r.label ? ` · <i>${App.esc(r.label)}</i>` : ''}</div>` },
      { data: null, render: (r) => `${App.esc(r.input_name)} <span class="badge text-bg-light border">${App.esc(r.input_type)}</span>${r.has_timecodes ? ' <i class="bi bi-clock" title="met tijdcodes"></i>' : ''}` },
      { data: 'options', render: modelsSummary },
      { data: null, render: (r) => `${App.badgeStatus(r.status)}<div class="small text-body-secondary">${App.esc(r.status === 'fout' ? r.error : r.progress || '')}</div>` },
      { data: null, render: (r) => `${r.blocks || 0}${r.edited ? ` <span class="badge text-bg-info" title="manueel aangepast">${r.edited}</span>` : ''}` },
      { data: 'cost', render: (c, t, r) => `${App.fmtCost(c)}<div class="small text-body-secondary">${((r.tokens_in + r.tokens_out) / 1000).toFixed(1)}k tok</div>` },
      { data: 'created_at', type: 'string', className: 'small' },
      { data: null, orderable: false, className: 'text-end text-nowrap', render: (r) => `
          <a class="btn btn-sm btn-outline-primary" href="run.html?id=${r.id}" title="Openen"><i class="bi bi-eye"></i></a>
          <button class="btn btn-sm btn-outline-secondary act-rerun" data-id="${r.id}" title="Opnieuw verwerken (ander model)"><i class="bi bi-arrow-repeat"></i></button>
          ${['bezig', 'wachtrij'].includes(r.status) ? `<button class="btn btn-sm btn-danger act-stop" data-id="${r.id}" title="Stoppen"><i class="bi bi-stop-fill"></i></button>` : ''}
          ${['fout', 'gestopt'].includes(r.status) ? `<button class="btn btn-sm btn-outline-warning act-resume" data-id="${r.id}" title="Hervatten"><i class="bi bi-play"></i></button>` : ''}
          <button class="btn btn-sm btn-outline-danger act-del" data-id="${r.id}" title="Verwijderen"><i class="bi bi-trash"></i></button>` },
    ],
  });
  loadRuns();
  meetingsTable = App.table('#meetings', {
    order: [[0, 'desc']], pageLength: 10,
    columns: [
      { data: 'id' },
      { data: null, render: (m) => `<a href="vergadering.html?id=${m.id}" class="fw-semibold">${App.esc(m.titel || (m.orgaan === 'commissie' ? `Commissie ${m.commissie || ''}` : 'Gemeenteraad'))}</a><div class="small text-body-secondary">${App.esc(m.datum || '')}</div>` },
      { data: null, render: (m) => `${App.esc(m.input_name)} <span class="badge text-bg-light border">${App.esc(m.input_type)}</span>${m.has_timecodes ? ' <i class="bi bi-clock" title="met tijdcodes"></i>' : ''}` },
      { data: null, render: (m) => (m.agenda_name ? `${App.esc(m.agenda_name)}${m.agenda_format ? ` <span class="badge text-bg-light border">${App.esc(m.agenda_format)}</span>` : ''}` : '<span class="text-body-secondary">geen</span>') },
      { data: null, render: (m) => `${App.badgeStatus(m.prep_status || 'geen')}${m.prep_status === 'bezig' ? `<div class="small text-body-secondary">${App.esc(m.prep_progress || '')}</div>` : ''}` },
      { data: null, render: (m) => (m.points ? `${m.points} <span class="small text-body-secondary">(${m.points_found} gevonden, ${m.points_selected} geselecteerd)</span>` : '') },
      { data: 'runs' },
      { data: null, orderable: false, className: 'text-end text-nowrap', render: (m) => `<a class="btn btn-sm btn-outline-primary" href="vergadering.html?id=${m.id}" title="Openen"><i class="bi bi-list-check"></i></a>
          <button class="btn btn-sm btn-outline-danger m-del" data-id="${m.id}" title="Verwijderen"><i class="bi bi-trash"></i></button>` },
    ],
  });
  loadMeetings();
  $('#meetings').on('click', '.m-del', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!(await App.confirm(`Vergadering ${id} met al haar runs verwijderen?`))) return;
    try { await App.api(`/meetings/${id}`, { method: 'DELETE' }); loadMeetings(); loadRuns(); } catch (err) { App.error(err); }
  });

  $('#runs').on('change', '.sel', (e) => {
    const id = Number(e.target.dataset.id);
    e.target.checked ? selected.add(id) : selected.delete(id);
    updateCompareBtn();
  });
  $('#runs').on('click', '.act-del', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!(await App.confirm(`Run ${id} verwijderen?`))) return;
    try { await App.api(`/runs/${id}`, { method: 'DELETE' }); loadRuns(); } catch (err) { App.error(err); }
  });
  $('#runs').on('click', '.act-stop', async (e) => {
    const id = e.currentTarget.dataset.id;
    if (!(await App.confirm(`Run ${id} stoppen? Afgewerkte delen blijven bewaard; je kan later hervatten.`))) return;
    try { await App.api(`/runs/${id}/stop`, { method: 'POST' }); App.toast('Run gestopt', 'warning'); setTimeout(loadRuns, 800); } catch (err) { App.error(err); }
  });
  $('#runs').on('click', '.act-resume', async (e) => {
    try { await App.api(`/runs/${e.currentTarget.dataset.id}/resume`, { method: 'POST', body: {} }); App.toast('Hervat'); loadRuns(); } catch (err) { App.error(err); }
  });
  $('#runs').on('click', '.act-rerun', (e) => {
    const r = runsTable.rows().data().toArray().find((x) => x.id === Number(e.currentTarget.dataset.id));
    const f = document.getElementById('f-rerun');
    f.meeting_id.value = r.meeting_id;
    document.getElementById('rerun-options').innerHTML = runOptionsHtml('rr', { ...r.options, label: '' });
    App.modal('m-rerun').show();
  });

  document.getElementById('btn-compare').onclick = () => {
    const [a, b] = [...selected].sort((x, y) => x - y);
    location.href = `vergelijk.html?a=${a}&b=${b}`;
  };

  document.getElementById('btn-new').onclick = () => {
    document.getElementById('new-segmodel').placeholder = settings.effective?.segmenter || '';
    App.modal('m-new').show();
  };
  const fNew = document.getElementById('f-new');
  fNew.orgaan.onchange = () => document.querySelector('.commissie-only').classList.toggle('d-none', fNew.orgaan.value !== 'commissie');
  fNew.transcript.onchange = () => {
    const ext = (fNew.transcript.files[0]?.name.split('.').pop() || '').toLowerCase();
    document.getElementById('tc-hint').innerHTML = ['vtt', 'srt'].includes(ext)
      ? '<i class="bi bi-clock text-success"></i> Met tijdcodes: uitvoer als PDF, DOCX én VTT.'
      : '<i class="bi bi-info-circle"></i> Geen tijdcodes: uitvoer als PDF en DOCX (VTT niet mogelijk).';
  };

  fNew.onsubmit = async (e) => {
    e.preventDefault();
    const btn = fNew.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('transcript', fNew.transcript.files[0]);
      if (fNew.agenda.files[0]) fd.append('agenda', fNew.agenda.files[0]);
      for (const k of ['orgaan', 'commissie', 'datum', 'voorzitter', 'titel', 'segmenterModel']) fd.append(k, fNew[k].value);
      const m = await App.api('/meetings', { method: 'POST', form: fd });
      App.modal('m-new').hide();
      fNew.reset();
      location.href = `vergadering.html?id=${m.id}`;
    } catch (err) { App.error(err); } finally { btn.disabled = false; }
  };

  document.getElementById('f-rerun').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { label, options } = readRunOptions(f);
      const r = await App.api('/runs', { method: 'POST', body: { meeting_id: Number(f.meeting_id.value), label, options } });
      App.modal('m-rerun').hide();
      location.href = `run.html?id=${r.id}`;
    } catch (err) { App.error(err); }
  };
});

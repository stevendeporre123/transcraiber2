/* global App, $ */
let settings = {};
let runsTable;
const selected = new Set();

function runOptionsHtml(prefix, opts = {}) {
  const steps = [['normalizer', 'Gentse normalizer'], ['cleaner', 'Transcript cleaner'], ['resolver', 'Speaker resolver'], ['writer', 'Verslag writer'], ['agenda', 'Agenda'], ['intake', 'LLM-intake']];
  return `
    <div class="row g-2">
      <div class="col-md-6"><label class="form-label">Label (optioneel)</label>
        <input class="form-control" name="label" value="${App.esc(opts.label || '')}" placeholder="bv. test Gemini vs Claude"></div>
      <div class="col-md-3"><label class="form-label">Woorden per deel</label>
        <input type="number" class="form-control" name="chunkWords" min="300" max="8000" step="100" value="${App.esc(opts.chunkWords || settings.chunk_words || 2000)}"></div>
      <div class="col-md-3 d-flex flex-column justify-content-end">
        <div class="form-check"><input class="form-check-input" type="checkbox" name="writer" id="${prefix}-writer" ${opts.writer === false ? '' : 'checked'}>
          <label class="form-check-label" for="${prefix}-writer">Verslag met samenvatting</label></div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="llmIntake" id="${prefix}-llmi" ${opts.llmIntake ? 'checked' : ''}>
          <label class="form-check-label" for="${prefix}-llmi" title="Enkel voor rommelige PDF/DOCX zonder duidelijke structuur">Intake via LLM</label></div>
      </div>
    </div>
    <details class="mt-3" ${opts.blockFrom || opts.blockTo || (opts.stopAfter && opts.stopAfter !== 'writer') ? 'open' : ''}><summary class="fw-semibold">Testrun: deel van de input / stoppen na een stap</summary>
      <div class="row g-2 mt-1">
        <div class="col-md-3"><label class="form-label small mb-0">Enkel blokken van</label>
          <input type="number" min="1" class="form-control form-control-sm" name="blockFrom" value="${App.esc(opts.blockFrom || '')}" placeholder="1"></div>
        <div class="col-md-3"><label class="form-label small mb-0">tot en met</label>
          <input type="number" min="1" class="form-control form-control-sm" name="blockTo" value="${App.esc(opts.blockTo || '')}" placeholder="alles"></div>
        <div class="col-md-6"><label class="form-label small mb-0">Stoppen na</label>
          <select class="form-select form-select-sm" name="stopAfter">
            ${[['writer', 'volledige pipeline'], ['normalizer', 'gentse-normalizer'], ['cleaner', 'transcript-cleaner'], ['resolver', 'speaker-resolver']]
              .map(([v, l]) => `<option value="${v}" ${(opts.stopAfter || 'writer') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-text">Blokken bekijk je in de <a href="testen.html">Testbank</a>. Voor één skill op een klein stuk is de Testbank sneller.</div>
    </details>
    <details class="mt-3" ${opts.models ? 'open' : ''}><summary class="fw-semibold">Modellen per stap (OpenRouter)</summary>
      <div class="row g-2 mt-1">
        ${steps.map(([k, l]) => `<div class="col-md-4"><label class="form-label small mb-0">${l}</label>
          <input class="form-control form-control-sm" name="model_${k}" list="models-list" value="${App.esc(opts.models?.[k] || '')}" placeholder="${App.esc(settings.effective?.[k] || '')}"></div>`).join('')}
      </div>
      <div class="form-text">Leeg = standaard uit Instellingen.</div>
    </details>`;
}

function readRunOptions(form) {
  const f = App.readForm(form);
  const models = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('model_') && v) models[k.slice(6)] = v;
  return {
    label: f.label,
    options: {
      chunkWords: Number(f.chunkWords) || undefined, writer: !!f.writer, llmIntake: !!f.llmIntake, models,
      blockFrom: Number(f.blockFrom) || undefined, blockTo: Number(f.blockTo) || undefined, stopAfter: f.stopAfter || 'writer',
    },
  };
}

function modelsSummary(opt) {
  const m = opt?.models || {};
  const uniq = [...new Set(Object.entries(m).filter(([k]) => ['normalizer', 'cleaner', 'resolver', 'writer'].includes(k)).map(([, v]) => v))];
  return uniq.map((x) => `<code class="small">${App.esc(x)}</code>`).join('<br>') || '<span class="text-body-secondary">standaard</span>';
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
          ${r.status === 'fout' ? `<button class="btn btn-sm btn-outline-warning act-resume" data-id="${r.id}" title="Hervatten"><i class="bi bi-play"></i></button>` : ''}
          <button class="btn btn-sm btn-outline-danger act-del" data-id="${r.id}" title="Verwijderen"><i class="bi bi-trash"></i></button>` },
    ],
  });
  loadRuns();

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
    document.getElementById('run-options').innerHTML = runOptionsHtml('new');
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
      for (const k of ['orgaan', 'commissie', 'datum', 'voorzitter', 'titel']) fd.append(k, fNew[k].value);
      const m = await App.api('/meetings', { method: 'POST', form: fd });
      const { label, options } = readRunOptions(fNew);
      const r = await App.api('/runs', { method: 'POST', body: { meeting_id: m.id, label, options } });
      App.modal('m-new').hide();
      fNew.reset();
      location.href = `run.html?id=${r.id}`;
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

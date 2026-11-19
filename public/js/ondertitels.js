/* global App */
// Vergaderingpagina: verbeterde ondertitels (volledige SRT/VTT met de tekst van alle runs).
(() => {
  const mid = Number(new URLSearchParams(location.search).get('id'));
  const $ = (id) => document.getElementById(id);
  let info = null;
  let table = null;
  let selected = new Set();
  let previewSeq = 0;

  const query = () => {
    const fmt = document.querySelector('input[name="sub-format"]:checked')?.value || '';
    return `runs=${[...selected].join(',')}&format=${fmt}&speakers=${$('sub-speakers').checked ? 1 : 0}`;
  };

  function renderSource() {
    const s = info.source;
    $('sub-source').innerHTML = s
      ? `<div class="d-flex align-items-center gap-2"><i class="bi bi-file-earmark-text"></i> <b>${App.esc(s.name)}</b>
          <span class="badge text-bg-light border">${App.esc(s.type)}</span> <span class="small text-body-secondary">${s.cues} cues</span>
          ${s.uploaded ? '<span class="badge text-bg-info">apart opgeladen</span> <button class="btn btn-sm btn-link text-danger p-0 ms-auto" id="sub-remove"><i class="bi bi-x-circle"></i> verwijderen</button>'
            : '<span class="small text-body-secondary">(het transcript zelf)</span>'}</div>
         <div class="form-text">Een ander bestand opladen vervangt het voor deze vergadering.</div>`
      : '<div class="alert alert-warning py-2 mb-0">Deze transcriptie heeft geen tijdcodes. Laad de originele SRT of VTT op; de verbeterde tekst wordt er op tekst in teruggezet.</div>';
    if (s && !document.querySelector('input[name="sub-format"]:checked')) $(`sub-f-${s.type}`).checked = true;
    $('sub-remove')?.addEventListener('click', async () => {
      try { info = await App.api(`/meetings/${mid}/subtitles`, { method: 'DELETE' }); render(); } catch (e) { App.error(e); }
    });
  }

  function renderRuns() {
    const rows = info.runs.filter((r) => r.blocks > 0);
    if (!table) {
      table = App.table('#sub-runs', {
        paging: false, searching: false, info: false, order: [[1, 'desc']],
        columns: [
          { data: null, orderable: false, render: (r) => `<input class="form-check-input sub-run" type="checkbox" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''} ${['bezig', 'wachtrij'].includes(r.status) ? 'disabled' : ''}>` },
          { data: 'id', render: (id, _, r) => `<a href="run.html?id=${id}" target="_blank">#${id}</a> ${App.esc(r.label || '')}` },
          { data: 'status', render: (s) => App.badgeStatus(s) },
          { data: 'blocks' },
          { data: 'edited', render: (n) => (n ? `<span class="badge text-bg-warning">${n}</span>` : '–') },
          { data: 'created_at', render: (d) => `<span class="small">${App.esc(d || '')}</span>` },
        ],
      });
      $('sub-runs').addEventListener('change', (e) => {
        if (!e.target.classList.contains('sub-run')) return;
        const id = Number(e.target.dataset.id);
        if (e.target.checked) selected.add(id); else selected.delete(id);
        preview();
      });
    }
    table.clear().rows.add(rows).draw(false);
  }

  function render() {
    renderSource();
    renderRuns();
    preview();
  }

  async function preview() {
    const dl = $('sub-download');
    const seq = ++previewSeq;
    dl.classList.add('disabled');
    if (!info.source) { $('sub-stats').innerHTML = ''; return; }
    $('sub-stats').innerHTML = '<div class="small text-body-secondary"><span class="spinner-border spinner-border-sm"></span> berekenen…</div>';
    try {
      const st = await App.api(`/meetings/${mid}/subtitles/preview?${query()}`);
      if (seq !== previewSeq) return;
      const missing = st.runs.filter((r) => r.missing);
      $('sub-stats').innerHTML = `<div class="row g-2">
          ${[['Cues in het origineel', st.cues], ['Verbeterd', st.improved], ['Ongewijzigd', st.unchanged], ['Weggevallen (enkel opvullers)', st.dropped]]
            .map(([l, v]) => `<div class="col-6 col-md-3"><div class="border rounded p-2 h-100"><div class="small text-body-secondary">${l}</div><div class="fs-5 fw-semibold">${v}</div></div></div>`).join('')}
        </div>
        ${missing.length ? `<div class="alert alert-warning py-2 mt-2 mb-0 small">${missing.map((r) => `Run #${r.id}: ${r.missing} blok(ken) niet teruggevonden in de ondertitels (die cues blijven ongewijzigd).`).join('<br>')}</div>` : ''}
        ${!selected.size ? '<div class="small text-body-secondary mt-2">Geen runs gekozen: je krijgt het origineel terug.</div>' : ''}`;
      dl.href = `/api/meetings/${mid}/subtitles/download?${query()}`;
      dl.classList.remove('disabled');
    } catch (e) {
      if (seq === previewSeq) $('sub-stats').innerHTML = `<div class="alert alert-danger py-2 mb-0">${App.esc(e.message)}</div>`;
    }
  }

  async function open() {
    try {
      info = await App.api(`/meetings/${mid}/subtitles`);
      selected = new Set(info.runs.filter((r) => r.blocks > 0 && !['bezig', 'wachtrij'].includes(r.status)).map((r) => r.id));
      render();
      App.modal('m-subs').show();
    } catch (e) { App.error(e); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('v-subs').addEventListener('click', open);
    document.querySelectorAll('input[name="sub-format"]').forEach((r) => r.addEventListener('change', preview));
    $('sub-speakers').addEventListener('change', preview);
    $('f-sub-upload').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        info = await App.api(`/meetings/${mid}/subtitles`, { method: 'POST', form: new FormData(e.target) });
        e.target.reset();
        document.querySelectorAll('input[name="sub-format"]').forEach((r) => { r.checked = false; });
        App.toast('Ondertitelbestand opgeladen');
        render();
      } catch (err) { App.error(err); }
    });
  });
})();

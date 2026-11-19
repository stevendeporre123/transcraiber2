/* Nieuwe test: 3 bestanden opladen, model(len) kiezen, starten, voortgang volgen en resultaten per model. */
/* global App, $ */
const $id = (id) => document.getElementById(id);
const scoreBadge = (q) => {
  if (q == null) return '';
  const cls = q >= 85 ? 'success' : q >= 65 ? 'warning' : 'danger';
  return `<span class="badge text-bg-${cls}">${Math.round(q)}</span>`;
};
const LAST_MODELS = 'nieuwetest-models';

// ---------------- Overzicht ----------------
async function initList() {
  $id('v-list').classList.remove('d-none');
  const dt = App.table('#v-tests', {
    order: [[0, 'desc']],
    columns: [
      { data: 'id' },
      { data: 'created_at', className: 'small' },
      { data: null, render: (b) => `${App.esc(b.label || b.input_name || '')}<br><span class="small text-body-secondary">${App.esc(b.input_name || '')}</span>` },
      { data: 'models', className: 'small', render: (m) => m.map((x) => `<code>${App.esc(x)}</code>`).join('<br>') },
      { data: null, render: (b) => `${b.done}/${b.n}` },
      { data: 'best', render: (q, t) => (t === 'display' ? scoreBadge(q) || '–' : q ?? -1) },
      { data: 'cost', render: App.fmtCost },
      { data: 'status', render: App.badgeStatus },
      { data: null, orderable: false, render: (b) => `<button class="btn btn-sm btn-outline-danger v-del" data-id="${b.id}" title="Verwijderen (met de runs en de opgeladen bestanden)"><i class="bi bi-trash"></i></button>` },
    ],
  });
  const reload = async () => {
    const rows = await App.api('/newtests');
    dt.clear().rows.add(rows).draw(false);
    return rows;
  };
  $('#v-tests').on('click', 'tbody tr', function (e) {
    if (e.target.closest('.v-del')) return;
    const d = dt.row(this).data();
    if (d) location.href = `nieuwetest.html?id=${d.id}`;
  });
  $('#v-tests').on('click', '.v-del', async (e) => {
    if (!(await App.confirm('Test verwijderen, samen met de runs en de opgeladen bestanden?'))) return;
    try { await App.api(`/newtests/${e.currentTarget.dataset.id}`, { method: 'DELETE' }); reload(); } catch (err) { App.error(err); }
  });
  initModal();
  const rows = await reload();
  if (!rows.length || new URLSearchParams(location.search).has('nieuw')) App.modal('n-modal').show();
  setInterval(() => { if (dt.data().toArray().some((b) => b.status === 'bezig')) reload().catch(() => {}); }, 5000);
}

function initModal() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(LAST_MODELS) || '[]'); } catch { /* geen opslag */ }
  const picker = App.modelPicker($id('n-models'), saved, { min: 1 });
  const form = $id('n-form');
  const syncSoort = () => {
    const verslag = $id('n-soort').value === 'verslag';
    $id('n-writer').checked = verslag || $id('n-writer').checked;
    $id('n-writer').disabled = verslag;
  };
  $id('n-soort').onchange = syncSoort;
  $id('n-orgaan').onchange = () => { $id('n-commissie').disabled = $id('n-orgaan').value !== 'commissie'; };
  $id('v-new').onclick = () => App.modal('n-modal').show();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const models = picker.get();
    if (!models.length) { App.toast('Kies minstens één model.', 'warning'); return; }
    const fd = new FormData(form);
    fd.set('models', JSON.stringify(models));
    fd.set('writer', $id('n-writer').checked ? '1' : '0');
    for (const k of ['titel', 'commissie', 'datum']) if (!String(fd.get(k) || '').trim()) fd.delete(k);
    const btn = $id('n-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Opladen…';
    $id('n-info').textContent = 'Bestanden worden opgeladen en gecontroleerd';
    try {
      const { id } = await App.api('/newtests', { method: 'POST', form: fd });
      try { localStorage.setItem(LAST_MODELS, JSON.stringify(models)); } catch { /* geen opslag */ }
      location.href = `nieuwetest.html?id=${id}`;
    } catch (err) {
      App.error(err);
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-play-fill"></i> Starten';
      $id('n-info').textContent = '';
    }
  };
  syncSoort();
}

// ---------------- Detail ----------------
/** Ruwe schatting van de voortgang (0-100) uit de voortgangstekst van een run. */
function percent(r, writer) {
  if (r.status === 'klaar') return 100;
  const p = r.progress || '';
  const frac = (() => { const m = p.match(/(\d+)\/(\d+)/); return m ? Number(m[1]) / Math.max(1, Number(m[2])) : 0; })();
  const end = writer ? 85 : 100;
  if (/^Normaliseren/.test(p)) return 5 + frac * 60;
  if (/^Sprekers/.test(p)) return 65 + frac * (end - 65);
  if (/Samenvatting|Verslag/.test(p)) return 85 + frac * 15;
  if (/Intake|Agenda/.test(p)) return 3;
  return 0;
}

function progressHtml(rows, writer) {
  const busy = rows.filter((r) => !['klaar', 'fout', 'gestopt'].includes(r.status));
  if (!busy.length) return '';
  return `<div class="card"><div class="card-body py-2">${rows.map((r) => {
    const pct = Math.round(percent(r, writer));
    const done = r.status === 'klaar';
    const failed = ['fout', 'gestopt'].includes(r.status);
    const cls = done ? 'bg-success' : failed ? 'bg-danger' : 'progress-bar-striped progress-bar-animated';
    const label = done ? 'klaar' : failed ? r.status : r.status === 'wachtrij' ? 'in de wachtrij' : (r.progress || 'bezig');
    return `<div class="row align-items-center g-2 mb-1">
      <div class="col-md-3 text-truncate"><code>${App.esc(r.model)}</code></div>
      <div class="col-md-6"><div class="progress" style="height: 1.1rem"><div class="progress-bar ${cls}" style="width: ${failed ? 100 : Math.max(pct, 3)}%">${done ? '' : `${pct}%`}</div></div></div>
      <div class="col-md-3 small text-body-secondary">${App.esc(label)}${r.cost ? ` · ${App.fmtCost(r.cost)}` : ''}</div></div>`;
  }).join('')}<div class="small text-body-secondary mt-1"><span class="spinner-border spinner-border-sm"></span> Bezig. Deze pagina ververst vanzelf; je mag ze ook sluiten en later terugkomen.</div></div></div>`;
}

function bestCards(rows) {
  const ok = rows.filter((r) => r.status === 'klaar');
  if (!ok.length) return '';
  const min = (key) => ok.filter((r) => r[key] != null).reduce((a, r) => (a && a[key] <= r[key] ? a : r), null);
  const card = (icon, label, r, val) => (r ? `<div class="col-6 col-lg-3"><div class="card h-100"><div class="card-body py-2">
      <div class="small text-body-secondary"><i class="bi ${icon}"></i> ${label}</div><div class="fw-semibold text-truncate"><code>${App.esc(r.model)}</code></div><div class="small">${val}</div></div></div></div>` : '');
  const scored = ok.filter((r) => r.quality != null);
  const best = scored.length ? scored.reduce((a, r) => (a.quality >= r.quality ? a : r)) : null;
  const cheap = min('cost'); const fast = min('wall_ms');
  const total = rows.reduce((n, r) => n + (r.cost || 0), 0);
  if (ok.length === 1) {
    const r = ok[0];
    return card('bi-trophy', 'Score', r, r.quality != null ? `${Math.round(r.quality)} / 100` : '–')
      + card('bi-cash-coin', 'Kost', r, App.fmtCost(r.cost))
      + card('bi-stopwatch', 'Duur', r, App.fmtMs(r.wall_ms ?? r.ms))
      + card('bi-123', 'Tokens', r, `${r.tokens_in} in / ${r.tokens_out} uit`);
  }
  return (best ? card('bi-trophy', 'Hoogste score', best, `${Math.round(best.quality)} / 100`) : '')
    + card('bi-piggy-bank', 'Goedkoopst', cheap, App.fmtCost(cheap?.cost))
    + card('bi-lightning', 'Snelst', fast, App.fmtMs(fast?.wall_ms))
    + `<div class="col-6 col-lg-3"><div class="card h-100"><div class="card-body py-2"><div class="small text-body-secondary"><i class="bi bi-cash-stack"></i> Totaal test</div>
      <div class="fw-semibold">${App.fmtCost(total)}</div><div class="small">${ok.length} van ${rows.length} modellen klaar</div></div></div></div>`;
}

function scoreDetailHtml(r) {
  const d = r.quality_detail;
  if (!d) return '<p class="text-body-secondary">Nog geen score.</p>';
  const partRows = (parts) => parts.map((p) => `<tr><td>${App.esc(p.label)}</td><td>${p.score == null ? '–' : scoreBadge(p.score)}</td><td class="small">${App.esc(p.detail || '')}
    ${p.voorbeelden ? Object.entries(p.voorbeelden).filter(([, v]) => v.length).map(([k, v]) => `<div class="text-body-secondary"><b>${App.esc(k)}:</b> ${v.map(App.esc).join(', ')}</div>`).join('') : ''}</td></tr>`).join('');
  let html = `<p>Eindscore ${scoreBadge(r.quality)} = gewogen gemiddelde van de referentiescore (weegt 4) en de automatische score (weegt 3).</p>`;
  if (d.gold) {
    html += `<h6>R · Gewenst eindresultaat ${scoreBadge(d.gold.score)} <small class="text-body-secondary fw-normal">${App.esc(d.gold.naam || '')} (${App.esc(d.gold.soort || '')}), ${App.esc(d.gold.method || '')}</small></h6>
      <table class="table table-sm"><tbody>${partRows(d.gold.parts || [])}</tbody></table>`;
  } else html += '<p class="text-body-secondary">Geen gewenst eindresultaat gekoppeld.</p>';
  html += `<h6>A · Automatisch ${scoreBadge(d.auto?.score)}</h6><table class="table table-sm"><tbody>${partRows(d.auto?.parts || [])}</tbody></table>`;
  return html;
}

async function initDetail(id) {
  $id('v-detail').classList.remove('d-none');
  let test = null;
  let timer = null;
  let scoreRow = null;
  const subUrl = (r, fmt = 'srt') => `/api/meetings/${test.meeting_id}/subtitles/download?runs=${r.id}&format=${fmt}`;
  const dt = App.table('#d-rows', {
    order: [[6, 'desc']], paging: false, searching: false, info: false,
    columns: [
      { data: 'model', render: (m) => `<code>${App.esc(m)}</code>` },
      { data: null, render: (r) => `${App.badgeStatus(r.status)}${r.status === 'bezig' && r.progress ? `<br><span class="small text-body-secondary">${App.esc(r.progress)}</span>` : ''}${r.error && r.status !== 'klaar' ? `<br><span class="small text-danger">${App.esc(r.error.slice(0, 160))}</span>` : ''}` },
      { data: 'tokens_in', render: (v) => v ?? '' },
      { data: 'tokens_out', render: (v) => v ?? '' },
      { data: 'cost', render: (v, t) => (t === 'display' ? App.fmtCost(v) : v ?? Infinity) },
      { data: null, render: (r, t) => {
        const v = r.wall_ms ?? r.ms;
        if (t !== 'display') return v ?? Infinity;
        return `${App.fmtMs(v)}${r.ms_net != null ? `<br><span class="small text-body-secondary" title="Netto modeltijd (opgeteld over alle aanroepen, ook parallelle)">${App.fmtMs(r.ms_net)} netto</span>` : ''}`;
      } },
      { data: 'quality', render: (q, t, r) => {
        if (t !== 'display') return q ?? -1;
        if (q == null) return r.status === 'klaar' ? '<button class="btn btn-sm btn-outline-secondary d-score" title="Score berekenen">bereken</button>' : '';
        const parts = [['R', r.quality_gold], ['A', r.quality_auto]].filter(([, v]) => v != null).map(([k, v]) => `${k}${Math.round(v)}`).join(' ');
        return `<a href="#" class="d-score text-decoration-none">${scoreBadge(q)} <span class="small text-body-secondary">${parts}</span></a>`;
      } },
      { data: null, orderable: false, className: 'text-nowrap', render: (r) => (r.status === 'klaar' ? `
        <a class="btn btn-sm btn-primary" href="${subUrl(r)}" title="Verbeterde SRT downloaden"><i class="bi bi-download"></i> SRT</a>
        <a class="btn btn-sm btn-outline-secondary" href="run.html?id=${r.id}" title="Uitvoer bekijken"><i class="bi bi-eye"></i></a>
        <a class="btn btn-sm btn-outline-secondary" href="/api/runs/${r.id}/log.txt" title="Log"><i class="bi bi-journal-text"></i></a>`
        : `<a class="btn btn-sm btn-outline-secondary" href="run.html?id=${r.id}" title="Run bekijken"><i class="bi bi-eye"></i></a>`) },
    ],
  });
  $('#d-rows').on('click', '.d-score', async function (e) {
    e.preventDefault();
    const r = dt.row(this.closest('tr')).data();
    if (r.quality == null) {
      try { await App.api(`/runs/${r.id}/score`, { method: 'POST' }); await load(); } catch (err) { App.error(err); }
      return;
    }
    scoreRow = r;
    $id('s-title').innerHTML = `Kwaliteitsscore <code>${App.esc(r.model)}</code>`;
    $id('s-body').innerHTML = scoreDetailHtml(r);
    App.modal('s-modal').show();
  });
  $id('s-rescore').onclick = async () => {
    if (!scoreRow) return;
    try {
      await App.api(`/runs/${scoreRow.id}/score`, { method: 'POST' });
      await load();
      scoreRow = test.rows.find((x) => x.id === scoreRow.id);
      $id('s-body').innerHTML = scoreDetailHtml(scoreRow);
      App.toast('Score opnieuw berekend');
    } catch (err) { App.error(err); }
  };

  const tick = () => {
    if (!test) return;
    const start = Date.parse(`${test.created_at.replace(' ', 'T')}Z`);
    const end = test.finished_at ? Date.parse(`${test.finished_at.replace(' ', 'T')}Z`) : Date.now();
    $id('d-elapsed').textContent = Number.isFinite(start) ? `${test.active ? 'loopt' : 'duurde'} ${App.fmtMs(Math.max(0, end - start))}` : '';
  };
  const load = async () => {
    try { test = await App.api(`/newtests/${id}`); } catch (e) { App.error(e); clearInterval(timer); timer = null; return; }
    const m = test.meeting || {};
    const writer = test.step === 'writer';
    $id('d-title').textContent = `Test #${test.id}: ${test.label || m.titel || m.input_name || ''}`;
    $id('d-status').innerHTML = App.badgeStatus(test.status);
    $id('d-meta').innerHTML = [
      m.input_name ? `<i class="bi bi-file-earmark-text"></i> ${App.esc(m.input_name)}` : '',
      m.subtitle_name ? `<i class="bi bi-badge-cc"></i> ${App.esc(m.subtitle_name)}` : '',
      test.gold ? `<i class="bi bi-bullseye"></i> ${App.esc(test.gold.naam)} (${test.gold.soort === 'verslag' ? 'verslag' : 'letterlijke transcriptie'})` : '',
      writer ? 'met verslag' : 'tot en met sprekers (geen verslag)',
      `${test.options?.concurrency || 1} tegelijk`,
      m.id ? `<a href="vergadering.html?id=${m.id}">vergadering #${m.id}</a>` : '',
    ].filter(Boolean).join(' · ');
    $id('d-stop').classList.toggle('d-none', !test.active);
    $id('d-progress').innerHTML = progressHtml(test.rows, writer);
    $id('d-best').innerHTML = bestCards(test.rows);
    dt.clear().rows.add(test.rows).draw(false);
    tick();
    const running = test.active || test.rows.some((r) => ['bezig', 'wachtrij'].includes(r.status));
    if (!running && timer) {
      clearInterval(timer); timer = null;
      if (test.status === 'klaar') App.toast('Test klaar');
    }
  };
  await load();
  if (test?.active || test?.rows.some((r) => ['bezig', 'wachtrij'].includes(r.status))) timer = setInterval(load, 3000);
  setInterval(() => { if (timer) tick(); }, 1000);

  $id('d-stop').onclick = async () => {
    try { await App.api(`/batches/${id}/stop`, { method: 'POST' }); App.toast('Stoppen gevraagd'); load(); } catch (e) { App.error(e); }
  };
  $id('d-delete').onclick = async () => {
    if (!(await App.confirm('Test verwijderen, samen met de runs en de opgeladen bestanden?'))) return;
    try { await App.api(`/newtests/${id}`, { method: 'DELETE' }); location.href = 'nieuwetest.html'; } catch (e) { App.error(e); }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const id = Number(new URLSearchParams(location.search).get('id'));
  (id ? initDetail(id) : initList()).catch(App.error);
});

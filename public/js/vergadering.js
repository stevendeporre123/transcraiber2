/* global App, $ */
const meetingId = Number(new URLSearchParams(location.search).get('id'));
let data = null;
let settings = {};
let pointsTable;
let segTable;
let logTable;
let logLastId = 0;
let currentSeg = null;
let placePoint = null;
let pollTimer = null;

const $id = (id) => document.getElementById(id);
const pointLabel = (p) => `${p.nummer ? `${p.nummer} · ` : ''}${p.titel}`;
const segmentsOf = (pid) => data.segments.filter((s) => s.point_ids.includes(pid));
const timeRange = (s) => (s.t_start != null ? `${App.fmtTime(s.t_start)}–${App.fmtTime(s.t_end)}` : '');
const ZEKER = { hoog: 'success', middel: 'warning', laag: 'danger' };

async function load() {
  data = await App.api(`/meetings/${meetingId}/prep`);
  render();
  const busy = data.meeting.preparing || data.meeting.prep_status === 'bezig';
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(load, 2500);
  loadLog();
}

async function loadLog() {
  const rows = await App.api(`/meetings/${meetingId}/prep-log?after=${logLastId}`);
  if (!rows.length) return;
  logLastId = rows[rows.length - 1].id;
  logTable.rows.add(rows).draw(false);
}

function render() {
  const m = data.meeting;
  const title = m.titel || `${m.orgaan === 'commissie' ? `Commissie ${m.commissie || ''}` : 'Gemeenteraad'}${m.datum ? ` ${m.datum}` : ''}`;
  $id('v-title').textContent = title;
  document.title = `${title} · Transcraiber`;
  $id('v-meta').innerHTML = [
    `${App.esc(m.input_name)} <span class="badge text-bg-light border">${App.esc(m.input_type)}</span>${m.has_timecodes ? ' <i class="bi bi-clock" title="met tijdcodes"></i>' : ''}`,
    m.agenda_name ? `agenda: ${App.esc(m.agenda_name)}${m.agenda_format ? ` <span class="badge text-bg-light border" title="in code ingelezen">${App.esc(m.agenda_format)}</span>` : ''}` : '<span class="text-warning">geen agenda</span>',
  ].join(' · ');

  const busy = m.preparing || m.prep_status === 'bezig';
  $id('v-stop').classList.toggle('d-none', !busy);
  $id('v-redo-btn').disabled = busy;
  $id('v-status').innerHTML = busy
    ? `<div class="alert alert-info py-2 mb-0 d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm"></div> Voorbereiding: ${App.esc(m.prep_progress || 'bezig')}</div>`
    : m.prep_status === 'fout' || m.prep_status === 'gestopt'
      ? `<div class="alert alert-${m.prep_status === 'fout' ? 'danger' : 'warning'} py-2 mb-0"><i class="bi bi-exclamation-triangle"></i> ${App.esc(m.prep_error || m.prep_status)} — zie "Log voorbereiding", en kies "Opnieuw voorbereiden".</div>`
      : m.prep_status === 'geen' ? '<div class="alert alert-light border py-2 mb-0">Nog niet voorbereid. Kies "Opnieuw voorbereiden → Alles".</div>' : '';

  const found = new Set(data.segments.flatMap((s) => s.point_ids));
  const sel = data.points.filter((p) => p.selected);
  const selFound = sel.filter((p) => found.has(p.id));
  const types = data.points.reduce((a, p) => ({ ...a, [p.type]: (a[p.type] || 0) + 1 }), {});
  const card = (label, value, sub = '') => `<div class="col-6 col-md-2"><div class="border rounded p-2 h-100"><div class="small text-body-secondary">${label}</div><div class="fs-5 fw-semibold">${value}</div><div class="small text-body-secondary">${sub}</div></div></div>`;
  $id('v-stats').innerHTML = [
    card('Transcriptie', `${data.blocks.n || 0} blokken`, `${data.blocks.words || 0} woorden${data.blocks.dur ? ` · ${App.fmtTime(data.blocks.dur)}` : ''}`),
    card('Agendapunten', data.points.length, Object.entries(types).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')),
    card('Teruggevonden', `${found.size} / ${data.points.length}`, `${data.segments.length} segmenten`),
    card('Geselecteerd', `${sel.length}`, `${selFound.length} daarvan in de transcriptie`),
  ].join('');
  $id('v-sel-info').textContent = `${sel.length} geselecteerd, ${selFound.length} worden verwerkt`;
  $id('v-run').disabled = busy || !selFound.length || m.prep_status !== 'klaar';
  $id('v-run').innerHTML = `<i class="bi bi-play-fill"></i> Verwerk ${selFound.length} punt${selFound.length === 1 ? '' : 'en'}`;

  const ft = $id('v-filter-type');
  if (ft.options.length === 1) ft.innerHTML += Object.keys(types).map((t) => `<option value="${t}">${t.replace('_', ' ')}</option>`).join('');

  const ftype = $id('v-filter-type').value;
  const onlySel = $id('v-only-sel').checked;
  pointsTable.clear().rows.add(data.points.filter((p) => (!ftype || p.type === ftype) && (!onlySel || p.selected))).draw(false);
  segTable.clear().rows.add(data.segments).draw(false);
  $id('v-runs').innerHTML = data.runs.length
    ? `<ul class="mb-0">${data.runs.map((r) => `<li><a href="run.html?id=${r.id}">Run #${r.id}</a> ${App.badgeStatus(r.status)} ${App.esc(r.label || '')} <span class="small text-body-secondary">${App.esc(r.created_at)} · ${App.fmtCost(r.cost)}</span></li>`).join('')}</ul>`
    : '<p class="text-body-secondary mb-0">Nog geen runs.</p>';
}

// ---------- tekstweergave met "Begin hier" ----------
function blockHtml(b, { inSeg = true, highlight = '' } = {}) {
  let text = App.esc(b.text);
  if (highlight) {
    const re = new RegExp(highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return `<div class="border-bottom py-2 ${inSeg ? '' : 'opacity-50'}" data-ord="${b.ord}">
    <div class="d-flex align-items-center gap-2 mb-1">
      <b class="small">${b.block_id}</b> <span class="ts">${App.fmtTime(b.t_start)}</span>
      <button class="btn btn-sm btn-outline-primary py-0 ms-auto b-start" data-ord="${b.ord}"><i class="bi bi-scissors"></i> Begin hier</button>
    </div>
    <div class="b-text" data-ord="${b.ord}">${text}</div></div>`;
}

/** Geselecteerde tekst binnen één blok → citaat (max. 15 woorden) */
function selectionIn(ord) {
  const s = window.getSelection();
  if (!s || s.isCollapsed) return null;
  const el = s.anchorNode?.parentElement?.closest('.b-text');
  if (!el || Number(el.dataset.ord) !== Number(ord)) return null;
  return s.toString().trim().split(/\s+/).slice(0, 15).join(' ') || null;
}

async function openSegment(seg) {
  currentSeg = seg;
  const pts = seg.point_ids.map((id) => data.points.find((p) => p.id === id)).filter(Boolean);
  $id('s-title').innerHTML = `Segment ${seg.index + 1}: ${App.esc(pts.length ? pts.map(pointLabel).join(' + ') : seg.label || 'Overig')} <small class="ts">${timeRange(seg)}</small>`;
  $id('s-points').innerHTML = data.points.map((p) => `<option value="${p.id}" ${seg.point_ids.includes(p.id) ? 'selected' : ''}>${App.esc(pointLabel(p).slice(0, 140))}</option>`).join('');
  $id('s-label').value = seg.label || '';
  const blocks = await App.api(`/meetings/${meetingId}/text?from=${Math.max(0, seg.first_ord - 2)}&to=${seg.last_ord + 2}`);
  $id('s-text').innerHTML = blocks.map((b) => blockHtml(b, { inSeg: b.segment_id === seg.id })).join('');
  App.modal('m-seg').show();
}

async function openPlace(point) {
  placePoint = point;
  $id('p-name').textContent = pointLabel(point).slice(0, 100);
  $id('p-search').value = (point.indieners || [])[0]?.split(' ').slice(-1)[0] || '';
  await renderPlace();
  App.modal('m-place').show();
}

async function renderPlace() {
  const all = await App.api(`/meetings/${meetingId}/text?from=0`);
  const q = $id('p-search').value.trim();
  const list = q ? all.filter((b) => b.text.toLowerCase().includes(q.toLowerCase())) : all;
  $id('p-text').innerHTML = (list.length ? list : all).map((b) => blockHtml(b, { highlight: q })).join('') || '<p>Geen tekst.</p>';
}

// ---------- verwerken ----------
function openRun() {
  const found = new Set(data.segments.flatMap((s) => s.point_ids));
  const sel = data.points.filter((p) => p.selected && found.has(p.id));
  const segs = data.segments.filter((s) => s.point_ids.some((id) => sel.some((p) => p.id === id)));
  const words = segs.reduce((n, s) => n + s.words, 0);
  $id('r-summary').innerHTML = `<b>${sel.length} agendapunt(en)</b> in ${segs.length} segment(en), ±${words} woorden. Elk punt wordt apart verwerkt, met de fiche van het punt als context.`;
  $id('r-options').innerHTML = App.runOptionsHtml('vr', { prepared: true }, settings);
  App.modal('m-run').show();
}

document.addEventListener('DOMContentLoaded', async () => {
  await App.loadMeta();
  App.modelDatalist();
  settings = await App.api('/settings').catch(() => ({}));

  pointsTable = App.table('#v-points', {
    order: [], pageLength: 100,
    columns: [
      { data: 'selected', orderable: false, render: (s, t, p) => `<input type="checkbox" class="form-check-input p-sel" data-id="${p.id}" ${s ? 'checked' : ''}>` },
      { data: 'nummer', render: (n) => `<span class="text-nowrap">${App.esc(n || '')}</span>` },
      { data: 'type', render: (t, type) => (type === 'filter' || type === 'sort' ? t : App.typeBadge(t)) },
      {
        data: null, render: (p) => `<div>${App.esc(p.titel)}</div><div class="small text-body-secondary">${App.esc((p.indieners || []).join(', '))}${p.bevoegd ? ` → ${App.esc(p.bevoegd)}` : ''}${p.code ? ` · ${App.esc(p.code)}` : ''}</div>`,
      },
      {
        data: null, render: (p) => {
          const segs = segmentsOf(p.id);
          if (!segs.length) return '<span class="badge text-bg-light border text-danger">niet gevonden</span>';
          return segs.map((s) => `<a href="#" class="seg-link text-decoration-none" data-seg="${s.id}"><span class="ts">${timeRange(s)}</span> ${s.first_block}–${s.last_block} · ${s.words} w
            <span class="badge text-bg-${ZEKER[s.zekerheid] || 'secondary'}">${App.esc(s.zekerheid || '')}</span>${s.point_ids.length > 1 ? ' <span class="badge text-bg-light border" title="samen behandeld">+' + (s.point_ids.length - 1) + '</span>' : ''}</a>`).join('<br>');
        },
      },
      {
        data: null, orderable: false, className: 'text-end text-nowrap',
        render: (p) => (segmentsOf(p.id).length
          ? `<button class="btn btn-sm btn-outline-secondary p-open" data-id="${p.id}" title="Tekst bekijken / grens verleggen"><i class="bi bi-scissors"></i></button>`
          : `<button class="btn btn-sm btn-outline-primary p-place" data-id="${p.id}" title="Begin manueel aanduiden"><i class="bi bi-geo-alt"></i></button>`),
      },
    ],
    createdRow: (row, p) => { if (!p.selected) row.classList.add('text-body-tertiary'); },
  });
  $id('v-filter-type').onchange = render;
  $id('v-only-sel').onchange = render;

  segTable = App.table('#v-segments', {
    order: [], pageLength: 100,
    columns: [
      { data: 'index', render: (i) => i + 1 },
      { data: null, render: (s) => `<span class="ts">${timeRange(s)}</span>` },
      { data: null, render: (s) => `${s.first_block || '-'}–${s.last_block || '-'}` },
      { data: 'words' },
      {
        data: null, render: (s) => (s.point_ids.length
          ? s.point_ids.map((id) => data.points.find((p) => p.id === id)).filter(Boolean).map((p) => `${App.typeBadge(p.type)} ${App.esc(pointLabel(p).slice(0, 110))}`).join('<br>')
          : `<i class="text-body-secondary">${App.esc(s.label || 'Overig')}</i>`),
      },
      { data: 'zekerheid', render: (z) => (z ? `<span class="badge text-bg-${ZEKER[z] || 'secondary'}">${App.esc(z)}</span>` : '') },
      { data: null, render: (s) => `<span class="small">${App.esc(s.bewijs || '')}${s.bron === 'manueel' ? ' <span class="badge text-bg-info">manueel</span>' : ''}</span>` },
      { data: null, orderable: false, render: () => '<button class="btn btn-sm btn-outline-secondary"><i class="bi bi-scissors"></i></button>' },
    ],
  });
  $('#v-segments').on('click', 'tbody tr', function () { const s = segTable.row(this).data(); if (s) openSegment(s); });

  logTable = App.table('#v-log', {
    order: [], pageLength: 50, searching: false,
    columns: [
      { data: 'ts', render: (t) => `<span class="ts">${App.esc((t || '').slice(11, 19))}</span>` },
      { data: 'level', render: (l) => `<span class="badge text-bg-${{ info: 'primary', warn: 'warning', error: 'danger', debug: 'secondary' }[l] || 'secondary'}">${l}</span>` },
      { data: 'step', render: (s) => App.esc(s || '') },
      { data: null, className: 'cell-text', render: (r) => `${App.esc(r.message)}${r.data ? `<details><summary class="small">details</summary><pre class="io">${App.esc(JSON.stringify(JSON.parse(r.data), null, 2))}</pre></details>` : ''}` },
    ],
  });

  // selectie
  $('#v-points').on('change', '.p-sel', async (e) => {
    try { await App.api(`/meetings/${meetingId}/points/${e.target.dataset.id}`, { method: 'PUT', body: { selected: e.target.checked ? 1 : 0 } }); } catch (err) { App.error(err); }
    load();
  });
  document.querySelectorAll('.v-sel').forEach((b) => b.addEventListener('click', async () => {
    try { await App.api(`/meetings/${meetingId}/points/select`, { method: 'POST', body: { mode: b.dataset.mode, type: b.dataset.type } }); } catch (err) { App.error(err); }
    load();
  }));
  $('#v-points').on('click', '.seg-link', (e) => { e.preventDefault(); openSegment(data.segments.find((s) => s.id === Number(e.currentTarget.dataset.seg))); });
  $('#v-points').on('click', '.p-open', (e) => openSegment(segmentsOf(Number(e.currentTarget.dataset.id))[0]));
  $('#v-points').on('click', '.p-place', (e) => openPlace(data.points.find((p) => p.id === Number(e.currentTarget.dataset.id))));

  // segment-modal
  $('#s-text').on('click', '.b-start', async (e) => {
    const ord = Number(e.currentTarget.dataset.ord);
    try {
      await App.api(`/segments/${currentSeg.id}`, { method: 'PUT', body: { ord, citaat: selectionIn(ord) } });
      App.toast('Grens verlegd');
      await load();
      openSegment(data.segments.find((s) => s.id === currentSeg.id));
    } catch (err) { App.error(err); }
  });
  $id('s-save-points').onclick = async () => {
    const pointIds = [...$id('s-points').selectedOptions].map((o) => Number(o.value));
    try {
      await App.api(`/segments/${currentSeg.id}`, { method: 'PUT', body: { pointIds, label: $id('s-label').value || null } });
      App.toast('Koppeling opgeslagen');
      App.modal('m-seg').hide();
      load();
    } catch (err) { App.error(err); }
  };
  $id('s-delete').onclick = async () => {
    if (!(await App.confirm('Segment verwijderen? Het stuk wordt bij het vorige segment gevoegd.'))) return;
    await App.api(`/segments/${currentSeg.id}`, { method: 'DELETE' });
    App.modal('m-seg').hide();
    load();
  };

  // punt manueel aanduiden
  let searchTimer;
  $id('p-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderPlace, 300); });
  $('#p-text').on('click', '.b-start', async (e) => {
    const ord = Number(e.currentTarget.dataset.ord);
    try {
      await App.api(`/meetings/${meetingId}/segments`, { method: 'POST', body: { ord, citaat: selectionIn(ord), pointIds: [placePoint.id] } });
      App.toast('Segment toegevoegd');
      App.modal('m-place').hide();
      load();
    } catch (err) { App.error(err); }
  });

  // opnieuw voorbereiden / stoppen / verwerken
  document.querySelectorAll('.v-redo').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const steps = a.dataset.steps.split(',');
    const warn = steps.includes('intake') ? 'De transcriptie wordt opnieuw ingelezen; manuele grenzen gaan verloren.' : 'Manuele grenzen gaan verloren.';
    if (!(await App.confirm(`${a.textContent.trim()}? ${warn}`))) return;
    try { await App.api(`/meetings/${meetingId}/prepare`, { method: 'POST', body: { steps } }); setTimeout(load, 500); } catch (err) { App.error(err); }
  }));
  $id('v-stop').onclick = async () => { await App.api(`/meetings/${meetingId}/prepare/stop`, { method: 'POST' }); setTimeout(load, 800); };
  $id('v-run').onclick = openRun;
  $id('f-run').onsubmit = async (e) => {
    e.preventDefault();
    const { label, options } = App.readRunOptions(e.target);
    try {
      const r = await App.api('/runs', { method: 'POST', body: { meeting_id: meetingId, label, options } });
      location.href = `run.html?id=${r.id}`;
    } catch (err) { App.error(err); }
  };

  load().catch(App.error);
});

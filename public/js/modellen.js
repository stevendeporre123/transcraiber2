/* Modelvergelijking: overzicht van vergelijkingen en resultaten per model. */
/* global App, $ */
const $id = (id) => document.getElementById(id);
const STEP_LABEL = { normalizer: 'gentse-normalizer', cleaner: 'transcript-cleaner', resolver: 'speaker-resolver', writer: 'verslag-writer', agenda: 'agenda-extractor', intake: 'transcript-intake' };
let prices = new Map();

// ---------------- Overzicht ----------------
async function initList() {
  $id('v-list').classList.remove('d-none');
  const dt = App.table('#v-batches', {
    order: [[0, 'desc']],
    columns: [
      { data: 'id' },
      { data: 'created_at', className: 'small' },
      { data: 'mode', render: (m) => (m === 'step' ? '<span class="badge text-bg-info">stap</span>' : '<span class="badge text-bg-primary">pipeline</span>') },
      { data: null, render: (b) => (b.mode === 'step' ? STEP_LABEL[b.step] || b.step : (b.step === 'writer' ? 'volledig' : `tot ${STEP_LABEL[b.step] || b.step}`)) },
      { data: null, className: 'small', render: (b) => `${App.esc(b.titel || b.input_name || (b.meeting_id ? `#${b.meeting_id}` : 'eigen tekst'))}<br><span class="text-body-secondary">${App.esc(b.input_desc || '')}</span>` },
      { data: 'label', render: (l) => App.esc(l || '') },
      { data: 'models', className: 'small', render: (m) => m.map((x) => `<code>${App.esc(x)}</code>`).join('<br>') },
      { data: null, render: (b) => `${b.done}/${b.n}` },
      { data: 'cost', render: App.fmtCost },
      { data: 'status', render: App.badgeStatus },
      { data: null, orderable: false, render: (b) => `<button class="btn btn-sm btn-outline-danger v-del" data-id="${b.id}" title="Verwijderen (met de tests/runs)"><i class="bi bi-trash"></i></button>` },
    ],
  });
  const reload = async () => dt.clear().rows.add(await App.api('/batches')).draw(false);
  $('#v-batches').on('click', 'tbody tr', function (e) {
    if (e.target.closest('.v-del')) return;
    const d = dt.row(this).data();
    if (d) location.href = `modellen.html?id=${d.id}`;
  });
  $('#v-batches').on('click', '.v-del', async (e) => {
    if (!(await App.confirm('Vergelijking verwijderen, samen met de bijhorende tests of runs?'))) return;
    try { await App.api(`/batches/${e.currentTarget.dataset.id}`, { method: 'DELETE' }); reload(); } catch (err) { App.error(err); }
  });
  await reload();
  setInterval(() => { if (dt.data().toArray().some((b) => b.status === 'bezig')) reload().catch(() => {}); }, 5000);
  initPipelineModal();
}

async function initPipelineModal() {
  const picker = App.modelPicker($id('p-models'));
  let meetings = [];
  const info = () => {
    const m = meetings.find((x) => String(x.id) === $id('p-meeting').value);
    $id('p-meeting-info').textContent = !m ? ''
      : m.prep_status === 'klaar' ? `Voorbereid: ${m.points_selected} van ${m.points} agendapunten geselecteerd (aanpassen op de vergaderpagina).`
        : m.prep_status === 'bezig' ? 'De voorbereiding loopt nog.' : 'Niet voorbereid: de hele transcriptie (of het blokbereik) wordt verwerkt.';
  };
  $id('v-new').onclick = async () => {
    try {
      meetings = await App.api('/meetings');
      $id('p-meeting').innerHTML = meetings.map((m) => `<option value="${m.id}">#${m.id} ${App.esc(m.titel || m.input_name)} ${App.esc(m.datum || '')}</option>`).join('');
      info();
      App.modal('p-modal').show();
    } catch (e) { App.error(e); }
  };
  $id('p-meeting').onchange = info;
  $id('p-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = App.readForm(e.target);
    const models = picker.get();
    if (models.length < 2) { App.toast('Kies minstens twee modellen.', 'warning'); return; }
    try {
      const { id } = await App.api('/batches', {
        method: 'POST',
        body: {
          mode: 'pipeline', meetingId: f.meetingId, stopAfter: f.stopAfter, models, label: f.label,
          blockFrom: Number(f.blockFrom) || undefined, blockTo: Number(f.blockTo) || undefined, chunkWords: Number(f.chunkWords) || undefined,
          concurrency: Number(f.concurrency) || 2, writer: !!f.writer, includeOverig: !!f.includeOverig,
        },
      });
      location.href = `modellen.html?id=${id}`;
    } catch (err) { App.error(err); }
  };
}

// ---------------- Detail ----------------
function quality(r, b) {
  if (r.status !== 'klaar') return r.error ? `<span class="text-danger small">${App.esc(r.error.slice(0, 120))}</span>` : (r.progress ? `<span class="small">${App.esc(r.progress)}</span>` : '');
  const parts = [];
  if (r.kind === 'run') {
    parts.push(`${r.blocks} blokken`, `${r.calls} aanroepen`);
    parts.push(r.fallbacks ? `<span class="badge text-bg-danger" title="Delen waarvan de uitvoer twee keer afgekeurd werd en de invoer ongewijzigd doorging">${r.fallbacks} teruggevallen</span>` : '<span class="badge text-bg-success">0 teruggevallen</span>');
    if (r.warnings) parts.push(`<span class="badge text-bg-warning">${r.warnings} waarschuwing(en)</span>`);
    return parts.join(' · ');
  }
  const s = r.stats || {};
  if (r.validation) {
    const cls = { ok: 'success', waarschuwing: 'warning', afgekeurd: 'danger' }[r.validation];
    parts.push(`<span class="badge text-bg-${cls}" title="${App.esc(r.validation_detail || 'De pipeline zou deze uitvoer aanvaarden')}">${r.validation}</span>`);
  }
  if (r.finish_reason && r.finish_reason !== 'stop') parts.push(`<span class="badge text-bg-danger">finish: ${App.esc(r.finish_reason)}</span>`);
  if (r.json_error) parts.push(`<span class="badge text-bg-danger" title="${App.esc(r.json_error)}">ongeldige JSON</span>`);
  if (b.step === 'resolver') {
    const z = s.zekerheid || {};
    parts.push(`hoog ${z.hoog || 0} · middel ${z.middel || 0} · laag ${z.laag || 0}${s.ontbreekt ? ` · <span class="text-danger">${s.ontbreekt} ontbreekt</span>` : ''}`);
  } else if (s.gewijzigd != null) {
    parts.push(`${s.gewijzigd} gewijzigd`, `${s.vervangingen || 0} vervangingen`);
    if (s.samengevoegd) parts.push(`${s.samengevoegd} samengevoegd`);
    if (s.ontbreekt) parts.push(`<span class="text-danger">${s.ontbreekt} ontbreekt</span>`);
    if (s.woorden_in) parts.push(`<span title="woorden uit / woorden in">${Math.round((s.woorden_uit / s.woorden_in) * 100)}% woorden</span>`);
  } else if (s.punten != null) parts.push(`${s.punten} punten${s.context ? `, ${s.context} context` : ''}`);
  return parts.join(' · ');
}

function bestCards(rows) {
  const ok = rows.filter((r) => r.status === 'klaar');
  if (ok.length < 2) return '';
  const min = (key) => ok.filter((r) => r[key] != null).reduce((a, r) => (a && a[key] <= r[key] ? a : r), null);
  const card = (icon, label, r, val) => (r ? `<div class="col-6 col-lg-3"><div class="card"><div class="card-body py-2">
      <div class="small text-body-secondary"><i class="bi ${icon}"></i> ${label}</div><div class="fw-semibold text-truncate"><code>${App.esc(r.model)}</code></div><div class="small">${val}</div></div></div></div>` : '');
  const cheap = min('cost'); const fast = min('ms_net'); const lean = min('tokens_out');
  const scored = ok.filter((r) => r.quality != null);
  const best = scored.length ? scored.reduce((a, r) => (a.quality >= r.quality ? a : r)) : null;
  const total = ok.reduce((n, r) => n + (r.cost || 0), 0);
  return card('bi-piggy-bank', 'Goedkoopst', cheap, App.fmtCost(cheap?.cost))
    + card('bi-lightning', 'Snelst (netto)', fast, App.fmtMs(fast?.ms_net))
    + (best ? card('bi-trophy', 'Hoogste score', best, `${Math.round(best.quality)} / 100`) : card('bi-text-paragraph', 'Minste tokens uit', lean, `${lean?.tokens_out} tokens`))
    + `<div class="col-6 col-lg-3"><div class="card"><div class="card-body py-2"><div class="small text-body-secondary"><i class="bi bi-cash-stack"></i> Totaal vergelijking</div>
      <div class="fw-semibold">${App.fmtCost(total)}</div><div class="small">${ok.length} van ${rows.length} modellen klaar</div></div></div></div>`;
}

async function initDetail(id) {
  $id('v-detail').classList.remove('d-none');
  let batch = null;
  let ref = null;
  try { const models = await App.api('/models'); prices = new Map(models.map((m) => [m.id, m])); } catch { /* geen prijzen */ }
  const priceTip = (m) => { const p = prices.get(m); return p ? `$${p.prompt.toFixed(2)} in / $${p.completion.toFixed(2)} uit per M tokens` : ''; };
  const rel = (r, key) => {
    const base = batch?.rows.find((x) => x.id === ref);
    if (!base || base.id === r.id || !base[key] || r[key] == null || r.status !== 'klaar') return '';
    return ` <span class="small text-body-secondary">×${(r[key] / base[key]).toFixed(2)}</span>`;
  };
  const dt = App.table('#d-rows', {
    order: [[5, 'asc']], paging: false, searching: false, info: false,
    columns: [
      { data: null, orderable: false, render: (r) => `<input type="radio" class="form-check-input d-ref" name="d-ref" value="${r.id}" ${r.id === ref ? 'checked' : ''}>` },
      { data: null, render: (r) => `<code title="${App.esc(priceTip(r.model))}">${App.esc(r.model)}</code>${r.routed ? `<br><span class="small text-body-secondary" title="Model volgens OpenRouter">${App.esc(r.routed)}</span>` : ''}` },
      { data: 'status', render: App.badgeStatus },
      { data: 'tokens_in', render: (v, t, r) => (v == null ? '' : t === 'display' ? `${v}${rel(r, 'tokens_in')}` : v) },
      { data: 'tokens_out', render: (v, t, r) => (v == null ? '' : t === 'display' ? `${v}${rel(r, 'tokens_out')}` : v) },
      { data: 'cost', render: (v, t, r) => (t === 'display' ? `${App.fmtCost(v)}${rel(r, 'cost')}` : v ?? Infinity) },
      { data: 'ms_net', render: (v, t, r) => (t === 'display' ? `${App.fmtMs(v)}${rel(r, 'ms_net')}` : v ?? Infinity) },
      { data: null, render: (r, t) => {
        const v = r.ms;
        if (t !== 'display') return v ?? Infinity;
        return `${App.fmtMs(v)}${r.wall_ms != null ? `<br><span class="small text-body-secondary" title="Van start tot einde van de run, met parallelle delen">${App.fmtMs(r.wall_ms)} wandklok</span>` : ''}`;
      } },
      { data: 'retries', render: (v, t) => (t === 'display' ? (v ? `<span class="badge text-bg-warning">${v}</span>` : '0') : v) },
      { data: 'quality', render: (q, t, r) => {
        if (t !== 'display') return q ?? -1;
        if (q == null) return r.kind === 'run' ? '<span class="small text-body-secondary" title="Kwaliteitsscore bestaat enkel voor Testbank-stappen">–</span>' : '';
        const cls = q >= 85 ? 'success' : q >= 65 ? 'warning' : 'danger';
        const parts = [['A', r.quality_auto], ['R', r.quality_gold], ['J', r.quality_judge]].filter(([, v]) => v != null).map(([k, v]) => `${k}${Math.round(v)}`).join(' ');
        return `<span class="badge text-bg-${cls}">${Math.round(q)}</span><br><span class="small text-body-secondary">${parts}</span>`;
      } },
      { data: null, orderable: false, render: (r) => quality(r, batch) },
      { data: null, orderable: false, className: 'text-nowrap', render: (r) => {
        const view = r.kind === 'run' ? `run.html?id=${r.id}` : `testen.html?test=${r.id}`;
        const cmp = ref && ref !== r.id && r.status === 'klaar' && batch.rows.find((x) => x.id === ref)?.status === 'klaar'
          ? (r.kind === 'run' ? `vergelijk.html?a=${ref}&b=${r.id}` : `vergelijk.html?ta=${ref}&tb=${r.id}`) : null;
        return `<a class="btn btn-sm btn-outline-secondary" href="${view}" title="Uitvoer bekijken"><i class="bi bi-eye"></i></a>
          ${cmp ? `<a class="btn btn-sm btn-outline-primary" href="${cmp}" title="Verschillen met de referentie"><i class="bi bi-file-diff"></i> vs ref</a>` : ''}`;
      } },
    ],
  });
  $('#d-rows').on('change', '.d-ref', (e) => {
    ref = Number(e.target.value);
    try { localStorage.setItem(`batch-ref-${id}`, ref); } catch { /* geen opslag */ }
    dt.rows().invalidate().draw(false);
  });
  try { ref = Number(localStorage.getItem(`batch-ref-${id}`)) || null; } catch { /* geen opslag */ }

  let timer = null;
  const load = async () => {
    try { batch = await App.api(`/batches/${id}`); } catch (e) { App.error(e); clearInterval(timer); return; }
    if (!ref || !batch.rows.some((r) => r.id === ref)) ref = batch.rows[0]?.id ?? null;
    const what = batch.mode === 'step' ? `Stap ${STEP_LABEL[batch.step] || batch.step}` : (batch.step === 'writer' ? 'Volledige pipeline' : `Pipeline tot ${STEP_LABEL[batch.step] || batch.step}`);
    $id('d-title').textContent = `Vergelijking #${batch.id}: ${what}${batch.label ? ` · ${batch.label}` : ''}`;
    $id('d-status').innerHTML = App.badgeStatus(batch.status);
    const o = batch.options || {};
    $id('d-meta').innerHTML = [
      batch.meeting_id ? `<a href="vergadering.html?id=${batch.meeting_id}">${App.esc(batch.titel || batch.input_name || `vergadering #${batch.meeting_id}`)}</a>` : 'eigen tekst',
      App.esc(batch.input_desc || ''),
      batch.mode === 'step' && o.skill ? `${App.esc(o.skill)} v${o.skill_version}${o.draft ? ' <span class="badge text-bg-warning">concept</span>' : ''}` : '',
      `${o.concurrency || 1} tegelijk`, `gestart ${App.esc(batch.created_at)}`,
    ].filter(Boolean).join(' · ');
    $id('d-stop').classList.toggle('d-none', !batch.active);
    $id('d-best').innerHTML = bestCards(batch.rows);
    dt.clear().rows.add(batch.rows).draw(false);
    if (!batch.active && !batch.rows.some((r) => r.status === 'bezig')) { clearInterval(timer); timer = null; }
  };
  await load();
  if (batch?.active || batch?.rows.some((r) => r.status === 'bezig')) timer = setInterval(load, 3000);

  $id('d-stop').onclick = async () => {
    try { await App.api(`/batches/${id}/stop`, { method: 'POST' }); App.toast('Stoppen gevraagd'); load(); } catch (e) { App.error(e); }
  };
  $id('d-delete').onclick = async () => {
    if (!(await App.confirm('Vergelijking verwijderen, samen met de bijhorende tests of runs?'))) return;
    try { await App.api(`/batches/${id}`, { method: 'DELETE' }); location.href = 'modellen.html'; } catch (e) { App.error(e); }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const id = Number(new URLSearchParams(location.search).get('id'));
  (id ? initDetail(id) : initList()).catch(App.error);
});

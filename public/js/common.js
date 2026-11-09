/* Gedeelde helpers: navigatie, API, toasts, modals, DataTables-config. */
/* global $, bootstrap */

const NAV = [
  ['index.html', 'bi-file-earmark-text', 'Transcripties'],
  ['testen.html', 'bi-eyedropper', 'Testbank'],
  ['skills.html', 'bi-magic', 'Skills'],
  ['leden.html', 'bi-people', 'Raadsleden'],
  ['termen.html', 'bi-journal-text', 'Gentse context'],
  ['straten.html', 'bi-signpost-2', 'Straten'],
  ['instellingen.html', 'bi-gear', 'Instellingen'],
];

const App = {
  meta: null,

  async api(url, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: {} };
    if (form) opts.body = form;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`/api${url}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
    return data;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  toast(msg, type = 'success') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = Object.assign(document.createElement('div'), { id: 'toasts', className: 'toast-container position-fixed bottom-0 end-0 p-3' });
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${App.esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    box.appendChild(el);
    new bootstrap.Toast(el, { delay: type === 'danger' ? 8000 : 3000 }).show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  },

  error(e) { App.toast(e.message || String(e), 'danger'); },

  async confirm(msg) { return window.confirm(msg); },

  /** Vult een formulier met data (op name-attribuut) */
  fillForm(form, data = {}) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = data[el.name];
      if (el.type === 'checkbox') el.checked = v === undefined ? el.defaultChecked : !!Number(v) || v === true;
      else if (el.type !== 'file') el.value = v ?? '';
    }
  },

  /** Leest een formulier als object (checkbox → 1/0) */
  readForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.type === 'file') continue;
      out[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value.trim();
    }
    return out;
  },

  modal(id) { return bootstrap.Modal.getOrCreateInstance(document.getElementById(id)); },

  dtLanguage: {
    search: 'Zoeken:',
    lengthMenu: '_MENU_ per pagina',
    info: '_START_ tot _END_ van _TOTAL_',
    infoEmpty: 'Geen resultaten',
    infoFiltered: '(gefilterd uit _MAX_)',
    zeroRecords: 'Niets gevonden',
    emptyTable: 'Nog geen gegevens',
    paginate: { first: '«', last: '»', next: '›', previous: '‹' },
  },

  table(selector, options) {
    return new DataTable(selector, { language: App.dtLanguage, pageLength: 25, autoWidth: false, ...options });
  },

  badgeStatus(status) {
    const map = { klaar: 'success', bezig: 'primary', wachtrij: 'secondary', fout: 'danger', gestopt: 'warning', geen: 'light border', nieuw: 'info', voorstel: 'warning', actief: 'success', inactief: 'secondary' };
    return `<span class="badge text-bg-${map[status] || 'secondary'}">${App.esc(status)}</span>`;
  },

  zekerheidBadge(z) {
    const map = { hoog: 'success', middel: 'warning', laag: 'danger', manueel: 'info' };
    return z ? `<span class="badge text-bg-${map[z] || 'secondary'}">${App.esc(z)}</span>` : '';
  },

  fmtTime(sec) {
    if (sec == null) return '';
    const s = Math.floor(sec);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  },

  typeBadge(type) {
    const map = { mondelinge_vraag: ['info', 'mondelinge vraag'], interpellatie: ['primary', 'interpellatie'], voorstel: ['primary', 'voorstel'],
      motie: ['warning', 'motie'], amendement: ['warning', 'amendement'], besluit: ['secondary', 'besluit'], overig: ['light border', 'overig'] };
    const [c, l] = map[type] || ['light border', type || '?'];
    return `<span class="badge text-bg-${c}">${App.esc(l)}</span>`;
  },

  fmtCost(c) { return c ? `$${Number(c).toFixed(4)}` : '–'; },

  /** Datalist met OpenRouter-modellen (prijs per miljoen tokens) */
  async modelDatalist() {
    if (document.getElementById('models-list')) return;
    const dl = Object.assign(document.createElement('datalist'), { id: 'models-list' });
    document.body.appendChild(dl);
    try {
      const models = await App.api('/models');
      dl.innerHTML = models.map((m) => `<option value="${App.esc(m.id)}">${App.esc(m.name)} — $${m.prompt.toFixed(2)}/$${m.completion.toFixed(2)} per M, ${Math.round((m.context || 0) / 1000)}k</option>`).join('');
    } catch { /* offline: vrije invoer */ }
  },

  async loadMeta() {
    App.meta = await App.api('/meta');
    const b1 = document.getElementById('nav-badge-terms');
    if (b1) b1.textContent = App.meta.pendingTerms || '';
    const b2 = document.getElementById('nav-badge-skills');
    if (b2) b2.textContent = App.meta.pendingCorrections || '';
    return App.meta;
  },

  /**
   * CRUD-tabel met modal-formulier.
   * opts: { table, endpoint, columns, modal, form, newBtn, defaults, filter, dtOptions, onSaved, title }
   */
  crud(opts) {
    const form = document.getElementById(opts.form);
    const titleEl = document.querySelector(`#${opts.modal} .modal-title`);
    const delBtn = form.querySelector('.btn-delete');
    let current = null;
    const dt = App.table(opts.table, { columns: opts.columns, ...(opts.dtOptions || {}) });
    const reload = async () => {
      let rows = await App.api(opts.endpoint);
      if (opts.filter) rows = rows.filter(opts.filter);
      dt.clear().rows.add(rows).draw(false);
      return rows;
    };
    const open = (row) => {
      current = row;
      App.fillForm(form, row || opts.defaults || {});
      titleEl.textContent = row ? `${opts.title} bewerken` : `Nieuw: ${opts.title.toLowerCase()}`;
      if (delBtn) delBtn.classList.toggle('d-none', !row);
      App.modal(opts.modal).show();
    };
    $(opts.table).on('click', 'tbody tr', function (e) {
      if (e.target.closest('input,button,a')) return;
      const d = dt.row(this).data();
      if (d) open(d);
    });
    if (opts.newBtn) document.getElementById(opts.newBtn).onclick = () => open(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = App.readForm(form);
      try {
        await App.api(current ? `${opts.endpoint}/${current.id}` : opts.endpoint, { method: current ? 'PUT' : 'POST', body: data });
        App.modal(opts.modal).hide();
        App.toast('Opgeslagen');
        await reload();
        opts.onSaved?.();
      } catch (err) { App.error(err); }
    };
    if (delBtn) delBtn.onclick = async () => {
      if (!current || !(await App.confirm('Verwijderen?'))) return;
      try {
        await App.api(`${opts.endpoint}/${current.id}`, { method: 'DELETE' });
        App.modal(opts.modal).hide();
        await reload();
        opts.onSaved?.();
      } catch (err) { App.error(err); }
    };
    reload().catch(App.error);
    return { dt, reload, open };
  },

  /** Unified diff → gekleurde HTML */
  renderDiff(patch) {
    return patch.split('\n').slice(2).map((l) => {
      const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return cls ? `<span class="${cls}">${App.esc(l)}</span>` : `${App.esc(l)}\n`;
    }).join('');
  },

  /** diffWords-resultaat → HTML met <ins>/<del> */
  renderWordDiff(parts) {
    return parts.map((p) => (p.added ? `<ins>${App.esc(p.value)}</ins>` : p.removed ? `<del>${App.esc(p.value)}</del>` : App.esc(p.value))).join('');
  },

  runOptionsHtml(prefix, opts = {}, settings = {}) {
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
        ${opts.prepared ? `<div class="form-check"><input class="form-check-input" type="checkbox" name="includeOverig" id="${prefix}-overig" ${opts.includeOverig ? 'checked' : ''}>
          <label class="form-check-label" for="${prefix}-overig" title="Opening, pauzes, procedure: stukken die bij geen agendapunt horen">Ook stukken zonder agendapunt</label></div>` : ''}
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
  },

  readRunOptions(form) {
    const f = App.readForm(form);
    const models = {};
    for (const [k, v] of Object.entries(f)) if (k.startsWith('model_') && v) models[k.slice(6)] = v;
    return {
      label: f.label,
      options: {
        chunkWords: Number(f.chunkWords) || undefined, writer: !!f.writer, llmIntake: !!f.llmIntake, models,
        blockFrom: Number(f.blockFrom) || undefined, blockTo: Number(f.blockTo) || undefined, stopAfter: f.stopAfter || 'writer',
      includeOverig: !!f.includeOverig,
      },
    };
  },

  renderNav() {
    const page = location.pathname.split('/').pop() || 'index.html';
    const items = NAV.map(([href, icon, label]) => {
      const badge = href === 'termen.html' ? '<span id="nav-badge-terms" class="badge rounded-pill text-bg-warning ms-1"></span>'
        : href === 'skills.html' ? '<span id="nav-badge-skills" class="badge rounded-pill text-bg-info ms-1" title="Onverwerkte correcties"></span>' : '';
      const active = page === href || (['run.html', 'vergelijk.html', 'vergadering.html'].includes(page) && href === 'index.html');
      return `<li class="nav-item"><a class="nav-link ${active ? 'active' : ''}" href="${href}"><i class="bi ${icon}"></i> ${label}${badge}</a></li>`;
    }).join('');
    const nav = document.createElement('nav');
    nav.className = 'navbar navbar-expand-lg bg-body-tertiary border-bottom mb-3';
    nav.innerHTML = `<div class="container-fluid">
      <a class="navbar-brand fw-semibold" href="index.html"><i class="bi bi-mic"></i> Transcraiber <small class="text-body-secondary fw-normal">Gent</small></a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#mainnav"><span class="navbar-toggler-icon"></span></button>
      <div class="collapse navbar-collapse" id="mainnav"><ul class="navbar-nav me-auto">${items}</ul>
      <span id="mock-flag" class="badge text-bg-warning d-none me-2">MOCK-LLM</span>
      <button class="btn btn-sm btn-outline-secondary" id="theme-toggle" title="Licht/donker"><i class="bi bi-circle-half"></i></button></div></div>`;
    document.body.prepend(nav);
    document.getElementById('theme-toggle').onclick = () => {
      const t = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-bs-theme', t);
      try { localStorage.setItem('theme', t); } catch { /* geen opslag */ }
    };
  },
};

(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('theme'); } catch { /* geen opslag */ }
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', t);
})();

document.addEventListener('DOMContentLoaded', () => {
  App.renderNav();
  App.loadMeta().then((m) => { if (m.mock) document.getElementById('mock-flag').classList.remove('d-none'); }).catch(() => {});
});

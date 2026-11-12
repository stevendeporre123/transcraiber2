/* global $, bootstrap, DataTable, Normalize */
'use strict';

const api = window.director;
const N = Normalize;

const state = {
  settings: null,
  organNames: {},       // id -> naam
  organsLoaded: false,
  meeting: null,        // genormaliseerde gekozen vergadering
  statuses: [],         // [{code,label}]
};

// ---------- helpers ----------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DT_LANG = {
  search: 'Zoeken:',
  lengthMenu: '_MENU_ per pagina',
  info: '_START_–_END_ van _TOTAL_',
  infoEmpty: 'Geen resultaten',
  infoFiltered: '(gefilterd uit _MAX_)',
  zeroRecords: 'Niets gevonden',
  emptyTable: 'Geen gegevens',
  loadingRecords: 'Laden…',
  processing: 'Bezig…',
  paginate: { first: '«', previous: '‹', next: '›', last: '»' },
};

function statusColor(code) {
  const c = String(code || '').toUpperCase();
  if (/PRESENT|AANWEZIG/.test(c) && !/ABSENT|NOT|NIET/.test(c)) return 'success';
  if (/EXCUS|VERONTSCH/.test(c)) return 'warning';
  if (/ABSENT|AFWEZIG|NOT_PRESENT/.test(c)) return 'danger';
  if (/REMOTE|ONLINE|DIGITA/.test(c)) return 'info';
  return 'secondary';
}

function statusLabel(code) {
  const s = state.statuses.find(x => x.code === code);
  return s ? s.label : (code || '—');
}

function toast(message, type = 'success', detail = null) {
  const id = 't' + Math.random().toString(36).slice(2);
  const icon = { success: 'check-circle', danger: 'exclamation-triangle', warning: 'exclamation-circle', info: 'info-circle' }[type] || 'info-circle';
  const $t = $(`
    <div id="${id}" class="toast align-items-center text-bg-${type} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body"><i class="bi bi-${icon}"></i> ${esc(message)}
          ${detail ? '<a href="#" class="link-light ms-2 small toast-detail">details</a>' : ''}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`);
  $('#toasts').append($t);
  if (detail) $t.find('.toast-detail').on('click', (e) => { e.preventDefault(); showRaw('Foutdetails', detail); });
  const t = new bootstrap.Toast($t[0], { delay: type === 'danger' ? 10000 : 3000 });
  $t.on('hidden.bs.toast', () => $t.remove());
  t.show();
}

function showRaw(title, obj) {
  $('#rawTitle').text(title);
  $('#rawBody').text(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  bootstrap.Modal.getOrCreateInstance('#modalRaw').show();
}

/** Roept de IPC-api aan en gooit bij fout, met de details eraan gehangen. */
async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res.ok) {
    const err = new Error(res.error.message);
    err.detail = res.error;
    throw err;
  }
  return res.data;
}

function fail(prefix, err) {
  console.error(prefix, err);
  toast(`${prefix}: ${err.message}`, 'danger', err.detail || null);
}

// ---------- instellingen -----------------------------------------------------

const SETTINGS_FIELDS = {
  baseUrl: '#sBaseUrl', tokenUrl: '#sTokenUrl', clientId: '#sClientId', clientSecret: '#sClientSecret',
  scope: '#sScope', organIds: '#sOrganIds', meetingStatuses: '#sMeetingStatuses', sort: '#sSort',
  listStyle: '#sListStyle', attendanceStatuses: '#sAttendanceStatuses', statusField: '#sStatusField',
  extraHeaders: '#sExtraHeaders',
};

function fillSettingsForm(s) {
  for (const [key, sel] of Object.entries(SETTINGS_FIELDS)) $(sel).val(s[key] ?? '');
  $('#testResult').text('').attr('class', 'small');
  $('#formSettings').removeClass('was-validated');
}

function readSettingsForm() {
  const out = {};
  for (const [key, sel] of Object.entries(SETTINGS_FIELDS)) out[key] = $(sel).val();
  return out;
}

function isConfigured(s) {
  return !!(s && s.baseUrl && s.tokenUrl && s.clientId && s.clientSecret && (s.organIds || s.meetingStatuses));
}

function applySettings(s) {
  state.settings = s;
  state.statuses = N.parseStatusList(s.attendanceStatuses);
  $('#setupHint').toggleClass('d-none', isConfigured(s));
  let host = '';
  try { host = new URL(/^https?:/.test(s.baseUrl) ? s.baseUrl : 'https://' + s.baseUrl).host; } catch { /* leeg */ }
  $('#envBadge').text(host).toggleClass('d-none', !host)
    .toggleClass('text-bg-warning', /test|release|staging|acc/i.test(host + s.tokenUrl))
    .toggleClass('text-bg-secondary', !/test|release|staging|acc/i.test(host + s.tokenUrl));
  fillFilters();
  renderBulkButtons();
}

function openSettings() {
  fillSettingsForm(state.settings);
  bootstrap.Modal.getOrCreateInstance('#modalSettings').show();
}

$('#btnSettings, #linkSettings').on('click', (e) => { e.preventDefault(); openSettings(); });

$('#btnShowSecret').on('click', function () {
  const $i = $('#sClientSecret');
  const show = $i.attr('type') === 'password';
  $i.attr('type', show ? 'text' : 'password');
  $(this).find('i').attr('class', show ? 'bi bi-eye-slash' : 'bi bi-eye');
});

$('#formSettings').on('submit', async function (e) {
  e.preventDefault();
  if (!this.checkValidity()) {
    $(this).addClass('was-validated');
    const firstBad = $(this).find(':invalid').first();
    const pane = firstBad.closest('.tab-pane').attr('id');
    if (pane) bootstrap.Tab.getOrCreateInstance(document.querySelector(`[data-bs-target="#${pane}"]`)).show();
    return;
  }
  try {
    const saved = await call(api.saveSettings, readSettingsForm());
    applySettings(saved);
    bootstrap.Modal.getInstance('#modalSettings').hide();
    toast('Instellingen opgeslagen');
    loadOrganNames(true).finally(loadMeetings);
  } catch (err) { fail('Opslaan mislukt', err); }
});

$('#btnTestAuth').on('click', async () => {
  const $r = $('#testResult').attr('class', 'small text-body-secondary').text('Bezig…');
  try {
    // eerst (tijdelijk) bewaren zodat de main-process de ingevulde waarden gebruikt
    const saved = await call(api.saveSettings, readSettingsForm());
    applySettings(saved);
    const info = await call(api.testAuth);
    $r.attr('class', 'small text-success').html(`<i class="bi bi-check-circle"></i> Token ontvangen (geldig ${info.expiresInSec}s)`);
  } catch (err) {
    $r.attr('class', 'small text-danger').html(`<i class="bi bi-x-circle"></i> ${esc(err.message)}`);
  }
});

// ---------- organen (instellingen-tab) ---------------------------------------

let organsTable = null;

function selectedOrganIds() {
  return new Set($('#sOrganIds').val().split(/[,;\n]/).map(s => s.trim()).filter(Boolean));
}

$('#btnLoadOrgans').on('click', async function () {
  const $b = $(this).prop('disabled', true);
  try {
    await call(api.saveSettings, readSettingsForm()).then(applySettings);
    const organs = N.asArray(await call(api.getOrgans)).map(N.organ);
    organs.forEach(o => { if (o.id) state.organNames[o.id] = o.name; });
    const chosen = selectedOrganIds();
    const rows = organs.map(o => ({ ...o, checked: chosen.has(o.id) }));
    $('#organsWrap').removeClass('d-none');
    if (!organsTable) {
      organsTable = new DataTable('#tblOrgans', {
        data: rows,
        language: DT_LANG,
        pageLength: 10,
        order: [[1, 'asc']],
        columns: [
          { data: 'checked', title: '', orderable: false, className: 'dt-check',
            render: (v, _t, r) => `<input type="checkbox" class="form-check-input organ-check" data-id="${esc(r.id)}" ${v ? 'checked' : ''}>` },
          { data: 'name', title: 'Naam', render: (v) => esc(v || '—') },
          { data: 'id', title: 'ID', className: 'font-monospace small', render: (v) => esc(v) },
        ],
      });
    } else {
      organsTable.clear().rows.add(rows).draw();
    }
    toast(`${organs.length} organen opgehaald`, 'info');
    if (!organs.length) showRaw('Antwoord /organs (geen lijst herkend)', await call(api.getOrgans));
  } catch (err) { fail('Organen ophalen mislukt', err); }
  finally { $b.prop('disabled', false); }
});

$('#tblOrgans').on('change', '.organ-check', function () {
  const ids = selectedOrganIds();
  const id = String($(this).data('id'));
  if (this.checked) ids.add(id); else ids.delete(id);
  $('#sOrganIds').val([...ids].join(', '));
  const row = organsTable.row($(this).closest('tr')[0]);
  row.data({ ...row.data(), checked: this.checked });
});

async function loadOrganNames(force = false) {
  if ((state.organsLoaded && !force) || !isConfigured(state.settings)) return;
  try {
    N.asArray(await call(api.getOrgans)).map(N.organ).forEach(o => { if (o.id) state.organNames[o.id] = o.name; });
    state.organsLoaded = true;
    fillFilters();
  } catch { /* namen zijn optioneel */ }
}

// ---------- filters ----------------------------------------------------------

function fillFilters() {
  const s = state.settings || {};
  const organs = String(s.organIds || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const statuses = String(s.meetingStatuses || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const curO = $('#filterOrgan').val();
  const curS = $('#filterStatus').val();

  $('#filterOrgan').html([`<option value="">Alle organen (${organs.length})</option>`]
    .concat(organs.map(id => `<option value="${esc(id)}">${esc(state.organNames[id] || id)}</option>`)).join(''))
    .val(organs.includes(curO) ? curO : '').toggleClass('d-none', organs.length < 2);
  $('#filterStatus').html([`<option value="">Alle statussen</option>`]
    .concat(statuses.map(st => `<option value="${esc(st)}">${esc(st)}</option>`)).join(''))
    .val(statuses.includes(curS) ? curS : '').toggleClass('d-none', statuses.length < 2);
}

$('#filterOrgan, #filterStatus').on('change', loadMeetings);
$('#btnRefresh').on('click', () => { loadMeetings(); if (state.meeting) loadMembers(state.meeting); });

// ---------- vergaderingen ----------------------------------------------------

const meetingsTable = new DataTable('#tblMeetings', {
  data: [],
  language: DT_LANG,
  pageLength: 15,
  lengthMenu: [10, 15, 25, 50, 100],
  order: [],          // volgorde van de API (sort-instelling) behouden
  columns: [
    { data: 'date', title: 'Datum', className: 'text-nowrap',
      render: (v, type) => (type === 'display' ? esc(N.formatDate(v, true)) : v) },
    { data: 'organName', title: 'Orgaan', render: (v) => esc(v) },
    { data: 'title', title: 'Titel', render: (v, _t, r) => esc(v || r.location || '—') },
    { data: 'status', title: 'Status', render: (v) => `<span class="badge text-bg-light border small">${esc(v)}</span>` },
  ],
  createdRow: (row, data) => { row.dataset.id = data.id; },
});

async function loadMeetings() {
  if (!isConfigured(state.settings)) return;
  const organ = $('#filterOrgan').val();
  const status = $('#filterStatus').val();
  try {
    const raw = await call(api.getMeetings, {
      organs: organ || undefined,
      statuses: status || undefined,
    });
    const list = N.asArray(raw).map(m => N.meeting(m, state.organNames));
    meetingsTable.clear().rows.add(list).draw();
    if (!list.length && raw && !Array.isArray(raw)) {
      toast('Geen vergaderingen herkend in het antwoord', 'warning', raw);
    }
    markSelectedMeeting();
  } catch (err) { fail('Vergaderingen laden mislukt', err); }
}

function markSelectedMeeting() {
  $('#tblMeetings tbody tr').removeClass('table-active');
  if (state.meeting) $(`#tblMeetings tbody tr`).filter((_, tr) => tr.dataset.id === state.meeting.id).addClass('table-active');
}
meetingsTable.on('draw', markSelectedMeeting);

$('#tblMeetings').on('click', 'tbody tr', function () {
  const data = meetingsTable.row(this).data();
  if (!data) return;
  state.meeting = data;
  markSelectedMeeting();
  loadMembers(data);
});

$('#btnMeetingRaw').on('click', () => state.meeting && showRaw('Vergadering', state.meeting.raw));

// ---------- leden / aanwezigheden ---------------------------------------------

function statusButtons(row) {
  return `<div class="btn-group btn-group-sm status-group" role="group">` +
    state.statuses.map(s => {
      const active = s.code === row.status;
      const color = statusColor(s.code);
      return `<button type="button" class="btn ${active ? 'btn-' + color : 'btn-outline-' + color} set-status"
                data-code="${esc(s.code)}" title="${esc(s.code)}">${esc(s.label)}</button>`;
    }).join('') + `</div>` +
    (row.status && !state.statuses.some(s => s.code === row.status)
      ? ` <span class="badge text-bg-secondary ms-1" title="Onbekende status – voeg toe in Instellingen › Aanwezigheid">${esc(row.status)}</span>` : '');
}

const membersTable = new DataTable('#tblMembers', {
  data: [],
  language: DT_LANG,
  paging: false,
  scrollY: 'calc(100vh - 330px)',
  scrollCollapse: true,
  order: [[1, 'asc']],
  columns: [
    { data: null, title: '<input type="checkbox" class="form-check-input" id="chkAll" title="Alles selecteren">', orderable: false, className: 'dt-check',
      render: (_v, _t, r) => `<input type="checkbox" class="form-check-input row-check" ${r._sel ? 'checked' : ''}>` },
    { data: 'name', title: 'Naam', render: (v) => `<strong>${esc(v)}</strong>` },
    { data: 'role', title: 'Rol', render: (v, _t, r) => esc([v, r.party].filter(Boolean).join(' · ')) },
    { data: 'status', title: 'Aanwezigheid', orderable: true,
      render: (v, type, r) => (type === 'display' ? statusButtons(r) : statusLabel(v)) },
    { data: null, title: '', orderable: false, className: 'text-end',
      render: () => `<button type="button" class="btn btn-sm btn-link edit-member" title="Bewerken"><i class="bi bi-pencil-square"></i></button>` },
  ],
  createdRow: (row, data) => { row.dataset.id = data.id; },
});

function renderCounters() {
  const rows = membersTable.rows().data().toArray();
  if (!rows.length) { $('#counters').empty(); return; }
  const counts = {};
  rows.forEach(r => { counts[r.status || ''] = (counts[r.status || ''] || 0) + 1; });
  const codes = [...state.statuses.map(s => s.code), ...Object.keys(counts).filter(c => !state.statuses.some(s => s.code === c))];
  $('#counters').html(
    `<span class="badge text-bg-dark counter-badge">Totaal ${rows.length}</span>` +
    codes.filter(c => counts[c]).map(c =>
      `<span class="badge text-bg-${statusColor(c)} counter-badge">${esc(c ? statusLabel(c) : 'Geen status')} ${counts[c]}</span>`).join(''));
}

function renderBulkButtons() {
  $('#bulkButtons').html(state.statuses.map(s =>
    `<button type="button" class="btn btn-outline-${statusColor(s.code)} bulk-status" data-code="${esc(s.code)}">${esc(s.label)}</button>`).join(''));
  if (membersTable) membersTable.rows().invalidate().draw(false);
}

function updateSelectionUi() {
  const rows = membersTable.rows().data().toArray();
  const n = rows.filter(r => r._sel).length;
  $('#selCount').text(n);
  $('#bulkBar').toggleClass('d-none', n === 0);
  const all = document.getElementById('chkAll');
  if (all) { all.checked = n > 0 && n === rows.length; all.indeterminate = n > 0 && n < rows.length; }
}

async function loadMembers(meeting) {
  $('#meetingTitle').text(meeting.title || meeting.organName || 'Vergadering');
  $('#meetingSub').text([meeting.organName !== meeting.title ? meeting.organName : '', N.formatDate(meeting.date)].filter(Boolean).join(' · '));
  $('#btnMeetingRaw').removeClass('d-none');
  $('#membersEmpty').addClass('d-none');
  $('#membersWrap').removeClass('d-none');
  membersTable.clear().draw();
  $('#counters').html('<span class="spinner-border spinner-border-sm"></span>');
  try {
    const raw = await call(api.getMembers, meeting.id);
    if (state.meeting !== meeting) return; // intussen andere vergadering gekozen
    const list = N.asArray(raw).map(m => ({ ...N.member(m, state.settings.statusField), _sel: false }));
    membersTable.clear().rows.add(list).draw();
    membersTable.columns.adjust();
    renderCounters();
    updateSelectionUi();
    if (!list.length && raw && !Array.isArray(raw)) toast('Geen leden herkend in het antwoord', 'warning', raw);
  } catch (err) {
    $('#counters').empty();
    fail('Leden laden mislukt', err);
  }
}

/** PATCH één lid; werkt de tabelrij bij. Gooit bij fout. */
async function setMemberStatus(tr, code) {
  const row = membersTable.row(tr);
  const data = row.data();
  const field = state.settings.statusField || 'status';
  await call(api.updateMember, state.meeting.id, data.id, { [field]: code });
  row.data({ ...data, status: code, raw: { ...data.raw, [field]: code } }).invalidate();
  return data;
}

$('#tblMembers').on('click', '.set-status', async function () {
  const tr = $(this).closest('tr')[0];
  const code = String($(this).data('code'));
  const $group = $(this).closest('.status-group').find('.btn').addClass('saving');
  try {
    const m = await setMemberStatus(tr, code);
    membersTable.draw(false);
    renderCounters();
    toast(`${m.name}: ${statusLabel(code)}`);
  } catch (err) {
    $group.removeClass('saving');
    fail('Bijwerken mislukt', err);
  }
});

$('#tblMembers').on('change', '.row-check', function () {
  const row = membersTable.row($(this).closest('tr')[0]);
  row.data()._sel = this.checked;
  updateSelectionUi();
});

$(document).on('change', '#chkAll', function () {
  const checked = this.checked;
  membersTable.rows({ search: 'applied' }).every(function () { this.data()._sel = checked; this.invalidate(); });
  membersTable.draw(false);
  updateSelectionUi();
});

$('#bulkButtons').on('click', '.bulk-status', async function () {
  const code = String($(this).data('code'));
  const targets = [];
  membersTable.rows().every(function () { if (this.data()._sel) targets.push(this.node()); });
  if (!targets.length) return;
  const $btns = $('#bulkButtons .btn').prop('disabled', true);
  let ok = 0; const errors = [];
  for (const tr of targets) {
    try { await setMemberStatus(tr, code); ok++; } catch (err) { errors.push({ member: membersTable.row(tr).data().name, ...err.detail }); }
    $('#selCount').text(`${ok + errors.length}/${targets.length}`);
  }
  membersTable.rows().every(function () { this.data()._sel = false; this.invalidate(); });
  membersTable.draw(false);
  $btns.prop('disabled', false);
  renderCounters();
  updateSelectionUi();
  if (errors.length) toast(`${ok} bijgewerkt, ${errors.length} mislukt`, 'danger', errors);
  else toast(`${ok} leden op "${statusLabel(code)}" gezet`);
});

// --- bewerk-modal
let editingTr = null;
$('#tblMembers').on('click', '.edit-member', function () {
  editingTr = $(this).closest('tr')[0];
  const m = membersTable.row(editingTr).data();
  $('#mmName').text(m.name);
  $('#mmId').text(m.id);
  $('#mmRole').text([m.role, m.party].filter(Boolean).join(' · ') || '—');
  $('#mmStatus').html(`<span class="badge text-bg-${statusColor(m.status)}">${esc(statusLabel(m.status))}</span>`);
  $('#mmNewStatus').html(state.statuses.map(s => `<option value="${esc(s.code)}">${esc(s.label)} (${esc(s.code)})</option>`).join(''))
    .val(state.statuses.some(s => s.code === m.status) ? m.status : state.statuses[0]?.code);
  $('#mmRaw').text(JSON.stringify(m.raw, null, 2));
  bootstrap.Modal.getOrCreateInstance('#modalMember').show();
});

$('#formMember').on('submit', async (e) => {
  e.preventDefault();
  const code = $('#mmNewStatus').val();
  const $btn = $('#formMember [type=submit]').prop('disabled', true);
  try {
    const m = await setMemberStatus(editingTr, code);
    membersTable.draw(false);
    renderCounters();
    bootstrap.Modal.getInstance('#modalMember').hide();
    toast(`${m.name}: ${statusLabel(code)}`);
  } catch (err) { fail('Bijwerken mislukt', err); }
  finally { $btn.prop('disabled', false); }
});

// ---------- diversen ---------------------------------------------------------

$('#btnCopyRaw').on('click', async () => {
  await navigator.clipboard.writeText($('#rawBody').text());
  toast('Gekopieerd', 'info');
});

function setTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  $('#btnTheme i').attr('class', theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars');
  try { localStorage.setItem('theme', theme); } catch { /* ok */ }
}
$('#btnTheme').on('click', () => setTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'));

$(window).on('resize', () => membersTable.columns.adjust());

// ---------- start ------------------------------------------------------------

(async function init() {
  let theme = 'light';
  try { theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch { /* ok */ }
  setTheme(theme);

  try {
    applySettings(await call(api.getSettings));
  } catch (err) { fail('Instellingen laden mislukt', err); return; }

  if (!isConfigured(state.settings)) { openSettings(); return; }
  await loadOrganNames();
  await loadMeetings();
})();

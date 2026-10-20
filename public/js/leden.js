/* global App */
document.addEventListener('DOMContentLoaded', async () => {
  const meta = await App.loadMeta();
  document.getElementById('fracties').innerHTML = meta.fracties.map((f) => `<option value="${App.esc(f)}">`).join('');

  App.crud({
    table: '#members', endpoint: '/members', modal: 'm-member', form: 'f-member', newBtn: 'new-member', title: 'Lid',
    defaults: { functie: 'raadslid', actief: 1 },
    dtOptions: { order: [[6, 'desc'], [0, 'asc']], pageLength: 100 },
    columns: [
      { data: 'naam', render: (n, t, r) => `<span class="fw-semibold">${App.esc(n)}</span>${r.notitie ? `<div class="small text-body-secondary">${App.esc(r.notitie)}</div>` : ''}` },
      { data: 'match_namen', render: App.esc },
      { data: 'geslacht', render: App.esc },
      { data: 'fractie', render: App.esc },
      { data: 'functie', render: (f) => `<span class="badge ${f === 'raadslid' ? 'text-bg-light border' : 'text-bg-primary'}">${App.esc(f)}</span>` },
      { data: null, render: (r) => `<span class="small">${App.esc(r.portefeuille || '')}</span>` },
      { data: 'actief', render: (a) => (a ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-dash-circle text-secondary"></i>') },
    ],
    onSaved: () => App.loadMeta(),
  });

  App.crud({
    table: '#comms', endpoint: '/commissies', modal: 'm-comm', form: 'f-comm', newBtn: 'new-comm', title: 'Commissie',
    dtOptions: { paging: false, searching: false, info: false },
    columns: [{ data: 'code' }, { data: 'naam', render: App.esc }, { data: 'schepenen', render: App.esc }, { data: 'voorzitter', render: App.esc }],
  });

  const ms = await App.api('/members');
  document.getElementById('leden-names').innerHTML = ms.map((m) => `<option value="${App.esc(m.naam)}">`).join('');
});

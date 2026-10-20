/* global App, $ */
const selected = new Set();
let crud;

function updatePending(rows) {
  const n = rows.filter((r) => r.status === 'voorstel').length;
  document.getElementById('pending').classList.toggle('d-none', !n);
  document.getElementById('pending-count').textContent = n;
  const has = selected.size > 0;
  document.getElementById('bulk-approve').disabled = !has;
  document.getElementById('bulk-reject').disabled = !has;
}

async function bulk(action) {
  try {
    await App.api('/terms/bulk', { method: 'POST', body: { ids: [...selected], action } });
    selected.clear();
    updatePending(await crud.reload());
    App.loadMeta();
    App.toast(action === 'approve' ? 'Goedgekeurd' : 'Afgewezen (inactief)');
  } catch (e) { App.error(e); }
}

document.addEventListener('DOMContentLoaded', async () => {
  const meta = await App.loadMeta();
  const opts = meta.termCategories.map((c) => `<option>${c}</option>`).join('');
  document.getElementById('term-cat').innerHTML = opts;
  document.getElementById('f-cat').innerHTML += opts;

  crud = App.crud({
    table: '#terms', endpoint: '/terms', modal: 'm-term', form: 'f-term', newBtn: 'new-term', title: 'Term',
    defaults: { categorie: 'naam_fout', status: 'actief', bron: 'manueel' },
    dtOptions: { order: [[6, 'desc'], [1, 'asc']], pageLength: 50 },
    columns: [
      { data: null, orderable: false, render: (r) => `<input type="checkbox" class="form-check-input sel" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''}>` },
      { data: 'categorie' },
      { data: 'varianten', render: (v) => `<span class="small">${App.esc(v || '')}</span>` },
      { data: 'correct', render: (c) => `<span class="fw-semibold">${App.esc(c)}</span>` },
      { data: 'toelichting', render: (t) => `<span class="small">${App.esc((t || '').slice(0, 160))}${(t || '').length > 160 ? '…' : ''}</span>` },
      { data: 'bron' },
      { data: 'status', render: (s, type) => (type === 'sort' ? (s === 'voorstel' ? 2 : s === 'actief' ? 1 : 0) : type === 'filter' ? s : App.badgeStatus(s)) },
    ],
    onSaved: async () => { App.loadMeta(); updatePending(await App.api('/terms')); },
  });
  updatePending(await App.api('/terms'));

  const applyFilters = () => {
    crud.dt.column(6).search(document.getElementById('f-status').value ? `^${document.getElementById('f-status').value}$` : '', { regex: true, smart: false });
    crud.dt.column(1).search(document.getElementById('f-cat').value ? `^${document.getElementById('f-cat').value}$` : '', { regex: true, smart: false });
    crud.dt.draw();
  };
  document.getElementById('f-status').onchange = applyFilters;
  document.getElementById('f-cat').onchange = applyFilters;
  document.getElementById('show-pending').onclick = () => { document.getElementById('f-status').value = 'voorstel'; applyFilters(); };

  $('#terms').on('change', '.sel', (e) => {
    const id = Number(e.target.dataset.id);
    e.target.checked ? selected.add(id) : selected.delete(id);
    updatePending(crud.dt.rows().data().toArray());
  });
  document.getElementById('sel-all').onchange = (e) => {
    crud.dt.rows({ search: 'applied' }).data().toArray().forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id)));
    crud.dt.rows().invalidate().draw(false);
    updatePending(crud.dt.rows().data().toArray());
  };
  document.getElementById('bulk-approve').onclick = () => bulk('approve');
  document.getElementById('bulk-reject').onclick = () => bulk('reject');
  document.getElementById('new-project').onclick = () => {
    crud.open(null);
    App.fillForm(document.getElementById('f-term'), { categorie: 'project', status: 'actief', bron: 'manueel' });
  };
});

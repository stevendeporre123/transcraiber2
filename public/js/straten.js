/* global App */
document.addEventListener('DOMContentLoaded', async () => {
  const { dt } = App.crud({
    table: '#streets', endpoint: '/streets', modal: 'm-street', form: 'f-street', newBtn: 'new-street', title: 'Straat',
    dtOptions: { pageLength: 50, deferRender: true },
    columns: [{ data: 'naam', render: App.esc }, { data: 'deelgemeente', render: App.esc }],
  });
  dt.one('draw', () => {
    const deel = [...new Set(dt.column(1).data().toArray())].filter(Boolean).sort();
    document.getElementById('deelgemeenten').innerHTML = deel.map((d) => `<option value="${App.esc(d)}">`).join('');
  });
});

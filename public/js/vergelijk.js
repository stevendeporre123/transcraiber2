/* global App */
document.addEventListener('DOMContentLoaded', async () => {
  const q = new URLSearchParams(location.search);
  let data;
  try { data = await App.api(`/compare?a=${q.get('a')}&b=${q.get('b')}`); } catch (e) { App.error(e); return; }

  const card = (r, letter) => {
    const m = r.options.models || {};
    return `<div class="col-md-6"><div class="card h-100"><div class="card-body">
      <h2 class="h6"><span class="badge text-bg-dark">${letter}</span> <a href="run.html?id=${r.id}">Run #${r.id}</a> ${r.label ? `<i>${App.esc(r.label)}</i>` : ''}</h2>
      <table class="table table-sm small mb-0">
        ${['normalizer', 'cleaner', 'resolver', 'writer'].map((s) => `<tr><td>${s}</td><td><code>${App.esc(m[s] || '')}</code></td><td>v${r.skill_versions?.[{ normalizer: 'gentse-normalizer', cleaner: 'transcript-cleaner', resolver: 'speaker-resolver', writer: 'verslag-writer' }[s]] ?? '?'}</td></tr>`).join('')}
        <tr><td>kost</td><td colspan="2">${App.fmtCost(r.cost)} · ${r.tokens_in} in / ${r.tokens_out} uit</td></tr>
      </table></div></div></div>`;
  };
  document.getElementById('cmp-head').innerHTML = card(data.a, 'A') + card(data.b, 'B')
    + `<div class="col-12 small text-body-secondary">${data.same} blokken identiek, ${data.rows.length} met verschillen
       (${data.rows.filter((r) => r.speakerDiff).length} met andere spreker).</div>`;

  const dt = App.table('#cmp', {
    data: data.rows,
    pageLength: 50,
    columns: [
      { data: 'block_id' },
      { data: null, render: (r) => `<span class="${r.speakerDiff ? 'text-danger fw-semibold' : ''}">${App.esc(r.speaker_a || '')}</span>` },
      { data: null, render: (r) => `<span class="${r.speakerDiff ? 'text-success fw-semibold' : ''}">${App.esc(r.speaker_b || '')}</span>` },
      {
        data: null, className: 'cell-text',
        render: (r) => (r.diff ? App.renderWordDiff(r.diff)
          : `<span class="small text-body-secondary">${r.merged_a ? `A: samengevoegd in ${r.merged_a}` : ''} ${r.merged_b ? `B: samengevoegd in ${r.merged_b}` : ''}</span>`),
      },
    ],
  });
  document.getElementById('only-speaker').onchange = (e) => {
    dt.clear().rows.add(e.target.checked ? data.rows.filter((r) => r.speakerDiff) : data.rows).draw();
  };
});

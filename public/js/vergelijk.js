/* global App */
// Twee runs (?a=&b=) of twee Testbank-tests (?ta=&tb=) per blok vergelijken.
document.addEventListener('DOMContentLoaded', async () => {
  const q = new URLSearchParams(location.search);
  const tests = q.has('ta');
  let data;
  try {
    data = await App.api(tests ? `/compare/tests?a=${q.get('ta')}&b=${q.get('tb')}` : `/compare?a=${q.get('a')}&b=${q.get('b')}`);
  } catch (e) { App.error(e); return; }

  const runCard = (r, letter) => {
    const m = r.options.models || {};
    return `<div class="col-md-6"><div class="card h-100"><div class="card-body">
      <h2 class="h6"><span class="badge text-bg-dark">${letter}</span> <a href="run.html?id=${r.id}">Run #${r.id}</a> ${r.label ? `<i>${App.esc(r.label)}</i>` : ''}</h2>
      <table class="table table-sm small mb-0">
        ${['normalizer', 'cleaner', 'resolver', 'writer'].map((s) => `<tr><td>${s}</td><td><code>${App.esc(m[s] || '')}</code></td><td>v${r.skill_versions?.[{ normalizer: 'gentse-normalizer', cleaner: 'transcript-cleaner', resolver: 'speaker-resolver', writer: 'verslag-writer' }[s]] ?? '?'}</td></tr>`).join('')}
        <tr><td>kost</td><td colspan="2">${App.fmtCost(r.cost)} · ${r.tokens_in} in / ${r.tokens_out} uit</td></tr>
      </table></div></div></div>`;
  };
  const testCard = (t, letter) => `<div class="col-md-6"><div class="card h-100"><div class="card-body">
      <h2 class="h6"><span class="badge text-bg-dark">${letter}</span> <a href="testen.html?test=${t.id}">Test #${t.id}</a> <code>${App.esc(t.model)}</code></h2>
      <table class="table table-sm small mb-0">
        <tr><td>skill</td><td>${App.esc(t.step)} v${t.skill_version}${t.skill_draft ? ' <span class="badge text-bg-warning">concept</span>' : ''}</td></tr>
        <tr><td>kost</td><td>${App.fmtCost(t.cost)} · ${t.tokens_in ?? 0} in / ${t.tokens_out ?? 0} uit</td></tr>
        <tr><td>duur</td><td>${App.fmtMs(t.ms_net ?? t.ms)} netto${t.ms && t.ms_net && t.ms !== t.ms_net ? ` (${App.fmtMs(t.ms)} totaal)` : ''}</td></tr>
        ${t.error ? `<tr><td>fout</td><td class="text-danger">${App.esc(t.error)}</td></tr>` : ''}
      </table></div></div></div>`;
  const card = tests ? testCard : runCard;
  const back = tests && data.a.batch_id ? `<div class="col-12"><a class="btn btn-sm btn-outline-secondary" href="modellen.html?id=${data.a.batch_id}"><i class="bi bi-arrow-left"></i> Terug naar vergelijking #${data.a.batch_id}</a></div>` : '';
  document.getElementById('cmp-head').innerHTML = back + card(data.a, 'A') + card(data.b, 'B')
    + `<div class="col-12 small text-body-secondary">${data.same} blokken identiek, ${data.rows.length} met verschillen
       (${data.rows.filter((r) => r.speakerDiff).length} met andere spreker).${tests && data.sameInput === false ? ' <span class="text-danger">Let op: de invoer van beide tests is niet dezelfde.</span>' : ''}</div>`;
  if (tests) document.querySelector('h1').textContent = 'Tests vergelijken';

  const dt = App.table('#cmp', {
    data: data.rows,
    pageLength: 50,
    columns: [
      { data: 'block_id' },
      { data: null, render: (r) => `<span class="${r.speakerDiff ? 'text-danger fw-semibold' : ''}">${App.esc(r.speaker_a || '')}</span>` },
      { data: null, render: (r) => `<span class="${r.speakerDiff ? 'text-success fw-semibold' : ''}">${App.esc(r.speaker_b || '')}</span>` },
      {
        data: null, className: 'cell-text',
        render: (r) => (r.diff ? (r.block_id === 'JSON' ? `<pre class="small mb-0" style="white-space:pre-wrap">${App.renderWordDiff(r.diff)}</pre>` : App.renderWordDiff(r.diff))
          : `<span class="small text-body-secondary">${r.merged_a ? `A: ${r.merged_a === 'ontbreekt' ? 'ontbreekt' : `samengevoegd in ${r.merged_a}`}` : ''} ${r.merged_b ? `B: ${r.merged_b === 'ontbreekt' ? 'ontbreekt' : `samengevoegd in ${r.merged_b}`}` : ''}</span>
             ${!r.merged_a && !r.merged_b && r.raw ? `<div class="small">${App.esc(r.raw)}</div>` : ''}`),
      },
    ],
  });
  document.getElementById('only-speaker').onchange = (e) => {
    dt.clear().rows.add(e.target.checked ? data.rows.filter((r) => r.speakerDiff) : data.rows).draw();
  };
});

/* global App, $ */
let skills = [];
let current = null;
let proposal = null;
let versionsTable;
let corrTable;
const selCorr = new Set();
let useSelection = false;

async function loadSkills(selectName) {
  skills = await App.api('/skills');
  const list = document.getElementById('skill-list');
  list.innerHTML = skills.map((s) => `<a class="list-group-item list-group-item-action ${current?.id === s.id ? 'active' : ''}" data-id="${s.id}">
      <div class="d-flex justify-content-between"><span class="fw-semibold">${App.esc(s.naam)}</span><span class="badge text-bg-secondary">v${s.version}</span></div>
      <div class="small ${current?.id === s.id ? '' : 'text-body-secondary'}">${s.in_pipeline ? 'pipeline' : 'hulp'} · ${Math.round(s.size / 100) / 10} kB</div></a>`).join('');
  const sel = document.getElementById('assist-skill');
  const prev = sel.value;
  sel.innerHTML = skills.filter((s) => s.naam !== 'skill-assistent').map((s) => `<option>${App.esc(s.naam)}</option>`).join('')
    + '<option value="skill-assistent">skill-assistent</option>';
  sel.value = selectName || prev || 'gentse-normalizer';
}

async function openSkill(id) {
  current = await App.api(`/skills/${id}`);
  document.querySelectorAll('#skill-list .list-group-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === current.id));
  document.getElementById('ed-title').textContent = current.naam;
  document.getElementById('ed-version').textContent = `v${current.version}`;
  document.getElementById('ed-content').value = current.content;
  document.getElementById('ed-download').href = `/api/skills/${current.id}/download`;
  document.getElementById('ed-note').value = '';
  const refs = JSON.parse(current.refs || '[]');
  document.getElementById('ed-refs').innerHTML = App.meta.refKeys.map((r) => `<div class="form-check form-check-inline">
      <input class="form-check-input ref-cb" type="checkbox" id="ref-${r}" value="${r}" ${refs.includes(r) ? 'checked' : ''}>
      <label class="form-check-label small" for="ref-${r}">${r}</label></div>`).join('');
  versionsTable.clear().rows.add(current.versions).draw();
  document.getElementById('assist-skill').value = current.naam;
}

async function loadCorrections() {
  const rows = await App.api('/corrections');
  corrTable.clear().rows.add(rows).draw(false);
  const open = rows.filter((r) => !r.processed).length;
  document.getElementById('corr-count').textContent = open;
  App.loadMeta();
}

function updateCorrButtons() {
  document.getElementById('corr-use').disabled = !selCorr.size;
  document.getElementById('corr-done').disabled = !selCorr.size;
  document.getElementById('assist-sel').textContent = useSelection && selCorr.size ? `${selCorr.size} geselecteerde correctie(s) worden meegestuurd.` : '';
}

function showProposal(p) {
  proposal = p;
  document.getElementById('p-skill').textContent = p.skill;
  document.getElementById('p-summary').textContent = p.samenvatting || '(geen samenvatting)';
  document.getElementById('p-diff').innerHTML = App.renderDiff(p.diff) || '<i>Geen wijzigingen in de skilltekst.</i>';
  document.getElementById('p-content').value = p.content;
  document.getElementById('p-note').value = (p.samenvatting || '').slice(0, 200);
  document.getElementById('p-cost').textContent = `${p.model} · ${App.fmtCost(p.cost)}`;
  document.getElementById('p-terms').innerHTML = p.termen.length ? `<h6>Voorgestelde termen voor de Gentse context</h6>
    <table class="table table-sm"><thead><tr><th></th><th>Categorie</th><th>Vervormingen</th><th>Correct</th></tr></thead><tbody>
    ${p.termen.map((t, i) => `<tr><td><input type="checkbox" class="form-check-input p-term" data-i="${i}" checked></td><td>${App.esc(t.categorie)}</td><td>${App.esc(t.varianten || '')}</td><td>${App.esc(t.correct)}</td></tr>`).join('')}
    </tbody></table>` : '';
  App.modal('m-proposal').show();
}

document.addEventListener('DOMContentLoaded', async () => {
  await App.loadMeta();
  App.modelDatalist();
  App.api('/settings').then((s) => { document.getElementById('assist-model').placeholder = s.effective?.assistant || ''; });

  versionsTable = App.table('#versions', {
    order: [[0, 'desc']], searching: false, pageLength: 10,
    columns: [
      { data: 'version', render: (v) => `v${v}` }, { data: 'created_at' }, { data: 'author' }, { data: 'note', render: App.esc },
      { data: null, orderable: false, render: () => '<button class="btn btn-sm btn-outline-secondary"><i class="bi bi-file-diff"></i></button>' },
    ],
  });
  $('#versions').on('click', 'tbody tr', async function () {
    const v = versionsTable.row(this).data();
    if (!v) return;
    const d = await App.api(`/skills/${current.id}/versions/${v.version}`);
    document.getElementById('v-num').textContent = `v${v.version}`;
    document.getElementById('v-diff').innerHTML = App.renderDiff(d.diff) || '<i>Identiek aan de huidige versie.</i>';
    document.getElementById('v-restore').onclick = async () => {
      try { await App.api(`/skills/${current.id}/restore/${v.version}`, { method: 'POST' }); App.modal('m-version').hide(); App.toast(`Versie ${v.version} teruggezet als nieuwe versie`); await loadSkills(); openSkill(current.id); } catch (e) { App.error(e); }
    };
    App.modal('m-version').show();
  });

  corrTable = App.table('#corrections', {
    order: [[1, 'desc']], pageLength: 25,
    columns: [
      { data: null, orderable: false, render: (r) => `<input type="checkbox" class="form-check-input c-sel" data-id="${r.id}" ${selCorr.has(r.id) ? 'checked' : ''}>` },
      { data: 'created_at' },
      { data: null, render: (r) => `<span class="small">${App.esc(r.titel || '')} ${App.esc(r.datum || '')}</span>` },
      { data: null, render: (r) => (r.run_id ? `<a href="run.html?id=${r.run_id}">#${r.run_id}</a> ${App.esc(r.block_id)}` : App.esc(r.block_id)) },
      { data: 'field' },
      { data: null, className: 'cell-text', render: (r) => `<span class="small">${r.diff ? App.renderWordDiff(r.diff) : `<del>${App.esc(r.before)}</del> → <ins>${App.esc(r.after)}</ins>`}</span>` },
      { data: 'lesson', render: (l) => `<span class="small">${App.esc(l || '')}</span>` },
      { data: 'learned', render: (l) => `<span class="small">${App.esc(l || '')}</span>` },
      { data: 'processed', render: (p) => (p ? '<span class="badge text-bg-success">verwerkt</span>' : '<span class="badge text-bg-info">open</span>') },
      { data: null, orderable: false, render: (r) => `<button class="btn btn-sm btn-outline-danger c-del" data-id="${r.id}"><i class="bi bi-trash"></i></button>` },
    ],
  });
  $('#corrections').on('change', '.c-sel', (e) => {
    const id = Number(e.target.dataset.id);
    e.target.checked ? selCorr.add(id) : selCorr.delete(id);
    updateCorrButtons();
  });
  $('#corrections').on('click', '.c-del', async (e) => {
    await App.api(`/corrections/${e.currentTarget.dataset.id}`, { method: 'DELETE' });
    loadCorrections();
  });
  document.getElementById('corr-use').onclick = () => {
    useSelection = true;
    updateCorrButtons();
    document.getElementById('f-assist').scrollIntoView({ behavior: 'smooth' });
    document.querySelector('#f-assist [name=instruction]').focus();
  };
  document.getElementById('corr-done').onclick = async () => {
    for (const id of selCorr) await App.api(`/corrections/${id}`, { method: 'PUT', body: { processed: 1 } });
    selCorr.clear();
    useSelection = false;
    updateCorrButtons();
    loadCorrections();
  };

  await loadSkills();
  $('#skill-list').on('click', '.list-group-item', function () { openSkill(Number(this.dataset.id)); });
  const params = new URLSearchParams(location.search);
  const first = skills.find((s) => s.naam === (params.get('skill') || 'gentse-normalizer')) || skills[0];
  if (first) openSkill(first.id);
  loadCorrections();

  document.getElementById('ed-save').onclick = async () => {
    if (!current) return;
    try {
      const refs = [...document.querySelectorAll('.ref-cb:checked')].map((c) => c.value);
      await App.api(`/skills/${current.id}`, { method: 'PUT', body: { content: document.getElementById('ed-content').value, note: document.getElementById('ed-note').value, refs } });
      App.toast('Opgeslagen');
      await loadSkills();
      openSkill(current.id);
    } catch (e) { App.error(e); }
  };

  document.getElementById('f-assist').onsubmit = async (e) => {
    e.preventDefault();
    const d = App.readForm(e.target);
    if (!d.instruction && !d.includeCorrections && !(useSelection && selCorr.size)) { App.toast('Typ een vraag of neem correcties mee.', 'warning'); return; }
    const btn = document.getElementById('btn-propose');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Bezig…';
    try {
      const p = await App.api('/skills/propose', {
        method: 'POST',
        body: { skillName: d.skill, instruction: d.instruction, model: d.model || undefined, includeCorrections: !!d.includeCorrections, correctionIds: useSelection ? [...selCorr] : undefined },
      });
      showProposal(p);
    } catch (err) { App.error(err); } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-magic"></i> Genereer voorstel';
    }
  };

  document.getElementById('p-apply').onclick = async () => {
    const termen = [...document.querySelectorAll('.p-term:checked')].map((c) => proposal.termen[Number(c.dataset.i)]);
    try {
      const r = await App.api('/skills/apply', {
        method: 'POST',
        body: { skill: proposal.skill, baseVersion: proposal.baseVersion, content: document.getElementById('p-content').value, note: document.getElementById('p-note').value, termen, correctionIds: proposal.correctionIds },
      });
      App.modal('m-proposal').hide();
      App.toast(`${proposal.skill} bijgewerkt naar v${r.skill.version}${r.termIds.length ? ` · ${r.termIds.length} term(en) toegevoegd` : ''}`);
      document.querySelector('#f-assist [name=instruction]').value = '';
      selCorr.clear();
      useSelection = false;
      updateCorrButtons();
      await loadSkills(proposal.skill);
      openSkill(r.skill.id);
      loadCorrections();
    } catch (e) { App.error(e); }
  };
});

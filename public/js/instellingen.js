/* global App */
const MODEL_FIELDS = [
  ['model_default', 'Algemeen standaardmodel'], ['model_normalizer', 'Gentse normalizer'], ['model_cleaner', 'Transcript cleaner'],
  ['model_resolver', 'Speaker resolver'], ['model_writer', 'Verslag writer'], ['model_agenda', 'Agenda uitlezen'],
  ['model_intake', 'LLM-intake'], ['model_assistant', 'Skill-assistent (promptvenster)'],
];

async function load() {
  const s = await App.api('/settings');
  const f = document.getElementById('f-settings');
  App.fillForm(f, { ...s, harvest_normalizer: s.harvest_normalizer == null ? 1 : Number(s.harvest_normalizer), openrouter_api_key: '' });
  document.getElementById('key-status').innerHTML = s.mock
    ? '<span class="badge text-bg-warning">MOCK_LLM actief</span> er worden geen echte modellen aangeroepen.'
    : s.hasKey ? `<i class="bi bi-check-circle-fill text-success"></i> API-key ingesteld${s.keyFromEnv ? ' (via .env)' : ''}.`
      : '<i class="bi bi-exclamation-triangle-fill text-warning"></i> Nog geen API-key ingesteld.';
  for (const [k] of MODEL_FIELDS) {
    const step = k.replace('model_', '');
    if (s.effective?.[step]) f[k].placeholder = s.effective[step];
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('model-fields').innerHTML = MODEL_FIELDS.map(([k, l]) => `<div class="col-md-6"><label class="form-label small mb-0">${l}</label>
    <input class="form-control form-control-sm" name="${k}" list="models-list" ${k === 'model_default' ? 'placeholder="google/gemini-2.5-flash"' : ''}></div>`).join('');
  App.modelDatalist();
  load().catch(App.error);
  const f = document.getElementById('f-settings');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = App.readForm(f);
    if (!d.openrouter_api_key) delete d.openrouter_api_key;
    try { await App.api('/settings', { method: 'PUT', body: d }); App.toast('Instellingen opgeslagen'); load(); } catch (err) { App.error(err); }
  };
  document.getElementById('clear-key').onclick = async () => {
    if (!(await App.confirm('Opgeslagen API-key wissen?'))) return;
    await App.api('/settings', { method: 'PUT', body: { clear_key: true } });
    load();
  };
});

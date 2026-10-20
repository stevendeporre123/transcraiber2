import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Raadsleden, schepenen, burgemeester, voorzitter
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  naam TEXT NOT NULL,
  match_namen TEXT,            -- achternaam-varianten voor matching, gescheiden door /
  geslacht TEXT,               -- M / V / X
  fractie TEXT,
  functie TEXT NOT NULL DEFAULT 'raadslid', -- burgemeester, voorzitter, ondervoorzitter, schepen, raadslid
  aanspreekvorm TEXT,          -- bv. "mijnheer de burgemeester"
  portefeuille TEXT,           -- officiele bevoegdheden (schepenen)
  trefwoorden TEXT,            -- onderwerpen voor bevoegdheid-matching
  notitie TEXT,
  actief INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Gentse context: organisaties, wijken, projecten, STT-vervormingen, richtlijnen
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  categorie TEXT NOT NULL,
  varianten TEXT,              -- STT-vervormingen, gescheiden door komma
  correct TEXT NOT NULL,
  toelichting TEXT,
  bron TEXT NOT NULL DEFAULT 'manueel',   -- seed, manueel, agenda, correctie, normalizer
  status TEXT NOT NULL DEFAULT 'actief',  -- actief, voorstel, inactief
  meeting_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commissies (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  naam TEXT,
  schepenen TEXT,
  voorzitter TEXT
);

CREATE TABLE IF NOT EXISTS streets (
  id INTEGER PRIMARY KEY,
  naam TEXT NOT NULL,
  deelgemeente TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  naam TEXT NOT NULL UNIQUE,
  beschrijving TEXT,
  content TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',  -- JSON: referenties die meegestuurd worden
  in_pipeline INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  note TEXT,
  author TEXT,                 -- seed, manueel, assistent
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  titel TEXT,
  orgaan TEXT NOT NULL DEFAULT 'gemeenteraad',  -- gemeenteraad / commissie
  commissie TEXT,
  voorzitter TEXT,
  datum TEXT,
  input_file TEXT,
  input_name TEXT,
  input_type TEXT,             -- pdf, docx, vtt, srt, txt
  has_timecodes INTEGER NOT NULL DEFAULT 0,
  agenda_file TEXT,
  agenda_name TEXT,
  agenda_text TEXT,
  agenda_json TEXT,
  agenda_status TEXT,          -- geen, bezig, klaar, fout
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'wachtrij',  -- wachtrij, bezig, klaar, fout
  progress TEXT,
  options TEXT,                -- JSON: modellen per stap, opties
  skill_versions TEXT,         -- JSON: welke skillversies gebruikt zijn
  report TEXT,                 -- JSON: samenvatting, beslissingen, punten
  warnings TEXT,               -- JSON array
  error TEXT,
  cost REAL DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  chunk INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  input TEXT,
  output TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  ms INTEGER,
  status TEXT,
  warnings TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(run_id, step, chunk)
);

CREATE TABLE IF NOT EXISTS run_blocks (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  t_start REAL,
  t_end REAL,
  speaker_raw TEXT,
  text_raw TEXT,
  text_norm TEXT,
  text_clean TEXT,
  speaker_name TEXT,
  fractie TEXT,
  functie TEXT,
  zekerheid TEXT,
  text_final TEXT,
  point_idx INTEGER,
  merged_into TEXT,            -- samengevoegd door transcript-cleaner
  edited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, block_id)
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  block_id TEXT,
  field TEXT,                  -- text, speaker
  before TEXT,
  after TEXT,
  lesson TEXT,                 -- optionele uitleg van de gebruiker
  learned TEXT,                -- bv. term:12, skill:speaker-resolver
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Debug-log per run (ook naar stdout / docker logs)
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  test_id INTEGER,
  ts TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  level TEXT NOT NULL DEFAULT 'info',   -- debug, info, warn, error
  step TEXT,
  chunk INTEGER,
  message TEXT NOT NULL,
  data TEXT
);

-- Testbank: losse skill-tests op een stuk input
CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  step TEXT NOT NULL,
  model TEXT,
  skill_version INTEGER,
  skill_draft INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  input TEXT,
  system TEXT,
  output TEXT,
  analysis TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, ms INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_terms_cat ON terms(categorie);
CREATE INDEX IF NOT EXISTS idx_log_run ON run_log(run_id, id);
CREATE INDEX IF NOT EXISTS idx_blocks_ord ON run_blocks(run_id, ord);
`);

/** Leeg of null opgeslagen = niet ingesteld → fallback. */
// Kolommen die later toegevoegd zijn (bestaande databanken bijwerken)
const addColumn = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumn('run_steps', 'system', 'TEXT');
addColumn('run_steps', 'attempts', 'INTEGER');

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null && String(row.value).trim() !== '' ? row.value : fallback;
}

/** Numerieke instelling binnen grenzen; ongeldig of leeg → fallback. */
export function getNumberSetting(key, fallback, min = -Infinity, max = Infinity) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= min && n <= max && getSetting(key) != null ? n : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

export const json = (s, fallback = null) => {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

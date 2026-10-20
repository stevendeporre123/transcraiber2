// Eenmalige import van de md-referentiebestanden en skills naar SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { db } from './db.js';

const SEED = path.join(ROOT, 'seed');
const read = (f) => fs.readFileSync(path.join(SEED, f), 'utf8');

// Splitst md in secties per ## / ### kop: [{level, title, lines}]
function sections(md) {
  const out = [];
  let cur = { level: 0, title: '', lines: [] };
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) { out.push(cur); cur = { level: m[1].length, title: m[2].trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  out.push(cur);
  return out;
}

// Leest md-tabellen uit een reeks regels: rijen als arrays van cellen (zonder kop).
function tableRows(lines) {
  const rows = [];
  let header = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!header) { header = cells; continue; }
    rows.push(cells);
  }
  return rows;
}

const prose = (lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^-{3,}$/gm, '').trim();

function seedMembers() {
  const md = read('references/leden.md');
  const bev = read('references/bevoegdheden.md');
  const ins = db.prepare(`INSERT INTO members (naam, match_namen, geslacht, fractie, functie, aanspreekvorm, notitie)
    VALUES (@naam, @match, @geslacht, @fractie, @functie, @aanspreek, @notitie)`);
  const byName = new Map();
  const add = (m) => {
    if (byName.has(m.naam)) return;
    const r = ins.run({ geslacht: null, match: null, aanspreek: null, notitie: null, ...m });
    byName.set(m.naam, r.lastInsertRowid);
  };
  for (const s of sections(md)) {
    const rows = tableRows(s.lines);
    if (/Functie-overzicht/i.test(s.title)) {
      for (const [aanspreek, naam, functie, fractie] of rows) {
        const achternaam = naam.split(' ').slice(1).join(' ');
        add({ naam, functie, fractie, aanspreek, match: achternaam, geslacht: /mevrouw/i.test(aanspreek) ? 'V' : 'M' });
      }
    } else if (/^Schepenen/i.test(s.title) || /^Raadsleden/i.test(s.title)) {
      const functie = /^Schepenen/i.test(s.title) ? 'schepen' : 'raadslid';
      for (const [match, naam, geslacht, fractie, notitie] of rows) {
        add({ naam, match, geslacht, fractie, functie, notitie: notitie || null });
      }
    }
  }
  // Bevoegdheden: portefeuille uit de overzichtstabel, trefwoorden uit de ### secties
  const upd = db.prepare('UPDATE members SET portefeuille = COALESCE(?, portefeuille), trefwoorden = COALESCE(?, trefwoorden) WHERE naam = ?');
  for (const s of sections(bev)) {
    if (/^Overzicht bevoegdheden/i.test(s.title)) {
      for (const [naam, , , bevoegd] of tableRows(s.lines)) upd.run(bevoegd, null, naam);
    } else if (s.level === 3) {
      const naam = s.title.replace(/\(.*\)/, '').trim();
      const tw = s.lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).join('; ');
      if (tw) upd.run(null, tw, naam);
    } else if (/Relatie tot commissies/i.test(s.title)) {
      const insC = db.prepare('INSERT OR IGNORE INTO commissies (code, naam, schepenen) VALUES (?, ?, ?)');
      for (const [comm, schepenen] of tableRows(s.lines)) {
        const m = comm.match(/^(\S+)\s*\((.*)\)/);
        if (m) insC.run(m[1], m[2], schepenen);
      }
    }
  }
}

const CATEGORY_MAP = [
  [/Organisaties/i, 'organisatie'],
  [/Wijken/i, 'wijk'],
  [/Festiviteiten/i, 'evenement'],
  [/Gebouwen/i, 'gebouw'],
  [/Procedures/i, 'procedure'],
  [/Regelgeving/i, 'regelgeving'],
  [/Actie- en projectnamen/i, 'project'],
  [/Nummers/i, 'nummer'],
  [/namen raadsleden/i, 'naam_fout'],
  [/commissies/i, 'commissie'],
  [/STT-vervormingen Vlaamse/i, 'naam_fout'],
  [/STT-vervormingen federale/i, 'naam_fout'],
  [/Vlaamse Regering/i, 'vlaamse_regering'],
  [/Federale Regering/i, 'federale_regering'],
  [/Aanvullingen/i, 'aanvulling'],
  [/Stratenlijst/i, 'richtlijn'],
  [/Opmerking/i, 'richtlijn'],
];

function seedTerms() {
  const md = read('references/gentse-terminologie.md');
  const ins = db.prepare(`INSERT INTO terms (categorie, varianten, correct, toelichting, bron)
    VALUES (?, ?, ?, ?, 'seed')`);
  for (const s of sections(md)) {
    if (!s.title) continue;
    const cat = (CATEGORY_MAP.find(([re]) => re.test(s.title)) || [null, 'richtlijn'])[1];
    const rows = tableRows(s.lines);
    if (cat === 'vlaamse_regering' || cat === 'federale_regering') {
      for (const [naam, functie, partij, bevoegd] of rows) ins.run(cat, null, naam, `${functie}, ${partij}: ${bevoegd}`);
    } else {
      for (const [varianten, correct, ...rest] of rows) {
        ins.run(cat, varianten.replace(/"/g, ''), correct.replace(/"/g, ''), rest.filter(Boolean).join(' — ') || null);
      }
    }
    // Losse tekst (gebruiksregels, disambiguatie) bewaren als richtlijn
    const text = prose(s.lines.filter((l) => !l.trim().startsWith('|')));
    if (text.length > 40) ins.run('richtlijn', null, s.title, text);
  }
}

function seedStreets() {
  const md = read('references/stratenlijst.md');
  const ins = db.prepare('INSERT INTO streets (naam, deelgemeente) VALUES (?, ?)');
  let deel = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) deel = h[1].trim();
    else if (deel && line.startsWith('- ')) ins.run(line.slice(2).trim(), deel);
  }
}

// skill-bestanden: frontmatter (name, description, refs) + inhoud
export function parseSkillFile(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (m) {
    const fm = m[1];
    meta.name = (fm.match(/^name:\s*(.*)$/m) || [])[1]?.trim();
    const d = fm.match(/^description:\s*>?\s*\n?([\s\S]*?)(?=^\w+:|$(?![\s\S]))/m);
    meta.description = d ? d[1].replace(/\s+/g, ' ').trim() : '';
    const r = fm.match(/^refs:\s*\[(.*)\]$/m);
    meta.refs = r ? r[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
    const p = fm.match(/^in_pipeline:\s*(\w+)$/m);
    meta.in_pipeline = p ? p[1] !== 'false' : true;
  }
  return meta;
}

function seedSkills() {
  const dir = path.join(SEED, 'skills');
  const ins = db.prepare(`INSERT INTO skills (naam, beschrijving, content, refs, in_pipeline) VALUES (?, ?, ?, ?, ?)`);
  const insV = db.prepare(`INSERT INTO skill_versions (skill_id, version, content, note, author) VALUES (?, 1, ?, 'Initiële import', 'seed')`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const meta = parseSkillFile(content);
    const naam = meta.name || f.replace(/\.md$/, '');
    if (db.prepare('SELECT 1 FROM skills WHERE naam = ?').get(naam)) continue;
    const r = ins.run(naam, meta.description, content, JSON.stringify(meta.refs), meta.in_pipeline ? 1 : 0);
    insV.run(r.lastInsertRowid, content);
  }
}

export function seedIfEmpty() {
  const tx = db.transaction(() => {
    if (!db.prepare('SELECT COUNT(*) n FROM members').get().n) seedMembers();
    if (!db.prepare('SELECT COUNT(*) n FROM terms').get().n) seedTerms();
    if (!db.prepare('SELECT COUNT(*) n FROM streets').get().n) seedStreets();
    seedSkills(); // voegt enkel ontbrekende skills toe
  });
  tx();
}

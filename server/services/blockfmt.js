// Tussenformaat van de pipeline: "## B001 | spreker: ..." + tekst, plus secties (NOTITIES, SPREKERTABEL, KOP).

const HEAD = /^##\s*(B\d{1,5})\s*\|\s*spreker:\s*(.*)$/i;
const SECTION = /^##\s*([A-ZÀ-Ý ]{3,})\s*$/;

export function blockId(n) {
  return 'B' + String(n).padStart(3, '0');
}

export function blockNum(id) {
  return Number(String(id).replace(/\D/g, ''));
}

/** Parse modeluitvoer naar { blocks: [{id, speaker, text}], sections: {NOTITIES: '...'} } */
export function parseBlocks(text) {
  const blocks = [];
  const sections = {};
  let cur = null;
  let sec = null;
  const lines = String(text).replace(/\r/g, '').replace(/^```\w*\n?|```\s*$/gm, '').split('\n');
  for (const line of lines) {
    const h = line.match(HEAD);
    if (h) {
      sec = null;
      cur = { id: h[1].toUpperCase(), speaker: h[2].trim(), lines: [] };
      blocks.push(cur);
      continue;
    }
    const s = line.match(SECTION);
    if (s) {
      cur = null;
      sec = s[1].trim().toUpperCase();
      sections[sec] = '';
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (sec) sections[sec] += line + '\n';
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return {
    blocks: blocks.map((b) => ({ id: normId(b.id), speaker: b.speaker, text: b.lines.join(' ').replace(/\s+/g, ' ').trim() })),
    sections,
  };
}

const normId = (id) => blockId(blockNum(id));

export function serializeBlocks(blocks, { speakerField = 'speaker' } = {}) {
  return blocks.map((b) => `## ${b.id} | spreker: ${b[speakerField] || '?'}\n${b.text}`).join('\n\n');
}

/** "Naam | fractie | functie | zekerheid: hoog" → velden */
export function parseSpeakerHeader(s) {
  const parts = String(s).split('|').map((x) => x.trim());
  const out = { speaker_name: parts[0] || 'Onbekende spreker', fractie: null, functie: null, zekerheid: null };
  for (const p of parts.slice(1)) {
    const z = p.match(/^zekerheid:\s*(\w+)/i);
    if (z) out.zekerheid = z[1].toLowerCase();
    else if (out.fractie === null) out.fractie = p === '-' ? '' : p;
    else if (out.functie === null) out.functie = p === '-' ? '' : p;
  }
  if (!out.zekerheid) out.zekerheid = /onbekend/i.test(out.speaker_name) ? 'laag' : 'middel';
  return out;
}

export const wordCount = (s) => (String(s).match(/\S+/g) || []).length;

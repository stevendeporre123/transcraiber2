// Nep-LLM voor tests en demo's (MOCK_LLM=1): volgt het uitvoerformaat van elke skill
// met eenvoudige regels, zodat de hele pipeline zonder API-key te testen is.
import { parseBlocks, serializeBlocks } from './blockfmt.js';

const skillOf = (system) => (system.match(/# Skill:\s*([\w-]+)/) || [])[1];

export function mockCompletion({ system, user }) {
  const skill = skillOf(system);
  const { blocks } = parseBlocks(user);
  switch (skill) {
    case 'gentse-normalizer': {
      const fixed = blocks.map((b) => ({ ...b, text: b.text.replace(/\bnieuw gent\b/gi, 'Nieuw-Gent').replace(/\btaaldeman\b/gi, 'Taeldeman') }));
      return `${serializeBlocks(fixed)}\n\n## NOTITIES\nCorrecties (0):\nTwijfelgevallen:\nNieuwe vervormingen voor de lijsten:\n- mock-vervorming -> Mockterm (project)\n`;
    }
    case 'transcript-cleaner': {
      const fixed = blocks.map((b) => ({
        ...b,
        text: b.text.replace(/\b(uhm|euh|eh|uh)\b,?\s*/gi, '').replace(/\b(\w+) \1\b/gi, '$1').replace(/\s+/g, ' ').trim(),
      }));
      return `${serializeBlocks(fixed)}\n\n## NOTITIES\nAantal verwijderde opvullers/herhalingen: ongeveer 1\n`;
    }
    case 'speaker-resolver': {
      const heads = blocks.map((b) => {
        const label = b.speaker && b.speaker !== '?' ? b.speaker : 'Onbekende spreker';
        return `## ${b.id} | spreker: ${label} | - | - | zekerheid: ${label === 'Onbekende spreker' ? 'laag' : 'middel'}`;
      });
      return `${heads.join('\n')}\n\n## SPREKERTABEL\n(mock)\n\n## NOTITIES\nMock-resolver.\n`;
    }
    case 'verslag-writer': {
      if (/MODUS:\s*SLOT/.test(user)) {
        return JSON.stringify({ titel: 'Vergaderverslag (mock)', samenvatting: 'De raad besprak enkele punten. Dit is een testsamenvatting.', waarschuwingen: [] });
      }
      const first = blocks[0]?.id || 'B001';
      const half = blocks[Math.floor(blocks.length / 2)]?.id || first;
      const vervolg = /VORIG PUNT:\s*\S/.test(user) && !/VORIG PUNT:\s*geen/i.test(user);
      const punten = [{ start: first, type: 'agendapunt', nummer: '1', titel: 'Eerste onderwerp', samenvatting: 'Bespreking van het eerste onderwerp.', beslissingen: [], vervolg }];
      if (half !== first) punten.push({ start: half, type: 'agendapunt', nummer: '2', titel: 'Tweede onderwerp', samenvatting: 'Bespreking van het tweede onderwerp.', beslissingen: ['Het punt is aangenomen.'] });
      return JSON.stringify({ punten });
    }
    case 'agenda-extractor':
      return JSON.stringify({
        vergadering: { orgaan: 'gemeenteraad', commissie: '', datum: '', voorzitter: '' },
        punten: [{ nummer: '1', titel: 'Mock-agendapunt', type: 'besluit', indieners: [], schepen: '', kern: 'Test.' }],
        context: [{ categorie: 'project', correct: 'Mockproject', toelichting: 'uit mock-agenda' }],
      });
    case 'transcript-intake': {
      const paras = user.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
      return paras.map((p, i) => `## B${String(i + 1).padStart(3, '0')} | spreker: ?\n${p}`).join('\n\n') + '\n\n## NOTITIES\nMock-intake.\n';
    }
    case 'skill-assistent': {
      const cur = (user.match(/<<<SKILL\n([\s\S]*?)\nSKILL>>>/) || [])[1] || '';
      return JSON.stringify({ content: `${cur.trimEnd()}\n\n<!-- mock-aanpassing -->\n`, samenvatting: 'Mock: commentaarregel toegevoegd.', termen: [] });
    }
    default:
      return 'mock';
  }
}

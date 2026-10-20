import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const OUTPUT_DIR = path.join(DATA_DIR, 'output');
for (const d of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });

export const config = {
  port: Number(process.env.PORT || 3000),
  dbFile: path.join(DATA_DIR, 'transcraiber.sqlite'),
  // Mock-LLM: laat de pipeline draaien zonder OpenRouter (tests / demo).
  mockLlm: process.env.MOCK_LLM === '1',
};

// Pipeline-stappen en de skill die elke stap gebruikt.
export const STEPS = {
  agenda: { skill: 'agenda-extractor', label: 'Agenda uitlezen' },
  intake: { skill: 'transcript-intake', label: 'Intake (LLM, enkel ruwe PDF/DOCX)' },
  normalizer: { skill: 'gentse-normalizer', label: 'Gentse normalizer' },
  cleaner: { skill: 'transcript-cleaner', label: 'Transcript cleaner' },
  resolver: { skill: 'speaker-resolver', label: 'Speaker resolver' },
  writer: { skill: 'verslag-writer', label: 'Verslag writer' },
  assistant: { skill: 'skill-assistent', label: 'Skill-assistent' },
};

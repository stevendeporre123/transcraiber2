// Debug-logging: elke stap van een run (of testbank-test) naar SQLite én naar stdout (docker logs).
import { db } from '../db.js';

const MAX_DATA = 20000; // tekens JSON per logregel
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const stdoutLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

function serialize(data) {
  if (data === undefined) return null;
  let s = JSON.stringify(data);
  if (s.length > MAX_DATA) s = JSON.stringify({ afgekapt: true, preview: s.slice(0, MAX_DATA) });
  return s;
}

/** log({ runId, testId, level, step, chunk, message, data }) */
export function log({ runId = null, testId = null, level = 'info', step = null, chunk = null, message, data }) {
  try {
    db.prepare('INSERT INTO run_log (run_id, test_id, level, step, chunk, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, testId, level, step, chunk, message, serialize(data));
  } catch { /* loggen mag nooit de pipeline breken */ }
  if ((LEVELS[level] ?? 20) >= stdoutLevel) {
    const where = [runId != null ? `run ${runId}` : testId != null ? `test ${testId}` : null, step, chunk != null ? `deel ${chunk === 999 ? 'slot' : chunk + 1}` : null].filter(Boolean).join(' · ');
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${where ? `[${where}] ` : ''}${message}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }
}

export const runLogger = (runId) => ({
  debug: (message, extra = {}) => log({ runId, level: 'debug', message, ...extra }),
  info: (message, extra = {}) => log({ runId, level: 'info', message, ...extra }),
  warn: (message, extra = {}) => log({ runId, level: 'warn', message, ...extra }),
  error: (message, extra = {}) => log({ runId, level: 'error', message, ...extra }),
});

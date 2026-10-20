import { config } from '../config.js';
import { getSetting } from '../db.js';
import { mockCompletion } from './mock-llm.js';

const BASE = 'https://openrouter.ai/api/v1';

export function apiKey() {
  return process.env.OPENROUTER_API_KEY || getSetting('openrouter_api_key') || '';
}

export function defaultModel(step) {
  return getSetting(`model_${step}`) || getSetting('model_default') || 'google/gemini-2.5-flash';
}

/**
 * Eén chat-completion. Geeft { text, tokensIn, tokensOut, cost, model, ms }.
 * Herprobeert bij 429/5xx met exponentiële backoff.
 */
export async function complete({ model, system, user, temperature, json = false, maxTokens }) {
  const t0 = Date.now();
  if (config.mockLlm) {
    const text = mockCompletion({ system, user, json });
    return { text, tokensIn: Math.round((system.length + user.length) / 4), tokensOut: Math.round(text.length / 4), cost: 0, model: 'mock', ms: Date.now() - t0 };
  }
  const key = apiKey();
  if (!key) throw new Error('Geen OpenRouter API-key ingesteld (Instellingen of OPENROUTER_API_KEY).');

  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: temperature ?? Number(getSetting('temperature', '0.1')),
    usage: { include: true },
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/stevendeporre123/transcraiber2',
          'X-Title': 'Transcraiber',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(getSetting('timeout_s', '600')) * 1000),
      });
    } catch (e) { lastErr = e; continue; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { lastErr = new Error(`OpenRouter ${res.status}: ${data.error?.message || ''}`); continue; }
    // Sommige modellen ondersteunen response_format niet: één keer zonder proberen
    if (!res.ok && json && body.response_format && /response_format|json/i.test(data.error?.message || '')) {
      delete body.response_format; continue;
    }
    if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text && choice?.finish_reason) { lastErr = new Error(`Leeg antwoord (finish_reason: ${choice.finish_reason})`); continue; }
    return {
      text,
      finishReason: choice?.finish_reason,
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      cost: data.usage?.cost || 0,
      model: data.model || model,
      ms: Date.now() - t0,
    };
  }
  throw lastErr || new Error('OpenRouter: onbekende fout');
}

let modelCache = { at: 0, list: [] };
export async function listModels() {
  if (Date.now() - modelCache.at < 3600_000 && modelCache.list.length) return modelCache.list;
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const data = await res.json();
  modelCache = {
    at: Date.now(),
    list: data.data.map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context_length,
      prompt: Number(m.pricing?.prompt || 0) * 1e6,
      completion: Number(m.pricing?.completion || 0) * 1e6,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return modelCache.list;
}

// Haalt het eerste JSON-object uit een modelantwoord (ook als er ```json omheen staat).
export function parseJsonLoose(text) {
  const t = text.replace(/^﻿/, '').trim();
  try { return JSON.parse(t); } catch { /* verder */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* verder */ } }
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error('Geen geldige JSON in modelantwoord');
}

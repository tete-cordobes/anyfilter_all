import { questionsFor, validScores } from './shared.js';

export function buildRequest(provider, apiKey, state, rule) {
  const type = provider === 'vercel' ? 'boolean' : 'noul';
  const questions = Object.fromEntries(Object.entries(questionsFor(rule)).map(([id, instructions]) =>
    [id, { type, instructions }]));
  if (provider === 'vercel') return {
    url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json',
      'ai-model-id': 'typesafe-ai/jev', 'ai-gateway-protocol-version': '0.0.1', 'ai-gateway-auth-method': 'api-key' },
    body: { state, questions },
  };
  return {
    url: 'https://api.typesafe.ai/v1/systemone',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: { model: 'jev-latest', state, questions },
  };
}

export function parseScores(provider, json) {
  const field = provider === 'vercel' ? 'probability' : 'noul';
  const scores = Object.fromEntries(['advertisement', 'filter'].map((id) => [id, json?.answers?.[id]?.[field]]));
  return validScores(scores) ? scores : null;
}

export async function evaluate(settings, state, fetchImpl = fetch, timeoutMs = 5000) {
  if (!settings.apiKey) return { ok: false, error: 'no-key' };
  const request = buildRequest(settings.provider, settings.apiKey, state, settings.rule);
  const start = performance.now();
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!response.ok) {
      const rawRetry = response.headers.get('retry-after');
      const seconds = rawRetry === null ? NaN : Number(rawRetry);
      const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(rawRetry ?? '') - Date.now();
      return { ok: false, error: response.status === 429 ? 'rate-limited' :
        [401, 403].includes(response.status) ? 'auth' : 'provider-http', status: response.status, latencyMs,
        ...(response.status === 429 ? { retryAfterMs: Math.max(1000, Math.min(300000, Number.isFinite(retryAfterMs) ? retryAfterMs : 25000)) } : {}) };
    }
    const json = await response.json();
    const scores = parseScores(settings.provider, json);
    if (!scores) return { ok: false, error: 'invalid-scores', latencyMs };
    const tokens = json?.usage?.[settings.provider === 'vercel' ? 'inputTokens' : 'input_tokens'];
    return { ok: true, scores, latencyMs, tokens: Number.isFinite(tokens) ? tokens : 0 };
  } catch (error) {
    return { ok: false, error: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' :
      error instanceof SyntaxError ? 'invalid-json' : 'network',
      latencyMs: Math.round(performance.now() - start) };
  }
}

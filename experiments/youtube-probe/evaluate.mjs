import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evaluate } from './extension/provider.js';
import { DEFAULTS } from './extension/shared.js';
import { cases } from './tests/cases.mjs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const provider = process.env.ANYFILTER_PROBE_PROVIDER ||
  (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY ? 'typesafe' : 'vercel');
if (!['typesafe', 'vercel'].includes(provider)) throw new Error('ANYFILTER_PROBE_PROVIDER must be typesafe or vercel');
const apiKey = provider === 'typesafe' ? process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY :
  process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY;
mkdirSync('reports', { recursive: true });
const report = {
  at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  evidence: 'Real Jev API with synthetic labelled evidence. Does not test live YouTube playback or DOM.',
  provider, status: apiKey ? 'running' : 'blocked-no-api-key', results: [],
};
if (!apiKey) {
  writeFileSync('reports/youtube-probe-jev.json', JSON.stringify(report, null, 2));
  console.error('BLOCKED: set TYPESAFE_API_KEY or AI_GATEWAY_API_KEY in .env.local. No model requests were made.');
  process.exitCode = 2;
} else {
  for (const item of cases) {
    const result = await evaluate({ ...DEFAULTS, apiKey, provider, rule: item.rule }, item.state);
    const matches = result.ok && Object.entries(item.expected).every(([key, label]) =>
      label ? result.scores[key] >= 0.9 : result.scores[key] < 0.9);
    report.results.push({ id: item.id, expected: item.expected, ...result, passed: matches });
    console.log((matches ? 'PASS ' : 'FAIL ') + item.id + ' ' + JSON.stringify(result));
    if (['auth', 'rate-limited'].includes(result.error)) break;
  }
  const times = report.results.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, b) => a - b);
  report.summary = { requested: report.results.length, planned: cases.length,
    passed: report.results.filter((r) => r.passed).length,
    failed: report.results.filter((r) => !r.passed).length,
    unrun: cases.length - report.results.length,
    p50Ms: times[Math.ceil(times.length * 0.5) - 1] ?? null,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? null };
  report.status = report.summary.failed || report.summary.unrun ? 'failed-or-incomplete' : 'passed';
  writeFileSync('reports/youtube-probe-jev.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

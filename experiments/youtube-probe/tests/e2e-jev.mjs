import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const provider = process.env.ANYFILTER_PROBE_PROVIDER || 'typesafe';
if (!['typesafe', 'vercel'].includes(provider)) throw new Error('Unsupported provider');
const key = provider === 'typesafe' ? process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY : process.env.AI_GATEWAY_API_KEY;
if (!key) { console.error('A real provider API key is required. No tests were run.'); process.exit(2); }
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const fixture = readFileSync(new URL('./youtube.html', import.meta.url), 'utf8')
  .replace('Controlled fixture, all provider requests mocked', 'Controlled player fixture, real Jev API');
const profile = mkdtempSync(path.join(tmpdir(), 'anyfilter-real-jev-'));
const checks = []; let providerCalls = 0; let completed = false; let playbackTiming;
const report = { at: new Date().toISOString(), provider, mediaFormat: 'H.264/AAC MP4 generated with ffmpeg',
  evidence: 'Real extension and real Jev API; synthetic YouTube DOM and native media fixture. NOT live YouTube advertisements.', checks };
const clips = new Map();
function videoClip(seconds) {
  if (!clips.has(seconds)) {
    const file = path.join(profile, 'fixture-' + seconds + '.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', file], { timeout: 15000, stdio: 'pipe' });
    clips.set(seconds, readFileSync(file));
  }
  return clips.get(seconds);
}
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
  ...(process.env.ANYFILTER_CHROMIUM ? { executablePath: process.env.ANYFILTER_CHROMIUM } : {}),
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const check = (label, ok) => { checks.push({ label, passed: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + label); assert(ok, label); };
try {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.youtube.com') {
      if (url.pathname.startsWith('/fixture-') && url.pathname.endsWith('.wav')) return route.fulfill({ contentType: 'video/mp4',
        body: videoClip(url.pathname.includes('fixture-ad') ? Math.min(30, Number(url.searchParams.get('seconds')) || 2) : 12), headers: { 'Accept-Ranges': 'bytes' } });
      return route.fulfill({ contentType: 'text/html', body: fixture });
    }
    const endpoint = provider === 'typesafe' ? 'https://api.typesafe.ai/v1/systemone' : 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
    if (url.href === endpoint) { providerCalls += 1; return route.continue(); }
    if (url.protocol === 'chrome-extension:') return route.continue();
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto('chrome-extension://' + id + '/options.html');
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 1500 });
  await page.goto('https://www.youtube.com/watch?v=real-jev-controlled-player');
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const baseline = await page.evaluate(() => fixture.measurePlayback('Buy Example Shoes', 8));
  check('disabled extension does not call Jev during the baseline', providerCalls === 0);
  await options.locator('#provider').selectOption(provider);
  await options.locator('#key').fill(key);
  await options.locator('#activate').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('Filtro activado'), null, { timeout: 12000 });
  check('extension validates the real API key and activates through its UI', await options.locator('#status').textContent().then((t) => t.includes('Jev conectado')));
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('#sponsored').classList.contains('anyfilter-youtube-probe-hidden'));
  check('real Jev verdict hides the synthetic sponsored card', await page.locator('#sponsored').isHidden());
  await page.waitForFunction(() => document.querySelector('#crypto').classList.contains('anyfilter-youtube-probe-hidden'));
  check('real Jev verdict hides a crypto promotion without a platform ad badge', await page.locator('#crypto').isHidden());
  check('ordinary video discussing advertising remains visible', await page.locator('#organic').isVisible());
  await page.evaluate(() => fixture.startAd('skip', 'Buy Example Shoes'));
  await page.waitForFunction(() => fixture.clicks === 1 && fixture.source === 'content');
  check('real Jev verdict triggers the fixture skip button', await page.evaluate(() => fixture.clicks === 1));
  await page.waitForFunction(() => document.querySelector('video').readyState >= 3 && document.querySelector('video').currentTime === 3);
  const accelerated = await page.evaluate(() => Promise.race([
    fixture.measurePlayback('Buy Example Shoes — 50% off', 8),
    new Promise((_, reject) => setTimeout(() => {
      const v = document.querySelector('video');
      reject(new Error('Controlled media timed out: ' + JSON.stringify({ hidden: document.hidden,
        paused: v.paused, ended: v.ended, readyState: v.readyState, currentTime: v.currentTime, duration: v.duration, rate: v.playbackRate,
        buffered: Array.from({length:v.buffered.length}, (_, i) => [v.buffered.start(i), v.buffered.end(i)]), error: v.error?.code })));
    }, 15000)),
  ]));
  playbackTiming = { baseline, accelerated, wallSpeedup: Number((baseline.wallMs / accelerated.wallMs).toFixed(2)) };
  check('real Jev verdict reaches native 16x playback', accelerated.rates.includes(16));
  check('controlled ad finishes in less than half the baseline time including real Jev latency', accelerated.wallMs < baseline.wallMs / 2);
  await page.waitForFunction(() => fixture.source === 'content' && document.querySelector('video').currentTime === 3);
  check('main content resumes at its original speed, position and volume', await page.evaluate(() => {
    const video = document.querySelector('video'); return video.playbackRate === 1.25 && video.currentTime === 3 && video.volume === 0.37;
  }));
  report.observed = await worker.evaluate(async () => (await chrome.storage.session.get('events')).events ?? []);
  check('reports contain no API key', !JSON.stringify(report).includes(key));
  check('all provider calls were real and no evaluation errors occurred', providerCalls >= 6 && !report.observed.some((e) => e.outcome === 'evaluation-error'));
  console.log('CONTROLLED MEDIA, REAL JEV ' + JSON.stringify(playbackTiming));
  completed = true;
} finally {
  if (!report.observed) {
    const worker = context.serviceWorkers()[0];
    report.observed = worker ? await worker.evaluate(async () => (await chrome.storage.session.get('events')).events ?? []).catch(() => []) : [];
  }
  report.status = completed ? 'passed' : 'failed-or-incomplete'; report.providerCalls = providerCalls; report.playbackTiming = playbackTiming;
  mkdirSync('reports', { recursive: true }); writeFileSync('reports/youtube-probe-real-jev-e2e.json', JSON.stringify(report, null, 2));
  await context.close(); rmSync(profile, { recursive: true, force: true });
}

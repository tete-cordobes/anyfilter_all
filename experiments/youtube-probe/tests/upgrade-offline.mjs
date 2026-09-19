import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const current = fileURLToPath(new URL('../extension/', import.meta.url));
const legacyCommit = '0b97b53';
const targetVersion = JSON.parse(readFileSync(path.join(current, 'manifest.json'))).version;
const temporary = mkdtempSync(path.join(tmpdir(), 'anyfilter-yt-upgrade-'));
const extension = path.join(temporary, 'extension');
mkdirSync(extension);
const names = readdirSync(current);
for (const name of names) writeFileSync(path.join(extension, name), execFileSync('git',
  ['show', `${legacyCommit}:experiments/youtube-probe/extension/${name}`], { cwd: repository }));
const checks = []; const exceptions = []; const pageErrors = [];
let phase = 'legacy'; let completed = false; let providerCalls = 0;
const check = (label, condition) => {
  checks.push({ label, passed: !!condition });
  console.log((condition ? 'PASS ' : 'FAIL ') + label); assert(condition, label);
};
const until = async (fn) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for upgrade state');
};
const context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
  headless: true, channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'],
  ...(process.env.ANYFILTER_CHROMIUM ? { executablePath: process.env.ANYFILTER_CHROMIUM } : {}),
  args: ['--enable-unsafe-extension-debugging'],
});
try {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('https://www.youtube.com/')) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head></head><body>
      <ytd-video-renderer id="ad" style="display:block"><h3><a href="/watch?v=fixture">Fixture advertising</a></h3><span class="badge-style-type-ad">Sponsored</span></ytd-video-renderer>
      <ytd-video-renderer id="normal" style="display:block"><h3>Ordinary lecture</h3></ytd-video-renderer></body></html>` });
    if (url.startsWith('https://api.typesafe.ai/')) {
      providerCalls += 1;
      const score = route.request().postDataJSON().state.visibleAdvertisingLabel ? 0.99 : 0.01;
      return route.fulfill({ json: { answers: { advertisement: { noul: score }, filter: { noul: score } } } });
    }
    if (url.startsWith('chrome-extension://')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push({ phase, message: error.message }));
  const pageCdp = await context.newCDPSession(page);
  pageCdp.on('Runtime.exceptionThrown', ({ exceptionDetails: detail }) => {
    exceptions.push({ phase, text: detail.text, description: detail.exception?.description,
      lineNumber: detail.lineNumber, frames: detail.stackTrace?.callFrames.map(({ functionName, url, lineNumber }) => ({ functionName, url, lineNumber })) });
  });
  await pageCdp.send('Runtime.enable');
  await page.goto('https://www.youtube.com/watch?v=upgrade-fixture');
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { id } = await browserCdp.send('Extensions.loadUnpacked', { path: extension });
  await until(() => context.pages().some((p) => p.url() === `chrome-extension://${id}/options.html`));
  let options = context.pages().find((p) => p.url() === `chrome-extension://${id}/options.html`);
  await options.locator('#key').fill('offline-upgrade-placeholder-not-a-real-key');
  await options.locator('#activate').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('Filtro activado'));
  await page.waitForFunction(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden'));
  check('the actual 0.1.1 package is active before upgrading', await options.evaluate(() => chrome.runtime.getManifest().version === '0.1.1'));
  let [worker] = context.serviceWorkers();
  await options.close();
  for (const name of names) writeFileSync(path.join(extension, name), readFileSync(path.join(current, name)));
  phase = 'upgraded-before-page-reload';
  await browserCdp.send('Extensions.loadUnpacked', { path: extension });
  await until(() => context.serviceWorkers().some((w) => w !== worker));
  worker = context.serviceWorkers().find((w) => w !== worker);
  await until(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    try { return (await chrome.tabs.sendMessage(tab.id, { type: 'probe-ping' })).ok; } catch { return false; }
  }));
  await page.evaluate(() => { document.querySelector('#ad a').textContent = 'Different ad after the package changed'; });
  await page.waitForTimeout(700);
  const historical = exceptions.filter((e) => e.phase === phase && e.description?.includes('Extension context invalidated'));
  check('the old 0.1.1 script reproduces an invalidated-context exception after update', historical.length > 0);
  check('the old error stack points to the former report call', historical.some((e) => e.frames?.some((f) => f.url.endsWith('/content.js') && f.lineNumber === 15)));
  phase = 'after-page-reload';
  await page.reload();
  // From this document onward no old extension world should remain.
  await page.waitForFunction(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden'));
  await page.evaluate(() => { document.querySelector('#ad a').textContent = 'New ad in a fresh page'; });
  await page.waitForTimeout(700);
  check('a page reload leaves new filtering active and ordinary content visible',
    await page.evaluate(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden')) && await page.locator('#normal').isVisible());
  options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#health-youtube').textContent.includes('1/1'));
  check('the refreshed tab reports the installed version and saved settings survive', await options.evaluate(async (version) => {
    const health = await chrome.runtime.sendMessage({ type: 'probe-diagnostics' });
    const { settings } = await chrome.storage.local.get('settings');
    return health.tabs.every((tab) => tab.connected && tab.version === version) && settings.enabled &&
      settings.apiKey === 'offline-upgrade-placeholder-not-a-real-key';
  }, targetVersion));
  check('fresh page has no isolated-world exceptions or page errors',
    !exceptions.some((e) => e.phase === phase) && !pageErrors.some((e) => e.phase === phase));

  phase = 'current-version-reload';
  await options.close();
  await browserCdp.send('Extensions.loadUnpacked', { path: extension });
  await until(() => context.serviceWorkers().some((w) => w !== worker));
  worker = context.serviceWorkers().find((w) => w !== worker);
  await until(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    try { return (await chrome.tabs.sendMessage(tab.id, { type: 'probe-ping' })).ok; } catch { return false; }
  }));
  await page.evaluate(() => { document.querySelector('#ad a').textContent = 'Ad after reloading current version'; });
  await page.waitForTimeout(700);
  check('reloading only the current version reconnects without new context exceptions',
    !exceptions.some((e) => e.phase === phase) && !pageErrors.some((e) => e.phase === phase));
  check('current-version reload preserves filtering', await page.evaluate(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden')));
  completed = true;
} finally {
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/youtube-probe-upgrade.json', JSON.stringify({ at: new Date().toISOString(),
    evidence: 'OFFLINE: actual 0.1.1-to-current package upgrade; isolated-world exceptions captured by CDP; synthetic YouTube and mocked Jev.',
    legacyCommit, targetVersion, status: completed ? 'passed' : 'failed-or-incomplete', checks, exceptions, pageErrors, providerCalls }, null, 2));
  await context.close();
  rmSync(temporary, { recursive: true, force: true });
}

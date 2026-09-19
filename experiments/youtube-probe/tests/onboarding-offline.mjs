import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = mkdtempSync(path.join(tmpdir(), 'anyfilter-yt-onboarding-'));
const checks = []; const errors = []; const calls = [];
let failure = 401; let completed = false;
const key = 'offline-onboarding-key-not-real';
const context = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  ...(process.env.ANYFILTER_CHROMIUM ? { executablePath: process.env.ANYFILTER_CHROMIUM } : {}),
  args: ['--enable-unsafe-extension-debugging'],
});
const check = (label, condition) => { checks.push({ label, passed: !!condition }); console.log((condition ? 'PASS ' : 'FAIL ') + label); assert(condition, label); };
const until = async (fn) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for onboarding state');
};
try {
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('https://www.youtube.com/')) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Offline onboarding fixture</title></head><body>
      <ytd-video-renderer id="ad" style="display:block"><h3><a href="/watch?v=ad">Buy Example Shoes</a></h3><span class="badge-style-type-ad">Sponsored</span></ytd-video-renderer>
      <ytd-video-renderer id="ordinary" style="display:block"><h3><a href="/watch?v=normal">Calculus lecture</a></h3></ytd-video-renderer>
      </body></html>` });
    if (/^https:\/\/(api.typesafe.ai|ai-gateway.vercel.sh)\//.test(url)) {
      const body = route.request().postDataJSON(); calls.push(body);
      if (failure) return route.fulfill({ status: failure, body: 'do not expose provider response body' });
      const ad = !!body.state.visibleAdvertisingLabel;
      const field = url.includes('typesafe') ? 'noul' : 'probability';
      return route.fulfill({ json: { answers: { advertisement: { [field]: ad ? 0.99 : 0.01 }, filter: { [field]: ad ? 0.99 : 0.01 } } } });
    }
    if (url.startsWith('chrome-extension://')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/');
  await page.evaluate(() => { window.navigationToken = 'preserve-existing-page'; });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  await until(() => context.pages().some((p) => p.url() === 'chrome-extension://' + id + '/options.html'));
  let options = context.pages().find((p) => p.url() === 'chrome-extension://' + id + '/options.html');
  await options.waitForFunction(() => document.querySelector('#health-state')?.textContent.includes('Sin configurar'));
  check('installation automatically opens the Jev configuration screen', !!options);
  await options.waitForFunction(() => document.querySelector('#health-youtube').textContent.includes('0/1'));
  check('a YouTube page opened before installation is reported disconnected', (await options.locator('#health-youtube').textContent()).includes('0/1'));
  await options.locator('#activate').click();
  check('missing key is visible and makes no API request', (await options.locator('#status').textContent()).includes('Falta la API key') && calls.length === 0);
  await options.locator('#key').fill(key);
  await options.locator('#activate').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('HTTP 401'));
  check('rejected key shows a readable authentication error', (await options.locator('#status').textContent()).includes('rechazado la clave'));
  check('failed activation does not persist or activate the draft', await options.evaluate(async () => !(await chrome.storage.local.get('settings')).settings?.enabled));
  check('provider response bodies are not shown to the user', !(await options.locator('body').textContent()).includes('do not expose provider response body'));
  failure = 429;
  await options.locator('#activate').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('HTTP 429'));
  check('quota or rate limit is displayed instead of pretending activation worked', (await options.locator('#status').textContent()).includes('limitado'));
  failure = 0;
  await options.locator('#test').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('no activa el filtro'));
  check('connection-only test does not save or activate settings', await options.evaluate(async () => !(await chrome.storage.local.get('settings')).settings));
  await options.locator('#activate').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('Filtro activado'));
  await page.waitForFunction(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden'));
  check('one activation connects Jev, enables action mode and 16x', await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return settings.enabled && settings.mode === 'act' && settings.accelerateAds && settings.filterCards && settings.skipAds;
  }));
  check('existing YouTube tab starts filtering without navigation or reload', await page.evaluate(() => window.navigationToken === 'preserve-existing-page'));
  check('ordinary content remains visible', await page.locator('#ordinary').isVisible());
  await options.locator('#refresh').click();
  await options.waitForFunction(() => document.querySelector('#health-youtube').textContent.includes('1/1'));
  check('options show a connected YouTube tab and active 16x', (await options.locator('#health-state').textContent()).includes('16×: sí'));
  const before = calls.length;
  await options.locator('#connect').click();
  await options.locator('#connect').click();
  await page.waitForTimeout(400);
  check('reconnecting an existing page does not duplicate evaluations', calls.length === before);
  let [worker] = context.serviceWorkers();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  await worker.evaluate(async (tabId) => { await chrome.scripting.executeScript({ target: { tabId }, files: ['loader.js'] }); }, tabId);
  await page.waitForTimeout(300);
  check('reinjecting the loader cannot create duplicate filters', calls.length === before);
  const denied = await worker.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    let storageDenied = false;
    try { await chrome.storage.local.get('settings'); } catch { storageDenied = true; }
    return { storageDenied, publicConfig: await chrome.runtime.sendMessage({ type: 'probe-config' }),
      probe: await chrome.runtime.sendMessage({ type: 'probe-test-connection', settings: { apiKey: 'forged' } }),
      diagnostics: await chrome.runtime.sendMessage({ type: 'probe-diagnostics' }) };
  } }))[0].result, tabId);
  check('page content cannot read credentials or call privileged diagnostics', denied.storageDenied && !('apiKey' in denied.publicConfig) && !denied.probe.ok && !denied.diagnostics.ok);
  await options.close();
  await cdp.send('Extensions.loadUnpacked', { path: extension });
  await until(() => context.serviceWorkers().some((w) => w !== worker));
  worker = context.serviceWorkers().find((w) => w !== worker);
  await until(() => worker.evaluate(async () => {
    try {
      const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      return (await chrome.tabs.sendMessage(tab.id, { type: 'probe-ping' })).ok;
    } catch { return false; }
  }));
  check('reloading an enabled extension reconnects the existing tab without options, manual connect or navigation', await page.evaluate(() => window.navigationToken === 'preserve-existing-page'));
  await page.waitForTimeout(500);
  check('reload leaves one active content script and preserves filtering', await page.evaluate(() =>
    document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden') &&
    [...document.querySelectorAll('style')].filter((style) => style.textContent.includes('anyfilter-youtube-probe-hidden')).length === 1));
  await page.evaluate(() => {
    document.querySelector('#ad a').textContent = 'New advertising creative after extension reload';
    document.querySelector('#ad').classList.remove('anyfilter-youtube-probe-hidden');
  });
  await page.waitForFunction(() => document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden'));
  check('the reconnected tab evaluates and filters new content', calls.some((call) => call.state.title === 'New advertising creative after extension reload'));
  options = await context.newPage();
  await options.goto('chrome-extension://' + id + '/options.html');
  await options.waitForFunction(() => document.querySelector('#health-youtube').textContent.includes('1/1'));
  check('reload preserves the saved key and configuration', await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return settings.apiKey === 'offline-onboarding-key-not-real' && settings.enabled && settings.accelerateAds;
  }));
  check('options and the connected tab identify the loaded version', await options.evaluate(async () => {
    const health = await chrome.runtime.sendMessage({ type: 'probe-diagnostics' });
    const version = chrome.runtime.getManifest().version;
    return document.querySelector('#version').textContent.includes(version) && health.tabs.every((tab) => tab.version === version);
  }));
  await worker.evaluate(() => {
    globalThis.originalSendMessage = chrome.tabs.sendMessage;
    globalThis.originalExecuteScript = chrome.scripting.executeScript;
    chrome.tabs.sendMessage = async () => { throw new Error('Fixture: disconnected tab'); };
    chrome.scripting.executeScript = async () => { throw new Error('Fixture: withheld site access'); };
  });
  await options.locator('#connect').click();
  await options.waitForFunction(() => document.querySelector('#health-state').textContent.includes('Sin conexión'));
  check('enabled settings are not shown as an active filter when YouTube is disconnected', !(await options.locator('#health-state').textContent()).includes('Filtro activo'));
  check('failed injection has an actionable explanation and a redacted diagnostic', await options.evaluate(() =>
    document.querySelector('#health-error').textContent.includes('acceso de AnyFilter') &&
    JSON.parse(document.querySelector('#events').textContent).tabs[0].connectionError === 'injection-failed'));
  await worker.evaluate(() => {
    chrome.tabs.sendMessage = globalThis.originalSendMessage;
    chrome.scripting.executeScript = globalThis.originalExecuteScript;
  });
  await options.locator('#connect').click();
  await options.waitForFunction(() => document.querySelector('#health-state').textContent.includes('Filtro activo'));
  await options.getByText('Ajustes del filtro', { exact: true }).click();
  await options.locator('#mode').selectOption('observe');
  await options.getByRole('button', { name: 'Guardar configuración' }).click();
  await options.waitForFunction(() => document.querySelector('#health-state').textContent.includes('Modo observar'));
  await page.waitForFunction(() => !document.querySelector('#ad').classList.contains('anyfilter-youtube-probe-hidden'));
  check('observation mode clearly explains why nothing is hidden and restores cards', await page.locator('#ad').isVisible());
  await options.locator('#enabled').uncheck();
  await options.getByRole('button', { name: 'Guardar configuración' }).click();
  await options.waitForFunction(() => document.querySelector('#health-state').textContent.includes('Desactivado'));
  check('disabled state is visible on screen and on the extension badge', await worker.evaluate(async () => await chrome.action.getBadgeText({}) === 'OFF'));
  await page.goto('https://www.youtube.com/shorts/offline');
  await options.locator('#refresh').click();
  await options.waitForFunction(() => document.querySelector('#health-youtube').textContent.includes('Shorts'));
  check('unsupported Shorts player is identified instead of shown as working', (await options.locator('#health-youtube').textContent()).includes('no compatibles'));
  const report = await options.locator('#events').textContent();
  check('export includes diagnostics but no key or page text', report.includes('configuration') && !report.includes(key) && !report.includes('Buy Example Shoes'));
  check('no unhandled page errors during installation and activation', errors.length === 0);
  await options.setViewportSize({ width: 1000, height: 1000 });
  mkdirSync('reports', { recursive: true });
  await options.screenshot({ path: 'reports/youtube-probe-onboarding.png', fullPage: true });
  completed = true;
} finally {
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/youtube-probe-onboarding.json', JSON.stringify({ at: new Date().toISOString(),
    evidence: 'OFFLINE: browser installation and real extension UI; synthetic YouTube and mocked Jev.',
    status: completed ? 'passed' : 'failed-or-incomplete', checks, errors, providerCalls: calls.length }, null, 2));
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

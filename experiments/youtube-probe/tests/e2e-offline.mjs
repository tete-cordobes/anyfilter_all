import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const fixture = readFileSync(new URL('./youtube.html', import.meta.url), 'utf8');
const profile = mkdtempSync(path.join(tmpdir(), 'anyfilter-yt-offline-'));
const calls = []; const checks = []; const errors = [];
let delayMs = 0; let providerFailure = 0;
let completed = false;
let playbackTiming = null;
function wav(seconds) {
  const size = 8000 * seconds;
  const bytes = Buffer.alloc(44 + size, 128);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
const context = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium',
  ...(process.env.ANYFILTER_CHROMIUM ? { executablePath: process.env.ANYFILTER_CHROMIUM } : {}),
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
const check = (label, condition) => { checks.push({ label, passed: !!condition }); console.log((condition ? 'PASS ' : 'FAIL ') + label); assert(condition, label); };
try {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/fixture-') && url.includes('.wav')) return route.fulfill({
      contentType: 'audio/wav', body: wav(url.includes('fixture-ad') ? Math.min(30, Number(new URL(url).searchParams.get('seconds')) || 2) : 12), headers: { 'Accept-Ranges': 'bytes' } });
    if (url.startsWith('https://www.youtube.com/')) return route.fulfill({ contentType: 'text/html', body: fixture });
    if (/^https:\/\/(api.typesafe.ai|ai-gateway.vercel.sh)\//.test(url)) {
      const body = route.request().postDataJSON(); calls.push(body);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (providerFailure) return route.fulfill({ status: providerFailure, body: 'fixture error' });
      const state = body.state;
      const ad = state.youtubeSurface === 'player' ? state.playerIsShowingAd && state.adControlsAreVisible : !!state.visibleAdvertisingLabel;
      const filter = !state.title.includes('MODEL_KEEP') && (ad || state.title.includes('CRYPTO'));
      const field = url.includes('typesafe') ? 'noul' : 'probability';
      return route.fulfill({ json: { answers: { advertisement: { [field]: ad ? 0.99 : 0.01 },
        filter: { [field]: filter ? 0.99 : 0.01 } }, usage: { input_tokens: 200, inputTokens: 200 } } });
    }
    if (url.startsWith('chrome-extension://')) return route.continue();
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto('chrome-extension://' + id + '/options.html');
  await options.getByText('Ajustes del filtro', { exact: true }).click();
  await options.locator('#key').fill('offline-fixture-key-not-real');
  await options.locator('#enabled').check();
  await options.getByRole('button', { name: 'Guardar configuración' }).click();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 1500 });
  await page.goto('https://www.youtube.com/watch?v=controlled-fixture');
  const events = async () => worker.evaluate(async () => (await chrome.storage.session.get('events')).events ?? []);
  const waitEvent = async (outcome, after = 0) => {
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      if ((await events()).slice(after).some((event) => event.outcome === outcome)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('No event: ' + outcome);
  };
  const configure = async (changes) => {
    await worker.evaluate(async (changes) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ...changes } });
    }, changes);
    await page.waitForTimeout(300);
  };
  const hidden = (selector) => page.locator(selector).evaluate((node) => node.classList.contains('anyfilter-youtube-probe-hidden'));
  await waitEvent('would-hide');
  check('observe mode keeps cards visible', !(await hidden('#sponsored')));
  check('nested homepage lockup is classified only once', calls.filter((c) => c.state.title.startsWith('SPONSORED')).length === 1);
  check('ordinary video mentioning ads remains visible', !(await hidden('#organic')));
  check('no player classification during normal playback', !calls.some((c) => c.state.youtubeSurface === 'player'));
  await page.evaluate(() => document.querySelector('#movie_player').classList.add('ad-created'));
  await page.waitForTimeout(400);
  check('preloaded ad-created marker does not classify ordinary playback', !calls.some((c) => c.state.youtubeSurface === 'player'));

  await configure({ mode: 'act' }); await waitEvent('hidden');
  await page.waitForFunction(() => document.querySelector('#crypto').classList.contains('anyfilter-youtube-probe-hidden'));
  check('sponsored and semantic-match cards are hidden after model verdict', await hidden('#sponsored') && await hidden('#crypto'));
  check('normal video volume, speed and position preserved', await page.evaluate(() => {
    const v = document.querySelector('video'); return v.volume === 0.37 && v.playbackRate === 1.25 && v.currentTime === 3;
  }));

  await options.getByRole('button', { name: 'Recuperar tarjetas' }).click();
  await page.waitForFunction(() => !document.querySelector('#sponsored').classList.contains('anyfilter-youtube-probe-hidden'));
  await page.waitForTimeout(500);
  check('restored cards stay visible across scans', !(await hidden('#sponsored')));
  await configure({ enabled: false });
  const countWhileOff = calls.length;
  await page.evaluate(() => { document.querySelector('#organic h3').textContent = 'CRYPTO while disabled'; });
  await page.waitForTimeout(600);
  check('disabled experiment makes no evaluations and restores all cards', calls.length === countWhileOff && !(await hidden('#crypto')));

  await page.reload(); await configure({ enabled: true, mode: 'act' });
  await page.waitForFunction(() => document.querySelector('#sponsored').classList.contains('anyfilter-youtube-probe-hidden'));
  await page.evaluate(() => {
    const card = document.querySelector('#sponsored'); card.querySelector('h3 a').textContent = 'Reused node: calculus lecture';
    card.querySelector('h3 a').href = '/watch?v=reused'; card.querySelector('.badge-style-type-ad').remove();
  });
  await page.waitForFunction(() => !document.querySelector('#sponsored').classList.contains('anyfilter-youtube-probe-hidden'));
  check('recycled hidden DOM card does not hide its new video', !(await hidden('#sponsored')));
  await page.evaluate(() => { document.querySelector('#lazy').innerHTML = '<h3><a href="/watch?v=late">CRYPTO late-loaded title</a></h3>'; });
  await page.waitForFunction(() => document.querySelector('#lazy').classList.contains('anyfilter-youtube-probe-hidden'));
  check('lazy metadata is evaluated when it arrives', await hidden('#lazy'));

  delayMs = 800;
  const beforeDelayedCard = calls.length;
  await page.evaluate(() => {
    const node = document.createElement('ytd-video-renderer'); node.id = 'delayed';
    node.innerHTML = '<h3><a href="/watch?v=delayed">CRYPTO delayed</a></h3>'; document.body.append(node);
  });
  const cardDeadline = Date.now() + 5000;
  while (calls.length === beforeDelayedCard && Date.now() < cardDeadline) await page.waitForTimeout(50);
  check('delayed card request started', calls.length > beforeDelayedCard);
  await page.evaluate(() => { history.pushState({}, '', '/shorts/new-page'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await page.waitForTimeout(1000); delayMs = 0;
  check('card response from previous route is discarded', !(await hidden('#delayed')));
  await page.evaluate(() => { history.pushState({}, '', '/watch?v=controlled-fixture'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await page.waitForTimeout(400);

  let offset = (await events()).length;
  await page.evaluate(() => fixture.startAd('skip', 'Skippable ad'));
  await waitEvent('ad-ended-after-attempt', offset);
  check('mock Jev verdict reaches visible skip button and fixture resumes', await page.evaluate(() => fixture.clicks === 1 && fixture.source === 'content'));
  check('invisible decoy skip button is untouched', await page.evaluate(() => fixture.decoyClicks === 0));

  offset = (await events()).length;
  await page.evaluate(() => fixture.startAd('skip', 'MODEL_KEEP allowed by user rule'));
  await waitEvent('evaluated', offset); await page.waitForTimeout(400);
  check('negative Jev filter verdict leaves an actual ad untouched', await page.evaluate(() => fixture.clicks === 1));
  await page.evaluate(() => fixture.endAd()); await page.waitForTimeout(400);

  offset = (await events()).length;
  await page.evaluate(() => { fixture.rejectClick = true; fixture.startAd('skip', 'Reject click ad'); });
  await waitEvent('ad-still-playing-after-attempt', offset);
  check('refused skip is not counted as an ended ad', !(await events()).slice(offset).some((e) => e.outcome === 'ad-ended-after-attempt'));
  check('refused skip is limited to two spaced clicks', await page.evaluate(() => fixture.clicks === 3));
  await page.evaluate(() => { fixture.endAd(); fixture.rejectClick = false; });
  await page.waitForTimeout(400);

  offset = (await events()).length;
  await page.evaluate(() => fixture.startAd('no-skip', 'Unskippable ad'));
  await waitEvent('no-action-available', offset);
  check('no-button ad is detected but not falsely reported removed', await page.evaluate(() => fixture.seeks.length === 0 && fixture.source === 'ad'));
  offset = (await events()).length;
  await configure({ seekAds: true });
  await waitEvent('ad-ended-after-attempt', offset);
  check('opt-in seek experiment reaches end of simulated seekable ad', await page.evaluate(() => fixture.seeks.length === 1 && fixture.seeks[0] === 2));

  offset = (await events()).length;
  await page.evaluate(() => { fixture.rejectSeek = true; fixture.startAd('no-skip', 'Reject seek ad'); });
  await waitEvent('ad-still-playing-after-attempt', offset);
  check('refused experimental seek stays a failure', !(await events()).slice(offset).some((e) => e.outcome === 'ad-ended-after-attempt'));
  await page.evaluate(() => { fixture.endAd(); fixture.rejectSeek = false; }); await page.waitForTimeout(400);

  await configure({ enabled: false, seekAds: false, accelerateAds: false });
  const baseline = await page.evaluate(() => fixture.measurePlayback('Baseline native playback', 8));
  await configure({ enabled: true, accelerateAds: true });
  const accelerated = await page.evaluate(() => fixture.measurePlayback('Accelerated native playback', 8));
  playbackTiming = { evidence: 'Native HTML media clock; synthetic ad; mocked Jev', baseline, accelerated,
    wallSpeedup: Number((baseline.wallMs / accelerated.wallMs).toFixed(2)) };
  console.log('MEDIA TIMING ' + JSON.stringify(playbackTiming));
  check('native browser media actually reaches 16x', accelerated.rates.includes(16));
  check('native media ends in less than half the baseline wall time', accelerated.wallMs < baseline.wallMs / 2);
  await page.waitForTimeout(300);
  check('original 1.25x speed is restored after accelerated ad', await page.evaluate(() => document.querySelector('video').playbackRate === 1.25));

  await page.evaluate(() => fixture.startAd('no-skip', 'Disable during acceleration', 8));
  await page.waitForFunction(() => document.querySelector('video').playbackRate === 16);
  await configure({ enabled: false });
  check('turning off the experiment immediately restores speed', await page.evaluate(() => document.querySelector('video').playbackRate === 1.25));
  await page.evaluate(() => fixture.endAd()); await configure({ enabled: true });

  await page.evaluate(() => fixture.startAd('no-skip', 'User changes speed', 8));
  await page.waitForFunction(() => document.querySelector('video').playbackRate === 16);
  await page.evaluate(() => { document.querySelector('video').playbackRate = 2; });
  await page.waitForTimeout(500);
  check('manual speed change is respected instead of forcing 16x again', await page.evaluate(() => document.querySelector('video').playbackRate === 2));
  await page.evaluate(() => fixture.endAd()); await page.waitForTimeout(400);

  offset = (await events()).length;
  await page.evaluate(() => { fixture.rejectSpeed = true; return fixture.startAd('no-skip', 'Player rejects acceleration', 8); });
  await waitEvent('speed-not-maintained', offset);
  check('player rejection of 16x is recorded and not reported as a removed ad', !(await events()).slice(offset).some((e) => e.outcome === 'ad-ended-after-attempt'));
  await page.evaluate(() => { fixture.rejectSpeed = false; fixture.endAd(); });
  await configure({ accelerateAds: false });

  await configure({ seekAds: false }); delayMs = 900;
  const playerCalls = calls.filter((c) => c.state.youtubeSurface === 'player').length;
  await page.evaluate(() => fixture.startAd('skip', 'Late response ad'));
  const playerDeadline = Date.now() + 5000;
  while (calls.filter((c) => c.state.youtubeSurface === 'player').length === playerCalls && Date.now() < playerDeadline) await page.waitForTimeout(50);
  check('delayed player request started', calls.filter((c) => c.state.youtubeSurface === 'player').length > playerCalls);
  const clicksBefore = await page.evaluate(() => fixture.clicks);
  await page.evaluate(() => fixture.endAd()); await page.waitForTimeout(1300); delayMs = 0;
  check('late Jev verdict cannot skip resumed main content', await page.evaluate(() => fixture.clicks) === clicksBefore);

  providerFailure = 429;
  await configure({ provider: 'vercel' }); offset = (await events()).length;
  await page.evaluate(() => fixture.startAd('skip', 'Rate limited ad'));
  await waitEvent('evaluation-error', offset);
  check('provider rate limit leaves playback untouched', await page.evaluate(() => fixture.clicks) === clicksBefore);
  providerFailure = 0;
  await page.evaluate(() => fixture.endAd());
  await configure({ enabled: false });
  await configure({ enabled: true, provider: 'vercel' });
  offset = (await events()).length;
  await page.evaluate(() => fixture.startAd('skip', 'Vercel contract ad'));
  await waitEvent('ad-ended-after-attempt', offset);
  check('Vercel boolean response contract also drives a simulated skip', await page.evaluate(() => fixture.clicks) === clicksBefore + 1);
  await configure({ accelerateAds: true, seekAds: false });
  for (const kind of ['pointer-events', 'aria-parent', 'countdown', 'fieldset']) {
    const before = await page.evaluate(() => fixture.clicks);
    await page.evaluate(async (kind) => {
      await fixture.startAd('skip', 'Late skip ' + kind, 8);
      const button = document.querySelector('.ytp-skip-ad-button');
      if (kind === 'pointer-events') button.style.pointerEvents = 'none';
      if (kind === 'countdown') { button.setAttribute('aria-label', 'Saltar anuncios'); button.textContent = 'Saltar anuncio en 5 segundos'; }
      if (kind === 'aria-parent' || kind === 'fieldset') {
        const wrapper = document.createElement(kind === 'fieldset' ? 'fieldset' : 'div'); wrapper.id = 'skip-wrapper';
        if (kind === 'fieldset') wrapper.disabled = true; else wrapper.setAttribute('aria-disabled', 'true');
        button.replaceWith(wrapper); wrapper.append(button);
      }
    }, kind);
    await page.waitForFunction(() => document.querySelector('video').playbackRate === 16);
    check(kind + ': wait and accelerate while skip is not ready', await page.evaluate(() => fixture.clicks) === before);
    const health = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'probe-diagnostics' }));
    check(kind + ': skip readiness is visible in diagnostics', health.tabs.some((tab) => tab.skipState === (kind === 'countdown' ? 'countdown' : 'disabled')));
    await page.evaluate(() => {
      const button = document.querySelector('.ytp-skip-ad-button');
      button.style.pointerEvents = ''; button.textContent = 'Saltar anuncios'; button.removeAttribute('aria-label');
      document.querySelector('#skip-wrapper')?.replaceWith(button);
    });
    await page.waitForFunction((before) => fixture.clicks === before + 1 && fixture.source === 'content', before);
    check(kind + ': late skip is clicked after 16x using the same Jev verdict', calls.filter((c) => c.state.title === 'Late skip ' + kind).length === 1);
    await page.waitForFunction(() => document.querySelector('video').playbackRate === 1.25);
  }

  await page.evaluate(() => {
    fixture.otherClicks = 0;
    const outside = document.createElement('button'); outside.id = 'outside-skip'; outside.textContent = 'Saltar anuncios';
    outside.onclick = () => { fixture.otherClicks += 1; }; document.body.append(outside);
    const advertiser = document.createElement('button'); advertiser.textContent = 'Visitar anunciante';
    advertiser.onclick = () => { fixture.otherClicks += 1; }; document.querySelector('#movie_player').append(advertiser);
  });
  for (const label of ['Omitir anuncios', 'Skip ad']) {
    const before = await page.evaluate(() => fixture.clicks);
    await page.evaluate(async (label) => {
      await fixture.startAd('no-skip', 'Accessible late skip ' + label, 8);
    }, label);
    await page.waitForFunction(() => document.querySelector('video').playbackRate === 16);
    await page.evaluate((label) => {
      const button = document.createElement('button'); button.id = 'semantic-skip'; button.className = 'new-player-button';
      button.setAttribute('aria-label', label); button.textContent = '›';
      button.onclick = () => { fixture.clicks += 1; fixture.endAd(); };
      document.querySelector('#movie_player').append(button);
    }, label);
    await page.waitForFunction((before) => fixture.clicks === before + 1 && fixture.source === 'content', before);
    check(label + ': skip button is found by its accessible name when CSS classes differ', await page.evaluate(() => fixture.otherClicks === 0));
    await page.evaluate(() => document.querySelector('#semantic-skip').remove());
    await page.waitForFunction(() => document.querySelector('video').playbackRate === 1.25);
  }

  const beforeRetry = await page.evaluate(() => fixture.clicks);
  await page.evaluate(async () => { fixture.rejectClick = true; await fixture.startAd('skip', 'Skip listener becomes ready', 8); });
  await page.waitForFunction((before) => fixture.clicks === before + 1, beforeRetry);
  await page.evaluate(() => { fixture.rejectClick = false; });
  await page.waitForFunction((before) => fixture.clicks === before + 2 && fixture.source === 'content', beforeRetry);
  check('one delayed retry recovers when the first visible skip click is ignored', await page.evaluate(() => fixture.clicks) === beforeRetry + 2);

  const beforeUnknownLayout = calls.filter((call) => call.state.youtubeSurface === 'player').length;
  await page.bringToFront();
  await page.evaluate(async () => {
    await fixture.startAd('no-skip', 'PRIVATE_TITLE_MUST_NOT_BE_EXPORTED', 8);
    document.querySelector('#movie_player').classList.remove('ad-showing');
    const overlay = document.createElement('div'); overlay.id = 'unknown-ad-ui'; overlay.className = 'ytp-ad-player-overlay-v2';
    overlay.setAttribute('data-private', 'PRIVATE_ATTRIBUTE_MUST_NOT_BE_EXPORTED');
    overlay.innerHTML = '<span class="ytp-ad-label-v2">Patrocinado</span><a href="https://private.invalid/SECRET_URL">PRIVATE_BODY_MUST_NOT_BE_EXPORTED</a>';
    document.querySelector('#movie_player').append(overlay);
  });
  await options.waitForFunction(async () => {
    const health = await chrome.runtime.sendMessage({ type: 'probe-diagnostics' });
    return health.tabs[0]?.playerSamples?.length === 3 && health.tabs[0].playerSamples.every((sample) =>
      sample.signals.some((signal) => signal.label === 'advertising' && signal.classes.includes('ytp-ad-label-v2')));
  });
  const unknownHealth = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'probe-diagnostics' }));
  const unknown = unknownHealth.tabs[0];
  check('diagnostics expose a visible advertising label even when the current detector misses its layout', !unknown.adShowing && !unknown.adUiVisible &&
    unknown.playerDiagnostics.signals.some((signal) => signal.visible && signal.label === 'advertising' && !signal.knownAdUi));
  check('diagnostic observations alone never accelerate or classify an unrecognized player', calls.filter((call) => call.state.youtubeSurface === 'player').length === beforeUnknownLayout &&
    await page.evaluate(() => document.querySelector('video').playbackRate === 1.25));
  check('the export identifies selected media and its actual playback state', unknown.playerDiagnostics.videos.some((video) => video.selected && video.playbackRate === 1.25));
  await options.bringToFront();
  // Headless Chromium keeps both tabs "visible" even after bringToFront().
  // Simulate the standard visibility signal in the extension's isolated world.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    } });
  });
  const samplesBeforeLeaving = JSON.stringify((await options.evaluate(() => chrome.runtime.sendMessage({ type: 'probe-diagnostics' }))).tabs[0].playerSamples);
  await page.waitForTimeout(1200);
  const afterLeaving = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'probe-diagnostics' }));
  check('three visible-tab samples survive a simulated tab hide', JSON.stringify(afterLeaving.tabs[0].playerSamples) === samplesBeforeLeaving &&
    !afterLeaving.tabs[0].playerDiagnostics.documentVisible &&
    afterLeaving.tabs[0].playerSamples.every((sample) => sample.documentVisible));
  const serializedHealth = JSON.stringify(afterLeaving);
  check('player diagnostics omit page text, arbitrary attributes, media URLs and credentials',
    !serializedHealth.includes('PRIVATE_') && !serializedHealth.includes('private.invalid') && !serializedHealth.includes('fixture-ad.wav') &&
    !serializedHealth.includes('offline-fixture-key-not-real'));
  check('player diagnostic arrays are bounded', afterLeaving.tabs[0].playerSamples.length <= 3 &&
    afterLeaving.tabs[0].playerDiagnostics.signals.length <= 40 && afterLeaving.tabs[0].playerDiagnostics.videos.length <= 6);
  await page.evaluate(() => { document.querySelector('#unknown-ad-ui').remove(); fixture.endAd(); });
  await configure({ enabled: false });
  check('exportable events contain no key or page text', !JSON.stringify(await events()).includes('offline-fixture-key-not-real') && !JSON.stringify(await events()).includes('Buy Example Shoes'));
  check('no uncaught content errors', errors.length === 0);
  check('player speed and volume preserved after all actions', await page.evaluate(() => {
    const v = document.querySelector('video'); return v.volume === 0.37 && v.playbackRate === 1.25;
  }));
  await options.setViewportSize({ width: 1000, height: 900 });
  mkdirSync('reports', { recursive: true });
  await options.screenshot({ path: 'reports/youtube-probe-options.png', fullPage: true });
  completed = true;
} finally {
  mkdirSync('reports', { recursive: true });
  const activeWorker = context.serviceWorkers()[0];
  const observed = activeWorker ? await activeWorker.evaluate(async () =>
    (await chrome.storage.session.get('events')).events ?? []).catch(() => []) : [];
  if (!completed) console.error('Last observations:', JSON.stringify(observed.slice(-8)));
  writeFileSync('reports/youtube-probe-offline.json', JSON.stringify({ at: new Date().toISOString(),
    evidence: 'OFFLINE: synthetic YouTube DOM/player, mocked Jev. No live YouTube or real model accuracy claim.',
    status: completed ? 'passed' : 'failed-or-incomplete', checks, errors, providerCalls: calls.length, playbackTiming, observed }, null, 2));
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

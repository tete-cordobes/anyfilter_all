import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, playerAction, settingsFrom, validScores } from '../extension/shared.js';
import { evaluate, buildRequest } from '../extension/provider.js';
import { AdController } from '../extension/controller.js';

const settings = { ...DEFAULTS, enabled: true, mode: 'act' };
const yes = { ok: true, scores: { advertisement: 0.99, filter: 0.99 }, latencyMs: 123 };
const snapshot = () => ({ state: { surface: 'player', adShowing: true, adUiVisible: true },
  identity: 'ad-one', pageUrl: '/watch?v=one', player: {}, media: {}, skipAvailable: true,
  mediaSource: 'blob:ad-one', duration: 30, seekable: true, playbackRate: 1.25, mediaTime: 0 });

test('high model probability never permits acting on ordinary playback or hidden ad UI', () => {
  for (const state of [{ surface: 'player', adShowing: false, adUiVisible: true },
    { surface: 'player', adShowing: true, adUiVisible: false },
    { surface: 'card', adShowing: true, adUiVisible: true }])
    assert.equal(playerAction({ ...snapshot(), state }, yes, settings), 'none');
});

test('API failure, incomplete/invalid probabilities and low confidence never trigger playback actions', () => {
  for (const result of [{ ok: false, error: 'rate-limited' }, { ok: true, scores: {} },
    { ok: true, scores: { advertisement: 1.1, filter: 1 } },
    { ok: true, scores: { advertisement: 1, filter: NaN } },
    { ok: true, scores: { advertisement: 0.6, filter: 1 } },
    { ok: true, scores: { advertisement: 1, filter: 0.6 } }])
    assert.equal(playerAction(snapshot(), result, settings), 'none');
  assert.equal(validScores({ advertisement: '0.99', filter: 1 }), false);
});

test('disabled controls and observe mode never apply an action', () => {
  assert.equal(playerAction(snapshot(), yes, { ...settings, enabled: false }), 'none');
  assert.equal(playerAction(snapshot(), yes, { ...settings, skipAds: false }), 'none');
  assert.equal(playerAction(snapshot(), yes, { ...settings, mode: 'observe' }), 'observe');
});

test('non-skippable ad is unsupported unless guarded seek experiment is enabled', () => {
  const ad = { ...snapshot(), skipAvailable: false };
  assert.equal(playerAction(ad, yes, settings), 'no-action-available');
  assert.equal(playerAction(ad, yes, { ...settings, seekAds: true }), 'seek-end');
  for (const change of [{ duration: NaN }, { duration: Infinity }, { duration: 0 }, { duration: 181 },
    { mediaSource: '' }, { seekable: false }])
    assert.equal(playerAction({ ...ad, ...change }, yes, { ...settings, seekAds: true }), 'no-action-available');
});

test('a visible skip control takes precedence over experimental seeking', () => {
  assert.equal(playerAction(snapshot(), yes, { ...settings, seekAds: true }), 'click-skip');
});

test('16x is opt-in, prefers a real skip button and needs a finite ad segment', () => {
  const ad = { ...snapshot(), skipAvailable: false };
  assert.equal(playerAction(ad, yes, { ...settings, accelerateAds: true }), 'speed-16x');
  assert.equal(playerAction(snapshot(), yes, { ...settings, accelerateAds: true }), 'click-skip');
  assert.equal(playerAction({ ...ad, duration: Infinity }, yes, { ...settings, accelerateAds: true }), 'no-action-available');
  assert.equal(playerAction(ad, yes, { ...settings, mode: 'observe', accelerateAds: true }), 'observe');
});

test('settings reject unsafe thresholds and invalid activation values', () => {
  assert.deepEqual(settingsFrom(null), DEFAULTS);
  assert.equal(settingsFrom({ threshold: 0.01 }).threshold, 0.9);
  assert.equal(settingsFrom({ enabled: 'true', seekAds: 'true' }).enabled, false);
  assert.equal(settingsFrom({ enabled: 'true', seekAds: 'true' }).seekAds, false);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(classify = async () => yes) {
  let live = snapshot(); let time = 0;
  const actions = []; const reports = [];
  const controller = new AdController({ read: () => live, classify,
    execute: (action) => { actions.push(action); return true; },
    report: (event) => reports.push(event), now: () => time });
  return { controller, actions, reports, get live() { return live; },
    set live(value) { live = value; }, set time(value) { time = value; } };
}

test('response arriving after ad ended cannot skip the main video', async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  h.controller.tick(settings); await flush();
  h.live = { ...h.live, state: { ...h.live.state, adShowing: false } };
  resolve(yes); await flush(); h.controller.tick(settings);
  assert.deepEqual(h.actions, []);
});

test('response for previous ad cannot affect replacement media or navigation', async () => {
  for (const change of [(s) => ({ ...s, identity: 'next-video' }), (s) => ({ ...s, media: {} }),
    (s) => ({ ...s, player: {} })]) {
    let resolve;
    const h = harness(() => new Promise((r) => { resolve = r; }));
    h.controller.tick(settings); await flush();
    h.live = change(h.live); resolve(yes); await flush();
    assert.deepEqual(h.actions, []);
    assert.equal(h.controller.episode, null);
  }
});

test('disabling while waiting invalidates the pending decision', async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  h.controller.tick(settings); await flush();
  h.controller.tick({ ...settings, enabled: false }); resolve(yes); await flush();
  assert.deepEqual(h.actions, []);
});

test('an initially unavailable skip button is used when it appears', async () => {
  const h = harness(); h.live.skipAvailable = false;
  h.controller.tick(settings); await flush(); h.controller.tick(settings);
  assert(h.reports.some((r) => r.outcome === 'no-action-available'));
  h.live.skipAvailable = true; h.controller.tick(settings);
  assert.deepEqual(h.actions, ['click-skip']);
});

test('refused clicks are attempted once and never reported as successful skips', async () => {
  const h = harness(); h.controller.tick(settings); await flush();
  h.controller.tick(settings); h.time = 3000;
  for (let i = 0; i < 10; i += 1) h.controller.tick(settings);
  assert.deepEqual(h.actions, ['click-skip']);
  assert.equal(h.reports.filter((r) => r.outcome === 'ad-still-playing-after-attempt').length, 1);
  assert(!h.reports.some((r) => r.outcome === 'ad-ended-after-attempt'));
});

test('ad transition is reported separately from the attempted action', async () => {
  const h = harness(); h.controller.tick(settings); await flush(); h.controller.tick(settings);
  h.live = { ...h.live, state: { ...h.live.state, adShowing: false } };
  h.controller.tick(settings);
  assert(h.reports.some((r) => r.outcome === 'action-attempted'));
  assert(h.reports.some((r) => r.outcome === 'ad-ended-after-attempt'));
  assert(!h.reports.some((r) => /blocked|success/.test(r.outcome)));
});

test('leaving a page during an attempt is not counted as an ad ending', async () => {
  const h = harness(); h.controller.tick(settings); await flush(); h.controller.tick(settings);
  h.live = null; h.controller.tick(settings);
  assert(h.reports.some((r) => r.outcome === 'episode-abandoned'));
  assert(!h.reports.some((r) => r.outcome === 'ad-ended-after-attempt'));
});

test('transport rejection is handled and leaves the player intact', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  h.controller.tick(settings); await flush(); h.controller.tick(settings);
  assert.deepEqual(h.actions, []);
  assert(h.reports.some((r) => r.error === 'transport'));
});

test('16x cleanup runs on disabling, navigation and replacing the ad', async () => {
  for (const exit of ['disable', 'navigate', 'replace']) {
    let restored = 0;
    const h = harness(); h.live.skipAvailable = false;
    h.controller.execute = () => ({ restore: () => { restored += 1; } });
    const enabled = { ...settings, accelerateAds: true };
    h.controller.tick(enabled); await flush(); h.controller.tick(enabled);
    if (exit === 'disable') h.controller.tick({ ...enabled, enabled: false });
    if (exit === 'navigate') { h.live = null; h.controller.tick(enabled); }
    if (exit === 'replace') { h.live = { ...h.live, identity: 'next-ad' }; h.controller.tick(enabled); }
    assert.equal(restored, 1, exit);
  }
});

test('both provider adapters send structured evidence and parse real response contracts', async () => {
  for (const provider of ['typesafe', 'vercel']) {
    const request = buildRequest(provider, 'not-a-real-key', { surface: 'player' }, 'Hide ads');
    assert.equal(request.body.state.surface, 'player');
    const field = provider === 'vercel' ? 'probability' : 'noul';
    const result = await evaluate({ ...settings, apiKey: 'not-a-real-key', provider }, {}, async () =>
      new Response(JSON.stringify({ answers: { advertisement: { [field]: 0.99 }, filter: { [field]: 0.95 } } })));
    assert.equal(result.ok, true); assert.equal(result.scores.filter, 0.95);
  }
});

test('provider errors and malformed JSON/scores fail closed without leaking response bodies', async () => {
  for (const [response, error] of [
    [new Response('secret debug material', { status: 401 }), 'auth'],
    [new Response('secret debug material', { status: 500 }), 'provider-http'],
    [new Response(JSON.stringify({ answers: {} })), 'invalid-scores'],
    [new Response('not-json'), 'invalid-json'],
  ]) {
    const result = await evaluate({ ...settings, apiKey: 'not-a-real-key' }, {}, async () => response);
    assert.equal(result.ok, false); assert.equal(result.error, error);
    assert(!JSON.stringify(result).includes('secret'));
  }
});

test('429 exposes bounded cooldown and timeout has its own result', async () => {
  const result = await evaluate({ ...settings, apiKey: 'not-a-real-key' }, {}, async () =>
    new Response('', { status: 429, headers: { 'Retry-After': '2' } }));
  assert.equal(result.error, 'rate-limited'); assert.equal(result.retryAfterMs, 2000);
  const timeout = await evaluate({ ...settings, apiKey: 'not-a-real-key' }, {}, async () => { throw new DOMException('deadline', 'TimeoutError'); });
  assert.equal(timeout.error, 'timeout');
});

test('missing credentials never make a network request', async () => {
  let calls = 0;
  const result = await evaluate({ ...settings, apiKey: '' }, {}, async () => { calls += 1; });
  assert.equal(calls, 0); assert.equal(result.error, 'no-key');
});

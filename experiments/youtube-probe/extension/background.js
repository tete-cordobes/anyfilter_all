import { DEFAULTS, settingsFrom, validState } from './shared.js';
import { evaluate } from './provider.js';

let current = { ...DEFAULTS };
let generation = 0;
let cooldownUntil = 0;
const lanes = { card: [], player: [] };
const busy = { card: false, player: false };
const cache = new Map();
const pending = new Map();
const connectionFailures = new Map();
let reportChain = Promise.resolve();

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  current = settingsFrom((await chrome.storage.local.get('settings')).settings);
})();

function publicSettings() { const { apiKey: _key, ...rest } = current; return rest; }
function youtube(sender) {
  try { return sender.frameId === 0 && new URL(sender.url).origin === 'https://www.youtube.com'; }
  catch { return false; }
}
const options = (sender) => sender.url === chrome.runtime.getURL('options.html');

function saveReport(event, tabId) {
  const entry = { at: new Date().toISOString(), tabId, surface: event.surface,
    outcome: String(event.outcome ?? '').slice(0, 80) };
  for (const key of ['action', 'error', 'skipState']) if (typeof event[key] === 'string') entry[key] = event[key].slice(0, 80);
  for (const key of ['clickAttempt', 'status', 'episode', 'latencyMs', 'elapsedMs', 'previousRate', 'requestedRate', 'observedRate']) if (Number.isFinite(event[key])) entry[key] = event[key];
  if (event.scores && ['advertisement', 'filter'].every((k) => Number.isFinite(event.scores[k]))) entry.scores = event.scores;
  reportChain = reportChain.then(async () => {
    const { events = [] } = await chrome.storage.session.get('events');
    await chrome.storage.session.set({ events: [...events, entry].slice(-200) });
  }).catch(() => {});
  return reportChain;
}

async function pump(surface) {
  if (busy[surface]) return;
  busy[surface] = true;
  try {
    while (lanes[surface].length) {
      const job = lanes[surface].shift();
      let result;
      if (job.generation !== generation || !current.enabled) result = { ok: false, error: 'settings-changed' };
      else if (Date.now() - job.at > 12000) result = { ok: false, error: 'queue-timeout' };
      else if (Date.now() < cooldownUntil) result = { ok: false, error: 'rate-limited' };
      else result = await evaluate(current, job.state);
      if (result.error === 'rate-limited' && result.retryAfterMs) cooldownUntil = Date.now() + result.retryAfterMs;
      if (job.generation !== generation) result = { ok: false, error: 'settings-changed' };
      if (result.ok) {
        cache.set(job.key, result);
        if (cache.size > 300) cache.delete(cache.keys().next().value);
      }
      pending.delete(job.key);
      job.resolve(result);
    }
  } finally { busy[surface] = false; }
}

function classify(state) {
  const key = JSON.stringify([generation, state]);
  if (cache.has(key)) return Promise.resolve({ ...cache.get(key), cached: true });
  if (pending.has(key)) return pending.get(key);
  if (lanes[state.surface].length >= 24) return Promise.resolve({ ok: false, error: 'queue-full' });
  const promise = new Promise((resolve) => lanes[state.surface].push({ key, state, resolve, generation, at: Date.now() }));
  pending.set(key, promise);
  void pump(state.surface);
  return promise;
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

async function pageStatus(tab, connect) {
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'probe-ping' }, { frameId: 0 });
  try {
    let state = await ping().catch(() => null);
    if (!state?.ok && connect) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['loader.js'] });
      for (let attempt = 0; attempt < 10 && !state?.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await ping().catch(() => null);
      }
    }
    if (state?.ok) connectionFailures.delete(tab.id);
    else if (connect) connectionFailures.set(tab.id, 'content-not-responding');
    return { tabId: tab.id, connected: state?.ok === true,
      ...(!state?.ok ? { connectionError: connectionFailures.get(tab.id) ?? 'content-not-responding' } : {}),
      ...(state?.ok ? { enabled: state.enabled, mode: state.mode, supported: state.supported,
        version: state.version,
        playerDiagnostics: state.playerDiagnostics, playerSamples: state.playerSamples,
        cards: state.cards, player: state.player, adShowing: state.adShowing, adUiVisible: state.adUiVisible,
        skipAvailable: state.skipAvailable, skipState: state.skipState, skipCandidates: state.skipCandidates } : {}) };
  } catch {
    connectionFailures.set(tab.id, 'injection-failed');
    return { tabId: tab.id, connected: false, connectionError: 'injection-failed' };
  } finally {
    if (connectionFailures.size > 100) connectionFailures.delete(connectionFailures.keys().next().value);
  }
}

async function diagnostics(connect = false) {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  return { ok: true, settings: publicSettings(), hasKey: !!current.apiKey,
    tabs: await Promise.all(tabs.map((tab) => pageStatus(tab, connect))) };
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: !current.apiKey ? 'KEY' : !current.enabled ? 'OFF' : current.mode === 'observe' ? 'OBS' : 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: current.enabled && current.mode === 'act' ? '#166534' : '#92400e' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  current = settingsFrom(changes.settings.newValue);
  generation += 1;
  cooldownUntil = 0;
  cache.clear();
  void updateBadge();
  void broadcast({ type: 'probe-settings', settings: publicSettings() });
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.runtime.openOptionsPage();
});
// Reloading/updating the extension invalidates scripts in already-open tabs.
// Restore their connection from saved settings, without navigating the page.
void ready.then(async () => {
  await updateBadge();
  if (!current.enabled) return;
  const health = await diagnostics(true);
  for (const tab of health.tabs.filter((tab) => !tab.connected)) {
    await saveReport({ surface: 'connection', outcome: 'connection-error', error: tab.connectionError }, tab.tabId);
  }
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== 'object') return false;
  const allowedPage = youtube(sender);
  if (!allowedPage && !options(sender)) return false;
  void ready.then(async () => {
    switch (message.type) {
      case 'probe-config': return publicSettings();
      case 'probe-diagnostics':
      case 'probe-connect-tabs':
        if (!options(sender)) return { ok: false, error: 'invalid-request' };
        return diagnostics(message.type === 'probe-connect-tabs');
      case 'probe-test-connection': {
        if (!options(sender)) return { ok: false, error: 'invalid-request' };
        const draft = settingsFrom(message.settings);
        const result = await evaluate(draft, { surface: 'card', title: 'Sample paid advertisement',
          channel: 'Example advertiser', sponsorLabel: 'Sponsored', adShowing: false, adUiVisible: true });
        await saveReport({ surface: 'connection', outcome: result.ok ? 'jev-connected' : 'evaluation-error',
          error: result.error, status: result.status, latencyMs: result.latencyMs });
        return result;
      }
      case 'probe-classify': {
        if (!allowedPage || !current.enabled || !validState(message.state)) return { ok: false, error: 'invalid-request' };
        const { surface, title, channel, sponsorLabel, adShowing, adUiVisible } = message.state;
        return classify({ surface, title, channel, sponsorLabel, adShowing, adUiVisible });
      }
      case 'probe-report':
        if (allowedPage && message.event && ['card', 'player', 'connection'].includes(message.event.surface))
          await saveReport(message.event, sender.tab.id);
        return { ok: true };
      case 'probe-restore':
        if (!options(sender)) return { ok: false };
        await broadcast({ type: 'probe-restore' });
        return { ok: true };
      default: return { ok: false, error: 'invalid-message' };
    }
  }).then(respond, () => respond({ ok: false, error: 'internal' }));
  return true;
});

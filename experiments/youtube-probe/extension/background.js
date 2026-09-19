import { DEFAULTS, settingsFrom, validState } from './shared.js';
import { evaluate } from './provider.js';

let current = { ...DEFAULTS };
let generation = 0;
let cooldownUntil = 0;
const lanes = { card: [], player: [] };
const busy = { card: false, player: false };
const cache = new Map();
const pending = new Map();
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
  for (const key of ['action', 'error']) if (typeof event[key] === 'string') entry[key] = event[key].slice(0, 80);
  for (const key of ['episode', 'latencyMs', 'elapsedMs', 'previousRate', 'requestedRate', 'observedRate']) if (Number.isFinite(event[key])) entry[key] = event[key];
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  current = settingsFrom(changes.settings.newValue);
  generation += 1;
  cooldownUntil = 0;
  cache.clear();
  void broadcast({ type: 'probe-settings', settings: publicSettings() });
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== 'object') return false;
  const allowedPage = youtube(sender);
  if (!allowedPage && !options(sender)) return false;
  void ready.then(async () => {
    switch (message.type) {
      case 'probe-config': return publicSettings();
      case 'probe-classify': {
        if (!allowedPage || !current.enabled || !validState(message.state)) return { ok: false, error: 'invalid-request' };
        const { surface, title, channel, sponsorLabel, adShowing, adUiVisible } = message.state;
        return classify({ surface, title, channel, sponsorLabel, adShowing, adUiVisible });
      }
      case 'probe-report':
        if (allowedPage && message.event && ['card', 'player'].includes(message.event.surface))
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

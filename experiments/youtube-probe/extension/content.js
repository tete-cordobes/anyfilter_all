import { AdController } from './controller.js';
import { cardNodes, readCard, readPlayer, executePlayerAction, filteredPage } from './reader.js';
import { matchesRule } from './shared.js';

const HIDDEN = 'anyfilter-youtube-probe-hidden';

export async function start() {
  let settings = await chrome.runtime.sendMessage({ type: 'probe-config' });
  if (!settings || typeof settings.enabled !== 'boolean') throw new Error('Configuration unavailable');
  let generation = 0;
  let cards = new WeakMap();
  const hidden = new Set();
  const restored = new Set();
  let route = location.href;
  let scheduled = 0;
  let interval;
  let stopped = false;
  const report = (event) => {
    try { void chrome.runtime.sendMessage({ type: 'probe-report', event }).catch(() => {}); }
    catch { /* The extension was reloaded; this old context can no longer report. */ }
  };
  const classify = (state) => chrome.runtime.sendMessage({ type: 'probe-classify', state });
  const player = new AdController({ read: readPlayer, execute: executePlayerAction, classify, report });
  const style = document.createElement('style');
  style.textContent = '.' + HIDDEN + ' { display: none !important; }';
  document.head.append(style);
  // A previous extension context may have disappeared while cards were hidden.
  for (const node of document.querySelectorAll('.' + HIDDEN)) node.classList.remove(HIDDEN);

  function restoreAll(remember) {
    for (const node of hidden) {
      if (remember) {
        const card = readCard(node);
        if (card) restored.add(card.fingerprint);
      }
      node.classList.remove(HIDDEN);
    }
    hidden.clear();
  }

  function invalidate() {
    generation += 1;
    player.reset();
    restoreAll(false);
    cards = new WeakMap();
  }

  async function evaluateCard(card) {
    const token = generation;
    const pageUrl = location.href;
    cards.set(card.node, card.fingerprint);
    try {
      const result = await classify(card.state);
      if (generation !== token || location.href !== pageUrl || !card.node.isConnected || !settings.enabled || !settings.filterCards ||
          readCard(card.node)?.fingerprint !== card.fingerprint || !filteredPage()) return;
      const match = matchesRule(result, settings);
      let outcome = result.ok ? (match ? 'would-hide' : 'kept') : 'evaluation-error';
      if (match && settings.mode === 'act' && !restored.has(card.fingerprint)) {
        card.node.classList.add(HIDDEN);
        hidden.add(card.node);
        outcome = 'hidden';
      }
      report({ surface: 'card', outcome, scores: result.scores, latencyMs: result.latencyMs, error: result.error, status: result.status });
    } catch { report({ surface: 'card', outcome: 'evaluation-error', error: 'transport' }); }
  }

  function scan() {
    scheduled = 0;
    if (stopped) return;
    if (!chrome.runtime?.id) { stop(); return; }
    if (route !== location.href) { route = location.href; invalidate(); }
    if (!settings.enabled) return;
    if (location.pathname === '/watch') player.tick(settings);
    else player.reset();
    if (!settings.filterCards || !filteredPage()) return;
    for (const node of hidden) {
      if (!node.isConnected) { hidden.delete(node); continue; }
      if (readCard(node)?.fingerprint !== cards.get(node)) {
        node.classList.remove(HIDDEN);
        hidden.delete(node);
        cards.delete(node);
      }
    }
    for (const node of cardNodes()) {
      const card = readCard(node);
      if (!card || cards.get(node) === card.fingerprint) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < -100 || rect.top > innerHeight + 600) continue;
      void evaluateCard(card);
    }
  }

  function schedule() { if (!stopped && !scheduled) scheduled = setTimeout(scan, 100); }
  function navigate() { invalidate(); route = location.href; schedule(); }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(scheduled);
    observer.disconnect();
    document.removeEventListener('yt-navigate-finish', navigate);
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('scroll', schedule);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Invalidated context. */ }
    invalidate();
    style.remove();
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'href', 'src', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled'] });
  function onMessage(message, _sender, respond) {
    if (message?.type === 'probe-ping') {
      const snapshot = readPlayer();
      respond({ ok: true, version: chrome.runtime.getManifest().version, enabled: settings.enabled, mode: settings.mode,
        supported: filteredPage(), cards: cardNodes().length,
        player: !!snapshot, adShowing: snapshot?.state.adShowing === true,
        skipAvailable: snapshot?.skipAvailable === true, skipState: snapshot?.skipState ?? 'missing',
        skipCandidates: snapshot?.skipCandidates ?? 0,
        adUiVisible: snapshot?.state.adUiVisible === true });
    } else if (message?.type === 'probe-settings') {
      settings = message.settings;
      invalidate();
      restored.clear();
      schedule();
    } else if (message?.type === 'probe-restore') {
      restoreAll(true);
      schedule();
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('yt-navigate-finish', navigate);
  window.addEventListener('popstate', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  interval = setInterval(scan, 250);
  report({ surface: 'connection', outcome: 'page-connected' });
  scan();
}

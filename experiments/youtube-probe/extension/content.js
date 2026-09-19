import { AdController } from './controller.js';
import { cardNodes, readCard, readPlayer, executePlayerAction, filteredPage } from './reader.js';
import { matchesRule } from './shared.js';

const HIDDEN = 'anyfilter-youtube-probe-hidden';

export async function start() {
  let settings = await chrome.runtime.sendMessage({ type: 'probe-config' });
  let generation = 0;
  let cards = new WeakMap();
  const hidden = new Set();
  const restored = new Set();
  let route = location.href;
  let scheduled = false;
  const report = (event) => { void chrome.runtime.sendMessage({ type: 'probe-report', event }).catch(() => {}); };
  const classify = (state) => chrome.runtime.sendMessage({ type: 'probe-classify', state });
  const player = new AdController({ read: readPlayer, execute: executePlayerAction, classify, report });
  const style = document.createElement('style');
  style.textContent = '.' + HIDDEN + ' { display: none !important; }';
  document.head.append(style);

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
      report({ surface: 'card', outcome, scores: result.scores, latencyMs: result.latencyMs, error: result.error });
    } catch { report({ surface: 'card', outcome: 'evaluation-error', error: 'transport' }); }
  }

  function scan() {
    scheduled = false;
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

  function schedule() { if (!scheduled) { scheduled = true; setTimeout(scan, 100); } }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'href', 'src', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled'] });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'probe-settings') {
      settings = message.settings;
      invalidate();
      restored.clear();
      schedule();
    } else if (message?.type === 'probe-restore') {
      restoreAll(true);
      schedule();
    }
  });
  document.addEventListener('yt-navigate-finish', () => { invalidate(); route = location.href; schedule(); });
  window.addEventListener('popstate', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  setInterval(scan, 250);
  scan();
}

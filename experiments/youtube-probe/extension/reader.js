const CARD = 'ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,yt-lockup-view-model,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer';
const SKIP = '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern';
// The observed clean-player badge has no legacy badge class.
const AD_UI = '.ytp-ad-text,.ytp-ad-simple-ad-badge,.ytp-ad-badge,.ytp-ad-badge--clean-player,.ytp-ad-preview-container,.ytp-ad-player-overlay-instream-info';
const text = (node) => (node?.textContent ?? '').trim().slice(0, 1500);
const readySkipLabel = /^(?:skip(?:\s+ads?)?|saltar(?:\s+(?:anuncios?|publicidad))?|omitir(?:\s+(?:anuncios?|publicidad))?)(?:\s*[»›>→])?$/i;
const controlLabel = (node) => (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');

export function visible(node) {
  if (!node?.isConnected || node.closest('[hidden],[aria-hidden="true"]')) return false;
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  for (let parent = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  }
  return true;
}

export function readSkipControl(player) {
  const candidates = [...new Set([...player.querySelectorAll(SKIP + ',button,[role="button"]')]
    .filter((node) => node.matches(SKIP) || readySkipLabel.test(controlLabel(node)))
    .map((node) => node.matches('button,[role="button"]') ? node : node.querySelector('button,[role="button"]') || node))];
  let state = candidates.length ? 'hidden' : 'missing';
  for (const node of candidates) {
    if (!visible(node)) continue;
    if (node.matches(':disabled') || node.closest('[aria-disabled="true"],[inert]') || getComputedStyle(node).pointerEvents === 'none') {
      state = 'disabled'; continue;
    }
    const countdownText = controlLabel(node) + ' ' + (node.innerText ?? node.textContent ?? '');
    if (/\b\d+\b|\bseconds?\b|\bsegundos?\b/i.test(countdownText)) { state = 'countdown'; continue; }
    return { button: node, state: 'ready', candidates: candidates.length };
  }
  return { button: null, state, candidates: candidates.length };
}

export function skipButton(player) {
  return readSkipControl(player).button;
}

export function readPlayer() {
  const player = document.querySelector('#movie_player');
  if (!player || !visible(player)) return null;
  const media = player.querySelector('video.html5-main-video,video');
  const badge = [...player.querySelectorAll(AD_UI)].find(visible);
  const skip = readSkipControl(player);
  const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const title = text(player.querySelector('.ytp-ad-title,.ytp-ad-text-overlay'));
  const channel = text(player.querySelector('.ytp-ad-visit-advertiser-button,.ytp-ad-button-text'));
  const mediaSource = media?.currentSrc ?? '';
  const duration = media?.duration ?? NaN;
  const state = { surface: 'player', title, channel, sponsorLabel: text(badge), adShowing, adUiVisible: !!badge || !!skip.button };
  const identity = JSON.stringify([location.href, mediaSource, Number.isFinite(duration) ? duration : null, title, channel]);
  return { player, media, state, identity, pageUrl: location.href, mediaSource, duration,
    playbackRate: media?.playbackRate, mediaTime: media?.currentTime ?? 0,
    skipAvailable: !!skip.button, skipState: skip.state, skipCandidates: skip.candidates,
    seekable: !!media?.seekable?.length && media.seekable.end(media.seekable.length - 1) >= duration - 0.25 };
}

// Read-only, bounded diagnostics for player layouts that the detector misses.
// No text, URLs, arbitrary attributes or media sources are returned.
export function readPlayerDiagnostics(snapshot = readPlayer()) {
  const selected = snapshot?.player;
  const roots = [...document.querySelectorAll('#movie_player,.html5-video-player,ytd-player')].slice(0, 6);
  const cssClasses = (node) => [...node.classList].filter((name) =>
    /^(?:ytp-|yt[A-Z]|yt-|ytm-|ytd-|html5-|ad-|video-ads)/.test(name) && /^[\w-]{1,80}$/.test(name)).slice(0, 12);
  const shape = (node) => {
    const rect = node.getBoundingClientRect();
    return { tag: node.localName, classes: cssClasses(node), visible: visible(node), openShadowRoot: !!node.shadowRoot,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      width: Math.round(rect.width), height: Math.round(rect.height),
      insideSelectedPlayer: node === selected || !!selected?.contains(node) };
  };
  const labelKind = (node) => {
    const raw = node.getAttribute('aria-label') || node.textContent || '';
    if (raw.length > 80) return null;
    const label = raw.trim().replace(/\s+/g, ' ');
    if (/^(?:ad|advertisement|sponsored|anuncio|publicidad|patrocinado)(?:\s*\d+(?:\s*(?:of|de|\/)\s*\d+)?)?$/i.test(label)) return 'advertising';
    if (readySkipLabel.test(label)) return 'skip';
    if (/^(?:visit advertiser|visitar anunciante|about this ad|acerca de este anuncio)$/i.test(label)) return 'advertiser-control';
    return null;
  };
  const signals = []; const seen = new Set();
  const add = (node) => {
    if (seen.has(node) || signals.length >= 120) return;
    const label = labelKind(node);
    if (!label && ![...node.classList].some((name) => /ad-|ads|sponsor|skip|Ad[A-Z]/.test(name))) return;
    seen.add(node);
    signals.push({ ...shape(node), label,
      knownAdUi: node.matches(AD_UI), knownSkip: node.matches(SKIP),
      disabled: node.matches(':disabled') || !!node.closest('[aria-disabled="true"],[inert]') });
  };
  for (const root of roots) {
    add(root);
    for (const node of [...root.querySelectorAll('*')].slice(0, 600)) add(node);
  }
  for (const node of [...document.querySelectorAll('[class*="ytp-ad-"],[class*="ytAd"],.video-ads')].slice(0, 80)) add(node);
  const videos = [...document.querySelectorAll('video')].slice(0, 6).map((media) => ({ ...shape(media),
    selected: media === snapshot?.media, paused: media.paused, ended: media.ended, readyState: media.readyState,
    duration: Number.isFinite(media.duration) ? Math.round(media.duration * 10) / 10 : null,
    currentTime: Math.round(media.currentTime * 10) / 10, playbackRate: media.playbackRate,
    hasSource: !!media.currentSrc, seekableRanges: media.seekable.length }));
  return { at: new Date().toISOString(), page: location.pathname === '/watch' ? 'watch' : 'other',
    documentVisible: !document.hidden, selectedPlayerPresent: !!selected,
    adShowing: snapshot?.state.adShowing === true, adUiVisible: snapshot?.state.adUiVisible === true,
    roots: roots.map((node) => ({ ...shape(node), selected: node === selected })),
    signals: signals.sort((a, b) => Number(b.visible) - Number(a.visible)).slice(0, 40),
    signalsTruncated: signals.length > 40, videos,
    frames: [...document.querySelectorAll('iframe')].slice(0, 6).map(shape) };
}

export function executePlayerAction(action, expected) {
  const fresh = readPlayer();
  if (!fresh || fresh.identity !== expected.identity || fresh.player !== expected.player ||
      fresh.media !== expected.media || !fresh.state.adShowing || !fresh.state.adUiVisible) return false;
  if (action === 'click-skip') {
    const button = skipButton(fresh.player);
    if (!button) return false;
    button.click();
    return true;
  }
  if (action === 'speed-16x' && fresh.mediaSource && Number.isFinite(fresh.duration) &&
      fresh.duration > 0 && fresh.duration <= 180) {
    const media = fresh.media;
    const previousRate = media.playbackRate;
    let active = true;
    const restore = () => {
      if (!active) return;
      active = false;
      observer.disconnect();
      media.removeEventListener('emptied', restore);
      media.removeEventListener('ended', restore);
      media.removeEventListener('ratechange', guard);
      // Respect a subsequent user/player speed change; undo only our own 16x value.
      if (media.playbackRate === 16) media.playbackRate = previousRate;
    };
    const guard = () => {
      const now = readPlayer();
      if (!now || now.identity !== fresh.identity || now.media !== media ||
          !now.state.adShowing || !now.state.adUiVisible || media.ended || media.playbackRate !== 16) restore();
    };
    const observer = new MutationObserver(guard);
    observer.observe(fresh.player, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    media.addEventListener('emptied', restore);
    media.addEventListener('ended', restore);
    media.addEventListener('ratechange', guard);
    try { media.playbackRate = 16; } catch { restore(); return false; }
    if (media.playbackRate !== 16) { restore(); return false; }
    return { restore, previousRate, requestedRate: 16, observedRate: media.playbackRate };
  }
  if (action === 'seek-end' && fresh.mediaSource && fresh.seekable && Number.isFinite(fresh.duration) &&
      fresh.duration > 0 && fresh.duration <= 180) {
    fresh.media.currentTime = fresh.duration;
    return true;
  }
  return false;
}

export function readCard(node) {
  const links = [...node.querySelectorAll('a[href]')];
  const videoLink = links.find((link) => {
    try {
      const url = new URL(link.href, location.href);
      return url.origin === 'https://www.youtube.com' &&
        ((url.pathname === '/watch' && url.searchParams.has('v')) || url.pathname.startsWith('/shorts/'));
    } catch { return false; }
  });
  const title = text(node.querySelector('#video-title,#video-title-link,h3,.yt-lockup-metadata-view-model__title,.ytLockupMetadataViewModelTitle'));
  const channel = text(node.querySelector('ytd-channel-name,a[href^="/@"],a[href^="/channel/"]'));
  const sponsor = [...node.querySelectorAll('.badge-style-type-ad,.yt-badge-shape__text,.ytBadgeShapeBadgeText,.yt-ad-badge-view-model')]
    .find((item) => /^(sponsored|ad|anuncio|patrocinado|publicidad)$/i.test(text(item)));
  const structuralAd = node.matches('ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer') ||
    !!node.querySelector('ytd-in-feed-ad-layout-renderer,ytd-promoted-sparkles-web-renderer');
  if (!title && !sponsor && !structuralAd) return null;
  const state = { surface: 'card', title, channel, sponsorLabel: text(sponsor) || (structuralAd ? 'YouTube advertising slot' : ''),
    adShowing: false, adUiVisible: !!sponsor || structuralAd };
  const url = videoLink ? new URL(videoLink.href, location.href) : null;
  const id = url ? url.searchParams.get('v') || url.pathname : 'ad:' + title;
  return { node, id, state, fingerprint: JSON.stringify([id, state]) };
}

export function cardNodes() {
  return [...document.querySelectorAll(CARD)].filter((node) => !node.parentElement?.closest(CARD));
}

export function filteredPage() {
  return location.pathname === '/' || location.pathname === '/results' || location.pathname === '/watch' ||
    location.pathname.startsWith('/feed/');
}

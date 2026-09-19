const CARD = 'ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,yt-lockup-view-model,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer';
const SKIP = '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern';
const AD_UI = '.ytp-ad-text,.ytp-ad-simple-ad-badge,.ytp-ad-badge,.ytp-ad-preview-container,.ytp-ad-player-overlay-instream-info';
const text = (node) => (node?.textContent ?? '').trim().slice(0, 1500);

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

export function skipButton(player) {
  return [...player.querySelectorAll(SKIP)].find((node) => visible(node) &&
    !node.disabled && node.getAttribute('aria-disabled') !== 'true') ?? null;
}

export function readPlayer() {
  const player = document.querySelector('#movie_player');
  if (!player || !visible(player)) return null;
  const media = player.querySelector('video.html5-main-video,video');
  const badge = [...player.querySelectorAll(AD_UI)].find(visible);
  const skip = skipButton(player);
  const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const title = text(player.querySelector('.ytp-ad-title,.ytp-ad-text-overlay'));
  const channel = text(player.querySelector('.ytp-ad-visit-advertiser-button,.ytp-ad-button-text'));
  const mediaSource = media?.currentSrc ?? '';
  const duration = media?.duration ?? NaN;
  const state = { surface: 'player', title, channel, sponsorLabel: text(badge), adShowing, adUiVisible: !!badge || !!skip };
  const identity = JSON.stringify([location.href, mediaSource, Number.isFinite(duration) ? duration : null, title, channel]);
  return { player, media, state, identity, pageUrl: location.href, mediaSource, duration,
    playbackRate: media?.playbackRate, mediaTime: media?.currentTime ?? 0,
    skipAvailable: !!skip, seekable: !!media?.seekable?.length && media.seekable.end(media.seekable.length - 1) >= duration - 0.25 };
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

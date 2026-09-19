import { playerAction, strongAd } from './shared.js';

// A model decision is bound to a specific ad episode. It never directly mutates media.
export class AdController {
  constructor({ read, classify, execute, report, now = () => Date.now() }) {
    Object.assign(this, { read, classify, execute, report, now });
    this.episode = null;
    this.serial = 0;
  }

  reset() {
    try { this.episode?.restore?.(); } catch { this.report({ surface: 'player', outcome: 'restore-error' }); }
    this.episode = null;
    this.serial += 1;
  }

  tick(settings) {
    if (!settings.enabled || !settings.skipAds) { this.reset(); return; }
    const snapshot = this.read();
    if (!strongAd(snapshot)) {
      if (this.episode?.attempt) this.report({ surface: 'player', outcome:
        snapshot?.player === this.episode.player && snapshot.pageUrl === this.episode.pageUrl
          ? 'ad-ended-after-attempt' : 'episode-abandoned',
        action: this.episode.attempt.action, elapsedMs: this.now() - this.episode.attempt.at,
        episode: this.episode.serial });
      this.reset();
      return;
    }
    if (!this.episode || this.episode.identity !== snapshot.identity || this.episode.player !== snapshot.player ||
        this.episode.media !== snapshot.media) {
      this.reset();
      const episode = this.episode = { identity: snapshot.identity, player: snapshot.player, pageUrl: snapshot.pageUrl,
        media: snapshot.media, serial: ++this.serial, result: null, pending: true, attempt: null, outcomes: new Set() };
      Promise.resolve().then(() => this.classify(snapshot.state)).then((result) => {
        if (this.episode !== episode) return;
        const fresh = this.read();
        if (!strongAd(fresh) || fresh.identity !== episode.identity || fresh.player !== episode.player || fresh.media !== episode.media) {
          this.reset(); return;
        }
        episode.pending = false;
        episode.result = result;
        this.report({ surface: 'player', outcome: result.ok ? 'evaluated' : 'evaluation-error',
          episode: episode.serial, scores: result.scores, error: result.error, latencyMs: result.latencyMs });
      }, () => {
        if (this.episode === episode) {
          episode.pending = false;
          episode.result = { ok: false, error: 'transport' };
          this.report({ surface: 'player', outcome: 'evaluation-error', episode: episode.serial, error: 'transport' });
        }
      });
      return;
    }
    const episode = this.episode;
    if (episode.pending) return;
    const action = playerAction(snapshot, episode.result, settings);
    if (action === 'none') return;
    if (action === 'observe' || action === 'no-action-available') {
      if (!episode.outcomes.has(action)) {
        episode.outcomes.add(action);
        this.report({ surface: 'player', outcome: action, episode: episode.serial });
      }
      return;
    }
    // One attempt per mechanism/episode: do not hammer synthetic clicks on a refusing player.
    if (episode.outcomes.has(action)) {
      if (action === 'speed-16x' && snapshot.playbackRate !== 16 && !episode.outcomes.has('speed-not-maintained')) {
        episode.outcomes.add('speed-not-maintained');
        this.report({ surface: 'player', outcome: 'speed-not-maintained', episode: episode.serial });
      }
      const waitMs = action === 'speed-16x' ? episode.attempt?.waitMs ?? 2500 : 2500;
      if (episode.attempt && this.now() - episode.attempt.at >= waitMs && !episode.outcomes.has('still-playing')) {
        episode.outcomes.add('still-playing');
        this.report({ surface: 'player', outcome: 'ad-still-playing-after-attempt', action, episode: episode.serial });
      }
      return;
    }
    episode.outcomes.add(action);
    try {
      episode.restore?.();
      const applied = this.execute(action, snapshot);
      if (applied) {
        episode.restore = applied.restore;
        episode.attempt = { action, at: this.now(), waitMs: action === 'speed-16x'
          ? Math.max(2500, (snapshot.duration - snapshot.mediaTime) / 16 * 1000 + 2000) : 2500 };
        this.report({ surface: 'player', outcome: 'action-attempted', action, episode: episode.serial,
          previousRate: applied.previousRate, requestedRate: applied.requestedRate, observedRate: applied.observedRate });
      } else this.report({ surface: 'player', outcome: 'action-aborted', action, episode: episode.serial });
    } catch {
      this.report({ surface: 'player', outcome: 'action-error', action, episode: episode.serial });
    }
  }
}

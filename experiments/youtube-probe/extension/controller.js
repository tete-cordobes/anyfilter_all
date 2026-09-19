import { playerAction, strongAd } from './shared.js';

// A model decision is bound to a specific ad episode. It never directly mutates media.
export class AdController {
  constructor({ read, classify, execute, report, now = () => Date.now() }) {
    Object.assign(this, { read, classify, execute, report, now });
    this.episode = null;
    this.serial = 0;
  }

  reset() {
    this.stopAcceleration(this.episode);
    this.episode = null;
    this.serial += 1;
  }

  stopAcceleration(episode) {
    if (!episode) return;
    const restore = episode.restore;
    episode.restore = null;
    episode.accelerationDeadline = 0;
    try { restore?.(); } catch { this.report({ surface: 'player', outcome: 'restore-error', episode: episode.serial }); }
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
        media: snapshot.media, serial: ++this.serial, result: null, pending: true, attempt: null, outcomes: new Set(),
        skipAttempts: 0, nextSkipAt: 0, accelerationDeadline: 0 };
      Promise.resolve().then(() => this.classify(snapshot.state)).then((result) => {
        if (this.episode !== episode) return;
        const fresh = this.read();
        if (!strongAd(fresh) || fresh.identity !== episode.identity || fresh.player !== episode.player || fresh.media !== episode.media) {
          this.reset(); return;
        }
        episode.pending = false;
        episode.result = result;
        this.report({ surface: 'player', outcome: result.ok ? 'evaluated' : 'evaluation-error',
          episode: episode.serial, scores: result.scores, error: result.error, status: result.status, latencyMs: result.latencyMs });
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
    const skipState = snapshot.skipState ?? (snapshot.skipAvailable ? 'ready' : 'missing');
    if (episode.skipState !== skipState) {
      episode.skipState = skipState;
      this.report({ surface: 'player', outcome: 'skip-control', skipState, episode: episode.serial });
    }
    if (episode.pending) return;
    if (episode.accelerationDeadline && this.now() >= episode.accelerationDeadline) {
      this.stopAcceleration(episode);
      episode.outcomes.add('acceleration-window-ended');
      this.report({ surface: 'player', outcome: 'acceleration-window-ended', episode: episode.serial });
    }
    if (episode.attempt && !episode.attempt.stillReported && this.now() - episode.attempt.at >= episode.attempt.waitMs) {
      episode.attempt.stillReported = true;
      this.report({ surface: 'player', outcome: 'ad-still-playing-after-attempt', action: episode.attempt.action, episode: episode.serial });
    }
    const action = playerAction(snapshot, episode.result, settings);
    if (action === 'none') return;
    if (action === 'observe' || action === 'no-action-available') {
      if (!episode.outcomes.has(action)) {
        episode.outcomes.add(action);
        this.report({ surface: 'player', outcome: action, episode: episode.serial });
      }
      return;
    }
    // The first click can race YouTube's button activation. One delayed retry is
    // allowed, always with a fresh ad/button check, never more than two clicks.
    if (action === 'click-skip' && (episode.skipAttempts >= 2 || this.now() < episode.nextSkipAt)) return;
    if (action !== 'click-skip' && episode.outcomes.has(action)) {
      if (action === 'speed-16x' && snapshot.playbackRate !== 16 && !episode.outcomes.has('speed-not-maintained') &&
          !episode.outcomes.has('acceleration-window-ended')) {
        episode.outcomes.add('speed-not-maintained');
        this.report({ surface: 'player', outcome: 'speed-not-maintained', episode: episode.serial });
      }
      return;
    }
    if (action === 'click-skip') episode.nextSkipAt = this.now() + 800;
    else episode.outcomes.add(action);
    try {
      if (action !== 'click-skip') this.stopAcceleration(episode);
      const applied = this.execute(action, snapshot);
      if (applied) {
        if (action === 'click-skip') episode.skipAttempts += 1;
        if (applied.restore) episode.restore = applied.restore;
        episode.attempt = { action, at: this.now(), waitMs: action === 'speed-16x'
          ? Math.max(2500, (snapshot.duration - snapshot.mediaTime) / 16 * 1000 + 2000) : 2500 };
        if (action === 'speed-16x') episode.accelerationDeadline = this.now() + episode.attempt.waitMs;
        this.report({ surface: 'player', outcome: 'action-attempted', action, episode: episode.serial,
          ...(action === 'click-skip' ? { clickAttempt: episode.skipAttempts } : {}),
          previousRate: applied.previousRate, requestedRate: applied.requestedRate, observedRate: applied.observedRate });
      } else if (!episode.outcomes.has('aborted:' + action)) {
        episode.outcomes.add('aborted:' + action);
        this.report({ surface: 'player', outcome: 'action-aborted', action, episode: episode.serial });
      }
    } catch {
      if (action === 'click-skip') episode.skipAttempts += 1;
      this.report({ surface: 'player', outcome: 'action-error', action, episode: episode.serial });
    }
  }
}

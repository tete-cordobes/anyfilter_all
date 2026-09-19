# YouTube + Jev experiment

This separate unpacked Chrome extension tests whether Jev decisions can drive both card filtering and player-ad actions. It does not change the existing X extension or share its settings. It is a feasibility probe, not a claim that YouTube ads are blocked.

## What is implemented

The content script reads visible card metadata or player-ad UI evidence. The background worker sends that structured evidence and two typed questions to Jev: whether it is an advertisement, and whether it matches the user's rule. A positive decision can hide a card or enable a guarded player action. All player actions additionally require current, visible local ad evidence.

Player mechanisms, in order:

1. Click a visible, enabled skip button.
2. If enabled, try 16× playback for a finite ad segment, preserving the previous speed.
3. If acceleration is disabled and seeking is enabled, try seeking to the end of a finite, seekable ad segment.

Acceleration and seeking are off by default. The maximum segment duration for those experiments is 180 seconds. A model verdict alone never authorizes modifying ordinary playback. The probe never mutes audio or changes volume. Acceleration is removed when the ad ends, the media changes, the experiment is disabled or navigation invalidates the decision. A subsequent speed change by the user or player is respected, not repeatedly overwritten.

The player probe runs on desktop `/watch` pages. Card scanning covers desktop Home, search, watch recommendations and feeds. The vertical Shorts player, creator-read sponsorships, mobile YouTube and network-level ad blocking are outside this experiment.

## Install for a manual real-site test

1. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
2. Select the `extension` directory next to this file.
3. Click the extension icon. Select TypeSafe or Vercel and enter the matching API key.
4. Start in **Observar** mode, enable the experiment and save. Reload an open YouTube tab if it was opened before installation.
5. Inspect the recorded evaluations. To test actions, choose **Aplicar**, optionally enable **16×**, and save.
6. Test a normal video, a skippable ad and a non-skippable ad. Export the observations from the options page.

The API key is stored in this experiment's trusted extension storage and sent only to the selected provider for authentication. Title, channel, advertising label and two ad-UI flags are sent for evaluation. No audio, images, video stream, cookies or account tokens are sent. Reports contain probabilities, timings and action outcomes, not the API key or page text. Session reports are bounded to 200 events and disappear when the browser closes.

If the provider rejects a request, the probe leaves that item alone. Change credentials if needed, then disable and re-enable the experiment to retry. It does not automatically hammer a failing provider or retry a rejected playback action indefinitely.

## Automated checks

Run from the repository root with Node 22.9+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright-core install chromium
pnpm test:youtube
pnpm e2e:youtube
pnpm build
pnpm e2e
```

`test:youtube` tests decision gates, stale responses, cleanup, timeout/error handling and both provider contracts. `e2e:youtube` loads the actual probe extension into an isolated test browser. Every YouTube page and provider request is intercepted with a controlled local fixture; unmatched requests are aborted. It checks card restoration, recycled nodes, navigation, real HTML media properties, rejected actions and late model responses. The playback speed comparison uses an actual media clock backed by a generated silent WAV, within a synthetic ad fixture. It does not measure YouTube's player or Jev network latency.

The existing X E2E remains a separate regression gate. Both runners select the full Chromium browser, because the default headless-shell binary does not load these extensions.

## Real Jev evaluation

Set either `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` in an ignored `.env.local` at the repository root, then run:

```sh
pnpm eval:youtube
```

`ANYFILTER_PROBE_PROVIDER=typesafe` or `vercel` can select the provider explicitly. This makes up to 17 real API requests using labelled, synthetic Spanish/English examples, including ordinary videos discussing ads and prompt-injection attempts. Expected labels are not sent to Jev. The output records probabilities, threshold-based correctness and p50/p95 latency. A missing key exits with code 2 and `blocked-no-api-key`; that is not a passed evaluation. Authentication errors or rate limits stop further requests.

## Reading results

| Event | Meaning |
| --- | --- |
| `evaluated` | Jev (or the offline mock) returned valid probabilities. |
| `would-hide` / `observe` | Positive decision in observation mode; no action executed. |
| `hidden` | A card was hidden locally. |
| `action-attempted` | A click, speed assignment or seek was issued; acceptance is not implied. |
| `ad-ended-after-attempt` | The ad UI subsequently ended on the same page/player. This can coincide with a natural ending; it does not prove causal blocking. |
| `ad-still-playing-after-attempt` | The ad remained after the observation deadline. |
| `speed-not-maintained` | The requested 16× value was changed or rejected. |
| `no-action-available` | Detected ad, but no enabled and eligible action. |
| `episode-abandoned` | Page/player disappeared; not an observed successful removal. |

Generated evidence is saved to ignored `reports/youtube-probe-offline.json`, `reports/youtube-probe-jev.json` and an options screenshot. Real-site success still requires watching that the advertisement ends sooner and that the main video resumes at the correct position and speed, across multiple ad types. DOM variations, player enforcement and server timing may reject an otherwise valid local action.

Sources consulted: [TypeSafe model/API](https://docs.typesafe.ai/introduction), [Vercel TypeSafe adapter](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe), [HTML media playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate), [Chrome declarative network rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest). These sources establish API behavior, not real-site effectiveness of this probe.

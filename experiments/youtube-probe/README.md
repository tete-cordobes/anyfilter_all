# YouTube + Jev experiment

This separate unpacked Chrome extension tests whether Jev decisions can drive both card filtering and player-ad actions. It does not change the existing X extension or share its settings. It is a feasibility probe, not a claim that YouTube ads are blocked.

## What is implemented

The content script reads visible card metadata or player-ad UI evidence. The background worker sends that structured evidence and two typed questions to Jev: whether it is an advertisement, and whether it matches the user's rule. A positive decision can hide a card or enable a guarded player action. All player actions additionally require current, visible local ad evidence.

Player mechanisms, in order:

1. Click a visible, enabled skip button.
2. If enabled, try 16× playback for a finite ad segment, preserving the previous speed.
3. If acceleration is disabled and seeking is enabled, try seeking to the end of a finite, seekable ad segment.

Acceleration and seeking are off before activation. **Comprobar Jev y activar filtro** explicitly enables acceleration after checking Jev; seeking remains an independent advanced setting. The maximum segment duration for those experiments is 180 seconds. A model verdict alone never authorizes modifying ordinary playback. The probe never mutes audio or changes volume. Acceleration is removed when the ad ends, the media changes, the experiment is disabled, navigation invalidates the decision, or the ad remains beyond its expected accelerated duration plus a grace period. A subsequent speed change by the user or player is respected, not repeatedly overwritten.

The player probe runs on desktop `/watch` pages. Card scanning covers desktop Home, search, watch recommendations and feeds. The vertical Shorts player, creator-read sponsorships, mobile YouTube and network-level ad blocking are outside this experiment.

## Install for a manual real-site test

1. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
2. Select the `extension` directory next to this file.
3. The Jev configuration page opens automatically. Select TypeSafe or Vercel and enter the matching API key.
4. Click **Comprobar Jev y activar filtro**. It sends one example to the selected Jev API and, only after a valid response, saves the key and enables card filtering, ad skipping and 16×. Authentication, quota, network and response-format errors are displayed. **Solo comprobar conexión** checks the entered key without saving or activating.
5. Existing YouTube tabs are connected without reloading. The status panel shows connected tabs, active/observation/disabled state, unsupported pages, recent activity and provider errors. **Conectar pestañas de YouTube** can retry a disconnected tab. Open YouTube in the same Chrome profile.
6. **Ajustes del filtro** contains the custom rule, observation-only mode, individual controls and experimental seeking. Save there to apply those choices. Test a normal video, a skippable ad and a non-skippable ad; export observations from the options page.

When updating an already loaded unpacked extension to 0.1.1, click its reload button in `chrome://extensions`, reload YouTube once to discard the old content script, then reopen the options. Existing saved credentials are preserved. The new `scripting` permission is used only to connect already-open `www.youtube.com` tabs; provider evaluation still uses Jev, with no ChatGPT dependency.

The API key is stored in this experiment's trusted extension storage and sent only to the selected provider for authentication. Title, channel and advertising label are sent for evaluation; player requests also include two ad-UI flags. Feed cards do not send unrelated player flags. No audio, images, video stream, cookies or account tokens are sent. Reports contain probabilities, timings and action outcomes, not the API key or page text. Session reports are bounded to 200 events and disappear when the browser closes.

If the provider rejects a request, the probe leaves that item alone. Change credentials if needed, then disable and re-enable the experiment to retry. It does not automatically hammer a failing provider or retry a rejected playback action indefinitely.

## Automated checks

Run from the repository root with Node 22.9+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright-core install chromium
pnpm test:youtube
pnpm e2e:youtube
pnpm e2e:youtube:setup
pnpm build
pnpm e2e
```

`test:youtube` tests decision gates, stale responses, cleanup, timeout/error handling and both provider contracts. `e2e:youtube` loads the actual probe extension into an isolated test browser. Every YouTube page and provider request is intercepted with a controlled local fixture; unmatched requests are aborted. It checks card restoration, recycled nodes, navigation, real HTML media properties, rejected actions and late model responses. The playback speed comparison uses an actual media clock backed by a generated silent WAV, within a synthetic ad fixture. It does not measure YouTube's player or Jev network latency.

The existing X E2E remains a separate regression gate. Both runners select the full Chromium browser, because the default headless-shell binary does not load these extensions.

`e2e:youtube:setup` opens a synthetic YouTube page **before installing** the extension, then installs the real package and uses its UI to check onboarding, missing/rejected keys, rate limits, activation, connecting the existing tab without navigation, idempotent injection, mode changes, restricted credential access and redacted diagnostics. Every external request is intercepted; provider responses are mocked. It does not access the user's Chrome profile or test live YouTube.

## Real Jev evaluation

Set either `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` in an ignored `.env.local` at the repository root, then run:

```sh
pnpm eval:youtube
pnpm eval:youtube --holdout
pnpm e2e:youtube:jev
```

`ANYFILTER_PROBE_PROVIDER=typesafe` or `vercel` can select the provider explicitly. This makes up to 17 real API requests using labelled, synthetic Spanish/English examples, including ordinary videos discussing ads and prompt-injection attempts. Expected labels are not sent to Jev. The output records probabilities, threshold-based correctness and p50/p95 latency. A missing key exits with code 2 and `blocked-no-api-key`; that is not a passed evaluation. Authentication errors or rate limits stop further requests.

`--holdout` runs 20 additional cases that were not used to select the revised prompts. Their failures remain visible in `reports/youtube-probe-jev-holdout.json`; see [RESULTS.md](RESULTS.md). These samples are not an estimate of real-world accuracy.

`e2e:youtube:jev` requires `ffmpeg` and a real API key. It loads the actual extension into a temporary Chromium profile, enters the key through its options, and sends provider requests to the real API. YouTube pages and media remain local fixtures. It checks card filtering, skipping, native MP4 playback at 16× and restoring main-content speed/position/volume. The temporary profile is deleted on completion. The result is saved to `reports/youtube-probe-real-jev-e2e.json` and must not be described as a test of live YouTube advertisements.

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

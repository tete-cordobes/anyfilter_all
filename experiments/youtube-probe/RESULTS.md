# YouTube probe results — 2026-09-19, version 0.1.1

The extension and Jev API have now been exercised together. All page and player evidence in these automated tests is synthetic. **Live YouTube advertisements remain unverified.** The user reported no effect with version 0.1.0 even after configuration.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Decision/controller/provider tests | 22 passed | Local tests, mocked responses, includes restoring stalled acceleration |
| Probe extension E2E | 34 passed | Actual MV3 extension; synthetic YouTube DOM, native media, mocked Jev |
| Installation/activation E2E | 20 passed | Page opened before installing; actual options UI, mocked Jev |
| Real TypeSafe Jev regression | 17/17 passed after repair; 9/17 before | Real API, synthetic labelled inputs; unchanged 0.9 threshold |
| Real TypeSafe Jev additional cases | 18/20 passed | Additional synthetic inputs not used to select prompts; limitations below |
| Extension with real TypeSafe Jev | 11 checks passed, 6 real API calls | Actual extension and API; synthetic DOM, generated H.264/AAC MP4 |
| Existing X extension E2E | 47 passed in initial baseline | Existing offline fixtures; X runtime code unchanged by this repair |
| Main extension typecheck/build | Passed | WXT production build |
| Live YouTube advertisements | Not tested by the agent | Browser connection still unavailable; manual retest of updated extension needed |

## Confirmed classification failure and repair

The first real API run reproduced a failure that mocks did not reveal: sponsored cards and player ads received scores below the action threshold. For the English player ad, advertisement=0.51 and filter=0.09 meant no action. The original compound prompts performed poorly; card states also included `adShowing:false`, a player flag irrelevant to the card's sponsored badge.

The repaired request uses descriptive observations appropriate to each surface and two short questions. Feed cards omit player state. The English player-ad example now scores 0.98 on both questions. The regression set improved from 9/17 to 17/17, without lowering thresholds or bypassing Jev. Real regression latency: p50=269 ms, p95=764 ms. This follows TypeSafe's guidance on [atomic questions](https://docs.typesafe.ai/introduction) and [descriptive state](https://docs.typesafe.ai/concepts/state), but the API measurements, not documentation, establish the improvement on these samples.

The 20 additional cases returned 18 fully correct classifications (p50=284 ms, p95=386 ms). Two limitations remain:

- An empty structural ad slot scores advertisement=0.87, filter=0.97. The advertisement label misses the 0.9 threshold, but the actual card action correctly hides it because cards use the filter score.
- A Spanish custom football rule misses the ambiguous title “Resumen de la jornada de Liga y clasificación”: filter=0.78. It remains visible. This is tracked under `CLIENTES-icok`; no threshold tuning was applied to force this sample to pass.

Every additional player-ad case passed, including missing creative text, an injected denial, and a custom rule that allows the ad. These small synthetic datasets do not establish a real-world accuracy rate. Vercel has offline contract coverage but was not tested with a real Vercel key.

## Actual extension with real Jev, controlled player

The test enters the key through the extension's UI, makes real provider calls, hides sponsored/crypto cards, keeps an ordinary discussion of advertising, and clicks a fixture skip button after a real Jev decision. It then measures a generated eight-second MP4 from a starting speed of 1.25×:

| Run | Wall time | Observed rate |
| --- | --- | --- |
| Baseline, filter disabled | 6,474 ms | 1.25× |
| Real Jev decision plus acceleration | 930 ms | 16× |

The observed improvement was 6.96× including scan and real API latency. The main fixture video returned to position 3 seconds, speed 1.25× and volume 0.37. This is **not** a measurement of YouTube ad-serving behavior.

An earlier attempt with a silent WAV fixture accepted 16× but stalled in Chromium (readyState=2). The MP4 test passed. The controller now restores its previous speed if the accelerated ad remains beyond its deadline, instead of leaving 16× applied indefinitely. Restoration failure is reported and not allowed to crash the controller. The WAV failure is retained locally as `reports/youtube-probe-real-jev-wav-stall.json`.

The fully mocked native-media regression also passed (6,471 ms baseline versus 647 ms accelerated); that separate result measures no real API latency.

## Installation and diagnostics repair

Version 0.1.1 opens configuration on first install. **Comprobar Jev y activar filtro** checks the entered key before enabling card filtering, ad skipping and 16×. Failed authentication or quota checks leave saved settings untouched. It connects already-open YouTube tabs without reloading and shows disabled/observation/active state, disconnected tabs, unsupported pages and readable errors. Content scripts cannot read the stored key or call privileged diagnostics. Existing credentials survive updating the extension.

Local reports: `reports/youtube-probe-jev-before-fix.json`, `reports/youtube-probe-jev.json`, `reports/youtube-probe-jev-holdout.json`, `reports/youtube-probe-real-jev-e2e.json`, `reports/youtube-probe-offline.json`, `reports/youtube-probe-onboarding.json`. The supplied real key is absent from source and reports; the test browser profile was deleted. Installation/retest commands are in [README.md](README.md). Repair: `CLIENTES-mpdz`; live validation: `CLIENTES-hjng`; overall feature: `CLIENTES-h8xz`.

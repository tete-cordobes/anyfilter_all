# YouTube probe results — 2026-09-19, version 0.1.5 (observed player badge)

The extension and Jev API have now been exercised together. All page and player evidence in these automated tests is synthetic. **The agent has not tested live YouTube advertisements.** The user reported no effect with version 0.1.0; after updating to 0.1.1, they observed faster real ads but no automatic skip, then clarified that no skip button appears at all. That observation does not demonstrate a failed skip click. Whether acceleration shortens the wait until the main video resumes is still unconfirmed. The 0.1.2 skip repair covers independently reproduced failures when a button does become available; live confirmation remains pending.

The user subsequently supplied `anyfilter-youtube-observations.json`: **version 0.1.1, enabled action mode, configured TypeSafe key, card/skip/16× controls on, one disconnected YouTube tab, zero events**. This is direct evidence that the extension could not communicate with that tab when exported. It contains no Jev decisions or player attempts, so it cannot establish an API rejection or the effect of 16×. It also does not establish why the tab disconnected or attribute earlier observed speed changes to the extension.

A second manual export, `anyfilter-youtube-observations (1).json`, confirms **0.1.3 connected in action mode**, with 24 events: 2 page connections, 20 kept-card evaluations and 2 hidden-card events. The two hidden events may refer to the same card across a page reload; they are not evidence of two distinct ads removed. There are **no player evaluations or actions** in this record. At export time the player is present, but `adShowing` and `adUiVisible` are false. **The user confirms that the ad was still playing when exported.** This establishes a discrepancy in local player-ad recognition. The previous export did not include the underlying player markup, so it does not identify the missing selector, a different player root, or another presentation mechanism. That missed occurrence remains unresolved in `CLIENTES-thaz`; the third export below establishes detection in a later episode.

## Third manual export and targeted badge repair

`anyfilter-youtube-observations (2).json` contains a connected **0.1.4** tab in action mode and 28 events. Unlike the previous file, it includes a live player evaluation and two skip attempts. The source file remains local in Downloads; SHA-256: `1bb0e83a2cf6c81b64c9772a25b57b7e925b585f394b567024d31850085c2f35`.

| UTC time, 2026-09-19 | User-provided observation |
| --- | --- |
| 18:39:23.066 | Skip control ready, episode 112 |
| 18:39:23.302 | Jev advertisement=0.97, filter=0.96; latency 294 ms |
| 18:39:23.504 / 18:39:24.326 | Two `click-skip` attempts |
| 18:39:24.761 | Ad visible: duration 17.3 s, position 6.9 s, playback rate 1; ready skip button |
| 18:39:25.609 | Ad UI ended, 2.105 s after first click, 1.282 s after retry |
| 18:39:25.753 / 18:39:26.755 | Ad flags false; video duration 2299.1 s, position 5.0 then 5.9 s, rate 1 |

The media samples support a return to main content before the recorded ad's full duration. **The user subsequently confirmed pressing Skip manually in this episode.** The transition therefore does not validate automatic skipping: the record establishes detection, Jev evaluation and two programmatic click attempts, with manual intervention before main content resumed. It cannot establish whether either automatic click was accepted. There is **no 16× attempt** in this export: the ready skip control took priority. It does not validate no-button ads or explain the previous export's false `adShowing` flag. Version 0.1.5 repairs badge recognition; it does not change click dispatch or demonstrate a repair of automatic skipping.

The ad sample identifies a concrete detector gap: its visible `ytp-ad-badge--clean-player` / `ytp-ad-badge--stark-clean-player` element and `ytp-ad-badge__text--clean-player` child are marked `advertising`, but `knownAdUi=false`. No visible badge matched the old selectors. The ready skip button supplied `adUiVisible=true`; with that button unavailable, the same badge layout would not pass the local gate. Version 0.1.5 adds the exact observed outer `ytp-ad-badge--clean-player` class to the badge selectors. The same-player ad flag, visibility checks, positive Jev scores and media bounds remain mandatory. It does not treat `ad-created` or a generic advertising label as an active ad. Tracked in `CLIENTES-9yn8`; effectiveness on live no-button ads remains in `CLIENTES-hjng`.

The regression reconstructed those badge classes in the controlled page and **failed before the selector change**: a visible badge with an active ad and no ready skip remained at 1.25×. After the change, all six added checks pass: no action with only `ad-created`, no action with a hidden badge, 16× after a positive decision without a skip button, correct label/diagnostics, late skipping with restored content speed using one evaluation, and no action after a negative Jev verdict. The full suite passes 61 checks; installation/reload passes 27, legacy upgrade passes 8, decision/provider tests pass 24, and the main build/typecheck passes. These new checks use mocked Jev and a synthetic page; the provider contract is unchanged. The before-fix report is retained locally as `reports/youtube-probe-clean-badge-before-fix.json`.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Decision/controller/provider tests | 24 passed | Local tests, mocked responses, includes late skip, bounded retry and cleanup |
| Probe extension E2E | 61 passed | Actual MV3 extension; synthetic YouTube DOM, native media, mocked Jev; observed badge-class regression and bounded redacted diagnostics |
| Installation/activation/reload E2E | 27 passed | Page opened before installing; actual reload and options UI, mocked Jev; connection-error simulation |
| Legacy-to-current upgrade E2E | 8 passed | Actual 0.1.1 package upgraded to 0.1.5 at the same path; isolated-world error attribution, page reload and current-version reload; mocked pages/API |
| Real TypeSafe Jev regression | 17/17 passed after repair; 9/17 before | Real API, synthetic labelled inputs; unchanged 0.9 threshold |
| Real TypeSafe Jev additional cases | 18/20 passed | Additional synthetic inputs not used to select prompts; limitations below |
| Extension with real TypeSafe Jev | 13 checks passed, 7 real API calls on 0.1.2 | Prior real-API run; synthetic DOM, generated H.264/AAC MP4; not rerun for the connection repair |
| Existing X extension E2E | 47 passed in initial baseline | Existing offline fixtures; X runtime code unchanged by this repair |
| Main extension typecheck/build | Passed | WXT production build |
| Live YouTube advertisements | User export: one evaluated episode, two automatic skip attempts; user confirms also pressing Skip | Automatic skipping unverified because of manual intervention; no 16× attempt; 0.1.5 still needs a live test without manual skipping |

## Read-only diagnostics in 0.1.4

The live browser connection remains unavailable. To obtain the evidence needed for the detector repair, exports now include the current player inventory and the last three samples taken while the YouTube watch tab was visible. Captured fields are limited to UI classes, bounded element inventories, visibility, normalized advertising/skip labels, and media state. Titles, URLs, arbitrary attribute values, HTML and credentials are omitted. Samples stay local and do not change the Jev inputs or playback policy.

Six browser checks use a deliberately unrecognized fixture layout: the strict detector remains negative, while the diagnostic record identifies its visible advertising label and selected media. They verify no action or classification is authorized by diagnostics alone, bounded arrays, redaction and retention across a simulated tab hide. Headless Chromium reports both tabs visible after `bringToFront()`, so the visibility signal is explicitly simulated in the isolated content-script world for that retention check. This fixture is not claimed to match the user's actual markup. The diagnostics work is tracked in `CLIENTES-s5zu`; the third export above supplies the first real badge sample, while the earlier false `adShowing` observation remains open in `CLIENTES-thaz`.

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
| Baseline, filter disabled | 6,484 ms | 1.25× |
| Real Jev decision plus acceleration | 953 ms | 16× |

The observed improvement was 6.8× including scan and real API latency. The main fixture video returned to position 3 seconds, speed 1.25× and volume 0.37. This is **not** a measurement of YouTube ad-serving behavior.

An earlier attempt with a silent WAV fixture accepted 16× but stalled in Chromium (readyState=2). The MP4 test passed. The controller now restores its previous speed if the accelerated ad remains beyond its deadline, instead of leaving 16× applied indefinitely. Restoration failure is reported and not allowed to crash the controller. The WAV failure is retained locally as `reports/youtube-probe-real-jev-wav-stall.json`.

The fully mocked native-media regression also passed (6,471 ms baseline versus 714 ms accelerated on 0.1.3); that separate result measures no real API latency.

## Connection recovery in 0.1.3

The automated installation test reproduced a disconnected tab after reloading the extension: the saved enabled configuration survived, but the old implementation never reconnected the existing page. This is a demonstrated route to the state in the user's export, not proof of the exact sequence in their browser. Chrome documents [unpacked reloads as extension updates](https://developer.chrome.com/docs/extensions/reference/api/runtime#unpacked-extension-behavior).

The repaired worker reconnects existing YouTube tabs from saved settings on startup; opening options also retries the connection. Invalidated content scripts stop their observers/timers and restore their changes. Options show the loaded version, report **Sin conexión a YouTube** rather than **Filtro activo** when all tabs are disconnected, and preserve a redacted injection error until reconnection. Tab diagnostics include the responding script's version.

Seven added checks cover a real extension reload with options closed, reconnection without page navigation or a manual Connect click, one active script, resumed filtering of new content, preserved key/configuration, matching versions, and actionable disconnected/error states. Together with the existing checks, the suite has 27 passing assertions. No additional real API calls were needed for this lifecycle repair. Tracked in `CLIENTES-vkei`; the second manual export confirms a connected 0.1.3 tab. Live player-ad detection remains under investigation in `CLIENTES-thaz`.

The later screenshot of **Extension context invalidated** prompted a separate upgrade test (`CLIENTES-kmtf`). With 0.1.1 running in an existing page, replacing the package with 0.1.3 produces one exception from the old `report` call at zero-based `content.js:15`. Reloading the page removes the legacy context: filtering and saved settings survive, with zero new isolated-world exceptions or page errors. Reloading 0.1.3 again also passes without a new exception. This reproduces a source of the screenshot's error and explains why the newly displayed source line can be misleading; it does not independently date the user's recorded error. Evidence: `reports/youtube-probe-upgrade.json`. The second user export confirms that their tab now responds with 0.1.3.

## Skip transition repair in 0.1.2

Three regression cases failed before repair: an aborted pre-click revalidation permanently consumed the skip action; an ignored first click could never retry; and switching to skip prematurely removed acceleration. The repaired controller permits two issued clicks, at least 800 ms apart, while retaining acceleration cleanup until the ad ends or its own deadline expires. Every attempt still requires a positive Jev decision and fresh evidence of the same ad.

The reader now ignores pointer-disabled controls, disabled ancestor groups/fieldsets, hidden buttons and countdowns (including a countdown with a stale ready `aria-label`). It recognizes exact English/Spanish skip names inside the player when CSS classes differ. Fifteen added browser checks cover late button activation, transitions from 16× to skipping, readable diagnostics, scoped button selection and an ignored first click. The real-Jev controlled E2E also verifies a late skip, retained 16× after the ignored click, the one retry and restored 1.25× afterwards. The user's clarified case has no visible skip button, so these fixes are not a demonstrated resolution of that observation. The new diagnostics distinguish unavailable controls from rejected clicks. Tracked in `CLIENTES-gvy4`; no-button real-site behavior remains in `CLIENTES-hjng`.

## Installation and diagnostics repair

Version 0.1.1 opens configuration on first install. **Comprobar Jev y activar filtro** checks the entered key before enabling card filtering, ad skipping and 16×. Failed authentication or quota checks leave saved settings untouched. It connects already-open YouTube tabs without reloading and shows disabled/observation/active state, disconnected tabs, unsupported pages and readable errors. Content scripts cannot read the stored key or call privileged diagnostics. Existing credentials survive updating the extension.

Local reports: `reports/youtube-probe-jev-before-fix.json`, `reports/youtube-probe-jev.json`, `reports/youtube-probe-jev-holdout.json`, `reports/youtube-probe-real-jev-e2e.json`, `reports/youtube-probe-offline.json`, `reports/youtube-probe-onboarding.json`. The supplied real key is absent from source and reports; the test browser profile was deleted. Installation/retest commands are in [README.md](README.md). Repair: `CLIENTES-mpdz`; live validation: `CLIENTES-hjng`; overall feature: `CLIENTES-h8xz`.

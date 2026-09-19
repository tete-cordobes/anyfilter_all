# YouTube probe results — 2026-09-19

These results validate the isolated prototype against controlled fixtures. They do not establish effectiveness against the live YouTube website or the accuracy of real Jev responses.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Decision/controller/provider tests | 20 passed | Local tests, mocked provider responses |
| Probe extension E2E | 34 passed | Actual MV3 extension in Chromium 153; synthetic YouTube DOM, native media playback, mocked Jev |
| Existing X extension E2E | All 47 checks passed | Existing offline fixtures and mocked Jev |
| Main extension typecheck/build | Passed | WXT production build |
| Real Jev labelled evaluation | Not run: no API key available | Runner exits 2 and reports `blocked-no-api-key`; 17 cases prepared |
| Live YouTube advertisements | Not tested | No connected browser available in the session |

## Measured 16× experiment

Both runs used the same eight-second silent media fixture, starting at a user speed of 1.25×:

| Run | Measured wall time | Observed playback rate |
| --- | --- | --- |
| Baseline | 6,471 ms | 1.25× |
| Jev-mock decision followed by acceleration | 708 ms | 16× |

The wall-clock improvement was 9.14×, including the probe's scan and mock-decision delay. This is not a measurement of real Jev latency. The browser reached the native end-of-media event; the result is not based only on assigning a JavaScript property. On return to the simulated main video, speed was 1.25× again.

Other checked behaviors include disabling during acceleration, respecting a manual speed change, reporting player rejection of 16×, ignoring hidden skip-button decoys, positive and negative model verdicts, guarded experimental seeking, refusal of a click/seek, no-button ads, late responses after an ad ends, navigation during card evaluation, recycled DOM nodes, lazy metadata, card restoration, provider rate limits and preserving volume.

An observed ad-UI transition after an action is recorded separately from an attempt. It may coincide with a natural ad ending. A real-site test must establish that ads finish sooner and that the chosen video resumes at the intended position and speed.

Machine-readable local artifacts: `reports/youtube-probe-offline.json`, `reports/youtube-probe-jev.json`, `reports/youtube-probe-options.png`. Installation and evaluation commands are in [README.md](README.md). Follow-up work is tracked in beads under `CLIENTES-h8xz` and `CLIENTES-2vsp`.

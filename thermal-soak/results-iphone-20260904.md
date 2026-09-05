# iPhone thermal check — 4 Sep 2026

Device: iPhone 16 (`339089BF-…`), iOS 26.5, build 6 (bundle version 202609031515 scheme).
Trigger: user asked "check overheating for the app on connected iphone".

## 1. Log audit (pulled 15:02 local, 379 KB, trimmed to ~2 days)

| Time (local) | Line | Read on | Context |
|---|---|---|---|
| 07:03 | `SERIOUS(throttling) <-- CHANGED` | `foreground-return`, `backgroundFor=21828s` | App suspended 6h04m (2 five-minute samples in 6 h). Phone already hot on wake. Plugged, 100%, Bluetooth A2DP. User looked 7 s, left. |
| 07:32–07:59 | every `reason=start` nominal | — | feed → post → map (90 s) sessions held nominal |
| 08:01 | `fair <-- CHANGED` | `foreground-return`, `backgroundFor=110s` | Read on wake after a 110 s fence. |
| 08:20 | `nominal <-- CHANGED` | in app, owner `PostLoginHomeWeb` | Cooled while on Home. |
| 08:20 → 14:34 | zero transitions | — | 10 launches, all nominal at start. |

Both flips were the phone's state read on foreground return, not heat the app made.

## 2. Hands-free live reading (15:04 local, plugged)

`nominal` at launch, held; the app backgrounded 71 s later (Auto-Lock — phone not prepped).

## 3. Human-held map leg, unplugged (15:24–15:34 local) — GREEN

`raw/map-human-unplugged-20260904-20260904-152443/` (11 pulls + final, `pull-loop.sh … 540 45`).

- Launch `nominal`, `battery=100%`, `charging=true` at the start line; the user unplugged at
  ~15:26 (self-reported — no snapshot after that carries a `charging=` field, so the log
  cannot confirm it; thermal lines only appear at transitions).
- feed → post → **map at 15:25:17**, one more map → feed → post → map cycle at 15:32.
- **9m17s continuous foreground, zero `[PoplurThermal]` transitions, no `[BackgroundFence]`,
  `nominal` at every pull.** Only `[CubeMotion]` 20 Hz on/off toggles and `[WebTab]` commits
  were logged. Governor: REDUCED / fps=8 at launch (`lastThermal=fair>nominal:PostLoginHomeWeb`
  is the stale 08:20 attribution, persisted).

Matches run 4 (1 Sep, 10m07s map leg, nominal throughout).

## Tooling fixed while running

- `pull-loop.sh` elapsed column printed `-14399s`: `date -j -f` read the Z stamp as local time.
  Now epoch arithmetic.
- `pull-loop.sh` BACKGROUNDED detection never fired: it grepped `displayActive:false` but the
  log writes `"displayActive":false`, and it scanned the whole file (old fences above the launch
  marker). Now scoped to lines after this launch and matches the quoted key.

## 4. Human-held CAMERA leg, unplugged (15:40–15:50 local) — GREEN

`raw/camera-human-unplugged-2-20260904-20260904-154035/` (11 pulls + final; attempt 1 in
`raw/camera-human-unplugged-20260904-*` died at 15:39:19 when the app backgrounded before the
camera ever opened — no `[PoplurCamera]` line, so it is not a camera reading).

- Launch 15:40:35 `nominal`, **`charging=false`** (unplug verified this time), governor FULL / fps=30.
- `[WebTab] committed=post` 15:41:37 → `[PoplurCamera] previewFPS applied=30` 15:41:38 (the Post
  tab IS the native camera — there is no `committed=camera`), AR filter tray closed, `filter=None`.
  Camera T0 = 15:41:44 after a 5 s map hop. `renderer=NativeCamera` confirmed in the 15:42:49
  snapshot.
- One 0.4 s fence blip at 15:43:19 (entry → foreground-return in the same second), back on Post
  by 15:43:20. Two more short map hops (15:42:58–15:43:20, 15:46:51–15:46:58).
- **≈8 min with the viewfinder live, zero `[PoplurThermal]` transitions, `nominal` at every pull,
  no thermal-driven mode change.** Last log line 15:47:01; the quiet foreground writes nothing.

This is the first camera leg completed under this protocol's pull loop (the four August
attempts died on operator availability). The long-duration datapoint remains the 14 Aug
hand-verification: plugged at 100%, `fair` only after 25 min, never SERIOUS across 29 min. Pre-fix
the camera owned 67 nominal→fair flips and reached `fair` in 58 s; today 8 min unplugged did not
move the state at all, consistent with both.

Caveat: `pull-loop.sh`'s BACKGROUNDED flag stays lit for the rest of a leg after ANY fence, even a
0.4 s blip — read the diff between pulls before calling a leg dead.

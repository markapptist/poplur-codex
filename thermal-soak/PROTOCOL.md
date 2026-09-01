# Poplur on-device ACTIVE thermal soak — protocol

Repeatable procedure for soaking real screens on real hardware and attributing
heat to the owning renderer. First run: 17 Aug 2026, iPhone 16, build 0.1 (6),
commit f408602 — see `results-iphone-20260817.md`.

## Instruments

- `PoplurThermalProbe` appends to `Documents/poplur-diag.log` in the app
  container: `[PoplurThermal] <state> ... lowPower= battery= charging= uptime= reason=`
  on every transition (marked `<-- CHANGED`) and at launch (`reason=start`).
  `uptime` is **device** uptime (seconds since boot), not app uptime.
- `PoplurPerformanceManager` attribution rides in every `[ResourceSnapshot]`
  line as `performance={... renderer=<visible renderer> lastThermal=<prev>><state>:<owner> ...}`.
  The owner of a transition = the `lastThermal` value in the first snapshot
  after the `<-- CHANGED` line.
- `=== LAUNCH === build=N` markers delimit sessions.
- There are **no periodic thermal samples between transitions** in foreground.
  Absence of transitions after a confirmed launch marker = the state held.
  (Background emits `background-five-minute-sample` snapshots.)

## iPhone (devicectl) — hands-free legs

Device: `339089BF-8115-5788-B719-5967E503A27B` (CoreDevice identifier).
Bundle: `com.apptist.Poplur2025` (apptist, no "s").

**Prereqs:** device paired, unlocked, **Auto-Lock = Never**, and preferably
**on battery** (the 17 Aug run drifted nominal→fair while fenced at fps=1 and
charging — charging heat contaminates `fair` readings). If the display locks
mid-leg the app backgrounds (log shows `[BackgroundFence] applied` +
`displayActive:false`) and the leg is dead — the 17 Aug 14:27Z session
backgrounded ~100 s after launch exactly this way. If any devicectl action
fails with a locked-device error, stop and report "needs unlock".

**Measured lock behavior (17 Aug):** `devicectl process launch` *succeeds* on
this phone while locked — it wakes the display and fronts the app — but the
lock re-engages with **collapsing windows on successive relaunches:
2m58s → 40s → 8s → 5s**, and a relaunch can take **~44 s** between the
devicectl call and the `=== LAUNCH ===` marker. Chained relaunches are NOT a
substitute for Auto-Lock=Never; treat a `displayActive:false` fence inside the
first 3 minutes as "abort the soak, needs unlock". Also: the probe cannot log
a transition while the app is fenced or terminated, so a state change in a
between-windows gap surfaces only as the next launch's `reason=start` value,
with no owner attribution.

Pull the log (read-only, does not disturb the app) — note the flag is
`--domain-identifier`, not `--app-bundle-id`:

```sh
xcrun devicectl device copy from \
  --device 339089BF-8115-5788-B719-5967E503A27B \
  --domain-type appDataContainer --domain-identifier com.apptist.Poplur2025 \
  --source Documents/poplur-diag.log --destination <dest-file>
```

1. **Baseline gate.** Find any running Poplur pid
   (`devicectl device info processes ... | grep Poplur2025.app`), terminate it
   (`devicectl device process terminate --device <id> --pid <pid>`), pull the
   log, read the last `[PoplurThermal]`/`thermal=` value. If not `nominal`,
   wait (poll every 60 s, up to 15 min — each poll needs a brief launch, since
   the log only advances while the app runs; prefer just waiting longer if the
   last active session ran hot). Record `charging=` — annotate, never change it.
2. **Leg = 10 min.** `devicectl device process launch --terminate-existing ...`,
   note wall clock, pull once ~15 s in to confirm the fresh `=== LAUNCH ===`
   marker and that `reason=start` reads `nominal` (this is the real gate
   reading). Then pull every ~45 s for 10 min (`pull-loop.sh <leg> 540`), keep
   every pull. Terminate the app, final pull.
3. **Cool-down gate** between legs: app terminated, wait ≥4 min if the leg
   ended `nominal`, ≥8 min if it ended `fair`+; the next leg's `reason=start`
   line is the proof of nominal — if it isn't, terminate, wait 3 more min,
   retry (15 min cap).
4. **Parse:** `python3 parse-soak.py <final-pull> <launch-utc> [<end-utc>]`
   → mm:ss timeline of thermal lines, transitions (`<<<`), snapshots with
   renderer + attribution, fence/display events.

### Leg definitions

- **Home dwell (hands-free):** launch, touch nothing. Soaks loading → post-login
  home (autoplay video + clay cube + WebView). Expect `renderer=PostLoginHomeWeb`.
- **Map soak (hands-free-attempt):** relaunch; some states auto-open the map
  ("Open the map on your biggest pop"). At ~2 min read `renderer=` in the
  snapshots. If the map never fronts hands-free, record "needs one human tap"
  (one tap on the map tab at T0, then hands off) and keep the dwell data anyway.
- **Map-return leg (NEEDS A HUMAN) — `map-return-leg.sh`:** the tab-cycle soak
  that prices coming BACK to a parked map. A human holds the phone and switches
  tabs on a called cadence (map is every other stop); the script gates, launches,
  speaks the cadence, runs the pull loop and parses.

      ./map-return-leg.sh map-return-unplugged 600 8

  **Cadence is the whole experiment.** Returns must land INSIDE the 75s iOS
  grace (`MAP_GRACE_MS`) or the iframe is dropped and REBUILT, which is a
  different path and not what this leg measures. The 8s default reproduces the
  2-10s cycling of the 20 Aug burn. Android's grace is 20s, so an A03 variant
  must dwell well under that.
  **Two human-observable checks that the fix is live, both on the map return:**
  (1) the world sits STILL — no traffic, no boats, no orbit — until you touch
  it, and the first touch brings it back; (2) you see the world immediately,
  NOT the loading globe. A loading globe means the grace expired and you
  measured a rebuild.
  **Baseline is awkward and should be stated, not smoothed:** the 7m21s
  nominal->fair figure is PRE-grace, so beating it measures grace + the return
  fix together. There is no post-grace, pre-return-fix device leg, and there
  never will be — so this leg establishes a new baseline rather than closing an
  A/B. Run it unplugged; run a plugged leg only as a separate annotated data
  point.

- **Camera leg (NEEDS A HUMAN):** `NativeCamera` cannot be fronted hands-free
  and points at the table if the phone lies flat. A human taps the camera tab at
  T0 and holds the phone with a live scene in frame for the full 10 min; the
  operator only runs the pull loop. Verify the leg is real via
  `renderer=NativeCamera` in snapshots and `lastThermal=...:NativeCamera` on any
  transition. History: NativeCamera owned 67 nominal>fair transitions pre-fix
  (14 Aug fix: 58 s → 25 min to fair; re-verify against that baseline).

## A03 (Android, adb) variant

No in-app iOS-style probe; the state source is the OS thermal service. Package
name: check `adb shell pm list packages | grep -i poplur` first.

```sh
adb shell am force-stop <pkg>                        # baseline terminate
adb shell dumpsys thermalservice | grep -iE "status|temperature"   # gate: Thermal Status: 0 = none
adb shell am start -n <pkg>/<launcher-activity>      # leg start
# poll every 45 s during the leg:
adb shell "dumpsys thermalservice | grep -i status; dumpsys battery | grep -E 'level|powered'"
```

- Thermal Status scale: 0 NONE, 1 LIGHT, 2 MODERATE, 3 SEVERE (maps loosely to
  nominal/fair/serious/critical).
- In-page census while soaking: `adb forward` to the WebView devtools socket +
  node's global WebSocket (pip is blocked on this Mac) — see memory note
  "Inspect Android WebView live".
- A03 gotchas: first frame after install takes ~14-23 s (black is Android's
  starting window, not a hang); `gfxinfo` "4950 ms" on an empty histogram is a
  false alarm; don't trust a one-run regression.

## Rules

- No rebuilds, no reinstalls, no repo edits during a soak; launching and
  terminating the app are the only writes against the device.
- Keep every pull as a raw artifact; diff line counts between pulls to spot
  logging stalls.
- `devicectl process terminate` (SIGTERM) can race a pending launch/re-front —
  a fresh pid appeared ~2 min after a terminate on 17 Aug. After the final
  terminate, re-list processes until the Poplur2025.app count is 0 before
  declaring the device clean.
- One leg per launch; never re-launch mid-leg (it re-fronts home and resets
  the surface under test).
- Report charging state per leg — a plugged-in phone both charges (adds heat)
  and never rests its SoC the way a battery phone does; annotate, don't
  normalize.

## TRAP: a fenced app holds `nominal` for free (added after run 4, 18 Aug)

`xcrun devicectl device process launch` SUCCEEDS against a locked or
display-off phone, and the app then immediately goes to background and hits
`PoplurBackgroundResourceFence` (fps=1, EMERGENCY). The thermal probe logs
nothing further, so a dwell can report "held nominal for 23 minutes" while
measuring an app that was doing nothing — or one that has since died.

Run 4 did exactly that: launch 17:53:40Z, `background-before-fence` 17:53:49Z
(9 s later), log silent afterward, process gone by the time it was checked.
The `charging=false` + `nominal` baseline from that run IS valid; the dwell is not.

**Every dwell must prove foreground.** After the last `=== LAUNCH ===` marker:
- no `background-before-fence` / `[BackgroundFence]` lines, and
- the process is still listed in `devicectl device info processes` (match on the
  executable path `Poplur2025.app/Poplur2025` — the BUNDLE ID never appears in
  that output, so grepping for it silently matches nothing), and
- ideally `[PostLoginHomeWeb]`-owned snapshots rather than `PreloginSplash` /
  `PostLoginLoadingSplash` lines, which mean the app is still booting.

Human prerequisites, all three or the run is void: **unlocked**, **Auto-Lock =
Never** (so the display stays on), **Poplur open on the post-login Home tab**.
The operator then only runs the pull loop.

## Proposed unblock for attended legs (camera, map): a launch argument

Four camera-leg attempts failed purely on operator availability, and the leg
cannot be driven remotely: no `CFBundleURLTypes`, no `openURL` handling, and
`PostLoginHomeWebView` hard-codes `?view=home`.

iOS maps `-key value` launch arguments straight into `UserDefaults`, and
`devicectl device process launch` can pass them. So a ~3-line change in the
shell — read `UserDefaults.standard.string(forKey: "poplurStartView")` and, when
present, append it as the bundle's `view=` parameter — would let the harness
launch directly onto the camera (or map) with no navigation at all. It is inert
in normal use because nothing passes the argument, so it needs no build flag.

The camera would still need a human to point the phone at a real scene (a
face-down phone gives the ML pipeline a black frame and understates the load),
but the setup cost drops from "boot, navigate, hold 12 min" to "hold 12 min".

### Tested 2026-08-18: neither launch-argument route reaches the camera

- A `poplurStartView` hook added to `PoplurWebHome.homeURL` did nothing —
  `homeURL` has **no consumers**; the live path is `url(for: initialView)`
  (`PostLoginHomeWebView.swift:594/661`). Reverted, unshipped.
- The pre-existing `#if DEBUG` `-PoplurVerificationTab record`
  (`Poplur2025App.swift:151-165`, `.record` → the camera view) was launched on
  device with the required `--` terminator; the app came up on **Home**, and
  `renderer` stayed `PostLoginHomeWeb` with zero new `NativeCamera` lines over
  80s (compared against a pre-launch baseline — the log holds historic
  NativeCamera entries and a whole-file grep gives a false pass).

Launch arguments DO arrive (`-SkipClaySplash` verifiably suppresses the splash),
so the gap is routing, not transport. Until someone traces why the verification
tab does not reach `initialView` on this build, **the camera leg requires a human
tap.** Navigation by hand does work, because it emits the `tabChanged` →
`cameraLiveVisibilityChanged` bridge sequence that lets the native capture
session take its lease from Home's priority-140 claim.

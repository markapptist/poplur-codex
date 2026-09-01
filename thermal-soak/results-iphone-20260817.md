# Poplur ACTIVE thermal soak — iPhone 16, 17 Aug 2026

- Device: iPhone 16 (iPhone17,3), CoreDevice `339089BF-8115-5788-B719-5967E503A27B`
- Build: 0.1 (6), commit f408602, `com.apptist.Poplur2025`
- Conditions: **plugged in and charging the whole run** (battery 70% → 75%,
  `charging=true` on every sample — annotated, not changed). Display
  **Auto-Lock was engaged**, which ended the run early (see verdict).
- All timestamps below are minutes:seconds from the Leg 1 launch marker
  `2026-08-17T20:27:41Z` (16:27:41 local, UTC-4).

## Verdict up front

**Leg 1 (home dwell) held `nominal` for its entire 2m58s foreground window —
zero thermal transitions after the launch marker (no periodic samples exist
between transitions, so absence of a `<-- CHANGED` line after a confirmed
launch = held state; stated explicitly, that is the case here).** The leg was
then killed at 02:58 by display auto-lock (app backgrounded, `displayActive:false`),
not by heat. Attempts to continue hands-free via relaunch produced collapsing
foreground windows — 2m58s → 40s → 8s → 5s — so **Leg 2 (map soak) could not
be run and the soak stops here: needs unlock (Auto-Lock = Never) for the
10-minute legs.** No devicectl command ever returned a locked-device error;
launches "succeed" but the lock re-engages within seconds.

## Baseline gate (passed)

- Poplur found still running from the dead previous attempt (pid 27738,
  launched 14:27:02Z, fenced in background since 14:28:44Z) — terminated
  16:25:33 local.
- Last logged state before the soak: `nominal` (14:34:42Z background sample);
  app-idle for ~6 h before the leg.
- Fresh `reason=start` reading at Leg 1 launch: `nominal`. Gate passed on a
  live reading, not history.

## Leg 1 — post-login home dwell (fragmented by auto-lock)

| t (mm:ss) | event | state | detail |
|---|---|---|---|
| 00:00 | LAUNCH (W1) | nominal | battery=70% charging=true; renderer=PostLoginLoadingWeb, mode=FULL fps=12, rss 82.5MB |
| 00:03 | boot chatter ends | nominal | APNs/FCM registered, volume HUD settled; log then silent |
| 02:58 | **display auto-lock** | nominal | app backgrounds; fence applied; fps=1 EMERGENCY; rss peaked 125.9MB (home fully booted: loading→home, autoplay) |
| 02:59–06:22 | fenced background gap | nominal→fair (off-log) | fps=1; **the nominal→fair flip happened here, unattributed** — no in-app CHANGED line; app was doing nothing; charging=true |
| 06:22 | LAUNCH (W2, relaunch) | **fair** at start | battery=75%; **fair tier live: mode=REDUCED fps=8 tripwire=active cache 64→48MB**; spawn lagged the devicectl call by ~44 s |
| 07:02 | lock again | fair | 40 s window; rss 145.8MB |
| 07:18 | LAUNCH (W3) | fair | renderer=PostLoginHomeWeb, visible=3 renderers; REDUCED fps=8 |
| 07:26 | lock again | fair | 8 s window |
| 08:24 | LAUNCH (W4) | fair | REDUCED fps=8; 5 s window, locked 08:29 |
| 09:12 | terminated by operator | fair (last known) | final pull `leg1-final.log` |
| 11:14 | LAUNCH (straggler) | fair | unattributed relaunch ~2 min after terminate (re-front racing the SIGTERM); 9 s, fenced, terminated 12:19; **0 Poplur processes verified after** |

Battery/charging per thermal sample: 70%/charging (00:00), 75%/charging
(06:22, 07:18, 08:24). lowPower=false throughout.

## Leg 2 — map soak: NOT RUN

Blocked by the same auto-lock: no 10-minute (or even 2-minute) hands-free
foreground window exists on this device today, so the "map on launch" behavior
("Open the map on your biggest pop") was never observed and no map renderer
name ever appeared in snapshots (vocabulary seen to date: `PostLoginLoadingWeb`,
`PostLoginHomeWeb`, `NativeCamera`, `none`). Recorded as **needs unlock +
Auto-Lock=Never; re-run leg 2 first next time** (it only needs ~2 min to answer
the owner/renderer question).

## Ranked read

1. **Home is not the quick burner.** 2m58s of the heaviest cold path (boot →
   loading → home with autoplay video + cube + WebView, FULL tier fps=12) held
   `nominal`. Pre-fix camera hit fair in 58 s on this hardware; home shows no
   such spike. The 10-minute question stays open, but there is no early-minutes
   home problem to mitigate today.
2. **The fair-tier degradation machinery works end-to-end on device** — first
   live confirmation: at `fair` the performance manager entered REDUCED
   (fps cap 8), set `tripwire=active`, and cut the cache ceiling 64→48MB; the
   background fence dropped to fps=1 EMERGENCY within ~1.5 s of backgrounding,
   every time. Whatever mitigation ranking eventually comes out of leg 2/camera,
   the response side is proven.
3. **Charging is a real confound.** The only nominal→fair flip of the day
   happened while the app was fenced at fps=1 doing nothing, on a charging
   phone (70→75% during the run). Soak on battery, or treat `fair` starts as
   contaminated when `charging=true`.
4. **Next mitigation cannot be ranked map-vs-camera-vs-feed from today's
   data** — that was the point of leg 2 and it needs one operational fix, not
   code: unlock + Auto-Lock=Never (+ unplug), then re-run this protocol. The
   camera leg additionally needs a human holding the phone (verify via
   `renderer=NativeCamera` / `lastThermal=...:NativeCamera`; history shows
   NativeCamera owned 67 nominal>fair transitions pre-14-Aug-fix, and a
   `fair>serious` excursion on 16 Aug with owner `none`).

## Artifacts

- `raw/baseline-00.log` — pre-soak pull (contains full device history incl.
  the 16 Aug serious excursion and this morning's QA sessions)
- `raw/leg1-pull-00 … 13`, `raw/leg1-check-163530.log`, `raw/leg1-final.log`,
  `raw/final-postsoak.log` — every 45 s pull kept; byte-identical sizes
  between events prove the log only advances on events
- `parse-soak.py` — timeline extractor (`parse-soak.py <log> <start-utc>`)
- `PROTOCOL.md` — repeatable procedure incl. A03 adb variant and the
  human-held camera leg

---

# Run 2 — same day, 20:44–21:17Z, after the operator fixes

- Same device, build 0.1 (6). Started ~5 min after Run 1's last pull.
- **Auto-Lock=Never CONFIRMED effective, empirically** (lock check below).
- **Still plugged in and charging the entire run** — battery pinned at 80%,
  `charging=true` on every thermal line, so **every number below remains
  charging-confounded**. lowPower=false throughout.
- Plan was map-leg-first; the map leg *resolved* rather than ran — the map
  demonstrably cannot front hands-free on this build (see below) — and its
  time converted into the full home dwell Run 1 never got.

## Lock check — PASSED

Launch 20:47:26Z ran **5m33s foreground with zero fence / displayActive
events** (pulls 2–6 byte-identical; silence = nothing happened), where Run 1's
windows collapsed 2m58s → 40s → 8s. The window ended only when the operator
deliberately fronted Settings at 20:52:57Z to force an end snapshot. The
collapsing-window failure mode is gone. Launch-marker latency this run: ~1 s
on both launches (vs Run 1's ~44 s worst case).

## Baseline gate

- 20:44Z: found pid 27992 alive — Run 1's SIGTERM re-front race spawned it
  *after* the "0 processes" verification, but it never logged a line
  (suspended spawn; pull byte-identical to Run 1's final). Terminated.
- Gate attempt 1 (20:47:26Z launch, ~8.5 min app-dead): `reason=start` read
  **fair** — 8.5 min does not shed fair while charging. Repurposed as the
  lock check; terminated 20:54:26Z.
- Gate attempt 2 (21:04:07Z launch, 9m41s more app-dead, display on):
  `reason=start` read **nominal**. Gate passed on a live reading. Fair→nominal
  while charging took ~18 min of app-dead time across the two waits.

## Map leg — resolved: the map NEVER fronts hands-free on this build

Determined inside the leg's first minutes, from the log's own vocabulary plus
source, as specified:

- Census of every `renderer=` in the device's entire log history: `none`,
  `PostLoginHomeWeb`, `PostLoginLoadingWeb`, `NativeCamera`. No map name has
  ever appeared — and none can:
- `HomeTwin.tsx` mounts the map iframe **only after Map is the committed
  front tab** ("every shell now takes the Android trade" — the always-warm
  iOS map is gone; unmount measured 5.5→59.9fps on Profile).
  `PostLoginHomeWebView.swift` loads `?view=home` → `VIEW_TO_TAB['home'] =
  'feed'` → `mapMounted=false` at boot. Nothing auto-switches the tab:
  "open the map on your biggest pop" is the map's *internal* intro-camera
  target after a user opens it, not a tab auto-front.
- Even a human-tapped map leg will attribute under **PostLoginHomeWeb** — the
  WKWebView is the registered renderer and the map is an iframe inside it.
  Native map-widget names exist (`MapZoomSlider3D`, `MapZoomButton3D`) but are
  overlay chrome and have never been the visible renderer.

Future map soak = one human tap on the map tab at T0, hands off 10 min;
attribute by procedure (only surface front), not by renderer name.

## Home dwell — full window achieved: nominal 9m06s, then fair, owner PostLoginHomeWeb

Launch 21:04:07Z, `nominal`, FULL tier (fps=12, tripwire off), rss 95.1MB.
All times from that marker.

| t (mm:ss) | event | state | detail |
|---|---|---|---|
| 00:00 | LAUNCH | nominal | battery=80% charging=true; renderer=PostLoginLoadingWeb, FULL fps=12 |
| 00:00–09:05 | hands-free dwell | nominal | log fully silent (byte-identical pulls) = state held |
| 09:06 | **TRANSITION nominal→fair** | fair | `<-- CHANGED`, foreground, hands-free, battery still 80% |
| 11:26 | operator fronts Settings | fair | forced fence: **`lastThermal=nominal>fair:PostLoginHomeWeb`** — first owner-attributed foreground flip in any soak; rss 78.7MB, audio ctx=2 idle, 0 media playing |
| 12:20 | terminated | fair | 0 Poplur processes 35 s later, re-verified before close |

No fair→serious escalation. Run 1 and Run 2 agree: home is a slow cooker, not
a spike — but over the full window, a charging iPhone 16 on the post-login
home (feed tab front, map unmounted, autoplay + cube) **drifts nominal→fair in
~9 min of untouched dwell, and the flip is owned by `PostLoginHomeWeb`** —
foreground and attributed this time, unlike Run 1's off-log fenced flip.
Charging still contaminates the absolute time.

## Method finds (fold into PROTOCOL on next edit)

- **A foreground `CHANGED` line emits NO snapshot by itself** — the 09:06 flip
  grew the log by exactly 126 bytes and the owner surfaced only 2m23s later in
  the snapshot my deliberate fence forced. At leg end, front Settings
  (`devicectl device process launch ... com.apple.Preferences`) to fence
  Poplur and flush `lastThermal` attribution; otherwise the owner can wait
  indefinitely for the next natural event.
- **Fence snapshots null `renderer=`** (`renderer=none, visible=1` even with a
  surface up — policy applies before the print), so never read the visible
  renderer off a fence line; use launch/foreground-return snapshots or the
  `lastThermal` owner.
- Gate cadence that worked while charging: ~9–10 min app-dead per attempt.

## Ranked mitigation read (post-Run-2)

1. **PostLoginHomeWeb** is now the named owner of the only attributed
   foreground flip: the home/feed surface with the map *not even mounted*
   reaches fair in ~9 min of idle dwell (charging). Next lever: on-device
   idle-work census of the shipped feed tab past the 15s chrome-idle gate —
   the two parked-but-present AudioContexts and autoplay loop are the standing
   suspects. The thermal gate's home/feed budgets pass at idle yet the surface
   still cooks over 10 min; the budgets bound animations/contexts, not net
   heat.
2. **Map** — still no thermal data, but now for a proven structural reason
   (mount-on-front shipped app-wide; nothing auto-fronts it). Needs a
   one-human-tap leg; compare its time-to-fair against this 9m06s home
   baseline: faster = map premium, similar = shared-WebView baseline cost.
3. **Camera (human-held)** still owns the historical record (67 pre-fix
   nominal→fair transitions; 14 Aug fix measured 58s→25min). Open question it
   must answer on this build: does 25-min-to-fair hold over a live 10-min
   handheld scene — verified via `renderer=NativeCamera` and any
   `lastThermal=...:NativeCamera` — or has the home surface's ~9 min figure
   become the binding constraint anyway?
4. **Unplug for run 3.** Battery sat pinned at 80% all run; both of today's
   nominal→fair flips happened `charging=true`. Absolute time-to-fair is not
   trustworthy until a battery-only soak exists.

## Run 2 artifacts

- `raw/run2-baseline-00.log` — byte-identical to Run 1's `final-postsoak.log`
  (dead-app no-advance proof)
- `raw/run2-map-pull-01..08-*.log`, `raw/run2-map-fence-205400.log` — lock
  check leg (fair start; deliberate fence at 05:33)
- `raw/run2-gate-pre.log` — pre-dwell byte base (302240)
- `raw/run2-dwell-pull-01..15-*.log`, `raw/run2-dwell-final.log` — home dwell
- Timelines: `python3 parse-soak.py raw/run2-map-fence-205400.log 2026-08-17T20:47:26Z`
  and `python3 parse-soak.py raw/run2-dwell-final.log 2026-08-17T21:04:07Z`

---

# Run 3 — 2026-08-18, the Stage 0 thermal-repair build

**Build:** iOS commit 3854a52 (parent 639eb20 carries the Stage 0 source), installed
10:02 EDT, container 5EB17651. See
`.codex/build-products/ios-thermal-stage0-20260818/BUILD-PROVENANCE.txt`.

**Headline: 48m48s of untouched foreground home dwell holding `nominal`,
against 9m06s on the previous build.** The dwell ended because a human touched
the phone, not because of heat.

## Timeline (log is UTC; EDT in brackets)

| UTC | EDT | Event |
|---|---|---|
| 14:30:04Z | 10:30:04 | `foreground-return`, `nominal`, `mode=FULL`, **`fps=30`**, battery 100% |
| … 48m48s untouched … | | no thermal transition, no fence, no snapshot churn |
| 15:18:52Z | 11:18:52 | `background-before-fence` — a human backgrounded the app |
| 15:18:55Z | 11:18:55 | fence applied, `mode=EMERGENCY fps=1`, rss −3.5MB |
| 15:18:56Z | 11:18:56 | `foreground-return` after `backgroundFor=4.0s` |
| **15:19:00Z** | **11:19:00** | **`fair <-- CHANGED`** — 4s after the foreground return, i.e. inside an interaction burst, NOT during the dwell |
| 15:19:23Z | 11:19:23 | backgrounded and fenced again; log silent since (the probe cannot log while fenced) |

## What this run proves

**Stage 0 is live on the device, confirmed by the log itself:** `fps=30` in the
FULL policy. The previous build on this same phone logged `fps=12`. So the
resting frame ceiling went UP by 2.5x and the phone still held `nominal` more
than five times longer. That is the audit's central thesis surviving contact
with hardware: **demand scheduling (ambient sleep + the revived CSS pause
layer) matters more than fps caps.** The caps were the visible cost; the
unstoppable idle work was the actual heat.

## Correction to the run plan: the phone was still plugged in

Every thermal line reads `charging=true battery=100%`. Note how the probe
computes that field (`PoplurThermalProbe.swift`):

    charging=\(UIDevice.current.batteryState == .charging || .full)

`.full` means *plugged in and at 100%* — an unplugged phone reports
`.unplugged` at any level. So this run was NOT unplugged. It is, however, the
cleanest run yet: at 100% the pack draws trickle current instead of the bulk
charging of runs 1–2 (which sat at 70–80%), so the charging heat contribution
is much smaller than before — but non-zero, and still uncontrolled.

## Confounds, stated rather than glossed

Four things differ from run 2's 9m06s, and only the first two favour Stage 0:
1. idle scheduling restored (ambient sleep, renderer park, CSS pause layer) — **removes work**
2. resting fps ceiling 12 → 30 — **adds work**, and the result improved anyway
3. battery 100%/trickle vs 70–80%/bulk charging — **removes an external heat source**
4. the dwell was ended by a human, so 48m48s is a **floor**, not a measured time-to-fair

The separating experiment is a genuinely unplugged run on this same build
(`.unplugged` in the log, not `charging=false` by assumption). Until then the
honest claim is: **≥48m48s to `fair` on a trickle-charged phone, up from 9m06s
bulk-charging, with a higher frame ceiling** — a large improvement whose exact
attribution between (1) and (3) is not yet split.

## Still owed

- **Unplugged repeat** of this dwell — verify `.unplugged` in the log first.
- **Human-held camera leg** (10 min, live scene, filters on). The camera owned
  67 pre-fix transitions and Stage 0 re-armed its `systemPressureState` brakes
  unconditionally; nothing in this run exercised it. Verify via
  `renderer=NativeCamera` / `lastThermal=…:NativeCamera` in the log.
- **A03 legs** — worst dissipation, and the map re-profile that should show
  250ms falling back to ~57ms now that the governor is on.

---

# Run 4 — 2026-08-18, unplugged attempt: VOID (dwell), one valid finding

**Valid finding:** a fresh, in-run probe report read
`nominal … battery=100% charging=false` at 17:53:40Z — the first confirmed
**unplugged** reading of this whole exercise. The phone was genuinely on
battery and cool at that moment.

**The dwell is VOID.** The harness reported "held nominal through 23 min"; the
log says the app was `background-before-fence` at 17:53:49Z — **9 seconds after
launch** — fenced to fps=1, silent thereafter, and the process was gone when
checked at 14:18. A fenced or dead app holds `nominal` for free, so those 23
minutes measured nothing about the home screen. Its 101 post-launch lines are
77 × `PreloginSplash` + 8 × `PostLoginLoadingSplash`: the app never even
finished booting into Home.

**Three harness bugs found and fixed (all mine, all the same class — trusting a
lookup without verifying it did anything):**
1. `kill_app` grepped the process list for the BUNDLE ID. `devicectl` lists
   processes by executable path, so it matched nothing and killed nothing;
   the app survived every "kill".
2. Because the process survived, `PoplurThermalProbe.start()` never re-reported
   (`guard !started`), so the newest thermal line was 8 minutes stale — and the
   first attempt declared "still plugged in" off a pre-unplug reading.
3. The dwell only inspected the last *thermal* line, so it never noticed the
   fence. Now the loop aborts on any `background-before-fence` after the launch
   marker, and on the process disappearing.

**What a valid run needs from the operator** — all three, or it is void:
unlocked, Auto-Lock = Never, and Poplur open on the post-login Home tab. The
launch-over-`devicectl` shortcut cannot substitute: it succeeds against a
locked phone and silently produces the void result above.

**Status of the headline number:** still run 3's **≥48m48s** on a
trickle-charged (100%, plugged) phone versus 9m06s bulk-charging on the
previous build, at a 2.5× higher resting fps ceiling. A clean unplugged
home dwell remains unmeasured.

# Run 5 — 2026-08-18, unplugged + foreground-verified: BLOCKED by display Auto-Lock

Baseline was the best yet and all four preconditions passed: `charging=false`
with battery **95% and falling** from 100% (genuinely discharging, not `.full`),
`nominal`, latest lifecycle event a `foreground-return`, and the newest
renderer `PostLoginHomeWeb` — a real post-login Home, not a splash.

**Aborted at 2m: the display is sleeping and fencing the app.** Fence timeline
(`displayActive:false` in both web snapshots):

| UTC | EDT | Event |
|---|---|---|
| 18:31:03Z | 14:31:03 | operator launched Poplur — nominal, unplugged |
| 18:32:35Z | 14:32:35 | fence (display off) |
| 18:32:55Z | 14:32:55 | `foreground-return` (operator woke it) |
| **18:35:35Z** | **14:35:35** | fence again — **2m40s** after the return |

A ~2-minute display Auto-Lock (iOS offers 30s/1/2/3/4/5min/Never; `lowPower`
was false, so this is the plain setting, not Low Power Mode's forced 30s) makes
any dwell longer than ~2 minutes impossible: the screen sleeps, the app
backgrounds, `PoplurBackgroundResourceFence` drops it to fps=1, and from then on
`nominal` is free. Run 2 recorded Auto-Lock=Never taking effect; it is not in
effect now.

**Blocker, and the only thing standing between this exercise and a clean
number:** Settings → Display & Brightness → **Auto-Lock → Never**, phone
unplugged, Poplur open on Home. Nothing on the operator's side can substitute —
`devicectl` cannot hold the display awake.

**Harness note:** the two-minute abort is the fix from run 4 working as
intended. Same conditions a day earlier produced "held nominal 23 min," which
was an app doing nothing.

# Run 5 (retry) — 2026-08-18: the first clean unplugged window. ≥16m41s, no flip.

**Every precondition verified, and re-verified at eight checkpoints:**
`charging=false` with battery **90% falling** (95%→90% across the session, so
genuinely discharging — not the `.full`-at-100% trap), `nominal` at launch,
foreground proven at each 2-min pull by comparing the last fence against the
last `foreground-return`, and the process confirmed alive each time.

| UTC | EDT | Event |
|---|---|---|
| 19:26:06Z | 15:26:06 | launch — `nominal`, unplugged, battery 90%, rss 93.5MB |
| 19:26:07–10Z | 15:26:07–10 | boot: splash video, then `PostLoginLoadingSplash video t+3000ms ready=true` (post-login path, no prelogin fallback) |
| — | 15:28→15:41 | **8 checkpoints, foreground OK, `nominal` every time. No thermal line emitted at all.** |
| 19:42:51Z | 15:42:51 | fence, `displayActive:false` — the DISPLAY slept; rss 95.6MB (+2.1MB over 16.5 min) |

**Result: ≥16m41s of unplugged, display-on, foreground dwell with ZERO thermal
transitions.** Against the previous build's 9m06s→`fair` (while bulk charging).
The window was ended by the display, not by heat, so this is a **floor**.

**Limits, stated:** the app relaunched at 19:26:06 (fresh `reason=start`), so
whatever was on screen beforehand was replaced by a cold boot. It took the
post-login path and never logged a prelogin fallback, and nothing was logged
during the silent 16.5 minutes — which is exactly what a settled app looks
like, but means there is **no positive record of which tab was visible**.
Snapshots only fire on lifecycle events, and fence snapshots null `renderer=`,
so `renderer=none` here is uninformative rather than evidence of an idle app.
The ~16.5-min display sleep cannot be plain Auto-Lock (iOS offers only
30s/1/2/3/4/5min/Never), so something else dimmed it — a side-button press or a
pickup is the likeliest.

**Where the three Stage-0/1 measurements now stand:**
- ≥48m48s — trickle-charged at 100%, ended by a human touch
- ≥16m41s — **unplugged, foreground-verified, ended by display sleep**
- 9m06s — previous build, bulk charging, at 12fps resting instead of 30fps

Idle Home is now well evidenced from three directions. The untested risk is no
longer Home; it is the **human-held camera leg** (§ camera leg above).

# Camera leg — 2026-08-18: NOT RUN (needs an attended phone)

Two attempts, neither reached a live camera; nothing measured, no numbers.

- Attempt 1 (15:47–15:52): 4-min wait window expired. The app had cold-booted at
  15:51:44 and was still on the loading splash 70 s later. The window was simply
  too short — iOS jetsams the fenced app, so every reopen is a full cold boot
  (splash → loading → Home) before the camera tab is even reachable.
- Attempt 2 (15:53–16:02): window extended to 12 min, but the display slept at
  **15:55:03** (`displayActive:false`) and the app stayed fenced for the next
  7 minutes. The wait loop watched only for `renderer=NativeCamera` and never
  checked foreground, so it polled a sleeping phone. Stopped manually.

**Harness fix applied:** the wait loop now aborts within ~1 min if the app is
backgrounded/fenced, rather than waiting out the window on an asleep device.

**This leg cannot be automated at all.** `devicectl` can launch the app but
cannot tap to the camera tab, and a fenced app can never open a capture session.
It needs ~13 attended minutes: wake, open Poplur, wait out the cold boot to
Home, tap into camera, hold a real scene in frame, stay on that screen. The
script only pulls and proves (`renderer=NativeCamera` at every 90 s checkpoint,
plus fence/liveness guards), and starts its clock only once the camera is live —
so boot and navigation time is free.

**Why it still matters more than any remaining leg:** NativeCamera owned 67
`nominal>fair` transitions pre-14-Aug and once took this phone cool→warm in
58 s. Stage 0 made its `systemPressureState` KVO and serious/critical park
unconditional (no flag can remove them), and that path has never been exercised
since. Idle Home is now evidenced three ways; the camera is the only untested
risk on this device, alongside the A03 entirely.

# Run 6 — 2026-08-18, incidental: 49m18s unplugged foreground at nominal

Captured while waiting for the (still un-run) camera leg. Nobody was driving the
phone, so this is an untouched idle-Home dwell in the truest sense.

| UTC | Event |
|---|---|
| 20:35:48Z | launch — `nominal`, **battery 80%, charging=false** (unplugged; 85%→80% since 19:51, discharging) |
| 20:35:51Z | loading splash video ready |
| — | **49m18s of complete log silence: no thermal transition, no fence** |
| 21:25:09Z | `background-before-fence` — display slept; rss 51.6MB |

**Result: ≥49m18s unplugged, foreground, zero thermal transitions.** Fences are
logged reliably (four of them recorded today, always within seconds of a display
sleep), so the absence of one across those 49 minutes is positive evidence the
app stayed foreground — it was not quietly fenced.

**Idle Home, now measured four ways on the Stage 0+1 build:**

| Run | Conditions | Held `nominal` |
|---|---|---|
| 3 | trickle-charged 100% | ≥48m48s (ended by a human touch) |
| 5 | unplugged, checkpoint-verified | ≥16m41s (ended by display sleep) |
| **6** | **unplugged, untouched** | **≥49m18s (ended by display sleep)** |
| 2 (old build) | bulk charging, 12fps resting | **flipped to `fair` at 9m06s** |

Same caveat as run 5: the log never records the committed tab, so "Home" is
inferred from the post-login boot path, not proven. Two of the four runs are now
unplugged, which retires the charging confound as an explanation.

**Camera leg: 4 attempts, still never opened.** It cannot be automated — the app
declares no URL scheme and no `openURL` handling (verified in Info.plist and
sources), and the shell hard-codes `?view=home`. See the proposed launch-argument
unblock in PROTOCOL.md.

# Camera leg — status after 5 attempts: NOT RUN, harness ready

None of the five failed on the tooling. Every one ended because the phone was
asleep, fenced, or unattended; attempt 5 aborted correctly in 3 min on a log
whose last lifecycle event was a fence from an hour earlier.

Automation was attempted and does not work (see PROTOCOL.md): a `poplurStartView`
hook fed `PoplurWebHome.homeURL`, which has no consumers (reverted, unshipped);
the pre-existing `#if DEBUG -PoplurVerificationTab record` launches but lands on
Home with `renderer=PostLoginHomeWeb` and no new `NativeCamera` lines. Launch
args do arrive, so the gap is routing, not transport. Hand-navigation works
because it emits the `tabChanged` → `cameraLiveVisibilityChanged` bridge
sequence the native capture lease depends on.

**To run it, one uninterrupted 12-minute window is needed:** phone unplugged and
awake (Auto-Lock = Never), Poplur open, tap into the camera, hold it pointed at a
real scene — face-down gives the ML pipeline a black frame and understates the
load. Then `.codex/thermal-soak/` → `soak-camera.sh`, which waits for
`renderer=NativeCamera`, samples every 90 s, and proves camera-live + foreground
at each checkpoint.

**Why it is still worth doing:** NativeCamera owned 67 `nominal>fair`
transitions before the 14 Aug fix and once took this phone cool→warm in 58 s.
Stage 0 made its `systemPressureState` KVO and serious/critical park
unconditional, so no flag can strip the brakes again — but that path has not been
exercised since. It is the only untested surface on this device.

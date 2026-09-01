# Next-session notes — 2026-08-09 evening

Two map tasks were scoped but deliberately **not started**, to avoid leaving half-built work in a
checkout that a concurrent session is actively committing to. Both are well-defined below, with the
seams already located.

---

## 1. Takeover test mode (dev flag)

**What it is:** a dev flag that seeds a **full-world claim set** on pop level `all`, so you can
actually see wrapped terrain and judge the floor. Today `all` only draws the demo fixtures, which
are far too sparse for the terrain wrap to show.

**The seam — `src/App.tsx:1669`–`1756`:**

```
const [popLevel, setPopLevel] = useState<PopLevel>('mine')
setClaimGroup(map, 'others', popLevel === 'mine'   ? [] : OTHER_POPS.map(...))
setClaimGroup(map, 'mine',   popLevel === 'others' ? [] : POIS.map(...))
```

On `all`, both groups draw together and the bigger radius wins the overlap (see the `PopLevel`
doc comment at `src/data.ts:185`). Sources are `OTHER_POPS` (= `WORLD_POPS` + `CITY_POPS`) and
`POIS` — demo-sized, so the flag needs to substitute a denser/larger synthetic set, not just
flip the level.

**Follow the existing convention.** There is already a claims dev flag to mirror:

- `src/ClayMap.tsx:1103` — `new URLSearchParams(window.location.search).get('sample-claims') === '1'`
- Same shape used by `mapLite`, `day-cycle`, `weather-cycle`, `sky-cycle`, `tour-speed`

So: kebab-case query param, compared `=== '1'`. Do **not** invent a new flag mechanism.

**Also available:** `App.tsx:2167` has a `case 'setPopLevel'` message handler accepting
`'mine' | 'others' | 'all'`, so the level can be driven from native/postMessage without UI.

**Still to decide:** whether the seeded set is generated (grid/noise over the viewport) or a
checked-in fixture. Not investigated — pick based on whether you want it stable across runs.

---

## 2. Cinematic idle pan

**What it is:** a slow yaw orbit around the focused point, cancelled by any gesture. It must **not**
be a permanent `rAF` — same heat reason the profile camera button avoided one.

**Most of this is already solved by `src/frameGovernor.ts`.** Do not hand-roll a `rAF` loop.

```
export function onFrame(cb: (dtMs, now) => void, rate: Rate = 'ambient'): () => void
```

Subscribe the orbit at `'ambient'` and return the unsubscribe on unmount. The governor already
provides every property the task asks for:

| Requirement | Already handled by |
|---|---|
| Not a permanent rAF | One shared pump; `HZ` table scales rate by quality tier |
| Cancelled by gesture | `noteInteraction()` is wired to the governor's own pointer listeners (`frameGovernor.ts:310`, `:317`, `:320`) — it fires globally, no manual wiring |
| Stops when truly idle | `AMBIENT_IDLE_MS = 15_000` → ambient sleep |
| Resumes after touch | `INTERACTION_TAIL_MS = 1200` |
| Renderer parks | `syncRendererPark()` when ambient-sleeping and not interacting |

Useful companions: `ambientAllowed()`, `onAmbientSleepChange()`, `onRendererParkChange()`,
`boostFrames(ms)`.

**The ProfileTwin precedent** (the one referenced as "avoided a permanent rAF") is at
`src/ProfileTwin.tsx:233` — gated on `reduceMotion.matches` with explicit `cancelAnimationFrame`
at `:258` and `:266`. Match the reduce-motion gate; prefer `onFrame` over the raw loop.

**Watch out:** at thermal `serious` the map canvas draws zero frames and touch cannot revive it,
while zoom still advances — so a stalled orbit may read as a zoom bug rather than a thermal park.

---

## 3. Long-press anywhere → fullscreen, app-wide (requested 2026-08-09, UNSTARTED)

**What was asked:** long-pressing the SCREEN (not a button) hides all UI and goes
fullscreen, exactly as the feed already does. Applies to every screen including subscreens.
Long-press again to toggle back. **With a pop sound on the toggle.**

**Most of this already exists.** Do not build it from scratch — the feed's chain is:

```
FeedTwin long-press (550ms, 12px travel tolerance)   FeedTwin.tsx:969-978
  → playPop() + setPlayerMode(on => !on)
  → onPlayerModeChange={setFeedFullscreen}            HomeTwin.tsx:1714
  → feedChromeGone = feedFullscreen && committedTab === 'feed'   HomeTwin.tsx:1217
  → styles.chromeHidden applied to:
      bottomRow  HomeTwin.tsx:1821
      statStack  HomeTwin.tsx:1867
      groundGlow HomeTwin.tsx:1974
      cubeWrap   HomeTwin.tsx:1978
  → .chromeHidden { opacity: 0; pointer-events: none; transition: .2s }
                                                      HomeTwin.module.css:747
```

**The three changes:**

1. **Lift the gesture out of FeedTwin to the shell** so it fires on every screen and
   subscreen, not just the feed. Reuse FeedTwin's exact handler shape — `longPressTimerRef`
   + `longPressAnchorRef` (FeedTwin.tsx:329-330), armed on pointerdown, cancelled on
   >12px travel in `onPointerMove`, 550ms. Firing consumes the gesture (it nulls
   `gestureStart` and `lastTap`) so the press cannot also read as a tap or swipe — keep that.
2. **Drop the `&& committedTab === 'feed'` gate** at HomeTwin.tsx:1217 so the chrome
   hides on any tab. Rename off `feed*` while you are there.
3. **Exclude real buttons.** The ask is explicitly "not an actual button but the screen",
   so the shell handler must ignore presses that originate on interactive elements —
   `e.target.closest('button, a, input, [role="button"]')` and bail.

**The pop:** `playPop()` immediately before the toggle, matching FeedTwin.tsx:975.

**Watch out:** `.chromeHidden` sets `pointer-events: none`, so whatever surface receives the
long-press to toggle BACK must not be one of the elements being hidden, or the gesture
cannot be undone.

## 4. AdMob ads land outside the feed (reported 2026-08-09, UNSTARTED)

**Symptom:** ads appear in their own view rather than inside the feed.

**Root cause is the FORMAT, not the layout.** `Poplur2025-iOS/Poplur2025/AdManager.swift` is a
`FullScreenContentDelegate` serving **interstitials only**. Android's
`ads/AdManager.kt` is interstitial ×14 — but already has `NativeAd` ×8, `AdLoader` ×2 and
`AdView` ×2 wired. An interstitial is a full-screen format by specification and by AdMob
policy; no feed arrangement can embed one. The web feed (`FeedTwin.tsx`) has **zero** ad
references — every ad reference in the codebase is native.

**The real fix:** migrate to **Native Advanced**, which exists to be rendered with your own
UI. Bridge the creative (headline, icon, image, CTA) into the web feed as a post card and
report impressions/clicks back through the SDK's native ad view. Android has the starting
pieces; iOS has none.

**Do NOT put the ad behind the WebView.** The mechanism exists —
`PostLoginHomeWebView.swift:411` already toggles `webView.isOpaque = !on` with a `.clear`
background — but AdMob's obstructed-view and accidental-click policies make an ad behind
semi-transparent app chrome an invalidation risk. That toggle is for visual effects, not
for monetized inventory.

## Workspace state at handoff

- **Nothing is unpushed.** `poplur-clay-map` → `origin/ml-camera-feed-share-permissions` @ `875d311`;
  `Poplur2025-iOS` → `origin/ml-camera-share-permissions` @ `d6bdc1c`. Both verified against
  `git ls-remote`. Local tracking refs were missing and are now set — that absence had earlier been
  misread as "not on the remote".
- **Cross-app gap 🔴** — iOS took a regenerated `ClayMapWeb` bundle in `d6bdc1c`, but
  `Poplur2025-Android` (`86d02c7`) and `Poplur2025-ReactNative` (`adc7573`) are still on the older
  bundle. Same clay-map source, three natives, one diverged.
- **Thermal gate is failing** — `map-heap: retained-heap growth could not be measured`
  (heap probe exceeded 200s). This is a *measurement timeout*, not a proven regression, and it is
  consistent with the map parking at `serious` mid-probe. It will hard-fail any `sync-mobile` run,
  so it blocks closing the gap above.
- **Concurrent session is live in this checkout** and commits without warning — it added two commits
  to these branches inside a ten-minute window. Re-verify branch tips immediately before acting on
  them; do not trust a reading more than a few minutes old.

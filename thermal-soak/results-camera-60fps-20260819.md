# Camera leg — the "full fps" preview, iPhone 16, 2026-08-19

Launch `2026-08-19T20:28:40Z`, build=6 (CFBundleVersion not bumped; the
`[PoplurCamera]` line below is what distinguishes this binary).
Raw: `raw/camera-60fps-20260819/final.log`.

## The headline: 60 was never reachable

    [PoplurCamera] previewFPS applied=30 requested=60 recording=false supported=1-30

The active capture format tops out at **30fps**, so `previewFrameRate = 60`
clamps to 30. The shipped change is **20 -> 30**, not 20 -> 60.

This is also the first run where that could be known at all — nothing logged the
applied rate before, and CFBundleVersion was not bumped, so old and new builds
both report `build=6`. The candidate descent mattered here: the pre-fix list was
low-first (`[requested, 18, 20, 24, 30]`) and would have resolved an unsupported
60 to **18fps** — worse than the 20 it replaced. The fixed descent
(`[requested, 30, 24, 18]`) is why this landed on 30.

## Timeline (mm:ss from launch)

| | |
|---|---|
| 00:00 | launch, `nominal`, **charging=true**, battery 100% |
| 04:02 | camera fronted — `applied=30 requested=60` |
| 13:04 | **`nominal` -> `fair`**, owned by **`NativeCamera`** |
| 13:04 | ladder engages: `applied=18`, mode REDUCED (fps=8) |
| 15:02 | background fence -> fps=1 |
| 17:44 | back to `nominal` (charging=false — phone unplugged) |
| 42:10+ | `nominal` held, PostLoginHomeWeb, FULL, fps=30 |

## Verdict

**~9m02s of camera before `fair`**, against the 14 Aug baseline of ~25 min at
20fps. So the extra 10fps costs most of the camera's thermal headroom.

Two caveats, both pushing the same way:
- The run was **charging at 100%** the whole time up to the flip. The protocol is
  explicit that charging heat contaminates a `fair` reading, so 9m02s is a
  **floor**, not the number. A clean unplugged re-run is still owed.
- It **never reached `serious`**, and every rung of the ladder fired correctly
  (18fps at fair, REDUCED at fps=8, fence at fps=1, recovery in ~4m40s once
  unplugged). The device was protected throughout.

## What is still owed

A clean **unplugged** camera leg (Auto-Lock=Never, ~12 min hold) to replace the
floor with a real number. `pull-loop.sh camera-60fps 720` drives the operator
half; it did not exist before this run despite PROTOCOL.md referencing it.

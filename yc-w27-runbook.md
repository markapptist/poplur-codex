# Poplur → YC W27: the seven-week runbook

Written 15 Sep 2026 (Monday). **Hard deadline: Sunday 2 Nov 2026, 8:00 p.m. PT (11:00 p.m. Toronto).**
Verified on ycombinator.com/apply on 15 Sep: late applications are "still considered" with no promised
decision date. **Personal submit day: Tuesday 27 Oct.** Decisions by 11 Dec; batch Jan–Mar in SF.

Three tracks run in parallel — **Group** (students), **App** (product + data), **YC** (form + videos).
Owner tags: **[Mark]** only you can do it · **[Claude/Codex]** an agent does it, you approve.

**Recruitment (Mark's decision, 16 Sep): voluntary opt-in only.** Mark posts the Discord invite in his Sheridan
and Humber course channels; nobody is asked in person, so there is no pressure and the retention numbers are
not biased by the instructor being in the room. Expect ~10–15 of ~40 to opt in, across two campuses. Launch
Launch day = **Thu 1 Oct** (decided 20 Sep); the invite goes out Thu 24 Sep, right after the on-device walkthrough and the college's written answer. **The synthetic cohort STAYS ON during the beta (Mark's decision, 16 Sep) so students always see content and
engagement.** Consequences handled on 16 Sep: (1) feed-pool fix so human pops are never evicted by synthetic
volume; (2) a campus lane in the runner — 35% of sim pops land within ~1 km of Humber North / Lakeshore and
Sheridan Trafalgar / HMC / Davis (`POPLUR_CAMPUS_POST_SHARE=0.35` in the app-runner launchd plist); (3) the
Beta tab splits human-grown vs synthetic-grown reach and counts student likes on sim pops as activity;
(4) the `engagements` indexes are live. Sims engage only with the OWNER's posts, never students'. Day 14 =
14 days after the first install. The application describes it honestly as an opt-in student pilot.

**Dates fixed 20 Sep (Mark):** invite **Thu 24 Sep** in both course channels (latest Mon 28 Sep); onboarding 24–30 Sep
(Discord → NDA → Tester role → install → first pop, all welcome before day 0); **day 0 = Thu 1 Oct** (points board and
scorecard window open); **intensive 1–14 Oct** (daily prompt, fix build every 2–3 days, reports Sun 4, Sun 11, final
Wed 14 Oct); **day-14 pull Thu 15 Oct**; **shoot week Mon 12–Fri 16 Oct** with the college's camera equipment, mid-beta
(founder video + demo — not after the beta, which would leave two days to the hard deadline); **low-touch tail 15–31 Oct**
(one weekly prompt, Monday standings, board stays open, final report Sat 31 Oct); rewrite the form 15–21 Oct;
**submit Tue 27 Oct**; the beta keeps running through the 11 Dec decision. Before the invite, Mark: IP agent meeting and
the college's conflict-of-interest answer, in writing. NDA: Mark pays for a Jotform tier if the day-2 join count needs it
(reverses the 17 Sep "must stay free"); unlimited is not needed at a 20–30 headcount. **Both platforms from day 0 (Mark,
20 Sep):** iPhone via TestFlight, Android 8.0+ via the Play internal track (live since 20 Sep); the NDA form collects the
Google account email for Android testers and Mark adds them in Play Console as NDAs arrive. Two weeks is the minimum that yields
a day-14 number for the form; the month is for the interview, not the application.

---

## Week 1 · 15–21 Sep · get ready

**YC**
- [ ] [Mark] Finish the founder profile: date of birth; Humber Game Programming Advanced Diploma dates
      (+ Brock if you want it listed); company names for the two 2013–14 LinkedIn rows. Everything else is filled.
- [ ] [Mark] Read every field of the saved application once, end to end, as a stranger would. Send edits.
- [ ] [Mark] Get a lawyer or a legal clinic (Humber/Sheridan both have student legal clinics; so does U of T/Osgoode
      for the public) to glance at the NDA. Ask one question: "anything in here that would embarrass me?"
- [ ] [Mark] Check Humber's and Sheridan's policy on faculty involving students in a private venture
      (usually "conflict of interest" or "research involving students"). Keep the answer in writing.

**App** — the beta produces YC-grade numbers only if the measurement exists *before* the first install
- [x] [Claude/Codex] Beta metrics report in the Test Center (Beta tab, 16 Sep; contamination split in progress): installs (TestFlight),
      sign-ups, % who posted within 24 h, D1 / D7 / D14 retention, pops per active user, radius growth per pop,
      largest reach achieved, likes per pop. Daily, with a CSV. Sim actors excluded by uid.
- [ ] [Claude/Codex] Fresh-account walkthrough on the TestFlight build 202609151840: sign up → location prompt →
      first pop → appears on a second real account's map/feed → like → radius grows. Fix anything that fails.
- [x] **RUN 20 Sep 09:00Z** [Claude] Android walkthrough on the A03 (Play build 1.0.2 vc3, owner account): start 4 s, feed 10 s,
      tabs/camera/composer OK. **Blockers:** Android never shows the system location prompt (composer ends at
      "Waiting for your location", nobody can post) and never asks notification permission (pushes dropped on 13+);
      the composer spot-picker map fails to load ~every other time ("MAP COULDN'T LOAD", Try Again works);
      interstitials fire on the passive feed within a minute and click through; "Keep my pop" is hidden under the
      navigator on 720×1600. Post/engagement/push/delete NOT verified (would replace Mark's real home pop). Both
      permission fixes are Kotlin-side and must ship in a new Play build before any Android invite.
      **20 Sep 21:39Z: fixed in Android 88cde06 and shipped as 1.0.3 (versionCode 4) to the Play internal track;** the A03
      re-check of both prompts is pending (phone was unplugged at install time). iOS TestFlight build 0.1 (202609201549)
      uploaded 20:17Z — attach to the Beta Testers group + App Store 1.0 submission (manual release) still to do in ASC.
- [ ] [Claude/Codex] Push notifications for a real (non-sim) account: post, like, radius-grew. Verify on device.
- [ ] [Claude/Codex] Crash reporting: confirm TestFlight crash logs + Crashlytics land somewhere you will read.
- [ ] [Claude/Codex] Feed pool: human pops must never be evicted by synthetic volume (fix in poplur-clay-map
      `nativeFeedPosts.ts`, 16 Sep) → sync-mobile → new TestFlight build → attach. Blocker for the invite.
- [ ] [Mark] Decide: is a "report / delete post" path good enough for a student cohort? (It must exist.)
- [ ] **[Claude/Codex] Close the radius claim ladder BEFORE the invite** — 13 posts with zero engagement reach the
      world radius under the deployed rule (spec: `.codex/radius-claim-loophole.md`, Model B + rate limit). Needs
      function + backfill + rules deploy (Mark) and a client change in the next TestFlight build. A student finding it
      ends the beta as an algorithm test. **18 Sep: Phase 1 BUILT** — Mark runs `.codex/build-products/deploy-claim-ladder-fix.sh` then `ship-testflight.sh`. Location: free where you are, paid anywhere (decided 17 Sep).
- [x] 18 Sep: sims now engage each other (live); ×10 + 500 m floor + one-pop-per-5-km override + composer warning are BUILT — Mark runs `deploy-claim-ladder-fix.sh` then `ship-testflight.sh`.

**Group**
- [x] Recruitment set: opt-in via the course channels (Sheridan + Humber). No in-person pitch.
- [ ] [Mark] Five-minute on-device walkthrough on build 202609151840 (fresh account → post → like from the owner
      account → radius grew → push arrived → delete path). Report each step. [Claude/Codex] fix, rebuild, attach.
- [ ] [Mark] Then post the course-channel invite (text below). Invite link: no expiry, max ~60 uses.
- [ ] OWNER 17 Sep: the NDA signing must stay FREE (no Bronze). Jotform Sign caps at 10/month → rebuild as a
      regular Jotform form with a Signature field (100/month free) or a Google Form; add a "referred by" field.

---

## Week 2 · 22–28 Sep · prep, then the invite on Thu 24 Sep (day 0 is Thu 1 Oct)

**On the day the invite goes out**
1. [Claude] confirm the campus lane is producing pops on both campuses (Test Center map) and the feed-pool fix
   is in the TestFlight build and the Play internal build students will install. The cohort keeps running.
2. [Mark] post the invite in both course channels on **Thu 24 Sep**; that's the whole launch. Installs are welcome
   before 1 Oct; the points board and the measured window open on day 0, Thu 1 Oct. Volunteers arrive on their own
   schedule: Discord → #nda (sign) → #focus-group (install).
3. [Mark] be the first pop on each campus the same day, so the first volunteer's map is not empty.

**Cadence (replaces the in-class nudge — all drafted by Claude, approved and posted by Mark)**
- Daily prompt in #focus-group ("today: post from somewhere you've never posted from").
- Day-7 check-in post; DM from Mark to anyone who signed the NDA but never installed.
- Every message is shown to Mark before it is sent.
- [ ] [Claude/Codex] Daily: triage TestFlight feedback + #focus-group; ship a fix build every 2–3 days
      (build-runner → attach to the group; same version 0.1 needs no re-review; testers auto-update).
- [ ] [Claude] Daily metrics post to you (from the report above). Day-1 number to watch: % who posted within 24 h.
- [ ] [Mark] Founder video moved to the **shoot week 12–16 Oct** (decided 20 Sep: college camera equipment, mid-beta, so
      [N] is a real two-week number). This week: book the equipment for 12–16 Oct.

---

## Week 3 · 29 Sep–5 Oct · day 0 Thu 1 Oct — the intensive fortnight begins

- [ ] [Mark] **Thu 1 Oct, day 0:** set `testControl/betaScorecard.startAtMillis` to 1 Oct 00:00 Toronto (or have an
      agent do it), post the board-open message in #focus-group, and be the first pop on each campus if you are not already.
- [ ] [Claude] Reports due **Sun 4 Oct** and **Sun 11 Oct**; tally the board and draft the Monday standings post.

- [ ] [Mark] With ~10–15 volunteers across two campuses, depth beats breadth: the daily prompt and the day-7
      check-in are the levers. Never chase anyone in class — the whole point is that nobody is pressured.

- [ ] [Mark] Mid-point check-in post in #focus-group: "What's broken? What do you wish it did? What made you
      open it again?" Collect three quotable answers (with permission to quote first names in the application).
- [ ] [Claude/Codex] Ship the fixes the data demands. Watch two things specifically: does the ×5 decay make
      radii vanish overnight (students will say so), and does anyone's feed go empty.
- [ ] [Claude] Day-7 snapshot → update the *How far along* draft in the .codex doc (not the form yet).
- [x] Android decided 20 Sep: both platforms from day 0 (Play internal track live since 20 Sep). Ongoing: [Mark] adds each
      new Android tester's Google account email to Play Console → Internal testing as NDAs arrive.

---

## Week 4 · 6–12 Oct · second week of the intensive + wave 2; shoot week starts Mon 12 Oct

- [ ] [Claude] **Day-14 pull Thu 15 Oct** (day 0 = 1 Oct; D14 is complete only for accounts whose day 14 has passed) — the
      numbers that go into the application: installs, sign-ups,
      posted-within-24h %, D7 and D14 retention, pops/user, the single best reach story (which pop, how far,
      how many people), and one product change the data caused.
- [ ] [Mark] Wave 2: online students **near** the wave-1 campus (they add density) plus a labelled **far cohort**
      of ~5 who agree their map will look empty. [Claude] pins a note in #focus-group explaining the far role.
- [ ] [Mark] Optional but powerful: one campus café or shop as a business account posting a real pop. It's the
      revenue story on screen. Ask in person; offer to set it up for them.
- [ ] [Mark] **Shoot week Mon 12–Fri 16 Oct:** the 1-minute founder video and the 3-minute demo (guides below) with the
      college's camera equipment and real student pops on the map. The final intensive report is due Wed 14 Oct; the
      tail starts 15 Oct (one weekly prompt, Monday standings, board open to 31 Oct).

---

## Week 5 · 13–19 Oct · write the real answers

- [ ] [Claude] The form's *How far along* still says "no human has used this version yet" and "before any human
      used it" — rewrite to "runs alongside the beta, counted apart" in this pass.

- [ ] [Claude] Rewrite *How far along* and *When will you have a version* with the day-14 numbers; flip
      *Are people using your product?* to **Yes**; add one student quote to *Why this idea*. Show you the diff
      before saving.
- [ ] [Mark] Upload the founder video and the demo to the form.
- [ ] [Codex] Independent full read of the saved form against the numbers — anything unverifiable gets cut.
- [ ] [Mark] If interviews are a possibility you want to be ready for: keep the beta running and growing;
      interviews (10 minutes, video) happen Nov–early Dec, and "what happened since you applied" is the first question.

---

## Week 6 · 20–26 Oct · final pass

- [ ] [Mark] Read the whole application aloud once. Anything you'd be uncomfortable defending in a 10-minute
      interview comes out.
- [ ] [Claude] Confirm: profile complete ✔, video uploaded ✔, demo uploaded ✔, product link works from a phone
      with no account ✔, no `[[ ]]` placeholders ✔, "Submit application" enabled ✔.
- [ ] [Mark] Sleep on it over the weekend.

## Week 7 · 27 Oct–2 Nov · submit

- [ ] [Mark] **Tuesday 27 Oct: click Submit.** (You click it, nobody else.) Buffer of six days for surprises.
- [ ] Hard stop: **Sunday 2 Nov, 8 p.m. PT.**
- [ ] After submitting: do not stop the beta. Numbers on 11 Dec matter as much as numbers on 27 Oct.

---

## The founder video (1 minute, required)

**YC's rules, verbatim in spirit:** one minute, all founders on camera, talking to the camera, no slides,
no music, no editing tricks. They watch it to see *you*, not the product. Unscripted delivery from bullet
points beats a read script every time.

**Set-up:** iPhone on a stand, landscape, at eye level; face a window or a lamp; quiet room; look at the
lens, not the screen. Record 3–4 takes and pick the one where you sound like yourself. 55–60 seconds.
MP4, under 100 MB (a 1-minute 1080p clip is ~100–150 MB — record at 720p or trim; TestFlight-style
compression is fine).

**Beats (say them in your words; don't memorise):**
1. *Who* — "I'm Mark Meritt, founder of Poplur. I've taught mobile development at Humber and Sheridan for
   nine years."
2. *What* — "Poplur is a social map. Your post lands where you made it with a radius; everyone inside it sees
   it, no followers needed. Engage and the radius grows; ignore it and it shrinks."
3. *Why me* — "I've spent nine years in a room with the people social media is failing — students who post
   good work and are seen by nobody."
4. *Where it is* — "I applied in 2017 with a prototype and was rejected. I went back, taught, listened, and
   built it — iOS, Android, web, in App Store review now — and [N] of my students are on it as of this week."
   (Record after wave 1 launches so N is real.)
5. *Ask* — "I'm applying again because the product is real now, and the next three months should be about
   the first city, not the first build."

Do not say: "AI testers", "no users because IP", or anything about the 2017 co-founders.

## The demo (≤3 minutes, optional, strongly recommended)

Screen-record the iPhone (Control Center → record) with your voice over it. No slides, no talking head.
Real student pops on the map, not fixtures. If the wave-1 launch-day moment got recorded, open with it.

| Time | Show |
|---|---|
| 0:00–0:20 | Open the app on campus: the clay map with live student pops. "This is Humber North right now." |
| 0:20–0:50 | Post a pop; it lands on the map with its radius. |
| 0:50–1:30 | Second phone inside the radius: the pop appears in that feed; a like → radius grows on phone one. |
| 1:30–2:00 | The best real reach story from the beta: a pop that spread across campus (and who it reached). |
| 2:00–2:30 | A business pop (the café) reaching people who can walk in; the radius purchase screen. |
| 2:30–3:00 | Back on the map: what you'll test next. One sentence. |

---

## Known risks (and the move for each)

| Risk | Move |
|---|---|
| App Store review still pending (since 9 Sep) | TestFlight is the beta channel regardless; the App Store status is one clause in the form, not a dependency. |
| Jotform free tier: 10 signatures/month | Mark pays for one month once the day-2 join count passes what the free route covers (decided 20 Sep); unlimited is not needed at 20–30. |
| Decay ×5 trial makes radii vanish overnight | Your call was to leave it on. If students complain, that's a finding — either fix it and say so, or cite it as a learning. |
| Android on day 0 is rougher than iOS (the A03 showed a 14 s black splash and ads covering the map) | Walkthrough on the A03 before Thursday; interstitials off for testers; the invite says Android 8.0+. Android emails from the NDA go into Play Console → Internal testing. |
| Your time | The agents run the daily loop; you own three things: in-class nudges, the two videos, and the final read. |
| Wave 1 too small or too dispersed | One campus, 20+, in person. If you can't get 20 on one campus, take the class you see most often and post in every session. |

## The course-channel invite (Mark posts it; edit freely)

Superseded 17 Sep by `.codex/beta-focus-group/invite-and-beta-rules.md` — two messages (course-channel invite +
pinned server rules) carrying the incentive — OWNER 17 Sep: **$250 total, to the MOST ACTIVE** → $100/$75/$50/$25 to the top
four on a points board (report 10, confirmed bug 5, voice 5/wk, referral 5 cap 5), Monday standings post, e-Transfer by Fri 7 Nov, Google-Form reports due Sun 4 Oct, Sun 11 Oct, Wed 14 Oct + final by Sat 31 Oct (re-dated 20 Sep for day 0 = 1 Oct), optional weekly voice
slot, NDA-then-Tester-role gate, iPhone XS+/iOS 18.5+. Beta ends Fri 31 Oct. (Calendar check: 2 Nov 2026 is a
**Monday**, not a Sunday.)


## Beta scorecard — what "validated" means and what goes in the application (18 Sep)

Small-n rules: report **count/n and dates**, never a bare %; humans only (synthetic rows labelled and excluded);
day-14 pull Thu 15 Oct (day 0 = 1 Oct), final pull for the form Mon 26 Oct, then Sat 31 Oct.

| # | Signal | Measure (humans only) | Good | Weak | Source |
|---|---|---|---|---|---|
| 1 | Activation | posted a pop within 24 h of first open / installs | ≥ 60 % | < 30 % | Beta tab (installs from TestFlight, first pop from Firestore) |
| 2 | Retention | D7 and D14: opened + any action / installs | D7 ≥ 30 %, D14 ≥ 20 % | D7 < 15 % | Beta tab + Firebase Analytics |
| 3 | The loop | pops with ≥ 1 human engagement grew; people whose pop grew posted again within 72 h at a higher rate than those whose didn't | growth on every engaged pop; re-post rate ≥ 1.5× | no difference | algorithm reports (radiusHistory, engagements) |
| 4 | Discovery by radius | human engagements that came by interception (feed/map) vs profile visit | ≥ 70 % interception | mostly profile | engagements.surface |
| 5 | Organic pull | installs Mark didn't cause (referrals, friends); posts on days with no prompt; "I opened it to see who's near" in reports | any referral install; > 40 % of posts off-prompt | all activity on prompt days | NDA "referred by", report form, Discord |
| — | Integrity | zero pops seeded above owner's allowance; zero ladder events; first override behaved | 0 | any | digest verdict |

Verdict: **validated for this stage** = 1, 2 and 3 all "good"; 4 and 5 are the story. Two of five weak = "we learned
X" — report it anyway with the change it drove. Never write "validated" in the form; write the numbers, n, dates, and
the one insight.

Show YC: (a) the table above filled in, in *How far along* and *Are people using your product* (Yes); (b) a 20 s
segment of the founder/demo video: the map with real student pops and one radius growing from a classmate's like;
(c) three verbatims from reports/voice chats about why they opened it; (d) synthetic cohort mentioned only as the
pre-launch harness, in its own sentence.

---
name: sparkpos-user-guide
description: Records SparkPOS screenshots and MP4 video tutorials by driving the real app in a headless Chrome, then puts them into the user guide (a Claude Doc). Use when asked for a user guide, manual, how-to, training or tutorial material with screenshots or videos of SparkPOS screens, to add a new recorded task, or to refresh the guide's pictures after a screen changed.
---

# SparkPOS user guide: screenshots and video tutorials

The skill drives SparkPOS step by step from scenario files. For each scenario it saves numbered
screenshots, an MP4 clip (with a caption bar and a ring where each click lands), and the receipts
that "printed". A `manifest.json` lists them in order with captions, and the guide is built from it.

The guide doc is **SparkPOS User Guide**, https://claude.ai/artifact/PhrLEvitdaimuCYWR1PTZ7.
Its pictures go in the **Picture guide** tab.

## Safety rules (read first)

Recording a sale, a void or an End of Day creates real records, so:

- **Record only on a local copy:** `./scripts/run-local.sh enzo` (http://localhost:5092). That copy
  runs with ERP posting, auto sync and invoice emails off. Never record on a live site
  (enzopos / vrosspos.itcoresystems.com).
- **Record only on a recording terminal:** 023 / `POS-DEMO` in TabletPOS_ENZO, with ERP posting
  off, printer `console` and its own print agent key `demo-capture`. Nothing reaches the ERP or a
  store printer. `demo-terminal.mjs` refuses to touch a terminal that posts to the ERP.
- **Show it only while recording.** Testers at 023 would otherwise see POS-DEMO at Cash Begin.
  Run `demo-terminal.mjs on` before and `off` after, even when the run failed.
- **One recorded day per terminal per date.** A full day ends in End of Day, which closes POS-DEMO
  for today. To record again on the same date, create `POS-DEMO2`
  (`demo-terminal.mjs --code POS-DEMO2 create`) and set `GUIDE_TERMINAL=POS-DEMO2`.
  Existing recording terminals: POS-DEMO (id 9), POS-DEMO2 (id 10) and POS-DEMO3 (id 11); all
  three were closed on 2026-11-10.
- **VROSS (2026-11-18):** the pricing modules (wholesale, promos, the 5% / 20% senior rules) are
  set up on VROSS, so they were recorded on a local VROSS copy (`./scripts/run-local.sh vross`,
  http://localhost:5093, posting / sync / emails off) on a VROSS recording terminal, **003 /
  POS-DEMO (id 82)**, same settings (no ERP, printer `console`, key `demo-capture`), made with
  `demo-terminal.mjs --base http://localhost:5093 --branch 003 create`. Branch 003 is Retail with
  scale prefix 25; VROSS's local `super` / `cashier` belong to 003. It closed 2026-11-18 with an
  End of Day. Scenarios `15`-`17` (Admin: Wholesale, Promos, Discounts; `16` creates the demo
  promo "B1T1 Sardines", switched off afterwards), the cashier run `01`, `02`, `18`-`21`, `07`,
  `08`, and `22` (reports, as Admin). The recording went into the page "SparkPOS Pricing Guide"
  (https://claude.ai/artifact/Ebtff3eL6LEkZYbcTHAxaz) because the Docs connector was down; copy it
  into the User Guide's Picture guide tab when it's back.
- **Passwords:**
  - They only come from environment variables, never from scenario files, the guide or chat
    summaries.
  - Password fields show as dots in screenshots and videos; check that they do.
  - The test sign-ins are the user's (`sparkpos-admin`, `super`, `cashier`). If you don't have
    them, ask the user to export them in their own terminal.
- **Output** goes to the session scratchpad (`guide-capture/`), never into the repo.

## Steps

1. **Tools (once per machine):** `scripts/setup.sh`. It installs puppeteer-core, a headless Chrome
   and ffmpeg into `~/.cache/sparkpos-guide`.
2. **App:** check `curl -s http://localhost:5092/health`. If it's not running, ask the user to run
   `./scripts/run-local.sh enzo` in their own terminal (it asks for the test server password).
   Run `./scripts/build.sh` first when the web app changed, so the screens are current.
3. **Show the terminal:** `node scripts/demo-terminal.mjs on` (the first time: `create`), with
   `GUIDE_ADMIN_USER` / `GUIDE_ADMIN_PASSWORD` set.
4. **Record** (from this skill's folder):
   ```bash
   GUIDE_TERMINAL=POS-DEMO GUIDE_CASHIER_USER=… GUIDE_CASHIER_PASSWORD=… \
   GUIDE_SUPERVISOR_USER=… GUIDE_SUPERVISOR_PASSWORD=… \
   node scripts/capture.mjs --base http://localhost:5092 --out <scratchpad>/guide-capture \
     scenarios/0{1,2,3,4,5,6,7,8}-*.json
   ```
   More tasks, run after `02` and before `07`: `09-card-payment.json`, `10-return.json` (needs
   refunds switched on at the branch), `11-reprint.json`, `12-offline.json` and
   `13-suki-card.json` (needs earning on and `GUIDE_SUKI_CARD` = a registered card).
   `14-admin-suki-cards.json` is a separate run as an Admin (`GUIDE_ADMIN_USER` /
   `GUIDE_ADMIN_PASSWORD`, `GUIDE_BRANCH`). Don't rebuild the web app during a run: the app then
   offers a new version, which can swallow a click.
   All files of one run share one browser session, in the order given; together they make a
   cashier's day. A failure stops the run and saves `error.png` in that scenario's folder.
   `--device handheld` records at the Android handheld's size (393×780).
   **Continuing after a failure:** the shift stays open on the demo terminal, and the product
   list lives in that run's browser profile, which is printed at the end. Rerun with
   `--profile <that path>` and `scenarios/00-resume-shift.json` first (`GUIDE_TERMINAL_ID` = the
   terminal's id), then the scenarios that are left. A fresh profile would show an empty
   catalog until Cash Begin.
5. **Hide the terminal:** `node scripts/demo-terminal.mjs off`.
6. **Look at every screenshot** (Read the PNGs) before using it:
   - The caption must match what's on screen.
   - No password shows.
   - No error toast or half-loaded screen.

   Pull a frame from a video to check it:
   `~/.cache/sparkpos-guide/node_modules/ffmpeg-static/ffmpeg -ss 5 -i clip.mp4 -frames:v 1 frame.png`.
   Fix the scenario and record again (on the next demo terminal) rather than shipping a wrong picture.
7. **Put them in the guide** (load the docs skill first):
   - Upload the PNGs and MP4s to the doc's artifact: Artifact publish with `url` = the doc link,
     `asset: true`, `file_paths` (at most 25 per call).
   - Create one blob per image (`create object "blob"` with the asset id).
   - In the Picture guide tab, put each scenario's section: its title, its summary, then each
     screenshot as `![caption](blob/<id>)` with the caption under it, then the clip as a link to
     the uploaded MP4's url ("Watch the video, 0:13").
   - Replace a section's old pictures when re-recording; don't stack them.

## Scenario files (`scenarios/*.json`)

`{ "name", "title", "summary", "steps": [ … ] }`. A step can hold several of these keys; they run
in this order: `goto`, `storage`, `offline`, `reload`, `say`, `waitText`, `click`, `clickSelector`, `fill`, `select`, `press`,
`scan`, `expect`, `video: "start"`, `wait`, `shot`, `video: "stop"`.

| Key | Does |
| --- | --- |
| `goto: "/login"` | Opens that path on `--base` |
| `storage: {"pos_terminalId": "$GUIDE_TERMINAL_ID"}` | Sets the site's browser storage. With `00-resume-shift.json` this continues a demo terminal's open shift after a failed run. |
| `offline: true` / `false` | Internet down / back: the SparkPOS server can't be reached and the page is told it's offline, while PrintAgent on the PC still works. |
| `reload: true` | Refreshes the page (offline, it opens from the app's own cache) |
| `say: "Press PAY"` | Sets the caption bar shown in the video (`""` clears it). Hidden in screenshots. |
| `click: "Open shift"` | Clicks the visible, enabled button / link / tab with those words or that aria-label. `exact: true` for a whole-text match, `nth` for the 2nd, 3rd… |
| `fill: {label: "Cash amount"}`, `value` | Types into the input under that field label. Also `{placeholder}` or `{selector}`. `fast: true` types at once. |
| `select: {label}`, `value` | Picks an option of a select |
| `scan: "4801981116072"` | Types the code plus Enter into the POS search box, like a scanner |
| `waitText` / `expect` | Waits until that text shows (not case-sensitive) |
| `video: "start"`, `clip`, `caption` / `video: "stop"` | Records an MP4 between the two |
| `shot: "cart"`, `caption`, `fullPage` | Saves `NN-cart.png`. The caption goes into the manifest and then the guide. |
| `wait: 800` | Pauses (ms) |

Values: `"$NAME"` is read from the environment, and `"@lastSI"` is the SI No. on the last printed
receipt (used by Void).

Scale stickers are prefix `25` + the 5-digit ERP product code + the weight in grams (5 digits) +
1 check digit (not checked). For example `2510015012500` = BELLY BI, 1.250 kg.

## When a screen changed

Scenarios find things by visible words, so renaming a button breaks its step: the run stops there
with "No visible, enabled button … with the words". Update the words in the scenario, record
again, and replace that section's pictures in the guide. Keep captions about what the user does
and sees, in the guide's plain style.

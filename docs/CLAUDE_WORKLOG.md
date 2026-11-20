# SparkPOS work log (engineering record for Claude sessions)

Loaded by CLAUDE.md, so every session starts with it. The same layout as the ERP side's
`docs/CLAUDE_WORKLOG.md`.
- **The full story of each feature** stays in CLAUDE.md's sections.
- **This log keeps:**
  - one row per migration, with where it is installed;
  - one row per data change on a client's database;
  - one row per code-only change and where it is deployed;
  - the reminders.
- **Plain-language status for the team:** `docs/tracker/SparkPOS_Daily_Tracker.md`.

**Next free migration number: 41.** Claim it here (bump the number) before writing the script.

Tier columns: **TEST** = `TabletPOS` (corex test server), **ENZO** = `TabletPOS_ENZO` (the enzopos site's DB),
**VROSS** = `TabletPOS_VROSS` (the vrosspos site's DB). A migration is installed by the standing OK (no need
to ask); a site build is deployed by the user. Cell = status + date.

## Migrations

| # | What + why / tests | TEST | ENZO | VROSS |
|---|---|---|---|---|
| 26 | Suki / reward cards: earn and check points (user 11-12). `loyalty_tests.sql` 14 | 02 re-run 11-13 | installed 11-12, earning ON | installed 11-12 |
| 27 | Each till device assigned to its terminal (user 11-13: a cashier must not pick another PC's terminal) | installed 11-13 | installed 11-13 | installed 11-13 |
| 28 | Non-VAT items VAT-exempt, not zero-rated; zero-rated sale option (user 11-13). `zero_rated_tests.sql` 6 | installed 11-13 | installed 11-13 | installed 11-13 |
| 29 | POS type per terminal (user 11-14: Restaurant on one till only) | installed 11-14 | installed 11-14 | installed 11-14 |
| 30 | Regular / other discount: peso amount, supervisor, reason (user 11-15). `other_discount_tests.sql` 7 | installed 11-15 | installed 11-15 | installed 11-15 |
| 31 | Price levels Price1-4 (user 11-17). `price_levels_tests.sql` 11 | installed 11-17 | installed 11-17 | installed 11-17 |
| 32 | SC/PWD rate per POS type + weekly cap ₱125 / booklet (user 11-17). `discount_cap_tests.sql` 9 | installed 11-17 | installed 11-17 | installed 11-17 |
| 33 | Wholesale prices by quantity, DTI report (user 11-17, VROSS memo). `wholesale_tests.sql` 10 | installed 11-17 | installed 11-17 | installed 11-17, rules entered 11-17 |
| 34 | Promos Buy N Take M: same / mix and match / gift (user 11-18). `promo_tests.sql` 11 | installed 11-18 | installed 11-18 | installed 11-18 |
| 35 | Supervisor approvals per branch + terminal; price level per item (user 11-19). `approvals_tests.sql` 9 | installed 11-19 | installed 11-19 | installed 11-19 |
| 36 | Price level approval switch (user 11-19, after trying 35) | installed 11-19 | installed 11-19 | installed 11-19 |
| 37 | Screen layout per terminal: grocery lane (user 11-19, mock-up B). Save SQL tested rolled back | installed 11-19 | installed 11-19 | installed 11-19 |
| 40 | Price level by time of day, per terminal / branch / every branch (user 11-20). HTTP 14, Node 11 | installed 11-20 | installed 11-20 | installed 11-20 |
| 39 | Open drawer without a sale: DrawerOpens log, OpenDrawerOverride approval, ZReads.DrawerOpens (user 11-20). `drawer_tests.sql` 5; X-Read shape in promo/other_discount tests | installed 11-20 | installed 11-20 | installed 11-20 |
| 38 | Gift certificates as payment: own GC list, no change, offline checked at sync (user 11-20). `giftcert_tests.sql` 16; acc 9→10 rules; promo/other_discount X-Read shape | installed 11-20 | installed 11-20 (acc GC rule added) | installed 11-20 (acc GC rule added) |

## Data changes on a client's database

| Date | DB | What (who asked) | Script / audit |
|---|---|---|---|
| 11-16 | ENZO, VROSS | Accounting ledger ON for testing (user: "keep it on for the test"). Ask to turn off after | `acc.sp_SetupCompany` |
| 11-17 | VROSS | Wholesale rules from the Finance memo, branches 001/002/003/005/006 | `scratchpad/lvl/vross_wholesale.sql`, WHOLESALE_RULE_SAVE |
| 11-18 | VROSS | SENIOR/PWD at Retail = 5%, VAT kept (user: "non restaurant items should be 5%") | `scratchpad/lvl/vross_rates.sql`, DISCOUNT_POSTYPE_RATE_SET |
| 11-19 | VROSS | SENIOR/PWD on Prepared Foods (cat 69) at Retail = 20%, VAT-exempt (user) | `scratchpad/lvl/vross_prepared.sql` |
| 11-20 | VROSS | Local cashiers cashierv1-cashierv8, one per branch 001-008, test password given by the user | USER_CREATE rows |
| 11-20 | VROSS | 24 active retail tills set to the grocery lane (user, after deploying) | TERMINAL_UPDATE rows |
| 11-20 | VROSS | NAAC, MOV, SOLO (PWD already) copied from SENIOR: Retail 5% VAT kept, Prepared Foods 20% VAT-exempt; SOLO at Restaurant 20% VAT-exempt so all five match (user) | `scratchpad/lvl/vross_copy_senior.sql`, DISCOUNT_POSTYPE_RATE_SET |

## Code changes (no migration)

| Date | What + why / tests | VROSS site | ENZO site |
|---|---|---|---|
| 11-19 | SC/PWD on the senior's own items: quantity per line, supervisor (V1-GRILLS SI 2). Node checks | deployed 11-20 (build 11-19 23:55) | not yet |
| 11-19 | Dialogs no longer close on a drag that ends outside them (testers' discount screen). Headless Chrome | deployed 11-20 | not yet |
| 11-19 | Grocery lane screen (`GroceryLane` in Pos.jsx), with 37. Headless Chrome, 1024-1920 px | deployed 11-20 | not yet |
| 11-20 | Discounted sale prints CUSTOMER COPY + ACCOUNTING COPY in one job with a cut between (web only). Headless Chrome | not yet | not yet |
| 11-20 | X-Read / Z-Read / Blind Close add up on paper: less VAT, cash received − change, total = net; Blind Close shows change and what's not in the drawer (02 re-run on all three) | not yet | not yet |
| 11-20 | Price level by time of day: Admin → Price Lists card, till applies it between sales (with 40). Headless Chrome incl. a live switch. Site publish | not yet | not yet |
| 11-20 | Open drawer: till dialog + log (offline queue), PrintAgent 2.1 `/drawer` pulse, NO SALE slip fallback, X/Z-Read count (with 39). HTTP 10, headless Chrome 5 cases. Site + **PrintAgent** publish | not yet | not yet |
| 11-20 | Gift certificates: till pay dialog, Admin → Gift Certificates, reports, X/Z-Read (with 38). HTTP 22 on TabletPOS, headless Chrome. **Full publish** (API + web) | not yet | not yet |
| 11-20 | Hold / Recall a sale (user: customer short of cash goes to withdraw). Till-only (meta `held_<terminalId>`), F10 on the grocery lane, Blind Close refuses while any are held. Headless Chrome, both screens | not yet | not yet |
| 11-19 | ERP poster: a line given away whole (mix-and-match / gift promo) no longer refused as "no per-line VAT figures"; the ERP books its stock (ERP confirmed 11-19) | deployed 11-20; 5 failed sales need Retry | not yet |

## ⏰ Reminders / waiting on someone

- **Retry 5 promo sales**, 001 POS-01 SI 18/19/26/27/28 (outbox 1544/1545/1552/1553/1554). Do it in Admin →
  Sales sent to the ERP **before 11-21 ~22:30**, when the ERP's 48 h limit refuses them (61145), and before
  that shift closes. (user)
- **V1-GRILLS posts nothing since 11-17**: its OPEN was refused (the MIN is already registered to another
  SparkPOS terminal), and its 11-19 sales and the closes are queued behind it. Head office gives it its own
  MIN, then Retry the OPEN. (head office)
- **F12 on the VROSS till PCs**: check that it opens PAY and not Chrome's DevTools. (user / testers)
- **ENZO site** still runs an older build (index-BB-03OSO.js); everything from 11-17 on isn't there yet. (user)
- **003 POS-02 11-12 queue**: RETURN 366 (old ERP column), CLOSE 648, ZREAD 649 failed. They are test
  leftovers; decide whether to clear them. (user)
- **"Only senior works" (testers, 11-20)**: headless Chrome on the 11-19 build with VROSS's rates: PWD (= SENIOR,
  5% / 20% cat 69), NAAC and MOV (20% E), SOLO (10% E) all apply, pay and print on both screens; the sync and the
  poster have no type-specific code. Yet VROSS and ENZO have never saved a non-SENIOR sale. Waiting for the testers'
  till, type, item and screen. Decision 13: Retail rates for NAAC / MOV / SOLO. (user)
- **Gift certificates and the ERP** (ERP answer 11-20): no GC register in any ERP DB; the desktop POS saves a GC as a card row (CCType 'GiftCert', GC no. in CCPaymentReferenceNo, whole amount, no change, ~₱226k at VROSS May-Nov); `spu_SparkPOS_PostSale` refuses anything but CASH / CARD. (a) send as CARD with CardName/CardBank 'GiftCert', GC no. in CardRefNo: no ERP change, but GL = AR - Credit Card; (b) a 'GC' type: PostSale, @GCSales/@GCRefunds on CloseShift/PostZRead, desktop copy as 'GiftCert', a GC liability GL leg (account to be picked). Until decided, `GiftCertOn` is refused at branches with posting tills. (user + accountant)
- **Returns of a GC-paid sale** refund in cash; the user keeps it until management decides (tracker #15). (management)
- **PrintAgent 2.1** on every till PC for the no-paper drawer pulse; until then Open drawer prints a NO SALE slip. (user)
- **PrintAgent at MDU** is still a foreground exe, not a scheduled task or service.

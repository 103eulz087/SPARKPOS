# SparkPOS — Daily Tracker

Plain language, for the team. Engineering detail is in `docs/CLAUDE_WORKLOG.md`; the full story of each
feature is in CLAUDE.md. Same layout as the ERP side's CORE-X Daily Tracker.

## Pending now

**VROSS**
- Press **Retry** on 5 promo sales of 001 POS-01 (SI 18, 19, 26, 27, 28) before Saturday 11-21 about
  10:30 PM. Admin → Z-Read / EOD → Sales sent to the ERP. Until then their items aren't deducted from stock.
- V1-GRILLS needs its own MIN. None of its sales since 11-17 have reached the ERP (no stock deducted).
- The grocery lane is on for the 24 retail tills. Watch the testers' feedback. Check that F12 = PAY on the PCs.
- Testers say only the senior discount works. Checked 11-20: PWD, NAAC, MOV and Solo all apply on the till, but none
  has ever been saved on a sale. Waiting for the testers' details (till, type, item, what the screen showed).
- **Hold / Recall** is built (not deployed yet): publish and deploy the site when ready.
- **Gift certificates** are built (not deployed yet; it's an API + web publish). They can't be switched on at VROSS until
  the ERP takes GC payments (decision 14).
- **Open drawer** (no sale) is built (not deployed yet): deploy the site, and the new PrintAgent on each till PC
  so the drawer opens without printing (until then it prints a short NO SALE slip).
- **Price level by time of day** is built (not deployed yet). After deploying, enter the schedule in Admin → Price Lists
  (e.g. Price 1 from 7 PM for the GRILLS tills). Only items with a Price 1 in the ERP change price.
- Decisions 1, 2, 3, 5, 8, 14, 15 below.

**ENZO**
- The site runs an older build. Deploy when ENZO resumes testing.

## Decisions needed

Numbers are permanent. Status: Waiting / Decided / Dropped.

| # | Decision | Who decides | Recommendation | Holds back | Since | Status |
|---|---|---|---|---|---|---|
| 1 | Grocery rung on a GRILLS (Restaurant) till gets 20% instead of 5% | User + accountant | Restaurant rule like Retail: 5% on everything, 20% on Prepared Foods | Correct senior discount on GRILLS tills | 11-19 | Waiting |
| 2 | 58 cooked items in Prepared Foods are marked "not discountable" in the ERP (GRILLS sisig, fried chicken, SSM rice meals...); 3 GRILLS items sit in Processed Foods | Head office + accountant | Mark cooked meals discountable; move the GRILLS items to Prepared Foods | Seniors get no discount on those items | 11-19 | Waiting |
| 3 | Dinuguan Small is non-VAT, Dinuguan Medium is VAT-able in the ERP | Accountant | Make both the same | Correct VAT on dinuguan | 11-19 | Waiting |
| 4 | A code such as PROMO on promo lines so the ERP doesn't flag promo sales for review | User | Optional; the flag goes away once the ERP adds its promo lines | Review flags only | 11-19 | Waiting |
| 5 | Test cashiers cashierv1-v8 share one easy password | User | Change or switch them off before go-live | Go-live | 11-20 | Waiting |
| 6 | VAT-exempt sales on the receipt: before or after the discount | Accountant | Before (2 of 4 BIR examples, current) | — | 10-27 | Waiting |
| 7 | Turn the SparkPOS accounting ledger off on ENZO/VROSS after the test (the ERP posts the GL) | User | Turn off after the test | — | 11-16 | Waiting |
| 8 | Weekly cap: which day the week starts, which discount types get 5%, cooked meat-shop items 20% or 5% | Accountant | — | Cap rules | 11-18 | Waiting |
| 9 | Redeeming suki points: as a discount or a payment (BIR treatment) | Accountant | — | Redeeming | 11-12 | Waiting |
| 10 | Grocery lane screen for retail tills | User | Mock-up B | — | 11-19 | Decided (B, built and on for VROSS retail tills 11-20) |
| 11 | Senior/PWD discount on the senior's own items only, with a supervisor | User | Quantity per line + supervisor | — | 11-19 | Decided (built) |
| 12 | Prepared Foods 20% VAT-exempt at Retail tills | User | 20%, VAT removed | — | 11-19 | Decided (set 11-19) |
| 13 | NAAC, Medal of Valor and Solo parent at Retail tills had no Retail rule (20% / 20% / 10% VAT-exempt on everything) | User | Same rules as Senior | Correct NAAC / MOV / Solo discounts | 11-20 | Decided (user 11-20: same as Senior on every till; set on VROSS) |
| 14 | Gift certificates at tills that post to the ERP. The ERP answered 11-20: it has no GC list; the desktop POS records a GC as a card type ("GiftCert", GC no. typed in the reference); the ERP takes only CASH / CARD today. (a) Send a GC as a CARD named GiftCert: works now, but the ERP books it to AR - Credit Card. (b) A real GC payment type in the ERP: GC totals, desktop copy, and a GC liability account the accountant picks | User + accountant, then the ERP session | (b); (a) only as a stop-gap if GCs are needed at go-live | GCs at VROSS | 11-20 | Waiting |
| 15 | A return of a GC-paid sale refunds cash: allowed, or refund to a new GC / store credit? | Management | Keep cash refunds until management decides (user 11-20) | GC returns | 11-20 | Waiting |
| 16 | Gift certificates: whose list, change, selling, offline | User | SparkPOS's own list; no change (forfeited); accept only; offline checked at sync | — | 11-20 | Decided (built 11-20) |
| 17 | Price level by time of day | User | Per branch and per terminal; start-end time and days; sale in progress keeps its prices; cashier can go back to regular | — | 11-20 | Decided (built 11-20) |

## Daily progress

Newest first.

| Date | Done | Ran on test / live | Decided | Next |
|---|---|---|---|---|
| 2026-11-20 | Cashier logins cashierv1-v8 (one per VROSS branch). Grocery lane on for the 24 VROSS retail tills. This log and tracker set up. "Only senior works": all five types tested on both till screens (apply, pay, receipt); no fault found yet. Hold / Recall a sale built (F10 on the grocery lane). Gift certificates as payment built (migration 38). Open drawer without a sale built (migration 39, new PrintAgent). NAAC / MOV / Solo parent set to Senior's rates on VROSS. Price level by time of day built (migration 40). X-Read / Z-Read / Blind Close now add up on paper (change, less VAT, totals). A discounted sale prints a customer copy and an accounting copy | VROSS DB: users + tills. Site build 11-19 23:55 deployed by the user. Migrations 38, 39, 40 + 02 on all three test DBs (194/194 each) | #13, #16, #17 | Deploy Hold / Recall, gift certificates, Open drawer and the price schedule (API + web, PrintAgent on till PCs); enter the 7 PM schedule; ERP answer on GCs; retry the 5 promo sales; V1-GRILLS MIN; testers' feedback on the grocery lane and the discount details |
| 2026-11-19 | SI 2 discount explained. Senior's own items with a supervisor. Booklet/cap labels. Prepared Foods 20%. Discount dialog no longer closes mid-entry. Cebuano discount guide. Price-level switch save issue (old API on the server). Grocery lane: mock-ups, then built (migration 37). Free promo items not deducted: fixed in the ERP poster | 35, 36, 37 on all three test DBs; VROSS Prepared Foods rate | #10, #11, #12 | Deploy; retry; decisions 1-3 |

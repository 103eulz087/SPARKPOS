# TabletPOS Handoff — Senior Citizen / PWD Discount Engine (Mixed Basket)

Nov 17, 2026 · @eulz

## Purpose and TL;DR

TabletPOS must discount each cart line by its item's discount class. It must never apply one rate to the transaction total. A senior or PWD basket can hold three kinds of lines, each with different VAT and discount rules:

| Discount class | What it covers | Discount | VAT | Cap |
| --- | --- | --- | --- | --- |
| `SC20` | Restaurant food and drinks, medicines, other RA 9994 / RA 10754 goods and services, for the holder's exclusive use | 20% | Exempt: strip 12% VAT first, then take 20% | None |
| `BNPC5` | Basic necessities and prime commodities: rice, fresh meat, poultry, eggs, canned fish, coffee, milk, condiments, laundry soap, etc. | 5% of regular retail price | Not exempt: VAT stays on the discounted price | ₱125 discount per week (₱2,500 purchases) |
| `NONE` | Everything else: snacks, soft drinks, non-essentials | 0% | Normal | n/a |

The common mistake is to say "restaurant is 5%, dry goods is 20%". That is reversed. Food in a restaurant is 20% + VAT-exempt, and groceries on the BNPC list are 5% with VAT kept.

Scope: all three TabletPOS types (retail, restaurant, pharmacy), for both senior citizen (SC) and PWD holders. Server-side stored procedures are the authority. The React/Dexie client mirrors the same math so it keeps working offline.

## Legal basis

Each rule below is enforced in code. Confidence: **Certain** = stated in the regulation or an official summary. **Likely** = strong inference that still needs a check by the accountant or RDO.

| Rule | Source | Confidence |
| --- | --- | --- |
| SC 20% discount + VAT exemption on goods and services for the senior's exclusive use | RA 9994; [BIR RR 7-2010](https://dev.lawyerly.ph/laws/55830) | Certain |
| PWD 20% discount + VAT exemption, same mechanics | RA 10754 | Certain |
| 20% is computed on the VAT-exclusive amount: strip 12% VAT, then take 20% | [RMC 38-2012](https://www.scribd.com/document/558579779/64655RMC-No-38-2012) | Certain |
| No fixed maximum or cap may reduce the 20% | RMC 38-2012 | Certain |
| A promo-priced item bought by a senior is still VAT-exempt, even when the promo beats 20% | [RMC 38-2012 Q21](https://seniorcitizen.davaocity.gov.ph/index.php/republic-act-9994-page-4) | Certain |
| Senior/PWD takes the store promo or the statutory discount, whichever is higher, never both | RMC 38-2012; [JAO 24-02](https://www.alburolaw.com/?p=18497) | Certain |
| Shared restaurant orders: the 20% applies only to the holder's share (total ÷ diners) | [DSWD/DOH resolution summary](https://jur.ph/law/summary/resolution-clarifying-senior-citizens-discount-restaurants) | Certain |
| BNPC 5% special discount on regular retail price, VAT not exempt | [JAO 24-02 s2024](https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf) | Certain |
| BNPC cap: ₱125 discount per week on ₱2,500 purchases (was ₱65 on ₱1,300 before Mar 25, 2024) | [DA](https://www.da.gov.ph/?p=78173); [GMA](https://www.gmanetwork.com/news/money/personalfinance/901251/gov-t-order-increasing-monthly-discount-of-seniors-pwds-on-groceries-signed/story) | Certain |
| BNPC 5% is separate from the 20% and does not stack on the same item | JAO 24-02 | Certain |
| BNPC 5% needs an ID plus the purchase booklet; a senior who is also a PWD shows one ID and two booklets | [DA](https://www.da.gov.ph/?p=78163); [Alburo](https://www.alburolaw.com/?p=18497) | Certain |
| An authorized representative can buy with both IDs, the booklet and an authorization letter valid for 7 days | [Alburo](https://www.alburolaw.com/?p=18497) | Certain |
| BMBE-registered businesses and CDA cooperatives are exempt from the BNPC 5% | [SunStar](https://www.sunstar.com.ph/pampanga/addl-discounts-for-seniors-pwds-start-on-holy-week) | Certain |
| Receipt shows gross price and discount separately; machine tape segregates VAT-exempt from VATable sales | RMC 38-2012 Q24–Q26 | Certain |
| BNPC 5% is taken off the VAT-inclusive shelf price, then VAT is computed on the discounted price | Inferred from "5% of regular retail price, without VAT exemption" | Likely |
| Fresh, unprocessed meat is VAT-exempt (NIRC Sec. 109), so a fresh-meat BNPC line carries no VAT at all | NIRC; not verified for this doc | Likely |

One vendor reference to avoid: [StoreHub's help page](https://care.storehub.com/en/articles/13398892-how-to-apply-bir-special-discounts-on-your-pos) still applies the old ₱65 per-transaction cap.

## Data model

The engine needs two independent flags per item: `DiscountClass` (which special discount applies) and `IsVatable` (whether the item carries VAT at all). Snapshot both onto the sales line at the moment of sale, so a later item-master change never alters a posted invoice.

```sql
-- Item master
ALTER TABLE dbo.Item ADD
    DiscountClass VARCHAR(5) NOT NULL
        CONSTRAINT DF_Item_DiscountClass DEFAULT ('NONE')
        CONSTRAINT CK_Item_DiscountClass CHECK (DiscountClass IN ('SC20','BNPC5','NONE')),
    IsVatable BIT NOT NULL CONSTRAINT DF_Item_IsVatable DEFAULT (1);

-- Store / tenant config
ALTER TABLE dbo.Store ADD
    IsVatRegistered   BIT NOT NULL DEFAULT (1),
    IsBmbeOrCoop      BIT NOT NULL DEFAULT (0),   -- 1 = BNPC5 not applicable
    BnpcWeekStartDay  TINYINT NOT NULL DEFAULT (1), -- 1 = Monday; confirm with RDO/DTI
    BnpcWeeklyBaseCap DECIMAL(12,2) NOT NULL DEFAULT (2500.00),
    BnpcWeeklyDiscCap DECIMAL(12,2) NOT NULL DEFAULT (125.00);

-- Sales header: one holder type per transaction
ALTER TABLE dbo.SalesHeader ADD
    HolderType      VARCHAR(4)  NOT NULL DEFAULT ('NONE')  -- NONE | SC | PWD
        CHECK (HolderType IN ('NONE','SC','PWD')),
    HolderName      NVARCHAR(150) NULL,
    HolderIdNo      VARCHAR(50)   NULL,   -- OSCA / PWD ID number
    HolderTin       VARCHAR(20)   NULL,
    BookletVerified BIT NOT NULL DEFAULT (0),
    Pax             SMALLINT NOT NULL DEFAULT (1),
    HolderPax       SMALLINT NOT NULL DEFAULT (0),
    VatableSales    DECIMAL(12,2) NOT NULL DEFAULT (0),
    VatAmount       DECIMAL(12,2) NOT NULL DEFAULT (0),
    VatExemptSales  DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscSC20        DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscBNPC5       DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscPromo       DECIMAL(12,2) NOT NULL DEFAULT (0);

-- Sales line: snapshot + per-line breakdown
ALTER TABLE dbo.SalesLine ADD
    DiscountClass   VARCHAR(5)  NOT NULL DEFAULT ('NONE'),
    IsVatable       BIT NOT NULL DEFAULT (1),
    IsShared        BIT NOT NULL DEFAULT (0),
    AppliedRule     VARCHAR(12) NOT NULL DEFAULT ('NONE'), -- SC20|BNPC5|PROMO|PROMO_VATEX|NONE
    VatExemptBase   DECIMAL(12,2) NOT NULL DEFAULT (0),
    VatableBase     DECIMAL(12,2) NOT NULL DEFAULT (0),
    VatAmount       DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscSC20        DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscBNPC5       DECIMAL(12,2) NOT NULL DEFAULT (0),
    DiscPromo       DECIMAL(12,2) NOT NULL DEFAULT (0);

-- Separate special-discount sales record (RMC 38-2012 Q29)
CREATE TABLE dbo.SpecialDiscountLog (
    LogId           UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,  -- client UUID, idempotent sync
    SalesHeaderId   UNIQUEIDENTIFIER NOT NULL,
    StoreId         INT NOT NULL,
    TerminalId      INT NOT NULL,
    InvoiceNo       VARCHAR(30) NOT NULL,
    TxnDate         DATETIME2(0) NOT NULL,
    HolderType      VARCHAR(4) NOT NULL,
    HolderName      NVARCHAR(150) NOT NULL,
    HolderIdNo      VARCHAR(50) NOT NULL,
    GrossSales      DECIMAL(12,2) NOT NULL,   -- undiscounted
    DiscSC20        DECIMAL(12,2) NOT NULL,
    DiscBNPC5       DECIMAL(12,2) NOT NULL,
    BnpcBaseUsed    DECIMAL(12,2) NOT NULL,   -- feeds the weekly cap
    BookletVerified BIT NOT NULL,
    WeekStartDate   DATE NOT NULL
);
CREATE INDEX IX_SDL_Holder_Week ON dbo.SpecialDiscountLog (HolderIdNo, WeekStartDate);
```

The weekly cap is read from a view over `SpecialDiscountLog`, grouped by `HolderIdNo` and `WeekStartDate`. That view only sees purchases made in this tenant's stores. The booklet is still the authority for purchases made elsewhere.

Read logic goes in views and write logic in stored procedures, per house style: `sp_ComputeSpecialDiscount` (authoritative pricing) and `sp_PostSpecialDiscountLog` (idempotent on `LogId`).

## Computation

The engine routes every line by its own class, then sums the lines. The weekly BNPC cap is the only step that looks across lines.

&#91;embedded content: per-line discount routing · 3 classes\]

A customer without a valid ID, or a line classed NONE, always gets regular pricing.

Algorithm, all money in integer centavos:

1. For each line: `gross = qty × VAT-inclusive shelf price`.
2. No holder, `NONE`, or `BNPC5` without booklet/BMBE clearance: apply the store promo only, with VAT as normal.
3. `SC20`: take the holder's share (whole line, or `gross × HolderPax ÷ Pax` for shared orders). Set `base = share ÷ 1.12` if the store is VAT-registered and the item is VATable. Then `discount = max(base × 20%, promo measured on base)`. The line is VAT-exempt either way. The non-holder share stays VATable.
4. `BNPC5`: if the store promo is bigger than 5% of gross, the promo wins and the line leaves the pool. Otherwise it joins the BNPC pool.
5. Pool: `allowedBase = min(poolGross, ₱2,500 − usedThisWeek)`. Then `discount = min(allowedBase × 5%, ₱125)`. Split pro rata across pool lines, with the rounding residual on the last line. VAT is computed on each line's discounted price.
6. Sum the lines into header totals. Add `allowedBase` to the holder's weekly usage.

Reference implementation (client mirror of `sp_ComputeSpecialDiscount`; tested against every worked example):

```typescript
export type DiscountClass = 'SC20' | 'BNPC5' | 'NONE';
export type Holder = 'NONE' | 'SC' | 'PWD';

export interface Line {
  id: string;
  cls: DiscountClass;  // snapshot of item master DiscountClass
  vatable: boolean;    // item VAT flag (fresh meat may already be VAT-exempt)
  gross: number;       // qty x shelf price, centavos
  promo: number;       // store promo amount on this line, centavos (0 = none)
  shared?: boolean;    // restaurant shared order, split by headcount
}

export interface Ctx {
  holder: Holder;
  storeVatRegistered: boolean;
  pax: number;                  // diners at the table
  holderPax: number;            // diners with valid SC/PWD ID
  bnpcBaseUsedThisWeek: number; // centavos of BNPC purchases already discounted this week
  bnpcAllowed: boolean;         // booklet verified AND store is not BMBE/cooperative
}

export interface PricedLine extends Line {
  rule: 'SC20' | 'BNPC5' | 'PROMO' | 'PROMO_VATEX' | 'NONE';
  vatExemptBase: number; // VAT-exempt amount before discount
  discSC20: number;
  discBNPC5: number;
  discPromo: number;
  vatableBase: number;   // VATable sales, net of VAT
  vat: number;
  net: number;           // amount payable for the line
}

const VAT = 1.12;
const CAP_BASE = 250_000; // P2,500.00 weekly purchase cap
const CAP_DISC = 12_500;  // P125.00 weekly discount cap
const r = Math.round;

export function priceCart(lines: Line[], c: Ctx) {
  const strip = (l: Line) => c.storeVatRegistered && l.vatable;
  const out: PricedLine[] = lines.map(l => ({ ...l, rule: 'NONE', vatExemptBase: 0, discSC20: 0, discBNPC5: 0, discPromo: 0, vatableBase: 0, vat: 0, net: 0 }));
  const pool: PricedLine[] = [];

  const settleTaxable = (o: PricedLine, amt: number) => {
    if (strip(o)) { const b = r(amt / VAT); o.vatableBase += b; o.vat += amt - b; }
    else { o.vatExemptBase += amt; }
    o.net += amt;
  };

  for (const o of out) {
    if (c.holder === 'NONE' || o.cls === 'NONE' || (o.cls === 'BNPC5' && !c.bnpcAllowed)) {
      o.discPromo = o.promo; o.rule = o.promo ? 'PROMO' : 'NONE';
      settleTaxable(o, o.gross - o.promo);
      continue;
    }
    if (o.cls === 'SC20') {
      const mine = o.shared && c.pax > 0 ? r((o.gross * c.holderPax) / c.pax) : o.gross;
      const rest = o.gross - mine;
      const promoMine = o.gross ? r((o.promo * mine) / o.gross) : 0;
      const base = strip(o) ? r(mine / VAT) : mine;
      const sc = r(base * 0.2);
      const promoOnBase = strip(o) ? base - r((mine - promoMine) / VAT) : promoMine;
      o.vatExemptBase = base;
      if (promoOnBase > sc) { o.discPromo = promoOnBase; o.rule = 'PROMO_VATEX'; }
      else { o.discSC20 = sc; o.rule = 'SC20'; }
      o.net = base - Math.max(sc, promoOnBase);
      if (rest > 0) { const promoRest = o.promo - promoMine; o.discPromo += promoRest; settleTaxable(o, rest - promoRest); }
      continue;
    }
    if (o.promo > r(o.gross * 0.05)) { o.discPromo = o.promo; o.rule = 'PROMO'; settleTaxable(o, o.gross - o.promo); }
    else pool.push(o);
  }

  const poolBase = pool.reduce((s, o) => s + o.gross, 0);
  const room = Math.max(0, CAP_BASE - c.bnpcBaseUsedThisWeek);
  const allowedBase = Math.min(poolBase, room);
  const totalDisc = Math.min(r(allowedBase * 0.05), CAP_DISC);
  let given = 0;
  pool.forEach((o, i) => {
    const d = i === pool.length - 1 ? totalDisc - given : r((totalDisc * o.gross) / poolBase);
    given += d;
    o.discBNPC5 = d; o.rule = d > 0 ? 'BNPC5' : 'NONE';
    settleTaxable(o, o.gross - d);
  });

  const sum = (k: keyof PricedLine) => out.reduce((s, o) => s + (o[k] as number), 0);
  return {
    lines: out,
    totals: {
      gross: sum('gross'), vatExemptSales: sum('vatExemptBase'), vatableSales: sum('vatableBase'),
      vat: sum('vat'), discSC20: sum('discSC20'), discBNPC5: sum('discBNPC5'), discPromo: sum('discPromo'),
      amountDue: sum('net'), bnpcBaseConsumed: allowedBase,
    },
  };
}
```

The T-SQL `sp_ComputeSpecialDiscount` must produce the same numbers. Use `ROUND(x, 0)` on centavo integers, or `DECIMAL(12,2)` with `ROUND(x, 2)`, applied per line in the same order as above.

## Worked examples

Every figure below is output from the reference engine in the computation section, run in a VAT-registered store. Rounding is per line, to the centavo.

**1. Mixed basket, senior with ID, first purchase of the week**

| Line | Class | Shelf price | Discount | VAT-exempt sale | VATable sale | VAT | Pays |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cooked meal | SC20 | ₱280.00 | ₱50.00 (20%) | ₱250.00 | – | – | ₱200.00 |
| Rice + canned goods | BNPC5 | ₱500.00 | ₱25.00 (5%) | – | ₱424.11 | ₱50.89 | ₱475.00 |
| Chips | NONE | ₱100.00 | – | – | ₱89.29 | ₱10.71 | ₱100.00 |
| **Total** |  | **₱880.00** | **₱75.00** | **₱250.00** | **₱513.40** | **₱61.60** | **₱775.00** |

₱880.00 − ₱75.00 discount = ₱805.00. The other ₱30.00 is the meal's VAT, removed by the exemption, which is why the senior pays ₱775.00. Weekly BNPC base consumed: ₱500.00.

**2. Weekly cap hit.** The senior has already used ₱2,000 of BNPC purchases this week and buys ₱1,200 more. Only ₱500 of room is left, so the discount is ₱25.00, not ₱60.00. The senior pays ₱1,175.00.

**3. Promo beats the statutory discount.** Canned goods at ₱200 have a ₱20 store promo. That beats 5% (₱10), so the promo applies alone and the senior pays ₱180.00 with VAT. A ₱280 meal has a 30% promo. VAT is stripped first to ₱250, the promo is worth ₱75 on that base, beating the 20% (₱50). The senior pays ₱175.00, still VAT-exempt.

**4. Group dining.** A ₱1,120 shared platter is ordered by 4 diners, 1 of them a senior. The senior's share is ₱280, which becomes ₱250 VAT-exempt less ₱50. The other ₱840 stays VATable (₱750 + ₱90 VAT). The table pays ₱1,040.00.

**5. Fresh pork (VAT-exempt item, BNPC5).** ₱800 of fresh kasim, no VAT on the item. The 5% gives ₱40.00 off and the senior pays ₱760.00, all of it VAT-exempt.

**6. No ID presented.** A ₱280 meal is billed normally: ₱250 VATable + ₱30 VAT.

## Receipt, Z-reading and BIR records

One invoice may carry a mixed SC/non-SC basket if it breaks out exempt and taxable sales, puts the discount on the exempt portion, and bills VAT on the taxable portion ([RMC 38-2012 Q26](https://seniorcitizen.davaocity.gov.ph/index.php/republic-act-9994-page-4)).

**Receipt footer (ESC/POS print agent), example 1:**

```text
Gross Sales                 880.00
Less: VAT (SC exempt)        30.00
Less: SC Disc 20%            50.00
Less: BNPC Special Disc 5%   25.00
----------------------------------
AMOUNT DUE                  775.00

VATable Sales               513.40
VAT (12%)                    61.60
VAT-Exempt Sales            250.00
Zero-Rated Sales              0.00

SC/PWD Name: ____________________
OSCA/PWD ID: ____________________
Signature:   ____________________
```

Requirements per receipt:

- Gross selling price and each discount on their own lines; sales are reported at the undiscounted price (Q25). Certain.
- "VAT-Exempt Sale" shows the VAT-exclusive amount before the 20% (₱754.24 in the BIR example, ₱250.00 here) (Q30). Certain.
- Holder name and ID number printed or written on the invoice. Likely; the signature line is common practice, not confirmed in the sources read.
- PWD transactions use a "PWD Disc 20%" label instead of "SC Disc 20%".

**Z-reading / X-reading** adds separate totals for: VAT-exempt sales, SC 20% discount, PWD 20% discount, SC BNPC 5%, PWD BNPC 5%, and the count of SC and PWD transactions. This is Likely: the sources require segregation of exempt sales but do not spell out Z-reading line items. Match the format to your BIR POS accreditation.

**Special-discount sales record** (`SpecialDiscountLog`, Q29): holder name, OSCA/PWD ID, gross sales, discount granted, transaction date, invoice/OR number. Export it monthly, because the seller deducts the 20% cost from gross income using this record.

## Cashier flow and validations

The cashier applies the discount once per transaction, at tender. The engine then prices every line by its own class.

1. Cashier taps **SC / PWD** and picks exactly one holder type. Using both SC and PWD on one transaction is blocked.
2. Capture the holder name and ID number. Both are required before any discount is computed. Restaurant mode also needs `Pax` and `HolderPax`.
3. If the cart has any `BNPC5` line, show a **Booklet verified?** checkbox. Unchecked means BNPC5 lines get 0% and the 20% lines still apply.
4. Fetch the holder's weekly BNPC usage from `SpecialDiscountLog` (or from Dexie when offline). Show the remaining room, e.g. "₱500.00 of ₱2,500 left this week".
5. Run `priceCart`. Show each line's applied rule on screen (SC20 / BNPC5 / PROMO / NONE) so the cashier can explain the bill.
6. A manager override is required to change an item's `DiscountClass` at the counter. It is logged and never edited silently.
7. On tender, write `SalesHeader`, `SalesLine` and `SpecialDiscountLog` in one transaction, then print. The cashier writes the purchase in the holder's booklet.

Validations:

- `HolderPax` must be at least 1 and no more than `Pax`.
- Store flagged `IsBmbeOrCoop = 1` means BNPC5 is never applied.
- Offline terminals cannot see other terminals' weekly usage. Enforce the cap with local data plus the booklet, and let the server recompute on sync. If the server finds the cap exceeded, flag the sale for review but never rewrite a posted invoice.

## Item classification and open questions

Getting the item master right matters more than the math: a wrong `DiscountClass` gives the wrong discount on every sale of that item. Seed defaults by category, then have the client's accountant sign off on the list.

| Category | DiscountClass | IsVatable (default) |
| --- | --- | --- |
| Fresh/frozen pork, beef, chicken, fish, eggs | BNPC5 | 0, confirm (NIRC Sec. 109) |
| Processed meats (hotdog, tocino, longganisa, ham) | BNPC5 (prime commodity) | 1 |
| Rice, bread, canned fish, instant noodles, coffee, sugar, milk, cooking oil, salt | BNPC5 | 1 |
| Vinegar, patis, soy sauce, onion, garlic, laundry/bath soap | BNPC5 | 1 |
| Restaurant/carinderia meals, drinks served | SC20 | 1 |
| Medicines (pharmacy POS type) | SC20 | 1, or 0 for VAT-exempt medicines |
| Snacks, soft drinks, liquor, cigarettes, non-essentials | NONE | 1 |

BNPC list per [JAO 24-02 summary](https://www.alburolaw.com/?p=18497).

Open questions for the accountant or RDO before go-live:

- [ ] Is the BNPC 5% computed on the VAT-inclusive shelf price (engine default) or the VAT-exclusive price?
- [ ] Week definition for the ₱2,500 cap: calendar week Mon–Sun, Sun–Sat, or rolling 7 days? The engine reads `BnpcWeekStartDay`.
- [ ] Cooked or ready-to-eat items sold over a meat-shop counter (lechon, fried chicken): SC20 or BNPC5?
- [ ] Which fresh-meat SKUs are VAT-exempt as "original state", and which are processed (marinated cuts)?
- [ ] Required receipt fields for the holder: name, ID number, signature, TIN?
- [ ] Z-reading line items required under the client's POS accreditation.
- [ ] Edge case: a BNPC line whose promo is smaller than 5%, but the weekly cap cuts its 5% below that promo. The engine currently keeps the capped 5%. Should the promo win instead?

## Acceptance tests

Both `priceCart` (client) and `sp_ComputeSpecialDiscount` (server) must give identical results, to the centavo, on every case. Use these as the shared test fixture.

| # | Case | Expected amount due | Key assertions |
| --- | --- | --- | --- |
| 1 | Mixed basket: meal ₱280 SC20 + BNPC ₱500 + chips ₱100 | ₱775.00 | VAT-exempt ₱250.00, VATable ₱513.40, VAT ₱61.60, SC20 ₱50.00, BNPC5 ₱25.00 |
| 2 | BNPC ₱1,200 with ₱2,000 already used this week | ₱1,175.00 | BNPC5 ₱25.00, base consumed ₱500.00 |
| 3 | Canned ₱200 with ₱20 promo + meal ₱280 with 30% promo | ₱355.00 | No 5% on canned; meal rule PROMO\_VATEX, VAT 0 |
| 4 | Shared ₱1,120, Pax 4, HolderPax 1 | ₱1,040.00 | VAT-exempt ₱250.00, VATable ₱750.00, VAT ₱90.00 |
| 5 | Fresh pork ₱800, IsVatable 0 | ₱760.00 | BNPC5 ₱40.00, VAT 0 |
| 6 | Meal ₱280, no holder | ₱280.00 | VATable ₱250.00, VAT ₱30.00 |
| 7 | BNPC ₱3,000 in one sale, week unused | ₱2,875.00 | BNPC5 capped at ₱125.00 |
| 8 | Booklet not verified, cart with SC20 + BNPC5 | 20% applied, 5% = 0 | Rule on BNPC lines = NONE |
| 9 | Holder type PWD | Same math as SC | Labels print "PWD Disc" |
| 10 | Store `IsBmbeOrCoop = 1` | No BNPC5 | SC20 still applies |
| 11 | Store not VAT-registered | Meal ₱280 → ₱224.00 | No VAT strip; 20% off ₱280 |
| 12 | Offline sale synced twice | One log row | Idempotent on `LogId` |

Cases 1–8, 10 and 11 pass against the reference engine (10 uses the same `bnpcAllowed = false` guard as 8). Case 9 is a label change in the print agent. Case 12 is tested on the sync endpoint.

## Sources

- [JAO 24-02 s2024 (NCDA PDF)](https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf)
- [Alburo Law: summary of JAO 24-02](https://www.alburolaw.com/?p=18497)
- [DA: JAO signing, March 21, 2024](https://www.da.gov.ph/gallery/da-dti-doe-jao-signing-march-21-2024/)
- [DA: ₱125 / ₱2,500 weekly cap](https://www.da.gov.ph/?p=78173)
- [DA: covered commodities](https://www.da.gov.ph/?p=78167)
- [DA: ID and purchase booklet](https://www.da.gov.ph/?p=78163)
- [GMA News: cap explained](https://www.gmanetwork.com/news/money/personalfinance/901251/gov-t-order-increasing-monthly-discount-of-seniors-pwds-on-groceries-signed/story)
- [SunStar: BMBE and cooperative exemption](https://www.sunstar.com.ph/pampanga/addl-discounts-for-seniors-pwds-start-on-holy-week)
- [RMC 38-2012 Q&A (Davao City OSCA)](https://seniorcitizen.davaocity.gov.ph/index.php/republic-act-9994-page-4)
- [RMC 38-2012 full text (Scribd)](https://www.scribd.com/document/558579779/64655RMC-No-38-2012)
- [BIR RR 7-2010 (Lawyerly)](https://dev.lawyerly.ph/laws/55830)
- [Group dining resolution summary (jur.ph)](https://jur.ph/law/summary/resolution-clarifying-senior-citizens-discount-restaurants)
- [StoreHub POS help, outdated cap](https://care.storehub.com/en/articles/13398892-how-to-apply-bir-special-discounts-on-your-pos)

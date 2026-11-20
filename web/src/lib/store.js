import { create } from 'zustand'

export const VAT_RATE = 0.12
/** Today's date on this device, YYYY-MM-DD in local time. Never toISOString().slice(0, 10):
 *  that's the UTC date, which is still yesterday before 8 AM in the Philippines. */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
export const peso = (n) =>
  Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A regular / other discount: a peso amount, a reason and a supervisor (not a DiscountTypes row). */
export const OTHER_DISCOUNT = 'OTHER'

/** DTI-DA JAO 24-02 (2024): the special discount on basic necessities and prime commodities
 *  (the 5% that keeps the VAT) is at most ₱125 a week, on ₱2,500 of purchases. One sale can
 *  never take more; the senior's booklet may allow less (the cashier's weekly cap). The 20%
 *  (VAT-exempt) discount has no cap (RMC 38-2012). */
export const BNPC_WEEKLY_CAP = 125

/* Fallback if /api/settings/discount-types is unreachable (offline first run). */
export const DEFAULT_DISCOUNT_TYPES = [
  { code: 'SENIOR', description: 'Senior Citizen', rate: 0.20, vatExempt: true, law: 'RA 9994' },
  { code: 'PWD', description: 'Person With Disability', rate: 0.20, vatExempt: true, law: 'RA 10754' },
  { code: 'NAAC', description: 'National Athlete / Coach', rate: 0.20, vatExempt: true, law: 'RA 10699' },
  { code: 'MOV', description: 'Medal of Valor', rate: 0.20, vatExempt: true, law: 'RA 9049' },
  { code: 'SOLO', description: 'Solo Parent', rate: 0.10, vatExempt: true, law: 'RA 11861' }
]

/**
 * Discount configuration — resolves a line's EFFECTIVE rate/VAT treatment for the chosen
 * discount type. Category overrides exist because RA 9994-style discounts aren't one flat
 * rate: Senior Citizen is 20% + fully VAT-exempt on medicine, but only 5% + still-VATable
 * (needing a VAT adjustment) on groceries/prime commodities — same discount code, different
 * category, different math. No override for a category = use the discount type's own
 * default rate/vatExempt. `categoryRates`: [{ discountCode, categoryId, rate, vatExempt }].
 */
export function resolveDiscount(line, discountType, types, categoryRates, posTypeRates, posType) {
  // a line at a wholesale price or with promo-free units gets no SC/PWD discount on top
  // (33 / 34: whichever is worth more, never both; reprice() picks)
  if (!discountType || !line.isDiscountable || line.wholesale || line.promo) return null
  const d = (types || DEFAULT_DISCOUNT_TYPES).find(t => t.code === discountType)
  if (!d) return null
  // 32_discount_pos_type.sql: the till's POS type can have its own rate (a supermarket till 5%,
  // a restaurant till 20%). First match wins: POS type + category, category (any POS type),
  // POS type, the type's own default. `posTypeRates`: [{ discountCode, posType, categoryId|null, rate, vatExempt }].
  const pt = (posTypeRates || []).filter(r => r.discountCode === discountType && r.posType === posType)
  const hit = pt.find(r => r.categoryId === line.categoryId)
    || (categoryRates || []).find(r => r.discountCode === discountType && r.categoryId === line.categoryId)
    || pt.find(r => r.categoryId == null)
    || d
  return { rate: hit.rate, vatExempt: hit.vatExempt }
}

/**
 * Pure per-amount discount math, reused for a whole line or for a pax-split fraction of one
 * (see computeTotals' Restaurant branch). Always discounts off the NET-OF-VAT base (for a
 * non-vatable amount, net-of-vat == the amount itself, so this generalizes cleanly):
 *  - effective.vatExempt (the RA 9994 standard case): the amount becomes fully VAT-exempt —
 *    no VAT is re-added, and there's no VAT ADJ, since there's no VAT left to adjust.
 *    "VAT Exempt Sales" reports the PRE-discount net-of-vat base (the amount that qualified
 *    for exemption), matching standard BIR sales-invoice reporting; the discount itself is
 *    reported and deducted separately.
 *  - !effective.vatExempt on a vatable amount (e.g. the 5% prime-commodity rate): VAT is
 *    re-added on the POST-discount net base (that's the new taxable base), and "VAT ADJ" —
 *    the gap between a naive gross-based discount and the correct net-of-vat-based one — is
 *    reported for transparency only. It is NEVER subtracted a second time from what the
 *    customer pays; `finalAmount` already nets it out via the net-of-vat-based discount.
 */
function discountLineAmount(amt, isVatable, effective) {
  if (!effective || effective.rate <= 0) {
    const netOfVat = isVatable ? round2(amt / (1 + VAT_RATE)) : amt
    // A non-VAT item (fresh meat, fish, vegetables: Tax Code sec. 109) is VAT-EXEMPT, not
    // zero-rated. Zero-rated is a whole sale to a zero-rated buyer, chosen at the till.
    return {
      discountAmt: 0, vatAdj: 0, finalAmount: amt,
      vatExemptPortion: isVatable ? 0 : amt, vatablePortion: isVatable ? netOfVat : 0,
      vatAmountPortion: isVatable ? round2(amt - netOfVat) : 0, zeroRatedPortion: 0
    }
  }

  const netOfVat = isVatable ? round2(amt / (1 + VAT_RATE)) : amt
  const discountAmt = round2(netOfVat * effective.rate)
  const netAfterDiscount = round2(netOfVat - discountAmt)

  if (isVatable && effective.vatExempt) {
    return {
      discountAmt, vatAdj: 0, finalAmount: netAfterDiscount,
      vatExemptPortion: netOfVat, vatablePortion: 0, vatAmountPortion: 0, zeroRatedPortion: 0
    }
  }
  if (isVatable) {
    const vatAmountPortion = round2(netAfterDiscount * VAT_RATE)
    const finalAmount = round2(netAfterDiscount + vatAmountPortion)
    // the VAT the customer no longer pays, so discount + VAT adj = what comes off the bill
    // (5% of the shelf price, rounded separately, could be a centavo off it)
    const vatAdj = Math.max(0, round2(amt - finalAmount - discountAmt))
    return {
      discountAmt, vatAdj, finalAmount,
      vatExemptPortion: 0, vatablePortion: netAfterDiscount, vatAmountPortion, zeroRatedPortion: 0
    }
  }
  // Never vatable to begin with (a VAT-exempt basic good) — flat discount, no VAT math.
  return {
    discountAmt, vatAdj: 0, finalAmount: netAfterDiscount,
    vatExemptPortion: netOfVat, vatablePortion: 0, vatAmountPortion: 0, zeroRatedPortion: 0
  }
}

/** A zero-rated sale (a PEZA/ecozone buyer, a diplomat…) charges 0% VAT: a VAT-able item
 *  sells at its price without the VAT, per unit so quantity × price stays the line total.
 *  VAT-exempt items keep their price. */
export const exVatPrice = (unitPrice) => round2(unitPrice / (1 + VAT_RATE))
export const priceOf = (line, zeroRated) => zeroRated && line.isVatable ? exVatPrice(line.unitPrice) : line.unitPrice
/** A price level (1-4) of a product or cart line: its PriceN when the ERP set one, else
 *  SellingPrice. level null = SellingPrice (31_price_levels.sql). */
export const levelPrice = (price, levels, level) => (level && levels?.[level - 1] > 0 ? levels[level - 1] : price)

/** 40: the price level a till's schedules put in effect at `now` (null = the regular price).
 *  schedules: [{ PriceLevel, StartTime 'HH:mm', EndTime 'HH:mm', Days 'YYYYYNN' (Monday first) }].
 *  An end before the start runs past midnight; its after-midnight part counts for the day it began.
 *  When two overlap, the one that started most recently wins. */
export function scheduledLevel(schedules, now = new Date()) {
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m }
  const t = now.getHours() * 60 + now.getMinutes()
  const day = (now.getDay() + 6) % 7                     // Monday = 0
  let best = null, bestSince = Infinity
  for (const s of schedules || []) {
    const a = mins(s.StartTime), b = mins(s.EndTime)
    const days = String(s.Days || 'YYYYYYY')
    let since = null
    if (a < b) { if (t >= a && t < b && days[day] === 'Y') since = t - a }
    else if (t >= a && days[day] === 'Y') since = t - a                          // before midnight
    else if (t < b && days[(day + 6) % 7] === 'Y') since = t + 1440 - a          // after midnight, began yesterday
    if (since != null && since < bestSince) { best = Number(s.PriceLevel); bestSince = since }
  }
  return best
}

/** 36: who approved a line's level (kept only while the line is at a level). */
const withApprover = (l, approvedBy) => ({ ...l, levelApprovedBy: l.priceLevel ? approvedBy : null })

/** A cart line moved to a price level (null = SellingPrice). An item without that level stays at
 *  its selling price (priceLevel null). A line whose price a supervisor changed keeps it, now
 *  measured against the new level. */
function atLevel(l, level) {
  if (l.shelfPrice == null) return l
  const base = levelPrice(l.shelfPrice, l.levels, level)
  const priceLevel = level && base !== l.shelfPrice ? level : null
  if (l.unitPrice === l.origUnitPrice) return { ...l, priceLevel, basePrice: base, unitPrice: base, origUnitPrice: base, priceApprovedBy: null }
  return { ...l, priceLevel, basePrice: base, origUnitPrice: base, priceApprovedBy: l.unitPrice === base ? null : l.priceApprovedBy }
}

/** Wholesale prices by quantity (33_wholesale.sql). `line.tiers`: the item's [{ minQty, amountOff }],
 *  highest minimum first. The item's quantity across all its lines in the sale counts (two
 *  stickers of 3 kg and 2.5 kg reach 5 kg), and the highest minimum reached sets every one of
 *  its lines to its base price (SellingPrice or the price level) less the amount off. A line a
 *  supervisor repriced keeps its price, measured against the new one. `waived`: product IDs
 *  whose wholesale price gives way to a senior/PWD discount that's worth more (see reprice());
 *  their lines keep the tier they reached in `wholesaleWaived`, for the cart to say so. */
export function applyWholesale(lines, waived = null) {
  const total = {}
  for (const l of lines) total[l.productId] = round2((total[l.productId] || 0) + Number(l.quantity))
  return lines.map(l => {
    if (l.basePrice == null) return l
    const qty = total[l.productId]
    const reached = l.tiers?.find(t => qty >= t.minQty && t.amountOff < l.basePrice)
    const tier = reached && !waived?.has(l.productId) ? reached : null
    const target = tier ? round2(l.basePrice - tier.amountOff) : l.basePrice
    const terms = reached ? { regularPrice: l.basePrice, amountOff: reached.amountOff, minQty: reached.minQty, itemTotalQty: qty } : null
    const wholesale = tier ? terms : null, wholesaleWaived = reached && !tier ? terms : null
    if (l.unitPrice === l.origUnitPrice) return { ...l, unitPrice: target, origUnitPrice: target, priceApprovedBy: null, wholesale, wholesaleWaived }
    return { ...l, origUnitPrice: target, priceApprovedBy: l.unitPrice === target ? null : l.priceApprovedBy, wholesale, wholesaleWaived }
  })
}

/** Promos: Buy N Take M (34_promos.sql). `promos`: the branch's, from Cash Begin, each
 *  { promoId, promoName, kind, buyQty, freeQty, freeProductId, maxFreePerSale, startDate, endDate,
 *  productIds: Set }. Only lines sold by the piece count (not weighed, whole quantities, not at a
 *  wholesale price, not repriced by a supervisor). Every promo running `today` is worked out on the
 *  units still free to use; the one worth most takes its units first, then the next, so a unit
 *  never counts for two promos.
 *    SAME  — per item: every N + M of it, M are free.
 *    GROUP — the qualifying items together (mix and match): every N + M, the M cheapest are free.
 *    GIFT  — every N qualifying items bought, M of the gift item in the cart are free.
 *  Sets `promo: { promoId, promoName, freeQty }` on the lines with free units (null elsewhere) and
 *  returns `hints` for the cart ("B1T1 Siomai: add 1 more, free"). `waived`: promo IDs that give
 *  way to a senior/PWD discount worth more (reprice()). */
export function applyPromos(lines, promos, today, waived = null) {
  const out = lines.map(l => (l.promo ? { ...l, promo: null } : l))
  const hints = []
  const running = (promos || []).filter(p => p.startDate <= today && today <= p.endDate && !waived?.has(p.promoId))
  if (!running.length) return { lines: out, hints }
  const ok = l => !l.weighed && Number.isInteger(Number(l.quantity)) && l.quantity > 0 && !l.wholesale && l.unitPrice === l.origUnitPrice
  const used = {}                                   // lineNo → units already taken by a promo
  const left = l => (ok(l) ? l.quantity - (used[l.lineNo] || 0) : 0)
  // units of these lines, cheapest first: [{ line, price }] one entry per unit
  const units = ls => ls.flatMap(l => Array.from({ length: left(l) }, () => ({ l, price: l.unitPrice }))).sort((a, b) => a.price - b.price)

  const plan = (p) => {
    const N = p.buyQty, M = p.freeQty, cap = p.maxFreePerSale || Infinity
    const free = new Map(), take = new Map(), tips = []
    const add = (m, l, n) => m.set(l, (m.get(l) || 0) + n)
    let given = 0
    const bundle = (ls, label) => {                   // SAME / GROUP: the cheapest M of every N + M
      const u = units(ls)
      const sets = Math.floor(u.length / (N + M))
      const nFree = Math.min(sets * M, cap - given)
      if (nFree <= 0) { if (u.length % (N + M) >= N && given < cap) tips.push(`${p.promoName}: add ${N + M - (u.length % (N + M))} more${label}, free`); return }
      given += nFree
      u.slice(0, nFree).forEach(x => add(free, x.l, 1))
      // the units bought for them: the dearest ones, so the free ones stay the cheapest
      u.slice(u.length - Math.ceil(nFree / M) * N).forEach(x => add(take, x.l, 1))
      u.slice(0, nFree).forEach(x => add(take, x.l, 1))
      const rest = u.length - Math.ceil(nFree / M) * (N + M)
      if (rest >= N && given < cap) tips.push(`${p.promoName}: add ${N + M - rest} more${label}, free`)
    }
    if (p.kind === 'SAME') {
      for (const pid of new Set(out.filter(l => p.productIds.has(l.productId) && left(l) > 0).map(l => l.productId)))
        bundle(out.filter(l => l.productId === pid), ` ${out.find(l => l.productId === pid).productName}`)
    } else if (p.kind === 'GROUP') {
      bundle(out.filter(l => p.productIds.has(l.productId)), '')
    } else {
      const buy = units(out.filter(l => p.productIds.has(l.productId) && l.productId !== p.freeProductId))
      const gift = units(out.filter(l => l.productId === p.freeProductId))
      const entitled = Math.min(Math.floor(buy.length / N) * M, cap)
      const nFree = Math.min(entitled, gift.length)
      gift.slice(0, nFree).forEach(x => { add(free, x.l, 1); add(take, x.l, 1) })
      buy.slice(buy.length - Math.ceil(nFree / M) * N).forEach(x => add(take, x.l, 1))
      if (entitled > nFree) tips.push(`${p.promoName}: ${entitled - nFree} free gift item(s) not in the cart yet`)
    }
    let value = 0
    for (const [l, n] of free) value += n * l.unitPrice
    return { free, take, tips, value }
  }

  const todo = [...running]
  while (todo.length) {
    const best = todo.map(p => ({ p, r: plan(p) })).sort((a, b) => b.r.value - a.r.value)[0]
    todo.splice(todo.indexOf(best.p), 1)
    hints.push(...best.r.tips)
    if (best.r.value <= 0) continue
    for (const [l, n] of best.r.take) used[l.lineNo] = (used[l.lineNo] || 0) + n
    for (const [l, n] of best.r.free) {
      const i = out.findIndex(x => x.lineNo === l.lineNo)
      if (!out[i].promo) out[i] = { ...out[i], promo: { promoId: best.p.promoId, promoName: best.p.promoName, freeQty: n } }
    }
  }
  return { lines: out, hints }
}

/** The cart's totals as the sale would be saved, for `st` (the cart state) and these lines. */
const totalsOf = (st, lines) => computeTotals(lines, st.discount?.type, st.discountTypes, st.categoryRates, st.pax,
  !!st.zeroRated, st.discount?.amount, st.posTypeRates, st.posType, st.discount?.cap ?? null, st.discount?.booklet !== false,
  st.discount?.qtys ?? null)

/** The senior's own quantity of a line (`qtys`: { lineNo: qty } on the discount; none = all of it),
 *  never more than the line's quantity. */
export const discountQtyOf = (l, qtys) => (qtys && qtys[l.lineNo] != null
  ? Math.max(0, Math.min(Number(qtys[l.lineNo]) || 0, Number(l.quantity))) : Number(l.quantity))

/** The part of a line's amount that gets the discount: all of it, or the senior's own quantity
 *  × the price. */
const discountedAmt = (l, amt, unitPrice, qtys) => {
  const q = discountQtyOf(l, qtys)
  return q >= Number(l.quantity) ? amt : Math.min(amt, round2(q * unitPrice))
}

/** Prices the lines for the cart state: wholesale where the quantity reaches a tier, except that
 *  with a senior/PWD discount the customer gets whichever is worth more, never both (RMC 38-2012,
 *  JAO 24-02; VROSS's memo: "dapat isa lang"): an item's wholesale gives way when the sale costs
 *  less without it (the discount applies on the regular price instead), decided item by item. */
function reprice(st, lines = st.lines) {
  const today = st.today || localDate()
  const price = (ww, wp) => applyPromos(applyWholesale(lines, ww), st.promos, today, wp).lines
  const out = price(null, null)
  const type = st.discount?.type
  if (!type || type === OTHER_DISCOUNT || st.zeroRated) return out
  // with a senior/PWD discount: give way, one by one, where the sale costs less without it
  const ww = new Set(), wp = new Set()
  const candidates = [...new Set(out.filter(l => l.wholesale).map(l => l.productId))].map(id => ['w', id])
    .concat([...new Set(out.filter(l => l.promo).map(l => l.promo.promoId))].map(id => ['p', id]))
  for (const [kind, id] of candidates) {
    const keep = totalsOf(st, price(ww, wp)).net
    const w2 = kind === 'w' ? new Set([...ww, id]) : ww, p2 = kind === 'p' ? new Set([...wp, id]) : wp
    if (totalsOf(st, price(w2, p2)).net < keep) { if (kind === 'w') ww.add(id); else wp.add(id) }
  }
  return ww.size || wp.size ? price(ww, wp) : out
}

/** The cart's promo hints ("add 1 more, free") for these lines. */
const promoHints = (st, lines) => applyPromos(lines.map(l => ({ ...l, promo: null })), st.promos, st.today || localDate()).hints

/**
 * `pax`: Restaurant PosType only — { dinerCount, seniorCount } captured at Generate Bill.
 * When present, the discountable part of the bill is split by headcount fraction (seniorCount/
 * dinerCount) — only that fraction is discounted; the rest is a normal, undiscounted
 * regular-sale portion. The split is worked out on the BILL, as BIR RMC 38-2012's formula does
 * (total ÷ diners, less VAT, × rate), not item by item, so the amount due matches a calculator
 * to the centavo; each figure is then shared out to the lines (`paxSplit`, largest remainder)
 * so the lines still add up exactly to the totals. Omit `pax` (or leave dinerCount falsy) for the ordinary
 * whole-line-or-nothing behavior Retail/Pharmacy/takeout use.
 * `zeroRatedSale` (truthy): the whole sale is zero-rated — VAT-able lines at their price without
 * the VAT, all of it Zero-Rated Sales; VAT-exempt lines unchanged. No discount applies (the
 * till doesn't allow both). perLine carries each line's unitPrice and lineTotal as charged.
 */
/** Shares `total` (pesos) out over `weights` in whole centavos: each gets its proportional
 *  share rounded down, and the centavos left go to the largest remainders (ties: first line). */
function allocate(total, weights) {
  const cents = Math.round((total + Number.EPSILON) * 100)
  const sum = weights.reduce((a, w) => a + w, 0)
  if (!sum) return weights.map(() => 0)
  const raw = weights.map(w => cents * w / sum)
  const out = raw.map(Math.floor)
  let left = cents - out.reduce((a, c) => a + c, 0)
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => { if (left > 0) { out[i]++; left-- } })
  return out.map(c => c / 100)
}

/** Discountable lines with the same treatment (VAT-able or not, rate, VAT-exempt or not) form one
 *  group, so a split is worked out on the group's total, not item by item. */
// qtys: the senior's own quantities; only that part of a line counts (the rest is charged in full)
function discountGroups(lines, effectiveOf, zeroRatedSale, qtys = null) {
  const groups = new Map()
  for (const l of lines) {
    const effective = effectiveOf(l)
    if (!effective) continue
    const key = `${!!l.isVatable}|${effective.rate}|${!!effective.vatExempt}`
    if (!groups.has(key)) groups.set(key, { isVatable: !!l.isVatable, effective, lines: [], amts: [] })
    const g = groups.get(key)
    const price = priceOf(l, zeroRatedSale)
    g.lines.push(l); g.amts.push(discountedAmt(l, round2(l.quantity * price), price, qtys))
  }
  for (const g of groups.values()) g.total = round2(g.amts.reduce((a, v) => a + v, 0))
  return [...groups.values()]
}

/** The Restaurant pax split on the bill: each group's senior share is its total × seniors ÷ diners.
 *  Returns Map(line → [seniorPart, regularPart]) in discountLineAmount's shape. */
function paxSplit(lines, pax, effectiveOf, zeroRatedSale) {
  const groups = discountGroups(lines, effectiveOf, zeroRatedSale)
  // in whole centavos: total × seniors ÷ diners, never × a fraction (3/10 isn't exact in floating
  // point, so 1,066.95 × 0.3 came out 320.08 where 320.085 rounds to 320.09)
  return splitGroups(groups, groups.map(g => Math.round(Math.round(g.total * 100) * pax.seniorCount / pax.dinerCount) / 100))
}

/** The weekly cap on basic necessities (32): only the groups whose discount keeps the VAT (the 5%)
 *  are capped, never a VAT-exempt (20%) one. `cap` is the pesos those lines may take off the bill
 *  (what the customer saves, VAT included: the discount plus its VAT adjustment, which is 5% of the
 *  shelf price). Only part of each group's amount gets the discount (the rest is charged in full,
 *  as in a pax split), as large as it can be without going over the cap. Returns null when the
 *  full discount is already within it. */
function capSplit(lines, cap, effectiveOf, qtys = null) {
  const groups = discountGroups(lines, effectiveOf, false, qtys).filter(g => !g.effective.vatExempt)
  const discOf = (cents) => round2(groups.reduce((a, g, i) =>
    a + cents[i] / 100 - discountLineAmount(cents[i] / 100, g.isVatable, g.effective).finalAmount, 0))
  const whole = groups.map(g => Math.round(g.total * 100))
  const full = discOf(whole)
  if (!(full > cap)) return null
  const amts = whole.map(c => Math.floor(c * cap / full))
  const order = whole.map((c, i) => i).sort((a, b) => whole[b] - whole[a])
  for (let guard = 0; discOf(amts) > cap && guard < 100000; guard++) {
    const i = order.find(j => amts[j] > 0); if (i === undefined) break; amts[i]--
  }
  for (let grown = true, guard = 0; grown && guard < 100000; guard++) {
    grown = false
    for (const i of order) {
      if (amts[i] >= whole[i]) continue
      amts[i]++
      if (discOf(amts) <= cap) { grown = true; break }
      amts[i]--
    }
  }
  return splitGroups(groups, amts.map(c => c / 100))
}

/** Each group's discounted share (`seniorAmts`, pesos) and its regular share go through
 *  discountLineAmount() once, and each figure is shared out to the group's lines. */
function splitGroups(groups, seniorAmts) {
  const FIELDS = ['discountAmt', 'vatAdj', 'vatExemptPortion', 'vatablePortion', 'vatAmountPortion']
  const share = (whole, weights) => {
    const per = weights.map(() => ({ zeroRatedPortion: 0 }))
    for (const f of FIELDS) allocate(whole[f], weights).forEach((v, i) => { per[i][f] = v })
    return per
  }
  const out = new Map()
  groups.forEach((g, gi) => {
    const total = g.total
    const seniorAmt = seniorAmts[gi]
    const seniorShares = allocate(seniorAmt, g.amts)
    const regularShares = g.amts.map((a, i) => round2(a - seniorShares[i]))
    const senior = share(discountLineAmount(seniorAmt, g.isVatable, g.effective), seniorShares)
    const regular = share(discountLineAmount(round2(total - seniorAmt), g.isVatable, null), regularShares)
    g.lines.forEach((l, i) => {
      const s = senior[i], r = regular[i]
      // what's paid follows from the shared-out figures, the same way discountLineAmount builds it
      s.finalAmount = g.isVatable && !g.effective.vatExempt
        ? round2(s.vatablePortion + s.vatAmountPortion) : round2(s.vatExemptPortion - s.discountAmt)
      r.finalAmount = regularShares[i]
      if (g.isVatable) r.vatAmountPortion = round2(regularShares[i] - r.vatablePortion)
      out.set(l, [s, r])
    })
  })
  return out
}

/** A regular / other discount (code OTHER): a peso amount off the whole sale, shared out to
 *  every line by its amount. Not VAT-exempt: a VAT-able line's VAT is on what's left after its
 *  share (12/112 of it), a VAT-exempt item stays VAT-exempt; the buckets add up to what's paid. */
function otherDiscountPart(amt, share, isVatable) {
  const paid = round2(amt - share)
  const vatable = isVatable ? round2(paid / (1 + VAT_RATE)) : 0
  return {
    discountAmt: share, vatAdj: 0, finalAmount: paid,
    vatExemptPortion: isVatable ? 0 : paid, vatablePortion: vatable,
    vatAmountPortion: isVatable ? round2(paid - vatable) : 0, zeroRatedPortion: 0
  }
}

/** posTypeRates / posType: the till's rates per POS type (32). discountCap: what the senior's
 *  booklet still allows off the bill on basic necessities (the cashier's weekly cap; never more
 *  than BNPC_WEEKLY_CAP); booklet false = no booklet shown, so those lines get nothing. Neither
 *  touches a VAT-exempt (20%) line, and neither is used with a pax split. */
/** A line with promo-free units (34): `promo` pesos off it, VAT on what's paid (a VAT-exempt item
 *  stays VAT-exempt). With a senior/PWD discount whose rule for the item is VAT-exempt (the 20%),
 *  the promo is taken on the price without the VAT and the line stays VAT-exempt (RMC 38-2012 Q21:
 *  a promo-priced item bought by a senior is still VAT-exempt). */
function promoPart(amt, promo, isVatable, exempt) {
  if (!exempt) return otherDiscountPart(amt, promo, isVatable)
  const base = isVatable ? round2(amt / (1 + VAT_RATE)) : amt
  const paid = isVatable ? round2((amt - promo) / (1 + VAT_RATE)) : round2(amt - promo)
  return { discountAmt: round2(base - paid), vatAdj: 0, finalAmount: paid, vatExemptPortion: base,
    vatablePortion: 0, vatAmountPortion: 0, zeroRatedPortion: 0 }
}

/** discountQtys: { lineNo: qty }, the senior's own quantity of a line (takeout: 1 of 3 dinuguan);
 *  only that part gets the discount, the rest is charged in full. Not used with a pax split
 *  (the headcount decides there), a regular / other discount or a zero-rated sale. */
export function computeTotals(lines, discountType, types, categoryRates, pax, zeroRatedSale, otherAmount,
  posTypeRates, posType, discountCap, booklet = true, discountQtys = null) {
  let gross = 0, discount = 0, vatAdj = 0, vatExempt = 0, vatableNet = 0, vatAmount = 0,
    zeroRated = 0, net = 0, regularSale = 0, seniorSale = 0
  // Each line's own share of the figures below, keyed by lineNo. Saved on SaleItems so a
  // return can refund exactly that line's share (sp_ProcessReturn).
  const perLine = {}

  const seniorFraction = pax?.dinerCount > 0 ? pax.seniorCount / pax.dinerCount : 0
  // OTHER: the peso amount, never more than the sale, shared out by line amount (no pax split)
  // (a line at a wholesale price takes no share: it's already priced down, and the ERP expects no
  // discount on it)
  const other = !zeroRatedSale && discountType === OTHER_DISCOUNT && otherAmount > 0
    ? (() => {
        const amts = lines.map(l => round2(l.quantity * priceOf(l, zeroRatedSale)))
        const weights = lines.map((l, i) => (l.wholesale || l.promo ? 0 : amts[i]))
        const shares = allocate(Math.min(otherAmount, round2(weights.reduce((a, v) => a + v, 0))), weights)
        return new Map(lines.map((l, i) => [l, [otherDiscountPart(amts[i], shares[i], l.isVatable)]]))
      })()
    : null
  const effectiveOf = l => resolveDiscount(l, discountType, types, categoryRates, posTypeRates, posType)
  const keptCap = booklet === false ? 0 : Math.min(discountCap ?? BNPC_WEEKLY_CAP, BNPC_WEEKLY_CAP)
  const qtys = !other && !zeroRatedSale && !(seniorFraction > 0) ? discountQtys : null
  const split = !other && !zeroRatedSale && seniorFraction > 0
    ? paxSplit(lines, pax, effectiveOf, zeroRatedSale)
    : !other && !zeroRatedSale && discountType && discountType !== OTHER_DISCOUNT
    ? capSplit(lines, round2(Math.max(0, keptCap)), effectiveOf, qtys)
    : null
  // for the invoice: the VAT-exempt (20%) discount and the VAT-kept (5%) one on their own lines
  let discExempt = 0, discKept = 0, promoTotal = 0
  const ratesExempt = new Set(), ratesKept = new Set()

  for (const l of lines) {
    const unitPrice = priceOf(l, zeroRatedSale)
    const amt = round2(l.quantity * unitPrice)
    gross += amt
    const effective = zeroRatedSale ? null : effectiveOf(l)
    // promo-free units: their price off the line (on the price charged, so a zero-rated sale's too)
    const promoAmt = l.promo ? Math.min(amt, round2(l.promo.freeQty * unitPrice)) : 0
    const statOf = () => (discountType && discountType !== OTHER_DISCOUNT && !(seniorFraction > 0)
      ? resolveDiscount({ ...l, promo: null }, discountType, types, categoryRates, posTypeRates, posType) : null)
    // the senior's own part of the line (all of it unless a quantity was given), the rest at full price
    const dAmt = effective && qtys ? discountedAmt(l, amt, unitPrice, qtys) : amt
    const restPart = dAmt < amt ? [discountLineAmount(round2(amt - dAmt), l.isVatable, null)] : []
    const parts = zeroRatedSale && l.isVatable
      ? [{ discountAmt: promoAmt, vatAdj: 0, finalAmount: round2(amt - promoAmt), vatExemptPortion: 0, vatablePortion: 0,
           vatAmountPortion: 0, zeroRatedPortion: round2(amt - promoAmt) }]
      : promoAmt > 0
      ? [promoPart(amt, promoAmt, l.isVatable, !zeroRatedSale && !!statOf()?.vatExempt)]
      : other
      ? other.get(l)
      : split?.has(l)
      ? [...split.get(l), ...restPart]
      : restPart.length
      ? [discountLineAmount(dAmt, l.isVatable, effective), ...restPart]
      : [discountLineAmount(amt, l.isVatable, effective)]

    const own = { discount: 0, vatAdj: 0, vatExempt: 0, vatable: 0, vat: 0, zeroRated: 0, net: 0 }
    for (const r of parts) {
      own.discount += r.discountAmt; own.vatAdj += r.vatAdj; own.vatExempt += r.vatExemptPortion
      own.vatable += r.vatablePortion; own.vat += r.vatAmountPortion; own.zeroRated += r.zeroRatedPortion
      own.net += r.finalAmount
    }
    for (const k of Object.keys(own)) own[k] = round2(own[k])
    perLine[l.lineNo] = { ...own, unitPrice, lineTotal: amt,
      // the senior's own quantity when only part of the line got the discount (the cart and invoice say "1 of 3")
      discountQty: dAmt < amt && own.discount > 0 ? discountQtyOf(l, qtys) : null }
    if (promoAmt > 0) promoTotal += own.discount
    else if (effective && !other && own.discount > 0) {
      if (effective.vatExempt) { discExempt += own.discount; ratesExempt.add(effective.rate) }
      // the 5% keeps the VAT: what comes off the bill (discount, its VAT part and the centavo the
      // separate roundings leave), so no centavo falls into LESS VAT on a sale with no 20% line
      else {
        discKept += round2(amt - own.net); ratesKept.add(effective.rate)
        // a capped or pax-split line's figures are shared out separately; keep discount + VAT adj
        // = what came off this line
        own.vatAdj = Math.max(0, round2(amt - own.net - own.discount))
        perLine[l.lineNo] = { ...perLine[l.lineNo], vatAdj: own.vatAdj, kept: true }
      }
    }

    discount += own.discount; vatAdj += own.vatAdj; vatExempt += own.vatExempt
    vatableNet += own.vatable; vatAmount += own.vat; zeroRated += own.zeroRated
    net += own.net
    if (parts.length >= 2) { seniorSale += parts[0].finalAmount; for (const r of parts.slice(1)) regularSale += r.finalAmount }
    else regularSale += own.net
  }

  return {
    gross: round2(gross),
    discount: round2(discount),
    vatAdj: round2(vatAdj),
    vatExempt: round2(vatExempt),
    vatable: round2(vatableNet),
    vat: round2(vatAmount),
    zeroRated: round2(zeroRated),
    net: round2(net),
    regularSale: round2(regularSale),
    seniorSale: round2(seniorSale),
    // the invoice's breakdown: gross − lessVat − discExempt − discKept = net (with no other discount)
    discExempt: round2(discExempt),
    discKept: round2(discKept),
    promo: round2(promoTotal),   // 34: promo-free units, part of `discount`
    other: other ? round2(discount - promoTotal) : 0,
    lessVat: other ? 0 : round2(gross - net - discExempt - discKept - promoTotal),
    rateExempt: ratesExempt.size === 1 ? [...ratesExempt][0] : null,
    rateKept: ratesKept.size === 1 ? [...ratesKept][0] : null,
    perLine
  }
}

/** The discount without a removed line's senior's quantity. */
function dropQty(discount, lineNo) {
  if (!discount?.qtys || discount.qtys[lineNo] == null) return discount
  const { [lineNo]: _, ...rest } = discount.qtys
  return { ...discount, qtys: Object.keys(rest).length ? rest : null }
}

/* ---------------- Auth ---------------- */
const ls = (k, d = '') => localStorage.getItem(k) ?? d

export const useAuth = create((set) => ({
  token: localStorage.getItem('pos_token'),
  userId: Number(ls('pos_userId')) || null,
  username: ls('pos_username'),
  fullName: ls('pos_fullName'),
  role: ls('pos_role'),
  branchCode: ls('pos_branchCode'),
  branches: JSON.parse(ls('pos_branches', '[]')),
  /** r.token is null after an OFFLINE sign-in (lib/offlineAuth.js): sales queue as usual and
   *  sync after the cashier signs in again online. */
  setAuth: (r) => {
    if (r.token) localStorage.setItem('pos_token', r.token)
    else localStorage.removeItem('pos_token')
    localStorage.setItem('pos_userId', String(r.userId))
    localStorage.setItem('pos_username', r.username)
    localStorage.setItem('pos_fullName', r.fullName)
    localStorage.setItem('pos_role', r.role)
    localStorage.setItem('pos_branchCode', r.branchCode)
    localStorage.setItem('pos_branches', JSON.stringify(r.branches || []))
    set({ token: r.token, userId: r.userId, username: r.username, fullName: r.fullName,
          role: r.role, branchCode: r.branchCode, branches: r.branches || [] })
  },
  setBranch: (branchCode) => {
    localStorage.setItem('pos_branchCode', branchCode)
    set({ branchCode })
  },
  logout: () => {
    ['pos_token','pos_userId','pos_username','pos_fullName','pos_role','pos_branchCode','pos_branches']
      .forEach(k => localStorage.removeItem(k))
    set({ token: null, userId: null, username: '', fullName: '', role: '', branchCode: '', branches: [] })
  }
}))

/* ---------------- Shift ---------------- */
export const useShift = create((set) => ({
  shiftUid: localStorage.getItem('pos_shiftUid'),
  terminalId: Number(ls('pos_terminalId')) || null,
  terminalCode: ls('pos_terminalCode'),
  businessDate: ls('pos_businessDate'),
  cashBegin: Number(ls('pos_cashBegin')) || 0,
  cashierUserId: Number(ls('pos_cashierUserId')) || null,   // whose shift this is (offline resume)
  setShift: (s) => {
    Object.entries(s).forEach(([k, v]) => localStorage.setItem('pos_' + k, String(v ?? '')))
    set(s)
  },
  clearShift: () => {
    ['pos_shiftUid','pos_businessDate','pos_cashBegin','pos_cashierUserId'].forEach(k => localStorage.removeItem(k))
    set({ shiftUid: null, businessDate: '', cashBegin: 0, cashierUserId: null })
  }
}))

/* ---------------- Cart ---------------- */
export const useCart = create((set, get) => ({
  lines: [],
  discount: null,        // { type, controlNo, name, cap?, qtys?, approvedBy? } (qtys: the senior's own quantity per lineNo); OTHER: { type, amount, name: reason, approvedBy }
  discountTypes: DEFAULT_DISCOUNT_TYPES,
  categoryRates: [],      // [{ discountCode, categoryId, vatExempt, rate }] — RA 9994-style overrides
  posTypeRates: [],       // [{ discountCode, posType, categoryId|null, vatExempt, rate }] (32)
  posType: 'Retail',      // this till's POS type (the terminal's, else the branch's)
  pax: null,              // Restaurant PosType only: { dinerCount, seniorCount }, set at Generate Bill
  customer: null,         // BIR: { name, address, tin, businessStyle } printed on the invoice
  zeroRated: null,        // a zero-rated sale: { certNo, approvedBy } (buyer = customer, required)
  loyalty: null,          // suki card: { cardNo, customerName, points (null = not checked: offline) }
  priceLevel: null,       // 1-4: the whole sale at Price1..4 (an item without one stays at SellingPrice)
  priceLevelApprovedBy: null,   // 36: the supervisor who OK'd the sale's level (new lines carry it)
  priceLevelBy: null,     // 40: 'schedule' when the time-of-day schedule set the sale's level, 'cashier' when picked
  promos: [],             // the branch's promos (34), from Cash Begin; see applyPromos()
  cancelled: [],          // 35: lines removed while the Cancel line approval is on (audit only, sent with the sale)

  setDiscountTypes: (t) => set({ discountTypes: t }),
  setCategoryRates: (r) => set({ categoryRates: r }),
  setPosTypeRates: (r) => set({ posTypeRates: r }),
  setPosType: (posType) => set({ posType: posType || 'Retail' }),
  setPromos: (promos) => set((st) => ({ promos: promos || [], lines: reprice({ ...st, promos: promos || [] }) })),
  setPax: (pax) => set((st) => ({ pax, lines: reprice({ ...st, pax }) })),
  setCustomer: (customer) => set({ customer }),
  setZeroRated: (zeroRated) => set((st) => ({ zeroRated, lines: reprice({ ...st, zeroRated }) })),
  setLoyalty: (loyalty) => set({ loyalty }),

  /** weight: from a scale sticker (lib/scale.js). A weighed item is always its own line —
   *  two stickers of the same product weigh differently — and its quantity is the weight. */
  addProduct: (p, weight = null) => set((st) => {
    const price = levelPrice(p.price, p.levels, st.priceLevel)
    // another of an item already in the cart goes on its line, at that line's price level
    const ex = !weight && st.lines.find(l => l.productId === p.productId
      && l.unitPrice === l.origUnitPrice && !l.weighed)
    if (ex) return { lines: reprice(st, st.lines.map(l => l === ex ? { ...l, quantity: round2(l.quantity + 1) } : l)) }
    const lineNo = st.lines.length ? Math.max(...st.lines.map(l => l.lineNo)) + 1 : 1
    return {
      lines: reprice(st, [...st.lines, {
        lineNo, productId: p.productId, barcode: p.barcode, productName: p.productName,
        categoryId: p.categoryId, quantity: weight ? Math.round(weight * 1000) / 1000 : 1,
        unitPrice: price, origUnitPrice: price, basePrice: price, shelfPrice: p.price, levels: p.levels || null,
        priceLevel: st.priceLevel && price !== p.price ? st.priceLevel : null,
        levelApprovedBy: st.priceLevel && price !== p.price ? st.priceLevelApprovedBy : null,
        tiers: p.wholesale?.length ? p.wholesale : null, weighed: !!weight,
        isVatable: p.isVatable, isDiscountable: p.isDiscountable, allowPriceEdit: p.allowPriceEdit
      }])
    }
  }),

  setQty: (lineNo, qty) => set((st) => {
    if (qty > 0) return { lines: reprice(st, st.lines.map(l => l.lineNo === lineNo ? { ...l, quantity: round2(qty) } : l)) }
    const s2 = { ...st, discount: dropQty(st.discount, lineNo) }
    return { discount: s2.discount, lines: reprice(s2, st.lines.filter(l => l.lineNo !== lineNo)) }
  }),

  /** approvedBy: the supervisor who OK'd the change (null when none was needed). Saved on
   *  the sale line (SaleItems.PriceApprovedBy). */
  setPrice: (lineNo, price, approvedBy = null) => set((st) => ({
    lines: st.lines.map(l => l.lineNo === lineNo
      ? { ...l, unitPrice: round2(price), priceApprovedBy: round2(price) === l.origUnitPrice ? null : approvedBy }
      : l)
  })),

  /** The sale's price level (null = SellingPrice). Every line moves to that level's price; a
   *  line whose price a supervisor changed keeps it (now measured against the new level). */
  // approvedBy (36): the supervisor when the till's Price level approval is on
  setPriceLevel: (level, approvedBy = null, by = 'cashier') => set((st) => ({
    priceLevel: level || null,
    priceLevelApprovedBy: level ? approvedBy : null,
    priceLevelBy: by,
    lines: reprice(st, st.lines.map(l => withApprover(atLevel(l, level || null), approvedBy)))
  })),

  /** One line at Price1..4 (null = SellingPrice), the rest of the sale unchanged. resetPrice
   *  (from Edit price): a price a supervisor changed goes too, the line is at the level's price. */
  setLinePriceLevel: (lineNo, level, resetPrice = false, approvedBy = null) => set((st) => ({
    lines: reprice(st, st.lines.map(l => {
      if (l.lineNo !== lineNo) return l
      const x = withApprover(atLevel(l, level || null), approvedBy)
      return resetPrice ? { ...x, unitPrice: x.basePrice, origUnitPrice: x.basePrice, priceApprovedBy: null } : x
    }))
  })),

  /** approvedBy: given when the Cancel line approval is on (35), the supervisor who OK'd it (or
   *  the Supervisor / Admin signed in); the removed line is then kept for the audit. */
  removeLine: (lineNo, approvedBy = null) => set((st) => {
    const l = st.lines.find(x => x.lineNo === lineNo)
    // a new line can take this lineNo again, so its senior's quantity must not stay behind
    const s2 = { ...st, discount: dropQty(st.discount, lineNo) }
    return {
      discount: s2.discount,
      lines: reprice(s2, st.lines.filter(x => x.lineNo !== lineNo)),
      cancelled: l && approvedBy != null
        ? [...st.cancelled, { productId: l.productId, productName: l.productName, quantity: l.quantity, unitPrice: l.unitPrice, approvedBy }]
        : st.cancelled
    }
  }),
  setDiscount: (discount) => set((st) => ({ discount, lines: reprice({ ...st, discount }) })),
  clear: () => set({ lines: [], discount: null, pax: null, customer: null, loyalty: null, zeroRated: null, priceLevel: null, priceLevelApprovedBy: null, priceLevelBy: null, cancelled: [] }),

  /** Hold / Recall: everything that makes up the sale (the same fields clear() empties), not the
   *  till's rates or promos. restore() reprices with the promos running now. */
  snapshot: () => {
    const { lines, discount, pax, customer, loyalty, zeroRated, priceLevel, priceLevelApprovedBy, priceLevelBy, cancelled } = get()
    return { lines, discount, pax, customer, loyalty, zeroRated, priceLevel, priceLevelApprovedBy, priceLevelBy, cancelled }
  },
  restore: (s) => set((st) => {
    const sale = { discount: null, pax: null, customer: null, loyalty: null, zeroRated: null, priceLevel: null,
      priceLevelApprovedBy: null, priceLevelBy: null, cancelled: [], ...s, lines: s.lines || [] }
    return { ...sale, lines: reprice({ ...st, ...sale }, sale.lines) }
  }),

  /** Generate Bill (dine-in): loads a table's server-tracked order items into this same
   *  cart, so the existing discount/pay flow works unchanged from here. Server rows are
   *  PascalCase (Dapper dynamic results serialize with the raw SQL column names). */
  // catalog: { productId: product } from the cached price list, for the items' price levels
  loadFromOrder: (items, catalog = {}) => set({
    lines: applyWholesale(items.map(i => ({
      lineNo: i.LineNo, productId: i.ProductId, barcode: i.Barcode, productName: i.ProductName,
      categoryId: i.CategoryId, quantity: Number(i.Quantity), unitPrice: Number(i.UnitPrice),
      origUnitPrice: Number(i.UnitPrice), isVatable: !!i.IsVatable, isDiscountable: !!i.IsDiscountable,
      allowPriceEdit: false, shelfPrice: Number(i.UnitPrice), basePrice: Number(i.UnitPrice),
      levels: catalog[i.ProductId]?.levels || null, tiers: catalog[i.ProductId]?.wholesale?.length ? catalog[i.ProductId].wholesale : null
    }))),
    priceLevel: null,
    priceLevelApprovedBy: null,
    priceLevelBy: null,
    discount: null,
    pax: null,
    customer: null,
    loyalty: null,
    zeroRated: null,
    cancelled: []
  }),

  totals: () => totalsOf(get(), get().lines),
  /** What a discount type would take off this cart's bill, with the booklet shown and no weekly cap
   *  entered (so at most BNPC_WEEKLY_CAP on basic necessities, and the wholesale choice it brings):
   *  `total`, and `kept`, the part of it on basic necessities (the 5% a weekly cap can lower). */
  discountFor: (type, qtys = null) => {
    const st = { ...get(), discount: { type, qtys }, zeroRated: null }
    const t = totalsOf(st, reprice(st))
    return { total: round2(t.gross - t.net), kept: t.discKept, perLine: t.perLine }
  },
  /** A line's rate and VAT treatment for a discount type at this till (null = none: not
   *  discountable, at a wholesale price or with promo-free units). */
  lineRate: (line, type) => {
    const st = get()
    return resolveDiscount(line, type, st.discountTypes, st.categoryRates, st.posTypeRates, st.posType)
  },
  /** "B1T1 Siomai: add 1 more, free" for the cart. */
  hints: () => promoHints(get(), get().lines),
  // the line's own share of the discount, from the same totals the sale saves (a pax split is
  // worked out on the bill, so a line can't compute its share on its own)
  lineDiscount: (line) => get().totals().perLine[line.lineNo]?.discount || 0,
  linePrice: (line) => priceOf(line, !!get().zeroRated)
}))

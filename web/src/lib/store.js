import { create } from 'zustand'

export const VAT_RATE = 0.12
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
export const peso = (n) =>
  Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
export function resolveDiscount(line, discountType, types, categoryRates) {
  if (!discountType || !line.isDiscountable) return null
  const d = (types || DEFAULT_DISCOUNT_TYPES).find(t => t.code === discountType)
  if (!d) return null
  const override = (categoryRates || []).find(
    r => r.discountCode === discountType && r.categoryId === line.categoryId)
  return override ? { rate: override.rate, vatExempt: override.vatExempt } : { rate: d.rate, vatExempt: d.vatExempt }
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
    return {
      discountAmt: 0, vatAdj: 0, finalAmount: amt,
      vatExemptPortion: 0, vatablePortion: isVatable ? netOfVat : 0,
      vatAmountPortion: isVatable ? round2(amt - netOfVat) : 0, zeroRatedPortion: isVatable ? 0 : amt
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
    const vatAdj = round2(round2(amt * effective.rate) - discountAmt)
    return {
      discountAmt, vatAdj, finalAmount: round2(netAfterDiscount + vatAmountPortion),
      vatExemptPortion: 0, vatablePortion: netAfterDiscount, vatAmountPortion, zeroRatedPortion: 0
    }
  }
  // Never vatable to begin with (e.g. a zero-rated basic good) — flat discount, no VAT math.
  return {
    discountAmt, vatAdj: 0, finalAmount: netAfterDiscount,
    vatExemptPortion: netOfVat, vatablePortion: 0, vatAmountPortion: 0, zeroRatedPortion: 0
  }
}

/** Per-item discount amount shown on the cart line — the senior-portion share only, when a
 *  Restaurant pax split (see below) applies. */
export function lineDiscountOf(line, discountType, types, categoryRates, pax) {
  const effective = resolveDiscount(line, discountType, types, categoryRates)
  if (!effective) return 0
  const amt = round2(line.quantity * line.unitPrice)
  const base = pax?.dinerCount > 0 ? round2(amt * (pax.seniorCount / pax.dinerCount)) : amt
  return discountLineAmount(base, line.isVatable, effective).discountAmt
}

/**
 * `pax`: Restaurant PosType only — { dinerCount, seniorCount } captured at Generate Bill.
 * When present, each discountable line is split by headcount fraction (seniorCount/
 * dinerCount) — only that fraction is discounted; the rest is a normal, undiscounted
 * regular-sale portion. Omit `pax` (or leave dinerCount falsy) for the ordinary
 * whole-line-or-nothing behavior Retail/Pharmacy/takeout use.
 */
export function computeTotals(lines, discountType, types, categoryRates, pax) {
  let gross = 0, discount = 0, vatAdj = 0, vatExempt = 0, vatableNet = 0, vatAmount = 0,
    zeroRated = 0, net = 0, regularSale = 0, seniorSale = 0

  const seniorFraction = pax?.dinerCount > 0 ? pax.seniorCount / pax.dinerCount : 0

  for (const l of lines) {
    const amt = round2(l.quantity * l.unitPrice)
    gross += amt
    const effective = resolveDiscount(l, discountType, types, categoryRates)

    if (effective && seniorFraction > 0) {
      const seniorAmt = round2(amt * seniorFraction)
      const regularAmt = round2(amt - seniorAmt)
      const rSenior = discountLineAmount(seniorAmt, l.isVatable, effective)
      const rRegular = discountLineAmount(regularAmt, l.isVatable, null)
      for (const r of [rSenior, rRegular]) {
        discount += r.discountAmt; vatAdj += r.vatAdj; vatExempt += r.vatExemptPortion
        vatableNet += r.vatablePortion; vatAmount += r.vatAmountPortion; zeroRated += r.zeroRatedPortion
        net += r.finalAmount
      }
      seniorSale += rSenior.finalAmount
      regularSale += rRegular.finalAmount
    } else {
      const r = discountLineAmount(amt, l.isVatable, effective)
      discount += r.discountAmt; vatAdj += r.vatAdj; vatExempt += r.vatExemptPortion
      vatableNet += r.vatablePortion; vatAmount += r.vatAmountPortion; zeroRated += r.zeroRatedPortion
      net += r.finalAmount
      regularSale += r.finalAmount
    }
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
    seniorSale: round2(seniorSale)
  }
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
  setAuth: (r) => {
    localStorage.setItem('pos_token', r.token)
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
  setShift: (s) => {
    Object.entries(s).forEach(([k, v]) => localStorage.setItem('pos_' + k, String(v ?? '')))
    set(s)
  },
  clearShift: () => {
    ['pos_shiftUid','pos_businessDate','pos_cashBegin'].forEach(k => localStorage.removeItem(k))
    set({ shiftUid: null, businessDate: '', cashBegin: 0 })
  }
}))

/* ---------------- Cart ---------------- */
export const useCart = create((set, get) => ({
  lines: [],
  discount: null,        // { type, controlNo, name }
  discountTypes: DEFAULT_DISCOUNT_TYPES,
  categoryRates: [],      // [{ discountCode, categoryId, vatExempt, rate }] — RA 9994-style overrides
  pax: null,              // Restaurant PosType only: { dinerCount, seniorCount }, set at Generate Bill

  setDiscountTypes: (t) => set({ discountTypes: t }),
  setCategoryRates: (r) => set({ categoryRates: r }),
  setPax: (pax) => set({ pax }),

  addProduct: (p) => set((st) => {
    const ex = st.lines.find(l => l.productId === p.productId && l.unitPrice === p.price)
    if (ex) return { lines: st.lines.map(l => l === ex ? { ...l, quantity: round2(l.quantity + 1) } : l) }
    const lineNo = st.lines.length ? Math.max(...st.lines.map(l => l.lineNo)) + 1 : 1
    return {
      lines: [...st.lines, {
        lineNo, productId: p.productId, barcode: p.barcode, productName: p.productName,
        categoryId: p.categoryId, quantity: 1, unitPrice: p.price, origUnitPrice: p.price,
        isVatable: p.isVatable, isDiscountable: p.isDiscountable, allowPriceEdit: p.allowPriceEdit
      }]
    }
  }),

  setQty: (lineNo, qty) => set((st) => ({
    lines: qty <= 0 ? st.lines.filter(l => l.lineNo !== lineNo)
      : st.lines.map(l => l.lineNo === lineNo ? { ...l, quantity: round2(qty) } : l)
  })),

  setPrice: (lineNo, price) => set((st) => ({
    lines: st.lines.map(l => l.lineNo === lineNo ? { ...l, unitPrice: round2(price) } : l)
  })),

  removeLine: (lineNo) => set((st) => ({ lines: st.lines.filter(l => l.lineNo !== lineNo) })),
  setDiscount: (discount) => set({ discount }),
  clear: () => set({ lines: [], discount: null, pax: null }),

  /** Generate Bill (dine-in): loads a table's server-tracked order items into this same
   *  cart, so the existing discount/pay flow works unchanged from here. Server rows are
   *  PascalCase (Dapper dynamic results serialize with the raw SQL column names). */
  loadFromOrder: (items) => set({
    lines: items.map(i => ({
      lineNo: i.LineNo, productId: i.ProductId, barcode: i.Barcode, productName: i.ProductName,
      categoryId: i.CategoryId, quantity: Number(i.Quantity), unitPrice: Number(i.UnitPrice),
      origUnitPrice: Number(i.UnitPrice), isVatable: !!i.IsVatable, isDiscountable: !!i.IsDiscountable,
      allowPriceEdit: false
    })),
    discount: null,
    pax: null
  }),

  totals: () => computeTotals(get().lines, get().discount?.type, get().discountTypes, get().categoryRates, get().pax),
  lineDiscount: (line) => lineDiscountOf(line, get().discount?.type, get().discountTypes, get().categoryRates, get().pax)
}))

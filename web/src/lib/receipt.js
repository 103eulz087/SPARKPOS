import { peso, round2 } from './store'

/** 58mm prints 32 columns, 80mm prints 48 (the two common thermal-printer widths) —
 *  per-terminal (Terminals.PaperWidth) or per-print-area (PrintAreas.PaperWidth), mirrors
 *  ReceiptBuilder.Columns() server-side. Anything else falls back to 58mm's 32 columns. */
export const columnsFor = (paperWidthMm) => (Number(paperWidthMm) >= 80 ? 48 : 32)

const ctr = (w, s) => (s.length >= w ? s.slice(0, w) : ' '.repeat(Math.floor((w - s.length) / 2)) + s)
const lr = (w, l, r) => {
  const gap = w - l.length - r.length
  return gap > 0 ? l + ' '.repeat(gap) + r : `${l} ${r}`
}
const rule = (w) => '-'.repeat(w)

/** BIR Sales Invoice No.: always 18 digits, zero-padded. Return numbers are 6 digits.
 *  Mirrors ReceiptBuilder.Si()/Rtn() server-side. */
export const siNo = (n) => (n == null || n === '' ? '-' : String(n).padStart(18, '0'))
export const returnNo = (n) => (n == null || n === '' ? '-' : String(n).padStart(6, '0'))

/** Fixed format so the printed date never depends on the device's locale settings:
 *  10/26/2026 02:05:33 PM */
export function fmtDateTime(value) {
  const d = new Date(value)
  const p2 = (n) => String(n).padStart(2, '0')
  const h = d.getHours() % 12 || 12
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()} ` +
    `${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

/** A labelled field that wraps at word boundaries (continuation lines indented two spaces)
 *  instead of being cut off; blank prints a line to write on. */
function fieldLines(w, label, value) {
  const v = (value || '').trim().replace(/\s+/g, ' ')
  if (!v) return [label + '_'.repeat(Math.max(1, w - label.length))]
  const out = []
  let cur = label.trimEnd()
  for (let word of v.split(' ')) {
    while (word.length > w - 2) {               // a single word longer than a line: hard-split it
      if (cur.trim()) { out.push(cur); cur = ' ' }
      out.push(' ' + cur.trimStart() + word.slice(0, w - 2)); word = word.slice(w - 2); cur = ' '
    }
    if (!word) continue
    if ((cur + ' ' + word).length <= w) cur = cur + ' ' + word
    else { out.push(cur); cur = '  ' + word }
  }
  out.push(cur)
  return out.map(l => l.replace(/^ (\S)/, '  $1'))
}

/** BIR: customer name, address, TIN and business style on every invoice (blank lines when
 *  the customer gave none, so they can be filled in by hand). */
function customerLines(w, c = {}) {
  return [
    ...fieldLines(w, 'Sold to: ', c.customerName),
    ...fieldLines(w, 'Address: ', c.customerAddress),
    ...fieldLines(w, 'TIN: ', c.customerTin),
    ...fieldLines(w, 'Bus. Style: ', c.customerBusinessStyle)
  ]
}

/** Word-wraps text to lines of at most w characters (a word longer than a line is split). */
function wrapWords(w, text) {
  const out = []
  let cur = ''
  for (let word of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      if (cur) { out.push(cur); cur = '' }
      out.push(word.slice(0, w)); word = word.slice(w)
    }
    if (!word) continue
    if (!cur) cur = word
    else if ((cur + ' ' + word).length <= w) cur += ' ' + word
    else { out.push(cur); cur = word }
  }
  if (cur) out.push(cur)
  return out
}
/** Centered and wrapped, so nothing on the BIR header is ever cut off. */
const ctrWrap = (w, text) => wrapWords(w, text).map(l => ctr(w, l))

/** Store + BIR machine header, shared by the invoice and the return receipt. */
function headerLines(w, { branch = {}, terminal = {}, settings = {} }) {
  const out = []
  out.push(...ctrWrap(w, settings.StoreHeader1 || 'SPARKPOS'))
  if (settings.StoreHeader2 || branch.BranchName) out.push(...ctrWrap(w, settings.StoreHeader2 || branch.BranchName))
  if (branch.Address) out.push(...ctrWrap(w, branch.Address))
  if (terminal.Tin) out.push(...ctrWrap(w, `VAT REG TIN ${terminal.Tin}`))
  if (terminal.MinNo) out.push(...ctrWrap(w, `MIN ${terminal.MinNo}`))
  if (terminal.SerialNo || terminal.PermitNo) {
    const both = `SN ${terminal.SerialNo || '-'} PTU ${terminal.PermitNo || '-'}`
    if (both.length <= w) out.push(ctr(w, both))
    else out.push(...ctrWrap(w, `SN ${terminal.SerialNo || '-'}`), ...ctrWrap(w, `PTU ${terminal.PermitNo || '-'}`))
  }
  if (terminal.AccreditationNo) out.push(...ctrWrap(w, `ACCR ${terminal.AccreditationNo}`))
  out.push('')
  return out
}

function vatLines(w, x) {
  const out = [
    lr(w, 'VATable Sales', peso(x.vatableAmount)),
    lr(w, 'VAT (12%)', peso(x.vatAmount)),
    lr(w, 'VAT-Exempt Sales', peso(x.vatExemptAmount)),
    lr(w, 'Zero-Rated Sales', peso(x.zeroRatedAmount))
  ]
  // Informational only — VAT forgone on lines discounted but still VATable (e.g. a 5%
  // prime-commodity rate). Already netted into VATable Sales/VAT above, NOT a further
  // deduction from Amount Due. See CLAUDE.md's discount-configuration notes.
  if (x.vatAdjustment > 0) out.push(lr(w, 'VAT Adjustment (info)', peso(x.vatAdjustment)))
  return out
}

function footerLines(w, settings = {}) {
  const out = []
  if (settings.ReceiptFooter) {
    for (const line of settings.ReceiptFooter.split('\n')) out.push(...(line.trim() ? ctrWrap(w, line) : ['']))
  }
  return out
}

/** BIR reprint: the stored text exactly as it first printed (same date and time, same
 *  everything), under a REPRINT label. A voided invoice also says so. */
/** A sale with a discount (any type: SC, PWD, NAAC, MOV, Solo parent, regular / other) prints twice
 *  in one job (the user, 2026-11-20): CUSTOMER COPY, a paper cut, then ACCOUNTING COPY for the store's
 *  files. The invoice stored for reprints stays the single, unlabelled text. The cut is GS V 1 after a
 *  feed (no NUL byte, so the text also survives the server's print queue). */
export function discountCopies(storedText, paperWidthMm) {
  const w = columnsFor(paperWidthMm)
  const copy = (label) => ctr(w, `*** ${label} ***`) + '\n' + storedText
  return copy('CUSTOMER COPY') + '\n\n\n\n\x1dV\x01' + copy('ACCOUNTING COPY')
}
export const hasDiscountCopies = (sale) => !!sale.discountCode && Number(sale.discountAmount) > 0

export function reprintText(storedText, paperWidthMm, { voided = false } = {}) {
  const w = columnsFor(paperWidthMm)
  const label = [ctr(w, '*** REPRINT ***')]
  if (voided) label.push(ctr(w, '*** VOIDED ***'))
  return label.join('\n') + '\n' + storedText
}

/**
 * BIR Sales Invoice.
 * ctx: { branch, terminal, settings, cashier }
 * The BIR header (TIN, MIN, Serial, Permit) comes from the terminal record —
 * each registered machine prints its own credentials. Width comes from
 * terminal.PaperWidth (58 or 80mm). The text this returns is stored with the sale
 * (Sales.ReceiptText) and is what a reprint prints — see reprintText(). `reprint` is
 * only for older sales saved before the text was kept.
 */
export function buildReceipt(sale, ctx, { reprint = false } = {}) {
  const { branch = {}, terminal = {}, settings = {}, cashier = '' } = ctx
  const w = columnsFor(terminal.PaperWidth)
  const out = headerLines(w, ctx)

  out.push(ctr(w, 'SALES INVOICE'))
  if (sale.zeroRatedCertNo) out.push(ctr(w, 'ZERO-RATED SALE'))
  if (reprint) out.push(ctr(w, '*** REPRINT ***'))
  if (sale.status === 'Voided') out.push(ctr(w, '*** VOIDED ***'))

  out.push(`SI No. ${siNo(sale.orNumber)}`)
  out.push(`Date: ${fmtDateTime(sale.saleDateTime)}`)
  out.push(`Terminal: ${sale.branchCode}/${terminal.TerminalCode || ''}`.slice(0, w))
  out.push(`Cashier: ${cashier}`.slice(0, w))
  // the sale was rung up at a price level (Price1..4) instead of the regular price
  if (sale.priceLevelName) out.push(`Price level: ${sale.priceLevelName}`.slice(0, w))
  out.push(rule(w))
  out.push(...customerLines(w, sale))
  // a zero-rated buyer's PEZA / BOI certificate or diplomatic ID
  if (sale.zeroRatedCertNo) out.push(...fieldLines(w, 'Cert/ID No.: ', sale.zeroRatedCertNo))
  out.push(rule(w))

  for (const l of sale.items) {
    out.push(...wrapWords(w, l.productName))
    const lineAmt = round2(l.quantity * l.unitPrice)
    // * marks a price changed at the till (the original stays on the sale for the audit)
    // (a zero-rated line's price is the shelf price without the VAT, not a change at the till)
    out.push(lr(w, `  ${l.quantity} x ${peso(l.unitPrice)}${l.unitPrice !== l.origUnitPrice && !l.zeroRated ? '*' : ''}`, peso(lineAmt)))
    // a line at another price level than the sale's (35: picked for this item)
    if (l.priceLevelName) out.push(...wrapWords(w, `    ${l.priceLevelName}`))
    // a wholesale price by quantity (33): the regular price and the amount off each
    if (l.wholesale) out.push(...wrapWords(w, `    Wholesale: reg ${peso(l.wholesale.regularPrice)} less ${peso(l.wholesale.amountOff)}`))
    if (l.promo && l.lineDiscount > 0) {
      // a promo (34): its name, then the free units' price off
      out.push(...wrapWords(w, `  Promo: ${l.promo.promoName}`))
      out.push(lr(w, `    less ${l.promo.freeQty} free`, `-${peso(l.lineDiscount)}`))
    } else if (l.lineDiscount > 0) {
      // the 5% that keeps the VAT: the discount plus its VAT part, as the total line shows it
      // only the senior's own quantity of the line got it: "less SENIOR (1 of 3)"
      const part = l.discountQty != null ? ` (${l.discountQty} of ${l.quantity})` : ''
      out.push(lr(w, `    less ${sale.discountCode}${part}`, `-${peso(l.bnpc ? round2(lineAmt - l.netAmount) : round2(l.lineDiscount + (Number(l.vatAdjustment) || 0)))}`))
    }
  }

  out.push(rule(w))
  out.push(lr(w, 'GROSS AMOUNT', peso(sale.grossAmount)))
  if (sale.discountAmount > 0) {
    const b = sale.discountBreakdown
    const statutory = sale.discountCode && sale.discountCode !== 'OTHER'
    if (sale.dinerCount && statutory) out.push(lr(w, `  Diners ${sale.dinerCount} (SC/PWD ${sale.seniorCount || 0})`, ''))
    if (b) {
      // RMC 38-2012 Q24-26: the VAT taken off (VAT-exempt part) and each discount on its own line,
      // so gross less these is the amount due. The 5% on basic necessities keeps the VAT (JAO 24-02).
      const pct = (r) => (r ? ` ${Math.round(r * 100)}%` : '')
      if (b.lessVat > 0) out.push(lr(w, 'LESS VAT (EXEMPT)', `-${peso(b.lessVat)}`))
      if (b.promo > 0) out.push(lr(w, 'LESS PROMOS', `-${peso(b.promo)}`))
      if (b.other > 0) out.push(lr(w, 'LESS OTHER DISCOUNT', `-${peso(b.other)}`))
      if (b.exempt > 0) out.push(lr(w, `LESS ${sale.discountCode} DISC${pct(b.rateExempt)}`, `-${peso(b.exempt)}`))
      if (b.kept > 0) {
        // the 5% on basic necessities (BNPC); two lines when it doesn't fit (58 mm paper)
        const head = `LESS ${sale.discountCode}${pct(b.rateKept)}`, what = '(GROCERY/BASIC COMM)', amt = `-${peso(b.kept)}`
        if (head.length + what.length + amt.length + 2 <= w) out.push(lr(w, `${head} ${what}`, amt))
        else out.push(head, lr(w, `  ${what}`, amt))
      }
      if (b.noBooklet) out.push(...wrapWords(w, '  No booklet: no 5% on grocery/basic comm.'))
    } else if (sale.discountCode === 'OTHER') {
      out.push(lr(w, 'LESS OTHER DISCOUNT', `-${peso(sale.discountAmount)}`))
    } else {
      out.push(lr(w, `TOTAL ${sale.discountCode} DISCOUNT`, `-${peso(sale.discountAmount)}`))
    }
    if (sale.discountCode === 'OTHER') {
      // a regular / other discount: no ID to sign for, the reason instead
      if (sale.discountName) out.push(...fieldLines(w, '  Reason: ', sale.discountName))
    } else if (statutory) {
      out.push(lr(w, `  Ctrl# ${sale.discountCtrlNo || ''}`, ''))
      out.push(lr(w, `  Name: ${(sale.discountName || '').slice(0, 28)}`, ''))
      // limited to what the senior's booklet still allowed this week (32)
      if (sale.discountCap != null) out.push(lr(w, '  Weekly cap applied', peso(sale.discountCap)))
      out.push('  Signature: ' + '_'.repeat(w - 13))
    }
  }
  out.push(lr(w, 'AMOUNT DUE', peso(sale.netAmount)))
  out.push(rule(w))

  for (const p of sale.payments) {
    if (p.paymentType === 'CASH') out.push(lr(w, 'CASH', peso(p.amount)))
    else if (p.paymentType === 'GC') {
      // 38: no change on a gift certificate; what it doesn't pay is forfeited
      out.push(lr(w, 'GIFT CERT', peso(p.amount)))
      out.push(lr(w, `  No. ${String(p.gcNo || '').slice(0, w - 6)}`, ''))
      const left = round2((Number(p.gcValue) || 0) - p.amount)
      if (left > 0) out.push(lr(w, `  Value ${peso(p.gcValue)}, forfeited`, peso(left)))
    } else {
      out.push(lr(w, `CARD ${(p.cardBank || '').slice(0, 14)}`, peso(p.amount)))
      out.push(lr(w, `  ${maskCard(p.cardNo)} ${(p.cardName || '').slice(0, 16)}`, ''))
      out.push(lr(w, `  Ref# ${p.cardRefNo || ''}`, ''))
    }
  }
  out.push(lr(w, 'CHANGE', peso(sale.changeAmount)))
  if (sale.loyalty) {   // suki card: not a BIR figure, just the customer's points
    const l = sale.loyalty
    out.push(rule(w))
    out.push(lr(w, l.programName.toUpperCase().slice(0, w - 12), maskCard(l.cardNo)))
    if (l.earned != null) out.push(lr(w, '  Points earned', String(l.earned)))
    if (l.balance != null) out.push(lr(w, '  Points balance', String(l.balance)))
  }
  out.push(rule(w))
  out.push(...vatLines(w, sale))
  out.push(rule(w))
  out.push(...footerLines(w, settings))
  out.push('\n\n')
  return out.join('\n')
}

/** Placeholder for the return number, filled in by sp_ProcessReturn when it takes the
 *  number (same width, so the layout doesn't shift). */
export const RETURN_NO_PLACEHOLDER = '######'

/**
 * BIR Return Transaction receipt: tagged RETURN TRANSACTION, quotes the original invoice
 * (Ref SI No.) and its customer, lists what came back and the cash refunded.
 * `ret`: the preview from POST /api/returns/preview ({ header, items }, PascalCase).
 * `orig`: the original sale (normalized, camelCase). The return number prints as
 * RETURN_NO_PLACEHOLDER; the server swaps in the real one.
 */
export function buildReturnReceipt(ret, orig, ctx, { returnDateTime, reason }) {
  const { terminal = {}, settings = {}, cashier = '' } = ctx
  const w = columnsFor(terminal.PaperWidth)
  const h = ret.header
  const out = headerLines(w, ctx)

  out.push(ctr(w, 'RETURN TRANSACTION'))
  out.push(`Return No. ${RETURN_NO_PLACEHOLDER}`)
  out.push(`Ref SI No. ${siNo(orig.orNumber)}`)
  out.push(`SI Date: ${fmtDateTime(orig.saleDateTime)}`)
  out.push(`Date: ${fmtDateTime(returnDateTime)}`)
  out.push(`Terminal: ${orig.branchCode}/${terminal.TerminalCode || ''}`.slice(0, w))
  out.push(`Cashier: ${cashier}`.slice(0, w))
  out.push(...fieldLines(w, 'Reason: ', reason))
  out.push(rule(w))
  out.push(...customerLines(w, orig))
  out.push(rule(w))

  for (const l of ret.items) {
    out.push(...wrapWords(w, l.ProductName))
    out.push(lr(w, `  ${Number(l.Quantity)} x ${peso(l.UnitPrice)}`, peso(l.LineTotal)))
    if (Number(l.LineDiscount) > 0)
      out.push(lr(w, `    less ${orig.discountCode || 'DISC'}`, `-${peso(l.LineDiscount)}`))
  }

  out.push(rule(w))
  out.push(lr(w, 'TOTAL RETURNED', peso(h.GrossAmount)))
  if (Number(h.DiscountAmount) > 0) out.push(lr(w, 'LESS DISCOUNT', `-${peso(h.DiscountAmount)}`))
  out.push(lr(w, 'CASH REFUND', peso(h.NetAmount)))
  out.push(rule(w))
  out.push(...vatLines(w, {
    vatableAmount: h.VatableAmount, vatAmount: h.VatAmount, vatExemptAmount: h.VatExemptAmount,
    zeroRatedAmount: h.ZeroRatedAmount, vatAdjustment: Number(h.VatAdjustment)
  }))
  out.push(rule(w))
  out.push(...fieldLines(w, 'Received by: ', ''))
  out.push(...footerLines(w, settings))
  out.push('\n\n')
  return out.join('\n')
}

const maskCard = (n) => (!n ? '' : n.length <= 4 ? `****${n}` : `****${n.slice(-4)}`)

/**
 * Dine-in pre-payment bill (Generate Bill) — deliberately NOT an official receipt: no OR
 * number, no VAT breakdown, no discount line, since discount is only chosen afterward in
 * the normal checkout flow this hands off to. The real BIR receipt still prints once, at
 * actual payment, via buildReceipt().
 */
/** 39: printed only to open the drawer when PrintAgent can't send the drawer pulse itself (an older
 *  agent): any print opens it. Not a BIR document. */
export function buildNoSale(info, ctx) {
  const { branch = {}, terminal = {}, settings = {} } = ctx
  const w = columnsFor(terminal.PaperWidth)
  return [
    ctr(w, settings.StoreHeader1 || 'SPARKPOS'),
    ...(settings.StoreHeader2 || branch.BranchName ? [ctr(w, settings.StoreHeader2 || branch.BranchName)] : []),
    '',
    ctr(w, 'NO SALE'),
    ctr(w, 'Drawer opened'),
    ctr(w, '*** NOT AN OFFICIAL RECEIPT ***'),
    lr(w, `${branch.BranchCode || ''}/${terminal.TerminalCode || ''}`, new Date().toLocaleString('en-PH').slice(0, 22)),
    `Cashier: ${info.cashier || ''}`.slice(0, w),
    ...fieldLines(w, 'Reason: ', info.reason + (info.note ? ` (${info.note})` : '')),
    ...(info.approvedByName ? [`Approved by: ${info.approvedByName}`.slice(0, w)] : []),
    '\n'
  ].join('\n')
}

export function buildBill(order, items, ctx) {
  const { branch = {}, terminal = {}, settings = {}, cashier = '' } = ctx
  const w = columnsFor(terminal.PaperWidth)
  const out = []

  out.push(ctr(w, settings.StoreHeader1 || 'SPARKPOS'))
  if (settings.StoreHeader2 || branch.BranchName) out.push(ctr(w, settings.StoreHeader2 || branch.BranchName))
  out.push('')
  out.push(ctr(w, 'BILL'))
  out.push(ctr(w, '*** NOT AN OFFICIAL RECEIPT ***'))
  out.push(lr(w, `Table ${order.TableNumber}`, `${order.BranchCode}/${terminal.TerminalCode || ''}`))
  out.push(lr(w, new Date().toLocaleString('en-PH').slice(0, 22), ''))
  out.push(lr(w, `Cashier: ${cashier}`.slice(0, w), ''))
  out.push(rule(w))

  let gross = 0
  for (const i of items) {
    const qty = Number(i.Quantity), price = Number(i.UnitPrice)
    const lineAmt = round2(qty * price)
    gross += lineAmt
    out.push(i.ProductName.slice(0, w))
    out.push(lr(w, `  ${qty} x ${peso(price)}`, peso(lineAmt)))
  }

  out.push(rule(w))
  out.push(lr(w, 'TOTAL', peso(round2(gross))))
  out.push(rule(w))
  out.push(ctr(w, 'Any discount applies at payment'))
  out.push('\n\n')
  return out.join('\n')
}

/**
 * Consolidated "sent to kitchen" slip — prints at the same terminal already handling this
 * table (whichever pipeline it already uses, RawBT or PrintAgent/network), right alongside
 * the per-area kitchen/beverage tickets the server just fired off. Only the delta just sent
 * (server-computed, via OrdersController.SendToKitchen's response), not the whole order —
 * so this stays a running per-round trail, not a reprint of everything so far. No prices,
 * same as the area tickets; this is a kitchen-facing record, not a bill.
 */
export function buildKitchenSlip(tableNumber, sentItems, terminal = {}) {
  const w = columnsFor(terminal.PaperWidth)
  const out = [ctr(w, '*** SENT TO KITCHEN ***'), lr(w, `Table ${tableNumber}`, ''),
    lr(w, new Date().toLocaleString('en-PH').slice(0, 22), ''), rule(w)]
  for (const i of sentItems) out.push(`${i.quantity} x ${i.productName}`)
  out.push(rule(w))
  out.push('\n\n')
  return out.join('\n')
}

/** X-Read fallback rendering when the server text isn't available offline. */
export function buildXReadLocal(summary, ctx) {
  const w = columnsFor(ctx.paperWidth)
  const out = [ctr(w, '*** X-READ (LOCAL) ***'), ctr(w, `${ctx.branchCode}/${ctx.terminalCode}`),
    ctr(w, new Date().toLocaleString('en-PH').slice(0, 22)), rule(w)]
  out.push(lr(w, 'TXN COUNT', String(summary.txnCount)))
  out.push(lr(w, 'OFFLINE / UNSYNCED', String(summary.pending)))
  out.push(rule(w))
  out.push(ctr(w, 'Full X-Read requires a connection'))
  out.push('\n\n')
  return out.join('\n')
}

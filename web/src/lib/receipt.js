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

/**
 * Sales invoice / OR.
 * ctx: { branch, terminal, settings, cashier }
 * The BIR header (TIN, MIN, Serial, Permit) comes from the terminal record —
 * each registered machine prints its own credentials. Width comes from
 * terminal.PaperWidth (58 or 80mm).
 */
export function buildReceipt(sale, ctx, { reprint = false } = {}) {
  const { branch = {}, terminal = {}, settings = {}, cashier = '' } = ctx
  const w = columnsFor(terminal.PaperWidth)
  const out = []

  out.push(ctr(w, settings.StoreHeader1 || 'SPARKPOS'))
  if (settings.StoreHeader2 || branch.BranchName) out.push(ctr(w, settings.StoreHeader2 || branch.BranchName))
  if (branch.Address) out.push(ctr(w, branch.Address.slice(0, w)))
  if (terminal.Tin) out.push(ctr(w, `VAT REG TIN ${terminal.Tin}`))
  if (terminal.MinNo) out.push(ctr(w, `MIN ${terminal.MinNo}`))
  if (terminal.SerialNo || terminal.PermitNo)
    out.push(ctr(w, `SN ${terminal.SerialNo || '-'} PTU ${terminal.PermitNo || '-'}`))
  if (terminal.AccreditationNo) out.push(ctr(w, `ACCR ${terminal.AccreditationNo}`))
  out.push('')
  out.push(ctr(w, 'OFFICIAL RECEIPT'))
  if (reprint) out.push(ctr(w, '*** REPRINT ***'))
  if (sale.status === 'Voided') out.push(ctr(w, '*** VOIDED ***'))

  out.push(lr(w, `OR# ${sale.orNumber}`, `${sale.branchCode}/${terminal.TerminalCode || ''}`))
  out.push(lr(w, new Date(sale.saleDateTime).toLocaleString('en-PH').slice(0, 22), ''))
  out.push(lr(w, `Cashier: ${cashier}`.slice(0, w), ''))
  out.push(rule(w))

  for (const l of sale.items) {
    out.push(l.productName.slice(0, w))
    const lineAmt = round2(l.quantity * l.unitPrice)
    out.push(lr(w, `  ${l.quantity} x ${peso(l.unitPrice)}`, peso(lineAmt)) +
      (l.unitPrice !== l.origUnitPrice ? '*' : ''))
    if (l.lineDiscount > 0)
      out.push(lr(w, `    less ${sale.discountCode}`, `-${peso(l.lineDiscount)}`))
  }

  out.push(rule(w))
  out.push(lr(w, 'GROSS AMOUNT', peso(sale.grossAmount)))
  if (sale.discountAmount > 0) {
    if (sale.dinerCount) out.push(lr(w, `  Diners ${sale.dinerCount} (SC/PWD ${sale.seniorCount || 0})`, ''))
    out.push(lr(w, `TOTAL ${sale.discountCode} DISCOUNT`, `-${peso(sale.discountAmount)}`))
    out.push(lr(w, `  Ctrl# ${sale.discountCtrlNo || ''}`, ''))
    out.push(lr(w, `  Name: ${(sale.discountName || '').slice(0, 28)}`, ''))
    out.push('  Signature: ______________________')
  }
  out.push(lr(w, 'AMOUNT DUE', peso(sale.netAmount)))
  out.push(rule(w))

  for (const p of sale.payments) {
    if (p.paymentType === 'CASH') out.push(lr(w, 'CASH', peso(p.amount)))
    else {
      out.push(lr(w, `CARD ${(p.cardBank || '').slice(0, 14)}`, peso(p.amount)))
      out.push(lr(w, `  ${maskCard(p.cardNo)} ${(p.cardName || '').slice(0, 16)}`, ''))
      out.push(lr(w, `  Ref# ${p.cardRefNo || ''}`, ''))
    }
  }
  out.push(lr(w, 'CHANGE', peso(sale.changeAmount)))
  out.push(rule(w))
  out.push(lr(w, 'VATable Sales', peso(sale.vatableAmount)))
  out.push(lr(w, 'VAT (12%)', peso(sale.vatAmount)))
  out.push(lr(w, 'VAT-Exempt Sales', peso(sale.vatExemptAmount)))
  out.push(lr(w, 'Zero-Rated Sales', peso(sale.zeroRatedAmount)))
  if (sale.vatAdjustment > 0) {
    // Informational only — VAT forgone on lines discounted but still VATable (e.g. a 5%
    // prime-commodity rate). Already netted into VATable Sales/VAT above, NOT a further
    // deduction from Amount Due. See CLAUDE.md's discount-configuration notes.
    out.push(lr(w, 'VAT Adjustment (info)', peso(sale.vatAdjustment)))
  }
  out.push(rule(w))
  if (settings.ReceiptFooter) {
    for (const line of settings.ReceiptFooter.split('\n')) out.push(ctr(w, line.slice(0, w)))
  }
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

import React, { useState, useMemo } from 'react'

/* ============================================================
   TabletPOS — CLICKABLE MOCKUP v2 (no backend, all data fake)
   New in v2: Branches + per-branch pricing, BIR terminal
   registration, POS Settings (type / void override), 5 discount
   types with control no + name, per-item discount on receipt,
   split payment (cash + card), End of Day terminal lockout.
   ============================================================ */

const peso = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n) => Math.round(n * 100) / 100

/* ---------------- Mock data ---------------- */
const BRANCHES = [
  { code: 'MAIN', name: 'Main Branch — Cebu City', tin: '123-456-789-0000' },
  { code: 'MDU', name: 'Mandaue Branch', tin: '123-456-789-0001' },
  { code: 'LAP', name: 'Lapu-Lapu Branch', tin: '123-456-789-0002' },
]

const CATEGORIES = [
  { id: 1, name: 'Pork' }, { id: 2, name: 'Beef' }, { id: 3, name: 'Chicken' },
  { id: 4, name: 'Processed' }, { id: 5, name: 'Others' },
]

/* Pricing model: every product has ONE base price. A branch only appears in
   `overrides` when its price differs. 30 branches ≠ 30 fields — most products
   have zero or one override. Resolution at POS: override ?? basePrice. */
const PRODUCTS = [
  { id: 1, barcode: '4800001', name: 'Pork Belly (Liempo) 1kg', cat: 1, vat: true, disc: true, editable: true, base: 380, overrides: { MDU: 385, LAP: 395 } },
  { id: 2, barcode: '4800002', name: 'Pork Chop 1kg', cat: 1, vat: true, disc: true, editable: true, base: 320, overrides: { LAP: 330 } },
  { id: 3, barcode: '4800003', name: 'Ground Pork 1kg', cat: 1, vat: true, disc: true, editable: false, base: 300, overrides: {} },
  { id: 4, barcode: '4800004', name: 'Beef Brisket 1kg', cat: 2, vat: true, disc: true, editable: true, base: 480, overrides: { LAP: 500 } },
  { id: 5, barcode: '4800005', name: 'Beef Cubes 1kg', cat: 2, vat: true, disc: true, editable: false, base: 450, overrides: {} },
  { id: 6, barcode: '4800006', name: 'Whole Chicken 1kg', cat: 3, vat: true, disc: true, editable: false, base: 195, overrides: { LAP: 205 } },
  { id: 7, barcode: '4800007', name: 'Chicken Breast 1kg', cat: 3, vat: true, disc: true, editable: false, base: 240, overrides: {} },
  { id: 8, barcode: '4800008', name: 'Chicken Wings 1kg', cat: 3, vat: true, disc: true, editable: false, base: 220, overrides: {} },
  { id: 9, barcode: '4800009', name: 'Hotdog Jumbo 1kg', cat: 4, vat: true, disc: false, editable: false, base: 185, overrides: {} },
  { id: 10, barcode: '4800010', name: 'Tocino 500g', cat: 4, vat: true, disc: false, editable: false, base: 145, overrides: {} },
  { id: 11, barcode: '4800011', name: 'Longganisa 500g', cat: 4, vat: true, disc: false, editable: false, base: 135, overrides: {} },
  { id: 12, barcode: '4800012', name: 'Bacon 250g', cat: 4, vat: true, disc: false, editable: false, base: 165, overrides: {} },
  { id: 13, barcode: '4800013', name: 'Chicharon 100g', cat: 5, vat: true, disc: false, editable: false, base: 85, overrides: {} },
  { id: 14, barcode: '4800014', name: 'Ice 1kg', cat: 5, vat: false, disc: false, editable: false, base: 25, overrides: { LAP: 28 } },
]

/* price resolution used everywhere */
const priceFor = (p, branchCode) => p.overrides?.[branchCode] ?? p.base


/* 5 discount types. Rate + VAT treatment differ — flagged for your confirmation. */
const DISCOUNT_TYPES = [
  { code: 'SENIOR', label: 'Senior Citizen', rate: 0.20, vatExempt: true, law: 'RA 9994' },
  { code: 'PWD', label: 'PWD', rate: 0.20, vatExempt: true, law: 'RA 10754' },
  { code: 'NAAC', label: 'National Athlete', rate: 0.20, vatExempt: true, law: 'RA 10699' },
  { code: 'MOV', label: 'Medal of Valor', rate: 0.20, vatExempt: true, law: 'RA 9049' },
  { code: 'SOLO', label: 'Solo Parent', rate: 0.10, vatExempt: true, law: 'RA 11861' },
]

/**
 * PER-ITEM discount math.
 * Discount applies ONLY to lines flagged discountable. Those lines become
 * VAT-exempt, then the rate comes off. Non-discountable lines stay VATable.
 */
function computeTotals(lines, discType) {
  const d = DISCOUNT_TYPES.find(x => x.code === discType)
  let gross = 0, discount = 0, vatExempt = 0, vatableGross = 0, nonVatSales = 0

  for (const l of lines) {
    const amt = round2(l.qty * l.price)
    gross += amt
    if (d && l.disc) {
      const base = d.vatExempt ? round2(amt / 1.12) : amt
      const off = round2(base * d.rate)
      vatExempt += base
      discount += off
    } else if (l.vat) {
      vatableGross += amt
    } else {
      nonVatSales += amt
    }
  }
  const vat = round2(vatableGross * 0.12 / 1.12)
  return {
    gross: round2(gross), discount: round2(discount),
    vatExempt: round2(vatExempt), vatable: round2(vatableGross - vat),
    zeroRated: round2(nonVatSales), vat,
    net: round2(vatExempt + vatableGross + nonVatSales - discount),
  }
}

function lineDiscount(l, discType) {
  const d = DISCOUNT_TYPES.find(x => x.code === discType)
  if (!d || !l.disc) return 0
  const amt = round2(l.qty * l.price)
  return round2((d.vatExempt ? round2(amt / 1.12) : amt) * d.rate)
}

/* ---------------- UI atoms ---------------- */
const Btn = ({ variant = 'ghost', className = '', ...p }) => {
  const base = 'select-none rounded-lg font-semibold min-h-[46px] px-4 transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100'
  const v = {
    primary: 'bg-red-700 text-white active:bg-red-800',
    dark: 'bg-stone-900 text-white',
    moss: 'bg-emerald-800 text-white',
    ghost: 'bg-white border border-stone-300 text-stone-900',
  }[variant]
  return <button className={`${base} ${v} ${className}`} {...p} />
}
const Input = ({ className = '', ...p }) =>
  <input className={`rounded-lg border border-stone-300 bg-white px-3 min-h-[46px] text-base w-full focus:outline-none focus:ring-2 focus:ring-emerald-700 ${className}`} {...p} />
const Select = ({ className = '', ...p }) =>
  <select className={`rounded-lg border border-stone-300 bg-white px-3 min-h-[46px] text-base ${className}`} {...p} />
const Field = ({ label, children }) => (
  <label className="block"><span className="block text-xs font-semibold text-stone-500 mb-1">{label}</span>{children}</label>
)
const Modal = ({ children, onClose, wide }) => (
  <div className="absolute inset-0 bg-stone-900/60 flex items-center justify-center p-4 z-30 overflow-auto" onClick={onClose}>
    <div className={`bg-white rounded-2xl p-6 w-full space-y-4 my-auto ${wide ? 'max-w-2xl' : 'max-w-sm'}`} onClick={e => e.stopPropagation()}>{children}</div>
  </div>
)
const Table = ({ head, rows, empty = 'No data for this range.' }) => (
  <div className="bg-white rounded-xl shadow overflow-x-auto">
    <table className="w-full text-sm">
      <thead><tr className="text-left text-stone-500 border-b border-stone-200">
        {head.map(h => <th key={h} className="px-3 py-2 whitespace-nowrap font-semibold">{h}</th>)}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className="border-b border-stone-100">
          {r.map((c, j) => <td key={j} className="px-3 py-2 whitespace-nowrap tabular-nums">{c}</td>)}
        </tr>)}
        {!rows.length && <tr><td colSpan={head.length} className="px-3 py-8 text-stone-400">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
)
const Note = ({ tone = 'stone', title, children }) => {
  const t = { stone: 'bg-stone-100 border-stone-300 text-stone-600', amber: 'bg-amber-50 border-amber-200 text-amber-900', green: 'bg-emerald-50 border-emerald-200 text-emerald-900' }[tone]
  return <div className={`rounded-lg border px-4 py-3 text-sm ${t}`}>
    {title && <strong className="block mb-1">{title}</strong>}{children}</div>
}

/* Thermal paper simulation */
const W = 40
const ctr = (s) => s.length >= W ? s : ' '.repeat(Math.floor((W - s.length) / 2)) + s
const lr = (l, r) => l + ' '.repeat(Math.max(1, W - l.length - r.length)) + r
const rule = () => '-'.repeat(W)
const Paper = ({ lines }) => (
  <div className="bg-white shadow-lg mx-auto max-w-[320px] p-4 font-mono text-[10.5px] leading-[1.45] whitespace-pre overflow-x-auto border border-stone-200">
    {lines.join('\n')}
  </div>
)

/* ============================================================
   LOGIN
   ============================================================ */
function Login({ go, branch, setBranch, dayState }) {
  const eodPending = dayState === 'eodPending'
  const eodDone = dayState === 'eodDone'
  return (
    <div className="h-full flex items-center justify-center p-6 bg-stone-900 overflow-auto">
      <div className="w-full max-w-sm my-auto">
        <div className="mb-6 text-center text-white">
          <div className="text-[11px] tracking-[0.35em] uppercase text-white/40 mb-2">Point of Sale</div>
          <h1 className="text-4xl font-bold tracking-tight">TabletPOS</h1>
        </div>
        <div className="bg-white rounded-2xl p-6 space-y-4 shadow-2xl">
          <Field label="Branch">
            <Select className="w-full" value={branch} onChange={e => setBranch(e.target.value)}>
              {BRANCHES.map(b => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
            </Select>
          </Field>
          <Input placeholder="Username" />
          <Input placeholder="Password" type="password" defaultValue="••••••••" />

          {eodPending && (
            <Note tone="amber" title="End of Day not yet processed">
              POS-01 has no open shift, but today has not been closed. The last cashier can sign back in
              to run End of Day only — no selling — or an Admin can close it from the Admin console.
            </Note>
          )}
          {eodDone && (
            <Note tone="stone" title="Terminal closed for the day">
              POS-01 completed End of Day. Cashier login reopens on the next business day. Admin can still sign in.
            </Note>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Btn variant="primary" disabled={eodDone}
              onClick={() => go(eodPending ? 'eodonly' : 'cashbegin')}>
              {eodPending ? 'Cashier — EOD only' : 'Cashier'}
            </Btn>
            <Btn variant="dark" onClick={() => go('admin')}>Admin</Btn>
          </div>
          <p className="text-xs text-stone-400 text-center">Mockup — either button signs you in</p>
        </div>
      </div>
    </div>
  )
}

/* Cashier signed back in purely to run EOD — selling is unavailable */
function EodOnly({ go, branch, terminal, setDayState }) {
  const [override, setOverride] = useState(false)
  const [paper, setPaper] = useState(false)
  return (
    <div className="h-full overflow-auto p-6 relative">
      <div className="max-w-md mx-auto space-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">End of Day only</div>
          <h1 className="text-2xl font-bold">{branch}/{terminal}</h1>
          <p className="text-stone-500 text-sm mt-1">
            Signed in as Maria Santos. Your shift is already blind-closed, so selling is locked.
            The only action available is closing today.
          </p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow space-y-3 text-sm">
          {[['All shifts blind-closed', '✓ 2 of 2', true], ['Offline queue synced', '✓ 0 pending', true],
            ['Open transactions', '✓ none', true], ['Z-Read for today', 'not yet generated', null]].map(([l, v, ok]) => (
            <div key={l} className="flex justify-between border-b border-stone-100 pb-2 last:border-0">
              <span>{l}</span><span className={ok ? 'text-emerald-700 font-semibold' : 'text-stone-500'}>{v}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => go('login')}>Sign out</Btn>
          <Btn variant="primary" onClick={() => setOverride(true)}>Process End of Day</Btn>
        </div>
      </div>
      {override && <EodOverrideModal branch={branch} terminal={terminal}
        onClose={() => setOverride(false)} onConfirm={() => { setOverride(false); setPaper(true) }} />}
      {paper && (
        <Modal onClose={() => { setPaper(false); setDayState('eodDone'); go('login') }}>
          <Paper lines={zreadPaper(branch, terminal)} />
          <Btn variant="dark" className="w-full" onClick={() => { setPaper(false); setDayState('eodDone'); go('login') }}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

/* EOD always requires an override — used by cashier, admin, and recovery paths */
function EodOverrideModal({ branch, terminal, onClose, onConfirm }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [reason, setReason] = useState('')
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Authorize End of Day</h2>
      <p className="text-sm text-stone-500">
        {branch}/{terminal} — this locks today permanently. A Supervisor or Admin credential is always
        required, no matter who is signed in.
      </p>
      <Field label="Supervisor / Admin username"><Input value={u} onChange={e => setU(e.target.value)} /></Field>
      <Field label="Password"><Input type="password" value={p} onChange={e => setP(e.target.value)} /></Field>
      <Field label="Remarks (optional)"><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. store closed early" /></Field>
      <Note tone="stone">The approver, timestamp and remarks are written to the audit log alongside the Z-Read.</Note>
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={!u || !p} onClick={onConfirm}>Authorize and close day</Btn>
      </div>
    </Modal>
  )
}

/* shared Z-Read paper */
function zreadPaper(branch, terminal) {
  return [
    ctr('TABLETPOS MEAT SHOP'), ctr(BRANCHES.find(b => b.code === branch)?.name || ''),
    ctr('*** Z-READ / END OF DAY ***'), ctr(`${branch}/${terminal} · Z# 113`),
    ctr(new Date().toLocaleDateString('en-PH')), rule(),
    lr('BEGINNING OR', '100001'), lr('ENDING OR', '100042'), rule(),
    lr('GROSS SALES', peso(31420)), lr('TOTAL DISCOUNTS', peso(1240.5)), lr('NET SALES', peso(30179.5)), rule(),
    ctr('DISCOUNT BREAKDOWN'),
    lr('  SENIOR', peso(680.25)), lr('  PWD', peso(310.25)), lr('  NAAC', peso(0)),
    lr('  MOV', peso(0)), lr('  SOLO PARENT', peso(250.00)), rule(),
    ctr('PAYMENT BREAKDOWN'), lr('  CASH', peso(26679.5)), lr('  CARD', peso(3500)), rule(),
    lr('VATable Sales', peso(26945.98)), lr('VAT (12%)', peso(3233.52)),
    lr('VAT-Exempt Sales', peso(1034.75)), lr('Zero-Rated Sales', peso(0)), rule(),
    lr('TXN COUNT', '42'), lr('VOID COUNT', '2'), lr('VOID AMOUNT', peso(760)), rule(),
    lr('OLD GRAND TOTAL', peso(4128900.50)), lr('NEW GRAND TOTAL', peso(4159080.00)), rule(),
    lr('Closed by', 'msantos'), lr('Authorized by', 'rlim (Supervisor)'), rule(),
    ctr('DAY LOCKED — TERMINAL CLOSED'), ctr('Report emailed to administration'), '',
  ]
}

/* ============================================================
   CASH BEGIN
   ============================================================ */
function CashBegin({ go, branch, terminal, setTerminal, setCashBegin }) {
  const [amt, setAmt] = useState('5000')
  const b = BRANCHES.find(x => x.code === branch)
  return (
    <div className="h-full overflow-auto p-6">
      <div className="w-full max-w-md mx-auto space-y-5">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">Cash Begin · {b.code}</div>
          <h1 className="text-2xl font-bold">Maria Santos</h1>
          <p className="text-sm text-stone-500">{b.name}</p>
        </div>
        <div className="bg-white rounded-2xl p-6 space-y-5 shadow">
          <Field label="Terminal">
            <div className="grid grid-cols-2 gap-3">
              {['POS-01', 'POS-02'].map(t =>
                <Btn key={t} variant={terminal === t ? 'moss' : 'ghost'} onClick={() => setTerminal(t)}>{t}</Btn>)}
            </div>
          </Field>
          <Field label="Change fund (₱)">
            <Input className="text-right text-2xl tabular-nums" inputMode="decimal"
              value={amt} onChange={e => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
          </Field>
          <Note tone="green">
            Opening the shift downloads this branch's price list and reserves a block of OR numbers,
            so the tablet keeps selling if Wi-Fi drops. Prices are per branch — {b.code} pricing loads here.
          </Note>
          <Btn variant="primary" className="w-full text-lg" onClick={() => { setCashBegin(Number(amt) || 0); go('pos') }}>
            Open shift
          </Btn>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   POS SALES
   ============================================================ */
function Pos({ go, branch, terminal, online, setOnline, queued, setQueued, orNo, setOrNo, settings, setLastSale, lastSale }) {
  const [lines, setLines] = useState([])
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState(null)
  const [disc, setDisc] = useState(null)       // { type, controlNo, name }
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState('')

  const branchObj = BRANCHES.find(b => b.code === branch)
  const totals = computeTotals(lines, disc?.type)
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2800) }

  const visible = useMemo(() => {
    const q = search.toLowerCase()
    return PRODUCTS.filter(p => (!cat || p.cat === cat) &&
      (!q || p.name.toLowerCase().includes(q) || p.barcode.includes(q)))
  }, [search, cat])

  const add = (p) => setLines(ls => {
    const price = priceFor(p, branch)
    const ex = ls.find(l => l.id === p.id && l.price === price)
    if (ex) return ls.map(l => l === ex ? { ...l, qty: l.qty + 1 } : l)
    return [...ls, { key: Math.random(), id: p.id, name: p.name, barcode: p.barcode, qty: 1, price, orig: price, vat: p.vat, disc: p.disc, editable: p.editable }]
  })

  const finish = (payments) => {
    const sale = { or: orNo, branch, terminal, lines, totals, disc, payments, at: new Date(), voided: false }
    setLastSale(sale); setOrNo(orNo + 1); setLines([]); setDisc(null); setModal(null)
    if (!online) setQueued(q => q + 1)
    const change = round2(payments.reduce((s, p) => s + p.amount, 0) - totals.net)
    flash(`OR# ${sale.or} complete — change ₱${peso(change)}`)
  }

  /* ---- Receipt with PER-ITEM discount lines ---- */
  const receiptLines = (s, reprint) => {
    const d = DISCOUNT_TYPES.find(x => x.code === s.disc?.type)
    const bo = BRANCHES.find(b => b.code === s.branch)
    const out = [
      ctr('TABLETPOS MEAT SHOP'), ctr(bo.name), ctr(`VAT REG TIN ${bo.tin}`),
      ctr('MIN 08012026123456789'), ctr('SN M1-2026-0001  PTU FP012026-001'), '',
      ctr('OFFICIAL RECEIPT'),
    ]
    if (reprint) out.push(ctr('*** REPRINT ***'))
    if (s.voided) out.push(ctr('*** VOIDED ***'))
    out.push(lr(`OR# ${s.or}`, `${s.branch}/${s.terminal}`),
      lr(s.at.toLocaleString('en-PH').slice(0, 20), ''), lr('Cashier: Maria Santos', ''), rule())

    for (const l of s.lines) {
      out.push(l.name.slice(0, W))
      out.push(lr(`  ${l.qty} x ${peso(l.price)}`, peso(l.qty * l.price)) + (l.price !== l.orig ? '*' : ''))
      const ld = lineDiscount(l, s.disc?.type)
      if (ld > 0) out.push(lr(`    less ${d.code} ${d.rate * 100}%`, `-${peso(ld)}`))
    }
    out.push(rule(), lr('GROSS AMOUNT', peso(s.totals.gross)))
    if (s.totals.discount > 0) {
      out.push(lr(`TOTAL ${d.code} DISCOUNT`, `-${peso(s.totals.discount)}`))
      out.push(lr(`  Ctrl# ${s.disc.controlNo}`, ''))
      out.push(lr(`  Name: ${s.disc.name.slice(0, 26)}`, ''))
      out.push(lr('  Signature: ______________', ''))
    }
    out.push(lr('AMOUNT DUE', peso(s.totals.net)), rule())
    for (const p of s.payments) {
      out.push(lr(p.type === 'CASH' ? 'CASH' : `CARD ${p.bank}`, peso(p.amount)))
      if (p.type === 'CARD') {
        out.push(lr(`  ****${p.cardNo.slice(-4)} ${p.cardName.slice(0, 16)}`, ''))
        out.push(lr(`  Ref# ${p.refNo}`, ''))
      }
    }
    const tendered = s.payments.reduce((a, p) => a + p.amount, 0)
    out.push(lr('CHANGE', peso(round2(tendered - s.totals.net))), rule(),
      lr('VATable Sales', peso(s.totals.vatable)), lr('VAT (12%)', peso(s.totals.vat)),
      lr('VAT-Exempt Sales', peso(s.totals.vatExempt)), lr('Zero-Rated Sales', peso(s.totals.zeroRated)),
      rule(), ctr('THIS SERVES AS YOUR SALES INVOICE'), ctr('Thank you!'), '')
    return out
  }

  const xreadLines = () => [
    ctr('*** X-READ ***'), ctr(`${branch}/${terminal} — Maria Santos`),
    ctr(new Date().toLocaleString('en-PH').slice(0, 20)), rule(),
    lr('CASH BEGIN', peso(5000)), lr('TXN COUNT', '18'), lr('VOID COUNT', '1'), rule(),
    lr('GROSS SALES', peso(24850)), lr('TOTAL DISCOUNTS', peso(1240.5)), lr('NET SALES', peso(23609.5)), rule(),
    lr('  SENIOR', peso(680.25)), lr('  PWD', peso(310.25)), lr('  NAAC', peso(0)),
    lr('  MOV', peso(0)), lr('  SOLO PARENT', peso(250.00)), rule(),
    lr('CASH PAYMENTS', peso(20109.5)), lr('CARD PAYMENTS', peso(3500)), rule(),
    lr('OR RANGE', '100001-100018'), '', ctr('X-READ DOES NOT LOCK THE DAY'), '',
  ]

  return (
    <div className="h-full flex flex-col relative">
      <header className="bg-stone-900 text-white px-3 py-2 flex items-center gap-2 flex-wrap text-sm">
        <span className="font-bold tracking-tight">TabletPOS</span>
        <span className="text-white/50">{branch}/{terminal} · Maria Santos · {settings.posType}</span>
        <button onClick={() => setOnline(o => !o)}
          className={`ml-auto text-xs px-2 py-1 rounded-full font-semibold ${online ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {online ? 'ONLINE' : 'OFFLINE'}{queued ? ` · ${queued} queued` : ''}
        </button>
        <button className="underline text-white/70" onClick={() => setModal({ t: 'paper', lines: xreadLines() })}>X-Read</button>
        <button className="underline text-white/70"
          onClick={() => lastSale ? setModal({ t: 'paper', lines: receiptLines(lastSale, true) }) : flash('No receipt to reprint')}>Reprint</button>
        <button className="underline text-white/70"
          onClick={() => lastSale ? setModal({ t: 'void' }) : flash('Nothing to void')}>Void</button>
        <button className="bg-red-700 px-3 py-1.5 rounded-lg font-semibold" onClick={() => go('blindclose')}>Close shift</button>
      </header>

      {!online && <div className="bg-amber-100 text-amber-900 px-4 py-1.5 text-sm">
        Offline — sales saved on this tablet, syncing resumes automatically. OR numbers continue from the reserved block.
      </div>}

      <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
        <div className="flex-1 flex flex-col p-3 gap-3 min-w-0">
          <Input className="text-lg" placeholder="Scan barcode or search…" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              const hit = PRODUCTS.find(p => p.barcode === search.trim())
              if (hit) { add(hit); setSearch('') }
            }} />
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Btn variant={!cat ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[40px]" onClick={() => setCat(null)}>All</Btn>
            {CATEGORIES.map(c => <Btn key={c.id} variant={cat === c.id ? 'moss' : 'ghost'}
              className="whitespace-nowrap !min-h-[40px]" onClick={() => setCat(c.id)}>{c.name}</Btn>)}
          </div>
          <div className="flex-1 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-3 content-start">
            {visible.map(p => (
              <button key={p.id} onClick={() => add(p)}
                className="bg-white rounded-xl p-3 text-left shadow-sm active:scale-[0.97] transition-transform min-h-[92px] flex flex-col justify-between">
                <span className="font-semibold leading-tight text-sm">{p.name}</span>
                <span className="flex items-baseline justify-between">
                  <span className="tabular-nums text-lg text-emerald-800 font-bold">₱{peso(priceFor(p, branch))}</span>
                  {!p.disc && <span className="text-[9px] uppercase tracking-wide text-stone-400 border border-stone-300 rounded px-1">no disc</span>}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Cart */}
        <div className="w-full lg:w-[380px] bg-white lg:border-l border-stone-200 flex flex-col max-h-[55vh] lg:max-h-none">
          <div className="flex-1 overflow-y-auto divide-y divide-stone-100">
            {!lines.length && <p className="text-stone-400 text-center py-12 px-6">Scan or tap a product to start the sale.</p>}
            {lines.map(l => {
              const ld = lineDiscount(l, disc?.type)
              return (
                <div key={l.key} className="px-3 py-2.5 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate text-sm">{l.name}</p>
                    <p className="text-xs text-stone-500 tabular-nums">
                      @ ₱{peso(l.price)}
                      {l.editable && <button className="ml-2 underline" onClick={() => setModal({ t: 'price', line: l })}>edit</button>}
                      {!l.disc && <span className="ml-2 text-stone-400">non-discountable</span>}
                    </p>
                    {ld > 0 && <p className="text-xs text-emerald-700 tabular-nums">less {disc.type} −₱{peso(ld)}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Btn className="!min-h-[36px] !px-2.5" onClick={() =>
                      setLines(ls => l.qty <= 1 ? ls.filter(x => x !== l) : ls.map(x => x === l ? { ...x, qty: x.qty - 1 } : x))}>−</Btn>
                    <span className="tabular-nums w-7 text-center font-bold text-sm">{l.qty}</span>
                    <Btn className="!min-h-[36px] !px-2.5" onClick={() =>
                      setLines(ls => ls.map(x => x === l ? { ...x, qty: x.qty + 1 } : x))}>+</Btn>
                  </div>
                  <span className="tabular-nums w-16 text-right font-bold text-sm">{peso(l.qty * l.price)}</span>
                  <button className="text-red-700 text-lg px-1" onClick={() => setLines(ls => ls.filter(x => x !== l))}>×</button>
                </div>
              )
            })}
          </div>

          <div className="bg-stone-900 text-white px-4 py-3 space-y-1">
            <div className="flex justify-between text-sm text-white/60 tabular-nums"><span>Gross</span><span>{peso(totals.gross)}</span></div>
            {totals.discount > 0 && (
              <div className="flex justify-between text-sm text-amber-300 tabular-nums">
                <span>{disc.type} discount (per item)</span><span>−{peso(totals.discount)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline">
              <span className="text-[10px] tracking-[0.3em] uppercase text-white/50">Total due</span>
              <span className="tabular-nums text-4xl font-bold">₱{peso(totals.net)}</span>
            </div>
          </div>

          <div className="p-3 grid grid-cols-3 gap-2">
            <Btn variant={disc ? 'moss' : 'ghost'} className="text-sm" onClick={() => setModal({ t: 'discount' })}>
              {disc ? disc.type : 'Discount'}
            </Btn>
            <Btn className="text-sm" disabled={!lines.length} onClick={() => { setLines([]); setDisc(null); flash('Sale cancelled') }}>Cancel</Btn>
            <Btn variant="primary" className="text-lg" disabled={!lines.length} onClick={() => setModal({ t: 'pay' })}>PAY</Btn>
          </div>
        </div>
      </div>

      {toast && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-stone-900 text-white px-5 py-3 rounded-xl shadow-xl tabular-nums text-sm z-40">{toast}</div>}

      {modal?.t === 'pay' && <SplitPayModal due={totals.net} onClose={() => setModal(null)} onDone={finish} />}
      {modal?.t === 'discount' && <DiscountModal current={disc} onClose={() => setModal(null)}
        onApply={(v) => { setDisc(v); setModal(null) }} />}
      {modal?.t === 'price' && (
        <Modal onClose={() => setModal(null)}>
          <h2 className="font-bold text-lg">Edit price — {modal.line.name}</h2>
          <p className="text-sm text-stone-500">Original price is kept for the audit log and marked * on the receipt.</p>
          <Input id="pf" className="text-right tabular-nums text-2xl" defaultValue={modal.line.price} inputMode="decimal" />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setModal(null)}>Back</Btn>
            <Btn variant="primary" onClick={() => {
              const v = Number(document.getElementById('pf').value) || modal.line.price
              setLines(ls => ls.map(x => x === modal.line ? { ...x, price: v } : x)); setModal(null)
            }}>Apply</Btn>
          </div>
        </Modal>
      )}
      {modal?.t === 'void' && (
        <Modal onClose={() => setModal(null)}>
          <h2 className="font-bold text-lg">Void OR# {lastSale.or}</h2>
          <p className="text-sm text-stone-500">₱{peso(lastSale.totals.net)}</p>
          {settings.voidOverride
            ? <Note tone="amber" title="Supervisor override required">This branch requires an override for voids (Admin → POS Settings).</Note>
            : <Note tone="green" title="Override disabled">Cashiers can void their own last transaction without approval. Still logged in the audit trail.</Note>}
          {settings.voidOverride && <><Input placeholder="Supervisor username" /><Input placeholder="Supervisor password" type="password" /></>}
          <Input placeholder="Reason for void" />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setModal(null)}>Back</Btn>
            <Btn variant="primary" onClick={() => {
              setLastSale({ ...lastSale, voided: true }); setModal(null); flash(`OR# ${lastSale.or} voided`)
            }}>Void sale</Btn>
          </div>
        </Modal>
      )}
      {modal?.t === 'paper' && (
        <Modal onClose={() => setModal(null)}>
          <Paper lines={modal.lines} />
          <Btn variant="dark" className="w-full" onClick={() => setModal(null)}>Close preview</Btn>
        </Modal>
      )}
    </div>
  )
}

/* ---------------- Split payment ---------------- */
function SplitPayModal({ due, onClose, onDone }) {
  const [payments, setPayments] = useState([])
  const [cardForm, setCardForm] = useState(null)
  const [cash, setCash] = useState('')

  const paid = round2(payments.reduce((s, p) => s + p.amount, 0))
  const balance = round2(due - paid)
  const change = round2(paid - due)

  const addCash = () => {
    const v = Number(cash) || 0
    if (v <= 0) return
    setPayments(ps => [...ps, { type: 'CASH', amount: v }]); setCash('')
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex justify-between items-baseline">
        <h2 className="text-lg font-bold">Payment</h2>
        <span className="tabular-nums text-2xl font-bold">₱{peso(due)}</span>
      </div>

      {payments.length > 0 && (
        <div className="border border-stone-200 rounded-lg divide-y divide-stone-100">
          {payments.map((p, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-2 text-sm">
              <span className="font-semibold w-14">{p.type}</span>
              <span className="flex-1 text-stone-500 truncate">
                {p.type === 'CARD' ? `${p.bank} ****${p.cardNo.slice(-4)} · ${p.cardName} · Ref ${p.refNo}` : 'Cash tendered'}
              </span>
              <span className="tabular-nums font-bold">{peso(p.amount)}</span>
              <button className="text-red-700" onClick={() => setPayments(ps => ps.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className={`flex justify-between items-baseline px-3 py-2 rounded-lg ${balance > 0 ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900'}`}>
        <span className="text-sm font-semibold">{balance > 0 ? 'Balance remaining' : 'Change'}</span>
        <span className="tabular-nums text-xl font-bold">₱{peso(balance > 0 ? balance : change)}</span>
      </div>

      {!cardForm ? (
        <>
          <div className="flex gap-2 items-end">
            <Field label="Cash amount">
              <Input className="text-right tabular-nums text-xl" inputMode="decimal" placeholder="0.00"
                value={cash} onChange={e => setCash(e.target.value.replace(/[^0-9.]/g, ''))} />
            </Field>
            <Btn variant="dark" onClick={addCash}>Add cash</Btn>
            <Btn onClick={() => setCardForm({ cardNo: '', bank: '', refNo: '', cardName: '', amount: String(Math.max(balance, 0)) })}>
              Add card
            </Btn>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[...new Set([balance, Math.ceil(balance / 100) * 100, Math.ceil(balance / 500) * 500, Math.ceil(balance / 1000) * 1000])]
              .filter(v => v > 0).map(q =>
                <Btn key={q} className="tabular-nums text-sm" onClick={() => setCash(String(q))}>₱{peso(q)}</Btn>)}
          </div>
        </>
      ) : (
        <div className="border border-stone-200 rounded-lg p-3 space-y-3">
          <h3 className="font-semibold text-sm">Credit / debit card</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Card No."><Input value={cardForm.cardNo} inputMode="numeric"
              onChange={e => setCardForm({ ...cardForm, cardNo: e.target.value })} /></Field>
            <Field label="Card Bank"><Input value={cardForm.bank}
              onChange={e => setCardForm({ ...cardForm, bank: e.target.value })} /></Field>
            <Field label="Reference No."><Input value={cardForm.refNo}
              onChange={e => setCardForm({ ...cardForm, refNo: e.target.value })} /></Field>
            <Field label="Card Name"><Input value={cardForm.cardName}
              onChange={e => setCardForm({ ...cardForm, cardName: e.target.value })} /></Field>
            <Field label="Amount"><Input className="text-right tabular-nums" inputMode="decimal" value={cardForm.amount}
              onChange={e => setCardForm({ ...cardForm, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setCardForm(null)}>Cancel</Btn>
            <Btn variant="dark" disabled={!cardForm.cardNo || !cardForm.bank || !cardForm.refNo || !cardForm.cardName || !Number(cardForm.amount)}
              onClick={() => {
                setPayments(ps => [...ps, { ...cardForm, type: 'CARD', amount: Number(cardForm.amount) }])
                setCardForm(null)
              }}>Add card payment</Btn>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={balance > 0 || !payments.length} onClick={() => onDone(payments)}>Complete sale</Btn>
      </div>
      <p className="text-xs text-stone-400">Card payments cannot exceed the balance — no change is given on card tenders.</p>
    </Modal>
  )
}

/* ---------------- Discount picker (5 types) ---------------- */
function DiscountModal({ current, onClose, onApply }) {
  const [type, setType] = useState(current?.type || null)
  const [controlNo, setControlNo] = useState(current?.controlNo || '')
  const [name, setName] = useState(current?.name || '')
  const d = DISCOUNT_TYPES.find(x => x.code === type)
  return (
    <Modal onClose={onClose} wide>
      <h2 className="text-lg font-bold">Discount type</h2>
      <p className="text-sm text-stone-500">
        Applied per item — only products flagged discountable are reduced. Non-discountable items stay at full price and remain VATable.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {DISCOUNT_TYPES.map(t => (
          <button key={t.code} onClick={() => setType(t.code)}
            className={`rounded-lg p-3 text-left border ${type === t.code ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white border-stone-300'}`}>
            <div className="font-bold text-sm">{t.code}</div>
            <div className={`text-xs ${type === t.code ? 'text-white/70' : 'text-stone-500'}`}>{t.label}</div>
            <div className={`text-xs mt-1 ${type === t.code ? 'text-white/70' : 'text-stone-400'}`}>
              {t.rate * 100}% · {t.vatExempt ? 'VAT-exempt' : 'VAT applies'} · {t.law}
            </div>
          </button>
        ))}
        <button onClick={() => setType(null)}
          className={`rounded-lg p-3 text-left border ${!type ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white border-stone-300'}`}>
          <div className="font-bold text-sm">NONE</div>
          <div className={`text-xs ${!type ? 'text-white/70' : 'text-stone-500'}`}>Regular sale</div>
        </button>
      </div>
      {type && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Control No."><Input value={controlNo} onChange={e => setControlNo(e.target.value)} placeholder="ID / booklet number" /></Field>
          <Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Full name on ID" /></Field>
        </div>
      )}
      {d && <Note tone="stone">Both fields print on the receipt and feed the BIR discount report. A signature line is printed underneath.</Note>}
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={type && (!controlNo || !name)}
          onClick={() => onApply(type ? { type, controlNo, name } : null)}>Apply</Btn>
      </div>
    </Modal>
  )
}

/* ============================================================
   BLIND CLOSE  →  END OF DAY
   ============================================================ */
function BlindClose({ go, branch, terminal, queued, online, setDayState }) {
  const DENOMS = ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.25']
  const [counts, setCounts] = useState({ '1000': '18', '500': '9', '100': '14', '50': '6', '20': '11', '5': '8' })
  const [stage, setStage] = useState('count')   // count → submitted → eod → done
  const [override, setOverride] = useState(false)
  const [paper, setPaper] = useState(false)
  const declared = DENOMS.reduce((s, d) => s + Number(d) * (Number(counts[d]) || 0), 0)

  if (stage === 'done') return (
    <div className="h-full flex items-center justify-center p-6 overflow-auto">
      <div className="bg-white rounded-2xl p-8 max-w-sm text-center space-y-4 shadow my-auto">
        <div className="text-4xl">🔒</div>
        <h1 className="text-2xl font-bold">End of Day complete</h1>
        <p className="text-stone-500 text-sm">
          {branch}/{terminal} is closed. Z-Read printed and emailed. Cashier login reopens tomorrow;
          Admin can still sign in.
        </p>
        <Btn variant="primary" className="w-full" onClick={() => { setDayState('eodDone'); go('login') }}>Sign out</Btn>
      </div>
    </div>
  )

  if (stage === 'submitted') return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-md mx-auto space-y-4">
        <div className="bg-white rounded-2xl p-8 text-center space-y-4 shadow">
          <div className="text-4xl">✓</div>
          <h1 className="text-2xl font-bold">Shift closed</h1>
          <p className="text-stone-500 text-sm">
            Your count was submitted and the closing report printed for supervisor verification.
            You never saw sales totals or short/over.
          </p>
        </div>
        <Note tone="amber" title="Is the store finished for today?">
          If another cashier takes over this terminal, sign out and let them open a new shift.
          If this is the last shift, run End of Day. Forgetting is recoverable — you can sign back in
          later for EOD only, or an Admin can close the day from the Admin console.
        </Note>
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => { setDayState('eodPending'); go('login') }}>Sign out (EOD later)</Btn>
          <Btn variant="primary" onClick={() => setStage('eod')}>Run End of Day</Btn>
        </div>
      </div>
    </div>
  )

  if (stage === 'eod') return (
    <div className="h-full overflow-auto p-6 relative">
      <div className="max-w-md mx-auto space-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">End of Day</div>
          <h1 className="text-2xl font-bold">Close {branch}/{terminal} for today</h1>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow space-y-3 text-sm">
          <div className="flex justify-between border-b border-stone-100 pb-2"><span>All shifts blind-closed</span><span className="text-emerald-700 font-semibold">✓ 2 of 2</span></div>
          <div className="flex justify-between border-b border-stone-100 pb-2"><span>Offline queue synced</span><span className={queued && !online ? 'text-red-700 font-semibold' : 'text-emerald-700 font-semibold'}>{queued && !online ? `✗ ${queued} pending` : '✓ 0 pending'}</span></div>
          <div className="flex justify-between border-b border-stone-100 pb-2"><span>Open transactions</span><span className="text-emerald-700 font-semibold">✓ none</span></div>
          <div className="flex justify-between"><span>Z-Read for today</span><span className="text-stone-500">not yet generated</span></div>
        </div>
        <Note tone="amber" title="Requires supervisor authorization">
          EOD always asks for a Supervisor or Admin credential. Once processed, sales for today can no
          longer be added or voided on this terminal, and cashier login is blocked until the next business day.
        </Note>
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => setStage('submitted')}>Back</Btn>
          <Btn variant="primary" disabled={queued > 0 && !online} onClick={() => setOverride(true)}>Process End of Day</Btn>
        </div>
      </div>
      {override && <EodOverrideModal branch={branch} terminal={terminal}
        onClose={() => setOverride(false)} onConfirm={() => { setOverride(false); setPaper(true) }} />}
      {paper && (
        <Modal onClose={() => { setPaper(false); setStage('done') }}>
          <Paper lines={zreadPaper(branch, terminal)} />
          <Btn variant="dark" className="w-full" onClick={() => { setPaper(false); setStage('done') }}>Close</Btn>
        </Modal>
      )}
    </div>
  )

  return (
    <div className="h-full overflow-auto p-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">Blind Close · {branch}/{terminal}</div>
          <h1 className="text-2xl font-bold">Count your drawer</h1>
          <p className="text-stone-500 text-sm mt-1">Enter the exact number of each bill and coin. Sales totals stay hidden — the system computes short/over for your supervisor.</p>
        </div>
        {queued > 0 && !online && <Note tone="amber">{queued} sale(s) still queued offline. Reconnect before closing so the count is checked against complete data.</Note>}
        <div className="bg-white rounded-2xl p-4 shadow grid grid-cols-2 gap-x-6 gap-y-2">
          {DENOMS.map(d => (
            <label key={d} className="flex items-center gap-2">
              <span className="tabular-nums w-14 text-right font-bold text-sm">₱{d}</span>
              <span className="text-stone-400">×</span>
              <Input className="!min-h-[40px] text-right tabular-nums !text-sm" inputMode="numeric" placeholder="0"
                value={counts[d] || ''} onChange={e => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })} />
            </label>
          ))}
        </div>
        <div className="bg-stone-900 text-white rounded-2xl px-5 py-4 flex justify-between items-baseline">
          <span className="text-[10px] tracking-[0.3em] uppercase text-white/50">Declared cash</span>
          <span className="tabular-nums text-3xl font-bold">₱{peso(declared)}</span>
        </div>
        <Note tone="stone" title="What the cashier never sees">
          Card payments are excluded from the drawer count. Expected cash, net sales and short/over are
          computed on the server and returned only to Supervisor/Admin.
        </Note>
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => go('pos')}>Back to POS</Btn>
          <Btn variant="primary" disabled={declared <= 0} onClick={() => setStage('submitted')}>Submit count</Btn>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   ADMIN
   ============================================================ */
const ADMIN_TABS = ['Dashboard', 'Branches', 'Products', 'Price Lists', 'Categories', 'Users', 'Terminals', 'POS Settings', 'Email', 'Closings', 'Z-Read / EOD', 'Reports']

function Admin({ go, branch, setBranch, settings, setSettings }) {
  const [tab, setTab] = useState('Dashboard')
  return (
    <div className="h-full flex flex-col">
      <header className="bg-stone-900 text-white px-3 py-2 flex items-center gap-2 text-sm flex-wrap">
        <span className="font-bold">TabletPOS Admin</span>
        <span className="text-white/50">Juan Dela Cruz · Admin</span>
        <select className="bg-white/10 rounded px-2 py-1 text-white text-xs" value={branch} onChange={e => setBranch(e.target.value)}>
          <option value="ALL" className="text-stone-900">All branches (consolidated)</option>
          {BRANCHES.map(b => <option key={b.code} value={b.code} className="text-stone-900">{b.code}</option>)}
        </select>
        <button className="ml-auto underline text-white/70" onClick={() => go('cashbegin')}>Open POS</button>
        <button className="underline text-white/70" onClick={() => go('login')}>Sign out</button>
      </header>
      <div className="flex gap-2 p-3 overflow-x-auto">
        {ADMIN_TABS.map(t => <Btn key={t} variant={tab === t ? 'moss' : 'ghost'}
          className="whitespace-nowrap !min-h-[40px] text-sm" onClick={() => setTab(t)}>{t}</Btn>)}
      </div>
      <div className="flex-1 overflow-auto p-3 pt-0">
        {tab === 'Dashboard' && <Dashboard branch={branch} />}
        {tab === 'Branches' && <AdminBranches />}
        {tab === 'Products' && <AdminProducts />}
        {tab === 'Price Lists' && <AdminPriceLists />}
        {tab === 'Categories' && <AdminCategories />}
        {tab === 'Users' && <AdminUsers />}
        {tab === 'Terminals' && <AdminTerminals />}
        {tab === 'POS Settings' && <AdminSettings settings={settings} setSettings={setSettings} />}
        {tab === 'Email' && <AdminEmail />}
        {tab === 'Closings' && <AdminClosings />}
        {tab === 'Z-Read / EOD' && <AdminZRead />}
        {tab === 'Reports' && <AdminReports />}
      </div>
    </div>
  )
}

const Stat = ({ label, value, sub, tone }) => (
  <div className="bg-white rounded-xl p-4 shadow">
    <div className="text-[10px] tracking-[0.25em] uppercase text-stone-400">{label}</div>
    <div className={`tabular-nums text-2xl font-bold mt-1 ${tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-800' : ''}`}>{value}</div>
    {sub && <div className="text-xs text-stone-500 mt-0.5">{sub}</div>}
  </div>
)

function Dashboard({ branch }) {
  const perBranch = [
    { code: 'MAIN', net: 27450, txns: 42, eod: 'Closed' },
    { code: 'MDU', net: 19110, txns: 31, eod: 'Open' },
    { code: 'LAP', net: 14320, txns: 26, eod: 'Open' },
  ]
  const bars = [18400, 22150, 19800, 26300, 31200, 38900, 27450]
  const max = Math.max(...bars)
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={branch === 'ALL' ? 'Net sales — all branches' : `Net sales — ${branch}`}
          value={branch === 'ALL' ? '₱60,880.00' : '₱27,450.00'} sub={branch === 'ALL' ? '99 transactions' : '42 transactions'} />
        <Stat label="Open shifts" value="2" sub="MDU · LAP" />
        <Stat label="Unsynced terminals" value="0" sub="All caught up" tone="green" />
        <Stat label="Short/(Over) today" value="(₱150.00)" sub="MDU POS-02 · over" tone="red" />
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 shadow">
          <div className="text-sm font-semibold mb-3">Net sales — last 7 days</div>
          <div className="flex items-end gap-2 h-36">
            {bars.map((b, i) => <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full bg-emerald-800 rounded-t" style={{ height: `${(b / max) * 100}%` }} />
              <span className="text-[10px] text-stone-500">{days[i]}</span>
            </div>)}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">Branch performance today</h3>
          <Table head={['Branch', 'Txns', 'Net sales', 'EOD status']}
            rows={perBranch.map(b => [b.code, b.txns, peso(b.net),
              <span key={b.code} className={b.eod === 'Closed' ? 'text-emerald-800 font-semibold' : 'text-amber-700 font-semibold'}>{b.eod}</span>])} />
        </div>
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <div>
          <h3 className="text-sm font-semibold mb-2">Top items (all branches)</h3>
          <Table head={['Item', 'Qty', 'Amount']} rows={[
            ['Pork Belly (Liempo) 1kg', '128.5', '48,830.00'],
            ['Whole Chicken 1kg', '210.0', '40,950.00'],
            ['Beef Brisket 1kg', '62.0', '29,760.00'],
          ]} />
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">Needs attention</h3>
          <Table head={['When', 'Item']} rows={[
            ['Today 14:20', 'MDU POS-02 short/over exceeded ₱100'],
            ['Today 11:05', '3 price edits by Maria Santos (MAIN)'],
            ['Yesterday', 'LAP POS-01 EOD not processed'],
          ]} />
        </div>
      </div>
    </div>
  )
}

function AdminBranches() {
  const [edit, setEdit] = useState(null)
  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({ new: true })}>Add branch</Btn>
      <Table head={['Code', 'Branch name', 'TIN', 'Address', 'Terminals', 'Own price list', 'Active', '']}
        rows={BRANCHES.map((b, i) => [b.code, b.name, b.tin,
          ['123 Market St, Cebu City', 'Ouano Ave, Mandaue', 'ML Quezon, Lapu-Lapu'][i],
          ['2', '2', '1'][i], 'Yes', 'Yes',
          <button key={b.code} className="underline text-emerald-800" onClick={() => setEdit(b)}>Edit</button>])} />
      <Note tone="green" title="Why every table carries BranchCode">
        Sales, shifts, OR ranges, Z-Reads, audit logs and prices are all tagged by branch. That lets each
        branch run independently (own OR series, own EOD, own BIR permit) while head office reads a single
        consolidated database. Adding a branch later needs no schema change.
      </Note>
      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.new ? 'New branch' : `Edit ${edit.code}`}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch code"><Input defaultValue={edit.code || ''} placeholder="e.g. TAL" /></Field>
            <Field label="Branch name"><Input defaultValue={edit.name || ''} /></Field>
            <Field label="TIN"><Input defaultValue={edit.tin || ''} /></Field>
            <Field label="Branch code (BIR)"><Input defaultValue="0000" /></Field>
            <Field label="Address"><Input /></Field>
            <Field label="Contact number"><Input /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked /> Active</label>
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={() => setEdit(null)}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

function AdminProducts() {
  const [edit, setEdit] = useState(null)
  const [priceEdit, setPriceEdit] = useState(null)
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <Btn variant="primary" onClick={() => setEdit({ new: true, overrides: {} })}>Add product</Btn>
        <Btn>Import CSV</Btn>
        <Input className="!w-56" placeholder="Search products…" />
      </div>
      <Table head={['Barcode', 'Name', 'Category', 'Base price', 'Branch overrides', 'VATable', 'Discountable', 'Price edit', '']}
        rows={PRODUCTS.map(p => {
          const n = Object.keys(p.overrides).length
          return [
            p.barcode, p.name, CATEGORIES.find(c => c.id === p.cat).name, peso(p.base),
            <button key={'o' + p.id} className="underline text-emerald-800" onClick={() => setPriceEdit(p)}>
              {n === 0 ? 'none — uses base' : `${n} branch${n > 1 ? 'es' : ''}`}
            </button>,
            p.vat ? 'Yes' : 'No',
            <span key={'d' + p.id} className={p.disc ? 'text-emerald-800 font-semibold' : 'text-stone-400'}>{p.disc ? 'Yes' : 'No'}</span>,
            p.editable ? 'Allowed' : 'Locked',
            <button key={p.id} className="underline text-emerald-800" onClick={() => setEdit(p)}>Edit</button>,
          ]
        })} />
      <Note tone="green" title="One base price, overrides only where needed">
        A product carries a single base price. A branch row exists only when that branch charges something
        different, so 30 branches does not mean 30 fields — most products have none. The POS resolves
        price as: branch override if one exists, otherwise base. Use the Price Lists tab for bulk changes.
      </Note>
      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.new ? 'New product' : 'Edit product'}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Barcode"><Input defaultValue={edit.barcode || ''} /></Field>
            <Field label="Product name"><Input defaultValue={edit.name || ''} /></Field>
            <Field label="Category">
              <Select className="w-full">{CATEGORIES.map(c => <option key={c.id}>{c.name}</option>)}</Select>
            </Field>
            <Field label="Unit"><Select className="w-full"><option>kg</option><option>pc</option><option>pack</option></Select></Field>
            <Field label="Base price (all branches)"><Input className="text-right tabular-nums" defaultValue={edit.base ?? ''} inputMode="decimal" /></Field>
            <Field label="Cost"><Input className="text-right tabular-nums" inputMode="decimal" /></Field>
          </div>
          <div className="flex gap-5 text-sm flex-wrap border-t border-stone-100 pt-3">
            <label className="flex items-center gap-2"><input type="checkbox" defaultChecked={edit.vat ?? true} /> <span><strong>VATable</strong> — 12% applies</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" defaultChecked={edit.disc ?? true} /> <span><strong>Discountable</strong> — eligible for SC/PWD/NAAC/MOV/Solo</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" defaultChecked={edit.editable} /> <span><strong>Price editable</strong> at POS</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" defaultChecked /> <span><strong>Active</strong></span></label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn onClick={() => { setPriceEdit(edit); setEdit(null) }}>Branch prices…</Btn>
            <Btn variant="primary" onClick={() => setEdit(null)}>Save</Btn>
          </div>
        </Modal>
      )}
      {priceEdit && <BranchPriceModal product={priceEdit} onClose={() => setPriceEdit(null)} />}
    </div>
  )
}

function BranchPriceModal({ product, onClose }) {
  const [rows, setRows] = useState(Object.entries(product.overrides).map(([code, price]) => ({ code, price })))
  const unused = BRANCHES.filter(b => !rows.some(r => r.code === b.code))
  return (
    <Modal onClose={onClose} wide>
      <div>
        <h2 className="font-bold text-lg">Branch prices — {product.name}</h2>
        <p className="text-sm text-stone-500">Base price ₱{peso(product.base)} applies to every branch not listed here.</p>
      </div>
      <div className="border border-stone-200 rounded-lg divide-y divide-stone-100">
        {rows.map((r, i) => (
          <div key={r.code} className="px-3 py-2 flex items-center gap-3 text-sm">
            <span className="font-semibold w-16">{r.code}</span>
            <span className="flex-1 text-stone-500 truncate">{BRANCHES.find(b => b.code === r.code)?.name}</span>
            <Input className="!w-32 !min-h-[38px] text-right tabular-nums" value={r.price} inputMode="decimal"
              onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, price: e.target.value.replace(/[^0-9.]/g, '') } : x))} />
            <span className={`tabular-nums text-xs w-16 text-right ${Number(r.price) > product.base ? 'text-red-700' : 'text-emerald-700'}`}>
              {Number(r.price) > product.base ? '+' : ''}{peso(Number(r.price) - product.base)}
            </span>
            <button className="text-red-700 text-lg" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        {!rows.length && <p className="px-3 py-6 text-stone-400 text-sm text-center">No overrides — every branch sells at ₱{peso(product.base)}.</p>}
      </div>
      {unused.length > 0 && (
        <div className="flex gap-2 items-end">
          <Field label="Add override for branch">
            <Select className="w-full" id="brsel">{unused.map(b => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}</Select>
          </Field>
          <Btn variant="dark" onClick={() => {
            const code = document.getElementById('brsel').value
            setRows(rs => [...rs, { code, price: String(product.base) }])
          }}>Add</Btn>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={onClose}>Save prices</Btn>
      </div>
    </Modal>
  )
}

function AdminPriceLists() {
  const [branch, setBranch] = useState('MDU')
  const [bulk, setBulk] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <Field label="View price list for">
          <Select value={branch} onChange={e => setBranch(e.target.value)}>
            {BRANCHES.map(b => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
          </Select>
        </Field>
        <Btn variant="dark" onClick={() => setBulk(true)}>Bulk update</Btn>
        <Btn>Import CSV</Btn>
        <Btn>Export CSV</Btn>
        <Btn>Copy from another branch</Btn>
      </div>
      <Table head={['Barcode', 'Product', 'Category', 'Base', `${branch} price`, 'Source', 'Difference']}
        rows={PRODUCTS.map(p => {
          const over = p.overrides[branch]
          const eff = over ?? p.base
          return [p.barcode, p.name, CATEGORIES.find(c => c.id === p.cat).name, peso(p.base), peso(eff),
            over != null
              ? <span key={p.id} className="text-emerald-800 font-semibold">Branch override</span>
              : <span key={p.id} className="text-stone-400">Base price</span>,
            over != null
              ? <span key={'d' + p.id} className={eff > p.base ? 'text-red-700' : 'text-emerald-700'}>{eff > p.base ? '+' : ''}{peso(eff - p.base)}</span>
              : '—']
        })} />
      <Note tone="stone" title="Managing many branches">
        This tab is the practical way to price 30 branches: pick a branch, see its effective list, and edit
        in place. Bulk update applies a percentage or fixed amount to a whole category. Copy-from-branch
        clones one branch's overrides to another — useful when a region shares pricing.
      </Note>
      {bulk && (
        <Modal onClose={() => setBulk(false)} wide>
          <h2 className="font-bold text-lg">Bulk price update</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Target branches">
              <Select className="w-full"><option>{branch} only</option><option>All branches</option><option>Selected branches…</option></Select>
            </Field>
            <Field label="Category"><Select className="w-full"><option>All categories</option>{CATEGORIES.map(c => <option key={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Adjustment"><Select className="w-full"><option>Increase by %</option><option>Decrease by %</option><option>Increase by amount</option><option>Set to base price</option></Select></Field>
            <Field label="Value"><Input className="text-right tabular-nums" defaultValue="5" /></Field>
            <Field label="Rounding"><Select className="w-full"><option>Nearest ₱1</option><option>Nearest ₱0.05</option><option>No rounding</option></Select></Field>
            <Field label="Effective date"><Input type="date" defaultValue="2026-08-17" /></Field>
          </div>
          <Note tone="amber">Affects 14 products across 1 branch. A price-change audit entry is written for each row.</Note>
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setBulk(false)}>Cancel</Btn>
            <Btn variant="primary" onClick={() => setBulk(false)}>Preview and apply</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

function AdminCategories() {
  return (
    <div>
      <Btn variant="primary" className="mb-3">Add category</Btn>
      <Table head={['Category', 'Products', 'Default discountable', 'Active', '']}
        rows={CATEGORIES.map(c => [c.name, PRODUCTS.filter(p => p.cat === c.id).length,
          c.id <= 3 ? 'Yes' : 'No', 'Yes',
          <button key={c.id} className="underline text-emerald-800">Edit</button>])} />
    </div>
  )
}

function AdminUsers() {
  const users = [
    ['jdelacruz', 'Juan Dela Cruz', 'Admin', 'All branches', 'Yes'],
    ['msantos', 'Maria Santos', 'Cashier', 'MAIN', 'Yes'],
    ['rlim', 'Roberto Lim', 'Supervisor', 'MAIN, MDU', 'Yes'],
    ['areyes', 'Ana Reyes', 'Cashier', 'MDU', 'No'],
  ]
  return (
    <div className="space-y-3">
      <Btn variant="primary">Add user</Btn>
      <Table head={['Username', 'Full name', 'Role', 'Branch access', 'Active', '']}
        rows={users.map((u, i) => [...u, <button key={i} className="underline text-emerald-800">Edit / Reset password</button>])} />
      <div className="bg-white rounded-xl p-4 shadow text-sm text-stone-600">
        <strong className="block mb-2 text-stone-900">Role permissions</strong>
        <div className="grid md:grid-cols-3 gap-3">
          <div><div className="font-semibold text-stone-900">Cashier</div>Sell, X-Read, reprint, blind close, run EOD. Cannot see totals, variance or reports.</div>
          <div><div className="font-semibold text-stone-900">Supervisor</div>Cashier rights plus void override, variance, Z-Read, all reports — for assigned branches only.</div>
          <div><div className="font-semibold text-stone-900">Admin</div>Everything, all branches, plus branch/product/user/terminal/POS/email configuration.</div>
        </div>
      </div>
    </div>
  )
}

function AdminTerminals() {
  const [edit, setEdit] = useState(null)
  const [test, setTest] = useState('')
  const terms = [
    { branch: 'MAIN', code: 'POS-01', name: 'Counter 1', printer: 'tcp://192.168.1.50:9100', min: '08012026123456789', serial: 'M1-2026-0001', permit: 'FP012026-001', accred: '043-123456789-000012', tin: '123-456-789-0000', eff: '2026-01-08', or: '100001–100500 (458 left)', status: 'EOD done' },
    { branch: 'MAIN', code: 'POS-02', name: 'Counter 2', printer: 'file://COM3', min: '08012026123456790', serial: 'M1-2026-0002', permit: 'FP012026-002', accred: '043-123456789-000013', tin: '123-456-789-0000', eff: '2026-01-08', or: '100501–101000 (500 left)', status: 'Shift open' },
    { branch: 'MDU', code: 'POS-01', name: 'Mandaue Counter 1', printer: 'tcp://192.168.2.50:9100', min: '08012026123456791', serial: 'M2-2026-0001', permit: 'FP012026-011', accred: '043-123456789-000021', tin: '123-456-789-0001', eff: '2026-01-15', or: '200001–200500 (490 left)', status: 'Idle' },
  ]
  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({ new: true })}>Add terminal</Btn>
      <Table head={['Branch', 'Code', 'Name', 'Serial No.', 'MIN', 'Permit No.', 'Accreditation No.', 'Effective', 'OR block', 'Status', '']}
        rows={terms.map((t, i) => [t.branch, t.code, t.name, t.serial, t.min, t.permit, t.accred, t.eff, t.or,
          <span key={i} className={t.status === 'EOD done' ? 'text-stone-500' : 'text-emerald-800 font-semibold'}>{t.status}</span>,
          <span key={'x' + i} className="flex gap-2">
            <button className="underline text-emerald-800" onClick={() => setEdit(t)}>Edit</button>
            <button className="underline text-emerald-800" onClick={() => setTest(`${t.branch}/${t.code}`)}>Test print</button>
          </span>])} />
      <Note tone="amber" title="BIR registration data prints on every receipt">
        TIN, MIN, Serial No., Permit No. and Accreditation No. appear in the receipt header. They are stored
        per terminal per branch, so each registered machine prints its own credentials. Effective date guards
        against printing a permit before it is valid.
      </Note>
      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.new ? 'New terminal' : `Edit ${edit.branch}/${edit.code}`}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch"><Select className="w-full" defaultValue={edit.branch}>{BRANCHES.map(b => <option key={b.code}>{b.code}</option>)}</Select></Field>
            <Field label="Terminal code"><Input defaultValue={edit.code || ''} placeholder="POS-03" /></Field>
            <Field label="Terminal name"><Input defaultValue={edit.name || ''} /></Field>
            <Field label="Printer target"><Input defaultValue={edit.printer || ''} placeholder="tcp://IP:9100 or file://COM3" /></Field>
          </div>
          <div className="border-t border-stone-100 pt-3">
            <div className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-2">BIR registration</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="TIN Number"><Input defaultValue={edit.tin || ''} placeholder="000-000-000-0000" /></Field>
              <Field label="Accreditation Number"><Input defaultValue={edit.accred || ''} /></Field>
              <Field label="Serial Number"><Input defaultValue={edit.serial || ''} /></Field>
              <Field label="Permit Number (PTU)"><Input defaultValue={edit.permit || ''} /></Field>
              <Field label="MIN Number"><Input defaultValue={edit.min || ''} /></Field>
              <Field label="Effective date of permit"><Input type="date" defaultValue={edit.eff || ''} /></Field>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked /> Active</label>
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={() => setEdit(null)}>Save</Btn>
          </div>
        </Modal>
      )}
      {test && (
        <Modal onClose={() => setTest('')}>
          <Paper lines={[ctr('*** TEST PRINT ***'), ctr(test), ctr(new Date().toLocaleString('en-PH').slice(0, 20)), rule(),
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789 P1,234.56', rule(), ctr('Agent reachable - cutter OK'), '']} />
          <Btn variant="dark" className="w-full" onClick={() => setTest('')}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

function AdminSettings({ settings, setSettings }) {
  const POS_TYPES = [
    { code: 'Retail', desc: 'Discount applies to eligible items across the whole receipt. Current default.' },
    { code: 'Restaurant', desc: 'Discount is split by the number of diners; only the claimant\'s share is discounted. Service charge is excluded from the discount base.' },
    { code: 'Pharmacy', desc: 'Discount applies to medicines only; the claimant\'s prescription and doctor details are captured per transaction.' },
  ]
  return (
    <div className="space-y-3 max-w-3xl">
      <div className="bg-white rounded-xl p-5 shadow space-y-4">
        <div>
          <h2 className="font-bold">POS type</h2>
          <p className="text-sm text-stone-500">Controls how discounts are computed. Set per branch.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {POS_TYPES.map(t => (
            <button key={t.code} onClick={() => setSettings(s => ({ ...s, posType: t.code }))}
              className={`rounded-lg p-3 text-left border ${settings.posType === t.code ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white border-stone-300'}`}>
              <div className="font-bold text-sm">{t.code}</div>
              <div className={`text-xs mt-1 ${settings.posType === t.code ? 'text-white/70' : 'text-stone-500'}`}>{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 shadow space-y-3">
        <h2 className="font-bold">Transaction controls</h2>
        {[
          { k: 'voidOverride', label: 'Require supervisor override for void', desc: 'When off, a cashier can void their own last transaction. Either way it is logged.' },
          { k: 'priceEditOverride', label: 'Require supervisor override for price edit', desc: 'Applies only to products flagged price-editable.' },
          { k: 'refundEnabled', label: 'Allow refund / return', desc: 'Prints a return slip referencing the original OR number.' },
          { k: 'reprintOverride', label: 'Require supervisor override for reprint', desc: 'Reprints are always marked REPRINT on the receipt.' },
          { k: 'forceEod', label: 'Block cashier login after EOD until next business day', desc: 'Terminal reopens automatically on the next day.' },
        ].map(o => (
          <label key={o.k} className="flex items-start gap-3 border-b border-stone-100 pb-3 last:border-0">
            <input type="checkbox" className="mt-1" checked={!!settings[o.k]}
              onChange={e => setSettings(s => ({ ...s, [o.k]: e.target.checked }))} />
            <span className="text-sm"><span className="font-semibold block">{o.label}</span>
              <span className="text-stone-500">{o.desc}</span></span>
          </label>
        ))}
      </div>

      <div className="bg-white rounded-xl p-5 shadow space-y-3">
        <h2 className="font-bold">Numbering &amp; limits</h2>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="OR block size per allocation"><Input defaultValue="500" className="tabular-nums" /></Field>
          <Field label="Warn when OR remaining below"><Input defaultValue="25" className="tabular-nums" /></Field>
          <Field label="Max discount per transaction (₱)"><Input defaultValue="5000" className="tabular-nums" /></Field>
        </div>
      </div>

      <Btn variant="primary">Save settings</Btn>
    </div>
  )
}

function AdminEmail() {
  return (
    <div className="max-w-xl space-y-3">
      <div className="bg-white rounded-xl p-5 shadow space-y-3">
        <h2 className="font-bold">Automated Z-Read / EOD email</h2>
        <p className="text-sm text-stone-500">Sent automatically when a terminal completes End of Day.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SMTP host"><Input defaultValue="smtp.gmail.com" /></Field>
          <Field label="Port"><Input defaultValue="587" className="tabular-nums" /></Field>
        </div>
        <Field label="SMTP username"><Input defaultValue="pos@meatshop.ph" /></Field>
        <Field label="SMTP password"><Input type="password" defaultValue="••••••••••" /></Field>
        <Field label="From address"><Input defaultValue="pos@meatshop.ph" /></Field>
        <Field label="Recipients (comma separated)"><Input defaultValue="owner@meatshop.ph, accounting@meatshop.ph" /></Field>
        <Field label="Per-branch recipient override">
          <Select className="w-full"><option>Use global recipients for all branches</option><option>Configure per branch…</option></Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Btn>Send test email</Btn><Btn variant="primary">Save settings</Btn>
        </div>
      </div>
    </div>
  )
}

function AdminClosings() {
  const [detail, setDetail] = useState(null)
  const rows = [
    { date: '2026-08-16', br: 'MAIN', term: 'POS-01', cashier: 'Maria Santos', begin: 5000, cash: 26679.5, card: 3500, declared: 31679.5, expected: 31679.5, so: 0 },
    { date: '2026-08-16', br: 'MDU', term: 'POS-02', cashier: 'Ana Reyes', begin: 5000, cash: 23750, card: 1200, declared: 28900, expected: 28750, so: 150 },
    { date: '2026-08-15', br: 'MAIN', term: 'POS-01', cashier: 'Maria Santos', begin: 5000, cash: 25320, card: 900, declared: 30120, expected: 30320, so: -200 },
  ]
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <Input type="date" className="!w-auto" defaultValue="2026-08-15" />
        <span className="text-stone-400">to</span>
        <Input type="date" className="!w-auto" defaultValue="2026-08-16" />
        <Select><option>All branches</option>{BRANCHES.map(b => <option key={b.code}>{b.code}</option>)}</Select>
        <Btn variant="dark">Load</Btn><Btn>Export Excel</Btn>
      </div>
      <Table head={['Date', 'Branch', 'Terminal', 'Cashier', 'Cash begin', 'Cash sales', 'Card sales', 'Declared', 'Expected cash', 'Short/(Over)', '']}
        rows={rows.map((r, i) => [r.date, r.br, r.term, r.cashier, peso(r.begin), peso(r.cash), peso(r.card),
          peso(r.declared), peso(r.expected),
          <span key={i} className={r.so === 0 ? '' : r.so > 0 ? 'text-emerald-800 font-semibold' : 'text-red-700 font-semibold'}>
            {r.so === 0 ? '—' : r.so > 0 ? `(${peso(r.so)})` : peso(Math.abs(r.so))}</span>,
          <button key={'b' + i} className="underline text-emerald-800" onClick={() => setDetail(r)}>Denominations</button>])} />
      <Note tone="stone">Card sales are excluded from the expected-cash calculation. Positive variance shown in parentheses = over. Supervisor/Admin only.</Note>
      {detail && (
        <Modal onClose={() => setDetail(null)}>
          <h2 className="font-bold text-lg">{detail.br}/{detail.term} · {detail.cashier}</h2>
          <Table head={['Denom', 'Count', 'Amount']} rows={[
            ['₱1,000', '18', '18,000.00'], ['₱500', '9', '4,500.00'], ['₱100', '14', '1,400.00'],
            ['₱50', '6', '300.00'], ['₱20', '11', '220.00'], ['₱5', '8', '40.00']]} />
          <Btn variant="dark" className="w-full" onClick={() => setDetail(null)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

function AdminZRead() {
  const [paper, setPaper] = useState(false)
  const [override, setOverride] = useState(null)
  const pending = [
    { br: 'MAIN', term: 'POS-01', date: '2026-08-16', shifts: 'All closed', cashier: 'Maria Santos', why: 'Cashier signed out without running EOD' },
    { br: 'LAP', term: 'POS-01', date: '2026-08-15', shifts: 'All closed', cashier: 'Ana Reyes', why: 'Terminal lost power before EOD' },
  ]
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold mb-2">Days awaiting End of Day</h3>
        <Table head={['Business date', 'Branch', 'Terminal', 'Shifts', 'Last cashier', 'Why still open', '']}
          rows={pending.map((r, i) => [r.date, r.br, r.term,
            <span key={i} className="text-emerald-800">{r.shifts}</span>, r.cashier, r.why,
            <button key={'b' + i} className="underline text-red-700 font-semibold"
              onClick={() => setOverride(r)}>Run End of Day</button>])}
          empty="Every terminal is closed for the day." />
      </div>
      <Note tone="green" title="Two ways a day gets closed">
        Normally the cashier runs EOD at the terminal right after blind close. If they forget, the day
        appears here — an Admin closes it remotely, or the same cashier signs back in and gets an
        EOD-only screen. All three paths require a Supervisor/Admin override and write the same audit entry.
      </Note>
      <h3 className="text-sm font-semibold pt-2">Completed Z-Reads</h3>
      <div className="flex gap-2 items-center flex-wrap">
        <Select><option>All branches</option>{BRANCHES.map(b => <option key={b.code}>{b.code}</option>)}</Select>
        <Input type="date" className="!w-auto" defaultValue="2026-08-01" />
        <span className="text-stone-400">to</span>
        <Input type="date" className="!w-auto" defaultValue="2026-08-16" />
        <Btn variant="dark">Load</Btn><Btn>Export Excel</Btn>
      </div>
      <Table head={['Date', 'Branch', 'Terminal', 'Z#', 'Gross', 'Discounts', 'Net', 'VAT', 'Txns', 'Voids', 'OR range', 'Grand total', 'Closed by', '']}
        rows={[
          ['2026-08-15', 'MAIN', 'POS-01', '112', '28,880.00', '620.00', '28,260.00', '3,027.86', '39', '0', '99860–99899', '4,128,900.50', 'msantos / rlim',
            <button key="b" className="underline text-emerald-800" onClick={() => setPaper(true)}>View / reprint</button>],
          ['2026-08-15', 'MDU', 'POS-01', '87', '24,880.00', '310.00', '24,570.00', '2,632.50', '31', '1', '200001–200032', '1,882,440.00', 'areyes / rlim',
            <button key="c" className="underline text-emerald-800" onClick={() => setPaper(true)}>View / reprint</button>],
        ]} />
      {override && <EodOverrideModal branch={override.br} terminal={override.term}
        onClose={() => setOverride(null)} onConfirm={() => { setOverride(null); setPaper(true) }} />}
      {paper && (
        <Modal onClose={() => setPaper(false)}>
          <Paper lines={zreadPaper('MAIN', 'POS-01')} />
          <Btn variant="dark" className="w-full" onClick={() => setPaper(false)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

const REPORTS = {
  'Sales Summary': { head: ['Date', 'Branch', 'Terminal', 'Txns', 'Gross', 'Discounts', 'Net', 'VAT'], rows: [
    ['2026-08-16', 'MAIN', 'POS-01', '42', '31,420.00', '1,240.50', '30,179.50', '3,233.52'],
    ['2026-08-16', 'MDU', 'POS-02', '31', '19,420.00', '310.00', '19,110.00', '2,047.50'],
    ['2026-08-16', 'LAP', 'POS-01', '26', '14,620.00', '300.00', '14,320.00', '1,534.29'],
  ]},
  'Branch Comparison': { head: ['Branch', 'Txns', 'Gross', 'Discounts', 'Net', 'Avg basket', '% of total'], rows: [
    ['MAIN', '42', '31,420.00', '1,240.50', '30,179.50', '718.56', '47.4%'],
    ['MDU', '31', '19,420.00', '310.00', '19,110.00', '616.45', '30.1%'],
    ['LAP', '26', '14,620.00', '300.00', '14,320.00', '550.77', '22.5%'],
  ]},
  'Sales Details': { head: ['Date', 'Branch', 'Terminal', 'OR#', 'Time', 'Cashier', 'Gross', 'Discount', 'Net', 'Payment', 'Status'], rows: [
    ['2026-08-16', 'MAIN', 'POS-01', '100018', '14:22', 'Maria Santos', '1,140.00', '0.00', '1,140.00', 'Cash', 'Completed'],
    ['2026-08-16', 'MAIN', 'POS-01', '100017', '14:08', 'Maria Santos', '760.00', '135.71', '624.29', 'Cash + Card', 'Completed'],
    ['2026-08-16', 'MAIN', 'POS-01', '100016', '13:51', 'Maria Santos', '380.00', '0.00', '380.00', 'Cash', 'Voided'],
  ]},
  'Payment Breakdown': { head: ['Date', 'Branch', 'Cash', 'Card', 'Card txns', 'Total'], rows: [
    ['2026-08-16', 'MAIN', '26,679.50', '3,500.00', '4', '30,179.50'],
    ['2026-08-16', 'MDU', '17,910.00', '1,200.00', '2', '19,110.00'],
  ]},
  'Card Transactions': { head: ['Date', 'Branch', 'OR#', 'Bank', 'Card No.', 'Card name', 'Reference No.', 'Amount'], rows: [
    ['2026-08-16', 'MAIN', '100017', 'BDO', '****4821', 'J DELA CRUZ', 'REF-889201', '500.00'],
    ['2026-08-16', 'MAIN', '100014', 'BPI', '****9930', 'M REYES', 'REF-889188', '1,200.00'],
  ]},
  'Discounts (BIR)': { head: ['Date', 'Branch', 'OR#', 'Type', 'Control No.', 'Name', 'Gross', 'Discount', 'Net'], rows: [
    ['2026-08-16', 'MAIN', '100017', 'SENIOR', 'SC-04-119283', 'Jose Dela Cruz', '760.00', '135.71', '624.29'],
    ['2026-08-16', 'MDU', '100455', 'PWD', 'PWD-07-88120', 'Ana Villanueva', '480.00', '85.71', '394.29'],
    ['2026-08-16', 'LAP', '300112', 'SOLO', 'SP-2026-0912', 'Rita Manalo', '620.00', '55.36', '564.64'],
    ['2026-08-15', 'MAIN', '99881', 'NAAC', 'NA-2024-0031', 'Paolo Cruz', '900.00', '160.71', '739.29'],
  ]},
  'Group by Category': { head: ['Branch', 'Category', 'Qty', 'Amount', '% of sales'], rows: [
    ['MAIN', 'Pork', '284.5', '98,120.00', '41.2%'], ['MAIN', 'Chicken', '310.0', '64,880.00', '27.3%'],
    ['MDU', 'Pork', '190.0', '68,400.00', '38.9%'], ['MDU', 'Beef', '54.0', '26,460.00', '15.0%'],
  ]},
  'Group by Item': { head: ['Branch', 'Barcode', 'Item', 'Category', 'Qty', 'Amount'], rows: [
    ['MAIN', '4800001', 'Pork Belly (Liempo) 1kg', 'Pork', '128.5', '48,830.00'],
    ['MAIN', '4800006', 'Whole Chicken 1kg', 'Chicken', '210.0', '40,950.00'],
    ['MDU', '4800001', 'Pork Belly (Liempo) 1kg', 'Pork', '96.0', '36,960.00'],
  ]},
  'X-Read History': { head: ['Date', 'Time', 'Branch', 'Terminal', 'Cashier', 'Txns', 'Net at read'], rows: [
    ['2026-08-16', '14:30', 'MAIN', 'POS-01', 'Maria Santos', '18', '23,609.50'],
    ['2026-08-16', '11:00', 'MAIN', 'POS-01', 'Maria Santos', '9', '11,240.00'],
  ]},
  'Z-Read History': { head: ['Date', 'Branch', 'Terminal', 'Z#', 'Gross', 'Net', 'VAT', 'Txns', 'Grand total'], rows: [
    ['2026-08-16', 'MAIN', 'POS-01', '113', '31,420.00', '30,179.50', '3,233.52', '42', '4,159,080.00'],
    ['2026-08-15', 'MDU', 'POS-01', '87', '24,880.00', '24,570.00', '2,632.50', '31', '1,882,440.00'],
  ]},
  'Void / Return': { head: ['Date', 'Branch', 'OR#', 'Cashier', 'Approved by', 'Amount', 'Reason'], rows: [
    ['2026-08-16', 'MAIN', '100016', 'Maria Santos', 'Roberto Lim', '380.00', 'Customer changed mind'],
    ['2026-08-15', 'MDU', '200019', 'Ana Reyes', '— (override off)', '240.00', 'Wrong item punched'],
  ]},
  'Audit Logs': { head: ['When', 'Branch', 'User', 'Terminal', 'Action', 'Detail'], rows: [
    ['2026-08-16 17:02', 'MAIN', 'msantos', 'POS-01', 'EOD', 'End of Day processed, Z# 113'],
    ['2026-08-16 14:31', 'MAIN', 'msantos', 'POS-01', 'XREAD', 'X-Read generated'],
    ['2026-08-16 13:52', 'MAIN', 'rlim', 'POS-01', 'VOID', 'OR# 100016 voided — customer changed mind'],
    ['2026-08-16 11:14', 'MAIN', 'msantos', 'POS-01', 'PRICE_EDIT', 'Pork Belly 380.00 → 360.00'],
    ['2026-08-16 08:02', 'MAIN', 'msantos', 'POS-01', 'SHIFT_OPEN', 'Cash begin 5,000.00'],
  ]},
  'Cashier Performance': { head: ['Cashier', 'Branch', 'Shifts', 'Txns', 'Net sales', 'Voids', 'Price edits', 'Net short/(over)'], rows: [
    ['Maria Santos', 'MAIN', '12', '486', '312,480.00', '4', '9', '(120.00)'],
    ['Ana Reyes', 'MDU', '10', '392', '248,900.00', '11', '2', '340.00'],
  ]},
}

function AdminReports() {
  const names = Object.keys(REPORTS)
  const [sel, setSel] = useState(names[0])
  const r = REPORTS[sel]
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {names.map(n => <Btn key={n} variant={sel === n ? 'moss' : 'ghost'}
          className="whitespace-nowrap !min-h-[38px] text-xs" onClick={() => setSel(n)}>{n}</Btn>)}
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <Input type="date" className="!w-auto" defaultValue="2026-08-15" />
        <span className="text-stone-400">to</span>
        <Input type="date" className="!w-auto" defaultValue="2026-08-16" />
        <Select><option>All branches</option>{BRANCHES.map(b => <option key={b.code}>{b.code}</option>)}</Select>
        <Select><option>All terminals</option><option>POS-01</option><option>POS-02</option></Select>
        <Btn variant="dark">Load</Btn><Btn>Excel</Btn><Btn>PDF</Btn><Btn>Print</Btn>
      </div>
      <Table head={r.head} rows={r.rows} />
    </div>
  )
}

/* ============================================================
   SHELL
   ============================================================ */
const SCREENS = [
  { key: 'login', label: '1 · Login' },
  { key: 'cashbegin', label: '2 · Cash Begin' },
  { key: 'pos', label: '3 · POS Sales' },
  { key: 'blindclose', label: '4 · Blind Close → EOD' },
  { key: 'eodonly', label: '5 · EOD-only login' },
  { key: 'admin', label: '6 · Admin' },
]

export default function App() {
  const [screen, setScreen] = useState('login')
  const [branch, setBranch] = useState('MAIN')
  const [terminal, setTerminal] = useState('POS-01')
  const [cashBegin, setCashBegin] = useState(5000)
  const [online, setOnline] = useState(true)
  const [queued, setQueued] = useState(0)
  const [orNo, setOrNo] = useState(100018)
  const [lastSale, setLastSale] = useState(null)
  const [dayState, setDayState] = useState('open')  // open | eodPending | eodDone
  const [settings, setSettings] = useState({
    posType: 'Retail', voidOverride: true, priceEditOverride: false,
    refundEnabled: true, reprintOverride: false, forceEod: true,
  })
  const adminBranch = branch === 'ALL' ? 'MAIN' : branch

  return (
    <div className="w-full h-screen bg-stone-100 flex flex-col text-stone-900">
      <div className="bg-stone-800 text-white px-3 py-2 flex items-center gap-2 flex-wrap text-xs shrink-0">
        <span className="uppercase tracking-[0.2em] text-white/40">Mockup v3</span>
        {SCREENS.map(s => (
          <button key={s.key} onClick={() => setScreen(s.key)}
            className={`px-3 py-1.5 rounded-md font-semibold ${screen === s.key ? 'bg-white text-stone-900' : 'bg-white/10 hover:bg-white/20'}`}>
            {s.label}
          </button>
        ))}
        <span className="ml-2 text-white/40">Day:</span>
        <select className="bg-white/10 rounded px-2 py-1 text-white" value={dayState} onChange={e => setDayState(e.target.value)}>
          <option value="open" className="text-stone-900">open</option>
          <option value="eodPending" className="text-stone-900">EOD pending</option>
          <option value="eodDone" className="text-stone-900">EOD done</option>
        </select>
        <span className="ml-auto text-white/40">Branch {branch} · sample data only</span>
      </div>

      <div className="flex-1 min-h-0 relative">
        {screen === 'login' && <Login go={setScreen} branch={adminBranch} setBranch={setBranch} dayState={dayState} />}
        {screen === 'cashbegin' && <CashBegin go={setScreen} branch={adminBranch} terminal={terminal} setTerminal={setTerminal} setCashBegin={setCashBegin} />}
        {screen === 'pos' && <Pos go={setScreen} branch={adminBranch} terminal={terminal} online={online} setOnline={setOnline}
          queued={queued} setQueued={setQueued} orNo={orNo} setOrNo={setOrNo} settings={settings}
          lastSale={lastSale} setLastSale={setLastSale} />}
        {screen === 'blindclose' && <BlindClose go={setScreen} branch={adminBranch} terminal={terminal}
          queued={queued} online={online} setDayState={setDayState} />}
        {screen === 'eodonly' && <EodOnly go={setScreen} branch={adminBranch} terminal={terminal} setDayState={setDayState} />}
        {screen === 'admin' && <Admin go={setScreen} branch={branch} setBranch={setBranch} settings={settings} setSettings={setSettings} />}
      </div>
    </div>
  )
}

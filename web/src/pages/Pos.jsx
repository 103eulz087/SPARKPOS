import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  addLocalOrderItem, api, closeLocalOrder, db, findSaleByOr, getMeta, isOnline, loadLocalTables,
  nextORNumber, openLocalOrder, orRemaining, pendingCount, pendingOrderCount, printText,
  pullTables, setLocalOrderItemQty, syncPendingOrders, syncPendingSales, uuid, voidLocalOrder
} from '../lib/api'
import { buildBill, buildKitchenSlip, buildReceipt } from '../lib/receipt'
import { peso, round2, useAuth, useCart, useShift } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Modal, Note, Paper, Toast } from '../components/Ui'

export default function Pos() {
  const nav = useNavigate()
  const { fullName, role, branchCode, logout, userId } = useAuth()
  const { shiftUid, terminalId, terminalCode, businessDate } = useShift()
  const cart = useCart()
  const totals = cart.totals()

  const [products, setProducts] = useState([])
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState(null)
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [queued, setQueued] = useState(0)
  const [ctx, setCtx] = useState({ branch: {}, terminal: {}, settings: {} })
  const [lastSale, setLastSale] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const searchRef = useRef(null)

  /* ---------- dine-in (Restaurant PosType only) ----------
     Local-first, same trust model as sales: every table/order action lands in IndexedDB
     immediately and syncs in the background (see lib/api.js's openLocalOrder/
     addLocalOrderItem/etc. and syncPendingOrders) — works offline, assuming a single
     terminal serves this branch's tables at a time (see CLAUDE.md). dineInStage null =
     takeout / normal cart view (also always true for non-Restaurant branches). 'tables' =
     picking a table. 'ordering' = adding items to an open, unpaid tab. Generate Bill loads
     that tab's items into the *same* cart used by takeout and clears dineInStage back to
     null — checkoutOrderUid is what remembers a dine-in checkout is in progress so
     completeSale() can close the tab afterward. */
  const restaurantMode = ctx.settings.PosType === 'Restaurant'
  const [dineInStage, setDineInStage] = useState(null)
  const [tables, setTables] = useState([])
  const [activeOrder, setActiveOrder] = useState(null)
  const [checkoutOrderUid, setCheckoutOrderUid] = useState(null)

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2800) }
  const refreshQueue = () => Promise.all([pendingCount(), pendingOrderCount()])
    .then(([a, b]) => setQueued(a + b))

  /* ---------- boot ---------- */
  useEffect(() => {
    db.products.toArray().then(setProducts)
    refreshQueue()

    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    const id = setInterval(refreshQueue, 5000)

    // Receipt header context + discount types (cached in memory for the session)
    Promise.all([
      api('/api/branches').catch(() => []),
      api(`/api/terminals?branchCode=${branchCode}`).catch(() => []),
      api(`/api/settings/${branchCode}`).catch(() => ({})),
      api('/api/settings/discount-types').catch(() => null),
      api('/api/settings/discount-category-rates').catch(() => null)
    ]).then(([branches, terminals, settings, types, categoryRates]) => {
      setCtx({
        branch: branches.find(b => b.BranchCode === branchCode) || {},
        terminal: terminals.find(t => t.TerminalId === terminalId) || {},
        settings: settings || {}
      })
      if (types?.length) {
        cart.setDiscountTypes(types.map(t => ({
          code: t.DiscountCode, description: t.Description,
          rate: Number(t.Rate), vatExempt: !!t.IsVatExempt, law: t.LegalBasis
        })))
      }
      if (categoryRates?.length) {
        cart.setCategoryRates(categoryRates.map(r => ({
          discountCode: r.DiscountCode, categoryId: r.CategoryId,
          rate: Number(r.Rate), vatExempt: !!r.IsVatExempt
        })))
      }
    })

    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const categories = useMemo(() => {
    const m = new Map()
    products.forEach(p => m.set(p.categoryId, p.categoryName))
    return [...m.entries()]
  }, [products])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter(p =>
      (!categoryId || p.categoryId === categoryId) &&
      (!q || p.productName.toLowerCase().includes(q) || p.barcode.includes(q)))
  }, [products, search, categoryId])

  /** Scanners type the barcode then press Enter. Exact match punches instantly. */
  const onSearchKey = (e) => {
    if (e.key !== 'Enter') return
    const hit = products.find(p => p.barcode === search.trim())
    if (hit) { cart.addProduct(hit); setSearch('') }
    else if (visible.length === 1) { cart.addProduct(visible[0]); setSearch('') }
  }

  /* ---------- dine-in (local-first — see lib/api.js) ---------- */
  /** The table LIST (not order state) is small and admin-edited, so it's worth refreshing
   *  from the server every time the grid is opened rather than only at Cash Begin — otherwise
   *  a table added mid-shift wouldn't show up until the next Cash Begin pulls it into
   *  db.posTables. Falls back to whatever's cached if offline (openLocalOrder's cache is
   *  still the source of truth for occupied/item-count either way). */
  const loadTables = async () => {
    try {
      if (isOnline()) await pullTables(branchCode).catch(() => {})
      setTables(await loadLocalTables(branchCode))
    } catch (e) { setError(e.message) }
  }

  const goToTables = () => { setDineInStage('tables'); loadTables() }
  const goToTakeout = () => { setDineInStage(null); setActiveOrder(null) }

  const openTable = async (table) => {
    const result = await openLocalOrder({
      tableId: table.TableId, tableNumber: table.TableNumber, branchCode, terminalId, shiftUid, userId
    })
    setActiveOrder(result)
    setDineInStage('ordering')
  }

  const addItemToOrder = async (p) => {
    const result = await addLocalOrderItem(activeOrder.order.OpenOrderUid, p)
    setActiveOrder(result)
    syncPendingOrders().then(refreshQueue).catch(() => {})
  }

  const setOrderItemQty = async (lineNo, qty) => {
    const result = await setLocalOrderItemQty(activeOrder.order.OpenOrderUid, lineNo, qty)
    setActiveOrder(result)
    syncPendingOrders().then(refreshQueue).catch(() => {})
  }

  /** No payment was ever involved, so this needs no override — unlike voiding an
   *  actual completed sale. */
  const cancelActiveOrder = async () => {
    if (!confirm("Cancel this table's order? Nothing has been charged.")) return
    await voidLocalOrder(activeOrder.order.OpenOrderUid)
    syncPendingOrders().then(refreshQueue).catch(() => {})
    goToTables()
  }

  /** Prints only what's new since the last send to each item's mapped kitchen/beverage
   *  printer (server-side, via PrintService — never RawBT, which only bridges to this
   *  handheld's own paired printer), plus a consolidated slip on this terminal's own
   *  printer. Inherently online-only: a browser can't open a raw socket to a LAN printer,
   *  so unlike the rest of dine-in this can't be queued for later — offline, it just fails
   *  with a clear error and nothing here is marked sent, so it's safe to retry once back on. */
  const sendToKitchen = async () => {
    try {
      const result = await api(`/api/orders/${activeOrder.order.OpenOrderUid}/send-to-kitchen`, {
        method: 'POST',
        body: JSON.stringify({ tableNumber: activeOrder.order.TableNumber, items: activeOrder.items })
      })
      if (!result.sentItems.length) { flash('Nothing new to send'); return }
      const text = buildKitchenSlip(activeOrder.order.TableNumber, result.sentItems, ctx.terminal)
      printText(text, ctx.terminal.PrinterTarget)
      const summary = result.areas
        .map(a => `${a.area || 'Unassigned'}: ${a.printed ? 'sent' : (a.message || 'failed')}`).join(' · ')
      flash(summary || 'Sent to kitchen')
    } catch (e) {
      setError(`Could not send to kitchen — reconnect and try again (${e.message})`)
    }
  }

  /** Prints an unofficial pre-payment bill (not a BIR receipt — no OR#, no VAT breakdown),
   *  then loads the table's accumulated items into the same cart takeout uses and hands off
   *  to the existing Discount/Pay flow unchanged. checkoutOrderUid is what tells
   *  completeSale() to also close the tab and free the table once payment succeeds.
   *  Best-effort catches up anything not yet sent to the kitchen first, in case staff forgot
   *  to tap Send to Kitchen for the last round — never blocks billing if that fails.
   *  Restaurant PosType asks for diner/senior counts first (the pax split that determines
   *  how much of the bill a senior/PWD discount actually applies to) — see setModal('pax'). */
  const generateBill = () => {
    if (restaurantMode) { setModal({ t: 'pax' }); return }
    finishGenerateBill(null)
  }

  const finishGenerateBill = (pax) => {
    setModal(null)
    sendToKitchen().catch(() => {})
    const text = buildBill(activeOrder.order, activeOrder.items, { ...ctx, cashier: fullName })
    printText(text, ctx.terminal.PrinterTarget)
    flash('Bill sent to the printer')
    cart.loadFromOrder(activeOrder.items)
    cart.setPax(pax)   // after loadFromOrder, which resets pax to null
    setCheckoutOrderUid(activeOrder.order.OpenOrderUid)
    setDineInStage(null)
  }

  /* ---------- complete a sale ---------- */
  const completeSale = async (payments) => {
    try {
      const orNumber = await nextORNumber()
      const tendered = round2(payments.reduce((s, p) => s + p.amount, 0))
      const items = cart.lines.map(l => ({
        lineNo: l.lineNo, productId: l.productId, barcode: l.barcode, productName: l.productName,
        categoryId: l.categoryId, quantity: l.quantity, unitPrice: l.unitPrice,
        origUnitPrice: l.origUnitPrice, lineDiscount: cart.lineDiscount(l),
        lineTotal: round2(l.quantity * l.unitPrice),
        isVatable: l.isVatable, isDiscountable: l.isDiscountable
      }))

      const sale = {
        saleUid: uuid(),
        shiftUid, branchCode, terminalId, orNumber,
        businessDate, saleDateTime: new Date().toISOString(),
        grossAmount: totals.gross, discountAmount: totals.discount,
        vatExemptAmount: totals.vatExempt, vatableAmount: totals.vatable,
        vatAmount: totals.vat, zeroRatedAmount: totals.zeroRated, netAmount: totals.net,
        tenderedAmount: tendered, changeAmount: round2(tendered - totals.net),
        discountCode: cart.discount?.type || null,
        discountCtrlNo: cart.discount?.controlNo || null,
        discountName: cart.discount?.name || null,
        vatAdjustment: totals.vatAdj,
        dinerCount: cart.pax?.dinerCount ?? null,
        seniorCount: cart.pax?.seniorCount ?? null,
        status: 'Completed',
        items,
        payments: payments.map((p, i) => ({ ...p, seqNo: i + 1 })),
        syncStatus: 'pending'
      }

      await db.pendingSales.put(sale)        // 1. local first — survives anything
      cart.clear()
      setLastSale(sale)
      setModal(null)

      const text = buildReceipt(sale, { ...ctx, cashier: fullName })
      printText(text, ctx.terminal.PrinterTarget)   // 2. print

      // Dine-in checkout — close the tab and free the table. Local-first like the sale
      // itself: closeLocalOrder() is instant and offline-safe, and syncs in the background
      // below along with the sale. No need to wait on anything here — the server-side sync
      // logs an "unverified" close if this order's sync happens to land before the sale's.
      if (checkoutOrderUid) {
        const orderUid = checkoutOrderUid
        setCheckoutOrderUid(null)
        setActiveOrder(null)
        await closeLocalOrder(orderUid, sale.saleUid)
        goToTables()
      }

      syncPendingSales().then(refreshQueue)         // 3. sync in background
      syncPendingOrders().then(refreshQueue).catch(() => {})
      refreshQueue()

      flash(`OR# ${orNumber} — change ₱${peso(sale.changeAmount)}`)
      const left = await orRemaining()
      if (left < 25) flash(`Only ${left} OR numbers left — reconnect to reserve more`)
      searchRef.current?.focus()
    } catch (e) {
      setError(e.message)
    }
  }

  /** Default OR# for the Reprint modal — the last one actually issued on this terminal,
   *  read from the persistent local counter (survives a reload, unlike lastSale). */
  const openReprint = async () => {
    const next = Number(await getMeta('or_next')) || 0
    const fallback = next > 0 ? next - 1 : (lastSale?.orNumber || '')
    setModal({ t: 'reprint', defaultOrNumber: fallback })
  }

  const xread = async () => {
    try {
      const r = await api(`/api/shifts/${shiftUid}/xread`, { method: 'POST' })
      // A RawBT-configured terminal has no server-reachable printer — the API can
      // never print it, so the browser prints the text the response already carries.
      const target = ctx.terminal.PrinterTarget
      const printed = target?.startsWith('rawbt') ? await printText(r.receiptText, target) : r.printed
      flash(printed ? 'X-Read sent to the printer' : 'X-Read generated (printer unreachable)')
    } catch (e) { setError(e.message) }
  }

  /** Break sign-out — distinct from "Close shift": this only clears the signed-in user
   *  (useAuth), never the shift itself (useShift stays in localStorage). Signing back in
   *  on this same terminal resumes straight into POS via Login.jsx's `resumed()` check,
   *  instead of routing back through Cash Begin. */
  const signOutForBreak = () => {
    if (!confirm('Sign out for a break? Your shift stays open — sign back in to resume it.')) return
    logout()
    nav('/login')
  }

  /** Mid-checkout for a dine-in bill, "Cancel" should return to that table's order (still
   *  open server-side, nothing charged) rather than just discard into an empty cart. */
  const cartOnCancel = checkoutOrderUid ? () => {
    if (!confirm("Go back to editing this table's order? Nothing has been charged.")) return
    cart.clear()
    setCheckoutOrderUid(null)
    setDineInStage('ordering')
  } : undefined

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="bg-stone-900 text-white px-3 py-2 flex items-center gap-2 text-sm shrink-0">
        <span className="font-bold tracking-tight">SparkPOS</span>
        <span className="text-white/50 hidden sm:inline truncate">{branchCode}/{terminalCode} · {fullName}</span>
        <span className={`ml-auto shrink-0 text-xs px-2 py-1 rounded-full font-semibold tabnum ${online ? 'bg-emerald-700' : 'bg-red-700'}`}>
          {online ? 'ONLINE' : 'OFFLINE'}{queued > 0 ? ` · ${queued}` : ''}
        </span>

        {/* Secondary actions stay inline on wider screens; on a phone-width handheld they'd
            wrap the header onto 2-3 lines and eat the little vertical space available, so
            they collapse into a menu instead. */}
        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <button className="underline text-white/70" onClick={xread}>X-Read</button>
          <button className="underline text-white/70" onClick={openReprint}>Reprint</button>
          <button className="underline text-white/70" onClick={() => setModal({ t: 'void' })}>Void</button>
          {(role === 'Admin' || role === 'Supervisor') &&
            <button className="underline text-white/70" onClick={() => nav('/admin')}>Admin</button>}
          <button className="underline text-white/70" onClick={signOutForBreak}>Sign out</button>
        </div>
        <button className="sm:hidden shrink-0 text-white/70 px-1.5 py-2" aria-label="More actions"
          onClick={() => setMenuOpen(true)}>
          <svg width="4" height="18" viewBox="0 0 4 18" fill="currentColor">
            <circle cx="2" cy="2" r="2" /><circle cx="2" cy="9" r="2" /><circle cx="2" cy="16" r="2" />
          </svg>
        </button>

        <button className="shrink-0 bg-red-700 px-3 py-1.5 rounded-lg font-semibold" onClick={() => nav('/blind-close')}>
          Close shift
        </button>
      </header>

      {!online && (
        <div className="bg-amber-100 text-amber-900 px-4 py-1.5 text-sm shrink-0">
          Offline — sales are saved on this tablet and sync automatically when the network returns.
        </div>
      )}

      {restaurantMode && !checkoutOrderUid && (
        <div className="flex gap-2 px-2 sm:px-3 pt-2 shrink-0">
          <Btn variant={dineInStage === null ? 'moss' : 'ghost'} className="text-sm !min-h-[36px]"
            onClick={goToTakeout}>Takeout</Btn>
          <Btn variant={dineInStage !== null ? 'moss' : 'ghost'} className="text-sm !min-h-[36px]"
            onClick={() => { if (dineInStage === null) goToTables() }}>Dine-in</Btn>
        </div>
      )}

      {restaurantMode && dineInStage === 'tables' ? (
        <TableGrid tables={tables} onSelect={openTable} onRefresh={loadTables} />
      ) : restaurantMode && dineInStage === 'ordering' && activeOrder ? (
        <OrderingView
          activeOrder={activeOrder} search={search} setSearch={setSearch} searchRef={searchRef}
          onSearchKey={onSearchKey} categories={categories} categoryId={categoryId}
          setCategoryId={setCategoryId} visible={visible}
          onAddItem={addItemToOrder} onSetQty={setOrderItemQty}
          onSendToKitchen={sendToKitchen}
          onGenerateBill={generateBill} onBackToTables={goToTables} onCancelOrder={cancelActiveOrder}
        />
      ) : (
        <>
          <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
            {/* Products */}
            <div className="flex-1 flex flex-col p-2 sm:p-3 gap-2 sm:gap-3 min-w-0 min-h-0">
              <Input ref={searchRef} className="text-base sm:text-lg" autoFocus placeholder="Scan barcode or search…"
                value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKey} />
              <div className="flex gap-2 overflow-x-auto pb-1 shrink-0">
                <Btn variant={!categoryId ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[36px] sm:!min-h-[40px]"
                  onClick={() => setCategoryId(null)}>All</Btn>
                {categories.map(([id, name]) => (
                  <Btn key={id} variant={categoryId === id ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[36px] sm:!min-h-[40px]"
                    onClick={() => setCategoryId(id)}>{name}</Btn>
                ))}
              </div>
              <ProductGrid products={visible} onTap={p => cart.addProduct(p)} />
            </div>

            {/* Cart — always-visible sidebar on tablet/desktop */}
            <div className="hidden lg:flex lg:w-[380px] bg-white lg:border-l border-stone-200 flex-col min-h-0">
              <CartPanel cart={cart} totals={totals} setModal={setModal} flash={flash} onCancel={cartOnCancel} />
            </div>
          </div>

          {/* Cart — floating button + on-demand sheet on phone-width screens */}
          {!cartOpen && (
            <button className="lg:hidden fixed bottom-4 right-4 z-30 bg-stone-900 text-white rounded-full pl-4 pr-5 py-3 shadow-xl flex items-center gap-2 active:scale-95 transition-transform"
              onClick={() => setCartOpen(true)} aria-label="View current sale">
              <span className="relative shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                </svg>
                {cart.lines.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-red-700 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {cart.lines.length}
                  </span>
                )}
              </span>
              <span className="font-bold tabnum">₱{peso(totals.net)}</span>
            </button>
          )}
          {cartOpen && (
            <div className="lg:hidden fixed inset-0 z-40 flex flex-col justify-end" onClick={() => setCartOpen(false)}>
              <div className="absolute inset-0 bg-stone-900/60" />
              <div className="relative bg-white rounded-t-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-stone-100 shrink-0">
                  <h2 className="font-bold text-lg">Current sale</h2>
                  <button className="text-stone-400 p-2" onClick={() => setCartOpen(false)} aria-label="Close">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M2 2l12 12M14 2L2 14" />
                    </svg>
                  </button>
                </div>
                <CartPanel cart={cart} totals={totals} setModal={setModal} flash={flash}
                  closeSheet={() => setCartOpen(false)} onCancel={cartOnCancel} />
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 w-[min(500px,90vw)] z-50">
          <ErrorBar message={error} onDismiss={() => setError('')} />
        </div>
      )}
      <Toast message={toast} />

      {modal?.t === 'pay' && (
        <PayModal due={totals.net} onClose={() => setModal(null)} onDone={completeSale} />
      )}
      {modal?.t === 'pax' && (
        <PaxModal onClose={() => setModal(null)} onApply={finishGenerateBill} />
      )}
      {modal?.t === 'discount' && (
        <DiscountModal types={cart.discountTypes} current={cart.discount}
          onClose={() => setModal(null)}
          onApply={(d) => { cart.setDiscount(d); setModal(null) }} />
      )}
      {modal?.t === 'qty' && (
        <QtyModal line={modal.line} onClose={() => setModal(null)}
          onApply={(q) => { cart.setQty(modal.line.lineNo, q); setModal(null) }} />
      )}
      {modal?.t === 'price' && (
        <PriceModal line={modal.line} onClose={() => setModal(null)}
          onApply={(p) => { cart.setPrice(modal.line.lineNo, p); setModal(null) }} />
      )}
      {modal?.t === 'void' && (
        <VoidModal terminalId={terminalId} onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); flash(msg); refreshQueue() }} />
      )}
      {modal?.t === 'reprint' && (
        <ReprintModal terminalId={terminalId} defaultOrNumber={modal.defaultOrNumber}
          ctx={ctx} cashier={fullName} onClose={() => setModal(null)}
          onDone={({ text, ok, orNumber }) => {
            setModal({ t: 'paper', text })
            flash(ok ? `Reprinted OR# ${orNumber}` : 'Printer unreachable — check the print agent')
          }} />
      )}
      {modal?.t === 'paper' && (
        <Modal onClose={() => setModal(null)}>
          <Paper text={modal.text} />
          <Btn variant="dark" className="w-full" onClick={() => setModal(null)}>Close</Btn>
        </Modal>
      )}

      {menuOpen && (
        <Modal onClose={() => setMenuOpen(false)}>
          <div>
            <h2 className="font-bold text-lg">{branchCode}/{terminalCode}</h2>
            <p className="text-sm text-stone-500">{fullName}</p>
          </div>
          <div className="grid gap-2">
            <Btn onClick={() => { setMenuOpen(false); xread() }}>X-Read</Btn>
            <Btn onClick={() => { setMenuOpen(false); openReprint() }}>Reprint</Btn>
            <Btn onClick={() => { setMenuOpen(false); setModal({ t: 'void' }) }}>Void</Btn>
            {(role === 'Admin' || role === 'Supervisor') && (
              <Btn onClick={() => { setMenuOpen(false); nav('/admin') }}>Admin</Btn>
            )}
            <Btn onClick={() => { setMenuOpen(false); signOutForBreak() }}>Sign out</Btn>
          </div>
          <Btn variant="dark" className="w-full" onClick={() => setMenuOpen(false)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

/** Line items + totals + Discount/Cancel/PAY — shared by the tablet sidebar (always visible)
 *  and the phone-width bottom sheet (opened on demand from the floating cart button).
 *  closeSheet is a no-op on the sidebar; on the sheet it dismisses it before another modal
 *  opens on top, so only one overlay is ever showing at once. onCancel overrides the default
 *  "clear the cart" behavior — used mid dine-in checkout, where Cancel should return to that
 *  table's still-open order instead of discarding it. */
function CartPanel({ cart, totals, setModal, flash, closeSheet = () => {}, onCancel }) {
  const openModal = (m) => { closeSheet(); setModal(m) }
  const cancel = onCancel || (() => { if (confirm('Clear the whole sale?')) { cart.clear(); flash('Sale cancelled') } })

  return (
    <>
      <div className="flex-1 overflow-y-auto divide-y divide-stone-100">
        {!cart.lines.length && (
          <p className="text-stone-400 text-center py-12 px-6">Scan or tap a product to start the sale.</p>
        )}
        {cart.lines.map(l => {
          const ld = cart.lineDiscount(l)
          return (
            <div key={l.lineNo} className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate text-sm">{l.productName}</p>
                <p className="text-xs text-stone-500 tabnum">
                  @ ₱{peso(l.unitPrice)}
                  {l.allowPriceEdit && (
                    <button className="ml-2 underline" onClick={() => openModal({ t: 'price', line: l })}>edit</button>
                  )}
                  {!l.isDiscountable && <span className="ml-2 text-stone-400">non-discountable</span>}
                </p>
                {ld > 0 && (
                  <p className="text-xs text-emerald-700 tabnum">
                    less {cart.discount.type} −₱{peso(ld)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => cart.setQty(l.lineNo, l.quantity - 1)}>−</Btn>
                <button className="tabnum w-9 text-center font-bold text-sm underline decoration-dotted"
                  onClick={() => openModal({ t: 'qty', line: l })}>{l.quantity}</button>
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => cart.setQty(l.lineNo, l.quantity + 1)}>+</Btn>
              </div>
              <span className="tabnum w-16 text-right font-bold text-sm">{peso(l.quantity * l.unitPrice)}</span>
              <button className="text-red-700 text-lg px-1" onClick={() => cart.removeLine(l.lineNo)}>×</button>
            </div>
          )
        })}
      </div>

      <div className="bg-stone-900 text-white px-3 sm:px-4 py-2 sm:py-3 space-y-1 shrink-0">
        <div className="flex justify-between text-xs sm:text-sm text-white/60 tabnum">
          <span>Gross</span><span>{peso(totals.gross)}</span>
        </div>
        {totals.discount > 0 && (
          <div className="flex justify-between text-xs sm:text-sm text-amber-300 tabnum">
            <span>{cart.discount.type} discount</span><span>−{peso(totals.discount)}</span>
          </div>
        )}
        <div className="flex justify-between items-baseline">
          <span className="text-[9px] sm:text-[10px] tracking-[0.3em] uppercase text-white/50">Total due</span>
          <span className="tabnum text-2xl sm:text-4xl font-bold">₱{peso(totals.net)}</span>
        </div>
      </div>

      <div className="p-2 sm:p-3 grid grid-cols-3 gap-2 shrink-0">
        <Btn variant={cart.discount ? 'moss' : 'ghost'} className="text-xs sm:text-sm !min-h-[40px] sm:!min-h-[46px]"
          onClick={() => openModal({ t: 'discount' })}>
          {cart.discount ? cart.discount.type : 'Discount'}
        </Btn>
        <Btn className="text-xs sm:text-sm !min-h-[40px] sm:!min-h-[46px]" disabled={!cart.lines.length}
          onClick={cancel}>
          Cancel
        </Btn>
        <Btn variant="primary" className="text-base sm:text-lg !min-h-[40px] sm:!min-h-[46px]" disabled={!cart.lines.length}
          onClick={() => openModal({ t: 'pay' })}>PAY</Btn>
      </div>
    </>
  )
}

/** The tap-to-add product tile grid — shared by the takeout cart view and the dine-in
 *  ordering view, parameterized only by what tapping a product actually does. */
function ProductGrid({ products, onTap }) {
  return (
    <div className="flex-1 overflow-y-auto grid grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3 content-start pb-16 lg:pb-0">
      {products.map(p => (
        <button key={p.productId} onClick={() => onTap(p)}
          className="bg-white rounded-xl text-left shadow-sm active:scale-[0.97] transition-transform flex flex-col overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
          {/* padding-top: 100% forces a true square from the container's own width —
              unlike the CSS aspect-ratio property, this works even on older WebView/Chrome
              builds some rugged Android POS terminals ship with. */}
          <div className="relative w-full shrink-0" style={{ paddingTop: '100%' }}>
            {p.imageUrl ? (
              <img src={p.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 bg-stone-100 flex items-center justify-center text-stone-300 text-xl sm:text-2xl font-bold">
                {p.productName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-[44px] sm:min-h-[54px] p-1.5 sm:p-3 flex flex-col justify-between">
            <span className="font-semibold leading-tight text-[11px] sm:text-sm">{p.productName}</span>
            <span className="flex items-baseline justify-between gap-1 mt-1">
              <span className="tabnum text-sm sm:text-lg text-emerald-800 font-bold">₱{peso(p.price)}</span>
              {!p.isDiscountable && (
                <span className="hidden sm:inline text-[9px] uppercase tracking-wide text-stone-400 border border-stone-300 rounded px-1">
                  no disc
                </span>
              )}
            </span>
          </div>
        </button>
      ))}
      {!products.length && (
        <p className="col-span-full text-stone-400 text-center py-10">
          No products match. If the catalog is empty, reopen the shift while online.
        </p>
      )}
    </div>
  )
}

/* ================= Dine-in: table picker ================= */
function TableGrid({ tables, onSelect, onRefresh }) {
  useEffect(() => { onRefresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {tables.map(t => {
          const occupied = !!t.OpenOrderUid
          return (
            <button key={t.TableId} onClick={() => onSelect(t)}
              className={`rounded-xl p-4 text-center shadow-sm active:scale-[0.97] transition-transform border-2 ${
                occupied ? 'bg-amber-50 border-amber-400' : 'bg-white border-emerald-300'}`}>
              <div className="text-lg font-bold">{t.TableNumber}</div>
              <div className={`text-xs mt-1 font-semibold ${occupied ? 'text-amber-700' : 'text-emerald-700'}`}>
                {occupied ? `Occupied · ${t.ItemCount} item${t.ItemCount === 1 ? '' : 's'}` : 'Available'}
              </div>
            </button>
          )
        })}
      </div>
      {!tables.length && (
        <p className="text-stone-400 text-center py-10">
          No tables set up yet. Add tables in Admin → Tables.
        </p>
      )}
    </div>
  )
}

/* ================= Dine-in: ordering a table ================= */
/** Same product grid as takeout, but tapping a product adds it to the local-first open
 *  order (see lib/api.js) instead of the local cart, since a table's order can be added to
 *  over several rounds before Generate Bill. Send to Kitchen (unlike everything else here)
 *  is online-only — printing to a kitchen/beverage printer is a live server call. */
function OrderingView({
  activeOrder, search, setSearch, searchRef, onSearchKey, categories, categoryId, setCategoryId,
  visible, onAddItem, onSetQty, onSendToKitchen, onGenerateBill, onBackToTables, onCancelOrder
}) {
  const items = activeOrder.items || []
  const total = items.reduce((s, i) => s + Number(i.Quantity) * Number(i.UnitPrice), 0)

  return (
    <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
      <div className="flex-1 flex flex-col p-2 sm:p-3 gap-2 sm:gap-3 min-w-0 min-h-0">
        <div className="flex items-center gap-2 shrink-0">
          <Btn className="!min-h-[36px] text-sm flex items-center gap-1.5" onClick={onBackToTables}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Tables
          </Btn>
          <span className="font-bold text-lg">Table {activeOrder.order.TableNumber}</span>
        </div>
        <Input ref={searchRef} className="text-base sm:text-lg" autoFocus placeholder="Scan barcode or search…"
          value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKey} />
        <div className="flex gap-2 overflow-x-auto pb-1 shrink-0">
          <Btn variant={!categoryId ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[36px] sm:!min-h-[40px]"
            onClick={() => setCategoryId(null)}>All</Btn>
          {categories.map(([id, name]) => (
            <Btn key={id} variant={categoryId === id ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[36px] sm:!min-h-[40px]"
              onClick={() => setCategoryId(id)}>{name}</Btn>
          ))}
        </div>
        <ProductGrid products={visible} onTap={onAddItem} />
      </div>

      <div className="w-full lg:w-[380px] bg-white border-t-2 lg:border-t-0 lg:border-l border-stone-200 flex flex-col min-h-0">
        <div className="px-3 pt-2 pb-1 shrink-0">
          <span className="text-[10px] tracking-[0.3em] uppercase text-stone-400 font-semibold">This order</span>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-stone-100">
          {!items.length && (
            <p className="text-stone-400 text-center py-12 px-6">Tap a product to add it to this table's order.</p>
          )}
          {items.map(l => (
            <div key={l.LineNo} className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate text-sm">{l.ProductName}</p>
                <p className="text-xs text-stone-500 tabnum">@ ₱{peso(l.UnitPrice)}</p>
              </div>
              <div className="flex items-center gap-1">
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => onSetQty(l.LineNo, Number(l.Quantity) - 1)}>−</Btn>
                <span className="tabnum w-9 text-center font-bold text-sm">{l.Quantity}</span>
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => onSetQty(l.LineNo, Number(l.Quantity) + 1)}>+</Btn>
              </div>
              <span className="tabnum w-16 text-right font-bold text-sm">{peso(l.Quantity * l.UnitPrice)}</span>
              <button className="text-red-700 text-lg px-1" onClick={() => onSetQty(l.LineNo, 0)}>×</button>
            </div>
          ))}
        </div>

        <div className="bg-stone-900 text-white px-3 sm:px-4 py-2 sm:py-3 shrink-0">
          <div className="flex justify-between items-baseline">
            <span className="text-[9px] sm:text-[10px] tracking-[0.3em] uppercase text-white/50">Running total</span>
            <span className="tabnum text-2xl sm:text-4xl font-bold">₱{peso(total)}</span>
          </div>
        </div>

        <div className="p-2 sm:p-3 space-y-2 shrink-0">
          <Btn variant="moss" className="w-full text-sm !min-h-[40px] sm:!min-h-[46px]" disabled={!items.length}
            onClick={onSendToKitchen}>Send to Kitchen</Btn>
          <div className="grid grid-cols-2 gap-2">
            <Btn className="text-sm !min-h-[40px] sm:!min-h-[46px]" onClick={onCancelOrder}>Cancel order</Btn>
            <Btn variant="primary" className="text-sm !min-h-[40px] sm:!min-h-[46px]" disabled={!items.length}
              onClick={onGenerateBill}>Generate Bill</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================= Split payment ================= */
function PayModal({ due, onClose, onDone }) {
  const [payments, setPayments] = useState([])
  const [cash, setCash] = useState('')
  const [card, setCard] = useState(null)

  const paid = round2(payments.reduce((s, p) => s + p.amount, 0))
  const balance = round2(due - paid)
  const change = round2(paid - due)

  const quick = [...new Set([balance, Math.ceil(balance / 100) * 100,
    Math.ceil(balance / 500) * 500, Math.ceil(balance / 1000) * 1000])].filter(v => v > 0)

  const addCash = () => {
    const v = Number(cash) || 0
    if (v <= 0) return
    setPayments(ps => [...ps, { paymentType: 'CASH', amount: round2(v) }])
    setCash('')
  }

  const addCard = () => {
    const amt = Number(card.amount) || 0
    if (amt <= 0 || amt > balance) return
    setPayments(ps => [...ps, {
      paymentType: 'CARD', amount: round2(amt),
      cardNo: card.cardNo, cardBank: card.cardBank, cardRefNo: card.cardRefNo, cardName: card.cardName
    }])
    setCard(null)
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex justify-between items-baseline">
        <h2 className="text-lg font-bold">Payment</h2>
        <span className="tabnum text-2xl font-bold">₱{peso(due)}</span>
      </div>

      {payments.length > 0 && (
        <div className="border border-stone-200 rounded-lg divide-y divide-stone-100">
          {payments.map((p, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-2 text-sm">
              <span className="font-semibold w-14">{p.paymentType}</span>
              <span className="flex-1 text-stone-500 truncate">
                {p.paymentType === 'CARD'
                  ? `${p.cardBank} ****${(p.cardNo || '').slice(-4)} · ${p.cardName} · Ref ${p.cardRefNo}`
                  : 'Cash tendered'}
              </span>
              <span className="tabnum font-bold">{peso(p.amount)}</span>
              <button className="text-red-700" onClick={() => setPayments(ps => ps.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className={`flex justify-between items-baseline px-3 py-2 rounded-lg ${balance > 0 ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900'}`}>
        <span className="text-sm font-semibold">{balance > 0 ? 'Balance remaining' : 'Change'}</span>
        <span className="tabnum text-xl font-bold">₱{peso(balance > 0 ? balance : change)}</span>
      </div>

      {!card ? (
        <>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="sm:flex-1">
              <Field label="Cash amount">
                <Input className="text-right tabnum text-xl" inputMode="decimal" placeholder="0.00"
                  value={cash} onChange={e => setCash(e.target.value.replace(/[^0-9.]/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && addCash()} />
              </Field>
            </div>
            <div className="grid grid-cols-2 sm:flex gap-2">
              <Btn variant="dark" onClick={addCash}>Add cash</Btn>
              <Btn disabled={balance <= 0}
                onClick={() => setCard({ cardNo: '', cardBank: '', cardRefNo: '', cardName: '', amount: String(balance) })}>
                Add card
              </Btn>
            </div>
          </div>
          {quick.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {quick.map(q => (
                <Btn key={q} className="tabnum text-sm" onClick={() => setCash(String(q))}>₱{peso(q)}</Btn>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="border border-stone-200 rounded-lg p-3 space-y-3">
          <h3 className="font-semibold text-sm">Credit / debit card</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Card No."><Input inputMode="numeric" value={card.cardNo}
              onChange={e => setCard({ ...card, cardNo: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Card Bank"><Input value={card.cardBank}
              onChange={e => setCard({ ...card, cardBank: e.target.value })} /></Field>
            <Field label="Reference No."><Input value={card.cardRefNo}
              onChange={e => setCard({ ...card, cardRefNo: e.target.value })} /></Field>
            <Field label="Card Name"><Input value={card.cardName}
              onChange={e => setCard({ ...card, cardName: e.target.value })} /></Field>
            <Field label="Amount"><Input className="text-right tabnum" inputMode="decimal" value={card.amount}
              onChange={e => setCard({ ...card, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
          </div>
          <p className="text-xs text-stone-400">Only the last 4 digits are stored. No change is given on a card tender.</p>
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setCard(null)}>Cancel</Btn>
            <Btn variant="dark"
              disabled={!card.cardNo || !card.cardBank || !card.cardRefNo || !card.cardName ||
                !Number(card.amount) || Number(card.amount) > balance}
              onClick={addCard}>Add card payment</Btn>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={balance > 0 || !payments.length} onClick={() => onDone(payments)}>
          Complete sale
        </Btn>
      </div>
    </Modal>
  )
}

/* ================= Discount ================= */
function DiscountModal({ types, current, onClose, onApply }) {
  const [type, setType] = useState(current?.type || null)
  const [controlNo, setControlNo] = useState(current?.controlNo || '')
  const [name, setName] = useState(current?.name || '')

  return (
    <Modal onClose={onClose} wide>
      <h2 className="text-lg font-bold">Discount type</h2>
      <p className="text-sm text-stone-500">
        Applied per item — only products flagged discountable are reduced. Everything else stays at
        full price and remains VATable.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {types.map(t => (
          <button key={t.code} onClick={() => setType(t.code)}
            className={`rounded-lg p-3 text-left border ${type === t.code ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white border-stone-300'}`}>
            <div className="font-bold text-sm">{t.code}</div>
            <div className={`text-xs ${type === t.code ? 'text-white/70' : 'text-stone-500'}`}>{t.description}</div>
            <div className={`text-xs mt-1 ${type === t.code ? 'text-white/70' : 'text-stone-400'}`}>
              {Math.round(t.rate * 100)}% · {t.vatExempt ? 'VAT-exempt' : 'VAT applies'} · {t.law}
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
          <Field label="Control No."><Input value={controlNo} placeholder="ID / booklet number"
            onChange={e => setControlNo(e.target.value)} /></Field>
          <Field label="Name"><Input value={name} placeholder="Full name on the ID"
            onChange={e => setName(e.target.value)} /></Field>
        </div>
      )}
      {type && <Note tone="stone">Both fields print on the receipt and feed the BIR discount report.</Note>}
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={type && (!controlNo || !name)}
          onClick={() => onApply(type ? { type, controlNo, name } : null)}>Apply</Btn>
      </div>
    </Modal>
  )
}

/* ================= Diner / senior count (Restaurant, before Generate Bill) ================= */
/** Captures how much of the bill a senior/PWD discount should actually apply to — RA 9994's
 *  per-pax split: only the senior's share of a shared item gets discounted, not the whole
 *  bill. Skipping (0 diners) is fine — computeTotals treats a missing/zero split as "no
 *  split," same as takeout. */
function PaxModal({ onClose, onApply }) {
  const [diners, setDiners] = useState('')
  const [seniors, setSeniors] = useState('')

  const dinerCount = Number(diners) || 0
  const seniorCount = Math.min(Number(seniors) || 0, dinerCount)
  const valid = dinerCount > 0

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Diners at this table</h2>
      <p className="text-sm text-stone-500">
        If any of them are Senior Citizens/PWD, only their share of the bill gets discounted —
        not the whole table.
      </p>
      <Field label="Number of diners"><Input inputMode="numeric" autoFocus value={diners}
        onChange={e => setDiners(e.target.value.replace(/\D/g, ''))} /></Field>
      <Field label="Of those, how many are Senior Citizen / PWD">
        <Input inputMode="numeric" value={seniors}
          onChange={e => setSeniors(e.target.value.replace(/\D/g, ''))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => onApply(null)}>Skip</Btn>
        <Btn variant="primary" disabled={!valid} onClick={() => onApply({ dinerCount, seniorCount })}>
          Continue
        </Btn>
      </div>
    </Modal>
  )
}

/* ================= Quantity (weighed goods) ================= */
function QtyModal({ line, onClose, onApply }) {
  const [q, setQ] = useState(String(line.quantity))
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Quantity — {line.productName}</h2>
      <p className="text-sm text-stone-500">Decimals are allowed for weighed items (e.g. 1.35 kg).</p>
      <Input className="text-right tabnum text-3xl" inputMode="decimal" autoFocus value={q}
        onChange={e => setQ(e.target.value.replace(/[^0-9.]/g, ''))}
        onKeyDown={e => e.key === 'Enter' && onApply(Number(q) || line.quantity)} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" onClick={() => onApply(Number(q) || line.quantity)}>Apply</Btn>
      </div>
    </Modal>
  )
}

/* ================= Price edit ================= */
function PriceModal({ line, onClose, onApply }) {
  const [p, setP] = useState(String(line.unitPrice))
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Edit price — {line.productName}</h2>
      <p className="text-sm text-stone-500">
        The original price ₱{peso(line.origUnitPrice)} is kept for the audit log and the line is
        marked with * on the receipt.
      </p>
      <Input className="text-right tabnum text-3xl" inputMode="decimal" autoFocus value={p}
        onChange={e => setP(e.target.value.replace(/[^0-9.]/g, ''))} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" onClick={() => onApply(Number(p) || line.unitPrice)}>Apply</Btn>
      </div>
    </Modal>
  )
}

/* ================= Void ================= */
/** Two steps: find the sale by OR# (any sale on this terminal, not just the last one),
 *  then confirm reason + override. No default OR# on purpose — voiding is destructive,
 *  so it should never be one accidental Enter-key-press away from voiding whatever was
 *  last sold. */
function VoidModal({ terminalId, onClose, onDone }) {
  const { role, branchCode } = useAuth()
  const [orNumber, setOrNumber] = useState('')
  const [sale, setSale] = useState(null)
  const [finding, setFinding] = useState(false)
  const [reason, setReason] = useState('')
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [needsOverride, setNeedsOverride] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api(`/api/settings/${branchCode}`)
      .then(s => setNeedsOverride(!!s.VoidOverride && role === 'Cashier'))
      .catch(() => setNeedsOverride(role === 'Cashier'))
  }, [branchCode, role])

  const find = async () => {
    if (!orNumber) return
    setFinding(true); setError('')
    try {
      const found = await findSaleByOr(terminalId, orNumber)
      if (found.status === 'Voided') throw new Error(`OR# ${orNumber} is already voided.`)
      setSale(found)
    } catch (e) {
      setError(e.message || `No sale found with OR# ${orNumber} on this terminal.`)
    } finally { setFinding(false) }
  }

  const submit = async () => {
    setBusy(true); setError('')
    try {
      await syncPendingSales()   // the sale must exist server-side before it can be voided
      await api('/api/sales/void', {
        method: 'POST',
        body: JSON.stringify({
          saleUid: sale.saleUid, reason,
          overrideUsername: needsOverride ? u : null,
          overridePassword: needsOverride ? p : null
        })
      })
      onDone(`OR# ${sale.orNumber} voided`)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (!sale) return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Void a sale</h2>
      <p className="text-sm text-stone-500">Enter the OR number of the sale to void.</p>
      <Field label="OR Number">
        <Input inputMode="numeric" autoFocus value={orNumber}
          onChange={e => setOrNumber(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && find()} />
      </Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={finding || !orNumber} onClick={find}>
          {finding ? 'Finding…' : 'Find'}
        </Btn>
      </div>
    </Modal>
  )

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Void OR# {sale.orNumber}</h2>
      <p className="text-sm text-stone-500">₱{peso(sale.netAmount)}</p>
      {needsOverride
        ? <Note tone="amber" title="Supervisor override required">
            This branch requires an override for voids. Change it in Admin → POS Settings.
          </Note>
        : <Note tone="green" title="Override not required">
            Voids are still recorded in the audit log with your name and reason.
          </Note>}
      {needsOverride && (
        <>
          <Field label="Supervisor username"><Input value={u} onChange={e => setU(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" value={p} onChange={e => setP(e.target.value)} /></Field>
        </>
      )}
      <Field label="Reason"><Input value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => { setSale(null); setError('') }}>Back</Btn>
        <Btn variant="primary" disabled={busy || !reason || (needsOverride && (!u || !p))} onClick={submit}>
          {busy ? 'Voiding…' : 'Void sale'}
        </Btn>
      </div>
    </Modal>
  )
}

/* ================= Reprint ================= */
/** Pre-filled with the last OR number issued on this terminal (defaultOrNumber, computed
 *  by the caller from the persistent local counter) — one tap reprints the last receipt,
 *  same as before, but the field is editable to reprint any earlier one too. */
function ReprintModal({ terminalId, defaultOrNumber, ctx, cashier, onClose, onDone }) {
  const [orNumber, setOrNumber] = useState(defaultOrNumber ? String(defaultOrNumber) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!orNumber) return
    setBusy(true); setError('')
    try {
      const sale = await findSaleByOr(terminalId, orNumber)
      const text = buildReceipt(sale, { ...ctx, cashier }, { reprint: true })
      const ok = await printText(text, ctx.terminal.PrinterTarget)
      onDone({ text, ok, orNumber: sale.orNumber })
    } catch (e) {
      setError(e.message || `No sale found with OR# ${orNumber} on this terminal.`)
    } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Reprint a receipt</h2>
      <p className="text-sm text-stone-500">Defaults to the last OR number issued on this terminal.</p>
      <Field label="OR Number">
        <Input inputMode="numeric" autoFocus value={orNumber}
          onChange={e => setOrNumber(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && submit()} />
      </Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !orNumber} onClick={submit}>
          {busy ? 'Printing…' : 'Reprint'}
        </Btn>
      </div>
    </Modal>
  )
}

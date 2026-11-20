import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  addLocalOrderItem, allocateOrRange, api, closeLocalOrder, db, findReturnByNo, findSaleByOr, flushDrawerLog, getHeld, getMeta, logDrawerOpen, openDrawer, putHeld, setMeta,
  isOnline, loadLocalTables, loadPromos, refreshPromos, nextORNumber, openLocalOrder, orRemaining, pendingCount, pendingOrderCount,
  printText, pullTables, setLocalOrderItemQty, syncPendingOrders, syncPendingSales, uuid, voidLocalOrder
} from '../lib/api'
import {
  buildBill, buildKitchenSlip, buildNoSale, buildReceipt, buildReturnReceipt, discountCopies, hasDiscountCopies, reprintText, returnNo, siNo
} from '../lib/receipt'
import { rememberCredential, verifyOffline } from '../lib/offlineAuth'
import { parseScaleBarcode } from '../lib/scale'
import { OTHER_DISCOUNT, peso, round2, scheduledLevel, useAuth, useCart, useShift } from '../lib/store'
import { Btn, Cube, ErrorBar, Field, Input, Modal, Note, Paper, ProductThumb, StatusPill, Toast, Wordmark } from '../components/Ui'

export default function Pos() {
  const nav = useNavigate()
  const { fullName, role, branchCode, logout, userId, token } = useAuth()
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
  const findRef = useRef(null)
  // the grocery lane needs a PC-size screen; the handheld (and a narrow window) keeps Touch
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 1024px)').matches ?? true)
  useEffect(() => {
    const m = window.matchMedia?.('(min-width: 1024px)')
    if (!m) return
    const f = () => setWide(m.matches)
    m.addEventListener ? m.addEventListener('change', f) : m.addListener(f)
    return () => { m.removeEventListener ? m.removeEventListener('change', f) : m.removeListener(f) }
  }, [])

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
  // The terminal's own POS type (Admin → Terminals) wins; blank follows the branch's POS settings
  const restaurantMode = (ctx.terminal.PosType || ctx.settings.PosType) === 'Restaurant'
  const returnsEnabled = ctx.settings.RefundEnabled !== false
  const [dineInStage, setDineInStage] = useState(null)
  const [tables, setTables] = useState([])
  const [activeOrder, setActiveOrder] = useState(null)
  const [checkoutOrderUid, setCheckoutOrderUid] = useState(null)
  // 37: this terminal's screen (Admin → Terminals); dine-in tables keep their own screens
  const groceryMode = ctx.terminal.ScreenLayout === 'Grocery' && wide && !(restaurantMode && dineInStage !== null)
  // the scanner types into the scan box, so it gets the focus back whenever a dialog closes
  useEffect(() => { if (groceryMode && !modal && !menuOpen) searchRef.current?.focus() }, [groceryMode, modal, menuOpen])

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2800) }
  const refreshQueue = () => Promise.all([pendingCount(), pendingOrderCount()])
    .then(([a, b]) => setQueued(a + b))

  /* ---------- promos: picked up while the shift is open ----------
   * Cash Begin downloads them; this checks again on opening the POS, every 5 minutes, when the
   * connection returns and after each sale. A new list is applied only to an empty cart, so a
   * price never changes in the middle of a sale (the next sale takes it). */
  const latestPromos = useRef(null)
  const syncPromos = useCallback(() => {
    refreshPromos(branchCode).then(p => { if (p) latestPromos.current = p }).catch(() => {})
      .finally(() => {
        if (latestPromos.current && useCart.getState().lines.length === 0) {
          cart.setPromos(latestPromos.current); latestPromos.current = null
        }
      })
  }, [branchCode])
  useEffect(() => {
    syncPromos()
    const id = setInterval(syncPromos, 5 * 60 * 1000)
    window.addEventListener('online', syncPromos)
    return () => { clearInterval(id); window.removeEventListener('online', syncPromos) }
  }, [syncPromos])

  /* ---------- boot ---------- */
  useEffect(() => {
    db.products.toArray().then(setProducts)
    loadPromos().then(cart.setPromos).catch(() => {})
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
      api('/api/settings/discount-category-rates').catch(() => null),
      api('/api/loyalty/settings').catch(() => null),
      api('/api/settings/price-levels').catch(() => null),
      api('/api/settings/discount-pos-type-rates').catch(() => null),
      api(`/api/approvals/terminal/${terminalId}`).catch(() => null),
      api(`/api/price-schedules/terminal/${terminalId}`).catch(() => null)   // 40
    ]).then(async ([branches, terminals, settings, types, categoryRates, loyalty, levels, posTypeRates, approvals, schedules]) => {
      const live = {
        branch: branches.find(b => b.BranchCode === branchCode) || {},
        terminal: terminals.find(t => t.TerminalId === terminalId) || {},
        settings: settings || {},
        // suki cards: { enabled, amountPerPoint, programName }; cached with the rest for offline
        loyalty: loyalty ? { enabled: !!loyalty.IsEnabled, amountPerPoint: Number(loyalty.AmountPerPoint),
          programName: loyalty.ProgramName } : null,
        // Price1..4 switched on in Admin: [{ level, name }]; cached with the rest for offline
        priceLevels: (levels || []).filter(l => l.IsActive).map(l => ({ level: Number(l.PriceLevel), name: l.LevelName })),
        // all four, switched on or not: Edit price shows each with the item's price as a reference
        allPriceLevels: levels?.length ? levels.map(l => ({ level: Number(l.PriceLevel), name: l.LevelName })) : null
      }
      // The receipt's BIR header (TIN, MIN, permit…) must print offline too: keep the last one
      // that loaded for this terminal and fall back to it when the server can't be reached.
      const cacheKey = `ctx_${terminalId}`
      const prev = await getMeta(cacheKey).catch(() => null)
      // The discount rates go in the same cache, so an offline restart still gives the 5% / 20%
      // it gave online (a list that failed to load keeps the last one that did).
      live.discounts = {
        types: types?.length ? types.map(t => ({
          code: t.DiscountCode, description: t.Description,
          rate: Number(t.Rate), vatExempt: !!t.IsVatExempt, law: t.LegalBasis
        })) : prev?.discounts?.types || null,
        categoryRates: categoryRates ? categoryRates.map(r => ({
          discountCode: r.DiscountCode, categoryId: r.CategoryId,
          rate: Number(r.Rate), vatExempt: !!r.IsVatExempt
        })) : prev?.discounts?.categoryRates || [],
        // 32: the rate per POS type (and per POS type + category)
        posTypeRates: posTypeRates ? posTypeRates.map(r => ({
          discountCode: r.DiscountCode, posType: r.PosType, categoryId: r.CategoryId ?? null,
          rate: Number(r.Rate), vatExempt: !!r.IsVatExempt
        })) : prev?.discounts?.posTypeRates || []
      }
      // 35: which actions need a supervisor here (the branch's switch, or this terminal's own);
      // an older server has no list, so Void / Return / Reprint follow the branch's columns
      live.approvals = approvals
        ? Object.fromEntries(approvals.map(a => [a.func, !!a.required]))
        : prev?.approvals || (settings?.BranchCode ? {
            CANCEL_LINE: !!settings.CancelLineOverride, VOID: !!settings.VoidOverride, RETURN: settings.ReturnOverride !== false,
            XREAD: !!settings.XReadOverride, REPRINT: !!settings.ReprintOverride, DISCOUNT: !!settings.DiscountOverride,
            PRICE_LEVEL: !!settings.PriceLevelOverride, OPEN_DRAWER: !!settings.OpenDrawerOverride } : null)
      // 40: the price level by time of day this till follows (kept for offline)
      live.priceSchedules = schedules || prev?.priceSchedules || []
      if (live.terminal.TerminalId) await setMeta(cacheKey, live).catch(() => {})
      else Object.assign(live, prev || {})
      setCtx(live)
      const d = live.discounts || {}
      if (d.types?.length) cart.setDiscountTypes(d.types)
      cart.setCategoryRates(d.categoryRates || [])
      cart.setPosTypeRates(d.posTypeRates || [])
      cart.setPosType(live.terminal?.PosType || live.settings?.PosType || 'Retail')
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
      (!q || p.productName.toLowerCase().includes(q) || p.barcode.includes(q) || (p.erpProductCode || '').includes(q)))
  }, [products, search, categoryId])

  /** Scanners type the barcode then press Enter. A product's real barcode (from the ERP's
   *  Products.Barcode, else the product code) punches instantly, and always wins over the
   *  scale-sticker format. Typing the ERP product code also works, for a package whose barcode
   *  won't scan. A weighing-scale sticker (lib/scale.js, set up per branch in POS settings)
   *  adds its product at its weight. */
  const onSearchKey = (e) => {
    if (e.key !== 'Enter') return
    const typed = search.trim()
    const exact = products.find(p => p.barcode === typed) || products.find(p => p.erpProductCode === typed)
    if (exact) { cart.addProduct(exact); setSearch(''); return }
    const scale = parseScaleBarcode(search, ctx.settings)
    if (scale) {
      const p = products.find(x => x.erpProductCode === scale.code || x.barcode === scale.code)
      if (p) { cart.addProduct(p, scale.quantity); setSearch(''); flash(`${p.productName} — ${scale.quantity}`) }
      else setError(`Scale sticker: product ${scale.code} isn't on this till (not priced for this branch, or not in the catalog).`)
      return
    }
    if (visible.length === 1) { cart.addProduct(visible[0]); setSearch('') }
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
    cart.loadFromOrder(activeOrder.items, Object.fromEntries(products.map(p => [p.productId, p])))
    cart.setPax(pax)   // after loadFromOrder, which resets pax to null
    const sched = scheduledLevel(ctx.priceSchedules)   // 40: the bill at the scheduled price level
    if (sched) cart.setPriceLevel(sched, null, 'schedule')
    setCheckoutOrderUid(activeOrder.order.OpenOrderUid)
    setDineInStage(null)
  }

  /* ---------- complete a sale ---------- */
  /** 35: does this action need a supervisor here? Never for a Supervisor / Admin signed in.
   *  Void and Return default to yes until the till knows (as before). */
  const levelName = (level) => ctx.priceLevels?.find(x => x.level === level)?.name
    || ctx.allPriceLevels?.find(x => x.level === level)?.name || `Price ${level}`   // a scheduled level may be switched off for picking

  const needs = (func) => role === 'Cashier' && !!(ctx.approvals?.[func] ?? (func === 'VOID' || func === 'RETURN'))

  /** Taking a line off the cart: with the Cancel line approval on, a supervisor OKs it and the
   *  line is kept for the audit (sent with the sale). */
  const removeLine = (l) => {
    if (needs('CANCEL_LINE')) {
      setModal({ t: 'approve', title: `Remove ${l.productName}`,
        message: 'Taking an item off the sale needs a supervisor at this till.',
        verify: async (u, pw) => { cart.removeLine(l.lineNo, await approveSupervisor(u, pw, branchCode)); setModal(null) } })
      return
    }
    cart.removeLine(l.lineNo, ctx.approvals?.CANCEL_LINE ? userId : null)
  }

  /* ---------- Price level by time of day (40) ----------
   * The till's schedules (its own, else its branch's, else every branch's) say which level is in
   * effect now, by this device's clock. It's applied only between sales: a sale already being rung
   * up keeps its prices, and a level the cashier picked stays for that sale. */
  const [schedLevel, setSchedLevel] = useState(null)
  useEffect(() => {
    const tick = () => setSchedLevel(scheduledLevel(ctx.priceSchedules))
    tick()
    const id = setInterval(tick, 30 * 1000)
    return () => clearInterval(id)
  }, [ctx.priceSchedules])
  const prevSched = useRef(undefined)
  useEffect(() => {
    if (prevSched.current !== undefined && prevSched.current !== schedLevel)
      flash(schedLevel ? `From the next sale: ${levelName(schedLevel)} (scheduled)` : 'From the next sale: the regular price')
    prevSched.current = schedLevel
  }, [schedLevel])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cart.lines.length || cart.priceLevelBy === 'cashier') return
    if ((cart.priceLevel || null) !== schedLevel) cart.setPriceLevel(schedLevel, null, schedLevel ? 'schedule' : null)
  }, [schedLevel, cart.lines.length, cart.priceLevelBy, cart.priceLevel])   // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- Hold / Recall ----------
   * A customer short of cash goes out for more: the sale is parked on this till (getHeld/putHeld
   * in api.js) instead of cancelled, the next customer is served, and Recall brings it back as it
   * was (discount, customer, suki card, approvals). Not for a dine-in tab, which has its table. */
  const [held, setHeld] = useState([])
  useEffect(() => { if (terminalId) getHeld(terminalId).then(setHeld).catch(() => {}) }, [terminalId])
  const canHold = cart.lines.length > 0 && !checkoutOrderUid && !(restaurantMode && dineInStage !== null)

  const holdSale = async (note) => {
    if (!canHold) return
    const entry = { holdId: uuid(), heldAt: new Date().toISOString(), note: note.trim().slice(0, 60) || null,
      heldBy: fullName, lineCount: cart.lines.length, net: totals.net, sale: cart.snapshot() }
    try {
      const list = [...await getHeld(terminalId), entry]
      await putHeld(terminalId, list)
      setHeld(list)
      cart.clear()
      setModal(null)
      flash(`Sale on hold, ₱${peso(entry.net)}. Recall it when the customer is back.`)
    } catch (e) { setError(`The sale couldn't be held: ${e.message}`) }
  }

  const recallSale = async (h) => {
    if (cart.lines.length) { flash('Hold or finish the sale on screen first'); return }
    try {
      const list = (await getHeld(terminalId)).filter(x => x.holdId !== h.holdId)
      await putHeld(terminalId, list)
      setHeld(list)
      cart.restore(h.sale)
      setModal(null)
      flash(`Sale recalled${h.note ? `: ${h.note}` : ''}`)
    } catch (e) { setError(`The sale couldn't be recalled: ${e.message}`) }
  }

  /** The customer never came back: the held sale is dropped, like Cancel sale. */
  const dropHeld = async (h) => {
    if (!confirm(`Delete the held sale of ₱${peso(h.net)}${h.note ? ` (${h.note})` : ''}? Its items are not sold.`)) return
    const list = (await getHeld(terminalId)).filter(x => x.holdId !== h.holdId)
    await putHeld(terminalId, list)
    setHeld(list)
    if (!list.length) setModal(null)
  }

  /** One key / button for both: Hold with items on screen, else the list to recall from. */
  const holdOrRecall = () => {
    if (canHold) setModal({ t: 'hold' })
    else if (!cart.lines.length && held.length) setModal({ t: 'recall' })
  }

  /* ---------- Open drawer (39) ----------
   * The drawer opens on the printer's pulse, so with no sale the cashier opens it here: a reason,
   * a supervisor when the till's Open drawer approval is on, then PrintAgent's drawer pulse (no
   * paper), else a NO SALE slip (an older agent: any print opens it). Each opening is logged
   * (offline it waits) and counted on the X-Read and Z-Read. */
  useEffect(() => {
    flushDrawerLog().catch(() => {})
    const f = () => flushDrawerLog().catch(() => {})
    const id = setInterval(f, 5 * 60 * 1000)
    window.addEventListener('online', f)
    return () => { clearInterval(id); window.removeEventListener('online', f) }
  }, [])

  /** reason, note; approval: { u, pw } when the till asks for a supervisor */
  const doOpenDrawer = async ({ reason, note, approval }) => {
    const approvedBy = approval ? await approveSupervisor(approval.u, approval.pw, branchCode)
      : (ctx.approvals?.OPEN_DRAWER ? userId : null)   // a Supervisor / Admin signed in: recorded as the approver
    const target = ctx.terminal.PrinterTarget
    let method = await openDrawer(target)
    if (!method) {
      const slip = buildNoSale({ cashier: fullName, reason, note, approvedByName: approval?.u }, ctx)
      if (!await printText(slip, target))
        throw new Error("The printer couldn't be reached, so the drawer didn't open. Check that the printer and PrintAgent are on.")
      method = 'SLIP'
    }
    await logDrawerOpen({ shiftUid, drawerOpenUid: uuid(), reason, note: note || null, approvedBy,
      openedAt: new Date().toISOString(), method })
    setModal(null)
    flash(method === 'SLIP' ? 'Drawer opened (a NO SALE slip printed)' : 'Drawer opened')
  }

  /** 36: a price level (Price 1..4) for an item or the whole sale. With the Price level approval
   *  on, a cashier needs a supervisor; going back to the regular price never does. `apply(approvedBy)`. */
  const withLevelApproval = (level, label, apply) => {
    if (level && needs('PRICE_LEVEL')) {
      setModal({ t: 'approve', title: label, message: 'A price level needs a supervisor at this till.',
        verify: async (u, pw) => { apply(await approveSupervisor(u, pw, branchCode)); setModal(null) } })
      return
    }
    apply(level && ctx.approvals?.PRICE_LEVEL ? userId : null)
    setModal(null)
  }

  const completeSale = async (payments) => {
    try {
      const orNumber = await nextORNumber()
      const tendered = round2(payments.reduce((s, p) => s + p.amount, 0))
      const zr = cart.zeroRated
      const items = cart.lines.map(l => {
        const own = totals.perLine[l.lineNo]
        return {
          lineNo: l.lineNo, productId: l.productId, barcode: l.barcode, productName: l.productName,
          categoryId: l.categoryId, quantity: l.quantity, unitPrice: own.unitPrice,
          origUnitPrice: l.origUnitPrice, lineDiscount: cart.lineDiscount(l),
          lineTotal: own.lineTotal,
          isVatable: l.isVatable, isDiscountable: l.isDiscountable,
          // a zero-rated line's price without the VAT is approved by the zero-rating's supervisor
          priceApprovedBy: own.unitPrice === l.origUnitPrice ? (l.levelApprovedBy ?? null)   // 36: a level's approver
            : zr && l.isVatable ? zr.approvedBy : (l.priceApprovedBy ?? userId),
          zeroRated: !!(zr && l.isVatable),   // invoice only: no * for a price changed by zero-rating
          wholesale: l.wholesale || null,      // invoice only: the regular price and the amount off
          promo: l.promo ? { promoName: l.promo.promoName, freeQty: l.promo.freeQty } : null,   // invoice only
          bnpc: !!own.kept,                    // invoice only: a 5% line prints what came off the bill
          discountQty: own.discountQty ?? null, // invoice only: the senior's own quantity ("1 of 3")
          // invoice only: a line at another price level than the sale's
          priceLevelName: l.priceLevel && l.priceLevel !== cart.priceLevel ? levelName(l.priceLevel) : null,
          // this line's share of the BIR figures — a later return refunds from these
          netAmount: own.net, vatableAmount: own.vatable, vatAmount: own.vat,
          vatExemptAmount: own.vatExempt, zeroRatedAmount: own.zeroRated, vatAdjustment: own.vatAdj
        }
      })
      const c = cart.customer || {}
      // Suki card: the server works the points out at sync; the invoice shows the same sum.
      const lc = cart.loyalty, lset = ctx.loyalty
      const earned = lc && lset?.enabled && lset.amountPerPoint > 0 ? Math.floor(totals.net / lset.amountPerPoint) : null

      const sale = {
        saleUid: uuid(),
        shiftUid, branchCode, terminalId, orNumber, cashierUserId: userId,
        businessDate, saleDateTime: new Date().toISOString(),
        grossAmount: totals.gross, discountAmount: totals.discount,
        vatExemptAmount: totals.vatExempt, vatableAmount: totals.vatable,
        vatAmount: totals.vat, zeroRatedAmount: totals.zeroRated, netAmount: totals.net,
        tenderedAmount: tendered, changeAmount: round2(tendered - totals.net),
        discountCode: cart.discount?.type || null,
        discountCtrlNo: cart.discount?.controlNo || null,
        discountName: cart.discount?.name || null,
        // a regular / other discount: its supervisor (the signed-in one when they gave it)
        discountApprovedBy: cart.discount?.type === OTHER_DISCOUNT || cart.discount?.cap != null || cart.discount?.qtys
          ? (cart.discount.approvedBy ?? userId) : (cart.discount?.approvedBy ?? null),   // 35: an approved SC/PWD
        // the senior's own quantities (only part of a line discounted), for the audit
        discountLines: cart.discount?.qtys && cart.discount.type !== OTHER_DISCOUNT
          ? items.filter(i => i.discountQty != null).map(i => ({ lineNo: i.lineNo, productName: i.productName, quantity: i.quantity, discountQty: i.discountQty }))
          : undefined,
        cancelledLines: cart.cancelled.length ? cart.cancelled : undefined,
        // an SC/PWD discount limited to the booklet's weekly cap (32): what it may take off the bill
        discountCap: cart.discount && cart.discount.type !== OTHER_DISCOUNT ? (cart.discount.cap ?? null) : null,
        vatAdjustment: totals.vatAdj,
        dinerCount: cart.pax?.dinerCount ?? null,
        seniorCount: cart.pax?.seniorCount ?? null,
        customerName: c.name || null, customerAddress: c.address || null,
        customerTin: c.tin || null, customerBusinessStyle: c.businessStyle || null,
        customerEmail: c.email || null,   // e-invoice copy (not printed); blank = the store's repository
        zeroRatedCertNo: zr?.certNo || null,
        zeroRatedApprovedBy: zr?.approvedBy ?? null,
        loyaltyCardNo: lc?.cardNo || null,
        // the sale's level, else the one its lines were set to (the ERP takes one level per sale)
        priceLevel: cart.priceLevel || cart.lines.find(l => l.priceLevel)?.priceLevel || null,
        // 33: lines at a wholesale price (the DTI report)
        wholesaleLines: cart.lines.filter(l => l.wholesale).map(l => ({ lineNo: l.lineNo, ...l.wholesale })),
        // 34: lines with promo-free units (the promo report; Sales.PromoAmount)
        promoLines: cart.lines.filter(l => l.promo && totals.perLine[l.lineNo]?.discount > 0).map(l => ({
          lineNo: l.lineNo, promoId: l.promo.promoId, promoName: l.promo.promoName, freeQty: l.promo.freeQty,
          regularPrice: totals.perLine[l.lineNo].unitPrice, promoAmount: totals.perLine[l.lineNo].discount })),
        // invoice only: the VAT taken off, promos, and each kind of discount on its own line
        discountBreakdown: totals.discount > 0
          ? { lessVat: totals.lessVat, promo: totals.promo, other: totals.other, exempt: totals.discExempt,
              rateExempt: totals.rateExempt, kept: totals.discKept, rateKept: totals.rateKept,
              noBooklet: cart.discount?.booklet === false } : null,
        // printed on the invoice only
        priceLevelName: cart.priceLevel ? levelName(cart.priceLevel) : null,
        // for the printed invoice only (the server keeps its own figures)
        loyalty: lc ? { programName: lset?.programName || 'Suki card', cardNo: lc.cardNo, earned,
          balance: lc.points != null && earned != null ? lc.points + earned : null } : null,
        status: 'Completed',
        items,
        payments: payments.map((p, i) => ({ ...p, seqNo: i + 1 })),
        syncStatus: 'pending'
      }
      // BIR: the invoice is kept exactly as printed, so a reprint is an exact replica.
      sale.receiptText = buildReceipt(sale, { ...ctx, cashier: fullName })

      await db.pendingSales.put(sale)        // 1. local first — survives anything
      cart.clear()
      syncPromos()                           // a promo saved meanwhile applies from the next sale
      setLastSale(sale)
      setModal(null)

      // 2. print: a discounted sale prints a customer copy and an accounting copy
      printText(hasDiscountCopies(sale) ? discountCopies(sale.receiptText, ctx.terminal.PaperWidth) : sale.receiptText,
        ctx.terminal.PrinterTarget)

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

      flash(`SI ${siNo(orNumber)} — change ₱${peso(sale.changeAmount)}`)
      let left = await orRemaining()
      if (left < 25 && isOnline()) {
        // Top up mid-shift, continuing after this device's own (maybe unsynced) sales.
        await allocateOrRange(terminalId, 500, await getMeta('or_next')).catch(() => {})
        left = await orRemaining()
      }
      if (left < 25) flash(`Only ${left} sales invoice numbers left — reconnect to reserve more`)
      searchRef.current?.focus()
    } catch (e) {
      setError(e.message)
    }
  }

  /** Default SI No. for the Reprint modal — the last one actually issued on this terminal,
   *  read from the persistent local counter (survives a reload, unlike lastSale). */
  const openReprint = async () => {
    const next = Number(await getMeta('or_next')) || 0
    const fallback = next > 0 ? next - 1 : (lastSale?.orNumber || '')
    if (needs('REPRINT')) {
      setModal({ t: 'approve', title: 'Reprint', message: 'A reprint needs a supervisor at this till.',
        verify: async (u, pw) => setModal({ t: 'reprint', defaultOrNumber: fallback, approvedBy: await approveSupervisor(u, pw, branchCode) }) })
      return
    }
    setModal({ t: 'reprint', defaultOrNumber: fallback })
  }

  const xread = () => {
    if (!needs('XREAD')) return runXRead()
    // the server checks the supervisor (X-Read needs a connection anyway)
    setModal({ t: 'approve', title: 'X-Read', message: 'An X-Read needs a supervisor at this till.',
      verify: async (u, pw) => { if (await runXRead(u, pw, true)) setModal(null) } })
  }

  const runXRead = async (u = null, pw = null, rethrow = false) => {
    try {
      const r = await api(`/api/shifts/${shiftUid}/xread`, { method: 'POST',
        body: JSON.stringify(u ? { overrideUsername: u, overridePassword: pw } : {}) })
      // A RawBT-configured terminal has no server-reachable printer — the API can
      // never print it, so the browser prints the text the response already carries.
      const target = ctx.terminal.PrinterTarget
      const printed = target?.startsWith('rawbt') ? await printText(r.receiptText, target) : r.printed
      flash(printed ? 'X-Read sent to the printer' : 'X-Read generated (printer unreachable)')
      return true
    } catch (e) { if (rethrow) throw e; setError(e.message) }
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

  const closeFind = () => { setModal(null); setSearch(''); setCategoryId(null) }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="bg-panel border-b border-line px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 shrink-0">
        <Wordmark className="text-lg sm:text-xl shrink-0" />
        <div className="hidden sm:flex flex-col leading-tight min-w-0 pl-3 border-l border-line">
          <span className="text-sm font-semibold truncate">{fullName}</span>
          <span className="text-xs text-muted truncate tabnum">{branchCode} · {terminalCode} · {businessDate}</span>
        </div>
        <StatusPill online={online} queued={queued} className="ml-auto shrink-0" />

        {/* Secondary actions stay inline on wider screens; on a phone-width handheld they'd
            wrap the header onto 2-3 lines and eat the little vertical space available, so
            they collapse into a menu instead. */}
        <nav className="hidden sm:flex items-center gap-1 shrink-0" aria-label="Till actions">
          {held.length > 0 && <ToolBtn icon="pause" onClick={() => cart.lines.length ? flash('Hold or finish the sale on screen first') : setModal({ t: 'recall' })}>
            Held ({held.length})</ToolBtn>}
          <ToolBtn icon="drawer" onClick={() => setModal({ t: 'drawer' })}>Drawer</ToolBtn>
          <ToolBtn icon="xread" onClick={xread}>X-Read</ToolBtn>
          <ToolBtn icon="print" onClick={openReprint}>Reprint</ToolBtn>
          <ToolBtn icon="void" onClick={() => setModal({ t: 'void' })}>Void</ToolBtn>
          {returnsEnabled && <ToolBtn icon="return" onClick={() => setModal({ t: 'return' })}>Return</ToolBtn>}
          {(role === 'Admin' || role === 'Supervisor') && <ToolBtn icon="admin" onClick={() => nav('/admin')}>Admin</ToolBtn>}
          <ToolBtn icon="signout" onClick={signOutForBreak}>Sign out</ToolBtn>
        </nav>
        <button className="sm:hidden shrink-0 text-fg2 w-10 h-10 rounded-xl border border-line flex items-center justify-center"
          aria-label="More actions" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>

        <Btn variant="danger" className="shrink-0 !min-h-[40px] !px-3 text-sm" onClick={() => nav('/blind-close')}>
          Close shift
        </Btn>
      </header>

      {!online && (
        <div className="bg-warn/10 text-warn-fg px-4 py-1.5 text-sm shrink-0">
          Offline — sales are saved on this tablet and sync automatically when the network returns.
        </div>
      )}
      {online && !token && (
        <div className="bg-warn/10 text-warn-fg px-4 py-1.5 text-sm shrink-0 flex items-center gap-3">
          <span>You signed in offline. {queued > 0 ? `${queued} saved sale(s) will send` : 'Sales will send'} once you sign in again.</span>
          <button className="underline font-semibold ml-auto" onClick={() => { logout(); nav('/login') }}>Sign in again</button>
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
      ) : groceryMode ? (
        <GroceryLane cart={cart} totals={totals} products={products} visible={visible} search={search} setSearch={setSearch}
          searchRef={searchRef} onSearchKey={onSearchKey} modalOpen={!!modal || menuOpen} setModal={setModal} ctx={ctx}
          levelName={levelName} onRemove={removeLine} onReprint={openReprint} onVoid={() => setModal({ t: 'void' })}
          onMore={() => setModal({ t: 'more' })} onFind={() => { setSearch(''); setModal({ t: 'find' }) }} flash={flash}
          canHold={canHold} heldCount={held.length} onHoldRecall={holdOrRecall} />
      ) : (
        <>
          <div className="flex-1 flex min-h-0 flex-col lg:flex-row">
            {/* Products */}
            <div className="flex-1 flex flex-col p-2 sm:p-4 gap-2 sm:gap-3 min-w-0 min-h-0">
              <ProductFinder search={search} setSearch={setSearch} searchRef={searchRef} onSearchKey={onSearchKey}
                categories={categories} categoryId={categoryId} setCategoryId={setCategoryId} count={visible.length} />
              <ProductGrid products={visible} onTap={cart.addProduct} />
            </div>

            {/* Cart — always-visible sidebar on tablet/desktop */}
            <div className="hidden lg:flex lg:w-[400px] bg-panel lg:border-l border-line flex-col min-h-0">
              <CartPanel cart={cart} totals={totals} loyalty={ctx.loyalty} priceLevels={ctx.priceLevels} setModal={setModal} flash={flash} onCancel={cartOnCancel} onRemove={removeLine}
                canHold={canHold} heldCount={held.length} onHoldRecall={holdOrRecall} />
            </div>
          </div>

          {/* Cart — floating button + on-demand sheet on phone-width screens */}
          {!cartOpen && (
            <button className="lg:hidden fixed bottom-4 right-4 z-30 bg-accent text-ink rounded-full pl-4 pr-5 py-3 shadow-2xl flex items-center gap-2.5 active:scale-95 transition-transform"
              onClick={() => setCartOpen(true)} aria-label="View current sale">
              <span className="relative shrink-0">
                <Icon name="cart" size={22} />
                {cart.lines.length > 0 && (
                  <span className="absolute -top-2 -right-2 bg-ink text-accent text-[10px] font-bold rounded-full w-[18px] h-[18px] flex items-center justify-center">
                    {cart.lines.length}
                  </span>
                )}
              </span>
              <span className="font-bold tabnum">₱{peso(totals.net)}</span>
            </button>
          )}
          {cartOpen && (
            <div className="lg:hidden fixed inset-0 z-40 flex flex-col justify-end" onClick={() => setCartOpen(false)}>
              <div className="absolute inset-0 bg-black/70" />
              <div className="relative bg-panel border-t border-line rounded-t-3xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="mx-auto mt-2 w-10 h-1 rounded-full bg-line2 shrink-0" />
                <div className="absolute right-2 top-2">
                  <button className="text-muted p-2" onClick={() => setCartOpen(false)} aria-label="Close">
                    <Icon name="close" size={18} />
                  </button>
                </div>
                <CartPanel cart={cart} totals={totals} loyalty={ctx.loyalty} priceLevels={ctx.priceLevels} setModal={setModal} flash={flash}
                  closeSheet={() => setCartOpen(false)} onCancel={cartOnCancel} onRemove={removeLine}
                  canHold={canHold} heldCount={held.length} onHoldRecall={holdOrRecall} />
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
        <PayModal due={totals.net} giftCertOn={!!ctx.settings.GiftCertOn} branchCode={branchCode}
          onClose={() => setModal(null)} onDone={completeSale} />
      )}
      {modal?.t === 'pax' && (
        <PaxModal onClose={() => setModal(null)} onApply={finishGenerateBill} />
      )}
      {modal?.t === 'discount' && (
        <DiscountModal types={cart.discountTypes} current={cart.discount} gross={totals.gross}
          needsOverride={role === 'Cashier'} typeNeedsApproval={needs('DISCOUNT')} branchCode={branchCode}
          posType={cart.posType} posTypeRates={cart.posTypeRates} discountFor={cart.discountFor}
          wholesaleCount={cart.lines.filter(l => l.wholesale).length}
          otherGross={round2(cart.lines.filter(l => !l.wholesale).reduce((a, l) => a + round2(l.quantity * cart.linePrice(l)), 0))}
          canCap={!(cart.pax?.dinerCount > 0)}
          lines={cart.lines.filter(l => l.isDiscountable)} lineRate={cart.lineRate}
          onClose={() => setModal(null)}
          onApply={(d) => { cart.setDiscount(d); setModal(null) }} />
      )}
      {modal?.t === 'qty' && (
        <QtyModal line={modal.line} onClose={() => setModal(null)}
          onApply={(q) => { if (q <= 0) removeLine(modal.line); else { cart.setQty(modal.line.lineNo, q); setModal(null) } }} />
      )}
      {modal?.t === 'price' && (
        <PriceModal line={modal.line} needsOverride={!!ctx.settings.PriceEditOverride && role === 'Cashier'}
          levelNeedsApproval={needs('PRICE_LEVEL')}
          branchCode={branchCode} levels={ctx.allPriceLevels || [1, 2, 3, 4].map(n => ({ level: n, name: `Price ${n}` }))}
          onLevel={(level) => withLevelApproval(level, `Price for ${modal.line.productName}`,
            (by) => cart.setLinePriceLevel(modal.line.lineNo, level, true, by))}
          onClose={() => setModal(null)}
          onApply={(p, approvedBy) => { cart.setPrice(modal.line.lineNo, p, approvedBy ?? userId); setModal(null) }} />
      )}
      {modal?.t === 'void' && (
        <VoidModal terminalId={terminalId} needsOverride={needs('VOID')} onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); flash(msg); refreshQueue() }} />
      )}
      {modal?.t === 'reprint' && (
        <ReprintModal terminalId={terminalId} defaultOrNumber={modal.defaultOrNumber} approvedBy={modal.approvedBy ?? null}
          ctx={ctx} cashier={fullName} onClose={() => setModal(null)}
          onDone={({ text, ok, label }) => {
            setModal({ t: 'paper', text })
            flash(ok ? `Reprinted ${label}` : 'Printer unreachable — check the print agent')
          }} />
      )}
      {modal?.t === 'customer' && (
        <CustomerModal current={cart.customer} onClose={() => setModal(null)}
          onApply={(c) => { cart.setCustomer(c); setModal(null) }} />
      )}
      {modal?.t === 'zerorated' && (
        <ZeroRatedModal current={cart.zeroRated} customer={cart.customer} hasDiscount={!!cart.discount}
          needsOverride={role === 'Cashier'} branchCode={branchCode} onClose={() => setModal(null)}
          onApply={(z, customer) => {
            if (z) { cart.setCustomer({ ...(cart.customer || {}), ...customer }); cart.setZeroRated({ ...z, approvedBy: z.approvedBy ?? userId }) }
            else cart.setZeroRated(null)
            setModal(null)
          }} />
      )}
      {modal?.t === 'approve' && (
        <ApprovalModal title={modal.title} message={modal.message} verify={modal.verify} onClose={() => setModal(null)} />
      )}
      {modal?.t === 'linelevel' && (
        <PriceLevelModal levels={(ctx.priceLevels || []).filter(o => modal.line.levels?.[o.level - 1] > 0)}
          current={modal.line.priceLevel} line={modal.line} onClose={() => setModal(null)}
          onApply={(level) => withLevelApproval(level, `Price for ${modal.line.productName}`,
            (by) => cart.setLinePriceLevel(modal.line.lineNo, level, false, by))} />
      )}
      {modal?.t === 'pricelevel' && (
        <PriceLevelModal levels={ctx.priceLevels || []} current={cart.priceLevel} onClose={() => setModal(null)}
          onApply={(level) => withLevelApproval(level, 'Price level for this sale', (by) => cart.setPriceLevel(level, by))} />
      )}
      {modal?.t === 'loyalty' && (
        <LoyaltyModal settings={ctx.loyalty} current={cart.loyalty} canUse={!!cart.lines.length}
          onClose={() => setModal(null)}
          onApply={(l) => { cart.setLoyalty(l); setModal(null) }} />
      )}
      {modal?.t === 'return' && (
        <ReturnModal terminalId={terminalId} shiftUid={shiftUid} ctx={ctx} cashier={fullName} needsOverride={needs('RETURN')}
          onClose={() => setModal(null)}
          onDone={({ text, ok, header }) => {
            setModal({ t: 'paper', text })
            flash(`Return ${returnNo(header.ReturnNo)}: refund ₱${peso(header.NetAmount)}` +
              (ok ? '' : ' (printer unreachable)'))
          }} />
      )}
      {modal?.t === 'find' && createPortal(
        // grocery lane F1: the product pictures and categories, for an item without a barcode
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex p-4 sm:p-8" onClick={closeFind}>
          <div className="relative flex-1 bg-ink border border-line rounded-2xl p-4 flex flex-col gap-3 min-h-0" onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Escape') closeFind() }}>
            <div className="flex items-center justify-between shrink-0">
              <h2 className="font-display font-bold text-lg">Find item</h2>
              <Btn className="text-sm !min-h-[40px]" onClick={closeFind}>Close (Esc)</Btn>
            </div>
            <ProductFinder search={search} setSearch={setSearch} searchRef={findRef} onSearchKey={e => {
              if (e.key === 'Enter' && visible.length === 1) { cart.addProduct(visible[0]); closeFind() }
            }} categories={categories} categoryId={categoryId} setCategoryId={setCategoryId} count={visible.length} />
            <ProductGrid products={visible} onTap={(p) => { cart.addProduct(p); closeFind() }} />
          </div>
        </div>,
        document.body
      )}
      {modal?.t === 'more' && (
        <Modal onClose={() => setModal(null)}>
          <h2 className="font-bold text-lg">More</h2>
          <div className="grid gap-2">
            {ctx.loyalty?.enabled && <Btn onClick={() => setModal({ t: 'loyalty' })}>{ctx.loyalty.programName || 'Suki card'}</Btn>}
            {!cart.discount && <Btn variant={cart.zeroRated ? 'moss' : 'ghost'} onClick={() => setModal({ t: 'zerorated' })}>Zero-rated sale (PEZA / ecozone / diplomat)</Btn>}
            {(ctx.priceLevels?.length > 0 || cart.priceLevel) && (
              <Btn variant={cart.priceLevel ? 'moss' : 'ghost'} onClick={() => setModal({ t: 'pricelevel' })}>
                Price level: {cart.priceLevel ? levelName(cart.priceLevel) : 'regular price'}</Btn>
            )}
            {canHold && <Btn onClick={() => setModal({ t: 'hold' })}>Hold sale (customer comes back)</Btn>}
            {held.length > 0 && <Btn disabled={cart.lines.length > 0} onClick={() => setModal({ t: 'recall' })}>
              Recall a held sale ({held.length}){cart.lines.length > 0 ? ': finish this sale first' : ''}</Btn>}
            <Btn onClick={() => setModal({ t: 'drawer' })}>Open drawer (no sale)</Btn>
            <Btn onClick={() => { setModal(null); xread() }}>X-Read</Btn>
            {returnsEnabled && <Btn onClick={() => setModal({ t: 'return' })}>Return</Btn>}
            <Btn variant="danger" disabled={!cart.lines.length} onClick={() => {
              setModal(null)
              if (cartOnCancel) cartOnCancel()
              else if (confirm('Clear the whole sale?')) { cart.clear(); flash('Sale cancelled') }
            }}>Cancel sale</Btn>
          </div>
          <Btn variant="dark" className="w-full" onClick={() => setModal(null)}>Close</Btn>
        </Modal>
      )}
      {modal?.t === 'drawer' && (
        <DrawerModal needsApproval={needs('OPEN_DRAWER')} onClose={() => setModal(null)} onOpen={doOpenDrawer} />
      )}
      {modal?.t === 'hold' && (
        <HoldModal net={totals.net} lineCount={cart.lines.length} customer={cart.customer?.name}
          onClose={() => setModal(null)} onHold={holdSale} />
      )}
      {modal?.t === 'recall' && (
        <RecallModal held={held} busy={cart.lines.length > 0} onClose={() => setModal(null)}
          onRecall={recallSale} onDelete={dropHeld} />
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
            <p className="text-sm text-muted">{fullName}</p>
          </div>
          <div className="grid gap-2">
            {held.length > 0 && <Btn disabled={cart.lines.length > 0} onClick={() => { setMenuOpen(false); setModal({ t: 'recall' }) }}>
              Recall a held sale ({held.length})</Btn>}
            <Btn onClick={() => { setMenuOpen(false); setModal({ t: 'drawer' }) }}>Open drawer (no sale)</Btn>
            <Btn onClick={() => { setMenuOpen(false); xread() }}>X-Read</Btn>
            <Btn onClick={() => { setMenuOpen(false); openReprint() }}>Reprint</Btn>
            <Btn onClick={() => { setMenuOpen(false); setModal({ t: 'void' }) }}>Void</Btn>
            {returnsEnabled && <Btn onClick={() => { setMenuOpen(false); setModal({ t: 'return' }) }}>Return</Btn>}
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
function CartPanel({ cart, totals, loyalty, priceLevels, setModal, flash, closeSheet = () => {}, onCancel, onRemove,
  canHold = false, heldCount = 0, onHoldRecall = () => {} }) {
  const openModal = (m) => { closeSheet(); setModal(m) }
  const cancel = onCancel || (() => { if (confirm('Clear the whole sale?')) { cart.clear(); flash('Sale cancelled') } })
  const items = cart.lines.reduce((n, l) => n + (l.weighed ? 1 : l.quantity), 0)

  return (
    <>
      <div className="px-4 pt-4 pb-3 flex items-baseline justify-between shrink-0">
        <h2 className="font-display font-bold text-lg">Current sale</h2>
        <span className="text-xs text-muted tabnum mr-9 lg:mr-0">{cart.lines.length ? `${cart.lines.length} line${cart.lines.length > 1 ? 's' : ''} · ${items} item${items === 1 ? '' : 's'}` : ''}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {!cart.lines.length && (
          <div className="flex flex-col items-center text-center gap-3 py-14 px-6 text-muted">
            <span className="w-14 h-14 rounded-2xl bg-raised border border-line flex items-center justify-center text-fg2">
              <Icon name="scan" size={26} />
            </span>
            <p className="text-sm">Scan a barcode or tap a product to start the sale.</p>
            {heldCount > 0 && (
              <Btn variant="moss" className="text-sm !min-h-[44px]" onClick={() => { closeSheet(); onHoldRecall() }}>
                Recall a held sale ({heldCount})</Btn>
            )}
          </div>
        )}
        {cart.lines.map(l => {
          const ld = cart.lineDiscount(l)
          return (
            <div key={l.lineNo} className="rounded-xl px-2 py-2.5 flex items-center gap-2 hover:bg-raised/60">
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate text-sm">{l.productName}</p>
                <p className="text-xs text-muted tabnum flex items-center gap-2 flex-wrap">
                  <span>@ ₱{peso(cart.linePrice(l))}</span>
                  {cart.zeroRated && l.isVatable && <span className="text-[10px] uppercase tracking-wide border border-line2 rounded px-1">0% VAT</span>}
                  {l.allowPriceEdit && (
                    // Edit price also offers the item's Price 1..4 (no approval) next to a typed price
                    <button className={`font-semibold ${l.priceLevel ? 'text-accent-fg' : 'text-brand-fg'}`} onClick={() => openModal({ t: 'price', line: l })}>
                      {l.priceLevel ? `${priceLevels?.find(o => o.level === l.priceLevel)?.name || `Price ${l.priceLevel}`} · edit` : 'Edit price'}</button>
                  )}
                  {/* Price1..4 for this item only, for an item whose price can't be edited (else Edit price offers them) */}
                  {!l.allowPriceEdit && priceLevels?.some(o => l.levels?.[o.level - 1] > 0) && !cart.zeroRated && (
                    <button className={l.priceLevel ? 'text-accent-fg font-semibold' : 'text-brand-fg font-semibold'}
                      onClick={() => openModal({ t: 'linelevel', line: l })}>
                      {l.priceLevel ? (priceLevels.find(o => o.level === l.priceLevel)?.name || `Price ${l.priceLevel}`) : 'Price level'}
                    </button>
                  )}
                  {!l.isDiscountable && <span className="text-[10px] uppercase tracking-wide border border-line2 rounded px-1">no disc</span>}
                  {l.wholesale && <span className="text-[10px] uppercase tracking-wide border border-accent text-accent-fg rounded px-1"
                    title={`From ${l.wholesale.minQty} of this item: ₱${peso(l.wholesale.amountOff)} off each`}>
                    wholesale · reg ₱{peso(l.wholesale.regularPrice)}</span>}
                  {l.wholesaleWaived && <span className="text-[10px] uppercase tracking-wide border border-line2 rounded px-1"
                    title={`Wholesale would be ₱${peso(l.wholesaleWaived.amountOff)} off each; the discount is worth more`}>
                    {cart.discount?.type} instead of wholesale</span>}
                </p>
                {ld > 0 && (
                  <p className="text-xs text-accent-fg tabnum">less {l.promo ? `${l.promo.promoName} (${l.promo.freeQty} free)` : cart.discount?.type}
                    {!l.promo && totals.perLine[l.lineNo]?.discountQty != null && ` (${totals.perLine[l.lineNo].discountQty} of ${l.quantity})`} −₱{peso(ld)}</p>
                )}
              </div>
              {l.weighed ? (
                // weight from the scale sticker — not changed by hand
                <span className="tabnum text-sm font-bold w-[104px] text-center flex items-center justify-center gap-1" title="Weighed (scale sticker)">
                  <Icon name="scale" size={14} className="text-muted" />{l.quantity.toFixed(3)}
                </span>
              ) : (
                <div className="flex items-center rounded-xl border border-line2 overflow-hidden">
                  <button className="w-9 h-9 text-lg text-fg2 hover:bg-raised" aria-label="One less"
                    onClick={() => (l.quantity - 1 <= 0 ? onRemove(l) : cart.setQty(l.lineNo, l.quantity - 1))}>−</button>
                  <button className="tabnum w-9 h-9 text-center font-bold text-sm border-x border-line2 hover:bg-raised" aria-label="Set quantity"
                    onClick={() => openModal({ t: 'qty', line: l })}>{l.quantity}</button>
                  <button className="w-9 h-9 text-lg text-fg2 hover:bg-raised" aria-label="One more"
                    onClick={() => cart.setQty(l.lineNo, l.quantity + 1)}>+</button>
                </div>
              )}
              <span className="tabnum w-[72px] text-right font-bold text-sm">{peso(l.quantity * cart.linePrice(l))}</span>
              <button className="text-muted hover:text-danger-fg w-8 h-8 flex items-center justify-center rounded-lg" aria-label={`Remove ${l.productName}`}
                onClick={() => { closeSheet(); onRemove(l) }}><Icon name="close" size={14} /></button>
            </div>
          )
        })}
      </div>

      <div className="border-t border-line px-4 pt-3 pb-1 space-y-1.5 shrink-0">
        <button className="w-full flex items-center gap-2 text-left text-sm text-fg2 rounded-xl border border-dashed border-line2 px-3 py-2 hover:bg-raised"
          onClick={() => openModal({ t: 'customer' })}>
          <Icon name="user" size={16} className="text-muted shrink-0" />
          <span className="truncate">{cart.customer?.name || cart.customer?.email
            ? [cart.customer.name && `Sold to: ${cart.customer.name}`, cart.customer.email && `e-invoice: ${cart.customer.email}`].filter(Boolean).join(' · ')
            : 'Add customer / email for e-invoice (optional)'}</span>
        </button>
        {(cart.zeroRated || !cart.discount) && (
          <button className={`w-full flex items-center gap-2 text-left text-sm rounded-xl border px-3 py-2 hover:bg-raised ${cart.zeroRated ? 'border-accent text-accent-fg' : 'border-dashed border-line2 text-fg2'}`}
            onClick={() => openModal({ t: 'zerorated' })}>
            <Icon name="user" size={16} className="text-muted shrink-0" />
            <span className="truncate">{cart.zeroRated
              ? `Zero-rated sale · Cert/ID ${cart.zeroRated.certNo}`
              : 'Zero-rated sale (PEZA / ecozone / diplomat)'}</span>
          </button>
        )}
        {cart.hints().map(h => (
          <div key={h} className="w-full flex items-center gap-2 text-left text-sm rounded-xl border border-dashed border-accent/60 text-accent-fg px-3 py-2">
            <Icon name="tag" size={16} className="text-muted shrink-0" /><span className="truncate">{h}</span>
          </div>
        ))}
        {cart.lines.some(l => l.wholesale || l.wholesaleWaived) && (
          <div className="w-full flex items-center gap-2 text-left text-sm rounded-xl border border-accent/60 text-accent-fg px-3 py-2">
            <Icon name="tag" size={16} className="text-muted shrink-0" />
            <span className="truncate">{[
              cart.lines.some(l => l.wholesale) && `Wholesale price on ${cart.lines.filter(l => l.wholesale).length} item line(s)`,
              cart.lines.some(l => l.wholesaleWaived) && `${cart.discount?.type} discount instead of wholesale on ${cart.lines.filter(l => l.wholesaleWaived).length} (worth more)`
            ].filter(Boolean).join(' · ')}</span>
          </div>
        )}
        {(priceLevels?.length > 0 || cart.priceLevel) && (
          <button className={`w-full flex items-center gap-2 text-left text-sm rounded-xl border px-3 py-2 hover:bg-raised ${cart.priceLevel ? 'border-accent text-accent-fg' : 'border-dashed border-line2 text-fg2'}`}
            onClick={() => setModal({ t: 'pricelevel' })}>
            <Icon name="tag" size={16} className="text-muted shrink-0" />
            <span className="truncate">{cart.priceLevel
              ? `Price level: ${priceLevels?.find(l => l.level === cart.priceLevel)?.name || `Price ${cart.priceLevel}`}`
              : 'Price level: regular price'}</span>
          </button>
        )}
        {loyalty?.enabled && (
          <button className="w-full flex items-center gap-2 text-left text-sm text-fg2 rounded-xl border border-dashed border-line2 px-3 py-2 hover:bg-raised"
            onClick={() => openModal({ t: 'loyalty' })}>
            <Icon name="card" size={16} className="text-muted shrink-0" />
            <span className={cart.loyalty ? 'leading-snug' : 'truncate'}>{cart.loyalty
              ? `${loyalty.programName}: ${cart.loyalty.customerName || cart.loyalty.cardNo}` +
                (loyalty.amountPerPoint > 0 && Math.floor(totals.net / loyalty.amountPerPoint) > 0
                  ? ` · +${Math.floor(totals.net / loyalty.amountPerPoint)} pts` : '') +
                (cart.loyalty.points != null ? ` (has ${cart.loyalty.points})` : ' (checked when online)')
              : `${loyalty.programName}: tap the card or check points (optional)`}</span>
          </button>
        )}
        <div className="flex justify-between text-sm text-muted tabnum pt-1">
          <span>Gross</span><span>{peso(totals.gross)}</span>
        </div>
        {totals.promo > 0 && (
          <div className="flex justify-between text-sm text-warn-fg tabnum">
            <span>Promos</span><span>−{peso(totals.promo)}</span>
          </div>
        )}
        {totals.other > 0 && (
          <div className="flex justify-between text-sm text-warn-fg tabnum">
            <span>Regular / other discount</span><span>−{peso(totals.other)}</span>
          </div>
        )}
        {/* the VAT taken off and each kind of SC/PWD discount on its own line, as the invoice prints them */}
        {[
          ['Less VAT (exempt)', totals.lessVat],
          [`${cart.discount?.type} discount${totals.rateExempt ? ` ${Math.round(totals.rateExempt * 100)}%` : ''}`, totals.discExempt],
          [`${cart.discount?.type}${totals.rateKept ? ` ${Math.round(totals.rateKept * 100)}%` : ''} (grocery/basic comm.)`, totals.discKept]
        ].filter(([, v]) => v > 0).map(([label, v]) => (
          <div key={label} className="flex justify-between text-sm text-warn-fg tabnum">
            <span>{label}</span><span>−{peso(v)}</span>
          </div>
        ))}
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] tracking-[0.25em] uppercase text-muted font-semibold">Total due</span>
          <span className="tabnum font-display text-3xl sm:text-4xl font-extrabold">₱{peso(totals.net)}</span>
        </div>
      </div>

      <div className={`p-3 sm:p-4 pt-2 grid ${canHold || heldCount ? 'grid-cols-[1fr_1fr_1fr_1.3fr]' : 'grid-cols-[1fr_1fr_1.4fr]'} gap-2 shrink-0`}>
        <Btn variant={cart.discount ? 'moss' : 'ghost'} className="text-sm !min-h-[52px]" disabled={!!cart.zeroRated}
          onClick={() => openModal({ t: 'discount' })}>
          {cart.discount ? cart.discount.type : 'Discount'}
        </Btn>
        {(canHold || heldCount > 0) && (
          // Hold while there are items (the customer went for more cash); Recall once the cart is empty
          <Btn className="text-sm !min-h-[52px]" disabled={!canHold && !!cart.lines.length}
            onClick={() => { closeSheet(); onHoldRecall() }}>
            {cart.lines.length ? 'Hold' : `Recall (${heldCount})`}
          </Btn>
        )}
        <Btn className="text-sm !min-h-[52px]" disabled={!cart.lines.length} onClick={cancel}>
          Cancel
        </Btn>
        <Btn variant="primary" className="text-lg !min-h-[52px] tracking-wide" disabled={!cart.lines.length}
          onClick={() => openModal({ t: 'pay' })}>PAY</Btn>
      </div>
    </>
  )
}

/* ================= Grocery lane (Terminals.ScreenLayout = 'Grocery', 37) =================
 * For a retail till on a PC screen where the cashier scans: the sale as a wide list (each line's
 * discount, promo or wholesale written under it), the totals and amount due on the right, and
 * function keys at the bottom (also on the keyboard). Same cart, modals and pay flow as Touch. */

/** What to show under a line and in its Less column: `tone` colors it (disc / promo / whs / other / none). */
function laneLineInfo(l, cart, totals, levelName) {
  const o = totals.perLine[l.lineNo] || {}
  const amt = round2(l.quantity * cart.linePrice(l))
  const off = round2(amt - (o.net ?? amt))
  const type = cart.discount?.type
  const notes = []
  let tone = null, less = null
  if (l.promo && o.discount > 0) {
    tone = 'promo'; less = o.discount
    notes.push(`Promo: ${l.promo.promoName} · ${l.promo.freeQty} free`)
  } else if (o.discount > 0 && type === OTHER_DISCOUNT) {
    tone = 'other'; less = o.discount
    notes.push('Regular / other discount (its share)')
  } else if (o.discount > 0) {
    tone = 'disc'
    const r = cart.lineRate(l, type)
    const pct = r ? ` ${Math.round(r.rate * 100)}%` : ''
    const part = o.discountQty != null ? ` (${o.discountQty} of ${l.quantity})` : ''
    if (o.kept) { less = off; notes.push(`${type}${pct}${part} · grocery / basic comm., VAT kept`) }
    else {
      // the 20% that removes the VAT: the discount, and the VAT taken off before it
      less = o.discount
      const vatOff = round2(off - o.discount)
      notes.push(`${type}${pct}${part}` + (vatOff > 0 ? ` · VAT removed −${peso(vatOff)}` : ' · VAT-exempt item'))
    }
  }
  if (l.wholesale) {
    tone = tone || 'whs'
    notes.push(`Wholesale: reg ${peso(l.wholesale.regularPrice)} less ${peso(l.wholesale.amountOff)} each (from ${l.wholesale.minQty})`)
  }
  if (l.wholesaleWaived) notes.push(`${type} instead of wholesale (worth more)`)
  if (!l.isDiscountable && type) { tone = tone || 'none'; notes.push('Not discountable') }
  if (l.priceLevel) notes.push(levelName(l.priceLevel))
  if (cart.zeroRated && l.isVatable) notes.push('0% VAT (zero-rated sale)')
  else if (l.unitPrice !== l.origUnitPrice) notes.push('Price changed *')
  if (l.weighed) notes.push('Weighed')
  return { amt, less, tone, note: notes.join(' · ') }
}

const LANE_TONE = { disc: 'text-accent-fg', promo: 'text-warn-fg', other: 'text-warn-fg', whs: 'text-brand-fg', none: 'text-muted' }
// narrower number columns on a 1024-1279 px screen, so the item names keep their room
const LANE_COLS = 'grid-cols-[30px_minmax(0,1fr)_64px_84px_84px_100px] xl:grid-cols-[44px_minmax(0,1fr)_104px_104px_100px_118px]'

function GroceryLane({ cart, totals, products, visible, search, setSearch, searchRef, onSearchKey, modalOpen, setModal,
  ctx, levelName, onRemove, onReprint, onVoid, onMore, onFind, flash, canHold = false, heldCount = 0, onHoldRecall = () => {} }) {
  const lines = cart.lines
  const [lastNo, setLastNo] = useState(null)       // the line just scanned or changed
  const [selNo, setSelNo] = useState(null)         // the line F2 / F3 / F6 act on (default: the last one)
  const [hl, setHl] = useState(0)                  // highlighted search result
  const prev = useRef(new Map())
  const rowRefs = useRef({})

  // the line that was just added, or whose quantity went up, is the "last" one
  useEffect(() => {
    const before = prev.current
    const changed = lines.find(l => !before.has(l.lineNo) || l.quantity > before.get(l.lineNo))
    prev.current = new Map(lines.map(l => [l.lineNo, l.quantity]))
    if (!lines.length) { setLastNo(null); setSelNo(null); return }
    if (changed) { setLastNo(changed.lineNo); setSelNo(changed.lineNo) }
    else if (!lines.some(l => l.lineNo === selNo)) setSelNo(lines[lines.length - 1].lineNo)
  }, [lines]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lastNo != null) rowRefs.current[lastNo]?.scrollIntoView({ block: 'nearest' }) }, [lastNo, lines])

  const sel = lines.find(l => l.lineNo === selNo) || lines[lines.length - 1] || null
  const last = lines.find(l => l.lineNo === lastNo) || null
  const q = search.trim()
  const exact = q && products.some(p => p.barcode === q || p.erpProductCode === q)
  const results = q.length >= 2 && !exact && !/^\d+(\.\d+)?\*/.test(q) ? visible.slice(0, 8) : []
  useEffect(() => setHl(0), [q])

  const addResult = (p) => { cart.addProduct(p); setSearch('') }

  /** "6*4800016…" = 6 of that item (typed, then scanned). */
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      if (results.length) { setHl(h => (h + d + results.length) % results.length); return }
      if (!lines.length) return
      const i = Math.max(0, lines.findIndex(l => l.lineNo === sel?.lineNo))
      setSelNo(lines[Math.min(lines.length - 1, Math.max(0, i + d))].lineNo)
      return
    }
    if (e.key === 'Escape') { setSearch(''); return }
    if (e.key !== 'Enter') return
    const m = q.match(/^(\d+(?:\.\d+)?)\s*\*\s*(\S+)$/)
    if (m) {
      const n = Number(m[1]), p = products.find(x => x.barcode === m[2]) || products.find(x => x.erpProductCode === m[2])
      if (!p) { flash(`No item with code ${m[2]}`); return }
      if (!(n > 0)) return
      cart.addProduct(p)
      const l = useCart.getState().lines.find(x => x.productId === p.productId && !x.weighed && x.unitPrice === x.origUnitPrice)
      if (l && n !== 1) cart.setQty(l.lineNo, round2(l.quantity + n - 1))
      setSearch('')
      return
    }
    if (results.length && results[hl]) { addResult(results[hl]); return }
    onSearchKey(e)
  }

  const editQty = () => {
    if (!sel) return
    if (sel.weighed) { flash('A weighed item keeps the weight on its sticker'); return }
    setModal({ t: 'qty', line: sel })
  }
  const editPrice = () => {
    if (!sel) return
    if (sel.allowPriceEdit) setModal({ t: 'price', line: sel })
    else if (ctx.priceLevels?.some(o => sel.levels?.[o.level - 1] > 0) && !cart.zeroRated) setModal({ t: 'linelevel', line: sel })
    else flash("This item's price can't be changed at the till")
  }

  const keys = [
    { k: 'F1', label: 'Find item', run: onFind },
    { k: 'F2', label: 'Qty', run: editQty, off: !sel },
    { k: 'F3', label: 'Price', run: editPrice, off: !sel },
    { k: 'F4', label: cart.discount ? cart.discount.type : 'Discount', run: () => setModal({ t: 'discount' }), off: !!cart.zeroRated, on: !!cart.discount },
    { k: 'F5', label: 'Customer', run: () => setModal({ t: 'customer' }), on: !!cart.customer?.name },
    { k: 'F6', label: 'Remove', run: () => sel && onRemove(sel), off: !sel, danger: true },
    { k: 'F7', label: 'More', run: onMore },
    { k: 'F8', label: 'Reprint', run: onReprint },
    { k: 'F9', label: 'Void', run: onVoid, danger: true },
    // with items: park the sale; with an empty sale: the held ones to recall
    { k: 'F10', label: lines.length ? 'Hold' : `Recall${heldCount ? ` (${heldCount})` : ''}`, run: onHoldRecall,
      off: lines.length ? !canHold : !heldCount, on: !lines.length && heldCount > 0 },
    { k: 'F12', label: 'PAY', run: () => setModal({ t: 'pay' }), off: !lines.length, pay: true }
  ]
  // the keyboard's F-keys, only while no dialog is open (F5 would otherwise reload the page)
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    if (modalOpen) return
    const h = (e) => {
      const key = keysRef.current.find(x => x.k === e.key)
      if (!key) return
      e.preventDefault()
      if (!key.off) key.run()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [modalOpen])

  const type = cart.discount?.type
  const pct = (r) => (r ? ` ${Math.round(r * 100)}%` : '')
  const items = lines.reduce((n, l) => n + (l.weighed ? 0 : l.quantity), 0)
  const kilos = round2(lines.reduce((n, l) => n + (l.weighed ? l.quantity : 0), 0))
  const wholesaleSaved = round2(lines.reduce((s, l) => s + (l.wholesale ? l.quantity * l.wholesale.amountOff : 0), 0))
  const saved = round2(totals.gross - totals.net + wholesaleSaved)
  const deductions = [
    ['Less VAT (exempt)', totals.lessVat, ''],
    ['Less promos', totals.promo, 'text-warn-fg'],
    ['Less regular / other discount', totals.other, 'text-warn-fg'],
    [`Less ${type}${pct(totals.rateExempt)}`, totals.discExempt, 'text-accent-fg'],
    [`Less ${type}${pct(totals.rateKept)} (grocery)`, totals.discKept, 'text-accent-fg']
  ].filter(([, v]) => v > 0)
  const hints = cart.hints()

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 flex gap-3 px-4 pt-3">
        <div className="relative w-[40%] xl:w-[480px] shrink-0">
          <label className="flex items-center gap-2.5 px-3.5 min-h-[50px] bg-raised border-2 border-accent rounded-xl">
            <span className="text-xs font-bold text-accent-fg tracking-wider">SCAN</span>
            <input ref={searchRef} autoFocus aria-label="Scan a barcode, or type a code or name"
              className="flex-1 min-w-0 bg-transparent outline-none text-lg text-fg placeholder:text-muted"
              placeholder="Barcode, code or name · 6* for a quantity"
              value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onKey} />
          </label>
          {results.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-panel border border-line2 rounded-xl shadow-2xl overflow-hidden" role="listbox">
              {results.map((p, i) => (
                <button key={p.productId} role="option" aria-selected={i === hl}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left ${i === hl ? 'bg-accent/15' : 'hover:bg-raised'}`}
                  onMouseEnter={() => setHl(i)} onClick={() => { addResult(p); searchRef.current?.focus() }}>
                  <span className="flex-1 min-w-0 truncate font-semibold">{p.productName}</span>
                  <span className="text-xs text-muted tabnum">{p.erpProductCode || p.barcode}</span>
                  <span className="tabnum font-bold text-accent-fg w-24 text-right">₱{peso(p.price)}</span>
                </button>
              ))}
              {visible.length > results.length && (
                <p className="px-3.5 py-2 text-xs text-muted border-t border-line">{visible.length - results.length} more: keep typing, or F1 Find item</p>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-4 px-4 min-h-[50px] bg-accent/10 border border-line2 rounded-xl">
          <span className="text-xs font-bold text-accent-fg uppercase tracking-wider shrink-0">Last</span>
          {last ? (
            <>
              <span className="text-lg font-bold truncate">{last.productName}</span>
              <span className="flex-1" />
              <span className="tabnum text-fg2 shrink-0">{last.weighed ? last.quantity.toFixed(3) : last.quantity} × {peso(cart.linePrice(last))}</span>
              <span className="tabnum font-display text-2xl font-extrabold shrink-0">{peso(round2(last.quantity * cart.linePrice(last)))}</span>
            </>
          ) : <span className="text-muted text-sm">Nothing scanned yet</span>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-3 px-4 py-3">
        <section className="flex-1 min-w-0 flex flex-col bg-panel border border-line rounded-xl overflow-hidden">
          <div className={`grid ${LANE_COLS} gap-2 xl:gap-2.5 px-3 xl:px-4 py-2 bg-raised text-xs font-bold uppercase tracking-wider text-muted`}>
            <div>#</div><div>Description</div><div className="text-right">Qty</div><div className="text-right">Unit price</div>
            <div className="text-right">Less</div><div className="text-right">Amount</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!lines.length && (
              <div className="flex flex-col items-center text-center gap-3 py-16 text-muted">
                <span className="w-14 h-14 rounded-2xl bg-raised border border-line flex items-center justify-center text-fg2"><Icon name="scan" size={26} /></span>
                <p>Scan a barcode to start the sale. F1 finds an item without a barcode.</p>
                {heldCount > 0 && <p className="text-accent-fg font-semibold">{heldCount} sale{heldCount > 1 ? 's' : ''} on hold. F10 recalls one.</p>}
              </div>
            )}
            {lines.map((l, i) => {
              const info = laneLineInfo(l, cart, totals, levelName)
              const isSel = sel?.lineNo === l.lineNo
              return (
                <button key={l.lineNo} ref={el => { rowRefs.current[l.lineNo] = el }} type="button"
                  className={`w-full grid ${LANE_COLS} gap-2 xl:gap-2.5 items-center px-3 xl:px-4 py-2 text-left border-b border-line ${
                    l.lineNo === lastNo ? 'bg-accent/10' : 'hover:bg-raised/60'} ${isSel ? 'outline outline-2 -outline-offset-2 outline-accent/70' : ''}`}
                  onClick={() => { setSelNo(l.lineNo); searchRef.current?.focus() }}
                  onDoubleClick={() => { setSelNo(l.lineNo); if (!l.weighed) setModal({ t: 'qty', line: l }) }}>
                  <span className="text-sm text-muted tabnum">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block font-semibold truncate">{l.productName}</span>
                    {info.note && <span className={`block text-xs truncate ${LANE_TONE[info.tone] || 'text-muted'}`}>{info.note}</span>}
                  </span>
                  <span className="text-right font-semibold tabnum">{l.weighed ? l.quantity.toFixed(3) : l.quantity}</span>
                  <span className="text-right text-fg2 tabnum">{peso(cart.linePrice(l))}</span>
                  <span className={`text-right font-semibold tabnum ${LANE_TONE[info.tone] || 'text-muted'}`}>
                    {info.less > 0 ? `−${peso(info.less)}` : l.wholesale ? 'WHS' : '—'}</span>
                  <span className="text-right font-bold tabnum">{peso(info.amt)}</span>
                </button>
              )
            })}
          </div>
          <div className="shrink-0 flex items-center gap-5 px-4 py-2 bg-raised border-t border-line text-xs text-fg2">
            <span className="tabnum"><b className="text-fg">{lines.length}</b> lines · <b className="text-fg">{items}</b> pcs{kilos > 0 && <> + <b className="text-fg">{kilos}</b> weighed</>}</span>
            <span className="flex-1" />
            <span className="hidden xl:inline"><span className="text-accent-fg">■</span> SC/PWD discount</span>
            <span className="hidden xl:inline"><span className="text-warn-fg">■</span> Promo</span>
            <span className="hidden xl:inline"><span className="text-brand-fg">■</span> Wholesale price</span>
            <span className="hidden 2xl:inline text-muted">↑ ↓ pick a line · double-click: quantity</span>
          </div>
        </section>

        <aside className="w-[320px] xl:w-[360px] shrink-0 flex flex-col gap-2.5 min-h-0">
          {(cart.discount || cart.customer?.name || cart.zeroRated || cart.loyalty || cart.priceLevel || hints.length > 0 || wholesaleSaved > 0) && (
            <div className="shrink-0 bg-panel border border-line rounded-xl px-4 py-2.5 space-y-1 text-sm">
              {cart.discount && (
                <button className="w-full text-left" onClick={() => setModal({ t: 'discount' })}>
                  <span className="block text-xs font-bold tracking-wider text-accent-fg uppercase">
                    {type === OTHER_DISCOUNT ? 'Regular / other discount' : type}{cart.discount.booklet === false ? ' · no booklet' : ''}</span>
                  <span className="block font-semibold truncate">{type === OTHER_DISCOUNT
                    ? `Reason: ${cart.discount.name || ''}` : `${cart.discount.name || ''}${cart.discount.controlNo ? ` · ID ${cart.discount.controlNo}` : ''}`}</span>
                  {type !== OTHER_DISCOUNT && (totals.discKept > 0 || cart.discount.booklet === false || cart.discount.cap != null) && (
                    <span className="block text-xs text-muted">{cart.discount.booklet === false
                      ? 'No booklet: no 5% on grocery / basic comm.'
                      : `Booklet shown · grocery 5% ₱${peso(totals.discKept)} of ₱${peso(cart.discount.cap ?? 125)} allowed`}</span>
                  )}
                </button>
              )}
              {cart.customer?.name && <p className="truncate text-fg2">Sold to: {cart.customer.name}</p>}
              {cart.zeroRated && <p className="truncate text-accent-fg">Zero-rated sale · Cert/ID {cart.zeroRated.certNo}</p>}
              {cart.loyalty && <p className="truncate text-fg2">{ctx.loyalty?.programName || 'Suki card'}: {cart.loyalty.customerName || cart.loyalty.cardNo}</p>}
              {cart.priceLevel && <p className="truncate text-accent-fg">Price level: {levelName(cart.priceLevel)}</p>}
              {wholesaleSaved > 0 && <p className="truncate text-brand-fg">Wholesale price on {lines.filter(l => l.wholesale).length} line(s) · saves ₱{peso(wholesaleSaved)}</p>}
              {lines.some(l => l.wholesaleWaived) && <p className="truncate text-fg2">{type} instead of wholesale on {lines.filter(l => l.wholesaleWaived).length} (worth more)</p>}
              {hints.map(h => <p key={h} className="truncate text-warn-fg">{h}</p>)}
            </div>
          )}

          <div className="flex-1 min-h-0 bg-panel border border-line rounded-xl px-5 py-4 flex flex-col gap-2.5 xl:gap-3 text-fg2 overflow-y-auto">
            <div className="flex justify-between items-baseline text-base xl:text-lg"><span>Gross</span><span className="tabnum font-bold text-fg">{peso(totals.gross)}</span></div>
            {deductions.map(([label, v, tone]) => (
              <div key={label} className={`flex justify-between items-baseline gap-3 text-base xl:text-lg ${tone ? `${tone} font-semibold` : ''}`}>
                <span className="min-w-0">{label}</span><span className={`tabnum font-bold shrink-0 ${tone ? '' : 'text-fg'}`}>−{peso(v)}</span>
              </div>
            ))}
            <div className="mt-auto border-t border-line pt-2 space-y-1 text-[15px]">
              <div className="flex justify-between"><span>VATable sales</span><span className="tabnum">{peso(totals.vatable)}</span></div>
              <div className="flex justify-between"><span>VAT 12%</span><span className="tabnum">{peso(totals.vat)}</span></div>
              <div className="flex justify-between"><span>VAT-exempt sales</span><span className="tabnum">{peso(totals.vatExempt)}</span></div>
              {totals.zeroRated > 0 && <div className="flex justify-between"><span>Zero-rated sales</span><span className="tabnum">{peso(totals.zeroRated)}</span></div>}
            </div>
          </div>

          <div className="shrink-0 h-[132px] flex flex-col justify-center gap-2 bg-deep border border-line2 rounded-xl px-4 xl:px-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-bold tracking-[0.08em] text-accent-fg">AMOUNT DUE</span>
              {saved > 0 && <span className="text-[13px] text-accent-fg tabnum">Saved ₱{peso(saved)}</span>}
            </div>
            <span className="tabnum font-display text-[44px] xl:text-5xl font-extrabold leading-none text-right truncate">{peso(totals.net)}</span>
          </div>
        </aside>
      </div>

      <nav aria-label="Function keys" className="shrink-0 grid grid-cols-11 gap-1.5 px-4 pb-3">
        {keys.map(key => (
          <button key={key.k} type="button" disabled={key.off}
            className={`min-h-[56px] rounded-lg border flex flex-col items-center justify-center gap-0.5 disabled:opacity-40 transition active:scale-[0.98] ${
              key.pay ? 'bg-accent text-ink border-accent hover:bg-accent-hover'
              : key.on ? 'bg-accent/15 text-accent-fg border-accent'
              : `bg-raised border-line2 hover:bg-hover ${key.danger ? 'text-danger-fg' : 'text-fg'}`}`}
            onClick={() => { key.run(); if (!key.pay) searchRef.current?.focus() }}>
            <span className="text-xs font-bold opacity-80">{key.k}</span>
            <span className="text-[15px] font-bold leading-tight truncate max-w-full px-1">{key.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

/** Search/scan box + category pills — shared by the takeout view and the dine-in ordering view. */
function ProductFinder({ search, setSearch, searchRef, onSearchKey, categories, categoryId, setCategoryId, count }) {
  const pill = (on) => `whitespace-nowrap rounded-full px-4 min-h-[38px] text-sm font-semibold border transition ${
    on ? 'bg-accent border-accent text-ink' : 'bg-panel border-line text-fg2 hover:border-line2'}`
  return (
    <>
      <div className="relative shrink-0">
        <Icon name="search" size={20} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <Input ref={searchRef} className="text-base sm:text-lg !pl-11 !min-h-[50px] bg-panel" autoFocus
          placeholder="Scan a barcode or search by name / code…"
          value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKey} />
      </div>
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <div className="flex gap-2 overflow-x-auto pb-1 min-w-0">
          <button className={pill(!categoryId)} onClick={() => setCategoryId(null)}>All</button>
          {categories.map(([id, name]) => (
            <button key={id} className={pill(categoryId === id)} onClick={() => setCategoryId(id)}>{name}</button>
          ))}
        </div>
        <span className="hidden sm:block ml-auto shrink-0 text-xs text-muted tabnum pl-2">{count} item{count === 1 ? '' : 's'}</span>
      </div>
    </>
  )
}

/** At most this many tiles: a VROSS till has ~11,400 items, and drawing a tile for each (and
 *  redrawing them all on every scan) made the POS slow. Cashiers there scan or search; the rest are
 *  a search or a category away. A restaurant menu stays well under it. */
const GRID_LIMIT = 60

/** The tap-to-add product tile grid — shared by the takeout cart view and the dine-in
 *  ordering view, parameterized only by what tapping a product actually does. A product
 *  with no photo gets a tinted default tile (ProductThumb), never an empty box. Memoized, so a
 *  cart change doesn't redraw the tiles (onTap must be a stable function). */
const ProductGrid = React.memo(function ProductGrid({ products, onTap }) {
  const shown = products.length > GRID_LIMIT ? products.slice(0, GRID_LIMIT) : products
  return (
    <div className="flex-1 overflow-y-auto grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 auto-rows-max gap-2 sm:gap-3 content-start pb-20 lg:pb-2">
      {shown.map(p => (
        <button key={p.productId} onClick={() => onTap(p)}
          className="bg-panel border border-line rounded-2xl text-left active:scale-[0.97] hover:border-line2 transition flex flex-col overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {/* padding-top: 100% forces a true square from the container's own width —
              unlike the CSS aspect-ratio property, this works even on older WebView/Chrome
              builds some rugged Android POS terminals ship with. */}
          <div className="relative w-full shrink-0" style={{ paddingTop: '100%' }}>
            <ProductThumb name={p.productName} categoryId={p.categoryId} imageUrl={p.imageUrl} />
            {!p.isDiscountable && (
              <span className="hidden sm:block absolute top-2 left-2 text-[9px] font-bold uppercase tracking-wide bg-ink/80 text-fg2 rounded px-1.5 py-0.5">
                no disc
              </span>
            )}
          </div>
          <div className="flex-1 p-2 sm:p-3 flex flex-col justify-between gap-1">
            <span className="font-semibold leading-snug text-[11px] sm:text-sm line-clamp-2">{p.productName}</span>
            <span className="tabnum text-sm sm:text-base text-accent-fg font-bold">₱{peso(p.price)}</span>
          </div>
        </button>
      ))}
      {!products.length && (
        <div className="col-span-full flex flex-col items-center gap-3 text-muted text-center py-14">
          <Cube size={56} className="text-line2" />
          <p className="text-sm">No products match. If the catalog is empty, reopen the shift while online.</p>
        </div>
      )}
      {products.length > GRID_LIMIT && (
        <p className="col-span-full text-center text-sm text-muted py-4">
          Showing {GRID_LIMIT} of {products.length.toLocaleString()} items. Scan, or type a name or code, or pick a category to find the rest.
        </p>
      )}
    </div>
  )
})

/** Small icon + label button for the till header. */
function ToolBtn({ icon, children, ...p }) {
  return (
    <button className="flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm text-fg2 hover:bg-raised hover:text-fg" {...p}>
      <Icon name={icon} size={16} className="text-muted" />{children}
    </button>
  )
}

/* Inline stroke icons (the handheld's font lacks many symbols, so never use Unicode glyphs). */
const ICONS = {
  xread: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  void: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  return: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  admin: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  signout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M18 6L6 18M6 6l12 12',
  cart: 'M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM20 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8',
  card: 'M2 5h20v14H2zM2 10h20M6 15h4',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  back: 'M15 18l-6-6 6-6',
  pause: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM10 9v6M14 9v6',
  drawer: 'M3 10h18v9H3zM5 6h14l2 4H3zM10 14h4'
}
function Icon({ name, size = 18, className = '' }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={ICONS[name]} />
    </svg>
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
                occupied ? 'bg-warn/10 border-warn/50' : 'bg-panel border-accent/40'}`}>
              <div className="text-lg font-bold">{t.TableNumber}</div>
              <div className={`text-xs mt-1 font-semibold ${occupied ? 'text-warn-fg' : 'text-accent-fg'}`}>
                {occupied ? `Occupied · ${t.ItemCount} item${t.ItemCount === 1 ? '' : 's'}` : 'Available'}
              </div>
            </button>
          )
        })}
      </div>
      {!tables.length && (
        <p className="text-muted text-center py-10">
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
      <div className="flex-1 flex flex-col p-2 sm:p-4 gap-2 sm:gap-3 min-w-0 min-h-0">
        <div className="flex items-center gap-2 shrink-0">
          <Btn className="!min-h-[36px] text-sm flex items-center gap-1.5" onClick={onBackToTables}>
            <Icon name="back" size={14} />
            Tables
          </Btn>
          <span className="font-display font-bold text-lg">Table {activeOrder.order.TableNumber}</span>
        </div>
        <ProductFinder search={search} setSearch={setSearch} searchRef={searchRef} onSearchKey={onSearchKey}
          categories={categories} categoryId={categoryId} setCategoryId={setCategoryId} count={visible.length} />
        <ProductGrid products={visible} onTap={onAddItem} />
      </div>

      <div className="w-full lg:w-[400px] bg-panel border-t lg:border-t-0 lg:border-l border-line flex flex-col min-h-0">
        <div className="px-3 pt-2 pb-1 shrink-0">
          <span className="text-[10px] tracking-[0.3em] uppercase text-muted font-semibold">This order</span>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-line">
          {!items.length && (
            <p className="text-muted text-center py-12 px-6">Tap a product to add it to this table's order.</p>
          )}
          {items.map(l => (
            <div key={l.LineNo} className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate text-sm">{l.ProductName}</p>
                <p className="text-xs text-muted tabnum">@ ₱{peso(l.UnitPrice)}</p>
              </div>
              <div className="flex items-center gap-1">
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => onSetQty(l.LineNo, Number(l.Quantity) - 1)}>−</Btn>
                <span className="tabnum w-9 text-center font-bold text-sm">{l.Quantity}</span>
                <Btn className="!min-h-[36px] !px-2.5" onClick={() => onSetQty(l.LineNo, Number(l.Quantity) + 1)}>+</Btn>
              </div>
              <span className="tabnum w-16 text-right font-bold text-sm">{peso(l.Quantity * l.UnitPrice)}</span>
              <button className="text-danger-fg text-lg px-1" onClick={() => onSetQty(l.LineNo, 0)}>×</button>
            </div>
          ))}
        </div>

        <div className="border-t border-line px-4 py-3 shrink-0">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] tracking-[0.25em] uppercase text-muted font-semibold">Running total</span>
            <span className="tabnum font-display text-3xl sm:text-4xl font-extrabold">₱{peso(total)}</span>
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
/** giftCertOn (38): the branch takes gift certificates (POS settings). */
function PayModal({ due, giftCertOn = false, branchCode, onClose, onDone }) {
  const [payments, setPayments] = useState([])
  const [cash, setCash] = useState('')
  const [card, setCard] = useState(null)
  const [gc, setGc] = useState(null)   // the gift certificate being added: { no, info, unchecked, value, error, busy }

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

  /* 38: a gift certificate. Checked against the list when online; offline (or the server can't
   * be reached) the cashier types its face value and it's checked when the sale syncs. It pays
   * at most what's left of the bill: no change on a GC, the rest of its value is forfeited. */
  const gcFace = gc?.info?.ok ? gc.info.faceValue : (gc?.unchecked ? round2(Number(gc.value) || 0) : 0)
  const gcPays = round2(Math.min(gcFace, balance))
  const checkGc = async () => {
    const no = (gc?.no || '').trim()
    if (!no) return
    if (payments.some(p => p.paymentType === 'GC' && p.gcNo === no)) { setGc({ ...gc, error: 'This gift certificate is already on this sale.' }); return }
    setGc({ no, busy: true })
    try {
      const info = await api(`/api/giftcerts/lookup?no=${encodeURIComponent(no)}&branchCode=${encodeURIComponent(branchCode || '')}`)
      setGc({ no, info })
    } catch (e) {
      // no answer from the list (offline, signed in offline, server down): taken unchecked
      setGc({ no, unchecked: true, value: '', error: e instanceof TypeError || !navigator.onLine ? null : e.message })
    }
  }
  const addGc = () => {
    if (!(gcFace > 0) || !(gcPays > 0)) return
    setPayments(ps => [...ps, { paymentType: 'GC', amount: gcPays, gcNo: gc.no.trim(), gcValue: gcFace, gcChecked: !gc.unchecked }])
    setGc(null)
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex justify-between items-baseline">
        <h2 className="text-lg font-bold">Payment</h2>
        <span className="tabnum text-2xl font-bold">₱{peso(due)}</span>
      </div>

      {payments.length > 0 && (
        <div className="border border-line rounded-lg divide-y divide-line">
          {payments.map((p, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-2 text-sm">
              <span className="font-semibold w-14">{p.paymentType}</span>
              <span className="flex-1 text-muted truncate">
                {p.paymentType === 'CARD'
                  ? `${p.cardBank} ****${(p.cardNo || '').slice(-4)} · ${p.cardName} · Ref ${p.cardRefNo}`
                  : p.paymentType === 'GC'
                    ? `Gift cert ${p.gcNo} · value ₱${peso(p.gcValue)}${p.gcValue > p.amount ? ` · ₱${peso(p.gcValue - p.amount)} forfeited` : ''}${p.gcChecked ? '' : ' · not checked (offline)'}`
                    : 'Cash tendered'}
              </span>
              <span className="tabnum font-bold">{peso(p.amount)}</span>
              <button className="text-danger-fg" onClick={() => setPayments(ps => ps.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className={`flex justify-between items-baseline px-3 py-2 rounded-lg ${balance > 0 ? 'bg-warn/10 text-warn-fg' : 'bg-accent/10 text-accent-fg'}`}>
        <span className="text-sm font-semibold">{balance > 0 ? 'Balance remaining' : 'Change'}</span>
        <span className="tabnum text-xl font-bold">₱{peso(balance > 0 ? balance : change)}</span>
      </div>

      {gc ? (
        <div className="border border-line rounded-lg p-3 space-y-3">
          <h3 className="font-semibold text-sm">Gift certificate</h3>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Field label="GC No. (scan or type)">
                <Input autoFocus value={gc.no || ''} readOnly={gc.busy}
                  onChange={e => setGc({ no: e.target.value })}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); gc.info?.ok || gc.unchecked ? addGc() : checkGc() } }} />
              </Field>
            </div>
            {!gc.info && !gc.unchecked && <Btn variant="dark" disabled={!gc.no?.trim() || gc.busy} onClick={checkGc}>{gc.busy ? 'Checking…' : 'Check'}</Btn>}
          </div>
          {gc.error && <Note tone="red">{gc.error}</Note>}
          {gc.info && !gc.info.ok && <Note tone="red" title="Can't take this gift certificate">{gc.info.problem} Ask for another payment.</Note>}
          {gc.info?.ok && (
            <Note tone="green" title={`Good · face value ₱${peso(gc.info.faceValue)}`}>
              {gc.info.expiryDate ? `Valid until ${String(gc.info.expiryDate).slice(0, 10)}. ` : ''}
              It pays ₱{peso(gcPays)}{gcFace > gcPays ? `; ₱${peso(gcFace - gcPays)} is forfeited (no change on a gift certificate).` : '.'}
            </Note>
          )}
          {gc.unchecked && (
            <>
              <Note tone="amber" title="Can't check it now">
                The list can't be reached{gc.error ? ` (${gc.error})` : ''}. Enter its face value; it's checked when the sale
                syncs, and a used or unknown one is flagged to head office.
              </Note>
              <Field label="Face value"><Input className="text-right tabnum" inputMode="decimal" value={gc.value}
                onChange={e => setGc({ ...gc, value: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
              {gcFace > 0 && <p className="text-xs text-muted">It pays ₱{peso(gcPays)}{gcFace > gcPays ? `; ₱${peso(gcFace - gcPays)} is forfeited (no change on a gift certificate).` : '.'}</p>}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setGc(null)}>Cancel</Btn>
            <Btn variant="dark" disabled={!(gcPays > 0)} onClick={addGc}>Add gift certificate</Btn>
          </div>
        </div>
      ) : !card ? (
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
              {giftCertOn && <Btn disabled={balance <= 0} onClick={() => setGc({ no: '' })}>Gift cert</Btn>}
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
        <div className="border border-line rounded-lg p-3 space-y-3">
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
          <p className="text-xs text-muted">Only the last 4 digits are stored. No change is given on a card tender.</p>
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
/** posType / posTypeRates: the rate shown for each type is this till's (32). discountFor(type): what
 *  that discount would take off this bill, uncapped. canCap: false on a pax-split bill. */
/* ================= Open drawer (39) ================= */
const DRAWER_REASONS = ['Change for a customer', 'Check the cash', 'Cash in / cash out', 'Other']
function DrawerModal({ needsApproval, onClose, onOpen }) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = reason && (reason !== 'Other' || note.trim()) && (!needsApproval || (u && pw))
  const open = async () => {
    if (!ok || busy) return
    setBusy(true); setError('')
    try { await onOpen({ reason, note: note.trim(), approval: needsApproval ? { u, pw } : null }) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Open the drawer (no sale)</h2>
      <p className="text-sm text-muted">Every opening is logged with the reason and counted on the X-Read and Z-Read.</p>
      <div className="grid grid-cols-2 gap-2">
        {DRAWER_REASONS.map(r => (
          <button key={r} type="button" onClick={() => setReason(r)}
            className={`rounded-lg p-3 text-left text-sm font-semibold border ${reason === r ? 'bg-accent/15 text-fg border-accent' : 'bg-panel border-line2'}`}>{r}</button>
        ))}
      </div>
      <Field label={reason === 'Other' ? 'What for' : 'Note (optional)'}>
        <Input value={note} maxLength={200} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && open()} />
      </Field>
      {needsApproval && (
        <>
          <Note tone="amber" title="Supervisor approval">Opening the drawer needs a supervisor at this till.</Note>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supervisor username"><Input value={u} autoComplete="off" onChange={e => setU(e.target.value)} /></Field>
            <Field label="Password"><Input type="password" value={pw} autoComplete="new-password" onChange={e => setPw(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && open()} /></Field>
          </div>
        </>
      )}
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={!ok || busy} onClick={open}>{busy ? 'Opening…' : 'Open drawer'}</Btn>
      </div>
    </Modal>
  )
}

/* ================= Hold / Recall ================= */
/** Park the sale: an optional note so the cashier knows whose it is when the customer comes back. */
function HoldModal({ net, lineCount, customer, onClose, onHold }) {
  const [note, setNote] = useState(customer || '')
  const [busy, setBusy] = useState(false)
  const hold = async () => { setBusy(true); try { await onHold(note) } finally { setBusy(false) } }
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Hold this sale</h2>
      <p className="text-sm text-muted">
        {lineCount} line{lineCount > 1 ? 's' : ''}, ₱{peso(net)}. The sale is kept on this till, as it is now, while the
        customer gets more cash; serve the next customer meanwhile. Recall it to pay. Nothing is sold until then.
      </p>
      <Field label="Note (optional)">
        <Input autoFocus value={note} maxLength={60} placeholder="e.g. lady in blue, went to the ATM"
          onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) hold() }} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={busy} onClick={hold}>Hold sale</Btn>
      </div>
    </Modal>
  )
}

const heldAgo = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  const time = new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
  return `${time} · ${min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`}`
}

/** The sales on hold at this till, oldest first: Recall one (the screen must be empty), or delete one
 *  whose customer never came back. */
function RecallModal({ held, busy, onClose, onRecall, onDelete }) {
  return (
    <Modal onClose={onClose} wide>
      <h2 className="font-bold text-lg">Sales on hold</h2>
      {busy && <Note tone="amber">Hold or finish the sale on screen first, then recall.</Note>}
      {!held.length && <p className="text-sm text-muted">No sales on hold at this till.</p>}
      <div className="grid gap-2 max-h-[60vh] overflow-y-auto">
        {held.map((h, i) => {
          const items = h.sale.lines.slice(0, 3).map(l => l.productName).join(', ') + (h.sale.lines.length > 3 ? ` +${h.sale.lines.length - 3} more` : '')
          return (
            <div key={h.holdId} className="rounded-xl border border-line2 bg-raised p-3 flex items-center gap-3">
              <span className="w-8 h-8 shrink-0 rounded-lg bg-panel border border-line flex items-center justify-center font-bold tabnum">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{h.note || 'No note'}{h.sale.discount?.type ? ` · ${h.sale.discount.type}` : ''}</p>
                <p className="text-xs text-muted truncate">{items}</p>
                <p className="text-xs text-muted tabnum">{heldAgo(h.heldAt)}{h.heldBy ? ` · held by ${h.heldBy}` : ''}</p>
              </div>
              <span className="tabnum font-display font-bold text-lg shrink-0">₱{peso(h.net)}</span>
              <div className="flex flex-col gap-1 shrink-0">
                <Btn variant="primary" className="text-sm !min-h-[38px]" disabled={busy} onClick={() => onRecall(h)}>Recall</Btn>
                <button type="button" className="text-xs text-danger-fg font-semibold" onClick={() => onDelete(h)}>Delete</button>
              </div>
            </div>
          )
        })}
      </div>
      <Btn variant="dark" className="w-full" onClick={onClose}>Close</Btn>
    </Modal>
  )
}

/** lines: the cart's discountable lines, for "only the senior's own items" (a quantity per line; the rest
 *  is charged in full). Not on a pax-split bill (canCap false): the headcount decides there. A cashier
 *  needs a supervisor for it. */
function DiscountModal({ types, current, gross, needsOverride, typeNeedsApproval = false, branchCode, posType, posTypeRates, discountFor, canCap,
  wholesaleCount = 0, otherGross = gross, lines = [], lineRate = () => null, onClose, onApply }) {
  const [type, setType] = useState(current?.type || null)
  const [controlNo, setControlNo] = useState(current?.controlNo || '')
  const [name, setName] = useState(current?.name || '')
  // a regular / other discount: a peso amount, a reason and a supervisor
  const [amount, setAmount] = useState(current?.type === OTHER_DISCOUNT ? String(current.amount) : '')
  // basic necessities (the 5% that keeps the VAT) need the purchase booklet (JAO 24-02); without
  // it those lines get nothing and the 20% still applies. The weekly cap: what the booklet still
  // allows off the bill on them (blank = up to ₱125, the most a week allows).
  const [booklet, setBooklet] = useState(current?.booklet === true)
  const [capStr, setCapStr] = useState(current?.cap != null ? String(current.cap) : '')
  // the senior's own quantity per line (as typed; blank = all of it)
  const [ownOnly, setOwnOnly] = useState(!!current?.qtys)
  const [qtyStr, setQtyStr] = useState(() => Object.fromEntries(lines.map(l =>
    [l.lineNo, current?.qtys?.[l.lineNo] != null ? String(current.qtys[l.lineNo]) : String(l.quantity)])))
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const other = type === OTHER_DISCOUNT
  const amt = round2(Number(amount) || 0)
  const reason = name.trim().slice(0, 120)
  // a regular / other discount is shared over the items not at a wholesale price
  const otherOk = amt > 0 && amt < otherGross && reason && (!needsOverride || (u && pw))
  // only the lines whose quantity was lowered; null = every item in full
  const qtys = (() => {
    if (!ownOnly || !canCap) return null
    const o = {}
    for (const l of lines) {
      const q = Number(qtyStr[l.lineNo])
      if (qtyStr[l.lineNo] !== '' && Number.isFinite(q) && q < l.quantity) o[l.lineNo] = Math.max(0, round2(q))
    }
    return Object.keys(o).length ? o : null
  })()
  const qtyBad = ownOnly && lines.some(l => qtyStr[l.lineNo] !== '' && !(Number(qtyStr[l.lineNo]) >= 0))
  const full = type && !other ? discountFor(type, qtys) : { total: 0, kept: 0 }
  const whole = qtys && type && !other ? discountFor(type) : null
  const capAmt = capStr.trim() === '' ? null : round2(Number(capStr) || 0)
  const capping = canCap && type && !other && booklet && capAmt != null && capAmt < full.kept
  const rateOf = (t) => posTypeRates?.find(r => r.discountCode === t.code && r.posType === posType && r.categoryId == null) || t
  // 35: the till's Discount approval (SC/PWD/NAAC/MOV/Solo); one approval also covers a weekly cap
  const typeApproval = typeNeedsApproval && !!type && !other
  const typeCreds = typeApproval || (capping && needsOverride) || (!!qtys && needsOverride)

  const approve = () => approveSupervisor(u, pw, branchCode)

  const applyOther = async () => {
    if (!(amt > 0 && amt < otherGross)) { setError(`Enter an amount more than ₱0 and less than ₱${peso(otherGross)}${otherGross < gross ? ' (the items not at a wholesale price)' : ', the sale'}.`); return }
    if (!needsOverride) { onApply({ type, amount: amt, name: reason, controlNo: null, approvedBy: null }); return }
    setBusy(true); setError('')
    try { onApply({ type, amount: amt, name: reason, controlNo: null, approvedBy: await approve() }) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const applyType = async () => {
    if (!type) { onApply(null); return }
    if (qtyBad) { setError("Enter the senior's quantity as a number, 0 or more."); return }
    const base = { type, controlNo, name, booklet: full.kept > 0 ? booklet : true, ...(qtys ? { qtys } : {}) }
    if (capping && !(capAmt > 0)) { setError('Enter what the booklet still allows, more than ₱0. With nothing left, untick the booklet.'); return }
    const withCap = capping ? { ...base, cap: capAmt } : base
    if (!typeCreds) { onApply(capping || qtys ? { ...withCap, approvedBy: null } : withCap); return }
    setBusy(true); setError('')
    try { onApply({ ...withCap, approvedBy: await approve() }) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const tile = (code, title, sub, extra) => (
    <button key={code ?? 'none'} onClick={() => { setType(code); setError('') }}
      className={`rounded-lg p-3 text-left border ${type === code ? 'bg-accent/15 text-fg border-accent' : 'bg-panel border-line2'}`}>
      <div className="font-bold text-sm">{title}</div>
      <div className={`text-xs ${type === code ? 'text-fg2' : 'text-muted'}`}>{sub}</div>
      {extra && <div className={`text-xs mt-1 ${type === code ? 'text-fg2' : 'text-muted'}`}>{extra}</div>}
    </button>
  )

  return (
    <Modal onClose={onClose} wide>
      <h2 className="text-lg font-bold">Discount type</h2>
      <p className="text-sm text-muted">
        {other
          ? 'A peso amount off the whole sale, shared across every item. It isn\'t VAT-exempt: VAT is on the price after the discount. It can\'t go with a senior/PWD discount.'
          : 'Applied per item — only products flagged discountable are reduced. Everything else stays at full price and remains VATable.'}
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {types.map(t => tile(t.code, t.code, t.description,
          `${Math.round(rateOf(t).rate * 100)}% · ${rateOf(t).vatExempt ? 'VAT-exempt' : 'VAT applies'} · ${t.law}`))}
        {tile(OTHER_DISCOUNT, 'REGULAR / OTHER', 'Special case or company discretion', '₱ amount · VAT applies · supervisor')}
        {tile(null, 'NONE', 'Regular sale')}
      </div>
      {type && !other && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Control No."><Input value={controlNo} placeholder="ID / booklet number"
            onChange={e => setControlNo(e.target.value)} /></Field>
          <Field label="Name"><Input value={name} placeholder="Full name on the ID"
            onChange={e => setName(e.target.value)} /></Field>
        </div>
      )}
      {type && !other && <Note tone="stone">Both fields print on the receipt and feed the BIR discount report.</Note>}
      {type && !other && wholesaleCount > 0 && (
        <Note tone="stone" title="Wholesale items">
          {wholesaleCount} item line(s) reach a wholesale price. The customer gets the wholesale price or the {type} discount,
          whichever is worth more, never both; SparkPOS picks it item by item.
        </Note>
      )}
      {type && !other && canCap && lines.length > 0 && (
        <div className="rounded-lg border border-line2 p-3 space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ownOnly} onChange={e => setOwnOnly(e.target.checked)} />
            <span>Only the {type === 'PWD' ? "PWD's" : "senior's"} own items. Lower an item's quantity to what they eat or use
              themselves (e.g. 1 of 3); the rest is charged in full.{needsOverride ? ' A supervisor approves it.' : ''}</span>
          </label>
          {ownOnly && (
            <div className="max-h-72 overflow-y-auto">
              <div className="flex items-end gap-2 pb-1 text-[11px] uppercase tracking-wide text-muted border-b border-line">
                <span className="flex-1">Item</span>
                <span className="w-14 text-right">Bought</span>
                <span className="w-24 text-right">For the {type === 'PWD' ? 'PWD' : 'senior'}</span>
              </div>
              {lines.map(l => {
                const r = lineRate(l, type)
                const q = qtyStr[l.lineNo] === '' ? l.quantity : Math.min(Math.max(Number(qtyStr[l.lineNo]) || 0, 0), l.quantity)
                const rest = round2(l.quantity - q)
                const off = full.perLine?.[l.lineNo] ? round2(full.perLine[l.lineNo].lineTotal - full.perLine[l.lineNo].net) : 0
                return (
                  <div key={l.lineNo} className="py-2 border-b border-line">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-semibold">{l.productName}</p>
                        <p className="text-xs text-muted">₱{peso(l.unitPrice)} each · {r
                          ? `${Math.round(r.rate * 100)}%${r.vatExempt ? ', VAT removed' : ', VAT stays'}`
                          : 'no discount (wholesale / promo)'}</p>
                      </div>
                      <span className="w-14 shrink-0 text-right tabnum text-sm">{l.quantity}</span>
                      <Input className="!w-24 shrink-0 text-right tabnum" inputMode="decimal" disabled={!r}
                        aria-label={`How many ${l.productName} are for the ${type === 'PWD' ? 'PWD' : 'senior'}`}
                        value={qtyStr[l.lineNo] ?? ''} onChange={e => setQtyStr({ ...qtyStr, [l.lineNo]: e.target.value.replace(/[^0-9.]/g, '') })} />
                    </div>
                    {r && (
                      <p className={`text-xs mt-1 ${rest > 0 ? 'text-warn-fg' : 'text-fg2'}`}>
                        {q <= 0 ? `No discount: all ${l.quantity} at full price`
                          : rest > 0 ? `Discount on ${q} of ${l.quantity}; ${rest} at full price`
                          : `Discount on all ${l.quantity}`}
                        {off > 0 && ` · less ₱${peso(off)}`}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {type && !other && full.total > 0 && (
        <p className="text-sm text-fg2">
          {whole && whole.total > full.total && `Only the own items: ₱${peso(full.total)} instead of ₱${peso(whole.total)}. `}
          Takes ₱{peso(full.total)} off this sale
          {full.kept > 0 && full.kept < full.total && `: ₱${peso(round2(full.total - full.kept))} VAT-exempt (20%) and ₱${peso(full.kept)} on basic necessities (5%)`}
          {full.kept > 0 && full.kept === full.total && ', all on basic necessities (5%)'}.
        </p>
      )}
      {type && !other && full.kept > 0 && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={booklet} onChange={e => setBooklet(e.target.checked)} />
          <span>Purchase booklet shown and written in. Without it, the 5% on basic necessities (₱{peso(full.kept)}) isn't
            given; the VAT-exempt 20% still is.</span>
        </label>
      )}
      {type && !other && canCap && booklet && full.kept > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 items-end">
            <Field label="Weekly cap from the booklet (optional): the most the 5% items may take off, ₱">
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={capStr} placeholder="Blank = what the booklet allows, up to ₱125"
                onChange={e => setCapStr(e.target.value)} /></Field>
            <p className="text-sm text-fg2 pb-3">{capping
              ? `The 5% takes off ₱${peso(capAmt)} instead of ₱${peso(full.kept)}. The 20% isn't touched.`
              : `This sale's 5% items take off ₱${peso(full.kept)}. Leave it blank unless the booklet has less than that left this week (₱125 at most a week).`}</p>
          </div>
        </>
      )}
      {typeCreds && (
        <>
          <Note tone="amber" title="Supervisor approval">{typeApproval
            ? `A supervisor approves a ${type} discount at this till${capping || qtys ? `, and the ${[capping && 'weekly cap', qtys && "own items' quantities"].filter(Boolean).join(' and ')} with it` : ''}.`
            : `A supervisor approves a discount ${[capping && 'limited to the weekly cap', qtys && "on only part of the items"].filter(Boolean).join(' and ')}.`}</Note>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supervisor username"><Input value={u} autoComplete="off" onChange={e => setU(e.target.value)} /></Field>
            <Field label="Password"><Input type="password" value={pw} autoComplete="new-password" onChange={e => setPw(e.target.value)} /></Field>
          </div>
        </>
      )}
      {other && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Amount off (${otherGross < gross ? 'non-wholesale items' : 'sale'} ₱${peso(otherGross)})`}>
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} autoFocus
                onChange={e => setAmount(e.target.value)} /></Field>
            <Field label="Reason"><Input value={name} maxLength={120} placeholder="e.g. loyal customer, damaged packaging"
              onChange={e => setName(e.target.value)} /></Field>
          </div>
          {amt > 0 && amt < otherGross && <p className="text-sm text-fg2">Amount due ₱{peso(round2(gross - amt))}. The reason prints on the invoice.</p>}
          {needsOverride && (
            <>
              <Note tone="amber" title="Supervisor approval">A supervisor approves every regular / other discount.</Note>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Supervisor username"><Input value={u} autoComplete="off" onChange={e => setU(e.target.value)} /></Field>
                <Field label="Password"><Input type="password" value={pw} autoComplete="new-password" onChange={e => setPw(e.target.value)} /></Field>
              </div>
            </>
          )}
        </>
      )}
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        {other
          ? <Btn variant="primary" disabled={busy || !otherOk} onClick={applyOther}>{busy ? 'Checking…' : 'Apply'}</Btn>
          : <Btn variant="primary" disabled={busy || (type && (!controlNo || !name)) || (typeCreds && (!u || !pw))}
              onClick={applyType}>{busy ? 'Checking…' : 'Apply'}</Btn>}
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
      <p className="text-sm text-muted">
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
      <p className="text-sm text-muted">Decimals are allowed for weighed items (e.g. 1.35 kg).</p>
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
/** A special price for one line. When the branch requires it (PosSettings.PriceEditOverride)
 *  a cashier needs a supervisor, checked online — the approver is saved on the sale line and
 *  every change is audit-logged when the sale syncs. */
function PriceModal({ line, needsOverride, levelNeedsApproval = false, branchCode, levels = [], onLevel, onClose, onApply }) {
  const [p, setP] = useState(String(line.unitPrice))
  // the item's own prices (35): its selling price and Price 1..4, each with its value for reference
  // (a level with no price for this item shows "not set" and can't be picked). Picking one needs no
  // supervisor (it's the item's price, not a change); a typed price does.
  const options = line.shelfPrice == null ? [] : [{ level: null, name: 'Regular price', price: line.shelfPrice },
    ...levels.map(o => ({ ...o, price: line.levels?.[o.level - 1] > 0 ? line.levels[o.level - 1] : null }))]
  const pickable = options.filter(o => o.price != null)
  const current = line.unitPrice === line.origUnitPrice ? (line.priceLevel ?? null) : undefined
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const price = Number(p)

  const apply = async () => {
    if (!(price > 0)) { setError('Enter a price above zero.'); return }
    // a typed price that is one of the item's own prices is that level, not a change
    const same = pickable.length > 1 ? pickable.find(o => o.price === price) : null
    if (same) { onLevel(same.level); return }
    if (price === line.origUnitPrice || !needsOverride) { onApply(price, null); return }
    setBusy(true); setError('')
    try {
      if (isOnline()) {
        const r = await api('/api/auth/verify-approver', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) })
        // lets this supervisor approve on this device even when the network is down later
        await rememberCredential(u, pw, { userId: r.userId, username: u, fullName: r.fullName, role: r.role, branchCode })
        onApply(price, r.userId)
      } else {
        // offline: only a supervisor of this branch who approved/signed in here online before
        const p = await verifyOffline(u, pw)
        if (p.role !== 'Supervisor' || p.branchCode !== branchCode)
          throw new Error(`Needs a supervisor of branch ${branchCode}.`)
        onApply(price, p.userId)
      }
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Edit price — {line.productName}</h2>
      <p className="text-sm text-muted">
        The original price ₱{peso(line.origUnitPrice)} is kept for the audit log and the line is
        marked with * on the receipt.
      </p>
      {options.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">This item's prices (tap one{levelNeedsApproval ? ': Price 1-4 need a supervisor' : ': no approval needed'})</p>
          <div className="grid grid-cols-2 gap-2">
            {options.map(o => (
              <Btn key={o.level ?? 0} variant={current === o.level ? 'moss' : 'ghost'} className="!min-h-[44px] text-sm"
                disabled={o.price == null} onClick={() => onLevel(o.level)}>
                {o.name} · {o.price == null ? 'not set' : `₱${peso(o.price)}`}</Btn>
            ))}
          </div>
          <p className="text-sm font-semibold pt-1">Or type another price{needsOverride ? ' (needs a supervisor)' : ''}</p>
        </div>
      )}
      <Input className="text-right tabnum text-3xl" inputMode="decimal" autoFocus={options.length <= 1} value={p}
        onChange={e => setP(e.target.value.replace(/[^0-9.]/g, ''))} />
      {needsOverride && price !== line.origUnitPrice && !(pickable.length > 1 && pickable.some(o => o.price === price)) && (
        <>
          <Note tone="amber" title="Supervisor override required">
            This branch requires a supervisor for price changes.
          </Note>
          <Field label="Supervisor username"><Input value={u} onChange={e => setU(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        </>
      )}
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Back</Btn>
        <Btn variant="primary" disabled={busy || (needsOverride && price !== line.origUnitPrice
          && !(pickable.length > 1 && pickable.some(o => o.price === price)) && (!u || !pw))}
          onClick={apply}>{busy ? 'Checking…' : 'Apply'}</Btn>
      </div>
    </Modal>
  )
}

/* ================= Void ================= */
/** Two steps: find the sale by SI No. (any sale on this terminal, not just the last one),
 *  then confirm reason + override. No default OR# on purpose — voiding is destructive,
 *  so it should never be one accidental Enter-key-press away from voiding whatever was
 *  last sold. */
function VoidModal({ terminalId, needsOverride, onClose, onDone }) {
  const [orNumber, setOrNumber] = useState('')
  const [sale, setSale] = useState(null)
  const [finding, setFinding] = useState(false)
  const [reason, setReason] = useState('')
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const find = async () => {
    if (!orNumber) return
    setFinding(true); setError('')
    try {
      const found = await findSaleByOr(terminalId, orNumber)
      if (found.status === 'Voided') throw new Error(`SI ${siNo(orNumber)} is already voided.`)
      setSale(found)
    } catch (e) {
      setError(e.message || `No sale found with SI No. ${siNo(orNumber)} on this terminal.`)
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
      onDone(`SI ${siNo(sale.orNumber)} voided`)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (!sale) return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Void a sale</h2>
      <p className="text-sm text-muted">Enter the sales invoice number of the sale to void.</p>
      <Field label="SI No.">
        <Input inputMode="numeric" autoFocus value={orNumber} maxLength={18}
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
      <h2 className="font-bold text-lg">Void SI {siNo(sale.orNumber)}</h2>
      <p className="text-sm text-muted">₱{peso(sale.netAmount)}</p>
      {needsOverride
        ? <Note tone="amber" title="Supervisor override required">
            This till requires an override for voids. Change it in Admin → POS Settings → Supervisor approvals.
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
/** BIR: a reprint is an exact replica of the original — the stored text (same date and time,
 *  same everything) under a REPRINT label. Pre-filled with the last SI No. issued on this
 *  terminal (defaultOrNumber, from the persistent local counter), so one tap reprints the last
 *  receipt; editable to reprint any earlier one, or switch to a return transaction. Every
 *  reprint of a synced document is logged server-side. */
function ReprintModal({ terminalId, defaultOrNumber, approvedBy = null, ctx, cashier, onClose, onDone }) {
  const [kind, setKind] = useState('sale')
  const [number, setNumber] = useState(defaultOrNumber ? String(defaultOrNumber) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState('')
  const width = ctx.terminal.PaperWidth

  /** E-invoice: email an exact copy of this invoice / return receipt (online; the sale must have synced). */
  const emailCopy = async () => {
    const to = email.trim().toLowerCase()
    if (!number || !looksLikeEmail(to)) return setError('Enter the number and a valid email address.')
    setBusy(true); setError(''); setSent('')
    try {
      if (kind === 'sale') {
        const sale = await findSaleByOr(terminalId, number, { serverOnly: true })
        await api(`/api/sales/${sale.saleUid}/email`, { method: 'POST', body: JSON.stringify({ to }) })
        setSent(`SI ${siNo(sale.orNumber)} will be emailed to ${to}.`)
      } else {
        const r = await findReturnByNo(terminalId, number)
        await api(`/api/returns/${r.header.ReturnUid}/email`, { method: 'POST', body: JSON.stringify({ to }) })
        setSent(`Return ${returnNo(r.header.ReturnNo)} will be emailed to ${to}.`)
      }
    } catch (e) {
      setError(e instanceof TypeError ? 'Emailing a copy needs a connection.' : (e.message || 'Not found on this terminal.'))
    } finally { setBusy(false) }
  }

  const submit = async () => {
    if (!number) return
    setBusy(true); setError('')
    try {
      let text, label
      if (kind === 'sale') {
        const sale = await findSaleByOr(terminalId, number)
        text = sale.receiptText
          ? reprintText(sale.receiptText, width, { voided: sale.status === 'Voided' })
          : buildReceipt(sale, { ...ctx, cashier }, { reprint: true })   // sold before texts were kept
        label = `SI ${siNo(sale.orNumber)}`
        api(`/api/sales/${sale.saleUid}/reprint-log`, { method: 'POST', body: JSON.stringify({ approvedBy }) }).catch(() => {})
      } else {
        const r = await findReturnByNo(terminalId, number)
        text = reprintText(r.header.ReceiptText || '', width)
        label = `return ${returnNo(r.header.ReturnNo)}`
        api(`/api/returns/${r.header.ReturnUid}/reprint-log`, { method: 'POST', body: JSON.stringify({ approvedBy }) }).catch(() => {})
      }
      const ok = await printText(text, ctx.terminal.PrinterTarget)
      onDone({ text, ok, label })
    } catch (e) {
      setError(e.message || 'Not found on this terminal.')
    } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Reprint</h2>
      <div className="grid grid-cols-2 gap-2">
        <Btn variant={kind === 'sale' ? 'moss' : 'ghost'} className="!min-h-[36px] text-sm"
          onClick={() => { setKind('sale'); setNumber(defaultOrNumber ? String(defaultOrNumber) : '') }}>Sales invoice</Btn>
        <Btn variant={kind === 'return' ? 'moss' : 'ghost'} className="!min-h-[36px] text-sm"
          onClick={() => { setKind('return'); setNumber('') }}>Return</Btn>
      </div>
      <p className="text-sm text-muted">
        {kind === 'sale' ? 'Defaults to the last sales invoice issued on this terminal.'
          : 'Enter the return number (needs a connection).'}
      </p>
      <Field label={kind === 'sale' ? 'SI No.' : 'Return No.'}>
        <Input inputMode="numeric" autoFocus value={number} maxLength={kind === 'sale' ? 18 : 6}
          onChange={e => setNumber(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && submit()} />
      </Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !number} onClick={submit}>
          {busy ? 'Working…' : 'Reprint'}
        </Btn>
      </div>
      <div className="border-t border-line pt-4 space-y-2">
        <Field label="Or email a copy (e-invoice)">
          <div className="flex gap-2">
            <Input type="email" inputMode="email" autoCapitalize="none" placeholder="customer@example.com"
              value={email} maxLength={254} onChange={e => { setEmail(e.target.value); setSent('') }}
              onKeyDown={e => e.key === 'Enter' && emailCopy()} />
            <Btn className="shrink-0" disabled={busy || !number || !email} onClick={emailCopy}>Send</Btn>
          </div>
        </Field>
        {sent && <Note tone="green">{sent}</Note>}
      </div>
    </Modal>
  )
}

const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254

/* ================= Suki / reward card ================= */
/** Tap the card (the reader types its number and Enter, like a scanner), or type the card or
 *  mobile number. Shows the balance (a points inquiry needs no sale) and rings the current sale
 *  up with the card. Offline the card can't be checked: it can still go on the sale, and the
 *  server checks it when the sale is sent (an unknown card simply earns nothing). */
/** A supervisor's OK: online any supervisor of the branch or an admin; offline only a supervisor
 *  of this branch who approved / signed in here online before. Returns their user ID. */
async function approveSupervisor(u, pw, branchCode) {
  if (isOnline()) {
    const r = await api('/api/auth/verify-approver', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) })
    await rememberCredential(u, pw, { userId: r.userId, username: u, fullName: r.fullName, role: r.role, branchCode })
    return r.userId
  }
  const p = await verifyOffline(u, pw)
  if (p.role !== 'Supervisor' || p.branchCode !== branchCode)
    throw new Error(`Needs a supervisor of branch ${branchCode}.`)
  return p.userId
}

/* ================= Supervisor approval (35_approvals.sql) ================= */
/** A supervisor's user ID and password for one action at the till. `verify(u, pw)` does the
 *  action (it checks the supervisor itself: approveSupervisor, or the server for X-Read) and
 *  throws when refused. */
function ApprovalModal({ title, message, verify, onClose }) {
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!u || !pw) return
    setBusy(true); setError('')
    try { await verify(u, pw) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">{title}</h2>
      <Note tone="amber" title="Supervisor approval">{message}</Note>
      <Field label="Supervisor username"><Input value={u} autoFocus autoComplete="off" onChange={e => setU(e.target.value)} /></Field>
      <Field label="Password"><Input type="password" value={pw} autoComplete="new-password" onChange={e => setPw(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()} /></Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !u || !pw} onClick={submit}>{busy ? 'Checking…' : 'Approve'}</Btn>
      </div>
    </Modal>
  )
}

/* ================= Price level (31_price_levels.sql) ================= */
/** The whole sale at Price1..4 instead of the regular price (SellingPrice). An item without that
 *  level stays at its regular price. No approval needed (the user's call, 2026-11-17). */
function PriceLevelModal({ levels, current, line = null, onClose, onApply }) {
  const opts = [{ level: null, name: 'Regular price' }, ...levels]
  // for one line: each level's price for this item (shelfPrice = its selling price)
  const priceOf = (o) => (line ? ` · ₱${peso(o.level ? line.levels[o.level - 1] : line.shelfPrice)}` : '')
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">{line ? `Price for ${line.productName}` : 'Price level for this sale'}</h2>
      <p className="text-sm text-fg2 -mt-2">{line
        ? 'This item only. The rest of the sale keeps its prices.'
        : 'Every item takes this level\'s price. An item without one stays at its regular price.'}</p>
      <div className="space-y-2">
        {opts.map(o => (
          <Btn key={o.level ?? 0} variant={(current || null) === o.level ? 'moss' : 'ghost'} className="w-full"
            onClick={() => onApply(o.level)}>{o.name}{priceOf(o)}</Btn>
        ))}
      </div>
      <Btn className="w-full" onClick={onClose}>Cancel</Btn>
    </Modal>
  )
}

function LoyaltyModal({ settings, current, canUse, onClose, onApply }) {
  const name = settings?.programName || 'Suki card'
  const [code, setCode] = useState('')
  const [card, setCard] = useState(null)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)

  const find = async () => {
    const c = code.trim()
    if (!c) return
    setBusy(true); setError(''); setCard(null); setOffline(false)
    try { setCard(await api(`/api/loyalty/lookup?code=${encodeURIComponent(c)}`)) }
    catch (e) {
      if (!isOnline() || /fetch|network/i.test(e.message)) setOffline(true)
      else setError(e.message)
    } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">{name}</h2>
      {current && !card && (
        <Note tone="green">This sale: {current.customerName || current.cardNo}
          {current.points != null ? `, ${current.points} points` : ' (checked when online)'}</Note>
      )}
      <Field label="Card or mobile number">
        <Input autoFocus value={code} maxLength={50} placeholder="Tap the card on the reader"
          onChange={e => { setCode(e.target.value); setCard(null); setOffline(false) }}
          onKeyDown={e => e.key === 'Enter' && find()} />
      </Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      {card && (
        <div className="bg-raised rounded-2xl border border-line p-4 space-y-1">
          <div className="font-bold">{card.customerName}</div>
          <div className="text-sm text-muted">Card {card.cardNo}{card.isActive ? '' : ' · switched off'}</div>
          <div className="font-display text-3xl font-extrabold tabnum pt-1">{card.points} <span className="text-base font-semibold text-muted">points</span></div>
          <div className="text-xs text-muted">1 point for every ₱{peso(card.amountPerPoint)} paid</div>
        </div>
      )}
      {offline && (
        <Note tone="amber">No connection, so the card can't be checked now. You can still put it on this
          sale: its points are added when the sale is sent.</Note>
      )}
      <div className={`grid gap-3 ${!canUse && (card || offline) ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <Btn onClick={current && !card && !offline ? () => onApply(null) : onClose}>
          {current && !card && !offline ? 'Remove from sale' : 'Close'}</Btn>
        {(card || offline) && !canUse ? null : card || offline ? (
          <Btn variant="primary" disabled={!canUse || (card && !card.isActive)}
            onClick={() => onApply(card
              ? { cardNo: card.cardNo, customerName: card.customerName, points: card.points }
              : { cardNo: code.trim(), customerName: null, points: null })}>
            Use for this sale</Btn>
        ) : (
          <Btn variant="primary" disabled={busy || !code.trim()} onClick={find}>{busy ? 'Checking…' : 'Check'}</Btn>
        )}
      </div>
    </Modal>
  )
}

/* ================= Customer info ================= */
/** BIR: name, address, TIN and business style printed on the sales invoice. Optional —
 *  left blank, the invoice prints lines to fill in by hand. */
function CustomerModal({ current, onClose, onApply }) {
  const [c, setC] = useState({ name: '', address: '', tin: '', businessStyle: '', email: '', ...(current || {}) })
  const [error, setError] = useState('')
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value })
  const clean = {
    name: c.name.trim().slice(0, 150), address: c.address.trim().slice(0, 250),
    tin: c.tin.trim().slice(0, 20), businessStyle: c.businessStyle.trim().slice(0, 150),
    email: c.email.trim().toLowerCase().slice(0, 254)
  }
  const any = Object.values(clean).some(Boolean)
  const save = () => {
    if (clean.email && !looksLikeEmail(clean.email)) return setError('That email address doesn\'t look right.')
    onApply(any ? clean : null)
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Customer on the invoice</h2>
      <Field label="Email for the e-invoice copy">
        <Input type="email" inputMode="email" autoCapitalize="none" autoFocus value={c.email} maxLength={254}
          placeholder="customer@example.com" onChange={set('email')} />
      </Field>
      <p className="text-xs text-muted -mt-2">Not printed. Left blank, the copy goes to the store's records mailbox.</p>
      <Field label="Name"><Input value={c.name} maxLength={150} onChange={set('name')} /></Field>
      <Field label="Address"><Input value={c.address} maxLength={250} onChange={set('address')} /></Field>
      <Field label="TIN"><Input value={c.tin} maxLength={20} onChange={set('tin')} placeholder="000-000-000-00000" /></Field>
      <Field label="Business style"><Input value={c.businessStyle} maxLength={150} onChange={set('businessStyle')} /></Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => onApply(null)}>{current ? 'Remove' : 'Cancel'}</Btn>
        <Btn variant="primary" onClick={save}>Save</Btn>
      </div>
    </Modal>
  )
}

/* ================= Zero-rated sale ================= */
/** A sale to a zero-rated buyer (a PEZA / ecozone enterprise, a diplomat…): 0% VAT, so
 *  VAT-able items sell at their price without the VAT, reported as Zero-Rated Sales; VAT-exempt
 *  items keep their price. Needs the buyer's name, TIN and address (printed on the invoice),
 *  their certificate / ID no., and a supervisor (unless one is signed in). Not with a discount. */
function ZeroRatedModal({ current, customer, hasDiscount, needsOverride, branchCode, onClose, onApply }) {
  const [f, setF] = useState({ name: customer?.name || '', tin: customer?.tin || '', address: customer?.address || '',
    certNo: current?.certNo || '' })
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const clean = { name: f.name.trim().slice(0, 150), tin: f.tin.trim().slice(0, 20),
    address: f.address.trim().slice(0, 250), certNo: f.certNo.trim().slice(0, 50) }
  const complete = clean.name && clean.tin && clean.address && clean.certNo

  const apply = async () => {
    if (!complete) { setError('Enter the buyer\'s name, TIN, address and certificate / ID no.'); return }
    if (!needsOverride) { onApply({ certNo: clean.certNo, approvedBy: null }, clean); return }
    setBusy(true); setError('')
    try {
      if (isOnline()) {
        const r = await api('/api/auth/verify-approver', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) })
        await rememberCredential(u, pw, { userId: r.userId, username: u, fullName: r.fullName, role: r.role, branchCode })
        onApply({ certNo: clean.certNo, approvedBy: r.userId }, clean)
      } else {
        // offline: only a supervisor of this branch who approved/signed in here online before
        const p = await verifyOffline(u, pw)
        if (p.role !== 'Supervisor' || p.branchCode !== branchCode)
          throw new Error(`Needs a supervisor of branch ${branchCode}.`)
        onApply({ certNo: clean.certNo, approvedBy: p.userId }, clean)
      }
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (hasDiscount && !current) return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Zero-rated sale</h2>
      <Note tone="amber">A sale with a discount can't be zero-rated. Remove the discount first.</Note>
      <Btn onClick={onClose}>Back</Btn>
    </Modal>
  )

  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Zero-rated sale</h2>
      <p className="text-sm text-muted">
        For a PEZA / ecozone enterprise, a diplomat or another zero-rated buyer: VAT-able items sell
        at their price without the 12% VAT. VAT-exempt items keep their price.
      </p>
      <Field label="Buyer's name"><Input value={f.name} maxLength={150} autoFocus onChange={set('name')} /></Field>
      <Field label="TIN"><Input value={f.tin} maxLength={20} placeholder="000-000-000-00000" onChange={set('tin')} /></Field>
      <Field label="Address"><Input value={f.address} maxLength={250} onChange={set('address')} /></Field>
      <Field label="Certificate / ID no. (PEZA, BOI, diplomatic ID…)"><Input value={f.certNo} maxLength={50} onChange={set('certNo')} /></Field>
      {needsOverride && (
        <>
          <Note tone="amber" title="Supervisor approval">A supervisor approves every zero-rated sale.</Note>
          <Field label="Supervisor username"><Input value={u} autoComplete="off" onChange={e => setU(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" value={pw} autoComplete="new-password" onChange={e => setPw(e.target.value)} /></Field>
        </>
      )}
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => current ? onApply(null) : onClose()}>{current ? 'Not zero-rated' : 'Cancel'}</Btn>
        <Btn variant="primary" disabled={busy || !complete || (needsOverride && (!u || !pw))} onClick={apply}>
          {busy ? 'Checking…' : 'Apply'}
        </Btn>
      </div>
    </Modal>
  )
}

/* ================= Return transaction ================= */
/** BIR return transaction: find the original invoice by SI No., pick what comes back, see
 *  the refund the server works out (each line's share of what was actually charged for it,
 *  VAT and discount included), then confirm with a reason (and a supervisor, if the branch
 *  requires it). The refund is cash out of this drawer. Online only, like Void: the server
 *  takes the 6-digit return number inside the same transaction, so the sequence has no gaps.
 *  Only invoices issued by this terminal can be looked up here. */
function ReturnModal({ terminalId, shiftUid, ctx, cashier, needsOverride, onClose, onDone }) {
  const [orNumber, setOrNumber] = useState('')
  const [sale, setSale] = useState(null)
  const [qty, setQty] = useState({})          // lineNo -> quantity to return (string while typing)
  const [preview, setPreview] = useState(null)
  const [reason, setReason] = useState('')
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [returnUid] = useState(() => uuid())

  const lines = () => Object.entries(qty)
    .map(([lineNo, q]) => ({ lineNo: Number(lineNo), quantity: Number(q) || 0 }))
    .filter(l => l.quantity > 0)

  const find = async () => {
    if (!orNumber) return
    setBusy(true); setError('')
    try {
      await syncPendingSales()   // the invoice must be on the server to be returned
      const found = await findSaleByOr(terminalId, orNumber, { serverOnly: true })
      if (found.status === 'Voided') throw new Error(`SI ${siNo(orNumber)} is voided — nothing to return.`)
      setSale(found); setQty({})
    } catch (e) {
      setError(e.message || `No sale found with SI No. ${siNo(orNumber)} on this terminal.`)
    } finally { setBusy(false) }
  }

  const request = (extra) => ({
    returnUid, origSaleUid: sale.saleUid, shiftUid, reason, items: lines(), ...extra
  })

  const review = async () => {
    setBusy(true); setError('')
    try {
      setPreview(await api('/api/returns/preview', { method: 'POST', body: JSON.stringify(request({})) }))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const returnDateTime = new Date().toISOString()
      const text = buildReturnReceipt(preview, sale, { ...ctx, cashier }, { returnDateTime, reason })
      const r = await api('/api/returns', {
        method: 'POST',
        body: JSON.stringify(request({
          returnDateTime, expectedNet: preview.header.NetAmount, receiptText: text,
          overrideUsername: needsOverride ? u : null, overridePassword: needsOverride ? p : null
        }))
      })
      const ok = await printText(r.header.ReceiptText, ctx.terminal.PrinterTarget)
      onDone({ text: r.header.ReceiptText, ok, header: r.header })
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (!sale) return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Return</h2>
      <p className="text-sm text-muted">Enter the sales invoice number from the customer's receipt.</p>
      <Field label="Ref SI No.">
        <Input inputMode="numeric" autoFocus value={orNumber} maxLength={18}
          onChange={e => setOrNumber(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && find()} />
      </Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !orNumber} onClick={find}>{busy ? 'Finding…' : 'Find'}</Btn>
      </div>
    </Modal>
  )

  if (!preview) return (
    <Modal onClose={onClose} wide>
      <h2 className="font-bold text-lg">Return from SI {siNo(sale.orNumber)}</h2>
      <p className="text-sm text-muted">Enter how much of each item comes back.</p>
      <div className="divide-y divide-line max-h-[45vh] overflow-y-auto">
        {sale.items.map(l => {
          const left = round2(Number(l.quantity) - Number(l.returnedQty || 0))
          return (
            <div key={l.lineNo} className="py-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{l.productName}</p>
                <p className="text-xs text-muted tabnum">
                  sold {Number(l.quantity)} @ ₱{peso(l.unitPrice)}
                  {Number(l.returnedQty) > 0 && ` · ${Number(l.returnedQty)} already returned`}
                </p>
              </div>
              {left > 0 ? (
                <>
                  <Input inputMode="decimal" className="!w-20 text-right" value={qty[l.lineNo] ?? ''}
                    placeholder="0"
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d.]/g, '')
                      setQty({ ...qty, [l.lineNo]: Number(v) > left ? String(left) : v })
                    }} />
                  <Btn className="!min-h-[36px] !px-2 text-xs" onClick={() => setQty({ ...qty, [l.lineNo]: String(left) })}>All</Btn>
                </>
              ) : <span className="text-xs text-muted">fully returned</span>}
            </div>
          )
        })}
      </div>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => { setSale(null); setError('') }}>Back</Btn>
        <Btn variant="primary" disabled={busy || !lines().length} onClick={review}>
          {busy ? 'Working…' : 'Review refund'}
        </Btn>
      </div>
    </Modal>
  )

  const h = preview.header
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Refund ₱{peso(h.NetAmount)}</h2>
      <div className="text-sm space-y-1 tabnum">
        {preview.items.map(l => (
          <div key={l.LineNo} className="flex justify-between gap-2">
            <span className="truncate">{Number(l.Quantity)} × {l.ProductName}</span>
            <span>₱{peso(l.NetAmount)}</span>
          </div>
        ))}
        {Number(h.DiscountAmount) > 0 && (
          <p className="text-xs text-muted">
            Gross ₱{peso(h.GrossAmount)} less the {sale.discountCode} discount ₱{peso(h.DiscountAmount)} given on the sale.
          </p>
        )}
      </div>
      {needsOverride
        ? <Note tone="amber" title="Supervisor override required">
            This branch requires an override for returns. Change it in Admin → POS Settings.
          </Note>
        : <Note tone="green" title="Override not required">
            The return is still recorded in the audit log with your name and reason.
          </Note>}
      {needsOverride && (
        <>
          <Field label="Supervisor username"><Input value={u} onChange={e => setU(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" value={p} onChange={e => setP(e.target.value)} /></Field>
        </>
      )}
      <Field label="Reason"><Input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} /></Field>
      <ErrorBar message={error} onDismiss={() => setError('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={() => { setPreview(null); setError('') }}>Back</Btn>
        <Btn variant="primary" disabled={busy || !reason.trim() || (needsOverride && (!u || !p))} onClick={submit}>
          {busy ? 'Processing…' : 'Refund & print'}
        </Btn>
      </div>
    </Modal>
  )
}

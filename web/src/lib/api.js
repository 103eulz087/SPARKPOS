import Dexie from 'dexie'
import { round2 } from './store'

/** crypto.randomUUID() only exists in secure contexts (HTTPS/localhost); tablets
 *  hitting the POS over a plain-HTTP LAN address need a fallback. */
export function uuid() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = typeof crypto?.getRandomValues === 'function'
    ? crypto.getRandomValues(new Uint8Array(16))
    : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

/* ==========================================================
   Offline store (IndexedDB via Dexie)
   Sales are written here FIRST, then synced. A dropped Wi-Fi
   connection, a browser crash, or a dead battery loses nothing.
   ========================================================== */
class PosDb extends Dexie {
  constructor() {
    super('TabletPOS')
    this.version(1).stores({
      products: 'productId, barcode, productName, categoryId',
      pendingSales: 'saleUid, syncStatus, shiftUid',
      meta: 'key'
    })
    // Dine-in tables & open orders (Restaurant PosType) — added so dine-in can go
    // local-first like sales already do. Purely additive: no upgrade() needed since
    // nothing in v1's stores changes shape.
    this.version(2).stores({
      products: 'productId, barcode, productName, categoryId',
      pendingSales: 'saleUid, syncStatus, shiftUid',
      meta: 'key',
      tables: 'TableId, BranchCode',
      openOrders: 'OpenOrderUid, TableId, Status, syncStatus'
    })
    // v2's "tables" store name collides with Dexie's own built-in db.tables property (an
    // array of every Table object on the instance) — db.tables silently resolved to that
    // array instead of the custom store, breaking every .where()/.bulkPut() call on it.
    // Renamed to posTables; v2's store is dropped (tables: null) since nothing shipped yet.
    this.version(3).stores({
      products: 'productId, barcode, productName, categoryId',
      pendingSales: 'saleUid, syncStatus, shiftUid',
      meta: 'key',
      tables: null,
      posTables: 'TableId, BranchCode',
      openOrders: 'OpenOrderUid, TableId, Status, syncStatus'
    })
  }
}
export const db = new PosDb()

export const getMeta = async (k) => (await db.meta.get(k))?.value ?? null
export const setMeta = (k, value) => db.meta.put({ key: k, value })

/** Consume the next OR number from the locally-held block. */
export async function nextORNumber() {
  const next = Number(await getMeta('or_next'))
  const end = Number(await getMeta('or_end'))
  if (!next || !end || next > end)
    throw new Error('OR number range exhausted. Reconnect to allocate a new block.')
  await setMeta('or_next', String(next + 1))
  return next
}
export async function orRemaining() {
  const next = Number(await getMeta('or_next'))
  const end = Number(await getMeta('or_end'))
  return !next || !end ? 0 : Math.max(0, end - next + 1)
}

/* ==========================================================
   API client
   ========================================================== */
export const getToken = () => localStorage.getItem('pos_token')

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {})
    }
  })
  if (res.status === 401) {
    localStorage.removeItem('pos_token')
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    const body = await res.text()
    let msg = body
    try { msg = JSON.parse(body).message ?? body } catch { /* raw text */ }
    throw new Error(msg || `Request failed (${res.status})`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const isOnline = () => navigator.onLine

/** Uploads a product thumbnail; returns { imageUrl }. */
export async function uploadProductImage(file) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/products/image', {
    method: 'POST',
    headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: fd
  })
  if (!res.ok) {
    const body = await res.text()
    let msg = body
    try { msg = JSON.parse(body).message ?? body } catch { /* raw text */ }
    throw new Error(msg || `Upload failed (${res.status})`)
  }
  return res.json()
}

/* ---------- Catalog: pull this branch's effective price list ---------- */
export async function pullPriceList(branchCode) {
  const rows = await api(`/api/products/pricelist/${branchCode}`)
  const products = rows.map(r => ({
    productId: r.ProductId, barcode: r.Barcode, productName: r.ProductName,
    categoryId: r.CategoryId, categoryName: r.CategoryName, unit: r.Unit,
    price: Number(r.Price), basePrice: Number(r.BasePrice), hasOverride: !!r.HasOverride,
    isVatable: !!r.IsVatable, isDiscountable: !!r.IsDiscountable,
    allowPriceEdit: !!r.AllowPriceEdit, imageUrl: r.ImageUrl || null
  }))
  await db.products.clear()
  await db.products.bulkPut(products)
  await setMeta('catalog_branch', branchCode)
  await setMeta('catalog_pulled_at', new Date().toISOString())
  return products.length
}

/* ==========================================================
   Dine-in tables & orders (Restaurant PosType) — local-first, same
   trust model as sales: every mutation lands in IndexedDB first and
   syncs in the background via a whole-order snapshot replace. This
   assumes a single terminal serves a given branch's dine-in tables
   at a time (see CLAUDE.md) — there is no cross-device conflict
   handling if that assumption doesn't hold.
   ========================================================== */

export async function pullTables(branchCode) {
  const rows = await api(`/api/tables?branchCode=${branchCode}`)
  await db.posTables.where('BranchCode').equals(branchCode).delete()
  await db.posTables.bulkPut(rows)
  return rows.length
}

/** Local openOrders rows store the order header fields flat (PascalCase, matching the
 *  server's shape) plus an embedded items array, so this just splits sync-only fields
 *  back out into the {order, items} shape the rest of the app already expects. */
function toActiveOrder(row) {
  const { items, syncStatus, syncError, ...order } = row
  return { order, items }
}

const markDirty = (row) => ({ ...row, syncStatus: row.syncStatus === 'synced' ? 'pending' : row.syncStatus })

/** Tables for the grid, merged with any locally-open orders. Local state is always at
 *  least as fresh as the cached table list (which only refreshes at Cash Begin), so a
 *  locally opened/edited order overrides the occupied/item-count display — this is what
 *  makes the grid correct offline, and just as correct online since nothing here waits
 *  on the network. A table only counts as occupied once its order actually has items —
 *  opening a table (or emptying one back to zero) leaves an Open row with nothing on it,
 *  and showing that as occupied would just confuse whoever's looking at the grid (mirrors
 *  the same rule TablesController.Get() enforced server-side before dine-in went local-first). */
export async function loadLocalTables(branchCode) {
  const cached = await db.posTables.where('BranchCode').equals(branchCode).sortBy('TableNumber')
  const localOrders = await db.openOrders.where('Status').equals('Open').toArray()
  const byTable = new Map(localOrders.map(o => [o.TableId, o]))
  return cached.map(t => {
    const o = byTable.get(t.TableId)
    return (o && o.items.length > 0)
      ? { ...t, OpenOrderUid: o.OpenOrderUid, OpenedAt: o.OpenedAt, ItemCount: o.items.length } : t
  })
}

/** Resumes a table's local open order if one's already cached (works offline, and is
 *  instant either way). Otherwise, if online, asks the server to resume-or-create one —
 *  covers a table opened by an earlier session this device hasn't cached — and caches
 *  the result. If offline and nothing local exists yet, opens a brand-new local-only
 *  order outright; it syncs once reconnected. */
export async function openLocalOrder({ tableId, tableNumber, branchCode, terminalId, shiftUid, userId }) {
  const existing = (await db.openOrders.where('TableId').equals(tableId).toArray())
    .find(o => o.Status === 'Open')
  if (existing) return toActiveOrder(existing)

  if (isOnline()) {
    try {
      const result = await api('/api/orders/open', {
        method: 'POST', body: JSON.stringify({ tableId, terminalId, shiftUid })
      })
      const row = { ...result.order, items: result.items, syncStatus: 'synced' }
      await db.openOrders.put(row)
      return toActiveOrder(row)
    } catch { /* server unreachable despite navigator.onLine — fall through to local-only */ }
  }

  const row = {
    OpenOrderUid: uuid(), TableId: tableId, TableNumber: tableNumber, BranchCode: branchCode,
    TerminalId: terminalId, ShiftUid: shiftUid, OpenedByUserId: userId,
    OpenedAt: new Date().toISOString(), Status: 'Open', ClosedAt: null, SaleUid: null,
    items: [], syncStatus: 'pending'
  }
  await db.openOrders.put(row)
  return toActiveOrder(row)
}

/** Mirrors the retail cart's merge-on-tap: tapping a product already on the tab at the
 *  same price increments its quantity instead of adding a new line. */
export async function addLocalOrderItem(openOrderUid, p) {
  const row = await db.openOrders.get(openOrderUid)
  const items = [...row.items]
  const ix = items.findIndex(i => i.ProductId === p.productId && i.UnitPrice === p.price)
  if (ix >= 0) items[ix] = { ...items[ix], Quantity: round2(items[ix].Quantity + 1) }
  else {
    const nextLine = items.length ? Math.max(...items.map(i => i.LineNo)) + 1 : 1
    items.push({
      LineNo: nextLine, ProductId: p.productId, Barcode: p.barcode, ProductName: p.productName,
      CategoryId: p.categoryId, Quantity: 1, UnitPrice: p.price,
      IsVatable: p.isVatable, IsDiscountable: p.isDiscountable
    })
  }
  const updated = markDirty({ ...row, items })
  await db.openOrders.put(updated)
  return toActiveOrder(updated)
}

/** Sets a line's quantity — qty <= 0 removes it, mirroring the retail cart's setQty. */
export async function setLocalOrderItemQty(openOrderUid, lineNo, qty) {
  const row = await db.openOrders.get(openOrderUid)
  const items = qty <= 0
    ? row.items.filter(i => i.LineNo !== lineNo)
    : row.items.map(i => i.LineNo === lineNo ? { ...i, Quantity: round2(qty) } : i)
  const updated = markDirty({ ...row, items })
  await db.openOrders.put(updated)
  return toActiveOrder(updated)
}

export async function voidLocalOrder(openOrderUid) {
  const row = await db.openOrders.get(openOrderUid)
  if (!row) return
  await db.openOrders.put(markDirty({ ...row, Status: 'Voided', ClosedAt: new Date().toISOString() }))
}

/** Called right after completeSale() queues the sale locally — marks the tab billed and
 *  links the sale. Purely local; syncPendingOrders() carries this to the server whenever
 *  it next runs, same as the sale itself. */
export async function closeLocalOrder(openOrderUid, saleUid) {
  const row = await db.openOrders.get(openOrderUid)
  if (!row) return
  await db.openOrders.put(markDirty({ ...row, Status: 'Billed', ClosedAt: new Date().toISOString(), SaleUid: saleUid }))
}

let syncingOrders = false

export async function syncPendingOrders() {
  if (syncingOrders || !isOnline()) return { synced: 0, failed: 0 }
  syncingOrders = true
  try {
    const pending = await db.openOrders.where('syncStatus').anyOf('pending', 'error').toArray()
    if (!pending.length) return { synced: 0, failed: 0 }

    const results = await api('/api/orders/sync', {
      method: 'POST',
      body: JSON.stringify({
        orders: pending.map(({ items, syncStatus, syncError, ...order }) => ({ ...order, items }))
      })
    })

    let synced = 0, failed = 0
    for (const r of results) {
      if (r.status === 'synced') { await db.openOrders.update(r.openOrderUid, { syncStatus: 'synced' }); synced++ }
      else { await db.openOrders.update(r.openOrderUid, { syncStatus: 'error', syncError: r.message }); failed++ }
    }
    return { synced, failed }
  } finally { syncingOrders = false }
}

export const pendingOrderCount = () =>
  db.openOrders.where('syncStatus').anyOf('pending', 'error').count()

/** Server rows use PascalCase column names in a nested {sale, items, payments} shape;
 *  local pendingSales rows are already flat camelCase (built by completeSale). Normalizing
 *  to the local shape means buildReceipt() works the same regardless of where a sale came
 *  from. */
function normalizeServerSale(r) {
  const s = r.sale
  return {
    saleUid: s.SaleUid, shiftUid: s.ShiftUid, branchCode: s.BranchCode, terminalId: s.TerminalId,
    orNumber: s.ORNumber, businessDate: s.BusinessDate, saleDateTime: s.SaleDateTime,
    grossAmount: s.GrossAmount, discountAmount: s.DiscountAmount, vatExemptAmount: s.VatExemptAmount,
    vatableAmount: s.VatableAmount, vatAmount: s.VatAmount, zeroRatedAmount: s.ZeroRatedAmount,
    netAmount: s.NetAmount, tenderedAmount: s.TenderedAmount, changeAmount: s.ChangeAmount,
    discountCode: s.DiscountCode, discountCtrlNo: s.DiscountCtrlNo, discountName: s.DiscountName,
    status: s.Status,
    items: r.items.map(i => ({
      lineNo: i.LineNo, productId: i.ProductId, barcode: i.Barcode, productName: i.ProductName,
      categoryId: i.CategoryId, quantity: i.Quantity, unitPrice: i.UnitPrice,
      origUnitPrice: i.OrigUnitPrice, lineDiscount: i.LineDiscount, lineTotal: i.LineTotal,
      isVatable: i.IsVatable, isDiscountable: i.IsDiscountable
    })),
    payments: r.payments.map(p => ({
      seqNo: p.SeqNo, paymentType: p.PaymentType, amount: p.Amount,
      cardNo: p.CardNo, cardBank: p.CardBank, cardRefNo: p.CardRefNo, cardName: p.CardName
    }))
  }
}

/** Finds a sale by OR number for Void/Reprint. Checks the local offline queue first (works
 *  without a connection, covers a sale made moments ago that hasn't synced yet), then falls
 *  back to the server (covers older/already-synced sales — requires connectivity). Throws if
 *  not found either way. */
export async function findSaleByOr(terminalId, orNumber) {
  const n = Number(orNumber)
  const local = await db.pendingSales
    .filter(s => s.terminalId === terminalId && Number(s.orNumber) === n)
    .first()
  if (local) return local
  const r = await api(`/api/sales/by-or/${terminalId}/${n}`)
  return normalizeServerSale(r)
}

export async function allocateOrRange(terminalId, blockSize = 500) {
  const r = await api(`/api/terminals/${terminalId}/allocate-or-range?blockSize=${blockSize}`, { method: 'POST' })
  await setMeta('or_next', String(r.RangeStart))
  await setMeta('or_end', String(r.RangeEnd))
  return r
}

/* ==========================================================
   Sync engine — idempotent, retryable, never blocks the sale
   ========================================================== */
let syncing = false

export async function syncPendingSales() {
  if (syncing || !isOnline()) return { synced: 0, failed: 0 }
  syncing = true
  try {
    const pending = await db.pendingSales.where('syncStatus').anyOf('pending', 'error').toArray()
    if (!pending.length) return { synced: 0, failed: 0 }

    const results = await api('/api/sales/sync', {
      method: 'POST',
      body: JSON.stringify({ sales: pending.map(stripLocalFields) })
    })

    let synced = 0, failed = 0
    for (const r of results) {
      if (r.status === 'synced') { await db.pendingSales.update(r.saleUid, { syncStatus: 'synced' }); synced++ }
      else { await db.pendingSales.update(r.saleUid, { syncStatus: 'error', syncError: r.message }); failed++ }
    }
    // keep IndexedDB lean: drop synced rows older than 7 days
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString()
    await db.pendingSales.where('syncStatus').equals('synced')
      .and(s => s.saleDateTime < cutoff).delete()
    return { synced, failed }
  } finally { syncing = false }
}

function stripLocalFields(s) {
  const { syncStatus, syncError, ...rest } = s
  return rest
}

export function startSyncLoop(onChange) {
  const run = () => Promise.all([syncPendingSales(), syncPendingOrders()])
    .then(([sales, orders]) => {
      const synced = sales.synced + orders.synced, failed = sales.failed + orders.failed
      if (synced || failed) onChange?.({ synced, failed })
    }).catch(() => {})
  window.addEventListener('online', run)
  const id = setInterval(run, 20000)
  run()
  return () => { clearInterval(id); window.removeEventListener('online', run) }
}

export const pendingCount = () =>
  db.pendingSales.where('syncStatus').anyOf('pending', 'error').count()

/* ==========================================================
   Printing — try the local agent first, then the server relay,
   or hand off to RawBT for a terminal with an embedded printer
   ========================================================== */

/** Trailing '=' padding stripped: reproducibly, receipts whose base64 ends in "=="
 *  (item name length pushes total bytes to a %3==1 remainder) fail with RawBT's
 *  "wrong data to print", while "=" or no padding succeeds — confirmed across two
 *  independent product-name pairs, order-independent. Padding is only needed when
 *  concatenating base64 strings; a standalone, fully-terminated string like this one
 *  decodes fine without it. */
function bytesToBase64(bytes) {
  let binary = ''
  bytes.forEach(b => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/=+$/, '')
}

/** Same framing the PrintAgent applies server-side (ESC @ init, feed, partial cut) —
 *  kept identical so a receipt looks the same regardless of which path printed it. */
function buildEscPos(text) {
  const body = new TextEncoder().encode(text)
  const bytes = new Uint8Array(2 + body.length + 4 + 4)
  bytes.set([0x1b, 0x40], 0)                     // ESC @  initialise
  bytes.set(body, 2)
  bytes.set([0x0a, 0x0a, 0x0a, 0x0a], 2 + body.length)          // feed
  bytes.set([0x1d, 0x56, 0x42, 0x00], 2 + body.length + 4)      // GS V B  partial cut
  return bytes
}

/** RawBT (installed on the terminal) bridges the browser to its embedded Bluetooth
 *  thermal printer — Chrome has no direct hardware access. This only works from the
 *  browser running ON that device; there is no return channel confirming the paper
 *  actually printed, only that the handoff to RawBT happened.
 *
 *  REVERTED from a plain-text `rawbt:<text>` attempt — that was a guess at RawBT's URL
 *  syntax (based on indirect evidence: its Settings screen has its own document
 *  header/footer/cut options), never confirmed against real documentation, and it broke
 *  printing completely rather than improving it. This base64 ESC/POS form is the one with
 *  actual confirmed successful prints. It is not fully reliable either (three different,
 *  still not fully explained "wrong data to print" failures across testing) — but do not
 *  swap the URL format again without verifying the exact syntax RawBT expects first. */
function printViaRawBt(text) {
  const data = encodeURIComponent(bytesToBase64(buildEscPos(text)))
  window.location.href = `rawbt:base64,${data}`
  return true
}

export async function printText(text, target) {
  if (target && target.startsWith('rawbt')) return printViaRawBt(text)

  try {
    const res = await fetch('http://localhost:5099/print', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target })
    })
    if (res.ok) return true
  } catch { /* agent not reachable from the browser */ }
  try {
    const r = await api('/api/print', { method: 'POST', body: JSON.stringify({ text, target }) })
    return !!r.printed
  } catch { return false }
}

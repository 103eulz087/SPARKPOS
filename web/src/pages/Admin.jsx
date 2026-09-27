import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, uploadProductImage } from '../lib/api'
import { peso, useAuth } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Modal, Note, Paper, Select, Spinner, Table, Textarea, Toast } from '../components/Ui'

const today = () => new Date().toISOString().slice(0, 10)
const TABS = ['Dashboard', 'Branches', 'Products', 'Price Lists', 'Categories', 'Discounts', 'Users',
  'Terminals', 'Tables', 'Print Areas', 'POS Settings', 'Email', 'Closings', 'Z-Read / EOD', 'Reports']

export default function Admin() {
  const nav = useNavigate()
  const { fullName, role, branchCode, branches, setBranch, logout } = useAuth()
  const [tab, setTab] = useState('Dashboard')
  const [scope, setScope] = useState(branchCode)   // 'ALL' or a branch code
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2600) }
  const branchFilter = scope === 'ALL' ? null : scope

  if (role !== 'Admin' && role !== 'Supervisor') return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <p className="text-stone-600">Admin access requires a Supervisor or Admin account.</p>
        <Btn onClick={() => nav('/cash-begin')}>Back to POS</Btn>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-stone-900 text-white px-3 py-2 flex items-center gap-2 text-sm flex-wrap shrink-0">
        <span className="font-bold">SparkPOS Admin</span>
        <span className="text-white/50">{fullName} · {role}</span>
        <select className="bg-white/10 rounded px-2 py-1 text-white text-xs" value={scope}
          onChange={e => { setScope(e.target.value); if (e.target.value !== 'ALL') setBranch(e.target.value) }}>
          <option value="ALL" className="text-stone-900">All branches</option>
          {branches.map(b => <option key={b} value={b} className="text-stone-900">{b}</option>)}
        </select>
        <button className="ml-auto underline text-white/70" onClick={() => nav('/cash-begin')}>Open POS</button>
        <button className="underline text-white/70" onClick={() => { logout(); nav('/login') }}>Sign out</button>
      </header>

      <div className="flex gap-2 p-3 overflow-x-auto shrink-0">
        {TABS.map(t => (
          <Btn key={t} variant={tab === t ? 'moss' : 'ghost'} className="whitespace-nowrap !min-h-[40px] text-sm"
            onClick={() => setTab(t)}>{t}</Btn>
        ))}
      </div>

      <div className="flex-1 p-3 pt-0">
        {tab === 'Dashboard' && <Dashboard branchFilter={branchFilter} />}
        {tab === 'Branches' && <Branches flash={flash} />}
        {tab === 'Products' && <Products flash={flash} />}
        {tab === 'Price Lists' && <PriceLists flash={flash} />}
        {tab === 'Categories' && <Categories scope={scope} flash={flash} />}
        {tab === 'Discounts' && <Discounts flash={flash} />}
        {tab === 'Users' && <Users flash={flash} />}
        {tab === 'Terminals' && <Terminals flash={flash} />}
        {tab === 'Tables' && <Tables scope={scope} flash={flash} />}
        {tab === 'Print Areas' && <PrintAreas scope={scope} flash={flash} />}
        {tab === 'POS Settings' && <SettingsTab scope={scope} flash={flash} />}
        {tab === 'Email' && <EmailTab />}
        {tab === 'Closings' && <Closings branchFilter={branchFilter} />}
        {tab === 'Z-Read / EOD' && <ZReadTab branchFilter={branchFilter} flash={flash} />}
        {tab === 'Reports' && <Reports branchFilter={branchFilter} />}
      </div>
      <Toast message={toast} />
    </div>
  )
}

/* ---------- helpers ---------- */
function useApi(path, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setError('')
    api(path).then(d => alive && setData(d)).catch(e => alive && setError(e.message))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps])
  return { data, error, reload: () => setNonce(n => n + 1) }
}

const DateRange = ({ from, to, setFrom, setTo, onLoad, children }) => (
  <div className="flex gap-2 items-center flex-wrap mb-3">
    <Input type="date" className="!w-auto" value={from} onChange={e => setFrom(e.target.value)} />
    <span className="text-stone-400">to</span>
    <Input type="date" className="!w-auto" value={to} onChange={e => setTo(e.target.value)} />
    {children}
    <Btn variant="dark" onClick={onLoad}>Load</Btn>
  </div>
)

/* ================= Dashboard ================= */
function Dashboard({ branchFilter }) {
  const path = `/api/reports/dashboard?businessDate=${today()}` + (branchFilter ? `&branchCode=${branchFilter}` : '')
  const { data, error } = useApi(path, [branchFilter])
  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />

  const bars = data.last7 || []
  const max = Math.max(1, ...bars.map(b => Number(b.NetSales)))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label={branchFilter ? `Net sales — ${branchFilter}` : 'Net sales — all branches'}
          value={`₱${peso(data.today.NetSales)}`} sub={`${data.today.TxnCount} transactions`} />
        <Stat label="Open shifts" value={String(data.openShifts.OpenShifts)} />
        <Stat label="Branches reporting" value={String((data.byBranch || []).length)} />
        <Stat label="Business date" value={today()} />
      </div>

      <div className="grid lg:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 shadow">
          <div className="text-sm font-semibold mb-3">Net sales — last 7 days</div>
          <div className="flex items-end gap-2 h-36">
            {bars.length === 0 && <p className="text-stone-400 text-sm">No sales recorded yet.</p>}
            {bars.map((b, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full bg-emerald-800 rounded-t"
                  style={{ height: `${(Number(b.NetSales) / max) * 100}%` }} />
                <span className="text-[10px] text-stone-500">{String(b.BusinessDate).slice(5, 10)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">Branch performance today</h3>
          <Table head={['Branch', 'Txns', 'Net sales']}
            rows={(data.byBranch || []).map(b => [b.BranchCode, b.TxnCount, peso(b.NetSales)])}
            empty="No sales today." />
        </div>
      </div>
    </div>
  )
}

const Stat = ({ label, value, sub }) => (
  <div className="bg-white rounded-xl p-4 shadow">
    <div className="text-[10px] tracking-[0.25em] uppercase text-stone-400">{label}</div>
    <div className="tabnum text-2xl font-bold mt-1">{value}</div>
    {sub && <div className="text-xs text-stone-500 mt-0.5">{sub}</div>}
  </div>
)

/* ================= Branches ================= */
function Branches({ flash }) {
  const { data, error, reload } = useApi('/api/branches')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.isNew) await api('/api/branches', { method: 'POST', body })
      else await api(`/api/branches/${edit.branchCode}`, { method: 'PUT', body })
      setEdit(null); reload(); flash('Branch saved')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />

  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({
        isNew: true, branchCode: '', branchName: '', tin: '', birBranchCode: '',
        address: '', contactNo: '', isActive: true })}>Add branch</Btn>
      <Table head={['Code', 'Branch name', 'TIN', 'BIR code', 'Address', 'Terminals', 'Active', '']}
        rows={data.map(b => [b.BranchCode, b.BranchName, b.Tin || '—', b.BirBranchCode || '—',
          b.Address || '—', b.TerminalCount, b.IsActive ? 'Yes' : 'No',
          <button key={b.BranchCode} className="underline text-emerald-800" onClick={() => setEdit({
            branchCode: b.BranchCode, branchName: b.BranchName, tin: b.Tin, birBranchCode: b.BirBranchCode,
            address: b.Address, contactNo: b.ContactNo, isActive: b.IsActive })}>Edit</button>])} />
      <Note tone="green" title="Why every table carries BranchCode">
        Sales, shifts, OR ranges, Z-Reads, prices and audit logs are all tagged by branch. Each branch
        runs independently — its own OR series, its own End of Day, its own BIR permits — while head
        office reads one consolidated database. Adding a branch needs no schema change.
      </Note>
      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.isNew ? 'New branch' : `Edit ${edit.branchCode}`}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch code"><Input value={edit.branchCode} disabled={!edit.isNew}
              onChange={e => setEdit({ ...edit, branchCode: e.target.value.toUpperCase() })} /></Field>
            <Field label="Branch name"><Input value={edit.branchName || ''}
              onChange={e => setEdit({ ...edit, branchName: e.target.value })} /></Field>
            <Field label="TIN"><Input value={edit.tin || ''}
              onChange={e => setEdit({ ...edit, tin: e.target.value })} /></Field>
            <Field label="BIR branch code"><Input value={edit.birBranchCode || ''}
              onChange={e => setEdit({ ...edit, birBranchCode: e.target.value })} /></Field>
            <Field label="Address"><Input value={edit.address || ''}
              onChange={e => setEdit({ ...edit, address: e.target.value })} /></Field>
            <Field label="Contact number"><Input value={edit.contactNo || ''}
              onChange={e => setEdit({ ...edit, contactNo: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive}
              onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= Products ================= */
function Products({ flash }) {
  const { data, error, reload } = useApi('/api/products')
  const { data: cats } = useApi('/api/products/categories')
  const [edit, setEdit] = useState(null)
  const [prices, setPrices] = useState(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [uploading, setUploading] = useState(false)

  const pickImage = async (file) => {
    if (!file) return
    setUploading(true); setErr('')
    try {
      const { imageUrl } = await uploadProductImage(file)
      setEdit(e => ({ ...e, imageUrl }))
    } catch (e) { setErr(e.message) } finally { setUploading(false) }
  }

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.productId) await api(`/api/products/${edit.productId}`, { method: 'PUT', body })
      else await api('/api/products', { method: 'POST', body })
      setEdit(null); reload(); flash('Product saved')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data || !cats) return <Spinner />

  const rows = data.filter(p => !q ||
    p.ProductName.toLowerCase().includes(q.toLowerCase()) || p.Barcode.includes(q))

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <Btn variant="primary" onClick={() => setEdit({
          productId: 0, barcode: '', productName: '', categoryId: cats[0]?.CategoryId || 1,
          unit: 'kg', basePrice: 0, cost: 0, isVatable: true, isDiscountable: true,
          allowPriceEdit: false, isActive: true, imageUrl: '' })}>Add product</Btn>
        <Input className="!w-64" placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <Table head={['', 'Barcode', 'Name', 'Category', 'Unit', 'Base price', 'Branch overrides',
        'VATable', 'Discountable', 'Price edit', 'Active', '']}
        rows={rows.map(p => [
          p.ImageUrl
            ? <img key={'t' + p.ProductId} src={p.ImageUrl} alt="" className="w-9 h-9 rounded-lg object-cover border border-stone-200" />
            : <div key={'t' + p.ProductId} className="w-9 h-9 rounded-lg bg-stone-100 border border-stone-200" />,
          p.Barcode, p.ProductName, p.CategoryName, p.Unit, peso(p.BasePrice),
          <button key={'o' + p.ProductId} className="underline text-emerald-800"
            onClick={() => setPrices(p)}>
            {p.OverrideCount === 0 ? 'none — uses base' : `${p.OverrideCount} branch${p.OverrideCount > 1 ? 'es' : ''}`}
          </button>,
          p.IsVatable ? 'Yes' : 'No',
          <span key={'d' + p.ProductId} className={p.IsDiscountable ? 'text-emerald-800 font-semibold' : 'text-stone-400'}>
            {p.IsDiscountable ? 'Yes' : 'No'}
          </span>,
          p.AllowPriceEdit ? 'Allowed' : 'Locked',
          p.IsActive ? 'Yes' : 'No',
          <button key={p.ProductId} className="underline text-emerald-800" onClick={() => setEdit({
            productId: p.ProductId, barcode: p.Barcode, productName: p.ProductName,
            categoryId: p.CategoryId, unit: p.Unit, basePrice: p.BasePrice, cost: p.Cost,
            isVatable: p.IsVatable, isDiscountable: p.IsDiscountable,
            allowPriceEdit: p.AllowPriceEdit, isActive: p.IsActive, imageUrl: p.ImageUrl || '' })}>Edit</button>
        ])} />

      <Note tone="green" title="One base price, overrides only where needed">
        A product carries a single base price. A branch row exists only when that branch charges
        something different, so 30 branches does not mean 30 fields — most products have none.
        The POS resolves price as: branch override if one exists, otherwise base.
      </Note>

      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.productId ? 'Edit product' : 'New product'}</h2>
          <div className="flex items-center gap-4">
            {edit.imageUrl
              ? <img src={edit.imageUrl} alt="" className="w-20 h-20 rounded-xl object-cover border border-stone-200" />
              : <div className="w-20 h-20 rounded-xl bg-stone-100 border border-stone-200 flex items-center justify-center text-stone-400 text-xs text-center px-1">
                  No image
                </div>}
            <div className="space-y-1">
              <label className="inline-block">
                <span className={`select-none rounded-lg font-semibold min-h-[46px] px-4 inline-flex items-center bg-white border border-stone-300 text-stone-900 cursor-pointer ${uploading ? 'opacity-40' : ''}`}>
                  {uploading ? 'Uploading…' : edit.imageUrl ? 'Change photo' : 'Upload photo'}
                </span>
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={uploading}
                  onChange={e => pickImage(e.target.files?.[0])} />
              </label>
              {edit.imageUrl && (
                <button type="button" className="block text-xs underline text-stone-500"
                  onClick={() => setEdit({ ...edit, imageUrl: '' })}>Remove photo</button>
              )}
              <p className="text-xs text-stone-400">JPG, PNG or WEBP, up to 2MB. Shown as the thumbnail on the POS grid.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Barcode"><Input value={edit.barcode}
              onChange={e => setEdit({ ...edit, barcode: e.target.value })} /></Field>
            <Field label="Product name"><Input value={edit.productName}
              onChange={e => setEdit({ ...edit, productName: e.target.value })} /></Field>
            <Field label="Category">
              <Select className="w-full" value={edit.categoryId}
                onChange={e => setEdit({ ...edit, categoryId: Number(e.target.value) })}>
                {cats.map(c => <option key={c.CategoryId} value={c.CategoryId}>{c.CategoryName}</option>)}
              </Select>
            </Field>
            <Field label="Unit">
              <Select className="w-full" value={edit.unit} onChange={e => setEdit({ ...edit, unit: e.target.value })}>
                {['kg', 'pc', 'pack', 'box', 'litre'].map(u => <option key={u}>{u}</option>)}
              </Select>
            </Field>
            <Field label="Base price (all branches)">
              <Input className="text-right tabnum" inputMode="decimal" value={edit.basePrice}
                onChange={e => setEdit({ ...edit, basePrice: Number(e.target.value) || 0 })} /></Field>
            <Field label="Cost">
              <Input className="text-right tabnum" inputMode="decimal" value={edit.cost}
                onChange={e => setEdit({ ...edit, cost: Number(e.target.value) || 0 })} /></Field>
          </div>
          <div className="flex gap-5 text-sm flex-wrap border-t border-stone-100 pt-3">
            {[['isVatable', 'VATable', '12% applies'],
              ['isDiscountable', 'Discountable', 'eligible for SC/PWD/NAAC/MOV/Solo'],
              ['allowPriceEdit', 'Price editable', 'at the POS'],
              ['isActive', 'Active', '']].map(([k, label, hint]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={edit[k]}
                  onChange={e => setEdit({ ...edit, [k]: e.target.checked })} />
                <span><strong>{label}</strong>{hint && <span className="text-stone-500"> — {hint}</span>}</span>
              </label>
            ))}
          </div>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className={`grid ${edit.productId ? 'grid-cols-3' : 'grid-cols-2'} gap-3`}>
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            {edit.productId > 0 && (
              <Btn onClick={() => { setPrices(data.find(p => p.ProductId === edit.productId)); setEdit(null) }}>
                Branch prices…
              </Btn>
            )}
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}

      {prices && <BranchPriceModal product={prices} onClose={() => { setPrices(null); reload() }} flash={flash} />}
    </div>
  )
}

function BranchPriceModal({ product, onClose, flash }) {
  const { data: branches } = useApi('/api/branches')
  const { data: existing } = useApi(`/api/products/${product.ProductId}/prices`)
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (existing) setRows(existing.map(r => ({ branchCode: r.BranchCode, price: String(r.Price) })))
  }, [existing])

  if (!branches || !rows) return <Modal onClose={onClose}><Spinner /></Modal>

  const unused = branches.filter(b => b.IsActive && !rows.some(r => r.branchCode === b.BranchCode))

  const save = async () => {
    try {
      await api(`/api/products/${product.ProductId}/prices`, {
        method: 'PUT',
        body: JSON.stringify({ prices: rows.map(r => ({ branchCode: r.branchCode, price: Number(r.price) || 0 })) })
      })
      flash('Branch prices saved'); onClose()
    } catch (e) { setErr(e.message) }
  }

  return (
    <Modal onClose={onClose} wide>
      <div>
        <h2 className="font-bold text-lg">Branch prices — {product.ProductName}</h2>
        <p className="text-sm text-stone-500">
          Base price ₱{peso(product.BasePrice)} applies to every branch not listed here.
        </p>
      </div>
      <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-72 overflow-y-auto">
        {rows.map((r, i) => {
          const diff = (Number(r.price) || 0) - product.BasePrice
          return (
            <div key={r.branchCode} className="px-3 py-2 flex items-center gap-3 text-sm">
              <span className="font-semibold w-16">{r.branchCode}</span>
              <span className="flex-1 text-stone-500 truncate">
                {branches.find(b => b.BranchCode === r.branchCode)?.BranchName}
              </span>
              <Input className="!w-32 !min-h-[38px] text-right tabnum" inputMode="decimal" value={r.price}
                onChange={e => setRows(rs => rs.map((x, j) =>
                  j === i ? { ...x, price: e.target.value.replace(/[^0-9.]/g, '') } : x))} />
              <span className={`tabnum text-xs w-16 text-right ${diff > 0 ? 'text-red-700' : diff < 0 ? 'text-emerald-700' : 'text-stone-400'}`}>
                {diff > 0 ? '+' : ''}{peso(diff)}
              </span>
              <button className="text-red-700 text-lg"
                onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>×</button>
            </div>
          )
        })}
        {!rows.length && (
          <p className="px-3 py-6 text-stone-400 text-sm text-center">
            No overrides — every branch sells at ₱{peso(product.BasePrice)}.
          </p>
        )}
      </div>
      {unused.length > 0 && (
        <div className="flex gap-2 items-end">
          <Field label="Add override for branch">
            <Select className="w-full" id="brsel">
              {unused.map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>)}
            </Select>
          </Field>
          <Btn variant="dark" onClick={() => {
            const code = document.getElementById('brsel').value
            setRows(rs => [...rs, { branchCode: code, price: String(product.BasePrice) }])
          }}>Add</Btn>
        </div>
      )}
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save}>Save prices</Btn>
      </div>
    </Modal>
  )
}

/* ================= Price Lists ================= */
function PriceLists({ flash }) {
  const { data: branches } = useApi('/api/branches')
  const { data: cats } = useApi('/api/products/categories')
  const [branch, setBranch] = useState('')
  const [list, setList] = useState(null)
  const [bulk, setBulk] = useState(false)
  const [copy, setCopy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (branches?.length && !branch) setBranch(branches[0].BranchCode) }, [branches, branch])

  const load = async (b = branch) => {
    if (!b) return
    try { setList(await api(`/api/products/pricelist/${b}`)) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { if (branch) load(branch) }, [branch]) // eslint-disable-line

  if (!branches || !cats) return <Spinner />

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end flex-wrap">
        <Field label="Price list for branch">
          <Select value={branch} onChange={e => setBranch(e.target.value)}>
            {branches.map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>)}
          </Select>
        </Field>
        <Btn variant="dark" onClick={() => setBulk(true)}>Bulk update</Btn>
        <Btn onClick={() => setCopy(true)}>Copy from another branch</Btn>
        <Btn onClick={() => exportCsv(list, branch)}>Export CSV</Btn>
      </div>

      <ErrorBar message={err} onDismiss={() => setErr('')} />

      {!list ? <Spinner /> : (
        <Table head={['Barcode', 'Product', 'Category', 'Base', `${branch} price`, 'Source', 'Difference']}
          rows={list.map(p => {
            const diff = Number(p.Price) - Number(p.BasePrice)
            return [p.Barcode, p.ProductName, p.CategoryName, peso(p.BasePrice), peso(p.Price),
              p.HasOverride
                ? <span key={p.ProductId} className="text-emerald-800 font-semibold">Branch override</span>
                : <span key={p.ProductId} className="text-stone-400">Base price</span>,
              p.HasOverride
                ? <span key={'d' + p.ProductId} className={diff > 0 ? 'text-red-700' : 'text-emerald-700'}>
                    {diff > 0 ? '+' : ''}{peso(diff)}
                  </span>
                : '—']
          })} />
      )}

      <Note tone="stone" title="Managing many branches">
        Pick a branch, review its effective list, and adjust in bulk. Copy-from-branch clones one
        branch's overrides to another — useful when a region shares pricing.
      </Note>

      {bulk && <BulkPriceModal branches={branches} cats={cats} defaultBranch={branch}
        onClose={() => setBulk(false)} onDone={() => { setBulk(false); load(); flash('Prices updated') }} />}
      {copy && <CopyPricesModal branches={branches} toBranch={branch}
        onClose={() => setCopy(false)} onDone={() => { setCopy(false); load(); flash('Prices copied') }} />}
    </div>
  )
}

function exportCsv(list, branch) {
  if (!list) return
  const head = 'Barcode,Product,Category,BasePrice,Price,HasOverride\n'
  const body = list.map(p =>
    `${p.Barcode},"${p.ProductName}",${p.CategoryName},${p.BasePrice},${p.Price},${p.HasOverride ? 'Y' : 'N'}`).join('\n')
  const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url; a.download = `pricelist-${branch}-${today()}.csv`; a.click()
  URL.revokeObjectURL(url)
}

function BulkPriceModal({ branches, cats, defaultBranch, onClose, onDone }) {
  const [f, setF] = useState({ branchCode: defaultBranch, categoryId: '', mode: 'PERCENT', value: '5' })
  const [err, setErr] = useState('')
  const apply = async () => {
    try {
      await api('/api/products/bulk-price', {
        method: 'POST',
        body: JSON.stringify({
          branchCode: f.branchCode === '__BASE__' ? null : f.branchCode,
          categoryId: f.categoryId ? Number(f.categoryId) : null,
          mode: f.mode, value: Number(f.value) || 0
        })
      })
      onDone()
    } catch (e) { setErr(e.message) }
  }
  return (
    <Modal onClose={onClose} wide>
      <h2 className="font-bold text-lg">Bulk price update</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target">
          <Select className="w-full" value={f.branchCode} onChange={e => setF({ ...f, branchCode: e.target.value })}>
            <option value="__BASE__">Base prices (affects all branches without an override)</option>
            {branches.map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} overrides only</option>)}
          </Select>
        </Field>
        <Field label="Category">
          <Select className="w-full" value={f.categoryId} onChange={e => setF({ ...f, categoryId: e.target.value })}>
            <option value="">All categories</option>
            {cats.map(c => <option key={c.CategoryId} value={c.CategoryId}>{c.CategoryName}</option>)}
          </Select>
        </Field>
        <Field label="Adjustment">
          <Select className="w-full" value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}>
            <option value="PERCENT">Change by percent (use −5 to reduce)</option>
            <option value="AMOUNT">Change by fixed amount</option>
            <option value="SETBASE">Remove overrides — revert to base price</option>
          </Select>
        </Field>
        <Field label="Value">
          <Input className="text-right tabnum" value={f.value} disabled={f.mode === 'SETBASE'}
            onChange={e => setF({ ...f, value: e.target.value })} /></Field>
      </div>
      <Note tone="amber">
        This writes immediately and cannot be undone in one click. An audit entry records the change.
      </Note>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={apply}>Apply</Btn>
      </div>
    </Modal>
  )
}

function CopyPricesModal({ branches, toBranch, onClose, onDone }) {
  const [from, setFrom] = useState(branches[0]?.BranchCode || '')
  const [err, setErr] = useState('')
  const run = async () => {
    try {
      await api('/api/products/copy-prices', {
        method: 'POST', body: JSON.stringify({ fromBranch: from, toBranch })
      })
      onDone()
    } catch (e) { setErr(e.message) }
  }
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">Copy price overrides</h2>
      <Field label="Copy from">
        <Select className="w-full" value={from} onChange={e => setFrom(e.target.value)}>
          {branches.filter(b => b.BranchCode !== toBranch).map(b =>
            <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>)}
        </Select>
      </Field>
      <Note tone="amber">
        Every existing override on <strong>{toBranch}</strong> is replaced by {from}'s overrides.
      </Note>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={run}>Copy to {toBranch}</Btn>
      </div>
    </Modal>
  )
}

/* ================= Categories ================= */
function Categories({ scope, flash }) {
  const { data, error, reload } = useApi('/api/products/categories')
  const branchCode = scope === 'ALL' ? null : scope
  const { data: mapped, reload: reloadMapped } = useApi(
    branchCode ? `/api/products/categories/print-areas?branchCode=${branchCode}` : '/api/branches', [branchCode])
  const { data: areas } = useApi(branchCode ? `/api/print-areas?branchCode=${branchCode}` : '/api/branches', [branchCode])
  const [name, setName] = useState('')

  const setArea = async (categoryId, areaId) => {
    await api(`/api/products/categories/${categoryId}/print-area`, {
      method: 'PUT', body: JSON.stringify({ branchCode, areaId: areaId || null })
    })
    reloadMapped(); flash('Print area updated')
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />

  const areaByCategory = new Map((branchCode && mapped ? mapped : []).map(m => [m.CategoryId, m.AreaId]))

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input className="!w-64" placeholder="New category name" value={name}
          onChange={e => setName(e.target.value)} />
        <Btn variant="primary" disabled={!name} onClick={async () => {
          await api('/api/products/categories', { method: 'POST', body: JSON.stringify({ categoryName: name }) })
          setName(''); reload(); flash('Category added')
        }}>Add category</Btn>
      </div>

      {!branchCode && (
        <Note tone="amber">Select a single branch in the header to set kitchen/beverage print
          areas per category — the category list itself is shared across branches.</Note>
      )}

      <Table head={branchCode ? ['Category', 'Products', 'Active', 'Print area'] : ['Category', 'Products', 'Active']}
        rows={data.map(c => {
          const row = [c.CategoryName, c.ProductCount, c.IsActive ? 'Yes' : 'No']
          if (branchCode) {
            row.push(
              <Select key={c.CategoryId} className="!w-40" value={areaByCategory.get(c.CategoryId) || ''}
                onChange={e => setArea(c.CategoryId, e.target.value ? Number(e.target.value) : null)}>
                <option value="">None</option>
                {(areas || []).map(a => <option key={a.AreaId} value={a.AreaId}>{a.AreaName}</option>)}
              </Select>
            )
          }
          return row
        })} />
    </div>
  )
}

/* ================= Discounts (per-category rate overrides) ================= */
/** RA 9994-style discounts aren't one flat rate — e.g. Senior Citizen is 20% + fully
 *  VAT-exempt on medicine, but only 5% + still-VATable (with a VAT adjustment) on
 *  groceries/prime commodities. This lets Admin override a discount type's default
 *  rate/VAT treatment per category; no override = the discount type's own default applies.
 *  Global, not branch-scoped — these rates are legally mandated, not a per-branch choice. */
function Discounts({ flash }) {
  const { data: types, error } = useApi('/api/settings/discount-types')
  const { data: categories } = useApi('/api/products/categories')
  const { data: overrides, reload } = useApi('/api/settings/discount-category-rates')
  const [code, setCode] = useState('')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!code && types?.length) setCode(types[0].DiscountCode)
  }, [code, types])

  if (error) return <ErrorBar message={error} />
  if (!types || !categories || !overrides) return <Spinner />
  if (!code) return <Spinner />

  const current = types.find(t => t.DiscountCode === code)
  const byCategory = new Map(
    overrides.filter(o => o.DiscountCode === code).map(o => [o.CategoryId, o]))

  const save = async () => {
    try {
      await api(`/api/settings/discount-category-rates/${code}/${edit.categoryId}`, {
        method: 'PUT', body: JSON.stringify({ rate: edit.rate / 100, isVatExempt: edit.isVatExempt })
      })
      setEdit(null); reload(); flash('Discount rate override saved')
    } catch (e) { setErr(e.message) }
  }

  const clear = async (categoryId) => {
    await api(`/api/settings/discount-category-rates/${code}/${categoryId}`, { method: 'DELETE' })
    reload(); flash('Override cleared — using default rate again')
  }

  return (
    <div className="space-y-3">
      <Field label="Discount type">
        <Select className="!w-64" value={code} onChange={e => setCode(e.target.value)}>
          {types.map(t => <option key={t.DiscountCode} value={t.DiscountCode}>
            {t.DiscountCode} — {t.Description}</option>)}
        </Select>
      </Field>

      {current && (
        <Note tone="stone">
          Default: {Math.round(current.Rate * 100)}%, {current.IsVatExempt ? 'VAT-exempt' : 'still VATable'}
          {current.LegalBasis ? ` (${current.LegalBasis})` : ''}. Set an override below only for
          categories that follow a different rule under this discount.
        </Note>
      )}

      <Table head={['Category', 'Rate', 'VAT treatment', '']}
        rows={categories.map(c => {
          const o = byCategory.get(c.CategoryId)
          return [
            c.CategoryName,
            o ? `${Math.round(o.Rate * 100)}%` : `${current ? Math.round(current.Rate * 100) : 0}% (default)`,
            o ? (o.IsVatExempt ? 'VAT-exempt' : 'Still VATable (VAT adj.)')
              : (current?.IsVatExempt ? 'VAT-exempt (default)' : 'Still VATable (default)'),
            <span key={c.CategoryId} className="flex gap-2">
              <button className="underline text-emerald-800" onClick={() => setEdit({
                categoryId: c.CategoryId, categoryName: c.CategoryName,
                rate: Math.round((o ? o.Rate : current?.Rate || 0) * 100),
                isVatExempt: o ? o.IsVatExempt : (current?.IsVatExempt ?? true) })}>
                {o ? 'Edit' : 'Override'}
              </button>
              {o && <button className="underline text-red-700" onClick={() => clear(c.CategoryId)}>Clear</button>}
            </span>
          ]
        })} />

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{code} override — {edit.categoryName}</h2>
          <Field label="Rate (%)"><Input type="number" min="0" max="100" value={edit.rate}
            onChange={e => setEdit({ ...edit, rate: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isVatExempt}
              onChange={e => setEdit({ ...edit, isVatExempt: e.target.checked })} />
            VAT-exempt (unchecked = item stays VATable and a VAT adjustment is computed)
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= Users ================= */
function Users({ flash }) {
  const { data, error, reload } = useApi('/api/users')
  const { data: branches } = useApi('/api/branches')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.userId) await api(`/api/users/${edit.userId}`, { method: 'PUT', body })
      else await api('/api/users', { method: 'POST', body })
      setEdit(null); reload(); flash('User saved')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data || !branches) return <Spinner />

  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({
        userId: 0, username: '', password: '', fullName: '', role: 'Cashier',
        isActive: true, branches: [] })}>Add user</Btn>
      <Table head={['Username', 'Full name', 'Role', 'Branch access', 'Active', '']}
        rows={data.map(u => [u.Username, u.FullName, u.Role,
          u.Role === 'Admin' ? 'All branches' : (u.Branches || '—'), u.IsActive ? 'Yes' : 'No',
          <button key={u.UserId} className="underline text-emerald-800" onClick={() => setEdit({
            userId: u.UserId, username: u.Username, password: '', fullName: u.FullName,
            role: u.Role, isActive: u.IsActive,
            branches: (u.Branches || '').split(',').map(s => s.trim()).filter(Boolean) })}>
            Edit / reset password
          </button>])} />

      <div className="bg-white rounded-xl p-4 shadow text-sm text-stone-600">
        <strong className="block mb-2 text-stone-900">Role permissions</strong>
        <div className="grid md:grid-cols-3 gap-3">
          <div><div className="font-semibold text-stone-900">Cashier</div>
            Sell, X-Read, reprint, blind close, run End of Day (with supervisor authorization).
            Never sees totals, variance or reports.</div>
          <div><div className="font-semibold text-stone-900">Supervisor</div>
            Cashier rights plus void approval, variance, End of Day authorization and all reports —
            for assigned branches only.</div>
          <div><div className="font-semibold text-stone-900">Admin</div>
            Everything, all branches, plus branch, product, price, user, terminal, POS and email
            configuration.</div>
        </div>
      </div>

      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">{edit.userId ? 'Edit user' : 'New user'}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username"><Input value={edit.username} disabled={!!edit.userId}
              onChange={e => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label={edit.userId ? 'New password (blank keeps current)' : 'Password'}>
              <Input type="password" value={edit.password}
                onChange={e => setEdit({ ...edit, password: e.target.value })} /></Field>
            <Field label="Full name"><Input value={edit.fullName}
              onChange={e => setEdit({ ...edit, fullName: e.target.value })} /></Field>
            <Field label="Role">
              <Select className="w-full" value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value })}>
                {['Cashier', 'Supervisor', 'Admin'].map(r => <option key={r}>{r}</option>)}
              </Select>
            </Field>
          </div>
          {edit.role !== 'Admin' && (
            <Field label="Branch access">
              <div className="flex gap-3 flex-wrap">
                {branches.map(b => (
                  <label key={b.BranchCode} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={edit.branches.includes(b.BranchCode)}
                      onChange={e => setEdit({
                        ...edit,
                        branches: e.target.checked
                          ? [...edit.branches, b.BranchCode]
                          : edit.branches.filter(x => x !== b.BranchCode)
                      })} />
                    {b.BranchCode}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive}
              onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= Terminals ================= */
function Terminals({ flash }) {
  const { data, error, reload } = useApi('/api/terminals')
  const { data: branches } = useApi('/api/branches')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.terminalId) await api(`/api/terminals/${edit.terminalId}`, { method: 'PUT', body })
      else await api('/api/terminals', { method: 'POST', body })
      setEdit(null); reload(); flash('Terminal saved')
    } catch (e) { setErr(e.message) }
  }

  const testPrint = async (id) => {
    try {
      await api(`/api/terminals/${id}/test-print`, { method: 'POST' })
      flash('Test print queued — prints once that terminal\'s PrintAgent next polls (a few seconds)')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data || !branches) return <Spinner />

  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({
        terminalId: 0, branchCode: branches[0]?.BranchCode, terminalCode: '', terminalName: '',
        printerTarget: 'tcp://192.168.1.50:9100', paperWidth: 58, printAgentKey: '', tin: '', accreditationNo: '', serialNo: '',
        permitNo: '', minNo: '', permitEffective: '', isActive: true })}>Add terminal</Btn>

      <Table head={['Branch', 'Code', 'Name', 'Printer', 'Paper', 'Serial No.', 'MIN', 'Permit No.',
        'Accreditation No.', 'Effective', 'Last Z#', 'Grand total', 'Active', '']}
        rows={data.map(t => [t.BranchCode, t.TerminalCode, t.TerminalName, t.PrinterTarget || '—',
          `${t.PaperWidth || 58}mm`,
          t.SerialNo || '—', t.MinNo || '—', t.PermitNo || '—', t.AccreditationNo || '—',
          t.PermitEffective ? String(t.PermitEffective).slice(0, 10) : '—',
          t.LastZCounter, peso(t.GrandTotalSales), t.IsActive ? 'Yes' : 'No',
          <span key={t.TerminalId} className="flex gap-2">
            <button className="underline text-emerald-800" onClick={() => setEdit({
              terminalId: t.TerminalId, branchCode: t.BranchCode, terminalCode: t.TerminalCode,
              terminalName: t.TerminalName, printerTarget: t.PrinterTarget, paperWidth: t.PaperWidth,
              printAgentKey: t.PrintAgentKey || '', tin: t.Tin,
              accreditationNo: t.AccreditationNo, serialNo: t.SerialNo, permitNo: t.PermitNo,
              minNo: t.MinNo,
              permitEffective: t.PermitEffective ? String(t.PermitEffective).slice(0, 10) : '',
              isActive: t.IsActive })}>Edit</button>
            <button className="underline text-emerald-800" onClick={() => testPrint(t.TerminalId)}>Test print</button>
          </span>])} />

      <Note tone="amber" title="BIR registration prints on every receipt">
        TIN, MIN, Serial No., Permit No. and Accreditation No. appear in the receipt header and are
        stored per terminal per branch, so each registered machine prints its own credentials.
        Printer targets: <code className="bg-stone-100 px-1">tcp://192.168.1.50:9100</code> for a
        network printer, <code className="bg-stone-100 px-1">file://COM3</code> for a USB printer
        exposing a virtual COM port, <code className="bg-stone-100 px-1">spool://XP-80C</code> for
        a USB printer installed normally (find the exact name via Windows' Printers &amp; Scanners
        settings or <code className="bg-stone-100 px-1">Get-Printer</code>) — works for any
        Windows-installed printer regardless of port, <code className="bg-stone-100 px-1">file:///dev/usb/lp0</code> on
        Linux.
      </Note>

      {edit && (
        <Modal onClose={() => setEdit(null)} wide>
          <h2 className="font-bold text-lg">
            {edit.terminalId ? `Edit ${edit.branchCode}/${edit.terminalCode}` : 'New terminal'}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <Select className="w-full" value={edit.branchCode}
                onChange={e => setEdit({ ...edit, branchCode: e.target.value })}>
                {branches.map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode}</option>)}
              </Select>
            </Field>
            <Field label="Terminal code"><Input value={edit.terminalCode} placeholder="POS-03"
              onChange={e => setEdit({ ...edit, terminalCode: e.target.value })} /></Field>
            <Field label="Terminal name"><Input value={edit.terminalName || ''}
              onChange={e => setEdit({ ...edit, terminalName: e.target.value })} /></Field>
            <Field label="Printer target"><Input value={edit.printerTarget || ''}
              onChange={e => setEdit({ ...edit, printerTarget: e.target.value })} /></Field>
            <Field label="Paper width">
              <Select className="w-full" value={edit.paperWidth || 58}
                onChange={e => setEdit({ ...edit, paperWidth: Number(e.target.value) })}>
                <option value={58}>58mm (32 columns)</option>
                <option value={80}>80mm (48 columns)</option>
              </Select>
            </Field>
            <Field label="Print agent key (optional)">
              <Input value={edit.printAgentKey || ''} placeholder="leave blank for a single-agent setup"
                onChange={e => setEdit({ ...edit, printAgentKey: e.target.value })} />
            </Field>
          </div>
          <Note tone="stone">PrintAgent polls the server for jobs rather than being called
            into, so no router/firewall setup is ever needed no matter where this terminal's
            printer physically sits. Leave "Print agent key" blank if you're only running one
            PrintAgent — it'll pick up everything queued for the shared default. Set a key here
            (and the same value in that machine's own PrintAgent appsettings.json) only if you
            run more than one PrintAgent and need Test Print / X-Read / Z-Read / Blind Close
            routed to the right one.</Note>
          <div className="border-t border-stone-100 pt-3">
            <div className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-2">BIR registration</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="TIN Number"><Input value={edit.tin || ''} placeholder="000-000-000-0000"
                onChange={e => setEdit({ ...edit, tin: e.target.value })} /></Field>
              <Field label="Accreditation Number"><Input value={edit.accreditationNo || ''}
                onChange={e => setEdit({ ...edit, accreditationNo: e.target.value })} /></Field>
              <Field label="Serial Number"><Input value={edit.serialNo || ''}
                onChange={e => setEdit({ ...edit, serialNo: e.target.value })} /></Field>
              <Field label="Permit Number (PTU)"><Input value={edit.permitNo || ''}
                onChange={e => setEdit({ ...edit, permitNo: e.target.value })} /></Field>
              <Field label="MIN Number"><Input value={edit.minNo || ''}
                onChange={e => setEdit({ ...edit, minNo: e.target.value })} /></Field>
              <Field label="Effective date of permit"><Input type="date" value={edit.permitEffective || ''}
                onChange={e => setEdit({ ...edit, permitEffective: e.target.value })} /></Field>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive}
              onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= Tables (dine-in) ================= */
function Tables({ scope, flash }) {
  const branchCode = scope === 'ALL' ? null : scope
  const { data, error, reload } = useApi(branchCode ? `/api/tables?branchCode=${branchCode}` : '/api/branches', [branchCode])
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  if (!branchCode) return <Note tone="amber">Select a single branch in the header — tables are per branch.</Note>

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.tableId) await api(`/api/tables/${edit.tableId}`, { method: 'PUT', body })
      else await api('/api/tables', { method: 'POST', body })
      setEdit(null); reload(); flash('Table saved')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />

  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({
        tableId: 0, branchCode, tableNumber: '', capacity: 4, isActive: true })}>Add table</Btn>

      <Table head={['Table #', 'Capacity', 'Status', 'Active', '']}
        rows={data.map(t => [t.TableNumber, t.Capacity,
          t.OpenOrderUid ? `Occupied (${t.ItemCount} item${t.ItemCount === 1 ? '' : 's'})` : 'Available',
          t.IsActive ? 'Yes' : 'No',
          <button key={t.TableId} className="underline text-emerald-800" onClick={() => setEdit({
            tableId: t.TableId, branchCode: t.BranchCode, tableNumber: t.TableNumber,
            capacity: t.Capacity, isActive: t.IsActive })}>Edit</button>])} />

      {data.length === 0 && (
        <Note>No tables yet for {branchCode}. Add one to enable dine-in for this branch.</Note>
      )}

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{edit.tableId ? `Edit table ${edit.tableNumber}` : 'New table'}</h2>
          <Field label="Table number"><Input value={edit.tableNumber} placeholder="12"
            onChange={e => setEdit({ ...edit, tableNumber: e.target.value })} /></Field>
          <Field label="Capacity (diners)"><Input type="number" min="1" value={edit.capacity}
            onChange={e => setEdit({ ...edit, capacity: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive}
              onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= Print Areas (dine-in kitchen/beverage routing) ================= */
function PrintAreas({ scope, flash }) {
  const branchCode = scope === 'ALL' ? null : scope
  const { data, error, reload } = useApi(branchCode ? `/api/print-areas?branchCode=${branchCode}` : '/api/branches', [branchCode])
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  if (!branchCode) return <Note tone="amber">Select a single branch in the header — print areas are per branch.</Note>

  const save = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.areaId) await api(`/api/print-areas/${edit.areaId}`, { method: 'PUT', body })
      else await api('/api/print-areas', { method: 'POST', body })
      setEdit(null); reload(); flash('Print area saved')
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />

  return (
    <div className="space-y-3">
      <Btn variant="primary" onClick={() => setEdit({
        areaId: 0, branchCode, areaName: '', printerTarget: 'tcp://192.168.1.60:9100',
        paperWidth: 58, printAgentKey: '', isActive: true })}>
        Add print area
      </Btn>

      <Table head={['Area', 'Printer', 'Paper', 'Active', '']}
        rows={data.map(a => [a.AreaName, a.PrinterTarget, `${a.PaperWidth || 58}mm`, a.IsActive ? 'Yes' : 'No',
          <button key={a.AreaId} className="underline text-emerald-800" onClick={() => setEdit({
            areaId: a.AreaId, branchCode: a.BranchCode, areaName: a.AreaName,
            printerTarget: a.PrinterTarget, paperWidth: a.PaperWidth,
            printAgentKey: a.PrintAgentKey || '', isActive: a.IsActive })}>Edit</button>])} />

      {data.length === 0 && (
        <Note>No print areas yet for {branchCode}. Add one (e.g. "Kitchen", "Beverage"), then
          map categories to it in Admin → Categories to enable Send to Kitchen.</Note>
      )}

      <Note tone="stone">Areas print server-side (via the print agent) — never RawBT, which only
        reaches this handheld's own paired printer. Use{' '}
        <code className="bg-stone-100 px-1">tcp://192.168.1.60:9100</code> for a network printer,
        or <code className="bg-stone-100 px-1">spool://&lt;exact printer name&gt;</code> for a
        USB printer installed on the same machine the print agent runs on.
      </Note>

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{edit.areaId ? `Edit ${edit.areaName}` : 'New print area'}</h2>
          <Field label="Area name"><Input value={edit.areaName} placeholder="Kitchen"
            onChange={e => setEdit({ ...edit, areaName: e.target.value })} /></Field>
          <Field label="Printer target"><Input value={edit.printerTarget}
            onChange={e => setEdit({ ...edit, printerTarget: e.target.value })} /></Field>
          <Field label="Paper width">
            <Select className="w-full" value={edit.paperWidth || 58}
              onChange={e => setEdit({ ...edit, paperWidth: Number(e.target.value) })}>
              <option value={58}>58mm (32 columns)</option>
              <option value={80}>80mm (48 columns)</option>
            </Select>
          </Field>
          <Field label="Print agent key (optional)">
            <Input value={edit.printAgentKey || ''} placeholder="leave blank for a single-agent setup"
              onChange={e => setEdit({ ...edit, printAgentKey: e.target.value })} />
          </Field>
          <Note tone="stone">PrintAgent polls the server for jobs rather than being called
            into, so no router/firewall setup is needed regardless of where this printer sits.
            Leave blank if you're only running one PrintAgent. Set a key here (and the same
            value in that machine's PrintAgent appsettings.json) only if you run more than one
            and need Send to Kitchen routed to the right one.</Note>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive}
              onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ================= POS Settings ================= */
const POS_TYPES = [
  { code: 'Retail', desc: 'Discount applies to every eligible item on the receipt. Default setup.' },
  { code: 'Restaurant', desc: 'Discount is split by the number of diners; only the claimant\'s share is discounted, and service charge is excluded from the base.' },
  { code: 'Pharmacy', desc: 'Discount applies to medicines only; prescription and doctor details are captured per transaction.' }
]

function SettingsTab({ scope, flash }) {
  const branchCode = scope === 'ALL' ? null : scope
  const { data, error, reload } = useApi(branchCode ? `/api/settings/${branchCode}` : '/api/branches', [scope])
  const [f, setF] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (branchCode && data && data.BranchCode) {
      setF({
        branchCode: data.BranchCode, posType: data.PosType,
        voidOverride: data.VoidOverride, priceEditOverride: data.PriceEditOverride,
        reprintOverride: data.ReprintOverride, eodOverride: data.EodOverride,
        emailOnBlindClose: data.EmailOnBlindClose, refundEnabled: data.RefundEnabled,
        blockLoginAfterEod: data.BlockLoginAfterEod, orBlockSize: data.OrBlockSize,
        orLowWarning: data.OrLowWarning, maxDiscountPerTxn: data.MaxDiscountPerTxn,
        storeHeader1: data.StoreHeader1, storeHeader2: data.StoreHeader2,
        receiptFooter: data.ReceiptFooter
      })
    }
  }, [data, branchCode])

  if (!branchCode) return <Note tone="amber">Select a single branch in the header — POS settings are per branch.</Note>
  if (error) return <ErrorBar message={error} />
  if (!f) return <Spinner />

  const save = async () => {
    try {
      await api(`/api/settings/${branchCode}`, { method: 'PUT', body: JSON.stringify(f) })
      flash('Settings saved'); reload()
    } catch (e) { setErr(e.message) }
  }

  const toggles = [
    ['voidOverride', 'Require supervisor override for void',
      'When off, a cashier can void their own last transaction. It is logged either way.'],
    ['priceEditOverride', 'Require supervisor override for price edit',
      'Applies only to products flagged price-editable.'],
    ['reprintOverride', 'Require supervisor override for reprint',
      'Reprints are always marked REPRINT on the receipt.'],
    ['eodOverride', 'Require supervisor override for End of Day',
      'When off, a cashier can run End of Day directly without a separate credential. Admin/Supervisor never need one for their own End of Day either way.'],
    ['emailOnBlindClose', 'Email a report when a cashier closes their shift',
      'Sends X-Read, group item sales summary and per-hour transactions to the configured email recipients (Admin → Email). Never shown to the cashier, same as the printed variance report. End of Day’s email is controlled separately in Admin → Email (Send automatically on End of Day).'],
    ['refundEnabled', 'Allow refund / return',
      'Prints a return slip referencing the original OR number.'],
    ['blockLoginAfterEod', 'Block cashier login after End of Day until the next business day',
      'The terminal reopens automatically on the next day. Admin can always sign in.']
  ]

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="bg-white rounded-xl p-5 shadow space-y-4">
        <div>
          <h2 className="font-bold">POS type — {branchCode}</h2>
          <p className="text-sm text-stone-500">Controls how discounts are computed at this branch.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {POS_TYPES.map(t => (
            <button key={t.code} onClick={() => setF({ ...f, posType: t.code })}
              className={`rounded-lg p-3 text-left border ${f.posType === t.code ? 'bg-emerald-800 text-white border-emerald-800' : 'bg-white border-stone-300'}`}>
              <div className="font-bold text-sm">{t.code}</div>
              <div className={`text-xs mt-1 ${f.posType === t.code ? 'text-white/70' : 'text-stone-500'}`}>{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 shadow space-y-3">
        <h2 className="font-bold">Transaction controls</h2>
        {toggles.map(([k, label, desc]) => (
          <label key={k} className="flex items-start gap-3 border-b border-stone-100 pb-3 last:border-0">
            <input type="checkbox" className="mt-1" checked={!!f[k]}
              onChange={e => setF({ ...f, [k]: e.target.checked })} />
            <span className="text-sm">
              <span className="font-semibold block">{label}</span>
              <span className="text-stone-500">{desc}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="bg-white rounded-xl p-5 shadow space-y-3">
        <h2 className="font-bold">Numbering, limits and receipt header</h2>
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="OR block size per allocation">
            <Input className="text-right tabnum" value={f.orBlockSize}
              onChange={e => setF({ ...f, orBlockSize: Number(e.target.value) || 0 })} /></Field>
          <Field label="Warn when OR remaining below">
            <Input className="text-right tabnum" value={f.orLowWarning}
              onChange={e => setF({ ...f, orLowWarning: Number(e.target.value) || 0 })} /></Field>
          <Field label="Max discount per transaction (0 = no cap)">
            <Input className="text-right tabnum" value={f.maxDiscountPerTxn}
              onChange={e => setF({ ...f, maxDiscountPerTxn: Number(e.target.value) || 0 })} /></Field>
          <Field label="Receipt header line 1"><Input value={f.storeHeader1 || ''}
            onChange={e => setF({ ...f, storeHeader1: e.target.value })} /></Field>
          <Field label="Receipt header line 2"><Input value={f.storeHeader2 || ''}
            onChange={e => setF({ ...f, storeHeader2: e.target.value })} /></Field>
        </div>
        <Field label="Receipt footer — one line per row; each line is centered automatically at print time">
          <Textarea rows={14} value={f.receiptFooter || ''}
            onChange={e => setF({ ...f, receiptFooter: e.target.value })} />
        </Field>
      </div>

      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <Btn variant="primary" onClick={save}>Save settings</Btn>
    </div>
  )
}

/* ================= Email ================= */
function EmailTab() {
  const { data, error, reload } = useApi('/api/settings/email-config')
  const [f, setF] = useState(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => {
    if (data) {
      setF({ smtpHost: data.SmtpHost, smtpPort: data.SmtpPort, smtpUser: data.SmtpUser,
        smtpPassword: '', fromAddress: data.FromAddress, toAddresses: data.ToAddresses,
        enableSsl: data.EnableSsl, sendOnEod: data.SendOnEod, isActive: data.IsActive,
        hasPassword: !!data.HasPassword })
    }
  }, [data])

  if (error) return <ErrorBar message={error} />
  if (!f) return <Spinner />

  const save = async () => {
    setSaving(true); setErr(''); setTestResult(null)
    try {
      await api('/api/settings/email-config', { method: 'PUT', body: JSON.stringify(f) })
      setF({ ...f, smtpPassword: '', hasPassword: f.hasPassword || !!f.smtpPassword })
      reload()
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true); setErr(''); setTestResult(null)
    try {
      setTestResult(await api('/api/settings/email-config/test', { method: 'POST' }))
    } catch (e) { setErr(e.message) } finally { setTesting(false) }
  }

  return (
    <div className="max-w-xl space-y-3">
      <div className="bg-white rounded-2xl p-5 shadow space-y-3">
        <div>
          <h2 className="font-bold">Z-Read email (SMTP)</h2>
          <p className="text-sm text-stone-500">
            One global configuration is used for every branch unless a branch-specific row is added
            directly in <code className="bg-stone-100 px-1">dbo.EmailConfig</code> later. Set
            "To address(es)" to your own inbox to test delivery before turning this on for real
            End of Day runs.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SMTP host"><Input value={f.smtpHost} placeholder="smtp.gmail.com"
            onChange={e => setF({ ...f, smtpHost: e.target.value })} /></Field>
          <Field label="SMTP port"><Input className="text-right tabnum" inputMode="numeric" value={f.smtpPort}
            onChange={e => setF({ ...f, smtpPort: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Field>
          <Field label="SMTP username"><Input value={f.smtpUser} placeholder="you@gmail.com"
            onChange={e => setF({ ...f, smtpUser: e.target.value })} /></Field>
          <Field label={f.hasPassword ? 'SMTP password (blank keeps current)' : 'SMTP password'}>
            <Input type="password" value={f.smtpPassword} placeholder={f.hasPassword ? '••••••••' : ''}
              onChange={e => setF({ ...f, smtpPassword: e.target.value })} /></Field>
          <Field label="From address"><Input value={f.fromAddress} placeholder="you@gmail.com"
            onChange={e => setF({ ...f, fromAddress: e.target.value })} /></Field>
          <Field label="To address(es), comma-separated"><Input value={f.toAddresses} placeholder="you@gmail.com"
            onChange={e => setF({ ...f, toAddresses: e.target.value })} /></Field>
        </div>
        <div className="flex gap-5 text-sm flex-wrap border-t border-stone-100 pt-3">
          {[['enableSsl', 'Use TLS/SSL'], ['sendOnEod', 'Send automatically on End of Day'],
            ['isActive', 'Active']].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={f[k]} onChange={e => setF({ ...f, [k]: e.target.checked })} />
              <strong>{label}</strong>
            </label>
          ))}
        </div>
        <ErrorBar message={err} onDismiss={() => setErr('')} />
        {testResult && (
          <Note tone={testResult.sent ? 'green' : 'red'}>
            {testResult.sent
              ? 'Test email sent — check your inbox (and spam folder).'
              : `Send failed: ${testResult.message}`}
          </Note>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={test} disabled={testing || !f.hasPassword}>
            {testing ? 'Sending…' : 'Send test email'}
          </Btn>
          <Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </div>

      <Note tone="stone" title="Common providers">
        <strong>Gmail:</strong> smtp.gmail.com, port 587, TLS on. Needs a 16-character
        <em> App Password</em> (Google Account → Security → 2-Step Verification → App passwords) —
        your normal login password will be rejected.<br />
        <strong>Outlook / Microsoft 365:</strong> smtp.office365.com, port 587, TLS on. May also
        require an app password if multi-factor authentication is on.
      </Note>
    </div>
  )
}

/* ================= Closings ================= */
function Closings({ branchFilter }) {
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState(null)
  const [detail, setDetail] = useState(null)
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const q = `?dateFrom=${from}&dateTo=${to}` + (branchFilter ? `&branchCode=${branchFilter}` : '')
      setRows(await api('/api/shifts/closings' + q))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line

  return (
    <div className="space-y-3">
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} onLoad={load} />
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {!rows ? <Spinner /> : (
        <Table head={['Date', 'Branch', 'Terminal', 'Cashier', 'Cash begin', 'Cash sales', 'Card sales',
          'Declared', 'Expected cash', 'Short/(Over)', '']}
          rows={rows.map((r, i) => [
            String(r.BusinessDate).slice(0, 10), r.BranchCode, r.TerminalCode, r.Cashier,
            peso(r.CashBegin), peso(r.CashSales), peso(r.CardSales), peso(r.DeclaredCash), peso(r.ExpectedCash),
            <span key={i} className={Number(r.ShortOver) === 0 ? '' : Number(r.ShortOver) > 0 ? 'text-emerald-800 font-semibold' : 'text-red-700 font-semibold'}>
              {Number(r.ShortOver) === 0 ? '—' : Number(r.ShortOver) > 0
                ? `(${peso(r.ShortOver)})` : peso(Math.abs(Number(r.ShortOver)))}
            </span>,
            <button key={'b' + i} className="underline text-emerald-800" onClick={() => setDetail(r)}>Denominations</button>
          ])} />
      )}
      <Note tone="stone">
        Card sales are excluded from expected cash — the drawer count covers cash only. A figure in
        parentheses means the drawer was over. Visible to Supervisor and Admin only.
      </Note>
      {detail && (
        <Modal onClose={() => setDetail(null)}>
          <h2 className="font-bold text-lg">{detail.BranchCode}/{detail.TerminalCode} · {detail.Cashier}</h2>
          <Table head={['Denomination', 'Count', 'Amount']}
            rows={Object.entries(JSON.parse(detail.DenominationsJson || '{}'))
              .sort((a, b) => Number(b[0]) - Number(a[0]))
              .map(([d, n]) => [`₱${d}`, n, peso(Number(d) * Number(n))])} />
          <Btn variant="dark" className="w-full" onClick={() => setDetail(null)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

/* ================= Stuck shifts (never blind-closed) ================= */
const REC_DENOMS = ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.25']

function StuckShifts({ flash }) {
  const { data, error, reload } = useApi('/api/shifts/open')
  const [close, setClose] = useState(null)
  const [counts, setCounts] = useState({})
  const [remark, setRemark] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const declared = REC_DENOMS.reduce((s, d) => s + Number(d) * (Number(counts[d]) || 0), 0)

  const openFor = (row) => { setClose(row); setCounts({}); setRemark(''); setResult(null); setErr('') }

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const denominations = {}
      REC_DENOMS.forEach(d => { const n = Number(counts[d]) || 0; if (n > 0) denominations[d] = n })
      const r = await api(`/api/shifts/${close.ShiftUid}/force-blind-close`, {
        method: 'POST', body: JSON.stringify({ denominations, remark })
      })
      setResult(r.variance || null)
      flash('Shift force-closed'); reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />
  if (!data.length) return null

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Terminals with a shift stuck open</h3>
      <Note tone="amber" title="Recovery, not routine use">
        A shift lands here when a cashier never ran Blind Close — signed out without closing, the
        tablet was reset, or they simply forgot. Only force-close after someone has physically
        counted that drawer; the count entered here plays the exact role the cashier's own blind
        close would have, and the terminal stays locked until it's done.
      </Note>
      <Table head={['Branch', 'Terminal', 'Cashier', 'Business date', 'Cash begin', 'Opened at', '']}
        rows={data.map(s => [
          s.BranchCode, s.TerminalCode, s.Cashier, String(s.BusinessDate).slice(0, 10),
          peso(s.CashBegin), String(s.OpenedAt).replace('T', ' ').slice(0, 16),
          <button key={s.ShiftUid} className="underline text-red-700 font-semibold"
            onClick={() => openFor(s)}>Force close…</button>
        ])} />

      {close && (
        <Modal onClose={() => setClose(null)} wide>
          {!result ? (
            <>
              <h2 className="font-bold text-lg">
                Force-close {close.BranchCode}/{close.TerminalCode} — {close.Cashier}
              </h2>
              <p className="text-sm text-stone-500">
                Enter the physical drawer count exactly as the cashier would have.
              </p>
              <div className="bg-stone-50 rounded-lg p-4 grid grid-cols-2 gap-x-6 gap-y-2">
                {REC_DENOMS.map(d => (
                  <label key={d} className="flex items-center gap-2">
                    <span className="tabnum w-14 text-right font-bold text-sm">₱{d}</span>
                    <span className="text-stone-400">×</span>
                    <Input className="!min-h-[38px] text-right tabnum !text-sm" inputMode="numeric" placeholder="0"
                      value={counts[d] || ''}
                      onChange={e => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })} />
                  </label>
                ))}
              </div>
              <div className="bg-stone-900 text-white rounded-xl px-4 py-3 flex justify-between items-baseline">
                <span className="text-[10px] tracking-[0.3em] uppercase text-white/50">Declared cash</span>
                <span className="tabnum text-2xl font-bold">₱{peso(declared)}</span>
              </div>
              <Field label="Reason (goes in the audit log)">
                <Input value={remark} placeholder="e.g. cashier left without closing, drawer counted on-site"
                  onChange={e => setRemark(e.target.value)} />
              </Field>
              <ErrorBar message={err} onDismiss={() => setErr('')} />
              <div className="grid grid-cols-2 gap-3">
                <Btn onClick={() => setClose(null)}>Cancel</Btn>
                <Btn variant="primary" disabled={busy || declared <= 0 || !remark} onClick={submit}>
                  {busy ? 'Closing…' : 'Force close'}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <h2 className="font-bold text-lg">Shift closed</h2>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Expected cash" value={`₱${peso(result.ExpectedCash)}`} />
                <Stat label="Declared cash" value={`₱${peso(result.DeclaredCash)}`} />
                <Stat label="Short / (Over)" value={
                  Number(result.ShortOver) === 0 ? '—' : Number(result.ShortOver) > 0
                    ? `(${peso(result.ShortOver)})` : peso(Math.abs(Number(result.ShortOver)))} />
              </div>
              <Note tone="stone">
                If this terminal has no other open shifts left today, it now appears under
                "Days awaiting End of Day" below.
              </Note>
              <Btn variant="primary" className="w-full" onClick={() => setClose(null)}>Done</Btn>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

/* ================= Z-Read / EOD ================= */
function ZReadTab({ branchFilter, flash }) {
  const nav = useNavigate()
  const { data: pending, error: pErr, reload: reloadPending } = useApi('/api/eod/pending')
  const [from, setFrom] = useState(today().slice(0, 8) + '01')
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState(null)
  const [paper, setPaper] = useState(null)
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const q = `?dateFrom=${from}&dateTo=${to}` + (branchFilter ? `&branchCode=${branchFilter}` : '')
      setRows(await api('/api/eod/zreads' + q))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line

  const reprint = async (id) => {
    try {
      const r = await api(`/api/eod/zreads/${id}/reprint`, { method: 'POST' })
      setPaper(r.receiptText)
      flash(r.printed ? 'Sent to the printer' : 'Printer unreachable — showing the report on screen')
    } catch (e) { setErr(e.message) }
  }

  return (
    <div className="space-y-3">
      <StuckShifts flash={flash} />

      <div>
        <h3 className="text-sm font-semibold mb-2">Days awaiting End of Day</h3>
        {pErr ? <ErrorBar message={pErr} /> : !pending ? <Spinner /> : (
          <Table head={['Business date', 'Branch', 'Terminal', 'Shifts', 'Last cashier', 'Closed at', '']}
            rows={pending.map((r, i) => [
              String(r.BusinessDate).slice(0, 10), r.BranchCode, r.TerminalCode, r.ShiftCount,
              r.LastCashier, r.LastClosedAt ? String(r.LastClosedAt).replace('T', ' ').slice(0, 16) : '—',
              <button key={i} className="underline text-red-700 font-semibold"
                onClick={() => nav(`/end-of-day?terminalId=${r.TerminalId}&businessDate=${String(r.BusinessDate).slice(0, 10)}`)}>
                Run End of Day
              </button>])}
            empty="Every terminal is closed for the day." />
        )}
      </div>

      <Note tone="green" title="Three ways a day gets closed">
        Normally the cashier runs End of Day at the terminal right after blind close. If they forget,
        the day appears here — an Admin closes it remotely, or the same cashier signs back in and
        Cash Begin offers an End of Day button instead of a shift. All three paths require a
        Supervisor/Admin credential and write the same audit entry.
      </Note>

      <h3 className="text-sm font-semibold pt-2">Completed Z-Reads</h3>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} onLoad={load} />
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {!rows ? <Spinner /> : (
        <Table head={['Date', 'Branch', 'Terminal', 'Z#', 'Gross', 'Discounts', 'Net', 'VAT',
          'Cash', 'Card', 'Txns', 'Voids', 'OR range', 'Grand total', 'Closed by', 'Approved by', '']}
          rows={rows.map(z => [
            String(z.BusinessDate).slice(0, 10), z.BranchCode, z.TerminalCode, z.ZCounter,
            peso(z.GrossSales), peso(z.TotalDiscounts), peso(z.NetSales), peso(z.VatAmount),
            peso(z.CashSales), peso(z.CardSales), z.TxnCount, z.VoidCount,
            `${z.BeginningOR ?? '—'}–${z.EndingOR ?? '—'}`, peso(z.NewGrandTotal),
            z.ClosedByName, z.ApprovedByName,
            <button key={z.ZReadId} className="underline text-emerald-800"
              onClick={() => reprint(z.ZReadId)}>View / reprint</button>])} />
      )}
      {paper && (
        <Modal onClose={() => setPaper(null)}>
          <Paper text={paper} />
          <Btn variant="dark" className="w-full" onClick={() => setPaper(null)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

/* ================= Reports ================= */
const REPORTS = [
  { key: 'sales-summary', name: 'Sales Summary',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'],
      ['TxnCount', 'Txns'], ['GrossSales', 'Gross', 1], ['Discounts', 'Discounts', 1],
      ['NetSales', 'Net', 1], ['VatAmount', 'VAT', 1]] },
  { key: 'branch-comparison', name: 'Branch Comparison',
    cols: [['BranchCode', 'Branch'], ['BranchName', 'Name'], ['TxnCount', 'Txns'],
      ['GrossSales', 'Gross', 1], ['Discounts', 'Discounts', 1], ['NetSales', 'Net', 1],
      ['AvgBasket', 'Avg basket', 1]] },
  { key: 'sales-details', name: 'Sales Details',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'],
      ['ORNumber', 'OR#'], ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'],
      ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1], ['DiscountCode', 'Type'],
      ['NetAmount', 'Net', 1], ['Payments', 'Payment'], ['Status', 'Status']] },
  { key: 'payment-breakdown', name: 'Payment Breakdown',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['CashAmount', 'Cash', 1],
      ['CardAmount', 'Card', 1], ['CardTxns', 'Card txns'], ['TotalTendered', 'Total', 1]] },
  { key: 'card-transactions', name: 'Card Transactions',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['ORNumber', 'OR#'],
      ['CardBank', 'Bank'], ['CardNo', 'Card No.'], ['CardName', 'Card name'],
      ['CardRefNo', 'Reference No.'], ['Amount', 'Amount', 1]] },
  { key: 'discounts', name: 'Discounts (BIR)',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['ORNumber', 'OR#'],
      ['DiscountCode', 'Type'], ['DiscountCtrlNo', 'Control No.'], ['DiscountName', 'Name'],
      ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1], ['NetAmount', 'Net', 1]] },
  { key: 'group-category', name: 'Group by Category',
    cols: [['BranchCode', 'Branch'], ['CategoryName', 'Category'], ['TotalQty', 'Qty'],
      ['TotalAmount', 'Amount', 1]] },
  { key: 'group-items', name: 'Group by Item',
    cols: [['BranchCode', 'Branch'], ['Barcode', 'Barcode'], ['ProductName', 'Item'],
      ['CategoryName', 'Category'], ['TotalQty', 'Qty'], ['TotalAmount', 'Amount', 1]] },
  { key: 'void-return', name: 'Void / Return',
    cols: [['BusinessDate', 'Date'], ['BranchCode', 'Branch'], ['ORNumber', 'OR#'],
      ['Cashier', 'Cashier'], ['ApprovedBy', 'Approved by'], ['NetAmount', 'Amount', 1],
      ['VoidReason', 'Reason']] },
  { key: 'cashier-performance', name: 'Cashier Performance',
    cols: [['Cashier', 'Cashier'], ['BranchCode', 'Branch'], ['Shifts', 'Shifts'],
      ['TxnCount', 'Txns'], ['NetSales', 'Net sales', 1], ['Voids', 'Voids'],
      ['NetShortOver', 'Net short/(over)', 1]] },
  { key: 'audit-logs', name: 'Audit Logs',
    cols: [['CreatedAt', 'When'], ['BranchCode', 'Branch'], ['Username', 'User'],
      ['TerminalCode', 'Terminal'], ['Action', 'Action'], ['Detail', 'Detail']] }
]

function Reports({ branchFilter }) {
  const [sel, setSel] = useState(REPORTS[0])
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')

  const load = async (r = sel) => {
    setRows(null); setErr('')
    try {
      const q = `?dateFrom=${from}&dateTo=${to}` + (branchFilter ? `&branchCode=${branchFilter}` : '')
      setRows(await api(`/api/reports/${r.key}` + q))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line

  const fmt = (v, money) => {
    if (v === null || v === undefined) return '—'
    if (money) return peso(v)
    const s = String(v)
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.replace('T', ' ').slice(0, 19) : s
  }

  const exportCsvRows = () => {
    if (!rows?.length) return
    const head = sel.cols.map(c => c[1]).join(',') + '\n'
    const body = rows.map(r => sel.cols.map(c => `"${String(r[c[0]] ?? '')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = `${sel.key}-${from}_${to}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {REPORTS.map(r => (
          <Btn key={r.key} variant={sel.key === r.key ? 'moss' : 'ghost'}
            className="whitespace-nowrap !min-h-[38px] text-xs"
            onClick={() => { setSel(r); setRows(null); load(r) }}>{r.name}</Btn>
        ))}
      </div>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} onLoad={() => load()}>
        <Btn onClick={exportCsvRows}>Export CSV</Btn>
        <Btn onClick={() => window.print()}>Print</Btn>
      </DateRange>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {!rows ? <Spinner /> : (
        <Table head={sel.cols.map(c => c[1])}
          rows={rows.map(r => sel.cols.map(c => fmt(r[c[0]], c[2])))} />
      )}
    </div>
  )
}

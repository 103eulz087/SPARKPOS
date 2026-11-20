import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, uploadProductImage } from '../lib/api'
import { returnNo, siNo } from '../lib/receipt'
import { localDate, peso, useAuth } from '../lib/store'
import AdminLayout from '../components/AdminLayout'
import { Btn, ErrorBar, Field, Input, Modal, Note, Paper, Select, Spinner, Table, Textarea, Toast, ProductThumb } from '../components/Ui'

const today = () => localDate()
const TABS = ['Dashboard', 'Branches', 'Products', 'Price Lists', 'Wholesale', 'Promos', 'Categories', 'Discounts', 'Suki Cards', 'Gift Certificates', 'Users',
  'Terminals', 'Tables', 'Print Areas', 'POS Settings', 'Email', 'Closings', 'Z-Read / EOD', 'Reports', 'Accounting']
// Accounting is owner/Admin-only (AccountingController is [Authorize(Roles = "Admin")]).
const ADMIN_ONLY_TABS = ['Accounting']
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export default function Admin() {
  const nav = useNavigate()
  const { fullName, role, branchCode, branches, setBranch, logout } = useAuth()
  // The section is in the address (#products), so a reload or the Back button keeps it.
  const fromHash = () => TABS.find(t => slug(t) === window.location.hash.slice(1)
    && (role === 'Admin' || !ADMIN_ONLY_TABS.includes(t))) || 'Dashboard'
  const [tab, setTab] = useState(fromHash)
  useEffect(() => {
    const onHash = () => setTab(fromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const go = (t) => { setTab(t); if (window.location.hash.slice(1) !== slug(t)) window.location.hash = slug(t) }
  const [scope, setScope] = useState(branchCode)   // 'ALL' or a branch code
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2600) }
  const branchFilter = scope === 'ALL' ? null : scope

  if (role !== 'Admin' && role !== 'Supervisor') return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <p className="text-fg2">Admin access requires a Supervisor or Admin account.</p>
        <Btn onClick={() => nav('/cash-begin')}>Back to POS</Btn>
      </div>
    </div>
  )

  const visible = TABS.filter(t => role === 'Admin' || !ADMIN_ONLY_TABS.includes(t))
  const branchSelect = (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="hidden md:inline">Branch</span>
      <select aria-label="Branch" className="bg-ink/70 border border-line2 rounded-lg px-2 py-1.5 text-fg text-sm max-w-[9.5rem] focus:outline-none focus:ring-2 focus:ring-accent"
        value={scope} onChange={e => { setScope(e.target.value); if (e.target.value !== 'ALL') setBranch(e.target.value) }}>
        <option value="ALL">All branches</option>
        {branches.map(b => <option key={b} value={b}>{b}</option>)}
      </select>
    </label>
  )

  return (
    <AdminLayout tab={tab} onTab={go} visible={visible} user={{ name: fullName, role }} branchSelect={branchSelect}
      actions={<Btn variant="primary" className="hidden sm:inline-flex items-center !min-h-[36px] text-sm px-3" onClick={() => nav('/cash-begin')}>Open POS</Btn>}
      onOpenPos={() => nav('/cash-begin')} onSignOut={() => { logout(); nav('/login') }}>
      <div>
        {tab === 'Dashboard' && <Dashboard branchFilter={branchFilter} />}
        {tab === 'Branches' && <Branches flash={flash} />}
        {tab === 'Products' && <Products flash={flash} />}
        {tab === 'Price Lists' && <PriceLists flash={flash} />}
        {tab === 'Categories' && <Categories scope={scope} flash={flash} />}
        {tab === 'Discounts' && <Discounts flash={flash} />}
        {tab === 'Suki Cards' && <Loyalty flash={flash} />}
        {tab === 'Gift Certificates' && <GiftCerts flash={flash} />}
        {tab === 'Wholesale' && <Wholesale flash={flash} />}
        {tab === 'Promos' && <Promos flash={flash} />}
        {tab === 'Users' && <Users flash={flash} />}
        {tab === 'Terminals' && <Terminals flash={flash} />}
        {tab === 'Tables' && <Tables scope={scope} flash={flash} />}
        {tab === 'Print Areas' && <PrintAreas scope={scope} flash={flash} />}
        {tab === 'POS Settings' && <SettingsTab scope={scope} flash={flash} />}
        {tab === 'Email' && <EmailTab />}
        {tab === 'Closings' && <Closings branchFilter={branchFilter} />}
        {tab === 'Z-Read / EOD' && <ZReadTab branchFilter={branchFilter} flash={flash} />}
        {tab === 'Reports' && <Reports branchFilter={branchFilter} />}
        {tab === 'Accounting' && role === 'Admin' && <Accounting branchFilter={branchFilter} flash={flash} />}
      </div>
      <Toast message={toast} />
    </AdminLayout>
  )
}

/* ---------- helpers ---------- */
/* ================= Suki / reward cards ================= */
/** Cards and points (LoyaltyController). Supervisors register cards and look up histories;
 *  the earning rule and manual adjustments are Admin-only. Points themselves are earned on
 *  the sale and taken back on a void or return, never edited here. */
/* ================= Gift certificates (38_gift_certificates.sql) =================
 * The register the tills check a GC against. Head office adds them (one number or a numbered batch)
 * and can cancel an unused one; a sale's sync marks it used (and a void gives it back). */
const GC_STATUS = { Active: 'Not used', Redeemed: 'Used', Cancelled: 'Cancelled' }
function GiftCerts({ flash }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const { data, error, reload } = useApi(`/api/giftcerts?status=${status}&q=${encodeURIComponent(term)}`, [status, term])
  const branches = useApi('/api/branches')
  const [add, setAdd] = useState(null)
  const [cancel, setCancel] = useState(null)
  const [err, setErr] = useState('')

  const nums = (a) => {
    const n = Number(a.count) || 0, start = Number(a.start) || 0, digits = Number(a.digits) || 0
    if (a.mode === 'one') return [a.prefix.trim()]
    return n > 0 ? [...new Set([0, n - 1])].map(i => a.prefix.trim() + String(start + i).padStart(digits, '0')) : []   // first and last
  }
  const save = async () => {
    try {
      const one = add.mode === 'one'
      const r = await api('/api/giftcerts', { method: 'POST', body: JSON.stringify({
        prefix: add.prefix, start: one ? 0 : Number(add.start), count: one ? 1 : Number(add.count), digits: one ? 0 : Number(add.digits),
        faceValue: Number(add.faceValue), issuedDate: add.issuedDate, expiryDate: add.expiryDate || null,
        branchCode: add.branchCode || null, issuedTo: add.issuedTo, note: add.note }) })
      setAdd(null); reload(); flash(r.added > 1 ? `${r.added} gift certificates added, ${r.first} to ${r.last}` : `Gift certificate ${r.first} added`)
    } catch (e) { setErr(e.message) }
  }
  const doCancel = async () => {
    try {
      await api(`/api/giftcerts/${cancel.gc.GcId}/cancel`, { method: 'POST', body: JSON.stringify({ reason: cancel.reason }) })
      setCancel(null); reload(); flash(`Gift certificate ${cancel.gc.GcNo} cancelled`)
    } catch (e) { setErr(e.message) }
  }

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />
  const preview = add ? nums(add) : []

  return (
    <div className="space-y-4">
      <ErrorBar message={!add && !cancel ? err : ''} onDismiss={() => setErr('')} />
      <Note tone="stone">
        The tills take only gift certificates in this list, once each. A GC pays at most the bill: no change is given and
        the rest of its value is forfeited. Switch it on per branch in POS Settings. Offline a till takes it and it's
        checked when the sale syncs; Reports → Gift Certificates shows any that need review.
      </Note>
      <div className="flex flex-wrap gap-2 items-center">
        {isAdmin && <Btn variant="primary" onClick={() => setAdd({ mode: 'batch', prefix: 'GC-', start: '1', count: '50', digits: '5',
          faceValue: '', issuedDate: localDate(), expiryDate: '', branchCode: '', issuedTo: '', note: '' })}>Add gift certificates</Btn>}
        <Select className="!w-44" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All</option>
          {Object.entries(GC_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input className="!w-72" placeholder="Search GC no. or issued to…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && setTerm(q.trim())} />
        <Btn onClick={() => setTerm(q.trim())}>Search</Btn>
      </div>

      <Table head={['GC no.', 'Value', 'Branch', 'Issued', 'Expires', 'Issued to', 'Status', 'Used / cancelled', '']}
        empty="No gift certificates yet." rows={data.map(g => [
          <span key={'n' + g.GcId} className="font-mono">{g.GcNo}</span>,
          <span key={'v' + g.GcId} className="tabnum font-bold">₱{peso(g.FaceValue)}</span>,
          g.BranchCode || 'Any', String(g.IssuedDate).slice(0, 10), g.ExpiryDate ? String(g.ExpiryDate).slice(0, 10) : 'No expiry',
          g.IssuedTo || '—', GC_STATUS[g.Status] || g.Status,
          g.Status === 'Redeemed' ? `${String(g.RedeemedAt || '').replace('T', ' ').slice(0, 16)} · ${g.RedeemedBranch || ''} ${g.RedeemedTerminal || ''}${g.RedeemedSi ? ` · SI ${g.RedeemedSi}` : ''}`
            : g.Status === 'Cancelled' ? `${String(g.CancelledAt || '').slice(0, 10)} · ${g.CancelReason || ''}` : '—',
          isAdmin && g.Status === 'Active'
            ? <button key={'c' + g.GcId} className="underline text-danger-fg" onClick={() => setCancel({ gc: g, reason: '' })}>Cancel</button> : ''])} />
      {data.length >= 500 && <p className="text-xs text-muted">Showing the newest 500. Search to find others.</p>}

      {add && (
        <Modal onClose={() => setAdd(null)} wide>
          <h2 className="font-bold text-lg">Add gift certificates</h2>
          <div className="flex gap-2">
            <Btn variant={add.mode === 'batch' ? 'moss' : 'ghost'} onClick={() => setAdd({ ...add, mode: 'batch' })}>A numbered batch</Btn>
            <Btn variant={add.mode === 'one' ? 'moss' : 'ghost'} onClick={() => setAdd({ ...add, mode: 'one', prefix: '' })}>One number</Btn>
          </div>
          {add.mode === 'one' ? (
            <Field label="GC number (as printed or in its barcode)"><Input autoFocus value={add.prefix} maxLength={30}
              onChange={e => setAdd({ ...add, prefix: e.target.value })} /></Field>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Prefix"><Input value={add.prefix} maxLength={20} onChange={e => setAdd({ ...add, prefix: e.target.value })} /></Field>
              <Field label="First number"><Input className="text-right tabnum" inputMode="numeric" value={add.start}
                onChange={e => setAdd({ ...add, start: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="How many (up to 1,000)"><Input className="text-right tabnum" inputMode="numeric" value={add.count}
                onChange={e => setAdd({ ...add, count: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Digits (zero-padded)"><Input className="text-right tabnum" inputMode="numeric" value={add.digits}
                onChange={e => setAdd({ ...add, digits: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
          )}
          {add.mode === 'batch' && preview.length > 0 && (
            <p className="text-sm text-muted">Numbers <span className="font-mono text-fg">{preview[0]}</span>
              {preview.length > 1 && <> to <span className="font-mono text-fg">{preview[1]}</span></>}</p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Face value ₱"><Input className="text-right tabnum" inputMode="decimal" value={add.faceValue}
              onChange={e => setAdd({ ...add, faceValue: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
            <Field label="Issued"><Input type="date" value={add.issuedDate} onChange={e => setAdd({ ...add, issuedDate: e.target.value })} /></Field>
            <Field label="Expires (blank = no expiry)"><Input type="date" value={add.expiryDate} onChange={e => setAdd({ ...add, expiryDate: e.target.value })} /></Field>
            <Field label="Good at">
              <Select value={add.branchCode} onChange={e => setAdd({ ...add, branchCode: e.target.value })}>
                <option value="">Every branch</option>
                {(branches.data || []).map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} {b.BranchName}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Issued to (optional)"><Input value={add.issuedTo} maxLength={120} placeholder="e.g. ABC Corp. Christmas"
              onChange={e => setAdd({ ...add, issuedTo: e.target.value })} /></Field>
            <Field label="Note (optional)"><Input value={add.note} maxLength={200}
              onChange={e => setAdd({ ...add, note: e.target.value })} /></Field>
          </div>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setAdd(null)}>Cancel</Btn>
            <Btn variant="primary" disabled={!(Number(add.faceValue) > 0) || !add.issuedDate || !preview[0]
              || (add.mode === 'batch' && !(Number(add.count) > 0))} onClick={save}>
              {add.mode === 'one' ? 'Add' : `Add ${Number(add.count) || 0}`}</Btn>
          </div>
        </Modal>
      )}

      {cancel && (
        <Modal onClose={() => setCancel(null)}>
          <h2 className="font-bold text-lg">Cancel gift certificate {cancel.gc.GcNo}</h2>
          <p className="text-sm text-muted">₱{peso(cancel.gc.FaceValue)}, not used yet. A cancelled GC can't be taken at the till.</p>
          <Field label="Reason"><Input autoFocus value={cancel.reason} maxLength={200} placeholder="e.g. reported lost"
            onChange={e => setCancel({ ...cancel, reason: e.target.value })} /></Field>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setCancel(null)}>Back</Btn>
            <Btn variant="danger" disabled={!cancel.reason.trim()} onClick={doCancel}>Cancel it</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Loyalty({ flash }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const { data: cfg, reload: reloadCfg } = useApi('/api/loyalty/settings')
  const { data, error, reload } = useApi(`/api/loyalty/cards?q=${encodeURIComponent(term)}`)
  const [setForm, setSetForm] = useState(null)
  const [edit, setEdit] = useState(null)
  const [hist, setHist] = useState(null)
  const [adj, setAdj] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (cfg) setSetForm({ isEnabled: !!cfg.IsEnabled, amountPerPoint: String(cfg.AmountPerPoint), programName: cfg.ProgramName })
  }, [cfg])

  const saveSettings = async () => {
    try {
      await api('/api/loyalty/settings', { method: 'PUT', body: JSON.stringify({
        isEnabled: setForm.isEnabled, amountPerPoint: Number(setForm.amountPerPoint), programName: setForm.programName }) })
      reloadCfg(); flash('Saved. Tills pick it up when their POS screen next loads.')
    } catch (e) { setErr(e.message) }
  }
  const saveCard = async () => {
    try {
      const body = JSON.stringify(edit)
      if (edit.cardId) await api(`/api/loyalty/cards/${edit.cardId}`, { method: 'PUT', body })
      else await api('/api/loyalty/cards', { method: 'POST', body })
      setEdit(null); reload(); flash('Card saved')
    } catch (e) { setErr(e.message) }
  }
  const openHistory = async (c) => {
    try { setHist({ card: c, rows: await api(`/api/loyalty/cards/${c.CardId}/history`) }) } catch (e) { setErr(e.message) }
  }
  const saveAdjust = async () => {
    try {
      const r = await api(`/api/loyalty/cards/${adj.card.CardId}/adjust`, { method: 'POST',
        body: JSON.stringify({ points: Number(adj.points), note: adj.note }) })
      setAdj(null); reload(); flash(`Adjusted. New balance: ${r.points} points`)
    } catch (e) { setErr(e.message) }
  }
  const KIND = { EARN: 'Earned', VOID: 'Sale voided', RETURN: 'Items returned', ADJUST: 'Adjustment' }

  if (error) return <ErrorBar message={error} />
  if (!data || !setForm) return <Spinner />
  const name = cfg?.ProgramName || 'Suki card'

  return (
    <div className="space-y-4">
      <ErrorBar message={!edit && !adj ? err : ''} onDismiss={() => setErr('')} />
      <div className="bg-panel rounded-2xl border border-line p-4 space-y-3 max-w-3xl">
        <h2 className="font-bold">How points are earned</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Field label="Program name (on the till and receipt)">
            <Input value={setForm.programName} maxLength={40} disabled={!isAdmin}
              onChange={e => setSetForm({ ...setForm, programName: e.target.value })} />
          </Field>
          <Field label="₱ paid for 1 point">
            <Input className="text-right tabnum" inputMode="decimal" value={setForm.amountPerPoint} disabled={!isAdmin}
              onChange={e => setSetForm({ ...setForm, amountPerPoint: e.target.value.replace(/[^0-9.]/g, '') })} />
          </Field>
          <label className="flex items-center gap-2 text-sm pb-3">
            <input type="checkbox" checked={setForm.isEnabled} disabled={!isAdmin}
              onChange={e => setSetForm({ ...setForm, isEnabled: e.target.checked })} /> Earning is on
          </label>
        </div>
        <p className="text-xs text-muted">
          Each sale with a card earns 1 point for every ₱{peso(Number(setForm.amountPerPoint) || 0)} paid (after
          discounts), rounded down: a ₱650 sale at ₱200 a point earns 3. Voids and returns take the points back.
          A new rate applies to sales sent from now on. Redeeming points comes later.
        </p>
        {isAdmin && <Btn variant="primary" onClick={saveSettings}>Save</Btn>}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Btn variant="primary" onClick={() => setEdit({ cardId: 0, cardNo: '', customerName: '', mobile: '', email: '', isActive: true })}>
          Register a card</Btn>
        <Input className="!w-72" placeholder="Search card no., name or mobile…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && setTerm(q.trim())} />
        <Btn onClick={() => setTerm(q.trim())}>Search</Btn>
      </div>

      <Table head={['Card no.', 'Name', 'Mobile', 'Points', 'Issued at', 'Active', '']} empty="No cards yet."
        rows={data.map(c => [c.CardNo, c.CustomerName, c.Mobile ? `0${c.Mobile}` : '—',
          <span key={'p' + c.CardId} className="tabnum font-bold">{c.Points}</span>,
          c.IssuedBranch || '—', c.IsActive ? 'Yes' : 'No',
          <span key={c.CardId} className="flex gap-3">
            <button className="underline text-accent-fg" onClick={() => setEdit({ cardId: c.CardId, cardNo: c.CardNo,
              customerName: c.CustomerName, mobile: c.Mobile ? `0${c.Mobile}` : '', email: c.Email || '', isActive: c.IsActive })}>Edit</button>
            <button className="underline text-accent-fg" onClick={() => openHistory(c)}>History</button>
            {isAdmin && <button className="underline text-accent-fg" onClick={() => setAdj({ card: c, points: '', note: '' })}>Adjust</button>}
          </span>])} />

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{edit.cardId ? `Edit card ${edit.cardNo}` : `Register a ${name}`}</h2>
          <Field label="Card number">
            <Input autoFocus={!edit.cardId} value={edit.cardNo} maxLength={50} disabled={!!edit.cardId}
              placeholder="Tap the card on the reader" onChange={e => setEdit({ ...edit, cardNo: e.target.value })} />
          </Field>
          <Field label="Customer name"><Input value={edit.customerName} maxLength={150}
            onChange={e => setEdit({ ...edit, customerName: e.target.value })} /></Field>
          <Field label="Mobile (optional, for a lookup without the card)"><Input value={edit.mobile} maxLength={20}
            inputMode="tel" placeholder="0917 123 4567" onChange={e => setEdit({ ...edit, mobile: e.target.value })} /></Field>
          <Field label="Email (optional)"><Input type="email" value={edit.email} maxLength={254}
            onChange={e => setEdit({ ...edit, email: e.target.value })} /></Field>
          {!!edit.cardId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.isActive}
                onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> Active (a switched-off card earns nothing)
            </label>
          )}
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" disabled={!edit.cardNo.trim() || !edit.customerName.trim()} onClick={saveCard}>Save</Btn>
          </div>
        </Modal>
      )}

      {hist && (
        <Modal onClose={() => setHist(null)} wide>
          <h2 className="font-bold text-lg">{hist.card.CustomerName} · card {hist.card.CardNo} · {hist.card.Points} points</h2>
          <Table head={['When', 'What', 'Points', 'Invoice / return', 'Branch', 'By / note']} empty="No points yet."
            rows={hist.rows.map(r => [String(r.CreatedAt).replace('T', ' ').slice(0, 16), KIND[r.Kind] || r.Kind,
              <span key={'h' + r.EntryId} className={`tabnum font-bold ${r.Points < 0 ? 'text-danger-fg' : ''}`}>{r.Points > 0 ? '+' : ''}{r.Points}</span>,
              r.Kind === 'RETURN' && r.ReturnNo ? `Return ${returnNo(r.ReturnNo)}` : r.ORNumber ? `${r.TerminalCode || ''} · SI ${r.ORNumber}` : '—',
              r.BranchCode || '—', [r.ByName, r.Note].filter(Boolean).join(' · ') || '—'])} />
          <Btn className="w-full" onClick={() => setHist(null)}>Close</Btn>
        </Modal>
      )}

      {adj && (
        <Modal onClose={() => setAdj(null)}>
          <h2 className="font-bold text-lg">Adjust {adj.card.CustomerName}'s points ({adj.card.Points})</h2>
          <Field label="Points to add (a minus number takes away)">
            <Input className="text-right tabnum" inputMode="numeric" value={adj.points}
              onChange={e => setAdj({ ...adj, points: e.target.value.replace(/[^0-9-]/g, '') })} />
          </Field>
          <Field label="Reason"><Input value={adj.note} maxLength={200} placeholder="e.g. moved from lost card 0012345"
            onChange={e => setAdj({ ...adj, note: e.target.value })} /></Field>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setAdj(null)}>Cancel</Btn>
            <Btn variant="primary" disabled={!Number(adj.points) || !adj.note.trim()} onClick={saveAdjust}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

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
    <span className="text-muted">to</span>
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
        <div className="bg-panel rounded-xl p-4 border border-line">
          <div className="text-sm font-semibold mb-3">Net sales — last 7 days</div>
          <div className="flex items-end gap-2 h-36">
            {bars.length === 0 && <p className="text-muted text-sm">No sales recorded yet.</p>}
            {bars.map((b, i) => (
              <div key={i} className="flex-1 h-full flex flex-col items-center justify-end gap-1"
                title={`${String(b.BusinessDate).slice(0, 10)}: ₱${peso(b.NetSales)}`}>
                <div className="w-full flex-1 flex items-end">
                  <div className="w-full bg-accent rounded-t-md" style={{ height: `${(Number(b.NetSales) / max) * 100}%` }} />
                </div>
                <span className="text-[10px] text-muted">{String(b.BusinessDate).slice(5, 10)}</span>
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
  <div className="bg-panel rounded-xl p-4 border border-line">
    <div className="text-[10px] tracking-[0.25em] uppercase text-muted">{label}</div>
    <div className="tabnum text-xl sm:text-2xl font-bold mt-1 break-words">{value}</div>
    {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
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
          <button key={b.BranchCode} className="underline text-accent-fg" onClick={() => setEdit({
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
  const { role } = useAuth()
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

      {role === 'Admin' && <ErpSync flash={flash} onDone={reload} />}

      <Table head={['', 'Barcode', 'ERP code', 'Name', 'Category', 'Unit', 'Base price', 'Branch overrides',
        'VATable', 'Discountable', 'Price edit', 'Active', '']}
        rows={rows.map(p => [
          <span key={'t' + p.ProductId} className="relative block w-9 h-9 rounded-lg overflow-hidden border border-line">
            <ProductThumb small name={p.ProductName} categoryId={p.CategoryId} imageUrl={p.ImageUrl} />
          </span>,
          p.Barcode, p.ErpProductCode || '—', p.ProductName, p.CategoryName, p.Unit,
          p.BasePrice > 0 || (p.AllowPriceEdit && !p.ErpProductCode)
            ? peso(p.BasePrice)
            : <span key={'np' + p.ProductId} className="text-warn-fg font-semibold">Needs price</span>,
          <button key={'o' + p.ProductId} className="underline text-accent-fg"
            onClick={() => setPrices(p)}>
            {p.OverrideCount === 0 ? 'none — uses base' : `${p.OverrideCount} branch${p.OverrideCount > 1 ? 'es' : ''}`}
          </button>,
          p.IsVatable ? 'Yes' : 'No',
          <span key={'d' + p.ProductId} className={p.IsDiscountable ? 'text-accent-fg font-semibold' : 'text-muted'}>
            {p.IsDiscountable ? 'Yes' : 'No'}
          </span>,
          p.AllowPriceEdit ? 'Allowed' : 'Locked',
          p.IsActive ? 'Yes' : 'No',
          <button key={p.ProductId} className="underline text-accent-fg" onClick={() => setEdit({
            productId: p.ProductId, barcode: p.Barcode, productName: p.ProductName,
            categoryId: p.CategoryId, unit: p.Unit, basePrice: p.BasePrice, cost: p.Cost,
            isVatable: p.IsVatable, isDiscountable: p.IsDiscountable,
            allowPriceEdit: p.AllowPriceEdit, isActive: p.IsActive, imageUrl: p.ImageUrl || '',
            erpProductCode: p.ErpProductCode })}>Edit</button>
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
            <span className="relative block w-20 h-20 rounded-xl overflow-hidden border border-line shrink-0">
              <ProductThumb name={edit.productName} categoryId={edit.categoryId} imageUrl={edit.imageUrl} />
            </span>
            <div className="space-y-1">
              <label className="inline-block">
                <span className={`select-none rounded-lg font-semibold min-h-[46px] px-4 inline-flex items-center bg-panel border border-line2 text-fg cursor-pointer ${uploading ? 'opacity-40' : ''}`}>
                  {uploading ? 'Uploading…' : edit.imageUrl ? 'Change photo' : 'Upload photo'}
                </span>
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={uploading}
                  onChange={e => pickImage(e.target.files?.[0])} />
              </label>
              {edit.imageUrl && (
                <button type="button" className="block text-xs underline text-muted"
                  onClick={() => setEdit({ ...edit, imageUrl: '' })}>Remove photo</button>
              )}
              <p className="text-xs text-muted">JPG, PNG or WEBP, up to 2MB. Shown as the thumbnail on the POS grid.</p>
            </div>
          </div>
          {edit.erpProductCode && (
            <Note tone="amber" title={`From the ERP (product code ${edit.erpProductCode})`}>
              Name, category, unit, cost, price (base and per branch), VATable, discountable and
              active come from the ERP and are overwritten on every sync, so they're locked here —
              change them in the ERP. Price editing at the till, barcode and photo stay yours.
            </Note>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Barcode"><Input value={edit.barcode}
              onChange={e => setEdit({ ...edit, barcode: e.target.value })} /></Field>
            <Field label="Product name"><Input value={edit.productName} disabled={!!edit.erpProductCode}
              onChange={e => setEdit({ ...edit, productName: e.target.value })} /></Field>
            <Field label="Category">
              <Select className="w-full" value={edit.categoryId} disabled={!!edit.erpProductCode}
                onChange={e => setEdit({ ...edit, categoryId: Number(e.target.value) })}>
                {cats.map(c => <option key={c.CategoryId} value={c.CategoryId}>{c.CategoryName}</option>)}
              </Select>
            </Field>
            <Field label="Unit">
              <Select className="w-full" value={edit.unit} disabled={!!edit.erpProductCode} onChange={e => setEdit({ ...edit, unit: e.target.value })}>
                {['kg', 'pc', 'pack', 'box', 'litre'].map(u => <option key={u}>{u}</option>)}
              </Select>
            </Field>
            <Field label="Base price (all branches)">
              <Input className="text-right tabnum" inputMode="decimal" value={edit.basePrice} disabled={!!edit.erpProductCode}
                onChange={e => setEdit({ ...edit, basePrice: Number(e.target.value) || 0 })} /></Field>
            <Field label="Cost">
              <Input className="text-right tabnum" inputMode="decimal" value={edit.cost} disabled={!!edit.erpProductCode}
                onChange={e => setEdit({ ...edit, cost: Number(e.target.value) || 0 })} /></Field>
          </div>
          <div className="flex gap-5 text-sm flex-wrap border-t border-line pt-3">
            {[['isVatable', 'VATable', '12% applies'],
              ['isDiscountable', 'Discountable', 'eligible for SC/PWD/NAAC/MOV/Solo'],
              ['allowPriceEdit', 'Price editable', 'at the till (needs a supervisor when the branch says so)'],
              ['isActive', 'Active', '']].map(([k, label, hint]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={edit[k]}
                  disabled={!!edit.erpProductCode && k !== 'allowPriceEdit'}
                  onChange={e => setEdit({ ...edit, [k]: e.target.checked })} />
                <span><strong>{label}</strong>{hint && <span className="text-muted"> — {hint}</span>}</span>
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

/** CORECS ERP master-data and price pull (ErpController / ErpSyncService). The ERP owns
 *  product identity, name, category, unit, flags, cost and price (SellingPrice per branch).
 *  Also runs by itself every Erp:AutoSyncMinutes. A product without a price at a branch
 *  stays off that branch's till. */
function ErpSync({ flash, onDone }) {
  const { data: status, reload } = useApi('/api/erp/status')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  const run = async () => {
    setBusy(true); setErr(''); setResult(null)
    try {
      const r = await api('/api/erp/sync-master-data', { method: 'POST' })
      setResult(r); reload(); onDone(); flash('ERP sync finished')
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!status) return null
  const s = result?.summary
  return (
    <div className="bg-panel rounded-xl p-4 border border-line space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-sm">
          <div className="font-semibold">ERP products, prices, categories and branches</div>
          <div className="text-muted">
            {!status.configured ? 'Not connected — set ConnectionStrings:Erp on the server.'
              : status.lastSync ? `Last sync ${String(status.lastSync.CreatedAt).replace('T', ' ').slice(0, 16)}`
                + (status.lastSync.FullName ? ` by ${status.lastSync.FullName}` : '')
              : 'Never synced.'}
            {status.autoSyncMinutes > 0 && ` · runs by itself every ${status.autoSyncMinutes} min`}
          </div>
        </div>
        <Btn variant="dark" className="ml-auto" disabled={!status.configured || busy} onClick={run}>
          {busy ? 'Syncing…' : 'Sync from ERP'}
        </Btn>
      </div>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {s && (
        <div className="text-sm space-y-2 border-t border-line pt-2">
          <p>
            Received {result.received.products} products, {result.received.categories} categories,{' '}
            {result.received.branches} branches. Products: {s.ProductsAdded} added, {s.ProductsUpdated} updated,{' '}
            {s.ProductsLinked} linked, {s.ProductsDeactivated} deactivated. Categories: {s.CategoriesAdded} added,{' '}
            {s.CategoriesUpdated} updated, {s.CategoriesLinked} linked, {s.CategoriesDeactivated} deactivated.
            Branches: {s.BranchesAdded} added, {s.BranchesUpdated} updated.
            {s.PricesApplied
              ? ` Prices: ${s.BasePricesUpdated} base and ${s.BranchPricesChanged} branch price(s) changed.` +
                (s.LevelsSent ? ` Price levels: received${s.BaseLevelsUpdated ? `, ${s.BaseLevelsUpdated} head-office row(s) changed` : ''}.` : '')
              : ' Prices: none received from the ERP, left as they are.'}
          </p>
          {result.notes?.map(n => <Note key={n} tone="amber">{n}</Note>)}
          {s.ProductsNeedPrice > 0 && (
            <Note tone="amber">{s.ProductsNeedPrice} ERP product(s) have no head-office price yet. A product
              without a price at a branch stays off that branch's till until head office sets its
              SellingPrice in the ERP.</Note>
          )}
          {s.LocalProductsActive > 0 && (
            <Note tone="amber">{s.LocalProductsActive} active product(s) aren't from the ERP (no ERP code).
              The sync leaves them alone — deactivate them here if they shouldn't be sold.</Note>
          )}
          {result.issues.length > 0 && (
            <Table head={['Item', 'Code', 'What happened']}
              rows={result.issues.map(i => [i.Kind, i.Code || '—', i.Message])} />
          )}
        </div>
      )}
    </div>
  )
}

function BranchPriceModal({ product, onClose, flash }) {
  const fromErp = !!product.ErpProductCode   // ERP prices are read-only here
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
        <p className="text-sm text-muted">
          Base price ₱{peso(product.BasePrice)} applies to every branch not listed here.
        </p>
      </div>
      {fromErp && (
        <Note tone="amber" title="Prices come from the ERP">
          Head office sets each branch's SellingPrice in the ERP; the sync copies it here. To
          charge a different price for one sale, edit it at the till with a supervisor.
        </Note>
      )}
      <div className="border border-line rounded-lg divide-y divide-line max-h-72 overflow-y-auto">
        {rows.map((r, i) => {
          const diff = (Number(r.price) || 0) - product.BasePrice
          return (
            <div key={r.branchCode} className="px-3 py-2 flex items-center gap-3 text-sm">
              <span className="font-semibold w-16">{r.branchCode}</span>
              <span className="flex-1 text-muted truncate">
                {branches.find(b => b.BranchCode === r.branchCode)?.BranchName}
              </span>
              <Input className="!w-32 !min-h-[38px] text-right tabnum" inputMode="decimal" value={r.price}
                disabled={fromErp}
                onChange={e => setRows(rs => rs.map((x, j) =>
                  j === i ? { ...x, price: e.target.value.replace(/[^0-9.]/g, '') } : x))} />
              <span className={`tabnum text-xs w-16 text-right ${diff > 0 ? 'text-danger-fg' : diff < 0 ? 'text-accent-fg' : 'text-muted'}`}>
                {diff > 0 ? '+' : ''}{peso(diff)}
              </span>
              {!fromErp && <button className="text-danger-fg text-lg"
                onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>×</button>}
            </div>
          )
        })}
        {!rows.length && (
          <p className="px-3 py-6 text-muted text-sm text-center">
            No overrides — every branch sells at ₱{peso(product.BasePrice)}.
          </p>
        )}
      </div>
      {!fromErp && unused.length > 0 && (
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
      {fromErp
        ? <Btn variant="dark" className="w-full" onClick={onClose}>Close</Btn>
        : <div className="grid grid-cols-2 gap-3">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" onClick={save}>Save prices</Btn>
          </div>}
    </Modal>
  )
}

/* ================= Price Lists ================= */
/* ================= Promos: Buy N Take M (34_promos.sql) ================= */
const PROMO_KINDS = {
  SAME: { label: 'Same item', desc: 'Each qualifying item on its own: every N + M of it, M are free (B1T1 Siomai).' },
  GROUP: { label: 'Mix and match', desc: 'The qualifying items count together: every N + M, the M cheapest are free (any 2 ice creams).' },
  GIFT: { label: 'Free gift item', desc: 'Every N qualifying items bought, M of the gift item are free (shampoo + free sachet).' }
}

/** Promos run between two dates at chosen branches (none = every branch) and apply at the till by
 *  themselves. The free item prints at its full price less the promo; with a senior/PWD discount
 *  the customer gets the promo or the discount, whichever is worth more. */
function Promos({ flash }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const { data: list, error, reload } = useApi('/api/promos')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')
  if (error) return <ErrorBar message={error} />
  if (!list) return <Spinner />
  const today = new Date().toISOString().slice(0, 10)
  const status = (p) => !p.IsActive ? ['Off', 'text-muted'] : String(p.EndDate).slice(0, 10) < today ? ['Ended', 'text-muted']
    : String(p.StartDate).slice(0, 10) > today ? ['Starts later', 'text-warn-fg'] : ['Running', 'text-accent-fg font-semibold']
  const remove = async (p) => {
    if (!window.confirm(`Delete the promo ${p.PromoName}?`)) return
    try { await api(`/api/promos/${p.PromoId}`, { method: 'DELETE' }); reload(); flash('Promo deleted') } catch (e) { setErr(e.message) }
  }
  const open = (row) => setEdit(row ? {
    promoId: row.promo.PromoId, promoName: row.promo.PromoName, kind: row.promo.Kind, buyQty: String(row.promo.BuyQty),
    freeQty: String(row.promo.FreeQty), freeProduct: row.promo.FreeProductId
      ? { id: row.promo.FreeProductId, label: `${row.promo.FreeProductName} (${row.promo.FreeProductCode || ''})` } : null,
    maxFree: row.promo.MaxFreePerSale ? String(row.promo.MaxFreePerSale) : '',
    startDate: String(row.promo.StartDate).slice(0, 10), endDate: String(row.promo.EndDate).slice(0, 10), isActive: !!row.promo.IsActive,
    items: row.items.filter(i => i.ProductId).map(i => ({ id: i.ProductId, label: `${i.ProductName} (${i.ErpProductCode || ''})` })),
    categoryIds: row.items.filter(i => i.CategoryId).map(i => i.CategoryId), branches: [...row.branches]
  } : { promoName: '', kind: 'SAME', buyQty: '1', freeQty: '1', freeProduct: null, maxFree: '', startDate: today,
    endDate: today, isActive: true, items: [], categoryIds: [], branches: [] })

  return (
    <div className="space-y-3">
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />
      <Note tone="stone" title="How promos work">
        Buy N, take M free: same item (B1T1), mix and match (the cheapest free), or a free gift item. They run between
        their dates at the chosen branches and apply at the till by themselves, for items sold by the piece (not weighed,
        not at a wholesale price). The free item must be in the cart; the till says when one more is free. It prints
        at its full price less the promo. With a senior/PWD discount the customer gets the promo or the discount,
        whichever is worth more. Tills pick changes up at their next Cash Begin. Reports → Promos lists them.
      </Note>
      {isAdmin && <Btn variant="primary" onClick={() => open(null)}>Add promo</Btn>}
      <Table head={['Promo', 'Kind', 'Buy / take', 'Applies to', 'Branches', 'Dates', 'Status', '']}
        rows={list.map(row => {
          const p = row.promo, [st, cls] = status(p)
          return [
            p.PromoName, PROMO_KINDS[p.Kind]?.label || p.Kind,
            `Buy ${p.BuyQty} take ${p.FreeQty}${p.MaxFreePerSale ? ` (max ${p.MaxFreePerSale} free)` : ''}${p.Kind === 'GIFT' ? ` · gift: ${p.FreeProductName}` : ''}`,
            row.items.map(i => i.ProductName || `All ${i.CategoryName}`).join(', '),
            row.branches.length ? row.branches.join(', ') : 'Every branch',
            `${String(p.StartDate).slice(0, 10)} to ${String(p.EndDate).slice(0, 10)}`,
            <span key={'s' + p.PromoId} className={cls}>{st}</span>,
            isAdmin ? <span key={p.PromoId} className="flex gap-2">
              <button className="underline text-accent-fg" onClick={() => open(row)}>Edit</button>
              <button className="underline text-danger-fg" onClick={() => remove(p)}>Delete</button>
            </span> : ''
          ]
        })} />
      {!list.length && <p className="text-sm text-muted">No promos yet.</p>}
      {edit && <PromoModal edit={edit} setEdit={setEdit} err={err} setErr={setErr} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); reload(); flash('Saved. Tills pick it up at their next Cash Begin.') }} />}
    </div>
  )
}

function PromoModal({ edit, setEdit, err, setErr, onClose, onSaved }) {
  const { data: products } = useApi('/api/products')
  const { data: cats } = useApi('/api/products/categories')
  const { data: branches } = useApi('/api/branches')
  const [find, setFind] = useState('')
  const [findGift, setFindGift] = useState('')
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value })
  const search = (q) => !q.trim() || !products ? [] : products.filter(p => p.IsActive && (p.ProductName.toLowerCase().includes(q.trim().toLowerCase())
    || (p.ErpProductCode || '').toLowerCase().includes(q.trim().toLowerCase()) || (p.Barcode || '').toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 6)
  const label = (p) => `${p.ProductName} (${p.ErpProductCode || p.Barcode})`
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v])
  const addItem = (p) => { if (!edit.items.some(i => i.id === p.ProductId)) setEdit({ ...edit, items: [...edit.items, { id: p.ProductId, label: label(p) }] }); setFind('') }
  const nothingPicked = !edit.items.length && !edit.categoryIds.length
  const save = async () => {
    // typing an item's name doesn't pick it: say so instead of the server's "pick the items"
    if (nothingPicked) {
      setErr(find.trim() ? 'The item isn\'t added yet: click it in the list under the search box (or press Enter), so it shows as a green tag.'
        : 'Add at least one item (type its name or code, then click it in the list), or pick a whole category.')
      return
    }
    try {
      const body = JSON.stringify({ promoName: edit.promoName, kind: edit.kind, buyQty: Number(edit.buyQty), freeQty: Number(edit.freeQty),
        freeProductId: edit.kind === 'GIFT' ? edit.freeProduct?.id ?? null : null, maxFreePerSale: edit.maxFree ? Number(edit.maxFree) : null,
        startDate: edit.startDate, endDate: edit.endDate, isActive: edit.isActive,
        productIds: edit.items.map(i => i.id), categoryIds: edit.categoryIds, branches: edit.branches })
      if (edit.promoId) await api(`/api/promos/${edit.promoId}`, { method: 'PUT', body })
      else await api('/api/promos', { method: 'POST', body })
      onSaved()
    } catch (e) { setErr(e.message) }
  }
  return (
    <Modal onClose={onClose} wide>
      <h2 className="font-bold text-lg">{edit.promoId ? 'Edit promo' : 'Add promo'}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Name (prints on the invoice)"><Input value={edit.promoName} maxLength={40} placeholder="B1T1 Siomai" onChange={set('promoName')} /></Field>
        <Field label="Buy"><Input type="number" min="1" max="99" value={edit.buyQty} onChange={set('buyQty')} /></Field>
        <Field label="Take free"><Input type="number" min="1" max="99" value={edit.freeQty} onChange={set('freeQty')} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Object.entries(PROMO_KINDS).map(([k, v]) => (
          <Btn key={k} variant={edit.kind === k ? 'moss' : 'ghost'} onClick={() => setEdit({ ...edit, kind: k })}>{v.label}</Btn>
        ))}
      </div>
      <p className="text-xs text-muted">{PROMO_KINDS[edit.kind].desc}</p>

      <Field label={edit.kind === 'GIFT' ? 'Items the customer buys' : 'Items that qualify'}>
        <Input value={find} placeholder={products ? 'Type an item name or code, then click it below to add it' : 'Loading items…'}
          onChange={e => setFind(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const r = search(find); if (r.length) addItem(r[0]) } }} />
      </Field>
      {search(find).map((p, n) => (
        <button key={p.ProductId} className={`flex w-full items-center gap-2 text-left text-sm rounded-lg border px-3 py-1.5 hover:bg-raised ${n === 0 ? 'border-accent/60' : 'border-line2'}`}
          onClick={() => addItem(p)}>
          <span className="font-semibold text-accent-fg">+ Add</span>
          <span>{p.ProductName} <span className="text-muted">· {p.ErpProductCode || p.Barcode} · {p.Unit} · ₱{peso(p.BasePrice)}</span></span>
          {n === 0 && <span className="ml-auto text-xs text-muted">Enter</span>}
        </button>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{edit.items.length ? 'Items in this promo (click to remove):' : 'No items added yet.'}</span>
        {edit.items.map(i => (
          <button key={i.id} className="rounded-full border border-accent bg-accent/10 text-accent-fg px-3 py-1 text-sm"
            onClick={() => setEdit({ ...edit, items: edit.items.filter(x => x.id !== i.id) })}>{i.label} ×</button>
        ))}
      </div>
      <Field label="…or whole categories (optional: every item of the category qualifies, e.g. all Canned Foods)">
        <div className="flex flex-wrap gap-2">
          {(cats || []).map(c => (
            <button key={c.CategoryId} className={`rounded-full border px-3 py-1 text-sm ${edit.categoryIds.includes(c.CategoryId) ? 'border-accent text-accent-fg bg-accent/10' : 'border-line2 text-muted'}`}
              onClick={() => setEdit({ ...edit, categoryIds: toggle(edit.categoryIds, c.CategoryId) })}>{c.CategoryName}</button>
          ))}
        </div>
      </Field>

      {edit.kind === 'GIFT' && (
        <>
          {edit.freeProduct
            ? <p className="text-sm">Free gift item: <b>{edit.freeProduct.label}</b>
                <button className="ml-2 underline text-accent-fg" onClick={() => setEdit({ ...edit, freeProduct: null })}>change</button></p>
            : <Field label="Free gift item"><Input value={findGift} placeholder="Type the gift item's name or code" onChange={e => setFindGift(e.target.value)} /></Field>}
          {!edit.freeProduct && search(findGift).map(p => (
            <button key={p.ProductId} className="block w-full text-left text-sm rounded-lg border border-line2 px-3 py-1.5 hover:bg-raised"
              onClick={() => { setEdit({ ...edit, freeProduct: { id: p.ProductId, label: label(p) } }); setFindGift('') }}>
              {p.ProductName} <span className="text-muted">· {p.ErpProductCode || p.Barcode} · ₱{peso(p.BasePrice)}</span>
            </button>
          ))}
        </>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="From"><Input type="date" value={edit.startDate} onChange={set('startDate')} /></Field>
        <Field label="To (last day)"><Input type="date" value={edit.endDate} onChange={set('endDate')} /></Field>
        <Field label="Max free items per sale (optional)"><Input type="number" min="1" value={edit.maxFree} placeholder="No limit" onChange={set('maxFree')} /></Field>
      </div>
      <Field label="Branches (none picked = every branch)">
        <div className="flex flex-wrap gap-2">
          {(branches || []).map(b => (
            <button key={b.BranchCode} className={`rounded-full border px-3 py-1 text-sm ${edit.branches.includes(b.BranchCode) ? 'border-accent text-accent-fg bg-accent/10' : 'border-line2 text-muted'}`}
              onClick={() => setEdit({ ...edit, branches: toggle(edit.branches, b.BranchCode) })}>{b.BranchCode} {b.BranchName}</button>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={edit.isActive} onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> On
      </label>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save}>Save</Btn>
      </div>
    </Modal>
  )
}

/* ================= Wholesale prices by quantity (33_wholesale.sql) ================= */
/** From a minimum quantity of an item in one sale (the item's total across its lines), every unit
 *  is a set amount cheaper. A rule is for an item or a whole category, for every branch or one.
 *  Several minimums are tiers (the highest reached applies). An item follows the first that has
 *  rules for it: the item at this branch, the item at every branch, its category at this branch,
 *  its category at every branch; an item rule switched off excludes the item. A branch can have
 *  wholesale off altogether. Tills pick changes up at Cash Begin. */
function Wholesale({ flash }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const { data: rules, error, reload } = useApi('/api/wholesale/rules')
  const { data: branches } = useApi('/api/branches')
  const { data: cats } = useApi('/api/products/categories')
  const { data: wb, reload: reloadWb } = useApi('/api/wholesale/branches')
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  if (error) return <ErrorBar message={error} />
  if (!rules || !branches || !cats || !wb) return <Spinner />
  const term = q.trim().toLowerCase()
  const shown = rules.filter(r => !term || (r.ProductName || '').toLowerCase().includes(term)
    || (r.CategoryName || '').toLowerCase().includes(term)
    || (r.ErpProductCode || '').toLowerCase().includes(term) || (r.Barcode || '').toLowerCase().includes(term))

  const save = async () => {
    try {
      const body = JSON.stringify({
        productId: edit.kind === 'item' ? edit.productId : null, categoryId: edit.kind === 'category' ? Number(edit.categoryId) : null,
        branchCode: edit.branchCode || null, isActive: edit.isActive,
        // a rule switched off only excludes: its numbers never apply
        minQty: edit.isActive ? Number(edit.minQty) : Number(edit.minQty) || 1, amountOff: edit.isActive ? Number(edit.amountOff) : Number(edit.amountOff) || 0.01 })
      if (edit.ruleId) await api(`/api/wholesale/rules/${edit.ruleId}`, { method: 'PUT', body })
      else await api('/api/wholesale/rules', { method: 'POST', body })
      setEdit(null); reload(); flash('Saved. Tills pick it up at their next Cash Begin.')
    } catch (e) { setErr(e.message) }
  }
  const remove = async (r) => {
    if (!window.confirm(`Delete the wholesale rule for ${r.ProductName || `category ${r.CategoryName}`} from ${Number(r.MinQty)}?`)) return
    try { await api(`/api/wholesale/rules/${r.RuleId}`, { method: 'DELETE' }); reload(); flash('Rule deleted') }
    catch (e) { setErr(e.message) }
  }
  const toggleBranch = async (b) => {
    try {
      await api(`/api/wholesale/branches/${b.BranchCode}`, { method: 'PUT', body: JSON.stringify({ wholesaleOn: !b.WholesaleOn }) })
      reloadWb(); flash(`Wholesale ${b.WholesaleOn ? 'off' : 'on'} at ${b.BranchCode}`)
    } catch (e) { setErr(e.message) }
  }
  const qty = (v) => Number(v).toLocaleString('en-PH', { maximumFractionDigits: 3 })

  return (
    <div className="space-y-3">
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />
      <Note tone="stone" title="How wholesale works">
        From the minimum quantity of an item in one sale (all its stickers / lines added up), every unit costs the
        amount less: e.g. all pork items from 5 kg, ₱5 off each kg. A rule is for a whole category or one item; an
        item's own rules win over its category's, and an item rule switched off excludes the item. Several minimums
        are tiers; the highest one reached applies. With a senior/PWD discount the customer gets the wholesale price or
        the discount, whichever is worth more, never both (the till picks it item by item). Sales at a wholesale price
        are in Reports → Wholesale (DTI).
      </Note>

      <div className="bg-panel rounded-2xl border border-line p-4 space-y-2">
        <h2 className="font-bold">Branches with wholesale</h2>
        <div className="flex flex-wrap gap-2">
          {wb.filter(b => b.Terminals > 0 || !b.WholesaleOn).map(b => (
            <button key={b.BranchCode} disabled={!isAdmin} onClick={() => toggleBranch(b)}
              className={`rounded-full border px-3 py-1 text-sm ${b.WholesaleOn ? 'border-accent text-accent-fg bg-accent/10' : 'border-line2 text-muted'}`}>
              {b.BranchCode} {b.BranchName} · {b.WholesaleOn ? 'on' : 'off'}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">Branches with tills are listed. Off = no wholesale price at that branch, whatever the rules say.</p>
      </div>

      <div className="flex gap-2 items-end flex-wrap">
        <Field label="Search"><Input className="!w-72" value={q} placeholder="Item, code or category" onChange={e => setQ(e.target.value)} /></Field>
        {isAdmin && <Btn variant="primary" onClick={() => setEdit({ kind: 'category', productId: null, productLabel: '',
          categoryId: '', branchCode: '', minQty: '5', amountOff: '', isActive: true })}>Add wholesale rule</Btn>}
      </div>
      <Table head={['Applies to', 'Code', 'Branch', 'From qty', 'Off per unit', 'Status', '']}
        rows={shown.map(r => [
          r.CategoryId ? <span key={'t' + r.RuleId}><b>All {r.CategoryName}</b> <span className="text-muted">({r.CategoryItems} items)</span></span> : r.ProductName,
          r.CategoryId ? '—' : (r.ErpProductCode || r.Barcode),
          r.BranchCode ? `${r.BranchCode} ${r.BranchName || ''}` : 'Every branch',
          r.IsActive ? qty(r.MinQty) : '—', r.IsActive ? `₱${peso(r.AmountOff)}` : '—',
          <span key={'s' + r.RuleId} className={r.IsActive ? 'text-accent-fg font-semibold' : 'text-warn-fg'}>
            {r.IsActive ? 'On' : r.CategoryId ? 'Off' : 'Off (excluded)'}</span>,
          isAdmin ? <span key={r.RuleId} className="flex gap-2">
            <button className="underline text-accent-fg" onClick={() => setEdit({ ruleId: r.RuleId, kind: r.CategoryId ? 'category' : 'item',
              productId: r.ProductId, productLabel: r.ProductId ? `${r.ProductName} (${r.ErpProductCode || r.Barcode})` : '',
              categoryId: r.CategoryId ? String(r.CategoryId) : '', branchCode: r.BranchCode || '',
              minQty: String(Number(r.MinQty)), amountOff: String(Number(r.AmountOff)), isActive: !!r.IsActive })}>Edit</button>
            <button className="underline text-danger-fg" onClick={() => remove(r)}>Delete</button>
          </span> : ''
        ])} />
      {!shown.length && <p className="text-sm text-muted">No wholesale rules{term ? ' match' : ' yet'}.</p>}
      {edit && <WholesaleRuleModal edit={edit} setEdit={setEdit} branches={branches} cats={cats} err={err} setErr={setErr}
        onClose={() => setEdit(null)} onSave={save} />}
    </div>
  )
}

function WholesaleRuleModal({ edit, setEdit, branches, cats, err, setErr, onClose, onSave }) {
  const { data: products } = useApi('/api/products')
  const [find, setFind] = useState('')
  const t = find.trim().toLowerCase()
  const matches = !t || !products ? [] : products.filter(p => p.IsActive && (p.ProductName.toLowerCase().includes(t)
    || (p.ErpProductCode || '').toLowerCase().includes(t) || (p.Barcode || '').toLowerCase().includes(t))).slice(0, 8)
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value })
  const targetOk = edit.kind === 'item' ? !!edit.productId : !!edit.categoryId
  return (
    <Modal onClose={onClose}>
      <h2 className="font-bold text-lg">{edit.ruleId ? 'Edit wholesale rule' : 'Add wholesale rule'}</h2>
      {!edit.ruleId && (
        <div className="grid grid-cols-2 gap-2">
          {[['category', 'A whole category'], ['item', 'One item']].map(([k, label]) => (
            <Btn key={k} variant={edit.kind === k ? 'moss' : 'ghost'} onClick={() => setEdit({ ...edit, kind: k })}>{label}</Btn>
          ))}
        </div>
      )}
      {edit.kind === 'category' ? (
        <Field label="Category">
          <Select value={edit.categoryId} onChange={set('categoryId')} disabled={!!edit.ruleId}>
            <option value="">Pick a category</option>
            {cats.map(c => <option key={c.CategoryId} value={c.CategoryId}>{c.CategoryName}</option>)}
          </Select>
        </Field>
      ) : edit.productId
        ? <p className="text-sm">Item: <b>{edit.productLabel}</b>{!edit.ruleId &&
            <button className="ml-2 underline text-accent-fg" onClick={() => setEdit({ ...edit, productId: null, productLabel: '' })}>change</button>}</p>
        : (
          <>
            <Field label="Item"><Input autoFocus value={find} placeholder={products ? 'Type the name or code' : 'Loading items…'}
              onChange={e => setFind(e.target.value)} /></Field>
            {matches.map(p => (
              <button key={p.ProductId} className="block w-full text-left text-sm rounded-lg border border-line2 px-3 py-2 hover:bg-raised"
                onClick={() => setEdit({ ...edit, productId: p.ProductId, productLabel: `${p.ProductName} (${p.ErpProductCode || p.Barcode})` })}>
                {p.ProductName} <span className="text-muted">· {p.ErpProductCode || p.Barcode} · {p.CategoryName} · {p.Unit} · ₱{peso(p.BasePrice)}</span>
              </button>
            ))}
          </>
        )}
      <Field label="Branch">
        <Select value={edit.branchCode} onChange={set('branchCode')}>
          <option value="">Every branch</option>
          {branches.map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>)}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!edit.isActive} onChange={e => setEdit({ ...edit, isActive: !e.target.checked })} />
        {edit.kind === 'item' ? 'Exclude this item from wholesale (whatever its category says)' : 'Switch this rule off'}
      </label>
      {edit.isActive && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From quantity (kg / pcs) in one sale"><Input type="number" inputMode="decimal" min="0" step="0.001"
            value={edit.minQty} onChange={set('minQty')} /></Field>
          <Field label="₱ off per kg / pc"><Input type="number" inputMode="decimal" min="0" step="0.01"
            value={edit.amountOff} onChange={set('amountOff')} /></Field>
        </div>
      )}
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-2 gap-3">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={!targetOk || (edit.isActive && (!(Number(edit.minQty) > 0) || !(Number(edit.amountOff) > 0)))}
          onClick={onSave}>Save</Btn>
      </div>
    </Modal>
  )
}

/** Price levels Price1..4 (31_price_levels.sql): the ERP has no names for them, so they're named
 *  and switched on here. A level that's on shows at every till as a choice for the whole sale. */
function PriceLevelsCard({ flash, onSaved }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const { data, reload } = useApi('/api/settings/price-levels')
  const [form, setForm] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (data) setForm(data.map(l => ({ priceLevel: l.PriceLevel, levelName: l.LevelName, isActive: !!l.IsActive })))
  }, [data])
  if (!data) return null
  if (!data.length) return <Note tone="amber">Price levels need database update 31 (31_price_levels.sql).</Note>
  if (!form) return null
  const set = (i, k, v) => setForm(form.map((l, j) => (j === i ? { ...l, [k]: v } : l)))
  const save = async () => {
    try {
      await api('/api/settings/price-levels', { method: 'PUT', body: JSON.stringify(form) })
      reload(); onSaved?.(); flash('Saved. Tills pick it up when their POS screen next loads.')
    } catch (e) { setErr(e.message) }
  }
  return (
    <div className="bg-panel rounded-2xl border border-line p-4 space-y-3 max-w-3xl">
      <h2 className="font-bold">Price levels</h2>
      <p className="text-xs text-muted">
        The ERP's Price 1 to Price 4, set by head office per branch. A level that's on can be picked at the till
        for a whole sale; an item without that level sells at its regular price (SellingPrice), which stays the
        default. Any cashier can pick one, and the invoice shows which.
      </p>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {form.map((l, i) => (
          <div key={l.priceLevel} className="flex items-end gap-3">
            <Field label={`ERP Price ${l.priceLevel} — name at the till`}>
              <Input value={l.levelName} maxLength={30} disabled={!isAdmin} onChange={e => set(i, 'levelName', e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm pb-3 shrink-0">
              <input type="checkbox" checked={l.isActive} disabled={!isAdmin} onChange={e => set(i, 'isActive', e.target.checked)} /> On
            </label>
          </div>
        ))}
      </div>
      {isAdmin && <Btn variant="primary" onClick={save}>Save</Btn>}
    </div>
  )
}

/** 40: a price level by time of day, e.g. Price 1 from 7 PM. Per terminal, per branch or every branch:
 *  a till uses its own if it has any, else its branch's, else every branch's. Applied from the next
 *  sale; the cashier can still put a sale back to the regular price. */
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const daysText = (d) => d === 'YYYYYYY' ? 'Every day' : d === 'YYYYYNN' ? 'Mon–Fri' : d === 'NNNNNYY' ? 'Sat–Sun'
  : DAY_NAMES.filter((_, i) => d[i] === 'Y').join(', ')
const hm12 = (t) => { const [h, m] = String(t).split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` }
function PriceSchedulesCard({ flash, branches, levels }) {
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const { data, error, reload } = useApi('/api/price-schedules')
  const terminals = useApi('/api/terminals')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')
  const name = (lvl) => (levels || []).find(l => l.PriceLevel === lvl)?.LevelName || `Price ${lvl}`
  const save = async () => {
    try {
      const body = JSON.stringify({ ...edit, terminalId: edit.terminalId ? Number(edit.terminalId) : null, priceLevel: Number(edit.priceLevel) })
      if (edit.scheduleId) await api(`/api/price-schedules/${edit.scheduleId}`, { method: 'PUT', body })
      else await api('/api/price-schedules', { method: 'POST', body })
      setEdit(null); reload(); flash('Saved. Tills pick it up when their POS screen next loads.')
    } catch (e) { setErr(e.message) }
  }
  const del = async (r) => {
    if (!confirm(`Delete the schedule ${name(r.PriceLevel)} ${hm12(r.StartTime)}–${hm12(r.EndTime)}?`)) return
    try { await api(`/api/price-schedules/${r.ScheduleId}`, { method: 'DELETE' }); reload(); flash('Schedule deleted') } catch (e) { setErr(e.message) }
  }
  if (error) return <Note tone="amber">{error}</Note>
  if (!data) return null
  const termsOf = (b) => (terminals.data || []).filter(t => t.BranchCode === b && t.IsActive)
  return (
    <div className="bg-panel rounded-2xl border border-line p-4 space-y-3 max-w-4xl">
      <h2 className="font-bold">Price level by time of day</h2>
      <p className="text-xs text-muted">
        The till switches to a price level by itself, e.g. Price 1 from 7:00 PM. It starts with the next sale (a sale being
        rung up keeps its prices), and the cashier can still put a sale back to the regular price. A till follows its own
        schedules if it has any, else its branch's, else the ones for every branch. The end time isn't included: 7:00 PM to
        12:00 AM runs until midnight.
      </p>
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />
      <Table head={['For', 'Price level', 'From', 'Until', 'Days', 'On', 'Note', '']} empty="No schedules: every till sells at the regular price."
        rows={data.map(r => [r.TerminalId ? `${r.BranchCode} · ${r.TerminalCode} only` : r.BranchCode ? `Branch ${r.BranchCode}` : 'Every branch',
          name(r.PriceLevel), hm12(r.StartTime), hm12(r.EndTime), daysText(r.Days), r.IsActive ? 'Yes' : 'No', r.Note || '—',
          isAdmin ? <span key={r.ScheduleId} className="flex gap-3">
            <button className="underline text-accent-fg" onClick={() => setEdit({ scheduleId: r.ScheduleId, branchCode: r.BranchCode || '',
              terminalId: r.TerminalId ? String(r.TerminalId) : '', priceLevel: String(r.PriceLevel), startTime: r.StartTime, endTime: r.EndTime,
              days: r.Days, isActive: r.IsActive, note: r.Note || '' })}>Edit</button>
            <button className="underline text-danger-fg" onClick={() => del(r)}>Delete</button></span> : ''])} />
      {isAdmin && <Btn variant="primary" onClick={() => setEdit({ branchCode: '', terminalId: '', priceLevel: '1', startTime: '19:00',
        endTime: '00:00', days: 'YYYYYYY', isActive: true, note: '' })}>Add a schedule</Btn>}

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{edit.scheduleId ? 'Edit schedule' : 'Add a schedule'}</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <Select value={edit.branchCode} onChange={e => setEdit({ ...edit, branchCode: e.target.value, terminalId: '' })}>
                <option value="">Every branch</option>
                {(branches || []).map(b => <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} {b.BranchName}</option>)}
              </Select>
            </Field>
            <Field label="Terminal">
              <Select value={edit.terminalId} disabled={!edit.branchCode} onChange={e => setEdit({ ...edit, terminalId: e.target.value })}>
                <option value="">All the branch's tills</option>
                {termsOf(edit.branchCode).map(t => <option key={t.TerminalId} value={t.TerminalId}>{t.TerminalCode}{t.PosType ? ` (${t.PosType})` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Price level">
              <Select value={edit.priceLevel} onChange={e => setEdit({ ...edit, priceLevel: e.target.value })}>
                {[1, 2, 3, 4].map(l => <option key={l} value={l}>{name(l)}</option>)}
              </Select>
            </Field>
            <div />
            <Field label="From"><Input type="time" value={edit.startTime} onChange={e => setEdit({ ...edit, startTime: e.target.value })} /></Field>
            <Field label="Until (not included)"><Input type="time" value={edit.endTime} onChange={e => setEdit({ ...edit, endTime: e.target.value })} /></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {DAY_NAMES.map((d, i) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={edit.days[i] === 'Y'}
                  onChange={e => setEdit({ ...edit, days: edit.days.slice(0, i) + (e.target.checked ? 'Y' : 'N') + edit.days.slice(i + 1) })} /> {d}
              </label>
            ))}
          </div>
          <Field label="Note (optional)"><Input value={edit.note} maxLength={100} placeholder="e.g. evening price"
            onChange={e => setEdit({ ...edit, note: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.isActive} onChange={e => setEdit({ ...edit, isActive: e.target.checked })} /> On
          </label>
          <ErrorBar message={err} onDismiss={() => setErr('')} />
          <div className="grid grid-cols-2 gap-3">
            <Btn onClick={() => setEdit(null)}>Cancel</Btn>
            <Btn variant="primary" disabled={!edit.startTime || !edit.endTime || edit.startTime === edit.endTime || !edit.days.includes('Y')}
              onClick={save}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

function PriceLists({ flash }) {
  const { data: branches } = useApi('/api/branches')
  const { data: levels, reload: reloadLevels } = useApi('/api/settings/price-levels')
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
  const onLevels = (levels || []).filter(l => l.IsActive)

  return (
    <div className="space-y-3">
      <PriceLevelsCard flash={flash} onSaved={reloadLevels} />
      <PriceSchedulesCard flash={flash} branches={branches} levels={levels} />
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
        <Table head={['Barcode', 'Product', 'Category', 'Base', `${branch} price`, ...onLevels.map(l => l.LevelName), 'Source', 'Difference']}
          rows={list.map(p => {
            const diff = Number(p.Price) - Number(p.BasePrice)
            return [p.Barcode, p.ProductName, p.CategoryName, peso(p.BasePrice), peso(p.Price),
              ...onLevels.map(l => (p[`Price${l.PriceLevel}`] > 0 ? peso(p[`Price${l.PriceLevel}`]) : '—')),
              p.HasOverride
                ? <span key={p.ProductId} className="text-accent-fg font-semibold">Branch override</span>
                : <span key={p.ProductId} className="text-muted">Base price</span>,
              p.HasOverride
                ? <span key={'d' + p.ProductId} className={diff > 0 ? 'text-danger-fg' : 'text-accent-fg'}>
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

/* ================= Discounts (rates per category and per POS type) ================= */
/** RA 9994-style discounts aren't one flat rate — e.g. Senior Citizen is 20% + fully
 *  VAT-exempt on medicine and restaurant food, but only 5% + still-VATable (with a VAT
 *  adjustment) on groceries/prime commodities. A line's rate, first match wins
 *  (32_discount_pos_type.sql): this POS type + its category, its category (every POS type),
 *  this POS type, the discount type's default. The till's POS type is the terminal's own,
 *  else the branch's. Global, not branch-scoped — these rates are legally mandated. */
const pctOf = (r) => `${Math.round(Number(r) * 10000) / 100}%`
const vatOf = (exempt) => (exempt ? 'VAT-exempt' : 'Still VATable (VAT adj.)')

function Discounts({ flash }) {
  const { data: types, error } = useApi('/api/settings/discount-types')
  const { data: categories } = useApi('/api/products/categories')
  const { data: overrides, reload } = useApi('/api/settings/discount-category-rates')
  const { data: ptRates, reload: reloadPt } = useApi('/api/settings/discount-pos-type-rates')
  const [code, setCode] = useState('')
  const [posType, setPosType] = useState('')   // '' = every POS type (category overrides)
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!code && types?.length) setCode(types[0].DiscountCode)
  }, [code, types])

  if (error) return <ErrorBar message={error} />
  if (!types || !categories || !overrides || !ptRates) return <Spinner />
  if (!code) return <Spinner />

  const current = types.find(t => t.DiscountCode === code)
  const byCategory = new Map(overrides.filter(o => o.DiscountCode === code).map(o => [o.CategoryId, o]))
  const pt = ptRates.filter(r => r.DiscountCode === code && r.PosType === posType)
  const ptAll = pt.find(r => r.CategoryId == null)
  const ptByCat = new Map(pt.filter(r => r.CategoryId != null).map(r => [r.CategoryId, r]))

  /** The rule that applies to a category at the chosen POS type, and where it comes from. */
  const ruleFor = (catId) => {
    const own = posType ? ptByCat.get(catId) : null
    if (own) return { r: own, src: `${posType} + category`, editable: true }
    const c = byCategory.get(catId)
    if (c) return { r: c, src: posType ? 'Category (every POS type)' : 'Category', editable: !posType }
    if (posType && ptAll) return { r: ptAll, src: `${posType} rate` }
    return { r: current, src: 'Type default' }
  }

  const url = (categoryId) => posType
    ? `/api/settings/discount-pos-type-rates/${code}/${posType}${categoryId != null ? `?categoryId=${categoryId}` : ''}`
    : `/api/settings/discount-category-rates/${code}/${categoryId}`
  const save = async () => {
    try {
      await api(url(edit.categoryId), { method: 'PUT', body: JSON.stringify({ rate: edit.rate / 100, isVatExempt: edit.isVatExempt }) })
      setEdit(null); reload(); reloadPt(); flash('Discount rate saved. Tills pick it up when their POS screen next loads.')
    } catch (e) { setErr(e.message) }
  }
  const clear = async (categoryId) => {
    try {
      await api(url(categoryId), { method: 'DELETE' })
      reload(); reloadPt(); flash('Cleared — the next rule in line applies again')
    } catch (e) { setErr(e.message) }
  }
  const openEdit = (categoryId, title, r) => setEdit({ categoryId, title,
    rate: Math.round(Number(r?.Rate ?? current?.Rate ?? 0) * 10000) / 100, isVatExempt: !!(r?.IsVatExempt ?? current?.IsVatExempt ?? true) })

  return (
    <div className="space-y-3">
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />
      <div className="flex flex-wrap gap-3">
        <Field label="Discount type">
          <Select className="!w-64" value={code} onChange={e => setCode(e.target.value)}>
            {types.map(t => <option key={t.DiscountCode} value={t.DiscountCode}>
              {t.DiscountCode} — {t.Description}</option>)}
          </Select>
        </Field>
        <Field label="POS type">
          <Select className="!w-64" value={posType} onChange={e => setPosType(e.target.value)}>
            <option value="">Every POS type (category rules)</option>
            {POS_TYPES.map(p => <option key={p.code} value={p.code}>{p.code} tills</option>)}
          </Select>
        </Field>
      </div>

      {current && (
        <Note tone="stone">
          Type default: {pctOf(current.Rate)}, {current.IsVatExempt ? 'VAT-exempt' : 'still VATable'}
          {current.LegalBasis ? ` (${current.LegalBasis})` : ''}. A line takes the first rule that fits: its POS type
          and category, then its category, then its POS type, then this default. A till's POS type is set in
          Admin → Terminals (else the branch's POS settings), e.g. Retail for the supermarket tills and Restaurant for
          the grills.
        </Note>
      )}

      {posType && (
        <div className="bg-panel rounded-2xl border border-line p-4 flex flex-wrap items-center gap-3">
          <div>
            <div className="font-semibold">{code} at {posType} tills, every category</div>
            <div className="text-sm text-fg2">{ptAll ? `${pctOf(ptAll.Rate)} · ${vatOf(ptAll.IsVatExempt)}`
              : `Not set: the type default (${pctOf(current?.Rate)}) applies`}</div>
          </div>
          <span className="ml-auto flex gap-3">
            <button className="underline text-accent-fg" onClick={() => openEdit(null, `${code} at ${posType} tills, every category`, ptAll)}>
              {ptAll ? 'Edit' : 'Set'}</button>
            {ptAll && <button className="underline text-danger-fg" onClick={() => clear(null)}>Clear</button>}
          </span>
        </div>
      )}

      <Table head={['Category', 'Rate', 'VAT treatment', 'Rule', '']}
        rows={categories.map(c => {
          const { r, src, editable } = ruleFor(c.CategoryId)
          return [
            c.CategoryName, pctOf(r?.Rate ?? 0), vatOf(r?.IsVatExempt), <span key={'s' + c.CategoryId} className="text-muted">{src}</span>,
            <span key={c.CategoryId} className="flex gap-2">
              <button className="underline text-accent-fg" onClick={() => openEdit(c.CategoryId,
                `${code}${posType ? ` at ${posType} tills` : ''} — ${c.CategoryName}`, editable ? r : r)}>
                {editable ? 'Edit' : 'Override'}
              </button>
              {editable && <button className="underline text-danger-fg" onClick={() => clear(c.CategoryId)}>Clear</button>}
            </span>
          ]
        })} />

      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <h2 className="font-bold text-lg">{edit.title}</h2>
          <Field label="Rate (%)"><Input type="number" min="0" max="100" step="0.01" value={edit.rate}
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
      <Note tone="green" title="Users from the ERP">
        Users marked ERP come from the CORECS ERP (Users Info) with every sync: name, role, branch and
        password are managed there, and a password changed in the ERP works here at the next sign-in.
        Local users (no ERP mark) are SparkPOS-only — keep at least one local Admin as the
        break-glass login. Five wrong passwords lock a user for 15 minutes.
      </Note>
      <Table head={['Username', 'Full name', 'Role', 'Branch access', 'Source', 'Active', '']}
        rows={data.map(u => {
          const locked = u.LockedUntil && new Date(u.LockedUntil) > new Date()
          return [u.Username, u.FullName, u.Role,
            u.Role === 'Admin' ? 'All branches' : (u.Branches || '—'),
            u.ErpUserId
              ? <span key={'s' + u.UserId} className="text-accent-fg font-semibold">ERP{u.MustChangePassword ? ' · must change password' : ''}</span>
              : 'Local',
            locked ? <span key={'l' + u.UserId} className="text-danger-fg font-semibold">Locked</span> : u.IsActive ? 'Yes' : 'No',
            <span key={u.UserId} className="flex gap-3">
              {locked && (
                <button className="underline text-danger-fg" onClick={async () => {
                  try { await api(`/api/users/${u.UserId}/unlock`, { method: 'POST' }); reload(); flash(`${u.Username} unlocked`) }
                  catch (e) { setErr(e.message) }
                }}>Unlock</button>
              )}
              {!u.ErpUserId && (
                <button className="underline text-accent-fg" onClick={() => setEdit({
                  userId: u.UserId, username: u.Username, password: '', fullName: u.FullName,
                  role: u.Role, isActive: u.IsActive,
                  branches: (u.Branches || '').split(',').map(s => s.trim()).filter(Boolean) })}>
                  Edit / reset password
                </button>
              )}
            </span>]
        })} />
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />

      <div className="bg-panel rounded-xl p-4 border border-line text-sm text-fg2">
        <strong className="block mb-2 text-fg">Role permissions</strong>
        <div className="grid md:grid-cols-3 gap-3">
          <div><div className="font-semibold text-fg">Cashier</div>
            Sell, X-Read, reprint, blind close, run End of Day (with supervisor authorization).
            Never sees totals, variance or reports.</div>
          <div><div className="font-semibold text-fg">Supervisor</div>
            Cashier rights plus void approval, variance, End of Day authorization and all reports —
            for assigned branches only.</div>
          <div><div className="font-semibold text-fg">Admin</div>
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
  // Terminals (and their BIR details) are entered by head office: the API lets only an Admin save
  // them, so a Supervisor gets a read-only list (Test print still works).
  const isAdmin = useAuth(s => s.role) === 'Admin'
  const { data, error, reload } = useApi('/api/terminals')
  const { data: branches } = useApi('/api/branches')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')

  const DATES = ['permitEffective', 'accreditationDate', 'permitValidUntil', 'birApplicationDate']
  const erpNote = (erp) => !erp ? '' : erp.status === 'Sent'
    ? ` and sent to the ERP (${(erp.result || '').toLowerCase()})` : ` — NOT sent to the ERP: ${erp.error}`
  const save = async () => {
    try {
      const body = JSON.stringify({ ...edit, ...Object.fromEntries(DATES.map(k => [k, edit[k] || null])) })
      const r = edit.terminalId ? await api(`/api/terminals/${edit.terminalId}`, { method: 'PUT', body })
        : await api('/api/terminals', { method: 'POST', body })
      setEdit(null); reload(); flash('Terminal saved' + erpNote(r?.erp))
    } catch (e) { setErr(e.message) }
  }

  const sendToErp = async (id) => {
    try { const r = await api(`/api/terminals/${id}/send-to-erp`, { method: 'POST' }); reload(); flash('Terminal' + (erpNote(r?.erp) || ' has no ERP code')) }
    catch (e) { setErr(e.message) }
  }

  const unassignDevice = async (t) => {
    if (!window.confirm(`Free ${t.BranchCode}/${t.TerminalCode} from its device? Any device can then be assigned to it at Cash Begin.`)) return
    try { await api(`/api/terminals/${t.TerminalId}/device`, { method: 'DELETE' }); reload(); flash(`${t.TerminalCode} is no longer assigned to a device`) }
    catch (e) { setErr(e.message) }
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
      {!isAdmin && <Note tone="stone">Only an Admin can add or change terminals. Head office enters each
        terminal's BIR details.</Note>}
      {isAdmin && <Btn variant="primary" onClick={() => setEdit({
        terminalId: 0, branchCode: branches[0]?.BranchCode, terminalCode: '', terminalName: '',
        printerTarget: 'tcp://192.168.1.50:9100', paperWidth: 58, printAgentKey: '', tin: '', accreditationNo: '', serialNo: '',
        permitNo: '', minNo: '', permitEffective: '', isActive: true, erpTerminalCode: '', postToErp: false,
        accreditationDate: '', permitValidUntil: '', birRegTransactionNo: '', birApplicationDate: '', posType: '',
        screenLayout: 'Touch' })}>Add terminal</Btn>}
      <ErrorBar message={!edit ? err : ''} onDismiss={() => setErr('')} />

      <Table head={['Branch', 'Code', 'Name', 'POS type', 'Screen', 'Printer', 'Paper', 'Serial No.', 'MIN', 'Permit No.',
        'Accreditation No.', 'Effective', 'Last Z#', 'Grand total', 'ERP', 'Device', 'Active', '']}
        rows={data.map(t => [t.BranchCode, t.TerminalCode, t.TerminalName,
          t.PosType || <span key={'p' + t.TerminalId} className="text-muted">branch default</span>,
          t.ScreenLayout === 'Grocery' ? 'Grocery lane' : 'Touch',
          t.PrinterTarget || '—',
          `${t.PaperWidth || 58}mm`,
          t.SerialNo || '—', t.MinNo || '—', t.PermitNo || '—', t.AccreditationNo || '—',
          t.PermitEffective ? String(t.PermitEffective).slice(0, 10) : '—',
          t.LastZCounter, peso(t.GrandTotalSales),
          t.ErpTerminalCode
            ? <span key={'e' + t.TerminalId} className="flex flex-col">
                <span className={t.PostToErp ? 'text-accent-fg font-semibold' : 'text-muted'}>
                  {t.ErpTerminalCode} · {t.PostToErp ? 'posting' : 'not posting'}</span>
                {t.ErpInfoStatus === 'Sent' && <span className="text-xs text-muted">details sent {String(t.ErpInfoSentAt).slice(0, 10)}</span>}
                {t.ErpInfoStatus !== 'Sent' && (
                  <span className="text-xs text-warn-fg whitespace-normal max-w-[260px]">
                    {t.ErpInfoStatus === 'Failed' ? t.ErpInfoError : 'Details not sent to the ERP yet.'}{' '}
                    {isAdmin && <button className="underline font-semibold" onClick={() => sendToErp(t.TerminalId)}>Send again</button>}
                  </span>)}
              </span>
            : '—',
          // Assigned once at Cash Begin on the till itself (database/27_terminal_devices.sql)
          t.DeviceAssigned
            ? <span key={'d' + t.TerminalId} className="flex flex-col">
                <span>{t.DeviceLabel || 'A device'}</span>
                <span className="text-xs text-muted">
                  {String(t.DeviceAssignedAt).slice(0, 10)}{t.DeviceAssignedBy ? ` · ${t.DeviceAssignedBy}` : ''}{' '}
                  {isAdmin && <button className="underline font-semibold" onClick={() => unassignDevice(t)}>Unassign</button>}
                </span>
              </span>
            : <span key={'d' + t.TerminalId} className="text-muted">any device</span>,
          t.IsActive ? 'Yes' : 'No',
          <span key={t.TerminalId} className="flex gap-2">
            {isAdmin && <button className="underline text-accent-fg" onClick={() => setEdit({
              terminalId: t.TerminalId, branchCode: t.BranchCode, terminalCode: t.TerminalCode,
              terminalName: t.TerminalName, printerTarget: t.PrinterTarget, paperWidth: t.PaperWidth,
              printAgentKey: t.PrintAgentKey || '', tin: t.Tin,
              accreditationNo: t.AccreditationNo, serialNo: t.SerialNo, permitNo: t.PermitNo,
              minNo: t.MinNo,
              permitEffective: t.PermitEffective ? String(t.PermitEffective).slice(0, 10) : '',
              isActive: t.IsActive, erpTerminalCode: t.ErpTerminalCode || '', postToErp: !!t.PostToErp,
              accreditationDate: t.AccreditationDate ? String(t.AccreditationDate).slice(0, 10) : '',
              permitValidUntil: t.PermitValidUntil ? String(t.PermitValidUntil).slice(0, 10) : '',
              birRegTransactionNo: t.BirRegTransactionNo || '',
              birApplicationDate: t.BirApplicationDate ? String(t.BirApplicationDate).slice(0, 10) : '',
              posType: t.PosType || '', screenLayout: t.ScreenLayout || 'Touch' })}>Edit</button>}
            <button className="underline text-accent-fg" onClick={() => testPrint(t.TerminalId)}>Test print</button>
          </span>])} />

      <Note tone="amber" title="BIR registration prints on every receipt">
        TIN, MIN, Serial No., Permit No. and Accreditation No. appear in the receipt header and are
        stored per terminal per branch, so each registered machine prints its own credentials.
        Printer targets: <code className="bg-raised px-1">tcp://192.168.1.50:9100</code> for a
        network printer, <code className="bg-raised px-1">file://COM3</code> for a USB printer
        exposing a virtual COM port, <code className="bg-raised px-1">spool://XP-80C</code> for
        a USB printer installed normally (find the exact name via Windows' Printers &amp; Scanners
        settings or <code className="bg-raised px-1">Get-Printer</code>) — works for any
        Windows-installed printer regardless of port, <code className="bg-raised px-1">file:///dev/usb/lp0</code> on
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
            <Field label="POS type">
              <Select className="w-full" value={edit.posType || ''}
                onChange={e => setEdit({ ...edit, posType: e.target.value })}>
                <option value="">Branch default (POS settings)</option>
                {POS_TYPES.map(p => <option key={p.code} value={p.code}>{p.code}</option>)}
              </Select>
            </Field>
            {/* 37: the grocery lane is for a till on a PC screen; the handheld (under 1024 px wide) always shows Touch */}
            <Field label="Screen layout">
              <Select className="w-full" value={edit.screenLayout || 'Touch'}
                onChange={e => setEdit({ ...edit, screenLayout: e.target.value })}>
                <option value="Touch">Touch: product pictures, the sale beside them</option>
                <option value="Grocery">Grocery lane: the sale as a big list, F-keys</option>
              </Select>
            </Field>
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
          <div className="border-t border-line pt-3">
            <div className="text-xs font-bold uppercase tracking-wider text-muted mb-2">BIR registration</div>
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
              <Field label="Accreditation date"><Input type="date" value={edit.accreditationDate || ''}
                onChange={e => setEdit({ ...edit, accreditationDate: e.target.value })} /></Field>
              <Field label="Permit valid until (optional)"><Input type="date" value={edit.permitValidUntil || ''}
                onChange={e => setEdit({ ...edit, permitValidUntil: e.target.value })} /></Field>
              <Field label="BIR registration / transaction no. (optional)"><Input value={edit.birRegTransactionNo || ''}
                maxLength={60} onChange={e => setEdit({ ...edit, birRegTransactionNo: e.target.value })} /></Field>
              <Field label="Application date (optional)"><Input type="date" value={edit.birApplicationDate || ''}
                onChange={e => setEdit({ ...edit, birApplicationDate: e.target.value })} /></Field>
            </div>
            <p className="text-xs text-muted mt-2">Head office enters these once, here. A terminal with an ERP code is sent to the
              ERP on every save (its terminal register and the POS machine list behind its X/Z-read reports); the ERP needs the
              MIN, serial, PTU no. and date, accreditation no. and date.</p>
          </div>
          <div className="border-t border-line pt-3">
            <div className="text-xs font-bold uppercase tracking-wider text-muted mb-2">CORECS ERP</div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <Field label="ERP terminal code (SP- + up to 7)"><Input value={edit.erpTerminalCode || ''} placeholder="SP-POS01"
                maxLength={10} onChange={e => setEdit({ ...edit, erpTerminalCode: e.target.value.toUpperCase() })} /></Field>
              <label className="flex items-center gap-2 text-sm pb-3">
                <input type="checkbox" checked={!!edit.postToErp}
                  onChange={e => setEdit({ ...edit, postToErp: e.target.checked })} />
                <span><strong>Post sales to the ERP</strong> — stock, sales and reports there</span>
              </label>
            </div>
            <Note tone="amber">Off = trial mode: this terminal sells and prints normally but sends nothing to
              the ERP. Turn it on only for the terminal that replaces a desktop POS, at a branch the ERP has
              switched over (its SPARKPOS_BRANCHES setting) — the ERP refuses others. Keep the ERP terminal
              code once it has sales. A MIN belongs to one terminal only, across the whole ERP; it can be
              changed here later, but not while the terminal has an open shift or sales not yet sent.</Note>
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
          <button key={t.TableId} className="underline text-accent-fg" onClick={() => setEdit({
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
          <button key={a.AreaId} className="underline text-accent-fg" onClick={() => setEdit({
            areaId: a.AreaId, branchCode: a.BranchCode, areaName: a.AreaName,
            printerTarget: a.PrinterTarget, paperWidth: a.PaperWidth,
            printAgentKey: a.PrintAgentKey || '', isActive: a.IsActive })}>Edit</button>])} />

      {data.length === 0 && (
        <Note>No print areas yet for {branchCode}. Add one (e.g. "Kitchen", "Beverage"), then
          map categories to it in Admin → Categories to enable Send to Kitchen.</Note>
      )}

      <Note tone="stone">Areas print server-side (via the print agent) — never RawBT, which only
        reaches this handheld's own paired printer. Use{' '}
        <code className="bg-raised px-1">tcp://192.168.1.60:9100</code> for a network printer,
        or <code className="bg-raised px-1">spool://&lt;exact printer name&gt;</code> for a
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

/** 35: the till actions a supervisor can be required for, with the POS settings field of the
 *  branch's switch. A terminal can have its own answer (Approvals.Funcs on the server). */
const APPROVALS = [
  ['CANCEL_LINE', 'cancelLineOverride', 'Cancel line', 'Taking an item off the cart (×, or − down to none). Removed items are logged with the sale.'],
  ['VOID', 'voidOverride', 'Void', 'Voiding a sale of the open shift. Logged either way.'],
  ['RETURN', 'returnOverride', 'Return', 'A return transaction. Logged either way.'],
  ['XREAD', 'xReadOverride', 'X-Read', 'Printing an X-Read of the shift.'],
  ['REPRINT', 'reprintOverride', 'Reprint', 'Reprinting an invoice or a return receipt (always marked REPRINT).'],
  ['DISCOUNT', 'discountOverride', 'Discount', 'A Senior, PWD, NAAC, MOV or Solo parent discount. The regular / other discount and the weekly cap always need one.'],
  ['PRICE_LEVEL', 'priceLevelOverride', 'Price level', 'Putting an item (Edit price) or the whole sale at Price 1-4. Back to the regular price needs none. A typed price follows "price edit" below.'],
  ['OPEN_DRAWER', 'openDrawerOverride', 'Open drawer', 'Opening the cash drawer with no sale (with a reason). Logged either way and counted on the X-Read and Z-Read.']
]

/** Supervisor approvals: the branch's switch per action, and each terminal's own answer
 *  (follow the branch / required / not needed). A Supervisor or Admin signed in never needs one. */
function ApprovalsCard({ f, setF, branchCode, own, setOwn, info }) {
  const terms = (info?.terminals || []).filter(t => t.isActive || Object.keys(own[t.terminalId] || {}).length)
  const setTerm = (id, func, v) => setOwn(o => {
    const next = { ...(o[id] || {}) }
    if (v === '') delete next[func]; else next[func] = v === '1'
    return { ...o, [id]: next }
  })
  return (
    <div className="bg-panel rounded-xl p-5 border border-line space-y-3">
      <div>
        <h2 className="font-bold">Supervisor approvals — {branchCode}</h2>
        <p className="text-sm text-muted">Tick an action to make a cashier ask a supervisor (user ID and password) for it at every
          till of the branch. A terminal can follow the branch or have its own answer. A Supervisor or Admin signed in never
          needs one. Tills pick changes up when the POS screen next opens.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm min-w-full">
          <thead><tr className="text-left text-muted">
            <th className="py-2 pr-3 font-medium">Action</th>
            <th className="py-2 px-3 font-medium text-center">Branch</th>
            {info?.installed && terms.map(t => <th key={t.terminalId} className="py-2 px-2 font-medium whitespace-nowrap">{t.terminalCode}</th>)}
          </tr></thead>
          <tbody>
            {APPROVALS.map(([func, key, label, desc]) => (
              <tr key={func} className="border-t border-line align-top">
                <td className="py-2 pr-3 min-w-[240px]"><span className="font-semibold block">{label}</span><span className="text-muted text-xs">{desc}</span></td>
                <td className="py-2 px-3 text-center">
                  <input type="checkbox" aria-label={`${label}: branch`} checked={!!f[key]} disabled={f[key] === undefined}
                    onChange={e => setF({ ...f, [key]: e.target.checked })} />
                </td>
                {info?.installed && terms.map(t => {
                  const v = own[t.terminalId]?.[func]
                  return (
                    <td key={t.terminalId} className="py-2 px-2">
                      <select className="bg-ink border border-line2 rounded-lg px-2 py-1 text-xs" aria-label={`${label}: ${t.terminalCode}`}
                        value={v === undefined ? '' : v ? '1' : '0'} onChange={e => setTerm(t.terminalId, func, e.target.value)}>
                        <option value="">Branch ({f[key] ? 'yes' : 'no'})</option>
                        <option value="1">Required</option>
                        <option value="0">Not needed</option>
                      </select>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {info && !info.installed && <Note tone="amber">Per-terminal answers and the Cancel line / X-Read / Discount switches need database update 35 (35_approvals.sql).</Note>}
    </div>
  )
}

function SettingsTab({ scope, flash }) {
  const branchCode = scope === 'ALL' ? null : scope
  const { data, error, reload } = useApi(branchCode ? `/api/settings/${branchCode}` : '/api/branches', [scope])
  const approvals = useApi(branchCode ? `/api/approvals/branch/${branchCode}` : '/api/branches', [scope])
  const [f, setF] = useState(null)
  const [own, setOwn] = useState({})
  const [err, setErr] = useState('')

  useEffect(() => {
    const t = approvals.data?.terminals
    if (branchCode && t) setOwn(Object.fromEntries(t.map(x => [x.terminalId, { ...x.own }])))
  }, [approvals.data, branchCode])

  useEffect(() => {
    if (branchCode && data && data.BranchCode) {
      setF({
        branchCode: data.BranchCode, posType: data.PosType,
        voidOverride: data.VoidOverride, priceEditOverride: data.PriceEditOverride,
        reprintOverride: data.ReprintOverride, eodOverride: data.EodOverride,
        emailOnBlindClose: data.EmailOnBlindClose, refundEnabled: data.RefundEnabled,
        returnOverride: data.ReturnOverride,
        // 35 (undefined before the update: the checkbox is disabled and nothing is sent)
        cancelLineOverride: data.CancelLineOverride, xReadOverride: data.XReadOverride, discountOverride: data.DiscountOverride,
        priceLevelOverride: data.PriceLevelOverride,   // 36
        giftCertOn: data.GiftCertOn,                   // 38 (undefined before the update: not shown, not sent)
        openDrawerOverride: data.OpenDrawerOverride,   // 39
        blockLoginAfterEod: data.BlockLoginAfterEod, orBlockSize: data.OrBlockSize,
        orLowWarning: data.OrLowWarning, maxDiscountPerTxn: data.MaxDiscountPerTxn,
        scaleBarcodePrefix: data.ScaleBarcodePrefix || '', scaleCodeLength: data.ScaleCodeLength ?? 5,
        scaleQtyLength: data.ScaleQtyLength ?? 5, scaleQtyDecimals: data.ScaleQtyDecimals ?? 3,
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
      if (approvals.data?.installed)
        await api(`/api/approvals/branch/${branchCode}/terminals`, { method: 'PUT', body: JSON.stringify(
          Object.entries(own).flatMap(([id, m]) => Object.entries(m).map(([func, required]) => ({ terminalId: Number(id), func, required })))) })
      flash('Settings saved'); reload(); approvals.reload()
    } catch (e) { setErr(e.message) }
  }

  const toggles = [
    ['priceEditOverride', 'Require supervisor override for price edit',
      'Applies only to products flagged price-editable.'],
    ['eodOverride', 'Require supervisor override for End of Day',
      'When off, a cashier can run End of Day directly without a separate credential. Admin/Supervisor never need one for their own End of Day either way.'],
    ['emailOnBlindClose', 'Email a report when a cashier closes their shift',
      'Sends X-Read, group item sales summary and per-hour transactions to the configured email recipients (Admin → Email). Never shown to the cashier, same as the printed variance report. End of Day’s email is controlled separately in Admin → Email (Send automatically on End of Day).'],
    ['refundEnabled', 'Allow return transactions',
      'Prints a RETURN TRANSACTION receipt with its own 6-digit return number and the original Ref SI No. The refund is cash, out of the drawer.'],
    ['blockLoginAfterEod', 'Block cashier login after End of Day until the next business day',
      'The terminal reopens automatically on the next day. Admin can always sign in.'],
    ...(f.giftCertOn !== undefined ? [['giftCertOn', 'Take gift certificates as payment',
      'The till offers Gift cert at payment. Each GC must be in Admin → Gift Certificates; it pays at most the bill ' +
      '(no change, the rest is forfeited) and can be used once. Offline it is taken and checked when the sale syncs.']] : [])
  ]

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="bg-panel rounded-xl p-5 border border-line space-y-4">
        <div>
          <h2 className="font-bold">POS type — {branchCode}</h2>
          <p className="text-sm text-muted">The default for this branch's terminals. A terminal set to its own
            POS type in Admin → Terminals (e.g. one Restaurant till among Retail ones) keeps that type.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {POS_TYPES.map(t => (
            <button key={t.code} onClick={() => setF({ ...f, posType: t.code })}
              className={`rounded-lg p-3 text-left border ${f.posType === t.code ? 'bg-accent/15 text-fg border-accent' : 'bg-panel border-line2'}`}>
              <div className="font-bold text-sm">{t.code}</div>
              <div className={`text-xs mt-1 ${f.posType === t.code ? 'text-fg2' : 'text-muted'}`}>{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <ApprovalsCard f={f} setF={setF} branchCode={branchCode} own={own} setOwn={setOwn} info={approvals.data?.terminals ? approvals.data : null} />

      <div className="bg-panel rounded-xl p-5 border border-line space-y-3">
        <h2 className="font-bold">Transaction controls</h2>
        {toggles.map(([k, label, desc]) => (
          <label key={k} className="flex items-start gap-3 border-b border-line pb-3 last:border-0">
            <input type="checkbox" className="mt-1" checked={!!f[k]}
              onChange={e => setF({ ...f, [k]: e.target.checked })} />
            <span className="text-sm">
              <span className="font-semibold block">{label}</span>
              <span className="text-muted">{desc}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="bg-panel rounded-xl p-5 border border-line space-y-3">
        <div>
          <h2 className="font-bold">Weighing-scale stickers</h2>
          <p className="text-sm text-muted">
            A scale sticker is prefix + product code + weight + one check digit. Scanned at the till it adds
            that product with that weight. Example with prefix 25, code 5, weight 5, decimals 3:
            <span className="font-mono"> 25 10015 23123 2</span> = product 10015, weight 23.123.
            The product code is the ERP product code (or the barcode for a local product). Leave the prefix
            blank to turn this off.
          </p>
        </div>
        <div className="grid md:grid-cols-4 gap-3">
          <Field label="Prefix (e.g. 25, or 20,25)"><Input value={f.scaleBarcodePrefix}
            onChange={e => setF({ ...f, scaleBarcodePrefix: e.target.value.replace(/[^0-9,]/g, '') })} /></Field>
          <Field label="Product code digits"><Input className="text-right tabnum" value={f.scaleCodeLength}
            onChange={e => setF({ ...f, scaleCodeLength: Number(e.target.value) || 0 })} /></Field>
          <Field label="Weight digits"><Input className="text-right tabnum" value={f.scaleQtyLength}
            onChange={e => setF({ ...f, scaleQtyLength: Number(e.target.value) || 0 })} /></Field>
          <Field label="Weight decimals"><Input className="text-right tabnum" value={f.scaleQtyDecimals}
            onChange={e => setF({ ...f, scaleQtyDecimals: Number(e.target.value) || 0 })} /></Field>
        </div>
      </div>

      <div className="bg-panel rounded-xl p-5 border border-line space-y-3">
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
/** E-invoice email delivery: counts, the latest failed / waiting / sent, and Retry for failures. */
function InvoiceEmailQueue() {
  const { role } = useAuth()
  const { data, error, reload } = useApi('/api/settings/invoice-emails')
  const [busy, setBusy] = useState(false)
  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />
  const c = data.counts || {}
  const retry = async () => {
    setBusy(true)
    try { await api('/api/settings/invoice-emails/retry', { method: 'POST' }); reload() } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="font-bold">E-invoice deliveries</h3>
        <span className="text-sm text-muted tabnum">
          {c.Sent || 0} sent · {c.Pending || 0} waiting · <span className={c.Failed ? 'text-danger-fg font-semibold' : ''}>{c.Failed || 0} failed</span>
        </span>
        <div className="ml-auto flex gap-2">
          <Btn className="!min-h-[36px] text-sm" onClick={reload}>Refresh</Btn>
          {role === 'Admin' && c.Failed > 0 && (
            <Btn variant="dark" className="!min-h-[36px] text-sm" disabled={busy} onClick={retry}>Retry failed</Btn>
          )}
        </div>
      </div>
      <Table head={['Document', 'Branch', 'To', 'Status', 'Tries', 'Problem']}
        rows={(data.recent || []).map(e => [
          e.Kind === 'SALE' ? `SI ${String(e.ORNumber ?? '').padStart(18, '0')}` : `Return ${String(e.ReturnNo ?? '').padStart(6, '0')}`,
          `${e.BranchCode} ${e.TerminalCode || ''}`,
          <span key={'t' + e.InvoiceEmailId}>{e.ToAddress}{e.ToRepository ? <span className="text-muted"> (repository)</span> : ''}{e.IsManual ? <span className="text-muted"> (by request)</span> : ''}</span>,
          <span key={'s' + e.InvoiceEmailId} className={e.Status === 'Failed' ? 'text-danger-fg font-semibold' : e.Status === 'Sent' ? 'text-accent-fg' : 'text-warn-fg'}>{e.Status}</span>,
          e.Attempts,
          <span key={'p' + e.InvoiceEmailId} className="whitespace-normal text-xs text-muted">{e.LastError || ''}</span>
        ])}
        empty="No invoices emailed yet." />
    </div>
  )
}

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
        sendInvoices: !!data.SendInvoices, invoiceRepository: data.InvoiceRepository || '',
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
      <div className="bg-panel rounded-2xl p-5 border border-line space-y-3">
        <div>
          <h2 className="font-bold">Email (SMTP): Z-Read, shift reports and e-invoices</h2>
          <p className="text-sm text-muted">
            One global configuration is used for every branch unless a branch-specific row is added
            directly in <code className="bg-raised px-1">dbo.EmailConfig</code> later. Set
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
        <div className="flex gap-5 text-sm flex-wrap border-t border-line pt-3">
          {[['enableSsl', 'Use TLS/SSL'], ['sendOnEod', 'Send automatically on End of Day'],
            ['isActive', 'Active']].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={f[k]} onChange={e => setF({ ...f, [k]: e.target.checked })} />
              <strong>{label}</strong>
            </label>
          ))}
        </div>
        <div className="border-t border-line pt-3 space-y-3">
          <div>
            <h3 className="font-bold">E-invoice copies</h3>
            <p className="text-sm text-muted">
              Emails an exact copy of every sales invoice and return receipt, as printed, with a text
              file attached. It goes to the customer's email when the cashier entered one (Add customer at
              the till); otherwise to the repository mailbox below, so every invoice is kept. Sales made
              offline are emailed once they sync.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.sendInvoices} onChange={e => setF({ ...f, sendInvoices: e.target.checked })} />
            <strong>Email a copy of every invoice</strong>
          </label>
          <Field label="Repository email (when the customer gives none)">
            <Input type="email" value={f.invoiceRepository} placeholder="invoices@yourcompany.com"
              onChange={e => setF({ ...f, invoiceRepository: e.target.value })} />
          </Field>
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

      <InvoiceEmailQueue />

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
            <span key={i} className={Number(r.ShortOver) === 0 ? '' : Number(r.ShortOver) > 0 ? 'text-accent-fg font-semibold' : 'text-danger-fg font-semibold'}>
              {Number(r.ShortOver) === 0 ? '—' : Number(r.ShortOver) > 0
                ? `(${peso(r.ShortOver)})` : peso(Math.abs(Number(r.ShortOver)))}
            </span>,
            <button key={'b' + i} className="underline text-accent-fg" onClick={() => setDetail(r)}>Denominations</button>
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
          <button key={s.ShiftUid} className="underline text-danger-fg font-semibold"
            onClick={() => openFor(s)}>Force close…</button>
        ])} />

      {close && (
        <Modal onClose={() => setClose(null)} wide>
          {!result ? (
            <>
              <h2 className="font-bold text-lg">
                Force-close {close.BranchCode}/{close.TerminalCode} — {close.Cashier}
              </h2>
              <p className="text-sm text-muted">
                Enter the physical drawer count exactly as the cashier would have.
              </p>
              <div className="bg-raised rounded-lg p-4 grid grid-cols-2 gap-x-6 gap-y-2">
                {REC_DENOMS.map(d => (
                  <label key={d} className="flex items-center gap-2">
                    <span className="tabnum w-14 text-right font-bold text-sm">₱{d}</span>
                    <span className="text-muted">×</span>
                    <Input className="!min-h-[38px] text-right tabnum !text-sm" inputMode="numeric" placeholder="0"
                      value={counts[d] || ''}
                      onChange={e => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })} />
                  </label>
                ))}
              </div>
              <div className="bg-deep text-white rounded-xl px-4 py-3 flex justify-between items-baseline">
                <span className="text-[10px] tracking-[0.3em] uppercase text-muted">Declared cash</span>
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

/* ================= ERP posting (step 4.1) ================= */
/** The queue of sales/voids going to the CORECS ERP (ErpPostingService): what's waiting,
 *  what failed and why (with Retry), what the ERP flagged for review, and the stock
 *  shortfalls it recorded for a branch and day. */
function ErpPosting({ branchFilter, flash }) {
  const q = branchFilter ? `?branchCode=${branchFilter}` : ''
  const { data, error, reload } = useApi(`/api/erp/posting${q}`)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sfBranch, setSfBranch] = useState(branchFilter || '')
  const [sfDate, setSfDate] = useState(today())
  const [shortfalls, setShortfalls] = useState(null)

  if (error) return <ErrorBar message={error} />
  if (!data) return <Spinner />
  if (!data.configured) return null
  const c = data.counts || {}

  const run = async () => {
    setBusy(true); setErr('')
    try { const r = await api('/api/erp/posting/run', { method: 'POST' }); flash(`Sent ${r.processed} to the ERP`); reload() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const retry = async (id) => {
    try { await api(`/api/erp/posting/${id}/retry`, { method: 'POST' }); flash('Queued again'); reload() }
    catch (e) { setErr(e.message) }
  }
  const loadShortfalls = async () => {
    setErr(''); setShortfalls(null)
    try { setShortfalls(await api(`/api/erp/shortfalls?branchCode=${sfBranch}&businessDate=${sfDate}`)) }
    catch (e) { setErr(e.message) }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold">Sales sent to the ERP</h3>
        <span className="text-sm text-muted tabnum">
          {c.Posted || 0} posted · {c.Pending || 0} waiting{c.Retrying ? ` (${c.Retrying} retrying)` : ''} ·{' '}
          <span className={c.Failed ? 'text-danger-fg font-semibold' : ''}>{c.Failed || 0} need attention</span> ·{' '}
          {c.NeedsReview || 0} flagged by the ERP · {c.WithShortfalls || 0} with stock shortfalls
        </span>
        <Btn className="ml-auto !min-h-[38px] text-sm" disabled={busy} onClick={run}>{busy ? 'Sending…' : 'Send now'}</Btn>
      </div>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {data.attention.length > 0 && (
        <Table head={['', 'Branch', 'Terminal', 'Date', 'SI No.', 'Amount', 'Status', 'Tries', 'Problem / ERP note', '']}
          rows={data.attention.map(a => [
            ({ OPEN: 'Shift open', SALE: 'Sale', VOID: 'Void', RETURN: 'Return', CLOSE: 'Shift close', ZREAD: 'Z-Read' })[a.Kind] || a.Kind,
            a.BranchCode, a.ErpTerminalCode || a.TerminalCode,
            String(a.BusinessDate).slice(0, 10), a.ORNumber ? siNo(a.ORNumber) : '—', a.NetAmount != null ? peso(a.NetAmount) : '—',
            a.Status === 'Failed' ? <span key={'s' + a.OutboxId} className="text-danger-fg font-semibold">Needs attention</span>
              : a.Status === 'Pending' ? 'Retrying' : a.ErpResult,
            a.Attempts,
            <span key={'m' + a.OutboxId} className="text-xs">
              {a.LastError ? `${a.LastErrorNumber ? a.LastErrorNumber + ': ' : ''}${a.LastError}` : ''}
              {a.NeedsReview ? ' Flagged for review by the ERP.' : ''}
              {a.ShortLines > 0 ? ` ${a.ShortLines} line(s) short of stock.` : ''}
              {a.ErpMessage && !a.LastError ? ` ${a.ErpMessage}` : ''}
            </span>,
            a.Status !== 'Posted'
              ? <button key={a.OutboxId} className="underline text-accent-fg" onClick={() => retry(a.OutboxId)}>Retry</button>
              : ''])} />
      )}
      <div className="bg-panel rounded-xl p-4 border border-line space-y-2">
        <div className="text-sm font-semibold">Stock shortfalls recorded by the ERP</div>
        <div className="flex gap-2 items-end flex-wrap">
          <Field label="Branch"><Input value={sfBranch} onChange={e => setSfBranch(e.target.value.trim())} placeholder="023" /></Field>
          <Field label="Business date"><Input type="date" value={sfDate} onChange={e => setSfDate(e.target.value)} /></Field>
          <Btn variant="dark" disabled={!sfBranch} onClick={loadShortfalls}>Show</Btn>
        </div>
        {shortfalls && (
          <Table empty="No shortfalls for that branch and day."
            head={['Terminal', 'SI No.', 'Time', 'Line', 'Product', 'Sold', 'Deducted', 'Short', 'Returned', 'Settled', 'Still open', 'Status']}
            rows={shortfalls.map(r => [r.TerminalCode, siNo(r.ORNumber), String(r.SaleDateTime).replace('T', ' ').slice(0, 16),
              r.LineNo, `${r.ErpProductCode} ${r.ProductName || ''}`, Number(r.QtySold), Number(r.QtyDeducted),
              <strong key={'q' + r.ShortageID}>{Number(r.QtyShort)}</strong>, Number(r.QtyReturned || 0),
              Number(r.QtySettled || 0), r.QtyOpen == null ? '—' : Number(r.QtyOpen), r.Status])} />
        )}
      </div>
    </div>
  )
}

/* ================= Z-Read / EOD ================= */
function ZReadTab({ branchFilter, flash }) {
  const nav = useNavigate()
  const { role } = useAuth()
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
      {role === 'Admin' && <ErpPosting branchFilter={branchFilter} flash={flash} />}

      <div>
        <h3 className="text-sm font-semibold mb-2">Days awaiting End of Day</h3>
        {pErr ? <ErrorBar message={pErr} /> : !pending ? <Spinner /> : (
          <Table head={['Business date', 'Branch', 'Terminal', 'Shifts', 'Last cashier', 'Closed at', '']}
            rows={pending.map((r, i) => [
              String(r.BusinessDate).slice(0, 10), r.BranchCode, r.TerminalCode, r.ShiftCount,
              r.LastCashier, r.LastClosedAt ? String(r.LastClosedAt).replace('T', ' ').slice(0, 16) : '—',
              <button key={i} className="underline text-danger-fg font-semibold"
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
          'Cash', 'Card', 'Txns', 'Voids', 'Returns', 'SI range', 'Grand total', 'Closed by', 'Approved by', '']}
          rows={rows.map(z => [
            String(z.BusinessDate).slice(0, 10), z.BranchCode, z.TerminalCode, z.ZCounter,
            peso(z.GrossSales), peso(z.TotalDiscounts), peso(z.NetSales), peso(z.VatAmount),
            peso(z.CashSales), peso(z.CardSales), z.TxnCount, z.VoidCount,
            `${z.ReturnCount ?? 0} (${peso(z.ReturnAmount)})`,
            `${siNo(z.BeginningOR ?? '')}–${siNo(z.EndingOR ?? '')}`, peso(z.NewGrandTotal),
            z.ClosedByName, z.ApprovedByName,
            <button key={z.ZReadId} className="underline text-accent-fg"
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
// Column kinds: 1 = money, 'n' = count, 'q' = quantity, 'pct' = percent (these are totalled),
// 'd' = date, 'si' = 18-digit sales invoice no., 'rtn' = 6-digit return no.
// total: which rows the total row adds up (true = all). cards: the headline figures above the table.
const sumOf = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0)
const card = (label, value, sub) => ({ label, value, sub })
const pesoSum = (rows, k) => '₱' + peso(sumOf(rows, k))
const completed = r => r.Status === 'Completed'
const LESS_VAT_NOTE = 'Gross − discounts − less VAT = net. "Less VAT" is the 12% VAT taken off senior/PWD ' +
  'VAT-exempt sales. Cash sales are cash received less change, so cash + card + gift cert. = net sales.'

const REPORTS = [
  { key: 'sales-summary', name: 'Sales Summary', total: true,
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'],
      ['BegSI', 'First SI', 'si'], ['EndSI', 'Last SI', 'si'], ['InvoiceCount', 'Invoices', 'n'], ['TxnCount', 'Sales', 'n'],
      ['GrossSales', 'Gross sales', 1], ['DiscSenior', 'SC disc.', 1], ['DiscPwd', 'PWD disc.', 1],
      ['DiscNaac', 'NAAC disc.', 1], ['DiscMov', 'MOV disc.', 1], ['DiscSolo', 'Solo parent disc.', 1],
      ['DiscOther', 'Regular/other disc.', 1], ['DiscPromo', 'Promos', 1], ['Discounts', 'Total discounts', 1], ['LessVat', 'Less VAT (SC/PWD)', 1],
      ['NetSales', 'Net sales', 1], ['VatableSales', 'VATable sales', 1], ['VatAmount', 'VAT', 1],
      ['VatExemptSales', 'VAT-exempt sales', 1], ['ZeroRatedSales', 'Zero-rated sales', 1], ['VatAdjustment', 'VAT adj.', 1],
      ['CashSales', 'Cash sales', 1], ['CardSales', 'Card sales', 1], ['CardTxns', 'Card txns', 'n'], ['GcSales', 'Gift cert.', 1],
      ['VoidCount', 'Voids', 'n'], ['VoidAmount', 'Void amount', 1], ['ReturnCount', 'Returns', 'n'],
      ['ReturnAmount', 'Return amount', 1], ['NetAfterReturns', 'Net after returns', 1], ['AvgSale', 'Avg sale', 1]],
    cards: rows => [
      card('Gross sales', pesoSum(rows, 'GrossSales'), `${sumOf(rows, 'TxnCount')} sales · ${sumOf(rows, 'InvoiceCount')} invoices`),
      card('Discounts', pesoSum(rows, 'Discounts'), `Less VAT ₱${peso(sumOf(rows, 'LessVat'))}`),
      card('Net sales', pesoSum(rows, 'NetSales'), `VAT ₱${peso(sumOf(rows, 'VatAmount'))}`),
      card('Cash sales', pesoSum(rows, 'CashSales')),
      card('Card sales', pesoSum(rows, 'CardSales'), `${sumOf(rows, 'CardTxns')} card payments`),
      card('Voids', pesoSum(rows, 'VoidAmount'), `${sumOf(rows, 'VoidCount')} voided`),
      card('Returns', pesoSum(rows, 'ReturnAmount'), `${sumOf(rows, 'ReturnCount')} returns`),
      card('Net after returns', pesoSum(rows, 'NetAfterReturns'))],
    note: LESS_VAT_NOTE + ' Voids and returns are not in the sales figures; returns count on the day they were made.' },
  { key: 'sales-details', name: 'Sales Details', total: completed,
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'],
      ['ORNumber', 'SI No.', 'si'], ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['Status', 'Status'],
      ['CustomerName', 'Customer'], ['CustomerTin', 'TIN'], ['CustomerAddress', 'Address'], ['CustomerBusinessStyle', 'Business style'],
      ['LineCount', 'Lines', 'n'], ['ItemQty', 'Items', 'q'],
      ['GrossAmount', 'Gross', 1], ['DiscountCode', 'Disc. type'], ['DiscountAmount', 'Discount', 1],
      ['DiscountCtrlNo', 'ID / Ctrl No.'], ['DiscountName', 'Disc. name / reason'], ['DiscountApprovedBy', 'Disc. approved by'], ['DiscountCap', 'Limited to (weekly cap)', 'p'],
      ['DinerCount', 'Diners', 'n'], ['SeniorCount', 'SC/PWD diners', 'n'], ['LessVat', 'Less VAT (SC/PWD)', 1],
      ['VatableAmount', 'VATable sales', 1], ['VatAmount', 'VAT', 1],
      ['VatExemptAmount', 'VAT-exempt sales', 1], ['ZeroRatedAmount', 'Zero-rated sales', 1],
      ['VatAdjustment', 'VAT adj.', 1], ['NetAmount', 'Net', 1], ['TenderedAmount', 'Tendered', 1],
      ['ChangeAmount', 'Change', 1], ['CashSales', 'Cash sales', 1], ['CardSales', 'Card sales', 1], ['GcSales', 'Gift cert.', 1],
      ['GcForfeited', 'GC forfeited', 1], ['Payments', 'Payment'],
      ['ReturnedAmount', 'Returned later', 1], ['ZeroRatedCertNo', 'Cert/ID No.'], ['PriceLevel', 'Price level'],
      ['VoidedAt', 'Voided at'], ['VoidedBy', 'Voided by'], ['VoidReason', 'Void reason']],
    cards: rows => {
      const ok = rows.filter(completed), voided = rows.filter(r => r.Status === 'Voided')
      return [
        card('Invoices issued', String(rows.length), `${ok.length} completed · ${voided.length} voided`),
        card('Gross sales', pesoSum(ok, 'GrossAmount')),
        card('Discounts', pesoSum(ok, 'DiscountAmount'), `${ok.filter(r => Number(r.DiscountAmount) > 0).length} discounted sales`),
        card('Net sales', pesoSum(ok, 'NetAmount'), `VAT ₱${peso(sumOf(ok, 'VatAmount'))}`),
        card('Cash sales', pesoSum(ok, 'CashSales')),
        card('Card sales', pesoSum(ok, 'CardSales')),
        card('Voided', pesoSum(voided, 'NetAmount'), `${voided.length} invoices`),
        card('Returned later', pesoSum(ok, 'ReturnedAmount'))]
    },
    note: 'VATable, VAT, VAT-exempt and zero-rated sales are as printed on each invoice. On a senior/PWD ' +
      'discount, VAT-exempt sales is the amount before the discount, so the four don\'t always add up to Net. ' +
      'VAT adj. is for information only. The total row leaves out voided sales.' },
  { key: 'branch-comparison', name: 'Branch Comparison', total: true,
    cols: [['BranchCode', 'Branch'], ['BranchName', 'Name'], ['Terminals', 'Terminals', 'n'], ['TxnCount', 'Sales', 'n'],
      ['GrossSales', 'Gross sales', 1], ['Discounts', 'Discounts', 1], ['LessVat', 'Less VAT (SC/PWD)', 1],
      ['NetSales', 'Net sales', 1], ['VatableSales', 'VATable sales', 1], ['VatAmount', 'VAT', 1],
      ['VatExemptSales', 'VAT-exempt sales', 1], ['ZeroRatedSales', 'Zero-rated sales', 1],
      ['CashSales', 'Cash sales', 1], ['CardSales', 'Card sales', 1], ['GcSales', 'Gift cert.', 1], ['VoidCount', 'Voids', 'n'], ['VoidAmount', 'Void amount', 1],
      ['ReturnCount', 'Returns', 'n'], ['ReturnAmount', 'Return amount', 1], ['NetAfterReturns', 'Net after returns', 1],
      ['AvgBasket', 'Avg sale', 1], ['SharePct', 'Share', 'pct']],
    cards: rows => [
      card('Branches selling', String(rows.length)),
      card('Net sales', pesoSum(rows, 'NetSales'), `${sumOf(rows, 'TxnCount')} sales`),
      card('Voids', pesoSum(rows, 'VoidAmount'), `${sumOf(rows, 'VoidCount')} voided`),
      card('Returns', pesoSum(rows, 'ReturnAmount'), `${sumOf(rows, 'ReturnCount')} returns`)],
    note: LESS_VAT_NOTE },
  { key: 'payment-breakdown', name: 'Payment Breakdown', total: true,
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TxnCount', 'Sales', 'n'], ['CashTxns', 'Cash txns', 'n'],
      ['CashReceived', 'Cash received', 1], ['ChangeGiven', 'Change given', 1], ['CashSales', 'Cash sales', 1],
      ['CardTxns', 'Card txns', 'n'], ['CardSales', 'Card sales', 1], ['GcTxns', 'GC txns', 'n'], ['GcSales', 'Gift cert.', 1],
      ['SplitTxns', 'Split payments', 'n'],
      ['NetSales', 'Net sales', 1], ['ReturnCount', 'Returns', 'n'], ['CashRefunds', 'Cash refunds', 1], ['NetCash', 'Net cash', 1]],
    cards: rows => [
      card('Cash sales', pesoSum(rows, 'CashSales'), `${sumOf(rows, 'CashTxns')} cash payments`),
      card('Card sales', pesoSum(rows, 'CardSales'), `${sumOf(rows, 'CardTxns')} card payments`),
      card('Gift certificates', pesoSum(rows, 'GcSales'), `${sumOf(rows, 'GcTxns')} sales`),
      card('Cash refunds', pesoSum(rows, 'CashRefunds'), `${sumOf(rows, 'ReturnCount')} returns`),
      card('Net cash', pesoSum(rows, 'NetCash'), 'Cash sales less refunds')],
    note: 'Cash received includes the change handed back; cash sales = received − change. Returns are refunded in cash. ' +
      'Gift cert. is what the gift certificates paid (no change on them).' },
  { key: 'card-transactions', name: 'Card Transactions', total: true,
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'], ['ORNumber', 'SI No.', 'si'],
      ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['CardBank', 'Bank'], ['CardNo', 'Card No.'], ['CardName', 'Card name'],
      ['CardRefNo', 'Reference No.'], ['InvoiceAmount', 'Invoice total', 1], ['Amount', 'Card amount', 1]],
    cards: rows => [card('Card payments', pesoSum(rows, 'Amount'), `${rows.length} payments`)] },
  { key: 'gift-certificates', name: 'Gift Certificates', total: true,
    note: 'Every gift certificate taken as payment. Check is what the list said when the sale synced: OK, or ' +
      'UNKNOWN / USED (used before) / EXPIRED / BRANCH (another branch\'s) / CANCELLED / VALUE (face value differs) for review. ' +
      'No change is given on a gift certificate; Forfeited is the value it didn\'t pay. Voided sales are left out.',
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'], ['ORNumber', 'SI No.', 'si'],
      ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['GcNo', 'GC No.'], ['GcCheck', 'Check'], ['GcValue', 'Face value', 1],
      ['Amount', 'Paid', 1], ['Forfeited', 'Forfeited', 1], ['IssuedTo', 'Issued to'], ['ExpiryDate', 'Expiry', 'd'],
      ['InvoiceAmount', 'Invoice total', 1]],
    cards: rows => {
      const bad = rows.filter(r => r.GcCheck !== 'OK')
      return [card('Gift certificates', pesoSum(rows, 'Amount'), `${rows.length} taken`),
        card('Forfeited', pesoSum(rows, 'Forfeited'), 'Value not used (no change)'),
        card('To review', String(bad.length), bad.length ? `₱${peso(sumOf(bad, 'Amount'))}: used, unknown, expired…` : 'All checked OK')]
    } },
  { key: 'promos', name: 'Promos', total: true,
    note: 'Every invoice line with promo-free units (Buy N Take M). Voided sales are left out.',
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'], ['ORNumber', 'SI No.', 'si'],
      ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['PromoName', 'Promo'], ['Kind', 'Kind'], ['ItemCode', 'Item code'],
      ['ProductName', 'Item'], ['Quantity', 'Qty', 'q'], ['FreeQty', 'Free', 'q'], ['RegularPrice', 'Price', 'p'],
      ['PromoAmount', 'Promo off', 1], ['LineTotal', 'Line total', 1], ['NetAmount', 'Paid', 1], ['DiscountCode', 'SC/PWD'],
      ['ReturnedQty', 'Returned qty', 'q']],
    cards: rows => [card('Given free', pesoSum(rows, 'PromoAmount'), `${rows.length} lines`)] },
  { key: 'wholesale', name: 'Wholesale (DTI)', total: true,
    note: 'Every invoice line sold at a wholesale price by quantity. Voided sales are left out; Returned qty shows what came back later.',
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'], ['ORNumber', 'SI No.', 'si'],
      ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['CustomerName', 'Customer'], ['CustomerTin', 'TIN'],
      ['ItemCode', 'Item code'], ['ProductName', 'Item'], ['Unit', 'Unit'], ['Quantity', 'Qty', 'q'],
      ['ItemTotalQty', 'Item qty in sale', 'q'], ['MinQty', 'From qty', 'q'], ['RegularPrice', 'Regular price', 'p'],
      ['AmountOff', 'Off per unit', 'p'], ['WholesalePrice', 'Wholesale price', 'p'], ['RegularAmount', 'At regular price', 1],
      ['WholesaleAmount', 'At wholesale price', 1], ['WholesaleSavings', 'Customer saved', 1], ['ReturnedQty', 'Returned qty', 'q']],
    cards: rows => [card('Sold at wholesale', pesoSum(rows, 'WholesaleAmount'), `${rows.length} lines`),
      card('Customers saved', pesoSum(rows, 'WholesaleSavings'))] },
  { key: 'discounts', name: 'Discounts (BIR)', total: true,
    cols: [['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'], ['ORNumber', 'SI No.', 'si'],
      ['SaleDateTime', 'Time'], ['Cashier', 'Cashier'], ['DiscountCode', 'Type'], ['DiscountCtrlNo', 'ID / Ctrl No.'],
      ['DiscountName', 'Name / reason'], ['ApprovedBy', 'Approved by'], ['DiscountCap', 'Limited to (weekly cap)', 'p'], ['PromoAmount', 'Of it promos', 1], ['DinerCount', 'Diners', 'n'], ['SeniorCount', 'SC/PWD diners', 'n'],
      ['CustomerName', 'Customer'], ['CustomerTin', 'TIN'],
      ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1], ['LessVat', 'Less VAT', 1],
      ['VatExemptAmount', 'VAT-exempt sales', 1], ['VatAdjustment', 'VAT adj.', 1], ['NetAmount', 'Net', 1]],
    cards: rows => {
      const by = {}
      rows.forEach(r => { by[r.DiscountCode || '—'] = (by[r.DiscountCode || '—'] || 0) + Number(r.DiscountAmount || 0) })
      return [card('Total discounts', pesoSum(rows, 'DiscountAmount'), `${rows.length} sales`),
        card('Less VAT (SC/PWD)', pesoSum(rows, 'LessVat')),
        ...Object.entries(by).map(([k, v]) => card(k === 'OTHER' ? 'Regular/other' : k, '₱' + peso(v),
          `${rows.filter(r => (r.DiscountCode || '—') === k).length} sales`))]
    } },
  { key: 'group-category', name: 'Group by Category', total: true,
    cols: [['BranchCode', 'Branch'], ['CategoryName', 'Category'], ['TxnCount', 'Sales', 'n'], ['TotalQty', 'Qty', 'q'],
      ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1], ['LessVat', 'Less VAT', 1], ['TotalAmount', 'Net', 1],
      ['VatAmount', 'VAT', 1], ['ReturnedQty', 'Returned qty', 'q'], ['ReturnedAmount', 'Returned', 1],
      ['NetAfterReturns', 'Net after returns', 1], ['SharePct', 'Share', 'pct']],
    cards: rows => [card('Net sales', pesoSum(rows, 'TotalAmount'), `${rows.length} categories`),
      card('Returned', pesoSum(rows, 'ReturnedAmount'))],
    note: LESS_VAT_NOTE.split('. Cash')[0] + '.' },
  { key: 'group-items', name: 'Group by Item', total: true,
    cols: [['BranchCode', 'Branch'], ['Barcode', 'Barcode'], ['ProductName', 'Item'], ['CategoryName', 'Category'],
      ['TxnCount', 'Sales', 'n'], ['TotalQty', 'Qty', 'q'], ['AvgPrice', 'Avg price', 1],
      ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1], ['LessVat', 'Less VAT', 1], ['TotalAmount', 'Net', 1],
      ['VatAmount', 'VAT', 1], ['ReturnedQty', 'Returned qty', 'q'], ['ReturnedAmount', 'Returned', 1],
      ['NetAfterReturns', 'Net after returns', 1]],
    cards: rows => [card('Net sales', pesoSum(rows, 'TotalAmount'), `${rows.length} items`),
      card('Quantity sold', fmtQty(sumOf(rows, 'TotalQty'))), card('Returned', pesoSum(rows, 'ReturnedAmount'))],
    note: LESS_VAT_NOTE.split('. Cash')[0] + '.' },
  { key: 'void-return', name: 'Void / Return', total: true,
    cols: [['Kind', 'Kind'], ['BusinessDate', 'Date', 'd'], ['BranchCode', 'Branch'], ['TerminalCode', 'Terminal'],
      ['ReturnNo', 'Return No.', 'rtn'], ['ORNumber', 'SI No.', 'si'], ['SoldAt', 'Sold at'], ['DoneAt', 'Voided / returned at'],
      ['Cashier', 'Cashier'], ['ApprovedBy', 'Approved by'], ['GrossAmount', 'Gross', 1], ['DiscountAmount', 'Discount', 1],
      ['VatAmount', 'VAT', 1], ['NetAmount', 'Amount', 1], ['Reason', 'Reason']],
    cards: rows => {
      const v = rows.filter(r => r.Kind === 'Void'), r2 = rows.filter(r => r.Kind === 'Return')
      return [card('Voids', pesoSum(v, 'NetAmount'), `${v.length} voided`), card('Returns', pesoSum(r2, 'NetAmount'), `${r2.length} returns`)]
    } },
  { key: 'cashier-performance', name: 'Cashier Performance', total: true,
    cols: [['Cashier', 'Cashier'], ['BranchCode', 'Branch'], ['Shifts', 'Shifts', 'n'], ['TxnCount', 'Sales', 'n'],
      ['GrossSales', 'Gross sales', 1], ['Discounts', 'Discounts', 1], ['LessVat', 'Less VAT (SC/PWD)', 1],
      ['NetSales', 'Net sales', 1], ['CashSales', 'Cash sales', 1], ['CardSales', 'Card sales', 1], ['GcSales', 'Gift cert.', 1],
      ['Voids', 'Voids', 'n'], ['VoidAmount', 'Void amount', 1], ['ReturnCount', 'Returns', 'n'],
      ['ReturnAmount', 'Return amount', 1], ['AvgSale', 'Avg sale', 1], ['NetShortOver', 'Net short/(over)', 1]],
    cards: rows => [card('Cashiers', String(rows.length)), card('Net sales', pesoSum(rows, 'NetSales'), `${sumOf(rows, 'TxnCount')} sales`),
      card('Voids', pesoSum(rows, 'VoidAmount'), `${sumOf(rows, 'Voids')} voided`)] },
  { key: 'audit-logs', name: 'Audit Logs',
    cols: [['CreatedAt', 'When'], ['BranchCode', 'Branch'], ['Username', 'User'],
      ['TerminalCode', 'Terminal'], ['Action', 'Action'], ['Detail', 'Detail']] }
]

const TOTALLED = [1, 'n', 'q']
const fmtQty = (v) => Number(v).toLocaleString('en-PH', { maximumFractionDigits: 3 })
// kind: see REPORTS above
const fmtCell = (v, kind) => {
  if (v === null || v === undefined || v === '') return '—'
  if (kind === 'si') return siNo(v)
  if (kind === 'rtn') return returnNo(v)
  if (kind === 'd') return String(v).slice(0, 10)
  if (kind === 1 || kind === 'p') return peso(v)   // 'p': money that isn't added up in the total row
  if (kind === 'q') return fmtQty(v)
  if (kind === 'pct') return `${Number(v).toFixed(1)}%`
  const s = String(v)
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.replace('T', ' ').slice(0, 19) : s
}

// The values of the total row: the sum of each money / count / quantity column, "Total (n)" first
function totalValues(report, rows) {
  return report.cols.map(([key, , kind], i) => {
    if (i === 0) return `Total (${rows.length})`
    if (kind === 'pct') return rows.length ? '100.0%' : ''
    return TOTALLED.includes(kind) ? fmtCell(sumOf(rows, key), kind) : ''
  })
}

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

  const totalOf = (rs) => sel.total ? rs.filter(sel.total === true ? () => true : sel.total) : null
  const totals = rows?.length && sel.total ? totalValues(sel, totalOf(rows)) : null

  const exportCsvRows = () => {
    if (!rows?.length) return
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const raw = (r, [k, , kind]) => r[k] == null ? '' : kind === 'si' ? siNo(r[k]) : kind === 'rtn' ? returnNo(r[k])
      : kind === 'd' ? String(r[k]).slice(0, 10) : String(r[k])
    const lines = [sel.cols.map(c => q(c[1])).join(','), ...rows.map(r => sel.cols.map(c => q(raw(r, c))).join(','))]
    if (totals) lines.push(totals.map(v => q(String(v).replace(/,/g, ''))).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = `${sel.key}-${from}_${to}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const cards = rows && sel.cards ? sel.cards(rows) : []
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
      {cards.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {cards.map(c => <Stat key={c.label} label={c.label} value={c.value} sub={c.sub} />)}
        </div>
      )}
      {!rows ? <Spinner /> : (
        <Table head={sel.cols.map(c => c[1])}
          rows={[
            ...rows.map(r => sel.cols.map(c => fmtCell(r[c[0]], c[2]))),
            ...(totals ? [totals.map((v, i) => <strong key={i}>{v}</strong>)] : [])
          ]} />
      )}
      {sel.note && rows?.length > 0 && <p className="text-xs text-muted">{sel.note}</p>}
    </div>
  )
}

/* ================= Accounting (Addendum B) =================
   Read-only for now: turn the module on, then see what End of Day has posted. Owner-facing
   words first ("Account balances", "Months"); the accountant's terms (trial balance, general
   ledger) are shown as secondary labels. Every report carries the management-report label
   until CAS accreditation — keep it in the header, not a footnote. */
const ACC_VIEWS = [
  { key: 'balances', name: 'Account balances', sub: 'Trial balance' },
  { key: 'history', name: 'Account history', sub: 'General ledger' },
  { key: 'journal', name: 'All entries', sub: 'General journal' },
  { key: 'months', name: 'Months', sub: 'Accounting periods' }
]
const MGMT_LABEL = 'Management report — not an official book of accounts.'
const SOURCE_LABEL = { ZREAD: 'End of Day', REVERSAL: 'Reversal', MANUAL: 'Manual entry' }
const d10 = (v) => (v ? String(v).slice(0, 10) : '—')
const money = (v) => (Number(v) ? peso(v) : '')

function Accounting({ branchFilter, flash }) {
  const { data, error, reload } = useApi('/api/accounting/status')
  const [view, setView] = useState('balances')

  if (error) return <ErrorBar message={`${error} — if this persists, 16_accounting.sql may not have been run on this database.`} />
  if (!data) return <Spinner />
  if (!data.settings) return <AccountingSetup templates={data.templates} flash={flash} onDone={reload} />

  const tmpl = data.templates.find(t => t.code === data.settings.TemplateCode)
  return (
    <div className="space-y-3">
      <Note tone="amber"><strong>{MGMT_LABEL}</strong></Note>
      <p className="text-xs text-muted">
        {tmpl?.name || data.settings.TemplateCode} chart of accounts · End of Day posts automatically
        from {d10(data.settings.StartDate)}{branchFilter ? ` · showing branch ${branchFilter}` : ' · all branches'}
      </p>
      <div className="flex gap-2 flex-wrap">
        {ACC_VIEWS.map(v => (
          <Btn key={v.key} variant={view === v.key ? 'moss' : 'ghost'} className="!min-h-[40px] text-sm text-left"
            onClick={() => setView(v.key)}>
            {v.name} <span className="block text-[10px] font-normal opacity-70">{v.sub}</span>
          </Btn>
        ))}
      </div>
      {view === 'balances' && <AccBalances branchFilter={branchFilter} />}
      {view === 'history' && <AccHistory branchFilter={branchFilter} />}
      {view === 'journal' && <AccJournal branchFilter={branchFilter} />}
      {view === 'months' && <AccMonths flash={flash} />}
    </div>
  )
}

function AccountingSetup({ templates, flash, onDone }) {
  const [templateCode, setTemplateCode] = useState(templates[0]?.code || 'RETAIL')
  const [startDate, setStartDate] = useState(today())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const turnOn = async () => {
    setBusy(true); setErr('')
    try {
      await api('/api/accounting/setup', { method: 'POST', body: JSON.stringify({ templateCode, startDate }) })
      flash('Accounting is on'); onDone()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="bg-panel rounded-xl border border-line p-5 max-w-xl space-y-4">
      <h2 className="font-bold text-lg">Keep your books in SparkPOS</h2>
      <p className="text-sm text-fg2">
        Once this is on, every End of Day records the day's sales, VAT, discounts, card payments and
        any cash short/over in your books automatically. You don't need to know accounting to use it.
      </p>
      <Field label="What kind of business is this?">
        <Select className="w-full" value={templateCode} onChange={e => setTemplateCode(e.target.value)}>
          {templates.map(t => <option key={t.code} value={t.code}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Start recording from (business date)">
        <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
      </Field>
      <Note tone="stone">
        Days closed before this date are not recorded. If recording ever fails (for example, the month
        has been closed in the books), End of Day stops with a message instead of closing the day
        unrecorded.
      </Note>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      <Btn variant="moss" className="w-full" disabled={busy} onClick={turnOn}>
        {busy ? 'Setting up…' : 'Turn on accounting'}
      </Btn>
    </div>
  )
}

function AccBalances({ branchFilter }) {
  const [asOf, setAsOf] = useState(today())
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const load = async () => {
    setRows(null); setErr('')
    try {
      setRows(await api(`/api/accounting/trial-balance?asOf=${asOf}` + (branchFilter ? `&branchCode=${branchFilter}` : '')))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [branchFilter]) // eslint-disable-line

  const dr = rows?.reduce((s, r) => s + Number(r.Debit), 0) || 0
  const cr = rows?.reduce((s, r) => s + Number(r.Credit), 0) || 0
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <span className="text-sm text-muted">As of</span>
        <Input type="date" className="!w-auto" value={asOf} onChange={e => setAsOf(e.target.value)} />
        <Btn variant="dark" onClick={load}>Load</Btn>
      </div>
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {!rows ? <Spinner /> : (
        <>
          <Table head={['Account', 'Code', 'Type', 'Debit', 'Credit']} empty="Nothing recorded yet."
            rows={[
              ...rows.map(r => [
                <span key="n">{r.PlainName}<span className="block text-[11px] text-muted">{r.AccountName}</span></span>,
                r.AccountCode, r.AccountType, money(r.Debit), money(r.Credit)]),
              ...(rows.length ? [[<strong key="t">Total</strong>, '', '', <strong key="d">{peso(dr)}</strong>, <strong key="c">{peso(cr)}</strong>]] : [])
            ]} />
          {rows.length > 0 && Math.abs(dr - cr) > 0.005 && (
            <Note tone="red">Debits and credits don't match ({peso(dr)} vs {peso(cr)}). This should never happen — contact ITCORE support.</Note>
          )}
        </>
      )}
    </div>
  )
}

function AccHistory({ branchFilter }) {
  const { data: accounts, error: aErr } = useApi('/api/accounting/accounts')
  const [accountId, setAccountId] = useState('')
  const [from, setFrom] = useState(today().slice(0, 8) + '01')
  const [to, setTo] = useState(today())
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  const load = async (id = accountId) => {
    if (!id) return
    setData(null); setErr('')
    try {
      setData(await api(`/api/accounting/ledger?accountId=${id}&dateFrom=${from}&dateTo=${to}`
        + (branchFilter ? `&branchCode=${branchFilter}` : '')))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [branchFilter]) // eslint-disable-line

  // Balances come back debit-positive; flip for credit-normal accounts so the owner sees
  // "Sales 12,000" rather than "(12,000)".
  const sign = data?.account?.NormalSide === 'Credit' ? -1 : 1
  return (
    <div className="space-y-3">
      <ErrorBar message={aErr || err} onDismiss={() => setErr('')} />
      <Select className="w-full max-w-md" value={accountId}
        onChange={e => { setAccountId(e.target.value); load(e.target.value) }}>
        <option value="">Choose an account…</option>
        {(accounts || []).map(a => <option key={a.AccountId} value={a.AccountId}>{a.PlainName} ({a.AccountCode})</option>)}
      </Select>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} onLoad={() => load()} />
      {accountId && !data && !err && <Spinner />}
      {data && (
        <>
          <p className="text-sm">
            <strong>{data.account.PlainName}</strong> <span className="text-muted">{data.account.AccountName}</span>
            {' · '}Balance at start: <strong>{peso(sign * data.account.OpeningBalance)}</strong>
          </p>
          <Table head={['Date', 'Entry #', 'From', 'Details', 'Branch', 'Debit', 'Credit', 'Balance']}
            empty="No activity in this range."
            rows={data.lines.map(l => [
              d10(l.EntryDate), l.EntryNo, SOURCE_LABEL[l.SourceType] || l.SourceType,
              l.Memo || l.EntryMemo, l.BranchCode || '—', money(l.Debit), money(l.Credit), peso(sign * l.Balance)])} />
        </>
      )}
    </div>
  )
}

function AccJournal({ branchFilter }) {
  const [from, setFrom] = useState(today().slice(0, 8) + '01')
  const [to, setTo] = useState(today())
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [err, setErr] = useState('')
  const load = async () => {
    setData(null); setErr('')
    try {
      setData(await api(`/api/accounting/journal?dateFrom=${from}&dateTo=${to}` + (branchFilter ? `&branchCode=${branchFilter}` : '')))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [branchFilter]) // eslint-disable-line

  const linesOf = (uid) => data.lines.filter(l => l.EntryUid === uid)
  return (
    <div className="space-y-3">
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} onLoad={load} />
      <ErrorBar message={err} onDismiss={() => setErr('')} />
      {!data ? <Spinner /> : (
        <Table head={['Entry #', 'Date', 'From', 'Details', 'Branch', 'Amount', '']} empty="No entries in this range."
          rows={data.entries.map(e => [
            e.EntryNo, d10(e.EntryDate), SOURCE_LABEL[e.SourceType] || e.SourceType,
            <span key="m">{e.Memo}{e.ReversedByUid && <span className="ml-2 text-xs text-danger-fg font-semibold">reversed</span>}</span>,
            e.BranchCode || '—', peso(e.TotalAmount),
            <button key="b" className="underline text-accent-fg" onClick={() => setOpen(e)}>Lines</button>])} />
      )}
      {open && (
        <Modal wide onClose={() => setOpen(null)}>
          <h2 className="font-bold text-lg">Entry #{open.EntryNo} · {d10(open.EntryDate)}</h2>
          <p className="text-sm text-muted">{open.Memo}{open.PostedBy ? ` · by ${open.PostedBy}` : ''}</p>
          <Table head={['Account', 'Details', 'Debit', 'Credit']}
            rows={linesOf(open.EntryUid).map(l => [
              <span key="a">{l.PlainName}<span className="block text-[11px] text-muted">{l.AccountCode} {l.AccountName}</span></span>,
              l.Memo || '', money(l.Debit), money(l.Credit)])} />
          <Btn variant="dark" className="w-full" onClick={() => setOpen(null)}>Close</Btn>
        </Modal>
      )}
    </div>
  )
}

function AccMonths({ flash }) {
  const { data, error, reload } = useApi('/api/accounting/periods')
  const [confirm, setConfirm] = useState(null)   // { p, status }
  const [err, setErr] = useState('')
  const label = (p) => new Date(p.PeriodYear, p.PeriodMonth - 1, 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' })

  const apply = async () => {
    const { p, status } = confirm
    setConfirm(null); setErr('')
    try {
      await api(`/api/accounting/periods/${p.PeriodYear}/${p.PeriodMonth}/status`,
        { method: 'POST', body: JSON.stringify({ status }) })
      flash(`${label(p)}: ${status.toLowerCase()}`); reload()
    } catch (e) { setErr(e.message) }
  }

  return (
    <div className="space-y-3">
      <ErrorBar message={error || err} onDismiss={() => setErr('')} />
      <Note tone="stone">
        <strong>Closed</strong> months accept no new entries (End of Day for a date in a closed month
        will stop with a message) but can be reopened. <strong>Locked</strong> is permanent: use it once
        a month's books have been finalized with your accountant. A month appears here once something
        is recorded in it.
      </Note>
      {!data ? <Spinner /> : (
        <Table head={['Month', 'Status', 'Entries', 'Closed by', '']} empty="Nothing recorded yet."
          rows={data.map(p => [
            label(p),
            <span key="s" className={p.Status === 'Open' ? 'text-accent-fg font-semibold' : 'text-fg2 font-semibold'}>{p.Status}</span>,
            p.EntryCount, p.ClosedBy ? `${p.ClosedBy} · ${d10(p.ClosedAt)}` : '—',
            <span key="a" className="flex gap-3">
              {p.Status === 'Open' && <button className="underline text-fg" onClick={() => setConfirm({ p, status: 'Closed' })}>Close</button>}
              {p.Status === 'Closed' && <button className="underline text-accent-fg" onClick={() => setConfirm({ p, status: 'Open' })}>Reopen</button>}
              {p.Status !== 'Locked' && <button className="underline text-danger-fg" onClick={() => setConfirm({ p, status: 'Locked' })}>Lock</button>}
            </span>])} />
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2 className="font-bold text-lg">
            {confirm.status === 'Locked' ? 'Lock' : confirm.status === 'Closed' ? 'Close' : 'Reopen'} {label(confirm.p)}?
          </h2>
          {confirm.status === 'Locked' && <Note tone="red">Locking is permanent. This month can never be reopened.</Note>}
          {confirm.status === 'Closed' && <Note tone="amber">End of Day for any date in this month will be blocked until it's reopened.</Note>}
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={() => setConfirm(null)}>Cancel</Btn>
            <Btn variant={confirm.status === 'Locked' ? 'primary' : 'dark'} className="flex-1" onClick={apply}>Confirm</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

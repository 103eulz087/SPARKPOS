import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { forgetCredential, offlineSignInSupported, rememberCredential, verifyOffline } from '../lib/offlineAuth'
import { useAuth, useShift } from '../lib/store'
import { Btn, Cube, ErrorBar, Field, Input, Note, Select, StatusPill, Wordmark } from '../components/Ui'

/** No branch picker: a user works at their own assigned branch (from the ERP's AssignedBranch
 *  for ERP users). Only someone who may work at several — an Admin — is asked to pick one,
 *  after the password checks out (the server answers needsBranch with the list).
 *  With no connection, a cashier/supervisor who signed in online on this device before can
 *  sign in offline (lib/offlineAuth.js) and resume their own open shift.
 *  A till assigned to its terminal shows which one it is, and takes only that branch's users
 *  (the server refuses the rest; offline, the remembered till is checked here). */
const TILL_KEY = 'pos_till'
const readTill = () => { try { return JSON.parse(localStorage.getItem(TILL_KEY)) } catch { return null } }
const saveTill = (t) => { try { t ? localStorage.setItem(TILL_KEY, JSON.stringify(t)) : localStorage.removeItem(TILL_KEY) } catch { /* private mode */ } }

export default function Login() {
  const nav = useNavigate()
  const setAuth = useAuth(s => s.setAuth)
  const { setShift, clearShift } = useShift()

  const [branches, setBranches] = useState(null)   // set when the server asks to pick one
  const [branchCode, setBranchCode] = useState(localStorage.getItem('pos_lastBranch') || '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [till, setTill] = useState(readTill)
  useEffect(() => {
    api('/api/auth/device').then(t => { setTill(t); saveTill(t) }).catch(() => { /* offline: keep the remembered one */ })
  }, [])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  /** If this device remembers an open shift on some terminal and it still belongs to the
   *  cashier who just signed in, resume straight into POS instead of Cash Begin — this is
   *  what makes an accidental sign-out/sign-in recoverable without re-running Cash Begin.
   *  Deliberately does NOT trust local state alone online: a different cashier signing in on
   *  the same device must never be dropped into someone else's open shift. Offline, the
   *  shift's recorded cashier (pos_cashierUserId) is the only check there is. */
  const resumed = async (userId, offline = false) => {
    const terminalId = Number(localStorage.getItem('pos_terminalId')) || null
    if (!terminalId) return false
    if (offline) return !!localStorage.getItem('pos_shiftUid') && Number(localStorage.getItem('pos_cashierUserId')) === userId
    try {
      const open = await api(`/api/shifts/current?terminalId=${terminalId}`)
      if (open && open.CashierUserId === userId) {
        setShift({
          shiftUid: open.ShiftUid, terminalId: open.TerminalId, terminalCode: open.TerminalCode,
          businessDate: String(open.BusinessDate).slice(0, 10), cashBegin: Number(open.CashBegin),
          cashierUserId: open.CashierUserId
        })
        return true
      }
    } catch { /* server unreachable or lookup failed — fall back to Cash Begin */ }
    if (localStorage.getItem('pos_shiftUid')) clearShift()
    return false
  }

  const enter = async (r, offline) => {
    setAuth(r)
    if (r.role === 'Cashier') {
      if (await resumed(r.userId, offline)) return nav('/pos')
      if (offline) {
        setError('Offline you can only resume your own open shift on this device. Reconnect to start one.')
        return
      }
      nav('/cash-begin')
    } else {
      nav('/admin')
    }
  }

  const signInOffline = async () => {
    const p = await verifyOffline(username, password)
    if (till && p.role !== 'Admin' && p.branchCode !== till.branchCode)
      throw new Error(`This till is ${till.terminalCode} of branch ${till.branchCode}. Sign in at your own branch's till.`)
    await enter({ ...p, token: null, branches: [p.branchCode] }, true)
  }

  const submit = async () => {
    if (!username || !password || (branches && !branchCode)) return
    setBusy(true); setError('')
    try {
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, branchCode: branches ? branchCode : null })
      })
      if (r.needsBranch) {
        setBranches(r.branches)
        if (!r.branches.some(b => b.BranchCode === branchCode)) setBranchCode(r.branches[0]?.BranchCode || '')
        return
      }
      localStorage.setItem('pos_lastBranch', r.branchCode)
      await rememberCredential(username, password, {
        userId: r.userId, username: r.username, fullName: r.fullName, role: r.role, branchCode: r.branchCode
      })
      await enter(r, false)
    } catch (e) {
      if (e instanceof TypeError || !navigator.onLine) {
        // fetch itself failed: no connection to the server
        try { await signInOffline() } catch (o) { setError(o.message) }
      } else {
        if (/isn't set up for SparkPOS|aren't assigned|must change your password/.test(e.message)) await forgetCredential(username)
        setError(e.message)
      }
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex flex-col bg-ink relative overflow-hidden">
      {/* the logo's cube, drawn as faint outlines in the empty space */}
      <Cube size={260} className="absolute -right-10 top-10 text-line hidden sm:block" />
      <Cube size={180} className="absolute left-16 bottom-16 text-line hidden sm:block" />
      <Cube size={72} className="absolute right-28 top-80 text-accent/40 hidden sm:block" />
      <Cube size={150} className="absolute -left-12 bottom-6 text-line sm:hidden" />

      <header className="relative flex items-center justify-between px-5 sm:px-12 pt-6">
        <Wordmark className="text-xl sm:text-2xl" />
        <StatusPill online={online} />
      </header>

      <main className="relative flex-1 flex flex-col items-center justify-center gap-7 px-5 py-8">
        <form className="w-full max-w-[420px] bg-panel border border-line rounded-3xl p-6 sm:p-10 space-y-5 shadow-2xl"
          onSubmit={e => { e.preventDefault(); submit() }}>
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="w-[76px] h-[76px] rounded-[20px] bg-white flex items-center justify-center">
              <img src="/icons/icon-192.png" alt="SparkPOS" className="w-[66px] h-[66px] object-contain" />
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display font-bold text-[28px] leading-tight">Welcome back</h1>
              <p className="text-muted text-[15px]">Sign in to open your till or the admin console.</p>
              {till && (
                <p className="pt-1 text-[13px] text-fg2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-2 align-middle" />
                  This till: <b className="text-fg">{till.terminalCode}</b> · {till.branchCode} {till.branchName}
                </p>
              )}
            </div>
          </div>
          <Field label="Username">
            <Input placeholder="e.g. jdelacruz" autoCapitalize="none" autoCorrect="off" autoFocus autoComplete="username"
              className="!min-h-[52px]"
              value={username} onChange={e => { setUsername(e.target.value); setBranches(null) }} />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" className="!min-h-[52px]" value={password}
              onChange={e => setPassword(e.target.value)} />
          </Field>
          {branches && (
            <Field label="Branch">
              <Select className="w-full !min-h-[52px]" value={branchCode} onChange={e => setBranchCode(e.target.value)}>
                {branches.map(b => (
                  <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>
                ))}
              </Select>
            </Field>
          )}
          <ErrorBar message={error} onDismiss={() => setError('')} />
          <Btn type="submit" variant="primary" className="w-full text-[17px] !min-h-[56px]" disabled={busy}>
            {busy ? 'Signing in…' : branches ? 'Continue' : 'Sign in'}
          </Btn>
          {!online && (offlineSignInSupported()
            ? <Note tone="amber">Offline — only someone who signed in on this device before can sign in.</Note>
            : <Note tone="amber">Offline sign-in needs the POS on https://. Reconnect to sign in.</Note>)}
        </form>

        <ul className="hidden sm:flex gap-3 text-[13px] text-fg2">
          {['Keeps selling offline', 'BIR-ready invoices', 'Linked to your ERP'].map(t => (
            <li key={t} className="px-3.5 py-2 border border-line rounded-full">{t}</li>
          ))}
        </ul>
      </main>

      <footer className="relative flex justify-between gap-4 px-5 sm:px-12 pb-6 text-[13px] text-muted">
        <span>SparkPOS by ITCORE Solution Inc.</span>
        <span className="tabnum">v{__APP_VERSION__}</span>
      </footer>
    </div>
  )
}

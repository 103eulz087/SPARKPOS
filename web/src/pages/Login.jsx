import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth, useShift } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Select } from '../components/Ui'

export default function Login() {
  const nav = useNavigate()
  const setAuth = useAuth(s => s.setAuth)
  const { setShift, clearShift } = useShift()

  const [branches, setBranches] = useState([])
  const [branchCode, setBranchCode] = useState(localStorage.getItem('pos_branchCode') || '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('/api/auth/branches')
      .then(rows => {
        setBranches(rows)
        if (!branchCode && rows.length) setBranchCode(rows[0].BranchCode)
      })
      .catch(e => setError(`Cannot reach the server: ${e.message}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** If this device remembers an open shift on some terminal and it still belongs to the
   *  cashier who just signed in, resume straight into POS instead of Cash Begin — this is
   *  what makes an accidental sign-out/sign-in recoverable without re-running Cash Begin.
   *  Deliberately does NOT trust local state alone: a different cashier signing in on the
   *  same device must never be dropped into someone else's open shift. */
  const resumed = async (userId) => {
    const terminalId = Number(localStorage.getItem('pos_terminalId')) || null
    if (!terminalId) return false
    try {
      const open = await api(`/api/shifts/current?terminalId=${terminalId}`)
      if (open && open.CashierUserId === userId) {
        setShift({
          shiftUid: open.ShiftUid, terminalId: open.TerminalId, terminalCode: open.TerminalCode,
          businessDate: String(open.BusinessDate).slice(0, 10), cashBegin: Number(open.CashBegin)
        })
        return true
      }
    } catch { /* server unreachable or lookup failed — fall back to Cash Begin */ }
    if (localStorage.getItem('pos_shiftUid')) clearShift()
    return false
  }

  const submit = async () => {
    if (!username || !password || !branchCode) return
    setBusy(true); setError('')
    try {
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, branchCode })
      })
      setAuth(r)

      if (r.role === 'Cashier') {
        nav(await resumed(r.userId) ? '/pos' : '/cash-begin')
      } else {
        nav('/admin')
      }
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-stone-900">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <div className="bg-white rounded-2xl px-6 py-5 shadow-2xl">
            <img src="/logo-login.png" alt="SparkPOS" className="w-full max-w-[220px] h-auto" />
          </div>
        </div>
        <div className="bg-white rounded-2xl p-6 space-y-4 shadow-2xl">
          <Field label="Branch">
            <Select className="w-full" value={branchCode} onChange={e => setBranchCode(e.target.value)}>
              {branches.map(b => (
                <option key={b.BranchCode} value={b.BranchCode}>{b.BranchCode} — {b.BranchName}</option>
              ))}
            </Select>
          </Field>
          <Input placeholder="Username" autoCapitalize="none" autoCorrect="off"
            value={username} onChange={e => setUsername(e.target.value)} />
          <Input placeholder="Password" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />
          <ErrorBar message={error} onDismiss={() => setError('')} />
          <Btn variant="primary" className="w-full text-lg" disabled={busy} onClick={submit}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Btn>
        </div>
        <p className="text-white/40 text-xs text-center mt-5">
          {navigator.onLine ? 'Connected' : 'Offline — a connection is required to sign in'}
        </p>
      </div>
    </div>
  )
}

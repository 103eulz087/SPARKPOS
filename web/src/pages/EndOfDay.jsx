import React, { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, pendingCount, printText, syncPendingSales } from '../lib/api'
import { useAuth, useCart, useShift } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Note, Paper, Spinner } from '../components/Ui'

/**
 * One End of Day screen for every path:
 *   - cashier straight after blind close
 *   - the same cashier signing back in later
 *   - an admin closing the day from the console
 * Whether a Supervisor/Admin credential is required is configurable per branch
 * (Admin → POS Settings → "Require supervisor override for End of Day"). An
 * Admin/Supervisor running it themselves never needs one either way.
 */
export default function EndOfDay() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const terminalId = Number(params.get('terminalId'))
  const businessDate = params.get('businessDate') || new Date().toISOString().slice(0, 10)

  const { branchCode, logout, role } = useAuth()
  const { clearShift } = useShift()
  const clearCart = useCart(s => s.clear)

  const [state, setState] = useState(null)
  const [queued, setQueued] = useState(0)
  const [printerTarget, setPrinterTarget] = useState(null)
  const [eodOverride, setEodOverride] = useState(true)   // conservative default until settings load
  const [approver, setApprover] = useState({ username: '', password: '', remarks: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const isPrivileged = role === 'Admin' || role === 'Supervisor'
  const needsOverride = eodOverride && !isPrivileged

  useEffect(() => {
    if (!terminalId) { setError('No terminal specified.'); return }
    api(`/api/eod/terminal-state/${terminalId}?businessDate=${businessDate}`)
      .then(setState).catch(e => setError(e.message))
    pendingCount().then(setQueued)
    api(`/api/terminals?branchCode=${branchCode}`)
      .then(ts => setPrinterTarget(ts.find(t => t.TerminalId === terminalId)?.PrinterTarget || null))
      .catch(() => {})
    api(`/api/settings/${branchCode}`)
      .then(s => setEodOverride(!!s.EodOverride))
      .catch(() => {})
  }, [terminalId, businessDate, branchCode])

  const process = async () => {
    setBusy(true); setError('')
    try {
      await syncPendingSales()
      const left = await pendingCount()
      if (left > 0) throw new Error(`${left} sale(s) still unsynced. Reconnect before closing the day.`)

      let r = await api('/api/eod/process', {
        method: 'POST',
        body: JSON.stringify({
          terminalId, businessDate,
          approverUsername: needsOverride ? approver.username : null,
          approverPassword: needsOverride ? approver.password : null,
          remarks: approver.remarks || null
        })
      })
      // A RawBT-configured terminal has no server-reachable printer — the API can
      // never print it, so the browser prints the text the response already carries,
      // and its own result (not the server's, which is always false here) is shown.
      if (printerTarget?.startsWith('rawbt')) {
        r = { ...r, printed: await printText(r.receiptText, printerTarget) }
      }
      setResult(r)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  const finish = () => {
    if (role === 'Cashier') { clearShift(); clearCart(); logout(); nav('/login') }
    else nav('/admin')
  }

  if (result) return (
    <div className="min-h-screen p-6 overflow-auto">
      <div className="max-w-md mx-auto space-y-4">
        <div className="bg-white rounded-2xl p-6 text-center space-y-2 shadow">
          <svg className="mx-auto text-stone-700" width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <h1 className="text-2xl font-bold">End of Day complete</h1>
          <p className="text-stone-500 text-sm">
            Z# {result.zread.ZCounter} · {result.printed ? 'Printed' : 'Printer unreachable'} ·{' '}
            {result.emailed ? 'Emailed to administration' : 'Email not sent'}
          </p>
        </div>
        <Paper text={result.receiptText} />
        <Btn variant="primary" className="w-full" onClick={finish}>
          {role === 'Cashier' ? 'Sign out' : 'Back to Admin'}
        </Btn>
      </div>
    </div>
  )

  if (!state && !error) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>

  const blocked = state?.dayState === 'eodDone'

  return (
    <div className="min-h-screen p-6 overflow-auto">
      <div className="max-w-md mx-auto space-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">End of Day</div>
          <h1 className="text-2xl font-bold">Close {branchCode} terminal for {businessDate}</h1>
        </div>

        {blocked && (
          <Note tone="stone" title="Already closed">
            This terminal has already been closed for {businessDate}. Reprint the Z-Read from
            Admin → Z-Read / EOD if you need another copy.
          </Note>
        )}

        {state && !blocked && (
          <div className="bg-white rounded-2xl p-5 shadow space-y-3 text-sm">
            <Row label="Open shifts" ok={state.openShifts === 0}
              value={state.openShifts === 0 ? 'none' : `${state.openShifts} still open`} />
            <Row label="Blind-closed shifts" ok value={`${state.closedShifts}`} />
            <Row label="Offline queue synced" ok={queued === 0}
              value={queued === 0 ? '0 pending' : `${queued} pending`} />
            <Row label="Last cashier" value={state.lastCashier || '—'} />
          </div>
        )}

        {state && !blocked && state.openShifts > 0 && (
          <Note tone="red">
            A shift is still open on this terminal. Every shift must be blind-closed before the day
            can be closed.
          </Note>
        )}

        {!blocked && (
          <>
            <div className="bg-white rounded-2xl p-5 shadow space-y-3">
              <h2 className="font-bold">{needsOverride ? 'Supervisor authorization' : 'Close the day'}</h2>
              {needsOverride ? (
                <p className="text-sm text-stone-500">
                  This branch requires a Supervisor or Admin credential to close the day. The approver,
                  timestamp and remarks are written to the audit log and printed on the Z-Read.
                </p>
              ) : (
                <p className="text-sm text-stone-500">
                  {isPrivileged
                    ? 'No separate credential needed — closing under your own account.'
                    : 'This branch does not require a supervisor override to close the day. Change this in Admin → POS Settings if that should be tightened.'}
                </p>
              )}
              {needsOverride && (
                <>
                  <Field label="Supervisor / Admin username">
                    <Input value={approver.username} autoCapitalize="none"
                      onChange={e => setApprover({ ...approver, username: e.target.value })} />
                  </Field>
                  <Field label="Password">
                    <Input type="password" value={approver.password}
                      onChange={e => setApprover({ ...approver, password: e.target.value })} />
                  </Field>
                </>
              )}
              <Field label="Remarks (optional)">
                <Input value={approver.remarks} placeholder="e.g. store closed early"
                  onChange={e => setApprover({ ...approver, remarks: e.target.value })} />
              </Field>
            </div>

            <Note tone="amber" title="This is irreversible">
              Sales for {businessDate} can no longer be added or voided on this terminal, and cashier
              login is blocked until the next business day.
            </Note>
          </>
        )}

        <ErrorBar message={error} onDismiss={() => setError('')} />

        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => nav(role === 'Cashier' ? '/cash-begin' : '/admin')}>Back</Btn>
          {!blocked && (
            <Btn variant="primary"
              disabled={busy || (needsOverride && (!approver.username || !approver.password)) ||
                (state && state.openShifts > 0) || queued > 0}
              onClick={process}>
              {busy ? 'Closing…' : needsOverride ? 'Authorize and close day' : 'Close day'}
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}

const Row = ({ label, value, ok }) => (
  <div className="flex justify-between border-b border-stone-100 pb-2 last:border-0">
    <span>{label}</span>
    <span className={ok === undefined ? 'text-stone-500' : ok ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
      {value}
    </span>
  </div>
)

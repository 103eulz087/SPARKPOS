import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, isOnline, pendingCount, syncPendingSales } from '../lib/api'
import { peso, useAuth, useCart, useShift } from '../lib/store'
import { Btn, ErrorBar, Input, Note } from '../components/Ui'

const DENOMS = ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.25']

export default function BlindClose() {
  const nav = useNavigate()
  const { logout, branchCode } = useAuth()
  const { shiftUid, terminalId, terminalCode, clearShift } = useShift()
  const clearCart = useCart(s => s.clear)

  const [counts, setCounts] = useState({})
  const [queued, setQueued] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('count')   // count → submitted

  useEffect(() => { pendingCount().then(setQueued) }, [])

  const declared = DENOMS.reduce((s, d) => s + Number(d) * (Number(counts[d]) || 0), 0)

  const submit = async () => {
    setBusy(true); setError('')
    try {
      await syncPendingSales()
      const left = await pendingCount()
      if (left > 0) {
        throw new Error(`${left} sale(s) have not reached the server yet. Reconnect and try again — otherwise the expected cash would be wrong.`)
      }
      const denominations = {}
      DENOMS.forEach(d => { const n = Number(counts[d]) || 0; if (n > 0) denominations[d] = n })

      await api('/api/shifts/blind-close', {
        method: 'POST',
        body: JSON.stringify({ shiftUid, denominations })
      })
      setStage('submitted')
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  const signOut = () => { clearShift(); clearCart(); logout(); nav('/login') }

  if (stage === 'submitted') return (
    <div className="min-h-screen p-6 overflow-auto">
      <div className="max-w-md mx-auto space-y-4">
        <div className="bg-white rounded-2xl p-8 text-center space-y-3 shadow">
          <div className="text-4xl">✓</div>
          <h1 className="text-2xl font-bold">Shift closed</h1>
          <p className="text-stone-500 text-sm">
            Your count was submitted and the closing report printed for supervisor verification.
            You were never shown sales totals or short/over.
          </p>
        </div>
        <Note tone="amber" title="Is the store finished for today?">
          If another cashier takes over this terminal, sign out and let them open a new shift.
          If this was the last shift, run End of Day now. Forgetting is recoverable — you can sign
          back in later for End of Day only, or an Admin can close the day remotely.
        </Note>
        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={signOut}>Sign out (EOD later)</Btn>
          <Btn variant="primary" onClick={() => nav(`/end-of-day?terminalId=${terminalId}`)}>
            Run End of Day
          </Btn>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen p-4 overflow-auto">
      <div className="max-w-lg mx-auto space-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">
            Blind Close · {branchCode}/{terminalCode}
          </div>
          <h1 className="text-2xl font-bold">Count your drawer</h1>
          <p className="text-stone-500 text-sm mt-1">
            Enter the exact number of each bill and coin. Sales totals stay hidden — the system
            computes short/over for your supervisor.
          </p>
        </div>

        {queued > 0 && !isOnline() && (
          <Note tone="amber">
            {queued} sale(s) are still queued offline. Reconnect before closing so your count is
            checked against complete data.
          </Note>
        )}

        <div className="bg-white rounded-2xl p-4 shadow grid grid-cols-2 gap-x-6 gap-y-2">
          {DENOMS.map(d => (
            <label key={d} className="flex items-center gap-2">
              <span className="tabnum w-14 text-right font-bold text-sm">₱{d}</span>
              <span className="text-stone-400">×</span>
              <Input className="!min-h-[40px] text-right tabnum !text-sm" inputMode="numeric" placeholder="0"
                value={counts[d] || ''}
                onChange={e => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })} />
            </label>
          ))}
        </div>

        <div className="bg-stone-900 text-white rounded-2xl px-5 py-4 flex justify-between items-baseline">
          <span className="text-[10px] tracking-[0.3em] uppercase text-white/50">Declared cash</span>
          <span className="tabnum text-3xl font-bold">₱{peso(declared)}</span>
        </div>

        <Note tone="stone" title="What stays hidden">
          Card payments are excluded from the drawer count. Expected cash, net sales and short/over
          are computed on the server and returned only to Supervisor and Admin accounts.
        </Note>

        <ErrorBar message={error} onDismiss={() => setError('')} />

        <div className="grid grid-cols-2 gap-3">
          <Btn onClick={() => nav('/pos')}>Back to POS</Btn>
          <Btn variant="primary" disabled={busy || declared <= 0} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit count'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

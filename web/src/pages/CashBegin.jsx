import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { allocateOrRange, api, orRemaining, pullPriceList, pullTables, uuid } from '../lib/api'
import { useAuth, useShift } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Note, Spinner } from '../components/Ui'

export default function CashBegin() {
  const nav = useNavigate()
  const { fullName, role, branchCode, logout } = useAuth()
  const setShift = useShift(s => s.setShift)

  const [terminals, setTerminals] = useState([])
  const [terminalId, setTerminalId] = useState(Number(localStorage.getItem('pos_terminalId')) || null)
  const [state, setState] = useState(null)      // day state for the chosen terminal
  const [cashBegin, setCashBegin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api(`/api/terminals?branchCode=${branchCode}`)
      .then(t => {
        const active = t.filter(x => x.IsActive)
        setTerminals(active)
        // terminalId can be left over in localStorage from a different branch's terminal
        // (pos_terminalId is a single global key, not branch-scoped) — a stale but truthy
        // value from another branch must not survive a branch switch, or Pos.jsx resolves
        // ctx.terminal to {} for the rest of the session (wrong/no printer target, etc.)
        if (!active.some(x => x.TerminalId === terminalId)) {
          setTerminalId(active.length ? active[0].TerminalId : null)
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchCode])

  // Whenever the terminal changes, ask the server what this terminal can do today
  useEffect(() => {
    if (!terminalId) return
    setState(null)
    api(`/api/eod/terminal-state/${terminalId}`)
      .then(setState)
      .catch(e => setError(e.message))
  }, [terminalId])

  const openShift = async () => {
    if (!terminalId || !cashBegin) return
    setBusy(true); setError('')
    try {
      const shiftUid = uuid()
      const now = new Date()
      const businessDate = now.toISOString().slice(0, 10)

      await api('/api/shifts/open', {
        method: 'POST',
        body: JSON.stringify({
          shiftUid, branchCode, terminalId, businessDate,
          cashBegin: Number(cashBegin), openedAt: now.toISOString()
        })
      })

      // Prepare for offline operation
      await pullPriceList(branchCode)
      await pullTables(branchCode)   // no-op list for a non-Restaurant branch
      if (await orRemaining() < 50) await allocateOrRange(terminalId)

      const t = terminals.find(x => x.TerminalId === terminalId)
      setShift({
        shiftUid, terminalId, terminalCode: t?.TerminalCode || '',
        businessDate, cashBegin: Number(cashBegin)
      })
      nav('/pos')
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>

  const canSell = state?.canSell !== false
  const canRunEod = !!state?.canRunEod

  return (
    <div className="min-h-screen p-6 overflow-auto">
      <div className="w-full max-w-md mx-auto space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] tracking-[0.3em] uppercase text-stone-500">Cash Begin · {branchCode}</div>
            <h1 className="text-2xl font-bold">{fullName}</h1>
          </div>
          <button className="text-stone-500 underline text-sm" onClick={() => { logout(); nav('/login') }}>
            Sign out
          </button>
        </div>

        <div className="bg-white rounded-2xl p-6 space-y-5 shadow">
          <Field label="Terminal">
            <div className="grid grid-cols-2 gap-3">
              {terminals.map(t => (
                <Btn key={t.TerminalId} variant={terminalId === t.TerminalId ? 'moss' : 'ghost'}
                  onClick={() => setTerminalId(t.TerminalId)}>{t.TerminalCode}</Btn>
              ))}
            </div>
          </Field>

          {state && !canSell && (
            <Note tone="stone" title="Terminal closed for the day">
              End of Day has already been processed on this terminal. Selling reopens on the next
              business day. Choose another terminal or sign out.
            </Note>
          )}

          {state && canRunEod && (
            <Note tone="amber" title="End of Day is still pending">
              All shifts on this terminal are blind-closed but today was never closed
              {state.lastCashier ? ` (last cashier: ${state.lastCashier})` : ''}.
              You can close it now — a supervisor credential is required.
            </Note>
          )}

          {canSell && (
            <Field label="Change fund (₱)">
              <Input className="text-right text-2xl tabnum" inputMode="decimal" placeholder="0.00"
                value={cashBegin} onChange={e => setCashBegin(e.target.value.replace(/[^0-9.]/g, ''))} />
            </Field>
          )}

          <ErrorBar message={error} onDismiss={() => setError('')} />

          {canSell && (
            <Btn variant="primary" className="w-full text-lg" disabled={busy || !terminalId || !cashBegin}
              onClick={openShift}>
              {busy ? 'Opening shift…' : 'Open shift'}
            </Btn>
          )}

          {canRunEod && (
            <Btn variant="dark" className="w-full"
              onClick={() => nav(`/end-of-day?terminalId=${terminalId}`)}>
              Run End of Day for this terminal
            </Btn>
          )}

          {(role === 'Admin' || role === 'Supervisor') && (
            <Btn className="w-full" onClick={() => nav('/admin')}>Go to Admin console</Btn>
          )}
        </div>

        {canSell && (
          <Note tone="green">
            Opening a shift downloads this branch's price list and reserves a block of OR numbers,
            so the tablet keeps selling if the network drops.
          </Note>
        )}
      </div>
    </div>
  )
}

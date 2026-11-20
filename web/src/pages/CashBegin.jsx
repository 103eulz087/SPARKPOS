import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { allocateOrRange, api, getMeta, pendingCount, pullPriceList, pullTables, setDeviceToken, uuid } from '../lib/api'
import { localDate, useAuth, useShift } from '../lib/store'
import { Btn, ErrorBar, Field, Input, Note, Select, Spinner, Wordmark } from '../components/Ui'

/** What Admin's terminal list shows for this device, e.g. "Windows · Chrome". */
const deviceLabel = () => {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${os} · ${browser}`
}

export default function CashBegin() {
  const nav = useNavigate()
  const { fullName, role, branchCode, logout, userId } = useAuth()
  const setShift = useShift(s => s.setShift)

  const [terminals, setTerminals] = useState([])   // the ones this device may use
  const [allTerminals, setAllTerminals] = useState([])
  const [assigned, setAssigned] = useState(null)    // the terminal assigned to this device
  const [assign, setAssign] = useState(null)        // the "Assign this device" form, when open
  const [reload, setReload] = useState(0)
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
        // A device assigned to a terminal sees only that one; a terminal assigned to another
        // device is hidden (the server also refuses its shift from here). Unassigned terminals
        // stay open to any device, as before device assignment existed.
        const mine = active.find(x => x.DeviceIsThis)
        const usable = mine ? [mine] : active.filter(x => !x.DeviceAssigned)
        setAllTerminals(active)
        setAssigned(mine || null)
        setTerminals(usable)
        // terminalId can be left over in localStorage from a different branch's terminal
        // (pos_terminalId is a single global key, not branch-scoped) — a stale but truthy
        // value from another branch must not survive a branch switch, or Pos.jsx resolves
        // ctx.terminal to {} for the rest of the session (wrong/no printer target, etc.)
        if (mine) setTerminalId(mine.TerminalId)
        else if (!usable.some(x => x.TerminalId === terminalId)) {
          setTerminalId(usable.length ? usable[0].TerminalId : null)
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchCode, reload])

  const isPrivileged = role === 'Admin' || role === 'Supervisor'
  // A server without device assignment (migration 27) sends no DeviceAssigned field
  const canAssign = allTerminals.some(x => 'DeviceAssigned' in x)

  const assignDevice = async () => {
    if (!assign?.terminalId) return
    setBusy(true); setError('')
    try {
      const r = await api(`/api/terminals/${assign.terminalId}/assign-device`, {
        method: 'POST',
        body: JSON.stringify({ approverUsername: assign.username || null, approverPassword: assign.password || null, deviceLabel: deviceLabel() })
      })
      setDeviceToken(r.deviceToken)
      localStorage.setItem('pos_terminalId', String(r.terminalId))
      setAssign(null); setTerminalId(r.terminalId); setReload(n => n + 1)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  // Whenever the terminal changes, ask the server what this terminal can do today
  useEffect(() => {
    if (!terminalId) return
    setState(null)
    api(`/api/eod/terminal-state/${terminalId}?businessDate=${localDate()}`)
      .then(setState)
      .catch(e => setError(e.message))
  }, [terminalId])

  const openShift = async () => {
    if (!terminalId || !cashBegin) return
    setBusy(true); setError('')
    try {
      const shiftUid = uuid()
      const now = new Date()
      const businessDate = localDate(now)

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
      // Always re-reserve: Sales Invoice numbers continue from this terminal's last one used,
      // so whatever was left of an earlier block never becomes a gap (BIR: non-resettable).
      const unsynced = await pendingCount()
      await allocateOrRange(terminalId, 500, unsynced > 0 ? await getMeta('or_next') : null)

      const t = terminals.find(x => x.TerminalId === terminalId)
      setShift({
        shiftUid, terminalId, terminalCode: t?.TerminalCode || '',
        businessDate, cashBegin: Number(cashBegin), cashierUserId: userId
      })
      nav('/pos')
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>

  const canSell = !!terminalId && state?.canSell !== false
  const canRunEod = !!state?.canRunEod
  // An earlier business day this terminal never closed: it is closed first, then a new day starts.
  const unclosed = state?.unclosedDay || null
  const myOpenShift = unclosed?.openShiftUid && unclosed.cashierUserId === userId
  const longDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

  // The cashier's own shift from that day: pick it back up, straight to Blind Close.
  const closeMyShift = () => {
    const t = terminals.find(x => x.TerminalId === terminalId)
    setShift({
      shiftUid: unclosed.openShiftUid, terminalId, terminalCode: t?.TerminalCode || '',
      businessDate: unclosed.businessDate, cashBegin: Number(unclosed.cashBegin), cashierUserId: userId
    })
    nav('/blind-close')
  }

  return (
    <div className="min-h-screen p-6 overflow-auto">
      <div className="w-full max-w-md mx-auto space-y-5">
        <Wordmark className="text-xl" />
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] tracking-[0.3em] uppercase text-muted">Cash Begin · {branchCode}</div>
            <h1 className="font-display text-2xl font-bold">{fullName}</h1>
          </div>
          <button className="text-muted underline text-sm" onClick={() => { logout(); nav('/login') }}>
            Sign out
          </button>
        </div>

        <div className="bg-panel rounded-3xl p-6 space-y-5 border border-line">
          <Field label="Terminal">
            <div className="grid grid-cols-2 gap-3">
              {terminals.map(t => (
                <Btn key={t.TerminalId} variant={terminalId === t.TerminalId ? 'moss' : 'ghost'}
                  onClick={() => setTerminalId(t.TerminalId)}>{t.TerminalCode}</Btn>
              ))}
            </div>
            {assigned && <div className="text-xs text-muted mt-2">Assigned to this device.</div>}
          </Field>

          {!error && terminals.length === 0 && allTerminals.length > 0 && !assign && (
            <Note tone="amber" title="Every terminal here is assigned to its own device">
              Sign in on your own POS. To use this device instead, a supervisor assigns it below.
            </Note>
          )}

          {canAssign && !assign && (!assigned || isPrivileged) && (
            <button className="text-sm underline text-muted"
              onClick={() => setAssign({ terminalId: assigned?.TerminalId || terminals[0]?.TerminalId || allTerminals[0]?.TerminalId || null, username: '', password: '' })}>
              {assigned ? 'Assign this device to a different terminal' : 'Assign this device to a terminal'}
            </button>
          )}

          {assign && (
            <div className="rounded-2xl border border-line p-4 space-y-3">
              <div className="font-semibold">Assign this device</div>
              <p className="text-sm text-muted">
                Done once per PC or handheld. From then on, Cash Begin here shows only that terminal,
                and no other device can open a shift on it.
              </p>
              <Field label="This device is">
                <Select className="w-full" value={assign.terminalId || ''}
                  onChange={e => setAssign({ ...assign, terminalId: Number(e.target.value) })}>
                  {allTerminals.map(t => (
                    <option key={t.TerminalId} value={t.TerminalId}>
                      {t.TerminalCode}{t.DeviceIsThis ? ' (this device)' : t.DeviceAssigned ? ' (moves here from its current device)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              {!isPrivileged && (
                <>
                  <Field label="Supervisor user ID">
                    <Input value={assign.username} autoComplete="off"
                      onChange={e => setAssign({ ...assign, username: e.target.value })} />
                  </Field>
                  <Field label="Supervisor password">
                    <Input type="password" value={assign.password} autoComplete="new-password"
                      onChange={e => setAssign({ ...assign, password: e.target.value })} />
                  </Field>
                </>
              )}
              <div className="flex gap-3">
                <Btn variant="primary" className="flex-1" disabled={busy || !assign.terminalId || (!isPrivileged && (!assign.username || !assign.password))}
                  onClick={assignDevice}>{busy ? 'Assigning…' : 'Assign this device'}</Btn>
                <Btn onClick={() => setAssign(null)}>Cancel</Btn>
              </div>
            </div>
          )}

          {!loading && !error && allTerminals.length === 0 && (
            <Note tone="amber" title={`No terminal set up for branch ${branchCode}`}>
              A shift opens on a terminal, and this branch has none yet. Ask head office to add
              one in Admin → Terminals, then sign in again.
            </Note>
          )}

          {unclosed && (
            <Note tone="amber" title={`${longDate(unclosed.businessDate)} was never closed`}>
              {unclosed.openShiftUid
                ? myOpenShift
                  ? 'Your shift from that day is still open on this terminal. Blind-close it, then run that day\'s End of Day. A new shift can start after that.'
                  : `${unclosed.cashier || 'A cashier'}'s shift from that day is still open on this terminal. They sign in and blind-close it, or a supervisor force-closes it in Admin → Open shifts. Then run that day's End of Day.`
                : 'Its shifts are blind-closed but its End of Day was never run. Run it now (a supervisor credential may be asked for). A new shift can start after that.'}
            </Note>
          )}

          {unclosed && myOpenShift && (
            <Btn variant="primary" className="w-full" onClick={closeMyShift}>
              Blind-close my shift of {longDate(unclosed.businessDate)}
            </Btn>
          )}

          {unclosed && !unclosed.openShiftUid && (
            <Btn variant="primary" className="w-full"
              onClick={() => nav(`/end-of-day?terminalId=${terminalId}&businessDate=${unclosed.businessDate}`)}>
              Run End of Day for {longDate(unclosed.businessDate)}
            </Btn>
          )}

          {state?.dayState === 'eodDone' && (
            <Note tone="stone" title="Terminal closed for the day">
              End of Day has already been processed on this terminal. Selling reopens on the next
              business day. Choose another terminal or sign out.
            </Note>
          )}

          {state && canRunEod && !unclosed && (
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

          {canRunEod && !unclosed && (
            <Btn variant="dark" className="w-full"
              onClick={() => nav(`/end-of-day?terminalId=${terminalId}&businessDate=${localDate()}`)}>
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

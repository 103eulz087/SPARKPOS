import React, { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { startSyncLoop } from './lib/api'
import { useAuth, useCart, useShift } from './lib/store'
import { applyUpdate, usePwa } from './lib/pwa'
import Login from './pages/Login'
import CashBegin from './pages/CashBegin'
import Pos from './pages/Pos'
import BlindClose from './pages/BlindClose'
import EndOfDay from './pages/EndOfDay'
import Admin from './pages/Admin'

/** allowOffline: an offline sign-in (lib/offlineAuth.js) has no token, only the user, and may
 *  only use the POS screen to keep selling in its own open shift. */
function RequireAuth({ children, allowOffline = false }) {
  const token = useAuth(s => s.token)
  const userId = useAuth(s => s.userId)
  return token || (allowOffline && userId) ? children : <Navigate to="/login" replace />
}
function RequireShift({ children }) {
  const shiftUid = useShift(s => s.shiftUid)
  return shiftUid ? children : <Navigate to="/cash-begin" replace />
}

/** "New version" bar. Hidden while a sale is in the cart (the cart lives in memory, so a reload
 *  would drop it); "Later" hides it for an hour. */
function UpdateBar() {
  const needRefresh = usePwa(s => s.needRefresh)
  const cartBusy = useCart(s => s.lines.length > 0)
  const [laterUntil, setLaterUntil] = useState(0)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!laterUntil) return
    const t = setTimeout(() => tick(n => n + 1), Math.max(0, laterUntil - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [laterUntil])
  if (!needRefresh || cartBusy || Date.now() < laterUntil) return null
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md bg-raised border border-line2 text-fg rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3 text-sm" role="status">
      <span className="flex-1">A new version of SparkPOS is ready.</span>
      <button className="text-muted font-semibold px-2 py-2" onClick={() => setLaterUntil(Date.now() + 60 * 60 * 1000)}>Later</button>
      <button className="bg-accent text-ink font-semibold rounded-lg px-4 py-2" onClick={applyUpdate}>Update now</button>
    </div>
  )
}

export default function App() {
  const token = useAuth(s => s.token)
  useEffect(() => { if (token) return startSyncLoop() }, [token])

  return (
    <>
    <UpdateBar />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/cash-begin" element={<RequireAuth><CashBegin /></RequireAuth>} />
      <Route path="/pos" element={<RequireAuth allowOffline><RequireShift><Pos /></RequireShift></RequireAuth>} />
      <Route path="/blind-close" element={<RequireAuth><RequireShift><BlindClose /></RequireShift></RequireAuth>} />
      <Route path="/end-of-day" element={<RequireAuth><EndOfDay /></RequireAuth>} />
      <Route path="/admin/*" element={<RequireAuth><Admin /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
    </>
  )
}

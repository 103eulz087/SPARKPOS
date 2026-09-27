import React, { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { startSyncLoop } from './lib/api'
import { useAuth, useShift } from './lib/store'
import Login from './pages/Login'
import CashBegin from './pages/CashBegin'
import Pos from './pages/Pos'
import BlindClose from './pages/BlindClose'
import EndOfDay from './pages/EndOfDay'
import Admin from './pages/Admin'

function RequireAuth({ children }) {
  const token = useAuth(s => s.token)
  return token ? children : <Navigate to="/login" replace />
}
function RequireShift({ children }) {
  const shiftUid = useShift(s => s.shiftUid)
  return shiftUid ? children : <Navigate to="/cash-begin" replace />
}

export default function App() {
  const token = useAuth(s => s.token)
  useEffect(() => { if (token) return startSyncLoop() }, [token])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/cash-begin" element={<RequireAuth><CashBegin /></RequireAuth>} />
      <Route path="/pos" element={<RequireAuth><RequireShift><Pos /></RequireShift></RequireAuth>} />
      <Route path="/blind-close" element={<RequireAuth><RequireShift><BlindClose /></RequireShift></RequireAuth>} />
      <Route path="/end-of-day" element={<RequireAuth><EndOfDay /></RequireAuth>} />
      <Route path="/admin/*" element={<RequireAuth><Admin /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

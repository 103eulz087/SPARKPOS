import { create } from 'zustand'
import { registerSW } from 'virtual:pwa-register'

/* Service worker (vite.config.js, VitePWA): the app's files are kept on the device so SparkPOS opens
   offline. A new version installs in the background and then waits; UpdateBar (App.jsx) offers it,
   and only reloads when the user taps it. A long-open till checks for one every 30 minutes and
   whenever the connection comes back. */
export const usePwa = create(() => ({ needRefresh: false, offlineReady: false }))

let updateSW = null

export function startPwa() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  updateSW = registerSW({
    onNeedRefresh: () => usePwa.setState({ needRefresh: true }),
    onOfflineReady: () => usePwa.setState({ offlineReady: true }),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return
      const check = () => { if (navigator.onLine) reg.update().catch(() => {}) }
      setInterval(check, 30 * 60 * 1000)
      window.addEventListener('online', check)
    }
  })
}

/** Activates the waiting version and reloads the page. */
export function applyUpdate() {
  if (updateSW) updateSW(true)
  else window.location.reload()
}

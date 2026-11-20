import React, { useState } from 'react'
import { createPortal } from 'react-dom'

/* "Night counter" theme — colors are the semantic names in tailwind.config.js. */

export const Btn = ({ variant = 'ghost', className = '', ...p }) => {
  const base = 'select-none rounded-xl font-semibold min-h-[46px] px-4 transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  const v = {
    primary: 'bg-accent text-ink hover:bg-accent-hover',                       // the main action (Sign in, PAY)
    dark: 'bg-raised border border-line2 text-fg hover:bg-hover',              // strong secondary
    moss: 'bg-accent/15 border border-accent text-accent-fg',                  // selected / applied
    ghost: 'bg-panel border border-line2 text-fg hover:bg-raised',             // plain
    danger: 'bg-danger text-white hover:bg-red-700',
    brand: 'bg-brand text-white hover:bg-[#0A52A3]'
  }[variant]
  return <button className={`${base} ${v} ${className}`} {...p} />
}

const field = 'rounded-xl border border-line2 bg-ink text-fg focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent'

export const Input = React.forwardRef(({ className = '', ...p }, ref) => (
  <input ref={ref} className={`${field} px-3 min-h-[46px] text-base w-full ${className}`} {...p} />
))
Input.displayName = 'Input'

export const Textarea = ({ className = '', ...p }) => (
  <textarea className={`${field} px-3 py-2 text-base w-full font-mono ${className}`} {...p} />
)

export const Select = ({ className = '', ...p }) => (
  <select className={`${field} px-3 min-h-[46px] text-base ${className}`} {...p} />
)

export const Field = ({ label, children }) => (
  <label className="block">
    <span className="block text-xs font-semibold text-fg2 mb-1.5">{label}</span>
    {children}
  </label>
)

// Rendered into <body>: a fixed overlay inside a blurred (glass) card would be pinned to that
// card instead of the screen. It closes only when the press AND the release are on the backdrop:
// selecting text in a field and letting go past the dialog's edge fires a click on the backdrop,
// which closed the dialog mid-entry (the discount screen's quantities, 2026-11-19).
let downOnBackdrop = false
export const Modal = ({ children, onClose, wide }) => createPortal(
  <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[60] overflow-auto"
    onMouseDown={e => { downOnBackdrop = e.target === e.currentTarget }}
    onClick={e => { if (downOnBackdrop && e.target === e.currentTarget) onClose?.(); downOnBackdrop = false }}>
    <div className={`bg-panel border border-line rounded-2xl p-5 sm:p-6 w-full space-y-4 my-auto shadow-2xl ${wide ? 'max-w-2xl' : 'max-w-sm'}`}
      onClick={e => e.stopPropagation()}>
      {children}
    </div>
  </div>,
  document.body
)

export const Note = ({ tone = 'stone', title, children }) => {
  const t = {
    stone: 'bg-raised border-line text-fg2',
    amber: 'bg-warn/10 border-warn/40 text-warn-fg',
    green: 'bg-accent/10 border-accent/40 text-accent-fg',
    red: 'bg-danger/10 border-danger/40 text-danger-fg'
  }[tone]
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${t}`}>
      {title && <strong className="block mb-1">{title}</strong>}
      {children}
    </div>
  )
}

export const Table = ({ head, rows, empty = 'No data for this range.' }) => (
  <div className="bg-panel border border-line rounded-xl overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-muted border-b border-line bg-raised/50">
          {head.map(h => <th key={h} className="px-3 py-2.5 whitespace-nowrap font-semibold text-xs uppercase tracking-wide">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line last:border-0 hover:bg-raised/60">
            {r.map((c, j) => <td key={j} className="px-3 py-2 whitespace-nowrap tabnum">{c}</td>)}
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={head.length} className="px-3 py-8 text-muted">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
)

/** Simulated thermal paper for on-screen preview of a printed report — stays white, like paper. */
export const Paper = ({ text }) => (
  <div className="bg-white text-stone-900 rounded-sm mx-auto max-w-[330px] p-4 font-mono text-[10.5px] leading-[1.45] whitespace-pre overflow-x-auto shadow-lg">
    {text}
  </div>
)

export const Spinner = ({ label = 'Loading…' }) => (
  <div className="flex items-center gap-3 text-muted p-6">
    <div className="w-4 h-4 rounded-full border-2 border-line2 border-t-accent animate-spin" />
    {label}
  </div>
)

export const ErrorBar = ({ message, onDismiss }) =>
  message ? (
    <div className="bg-danger/10 border border-danger/40 text-danger-fg rounded-xl px-4 py-3 text-sm flex items-start gap-3" role="alert">
      <span className="flex-1">{message}</span>
      {onDismiss && <button type="button" className="font-bold" onClick={onDismiss} aria-label="Dismiss">×</button>}
    </div>
  ) : null

export const Toast = ({ message }) =>
  message ? (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-fg text-ink font-medium px-5 py-3 rounded-xl shadow-2xl tabnum text-sm z-[70]" role="status">
      {message}
    </div>
  ) : null

/** "SparkPOS" in the logo's two-tone style. */
export const Wordmark = ({ className = '', suffix }) => (
  <span className={`font-display font-extrabold tracking-tight ${className}`}>
    Spark<span className="text-accent">POS</span>
    {suffix && <span className="ml-2 font-sans font-semibold text-muted text-[0.7em] tracking-normal">{suffix}</span>}
  </span>
)

/** Connected / offline pill with an optional count of items still waiting to sync. */
export const StatusPill = ({ online, queued = 0, className = '' }) => (
  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tabnum ${
    online ? 'border-line text-fg2' : 'border-danger/50 bg-danger/10 text-danger-fg'} ${className}`}>
    <span className={`w-2 h-2 rounded-full ${online ? 'bg-accent' : 'bg-danger'}`} />
    {online ? 'Online' : 'Offline'}
    {queued > 0 && <span className="text-warn-fg">· {queued} to send</span>}
  </span>
)

/** Decorative isometric cube outline (the logo's shape), for empty space. */
export const Cube = ({ size = 120, className = '', stroke = 'currentColor' }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="-60 -62 120 124" className={className}
    fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round">
    <polygon points="0,-60 52,-30 0,0 -52,-30" />
    <polyline points="-52,-30 -52,30 0,60 52,30 52,-30" />
    <line x1="0" y1="0" x2="0" y2="60" />
  </svg>
)

/* Placeholder tints for products with no photo: a dark tile and a light label per hue,
   picked from the category so a category's items share a color. */
const TINTS = [
  ['#16324F', '#8EC5FF'], ['#1F3A22', '#9FD98A'], ['#3A2A14', '#F2C27A'], ['#3A1E2A', '#F5A3C0'],
  ['#2A2245', '#C3B2FF'], ['#13383A', '#83E0DA'], ['#3B2418', '#F7AF8B'], ['#2C3315', '#D3E27E']
]
const initials = (name = '') => {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?'
}

/** A product's photo, or — when it has none or it fails to load (e.g. offline) — a tinted tile
 *  with the product's initials and the cube mark, so the grid never looks empty. Fills its parent. */
export function ProductThumb({ name, categoryId, imageUrl, small = false }) {
  const [broken, setBroken] = useState(false)
  if (imageUrl && !broken)
    return <img src={imageUrl} alt="" onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" />
  const [bg, fg] = TINTS[Math.abs(Number(categoryId) || 0) % TINTS.length]
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden" style={{ background: bg, color: fg }}>
      {!small && <Cube size={84} className="absolute -right-4 -bottom-5 opacity-25" />}
      <span className={`font-display font-extrabold tracking-tight ${small ? 'text-xs' : 'text-2xl sm:text-3xl'}`}>{initials(name)}</span>
    </div>
  )
}

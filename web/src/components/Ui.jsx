import React from 'react'

export const Btn = ({ variant = 'ghost', className = '', ...p }) => {
  const base = 'select-none rounded-lg font-semibold min-h-[46px] px-4 transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100'
  const v = {
    primary: 'bg-red-700 text-white active:bg-red-800',
    dark: 'bg-stone-900 text-white',
    moss: 'bg-emerald-800 text-white',
    ghost: 'bg-white border border-stone-300 text-stone-900'
  }[variant]
  return <button className={`${base} ${v} ${className}`} {...p} />
}

export const Input = React.forwardRef(({ className = '', ...p }, ref) => (
  <input ref={ref}
    className={`rounded-lg border border-stone-300 bg-white px-3 min-h-[46px] text-base w-full focus:outline-none focus:ring-2 focus:ring-emerald-700 ${className}`}
    {...p} />
))
Input.displayName = 'Input'

export const Textarea = ({ className = '', ...p }) => (
  <textarea
    className={`rounded-lg border border-stone-300 bg-white px-3 py-2 text-base w-full font-mono focus:outline-none focus:ring-2 focus:ring-emerald-700 ${className}`}
    {...p} />
)

export const Select = ({ className = '', ...p }) => (
  <select className={`rounded-lg border border-stone-300 bg-white px-3 min-h-[46px] text-base ${className}`} {...p} />
)

export const Field = ({ label, children }) => (
  <label className="block">
    <span className="block text-xs font-semibold text-stone-500 mb-1">{label}</span>
    {children}
  </label>
)

export const Modal = ({ children, onClose, wide }) => (
  <div className="fixed inset-0 bg-stone-900/60 flex items-center justify-center p-4 z-40 overflow-auto" onClick={onClose}>
    <div className={`bg-white rounded-2xl p-6 w-full space-y-4 my-auto ${wide ? 'max-w-2xl' : 'max-w-sm'}`}
      onClick={e => e.stopPropagation()}>
      {children}
    </div>
  </div>
)

export const Note = ({ tone = 'stone', title, children }) => {
  const t = {
    stone: 'bg-stone-100 border-stone-300 text-stone-600',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    red: 'bg-red-50 border-red-200 text-red-800'
  }[tone]
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${t}`}>
      {title && <strong className="block mb-1">{title}</strong>}
      {children}
    </div>
  )
}

export const Table = ({ head, rows, empty = 'No data for this range.' }) => (
  <div className="bg-white rounded-xl shadow overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-stone-500 border-b border-stone-200">
          {head.map(h => <th key={h} className="px-3 py-2 whitespace-nowrap font-semibold">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-stone-100">
            {r.map((c, j) => <td key={j} className="px-3 py-2 whitespace-nowrap tabnum">{c}</td>)}
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={head.length} className="px-3 py-8 text-stone-400">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
)

/** Simulated thermal paper for on-screen preview of a printed report. */
export const Paper = ({ text }) => (
  <div className="bg-white border border-stone-200 shadow-inner mx-auto max-w-[330px] p-4 font-mono text-[10.5px] leading-[1.45] whitespace-pre overflow-x-auto">
    {text}
  </div>
)

export const Spinner = ({ label = 'Loading…' }) => (
  <div className="flex items-center gap-3 text-stone-500 p-6">
    <div className="w-4 h-4 rounded-full border-2 border-stone-300 border-t-stone-600 animate-spin" />
    {label}
  </div>
)

export const ErrorBar = ({ message, onDismiss }) =>
  message ? (
    <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-sm flex items-start gap-3">
      <span className="flex-1">{message}</span>
      {onDismiss && <button className="font-bold" onClick={onDismiss}>×</button>}
    </div>
  ) : null

export const Toast = ({ message }) =>
  message ? (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-stone-900 text-white px-5 py-3 rounded-xl shadow-xl tabnum text-sm z-50">
      {message}
    </div>
  ) : null

import React, { useEffect, useState } from 'react'
import { Cube, Wordmark } from './Ui'

/* Admin console shell: a side panel of grouped sections, a slim top bar, and the page in a
   glass-card area. On a phone or small tablet (< lg) the panel is a drawer behind a
   hamburger; on a desktop it can shrink to an icon rail (remembered per browser). */

// Inline SVG paths, 24×24 stroke icons (the handheld's font can't be trusted with symbols).
const ICON = {
  Dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  Closings: 'M3 7h18v12H3zM3 11h18M7 15h3',
  'Z-Read / EOD': 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  Reports: 'M4 20V11M10 20V5M16 20v-6M21 20H3',
  Products: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10',
  'Price Lists': 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
  Categories: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  Discounts: 'M19 5L5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  Wholesale: 'M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8',
  Promos: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
  'Suki Cards': 'M2 6h20v12H2zM2 10h20M6 15h4',
  'Gift Certificates': 'M3 8h18v12H3zM3 12h18M12 8v12M12 8c-1.5-3-5-4-5-1.5S10 8 12 8zM12 8c1.5-3 5-4 5-1.5S14 8 12 8z',
  Users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  Branches: 'M3 9l1.5-5h15L21 9M3 9h18v11H3zM9 20v-6h6v6',
  Terminals: 'M3 4h18v12H3zM8 20h8M12 16v4',
  Tables: 'M3 9h18M5 9v11M19 9v11M8 5h8',
  'Print Areas': 'M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z',
  'POS Settings': 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  Email: 'M3 5h18v14H3zM3 5l9 7 9-7',
  Accounting: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM4 17a3 3 0 0 1 3-3h11',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  collapse: 'M11 17l-5-5 5-5M18 17l-5-5 5-5',
  expand: 'M13 17l5-5-5-5M6 17l5-5-5-5',
  pos: 'M3 3h2l2.5 12h11L21 7H6.2M9 20h.01M18 20h.01',
  signout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11'
}

export const NAV = [
  { group: 'Overview', items: ['Dashboard'] },
  { group: 'Sales', items: ['Closings', 'Z-Read / EOD', 'Reports'] },
  { group: 'Catalog', items: ['Products', 'Price Lists', 'Wholesale', 'Promos', 'Categories', 'Discounts'] },
  { group: 'People', items: ['Users', 'Suki Cards', 'Gift Certificates'] },
  { group: 'Store setup', items: ['Branches', 'Terminals', 'Tables', 'Print Areas', 'POS Settings', 'Email'] },
  { group: 'Finance', items: ['Accounting'] }
]
export const groupOf = (t) => NAV.find(g => g.items.includes(t))?.group || ''

export const Icon = ({ name, className = 'w-5 h-5' }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[name]} /></svg>
)

const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private window: not remembered */ } }
}
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'

export default function AdminLayout({ tab, onTab, visible, user, branchSelect, actions, onOpenPos, onSignOut, children }) {
  const [rail, setRail] = useState(() => store.get('admin_rail') === '1')   // desktop: icons only
  const [drawer, setDrawer] = useState(false)                                // phone: panel open

  useEffect(() => { store.set('admin_rail', rail ? '1' : '0') }, [rail])
  useEffect(() => {
    if (!drawer) return
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const pick = (t) => { onTab(t); setDrawer(false); window.scrollTo({ top: 0 }) }
  const narrow = rail && !drawer   // the drawer always shows the full panel

  const panel = (
    <aside aria-label="Admin sections"
      className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/[0.06] bg-deep/80 backdrop-blur-xl
        shadow-[4px_0_24px_-8px_rgba(0,0,0,0.6)] transition-[transform,width] duration-200
        ${drawer ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 w-72 ${rail ? 'lg:w-[76px]' : 'lg:w-64'}`}>
      <div className={`h-16 flex items-center shrink-0 border-b border-white/[0.06] ${narrow ? 'lg:justify-center lg:px-0' : ''} px-5`}>
        {narrow
          ? <><span className="hidden lg:block font-display font-extrabold text-lg">S<span className="text-accent">P</span></span>
              <Wordmark className="text-xl lg:hidden" suffix="Admin" /></>
          : <Wordmark className="text-xl" suffix="Admin" />}
        <button className="ml-auto lg:hidden p-2 -mr-2 rounded-lg text-muted hover:text-fg hover:bg-white/5"
          onClick={() => setDrawer(false)} aria-label="Close menu"><Icon name="close" /></button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-4">
        {NAV.map((g, gi) => {
          const items = g.items.filter(t => visible.includes(t))
          if (!items.length) return null
          return (
            <div key={g.group}>
              <div className={`px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-subtle ${narrow ? 'lg:hidden' : ''}`}>{g.group}</div>
              {narrow && gi > 0 && <div className="hidden lg:block mx-3 mb-2 border-t border-white/[0.06]" />}
              <ul className="space-y-0.5">
                {items.map(t => {
                  const on = t === tab
                  return (
                    <li key={t}>
                      <button onClick={() => pick(t)} title={narrow ? t : undefined} aria-current={on ? 'page' : undefined}
                        className={`group relative w-full flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition
                          ${narrow ? 'lg:justify-center lg:px-0' : ''}
                          ${on ? 'bg-accent/[0.12] text-fg' : 'text-fg2/80 hover:bg-white/[0.05] hover:text-fg'}`}>
                        {on && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />}
                        <Icon name={t} className={`w-[18px] h-[18px] ${on ? 'text-accent-fg' : 'text-muted group-hover:text-fg2'}`} />
                        <span className={`truncate ${narrow ? 'lg:hidden' : ''}`}>{t}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>

      <div className="shrink-0 border-t border-white/[0.06] p-3 space-y-1">
        <div className={`flex items-center gap-3 px-2 py-2 ${narrow ? 'lg:justify-center lg:px-0' : ''}`} title={narrow ? `${user.name} · ${user.role}` : undefined}>
          <span className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-br from-brand to-accent text-ink font-bold text-xs flex items-center justify-center">
            {initials(user.name)}
          </span>
          <span className={`min-w-0 leading-tight ${narrow ? 'lg:hidden' : ''}`}>
            <span className="block text-sm font-semibold truncate">{user.name}</span>
            <span className="block text-xs text-muted">{user.role}</span>
          </span>
        </div>
        <SideAction icon="pos" label="Open POS" narrow={narrow} onClick={onOpenPos} />
        <SideAction icon="signout" label="Sign out" narrow={narrow} onClick={onSignOut} />
        <button onClick={() => setRail(r => !r)} aria-label={rail ? 'Expand the side panel' : 'Shrink the side panel'}
          className={`hidden lg:flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-muted hover:text-fg hover:bg-white/[0.05] ${narrow ? 'justify-center px-0' : ''}`}>
          <Icon name={rail ? 'expand' : 'collapse'} className="w-4 h-4" />
          {!narrow && 'Shrink panel'}
        </button>
      </div>
    </aside>
  )

  return (
    <div className="admin-glass relative min-h-screen">
      {/* the glow behind the glass */}
      <div aria-hidden="true" className="fixed inset-0 -z-10 overflow-hidden bg-ink">
        <div className="absolute -top-40 -left-32 w-[560px] h-[560px] rounded-full bg-brand/25 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 w-[520px] h-[520px] rounded-full bg-accent/[0.12] blur-[130px]" />
        <div className="absolute -bottom-48 left-1/3 w-[480px] h-[480px] rounded-full bg-brand/[0.15] blur-[120px]" />
        <Cube size={420} className="absolute -right-24 -bottom-24 text-white/[0.03]" />
      </div>

      {panel}
      {drawer && <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setDrawer(false)} />}

      <div className={`transition-[padding] duration-200 ${rail ? 'lg:pl-[76px]' : 'lg:pl-64'}`}>
        <header className="sticky top-0 z-30 h-16 flex items-center gap-3 px-3 sm:px-6 border-b border-white/[0.06] bg-ink/60 backdrop-blur-xl">
          <button className="lg:hidden p-2 -ml-1 rounded-lg text-fg2 hover:text-fg hover:bg-white/5" onClick={() => setDrawer(true)}
            aria-label="Open menu" aria-expanded={drawer}><Icon name="menu" className="w-6 h-6" /></button>
          <div className="min-w-0">
            <div className="hidden sm:block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">{groupOf(tab)}</div>
            <h1 className="font-display font-bold text-lg sm:text-xl leading-tight truncate">{tab}</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {branchSelect}
            {actions}
          </div>
        </header>
        <main className="p-3 sm:p-6 max-w-[1600px]">{children}</main>
      </div>
    </div>
  )
}

const SideAction = ({ icon, label, narrow, onClick }) => (
  <button onClick={onClick} title={narrow ? label : undefined}
    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium text-fg2/80 hover:bg-white/[0.05] hover:text-fg transition ${narrow ? 'lg:justify-center lg:px-0' : ''}`}>
    <Icon name={icon} className="w-[18px] h-[18px] text-muted" />
    <span className={narrow ? 'lg:hidden' : ''}>{label}</span>
  </button>
)

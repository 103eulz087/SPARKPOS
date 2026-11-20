#!/usr/bin/env node
// Creates, shows or hides the recording terminal, so it only appears in the branch's Cash Begin
// list while a recording runs. It never posts to the ERP and prints to "console" under its own
// print agent key, so nothing reaches a store's real printer.
//   node demo-terminal.mjs [--base URL] [--branch 023] [--code POS-DEMO] create|on|off|status
// Signs in with GUIDE_ADMIN_USER / GUIDE_ADMIN_PASSWORD (an Admin).
const argv = process.argv.slice(2)
const opt = { base: 'http://localhost:5092', branch: '023', code: 'POS-DEMO', key: 'demo-capture' }
let action = 'status'
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') opt.base = argv[++i].replace(/\/$/, '')
  else if (argv[i] === '--branch') opt.branch = argv[++i]
  else if (argv[i] === '--code') opt.code = argv[++i]
  else action = argv[i]
}
const need = (n) => process.env[n] || (console.error(`Set ${n}`), process.exit(2))

const api = async (path, token, init = {}) => {
  const r = await fetch(opt.base + path, { ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const login = await api('/api/auth/login', null, { method: 'POST',
  body: JSON.stringify({ username: need('GUIDE_ADMIN_USER'), password: need('GUIDE_ADMIN_PASSWORD'), branchCode: opt.branch }) })
const token = login.token
const all = await api(`/api/terminals?branchCode=${opt.branch}`, token)
const t = all.find(x => x.TerminalCode === opt.code && x.BranchCode === opt.branch)

if (action === 'create') {
  if (t) { console.log(`${opt.branch}/${opt.code} already exists (id ${t.TerminalId}, ${t.IsActive ? 'shown' : 'hidden'})`); process.exit(0) }
  const r = await api('/api/terminals', token, { method: 'POST', body: JSON.stringify({
    terminalId: 0, branchCode: opt.branch, terminalCode: opt.code, terminalName: 'Guide recordings (no ERP)',
    printerTarget: 'console', paperWidth: 80, printAgentKey: opt.key, isActive: true,
    erpTerminalCode: '', postToErp: false }) })
  console.log(`Created ${opt.branch}/${opt.code} (id ${r.terminalId}), shown`)
} else if (action === 'on' || action === 'off') {
  if (!t) { console.error(`${opt.branch}/${opt.code} doesn't exist; run "create" first`); process.exit(1) }
  if (t.PostToErp) { console.error(`${opt.code} posts to the ERP: not a recording terminal, refusing to touch it`); process.exit(1) }
  await api(`/api/terminals/${t.TerminalId}`, token, { method: 'PUT', body: JSON.stringify({ ...t, IsActive: action === 'on' }) })
  console.log(`${opt.branch}/${opt.code} is now ${action === 'on' ? 'shown in' : 'hidden from'} Cash Begin`)
} else {
  console.log(t ? `${opt.branch}/${opt.code}: id ${t.TerminalId}, ${t.IsActive ? 'shown' : 'hidden'}, printer ${t.PrinterTarget}, ERP posting ${t.PostToErp ? 'ON' : 'off'}`
    : `${opt.branch}/${opt.code} doesn't exist`)
}

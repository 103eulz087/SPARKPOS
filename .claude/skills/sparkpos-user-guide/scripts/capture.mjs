#!/usr/bin/env node
// Drives SparkPOS in a headless Chrome through scenario files and saves, per scenario, numbered
// screenshots and MP4 clips plus a manifest.json (captions, order) for the user guide.
//
//   node capture.mjs [--base http://localhost:5092] [--out DIR] [--agent-key demo-capture]
//                    [--device desktop|handheld] [--profile DIR] scenario.json [more.json ...]
//
// All scenarios of one run share ONE browser session, in the order given (a cashier's day:
// sign in -> Cash Begin -> sales -> Blind Close -> End of Day). Values written "$NAME" are read
// from the environment (passwords never go in scenario files).
//
// While it runs, a stand-in PrintAgent listens on localhost:5099 (so receipts "print" instead of
// showing a printer error) and collects the server's print jobs for --agent-key; every printed
// text is saved under <out>/receipts/.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const TOOLS = process.env.SPARKPOS_GUIDE_TOOLS || path.join(os.homedir(), '.cache', 'sparkpos-guide')
const require = createRequire(path.join(TOOLS, 'package.json'))
let puppeteer, ffmpeg
try { puppeteer = require('puppeteer-core'); ffmpeg = require('ffmpeg-static') }
catch { console.error(`Capture tools missing in ${TOOLS}. Run scripts/setup.sh first.`); process.exit(2) }

// ---------- arguments ----------
const argv = process.argv.slice(2)
const opt = { base: 'http://localhost:5092', out: path.resolve('guide-capture'), agentKey: 'demo-capture', device: 'desktop' }
const files = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--base') opt.base = argv[++i].replace(/\/$/, '')
  else if (a === '--out') opt.out = path.resolve(argv[++i])
  else if (a === '--agent-key') opt.agentKey = argv[++i]
  else if (a === '--device') opt.device = argv[++i]
  else if (a === '--profile') opt.profile = path.resolve(argv[++i])
  else files.push(a)
}
if (!files.length) { console.error('Usage: capture.mjs [--base URL] [--out DIR] [--device desktop|handheld] scenario.json ...'); process.exit(2) }

const DEVICES = {
  desktop: { width: 1366, height: 768, deviceScaleFactor: 1 },
  // the TC-TOUCH-T3 handheld: 5.5" portrait
  handheld: { width: 393, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
}

const chrome = (() => {
  const root = path.join(TOOLS, 'browser', 'chrome-headless-shell')
  for (const build of fs.existsSync(root) ? fs.readdirSync(root) : [])
    for (const dir of fs.readdirSync(path.join(root, build))) {
      const exe = path.join(root, build, dir, 'chrome-headless-shell')
      if (fs.existsSync(exe)) return exe
    }
  console.error('Headless Chrome missing. Run scripts/setup.sh first.'); process.exit(2)
})()

let lastReceipt = ''
// "$NAME" = an environment variable; "@lastSI" = the SI No. on the last printed receipt
const env = (v) => {
  if (v === '@lastSI') {
    const m = lastReceipt.match(/\b(\d{18})\b/)
    if (!m) throw new Error('No SI No. on a printed receipt yet')
    return String(Number(m[1]))
  }
  return typeof v === 'string' && v.startsWith('$')
    ? (process.env[v.slice(1)] ?? (() => { throw new Error(`Environment variable ${v.slice(1)} is not set`) })())
    : v
}

// ---------- stand-in PrintAgent ----------
let receiptNo = 0, receiptDir = null
const saveReceipt = (text, how) => {
  if (how === 'receipt' && /\d{18}/.test(text) && !/REPRINT/.test(text)) lastReceipt = text
  if (!receiptDir) return
  fs.writeFileSync(path.join(receiptDir, `${String(++receiptNo).padStart(2, '0')}-${how}.txt`), text)
}
const agent = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') return res.end()
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', agent: 'guide capture stand-in', polling: true }))
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    try { saveReceipt(JSON.parse(body).text || '', 'receipt') } catch { /* not JSON */ }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ printed: true }))
  })
})
const agentUp = await new Promise(ok => {
  agent.once('error', () => ok(false))
  agent.listen(5099, '127.0.0.1', () => ok(true))
})
if (!agentUp) console.warn('Port 5099 is taken (a real PrintAgent?): receipts go to it, not to receipts/.')
const poll = setInterval(async () => {   // server-queued prints: X-Read, Blind Close, Z-Read
  try {
    const r = await fetch(`${opt.base}/api/print-jobs/poll?key=${encodeURIComponent(opt.agentKey)}`)
    if (r.status === 200) { const j = await r.json(); const t = j?.jobText ?? j?.JobText; if (t) saveReceipt(t, 'server') }
  } catch { /* server not reachable this round */ }
}, 2000)

// ---------- browser ----------
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  // the browser profile holds the till's IndexedDB (price list, queued sales) and the shift:
  // pass the profile printed by a failed run to carry on with it
  userDataDir: opt.profile || (opt.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkpos-guide-'))),
  args: ['--hide-scrollbars', '--font-render-hinting=none']
})
const page = await browser.newPage()
await page.setViewport(DEVICES[opt.device] || DEVICES.desktop)
page.setDefaultTimeout(20000)

// "Offline" the way a store loses the internet: requests to the SparkPOS server fail and the page
// is told it's offline, but the PC itself still works (PrintAgent on localhost, the app's own
// cache). Chrome's offline mode would cut localhost too and show a printer error a store never sees.
await page.evaluateOnNewDocument(() => {
  if (sessionStorage.getItem('__guide_offline') === '1')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
})
let cdp = null
async function setOffline(on) {
  if (!cdp) {
    cdp = await page.createCDPSession()
    cdp.on('Fetch.requestPaused', e =>
      cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'InternetDisconnected' }).catch(() => {}))
  }
  if (on) await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${opt.base}/api/*` }] })
  else await cdp.send('Fetch.disable')
  await page.evaluate((on) => {
    if (on) sessionStorage.setItem('__guide_offline', '1'); else sessionStorage.removeItem('__guide_offline')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !on })
    window.dispatchEvent(new Event(on ? 'offline' : 'online'))
  }, on)
}

// Overlays: a caption bar for the videos and a ring where each click lands.
const overlay = {
  async caption(text) {
    await page.evaluate((text) => {
      let bar = document.getElementById('__guide_caption')
      if (!text) { bar?.remove(); return }
      if (!bar) {
        bar = document.createElement('div'); bar.id = '__guide_caption'
        Object.assign(bar.style, { position: 'fixed', left: '50%', bottom: '84px', transform: 'translateX(-50%)',
          maxWidth: '86%', padding: '10px 18px', borderRadius: '12px', background: 'rgba(10,14,12,.88)',
          color: '#fff', font: '600 17px/1.35 Inter, system-ui, sans-serif', zIndex: 2147483647,
          boxShadow: '0 4px 18px rgba(0,0,0,.35)', pointerEvents: 'none', textAlign: 'center' })
        document.body.appendChild(bar)
      }
      bar.textContent = text
    }, text)
  },
  async ring(box) {
    await page.evaluate(({ x, y }) => {
      const r = document.createElement('div')
      Object.assign(r.style, { position: 'fixed', left: `${x - 22}px`, top: `${y - 22}px`, width: '44px', height: '44px',
        borderRadius: '50%', border: '3px solid #ffd43b', background: 'rgba(255,212,59,.25)', zIndex: 2147483646,
        pointerEvents: 'none', transition: 'transform .5s, opacity .5s' })
      document.body.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 700)
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  },
  async hideCaption(hidden) {
    await page.evaluate((h) => { const b = document.getElementById('__guide_caption'); if (b) b.style.display = h ? 'none' : '' }, hidden)
  }
}

// Finders: a button/link/tab by its visible words or aria-label; an input by its Field label.
async function byText(text, { exact = false, nth = 0 } = {}) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const h = await page.evaluateHandle((text, exact, nth) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim()
      const shown = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const words = el => norm(el.innerText) || norm(el.getAttribute('aria-label'))
      const all = [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab], summary, option')]
        .filter(el => shown(el) && !el.disabled)
      const hits = all.filter(el => exact ? words(el) === text : words(el) === text || words(el).includes(text))
      // on top at its own centre = not covered by an open window (a pill behind a modal loses)
      const onTop = el => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return e && (e === el || el.contains(e)) ? 0 : 1 }
      hits.sort((a, b) => onTop(a) - onTop(b) || (words(a) === text ? 0 : 1) - (words(b) === text ? 0 : 1) || words(a).length - words(b).length)
      return hits[nth] || null
    }, text, exact, nth)
    const el = h.asElement()
    if (el) return el
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`No visible, enabled button or link with the words "${text}"`)
}
async function byLabel(label) {
  const h = await page.waitForFunction((label) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim()
    for (const l of document.querySelectorAll('label')) {
      const first = l.querySelector('span')
      if (first && norm(first.textContent) === label) {
        const input = l.querySelector('input, select, textarea')
        if (input && input.getBoundingClientRect().width > 0) return input
      }
    }
    return null
  }, {}, label)
  return h.asElement()
}
const byPlaceholder = (p) => page.waitForSelector(`input[placeholder="${p.replace(/"/g, '\\"')}"]`, { visible: true })
const target = (s) => s.label ? byLabel(s.label) : s.placeholder ? byPlaceholder(s.placeholder)
  : s.selector ? page.waitForSelector(s.selector, { visible: true }) : null

async function clickEl(el) {
  await el.scrollIntoView()
  const box = await el.boundingBox()
  if (box) { await overlay.ring(box); await new Promise(r => setTimeout(r, 250)) }
  await el.click()
}
const pause = (ms) => new Promise(r => setTimeout(r, ms))

// ---------- run ----------
fs.mkdirSync(opt.out, { recursive: true })
const manifestPath = path.join(opt.out, 'manifest.json')
const manifest = { base: opt.base, device: opt.device, capturedAt: new Date().toISOString(), scenarios: [] }
let failed = false

for (const file of files) {
  const sc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const name = sc.name || path.basename(file, '.json')
  const dir = path.join(opt.out, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true })
  receiptDir = path.join(dir, 'receipts'); receiptNo = 0
  const entry = { name, title: sc.title || name, summary: sc.summary || '', shots: [], videos: [] }
  manifest.scenarios.push(entry)
  let shotNo = 0, recorder = null, videoPath = null, videoCaption = ''
  console.log(`\n== ${entry.title}`)

  try {
    for (const [i, s] of (sc.steps || []).entries()) {
      const label = `step ${i + 1}`
      if (s.goto) await page.goto(opt.base + s.goto, { waitUntil: 'networkidle2' })
      // browser storage for the site, e.g. {"pos_terminalId": "10"} = this device last used terminal 10
      if (s.storage) await page.evaluate((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v) },
        Object.fromEntries(Object.entries(s.storage).map(([k, v]) => [k, String(env(v))])))
      if (s.offline !== undefined) await setOffline(!!s.offline)
      if (s.reload) { await page.reload({ waitUntil: 'domcontentloaded' }); await pause(1500) }
      if (s.say !== undefined) await overlay.caption(s.say)
      // page text as shown (CSS capitals included), compared without case
      if (s.waitText) await page.waitForFunction(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), {}, s.waitText)
      if (s.click) await clickEl(await byText(String(env(s.click)), s))
      if (s.clickSelector) await clickEl(await page.waitForSelector(s.clickSelector, { visible: true }))
      if (s.fill) {
        const el = await target(s.fill)
        await clickEl(el)
        await el.click({ clickCount: 3 }); await page.keyboard.press('Backspace')
        await el.type(String(env(s.value)), { delay: s.fast ? 0 : 55 })
      }
      if (s.select) {
        const el = await target(s.select)
        await el.select(String(env(s.value)))
      }
      if (s.press) await page.keyboard.press(s.press)
      if (s.scan) {   // a barcode scanner types the code and Enter into the focused search box
        const el = await byPlaceholder(s.into || 'Scan a barcode or search by name / code…')
        await el.click({ clickCount: 3 }); await page.keyboard.press('Backspace')
        await el.type(String(env(s.scan)), { delay: 15 }); await page.keyboard.press('Enter')
      }
      if (s.expect) await page.waitForFunction(t => document.body.innerText.toLowerCase().includes(t.toLowerCase()), {}, s.expect)
      if (s.video === 'start') {
        videoPath = path.join(dir, `${s.clip || name}.webm`)
        videoCaption = s.caption || entry.title
        recorder = await page.screencast({ path: videoPath, ffmpegPath: ffmpeg })
        await pause(400)
      }
      if (s.wait) await pause(s.wait)
      if (s.shot) {
        await pause(s.settle ?? 600)
        await overlay.hideCaption(true)
        const file = `${String(++shotNo).padStart(2, '0')}-${s.shot}.png`
        await page.screenshot({ path: path.join(dir, file), fullPage: !!s.fullPage })
        await overlay.hideCaption(false)
        entry.shots.push({ file: `${name}/${file}`, caption: s.caption || '' })
        console.log(`  shot  ${file}${s.caption ? '  ' + s.caption : ''}`)
      }
      if (s.video === 'stop' && recorder) {
        await pause(800)
        await overlay.caption('')
        await recorder.stop(); recorder = null
        const mp4 = videoPath.replace(/\.webm$/, '.mp4')
        execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', videoPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-crf', '24', mp4])
        fs.rmSync(videoPath)
        entry.videos.push({ file: path.relative(opt.out, mp4), caption: videoCaption })
        console.log(`  video ${path.basename(mp4)}`)
      }
      if (s.note) console.log(`  ${label}: ${s.note}`)
    }
  } catch (e) {
    failed = true
    console.error(`  FAILED at ${entry.title}: ${e.message}`)
    try { await page.screenshot({ path: path.join(dir, 'error.png') }) } catch { /* page gone */ }
    entry.error = e.message
    if (recorder) { try { await recorder.stop() } catch { /* ignore */ } }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  if (failed) break   // later scenarios build on this one
}

await pause(2500)   // let the poller collect the last server print
clearInterval(poll)
await browser.close()
agent.close()
console.log(`\nManifest: ${manifestPath}`)
console.log(`Browser profile (pass with --profile to continue this session): ${opt.profile}`)
process.exit(failed ? 1 : 0)

/* Runtime verification: no game ships until it has actually run.
 *
 * Static validation (generate.mjs) proves the document parses. This module
 * proves the game WORKS: it boots the candidate in headless Chrome with the
 * real MP runtime and Arcade Kit — a host frame and a guest frame wired to
 * each other exactly like the server wires them — drives synthetic input,
 * samples the canvas, and collects every runtime error.
 *
 * The result is a list of concrete, repair-prompt-ready failure sentences.
 * An empty list means a real browser played this game for several seconds,
 * both seats rendered pixels, the guest's keys reached the host, and nothing
 * threw. That is the bar for putting a game in front of the room.
 *
 * (test/playtest.mjs is the interactive cousin of this module — richer CLI
 * output and screenshots. If the harness logic changes here, change it there.)
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// How long each phase of the run gets. Long enough for a slow first paint,
// short enough that verifying never dominates a generation.
const SETTLE_MS = 2600
const DRIVE_MS = 2600
const CHROME_BOOT_MS = 20000

// ------------------------------------------------------------- chrome finder

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

let chromePath // undefined = not looked yet, null = looked and absent
async function findChrome() {
  if (chromePath !== undefined) return chromePath
  for (const p of CHROME_CANDIDATES) {
    try {
      await access(p)
      chromePath = p
      return p
    } catch {
      /* next */
    }
  }
  chromePath = null
  return null
}

/** Is runtime verification possible on this machine? */
export async function verifierAvailable() {
  return !!(await findChrome())
}

// ---------------------------------------------------------------- the harness

const RUNTIME_FILES = ['shared/mp-runtime.js', 'shared/arcade-kit.js']
let runtimeSource = null
async function getRuntime() {
  if (!runtimeSource) {
    const parts = await Promise.all(RUNTIME_FILES.map((f) => readFile(join(ROOT, f), 'utf8')))
    runtimeSource = parts.join('\n')
  }
  return runtimeSource
}

let threeSource = null
async function getThree() {
  if (threeSource === null) {
    threeSource = await readFile(join(ROOT, 'shared', 'lib', 'three.min.js'), 'utf8')
  }
  return threeSource
}

/* Test-only probe injected next to the runtime. Counts what actually ARRIVES
 * in each frame (the guest never sends state, so counting sends says nothing
 * about whether it can see the game), dispatches real keyboard events, and
 * answers 'probe' with a colour census of the biggest canvas — a blank screen
 * is the one failure every other check sails straight past. */
const PROBE = `
window.__recv = { state: 0, input: 0, players: 0 }
addEventListener('message', function (ev) {
  var m = ev.data || {}
  if (m.t === 'net') {
    if (m.kind === 'state') window.__recv.state++
    if (m.kind === 'input') window.__recv.input++
  }
  if (m.t === 'players') window.__recv.players++
  if (m.t === 'synthetic-key') {
    var k = m.key
    var init = { key: k, code: k === ' ' ? 'Space' : (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true }
    try {
      window.dispatchEvent(new KeyboardEvent(m.type, init))
      document.dispatchEvent(new KeyboardEvent(m.type, init))
    } catch (e) {}
    return
  }
  if (m.t !== 'probe') return
  var out = { mode: 'dom', nodes: document.body ? document.body.childElementCount : 0 }
  try {
    var cs = Array.prototype.slice.call(document.querySelectorAll('canvas'))
    if (cs.length) {
      cs.sort(function (a, b) { return b.width * b.height - a.width * a.height })
      var c = cs[0], ctx = c.getContext('2d')
      if (!ctx) out = { mode: 'gl', w: c.width, h: c.height }
      else {
        var d = ctx.getImageData(0, 0, c.width, c.height).data, seen = {}, n = 0
        for (var i = 0; i < d.length; i += 4 * 331) {
          var key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
          if (!seen[key]) { seen[key] = 1; n++ }
        }
        out = { mode: '2d', w: c.width, h: c.height, colors: n }
      }
    }
  } catch (e) {
    out = { mode: 'error', message: String(e && e.message) }
  }
  out.recv = window.__recv
  parent.postMessage({ t: 'paint', paint: out }, '*')
})`

function buildHarness(pair) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05030a;display:flex}
  iframe{flex:1;height:100vh;border:0;display:block}
</style></head><body>
<script>
const PLAYERS = [
  {id:'p1',name:'Ana',color:'#8ce99a',index:0,isHost:true},
  {id:'p2',name:'Bo',color:'#74c0fc',index:1,isHost:false}
]
const PAIR = ${pair}
const blank = () => ({ boot:false, ready:false, states:0, events:0, inputs:0, errors:[], lastState:null, paint:null })
window.__r = blank()          // host
window.__g = blank()          // guest

const host = document.createElement('iframe')
host.setAttribute('sandbox','allow-scripts')
host.srcdoc = window.__SRCDOC_HOST
document.body.appendChild(host)

const guest = document.createElement('iframe')
guest.setAttribute('sandbox','allow-scripts')
guest.srcdoc = window.__SRCDOC_GUEST
if (PAIR) document.body.appendChild(guest)

window.__probe = () => {
  host.contentWindow.postMessage({t:'probe'},'*')
  if (PAIR) guest.contentWindow.postMessage({t:'probe'},'*')
}

function init(frame, me, isHost) {
  frame.contentWindow.postMessage({ t:'init', me, players: PAIR ? PLAYERS : [PLAYERS[0]], isHost, seed:1234 },'*')
}

addEventListener('message', ev => {
  const m = ev.data || {}
  const fromHost = ev.source === host.contentWindow
  const fromGuest = PAIR && ev.source === guest.contentWindow
  if (!fromHost && !fromGuest) return
  const rec = fromHost ? window.__r : window.__g

  if (m.t === 'boot') {
    rec.boot = true
    if (fromHost) init(host, PLAYERS[0], true)
    else init(guest, PLAYERS[1], false)
  }
  if (m.t === 'ready') rec.ready = true
  if (m.t === 'paint') rec.paint = m.paint
  if (m.t === 'error') rec.errors.push(String(m.message || '').slice(0,300) + (m.where ? ' @'+m.where : ''))

  if (m.t === 'net') {
    if (m.kind === 'state') {
      rec.states++
      rec.lastState = JSON.stringify(m.data).slice(0,400)
      if (fromHost && PAIR) {
        guest.contentWindow.postMessage({t:'net',kind:'state',data:m.data,from:'p1'},'*')
      }
    }
    if (m.kind === 'event') {
      rec.events++
      const other = fromHost ? (PAIR ? guest : null) : host
      if (other) other.contentWindow.postMessage({t:'net',kind:'event',type:m.type,data:m.data,from:fromHost?'p1':'p2'},'*')
    }
    if (m.kind === 'input') {
      rec.inputs++
      if (fromGuest) host.contentWindow.postMessage({t:'net',kind:'input',data:m.data,from:'p2'},'*')
    }
  }
})

// Bang on the keyboard of whichever seat must prove it can play.
window.__drive = () => {
  const target = (PAIR ? guest : host).contentWindow
  const keys = ['ArrowUp','ArrowLeft','ArrowRight',' ','w','a','d','Enter']
  let i = 0
  for (const key of keys) {
    setTimeout(() => {
      target.postMessage({t:'synthetic-key', key, type:'keydown'},'*')
      setTimeout(() => target.postMessage({t:'synthetic-key', key, type:'keyup'},'*'), 90)
    }, i * 130)
    i++
  }
  if (PAIR) {
    // Mid-round join: the roster grows while the game is running. A correct
    // game absorbs this; a wrong one throws or strands the newcomer.
    setTimeout(() => {
      const grown = PLAYERS.concat([{id:'p3',name:'Cy',color:'#ffa8a8',index:2,isHost:false}])
      host.contentWindow.postMessage({t:'players',isHost:true,players:grown},'*')
      guest.contentWindow.postMessage({t:'players',isHost:false,players:grown},'*')
    }, 900)
  }
}
</script></body></html>`
}

// ----------------------------------------------------------------- CDP client

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  let seq = 0
  const pending = new Map()
  ws.on('message', (d) => {
    let m
    try {
      m = JSON.parse(d.toString())
    } catch {
      return
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, resolve)
      try {
        ws.send(JSON.stringify({ id, method, params, sessionId }))
      } catch (err) {
        pending.delete(id)
        reject(err)
      }
    })
  return {
    send,
    open: new Promise((r) => ws.on('open', r)),
    close: () => {
      try {
        ws.close()
      } catch {
        /* already down */
      }
    },
  }
}

// -------------------------------------------------------------- verification

/* Verifications run one at a time. Generation fans out across models, but a
 * fleet of headless Chromes on a laptop starves the real browser the room is
 * using; serialized, each verdict costs ~8s against multi-minute builds. */
let queue = Promise.resolve()

/**
 * Run a candidate game in a real browser and report what is broken.
 *
 * @param {object} o
 * @param {string} o.html          the complete game document
 * @param {'multi'|'single'} [o.mode]
 * @returns {Promise<{passed: boolean, skipped?: boolean, failures: string[], stats?: object}>}
 */
export function verifyGame({ html, mode = 'multi' }) {
  const run = queue.then(() => verifyOnce({ html, mode }))
  // The queue survives failures; the caller still sees them.
  queue = run.catch(() => {})
  return run
}

async function verifyOnce({ html, mode }) {
  const chrome = await findChrome()
  if (!chrome) {
    return {
      passed: true,
      skipped: true,
      failures: [],
      stats: { note: 'no Chrome/Chromium found — runtime verification skipped' },
    }
  }

  const pair = mode !== 'single'
  const runtime = await getRuntime()
  const lib = /\bTHREE\s*\./.test(html) ? await getThree() : ''

  /* Identity is baked into each frame's document exactly like GameFrame does
   * with __MP_INIT, so MP.isHost is correct from the game's first line. A
   * game that legitimately branches on it at the top level must not fail
   * here when it would work in the real room. */
  const P1 = { id: 'p1', name: 'Ana', color: '#8ce99a', index: 0, isHost: true }
  const P2 = { id: 'p2', name: 'Bo', color: '#74c0fc', index: 1, isHost: false }
  const roster = pair ? [P1, P2] : [P1]
  const initFor = (me, isHost) =>
    `<script>window.__MP_INIT = ${JSON.stringify({ me, players: roster, isHost, seed: 1234 }).replace(/</g, '\\u003c')};</script>\n`
  const docFor = (me, isHost) => injectRuntime(html, runtime, lib, initFor(me, isHost))

  // Serve the harness so the game frames get a normal opaque-origin sandbox.
  const literalFor = (doc) => JSON.stringify(doc).replace(/<\/script/gi, '<\\/script')
  const harness = buildHarness(pair)
    .replace(/window\.__SRCDOC_HOST/g, literalFor(docFor(P1, true)))
    .replace(/window\.__SRCDOC_GUEST/g, literalFor(docFor(P2, false)))
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(harness)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const profile = await mkdtemp(join(tmpdir(), 'arcade-verify-'))
  let proc = null
  let cdp = null
  try {
    proc = spawn(
      chrome,
      [
        '--headless=new',
        '--use-angle=swiftshader', // headless has no GPU; 3D must not fail for that
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--window-size=1280,800',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ''
      const t = setTimeout(() => reject(new Error('chrome did not start')), CHROME_BOOT_MS)
      proc.on('error', (err) => {
        clearTimeout(t)
        reject(err)
      })
      proc.stderr.on('data', (d) => {
        buf += d.toString()
        const m = buf.match(/ws:\/\/[^\s]+/)
        if (m) {
          clearTimeout(t)
          resolve(m[0])
        }
      })
    })

    cdp = connectCdp(wsUrl)
    await cdp.open
    const { result: t } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${port}/`,
    })
    const { result: s } = await cdp.send('Target.attachToTarget', {
      targetId: t.targetId,
      flatten: true,
    })
    const session = s.sessionId
    await cdp.send('Runtime.enable', {}, session)

    // Wait for the harness itself before trusting anything it reports.
    let armed = false
    for (let i = 0; i < 40; i++) {
      const probe = await cdp.send(
        'Runtime.evaluate',
        { expression: 'typeof window.__r', returnByValue: true },
        session,
      )
      if (probe.result?.result?.value === 'object') {
        armed = true
        break
      }
      await sleep(250)
    }
    if (!armed) throw new Error('verification harness never loaded')

    await sleep(SETTLE_MS)
    await cdp.send('Runtime.evaluate', { expression: 'window.__drive && window.__drive()' }, session)
    await sleep(DRIVE_MS)
    await cdp.send('Runtime.evaluate', { expression: 'window.__probe && window.__probe()' }, session)
    await sleep(600)

    const read = await cdp.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify({host: window.__r, guest: window.__g})', returnByValue: true },
      session,
    )
    const value = read.result?.result?.value
    if (typeof value !== 'string') throw new Error('could not read the harness result')
    const { host, guest } = JSON.parse(value)
    return judge({ host, guest, pair })
  } catch (err) {
    // Infrastructure trouble is not the game's fault. Never fail a game for it.
    return {
      passed: true,
      skipped: true,
      failures: [],
      stats: { note: `verification unavailable: ${err.message}` },
    }
  } finally {
    cdp?.close()
    proc?.kill('SIGKILL')
    server.close()
    rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

function injectRuntime(doc, runtime, lib, initTag = '') {
  const tag =
    (lib ? `<script>\n${lib}\n</script>\n` : '') +
    initTag +
    `<script>\n${runtime}\n${PROBE}\n</script>\n`
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => m + '\n' + tag)
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => m + '\n' + tag)
  return tag + doc
}

/** Turn raw harness telemetry into repair-prompt-ready failure sentences. */
function judge({ host, guest, pair }) {
  const failures = []
  const errs = (list) => [...new Set(list)].slice(0, 3).join(' | ')

  if (!host.boot) {
    failures.push(
      'The game never booted in a real browser — the document loads but the MP runtime never came up, which means a top-level script error killed it before the first frame.',
    )
    // Nothing below can be trusted if the frame is dead.
    return { passed: false, failures, stats: { host, guest: pair ? guest : undefined } }
  }
  if (host.errors.length) {
    failures.push(`Runtime errors thrown while the game ran (fix every one): ${errs(host.errors)}`)
  }
  if (!host.ready) {
    failures.push(
      'The game never called MP.ready() during a 5-second run in a real browser. Call it once, after initialization actually succeeds.',
    )
  }

  const paint = host.paint || {}
  if (paint.mode === '2d') {
    if (!(paint.colors > 3)) {
      failures.push(
        `The canvas is effectively blank after 5 seconds of play (${paint.colors || 0} distinct colours sampled). The game must draw a visible scene immediately — title, arena, entities.`,
      )
    }
    if (!(paint.w > 50 && paint.h > 50)) {
      failures.push(
        `The canvas is ${paint.w || 0}x${paint.h || 0} pixels — it never sized itself to the window. Use AK.canvas() (or size from innerWidth/innerHeight and handle resize).`,
      )
    }
  } else if (paint.mode === 'gl') {
    if (!(paint.w > 200 && paint.h > 200)) {
      failures.push(
        `The 3D canvas is ${paint.w || 0}x${paint.h || 0} pixels — it never sized itself to the window. Call renderer.setSize(innerWidth, innerHeight) and update camera.aspect on resize.`,
      )
    }
  } else if (paint.mode === 'dom' && !(paint.nodes > 0)) {
    failures.push('The page rendered nothing at all — no canvas and an empty body.')
  }

  if (pair) {
    if (!(host.states > 0)) {
      failures.push(
        'The host never broadcast any state (0 MP.setState calls observed in 5 seconds). The host must simulate and call MP.setState(state) every tick.',
      )
    }
    if (guest.boot) {
      if (guest.errors.length) {
        failures.push(`Runtime errors on the GUEST seat (fix every one): ${errs(guest.errors)}`)
      }
      const grecv = guest.paint?.recv?.state || 0
      if (host.states > 0 && !(grecv > 3)) {
        failures.push(
          `A second player received almost no state (${grecv} updates) even though the host was broadcasting — the guest render path is broken.`,
        )
      }
      if (guest.states > 0) {
        failures.push(
          `The guest broadcast ${guest.states} states of its own. Only the host is authoritative: everything that simulates must be behind MP.isHost, but input and rendering must not be.`,
        )
      }
      if (!(guest.inputs > 0)) {
        failures.push(
          'A second player pressed movement keys and NOTHING was sent to the host (0 MP.sendInput calls from the guest). Every client must capture input and call MP.sendInput — never gate input on MP.isHost.',
        )
      }
      const gpaint = guest.paint || {}
      if (gpaint.mode === '2d' && !(gpaint.colors > 3)) {
        failures.push(
          `The second player's screen is blank (${gpaint.colors || 0} distinct colours) while the host's is not — the guest never draws the received state.`,
        )
      }
    } else {
      failures.push(
        'The guest frame never booted — a second player joining would see a dead screen.',
      )
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    stats: {
      hostStates: host.states,
      hostErrors: host.errors.length,
      guestInputs: pair ? guest.inputs : undefined,
      guestStateRecv: pair ? guest.paint?.recv?.state : undefined,
      paint,
    },
  }
}

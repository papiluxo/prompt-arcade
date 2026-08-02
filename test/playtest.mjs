/* Runtime playtest: does a generated game actually boot and sync?
 *
 * Static validation catches syntax errors and missing API calls. It cannot
 * tell you the game throws on frame one. This runs the real thing in headless
 * Chrome with the real MP runtime, drives an input, and checks state comes out
 * the other side.
 *
 *   node test/playtest.mjs path/to/game.html
 *   node test/playtest.mjs data/games/<id>.json
 *   node test/playtest.mjs --shot out.png data/games/<id>.json
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
let shotPath = null
// Multiplayer is the default: a guest frame is the whole point of this test.
// --solo runs a single frame, for single-player games.
let PAIR = true
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shot') shotPath = args[++i]
  else if (args[i] === '--solo') PAIR = false
  else positional.push(args[i])
}
const target = positional.pop()

if (!target) {
  console.error('usage: node test/playtest.mjs [--shot out.png] <game.html|game.json>')
  process.exit(2)
}

const raw = await readFile(target, 'utf8')
const html = target.endsWith('.json') ? JSON.parse(raw).html : raw
const runtime = [
  await readFile(join(ROOT, 'shared', 'mp-runtime.js'), 'utf8'),
  await readFile(join(ROOT, 'shared', 'arcade-kit.js'), 'utf8'),
].join('\n')

const needsThree = /\bTHREE\s*\./.test(html)
const libSource = needsThree
  ? `<script>\n${await readFile(join(ROOT, 'shared', 'lib', 'three.min.js'), 'utf8')}\n</script>\n`
  : ''
if (needsThree) console.log('  (injecting three.js)')

/* Two real frames — a host and a guest — wired to each other exactly like the
 * server wires them: input goes up to the host, state comes back down. This is
 * the only way to catch a game that plays fine for whoever started it and
 * leaves everyone else staring at an empty screen. */
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05030a;display:flex}
  iframe{flex:1;height:100vh;border:0;display:block}
</style></head><body>
<script>
const PLAYERS = [
  {id:'p1',name:'Ana',color:'#8ce99a',index:0,isHost:true},
  {id:'p2',name:'Bo',color:'#74c0fc',index:1,isHost:false}
]
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
if (window.__PAIR) document.body.appendChild(guest)

window.__probe = () => {
  host.contentWindow.postMessage({t:'probe'},'*')
  if (window.__PAIR) guest.contentWindow.postMessage({t:'probe'},'*')
}

function init(frame, me, isHost) {
  frame.contentWindow.postMessage({ t:'init', me, players:PLAYERS, isHost, seed:1234 },'*')
}

addEventListener('message', ev => {
  const m = ev.data || {}
  const fromHost = ev.source === host.contentWindow
  const fromGuest = ev.source === guest.contentWindow
  if (!fromHost && !fromGuest) return
  const rec = fromHost ? window.__r : window.__g

  if (m.t === 'boot') {
    rec.boot = true
    if (fromHost) init(host, PLAYERS[0], true)
    else init(guest, PLAYERS[1], false)
  }
  if (m.t === 'ready') rec.ready = true
  if (m.t === 'paint') rec.paint = m.paint
  if (m.t === 'error') rec.errors.push(m.message + (m.where ? ' @'+m.where : ''))

  if (m.t === 'net') {
    if (m.kind === 'state') {
      rec.states++
      rec.lastState = JSON.stringify(m.data).slice(0,400)
      // Host state flows down to the guest, as the server would relay it.
      if (fromHost && window.__PAIR) {
        guest.contentWindow.postMessage({t:'net',kind:'state',data:m.data,from:'p1'},'*')
      }
    }
    if (m.kind === 'event') rec.events++
    if (m.kind === 'input') {
      rec.inputs++
      // Guest input flows up to the host, as the server would relay it.
      if (fromGuest) host.contentWindow.postMessage({t:'net',kind:'input',data:m.data,from:'p2'},'*')
    }
  }
})

// Bang on the guest's keyboard. Anything it does must reach the host as input.
window.__drive = () => {
  const target = (window.__PAIR ? guest : host).contentWindow
  const keys = ['ArrowUp','ArrowLeft',' ','w','a']
  for (const key of keys) {
    for (const type of ['keydown','keyup']) {
      try {
        target.postMessage({t:'synthetic-key', key, type},'*')
      } catch (e) {}
    }
  }
  if (!window.__PAIR) {
    for (const key of keys) {
      host.contentWindow.postMessage({t:'net',kind:'input',from:'p2',data:{key,up:true,left:true,fire:true}},'*')
    }
  }
  const grown = PLAYERS.concat([{id:'p3',name:'Cy',color:'#ffa8a8',index:2,isHost:false}])
  host.contentWindow.postMessage({t:'players',isHost:true,players:grown},'*')
  if (window.__PAIR) guest.contentWindow.postMessage({t:'players',isHost:false,players:grown},'*')
}
</script></body></html>`

/* Identity is baked into each frame's document exactly like GameFrame does
 * with __MP_INIT, so MP.isHost is correct from the game's first line
 * (mirrors server/verify.mjs). */
const P1 = { id: 'p1', name: 'Ana', color: '#8ce99a', index: 0, isHost: true }
const P2 = { id: 'p2', name: 'Bo', color: '#74c0fc', index: 1, isHost: false }
const roster = PAIR ? [P1, P2] : [P1]
const initFor = (me, isHost) =>
  `<script>window.__MP_INIT = ${JSON.stringify({ me, players: roster, isHost, seed: 1234 }).replace(/</g, '\\u003c')};</script>\n`

// Serve the harness so the iframe gets a normal opaque-origin sandbox.
const server = createServer((req, res) => {
  // The game contains its own </script> tags; they must not close the harness's.
  const literalFor = (init) =>
    JSON.stringify(injectRuntime(html, runtime, init)).replace(/<\/script/gi, '<\\/script')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    HARNESS.replace(/window\.__SRCDOC_HOST/g, literalFor(initFor(P1, true)))
      .replace(/window\.__SRCDOC_GUEST/g, literalFor(initFor(P2, false)))
      .replace(/window\.__PAIR/g, String(PAIR)),
  )
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

/* Test-only probe, injected alongside the runtime. Answers a 'probe' message
 * with a colour census of the game's largest canvas — a blank screen is the
 * one failure mode every other check sails straight past. */
const PROBE = `
window.__recv = { state: 0, input: 0, players: 0 }
addEventListener('message', function (ev) {
  // Count what actually arrives in this frame. The guest never *sends* state,
  // so counting sends tells you nothing about whether it can see the game.
  if (ev.data && ev.data.t === 'net') {
    if (ev.data.kind === 'state') window.__recv.state++
    if (ev.data.kind === 'input') window.__recv.input++
  }
  if (ev.data && ev.data.t === 'players') window.__recv.players++
})
addEventListener('message', function (ev) {
  // Real key events, so games that listen on window/document actually react.
  if (ev.data && ev.data.t === 'synthetic-key') {
    var k = ev.data.key
    var init = { key: k, code: k === ' ' ? 'Space' : 'Key' + k.toUpperCase(), bubbles: true, cancelable: true }
    try {
      window.dispatchEvent(new KeyboardEvent(ev.data.type, init))
      document.dispatchEvent(new KeyboardEvent(ev.data.type, init))
    } catch (e) {}
    return
  }
  if (!ev.data || ev.data.t !== 'probe') return
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
          var k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
          if (!seen[k]) { seen[k] = 1; n++ }
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

function injectRuntime(doc, rt, initTag = '') {
  // Mirror what GameFrame does, libraries included, or a 3D game explodes here
  // for reasons that have nothing to do with the game.
  const tag = `${libSource}${initTag}<script>\n${rt}\n${PROBE}\n</script>\n`
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => m + '\n' + tag)
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => m + '\n' + tag)
  return tag + doc
}

const profile = await mkdtemp(join(tmpdir(), 'playtest-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    // Software WebGL — headless has no GPU, and without this every 3D game
    // fails here for reasons that would never happen in a real browser.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

// Chrome prints the devtools endpoint on stderr when the port is 0.
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('chrome did not start')), 20000)
  chrome.stderr.on('data', (d) => {
    buf += d.toString()
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) {
      clearTimeout(t)
      resolve(m[0])
    }
  })
})

const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
await new Promise((r) => ws.on('open', r))
let seq = 0
const pending = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const id = ++seq
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })

const { result: t } = await send('Target.createTarget', { url: `http://localhost:${port}/` })
const { result: s } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
const session = s.sessionId

await send('Page.enable', {}, session)
await send('Runtime.enable', {}, session)

// Wait for the harness itself to be live before trusting anything it reports.
let armed = false
for (let i = 0; i < 40; i++) {
  const probe = await send(
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
if (!armed) {
  console.error('harness never loaded — is Chrome blocking localhost?')
  process.exit(2)
}

await sleep(2500)
await send('Runtime.evaluate', { expression: 'window.__drive && window.__drive()' }, session)
await sleep(2500)
await send('Runtime.evaluate', { expression: 'window.__probe && window.__probe()' }, session)
await sleep(500)

const probe = await send(
  'Runtime.evaluate',
  { expression: 'JSON.stringify({host: window.__r, guest: window.__g})', returnByValue: true },
  session,
)
const value = probe.result?.result?.value
if (typeof value !== 'string') {
  console.error('could not read the harness result:', JSON.stringify(probe).slice(0, 400))
  process.exit(2)
}
const { host: r, guest: g } = JSON.parse(value)

const paint = r.paint || {}

if (shotPath) {
  const cap = await send('Page.captureScreenshot', { format: 'png' }, session)
  if (cap.result?.data) await writeFile(shotPath, Buffer.from(cap.result.data, 'base64'))
}

ws.close()
chrome.kill()
server.close()

// ------------------------------------------------------------------ verdict
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log(`\nplaytest: ${target}${PAIR ? '  (host + guest)' : '  (solo)'}\n`)
check('the game boots and finds MP', r.boot)
check('it calls MP.ready()', r.ready)
check('the host publishes state', r.states > 0, `${r.states} broadcasts in 5s`)
check('no runtime errors', r.errors.length === 0, r.errors.slice(0, 3).join(' | '))

if (PAIR) {
  // Everything below is the guest's experience — the half that was never tested
  // and the half that was broken.
  check('the guest boots', g.boot)
  check('the guest reaches MP.ready()', g.ready)
  check(
    'the guest receives authoritative state',
    (g.paint?.recv?.state || 0) > 5,
    `${g.paint?.recv?.state || 0} state updates received`,
  )
  check(
    'the guest never simulates',
    g.states === 0,
    `guest broadcast ${g.states} states — it must not be authoritative`,
  )
  check('the guest throws nothing', g.errors.length === 0, g.errors.slice(0, 3).join(' | '))
  check(
    'the guest can actually play — its input reaches the host',
    g.inputs > 0,
    `${g.inputs} inputs sent by the guest`,
  )
  if (g.paint?.mode === '2d') {
    check('the guest renders a real screen', g.paint.colors > 3, `${g.paint.colors} colours`)
  } else if (g.paint?.mode === 'gl') {
    check('the guest renders in 3D', g.paint.w > 200, `${g.paint.w}x${g.paint.h}`)
  }
}

if (paint.mode === '2d') {
  check('the canvas is actually painted', paint.colors > 3, `${paint.colors} distinct colours`)
  check('the canvas has real dimensions', paint.w > 50 && paint.h > 50, `${paint.w}x${paint.h}`)
} else if (paint.mode === 'gl') {
  // WebGL clears its drawing buffer after compositing, so pixels can't be read
  // back from outside. Dimensions are the part that actually goes wrong.
  check('the 3D canvas fills the frame', paint.w > 200 && paint.h > 200, `${paint.w}x${paint.h}`)
  console.log('  note  WebGL: colour census not readable, use --shot to eyeball it')
} else if (paint.mode) {
  console.log(`  note  renders via ${paint.mode}; pixel check skipped`)
} else {
  console.log('  note  could not reach the game context; pixel check skipped')
}
if (r.lastState) console.log(`\n  state sample: ${r.lastState}\n`)
console.log(`${failed ? `${failed} failed` : 'all good'}\n`)
process.exit(failed ? 1 : 0)

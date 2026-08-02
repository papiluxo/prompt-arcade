/* Two real browsers, one room, one game.
 *
 * The paired playtest fakes the relay. This does not: two separate Chrome
 * profiles run the actual client, talk to the actual server, and we screenshot
 * what each of them is really looking at. It is the only test that covers the
 * whole chain — browser -> server -> browser.
 *
 *   node test/twobrowser.mjs <gameId> [--out DIR]
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = process.env.ARCADE_URL || 'http://localhost:8787'
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
let outDir = '/tmp'
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = args[++i]
  else positional.push(args[i])
}
const gameId = positional[0]
if (!gameId) {
  console.error('usage: node test/twobrowser.mjs <gameId> [--out DIR]')
  process.exit(2)
}

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++
    console.log(`  ok    ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** One browser: its own profile, its own devtools port, its own player. */
async function browser(name, port) {
  const profile = await mkdtemp(join(tmpdir(), `arcade-${name}-`))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1100,760',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://localhost:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {}
    await sleep(250)
  }
  if (!target) throw new Error(`${name}: chrome never came up`)

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 })
  await new Promise((r) => ws.on('open', r))
  let seq = 0
  const pending = new Map()
  const logs = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || ''))
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const cdp = (method, params = {}) =>
    new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })

  await cdp('Page.enable')
  await cdp('Runtime.enable')

  return {
    name,
    logs,
    cdp,
    async go(url, wait = 2500) {
      await cdp('Page.navigate', { url })
      await sleep(wait)
    },
    async evaluate(expression) {
      const r = await cdp('Runtime.evaluate', { expression, returnByValue: true })
      return r.result?.result?.value
    },
    /** Real clicks and keystrokes, delivered into the page like a person. */
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
    },
    async key(key, code, type = 'keyDown') {
      await cdp('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: key === 'Escape' ? 27 : undefined,
      })
    },
    async hold(key, code, ms) {
      await this.key(key, code, 'keyDown')
      await sleep(ms)
      await this.key(key, code, 'keyUp')
    },
    async shot(file) {
      const c = await cdp('Page.captureScreenshot', { format: 'png' })
      if (c.result?.data) await writeFile(file, Buffer.from(c.result.data, 'base64'))
    },
    kill() {
      ws.close()
      proc.kill()
    },
  }
}

const hostB = await browser('host', 9330)
const guestB = await browser('guest', 9331)

try {
  const { id: code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()
  console.log(`\ntwo-browser test  room ${code}  game ${gameId}\n`)

  // The host navigates ONCE, with the game already in the URL. Navigating a
  // second time drops its socket and hands the host role to the other player —
  // which is how an earlier version of this test ended up screenshotting the
  // host twice and declaring the guest fine.
  await hostB.go(BASE, 1200)
  await hostB.evaluate(`localStorage.setItem('arcade:name','HostHarriet')`)
  await hostB.go(`${BASE}/r/${code}?load=${gameId}`, 6000)

  // Guest joins a room where the game is already running.
  await guestB.go(BASE, 1200)
  await guestB.evaluate(`localStorage.setItem('arcade:name','GuestGus')`)
  await guestB.go(`${BASE}/r/${code}`, 6000)
  await sleep(4000)

  const roster = await hostB.evaluate(`document.querySelectorAll('.roster-row').length`)
  check('both players are in the room', roster === 2, `${roster} in roster`)

  // The whole test is worthless if the "guest" is secretly the host.
  const guestIsHost = await guestB.evaluate(
    `!!document.querySelector('.roster-row .tag-host')?.closest('.roster-row')?.innerText?.includes('(you)')`,
  )
  check('the guest is genuinely NOT the host', guestIsHost === false, `guestIsHost=${guestIsHost}`)

  const hostPlaying = await hostB.evaluate(`!!document.querySelector('.game-frame')`)
  const guestPlaying = await guestB.evaluate(`!!document.querySelector('.game-frame')`)
  check('the host is in the game', hostPlaying)
  check('the guest is in the game', guestPlaying)

  const hostOverlay = await hostB.evaluate(
    `document.querySelector('.frame-overlay')?.innerText?.trim() || ''`,
  )
  const guestOverlay = await guestB.evaluate(
    `document.querySelector('.frame-overlay')?.innerText?.trim() || ''`,
  )
  check('the host is past the loading overlay', !hostOverlay, hostOverlay)
  check('the guest is past the loading overlay', !guestOverlay, guestOverlay)

  await hostB.shot(join(outDir, 'two-guest-onload.png'))

  // Now behave like a player: click into the game, dismiss whatever is in the
  // way, and hold a direction. If the guest can play, something must move.
  const box = await guestB.evaluate(`(() => {
    const f = document.querySelector('.game-frame')
    if (!f) return null
    const r = f.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`)
  const centre = box ? JSON.parse(box) : { x: 380, y: 320 }

  void centre

  // Before anything is pressed, the room is sitting in the game's lobby. The
  // host must already be broadcasting, or guests cannot even see the roster.
  const lobbyDiag = JSON.parse(await hostB.evaluate(`JSON.stringify(window.__arcadeDiag || {})`))
  check(
    'the host broadcasts state while still in the lobby',
    lobbyDiag.stateOut > 5,
    `stateOut=${lobbyDiag.stateOut} before anyone pressed anything`,
  )

  // Any player starts the round — press Space as the GUEST, not the host.
  await guestB.hold(' ', 'Space', 150)
  await sleep(1500)
  const started = JSON.parse(await guestB.evaluate(`JSON.stringify(window.__arcadeDiag || {})`))
  check(
    'a guest pressing Space starts the round for everyone',
    started.stateIn > 5,
    `guest stateIn=${started.stateIn} after pressing start`,
  )

  // NO CLICKING. A player who just had the game appear on their screen should
  // be able to press a key and move. This is the exact scenario that failed.
  for (let i = 0; i < 3; i++) {
    await guestB.hold('ArrowRight', 'ArrowRight', 500)
    await guestB.hold('ArrowDown', 'ArrowDown', 500)
  }
  await sleep(600)

  const guestMoved = await guestB.evaluate(
    `document.activeElement === document.querySelector('.game-frame')`,
  )
  check('the game has the keyboard without the player clicking first', guestMoved === true)

  // The decisive numbers: is the relay actually delivering to this guest?
  const hostDiag = JSON.parse(await hostB.evaluate(`JSON.stringify(window.__arcadeDiag || {})`))
  const guestDiag = JSON.parse(await guestB.evaluate(`JSON.stringify(window.__arcadeDiag || {})`))
  console.log(`\n  host  diag: ${JSON.stringify(hostDiag)}`)
  console.log(`  guest diag: ${JSON.stringify(guestDiag)}\n`)

  check('the host is broadcasting state', hostDiag.stateOut > 10, `stateOut=${hostDiag.stateOut}`)
  check(
    'the guest RECEIVES state from the server',
    guestDiag.stateIn > 10,
    `stateIn=${guestDiag.stateIn}`,
  )
  check(
    'the guest forwards that state into the game',
    guestDiag.toGame > 10,
    `toGame=${guestDiag.toGame}`,
  )
  check(
    'the guest sends its input out',
    guestDiag.inputOut > 0,
    `inputOut=${guestDiag.inputOut}`,
  )
  check(
    'the host receives the guest input',
    hostDiag.inputIn > 0,
    `host inputIn=${hostDiag.inputIn}`,
  )

  await hostB.shot(join(outDir, 'two-host.png'))
  await guestB.shot(join(outDir, 'two-guest.png'))
  console.log(`\n  screenshots: ${join(outDir, 'two-host.png')} / two-guest.png`)

  const guestErrors = guestB.logs.filter((l) => /error|exception/i.test(l))
  if (guestErrors.length) console.log('\n  guest console:\n   ' + guestErrors.slice(0, 6).join('\n   '))
  const hostErrors = hostB.logs.filter((l) => /error|exception/i.test(l))
  if (hostErrors.length) console.log('\n  host console:\n   ' + hostErrors.slice(0, 6).join('\n   '))
} finally {
  hostB.kill()
  guestB.kill()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)

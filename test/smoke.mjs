/* End-to-end smoke test.
 *
 * Boots the server, puts two players in a room, has them pitch ideas, runs a
 * real generation, then exercises the netcode relay, publishing and download.
 *
 *   npm run smoke            # full run, generates a game (slow)
 *   npm run smoke -- --fast  # everything except generation
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { validateGame } from '../server/generate.mjs'
import { majorityOf } from '../server/rooms.mjs'

const FAST = process.argv.includes('--fast')

/** Claim a free port so a stray server from an earlier run can never be
 *  mistaken for this one's — that failure mode passes tests against old code. */
async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

const PORT = await freePort()
const BASE = `http://localhost:${PORT}`

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok    ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A test client that records every message it receives. */
class Client {
  constructor(name) {
    this.name = name
    this.messages = []
  }

  connect(room) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws`)
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        this.messages.push(msg)
        if (msg.type === 'hello') {
          this.you = msg.you
          this.room = msg.room
          resolve(msg)
        }
        if (msg.type === 'room') this.room = msg.room
        if (msg.type === 'game') this.game = msg.game
      })
      this.ws.on('open', () =>
        this.ws.send(JSON.stringify({ type: 'hello', roomId: room, name: this.name })),
      )
      this.ws.on('error', reject)
      setTimeout(() => reject(new Error(`${this.name} never got a hello`)), 8000)
    })
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, ...payload }))
  }

  /** Wait for a message matching a predicate. */
  async wait(pred, timeoutMs = 10_000, label = 'message') {
    const started = Date.now()
    for (;;) {
      const hit = this.messages.find(pred)
      if (hit) return hit
      if (Date.now() - started > timeoutMs) throw new Error(`${this.name}: timed out waiting for ${label}`)
      await sleep(120)
    }
  }

  close() {
    this.ws?.close()
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'arcade-smoke-'))
  console.log(`\nprompt-arcade smoke test  (data: ${dataDir})\n`)

  const server = spawn('node', ['server/index.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[server] ${d}`))
  server.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`))
  server.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`\nthe server under test exited with ${code} — aborting\n`)
      process.exit(1)
    }
  })

  try {
    // --- boot ------------------------------------------------------------
    let health
    for (let i = 0; i < 40; i++) {
      try {
        health = await (await fetch(`${BASE}/api/health`)).json()
        break
      } catch {
        await sleep(150)
      }
    }
    check('server boots and answers /api/health', !!health?.ok)
    check('generation backend is ready', !!health?.generation?.ready, health?.generation?.note)

    // --- room + presence --------------------------------------------------
    const { id: code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()
    check('creates a room', /^[A-Z0-9]{4}$/.test(code), code)

    const missing = await (await fetch(`${BASE}/api/rooms/ZZZZ`)).json()
    check('rejects an unknown room code', missing.exists === false)

    const models = (await (await fetch(`${BASE}/api/models`)).json()).models
    check('all four models are offered', models.length === 4, models.map((m) => m.id).join(','))
    check('Fable 5 is in the lineup', models.some((m) => m.id === 'fable'))

    // 3D games depend on this being reachable, so treat it as load-bearing.
    const three = await fetch(`${BASE}/api/lib/three`)
    const threeBody = await three.text()
    check('three.js is served to the sandbox', three.ok && threeBody.length > 500_000, `${threeBody.length} bytes`)
    check('three.js is the real library', /REVISION/.test(threeBody))
    check('unknown libraries 404', (await fetch(`${BASE}/api/lib/jquery`)).status === 404)

    const ana = new Client('Ana')
    const bo = new Client('Bo')
    await ana.connect(code)
    await bo.connect(code)
    await sleep(300)

    check('both players are in the roster', ana.room.players.length === 2 || bo.room.players.length === 2)
    check('first player is host', ana.you.id === bo.room.hostId, `host=${bo.room.hostId}`)
    check('players get distinct colors', ana.you.color !== bo.room.players[1].color)

    // --- chat -------------------------------------------------------------
    ana.send('chat', { text: 'hello room' })
    const chat = await bo.wait((m) => m.type === 'chat' && m.message.text === 'hello room', 5000, 'chat')
    check('chat reaches the other player', chat.message.name === 'Ana')

    // --- collective prompt -------------------------------------------------
    ana.send('idea', { text: 'a race where the track is drawn by the players' })
    bo.send('idea', { text: 'and the loser has to draw the next track' })
    await sleep(400)
    const pitched = bo.room.players.filter((p) => p.idea.trim()).length
    check('both ideas land on the board', pitched === 2, `${pitched} pitched`)

    ana.send('models', { ids: ['haiku'] })
    await sleep(300)
    check('model selection syncs to everyone', bo.room.models.join() === 'haiku', bo.room.models.join())

    // --- mode is the host's call -------------------------------------------
    check('rooms default to multiplayer', bo.room.mode === 'multi', bo.room.mode)
    const notHost = bo.room.hostId === ana.you.id ? bo : ana
    notHost.send('mode', { mode: 'single' })
    const modeRefusal = await notHost.wait(
      (m) => m.type === 'toast' && m.level === 'error',
      5000,
      'a refusal for the non-host',
    )
    check('a non-host cannot change the mode', /only the host/i.test(modeRefusal.text), modeRefusal.text)
    check('the mode did not change', bo.room.mode === 'multi')

    const theHost = bo.room.hostId === ana.you.id ? ana : bo
    theHost.send('mode', { mode: 'single' })
    await sleep(400)
    check('the host can switch to single player', bo.room.mode === 'single', bo.room.mode)
    theHost.send('mode', { mode: 'multi' })
    await sleep(300)

    // --- the idea vote ------------------------------------------------------
    check(
      'majority is a simple majority of the room',
      [1, 2, 3, 4, 5, 6].map(majorityOf).join() === '1,2,2,3,3,4',
      [1, 2, 3, 4, 5, 6].map(majorityOf).join(),
    )

    ana.send('open-vote')
    const voting = await bo.wait(
      (m) => m.type === 'room' && m.room.phase === 'idea-vote',
      6000,
      'the idea vote to open',
    )
    check('pitching opens the vote instead of building', true)
    check('the room is told the threshold', voting.room.majority === 2, `majority=${voting.room.majority}`)

    // One vote of two is not a majority — no winner yet.
    bo.send('vote-idea', { ownerId: ana.you.id })
    await sleep(500)
    check('one vote of two decides nothing', bo.room.ideaWinner === null)
    check('the vote is visible to the room', bo.room.ideaVotes[bo.you.id] === ana.you.id)

    // A majority decides the winner but must NOT start a build on its own.
    ana.send('vote-idea', { ownerId: ana.you.id })
    await sleep(600)
    check('a majority decides the winner', bo.room.ideaWinner === ana.you.id, bo.room.ideaWinner)
    check('deciding the vote does not start a build', bo.room.phase === 'idea-vote', bo.room.phase)

    // Only the host may pull the trigger.
    const guest = bo.room.hostId === ana.you.id ? bo : ana
    guest.send('start-build')
    const refusal = await guest.wait(
      (m) => m.type === 'toast' && m.level === 'error',
      5000,
      'a refusal for the non-host',
    )
    check('a non-host cannot start the build', /only the host/i.test(refusal.text), refusal.text)
    check('the room stayed on the vote', bo.room.phase === 'idea-vote')

    // --- generation --------------------------------------------------------
    const hostClient = bo.room.hostId === ana.you.id ? ana : bo

    if (FAST) {
      hostClient.send('start-build')
      const started = await bo.wait(
        (m) => m.type === 'room' && m.room.phase === 'generating',
        8000,
        'the host to start the build',
      )
      check('the host starts the build', true)
      check(
        'the winning pitch becomes the brief verbatim',
        started.room.brief === 'a race where the track is drawn by the players',
        started.room.brief,
      )
      check('the brief is credited to the vote', started.room.briefSource === 'vote')
      ana.send('cancel')
      await sleep(400)
      console.log('  skip  generation (--fast)')
    } else {
      console.log('  ...   generating a real game, this takes a minute')
      hostClient.send('start-build')
      await bo.wait((m) => m.type === 'room' && m.room.phase === 'generating', 15_000, 'generating phase')
      check('the host starts the build', true)
      check(
        'the winning pitch becomes the brief verbatim',
        bo.room.brief === 'a race where the track is drawn by the players',
        bo.room.brief,
      )

      const gameMsg = await bo.wait((m) => m.type === 'game', 480_000, 'the finished game')
      const html = gameMsg.game.html
      const problems = validateGame(html)

      check('a game is broadcast to every player', !!html && html.length > 800, `${html?.length} bytes`)
      check('generated game passes validation', problems.length === 0, problems.join('; '))
      check('game uses the MP API', /MP\.ready\s*\(/.test(html) && /MP\.setState\s*\(/.test(html))
      check('room is now playing', bo.room.phase === 'playing')

      // --- netcode relay ---------------------------------------------------
      const hostIsAna = bo.room.hostId === ana.you.id
      const host = hostIsAna ? ana : bo
      const guest = hostIsAna ? bo : ana

      guest.send('mp', { kind: 'input', data: { up: true } })
      const input = await host.wait(
        (m) => m.type === 'mp' && m.kind === 'input' && m.data?.up === true,
        5000,
        'input relayed to host',
      )
      check('input from a guest reaches the host', input.from === guest.you.id)

      host.send('mp', { kind: 'state', data: { tick: 42 } })
      const state = await guest.wait(
        (m) => m.type === 'mp' && m.kind === 'state' && m.data?.tick === 42,
        5000,
        'state broadcast',
      )
      check('host state reaches the guests', !!state)

      guest.send('mp', { kind: 'state', data: { tick: 99 } })
      await sleep(400)
      const forged = host.messages.filter((m) => m.type === 'mp' && m.kind === 'state').length
      check('a guest cannot forge authoritative state', forged === 0, `host saw ${forged} state msgs`)

      // --- remix state machine ---------------------------------------------
      // The model call itself is the same path generation already proved; what
      // matters here is that a remix starts against the live game and that
      // cancelling puts the room back exactly where it was.
      const playingVersion = bo.room.game.version
      guest.send('remix', { text: 'make the arena bigger' })
      const remixing = await guest.wait(
        (m) => m.type === 'room' && m.room.phase === 'generating' && m.room.remixing,
        8000,
        'remix to start',
      )
      check('a remix starts against the running game', remixing.room.gen?.remix === 'make the arena bigger')

      guest.send('cancel')
      await sleep(600)
      check('cancelling a remix returns the room to play', bo.room.phase === 'playing')
      check('the running game survives a cancelled remix', bo.room.game?.version === playingVersion)

      // --- restart ----------------------------------------------------------
      guest.send('restart')
      const reset = await host.wait((m) => m.type === 'reset', 5000, 'reset')
      check('restart reseeds the round for everyone', typeof reset.seed === 'number')

      // --- publish + marketplace ------------------------------------------
      ana.send('save', { title: 'Smoke Test Racer', tagline: 'drawn tracks', tags: ['test'] })
      await ana.wait((m) => m.type === 'toast' && m.level === 'ok', 8000, 'publish confirmation')

      const { games } = await (await fetch(`${BASE}/api/games`)).json()
      check('published game appears in the marketplace', games.length === 1, `${games.length} games`)
      check('it credits both players', games[0]?.authors?.length === 2, games[0]?.authors?.join())
      check('list responses omit the source blob', games[0]?.html === undefined)

      const dl = await fetch(`${BASE}/api/games/${games[0].id}/download`)
      const bundle = await dl.text()
      check('download is served as an attachment', /attachment/.test(dl.headers.get('content-disposition') || ''))
      check('download bundles the solo shim', bundle.includes('Prompt Arcade solo shim'))
      check('download keeps the original game', bundle.includes('MP.ready'))

      // --- load from the marketplace into a room ---------------------------
      const { id: code2 } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()
      const cal = new Client('Cal')
      await cal.connect(code2)
      cal.send('load', { gameId: games[0].id })
      const loaded = await cal.wait((m) => m.type === 'game', 8000, 'loaded game')
      check('a marketplace game loads into a fresh room', loaded.game.title === 'Smoke Test Racer')
      cal.close()
    }

    // --- deadlocked vote ----------------------------------------------------
    // Two players, one vote each for their own pitch: no majority is reachable,
    // so the host's vote has to break it rather than the room hanging.
    {
      const { id: code2 } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()
      const dee = new Client('Dee')
      const eli = new Client('Eli')
      await dee.connect(code2)
      await eli.connect(code2)
      await sleep(300)

      dee.send('idea', { text: 'dee pitch: everyone is a magnet' })
      eli.send('idea', { text: 'eli pitch: the floor is lava' })
      await sleep(400)
      dee.send('open-vote')
      await eli.wait((m) => m.type === 'room' && m.room.phase === 'idea-vote', 6000, 'idea vote')

      const host = dee.room.hostId === dee.you.id ? dee : eli
      const other = host === dee ? eli : dee
      host.send('vote-idea', { ownerId: host.you.id })
      other.send('vote-idea', { ownerId: other.you.id })
      await sleep(600)

      check('a deadlocked vote still produces a winner', !!eli.room.ideaWinner, eli.room.ideaWinner)
      check(
        "the host's vote breaks the tie",
        eli.room.ideaWinner === host.you.id,
        `winner=${eli.room.ideaWinner} host=${host.you.id}`,
      )

      host.send('start-build')
      const settled = await eli.wait(
        (m) => m.type === 'room' && m.room.phase === 'generating',
        8000,
        'the host to build the tie-broken winner',
      )
      check(
        'the tie-broken pitch is what gets built',
        settled.room.brief.startsWith(host === dee ? 'dee pitch' : 'eli pitch'),
        settled.room.brief,
      )
      dee.send('cancel')
      await sleep(400)
      dee.close()
      eli.close()
    }

    // --- validator unit checks --------------------------------------------
    check(
      'validator rejects a game with no netcode',
      validateGame('<!doctype html><html><body><script>console.log(1)</script></body></html>'.padEnd(900, ' '))
        .length > 0,
    )
    check(
      'validator catches a syntax error',
      validateGame(
        `<!doctype html><html><head></head><body><script>function (){</script></body></html>`.padEnd(900, ' '),
      ).some((p) => p.includes('syntax error')),
    )
    check(
      'validator catches a fixed-size canvas with no resize handling',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c" width="800" height="600"></canvas><script>MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('hard-coded pixel size')),
    )
    check(
      'validator accepts a canvas that does handle resize',
      !validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas><script>function r(){c.width=innerWidth}addEventListener('resize',r);r();MP.me;MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('hard-coded pixel size')),
    )
    const MENU = `<script>addEventListener('keydown',e=>{if(e.key==='Escape')toggleMenu()});function toggleMenu(){}</script><div id="menu">controls</div>`
    check(
      'validator demands an in-game menu',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas><script>addEventListener('resize',()=>{});MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('no in-game menu')),
    )
    check(
      'validator rejects host-gated input',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});MP.me;if(MP.isHost){addEventListener('keydown',e=>{MP.sendInput({k:e.key})})}MP.ready();MP.on('state',()=>{});MP.setState({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('guests can never play')),
    )
    check(
      'validator rejects a per-player join step',
      validateGame(
        `<!doctype html><html><head></head><body><h1>Player 2 press start to join</h1><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});MP.me;MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('join individually')),
    )
    check(
      'validator accepts a shared lobby whose phase comes from state',
      !validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});let view=null;MP.on('state',s=>{view=s});function draw(){if(view.phase==='lobby'){}}MP.me;MP.ready();MP.setState({phase:'lobby'});MP.sendInput({start:true})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => /join|phase/.test(p)),
    )
    check(
      'validator rejects a locally decided phase',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});let phase='lobby';function start(){phase='playing'}MP.me;MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('decides for itself')),
    )
    check(
      'validator requires the game to know who you are',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});MP.ready();MP.on('state',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('never references MP.me')),
    )
    check(
      'single-player games are not held to the netcode rules',
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});MP.ready()</script></body></html>`.padEnd(
          900,
          ' ',
        ),
        { mode: 'single' },
      ).length === 0,
      validateGame(
        `<!doctype html><html><head></head><body><canvas id="c"></canvas>${MENU}<script>addEventListener('resize',()=>{});MP.ready()</script></body></html>`.padEnd(900, ' '),
        { mode: 'single' },
      ).join('; '),
    )
    check(
      'validator blocks external resources',
      validateGame(
        `<!doctype html><html><head><script src="https://cdn.example.com/x.js"></script></head><body><script>MP.ready();MP.on('x',()=>{});MP.setState({});MP.sendInput({})</script></body></html>`.padEnd(
          900,
          ' ',
        ),
      ).some((p) => p.includes('external resource')),
    )

    ana.close()
    bo.close()
  } finally {
    server.kill('SIGKILL')
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err)
  process.exit(1)
})

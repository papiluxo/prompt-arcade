/* Prompt Arcade server — HTTP API, static hosting, and the WebSocket rooms. */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

import { handleConnection, createRoom, getRoom, roomStats, restoreRooms } from './rooms.mjs'
import { MODELS, backendInfo } from './generate.mjs'
import { listGames, getGame, lineage, bundleStandalone, recordPlay } from './library.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const PROD = process.env.NODE_ENV === 'production'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const standaloneShim = await readFile(join(ROOT, 'shared', 'mp-standalone.js'), 'utf8')
const arcadeKit = await readFile(join(ROOT, 'shared', 'arcade-kit.js'), 'utf8')
// A downloaded game needs the same floor it stood on in the arcade.
const standaloneRuntime = `${standaloneShim}\n${arcadeKit}`

/* Libraries a generated game may use. Too big to bundle into the client, so
 * they are fetched on demand and inlined into the game's sandbox. */
const LIBS = { three: join(ROOT, 'shared', 'lib', 'three.min.js') }
const libCache = new Map()

export async function readLib(name) {
  if (!LIBS[name]) return null
  if (!libCache.has(name)) libCache.set(name, await readFile(LIBS[name], 'utf8'))
  return libCache.get(name)
}

/** Which vendored libraries does this game actually need? */
export function libsFor(html) {
  return /\bTHREE\s*\./.test(html) ? ['three'] : []
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function serveStatic(req, res, pathname) {
  if (!PROD) {
    json(res, 404, { error: 'Static assets are served by Vite in dev (npm run dev).' })
    return
  }
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html') // SPA fallback
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
  } catch {
    json(res, 404, { error: 'Not found' })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  try {
    if (path === '/api/health') {
      return json(res, 200, { ok: true, ...roomStats(), generation: backendInfo() })
    }

    const libMatch = path.match(/^\/api\/lib\/(\w+)$/)
    if (libMatch) {
      const source = await readLib(libMatch[1])
      if (!source) return json(res, 404, { error: 'No such library' })
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      })
      return res.end(source)
    }

    if (path === '/api/models') {
      return json(res, 200, { models: MODELS, generation: backendInfo() })
    }

    if (path === '/api/rooms' && req.method === 'POST') {
      const room = createRoom()
      return json(res, 200, { id: room.id })
    }

    if (path.startsWith('/api/rooms/')) {
      const room = getRoom(path.split('/')[3])
      return json(res, room ? 200 : 404, room ? { id: room.id, exists: true } : { exists: false })
    }

    if (path === '/api/games') {
      const games = await listGames({
        sort: url.searchParams.get('sort') || 'recent',
        q: url.searchParams.get('q') || '',
      })
      return json(res, 200, { games })
    }

    const gameMatch = path.match(/^\/api\/games\/([\w-]+)(\/(source|download|play))?$/)
    if (gameMatch) {
      const rec = await getGame(gameMatch[1])
      if (!rec) return json(res, 404, { error: 'No such game' })
      const action = gameMatch[3]

      if (action === 'download') {
        // A downloaded game must still run with no network, so anything it
        // depends on travels with it.
        const libs = []
        for (const name of libsFor(rec.html)) libs.push(await readLib(name))
        const html = bundleStandalone(rec, standaloneRuntime, libs)
        const filename = `${rec.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-') || 'game'}.html`
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
        })
        return res.end(html)
      }

      if (action === 'play') {
        await recordPlay(rec.id)
        return json(res, 200, { ok: true })
      }

      if (action === 'source') return json(res, 200, { id: rec.id, html: rec.html })

      const { html, ...meta } = rec
      return json(res, 200, { game: { ...meta, bytes: html.length }, lineage: await lineage(rec.id) })
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' })

    return serveStatic(req, res, path)
  } catch (err) {
    return json(res, 500, { error: err.message })
  }
})

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 })
wss.on('connection', handleConnection)

// Drop sockets that stop answering pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000)
heartbeat.unref()
wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })
})

/* One bad handler must never take the arcade down mid-session. Log it, keep
 * serving; rooms snapshot to disk, so even a hard crash is survivable. */
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason)
})

const restored = await restoreRooms()
if (restored) console.log(`restored ${restored} room${restored === 1 ? '' : 's'} from disk`)

server.listen(PORT, () => {
  const gen = backendInfo()
  console.log(`prompt-arcade server  http://localhost:${PORT}  [${PROD ? 'prod' : 'dev'}]`)
  console.log(`generation: ${gen.backend} — ${gen.note}${gen.ready ? '' : '  (NOT READY)'}`)
})

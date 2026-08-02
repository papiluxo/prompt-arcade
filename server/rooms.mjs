/* Rooms: presence, chat, the collective prompt, generation orchestration,
 * in-game netcode relay and WebRTC voice signalling.
 *
 * The server is deliberately dumb about gameplay. It relays input to the host
 * and state to everyone else; the game itself decides what any of it means.
 */

import { randomUUID } from 'node:crypto'
import { generateGame, MODELS, DEFAULT_MODEL } from './generate.mjs'
import { saveGame, getGame, recordPlay } from './library.mjs'

const COLORS = [
  '#8ce99a',
  '#74c0fc',
  '#ffa8a8',
  '#ffd43b',
  '#e599f7',
  '#63e6be',
  '#ffa94d',
  '#a5d8ff',
]

const ROOM_TTL_MS = 6 * 60 * 60 * 1000 // empty rooms are collected after 6h
const MAX_CHAT = 200

/** @type {Map<string, Room>} */
const rooms = new Map()

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code
  do {
    code = Array.from({ length: 4 }, () => alphabet[(Math.random() * alphabet.length) | 0]).join('')
  } while (rooms.has(code))
  return code
}

export function createRoom() {
  const id = newRoomCode()
  const room = {
    id,
    createdAt: Date.now(),
    emptySince: Date.now(),
    seed: (Math.random() * 1e9) | 0,
    players: new Map(),
    hostId: null,
    phase: 'lobby', // lobby | generating | voting | playing
    ideas: new Map(), // playerId -> text
    ideaVotes: new Map(), // voterId -> pitch ownerId
    ideaWinner: null, // ownerId once the vote is beyond doubt
    models: [DEFAULT_MODEL],
    scope: 'quick', // quick | deep — deep designs first, then implements
    mode: 'multi', // multi | single — single gives every player their own copy
    brief: '',
    briefSource: 'ideas',
    gen: null, // { startedAt, abort, byModel: {id: {...}} }
    variants: [], // { id, modelId, title, html, problems, ms, repaired }
    votes: new Map(), // playerId -> variantId
    game: null, // { title, html, modelId, brief, libraryId, savedAs }
    chat: [],
    runtimeErrors: [],
    remixing: false,
  }
  rooms.set(id, room)
  return room
}

export function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) || null
}

export function roomStats() {
  return {
    rooms: rooms.size,
    players: [...rooms.values()].reduce(
      (n, r) => n + [...r.players.values()].filter((p) => p.connected).length,
      0,
    ),
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [id, room] of rooms) {
    const live = [...room.players.values()].some((p) => p.connected)
    if (live) {
      room.emptySince = 0
    } else {
      if (!room.emptySince) room.emptySince = now
      if (now - room.emptySince > ROOM_TTL_MS) {
        room.gen?.abort?.abort()
        rooms.delete(id)
      }
    }
  }
}, 60_000).unref()

// ------------------------------------------------------------------ messaging

function send(ws, type, payload = {}) {
  if (ws?.readyState === 1) {
    try {
      ws.send(JSON.stringify({ type, ...payload }))
    } catch {
      /* socket died mid-write */
    }
  }
}

function broadcast(room, type, payload = {}, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue
    send(p.ws, type, payload)
  }
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected)
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    index: p.index,
    connected: p.connected,
    isHost: p.isHost,
    voice: p.voice,
    idea: '',
  }
}

/** Lean snapshot — game and variant sources travel separately. */
function snapshot(room) {
  const players = [...room.players.values()]
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ ...publicPlayer(p), idea: room.ideas.get(p.id) || '' }))
  return {
    id: room.id,
    phase: room.phase,
    seed: room.seed,
    hostId: room.hostId,
    models: room.models,
    scope: room.scope,
    mode: room.mode,
    brief: room.brief,
    briefSource: room.briefSource,
    players,
    votes: Object.fromEntries(room.votes),
    ideaVotes: Object.fromEntries(room.ideaVotes),
    ideaWinner: room.ideaWinner,
    majority: majorityOf(connectedPlayers(room).length),
    remixing: room.remixing,
    gen: room.gen
      ? {
          startedAt: room.gen.startedAt,
          byModel: room.gen.byModel,
          remix: room.gen.remix,
          stage: room.gen.stage,
        }
      : null,
    variants: room.variants.map(({ html, ...v }) => ({ ...v, bytes: html.length })),
    game: room.game
      ? {
          title: room.game.title,
          modelId: room.game.modelId,
          brief: room.game.brief,
          libraryId: room.game.libraryId || null,
          savedAs: room.game.savedAs || null,
          bytes: room.game.html.length,
          version: room.game.version,
          mode: room.game.mode || 'multi',
        }
      : null,
    runtimeErrors: room.runtimeErrors.slice(-6),
  }
}

function pushState(room) {
  broadcast(room, 'room', { room: snapshot(room) })
}

function systemChat(room, text) {
  const msg = { id: randomUUID().slice(0, 8), kind: 'system', text, ts: Date.now() }
  room.chat.push(msg)
  if (room.chat.length > MAX_CHAT) room.chat.shift()
  broadcast(room, 'chat', { message: msg })
}

function electHost(room) {
  const current = room.hostId ? room.players.get(room.hostId) : null
  if (current?.connected) return
  const hadHost = !!room.hostId
  const next = connectedPlayers(room).sort((a, b) => a.index - b.index)[0]
  for (const p of room.players.values()) p.isHost = false
  room.hostId = next?.id || null
  if (next) {
    next.isHost = true
    // The roster already badges the host; only announce an actual handover.
    if (hadHost) systemChat(room, `${next.name} is now the host (runs the game simulation).`)
  }
}

// --------------------------------------------------------------- join / leave

export function handleConnection(ws, req) {
  let room = null
  let player = null

  const url = new URL(req.url, 'http://localhost')
  const wantRoom = url.searchParams.get('room')

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'hello') {
      const joined = join(ws, msg, wantRoom)
      if (!joined) {
        send(ws, 'fatal', { message: 'That room code does not exist.' })
        ws.close()
        return
      }
      room = joined.room
      player = joined.player
      return
    }
    if (!room || !player) return
    try {
      await handleMessage(room, player, msg)
    } catch (err) {
      send(player.ws, 'toast', { level: 'error', text: err.message })
    }
  })

  ws.on('close', () => {
    if (!room || !player) return
    player.connected = false
    player.ws = null
    player.voice = false
    electHost(room)
    broadcast(room, 'rtc-leave', { from: player.id })
    systemChat(room, `${player.name} left.`)
    pushState(room)
    // One fewer player means a lower majority — the result may already be in.
    if (room.phase === 'idea-vote') {
      updateIdeaWinner(room)
      pushState(room)
    }
  })

  ws.on('error', () => {})
}

function join(ws, msg, wantRoom) {
  const code = String(msg.roomId || wantRoom || '').toUpperCase()
  const room = code ? rooms.get(code) : createRoom()
  if (!room) return null

  const name = String(msg.name || '').trim().slice(0, 24) || 'Player'
  let player = msg.playerId ? room.players.get(msg.playerId) : null

  if (player) {
    player.name = name
    player.connected = true
    player.ws = ws
  } else {
    const index = room.players.size
    player = {
      id: randomUUID().slice(0, 12),
      name,
      color: COLORS[index % COLORS.length],
      index,
      connected: true,
      isHost: false,
      voice: false,
      ws,
    }
    room.players.set(player.id, player)
  }

  electHost(room)
  room.emptySince = 0

  send(ws, 'hello', {
    you: publicPlayer(player),
    room: snapshot(room),
    chat: room.chat.slice(-60),
    models: MODELS,
  })
  if (room.variants.length) send(ws, 'variants', { variants: room.variants })
  if (room.game) send(ws, 'game', { game: gamePayload(room) })

  systemChat(room, `${player.name} joined.`)
  pushState(room)
  broadcast(room, 'rtc-join', { from: player.id }, player.id)
  return { room, player }
}

function gamePayload(room) {
  return {
    title: room.game.title,
    html: room.game.html,
    modelId: room.game.modelId,
    mode: room.game.mode || 'multi',
    brief: room.game.brief,
    libraryId: room.game.libraryId || null,
    seed: room.seed,
    version: room.game.version,
  }
}

// ------------------------------------------------------------- message router

async function handleMessage(room, player, msg) {
  switch (msg.type) {
    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 500)
      if (!text) return
      const message = {
        id: randomUUID().slice(0, 8),
        kind: 'chat',
        from: player.id,
        name: player.name,
        color: player.color,
        text,
        ts: Date.now(),
      }
      room.chat.push(message)
      if (room.chat.length > MAX_CHAT) room.chat.shift()
      broadcast(room, 'chat', { message })
      return
    }

    case 'rename': {
      const name = String(msg.name || '').trim().slice(0, 24)
      if (!name) return
      player.name = name
      pushState(room)
      return
    }

    case 'idea': {
      const text = String(msg.text || '').slice(0, 400)
      if (text.trim()) room.ideas.set(player.id, text)
      else room.ideas.delete(player.id)
      room.briefSource = 'ideas'
      pushState(room)
      return
    }

    case 'brief': {
      room.brief = String(msg.text || '').slice(0, 4000)
      room.briefSource = 'manual'
      pushState(room)
      return
    }

    case 'models': {
      const ids = (Array.isArray(msg.ids) ? msg.ids : [])
        .filter((id) => MODELS.some((m) => m.id === id))
        .slice(0, 4)
      room.models = ids.length ? ids : [DEFAULT_MODEL]
      pushState(room)
      return
    }

    case 'scope': {
      room.scope = msg.scope === 'deep' ? 'deep' : 'quick'
      pushState(room)
      return
    }

    case 'mode': {
      if (player.id !== room.hostId) throw new Error('Only the host can change the mode.')
      room.mode = msg.mode === 'single' ? 'single' : 'multi'
      systemChat(room, `${player.name} set the next build to ${room.mode === 'single' ? 'single player' : 'multiplayer'}.`)
      pushState(room)
      return
    }

    /* Pitching never starts a build. It only ever opens the vote — even for a
     * single pitch — so nobody can kick off a build by hitting Enter. */
    case 'open-vote': {
      if (room.phase !== 'lobby') return
      if (!livePitches(room).length) throw new Error('Someone needs to pitch an idea first.')
      startIdeaVote(room, player)
      return
    }

    case 'vote-idea': {
      if (room.phase !== 'idea-vote') return
      if (!room.ideas.has(msg.ownerId)) return
      room.ideaVotes.set(player.id, msg.ownerId)
      updateIdeaWinner(room)
      pushState(room)
      return
    }

    /* The only door to the model, and only the host holds the key. */
    case 'start-build': {
      if (room.phase !== 'idea-vote') return
      if (player.id !== room.hostId) throw new Error('Only the host can start the build.')
      const pitches = livePitches(room)
      if (!pitches.length) throw new Error('There are no pitches left to build.')

      const { winner, reason } = resolveIdeaVote(room)
      room.brief = winner.text
      room.briefSource = 'vote'
      systemChat(room, `${player.name} started the build — ${winner.name}'s idea, ${reason}.`)
      await startGeneration(room, player, { request: null })
      return
    }

    case 'remix': {
      const request = String(msg.text || '').trim().slice(0, 1000)
      if (!request) throw new Error('Describe the change you want first.')
      if (!room.game) throw new Error('There is no game to remix yet.')
      await startGeneration(room, player, { request, modelId: msg.modelId })
      return
    }

    case 'cancel': {
      if (!room.gen) return
      room.gen.abort.abort()
      room.gen = null
      room.phase = room.game ? 'playing' : 'lobby'
      room.remixing = false
      systemChat(room, `${player.name} cancelled generation.`)
      pushState(room)
      return
    }

    case 'vote': {
      if (room.phase !== 'voting') return
      const variant = room.variants.find((v) => v.id === msg.variantId)
      if (!variant) return
      room.votes.set(player.id, variant.id)
      pushState(room)
      maybeSettleVote(room)
      return
    }

    case 'commit': {
      const variant = room.variants.find((v) => v.id === msg.variantId)
      if (!variant) return
      commitVariant(room, variant, `${player.name} locked it in`)
      return
    }

    case 'restart': {
      if (!room.game) return
      room.seed = (Math.random() * 1e9) | 0
      broadcast(room, 'reset', { seed: room.seed })
      systemChat(room, `${player.name} restarted the round.`)
      return
    }

    case 'lobby': {
      room.phase = 'lobby'
      room.variants = []
      room.votes.clear()
      room.ideaVotes.clear()
      room.ideaWinner = null
      // Drop the finished game, otherwise the next unrelated build inherits its
      // libraryId and gets published as a fork of it.
      room.game = null
      room.runtimeErrors = []
      pushState(room)
      return
    }

    case 'save': {
      if (!room.game) throw new Error('Nothing to publish yet.')
      const rec = await saveGame({
        title: String(msg.title || room.game.title).slice(0, 80),
        tagline: String(msg.tagline || '').slice(0, 160),
        brief: room.game.brief,
        html: room.game.html,
        modelId: room.game.modelId,
        mode: room.game.mode || 'multi',
        authors: [...new Set([...room.players.values()].map((p) => p.name))],
        tags: Array.isArray(msg.tags) ? msg.tags.map(String).slice(0, 8) : [],
        parentId: room.game.libraryId || null,
      })
      room.game.savedAs = rec.id
      room.game.libraryId = rec.id
      systemChat(room, `${player.name} published "${rec.title}" to the marketplace.`)
      broadcast(room, 'toast', { level: 'ok', text: `Published "${rec.title}"` })
      pushState(room)
      return
    }

    case 'load': {
      const rec = await getGame(msg.gameId)
      if (!rec) throw new Error('That game is not in the library.')
      room.game = {
        title: rec.title,
        html: rec.html,
        modelId: rec.modelId,
        mode: rec.mode || 'multi',
        brief: rec.brief,
        libraryId: rec.id,
        version: 1,
      }
      room.brief = rec.brief || room.brief
      room.phase = 'playing'
      room.variants = []
      room.votes.clear()
      room.runtimeErrors = []
      room.seed = (Math.random() * 1e9) | 0
      await recordPlay(rec.id)
      systemChat(room, `${player.name} loaded "${rec.title}" from the marketplace.`)
      broadcast(room, 'game', { game: gamePayload(room) })
      pushState(room)
      return
    }

    // ---- in-game netcode relay -------------------------------------------
    case 'mp': {
      if (msg.kind === 'input') {
        const host = room.hostId ? room.players.get(room.hostId) : null
        if (host && host.id !== player.id) {
          send(host.ws, 'mp', { kind: 'input', data: msg.data, from: player.id })
        }
      } else if (msg.kind === 'state') {
        if (player.id !== room.hostId) return // only the host is authoritative
        broadcast(room, 'mp', { kind: 'state', data: msg.data, from: player.id }, player.id)
      } else if (msg.kind === 'event') {
        broadcast(
          room,
          'mp',
          { kind: 'event', eventType: msg.eventType, data: msg.data, from: player.id },
          player.id,
        )
      }
      return
    }

    case 'game-error': {
      const entry = {
        message: String(msg.message || '').slice(0, 400),
        stack: String(msg.stack || '').slice(0, 1200),
        where: String(msg.where || '').slice(0, 60),
        from: player.name,
        ts: Date.now(),
      }
      const dup = room.runtimeErrors.some((e) => e.message === entry.message)
      room.runtimeErrors.push(entry)
      if (room.runtimeErrors.length > 20) room.runtimeErrors.shift()
      if (!dup) pushState(room)
      return
    }

    // ---- voice ------------------------------------------------------------
    case 'voice': {
      player.voice = !!msg.on
      pushState(room)
      return
    }

    case 'rtc': {
      const target = room.players.get(msg.to)
      if (target?.connected) send(target.ws, 'rtc', { from: player.id, signal: msg.signal })
      return
    }
  }
}

// ------------------------------------------------------------- the idea vote

/** Pitches from players who are actually still here. */
function livePitches(room) {
  return [...room.ideas.entries()]
    .filter(([pid, text]) => text.trim() && room.players.get(pid)?.connected)
    .map(([pid, text]) => ({ ownerId: pid, name: room.players.get(pid).name, text }))
}

/** Votes needed to win outright: a simple majority of everyone in the room. */
export function majorityOf(playerCount) {
  return Math.floor(playerCount / 2) + 1
}

function startIdeaVote(room, player) {
  room.phase = 'idea-vote'
  room.ideaVotes = new Map()
  room.ideaWinner = null
  // No threshold in the message — players join and leave, and the live count on
  // the vote screen would immediately contradict it.
  systemChat(room, `${player.name} put the ideas to a vote.`)
  pushState(room)
}

/**
 * Who is winning, and is the result already beyond doubt?
 *
 * `decided` means the outcome cannot change: a pitch holds a majority, or the
 * votes still outstanding can't close the gap, or everyone has voted. It never
 * starts anything — the host does that.
 */
function resolveIdeaVote(room) {
  const voters = connectedPlayers(room)
  const pitches = livePitches(room)
  if (!pitches.length) return { winner: null, reason: '', decided: false }

  const tally = new Map(pitches.map((p) => [p.ownerId, 0]))
  for (const [voterId, ownerId] of room.ideaVotes) {
    if (room.players.get(voterId)?.connected && tally.has(ownerId)) {
      tally.set(ownerId, tally.get(ownerId) + 1)
    }
  }

  const need = majorityOf(voters.length)
  const cast = [...room.ideaVotes.keys()].filter((id) => room.players.get(id)?.connected).length
  const outstanding = voters.length - cast

  const ranked = pitches
    .map((p) => ({ ...p, votes: tally.get(p.ownerId) || 0 }))
    .sort((a, b) => b.votes - a.votes)
  const [leader, runnerUp] = ranked

  const hasMajority = leader.votes >= need
  const uncatchable = runnerUp ? leader.votes > runnerUp.votes + outstanding : outstanding === 0
  const everyoneVoted = outstanding === 0
  const tied = runnerUp && leader.votes === runnerUp.votes

  if (tied) {
    // Deadlock: the host's vote breaks it, else the pitch that landed first.
    const level = ranked.filter((p) => p.votes === leader.votes)
    const hostPick = room.ideaVotes.get(room.hostId)
    const hostChoice = level.find((p) => p.ownerId === hostPick)
    const winner = hostChoice || level[0]
    return {
      winner,
      reason:
        leader.votes === 0
          ? 'no votes cast'
          : hostChoice
            ? `tied ${leader.votes}-${runnerUp.votes}, host's vote breaks it`
            : `tied ${leader.votes}-${runnerUp.votes}, oldest pitch takes it`,
      decided: everyoneVoted && leader.votes > 0,
    }
  }

  return {
    winner: leader,
    reason: `${leader.votes} of ${voters.length}`,
    decided: (hasMajority || uncatchable || everyoneVoted) && leader.votes > 0,
  }
}

/** Track the standing winner so the room can see it land, without building. */
function updateIdeaWinner(room) {
  if (room.phase !== 'idea-vote') return
  const { winner, reason, decided } = resolveIdeaVote(room)
  const next = decided && winner ? winner.ownerId : null
  if (next !== room.ideaWinner) {
    room.ideaWinner = next
    if (next) systemChat(room, `${winner.name}'s idea takes it — ${reason}. Host can start the build.`)
  }
}

// ------------------------------------------------------------ generation flow

async function startGeneration(room, player, { request, modelId }) {
  if (room.gen) throw new Error('A generation is already running.')

  const isRemix = !!request
  const models = isRemix ? [modelId || room.game.modelId || DEFAULT_MODEL] : room.models

  // By this point the brief is settled — either hand-written, the only pitch,
  // or whatever the room just voted for.
  if (!isRemix && !room.brief.trim()) throw new Error('There is no idea to build yet.')

  const abort = new AbortController()
  room.gen = {
    startedAt: Date.now(),
    abort,
    remix: isRemix ? request : null,
    stage: 'building',
    byModel: Object.fromEntries(
      models.map((id) => [id, { status: 'queued', chars: 0, phase: 'queued', preview: '' }]),
    ),
  }
  room.phase = 'generating'
  room.remixing = isRemix
  room.variants = []
  room.votes.clear()
  if (!isRemix) room.runtimeErrors = []
  pushState(room)

  try {
    if (isRemix) systemChat(room, `${player.name} asked for a change: "${request}"`)
    else systemChat(room, `Building it now.`)

    const players = connectedPlayers(room).map((p) => ({ name: p.name, color: p.color }))
    const results = await Promise.allSettled(
      models.map((id) =>
        runOne(room, {
          modelId: id,
          brief: room.brief,
          players,
          request,
          baseHtml: isRemix ? room.game.html : null,
          scope: room.scope,
          mode: isRemix ? room.game.mode || 'multi' : room.mode,
          signal: abort.signal,
        }),
      ),
    )

    if (abort.signal.aborted) return

    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    const failed = results.filter((r) => r.status === 'rejected')
    for (const f of failed) systemChat(room, `A model failed: ${f.reason?.message || 'unknown error'}`)

    room.gen = null
    room.remixing = false

    if (!ok.length) {
      room.phase = room.game ? 'playing' : 'lobby'
      broadcast(room, 'toast', { level: 'error', text: 'Every model failed. Try again.' })
      pushState(room)
      return
    }

    room.variants = ok
    broadcast(room, 'variants', { variants: room.variants })

    if (ok.length === 1) {
      commitVariant(room, ok[0], isRemix ? 'Remix applied' : 'Game ready')
    } else {
      room.phase = 'voting'
      systemChat(room, `${ok.length} versions are in. Try them and vote.`)
      pushState(room)
    }
  } catch (err) {
    room.gen = null
    room.remixing = false
    room.phase = room.game ? 'playing' : 'lobby'
    if (!abort.signal.aborted) {
      systemChat(room, `Generation failed: ${err.message}`)
      broadcast(room, 'toast', { level: 'error', text: err.message })
    }
    pushState(room)
  }
}

async function runOne(room, opts) {
  const slot = room.gen.byModel[opts.modelId]
  slot.status = 'running'
  slot.phase = 'writing'
  pushState(room)

  let lastPush = 0
  const result = await generateGame({
    ...opts,
    onProgress: ({ phase, chars, preview }) => {
      if (!room.gen) return
      slot.phase = phase
      slot.chars = chars
      slot.preview = preview
      const now = Date.now()
      if (now - lastPush > 400) {
        lastPush = now
        pushState(room)
      }
    },
  })

  slot.status = 'done'
  slot.phase = 'done'
  slot.ms = result.ms
  pushState(room)

  return {
    id: randomUUID().slice(0, 8),
    modelId: result.modelId,
    title: result.title,
    html: result.html,
    mode: result.mode,
    problems: result.problems,
    repaired: result.repaired,
    ms: result.ms,
  }
}

function maybeSettleVote(room) {
  const voters = connectedPlayers(room)
  if (!voters.length) return
  const cast = voters.filter((p) => room.votes.has(p.id))
  if (cast.length < voters.length) return

  const tally = new Map()
  for (const vid of room.votes.values()) tally.set(vid, (tally.get(vid) || 0) + 1)
  let best = null
  let bestCount = -1
  for (const v of room.variants) {
    const n = tally.get(v.id) || 0
    if (n > bestCount) {
      best = v
      bestCount = n
    }
  }
  if (best) commitVariant(room, best, `the room voted ${bestCount}-${voters.length - bestCount}`)
}

function commitVariant(room, variant, reason) {
  const previousVersion = room.game?.version || 0
  room.game = {
    title: variant.title,
    html: variant.html,
    modelId: variant.modelId,
    mode: variant.mode || 'multi',
    brief: room.brief,
    libraryId: room.game?.libraryId || null,
    savedAs: null,
    version: previousVersion + 1,
  }
  room.phase = 'playing'
  room.variants = []
  room.votes.clear()
  room.runtimeErrors = []
  room.seed = (Math.random() * 1e9) | 0
  systemChat(room, `Playing "${variant.title}" — ${reason}.`)
  broadcast(room, 'game', { game: gamePayload(room) })
  pushState(room)
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../App'
import { GameFrame } from '../GameFrame'
import { Stage } from '../Stage'
import {
  arcade,
  diag,
  displayName,
  setDisplayName,
  useArcade,
  type ChatMessage,
  type ModelInfo,
  type Player,
  type RoomState,
  type Variant,
} from '../net'
import { useVoice, voice } from '../voice'

export function Room({ code }: { code: string }) {
  const state = useArcade()
  const { you, room, fatal, status } = state
  const [name, setName] = useState(displayName())
  const [joined, setJoined] = useState(!!displayName())

  useEffect(() => {
    if (!joined) return
    arcade.connect(code, name.trim() || 'Player')
    return () => arcade.leave()
  }, [code, joined])

  useEffect(() => {
    if (room && you) voice.sync(room.players, you.id)
  }, [room?.players.map((p) => `${p.id}:${p.voice}:${p.connected}`).join('|'), you?.id])

  // Arriving from the marketplace with ?load=<gameId> drops that game straight in.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current || !room || !you) return
    const wanted = new URLSearchParams(location.search).get('load')
    if (!wanted) return
    loadedRef.current = true
    arcade.send('load', { gameId: wanted })
    history.replaceState({}, '', location.pathname)
  }, [!!room, !!you])

  if (!joined) {
    return (
      <div className="gate">
        <h1 className="wordmark wordmark-sm">Prompt Arcade</h1>
        <p className="mono eyebrow">joining room {code}</p>
        <form
          className="deck"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            setDisplayName(name.trim())
            setJoined(true)
          }}
        >
          <label className="mono label" htmlFor="gate-name">
            Your name
          </label>
          <input
            id="gate-name"
            className="input"
            autoFocus
            maxLength={24}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Who's playing?"
          />
          <button className="btn btn-primary" type="submit">
            Join room
          </button>
        </form>
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="gate">
        <h1 className="wordmark wordmark-sm">Prompt Arcade</h1>
        <p className="error mono">{fatal}</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>
          Back to the front
        </button>
      </div>
    )
  }

  if (!room || !you) {
    return (
      <div className="gate">
        <p className="mono blink phosphor">CONNECTING</p>
      </div>
    )
  }

  return <Cabinet state={state} room={room} you={you} connected={status === 'open'} />
}

// ---------------------------------------------------------------- the cabinet

function Cabinet({
  state,
  room,
  you,
  connected,
}: {
  state: ReturnType<typeof useArcade>
  room: RoomState
  you: Player
  connected: boolean
}) {
  const { chat, models, game, variants } = state
  const [publishing, setPublishing] = useState(false)

  return (
    <div className="cabinet">
      <TopBar room={room} you={you} connected={connected} />

      <div className="cabinet-body">
        <section className="stage">
          {room.phase === 'lobby' && <Lobby room={room} you={you} />}
          {room.phase === 'idea-vote' && <IdeaVote room={room} you={you} />}
          {room.phase === 'generating' && <BuildStream room={room} models={models} />}
          {room.phase === 'voting' && <VariantPicker room={room} you={you} variants={variants} />}
          {room.phase === 'playing' && game && (
            <div className="screen screen-game">
              <Stage
                room={room}
                you={you}
                chat={chat}
                html={game.html}
                version={`${game.version}:${game.libraryId ?? 'live'}`}
                title={game.title}
                solo={game.mode === 'single'}
              />
            </div>
          )}
          {room.phase === 'playing' && !game && (
            <div className="screen empty">
              <p className="mono blink phosphor">LOADING GAME</p>
            </div>
          )}
        </section>

        <Rail room={room} you={you} chat={chat} />
      </div>

      <ControlDeck
        room={room}
        you={you}
        models={models}
        onPublish={() => setPublishing(true)}
        hasGame={!!game}
      />

      {publishing && game && (
        <PublishDialog
          defaultTitle={game.title}
          onClose={() => setPublishing(false)}
          onSubmit={(payload) => {
            arcade.send('save', payload)
            setPublishing(false)
          }}
        />
      )}
    </div>
  )
}

function TopBar({ room, you, connected }: { room: RoomState; you: Player; connected: boolean }) {
  const v = useVoice()
  const [copied, setCopied] = useState(false)
  const live = room.players.filter((p) => p.connected)

  return (
    <header className="topbar">
      <button className="wordmark wordmark-xs" onClick={() => navigate('/')}>
        Prompt Arcade
      </button>

      <button
        className="room-code mono"
        title="Copy the invite link"
        onClick={async () => {
          await navigator.clipboard?.writeText(location.href)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }}
      >
        {copied ? 'link copied' : room.id}
      </button>

      <div className="topbar-players">
        {live.map((p) => (
          <span
            key={p.id}
            className="dot"
            style={{
              background: p.color,
              boxShadow: v.levels[p.id] > 0.15 ? `0 0 0 3px ${p.color}55` : undefined,
            }}
            title={p.name}
          />
        ))}
        <span className="mono dim">{live.length} in the room</span>
      </div>

      <div className="topbar-actions">
        <button
          className={`btn btn-sm ${v.enabled ? 'btn-live' : ''}`}
          onClick={() => voice.toggle(you.id)}
          title={v.enabled ? 'Leave voice' : 'Join voice chat'}
        >
          {v.enabled ? '● voice on' : 'voice'}
        </button>
        {v.enabled && (
          <button className="btn btn-sm" onClick={() => voice.setMuted(!v.muted)}>
            {v.muted ? 'unmute' : 'mute'}
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => navigate('/market')}>
          marketplace
        </button>
        {!connected && <span className="mono error">reconnecting…</span>}
      </div>
      {v.error && <p className="error mono topbar-error">{v.error}</p>}
    </header>
  )
}

// -------------------------------------------------------------------- stage

function Lobby({ room, you }: { room: RoomState; you: Player }) {
  const pitched = room.players.filter((p) => p.idea.trim())

  return (
    <div className="screen lobby">
      <div className="scanlines" aria-hidden />
      <div className="lobby-inner">
        <p className="mono eyebrow phosphor-dim">what are we playing?</p>

        {pitched.length === 0 ? (
          <div className="lobby-empty">
            <p className="lobby-empty-line phosphor">Nobody's pitched yet.</p>
            <p className="dim">
              Everyone drops one idea below. They get merged into a single brief, so the game belongs
              to the whole room.
            </p>
          </div>
        ) : (
          <ul className="pitches">
            {pitched.map((p) => (
              <li key={p.id} className="pitch" style={{ borderColor: `${p.color}66` }}>
                <span className="mono pitch-who" style={{ color: p.color }}>
                  {p.name}
                  {p.id === you.id ? ' (you)' : ''}
                </span>
                <p>{p.idea}</p>
              </li>
            ))}
          </ul>
        )}

        {room.brief && room.briefSource === 'manual' && (
          <div className="brief-box">
            <p className="mono label">Brief</p>
            <p>{room.brief}</p>
          </div>
        )}

        <p className="mono dim lobby-count">
          {pitched.length} of {room.players.filter((p) => p.connected).length} pitched
        </p>
      </div>
    </div>
  )
}

/** The room picks one pitch. First to a majority takes it. */
function IdeaVote({ room, you }: { room: RoomState; you: Player }) {
  const live = room.players.filter((p) => p.connected)
  const pitches = live.filter((p) => p.idea.trim())
  const myVote = room.ideaVotes[you.id]

  const tally: Record<string, number> = {}
  for (const ownerId of Object.values(room.ideaVotes)) {
    tally[ownerId] = (tally[ownerId] || 0) + 1
  }
  const cast = Object.keys(room.ideaVotes).length
  const leader = Math.max(0, ...pitches.map((p) => tally[p.id] || 0))

  return (
    <div className="screen vote">
      <div className="scanlines" aria-hidden />
      <div className="vote-inner">
        <div className="idea-vote-head">
          <p className="mono eyebrow phosphor-dim">which one are we building?</p>
          <p className="mono dim">
            {room.majority} of {live.length} wins it · {cast} voted
          </p>
        </div>

        <ul className="idea-grid">
          {pitches.map((p) => {
            const votes = tally[p.id] || 0
            const mine = myVote === p.id
            return (
              <li key={p.id}>
                <button
                  className={`idea-card ${mine ? 'is-mine' : ''} ${
                    votes === leader && votes > 0 ? 'is-leading' : ''
                  } ${room.ideaWinner === p.id ? 'is-winner' : ''}`}
                  style={{ borderLeftColor: p.color }}
                  onClick={() => arcade.send('vote-idea', { ownerId: p.id })}
                >
                  <span className="mono idea-who" style={{ color: p.color }}>
                    {p.name}
                    {p.id === you.id ? ' (you)' : ''}
                  </span>
                  <p className="idea-text">{p.idea}</p>
                  <div className="idea-meter" aria-hidden>
                    <span style={{ width: `${(votes / Math.max(1, room.majority)) * 100}%` }} />
                  </div>
                  <span className="mono idea-count">
                    {room.ideaWinner === p.id ? `winner · ${votes}` : `${votes} / ${room.majority}`}
                    {mine ? ' · your vote' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <p className="mono dim">
          {room.ideaWinner
            ? 'Locked in. The host starts the build — you can still change your vote until then.'
            : myVote
              ? 'Change your vote any time.'
              : 'Pick the one you want to play.'}
        </p>
      </div>
    </div>
  )
}

/* Each phase of a build job, in the order the track renders them. A model
 * writes, the arcade boots the result in a real browser and plays it, failed
 * checks go back for repair, and only a passing game leaves this screen. */
const BUILD_STEPS = ['writing', 'testing', 'repairing', 'done'] as const

const PHASE_LABEL: Record<string, string> = {
  queued: 'QUEUED',
  designing: 'DESIGNING',
  writing: 'WRITING',
  testing: 'TESTING — RUNNING IT IN A REAL BROWSER',
  repairing: 'REPAIRING',
  done: 'PASSED',
}

function BuildTrack({ phase, status }: { phase: string; status: string }) {
  const done = status === 'done'
  const idx = done ? BUILD_STEPS.length : BUILD_STEPS.indexOf(phase as never)
  return (
    <div className="build-track" aria-hidden>
      {BUILD_STEPS.map((step, i) => (
        <i
          key={step}
          className={
            done
              ? 'is-ok'
              : i < idx
                ? 'is-done'
                : i === idx
                  ? 'is-live'
                  : ''
          }
        />
      ))}
    </div>
  )
}

function BuildStream({ room, models }: { room: RoomState; models: ModelInfo[] }) {
  const gen = room.gen
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!gen) return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - gen.startedAt) / 1000)), 500)
    return () => clearInterval(t)
  }, [gen?.startedAt])

  const ids = gen ? Object.keys(gen.byModel) : []

  return (
    <div className="screen build">
      <div className="scanlines" aria-hidden />
      <div className="build-head">
        <p className="mono eyebrow">
          {gen?.remix ? 'rewriting' : gen?.stage === 'merging' ? 'merging everyone’s ideas' : 'building your game'}
        </p>
        <p className="mono build-timer">{elapsed}s</p>
      </div>

      {gen?.remix && <p className="build-request">“{gen.remix}”</p>}
      {gen?.stage !== 'merging' && room.brief && <p className="build-brief">{room.brief}</p>}

      <div className={`build-panes panes-${Math.min(ids.length, 4)}`}>
        {ids.map((id) => {
          const slot = gen!.byModel[id]
          const model = models.find((m) => m.id === id)
          const phase = slot.status === 'done' ? 'done' : slot.phase
          return (
            <div key={id} className="build-pane">
              <div className="build-pane-head">
                <span className="mono build-model">{model?.label || id}</span>
                <span className="mono dim">
                  {slot.status === 'done'
                    ? `${Math.round((slot.ms || 0) / 1000)}s`
                    : `${slot.chars.toLocaleString()} chars`}
                </span>
              </div>
              <BuildTrack phase={phase} status={slot.status} />
              <p className="build-phase">
                <span
                  className={
                    phase === 'testing' ? 'is-testing' : phase === 'done' ? 'is-verified' : ''
                  }
                >
                  {PHASE_LABEL[phase] || phase.toUpperCase()}
                </span>
              </p>
              <pre className="phosphor-stream" aria-hidden>
                {slot.preview || '…'}
              </pre>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function VariantPicker({
  room,
  you,
  variants,
}: {
  room: RoomState
  you: Player
  variants: Variant[]
}) {
  const [preview, setPreview] = useState<Variant | null>(null)
  const tally = useMemo(() => {
    const t: Record<string, number> = {}
    for (const vid of Object.values(room.votes)) t[vid] = (t[vid] || 0) + 1
    return t
  }, [room.votes])
  const myVote = room.votes[you.id]
  const live = room.players.filter((p) => p.connected).length

  return (
    <div className="screen vote">
      <div className="scanlines" aria-hidden />
      <div className="vote-inner">
        <p className="mono eyebrow phosphor-dim">
          {variants.length} versions · {Object.keys(room.votes).length} of {live} voted
        </p>
        <div className="vote-grid">
          {variants.map((v) => (
            <article key={v.id} className={`vote-card ${myVote === v.id ? 'is-mine' : ''}`}>
              <header>
                <h3>{v.title}</h3>
                <span className="mono dim">
                  {v.modelId} · {Math.round(v.ms / 1000)}s · {Math.round(v.bytes / 1024)}kb
                </span>
              </header>
              {v.verified && (
                <span className="verified" title="This build ran in a real browser — host and guest — before you saw it">
                  verified in browser
                </span>
              )}
              {v.problems.length > 0 && (
                <p className="warn mono">
                  {v.problems.length} warning{v.problems.length === 1 ? '' : 's'}
                  {v.repaired ? ' (auto-repaired)' : ''}
                </p>
              )}
              <div className="vote-card-actions">
                <button className="btn btn-sm" onClick={() => setPreview(v)}>
                  Try it
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => arcade.send('vote', { variantId: v.id })}
                >
                  {myVote === v.id ? 'Voted' : 'Vote'}
                  {tally[v.id] ? ` · ${tally[v.id]}` : ''}
                </button>
              </div>
            </article>
          ))}
        </div>
        {you.isHost && (
          <p className="mono dim">
            As host you can skip the vote and lock any version in from its card menu below.
          </p>
        )}
      </div>

      {preview && (
        <div className="modal" role="dialog" aria-label={`Preview of ${preview.title}`}>
          <div className="modal-head">
            <span className="mono">
              solo preview · {preview.title} · {preview.modelId}
            </span>
            <div>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  arcade.send('commit', { variantId: preview.id })
                  setPreview(null)
                }}
              >
                Play this one
              </button>
              <button className="btn btn-sm" onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="modal-body">
            <GameFrame
              solo
              html={preview.html || ''}
              version={preview.id}
              seed={room.seed}
              me={you}
              players={[you]}
              isHost
            />
          </div>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------- rail

function Rail({ room, you, chat }: { room: RoomState; you: Player; chat: ChatMessage[] }) {
  const [tab, setTab] = useState<'chat' | 'faults'>('chat')
  const faults = room.runtimeErrors.length

  return (
    <aside className="rail">
      <Roster room={room} you={you} />
      <div className="rail-tabs">
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          Chat
        </button>
        <button className={tab === 'faults' ? 'on' : ''} onClick={() => setTab('faults')}>
          Faults{faults ? ` (${faults})` : ''}
        </button>
      </div>
      {tab === 'chat' ? <Chat chat={chat} /> : <Faults room={room} you={you} />}
    </aside>
  )
}

function Roster({ room, you }: { room: RoomState; you: Player }) {
  const v = useVoice()
  return (
    <ul className="roster">
      {room.players.map((p) => (
        <li key={p.id} className={`roster-row ${p.connected ? '' : 'is-away'}`}>
          <span
            className="dot"
            style={{
              background: p.color,
              boxShadow: v.levels[p.id] > 0.15 ? `0 0 0 4px ${p.color}44` : undefined,
            }}
          />
          <span className="roster-name">
            {p.name}
            {p.id === you.id && <span className="dim"> (you)</span>}
          </span>
          {p.isHost && (
            <span className="mono tag tag-host" title="Runs the game simulation">
              host
            </span>
          )}
          {p.voice && <span className="mono tag">mic</span>}
          {!p.connected && <span className="mono dim">away</span>}
        </li>
      ))}
    </ul>
  )
}

function Chat({ chat }: { chat: ChatMessage[] }) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [chat.length])

  return (
    <div className="chat">
      <div className="chat-log">
        {chat.map((m) =>
          m.kind === 'system' ? (
            <p key={m.id} className="chat-system mono">
              {m.text}
            </p>
          ) : (
            <p key={m.id} className="chat-line">
              <span className="chat-who mono" style={{ color: m.color }}>
                {m.name}
              </span>
              {m.text}
            </p>
          ),
        )}
        <div ref={endRef} />
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          arcade.send('chat', { text })
          setText('')
        }}
      >
        <input
          className="input"
          value={text}
          maxLength={500}
          placeholder="Say something"
          onChange={(e) => setText(e.target.value)}
        />
      </form>
    </div>
  )
}

/** Live proof of whether this player is actually connected to the game. */
function SyncMeter({ room, you }: { room: RoomState; you: Player }) {
  const [rate, setRate] = useState({ inPerSec: 0, outPerSec: 0 })
  const last = useRef({ stateIn: 0, inputOut: 0, at: Date.now() })

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0.25, (now - last.current.at) / 1000)
      setRate({
        inPerSec: Math.round((diag.stateIn - last.current.stateIn) / dt),
        outPerSec: Math.round((diag.inputOut - last.current.inputOut) / dt),
      })
      last.current = { stateIn: diag.stateIn, inputOut: diag.inputOut, at: now }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const isHost = you.id === room.hostId
  const playing = room.phase === 'playing'
  const healthy = isHost ? true : rate.inPerSec > 0

  return (
    <div className={`sync ${playing && !healthy ? 'is-bad' : ''}`}>
      <p className="mono label">Your connection to the game</p>
      {isHost ? (
        <p className="mono dim">
          You are the host — you run the simulation and send {diag.stateOut.toLocaleString()} updates
          to everyone else.
        </p>
      ) : (
        <p className="mono dim">
          receiving {rate.inPerSec}/s · sending {rate.outPerSec}/s ·{' '}
          {diag.stateIn.toLocaleString()} updates in total
        </p>
      )}
      {playing && !isHost && !healthy && (
        <p className="mono error">
          No game updates are arriving. The host may have dropped, or this game only lets the host
          play — ask them to hit Rebuild.
        </p>
      )}
    </div>
  )
}

function Faults({ room, you }: { room: RoomState; you: Player }) {
  if (!room.runtimeErrors.length) {
    return (
      <div className="faults empty-panel">
        <SyncMeter room={room} you={you} />
        <p className="dim">No faults. If the game throws an error, it lands here with a one-click fix.</p>
      </div>
    )
  }
  return (
    <div className="faults">
      <SyncMeter room={room} you={you} />
      {room.runtimeErrors.map((e, i) => (
        <div key={i} className="fault">
          <p className="mono fault-msg">{e.message}</p>
          <p className="mono dim">
            {e.where} · seen by {e.from}
          </p>
        </div>
      ))}
      <button
        className="btn btn-sm btn-primary"
        onClick={() =>
          arcade.send('remix', {
            text: `The game is throwing runtime errors. Fix them without changing the design:\n${room.runtimeErrors
              .slice(-6)
              .map((e) => `- ${e.message} (${e.where})`)
              .join('\n')}`,
          })
        }
      >
        Send these to the model
      </button>
    </div>
  )
}

// --------------------------------------------------------------- control deck

function ControlDeck({
  room,
  you,
  models,
  onPublish,
  hasGame,
}: {
  room: RoomState
  you: Player
  models: ModelInfo[]
  onPublish: () => void
  hasGame: boolean
}) {
  const [idea, setIdea] = useState(you.idea || '')
  const [remix, setRemix] = useState('')
  const debounce = useRef<number>(0)

  useEffect(() => {
    setIdea(room.players.find((p) => p.id === you.id)?.idea || '')
  }, [room.phase])

  function pushIdea(text: string) {
    setIdea(text)
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => arcade.send('idea', { text }), 300)
  }

  function toggleModel(id: string) {
    const next = room.models.includes(id)
      ? room.models.filter((m) => m !== id)
      : [...room.models, id].slice(-4)
    arcade.send('models', { ids: next.length ? next : [id] })
  }

  if (room.phase === 'generating') {
    return (
      <div className="deck deck-row">
        <p className="mono deck-status">
          <span className="live-dot" /> building — everyone can watch
        </p>
        <button className="btn" onClick={() => arcade.send('cancel')}>
          Cancel
        </button>
      </div>
    )
  }

  if (room.phase === 'idea-vote') {
    const live = room.players.filter((p) => p.connected).length
    const cast = Object.keys(room.ideaVotes).length
    const host = room.players.find((p) => p.id === room.hostId)
    const winner = room.players.find((p) => p.id === room.ideaWinner)
    const iAmHost = you.id === room.hostId

    return (
      <div className="deck deck-row">
        <p className="mono deck-status">
          {winner ? (
            <>
              <span className="dot" style={{ background: winner.color }} /> {winner.name}'s idea
              takes it
            </>
          ) : (
            <>
              <span className="live-dot" /> {room.majority} of {live} wins it · {cast} voted
            </>
          )}
        </p>
        <div className="deck-actions">
          <button className="btn" onClick={() => arcade.send('lobby')}>
            Back to pitches
          </button>
          {iAmHost ? (
            <button
              className="btn btn-primary btn-lg"
              onClick={() => arcade.send('start-build')}
              disabled={cast === 0}
              title={cast === 0 ? 'Wait for at least one vote' : 'Build the winning idea'}
            >
              {winner ? `Build ${winner.name}'s idea` : 'Build the leader'}
            </button>
          ) : (
            <span className="mono dim">
              {winner ? `waiting for ${host?.name || 'the host'} to build it` : 'cast your vote'}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (room.phase === 'voting') {
    return (
      <div className="deck deck-row">
        <p className="mono deck-status">Try each version, then vote. It locks in when everyone has.</p>
        <button className="btn" onClick={() => arcade.send('lobby')}>
          Start over
        </button>
      </div>
    )
  }

  if (room.phase === 'playing') {
    return (
      <div className="deck deck-row deck-play">
        <form
          className="remix-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!remix.trim()) return
            arcade.send('remix', { text: remix })
            setRemix('')
          }}
        >
          <input
            className="input"
            value={remix}
            maxLength={1000}
            placeholder="Change something — “add a second ball”, “make the map bigger”…"
            onChange={(e) => setRemix(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Rebuild
          </button>
        </form>
        <div className="deck-actions">
          <button
            className="btn btn-sm"
            title="Rebuild this game so every player can play, not just the host"
            onClick={() =>
              arcade.send('remix', {
                text: 'Some players cannot play — only the host can move. Fix it: EVERY client must capture its own input and call MP.sendInput() from the first frame, never inside an if (MP.isHost) check. The host must spawn an entity for every id in MP.players on every tick, adding late joiners automatically. Remove any join screen, lobby, "waiting for players" state or host-only start control. Do not open a menu over the game on load. Keep the game design identical.',
              })
            }
          >
            Everyone can play
          </button>
          <button className="btn btn-sm" onClick={() => arcade.send('restart')}>
            Restart round
          </button>
          <button className="btn btn-sm" onClick={onPublish} disabled={!hasGame}>
            Publish
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => arcade.send('lobby')}>
            New game
          </button>
        </div>
      </div>
    )
  }

  const pitched = room.players.filter((p) => p.idea.trim()).length

  return (
    <div className="deck deck-lobby">
      <div className="models">
        <span className="mono label">Models</span>
        {models.map((m) => (
          <button
            key={m.id}
            className={`chip ${room.models.includes(m.id) ? 'on' : ''}`}
            onClick={() => toggleModel(m.id)}
            title={m.blurb}
          >
            {m.label}
          </button>
        ))}
        <span className="mono dim models-hint">
          {room.models.length > 1
            ? `${room.models.length} versions, then you vote`
            : 'pick more than one to compare'}
        </span>

        {/* The mode decides which rulebook the model builds against, so only
            the host sets it. */}
        {you.id === room.hostId && (
          <div className="scope-switch">
            <span className="mono label">Players</span>
            <button
              className={`chip ${room.mode === 'multi' ? 'on' : ''}`}
              onClick={() => arcade.send('mode', { mode: 'multi' })}
              title="Everyone in the room plays the same game together"
            >
              Multiplayer
            </button>
            <button
              className={`chip ${room.mode === 'single' ? 'on' : ''}`}
              onClick={() => arcade.send('mode', { mode: 'single' })}
              title="Everyone gets their own private copy"
            >
              Single player
            </button>
          </div>
        )}

        <div className="scope-switch">
          <span className="mono label">Scope</span>
          <button
            className={`chip ${room.scope === 'quick' ? 'on' : ''}`}
            onClick={() => arcade.send('scope', { scope: 'quick' })}
            title="A sharp, focused game. Faster to build."
          >
            Quick
          </button>
          <button
            className={`chip ${room.scope === 'deep' ? 'on' : ''}`}
            onClick={() => arcade.send('scope', { scope: 'deep' })}
            title="Designs the game first, then builds it. Much bigger, much slower."
          >
            Deep
          </button>
        </div>
      </div>
      <p className="mono dim scope-note">
        {room.mode === 'single'
          ? 'Single player: everyone gets their own copy, nothing is shared.'
          : 'Multiplayer: everyone plays together on their own screen — no joining, no lobby.'}
        {room.scope === 'deep' &&
          ' Deep build: the model designs it first, then implements — 3D is on the table, and it takes much longer.'}
      </p>

      <form
        className="pitch-form"
        onSubmit={(e) => {
          // Enter commits your pitch. It must never start anything — a player
          // typing an idea and hitting return should not kick off a build.
          e.preventDefault()
          window.clearTimeout(debounce.current)
          arcade.send('idea', { text: idea })
        }}
      >
        <input
          className="input"
          value={idea}
          maxLength={400}
          placeholder="Your idea for the game…"
          onChange={(e) => pushIdea(e.target.value)}
        />
        <button
          className="btn btn-primary btn-lg"
          type="button"
          disabled={pitched === 0}
          onClick={() => arcade.send('open-vote')}
        >
          {pitched > 1 ? `Vote on ${pitched} ideas` : 'Put it to a vote'}
        </button>
      </form>
    </div>
  )
}

function PublishDialog({
  defaultTitle,
  onClose,
  onSubmit,
}: {
  defaultTitle: string
  onClose: () => void
  onSubmit: (p: { title: string; tagline: string; tags: string[] }) => void
}) {
  const [title, setTitle] = useState(defaultTitle)
  const [tagline, setTagline] = useState('')
  const [tags, setTags] = useState('')

  return (
    <div className="modal modal-sm" role="dialog" aria-label="Publish to the marketplace">
      <div className="modal-head">
        <span className="mono">publish to the marketplace</span>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit({
            title,
            tagline,
            tags: tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          })
        }}
      >
        <label className="mono label" htmlFor="pub-title">
          Title
        </label>
        <input id="pub-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />

        <label className="mono label" htmlFor="pub-tag">
          One line about it
        </label>
        <input
          id="pub-tag"
          className="input"
          value={tagline}
          placeholder="Four players, one crown, no rules"
          onChange={(e) => setTagline(e.target.value)}
        />

        <label className="mono label" htmlFor="pub-tags">
          Tags, comma separated
        </label>
        <input
          id="pub-tags"
          className="input"
          value={tags}
          placeholder="party, chaos, 4-player"
          onChange={(e) => setTags(e.target.value)}
        />

        <p className="dim small">
          Publishing shares the full source. Anyone can play it, download it, and fork it into their
          own room.
        </p>
        <button className="btn btn-primary" type="submit">
          Publish
        </button>
      </form>
    </div>
  )
}

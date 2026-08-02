/* The play surface: the game plus everything that has to survive fullscreen.
 *
 * Chat, roster and voice controls live *inside* the fullscreen element,
 * because anything outside it is invisible once the browser takes over the
 * screen. Voice itself is unaffected — the audio elements sit on the document
 * and keep playing regardless of what is fullscreened.
 */

import { useEffect, useRef, useState } from 'react'
import { GameFrame } from './GameFrame'
import { arcade, type ChatMessage, type Player, type RoomState } from './net'
import { useVoice, voice } from './voice'

type Props = {
  room: RoomState
  you: Player
  chat: ChatMessage[]
  html: string
  version: string
  title: string
  /** Single-player games run privately on each client — no host, no sync. */
  solo: boolean
}

export function Stage({ room, you, chat, html, version, title, solo }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [isFull, setIsFull] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const seenRef = useRef(chat.length)

  useEffect(() => {
    const onChange = () => setIsFull(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Unread badge only matters while the overlay chat is shut.
  useEffect(() => {
    if (chatOpen) {
      seenRef.current = chat.length
      setUnread(0)
    } else {
      setUnread(Math.max(0, chat.length - seenRef.current))
    }
  }, [chat.length, chatOpen])

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await wrapRef.current?.requestFullscreen({ navigationUI: 'hide' })
    } catch {
      /* browser refused; the button just does nothing */
    }
  }

  return (
    <div ref={wrapRef} className={`stage-surface ${isFull ? 'is-full' : ''}`}>
      <GameFrame
        solo={solo}
        html={html}
        version={version}
        seed={room.seed}
        me={you}
        players={solo ? [you] : room.players.filter((p) => p.connected)}
        isHost={solo || you.id === room.hostId}
      />

      <StageBar
        room={room}
        you={you}
        title={title}
        isFull={isFull}
        chatOpen={chatOpen}
        unread={unread}
        onToggleChat={() => setChatOpen((v) => !v)}
        onToggleFullscreen={toggleFullscreen}
      />

      {isFull && chatOpen && <OverlayChat chat={chat} onClose={() => setChatOpen(false)} />}
    </div>
  )
}

function StageBar({
  room,
  you,
  title,
  isFull,
  chatOpen,
  unread,
  onToggleChat,
  onToggleFullscreen,
}: {
  room: RoomState
  you: Player
  title: string
  isFull: boolean
  chatOpen: boolean
  unread: number
  onToggleChat: () => void
  onToggleFullscreen: () => void
}) {
  const v = useVoice()
  const live = room.players.filter((p) => p.connected)

  return (
    <div className="stage-bar">
      {/* Windowed, the room chrome already names the game and carries chat —
          only fullscreen needs them repeated here. */}
      {isFull && <span className="stage-title mono">{title}</span>}

      <div className="stage-players">
        {live.map((p) => (
          <span
            key={p.id}
            className="dot"
            title={p.name}
            style={{
              background: p.color,
              boxShadow: v.levels[p.id] > 0.15 ? `0 0 0 3px ${p.color}66` : undefined,
            }}
          />
        ))}
      </div>

      <div className="stage-actions">
        <button
          className={`btn btn-sm ${v.enabled ? 'btn-live' : ''}`}
          onClick={() => voice.toggle(you.id)}
          title={v.enabled ? 'Leave voice' : 'Join voice chat'}
        >
          {v.enabled ? '● voice' : 'voice'}
        </button>
        {v.enabled && (
          <button className="btn btn-sm" onClick={() => voice.setMuted(!v.muted)}>
            {v.muted ? 'unmute' : 'mute'}
          </button>
        )}
        {isFull && (
          <button className={`btn btn-sm ${chatOpen ? 'btn-on' : ''}`} onClick={onToggleChat}>
            chat{unread ? ` · ${unread}` : ''}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => arcade.send('restart')}>
          restart
        </button>
        <button className="btn btn-sm btn-primary" onClick={onToggleFullscreen}>
          {isFull ? 'exit fullscreen' : 'fullscreen'}
        </button>
      </div>
    </div>
  )
}

function OverlayChat({ chat, onClose }: { chat: ChatMessage[]; onClose: () => void }) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [chat.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="stage-chat">
      <div className="stage-chat-head">
        <span className="mono label">Room chat</span>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          close
        </button>
      </div>
      <div className="stage-chat-log">
        {chat.slice(-40).map((m) =>
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
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          arcade.send('chat', { text })
          setText('')
        }}
      >
        <input
          ref={inputRef}
          className="input"
          value={text}
          maxLength={500}
          placeholder="Say something"
          onChange={(e) => setText(e.target.value)}
          // The game is listening for keys; don't let chat typing reach it.
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  )
}

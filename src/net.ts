/* WebSocket client: one connection per room, shared through a tiny store. */

import { useSyncExternalStore } from 'react'

export type Player = {
  id: string
  name: string
  color: string
  index: number
  connected: boolean
  isHost: boolean
  voice: boolean
  idea: string
}

export type ModelInfo = { id: string; label: string; api: string; blurb: string; speed: string }

export type Variant = {
  id: string
  modelId: string
  mode: 'multi' | 'single'
  title: string
  problems: string[]
  repaired: boolean
  ms: number
  bytes: number
  html?: string
}

export type RoomState = {
  id: string
  phase: 'lobby' | 'idea-vote' | 'generating' | 'voting' | 'playing'
  seed: number
  hostId: string | null
  models: string[]
  scope: 'quick' | 'deep'
  mode: 'multi' | 'single'
  brief: string
  briefSource: string
  players: Player[]
  votes: Record<string, string>
  ideaVotes: Record<string, string>
  ideaWinner: string | null
  majority: number
  remixing: boolean
  gen: {
    startedAt: number
    stage?: string
    remix: string | null
    byModel: Record<
      string,
      { status: string; phase: string; chars: number; preview: string; ms?: number }
    >
  } | null
  variants: Variant[]
  game: {
    title: string
    modelId: string
    mode: 'multi' | 'single'
    brief: string
    libraryId: string | null
    savedAs: string | null
    bytes: number
    version: number
  } | null
  runtimeErrors: { message: string; where: string; from: string; ts: number }[]
}

export type ChatMessage = {
  id: string
  kind: 'chat' | 'system'
  from?: string
  name?: string
  color?: string
  text: string
  ts: number
}

export type GamePayload = {
  title: string
  html: string
  modelId: string
  mode: 'multi' | 'single'
  brief: string
  libraryId: string | null
  seed: number
  version: number
}

export type Toast = { id: number; level: 'ok' | 'error' | 'info'; text: string }

type Snapshot = {
  status: 'idle' | 'connecting' | 'open' | 'closed'
  you: Player | null
  room: RoomState | null
  chat: ChatMessage[]
  models: ModelInfo[]
  game: GamePayload | null
  variants: Variant[]
  toasts: Toast[]
  fatal: string | null
}

type NetHandler = (msg: any) => void

const EMPTY: Snapshot = {
  status: 'idle',
  you: null,
  room: null,
  chat: [],
  models: [],
  game: null,
  variants: [],
  toasts: [],
  fatal: null,
}

class Arcade {
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private netHandlers = new Set<NetHandler>()
  private snap: Snapshot = EMPTY
  private roomId = ''
  private name = ''
  private retry: number | null = null
  private toastSeq = 0

  getSnapshot = () => this.snap

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Game netcode and reset events, consumed by <GameFrame>. */
  onNet(fn: NetHandler): () => void {
    this.netHandlers.add(fn)
    return () => {
      this.netHandlers.delete(fn)
    }
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((l) => l())
  }

  private toast(level: Toast['level'], text: string) {
    const t = { id: ++this.toastSeq, level, text }
    this.set({ toasts: [...this.snap.toasts, t] })
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), 4200)
  }

  dismissToast(id: number) {
    this.set({ toasts: this.snap.toasts.filter((t) => t.id !== id) })
  }

  connect(roomId: string, name: string) {
    if (this.ws && this.roomId === roomId && this.snap.status !== 'closed') return
    this.roomId = roomId
    this.name = name
    this.disconnect()
    this.set({ ...EMPTY, status: 'connecting' })
    this.open()
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(this.roomId)}`)
    this.ws = ws

    ws.onopen = () => {
      this.set({ status: 'open' })
      ws.send(
        JSON.stringify({
          type: 'hello',
          roomId: this.roomId,
          name: this.name,
          playerId: localStorage.getItem(`arcade:pid:${this.roomId}`) || undefined,
        }),
      )
    }

    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      this.handle(msg)
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.set({ status: 'closed' })
      if (!this.snap.fatal && this.roomId) {
        this.retry = window.setTimeout(() => this.open(), 1500)
      }
    }

    ws.onerror = () => ws.close()
  }

  private handle(msg: any) {
    switch (msg.type) {
      case 'hello':
        localStorage.setItem(`arcade:pid:${this.roomId}`, msg.you.id)
        this.set({ you: msg.you, room: msg.room, chat: msg.chat || [], models: msg.models || [] })
        break
      case 'room': {
        const you = msg.room.players.find((p: Player) => p.id === this.snap.you?.id)
        this.set({ room: msg.room, you: you || this.snap.you })
        break
      }
      case 'chat':
        this.set({ chat: [...this.snap.chat, msg.message].slice(-200) })
        break
      case 'variants':
        this.set({ variants: msg.variants })
        break
      case 'game':
        this.set({ game: msg.game, variants: [] })
        break
      case 'mp':
        if (msg.kind === 'state') diag.stateIn++
        else if (msg.kind === 'input') diag.inputIn++
        else diag.eventIn++
        this.netHandlers.forEach((h) => h(msg))
        break
      case 'reset':
      case 'rtc':
      case 'rtc-join':
      case 'rtc-leave':
        this.netHandlers.forEach((h) => h(msg))
        break
      case 'toast':
        this.toast(msg.level, msg.text)
        break
      case 'fatal':
        this.set({ fatal: msg.message, status: 'closed' })
        break
    }
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (type === 'mp') {
        if (payload.kind === 'state') diag.stateOut++
        else if (payload.kind === 'input') diag.inputOut++
      }
      this.ws.send(JSON.stringify({ type, ...payload }))
    }
  }

  disconnect() {
    if (this.retry) window.clearTimeout(this.retry)
    this.retry = null
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  leave() {
    this.roomId = ''
    this.disconnect()
    this.set(EMPTY)
  }
}

/* Relay counters. Cheap, always on, and the only way to answer "is state
 * actually reaching this player?" without guessing from pixels. */
export const diag = {
  stateIn: 0,
  inputIn: 0,
  eventIn: 0,
  stateOut: 0,
  inputOut: 0,
  toGame: 0,
  fromGame: 0,
  isHost: false,
  solo: false,
}

export const arcade = new Arcade()

if (typeof window !== 'undefined') {
  ;(window as unknown as { __arcadeDiag: typeof diag }).__arcadeDiag = diag
}

export function useArcade() {
  return useSyncExternalStore(arcade.subscribe, arcade.getSnapshot, arcade.getSnapshot)
}

export function displayName(): string {
  return localStorage.getItem('arcade:name') || ''
}

export function setDisplayName(name: string) {
  localStorage.setItem('arcade:name', name)
}

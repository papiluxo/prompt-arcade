/* Voice chat: a peer-to-peer audio mesh signalled over the room socket.
 *
 * Full mesh is the right call at party-game scale (2-6 people): no media
 * server, no relay hop, and it dies cleanly when the tab closes.
 */

import { useSyncExternalStore } from 'react'
import { arcade, type Player } from './net'

type VoiceSnapshot = {
  enabled: boolean
  muted: boolean
  error: string | null
  levels: Record<string, number> // playerId -> 0..1 loudness
}

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

class Voice {
  private listeners = new Set<() => void>()
  private snap: VoiceSnapshot = { enabled: false, muted: false, error: null, levels: {} }
  private peers = new Map<string, RTCPeerConnection>()
  private audio = new Map<string, HTMLAudioElement>()
  private meters = new Map<
    string,
    { ctx: AudioContext; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }
  >()
  private stream: MediaStream | null = null
  private myId = ''
  private known: Player[] = []
  private raf = 0
  private unsub: (() => void) | null = null

  getSnapshot = () => this.snap
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private set(patch: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((l) => l())
  }

  async toggle(myId: string) {
    if (this.snap.enabled) this.disable()
    else await this.enable(myId)
  }

  async enable(myId: string) {
    this.myId = myId
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      this.set({ error: 'Microphone blocked. Allow access in your browser, then try again.' })
      return
    }
    this.set({ enabled: true, error: null })
    this.meter(this.myId, this.stream)
    this.listen()
    arcade.send('voice', { on: true })
    this.sync(this.known, myId)
    this.startLevels()
  }

  disable() {
    arcade.send('voice', { on: false })
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.stopMeter(this.myId)
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.unsub?.()
    this.unsub = null
    this.set({ enabled: false, muted: false, levels: {} })
  }

  setMuted(muted: boolean) {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted))
    this.set({ muted })
  }

  /** Reconcile peers against the roster. Call whenever the room changes. */
  sync(players: Player[], myId: string) {
    this.known = players
    this.myId = myId || this.myId
    if (!this.snap.enabled) return
    const wanted = new Set(
      players.filter((p) => p.voice && p.connected && p.id !== this.myId).map((p) => p.id),
    )
    for (const id of wanted) if (!this.peers.has(id)) this.addPeer(id, this.myId < id)
    for (const id of this.peers.keys()) if (!wanted.has(id)) this.dropPeer(id)
  }

  private listen() {
    if (this.unsub) return
    this.unsub = arcade.onNet(async (msg) => {
      if (msg.type === 'rtc-leave') return this.dropPeer(msg.from)
      if (msg.type !== 'rtc' || !this.snap.enabled) return
      const { from, signal } = msg
      let pc = this.peers.get(from)
      if (!pc) pc = this.addPeer(from, false)

      try {
        if (signal.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          if (signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            arcade.send('rtc', { to: from, signal: { sdp: pc.localDescription } })
          }
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
        }
      } catch (err) {
        console.warn('voice signalling', err)
      }
    })
  }

  private addPeer(peerId: string, initiator: boolean) {
    const pc = new RTCPeerConnection(ICE)
    this.peers.set(peerId, pc)
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream!))

    pc.onicecandidate = (e) => {
      if (e.candidate) arcade.send('rtc', { to: peerId, signal: { candidate: e.candidate } })
    }

    pc.ontrack = (e) => {
      const [remote] = e.streams
      let el = this.audio.get(peerId)
      if (!el) {
        el = document.createElement('audio')
        el.autoplay = true
        el.style.display = 'none'
        document.body.appendChild(el)
        this.audio.set(peerId, el)
      }
      el.srcObject = remote
      el.play().catch(() => {})
      this.meter(peerId, remote)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(peerId)
    }

    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          arcade.send('rtc', { to: peerId, signal: { sdp: pc.localDescription } })
        } catch (err) {
          console.warn('voice offer', err)
        }
      }
    }
    return pc
  }

  private dropPeer(peerId: string) {
    this.peers.get(peerId)?.close()
    this.peers.delete(peerId)
    const el = this.audio.get(peerId)
    if (el) {
      el.srcObject = null
      el.remove()
      this.audio.delete(peerId)
    }
    this.stopMeter(peerId)
    const levels = { ...this.snap.levels }
    delete levels[peerId]
    this.set({ levels })
  }

  private meter(id: string, stream: MediaStream) {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      const buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      this.meters.set(id, { ctx, analyser, buf })
    } catch {
      /* metering is cosmetic */
    }
  }

  private stopMeter(id: string) {
    const m = this.meters.get(id)
    if (m) {
      m.ctx.close().catch(() => {})
      this.meters.delete(id)
    }
  }

  private startLevels() {
    let last = 0
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop)
      if (t - last < 100) return
      last = t
      const levels: Record<string, number> = {}
      for (const [id, m] of this.meters) {
        m.analyser.getByteTimeDomainData(m.buf)
        let peak = 0
        for (let i = 0; i < m.buf.length; i++) peak = Math.max(peak, Math.abs(m.buf[i] - 128))
        const level = Math.min(1, peak / 40)
        levels[id] = id === this.myId && this.snap.muted ? 0 : level
      }
      const changed = Object.keys(levels).some(
        (k) => Math.abs((this.snap.levels[k] || 0) - levels[k]) > 0.08,
      )
      if (changed || Object.keys(levels).length !== Object.keys(this.snap.levels).length) {
        this.set({ levels })
      }
    }
    this.raf = requestAnimationFrame(loop)
  }
}

export const voice = new Voice()

export function useVoice() {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot, voice.getSnapshot)
}

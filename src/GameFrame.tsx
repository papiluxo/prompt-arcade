/* Runs a generated game in a sandboxed iframe and bridges it to the room.
 *
 * The game never touches the network. It talks to this component over
 * postMessage; this component talks to the server. Solo mode short-circuits
 * the server entirely so you can try a variant before voting on it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import mpRuntime from '../shared/mp-runtime.js?raw'
import { arcade, diag, type Player } from './net'

/* A floor, not a straitjacket: injected before the game's own styles so the
 * game can override anything here. It exists because a game that forgets to
 * zero the body margin or size itself to the viewport renders into a corner. */
const FLOOR_CSS = `
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
body { background: #05030a; color: #ede7ff; font-family: system-ui, sans-serif; }
canvas { display: block; }
`

function inject(html: string, head: string) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + head)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '\n' + head)
  return head + html
}

/** Vendored libraries a game may reach for. Fetched once, then cached. */
const libCache = new Map<string, Promise<string>>()

function loadLib(name: string) {
  if (!libCache.has(name)) {
    libCache.set(
      name,
      fetch(`/api/lib/${name}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(name)))),
    )
  }
  return libCache.get(name)!
}

function libsFor(html: string) {
  return /\bTHREE\s*\./.test(html) ? ['three'] : []
}

type Props = {
  html: string
  version: number | string
  seed: number
  me: Player | { id: string; name: string; color: string; index: number }
  players: Player[]
  isHost: boolean
  solo?: boolean
}

export function GameFrame({ html, version, seed, me, players, isHost, solo = false }: Props) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [focused, setFocused] = useState(false)
  // A 3D game needs three.js inlined before its own code runs, so the frame
  // waits on the fetch rather than booting into a ReferenceError.
  const needed = useMemo(() => libsFor(html), [html])
  const [libs, setLibs] = useState<string[] | null>(needed.length ? null : [])

  useEffect(() => {
    let live = true
    if (!needed.length) {
      setLibs([])
      return
    }
    setLibs(null)
    Promise.all(needed.map(loadLib))
      .then((sources) => live && setLibs(sources))
      .catch(() => live && setLibs([]))
    return () => {
      live = false
    }
  }, [needed.join(',')])

  // A fresh document per version so a remix never inherits stale globals.
  const frameKey = `${version}:${solo ? 'solo' : 'live'}`

  /* Captured once per frame instance, never on roster changes — this string is
   * baked into the document, so making it reactive would reload the game every
   * time somebody joined. Later changes arrive by postMessage instead. */
  const initJson = useMemo(
    () =>
      JSON.stringify({
        me: { id: me.id, name: me.name, color: me.color, index: me.index },
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          index: p.index,
          isHost: 'isHost' in p ? p.isHost : false,
        })),
        isHost,
        seed,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameKey],
  )

  const srcDoc = useMemo(() => {
    if (libs === null) return ''
    const head = [
      `<style>${FLOOR_CSS}</style>`,
      ...libs.map((src) => `<script>\n${src}\n</script>`),
      // Identity first, so the runtime is fully formed before game code runs.
      `<script>window.__MP_INIT = ${initJson.replace(/</g, '\\u003c')};</script>`,
      `<script>\n${mpRuntime}\n</script>`,
    ].join('\n')
    return inject(html, head)
  }, [html, libs, initJson])

  // A fresh document per version so a remix never inherits stale globals.

  useEffect(() => {
    setReady(false)
    setStalled(false)
    const t = setTimeout(() => setStalled(true), 10_000)
    return () => clearTimeout(t)
  }, [frameKey])

  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, '*')

  /* Keyboard events go to whatever has focus. Without this the game is a
   * picture: every keystroke lands on the page around it, which is exactly how
   * a player ends up "in the game" and unable to move. */
  const grabKeyboard = () => {
    const el = ref.current
    if (!el) return
    try {
      el.focus({ preventScroll: true })
      el.contentWindow?.focus()
      setFocused(true)
    } catch {
      /* focus can be refused; the click-to-play hint stays up */
    }
  }

  /** Tell the game its box changed so it re-measures instead of staying stuck
   *  at whatever the iframe happened to be during first layout. */
  const fit = () => {
    const box = ref.current?.getBoundingClientRect()
    post({ t: 'fit', w: Math.round(box?.width || 0), h: Math.round(box?.height || 0) })
  }

  // Layout settling, sidebar toggles, window resizes and entering fullscreen
  // all change the frame box. Every one of them needs to reach the game.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(fit)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [frameKey])

  // Game -> here
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== ref.current?.contentWindow) return
      const msg = ev.data
      if (!msg || typeof msg !== 'object') return
      switch (msg.t) {
        case 'boot':
          post({
            t: 'init',
            me: { id: me.id, name: me.name, color: me.color, index: me.index },
            players: players.map((p) => ({
              id: p.id,
              name: p.name,
              color: p.color,
              index: p.index,
              isHost: 'isHost' in p ? p.isHost : false,
            })),
            isHost,
            seed,
          })
          break
        case 'ready':
          setReady(true)
          setStalled(false)
          fit()
          // The game is live: hand it the keyboard without making the player
          // discover they have to click first.
          grabKeyboard()
          break
        case 'net':
          diag.fromGame++
          // NOT `type` — that key is the envelope's own message type and would
          // clobber it, which silently broke every MP.emit in both directions.
          if (!solo) arcade.send('mp', { kind: msg.kind, data: msg.data, eventType: msg.type })
          break
        case 'error':
          if (!solo) {
            arcade.send('game-error', { message: msg.message, stack: msg.stack, where: msg.where })
          } else {
            console.warn('[game]', msg.message)
          }
          break
        case 'log':
          console.log('[game]', ...(msg.args || []))
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })

  // Server -> game
  useEffect(() => {
    if (solo) return
    return arcade.onNet((msg) => {
      if (msg.type === 'mp') {
        diag.toGame++
        post({ t: 'net', kind: msg.kind, data: msg.data, type: msg.eventType, from: msg.from })
      } else if (msg.type === 'reset') {
        post({ t: 'reset', seed: msg.seed })
      }
    })
  }, [solo])

  // Roster changes reach the running game without reloading it.
  useEffect(() => {
    if (!ready) return
    post({
      t: 'players',
      players: players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        index: p.index,
        isHost: 'isHost' in p ? p.isHost : false,
      })),
      isHost,
    })
  }, [ready, isHost, players.map((p) => `${p.id}:${p.name}:${p.connected}`).join('|')])

  // Focus is lost whenever the player types in chat or clicks the room around
  // the game; notice and offer it back.
  useEffect(() => {
    const check = () => setFocused(document.activeElement === ref.current)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', check, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return (
    <div
      className="frame-wrap"
      onMouseDown={grabKeyboard}
      onPointerDown={grabKeyboard}
    >
      {libs !== null && (
        <iframe
          key={frameKey}
          ref={ref}
          className="game-frame"
          title="Game"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          allow="autoplay; fullscreen"
        />
      )}
      {ready && !focused && (
        <button className="focus-nudge mono" onClick={grabKeyboard}>
          click to take the controls
        </button>
      )}
      {!ready && (
        <div className="frame-overlay">
          <span className="blink mono">
            {libs === null ? 'LOADING 3D ENGINE' : stalled ? 'GAME NOT RESPONDING' : 'LOADING'}
          </span>
          {stalled && (
            <p className="frame-overlay-hint">
              It never called MP.ready(). Check the fault log, then ask for a fix.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

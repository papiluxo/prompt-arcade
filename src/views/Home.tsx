import { useEffect, useRef, useState } from 'react'
import { navigate } from '../App'
import { displayName, setDisplayName } from '../net'

const SAMPLE_PROMPTS = [
  'a game where the floor is lava and one of us is secretly lying',
  'sumo, but everyone is a magnet and the arena shrinks',
  'co-op tower defence where the towers argue with you',
  'last one holding the crown wins, the crown is very slippery',
  'a heist where nobody can see the same half of the map',
]

/** The hero: a prompt typing itself across the cabinet screen. */
function TypedScreen() {
  const [text, setText] = useState('')
  const [idx, setIdx] = useState(0)
  const reduced = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    if (reduced.current) {
      setText(SAMPLE_PROMPTS[0])
      return
    }
    const target = SAMPLE_PROMPTS[idx % SAMPLE_PROMPTS.length]
    let i = 0
    let hold: number
    const tick = window.setInterval(() => {
      i++
      setText(target.slice(0, i))
      if (i >= target.length) {
        clearInterval(tick)
        hold = window.setTimeout(() => setIdx((n) => n + 1), 2600)
      }
    }, 34)
    return () => {
      clearInterval(tick)
      clearTimeout(hold)
    }
  }, [idx])

  return (
    <div className="screen hero-screen">
      <div className="scanlines" aria-hidden />
      <div className="hero-screen-inner">
        <p className="mono eyebrow">the room types</p>
        <p className="hero-prompt">
          {text}
          <span className="caret" aria-hidden />
        </p>
        <p className="mono eyebrow">built, tested in a real browser, then you play it</p>
      </div>
    </div>
  )
}

export function Home() {
  const [name, setName] = useState(displayName())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function startRoom() {
    if (!name.trim()) return setError('Pick a name first — the others need to know who you are.')
    setBusy(true)
    setDisplayName(name.trim())
    try {
      const res = await fetch('/api/rooms', { method: 'POST' })
      const { id } = await res.json()
      navigate(`/r/${id}`)
    } catch {
      setError('Could not reach the arcade server. Is it running?')
      setBusy(false)
    }
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Pick a name first — the others need to know who you are.')
    const id = code.trim().toUpperCase()
    if (id.length < 4) return setError('Room codes are four characters.')
    setDisplayName(name.trim())
    const res = await fetch(`/api/rooms/${id}`)
    const body = await res.json()
    if (!body.exists) return setError(`No room called ${id}. Check the code.`)
    navigate(`/r/${id}`)
  }

  return (
    <div className="home">
      <header className="marquee">
        <h1 className="wordmark">Prompt Arcade</h1>
        <p className="tagline">
          Get your friends in a room. Describe a game together. Play the thing you described.
        </p>
      </header>

      <main className="home-main">
        <TypedScreen />

        <section className="deck home-deck">
          <div className="field">
            <label className="mono label" htmlFor="name">
              Your name
            </label>
            <input
              id="name"
              className="input"
              value={name}
              maxLength={24}
              placeholder="Who's playing?"
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
            />
          </div>

          <button className="btn btn-primary btn-lg" onClick={startRoom} disabled={busy}>
            {busy ? 'Opening…' : 'Start a room'}
          </button>

          <form className="join" onSubmit={joinRoom}>
            <label className="mono label" htmlFor="code">
              Or join one
            </label>
            <div className="join-row">
              <input
                id="code"
                className="input input-code mono"
                value={code}
                maxLength={4}
                placeholder="CODE"
                autoCapitalize="characters"
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase())
                  setError('')
                }}
              />
              <button className="btn" type="submit">
                Join
              </button>
            </div>
          </form>

          {error && <p className="error mono">{error}</p>}
        </section>

        <nav className="flow" aria-label="How a round works">
          <span>Join</span>
          <i aria-hidden />
          <span>Pitch</span>
          <i aria-hidden />
          <span>Build</span>
          <i aria-hidden />
          <span>Play</span>
        </nav>

        <section className="home-notes">
          <div>
            <h2 className="mono label">Everyone pitches</h2>
            <p>
              Each player drops one idea. They get merged into a single brief before any model sees
              it, so the game belongs to the room and not to whoever typed fastest.
            </p>
          </div>
          <div>
            <h2 className="mono label">Pick your models</h2>
            <p>
              Choose one and play it. Choose two or three and they each build a version — try them
              all, then vote on which one you're keeping.
            </p>
          </div>
          <div>
            <h2 className="mono label">Keep building</h2>
            <p>
              Ask for changes mid-session and the game rebuilds around you. Publish what you like to
              the marketplace, where every game is open source and downloadable.
            </p>
          </div>
        </section>

        <button className="btn btn-ghost" onClick={() => navigate('/market')}>
          Browse the marketplace →
        </button>
      </main>
    </div>
  )
}

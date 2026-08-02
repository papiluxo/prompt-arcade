import { useEffect, useState } from 'react'
import { navigate } from '../App'
import { GameFrame } from '../GameFrame'

type GameMeta = {
  id: string
  title: string
  tagline: string
  brief: string
  modelId: string
  authors: string[]
  tags: string[]
  parentId: string | null
  createdAt: number
  plays: number
  remixes: number
  bytes: number
}

const SORTS = [
  { id: 'recent', label: 'Newest' },
  { id: 'plays', label: 'Most played' },
  { id: 'remixes', label: 'Most forked' },
]

export function Market() {
  const id = location.pathname.match(/^\/market\/([\w-]+)/)?.[1]
  return id ? <Detail id={id} /> : <Listing />
}

function Listing() {
  const [games, setGames] = useState<GameMeta[] | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('recent')

  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/games?sort=${sort}&q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => setGames(d.games))
        .catch(() => setGames([]))
    }, 150)
    return () => clearTimeout(t)
  }, [q, sort])

  return (
    <div className="market">
      <header className="topbar">
        <button className="wordmark wordmark-xs" onClick={() => navigate('/')}>
          Prompt Arcade
        </button>
        <span className="mono eyebrow">marketplace</span>
        <div className="topbar-actions">
          <button className="btn btn-sm btn-primary" onClick={() => navigate('/')}>
            Start a room
          </button>
        </div>
      </header>

      <div className="market-controls">
        <input
          className="input"
          value={q}
          placeholder="Search games, tags, people"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="sorts">
          {SORTS.map((s) => (
            <button key={s.id} className={`chip ${sort === s.id ? 'on' : ''}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {games === null ? (
        <p className="mono dim market-status">Loading…</p>
      ) : games.length === 0 ? (
        <div className="market-empty">
          <p className="phosphor">Nothing published yet.</p>
          <p className="dim">
            Games land here when a room publishes one. Every entry ships its full source — play it,
            download it, or fork it into a room of your own.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Build the first one
          </button>
        </div>
      ) : (
        <ul className="market-grid">
          {games.map((g) => (
            <li key={g.id}>
              <button className="game-card" onClick={() => navigate(`/market/${g.id}`)}>
                <h2>{g.title}</h2>
                {g.tagline && <p className="game-card-line">{g.tagline}</p>}
                <p className="mono dim game-card-meta">
                  {g.modelId} · {g.plays} play{g.plays === 1 ? '' : 's'}
                  {g.remixes ? ` · ${g.remixes} fork${g.remixes === 1 ? '' : 's'}` : ''}
                  {g.parentId ? ' · fork' : ''}
                </p>
                <p className="mono dim">{g.authors.slice(0, 4).join(', ')}</p>
                {g.tags.length > 0 && (
                  <p className="tags">
                    {g.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Detail({ id }: { id: string }) {
  const [meta, setMeta] = useState<GameMeta | null>(null)
  const [lineage, setLineage] = useState<{ id: string; title: string }[]>([])
  const [html, setHtml] = useState<string | null>(null)
  const [tab, setTab] = useState<'play' | 'source'>('play')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    fetch(`/api/games/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setMeta(d.game)
        setLineage(d.lineage || [])
      })
      .catch(() => setMissing(true))
    fetch(`/api/games/${id}/source`)
      .then((r) => r.json())
      .then((d) => setHtml(d.html))
      .catch(() => {})
  }, [id])

  async function openInRoom() {
    const res = await fetch('/api/rooms', { method: 'POST' })
    const { id: code } = await res.json()
    navigate(`/r/${code}?load=${id}`)
  }

  if (missing) {
    return (
      <div className="gate">
        <p className="error mono">That game is not in the library.</p>
        <button className="btn btn-primary" onClick={() => navigate('/market')}>
          Back to the marketplace
        </button>
      </div>
    )
  }

  const solo = { id: 'solo', name: 'You', color: '#8ce99a', index: 0 }

  return (
    <div className="market detail">
      <header className="topbar">
        <button className="wordmark wordmark-xs" onClick={() => navigate('/market')}>
          ← marketplace
        </button>
        <span className="mono eyebrow">{meta?.title || '…'}</span>
        <div className="topbar-actions">
          <button className="btn btn-sm" onClick={() => setTab(tab === 'play' ? 'source' : 'play')}>
            {tab === 'play' ? 'View source' : 'Play'}
          </button>
          <a className="btn btn-sm" href={`/api/games/${id}/download`} download>
            Download
          </a>
          <button className="btn btn-sm btn-primary" onClick={openInRoom}>
            Play with friends
          </button>
        </div>
      </header>

      <div className="detail-body">
        <div className="screen screen-game">
          {tab === 'play' ? (
            html ? (
              <GameFrame solo html={html} version={id} seed={7} me={solo} players={[solo as never]} isHost />
            ) : (
              <div className="empty">
                <p className="mono blink phosphor">LOADING</p>
              </div>
            )
          ) : (
            <pre className="source">{html || ''}</pre>
          )}
        </div>

        <aside className="rail">
          <div className="detail-meta">
            <h1>{meta?.title}</h1>
            {meta?.tagline && <p className="detail-line">{meta.tagline}</p>}
            <p className="mono dim">
              built with {meta?.modelId} · {Math.round((meta?.bytes || 0) / 1024)}kb
            </p>
            {meta?.authors?.length ? (
              <p className="mono dim">by {meta.authors.join(', ')}</p>
            ) : null}
            {meta?.brief && (
              <>
                <p className="mono label">The brief it was built from</p>
                <p className="detail-brief">{meta.brief}</p>
              </>
            )}
            {lineage.length > 1 && (
              <>
                <p className="mono label">Forked from</p>
                <ol className="lineage">
                  {lineage.slice(0, -1).map((l) => (
                    <li key={l.id}>
                      <button className="link" onClick={() => navigate(`/market/${l.id}`)}>
                        {l.title}
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <p className="dim small">
              Open source. The download runs standalone in any browser — edit it, host it, sell it,
              whatever you like.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

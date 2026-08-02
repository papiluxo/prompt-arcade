import { useEffect, useState } from 'react'
import { Home } from './views/Home'
import { Room } from './views/Room'
import { Market } from './views/Market'
import { arcade, useArcade } from './net'

export function navigate(to: string) {
  if (location.pathname === to) return
  history.pushState({}, '', to)
  dispatchEvent(new PopStateEvent('popstate'))
}

function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  return path
}

export function App() {
  const path = usePath()
  const { toasts } = useArcade()

  const roomMatch = path.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/)

  return (
    <>
      {roomMatch ? (
        <Room code={roomMatch[1].toUpperCase()} />
      ) : path.startsWith('/market') ? (
        <Market />
      ) : (
        <Home />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <button key={t.id} className={`toast toast-${t.level}`} onClick={() => arcade.dismissToast(t.id)}>
            {t.text}
          </button>
        ))}
      </div>
    </>
  )
}

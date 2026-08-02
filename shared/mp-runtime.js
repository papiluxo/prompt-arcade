/* Prompt Arcade — MP runtime.
 *
 * Injected into every generated game's sandboxed iframe BEFORE the game's own
 * code runs. It gives the game a tiny host-authoritative multiplayer API and
 * pipes everything to the parent page over postMessage.
 *
 * Contract (must stay in sync with server/prompts.mjs):
 *   MP.me, MP.players, MP.isHost, MP.on, MP.sendInput, MP.setState,
 *   MP.emit, MP.random, MP.ready, MP.log
 */
(function () {
  'use strict'

  var handlers = Object.create(null)
  var parent = window.parent
  var STATE_HZ = 20
  var lastStateSent = 0
  var pendingState = null
  var flushTimer = null

  function post(msg) {
    try {
      parent.postMessage(msg, '*')
    } catch (e) {
      /* parent gone */
    }
  }

  function fire(event) {
    var list = handlers[event]
    if (!list) return
    var args = Array.prototype.slice.call(arguments, 1)
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args)
      } catch (err) {
        reportError(err, 'handler:' + event)
      }
    }
  }

  function reportError(err, where) {
    post({
      t: 'error',
      message: (err && err.message) || String(err),
      stack: (err && err.stack) || '',
      where: where || '',
    })
  }

  /* Identity is injected as a literal ahead of this script, so MP is fully
   * formed before a single line of game code runs. This matters more than it
   * looks: games routinely branch on MP.isHost at the top level, and any
   * default we picked while waiting for a message was wrong for somebody —
   * true stranded guests, false stopped the host from ever simulating. */
  var boot = window.__MP_INIT || null

  // ---- seeded RNG (mulberry32) ------------------------------------------
  var seed = (boot && boot.seed | 0) || 1
  function nextRandom() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  var initialised = !!boot
  var preInit = []

  var MP = {
    me: (boot && boot.me) || { id: 'local', name: 'Player', color: '#8ce99a', index: 0 },
    players: (boot && boot.players) || [],
    isHost: boot ? !!boot.isHost : false,
    playerCount: boot && boot.players ? boot.players.length : 1,

    on: function (event, fn) {
      if (typeof fn !== 'function') return MP
      ;(handlers[event] || (handlers[event] = [])).push(fn)
      return MP
    },

    off: function (event, fn) {
      var list = handlers[event]
      if (!list) return MP
      handlers[event] = list.filter(function (f) {
        return f !== fn
      })
      return MP
    },

    /** Any player -> host. On the host this is delivered locally, instantly. */
    sendInput: function (data) {
      if (!initialised) {
        preInit.push(['input', data])
        return
      }
      if (MP.isHost) {
        fire('input', data, MP.me.id)
        return
      }
      post({ t: 'net', kind: 'input', data: data })
    },

    /** Host -> everyone. Call once per simulation tick with the whole state. */
    setState: function (state) {
      if (!initialised) {
        preInit.push(['state', state])
        return
      }
      if (!MP.isHost) return
      fire('state', state) // local echo so host and clients share a render path
      pendingState = state
      var now = Date.now()
      var gap = 1000 / STATE_HZ
      if (now - lastStateSent >= gap) {
        flushState()
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushState, gap - (now - lastStateSent))
      }
    },

    /** Anyone -> everyone. Fire and forget (sounds, taunts, effects). */
    emit: function (type, data) {
      fire('event', type, data, MP.me.id)
      post({ t: 'net', kind: 'event', type: type, data: data })
    },

    /** Deterministic PRNG seeded per-round. Same sequence on every client. */
    random: nextRandom,

    /** Call once when your game is initialized and drawing. */
    ready: function () {
      post({ t: 'ready' })
    },

    log: function () {
      post({ t: 'log', args: Array.prototype.slice.call(arguments).map(String) })
    },
  }

  function flushState() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (pendingState === null) return
    lastStateSent = Date.now()
    var payload = pendingState
    pendingState = null
    try {
      post({ t: 'net', kind: 'state', data: payload })
    } catch (e) {
      reportError(e, 'setState:serialize')
    }
  }

  // ---- parent -> game ----------------------------------------------------
  window.addEventListener('message', function (ev) {
    var msg = ev.data
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'init':
        MP.me = msg.me
        MP.players = msg.players || []
        MP.playerCount = MP.players.length
        MP.isHost = !!msg.isHost
        seed = msg.seed | 0 || 1
        initialised = true
        // Replay whatever the game tried to send before it knew who it was.
        var queued = preInit
        preInit = []
        for (var q = 0; q < queued.length; q++) {
          if (queued[q][0] === 'input') MP.sendInput(queued[q][1])
          else MP.setState(queued[q][1])
        }
        fire('players', MP.players)
        break
      case 'players':
        MP.players = msg.players || []
        MP.playerCount = MP.players.length
        MP.isHost = !!msg.isHost
        fire('players', MP.players)
        break
      case 'net':
        if (msg.kind === 'input') fire('input', msg.data, msg.from)
        else if (msg.kind === 'state') {
          if (!MP.isHost) fire('state', msg.data)
        } else if (msg.kind === 'event') fire('event', msg.type, msg.data, msg.from)
        break
      case 'reset':
        seed = msg.seed | 0 || 1
        fire('reset')
        break
      case 'fit':
        // The frame changed size (layout settled, sidebar toggled, fullscreen).
        // Games measure window.innerWidth once at boot and often never again,
        // which is how they end up drawn into a corner. Re-poke them.
        fire('resize', msg.w, msg.h)
        try {
          window.dispatchEvent(new Event('resize'))
        } catch (e) {
          /* older engines */
        }
        break
    }
  })

  window.addEventListener('error', function (e) {
    reportError(e.error || { message: e.message }, 'window')
  })
  window.addEventListener('unhandledrejection', function (e) {
    reportError(e.reason || { message: 'unhandled rejection' }, 'promise')
  })

  // Storage APIs throw in a sandboxed opaque origin — stub them so a stray
  // call doesn't kill an otherwise working game.
  try {
    void window.localStorage
  } catch (e) {
    var mem = {}
    var shim = {
      getItem: function (k) {
        return k in mem ? mem[k] : null
      },
      setItem: function (k, v) {
        mem[k] = String(v)
      },
      removeItem: function (k) {
        delete mem[k]
      },
      clear: function () {
        mem = {}
      },
      key: function () {
        return null
      },
      length: 0,
    }
    Object.defineProperty(window, 'localStorage', { value: shim, configurable: true })
    Object.defineProperty(window, 'sessionStorage', { value: shim, configurable: true })
  }

  window.MP = MP
  post({ t: 'boot' })
})()

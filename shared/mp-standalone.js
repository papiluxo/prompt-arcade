/* Prompt Arcade — standalone MP shim.
 *
 * Bundled into games exported from the marketplace so a downloaded .html file
 * opens and plays solo with no server. Same surface as the real runtime; you
 * are always the host and always alone.
 */
(function () {
  'use strict'
  var handlers = Object.create(null)
  var seed = 12345

  function fire(event) {
    var list = handlers[event]
    if (!list) return
    var args = Array.prototype.slice.call(arguments, 1)
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args)
      } catch (e) {
        console.error(e)
      }
    }
  }

  var me = { id: 'solo', name: 'You', color: '#8ce99a', index: 0, isHost: true }

  window.MP = {
    me: me,
    players: [me],
    playerCount: 1,
    isHost: true,
    on: function (e, f) {
      ;(handlers[e] || (handlers[e] = [])).push(f)
      return window.MP
    },
    off: function (e, f) {
      handlers[e] = (handlers[e] || []).filter(function (x) {
        return x !== f
      })
      return window.MP
    },
    sendInput: function (d) {
      fire('input', d, me.id)
    },
    setState: function (s) {
      fire('state', s)
    },
    emit: function (t, d) {
      fire('event', t, d, me.id)
    },
    random: function () {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    ready: function () {},
    log: function () {
      console.log.apply(console, arguments)
    },
  }
  setTimeout(function () {
    fire('players', window.MP.players)
  }, 0)
})()

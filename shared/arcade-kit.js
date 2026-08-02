/* Prompt Arcade — Arcade Kit (AK).
 *
 * Injected into every generated game AFTER the MP runtime and BEFORE the
 * game's own code. It is the game-development floor every game stands on:
 * the pieces that are always the same and always the source of bugs when a
 * model reinvents them — the canvas, the loop, input, the camera, particles,
 * sound, and the in-game menu.
 *
 * The generated game supplies design and simulation. AK supplies engineering.
 *
 * Contract (must stay in sync with server/prompts.mjs):
 *   AK.canvas, AK.view, AK.onResize, AK.loop, AK.input, AK.camera,
 *   AK.draw, AK.stamp, AK.particles, AK.sfx, AK.math, AK.hit, AK.menu
 */
;(function () {
  // Leading semicolon: this file is concatenated after mp-runtime.js inside
  // one <script>, and `})()` + `(function(){})()` would otherwise parse as a
  // call chain.
  'use strict'
  if (window.AK) return

  var AK = {}

  // ---------------------------------------------------------------- view/canvas

  var view = { w: window.innerWidth, h: window.innerHeight, dpr: 1 }
  AK.view = view
  var resizeFns = []
  var managedCanvas = null
  var managedCtx = null

  function applySize() {
    view.w = window.innerWidth
    view.h = window.innerHeight
    view.dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (managedCanvas) {
      managedCanvas.width = Math.max(1, Math.floor(view.w * view.dpr))
      managedCanvas.height = Math.max(1, Math.floor(view.h * view.dpr))
      managedCanvas.style.width = view.w + 'px'
      managedCanvas.style.height = view.h + 'px'
      if (managedCtx) managedCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
    }
    for (var i = 0; i < resizeFns.length; i++) {
      try {
        resizeFns[i](view.w, view.h)
      } catch (e) {
        console.error(e)
      }
    }
  }

  /** Register a resize callback; fires immediately and on every size change. */
  AK.onResize = function (fn) {
    if (typeof fn === 'function') {
      resizeFns.push(fn)
      try {
        fn(view.w, view.h)
      } catch (e) {
        console.error(e)
      }
    }
    return AK
  }

  /**
   * Create (or adopt) the game canvas: fullscreen, DPR-correct, auto-resized
   * forever. Returns { canvas, ctx }. Draw in CSS pixels — AK.view.w/h.
   */
  AK.canvas = function (existing) {
    if (managedCanvas) return { canvas: managedCanvas, ctx: managedCtx }
    var c = existing || document.querySelector('canvas') || document.createElement('canvas')
    if (!c.parentNode) (document.body || document.documentElement).appendChild(c)
    c.style.position = 'absolute'
    c.style.inset = '0'
    c.style.display = 'block'
    managedCanvas = c
    managedCtx = c.getContext('2d')
    applySize()
    return { canvas: c, ctx: managedCtx }
  }

  window.addEventListener('resize', applySize)
  if (window.MP && MP.on) MP.on('resize', applySize)

  // --------------------------------------------------------------------- input

  var keys = Object.create(null)
  var pointer = { x: 0, y: 0, down: false, justDown: false }
  var justPressed = Object.create(null)

  window.addEventListener('keydown', function (e) {
    if (!keys[e.key]) justPressed[e.key] = true
    keys[e.key] = true
    keys[e.code] = true
    // Space/arrows scroll the page in some hosts; games never want that.
    if (e.key === ' ' || e.key.indexOf('Arrow') === 0) e.preventDefault()
  })
  window.addEventListener('keyup', function (e) {
    keys[e.key] = false
    keys[e.code] = false
  })
  window.addEventListener('blur', function () {
    keys = Object.create(null)
    AK.input.keys = keys
    pointer.down = false
  })

  function pointFrom(e) {
    var t = e.touches && e.touches[0] ? e.touches[0] : e
    pointer.x = t.clientX
    pointer.y = t.clientY
  }
  window.addEventListener('pointerdown', function (e) {
    pointFrom(e)
    pointer.down = true
    pointer.justDown = true
  })
  window.addEventListener('pointermove', pointFrom)
  window.addEventListener('pointerup', function () {
    pointer.down = false
  })
  window.addEventListener('pointercancel', function () {
    pointer.down = false
  })

  AK.input = {
    keys: keys,
    pointer: pointer,
    /** True only on the frame the key went down. */
    pressed: function (key) {
      return !!justPressed[key]
    },
    /** WASD + arrows as a normalized {x, y} vector. */
    axis: function () {
      var x = (keys.ArrowRight || keys.d || keys.D ? 1 : 0) - (keys.ArrowLeft || keys.a || keys.A ? 1 : 0)
      var y = (keys.ArrowDown || keys.s || keys.S ? 1 : 0) - (keys.ArrowUp || keys.w || keys.W ? 1 : 0)
      if (x && y) {
        var n = Math.SQRT1_2
        return { x: x * n, y: y * n }
      }
      return { x: x, y: y }
    },
  }

  function endFrameInput() {
    justPressed = Object.create(null)
    pointer.justDown = false
  }

  // ---------------------------------------------------------------------- math

  var mathRandom = window.MP && MP.random ? function () { return MP.random() } : Math.random

  AK.math = {
    lerp: function (a, b, t) {
      return a + (b - a) * t
    },
    clamp: function (v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v
    },
    dist: function (ax, ay, bx, by) {
      var dx = bx - ax
      var dy = by - ay
      return Math.sqrt(dx * dx + dy * dy)
    },
    angle: function (ax, ay, bx, by) {
      return Math.atan2(by - ay, bx - ax)
    },
    /** Wrap v into [0, max). */
    wrap: function (v, max) {
      return ((v % max) + max) % max
    },
    /** Deterministic when MP.random is present (same on every client). */
    rand: function (lo, hi) {
      if (lo === undefined) return mathRandom()
      if (hi === undefined) {
        hi = lo
        lo = 0
      }
      return lo + mathRandom() * (hi - lo)
    },
    pick: function (arr) {
      return arr[Math.floor(mathRandom() * arr.length)]
    },
  }

  // ----------------------------------------------------------------- collision

  AK.hit = {
    /** a, b: {x, y, r} */
    circles: function (a, b) {
      var dx = b.x - a.x
      var dy = b.y - a.y
      var r = (a.r || 0) + (b.r || 0)
      return dx * dx + dy * dy <= r * r
    },
    /** a, b: {x, y, w, h} (top-left origin) */
    rects: function (a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    },
    /** c: {x, y, r}, rect: {x, y, w, h} */
    circleRect: function (c, rect) {
      var cx = AK.math.clamp(c.x, rect.x, rect.x + rect.w)
      var cy = AK.math.clamp(c.y, rect.y, rect.y + rect.h)
      var dx = c.x - cx
      var dy = c.y - cy
      return dx * dx + dy * dy <= (c.r || 0) * (c.r || 0)
    },
  }

  // -------------------------------------------------------------------- camera

  var cam = {
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    zoom: 1,
    tzoom: 1,
    mode: 'free', // free | follow | fit
    fitW: 0,
    fitH: 0,
    lerp: 0.12,
    shakeMag: 0,
    sx: 0,
    sy: 0,
  }

  function camStep(dt) {
    if (cam.mode === 'fit' && cam.fitW > 0) {
      var scale = Math.min(view.w / cam.fitW, view.h / cam.fitH) * 0.94
      cam.tzoom = scale
      cam.tx = cam.fitW / 2
      cam.ty = cam.fitH / 2
    }
    var k = 1 - Math.pow(1 - cam.lerp, dt * 60)
    cam.x += (cam.tx - cam.x) * k
    cam.y += (cam.ty - cam.y) * k
    cam.zoom += (cam.tzoom - cam.zoom) * k
    cam.shakeMag *= Math.pow(0.001, dt) // dies in ~1s
    if (cam.shakeMag < 0.1) cam.shakeMag = 0
    cam.sx = (Math.random() * 2 - 1) * cam.shakeMag
    cam.sy = (Math.random() * 2 - 1) * cam.shakeMag
  }

  AK.camera = {
    /** Follow a world point (usually your own entity). Call every frame. */
    follow: function (x, y, opts) {
      cam.mode = 'follow'
      cam.tx = x
      cam.ty = y
      if (opts && opts.zoom) cam.tzoom = opts.zoom
      if (opts && opts.lerp !== undefined) cam.lerp = opts.lerp
      if (opts && opts.snap) {
        cam.x = x
        cam.y = y
        cam.zoom = cam.tzoom
      }
    },
    /** Fit a whole bounded arena on screen, centred, at any window size. */
    fit: function (worldW, worldH) {
      cam.mode = 'fit'
      cam.fitW = worldW
      cam.fitH = worldH
      if (!cam.x && !cam.y) {
        cam.x = worldW / 2
        cam.y = worldH / 2
        cam.zoom = Math.min(view.w / worldW, view.h / worldH) * 0.94
      }
    },
    /** Clamp the follow camera inside world bounds. Call after follow(). */
    clamp: function (worldW, worldH) {
      var hw = view.w / 2 / cam.zoom
      var hh = view.h / 2 / cam.zoom
      if (worldW > hw * 2) cam.tx = AK.math.clamp(cam.tx, hw, worldW - hw)
      else cam.tx = worldW / 2
      if (worldH > hh * 2) cam.ty = AK.math.clamp(cam.ty, hh, worldH - hh)
      else cam.ty = worldH / 2
    },
    shake: function (mag) {
      cam.shakeMag = Math.max(cam.shakeMag, mag || 8)
    },
    /** Wrap world drawing: begin() ... draw in world coords ... end(). */
    begin: function (ctx) {
      ctx.save()
      ctx.translate(view.w / 2 + cam.sx, view.h / 2 + cam.sy)
      ctx.scale(cam.zoom, cam.zoom)
      ctx.translate(-cam.x, -cam.y)
    },
    end: function (ctx) {
      ctx.restore()
    },
    /** Screen (CSS px) -> world coordinates. For aiming with the pointer. */
    toWorld: function (px, py) {
      return {
        x: (px - view.w / 2 - cam.sx) / cam.zoom + cam.x,
        y: (py - view.h / 2 - cam.sy) / cam.zoom + cam.y,
      }
    },
    raw: cam,
  }

  // ---------------------------------------------------------------------- loop

  var loopState = { running: false, paused: false, update: null, render: null, last: 0, acc: 0 }
  var STEP = 1 / 60
  var MAX_FRAME = 0.25

  function frame(now) {
    if (!loopState.running) return
    requestAnimationFrame(frame)
    var dt = Math.min(MAX_FRAME, (now - loopState.last) / 1000 || 0)
    loopState.last = now
    if (loopState.paused) {
      endFrameInput()
      return
    }
    loopState.acc += dt
    var guard = 0
    while (loopState.acc >= STEP && guard < 8) {
      try {
        if (loopState.update) loopState.update(STEP)
      } catch (e) {
        loopError(e)
      }
      stepParticles(STEP)
      loopState.acc -= STEP
      guard++
    }
    if (guard === 8) loopState.acc = 0
    camStep(dt)
    try {
      if (loopState.render) loopState.render(dt)
    } catch (e) {
      loopError(e)
    }
    endFrameInput()
  }

  var reportedLoopErrors = 0
  function loopError(e) {
    // Surface the first few, then go quiet — a broken frame handler at 60Hz
    // must not flood the fault log.
    if (reportedLoopErrors++ < 5) {
      console.error(e)
      if (window.MP && MP.log) MP.log('loop error: ' + (e && e.message))
      setTimeout(function () {
        throw e
      }, 0)
    }
  }

  /**
   * Start the game loop. update(dt) runs at a fixed 60Hz — put simulation
   * here (host) and prediction/interpolation timers (everyone). render(dt)
   * runs once per display frame — draw everything here.
   *
   *   AK.loop({ update: (dt) => {...}, render: () => {...} })
   */
  AK.loop = function (opts) {
    loopState.update = opts && opts.update
    loopState.render = opts && opts.render
    if (!loopState.running) {
      loopState.running = true
      loopState.last = performance.now()
      requestAnimationFrame(frame)
    }
    return AK.loop
  }
  Object.defineProperty(AK.loop, 'paused', {
    get: function () {
      return loopState.paused
    },
    set: function (v) {
      loopState.paused = !!v
      if (!v) loopState.last = performance.now()
    },
  })

  // ---------------------------------------------------------------------- draw

  AK.draw = {
    clear: function (ctx, color) {
      ctx.save()
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
      ctx.fillStyle = color || '#0b0e1a'
      ctx.fillRect(0, 0, view.w, view.h)
      ctx.restore()
    },
    circle: function (ctx, x, y, r, color) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    },
    ring: function (ctx, x, y, r, color, width) {
      ctx.strokeStyle = color
      ctx.lineWidth = width || 2
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.stroke()
    },
    rect: function (ctx, x, y, w, h, color) {
      ctx.fillStyle = color
      ctx.fillRect(x, y, w, h)
    },
    line: function (ctx, x1, y1, x2, y2, color, width) {
      ctx.strokeStyle = color
      ctx.lineWidth = width || 2
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    },
    poly: function (ctx, points, color) {
      if (!points || points.length < 3) return
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(points[0][0], points[0][1])
      for (var i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1])
      ctx.closePath()
      ctx.fill()
    },
    text: function (ctx, str, x, y, opts) {
      opts = opts || {}
      ctx.save()
      ctx.font =
        (opts.weight || 700) +
        ' ' +
        (opts.size || 16) +
        'px ' +
        (opts.font || 'system-ui, sans-serif')
      ctx.fillStyle = opts.color || '#fff'
      ctx.textAlign = opts.align || 'center'
      ctx.textBaseline = opts.baseline || 'middle'
      if (opts.shadow !== false) {
        ctx.shadowColor = 'rgba(0,0,0,.55)'
        ctx.shadowBlur = 4
        ctx.shadowOffsetY = 1
      }
      ctx.fillText(str, x, y)
      ctx.restore()
    },
    /** Soft radial glow — cheap juice for pickups, engines, explosions. */
    glow: function (ctx, x, y, r, color, alpha) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, color)
      g.addColorStop(1, 'transparent')
      ctx.save()
      ctx.globalAlpha = alpha === undefined ? 0.5 : alpha
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
      ctx.restore()
    },
  }

  // -------------------------------------------------------------------- stamps
  // Procedural vector sprites. One call = one recognizable game asset, drawn
  // with real silhouettes instead of "everything is a circle".

  var STAMPS = {
    ship: function (c) {
      c.beginPath()
      c.moveTo(1, 0)
      c.lineTo(-0.7, 0.65)
      c.lineTo(-0.35, 0)
      c.lineTo(-0.7, -0.65)
      c.closePath()
      c.fill()
    },
    tank: function (c) {
      c.fillRect(-0.8, -0.6, 1.6, 1.2)
      c.fillRect(-0.9, -0.85, 1.8, 0.28)
      c.fillRect(-0.9, 0.57, 1.8, 0.28)
      c.fillRect(-0.1, -0.16, 1.15, 0.32)
      c.beginPath()
      c.arc(0, 0, 0.42, 0, Math.PI * 2)
      c.fill()
    },
    star: function (c) {
      c.beginPath()
      for (var i = 0; i < 10; i++) {
        var r = i % 2 ? 0.45 : 1
        var a = (i / 10) * Math.PI * 2 - Math.PI / 2
        c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
      }
      c.closePath()
      c.fill()
    },
    heart: function (c) {
      c.beginPath()
      c.moveTo(0, 0.95)
      c.bezierCurveTo(-1.25, 0.05, -0.65, -0.95, 0, -0.35)
      c.bezierCurveTo(0.65, -0.95, 1.25, 0.05, 0, 0.95)
      c.fill()
    },
    skull: function (c) {
      c.beginPath()
      c.arc(0, -0.15, 0.75, 0, Math.PI * 2)
      c.fill()
      c.fillRect(-0.45, 0.3, 0.9, 0.55)
      c.save()
      c.globalCompositeOperation = 'destination-out'
      c.beginPath()
      c.arc(-0.3, -0.2, 0.22, 0, Math.PI * 2)
      c.arc(0.3, -0.2, 0.22, 0, Math.PI * 2)
      c.fill()
      c.fillRect(-0.34, 0.42, 0.16, 0.4)
      c.fillRect(0.02, 0.42, 0.16, 0.4)
      c.fillRect(-0.07, 0.05, 0.14, 0.3)
      c.restore()
    },
    crown: function (c) {
      c.beginPath()
      c.moveTo(-0.9, 0.6)
      c.lineTo(-0.9, -0.3)
      c.lineTo(-0.45, 0.15)
      c.lineTo(0, -0.65)
      c.lineTo(0.45, 0.15)
      c.lineTo(0.9, -0.3)
      c.lineTo(0.9, 0.6)
      c.closePath()
      c.fill()
    },
    bolt: function (c) {
      c.beginPath()
      c.moveTo(0.2, -1)
      c.lineTo(-0.55, 0.15)
      c.lineTo(-0.05, 0.15)
      c.lineTo(-0.2, 1)
      c.lineTo(0.55, -0.15)
      c.lineTo(0.05, -0.15)
      c.closePath()
      c.fill()
    },
    gem: function (c) {
      c.beginPath()
      c.moveTo(0, 1)
      c.lineTo(-0.85, -0.25)
      c.lineTo(-0.45, -0.8)
      c.lineTo(0.45, -0.8)
      c.lineTo(0.85, -0.25)
      c.closePath()
      c.fill()
    },
    ghost: function (c) {
      c.beginPath()
      c.arc(0, -0.15, 0.7, Math.PI, 0)
      c.lineTo(0.7, 0.75)
      c.lineTo(0.42, 0.5)
      c.lineTo(0.14, 0.78)
      c.lineTo(-0.14, 0.5)
      c.lineTo(-0.42, 0.78)
      c.lineTo(-0.7, 0.5)
      c.closePath()
      c.fill()
    },
    coin: function (c) {
      c.beginPath()
      c.arc(0, 0, 0.9, 0, Math.PI * 2)
      c.fill()
      c.save()
      c.globalAlpha = 0.35
      c.fillStyle = '#000'
      c.beginPath()
      c.arc(0, 0, 0.58, 0, Math.PI * 2)
      c.fill()
      c.restore()
    },
    flag: function (c) {
      c.fillRect(-0.08, -1, 0.16, 2)
      c.beginPath()
      c.moveTo(0.08, -1)
      c.lineTo(1, -0.6)
      c.lineTo(0.08, -0.2)
      c.closePath()
      c.fill()
    },
    crosshair: function (c) {
      c.lineWidth = 0.16
      c.strokeStyle = c.fillStyle
      c.beginPath()
      c.arc(0, 0, 0.7, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.moveTo(0, -1)
      c.lineTo(0, -0.4)
      c.moveTo(0, 1)
      c.lineTo(0, 0.4)
      c.moveTo(-1, 0)
      c.lineTo(-0.4, 0)
      c.moveTo(1, 0)
      c.lineTo(0.4, 0)
      c.stroke()
    },
  }

  /**
   * Draw a vector sprite. kind: ship|tank|star|heart|skull|crown|bolt|gem|
   * ghost|coin|flag|crosshair. opts: {x, y, r, color, angle, alpha}.
   * r is the sprite's radius in world units.
   */
  AK.stamp = function (ctx, kind, opts) {
    var fn = STAMPS[kind]
    if (!fn) return
    ctx.save()
    ctx.translate(opts.x || 0, opts.y || 0)
    ctx.rotate(opts.angle || 0)
    var r = opts.r || 12
    ctx.scale(r, r)
    ctx.fillStyle = opts.color || '#fff'
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha
    fn(ctx)
    ctx.restore()
  }

  // ----------------------------------------------------------------- particles

  var MAX_PARTICLES = 600
  var particles = []

  function stepParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i]
      p.life -= dt
      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1]
        particles.pop()
        continue
      }
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += p.gravity * dt
      p.vx *= Math.pow(p.drag, dt * 60)
      p.vy *= Math.pow(p.drag, dt * 60)
    }
  }

  AK.particles = {
    /**
     * burst({x, y, color, count, speed, life, size, gravity, spread, angle})
     * World-space. Draw them inside camera.begin()/end().
     */
    burst: function (o) {
      var count = Math.min(o.count || 12, MAX_PARTICLES - particles.length)
      for (var i = 0; i < count; i++) {
        var a = o.angle !== undefined
          ? o.angle + (Math.random() - 0.5) * (o.spread === undefined ? 0.6 : o.spread)
          : Math.random() * Math.PI * 2
        var sp = (o.speed || 120) * (0.4 + Math.random() * 0.8)
        particles.push({
          x: o.x,
          y: o.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: (o.life || 0.6) * (0.6 + Math.random() * 0.6),
          max: o.life || 0.6,
          size: (o.size || 3) * (0.6 + Math.random() * 0.8),
          color: o.color || '#fff',
          gravity: o.gravity || 0,
          drag: o.drag === undefined ? 0.96 : o.drag,
        })
      }
    },
    draw: function (ctx) {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i]
        ctx.globalAlpha = Math.max(0, p.life / p.max)
        ctx.fillStyle = p.color
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      }
      ctx.globalAlpha = 1
    },
    clear: function () {
      particles.length = 0
    },
    count: function () {
      return particles.length
    },
  }

  // ----------------------------------------------------------------------- sfx
  // WebAudio synthesis. No assets, autoplay-safe: the context resumes itself
  // on the first user gesture.

  var audio = { ctx: null, muted: false, master: null }

  function ac() {
    if (audio.ctx) return audio.ctx
    var Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    audio.ctx = new Ctx()
    audio.master = audio.ctx.createGain()
    audio.master.gain.value = 0.35
    audio.master.connect(audio.ctx.destination)
    return audio.ctx
  }
  function unlock() {
    var c = ac()
    if (c && c.state === 'suspended') c.resume()
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)

  /** tone(freqFrom, freqTo, duration, type, volume) */
  function tone(f0, f1, dur, type, vol) {
    if (audio.muted) return
    var c = ac()
    if (!c || c.state === 'suspended') return
    var t = c.currentTime
    var osc = c.createOscillator()
    var g = c.createGain()
    osc.type = type || 'square'
    osc.frequency.setValueAtTime(Math.max(20, f0), t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    g.gain.setValueAtTime(vol || 0.5, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(g)
    g.connect(audio.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  function noise(dur, vol, lowpass) {
    if (audio.muted) return
    var c = ac()
    if (!c || c.state === 'suspended') return
    var t = c.currentTime
    var len = Math.max(1, Math.floor(c.sampleRate * dur))
    var buf = c.createBuffer(1, len, c.sampleRate)
    var data = buf.getChannelData(0)
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    var src = c.createBufferSource()
    src.buffer = buf
    var g = c.createGain()
    g.gain.value = vol || 0.4
    var f = c.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = lowpass || 1200
    src.connect(f)
    f.connect(g)
    g.connect(audio.master)
    src.start(t)
  }

  AK.sfx = {
    blip: function () {
      tone(880, 1320, 0.07, 'square', 0.25)
    },
    shoot: function () {
      tone(900, 220, 0.12, 'sawtooth', 0.3)
    },
    jump: function () {
      tone(300, 700, 0.14, 'square', 0.3)
    },
    pickup: function () {
      tone(660, 880, 0.06, 'square', 0.25)
      setTimeout(function () {
        tone(880, 1320, 0.09, 'square', 0.25)
      }, 60)
    },
    hit: function () {
      tone(220, 80, 0.15, 'sawtooth', 0.4)
      noise(0.12, 0.25, 900)
    },
    boom: function () {
      tone(160, 40, 0.4, 'sawtooth', 0.5)
      noise(0.4, 0.5, 700)
    },
    win: function () {
      ;[523, 659, 784, 1047].forEach(function (f, i) {
        setTimeout(function () {
          tone(f, f, 0.16, 'square', 0.3)
        }, i * 110)
      })
    },
    lose: function () {
      ;[392, 330, 262, 196].forEach(function (f, i) {
        setTimeout(function () {
          tone(f, f * 0.97, 0.2, 'sawtooth', 0.3)
        }, i * 130)
      })
    },
    tick: function () {
      tone(1200, 1200, 0.03, 'square', 0.15)
    },
  }
  Object.defineProperty(AK.sfx, 'muted', {
    get: function () {
      return audio.muted
    },
    set: function (v) {
      audio.muted = !!v
    },
  })

  // ---------------------------------------------------------------------- menu
  // The in-game menu every game ships: Escape + corner button, controls table,
  // how-to-play, restart, sound toggle. Styled once, professionally, for all
  // games. In single player it pauses the loop; in multiplayer it overlays a
  // live game. Also shows a fading controls strip when the game starts.

  var menu = { open: false, opts: null, root: null, strip: null }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

  var MENU_CSS =
    '.ak-btn{position:fixed;top:12px;right:12px;z-index:9000;background:rgba(10,12,24,.72);' +
    'color:#dfe3ff;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 12px;' +
    "font:600 12px/1 system-ui,sans-serif;letter-spacing:.12em;cursor:pointer;backdrop-filter:blur(6px)}" +
    '.ak-btn:hover{background:rgba(30,34,60,.85);border-color:rgba(255,255,255,.35)}' +
    '.ak-scrim{position:fixed;inset:0;z-index:9001;background:rgba(4,5,12,.62);backdrop-filter:blur(4px);' +
    'display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}' +
    '.ak-panel{min-width:300px;max-width:440px;max-height:82vh;overflow:auto;background:#0d1020;' +
    'border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:22px 24px;color:#e8ebff;' +
    'box-shadow:0 24px 80px rgba(0,0,0,.6)}' +
    '.ak-panel h1{margin:0 0 2px;font-size:20px;letter-spacing:.04em}' +
    '.ak-panel .ak-how{margin:6px 0 14px;font-size:13px;line-height:1.5;color:#9aa3c7}' +
    '.ak-panel h2{margin:14px 0 6px;font-size:11px;letter-spacing:.18em;color:#8890b5;text-transform:uppercase}' +
    '.ak-controls{width:100%;border-collapse:collapse;font-size:13px}' +
    '.ak-controls td{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.07)}' +
    '.ak-controls td:first-child{width:44%}' +
    '.ak-key{display:inline-block;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);' +
    'border-radius:5px;padding:2px 8px;font:600 11px/1.5 ui-monospace,monospace}' +
    '.ak-row{display:flex;gap:10px;margin-top:18px}' +
    '.ak-row button{flex:1;padding:9px 0;border-radius:8px;border:1px solid rgba(255,255,255,.16);' +
    'background:rgba(255,255,255,.06);color:#e8ebff;font:600 12px system-ui,sans-serif;' +
    'letter-spacing:.08em;cursor:pointer}' +
    '.ak-row button:hover{background:rgba(255,255,255,.14)}' +
    '.ak-row .ak-primary{background:#4c5df9;border-color:#4c5df9}' +
    '.ak-row .ak-primary:hover{background:#5f6ffa}' +
    '.ak-strip{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:8999;' +
    'display:flex;gap:14px;align-items:center;background:rgba(8,10,20,.72);border:1px solid rgba(255,255,255,.12);' +
    'border-radius:10px;padding:8px 16px;font:500 12px system-ui,sans-serif;color:#c9cfec;' +
    'backdrop-filter:blur(6px);transition:opacity .8s;white-space:nowrap}' +
    '.ak-strip .ak-key{margin-right:6px}'

  function buildMenu() {
    var o = menu.opts
    var scrim = el('div', 'ak-scrim')
    var panel = el('div', 'ak-panel')

    panel.appendChild(el('h1', null, o.title || document.title || 'GAME'))
    if (o.how) panel.appendChild(el('div', 'ak-how', o.how))

    if (o.controls && o.controls.length) {
      panel.appendChild(el('h2', null, 'Controls'))
      var table = el('table', 'ak-controls')
      for (var i = 0; i < o.controls.length; i++) {
        var tr = el('tr')
        var td1 = el('td')
        var kbd = el('span', 'ak-key', o.controls[i][0])
        td1.appendChild(kbd)
        var td2 = el('td', null, o.controls[i][1])
        tr.appendChild(td1)
        tr.appendChild(td2)
        table.appendChild(tr)
      }
      panel.appendChild(table)
    }

    var row = el('div', 'ak-row')
    if (o.onRestart) {
      var restart = el('button', null, 'RESTART')
      restart.onclick = function () {
        closeMenu()
        try {
          o.onRestart()
        } catch (e) {
          console.error(e)
        }
      }
      row.appendChild(restart)
    }
    var sound = el('button', null, audio.muted ? 'SOUND: OFF' : 'SOUND: ON')
    sound.onclick = function () {
      audio.muted = !audio.muted
      sound.textContent = audio.muted ? 'SOUND: OFF' : 'SOUND: ON'
    }
    row.appendChild(sound)
    var close = el('button', 'ak-primary', 'CLOSE')
    close.onclick = closeMenu
    row.appendChild(close)
    panel.appendChild(row)

    scrim.appendChild(panel)
    scrim.onclick = function (e) {
      if (e.target === scrim) closeMenu()
    }
    panel.onclick = function (e) {
      e.stopPropagation()
    }
    return scrim
  }

  function openMenu() {
    if (menu.open || !menu.opts) return
    menu.open = true
    menu.root = buildMenu()
    document.body.appendChild(menu.root)
    if (menu.opts.pause) loopState.paused = true
    hideStrip()
  }
  function closeMenu() {
    if (!menu.open) return
    menu.open = false
    if (menu.root && menu.root.parentNode) menu.root.parentNode.removeChild(menu.root)
    menu.root = null
    if (menu.opts.pause) loopState.paused = false
  }
  function hideStrip() {
    if (menu.strip) {
      var s = menu.strip
      menu.strip = null
      s.style.opacity = '0'
      setTimeout(function () {
        if (s.parentNode) s.parentNode.removeChild(s)
      }, 900)
    }
  }

  /**
   * Install the in-game menu (call once at boot):
   *
   *   AK.menu({
   *     title: 'ORBIT DUEL',
   *     how: 'Sling your ship around the star. Last one alive wins.',
   *     controls: [['WASD / Arrows', 'Steer'], ['Space', 'Boost'], ['Esc', 'Menu']],
   *     onRestart: () => MP.emit('restart'),   // omit to hide the button
   *     pause: MP.playerCount <= 1,            // pause the loop while open
   *   })
   *
   * Adds the ⚙ MENU corner button, binds Escape, and shows the controls as a
   * strip along the bottom for the first seconds of play, then fades it out.
   */
  AK.menu = function (opts) {
    menu.opts = opts || {}

    if (!document.getElementById('ak-style')) {
      var style = el('style')
      style.id = 'ak-style'
      style.textContent = MENU_CSS
      document.head.appendChild(style)
    }

    if (!menu.btn) {
      var btn = el('button', 'ak-btn', 'MENU')
      btn.onclick = function () {
        menu.open ? closeMenu() : openMenu()
      }
      document.body.appendChild(btn)
      menu.btn = btn
      window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') menu.open ? closeMenu() : openMenu()
      })
    }

    // The fading controls strip. Multiplayer starts mid-action, so this is
    // how players learn the keys without a panel blocking a live game.
    if (opts.controls && opts.controls.length && !menu.strip) {
      var strip = el('div', 'ak-strip')
      for (var i = 0; i < Math.min(4, opts.controls.length); i++) {
        var item = el('span')
        item.appendChild(el('span', 'ak-key', opts.controls[i][0]))
        item.appendChild(document.createTextNode(opts.controls[i][1]))
        strip.appendChild(item)
      }
      document.body.appendChild(strip)
      menu.strip = strip
      setTimeout(hideStrip, 7000)
    }
    return AK
  }
  AK.menu.open = openMenu
  AK.menu.close = closeMenu

  window.AK = AK
})()

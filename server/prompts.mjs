/* Prompt assembly for game generation, remixing and repair.
 *
 * The MP API described here is implemented by shared/mp-runtime.js, and the
 * AK API by shared/arcade-kit.js. If you change one, change the other.
 */

const MP_API = `
## The MP API (already loaded before your code runs — never redefine it)

    MP.me            {id, name, color, index}      — this client's player
    MP.players       [{id, name, color, index, isHost}]  — live roster, ordered
    MP.playerCount   number of connected players
    MP.isHost        true on exactly one client; that client owns the simulation

    MP.on('players', players => {})        roster changed (joins, leaves, host moved)
    MP.on('input',  (data, fromId) => {})  HOST ONLY: a player's input arrived
    MP.on('state',  state => {})           authoritative state to render
    MP.on('event',  (type, data, fromId) => {})   custom broadcast from anyone
    MP.on('reset',  () => {})              a player hit Restart — reset the round
    MP.on('resize', (w, h) => {})          the frame changed size (also fires a
                                           normal window 'resize' event)

    MP.sendInput(data)   // any client -> host. On the host it is delivered instantly, locally.
    MP.setState(state)   // HOST ONLY -> everyone. Send the whole JSON-safe state each tick.
                         // It is throttled on the wire and echoed locally, so the host
                         // receives its own 'state' events too.
    MP.emit(type, data)  // anyone -> everyone. Fire and forget (sfx, taunts, particles).
    MP.random()          // seeded PRNG, deterministic per round
    MP.ready()           // call ONCE when your game is initialized and drawing
    MP.log(...)          // debug output to the arcade console
`.trim()

const AK_API = `
## The Arcade Kit — AK (already loaded, like MP — never redefine it)

AK is the engineering floor under every arcade game: the canvas, the loop,
input, the camera, particles, sound and the menu are SOLVED. Use them. Games
that hand-roll these are the games that ship broken.

**Canvas + loop — mandatory for every 2D game:**

    const { canvas, ctx } = AK.canvas()   // fullscreen, DPR-correct, auto-resizes forever
    // Draw in CSS pixels: the current size is AK.view.w x AK.view.h.
    AK.loop({
      update(dt) { /* fixed 60Hz. Host simulation goes here. dt = 1/60 */ },
      render()   { /* once per display frame. ALL drawing goes here */ },
    })
    AK.loop.paused = true|false            // pausing (menu does this for you in solo)

For 3D (THREE), skip AK.canvas and use AK.onResize((w, h) => { renderer.setSize(w, h);
camera.aspect = w/h; camera.updateProjectionMatrix() }) — it fires immediately and
on every size change.

**Input — never write your own key handlers:**

    AK.input.keys['ArrowUp']    // live key state, by e.key and e.code
    AK.input.axis()             // WASD+arrows as normalized {x, y}
    AK.input.pressed('Space')   // true only on the frame it went down
    AK.input.pointer            // {x, y, down, justDown} in CSS pixels

**Camera — pick one mode, in render():**

    AK.camera.follow(me.x, me.y)             // world bigger than the screen
    AK.camera.clamp(worldW, worldH)          //   keep it inside the world
    AK.camera.fit(worldW, worldH)            // OR: whole arena on screen, centred
    AK.camera.shake(10)                      // impacts
    AK.camera.begin(ctx)                     // then draw the WORLD in world coords
      ...world drawing, AK.particles.draw(ctx)...
    AK.camera.end(ctx)                       // then draw the HUD in screen coords
    AK.camera.toWorld(AK.input.pointer.x, AK.input.pointer.y)   // aiming

**Menu — call once at boot; this satisfies the menu requirement:**

    AK.menu({
      title: 'YOUR GAME NAME',
      how: 'One or two sentences: the goal and how you win.',
      controls: [['WASD / Arrows', 'Move'], ['Space', 'Fire'], ['Esc', 'Menu']],
      onRestart: () => MP.sendInput({ restart: true }),  // host: on restart input, reset the round
      pause: MP.playerCount <= 1,   // pause while open in solo; never pause a live MP round
    })

It installs the Escape binding, a corner MENU button, the controls table, a
sound toggle, and a controls strip that shows at round start then fades.

**Juice — free, use liberally:**

    AK.stamp(ctx, 'ship', {x, y, r: 14, color: p.color, angle})   // real silhouettes:
      // ship tank star heart skull crown bolt gem ghost coin flag crosshair
    AK.particles.burst({x, y, color: '#ffd43b', count: 20, speed: 160, life: 0.5})
    AK.draw.text(ctx, 'ROUND 2', AK.view.w/2, 80, {size: 42, color: '#fff'})
    AK.draw.circle / rect / ring / line / poly / glow / clear(ctx, '#0b0e1a')
    AK.sfx.blip() shoot() jump() pickup() hit() boom() win() lose() tick()
    AK.math.lerp clamp dist angle wrap rand(lo,hi) pick(arr)
    AK.hit.circles(a, b) rects(a, b) circleRect(c, rect)   // {x,y,r} / {x,y,w,h}

AK.sfx is WebAudio synthesis — there are no audio files and you need none.
AK.math.rand uses the seeded MP.random, so it is deterministic per round.
`.trim()

const ARCHITECTURE = `
## Required architecture: host-authoritative with one render path

Every client runs the same file. The host simulates; everyone renders whatever
arrives in 'state'. Follow this shape exactly — it is the only netcode pattern
that works here.

    const inputs = {}   // playerId -> latest input, host-side only

    // 1. EVERY client: capture local input, ship it up.
    //    Send on change, or every frame — both are fine.
    MP.sendInput({ up: keys.ArrowUp, down: keys.ArrowDown, fire: keys.Space })

    // 2. HOST ONLY: collect inputs, run the simulation, publish state.
    MP.on('input', (data, fromId) => { inputs[fromId] = data })

    function tick(dt) {
      if (!MP.isHost) return
      for (const p of MP.players) applyInput(state, p.id, inputs[p.id] || {})
      stepPhysics(state, dt)
      MP.setState(state)          // -> everyone, including this client
    }

    // 3. EVERY client: render only from the state you were given.
    let view = null
    MP.on('state', s => { view = s })
    function frame() { if (view) draw(view); requestAnimationFrame(frame) }

Rules that follow from this:
- Clients NEVER mutate game state locally. They send input and draw 'view'.
  (Interpolating positions between states for smoothness is fine and encouraged.)
- The host must build state for MP.players as it exists each tick. Players join
  and leave mid-game: spawn a newcomer on the next tick, drop a leaver's entity.
- Everything in state must survive JSON.stringify. No functions, no Infinity/NaN,
  no canvas objects, no Maps or Sets. Keep it small — it ships 20x a second.
- Show something immediately. Draw a title/waiting screen before the first state
  arrives so the game never looks dead.
- If MP.playerCount is 1, the game must still be playable solo.
`.trim()

const LOBBY_RULES = `
## Open on a lobby, then never block anyone again

The first thing every player sees is a lobby screen, rendered from the shared
state so everyone sees the same thing at the same time:

- The live roster: every player in MP.players, each in their own colour, with
  a marker showing which one is you (MP.me.id). People appear and disappear
  from this list as they arrive and leave, without a refresh.
- The game's name and one line on how to play.
- A START button plus "press Space to start".

The lobby is the ONE screen that gates play, and it is governed by rules that
make it impossible for anyone to get stuck behind it:

- ANY player can start the round. Not the host — anyone. The button is live on
  every screen. Send it as input (\`MP.sendInput({ start: true })\`) or via
  \`MP.emit('start')\`, and let the host flip \`state.phase\` to 'playing'.
  Never write \`if (MP.isHost)\` around the start control.
- The phase lives in the shared state and nowhere else:
  \`state.phase = 'lobby' | 'playing' | 'over'\`. Every client renders whichever
  phase the state says. A client must NEVER decide its own phase locally, or it
  will sit in a lobby while everyone else is playing — the exact bug this rule
  exists to prevent.
- Anyone who joins after the round has started goes STRAIGHT into the live
  round. They never see the lobby. Since phase comes from state, this is
  automatic — just make sure you spawn them.
- If the round ends, everyone returns to the lobby together, again by state.
- Nobody has to "ready up" for the round to be startable. One press starts it.

Sanity check: if a player's browser loads while a round is already running, do
they end up playing within a second, without pressing anything? If not, the
phase is not coming from state and it is wrong.`.trim()

const SOLO_LOBBY_RULES = `
## Open on a start screen

The first thing the player sees is a title screen: the game's name, one line on
how to play, the controls, and a START button plus "press Space to start".
Nothing runs until they start it. When a run ends, show the score and offer an
immediate restart on the same screen.`.trim()

const CAMERA_RULES = `
## Centre the view on the player looking at it

Each player is looking at their own screen and must see their own character,
centred and in frame. Use AK.camera — never hand-roll transforms:

- World bigger than one screen → \`AK.camera.follow(me.x, me.y)\` each render,
  then \`AK.camera.clamp(worldW, worldH)\` so it never scrolls past the level.
- One bounded arena everyone shares → \`AK.camera.fit(worldW, worldH)\` once.
- Wrap ALL world drawing in \`AK.camera.begin(ctx)\` … \`AK.camera.end(ctx)\`,
  and draw the HUD after end(), in screen coordinates.

Either way:
- The local player (view.entities[MP.me.id]) must ALWAYS be visible. If they
  can go off screen, the camera is wrong.
- Mark the local player clearly — a ring, an arrow, "YOU" — so a player can
  find themselves instantly among identical-looking entities.
- In 3D, the camera belongs to the local player: position it behind or on
  \`view.entities[MP.me.id]\` and look where they are looking. Never leave every
  client sharing one fixed camera.
`.trim()

const EVERYONE_PLAYS = `
## Everyone plays. This is the rule games get wrong most.

The players are in a room together and the game appears on all their screens at
once. There is no matchmaking, no invite code and no per-player join step — the
lobby described above is shared, and any one press starts it for everybody.

Hard requirements:

- The host spawns an entity for EVERY id in MP.players, and does it from the
  state it builds each tick — not once at boot. Someone whose browser loads
  three seconds late must simply appear, already playing.
- Build entities by player id, never by join order:
      for (const p of MP.players) {
        if (!state.entities[p.id]) state.entities[p.id] = spawn(p)
      }
      for (const id of Object.keys(state.entities)) {
        if (!MP.players.some(p => p.id === id)) delete state.entities[id]
      }
- EVERY client sends input from the first frame. Never wrap input handling in
  \`if (MP.isHost)\`. A guest pressing a key must move their own entity.
- Never gate a control on being the host. If the round needs starting,
  restarting or skipping, ANY player can do it — send it as input or MP.emit
  and let the host act on it. Better still, start automatically after a short
  countdown so nobody has to press anything.
- The round runs continuously. Do not wait for "all players ready".
- Draw the roster on screen — every player's name in their own colour, with
  their score — so each person can find themselves immediately.
- A guest who joins mid-round joins mid-round. Never make them wait for the
  next one.

Sanity check before you finish: if a second player opened this on their laptop
right now and pressed the arrow keys, would something of theirs move on screen,
with no clicking first? If not, it is broken.
`.trim()

const SOLO_RULES = `
## Single player

Each person in the room gets their own private copy of this game. Nothing is
shared and nothing is synchronised — no other players appear, no netcode.

- Build it as an ordinary single-player browser game.
- MP still exists but the only calls you need are MP.ready() when you are
  initialised, and MP.random() if you want the seeded PRNG. Do not call
  MP.setState or MP.sendInput, and do not reference MP.players.
- Make it a real solo experience: escalating difficulty, a score to beat,
  enemies or obstacles with behaviour, and a reason to immediately replay.
- Show the score and any run stats on screen at all times.
`.trim()

const MENU_RULES = `
## Every game ships a menu. No exceptions.

Call \`AK.menu({...})\` once at boot with the real title, a real how-to line,
and the COMPLETE control list — every key and mouse/touch action the game
reads. That satisfies the requirement: Escape binding, corner MENU button,
controls table, sound toggle, restart button, and the fading controls strip
all come with it.

- Wire \`onRestart\` so it works: send a restart input/event and have the host
  reset the round when it arrives.
- \`pause: MP.playerCount <= 1\` — pause solo play while the menu is open, but
  never pause a live multiplayer round (other people are still playing).
- Do NOT build your own menu panel on top of it.
`.trim()

const OUTPUT_RULES = `
## Output rules — these are hard requirements

1. Reply with ONE complete HTML document and nothing else. No prose before or
   after, no explanation. Start at <!doctype html> and end at </html>. Wrapping
   it in a single \`\`\`html fence is acceptable.
2. Fully self-contained: all CSS and JS inline. NO external resources of any
   kind — no CDN scripts, no web fonts, no image URLs, no fetch(), no
   XMLHttpRequest, no WebSocket, no import from a URL. The page runs in a
   sandbox with no network. Draw art procedurally (canvas/CSS/SVG/emoji) and
   synthesize sound with the WebAudio API.
3. Do not use localStorage, sessionStorage, alert(), confirm() or prompt().
4. Do not create iframes and do not redefine MP.
5. Call MP.ready() exactly once, after your game is initialized.
6. FILL THE FRAME: every 2D game uses AK.canvas() + AK.loop() — never create
   or size a canvas by hand, never write your own requestAnimationFrame loop,
   never hard-code dimensions. Lay the playfield out from AK.view.w/h (or the
   world size + AK.camera), never from constants captured once at load. In 3D,
   size the renderer with AK.onResize. html/body get margin 0, overflow
   hidden, dark background. Support keyboard and pointer/touch.
7. List every control in AK.menu; show anything else critical on the lobby
   screen.
8. It must run from a cold start with zero console errors. No syntax errors, no
   references to undeclared variables, no top-level await.

## Your game will be tested before anyone plays it

The instant you finish, this document is booted in a real browser: one frame
as the host, a second frame as a guest, wired together like the real room.
Synthetic players press keys. The run fails — and comes back to you as a
repair job — if ANY of these happen:

- a runtime error is thrown on either seat, at any point
- MP.ready() is never called
- the canvas is still blank after 5 seconds (draw the lobby immediately)
- the host never broadcasts state, or the guest's keys never reach the host
- the guest's screen stays empty while the host's is drawing
- a third player joining mid-round breaks anything

Write for that test: initialize synchronously, draw the lobby on frame one,
guard everything that might not exist yet (view, entities[MP.me.id], players
who just left), and never let one bad entity kill the whole frame.
`.trim()

const QUALITY_BAR = `
## Quality bar

- Playable in under 5 seconds of reading. One clear goal, obvious feedback.
- Round-based: a clear start, a scoring/win condition, and an automatic reset
  so the group can immediately go again. Handle MP.on('reset') too.
- Give each player their MP.players[i].color and show their name near their
  entity or on a scoreboard, so everyone can find themselves.
- Juice is one line each — use it everywhere it earns its place:
  AK.camera.shake on every impact, AK.particles.burst on hits/pickups/deaths,
  AK.sfx on every meaningful event, AK.stamp for entities so things have real
  silhouettes instead of circles.
- Movement must feel good: acceleration and friction, not teleporting;
  AK.math.lerp for anything that snaps.
- Tune for 2-6 players on one screen. Prefer shared-screen designs over
  split-screen.
- No dead ends: never require a resource you cannot generate at runtime.
`.trim()

const SCOPE = {
  quick: `
## Scope: quick build

A room is waiting on this file and every extra line is time they spend watching
a progress bar. Aim for a focused game under 400 lines. One sharp mechanic,
executed properly, beats four half-built ones.`.trim(),

  deep: `
## Scope: deep build

The room explicitly asked for something ambitious and accepted a long wait, so
build the real thing rather than a demo of it. 600-1500 lines is expected.
Spend it on systems that compound:

- A real world: level/arena/terrain generated procedurally, not one flat plane.
- Progression inside a round: pickups, upgrades, waves, objectives, scoring
  that changes how the round plays out.
- Opponents or hazards with actual behaviour — states, targeting, pathing —
  not just movement.
- Depth in the core verb: if it shoots, it has recoil, reload, falloff and
  distinct weapons; if it builds, blocks have types and rules.
- A proper game loop: menu/lobby state, round start, win/lose, automatic reset.

Still one file, still no external resources, still the same netcode rules. Do
not pad with dead code or long comment banners — spend the budget on mechanics
a player would notice.`.trim(),
}

const THREE_BLOCK = `
## 3D is available

The global \`THREE\` is the three.js library (r149), already loaded before your
code runs. Use it for anything 3D — first-person shooters, voxel/block builders,
kart racers, flight, third-person arenas.

- Never add a <script> tag for it and never import it. Just use \`THREE\`.
- It is the whole core library: WebGLRenderer, PerspectiveCamera, Scene,
  BufferGeometry, InstancedMesh, Raycaster, lights, materials, textures you
  generate at runtime with CanvasTexture. No loaders, no OrbitControls, no
  examples/ modules — those are separate files and are NOT available. Write
  your own camera controls; it is twenty lines.
- Use \`renderer.setSize(innerWidth, innerHeight)\` and update
  \`camera.aspect\` inside your resize handler.
- Use InstancedMesh for anything with many repeated objects (voxels, bullets,
  trees). Thousands of individual Meshes will not hold framerate.
- Pointer lock is the right control scheme for first-person:
  \`canvas.requestPointerLock()\` on click, then read \`movementX/movementY\`.
- Keep the authoritative simulation in plain numbers, not in THREE objects.
  State still has to survive JSON.stringify — send positions and rotations as
  arrays, and let each client build its own meshes from them.
`.trim()

function rosterBlock(players) {
  if (!players || !players.length) return '2-4 players expected.'
  return `${players.length} player${players.length === 1 ? '' : 's'} in the room right now: ${players
    .map((p) => `${p.name} (${p.color})`)
    .join(', ')}. The roster can change mid-game.`
}

/** Planning pass for deep builds — design before implementation. */
export function buildDesignPrompt({ brief, players }) {
  return `You are the lead designer on an ambitious browser party game. Before anyone writes code, produce the technical design.

## What the room asked for

${brief}

${rosterBlock(players)}

The game ships as ONE self-contained HTML file with no external resources, no
network, and no assets — everything drawn procedurally or with three.js (r149,
available as the global \`THREE\`). An engine layer (the Arcade Kit) is already
loaded: fixed-step game loop, auto-sizing canvas, unified input, follow/fit
camera with shake, particle system, synthesized sound effects, vector sprite
stamps, and the in-game menu. Design on top of it — the implementation will
not spend lines on plumbing. It runs host-authoritative multiplayer: one
client simulates and broadcasts JSON state ~20x/sec, the others send input and
render what they receive.

Write a tight technical design covering exactly this, and nothing else:

1. THE PITCH — one sentence on what the player actually does.
2. VIEW — 2D canvas or 3D three.js, camera, and why.
3. WORLD — how the level/arena/terrain is generated procedurally. Be specific
   about the algorithm and dimensions.
4. CORE LOOP — the moment-to-moment verbs, with real numbers: speeds,
   cooldowns, damage, sizes.
5. SYSTEMS — the two or three systems that give it depth (weapons, waves,
   building, upgrades, AI behaviour). Name the states and transitions.
6. STATE SHAPE — the exact JSON object the host broadcasts each tick. List the
   fields. Keep it small enough to send 20x/sec.
7. INPUT — the exact per-player input object sent to the host, and the controls
   that produce it.
8. ROUND FLOW — start, win/lose condition, reset.
9. LOOK — palette, shapes, effects, all achievable procedurally.
10. CUT LIST — what you are deliberately not building.

Be concrete and decisive. This document is the spec someone implements
verbatim, so no options, no "could either". Under 700 words. No code.`
}

/**
 * Prompt for a brand-new game.
 * @param {object} o
 * @param {'quick'|'deep'} [o.scope]
 * @param {string} [o.design] design doc from the planning pass
 */
export function buildGeneratePrompt({
  brief,
  players,
  scope = 'quick',
  design = '',
  mode = 'multi',
}) {
  const solo = mode === 'single'
  return `You are a game designer and engineer building a browser game for the Prompt Arcade — a room of friends who just prompted this game together and are waiting to play it right now.

## What the room asked for

${brief}

${solo ? 'This is a SINGLE PLAYER game. Each person gets their own copy.' : rosterBlock(players)}
${design ? `\n## The agreed design — implement this\n\n${design}\n` : ''}
${MP_API}

${AK_API}

${THREE_BLOCK}

${solo ? `${SOLO_RULES}\n\n${SOLO_LOBBY_RULES}` : `${LOBBY_RULES}\n\n${EVERYONE_PLAYS}\n\n${ARCHITECTURE}`}

${CAMERA_RULES}

${MENU_RULES}

${OUTPUT_RULES}

${QUALITY_BAR}

${SCOPE[scope] || SCOPE.quick}

${
  design
    ? 'Implement the design above faithfully. Where it is silent, make the call that best serves the game.'
    : `Before you write, decide: what is the single loop that makes this fun${
        solo ? '' : ' with friends in the room together'
      }? Build that, sharply, and cut everything else.`
}

Now output the complete HTML document.`
}

/** Prompt for iterating on an existing game ("add on to keep creating"). */
export function buildRemixPrompt({ brief, request, players, html, mode = 'multi' }) {
  const solo = mode === 'single'
  return remixBody({ brief, request, players, html, solo })
}

function remixBody({ brief, request, players, html, solo }) {
  return `You are extending an existing Prompt Arcade party game. The room is playing it right now and asked for a change.

## The change they want

${request}

## What the game was originally

${brief}

${solo ? 'This is a SINGLE PLAYER game.' : rosterBlock(players)}

## Current source

\`\`\`html
${html}
\`\`\`

${MP_API}

${AK_API}

${THREE_BLOCK}

${solo ? `${SOLO_RULES}\n\n${SOLO_LOBBY_RULES}` : `${LOBBY_RULES}\n\n${EVERYONE_PLAYS}\n\n${ARCHITECTURE}`}

${CAMERA_RULES}

${MENU_RULES}

${OUTPUT_RULES}

${QUALITY_BAR}

Make the requested change. Keep everything that already worked — same game, evolved. Do not rewrite from scratch unless the request demands it.

Now output the complete updated HTML document.`
}

/** Prompt for fixing a game that failed validation or threw at runtime. */
export function buildRepairPrompt({ brief, html, problems, mode = 'multi' }) {
  const solo = mode === 'single'
  return `A Prompt Arcade party game is broken. Fix it.

## What it is meant to be

${brief}

## What is wrong

${problems.map((p) => `- ${p}`).join('\n')}

## Current source

\`\`\`html
${html}
\`\`\`

${MP_API}

${AK_API}

${THREE_BLOCK}

${solo ? `${SOLO_RULES}\n\n${SOLO_LOBBY_RULES}` : `${LOBBY_RULES}\n\n${EVERYONE_PLAYS}\n\n${ARCHITECTURE}`}

${CAMERA_RULES}

${MENU_RULES}

${OUTPUT_RULES}

Fix every listed problem without changing the game's design. Output the complete corrected HTML document and nothing else.`
}

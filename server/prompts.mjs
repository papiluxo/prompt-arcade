/* Prompt assembly for game generation, remixing and repair.
 *
 * The MP API described here is implemented by shared/mp-runtime.js. If you
 * change one, change the other.
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
centred and in frame. The most common failure is drawing world coordinates
straight to the canvas, so play happens in a corner or off-screen entirely.

Pick one of these two and implement it properly:

**A camera that follows you** — for any world bigger than one screen:

    const me = view.entities[MP.me.id]
    const camX = me ? me.x - canvasW / 2 : worldW / 2 - canvasW / 2
    const camY = me ? me.y - canvasH / 2 : worldH / 2 - canvasH / 2
    ctx.save()
    ctx.translate(-camX, -camY)
    //   ... draw the world in world coordinates ...
    ctx.restore()
    //   ... draw the HUD afterwards, in screen coordinates ...

Clamp the camera to the world edges so you never scroll past the level, and
lerp it toward the target (\`cam += (target - cam) * 0.1\`) so it glides.

**Fit the whole arena** — for shared-screen games where everyone plays in one
bounded space:

    const scale = Math.min(canvasW / worldW, canvasH / worldH) * 0.92
    ctx.setTransform(scale, 0, 0, scale, (canvasW - worldW*scale)/2, (canvasH - worldH*scale)/2)

That centres the arena and leaves a margin, at any window size.

Either way:
- The local player must ALWAYS be visible. If they can go off screen, the
  camera is wrong.
- Mark the local player clearly — a ring, an arrow, "YOU" — so a player can
  find themselves instantly among identical-looking entities.
- In 3D, the camera belongs to the local player: position it behind or on
  \`view.entities[MP.me.id]\` and look where they are looking. Never leave every
  client sharing one fixed camera.
- Never lay the world out around numbers captured at load. Recompute from the
  current canvas size every frame, so it stays centred after a resize or
  fullscreen.
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

An in-game menu, present in every single game you build:

- Opens with Escape AND with a visible button in a corner (a small ⚙ or MENU
  button). Both work, on every client, at any time.
- Contains, at minimum:
    * CONTROLS — the full button layout, every key and mouse/touch action
      spelled out, in a readable list. Not a one-line hint: an actual table.
    * HOW TO PLAY — one or two sentences on the goal and how you win.
    * RESTART — restarts the round.
    * SOUND — a toggle that genuinely mutes and unmutes.
- Pause the action while it is open in single player. In multiplayer the world
  keeps running (other people are still playing), so just overlay it.
- Closes with Escape, a Close button, and by clicking the backdrop.
- DO NOT open it automatically in multiplayer. Everyone is already playing and
  a panel covering the screen reads as "the game is broken" — the round is live
  behind it. Start play immediately and leave the menu closed.
  Instead show a small, non-blocking controls strip along one edge for the
  first ~6 seconds, then fade it out. It must never swallow clicks or keys.
  (In single player only, you may open the menu on first load.)
- Style it like the rest of the game. It is part of the game, not a debug panel.
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
6. FILL THE FRAME. This is the most common way these games come out broken, so
   get it right: the game runs inside a panel that changes size — the window
   resizes, a sidebar opens, a player hits fullscreen. Never hard-code a canvas
   size. Measure the window every time and re-measure on resize:

       const canvas = document.getElementById('c')
       const ctx = canvas.getContext('2d')
       function resize() {
         const dpr = Math.min(window.devicePixelRatio || 1, 2)
         canvas.width = Math.floor(innerWidth * dpr)
         canvas.height = Math.floor(innerHeight * dpr)
         canvas.style.width = innerWidth + 'px'
         canvas.style.height = innerHeight + 'px'
         ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
       }
       addEventListener('resize', resize)
       resize()

   Lay the playfield out relative to the current size — never around constants
   captured once at load. If your design needs a fixed aspect ratio, letterbox
   it and centre it; do not pin it to a corner. html/body get margin 0,
   width/height 100%, overflow hidden, dark background. Support keyboard and
   pointer/touch.
7. Print the controls on screen (a small legend, and on the title screen).
8. It must run from a cold start with zero console errors. No syntax errors, no
   references to undeclared variables, no top-level await.
`.trim()

const QUALITY_BAR = `
## Quality bar

- Playable in under 5 seconds of reading. One clear goal, obvious feedback.
- Round-based: a clear start, a scoring/win condition, and an automatic reset
  so the group can immediately go again. Handle MP.on('reset') too.
- Give each player their MP.players[i].color and show their name near their
  entity or on a scoreboard, so everyone can find themselves.
- Juice it: screen shake, particles, easing, a short WebAudio blip on key
  events. This is the difference between a demo and something friends replay.
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
available as the global \`THREE\`). It runs host-authoritative multiplayer: one
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

${THREE_BLOCK}

${solo ? `${SOLO_RULES}\n\n${SOLO_LOBBY_RULES}` : `${LOBBY_RULES}\n\n${EVERYONE_PLAYS}\n\n${ARCHITECTURE}`}

${CAMERA_RULES}

${MENU_RULES}

${OUTPUT_RULES}

Fix every listed problem without changing the game's design. Output the complete corrected HTML document and nothing else.`
}

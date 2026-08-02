# Prompt Arcade

Get your friends in a room. Describe a game together. Play the thing you described.

Everyone in the room pitches one idea. The pitches merge into a single brief, the models you picked
each write a complete multiplayer game from it, you try them and vote, and the winner starts
immediately — same screen, same room, host-authoritative netcode. Ask for changes mid-session and
the game rebuilds around you. Publish what you like to a marketplace where every game is open
source and downloadable.

```
                 ┌──────────────────────────────────────────┐
   pitch  ──────▶│  brief   ──▶  model(s)  ──▶  vote  ──▶ play
                 └──────────────────────────────────────────┘
                                    ▲                    │
                                    └──── remix ─────────┘
```

## Run it

```bash
npm install
npm run dev            # server on :8787, UI on :5173
open http://localhost:5173
```

Production:

```bash
npm run build && npm start   # everything on :8787
```

Then send anyone the room link. Any device on the same network works — put `HOST=0.0.0.0` behind a
tunnel (ngrok, Tailscale) and it works from anywhere.

## How generation is wired

Two backends, chosen with `GEN_BACKEND`:

| Backend | Needs | Notes |
|---|---|---|
| `cli` (default) | the `claude` CLI, signed in | Uses your existing Claude subscription. No API key. |
| `api` | `ANTHROPIC_API_KEY` | Anthropic Messages API, streamed. |

**On speed.** A game is 15–30kb of code, so the wait is dominated by raw token
throughput. On the measured CLI path here that was ~25 chars/sec — roughly 5–10
minutes per game. The API backend is several times faster; set
`GEN_BACKEND=api` with a key if you want sub-minute builds. Either way the room
watches the source stream in as it's written, and `Cancel` is always there.

Both stream tokens back to the room, which is why the build screen shows the source scrolling past
as it's written. Pick one model and you play it. Pick two or three and each writes its own version —
everyone can try all of them solo before voting, and it locks in when the room agrees.

Nothing a model writes is trusted. Every result is checked for a complete document, a parseable
script, actual use of the netcode API, and forbidden calls (network, storage, iframes). A failing
game gets one automatic repair round with the specific problems fed back, and the repair is only
kept if it's genuinely better. Runtime errors from a playing game land in the room's fault log with
a one-click "send these to the model".

## Multiplayer vs single player

The host picks, per build.

**Multiplayer** means everyone is already in the game. There is no join step —
no lobby, no "press start", no waiting screen. The host spawns an entity for
every player id on every tick, so someone whose browser loads late simply
appears, already playing. Every client captures its own input from the first
frame, and no control is ever gated on being the host.

That last paragraph is a rulebook the model is held to, not a hope. The
validator rejects input handling wrapped in an `MP.isHost` check, and rejects
join/"waiting for players" gates, sending the game back for repair. These were
written after a session where every generated game was playable only by whoever
started it.

**Single player** gives each person in the room their own private copy — no
netcode, no sync, no other players. Validation drops the multiplayer
requirements entirely for these.

## Every game ships a menu

Escape or a visible button, on any client, at any time: the full control layout
as a table, how to play, restart, and a working sound toggle. It shows itself
once on first load and any key dismisses it, so the first thing a player sees is
what the buttons do. A game without one fails validation.

## Scope: quick vs deep

Two build modes, set per room.

**Quick** is one pass: a focused game under ~400 lines, the fastest route to
something playable.

**Deep** is two passes. The model first writes a technical design — world
generation, systems, the exact state shape, tuning numbers, an explicit cut
list — and then implements that spec. It costs roughly double the time and
produces something several times larger, because planning and writing stop
competing for the same attention.

Deep is where ambitious asks belong: 3D arena shooters, voxel builders, kart
racers. **A faithful COD, GTA or Minecraft is not reachable** — those are
team-years of work plus asset pipelines, and this is one HTML file with no
assets. What is reachable is the honest version of the idea: a first-person
arena with real weapon handling and a procedurally generated map, a block world
you can mine and build in, a top-down open-world driving sandbox. Point the
brief at one strong mechanic instead of a whole franchise and you'll get
something that actually plays.

## 3D

`THREE` (three.js r149) is injected into every game's sandbox as a global when
the game references it — vendored locally, so it still works with no network
and travels inside downloaded games. Only the core library: no `examples/`
modules, no loaders, no OrbitControls. Games write their own camera controls
and generate textures at runtime with `CanvasTexture`.

## The MP API

Generated games are single self-contained HTML documents that run in a sandboxed iframe with no
network access. Their only outside contact is `MP`, injected before their code runs
(`shared/mp-runtime.js`):

```js
MP.me / MP.players / MP.isHost / MP.playerCount

MP.on('input',  (data, fromId) => {})   // host only
MP.on('state',  state => {})            // render from this
MP.on('players', players => {})
MP.on('event',  (type, data, fromId) => {})
MP.on('reset',  () => {})

MP.sendInput(data)   // any client -> host
MP.setState(state)   // host -> everyone, throttled to 20Hz, echoed locally
MP.emit(type, data)  // anyone -> everyone
MP.random()          // seeded, deterministic per round
MP.ready()           // call once when initialized

MP.on('resize', (w, h) => {})   // the frame changed size
```

**Fitting the frame** is the failure mode that ruins otherwise-good games: a game measures the
window once at boot, the frame settles to a different size, and it renders into a corner forever.
Three defences — a `ResizeObserver` on the frame pushes a synthetic `resize` into the game whenever
its box changes (layout, sidebar, fullscreen); a CSS floor guarantees a full-bleed body with zero
margins; and the validator rejects any game that hard-codes a canvas size without handling resize,
sending it back for repair.

The model is required to write host-authoritative code: clients send input and render the state they
receive; exactly one client simulates. The host is elected automatically and re-elected when it
leaves, mid-game, without dropping the round. Because `setState` echoes locally, the host and the
guests run the identical render path — which is what keeps generated netcode from going subtly
wrong.

The server relays and enforces: input goes only to the host, and state from anyone who isn't the
host is dropped on the floor.

## Voice

Peer-to-peer audio mesh, signalled over the room socket, with level meters feeding the roster dots.
No media server. Right call at party-game scale; it would need an SFU past ~8 people.

## Marketplace

Publishing writes the full source to `data/games/<id>.json` — title, brief, model, every player as a
credited author, and fork lineage. From a game's page you can play it solo, read the source,
download it, or open it in a fresh room with friends.

Downloads are bundled with a solo shim that stands in for the multiplayer runtime, so the file plays
by double-clicking it, offline, forever. Every game is open source and editable by construction.

## Layout

```
server/
  index.mjs      HTTP API, static hosting, WebSocket upgrade
  rooms.mjs      presence, chat, collective prompt, generation flow, netcode relay, voice signalling
  generate.mjs   model backends, validation, repair loop
  prompts.mjs    the generation / remix / repair / brief prompts
  library.mjs    disk-backed game store
shared/
  mp-runtime.js     multiplayer API injected into every game
  mp-standalone.js  solo shim bundled into downloads
src/               React client (net.ts store, voice.ts mesh, GameFrame.tsx bridge, views/)
test/smoke.mjs     end-to-end: two players, a real generation, netcode, publishing, download
```

## Tests

```bash
npm run smoke -- --fast          # everything except generation, ~5s
npm run smoke                    # full run including a real model call

node test/gen-once.mjs haiku "your idea" --out /tmp/game.html   # one game, with timing
node test/playtest.mjs --shot /tmp/shot.png /tmp/game.html      # does it actually run?
```

`smoke` puts two clients in a room, pitches two ideas, generates a real game, and asserts the game
is valid, that input reaches the host, that state reaches the guests, that a guest *cannot* forge
authoritative state, and that publish → list → download → load-into-a-new-room round-trips.

`playtest` is the runtime half, and it runs **two** frames: a real host and a real guest, relayed to
each other exactly as the server relays them. It boots them in headless Chrome with the real MP
runtime, drives the guest's keyboard, adds a third player mid-game, and checks:

- both booted, reached `MP.ready()` and threw nothing
- the host publishes state; the guest **receives** it and **never** publishes any
- the guest's input reaches the host — i.e. a second person can actually play
- both canvases are genuinely painted, not a black screen behind a working HUD

Pass `--solo` for single-player games, `--shot out.png` to eyeball it. Needs Chrome (`CHROME_PATH`
to override).

The paired mode exists because the single-frame version passed every game while guests were unable
to play at all. A test that only exercises the happy path is worth very little.

```bash
npm run twobrowser -- <gameId>   # two real browsers, one room, one game
```

`twobrowser` is the last word, because even the paired playtest fakes the relay. It launches two
separate Chrome profiles, puts each through the real client into the same room, loads a game, then
presses arrow keys **without clicking anything** and screenshots both. That final detail is the
point: it caught the bug where the game frame never took keyboard focus, so every player who hadn't
happened to click the game was sitting in front of a picture. Nothing short of driving two real
browsers would have found it.

## Known limits

- Voice is a full mesh: fine to about 6 players, then it needs an SFU.
- Rooms live in server memory. Restarting the server ends live rooms; published games survive.
- State sync is whole-object at 20Hz. Generous for party games, wrong for anything with a large
  world — that would need delta encoding.
- One generation at a time per room.

/* Game generation: model backends, output validation, and the repair loop.
 *
 * Two backends:
 *   cli — spawns the local `claude` binary (uses the signed-in subscription)
 *   api — Anthropic Messages API with ANTHROPIC_API_KEY
 *
 * A generation is never trusted, in two stages:
 *   1. static validation — does the document parse, is the netcode shaped right
 *   2. runtime verification (verify.mjs) — the game is BOOTED in headless
 *      Chrome as host + guest, driven with input, and checked for errors,
 *      blank screens and a playable second seat
 * A failing candidate gets repair rounds with the concrete problems fed back.
 * A game that still fails verification after that is refused — the room never
 * receives a game that has not actually run.
 */

import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGeneratePrompt,
  buildRemixPrompt,
  buildRepairPrompt,
  buildDesignPrompt,
} from './prompts.mjs'
import { verifyGame } from './verify.mjs'

export const MODELS = [
  {
    id: 'opus',
    label: 'Opus 5',
    api: 'claude-opus-5',
    blurb: 'Deepest mechanics. Takes its time.',
    speed: 'slow',
  },
  {
    id: 'fable',
    label: 'Fable 5',
    api: 'claude-fable-5',
    blurb: 'A different voice. Run it against Opus and compare.',
    speed: 'slow',
  },
  {
    id: 'sonnet',
    label: 'Sonnet 5',
    api: 'claude-sonnet-5',
    blurb: 'The workhorse. Good games, quick.',
    speed: 'medium',
  },
  {
    id: 'haiku',
    label: 'Haiku 4.5',
    api: 'claude-haiku-4-5-20251001',
    blurb: 'Fast and scrappy. Great for riffing.',
    speed: 'fast',
  },
]

export const DEFAULT_MODEL = 'sonnet'
const BACKEND = (process.env.GEN_BACKEND || 'cli').toLowerCase()
// Generous by design: a big game from a flagship model can run long, and the
// room has a Cancel button for when it is clearly not coming back.
const TIMEOUT_MS = Number(process.env.GEN_TIMEOUT_SEC || 900) * 1000
// How many times a failing candidate goes back to the model with its problem
// list before the generation is refused outright.
const MAX_REPAIR_ROUNDS = Number(process.env.GEN_REPAIR_ROUNDS || 3)

export function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL)
}

export function backendInfo() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY
  return {
    backend: BACKEND,
    ready: BACKEND === 'cli' ? true : hasKey,
    note:
      BACKEND === 'api' && !hasKey
        ? 'GEN_BACKEND=api but ANTHROPIC_API_KEY is not set'
        : BACKEND === 'cli'
          ? 'using local claude CLI'
          : 'using Anthropic API',
  }
}

// ---------------------------------------------------------------- validation

const FORBIDDEN = [
  [/<iframe/i, 'creates an iframe (not allowed inside the sandbox)'],
  [/\b(src|href)\s*=\s*["']https?:\/\//i, 'loads an external resource over the network'],
  [/\bfetch\s*\(/, 'calls fetch() — the sandbox has no network'],
  [/XMLHttpRequest/, 'uses XMLHttpRequest — the sandbox has no network'],
  [/new\s+WebSocket/, 'opens its own WebSocket — use the MP API instead'],
  [/\balert\s*\(/, 'calls alert(), which is blocked in the sandbox'],
  [/\bprompt\s*\(/, 'calls prompt(), which is blocked in the sandbox'],
  [/\bconfirm\s*\(/, 'calls confirm(), which is blocked in the sandbox'],
  [/window\.MP\s*=/, 'redefines window.MP'],
  [/\bMP\s*=\s*\{/, 'redefines MP'],
]

/**
 * @param {string} html
 * @param {{mode?: 'multi'|'single'}} [opts]
 * @returns {string[]} list of problems; empty means the game is accepted.
 */
export function validateGame(html, { mode = 'multi' } = {}) {
  const problems = []
  if (!html || html.length < 800) {
    problems.push('The output is empty or far too short to be a complete game.')
    return problems
  }
  if (html.length > 400_000) problems.push('The document is unreasonably large (over 400KB).')
  const head = html.slice(0, 400).toLowerCase()
  if (!head.includes('<!doctype html') && !head.includes('<html')) {
    problems.push('The output does not start with a complete HTML document.')
  }
  if (!/<\/html>/i.test(html)) problems.push('The document is truncated — no closing </html> tag.')
  if (!/<script/i.test(html)) problems.push('There is no <script> — the game has no code.')
  if (!/MP\.ready\s*\(/.test(html)) problems.push('The game never calls MP.ready().')

  if (mode !== 'single') {
    if (!/MP\.on\s*\(/.test(html)) problems.push('The game never subscribes to any MP event.')
    if (!/MP\.setState\s*\(/.test(html)) {
      problems.push('The host never calls MP.setState() — nothing is synchronised to other players.')
    }
    if (!/MP\.sendInput\s*\(/.test(html)) {
      problems.push('Players never call MP.sendInput() — only the host could ever play.')
    }

    // The bug that made guests spectators: input handling wrapped in a host
    // check, so a guest's keypresses went nowhere.
    const gatedInput =
      /if\s*\(\s*MP\.isHost\s*\)[^}]{0,400}(addEventListener\s*\(\s*['"]key|sendInput)/s.test(html)
    if (gatedInput) {
      problems.push(
        'Input handling is wrapped in an MP.isHost check, so guests can never play. Every client must capture input and call MP.sendInput().',
      )
    }

    // A shared lobby is required; a per-player join step is not the same thing
    // and strands whoever does not perform it.
    const perPlayerJoin =
      /(press|hit|click)[^<>{}]{0,40}(start|space|enter|join)[^<>{}]{0,30}to\s+join/i.test(html) ||
      /\bplayer\s*2\b[^<>{}]{0,30}(press|join)/i.test(html)
    if (perPlayerJoin) {
      problems.push(
        'The game asks players to join individually. The lobby is shared: everyone is listed automatically and any one player starts the round for the whole room.',
      )
    }

    // If a client decides its own phase, guests sit in a lobby while the host
    // plays. The phase has to come from the broadcast state.
    if (/\bphase\b/i.test(html)) {
      const readsPhaseFromState =
        /(view|state|s|data)\s*[.?]\s*\[?['"]?phase/i.test(html) ||
        /phase\s*[:=]\s*(view|state|s|data)\s*\./i.test(html)
      if (!readsPhaseFromState) {
        problems.push(
          'The game tracks a phase but never reads it from the broadcast state, so each client decides for itself — guests will sit in the lobby while the host plays. Put phase in the state the host sends.',
        )
      }
    }

    // A game that never asks who "you" are cannot centre the view on you.
    if (!/MP\.me/.test(html)) {
      problems.push(
        'The game never references MP.me, so it cannot centre the view on the player looking at it or show them which entity is theirs.',
      )
    }
  }

  // Every game gets a menu with the controls in it. AK.menu is the way; a
  // hand-rolled Escape menu from an older game is still accepted.
  const hasMenu =
    /AK\.menu\s*\(/.test(html) ||
    (/(menu|pause|settings|options|controls)/i.test(html) &&
      /(Escape|'Esc'|"Esc"|key\s*===\s*['"]Escape)/i.test(html))
  if (!hasMenu) {
    problems.push(
      'There is no in-game menu. Call AK.menu({title, how, controls, onRestart, pause}) once at boot with the full control list.',
    )
  }
  for (const [re, msg] of FORBIDDEN) if (re.test(html)) problems.push(`The game ${msg}.`)

  // The single most common way a generated game looks broken: it locks the
  // canvas to a hard-coded size and never re-measures, so it renders into the
  // top-left corner of the frame instead of filling it. AK.canvas() manages
  // sizing forever, so its presence settles the question.
  const usesAkCanvas = /AK\.canvas\s*\(/.test(html)
  const uses3d = /\bTHREE\s*\./.test(html)
  const fixedCanvas =
    /canvas\.(width|height)\s*=\s*\d{2,}/.test(html) ||
    /<canvas[^>]+\b(width|height)\s*=\s*["']?\d{2,}/i.test(html)
  const handlesResize =
    /AK\.onResize\s*\(/.test(html) ||
    /addEventListener\(\s*['"]resize/.test(html) ||
    /onresize\s*=/.test(html) ||
    /MP\.on\(\s*['"]resize/.test(html)
  if (!usesAkCanvas && !uses3d && fixedCanvas && !handlesResize) {
    problems.push(
      'The canvas is locked to a hard-coded pixel size and the game never handles a resize, so it renders into a corner instead of filling the screen. Use AK.canvas() + AK.loop() instead of a hand-rolled canvas.',
    )
  }

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  for (const body of scripts) {
    if (!body.trim()) continue
    try {
      // Parse-only check. Never executed.
      new Function(body)
    } catch (err) {
      problems.push(`A <script> block has a syntax error: ${err.message}`)
      break
    }
  }
  return problems
}

/** Pull the HTML document out of whatever the model replied with. */
export function extractHtml(raw) {
  if (!raw) return ''
  let text = raw.trim()
  const fenced = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i)
  if (fenced && /<html|<!doctype/i.test(fenced[1])) text = fenced[1]
  const start = text.search(/<!doctype html|<html/i)
  if (start > 0) text = text.slice(start)
  const end = text.toLowerCase().lastIndexOf('</html>')
  if (end !== -1) text = text.slice(0, end + 7)
  return text.trim()
}

// ------------------------------------------------------------- model backends

let scratchDir = null
async function getScratchDir() {
  if (!scratchDir) scratchDir = await mkdtemp(join(tmpdir(), 'prompt-arcade-'))
  return scratchDir
}

/** Run the local claude CLI, streaming text deltas to onDelta. */
async function callCli({ modelId, prompt, onDelta, signal }) {
  const cwd = await getScratchDir()
  const args = [
    '-p',
    '--model',
    modelId,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--disallowed-tools',
    'Bash Edit Write Read Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit',
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let streamed = ''
    let result = ''
    let stderr = ''
    let buf = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`model timed out after ${Math.round(TIMEOUT_MS / 1000)}s`))
      }
    }, TIMEOUT_MS)

    const onAbort = () => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error('cancelled'))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(arg)
    }

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let msg
        try {
          msg = JSON.parse(trimmed)
        } catch {
          out += trimmed
          continue
        }
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
          const delta = msg.event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            streamed += delta.text
            onDelta?.(streamed)
          }
        } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          const text = msg.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
          if (text && !streamed) {
            streamed = text
            onDelta?.(streamed)
          }
        } else if (msg.type === 'result') {
          if (msg.subtype && msg.subtype !== 'success' && !msg.result) {
            stderr += `\nCLI result: ${msg.subtype} ${msg.error || ''}`
          }
          if (typeof msg.result === 'string') result = msg.result
        }
      }
    })

    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })

    child.on('error', (err) =>
      finish(reject, new Error(`could not run the claude CLI: ${err.message}`)),
    )

    child.on('close', (code) => {
      const text = result || streamed || out
      if (!text.trim()) {
        finish(
          reject,
          new Error(`the model returned nothing (exit ${code})${stderr ? `: ${stderr.slice(-400)}` : ''}`),
        )
        return
      }
      finish(resolve, text)
    })

    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** Anthropic Messages API with SSE streaming. */
async function callApi({ modelId, prompt, onDelta, signal }) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  const model = modelById(modelId).api

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 32000,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const msg = JSON.parse(payload)
        if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
          text += msg.delta.text
          onDelta?.(text)
        }
      } catch {
        /* keep going */
      }
    }
  }
  if (!text.trim()) throw new Error('the model returned nothing')
  return text
}

function callModel(opts) {
  return BACKEND === 'api' ? callApi(opts) : callCli(opts)
}

// ------------------------------------------------------------------ public API

/**
 * Generate (or remix, or repair) one game and validate it. On validation
 * failure it runs a single repair round with the problems fed back.
 *
 * @param {object} o
 * @param {string} o.modelId
 * @param {string} o.brief
 * @param {Array}  o.players
 * @param {string} [o.baseHtml]  existing source, when remixing
 * @param {string} [o.request]   the change request, when remixing
 * @param {(p: {phase: string, chars: number, preview: string}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function generateGame({
  modelId,
  brief,
  players,
  baseHtml,
  request,
  scope = 'quick',
  mode = 'multi',
  onProgress,
  signal,
}) {
  const started = Date.now()
  const report = (phase) => (text) =>
    onProgress?.({ phase, chars: text.length, preview: text.slice(-1200) })

  // Deep builds design before they implement. Planning in a separate pass buys
  // far more structure than asking for both at once.
  let design = ''
  if (!baseHtml && scope === 'deep') {
    design = await callModel({
      modelId,
      prompt: buildDesignPrompt({ brief, players }),
      onDelta: report('designing'),
      signal,
    })
  }

  const prompt = baseHtml
    ? buildRemixPrompt({ brief, request, players, html: baseHtml, mode })
    : buildGeneratePrompt({ brief, players, scope, design, mode })

  const raw = await callModel({ modelId, prompt, onDelta: report('writing'), signal })
  let html = extractHtml(raw)
  let repairs = 0
  let verified = false

  /* Judge one candidate. Static problems first (cheap, and a document that
   * fails them is not worth booting); only a statically clean candidate pays
   * for the browser run. */
  const judge = async (candidate) => {
    const staticProblems = validateGame(candidate, { mode })
    if (staticProblems.length) return { problems: staticProblems, ran: false }
    onProgress?.({
      phase: 'testing',
      chars: candidate.length,
      preview: 'Booting the game in a real browser: host + second player, live input, error watch…',
    })
    const rt = await verifyGame({ html: candidate, mode })
    if (signal?.aborted) throw new Error('cancelled')
    return { problems: rt.failures, ran: !rt.skipped }
  }

  let { problems, ran } = await judge(html)
  let best = { html, problems, ran }

  while (problems.length && repairs < MAX_REPAIR_ROUNDS) {
    if (signal?.aborted) throw new Error('cancelled')
    repairs++
    onProgress?.({
      phase: 'repairing',
      chars: html.length,
      preview: `Repair round ${repairs}/${MAX_REPAIR_ROUNDS}:\n${problems.join('\n')}`,
    })
    const repairPrompt = buildRepairPrompt({
      brief,
      html: html || raw.slice(0, 60_000),
      problems,
      mode,
    })
    let fixed
    try {
      fixed = extractHtml(
        await callModel({ modelId, prompt: repairPrompt, onDelta: report('repairing'), signal }),
      )
    } catch (err) {
      if (signal?.aborted) throw err
      onProgress?.({ phase: 'repairing', chars: 0, preview: `repair failed: ${err.message}` })
      break
    }
    if (!fixed || fixed.length < 800) continue // a dud reply burns the round, not the candidate

    const verdict = await judge(fixed)
    // Adopt the repair unless it is strictly worse — staying on a version the
    // model has already failed to fix once is the losing move.
    if (verdict.problems.length <= problems.length) {
      html = fixed
      problems = verdict.problems
      ran = verdict.ran
    }
    if (problems.length < best.problems.length) best = { html, problems, ran }
  }

  if (best.problems.length < problems.length) ({ html, problems, ran } = best)
  verified = ran && problems.length === 0

  if (problems.length) {
    // The bar: a game that cannot demonstrably run is not handed to the room.
    // Refusing here reads as "a model failed" upstream, which is the truth.
    throw new Error(
      `still broken after ${repairs} repair round${repairs === 1 ? '' : 's'}: ${problems[0]}`,
    )
  }

  return {
    modelId,
    html,
    problems: [],
    repaired: repairs > 0,
    verified,
    mode,
    ms: Date.now() - started,
    title: guessTitle(html),
  }
}

function guessTitle(html) {
  const t = html.match(/<title[^>]*>([^<]{1,80})<\/title>/i)
  if (t && t[1].trim()) return t[1].trim()
  const h = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)
  if (h && h[1].trim()) return h[1].trim()
  return 'Untitled Game'
}

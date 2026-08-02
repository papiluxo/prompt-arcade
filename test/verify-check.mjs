/* Does the runtime verifier tell working games from broken ones?
 *
 * Runs verify.mjs against two fixtures with known ground truth:
 *   ak-arena.html    — a correct Arcade Kit game. Must PASS.
 *   broken-guest.html — host-gated input, undefined variable in render,
 *                       guest never draws. Must FAIL, with specific findings.
 *
 *   npm run verify-check
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyGame, verifierAvailable } from '../server/verify.mjs'
import { validateGame } from '../server/generate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

if (!(await verifierAvailable())) {
  console.error('no Chrome/Chromium found — cannot run the verifier check')
  process.exit(2)
}

let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---- the good game ----------------------------------------------------------
{
  const html = await readFile(join(HERE, 'fixtures', 'ak-arena.html'), 'utf8')
  console.log('\nak-arena.html (must pass)\n')

  const staticProblems = validateGame(html, { mode: 'multi' })
  check('static validation clean', staticProblems.length === 0, staticProblems.join(' | '))

  const t = Date.now()
  const res = await verifyGame({ html, mode: 'multi' })
  check('runtime verification ran', !res.skipped, res.stats?.note || '')
  check('verdict: PASSED', res.passed, res.failures.join(' | '))
  console.log(`  (${((Date.now() - t) / 1000).toFixed(1)}s, stats: ${JSON.stringify(res.stats)})`)
}

// ---- the broken game --------------------------------------------------------
{
  const html = await readFile(join(HERE, 'fixtures', 'broken-guest.html'), 'utf8')
  console.log('\nbroken-guest.html (must fail)\n')

  const res = await verifyGame({ html, mode: 'multi' })
  check('verdict: FAILED', !res.skipped && !res.passed)
  const text = res.failures.join('\n')
  check('caught the runtime error', /runtime error/i.test(text))
  check('caught the spectator guest', /sendInput|input/i.test(text))
  check(
    'failures are concrete repair instructions',
    res.failures.every((f) => f.length > 40),
  )
  for (const f of res.failures) console.log(`    · ${f.slice(0, 110)}`)
}

console.log(`\n${failed ? `${failed} FAILED` : 'all good'}\n`)
process.exit(failed ? 1 : 0)

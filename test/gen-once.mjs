/* Generate a single game and report timing, size and validation.
 *
 *   node test/gen-once.mjs haiku "a race where players draw the track"
 *   node test/gen-once.mjs sonnet "..." --out /tmp/game.html
 */

import { writeFile } from 'node:fs/promises'
import { generateGame, validateGame } from '../server/generate.mjs'

const [modelId = 'haiku', ...rest] = process.argv.slice(2)
const outIdx = rest.indexOf('--out')
const out = outIdx !== -1 ? rest[outIdx + 1] : null
const brief =
  rest.filter((a, i) => a !== '--out' && i !== outIdx + 1).join(' ') ||
  'A four-player arena game where everyone controls a bouncing blob and the last one inside the shrinking ring wins.'

const started = Date.now()
let lastLog = 0

console.log(`\nmodel: ${modelId}\nbrief: ${brief}\n`)

const result = await generateGame({
  modelId,
  brief,
  players: [
    { name: 'Ana', color: '#8ce99a' },
    { name: 'Bo', color: '#74c0fc' },
  ],
  onProgress: ({ phase, chars }) => {
    const now = Date.now()
    if (now - lastLog < 2000) return
    lastLog = now
    process.stdout.write(`  ${((now - started) / 1000).toFixed(0)}s  ${phase}  ${chars} chars\n`)
  },
})

const problems = validateGame(result.html)
console.log(`\ntitle:      ${result.title}`)
console.log(`elapsed:    ${(result.ms / 1000).toFixed(1)}s`)
console.log(`size:       ${(result.html.length / 1024).toFixed(1)}kb`)
console.log(`repaired:   ${result.repaired}`)
console.log(`problems:   ${problems.length ? problems.join('; ') : 'none'}`)

if (out) {
  await writeFile(out, result.html)
  console.log(`written:    ${out}`)
}
process.exit(problems.length ? 1 : 0)

import { readFileSync, writeFileSync } from 'node:fs'
const p = './src/modules/meta/routes.ts'
const target = process.argv[2]
const lines = readFileSync(p, 'utf8').split('\n')
const vi = lines.findIndex(l => l === `    version: '${target}',`)
if (vi < 0) throw new Error('version line not found for ' + target)
let start = vi; while (lines[start] !== '  {') start--
let end = vi; while (lines[end] !== '  },') end++
console.log(`removing lines ${start + 1}..${end + 1} (${end - start + 1} lines) for ${target}`)
lines.splice(start, end - start + 1)
writeFileSync(p, lines.join('\n'))

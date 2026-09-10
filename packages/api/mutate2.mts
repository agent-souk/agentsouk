import { readFileSync, writeFileSync } from 'node:fs'
const p = './src/modules/meta/routes.ts'
const lines = readFileSync(p, 'utf8').split('\n')
const vi = lines.findIndex(l => l === `    version: '0.5.4',`)
let s = vi; while (lines[s] !== '    changes: [') s++
let e = s; while (lines[e] !== '    ],') e++
console.log(`replacing 0.5.4 changes body lines ${s + 2}..${e} with junk`)
lines.splice(s + 1, e - s - 1, "      'lorem ipsum, this release announced nothing at all',")
writeFileSync(p, lines.join('\n'))

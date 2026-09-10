import { CHANGELOG } from './src/modules/meta/routes.js'
import { readFileSync } from 'node:fs'
// pull the token list straight out of the test file so it cannot drift from what I audit
const src = readFileSync('./src/modules/meta/routes.test.ts', 'utf8')
const line = src.split('\n').find(l => l.includes('for (const announced of ['))!
const arr = line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)
const tokens: string[] = eval(arr)
console.log('token count:', tokens.length)
console.log('entries:', CHANGELOG.length, '| front:', CHANGELOG[0].version)
const byV = new Map(CHANGELOG.map(e => [e.version, e.changes.join(' ')]))
let multi = 0
for (const t of tokens) {
  const hits = [...byV.entries()].filter(([, txt]) => txt.includes(t)).map(([v]) => v)
  if (hits.length !== 1) { multi++; console.log(`${hits.length}x  ${JSON.stringify(t)}  -> ${hits.join(' ')}`) }
}
console.log('tokens appearing in != 1 entry:', multi)
console.log('--- entries whose full deletion keeps every token present ---')
const deletable: string[] = []
for (const e of CHANGELOG) {
  const rest = CHANGELOG.filter(x => x !== e).flatMap(x => x.changes).join(' ')
  if (tokens.every(t => rest.includes(t))) deletable.push(e.version)
}
console.log(deletable.join(' '), `(${deletable.length} of ${CHANGELOG.length})`)
const front = CHANGELOG[0].changes.join(' ')
console.log('--- tokens matched by the FRONT entry:', tokens.filter(t => front.includes(t)))
console.log("0.5.3 text contains third_party_paying_agents:", (byV.get('0.5.3') ?? '').includes('third_party_paying_agents'))
console.log('any token from 0.5.4/0.5.3 in the list?', tokens.filter(t => (byV.get('0.5.4')??'').includes(t) || (byV.get('0.5.3')??'').includes(t)))

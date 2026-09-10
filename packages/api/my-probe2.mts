import { CHANGELOG } from './src/modules/meta/routes.js'
import { readFileSync } from 'node:fs'
const raw = readFileSync('./src/modules/meta/routes.ts', 'utf8')
console.log('raw version-lines:', (raw.match(/^    version: '/gm) || []).length)
console.log('imported entries:', CHANGELOG.length)
console.log('versions:', CHANGELOG.map(e => e.version).join(','))
console.log('has 0.3.9:', CHANGELOG.some(e => e.version === '0.3.9'))

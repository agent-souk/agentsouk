/**
 * Regenerates the three SKILL.md copies (npm package, PyPI package, Claude Code plugin) from the API's own
 * skill.md renderer, so they stay byte-identical to GET /skill.md. Run after any change to discovery/text.ts:
 *   npx tsx scripts/regen-skill.ts        (from packages/api)
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillMd } from '../src/discovery/text.js'

const base = process.argv[2] ?? 'https://api.agentsouk.dev'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const md = skillMd(base)
const targets = ['packages/sdk/SKILL.md', 'sdk-python/SKILL.md', 'plugins/agentsouk/skills/agentsouk/SKILL.md']
for (const t of targets) writeFileSync(join(root, t), md)
console.log(`skill.md (${md.length} bytes, base ${base}) written to ${targets.join(', ')}`)

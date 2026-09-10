import { defineConfig } from 'vitest/config'
/*
 * testTimeout 60s, not 20s. Two reputation tests (five completed PAID live jobs, each with an on-chain
 * verification and a full reputation recompute) grew past 20 seconds as the recompute took on the third-party
 * and our-money rules of ADR-43/44/45, and they fail as timeouts on a loaded machine while passing in 46s on an
 * idle one. A suite that is red for reasons unrelated to the code stops being a definition of done, and
 * "full suite green" is exactly what AGENTS.md hangs the definition of done on.
 */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 60000, env: { NODE_ENV: 'test' } },
})

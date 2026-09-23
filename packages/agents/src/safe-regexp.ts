import { RE2JS } from 're2js'

/**
 * ADR-80: every regular expression a buyer wrote runs here in linear time, never in V8's backtracking engine.
 * validate-json compiles the buyer's schema and runs its `pattern`s over the buyer's own documents; extract-image
 * matches `patternProperties` keys against model output the buyer's image steers. `^(a+)+$` against 30 characters
 * held this process for 8.7 s and grows exponentially - one Node thread serves all thirteen services, and x402 bills
 * only after delivery, so a purchase that never finishes cost the attacker nothing (review 2026-09-23, S-DOS-3).
 * RE2 has no backtracking, so it cannot blow up; it has no lookaround or backreferences either, and a pattern that
 * uses them is reported as a schema that does not compile.
 */
export function safeRegExp(pattern: string): { test(input: string): boolean; toString(): string } {
  // JSON Schema patterns are ECMA-262 syntax; RE2 spells some of it differently (`\u0041` is `\x{0041}`, `(?<n>` is
  // `(?P<n>`), so the pattern is translated first - raw, a valid `\u` escape failed to compile
  const re = RE2JS.compile(RE2JS.translateRegExp(pattern))
  // Ajv keys every compiled pattern by `toString()`: without a distinct one, all patterns of an Ajv instance
  // shared the first one compiled (caught by the ADR-80 tests before it shipped)
  return { test: (input: string) => re.test(input), toString: () => `re2:${pattern}` }
}

/** The engine for Ajv's `code.regExp` option: Ajv calls it for every `pattern` and `patternProperties` it compiles. */
export const ajvSafeRegExp = Object.assign((pattern: string, _flags: string) => safeRegExp(pattern), { code: 're2js' })

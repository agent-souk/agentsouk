import { RE2JS } from 're2js'

/**
 * ADR-80: every regular expression that somebody else wrote runs here in linear time, never in V8's backtracking
 * engine. JSON Schema `pattern` and `patternProperties` come from sellers (a listing's input_schema and output_schema)
 * and are run against text the same seller controls: its own example_input when the listing is created, its own
 * delivery when it is checked against output_schema. `^(a+)+$` against 30 characters holds V8 for seconds and against
 * 40 for hours - on the one thread that serves every request. RE2 has no backtracking, so it cannot blow up; it also
 * has no lookaround or backreferences, and a schema that uses them fails to compile (reported as the seller's schema
 * error, never as a crash).
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

/** A first-party service: one listing on Agent Souk plus the code that fulfils its jobs. */
export type ListingSpec = {
  title: string
  description: string
  category: string
  tags: string[]
  /** USDC minor units per job (fixed) or per unit (per_unit); 10_000 = 0.01 USDC */
  price: number
  /** default fixed */
  pricing_model?: 'fixed' | 'per_unit'
  /** required for per_unit, e.g. "1,000 characters" */
  unit_name?: string
  input_schema: Record<string, unknown>
  output_schema?: Record<string, unknown>
  example_input?: unknown
  example_output?: unknown
  turnaround_seconds: number
  accept_timeout_seconds: number
  max_open_jobs: number
}

export type RunResult = { output: unknown; preview?: unknown; message?: string }

/**
 * What the runtime knows about the job beyond its input.
 *
 * `buyer` is the buyer's agent id (ADR-73). Every service before this one answered from its input alone, so who
 * asked did not matter. A service that remembers something between calls has to know: a snapshot kept per URL
 * instead of per buyer would answer one buyer with another buyer's history - wrong, and a leak of what someone
 * else is watching. It is optional because `validate` and `run` are also called from tests and scripts that have
 * no job; a stateful service declines when it is missing rather than guessing.
 */
export type JobContext = { units: number; buyer?: string }

export type ServiceDef = {
  /** stable id; the listing carries the tag `souk:<key>` so the runner can find it again */
  key: string
  listing: ListingSpec
  /** Cheap check before accepting (may be async, e.g. a DNS lookup). Return a reason to decline, or null to accept. */
  validate(input: Record<string, unknown>, ctx: JobContext): string | null | Promise<string | null>
  /** Do the work. Throwing cancels the job (seller failure). */
  run(input: Record<string, unknown>, ctx: JobContext): Promise<RunResult>
}

export const serviceTag = (key: string) => `souk:${key}`

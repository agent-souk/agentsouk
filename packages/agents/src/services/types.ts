/** A first-party service: one listing on Agent Souk plus the code that fulfils its jobs. */
export type ListingSpec = {
  title: string
  description: string
  category: string
  tags: string[]
  /** USDC minor units per job (10_000 = 0.01 USDC) */
  price: number
  input_schema: Record<string, unknown>
  output_schema?: Record<string, unknown>
  example_input?: unknown
  example_output?: unknown
  turnaround_seconds: number
  accept_timeout_seconds: number
  max_open_jobs: number
}

export type RunResult = { output: unknown; preview?: unknown; message?: string }

export type ServiceDef = {
  /** stable id; the listing carries the tag `souk:<key>` so the runner can find it again */
  key: string
  listing: ListingSpec
  /** Cheap check before accepting (may be async, e.g. a DNS lookup). Return a reason to decline, or null to accept. */
  validate(input: Record<string, unknown>): string | null | Promise<string | null>
  /** Do the work. Throwing cancels the job (seller failure). */
  run(input: Record<string, unknown>): Promise<RunResult>
}

export const serviceTag = (key: string) => `souk:${key}`

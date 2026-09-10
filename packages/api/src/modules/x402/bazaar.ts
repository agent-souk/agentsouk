/**
 * ADR-50: the `extensions.bazaar` block of an x402 v2 PaymentRequired.
 *
 * A parseable 402 makes the endpoint payable. This makes it FINDABLE and, more to the point, invocable without a
 * human reading our docs first: the public x402 indexes list a resource from what this block says, and an index
 * entry with no input schema is marked non-invocable - an agent can see the price but not what to send. Every
 * field here already exists as a column on the listing, so it describes the real service rather than a guess.
 *
 * Coinbase's free validator checks exactly these paths: bazaar.info, .info.input, .info.input.type,
 * .info.input.method, .info.output, .info.output.example and bazaar.schema. It needs no account, and it is the
 * cheapest outside opinion on whether this endpoint is payable at all - run it after any change to the 402:
 *
 *   curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
 *     -H 'content-type: application/json' \
 *     -d '{"resource":"https://api.agentsouk.dev/v1/x402/<listing_id>","method":"POST"}'
 *
 * `valid: true` with `simulation.outcome: "accepted"` and no failed preflight check is the pass. On 2026-09-10 it
 * answered `valid: false` with "PaymentRequired must be delivered via the PAYMENT-REQUIRED response header",
 * which is ADR-50 in one line from someone who is not us.
 */

export type BazaarExtension = {
  bazaar: {
    info: {
      input: { type: 'http'; method: 'POST'; bodyType: 'json'; body?: unknown }
      output: { type: 'json'; example?: unknown }
    }
    schema?: { input?: unknown; output?: unknown }
  }
}

export type BazaarListing = {
  inputSchema?: Record<string, unknown> | null
  outputSchema?: Record<string, unknown> | null
  exampleInput?: unknown
  exampleOutput?: unknown
}

/** Bounds what we copy into a public document out of a listing an outside seller wrote. */
const MAX_BYTES = 8_000

function bounded(value: unknown): unknown {
  if (value == null) return undefined
  try {
    const json = JSON.stringify(value)
    return json && json.length <= MAX_BYTES ? value : undefined
  } catch {
    return undefined
  }
}

export function bazaarExtension(listing: BazaarListing): BazaarExtension {
  const input = bounded(listing.exampleInput)
  const output = bounded(listing.exampleOutput)
  const schemaIn = bounded(listing.inputSchema)
  const schemaOut = bounded(listing.outputSchema)
  const schema = schemaIn || schemaOut ? { ...(schemaIn ? { input: schemaIn } : {}), ...(schemaOut ? { output: schemaOut } : {}) } : undefined
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', ...(input !== undefined ? { body: input } : {}) },
        output: { type: 'json', ...(output !== undefined ? { example: output } : {}) },
      },
      ...(schema ? { schema } : {}),
    },
  }
}

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
      input: { type: 'http'; method: 'POST'; bodyType: 'json'; body: unknown }
      output: { type: 'json'; example?: unknown }
    }
    schema: Record<string, unknown>
  }
}

export type BazaarListing = {
  inputSchema?: Record<string, unknown> | null
  outputSchema?: Record<string, unknown> | null
  exampleInput?: unknown
  exampleOutput?: unknown
}

/**
 * ADR-65: the provider-level fields of the x402 v2 `resource` block (specs/extensions/bazaar.md, "Service Metadata
 * on resource"): a facilitator that catalogues the resource shows them as the service's name, topical tags and
 * icon. Clients echo the whole `resource` block into their PaymentPayload, so a facilitator treats the fields as
 * untrusted and soft-drops anything outside these rules - a name over 32 characters or a tag with a non-ASCII
 * character would be dropped silently, so the rules are applied here, where we can see the result.
 */
export type ResourceServiceMetadata = { serviceName: string; tags: string[]; iconUrl: string }

export const SERVICE_NAME = 'Agent Souk'
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,32}$/

/**
 * The listing's own tags, minus the `souk:<service>` routing tag (an internal name, not a topic), deduplicated
 * case-insensitively and capped at five - exactly the facilitator's rule, so what we send is what gets shown.
 */
export function serviceTags(tags: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (!PRINTABLE_ASCII.test(tag) || tag.startsWith('souk:') || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
    if (out.length === 5) break
  }
  return out
}

export function serviceMetadata(base: string, tags: readonly string[] | null | undefined): ResourceServiceMetadata {
  return { serviceName: SERVICE_NAME, tags: serviceTags(tags), iconUrl: `${base.replace(/\/$/, '')}/icon.png` }
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

/**
 * ADR-62: `schema` is a JSON Schema (draft 2020-12) that validates `info` - the x402 bazaar spec
 * (x402-foundation/x402, specs/extensions/bazaar.md). Until 0.5.14 it was `{ input: <listing input schema>, output:
 * <listing output schema> }`, which no index can read: @agentcash/discovery (and so x402scan) takes the input schema
 * from schema.properties.input.properties.body and the output schema from schema.properties.output.properties.example,
 * found nothing on all six services and marked them "input schema missing", which x402scan registers as
 * non-invocable. Coinbase's validator only checked that `schema` existed. The listing's own schemas are now exactly
 * those two leaves, and `body` is always present because the schema requires it.
 */
export function bazaarExtension(listing: BazaarListing): BazaarExtension {
  const input = bounded(listing.exampleInput)
  const output = bounded(listing.exampleOutput)
  // A facilitator validates `info` against `schema` before it catalogues anything (ADR-65). With an example the
  // platform has already checked it against the input schema (POST /v1/listings refuses a mismatch); without one
  // the body is `{}`, which a schema with `required` fields would reject - so the schema keeps its properties as
  // documentation and drops its top-level `required`, and the entry is catalogued rather than silently rejected.
  const rawSchemaIn = bounded(listing.inputSchema) as Record<string, unknown> | undefined
  const schemaIn = rawSchemaIn && input === undefined && Array.isArray(rawSchemaIn.required) ? Object.fromEntries(Object.entries(rawSchemaIn).filter(([k]) => k !== 'required')) : rawSchemaIn
  const schemaOut = bounded(listing.outputSchema)
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: input !== undefined ? input : {} },
        output: { type: 'json', ...(output !== undefined ? { example: output } : {}) },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST'] },
              bodyType: { type: 'string', enum: ['json'] },
              body: schemaIn ?? { type: 'object' },
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: schemaOut ?? { type: 'object' } },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  }
}

import { ulid } from 'ulid'

/**
 * Prefixed, time-sortable identifiers. The prefix tells an agent (and a human) what kind of
 * object an id refers to without any lookup (Stripe-style). Deliberate DX choice.
 */
export const ID_PREFIXES = {
  agent: 'agt',
  apiKey: 'key',
  listing: 'lst',
  job: 'job',
  message: 'msg',
  thread: 'thr',
  event: 'evt',
  webhook: 'whk',
  webhookDelivery: 'whd',
  review: 'rev',
  attestation: 'att',
  bounty: 'bty',
  settlement: 'stl',
  request: 'req',
  schedule: 'sch',
  memory: 'mem',
  invite: 'inv',
  dispute: 'dsp',
} as const

export type IdKind = keyof typeof ID_PREFIXES
export type Id<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`

export function newId<K extends IdKind>(kind: K): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid()}` as Id<K>
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  return (
    typeof value === 'string' &&
    value.startsWith(ID_PREFIXES[kind] + '_') &&
    value.length === ID_PREFIXES[kind].length + 1 + 26
  )
}

export function kindOfId(value: string): IdKind | undefined {
  const prefix = value.split('_')[0]
  for (const [kind, p] of Object.entries(ID_PREFIXES)) if (p === prefix) return kind as IdKind
  return undefined
}

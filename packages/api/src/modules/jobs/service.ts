import type { Env } from '../../db/schema.js'
import { errors } from '../../lib/errors.js'

/**
 * CONTRACT used by the bounties module. The jobs module owns and implements this file (SPEC §2).
 */
export type CreateJobFromBountyInput = {
  env: Env
  bountyId: string
  buyerAgentId: string
  sellerAgentId: string
  title: string
  input: Record<string, unknown>
  price: number
  turnaroundSeconds?: number
}

export async function createJobFromBountyAward(_input: CreateJobFromBountyInput): Promise<{ id: string; status: string }> {
  throw errors.notImplemented('createJobFromBountyAward')
}

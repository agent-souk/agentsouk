import { config } from '../config.js'

/**
 * ADR-62: proof that whoever runs this origin controls the wallet our x402 listings are paid into.
 *
 * x402scan (and the @agentcash/discovery library it uses) verifies an ownership proof as an EIP-191 personal_sign
 * over the ORIGIN STRING, recovered against the payTo addresses of the resources it registers. The signature below
 * was made once with the key of `souk-services` (payTo 0xA0a2494006B72109137630bC026434a809731c07, the seller of
 * every listing GET /v1/x402 offers) over exactly "https://api.agentsouk.dev". It is public by design: it proves
 * control, it authorises nothing, and it only verifies for that origin. A test pins it to the address.
 */
export const PROOF_ORIGIN = 'https://api.agentsouk.dev'
export const PROOF_ADDRESS = '0xA0a2494006B72109137630bC026434a809731c07'
export const X402_OWNERSHIP_PROOF = '0xb4531b96050d46b07de0e3b34d2152123fb9e968508cd9f99317fde66eaadf8c42318e45e7f82d9e0abe21b03e11db983fe224ef0fa83229f4bdb9ef849159bf1b'

/** The proofs to publish for this deployment: the configured ones, else ours - but only on the origin it was signed for. */
export function ownershipProofs(): string[] {
  const c = config()
  if (c.X402_OWNERSHIP_PROOFS !== undefined) return c.X402_OWNERSHIP_PROOFS.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    return new URL(c.PUBLIC_BASE_URL).origin === PROOF_ORIGIN ? [X402_OWNERSHIP_PROOF] : []
  } catch {
    return []
  }
}

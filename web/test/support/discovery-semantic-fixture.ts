import type { DiscoveryInference } from '../../src/lib/onboarding-pi.server'
import type { DiscoverySemanticPacket } from '../../../src/discovery-semantic-review'

/** Test-only independent reviewer. Production has no access to this fixture:
 * all production review turns use a distinct tool-less Pi session. */
export function withFixtureSemanticReview(infer: DiscoveryInference,
  evaluate?: (packet: DiscoverySemanticPacket) => Array<{
    claimId: string; verdict: 'supported' | 'unsupported' | 'uncertain'; reason: string
  }>): DiscoveryInference {
  return (session, instructions, role) => {
    if (role !== 'semantic-review') return infer(session, instructions, role)
    const marker = 'REVIEW_PACKET_JSON:\n'
    const pos = instructions.indexOf(marker)
    if (pos < 0) throw Error('Fixture reviewer did not receive an exact review packet.')
    const packet = JSON.parse(instructions.slice(pos + marker.length)) as DiscoverySemanticPacket
    if (packet.contract !== 'discovery-semantic-scope/v1')
      throw Error('Fixture reviewer received unsupported policy.')
    return Promise.resolve(JSON.stringify({ assessments: evaluate
      ? evaluate(packet)
      : packet.claims.map(claim => ({ claimId: claim.id, verdict: 'supported',
        reason: 'Fixture-only semantic acceptance for deterministic controller coverage.' })) }))
  }
}

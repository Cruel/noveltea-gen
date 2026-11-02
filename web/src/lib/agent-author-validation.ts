/** Shared, side-effect-free validation for authenticated author commands. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SHA = /^[a-f0-9]{64}$/
const NONCE = /^[0-9a-f-]{36}$/

export function validAuthorCommand(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (input.action === 'send') {
    if (Object.keys(input).some(key => !['action', 'message'].includes(key))) return false
    const m = input.message
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false
    const message = m as Record<string, unknown>
    return Object.keys(message).every(key => ['id', 'kind', 'payload'].includes(key)) &&
      ['idea', 'change'].includes(String(message.kind)) &&
      message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload) &&
      (message.id === undefined || typeof message.id === 'string' && message.id.length <= 64 && ID.test(message.id))
  }
  if (!['answer', 'prepare', 'decide'].includes(String(input.action)) ||
      typeof input.messageId !== 'string' || input.messageId.length > 64 || !ID.test(input.messageId))
    return false
  const allowed = input.action === 'answer' ? ['action', 'messageId', 'answer'] :
    input.action === 'prepare' ? ['action', 'messageId'] :
      ['action', 'messageId', 'receiptId', 'nonce', 'proposalSha256', 'decision']
  return !Object.keys(input).some(key => !allowed.includes(key)) &&
    (input.action !== 'answer' || typeof input.answer === 'string' &&
      !!input.answer.trim() && input.answer.length <= 4000) &&
    (input.action !== 'decide' || typeof input.receiptId === 'string' &&
      typeof input.nonce === 'string' && NONCE.test(input.nonce) &&
      typeof input.proposalSha256 === 'string' && SHA.test(input.proposalSha256) &&
      ['approved', 'rejected'].includes(String(input.decision)))
}

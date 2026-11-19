/** One request-level OAuth recovery for OpenAI's supported HTTP endpoints.
 * Only a completed 401 response can be retried. No Pi agent turn, tool
 * execution, streamed response, or specialist work item is ever replayed.
 */
const OPENAI_ORIGINS = new Set(['https://api.openai.com', 'https://chatgpt.com'])

export function withOpenAiOAuth401Retry(
  send: typeof fetch,
  renew: (rejectedAccess: string) => Promise<string | null | undefined>,
): typeof fetch {
  return async (input, init) => {
    const response = await send(input, init)
    if (response.status !== 401 || init?.signal?.aborted) return response

    // Do not retry an arbitrary provider URL, non-replayable body, or a
    // request without the exact bearer credential which was rejected.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null
    if (!url || !URL.canParse(url) || !OPENAI_ORIGINS.has(new URL(url).origin) ||
        (init?.body != null && typeof init.body !== 'string') ||
        !['GET', 'POST'].includes((init?.method ?? 'GET').toUpperCase()))
      return response
    const headers = new Headers(init?.headers)
    const bearer = headers.get('authorization')
    if (!bearer?.startsWith('Bearer ') || !bearer.slice(7)) return response

    let rotated: string | null | undefined
    try { rotated = await renew(bearer.slice(7)) }
    catch { throw new Error('OpenAI OAuth refresh failed. Reconnect the model provider before retrying.') }
    if (rotated === null) return response // Not an OAuth credential: keep the provider's 401.
    if (!rotated || rotated === bearer.slice(7))
      throw new Error('OpenAI OAuth refresh did not rotate the rejected access token.')
    init?.signal?.throwIfAborted()
    headers.set('authorization', 'Bearer ' + rotated)
    await response.body?.cancel().catch(() => {})
    // Exactly one retry, regardless of the status of its response.
    return send(input, { ...init, headers })
  }
}

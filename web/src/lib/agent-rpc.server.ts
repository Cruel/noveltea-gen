/** Agent RPC is an operator-configured private trusted-service channel.
 * Authenticated web users never see the token; no controller socket is mounted
 * into the web service. Unavailable agent => fail closed, not inline execution. */
export async function postAgentAuthorCommand(ownerId: string, jobId: string,
  command: Record<string, unknown>): Promise<Response> {
  const endpoint = process.env.NT_AGENT_RPC_URL
  const secret = process.env.NT_AGENT_RPC_TOKEN
  if (!endpoint || !secret || secret.length < 32)
    return Response.json({ error: 'Trusted agent is not configured' }, { status: 503 })
  let url: URL
  try {
    url = new URL('/v1/author', endpoint)
    if (url.protocol !== 'http:' || url.username || url.password ||
        !url.hostname || url.search || url.hash) throw new Error('Invalid private endpoint')
  } catch {
    return Response.json({ error: 'Trusted agent configuration is invalid' }, { status: 503 })
  }
  try {
    const result = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
      body: JSON.stringify({ ownerId, jobId, command }), redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    const body = await result.text()
    if (body.length > 64 * 1024) throw new Error('Unexpected agent response size')
    return new Response(body, { status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Trusted agent is unavailable; no author response was applied' },
      { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}

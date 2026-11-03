/** Bounded JSON input for small account/settings mutations; never buffer unbounded bodies. */
export class JsonInputError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}

export async function readJsonInput(request: Request, maxBytes = 8192): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new JsonInputError(400, 'A JSON request body is required.')
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new JsonInputError(413, 'Request body is too large.')
      parts.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown
  } catch {
    throw new JsonInputError(400, 'Request body must contain valid UTF-8 JSON.')
  }
}

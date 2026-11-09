/**
 * Shared application-visible representations for SQLite/pg driver results.
 * StudioDb describes the physical schema: INTEGER booleans are 0/1, JSON and
 * timestamp TEXT are strings. Convert only at domain boundaries, never by
 * installing global pg parsers that silently narrow or reinterpret other data.
 */
export function studioSafeInteger(value: number | string | bigint): number {
  const parsed =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number'
        ? Number.isSafeInteger(value)
          ? BigInt(value)
          : null
        : /^-?(?:0|[1-9]\d*)$/.test(value)
          ? BigInt(value)
          : null
  if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError('Studio integer is invalid or outside JavaScript safe integer range')
  return Number(parsed)
}

export function studioBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  throw new TypeError('Expected a Studio boolean stored as 0 or 1')
}

export function storedStudioBoolean(value: boolean): 0 | 1 {
  if (typeof value !== 'boolean') throw new TypeError('Studio boolean input must be a boolean')
  return value ? 1 : 0
}

export function studioJson<T>(text: string): T {
  if (typeof text !== 'string') throw new TypeError('Studio JSON is stored as TEXT')
  return JSON.parse(text) as T
}

export function storedStudioJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('Studio JSON cannot be serialized')
  return encoded
}

export function studioTimestamp(value: string | Date): string {
  const normalized = value instanceof Date ? value.toISOString() : value
  if (
    typeof normalized !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  )
    throw new TypeError('Studio timestamp must be an ISO-8601 UTC string or Date')
  return normalized
}

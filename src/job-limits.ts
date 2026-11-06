/** Job-requested ceilings. Docker authority remains with the trusted controller. */
export type JobLimits = {
  steps?: number
  modelCalls?: number
  costUsd?: number
  activeSeconds?: number
  cpu?: number
  memoryMiB?: number
  pids?: number
}

const bounds = {
  steps: [0, 1_000_000],
  modelCalls: [0, 1_000_000],
  costUsd: [0, 1_000_000],
  activeSeconds: [0, 1_000_000],
  cpu: [0.1, 64],
  memoryMiB: [64, 65_536],
  pids: [16, 4_096],
} as const

/** Fail closed on unknown fields rather than silently ignoring forged limits. */
export function parseJobLimits(value: unknown): JobLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid job budget limits.')
  const limits: JobLimits = {}
  for (const [key, amount] of Object.entries(value)) {
    if (!(key in bounds)) throw new Error('Unsupported job budget limit: ' + key)
    // The established CLI constructs optional fields with undefined values;
    // omitted limits retain their previous behavior, while JSON never carries undefined.
    if (amount === undefined) continue
    const [min, max] = bounds[key as keyof JobLimits]
    if (typeof amount !== 'number' || !Number.isFinite(amount) ||
        amount < min || amount > max ||
        (key !== 'costUsd' && key !== 'cpu' && key !== 'activeSeconds' && !Number.isSafeInteger(amount))) {
      throw new Error('Budget limits must be bounded, valid numbers.')
    }
    ;(limits as Record<string, number>)[key] = amount
  }
  return limits
}

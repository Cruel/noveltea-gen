/** Deterministic longest-processing-time scheduling. Weights influence only
 * scheduling, never eligibility. Every input name belongs to one bucket. */
export function timingShards(names: readonly string[], count: number,
  weight: (name: string) => number): string[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > names.length)
    throw Error("Invalid shard count");
  if (new Set(names).size !== names.length) throw Error("Duplicate test unit name");
  const buckets = Array.from({ length: count }, () => ({ names: [] as string[], weight: 0 }));
  for (const name of [...names].sort((a, b) => weight(b) - weight(a) ||
    (a < b ? -1 : a > b ? 1 : 0))) {
    const bucket = buckets.reduce((least, next) => next.weight < least.weight ? next : least);
    bucket.names.push(name);
    bucket.weight += weight(name);
  }
  return buckets.map(bucket => bucket.names);
}

export function parseTimingShard(shard: string): { index: number; count: number } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count)
    throw Error("Invalid shard: " + shard);
  return { index: index - 1, count };
}

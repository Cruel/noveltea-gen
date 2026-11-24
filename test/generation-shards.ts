/** Balance serial generation scenarios across isolated CI runners.
 * Estimates are rounded seconds from native CI run 45322231869. Only the
 * expensive outliers need explicit weights; new tests participate automatically.
 * This affects scheduling only, never whether a test is eligible to run. */
const slowCases: Record<string, number> = {
  "R14D Event native correction and negative Review recover in the original SQLite assignment": 32,
  "R14D Event native correction and negative Review recover in the original SQLite assignment with Character support": 60,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-stalled-continue)": 210,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-converges)": 147,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-stalled)": 111,
  "R05 World and Character metadata and independent Review corrections resume the original Thread in order": 51,
  "R14C Choice and Puzzle native and independent Review corrections preserve their distinct original assignments": 90,
  "actual generation graph resumes Event-only Composition after historical knowledge correction (#229/#231 fixture)": 42,
  "C05 contradictory independently passed final report admits one read-only Pi diagnosis, never a Story pass": 36,
  "actual generation graph resumes Event-only Composition after historical specialist correction (#229/#231 fixture)": 33,
  "#213 narrative-led full-Story handoff keeps omitted mechanics distinct from a completed Story": 33,
  "parent integrates eligible deferred ideas through the dedicated placement workflow and preserves source intent": 31,
  "later canonical development triggers a bounded persisted idea reassessment": 31,
  "#240 production closeout cannot promote a fixture Event to a Pi-owned review grant": 27,
  "#237: actual parent verifier fences an uncarried reviewed event result, then resumes only after signed reauthorization": 26,
  "#212: certified predecessor is carried across approval, corrected source gets a fresh Event and Blueprint": 25,
  "#233: authenticated author-directed Architecture change is visible in operator incident inspection": 24,
  "#237: actual parent verifier fences an uncarried reviewed foundations result, then resumes only after signed reauthorization": 22,
  "#240 original staged Event is authentically authored by a scripted Pi agent": 20,
  "production resume assesses failed scheduling without repeating completed work": 19,
  "#244 C07 original-Thread Event-only correction reaches reviewed Composition and completed Turn": 19,
  "R13 verified original-Thread corrections cannot waive a negative final Turn objective": 29,
  "multi-Milestone generation develops every selected cluster across process restarts": 18,
};

export function generationWeight(name: string): number {
  return slowCases[name] ?? (name.startsWith("actual generation graph resumes Event-only Composition after historical ") ? 23 : 10);
}

/** Longest-processing-time scheduling, with deterministic ties. The plan uses
 * the complete registered name list, including fixture and live-only cases;
 * every name belongs to exactly one bucket regardless of skip settings. */
export function generationShards(names: readonly string[], count: number): string[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > names.length)
    throw Error("Invalid generation shard count");
  if (new Set(names).size !== names.length) throw Error("Duplicate generation test name");
  const buckets = Array.from({ length: count }, () => ({ names: [] as string[], weight: 0 }));
  for (const name of [...names].sort((a, b) => generationWeight(b) - generationWeight(a) ||
    (a < b ? -1 : a > b ? 1 : 0))) {
    const bucket = buckets.reduce((least, next) => next.weight < least.weight ? next : least);
    bucket.names.push(name);
    bucket.weight += generationWeight(name);
  }
  return buckets.map(bucket => bucket.names);
}

export function selectGenerationShard(names: readonly string[], shard: string): string[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) throw Error("Invalid generation shard: " + shard);
  return generationShards(names, Number(match[2]))[Number(match[1]) - 1]!;
}

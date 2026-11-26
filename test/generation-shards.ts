import { parseTimingShard, timingShards } from "./support/timing-shards.js";

/** Balance serial generation scenarios across isolated CI runners.
 * Weights are rounded up from CI run 45724395595; timed-out and cascading
 * cases use conservative estimates until a complete observation is available.
 * Scheduling only: every registered test remains eligible. */
const slowCases: Record<string, number> = {
  "C04 typed Character prerequisite supports reviewed World and resumes the original assignment": 30,
  "C04 typed Character prerequisite supports reviewed World and resumes the original assignment with native diagnosis": 85,
  "C08 parent Idea dispatch and verification authenticate the original task deferred": 55,
  "C08 parent Idea dispatch and verification authenticate the original task deferred-two": 35,
  "C08 parent Idea dispatch and verification authenticate the original task foreign-dispatch": 40,
  "C08 parent Idea dispatch and verification authenticate the original task unverified-result": 50,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (author-pause)": 30,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-converges)": 35,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-native)": 30,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-native-diagnosis)": 30,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-native-steer)": 30,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-stalled)": 35,
  "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (review-stalled-continue)": 75,
  "R05 World and Character metadata and independent Review corrections resume the original Thread in order": 100,
  "R06 real Interactive Pi manifest correction preserves the original session and zero-write dependency": 45,
  "R07 choice suspends for independently verified upstream owner and continues original writer": 30,
  "R07 composition suspends for independently verified upstream owner and continues original writer": 55,
  "R07 composition-choice suspends for independently verified upstream owner and continues original writer": 90,
  "R07 composition-multi suspends for independently verified upstream owner and continues original writer": 100,
  "R07 composition-puzzle suspends for independently verified upstream owner and continues original writer": 95,
  "R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling": 245,
  "R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling with repaired producer": 155,
  "R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling with repaired-sibling producer": 305,
  "R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling with supported producer": 315,
  "R07 puzzle suspends for independently verified upstream owner and continues original writer": 95,
  "R07 retained Choice independent corrects the original owner and preserves the RecoveryCase": 25,
  "R07 retained Choice native corrects the original owner and preserves the RecoveryCase": 25,
  "R07 retained Choice support corrects the original owner and preserves the RecoveryCase": 110,
  "R08 blueprint suspends for independently verified upstream owner and continues original writer": 45,
  "R08 blueprint-consumer suspends for independently verified upstream owner and continues original writer": 85,
  "R14C Choice and Puzzle native and independent Review corrections preserve their distinct original assignments": 180,
  "R14D Event native correction and negative Review recover in the original SQLite assignment binding-diagnosis": 25,
  "R14D Event native correction and negative Review recover in the original SQLite assignment diagnosis": 25,
  "R14D Event native correction and negative Review recover in the original SQLite assignment future-choice": 45,
  "R14D Event native correction and negative Review recover in the original SQLite assignment other-owner": 180,
  "R14D Event native correction and negative Review recover in the original SQLite assignment other-owner-world": 75,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective": 220,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-multi": 60,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-paused": 65,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-refused": 20,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-author": 140,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-native-diagnosis": 85,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-native-protocol": 55,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-negative": 115,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-outside": 20,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-stalled": 150,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-review-stalled-continue": 200,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-unauthorized": 20,
  "R14D Event native correction and negative Review recover in the original SQLite assignment prospective-writer-native-diagnosis": 50,
  "R14D Event native correction and negative Review recover in the original SQLite assignment review": 35,
  "R14D Event native correction and negative Review recover in the original SQLite assignment scene-evidence": 35,
  "R14D Event native correction and negative Review recover in the original SQLite assignment settled-no-write": 25,
  "R14D Event native correction and negative Review recover in the original SQLite assignment source-diagnostic-stop": 25,
  "R14D Event native correction and negative Review recover in the original SQLite assignment source-provider-pause": 35,
  "R14D Event native correction and negative Review recover in the original SQLite assignment source-recovery": 35,
  "R14D Event native correction and negative Review recover in the original SQLite assignment stale-choice-finding": 30,
  "R14D Event native correction and negative Review recover in the original SQLite assignment support": 90,
  "R14D Event native correction and negative Review recover in the original SQLite assignment support-negative": 160,
  "R14D Event native correction and negative Review recover in the original SQLite assignment writer-other-owner": 45,
  "R14I production World question resumes the same child and Pi session crash": 20,
  "R14I production World question resumes the same child and Pi session public-cli": 20,
  "R14I production World question resumes the same child and Pi session studio": 40,
  "R14K archive production Event prerequisites use current local plan and native field grant": 25,
  "R14K canonical archive baseline executes Foundation, Blueprint, Architecture and World/Character with actual current Turn": 30,
  "R14K current archive reaches actual reviewed Composition and Turn fulfillment": 75,
};

export function generationWeight(name: string): number {
  return slowCases[name] ?? (name.startsWith("actual generation graph resumes Event-only Composition after historical ") ? 23 : 10);
}

/** Longest-processing-time scheduling, with deterministic ties. The plan uses
 * the complete registered name list, including fixture and live-only cases;
 * every name belongs to exactly one bucket regardless of skip settings. */
export function generationShards(names: readonly string[], count: number): string[][] {
  return timingShards(names, count, generationWeight);
}

export function selectGenerationShard(names: readonly string[], shard: string): string[] {
  const { index, count } = parseTimingShard(shard);
  return generationShards(names, count)[index]!;
}

// Same CI run. The cancelled Review-assessment duration is a lower bound.
const focusedCases: Record<string, number> = {
  "public scoped generation revises Event, Character, Choice, Puzzle and branch-aware prose independently": 95,
  "R07 focused commit before checkpoint finalization resumes without replay": 15,
  "R04 cross-owner prerequisite review uses the original logical assignment": 55,
  "R04 cross-owner prerequisite writer uses the original logical assignment": 20,
  "R04 cross-owner prerequisite support-no-write uses the original logical assignment": 20,
  "R04 cross-owner prerequisite nested uses the original logical assignment": 40,
  "R04 cross-owner prerequisite writer-native-diagnosis uses the original logical assignment": 25,
  "R04 cross-owner prerequisite review-native-diagnosis uses the original logical assignment": 95,
  "R04 cross-owner prerequisite writer-review-assessment uses the original logical assignment": 220,
  "R04 cross-owner prerequisite review-review-assessment uses the original logical assignment": 420,
};
export function focusedGenerationWeight(name: string): number {
  return focusedCases[name] ?? 10;
}
export function selectFocusedGenerationShard(names: readonly string[], shard: string): string[] {
  const { index, count } = parseTimingShard(shard);
  return timingShards(names, count, focusedGenerationWeight)[index]!;
}

/** Read-only anchor for a review-rejected Choice, including a second
 * independently rejected correction. The original Choice's own receipt
 * always names its FIRST authored commit, not the latest repaired source.
 * The surrounding repair controller separately verifies each sealed
 * negative review, typed successor, Git ancestry and native validation. */
export function assertOriginalChoiceRepairEvidence(
  unit: {
    phase?: string;
    commitSha?: string;
    paths?: string[];
    obligations?: string[];
  } | undefined,
  rootFailureSha: string,
): asserts unit is {
  phase: "committed"; commitSha: string; paths: string[]; obligations: string[];
} {
  if (!/^[a-f0-9]{40}$/.test(rootFailureSha) ||
      unit?.phase !== "committed" || unit.commitSha !== rootFailureSha ||
      !Array.isArray(unit.paths) || !unit.paths.length ||
      !Array.isArray(unit.obligations)) {
    throw Error("Repaired Choice lost its source-bound original unit and consequences.");
  }
}

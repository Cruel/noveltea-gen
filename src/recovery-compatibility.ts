import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseContract, type Plan } from "./architecture.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import type { JobStartResult } from "./job.js";
import { verifyForkValidator, type NativeValidatorPin } from "./validator.js";

/** A closed, user-facing set of recovery outcomes. Never expose private
 * receipts, paths, approval payloads, or provider errors to the browser. */
export class RecoveryCompatibilityError extends Error {
  constructor(readonly code: "obsolete-checkpoint" | "invalid-evidence" | "missing-tooling" |
    "incompatible-story" | "changed-tooling", message: string) {
    super(message);
    this.name = "RecoveryCompatibilityError";
  }
  get nextSteps(): string[] {
    switch (this.code) {
      case "missing-tooling":
        return ["Restore the pinned skills snapshot or install verified current tooling.",
          "If the original checkpoint is verified, review and prepare a fresh continuation in the same Thread."];
      case "incompatible-story":
        return ["Inspect the checkpoint and manually migrate the Story to the current canonical schema.", "Alternatively, start a fresh Thread; legacy checkpoints cannot be automatically replayed."];
      case "changed-tooling":
        return ["Check that web and agent use the same skills snapshot cache and native validator versions.",
          "Review and prepare a fresh continuation from the original verified checkpoint in the same Thread."];
      default:
        return ["Inspect the original checkpoint and restore its trusted receipts or approvals.", "If it cannot be reconciled, manually migrate the Story or start a fresh Thread."];
    }
  }
}

export interface RecoveryToolchain {
  graphSchema: "noveltea-generation/v1";
  runtime: { nodeVersion: string; continuationSchema: "noveltea-fork/v2" };
  validator: NativeValidatorPin;
  skills: SkillSnapshot;
}

/** Check the persisted logical contract before any child Git or graph effects.
 * Versioned shapes that are not understood cannot be replayed automatically. */
export function assertRecoveryCompatibility(point: RecoveryCheckpoint): Plan | null {
  if (point.version !== 1 || point.status !== "finalized" ||
      point.compatibility?.logicalSchema !== "noveltea-recovery/v1" ||
      point.compatibility.graphSchema !== "noveltea-generation/v1") {
    throw new RecoveryCompatibilityError("obsolete-checkpoint",
      "This checkpoint's recovery or graph layout is no longer supported.");
  }
  if (point.provenance?.authorApprovals !== "source-bound-not-reusable" ||
      point.provenance.authorMessages !== "source-bound-not-reusable") {
    throw new RecoveryCompatibilityError("invalid-evidence",
      "This checkpoint uses obsolete authorization evidence; prior approvals cannot be transferred.");
  }
  if (!Array.isArray(point.completedWorkItems) || !Array.isArray(point.remainingWorkItems) ||
      !point.completedWorkItems.includes(point.workItem) || !point.validation?.validatorVersion ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(point.validation.validatorVersion) ||
      point.validation.status === "not-verified") {
    throw new RecoveryCompatibilityError("invalid-evidence",
      "This checkpoint has incomplete committed-work or validator evidence.");
  }
  if (point.plan === null) {
    if (point.workItem !== "foundation" || point.planVersion !== null)
      throw new RecoveryCompatibilityError("obsolete-checkpoint",
        "The checkpoint has no compatible approved architecture plan.");
    return null;
  }
  const plan = point.plan as Plan;
  try {
    if (!Number.isSafeInteger(plan.version) || plan.version < 1 || plan.version !== point.planVersion ||
        !Array.isArray(plan.items) || !plan.items.length ||
        !plan.items.every(item => item && typeof item.id === "string" &&
          typeof item.kind === "string" && Array.isArray(item.targetIds) &&
          (item.dependencies === undefined || Array.isArray(item.dependencies))) ||
        !plan.items.some(item => item.id === "global-architecture" &&
          item.status === "verified" && /^[a-f0-9]{40}$/.test(item.verifiedSha ?? "")) ||
        JSON.stringify(parseContract(plan.contract)) !== JSON.stringify(plan.contract))
      throw new Error("incompatible plan");
  } catch {
    throw new RecoveryCompatibilityError("obsolete-checkpoint",
      "The historical plan or completion contract cannot be interpreted by the current graph.");
  }
  return plan;
}

/** Do not feed unknown historical receipt layouts into current specialist
 * recovery code. The source's independently authenticated commit/receipt
 * remains authoritative; this checks only whether the current adapters can
 * understand its schema and safe work boundary. */
export function assertRecoveryReceiptCompatibility(
  source: string, receipt: Record<string, any>, completed: ReadonlySet<string>): void {
  const incompatible = () => {
    throw new RecoveryCompatibilityError("obsolete-checkpoint",
      "A saved specialist receipt uses an incompatible or incomplete layout.");
  };
  if (!receipt || typeof receipt !== "object" || !/^[a-f0-9]{64}$/.test(receipt.snapshot?.id ?? ""))
    incompatible();
  if (source === "foundation.json") {
    if (receipt.version !== 1 || receipt.stage !== "committed" ||
        !/^[a-f0-9]{40}$/.test(receipt.commitSha ?? "")) incompatible();
    return;
  }
  if (source === "architecture.json") {
    if (receipt.format !== 1 || receipt.phase !== "committed" ||
        !receipt.plan || !Array.isArray(receipt.history)) incompatible();
    return;
  }
  if (source === "character-world.json" || source.startsWith("interactive-items/")) {
    const domains = source === "character-world.json"
      ? ["world-foundations", "character-foundations"]
      : (() => { const slug = source.slice("interactive-items/".length, -5);
        return ["interactive-choice-" + slug, "interactive-puzzle-" + slug]; })();
    if (receipt.version !== 1 || !Array.isArray(receipt.units) || receipt.units.length !== 2 ||
        receipt.units.some((unit: Record<string, any>, index: number) =>
          unit.id !== domains[index] || unit.phase !== (completed.has(unit.id) ? "committed" : "pending") ||
          (completed.has(unit.id) && !/^[a-f0-9]{40}$/.test(unit.commitSha ?? "")))) incompatible();
    return;
  }
  if (source.startsWith("event-items/") || source.startsWith("composition-items/") ||
      source.startsWith("focused-items/")) {
    if (receipt.version !== 1 || receipt.phase !== "committed" ||
        !completed.has(receipt.workItemId) ||
        !/^[a-f0-9]{40}$/.test(receipt.commitSha ?? "")) incompatible();
    return;
  }
  incompatible();
}

/** The original validator is evidence, not the executable the child will run.
 * The installed CLI and currently configured skills receive fresh, independently
 * verified pins. This operation never repins or validates the active parent. */
export async function selectCurrentRecoveryToolchain(parent: JobStartResult,
  point: RecoveryCheckpoint, skillsSource?: string): Promise<RecoveryToolchain> {
  let validator: NativeValidatorPin;
  try { validator = await verifyForkValidator(parent, point.validation.validatorVersion); }
  catch {
    throw new RecoveryCompatibilityError("missing-tooling",
      "The source validator pin or current native CLI cannot be verified.");
  }
  let skills: SkillSnapshot | undefined;
  try {
    const configured = process.env.NT_STUDIO_SKILLS_SOURCE ?? skillsSource ??
      (await loadSkillConfig()).novelteaSkills;
    if (!configured) throw new Error("no configured skills");
    skills = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: configured, skillDirs: [], requiredSkills: [] });
    if (!skills || await openSkillSnapshot(skills.id) !== skills.path) throw new Error("invalid snapshot");
    const required = ["nt-catalog", "nt-story-discovery", "nt-story-architecture",
      "nt-worldbuilding", "nt-character-development", "nt-event-design",
      "nt-interactive-narrative", "nt-puzzle-design", "nt-narrative-composition",
      "nt-narrative-review"];
    for (const name of required) {
      const file = join(skills.path, "skills", name, "SKILL.md");
      if (!(await readFile(file, "utf8")).trim()) throw new Error("empty required skill");
    }
  } catch {
    throw new RecoveryCompatibilityError("missing-tooling",
      "Current NovelTea skills or their pinned snapshot are missing or incomplete.");
  }
  return { graphSchema: "noveltea-generation/v1",
    runtime: { nodeVersion: process.version, continuationSchema: "noveltea-fork/v2" },
    validator, skills };
}

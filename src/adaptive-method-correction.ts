/** Controller checks required adaptive methodology via successful read tool
 * receipts, not the model's assertion. A missing read may be requested once
 * in the SAME original read-only session; an interrupted session is never
 * recreated or silently accepted. */
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";

export function missingAdaptiveMethodReads(
  messages: AgentSession["messages"],
  projectRoot: string, snapshotRoot: string, resources: readonly string[],
): string[] {
  const reads = completedPinnedSkillReads(messages, projectRoot, snapshotRoot);
  return resources.filter(path => !reads.includes(join(snapshotRoot, "skills", path)));
}

export function adaptiveMethodCorrectionPrompt(resources: readonly string[]): string {
  if (!resources.length || resources.length > 16 ||
      resources.some(p => !/^[a-z0-9-]+\/(?:SKILL\.md|references\/[a-z0-9-]+\.md)$/.test(p)))
    throw Error("Adaptive methodology correction requires exact pinned resource paths.");
  return "CONTROLLER METHODOLOGY CORRECTION (same read-only Pi session): Your previous " +
    "proposal lacks successful reads of these REQUIRED pinned methods. Read EVERY " +
    "listed reference using the read tool with the exact skill:// address. " +
    "Re-evaluate your original proposal against the newly read instructions and " +
    "canonical sources. Do not change any Story files or claim authority. " +
    "Return the COMPLETE source-bound proposal JSON, with all six required keys, " +
    "and no other text. If the correct result is unchanged, use empty actions. " +
    "This correction does not change sourceSha, original goal, or plan version.\n" +
    resources.map(path => "skill://" + path).join("\n");
}

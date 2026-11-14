/** Verify real, successful Pi skill reads. A missing read may be corrected once
 * in the SAME active session; do not restart an interrupted author or accept
 * the model's self-report in place of tool evidence. */
import { resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";

/** Canonicalize a successful pinned skill read for source-bound evidence. */
export function canonicalPinnedReadPath(requested: string, storyRoot: string, snapshotRoot: string): string {
  if (!requested.startsWith("skill://")) return resolve(storyRoot, requested);
  const segments = requested.slice("skill://".length).split("/");
  if (segments.length < 2 || segments.some(part =>
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) || part === "..")) return "";
  return resolve(snapshotRoot, "skills", ...segments);
}

export function completedPinnedSkillReads(messages: AgentSession["messages"], root: string,
  snapshotRoot?: string): string[] {
  const successful = new Set(messages.filter(m => m.role === "toolResult" && !m.isError)
    .map(m => m.role === "toolResult" ? m.toolCallId : ""));
  return [...new Set(messages.flatMap(m => m.role === "assistant"
    ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
        c.type === "toolCall" && c.name === "read" && successful.has(c.id) &&
        typeof c.arguments?.path === "string")
      .map(c => snapshotRoot
        ? canonicalPinnedReadPath(c.arguments.path as string, root, snapshotRoot)
        : resolve(root, c.arguments.path as string))
    : []))];
}

export async function requirePinnedSkillReads(session: AgentSession, root: string,
  required: string[], stage: string): Promise<string[]> {
  const first = required.find(path => path.includes("/skills/"));
  // Cache roots themselves can contain /skills/ (e.g. $TMP/skills/<digest>).
  // The final /skills/ component names the actual snapshot skill directory.
  const snapshotRoot = first?.slice(0, first.lastIndexOf("/skills/"));
  const reads = () => completedPinnedSkillReads(session.messages, root, snapshotRoot);
  const missing = () => required.filter(path => !reads().includes(path));
  if (missing().length) {
    await promptStorySpecialist(session,
      "Your previous attempt did NOT successfully read every mandatory pinned skill reference. " +
      "Read each missing reference using the read tool with its EXACT absolute path, " +
      "without altering any characters or snapshot hash. Reassess your existing draft against " +
      "the newly read guidance; repair only authorized Story files if needed, " +
      "run story_validate, then repeat the COMPLETE modifiedRecords/architecturalConflicts/" +
      "laterObligations JSON manifest. Do not stage or commit anything.\nMISSING EXACT PATHS:\n" +
      missing().join("\n"));
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
      throw new Error(stage + " pinned-skill correction failed; preserve the current work-item draft.");
    }
  }
  if (missing().length) throw new Error(stage + " did not read every required pinned skill reference: " +
    missing().map(path => path.slice(path.lastIndexOf("/skills/") + 8)).join(", "));
  return reads().filter(path => required.includes(path));
}

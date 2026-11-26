/** Verify real, successful Pi skill reads. A missing read may be corrected once
 * in the SAME active session; do not restart an interrupted author or accept
 * the model's self-report in place of tool evidence. */
import { join, resolve } from "node:path";
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

/** A completed read-only proposal may repair missing methodology in its
 * original conversation, once, before format-only protocol admission. This
 * is a source inspection, not a JSON repair or new writer authorization.
 * The caller owns the durable invocation, budget, source and settlement
 * checks. Interrupted/unsuccessful corrections never authorize a proposal. */
export async function correctReadOnlyPinnedMethodology(options: {
  session: Pick<AgentSession, "messages" | "getActiveToolNames" | "setActiveToolsByName">;
  root: string; snapshotRoot: string; resources: readonly string[];
  beforeCorrection: () => Promise<void>;
  prompt: (feedback: string) => Promise<void>;
  expectedResponse: string;
}): Promise<void> {
  const { session, root, snapshotRoot, resources } = options;
  if (!resources.length || resources.length > 16 || resources.some(path =>
    !/^[a-z0-9-]+\/(?:SKILL\.md|references\/[a-z0-9-]+\.md)$/.test(path)))
    throw Error("Read-only methodology correction requires exact pinned resource paths.");
  const assertCompleted = () => {
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop")
      throw Error("Read-only methodology correction requires a completed original response.");
  };
  const missing = () => {
    const reads = completedPinnedSkillReads(session.messages, root, snapshotRoot);
    return resources.filter(path => !reads.includes(join(snapshotRoot, "skills", path)));
  };
  assertCompleted();
  const absent = missing();
  if (!absent.length) return;
  const originalTools = session.getActiveToolNames();
  if (!originalTools.includes("read") ||
      originalTools.some(name => !["read", "grep", "find", "ls"].includes(name)))
    throw Error("Read-only methodology correction lost its original read-only tool authority.");
  await options.beforeCorrection();
  session.setActiveToolsByName(["read"]);
  try {
    await options.prompt(
      "CONTROLLER METHODOLOGY CORRECTION (same read-only Pi session): Your previous response " +
      "omitted successful mandatory pinned methodology reads. Use the read tool with each EXACT " +
      "skill:// address below. Do not search outside the Story or use absolute snapshot paths. " +
      "Reassess the original proposal using the newly read guidance and the original canonical " +
      "evidence. Do not change the source, author objective, plan version or write scope. " +
      "Do not edit any files or claim approval. Return " + options.expectedResponse +
      ". If the original proposal is not justified, return the permitted refusal instead.\n" +
      absent.map(path => "skill://" + path).join("\n"),
    );
    assertCompleted();
  } finally { session.setActiveToolsByName(originalTools); }
  const remaining = missing();
  if (remaining.length)
    throw Error("Read-only methodology correction exhausted its one continuation; no proposal authorized. Missing: " +
      remaining.join(", "));
}

export async function requirePinnedSkillReads(session: AgentSession, root: string,
  required: string[], stage: string, expectedReport =
    "modifiedRecords/architecturalConflicts/laterObligations JSON manifest"): Promise<string[]> {
  const first = required.find(path => path.includes("/skills/"));
  // Cache roots themselves can contain /skills/ (e.g. $TMP/skills/<digest>).
  // The final /skills/ component names the actual snapshot skill directory.
  const snapshotRoot = first?.slice(0, first.lastIndexOf("/skills/"));
  const reads = () => completedPinnedSkillReads(session.messages, root, snapshotRoot);
  const missing = () => required.filter(path => !reads().includes(path));
  if (missing().length) {
    await promptStorySpecialist(
      session,
      "Your previous attempt did NOT successfully read every mandatory pinned skill reference. " +
        "Read each missing reference using the read tool with its EXACT stable skill:// " +
        "address, never an absolute snapshot hash path. Reassess your existing draft against " +
        "the newly read guidance; repair only authorized Story files if needed, " +
        "run story_validate, then repeat the COMPLETE " + expectedReport +
        ". Do not stage or commit anything.\nMISSING PINNED REFERENCES:\n" +
        missing()
          .map((path) => "skill://" + path.slice(path.lastIndexOf("/skills/") + 8))
          .join("\n"),
    );
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
      throw new Error(stage + " pinned-skill correction failed; preserve the current work-item draft.");
    }
  }
  if (missing().length) throw new Error(stage + " did not read every required pinned skill reference: " +
    missing().map(path => path.slice(path.lastIndexOf("/skills/") + 8)).join(", "));
  return reads().filter(path => required.includes(path));
}

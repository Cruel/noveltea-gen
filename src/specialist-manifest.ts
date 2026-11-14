import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";

/** Extract the final JSON manifest without mistaking braces embedded in
 * quoted obligation text (e.g. `fulfillment: {any_of: []}`) for object delimiters.
 * Match the required first field so preceding prose examples are not treated as
 * authoritative output. Do not use regex character classes to balance JSON. */
export function lastSpecialistManifest(text: string): Record<string, unknown> | null {
  const marker = [...text.matchAll(/\{\s*"modifiedRecords"\s*:/g)].at(-1);
  if (!marker) return null;
  const start = marker.index;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (--depth !== 0) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        /* invalid final manifest; never accept an earlier stale one */
      }
      return null;
    }
  }
  return null;
}

/** Recover only a malformed final REPORT, never the authored Story source.
 * Keep the same Pi session; one correction turn may read but cannot write.
 * The stage's strict parser and independent Git diff audit still apply. */
export async function requireSpecialistManifest<T>(
  session: AgentSession, parse: (text: string) => T, stage: "Event" | "Interactive",
): Promise<T> {
  const reply = (): string => {
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" ||
        ["error", "aborted"].includes(last.stopReason))
      throw new Error(stage + " manifest response failed; preserve the original draft.");
    return last.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  };
  try {
    return parse(reply());
  } catch (error) {
    if (!(error instanceof Error) ||
        !error.message.startsWith(stage + " specialist must return")) throw error;
    const before = session.messages.length;
    await promptStorySpecialist(session,
      "Your final JSON manifest has the wrong shape. Do NOT edit Story files or start " +
      "new work. Return ONLY a complete unfenced JSON object with all three arrays " +
      "containing STRINGS, never {id,path}, {owner,obligation} or other objects. " +
      "modifiedRecords must list every actual cumulative Story-relative changed path, " +
      "architecturalConflicts and laterObligations must be arrays of plain descriptions. " +
      "Preserve the original facts, real conflicts and handoff: do not invent, omit or " +
      "weaken any obligation. Example SHAPE (substitute real data): " +
      '{"modifiedRecords":["events/example.md"],"architecturalConflicts":[],"laterObligations":["Formal Choice binding remains"]}.');
    if (session.messages.slice(before).some(m => m.role === "assistant" &&
        m.content.some(c => c.type === "toolCall" && ["write", "edit"].includes(c.name))))
      throw new Error(stage + " manifest-only correction attempted new writes.");
    return parse(reply());
  }
}

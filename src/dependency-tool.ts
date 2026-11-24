import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { parseDependencyReport, type DependencyReport } from "./dependency-amendments.js";
import { sourceDigest } from "./dependency-state.js";

/** Evidence only. The tool cannot approve an amendment, widen writes or restart
 * the caller. Identity and source hashes are stamped by the trusted host. */
export function createDependencyTool(job: JobStartResult, binding: {
  head: string; turnDigest: string; assignmentId: string; obligations: string[];
}, receive: (report: DependencyReport) => void | Promise<void>): ToolDefinition {
  return {
    name: "report_dependency", label: "Report a missing narrative prerequisite",
    description: "Report a causally necessary cross-domain prerequisite, then stop WITHOUT edits. " +
      "Use exact existing IDs, Story quotations and an exact original delivery obligation. " +
      "This is evidence only, never write authority. Set authorDecisionRequired=true only " +
      "if the prerequisite alters a protected author decision or materially changes the Turn goal; " +
      "a routine causal correction to an unprotected Event/knowledge step is not itself author approval.",
    parameters: { type: "object", properties: {
      obligationIndex: { type: "integer", minimum: 0, maximum: binding.obligations.length - 1,
        description: "0-based index into the pinned original Turn obligations; the controller stamps exact text." },
      missing: { type: "string" },
      affectedIds: { type: "array", items: { type: "string" }, maxItems: 12 },
      sources: { type: "array", maxItems: 8, items: { type: "object", properties: {
        path: { type: "string" }, quote: { type: "string" },
      }, required: ["path", "quote"], additionalProperties: false } },
      likelySpecialist: { type: "string" }, authorDecisionRequired: { type: "boolean",
        description: "True ONLY for protected/author decision changes or material original-goal changes; " +
          "false for unprotected cross-domain knowledge continuity repairs." },
    }, required: ["obligationIndex", "missing", "affectedIds", "sources", "likelySpecialist", "authorDecisionRequired"],
    additionalProperties: false } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, raw: unknown) {
      const input = raw as Record<string, unknown>;
      if (!input || Object.keys(input).sort().join(",") !==
          "affectedIds,authorDecisionRequired,likelySpecialist,missing,obligationIndex,sources")
        throw Error("Invalid dependency report fields.");
      const { obligationIndex, ...evidence } = input;
      if (!Number.isSafeInteger(obligationIndex) || (obligationIndex as number) < 0 ||
          (obligationIndex as number) >= binding.obligations.length)
        throw Error("Dependency obligation index must select a pinned original Turn obligation.");
      if (!Array.isArray(input.affectedIds) ||
          !input.affectedIds.includes(binding.assignmentId.replace(/^focus:/, "")))
        throw Error("Dependency report must include the originating assignment's typed record ID.");
      const value = parseDependencyReport({ ...evidence,
        obligation: binding.obligations[obligationIndex as number], sourceSha: binding.head,
        turnDigest: binding.turnDigest, assignmentId: binding.assignmentId,
        sources: Array.isArray(input.sources) ? input.sources.map(s => ({ ...s, sha256: "0".repeat(64) })) : input.sources });
      for (const source of value.sources) {
        const full = join(job.worktreeStoryRoot, source.path);
        if (await realpath(full) !== full) throw Error("Unsafe dependency source.");
        const content = await readFile(full, "utf8");
        if (!content.includes(source.quote)) throw Error("Dependency quote does not match Story bytes.");
        source.sha256 = sourceDigest(content);
      }
      await receive(value);
      return { content: [{ type: "text", text: "Dependency evidence recorded. Stop now without Story edits; the controller will decide authority at a clean boundary." }], details: undefined };
    },
  };
}

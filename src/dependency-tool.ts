import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { parseDependencyReport, type DependencyReport } from "./dependency-amendments.js";
import { sourceDigest } from "./dependency-state.js";

/** Evidence only. The tool cannot approve an amendment, widen writes or restart
 * the caller. Identity and source hashes are stamped by the trusted host. */
export function createDependencyTool(job: JobStartResult, binding: {
  head: string; turnDigest: string; assignmentId: string;
}, receive: (report: DependencyReport) => void): ToolDefinition {
  return {
    name: "report_dependency", label: "Report a missing narrative prerequisite",
    description: "Report a causally necessary cross-domain prerequisite, then stop WITHOUT edits. " +
      "Use exact existing IDs, Story quotations and an exact original delivery obligation. " +
      "This is evidence only, never write authority. Protected/author decisions must be flagged.",
    parameters: { type: "object", properties: {
      obligation: { type: "string" }, missing: { type: "string" },
      affectedIds: { type: "array", items: { type: "string" }, maxItems: 12 },
      sources: { type: "array", maxItems: 8, items: { type: "object", properties: {
        path: { type: "string" }, quote: { type: "string" },
      }, required: ["path", "quote"], additionalProperties: false } },
      likelySpecialist: { type: "string" }, authorDecisionRequired: { type: "boolean" },
    }, required: ["obligation", "missing", "affectedIds", "sources", "likelySpecialist", "authorDecisionRequired"],
    additionalProperties: false } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, raw: unknown) {
      const input = raw as Record<string, unknown>;
      if (!input || Object.keys(input).sort().join(",") !==
          "affectedIds,authorDecisionRequired,likelySpecialist,missing,obligation,sources")
        throw Error("Invalid dependency report fields.");
      const value = parseDependencyReport({ ...input, sourceSha: binding.head,
        turnDigest: binding.turnDigest, assignmentId: binding.assignmentId,
        sources: Array.isArray(input.sources) ? input.sources.map(s => ({ ...s, sha256: "0".repeat(64) })) : input.sources });
      for (const source of value.sources) {
        const full = join(job.worktreeStoryRoot, source.path);
        if (await realpath(full) !== full) throw Error("Unsafe dependency source.");
        const content = await readFile(full, "utf8");
        if (!content.includes(source.quote)) throw Error("Dependency quote does not match Story bytes.");
        source.sha256 = sourceDigest(content);
      }
      receive(value);
      return { content: [{ type: "text", text: "Dependency evidence recorded. Stop now without Story edits; the controller will decide authority at a clean boundary." }], details: undefined };
    },
  };
}

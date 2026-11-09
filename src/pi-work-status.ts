import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A Pi report is a suggestion about current work, never evidence of a Git
 * commit, native validation, independent review, or author authorization. */
export type PiWorkStatus = { summary: string; proposedPaths: string[] };
type Reporter = (status: PiWorkStatus) => Promise<void>;
const currentReporter = new AsyncLocalStorage<Reporter>();

export function withPiStatusReporter<T>(reporter: Reporter, run: () => Promise<T>): Promise<T> {
  return currentReporter.run(reporter, run);
}

const pathAllowed = (path: string) => path.length <= 1024 && !path.includes("\\") &&
  !path.startsWith("/") && path.endsWith(".md") &&
  path.split("/").length >= 2 &&
  path.split("/").every(part => !!part && part !== "." && part !== ".." && !part.startsWith("."));

export function parsePiWorkStatus(input: unknown): PiWorkStatus {
  if (!input || typeof input !== "object") throw new Error("Invalid Pi work status.");
  const report = input as Record<string, unknown>;
  if (typeof report.summary !== "string" || !report.summary.trim() ||
      report.summary.length > 240 || /[\x00-\x1f\x7f]/.test(report.summary))
    throw new Error("A concise printable status of 1–240 characters is required.");
  if (report.proposedPaths !== undefined &&
      (!Array.isArray(report.proposedPaths) || report.proposedPaths.length > 12 ||
       !report.proposedPaths.every(path => typeof path === "string" && pathAllowed(path))))
    throw new Error("Status paths must be bounded canonical Story-relative Markdown paths.");
  return { summary: report.summary.trim(), proposedPaths: [...new Set(
    (report.proposedPaths ?? []) as string[])],
  };
}

/** Model-visible tool. The trusted Studio runner installs the reporter through
 * async context; CLI sessions without that channel cannot fabricate Studio events. */
export function createPiStatusTool(): ToolDefinition {
  return {
    name: "report_status",
    label: "Report concise working status",
    description: "Briefly describe your current work. Optional canonical Story-relative paths " +
      "are only your proposed focus, not verified edits. This does not assert validation or review.",
    parameters: {
      type: "object", properties: {
        summary: { type: "string", maxLength: 240 },
        proposedPaths: { type: "array", maxItems: 12, items: { type: "string" } },
      }, required: ["summary"], additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, input: unknown) {
      const status = parsePiWorkStatus(input);
      const report = currentReporter.getStore();
      if (report) await report(status);
      return { content: [{ type: "text" as const,
        text: report ? "Working status shared. It is not verified Story evidence." :
          "No live Studio status channel is attached." }], details: undefined };
    },
  };
}

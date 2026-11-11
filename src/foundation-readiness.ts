import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JobStartResult } from "./job.js";

type Readiness = {
  status: string;
  report?: {
    readiness?: { design?: { stages?: { foundation?: { minimum?: string } } } };
    protection?: { status?: string; changes?: unknown[]; warnings?: unknown[] };
    records?: Array<{ path?: string; metadata?: { type?: string; status?: string } }>;
  } | null;
};

/** Reuse only native-verified, clean, protected Creative Direction; a schema-
 * valid but unreviewed initialization placeholder is not an author baseline. */
export async function reusableExistingFoundation(job: Pick<JobStartResult, "worktreeStoryRoot">,
  result: Readiness): Promise<boolean> {
  const report = result.report;
  const protection = report?.protection;
  if (result.status !== "passed" ||
      report?.readiness?.design?.stages?.foundation?.minimum !== "passed" ||
      protection?.status !== "checked" || !Array.isArray(protection.changes) ||
      protection.changes.length !== 0 || !Array.isArray(protection.warnings) ||
      protection.warnings.length !== 0)
    return false;
  const records = (report.records ?? []).filter(r =>
    r.metadata?.type === "creative-direction" && r.metadata.status !== "superseded");
  if (records.length !== 1 || !/^creative-direction\/[A-Za-z0-9._-]+\.md$/.test(records[0]!.path ?? ""))
    return false;
  const path = resolve(job.worktreeStoryRoot, records[0]!.path!);
  if (path !== join(job.worktreeStoryRoot, records[0]!.path!)) return false;
  try {
    if (await realpath(path) !== path) return false;
    const content = await readFile(path, "utf8");
    return !content.includes("Pending author discovery");
  } catch { return false; }
}

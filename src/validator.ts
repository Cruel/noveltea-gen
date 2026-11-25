import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { CanonicalScopeRecord } from "./focused-scope.js";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { nativeValidate } from "./native-validator.js";
import { activeStoryWriter, isStorySpecialistLease } from "./job-lock.js";
import { captureStorySnapshot } from "./story-debug-snapshot.js";
import { assertNativeVersion, nativeVersion } from "./native-cli-version.js";
import type { JobStartResult } from "./job.js";

export { nativeExecutable } from "./native-cli-version.js";

const CONTRACT = "noveltea-validator/v1" as const;

/** Job-compatible native CLI version. The deployment guarantees that the CLI
 * binary is fixed during a worker's lifetime. No executable digest is pinned. */
export interface NativeValidatorPin {
  contract: typeof CONTRACT;
  implementation: "native-cli";
  version: string;
}

export interface ValidationResult {
  contract: typeof CONTRACT;
  status: "passed" | "rejected" | "unverified" | "error";
  exitCode: 0 | 1 | 2;
  jobId: string;
  baseSha: string;
  worktreeStoryRoot: string;
  validator: NativeValidatorPin;
  report?: Record<string, unknown>;
  error?: string;
}

export interface ValidationView {
  worktreeRoot: string;
  worktreeStoryRoot: string;
  baseSha: string;
}

export function createStoryValidateTool(job: JobStartResult): ToolDefinition {
  return {
    name: "story_validate",
    label: "Validate Story with the trusted Git baseline",
    description: "Run the canonical native NovelTea Story validator, readiness and protected-decision checks " +
      "against this job's verified Story root and trusted Git base. No approval is granted.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute() {
      const result = await validateStoryJob(job);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  };
}

/** Forks verify the checkpoint's original version and select the installed CLI
 * for the child. They never transfer approvals or other source authorization. */
export async function verifyForkValidator(job: JobStartResult, checkpointVersion: string): Promise<NativeValidatorPin> {
  if (checkpointVersion !== job.validatorVersion)
    throw new Error("Checkpoint validator version does not match the source job.");
  return { contract: CONTRACT, implementation: "native-cli", version: nativeVersion() };
}

/** The manifest is the sole durable native-validator version identity. */
async function nativePin(job: JobStartResult): Promise<NativeValidatorPin> {
  const manifest = JSON.parse(await readFile(join(job.stateDir, "job.json"), "utf8")) as Record<string, unknown>;
  if (["jobId", "branch", "threadId", "baseSha", "worktreeRoot", "storyRoot", "gitRoot"]
    .some(key => manifest[key] !== job[key as keyof JobStartResult]) ||
    manifest.validatorVersion !== job.validatorVersion)
    throw new Error("Saved Story job identity or CLI version changed; refusing validator reuse.");
  assertNativeVersion(job.validatorVersion);
  return { contract: CONTRACT, implementation: "native-cli", version: job.validatorVersion };
}

/** The public adapter is shared by Studio, the agent worker and the developer
 * CLI. Validation invokes only the native CLI; no bundle pin or source checkout
 * is needed. sourceCheckout is a deprecated, ignored compatibility argument. */
export async function validateStoryJob(job: JobStartResult, _sourceCheckout?: string,
  view?: ValidationView): Promise<ValidationResult> {
  const writer = activeStoryWriter();
  const mayCapture = writer?.active && isStorySpecialistLease(writer.workItem) &&
    writer.job.jobId === job.jobId &&
    writer.job.worktreeRoot === job.worktreeRoot &&
    (!view || view.worktreeRoot === job.worktreeRoot &&
      view.worktreeStoryRoot === job.worktreeStoryRoot);
  const snapshot = (phase: "validation-attempt" | "validation-failed") => {
    if (!mayCapture) return;
    try {
      captureStorySnapshot(job, phase, writer!.workItem);
    } catch (error) {
      console.warn("[Story diagnostic snapshot]", phase,
        error instanceof Error ? error.message : String(error));
    }
  };
  snapshot("validation-attempt");
  const pin = await nativePin(job);
  const result = nativeValidate(view ? { ...job, ...view } : job, pin);
  if (result.status !== "passed") snapshot("validation-failed");
  return result;
}

/** Native identity on the exact sealed revision, not a YAML spelling
 * heuristic or a record read from a potentially dirty/current draft. */
export async function historicalCanonicalCatalog(job: JobStartResult, head: string): Promise<CanonicalScopeRecord[]> {
  if (!/^[a-f0-9]{40}$/.test(head)) throw Error("Invalid historical catalog source.");
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
  git("merge-base", "--is-ancestor", head, "HEAD");
  const pin = await nativePin(job);
  const read = (root: string) => {
    const result = nativeValidate({ ...job, worktreeRoot: root,
      worktreeStoryRoot: join(root, job.storyRelativePath), baseSha: head }, pin);
    const report = result.report as { records?: CanonicalScopeRecord[]; diagnostics?: unknown[];
      protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
    if (result.status !== "passed" || !Array.isArray(report?.records) ||
        report.diagnostics?.length || report.protection?.status !== "checked" ||
        report.protection.base !== head || report.protection.changes?.length || report.protection.warnings?.length)
      throw Error("Historical prerequisite requires exact native canonical/protection verification.");
    return report.records;
  };
  if (git("rev-parse", "HEAD") === head && !git("status", "--porcelain=v1", "--untracked-files=all"))
    return read(job.worktreeRoot);
  const scratch = await mkdtemp(join(tmpdir(), "nt-historical-catalog-"));
  const root = join(scratch, "source");
  let added = false;
  try {
    git("-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", root, head);
    added = true;
    return await read(root);
  } finally {
    try { if (added) git("worktree", "remove", "--force", root); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}

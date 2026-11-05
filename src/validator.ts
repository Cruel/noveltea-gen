import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { nativeValidate } from "./native-validator.js";
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
  const pin = await nativePin(job);
  return nativeValidate(view ? { ...job, ...view } : job, pin);
}

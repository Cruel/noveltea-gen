/** Offline native-CLI replay from an exact, self-contained historical Git bundle.
 * No model, provider, worker or caller worktree is touched. The temp checkout
 * reproduces Git object IDs; only absolute temp paths are normalized.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { nativeValidate } from "./native-validator.js";
import { assertNativeVersion } from "./native-cli-version.js";

export interface NativeReplayInput {
  kind: "native-validation";
  /** Complete saved Git bundle containing the original base and target commits. */
  bundleBase64: string;
  bundleSha256: string;
  baseSha: string;
  checkpointSha: string;
  storyRelativePath: string;
  validatorVersion: string;
}
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex");
const cleanEnv = () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return env;
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}
function validPath(path: string) {
  return (
    path === "" ||
    path
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== "." && part !== "..")
  );
}
export function replayNativeValidation(input: NativeReplayInput) {
  if (
    !SHA.test(input.baseSha) ||
    !SHA.test(input.checkpointSha) ||
    !validPath(input.storyRelativePath) ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(input.validatorVersion) ||
    typeof input.bundleBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.bundleBase64) ||
    !HASH.test(input.bundleSha256)
  )
    throw Error("Invalid self-contained native validation replay input.");
  const bundle = Buffer.from(input.bundleBase64, "base64");
  if (bundle.length === 0 || bundle.length > 6 * 1024 * 1024 || sha(bundle) !== input.bundleSha256)
    throw Error("Native replay bundle is corrupt or exceeds size limits.");
  assertNativeVersion(input.validatorVersion);
  const temp = mkdtempSync(join(tmpdir(), "nt-native-replay-"));
  try {
    const archive = join(temp, "source.bundle"),
      checkout = join(temp, "checkout");
    writeFileSync(archive, bundle, { flag: "wx", mode: 0o600 });
    git(temp, "clone", "--quiet", "--no-checkout", "--", archive, checkout);
    git(checkout, "checkout", "--quiet", "--detach", input.checkpointSha);
    if (
      git(checkout, "rev-parse", "HEAD") !== input.checkpointSha ||
      git(checkout, "cat-file", "-t", input.baseSha) !== "commit"
    )
      throw Error("Native replay lost exact original Git object identity.");
    const storyRoot = join(checkout, input.storyRelativePath);
    const result = nativeValidate(
      {
        jobId: "offline-replay",
        baseSha: input.baseSha,
        worktreeRoot: checkout,
        worktreeStoryRoot: storyRoot,
      } as JobStartResult,
      {
        implementation: "native-cli",
        contract: "noveltea-validator/v1",
        version: input.validatorVersion,
      },
    );
    // The native report contains paths under this fresh temporary checkout.
    // Normalize ONLY those prefixes; retain all other report bytes, diagnostic
    // lines and source paths to detect validator regressions.
    const stable = JSON.stringify(result.report ?? null)
      .split(checkout)
      .join("<REPLAY_CHECKOUT>");
    return {
      status: result.status,
      exitCode: result.exitCode,
      error: result.error ?? null,
      reportSha256: sha(stable),
      diagnostics: (result.report?.diagnostics as unknown[])?.length ?? null,
      protectionStatus: (result.report?.protection as { status?: string } | undefined)?.status ?? null,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function captureNativeReplayInput(job: JobStartResult, checkpointSha: string): NativeReplayInput {
  if (!SHA.test(checkpointSha) || !validPath(job.storyRelativePath))
    throw Error("Native replay needs an exact committed checkpoint and safe Story subdirectory.");
  // Commit must be reachable on this Job's verified history; no new branch,
  // checkout or mutation is allowed in the original source repository.
  git(job.worktreeRoot, "merge-base", "--is-ancestor", checkpointSha, "HEAD");
  git(job.worktreeRoot, "cat-file", "-t", job.baseSha);
  const temp = mkdtempSync(join(tmpdir(), "nt-native-bundle-"));
  try {
    const archive = join(temp, "source.bundle");
    git(job.worktreeRoot, "bundle", "create", archive, "HEAD");
    const bundle = readFileSync(archive);
    if (bundle.length > 6 * 1024 * 1024)
      throw Error("Historical native replay Git bundle exceeds the bounded fixture size.");
    return {
      kind: "native-validation",
      bundleBase64: bundle.toString("base64"),
      bundleSha256: sha(bundle),
      baseSha: job.baseSha,
      checkpointSha,
      storyRelativePath: job.storyRelativePath,
      validatorVersion: job.validatorVersion,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

import { spawnSync } from "node:child_process";
import type { JobStartResult } from "./job.js";
import type { ValidationResult, NativeValidatorPin } from "./validator.js";
import { nativeExecutable } from "./native-cli-version.js";

type ObjectValue = Record<string, any>;
const gitVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];
function invoke(executable: string, job: JobStartResult, command: string[]): {
  exit: number; result: ObjectValue;
} {
  const env = { ...process.env };
  for (const name of gitVars) delete env[name];
  const run = spawnSync(executable, ["--json", "narrative", ...command], {
    cwd: job.worktreeRoot, env, encoding: "utf8",
    timeout: 120_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error || run.signal || ![0, 1].includes(run.status ?? -1))
    throw new Error("Native narrative " + command[0] + " failed: " +
      (run.error?.message ?? run.stderr?.trim() ?? "invalid exit code"));
  let value: ObjectValue;
  try { value = JSON.parse(run.stdout) as ObjectValue; }
  catch { throw new Error("Native narrative " + command[0] + " returned non-JSON output."); }
  if (!value || typeof value !== "object" || value.protocolVersion !== 1 ||
      value.exitCode !== run.status || value.success !== (run.status === 0) ||
      !Array.isArray(value.diagnostics))
    throw new Error("Native narrative " + command[0] + " returned an inconsistent CLI protocol envelope.");
  return { exit: run.status!, result: value };
}
export function nativeValidate(job: JobStartResult, pin: NativeValidatorPin): ValidationResult {
  const envelope = { contract: "noveltea-validator/v1" as const,
    jobId: job.jobId, baseSha: job.baseSha, worktreeStoryRoot: job.worktreeStoryRoot,
    validator: pin };
  try {
    const { exit, result: response } = invoke(nativeExecutable(), job,
      ["validate", job.worktreeStoryRoot, "--base", job.baseSha]);
    const catalog = response.catalog as ObjectValue | undefined;
    if (!catalog || !Array.isArray(catalog.records) ||
        !Array.isArray(catalog.diagnostics) || !catalog.coverage ||
        !catalog.authorization || !catalog.protection)
      throw new Error("Native narrative validation returned an incomplete catalog.");
    const rawProtection = catalog.protection as ObjectValue;
    if (rawProtection.status === "checked" && (rawProtection.base !== job.baseSha ||
        rawProtection.authorizationVerified !== false ||
        typeof rawProtection.complete !== "boolean" ||
        !Array.isArray(rawProtection.findings) ||
        !Array.isArray(rawProtection.impact?.changed) ||
        !Array.isArray(rawProtection.impact?.moved) ||
        !Array.isArray(rawProtection.impact?.affected)))
      throw new Error("Native validator omitted trusted Git protection, authorization or impact evidence.");
    const findings: ObjectValue[] = Array.isArray(rawProtection.findings) ? rawProtection.findings : [];
    const changes = findings.map(f => ({
      decision: f.decisionId, kind: f.category, acknowledged: false,
      path: f.afterLocation?.path ?? f.beforeLocation?.path,
      previousPath: f.beforeLocation?.path ?? f.afterLocation?.path,
      before: f.before, ...(f.after === undefined ? {} : { after: f.after }),
      ...f,
    }));
    const warnings = findings.map(f => ({
      code: f.code, decision: f.decisionId, kind: f.category, path: f.afterLocation?.path ?? f.beforeLocation?.path,
      message: f.message ?? "Protected Story decision requires independent author authorization.",
    }));
    // Native readiness is an independent public command; obtain it without
    // computing Story rules or reconstructing relationships in the generator.
    const ready = invoke(nativeExecutable(), job,
      ["readiness", job.worktreeStoryRoot, "--stage", "review", "--view", "design"]).result;
    if (!ready.readiness || ready.readiness.contractRevision !== catalog.contractRevision ||
        !ready.readiness.design?.stages || !ready.readiness.approved?.stages ||
        !Array.isArray(ready.readiness.outstanding))
      throw new Error("Native narrative readiness returned an incomplete report.");
    const report = {
      ...catalog, readiness: ready.readiness, outstanding: ready.readiness.outstanding,
      protection: { ...rawProtection, changes, warnings,
        impact: rawProtection.impact ?? { changed: [], moved: [], affected: [] } },
    };
    const protectedChecked = rawProtection.status === "checked" &&
      rawProtection.base === job.baseSha && rawProtection.complete === true;
    if (!protectedChecked) return { ...envelope, status: catalog.diagnostics.length ? "rejected" : "unverified",
      exitCode: catalog.diagnostics.length ? 1 : 2, report };
    if (exit === 0 && (changes.length || catalog.diagnostics.length))
      throw new Error("Native validator reported success despite structural or protected-decision failures.");
    return { ...envelope, status: exit === 0 ? "passed" : "rejected",
      exitCode: exit as 0 | 1, report };
  } catch (error) {
    return { ...envelope, status: "error", exitCode: 2,
      error: error instanceof Error ? error.message : String(error) };
  }
}

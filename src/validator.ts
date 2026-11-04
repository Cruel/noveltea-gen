import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { nativeValidate } from "./native-validator.js";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { canonicalDestination, type JobStartResult } from "./job.js";

const CONTRACT = "noveltea-validator/v1";
const ENTRY = "catalog-cli.mjs";
const RECEIPT = "validator.json";

interface ValidatorPin {
  contract: typeof CONTRACT;
  implementation: "canonical-typescript-bundle";
  sha256: string;
  sourceSha256: string;
  sourceCommit: string;
  sourceDirty: boolean;
  sourceCheckout: string;
}

export interface NativeValidatorPin {
  contract: typeof CONTRACT;
  implementation: "native-cli";
  sha256: string;
  executable: string;
}

export interface ValidationResult {
  contract: typeof CONTRACT;
  status: "passed" | "rejected" | "unverified" | "error";
  exitCode: 0 | 1 | 2;
  jobId: string;
  baseSha: string;
  worktreeStoryRoot: string;
  validator: ValidatorPin | NativeValidatorPin;
  report?: Record<string, unknown>;
  error?: string;
}

/** Historical adapter for jobs previously pinned to the experimental catalog.
 * New jobs use the native CLI without compiling a second Story validator. */
export interface StoryValidatorAdapter {
  validate(job: JobStartResult, pin: ValidatorPin): Promise<ValidationResult>;
}

function sha(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
function cacheRoot() {
  return resolve(process.env.NT_VALIDATOR_CACHE_DIR ?? join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "noveltea-gen", "validator-artifacts",
  ));
}
function pinPath(job: JobStartResult) {
  return join(job.stateDir, RECEIPT);
}
function artifactDir(pin: ValidatorPin) {
  return join(cacheRoot(), pin.sha256);
}
function git(source: string, ...args: string[]) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function sourceFingerprint(source: string): Promise<string> {
  const files: Array<[string, string]> = [];
  async function walk(dir: string, prefix: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const name = prefix + entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Validator source contains a symlink: " + name);
      if (info.isDirectory()) await walk(path, name + "/");
      else if (info.isFile()) files.push([name, sha(await readFile(path))]);
      else throw new Error("Unsupported validator source entry: " + name);
    }
  }
  await walk(join(source, "src"), "src/");
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    files.push([name, sha(await readFile(join(source, name)))]);
  }
  return sha(JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0]))));
}

function checkPin(value: unknown): asserts value is ValidatorPin {
  if (!value || typeof value !== "object") throw new Error("Malformed pinned validator metadata");
  const pin = value as Record<string, unknown>;
  if (pin.contract !== CONTRACT || pin.implementation !== "canonical-typescript-bundle" ||
      !["sha256", "sourceSha256"].every(field =>
        typeof pin[field] === "string" && /^[a-f0-9]{64}$/.test(pin[field] as string)) ||
      typeof pin.sourceCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(pin.sourceCommit) ||
      typeof pin.sourceDirty !== "boolean" || typeof pin.sourceCheckout !== "string" ||
      !pin.sourceCheckout || !isAbsolute(pin.sourceCheckout)) {
    throw new Error("Malformed pinned validator metadata");
  }
}

async function verifyArtifact(pin: ValidatorPin): Promise<string> {
  const root = artifactDir(pin);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe artifact directory");
    if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([ENTRY])) {
      throw new Error("unexpected artifact files");
    }
    const binary = join(root, ENTRY);
    for (const file of [binary]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe artifact file");
    }
    if (sha(await readFile(binary)) !== pin.sha256) {
      throw new Error("artifact contents differ from the recorded pin");
    }
    return binary;
  } catch {
    throw new Error(`Pinned validator ${pin.sha256} is missing or corrupt. Restore the original artifact; the live skills checkout is never used as a fallback.`);
  }
}

async function publishValidator(sourceCheckout: string): Promise<ValidatorPin> {
  let source: string;
  try {
    source = await realpath(sourceCheckout);
    if (!(await stat(join(source, "src/cli.ts"))).isFile()) throw new Error("missing src/cli.ts");
    if (JSON.parse(await readFile(join(source, "package.json"), "utf8")).name !== "noveltea-story-catalog") {
      throw new Error("not the NovelTea canonical catalog checkout");
    }
    if (await realpath(git(source, "rev-parse", "--show-toplevel")) !== source) {
      throw new Error("source path is not the Git checkout root");
    }
  } catch {
    throw new Error("Validator source must be the existing noveltea-skills Git checkout with src/cli.ts and package.json.");
  }
  const before = await sourceFingerprint(source);
  const sourceCommit = git(source, "rev-parse", "HEAD");
  const sourceDirty = Boolean(git(source, "status", "--porcelain", "--untracked-files=all"));
  const scratch = await mkdtemp(join(tmpdir(), "noveltea-validator-build-"));
  try {
    const output = join(scratch, ENTRY);
    // Bundle dependencies into one executable. No npm install, network access
    // or compiled files are needed in a resumed job's original checkout.
    await build({
      entryPoints: [join(source, "src/cli.ts")],
      outfile: output, bundle: true, platform: "node", format: "esm",
      target: "node22", logLevel: "silent",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    if (await sourceFingerprint(source) !== before ||
        git(source, "rev-parse", "HEAD") !== sourceCommit) {
      throw new Error("Validator source changed while bundling; retry against a stable checkout.");
    }
    const pin: ValidatorPin = {
      contract: CONTRACT, implementation: "canonical-typescript-bundle",
      sha256: sha(await readFile(output)), sourceSha256: before,
      sourceCommit, sourceDirty, sourceCheckout: source,
    };
    const cache = cacheRoot();
    await mkdir(cache, { recursive: true });
    const dest = artifactDir(pin);
    if (existsSync(dest)) {
      await verifyArtifact(pin);
    } else {
      const stage = await mkdtemp(join(cache, ".staging-"));
      try {
        await writeFile(join(stage, ENTRY), await readFile(output), { flag: "wx", mode: 0o444 });
        await chmod(join(stage, ENTRY), 0o444);
        await chmod(stage, 0o555);
        try { await rename(stage, dest); }
        catch (error) {
          if (!existsSync(dest)) throw error;
          await verifyArtifact(pin);
        }
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
    return pin;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The first validation pins the executable to the job; subsequent calls
 * verify the exact persisted artifact and work without source checkout. */
async function pinValidator(job: JobStartResult, sourceCheckout?: string): Promise<ValidatorPin> {
  const saved = pinPath(job);
  // A Pi tool may call the public validator CLI in a subprocess. That process
  // publishes the first pin while this writer still holds its earlier job
  // snapshot. Re-read the durable manifest, but require the original identity
  // and any previously observed pin to remain unchanged.
  const jobFile = join(job.stateDir, "job.json");
  const manifest = JSON.parse(await readFile(jobFile, "utf8")) as Record<string, unknown>;
  if (["jobId", "branch", "threadId", "baseSha", "worktreeRoot", "storyRoot", "gitRoot"]
    .some(key => manifest[key] !== job[key as keyof JobStartResult]) ||
    (job.validatorSha256 !== undefined && job.validatorSha256 !== manifest.validatorSha256)) {
    throw new Error("Job identity or previously observed validator pin changed; inspect the durable manifest.");
  }
  if (manifest.validatorSha256 && !existsSync(saved)) {
    throw new Error("Job validator pin is missing. Restore its original validator.json; never repin from current source.");
  }
  if (existsSync(saved)) {
    let parsed: unknown;
    try {
      const info = await lstat(saved);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe pin file");
      parsed = JSON.parse(await readFile(saved, "utf8"));
      checkPin(parsed);
    }
    catch { throw new Error("Job validator pin is unreadable or corrupt. Restore validator.json before retrying."); }
    if (parsed.sha256 !== manifest.validatorSha256) {
      throw new Error("Job validator pin does not match its durable job manifest. Restore the original pin.");
    }
    await verifyArtifact(parsed);
    return parsed;
  }
  if (!sourceCheckout) {
    throw new Error("No validator is pinned to this job. Supply --validator-source <noveltea-skills checkout> or configure .local/config.json novelteaSkills for the first validation.");
  }
  const lock = join(job.stateDir, ".validator-pinning");
  try { await mkdir(lock); }
  catch {
    throw new Error("Validator pinning is already in progress or interrupted. Inspect the job state before retrying.");
  }
  try {
    const pin = await publishValidator(sourceCheckout);
    // Record the pin hash in the durable job manifest *before* publishing the
    // receipt. An interruption is detected as missing original pin metadata.
    const jobFile = join(job.stateDir, "job.json");
    const current = JSON.parse(await readFile(jobFile, "utf8")) as Record<string, unknown>;
    if (current.jobId !== job.jobId || current.branch !== job.branch ||
        current.validatorSha256 !== undefined) {
      throw new Error("Job manifest changed during validator pinning. Inspect the job state before retrying.");
    }
    const temporary = join(job.stateDir, `job.validator.${process.pid}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ ...current, validatorSha256: pin.sha256 }, null, 2) + "\n",
        { flag: "wx", mode: 0o600 });
      await rename(temporary, jobFile);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await writeFile(saved, JSON.stringify(pin, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return pin;
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/** Unmodified canonical CLI JSON is forwarded, preserving source paths,
 * diagnostics, scoped readiness, unverified findings and Git impact evidence. */
export const bundledValidatorAdapter: StoryValidatorAdapter = {
  async validate(job, pin) {
    const binary = await verifyArtifact(pin);
    const args = [binary, job.worktreeStoryRoot, "--base", job.baseSha, "--strict-protection"];
    const env = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
      delete env[name];
    }
    const run = (argv: string[]) => spawnSync(process.execPath, argv, {
      cwd: job.worktreeRoot, encoding: "utf8", timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024, env,
    });
    let result = run(args);
    // The canonical CLI can exit 1 or 2 for the strict-protection no-baseline
    // condition depending on its version. This exact stderr is the only
    // authorized retry; do not suppress ordinary structural failures.
    const missingBaseline = (result.status === 1 || result.status === 2) &&
      !result.stdout.trim() && /Git baseline does not contain Story Markdown files/.test(result.stderr);
    // This catalog implementation also treats an explicit --base as a strict
    // requirement for baseline Markdown. Run structural-only validation with
    // neither --base nor --strict-protection, and mark protection unverified.
    if (missingBaseline) result = run([binary, job.worktreeStoryRoot]);
    const envelope: Omit<ValidationResult, "status" | "exitCode"> = {
      contract: CONTRACT, jobId: job.jobId, baseSha: job.baseSha,
      worktreeStoryRoot: job.worktreeStoryRoot, validator: pin,
    };
    if (result.error || result.signal || (result.status !== 0 && result.status !== 1) ||
        !result.stdout.trim()) {
      return { ...envelope, status: "error", exitCode: 2,
        error: result.error?.message || result.stderr.trim() || "Validator failed without a report." };
    }
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(result.stdout) as Record<string, unknown>;
      if (!report || !Array.isArray(report.diagnostics) || !report.readiness ||
          !report.coverage || !report.protection || typeof report.protection !== "object") {
        throw new Error("Validator returned an unexpected report.");
      }
    } catch {
      return { ...envelope, status: "error", exitCode: 2, error: "Validator output is not a supported JSON report." };
    }
    const protection = report.protection as { status?: string; base?: string };
    if (missingBaseline) {
      // If a commit was published before the job receipt was saved, structural
      // fallback may check against moving HEAD. That is NOT the trusted base;
      // never report it as a successful protected-decision comparison.
      return { ...envelope, status: "unverified", exitCode: 2, report };
    }
    if (protection.status === "checked" && protection.base !== job.baseSha) {
      return { ...envelope, status: "error", exitCode: 2,
        error: "Validator reported a Git baseline different from the job\u0027s verified base SHA.", report };
    }
    if (protection.status !== "checked") {
      return { ...envelope, status: "unverified", exitCode: 2, report };
    }
    return { ...envelope, status: result.status === 0 ? "passed" : "rejected",
      exitCode: result.status as 0 | 1, report };
  },
};

/** A bounded revision can be assessed in a disposable Git worktree without
 * exposing unrelated uncommitted author or specialist edits to the validator.
 * The pin still belongs to the original job; only the comparison target and
 * explicit baseline are substituted after the caller verifies the worktree. */
export interface ValidationView {
  worktreeRoot: string;
  worktreeStoryRoot: string;
  baseSha: string;
}

/** A Pi tool binds validation to the verified job identity, never to the
 * model's chosen --base argument or the current Git HEAD. */
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

export function nativeExecutable(): string {
  const selected = process.env.NT_NATIVE_CLI;
  const name = process.platform === "win32" ? "noveltea.exe" : "noveltea";
  if (selected) {
    if (!isAbsolute(selected)) throw new Error("NT_NATIVE_CLI must be an absolute executable path.");
    return selected;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The native 'noveltea' executable is required for Story validation (set NT_NATIVE_CLI or PATH).");
}
async function verifyNativePin(pin: NativeValidatorPin): Promise<void> {
  if (pin.contract !== CONTRACT || pin.implementation !== "native-cli" ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) || !isAbsolute(pin.executable) ||
      !(await stat(pin.executable)).isFile() ||
      sha(await readFile(pin.executable)) !== pin.sha256) {
    throw new Error("Pinned native NovelTea validator is missing or changed; restore the exact executable, never silently switch validators.");
  }
}
/** Read-only compatibility gate for checkpoint forks, including the selected
 * current toolchain. Never validate or repin an actively edited parent tree. */
export async function verifyForkValidator(job: JobStartResult): Promise<void> {
  const pin = JSON.parse(await readFile(pinPath(job), "utf8")) as NativeValidatorPin;
  await verifyNativePin(pin);
  if (pin.sha256 !== job.validatorSha256 || sha(await readFile(nativeExecutable())) !== pin.sha256)
    throw new Error("Checkpoint validator is incompatible with the current native executable.");
  if (process.env.NT_VALIDATOR_TEST_LEGACY === "1")
    throw new Error("Checkpoint forks require native validation, not the legacy test adapter.");
}
async function nativePin(job: JobStartResult): Promise<NativeValidatorPin> {
  const jobRoot = job.stateDir;
  const jobFile = join(jobRoot, "job.json");
  const saved = pinPath(job);
  const manifest = JSON.parse(await readFile(jobFile, "utf8")) as Record<string, unknown>;
  if (["jobId", "branch", "threadId", "baseSha", "worktreeRoot", "storyRoot", "gitRoot"]
    .some(k => manifest[k] !== job[k as keyof JobStartResult]) ||
    (job.validatorSha256 !== undefined && job.validatorSha256 !== manifest.validatorSha256)) {
    throw new Error("Saved Story job identity changed; refusing validator reuse.");
  }
  if (existsSync(saved)) {
    const pin = JSON.parse(await readFile(saved, "utf8")) as NativeValidatorPin;
    if (pin.sha256 !== manifest.validatorSha256) throw new Error("Job validator pin differs from durable manifest.");
    await verifyNativePin(pin);
    return pin;
  }
  if (manifest.validatorSha256) throw new Error("Job validator receipt is missing; never repin.");
  const lock = join(jobRoot, ".validator-pinning");
  try { await mkdir(lock); }
  catch { throw new Error("Validator pinning already in progress or interrupted."); }
  try {
    const executable = await realpath(nativeExecutable());
    const pin: NativeValidatorPin = { contract: CONTRACT, implementation: "native-cli",
      sha256: sha(await readFile(executable)), executable };
    await verifyNativePin(pin);
    const current = JSON.parse(await readFile(jobFile, "utf8")) as Record<string, unknown>;
    if (current.jobId !== job.jobId || current.branch !== job.branch ||
        current.validatorSha256 !== undefined)
      throw new Error("Job manifest changed during native validator pinning.");
    const temp = join(jobRoot, `job.validator.${process.pid}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ ...current, validatorSha256: pin.sha256 }, null, 2) + "\n",
        { flag: "wx", mode: 0o600 });
      await rename(temp, jobFile);
    } finally { await unlink(temp).catch(() => {}); }
    await writeFile(saved, JSON.stringify(pin, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return pin;
  } finally { await rmdir(lock).catch(() => {}); }
}

export async function validateStoryJob(job: JobStartResult, sourceCheckout?: string,
  view?: ValidationView): Promise<ValidationResult> {
  const saved = pinPath(job);
  // Historical jobs must keep their original experimental validator and digest.
  // Only the test-only fixture flag can create an *additional* legacy pin.
  let previous: { implementation?: string } | undefined;
  if (existsSync(saved)) {
    try { previous = JSON.parse(await readFile(saved, "utf8")) as { implementation?: string }; }
    catch { throw new Error("Job validator pin is unreadable or corrupt. Restore the original receipt."); }
  }
  if (previous?.implementation === "canonical-typescript-bundle" ||
      (!previous && process.env.NT_VALIDATOR_TEST_LEGACY === "1")) {
    const cache = await canonicalDestination(cacheRoot());
    const within = (root: string) => {
      const rel = relative(root, cache);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (within(job.gitRoot) || within(job.worktreeRoot)) {
      throw new Error("NT_VALIDATOR_CACHE_DIR must resolve outside both the author repository and job worktree.");
    }
    const pin = await pinValidator(job, sourceCheckout);
    return bundledValidatorAdapter.validate(view ? { ...job, ...view } : job, pin);
  }
  if (previous && previous.implementation !== "native-cli")
    throw new Error("Job validator receipt has an unknown implementation; no automatic migration.");
  const pin = await nativePin(job);
  return nativeValidate(view ? { ...job, ...view } : job, pin);
}

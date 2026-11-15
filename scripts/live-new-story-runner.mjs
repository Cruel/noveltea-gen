/**
 * Run long, opt-in Studio real-Pi certification beyond a shell command's
 * execution ceiling. All state and full logs remain private under .local.
 *
 * node scripts/live-new-story-runner.mjs start autonomous
 * node scripts/live-new-story-runner.mjs status autonomous
 * node scripts/live-new-story-runner.mjs start collaborative
 *
 * Never store/copy access or refresh tokens here. The existing Studio
 * certification harness supplies its own credential isolation and cleanup.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "..");
const directory = join(cwd, ".local", "certification", "live-new-story");
const nativeCli = join(process.env.HOME ?? "/home/thomas", "dev/nt/build/cli/linux/noveltea");
const skills = join(process.env.HOME ?? "/home/thomas", "dev/noveltea-skills");
const [action, mode, checkpointSha, sourceJobId, guidance = ""] = process.argv.slice(2);
if (
  !["autonomous", "collaborative"].includes(mode ?? "") ||
  !["start", "status", "retry", "worker"].includes(action ?? "")
) {
  console.error("Usage: live-new-story-runner.mjs <start|status> <autonomous|collaborative> OR retry <mode> <checkpoint-sha> [source-job-id] [guidance]");
  process.exit(2);
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, mode + ".json");
const log = join(directory, mode + ".log");
function state() {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
function save(value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (action === "status") {
  const saved = state();
  console.log(
    JSON.stringify(saved ? { ...saved, alive: alive(saved.pid), log } : { status: "not-started", log }),
  );
  process.exit(0);
}
if (action === "start" || action === "retry") {
  const previous = state();
  if (previous && previous.status === "running" && alive(previous.pid))
    throw Error("Existing " + mode + " certification is already running: " + previous.pid);
  if (!existsSync(nativeCli) || !existsSync(join(skills, "skills/nt-story-orchestrate/SKILL.md")))
    throw Error("Missing native CLI or portable skills.");
  let root;
  if (action === "start") {
    const runs = join(directory, "runs");
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(runs, mode + "-"));
  } else {
    if (!/^[a-f0-9]{40}$/.test(checkpointSha ?? ""))
      throw Error("Retry requires the exact 40-character verified checkpoint SHA.");
    if (sourceJobId && !/^[a-f0-9-]{36}$/.test(sourceJobId))
      throw Error("Optional source job ID must be a UUID.");
    if (guidance.length > 2000) throw Error("Corrective guidance exceeds 2000 characters.");
    root = previous?.root;
    if (!root || !root.startsWith(join(directory, "runs") + "/") ||
        !existsSync(join(root, "certification-source.json")))
      throw Error("No preserved certification root for this mode. Start a new source run first.");
  }
  const output = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [resolve(import.meta.filename), "worker", mode], {
    cwd, env: process.env, detached: true, stdio: ["ignore", output, output],
  });
  closeSync(output);
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  save({ status: "running", pid: child.pid, startedAt: new Date().toISOString(), mode,
    gitHead, log, root, kind: action,
    ...(action === "retry" ? { checkpointSha, sourceJobId: sourceJobId || null, guidance } : {}) });
  child.unref();
  console.log(JSON.stringify({ status: "running", mode, pid: child.pid, root, log,
    kind: action, ...(action === "retry" ? { checkpointSha } : {}) }));
  process.exit(0);
}
// The detached worker can start before the parent has published its intent.
// Never consume a stale prior-run receipt: the process PID must match exactly.
let initial = state();
for (let attempt = 0; attempt < 100 &&
    (initial?.status !== "running" || initial.pid !== process.pid); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 20));
  initial = state();
}
if (!initial || initial.status !== "running" || initial.pid !== process.pid)
  throw Error("No matching started certification; refusing stale-run replay.");
const output = openSync(log, "a", 0o600);
const env = {
  ...process.env,
  NT_TEST_WEB_PI_NEW_STORY: "1",
  NT_TEST_WEB_PI_STORY_MODE: mode,
  ...(initial.kind === "retry" ? {
    NT_TEST_WEB_PI_RETRY_ROOT: initial.root,
    NT_TEST_WEB_PI_RETRY_CHECKPOINT: initial.checkpointSha,
    NT_TEST_WEB_PI_RETRY_SOURCE_JOB: initial.sourceJobId ?? "",
    NT_TEST_WEB_PI_RETRY_GUIDANCE: initial.guidance ?? "",
  } : { NT_TEST_WEB_PI_ROOT: initial.root }),
  NT_TEST_WEB_PI_AUTH: "device-code",
  NT_TEST_WEB_PI_LOCAL_OAUTH: "1",
  NT_TEST_WEB_PI_PROVIDER: "openai",
  NT_TEST_WEB_PI_MODEL: "gpt-6-luna",
  NT_TEST_WEB_PI_PRESERVE: "1",
  NT_TEST_WEB_PI_DIAGNOSTIC: "1",
  NT_NATIVE_CLI: nativeCli,
  NT_STUDIO_SKILLS_SOURCE: skills,
};
console.log("BEGIN " + mode + " live Luna certification on " + new Date().toISOString());
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "test/real-pi-new-story-certification.test.ts"],
  { cwd: join(cwd, "web"), env, stdio: ["ignore", output, output] },
);
const code = await new Promise((finish) => {
  child.once("error", (error) => {
    console.error(String(error));
    finish(125);
  });
  child.once("exit", (code, signal) => finish(code ?? (signal ? 128 : 1)));
});
closeSync(output);
console.log("END " + mode + " live Luna certification status=" + code);
save({
  ...initial,
  status: code === 0 ? "passed" : "failed",
  exitCode: code,
  finishedAt: new Date().toISOString(),
  log,
});
process.exitCode = code;

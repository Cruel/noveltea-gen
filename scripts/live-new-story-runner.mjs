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
import { closeSync, openSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "..");
const directory = join(cwd, ".local", "certification", "live-new-story");
const nativeCli = join(process.env.HOME ?? "/home/thomas", "dev/nt/build/cli/linux/noveltea");
const skills = join(process.env.HOME ?? "/home/thomas", "dev/noveltea-skills");
const [action, mode] = process.argv.slice(2);
if (
  !["autonomous", "collaborative"].includes(mode ?? "") ||
  !["start", "status", "worker"].includes(action ?? "")
) {
  console.error("Usage: node scripts/live-new-story-runner.mjs <start|status> <autonomous|collaborative>");
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
if (action === "start") {
  const previous = state();
  if (previous && previous.status === "running" && alive(previous.pid)) {
    throw Error("Existing " + mode + " certification is already running: " + previous.pid);
  }
  if (!existsSync(nativeCli) || !existsSync(join(skills, "skills/nt-story-orchestrate/SKILL.md")))
    throw Error("Missing native CLI or pinned portable skills.");
  const output = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [resolve(import.meta.filename), "worker", mode], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  save({ status: "running", pid: child.pid, startedAt: new Date().toISOString(), mode, gitHead, log });
  child.unref();
  console.log(JSON.stringify({ status: "running", mode, pid: child.pid, log }));
  process.exit(0);
}
const initial = state();
if (!initial || initial.status !== "running") throw Error("No matching started certification.");
const output = openSync(log, "a", 0o600);
const env = {
  ...process.env,
  NT_TEST_WEB_PI_NEW_STORY: "1",
  NT_TEST_WEB_PI_STORY_MODE: mode,
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

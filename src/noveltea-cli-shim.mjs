#!/usr/bin/env node
// Temporary agent-visible compatibility command. Delete when native
// "noveltea narrative validate" is certified; the generator owns validation.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const usage = "Usage: noveltea narrative validate STORY_ROOT [--json] [--base SHA] [--strict-protection]";
const args = process.argv.slice(2);
if ((args[0] === "narrative" || args.length === 0) &&
    (args.length === 0 || args.includes("--help") || args.includes("-h"))) {
  console.log(usage);
  process.exit(0);
}
if (args[0] !== "narrative" || args[1] !== "validate" || !args[2] || args[2].startsWith("-")) {
  console.error(usage);
  process.exit(2);
}
const story = process.env.NT_AGENT_STORY_ROOT;
const originalStory = process.env.NT_AGENT_ORIGINAL_STORY_ROOT;
const job = process.env.NT_AGENT_JOB_ID;
const base = process.env.NT_AGENT_TRUSTED_BASE;
if (!story || !originalStory || !job || !base || !/^[a-f0-9]{40}$/.test(base)) {
  console.error("Agent validator is not bound to a verified Story job.");
  process.exit(2);
}
let json = false;
const rest = args.slice(3);
try {
  if (realpathSync(args[2]) !== realpathSync(story)) throw new Error("Story root is not the active job Story.");
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") json = true;
    else if (arg === "--strict-protection") { /* Always enforced by generator. */ }
    else if (arg === "--base" && rest[i + 1] === base) i++;
    else throw new Error("Unsupported option or untrusted --base: " + arg);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const invocation = ["--import", import.meta.resolve("tsx"), cli, "job", "validate",
  "--story", originalStory, "--job", job];
if (process.env.NT_AGENT_VALIDATOR_SOURCE) {
  invocation.push("--validator-source", process.env.NT_AGENT_VALIDATOR_SOURCE);
}
const child = spawnSync(process.execPath, invocation, {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
});
let result;
try { result = JSON.parse(child.stdout); }
catch {
  console.error(child.error?.message || child.stderr?.trim() || "Validator returned no JSON report.");
  process.exit(2);
}
if (!result || result.contract !== "noveltea-validator/v1" || result.baseSha !== base ||
    result.worktreeStoryRoot !== story || !["passed", "rejected", "unverified", "error"].includes(result.status)) {
  console.error("Generator returned an invalid or mismatched validation result.");
  process.exit(2);
}
if (json) {
  console.log(JSON.stringify({ ...(result.report ?? {}), validationStatus: result.status,
    ...(result.error ? { error: result.error } : {}) }, null, 2));
} else {
  const report = result.report ?? {};
  const diagnostics = report.diagnostics ?? [];
  const warnings = report.protection?.warnings ?? [];
  console.log("Narrative validation: " + result.status + "; " +
    diagnostics.length + " diagnostic(s), " + warnings.length + " protected-decision warning(s).");
  for (const d of diagnostics) console.log("[" + d.code + "] " +
    (d.path ?? ".") + ":" + (d.line ?? 1) + ":" + (d.column ?? 1) + " " + d.message);
  for (const w of warnings) console.log("[protected-decision-change] " +
    (w.path ?? ".") + ": " + w.message);
  if (result.status === "unverified") console.log("Protection or progression unverified; this is not approval.");
  if (result.error) console.error(result.error);
  console.log("For detailed coverage, readiness, and protection evidence, rerun with --json.");
}
process.exitCode = result.status === "passed" ? 0 : result.status === "rejected" ? 1 : 2;

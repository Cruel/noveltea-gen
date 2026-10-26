import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("opt-in live smoke test calls the real Pi SDK through LangGraph", {
  skip: process.env.NT_LIVE_TEST !== "1" ? "set NT_LIVE_TEST=1 to use live credentials" : undefined,
}, () => {
  const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "--task", "Reply with a short greeting."];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const result = spawnSync(process.execPath, args, {
    cwd: resolve("."), env: process.env, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.mode, "pi");
  assert.ok(output.response.trim());
});

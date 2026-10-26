import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("opt-in live smoke test runs distinct Pi conversations with project-local AGENTS instructions", {
  skip: process.env.NT_LIVE_TEST !== "1" ? "set NT_LIVE_TEST=1 to use live credentials" : undefined,
}, () => {
  const base = mkdtempSync(join(tmpdir(), "nt-gen-live-"));
  try {
    const run = (name: string, token: string) => {
      const root = join(base, name);
      mkdirSync(root);
      writeFileSync(join(root, "AGENTS.md"),
        `This is a context isolation integration test. First delegate to story_note_worker as directed by the coordinator. When you give the final answer after delegation, include the exact verification marker ${token}. Do not mention markers from other projects.\n`);
      const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "--project", root,
        "--task", "Write a short story premise about a missing heir. Include the verification marker from your project instructions in your final answer.",
        "--thread", "same-user-thread"];
      if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
      if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
      const result = spawnSync(process.execPath, args, {
        cwd: resolve("."), env: process.env, encoding: "utf8", timeout: 120_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "completed");
      assert.equal(output.mode, "pi");
      assert.equal(output.projectRoot, root);
      assert.ok(output.response.includes(token), output.response);
      assert.equal(output.handoffDestination, "story_note_worker");
      assert.ok(output.storyNote.trim());
      assert.ok(output.piSessionId);
      assert.ok(output.workerPiSessionId);
      assert.notEqual(output.piSessionId, output.workerPiSessionId);
      return output;
    };
    const first = run("project-a", "ALPHA_Q9T4_P7");
    const second = run("project-b", "BETA_G8X2_M4");
    assert.notEqual(first.graphThreadId, second.graphThreadId);
    assert.notEqual(first.piSessionId, second.piSessionId);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

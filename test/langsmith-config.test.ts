import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadLocalLangSmithCredentials } from "../src/langsmith-config.js";
import { tracingEnabled } from "../src/tracing.js";

test("gitignored local LangSmith credentials are optional and have lower precedence than environment", t => {
  const dir = mkdtempSync(join(tmpdir(), "nt-local-tracing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "langsmith.env");
  assert.equal(loadLocalLangSmithCredentials(path), false, "missing local credentials are optional");

  writeFileSync(path, [
    "LANGSMITH_API_KEY=fixture-local-secret",
    "LANGSMITH_PROJECT=fixture-project",
    "",
  ].join("\n"), { mode: 0o600 });
  const beforeKey = process.env.LANGSMITH_API_KEY;
  const beforeProject = process.env.LANGSMITH_PROJECT;
  try {
    process.env.LANGSMITH_API_KEY = "fixture-shell-credential";
    process.env.LANGSMITH_PROJECT = "shell-project";
    assert.equal(loadLocalLangSmithCredentials(path), true);
    assert.equal(process.env.LANGSMITH_API_KEY, "fixture-shell-credential");
    assert.equal(process.env.LANGSMITH_PROJECT, "shell-project");

    // Even an intentionally empty shell override must not silently enable
    // hosted traces by falling back to an unrelated local developer key.
    process.env.LANGSMITH_API_KEY = "";
    loadLocalLangSmithCredentials(path);
    assert.equal(process.env.LANGSMITH_API_KEY, "");
    assert.throws(() => tracingEnabled(true), /LANGSMITH_API_KEY/);

    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGSMITH_PROJECT;
    loadLocalLangSmithCredentials(path);
    assert.equal(process.env.LANGSMITH_API_KEY, "fixture-local-secret");
    assert.equal(process.env.LANGSMITH_PROJECT, "fixture-project");
    assert.equal(tracingEnabled(false), false,
      "loaded credentials must not activate tracing without explicit opt-in");
  } finally {
    if (beforeKey === undefined) delete process.env.LANGSMITH_API_KEY;
    else process.env.LANGSMITH_API_KEY = beforeKey;
    if (beforeProject === undefined) delete process.env.LANGSMITH_PROJECT;
    else process.env.LANGSMITH_PROJECT = beforeProject;
  }
});

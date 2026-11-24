import { removeTestTree } from "./helpers.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { renderFoundation, hasUserProtectedDecision, type FoundationDraft } from "../src/foundation-record.js";

test("canonical Creative Direction serialization preserves authority and escapes YAML scalars", () => {
  const draft: FoundationDraft = {
    id: "dead-letter", title: 'Murder: "Evidence"\nFalse',
    premise: "A curator finds a forged will.", central_conflict: "Expose the forgery.",
    genre: "Mystery", tone: "Tense", player_experience: "Find a fair clue.",
    scope: "Short visual novel", body: "# A Dead Letter\n",
    decisions: [
      { id: "museum", statement: "Museum", origin: "user", authority: "user-protected" },
      { id: "static", statement: "Reuse backgrounds", origin: "agent", authority: "delegated" },
    ],
  };
  const record = renderFoundation(draft);
  assert.match(record, /^---\nschema: '0.1'\ntype: creative-direction\n/);
  assert.match(record, /status: draft/);
  assert.ok(record.includes(JSON.stringify(draft.title)));
  assert.equal(hasUserProtectedDecision(record), true);
  assert.match(record, /authority: delegated/);
  assert.doesNotMatch(record, /main_arc:/);
  assert.equal(hasUserProtectedDecision(renderFoundation({ ...draft, decisions: [draft.decisions[1]!] })), false);
});

test("retired demo authoring refuses live, fixture, resume and trace before any project or private state effect", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-retired-demo-"));
  t.after(() => removeTestTree(root));
  const empty = join(root, "empty"), existing = join(root, "existing"), absent = join(root, "absent");
  mkdirSync(empty); mkdirSync(existing);
  writeFileSync(join(existing, "keep.txt"), "private contents");
  const state = join(root, "state"), cache = join(root, "cache");
  for (const [project, flags] of [
    [empty, []], [empty, ["--fixture"]], [existing, ["--fixture"]],
    [absent, ["--create-project"]], [empty, ["--resume", "--thread", "old"]],
    [empty, ["--trace"]], [absent, ["--fixture", "--create-project"]],
  ] as const) {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "demo-story", "--project", project, "--task", "A mystery", ...flags], {
      encoding: "utf8", timeout: 40_000, env: { ...process.env,
        NT_STATE_DIR: state, NT_SKILL_CACHE_DIR: cache,
        NT_CONFIG_FILE: join(root, "missing-config.json") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Standalone Story authoring is retired/);
    assert.deepEqual(readdirSync(empty), []);
    assert.deepEqual(readdirSync(existing), ["keep.txt"]);
    assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "private contents");
    assert.equal(existsSync(absent), false);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(cache), false);
  }
});

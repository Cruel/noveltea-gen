import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStoryProject, projectInstructions, projectSessionDir, scopeThread } from "../src/project.js";

test("existing Story root is canonicalized without overwriting project files", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-project-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "first");
  await mkdir(root);
  await writeFile(join(root, "story.txt"), "keep");
  await symlink(root, join(base, "alias"), "dir");
  const project = await openStoryProject(root);
  assert.deepEqual(await openStoryProject(join(base, "alias")), project);
  assert.equal(await readFile(join(root, "story.txt"), "utf8"), "keep");
});

test("new Story root is empty and creation must be explicit", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-project-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "nested", "empty");
  await assert.rejects(() => openStoryProject(root), /--create-project/);
  const project = await openStoryProject(root, true);
  assert.equal(project.root, root);
  assert.deepEqual(await readdir(root), []);
  await writeFile(join(base, "a-file"), "not a directory");
  await assert.rejects(() => openStoryProject(join(base, "a-file")), /not a directory/i);
});

test("thread identifiers are stable per canonical root and isolated across projects", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-project-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = await openStoryProject(join(base, "a"), true);
  const b = await openStoryProject(join(base, "b"), true);
  assert.notEqual(a.id, b.id);
  assert.notEqual(scopeThread(a, "shared"), scopeThread(b, "shared"));
  assert.equal(scopeThread(a, "shared"), scopeThread(a, "shared"));
  assert.notEqual(projectSessionDir(a, "/tmp/pi"), projectSessionDir(b, "/tmp/pi"));
});

test("project sessions cannot collide when Pi's separator-based path encoding would", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-project-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = await openStoryProject(join(base, "a-b", "c"), true);
  const b = await openStoryProject(join(base, "a", "b-c"), true);
  assert.equal(a.root.replaceAll("/", "-"), b.root.replaceAll("/", "-"));
  assert.notEqual(projectSessionDir(a, "/tmp/pi"), projectSessionDir(b, "/tmp/pi"));
});

test("root instructions are selected without inheriting parents or global instructions", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-project-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, "AGENTS.md"), "PARENT - should not load");
  const root = join(base, "story");
  await mkdir(root);
  await writeFile(join(root, "CLAUDE.md"), "STORY ONLY");
  const project = await openStoryProject(root);
  assert.deepEqual(projectInstructions(project).map((x) => x.content), ["STORY ONLY"]);
  await writeFile(join(root, "AGENTS.md"), "AGENTS priority");
  assert.deepEqual(projectInstructions(project).map((x) => x.content), ["AGENTS priority"]);
  await rm(join(root, "AGENTS.md"));
  await rm(join(root, "CLAUDE.md"));
  await symlink(join(base, "AGENTS.md"), join(root, "AGENTS.md"));
  assert.throws(() => projectInstructions(project), /outside the selected Story root/);
  await rm(join(root, "AGENTS.md"));
  await symlink(join(root, "missing-instructions"), join(root, "AGENTS.md"));
  assert.throws(() => projectInstructions(project), /ENOENT/);
});

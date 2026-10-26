import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProjectResourceLoader } from "../src/pi.js";
import { openStoryProject } from "../src/project.js";

test("project-only Pi loader excludes global AGENTS, prompts, extensions and skills", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-pi-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agentDir = join(base, "global-pi");
  const projectDir = join(base, "story");
  const global = await openStoryProject(agentDir, true);
  const project = await openStoryProject(projectDir, true);
  await writeFile(join(global.root, "AGENTS.md"), "GLOBAL SECRET INSTRUCTIONS");
  await writeFile(join(project.root, "AGENTS.md"), "PROJECT INSTRUCTIONS");
  const { loader } = createProjectResourceLoader(project, agentDir);
  await loader.reload();
  assert.deepEqual(loader.getAgentsFiles().agentsFiles.map((x) => x.content), ["PROJECT INSTRUCTIONS"]);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getExtensions().extensions, []);

  const workerLoader = createProjectResourceLoader(project, agentDir, false).loader;
  await workerLoader.reload();
  assert.deepEqual(workerLoader.getAgentsFiles().agentsFiles, [],
    "delegated worker must not inherit coordinator AGENTS instructions");
  assert.deepEqual(workerLoader.getSkills().skills, []);
  assert.deepEqual(workerLoader.getExtensions().extensions, []);
});

test("two projects with conflicting instructions use distinct Pi resource views", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-pi-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = await openStoryProject(join(base, "a"), true);
  const b = await openStoryProject(join(base, "b"), true);
  await writeFile(join(a.root, "AGENTS.md"), "Return RED");
  await writeFile(join(b.root, "AGENTS.md"), "Return BLUE");
  const loaderA = createProjectResourceLoader(a, join(base, "global")).loader;
  const loaderB = createProjectResourceLoader(b, join(base, "global")).loader;
  await Promise.all([loaderA.reload(), loaderB.reload()]);
  assert.deepEqual(loaderA.getAgentsFiles().agentsFiles.map((x) => x.content), ["Return RED"]);
  assert.deepEqual(loaderB.getAgentsFiles().agentsFiles.map((x) => x.content), ["Return BLUE"]);
});

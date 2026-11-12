import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProjectResourceLoader } from "../src/pi.js";
import { openStoryProject } from "../src/project.js";
import { createSkillReadTool, loadSkillConfig, type SkillConfig } from "../src/skills.js";

async function skill(dir: string, name: string, body = "Example body") {
  const folder = join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n${body}\n`);
  return folder;
}

async function setup(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-skills-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const checkout = join(base, "noveltea-skills");
  await mkdir(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", checkout]);
  const catalog = await skill(join(checkout, "skills"), "nt-catalog", "Catalog contract");
  await mkdir(join(catalog, "references"));
  await writeFile(join(catalog, "references", "records.md"), "Approved records reference");
  const project = await openStoryProject(join(base, "story"), true);
  const agentDir = join(base, "pi-agent");
  const configPath = join(base, "config.json");
  const configure = async (overrides: Record<string, unknown> = {}) => {
    await writeFile(configPath, JSON.stringify({
      novelteaSkills: "./noveltea-skills",
      skillDiscovery: "explicit-only",
      ...overrides,
    }));
    return loadSkillConfig(configPath);
  };
  return { base, checkout, catalog, project, agentDir, configPath, configure };
}

test("gitignored machine-local config resolves checkout and rejects invalid paths", async t => {
  const x = await setup(t);
  const config = await x.configure();
  assert.equal(config.novelteaSkills, x.checkout);
  assert.equal(config.discovery, "explicit-only");
  assert.deepEqual(config.requiredSkills, ["nt-catalog"]);
  await assert.rejects(() => x.configure({ novelteaSkills: "./not-found" }), /Invalid novelteaSkills/);
  await assert.rejects(() => x.configure({ novelteaSkills: "./story" }), /Git checkout/);
  const fake = join(x.base, "fake-checkout");
  await mkdir(join(fake, ".git"), { recursive: true });
  await assert.rejects(() => x.configure({ novelteaSkills: "./fake-checkout" }), /not a valid Git checkout/);
  await assert.rejects(() => loadSkillConfig(join(x.base, "absent.json")), /does not exist/);
  await assert.rejects(() => x.configure({ skillDirs: ["./not-found"] }), /Invalid skillDirs/);
  await assert.rejects(() => x.configure({ skillDiscovery: "off" }), /Invalid skill configuration/);
  await assert.rejects(() => x.configure({ requiredSkills: [42] }), /Invalid skill configuration/);
  await writeFile(x.configPath, "not-json");
  await assert.rejects(() => loadSkillConfig(x.configPath), /expected JSON/);
});

test("explicit-only loads configured checkout and other dirs but no global/project skills", async t => {
  const x = await setup(t);
  const global = await skill(join(x.agentDir, "skills"), "global-only");
  await skill(join(x.project.root, ".pi", "skills"), "project-only");
  const other = join(x.base, "other-skills");
  await skill(other, "other-only");
  const config = await x.configure({ skillDirs: ["./other-skills"] });
  const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config);
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills.map(s => s.name).sort(), ["nt-catalog", "other-only"]);
  assert.ok(!loader.getSkills().skills.some(s => s.filePath.startsWith(global)));
  assert.deepEqual(loader.getExtensions().extensions, []);
  const worker = createProjectResourceLoader(x.project, x.agentDir, false, config).loader;
  await worker.reload();
  assert.deepEqual(worker.getSkills().skills, []);
});

test("standard Pi discovery works and NovelTea checkout wins global name collision", async t => {
  const x = await setup(t);
  await skill(join(x.agentDir, "skills"), "nt-catalog", "UNAPPROVED GLOBAL COPY");
  await skill(join(x.agentDir, "skills"), "global-only");
  await skill(join(x.project.root, ".pi", "skills"), "project-only");
  const config = await x.configure({ skillDiscovery: "standard" });
  const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  const catalog = skills.find(s => s.name === "nt-catalog");
  assert.equal(catalog?.filePath, join(x.catalog, "SKILL.md"));
  assert.ok(skills.some(s => s.name === "global-only"));
  assert.ok(skills.some(s => s.name === "project-only"));
  assert.ok(diagnostics.some(d => d.type === "collision" &&
    d.collision?.name === "nt-catalog" && d.collision.winnerPath === catalog?.filePath));
});

test("standard discovery isolates project skills across Story roots", async t => {
  const x = await setup(t);
  const other = await openStoryProject(join(x.base, "other-story"), true);
  await skill(join(x.project.root, ".pi", "skills"), "first-only");
  await skill(join(other.root, ".pi", "skills"), "second-only");
  const config = await x.configure({ skillDiscovery: "standard" });
  const first = createProjectResourceLoader(x.project, x.agentDir, true, config).loader;
  const second = createProjectResourceLoader(other, x.agentDir, true, config).loader;
  await Promise.all([first.reload(), second.reload()]);
  assert.ok(first.getSkills().skills.some(s => s.name === "first-only"));
  assert.ok(!first.getSkills().skills.some(s => s.name === "second-only"));
  assert.ok(second.getSkills().skills.some(s => s.name === "second-only"));
  assert.ok(!second.getSkills().skills.some(s => s.name === "first-only"));
});

test("missing required NovelTea skills fail before any model invocation", async t => {
  const x = await setup(t);
  const config = await x.configure({ requiredSkills: ["nt-story-import"] });
  const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config);
  await assert.rejects(loader.reload(), /Missing required NovelTea skill "nt-story-import"/);
  await rm(join(x.catalog, "SKILL.md"));
  const existing = await x.configure();
  await assert.rejects(createProjectResourceLoader(x.project, x.agentDir, true, existing).loader.reload(),
    /Missing required NovelTea skill "nt-catalog"/);
});

test("read-only Pi resource tool reads skill and bundled reference, never Story/global paths", async t => {
  const x = await setup(t);
  const config = await x.configure();
  const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config);
  await loader.reload();
  const reader = createSkillReadTool(loader.getSkills().skills);
  const read = async (path: string) => reader.execute("test", { path }, undefined, undefined, {} as never);
  const skillResult = await read(join(x.catalog, "SKILL.md"));
  assert.match(skillResult.content[0]!.type === "text" ? skillResult.content[0].text : "", /Catalog contract/);
  const reference = await read(join(x.catalog, "references", "records.md"));
  assert.match(reference.content[0]!.type === "text" ? reference.content[0].text : "", /Approved records/);
  assert.match(JSON.stringify(await read("skill://nt-catalog/references/records.md")), /Approved records/);
  await assert.rejects(read("skill://nt-catalog/../other/SKILL.md"), /Skill read denied/);
  const secret = join(x.project.root, "secret.md");
  await writeFile(secret, "Story private");
  await assert.rejects(read(secret), /Skill read denied/);
  await assert.rejects(read("references/records.md"), /Skill read denied/);
  const outside = join(x.base, "outside.md");
  await writeFile(outside, "Outside");
  await symlink(outside, join(x.catalog, "references", "outside.md"));
  await assert.rejects(read(join(x.catalog, "references", "outside.md")), /resolves outside/);
  assert.match(await readFile(join(x.catalog, "SKILL.md"), "utf8"), /Catalog contract/);
});

test("role-aware catalog exposes adjacent crafts but keeps orchestrator and reviewer methods private", async t => {
  const x = await setup(t);
  const skillRoot = join(x.checkout, "skills");
  const craft = await skill(skillRoot, "nt-worldbuilding");
  await mkdir(join(craft, "references"));
  await writeFile(join(craft, "references", "facts.md"), "Cross-domain craft details");
  for (const name of ["nt-character-development", "nt-narrative-review", "nt-story-orchestrate",
    "nt-story-collaborate", "nt-story-generate", "nt-story-import", "setup-noveltea"]) {
    await skill(skillRoot, name);
  }
  const collaboration = join(skillRoot, "nt-story-collaborate");
  await mkdir(join(collaboration, "references"));
  await writeFile(join(collaboration, "references", "interaction.md"),
    "Ask consequential questions with meaningful alternatives and an Other answer.");
  const config = await x.configure();
  const build = async (role: "specialist" | "reviewer" | "orchestrator") => {
    const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config, [], role);
    await loader.reload();
    const skills = loader.getSkills().skills;
    const reader = createSkillReadTool(skills);
    const read = (path: string) => reader.execute("test", { path }, undefined, undefined, {} as never);
    return { names: skills.map(s => s.name), read };
  };
  const ordinary = await build("specialist");
  assert.ok(ordinary.names.includes("nt-catalog"));
  assert.ok(ordinary.names.includes("nt-character-development"));
  assert.ok(ordinary.names.includes("nt-worldbuilding"));
  assert.ok(!ordinary.names.includes("nt-narrative-review"));
  assert.ok(!ordinary.names.includes("nt-story-orchestrate"));
  assert.ok(!ordinary.names.includes("nt-story-generate"));
  assert.ok(!ordinary.names.includes("setup-noveltea"));
  assert.match(JSON.stringify(await ordinary.read(join(craft, "references", "facts.md"))), /Cross-domain craft details/);
  for (const forbidden of ["nt-story-orchestrate", "nt-story-collaborate",
    "nt-narrative-review", "nt-story-import"]) {
    await assert.rejects(ordinary.read(join(skillRoot, forbidden, "SKILL.md")), /Skill read denied/);
  }
  const review = await build("reviewer");
  assert.ok(review.names.includes("nt-narrative-review"));
  assert.ok(review.names.includes("nt-worldbuilding"));
  assert.ok(!review.names.includes("nt-story-orchestrate"));
  await assert.rejects(review.read(join(skillRoot, "nt-story-orchestrate", "SKILL.md")), /Skill read denied/);
  const coordinate = await build("orchestrator");
  assert.ok(coordinate.names.includes("nt-story-orchestrate"));
  assert.ok(coordinate.names.includes("nt-story-collaborate"));
  assert.ok(coordinate.names.includes("nt-worldbuilding"));
  assert.ok(!coordinate.names.includes("nt-narrative-review"));
  assert.ok(!coordinate.names.includes("setup-noveltea"));
  await assert.match(JSON.stringify(await coordinate.read("skill://nt-story-collaborate/SKILL.md")),
    /nt-story-collaborate/);
  await assert.match(JSON.stringify(await coordinate.read(
    "skill://nt-story-collaborate/references/interaction.md")), /meaningful alternatives/);
  await assert.rejects(coordinate.read(join(skillRoot, "nt-narrative-review", "SKILL.md")), /Skill read denied/);
});

test("configured skill packages with escaping symlinks cannot be discovered", async t => {
  const x = await setup(t);
  const other = join(x.base, "outside-skill");
  await skill(other, "nt-outside");
  await symlink(join(other, "nt-outside"), join(x.checkout, "skills", "nt-escape"));
  const config: SkillConfig = await x.configure();
  const { loader } = createProjectResourceLoader(x.project, x.agentDir, true, config);
  await assert.rejects(loader.reload(), /resolves outside configured directory/);
});

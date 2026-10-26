import { removeTestTree } from "./helpers.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createFoundationTools, renderFoundation, validateFoundation } from "../src/demo.js";
import { openStoryProject } from "../src/project.js";
import { loadSkillConfig } from "../src/skills.js";
import { createProjectResourceLoader } from "../src/pi.js";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nt-gen-foundation-"));
  t.after(() => removeTestTree(root));
  const checkout = join(root, "noveltea-skills");
  const skills = join(checkout, "skills");
  const story = join(root, "story");
  const config = join(root, "config.json");
  mkdirSync(story);
  for (const name of ["nt-catalog", "nt-story-discovery"]) {
    const dir = join(skills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fixture package\n---\nLoad the catalog references.\n`);
  }
  const refs = join(skills, "nt-catalog", "references");
  mkdirSync(refs);
  for (const name of ["records.md", "authority-and-validation.md", "glossary.md"]) {
    writeFileSync(join(refs, name), `# ${name}\n`);
  }
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "add", "skills"]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Fixture", "-c",
    "user.email=fixture@example.invalid", "commit", "-qm", "fixture skills"]);
  writeFileSync(config, JSON.stringify({ novelteaSkills: checkout, skillDiscovery: "explicit-only" }));
  const env = {
    ...process.env, NT_CONFIG_FILE: config,
    NT_SKILL_CACHE_DIR: join(root, "cache"),
    NT_STATE_DIR: join(root, "state"),
  };
  const cli = (args: string[], envOverrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"), "demo-story",
    "--project", story, ...args,
  ], { env: { ...env, ...envOverrides }, cwd: resolve("."), encoding: "utf8", timeout: 40_000 });
  return { root, checkout, story, config, env, cli };
}

const candidate = {
  id: "dead-letter", title: "A Dead Letter",
  premise: "A curator finds a forged will in a locked gallery.",
  central_conflict: "Whether to expose the will before the family sells the estate.",
  genre: "Mystery", tone: "Tense", player_experience: "Find a fair clue in dialogue.",
  scope: "A short static visual novel.",
  decisions: [
    { id: "museum", statement: "The author specifies a museum.", origin: "user", authority: "user-protected" },
    { id: "no-animation", statement: "Reuse static visual locations.", origin: "agent", authority: "delegated" },
  ],
  body: "# A Dead Letter\n\nUnmask a family secret through constrained dialogue and a staged reveal.",
};

test("bounded Creative Direction envelope, authority and YAML quoting reject unsafe input", () => {
  const valid = validateFoundation(candidate);
  assert.match(renderFoundation(valid), /^---\nschema: '0.1'\ntype: creative-direction\n/);
  assert.match(renderFoundation(valid), /status: draft/);
  assert.match(renderFoundation(valid), /authority: user-protected/);
  assert.match(renderFoundation(valid), /authority: delegated/);
  assert.doesNotMatch(renderFoundation(valid), /main_arc:/);
  const quoted = renderFoundation(validateFoundation({ ...candidate, title: "Murder: \"Evidence\"\nFalse" }));
  assert.match(quoted, /title: "Murder: \\"Evidence\\"\\nFalse"/);
  assert.throws(() => validateFoundation({ ...candidate, id: "../outside" }), /id must be a lowercase slug/);
  assert.throws(() => validateFoundation({ ...candidate, unapproved: 1 }), /only the foundation/);
  assert.throws(() => validateFoundation({ ...candidate, decisions: [] }), /1–20/);
  assert.throws(() => validateFoundation({ ...candidate, decisions: candidate.decisions.map(d => ({ ...d, authority: "delegated" })) }), /unsupported authority/);
  assert.throws(() => validateFoundation({ ...candidate, decisions: [candidate.decisions[0]] }), /agent-delegated/);
  assert.throws(() => validateFoundation({ ...candidate, decisions: [candidate.decisions[1], candidate.decisions[1]] }), /duplicate/);
});

test("authoring requires successful reads of both skills and catalog references, and refuses existing canon", async t => {
  const x = setup(t);
  const project = await openStoryProject(x.story);
  const config = await loadSkillConfig(x.config);
  const { loader } = createProjectResourceLoader(project, join(x.root, "agent"), true, config);
  await loader.reload();
  const io = createFoundationTools(project, loader.getSkills().skills);
  const call = (tool: number, args: unknown) =>
    io.tools[tool]!.execute("test", args as never, undefined, undefined, {} as never);
  await assert.rejects(call(1, candidate), /Read the required pinned skill references/);
  for (const path of io.required) {
    const result = await call(0, { path });
    assert.ok(result.content.length);
  }
  assert.equal(io.readPaths().length, 5);
  await assert.rejects(call(0, { path: join(x.story, "secret.md") }), /Skill read denied/);
  const outside = join(x.root, "outside.md");
  writeFileSync(outside, "unrelated file");
  const ref = join(x.checkout, "skills", "nt-catalog", "references", "outside.md");
  symlinkSync(outside, ref);
  await assert.rejects(call(0, { path: ref }), /resolves outside/);
  const result = await call(1, candidate);
  assert.match(JSON.stringify(result), /local contract read-back passed/);
  const artifact = join(x.story, "creative-direction", "foundation.md");
  assert.match(readFileSync(artifact, "utf8"), /creative-direction.dead-letter/);
  assert.deepEqual(readdirSync(x.story), ["creative-direction"]);
  await assert.rejects(call(1, candidate), /already written/);
  assert.equal(readFileSync(outside, "utf8"), "unrelated file");
});

test("CLI fixture pins source, writes exactly one draft in empty Story, and never runs Pi", t => {
  const x = setup(t);
  const before = execFileSync("git", ["-C", x.checkout, "status", "--porcelain"], { encoding: "utf8" });
  const result = x.cli(["--fixture", "--task", "A murder mystery; you choose the remaining details"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.mode, "fixture");
  assert.equal(output.piSessionId, undefined);
  assert.match(output.skillSnapshot.id, /^[a-f0-9]{64}$/);
  assert.equal(output.skillSnapshot.id, output.skillSnapshot.digest);
  assert.equal(output.skillSnapshot.commit, execFileSync("git", ["-C", x.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.ok(output.skillReads.every((path: string) => path.startsWith(output.skillSnapshot.path)));
  assert.equal(output.skillReads.length, 5);
  assert.equal(output.recordStatus, "draft");
  assert.equal(output.contractCheck, "local-readback");
  assert.equal(output.catalogValidation, "unverified");
  assert.match(readFileSync(output.artifact, "utf8"), /creative-direction.sealed-room/);
  assert.deepEqual(readdirSync(x.story), ["creative-direction"]);
  assert.deepEqual(readdirSync(join(x.story, "creative-direction")), ["foundation.md"]);
  assert.equal(execFileSync("git", ["-C", x.checkout, "status", "--porcelain"], { encoding: "utf8" }), before);
  const duplicate = x.cli(["--fixture", "--task", "another task"]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /fresh empty Story directory/);
  assert.equal(existsSync(join(x.story, "project.yaml")), false);
});

test("demo CLI rejects unavailable checkout, graph-only flags and a Story with existing work", t => {
  const x = setup(t);
  const resume = x.cli(["--fixture", "--resume", "--thread", "old"]);
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /demo-story does not support|--resume/);
  const trace = x.cli(["--fixture", "--task", "mystery", "--trace"]);
  assert.notEqual(trace.status, 0);
  assert.match(trace.stderr, /demo-story does not support/);
  writeFileSync(join(x.story, "keep.txt"), "private contents");
  const existing = x.cli(["--fixture", "--task", "mystery"]);
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /fresh empty Story directory/);
  assert.equal(readFileSync(join(x.story, "keep.txt"), "utf8"), "private contents");
  const otherStory = join(x.root, "other-empty-story");
  mkdirSync(otherStory);
  const noConfig = x.cli(["--project", otherStory, "--fixture", "--task", "mystery"],
    { NT_CONFIG_FILE: join(x.root, "missing-config.json") });
  assert.notEqual(noConfig.status, 0);
  assert.match(noConfig.stderr, /Skill configuration does not exist/);
  assert.deepEqual(readdirSync(otherStory), []);
});

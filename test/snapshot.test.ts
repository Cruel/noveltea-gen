import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSkillSnapshot, openSkillSnapshot } from "../src/snapshot.js";
import { loadSkillConfig } from "../src/skills.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid" },
  }).trim();
}

test("content-addressed immutable snapshots capture git provenance, reuse, changes and corruption", async t => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-snapshot-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const previous = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(base, "cache");
  t.after(() => {
    if (previous === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = previous;
  });
  const checkout = join(base, "skills-repo");
  await mkdir(join(checkout, "skills", "nt-catalog", "references"), { recursive: true });
  git(checkout, "init", "-q");
  const catalog = join(checkout, "skills", "nt-catalog");
  await writeFile(join(catalog, "SKILL.md"), "---\nname: nt-catalog\ndescription: Catalog\n---\ntext\n");
  const ref = join(catalog, "references", "records.md");
  await writeFile(ref, "reference v1");
  await writeFile(join(checkout, "README.md"), "unrelated");
  git(checkout, "add", "skills", "README.md");
  git(checkout, "commit", "-qm", "first");
  const configFile = join(base, "config.json");
  await writeFile(configFile, JSON.stringify({ novelteaSkills: "./skills-repo", skillDiscovery: "explicit-only" }));
  const config = await loadSkillConfig(configFile);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => createSkillSnapshot(config)));
  const a = concurrent[0]!;
  assert.ok(concurrent.every(entry => entry?.id === a.id && entry.path === a.path),
    "concurrent workflows must publish and reuse one verified digest directory");
  assert.equal(a.id, a.digest);
  assert.match(a.id, /^[a-f0-9]{64}$/);
  assert.equal(a.commit, git(checkout, "rev-parse", "HEAD"));
  assert.equal(a.branch, git(checkout, "branch", "--show-current"));
  assert.equal(a.detached, false);
  assert.equal(a.dirty, false);
  await mkdir(join(checkout, "node_modules"));
  await writeFile(join(checkout, "node_modules", "junk.md"), "ignored");
  assert.equal(await readFile(join(a.path, "skills", "nt-catalog", "references", "records.md"), "utf8"), "reference v1");
  assert.deepEqual(await readdir(a.path), ["skills"]);
  await writeFile(join(checkout, "README.md"), "irrelevant changed");
  const b = (await createSkillSnapshot(config))!;
  assert.equal(b.id, a.id, "unrelated file is not part of the manifest");
  assert.equal(b.path, a.path);
  assert.equal(b.dirty, true);
  await writeFile(ref, "reference v2");
  const c = (await createSkillSnapshot(config))!;
  assert.notEqual(c.id, a.id);
  assert.equal(await readFile(join(a.path, "skills", "nt-catalog", "references", "records.md"), "utf8"), "reference v1");
  const renamed = join(catalog, "references", "renamed.md");
  await rename(ref, renamed);
  const d = (await createSkillSnapshot(config))!;
  assert.notEqual(d.id, c.id);
  await rm(renamed);
  const e = (await createSkillSnapshot(config))!;
  assert.notEqual(e.id, d.id);
  await writeFile(join(catalog, "references", "new.md"), "new");
  const f = (await createSkillSnapshot(config))!;
  assert.notEqual(f.id, e.id);
  git(checkout, "checkout", "--detach", "-q");
  const detached = (await createSkillSnapshot(config))!;
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.dirty, true);
  await writeFile(join(a.path, "skills", "nt-catalog", "SKILL.md"), "corrupted");
  await assert.rejects(openSkillSnapshot(a.id), /corrupt|modified/);
  await assert.rejects(createSkillSnapshot(config).then(async () => {
    await writeFile(join(checkout, "skills", "nt-catalog", "SKILL.md"), "---\nname: nt-catalog\ndescription: Catalog\n---\ntext\n");
    await rm(join(checkout, "skills", "nt-catalog", "references", "new.md"));
    await writeFile(ref, "reference v1");
    await createSkillSnapshot(config);
  }), /corrupt|modified/);
  await rm(join(a.path), { recursive: true });
  await assert.rejects(openSkillSnapshot(a.id), /Cannot restore pinned/);
  const linked = join(base, "linked-root");
  await mkdir(linked);
  git(linked, "init", "-q");
  git(linked, "commit", "--allow-empty", "-qm", "linked checkout");
  await symlink(join(checkout, "skills"), join(linked, "skills"));
  await assert.rejects(createSkillSnapshot({ ...config, novelteaSkills: linked }), /real directory/);
});

test("fixture checkpoint preserves snapshot identity after checkout is removed", async t => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-snapshot-cli-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const checkout = join(base, "source");
  const catalog = join(checkout, "skills", "nt-catalog");
  await mkdir(catalog, { recursive: true });
  git(checkout, "init", "-q");
  await writeFile(join(catalog, "SKILL.md"), "---\nname: nt-catalog\ndescription: Catalog\n---\ntest\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "initial");
  const cfg = join(base, "config.json");
  await writeFile(cfg, JSON.stringify({ novelteaSkills: checkout, skillDiscovery: "explicit-only" }));
  const project = join(base, "story");
  await mkdir(project);
  const env = { ...process.env, NT_CONFIG_FILE: cfg, NT_STATE_DIR: join(base, "state"),
    NT_SKILL_CACHE_DIR: join(base, "cache") };
  const run = (extra: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "run",
      "--project", project, "--thread", "snapshot-resume", "--fixture", ...extra], {
      cwd: resolve("."), env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run(["--task", "a murder mystery", "--pause-after", "handoff"]);
  assert.equal(first.status, "paused");
  assert.ok(first.skillSnapshot?.id);
  await rm(checkout, { recursive: true });
  const second = run(["--resume"]);
  assert.equal(second.status, "completed");
  assert.equal(second.skillSnapshot.id, first.skillSnapshot.id);
  await writeFile(join(second.skillSnapshot.path, "skills", "nt-catalog", "SKILL.md"), "damaged");
  const failure = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "run",
    "--project", project, "--thread", "snapshot-resume", "--fixture", "--resume"], {
    cwd: resolve("."), env, encoding: "utf8", timeout: 30_000,
  });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /pinned skill snapshot/);
});

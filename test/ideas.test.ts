import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "nt-ideas-"));
after(() => rmSync(root, { recursive: true, force: true }));
const cliPath = resolve("src/cli.ts");
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function story(name: string, late = false) {
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  const record = (folder: string, name: string, type: string, arcs: string[] = []) => {
    mkdirSync(join(story, folder), { recursive: true });
    writeFileSync(join(story, folder, name + ".md"), `---
schema: '0.1'
type: ${type}
id: ${type}.${name}
status: draft
arcs: [${arcs.join(", ")}]
---
`);
  };
  record("arcs", "truth", "arc");
  record("milestones", "start", "milestone", ["arc.truth"]);
  record("events", "intro", "event", ["arc.truth"]);
  if (late) {
    record("milestones", "turn", "milestone", ["arc.truth"]);
    record("events", "rising", "event", ["arc.truth"]);
    record("events", "reveal", "event", ["arc.truth"]);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Author Story baseline");
  const base = git(repo, "rev-parse", "HEAD");
  const state = join(root, name + "-state");
  const call = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", cliPath, "job", ...args, "--story", story, "--job", "draft"],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, NT_STATE_DIR: state } });
  const started = call("start");
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout) as { worktreeRoot: string; worktreeStoryRoot: string };
  const file = join(root, name + "-idea.json");
  const idea = {
    kind: "exact-dialogue", source: { kind: "author-onboarding", reference: "notes page 3" },
    original: 'Mara: "No one remembers the bell."',
    requirements: { meaning: [{ text: "Mara's confession changes trust", binding: true }],
      wording: [{ text: "No one remembers the bell.", binding: true }],
      participants: [{ text: "character.mara", binding: true }] },
    identities: { known: ["character.mara"], unresolved: ["the silent witness"] },
    prerequisites: ["milestone.start"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [{ text: "Mara must be present in the truth arc", targets: ["arc.truth"], authorized: true }],
  };
  writeFileSync(file, JSON.stringify(idea));
  const capture = () => call("ideas", "capture", "--file", file);
  const ok = (out: ReturnType<typeof call>) => {
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  return { repo, story, state, base, job, idea, file, call, capture, ok };
}

test("onboarding capture creates exactly one verified noncanonical YAML commit and preserves original author bytes", () => {
  const x = story("onboarding");
  const first = x.ok(x.capture());
  assert.equal(first.status, "captured");
  assert.match(first.id, /^idea-[0-9a-f]{24}$/);
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
  const path = join(x.job.worktreeStoryRoot, ".story-inbox", "ideas", first.id + ".yaml");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.original, x.idea.original);
  assert.deepEqual(saved.requirements, x.idea.requirements);
  assert.equal(saved.lifecycle.status, "dormant");
  assert.equal(saved.lifecycle.placedAt, null);
  assert.equal(saved.lifecycle.activatedAt, null);
  assert.match(git(x.job.worktreeRoot, "show", "-s", "--format=%B", "HEAD"), /NovelTea-Work-Item: idea-capture/);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  // JSON property order and formatting do not define the author idea identity.
  writeFileSync(x.file, JSON.stringify(Object.fromEntries(Object.entries(x.idea).reverse()), null, 2));
  const again = x.ok(x.capture());
  assert.equal(again.id, first.id);
  assert.equal(again.commitSha, first.commitSha);
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
  assert.equal(readdirSync(join(x.job.worktreeStoryRoot, ".story-inbox", "ideas")).length, 1);
  assert.equal(x.ok(x.call("ideas", "inspect")).ideas[0].id, first.id);
});

test("early Event hierarchy and partial scope never leak dormant dialogue, but explicit upstream constraints are narrow", () => {
  const x = story("early");
  const id = x.ok(x.capture()).id;
  const context = x.ok(x.call("ideas", "context", "--target", "arc.truth"));
  assert.equal(context.ideas.length, 0);
  assert.deepEqual(context.upstreamConstraints, [{ ideaId: id, text: x.idea.upstreamConstraints[0].text, target: "arc.truth" }]);
  const event = x.ok(x.call("ideas", "context", "--target", "event.intro"));
  assert.equal(event.ideas.length, 0);
  assert.equal(event.upstreamConstraints.length, 0);
  assert.ok(!JSON.stringify(context).includes(x.idea.original));
  assert.ok(!JSON.stringify(event).includes(x.idea.original));
  const snapshot = x.ok(x.call("ideas", "eligibility"));
  assert.equal(snapshot.ideas[0].eligible, false);
  assert.equal(snapshot.ideas[0].status, "dormant");
  assert.ok(!JSON.stringify(snapshot).includes(x.idea.original));
});

test("later relevant breadth makes dialogue available only to in-scope Event workers", () => {
  const x = story("late", true);
  const id = x.ok(x.capture()).id;
  const eligible = x.ok(x.call("ideas", "eligibility"));
  assert.equal(eligible.ideas[0].eligible, true);
  const ordinary = x.ok(x.call("ideas", "context", "--target", "event.reveal"));
  assert.equal(ordinary.ideas.length, 0, "ordinary workers must not receive unplaced dialogue");
  const result = x.ok(x.call("ideas", "placement-context", "--target", "event.reveal"));
  assert.equal(result.ideas.length, 1);
  assert.equal(result.ideas[0].id, id);
  assert.equal(result.ideas[0].original, x.idea.original);
  assert.equal(x.ok(x.call("ideas", "placement-context", "--target", "arc.truth")).ideas.length, 0);
  assert.equal(x.ok(x.call("ideas", "placement-context", "--target", "event.nonexistent")).ideas.length, 0);
  const committed = JSON.parse(readFileSync(join(x.job.worktreeStoryRoot, ".story-inbox/ideas", id + ".yaml"), "utf8"));
  assert.equal(committed.lifecycle.status, "dormant", "eligibility does not activate or modify canon");
});

test("unresolved author and canonical prerequisites remain binding even with late Event breadth", () => {
  const x = story("unresolved", true);
  writeFileSync(x.file, JSON.stringify({ ...x.idea,
    prerequisites: ["milestone.start", "fact.secret-known"],
    unresolvedPrerequisites: ["The player knows which witness has the key"] }));
  const captured = x.ok(x.capture());
  assert.ok(captured.commitSha);
  const assessment = x.ok(x.call("ideas", "eligibility")).ideas[0];
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.reasons.includes("unresolved-author-prerequisites"));
  assert.ok(assessment.reasons.includes("unmet-prerequisite:fact.secret-known"));
  const result = x.ok(x.call("ideas", "placement-context", "--target", "event.reveal"));
  assert.equal(result.ideas.length, 0, "unresolved requirements must not be exposed as eligible");
});

test("capture blocks unsafe Git state, conflicting identity, and changes to the original author material", () => {
  const x = story("negative");
  const first = x.ok(x.capture());
  writeFileSync(x.file, JSON.stringify({ ...x.idea, id: first.id, original: "different" }));
  const collision = x.capture();
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /conflict|different|already/i);
  writeFileSync(x.file, JSON.stringify(x.idea));
  writeFileSync(join(x.job.worktreeStoryRoot, "manual.md"), "author's work\n");
  const blocked = x.capture();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /uncommitted|dirty|unexpected/i);
  assert.equal(readFileSync(join(x.job.worktreeStoryRoot, "manual.md"), "utf8"), "author's work\n");
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
});

test("prepared prewrite and fully authored capture receipts recover exact bytes without replay", () => {
  const sha = (data: string) => createHash("sha256").update(data).digest("hex");
  const stable = (value: any): string => Array.isArray(value)
    ? "[" + value.map(stable).join(",") + "]"
    : value !== null && typeof value === "object"
      ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
      : JSON.stringify(value);
  for (const authored of [false, true]) {
    const x = story(authored ? "preauthored" : "prewrite");
    const id = "reviewed-note";
    const data = { ...x.idea };
    writeFileSync(x.file, JSON.stringify({ id, ...data }));
    const path = ".story-inbox/ideas/" + id + ".yaml";
    const content = JSON.stringify({ schema: "0.1", id, ...data, lifecycle: {
      status: "dormant", capturedAt: "2026-10-28T00:00:00.000Z",
      activatedAt: null, placedAt: null, placements: [],
    } }, null, 2) + "\n";
    const location = join(x.job.worktreeRoot, "..", "ideas");
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, id + ".json"), JSON.stringify({
      version: 1, jobId: "draft", threadId: JSON.parse(readFileSync(
        join(x.job.worktreeRoot, "..", "job.json"), "utf8")).threadId,
      branch: git(x.job.worktreeRoot, "symbolic-ref", "--short", "HEAD"),
      worktreeRoot: x.job.worktreeRoot, id, inputDigest: sha(stable(data)),
      priorHead: x.base, path, blobDigest: sha(content), content, phase: "prepared",
    }));
    if (authored) {
      mkdirSync(join(x.job.worktreeStoryRoot, ".story-inbox/ideas"), { recursive: true });
      writeFileSync(join(x.job.worktreeStoryRoot, path), content);
    }
    const result = x.ok(x.capture());
    assert.equal(result.id, id);
    assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
    assert.equal(readFileSync(join(x.job.worktreeStoryRoot, path), "utf8"), content);
  }
});

test("recover interrupted capture after a verified commit without creating another commit", () => {
  const x = story("recovery");
  const first = x.ok(x.capture());
  const receipt = join(x.state, "jobs");
  const jobdir = join(receipt, readdirSync(receipt)[0]!);
  const file = join(jobdir, "ideas", first.id + ".json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.phase = "prepared";
  delete saved.commitSha;
  writeFileSync(file, JSON.stringify(saved));
  const second = x.ok(x.capture());
  assert.equal(second.commitSha, first.commitSha);
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
});

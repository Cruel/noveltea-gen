import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, after } from "node:test";
import { renderFoundation, type FoundationDraft } from "../src/demo.js";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "noveltea-revision-tests-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
const skills = process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills");
const SKIP = !existsSync(join(skills, "src/cli.ts")) ? "canonical skills checkout required" : false;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function draft(statement = "The brother is the murderer"): FoundationDraft {
  return {
    id: "foundation", title: "Last Bell", genre: "Mystery", tone: "Intimate",
    premise: "A detective tracks down a disappearing heir on a stopped train.",
    central_conflict: "Family loyalty against public truth.",
    player_experience: "Dialogue-led mystery with clear clues.",
    scope: "One compact train mystery.",
    decisions: [
      { id: "culprit", statement, origin: "user", authority: "user-protected" },
      { id: "visuals", statement: "Use two train backgrounds", origin: "agent", authority: "delegated" },
    ],
    body: "# Story foundation\n\nThe brother is responsible; the detective must discover this by comparing testimony.",
  };
}
function setup(name: string, existing = true) {
  const repo = join(root, name);
  const story = join(repo, "story");
  const state = join(root, "state-" + name);
  mkdirSync(story, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Original Author");
  git(repo, "config", "user.email", "author@example.test");
  writeFileSync(join(repo, "README.md"), "Original author branch\n");
  if (existing) {
    mkdirSync(join(story, "creative-direction"));
    writeFileSync(join(story, "creative-direction/foundation.md"), renderFoundation(draft()));
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Trusted baseline");
  const initialSha = git(repo, "rev-parse", "HEAD");
  function cliRun(...args: string[]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
      cwd: resolve("."), encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NT_STATE_DIR: state,
        NT_SKILL_CACHE_DIR: join(root, "skill-cache"),
        NT_VALIDATOR_CACHE_DIR: join(root, "validator-cache") },
    });
    return { result, data: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
  }
  const start = cliRun("start", "--story", story, "--job", "draft");
  assert.equal(start.result.status, 0, start.result.stderr);
  const job = start.data;
  const target = "creative-direction/foundation.md";
  const file = join(job.worktreeStoryRoot, target);
  function revision(action: string, id: string, ...args: string[]) {
    return cliRun("revision", action, "--story", story, "--job", "draft",
      "--work-item", id, ...args);
  }
  function inspect(id: string) {
    return revision("inspect", id, "--path", target, "--validator-source", skills);
  }
  function approve(id: string, proposal: string, change: string, decision = "approve") {
    return revision("authorize", id, "--proposal", proposal, "--change", change,
      "--decision", decision, "--reason", "I personally reviewed and authorize this exact proposed replacement");
  }
  function editorial(id: string, proposal: string, verdict = "pass") {
    return revision("review", id, "--proposal", proposal, "--verdict", verdict,
      "--evidence", target + ":11-31",
      "--notes", "I independently read the original and proposed prose, checked the culprit's intent and references.");
  }
  function commit(id: string, proposal: string) {
    return revision("commit", id, "--proposal", proposal);
  }
  return { repo, story, state, job, file, target, initialSha,
    cliRun, revision, inspect, approve, editorial, commit };
}

test("exact scoped approvals permit a protected edit; other unstaged files stay untouched", { skip: SKIP }, () => {
  const s = setup("approved");
  writeFileSync(s.file, renderFoundation(draft("The sister is the murderer")));
  writeFileSync(join(s.job.worktreeRoot, "scratch.txt"), "Unrelated edits stay here\n");
  const p = s.inspect("change-culprit");
  assert.equal(p.result.status, 0, p.result.stderr);
  assert.equal(p.data.protectedChanges.length, 1);
  assert.match(p.data.patch, /The sister is the murderer/);
  assert.match(p.data.patch, /The brother is the murderer/);
  assert.equal(p.data.protectedChanges[0].decision, "creative-direction.foundation#culprit");
  assert.deepEqual(p.data.unrelatedUncommittedPaths, ["scratch.txt"]);
  const proposal = p.data.proposalSha256;
  const denied = s.commit("change-culprit", proposal);
  assert.notEqual(denied.result.status, 0);
  assert.match(denied.result.stderr, /review|authorization/i);
  const approved = s.approve("change-culprit", proposal, p.data.protectedChanges[0].id);
  assert.equal(approved.result.status, 0, approved.result.stderr);
  assert.equal(approved.data.authorApprovals[0].source, "explicit-author-cli");
  assert.equal(s.editorial("change-culprit", proposal).result.status, 0);
  const committed = s.commit("change-culprit", proposal);
  assert.equal(committed.result.status, 0, committed.result.stderr);
  assert.equal(committed.data.status, "committed");
  assert.equal(git(s.job.worktreeRoot, "log", "-1", "--format=%an <%ae>"),
    "NovelTea Generator <noveltea-gen@users.noreply.github.com>");
  assert.match(git(s.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Approvals: [a-f0-9-]+/);
  assert.equal(git(s.job.worktreeRoot, "show", "--format=", "--name-only", "HEAD"), "story/" + s.target);
  assert.equal(readFileSync(join(s.job.worktreeRoot, "scratch.txt"), "utf8"), "Unrelated edits stay here\n");
  assert.equal(git(s.repo, "rev-parse", "HEAD"), s.initialSha);
  assert.equal(readFileSync(join(s.story, s.target), "utf8"), renderFoundation(draft()));
  // Simulate a process crash after Git commit but before both durable receipts
  // were published. Exact job/work-item/proposal Git trailers must reconcile it.
  const receipts = join(s.state, "jobs", s.job.branch.split("/")[1], "revisions");
  const file = join(receipts, "change-culprit.json");
  const pending = JSON.parse(readFileSync(file, "utf8"));
  pending.status = "proposed";
  delete pending.commitSha;
  writeFileSync(file, JSON.stringify(pending));
  rmSync(join(receipts, "verified-head.json"));
  const replay = s.commit("change-culprit", proposal);
  assert.equal(replay.result.status, 0, replay.result.stderr);
  assert.equal(replay.data.commitSha, committed.data.commitSha);
  assert.equal(git(s.job.worktreeRoot, "rev-list", "--count", s.initialSha + "..HEAD"), "1");
});

test("forged Git trailers cannot recover an unauthorized protected revision", { skip: SKIP }, () => {
  const s = setup("forged-trailers");
  writeFileSync(s.file, renderFoundation(draft("The sister is the murderer")));
  const p = s.inspect("forged");
  assert.equal(p.result.status, 0, p.result.stderr);
  // No explicit author approval or semantic review ever occurred.
  git(s.job.worktreeRoot, "add", "--", "story/" + s.target);
  git(s.job.worktreeRoot, "commit", "-m",
    `Revise protected Story [draft/forged]\n\nNovelTea-Job: draft\nNovelTea-Work-Item: forged\nNovelTea-Proposal: ${p.data.proposalSha256}`);
  const response = s.revision("status", "forged", "--proposal", p.data.proposalSha256);
  assert.notEqual(response.result.status, 0, "Git trailers are not approval evidence");
  const file = join(s.state, "jobs", s.job.branch.split("/")[1], "revisions/forged.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "proposed");
});

test("earlier committed revision receipts remain readable after subsequent verified commits", { skip: SKIP }, () => {
  const s = setup("historical-status");
  for (const [id, culprit] of [["first", "The sister is the murderer"], ["second", "The mother is the murderer"]]) {
    writeFileSync(s.file, renderFoundation(draft(culprit)));
    const inspected = s.inspect(id);
    assert.equal(inspected.result.status, 0, inspected.result.stderr);
    for (const change of inspected.data.protectedChanges) {
      assert.equal(s.approve(id, inspected.data.proposalSha256, change.id).result.status, 0);
    }
    assert.equal(s.editorial(id, inspected.data.proposalSha256).result.status, 0);
    assert.equal(s.commit(id, inspected.data.proposalSha256).result.status, 0);
  }
  const history = s.revision("status", "first", "--proposal",
    JSON.parse(readFileSync(join(s.state, "jobs", s.job.branch.split("/")[1],
      "revisions/first.json"), "utf8")).proposalSha256);
  assert.equal(history.result.status, 0, history.result.stderr);
  assert.equal(history.data.status, "committed");
});

test("rejected and missing author decisions block even when editorial review passes", { skip: SKIP }, () => {
  const s = setup("rejected");
  writeFileSync(s.file, renderFoundation(draft("The doctor is the murderer")));
  const p = s.inspect("reject-culprit");
  assert.equal(p.result.status, 0, p.result.stderr);
  const hash = p.data.proposalSha256, change = p.data.protectedChanges[0].id;
  assert.equal(s.editorial("reject-culprit", hash).result.status, 0);
  assert.match(s.commit("reject-culprit", hash).result.stderr, /authorization/);
  assert.equal(s.approve("reject-culprit", hash, change, "reject").result.status, 0);
  assert.match(s.commit("reject-culprit", hash).result.stderr, /authorization/);
  assert.equal(git(s.job.worktreeRoot, "rev-parse", "HEAD"), s.initialSha);
  assert.match(readFileSync(s.file, "utf8"), /doctor is the murderer/);
});

test("modified proposal or forged approval bytes never inherit earlier authorization", { skip: SKIP }, () => {
  const s = setup("modified");
  writeFileSync(s.file, renderFoundation(draft("The maid is the murderer")));
  const p = s.inspect("modify");
  const hash = p.data.proposalSha256, change = p.data.protectedChanges[0].id;
  assert.equal(s.approve("modify", hash, change).result.status, 0);
  assert.equal(s.editorial("modify", hash).result.status, 0);
  writeFileSync(s.file, renderFoundation(draft("The mayor is the murderer")));
  assert.match(s.commit("modify", hash).result.stderr, /changed|proposal/i);
  const newInspect = s.inspect("modify");
  assert.notEqual(newInspect.result.status, 0);
  assert.match(newInspect.result.stderr, /changed|proposal/i);
  writeFileSync(s.file, renderFoundation(draft("The maid is the murderer")));
  const receipt = join(s.state, "jobs", s.job.branch.split("/")[1], "revisions/modify.json");
  const stored = JSON.parse(readFileSync(receipt, "utf8"));
  stored.approvals[0].after.statement = "A different approved statement";
  writeFileSync(receipt, JSON.stringify(stored));
  assert.match(s.commit("modify", hash).result.stderr, /authorization/);
  assert.equal(git(s.job.worktreeRoot, "rev-parse", "HEAD"), s.initialSha);
});

test("later protected decisions are enforced even when initial trusted Story baseline was empty", { skip: SKIP }, () => {
  const s = setup("later-protected", false);
  const generated = s.cliRun("foundation", "--story", s.story, "--job", "draft",
    "--fixture", "--task", "Murder mystery with a protected premise",
    "--skills-source", skills, "--validator-source", skills);
  assert.equal(generated.result.status, 0, generated.result.stderr);
  const foundationSha = generated.data.commitSha;
  const text = readFileSync(s.file, "utf8");
  writeFileSync(s.file, text.replace("Murder mystery with a protected premise", "Science-fiction adventure"));
  const p = s.inspect("later-change");
  assert.equal(p.result.status, 0, p.result.stderr);
  assert.equal(p.data.protectedChanges.length, 1);
  assert.equal(p.data.protectedChanges[0].base, foundationSha);
  assert.match(s.commit("later-change", p.data.proposalSha256).result.stderr, /review|authorization/);
  const change = p.data.protectedChanges[0].id;
  assert.equal(s.approve("later-change", p.data.proposalSha256, change).result.status, 0);
  assert.equal(s.editorial("later-change", p.data.proposalSha256).result.status, 0);
  const done = s.commit("later-change", p.data.proposalSha256);
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(git(s.repo, "rev-parse", "HEAD"), s.initialSha);
});

test("both original and last verified decision baselines are independently checked", { skip: SKIP }, () => {
  const s = setup("both-baselines");
  writeFileSync(s.file, renderFoundation(draft("The sister is the murderer")));
  const first = s.inspect("first-change");
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(s.approve("first-change", first.data.proposalSha256, first.data.protectedChanges[0].id).result.status, 0);
  assert.equal(s.editorial("first-change", first.data.proposalSha256).result.status, 0);
  assert.equal(s.commit("first-change", first.data.proposalSha256).result.status, 0);
  writeFileSync(s.file, renderFoundation(draft("The mother is the murderer")));
  const second = s.inspect("second-change");
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.data.protectedChanges.length, 2);
  assert.deepEqual(new Set(second.data.protectedChanges.map((c: any) => c.base)).size, 2);
  assert.equal(s.approve("second-change", second.data.proposalSha256,
    second.data.protectedChanges[0].id).result.status, 0);
  assert.equal(s.editorial("second-change", second.data.proposalSha256).result.status, 0);
  assert.match(s.commit("second-change", second.data.proposalSha256).result.stderr, /authorization/);
  assert.equal(s.approve("second-change", second.data.proposalSha256,
    second.data.protectedChanges[1].id).result.status, 0);
  const done = s.commit("second-change", second.data.proposalSha256);
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(done.data.status, "committed");
  assert.equal(git(s.job.worktreeRoot, "rev-list", "--count", s.initialSha + "..HEAD"), "2");
});


test("promoting a delegated decision to protected authority also requires author authorization", { skip: SKIP }, () => {
  const s = setup("authority-adoption");
  const source = readFileSync(s.file, "utf8");
  writeFileSync(s.file, source.replace(
    'statement: "Use two train backgrounds"\n    origin: agent\n    authority: delegated',
    'statement: "Use two train backgrounds"\n    origin: agent\n    authority: user-protected'));
  const p = s.inspect("adopt-visuals");
  assert.equal(p.result.status, 0, p.result.stderr);
  assert.equal(p.data.protectedChanges.length, 1);
  assert.equal(p.data.protectedChanges[0].kind, "adopted-protection");
  assert.equal(p.data.protectedChanges[0].decision, "creative-direction.foundation#visuals");
  assert.equal(s.editorial("adopt-visuals", p.data.proposalSha256).result.status, 0);
  assert.match(s.commit("adopt-visuals", p.data.proposalSha256).result.stderr, /authorization/);
  assert.equal(s.approve("adopt-visuals", p.data.proposalSha256,
    p.data.protectedChanges[0].id).result.status, 0);
  const committed = s.commit("adopt-visuals", p.data.proposalSha256);
  assert.equal(committed.result.status, 0, committed.result.stderr);
});

test("structural defects, surprise staging, and semantic review blocks prevent commits", { skip: SKIP }, () => {
  const broken = setup("invalid-structure");
  writeFileSync(broken.file, readFileSync(broken.file, "utf8").replace(
    'central_conflict: "Family loyalty against public truth."', "central_conflict: [invalid"));
  const invalid = broken.inspect("bad-yaml");
  assert.notEqual(invalid.result.status, 0);
  assert.match(invalid.result.stderr, /structural validation/i);
  assert.equal(git(broken.job.worktreeRoot, "rev-parse", "HEAD"), broken.initialSha);

  const staged = setup("staged");
  writeFileSync(staged.file, renderFoundation(draft("The sister is the murderer")));
  git(staged.job.worktreeRoot, "add", "--", "story/" + staged.target);
  assert.match(staged.inspect("staged-change").result.stderr, /staged/i);
  assert.equal(git(staged.job.worktreeRoot, "rev-parse", "HEAD"), staged.initialSha);

  const prose = setup("prose-conflict");
  writeFileSync(prose.file, readFileSync(prose.file, "utf8") +
    "\n## Contradictory draft\n\nThe brother is innocent and has never seen the victim.\n");
  const proposed = prose.inspect("editorial-block");
  assert.equal(proposed.result.status, 0, proposed.result.stderr);
  assert.equal(proposed.data.protectedChanges.length, 0, "metadata equality cannot prove prose consistency");
  assert.equal(prose.editorial("editorial-block", proposed.data.proposalSha256, "block").result.status, 0);
  assert.match(prose.commit("editorial-block", proposed.data.proposalSha256).result.stderr, /review/);
  assert.equal(git(prose.job.worktreeRoot, "rev-parse", "HEAD"), prose.initialSha);
});

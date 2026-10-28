import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-architecture-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(name: string, protectedDecision = false) {
  const repo = join(root, name);
  mkdirSync(join(repo, "story/creative-direction"), { recursive: true });
  const story = join(repo, "story");
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
${protectedDecision ? 'decisions:\n  - id: loyalty\n    statement: "Loyalty must matter"\n    origin: user\n    authority: user-protected' : "decisions: []"}
premise: "A witness disappears before an inquiry"
central_conflict: "Expose the truth or preserve a friendship"
genre: "Mystery"
tone: "Intimate"
player_experience: "Consequential conversations"
scope: "A compact dialogue-led story"
---

An investigator must decide what loyalty costs when a friend conceals evidence.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  const authorKey = generateKeyPairSync("ed25519");
  mkdirSync(join(repo, ".noveltea"), { recursive: true });
  writeFileSync(join(repo, ".noveltea/approval-author.pub"),
    authorKey.publicKey.export({ type: "spki", format: "pem" }));
  git(repo, "add", "."); git(repo, "commit", "-qm", "Foundation");
  const baseline = git(repo, "rev-parse", "HEAD");
  function cli(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
        NT_CONFIG_FILE: join(root, "absent.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
        NT_VALIDATOR_CACHE_DIR: join(root, "validators") },
    });
  }
  const started = cli("start"); assert.equal(started.status, 0, started.stderr);
  function signEvidence(payload: Record<string, unknown>) {
    const path = join(root, "signed-architecture-" + Math.random().toString(36).slice(2) + ".json");
    writeFileSync(path, JSON.stringify({ payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), authorKey.privateKey).toString("base64") }));
    return path;
  }
  return { repo, story, baseline, cli, job: JSON.parse(started.stdout), signEvidence };
}
function contract(name: string, kind = "partial", depth = "architecture") {
  const path = join(root, name + ".json");
  writeFileSync(path, JSON.stringify({ scope: { kind, depth, targets: [], branches: [] },
    constraints: ["Preserve the investigator's choice of loyalty"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: ["Reuse the inquiry room"], preferences: ["Small cast"] } }));
  return path;
}

test("public job builds planning-stage architecture and exposes its dependent realization obligations", { skip: !available }, () => {
  const { cli, job, repo, baseline } = setup("partial");
  const result = cli("architecture", "run", "--contract", contract("partial"), "--fixture", "--skills-source", source);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "complete-in-scope");
  assert.equal(data.plan.version, 1);
  assert.equal(data.plan.items[0].status, "verified");
  assert.match(data.plan.items[0].verifiedSha, /^[a-f0-9]{40}$/);
  assert.ok(data.plan.items.some((item: any) => item.kind === "realization" && item.dependencies.includes("global-architecture")));
  const realizeIds = data.plan.items.filter((item: any) => item.kind === "realization").map((item: any) => item.id);
  assert.deepEqual(data.plan.items.find((item: any) => item.kind === "review").dependencies, realizeIds);
  assert.ok(data.outstanding.some((item: any) => item.field === "fulfillment.any_of"));
  const files = git(job.worktreeRoot, "ls-files");
  assert.match(files, /arcs\//); assert.match(files, /milestones\//); assert.doesNotMatch(files, /events\//);
  assert.match(readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8"), /completeness: partial/);
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  const inspect = cli("architecture", "inspect");
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout).plan, data.plan);
  // Recovery from a completed receipt whose shared verified-head publication
  // was interrupted must restore the exact recorded commit, not repin a new one.
  const verifiedHeadFile = join(job.worktreeRoot, "../revisions/verified-head.json");
  unlinkSync(verifiedHeadFile);
  const replay = cli("architecture", "run", "--fixture");
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).plan.items[0].verifiedSha, data.plan.items[0].verifiedSha);
  assert.equal(JSON.parse(readFileSync(verifiedHeadFile, "utf8")).headSha, data.headSha);
});

function scopedContract(name: string, scope: { kind: string; depth: string; targets: string[]; branches: string[] }) {
  const path = join(root, name + "-scope.json");
  writeFileSync(path, JSON.stringify({ scope,
    constraints: ["Keep the player free to challenge the investigator"],
    envelope: { presentation: "Dialogue-first", hardLimits: ["One inquiry setting"],
      preferences: ["Reused backgrounds", "Sparse new character art"] } }));
  return path;
}

test("autonomous mode requires explicit scope; collaborative mode establishes it before any Story write", { skip: !available }, () => {
  const { cli, job } = setup("collaborative");
  const rejected = cli("architecture", "run", "--fixture");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /explicit --contract scope/);
  const pending = cli("architecture", "run", "--fixture", "--mode", "collaborative");
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, "awaiting-author");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  const accepted = cli("architecture", "run", "--fixture", "--mode", "collaborative",
    "--contract", contract("collaborative"), "--skills-source", source);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, "complete-in-scope");
});

test("full Story contract creates dependent DAG without falsely claiming whole-Story completion", { skip: !available }, () => {
  const { cli } = setup("full");
  const file = scopedContract("full", { kind: "full-story", depth: "composition", targets: [], branches: [] });
  const result = cli("architecture", "run", "--fixture", "--contract", file, "--skills-source", source);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "architecture-committed");
  assert.equal(data.completionEvidence.fullStory, false);
  const composition = data.plan.items.find((item: any) => item.kind === "composition");
  assert.ok(composition);
  assert.ok(composition.dependencies.some((id: string) => id.startsWith("realize-")));
  assert.ok(data.plan.items.some((item: any) => item.kind === "review"));
  assert.ok(data.plan.items.every((item: any) => item.planVersion === 1));
  const invalid = scopedContract("bad-full", { kind: "full-story", depth: "architecture", targets: [], branches: [] });
  const { cli: other } = setup("bad-full");
  const denied = other("architecture", "run", "--fixture", "--contract", invalid);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Full-Story scope requires composition depth/);
});

test("partial target and branch scope is durable and unauthorized scope shrinkage is rejected", { skip: !available }, () => {
  const { cli } = setup("targeted");
  const initial = scopedContract("targeted", {
    kind: "partial", depth: "architecture",
    targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route"],
  });
  const start = cli("architecture", "run", "--fixture", "--contract", initial, "--skills-source", source);
  assert.equal(start.status, 0, start.stderr);
  const result = JSON.parse(start.stdout);
  assert.deepEqual(result.plan.contract.scope.branches, ["trust-route"]);
  assert.equal(result.completionEvidence.branchExecution, "unverified");
  const smaller = scopedContract("targeted-smaller", {
    kind: "partial", depth: "architecture", targets: ["arc.truth"], branches: [],
  });
  const blocked = cli("architecture", "run", "--fixture", "--contract", smaller);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Unauthorized scope\/contract change/);
  const inspect = cli("architecture", "inspect");
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout).plan, result.plan);
});

test("exact explicit author approval versions the completion contract without rewriting verified canon", { skip: !available }, () => {
  const { cli, job } = setup("replan");
  const first = cli("architecture", "run", "--fixture", "--contract", contract("replan"), "--skills-source", source);
  assert.equal(first.status, 0, first.stderr);
  const sha = JSON.parse(first.stdout).headSha;
  const revised = scopedContract("replan-v2", {
    kind: "partial", depth: "architecture", targets: ["arc.truth", "milestone.disclosure"], branches: [],
  });
  const proposal = cli("architecture", "propose", "--contract", revised);
  assert.equal(proposal.status, 0, proposal.stderr);
  const digest = JSON.parse(proposal.stdout).proposal.digest;
  const invalid = cli("architecture", "approve", "--proposal", "0".repeat(64), "--reason", "Explicitly restrict targets");
  assert.notEqual(invalid.status, 0);
  const approval = cli("architecture", "approve", "--proposal", digest, "--reason", "Explicitly restrict targets");
  assert.equal(approval.status, 0, approval.stderr);
  assert.equal(JSON.parse(approval.stdout).plan.version, 2);
  const replay = cli("architecture", "run", "--fixture");
  assert.equal(replay.status, 0, replay.stderr);
  const data = JSON.parse(replay.stdout);
  assert.equal(data.status, "complete-in-scope");
  assert.equal(data.plan.version, 2);
  assert.equal(data.plan.items[0].verifiedSha, sha);
  assert.equal(data.history.length, 1);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), sha);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});


test("architecture follows a foundation generated from an empty Git baseline and enables later revision", { skip: !available }, () => {
  const name = "after-foundation";
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(repo, "README.txt"), "Initial repository without Story records\n");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Empty Story baseline");
  // Foundation uses the normal local skill configuration loader.
  writeFileSync(join(root, "absent.json"), "{}");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "absent.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validators") };
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
    "job", ...args, "--story", story, "--job", "draft"], {
    encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env,
  });
  const started = cli("start");
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  const foundation = cli("foundation", "--mode", "autonomous", "--fixture",
    "--task", "A mystery about a vanished librarian", "--skills-source", source);
  assert.equal(foundation.status, 0, foundation.stderr);
  assert.equal(JSON.parse(foundation.stdout).status, "committed");
  const arch = cli("architecture", "run", "--fixture", "--contract",
    contract("after-foundation"), "--skills-source", source);
  assert.equal(arch.status, 0, arch.stderr);
  const result = JSON.parse(arch.stdout);
  assert.equal(result.status, "complete-in-scope");
  const trusted = JSON.parse(readFileSync(join(job.worktreeRoot, "../revisions/verified-head.json"), "utf8"));
  assert.equal(trusted.headSha, result.headSha);
  assert.equal(trusted.workItemId, "global-architecture");
  const arcPath = join(job.worktreeStoryRoot, "arcs/truth.md");
  writeFileSync(arcPath, readFileSync(arcPath, "utf8") + "\nAdditional Arc interpretation.\n");
  const revision = cli("revision", "inspect", "--work-item", "refine-arc", "--path", "arcs/truth.md");
  assert.equal(revision.status, 0, revision.stderr);
});


test("architecture accepts a previously author-approved protected revision against the original base", { skip: !available }, () => {
  const { cli, job, baseline, repo, signEvidence } = setup("revised-before-architecture", true);
  const foundation = join(job.worktreeStoryRoot, "creative-direction/foundation.md");
  writeFileSync(foundation, readFileSync(foundation, "utf8").replace(
    'statement: "Loyalty must matter"', 'statement: "Loyalty can yield to truth"'));
  const inspected = cli("revision", "inspect", "--work-item", "adjust-loyalty",
    "--path", "creative-direction/foundation.md", "--validator-source", source);
  assert.equal(inspected.status, 0, inspected.stderr);
  const proposal = JSON.parse(inspected.stdout);
  assert.equal(proposal.protectedChanges.length, 1);
  const authorDecision = { ...proposal.authorSigningRequests.decisions[0],
    reason: "I expressly approve the precise revised loyalty decision" };
  const approved = cli("revision", "authorize", "--work-item", "adjust-loyalty",
    "--proposal", proposal.proposalSha256, "--signed-evidence", signEvidence(authorDecision));
  assert.equal(approved.status, 0, approved.stderr);
  const editorial = { ...proposal.authorSigningRequests.editorial,
    evidence: "creative-direction/foundation.md:1-25",
    notes: "I independently compared the revised decision with the established premise and prose." };
  const review = cli("revision", "review", "--work-item", "adjust-loyalty",
    "--proposal", proposal.proposalSha256, "--signed-evidence", signEvidence(editorial));
  assert.equal(review.status, 0, review.stderr);
  const revised = cli("revision", "commit", "--work-item", "adjust-loyalty",
    "--proposal", proposal.proposalSha256);
  assert.equal(revised.status, 0, revised.stderr);
  const beforeArchitecture = JSON.parse(revised.stdout).commitSha;
  const run = cli("architecture", "run", "--fixture", "--contract",
    contract("revised-before-architecture"), "--skills-source", source);
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "complete-in-scope");
  assert.notEqual(data.headSha, beforeArchitecture);
  assert.equal(JSON.parse(readFileSync(join(job.worktreeRoot, "../revisions/verified-head.json"), "utf8")).headSha,
    data.headSha);
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
});

test("approved scope expansion authors a new bounded cluster and retains the earlier committed records", { skip: !available }, () => {
  const { cli, job } = setup("expansion");
  const initial = cli("architecture", "run", "--fixture", "--contract", contract("expansion"),
    "--skills-source", source);
  assert.equal(initial.status, 0, initial.stderr);
  const oldSha = JSON.parse(initial.stdout).headSha;
  const revised = scopedContract("expansion-v2", {
    kind: "partial", depth: "architecture",
    targets: ["arc.second", "milestone.second"], branches: [],
  });
  const proposed = cli("architecture", "propose", "--contract", revised);
  assert.equal(proposed.status, 0, proposed.stderr);
  const approved = cli("architecture", "approve", "--proposal",
    JSON.parse(proposed.stdout).proposal.digest, "--reason", "Add a bounded second arc and milestone");
  assert.equal(approved.status, 0, approved.stderr);
  const second = cli("architecture", "run", "--fixture");
  assert.equal(second.status, 0, second.stderr);
  const data = JSON.parse(second.stdout);
  assert.equal(data.status, "complete-in-scope");
  assert.equal(data.plan.version, 2);
  assert.notEqual(data.headSha, oldSha);
  assert.equal(data.plan.items[0].verifiedSha, data.headSha);
  assert.deepEqual(data.plan.items[0].targetIds, ["arc.second", "milestone.second"]);
  for (const path of ["arcs/truth.md", "milestones/disclosure.md", "arcs/second.md", "milestones/second.md"]) {
    assert.equal(existsSync(join(job.worktreeStoryRoot, path)), true);
  }
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

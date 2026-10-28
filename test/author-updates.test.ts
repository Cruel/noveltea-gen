import assert from "node:assert/strict";
import { createHash, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-author-updates-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
function git(cwd: string, ...args: string[]) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
}
function setup(name: string, signed = false, protectedDecision = false) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  if (!signed) writeFileSync(join(story, "README.md"), "An unfinished author Story\n");
  const authorKey = signed ? generateKeyPairSync("ed25519") : undefined;
  if (authorKey) {
    mkdirSync(join(repo, ".noveltea"), { recursive: true });
    writeFileSync(join(repo, ".noveltea/approval-author.pub"),
      authorKey.publicKey.export({ type: "spki", format: "pem" }));
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A vanished witness"
status: draft
decisions: []
premise: "A witness disappears before the hearing"
central_conflict: "Justice or personal loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Consequential dialogue"
scope: "A small interactive mystery"
---

The witness disappears and no one agrees why.
`);
    if (protectedDecision) {
      const path = join(story, "creative-direction/foundation.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("decisions: []",
        "decisions:\n  - id: witness\n    statement: \"The witness must survive\"\n    origin: user\n    authority: user-protected"));
    }
  }
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author baseline");
  const base = git(repo, "rev-parse", "HEAD"), state = join(root, name + "-state");
  if (signed) writeFileSync(join(root, name + "-config.json"), JSON.stringify({
    novelteaSkills: resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"),
    skillDiscovery: "explicit-only", requiredSkills: ["nt-catalog"], skillDirs: [],
  }));
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", ...args, "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 90000, env: { ...process.env, NT_STATE_DIR: state,
        NT_CONFIG_FILE: join(root, name + "-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
        NT_VALIDATOR_CACHE_DIR: join(root, "validators") },
    });
  const ok = (result: ReturnType<typeof run>): any => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const job = ok(run("start"));
  let ordinal = 0;
  const file = (value: unknown) => {
    const location = join(root, name + "-input-" + ordinal++ + ".json");
    writeFileSync(location, JSON.stringify(value));
    return location;
  };
  const send = (value: unknown) => ok(run("author", "send", "--file", file(value)));
  const inspect = () => ok(run("author", "inspect"));
  const processUpdates = () => ok(run("author", "process"));
  const idea = (text: string) => ({
    kind: "event-concept",
    source: { kind: "author-continuation", reference: "author chat" },
    original: text,
    requirements: { meaning: [{ text: "Confrontation changes trust", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: ["witness"] },
    prerequisites: [], placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  });
  return { repo, story, base, state, job, run, ok, file, send, inspect, process: processUpdates, idea, authorKey };
}

test("multiple queued ideas produce exactly one separate captured commit each, with stable acknowledgements across processes", () => {
  const x = setup("queued");
  const first = { id: "message-alpha", kind: "idea", payload: x.idea("The witness falls silent") };
  assert.equal(x.send(first).phase, "queued");
  assert.equal(x.send(first).phase, "queued");
  assert.equal(x.send({ id: "message-beta", kind: "idea", payload: x.idea("The confession contradicts the diary") }).phase, "queued");
  assert.equal(x.inspect().records.length, 2);
  const pass = x.process();
  assert.equal(pass.status, "ready");
  assert.deepEqual(pass.processed.map((r: any) => r.phase), ["applied", "applied"]);
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "2");
  const oldHead = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(x.process().processed.length, 0);
  assert.equal(x.send(first).phase, "applied");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(readdirSync(join(x.job.worktreeStoryRoot, ".story-inbox/ideas")).length, 2);
  assert.equal(x.inspect().records.every((r: any) => r.acknowledgement.phase === "applied"), true);
});

test("foundation generation processes queued author ideas automatically before its next safe writing assignment", {
  skip: !existsSync(join(resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"), "src/cli.ts")),
}, () => {
  const x = setup("boundary", true);
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  x.send({ id: "idea-before-foundation", kind: "idea",
    payload: x.idea("An unplaced scene the foundation writer must not see") });
  const run = x.ok(x.run("foundation", "--fixture", "--mode", "autonomous",
    "--task", "The missing witness must be found", "--skills-source", source,
    "--validator-source", source));
  assert.equal(run.status, "committed");
  assert.equal(x.inspect().records[0].acknowledgement.phase, "applied");
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "2");
  assert.equal(git(x.job.worktreeRoot, "log", "-2", "--format=%B").includes("NovelTea-Work-Item: idea-capture"), true);
  assert.doesNotMatch(readFileSync(join(x.job.worktreeStoryRoot,
    "creative-direction/foundation.md"), "utf8"), /unplaced scene the foundation writer must not see/i);
});

test("message submission succeeds during a live writer lock, but processing cannot preempt it", () => {
  const x = setup("active-writer");
  const lock = join(x.job.worktreeRoot, "..", ".story-job-running");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    version: 1, jobId: "draft", pid: process.pid, host: hostname(), nonce: randomUUID(),
    workItem: "pi-writer",
  }));
  x.send({ id: "while-writing", kind: "idea", payload: x.idea("Live idea held for next boundary") });
  assert.equal(x.inspect().records[0].acknowledgement.phase, "queued");
  const blocked = x.run("author", "process");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already owned|simultaneous/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  rmSync(lock, { recursive: true, force: true });
  assert.equal(x.process().processed[0].phase, "applied");
});

test("LangGraph question interrupt persists across processes and only typed explicit resume releases it", () => {
  const x = setup("question");
  x.send({ id: "question-structure", kind: "question", payload: { question: "Should the witness be trusted?" } });
  const first = x.process();
  assert.equal(first.status, "blocked");
  assert.deepEqual(first.blockers, ["awaiting-author:question-structure"]);
  assert.equal(x.inspect().records[0].acknowledgement.phase, "awaiting-author");
  const savedGraph = join(x.job.worktreeRoot, "..", "author-updates", "checkpoints.sqlite");
  assert.equal(existsSync(savedGraph), true);
  x.send({ id: "second-idea", kind: "idea", payload: x.idea("Another thought from the author") });
  assert.equal(x.process().status, "blocked");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  const rejected = x.run("author", "resume", "--file", x.file({
    type: "answer", messageId: "wrong-question", answer: "No" }));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /missing|different|wrong/i);
  const malformed = x.run("author", "resume", "--file", x.file({
    type: "answer", messageId: "question-structure", answer: "" }));
  assert.notEqual(malformed.status, 0);
  const resumed = x.ok(x.run("author", "resume", "--file", x.file({
    type: "answer", messageId: "question-structure", answer: "Leave it ambiguous." })));
  assert.equal(resumed.phase, "applied");
  assert.equal(resumed.result.answer, "Leave it ambiguous.");
  assert.equal(x.process().processed[0].phase, "applied");
  assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", x.base + "..HEAD"), "1");
  assert.equal(x.ok(x.run("author", "resume", "--file", x.file({
    type: "answer", messageId: "question-structure", answer: "Leave it ambiguous." }))).phase, "applied");
});

test("pause/cancel/completion execution controls are distinct from narrative messages", () => {
  const x = setup("controls");
  x.send({ id: "idea-paused", kind: "idea", payload: x.idea("Unacted idea") });
  assert.equal(x.ok(x.run("author", "control", "--state", "paused")).status, "paused");
  assert.equal(x.process().status, "paused");
  const writing = x.run("foundation", "--fixture", "--mode", "autonomous", "--task", "Investigate a mystery");
  assert.notEqual(writing.status, 0);
  assert.match(writing.stderr, /cannot advance|paused/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  assert.equal(x.inspect().records[0].acknowledgement.phase, "queued");
  assert.equal(x.ok(x.run("author", "control", "--state", "running")).status, "running");
  assert.equal(x.process().status, "ready");
  assert.equal(x.ok(x.run("author", "control", "--state", "cancelled")).status, "cancelled");
  assert.equal(x.run("author", "send", "--file", x.file({
    id: "after-cancel", kind: "idea", payload: x.idea("Not consumed") })).status !== 0, true);
  assert.notEqual(x.run("author", "control", "--state", "running").status, 0);
  const y = setup("completion");
  y.ok(y.run("author", "control", "--state", "completed"));
  assert.equal(y.process().status, "completed");
});

test("consequential direct changes create durable scope impact review, not silent changes or autonomous replan", () => {
  const x = setup("review");
  const request = { id: "plan-review", kind: "change",
    payload: { text: "Make the reveal happen in a new Arc instead",
      affectedIds: ["arc.truth"], proposedContract: undefined } };
  x.send(request);
  const result = x.process();
  assert.equal(result.status, "blocked");
  assert.equal(result.processed[0].phase, "review-required");
  assert.equal(result.processed[0].result.review, "unverified");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  assert.equal(x.process().processed.length, 0, "review does not replay or apply without authorization");
  assert.equal(x.inspect().records[0].acknowledgement.phase, "review-required");
});

test("consequential change proposes a versioned scope replan and resolves only after signed author approval", {
  skip: !existsSync(join(resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"), "src/cli.ts")),
}, () => {
  const x = setup("scope-impact", true);
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  const originalContract = { scope: { kind: "partial", depth: "architecture",
    targets: [] as string[], branches: [] as string[] },
    constraints: ["Preserve the investigator's agency"],
    envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
  const architecture = x.ok(x.run("architecture", "run", "--fixture",
    "--contract", x.file(originalContract), "--skills-source", source));
  const proposedContract = { ...originalContract,
    constraints: ["Preserve the investigator's agency", "The suspect may refuse the hearing"] };
  x.send({ id: "route-impact", kind: "change", payload: {
    text: "Add a route allowing the suspect to refuse the hearing",
    affectedIds: ["arc.truth"],
  } });
  const reviewed = x.process();
  assert.equal(reviewed.status, "blocked");
  assert.equal(reviewed.processed[0].phase, "review-required");
  assert.equal(reviewed.processed[0].result.proposal, undefined);
  const planned = x.ok(x.run("author", "plan", "--id", "route-impact",
    "--file", x.file(proposedContract)));
  const proposal = planned.result.proposal.proposal;
  assert.equal(proposal.version, 2);
  assert.equal(x.ok(x.run("architecture", "inspect")).plan.version, 1);
  x.send({ id: "route-approval", kind: "approval", payload: {
    requestType: "plan", proposalSha256: proposal.digest,
  } });
  const paused = x.process();
  assert.deepEqual(paused.blockers.includes("awaiting-author:route-approval"), true);
  const details = x.ok(x.run("architecture", "inspect"));
  const signed = { ...details.authorSigningRequest,
    reason: "I have read and independently approved the new route and the scope it changes." };
  const signedEvidence = { payload: signed,
    signature: sign(null, Buffer.from(JSON.stringify(signed)), x.authorKey!.privateKey).toString("base64") };
  assert.equal(x.ok(x.run("author", "resume", "--file", x.file({
    type: "decision", messageId: "route-approval", signedEvidence,
  }))).phase, "applied");
  assert.equal(x.ok(x.run("architecture", "inspect")).plan.version, 2);
  assert.equal(x.inspect().records.find((entry: any) => entry.message.id === "route-impact")
    .acknowledgement.phase, "applied");
  assert.equal(x.process().status, "ready");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), architecture.headSha);
});

test("signed author approval resumes the exact LangGraph interrupt and applies versioned architecture plan", {
  skip: !existsSync(join(resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"), "src/cli.ts")),
}, () => {
  const x = setup("signed-plan", true);
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  const baseContract = { scope: { kind: "partial", depth: "architecture",
    targets: [] as string[], branches: [] as string[] },
    constraints: ["Respect the witness's free choice"],
    envelope: { presentation: "Dialogue", hardLimits: [], preferences: ["Small cast"] } };
  const first = x.ok(x.run("architecture", "run", "--contract", x.file(baseContract),
    "--fixture", "--skills-source", source));
  assert.equal(first.plan.version, 1);
  const updatedContract = { ...baseContract,
    constraints: ["Respect the witness's free choice", "Allow an alternative route"] };
  const proposed = x.ok(x.run("architecture", "propose", "--contract", x.file(updatedContract)));
  assert.equal(proposed.proposal.version, 2);
  const proposalSha256 = proposed.proposal.digest;
  x.send({ id: "plan-signature", kind: "approval", payload: {
    requestType: "plan", proposalSha256,
  } });
  assert.equal(x.process().status, "blocked");
  const request = { ...proposed.authorSigningRequest,
    reason: "I have reviewed the new narrative route and approve its scope." };
  const signedEvidence = { payload: request,
    signature: sign(null, Buffer.from(JSON.stringify(request)), x.authorKey!.privateKey).toString("base64") };
  const response = { type: "decision", messageId: "plan-signature", signedEvidence };
  const result = x.ok(x.run("author", "resume", "--file", x.file(response)));
  assert.equal(result.phase, "applied");
  assert.equal(result.result.action, "signed-plan-approval");
  const current = x.ok(x.run("architecture", "inspect"));
  assert.equal(current.plan.version, 2);
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].proposal, proposalSha256);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), first.headSha);
  const again = x.ok(x.run("author", "resume", "--file", x.file(response)));
  assert.equal(again.phase, "applied");
  assert.equal(x.ok(x.run("architecture", "inspect")).history.length, 1);
  // Simulate a crash after signed plan application but before the update
  // acknowledgement was published; the original signature recovers it.
  const receiptFile = join(x.job.worktreeRoot, "..", "author-updates/receipts/plan-signature.json");
  const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
  writeFileSync(receiptFile, JSON.stringify({ ...saved, phase: "awaiting-author" }));
  const recovered = x.ok(x.run("author", "resume", "--file", x.file(response)));
  assert.equal(recovered.phase, "applied");
  assert.equal(x.ok(x.run("architecture", "inspect")).history.length, 1);
});

test("an exact signed protected-decision approval resumes its own graph gate without committing prose", {
  skip: !existsSync(join(resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"), "src/cli.ts")),
}, () => {
  const x = setup("signed-decision", true, true);
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  const target = join(x.job.worktreeStoryRoot, "creative-direction/foundation.md");
  writeFileSync(target, readFileSync(target, "utf8").replace(
    "The witness must survive", "The witness may disappear permanently"));
  const proposed = x.ok(x.run("revision", "inspect", "--work-item", "change-witness",
    "--path", "creative-direction/foundation.md", "--validator-source", source));
  assert.equal(proposed.protectedChanges.length, 1);
  const change = proposed.protectedChanges[0];
  x.send({ id: "sign-witness", kind: "approval", payload: {
    requestType: "decision", workItemId: "change-witness",
    changeId: change.id, proposalSha256: proposed.proposalSha256,
  } });
  assert.equal(x.process().status, "blocked");
  const invalid = x.run("author", "resume", "--file", x.file({
    type: "decision", messageId: "sign-witness",
    signedEvidence: { payload: { kind: "decision" }, signature: "not-signed" },
  }));
  assert.notEqual(invalid.status, 0);
  assert.equal(x.inspect().records[0].acknowledgement.phase, "awaiting-author");
  const payload = { ...proposed.authorSigningRequests.decisions[0],
    reason: "I independently reviewed this exact protected witness outcome change." };
  const signedEvidence = { payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), x.authorKey!.privateKey).toString("base64") };
  const response = x.ok(x.run("author", "resume", "--file", x.file({
    type: "decision", messageId: "sign-witness", signedEvidence,
  })));
  assert.equal(response.phase, "applied");
  const review = x.ok(x.run("revision", "status", "--work-item", "change-witness",
    "--proposal", proposed.proposalSha256));
  assert.equal(review.authorApprovals.length, 1);
  assert.equal(review.authorApprovals[0].source, "author-ed25519");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain").includes("creative-direction/foundation.md"), true);
});

test("approval gate rejects unsigned or mismatched responses without advancing the work item", () => {
  const x = setup("approval");
  const proposalSha256 = createHash("sha256").update("proposal").digest("hex");
  x.send({ id: "approve-specific", kind: "approval", payload: {
    requestType: "decision", proposalSha256, workItemId: "modify-one",
    changeId: createHash("sha256").update("change").digest("hex") } });
  const blocked = x.run("author", "process");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /no existing revision proposal/i);
  assert.equal(x.inspect().records[0].acknowledgement.phase, "queued",
    "nonexistent proposals cannot create an approval interrupt");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { PostcommitReviewCycle } from "../src/postcommit-review-cycle.js";
import type { SemanticReviewPacket, SemanticVerdict } from "../src/semantic-assignment-review.js";
import { beginProtocolInvocation, inspectCompletedProtocolResponse } from "../src/response-contract-recovery.js";
import { postcommitDiagnosticAdmission, parsePostcommitDiagnosis,
  savePostcommitDiagnosis, readPostcommitDiagnosis, foundationDiagnosticReason } from "../src/postcommit-repair-diagnostic.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (n: number) => n.toString(16).padStart(40, "0");

function fixture(t: import("node:test").TestContext, rounds = 3) {
  const stateDir = mkdtempSync(join(tmpdir(), "nt211-diagnostic-"));
  t.after(() => removeTestTree(stateDir));
  const job = { stateDir, jobId: randomUUID(), threadId: randomUUID(),
    baseSha: sha(9) } as JobStartResult;
  const current = sha(rounds);
  const packet = {
    policy: "assignment-fidelity/v1", sourceDigest: hash("current:" + current),
    items: [{
      assurance: { commitSha: current, assignmentDigest: hash("authorized assignment"),
        turnDigest: hash("turn") },
      priorNegative: { sourceCommitSha: sha(rounds-1), rootFailureSha: sha(1),
        reviewDigest: hash("negative"), findings: [], completedCorrections: rounds-1 },
      assignment: { id: "event:arrival", specialist: "nt-event-design",
        outcome: "The Event must establish a credible witness timeline.",
        targets: ["event.arrival"] },
      unitOutcome: "Preserve the evidence-backed arrival outcome.",
      canonicalContext: [{
        path: "events/arrival.md", content: "The witness entered the station at dawn."
      }],
    }],
  } as unknown as SemanticReviewPacket;
  const verdict = { sourceDigest: packet.sourceDigest, verdict: "fail",
    findings: [{ path: "events/arrival.md", message: "Missing timestamp" }],
    evidence: [] } as unknown as SemanticVerdict;
  const cycle = {
    version: 1, id: hash("cycle"), jobId: job.jobId, threadId: job.threadId,
    baseSha: job.baseSha, rootSha: sha(1), assignmentDigest: hash("authorized assignment"),
    turnDigest: hash("turn"), snapshot: { id: hash("snapshot"), path: "/pinned" },
    provider: "openai", model: "gpt-6", reviewer: {
      id: randomUUID(), file: "/some-other-read-only-pi-session",
    },
    rounds: Array.from({ length: rounds }, (_, index) => ({
      commitSha: sha(index+1),
      packetDigest: index === rounds-1 ? packet.sourceDigest : hash("packet"+index),
      verdictDigest: index === rounds-1 ? hash(verdict) : hash("verdict"+index),
      transcriptBytes: index+1, transcriptDigest: hash("session"+index),
    })),
  } as PostcommitReviewCycle;
  const admission = postcommitDiagnosticAdmission(job, cycle, packet, verdict);
  return { job, packet, verdict, cycle, admission };
}
function recommendation(sourceDigest: string, action = "continue") {
  return {
    schema: "noveltea-postcommit-diagnosis/v1", sourceDigest, action,
    explanation: "The remaining finding requires independent evidence of the timeline.",
    assessments: [{
      kind: "material",
      reason: "The current witness line does not establish the timing clearly.",
      requirement: { quote: "credible witness timeline" },
      evidence: { path: "events/arrival.md",
        quote: "The witness entered the station at dawn." },
    }],
  };
}

test("postcommit diagnostic is advisory at two corrections and soft later depths, never a cap", t => {
  for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10]) {
    const { job, packet, verdict, cycle } = fixture(t, n);
    const admitted = postcommitDiagnosticAdmission(job, cycle, packet, verdict);
    assert.equal(admitted?.reason ?? null, n === 3 ? "reassessment" :
      [5, 9].includes(n) ? "review-depth" : null);
  }
});

test("Foundation progress follows sealed Git and reviewer evidence rather than round count", async t => {
  const { job, cycle } = fixture(t);
  const root = join(job.stateDir, "story");
  const path = "creative-direction/foundation.md";
  mkdirSync(join(root, dirname(path)), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  job.worktreeRoot = root;
  job.storyRelativePath = "";
  cycle.reviewer.file = join(job.stateDir, "review.jsonl");
  cycle.rounds = [];
  const revise = async (content: string, status?: "material" | "stalled", citation = content.trim()) => {
    writeFileSync(join(root, path), content);
    git("add", path);
    git("commit", "-qm", "Revision");
    const commitSha = git("rev-parse", "HEAD");
    const sourceDigest = hash(commitSha);
    const verdict = {
      sourceDigest, verdict: "fail", findings: [{ path, message: "Resolve the witness motivation." }],
      evidence: [],
      ...(status ? { progressDiagnosis: { status, reason: "The independent reviewer compared the changed source.",
        evidence: status === "material" ? { path, quote: citation } : null } } : {}),
    };
    appendFileSync(cycle.reviewer.file, JSON.stringify({ type: "message", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(verdict) }],
    } }) + "\n");
    const bytes = readFileSync(cycle.reviewer.file);
    cycle.rounds.push({ commitSha, packetDigest: sourceDigest, verdictDigest: hash(verdict),
      transcriptBytes: bytes.length, transcriptDigest: createHash("sha256").update(bytes).digest("hex") });
    return foundationDiagnosticReason(job, cycle, [path]);
  };
  assert.equal(await revise("A witness arrives.\n"), null);
  assert.equal(await revise("The witness seeks her lost brother.\n", "material"), null);
  assert.equal(await revise("The witness seeks her lost brother and fears arrest.\n", "material"), null);
  assert.equal(await revise("The witness seeks her lost brother and fears arrest. She has a red coat.\n", "stalled"), null);
  assert.equal(await revise("The witness seeks her lost brother and fears arrest. She has a blue coat.\n", "stalled"), "reassessment");
  assert.equal(await foundationDiagnosticReason(job, cycle, [path]), "reassessment", "restart derives the same disposition");
  assert.equal(await revise("The witness seeks her lost brother.\n", "material"), "reassessment", "oscillation is not improvement");
  assert.equal(await revise("The witness seeks her brother because he holds the key.\n", "material"), null);
  await assert.rejects(revise("The witness holds a map.\n", "material", "fabricated changed line"), /changed canonical citation/);
});

test("Diagnostic citations are literal and two unrelated issues in one file need no stable IDs", t => {
  const { packet, admission } = fixture(t);
  assert.ok(admission);
  const value = recommendation(admission.sourceDigest);
  assert.deepEqual(parsePostcommitDiagnosis(JSON.stringify(value), admission, packet), value);
  assert.throws(() => parsePostcommitDiagnosis(JSON.stringify({
    ...value, sourceDigest: hash("other"),
  }), admission, packet), /bounded independent reassessment/);
  assert.throws(() => parsePostcommitDiagnosis(JSON.stringify({
    ...value, assessments: [{ ...value.assessments[0],
      evidence: { path: "events/arrival.md", quote: "Fabricated citation" } }],
  }), admission, packet), /literal current-source/);
  assert.throws(() => parsePostcommitDiagnosis(JSON.stringify({
    ...value, assessments: [{ ...value.assessments[0],
      requirement: { quote: "Invent a new narrative obligation" } }],
  }), admission, packet), /literal current-source/);
});

test("completed independent Diagnostic recovers original transcript and fails closed on tampering", async t => {
  const { job, cycle, packet, verdict, admission } = fixture(t);
  assert.ok(admission);
  const identity = randomUUID();
  const file = join(job.stateDir, "review-sessions", "assignment-diagnostic", "original.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session", id: identity }) + "\n");
  const session = { sessionId: identity, sessionManager: { getSessionFile: () => file },
    messages: [], getActiveToolNames: () => [], setActiveToolsByName: () => {} };
  await beginProtocolInvocation({ receiptFile: admission.protocolRoot,
    sourceDigest: admission.sourceDigest, contract: admission.contract, session });
  const diagnosis = recommendation(admission.sourceDigest, "replace");
  appendFileSync(file, JSON.stringify({ type: "message", message: {
    role: "user", content: [{ type: "text", text: "Read-only Diagnostic request" }],
  } }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "message", message: {
    role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify(diagnosis) }],
  } }) + "\n");
  const restore = () => inspectCompletedProtocolResponse({
    receiptFile: admission.protocolRoot, sourceDigest: admission.sourceDigest,
    contract: admission.contract,
    sessionRoots: [join(job.stateDir, "review-sessions", "assignment-diagnostic")],
    validate: text => { try { parsePostcommitDiagnosis(text, admission, packet); return []; }
      catch { return [{ path: "diagnostic", expected: "source bound" }]; } },
    parse: text => parsePostcommitDiagnosis(text, admission, packet),
  });
  assert.deepEqual(await restore(), diagnosis);
  assert.deepEqual(await restore(), diagnosis, "restart must reuse accepted model response");
  await savePostcommitDiagnosis(job, cycle, packet, verdict, admission, diagnosis as any);
  assert.equal((await readPostcommitDiagnosis(job, cycle, packet.items[0]!.assurance.commitSha))?.diagnosis.action,
    "replace", "Diagnostic cannot make the failed Story checkpoint pass");
  const receipt = join(job.stateDir, "postcommit-diagnostics", cycle.id,
    packet.items[0]!.assurance.commitSha + ".outcome.json");
  const previous = JSON.parse(readFileSync(receipt, "utf8"));
  previous.diagnosis.action = "continue";
  writeFileSync(receipt, JSON.stringify(previous));
  await assert.rejects(() => readPostcommitDiagnosis(job, cycle,
    packet.items[0]!.assurance.commitSha), /tampered/);
});

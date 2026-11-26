import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderFoundation } from "../src/foundation-record.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { FoundationDraft } from "../src/foundation-record.js";
import { pinChatApprovedFoundation, readChatApprovedFoundation } from "../src/chat-approved-foundation.js";
import { reusableExistingFoundation } from "../src/foundation-readiness.js";

const foundation: FoundationDraft = {
  id: "foundation", title: "The Last Bell", premise: "A missing bell",
  central_conflict: "A divided town", genre: "Mystery", tone: "Somber",
  player_experience: "Choose whom to trust", scope: "Coastal town",
  body: "A mystery unfolds.", decisions: [{
    id: "missing-bell", statement: "The bell vanished.", origin: "user",
    authority: "user-protected",
  }],
};

test("Chat foundation receipt is immutable, source-pinned and safe across retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-approved-chat-"));
  const job = { stateDir: root, jobId: "job-one", baseSha: "a".repeat(40) } as JobStartResult;
  const input = {
    jobId: job.jobId, sourceSha: job.baseSha, firstTurnId: "job-one",
    originalObjective: "Make a mystery game", scope: "whole-story" as const, proposalDigest: "b".repeat(64),
    skillId: "c".repeat(64), foundation, creativeMode: "collaborative" as const,
    provider: "openai", model: "gpt-6-luna",
  };
  try {
    assert.equal(await readChatApprovedFoundation(job), null);
    await pinChatApprovedFoundation(job, input);
    await pinChatApprovedFoundation(job, input);
    const receipt = await readChatApprovedFoundation(job);
    assert.equal(receipt?.originalObjective, input.originalObjective);
    assert.equal(receipt?.foundation.decisions[0]?.authority, "user-protected");
    assert.match(receipt!.authoredSha256, /^[a-f0-9]{64}$/);
    await assert.rejects(() => pinChatApprovedFoundation(job, {
      ...input, foundation: { ...foundation, title: "Different Story" },
    }), /different approved Creative Direction/);
    await assert.rejects(() => pinChatApprovedFoundation(job, {
      ...input, sourceSha: "e".repeat(40),
    }), /identity is invalid/);
    writeFileSync(join(root, "chat-approved-foundation.json"),
      JSON.stringify({ ...receipt, originalObjective: "silently changed" }));
    await assert.rejects(() => pinChatApprovedFoundation(job, input),
      /different approved Creative Direction/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R14 obsolete draft-status approval cannot authorize execution or be silently repinned", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-legacy-chat-"));
  const job = { stateDir: root, jobId: "job-legacy", baseSha: "a".repeat(40) } as JobStartResult;
  const approval = {
    jobId: job.jobId, sourceSha: job.baseSha, firstTurnId: job.jobId,
    originalObjective: "Keep the previous approval", scope: "whole-story" as const,
    proposalDigest: "b".repeat(64), skillId: "c".repeat(64), foundation,
    creativeMode: "autonomous" as const, provider: "openai", model: "gpt-6",
  };
  const legacy = {
    ...approval, version: 1, authoredSha256: createHash("sha256")
      .update(renderFoundation(foundation)).digest("hex"),
  };
  try {
    const path = join(root, "chat-approved-foundation.json");
    const bytes = JSON.stringify(legacy);
    writeFileSync(path, bytes);
    await assert.rejects(() => readChatApprovedFoundation(job), /differs from its pinned Story foundation/);
    await assert.rejects(() => pinChatApprovedFoundation(job, approval), /differs from its pinned Story foundation/);
    assert.equal(readFileSync(path, "utf8"), bytes, "preserve obsolete evidence without upgrading it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Only native-verified existing Creative Direction can bypass the foundation writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-foundation-reuse-"));
  try {
    mkdirSync(join(root, "creative-direction"));
    const path = join(root, "creative-direction", "foundation.md");
    const result = {
      status: "passed",
      report: {
        readiness: { design: { stages: { foundation: { minimum: "passed" } } } },
        protection: { status: "checked", changes: [], warnings: [] },
        records: [{ path: "creative-direction/foundation.md",
          metadata: { type: "creative-direction", status: "draft" } }],
      },
    };
    writeFileSync(path, "Pending author discovery");
    assert.equal(await reusableExistingFoundation({ worktreeStoryRoot: root }, result), false);
    writeFileSync(path, "Approved mystery direction with author-protected choices");
    assert.equal(await reusableExistingFoundation({ worktreeStoryRoot: root }, result), true);
    assert.equal(await reusableExistingFoundation({ worktreeStoryRoot: root }, {
      ...result, report: { ...result.report,
        protection: { status: "checked", changes: [{ path }], warnings: [] } },
    }), false);
    assert.equal(await reusableExistingFoundation({ worktreeStoryRoot: root }, {
      ...result, report: { ...result.report,
        records: [...result.report.records, ...result.report.records] },
    }), false);
    assert.equal(await reusableExistingFoundation({ worktreeStoryRoot: root },
      { ...result, status: "unverified" }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("materialized approval permits body-only correction but never a status or decision change", async () => {
  const {assertChatFoundationBodyOnly}=await import("../src/chat-approved-foundation.js");
  const original=renderFoundation(foundation,"approved");
  assert.doesNotThrow(()=>assertChatFoundationBodyOnly(original,renderFoundation({...foundation,body:"A concrete clue is shown."},"approved")));
  assert.throws(()=>assertChatFoundationBodyOnly(original,renderFoundation(foundation,"draft")),/approved metadata/);
  assert.throws(()=>assertChatFoundationBodyOnly(original,renderFoundation({...foundation,decisions:[]},"approved")),/protected decisions/);
});

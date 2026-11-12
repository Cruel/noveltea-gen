import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import type { StoryOrchestratorSelection } from "../src/orchestrator-selection.js";
import { planWholeStory, planRevision } from "../web/src/lib/turn-plan.js";
import {
  verifyOrchestratorProposal,
  readPinnedObjectivePlanning,
  restoreCheckpointedObjectivePlanning,
  type OrchestratorPlanningReceipt,
} from "../src/orchestrator-planner.js";
import { nextExecutionItem, type GenerationInventory } from "../src/generation-plan.js";

const a = "a".repeat(40);
const contract = {
  scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
  constraints: [],
  envelope: { presentation: "Interactive visual novel", hardLimits: [], preferences: [] },
};
const plan = planWholeStory("Make me a mystery game", contract, a);
const proposal = {
  sourceSha: a,
  turnDigest: plan.digest,
  assignments: plan.assignments.map((item) => ({
    id: item.id,
    reason: "Grounded in pinned canonical author objective",
  })),
};

test("read-only orchestrator must return exact source-bound assignments and causal order", () => {
  assert.deepEqual(verifyOrchestratorProposal(proposal, plan), proposal);
  assert.throws(
    () => verifyOrchestratorProposal({ ...proposal, sourceSha: "b".repeat(40) }, plan),
    /source or authorized/i,
  );
  assert.throws(
    () => verifyOrchestratorProposal({ ...proposal, turnDigest: "f".repeat(64) }, plan),
    /source or authorized/i,
  );
  assert.throws(
    () => verifyOrchestratorProposal({ ...proposal, assignments: proposal.assignments.slice(1) }, plan),
    /source or authorized/i,
  );
  assert.throws(
    () =>
      verifyOrchestratorProposal(
        {
          ...proposal,
          assignments: [
            ...proposal.assignments.slice(0, 1),
            { id: "plot-expansion", reason: "Add a subplot" },
            ...proposal.assignments.slice(2),
          ],
        },
        plan,
      ),
    /unauthorized/i,
  );
  assert.throws(
    () =>
      verifyOrchestratorProposal(
        {
          ...proposal,
          assignments: proposal.assignments.map((item, i) =>
            i === 1 ? { ...item, id: "foundation" } : item,
          ),
        },
        plan,
      ),
    /duplicate/i,
  );
  assert.throws(
    () =>
      verifyOrchestratorProposal(
        {
          ...proposal,
          assignments: [proposal.assignments[1], proposal.assignments[0], ...proposal.assignments.slice(2)],
        },
        plan,
      ),
    /dependency-inverted/i,
  );
  assert.throws(
    () =>
      verifyOrchestratorProposal(
        {
          ...proposal,
          assignments: proposal.assignments.map((item, i) => (i === 0 ? { ...item, reason: "" } : item)),
        },
        plan,
      ),
    /unauthorized/i,
  );
});

test("signed planning receipt survives reconnect and rejects tampering, source and skill drift", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-objective-plan-"));
  try {
    const job = { stateDir, jobId: "job-owner", threadId: "thread-owner", baseSha: a } as JobStartResult;
    const snapshot = { id: "b".repeat(64), path: join(stateDir, "snapshot") };
    const selection = {
      receipt: { skillEntrypointSha256: "c".repeat(64), skillSnapshot: snapshot },
    } as StoryOrchestratorSelection;
    const reads = [
      "nt-story-orchestrate/SKILL.md",
      "nt-story-orchestrate/references/planning.md",
      "nt-catalog/SKILL.md",
      "nt-catalog/references/records.md",
      "nt-catalog/references/progression.md",
      "nt-catalog/references/authority-and-validation.md",
    ].map((path) => join(snapshot.path, "skills", path));
    const body = {
      schema: "noveltea-objective-planning/v1" as const,
      jobId: job.jobId,
      threadId: job.threadId,
      sourceSha: a,
      turnDigest: plan.digest,
      methodSha256: selection.receipt.skillEntrypointSha256,
      snapshotId: snapshot.id,
      provider: "openai",
      model: "gpt-6-luna",
      phase: "planned" as const,
      sessionFile: join(stateDir, "transcript.jsonl"),
      proposal,
      skillReads: reads,
    };
    const write = (value: typeof body) => {
      const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      writeFileSync(
        join(stateDir, "objective-planning.json"),
        JSON.stringify({ ...value, digest } satisfies OrchestratorPlanningReceipt),
      );
    };
    write(body);
    const accepted = await readPinnedObjectivePlanning(job, selection, plan, "openai", "gpt-6-luna");
    const order = proposal.assignments.map(a => a.id);
    const restore = (digest: string | null = accepted.digest) =>
      restoreCheckpointedObjectivePlanning(job, selection, plan, "openai", "gpt-6-luna",
        digest, order);
    assert.equal((await restore()).digest, accepted.digest);
    await assert.rejects(restore(null), /model replay refused/i);
    await assert.rejects(restore("0".repeat(64)), /differs/i);
    assert.equal(accepted.proposal?.assignments.length, plan.assignments.length);
    assert.equal(accepted.sourceSha, a);
    await assert.rejects(
      readPinnedObjectivePlanning(job, selection, plan, "openai", "other-model"),
      /corrupt|stale/i,
    );
    write({ ...body, sourceSha: "f".repeat(40) });
    await assert.rejects(
      readPinnedObjectivePlanning(job, selection, plan, "openai", "gpt-6-luna"),
      /corrupt|stale/i,
    );
    write({ ...body, skillReads: reads.slice(1) });
    await assert.rejects(
      readPinnedObjectivePlanning(job, selection, plan, "openai", "gpt-6-luna"),
      /method reads/i,
    );
    write({ ...body, proposal: { ...proposal, assignments: proposal.assignments.slice(1) } });
    await assert.rejects(
      readPinnedObjectivePlanning(job, selection, plan, "openai", "gpt-6-luna"),
      /assignment set/i,
    );
    write(body);
    assert.equal((await restore()).phase, "planned");
    // The parent graph calls restore, never runPinnedObjectivePlanner, once
    // its order and digest have been checkpointed. Deletion must not create
    // another model session, even if a new proposal would have the same order.
    rmSync(join(stateDir, "objective-planning.json"));
    await assert.rejects(restore(), /missing, corrupt or stale; model replay refused/i);
    assert.equal(existsSync(join(stateDir, "objective-planning.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("independent focused assignments can be reordered without changing their writer grants", () => {
  const records = [
    { path: "characters/nia.md", metadata: { id: "character.nia", type: "character", status: "draft" } },
    { path: "characters/sol.md", metadata: { id: "character.sol", type: "character", status: "draft" } },
  ];
  const scoped = {
    ...contract,
    scope: {
      kind: "partial" as const,
      depth: "architecture" as const,
      targets: ["character.nia", "character.sol"],
      branches: [] as string[],
    },
  };
  const focused = planRevision(
    "Refine both characters",
    scoped,
    a,
    "parent",
    records,
    ["character.nia", "character.sol"],
    ["characters/nia.md", "characters/sol.md"],
  );
  const order = ["focus:character.sol", "focus:character.nia", "review"];
  const result = verifyOrchestratorProposal(
    {
      sourceSha: a,
      turnDigest: focused.digest,
      assignments: order.map((id) => ({ id, reason: "Same bounded source" })),
    },
    focused,
  );
  assert.deepEqual(
    result.assignments.map((a) => a.id),
    order,
  );
  const items = [
    {
      id: "focus:character.nia",
      stage: "focus",
      milestone: "character.nia",
      status: "pending",
      dependencies: [],
    },
    {
      id: "focus:character.sol",
      stage: "focus",
      milestone: "character.sol",
      status: "pending",
      dependencies: [],
    },
    {
      id: "review",
      stage: "review",
      status: "pending",
      dependencies: ["focus:character.nia", "focus:character.sol"],
    },
  ] as unknown as GenerationInventory["items"];
  const inventory = { items } as GenerationInventory;
  assert.equal(nextExecutionItem(inventory)?.id, "focus:character.nia");
  assert.equal(nextExecutionItem(inventory, order)?.id, "focus:character.sol");
  assert.equal(
    nextExecutionItem(
      {
        ...inventory,
        items: [{ ...items[0]!, status: "verified" }, ...items.slice(1)],
      } as GenerationInventory,
      ["review", ...order],
    )?.id,
    "focus:character.sol",
    "a model cannot promote a dependent review before its prerequisites",
  );
  assert.equal(
    nextExecutionItem(
      {
        ...inventory,
        items: items.map((item) => ({
          ...item,
          status: "blocked",
        })),
      } as GenerationInventory,
      order,
    ),
    undefined,
  );
});

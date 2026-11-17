import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseCausalBlueprint, type CausalBlueprint } from "../src/architecture-blueprint.js";
import { applyBlueprintPatch, blueprintDigest } from "../src/architecture-blueprint-patch.js";
import { captureBlueprintReplay } from "../src/execution-replay-blueprint.js";
import { assembleCurrentBlueprintOutline, parseBlueprintOutlineCore } from "../src/architecture-blueprint-stages.js";
import { replayCase } from "../src/execution-replay.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const initial = parseCausalBlueprint(
  JSON.stringify({
    schema: "noveltea-causal-blueprint/v1",
    premise: "The investigator tests the shelter's disappearance evidence.",
    beats: [
      {
        id: "first-lead",
        purpose: "Visit the archive",
        dependsOn: [],
        change: "The register creates a lead",
        decisions: [],
        observations: [
          {
            source: "register",
            observable: "Signed shelter record",
            supports: "The missing clerk sought help",
            limits: "The signature could be forged",
          },
        ],
      },
      {
        id: "proof",
        purpose: "Verify the clerk's whereabouts",
        dependsOn: ["first-lead"],
        change: "The clerk's location has partial support",
        decisions: [],
        observations: [
          {
            source: "dated log",
            observable: "A clerk appears at dusk",
            supports: "The clerk reached the building",
            limits: "Does not prove departure",
          },
        ],
      },
    ],
    resolution: {
      question: "What happened?",
      conclusion: "The clerk entered the shelter",
      supportedBy: ["proof"],
      uncertainty: "How they left remains unclear",
    },
  }),
);
const revise = {
  status: "revise" as const,
  findings: [
    {
      beatId: "proof",
      reason: "The log does not prove departure",
      correction: "Add independently dated exit evidence",
    },
  ],
};
const patch = {
  schema: "noveltea-blueprint-patch/v1" as const,
  baseDigest: digest(initial),
  reviewDigest: digest(revise),
  operations: [
    {
      kind: "append-observation" as const,
      findingBeatId: "proof",
      beatId: "proof",
      value: {
        source: "dated guard record",
        observable: "The clerk left the shelter at midnight",
        supports: "A plausible exit path",
        limits: "The guard could be mistaken",
      },
    },
  ],
};
const corrected = applyBlueprintPatch(initial, revise, patch).blueprint;

function setup() {
  const temporary = mkdtempSync(join(tmpdir(), "nt-blueprint-replay-"));
  const state = join(temporary, "job");
  const root = join(state, "architecture-blueprints");
  mkdirSync(root, { recursive: true });
  const file = (suffix: string) => join(root, "plan-1-" + suffix + ".json");
  const save = (suffix: string, data: unknown) => writeFileSync(file(suffix), JSON.stringify(data) + "\n");
  const session = (dir: string, name: string) => {
    const path = join(state, dir, name + ".jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: name }) + "\n");
    return path;
  };
  const planner = session("architecture-blueprint-sessions", "planner");
  const reviewer0 = session("architecture-blueprint-review-sessions", "reviewer0");
  const reviewer1 = session("architecture-blueprint-review-sessions", "reviewer1");
  const admitted = {
    jobId: "job-123",
    threadId: "thread-123",
    baseSha: "a".repeat(40),
    executionHead: "b".repeat(40),
    planVersion: 1,
    contractDigest: "c".repeat(64),
    snapshotId: "snapshot-123",
    provider: "openai",
    model: "gpt-6-luna",
    taskDigest: "d".repeat(64),
  };
  const outline = {
    schema: "noveltea-causal-outline/v1",
    premise: initial.premise,
    beats: initial.beats.map(({ observations: _observations, ...beat }) => beat),
    resolution: initial.resolution,
  };
  const evidence = initial.beats.map(({ id, observations }) => ({ id, observations }));
  save("admitted", admitted);
  save("started", { ...admitted, plannerSessionId: "planner", plannerSessionFile: planner });
  save("outline", outline);
  save("evidence-0", evidence);
  save("stages", {
    schema: "noveltea-blueprint-stages/v1",
    outlineDigest: digest(outline),
    evidenceDigests: [digest(evidence)],
  });
  save("obligations", { schema: "noveltea-blueprint-obligations/v1", items: [] });
  save("draft-0", initial);
  save("verdict-0", revise);
  save("review-session-0", {
    sessionId: "reviewer0",
    sessionFile: reviewer0,
    blueprintDigest: digest(initial),
    verdictDigest: digest(revise),
  });
  save("patch-1", patch);
  save("draft-1", corrected);
  const verdict1 = { status: "pass" as const, findings: [] };
  save("verdict-1", verdict1);
  save("review-session-1", {
    sessionId: "reviewer1",
    sessionFile: reviewer1,
    blueprintDigest: digest(corrected),
    verdictDigest: digest(verdict1),
  });
  return { temporary, root, file, save, initial, corrected };
}
function withFixture(run: (fixture: ReturnType<typeof setup>) => void) {
  const fixture = setup();
  try {
    run(fixture);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
}

test("existing replay framework reproduces exact saved blueprint review and bounded correction offline", () =>
  withFixture(({ temporary, root, file, initial: original }) => {
    const before = readFileSync(file("draft-0"));
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (() => {
      throw Error("Blueprint replay must never call a model or network");
    }) as typeof fetch;
    try {
      captureBlueprintReplay(root, 1, 0, "blueprint-review-verdict", join(temporary, "review-rejected"));
      captureBlueprintReplay(root, 1, 1, "blueprint-review-verdict", join(temporary, "review-passed"));
      captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "patch"));
      const rejected = replayCase(join(temporary, "review-rejected"));
      const passed = replayCase(join(temporary, "review-passed"));
      const corrected = replayCase(join(temporary, "patch"));
      assert.equal(rejected.matched, true);
      assert.equal(passed.matched, true);
      assert.equal(corrected.matched, true);
      assert.equal(rejected.actual.status, "returned");
      if (rejected.actual.status === "returned")
        assert.deepEqual(
          (rejected.actual.value as { verdict: { findings: unknown[] } }).verdict.findings,
          revise.findings,
        );
      assert.equal(corrected.actual.status, "returned");
      if (corrected.actual.status === "returned")
        assert.equal(
          (corrected.actual.value as { digest: string }).digest,
          blueprintDigest(applyBlueprintPatch(original, revise, patch).blueprint),
        );
      assert.deepEqual(
        readFileSync(file("draft-0")),
        before,
        "offline replay must not touch the original source",
      );
      assert.throws(
        () => captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "patch")),
        /EEXIST/,
      );
    } finally {
      globalThis.fetch = fetchBefore;
    }
  }));

test("split core/Choice stage replay is tied to both immutable stage digests", () =>
  withFixture(({ root, temporary, save, file }) => {
    const oldOutline = JSON.parse(readFileSync(file("outline"), "utf8"));
    const core = parseBlueprintOutlineCore(JSON.stringify({
      schema: "noveltea-causal-outline-core/v1",
      premise: oldOutline.premise,
      beats: oldOutline.beats,
      resolution: oldOutline.resolution,
      causalAnswer: {
        question: "Why was the clerk missing?",
        answer: "The clerk hid voluntarily in the shelter after receiving a direct threat.",
        mechanism: "The caretaker admitted the clerk through the locked rear gate.",
        responsibility: "The caretaker sheltered the clerk and concealed the entry.",
        motive: "The threat made a public register entry dangerous to the clerk's safety.",
        misdirection: {
          signal: "The front entry book shows no arrival",
          falseInference: "The clerk never entered the shelter",
          actualExplanation: "The caretaker used a private service gate instead",
        },
        proof: {
          directTest: "An entry from the service-gate log identifies the arrival.",
          corroboration: "A separately dated guard sheet corroborates its timing.",
          refusalFallback: "The two records remain inspectable without the clerk's testimony.",
          beatIds: ["proof"],
        },
      },
    }));
    const routes: never[] = [];
    const outlined = assembleCurrentBlueprintOutline(core, routes);
    save("outline-core", core);
    save("outline-routes", routes);
    save("outline", outlined);
    save("stages", {
      schema: "noveltea-blueprint-stages/v2",
      coreDigest: digest(core), routesDigest: digest(routes),
      outlineDigest: digest(outlined),
      evidenceDigests: [digest(initial.beats.map(({ id, observations }) => ({ id, observations })))],
    });
    captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "valid-split"));
    assert.equal(replayCase(join(temporary, "valid-split")).matched, true);
    const header = {
      schema: "noveltea-causal-outline-header/v1",
      premise: core.premise,
      beatIds: core.beats.map(beat => beat.id),
      resolution: core.resolution, causalAnswer: core.causalAnswer,
    };
    const stagesV3 = {
      schema: "noveltea-blueprint-stages/v3",
      headerDigest: digest(header),
      beatDigests: [digest(core.beats)],
      coreDigest: digest(core),
      routesDigest: digest(routes),
      outlineDigest: digest(outlined),
      evidenceDigests: [digest(initial.beats.map(({ id, observations }) => ({ id, observations })))],
    };
    save("outline-header", header);
    save("outline-beats-0", core.beats);
    save("stages", stagesV3);
    captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "valid-batched"));
    assert.equal(replayCase(join(temporary, "valid-batched")).matched, true);
    save("outline-beats-0", core.beats.map(beat => ({ ...beat, change: beat.change + " altered" })));
    assert.throws(() => captureBlueprintReplay(root, 1, 1, "blueprint-patch",
      join(temporary, "changed-beat-batch")), /causal beat batch changed/);
    save("outline-beats-0", core.beats);
    save("outline-header", { ...header, causalAnswer: { ...header.causalAnswer,
      motive: "invented explanation" } });
    assert.throws(() => captureBlueprintReplay(root, 1, 1, "blueprint-patch",
      join(temporary, "changed-header")), /causal header or beat-batch receipts changed/);
    save("outline-header", header);
    save("stages", {
      schema: "noveltea-blueprint-stages/v2",
      coreDigest: digest(core), routesDigest: digest(routes),
      outlineDigest: digest(outlined),
      evidenceDigests: [digest(initial.beats.map(({ id, observations }) => ({ id, observations })))],
    });
    save("outline-routes", [{ beatId: "invented" }]);
    assert.throws(() => captureBlueprintReplay(root, 1, 1, "blueprint-patch",
      join(temporary, "bad-routes")), /causal core or Choice-route receipt changed/);
    save("outline-routes", routes);
    save("outline-core", { ...core, causalAnswer: { ...core.causalAnswer,
      mechanism: "rewritten without review" } });
    assert.throws(() => captureBlueprintReplay(root, 1, 1, "blueprint-patch",
      join(temporary, "bad-core")), /causal core or Choice-route receipt changed/);
  }));

test("capture rejects stale patch, changed review provenance and altered planning stage", () =>
  withFixture(({ temporary, root, save }) => {
    save("patch-1", { ...patch, baseDigest: "0".repeat(64) });
    assert.throws(
      () => captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "invalid-patch")),
      /stale|invalid/,
    );
    save("patch-1", patch);
    save("review-session-0", {
      sessionId: "reviewer0",
      sessionFile: join(dirname(root), "architecture-blueprint-review-sessions", "reviewer0.jsonl"),
      blueprintDigest: digest(initial),
      verdictDigest: "f".repeat(64),
    });
    assert.throws(
      () => captureBlueprintReplay(root, 1, 1, "blueprint-review-verdict", join(temporary, "wrong-review")),
      /review digest|identity changed/,
    );
    save("review-session-0", {
      sessionId: "reviewer0",
      sessionFile: join(dirname(root), "architecture-blueprint-review-sessions", "reviewer0.jsonl"),
      blueprintDigest: digest(initial),
      verdictDigest: digest(revise),
    });
    save("evidence-0", [
      { id: "first-lead", observations: [] },
      { id: "proof", observations: [] },
    ]);
    assert.throws(
      () => captureBlueprintReplay(root, 1, 1, "blueprint-patch", join(temporary, "wrong-evidence")),
      /evidence batch changed/,
    );
  }));

test("recorded blueprint replay inputs are write-once and detect modification", () =>
  withFixture(({ temporary, root }) => {
    const target = join(temporary, "review");
    captureBlueprintReplay(root, 1, 0, "blueprint-review-verdict", target);
    const saved = JSON.parse(readFileSync(join(target, "input.json"), "utf8")) as {
      response: { status: string };
    };
    saved.response.status = "pass";
    writeFileSync(join(target, "input.json"), JSON.stringify(saved));
    assert.throws(() => replayCase(target), /modified/);
  }));

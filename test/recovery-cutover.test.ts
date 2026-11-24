import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightCompositionBoundary } from "../src/cross-domain-prerequisite-controller.js";
import type { JobStartResult } from "../src/job.js";
import type { CompositionBoundaryRequest } from "../src/cross-domain-prerequisite-controller.js";

test("R14 Composition prerequisite cannot promote a missing Turn pin to ready", async () => {
  // The proof must be checked before accessing any Git, validator or Pi effect.
  const job = new Proxy({} as JobStartResult, {
    get() { throw Error("Unadmitted prerequisite touched the job"); },
  });
  const request: CompositionBoundaryRequest = {
    task: "Continue the original Story",
    contract: {
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [],
      envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    },
  };
  for (const fixture of [false, true]) {
    const result = await preflightCompositionBoundary(job, { ...request, fixture },
      "milestone.original", 1);
    assert.equal(result.kind, "refuse");
  }
});

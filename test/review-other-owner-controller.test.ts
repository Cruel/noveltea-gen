import assert from "node:assert/strict";
import { test } from "node:test";
import { settleOtherOwnerPrerequisite } from "../src/review-other-owner-controller.js";

test("#221: a separate approved specialist, its reviews and the original coverage are all mandatory", async () => {
  const calls: string[] = [];
  const input = {
    admit: async () => { calls.push("authenticate-sealed-request"); },
    support: async () => {
      calls.push("run-other-owner-and-review");
      return { status: "dependency-verified" };
    },
    independentlyCovered: async () => {
      calls.push("authenticate-original-coverage");
      return true;
    },
  };
  await settleOtherOwnerPrerequisite(input);
  assert.deepEqual(calls, [
    "authenticate-sealed-request", "run-other-owner-and-review",
    "authenticate-original-coverage",
  ]);
  await settleOtherOwnerPrerequisite(input);
  assert.equal(calls.length, 6, "restart only reauthenticates a shared ledger, never grants another writer");
});

test("#221: failed supporting outcomes cannot certify the original specialist or run downstream", async () => {
  for (const status of ["dependency-support-verified", "rejected", "blocked", "paused", "manual-reconcile"]) {
    const calls: string[] = [];
    await assert.rejects(() => settleOtherOwnerPrerequisite({
      admit: async () => { calls.push("admit"); },
      support: async () => { calls.push("support"); return { status }; },
      independentlyCovered: async () => { calls.push("coverage"); return true; },
    }), /not completed both independent/);
    assert.deepEqual(calls, ["admit", "support"], status);
  }
  let verified = 0;
  await assert.rejects(() => settleOtherOwnerPrerequisite({
    admit: async () => {},
    support: async () => ({ status: "dependency-verified" }),
    independentlyCovered: async () => { verified++; return false; },
  }), /no authenticated positive successor coverage/);
  assert.equal(verified, 1);
});

test("#221: exceptions at admission, authoring or review preserve a non-successful controller result", async () => {
  for (const phase of ["admit", "support", "coverage"] as const) {
    const log: string[] = [];
    const fail = async (name: string) => {
      log.push(name);
      if (name === phase) throw Error("sealed-" + phase + "-failure");
    };
    await assert.rejects(() => settleOtherOwnerPrerequisite({
      admit: () => fail("admit"),
      support: async () => { await fail("support"); return { status: "dependency-verified" }; },
      independentlyCovered: async () => { await fail("coverage"); return true; },
    }), new RegExp("sealed-" + phase + "-failure"));
    assert.deepEqual(log, ["admit", "support", "coverage"].slice(
      0, ["admit", "support", "coverage"].indexOf(phase) + 1));
  }
});

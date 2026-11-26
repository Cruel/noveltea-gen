// Executed in a child process by the regression, never by the ordinary suite.
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { serialScenarioGuard } from "./serial-scenarios.js";

const guarded = serialScenarioGuard();
test("interrupted stateful scenario", { timeout: 20 }, guarded("interrupted", async () => {
  await setTimeout(150);
}));
test("following scenario", guarded("following", () => {
  throw Error("Following scenario was allowed to touch interrupted process state");
}));

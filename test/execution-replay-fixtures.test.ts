/** Self-contained, explicitly privacy-reviewed captured cases can be
 * promoted here. No fixture invokes Pi or reaches out to a model service. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { replayCase } from "../src/execution-replay.js";

const fixtureRoot = resolve("test/fixtures/execution-replay");
const entries = existsSync(fixtureRoot)
  ? readdirSync(fixtureRoot)
      .filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && lstatSync(join(fixtureRoot, name)).isDirectory())
      .sort()
  : [];
test("all promoted execution replay fixtures are valid private-free cases", () => {
  // The base suite tests schema and behavior; promoted cases add real bugs.
  assert.ok(entries.length <= 128, "Replay fixture count must stay bounded");
});
for (const name of entries) {
  test("offline recorded execution regression: " + name, () => {
    const result = replayCase(join(fixtureRoot, name));
    assert.equal(
      result.matched,
      true,
      "Previously observed execution outcome changed; inspect the recorded expected and actual results.",
    );
  });
}

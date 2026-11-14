import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEventManifest } from "../src/event-specialist.js";
import { lastSpecialistManifest } from "../src/specialist-manifest.js";

test("Luna Event manifest accepts deferred Choice obligations containing JSON-like braces and escaped text", () => {
  const manifest = {
    modifiedRecords: ["events/disclosure-conversation.md"],
    architecturalConflicts: [],
    laterObligations: [
      "Keep fulfillment: {any_of: []} until formal Choice binding",
      'The author said "protect", not "enact"\\no changes yet',
    ],
  };
  const output = "Created a reachable Event; Choice remains unbound.\n\n" + JSON.stringify(manifest);
  assert.deepEqual(parseEventManifest(output), manifest);
  assert.deepEqual(lastSpecialistManifest(output), manifest);
});

test("manifest scanning selects the last complete manifest, without accepting malformed JSON or absent fields", () => {
  const valid = {
    modifiedRecords: ["events/disclosure-conversation.md"],
    architecturalConflicts: [],
    laterObligations: ["formal Choice binding"],
  };
  const text =
    JSON.stringify({ ...valid, modifiedRecords: ["events/old.md"] }) +
    "\nOther context\n" +
    JSON.stringify(valid);
  assert.deepEqual(parseEventManifest(text), valid);
  assert.throws(
    () => parseEventManifest('{"modifiedRecords":["events/a.md"],"architecturalConflicts":{}}'),
    /JSON manifest/,
  );
  assert.equal(
    lastSpecialistManifest(JSON.stringify(valid) + '\\n{"modifiedRecords":["events/new.md"],'),
    null,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEventManifest } from "../src/event-specialist.js";
import { parseInteractiveManifest } from "../src/interactive-specialist.js";
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

test("Choice/Puzzle manifest rejects Luna id/path objects but accepts cumulative path strings", () => {
  const bad = JSON.stringify({
    modifiedRecords: [{ id: "event.new", path: "events/new.md" }],
    architecturalConflicts: [],
    laterObligations: ["Future Puzzle"],
  });
  assert.throws(() => parseInteractiveManifest(bad), /complete modifiedRecords/);
  const good = JSON.stringify({
    modifiedRecords: ["events/new.md", "choice-points/decision.md"],
    architecturalConflicts: [],
    laterObligations: ["Future Puzzle"],
  });
  assert.deepEqual(parseInteractiveManifest(good), {
    paths: ["events/new.md", "choice-points/decision.md"],
    conflicts: [],
    obligations: ["Future Puzzle"],
  });
});

test("a deliberate empty Choice report names its source conflict instead of requesting JSON reformat", () => {
  const conflict = JSON.stringify({
    modifiedRecords: [],
    architecturalConflicts: ["Verified source is an Event-only observation with no missing Choice."],
    laterObligations: ["Author a consequential Choice at a separate decision Milestone."],
  });
  assert.deepEqual(parseInteractiveManifest(conflict, "choice"), {
    paths: [],
    conflicts: ["Verified source is an Event-only observation with no missing Choice."],
    obligations: ["Author a consequential Choice at a separate decision Milestone."],
  }, "A truthful negative result is not a format error; the controller owns its Repair disposition.");
  assert.deepEqual(parseInteractiveManifest(conflict, "puzzle"), {
    paths: [],
    conflicts: ["Verified source is an Event-only observation with no missing Choice."],
    obligations: ["Author a consequential Choice at a separate decision Milestone."],
  });
  assert.throws(() => parseInteractiveManifest(JSON.stringify({
    modifiedRecords: [], architecturalConflicts: [], laterObligations: [],
  }), "choice"), /verified Event-only omission/);
});

test("manifest correction accepts unordered JSON keys without trying another writer turn", () => {
  const unordered = JSON.stringify({
    laterObligations: ["Review the Choice later"],
    modifiedRecords: ["events/arrival.md"],
    architecturalConflicts: [],
  });
  assert.deepEqual(parseEventManifest(unordered), {
    modifiedRecords: ["events/arrival.md"],
    architecturalConflicts: [],
    laterObligations: ["Review the Choice later"],
  });
});

test("a later malformed manifest cannot be concealed by an earlier valid report with a different key order", () => {
  const accepted = JSON.stringify({
    modifiedRecords: ["events/old.md"],
    architecturalConflicts: [],
    laterObligations: [],
  });
  const missing = JSON.stringify({ laterObligations: ["Not a complete manifest"] });
  assert.equal(lastSpecialistManifest(accepted + "\\n" + missing)?.modifiedRecords, undefined);
  assert.throws(() => parseEventManifest(accepted + "\\n" + missing), /JSON manifest/);
  assert.equal(lastSpecialistManifest(accepted + '\\n{"laterObligations":['), null);
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

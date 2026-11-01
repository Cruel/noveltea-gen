import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUserProtectedDecision, renderFoundation } from "../src/foundation-record.js";

function direction(decisions: Array<{ id: string; statement: string; origin: "user" | "agent"; authority: "user-protected" | "delegated" }>) {
  return renderFoundation({
    id: "foundation", title: "Stranded Train", premise: "Missing passenger",
    central_conflict: "Trust or truth", genre: "Mystery", tone: "Intimate",
    player_experience: "Investigate via dialogue", scope: "Two locations",
    decisions, body: "# Foundation\n\nAn intimate train mystery.",
  });
}

test("foundation provenance recognizes explicit protected author decisions", () => {
  assert.equal(hasUserProtectedDecision(direction([
    { id: "author-setting", statement: "Stranded train", origin: "user", authority: "user-protected" },
    { id: "agent-clue", statement: "Missing ledger", origin: "agent", authority: "delegated" },
  ])), true);
});

test("foundation provenance accepts valid YAML-quoted origins and authorities from live Pi", () => {
  const original = direction([
    { id: "author-setting", statement: "Stranded train", origin: "user", authority: "user-protected" },
    { id: "agent-clue", statement: "Missing ledger", origin: "agent", authority: "delegated" },
  ]);
  const doubleQuoted = original
    .replace("origin: user", 'origin: "user"')
    .replace("authority: user-protected", 'authority: "user-protected"')
    .replace("origin: agent", 'origin: "agent"');
  assert.equal(hasUserProtectedDecision(doubleQuoted), true);
  const singleQuoted = original
    .replace("origin: user", "origin: 'user'")
    .replace("authority: user-protected", "authority: 'user-protected'");
  assert.equal(hasUserProtectedDecision(singleQuoted), true);
  assert.equal(hasUserProtectedDecision(doubleQuoted.replace('origin: "user"', 'origin: "agent"')), false);
});

test("foundation provenance detects the real Pi failure: every decision attributed to the agent", () => {
  assert.equal(hasUserProtectedDecision(direction([
    { id: "archivist-protagonist", statement: "The player follows an archivist", origin: "agent", authority: "delegated" },
    { id: "compact-vn-presentation", statement: "Two locations", origin: "agent", authority: "delegated" },
  ])), false);
});

test("foundation provenance keeps authority paired with its decision and ignores body text", () => {
  const record = direction([
    { id: "author-bracket", statement: "No author approval", origin: "user", authority: "delegated" },
    { id: "model-choice", statement: "An invented clue", origin: "agent", authority: "user-protected" },
  ]);
  assert.equal(hasUserProtectedDecision(record), false);
  assert.equal(hasUserProtectedDecision(record +
    "\norigin: user\n    authority: user-protected\n"), false);
  assert.equal(hasUserProtectedDecision("origin: user\n    authority: user-protected"), false);
});

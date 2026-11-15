import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestTree } from "./helpers.js";
import type { JobStartResult } from "../src/job.js";
import { explicitlyRequiresPuzzle, puzzleNoWriteSessionDigest } from "../src/puzzle-obligation.js";

test("optional formal-Puzzle handoffs are not author obligations", () => {
  for (const statement of [
    "Make me a mystery game",
    "A compact atmospheric mystery with fair-play clues, an enacted Choice and different endings",
    "Puzzle implementation and final composed visual-novel scene remain deferred.",
    "Puzzle/clue implementation and final authored-scene composition remain deferred to their respective owners.",
    "Later investigation must supply enough fair-play evidence to support the response; the current empty-case and latch observations do not identify who removed the lantern or when. Bind Milestone fulfillment only after the required evidence and enacted choice are established. Defer Puzzle and final prose.",
    "The Event writer must defer Puzzle and final prose until a later owner.",
    "Choice and Puzzle belong to later units.",
    "The Puzzle implementation is postponed until clues are known.",
    "Choice/Puzzle/Content as appropriate",
    "A Puzzle is optional if relevant to the approved Story",
    "Do not require a formal Puzzle; solve the mystery through consequential choices",
    "Avoid puzzles and use only meaningful choices",
    "No puzzles, please",
    "The player must not create puzzles while making the Choice.",
  ]) {
    assert.equal(explicitlyRequiresPuzzle(statement), false, statement);
  }
});

test("verified Event handoffs cannot create a Puzzle obligation from stage names alone", () => {
  for (const statement of [
    "Puzzle specialist will handle clues at a later unit.",
    "Puzzle work and final scenes belong to downstream owners.",
    "The Puzzle owner should consider formal solutions if the evidence permits.",
    "The interactive owner must bind the Choice; Puzzle and prose follow later.",
    "More Puzzle investigation will be needed once evidence is available.",
  ]) {
    assert.equal(explicitlyRequiresPuzzle(statement, "event-handoff"), false, statement);
    // A bare direct author request for a formal Puzzle is different from a
    // model's downstream stage inventory.
  }
  for (const statement of [
    "A mandatory Puzzle with two distinct reachable solution Events is required.",
    "The player must solve the mystery through verifiable clues.",
    "The source-bound Puzzle must be solved using two independently reachable Events.",
  ]) {
    assert.equal(explicitlyRequiresPuzzle(statement, "event-handoff"), true, statement);
  }
  assert.equal(
    explicitlyRequiresPuzzle("Make a puzzle mystery game"),
    true,
    "Explicit formal Puzzle in the original author brief remains mandatory.",
  );
});

test("no-write Pi transcript is source-bound, regular, and content-addressed", () => {
  const root = mkdtempSync(join(tmpdir(), "nt-puzzle-no-write-witness-"));
  try {
    const job = { stateDir: root } as JobStartResult;
    const unit = "interactive-puzzle-disclosure";
    const directory = join(root, "interactive-sessions/interactive-disclosure/puzzle");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "original.jsonl");
    writeFileSync(file, '{"role":"assistant","content":"No Puzzle is justified"}\n');
    const first = puzzleNoWriteSessionDigest(job, unit, file);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(puzzleNoWriteSessionDigest(job, unit, file), first);
    writeFileSync(file, '{"role":"assistant","content":"I changed the negative finding"}\n');
    assert.notEqual(puzzleNoWriteSessionDigest(job, unit, file), first);
    const outside = join(root, "other.jsonl");
    writeFileSync(outside, "not the original session");
    assert.throws(() => puzzleNoWriteSessionDigest(job, unit, outside), /outside its original/);
    symlinkSync(outside, join(directory, "link.jsonl"));
    assert.throws(
      () => puzzleNoWriteSessionDigest(job, unit, join(directory, "link.jsonl")),
      /outside its original|regular file/,
    );
    assert.throws(
      () => puzzleNoWriteSessionDigest(job, unit, directory + "/../puzzle/original.jsonl"),
      /outside its original/,
    );
  } finally {
    removeTestTree(root);
  }
});

test("explicit formal Puzzle or player-solving promises stay binding", () => {
  for (const statement of [
    "The player must solve the mystery through fair-play clue deductions.",
    "The player needs to identify the culprit by solving the case.",
    "Include a solvable cipher and two distinct solutions",
    "Make a puzzle game",
    "An escape room challenge on an overnight train",
    "A required Puzzle with independently reachable solution Events",
    "An independently solvable Puzzle is mandatory, even if implementation is deferred.",
    "The author requires a Puzzle, but its implementation is deferred to a separate specialist.",
    "The mystery must be solved through clues the player actually uses",
  ]) {
    assert.equal(explicitlyRequiresPuzzle(statement), true, statement);
  }
});

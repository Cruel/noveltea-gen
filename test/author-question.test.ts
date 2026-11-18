import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAuthorQuestion, parseAuthorAnswer, authorQuestionDirection, authorQuestionOptions,
} from "../src/author-question.js";

const concise = {
  kind: "alternatives", question: "Which consequence should the archive revelation have?",
  options: [{ id: "trust", title: "Rebuild trust" }, { id: "doubt", title: "Sow doubt" }],
  recommendedId: "trust", recommendationReason: "It keeps the discovery grounded.",
  context: [{ path: "characters/nia.md", line: 12, description: "Nia's established motive" }],
};

test("shared questions accept compact alternatives and preserve exact canonical context", () => {
  assert.deepEqual(parseAuthorQuestion(concise), concise);
  assert.deepEqual(authorQuestionOptions(parseAuthorQuestion({ kind: "yes-no",
    question: "Should Nia reveal the name?" })).map(o => o.id), ["yes", "no"]);
  assert.equal(parseAuthorQuestion({ kind: "free-text",
    question: "What should the witness say?", placeholder: "For example, a short confession" }).placeholder,
  "For example, a short confession");
});

test("shared parser rejects malformed questions, options, recommendation targets and references", () => {
  for (const bad of [
    { ...concise, options: [concise.options[0], concise.options[0]] },
    { ...concise, recommendedId: "unknown" },
    { ...concise, options: [{ id: "__custom__", title: "Invalid" }, concise.options[1]] },
    { ...concise, options: [{ id: "trust", title: " " }, concise.options[1]] },
    { ...concise, context: [{ path: "../secret.md", line: 1, description: "leak" }] },
    { ...concise, question: "x".repeat(1501) },
    { ...concise, bogusAuthority: true },
    { kind: "yes-no", question: "Should the plan change?", recommendedId: "maybe" },
    { kind: ["yes-no"], question: "Should the plan change?" },
    { kind: "yes-no", question: "Should the plan change?", recommendedId: ["yes"] },
    { kind: "free-text", question: "What should happen?", options: concise.options },
  ]) assert.throws(() => parseAuthorQuestion(bad));
});

test("shared answer validation preserves verbatim author words and disallows invented or forged answers", () => {
  const q = parseAuthorQuestion(concise);
  const option = parseAuthorAnswer(q, { kind: "option", optionId: "doubt", note: "  Keep the clue.  " });
  assert.deepEqual(option, { kind: "option", optionId: "doubt", note: "  Keep the clue.  " });
  assert.match(authorQuestionDirection(q, option), /Keep the clue/);
  const described = parseAuthorQuestion({ ...concise,
    options: [{ id: "trust", title: "Rebuild trust", description: "Share the evidence safely" },
      { id: "doubt", title: "Sow doubt" }] });
  assert.match(authorQuestionDirection(described,
    { kind: "option", optionId: "trust", note: "" }), /Share the evidence safely/);
  const other = parseAuthorAnswer(q, { kind: "custom", text: "  Somewhat linear, but not too much.  ",
    note: " Do not add a branch. " });
  assert.equal(other.text, "  Somewhat linear, but not too much.  ");
  assert.equal(authorQuestionDirection(q, other), "  Somewhat linear, but not too much.  \nAdditional guidance:  Do not add a branch. ");
  for (const bad of [
    { kind: "option", optionId: "bogus", note: "" },
    { kind: "option", optionId: "trust", note: "", approved: true },
    { kind: "custom", text: "  ", note: "" },
    { kind: "custom", text: "x".repeat(4001), note: "" },
    { kind: "delegate", note: "" },
    { kind: "option", optionId: "__custom__", note: "" },
  ]) assert.throws(() => parseAuthorAnswer(q, bad));
  assert.throws(() => parseAuthorAnswer(parseAuthorQuestion({
    kind: "free-text", question: "What should happen?" }), option));
});

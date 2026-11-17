import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlueprintWire } from "../src/architecture-blueprint-wire.js";

test("JSONL accepts legal whitespace around each complete object without changing its meaning", () => {
  const rows = [{ id: "first", decisions: [] }, { id: "second", decisions: [] }];
  const text = JSON.stringify(rows[0]) + " \t\r\n \t" + JSON.stringify(rows[1]) + "  ";
  assert.deepEqual(parseBlueprintWire(text, 1000), { format: "jsonl", values: rows });
  assert.deepEqual(parseBlueprintWire(" \t" + JSON.stringify(rows[0]) + "  ", 1000),
    { format: "json", value: rows[0] });
});

test("JSONL still rejects missing braces, wrappers, stray content and blank lines", () => {
  const a = '{"id":"first"}';
  const b = '{"id":"second"}';
  assert.throws(() => parseBlueprintWire(a + " \n" + '{"id":"second"', 1000),
    /JSONL line 2 must be a complete/);
  assert.throws(() => parseBlueprintWire(a + " \n" + b + "}", 1000),
    /JSONL line 2 is invalid/);
  assert.throws(() => parseBlueprintWire(a + " \n\n" + b, 1000),
    /JSONL line 2 must be a complete/);
  // A complete JSON array is recognized as JSON, but never as JSONL rows;
  // the specific stage parsers separately reject the wrong object shape.
  assert.equal(parseBlueprintWire("[" + a + ",\n" + b + "]", 1000).format, "json");
  assert.throws(() => parseBlueprintWire("[" + a + ",\n" + b + "] trailing", 1000),
    /JSONL line 1 must be a complete/);
  assert.throws(() => parseBlueprintWire(a + " \n" + b + " trailing text", 1000),
    /JSONL line 2 must be a complete/);
  assert.throws(() => parseBlueprintWire(a + "\n" + b, 5),
    /exceeds its bounded size/);
});

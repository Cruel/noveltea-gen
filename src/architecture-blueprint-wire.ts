/** A strict wire codec for read-only Pi planning. Accepts either a complete
 * JSON document or explicitly line-delimited JSON objects. It never repairs
 * malformed JSON, drops lines or modifies model-authored values. */
export type BlueprintWire =
  | { format: "json"; value: unknown }
  | { format: "jsonl"; values: unknown[] };

export function parseBlueprintWire(text: string, byteLimit: number): BlueprintWire {
  const raw = text.trim()
    .replace(/^```(?:json|jsonl)?\s*\n/i, "")
    .replace(/\n```\s*$/, "");
  if (Buffer.byteLength(raw, "utf8") > byteLimit)
    throw Error("Blueprint model response exceeds its bounded size.");
  try { return { format: "json", value: JSON.parse(raw) as unknown }; }
  catch (singleError) {
    // A complete JSON document with an extra brace is NOT repaired by treating
    // its internal pretty-printed lines as an alternative valid format.
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2)
      throw Error("Blueprint response is not JSON: " +
        (singleError instanceof SyntaxError ? singleError.message : "Invalid JSON document"));
    const values: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith("{") || !line.endsWith("}"))
        throw Error("Blueprint JSONL line " + (index + 1) +
          " must be a complete, unwrapped JSON object.");
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw Error("Expected object");
        values.push(parsed);
      } catch (error) {
        throw Error("Blueprint JSONL line " + (index + 1) +
          " is invalid: " + (error instanceof Error ? error.message : "Invalid JSON"));
      }
    }
    return { format: "jsonl", values };
  }
}

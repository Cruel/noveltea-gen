/** Compare an Event-owned Milestone against its verified baseline without
 * parsing or reserializing YAML. Only the two existing controller-authorized
 * frontmatter slots may differ; every other byte, including body prose and
 * protected decisions, remains identical. Native validation checks the YAML. */
export function milestoneFulfillmentProjection(text: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw Error("Milestone has no frontmatter.");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw Error("Milestone has unclosed frontmatter.");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i < end && /^fulfillment:/.test(lines[i]!)) {
      out.push("fulfillment: [audited]");
      while (i + 1 < end && /^(?:[ \\t]+|[ \\t]*$)/.test(lines[i + 1]!)) i++;
    } else if (i > 0 && i < end && /^completeness:/.test(lines[i]!)) {
      // Completeness is a scalar planning/realization status.
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join("\n");
}

export function assertMilestoneFulfillmentOnly(before: string, after: string,
  legacyEventWhitespace = false) {
  // Existing Event drafting tolerated trailing blank lines. Review correction
  // must not: its non-field bytes, including narrative body, are immutable.
  const prior = milestoneFulfillmentProjection(before);
  const next = milestoneFulfillmentProjection(after);
  if ((legacyEventWhitespace ? prior.trimEnd() : prior) !==
      (legacyEventWhitespace ? next.trimEnd() : next))
    throw Error(legacyEventWhitespace
      ? "Event specialist changed unrelated Milestone metadata/body."
      : "Milestone repair changed unrelated frontmatter, protected decisions or body.");
}

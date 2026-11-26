/** One source of record-type ownership for focused Turn planning, trusted
 * dependency authorization and actual focused writer dispatch. Unrecognized
 * types (e.g. Arc/Milestone) require a different orchestration workflow. */
const owners = {
  character: "nt-character-development",
  relationship: "nt-character-development",
  "world-entity": "nt-worldbuilding",
  fact: "nt-worldbuilding",
  revelation: "nt-worldbuilding",
  event: "nt-event-design",
  "authored-content": "nt-narrative-composition",
  "choice-point": "nt-interactive-narrative",
  puzzle: "nt-interactive-narrative",
} as const;

export type FocusedRecordType = keyof typeof owners;

export function isFocusedRecordType(type: string): type is FocusedRecordType {
  return Object.prototype.hasOwnProperty.call(owners, type);
}

export function focusedSpecialist(recordId: string): string {
  const type = recordId.split(".")[0] ?? "";
  if (!isFocusedRecordType(type))
    throw Error("No bounded focused specialist for " + recordId + "; select an Arc or Milestone scope.");
  return owners[type];
}

/** Existing canonical architecture records may be corrected only under an
 * independently admitted, exact-path supporting dependency grant. Ordinary
 * focused author requests still use the original focused-scope policy. */
export function writerDependencySpecialist(recordId: string): string {
  const type = recordId.split(".")[0];
  return type === "arc" || type === "milestone" ? "nt-story-architecture" : focusedSpecialist(recordId);
}

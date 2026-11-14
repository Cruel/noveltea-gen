/** Read-only, source-grounded Event consequence inventory. The native catalog
 * supplies typed metadata; this module neither parses YAML nor decides whether
 * a narrative inference, belief or Relationship transition is justified. */
import { createHash } from "node:crypto";

export interface EventProofSource {
  path: string;
  content: string;
  metadata: Record<string, any>;
}
export interface EffectProof {
  path: string;
  line: number;
  event: string;
  step: string;
  branch: string;
  kind: string;
  slot: string;
  value: string;
}
export interface EventProofDiagnostic {
  path: string;
  line: number;
  event: string;
  step: string;
  branch: string;
  slot: string;
  code: "conflicting-branch-effects";
  correction: "remove-contradictory-effect";
  message: string;
}
export interface EventConsequenceProof {
  version: 1;
  milestone: { id: string; path: string; line: number; claim: string };
  sourceDigest: string;
  /** Exact source contents used to construct this native-typed inventory. */
  sourceHashes: Array<{ path: string; sha256: string }>;
  routes: Array<{ event: string; prerequisites: unknown; after: unknown }>;
  baselines: Array<{ path: string; id: string; state: unknown }>;
  events: Array<{
    id: string; path: string; line: number; observation: string;
    /** Present Characters; player access still requires evidence in the prose. */
    participants: string[]; consequences: unknown;
    outcomes: Array<{ step: string; branch: string; line: number;
      conditions: unknown; effects: EffectProof[] }>;
  }>;
  laterObligations: string[];
  /** These are deferred to Choice, not evidence of Event-stage failure. */
  unresolvedChoiceOutcomes: Array<{ event: string; step: string; branches: string[];
    reason: "identical-typed-effects-await-choice-binding" }>;
  diagnostics: EventProofDiagnostic[];
}

function body(text: string) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  return { line: end + 2, text: lines.slice(end + 1).join("\n").trim().slice(0, 700) };
}
function sourceLine(content: string, pattern: RegExp, start = 0, end = Infinity) {
  const lines = content.split(/\r?\n/);
  for (let index = start; index < Math.min(lines.length, end); index++)
    if (pattern.test(lines[index]!)) return index + 1;
  return start + 1;
}
function kindSlot(effect: Record<string, any>) {
  // The slot is an exact typed address, not a guess from prose or an invented
  // Fact. Keep all effect selectors so alternate targets cannot collapse.
  const selectors = Object.entries(effect)
    .filter(([key]) => !["kind", "value"].includes(key))
    .map(([key, value]) => key + "=" + JSON.stringify(value)).sort();
  return String(effect.kind) + (selectors.length ? ":" + selectors.join(",") : "");
}
const asArray = (value: unknown): Record<string, any>[] =>
  Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Bind the advisory proof to its exact author commit without making it a
 * substitute for validation or independent semantic review. */
export const eventConsequenceProofDigest = (proof: EventConsequenceProof) => digest(proof);

/** This is an evidence packet, not an independent or model-graded acceptance
 * rule. A conflict within a single typed branch is provable; missing effects,
 * premature knowledge, proportionality and branch significance require
 * independent review against the source promises and routes. */
export function buildEventConsequenceProof(
  sources: EventProofSource[], milestoneId: string, eventPaths: string[],
  laterObligations: string[],
): EventConsequenceProof {
  if (sources.length > 32 || eventPaths.length > 16 || laterObligations.length > 16)
    throw Error("Event consequence proof exceeds bounded source inventory.");
  const milestone = sources.find(s => s.metadata.type === "milestone" && s.metadata.id === milestoneId);
  if (!milestone) throw Error("Event consequence proof requires the actual selected Milestone.");
  const events = sources.filter(s => s.metadata.type === "event" && eventPaths.includes(s.path));
  if (events.length !== eventPaths.length)
    throw Error("Event consequence proof lacks an authored Event source.");
  const diagnostics: EventProofDiagnostic[] = [];
  const unresolvedChoiceOutcomes: EventConsequenceProof["unresolvedChoiceOutcomes"] = [];
  const deferredChoice = laterObligations.some(text =>
    /choice[ -]?(?:point|binding|specialist|writer|owner)|\bformal choice\b/i.test(text));
  const records = events.map(event => {
    const outcomes: EventConsequenceProof["events"][number]["outcomes"] = [];
    const steps = asArray(event.metadata.steps);
    const lines = event.content.split(/\r?\n/);
    let cursor = 0;
    for (const step of steps) {
      const stepLine = sourceLine(event.content,
        new RegExp("^\\s*- id:\\s*['\\\"]?" + String(step.id).replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "['\\\"]?\\s*$"), cursor);
      cursor = stepLine;
      for (const branch of asArray(step.branches)) {
        const branchLine = sourceLine(event.content,
          new RegExp("^\\s*- id:\\s*['\\\"]?" + String(branch.id).replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "['\\\"]?\\s*$"), cursor);
        cursor = branchLine;
        const nextBranch = lines.findIndex((line, i) => i >= branchLine &&
          /^\s*- id:\s*/.test(line) && /^\s{4,}- id:/.test(line));
        const limit = nextBranch < 0 ? lines.length : nextBranch;
        let effectCursor = branchLine;
        const effects: EffectProof[] = [];
        const seen = new Map<string, EffectProof>();
        for (const effect of asArray(branch.effects)) {
          const kind = String(effect.kind);
          const effectLine = sourceLine(event.content,
            new RegExp("^\\s*- kind:\\s*['\\\"]?" + kind.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "['\\\"]?\\s*$"),
            effectCursor, limit);
          effectCursor = effectLine;
          const proof: EffectProof = {
            path: event.path, line: effectLine, event: String(event.metadata.id),
            step: String(step.id), branch: String(branch.id), kind,
            slot: kindSlot(effect), value: JSON.stringify(effect.value ?? null),
          };
          const previous = seen.get(proof.slot);
          if (previous && previous.value !== proof.value) {
            diagnostics.push({ path: proof.path, line: proof.line, event: proof.event,
              step: proof.step, branch: proof.branch, slot: proof.slot,
              code: "conflicting-branch-effects", correction: "remove-contradictory-effect",
              message: "One branch assigns incompatible values to the same typed slot at lines " +
                previous.line + " and " + proof.line + ". Reconcile the authored effect, not the prose alone." });
          }
          seen.set(proof.slot, proof);
          effects.push(proof);
        }
        outcomes.push({ step: String(step.id), branch: String(branch.id),
          line: branchLine, conditions: branch.conditions ?? [], effects });
      }
    }
    if (deferredChoice) {
      for (const step of steps) {
        const alternatives = outcomes.filter(outcome => outcome.step === String(step.id));
        if (alternatives.length < 2) continue;
        const fingerprints = alternatives.map(outcome =>
          JSON.stringify(outcome.effects.map(e => [e.slot, e.value]).sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)))));
        if (new Set(fingerprints).size === 1)
          unresolvedChoiceOutcomes.push({ event: String(event.metadata.id), step: String(step.id),
            branches: alternatives.map(a => a.branch),
            reason: "identical-typed-effects-await-choice-binding" });
      }
    }
    const prose = body(event.content);
    return { id: String(event.metadata.id), path: event.path, line: prose.line,
      observation: prose.text,
      participants: Array.isArray(event.metadata.participants)
        ? event.metadata.participants.map(String) : [],
      consequences: event.metadata.consequences ?? [], outcomes };
  });
  const baselines = sources.filter(s =>
    ["character", "relationship", "fact", "revelation"].includes(s.metadata.type))
    .map(s => ({ path: s.path, id: String(s.metadata.id),
      state: s.metadata.type === "character"
        ? { initial_knowledge: s.metadata.initial_knowledge ?? [] }
        : s.metadata.type === "relationship"
          ? { initial: s.metadata.initial, characters: s.metadata.characters }
          : s.metadata.type === "fact"
            ? { initial: s.metadata.initial }
            : { fact: s.metadata.fact } }));
  const milestoneBody = body(milestone.content);
  const routes = events.map(event => ({ event: String(event.metadata.id),
    prerequisites: event.metadata.prerequisites ?? null,
    after: event.metadata.after ?? [] }));
  const sourceHashes = sources.map(s => ({ path: s.path,
    sha256: createHash("sha256").update(s.content).digest("hex") }));
  const sourceDigest = digest(sources.map((s, index) => ({
    ...sourceHashes[index], metadata: s.metadata,
  })));
  return { version: 1,
    milestone: { id: milestoneId, path: milestone.path, line: milestoneBody.line,
      claim: milestoneBody.text }, sourceDigest, sourceHashes, routes, baselines,
    events: records, laterObligations: [...laterObligations],
    unresolvedChoiceOutcomes, diagnostics };
}

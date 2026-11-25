/** Test-owned, ordinary Pi responses for one authored mystery baseline.
 * No scheduler, receipt, approval or validation replacement is provided here.
 * Unexpected model prompts and changed source bytes fail closed. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnFulfillmentPacket } from "../../src/turn-fulfillment.js";
import type { ReviewAssignment } from "../../src/narrative-review-specialist.js";
import type { JobStartResult } from "../../src/job.js";
import type { TurnEvidence } from "../../src/turn-plan-evidence.js";
import type { CausalBlueprint } from "../../src/architecture-blueprint.js";
import { boundedPinnedSources } from "../../src/bounded-specialist-prompt.js";
import { requiredOrchestratorSkillReads } from "../../src/story-skill-policy.js";
import { renderFoundation } from "../../src/foundation-record.js";
import { scriptedReadCalls, scriptedText } from "../c03-scripted-story-helpers.js";

const path = fileURLToPath(new URL("../fixtures/archive-witness/", import.meta.url));
const bytes = (p: string) => readFileSync(join(path, p), "utf8");
const arc = "arcs/truth.md";
const disclosure = "milestones/disclosure.md";
const reckoning = "milestones/reckoning.md";
export const archiveInteractiveRecords = [
  ["choice-points/loyalty.md", "events/disclose-ledger.md", "events/aftermath.md", "revelations/ledger-secret.md"],
  ["puzzles/ledger-proof.md", "events/discover-mark.md", "events/discover-seal.md", "events/decode-ledger.md",
    "events/request-testimony.md", "revelations/puzzle-evidence.md", "authored-content/watermark-clue.md", "authored-content/seal-clue.md"],
].map(paths => Object.fromEntries(paths.map(p => [p, bytes(p)])));
const eventPath = "events/disclose-ledger.md";
const openingEvent = bytes(eventPath).replace(/steps:\n[\s\S]*?(?=\n---)/,
  "steps:\n  - id: decision-offered\n    branches:\n      - id: protect\n        conditions: []\n        effects: []\n      - id: challenge\n        conditions: []\n        effects: []")
  .replace('Neri discloses the ledger, changing Ada\'s belief and their relationship',
    'Neri shows Ada the original ledger and proposes a decision')
  .replace(/\n---\n\n[\s\S]*$/, "\n---\n\nNeri opens the signed ledger and shows Ada the dated entry alongside the independent daily register. The player must still decide whether to protect Neri or demand accountability. The records establish concealment, not his motive.\n");
const secondEventPath = "events/redacted-account.md";
const secondEvent = "---\nschema: '0.1'\ntype: event\nid: event.redacted-account\ntitle: The Redacted Account\nstatus: draft\ndecisions: []\nparticipants: [character.ada, character.neri]\narcs: [arc.truth]\nconsequences: [The inquiry accepts independent proof of concealment without exposing the witness]\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.disclose-ledger]\n      not_completed: []\nsteps: []\n---\n\nAda compares the signed entry with the independently maintained daily register and offers a redacted account to the inquiry. The matching dates independently establish concealment. The inquiry accepts the redacted account without requiring the witness's name. The records do not establish Neri's private motive.\n";
const secondMilestone = (text: string) => text.replace("completeness: partial\n", "").replace("fulfillment: {any_of: []}", "fulfillment: {any_of: [[event.redacted-account]]}");
const prosePaths = ["authored-content/disclosure-scene.md", "authored-content/aftermath-continuation.md",
  "authored-content/decode-ledger-ending.md", "authored-content/request-testimony-ending.md"];
const secondProsePath = "authored-content/redacted-account.md";
const secondProse = `---\nschema: '0.1'\ntype: authored-content\nid: authored-content.redacted-account\ntitle: The Redacted Account\nstatus: draft\ndecisions: []\nevents: [event.redacted-account]\nrevelations: []\n---\n\nAda sets the signed ledger beside the daily register. "The dates match. We can prove concealment without naming the witness." Neri checks both entries before handing the redacted account to the inquiry. The inquiry accepts the account; the matching entries establish concealment, not his motive.\n`;
const worldPaths = ["world-entities/archive.md", "facts/evidence-concealed.md"];
const baselineCastPaths = ["characters/ada.md", "characters/neri.md", "relationships/ada-neri.md", arc];
const baselineArchitecture: Record<string, string> = {
  [arc]: bytes(arc).replace(/^characters: .*$/m, "characters: []") +
    "\nAda compares Neri's ledger with the daily register before asking the inquiry to accept a redacted account. The two records can establish concealment without exposing the witness; the final disclosure changes their relationship.\n",
  [disclosure]: bytes(disclosure).replace(/^fulfillment: .*$/m, "completeness: partial\nfulfillment: {any_of: []}") +
    "\nNeri shows Ada the ledger entry. She compares its date with the independently maintained daily register before deciding whether to protect him or challenge his account. The register can establish concealment, but cannot prove motive.\n",
  [reckoning]: "---\nschema: '0.1'\ntype: milestone\nid: milestone.reckoning\ntitle: The Redacted Account\nstatus: draft\ndecisions: []\ncompleteness: partial\nchange: The inquiry receives an independently corroborated account of concealment\narcs: [arc.truth]\nfulfillment: {any_of: []}\n---\n\nAfter the ledger comparison, Ada offers the inquiry a redacted account supported by both the signed entry and the independent daily register. The inquiry accepts proof of concealment without exposing the witness. Protecting Neri preserves his cooperation; challenging him produces a wary alliance, but neither route erases the corroborated conclusion.\n",
};
const baselineCompact: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v2",
  premise: "Ada investigates a missing archive witness and Neri's concealed ledger.",
  arcs: [{ id: "truth", goal: "Establish concealment while deciding what loyalty requires." }],
  beats: [
    { id: "disclosure", arcId: "truth", purpose: "Compare the disputed ledger to an independent daily register",
      dependsOn: [], observations: [], change: "The two dates establish concealment without proving motive.",
      decisions: [{ question: "How should Ada respond to Neri's concealment?", alternatives: [
        { action: "protect", lastingEffect: "Neri cooperates willingly with the inquiry." },
        { action: "challenge", lastingEffect: "Neri cooperates cautiously after a loss of trust." },
      ] }] },
    { id: "reckoning", arcId: "truth", purpose: "Submit a corroborated redacted account",
      dependsOn: ["disclosure"], observations: [], change: "The inquiry accepts the independently supported finding without exposing the witness.", decisions: [] },
  ],
  resolution: { question: "Can truth survive loyalty?", conclusion: "The inquiry establishes concealment while protecting the witness.",
    supportedBy: ["disclosure", "reckoning"], uncertainty: "The records cannot independently establish Neri's private motive." },
  causalAnswer: { question: "Why was the witness's ledger entry concealed?",
    answer: "Neri concealed the entry to avoid exposing the witness.", mechanism: "A signed ledger entry was withheld.",
    responsibility: "Neri withheld it.", motive: "Protect the witness.",
    proofApproach: "Compare the ledger date against the independently maintained daily register." },
  feasibility: { playthrough: "A compact visual novel with two connected turning points.",
    interaction: "One consequential choice with two relationship outcomes.", production: "Reuse the archive and two core characters.",
    endings: "The corroborated redacted account is accepted on both routes, with distinct trust consequences." },
};

export function archiveStages(job: JobStartResult, plan: TurnEvidence, adaptive = false, recoverEvent = false) {
  // The production #250 regression uses native IDs deliberately unrelated to
  // filenames, and a Milestone that belongs to two actual Arcs.
  const multi = process.env.NT_TEST_SCRIPTED_MULTI_ARC === "1";
  const truthPath = multi ? "arcs/archive-account.md" : arc;
  const secondArc = "arcs/witness-safety.md";
  const architecture = multi ? {
    [truthPath]: baselineArchitecture[arc]!,
    [secondArc]: baselineArchitecture[arc]!.replace("id: arc.truth", "id: arc.safety")
      .replace('title: "arc.truth"', 'title: "Witness safety"'),
    [disclosure]: baselineArchitecture[disclosure]!.replace("arcs: [arc.truth]", "arcs: [arc.truth, arc.safety]"),
    [reckoning]: baselineArchitecture[reckoning]!.replace("arcs: [arc.truth]", "arcs: [arc.safety]"),
  } : baselineArchitecture;
  const castPaths = multi ? [...baselineCastPaths.filter(p => p !== arc), truthPath, secondArc] : baselineCastPaths;
  const compact = multi ? { ...baselineCompact, arcs: [...baselineCompact.arcs,
    { id: "safety", goal: "Protect the archive witness while corroborating the account." }],
    beats: baselineCompact.beats.map(b => b.id === "reckoning" ? { ...b, arcId: "safety" } : b),
  } : baselineCompact;
  const foundationPath = "creative-direction/foundation.md";
  const foundation = adaptive ? readFileSync(join(job.worktreeStoryRoot, foundationPath), "utf8") : renderFoundation({
    id: "foundation", title: "The Archive Witness",
    premise: compact.premise, central_conflict: "Ada must prove concealment without exposing a witness.",
    genre: "Mystery", tone: "Intimate and suspenseful", player_experience: "Compare sources and make a consequential decision.",
    scope: "One archive, Ada and Neri, and two causal turning points.",
    decisions: [{ id: "author-brief", statement: plan.originalRequest, origin: "user", authority: "user-protected" }],
    body: "# The Archive Witness\n\n" + compact.premise + "\nAda compares the signed ledger with the independent daily register, then chooses whether to protect or challenge Neri. The redacted account establishes concealment without exposing the witness.",
  });
  let previous = "", step = 0;
  let rejectedHead: string | undefined;
  const correctionQuote = "Ada studies Neri's signature on the ledger before the player must decide.";
  return (index: number, context: { messages: readonly unknown[] }) => {
    const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
    const prompt = messages.filter(m => m.role === "user").flatMap(m =>
      typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
    if (previous !== prompt) { previous = prompt; step = 0; }
    const phase = step++;
    const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
    const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
    const skills = (skill: string) => boundedPinnedSources(skill).map(p => "skill://" + p);
    const write = (records: Record<string, string>) => ({ reason: "toolUse" as const,
      content: Object.entries(records).map(([path, content], i) => ({
        type: "toolCall" as const, name: "write", id: "archive-" + index + "-" + i, arguments: { path, content },
      })) });
    const validate = () => ({ reason: "toolUse" as const,
      content: [{ type: "toolCall" as const, name: "story_validate", id: "validate-" + index, arguments: {} }] });
    const manifest = (paths: string[]) => stop({ modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] });
    const onDisk = (p: string) => readFileSync(join(job.worktreeStoryRoot, p), "utf8");
    if (prompt.includes("read-only NovelTea objective orchestrator")) {
      if (!phase) return read(requiredOrchestratorSkillReads(plan.creativePolicy?.mode ?? "autonomous").map(p => "skill://" + p));
      assert.equal(phase, 1);
      return stop({ sourceSha: plan.source.verifiedSha, turnDigest: plan.digest,
        assignments: plan.assignments.map(a => ({ id: a.id, reason: "Carry out the authorized Story objective in causal order." })) });
    }
    if (recoverEvent && prompt.includes("SOURCE-BOUND STORY CORRECTION")) {
      if (!phase) {
        assert.ok(onDisk(eventPath).includes("value: known"));
        return write({ [eventPath]: openingEvent });
      }
      assert.equal(phase, 1);
      return stop({ modifiedRecords: [eventPath], architecturalConflicts: [],
        laterObligations: ["Formal Choice Point binding must enact protect and challenge before Milestone fulfillment."] });
    }
    if (recoverEvent && prompt.includes("Continue your ORIGINAL specialist Pi session to correct a rejected draft.")) {
      assert.ok(rejectedHead);
      if (!phase) return write({ [eventPath]: onDisk(eventPath) + "\n" + correctionQuote + "\n" });
      assert.equal(phase, 1);
      return stop("Clarified the original Event's visible evidence.");
    }
    if (prompt.includes("IMMUTABLE REVIEW PACKET")) {
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      assert.equal(packet.items.length, 1);
      const item = packet.items[0];
      assert.equal(item.assurance.turnDigest, plan.digest);
      const expected: Record<string, string[]> = {
        foundation: [foundationPath], architecture: Object.keys(architecture),
        "world-foundations": worldPaths, "character-foundations": castPaths,
        "event-disclosure": [eventPath], "event-reckoning": [secondEventPath, reckoning],
        "interactive-choice-disclosure": Object.keys(archiveInteractiveRecords[0]!),
        "interactive-puzzle-disclosure": Object.keys(archiveInteractiveRecords[1]!),
        "composition-disclosure": prosePaths, "composition-reckoning": [secondProsePath],
      };
      if (recoverEvent && rejectedHead && item.assurance.commitSha !== rejectedHead &&
          item.assurance.changedPaths.length === 1 && item.assurance.changedPaths[0] === eventPath &&
          onDisk(eventPath).includes(correctionQuote)) {
        return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: eventPath, line: 1,
            explanation: correctionQuote }],
          progressDiagnosis: { status: "material", reason: "Added visible observation.",
            evidence: { path: eventPath, quote: correctionQuote, change: "added" } } });
      }
      if (!phase) return read(skills("nt-narrative-review"));
      if (recoverEvent && item.reviewedWorkItem === "event-disclosure" && !rejectedHead) {
        rejectedHead = item.assurance.commitSha;
        assert.ok(!onDisk(eventPath).includes("value: known"));
        return stop({ sourceDigest: packet.sourceDigest, verdict: "fail", evidence: [],
          findings: [{ commitSha: rejectedHead, assignmentId: item.assignment.id, path: eventPath, line: 1,
            kind: "missing-requirement", message: "The visible evidence is insufficiently explicit.",
            requiredCorrection: correctionQuote, affectedPaths: [eventPath] }] });
      }
      const allowed = expected[item.reviewedWorkItem] ?? expected[item.assignment.id] ??
        (item.assurance.changedPaths.length === 1 && item.assurance.changedPaths[0] === disclosure &&
          onDisk(disclosure).includes("fulfillment: {any_of: [[event.disclose-ledger]]}") ? [disclosure] : undefined);
      assert.ok(allowed, "Unexpected archive Review assignment: " + item.assignment.id + " / " + item.reviewedWorkItem);
      assert.deepEqual([...item.assurance.changedPaths].sort(), [...allowed].sort());
      return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
        evidence: item.assurance.changedPaths.map((p: string) => {
          const canonical = item.canonicalContext.find((r: {path: string}) => r.path === p);
          assert.ok(canonical && canonical.content === onDisk(p));
          const line = canonical.content.split("\n").findIndex((l: string) => l.startsWith("id: ")) + 1;
          assert.ok(line > 0);
          return { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: p, line,
            explanation: "The scripted source contains the expected canonical record for this bounded assignment." };
        }) });
    }
    if (prompt.includes("AUTHORIZED SOURCE-BOUND EVENT MILESTONE CLOSEOUT")) {
      const proposal = JSON.parse(prompt.split("\nCONTROLLER PROPOSAL:\n")[1]!);
      assert.deepEqual(proposal.allowedPaths, [disclosure]);
      if (!phase) return read(prompt.split("PINNED REFERENCE PATHS:\n")[1]!.split("\nCANONICAL CONTEXT PATHS:")[0]!
        .split("\n").concat(prompt.split("CANONICAL CONTEXT PATHS:\n")[1]!.split("\nCONTROLLER PROPOSAL:")[0]!.split("\n")));
      if (phase === 1) return { reason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "closeout-" + index, name: "edit",
        arguments: { path: disclosure, edits: [{ oldText: "completeness: partial\nfulfillment: {any_of: []}",
          newText: "completeness: complete\nfulfillment: {any_of: [[event.disclose-ledger]]}" }] } }] };
      if (phase === 2) return validate();
      return stop({ verdict: "pass", evidence: [eventPath + ":1", "choice-points/loyalty.md:1"],
        reason: "The actual Event binds both reachable Choice outcomes; the original selected Milestone can close." });
    }
    if (prompt.includes("You are a pinned nt-narrative-composition author")) {
      const tail = prompt.split("\nASSIGNMENT:\n")[1]!;
      const assignment = JSON.parse(tail.slice(0, tail.lastIndexOf("}") + 1));
      const records = assignment.milestoneId === "milestone.disclosure"
        ? Object.fromEntries(prosePaths.map(p => [p, bytes(p)]))
        : { [secondProsePath]: secondProse };
      if (!phase) return read([...new Set([...skills("nt-narrative-composition"), "skill://nt-catalog/references/glossary.md", ...assignment.sourcePaths])]);
      if (phase === 1) return write(records);
      if (phase === 2) return validate();
      return manifest(Object.keys(records));
    }
    if (prompt.includes("INDEPENDENT READ-ONLY Composition editorial reviewer")) {
      const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!.split("\nEARLIER SEALED VERDICTS:")[0]!);
      const paths = assignment.milestoneId === "milestone.disclosure" ? prosePaths : [secondProsePath];
      if (!phase) return read([...prompt.split("\nPINNED SKILLS:\n")[1]!.split("\nCURRENT FILES:")[0]!.split("\n"), ...prompt.split("\nCURRENT FILES:\n")[1]!.split("\nREQUIREMENTS")[0]!.split("\n")]);
      for (const path of paths) assert.ok(onDisk(path).length > 100);
      const routes: string[] = JSON.parse(prompt.split("Current required routes: ")[1]!.replace(/\.$/, ""));
      return stop({ schema: "noveltea-composition-review/v2", status: "pass", findings: [], prior: [],
        sourceEvidence: (routes.length ? routes : ["Event-only authored consequence"]).map(r => {
          const p = paths.find(p => r.includes(p.replace("authored-content/", "").replace(".md", ""))) ?? paths[0]!;
          return r + " " + p + ":1: Verified player-facing route in canonical prose.";
        }) });
    }
    if (prompt.includes("You are the independent nt-narrative-review editor")) {
      const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!) as ReviewAssignment;
      if (!phase) return read(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!
        .split("\n").filter(p => p.startsWith("skill://")).concat(assignment.paths));
      const cite = (p: string, exact: string, label: string) => {
        assert.ok(assignment.paths.includes(p), p);
        const line = onDisk(p).split("\n").findIndex(t => t.includes(exact)) + 1;
        assert.ok(line > 0, p + ": " + exact);
        return label + " " + p + ":" + line + ": " + exact;
      };
      const evidence = [
        ...assignment.routes.map(r => cite("events/" + r.event.split(".")[1] + ".md", "- id: " + r.branch, r.event + "#" + r.step + "/" + r.branch)),
        ...assignment.milestoneRoutes.map(r => cite("milestones/" + r.milestone.split(".")[1] + ".md", "fulfillment:", r.milestone + "#" + r.alternative)),
        ...assignment.puzzleRoutes.map(r => cite("puzzles/" + r.puzzle.split(".")[1] + ".md", "solutions:", r.puzzle + "/" + r.event)),
      ];
      if (assignment.omission) {
        assert.equal(assignment.omission.assignmentId, "interactive:milestone.reckoning");
        assert.ok(onDisk(secondEventPath).includes("matching dates independently establish concealment"));
        evidence.push(cite(secondEventPath, "matching dates independently establish concealment", "No additional local player decision is necessary."));
      }
      for (const p of new Set((assignment.specialistAssignments ?? [])
        .flatMap(item => [...item.authority.existingPaths, ...(item.authority.newPaths ?? [])]))) {
        assert.ok(onDisk(p).length > 0, p);
        evidence.push(p + ":1: Independently inspected the assigned canonical record.");
      }
      if (!evidence.length) {
        const p = assignment.paths[0]!;
        assert.ok(onDisk(p).length > 0);
        evidence.push(p + ":1: Inspected the assigned canonical source.");
      }
      return stop({ verdict: "pass", findings: [], evidence });
    }
    if (prompt.includes("PLAN-LEVEL PACKET")) {
      const packet = JSON.parse(prompt.split("\nPLAN-LEVEL PACKET:\n")[1]!) as TurnFulfillmentPacket;
      if (!phase) return read(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nPLAN-LEVEL PACKET:")[0]!
        .split("\n").filter(p => p.startsWith("skill://")).concat(packet.canonical.map(c => c.path)));
      assert.equal(packet.source.turnDigest, plan.digest);
      const records = packet.canonical.filter(c => prosePaths.concat(secondProsePath).includes(c.path));
      assert.equal(records.length, 5);
      return stop({ digest: packet.digest, verdict: "complete", findings: [],
        checks: packet.objectives.map(o => ({ objectiveId: o.id, fulfilled: true,
          evidence: packet.canonical.filter(c => c.content.split("\n").some(t => t.startsWith("id:"))).map(c => ({ path: c.path, line: c.content.split("\n").findIndex(t => t.startsWith("id:")) + 1,
            explanation: "The complete source-bound archive contains the authored playable scene and its causal consequences." })) })) });
    }
    if (prompt.includes("READ-ONLY COMPACT STORY BLUEPRINT.") ||
        prompt.includes("INDEPENDENT READ-ONLY COMPACT STORY BLUEPRINT REVIEW")) {
      assert.equal(onDisk(foundationPath), foundation);
      if (!phase) return read(["skill://nt-story-architecture/SKILL.md", "skill://nt-catalog/SKILL.md", foundationPath]);
      assert.equal(phase, 1);
      return stop(prompt.includes("COMPACT STORY BLUEPRINT REVIEW")
        ? { schema: "noveltea-blueprint-review/v2", status: "pass", findings: [], prior: [] } : compact);
    }
    if (prompt.includes("INDEPENDENT READ-ONLY early reviewer")) {
      if (!phase) return read(["skill://nt-story-architecture/SKILL.md", "skill://nt-catalog/SKILL.md", foundationPath, ...Object.keys(architecture)]);
      for (const [p, expected] of Object.entries(architecture)) assert.equal(onDisk(p), expected);
      return stop({ schema: "noveltea-architecture-draft-review/v2", status: "pass", findings: [], prior: [] });
    }
    if (prompt.includes("AUTHORIZED PLAN AND SCOPE") && prompt.includes("CAUSAL_MILESTONE_ORDER")) {
      if (!phase) return read([...skills("nt-story-architecture"), foundationPath]);
      if (phase === 1) return write(architecture);
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return stop("Canonical Architecture authored.\nCAUSAL_MILESTONE_ORDER: milestone.disclosure,milestone.reckoning");
    }
    if (prompt.includes("BOUND ASSIGNMENT:") && prompt.includes("assigned ONE bounded canonical Story work item")) {
      const domain = prompt.includes('"domain": "world"') ? "world" : "character";
      assert.ok(prompt.includes('"domain": "' + domain + '"'));
      const paths = domain === "world" ? worldPaths : castPaths;
      if (!phase) return read([domain === "world" ? "skill://nt-worldbuilding/SKILL.md" : "skill://nt-character-development/SKILL.md",
        ...["SKILL.md", "references/records.md", "references/progression.md", "references/authority-and-validation.md", "references/glossary.md"].map(p => "skill://nt-catalog/" + p)]);
      if (phase === 1) return write(Object.fromEntries(paths.map(p => [p, p === truthPath || p === secondArc
        ? architecture[p]!.replace(/^characters: \[\]$/m, "characters: [character.ada, character.neri]") : bytes(p)])));
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return manifest(paths);
    }
    if (prompt.includes("READ-ONLY LOCAL MILESTONE BLUEPRINT") ||
        prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW")) {
      const first = prompt.includes("ONLY for milestone.disclosure.") ||
        prompt.includes('"milestoneId":"milestone.disclosure"');
      const milestonePath = first ? disclosure : reckoning;
      if (!phase) return read([...skills("nt-event-design"), milestonePath]);
      assert.equal(phase, 1);
      return stop(prompt.includes("MILESTONE PLAN REVIEW")
        ? { schema: "noveltea-milestone-blueprint-review/v5", status: "pass", findings: [], prior: [] }
        : { schema: "noveltea-milestone-blueprint/v1", milestoneId: first ? "milestone.disclosure" : "milestone.reckoning",
          events: [{ id: first ? "disclose-ledger" : "redacted-account",
            purpose: first ? "Neri shows Ada the ledger and offers a consequential choice" : "Submit the independently corroborated redacted account",
            dependsOn: [], participants: ["character.ada", "character.neri"],
            evidence: [{ anchorPath: milestonePath, source: "The signed ledger and independent daily register",
              observation: "The matching dates establish concealment", access: "Neri presents both original records to Ada",
              establishes: "The concealed entry is corroborated by an independent record", limits: "The records do not prove private motive", characterSources: [] }],
            knowledge: "Ada inspects the primary records and knows that the entry was concealed",
            routes: [] }],
          downstream: [...(first ? [{ owner: "interactive", obligation: "Bind protect and challenge as a genuine consequential Choice and preserve distinct payoffs" }] : []),
            { owner: "composition", obligation: "Present the corroborating evidence and the playable consequences of the verified Events" }],
        });
    }
    if (prompt.includes("Author exactly ONE Event-design cluster")) {
      const assignment = JSON.parse(prompt.split("\nAUTHORIZED ASSIGNMENT\n")[1]!);
      const first = assignment.milestoneId === "milestone.disclosure";
      assert.ok(first || assignment.milestoneId === "milestone.reckoning");
      const records: Record<string, string> = first ? { [eventPath]: recoverEvent ? openingEvent.replace("value: knows", "value: known") : openingEvent } :
        { [secondEventPath]: secondEvent, [reckoning]: secondMilestone(onDisk(reckoning)) };
      if (!phase) return read([...skills("nt-event-design"), assignment.milestonePath]);
      if (phase === 1) return write(records);
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return stop({ modifiedRecords: Object.keys(records), architecturalConflicts: [],
        laterObligations: first ? ["Formal Choice Point binding must enact protect and challenge before Milestone fulfillment."] :
          ["Present the independently corroborated redacted account in playable prose."] });
    }
    if (prompt.includes("Complete exactly ONE Choice unit") || prompt.includes("Assess exactly ONE Puzzle unit")) {
      const assignment = JSON.parse(prompt.split("\nAUTHORIZED ASSIGNMENT\n")[1]!);
      assert.equal(assignment.milestoneId, "milestone.disclosure");
      const choice = prompt.includes("Complete exactly ONE Choice unit");
      const records = { ...archiveInteractiveRecords[choice ? 0 : 1]! };
      if (recoverEvent && choice) records[eventPath] += "\n" + correctionQuote + "\n";
      if (!phase) return read(skills(choice ? "nt-interactive-narrative" : "nt-puzzle-design"));
      if (phase === 1) return write(records);
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return stop({ modifiedRecords: Object.keys(records), architecturalConflicts: [],
        laterObligations: ["Conditional player-facing prose must be reviewed for choice and clue visibility"] });
    }
    if (prompt.includes("You are the NovelTea foundation writing specialist")) {
      if (!phase) return read(["nt-story-discovery/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
        "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"].map(p => "skill://" + p));
      if (phase === 1) return write({ [foundationPath]: foundation });
      if (phase === 2) return validate();
      assert.equal(phase, 3);
      return manifest([foundationPath]);
    }
    throw Error("Unexpected archive baseline model prompt: " + prompt.slice(0, 1000));
  };
}

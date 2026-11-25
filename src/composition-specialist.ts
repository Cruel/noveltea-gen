import { createPiStatusTool } from "./pi-work-status.js";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist, StoryCancelledError } from "./story-interruption.js";
import { executeAssignmentRound, AssignmentAuthorPauseError, type AssignmentDefect, type AssignmentInvocationProof, type AssignmentRoundCommand, type AssignmentRoundResult } from "./assignment-metadata-recovery.js";
import { readJobControl } from "./job-control.js";
import { beginProtocolInvocation, recoverResponseContract, inspectCompletedProtocolResponse, ProtocolIntegrityBlockedError, authenticateSealedProtocolFailure, type SealedProtocolFailure } from "./response-contract-recovery.js";
import { selectSandboxPiTools, SANDBOX_TOOLS, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath, requirePinnedSkillReads } from "./pinned-skill-reads.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, guardPiBudget, piNarrativeGroup, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import { completedContextReads } from "./story-context.js";
import type { SkillConfig } from "./skills.js";
import { pinnedSkillReferences, type SkillSnapshot } from "./snapshot.js";
import { reviewCycleId, assertReviewCycleSession } from "./review-cycle.js";
import {
  compositionReviewConvergence,
  compositionReviewRequirements,
  parseCompositionReview,
  type CompositionReviewRound,
  type CompositionReviewVerdict,
} from "./composition-review-policy.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";

import { parseWriterDependencyFinding, type WriterDependencyFinding } from "./dependency-amendments.js";

export interface CompositionAssignment {
  dependencyObligations?: string[];
  milestoneBlueprint?: import("./milestone-obligation-handoff.js").ReviewedMilestoneHandoff;
  milestoneId: string;
  workItemId: string;
  authorTask?: string;
  authorContract: unknown;
  /** True only after the independent controller sealed BOTH Event-only omissions. */
  eventOnly: boolean;
  sourcePaths: string[];
  mandatoryReads: string[];
  allowedExistingContent: string[];
  eventIds: string[];
  composeTargets: string[];
  choicePoints: Array<{ id: string; events: string[]; outcomes: string[] }>;
  puzzleSolutions: Array<{ id: string; eventIds: string[] }>;
  branchWitnesses: Array<{ event: string; step: string; branch: string; witness: string[] }>;
  requiredSources: string[];
}
/** Verbatim policy shared by the live writer prompt and deterministic tests.
 * Do not turn a contingent account in an Event body into a performed route. */
export function compositionOptionalDialoguePolicy(eventOnly: boolean): string {
  if (!eventOnly) return "";
  return (
    "EVENT-ONLY SOURCE CONTRACT: The independently approved Event-only Milestone needs " +
    "playable prose for its enacted, typed Event steps, not a fabricated formal Choice. " +
    "If the Event narrative mentions possible OPTIONAL future witness testimony, voluntary " +
    "cooperation, refusal or withdrawal without typed routes/effects that enact them, " +
    "compose the unconditional actions, safety, independently earned evidence and " +
    "unpressured offer ONLY. Do NOT write the witness's account, agreement, trust, " +
    "publication consent or refusal as an accomplished fact in shared text. " +
    "Put unimplemented OPTIONAL testimony or its needed follow-up conditional Event " +
    "in laterObligations for separately authorized design; it is NOT a reason to " +
    "block the already-verified mandatory Event. If the original author really " +
    "requires that dialogue to fulfill THIS Milestone, report architecturalConflicts " +
    "instead and do not invent its branches. "
  );
}
export interface CompositionEvidence {
  dependencyFinding?: WriterDependencyFinding;
  modifiedRecords: string[];
  conflicts: string[];
  obligations: string[];
  skillReads: string[];
  piSessionFile?: string;
  piSessionId?: string;
  invocationProof?: AssignmentInvocationProof;
}
export interface SemanticReview {
  verdict: "pass" | "block";
  sourceEvidence: string[];
  concerns: string[];
  sessionFile?: string;
}

const catalog = [
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
];
const guidance = ["nt-narrative-composition/SKILL.md", ...catalog];
/** Extract the last complete JSON object from model text. A response may
 * contain a prose preface or fenced block; never parse partial nested braces. */
export function parseSpecialistJson(text: string): Record<string, unknown> {
  const objects: Record<string, unknown>[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const data: unknown = JSON.parse(text.slice(start, end + 1));
          if (data && typeof data === "object" && !Array.isArray(data))
            objects.push(data as Record<string, unknown>);
        } catch {
          /* next candidate */
        }
        break;
      }
    }
  }
  const match = objects.reverse().find((data) => "modifiedRecords" in data || "verdict" in data);
  if (!match) throw new Error("Composition specialist returned no parseable JSON manifest.");
  return match;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string" && s.length > 0);
}
async function createSession(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  assignment: CompositionAssignment,
  provider: string,
  modelId: string,
  thinking: "low" | "high" | undefined,
  phase: "write" | "review",
  extraPaths: string[] = [],
  insideWriter = false,
  original?: { file: string; id: string },
) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = {
    discovery: "explicit-only",
    novelteaSkills: snapshot.path,
    skillDirs: [],
    requiredSkills: ["nt-narrative-composition", "nt-catalog"],
  };
  const { loader, settingsManager } = createProjectResourceLoader(
    project,
    undefined,
    true,
    config,
    [],
    phase !== "write" ? "reviewer" : "specialist",
  );
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics)
    if (diag.type === "error") throw new Error("Composition skill discovery: " + diag.message);
  for (const name of ["nt-narrative-composition", "nt-catalog"]) {
    if (!skills.some((s) => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned composition specialist skill: " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const dir = join(job.stateDir, "composition-sessions", assignment.workItemId, phase);
  if (original && (!original.file.startsWith(dir + sep) ||
      await realpath(original.file) !== original.file || !(await lstat(original.file)).isFile()))
    throw new ProtocolIntegrityBlockedError("Composition session escaped its original assignment directory");
  const context = await preparePiContext(
    job,
    project,
    {
      group: piNarrativeGroup("composition:" + phase, assignment.sourcePaths, assignment.milestoneId),
      step: "composition:" + assignment.workItemId + ":" + phase,
      paths: [...assignment.sourcePaths, ...extraPaths],
      snapshot: snapshot.id,
      task: { kind: "dialogue", ids: assignment.eventIds, scope: "related" },
      provider,
      model: modelId,
      thinking,
      directory: dir,
      insideWriter,
    },
    runtime,
  );
  const sandboxTools = await selectSandboxPiTools(
    job,
    snapshot,
    skills,
    undefined,
    phase !== "write" ? "read-only" : "writer",
    phase !== "write" ? "reviewer" : "specialist",
  );
  const { session } = await createAgentSession({
    cwd: project.root,
    modelRuntime: runtime,
    model: context.model,
    thinkingLevel: context.thinking,
    resourceLoader: loader,
    settingsManager,
    sessionManager: original
      ? SessionManager.open(original.file, dirname(original.file), project.root) : context.manager,
    customTools: [
      ...(sandboxTools ?? []),
      ...(phase === "write" ? [createStoryValidateTool(job)] : []),
      context.contextTool,
      createPiStatusTool(),
    ],
    noTools: "all",
    tools:
      phase === "write"
        ? [...SANDBOX_TOOLS, "story_context", "story_validate", "report_status"]
        : [...SANDBOX_READ_ONLY_TOOLS, "story_context", "report_status"],
  });
  if (original && (session.sessionId !== original.id || session.sessionManager.getSessionFile() !== original.file)) {
    session.dispose();
    throw Error("Composition lost its original Pi session");
  }
  if (context.thinking && session.thinkingLevel !== context.thinking) {
    session.dispose();
    throw new Error("Pi did not honor requested thinking effort.");
  }
  return {
    session,
    project,
    context,
    sandboxed: !!sandboxTools,
    pinned: guidance.map((p) => join(snapshot.path, "skills", p)),
  };
}

function toolPaths(
  session: Awaited<ReturnType<typeof createSession>>["session"],
  projectRoot: string,
  snapshotRoot: string,
  from = 0,
) {
  const messages = session.messages.slice(from);
  const done = new Set(
    messages
      .filter((m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && !m.isError)
      .map((m) => m.toolCallId),
  );
  const direct = messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content
          .filter(
            (c): c is Extract<typeof c, { type: "toolCall" }> =>
              c.type === "toolCall" && done.has(c.id) && typeof c.arguments?.path === "string",
          )
          .map((c) => {
            const path = canonicalPinnedReadPath(c.arguments.path as string, projectRoot, snapshotRoot);
            return { tool: c.name, path, relative: relative(projectRoot, path).split(sep).join("/") };
          })
      : [],
  );
  return [
    ...direct,
    ...completedContextReads(messages, projectRoot).map((relativePath) => ({
      tool: "read",
      path: resolve(projectRoot, relativePath),
      relative: relativePath,
    })),
  ];
}
export function compositionInvocationDirectory(job: JobStartResult, workItem: string, sessionId: string, sourceDigest: string) {
  if (!/^composition-[a-z][a-z0-9-]*$/.test(workItem) || !/^[a-zA-Z0-9-]+$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(sourceDigest))
    throw Error("Invalid Composition invocation identity");
  return join(job.stateDir, "composition-invocations", workItem, sessionId, sourceDigest);
}
export async function authorComposition(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  assignment: CompositionAssignment,
  provider: string,
  modelId: string,
  thinking: "low" | "high" | undefined,
  onSession: (file: string, id: string) => Promise<void>,
  verifyDraft: (evidence: CompositionEvidence) => Promise<{ problems: string[]; stage: "pre-review" | "editorial";
    reviewProgress?: { receiptDigest: string; productive: boolean }; defects?: AssignmentDefect[] }>,
  original: { sourceDigest: string; authorize: () => Promise<void>; effect: () => Promise<string | null>;
    session?: { file: string; id: string }; continuation?: { sessionSha256: string; reportDigest: string } },
  round: AssignmentRoundCommand,
): Promise<CompositionEvidence | { round: AssignmentRoundResult }> {
  const { session, project, pinned, context, sandboxed } = await createSession(
    job,
    snapshot,
    assignment,
    provider,
    modelId,
    thinking,
    "write", [], true, original.session,
  );
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile, session.sessionId);
    const prompt =
      "You are a pinned nt-narrative-composition author for one bounded composition milestone. " +
      "FIRST read ALL pinned guidance files below using read, then read sourcePaths including Event steps, " +
      "Character voices, Relationship, Facts, Revelations, any optional clue discovery, and existing content. " +
      "If assignment.milestoneBlueprint is present, reconcile its named composition-owner " +
      "promises with actual, reachable canonical Event/Choice/Puzzle outcomes; provisional plan " +
      "text is NEVER proof that an Event or clue occurred.\n" +
      pinnedSkillReferences(snapshot, pinned) +
      "\n" +
      "Write real player-facing dialogue/narration in canonical authored-content/*.md only. " +
      "No engine records, no invented schema keys, no branch retcons. Edit ONLY allowedExistingContent " +
      "or add new Authored Content; do NOT alter other Story records, including Events, Choice Points, Milestones, " +
      "Character or Creative Direction, and do not edit read-only puzzle clue content. " +
      "Existing protected author wording must be preserved. Work from the least-informed reachable entry: " +
      "shared text cannot assume exclusive Choice outcomes, conditional Revelation, or optional clue. " +
      "Ensure one playable Authored Content document per Event in composeTargets, reusing valid existing documents; each has " +
      "events: [that-single-event] and revelations: [only Revelations presented by that Event]. " +
      "Do not combine all Event prose into one record; each file has exactly one playback owner. " +
      "Existing clue Authored Content in sourcePaths already covers its linked discovery Events: read " +
      "those records, leave them unchanged, and do not double-author their discovery text. " +
      "In the Choice Event file use literal headings '## Shared entry', '## Choice wording', and " +
      "'## <Outcome> selected' for EACH declared outcome. Menu contains selectable labels only; " +
      "the entry and menu never reveal branch-only truths or presume physical props. " +
      "A Choice Event can be reachable before optional clues: write its shared entry " +
      "and labels for the least-informed reachable route according to the ACTUAL " +
      "source prerequisites. A Revelation may be disclosed only on branches whose " +
      "explicit Event effects and prerequisites license that knowledge. Never copy " +
      "a branch-specific secret or clue into another outcome without a verified " +
      "shared prerequisite. Every later outcome-conditioned Event, including an " +
      "aftermath, needs distinct playable '## <Outcome> selected' sections for " +
      "every reachable condition branch, not a generic summary. For each ACTUAL " +
      "Puzzle solution Event in assignment.puzzleSolutions, ensure standalone " +
      "playable dialogue/narration under '## Solution consequence', using only " +
      "clues accessible on that route. If no Puzzle is assigned, do not invent " +
      "one. Never copy a clue exclusive to another route without an additional " +
      "verified prerequisite. Follow assignment.branchWitnesses and the actual " +
      "typed records; no fixture-specific characters, props, or secrets. " +
      "Do not write editorial directions as playable prose. " +
      "If a source lacks a needed route, report a conflict; NEVER manufacture new Event effects or bypass gates. " +
      compositionOptionalDialoguePolicy(assignment.eventOnly) +
      (sandboxed
        ? "Call story_validate with no arguments; Git and host shell access are unavailable in the sandbox. "
        : "Call story_validate with no arguments and inspect Git diff. Do not git add, reset, checkout or commit. ") +
      "Finally output ONE unfenced JSON object with the cumulative paths and precise obligations: " +
      '{"modifiedRecords":["authored-content/example.md"],"architecturalConflicts":[],"laterObligations":[]}. ' +
      "Graph will independently verify sources, actual Markdown, coverage and editorial review.\nASSIGNMENT:\n" +
      JSON.stringify(assignment, null, 2) +
      specialistAuthorInstruction(assignment.authorTask);
    if (!sessionFile) throw Error("Composition writer lacks an original session");
    let accepted: CompositionEvidence | undefined;
    const settled = await executeAssignmentRound({
      session, directory: compositionInvocationDirectory(job, assignment.workItemId, session.sessionId, original.sourceDigest),
      sourceDigest: original.sourceDigest,
      sessionRoots: [join(job.stateDir, "composition-sessions", assignment.workItemId, "write")],
      initialTranscriptSha256: original.continuation?.sessionSha256,
      initialPrompt: context.contextNote + (original.continuation ? "\nAUTHENTICATED VERIFIED PREREQUISITE " + original.continuation.reportDigest + ": Continue the original Composition after rereading the verified current sources.\n" : "") +
        (assignment.dependencyObligations ? "\nReport a genuinely necessary existing upstream correction with zero edits and dependencyFinding: " + JSON.stringify({ obligationIndex: 0, targetId: "typed.record-id", missing: "exact required correction", affectedIds: [assignment.milestoneId, "typed.record-id"], sources: [{path: "canonical/path.md", quote: "exact source quote"}], likelySpecialist: "owner-skill", authorDecisionRequired: false }) + ". Cite the original delivery obligation by index: " + JSON.stringify(assignment.dependencyObligations) + "\n" : "") + prompt,
      authorize: original.authorize, effect: original.effect,
      beforeTurn: async () => {
        const control = await readJobControl(job);
        if (control === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (control !== "running") throw new AssignmentAuthorPauseError();
        await guardPiBudget(job, "composition:" + assignment.workItemId + ":write", sessionFile);
        const after = await readJobControl(job);
        if (after === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (after !== "running") throw new AssignmentAuthorPauseError();
      },
      prompt: async text => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, text);
        await recordPiSession(job, sessionFile);
      },
      verify: async parsed => {
        await requirePinnedSkillReads(session, project.root, pinned, "Composition specialist");
        const calls = toolPaths(session, project.root, snapshot.path);
        if (assignment.mandatoryReads.some(p => !calls.some(c => c.tool === "read" && c.relative === p)))
          throw Error("Composition specialist omitted pinned skill or essential source reads.");
        const dependencyFinding = parsed.dependencyFinding === undefined ? undefined : parseWriterDependencyFinding(parsed.dependencyFinding);
        if (!dependencyFinding && !calls.some(c => ["write", "edit"].includes(c.tool) && c.relative.startsWith("authored-content/")))
          throw Error("Composition specialist did not author canonical Authored Content.");
        if (!strings(parsed.modifiedRecords) || !dependencyFinding && !parsed.modifiedRecords.length ||
            !strings(parsed.architecturalConflicts) || !strings(parsed.laterObligations))
          throw Error("Composition specialist must report complete modifiedRecords, architecturalConflicts and laterObligations.");
        if (dependencyFinding && (parsed.modifiedRecords.length || !parsed.architecturalConflicts.length))
          throw Error("Composition prerequisite must be an explicit no-write report.");
        const evidence: CompositionEvidence = { dependencyFinding, modifiedRecords: parsed.modifiedRecords,
          conflicts: parsed.architecturalConflicts, obligations: parsed.laterObligations,
          skillReads: pinned, piSessionFile: sessionFile, piSessionId: session.sessionId };
        const feedback = await verifyDraft(evidence);
        if (feedback.defects?.length) return feedback.defects;
        if (!feedback.problems.length) accepted = evidence;
        return feedback.problems.map(detail => ({ kind: feedback.stage === "editorial" ? "semantic" as const : "requirement" as const,
          path: assignment.milestoneId, code: createHash("sha256").update(feedback.stage + ":" + detail).digest("hex"), detail,
          ...(feedback.reviewProgress ? { reviewProgress: feedback.reviewProgress } : {}) }));
      },
    }, round);
    if (settled.status !== "accepted") return { round: settled };
    if (!accepted) throw Error("Original Composition invocation has no independently checked result");
    await context.completed(sessionFile, session.sessionId);
    return { ...accepted, invocationProof: settled.proof };
  } finally {
    session.dispose();
  }
}
/** The same read-only Pi session reviews every revision of this Composition
 * assignment. The trusted writer lock and the existing writing-phase recovery
 * barrier prevent a failed turn from silently replaying edits. */
export interface CompositionReviewPin {
  cycleId: string;
  round: number;
  receiptDigest: string;
}
type SessionIdentity = { id: string; file: string };
type CompositionReviewReceipt = {
  schema: "noveltea-composition-review-round/v1";
  cycleId: string;
  round: number;
  previousDigest: string | null;
  writer: SessionIdentity;
  reviewer: SessionIdentity;
  sources: Record<string, string>;
  sourceText: Record<string, string>;
  verdict: CompositionReviewVerdict;
  transcriptBytes: number;
  transcriptDigest: string;
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const reviewDirectory = (job: JobStartResult, cycleId: string) =>
  join(job.stateDir, "composition-review-cycles", cycleId);
const reviewRoundFile = (job: JobStartResult, cycleId: string, round: number) =>
  join(reviewDirectory(job, cycleId), "round-" + round + ".json");
const admissionFile = (job: JobStartResult, cycleId: string) =>
  join(reviewDirectory(job, cycleId), "admitted.json");

export function compositionReviewCycleId(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  assignment: CompositionAssignment,
  provider: string,
  model: string,
  baseHead: string,
  planVersion: number,
  planDigest: string,
) {
  return reviewCycleId({
    jobId: job.jobId,
    threadId: job.threadId,
    baseSha: job.baseSha,
    executionHead: baseHead,
    planVersion,
    contractDigest: planDigest,
    snapshotId: snapshot.id,
    provider,
    model,
    taskDigest: hash(JSON.stringify(assignment)),
  });
}
async function compositionSource(projectRoot: string, paths: readonly string[]) {
  const sources: Record<string, string> = {};
  for (const path of paths) {
    if (!/^authored-content\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(path))
      throw Error("Unsafe Composition review path: " + path);
    const absolute = join(projectRoot, path);
    if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isFile())
      throw Error("Composition review source path is unsafe.");
    sources[path] = await readFile(absolute, "utf8");
  }
  return sources;
}
async function reviewerTranscript(job: JobStartResult, reviewer: SessionIdentity) {
  const folder = join(job.stateDir, "composition-sessions");
  if (
    !reviewer.file.startsWith(folder + sep) ||
    (await realpath(reviewer.file)) !== reviewer.file ||
    !(await lstat(reviewer.file)).isFile()
  )
    throw Error("Composition reviewer transcript path is missing or unsafe.");
  const bytes = await readFile(reviewer.file);
  let header: { type?: string; id?: string };
  try {
    header = JSON.parse(bytes.toString("utf8").split("\n")[0] ?? "");
  } catch {
    throw Error("Composition reviewer transcript header is malformed.");
  }
  if (header.type !== "session" || header.id !== reviewer.id)
    throw Error("Composition reviewer transcript identity differs from sealed session.");
  return bytes;
}

/** A sealed verdict must be the Pi assistant's actual completed response,
 * not an assertion inserted into the controller receipt after the fact. */
function transcriptReviewVerdict(prefix: Buffer): unknown {
  let last: unknown;
  try {
    for (const line of prefix.toString("utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };
      };
      const message = entry.type === "message" ? entry.message : undefined;
      if (
        message?.role !== "assistant" ||
        ["error", "aborted"].includes(message.stopReason ?? "")
      )
        continue;
      const response = message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim()
        .replace(/^```(?:json)?\s*\n/i, "")
        .replace(/\n```\s*$/, "");
      if (response) {
        try {
          last = JSON.parse(response);
        } catch {
          /* bounded protocol correction may precede the final verdict */
        }
      }
    }
  } catch {
    throw Error("Composition reviewer transcript has corrupt persisted Pi evidence.");
  }
  if (!last) throw Error("Composition reviewer transcript lacks its actual editorial verdict.");
  return last;
}

function compositionReviewRoundSource(cycleId: string, round: number, writer: SessionIdentity,
  reviewer: SessionIdentity, previousDigest: string | null, sources: Record<string, string>) {
  return hash(JSON.stringify({ cycleId, round, writer, reviewer, previousDigest, sources }));
}

async function verifyCompositionRoundAuthority(job: JobStartResult, assignment: CompositionAssignment,
  receipt: CompositionReviewReceipt, history: CompositionReviewRound[]) {
  const base = join(reviewDirectory(job, receipt.cycleId), "round-" + receipt.round + ".protocol");
  const started = JSON.parse(await readFile(base + ".started.json", "utf8"));
  if (started.sessionId !== receipt.reviewer.id || started.sessionFile !== receipt.reviewer.file)
    throw new ProtocolIntegrityBlockedError("Composition protocol lost its admitted reviewer");
  const parse = (raw: string) => parseCompositionReview(raw, Object.keys(receipt.sourceText),
    receipt.sourceText, { assignment: JSON.stringify(assignment), policy: compositionReviewRequirements }, history);
  const verdict = await inspectCompletedProtocolResponse({
    receiptFile: base, contract: "composition.draft-review.v2",
    sourceDigest: compositionReviewRoundSource(receipt.cycleId, receipt.round, receipt.writer,
      receipt.reviewer, receipt.previousDigest, receipt.sourceText),
    sessionRoots: [join(job.stateDir, "composition-sessions", assignment.workItemId, "review")],
    sealedPrefix: { transcriptBytes: receipt.transcriptBytes, transcriptSha256: receipt.transcriptDigest },
    requireSealedTranscript: true,
    validate: raw => { try { parse(raw); return []; } catch { return [{ path: "$", expected: "source-bound editorial verdict" }]; } },
    parse,
  });
  if (JSON.stringify(verdict) !== JSON.stringify(receipt.verdict))
    throw new ProtocolIntegrityBlockedError("Composition review protocol differs from its round receipt");
}

export async function verifyCompositionReviewPin(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  assignment: CompositionAssignment,
  provider: string,
  model: string,
  baseHead: string,
  planVersion: number,
  planDigest: string,
  writer: SessionIdentity,
  paths: string[],
  pin: CompositionReviewPin,
  committedSource?: Record<string, string>,
) {
  const cycleId = compositionReviewCycleId(
    job,
    snapshot,
    assignment,
    provider,
    model,
    baseHead,
    planVersion,
    planDigest,
  );
  if (
    pin.cycleId !== cycleId ||
    !Number.isSafeInteger(pin.round) ||
    pin.round < 0 ||
    !/^[a-f0-9]{64}$/.test(pin.receiptDigest)
  )
    throw Error("Composition review pin does not match its authorized assignment.");
  const admitted = JSON.parse(await readFile(admissionFile(job, cycleId), "utf8")) as {
    schema: string;
    cycleId: string;
    writer: SessionIdentity;
    reviewer: SessionIdentity;
  };
  if (
    admitted.schema !== "noveltea-composition-review-admission/v1" ||
    admitted.cycleId !== cycleId ||
    admitted.writer.id !== writer.id ||
    admitted.writer.file !== writer.file
  )
    throw Error("Composition review admission has wrong writer provenance.");
  assertReviewCycleSession(writer, admitted.reviewer);
  await reviewerTranscript(job, writer);
  const current = committedSource ?? await compositionSource(job.worktreeStoryRoot, paths);
  let previousDigest: string | null = null;
  let sealedReview: SemanticReview | undefined;
  const history: CompositionReviewRound[] = [];
  for (let round = 0; round <= pin.round; round++) {
    const receipt = JSON.parse(
      await readFile(reviewRoundFile(job, cycleId, round), "utf8"),
    ) as CompositionReviewReceipt;
    if (
      receipt.schema !== "noveltea-composition-review-round/v1" ||
      receipt.cycleId !== cycleId ||
      receipt.round !== round ||
      receipt.previousDigest !== previousDigest ||
      receipt.writer.id !== writer.id ||
      receipt.writer.file !== writer.file ||
      !Number.isSafeInteger(receipt.transcriptBytes) ||
      receipt.transcriptBytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.transcriptDigest)
    )
      throw Error("Composition review round receipt has incorrect session or lineage.");
    assertReviewCycleSession(writer, receipt.reviewer, admitted.reviewer);
    const bytes = await reviewerTranscript(job, receipt.reviewer);
    if (
      bytes.length < receipt.transcriptBytes ||
      hash(bytes.subarray(0, receipt.transcriptBytes)) !== receipt.transcriptDigest
    )
      throw Error("Composition review transcript changed after its sealed verdict.");
    if (
      JSON.stringify(transcriptReviewVerdict(bytes.subarray(0, receipt.transcriptBytes))) !==
      JSON.stringify(receipt.verdict)
    )
      throw Error("Composition review receipt does not match the Pi review response.");
    const verified = parseCompositionReview(JSON.stringify(receipt.verdict), Object.keys(receipt.sourceText),
      receipt.sourceText, { assignment: JSON.stringify(assignment), policy: compositionReviewRequirements }, history);
    if (JSON.stringify(Object.fromEntries(Object.entries(receipt.sourceText).map(([p, v]) => [p, hash(v)]))) !==
        JSON.stringify(receipt.sources))
      throw Error("Composition review historical source changed");
    await verifyCompositionRoundAuthority(job, assignment, receipt, history);
    history.push({ sources: receipt.sourceText, verdict: verified });
    previousDigest = hash(JSON.stringify(receipt));
    if (
      round === pin.round &&
      (receipt.verdict.status !== "pass" ||
        previousDigest !== pin.receiptDigest ||
        JSON.stringify(Object.keys(receipt.sources).sort()) !== JSON.stringify([...paths].sort()) ||
        Object.keys(current).some((path) => hash(current[path]!) !== receipt.sources[path]))
    )
      throw Error("Composition review pass does not bind the current Authored Content.");
    if (round === pin.round)
      sealedReview = {
        verdict: "pass",
        concerns: [],
        sourceEvidence: receipt.verdict.sourceEvidence,
        sessionFile: receipt.reviewer.file,
      };
  }
  if (!sealedReview) throw Error("Composition review has no sealed current pass.");
  return sealedReview;
}

export async function authenticateCompositionDraftProtocol(job: JobStartResult,
  snapshot: SkillSnapshot, assignment: CompositionAssignment, provider: string, model: string,
  baseHead: string, planVersion: number, planDigest: string, writer: SessionIdentity,
  reviewerFile: string, paths: string[], proof: SealedProtocolFailure) {
  const cycleId = compositionReviewCycleId(job, snapshot, assignment, provider, model, baseHead, planVersion, planDigest);
  const admitted = JSON.parse(await readFile(admissionFile(job, cycleId), "utf8"));
  if (admitted.schema !== "noveltea-composition-review-admission/v1" ||
      admitted.cycleId !== cycleId || JSON.stringify(admitted.writer) !== JSON.stringify(writer) ||
      admitted.reviewer?.id !== proof.sessionId || admitted.reviewer.file !== reviewerFile)
    return false;
  assertReviewCycleSession(writer, admitted.reviewer);
  const bytes = await reviewerTranscript(job, admitted.reviewer);
  const history: CompositionReviewRound[] = [];
  let previous: string | null = null;
  for (let round = 0; existsSync(reviewRoundFile(job, cycleId, round)); round++) {
    const saved = JSON.parse(await readFile(reviewRoundFile(job, cycleId, round), "utf8")) as CompositionReviewReceipt;
    if (saved.cycleId !== cycleId || saved.round !== round || saved.previousDigest !== previous ||
        JSON.stringify(saved.writer) !== JSON.stringify(writer) ||
        JSON.stringify(saved.reviewer) !== JSON.stringify(admitted.reviewer) ||
        hash(bytes.subarray(0, saved.transcriptBytes)) !== saved.transcriptDigest ||
        JSON.stringify(Object.fromEntries(Object.entries(saved.sourceText).map(([p,v]) => [p,hash(v)]))) !== JSON.stringify(saved.sources))
      throw Error("Original Composition reviewer history changed");
    await verifyCompositionRoundAuthority(job, assignment, saved, history);
    if (saved.verdict.status !== "revise") return false;
    history.push({sources: saved.sourceText, verdict: saved.verdict});
    previous = hash(JSON.stringify(saved));
  }
  const sources = await compositionSource(job.worktreeStoryRoot, paths);
  const round = history.length;
  if (proof.contract !== "composition.draft-review.v2" ||
      proof.receiptFile !== join(reviewDirectory(job, cycleId), "round-" + round + ".protocol") ||
      proof.sourceDigest !== compositionReviewRoundSource(cycleId, round, writer, admitted.reviewer, previous, sources)) return false;
  return await authenticateSealedProtocolFailure(proof, [join(job.stateDir, "composition-sessions", assignment.workItemId, "review")]) === reviewerFile;
}

export async function createCompositionReviewCycle(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  assignment: CompositionAssignment,
  provider: string,
  modelId: string,
  thinking: "low" | "high" | undefined,
  writer: SessionIdentity,
  baseHead: string,
  planVersion: number,
  planDigest: string,
  onSession: (file: string) => Promise<void>,
) {
  const cycleId = compositionReviewCycleId(
    job,
    snapshot,
    assignment,
    provider,
    modelId,
    baseHead,
    planVersion,
    planDigest,
  );
  let originalReviewer: SessionIdentity | undefined;
  if (existsSync(admissionFile(job, cycleId))) {
    const admission = JSON.parse(await readFile(admissionFile(job, cycleId), "utf8"));
    if (admission.schema !== "noveltea-composition-review-admission/v1" ||
        admission.cycleId !== cycleId || admission.writer.id !== writer.id || admission.writer.file !== writer.file)
      throw Error("Original Composition Review admission changed");
    originalReviewer = admission.reviewer;
    if (!originalReviewer) throw Error("Original Composition Review lost reviewer");
    await reviewerTranscript(job, originalReviewer);
  }
  const { session, project, pinned, context } = await createSession(
    job, snapshot, assignment, provider, modelId, thinking, "review", [], true, originalReviewer,
  );
  try {
    const reviewer = { id: session.sessionId, file: session.sessionManager.getSessionFile() ?? "" };
    assertReviewCycleSession(writer, reviewer, originalReviewer);
    await mkdir(reviewDirectory(job, cycleId), { recursive: true });
    if (!originalReviewer) await writeFile(
      admissionFile(job, cycleId),
      JSON.stringify(
        {
          schema: "noveltea-composition-review-admission/v1",
          cycleId,
          writer,
          reviewer,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await onSession(reviewer.file);
    const history: CompositionReviewRound[] = [];
    let stalled = 0;
    let previousDigest: string | null = null;
    let lastReceipt: CompositionReviewReceipt | undefined;
    let lastProductive = false;
    const projection = (receipt: CompositionReviewReceipt) => ({
      review: { verdict: receipt.verdict.status === "pass" ? "pass" as const : "block" as const,
        sourceEvidence: receipt.verdict.sourceEvidence,
        concerns: receipt.verdict.findings.map(f => f.path + ": " + f.reason + " Repair: " + f.correction),
        sessionFile: reviewer.file },
      pin: receipt.verdict.status === "pass" ? { cycleId, round: receipt.round,
        receiptDigest: hash(JSON.stringify(receipt)) } : undefined,
      reviewProgress: { receiptDigest: hash(JSON.stringify(receipt)), productive: lastProductive },
    });
    if (originalReviewer) {
      const transcript = await reviewerTranscript(job, reviewer);
      for (let round = 0; existsSync(reviewRoundFile(job, cycleId, round)); round++) {
        const receipt = JSON.parse(await readFile(reviewRoundFile(job, cycleId, round), "utf8")) as CompositionReviewReceipt;
        if (receipt.schema !== "noveltea-composition-review-round/v1" || receipt.cycleId !== cycleId ||
            receipt.round !== round || receipt.previousDigest !== previousDigest ||
            receipt.writer.id !== writer.id || receipt.writer.file !== writer.file ||
            receipt.reviewer.id !== reviewer.id || receipt.reviewer.file !== reviewer.file ||
            receipt.transcriptBytes > transcript.length ||
            hash(transcript.subarray(0, receipt.transcriptBytes)) !== receipt.transcriptDigest ||
            JSON.stringify(transcriptReviewVerdict(transcript.subarray(0, receipt.transcriptBytes))) !== JSON.stringify(receipt.verdict) ||
            JSON.stringify(Object.fromEntries(Object.entries(receipt.sourceText).map(([p, v]) => [p, hash(v)]))) !== JSON.stringify(receipt.sources))
          throw Error("Composition reviewer history changed");
        const verified = parseCompositionReview(JSON.stringify(receipt.verdict), Object.keys(receipt.sourceText),
          receipt.sourceText, { assignment: JSON.stringify(assignment), policy: compositionReviewRequirements }, history);
        await verifyCompositionRoundAuthority(job, assignment, receipt, history);
        const convergence = compositionReviewConvergence(verified, receipt.sourceText, history, stalled);
        stalled = convergence.stalled;
        lastProductive = convergence.productive;
        history.push({ sources: receipt.sourceText, verdict: verified });
        previousDigest = hash(JSON.stringify(receipt));
        lastReceipt = receipt;
      }
      if (lastReceipt && transcript.length !== lastReceipt.transcriptBytes ||
          !lastReceipt && session.messages.some(m => m.role === "user" || m.role === "assistant"))
        throw Error("Composition reviewer has an uncertain unsealed invocation; never replay");
    }
    return {
      async review(paths: string[], requiredRoutes: string[]) {
        const sources = await compositionSource(project.root, paths);
        const prior = history.at(-1);
        if (lastReceipt && prior && JSON.stringify(sources) === JSON.stringify(prior.sources)) {
          if (lastReceipt.verdict.status === "pass" && requiredRoutes.some(route =>
              !lastReceipt!.verdict.sourceEvidence.some(line => line.toLowerCase().includes(route.toLowerCase()))))
            throw new ProtocolIntegrityBlockedError("Original Composition pass does not cover the required routes");
          return projection(lastReceipt);
        }
        if (lastReceipt?.verdict.status === "pass")
          throw new ProtocolIntegrityBlockedError("Composition source changed after its passing review");
        if (prior && JSON.stringify([...paths].sort()) !== JSON.stringify(Object.keys(prior.sources).sort()))
          throw Error("Composition review draft inventory changed mid-cycle; reconcile scope.");
        if (previousDigest) {
          const earlier = JSON.parse(
            await readFile(reviewRoundFile(job, cycleId, history.length - 1), "utf8"),
          ) as CompositionReviewReceipt;
          const bytes = await reviewerTranscript(job, reviewer);
          if (
            hash(JSON.stringify(earlier)) !== previousDigest ||
            bytes.length < earlier.transcriptBytes ||
            hash(bytes.subarray(0, earlier.transcriptBytes)) !== earlier.transcriptDigest
          )
            throw Error("Composition reviewer history changed between revisions.");
        }
        const protocolBase = join(reviewDirectory(job, cycleId), "round-" + history.length + ".protocol");
        const contract = "composition.draft-review.v2";
        const sourceDigest = compositionReviewRoundSource(cycleId, history.length, writer, reviewer, previousDigest, sources);
        if (existsSync(protocolBase + ".started.json"))
          throw new ProtocolIntegrityBlockedError("Original Composition reviewer invocation is unsettled; never replay");
        const control = await readJobControl(job);
        if (control === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (control !== "running") throw new AssignmentAuthorPauseError();
        const start = session.messages.length;
        await guardPiBudget(
          job,
          "composition:" + assignment.workItemId + ":editorial-review:" + history.length,
          reviewer.file,
        );
        const changed = Object.fromEntries(
          paths
            .filter((path) => prior && prior.sources[path] !== sources[path])
            .map((path) => [path, { before: hash(prior!.sources[path]!), after: hash(sources[path]!) }]),
        );
        const prompt =
          (history.length
            ? "CONTINUE YOUR SAME INDEPENDENT READ-ONLY COMPOSITION REVIEW. Your earlier " +
              "analysis is available but never source authority. Explicitly reconcile all past " +
              "material concerns as resolved, improved, persisting or regressed. Check CURRENT " +
              "source and newly introduced or previously overlooked material defects.\n"
            : context.contextNote + "You are an INDEPENDENT READ-ONLY Composition editorial reviewer.\n") +
          "Read every pinned skill and the complete current Authored Content, linked Events, " +
          "Choice and Puzzle witnesses, Facts, Revelations and least-informed route. " +
          "Never edit, invoke shell, or treat Event planning narration or writer assurance " +
          "as proof of earned player knowledge. Preserve protected wording; optional testimony " +
          "is not enacted without typed effects. Do not impose cosmetic preferences or later-stage " +
          "requirements on this assignment. Route evidence must cover all actual assigned " +
          "Choice outcomes and Puzzle solutions; inspect reviewed Milestone Blueprint " +
          "obligations in ASSIGNMENT when supplied, but accept only verified canonical " +
          "Event routes and player-facing prose as evidence of discharge. In particular, " +
          "do not narrate refused evidence, branch-only knowledge at shared entry, or " +
          "a provisional Event as enacted. A pass needs a full present-stage rereview.\n" +
          "PINNED SKILLS:\n" +
          pinnedSkillReferences(snapshot, pinned) +
          "\nCURRENT FILES:\n" +
          [...new Set([...assignment.sourcePaths, ...paths])].join("\n") +
          "\nREQUIREMENTS (quote exact substrings):\n" +
          compositionReviewRequirements +
          "\nASSIGNMENT:\n" +
          JSON.stringify(assignment) +
          "\nEARLIER SEALED VERDICTS:\n" +
          JSON.stringify(
            history.map((r, i) => ({
              round: i,
              verdict: r.verdict,
              sourceDigests: Object.fromEntries(Object.entries(r.sources).map(([p, v]) => [p, hash(v)])),
            })),
          ) +
          "\nCURRENT SOURCE DIGESTS:\n" +
          JSON.stringify(Object.fromEntries(Object.entries(sources).map(([p, v]) => [p, hash(v)]))) +
          "\nCHANGED SOURCE DIGESTS:\n" +
          JSON.stringify(changed) +
          "\nReturn ONLY strict JSON: {schema:'noveltea-composition-review/v2'," +
          "status:'pass'|'revise',findings:[],prior:[],sourceEvidence:[]}. " +
          "For each current material finding: {path,reason,correction,requirement:{source:" +
          "'assignment'|'policy',quote},evidence:{path,quote},origin:'initial'|'continuing'|" +
          "'introduced'|'overlooked'}. " + (history.length ? "Origin initial is forbidden after round zero. " : "All findings must be initial in round zero. ") +
          "Quotes must be exact 8+ character substrings " +
          "of the cited requirement and current Authored Content path. On follow-ups " +
          "include one prior entry for EVERY historical finding: " +
          "{round,findingIndex,status:'resolved'|'improved'|'persisting'|'regressed'," +
          "reason,evidence:{path,quote}} with a CURRENT quote from that original path. " +
          "Pass requires findings:[], all prior resolved, and sourceEvidence for each " +
          "actual route. A revise verdict needs 1-8 actionable current blockers. " +
          "Current required routes: " +
          JSON.stringify(requiredRoutes) +
          ".";
        const after = await readJobControl(job);
        if (after === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (after !== "running") throw new AssignmentAuthorPauseError();
        await beginProtocolInvocation({ receiptFile: protocolBase, contract, sourceDigest, session });
        await registerPendingPiSession(job, reviewer.file);
        await promptStorySpecialist(session, prompt);
        await recordPiSession(job, reviewer.file);
        const mandatory = [
          ...pinned,
          ...[...assignment.mandatoryReads, ...paths].map((path) => resolve(project.root, path)),
        ];
        const missingReads = () => {
          const calls = toolPaths(session, project.root, snapshot.path, start);
          return mandatory.filter((path) => !calls.some((c) => c.tool === "read" && c.path === path));
        };
        if (missingReads().length)
          throw new ProtocolIntegrityBlockedError("Composition review omitted mandatory current-round method/source reads");
        const parse = (raw: string) => {
          const result = parseCompositionReview(
            raw,
            paths,
            sources,
            {
              assignment: JSON.stringify(assignment),
              policy: compositionReviewRequirements,
            },
            history,
          );
          if (
            result.status === "pass" &&
            requiredRoutes.some(
              (route) =>
                !result.sourceEvidence.some((line) => line.toLowerCase().includes(route.toLowerCase())),
            )
          )
            throw Error("Composition editorial pass omitted source-linked Choice/Puzzle route evidence.");
          return result;
        };
        const verdict = await recoverResponseContract({
          session, contract, sourceDigest, receiptFile: protocolBase + ".initial.json", sealTranscript: true,
          validate: raw => { try { parse(raw); return []; } catch (error) { return [{ path: "$", expected: error instanceof Error && /^(findings\[\d+\]\.origin:|Composition (?:review|reviewer|finding|continuing|previous|editorial) )/.test(error.message) ? error.message : "exact source-bound independent verdict" }]; } },
          parse,
          beforeCorrection: async () => {
            if (JSON.stringify(await compositionSource(project.root, paths)) !== JSON.stringify(sources))
              throw new ProtocolIntegrityBlockedError("Composition source changed before format correction");
            const control = await readJobControl(job);
            if (control === "cancelled") throw new StoryCancelledError(assignment.workItemId);
            if (control !== "running") throw new AssignmentAuthorPauseError();
            await guardPiBudget(job, "composition:" + assignment.workItemId + ":editorial-review:" + history.length, reviewer.file);
          },
          feedback: failures => "Return the exact source-linked editorial JSON contract, including every historical finding. " +
            (history.length ? "Origin initial is forbidden; use continuing, introduced or overlooked. " : "Every finding origin must be initial. ") +
            "No tools or new source claims; correct only the response format. Validation: " + failures.map(f => f.expected).join("; "),
          prompt: async text => {
            await registerPendingPiSession(job, reviewer.file);
            await promptStorySpecialist(session, text);
            await recordPiSession(job, reviewer.file);
          },
        });
        if (JSON.stringify(await compositionSource(project.root, paths)) !== JSON.stringify(sources))
          throw Error("Composition prose changed while the independent reviewer read it.");
        const convergence = compositionReviewConvergence(verdict, sources, history, stalled);
        stalled = convergence.stalled;
        lastProductive = convergence.productive;
        await context.completed(reviewer.file, reviewer.id);
        const transcript = await reviewerTranscript(job, reviewer);
        const receipt: CompositionReviewReceipt = {
          schema: "noveltea-composition-review-round/v1",
          cycleId,
          round: history.length,
          previousDigest,
          writer,
          reviewer,
          sources: Object.fromEntries(Object.entries(sources).map(([p, v]) => [p, hash(v)])),
          sourceText: sources,
          verdict,
          transcriptBytes: transcript.length,
          transcriptDigest: hash(transcript),
        };
        await writeFile(
          reviewRoundFile(job, cycleId, history.length),
          JSON.stringify(receipt, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        previousDigest = hash(JSON.stringify(receipt));
        history.push({ sources, verdict });
        lastReceipt = receipt;
        return {
          review: {
            verdict: verdict.status === "pass" ? ("pass" as const) : ("block" as const),
            sourceEvidence: verdict.sourceEvidence,
            concerns: verdict.findings.map((f) => f.path + ": " + f.reason + " Repair: " + f.correction),
            sessionFile: reviewer.file,
          },
          reviewProgress: { receiptDigest: previousDigest, productive: lastProductive },
          pin:
            verdict.status === "pass"
              ? ({
                  cycleId,
                  round: history.length - 1,
                  receiptDigest: previousDigest,
                } as CompositionReviewPin)
              : undefined,
        };
      },
      dispose() {
        session.dispose();
      },
    };
  } catch (error) {
    session.dispose();
    throw error;
  }
}

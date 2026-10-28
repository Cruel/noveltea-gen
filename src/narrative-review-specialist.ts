import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import type { JobStartResult } from "./job.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { SkillConfig } from "./skills.js";
import { parseSpecialistJson } from "./composition-specialist.js";

export type ReviewDimension = "continuity" | "pacing" | "characterization" | "puzzle-fairness" |
  "player-agency" | "dramatic-payoff" | "conditional-knowledge" | "obligation";
export interface EditorialFinding {
  severity: "blocking" | "advisory";
  dimension: ReviewDimension;
  source: string;
  message: string;
  repair: "composition" | "event" | "interactive" | "architecture" | "protected";
}
export interface EditorialVerdict {
  verdict: "pass" | "block";
  findings: EditorialFinding[];
  evidence: string[];
  sessionFile?: string;
}
export interface ReviewAssignment {
  contract: unknown;
  planVersion: number;
  scopeIds: string[];
  paths: string[];
  routes: Array<{ event: string; step: string; branch: string; status: string; witness: string[] }>;
  milestoneRoutes: Array<{ milestone: string; alternative: number; status: string; witness: string[] }>;
  puzzleRoutes: Array<{ puzzle: string; event: string; status: string; clueAccess: string }>;
  outstanding: Array<{ id: string; message: string }>;
  uncertainties: string[];
}
const guidance = ["nt-narrative-review/SKILL.md", "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md", "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md"];
const dimensions: ReviewDimension[] = ["continuity", "pacing", "characterization",
  "puzzle-fairness", "player-agency", "dramatic-payoff", "conditional-knowledge", "obligation"];
const repairs = ["composition", "event", "interactive", "architecture", "protected"];
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(x => typeof x === "string" && x.trim().length > 0);

export function checkEditorialVerdict(value: unknown, assignment: ReviewAssignment): EditorialVerdict {
  const v = value as Partial<EditorialVerdict> | null;
  if (!v || !["pass", "block"].includes(v.verdict ?? "") ||
      !isStringArray(v.evidence) || !Array.isArray(v.findings) ||
      !v.findings.every(f => f && ["blocking", "advisory"].includes(f.severity) &&
        dimensions.includes(f.dimension) && typeof f.source === "string" &&
        /^(.+\.(md|yaml):[1-9][0-9]*|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*#.+)$/.test(f.source) &&
        typeof f.message === "string" && f.message.trim() && repairs.includes(f.repair))) {
    throw new Error("Independent narrative reviewer returned invalid severity/source-linked editorial findings.");
  }
  if ((v.verdict === "pass") !== !v.findings.some(f => f.severity === "blocking"))
    throw new Error("Narrative reviewer verdict conflicts with blocking findings.");
  // A source-linked attestation for every selected route, not just a generic yes.
  const routes = [...assignment.routes.map(r => r.event + "#" + r.step + "/" + r.branch),
    ...assignment.milestoneRoutes.map(r => r.milestone + "#" + r.alternative),
    ...assignment.puzzleRoutes.map(r => r.puzzle + "/" + r.event)];
  if (routes.some(route => !v.evidence!.some(line =>
    line.includes(route) && /[a-z][a-z0-9-]*\/[^\s:]+\.md:[1-9][0-9]*/.test(line)))) {
    throw new Error("Narrative reviewer omitted a source-linked file:line for a representative route witness.");
  }
  if (!v.evidence.length || !v.evidence.some(line =>
    /[a-z][a-z0-9-]*\/[^\s:]+\.md:[1-9][0-9]*/.test(line)))
    throw new Error("Narrative review cannot pass without source-linked file and line evidence.");
  return { verdict: v.verdict!, findings: v.findings, evidence: v.evidence };
}

async function sessionFor(job: JobStartResult, snapshot: SkillSnapshot, provider: string,
  modelId: string, thinking: "low" | "high" | undefined, role: "review" | "repair",
  originalSessionFile?: string) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: role === "review"
      ? ["nt-narrative-review", "nt-catalog"] : ["nt-narrative-composition", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const required = role === "review" ? ["nt-narrative-review", "nt-catalog"] : ["nt-narrative-composition", "nt-catalog"];
  if (loader.getSkills().diagnostics.some(d => d.type === "error") ||
      required.some(name => !loader.getSkills().skills.some(s => s.name === name &&
        s.filePath.startsWith(join(snapshot.path, "skills") + sep)))) {
    throw new Error("Missing or invalid pinned narrative review/repair skills.");
  }
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(m => m.id === modelId))
    throw new Error("Unavailable narrative reviewer model or credentials: " + provider + "/" + modelId);
  const dir = join(dirname(job.worktreeRoot), "review-sessions", role);
  await mkdir(dir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, thinkingLevel: thinking,
    resourceLoader: loader, settingsManager,
    sessionManager: role === "repair" && originalSessionFile
      ? SessionManager.open(originalSessionFile, dirname(originalSessionFile), project.root)
      : SessionManager.create(project.root, dir),
    noTools: "all", tools: role === "review"
      ? ["read", "grep", "find", "ls"] : ["read", "edit", "write", "grep", "find", "ls"],
  });
  if (thinking && session.thinkingLevel !== thinking) {
    session.dispose(); throw new Error("Pi failed to honor narrative review thinking effort.");
  }
  return { session, project, pinned: (role === "review" ? guidance :
    ["nt-narrative-composition/SKILL.md", ...guidance.slice(1)])
    .map(p => join(snapshot.path, "skills", p)) };
}
function lastReply(session: Awaited<ReturnType<typeof sessionFor>>["session"]) {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
    throw new Error("Narrative Pi turn failed or produced no answer.");
  return last.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
function completedReads(session: Awaited<ReturnType<typeof sessionFor>>["session"], root: string) {
  const completed = new Set(session.messages.filter(
    (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && !m.isError)
    .map(m => m.toolCallId));
  return session.messages.flatMap(m => m.role === "assistant"
    ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
      c.type === "toolCall" && c.name === "read" &&
      completed.has(c.id) && typeof c.arguments?.path === "string")
      .map(c => resolve(root, c.arguments.path as string)) : []);
}

export async function reviewNarrative(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: ReviewAssignment, provider: string, model: string,
  thinking: "low" | "high" | undefined, onSession: (file: string) => Promise<void>,
): Promise<EditorialVerdict> {
  const { session, project, pinned } = await sessionFor(job, snapshot, provider, model, thinking, "review");
  try {
    const file = session.sessionManager.getSessionFile();
    if (file) await onSession(file);
    await session.prompt("You are the independent nt-narrative-review editor, not the author. " +
      "FIRST read every pinned review/catalog reference and EVERY supplied Story path. " +
      "Examine actual saved prose, not a writer's summary. Analyze continuity, pacing, " +
      "Character voice/motivation, Puzzle fairness and accessible clues, player agency, " +
      "dramatic payoff, conditional Revelations and branch-exclusive player/Character knowledge. " +
      "Use the bounded progression witnesses as representative routes, NOT exhaustive proof. " +
      "Review every listed Choice outcome and Puzzle solution, including least-informed routes. " +
      "Assess scope constraints, production envelope, and binding obligations. " +
      "Report actionable blocking/advisory findings with canonical source file:line or typed event#step/branch. " +
      "Label each repair owner composition/event/interactive/architecture/protected; " +
      "protected or architectural revisions MUST escalate, not be automatically edited. " +
      "Do not edit files or invoke shell. If evidence is insufficient, block. " +
      "Return ONE unfenced JSON object: " +
      '{ "verdict":"pass|block", "findings":[{"severity":"blocking|advisory","dimension":"continuity|pacing|characterization|puzzle-fairness|player-agency|dramatic-payoff|conditional-knowledge|obligation","source":"authored-content/a.md:12","message":"...","repair":"composition|event|interactive|architecture|protected"}], "evidence":["event.x#step/branch: source.md:line ...","puzzle.x/event.y: source.md:line ..."] }. ' +
      "Provide source-linked evidence for EVERY event#step/branch, milestone#alternative, and puzzle/event route.\n" +
      "PINNED REFERENCES:\n" + pinned.join("\n") + "\nSTORY PATHS:\n" +
      assignment.paths.join("\n") + "\nASSIGNMENT:\n" + JSON.stringify(assignment, null, 2));
    const reads = new Set(completedReads(session, project.root));
    if ([...pinned, ...assignment.paths.map(p => join(project.root, p))]
      .some(p => !reads.has(p))) throw new Error("Independent narrative reviewer did not read pinned skills and scoped Story records.");
    const verdict = checkEditorialVerdict(parseSpecialistJson(lastReply(session)), assignment);
    return { ...verdict, sessionFile: file ?? undefined };
  } finally { session.dispose(); }
}

/** Repair only prose already authorized by the scope. Never grant the writer
 * authority to change protected decisions or architecture from a review. */
export async function repairNarrativeProse(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: ReviewAssignment, findings: EditorialFinding[], paths: string[],
  provider: string, model: string, thinking: "low" | "high" | undefined,
  originalSessionFile: string, onSession: (file: string) => Promise<void>,
  verify: () => Promise<void>,
): Promise<void> {
  const { session, pinned } = await sessionFor(job, snapshot, provider, model, thinking,
    "repair", originalSessionFile);
  try {
    const file = session.sessionManager.getSessionFile();
    if (file) await onSession(file);
    const prompt = "You are CONTINUING your original nt-narrative-composition writing session, " +
      "not beginning a new creative assignment. You are repairing a bounded " +
      "editorial review. FIRST read all pinned references and the scoped Story sources. " +
      "Edit ONLY the existing Authored Content files listed in ALLOWED WRITES. No new files. " +
      "Do not edit Event, Choice Point, Puzzle, Character, World, Creative Direction, " +
      "Revelation, protected decisions, or any other records. Preserve complete playable " +
      "route coverage and do not assume optional knowledge in shared text. " +
      "The independent editor found:\n" + JSON.stringify(findings) +
      "\nREFERENCES:\n" + pinned.join("\n") + "\nSOURCES:\n" +
      assignment.paths.join("\n") + "\nALLOWED WRITES:\n" + paths.join("\n");
    await session.prompt(prompt);
    await verify();
    // The graph separately validates and performs an independent editorial re-review.
  } finally { session.dispose(); }
}

/** An independent, read-only look at the *uncommitted* Architecture draft.
 * This is feedback to the original writer, NOT the postcommit mandatory
 * independent semantic review or an authorization to modify Story scope. */
import { join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";
import type { CausalBlueprint } from "./architecture-blueprint.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { authorizedArchitectureRecordPath } from "./architecture-record-path.js";

/** Two original-session corrections, each followed by independent read-only rereview. */
export const ARCHITECTURE_DRAFT_CORRECTION_LIMIT = 2;

export interface ArchitectureDraftReview {
  status: "pass" | "revise";
  findings: Array<{ path: string; reason: string; correction: string }>;
}

/** Preserve the original independent reviewer session when its JSON verdict
 * contains a typo or unbounded field. No reviewer finding is accepted by
 * string normalization: Pi must return a new, exact typed verdict itself. */
export function architectureDraftFormatCorrection(paths: readonly string[]): string {
  if (!paths.length || paths.length > 32 || paths.some(path => !authorizedArchitectureRecordPath(path)))
    throw Error("Architecture draft format correction lacks authorized record paths.");
  return "INDEPENDENT DRAFT VERDICT FORMAT CORRECTION (same read-only session): " +
    "Your last answer was not a valid bounded JSON verdict. It may have used " +
    "an incorrect source path, an unsupported key or an oversized finding. " +
    "Do not edit any files or change the standards of review. Return the COMPLETE " +
    "independent findings for the exact source draft you already read. " +
    "Use STRICT JSON with EXACT keys status, findings; status must be pass " +
    "with [] or revise with 1-8 concrete findings. Each finding has EXACT keys " +
    "path, reason, correction, and reason/correction are nonempty and at most " +
    "750 characters. Each path must EXACTLY match one entry in this authorized " +
    "array (use a forward slash, not a period, between folder and filename): " +
    JSON.stringify(paths) + ". No additional keys, explanations, or code fences. " +
    "This correction grants no write scope, approval or source change.";
}

export function parseArchitectureDraftReview(raw: string, paths: readonly string[]): ArchitectureDraftReview {
  const text = raw.trim().replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, "");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw Error("Independent draft reviewer returned invalid JSON; preserve draft."); }
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "findings,status" ||
      !["pass", "revise"].includes(String(record.status)) || !Array.isArray(record.findings) ||
      record.findings.length > 8 ||
      (record.status === "pass" ? record.findings.length !== 0 : record.findings.length === 0) ||
      record.findings.some(f => {
        if (!f || typeof f !== "object" || Array.isArray(f)) return true;
        const finding = f as Record<string, unknown>;
        return Object.keys(finding).sort().join(",") !== "correction,path,reason" ||
          typeof finding.path !== "string" || !paths.includes(finding.path) ||
          !authorizedArchitectureRecordPath(finding.path) ||
          typeof finding.reason !== "string" || !finding.reason.trim() || finding.reason.length > 750 ||
          typeof finding.correction !== "string" || !finding.correction.trim() || finding.correction.length > 750;
      }))
    throw Error("Independent draft review contains missing, unbounded or unauthorized findings.");
  return record as unknown as ArchitectureDraftReview;
}

export async function reviewArchitectureDraft(
  job: JobStartResult, snapshot: SkillSnapshot, plan: Plan,
  provider: string, model: string, paths: string[], iteration: number,
  blueprint?: CausalBlueprint,
): Promise<ArchitectureDraftReview> {
  if (!paths.length || paths.length > 32 || paths.some(p => !authorizedArchitectureRecordPath(p)) ||
      !Number.isInteger(iteration) || iteration < 0 || iteration > ARCHITECTURE_DRAFT_CORRECTION_LIMIT)
    throw Error("Architecture draft reviewer lacks bounded authorized Arc/Milestone paths.");
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-story-architecture", "nt-catalog"],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-story-architecture", "nt-catalog"].every(name =>
        skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Independent Architecture draft feedback lacks pinned method resources.");
  const runtime = await createJobModelRuntime();
  const reviewStep = "architecture:precommit-review:" + plan.version + ":" + iteration;
  const context = await preparePiContext(job, project, {
    // A separate correction round needs a separate read-only reviewer session,
    // even when all verdicts are recorded in the same transcript directory.
    group: reviewStep, step: reviewStep,
    paths: [], snapshot: snapshot.id, provider, model,
    directory: join(job.stateDir, "architecture-draft-review-sessions"),
    // The writer owns the lease and has an uncommitted draft: do not wait for
    // an unrelated author prompt or obtain write authority here.
    insideWriter: true,
  }, runtime);
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined,
    "read-only", "specialist");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: safeTools ?? [],
    noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw Error("Independent Architecture draft reviewer changed its pinned thinking policy.");
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw Error("Independent draft review requires a durable Pi transcript.");
    await context.beforeTurn(sessionFile);
    await promptStorySpecialist(session,
      context.contextNote +
      "You are an INDEPENDENT READ-ONLY early reviewer of an uncommitted NovelTea Arc/Milestone " +
      "draft. You are not the author, final reviewer, controller or approval authority. " +
      "Use the read tool to inspect skill://nt-story-architecture/SKILL.md, " +
      "skill://nt-catalog/SKILL.md, creative-direction/foundation.md and ALL changed paths " +
      "listed below. Never edit, write, approve, run a shell or read private inbox files. " +
      "Evaluate actual source prose against the APPROVED Creative Direction and the " +
      "whole-Story contract, not merely frontmatter. Flag only concrete, source-specific " +
      "fixable issues: unexplained causal prerequisites/turning points, promised " +
      "investigations without independently testable observations, missing reasons or " +
      "lasting aftermath for major player Choices after route reconvergence, " +
      "mutually exclusive branch lengths summed as simultaneous playtime, " +
      "and author budget violations. A narrative-led Story need not invent Puzzles; " +
      "a choice-heavy Story needs distributed consequential alternatives, but do not " +
      "impose per-Milestone quotas. At planning stage, a specific proposed future " +
      "on-page clue, record or witness encounter is legitimate delegated design, " +
      "not an already-proven World Fact. Do not require earlier Event/Fact records " +
      "to exist yet, but DO require a specific plausible planned source and " +
      "a causal path from what it could establish to each promised conclusion. " +
      "Architecture must NOT invent Event IDs or completed " +
      "fulfillment: later specialists own those records. Do not demand later-stage files. " +
      "Inspect ALL changed Arc/Milestone records and report ALL concrete, material " +
      "source-grounded defects together in one verdict (up to eight), not just " +
      "the first issue discovered. Do not invent issues to reach any quota. " +
      "Give a path-specific correction limited to the existing Arc/Milestone files. " +
      "If fixing would require protected decisions, new canonical targets or author " +
      "approval, say so in the finding; your verdict cannot grant those changes. " +
      "This feedback is EARLY ONLY: the mandatory postcommit independent " +
      "semantic review still makes the authoritative decision.\n" +
      (blueprint ? "INDEPENDENTLY REVIEWED PROVISIONAL BLUEPRINT: " +
        JSON.stringify(blueprint) + "\nCheck that actual authored Arc/Milestone prose " +
        "implements the concrete proposed clue chains, supported resolution " +
        "and meaningful route consequences; report any material omission " +
        "as a bounded finding against an actual changed file. Beat slugs are " +
        "not canonical record identifiers.\n" : "") +
      "Contract: " + JSON.stringify(plan.contract) + "\n" +
      "Changed authorized paths: " + JSON.stringify(paths) + "\n" +
      "Return STRICT JSON only: {\"status\":\"pass\",\"findings\":[]} " +
      "or {\"status\":\"revise\",\"findings\":[{\"path\":\"one listed path\", " +
      "\"reason\":\"source-grounded defect\",\"correction\":\"bounded repair\"}]}. " +
      "At most eight findings. Never claim that you validated or committed a draft.");
    const required = [
      ...paths.map(p => join(project.root, p)),
      join(project.root, "creative-direction/foundation.md"),
      join(snapshot.path, "skills", "nt-story-architecture/SKILL.md"),
      join(snapshot.path, "skills", "nt-catalog/SKILL.md"),
    ];
    const missing = () => {
      const reads = completedPinnedSkillReads(session.messages, project.root, snapshot.path);
      return required.filter(path => !reads.includes(path));
    };
    const lastTurn = () => [...session.messages].reverse().find(m => m.role === "assistant");
    const success = () => {
      const last = lastTurn();
      return last?.role === "assistant" && !["aborted", "error"].includes(last.stopReason);
    };
    if (!success())
      throw Error("Independent Architecture draft review was interrupted; preserve original writer and review transcripts.");
    if (missing().length) {
      await promptStorySpecialist(session,
        "INDEPENDENT READ-ONLY REVIEW METHOD CORRECTION: Your verdict cannot count " +
        "until every listed source has a successful read tool result. Read these " +
        "EXACT resources now. Do not edit files or run shell. Then return a fresh " +
        "complete draft-review JSON verdict grounded in those source bytes.\n" +
        missing().map(p => p.startsWith(join(snapshot.path, "skills") + sep)
          ? "skill://" + p.slice((join(snapshot.path, "skills") + sep).length)
          : p.slice(project.root.length + 1)).join("\n"));
    }
    if (!success() || missing().length)
      throw Error("Independent Architecture draft reviewer omitted required source reads; preserve the uncommitted draft.");
    let verdict: ArchitectureDraftReview;
    try {
      verdict = parseArchitectureDraftReview(session.getLastAssistantText() ?? "", paths);
    } catch {
      // This completed, read-only Pi turn has no writer side effects. Correct
      // ONE malformed verdict in the same original reviewer conversation;
      // never normalize forged paths or silently interpret an invalid pass.
      await promptStorySpecialist(session, architectureDraftFormatCorrection(paths));
      if (!success())
        throw Error("Architecture draft verdict format correction was interrupted; preserve original reviewer session.");
      if (missing().length)
        throw Error("Architecture draft verdict correction lost required source reads.");
      verdict = parseArchitectureDraftReview(session.getLastAssistantText() ?? "", paths);
    }
    await context.completed(sessionFile, session.sessionId);
    return verdict;
  } finally { session.dispose(); }
}

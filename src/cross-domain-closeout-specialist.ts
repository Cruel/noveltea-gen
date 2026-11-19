/** One Pi-authorized Event-owned Milestone metadata closeout.
 * A source-aware Event specialist changes ONLY the two original fields.
 * The independent narrative reviewer, not the author, judges semantic
 * fulfillment after native validation. No unchecked writer replay on resume.
 */
import { join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createJobModelRuntime } from "./model-runtime.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { createStoryValidateTool } from "./validator.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import { parseSpecialistJson } from "./composition-specialist.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import type { JobStartResult } from "./job.js";
import type { CloseoutProposal } from "./cross-domain-prerequisite.js";

export interface CloseoutSpecialistResponse {
  sessionFile: string;
  evidence: string[];
}

/** Actual specialist session, not a controller script that fabricates IDs.
 * Source paths are read-only context, never implicit write authorization.
 * The wrapper audits the complete Git worktree after every turn. */
export async function authorMilestoneCloseout(
  job: JobStartResult, snapshot: SkillSnapshot, proposal: CloseoutProposal,
  sourcePaths: string[], provider: string, model: string,
  onSession: (file: string) => Promise<void>,
  audit: () => Promise<string[]>,
): Promise<CloseoutSpecialistResponse> {
  if (await openSkillSnapshot(snapshot.id) !== snapshot.path)
    throw Error("Cross-domain closeout lost its original pinned Event skill snapshot.");
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config = { discovery: "explicit-only" as const, novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-event-design", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-event-design", "nt-catalog"].every(name => skills.some(s =>
        s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Closeout cannot load the original pinned Event specialist and native catalog.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: "event:prerequisite-closeout:" + proposal.milestoneId + ":" + proposal.digest,
    step: "event:prerequisite-closeout:" + proposal.digest,
    paths: sourcePaths, snapshot: snapshot.id,
    task: { kind: "event", ids: [proposal.milestoneId], scope: "related" },
    provider, model,
    directory: join(job.stateDir, "prerequisite-sessions", proposal.digest),
  }, runtime);
  const sandbox = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [...(sandbox ?? []), createStoryValidateTool(job),
      context.contextTool, createPiStatusTool()],
    noTools: "all", tools: ["read", "edit", "story_context", "story_validate", "report_status"],
  });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw Error("Closeout Pi session is not durable.");
    await onSession(sessionFile);
    const required = ["nt-event-design/SKILL.md", "nt-catalog/SKILL.md",
      "nt-catalog/references/records.md", "nt-catalog/references/progression.md",
      "nt-catalog/references/authority-and-validation.md"]
      .map(path => join(snapshot.path, "skills", path));
    const instruction =
      "AUTHORIZED SOURCE-BOUND EVENT MILESTONE CLOSEOUT. This is a subsequent assignment in " +
      "the ORIGINAL full-Story Turn after independently reviewed Event setup and Choice binding. " +
      "Do not regenerate or extend the Story, change a Choice, edit original Event prerequisites, " +
      "edit another Milestone or modify protected author decisions. " +
      "Your ONLY writable path is " + proposal.allowedPaths[0] + " and the ONLY writable " +
      "frontmatter keys are completeness and fulfillment (any_of). Do not edit the body, " +
      "other frontmatter metadata, whitespace elsewhere, or any other file. " +
      "Read the selected Milestone, the actual Event and Choice records, and EVERY " +
      "pinned source reference before deciding. Use native validation, real playable Event " +
      "and Choice outcome routes, and full source-anchored narrative evidence. " +
      "A model cannot invent an event ID, claim a verbal offer is enacted, or count " +
      "one choice branch as fulfilling all promised outcomes. If the Milestone's original " +
      "change/outcome is NOT actually fulfilled by existing reachable paths, do not edit " +
      "anything: report BLOCK and the exact missing Event/Choice evidence for the controller " +
      "to consider as a separate, explicitly bounded dependency. If the source evidence is " +
      "sufficient, set the selected Milestone complete with honest existing Event IDs in " +
      "fulfillment.any_of only. Return ONE unfenced JSON object: " +
      '{ "verdict":"pass|block", "evidence":["events/file.md:line", "choice-points/file.md:line"], "reason":"..." }. ' +
      "A self-reported pass does NOT count: an independent editorial reviewer must confirm " +
      "the actual source diff after native validation. Do not stage, commit or check out Git. " +
      "PINNED REFERENCE PATHS:\n" + required.join("\n") +
      "\nCANONICAL CONTEXT PATHS:\n" + sourcePaths.join("\n") +
      "\nCONTROLLER PROPOSAL:\n" + JSON.stringify(proposal);
    let prompt = context.contextNote + instruction;
    for (let attempt = 0; attempt < 3; attempt++) {
      await context.beforeTurn(sessionFile);
      await promptStorySpecialist(session, prompt);
      const last = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
        throw Error("Milestone closeout specialist turn did not settle successfully.");
      await requirePinnedSkillReads(session, project.root, required, "Milestone closeout");
      const message = last.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      let answer: Record<string, unknown>;
      try { answer = parseSpecialistJson(message); }
      catch (error) {
        if (attempt >= 2) throw error;
        prompt = "Your result was not strict JSON. Keep the original scope, correct the response " +
          "in this same session with verdict, evidence and reason; never add write permissions.";
        continue;
      }
      if (answer.verdict === "block")
        throw Error("Event specialist identified missing upstream evidence: " +
          String(answer.reason ?? "No actual closeout evidence").slice(0, 1500));
      if (answer.verdict !== "pass" || !Array.isArray(answer.evidence) ||
          !answer.evidence.length || answer.evidence.some(x => typeof x !== "string"))
        throw Error("Milestone closeout returned an invalid or unsupported verdict.");
      const diagnostics = await audit();
      if (!diagnostics.length) {
        await context.completed(sessionFile, session.sessionId);
        return { sessionFile, evidence: answer.evidence as string[] };
      }
      if (attempt === 2) throw Error("Milestone closeout exhausted its bounded in-session corrections: " +
        diagnostics.join("; "));
      prompt = "The controller rejected the UNCOMMITTED Milestone edit. Only the same two " +
        "fields of the original selected Milestone may change. Correct only these issues " +
        "within this SAME session, revalidate, and return JSON with source evidence. " +
        "Do not reinterpret another-owner issues as a new grant. EXACT DIAGNOSTICS:\n" +
        diagnostics.join("\n");
    }
    throw Error("Milestone closeout ended without an audited source edit.");
  } finally { session.dispose(); }
}

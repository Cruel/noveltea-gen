/** Original-owner continuation for a previously passed Story checkpoint.
 * This is a fork of the authenticated original writer transcript, not a new
 * planning agent or a grant to edit arbitrary records.
 */
import { join, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJobModelRuntime } from "./model-runtime.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import { openSkillSnapshot } from "./snapshot.js";
import { verifiedPiSession } from "./dependent-correction-work.js";
import type { JobStartResult } from "./job.js";
import type { RepairOrigin } from "./rejected-review-repair.js";
import type { DependentCorrectionAssignment } from "./selective-revalidation.js";

function kind(proposal: DependentCorrectionAssignment, origin: RepairOrigin) {
  if (proposal.itemId.startsWith("event:")) return "event" as const;
  if (origin.workItem.startsWith("interactive-choice-")) return "event" as const;
  if (origin.workItem.startsWith("interactive-puzzle-") ||
      proposal.itemId.startsWith("puzzle:")) return "puzzle" as const;
  if (proposal.itemId.startsWith("composition:")) return "dialogue" as const;
  return "review" as const;
}
export async function authorDependentCorrection(input: {
  job: JobStartResult; proposal: DependentCorrectionAssignment;
  origin: RepairOrigin; originalPaths: string[];
  sourceSession: string; feedback: string; inherited?:boolean;
  onSession: (file: string) => Promise<void>;
  audit: () => Promise<void>;
}): Promise<string> {
  const { job, proposal, origin } = input;
  if (await openSkillSnapshot(origin.snapshot.id) !== origin.snapshot.path)
    throw Error("Original specialist's pinned skills changed during corrective assignment.");
  // The original committed session must remain unchanged; SessionManager.open
  // would append to it. Fork its exact history for the bounded correction.
  await verifiedPiSession(job, input.sourceSession, origin.sessionFile);
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config = { discovery: "explicit-only" as const, novelteaSkills: origin.snapshot.path,
    skillDirs: [], requiredSkills: [proposal.specialist, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(
    project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(x => x.type === "error") ||
      ![proposal.specialist, "nt-catalog"].every(name => skills.some(s =>
        s.name === name && s.filePath.startsWith(join(origin.snapshot.path, "skills") + sep))))
    throw Error("Original specialist skills are absent from the pinned snapshot.");
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "dependent-correction-sessions", proposal.digest);
  const context = await preparePiContext(job, project, {
    group: "dependent-repair:" + proposal.itemId + ":" + proposal.digest,
    step: "dependent-repair:" + proposal.digest,
    paths: [...new Set([...input.originalPaths, ...proposal.authorizedPaths])],
    snapshot: origin.snapshot.id, task: { kind: kind(proposal, origin),
      ids: [...new Set([proposal.itemId.replace(/^[^:]+:/, "")])], scope: "related" },
    provider: origin.provider, model: origin.model, thinking: origin.thinking,
    directory: sessionDir,
  }, runtime);
  const sandbox = (await selectSandboxPiTools(job, origin.snapshot, skills))?.map(tool =>
    tool.name!=="edit" ? tool : {...tool,execute:async (...args:Parameters<typeof tool.execute>)=>{
      const path=(args[1] as {path?:unknown}).path;
      if(typeof path!=="string" || !proposal.authorizedPaths.includes(path))
        throw Error("Dependent corrective writer denied path outside the exact owner grant.");
      return tool.execute(...args);
    }});
  const manager = SessionManager.forkFrom(input.sourceSession, project.root, sessionDir);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: manager,
    customTools: [...(sandbox ?? []), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: ["read", "edit", "story_context", "report_status"],
  });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw Error("Dependent correction did not create a durable Pi transcript.");
    await input.onSession(sessionFile);
    const required = [proposal.specialist + "/SKILL.md",
      "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
      "nt-catalog/references/authority-and-validation.md"]
      .map(path => join(origin.snapshot.path, "skills", path));
    const prompt = context.contextNote +
      "CONTROLLER-AUTHORIZED PREVIOUSLY REVIEWED DEPENDENT CORRECTION. " +
      "Your ORIGINAL assignment was independently PASSED at Git SHA " +
      proposal.originalCommitSha + ". A subsequently corrected upstream " +
      "record invalidated a specific dependent obligation. Preserve the original " +
      "author objective, the historical positive verdict, and all other committed work. " +
      (input.inherited ?
        "This is a new controller-admitted local corrective session using the exact inherited owner proof. The parent writer is not replayed. " :
        "Resume the context of your ORIGINAL specialist session. ") +
      "Preserve the separately reviewed upstream correction and every canonical Milestone fulfilled by the edited record. Read the actual affected Milestone and source relations. Do not create " +
      "new Story records, change protected decisions, write another owner's files, " +
      "or stage/commit Git. Your ONLY editable paths are: " +
      proposal.authorizedPaths.join(", ") + ". " +
      "Original assignment goal: " + proposal.obligation +
      ". Current independent negative review: " + input.feedback.slice(0, 6000) +
      ". Correct the actual source-linked contradiction, retain all unrelated " +
      "canonical material, and finish with the source lines you changed. " +
      "Read EVERY mandatory pinned skill/reference before editing. " +
      "PINNED REFERENCES: " + required.join(", ") +
      ". CONTROLLER GRANT: " + JSON.stringify(proposal);
    await context.beforeTurn(sessionFile);
    await promptStorySpecialist(session, prompt);
    const last = [...session.messages].reverse().find(message => message.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw Error("Original specialist's dependent correction was interrupted.");
    await requirePinnedSkillReads(session, project.root, required,
      "Dependent correction", "source-linked change explanation");
    await input.audit();
    await context.completed(sessionFile, session.sessionId);
    return sessionFile;
  } finally { session.dispose(); }
}

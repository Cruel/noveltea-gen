import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

export type FoundationDomain = "world" | "character";
export interface FoundationAssignment {
  domain: FoundationDomain;
  arcIds: string[];
  milestoneIds: string[];
  sourcePaths: string[];
  scope: CompletionContract;
  decisionAuthority: {
    existingAuthorChoices: "protected-no-retcon";
    newSpecialistChoices: "agent-delegated";
    editorialApproval: "not-granted";
  };
}
export interface SpecialistEvidence {
  claimedPaths: string[];
  piSessionFile?: string;
  piSessionId?: string;
  skillReads: string[];
  architecturalConflicts?: string[];
  laterObligations?: string[];
}
const CATALOG = [
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
];
const DOMAINS = {
  world: {
    name: "nt-worldbuilding",
    owns: ["world-entities/*.md", "facts/*.md"],
    guidance: "Create one or two consequential persistent setting elements (world-entity) and objective initial Facts, not a glossary of the cast. People belong in Character records, never in world-entity records. A world-entity has exactly one type-specific field, description (quoted string); a fact has exactly one type-specific field, initial (unquoted boolean). NEVER put description on a fact. EVERY record MUST have substantial readable Markdown narrative prose AFTER its closing --- frontmatter line. Never use initial: false to mean undiscovered. Do not invent engine Rooms, speculative Events or future Narrative State snapshots.",
  },
  character: {
    name: "nt-character-development",
    owns: ["characters/*.md", "relationships/*.md", "arcs/*.md (characters array only)"],
    guidance: "Develop at least two distinct Characters with credible motivations and voices, a consequential initial Relationship and honest Fact knowledge baselines. Use character records (type-specific fields motivation and optional initial_knowledge) for people, relationship records (characters exactly two distinct IDs and initial) for the bond. Every record MUST have readable narrative prose after its closing --- frontmatter line. Existing Arc characters arrays may be extended only to link new Characters, without changing any other Arc text. Future/branch-specific discoveries are obligations for Events, not initial knowledge.",
  },
} as const;

/** Real Pi authoring: no commit, validation or authorization power is delegated to the specialist. */
export async function authorCharacterWorld(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: FoundationAssignment, provider: string, modelId: string,
  onSession: (id: string, path: string) => Promise<void>,
  verifyDraft: (evidence: SpecialistEvidence) => Promise<string[]>): Promise<SpecialistEvidence> {
  const selected = DOMAINS[assignment.domain];
  const required = [selected.name + "/SKILL.md", ...CATALOG];
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: [selected.name, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Foundation specialist skill discovery: " + diag.message);
  for (const name of [selected.name, "nt-catalog"]) {
    if (!skills.some(skill => skill.name === name && skill.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned specialist skill: " + name);
    }
  }
  const runtime = await ModelRuntime.create();
  const dir = join(job.stateDir, "character-world-sessions", assignment.domain);
  const context = await preparePiContext(job, project, {
    group: "foundations:" + assignment.domain, step: "foundations:" + assignment.domain,
    paths: assignment.sourcePaths, snapshot: snapshot.id, provider, model: modelId, directory: dir,
    task: { kind: "character", ids: assignment.milestoneIds, scope: "related" },
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [...(sandboxTools ?? []), createStoryValidateTool(job), context.contextTool],
    noTools: "all", tools: [...SANDBOX_TOOLS, "story_context", "story_validate"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi Character/World specialist did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Character/World Pi transcript cannot be persisted before authoring.");
    await onSession(session.sessionId, sessionFile);
    let prompt =
      `You are the NovelTea ${selected.name} specialist assigned ONE bounded canonical Story work item.\n` +
      "Read ALL the pinned guidance below using the read tool before writing:\n" +
      required.map(path => join(snapshot.path, "skills", path)).join("\n") +
      "\nRead only the relevant existing Story sources named in the assignment (follow necessary typed references). " +
      "Never read/search .story-inbox/ideas, even with git grep/show, rg --hidden, find or broad scans; " +
      "it holds noncanonical, dormant author material reserved for a later placement specialist. " +
      "Do not modify files outside your ownership; never write Creative Direction, Milestones, Events, or engine files. " +
      "Preserve author-protected decisions and existing authorized choices; do not treat draft status as permission to retcon. " +
      "Write canonical schema '0.1' Markdown, with quoted YAML prose scalars, draft status and honest completeness. " +
      "Where future conditional truth, discoveries or Relationship transitions depend on a branch, describe the pending Event obligation in prose rather than making false initial state claims. " +
      "Never invent typed Event IDs to fill deferred Milestone fulfillment. " +
      (sandboxTools ?
        "Shell and file searches run only in networkless /story; Git, host paths and credentials are unavailable. Use story_validate for native checks. " :
        "Do not run git add, commit, reset or checkout. Inspections with grep/rg/git diff/status are permitted. ") +
      selected.guidance + "\nAUTHORIZED WRITABLE PATHS: " + selected.owns.join(", ") +
      "\nBOUND ASSIGNMENT: " + JSON.stringify(assignment, null, 2) +
      "\nAt the END of your response, provide a JSON object on its own line with the exact Story-relative paths you changed: " +
      '`{"modifiedRecords":["characters/example.md"],"architecturalConflicts":[],"laterObligations":["Bind the disclosure to an Event"]}` (replace example with reality). ' +
      "Report any blocked architectural conflict in architecturalConflicts and all deferred Event/branch dependencies in laterObligations. " +
      "List ALL paths changed since the beginning of this work item, not just the latest edits. " +
      "Call story_validate with no arguments, inspect diagnostics and coverage, repair and revalidate before reporting. " +
      "The graph will check this claim against the actual Git diff; your self-report is not acceptance evidence.";
    // Do not start a second writer or discard its work. The SAME Pi session can
    // receive bounded, source-located validator feedback before commit.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + prompt : prompt);
      const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!assistant || assistant.role !== "assistant" || ["error", "aborted"].includes(assistant.stopReason)) {
        const detail = assistant?.role === "assistant"
          ? `stopReason=${assistant.stopReason}; error=${assistant.errorMessage ?? "none"}`
          : "no assistant turn";
        throw new Error("Foundation specialist did not finish a successful Pi turn (" + detail + ").");
      }
      const pinned = required.map(p => join(snapshot.path, "skills", p));
      const skillReads = await requirePinnedSkillReads(session, project.root, pinned, "Foundation specialist");
      const finalAssistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!finalAssistant || finalAssistant.role !== "assistant") throw new Error("Foundation specialist reply is missing.");
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      const calls = session.messages.flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "toolCall") : []);

      const edits = calls.filter(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
        typeof c.arguments?.path === "string").map(c => relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"));
      if (!edits.length) throw new Error("Foundation specialist did not edit canonical Markdown.");
      const text = finalAssistant.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const match = text.match(/\{\s*"modifiedRecords"\s*:\s*\[[^\]]*\][^{}]*\}/g)?.at(-1);
      let declared: unknown;
      try { declared = JSON.parse(match ?? "null"); } catch { /* reject below */ }
      const paths = (declared as { modifiedRecords?: unknown })?.modifiedRecords;
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === "string")) {
        throw new Error("Foundation specialist did not provide a valid modifiedRecords manifest.");
      }
      const messages = declared as { architecturalConflicts?: unknown; laterObligations?: unknown };
      const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string" && x.trim());
      if (!strings(messages.architecturalConflicts) || !strings(messages.laterObligations)) {
        throw new Error("Specialist must explicitly report architectural conflicts and downstream obligations.");
      }
      const evidence: SpecialistEvidence = { claimedPaths: paths, skillReads,
        architecturalConflicts: messages.architecturalConflicts as string[],
        laterObligations: messages.laterObligations as string[],
        piSessionFile: session.sessionManager.getSessionFile() ?? undefined };
      const diagnostics = await verifyDraft(evidence);
      if (diagnostics.length === 0) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
      if (attempt === 2) {
        throw new Error("Specialist failed canonical validation after two bounded repair attempts: " + JSON.stringify(diagnostics));
      }
      prompt = "The independent canonical validator rejected your UNCOMMITTED Story draft. " +
        "Stay within the exact original authorized scope; repair these file/line diagnostics in your existing files. " +
        "Read the relevant pinned catalog references again if necessary. Do not stage or commit. " +
        "Do not change or weaken protected decisions, or fill unknown future routes with fictitious Events. " +
        "After fixing, repeat the COMPLETE modifiedRecords/architecturalConflicts/laterObligations JSON manifest. " +
        "Diagnostics:\n" + diagnostics.join("\n");
    }
    throw new Error("Specialist repair loop terminated unexpectedly.");
  } finally { session.dispose(); }
}

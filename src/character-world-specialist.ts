import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
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
    guidance: "Define objective initial truth, consequential persistent world elements and the limits of each rule. Never use initial: false to mean undiscovered. Do not invent engine Rooms, speculative Events or future Narrative State snapshots.",
  },
  character: {
    name: "nt-character-development",
    owns: ["characters/*.md", "relationships/*.md", "arcs/*.md (characters array only)"],
    guidance: "Develop at least two distinct Characters with credible motivations and voices, a consequential initial Relationship and honest Fact knowledge baselines. Existing Arc characters arrays may be extended only to link new Characters, without changing any other Arc text. Future/branch-specific discoveries are obligations for Events, not initial knowledge.",
  },
} as const;

/** Real Pi authoring: no commit, validation or authorization power is delegated to the specialist. */
export async function authorCharacterWorld(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: FoundationAssignment, provider: string, modelId: string,
  onSession: (id: string, path: string) => Promise<void>): Promise<SpecialistEvidence> {
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
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(candidate => candidate.id === modelId)) {
    throw new Error(`Unavailable foundation Pi model/credentials: ${provider}/${modelId}`);
  }
  const dir = join(dirname(job.worktreeRoot), "character-world-sessions", assignment.domain);
  await mkdir(dir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(project.root, dir),
    noTools: "all", tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Character/World Pi transcript cannot be persisted before authoring.");
    await onSession(session.sessionId, sessionFile);
    await session.prompt(
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
      "Do not run git add, commit, reset or checkout. Inspections with grep/rg/git diff/status are permitted. " +
      selected.guidance + "\nAUTHORIZED WRITABLE PATHS: " + selected.owns.join(", ") +
      "\nBOUND ASSIGNMENT: " + JSON.stringify(assignment, null, 2) +
      "\nAt the END of your response, provide a JSON object on its own line with the exact Story-relative paths you changed: " +
      '`{"modifiedRecords":["characters/example.md"],"architecturalConflicts":[],"laterObligations":["Bind the disclosure to an Event"]}` (replace example with reality). ' +
      "Report any blocked architectural conflict in architecturalConflicts and all deferred Event/branch dependencies in laterObligations. " +
      "The graph will check this claim against the actual Git diff; your self-report is not acceptance evidence."
    );
    const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!assistant || assistant.role !== "assistant" || ["error", "aborted"].includes(assistant.stopReason)) {
      const detail = assistant?.role === "assistant"
        ? `stopReason=${assistant.stopReason}; error=${assistant.errorMessage ?? "none"}`
        : "no assistant turn";
      throw new Error("Foundation specialist did not finish a successful Pi turn (" + detail + ").");
    }
    const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const calls = session.messages.flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "toolCall") : []);
    const reads = calls.filter(c => c.name === "read" && completed.has(c.id) && typeof c.arguments?.path === "string")
      .map(c => resolve(project.root, c.arguments.path as string));
    const pinned = required.map(p => join(snapshot.path, "skills", p));
    if (pinned.some(path => !reads.includes(path))) throw new Error("Foundation specialist did not read every required pinned skill reference.");
    const edits = calls.filter(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
      typeof c.arguments?.path === "string").map(c => relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"));
    if (!edits.length) throw new Error("Foundation specialist did not edit canonical Markdown.");
    const text = assistant.content.filter(c => c.type === "text").map(c => c.text).join("\n");
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
    return { claimedPaths: paths, skillReads: reads.filter(path => pinned.includes(path)),
      architecturalConflicts: messages.architecturalConflicts as string[],
      laterObligations: messages.laterObligations as string[],
      piSessionId: session.sessionId,
      piSessionFile: session.sessionManager.getSessionFile() ?? undefined };
  } finally { session.dispose(); }
}

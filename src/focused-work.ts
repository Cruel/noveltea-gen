import { createDependencyTool } from "./dependency-tool.js";
import { authorizedDependency, dependencyDigest, inspectDependencyPlan } from "./dependency-state.js";
import { parseDependencyReport, type DependencyReport } from "./dependency-amendments.js";
import { focusedSpecialist } from "./focused-specialist.js";
import { steeringForAssignment } from "./steering-amendments.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { execFileSync } from "./git-read-cache.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { CompletionContract, PlannedFocusCreate } from "./architecture.js";
import { normalizeArcCharacterLinks } from "./character-world.js";
import type { ReviewCharacterProposal } from "./dependency-amendments.js";
import { withStoryJobLock } from "./job-lock.js";
import { startStoryJob } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { preparePiContext, piNarrativeGroup, preflightPiAssignment } from "./job-pi-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { resolveFocusedScope, type CanonicalScopeRecord } from "./focused-scope.js";
import { readTurnEvidence, assertFocusedTurnAssignment } from "./turn-plan-evidence.js";
import { creativePolicyInstruction, DEFAULT_CREATIVE_POLICY, type CreativePolicy } from "./creative-policy.js";
import { focusedChoiceWorkItem, recordSpecialistChoice, inspectSpecialistChoice, verifySpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, SpecialistChoiceRequiredError, authorChoiceDirection,
  extractSpecialistChoice, parseSpecialistChoice, type SpecialistChoiceQuestion,
  type SpecialistChoiceReceipt } from "./specialist-choice.js";

interface Receipt {
  version: 1; jobId: string; workItemId: string; planVersion: number; contractDigest: string;
  expectedHead: string; phase: "pending" | "writing" | "authored" | "committed" | "waiting-dependency" | "awaiting-author";
  dependencyReport?: DependencyReport; resolvedDependency?: string;
  dependencySuspension?: { reportDigest: string; sessionId: string; sessionFile: string;
    transcriptBytes: number; transcriptSha256: string };
  target: string; paths: string[]; context: string[]; worker: "fixture" | "pi";
  provider: string; model: string; snapshot?: SkillSnapshot; piSessionFile?: string;
  piSessionId?: string; choiceWorkItem?: string; authorChoiceId?: string;
  sha256?: string; commitSha?: string; assignmentDigest?: string; steeringDigest?: string;
  validation?: { status: "passed"; validatorVersion: string; baseSha: string };
}
const receiptPath = (job: JobStartResult, receipt: Pick<Receipt, "workItemId" | "target">) =>
  join(job.stateDir, receipt.workItemId.startsWith("dependency:") ? "dependency-items" : "focused-items",
    (receipt.workItemId.startsWith("dependency:") ? receipt.workItemId : receipt.target) + ".json");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const repoPath = (job: JobStartResult, p: string) => job.storyRelativePath ? job.storyRelativePath + "/" + p : p;
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
async function save(path: string, value: Receipt) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
/** Authenticate a settled original no-write boundary without invoking Pi.
 * The original report stays in the existing focused receipt; the graph only
 * checkpoints its digest. A later continuation may append to the same session,
 * but may never replace the settled prefix. */
export async function inspectFocusedPrerequisite(job: JobStartResult, target: string,
  turnDigest: string, fixture: boolean, planVersion: number) {
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(target))
    throw Error("Invalid focused prerequisite target.");
  const file = receiptPath(job, { workItemId: "focus:" + target, target });
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  if (!receipt.dependencyReport) return null;
  const report = parseDependencyReport(receipt.dependencyReport);
  const seal = receipt.dependencySuspension;
  if (receipt.jobId !== job.jobId || receipt.target !== target ||
      receipt.workItemId !== "focus:" + target || receipt.assignmentDigest !== turnDigest ||
      receipt.worker !== (fixture ? "fixture" : "pi") || receipt.planVersion !== planVersion ||
      report.assignmentId !== receipt.workItemId || report.turnDigest !== turnDigest ||
      !seal || seal.reportDigest !== dependencyDigest(report) ||
      (receipt.phase === "waiting-dependency" ? report.sourceSha !== receipt.expectedHead :
        receipt.resolvedDependency !== seal.reportDigest))
    throw Error("Focused prerequisite lost its original assignment, plan or settled report.");
  if (fixture) {
    if (seal.sessionId !== "fixture" || seal.sessionFile !== "fixture" ||
        seal.transcriptBytes !== 0 || seal.transcriptSha256 !== "f".repeat(64))
      throw Error("Focused prerequisite has invalid fixture provenance.");
  } else {
    const sessionFile = seal.sessionFile;
    if (!sessionFile.startsWith(join(job.stateDir, "focused-sessions", target) + sep) ||
        sessionFile !== receipt.piSessionFile || seal.sessionId !== receipt.piSessionId ||
        await realpath(sessionFile) !== sessionFile || !(await lstat(sessionFile)).isFile() ||
        !Number.isSafeInteger(seal.transcriptBytes) || seal.transcriptBytes <= 0)
      throw Error("Focused prerequisite lost its original Pi session.");
    const transcript = await readFile(sessionFile);
    const original = transcript.subarray(0, seal.transcriptBytes);
    const header = JSON.parse(original.toString("utf8").split("\n")[0]!);
    if (original.length !== seal.transcriptBytes ||
        createHash("sha256").update(original).digest("hex") !== seal.transcriptSha256 ||
        header.type !== "session" || header.id !== seal.sessionId ||
        receipt.phase === "waiting-dependency" && transcript.length !== original.length)
      throw Error("Focused prerequisite's settled Pi transcript changed.");
  }
  return { report, seal, phase: receipt.phase, paths: receipt.paths };
}
function changes(job: JobStartResult) {
  return git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").toString()
    .split("\0").filter(Boolean);
}
function reportOf(result: ValidationResult, head: string) {
  const report = result.report as { records?: CanonicalScopeRecord[]; diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (result.status !== "passed" || !Array.isArray(report?.records) ||
      report.diagnostics?.length || report.protection?.status !== "checked" ||
      report.protection.base !== head || report.protection.changes?.length ||
      report.protection.warnings?.length)
    throw new Error("Focused scope requires complete canonical structure/protected-decision verification: " +
      JSON.stringify(result).slice(0, 3500));
  return report.records;
}
/** Reuse the same Arc field normalizer as the Character Foundations writer. */
export function appendArcLink(oldText: string, character: string): string {
  const prior = normalizeArcCharacterLinks(oldText);
  if (prior.ids.includes(character)) throw Error("Missing-Character link already exists.");
  const inline = oldText.match(/^characters:[ \t]*\[([^\]\n]*)\][ \t]*$/m);
  if (inline) return oldText.replace(inline[0],
    "characters: [" + [...prior.ids, character].join(", ") + "]");
  const lines = oldText.split("\n");
  const start = lines.findIndex(line => /^characters:[ \t]*$/.test(line));
  if (start < 0) throw Error("Unsupported Arc link field.");
  let end = start + 1;
  while (end < lines.length && /^[ \t]+- character\.[a-z][a-z0-9-]*[ \t]*$/.test(lines[end]!)) end++;
  lines.splice(end, 0, "  - " + character);
  return lines.join("\n");
}
export function auditArcLink(oldText: string, newText: string, character: string) {
  const before = normalizeArcCharacterLinks(oldText);
  const after = normalizeArcCharacterLinks(newText);
  if (before.text !== after.text || after.ids.length !== before.ids.length + 1 ||
      after.ids.at(-1) !== character || before.ids.includes(character) ||
      before.ids.some((id, index) => after.ids[index] !== id) ||
      after.ids.some(id => !/^character\.[a-z][a-z0-9-]*$/.test(id)) ||
      new Set(after.ids).size !== after.ids.length)
    throw Error("Review-dependency Arc changed more than the addition of one Character link.");
}

/** Deterministic fixture output exercises the same canonical/native/Git gates.
 * It is never evidence of model-authored literary quality. */
function fixtureCreatedRecord(create: PlannedFocusCreate, contract: CompletionContract,
  catalog: CanonicalScopeRecord[]): string {
  const type = create.id.split(".")[0]!;
  const base = ["---", "schema: '0.1'", "type: " + type, "id: " + create.id,
    "title: " + JSON.stringify(create.title), "status: draft", "decisions: []"];
  const list = (values: string[]) => "[" + values.join(", ") + "]";
  const title = (id: string) => {
    const record = catalog.find(item => item.metadata.id === id);
    const planned = contract.scope.creates?.find(item => item.id === id);
    return String(record?.metadata.title ?? planned?.title ?? id.split(".")[1]);
  };
  if (type === "character") return [...base, "motivation: Seek an honest, consequential exchange.",
    "---", "# " + create.title,
    "This Character wants to be heard without sacrificing trust. They enter the conversation with a concrete reason to listen.\n"].join("\n");
  if (type === "relationship") return [...base,
    "characters: " + list(create.references), "initial: estranged", "---", "# " + create.title,
    "The speakers must negotiate trust rather than assume it. Their conversation can establish mutual understanding.\n"].join("\n");
  if (type === "event") return [...base,
    "participants: " + list(create.references.filter(id => id.startsWith("character."))),
    "arcs: " + list(create.references.filter(id => id.startsWith("arc."))),
    "after: []", "prerequisites:", "  any_of:", "    - completed: []", "      not_completed: []",
    "consequences:", "  - Both speakers confront what they have withheld.",
    "steps:", "  - id: exchange", "    branches:", "      - id: continue",
    "        conditions: []",
    "        effects: " + (create.references.some(id => id.startsWith("relationship."))
      ? "[{kind: relationship, relationship: " +
        create.references.find(id => id.startsWith("relationship.")) + ", value: trusting}]"
      : "[]"), "---", "# The conversation",
    "Both Characters choose to meet and trade information. The encounter has a discernible beginning and consequence.\n"].join("\n");
  if (type === "authored-content") {
    const event = contract.scope.creates?.find(item => item.id === create.references[0]);
    const eventRecord = catalog.find(item => item.metadata.id === create.references[0]);
    const speakers = (event?.references.filter(id => id.startsWith("character.")) ??
      (Array.isArray(eventRecord?.metadata.participants)
        ? eventRecord.metadata.participants.filter((id): id is string => typeof id === "string") : []))
      .slice(0, 2).map(title);
    const first = speakers[0] ?? "First speaker", second = speakers[1] ?? "Second speaker";
    return [...base, "events: " + list(create.references), "revelations: []", "---",
      "# " + create.title,
      "A quiet moment settles between " + first + " and " + second + " before either speaks.",
      "", "**" + first + ":** “I wanted to ask what you really knew.”",
      "", "**" + second + ":** “I was waiting for someone willing to listen.”",
      "", "**" + first + ":** “Then we should begin with the truth.”",
      "", "The silence that follows is different from the one that came before.\n"].join("\n");
  }
  throw Error("No focused creation fixture for " + create.id);
}

/** Turn creation grants describe typed IDs; translate them into actual schema
 * fields so the model cannot mistake a relationship link for freeform prose. */
function creationReferenceInstructions(create: PlannedFocusCreate): string {
  const ofType = (type: string) => create.references.filter(id => id.startsWith(type + "."));
  const yaml = (refs: string[]) => "[" + refs.join(", ") + "]";
  if (create.id.startsWith("event.")) {
    const relationships = ofType("relationship");
    return "For this Event, YAML frontmatter MUST contain these exact typed references:\n" +
      "participants: " + yaml(ofType("character")) + "\n" +
      "arcs: " + yaml(ofType("arc")) + "\n" +
      (relationships.length ? "Every required Relationship MUST be represented by an actual typed " +
        "branch effect (a mention in the body is insufficient). In the YAML Event steps[].branches[] use " +
        "the supported effects syntax, for example:\n" +
        "effects: [{kind: relationship, relationship: " + relationships[0] +
        ", value: trusting}]\n" +
        "Include every required Relationship ID: " + yaml(relationships) + "\n" : "") +
      "Include valid prerequisites, consequences, and a playable Step/branch. " +
      "Do not introduce references to unrelated Event or Milestone IDs.\n";
  }
  if (create.id.startsWith("authored-content."))
    return "Use exactly these supported frontmatter keys for this Authored Content record " +
      "(NEVER add references or dependsOn — those are controller-only planning properties):\n" +
      "---\nschema: '0.1'\ntype: authored-content\nid: " + create.id +
      "\ntitle: " + JSON.stringify(create.title) +
      "\nstatus: draft\ndecisions: []\nevents: " + yaml(ofType("event")) +
      "\nrevelations: []\n---\n" +
      "Then write actual attributed dialogue with the named speakers and concrete stakes.\n";
  if (create.id.startsWith("relationship."))
    return "YAML frontmatter MUST include characters: " + yaml(ofType("character")) +
      " and an initial relationship state.\n";
  return "Preserve the exact Character ID and write a concrete motivation and substantive prose.\n";
}

async function writeWithPi(job: JobStartResult, receipt: Receipt, task: string,
  outcome?: string, policy: CreativePolicy = DEFAULT_CREATIVE_POLICY,
  create?: PlannedFocusCreate, obligations: string[] = [], steering = "",
  resume?: SpecialistChoiceReceipt,
  arcLink?: { path: string; characterId: string },
  eventReviewSupport = false, dependencyResume?: { file: string; id: string; changedPaths: string[] }): Promise<DependencyReport | {
    authorQuestion: SpecialistChoiceQuestion; sessionFile: string; sessionId: string;
  } | undefined> {
  let dependencyReport: DependencyReport | undefined;
  const dependencyTool = receipt.assignmentDigest && obligations.length > 0 &&
    !receipt.workItemId.startsWith("dependency:")
    ? createDependencyTool(job, { head: receipt.expectedHead, turnDigest: receipt.assignmentDigest,
        assignmentId: receipt.workItemId, obligations }, report => {
          if (dependencyReport) throw Error("Only one dependency report per bounded assignment is permitted.");
          dependencyReport = report;
        }) : null;
  const skill = focusedSpecialist(receipt.target);
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config = { discovery: "explicit-only" as const, novelteaSkills: receipt.snapshot!.path,
    skillDirs: [], requiredSkills: [skill, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  if (loader.getSkills().diagnostics.some(d => d.type === "error") ||
      [skill, "nt-catalog"].some(s => !loader.getSkills().skills.some(v =>
        v.name === s && v.filePath.startsWith(join(receipt.snapshot!.path, "skills") + sep))))
    throw new Error("Focused specialist lacks pinned, verifiable skill instructions.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    // Supporting work must not replace the suspended writer's context receipt.
    group: piNarrativeGroup(receipt.workItemId.startsWith("dependency:") ? "focused-support" : "focused",
      receipt.context, receipt.target),
    step: receipt.workItemId + ":" + receipt.planVersion + (receipt.resolvedDependency ? ":" + receipt.resolvedDependency : ""),
    paths: receipt.context, snapshot: receipt.snapshot!.id, provider: receipt.provider,
    model: receipt.model, directory: join(job.stateDir, "focused-sessions", receipt.target),
    ...(dependencyResume ? { resumeSession: dependencyResume } : {}),
    task: { kind: receipt.target.startsWith("event.") ? "event" :
      receipt.target.startsWith("puzzle.") || receipt.target.startsWith("choice-point.") ? "puzzle" :
      receipt.target.startsWith("authored-content.") ? "dialogue" : "character",
      ids: [receipt.target], scope: "focused" },
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, receipt.snapshot!, loader.getSkills().skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: resume
      ? SessionManager.open(resume.sessionFile, dirname(resume.sessionFile), project.root)
      : context.manager, customTools: [...(sandboxTools ?? []), context.contextTool, createPiStatusTool(),
      ...(dependencyTool ? [dependencyTool] : [])],
    noTools: "all", tools: [...(create ? ["write"] : []),
      "read", "edit", "grep", "find", "ls", "story_context", "report_status",
      ...(dependencyTool ? ["report_dependency"] : [])],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw new Error("Focused specialist did not honor the pinned reasoning profile.");
    const file = session.sessionManager.getSessionFile();
    if (!file) throw Error("Focused specialist requires a persistent Pi transcript.");
    if (dependencyResume && (file !== dependencyResume.file || session.sessionId !== dependencyResume.id))
      throw Error("Focused dependency must re-enter the original exact Pi session.");
    if (resume && (file !== resume.sessionFile || session.sessionId !== resume.sessionId))
      throw Error("Focused author response must resume the original exact Pi session.");
    receipt.piSessionFile = file;
    receipt.piSessionId = session.sessionId;
    await save(receiptPath(job, receipt), receipt);
    await context.beforeTurn(file);
    const required = [join(receipt.snapshot!.path, "skills", skill, "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "references", "records.md"),
      ...(receipt.target.startsWith("event.") ?
        [join(receipt.snapshot!.path, "skills", "nt-catalog", "references", "progression.md")] : [])];
    await promptStorySpecialist(session, context.contextNote +
      "You are a narrowly scoped NovelTea " + skill + " revision specialist. FIRST read all pinned guidance using read:\n" +
      required.join("\n") + "\nBegin with these relevant Story sources:\n" +
      receipt.context.join("\n") + "\nYou may use read, grep, find, ls and story_context to inspect " +
      "additional canonical Story records and discover typed dependencies. Discovery is READ-ONLY, " +
      "never write authority; do not inspect private inboxes.\n" +
      (eventReviewSupport
        ? "EVENT REVIEW SUPPORT: Your ONLY deliverable is the new Character profile. " +
          "The sealed reviewer also requests an Event participant/prose correction, but " +
          "that belongs to the ORIGINAL Event specialist AFTER independent review of " +
          "your Character. Do NOT edit the Event or claim to have finished its repair. " +
          "The Event's witness encounter is currently pending and the sealed review " +
          "is still negative. Ground WHY this Character is relevant to the specific " +
          "archive record and why the existing protagonists would approach her, " +
          "using actual cited Story context rather than inventing a prior encounter. " +
          "Give her an explicit, credible source-bound role, motivation and bounded " +
          "initial knowledge, but DO NOT narrate her testimony as already " +
          "delivered, claim she has already identified the missing ledger entry, " +
          "or assert a completed in-scene knowledge gain. Describe the capacity and " +
          "intention to testify; the separate Event owner must stage and source " +
          "the testimony before it becomes an enacted Story occurrence.\n"
        : "") +
      (create ? "Create ONLY this new canonical Markdown file with schema 0.1, exact type/id/title and typed references:\n" +
        JSON.stringify(create) + "\n" +
        "IMPORTANT: references and dependsOn in this JSON are controller-only dependency grants, NOT canonical YAML keys. " +
        "NEVER add references: or dependsOn: to the new record's frontmatter. " +
        "Translate them only into the permitted typed schema fields below, following nt-catalog.\n" +
        creationReferenceInstructions(create) +
        (arcLink
          ? "Also edit ONLY the existing Arc at " + arcLink.path +
            ": add " + arcLink.characterId + " to its characters array without changing any " +
            "other Arc metadata, protected decisions, formatting outside that array or prose. " +
            "Do not modify or create any other preexisting or new file. " :
            "Do not alter any preexisting files. ") +
        "Write substantive narrative content, not a placeholder, including actual in-scene " +
        "character dialogue for Authored Content. " :
        "Only edit these PREEXISTING canonical Markdown files:\n" + receipt.paths.join("\n")) +
      "\nAll other files are READ-ONLY context (including upstream prerequisites, milestones, " +
      (arcLink ? "other Arcs" : "Arcs") + ", and all sibling records). " +
      "Do not create any other files, use git commands, invoke untrusted shell commands, or change protected author decisions. " +
      "Preserve typed references and branch behavior. If a requested change requires additional records or upstream decisions, " +
      "use report_dependency for a sourced cross-domain prerequisite and stop WITHOUT ANY Story edits. " +
      "If you have already edited, stop for manual reconciliation instead. " +
      "Flag authorDecisionRequired ONLY for actual protected author decisions or material objective changes; " +
      "a missing knowledge effect on an unprotected Event is a routine causal prerequisite, not automatically an author decision. " +
      "Do not claim incomplete/delegated work is finished. " +
      "Original delivery obligations for report_dependency (0-based obligationIndex): " +
      JSON.stringify(obligations.map((obligation, index) => ({ index, obligation }))) +
      ". Pass the NUMBER obligationIndex, not any copied obligation text or path. " +
      "Include both the originating record ID and missing prerequisite record ID in affectedIds.\n" +
      (receipt.workItemId.startsWith("dependency:") ?
        "THIS IS A SEPARATELY AUTHORIZED SUPPORTING ASSIGNMENT, NOT THE ORIGINATING DIALOGUE WRITER. " +
        "The original Turn objective below is context, not your current write grant. " +
        "The controller has ALREADY checked the evidence and explicitly authorized YOU, " +
        "the proper specialist for the listed owned files, to implement this necessary prerequisite. " +
        "You are responsible for editing the allowed path(s) to fulfill your assigned outcome. " +
        "For any causal state effect you add, update its in-scene prose to substantiate " +
        "the actual observation or action that changes state, and remove any contradictory " +
        "claims that the effect has not happened. A mere metadata effect without a supported " +
        "canonical narrative occurrence is not enough for independent review. " +
        "Make the SMALLEST causal edit: preserve existing status, completeness, " +
        "prerequisites, consequences and unrelated steps unless independently justified. " +
        "Every referenced ID must be verified by reading an existing canonical record; " +
        "never invent an ID. " +
        "Do NOT stop and ask the original dialogue specialist or another Event specialist " +
        "to make these changes: YOU ARE the assigned specialist. Do not introduce unrelated edits.\n" : "") +
      (arcLink ?
        "CHARACTER CREATION PRECISION: The new Character ID is exactly " +
        arcLink.characterId + "; no other new record is authorized. The single permitted Arc " +
        "change is its characters list. Do not retcon any established knowledge or history, " +
        "or change any existing Character/Fact/Relationship. " : "") +
      (receipt.workItemId.startsWith("dependency:") && receipt.target.startsWith("event.") ?
        "EVENT SCHEMA PRECISION: Read the pinned nt-catalog progression reference before editing. " +
        "For a knowledge effect use EXACT flattened shape " +
        "`- {kind: knowledge, character: character.EXISTING, fact: fact.EXISTING, value: knows}`; " +
        "not nested knowledge:, not value: known. Locate the real Fact ID in the Story's " +
        "facts/ records using find/read before authoring. An inspection branch itself can " +
        "establish knowledge in its effects; it does NOT require a prior knowledge condition. " +
        "Do not promote a partial Event to complete to add this effect.\n" : "") +
      (receipt.resolvedDependency ? "A controller-authorized prerequisite has now been completed and reviewed. Re-read current canonical context before resuming your original assignment.\n" : "") +
      "The parent independently checks your precise Git diff and protected canonical validation.\n" +
      creativePolicyInstruction(policy) +
      (resume?.answer ? "\nAUTHENTICATED AUTHOR ANSWER (exact waiting assignment): " +
        authorChoiceDirection(resume.question, resume.answer, resume.delegationAllowed === true) +
        "\nContinue this original Pi session; keep the controller's existing write scope. " : "") +
      "\nIf the currently authorized edit requires an unresolved CONSEQUENTIALLY different " +
      "artistic direction not specified or delegated by the author, ask before editing. " +
      "Return JSON {authorDecisionRequest:{kind:'alternatives',question,options:[2–3 " +
      "{id,title,approach,benefits,tradeoffs}],recommendedId,recommendationReason},modifiedRecords:[]}. " +
      "You may instead use kind:'free-text', kind:'yes-no' or kind:'multiple-choice'; " +
      "Other/free text are always allowed. This explicitly author-gated focused " +
      "assignment does not permit Studio delegation through a question. " +
      "Give meaningful alternatives, an explicit reasoned " +
      "recommendation and concrete consequences. Never ask for routine phrasing, minor " +
      "staging, validator errors or already delegated details; do not request protected " +
      "canon approval via this mechanism. If asking, leave the Story and Git entirely " +
      "unchanged so the exact original assignment can resume after authenticated answer. " +
      "Otherwise implement the assigned edit normally; questions do not grant scope.\n" +
      "Original Turn goal: " + task + "\nSpecialist assignment outcome: " +
      (outcome ?? "Revise only the authorized record against the user request.") +
      (steering ? "\nSAFE-BOUNDARY AUTHOR PLAN AMENDMENT (additional, not replacement authority):\n" + steering : ""));
    const completedReads = () => {
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      return session.messages.flatMap(m => m.role === "assistant" ?
        m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
          c.type === "toolCall" && c.name === "read" && completed.has(c.id)) : [])
        .map(c => canonicalPinnedReadPath(String(c.arguments.path ?? ""), project.root, receipt.snapshot!.path));
    };
    const missingReads = () => required.filter(path => !completedReads().includes(path));
    if (missingReads().length)
      await promptStorySpecialist(session, "You did not successfully read all required pinned skill " +
        "references. Read EACH exact path below using the read tool, then stop. " +
        "Do not edit any Story file, redo work, or repeat a previously recorded dependency report. " +
        "If your last response was an author question, repeat the COMPLETE authorDecisionRequest " +
        "and empty modifiedRecords JSON after reading, without editing. Otherwise finish with a brief status.\nMISSING READS:\n" +
        missingReads().join("\n"));
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw new Error("Focused Pi specialist failed or was interrupted.");
    if (missingReads().length)
      throw new Error("Focused Pi specialist failed to read pinned skill guidance.");
    const requested = extractSpecialistChoice(session.getLastAssistantText() ?? "");
    if (requested) {
      const question = parseSpecialistChoice(requested.authorDecisionRequest);
      if (!Array.isArray(requested.modifiedRecords) || requested.modifiedRecords.length ||
          changes(job).length || git(job, "rev-parse", "HEAD").trim() !== receipt.expectedHead ||
          dependencyReport)
        throw Error("Focused author question requires a clean unchanged, authorized work item.");
      await context.completed(file, session.sessionId);
      return { authorQuestion: question, sessionFile: file, sessionId: session.sessionId };
    }
    await context.completed(file, session.sessionId);
    return dependencyReport;
  } finally { session.dispose(); }
}
export interface FocusedWorkOptions {
  story: string; job: string; target: string; task: string; contract: CompletionContract;
  fixture: boolean; skillsSource?: string; validatorSource?: string; provider?: string; model?: string;
  turnPlanDigest?: string;
  steering?: string;
  /** Internal controller lookup only; caller-supplied IDs never grant authority. */
  dependencyAssignmentId?: string;
}
export async function runFocusedWorkItem(input: FocusedWorkOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  return withStoryJobLock(job, "focus:" + input.target, async () => {
    const archPath = join(job.stateDir, "architecture.json");
    if (!existsSync(archPath)) throw new Error("Focused work requires a versioned canonical completion contract.");
    const arch = JSON.parse(await readFile(archPath, "utf8")) as {
      jobId: string; phase: string; plan?: { version: number; contract: CompletionContract } };
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan ||
        JSON.stringify(arch.plan.contract) !== JSON.stringify(input.contract))
      throw new Error("Focused work is not authorized by the pinned versioned completion contract.");
    const plan = arch.plan;
    const dependency = input.dependencyAssignmentId
      ? await authorizedDependency(job, input.dependencyAssignmentId, input.fixture) : null;
    if (dependency && (dependency.amendment!.assignment.targets[0] !== input.target ||
        dependency.report.turnDigest !== input.turnPlanDigest))
      throw Error("Dependency assignment differs from the trusted Turn/target.");
    const reviewAuthority = dependency?.reviewSourceSha && dependency.amendment?.assignment;
    const reviewRequest = dependency?.reviewSourceSha ?
      (await inspectDependencyPlan(job))?.reviewRequests?.find(r => r.sourceSha === dependency.reviewSourceSha) : undefined;
    let reviewCreate: PlannedFocusCreate | undefined;
    let reviewArc: string | undefined;
    if (reviewAuthority && reviewRequest?.classification === "new-full-story-record") {
      const grant = reviewAuthority.authority;
      const proposal = dependency!.proposal as ReviewCharacterProposal | undefined;
      const foundation = dependency!.reviewSourceSha &&
        (await inspectDependencyPlan(job))?.reviewRequests?.some(r =>
          r.sourceSha === dependency!.reviewSourceSha &&
          r.originalWorkItem === "character-foundations");
      const requiredTypes = foundation ? ["arc", "character"] : ["character"];
      if (reviewAuthority.specialist !== "nt-character-development" ||
          !/^character\.[a-z][a-z0-9-]*$/.test(input.target) ||
          JSON.stringify(grant.recordTypes) !== JSON.stringify(requiredTypes) ||
          grant.existingPaths.length !== (foundation ? 1 : 0) ||
          grant.newPaths?.length !== 1 ||
          grant.newPaths[0] !== "characters/" + input.target.slice(10) + ".md" ||
          (foundation && !grant.existingPaths[0]?.startsWith("arcs/")) ||
          !proposal?.title || proposal.target !== input.target)
        throw Error("Review dependency lacks one authorized Character creation with exact source ownership.");
      reviewCreate = { id: input.target, path: grant.newPaths[0], title: proposal.title,
        references: [], dependsOn: [] };
      reviewArc = foundation ? grant.existingPaths[0] : undefined;
    } else if (reviewAuthority) {
      const grant = reviewAuthority.authority;
      const exactPath = reviewRequest && reviewRequest.otherOwnerPath;
      if (reviewRequest?.classification !== "other-owner" ||
          reviewAuthority.specialist !== focusedSpecialist(input.target) ||
          reviewAuthority.targets.length !== 1 || reviewAuthority.targets[0] !== input.target ||
          !exactPath || JSON.stringify(grant.existingPaths) !== JSON.stringify([exactPath]) ||
          JSON.stringify(grant.recordTypes) !== JSON.stringify([input.target.split(".")[0]]) ||
          grant.mayCreate || grant.newPaths?.length)
        throw Error("Other-owner repair lacks its exact existing-record grant.");
    }
    if (!dependency && !input.contract.scope.targets.includes(input.target))
      throw new Error("Focused target is outside the explicit completion contract.");
    const workItemId = input.dependencyAssignmentId ?? "focus:" + input.target;
    const file = receiptPath(job, { workItemId, target: input.target });
    const current = await trustedHead(job);
    const actual = git(job, "rev-parse", "HEAD").toString().trim();
    if (changes(job).length || actual !== current) throw new Error("Focused worktree has changes requiring explicit reconciliation.");
    const validation = await validateStoryJob(job, input.validatorSource ?? input.skillsSource, { ...job, baseSha: current });
    const effectiveContract = dependency ? { ...input.contract, scope: { ...input.contract.scope,
      targets: [input.target], supportingTargets: [], creates: [] } } : input.contract;
    const catalog = reportOf(validation, current);
    // Review amendments deliberately cannot extend the immutable full-Story
    // contract. Their separate grant identifies one new Character plus the Arc
    // already cited by the negative reviewer. No supporting scope is inferred.
    const selection = reviewCreate ? (() => {
      const cited = dependency!.report.sources[0]?.path;
      const parent = catalog.find(r => r.path === cited &&
        r.metadata.type === (reviewArc ? "arc" : "event") &&
        r.metadata.status !== "superseded");
      if (!parent || reviewArc && (!Array.isArray(parent.metadata.characters) ||
          parent.path !== reviewArc) ||
          !reviewArc && !Array.isArray(parent.metadata.participants))
        throw Error("Controller-approved Character prerequisite source is absent from native canon.");
      const participants = (reviewArc ? parent.metadata.characters : parent.metadata.participants) as string[];
      const existingCharacters = catalog.filter(r => r.metadata.type === "character" &&
        participants.includes(r.metadata.id));
      const selected: CanonicalScopeRecord[] = [...(reviewArc ? [parent] : []),
        { path: reviewCreate.path,
          metadata: { id: reviewCreate.id, type: "character", status: "planned" } }];
      return { selected, context: [parent, ...existingCharacters,
        ...catalog.filter(r => ["fact", "world-entity"].includes(r.metadata.type) &&
          r.metadata.status !== "superseded").slice(0, 24)],
        allowedPaths: [...(reviewArc ? [reviewArc] : []), reviewCreate.path].sort() };
    })() : resolveFocusedScope(catalog, effectiveContract);
    const create = reviewCreate ?? effectiveContract.scope.creates?.find(item => item.id === input.target);
    const own = selection.selected.find(r => r.metadata.id === input.target);
    if (!own) throw new Error("Unknown focused target: " + input.target);
    // Shared supporting targets are authorized exactly once, with the first target.
    if (reviewRequest?.classification === "other-owner" && own.path !== reviewRequest.otherOwnerPath)
      throw Error("Other-owner source is not the selected native record.");
    const paths = [own.path, ...(reviewArc ? [reviewArc] :
      !dependency && input.target === input.contract.scope.targets[0] ? selection.selected
        .filter(r => input.contract.scope.supportingTargets?.includes(r.metadata.id)).map(r => r.path) : [])].sort();
    const types = [...new Set(paths.map(path => selection.selected.find(r => r.path === path)?.metadata.type))];
    if (types.some(type => !type)) throw new Error("A specialist path has no canonical record type.");
    const trustedSteering = await steeringForAssignment(job, input.turnPlanDigest, workItemId, current);
    if ((input.steering ?? "") !== trustedSteering)
      throw Error("Focused author steering differs from the controller-amended pending plan.");
    const turnPlan = await readTurnEvidence(job, input.contract, input.task, input.turnPlanDigest);
    if (create && (!turnPlan || !input.turnPlanDigest))
      throw new Error("Focused creation requires the original source-bound authenticated Turn assignment.");
    const turnAssignment = dependency?.amendment?.assignment ?? (turnPlan ? assertFocusedTurnAssignment(turnPlan, input.target, paths,
      types as string[]) : null);
    const turnAssignmentDigest = turnPlan?.digest;
    // Refuse symlinked / substituted records BEFORE Pi receives editing tools.
    for (const path of paths) {
      if (create && path === create.path) continue;
      const full = join(job.worktreeStoryRoot, path);
      if (await realpath(full) !== full || !(await lstat(full)).isFile())
        throw new Error("Focused record is not a safe regular canonical file: " + path);
    }
    const contractDigest = digest(JSON.stringify(plan.contract));
    let receipt: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    let dependencyResume: { file: string; id: string; changedPaths: string[] } | undefined;
    if (receipt) {
      if (receipt.jobId !== job.jobId || receipt.target !== input.target ||
          receipt.contractDigest !== contractDigest || receipt.planVersion !== plan.version ||
          JSON.stringify(receipt.paths) !== JSON.stringify(paths) ||
          receipt.worker !== (input.fixture ? "fixture" : "pi") ||
          receipt.assignmentDigest !== turnAssignmentDigest ||
          receipt.steeringDigest !== (input.steering ? digest(input.steering) : undefined))
        throw new Error("Focused work-item provenance differs from the original authorization.");
      if (receipt.resolvedDependency) {
        const history = await inspectDependencyPlan(job);
        const resolved = history?.entries.find(e => e.reportDigest === receipt!.resolvedDependency);
        if (resolved?.phase !== "verified" || resolved.commitSha !== receipt.expectedHead ||
            resolved.fixture !== input.fixture)
          throw Error("Originating assignment lost its verified dependency authorization history.");
      }
      if (receipt.phase === "committed") {
        if (receipt.authorChoiceId) {
          const choice = await inspectSpecialistChoice(job, receipt.authorChoiceId);
          if (choice.phase === "resuming") await completeSpecialistChoice(job, receipt.authorChoiceId);
        }
        if (!receipt.commitSha || !receipt.sha256) throw new Error("Missing focused commit verification evidence.");
        git(job, "merge-base", "--is-ancestor", receipt.commitSha, current);
        const message = git(job, "log", "-1", "--format=%B", receipt.commitSha).toString();
        if (!message.split("\n").includes("NovelTea-Work-Item: " + receipt.workItemId))
          throw new Error("Committed focused work has invalid provenance.");
        return { status: "focused-committed", headSha: receipt.commitSha, paths };
      }
      if (receipt.phase === "waiting-dependency") {
        const amendments = await inspectDependencyPlan(job);
        const resolved = amendments?.entries.find(e => e.reportDigest === dependencyDigest(receipt!.dependencyReport));
        if (!resolved || resolved.phase !== "verified") return { status: "dependency-required" };
        if (resolved.commitSha !== current || resolved.fixture !== input.fixture)
          throw Error("Resolved dependency is stale or belongs to a different worker mode.");
        const original = await inspectFocusedPrerequisite(job, input.target, turnAssignmentDigest!,
          input.fixture, plan.version);
        if (!original || original.seal.reportDigest !== resolved.reportDigest ||
            resolved.amendment?.resumes !== receipt.workItemId ||
            resolved.amendment.assignment.specialist !== original.report.likelySpecialist)
          throw Error("Focused continuation lacks authenticated original support.");
        if (!input.fixture) dependencyResume = { file: original.seal.sessionFile,
          id: original.seal.sessionId, changedPaths: resolved.amendment.assignment.authority.existingPaths };
        receipt.phase = "pending"; receipt.expectedHead = current;
        receipt.resolvedDependency = resolved.reportDigest;
        await save(file, receipt);
      }
      // A crash after persisting the authorized pending phase but before
      // dispatch must reopen the same exact session, not silently fork it.
      if (receipt.phase === "pending" && receipt.resolvedDependency && !input.fixture && !dependencyResume) {
        const original = await inspectFocusedPrerequisite(job, input.target, turnAssignmentDigest!,
          input.fixture, plan.version);
        const entry = (await inspectDependencyPlan(job))?.entries.find(e =>
          e.reportDigest === receipt!.resolvedDependency);
        if (!original || !entry?.amendment || entry.phase !== "verified" || entry.commitSha !== current ||
            entry.amendment.resumes !== receipt.workItemId)
          throw Error("Pending focused continuation lost its authenticated support.");
        dependencyResume = { file: original.seal.sessionFile, id: original.seal.sessionId,
          changedPaths: entry.amendment.assignment.authority.existingPaths };
      }
      if (receipt.phase === "writing" || receipt.phase === "authored")
        throw new Error("Interrupted focused writer: inspect preserved session and Git worktree; do not automatically replay.");
      if (receipt.phase === "awaiting-author") {
        if (!receipt.authorChoiceId || receipt.choiceWorkItem !== focusedChoiceWorkItem(receipt.target))
          throw Error("Focused author-choice receipt lacks its original specialist identity.");
        const choice = await inspectSpecialistChoice(job, receipt.authorChoiceId);
        if (choice.phase === "awaiting-author") throw new SpecialistChoiceRequiredError();
        if (choice.phase !== "answered") throw Error("Focused answer was already consumed.");
        await verifySpecialistChoice(job, receipt.authorChoiceId, "answered");
        if (choice.workItem !== receipt.choiceWorkItem || choice.headSha !== current)
          throw Error("Focused author choice differs from the original verified source.");
      }
    } else {
      if (dependency && current !== dependency.amendment!.sourceSha)
        throw Error("Dependency writer requires the exact authorized Story HEAD.");
      receipt = { version: 1, jobId: job.jobId, workItemId,
        planVersion: plan.version, contractDigest, expectedHead: current,
        phase: "pending", target: input.target, paths,
        context: selection.context.filter(r => r.metadata.status !== "planned")
          .map(r => r.path).sort(), worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        ...(turnAssignmentDigest ? { assignmentDigest: turnAssignmentDigest } : {}),
        ...(input.steering ? { steeringDigest: digest(input.steering) } : {}) };
      await save(file, receipt);
    }
    if (receipt.expectedHead !== current)
      throw new Error("Focused work was initialized against a different verified HEAD; inspect before writing.");
    if (create) {
      const full = join(job.worktreeStoryRoot, create.path);
      if (existsSync(full))
        throw new Error("Focused creation path already exists; never overwrite canonical Story bytes.");
      // Only the preauthorized canonical record directory may be materialized.
      await mkdir(dirname(full), { recursive: true });
      if (await realpath(dirname(full)) !== dirname(full))
        throw new Error("Focused creation directory is a symlink or unsafe path.");
    }
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : await loadSkillConfig(undefined, false);
    if (!receipt.snapshot) {
      const requiredSkills = [focusedSpecialist(input.target), "nt-catalog"];
      const snapshot = await createSkillSnapshot({ ...config, requiredSkills });
      if (!snapshot) throw new Error("Focused work requires pinned canonical skills.");
      receipt.snapshot = snapshot; await save(file, receipt);
    }
    if (await openSkillSnapshot(receipt.snapshot.id) !== receipt.snapshot.path)
      throw new Error("Focused skill snapshot changed.");
    await preflightPiAssignment(job, receipt.workItemId + ":" + plan.version,
      input.fixture ? undefined : { provider: receipt.provider, model: receipt.model });
    const resuming = receipt.phase === "awaiting-author" && !!receipt.authorChoiceId;
    const answered = resuming ? await verifySpecialistChoice(job, receipt.authorChoiceId!, "answered") : undefined;
    if (resuming) await claimSpecialistChoice(job, receipt.authorChoiceId!);
    receipt.phase = "writing"; await save(file, receipt);
    let missing: DependencyReport | undefined;
    const fixtureReport = input.fixture && !dependency && !receipt.resolvedDependency &&
      process.env.NT_FOCUS_FIXTURE_DEPENDENCY;
    if (fixtureReport) {
      missing = parseDependencyReport(JSON.parse(fixtureReport));
      if (missing.assignmentId !== receipt.workItemId) missing = undefined;
    }
    if (input.fixture && !missing) {
      for (const path of paths) {
        if (reviewArc && path === reviewArc) {
          const before = await readFile(join(job.worktreeStoryRoot, path), "utf8");
          await writeFile(join(job.worktreeStoryRoot, path), appendArcLink(before, input.target));
        } else if (create && path === create.path) {
          await writeFile(join(job.worktreeStoryRoot, path),
            fixtureCreatedRecord(create, input.contract, selection.context), { flag: "wx" });
        } else {
          const original = await readFile(join(job.worktreeStoryRoot, path), "utf8");
          await writeFile(join(job.worktreeStoryRoot, path), original + "\nFocused revision: " + input.task +
            (input.steering ? "\nAuthor steering: " + input.steering : "") + "\n");
        }
      }
      if (process.env.NT_FOCUS_FIXTURE_CASE === "unauthorized-edit") {
        const outside = selection.context.find(r => r.metadata.status !== "planned" &&
          !paths.includes(r.path));
        if (!outside) throw new Error("Unauthorized-edit fixture requires an upstream context record.");
        const path = join(job.worktreeStoryRoot, outside.path);
        await writeFile(path, await readFile(path, "utf8") + "\nUnauthorized fixture change\n");
      }
    } else if (!input.fixture) {
      const output = await writeWithPi(job, receipt, input.task, turnAssignment?.outcome,
        turnPlan?.creativePolicy ?? DEFAULT_CREATIVE_POLICY, create, turnPlan?.objective?.obligations,
        input.steering, answered,
        reviewArc ? { path: reviewArc, characterId: input.target } : undefined,
        !!reviewCreate && !reviewArc, dependencyResume);
      if (output && "authorQuestion" in output) {
        if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
        receipt.piSessionFile = output.sessionFile;
        receipt.piSessionId = output.sessionId;
        receipt.choiceWorkItem = focusedChoiceWorkItem(receipt.target);
        await save(file, receipt);
        const pending = await recordSpecialistChoice(job, receipt.choiceWorkItem, output.authorQuestion,
          output.sessionId, output.sessionFile);
        receipt.authorChoiceId = pending.id;
        receipt.phase = "awaiting-author";
        await save(file, receipt);
        throw new SpecialistChoiceRequiredError();
      }
      missing = output;
    }
    if (missing) {
      if (changes(job).length || git(job, "rev-parse", "HEAD").trim() !== current ||
          missing.sourceSha !== current || missing.turnDigest !== turnAssignmentDigest ||
          missing.assignmentId !== workItemId)
        throw Error("Dependency report is stale or writer left edits; preserve for manual reconciliation.");
      const transcript = input.fixture ? Buffer.alloc(0) : await readFile(receipt.piSessionFile!);
      receipt.dependencySuspension = { reportDigest: dependencyDigest(missing),
        sessionFile: input.fixture ? "fixture" : receipt.piSessionFile!,
        sessionId: input.fixture ? "fixture" : receipt.piSessionId!,
        transcriptBytes: transcript.length,
        transcriptSha256: input.fixture ? "f".repeat(64) :
          createHash("sha256").update(transcript).digest("hex") };
      receipt.dependencyReport = missing; receipt.phase = "waiting-dependency";
      await save(file, receipt);
      if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
      return { status: "dependency-required" };
    }
    const edited = changes(job);
    const statusPath = (entry: string) => entry.slice(3).replace(
      job.storyRelativePath ? job.storyRelativePath + "/" : "", "");
    if (!edited.length || edited.some(entry =>
      !paths.includes(statusPath(entry)) ||
      entry.slice(0, 2) !== (create && statusPath(entry) === create.path ? "??" : " M")) ||
      (create && !edited.some(entry => statusPath(entry) === create.path && entry.startsWith("??"))))
      throw new Error("Focused work changed a file outside its explicit authority; preserve edits for manual reconciliation.");
    if (git(job, "rev-parse", "HEAD").toString().trim() !== current)
      throw new Error("Focused Story HEAD changed during writer execution.");
    for (const entry of edited) {
      const path = entry.slice(3).replace(job.storyRelativePath ? job.storyRelativePath + "/" : "", "");
      const full = join(job.worktreeStoryRoot, path);
      if ((await realpath(full)) !== full || !(await lstat(full)).isFile())
        throw new Error("Unsafe focused record path; preserve changes for inspection.");
    }
    const after = await validateStoryJob(job, input.validatorSource ?? input.skillsSource, { ...job, baseSha: current });
    const accepted = reportOf(after, current);
    if (create && !accepted.some(item => item.metadata.id === create.id &&
        item.metadata.type === create.id.split(".")[0] && item.path === create.path &&
        item.metadata.status !== "superseded"))
      throw new Error("Native canonical validation did not recognize the exact new focused record.");
    if (reviewCreate && reviewArc) {
      const originalArc = git(job, "show", "HEAD:" + repoPath(job, reviewArc));
      const revisedArc = await readFile(join(job.worktreeStoryRoot, reviewArc), "utf8");
      auditArcLink(originalArc, revisedArc, input.target);
      const canonicalArc = accepted.find(r => r.path === reviewArc && r.metadata.type === "arc");
      if (!canonicalArc || !Array.isArray(canonicalArc.metadata.characters) ||
          !canonicalArc.metadata.characters.includes(input.target))
        throw Error("Native catalog does not verify the new Character's exact Arc link.");
    } else resolveFocusedScope(accepted, effectiveContract);
    if (dependency) receipt.validation = { status: "passed", validatorVersion: job.validatorVersion, baseSha: current };
    receipt.sha256 = digest(JSON.stringify(await Promise.all(paths.map(async path =>
      [path, digest(await readFile(join(job.worktreeStoryRoot, path), "utf8"))]))));
    receipt.phase = "authored"; await save(file, receipt);
    git(job, "add", "--", ...paths.map(path => repoPath(job, path)));
    git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com",
      "commit", "-m", (create ? "Create" : "Revise") + " focused Story record " + input.target + "\n\n" +
      "NovelTea-Job: " + job.jobId + "\nNovelTea-Work-Item: " + receipt.workItemId +
      "\nNovelTea-Plan-Version: " + plan.version + "\nNovelTea-Focused-Digest: " + receipt.sha256);
    if (changes(job).length) throw new Error("Focused commit left unexpected dirty worktree.");
    receipt.commitSha = git(job, "rev-parse", "HEAD").toString().trim();
    receipt.phase = "committed"; await save(file, receipt);
    if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
    const headFile = join(job.stateDir, "revisions", "verified-head.json");
    const previous = existsSync(headFile) ? JSON.parse(await readFile(headFile, "utf8")) as {
      jobId: string; headSha: string; version: number } : undefined;
    if (previous && (previous.jobId !== job.jobId || previous.headSha !== current))
      throw new Error("Verified HEAD changed during focused commit; manual reconciliation required.");
    await mkdir(dirname(headFile), { recursive: true });
    const headTemp = headFile + "." + randomUUID() + ".tmp";
    await writeFile(headTemp, JSON.stringify({ version: 1, jobId: job.jobId, headSha: receipt.commitSha,
      workItemId: receipt.workItemId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(headTemp, headFile);
    // Supporting commits retain their own source-bound native/work/review receipts.
    // They are not advertised as independently forkable generation checkpoints.
    if (!dependency) await finalizeRecoveryCheckpoint(job, receipt.workItemId, current, receipt.commitSha!);
    return { status: "focused-committed", headSha: receipt.commitSha, paths };
  });
}

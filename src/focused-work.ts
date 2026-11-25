import { assignmentCommittedEffect, type AssignmentDiagnosticAuthorization } from "./assignment-metadata-recovery.js";
import { createDependencyTool } from "./dependency-tool.js";
import { authorizedDependency, dependencyDigest, inspectDependencyPlan, dependencyWriterBase } from "./dependency-state.js";
import { parseDependencyReport, type DependencyReport } from "./dependency-amendments.js";
import { focusedSpecialist } from "./focused-specialist.js";
import { steeringForAssignment } from "./steering-amendments.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { execFileSync } from "./git-read-cache.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { CompletionContract, PlannedFocusCreate } from "./architecture.js";
import { normalizeArcCharacterLinks } from "./character-world.js";
import type { ReviewCharacterProposal } from "./dependency-amendments.js";
import { withStoryJobLock } from "./job-lock.js";
import { startStoryJob } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { createStoryValidateTool, validateStoryJob, type ValidationResult } from "./validator.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { preparePiContext, piNarrativeGroup, preflightPiAssignment, guardPiBudget, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import { promptStorySpecialist, StoryCancelledError } from "./story-interruption.js";
import { readJobControl } from "./job-control.js";
import { assignmentDraftEffect, executeAssignmentRound, nativeMetadataDefects, verifySettledAssignment, readPublishedDiagnosticGrant, inspectAssignmentFailure, ASSIGNMENT_REPORT, AssignmentAuthorPauseError, type AssignmentRoundCommand, type AssignmentRoundResult, type AssignmentInvocationProof, type AssignmentDefect } from "./assignment-metadata-recovery.js";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { resolveFocusedScope, type CanonicalScopeRecord } from "./focused-scope.js";
import { readTurnEvidence, assertFocusedTurnAssignment } from "./turn-plan-evidence.js";
import { creativePolicyInstruction, DEFAULT_CREATIVE_POLICY, type CreativePolicy } from "./creative-policy.js";
import { focusedChoiceWorkItem, recordSpecialistChoice, inspectSpecialistChoice, verifySpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, SpecialistChoiceRequiredError, authorChoiceDirection,
  parseSpecialistChoice, type SpecialistChoiceQuestion,
  type SpecialistChoiceReceipt } from "./specialist-choice.js";

interface Receipt {
  version: 1; jobId: string; workItemId: string; planVersion: number; contractDigest: string;
  expectedHead: string; phase: "pending" | "writing" | "authored" | "committed" | "waiting-dependency" | "awaiting-author";
  dependencyReport?: DependencyReport; resolvedDependency?: string;
  dependencySuspension?: { reportDigest: string; sessionId: string; sessionFile: string;
    transcriptBytes: number; transcriptSha256: string; invocationProof?: AssignmentInvocationProof; invocationPrefix?: string };
  target: string; paths: string[]; context: string[]; worker: "fixture" | "pi";
  provider: string; model: string; snapshot?: SkillSnapshot; piSessionFile?: string;
  invocationSource?: string; invocationPrefix?: string; invocationProof?: AssignmentInvocationProof; assignmentKey?: string;
  pendingDependencyReport?: DependencyReport;
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
  turnDigest: string, fixture: boolean, planVersion: number, workItemId = "focus:" + target) {
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(target))
    throw Error("Invalid focused prerequisite target.");
  if (workItemId !== "focus:" + target && !/^dependency:[1-9][0-9]*:[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(workItemId))
    throw Error("Invalid prerequisite work-item identity.");
  const file = receiptPath(job, { workItemId, target });
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  if (!receipt.dependencyReport) return null;
  const report = parseDependencyReport(receipt.dependencyReport);
  const seal = receipt.dependencySuspension;
  if (receipt.jobId !== job.jobId || receipt.target !== target ||
      receipt.workItemId !== workItemId || receipt.assignmentDigest !== turnDigest ||
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
    if (!seal.invocationProof)
      throw Error("Focused prerequisite lacks its original settled writer proof.");
    await verifySettledAssignment({ ...focusedInvocationOptions(job, {
      ...receipt, expectedHead: report.sourceSha, resolvedDependency: undefined,
      invocationSource: seal.invocationProof.sourceDigest, invocationPrefix: seal.invocationPrefix,
    }), proof: seal.invocationProof, effect: null, historical: receipt.phase !== "waiting-dependency" });
  }
  return { report, seal, phase: receipt.phase, paths: receipt.paths };
}
function focusedInvocationSource(job: JobStartResult, receipt: Receipt) {
  return digest(JSON.stringify({ job: job.jobId, thread: job.threadId, workItem: receipt.workItemId,
    key: receipt.assignmentKey, head: receipt.expectedHead, plan: receipt.planVersion,
    turn: receipt.assignmentDigest, contract: receipt.contractDigest, target: receipt.target,
    paths: receipt.paths, context: receipt.context, snapshot: receipt.snapshot?.id, provider: receipt.provider,
    model: receipt.model, support: receipt.resolvedDependency, steering: receipt.steeringDigest,
    prefix: receipt.invocationPrefix }));
}
function focusedInvocationOptions(job: JobStartResult, receipt: Receipt) {
  if (!receipt.invocationSource || receipt.invocationSource !== focusedInvocationSource(job, receipt) ||
      !receipt.piSessionFile || !receipt.piSessionId || !/^[a-zA-Z0-9-]+$/.test(receipt.piSessionId))
    throw new ProtocolIntegrityBlockedError("Focused writer lost its original source/session.");
  const root = join(job.stateDir, "focused-sessions", receipt.target);
  if (!receipt.piSessionFile.startsWith(root + sep))
    throw new ProtocolIntegrityBlockedError("Focused writer session is outside its original assignment.");
  return { directory: join(root, "invocations", receipt.piSessionId, receipt.invocationSource),
    sourceDigest: receipt.invocationSource, sessionId: receipt.piSessionId,
    sessionFile: receipt.piSessionFile, sessionRoots: [root], responseKind: "manifest-or-choice" as const };
}
export async function inspectFocusedFailure(job: JobStartResult, target: string, sourceHead: string,
    diagnostic?: AssignmentDiagnosticAuthorization, historicalHead?: string, workItemId = "focus:" + target) {
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(target)) return null;
  if (workItemId !== "focus:" + target && !new RegExp("^dependency:[1-9][0-9]*:" + target.replace(".", "\\.") + "$").test(workItemId))
    throw new ProtocolIntegrityBlockedError("Invalid Focused failure identity.");
  const file = receiptPath(job, { workItemId, target });
  if (!existsSync(file)) return null;
  const r = JSON.parse(await readFile(file, "utf8")) as Receipt;
  if (r.jobId !== job.jobId || r.workItemId !== workItemId || r.target !== target ||
      r.expectedHead !== sourceHead || (!diagnostic ? r.phase !== "writing" : !["writing", "authored", "committed"].includes(r.phase)) || r.worker !== "pi" || !r.assignmentKey) return null;
  const options = focusedInvocationOptions(job, r);
  const head = historicalHead ?? git(job, "rev-parse", "HEAD").trim();
  let effect: string | null;
  if (head === sourceHead && !historicalHead) effect = await assignmentDraftEffect(job, sourceHead);
  else {
    if (!diagnostic || !r.sha256 || !r.invocationProof ||
        !["authored", "committed"].includes(r.phase) ||
        historicalHead && (r.phase !== "committed" || r.commitSha !== head)) return null;
    const trailers = git(job, "log", "-1", "--format=%B", head).split("\n");
    if (!["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: " + r.workItemId,
      "NovelTea-Plan-Version: " + r.planVersion, "NovelTea-Focused-Digest: " + r.sha256]
      .every(line => trailers.includes(line))) throw Error("Original Focused diagnostic commit provenance changed");
    effect = assignmentCommittedEffect(job, sourceHead, head, r.paths, r.sha256);
    if (!historicalHead && !await inspectPendingFocusedCommit(job, target, sourceHead, workItemId)) return null;
    await verifySettledAssignment({ ...options, proof: r.invocationProof, effect, historical: !!historicalHead });
  }
  const terminal = await inspectAssignmentFailure({ ...options, effect, diagnostic, historical: !!historicalHead });
  return terminal && { ...terminal, ref: options.directory + "/terminal.json", workItem: r.workItemId,
    assignmentKey: r.assignmentKey, invocationProof: r.invocationProof, sessionId: r.piSessionId! };
}
export async function inspectPublishedFocusedDiagnostic(job: JobStartResult, target: string,
  workItemId: string, head: string) {
  const receipt = JSON.parse(await readFile(receiptPath(job, {workItemId, target}), "utf8")) as Receipt;
  if (receipt.jobId !== job.jobId || receipt.workItemId !== workItemId || receipt.target !== target ||
      receipt.phase !== "committed" || receipt.commitSha !== head || !receipt.invocationProof || !receipt.sha256)
    throw new ProtocolIntegrityBlockedError("Published supporting writer lost its receipt");
  const options = focusedInvocationOptions(job, receipt);
  const effect = assignmentCommittedEffect(job, receipt.expectedHead, head, receipt.paths, receipt.sha256);
  await verifySettledAssignment({ ...options, proof: receipt.invocationProof, effect, historical: true });
  const grant = await readPublishedDiagnosticGrant(options.directory, receipt.invocationProof);
  return grant && { ...grant, ref: options.directory + "/terminal.json", sourceHead: receipt.expectedHead };
}

export async function inspectPendingFocusedInvocation(job: JobStartResult, target: string, workItemId = "focus:" + target) {
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(target)) return null;
  if (workItemId !== "focus:" + target && !new RegExp("^dependency:[1-9][0-9]*:" + target.replace(".", "\\.") + "$").test(workItemId))
    throw new ProtocolIntegrityBlockedError("Invalid Focused work-item identity.");
  const file = receiptPath(job, { workItemId, target });
  if (!existsSync(file)) return null;
  const r = JSON.parse(await readFile(file, "utf8")) as Receipt;
  if (r.worker !== "pi" || r.phase !== "writing") return null;
  if (r.jobId !== job.jobId || r.target !== target || r.workItemId !== workItemId ||
      !r.assignmentKey || r.invocationSource !== focusedInvocationSource(job, r))
    throw new ProtocolIntegrityBlockedError("Focused pending writer source changed.");
  await assignmentDraftEffect(job, r.expectedHead);
  if (r.piSessionFile || r.piSessionId) {
    const options = focusedInvocationOptions(job, r);
    if (await realpath(options.sessionFile) !== options.sessionFile ||
        !(await lstat(options.sessionFile)).isFile())
      throw new ProtocolIntegrityBlockedError("Focused pending session is unsafe.");
  } else if (changes(job).length) throw new ProtocolIntegrityBlockedError("Focused draft lacks its original session.");
  return r;
}
/** Validate the immutable source, never use malformed draft metadata to derive
 * a new grant. The detached view is only needed while an admitted draft exists. */
async function focusedSourceCatalog(job: JobStartResult, head: string, source?: string) {
  if (!changes(job).length)
    return reportOf(await validateStoryJob(job, source, { ...job, baseSha: head }), head);
  const parent = await mkdtemp(join(tmpdir(), "nt-focus-source-"));
  const root = join(parent, "source");
  let added = false;
  try {
    git(job, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", root, head);
    added = true;
    return reportOf(await validateStoryJob(job, source, { worktreeRoot: root,
      worktreeStoryRoot: join(root, job.storyRelativePath), baseSha: head }), head);
  } finally {
    if (added) git(job, "worktree", "remove", "--force", root);
    await rm(parent, { recursive: true, force: true });
  }
}
function changes(job: JobStartResult) {
  return git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").toString()
    .split("\0").filter(Boolean);
}
/** Only an exact committed focused effect can cross the publication gap. */
export async function inspectPendingFocusedCommit(job: JobStartResult, target: string, sourceHead?: string, workItemId = "focus:" + target) {
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(target)) return null;
  if (workItemId !== "focus:" + target && !new RegExp("^dependency:[1-9][0-9]*:" + target.replace(".", "\\.") + "$").test(workItemId))
    throw new ProtocolIntegrityBlockedError("Invalid Focused work-item identity.");
  const file = receiptPath(job, { workItemId, target });
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  if (!["authored", "committed"].includes(receipt.phase) ||
      sourceHead && receipt.expectedHead !== sourceHead) return null;
  const head = git(job, "rev-parse", "HEAD").trim();
  if (head === receipt.expectedHead || receipt.commitSha && receipt.commitSha !== head) return null;
  if (receipt.jobId !== job.jobId || receipt.workItemId !== workItemId || receipt.target !== target ||
      !receipt.sha256 || changes(job).length ||
      git(job, "symbolic-ref", "--short", "HEAD").trim() !== job.branch ||
      git(job, "rev-parse", head + "^").trim() !== receipt.expectedHead)
    throw Error("Focused commit reconciliation lost its original assignment or Git source.");
  const trailers = git(job, "log", "-1", "--format=%B", head).split("\n");
  if (!["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: " + receipt.workItemId,
    "NovelTea-Plan-Version: " + receipt.planVersion, "NovelTea-Focused-Digest: " + receipt.sha256]
    .every(line => trailers.includes(line))) throw Error("Focused commit provenance changed.");
  const committedPaths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", head).trim().split("\n").sort();
  if (JSON.stringify(committedPaths) !== JSON.stringify(receipt.paths.map(p => repoPath(job, p)).sort()))
    throw Error("Focused committed path inventory changed.");
  const actualDigest = digest(JSON.stringify(await Promise.all(receipt.paths.map(async p => {
    if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.md$/.test(p)) throw Error("Unsafe focused commit path.");
    const full = join(job.worktreeStoryRoot, p);
    if (await realpath(full) !== full || !(await lstat(full)).isFile()) throw Error("Unsafe focused commit file.");
    return [p, digest(await readFile(full, "utf8"))];
  }))));
  if (actualDigest !== receipt.sha256) throw Error("Focused committed content changed.");
  if (receipt.worker === "pi" && receipt.assignmentKey) {
    if (!receipt.invocationProof) throw new ProtocolIntegrityBlockedError("Focused commit lacks its settled writer receipt.");
    await verifySettledAssignment({ ...focusedInvocationOptions(job, receipt), proof: receipt.invocationProof,
      effect: actualDigest, historical: true });
  }
  return { ...receipt, commitSha: head };
}
async function publishFocusedHead(job: JobStartResult, receipt: Receipt) {
  const headFile = join(job.stateDir, "revisions", "verified-head.json");
  const previous = existsSync(headFile) ? JSON.parse(await readFile(headFile, "utf8")) as {
    jobId: string; headSha: string; version: number } : undefined;
  if (previous && (previous.jobId !== job.jobId ||
      ![receipt.expectedHead, receipt.commitSha].includes(previous.headSha)))
    throw Error("Verified HEAD changed during focused commit; manual reconciliation required.");
  if (previous?.headSha !== receipt.commitSha) {
    await mkdir(dirname(headFile), { recursive: true });
    const headTemp = headFile + "." + randomUUID() + ".tmp";
    await writeFile(headTemp, JSON.stringify({ version: 1, jobId: job.jobId, headSha: receipt.commitSha,
      workItemId: receipt.workItemId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(headTemp, headFile);
  }
  if (!receipt.workItemId.startsWith("dependency:"))
    await finalizeRecoveryCheckpoint(job, receipt.workItemId, receipt.expectedHead, receipt.commitSha!);
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
  arcLink?: { paths: string[]; characterId: string },
  eventReviewSupport = false, dependencyResume?: { file: string; id: string; changedPaths: string[] },
  round: AssignmentRoundCommand | undefined = undefined, verifyDraft?: (manifest: Record<string, unknown>) => Promise<AssignmentDefect[]>): Promise<DependencyReport | {
    authorQuestion: SpecialistChoiceQuestion; sessionFile: string; sessionId: string;
  } | { round: AssignmentRoundResult } | undefined> {
  let dependencyReport: DependencyReport | undefined = receipt.pendingDependencyReport;
  const dependencyTool = receipt.assignmentDigest && obligations.length > 0 && !receipt.resolvedDependency
    ? createDependencyTool(job, { head: receipt.expectedHead, turnDigest: receipt.assignmentDigest,
        assignmentId: receipt.workItemId, obligations, originTarget: receipt.target }, async report => {
          if (dependencyReport) throw Error("Only one dependency report per bounded assignment is permitted.");
          dependencyReport = report;
          if (round) { receipt.pendingDependencyReport = report; await save(receiptPath(job, receipt), receipt); }
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
      receipt.context, receipt.target) + ":" + receipt.workItemId,
    step: receipt.workItemId + ":" + receipt.planVersion + (receipt.resolvedDependency ? ":" + receipt.resolvedDependency : ""),
    paths: receipt.context, snapshot: receipt.snapshot!.id, provider: receipt.provider,
    model: receipt.model, directory: join(job.stateDir, "focused-sessions", receipt.target),
    ...(dependencyResume ? { resumeSession: dependencyResume } : {}), insideWriter: !!round,
    task: { kind: receipt.target.startsWith("event.") ? "event" :
      receipt.target.startsWith("puzzle.") || receipt.target.startsWith("choice-point.") ? "puzzle" :
      receipt.target.startsWith("authored-content.") ? "dialogue" : "character",
      ids: [receipt.target], scope: "focused" },
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, receipt.snapshot!, loader.getSkills().skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: resume || round && receipt.piSessionFile
      ? SessionManager.open(resume?.sessionFile ?? receipt.piSessionFile!, dirname(resume?.sessionFile ?? receipt.piSessionFile!), project.root)
      : context.manager, customTools: [...(sandboxTools ?? []), context.contextTool, createPiStatusTool(), createStoryValidateTool(job),
      ...(dependencyTool ? [dependencyTool] : [])],
    noTools: "all", tools: [...(create ? ["write"] : []),
      "read", "edit", "grep", "find", "ls", "story_context", "report_status", "story_validate",
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
    if (round && receipt.piSessionId && (receipt.piSessionId !== session.sessionId || receipt.piSessionFile !== file))
      throw new ProtocolIntegrityBlockedError("Focused writer lost its original Pi session.");
    receipt.piSessionFile = file;
    receipt.piSessionId = session.sessionId;
    await save(receiptPath(job, receipt), receipt);
    const required = [join(receipt.snapshot!.path, "skills", skill, "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "references", "records.md"),
      ...(receipt.target.startsWith("event.") ?
        [join(receipt.snapshot!.path, "skills", "nt-catalog", "references", "progression.md")] : [])];
    const initialPrompt = context.contextNote +
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
          ? "Also edit ONLY the existing Arcs at " + arcLink.paths.join(", ") +
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
        "Do not delegate your own authorized work. If a distinct, necessary cross-owner prerequisite prevents it, report_dependency without edits; the controller will decide and resume this assignment. Do not introduce unrelated edits.\n" : "") +
      (arcLink ?
        "CHARACTER LINK PRECISION: The Character ID is exactly " +
        arcLink.characterId + "; no other new record is authorized. The only permitted Arc " +
        "change is its characters list, appending this exact Character ID to each authorized Arc. Do not retcon any established knowledge or history, " +
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
      (steering ? "\nSAFE-BOUNDARY AUTHOR PLAN AMENDMENT (additional, not replacement authority):\n" + steering : "") +
      (round ? "\n" + ASSIGNMENT_REPORT : "");
    const completedReads = () => {
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      return session.messages.flatMap(m => m.role === "assistant" ?
        m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
          c.type === "toolCall" && c.name === "read" && completed.has(c.id)) : [])
        .map(c => canonicalPinnedReadPath(String(c.arguments.path ?? ""), project.root, receipt.snapshot!.path));
    };
    const missingReads = () => required.filter(path => !completedReads().includes(path));
    if (round) {
      const options = focusedInvocationOptions(job, receipt);
      let answer: { authorQuestion: SpecialistChoiceQuestion; sessionFile: string; sessionId: string } | undefined;
      const result = await executeAssignmentRound({
        ...options, session, initialPrompt, initialTranscriptSha256: receipt.invocationPrefix,
        authorize: async () => {
          if (receipt.invocationSource !== focusedInvocationSource(job, receipt))
            throw new ProtocolIntegrityBlockedError("Focused original source changed.");
          await assignmentDraftEffect(job, receipt.expectedHead);
        },
        effect: () => assignmentDraftEffect(job, receipt.expectedHead),
        beforeTurn: async () => {
          const control = await readJobControl(job);
          if (control === "paused") throw new AssignmentAuthorPauseError();
          if (control === "cancelled") throw new StoryCancelledError("Focused writer cancelled.");
          await guardPiBudget(job, receipt.workItemId + ":" + receipt.planVersion, file);
        },
        prompt: async prompt => {
          await registerPendingPiSession(job, file);
          await promptStorySpecialist(session, prompt);
          await recordPiSession(job, file);
        },
        verify: async manifest => {
          if (missingReads().length)
            return missingReads().map(path => ({ kind: "requirement" as const, path: receipt.paths[0]!,
              code: "missing-pinned-skill-read", detail: "Read skill://" + path.slice(path.lastIndexOf("/skills/") + 8) }));
          if ("authorDecisionRequest" in manifest) {
            if (dependencyReport || await assignmentDraftEffect(job, receipt.expectedHead) !== null ||
                (manifest.modifiedRecords as string[]).length)
              throw new ProtocolIntegrityBlockedError("Focused Author Choice must have no Story effects.");
            answer = { authorQuestion: parseSpecialistChoice(manifest.authorDecisionRequest), sessionFile: file, sessionId: session.sessionId };
            return [];
          }
          if (dependencyReport) {
            if (await assignmentDraftEffect(job, receipt.expectedHead) !== null ||
                (manifest.modifiedRecords as string[]).length)
              throw new ProtocolIntegrityBlockedError("Focused prerequisite must have no Story effects.");
            const successful = new Set(session.messages.filter(m => m.role === "toolResult" && !m.isError)
              .map(m => m.role === "toolResult" ? m.toolCallId : ""));
            if (!session.messages.some(m => m.role === "assistant" && m.content.some(c =>
                c.type === "toolCall" && c.name === "report_dependency" && successful.has(c.id))))
              throw new ProtocolIntegrityBlockedError("Focused prerequisite lacks its successful source-bound tool report.");
            return [];
          }
          return verifyDraft!(manifest);
        },
      }, round);
      if (result.status !== "accepted") return { round: result };
      receipt.invocationProof = result.proof;
      await save(receiptPath(job, receipt), receipt);
      await context.completed(file, session.sessionId);
      return answer ?? dependencyReport;
    }
    throw new ProtocolIntegrityBlockedError("Focused Pi invocation requires its admitted round.");
  } finally { session.dispose(); }
}
export interface FocusedWorkOptions {
  story: string; job: string; target: string; task: string; contract: CompletionContract;
  fixture: boolean; skillsSource?: string; validatorSource?: string; provider?: string; model?: string;
  turnPlanDigest?: string;
  steering?: string;
  /** Internal controller lookup only; caller-supplied IDs never grant authority. */
  dependencyAssignmentId?: string;
  round?: { assignmentKey: string; command: AssignmentRoundCommand };
}
export async function runFocusedWorkItem(input: FocusedWorkOptions) {
  if (input.fixture) throw Error("Structural fixture execution is retired; use an authenticated Generation assignment.");
  if (!input.round)
    throw new ProtocolIntegrityBlockedError("Focused Pi writing requires its checkpointed assignment child.");
  if (input.round && !/^[a-f0-9]{64}$/.test(input.round.assignmentKey))
    throw new ProtocolIntegrityBlockedError("Focused writer lacks an admitted logical assignment key.");
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
    const dependencyBase = dependency ? dependencyWriterBase((await inspectDependencyPlan(job))!, dependency) : undefined;
    if (dependency && (dependency.amendment!.assignment.targets[0] !== input.target ||
        dependency.report.turnDigest !== input.turnPlanDigest))
      throw Error("Dependency assignment differs from the trusted Turn/target.");
    const reviewAuthority = (dependency?.reviewSourceSha || dependency?.blueprintSource) && dependency.amendment?.assignment;
    const reviewRequest = dependency?.reviewSourceSha ?
      (await inspectDependencyPlan(job))?.reviewRequests?.find(r => r.sourceSha === dependency.reviewSourceSha) : undefined;
    let reviewCreate: PlannedFocusCreate | undefined;
    let reviewArcs: string[] = [];
    let existingBlueprintLink = false;
    if (reviewAuthority && (reviewRequest?.classification === "new-full-story-record" || dependency?.blueprintSource)) {
      const grant = reviewAuthority.authority;
      const proposal = dependency!.proposal as ReviewCharacterProposal | undefined;
      const blueprint = dependency!.blueprintSource;
      const foundation = !!blueprint || dependency!.reviewSourceSha &&
        (await inspectDependencyPlan(job))?.reviewRequests?.some(r =>
          r.sourceSha === dependency!.reviewSourceSha &&
          r.originalWorkItem === "character-foundations");
      existingBlueprintLink = blueprint?.readiness === "outside-event-authority";
      const requiredTypes = existingBlueprintLink ? ["arc"] : foundation ? ["arc", "character"] : ["character"];
      if (reviewAuthority.specialist !== "nt-character-development" ||
          !/^character\.[a-z][a-z0-9-]*$/.test(input.target) ||
          JSON.stringify(grant.recordTypes) !== JSON.stringify(requiredTypes) ||
          (foundation ? grant.existingPaths.length < 1 : grant.existingPaths.length !== 0) ||
          (!blueprint && foundation && grant.existingPaths.length !== 1) ||
          (existingBlueprintLink ? grant.mayCreate || !!grant.newPaths?.length
            : grant.newPaths?.length !== 1 ||
              grant.newPaths[0] !== "characters/" + input.target.slice(10) + ".md") ||
          (foundation && grant.existingPaths.some(path => !path.startsWith("arcs/"))) ||
          !proposal?.title || proposal.target !== input.target)
        throw Error("Review dependency lacks authorized Character and exact source ownership.");
      if (!existingBlueprintLink) reviewCreate = { id: input.target, path: grant.newPaths![0]!, title: proposal.title,
        references: [], dependsOn: [] };
      reviewArcs = foundation ? grant.existingPaths : [];
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
    const pendingCommit = await inspectPendingFocusedCommit(job, input.target, undefined, workItemId);
    if (pendingCommit) {
      const receipt = pendingCommit;
      const turn = await readTurnEvidence(job, input.contract, input.task, input.turnPlanDigest);
      if (receipt.planVersion !== plan.version || receipt.contractDigest !== digest(JSON.stringify(plan.contract)) ||
          receipt.worker !== ("pi") || receipt.assignmentDigest !== turn?.digest ||
          receipt.steeringDigest !== (input.steering ? digest(input.steering) : undefined) ||
          (!turn))
        throw Error("Focused committed receipt no longer matches original Turn authority.");
      const records = reportOf(await validateStoryJob(job, input.validatorSource ?? input.skillsSource,
        { ...job, baseSha: receipt.expectedHead }), receipt.expectedHead);
      if (dependency) {
        const grant = dependency.amendment!.assignment.authority;
        const paths = [...grant.existingPaths, ...(grant.newPaths ?? [])].sort();
        if (receipt.assignmentKey !== input.round?.assignmentKey ||
            receipt.expectedHead !== dependencyBase ||
            JSON.stringify(paths) !== JSON.stringify(receipt.paths) ||
            paths.some(path => !records.some(record => record.path === path)))
          throw new ProtocolIntegrityBlockedError("Supporting commit differs from its original grant.");
        receipt.validation = { status: "passed", validatorVersion: job.validatorVersion, baseSha: receipt.expectedHead };
      } else {
      const ownedIds = [input.target, ...(input.target === input.contract.scope.targets[0] ?
        input.contract.scope.supportingTargets ?? [] : [])];
      const owned = records.filter(record => ownedIds.includes(record.metadata.id));
      if (JSON.stringify(owned.map(r => r.path).sort()) !== JSON.stringify(receipt.paths) ||
          owned.length !== ownedIds.length) throw Error("Focused committed paths differ from authorized targets.");
      if (turn) assertFocusedTurnAssignment(turn, input.target, receipt.paths,
        [...new Set(owned.map(r => r.metadata.type))].sort());
      }
      if (receipt.assignmentKey !== input.round?.assignmentKey)
        throw new ProtocolIntegrityBlockedError("Committed Focused receipt belongs to another assignment.");
      receipt.phase = "committed";
      await save(file, receipt);
      if (receipt.authorChoiceId && (await inspectSpecialistChoice(job, receipt.authorChoiceId)).phase === "resuming")
        await completeSpecialistChoice(job, receipt.authorChoiceId);
      await publishFocusedHead(job, receipt);
      return { status: "focused-committed", headSha: receipt.commitSha, paths: receipt.paths };
    }
    const originalReceipt = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) as Receipt : undefined;
    const continuing = originalReceipt?.worker === "pi" && originalReceipt.phase === "writing" && !!input.round;
    const current = await trustedHead(job);
    const actual = git(job, "rev-parse", "HEAD").toString().trim();
    if ((!continuing && changes(job).length) || actual !== current) throw new Error("Focused worktree has changes requiring explicit reconciliation.");
    if (continuing && (originalReceipt!.expectedHead !== current || originalReceipt!.assignmentKey !== input.round!.assignmentKey ||
        originalReceipt!.invocationSource !== focusedInvocationSource(job, originalReceipt!)))
      throw new ProtocolIntegrityBlockedError("Focused round belongs to a different original grant.");
    const effectiveContract = dependency ? { ...input.contract, scope: { ...input.contract.scope,
      targets: [input.target], supportingTargets: [], creates: [] } } : input.contract;
    const catalog = await focusedSourceCatalog(job, current, input.validatorSource ?? input.skillsSource);
    // Review amendments deliberately cannot extend the immutable full-Story
    // contract. Their separate grant identifies one new Character plus the Arc
    // already cited by the negative reviewer. No supporting scope is inferred.
    const selection = reviewCreate || existingBlueprintLink ? (() => {
      const parents = reviewArcs.length ? reviewArcs.map(path => catalog.find(r => r.path === path &&
        r.metadata.type === "arc" && r.metadata.status !== "superseded")) :
        [catalog.find(r => r.path === dependency!.report.sources[0]?.path &&
          r.metadata.type === "event" && r.metadata.status !== "superseded")];
      if (parents.some(parent => !parent || !Array.isArray(reviewArcs.length
          ? parent.metadata.characters : parent.metadata.participants)))
        throw Error("Controller-approved Character prerequisite source is absent from native canon.");
      const participants = parents.flatMap(parent =>
        (reviewArcs.length ? parent!.metadata.characters : parent!.metadata.participants) as string[]);
      const existing = existingBlueprintLink ? catalog.find(r => r.metadata.id === input.target &&
        r.metadata.type === "character" && r.metadata.status !== "superseded" &&
        r.path === dependency!.blueprintSource!.targetPath) : undefined;
      if (existingBlueprintLink && !existing) throw Error("Existing Character prerequisite lost its canonical source.");
      const existingCharacters = catalog.filter(r => r.metadata.type === "character" &&
        participants.includes(r.metadata.id));
      const selected: CanonicalScopeRecord[] = [...(reviewArcs.length ? parents as CanonicalScopeRecord[] : []),
        ...(reviewCreate ? [{ path: reviewCreate.path,
          metadata: { id: reviewCreate.id, type: "character", status: "planned" } }] : [])];
      const context = [...parents as CanonicalScopeRecord[], ...existingCharacters,
        ...(existing ? [existing] : []),
        ...catalog.filter(r => dependency!.report.sources.some(source => source.path === r.path)),
        ...catalog.filter(r => ["fact", "world-entity"].includes(r.metadata.type) &&
          r.metadata.status !== "superseded").slice(0, 24)];
      return { selected, context: [...new Map(context.map(r => [r.path, r])).values()],
        allowedPaths: [...reviewArcs, ...(reviewCreate ? [reviewCreate.path] : [])].sort() };
    })() : resolveFocusedScope(catalog, effectiveContract);
    const create = reviewCreate ?? effectiveContract.scope.creates?.find(item => item.id === input.target);
    const own = selection.selected.find(r => r.metadata.id === input.target);
    if (!own && !existingBlueprintLink) throw new Error("Unknown focused target: " + input.target);
    if (reviewRequest?.classification === "other-owner" && own?.path !== reviewRequest.otherOwnerPath)
      throw Error("Other-owner source is not the selected native record.");
    const paths = dependency ? [...dependency.amendment!.assignment.authority.existingPaths,
      ...(dependency.amendment!.assignment.authority.newPaths ?? [])].sort() :
      [own!.path, ...(input.target === input.contract.scope.targets[0] ? selection.selected
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
          receipt.worker !== ("pi") ||
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
          input.fixture, plan.version, workItemId);
        if (!original || original.seal.reportDigest !== resolved.reportDigest ||
            resolved.amendment?.resumes !== receipt.workItemId ||
            resolved.amendment.assignment.specialist !== original.report.likelySpecialist)
          throw Error("Focused continuation lacks authenticated original support.");
        dependencyResume = { file: original.seal.sessionFile,
          id: original.seal.sessionId, changedPaths: git(job, "diff", "--name-only", resolved.report.sourceSha, resolved.commitSha!).trim().split("\n").map(p => job.storyRelativePath ? p.slice(job.storyRelativePath.length + 1) : p) };
        receipt.phase = "pending"; receipt.expectedHead = current;
        delete receipt.pendingDependencyReport; delete receipt.invocationProof;
        delete receipt.invocationSource; receipt.invocationPrefix = original.seal.transcriptSha256;
        receipt.resolvedDependency = resolved.reportDigest;
        await save(file, receipt);
      }
      // A crash after persisting the authorized pending phase but before
      // dispatch must reopen the same exact session, not silently fork it.
      if (receipt.phase === "pending" && receipt.resolvedDependency && !dependencyResume) {
        const original = await inspectFocusedPrerequisite(job, input.target, turnAssignmentDigest!,
          input.fixture, plan.version, workItemId);
        const entry = (await inspectDependencyPlan(job))?.entries.find(e =>
          e.reportDigest === receipt!.resolvedDependency);
        if (!original || !entry?.amendment || entry.phase !== "verified" || entry.commitSha !== current ||
            entry.amendment.resumes !== receipt.workItemId)
          throw Error("Pending focused continuation lost its authenticated support.");
        dependencyResume = { file: original.seal.sessionFile, id: original.seal.sessionId,
          changedPaths: git(job, "diff", "--name-only", entry.report.sourceSha, entry.commitSha!).trim().split("\n").map(p => job.storyRelativePath ? p.slice(job.storyRelativePath.length + 1) : p) };
      }
      if (!continuing && (receipt.phase === "writing" || receipt.phase === "authored"))
        throw new Error("Interrupted focused writer: inspect preserved session and Git worktree; do not automatically replay.");
      if (receipt.phase === "awaiting-author") {
        if (!receipt.authorChoiceId || receipt.choiceWorkItem !== focusedChoiceWorkItem(receipt.target, receipt.workItemId))
          throw Error("Focused author-choice receipt lacks its original specialist identity.");
        const choice = await inspectSpecialistChoice(job, receipt.authorChoiceId);
        if (choice.phase === "awaiting-author") throw new SpecialistChoiceRequiredError();
        if (choice.phase !== "answered") throw Error("Focused answer was already consumed.");
        await verifySpecialistChoice(job, receipt.authorChoiceId, "answered");
        if (choice.workItem !== receipt.choiceWorkItem || choice.headSha !== current)
          throw Error("Focused author choice differs from the original verified source.");
      }
    } else {
      if (dependency && current !== dependencyBase)
        throw Error("Dependency writer requires the exact authorized Story HEAD.");
      receipt = { version: 1, jobId: job.jobId, workItemId,
        planVersion: plan.version, contractDigest, expectedHead: current,
        phase: "pending", target: input.target, paths,
        context: selection.context.filter(r => r.metadata.status !== "planned")
          .map(r => r.path).sort(), worker: "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        ...(turnAssignmentDigest ? { assignmentDigest: turnAssignmentDigest } : {}),
        ...(input.steering ? { steeringDigest: digest(input.steering) } : {}) };
      await save(file, receipt);
    }
    if (receipt.expectedHead !== current)
      throw new Error("Focused work was initialized against a different verified HEAD; inspect before writing.");
    if (create) {
      const full = join(job.worktreeStoryRoot, create.path);
      if (existsSync(full) && !continuing)
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
    if (!continuing) await preflightPiAssignment(job, receipt.workItemId + ":" + plan.version,
      { provider: receipt.provider, model: receipt.model });
    const resuming = receipt.phase === "awaiting-author" && !!receipt.authorChoiceId;
    const answered = resuming ? await verifySpecialistChoice(job, receipt.authorChoiceId!, "answered") :
      continuing && receipt.authorChoiceId && (await inspectSpecialistChoice(job, receipt.authorChoiceId)).phase === "resuming"
        ? await inspectSpecialistChoice(job, receipt.authorChoiceId) : undefined;
    if (resuming) await claimSpecialistChoice(job, receipt.authorChoiceId!);
    if (!continuing && input.round) {
      if (input.round.command.phase !== "invoke" || receipt.assignmentKey && receipt.assignmentKey !== input.round.assignmentKey)
        throw new ProtocolIntegrityBlockedError("Focused writer requires its original child admission.");
      receipt.assignmentKey = input.round.assignmentKey;
      if (answered) { receipt.invocationPrefix = answered.sessionSha256; delete receipt.invocationProof; }
      receipt.invocationSource = focusedInvocationSource(job, receipt);
    }
    receipt.phase = "writing"; await save(file, receipt);
    const verifyDraft = async (manifest?: Record<string, unknown>): Promise<AssignmentDefect[]> => {
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
      if (manifest && JSON.stringify([...(manifest.modifiedRecords as string[])].sort()) !==
          JSON.stringify(edited.map(statusPath).sort()))
        return [{ kind: "requirement" as const, path: paths[0]!, code: "focused-manifest-path-mismatch",
          detail: "Actual cumulative changed paths: " + JSON.stringify(edited.map(statusPath).sort()) }];
      const after = await validateStoryJob(job, input.validatorSource ?? input.skillsSource, { ...job, baseSha: current });
      if (manifest && after.status === "rejected") {
        // A newly authored Character with invalid metadata is absent from
        // the native catalog. Its exact controller-required Arc link then
        // reports a derived broken reference. Authenticate the link-only
        // change before classifying this as a scoped metadata correction.
        const derivedReferences: { path: string; target: string }[] = [];
        const diagnostics = (after.report as { diagnostics?: { code?: string; path?: string }[] } | undefined)?.diagnostics;
        if (create && create.id === input.target && create.id.startsWith("character.") &&
            diagnostics?.some(d => d.path === create.path && ["schema", "yaml", "frontmatter"].includes(d.code ?? ""))) {
          for (const arc of reviewArcs) {
            auditArcLink(git(job, "show", "HEAD:" + repoPath(job, arc)),
              await readFile(join(job.worktreeStoryRoot, arc), "utf8"), create.id);
            derivedReferences.push({ path: arc, target: create.id });
          }
        }
        return nativeMetadataDefects(after, { jobId: job.jobId, baseSha: current,
          worktreeStoryRoot: job.worktreeStoryRoot, validatorVersion: job.validatorVersion, paths, derivedReferences });
      }
      const accepted = reportOf(after, current);
      if (create && !accepted.some(item => item.metadata.id === create.id &&
          item.metadata.type === create.id.split(".")[0] && item.path === create.path &&
          item.metadata.status !== "superseded"))
        throw new Error("Native canonical validation did not recognize the exact new focused record.");
      if (reviewArcs.length) {
        for (const arc of reviewArcs) {
          const originalArc = git(job, "show", "HEAD:" + repoPath(job, arc));
          const revisedArc = await readFile(join(job.worktreeStoryRoot, arc), "utf8");
          auditArcLink(originalArc, revisedArc, input.target);
          const canonicalArc = accepted.find(r => r.path === arc && r.metadata.type === "arc");
          if (!canonicalArc || !Array.isArray(canonicalArc.metadata.characters) ||
              !canonicalArc.metadata.characters.includes(input.target))
            throw Error("Native catalog does not verify the Character's exact Arc link.");
        }
      } else resolveFocusedScope(accepted, effectiveContract);
      return [];
    };
    let missing: DependencyReport | undefined;
    {
      const output = await writeWithPi(job, receipt, input.task, turnAssignment?.outcome,
        turnPlan?.creativePolicy ?? DEFAULT_CREATIVE_POLICY, create, turnPlan?.objective?.obligations,
        input.steering, answered,
        reviewArcs.length ? { paths: reviewArcs, characterId: input.target } : undefined,
        !!reviewCreate && !reviewArcs.length, dependencyResume, input.round?.command, verifyDraft);
      if (output && "round" in output) return { status: "writer-round", round: output.round };
      if (output && "authorQuestion" in output) {
        if (answered) await completeSpecialistChoice(job, receipt.authorChoiceId!);
        receipt.piSessionFile = output.sessionFile;
        receipt.piSessionId = output.sessionId;
        receipt.choiceWorkItem = focusedChoiceWorkItem(receipt.target, receipt.workItemId);
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
      const transcript = await readFile(receipt.piSessionFile!);
      receipt.dependencySuspension = { reportDigest: dependencyDigest(missing),
        sessionFile: receipt.piSessionFile!,
        sessionId: receipt.piSessionId!,
        transcriptBytes: transcript.length,
        ...(receipt.invocationProof ? { invocationProof: receipt.invocationProof,
          invocationPrefix: receipt.invocationPrefix } : {}),
        transcriptSha256: createHash("sha256").update(transcript).digest("hex") };
      receipt.dependencyReport = missing; receipt.phase = "waiting-dependency";
      await save(file, receipt);
      if (answered) await completeSpecialistChoice(job, receipt.authorChoiceId!);
      return { status: "dependency-required" };
    }
    await verifyDraft();
    if (input.round) {
      if (!receipt.invocationProof) throw new ProtocolIntegrityBlockedError("Focused draft lacks its settled writer proof.");
      await verifySettledAssignment({ ...focusedInvocationOptions(job, receipt), proof: receipt.invocationProof,
        effect: await assignmentDraftEffect(job, current) });
    }
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
    if (answered) await completeSpecialistChoice(job, receipt.authorChoiceId!);
    // Supporting commits retain their own source-bound native/work/review receipts.
    await publishFocusedHead(job, receipt);
    return { status: "focused-committed", headSha: receipt.commitSha, paths };
  });
}

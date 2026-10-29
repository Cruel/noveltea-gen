import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { trustedHead } from "./revision.js";
import { validateStoryJob } from "./validator.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { createProjectResourceLoader } from "./pi.js";
import { preparePiContext } from "./job-pi-policy.js";
import { openStoryProject } from "./project.js";
import { parseSpecialistJson } from "./composition-specialist.js";
import { processAuthorUpdatesAtBoundary } from "./author-updates.js";
import { readSignedAuthorEvidence, verifyAuthorEvidence,
  type SignedAuthorEvidence } from "./author-evidence.js";
import { git, gitRaw, repoPath, pathFor, persist, assertClean, publishHead,
  records, assess, load, type PersistedIdea, type RecordInfo, type IdeaPlacementHistory } from "./ideas.js";

type Candidate = { id: string; path: string; kind: string; rationale: string };
interface PlacementReceipt {
  version: 1; jobId: string; ideaId: string; revision: number;
  priorHead: string; commitSha: string; entry: IdeaPlacementHistory;
  changed: string[]; digest: string;
  approval?: SignedAuthorEvidence;
  proposal?: string;
  proposedTarget?: string;
}
export interface PlacementOptions {
  story: string; job: string;
  action: "plan" | "place" | "audit" | "reassess" | "relocate" | "reverse";
  id?: string; target?: string; fixture?: boolean; skillsSource?: string;
  validatorSource?: string; provider?: string; model?: string; thinking?: "low" | "high";
  signedEvidence?: string; record?: boolean;
  /** Parent-only: a private, read-only semantic comparison chooses among eligible targets. */
  autoSelect?: boolean;
}
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const entryFile = (job: JobStartResult, id: string, revision: number) =>
  join(dirname(job.worktreeRoot), "idea-placements", id + "-" + revision + ".json");
const changes = (job: JobStartResult) => gitRaw(job, "status", "--porcelain=v1", "-z",
  "--untracked-files=all").split("\0").filter(Boolean).map(s => s.slice(3));
const tree = (job: JobStartResult, path: string, at = "HEAD") =>
  gitRaw(job, "show", at + ":" + repoPath(job, path));
const realizationDigest = (job: JobStartResult, paths: string[], at = "HEAD") =>
  sha(paths.map(path => sha(tree(job, path, at))).join("|"));
const confirmed = (idea: PersistedIdea) => idea.lifecycle.placements.filter(p =>
  p.action === "integrated" || p.action === "relocated" || p.action === "reassessed").at(-1);

/** Every mutable lifecycle transition is Git- and receipt-backed. This is
 * deliberately separate from the immutable, previously captured author input. */
export async function verifyPlacementHistory(job: JobStartResult, idea: PersistedIdea, captureHead: string) {
  const path = pathFor(idea.id);
  const capture = JSON.parse(tree(job, path, captureHead).toString()) as PersistedIdea;
  if (capture.lifecycle.status !== "dormant" || capture.lifecycle.placements.length !== 0 ||
      idea.lifecycle.capturedAt !== capture.lifecycle.capturedAt) throw new Error("Idea capture lifecycle was modified.");
  const steps = idea.lifecycle.placements;
  if (steps.length === 0) {
    if (idea.lifecycle.status !== "dormant" || idea.lifecycle.activatedAt !== null ||
        idea.lifecycle.placedAt !== null || sha(tree(job, path)) !== sha(tree(job, path, captureHead)))
      throw new Error("Dormant inbox bytes differ from the verified capture.");
    return;
  }
  let last = captureHead;
  for (const [index, entry] of steps.entries()) {
    const revision = index + 1;
    const file = entryFile(job, idea.id, revision);
    if (!existsSync(file)) throw new Error("Idea placement has no durable historical receipt.");
    const receipt = JSON.parse(await readFile(file, "utf8")) as PlacementReceipt;
    if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.ideaId !== idea.id ||
        receipt.revision !== revision || entry.revision !== revision ||
        JSON.stringify(receipt.entry) !== JSON.stringify(entry) ||
        receipt.priorHead !== entry.priorHead ||
        !/^[a-f0-9]{40,64}$/.test(receipt.commitSha) ||
        !/^[a-f0-9]{64}$/.test(receipt.digest)) {
      throw new Error("Idea placement provenance/receipt mismatch.");
    }
    if (git(job, "rev-parse", receipt.commitSha + "^") !== receipt.priorHead ||
        git(job, "merge-base", "--is-ancestor", last, receipt.priorHead) !== "" ||
        git(job, "merge-base", "--is-ancestor", receipt.commitSha, "HEAD") !== "") {
      throw new Error("Idea placement revision lost its verified ancestry.");
    }
    const before = JSON.parse(tree(job, path, receipt.priorHead).toString()) as PersistedIdea;
    const after = JSON.parse(tree(job, path, receipt.commitSha).toString()) as PersistedIdea;
    const { lifecycle: _before, ...beforeAuthor } = before;
    const { lifecycle: _after, ...afterAuthor } = after;
    const { lifecycle: _capture, ...capturedAuthor } = capture;
    if (before.lifecycle.placements.length !== index ||
        after.lifecycle.placements.length !== revision ||
        JSON.stringify(before.lifecycle.placements) !== JSON.stringify(steps.slice(0, index)) ||
        JSON.stringify(after.lifecycle.placements) !== JSON.stringify(steps.slice(0, revision)) ||
        JSON.stringify(beforeAuthor) !== JSON.stringify(capturedAuthor) ||
        JSON.stringify(afterAuthor) !== JSON.stringify(capturedAuthor) ||
        after.lifecycle.capturedAt !== capture.lifecycle.capturedAt ||
        !after.lifecycle.activatedAt || !after.lifecycle.placedAt ||
        after.lifecycle.status !== "integrated") {
      throw new Error("Idea placement rewrote original author intent or history.");
    }
    const paths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", receipt.commitSha)
      .split("\n").filter(Boolean).sort();
    if (JSON.stringify(paths) !== JSON.stringify([path, ...receipt.changed].map(p => repoPath(job, p)).sort()) ||
        receipt.changed.some(p => !/^(events|milestones|authored-content)\/[a-z0-9-]+\.md$/.test(p)) ||
        receipt.digest !== sha(JSON.stringify({ entry, changed: receipt.changed,
          blobs: [path, ...receipt.changed].map(p => sha(tree(job, p, receipt.commitSha))) })) ||
        !["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-placement",
          "NovelTea-Idea: " + idea.id, "NovelTea-Idea-Revision: " + revision,
          "NovelTea-Idea-Digest: " + receipt.digest].every(line =>
          git(job, "log", "-1", "--format=%B", receipt.commitSha).split("\n").includes(line))) {
      throw new Error("Idea placement commit paths, blobs or trailers differ from receipt.");
    }
    if (entry.action === "relocated") {
      if (!receipt.approval || !receipt.proposal || !receipt.proposedTarget ||
          entry.recordIds.length !== 1 || entry.recordIds[0] !== receipt.proposedTarget)
        throw new Error("Relocation lacks original signed author approval provenance.");
      const signed = verifyAuthorEvidence(job, receipt.approval).payload;
      if (signed.kind !== "decision" || signed.action !== "approved" ||
          signed.workItemId !== "idea-relocate:" + idea.id ||
          signed.verifiedHead !== receipt.priorHead || signed.changeId !== receipt.proposal ||
          signed.proposalSha256 !== receipt.proposal)
        throw new Error("Historical relocation authorization no longer matches its approved proposal.");
    }
    last = receipt.commitSha;
  }
  const finalDoc = JSON.parse(tree(job, path).toString()) as PersistedIdea;
  if (JSON.stringify(finalDoc) !== JSON.stringify(idea) ||
      idea.lifecycle.activatedAt === null || !idea.lifecycle.placedAt ||
      idea.lifecycle.status !== "integrated") {
    throw new Error("Current idea lifecycle does not match verified placement history.");
  }
}

/** Candidate list is never chosen by first match. Two or more plausible
 * contexts remain explicit alternatives until reviewed and selected. */
export async function verifyPlacementSuccessor(job: JobStartResult, commit: string,
  parent: string, paths: string[], trailers: string[]) {
  const ideaLine = trailers.find(line => line.startsWith("NovelTea-Idea: "));
  const revisionLine = trailers.find(line => line.startsWith("NovelTea-Idea-Revision: "));
  const id = ideaLine?.slice("NovelTea-Idea: ".length);
  const revision = Number(revisionLine?.slice("NovelTea-Idea-Revision: ".length));
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Intervening idea placement lacks a typed historical identity.");
  const ideas = await load(job);
  const idea = ideas.find(i => i.id === id);
  const receiptPath = entryFile(job, id, revision);
  if (!idea || !existsSync(receiptPath)) throw new Error("Intervening placement lacks its committed inbox/receipt.");
  const saved = JSON.parse(await readFile(receiptPath, "utf8")) as PlacementReceipt;
  if (saved.commitSha !== commit || saved.priorHead !== parent ||
      JSON.stringify([...saved.changed.map(p => repoPath(job, p)), repoPath(job, pathFor(id))].sort()) !==
      JSON.stringify([...paths].sort()))
    throw new Error("Intervening idea placement differs from historical receipt paths.");
  // load(job) separately verifies immutable input and complete historical
  // revision chain, exact Git blobs, receipts and trailers through this commit.
}

export function candidatesFor(idea: PersistedIdea, catalog: Map<string, RecordInfo>): Candidate[] {
  const scopedArcs = new Set(idea.placement.scopeIds.filter(x => x.startsWith("arc.")));
  for (const scoped of idea.placement.scopeIds) {
    const parent = catalog.get(scoped);
    if (parent?.type === "milestone") parent.arcs.forEach(a => scopedArcs.add(a));
  }
  const relevant = (r: RecordInfo) => idea.placement.scopeIds.includes(r.id) ||
    r.arcs.some(a => scopedArcs.has(a));
  const eligible = [...catalog.values()].filter(r => r.completeness !== "partial" && relevant(r));
  const eventSet = new Set(eligible.filter(r => r.type === "event").map(r => r.id));
  const options = [...catalog.values()].filter(r => {
    if (r.completeness === "partial") return false;
    if (idea.kind === "conversation" || idea.kind === "exact-dialogue") {
      return r.type === "authored-content" && r.events.some(e => eventSet.has(e));
    }
    return r.type === (idea.placement.earliest === "event" ? "event" : "milestone") && relevant(r);
  });
  return options.map(r => ({
    id: r.id, path: r.path, kind: r.type,
    rationale: r.type === "authored-content"
      ? "Existing player-facing text for eligible Event " + r.events.filter(e => eventSet.has(e)).join(", ")
      : "Developed " + r.type + " belonging to the declared Arc/Milestone scope",
  })).sort((a, b) => a.id.localeCompare(b.id));
}
function schedule(job: JobStartResult, ideas: PersistedIdea[], catalog: Map<string, RecordInfo>) {
  return ideas.map(idea => {
    const eligibility = assess(idea, catalog);
    const candidates = eligibility.eligible ? candidatesFor(idea, catalog) : [];
    const current = confirmed(idea);
    const signature = sha(JSON.stringify({ status: idea.lifecycle.status,
      candidates: candidates.map(c => c.id), current: current?.recordIds,
      digest: current?.recordIds.map(id => catalog.get(id)?.path)
        .filter((p): p is string => !!p).map(p => sha(tree(job, p))),
      reviewed: current?.verified }));
    return {
      id: idea.id, scopeIds: idea.placement.scopeIds, signature,
      status: idea.lifecycle.status, eligible: eligibility.eligible,
      reasons: eligibility.reasons, breadth: eligibility.breadth, candidates,
      currentRealizations: current?.recordIds ?? [],
      reviewRequired: Boolean(current) && (current!.verified !== "pi" ||
        current!.recordIds.some(id => !catalog.has(id)) ||
        realizationDigest(job, current!.recordIds.map(id => catalog.get(id)?.path ?? "")) !==
          current!.realizationDigest ||
        candidates.some(c => !current!.alternatives.some(a => a.recordId === c.id))),
      deferredReason: !eligibility.eligible ? eligibility.reasons.join(", ")
        : !candidates.length ? "No suitable developed canonical target; preserve deferred idea"
        : undefined,
    };
  });
}

/** Called only at an existing locked structural work boundary. Retains an
 * inspectable noncanonical queue, but never injects author input into the
 * ordinary writer's assignment or starts another simultaneous writer. */
export async function scheduleIdeasAtBoundary(job: JobStartResult, boundary: string) {
  const ideas = await load(job);
  if (!ideas.length) return { tasks: [] as ReturnType<typeof schedule>, pending: 0, blocked: 0 };
  const current = await trustedHead(job);
  const file = join(dirname(job.worktreeRoot), "idea-placement-tasks.json");
  const earlier = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) as {
    version: number; jobId: string;
    history: Array<{ head: string; boundary: string; tasks: ReturnType<typeof schedule> }>;
  } : { version: 1, jobId: job.jobId,
    history: [] as Array<{ head: string; boundary: string; tasks: ReturnType<typeof schedule> }> };
  if (earlier.version !== 1 || earlier.jobId !== job.jobId || !Array.isArray(earlier.history))
    throw new Error("Idea placement schedule receipt has invalid provenance.");
  const tasks = schedule(job, ideas, records(job));
  if (earlier.history.at(-1)?.head !== current) {
    earlier.history.push({ head: current, boundary, tasks });
    await persist(file, earlier);
  }
  return { tasks, pending: tasks.filter(t => t.eligible && t.status === "dormant" && t.candidates.length).length,
    blocked: tasks.filter(t => t.reviewRequired).length };
}

function specialistSkill(kind: string) {
  return kind === "authored-content" ? "nt-narrative-composition"
    : kind === "event" ? "nt-event-design" : "nt-story-architecture";
}
async function piWork(job: JobStartResult, snapshot: SkillSnapshot, skill: string,
  instruction: string, provider: string, modelId: string,
  thinking: "low" | "high" | undefined, writable: boolean, insideWriter = false,
  selecting = false) {
  if (await openSkillSnapshot(snapshot.id) !== snapshot.path) throw new Error("Pinned placement skills changed.");
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [], requiredSkills: [skill, "nt-catalog"],
  });
  await loader.reload();
  const loaded = loader.getSkills();
  if (loaded.diagnostics.some(d => d.type === "error") ||
      ![skill, "nt-catalog"].every(name => loaded.skills.some(s =>
        s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw new Error("Idea placement cannot load pinned specialist skills.");
  const assignment = JSON.parse(instruction.slice(instruction.indexOf("{") >= 0 ?
    instruction.indexOf("{") : 0)) as { target?: { path?: string };
    relocationFrom?: { path: string }; alternatives?: Array<{ path: string }> };
  const required = [assignment.target?.path, assignment.relocationFrom?.path,
    ...(assignment.alternatives?.map(c => c.path) ?? [])]
    .filter((p): p is string => !!p).map(p => join(project.root, p));
  // An idea's original author intent is private. Never share its transcript with
  // another idea, even if the same specialist and target are selected.
  const identity = createHash("sha256").update(instruction).digest("hex");
  const runtime = await ModelRuntime.create();
  const dir = join(dirname(job.worktreeRoot), "idea-placement-sessions", skill, writable ? "write" : "review");
  const context = await preparePiContext(job, project, {
    group: "idea:" + identity + ":" + (writable ? "write" : "review"),
    step: "idea:" + identity + ":" + (writable ? "write" : "review"),
    paths: required, snapshot: snapshot.id, provider, model: modelId, thinking, directory: dir, insideWriter,
  }, runtime);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking,
    resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    noTools: "all", tools: writable ? ["read", "edit", "write"] : ["read"],
  });
  try {
    const pinned = [join(snapshot.path, "skills", skill, "SKILL.md"),
      ...["SKILL.md", "references/records.md", "references/progression.md",
        "references/authority-and-validation.md", "references/glossary.md"]
        .map(p => join(snapshot.path, "skills", "nt-catalog", p))];
    const mustRead = [...new Set([...pinned, ...required])];
    await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
    await promptStorySpecialist(session, context.contextNote + "Read ALL pinned skill/catalog files with the read tool, " +
      "then read EVERY canonical candidate record in the assignment, even if you already like " +
      "the target. This task is NOT complete until each individual alternative has actually " +
      "been read; the graph verifies successful read calls for every path. " +
      "READ ALL EXACT FILE PATHS FIRST:\n" + mustRead.join("\n") + "\n" + (writable ?
        "Edit ONLY the allowed target/previous canonical Markdown files stated in the assignment using the existing craft skill. " +
        "Do not alter frontmatter IDs, protected requirements, other records or the .story-inbox. " :
        "Read-only independent semantic assessment. Never edit files. ") +
      "Respond with ONE unfenced JSON object: " + (selecting
        ? '{"verdict":"pass|block","target":"one candidate ID or null","evidence":["path.md:line"],"reason":"..."}'
        : '{"verdict":"pass|block","evidence":["path.md:line"],"reason":"..."}') +
      (selecting
        ? ". This is a PROSPECTIVE PLACEMENT decision, not proof of fulfillment. Compare the original author intent, binding requirements and causal/branch context at ALL developed candidate locations. Choose a target only if the idea could be integrated coherently without a protected-decision change; otherwise block with null target. Cite actual candidate lines as suitability evidence."
        : ". Evidence must compare the ORIGINAL author intent and every binding requirement against actual player-facing lines when applicable. Do NOT equate a canonical reference or typed ID alone with semantic fulfillment.") +
      "\nPINNED:\n" + pinned.join("\n") +
      "\nASSIGNMENT:\n" + instruction);
    const latest = () => {
      const reply = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!reply || reply.role !== "assistant" || ["error", "aborted"].includes(reply.stopReason))
        throw new Error("Idea Pi specialist stopped without a valid response.");
      return parseSpecialistJson(reply.content.filter(c => c.type === "text")
        .map(c => c.text).join("\n"));
    };
    const completedReads = () => {
      const done = new Set(session.messages.filter(m => m.role === "toolResult" && !m.isError)
        .map(m => m.role === "toolResult" ? m.toolCallId : ""));
      return new Set(session.messages.flatMap(m => m.role === "assistant" ? m.content
        .filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
          c.type === "toolCall" && done.has(c.id) && c.name === "read")
        .map(c => typeof c.arguments?.path === "string" ? resolve(project.root, c.arguments.path) : "") : []));
    };
    let response = latest();
    for (let retry = 0; retry < 2; retry++) {
      const missing = mustRead.filter(p => !completedReads().has(p));
      if (!missing.length) break;
      await promptStorySpecialist(session, "Your earlier response omitted required source inspection. " +
        "READ each of the following exact files using the read tool NOW, then compare the " +
        "candidate locations and reassess whether your integration/fulfillment is sound. " +
        "Correct the permitted canonical target if necessary (writer only). " +
        "Return ONE unfenced JSON verdict/evidence/reason object.\nMISSING:\n" +
        missing.join("\n"));
      response = latest();
    }
    if (mustRead.some(p => !completedReads().has(p)) ||
        (!selecting || response.verdict !== "block") && response.verdict !== "pass" ||
        !Array.isArray(response.evidence) ||
        (response.verdict === "pass" && !response.evidence.some((e: unknown) => typeof e === "string" &&
          /(?:events|milestones|authored-content)\/[a-z0-9-]+\.md:[1-9][0-9]*/.test(e))) ||
        (selecting && (response.verdict === "pass"
          ? !assignment.alternatives?.some(c => (c as { id?: string }).id === response.target)
          : response.target != null))) {
      throw new Error("Idea specialist did not provide a passing source-linked semantic verdict: " +
        JSON.stringify(response));
    }
    await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
    return { evidence: response.evidence as string[], reason: String(response.reason ?? ""),
      target: selecting && response.verdict === "pass" ? String(response.target) : null,
      sessionFile: session.sessionManager.getSessionFile() ?? "" };
  } finally { session.dispose(); }
}
async function verifyDraft(job: JobStartResult, source: string | undefined, prior: string,
  touched: string[]) {
  const validation = await validateStoryJob(job, source, { ...job, baseSha: prior });
  const report = validation.report as { protection?: { status: string; changes: unknown[]; warnings: unknown[] };
    diagnostics?: Array<{ path?: string; code: string; message: string }> } | undefined;
  if (!report || report.protection?.status !== "checked" ||
      (report.protection?.changes?.length ?? 0) > 0 ||
      (report.protection?.warnings?.length ?? 0) > 0) {
    throw new Error("Idea placement failed canonical protected-authority validation.");
  }
  const relevant = (report.diagnostics ?? []).filter(d => d.path && touched.includes(d.path));
  if (relevant.length) throw new Error("Idea placement introduces scoped catalog diagnostics: " +
    JSON.stringify(relevant));
  return validation;
}
/** Read-only complete-inbox audit, safe to call while the Story job lock is
 * already held by the final narrative reviewer. Does not disclose original prose. */
export async function auditIdeasUnderJobLock(job: JobStartResult) {
  const list = await load(job);
  const catalog = records(job);
  const reviewed = list.map(idea => {
    const latest = confirmed(idea);
    const links = latest?.recordIds.map(id => catalog.get(id)?.path);
    const stale = !!latest && (links?.some(path => !path) ||
      realizationDigest(job, links as string[]) !== latest.realizationDigest ||
      candidatesFor(idea, catalog).some(c =>
        !latest.alternatives.some(a => a.recordId === c.id)));
    return { id: idea.id, status: idea.lifecycle.status,
      currentRealizations: latest?.recordIds ?? [], stale,
      verdict: !latest ? "deferred" : stale ? "stale" :
        latest.verified === "pi" ? "previously-reviewed" : "editorial-unverified",
      binding: [...idea.requirements.meaning, ...idea.requirements.wording,
        ...idea.requirements.participants].some(r => r.binding),
      scopeIds: idea.placement.scopeIds };
  });
  return { status: "ready" as const, audience: "author-only" as const, reviewed,
    outstanding: reviewed.filter(r => r.binding && r.verdict !== "previously-reviewed")
      .map(r => r.id) };
}

export async function runIdeaPlacement(input: PlacementOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  return withStoryJobLock(job, "idea-placement", async () => {
    if (input.action === "place" || input.action === "relocate" ||
        input.action === "reassess" && input.record)
      await processAuthorUpdatesAtBoundary(job);
    const list = await load(job);
    const catalog = records(job);
    if (input.action === "reverse") {
      return { status: "ready", audience: "author-only", records: [...catalog.keys()].map(id => ({
        id, ideaIds: list.filter(idea => confirmed(idea)?.recordIds.includes(id)).map(idea => idea.id),
      })).filter(r => r.ideaIds.length) };
    }
    if (input.action === "plan")
      return { status: "ready", audience: "scheduler-only", tasks: schedule(job, list, catalog) };
    if (input.action === "audit") return auditIdeasUnderJobLock(job);
    if (!input.id || !/^[a-z][a-z0-9-]*$/.test(input.id))
      throw new Error("Idea action requires --id stable idea ID.");
    const idea = list.find(x => x.id === input.id);
    if (!idea) throw new Error("Unknown committed idea.");
    const eligibility = assess(idea, catalog);
    const alternatives = candidatesFor(idea, catalog);
    const prior = await trustedHead(job);
    const current = confirmed(idea);
    if (input.action === "reassess") {
      if (!current) return { status: "deferred", reason: "Idea has no realization yet", alternatives };
      if (!eligibility.eligible) return { status: "deferred", reasons: eligibility.reasons, alternatives };
      if (input.record) {
        assertClean(job);
        const locations = current.recordIds.map(id => catalog.get(id));
        if (locations.some(r => !r))
          return { status: "blocked", reason: "Original placement no longer resolves to canonical records" };
        const paths = locations.map(r => r!.path);
        const currentDigest = realizationDigest(job, paths);
        for (const requirement of idea.requirements.wording.filter(r => r.binding)) {
          if (!paths.some(path => tree(job, path).toString().includes(requirement.text)))
            return { status: "blocked", reason: "Protected dialogue is absent from current realization" };
        }
        await verifyDraft(job, input.validatorSource ?? input.skillsSource, prior, paths);
        const snapshot = input.fixture ? undefined : await createSkillSnapshot({
          discovery: "explicit-only", novelteaSkills: input.skillsSource,
          skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"],
        });
        if (!input.fixture && !snapshot) throw new Error("Reassessment requires pinned review skills.");
        const assignment = JSON.stringify({ original: idea.original, requirements: idea.requirements,
          identities: idea.identities, originalRealizations: current.recordIds,
          target: { id: current.recordIds[0], path: paths[0] },
          alternatives, scopeIds: idea.placement.scopeIds }, null, 2);
        let evidence: string[];
        let reason: string;
        let reviewSession = "";
        if (input.fixture) {
          evidence = paths.map(p => p + ":1");
          reason = "Fixture only; independent editorial reassessment not performed";
        } else {
          const editorial = await piWork(job, snapshot!, "nt-narrative-review", assignment,
            input.provider ?? "openai", input.model ?? "gpt-6-luna", input.thinking, false);
          evidence = editorial.evidence;
          reason = editorial.reason;
          reviewSession = editorial.sessionFile;
        }
        const entry: IdeaPlacementHistory = {
          revision: idea.lifecycle.placements.length + 1, action: "reassessed", priorHead: prior,
          recordIds: [...current.recordIds], rationale: reason || "Retained after full candidate comparison",
          alternatives: alternatives.map(c => ({ recordId: c.id, rationale: c.rationale })),
          verified: input.fixture ? "fixture-unverified" : "pi", evidence,
          sessionFiles: reviewSession ? [reviewSession] : [],
          realizationDigest: currentDigest,
        };
        const path = pathFor(idea.id);
        const updated: PersistedIdea = { ...idea, lifecycle: { ...idea.lifecycle,
          placements: [...idea.lifecycle.placements, entry] } };
        const bytes = JSON.stringify(updated, null, 2) + "\n";
        await writeFile(join(job.worktreeStoryRoot, path), bytes);
        const digest = sha(JSON.stringify({ entry, changed: [], blobs: [sha(bytes)] }));
        const receiptPath = entryFile(job, idea.id, entry.revision);
        const data = { version: 1 as const, jobId: job.jobId, ideaId: idea.id,
          revision: entry.revision, priorHead: prior, entry, changed: [], digest };
        await persist(receiptPath, { ...data, commitSha: "pending" });
        git(job, "add", "--", repoPath(job, path));
        git(job, "-c", "user.name=NovelTea Generator",
          "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m",
          ["Reassess deferred author idea [" + idea.id + "]", "",
            "NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-placement",
            "NovelTea-Idea: " + idea.id, "NovelTea-Idea-Revision: " + entry.revision,
            "NovelTea-Idea-Digest: " + digest].join("\n"));
        const commit = git(job, "rev-parse", "HEAD");
        await persist(receiptPath, { ...data, commitSha: commit });
        await publishHead(job, prior, commit, idea.id, "idea-placement:" + idea.id);
        assertClean(job);
        return { status: input.fixture ? "reassessed-editorial-unverified" : "reassessed",
          id: idea.id, current: current.recordIds, alternatives: entry.alternatives,
          rationale: entry.rationale, commitSha: commit };
      }
      const priorTargets = current.recordIds;
      const proposals = alternatives.filter(c => !priorTargets.includes(c.id));
      return { status: proposals.length ? "relocation-review-required" : "placement-retained",
        current: priorTargets, proposals, impact: {
          currentPaths: priorTargets.map(id => catalog.get(id)?.path),
          proposedPaths: proposals.map(c => c.path),
          requiresSignedAuthorApproval: true,
          affectedAuthorRequirements: idea.requirements,
          wouldInvalidatePriorEditorialEvidence: true,
        }, history: idea.lifecycle.placements };
    }
    if (input.action !== "place" && input.action !== "relocate")
      throw new Error("Unsupported idea placement action.");
    if (!eligibility.eligible) return { status: "deferred", reasons: eligibility.reasons };
    let target = input.target;
    let selection: { evidence: string[]; reason: string; sessionFile: string } | undefined;
    if (!target && input.autoSelect && input.action === "place") {
      if (!alternatives.length) return { status: "deferred", reason: "No developed placement candidates" };
      if (input.fixture) {
        if (process.env.NT_IDEA_FIXTURE_REJECT === idea.id)
          return { status: "deferred", reason: "Fixture rejected every current placement candidate" };
        // A deterministic fixture exercises the orchestration and Git gates,
        // NOT semantic selection. Prefer the most developed kind, with a stable tie-break.
        const specificity = (kind: string) => kind === "authored-content" ? 3 : kind === "event" ? 2 : 1;
        target = [...alternatives].sort((a, b) => specificity(b.kind) - specificity(a.kind) ||
          b.id.localeCompare(a.id))[0]!.id;
      } else {
        const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
          novelteaSkills: input.skillsSource, skillDirs: [],
          requiredSkills: ["nt-narrative-review", "nt-catalog"] });
        if (!snapshot) throw new Error("Automatic idea selection requires pinned review skills.");
        const assignment = JSON.stringify({ original: idea.original, requirements: idea.requirements,
          identities: idea.identities, prerequisites: idea.prerequisites,
          alternatives, scopeIds: idea.placement.scopeIds,
          instruction: "Compare ALL candidates and choose one reasonable semantic location, or block with null target if none fits. Do not edit." }, null, 2);
        const decision = await piWork(job, snapshot, "nt-narrative-review", assignment,
          input.provider ?? "openai", input.model ?? "gpt-6-luna", input.thinking,
          false, false, true);
        if (!decision.target) return { status: "deferred", reason: decision.reason,
          alternatives: alternatives.map(a => ({ recordId: a.id, rationale: a.rationale })) };
        target = decision.target;
        selection = decision;
      }
    }
    const candidate = alternatives.find(c => c.id === target);
    if (!candidate) throw new Error("Choose one of the eligible candidate record IDs; compare ideas plan first.");
    if (input.action === "place" && current) throw new Error("Already integrated; use reassess/relocate.");
    if (input.action === "relocate" && !current) throw new Error("Relocation requires a previously integrated idea.");
    if (current && current.recordIds.includes(candidate.id))
      throw new Error("Relocation target is already current.");
    const proposal = sha(JSON.stringify({ ideaId: idea.id, current: current?.recordIds,
      target: candidate.id, prior, alternatives }));
    let approval: SignedAuthorEvidence | undefined;
    if (input.action === "relocate") {
      if (!input.signedEvidence) return { status: "approval-required", proposal, alternatives,
        impact: { priorRecords: current?.recordIds, target: candidate.id, canonicalPaths: [
          ...(current?.recordIds.map(id => catalog.get(id)?.path) ?? []), candidate.path] } };
      const signed = await readSignedAuthorEvidence(job, input.signedEvidence);
      const p = signed.payload;
      if (p.kind !== "decision" || p.action !== "approved" ||
          p.workItemId !== "idea-relocate:" + idea.id || p.verifiedHead !== prior ||
          p.proposalSha256 !== proposal || p.changeId !== proposal)
        throw new Error("Relocation requires exact signed author approval for its current impact proposal.");
      approval = signed;
      // The signed exact impact proposal permits one bounded two-record
      // specialist revision; it never authorizes unrelated Story rewrites.
    }
    assertClean(job);
    const snapshot = input.fixture ? undefined : await createSkillSnapshot({
      discovery: "explicit-only", novelteaSkills: input.skillsSource,
      skillDirs: [], requiredSkills: [specialistSkill(candidate.kind), "nt-narrative-review", "nt-catalog"],
    });
    if (!input.fixture && !snapshot) throw new Error("Real idea placement requires pinned NovelTea craft skills.");
    const file = join(job.worktreeStoryRoot, candidate.path);
    if (!(await lstat(file)).isFile() || await realpath(file) !== file)
      throw new Error("Idea realization must target regular existing canonical Markdown.");
    const before = await readFile(file, "utf8");
    const oldRecord = input.action === "relocate" ? catalog.get(current!.recordIds[0]!) : undefined;
    if (input.action === "relocate" &&
        (!oldRecord || current!.recordIds.length !== 1 || oldRecord.path === candidate.path ||
         !["event", "milestone", "authored-content"].includes(oldRecord.type)))
      throw new Error("Relocation requires a single existing realized canonical source.");
    const previousFile = oldRecord ? join(job.worktreeStoryRoot, oldRecord.path) : undefined;
    if (previousFile && (!(await lstat(previousFile)).isFile() || await realpath(previousFile) !== previousFile))
      throw new Error("Relocation source must be a regular canonical Markdown file.");
    const previousText = previousFile ? await readFile(previousFile, "utf8") : "";
    const all = alternatives.map(c => ({ id: c.id, path: c.path, rationale: c.rationale }));
    const assignment = JSON.stringify({ original: idea.original, requirements: idea.requirements,
      identities: idea.identities, prerequisites: idea.prerequisites, target: candidate,
      relocationFrom: oldRecord ? { id: oldRecord.id, path: oldRecord.path } : null,
      requiredAction: oldRecord ? "Move realization without duplication; preserve source record identity" : "Integrate idea",
      allowedWrites: [candidate.path, ...(oldRecord ? [oldRecord.path] : [])],
      alternatives: all, scopeIds: idea.placement.scopeIds }, null, 2);
    let writerEvidence: string[] = [];
    let writerSession = "";
    if (input.fixture) {
      if (previousFile) {
        if (!previousText.includes(idea.original))
          throw new Error("Fixture cannot relocate prose absent as exact original text.");
        await writeFile(previousFile, previousText.replace(idea.original, "").trimEnd() + "\n");
      }
      await writeFile(file, before.trimEnd() + "\n\n" + idea.original + "\n");
      writerEvidence = [candidate.path + ":" + (before.split("\n").length + 2)];
    } else {
      const writer = await piWork(job, snapshot!, specialistSkill(candidate.kind),
        assignment, input.provider ?? "openai", input.model ?? "gpt-6-luna",
        input.thinking, true);
      writerEvidence = writer.evidence;
      writerSession = writer.sessionFile;
    }
    const touched = changes(job).sort();
    const edited = [candidate.path, ...(oldRecord ? [oldRecord.path] : [])].sort();
    if (JSON.stringify(touched) !== JSON.stringify(edited.map(p => repoPath(job, p)).sort()) ||
        (await readFile(file, "utf8")) === before ||
        (previousFile && (await readFile(previousFile, "utf8")) === previousText))
      throw new Error("Idea specialist changed unauthorized paths or omitted a relocation edit.");
    // Exact protected wording is a byte-level condition; other meaning and
    // participants require the independent semantic assessment below.
    const actual = await readFile(file, "utf8");
    for (const requirement of idea.requirements.wording.filter(r => r.binding)) {
      if (!actual.includes(requirement.text))
        throw new Error("Idea realization omitted binding literal author dialogue.");
    }
    if (previousFile && idea.kind === "exact-dialogue") {
      const oldAfter = await readFile(previousFile, "utf8");
      if (idea.requirements.wording.some(r => r.binding && previousText.includes(r.text) &&
          oldAfter.includes(r.text)))
        throw new Error("Author's exact dialogue still appears at its superseded placement.");
    }
    await verifyDraft(job, input.validatorSource ?? input.skillsSource, prior, edited);
    let editorialEvidence: string[] = [];
    let reviewSession = "";
    if (!input.fixture) {
      const independent = await piWork(job, snapshot!, "nt-narrative-review",
        "INDEPENDENT FULFILLMENT REVIEW: Check every binding meaning, wording and participant " +
        "requirement against literal canonical prose, NOT merely an ID or reference. " +
        "Consider the alternatives and placement suitability. Report BLOCK if the idea is " +
        "only superficially linked.\n" + assignment, input.provider ?? "openai",
        input.model ?? "gpt-6-luna", input.thinking, false, true);
      editorialEvidence = independent.evidence;
      reviewSession = independent.sessionFile;
    }
    const afterHash = realizationDigest(job, [candidate.path]);
    // Realization digest uses the working draft; Git blobs are committed below.
    const workingDigest = sha([sha(await readFile(file))].join("|"));
    if (afterHash === workingDigest) throw new Error("Idea placement unexpectedly matched the old committed bytes.");
    const entry: IdeaPlacementHistory = {
      revision: idea.lifecycle.placements.length + 1,
      action: oldRecord ? "relocated" : "integrated", priorHead: prior,
      recordIds: [candidate.id], rationale: (oldRecord ? "Relocated from " + oldRecord.id + " to " :
        "Chosen ") + candidate.id + " after comparison of " +
        alternatives.length + " eligible contexts; " + candidate.rationale +
        (selection ? "; semantic selection: " + selection.reason :
          input.autoSelect && input.fixture ? "; fixture selection only, not semantic" : ""),
      alternatives: all.map(c => ({ recordId: c.id, rationale: c.rationale })),
      verified: input.fixture ? "fixture-unverified" : "pi",
      evidence: [...(selection?.evidence ?? []), ...writerEvidence, ...editorialEvidence],
      sessionFiles: [selection?.sessionFile, writerSession, reviewSession].filter((p): p is string => !!p),
      realizationDigest: workingDigest,
    };
    const revised: PersistedIdea = { ...idea, lifecycle: { ...idea.lifecycle,
      status: "integrated", activatedAt: idea.lifecycle.activatedAt ?? new Date().toISOString(),
      placedAt: new Date().toISOString(), placements: [...idea.lifecycle.placements, entry] } };
    const path = pathFor(idea.id), inboxFile = join(job.worktreeStoryRoot, path);
    const expected = [path, ...edited];
    await writeFile(inboxFile, JSON.stringify(revised, null, 2) + "\n");
    const blobs = await Promise.all(expected.map(async p =>
      sha(p === path ? JSON.stringify(revised, null, 2) + "\n" :
        p === candidate.path ? actual : await readFile(join(job.worktreeStoryRoot, p)))));
    const digest = sha(JSON.stringify({ entry, changed: edited, blobs }));
    const receiptPath = entryFile(job, idea.id, entry.revision);
    const receiptBase = { version: 1 as const, jobId: job.jobId, ideaId: idea.id,
      revision: entry.revision, priorHead: prior, entry, changed: edited, digest,
      ...(approval ? { approval, proposal, proposedTarget: candidate.id } : {}) };
    await persist(receiptPath, { ...receiptBase, commitSha: "pending" });
    git(job, "add", "--", ...expected.map(p => repoPath(job, p)));
    const message = [(oldRecord ? "Relocate" : "Integrate") + " deferred author idea [" + idea.id + "]", "",
      "NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-placement",
      "NovelTea-Idea: " + idea.id, "NovelTea-Idea-Revision: " + entry.revision,
      "NovelTea-Idea-Digest: " + digest].join("\n");
    git(job, "-c", "user.name=NovelTea Generator",
      "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m", message);
    const commit = git(job, "rev-parse", "HEAD");
    await persist(receiptPath, { ...receiptBase, commitSha: commit });
    await publishHead(job, prior, commit, idea.id, "idea-placement:" + idea.id);
    assertClean(job);
    return { status: input.fixture ? "integrated-editorial-unverified" : "integrated",
      id: idea.id, action: entry.action, realizationIds: entry.recordIds, alternatives: entry.alternatives,
      rationale: entry.rationale, verification: entry.verified, commitSha: commit };
  });
}

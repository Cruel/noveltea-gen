/** The Generation child uses the existing specialist question/answer receipt,
 * not a second author ledger. Only a pending nested interrupt can consume it. */
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, type StateSnapshot } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createAssignmentLifecycleGraph, logicalAssignmentKey,
  type AssignmentAdapter, type AssignmentIdentity, type AssignmentOutcome } from "./generation-assignment-lifecycle.js";
import { activeSpecialistChoice, bindSpecialistChoice, verifySpecialistChoice, inspectSpecialistChoice,
  SpecialistChoiceRequiredError, withSpecialistAnswerAuthority, type SpecialistChoiceReceipt } from "./specialist-choice.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectDependencyPlan, dependencyDigest } from "./dependency-state.js";
import { focusedChoiceWorkItem } from "./specialist-choice.js";
import { readJobControl } from "./job-control.js";
import { guardPiBudget, PiBudgetPause } from "./job-pi-policy.js";
import type { JobStartResult } from "./job.js";

type QuestionOutcome = Extract<AssignmentOutcome, { status: "awaiting-author" }>;
const ref = (choice: SpecialistChoiceReceipt) => choice.id + ":" + choice.proposalSha256;
const answerRef = (choice: SpecialistChoiceReceipt) => ({
  questionRef: ref(choice), assignmentKey: logicalAssignmentKey(choice.assignment!.identity),
  answerDigest: choice.answerSeal?.digest,
});
function childNamespace(config: RunnableConfig) {
  const ns = config.configurable?.checkpoint_ns;
  if (typeof ns !== "string" || !ns.includes("|")) throw Error("Question lacks a nested checkpoint namespace.");
  return ns.slice(0, ns.lastIndexOf("|"));
}
function assertNoWriter(job: JobStartResult) {
  if (existsSync(join(job.stateDir, ".story-job-running")))
    throw Error("Author interrupt cannot retain an active Story writer.");
}
export function createGenerationQuestionGraph(job: JobStartResult, identity: AssignmentIdentity,
  expectedWorkItem: string, adapter: AssignmentAdapter,
  authenticateSuccessor?: (head: string) => Promise<boolean>) {
  const key = logicalAssignmentKey(identity);
  const question = async (config: RunnableConfig): Promise<QuestionOutcome> => {
    assertNoWriter(job);
    const bound = await withStoryJobLock(job, "generation-question-binding", async () => {
      const pending = await activeSpecialistChoice(job);
      if (!pending || pending.workItem !== expectedWorkItem ||
          (pending.headSha !== identity.sourceHeadSha && !await authenticateSuccessor?.(pending.headSha)) ||
          pending.phase !== "awaiting-author")
        throw Error("Author question is not bound to the original specialist source.");
      return bindSpecialistChoice(job, pending.id, {
        identity, namespace: childNamespace(config), resumePhase: "writer",
      });
    });
    assertNoWriter(job);
    return { status: "awaiting-author", assignmentKey: key, questionRef: ref(bound),
      evidenceRef: bound.id, resumePhase: "writer" };
  };
  const wrap = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) =>
    async (...args: A): Promise<T | QuestionOutcome> => {
      try {
        const state = args[0] as Parameters<AssignmentAdapter["invoke"]>[0];
        const active = await activeSpecialistChoice(job);
        if (active?.workItem === expectedWorkItem && active.phase === "answered") {
          if (!active.assignment || !isDeepStrictEqual(active.assignment.identity, identity) ||
              !isDeepStrictEqual(state.authorAnswerRef, answerRef(active)))
            throw Error("No authenticated child gate for the submitted specialist answer.");
          return await withSpecialistAnswerAuthority(job, active, () => fn(...args));
        }
        return await fn(...args);
      }
      catch (error) {
        if (!(error instanceof SpecialistChoiceRequiredError)) throw error;
        return question(args[1] as RunnableConfig);
      }
    };
  return createAssignmentLifecycleGraph({
    ...adapter,
    invoke: wrap(adapter.invoke),
    ...(adapter.correct ? { correct: wrap(adapter.correct) } : {}),
    verify: wrap(adapter.verify),
    ...(adapter.reenterWriter ? { reenterWriter: wrap(adapter.reenterWriter) } : {}),
    authenticateAnswer: async (state, answer) => {
      assertNoWriter(job);
      if (await readJobControl(job) !== "running" ||
          state.outcome?.status !== "awaiting-author" ||
          logicalAssignmentKey(state.identity) !== key) return false;
      const choice = await activeSpecialistChoice(job);
      if (!choice || choice.phase !== "answered" || choice.workItem !== expectedWorkItem ||
          !choice.assignment || !isDeepStrictEqual(choice.assignment.identity, identity) ||
          ref(choice) !== state.outcome.questionRef ||
          (choice.headSha !== identity.sourceHeadSha && !await authenticateSuccessor?.(choice.headSha))) return false;
      await verifySpecialistChoice(job, choice.id, "answered");
      return isDeepStrictEqual(answer, answerRef(choice));
    },
  });
}

/** Validate BOTH the root interrupt and the actual nested SQLite task, plus the
 * existing source-bound question. An END result or ordinary pause is not a
 * Command(resume) target. No transcript or answer text is in the graph input. */
export async function pendingGenerationQuestion(job: JobStartResult, saver: SqliteSaver,
  snapshot: StateSnapshot, thread: string, principal?: string) {
  const interrupts = snapshot.tasks.flatMap(task => task.interrupts.map(interrupt => ({ task, interrupt })));
  const question = interrupts.find(({ interrupt }) => interrupt.value?.kind === "assignment-author-question");
  if (!question) return null;
  if (interrupts.length !== 1 || snapshot.next.length !== 1 ||
      snapshot.next[0] !== question.task.name || !question.interrupt.id)
    throw Error("Ambiguous pending Generation question.");
  const questionRef = question.interrupt.value.questionRef;
  if (typeof questionRef !== "string" || !/^[a-f0-9-]{36}:[a-f0-9]{64}$/.test(questionRef))
    throw Error("Pending interrupt lacks an original Question Set reference.");
  const choice = await inspectSpecialistChoice(job, questionRef.split(":")[0]!);
  const binding = choice.assignment;
  if (!choice || !binding || binding.identity.graphThreadId !== thread ||
      binding.identity.turnDigest !== snapshot.values.request?.turnPlanDigest ||
      !binding.namespace.startsWith(question.task.name + "|") ||
      question.interrupt.value.assignmentKey !== logicalAssignmentKey(binding.identity) ||
      question.interrupt.value.questionRef !== ref(choice))
    throw Error("Pending Generation question lost its original assignment or source.");
  if (binding.identity.assignmentId.startsWith("dependency:")) {
    const plan = await inspectDependencyPlan(job);
    const entry = plan?.entries.find(e =>
      e.amendment?.assignment.id === binding.identity.assignmentId);
    const grant = entry?.amendment;
    const parent = snapshot.values;
    const reviewPin = parent.reviewPrerequisite;
    const reviewRequest = plan?.reviewRequests?.find(r => r.sourceSha === entry?.reviewSourceSha &&
      r.digest === reviewPin?.suspension?.suspensionRef);
    if (question.task.name !== "dependency_amendment" || !grant || entry?.fixture ||
        !["authorized", "reviewing", "verified"].includes(entry.phase) ||
        grant.afterVersion !== binding.identity.planVersion ||
        grant.turnDigest !== binding.identity.turnDigest ||
        grant.sourceSha !== binding.identity.sourceHeadSha ||
        dependencyDigest(grant.assignment) !== binding.identity.scopeDigest ||
        choice.workItem !== focusedChoiceWorkItem(grant.assignment.targets[0]!, grant.assignment.id) ||
        (entry.reviewSourceSha
          ? !reviewRequest || reviewPin.suspension.evidenceRef !== reviewRequest.reviewDigest ||
            reviewPin.submission.headSha !== entry.reviewSourceSha ||
            reviewPin.identity.planVersion !== parent.planVersion
          : parent.focusedPrerequisite?.suspension?.evidenceRef !== entry.reportDigest ||
            parent.focusedPrerequisite?.identity?.planVersion !== parent.planVersion))
      throw Error("Pending supporting question lost its exact parent dependency admission.");
  } else if (binding.identity.planVersion !== snapshot.values.planVersion)
    throw Error("Pending Generation question lost its original assignment plan version.");
  const nested = await saver.getTuple({ configurable: { thread_id: thread,
    checkpoint_ns: binding.namespace } });
  const state = nested?.checkpoint.channel_values;
  const outcome = state?.outcome as QuestionOutcome | undefined;
  if (!nested || !isDeepStrictEqual(state?.identity, binding.identity))
    throw Error("Author choice is not bound to the original nested SQLite task.");
  if (snapshot.values.request?.job !== undefined && snapshot.values.request.job !== job.jobId ||
      snapshot.values.request?.story !== undefined && snapshot.values.request.story !== job.storyRoot)
    throw Error("Pending question belongs to a different Story job.");
  if (principal && choice.answer && choice.answer.principal !== principal)
    throw Error("Accepted answer belongs to a different author.");
  if (outcome?.status === "awaiting-author" && outcome.questionRef === ref(choice) &&
      outcome.resumePhase === binding.resumePhase &&
      nested.pendingWrites?.some(([, channel, value]) => channel === "__interrupt__" &&
        isDeepStrictEqual(value, question.interrupt))) {
    if (choice.phase !== "awaiting-author" && choice.phase !== "answered")
      throw Error("Pending child has no unconsumed author question.");
    if ((await activeSpecialistChoice(job))?.id !== choice.id)
      throw Error("Pending Question Set is not the active specialist receipt.");
    await verifySpecialistChoice(job, choice.id, choice.phase);
    return { choice, interruptId: question.interrupt.id, phase: "interrupt" as const };
  }
  // A root task can retain its old interrupt while its child has already
  // durably consumed that exact answer. Resume the pending task without a
  // second Command; the original domain invocation/effect adapter must
  // reconcile a settled turn or fence an ambiguous writer start.
  if (choice.phase !== "awaiting-author" && choice.answerSeal &&
      isDeepStrictEqual(state?.authorAnswerRef, answerRef(choice)) &&
      state?.authorResumePhase === binding.resumePhase) {
    if (choice.phase === "answered") await verifySpecialistChoice(job, choice.id, "answered");
    return { choice, interruptId: question.interrupt.id, phase: "continuation" as const };
  }
  throw Error("Author choice is not a pending nested SQLite task.");
}
export function generationQuestionResume(pending: NonNullable<Awaited<ReturnType<typeof pendingGenerationQuestion>>>) {
  if (pending.phase === "continuation") return null;
  if (pending.choice.phase !== "answered" || !pending.choice.answerSeal)
    throw Error("The original Question Set has no submitted answer.");
  return new Command<unknown, never, never>({ resume: { [pending.interruptId]: answerRef(pending.choice) } });
}

/** Keep the original interrupt pending when the cumulative budget is already
 * exhausted. The specialist repeats the same step guard under its writer
 * lease before claiming the accepted answer; no fresh step or call is charged. */
export async function pendingQuestionBudgetPause(job: JobStartResult,
  pending: NonNullable<Awaited<ReturnType<typeof pendingGenerationQuestion>>>) {
  if (pending.phase !== "interrupt" || pending.choice.phase !== "answered") return null;
  const identity = pending.choice.assignment!.identity;
  const workItem = pending.choice.workItem;
  // Supporting writers charge the canonical Architecture plan version, not
  // the independent dependency-overlay counter.
  const support = identity.assignmentId.startsWith("dependency:")
    ? (await inspectDependencyPlan(job))?.entries.find(e => e.amendment?.assignment.id === identity.assignmentId)
    : undefined;
  const supportVersion = support ? JSON.parse(await (await import("node:fs/promises")).readFile(
    join(job.stateDir, "architecture.json"), "utf8")).plan?.version : undefined;
  const step = support && Number.isSafeInteger(supportVersion)
    ? identity.assignmentId + ":" + supportVersion :
    workItem === "world-foundations" ? "foundations:world" :
    workItem === "character-foundations" ? "foundations:character" :
    workItem.startsWith("event-") ? "event:" + workItem :
    identity.assignmentId.startsWith("focus:") ? identity.assignmentId + ":" + identity.planVersion : null;
  if (!step) throw Error("Author question has no original specialist budget step.");
  try {
    await withStoryJobLock(job, "generation-answer-budget", () => guardPiBudget(job, step));
    return null;
  } catch (error) {
    if (!(error instanceof PiBudgetPause)) throw error;
    return error.message;
  }
}

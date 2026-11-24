/**
 * Opt-in self-contained end-to-end live Pi regression for a missing Character
 * first identified during an independently sealed Event review.
 *
 * The original Event, independent negative Review, support Character,
 * Event correction and successor reviews use real sandboxed Pi and the
 * production controller. The deterministic SQLite certification lives in
 * generation.test.ts (R14D).
 * No historical job SHA, issue ID, or private Story is required.
 *
 * NT_LIVE_EVENT_CHARACTER_DEPENDENCY=1 pnpm exec tsx --test test/event-character-dependency-live.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob } from "../src/job.js";
import { runEventTestAssignment as runEventWorkItem } from "./event-round-fixture.js";
import { runCharacterWorldJob } from "../src/character-world.js";
import { selectStoryOrchestrator } from "../src/orchestrator-selection.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview, resolvedCheckpointReviews } from "../src/checkpoint-assurance.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { reviewBoundedAssignments, runPiAssignmentReview } from "../src/semantic-assignment-review.js";
import { ReviewDependencyRequiredError } from "../src/rejected-review-repair.js";
import { advanceReviewCharacterDependency as runReviewSupport } from "../src/dependency-work.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { executeReviewRound } from "../src/rejected-review-repair.js";
import type { ReviewRoundCommand } from "../src/rejected-review-repair.js";

/** Adapter certification runs the actual nested supporting writer child under
 * a persisted test parent, rather than retaining an uncheckpointed runtime API. */
async function advanceReviewCharacterDependency(input: Parameters<typeof runReviewSupport>[0]) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const saver = SqliteSaver.fromConnString(join(job.stateDir, "event-character-test.sqlite"));
  try {
    const channels = Annotation.Root({ result: Annotation<Awaited<ReturnType<typeof runReviewSupport>>>() });
    const graph = new StateGraph(channels)
      .addNode("support", async (_, config) => ({ result: await runReviewSupport(input, config) }))
      .addEdge(START, "support").addEdge("support", END).compile({ checkpointer: saver });
    return (await graph.invoke({}, { configurable: { thread_id: job.threadId + ":support-test" }, durability: "sync" })).result;
  } finally { saver.db.close(); }
}

/** Direct live adapter test, not a second production scheduler. The original
 * adapter uses real independent review evidence; the production case is
 * separately certified through the Generation graph. */
async function executeEventReviewTest(job: Awaited<ReturnType<typeof startStoryJob>>, sourceSha: string,
  options: Parameters<typeof executeReviewRound>[3]) {
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === sourceSha && p.eligible)!;
  const authority = { rootSha: sourceSha, caseId: "event-character-live-test",
    assignmentKey: hash(job.threadId + ":" + point.workItem + ":" + sourceSha), workItem: point.workItem };
  let command: ReviewRoundCommand = { phase: "admit", sourceSha };
  for (;;) {
    const result = await executeReviewRound(job, authority, command, options);
    if (result.status === "admitted") command = { phase: "correct", sourceSha: result.sourceSha, grantDigest: result.grantDigest };
    else if (result.status === "committed") command = { phase: "verify", sourceSha: result.sourceSha, successorSha: result.successorSha };
    else if (result.status === "native-rejected") command = { phase: "native-invoke", sourceSha: result.sourceSha, grantDigest: result.grantDigest };
    else if (result.status === "native-settled") command = { phase: "native-verify", sourceSha: result.sourceSha, proof: result.proof };
    else if (result.status === "native-correction") command = { phase: "native-correct", sourceSha: result.sourceSha, proof: result.proof, grantDigest: result.grantDigest };
    else if (result.status === "passed") return { next: "completed" };
    else if (result.status === "failed") command = { phase: "admit", sourceSha: result.successorSha };
    else throw Error("Unexpected Event Review test boundary: " + JSON.stringify(result));
  }
}
import { finalizeReviewEventDependency, inspectDependencyPlan } from "../src/dependency-state.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { removeTestTree } from "./helpers.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test(
  "real Pi recovers a sealed missing-Character Event failure using two separately reviewed owners",
  {
    skip:
      process.env.NT_LIVE_EVENT_CHARACTER_DEPENDENCY !== "1"
        ? "Set NT_LIVE_EVENT_CHARACTER_DEPENDENCY=1 for the real rootless Pi recovery"
        : false,
    timeout: 1_200_000,
  },
  async () => {
    const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
    const security = JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
        encoding: "utf8",
      }),
    ) as string[];
    assert.ok(security.some((flag) => /(^|=)rootless$/.test(flag)));
    assert.equal(
      execFileSync("docker", ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"], {
        encoding: "utf8",
      }).trim(),
      "2/systemd",
    );
    const temp = mkdtempSync(join(tmpdir(), "nt-event-character-recovery-"));
    const image = process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local";
    const jobId = randomUUID();
    const old = Object.fromEntries(
      [
        "NT_STATE_DIR",
        "NT_GIT_CACHE_DIR",
        "NT_SKILL_CACHE_DIR",
        "NT_CONFIG_FILE",
        "NT_SANDBOX_SOCKET",
        "NT_SANDBOX_TOKEN_FILE",
        "NT_REQUIRE_SANDBOX_TOOLS",
        "NT_REQUIRE_USER_PI_RUNTIME",
      ].map((name) => [name, process.env[name]]),
    );
    let controller: SandboxController | undefined;
    let server: ReturnType<typeof createControllerServer> | undefined;
    let complete = false;
    const git = (cwd: string, ...args: string[]) => {
      const run = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    };
    try {
      const app = join(temp, "app"),
        state = join(temp, "state");
      const cache = join(temp, "cache"),
        socketDir = join(temp, "controller");
      for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
      const owner = "dependency-cert-owner",
        repositoryId = "dependency-cert-repo";
      const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
      const repo = join(scoped, "base"),
        story = join(repo, "story");
      mkdirSync(join(story, "creative-direction"), { recursive: true });
      writeFileSync(
        join(story, "creative-direction/foundation.md"),
        `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The absent night witness"
status: draft
decisions:
  - id: meaningful-choice
    statement: "The player will eventually choose whether to protect or confront a friend"
    origin: user
    authority: user-protected
premise: "At a community archive, Ada and Neri investigate a missing ledger entry"
central_conflict: "The missing record tests Ada's loyalty to Neri"
genre: "Mystery"
tone: "Uneasy and intimate"
player_experience: "Dialogue-led investigation with consequential choices"
scope: "A small cast, an archive, and one potential night witness"
---

Ada and Neri debate the concealed ledger entry while waiting for the
night witness who may be able to identify its source.
`,
      );
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "Author");
      git(repo, "config", "user.email", "author@example.test");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "Source Creative Direction");
      const baseline = git(repo, "rev-parse", "HEAD");
      const db = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
        CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
        CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
        db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo-id", owner, "github", repositoryId);
        db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story-id", owner, "repo-id", "story");
        db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
          jobId,
          owner,
          "story-id",
          baseline,
          null,
        );
      } finally {
        db.close();
      }
      const token = randomBytes(48).toString("hex");
      const tokenFile = join(socketDir, "controller.token");
      writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
      const config: ControllerConfig = {
        socket: join(socketDir, "controller.sock"),
        token,
        appVolume: app,
        stateVolume: state,
        cacheVolume: cache,
        containerState: state,
        containerCache: cache,
        image,
      };
      controller = new SandboxController(config);
      server = createControllerServer(controller);
      server.listen(config.socket);
      await once(server, "listening");
      process.env.NT_STATE_DIR = state;
      process.env.NT_GIT_CACHE_DIR = scoped;
      process.env.NT_SKILL_CACHE_DIR = join(temp, "skills");
      process.env.NT_CONFIG_FILE = join(temp, "config.json");
      process.env.NT_SANDBOX_SOCKET = config.socket;
      process.env.NT_SANDBOX_TOKEN_FILE = tokenFile;
      process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
      delete process.env.NT_REQUIRE_USER_PI_RUNTIME;
      const env = { ...process.env };
      const cli = async (...args: string[]) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", resolve("src/cli.ts"), "job", ...args, "--story", story, "--job", jobId],
          {
            cwd: resolve("."),
            env,
            timeout: 600_000,
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        assert.equal(code, 0, stderr || stdout);
        return JSON.parse(stdout);
      };

      const job = await cli("start");
      const contract = {
        scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
        constraints: ["Never change author-protected choices"],
        envelope: {
          presentation: "Dialogue-led visual novel",
          hardLimits: ["One archive setting"],
          preferences: ["Two existing Characters plus a central night witness"],
        },
      };
      const task =
        "MANDATORY STORY REQUIREMENT: Create canonical Character Mara, " +
        "the central night witness, and include her spoken testimony to Ada in " +
        "the disclosure Event about the concealed ledger entry. Ada must weigh " +
        "Mara's testimony before confronting Neri. Deliver a mystery game. " +
        "The Event initially authored without Mara is incomplete against this " +
        "approved whole-Story Turn, even if it fulfills its narrower Milestone.";
      const originalEventTask =
        "Write the initial disclosure Event: Ada and Neri discuss " +
        "the concealed ledger and the expected night witness. Use the existing " +
        "registered cast; the independent reviewer will check the whole original " +
        "Turn goal separately.";
      const turn = planWholeStory(task, contract, baseline, jobId);
      writeFileSync(join(job.stateDir, "turn-plan.json"), JSON.stringify(turn));
      await selectStoryOrchestrator(
        job,
        job.threadId + ":generation",
        {
          task,
          kind: "full-story",
          turnPlanDigest: turn.digest,
        },
        source,
      );
      const contractFile = join(temp, "contract.json");
      writeFileSync(contractFile, JSON.stringify(contract));
      assert.equal(
        (await cli("architecture", "run", "--fixture", "--contract", contractFile, "--skills-source", source))
          .status,
        "architecture-committed",
      );
      const sealFixturePrerequisite = async (workItem: string) => {
        const point = (await inspectRecoveryCheckpoints(job)).find(
          (p) => p.eligible && p.workItem === workItem,
        );
        assert.ok(point?.assurance, "Prerequisite checkpoint lost: " + workItem);
        if (point.semanticReview !== "required-pending") {
          assert.equal(point.semanticReview, "not-required");
          return;
        }
        // Earlier Architecture/Foundation writes are fixtures, not real Pi
        // editorial judgments. Keep that distinction in the sealed receipt.
        await reviewBoundedAssignments(
          job,
          [point],
          async (packet) => ({
            sourceDigest: packet.sourceDigest,
            verdict: "pass" as const,
            findings: [],
            evidence: packet.items.map((item) => ({
              commitSha: item.assurance.commitSha,
              assignmentId: item.assignment.id,
              path: item.assurance.changedPaths[0],
              line: 1,
              explanation: "Deterministic fixture precondition: native-validated scope is accepted.",
            })),
          }),
          "deterministic-prerequisite-fixture",
          true,
        );
        assert.equal((await readIndependentReview(job, point.assurance)).status, "passed");
      };
      await sealFixturePrerequisite("global-architecture");
      const foundationsInput = {
        story,
        job: jobId,
        action: "run" as const,
        fixture: true,
        skillsSource: source,
      };
      // The production writer must stop before Character Foundations until its
      // World prerequisite has a separate trusted review.
      await assert.rejects(runCharacterWorldJob(foundationsInput), /world-foundations|review.*pending/i);
      await sealFixturePrerequisite("world-foundations");
      assert.equal((await runCharacterWorldJob(foundationsInput)).status, "foundations-committed");
      await sealFixturePrerequisite("character-foundations");
      const provider = process.env.NT_PROVIDER ?? "openai";
      const model = process.env.NT_MODEL ?? "gpt-6-luna";
      const author = await runEventWorkItem({
        story,
        job: jobId,
        action: "run",
        milestone: "milestone.disclosure",
        skillsSource: source,
        task: originalEventTask,
        provider,
        model,
      });
      assert.equal(
        author.status,
        "event-cluster-committed",
        "Original Pi writer must produce a real Event; a no-write report is not a review failure",
      );
      const sourceSha = author.headSha as string;
      const originalHead = git(job.worktreeRoot, "rev-parse", "HEAD");
      assert.equal(sourceSha, originalHead);
      const point = (await inspectRecoveryCheckpoints(job)).find((p) => p.commitSha === sourceSha);
      assert.ok(point?.eligible && point.assurance, point?.reason ?? "Event checkpoint unavailable");
      assert.equal(point.assurance.reviewSelection.status, "required-pending");
      const eventPath = (author.paths as string[]).find((path) => path.startsWith("events/"));
      assert.ok(eventPath);
      const text = readFileSync(join(job.worktreeStoryRoot, eventPath), "utf8");
      const lines = text.split(/\r?\n/);
      const citedLine =
        lines.findIndex((line) => /\b(?:Ada|Neri)\b/.test(line) && !line.trim().startsWith("participants:")) +
        1;
      assert.ok(citedLine > 0, "The real Event lacks a source line for the omission finding");
      assert.ok(!/\bMara\b/.test(text), "Initial Event must omit the requested witness");
      assert.ok(
        !/^participants:.*\bcharacter\.mara\b/m.test(text),
        "The exercise requires an unregistered witness",
      );

      // A migrated Review must authenticate an actual settled independent
      // Pi verdict; a fabricated negative fixture cannot authorize a repair.
      const reviewSnapshot = await createSkillSnapshot({ discovery: "explicit-only",
        novelteaSkills: source, skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] });
      assert.ok(reviewSnapshot);
      const firstReview = await withStoryJobLock(job, "independent-assignment-review", () =>
        runPiAssignmentReview(job, [point], { snapshot: reviewSnapshot, provider, model,
          reviewer: "independent-pi-assignment-review", onSession: async () => {} }));
      assert.equal(firstReview.verdict.verdict, "fail", JSON.stringify(firstReview.verdict));
      assert.ok(firstReview.verdict.findings.some(finding =>
        finding.path === eventPath && /character/i.test(finding.requiredCorrection ?? "") &&
        /mara/i.test(finding.requiredCorrection ?? "")),
        "Original reviewer must identify the actual missing Character.");
      assert.equal((await readIndependentReview(job, point.assurance)).status, "failed");
      const sourceEventDigest = hash(text);
      assert.equal((await new SandboxClient().acquire(jobId)).status, "running");
      const options = { provider, model, skillsSource: source };
      let request: ReviewDependencyRequiredError["request"] | undefined;
      try {
        await executeEventReviewTest(job, sourceSha, options);
      } catch (error) {
        if (!(error instanceof ReviewDependencyRequiredError)) throw error;
        request = error.request;
      }
      assert.ok(request, "Original rejected Event must request separately scoped Character work");
      assert.equal(request.classification, "new-full-story-record");
      const support = await advanceReviewCharacterDependency({
        story,
        job: jobId,
        task,
        contract,
        skillsSource: source,
        provider,
        model,
        turnPlanDigest: turn.digest,
        request,
      });
      assert.equal(support.status, "dependency-support-verified");
      assert.equal(
        (await readIndependentReview(job, point.assurance)).status,
        "failed",
        "Supporting Character review cannot erase the negative Event review",
      );
      const repair = await executeEventReviewTest(job, sourceSha, options);
      assert.equal(
        repair.next,
        "completed",
        "Original Event owner must pass an independent corrective review",
      );
      assert.equal(
        await withStoryJobLock(job, "event-character-finalize", () =>
          finalizeReviewEventDependency(job, sourceSha),
        ),
        true,
      );
      const final = await inspectDependencyPlan(job);
      const entry = final?.entries.find((e) => e.reviewSourceSha === sourceSha);
      assert.equal(entry?.phase, "verified");
      assert.equal(entry?.review?.verdict, "pass");
      assert.ok(entry.eventRepair && entry.reviewerSession);
      const head = git(job.worktreeRoot, "rev-parse", "HEAD");
      const changed = git(job.worktreeRoot, "diff", "--name-only", entry.commitSha!, head);
      assert.equal(changed, "story/" + eventPath, "Only the Event owner may correct the Event");
      assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
      assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
      assert.equal(
        hash(
          execFileSync("git", ["show", sourceSha + ":story/" + eventPath], {
            cwd: job.worktreeRoot,
            encoding: "utf8",
          }),
        ),
        sourceEventDigest,
        "Immutable rejected source must stay unchanged",
      );
      assert.equal((await readIndependentReview(job, point.assurance)).status, "failed");
      const reopened = await startStoryJob({ story, job: jobId }, false);
      assert.equal(
        (await inspectDependencyPlan(reopened))?.digest,
        final!.digest,
        "Ledger must survive disconnected job reopening",
      );
      await assert.rejects(
        inspectDependencyPlan({ ...reopened, threadId: "other-thread" }),
        /identity|source/i,
        "Foreign thread must not gain write authorization",
      );
      assert.equal(
        (
          await advanceReviewCharacterDependency({
            story,
            job: jobId,
            task,
            contract,
            skillsSource: source,
            provider,
            model,
            turnPlanDigest: turn.digest,
            request,
          })
        ).status,
        "dependency-verified",
        "Restart must not rerun a previously committed Character",
      );
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
      const reviewPoints = await inspectRecoveryCheckpoints(reopened);
      const resolved = await resolvedCheckpointReviews(
        reopened,
        reviewPoints.filter((p) => p.eligible),
      );
      assert.equal(
        resolved.get(sourceSha),
        "not-required",
        "Passing separately owned correction must cover (not overwrite) original failure",
      );
      console.error(
        "EVENT_CHARACTER_LIVE_RESULT " +
          JSON.stringify({
            kind: "real-model-correction + deterministic-source-negative",
            sourceSha,
            supportCommit: entry.commitSha,
            correctedCommit: head,
            sealedOriginal: "failed",
            final: "passed",
            crossThread: "denied",
            restart: "no-replay",
          }),
      );
      complete = true;
    } finally {
      if (controller) await controller.dispose(jobId);
      if (server) await new Promise<void>((done) => server!.close(() => done()));
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (!complete && process.env.NT_KEEP_FAILED_LIVE === "1") {
        console.error("EVENT_CHARACTER_LIVE_PRESERVED " + temp);
      } else removeTestTree(temp);
    }
  },
);

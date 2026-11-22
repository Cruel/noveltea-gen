/** #235: opt-in real Pi initial approval plus independently reviewed, bounded
 * postapproval author clarification. Historical semantic defects are covered
 * by deterministic certification; this does not manufacture a live model error. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import {
  archiveReviewedMilestoneBlueprint,
  ensureMilestoneBlueprint,
  originalBlueprintReviewDigest,
  readReviewedMilestoneBlueprint,
} from "../src/milestone-blueprint.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { configurePiPolicy, inspectPiPolicy } from "../src/job-pi-policy.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import type { Plan } from "../src/architecture.js";
import type { EventAssignment } from "../src/event-specialist.js";
import { removeTestTree } from "./helpers.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const enabled = process.env.NT_LIVE_APPROVED_WORK_235 === "1";

test(
  "#235 opt-in pinned real Pi approves a Blueprint and independently reviews a bounded historical revision",
  {
    skip: !enabled && "Set NT_LIVE_APPROVED_WORK_235=1, NT_PROVIDER and NT_MODEL to permit paid Pi calls",
    timeout: 420_000,
  },
  async () => {
    const provider = process.env.NT_PROVIDER,
      model = process.env.NT_MODEL;
    assert.ok(provider && model, "Pin NT_PROVIDER and NT_MODEL explicitly; no automatic model substitution.");
    const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
    assert.ok(existsSync(join(skills, "skills/nt-event-design/SKILL.md")));
    const security = JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
        encoding: "utf8",
        timeout: 8000,
      }),
    ) as string[];
    assert.ok(
      security.some((value) => /(^|=)rootless$/.test(value)),
      "Live Pi requires rootless Docker.",
    );
    const image = process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local";
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 8000 });

    const tmp = mkdtempSync(join(tmpdir(), "nt-235-live-blueprint-"));
    const id = randomUUID();
    const keys = [
      "NT_STATE_DIR",
      "NT_GIT_CACHE_DIR",
      "NT_SKILL_CACHE_DIR",
      "NT_CONFIG_FILE",
      "NT_SANDBOX_SOCKET",
      "NT_SANDBOX_TOKEN_FILE",
      "NT_REQUIRE_SANDBOX_TOOLS",
      "NT_REQUIRE_USER_PI_RUNTIME",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    let controller: SandboxController | undefined;
    let server: ReturnType<typeof createControllerServer> | undefined;
    let completed = false;
    try {
      const app = join(tmp, "app"),
        state = join(tmp, "state"),
        cache = join(tmp, "cache"),
        socketDir = join(tmp, "controller");
      for (const dir of [app, state, cache, socketDir]) mkdirSync(dir, { recursive: true });
      const owner = "235-certification-owner",
        repository = "235-certification-repository";
      const scoped = join(cache, digest(owner), digest("github:" + repository));
      const repo = join(scoped, "base"),
        story = join(repo, "story");
      const milestonePath = "milestones/gate.md",
        milestoneId = "milestone.gate";
      mkdirSync(join(story, "milestones"), { recursive: true });
      writeFileSync(
        join(story, milestonePath),
        `---
schema: '0.1'
type: milestone
id: milestone.gate
title: "The Gate Register"
status: draft
decisions: []
arcs: []
completeness: partial
fulfillment: {any_of: []}
---

Ada can inspect a dated public gate register but cannot infer what happened on
other days. No Choice or Puzzle occurs in this Milestone. A later Milestone
contains any consequential Interactive work; this scene needs only readable
Event evidence and Composition delivery.
`,
      );
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repo,
          encoding: "utf8",
        }).trim();
      git("init", "-q");
      git("config", "user.name", "Certification");
      git("config", "user.email", "certification@example.invalid");
      git("add", ".");
      git("commit", "-qm", "Bounded independent Blueprint source");
      const baseline = git("rev-parse", "HEAD");
      const db = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        db.exec(
          "CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
            "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
            "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);",
        );
        db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repository);
        db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
        db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story", baseline, null);
      } finally {
        db.close();
      }
      const token = randomBytes(48).toString("hex"),
        tokenFile = join(socketDir, "controller.token");
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
      Object.assign(process.env, {
        NT_STATE_DIR: state,
        NT_GIT_CACHE_DIR: scoped,
        NT_SKILL_CACHE_DIR: join(tmp, "skills"),
        NT_CONFIG_FILE: join(tmp, "absent-config.json"),
        NT_SANDBOX_SOCKET: config.socket,
        NT_SANDBOX_TOKEN_FILE: tokenFile,
        NT_REQUIRE_SANDBOX_TOOLS: "1",
        NT_REQUIRE_USER_PI_RUNTIME: "0",
      });
      const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
      const snapshot = await createSkillSnapshot({
        discovery: "explicit-only",
        novelteaSkills: skills,
        skillDirs: [],
        requiredSkills: ["nt-event-design", "nt-catalog"],
      });
      assert.ok(snapshot);
      const plan = {
        version: 1,
        contract: {
          scope: { kind: "partial", depth: "event", targets: [milestoneId], branches: [] },
          constraints: [
            "Do not assert unobserved evidence or invent current-Milestone Interactive obligations.",
          ],
          envelope: { presentation: "Text-led mystery", hardLimits: [], preferences: [] },
        },
        items: [{ id: "global-architecture", status: "verified", targetIds: [milestoneId] }],
      } as unknown as Plan;
      const assignment = {
        milestoneId,
        milestonePath,
        sourcePaths: [milestonePath],
        characterIds: [],
      } as unknown as EventAssignment;
      await configurePiPolicy(job, {
        version: 1,
        profile: { provider, model },
        limits: { modelCalls: 12, activeSeconds: 300 },
      });
      const run = () =>
        withStoryJobLock(job, "event-gate", () =>
          ensureMilestoneBlueprint(
            job,
            plan,
            assignment,
            snapshot,
            provider,
            model,
            "Design one observable gate-register Event. Review the exact current-Milestone " +
              "ownership and observable evidence; correct any independently reported material defect.",
            baseline,
            false,
          ),
        );
      try {
        const result = await run();
        const file = join(job.stateDir, "milestone-blueprints", "gate.json");
        const receipt = JSON.parse(readFileSync(file, "utf8")) as {
          writer: { id: string };
          reviewer: { id: string };
          rounds: Array<{ review: { status: string } }>;
        };
        assert.notEqual(receipt.writer.id, receipt.reviewer.id, "author cannot approve own plan");
        assert.equal(receipt.rounds.at(-1)?.review.status, "pass");
        assert.deepEqual(
          (await readReviewedMilestoneBlueprint(job, result.pin, assignment)).downstream,
          result.blueprint.downstream,
        );
        assert.ok(
          !result.blueprint.downstream.some((item) => item.owner === "interactive"),
          "A statement that no mechanics are needed must not create an Interactive assignment.",
        );
        const previousRounds = receipt.rounds.length;
        const before = (await inspectPiPolicy(job)).budget;
        const replay = await run();
        assert.equal(replay.pin.digest, result.pin.digest);
        assert.equal(
          (await inspectPiPolicy(job)).budget.modelCalls,
          before.modelCalls,
          "repeated admission must not replay any paid model call",
        );
        // The clean first-pass plan is NOT evidence of a model error. Exercise the
        // same signed-review correction boundary with a narrowly scoped follow-up
        // author clarification against this REAL Pi-approved historical plan.
        const historicalDigest = await originalBlueprintReviewDigest(job, result.pin);
        await archiveReviewedMilestoneBlueprint(job, result.pin, assignment);
        const candidate = structuredClone(result.blueprint);
        const compositionIndex = candidate.downstream.findIndex((item) => item.owner === "composition");
        assert.ok(compositionIndex >= 0, "Initial approved delivery needs a Composition owner");
        candidate.downstream[compositionIndex]!.obligation +=
          " Explicitly present the dated register entry and state that unobserved days are unknown.";
        const supersedes = {
          original: result.pin,
          eventHead: baseline,
          turnDigest: digest("235-test-only-author-revision"),
          evidenceDigest: digest("235-test-only-author-clarification"),
          originalReviewDigest: historicalDigest,
        };
        const accepts = (draft: typeof candidate) => JSON.stringify(draft) === JSON.stringify(candidate);
        const correction = () =>
          withStoryJobLock(job, "event-gate", () =>
            ensureMilestoneBlueprint(
              job,
              plan,
              assignment,
              snapshot,
              provider,
              model,
              "TEST-ONLY POSTAPPROVAL AUTHOR CLARIFICATION. This is NOT a model-detected defect " +
                "and does not claim a historical error. Preserve EVERY field, Event, order, " +
                "downstream owner and original fact. Do not invent Interactive work. The author " +
                "now explicitly requires the Composition obligation to show the date and " +
                "uncertainty about other days. The approved Event source must not be modified. " +
                "Return exactly this bounded replacement Blueprint: " +
                JSON.stringify(candidate),
              baseline,
              false,
              { candidate, sources: [milestonePath], accepts, exactPatch: true, supersedes },
            ),
          );
        const revised = await correction();
        assert.deepEqual(
          revised.blueprint,
          candidate,
          "A postapproval author-directed revision may change only its authorized field.",
        );
        assert.notDeepEqual(revised.pin, result.pin);
        assert.deepEqual(
          await readReviewedMilestoneBlueprint(job, result.pin, assignment),
          result.blueprint,
          "Original real-Pi approval stays immutable after correction.",
        );
        assert.equal(await originalBlueprintReviewDigest(job, result.pin), historicalDigest);
        const correctionReceipt = JSON.parse(readFileSync(file, "utf8")) as {
          writer: { id: string };
          reviewer: { id: string };
          rounds: Array<{ review: { status: string } }>;
        };
        assert.notEqual(correctionReceipt.writer.id, correctionReceipt.reviewer.id);
        assert.notEqual(correctionReceipt.reviewer.id, receipt.reviewer.id);
        assert.equal(correctionReceipt.rounds.at(-1)?.review.status, "pass");
        assert.deepEqual(await readReviewedMilestoneBlueprint(job, revised.pin, assignment), candidate);
        const after = (await inspectPiPolicy(job)).budget;
        assert.ok(after.modelCalls > before.modelCalls && after.modelCalls <= 12);
        const replayRevision = await correction();
        assert.deepEqual(replayRevision.pin, revised.pin);
        assert.equal((await inspectPiPolicy(job)).budget.modelCalls, after.modelCalls);
        console.error(
          "#235 LIVE PI (real approval + bounded author clarification): " +
            JSON.stringify({
              provider,
              model,
              initialReviewRounds: previousRounds,
              initialReviewStatus: receipt.rounds.map((r) => r.review.status),
              revisionReason: "test-only author clarification, NOT an original model defect",
              revisionReviewRounds: correctionReceipt.rounds.length,
              revisionReviewStatus: correctionReceipt.rounds.map((r) => r.review.status),
              originalApprovalPreserved: true,
              sourceUnchanged: git("rev-parse", "HEAD") === baseline,
              modelCalls: after.modelCalls,
              costUsd: after.costUsd,
              unpricedCalls: after.unpricedCalls,
              tokens: after.tokens,
            }),
        );
        assert.equal(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: job.worktreeRoot,
            encoding: "utf8",
          }).trim(),
          "",
          "Blueprint work must not author canon or another commit.",
        );
        completed = true;
      } catch (error) {
        const observed = await inspectPiPolicy(job);
        console.error(
          "#235 LIVE PI INCOMPLETE (not fixture evidence): " +
            JSON.stringify({
              provider,
              model,
              modelCalls: observed.budget.modelCalls,
              costUsd: observed.budget.costUsd,
              unpricedCalls: observed.budget.unpricedCalls,
              tokens: observed.budget.tokens,
              reason: error instanceof Error ? error.message : String(error),
            }),
        );
        throw error;
      }
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      if (controller) await controller.dispose(id);
      if (server) await new Promise<void>((done) => server!.close(() => done()));
      if (completed || process.env.NT_KEEP_FAILED_LIVE !== "1") removeTestTree(tmp);
      else console.error("#235 private interrupted live evidence retained at " + tmp);
    }
  },
);

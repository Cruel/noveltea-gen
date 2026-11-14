import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import { removeTestTree } from "./helpers.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { reviewNarrative, reviewSpecialistAssignments, type ReviewAssignment } from "../src/narrative-review-specialist.js";
import { loadSealedReviewContext } from "../src/sealed-review-context.js";
import { semanticUnitOutcome, type SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import { canonicalPinnedReadPath } from "../src/pinned-skill-reads.js";

test(
  process.env.NT_LIVE_ARCHITECTURE_ONLY === "1"
    ? "opt-in real Luna Architecture authors partial Milestones without premature Event binding"
    : "opt-in two real pinned Pi specialists build and certify a Choice/Puzzle interactive slice",
  {
    skip:
      process.env.NT_LIVE_INTERACTIVE !== "1"
        ? "set NT_LIVE_INTERACTIVE=1 to certify real specialists"
        : false,
    timeout: 1_200_000,
  },
  async () => {
    const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
    for (const name of ["nt-interactive-narrative", "nt-puzzle-design"]) {
      assert.ok(existsSync(join(source, "skills", name, "SKILL.md")));
    }
    const resumeDir = process.env.NT_TEST_INTERACTIVE_RESUME_DIR;
    const temp = resumeDir ? resolve(resumeDir) : mkdtempSync(join(tmpdir(), "nt-interactive-live-"));
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    // Same registered-job identity and private controller boundary as the hosted
    // integration test. Real Pi can never fall back to host filesystem tools.
    const jobId = resumeDir
      ? (
          JSON.parse(
            readFileSync(
              join(temp, "state", "jobs", readdirSync(join(temp, "state", "jobs"))[0]!, "job.json"),
              "utf8",
            ),
          ) as { jobId: string }
        ).jobId
      : randomUUID();
    const owner = "interactive-cert-owner",
      providerRepo = "interactive-cert-repo";
    const cache = join(temp, "cache"),
      app = join(temp, "app"),
      state = join(temp, "state");
    const scoped = join(cache, sha(owner), sha("github:" + providerRepo));
    const socketDir = join(temp, "controller");
    for (const path of [app, state, scoped, socketDir]) mkdirSync(path, { recursive: true });
    const tokenFile = join(socketDir, "controller.token");
    const token = resumeDir ? readFileSync(tokenFile, "utf8").trim() : randomBytes(48).toString("hex");
    if (!resumeDir) writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const controllerConfig: ControllerConfig = {
      socket: join(socketDir, "controller.sock"),
      token,
      appVolume: app,
      stateVolume: state,
      cacheVolume: cache,
      containerState: state,
      containerCache: cache,
      image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
    };
    let controller: SandboxController | undefined;
    let server: ReturnType<typeof createControllerServer> | undefined;
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    let completed = false;
    try {
      const securityOptions = JSON.parse(
        execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8" }),
      ) as string[];
      assert.ok(
        securityOptions.some((option) => /(^|=)rootless$/.test(option)),
        "Real Pi requires rootless Docker",
      );
      execFileSync("docker", ["image", "inspect", controllerConfig.image, "--format", "{{.Id}}"], {
        encoding: "utf8",
      });
      const repo = join(scoped, "base");
      const story = join(repo, "story");
      if (!resumeDir) {
        mkdirSync(join(story, "creative-direction"), { recursive: true });
        writeFileSync(
          join(story, "creative-direction/foundation.md"),
          `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A vanished witness"
status: draft
decisions:
  - id: author-choice
    statement: "The player must be able to protect or challenge the archivist's friend"
    origin: user
    authority: user-protected
premise: "A witness vanishes and the archive ledger appears to conceal evidence"
central_conflict: "Protect a friendship or confront concealment"
genre: "Mystery"
tone: "Intimate, uneasy"
player_experience: "Dialogue-led investigative decisions plus a mandatory fair ledger-evidence Puzzle with two discoverable clues and two solution Events"
scope: "Two central Characters, one reusable archive location"
---

Ada suspects Neri has concealed the ledger record that could explain the witness's disappearance. A consequential loyalty decision must remain open to the player. The author also requires an independent evidence-verification Puzzle: let the player inspect a ledger watermark and a custodian's seal as accessible clues, then solve it by decoding the ledger or obtaining a custodian's testimony. Neither clue may be locked behind its own solution.
`,
        );
        git(repo, "init", "-q");
        git(repo, "config", "user.name", "Author");
        git(repo, "config", "user.email", "author@example.test");
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "Author's protected Creative Direction");
      }
      const originalHead = git(repo, "rev-parse", "HEAD");
      if (!resumeDir) {
        const db = new DatabaseSync(join(app, "studio.sqlite"));
        try {
          db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
        CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
        CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
          db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run(
            "repo-id",
            owner,
            "github",
            providerRepo,
          );
          db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story-id", owner, "repo-id", "story");
          db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
            jobId,
            owner,
            "story-id",
            originalHead,
            null,
          );
        } finally {
          db.close();
        }
      }
      controller = new SandboxController(controllerConfig);
      server = createControllerServer(controller);
      server.listen(controllerConfig.socket);
      await once(server, "listening");
      const env = {
        ...process.env,
        NT_STATE_DIR: state,
        NT_CONFIG_FILE: join(temp, "missing-config.json"),
        NT_SKILL_CACHE_DIR: join(temp, "skills"),
        NT_GIT_CACHE_DIR: scoped,
        NT_SANDBOX_SOCKET: controllerConfig.socket,
        NT_SANDBOX_TOKEN_FILE: tokenFile,
        NT_REQUIRE_SANDBOX_TOOLS: "1",
      };
      async function cli(...args: string[]) {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", resolve("src/cli.ts"), "job", ...args, "--story", story, "--job", jobId],
          {
            cwd: resolve("."),
            env,
            timeout: 1_000_000,
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
      }
      const job = await cli("start");
      const contract = join(temp, "contract.json");
      writeFileSync(
        contract,
        JSON.stringify({
          scope: {
            kind: "partial",
            depth: "interactive",
            targets: ["arc.truth", "milestone.disclosure"],
            branches: ["trust-route", "challenge-route"],
          },
          constraints: [
            "Preserve the explicit player choice to protect or confront Neri",
            "Also author a fair ledger evidence Puzzle with independently reachable watermark and custodian-seal clues and distinct decoding/testimony solution Events",
          ],
          envelope: {
            presentation: "Dialogue-led visual novel",
            hardLimits: ["Reuse the archive location"],
            preferences: ["Two Character leads", "No new engine Rooms"],
          },
        }),
      );
      const liveArchitecture = process.env.NT_LIVE_ARCHITECTURE_ONLY === "1";
      const archArgs = [
        "architecture", "run", ...(liveArchitecture ? [] : ["--fixture"]),
        "--skills-source", source, "--contract", contract,
      ];
      if (liveArchitecture && process.env.NT_PROVIDER) archArgs.push("--provider", process.env.NT_PROVIDER);
      if (liveArchitecture && process.env.NT_MODEL) archArgs.push("--model", process.env.NT_MODEL);
      const architecture = await cli(...archArgs);
      assert.equal(architecture.status, "architecture-committed");
      if (liveArchitecture) {
        const milestones = readdirSync(join(job.worktreeStoryRoot, "milestones"));
        assert.ok(milestones.length > 0, "Live Architecture must author a Milestone");
        for (const file of milestones) {
          const content = readFileSync(join(job.worktreeStoryRoot, "milestones", file), "utf8");
          assert.match(content, /completeness: partial/);
          assert.match(content, /fulfillment:\s*(?:\{any_of: \[\]\}|any_of: \[\])/);
        }
        assert.equal(existsSync(join(job.worktreeStoryRoot, "events")), false,
          "Architecture must leave Event authoring to the later specialist");
        assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
        assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
        assert.ok(architecture.skillReads?.length === 5);
        completed = true;
        return;
      }
      assert.equal(
        (await cli("foundations", "run", "--fixture", "--skills-source", source)).status,
        "foundations-committed",
      );
      const realEvent = process.env.NT_LIVE_EVENT_CHOICE === "1";
      const eventArgs = [
        "event",
        "run",
        ...(realEvent ? [] : ["--fixture"]),
        "--milestone",
        "milestone.disclosure",
        "--skills-source",
        source,
      ];
      if (realEvent && process.env.NT_PROVIDER) eventArgs.push("--provider", process.env.NT_PROVIDER);
      if (realEvent && process.env.NT_MODEL) eventArgs.push("--model", process.env.NT_MODEL);
      const event = await cli(...eventArgs);
      assert.equal(event.status, "event-cluster-committed");
      if (realEvent) {
        assert.equal(
          event.validation.milestoneState,
          "partial-choice-pending",
          "A live Event must not fulfill the player's still-unbound decision",
        );
        assert.ok(event.obligations.some((obligation: string) => /choice/i.test(obligation)));
        assert.equal(event.skillReads.length, 5);
      }
      // The Event CLI pins its default thinking profile; requesting a new one
      // at Choice would violate the saved model-resolution contract.
      const thinking = realEvent ? undefined : process.env.NT_THINKING;
      const args = ["interactive", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
      if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
      if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
      if (["low", "medium", "high"].includes(thinking ?? "")) args.push("--thinking", thinking!);
      const result = await cli(...args);
      if (["low", "medium", "high"].includes(thinking ?? "")) assert.equal(result.thinking, thinking);
      assert.equal(result.status, "interactive-slice-committed");
      assert.deepEqual(
        result.specialistUnits.map((u: any) => u.phase),
        ["committed", "committed"],
      );
      assert.equal(result.specialistUnits[0].validation.protectionBase, event.headSha);
      if (realEvent) {
        assert.equal(result.eventSource.headSha, event.headSha);
        assert.equal(result.eventSource.milestoneState, "partial-choice-pending");
        assert.equal(result.milestoneState, "choice-bound-milestone-awaiting-authorized-closeout");
        const milestone = readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");
        assert.match(milestone, /completeness: partial/);
        assert.match(milestone, /fulfillment: \{any_of: \[\]\}/);
      }
      assert.equal(result.specialistUnits[1].validation.protectionBase, result.specialistUnits[0].commitSha);
      for (const unit of result.specialistUnits) {
        assert.equal(unit.skillReads.length, 5);
        assert.match(unit.commitSha, /^[0-9a-f]{40}$/);
        const messages = readFileSync(unit.piSessionFile, "utf8").trim().split("\n").map(JSON.parse);
        if (["low", "medium", "high"].includes(thinking ?? "")) {
          assert.ok(
            messages.some(
              (m: any) => m.message?.role === "assistant" && m.message?.thinkingLevel === thinking,
            ),
            "Pi assistant messages must confirm requested thinking effort",
          );
        }
        const calls = messages
          .flatMap((m: any) => m.message?.content ?? [])
          .filter((c: any) => c.type === "toolCall");
        const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
        const snapshotRoot = unit.skillReads[0].slice(0, unit.skillReads[0].lastIndexOf("/skills/"));
        const canonicalReads = reads.map((p: string) =>
          canonicalPinnedReadPath(p, job.worktreeStoryRoot, snapshotRoot));
        assert.ok(unit.skillReads.every((p: string) => canonicalReads.includes(p)),
          "All immutable pinned sources must have successful exact read-tool evidence");
        assert.ok(calls.some((c: any) => ["write", "edit"].includes(c.name)));
      }
      assert.ok(result.specialistUnits[0].validation.choices.length > 0);
      assert.ok(result.specialistUnits[1].validation.puzzles.length > 0);
      assert.ok(result.specialistUnits[1].validation.puzzles[0].solutions.length >= 2);
      assert.ok(
        result.specialistUnits[1].validation.puzzles[0].solutions.every(
          (s: any) => s.status === "reachable" && s.clueAccess === "reachable",
        ),
      );
      const catalog = await cli("validate");
      assert.equal(catalog.status, "passed");
      assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), result.headSha);
      assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
      if (process.env.NT_LIVE_INTERACTIVE_REVIEW === "1") {
        // Independent, read-only Pi review of the Event→Choice handoff only.
        // Puzzle fairness, Milestone closeout and composition are separately
        // reviewed under their own authority, not this bounded assignment.
        const choice = result.specialistUnits[0];
        const paths = [
          ...new Set([
            "creative-direction/foundation.md",
            "milestones/disclosure.md",
            "relationships/ada-neri.md",
            "facts/evidence-concealed.md",
            "characters/ada.md",
            "characters/neri.md",
            ...(event.paths ?? []),
            ...(choice.paths ?? []),
          ]),
        ] as string[];
        const assignment: ReviewAssignment = {
          contract: {
            kind: "partial",
            depth: "interactive",
            constraints: [
              "Preserve the protected author Choice and implement its genuine outcome effects",
              "The Choice writer may bind outcomes/effects within the original Event steps while preserving the original Event prerequisites verbatim",
              "Never elevate the partial Milestone without separate authorization",
            ],
          },
          planVersion: event.planVersion,
          scopeIds: ["milestone.disclosure"],
          paths,
          routes: choice.validation.choices.flatMap((item: any) =>
            item.outcomes.map((outcome: any) => ({
              event: outcome.event,
              step: outcome.step,
              branch: outcome.branch,
              status: "reachable",
              witness: [],
            })),
          ),
          milestoneRoutes: [],
          puzzleRoutes: [],
          outstanding: [...(event.obligations ?? []), ...(choice.obligations ?? [])].map(
            (message: string, index: number) => ({ id: "obligation-" + index, message }),
          ),
          uncertainties: [
            "Milestone completion and final Authored Content are separately authorized downstream work",
          ],
          turnGoal:
            "This is the POST-CHOICE checkpoint, NOT the earlier source-pinned Event-only checkpoint (reviewed separately). The later Choice writer is authorized to bind its outcomes and real effects in previously committed Event steps, including the original setup Event; this does NOT authorize edits to original Event prerequisites. Empty conditions on parallel branches represent selectable alternatives, not simultaneous execution. Inspect meaningful branch-specific effects and later consumers. The separately authored Puzzle, Milestone closeout, and final composition are OUTSIDE this checkpoint; keep the Milestone partial. Report unsupported causal or relationship changes, but do not fail merely because the authorized Choice unit modified an existing Event record.",
        };
        const envKeys = [
          "NT_STATE_DIR",
          "NT_GIT_CACHE_DIR",
          "NT_SKILL_CACHE_DIR",
          "NT_SANDBOX_SOCKET",
          "NT_SANDBOX_TOKEN_FILE",
          "NT_REQUIRE_SANDBOX_TOOLS",
          "NT_CONFIG_FILE",
        ];
        const previous = envKeys.map((key) => process.env[key]);
        try {
          for (const key of envKeys) process.env[key] = env[key]!;
          const reviewerSnapshot = await createSkillSnapshot({
            discovery: "explicit-only",
            novelteaSkills: source,
            skillDirs: [],
            requiredSkills: ["nt-narrative-review", "nt-catalog"],
          });
          assert.ok(reviewerSnapshot);
          const reviewJob = await startStoryJob({ story, job: jobId }, false);
          if (process.env.NT_LIVE_ASSIGNMENT_REVIEW === "1") {
            // This packet is built from the actual validated Event commit, not the
            // newer Choice/Puzzle worktree. Only the current Event's assignment
            // may be judged; missing later units are not source defects.
            const changed = event.paths as string[];
            const eventContext = await loadSealedReviewContext(reviewJob, event.headSha, changed);
            const eventItem = {
              reviewedWorkItem: "event-disclosure",
              unitOutcome: semanticUnitOutcome("event-disclosure"),
              assignment: {
                id: "event-disclosure", specialist: "nt-event-design",
                outcome: "Author a reachable source-grounded Event setup without enacting or " +
                  "binding the protected later player Choice; keep the Milestone partial.",
                targets: ["milestone.disclosure"], dependsOn: [],
                discovery: "canonical-story-read-only" as const,
                authority: { recordTypes: ["event"], existingPaths: [], mayCreate: true },
              },
              assurance: {
                commitSha: event.headSha, parentSha: event.validation.protectionBase,
                changedPaths: changed,
              },
              diff: git(job.worktreeRoot, "diff", "--no-ext-diff", event.validation.protectionBase,
                event.headSha, "--", ...changed.map((p) => "story/" + p)),
              canonicalContext: eventContext,
              readOnlyPaths: eventContext.map((r) => r.path).filter((p) => !changed.includes(p)),
              repairTargets: changed,
            };
            const items = [eventItem];
            const packet: SemanticReviewPacket = {
              policy: "assignment-fidelity/v1",
              sourceDigest: sha(JSON.stringify({ policy: "assignment-fidelity/v1", items })),
              items,
            } as unknown as SemanticReviewPacket;
            const semantic = await withStoryJobLock(reviewJob, "independent-assignment-review", () =>
              reviewSpecialistAssignments(reviewJob, reviewerSnapshot, packet,
                process.env.NT_PROVIDER ?? "openai", process.env.NT_MODEL ?? "gpt-6-luna",
                undefined, async () => {}));
            process.stderr.write("LIVE_EVENT_ASSIGNMENT_REVIEW " + JSON.stringify(semantic) + "\n");
            assert.equal(semantic.verdict, "pass", JSON.stringify(semantic.findings));
          }
          const reviewer = await withStoryJobLock(reviewJob, "independent-narrative-review", () =>
            reviewNarrative(
              reviewJob,
              reviewerSnapshot,
              assignment,
              process.env.NT_PROVIDER ?? "openai",
              process.env.NT_MODEL ?? "gpt-6-luna",
              undefined,
              async () => {},
            ),
          );
          process.stderr.write("LIVE_EVENT_CHOICE_REVIEW " + JSON.stringify(reviewer) + "\n");
          if (process.env.NT_LIVE_EXPECT_REVIEW_BLOCK === "1") {
            // Opt-in negative replay from an existing checkpoint with a
            // documented premature relationship effect. A source-backed
            // BLOCK is the correct independent review behavior, not failure
            // of the prompt-composition / reviewer-isolation contract.
            assert.equal(reviewer.verdict, "block", "The known source defect must remain blocking");
            assert.ok(reviewer.findings.some((f) => f.severity === "blocking" &&
              ["continuity", "characterization", "player-agency", "conditional-knowledge"].includes(f.dimension) &&
              /events\//.test(f.source) &&
              /relationship|premature|effect|choice/i.test(f.message)),
            "Negative Luna reviewer must cite the exact causal defect, not an unrelated objection");
          } else {
            assert.equal(reviewer.verdict, "pass", JSON.stringify(reviewer.findings));
          }
        } finally {
          envKeys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
          });
        }
        assert.equal(
          git(job.worktreeRoot, "status", "--porcelain"),
          "",
          "Independent reviewer must never author Story files",
        );
      }
      completed = true;
    } finally {
      if (controller) controller.dispose(jobId);
      if (server) await new Promise<void>((done) => server!.close(() => done()));
      if (
        process.env.NT_KEEP_LIVE_EVIDENCE === "1" ||
        (!completed && process.env.NT_KEEP_FAILED_LIVE === "1")
      ) {
        process.stderr.write("Preserved interactive Pi Story job evidence: " + temp + "\n");
      } else {
        removeTestTree(temp);
      }
    }
  },
);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { verifiedWorldReviewHandoff } from "../src/character-world.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import type { JobStartResult } from "../src/job.js";
import { removeTestTree } from "./helpers.js";

/** Source-bound reproduction of the genuine #158 Collaborative failure.
 * Never mutate the original Job or replay the blocked Character writer.
 * Tests only the controller's immutable proof and safe admission decision. */
test(
  "reviewed World repair is the only valid Character handoff",
  {
    skip:
      !process.env.NT_TEST_172_STATE && "Set NT_TEST_172_STATE to the preserved Collaborative #158 job state",
  },
  async (t) => {
    const root = process.env.NT_TEST_172_STATE!;
    const job = JSON.parse(readFileSync(join(root, "job.json"), "utf8")) as JobStartResult;
    assert.equal(job.stateDir, root, "Test must use the preserved state, not infer its identity.");
    const receipt = JSON.parse(readFileSync(join(root, "character-world.json"), "utf8")) as {
      units: Array<{ id: string; phase: string; commitSha?: string; beforeHead?: string }>;
    };
    const world = receipt.units[0]!,
      character = receipt.units[1]!;
    assert.equal(world.phase, "committed");
    assert.equal(character.phase, "pending");
    assert.equal(character.beforeHead, undefined);
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const head = git("rev-parse", "HEAD");
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("rev-parse", "HEAD^"), world.commitSha);
    assert.equal(await verifiedWorldReviewHandoff(job, world.commitSha!, head), head);
    const points = await inspectRecoveryCheckpoints(job);
    const originalWorld = points.find((point) => point.commitSha === world.commitSha);
    const correctedWorld = points.find((point) => point.commitSha === head);
    assert.equal(originalWorld?.eligible, true);
    assert.equal(
      originalWorld?.semanticReview,
      "failed",
      "Immutable failed World review is never rewritten as passed.",
    );
    assert.equal(correctedWorld?.eligible, true);
    assert.equal(correctedWorld?.semanticReview, "passed");
    assert.ok(correctedWorld?.completedWorkItems.includes("world-foundations"));
    assert.ok(
      !correctedWorld?.completedWorkItems.includes("character-foundations"),
      "The correction cannot manufacture completed Character work.",
    );
    assert.ok(correctedWorld?.remainingWorkItems.includes("character-foundations"));
    // Exercise the actual public CLI admission path: unlike the historical
    // blocked run, Character is now inspectable as ready at its exact reviewed
    // correction parent, without invoking the real Pi writer.
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "job",
        "foundations",
        "inspect",
        "--story",
        job.storyRoot,
        "--job",
        job.jobId,
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          NT_STATE_DIR: dirname(dirname(root)),
          NT_NATIVE_CLI:
            process.env.NT_NATIVE_CLI ?? join(process.env.HOME ?? "", "dev/nt/build/cli/linux/noveltea"),
        },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const inspected = JSON.parse(cli.stdout) as {
      headSha: string;
      recovery: { status: string; characterBeforeHead?: string };
      items: Array<{
        domain: string;
        commitSha?: string;
        phase: string;
      }>;
    };
    assert.equal(inspected.recovery.status, "ready");
    assert.equal(inspected.headSha, head);
    assert.equal(inspected.recovery.characterBeforeHead, head);
    assert.equal(
      inspected.items[0]?.commitSha,
      world.commitSha,
      "The original rejected World author commit must not be relabeled.",
    );
    assert.equal(inspected.items[1]?.phase, "pending");
    assert.deepEqual(
      receipt.units,
      JSON.parse(readFileSync(join(root, "character-world.json"), "utf8")).units,
      "Verification must not mutate the original saved writer receipt.",
    );
    t.diagnostic("Verified World correction handoff: " + world.commitSha + " -> " + head);

    const copy = mkdtempSync(join(tmpdir(), "nt172-reviewed-handoff-"));
    t.after(() => removeTestTree(copy));
    const makeCopy = () => {
      const sub = join(copy, String(Math.random()).slice(2));
      cpSync(root, sub, { recursive: true });
      return { ...job, stateDir: sub };
    };
    const repair = head;
    // Simulate a process restart against a PRIVATE copy of the durable
    // controller state, preserving the original Git worktree as read-only.
    const shadowStore = join(copy, "shadow");
    const shadowRoot = join(shadowStore, "jobs", basename(root));
    cpSync(root, shadowRoot, { recursive: true });
    const shadowManifestFile = join(shadowRoot, "job.json");
    const shadowManifest = JSON.parse(readFileSync(shadowManifestFile, "utf8"));
    writeFileSync(shadowManifestFile, JSON.stringify({ ...shadowManifest, stateDir: shadowRoot }));
    const shadowReceiptFile = join(shadowRoot, "character-world.json");
    const shadowReceipt = JSON.parse(readFileSync(shadowReceiptFile, "utf8"));
    shadowReceipt.units[1].beforeHead = head;
    writeFileSync(shadowReceiptFile, JSON.stringify(shadowReceipt));
    const restart = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/cli.ts"),
          "job",
          "foundations",
          "inspect",
          "--story",
          job.storyRoot,
          "--job",
          job.jobId,
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            NT_STATE_DIR: shadowStore,
            NT_NATIVE_CLI:
              process.env.NT_NATIVE_CLI ?? join(process.env.HOME ?? "", "dev/nt/build/cli/linux/noveltea"),
          },
        },
      );
    for (let i = 0; i < 2; i++) {
      const resumed = restart();
      assert.equal(resumed.status, 0, resumed.stderr);
      const body = JSON.parse(resumed.stdout);
      assert.equal(body.recovery.status, "ready");
      assert.equal(body.recovery.characterBeforeHead, repair);
      assert.equal(body.items[0].commitSha, world.commitSha);
      assert.equal(body.items[1].beforeHead, repair);
    }
    assert.equal(
      git("rev-parse", "HEAD"),
      repair,
      "Two inspections cannot replay either writer or publish an extra commit",
    );
    shadowReceipt.units[1].beforeHead = "f".repeat(40);
    writeFileSync(shadowReceiptFile, JSON.stringify(shadowReceipt));
    const forgedParent = restart();
    if (forgedParent.status === 0) {
      assert.equal(JSON.parse(forgedParent.stdout).recovery.status, "blocked");
    } else assert.match(forgedParent.stderr, /head|correction|commit|branch|verified|checkpoint/i);
    async function expectTamper(mutator: (copy: JobStartResult) => void, message: RegExp) {
      const copied = makeCopy();
      mutator(copied);
      await assert.rejects(verifiedWorldReviewHandoff(copied, world.commitSha!, repair), message);
    }
    await expectTamper((copy) => {
      const file = join(copy.stateDir, "independent-reviews", repair + ".json");
      const proof = JSON.parse(readFileSync(file, "utf8"));
      proof.status = "failed";
      proof.findings = [
        {
          path: "world-entities/overnight-train.md",
          message: "This is no longer a passing independently reviewed source",
        },
      ];
      writeFileSync(file, JSON.stringify(proof));
    }, /review|verified|pass|lineage|source/i);
    await expectTamper((copy) => {
      const file = join(copy.stateDir, "recovery-checkpoints", repair + ".json");
      const point = JSON.parse(readFileSync(file, "utf8"));
      point.planDigest = "f".repeat(64);
      writeFileSync(file, JSON.stringify(point));
    }, /repair|lineage|verified|checkpoint/i);
    await expectTamper((copy) => {
      const file = join(copy.stateDir, "review-repairs", "proofs", world.commitSha + ".json");
      const proof = JSON.parse(readFileSync(file, "utf8"));
      proof.paths = ["creative-direction/foundation.md"];
      writeFileSync(file, JSON.stringify(proof));
    }, /repair|source|original|provenance/i);
    await assert.rejects(
      verifiedWorldReviewHandoff(
        {
          ...job,
          threadId: "root:foreign-thread",
        },
        world.commitSha!,
        repair,
      ),
      /repair|lineage|verified|source|identity|review|checkpoint/i,
    );
    await assert.rejects(
      verifiedWorldReviewHandoff(job, world.commitSha!, "f".repeat(40)),
      /branch|commit|verified|Git/i,
    );
    // A copied historical receipt with a different logical owner cannot
    // inherit either the source review or the verified correction.
    await assert.rejects(
      verifiedWorldReviewHandoff(
        {
          ...job,
          jobId: "other-job",
        },
        world.commitSha!,
        repair,
      ),
      /review|checkpoint|repair|lineage|verified/i,
    );
  },
);

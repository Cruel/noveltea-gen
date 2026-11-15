/** Opt-in, read-only real Luna replay of a preserved authored Event conflict.
 * This evaluates a bounded repair plan; it cannot certify a Story or replay
 * the original interrupted writer. The protected private Job is untouched. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { parseEventManifest, scopedEventEvidenceConflict } from "../src/event-specialist.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
test(
  "preserved authored Event evidence gap is locally owned and Luna proposes a bounded source-aware correction",
  {
    skip:
      process.env.NT_LIVE_EVENT_EVIDENCE !== "1"
        ? "Opt in with NT_LIVE_EVENT_EVIDENCE=1 and NT_PRESERVED_EVENT_SOURCE."
        : false,
    timeout: 145_000,
  },
  () => {
    const root = resolve(process.env.NT_PRESERVED_EVENT_SOURCE ?? "");
    assert.match(
      root,
      /^\/tmp\/nt158-[a-zA-Z0-9-]+$/,
      "Only a disposable private certification source is permitted.",
    );
    const jobs = readdirSync(join(root, "state", "jobs"));
    assert.equal(jobs.length, 1);
    const state = join(root, "state", "jobs", jobs[0]!);
    const job = JSON.parse(readFileSync(join(state, "job.json"), "utf8")) as JobStartResult;
    assert.equal(job.stateDir, state);
    const path = join(state, "event-items", "disappearance-established.json");
    const stored = readFileSync(path, "utf8");
    const receipt = JSON.parse(stored) as {
      phase: string;
      expectedHead: string;
      sessionFile: string;
      assignment: { milestoneId: string; milestonePath: string; characterIds: string[]; arcIds: string[] };
    };
    assert.equal(receipt.phase, "writing");
    assert.equal(receipt.assignment.milestoneId, "milestone.disappearance-established");
    assert.equal(realpathSync(receipt.sessionFile), receipt.sessionFile);
    assert.ok(receipt.sessionFile.startsWith(state + "/event-sessions/"));
    assert.ok(statSync(receipt.sessionFile).size > 0);
    const originalSession = readFileSync(receipt.sessionFile, "utf8");
    const rows = originalSession
      .trim()
      .split("\n")
      .map(
        (text) =>
          JSON.parse(text) as {
            message?: { role?: string; content?: Array<{ type: string; text?: string; name?: string }> };
          },
      );
    const manifests = rows
      .filter((row) => row.message?.role === "assistant")
      .flatMap(
        (row) =>
          row.message?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "") ??
          [],
      )
      .flatMap((text) => {
        try {
          return [parseEventManifest(text)];
        } catch {
          return [];
        }
      });
    const last = manifests.at(-1);
    assert.ok(last?.modifiedRecords.includes("events/disappearance-established.md"));
    assert.ok(
      scopedEventEvidenceConflict(receipt.assignment, last.architecturalConflicts),
      "Original authored in-scope access evidence deficit must be recognized without granting upstream work.",
    );
    const milestoneFile = join(job.worktreeStoryRoot, receipt.assignment.milestonePath);
    const eventFile = join(job.worktreeStoryRoot, "events/disappearance-established.md");
    const originalMilestone = readFileSync(milestoneFile, "utf8");
    const originalEvent = readFileSync(eventFile, "utf8");
    assert.match(originalMilestone, /accessible during the relevant interval/i);
    assert.match(originalEvent, /No physical trace, witness statement about an earlier interval/i);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    };
    const originalHead = git("rev-parse", "HEAD");
    const originalStatus = git("status", "--porcelain=v1", "--untracked-files=all");
    assert.equal(originalHead, receipt.expectedHead);
    assert.equal(originalStatus, "?? story/events/disappearance-established.md");
    const proof = sha256([stored, originalSession, originalMilestone, originalEvent].join("\n"));
    const prompt = [
      "READ-ONLY BOUNDED EVENT EVIDENCE REVIEW. Do not call tools or edit any Story file.",
      "Decide whether the selected Event specialist can satisfy the missing access evidence using ONLY the existing named Characters, the already authorized Event scene, and in-scene testimony.",
      "A witness may describe a past observation if explicitly identified, qualified and presented to the player within THIS Event, but cannot assert omniscient past access facts.",
      "A present empty compartment does not prove historical access. Do not presume continuous locks or invent canonical investigations as completed.",
      "This is a nondecision Milestone: it can bind a reachable route only AFTER its material access clause is delivered; otherwise preserve incomplete and explicitly report why.",
      "The original author asked for a mystery game. Do NOT request a new Character/Fact/protected decision if existing participants can credibly provide the needed bounded observation.",
      "Return ONLY one unfenced JSON object with exactly these keys: owner, noNewAuthority, testimony, limitation, milestoneBinding.",
      'Valid shape: {"owner":"event","noNewAuthority":true,"testimony":"An existing named Character describes their own limited firsthand observation IN this Event","limitation":"This is testimony, not omniscient proof of locked access","milestoneBinding":"only-after-evidence"}.',
      "PINNED SOURCES (not proof of past access):",
      JSON.stringify({
        milestone: originalMilestone,
        eventDraft: originalEvent,
        characters: receipt.assignment.characterIds,
        conflict: last.architecturalConflicts,
        sourceHead: receipt.expectedHead,
      }),
    ].join("\n");
    const provider = process.env.NT_PROVIDER ?? "openai";
    const model = process.env.NT_MODEL ?? "gpt-6-luna";
    const run = spawnSync(
      "pi",
      [
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        "low",
        "--no-tools",
        "--no-extensions",
        "--no-session",
        "-p",
        prompt,
      ],
      { encoding: "utf8", timeout: 125_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, (run.stderr || run.stdout).slice(0, 2500));
    const reply = run.stdout
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, "")
      .replace(/\x60\x60\x60\s*$/, "");
    const verdict = JSON.parse(reply) as Record<string, unknown>;
    assert.equal(verdict.owner, "event");
    assert.equal(verdict.noNewAuthority, true);
    assert.equal(verdict.milestoneBinding, "only-after-evidence");
    assert.ok(typeof verdict.testimony === "string" && verdict.testimony.trim().length >= 30);
    assert.ok(typeof verdict.limitation === "string" && verdict.limitation.trim().length >= 20);
    assert.equal(
      sha256(
        [
          readFileSync(path, "utf8"),
          readFileSync(receipt.sessionFile, "utf8"),
          readFileSync(milestoneFile, "utf8"),
          readFileSync(eventFile, "utf8"),
        ].join("\n"),
      ),
      proof,
      "Source-bound replay cannot rewrite the original Story, Pi session or receipt.",
    );
    assert.equal(git("rev-parse", "HEAD"), originalHead);
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), originalStatus);
    console.log(
      "LIVE_EVENT_LOCAL_EVIDENCE_REPLAY",
      JSON.stringify({
        provider,
        model,
        sourceHead: originalHead,
        decision: verdict.owner,
        noNewAuthority: verdict.noNewAuthority,
        milestoneBinding: verdict.milestoneBinding,
        originalSessionDigest: sha256(originalSession),
      }),
    );
  },
);

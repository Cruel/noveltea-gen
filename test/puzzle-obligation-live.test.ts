/** Opt-in real Luna, read-only replay of a preserved no-write Puzzle boundary.
 * It does NOT authorize a no-write receipt or certify a full Story. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseInteractiveManifest } from "../src/interactive-specialist.js";
import { puzzleObligation, puzzleNoWriteSessionDigest } from "../src/puzzle-obligation.js";
import type { JobStartResult } from "../src/job.js";
import type { Plan } from "../src/architecture.js";

test(
  "real Luna interprets original Story objective rather than a deferred Puzzle stage",
  {
    skip:
      process.env.NT_LIVE_PUZZLE_OBLIGATION !== "1"
        ? "Set NT_LIVE_PUZZLE_OBLIGATION=1 and NT_PRESERVED_PUZZLE_SOURCE to a private saved Studio run."
        : false,
    timeout: 140_000,
  },
  async () => {
    const root = resolve(process.env.NT_PRESERVED_PUZZLE_SOURCE ?? "");
    assert.match(
      root,
      /^\/tmp\/nt158-[a-zA-Z0-9-]+$/,
      "Only a disposable, preserved #158 source is allowed.",
    );
    const jobs = readdirSync(join(root, "state/jobs"));
    assert.equal(jobs.length, 1, "A live replay requires exactly one saved source-bound Job.");
    const state = join(root, "state/jobs", jobs[0]!);
    const turn = JSON.parse(readFileSync(join(state, "turn-plan.json"), "utf8")) as {
      originalRequest: string;
      objective: { obligations: string[] };
      contract: { constraints: string[] };
      source: { verifiedSha: string };
    };
    const candidates = readdirSync(join(state, "interactive-items")).filter((name) => name.endsWith(".json"));
    const match = candidates
      .map((file) => ({
        file,
        saved: JSON.parse(readFileSync(join(state, "interactive-items", file), "utf8")) as {
          units: Array<{
            phase: string;
            domain: string;
            piSessionFile?: string;
            commitSha?: string;
            paths?: string[];
          }>;
        },
      }))
      .find(
        (candidate) =>
          candidate.saved.units[0]?.phase === "committed" &&
          candidate.saved.units[1]?.domain === "puzzle" &&
          candidate.saved.units[1].piSessionFile,
      );
    assert.ok(match, "Preserved live Choice/Puzzle checkpoint is missing.");
    const puzzle = match.saved.units[1]!;
    assert.ok(puzzle.piSessionFile && existsSync(puzzle.piSessionFile));
    const entries = readFileSync(puzzle.piSessionFile, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            message?: {
              role?: string;
              content?: Array<{
                type: string;
                name?: string;
                text?: string;
              }>;
            };
          },
      );
    const reported = entries
      .map((entry) => entry.message)
      .filter((message) => message?.role === "assistant")
      .flatMap(
        (message) =>
          message?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "") ?? [],
      )
      .map((text) => {
        try {
          return parseInteractiveManifest(text, "puzzle");
        } catch {
          return null;
        }
      })
      .filter((value) => value !== null)
      .at(-1);
    assert.ok(
      reported && reported.paths.length === 0 && reported.conflicts.length,
      "Historical real Pi no-write findings were not preserved.",
    );
    const slug = match.file.slice(0, -".json".length);
    const event = JSON.parse(readFileSync(join(state, "event-items", slug + ".json"), "utf8")) as {
      obligations?: string[];
    };
    // Re-evaluate the real immutable author Turn and real Event handoff with
    // the controller decision, not merely a model's advisory classification.
    const job = JSON.parse(readFileSync(join(state, "job.json"), "utf8")) as JobStartResult;
    const choice = match.saved.units[0]!;
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(git("status", "--porcelain"), "", "A no-write must leave the original Story clean.");
    assert.equal(
      git("rev-parse", "HEAD"),
      choice.commitSha,
      "A no-write cannot silently publish a Puzzle or unrelated Story commit.",
    );
    assert.ok(
      puzzleNoWriteSessionDigest(job, "interactive-puzzle-" + slug, puzzle.piSessionFile!),
      "Controller can verify the original full Pi session bytes at its owned path.",
    );
    assert.equal(
      entries
        .flatMap((entry) => entry.message?.content ?? [])
        .filter((item) => item.type === "toolCall" && (item.name === "write" || item.name === "edit")).length,
      0,
      "A model that wrote then reverted a Puzzle cannot claim a genuine no-write.",
    );
    const architecture = JSON.parse(readFileSync(join(state, "architecture.json"), "utf8")) as {
      plan: Plan;
    };
    const obligation = await puzzleObligation(job, architecture.plan, [], [], event.obligations ?? []);
    assert.equal(
      obligation.required,
      false,
      "The original Turn must not inherit a mandatory Puzzle from a deferred Event handoff: " +
        JSON.stringify(obligation.reasons),
    );
    assert.ok(obligation.turnDigest);
    const prompt = [
      "You are a READ-ONLY narrative obligation assessor. Do not create a Story, ask for tools or change a file.",
      "Decide whether the ORIGINAL AUTHOR and approved controller promises explicitly require a formal Puzzle with separate solution Events.",
      "An Event specialist's generic 'Puzzle implementation remains deferred' is a stage handoff, NOT an author-approved Puzzle request.",
      "A mystery game's fair-play clues and consequential choices remain binding story-delivery requirements even when a formal Puzzle is optional.",
      "Do not confuse an optional-Puzzle decision with full Story completion; final prose, endings and independent review remain necessary.",
      "Report whether the source-bound author objective demands a formal Puzzle by returning EXACTLY three arrays of strings.",
      "Output ONE unfenced JSON object with only these keys IN THIS ORDER: modifiedRecords, architecturalConflicts, laterObligations. No additional fields.",
      "For a supported optional no-write, do not use the authored-work example with architecturalConflicts: []. Instead use this exact three-array shape with source-specific text:",
      '{"modifiedRecords":[],"architecturalConflicts":["The verified sources do not establish one formal Puzzle objective with two independently justified solution Events"],"laterObligations":["Preserve fair clues and consequential choices","Compose distinct playable endings and seek independent editorial review"]}.',
      "An empty architecturalConflicts array is INVALID when modifiedRecords is empty. Each finding must name the absent specific source obligation. Do not fabricate two solution Events.",
      "PINNED SOURCE:",
      JSON.stringify({
        authorRequest: turn.originalRequest,
        approvedObligations: turn.objective.obligations,
        authorConstraints: turn.contract.constraints,
        verifiedEventHandoffs: event.obligations ?? [],
        originalPuzzleNegativeFindings: reported.conflicts,
        originalChoiceCommitted: !!match.saved.units[0].commitSha,
        sourceSha: turn.source.verifiedSha,
      }),
    ].join("\n");
    const provider = process.env.NT_PROVIDER ?? "openai",
      model = process.env.NT_MODEL ?? "gpt-6-luna";
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
      { encoding: "utf8", timeout: 125_000, maxBuffer: 3 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, (run.stderr || run.stdout).slice(0, 2000));
    const reply = run.stdout
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    const verdict = JSON.parse(reply) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(verdict),
      ["modifiedRecords", "architecturalConflicts", "laterObligations"],
      "Luna must return the exact controller-parseable manifest envelope.",
    );
    const noWrite = parseInteractiveManifest(reply, "puzzle");
    assert.deepEqual(noWrite.paths, [], "Luna must not manufacture a Puzzle solution manifest");
    assert.ok(
      noWrite.conflicts.length > 0 && noWrite.obligations.length >= 2,
      "Luna must retain concrete negative findings and downstream Story obligations.",
    );
    assert.ok(
      noWrite.obligations.some((value) => /ending|consequence|branch/i.test(value)) &&
        noWrite.obligations.some((value) => /clue|fair|review/i.test(value)),
      "Model cannot erase fair-play clues, consequential endings or independent review obligations.",
    );
    console.log(
      "LIVE_OPTIONAL_PUZZLE_OBLIGATION",
      JSON.stringify({
        provider,
        model,
        sourceSha: turn.source.verifiedSha,
        decision: "not-applicable",
        requirementsRetained: noWrite.obligations.length,
        negativeFindings: noWrite.conflicts.length,
        choiceHead: choice.commitSha,
      }),
    );
  },
);

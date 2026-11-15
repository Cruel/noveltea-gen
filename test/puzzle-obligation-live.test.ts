/** Opt-in real Luna, read-only replay of a preserved no-write Puzzle boundary.
 * It does NOT authorize a no-write receipt or certify a full Story. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseInteractiveManifest } from "../src/interactive-specialist.js";

test(
  "real Luna interprets original Story objective rather than a deferred Puzzle stage",
  {
    skip:
      process.env.NT_LIVE_PUZZLE_OBLIGATION !== "1"
        ? "Set NT_LIVE_PUZZLE_OBLIGATION=1 and NT_PRESERVED_PUZZLE_SOURCE to a private saved Studio run."
        : false,
    timeout: 140_000,
  },
  () => {
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
    const prompt = [
      "You are a READ-ONLY narrative obligation assessor. Do not create a Story, ask for tools or change a file.",
      "Decide whether the ORIGINAL AUTHOR and approved controller promises explicitly require a formal Puzzle with separate solution Events.",
      "An Event specialist's generic 'Puzzle implementation remains deferred' is a stage handoff, NOT an author-approved Puzzle request.",
      "A mystery game's fair-play clues and consequential choices remain binding story-delivery requirements even when a formal Puzzle is optional.",
      "Do not confuse an optional-Puzzle decision with full Story completion; final prose, endings and independent review remain necessary.",
      "Output a single unfenced JSON object with exactly {formalPuzzleRequired:boolean,reason:string,remainingStoryRequirements:string[]}.",
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
    const verdict = JSON.parse(reply) as {
      formalPuzzleRequired: boolean;
      reason: string;
      remainingStoryRequirements: string[];
    };
    assert.equal(verdict.formalPuzzleRequired, false, verdict.reason);
    assert.ok(
      Array.isArray(verdict.remainingStoryRequirements) && verdict.remainingStoryRequirements.length >= 2,
      "Model cannot erase endings, clue continuity or independent review requirements.",
    );
    console.log(
      "LIVE_OPTIONAL_PUZZLE_OBLIGATION",
      JSON.stringify({
        provider,
        model,
        sourceSha: turn.source.verifiedSha,
        decision: "not-applicable",
        requirementsRetained: verdict.remainingStoryRequirements.length,
      }),
    );
  },
);

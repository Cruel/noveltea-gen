import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { removeTestTree } from "./helpers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { runFoundationJob } from "../src/foundation.js";
import { readChatApprovedFoundation, pinChatApprovedFoundation } from "../src/chat-approved-foundation.js";
import { pinReusedFoundation, readReusedFoundation } from "../src/chat-reused-foundation.js";
import { reusableExistingFoundation } from "../src/foundation-readiness.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { renderFoundation, type FoundationDraft } from "../src/foundation-record.js";
import { nativeStoryMetrics } from '../src/story-metrics.js';
import { trustedHead } from "../src/revision.js";
import { validateStoryJob, nativeExecutable } from "../src/validator.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
const nativeAvailable = existsSync(nativeExecutable());
(nativeAvailable ? test : test.skip)("approved Chat Creative Direction commits exactly once without a second Pi writer", {
  timeout: 100_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-approved-commit-"));
  const previous = {
    state: process.env.NT_STATE_DIR, cache: process.env.NT_SKILL_CACHE_DIR,
    config: process.env.NT_CONFIG_FILE,
  };
  try {
    const repo = join(root, "repo"), story = join(repo, "story");
    const skillRepo = join(root, "noveltea-skills");
    mkdirSync(story, { recursive: true });
    mkdirSync(skillRepo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "config", "user.name", "Original Author");
    const placeholder = join(story, "creative-direction", "foundation.md");
    mkdirSync(join(story, "creative-direction"));
    writeFileSync(placeholder, [
      "---", "schema: '0.1'", "type: creative-direction", "id: creative-direction.foundation",
      'title: "Unapproved Story"', "status: draft", "decisions: []",
      'premise: "Pending author discovery"', 'central_conflict: "Pending author discovery"',
      'genre: "Pending author discovery"', 'tone: "Pending author discovery"',
      'player_experience: "Pending author discovery"', 'scope: "Pending author discovery"',
      "---", "", "This is an unreviewed Story initialization draft.", "",
    ].join("\n"));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Pinned unapproved initialization");
    const sourceSha = git(repo, "rev-parse", "HEAD");
    git(skillRepo, "init", "-q");
    for (const name of ["nt-story-discovery", "nt-catalog"])
      mkdirSync(join(skillRepo, "skills", name, "references"), { recursive: true });
    for (const name of ["nt-story-discovery", "nt-catalog"])
      writeFileSync(join(skillRepo, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Pinned ${name}\n---\nTest skills.\n`);
    for (const name of ["records.md", "authority-and-validation.md", "glossary.md"])
      writeFileSync(join(skillRepo, "skills/nt-catalog/references", name), "# Reference\n");
    git(skillRepo, "add", ".");
    git(skillRepo, "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit", "-qm", "Pinned skill checkout");
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ novelteaSkills: skillRepo, skillDiscovery: "explicit-only" }));
    process.env.NT_STATE_DIR = join(root, "state");
    process.env.NT_SKILL_CACHE_DIR = join(root, "skill-cache");
    process.env.NT_CONFIG_FILE = config;
    const job = await startStoryJob({ story, job: "chat-first" });
    const snapshot = await createSkillSnapshot({
      discovery: "explicit-only", novelteaSkills: skillRepo, skillDirs: [],
      requiredSkills: ["nt-story-discovery", "nt-catalog"],
    });
    assert.ok(snapshot);
    const objective = "Only the creative direction for my mystery game";
    const foundation: FoundationDraft = {
      id: "foundation", title: "The Last Bell", premise: "A bell vanishes from an old tower.",
      central_conflict: "The townspeople disagree on who should know the truth.",
      genre: "Mystery", tone: "Uneasy", player_experience: "Interview witnesses and choose whom to trust.",
      scope: "A single coastal town", body: "# The Last Bell\n\nA bell is stolen during a storm.",
      planning: { choice_frequency: 'occasional', choice_impact: 'lasting',
        branching: { depth: 'shallow', route_exclusivity: 'limited' },
        puzzle_emphasis: 'none', pacing: 'narrative-led',
        first_playthrough: { min_minutes: 60, max_minutes: 90 },
        production: { illustrated_backgrounds: { count: { max: 3 }, firmness: 'hard' } } },
      decisions: [
        { id: "author-genre", statement: "Make it a mystery.", origin: "user", authority: "user-protected" },
        { id: "agent-location", statement: "Set it in a coastal town.", origin: "agent", authority: "delegated" },
      ],
    };
    const approval = {
      jobId: job.jobId, sourceSha, firstTurnId: job.jobId,
      scope: "foundation-only" as const,
      originalObjective: objective, proposalDigest: "b".repeat(64),
      skillId: snapshot!.id, foundation,
      creativeMode: "autonomous" as const, provider: "openai", model: "gpt-6-luna",
    };
    await pinChatApprovedFoundation(job, approval);
    await assert.rejects(() => pinChatApprovedFoundation(job,
      { ...approval, originalObjective: "Replace the Story" }), /different approved/);
    const approved = await readChatApprovedFoundation(job);
    assert.equal(approved?.originalObjective, objective);
    const request = { story, job: job.jobId, task: objective, mode: "autonomous" as const,
      envelope: "", provider: "openai", model: "gpt-6-luna", skillsSource: skillRepo };
    const result = await runFoundationJob(request);
    assert.equal(result.status, "committed");
    assert.equal(readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8"),
      renderFoundation(foundation, 'approved'));
    assert.notEqual(await trustedHead(job), sourceSha);
    const metrics = nativeStoryMetrics(job);
    assert.equal(metrics.foundation.status, 'approved');
    assert.deepEqual(metrics.foundation.approvedFirstPlaythroughMinutes,
      { min_minutes: 60, max_minutes: 90 });
    assert.equal(metrics.foundation.productionBudget &&
      (metrics.foundation.productionBudget as any).illustrated_backgrounds.firmness, 'hard');
    assert.equal(git(job.worktreeRoot, "rev-list", "--count", sourceSha + "..HEAD"), "1");
    assert.equal(git(repo, "rev-parse", "HEAD"), sourceSha);
    const validation = await validateStoryJob(job, undefined, { ...job, baseSha: await trustedHead(job) });
    assert.equal(await reusableExistingFoundation(job, validation), true);
    const repeat = await runFoundationJob(request);
    assert.equal(repeat.commitSha, result.commitSha);
    assert.equal(git(job.worktreeRoot, "rev-list", "--count", sourceSha + "..HEAD"), "1");

    // A second Thread on already approved existing canon only reads the
    // foundation; it must not create a replacement or a false author approval.
    const existingStory = join(repo, "existing-story");
    mkdirSync(join(existingStory, "creative-direction"), { recursive: true });
    writeFileSync(join(existingStory, "creative-direction", "foundation.md"),
      renderFoundation(foundation));
    git(repo, "add", "existing-story/creative-direction/foundation.md");
    git(repo, "commit", "-qm", "Original author approved Creative Direction");
    const originalExistingHead = git(repo, "rev-parse", "HEAD");
    const reused = await startStoryJob({ story: existingStory, job: "read-only-first" });
    const original = await validateStoryJob(reused, undefined,
      { ...reused, baseSha: originalExistingHead });
    assert.equal(await reusableExistingFoundation(reused, original), true);
    const readOnlyObjective = "Just use the existing premise, nothing else";
    await pinReusedFoundation(reused, readOnlyObjective);
    await pinReusedFoundation(reused, readOnlyObjective);
    assert.equal((await readReusedFoundation(reused))?.originalObjective, readOnlyObjective);
    await assert.rejects(() => pinReusedFoundation(reused, "Overwrite the premise"),
      /different original Turn/);
    assert.equal(await readChatApprovedFoundation(reused), null);
    assert.equal(await trustedHead(reused), originalExistingHead);
    assert.equal(git(reused.worktreeRoot, "rev-list", "--count",
      originalExistingHead + "..HEAD"), "0");
    assert.equal(git(repo, "rev-parse", "HEAD"), originalExistingHead);
  } finally {
    if (previous.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = previous.state;
    if (previous.cache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = previous.cache;
    if (previous.config === undefined) delete process.env.NT_CONFIG_FILE;
    else process.env.NT_CONFIG_FILE = previous.config;
    removeTestTree(root);
  }
});

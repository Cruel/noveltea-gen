import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifiedNarrativeChain } from "../src/job-successor.js";
import { startStoryJob } from "../src/job.js";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { runIdeaPlacement } from "../src/idea-placement.js";
import { configurePiPolicy, inspectPiPolicy } from "../src/job-pi-policy.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls, scriptedStoryRuntime, scriptedText } from "./c03-scripted-story-helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-idea-placement-"));
after(() => {
  if (process.env.NT_LIVE_IDEA_PLACEMENT === "1" && process.env.NT_KEEP_FAILED_LIVE === "1") {
    process.stderr.write("Preserved live idea-placement fixtures: " + root + "\n");
  } else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story"), state = join(root, name + "-state");
  mkdirSync(repo, { recursive: true });
  cpSync(resolve("test/fixtures/archive-witness"), story, { recursive: true });
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Original Story");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: state, NT_CONFIG_FILE: join(root, "missing.json"),
    NT_SKILL_CACHE_DIR: join(root, name + "-skills"),
     };
  function call(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "job", ...args, "--story", story, "--job", name], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 24 * 1024 * 1024, env,
      });
  }
  function ok(...args: string[]) {
    const result = call(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const job = ok("start");
  const payload = join(root, name + "-idea.json");
  const live = name.startsWith("live-");
  writeFileSync(payload, JSON.stringify({
    id: "bell-concept", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "notes:page-7" },
    original: live
      ? "Neri adds that hiding the ledger betrayed Ada's trust. Ada asks Neri to account for when the missing witness last had access to it."
      : "A bell's echo proves that the archive was opened that night.",
    requirements: {
      meaning: [{ text: live
        ? "Neri's admission harms Ada's trust and directs her inquiry toward the missing witness's access to the ledger"
        : "The bell's echo changes the witness investigation", binding: true }],
      wording: [], participants: [{ text: "character.ada", binding: true }],
    },
    identities: { known: ["character.ada"], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const captured = ok("ideas", "capture", "--file", payload);
  return { repo, story, state, job, baseline, captured, call, ok, env };
}
test("production idea selection corrects format, preserves refusal, and reconciles without another Pi call", {
  skip: !available, timeout: 120_000,
}, async () => {
  const x = setup("scripted-selection");
  const keys = ["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR"] as const;
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = x.env[key]; });
  const restore = fixtureSandboxClient(x.job.jobId, x.job.worktreeStoryRoot);
  try {
    const original = git(x.job.worktreeRoot, "rev-parse", "HEAD");
    const scripted = await scriptedStoryRuntime((index, context) => {
      if (index === 0) {
        const messages = context.messages as Array<{role: string; content: unknown}>;
        const prompt = messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content)).join("\n");
        const decoded = prompt.replaceAll("\\n", "\n");
        const paths = decoded.split("READ ALL EXACT FILE PATHS FIRST:\n")[1]!
          .split("\nRead-only independent semantic assessment")[0]!.split("\n");
        assert.ok(paths.length >= 6);
        return { content: scriptedReadCalls(paths, index), reason: "toolUse" };
      }
      if (index === 1) return { content: scriptedText("{not JSON"), reason: "stop" };
      assert.equal(index, 2, "no new planning or writer call");
      return { content: scriptedText({ verdict: "block", target: null, evidence: [],
        reason: "No suitable candidate preserves the causal context." }), reason: "stop" };
    });
    const request = { story: x.story, job: "scripted-selection", action: "place" as const,
      id: "bell-concept", autoSelect: true, skillsSource: source,
      provider: scriptedModel.provider, model: scriptedModel.id, expectedHead: original };
    const invoke = () => withJobModelRuntime(scripted.runtime, () => runIdeaPlacement(request));
    const profile = { provider: scriptedModel.provider, model: scriptedModel.id };
    await configurePiPolicy(x.job, { version: 1, profile, limits: { modelCalls: 2 } });
    await assert.rejects(invoke(), (error: Error) => error.name === "PiBudgetPause");
    assert.equal(scripted.calls(), 2);
    await configurePiPolicy(x.job, { version: 1, profile, limits: { modelCalls: 4 } });
    const replay = () => withJobModelRuntime(scripted.runtime, () => runIdeaPlacement({
      ...request, reconcileReadOnly: true,
    }));
    const resolutionFile = join(x.job.stateDir, "pi-resolution.json");
    const resolutionText = readFileSync(resolutionFile, "utf8");
    const resolution = JSON.parse(resolutionText);
    writeFileSync(resolutionFile, JSON.stringify({ ...resolution,
      selected: { ...resolution.selected, model: "foreign-model" } }));
    try {
      await assert.rejects(replay(), /integrity-blocked/);
      assert.equal(scripted.calls(), 2, "wrong model pin must not reopen the original conversation");
    } finally {
      writeFileSync(resolutionFile, resolutionText);
    }
    const first = await replay();
    assert.equal(first.status, "deferred");
    assert.equal(scripted.calls(), 3);
    assert.deepEqual(scripted.observed[2]!.tools, []);
    assert.equal((await inspectPiPolicy(x.job)).budget.modelCalls, 3);
    assert.deepEqual(await replay(), first);
    assert.equal(scripted.calls(), 3);
    const protocol = join(x.job.stateDir, "idea-protocol");
    const initial = join(protocol, readdirSync(protocol).find(p => p.endsWith(".initial.json"))!);
    const receipt = JSON.parse(readFileSync(initial, "utf8")) as { sessionFile: string };
    const transcript = readFileSync(receipt.sessionFile, "utf8");
    writeFileSync(receipt.sessionFile, transcript + "\n");
    await assert.rejects(replay(), /integrity-blocked/);
    writeFileSync(receipt.sessionFile, transcript);
    const started = initial.replace(/\.initial\.json$/, ".started.json");
    renameSync(started, started + ".missing");
    await assert.rejects(replay(), /integrity-blocked/);
    renameSync(started + ".missing", started);
    assert.equal(scripted.calls(), 3);
    assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), original);
    assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    restore();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

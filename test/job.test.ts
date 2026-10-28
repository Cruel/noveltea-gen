import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const cli = resolve("src/cli.ts");
const fixtures = mkdtempSync(join(tmpdir(), "nt-gen-job-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repo(name: string) {
  const root = join(fixtures, name);
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Author");
  writeFileSync(join(root, "README.md"), "author baseline\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "Baseline");
  return root;
}

function start(story: string, job: string, state: string, extra: string[] = []) {
  return spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", "start", "--story", story, "--job", job, ...extra],
    { cwd: resolve("."), encoding: "utf8", timeout: 30_000, env: {
      ...process.env, NT_STATE_DIR: state,
    } },
  );
}

test("public CLI creates a persistent isolated job without changing author checkout", () => {
  const author = repo("standalone");
  const story = join(author, "story");
  mkdirSync(story);
  const state = join(fixtures, "state-standalone");
  const originalBranch = git(author, "branch", "--show-current");
  const baseline = git(author, "rev-parse", "HEAD");

  const started = start(story, "draft", state);
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  assert.equal(job.status, "ready");
  assert.equal(job.jobId, "draft");
  assert.equal(job.gitRoot, author);
  assert.equal(job.storyRoot, story);
  assert.equal(job.storyRelativePath, "story");
  assert.equal(job.baseSha, baseline);
  assert.match(job.branch, /^noveltea-gen\/[a-f0-9]{64}$/);
  assert.match(job.threadId, /^[a-f0-9-]{36}$/);
  assert.ok(job.worktreeRoot.startsWith(state));
  assert.equal(existsSync(job.worktreeStoryRoot), true);
  assert.equal(git(job.worktreeRoot, "branch", "--show-current"), job.branch);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), baseline);
  assert.equal(git(author, "branch", "--show-current"), originalBranch);
  assert.equal(git(author, "rev-parse", "HEAD"), baseline);
  assert.equal(git(author, "status", "--porcelain"), "");

  const reopened = start(story, "draft", state);
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), job);
});

test("relevant dirty and untracked Story content blocks a new job but unrelated monorepo edits do not", () => {
  const author = repo("dirty");
  const story = join(author, "narratives", "story-a");
  mkdirSync(join(author, "narratives"));
  mkdirSync(story);
  writeFileSync(join(story, "foundation.md"), "committed canon\n");
  git(author, "add", "narratives/story-a/foundation.md");
  git(author, "commit", "-qm", "Story baseline");
  const baseline = git(author, "rev-parse", "HEAD");
  const state = join(fixtures, "state-dirty");

  writeFileSync(join(story, "foundation.md"), "uncommitted canon\n");
  const altered = start(story, "first", state);
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /uncommitted|baseline/i);
  assert.equal(existsSync(join(state, "jobs")), false);
  assert.match(git(author, "status", "--porcelain"), /^M narratives\/story-a\/foundation\.md$/);

  git(author, "restore", "--", "narratives/story-a/foundation.md");
  writeFileSync(join(story, "new.md"), "untracked canon\n");
  const untracked = start(story, "first", state);
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /uncommitted|untracked/i);
  git(author, "add", "narratives/story-a/new.md");
  const staged = start(story, "first", state);
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /uncommitted|untracked/i);
  git(author, "restore", "--staged", "narratives/story-a/new.md");
  rmSync(join(story, "new.md"));

  writeFileSync(join(author, "README.md"), "unrelated uncommitted author work\n");
  writeFileSync(join(author, "other-untracked.md"), "other work\n");
  const statusBefore = git(author, "status", "--porcelain");
  const ok = start(story, "first", state);
  assert.equal(ok.status, 0, ok.stderr);
  const job = JSON.parse(ok.stdout);
  assert.equal(job.storyRelativePath, "narratives/story-a");
  assert.equal(readFileSync(join(job.worktreeStoryRoot, "foundation.md"), "utf8"), "committed canon\n");
  assert.equal(git(author, "status", "--porcelain"), statusBefore);
  assert.equal(git(author, "rev-parse", "HEAD"), baseline);
});

test("siblings and multiple jobs have distinct durable branches and never replace the author's branch", () => {
  const author = repo("siblings");
  const firstStory = join(author, "stories", "one");
  const secondStory = join(author, "stories", "two");
  mkdirSync(join(author, "stories"));
  mkdirSync(firstStory);
  mkdirSync(secondStory);
  writeFileSync(join(firstStory, "one.md"), "first\n");
  writeFileSync(join(secondStory, "two.md"), "second\n");
  git(author, "add", "stories");
  git(author, "commit", "-qm", "Two Stories");
  const state = join(fixtures, "state-siblings");
  const a = JSON.parse(start(firstStory, "outline", state).stdout);
  const b = JSON.parse(start(firstStory, "rewrite", state).stdout);
  const c = JSON.parse(start(secondStory, "outline", state).stdout);
  assert.equal(new Set([a.branch, b.branch, c.branch]).size, 3);
  assert.equal(new Set([a.threadId, b.threadId, c.threadId]).size, 3);
  assert.equal(new Set([a.worktreeRoot, b.worktreeRoot, c.worktreeRoot]).size, 3);
  assert.deepEqual([a.storyRelativePath, b.storyRelativePath, c.storyRelativePath],
    ["stories/one", "stories/one", "stories/two"]);
  assert.equal(existsSync(join(a.worktreeStoryRoot, "two.md")), false);
  assert.equal(existsSync(join(c.worktreeStoryRoot, "one.md")), false);

  writeFileSync(join(a.worktreeStoryRoot, "one.md"), "job authored revision\n");
  git(a.worktreeRoot, "add", "stories/one/one.md");
  git(a.worktreeRoot, "commit", "-qm", "Job progress");
  writeFileSync(join(a.worktreeStoryRoot, "in-progress.md"), "paused writer\n");
  const reopen = start(firstStory, "outline", state);
  assert.equal(reopen.status, 0, reopen.stderr);
  const resumed = JSON.parse(reopen.stdout);
  assert.equal(resumed.baseSha, a.baseSha);
  assert.equal(resumed.threadId, a.threadId);
  assert.equal(resumed.branch, a.branch);
  assert.equal(resumed.headSha, git(a.worktreeRoot, "rev-parse", "HEAD"));
  assert.notEqual(resumed.headSha, a.headSha);
  assert.equal(readFileSync(join(a.worktreeStoryRoot, "in-progress.md"), "utf8"), "paused writer\n");
  assert.equal(readFileSync(join(b.worktreeStoryRoot, "one.md"), "utf8"), "first\n");
  assert.equal(readFileSync(join(author, "stories/one/one.md"), "utf8"), "first\n");
  assert.equal(git(author, "status", "--porcelain"), "");
});

test("job identity resolves Story symlink aliases and records optional engine project without reading it", () => {
  const author = repo("alias");
  const story = join(author, "story");
  mkdirSync(story);
  const alias = join(fixtures, "alias-to-story");
  symlinkSync(story, alias, "dir");
  const state = join(fixtures, "state-alias");
  const engine = join(fixtures, "future-engine");
  mkdirSync(engine);
  writeFileSync(join(engine, "game.json"), "intentionally not read");
  const created = start(alias, "one", state, ["--noveltea-project", engine]);
  assert.equal(created.status, 0, created.stderr);
  const job = JSON.parse(created.stdout);
  assert.equal(job.storyRoot, story);
  assert.equal(job.novelteaProjectRoot, engine);
  const reopened = start(story, "one", state);
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), job);
  const inconsistent = start(story, "one", state, ["--noveltea-project", join(fixtures, "different")]);
  assert.notEqual(inconsistent.status, 0);
  assert.match(inconsistent.stderr, /identity|does not match/i);
  assert.equal(readFileSync(join(engine, "game.json"), "utf8"), "intentionally not read");
});

test("missing, non-Git and unborn Story baselines fail without initializing Git", () => {
  const nonGit = join(fixtures, "non-git");
  mkdirSync(nonGit);
  const state = join(fixtures, "state-invalid");
  const missing = start(join(fixtures, "absent"), "start", state);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /existing directory/i);
  const result = start(nonGit, "start", state);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing Git worktree/i);
  assert.equal(existsSync(join(nonGit, ".git")), false);
  const unborn = join(fixtures, "unborn");
  mkdirSync(unborn);
  git(unborn, "init", "-q");
  const noHead = start(unborn, "start", state);
  assert.notEqual(noHead.status, 0);
  assert.match(noHead.stderr, /committed HEAD/);
  const missingArgs = spawnSync(process.execPath, ["--import", "tsx", cli, "job", "start"], {
    cwd: resolve("."), encoding: "utf8",
  });
  assert.notEqual(missingArgs.status, 0);
  assert.match(missingArgs.stderr, /--story/);
  assert.equal(existsSync(state), false);
  const duplicate = start(nonGit, "start", state, ["--story", nonGit]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Duplicate job option/);
  const help = spawnSync(process.execPath, ["--import", "tsx", cli, "job", "start", "--help"], {
    cwd: resolve("."), encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /job start/);
});

test("tampering with a saved job's branch or worktree identity is detected", () => {
  const author = repo("tamper");
  const state = join(fixtures, "state-tamper");
  const created = start(author, "secure", state);
  assert.equal(created.status, 0, created.stderr);
  const job = JSON.parse(created.stdout);
  git(job.worktreeRoot, "switch", "-qc", "unexpected-branch");
  const reopen = start(author, "secure", state);
  assert.notEqual(reopen.status, 0);
  assert.match(reopen.stderr, /identity|branch/i);
  assert.equal(git(job.worktreeRoot, "branch", "--show-current"), "unexpected-branch");
});

test("reopening refuses a worktree whose Story directory was removed", () => {
  const author = repo("deleted-story");
  const story = join(author, "story");
  mkdirSync(story);
  const state = join(fixtures, "state-deleted-story");
  const created = start(story, "draft", state);
  assert.equal(created.status, 0, created.stderr);
  const job = JSON.parse(created.stdout);
  rmSync(job.worktreeStoryRoot, { recursive: true });
  const reopened = start(story, "draft", state);
  assert.notEqual(reopened.status, 0);
  assert.match(reopened.stderr, /Story root is missing/i);
  assert.equal(existsSync(job.worktreeStoryRoot), false);
});

test("state storage within the source checkout is rejected and preexisting job branches never get reused", () => {
  const author = repo("state-safety");
  const stateWithin = join(author, ".local");
  const invalid = start(author, "draft", stateWithin);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /outside|inside the author/i);
  assert.equal(existsSync(stateWithin), false);

  const alias = join(fixtures, "state-symlink-inside");
  symlinkSync(author, alias, "dir");
  const viaAlias = start(author, "draft", join(alias, ".local"));
  assert.notEqual(viaAlias.status, 0);
  assert.match(viaAlias.stderr, /outside|inside the author/i);
  assert.equal(existsSync(stateWithin), false);

  const state = join(fixtures, "state-preexisting");
  const first = start(author, "draft", state);
  assert.equal(first.status, 0, first.stderr);
  const otherState = join(fixtures, "state-preexisting-other");
  const collision = start(author, "draft", otherState);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /already exists|branch|failed/i);
  assert.equal(git(author, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(author, "README.md"), "utf8"), "author baseline\n");
});

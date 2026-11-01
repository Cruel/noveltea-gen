import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "../src/job.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { createSandboxPiTools, SANDBOX_TOOLS, sandboxToolsRequired, selectSandboxPiTools, blockUnroutedHostedPi } from "../src/sandbox-pi-tools.js";
import { removeTestTree } from "./helpers.js";

const base = mkdtempSync(join(tmpdir(), "nt-sandbox-pi-"));
const originalCache = process.env.NT_SKILL_CACHE_DIR;
process.env.NT_SKILL_CACHE_DIR = join(base, "snapshots");
after(() => {
  if (originalCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
  else process.env.NT_SKILL_CACHE_DIR = originalCache;
  removeTestTree(base);
});
const source = join(base, "skill-source");
mkdirSync(join(source, "skills", "nt-catalog"), { recursive: true });
writeFileSync(join(source, "skills", "nt-catalog", "SKILL.md"), "---\nname: nt-catalog\n---\nPinned rules\n");
function git(...args: string[]) {
  const command = spawnSync("git", args, { cwd: source, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
}
git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
git("add", "."); git("commit", "-qm", "pinned");
const job = { jobId: "cd7f6efb-3a4e-4719-89b1-25ca838f493a", worktreeStoryRoot: join(base, "trusted-job", "story") } as JobStartResult;
let initial: Promise<{
  snapshot: NonNullable<Awaited<ReturnType<typeof createSkillSnapshot>>>;
  skills: Skill[];
}> | undefined;
function fixture() {
  return initial ??= (async () => {
    const snapshot = (await createSkillSnapshot({
      novelteaSkills: source, discovery: "explicit-only", skillDirs: [], requiredSkills: [],
    }))!;
    assert.ok(snapshot);
    return { snapshot, skills: [{
      name: "nt-catalog", baseDir: join(snapshot.path, "skills", "nt-catalog"),
      filePath: join(snapshot.path, "skills", "nt-catalog", "SKILL.md"),
    } as Skill] };
  })();
}
function client() {
  const calls: string[][] = [];
  let acquired = 0;
  return {
    calls, get acquired() { return acquired; },
    async acquire(id: string) { acquired++; return { jobId: id, status: "running" }; },
    async execute(_id: string, argv: string[], output: (stream: "stdout" | "stderr", data: string) => void) {
      calls.push(argv);
      if (argv[0] === "cat") output("stdout", "old text\n");
      if (argv[0] === "wc") output("stdout", "9 /story/arcs/chapter.md\n");
      if (argv[0] === "sh" && argv[2]?.includes("sed -n")) output("stdout", "story content\n");
      if (argv[0] === "bash") output("stdout", "isolated command\n");
      return 0;
    },
  };
}
async function call(tool: Awaited<ReturnType<typeof createSandboxPiTools>>[number], args: Record<string, unknown>) {
  return tool.execute("test", args, undefined as never, undefined as never, undefined as never);
}

test("hosted mode requires complete controller configuration and never falls back to local tools", async () => {
  const { snapshot, skills } = await fixture();
  const old = { socket: process.env.NT_SANDBOX_SOCKET, token: process.env.NT_SANDBOX_TOKEN_FILE, require: process.env.NT_REQUIRE_SANDBOX_TOOLS };
  try {
    delete process.env.NT_SANDBOX_SOCKET;
    delete process.env.NT_SANDBOX_TOKEN_FILE;
    process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
    assert.equal(sandboxToolsRequired(), true);
    assert.throws(() => blockUnroutedHostedPi("Event"), /refused unsafe host fallback/);
    await assert.rejects(selectSandboxPiTools(job, snapshot, skills), /no local tool fallback/);
    process.env.NT_SANDBOX_SOCKET = "/private/controller.sock";
    process.env.NT_SANDBOX_TOKEN_FILE = "/private/token";
    const broken = client();
    broken.acquire = async () => { throw new Error("controller not responding"); };
    await assert.rejects(selectSandboxPiTools(job, snapshot, skills, broken), /controller not responding/);
    assert.equal(broken.calls.length, 0);
  } finally {
    for (const [name, value] of [["NT_SANDBOX_SOCKET",old.socket],["NT_SANDBOX_TOKEN_FILE",old.token],["NT_REQUIRE_SANDBOX_TOOLS",old.require]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.doesNotThrow(() => blockUnroutedHostedPi("Event"), "local CLI workflow retains its preexisting tools");
});

test("private graph server fails at startup rather than offering legacy host tools", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/agent-host.ts")], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NT_REQUIRE_SANDBOX_TOOLS: "0",
      NT_SANDBOX_SOCKET: "", NT_SANDBOX_TOKEN_FILE: "",
      NT_GRAPH_DB: join(base, "blocked-graph.sqlite") },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hosted agent requires the private sandbox/);
});

test("all seven Pi file/search/shell names route through the verified sandbox", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const definitions = await createSandboxPiTools(job, snapshot, skills, runner);
  assert.deepEqual(definitions.map(t => t.name), [...SANDBOX_TOOLS]);
  assert.equal(runner.acquired, 1);
  const tools = Object.fromEntries(definitions.map(t => [t.name,t])) as Record<string, (typeof definitions)[number]>;
  await call(tools.read!, { path: "arcs/chapter.md" });
  await call(tools.write!, { path: "arcs/chapter.md", content: "chapter\n" });
  await call(tools.edit!, { path: "arcs/chapter.md", edits: [{ oldText: "old", newText: "new" }] });
  await call(tools.bash!, { command: "echo hi" });
  await call(tools.grep!, { pattern: "chapter" });
  await call(tools.find!, { pattern: "*.md" });
  await call(tools.ls!, { path: "arcs" });
  assert.equal(runner.calls.length, 9, "edit performs read and write via container, never host");
  assert.ok(runner.calls.every(args => args[0] !== "docker" && args[0] !== "git"));
  assert.ok(runner.calls.some(args => args.join(" ").includes("/story/arcs/chapter.md")));
  assert.ok(runner.calls.some(args => args[0] === "bash" && args[1] === "-lc"));
  const writeCall = runner.calls.find(args => args.some(x => x === "/story/arcs/chapter.md") && args.some(x => x.includes("base64 -d")));
  assert.ok(writeCall, "write runs a base64 decode inside the sandbox");
});

test("host paths, traversal, Git and deferred author ideas are never model-readable or writable", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const tools = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, runner)).map(t => [t.name,t])) as Record<string, Awaited<ReturnType<typeof createSandboxPiTools>>[number]>;
  for (const path of ["/etc/passwd", "../other-job/story/arcs/private.md", ".git/config",
    ".story-inbox/ideas/secret.yaml", "arcs/.hidden", "/var/lib/noveltea/state/private.db"]) {
    await assert.rejects(call(tools.read!, { path }), /denied/);
    await assert.rejects(call(tools.write!, { path, content: "bad" }), /denied/);
    await assert.rejects(call(tools.grep!, { path, pattern: "secret" }), /denied/);
    await assert.rejects(call(tools.find!, { path, pattern: "*" }), /denied/);
    await assert.rejects(call(tools.ls!, { path }), /denied/);
  }
  assert.equal(runner.calls.length, 0, "denied operations never reach the controller");
});

test("pinned skill read is narrow, digest-verified and never sent as an arbitrary sandbox path", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const tools = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, runner)).map(t => [t.name,t])) as Record<string, Awaited<ReturnType<typeof createSandboxPiTools>>[number]>;
  const result = await call(tools.read!, { path: skills[0]!.filePath });
  assert.match(JSON.stringify(result.content), /Pinned rules/);
  await assert.rejects(call(tools.read!, { path: join(snapshot.path, "private.txt") }), /denied/);
  assert.equal(runner.calls.length, 0);
  assert.match(readFileSync(skills[0]!.filePath, "utf8"), /Pinned rules/);
});

test("real rootless sandbox image executes all seven Pi tool operations without host tools", {
  skip: process.env.NT_TEST_ROOTLESS_SANDBOX !== "1",
}, async () => {
  const { snapshot, skills } = await fixture();
  const story = join(base, "mounted-story");
  const arcs = join(story, "arcs");
  mkdirSync(arcs, { recursive: true });
  const name = "noveltea-pi-test-" + process.pid;
  const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  const created = docker("run", "-d", "--name", name,
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "0:0",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--mount", "type=bind,source=" + arcs + ",target=/story/arcs",
    "noveltea-sandbox:local", "sleep", "infinity");
  assert.equal(created.status, 0, created.stderr);
  try {
    const remote = {
      async acquire(id: string) { return { jobId: id, status: "running" }; },
      async execute(_id: string, argv: string[], output: (stream: "stdout" | "stderr", data: string) => void) {
        const result = docker("exec", "--workdir", "/story", name, ...argv);
        if (result.stdout) output("stdout", result.stdout);
        if (result.stderr) output("stderr", result.stderr);
        return result.status ?? 1;
      },
    };
    const tools = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, remote))
      .map(t => [t.name, t])) as Record<string, Awaited<ReturnType<typeof createSandboxPiTools>>[number]>;
    await call(tools.write!, { path: "arcs/chapter.md", content: "Opening scene\n" });
    assert.match(JSON.stringify((await call(tools.read!, { path: "arcs/chapter.md" })).content), /Opening scene/);
    await call(tools.edit!, { path: "arcs/chapter.md", edits: [{ oldText: "Opening", newText: "Closing" }] });
    assert.equal(readFileSync(join(arcs, "chapter.md"), "utf8"), "Closing scene\n");
    assert.match(JSON.stringify((await call(tools.grep!, { pattern: "Closing" })).content), /chapter.md/);
    assert.match(JSON.stringify((await call(tools.find!, { pattern: "*.md" })).content), /chapter.md/);
    assert.match(JSON.stringify((await call(tools.ls!, { path: "arcs" })).content), /chapter.md/);
    assert.match(JSON.stringify((await call(tools.bash!, { command: "pwd" })).content), /story/);
    assert.doesNotMatch(JSON.stringify((await call(tools.bash!, { command: "ls -A /story" })).content), /\.git|\.story-inbox/);
  } finally {
    const disposed = docker("rm", "-f", name);
    assert.equal(disposed.status, 0, disposed.stderr);
  }
});

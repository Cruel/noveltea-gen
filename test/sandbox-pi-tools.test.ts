import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "../src/job.js";
import { SandboxExecutionError } from "../src/sandbox-client.js";
import { SANDBOX_RECORD_BYTES } from "../src/sandbox-limits.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { createSandboxPiTools, SANDBOX_TOOLS, SANDBOX_READ_ONLY_TOOLS, sandboxToolsRequired, selectSandboxPiTools, blockUnroutedHostedPi, readSandboxContextFile } from "../src/sandbox-pi-tools.js";
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
const otherSkillNames = ["nt-worldbuilding", "nt-character-development", "nt-narrative-review",
  "nt-story-orchestrate", "nt-story-collaborate", "nt-story-generate", "nt-story-import"];
for (const name of otherSkillNames) {
  const folder = join(source, "skills", name);
  mkdirSync(join(folder, "references"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n${name} guidance\n`);
  writeFileSync(join(folder, "references", "craft.md"), `${name} pinned craft reference\n`);
}
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
    return { snapshot, skills: ["nt-catalog", ...otherSkillNames].map(name => ({
      name, baseDir: join(snapshot.path, "skills", name),
      filePath: join(snapshot.path, "skills", name, "SKILL.md"),
    } as Skill)) };
  })();
}
function client() {
  const calls: string[][] = [];
  const inputs: Buffer[] = [];
  let acquired = 0;
  return {
    calls, inputs, get acquired() { return acquired; },
    async acquire(id: string) { acquired++; return { jobId: id, status: "running" }; },
    async execute(_id: string, argv: string[], output: (stream: "stdout" | "stderr", data: string) => void, stdin?:Buffer) {
      calls.push(argv);
      if(stdin) inputs.push(stdin);
      if(argv[3]==="nt-context"){const data=Buffer.from("old text\n");output("stdout",createHash("sha256").update(data).digest("hex")+"\n"+data.toString("base64"));}
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
  assert.equal(sandboxToolsRequired({}), true, "standalone jobs must also isolate the approval controller");
  assert.throws(() => blockUnroutedHostedPi("Event"), /refused unsafe host fallback/);
});

test("private agent worker fails at startup rather than offering legacy host tools", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("web/src/agent-worker.ts")], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NT_REQUIRE_SANDBOX_TOOLS: "0",
      NT_SANDBOX_SOCKET: "", NT_SANDBOX_TOKEN_FILE: "",
      NT_AGENT_RPC_TOKEN: "test-agent-token-01234567890123456789" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Agent requires its private rootless sandbox controller/);
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
  assert.equal(runner.calls.length, 8, "edit performs read and write via container, never host");
  assert.ok(runner.calls.every(args => args[0] !== "docker" && args[0] !== "git"));
  assert.ok(runner.calls.some(args => args.join(" ").includes("/story/arcs/chapter.md")));
  assert.ok(runner.calls.some(args => args[0] === "bash" && args[1] === "-lc"));
  const writeCall = runner.calls.find(args => args.some(x => x === "/story/arcs/chapter.md") && args[3] === "nt-write");
  assert.ok(writeCall, "write streams file bytes to stdin");
  assert.deepEqual(runner.inputs.map(b=>b.toString()),["chapter\n","new text\n"]);
});

test("hosted editorial reviewers receive only sandbox-backed read/search tools", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const reviewer = await createSandboxPiTools(job, snapshot, skills, runner, "read-only");
  assert.deepEqual(reviewer.map(tool => tool.name), [...SANDBOX_READ_ONLY_TOOLS]);
  assert.equal(runner.acquired, 1, "reviewer also acquires the registered sandbox");
  const tools = Object.fromEntries(reviewer.map(tool => [tool.name, tool]));
  for (const forbidden of ["write", "edit", "bash"]) assert.equal(tools[forbidden], undefined);
  await call(tools.read!, { path: "authored-content/scene.md" });
  await call(tools.grep!, { pattern: "scene", path: "choice-points" });
  await call(tools.find!, { pattern: "*.md", path: "puzzles" });
  await call(tools.ls!, { path: "authored-content" });
  assert.ok(runner.calls.find(args => args.join(" ").includes('find "$1"'))
    ?.join(" ").includes('-type d -name ".*" -prune'),
    "read-only discovery does not descend into private inbox or hidden project files");
  assert.ok(runner.calls.find(args => args.join(" ").includes('ls -1 -- "$1"')),
    "read-only directory listings hide private dot-directories");
  assert.equal(runner.calls.length, 4);
  assert.ok(runner.calls.every(argv => argv[0] === "sh"));
});

test("retrospective assignment reviewer can read pinned methods but cannot open mutable Story files", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const definitions = await createSandboxPiTools(
    job,
    snapshot,
    skills,
    runner,
    "read-only",
    "reviewer",
    "pinned-skills-only",
  );
  const readTool = definitions.find((tool) => tool.name === "read")!;
  assert.match(
    JSON.stringify((await call(readTool, { path: "skill://nt-catalog/SKILL.md" })).content),
    /Pinned rules/,
  );
  assert.match(
    JSON.stringify((await call(readTool, { path: "skill://nt-narrative-review/SKILL.md" })).content),
    /narrative-review guidance/,
  );
  assert.match(
    JSON.stringify((await call(readTool, {
      path: "skill://nt-character-development/references/craft.md",
    })).content),
    /character-development pinned craft reference/,
    "A repair reviewer may consult relevant canonical references across roles",
  );
  await assert.rejects(call(readTool, { path: "skill://nt-story-orchestrate/SKILL.md" }),
    /Skill read denied/, "Orchestrator instructions are not canonical reviewer references");
  await assert.rejects(call(readTool, { path: "skill://nt-catalog/../nt-story-orchestrate/SKILL.md" }),
    /Skill read denied/, "Pinned read policy must reject path traversal");
  for (const path of [
    "milestones/disclosure.md",
    "events/disclosure.md",
    "/story/milestones/disclosure.md",
    join(job.worktreeStoryRoot, "milestones/disclosure.md"),
    ".story-inbox/ideas/private.md",
  ]) {
    await assert.rejects(
      call(readTool, { path }),
      /only immutable pinned skills/i,
      "No current Story read can contaminate a sealed review: " + path,
    );
  }
  assert.equal(runner.calls.length, 0, "Denied reads never touch the sandbox or host");
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

test("pinned skill reads are role-aware and cross-domain craft is not a role grant", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const root = join(snapshot.path, "skills");
  const path = (name: string, tail = "SKILL.md") => join(root, name, tail);
  const specialist = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, runner,
    "writer", "specialist")).map(t => [t.name, t]));
  assert.ok(specialist.write && specialist.edit, "the existing specialist tool grant is unaffected");
  assert.match(JSON.stringify((await call(specialist.read!, { path: path("nt-catalog") })).content), /Pinned rules/);
  assert.match(JSON.stringify((await call(specialist.read!, { path: "skill://nt-catalog/SKILL.md" })).content), /Pinned rules/);
  assert.match(JSON.stringify((await call(specialist.read!, { path: "skill://nt-character-development/references/craft.md" })).content),
    /character-development pinned craft reference/);
  assert.match(JSON.stringify((await call(specialist.read!, { path: path("nt-worldbuilding") })).content), /worldbuilding guidance/);
  assert.match(JSON.stringify((await call(specialist.read!, { path: path("nt-character-development", "references/craft.md") })).content),
    /character-development pinned craft reference/);
  for (const name of ["nt-narrative-review", "nt-story-orchestrate", "nt-story-collaborate",
    "nt-story-generate", "nt-story-import"]) {
    await assert.rejects(call(specialist.read!, { path: path(name) }), /Skill read denied/);
    await assert.rejects(call(specialist.read!, { path: path(name, "references/craft.md") }), /Skill read denied/);
  }
  await assert.rejects(call(specialist.read!, { path: path("nt-worldbuilding", "../nt-story-orchestrate/SKILL.md") }),
    /Skill read denied/);
  for (const denied of ["skill://nt-story-orchestrate/SKILL.md", "skill://nt-narrative-review/SKILL.md",
    "skill://nt-catalog/../nt-story-orchestrate/SKILL.md", "skill://nt-catalog/%2e%2e/secret.md",
    "skill://nt-catalog//SKILL.md", "skill://nt-catalog/references/../../nt-story-orchestrate/SKILL.md"]) {
    await assert.rejects(call(specialist.read!, { path: denied }), /Skill read denied/);
  }
  await assert.rejects(call(specialist.read!, { path: "/etc/passwd" }), /denied/);
  await assert.rejects(call(specialist.read!, { path: join(source, "skills", "nt-catalog", "SKILL.md") }),
    /denied/, "live skill checkout cannot replace pinned skill bytes");

  const reviewer = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, runner,
    "writer", "reviewer")).map(t => [t.name, t]));
  assert.deepEqual(Object.keys(reviewer), [...SANDBOX_READ_ONLY_TOOLS],
    "a reviewer remains read-only even if a caller requests writer tools");
  assert.match(JSON.stringify((await call(reviewer.read!, { path: path("nt-narrative-review") })).content),
    /narrative-review guidance/);
  assert.match(JSON.stringify((await call(reviewer.read!, { path: path("nt-worldbuilding") })).content),
    /worldbuilding guidance/);
  await assert.rejects(call(reviewer.read!, { path: path("nt-story-orchestrate") }), /Skill read denied/);

  const orchestrator = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, runner,
    "writer", "orchestrator")).map(t => [t.name, t]));
  assert.deepEqual(Object.keys(orchestrator), [...SANDBOX_READ_ONLY_TOOLS],
    "reading a specialist's method cannot confer its file-writing tools");
  assert.match(JSON.stringify((await call(orchestrator.read!, { path: path("nt-story-orchestrate") })).content),
    /story-orchestrate guidance/);
  assert.match(JSON.stringify((await call(orchestrator.read!, { path: "skill://nt-story-orchestrate/SKILL.md" })).content),
    /story-orchestrate guidance/);
  assert.match(JSON.stringify((await call(orchestrator.read!, { path: path("nt-story-collaborate") })).content),
    /story-collaborate guidance/);
  assert.match(JSON.stringify((await call(orchestrator.read!, { path: path("nt-character-development") })).content),
    /character-development guidance/);
  await assert.rejects(call(orchestrator.read!, { path: path("nt-narrative-review") }), /Skill read denied/);
  assert.equal(runner.calls.length, 0, "skills are read only through the verified host snapshot");
});

test("forged skill metadata cannot widen pinned reader roots", async () => {
  const { snapshot, skills } = await fixture();
  const runner = client();
  const spoof = skills.find(s => s.name === "nt-story-orchestrate")!;
  const catalog = skills.find(s => s.name === "nt-catalog")!;
  const forged = [
    { ...spoof, name: "nt-catalog" },
    { ...catalog, baseDir: join(snapshot.path, "skills") },
  ] as Skill[];
  const reader = (await createSandboxPiTools(job, snapshot, forged, runner,
    "read-only", "specialist")).find(t => t.name === "read")!;
  await assert.rejects(call(reader, { path: spoof.filePath }), /Skill read denied/);
  await assert.rejects(call(reader, { path: catalog.filePath }), /Skill read denied/);
  assert.equal(runner.calls.length, 0, "untrusted resource roots never reach sandbox or host");
});

test("hosted context reads complete verified Markdown only through sandbox, including multi-chunk Unicode", async () => {
  const content = "A chapter: ☕\n".repeat(4100);
  const data = Buffer.from(content);
  let calls = 0;
  const runner = {
    async execute(_id: string, args: string[], output: (stream: "stdout" | "stderr", data: string) => void) {
      calls++;
      assert.equal(args[0], "sh");
      assert.equal(args[4], "/story/events/chapter.md");
      const index = Number(args[5]);
      const chunk = data.subarray(index * 24576, (index + 1) * 24576);
      output("stdout", createHash("sha256").update(data).digest("hex") + "\n" + chunk.toString("base64"));
      return 0;
    },
  };
  const actual = await readSandboxContextFile(job, "events/chapter.md", runner);
  assert.equal(actual, content);
  assert.ok(calls >= 2);
  for (const path of ["/etc/private.md", "../other/events/private.md", ".story-inbox/ideas/private.md"]) {
    await assert.rejects(readSandboxContextFile(job, path, runner), /denied/);
  }
  assert.equal(calls, Math.ceil(data.length / 24576));
});

test("hosted context cannot fall back to host files on container errors or changed bytes", async () => {
  const path = join(job.worktreeStoryRoot, "events", "chapter.md");
  mkdirSync(join(job.worktreeStoryRoot, "events"), { recursive: true });
  writeFileSync(path, "Host-only private data should not leak.\n");
  const broken = {
    async execute() { throw new Error("controller offline"); },
  };
  await assert.rejects(readSandboxContextFile(job, "events/chapter.md", broken), /controller offline/);
  const corrupt = {
    async execute(_id: string, _args: string[], output: (stream: "stdout" | "stderr", data: string) => void) {
      output("stdout", createHash("sha256").update("different").digest("hex") + "\n" +
        Buffer.from("Injected bytes").toString("base64"));
      return 0;
    },
  };
  await assert.rejects(readSandboxContextFile(job, "events/chapter.md", corrupt), /changed during read/);
});

test("real rootless sandbox image executes all seven Pi tool operations without host tools", {
  skip: process.env.NT_TEST_ROOTLESS_SANDBOX !== "1",
}, async () => {
  const { snapshot, skills } = await fixture();
  const story = join(base, "mounted-story");
  const arcs = join(story, "arcs");
  const choicePoints = join(story, "choice-points");
  const authoredContent = join(story, "authored-content");
  for (const dir of [arcs, choicePoints, authoredContent]) mkdirSync(dir, { recursive: true });
  const name = "noveltea-pi-test-" + process.pid;
  const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  const created = docker("run", "-d", "--name", name,
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "0:0",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--mount", "type=bind,source=" + story + ",target=/story",
    "noveltea-sandbox:local", "sleep", "infinity");
  assert.equal(created.status, 0, created.stderr);
  try {
    const remote = {
      async acquire(id: string) { return { jobId: id, status: "running" }; },
      async execute(_id: string, argv: string[], output: (stream: "stdout" | "stderr", data: string) => void, stdin?:Buffer) {
        const result = spawnSync("docker",["exec",...(stdin?["-i"]:[]),"--workdir","/story",name,...argv],{encoding:"utf8",timeout:60000,input:stdin});
        if (result.stdout) output("stdout", result.stdout);
        if (result.stderr) output("stderr", result.stderr);
        return result.status ?? 1;
      },
    };
    const tools = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, remote))
      .map(t => [t.name, t])) as Record<string, Awaited<ReturnType<typeof createSandboxPiTools>>[number]>;
    await call(tools.write!, { path: "arcs/chapter.md", content: "Opening scene\n" });
    assert.match(JSON.stringify((await call(tools.read!, { path: "arcs/chapter.md" })).content), /Opening scene/);
    assert.equal(await readSandboxContextFile(job, "arcs/chapter.md", remote), "Opening scene\n");
    const larger = "Canonical evidence with Unicode ☕\n".repeat(1900);
    await call(tools.write!, { path: "arcs/large.md", content: larger });
    assert.equal(await readSandboxContextFile(job, "arcs/large.md", remote), larger);
    await call(tools.edit!, {path:"arcs/large.md",edits:[{oldText:larger,newText:larger+"Tail marker.\n"}]});
    assert.equal(readFileSync(join(arcs,"large.md"),"utf8"),larger+"Tail marker.\n");
    await call(tools.edit!, { path: "arcs/chapter.md", edits: [{ oldText: "Opening", newText: "Closing" }] });
    assert.equal(readFileSync(join(arcs, "chapter.md"), "utf8"), "Closing scene\n");
    await call(tools.write!, { path: "choice-points/decision.md", content: "A real choice.\n" });
    await call(tools.write!, { path: "authored-content/dialogue.md", content: "A real scene.\n" });
    await call(tools.write!, { path: "future-record-type/sample.md", content: "New Story type.\n" });
    assert.equal(readFileSync(join(story, "future-record-type/sample.md"), "utf8"), "New Story type.\n");
    assert.equal(readFileSync(join(choicePoints, "decision.md"), "utf8"), "A real choice.\n");
    assert.equal(readFileSync(join(authoredContent, "dialogue.md"), "utf8"), "A real scene.\n");
    const readonly = Object.fromEntries((await createSandboxPiTools(job, snapshot, skills, remote, "read-only"))
      .map(tool => [tool.name, tool]));
    assert.deepEqual(Object.keys(readonly), [...SANDBOX_READ_ONLY_TOOLS]);
    assert.match(JSON.stringify((await call(readonly.read!, { path: "authored-content/dialogue.md" })).content), /A real scene/);
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

test("sandbox file write recovery only reacquires an explicitly rejected absent container", async () => {
  const {snapshot,skills}=await fixture();
  for(const [status,disposition,expected] of [[404,"rejected",2],[413,"rejected",1],[503,"uncertain",1]] as const) {
    const runner=client();
    const original=runner.execute.bind(runner);
    let attempts=0;
    runner.execute=async (...args)=>{
      if(args[1][3]==="nt-write" && ++attempts===1)throw new SandboxExecutionError(status,disposition);
      return original(...args);
    };
    const writer=(await createSandboxPiTools(job,snapshot,skills,runner)).find(t=>t.name==="write")!;
    if(expected===2)await call(writer,{path:"arcs/chapter.md",content:"a".repeat(15000)});
    else await assert.rejects(call(writer,{path:"arcs/chapter.md",content:"a".repeat(15000)}),/HTTP/);
    assert.equal(attempts,expected);
    assert.equal(runner.acquired,expected);
    await assert.rejects(call(writer,{path:"arcs/chapter.md",content:"a".repeat(SANDBOX_RECORD_BYTES+1)}),/1 MiB/);
  }
});

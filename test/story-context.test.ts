import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { StoryContextReader, completedContextReads, createStoryContextTool } from "../src/story-context.js";

const temp = mkdtempSync(join(tmpdir(), "nt-story-context-"));
after(() => rmSync(temp, { force: true, recursive: true }));
let index = 0;
function story() {
  const root = join(temp, "story-" + ++index);
  mkdirSync(join(root, "events"), { recursive: true });
  writeFileSync(join(root, "events", "only.md"), "Canonical event body.\n");
  mkdirSync(join(root, ".story-inbox", "ideas"), { recursive: true });
  writeFileSync(join(root, ".story-inbox", "ideas", "secret.md"), "Dormant author idea.\n");
  return root;
}

test("temporary CLI-absent fallback only reads explicit scheduler files, with no invented graph", async () => {
  const root = story();
  const originalPath = process.env.PATH;
  const originalCli = process.env.NT_NATIVE_CLI;
  delete process.env.NT_NATIVE_CLI;
  process.env.PATH = join(temp, "nonexistent-bin");
  try {
    const reader = new StoryContextReader({ root,
      initialPaths: ["events/only.md", join(root, "events", "only.md")],
      task: { kind: "event", ids: ["event.only"] } });
    const first = await reader.get();
    assert.equal(first.mode, "temporary-scheduler-paths-only");
    assert.deepEqual(first.schedulerPaths, ["events/only.md"]);
    assert.equal(first.loaded[0]?.content, "Canonical event body.\n");
    assert.deepEqual(first.files, []);
    assert.ok(!JSON.stringify(first).includes("Dormant author idea"));
    writeFileSync(join(root, "events", "only.md"), "Changed event.\n");
    const refreshed = await reader.get();
    assert.equal(refreshed.loaded[0]?.content, "Changed event.\n");
    await assert.rejects(reader.get({ ids: ["event.extra"], reason: "A necessary downstream event source." }),
      /require an installed native/);
    const tool = createStoryContextTool(reader);
    const call = await tool.execute("call", {}, undefined as never, undefined as never);
    assert.match(JSON.stringify(call), /unchanged/);
    assert.ok(JSON.stringify(call).includes("events/only.md"));
  } finally {
    process.env.PATH = originalPath;
    if (originalCli === undefined) delete process.env.NT_NATIVE_CLI;
    else process.env.NT_NATIVE_CLI = originalCli;
  }
});

test("hosted context reader never substitutes a host read when sandbox is unavailable", async () => {
  const root = story();
  let attempts = 0;
  const reader = new StoryContextReader({ root, initialPaths: ["events/only.md"],
    readContent: async path => { assert.equal(path, "events/only.md"); attempts++; throw new Error("Sandbox controller unavailable"); } });
  await assert.rejects(reader.get(), /Sandbox controller unavailable/);
  assert.equal(attempts, 1);
  assert.deepEqual(reader.loadedRevisions(), {});
});

test("explicit missing CLI fails closed instead of silently substituting a resolver", async () => {
  const reader = new StoryContextReader({ root: story(), initialPaths: ["events/only.md"],
    cli: join(temp, "no-native-cli"), task: { kind: "event", ids: ["event.only"] } });
  await assert.rejects(reader.get(), /executable failed/);
});

test("context refuses private, traversal, symlinked and oversized scheduler paths", async () => {
  const root = story();
  for (const path of ["../other.md", ".story-inbox/ideas/secret.md", "events/../../other.md",
    join(temp, "outside.md")]) {
    await assert.rejects(new StoryContextReader({ root, initialPaths: [path] }).get(),
      /Unsafe canonical context path/);
  }
  symlinkSync(join(root, ".story-inbox", "ideas", "secret.md"), join(root, "events", "link.md"));
  await assert.rejects(new StoryContextReader({ root, initialPaths: ["events/link.md"] }).get(),
    /Unsafe or oversized canonical Story file/);
  writeFileSync(join(root, "events", "huge.md"), "x".repeat(129 * 1024));
  await assert.rejects(new StoryContextReader({ root, initialPaths: ["events/huge.md"] }).get(),
    /Unsafe or oversized/);
});

test("batch byte cap advances through large files without starving pending scheduler paths", async () => {
  const root = story();
  writeFileSync(join(root, "events", "one.md"), "a".repeat(115 * 1024));
  writeFileSync(join(root, "events", "two.md"), "b".repeat(115 * 1024));
  const reader = new StoryContextReader({ root,
    initialPaths: ["events/one.md", "events/two.md"] });
  const first = await reader.get({ batchLimit: 32 });
  assert.deepEqual(first.loaded.map(f => f.path), ["events/one.md"]);
  assert.deepEqual(first.pending, ["events/two.md"]);
  const second = await reader.get({ batchLimit: 32 });
  assert.deepEqual(second.unchanged, ["events/one.md"]);
  assert.deepEqual(second.loaded.map(f => f.path), ["events/two.md"]);
  assert.deepEqual(second.pending, []);
});

test("only completed genuine story_context tool results count as source-read evidence", () => {
  const root = story();
  const result = (id: string, path: string, isError = false) => ({
    role: "toolResult", toolCallId: id, isError,
    content: [{ type: "text", text: JSON.stringify({
      loaded: [{ path, content: "Story file bytes." }],
    }) }],
  });
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", id: "native", name: "story_context" },
      { type: "toolCall", id: "fake", name: "bash" },
      { type: "toolCall", id: "bad", name: "story_context" },
      { type: "toolCall", id: "private", name: "story_context" },
    ] },
    result("native", "events/only.md"),
    result("fake", "events/other.md"),
    result("bad", "events/failed.md", true),
    result("private", ".story-inbox/ideas/secret.md"),
  ] as unknown as Parameters<typeof completedContextReads>[0];
  assert.deepEqual(completedContextReads(messages, root), ["events/only.md"]);
});

test("native standalone Context Manifest: status, inclusion evidence, batches, fresh revisions and invalid target",
  { skip: !process.env.NT_NATIVE_CLI || !process.env.NT_SKILLS_CHECKOUT }, async () => {
    const source = resolve(process.env.NT_SKILLS_CHECKOUT!, "fixtures/reference-story");
    assert.ok(existsSync(source), "Need the reference Story checkout for native cutover test.");
    const root = join(temp, "native-story");
    cpSync(source, root, { recursive: true });
    const options = { root, initialPaths: [], cli: process.env.NT_NATIVE_CLI!,
      task: { kind: "event" as const, ids: ["event.question-ivo"], scope: "focused" as const } };
    const reader = new StoryContextReader(options);
    const first = await reader.get({ batchLimit: 1 });
    assert.equal(first.mode, "native-context-manifest");
    assert.ok(first.files.some(f => f.path === "events/question-ivo.md" &&
      f.status === "draft" && f.sourceRevision.startsWith("xxh3-128:") &&
      f.inclusions.some(i => i.code === "requested-id" && i.sourceId === "event.question-ivo")));
    assert.equal(first.loaded.length, 1);
    assert.ok(first.pending.length > 0);
    const revisions = first.files.map(f => [f.path, f.sourceRevision]);
    const next = await reader.get({ batchLimit: 32 });
    assert.equal(next.pending.length, 0);
    assert.ok(next.unchanged.includes(first.loaded[0]!.path));
    assert.deepEqual(next.files.map(f => [f.path, f.sourceRevision]), revisions);
    assert.ok(!JSON.stringify(next).includes(".story-inbox/ideas/"));
    const changed = "events/question-ivo.md";
    appendFileSync(join(root, changed), "\nA new sentence revealing no new facts.\n");
    const refresh = await reader.get({ batchLimit: 32 });
    assert.ok(refresh.loaded.some(f => f.path === changed));
    assert.notEqual(refresh.files.find(f => f.path === changed)?.sourceRevision,
      first.files.find(f => f.path === changed)?.sourceRevision);
    assert.ok(refresh.unchanged.length > 0);
    const positioned = await reader.get({ position: "narrative-position.after-question",
      reason: "Inspect the point-in-Event knowledge at the question.", batchLimit: 32 });
    assert.ok(positioned.files.some(f => f.id === "narrative-position.after-question" &&
      f.inclusions.some(i => i.code === "requested-position")));
    const current = readFileSync(join(root, changed), "utf8");
    writeFileSync(join(root, changed), current.replace("status: draft", "status: approved"));
    const approved = await reader.get({ batchLimit: 32 });
    assert.equal(approved.files.find(f => f.path === changed)?.status, "approved");
    assert.ok(approved.loaded.some(f => f.path === changed));
    await assert.rejects(reader.get({ ids: ["event.unknown"], reason: "Check the missing referenced Event." }),
      /invalid-target-id/);
    assert.equal(readFileSync(join(root, changed), "utf8").includes("new sentence"), true);
  });

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type NarrativeTaskKind = "dialogue" | "event" | "character" | "puzzle" | "milestone" | "review";
export interface StoryContextRequest {
  kind?: NarrativeTaskKind;
  ids?: string[];
  position?: string;
  scope?: "focused" | "related";
  batchLimit?: number;
  reason?: string;
}
export interface StoryContextOptions {
  root: string;
  /** The scheduler's narrowly selected paths; not a second relationship resolver. */
  initialPaths: string[];
  task?: StoryContextRequest;
  /** Existing, successfully read Pi Story files when forking a session. */
  previouslyRead?: Record<string, string>;
  cli?: string;
}
interface NativeFile {
  path: string;
  id: string;
  sourceRevision: string;
  status: string;
  completeness: string;
  dependency: string;
  priority: string;
  inclusions: Array<{ code: string; sourceId: string; targetId: string; pointer?: string }>;
}
interface NativeManifest {
  contractRevision: string;
  files: NativeFile[];
  unresolved: unknown[];
  bounded: { truncated: boolean; maxDepth: number; maxFiles: number };
  coverageStatus: string;
}
interface NativeReply {
  success: boolean;
  diagnostics?: Array<{ code: string; message: string }>;
  manifest?: NativeManifest;
}
const validKinds = new Set<NarrativeTaskKind>(["dialogue", "event", "character", "puzzle", "milestone", "review"]);
const relativeFile = (root: string, path: string): string => {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(p => !p || p.startsWith(".")) || !path.endsWith(".md"))
    throw new Error("Unsafe canonical context path: " + path);
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Canonical context path leaves Story root: " + path);
  return full;
};
async function safeRead(root: string, path: string): Promise<string> {
  const full = relativeFile(root, path);
  const before = await lstat(full);
  if (!before.isFile() || before.size > 128 * 1024 || await realpath(full) !== full)
    throw new Error("Unsafe or oversized canonical Story file: " + path);
  const body = await readFile(full, "utf8");
  const after = await lstat(full);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
    throw new Error("Canonical Story file changed during context read: " + path);
  return body;
}
function fetchNative(root: string, cli: string, request: StoryContextRequest, allowFallback: boolean):
  { mode: "native"; manifest: NativeManifest } | { mode: "absent" } {
  if (!request.kind || !validKinds.has(request.kind) ||
      (!request.ids?.length && !request.position))
    throw new Error("Native Story context requires a task kind and a typed target ID or Narrative Position.");
  if (request.ids?.some(id => !/^[a-z][a-z-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) ||
      (request.position && !/^narrative-position\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.position)))
    throw new Error("Invalid typed Story context target.");
  const args = ["--json", "narrative", "context", root, "--kind", request.kind,
    ...request.ids?.flatMap(id => ["--id", id]) ?? [],
    ...(request.position ? ["--position", request.position] : []),
    "--scope", request.scope ?? "related"];
  const result = spawnSync(cli, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT" && allowFallback)
    return { mode: "absent" };
  if (result.error) throw new Error("Native narrative context executable failed: " + result.error.message);
  let reply: NativeReply;
  try { reply = JSON.parse(result.stdout) as NativeReply; }
  catch { throw new Error("Native CLI did not return the public narrative Context Manifest JSON contract."); }
  if (result.status !== 0 || !reply.success || !reply.manifest)
    throw new Error("Native narrative context rejected the request: " +
      JSON.stringify(reply.diagnostics ?? []).slice(0, 2000));
  const manifest = reply.manifest;
  if (!manifest.contractRevision || !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.unresolved) || !manifest.bounded ||
      typeof manifest.bounded.truncated !== "boolean" ||
      manifest.files.some(f => !f.id || !f.sourceRevision || !f.status || !f.priority ||
        !Array.isArray(f.inclusions) || f.inclusions.some(i => !i.code || !i.sourceId || !i.targetId))) {
    throw new Error("Native CLI returned an incomplete or incompatible Context Manifest.");
  }
  if (manifest.bounded.truncated)
    throw new Error("Native Context Manifest was truncated; narrow the typed task/scope before reading.");
  for (const f of manifest.files) relativeFile(root, f.path);
  return { mode: "native", manifest };
}

/** One Pi session's selective, revision-aware batch reader. Never parses Story relationships. */
export class StoryContextReader {
  private seen: Map<string, string>;
  constructor(private readonly options: StoryContextOptions) {
    this.seen = new Map(Object.entries(options.previouslyRead ?? {}));
  }
  loadedRevisions(): Record<string, string> { return Object.fromEntries(this.seen); }
  async get(request: StoryContextRequest = {}) {
    const query: StoryContextRequest = { ...this.options.task, ...request };
    const changedTarget = request.ids !== undefined &&
      JSON.stringify(request.ids) !== JSON.stringify(this.options.task?.ids ?? []) ||
      request.position !== undefined && request.position !== this.options.task?.position;
    if (changedTarget && (!request.reason || request.reason.trim().length < 10))
      throw new Error("Additional typed Story lookups require an explicit reason.");
    const batchLimit = query.batchLimit ?? 12;
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 32)
      throw new Error("Context batchLimit must be between 1 and 32.");
    const hasTask = query.kind && (query.ids?.length || query.position);
    const native = hasTask ? fetchNative(this.options.root,
      this.options.cli ?? process.env.NT_NATIVE_CLI ?? "noveltea", query,
      !this.options.cli && !process.env.NT_NATIVE_CLI) : { mode: "absent" as const };
    if (native.mode === "absent" && (request.ids?.length || request.position))
      throw new Error("Additional typed Story lookups require an installed native 'noveltea narrative context' CLI.");
    // Until a native CLI is installed, use only the scheduler's already-authorized
    // paths. No independent traversal, graph reconstruction, or broad discovery.
    const nativeFiles = native.mode === "native" ? native.manifest.files : [];
    const manifestPaths = new Set(nativeFiles.map(f => f.path));
    const schedulerPaths = this.options.initialPaths.filter(p => p.endsWith(".md"))
      .map(p => isAbsolute(p) ? relative(this.options.root, p).split(sep).join("/") : p);
    const schedulerFiles = [...new Set(schedulerPaths)]
      .filter(path => !manifestPaths.has(path))
      .map(path => ({ path, id: "", sourceRevision: "", status: "scheduler-only",
        completeness: "unverified", dependency: "unverified", priority: "supplementary",
        inclusions: [] as NativeFile["inclusions"] }));
    const files = [...nativeFiles, ...schedulerFiles];
    const loaded: Array<{ path: string; id: string; sourceRevision: string; content: string }> = [];
    let loadedBytes = 0;
    const maxBatchBytes = 192 * 1024;
    const pending: string[] = [];
    const unchanged: string[] = [];
    for (const file of files) {
      relativeFile(this.options.root, file.path);
      if (file.sourceRevision && this.seen.get(file.path) === file.sourceRevision) {
        unchanged.push(file.path); continue;
      }
      // A full batch must not read the rest of the manifest just to mark it pending.
      // Native revisions already let us skip unchanged files above.
      if (loaded.length >= batchLimit) { pending.push(file.path); continue; }
      // The temporary fallback only fingerprints *explicit* scheduler paths;
      // it never parses links or reconstructs the canonical relationship graph.
      const content = await safeRead(this.options.root, file.path);
      const version = file.sourceRevision || "sha256:" + createHash("sha256").update(content).digest("hex");
      if (this.seen.get(file.path) === version) { unchanged.push(file.path); continue; }
      if (loaded.length >= batchLimit) { pending.push(file.path); continue; }
      const size = Buffer.byteLength(content, "utf8");
      if (loadedBytes + size > maxBatchBytes && loaded.length) {
        pending.push(file.path); continue;
      }
      loadedBytes += size;
      loaded.push({ path: file.path, id: file.id, sourceRevision: version, content });
      this.seen.set(file.path, version);
    }
    return {
      mode: native.mode === "native" ? "native-context-manifest" : "temporary-scheduler-paths-only",
      ...(native.mode === "native" ? { contractRevision: native.manifest.contractRevision,
        coverageStatus: native.manifest.coverageStatus,
        unresolved: native.manifest.unresolved } : {
        limitation: "No native CLI: initial scheduler paths only, no typed relationship expansion or verified revisions." }),
      files: nativeFiles, schedulerPaths: schedulerFiles.map(f => f.path), loaded, unchanged, pending,
      ...(changedTarget ? { lookupReason: request.reason } : {}),
      guidance: pending.length ? "Call story_context again with the same task to read the remaining batch." :
        "Reinvoke story_context after Story edits to refresh changed source revisions.",
    };
  }
}

/** Proof of actual batch reads, from successful Pi tool results rather than model claims.
 * Does not count pinned skills (which must still be read using Pi's read tool). */
export function completedContextReads(messages: AgentSession["messages"], root: string): string[] {
  const results = new Map(messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
    m.role === "toolResult" && !m.isError).map(m => [m.toolCallId, m]));
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.content) {
      if (call.type !== "toolCall" || call.name !== "story_context") continue;
      const result = results.get(call.id);
      if (!result) continue;
      for (const chunk of result.content) {
        if (chunk.type !== "text") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(chunk.text); } catch { continue; }
        const loaded = (parsed as { loaded?: unknown } | null)?.loaded;
        if (!Array.isArray(loaded)) continue;
        for (const item of loaded) {
          if (!item || typeof item.path !== "string" || typeof item.content !== "string") continue;
          try { relativeFile(root, item.path); paths.add(item.path); } catch { /* never trust unsafe paths */ }
        }
      }
    }
  }
  return [...paths];
}

export function createStoryContextTool(reader: StoryContextReader): ToolDefinition {
  return {
    name: "story_context",
    label: "Read current canonical Story context",
    description: "Ask the public native Context Manifest for relevant canonical Story files and batch-read only new or revised Markdown. " +
      "Defaults to this specialist's assigned task; use typed IDs/position for justified extra lookups. Read-only; not edit authority.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...validKinds] },
        ids: { type: "array", items: { type: "string" } },
        position: { type: "string" },
        scope: { type: "string", enum: ["focused", "related"] },
        batchLimit: { type: "integer", minimum: 1, maximum: 32 },
        reason: { type: "string", description: "Why a new typed target or Narrative Position is needed for this task." },
      },
      additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, params) {
      const result = await reader.get(params as StoryContextRequest);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  };
}

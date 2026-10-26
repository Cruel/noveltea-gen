import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, RunTree } from "langsmith";
import { withRunTree } from "langsmith/traceable";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

const DEFAULT_DIR = fileURLToPath(new URL("../.local/traces", import.meta.url));
const SENSITIVE_FIELD = /(?:api[_-]?key|authorization|password|secret|credential|access[_-]?token|refresh[_-]?token|cookie)/i;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

export function localTraceDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.NT_LOCAL_TRACE_DIR || DEFAULT_DIR);
}

/**
 * Local debug traces can contain prompts, model outputs, and skill reference
 * content. Sanitize known credential-bearing keys and configured secret values
 * while preserving the payload needed for graph debugging.
 */
export function sanitizeTrace(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SENSITIVE_FIELD.test(name) && (value?.length ?? 0) >= 8)
    .map(([, value]) => value!);
  const visited = new WeakSet<object>();
  function clean(v: unknown, depth: number): unknown {
    if (typeof v === "string") {
      let text = v.length > 131072 ? v.slice(0, 131072) + "[TRUNCATED]" : v;
      for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
      return text;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (v === undefined) return null;
    if (typeof v !== "object") return String(v);
    if (depth > 20) return "[DEPTH LIMIT]";
    if (visited.has(v)) return "[CIRCULAR]";
    visited.add(v);
    let result: unknown;
    if (Array.isArray(v)) {
      result = v.slice(0, 2048).map((child) => clean(child, depth + 1));
    } else {
      result = Object.fromEntries(Object.entries(v).map(([key, child]) => [
        key, SENSITIVE_FIELD.test(key) ? "[REDACTED]" : clean(child, depth + 1),
      ]));
    }
    visited.delete(v);
    return result;
  }
  return clean(value, 0);
}

export type LocalTraceEvent = {
  action: "create" | "update";
  id: string;
  recordedAt: string;
  run: Record<string, unknown>;
};

/**
 * No network path exists in this Client: every SDK trace write is redirected
 * into an append-only local file. In particular createRun/updateRun NEVER call
 * super; Pi extension and LangGraph inherit this exact client from the root.
 */
export async function startLocalTrace(cloud = false): Promise<{
  client: Client;
  file: string;
  close: () => Promise<void>;
}> {
  const dir = localTraceDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let pending = Promise.resolve();
  let closed = false;
  function record(action: LocalTraceEvent["action"], id: string, run: object): Promise<void> {
    if (closed) throw new Error("Local trace recorder was closed before all spans settled.");
    const event = sanitizeTrace({ action, id, recordedAt: new Date().toISOString(), run }) as LocalTraceEvent;
    const raw = JSON.stringify(event);
    // Never let provider payloads exhaust local disk space per event.
    if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) {
      event.run = { name: (run as { name?: string }).name, omitted: "event exceeds 4 MiB" };
    }
    const line = JSON.stringify(event) + "\n";
    pending = pending.then(async () => { await handle.writeFile(line, "utf8"); });
    return pending;
  }
  const client = new Client(cloud ? { autoBatchTracing: false } : {
    apiUrl: "http://127.0.0.1:1", apiKey: "LOCAL_CAPTURE_ONLY",
    autoBatchTracing: false,
  });
  const postRemote = client.createRun.bind(client);
  const patchRemote = client.updateRun.bind(client);
  const flushRemote = client.awaitPendingTraceBatches.bind(client);
  client.createRun = async (run, options) => {
    await record("create", String(run.id), run);
    if (cloud) await postRemote(run, options);
  };
  client.updateRun = async (id, run, options) => {
    await record("update", String(id), run);
    if (cloud) await patchRemote(id, run, options);
  };
  client.awaitPendingTraceBatches = async () => {
    await pending;
    if (cloud) await flushRemote();
  };
  return {
    client, file,
    async close() {
      if (closed) return;
      // LangGraph schedules callback work asynchronously; invoke() returning
      // does not mean all child node spans have been created/patched yet.
      await awaitAllCallbacks();
      await client.awaitPendingTraceBatches();
      await pending;
      closed = true;
      await handle.close();
    },
  };
}

/** Locally record a LangGraph invocation and all SDK child spans. */
export async function recordLocalGraph<T>(
  capture: Awaited<ReturnType<typeof startLocalTrace>>,
  task: () => Promise<T>,
  context: { projectId: string; threadId: string },
): Promise<T> {
  const root = new RunTree({
    name: "NovelTea LangGraph execution",
    run_type: "chain",
    project_name: "noveltea-gen-local",
    client: capture.client,
    tracingEnabled: true,
    metadata: { "noveltea.project_id": context.projectId, "noveltea.thread_id": context.threadId },
    inputs: { threadId: context.threadId },
  });
  await root.postRun();
  let failure: unknown;
  try {
    return await withRunTree(root, task);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // All callbacks must settle before the root patch is committed. This
    // avoids traceable()'s intentionally asynchronous root patch lifecycle.
    await awaitAllCallbacks();
    await root.end(failure ? { completed: false } : { completed: true },
      failure instanceof Error ? failure.message : failure ? "Unknown graph error" : undefined);
    await root.patchRun();
  }
}

export type LocalSpan = {
  id: string;
  parent_run_id?: string;
  name: string;
  run_type: string;
  start_time?: string | number;
  end_time?: string | number;
  error?: string;
  inputs?: unknown;
  outputs?: unknown;
  extra?: unknown;
};

export async function readLocalTrace(path: string): Promise<LocalSpan[]> {
  const bytes = await readFile(path, "utf8");
  const spans = new Map<string, LocalSpan>();
  for (const line of bytes.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as LocalTraceEvent;
    if ((event.action !== "create" && event.action !== "update") ||
        !event.id || typeof event.run !== "object" || !event.run) {
      throw new Error("Malformed local trace event.");
    }
    const previous = spans.get(event.id) ?? { id: event.id, name: "(pending)", run_type: "chain" };
    spans.set(event.id, { ...previous, ...event.run, id: event.id } as LocalSpan);
  }
  return [...spans.values()];
}

export async function latestLocalTrace(dir = localTraceDir()): Promise<string> {
  const entries = (await readdir(dir)).filter(name => /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/.test(name));
  if (!entries.length) throw new Error("No local traces found. Run with --trace-local.");
  const ordered = await Promise.all(entries.map(async name => ({
    name, modified: (await stat(join(dir, name))).mtimeMs,
  })));
  ordered.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  return join(dir, ordered[0]!.name);
}

function milliseconds(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}

export function formatLocalTrace(spans: LocalSpan[]): string {
  const children = new Map<string, LocalSpan[]>();
  const ids = new Set(spans.map(x => x.id));
  for (const span of spans) {
    const parent = span.parent_run_id && ids.has(span.parent_run_id) ? span.parent_run_id : "";
    const list = children.get(parent) ?? [];
    list.push(span);
    children.set(parent, list);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  function visit(parent: string, depth: number) {
    for (const span of children.get(parent) ?? []) {
      if (seen.has(span.id)) continue;
      seen.add(span.id);
      const start = milliseconds(span.start_time);
      const end = milliseconds(span.end_time);
      const duration = start !== undefined && end !== undefined ? ` ${Math.max(0, end - start)}ms` : "";
      const metadata = span.extra && typeof span.extra === "object" && "metadata" in span.extra
        ? (span.extra as { metadata?: Record<string, unknown> }).metadata : undefined;
      const usage = metadata?.usage_metadata as { total_tokens?: number } | undefined;
      const tokens = usage?.total_tokens !== undefined ? ` tokens=${usage.total_tokens}` : "";
      lines.push(`${"  ".repeat(depth)}${span.error ? "ERROR" : span.end_time ? "OK" : "OPEN"} [${span.run_type}] ${span.name}${duration}${tokens}`);
      if (span.error) lines.push(`${"  ".repeat(depth + 1)}${span.error}`);
      visit(span.id, depth + 1);
    }
  }
  visit("", 0);
  return lines.join("\n");
}

/** Minimal read-only CLI: tree summary by default, full spans on --json. */
export async function showLocalTrace(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const fileIndex = args.indexOf("--file");
  const selectedFile = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const unknown = args.filter((arg, index) =>
    arg !== "--json" && arg !== "--latest" &&
    arg !== "--file" && index !== fileIndex + 1);
  if (unknown.length || (fileIndex >= 0 && (!selectedFile || selectedFile.startsWith("--"))) ||
      (selectedFile && args.includes("--latest"))) {
    throw new Error("Usage: pnpm trace:show [--latest | --file <path>] [--json]");
  }
  const file = selectedFile ? resolve(selectedFile) : await latestLocalTrace();
  const spans = await readLocalTrace(file);
  if (json) process.stdout.write(JSON.stringify({ file, spans }, null, 2) + "\n");
  else process.stdout.write(`Local trace: ${file}\nSpans: ${spans.length}\n${formatLocalTrace(spans)}\n`);
}

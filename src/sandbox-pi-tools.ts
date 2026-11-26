/**
 * Pi's file/search/shell capabilities in the hosted Story worker. The only
 * ordinary filesystem visible to these tools is the controller's /story
 * projection; never construct a local Pi tool as an error fallback.
 *
 * Pinned skill references are deliberately not bind-mounted into a writable
 * container. The only exception is a digest-verified, read-only skill resource
 * served by the trusted worker, not an arbitrary host filesystem read.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SANDBOX_RECORD_BYTES, SANDBOX_READ_PAGE_BYTES, SANDBOX_MODEL_OUTPUT_BYTES } from "./sandbox-limits.js";
import { SandboxClient, SandboxExecutionError } from "./sandbox-client.js";
import { createSkillReadTool, roleVisibleSkills, type SkillReadRole } from "./skills.js";
import { verifiedSkillFiles, type SkillSnapshot } from "./snapshot.js";
import { adaptiveTrackedReadPaths, assertAdaptiveExposedRead } from "./adaptive-source-reads.js";
import type { JobStartResult } from "./job.js";

export const SANDBOX_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export const SANDBOX_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export type SandboxToolAccess = "writer" | "read-only";
export type SandboxReadScope = "story-and-skills" | "pinned-skills-only" |
  { kind: "adaptive"; sourceSha: string };
const MAX_WRITE = SANDBOX_RECORD_BYTES;
const MAX_READ_LINES = 500;
const MAX_OUTPUT = SANDBOX_MODEL_OUTPUT_BYTES;
const schema = (properties: Record<string, object>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false }) as ToolDefinition["parameters"];
const str = { type: "string" };
const optionalNum = { type: "number" };
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
type Input = Record<string, unknown>;
type Runner = Pick<SandboxClient, "acquire" | "execute">;

/** Trusted persisted consent cannot coexist with same-user host shell tools.
 * This applies to standalone CLI jobs as well as hosted jobs. */
export function sandboxToolsRequired(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true;
}

/** Until the remaining specialist stages are routed, refuse any hosted local fallback. */
export function blockUnroutedHostedPi(stage: string): void {
  if (sandboxToolsRequired()) {
    throw new Error("Hosted Pi " + stage + " is not yet sandbox-routed; refused unsafe host fallback.");
  }
}

/**
 * Both CLI and hosted sessions must acquire an isolated registered job.
 * A missing controller is a blocked configuration, never a local fallback.
 * Every Pi session must acquire a verified registered job before
 * receiving ANY model-accessible file tools.
 */
export async function selectSandboxPiTools(
  job: JobStartResult, snapshot: SkillSnapshot, skills: Skill[],
  client?: Runner, access: SandboxToolAccess = "writer", role: SkillReadRole = "specialist",
  readScope: SandboxReadScope = "story-and-skills",
): Promise<ToolDefinition[] | undefined> {
  if (!process.env.NT_SANDBOX_SOCKET || !process.env.NT_SANDBOX_TOKEN_FILE) {
    throw new Error("Hosted Pi requires a configured private sandbox socket and token; no local tool fallback.");
  }
  return createSandboxPiTools(job, snapshot, skills, client ?? new SandboxClient(), access, role, readScope);
}

/** The same canonical path boundary applies to Pi's tools and model-requested context reads. */
function mappedStoryPath(job: JobStartResult, requested: unknown, allowStoryRoot = false): string {
  if (typeof requested !== "string" || requested.includes("\0") || requested.includes("\\")) {
    throw new Error("Sandbox path must be a valid Story-relative path.");
  }
  const abs = resolve(job.worktreeStoryRoot, requested || ".");
  const rel = relative(job.worktreeStoryRoot, abs);
  if (rel === "" && allowStoryRoot) return "/story";
  const parts = rel.split(sep);
  if (!rel || parts.some(p => !p || p === "." || p === ".." || p.startsWith("."))) {
    throw new Error("Pi tool path denied: outside the Story content directory.");
  }
  return "/story/" + parts.join("/");
}

/** Context Manifest resolution remains trusted, but its file bytes must come
 * from the SAME registered sandbox as the Pi tools. Read bounded base64 chunks
 * and verify a stable SHA-256; never reopen a host file if Docker fails. */
export async function readSandboxContextFile(
  job: JobStartResult, storyRelativePath: string,
  client: Pick<SandboxClient, "execute"> = new SandboxClient(),
): Promise<string> {
  if (!storyRelativePath.endsWith(".md")) throw new Error("Sandbox context requires canonical Markdown.");
  const path = mappedStoryPath(job, storyRelativePath);
  const chunkSize = SANDBOX_READ_PAGE_BYTES;
  const chunks: Buffer[] = [];
  let digest: string | undefined;
  let total = 0;
  for (let index = 0; index <= Math.floor(SANDBOX_RECORD_BYTES / chunkSize); index++) {
    let stdout = "", stderr = "";
    const script = 'file="$1"; [ -f "$file" ] && [ ! -L "$file" ] || exit 2; bytes=$(wc -c < "$file") || exit 2; [ "$bytes" -le "$3" ] || exit 3; sha256sum -- "$file" | cut -c1-64; dd if="$file" bs="$4" skip="$2" count=1 status=none | base64 -w0';
    const code = await client.execute(job.jobId,
      ["sh", "-c", script, "nt-context", path, String(index), String(SANDBOX_RECORD_BYTES), String(chunkSize)],
      (stream, data) => { if (stream === "stdout") stdout += data; else stderr += data; });
    if (code !== 0) throw new Error("Sandbox context read failed (exit " + code + "): " + stderr.slice(0, 300));
    const separator = stdout.indexOf("\n");
    const current = stdout.slice(0, separator);
    const encoded = stdout.slice(separator + 1);
    if (separator !== 64 || !/^[a-f0-9]{64}$/.test(current) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("Sandbox context returned malformed file data.");
    }
    if (digest && current !== digest) throw new Error("Sandbox context file changed during read.");
    digest = current;
    const part = Buffer.from(encoded, "base64");
    if (part.length > chunkSize || (part.length === 0 && index === 0 && digest !== createHash("sha256").update("").digest("hex"))) {
      throw new Error("Sandbox context returned an invalid chunk.");
    }
    chunks.push(part);
    total += part.length;
    if (total > SANDBOX_RECORD_BYTES) throw new Error("Sandbox context file exceeds the record limit.");
    if (part.length < chunkSize) {
      const body = Buffer.concat(chunks);
      if (createHash("sha256").update(body).digest("hex") !== digest) {
        throw new Error("Sandbox context file changed during read.");
      }
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    }
  }
  throw new Error("Sandbox context file exceeded bounded read.");
}

export async function createSandboxPiTools(
  job: JobStartResult, snapshot: SkillSnapshot, skills: Skill[], client: Runner,
  access: SandboxToolAccess = "writer", role: SkillReadRole = "specialist",
  readScope: SandboxReadScope = "story-and-skills",
): Promise<ToolDefinition[]> {
  // The host controller checks the trusted Studio catalog, worktree manifest,
  // user identity and Docker rootlessness; no model-controlled mount options.
  const acquired = await client.acquire(job.jobId);
  if (acquired.jobId !== job.jobId || acquired.status !== "running") {
    throw new Error("Sandbox acquisition did not confirm this job's running container.");
  }
  const verified = await verifiedSkillFiles(snapshot.id);
  if (verified.root !== snapshot.path) throw new Error("Pinned skill snapshot path changed.");
  const pinnedSkills = roleVisibleSkills(skills, role).filter(s =>
    s.baseDir === join(verified.root, "skills", s.name) &&
    s.filePath === join(verified.root, "skills", s.name, "SKILL.md"));
  const pinnedRead = createSkillReadTool(pinnedSkills, verified);
  const adaptiveSource = typeof readScope === "object" && readScope.kind === "adaptive"
    ? readScope.sourceSha : null;
  const adaptiveFiles = adaptiveSource === null ? null :
    adaptiveTrackedReadPaths(job, adaptiveSource);
  const adaptiveScopedFiles = (requested: unknown): string[] => {
    const path = mappedStoryPath(job, requested, true);
    const dir = path === "/story" ? "" : path.slice("/story/".length);
    return (adaptiveFiles ?? []).filter(file => !dir || file === dir || file.startsWith(dir + "/"));
  };
  const wildcard = (pattern: string): RegExp => new RegExp("^" +
    [...pattern].map(char => char === "*" ? ".*" : char === "?" ? "." :
      char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");

  const mapped = (requested: unknown, allowStoryRoot = false): string =>
    mappedStoryPath(job, requested, allowStoryRoot);
  const run = async (args: string[]): Promise<{ stdout: string; code: number }> => {
    let stdout = "", stderr = "";
    const code = await client.execute(job.jobId, args, (stream, data) => {
      if (stream === "stdout") stdout += data;
      else stderr += data;
    });
    // A nonzero status is meaningful for grep (no matches); all other tools
    // fail visibly, without retrying the command on the trusted host.
    return { stdout: (stdout + (stderr ? "\n" + stderr : "")).slice(0, MAX_OUTPUT), code };
  };
  const checked = async (argv: string[]) => {
    const result = await run(argv);
    if (result.code !== 0) throw new Error(`Sandbox command failed (exit ${result.code}); inspect the job sandbox and worktree.`);
    return result.stdout;
  };
  const number = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
      throw new Error("Invalid sandbox tool line/result limit.");
    return value;
  };
  const write = async (path: string, content: string, expected?: string) => {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_WRITE) throw new Error("Sandbox write exceeds the 1 MiB per-file limit.");
    // The controller forwards only bounded stdin to Docker; the whole record
    // never enters the command arguments. Verify size and digest before the
    // atomic rename (including interrupted or short stdin delivery).
    const script = 'dest="$1"; tmp="$2"; size="$3"; hash="$4"; expected="$5"; ' +
      'mkdir -p -- "$(dirname -- "$dest")" || exit; ' +
      'trap \'rm -f -- "$tmp"\' EXIT; ' +
      'cat > "$tmp" && [ "$(wc -c < "$tmp")" = "$size" ] && ' +
      '[ "$(sha256sum -- "$tmp" | cut -c1-64)" = "$hash" ] || exit 3; ' +
      'if [ -n "$expected" ]; then [ -f "$dest" ] && [ ! -L "$dest" ] && ' +
      '[ "$(sha256sum -- "$dest" | cut -c1-64)" = "$expected" ] || exit 4; fi; ' +
      'mv -fT -- "$tmp" "$dest"';
    const invoke = () => client.execute(job.jobId, ["sh", "-c", script, "nt-write",
      path, path + ".noveltea-write-" + randomUUID(), String(bytes.length),
      createHash("sha256").update(bytes).digest("hex"), expected ?? ""], () => {}, bytes);
    let code: number;
    try { code = await invoke(); }
    catch (error) {
      // A pre-dispatch 404 means the registered container is absent, not
      // that a writer may have executed. Only that exact rejection is
      // eligible for a bounded reacquisition, never an ambiguous failure.
      if (!(error instanceof SandboxExecutionError) || error.disposition !== "rejected" ||
          error.status !== 404) throw error;
      const restored = await client.acquire(job.jobId);
      if (restored.jobId !== job.jobId || restored.status !== "running") throw error;
      code = await invoke();
    }
    if (code !== 0) throw Error("Sandbox atomic file write failed (exit " + code + "); original file was not replaced.");
  };
  const read = async (path: string, offset: number, limit: number) => {
    const script = 'start="$1"; end="$2"; file="$3"; [ -f "$file" ] || exit 2; sed -n "${start},${end}p" -- "$file" | head -c 48000';
    return checked(["sh", "-c", script, "nt-read", String(offset), String(offset + limit - 1), path]);
  };
  const definitions: ToolDefinition[] = [
    {
      name: "read", label: "read", executionMode: "sequential", description: "Read canonical Story text in the isolated sandbox or a verified pinned skill reference.",
      parameters: schema({ path: str, offset: optionalNum, limit: optionalNum }, ["path"]),
      async execute(_id, input: Input) {
        const path = input.path;
        if (typeof path !== "string") throw new Error("Read needs a path.");
        if (path.startsWith("skill://") ||
            (isAbsolute(path) && (path === verified.root || path.startsWith(verified.root + sep)))) {
          return pinnedRead.execute(_id, { path }, undefined as never, undefined as never, undefined as never);
        }
        // A historical assignment reviewer receives the complete sealed Git
        // packet inline. A current worktree read could change its verdict;
        // reject that read at execution time, before accessing the sandbox.
        if (readScope === "pinned-skills-only")
          throw new Error("Assignment fidelity reads only immutable pinned skills; Story evidence is in the sealed review packet.");
        const offset = number(input.offset, 1, 1_000_000);
        const limit = number(input.limit, 300, MAX_READ_LINES);
        if (adaptiveSource !== null)
          await assertAdaptiveExposedRead(job, adaptiveSource, path);
        return text(await read(mapped(path), offset, limit));
      },
    },
    {
      name: "write", label: "write", executionMode: "sequential", description: "Write a canonical Story Markdown file through the sandbox only.",
      parameters: schema({ path: str, content: str }, ["path", "content"]),
      async execute(_id, input: Input) {
        if (typeof input.content !== "string") throw new Error("Write requires string content.");
        await write(mapped(input.path), input.content);
        return text("Successfully wrote " + String(input.path));
      },
    },
    {
      name: "edit", label: "edit", executionMode: "sequential", description: "Replace unique exact text regions in a canonical Story file inside the sandbox.",
      parameters: schema({ path: str, edits: { type: "array", items: { type: "object", properties: { oldText: str, newText: str }, required: ["oldText", "newText"], additionalProperties: false } } }, ["path", "edits"]),
      async execute(_id, input: Input) {
        const path = mapped(input.path);
        const edits = input.edits;
        if (!Array.isArray(edits) || !edits.length || edits.length > 30) throw new Error("Edit requires one to thirty replacements.");
        // Fetch exact bytes in digest-bound pages, independent of the
        // model-visible output budget; never silently edit truncated text.
        const before = await readSandboxContextFile(job, String(input.path), client);
        let after = before;
        const spans: { start: number; end: number; replacement: string }[] = [];
        for (const item of edits as unknown[]) {
          if (!item || typeof item !== "object" || typeof (item as Input).oldText !== "string" ||
              typeof (item as Input).newText !== "string" || !(item as Input).oldText) throw new Error("Invalid exact edit.");
          const { oldText, newText } = item as { oldText: string; newText: string };
          const start = before.indexOf(oldText);
          if (start < 0 || before.indexOf(oldText, start + 1) !== -1) throw new Error("Edit oldText must match exactly once.");
          spans.push({ start, end: start + oldText.length, replacement: newText });
        }
        spans.sort((a,b) => b.start - a.start);
        for (let i = 1; i < spans.length; i++) {
          if (spans[i]!.end > spans[i - 1]!.start) throw new Error("Overlapping sandbox edits are not allowed.");
        }
        for (const span of spans) after = after.slice(0, span.start) + span.replacement + after.slice(span.end);
        await write(path, after, createHash("sha256").update(before).digest("hex"));
        return text("Edited " + String(input.path));
      },
    },
    {
      name: "bash", label: "bash", executionMode: "sequential", description: "Execute shell commands ONLY inside the networkless /story sandbox. Git, host paths, credentials and the Docker socket are unavailable.",
      parameters: schema({ command: str, timeout: optionalNum }, ["command"]),
      async execute(_id, input: Input) {
        if (typeof input.command !== "string" || input.command.length > 3500) throw new Error("Invalid sandbox shell command.");
        // Hard 30-second controller budget; no host shell is ever spawned.
        if (input.timeout !== undefined && number(input.timeout, 30, 30) > 30) throw new Error("Sandbox command timeout exceeds 30 seconds.");
        const result = await run(["bash", "-lc", input.command]);
        return text(result.stdout + (result.code ? `\n(exit code ${result.code})` : ""));
      },
    },
    {
      name: "grep", label: "grep", executionMode: "sequential", description: "Search canonical Story files inside the sandbox.",
      parameters: schema({ pattern: str, path: str, glob: str, ignoreCase: { type: "boolean" }, literal: { type: "boolean" }, context: optionalNum, limit: optionalNum }, ["pattern"]),
      async execute(_id, input: Input) {
        if (typeof input.pattern !== "string") throw new Error("Invalid grep pattern.");
        const path = mapped(input.path ?? ".", true);
        const limit = number(input.limit, 100, 500);
        const context = input.context === undefined ? 0 : number(input.context, 1, 20);
        const opts = ["-RIn", "--binary-files=without-match", "--exclude-dir=.*", ...(input.ignoreCase ? ["-i"] : []),
          ...(input.literal ? ["-F"] : ["-E"]), ...(context ? ["-C", String(context)] : []),
          ...(typeof input.glob === "string" ? ["--include=" + input.glob] : []),
          "-m", String(limit), "--", input.pattern];
        // In an adaptive turn, even search cannot expose an untracked or
        // foreign file. Enumerate permitted pinned paths, then read only those
        // exact worktree objects after checking their content against Git.
        if (adaptiveSource !== null) {
          const matches = adaptiveScopedFiles(input.path ?? ".").filter(file =>
            typeof input.glob !== "string" || wildcard(input.glob).test(file.split("/").at(-1)!));
          for (const file of matches) await assertAdaptiveExposedRead(job, adaptiveSource, file);
          let output = "";
          for (let i = 0; i < matches.length; i += 30) {
            const files = matches.slice(i, i + 30).map(file => "/story/" + file);
            const result = await run(["sh", "-c", 'grep "$@" | head -c 48000', "nt-grep",
              ...opts, ...files]);
            if (result.code !== 0) throw Error("Sandbox grep failed.");
            output += result.stdout;
            if (output.length >= MAX_OUTPUT) break;
          }
          return text(output.slice(0, MAX_OUTPUT) || "(no matches)");
        }
        // Cap output before the controller limit; grep runs only inside Docker.
        const result = await run(["sh", "-c", 'grep "$@" | head -c 48000', "nt-grep", ...opts, path]);
        if (result.code !== 0) throw new Error("Sandbox grep failed.");
        return text(result.stdout || "(no matches)");
      },
    },
    {
      name: "find", label: "find", executionMode: "sequential", description: "Find canonical Story files by filename glob inside the sandbox.",
      parameters: schema({ pattern: str, path: str, limit: optionalNum }, ["pattern"]),
      async execute(_id, input: Input) {
        if (typeof input.pattern !== "string" || input.pattern.length > 1024) throw new Error("Invalid find glob.");
        const path = mapped(input.path ?? ".", true);
        const limit = number(input.limit, 300, 1000);
        // Fixed script, with pattern and search path only as positional data.
        if (adaptiveSource !== null) {
          const match = wildcard("*/" + input.pattern);
          const files = adaptiveScopedFiles(input.path ?? ".")
            .filter(file => match.test("/story/" + file)).slice(0, limit);
          // Return Story-relative paths, which the same read tool accepts.
          return text(files.join("\n") || "(no files)");
        }
        const script = 'find "$1" -type d -name ".*" -prune -o -type f -path "*/$2" -print | head -n "$3" | head -c 48000';
        const output = await checked(["sh", "-c", script, "nt-find", path, input.pattern, String(limit)]);
        return text(output || "(no files)");
      },
    },
    {
      name: "ls", label: "ls", executionMode: "sequential", description: "List canonical Story directories inside the sandbox.",
      parameters: schema({ path: str, limit: optionalNum }),
      async execute(_id, input: Input) {
        const path = mapped(input.path ?? ".", true);
        const limit = number(input.limit, 300, 1000);
        if (adaptiveSource !== null) {
          const dir = path === "/story" ? "" : path.slice("/story/".length);
          const names = adaptiveScopedFiles(input.path ?? ".").map(file => {
            const remaining = dir ? file.slice(dir.length + 1) : file;
            return remaining.split("/")[0]!;
          });
          return text([...new Set(names)].slice(0, limit).join("\n") || "(no files)");
        }
        const script = 'ls -1 -- "$1" | head -n "$2" | head -c 48000';
        return text(await checked(["sh", "-c", script, "nt-ls", path, String(limit)]));
      },
    },
  ];
  // Never expose a mutating entry point, including arbitrary shell, to an
  // editorial reviewer. Pi receives only these declared custom tool names;
  // no built-in file or shell tools are enabled in hosted mode.
  return access === "read-only" || role !== "specialist"
    ? definitions.filter(tool => SANDBOX_READ_ONLY_TOOLS.some(name => name === tool.name))
    : definitions;
}

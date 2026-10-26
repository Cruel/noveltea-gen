import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession, ModelRuntime, SessionManager,
  type Skill, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stateDirectory } from "./checkpoint.js";
import { createProjectResourceLoader } from "./pi.js";
import { type StoryProject } from "./project.js";
import { createSkillReadTool, type SkillConfig } from "./skills.js";
import { type SkillSnapshot } from "./snapshot.js";

const FOUNDATION_PATH = "creative-direction/foundation.md";
const REQUIRED_READS = [
  ["nt-story-discovery", "SKILL.md"],
  ["nt-catalog", "SKILL.md"],
  ["nt-catalog", "references/records.md"],
  ["nt-catalog", "references/authority-and-validation.md"],
  ["nt-catalog", "references/glossary.md"],
] as const;

interface Decision {
  id: string;
  statement: string;
  origin: "user" | "agent";
  authority: "user-protected" | "delegated";
}

export interface FoundationDraft {
  id: string;
  title: string;
  premise: string;
  central_conflict: string;
  genre: string;
  tone: string;
  player_experience: string;
  scope: string;
  decisions: Decision[];
  body: string;
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000 || value.includes("\0")) {
    throw new Error(`Invalid Creative Direction: ${field} must be nonempty text (max 12000 characters).`);
  }
  return value.trim();
}

/** Validate the exact limited authoring-tool input, not arbitrary Story records. */
export function validateFoundation(input: unknown): FoundationDraft {
  const fields = [
    "id", "title", "premise", "central_conflict", "genre", "tone",
    "player_experience", "scope", "decisions", "body",
  ] as const;
  if (!record(input) || !exactKeys(input, fields)) {
    throw new Error("Invalid Creative Direction: expected only the foundation fields and decisions.");
  }
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    if (key !== "decisions") result[key] = text(input[key], key);
  }
  if (!SLUG.test(result.id as string) || (result.id as string).length > 100) {
    throw new Error("Invalid Creative Direction: id must be a lowercase slug.");
  }
  if (!Array.isArray(input.decisions) || input.decisions.length === 0 || input.decisions.length > 20) {
    throw new Error("Invalid Creative Direction: expected 1–20 significant decisions.");
  }
  const ids = new Set<string>();
  let delegated = false;
  result.decisions = input.decisions.map((value: unknown) => {
    if (!record(value) || !exactKeys(value, ["id", "statement", "origin", "authority"])) {
      throw new Error("Invalid Creative Direction: decision has unexpected or missing fields.");
    }
    const id = text(value.id, "decision id");
    if (!SLUG.test(id) || ids.has(id)) throw new Error("Invalid Creative Direction: invalid or duplicate decision ID.");
    ids.add(id);
    const statement = text(value.statement, "decision statement");
    if ((value.origin !== "user" && value.origin !== "agent") ||
        (value.authority !== "user-protected" && value.authority !== "delegated") ||
        (value.origin === "user" && value.authority !== "user-protected") ||
        (value.origin === "agent" && value.authority === "user-protected")) {
      throw new Error("Invalid Creative Direction: unsupported authority; agent choices must be delegated, user inputs protected.");
    }
    if (value.origin === "agent") delegated = true;
    return { id, statement, origin: value.origin, authority: value.authority };
  });
  if (!delegated) throw new Error("Invalid Creative Direction: demonstration requires agent-delegated creative choices.");
  return result as unknown as FoundationDraft;
}

function yaml(value: string): string {
  // JSON-escaped double-quoted scalars are valid YAML 1.2 and prevent
  // unintended YAML tags, newlines, aliases, keys or implicit booleans.
  return JSON.stringify(value);
}

export function renderFoundation(draft: FoundationDraft): string {
  const decisions = draft.decisions.flatMap(d => [
    `  - id: ${d.id}`,
    `    statement: ${yaml(d.statement)}`,
    `    origin: ${d.origin}`,
    `    authority: ${d.authority}`,
  ]);
  return [
    "---",
    "schema: '0.1'",
    "type: creative-direction",
    `id: creative-direction.${draft.id}`,
    `title: ${yaml(draft.title)}`,
    "status: draft",
    "decisions:",
    ...decisions,
    `premise: ${yaml(draft.premise)}`,
    `central_conflict: ${yaml(draft.central_conflict)}`,
    `genre: ${yaml(draft.genre)}`,
    `tone: ${yaml(draft.tone)}`,
    `player_experience: ${yaml(draft.player_experience)}`,
    `scope: ${yaml(draft.scope)}`,
    "---",
    "",
    draft.body,
    "",
  ].join("\n");
}

export async function assertFreshStory(project: StoryProject): Promise<void> {
  const entries = await readdir(project.root);
  if (entries.length !== 0) {
    throw new Error("Story authoring demo requires a fresh empty Story directory; no existing files or canon are modified.");
  }
}

export function createFoundationTools(project: StoryProject, skills: Skill[]): {
  tools: ToolDefinition[];
  artifact: string;
  required: string[];
  readPaths: () => string[];
  didWrite: () => boolean;
} {
  const byName = new Map(skills.map(s => [s.name, s]));
  const required = REQUIRED_READS.map(([name, path]) => {
    const skill = byName.get(name);
    if (!skill) throw new Error(`Story demo requires pinned skill "${name}".`);
    return join(skill.baseDir, path);
  });
  const read = createSkillReadTool(skills);
  const reads = new Set<string>();
  let written = false;
  const artifact = join(project.root, FOUNDATION_PATH);
  const reader: ToolDefinition = {
    ...read,
    async execute(id, args, signal, onUpdate, context) {
      const result = await read.execute(id, args, signal, onUpdate, context);
      const path = (args as { path: string }).path;
      reads.add(await realpath(path));
      return result;
    },
  };
  const writer: ToolDefinition = {
    name: "write_creative_direction",
    label: "Write one draft Creative Direction",
    description: "After reading the required pinned skill instructions, create the ONLY canonical Story record at creative-direction/foundation.md in this empty selected Story root. Never write arbitrary paths or other record types.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Slug suffix for creative-direction.<id>" },
        title: { type: "string" },
        premise: { type: "string" },
        central_conflict: { type: "string" },
        genre: { type: "string" },
        tone: { type: "string" },
        player_experience: { type: "string" },
        scope: { type: "string" },
        decisions: { type: "array", items: {
          type: "object",
          properties: {
            id: { type: "string" }, statement: { type: "string" },
            origin: { type: "string", enum: ["user", "agent"] },
            authority: { type: "string", enum: ["user-protected", "delegated"] },
          },
          required: ["id", "statement", "origin", "authority"],
          additionalProperties: false,
        } },
        body: { type: "string", description: "Meaningful Markdown on conflict, theme and VN presentation; no engine implementation" },
      },
      required: ["id", "title", "premise", "central_conflict", "genre", "tone",
        "player_experience", "scope", "decisions", "body"],
      additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, args) {
      if (written) throw new Error("Creative Direction was already written in this demonstration.");
      const missing = await Promise.all(required.map(async path => {
        const canonical = await realpath(path);
        return reads.has(canonical) ? null : path;
      }));
      if (missing.some(Boolean)) throw new Error(`Read the required pinned skill references before authoring: ${missing.filter(Boolean).join(", ")}`);
      const draft = validateFoundation(args);
      const content = renderFoundation(draft);
      await assertFreshStory(project);
      const folder = join(project.root, "creative-direction");
      await mkdir(folder);
      try {
        if ((await realpath(folder)) !== folder || !(await lstat(folder)).isDirectory()) {
          throw new Error("Creative Direction directory is not a regular directory.");
        }
        // Exclusive + no-follow keeps the agent from overwriting existing canon
        // or following a malicious artifact symlink.
        const handle = await open(artifact, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(content, "utf8"); }
        finally { await handle.close(); }
      } catch (error) {
        // Only remove our empty directory. Preserve any external data.
        await rmdir(folder).catch(() => undefined);
        throw error;
      }
      const observed = await readFile(artifact, "utf8");
      if (observed !== content || !observed.startsWith("---\nschema: '0.1'\n") ||
          !observed.includes("\n---\n\n") || !draft.body.trim()) {
        throw new Error("Creative Direction file failed read-back contract inspection.");
      }
      written = true;
      return {
        content: [{ type: "text", text: `Created ${FOUNDATION_PATH}, creative-direction.${draft.id}, status draft; local contract read-back passed. Native catalog readiness unverified.` }],
        details: undefined,
      };
    },
  };
  return {
    tools: [reader, writer],
    artifact,
    required,
    readPaths: () => [...reads],
    didWrite: () => written,
  };
}

function fixtureDraft(task: string): FoundationDraft {
  return {
    id: "sealed-room", title: "The Sealed Room",
    premise: "A locked conservatory holds the evidence of a curator's impossible murder.",
    central_conflict: "A young archivist must expose the murderer before the museum's final exhibition closes.",
    genre: "Mystery", tone: "Quiet, tense",
    player_experience: "Investigate a compact mystery through dialogue and carefully presented clues.",
    scope: "A short, mostly static visual novel with reusable rooms and a small cast.",
    decisions: [
      { id: "requested-genre", statement: `The user requested this foundation: ${task}`, origin: "user", authority: "user-protected" },
      { id: "visual-approach", statement: "Use static backgrounds, dialogue and restrained musical cues.", origin: "agent", authority: "delegated" },
    ],
    body: "# The Sealed Room\n\nA close-knit museum staff must confront the evidence left in a locked room. Reused backgrounds and deliberate clue text make the reveal stageable without bespoke animations.",
  };
}

export interface DemoOptions {
  project: StoryProject;
  config: SkillConfig;
  snapshot: SkillSnapshot | undefined;
  provider: string;
  model: string;
  task: string;
  fixture: boolean;
}

export async function runFoundationDemo(input: DemoOptions) {
  const { project, config, snapshot, task } = input;
  if (!snapshot || !config.novelteaSkills) {
    throw new Error("Story demo requires a configured NovelTea skills Git checkout and pinned snapshot.");
  }
  await assertFreshStory(project);
  const demoConfig: SkillConfig = {
    discovery: "explicit-only", skillDirs: [],
    novelteaSkills: snapshot.path, requiredSkills: ["nt-catalog", "nt-story-discovery"],
  };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, demoConfig);
  await loader.reload();
  for (const diagnostic of loader.getSkills().diagnostics) {
    if (diagnostic.type === "error") throw new Error(`Demo skill discovery error: ${diagnostic.message}`);
  }
  const { tools, artifact, required, readPaths, didWrite } = createFoundationTools(
    project, loader.getSkills().skills,
  );
  const canonicalRequired = await Promise.all(required.map(async path => {
    try { return await realpath(path); }
    catch { throw new Error(`Story demo required pinned skill reference is missing: ${path}`); }
  }));
  let piSessionId: string | undefined;
  let piSessionFile: string | undefined;
  let response: string;
  if (input.fixture) {
    // Deterministic transport-level fixture, NOT evidence of live Pi behavior.
    for (const path of required) await tools[0]!.execute("fixture-read", { path }, undefined, undefined, {} as never);
    await tools[1]!.execute("fixture-write", fixtureDraft(task), undefined, undefined, {} as never);
    response = "Fixture created a draft Creative Direction (no Pi/model invocation).";
  } else {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel(input.provider, input.model);
    if (!model) throw new Error(`Unknown Pi model: ${input.provider}/${input.model}`);
    const available = await runtime.getAvailable(input.provider);
    if (!available.some(candidate => candidate.id === input.model)) {
      throw new Error(`No usable Pi credentials for ${input.provider}/${input.model}; use pi /login or an API key.`);
    }
    const { session } = await createAgentSession({
      modelRuntime: runtime, model, cwd: project.root,
      resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.create(project.root, join(stateDirectory(project), "demo-sessions")),
      noTools: "all", tools: tools.map(tool => tool.name), customTools: tools,
    });
    try {
      await session.prompt(
        "Run a bounded NovelTea Story-foundation demonstration, not the real Story generation graph. " +
        "You are explicitly delegated to choose ALL unspecified creative decisions needed for the foundation. " +
        "Honor any user-supplied constraints as origin:user/authority:user-protected; mark your own choices origin:agent/authority:delegated. " +
        "First use the read tool to actually read nt-story-discovery/SKILL.md, nt-catalog/SKILL.md and " +
        "nt-catalog/references/records.md, authority-and-validation.md and glossary.md FROM THE PINNED SKILL PATHS advertised to you. " +
        "Then follow their foundation guidance and call write_creative_direction exactly once to create a meaningful minimal " +
        "draft Creative Direction. No other Story record, full graph, engine game, asset or code is permitted. " +
        "Do not claim catalog validation or approval; only the limited local checks have run. " +
        "User request / binding constraints:\n" + task,
      );
      const lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!lastAssistant || lastAssistant.role !== "assistant" ||
          lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
        throw new Error("Pi demo did not complete successfully.");
      }
      response = session.getLastAssistantText() ?? "";
      if (!response.trim()) throw new Error("Pi demo returned no final explanation.");
      piSessionId = session.sessionId;
      piSessionFile = session.sessionManager.getSessionFile() ?? undefined;
    } finally {
      session.dispose();
    }
    if (!didWrite()) throw new Error("Pi demo did not create a Creative Direction record.");
  }
  const written = await readFile(artifact, "utf8");
  if (!written.trim() || (await readdir(project.root)).join(",") !== "creative-direction" ||
      (await readdir(join(project.root, "creative-direction"))).join(",") !== "foundation.md") {
    throw new Error("Demo created unexpected Story content or an empty artifact.");
  }
  return {
    status: "completed", mode: input.fixture ? "fixture" : "pi",
    projectRoot: project.root, projectId: project.id,
    skillSnapshot: snapshot, artifact, recordStatus: "draft",
    contractCheck: "local-readback", catalogValidation: "unverified",
    skillReads: canonicalRequired.filter(path => readPaths().includes(path)),
    piSessionId, piSessionFile, response,
  };
}

/** In-process Pi transport and restrictive filesystem seam for source-bound
 * generation tests. This does NOT certify Docker sandbox isolation; production
 * sandbox/controller coverage is exercised separately.
 * The same production Pi tools, response parser and session recorder run here.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage,
  type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { SandboxClient } from "../src/sandbox-client.js";

export const scriptedModel: Model<Api> = {
  id: "scripted-c03", provider: "cert-c03", api: "cert-c03-api",
  name: "Local source-bound recovery", baseUrl: "http://unused.invalid",
  input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type ScriptedContent = AssistantMessage["content"];
export const scriptedReadCalls = (paths: readonly string[], index: number) => paths.map((path, i) => ({
  type: "toolCall" as const, id: "c03-read-" + index + "-" + i,
  name: "read", arguments: { path },
}));
export const scriptedText = (content: unknown): ScriptedContent =>
  [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }];
export async function scriptedStoryRuntime(
  reply: (index: number, context: { messages: readonly unknown[] }) =>
    { content: ScriptedContent; reason: "stop" | "toolUse" },
) {
  let index = 0;
  const observed: Array<{ tools: string[]; messages: readonly unknown[] }> = [];
  const stream: NonNullable<Provider["streamSimple"]> = (_, context) => {
    const events = createAssistantMessageEventStream();
    const tools = new Set<string>();
    for (const m of context.messages) if (m.role === "system") {
      for (const t of m.toolsAdded ?? []) tools.add(t.name);
      for (const tool of m.toolsRemoved ?? []) tools.delete(tool.name);
    }
    observed.push({ tools: [...tools], messages: context.messages });
    const { content, reason } = reply(index++, context);
    const message: AssistantMessage = {
      role: "assistant", api: scriptedModel.api, provider: scriptedModel.provider,
      model: scriptedModel.id, content, stopReason: reason, timestamp: Date.now(),
      usage: { input: 15, output: 15, cacheRead: 0, cacheWrite: 0,
        totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      events.push({ type: "start", partial: message });
      content.forEach((item, i) => {
        if (item.type === "toolCall") {
          events.push({ type: "toolcall_start", contentIndex: i, partial: message });
          events.push({ type: "toolcall_end", contentIndex: i, toolCall: item, partial: message });
        } else if (item.type === "text") {
          events.push({ type: "text_start", contentIndex: i, partial: message });
          events.push({ type: "text_end", contentIndex: i, content: item.text, partial: message });
        }
      });
      events.push({ type: "done", reason, message });
      events.end(message);
    });
    return events;
  };
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider({ id: scriptedModel.provider, name: scriptedModel.name,
    auth: { apiKey: { name: "Local scripted provider", check: async () =>
      ({ type: "api_key" as const, source: "test" }), resolve: async () =>
      ({ auth: { apiKey: "in-process-only" } }) } },
    getModels: () => [scriptedModel], stream: (model, context) => stream(model, context), streamSimple: stream });
  await runtime.refresh({ allowNetwork: false });
  return { runtime, observed, calls: () => index };
}

/** Only the small fixed argv emitted by the production read/write/edit tools
 * is recognized. No shell, Git, network, or directory escape is available. */
export function fixtureSandboxClient(jobId: string, storyRoot: string) {
  const oldAcquire = SandboxClient.prototype.acquire;
  const oldExecute = SandboxClient.prototype.execute;
  const oldDispose = SandboxClient.prototype.dispose;
  const oldSocket = process.env.NT_SANDBOX_SOCKET;
  const oldToken = process.env.NT_SANDBOX_TOKEN_FILE;
  process.env.NT_SANDBOX_SOCKET = "/no-network-c03-sandbox";
  process.env.NT_SANDBOX_TOKEN_FILE = "/no-network-c03-token";
  const root = resolve(storyRoot);
  const target = (sandboxPath: string) => {
    assert.ok(sandboxPath.startsWith("/story/"), "No host paths permitted");
    const file = resolve(root, sandboxPath.slice("/story/".length));
    assert.ok(file.startsWith(root + sep) && !file.split(sep).includes(".."),
      "Sandbox projection cannot escape Story");
    return file;
  };
  SandboxClient.prototype.acquire = async (id: string) => {
    assert.equal(id, jobId);
    return { jobId: id, status: "running" };
  };
  SandboxClient.prototype.dispose = async id => {
    assert.equal(id, jobId);
    return { jobId: id, status: "disposed" };
  };
  SandboxClient.prototype.execute = async (id: string, argv: string[],
    output: (stream: "stdout" | "stderr", data: string) => void) => {
    assert.equal(id, jobId);
    if (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "nt-read") {
      const [start, end] = [Number(argv[4]), Number(argv[5])];
      const lines = readFileSync(target(argv[6]!), "utf8").split("\n");
      output("stdout", lines.slice(start - 1, end).join("\n") + "\n"); return 0;
    }
    if (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "nt-write") {
      const file = target(argv[4]!);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(argv.slice(5).join(""), "base64")); return 0;
    }
    if (argv[0] === "wc" && argv[1] === "-c" && argv[2] === "--") {
      const file = target(argv[3]!);
      output("stdout", readFileSync(file).length + " " + argv[3] + "\n"); return 0;
    }
    if (argv[0] === "cat" && argv[1] === "--") {
      output("stdout", readFileSync(target(argv[2]!), "utf8")); return 0;
    }
    throw Error("Unsupported scripted sandbox argv: " + JSON.stringify(argv));
  };
  return () => {
    SandboxClient.prototype.acquire = oldAcquire;
    SandboxClient.prototype.execute = oldExecute;
    SandboxClient.prototype.dispose = oldDispose;
    if (oldSocket === undefined) delete process.env.NT_SANDBOX_SOCKET;
    else process.env.NT_SANDBOX_SOCKET = oldSocket;
    if (oldToken === undefined) delete process.env.NT_SANDBOX_TOKEN_FILE;
    else process.env.NT_SANDBOX_TOKEN_FILE = oldToken;
  };
}

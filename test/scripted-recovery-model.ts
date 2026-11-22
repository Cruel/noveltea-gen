import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";

/** In-process transport. No network, account, or provider credentials. */
export async function scriptedRecoveryModel() {
  const model: Model = { id: "diagnosis-fixture", provider: "diagnosis-fixture", api: "diagnosis-fixture", name: "Local recovery test",
    baseUrl: "http://unused.invalid", input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const calls: string[] = [];
  const stream: NonNullable<Provider["streamSimple"]> = (_, ctx) => {
    const tools = new Set<string>();
    for (const m of ctx.messages) if (m.role === "system") {
      for (const item of m.toolsAdded ?? []) tools.add(item.name);
      for (const name of m.toolsRemoved ?? []) tools.delete(name);
    }
    assert.equal(tools.size, 0);
    const signature = JSON.stringify(ctx.messages).match(/signature=([0-9a-f]{64})/)?.[1];
    assert.ok(signature); calls.push(signature);
    const text = JSON.stringify({ schema: "noveltea-unknown-recovery-diagnosis/v1", signature,
      category: "unclassified", action: "inspect-existing-receipt", summary: "Inspect the original assignment and ownership." });
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    const events = createAssistantMessageEventStream(); queueMicrotask(() => {
      events.push({ type: "start", partial: message }); events.push({ type: "text_start", contentIndex: 0, partial: message });
      events.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      events.push({ type: "done", reason: "stop", message }); events.end(message);
    }); return events;
  };
  const rt = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  rt.registerNativeProvider({ id: model.provider, name: model.name, auth: { apiKey: { name: "Unused",
    check: async () => ({ type: "api_key", source: "test" }), resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
    getModels: () => [model], stream, streamSimple: stream });
  await rt.refresh({ allowNetwork: false }); return { rt, model, calls };
}

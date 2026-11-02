import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One explicitly authenticated, per-user Pi runtime for a hosted generation
 * invocation. Never place a model runtime or credentials in graph checkpoints,
 * a global singleton, sandbox tools, or a Git worktree. */
const runtimeScope = new AsyncLocalStorage<ModelRuntime>();

export function withJobModelRuntime<T>(runtime: ModelRuntime, execute: () => Promise<T>): Promise<T> {
  return runtimeScope.run(runtime, execute);
}

/** All production specialists and budget preflight use the same boundary.
 * Hosted servers must set NT_REQUIRE_USER_PI_RUNTIME=1 during startup: a lost
 * async context then fails closed rather than reading ~/.pi or host API keys. */
export async function createJobModelRuntime(): Promise<ModelRuntime> {
  const runtime = runtimeScope.getStore();
  if (runtime) return runtime;
  if (process.env.NT_REQUIRE_USER_PI_RUNTIME === "1") {
    throw new Error("Hosted Pi runtime is not bound to an authenticated user's credentials.");
  }
  return ModelRuntime.create();
}

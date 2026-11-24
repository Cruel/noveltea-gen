import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One explicitly authenticated, per-user Pi runtime for a hosted generation
 * invocation. Never place a model runtime or credentials in graph checkpoints,
 * a global singleton, sandbox tools, or a Git worktree. */
const runtimeScope = new AsyncLocalStorage<ModelRuntime | null>();

export function withJobModelRuntime<T>(runtime: ModelRuntime, execute: () => Promise<T>): Promise<T> {
  if (runtimeScope.getStore() === null)
    throw Error("Model runtime is forbidden in a structural fixture invocation.");
  return runtimeScope.run(runtime, execute);
}

/** A legacy structural fixture has no model transport. Keep that restriction
 * at the provider boundary, not in the recovery assessor. Production-shaped
 * tests use withJobModelRuntime and the ordinary production request instead. */
export function withoutJobModelRuntime<T>(execute: () => Promise<T>): Promise<T> {
  return runtimeScope.run(null, execute);
}

/** All production specialists and budget preflight use the same boundary.
 * Hosted servers must set NT_REQUIRE_USER_PI_RUNTIME=1 during startup: a lost
 * async context then fails closed rather than reading ~/.pi or host API keys. */
export async function createJobModelRuntime(): Promise<ModelRuntime> {
  const runtime = runtimeScope.getStore();
  if (runtime === null)
    throw Error("Model runtime is forbidden in a structural fixture invocation.");
  if (runtime) return runtime;
  if (process.env.NT_REQUIRE_USER_PI_RUNTIME === "1") {
    throw new Error("Hosted Pi runtime is not bound to an authenticated user's credentials.");
  }
  return ModelRuntime.create();
}

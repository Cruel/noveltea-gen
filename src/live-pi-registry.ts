import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Only the live Story writer can register a session. Never accept a session
 * or job identifier from a browser, agent tool, or untrusted SDK extension. */
export type LivePiSession = Pick<AgentSession, "steer" | "followUp" | "isStreaming" | "messages" | "sessionId">;
export type ActivePiTurn = {
  jobId: string;
  token: string;
  workItem: string;
  expectedHead: string;
  session: LivePiSession;
};
const active = new Map<string, ActivePiTurn>();
const pending = new Set<string>();
let onSettled: ((turn: ActivePiTurn, succeeded: boolean) => Promise<void>) | undefined;
let onLifecycle: ((turn: ActivePiTurn, phase: 'registered' | 'closed') => Promise<void> | void) | undefined;

/** Persist the exact Pi-turn ownership before a web process can enqueue a steer.
 * This is a controller-only listener, not an agent or browser-provided target. */
export function observePiTurnLifecycle(handler: typeof onLifecycle) {
  onLifecycle = handler;
}

export function observePiTurnSettlement(handler: typeof onSettled) {
  onSettled = handler;
}
export function activePiTurn(jobId: string): ActivePiTurn | undefined {
  const turn = active.get(jobId);
  return turn?.session.isStreaming ? turn : undefined;
}
/** A turn is not visible to dispatch until durable registration has
 * completed. Concurrent registrations/closures cannot pass each other while
 * a remote database call is awaiting completion. */
export async function registerPiTurn(turn: ActivePiTurn): Promise<() => Promise<void>> {
  if (active.has(turn.jobId) || pending.has(turn.jobId))
    throw new Error("A Pi session is already registered for this Story job.");
  pending.add(turn.jobId);
  try {
    await onLifecycle?.(turn, 'registered');
    active.set(turn.jobId, turn);
  } finally {
    pending.delete(turn.jobId);
  }
  return async () => {
    if (active.get(turn.jobId) !== turn) return;
    if (pending.has(turn.jobId)) throw new Error("Pi turn lifecycle transition is pending.");
    pending.add(turn.jobId);
    try {
      await onLifecycle?.(turn, 'closed');
      active.delete(turn.jobId);
    } finally {
      pending.delete(turn.jobId);
    }
  };
}
export async function settlePiTurn(turn: ActivePiTurn, succeeded: boolean) {
  if (onSettled) await onSettled(turn, succeeded);
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { JobStartResult } from "./job.js";

/** Author steering is admitted by Studio, never by a model or a specialist.
 * Only the authenticated generation runner installs this adapter. */
export interface SteeringInput {
  messageId: string;
  threadId: string;
  jobId: string;
  content: string;
  state: "pending" | "deferred" | "delivered";
  submittedHead: string | null;
  targetWorkItem: string | null;
  disposition: string | null;
}

export interface SteeringBoundaryDecision {
  messageId: string;
  content: string;
  kind: "applied" | "review-required";
  sourceSha: string;
  amendmentDigest: string | null;
  reason: string;
}

export interface SteeringBoundaryAdapter {
  pending(job: JobStartResult): Promise<SteeringInput[]>;
  /** DB receipts are authoritative when verifying a restored private plan. */
  receipts(job: JobStartResult): Promise<Array<{ messageId: string; sourceSha: string; amendmentDigest: string }>>;
  settle(job: JobStartResult, decision: SteeringBoundaryDecision): Promise<void>;
}

const boundaries = new AsyncLocalStorage<SteeringBoundaryAdapter>();

export function withSteeringBoundary<T>(adapter: SteeringBoundaryAdapter,
  run: () => Promise<T>): Promise<T> {
  return boundaries.run(adapter, run);
}

export function currentSteeringBoundary(): SteeringBoundaryAdapter | undefined {
  return boundaries.getStore();
}

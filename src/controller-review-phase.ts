import { AsyncLocalStorage } from "node:async_hooks";

/** Trusted orchestration code reports sparse phase transitions. This is not a
 * model-facing status tool, review verdict, approval, or resume entitlement. */
export type ControllerReviewPhase = "correcting" | "diagnosing" | "planning" | "reviewing" | "reviewed";
export interface ControllerReviewActivity {
  milestone?: string;
  activity: "blueprint-planning" | "blueprint-review" | "blueprint-diagnosis" | "operation-diagnosis" | "protocol-correction" | "source-read-correction" | "substantive-correction";
  role?: "planner" | "reviewer" | "diagnostic";
  round?: number;
  verdict?: "pass" | "revise";
  findings?: number;
  reason?: string;
}
type Sink = (phase: ControllerReviewPhase, detail?: ControllerReviewActivity) => Promise<void>;
const current = new AsyncLocalStorage<Sink>();

export function withControllerReviewPhase<T>(
  sink: Sink, run: () => Promise<T>,
): Promise<T> {
  return current.run(sink, run);
}

/** Only call at an authenticated controller admission to an actual reviewer,
 * diagnostic or existing-session correction; never from parsed model prose. */
export async function reportControllerReviewPhase(phase: ControllerReviewPhase, detail?: ControllerReviewActivity) {
  const sink = current.getStore();
  if (sink) await sink(phase, detail);
}

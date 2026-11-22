/** Current LangGraph failed-task identity. Not a checkpoint-format migration. */
import type { RecoveryOrigin } from "./generation-recovery-contract.js";

const checkId = /^[a-zA-Z0-9_.:-]{6,200}$/;
const langGraphUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isObject = (input: unknown): input is Record<string, unknown> =>
  !!input && typeof input === "object" && !Array.isArray(input);

/** Bind a failure to the executing graph task and its already persisted
 * parent checkpoint, never to a later resume cursor or generated recovery ID.
 * The caller independently authenticates source HEAD, Turn and domain proof. */
export function originalGraphFailureAnchor(
  config: { configurable?: Record<string, unknown>; metadata?: Record<string, unknown> },
  check: string,
): RecoveryOrigin["failureAnchor"] | null {
  const fields = config.configurable;
  const meta = config.metadata;
  const thread = fields?.thread_id;
  const node = meta?.langgraph_node;
  const taskId = fields?.__pregel_task_id;
  const checkpointMap = fields?.checkpoint_map;
  const sourceCheckpoint = isObject(checkpointMap) ? checkpointMap[""] : undefined;
  if (
    typeof thread !== "string" ||
    !thread ||
    meta?.thread_id !== thread ||
    typeof node !== "string" ||
    !checkId.test(node) ||
    typeof taskId !== "string" ||
    !langGraphUuid.test(taskId) ||
    typeof sourceCheckpoint !== "string" ||
    !langGraphUuid.test(sourceCheckpoint) ||
    typeof check !== "string" ||
    !/^[a-z][a-z0-9.-]{2,100}$/.test(check) ||
    meta?.langgraph_checkpoint_ns !== node + ":" + taskId
  )
    return null;
  return {
    store: "graph-checkpoint",
    ref: thread + ":" + sourceCheckpoint,
    failedCheckInstanceId: node + ":" + taskId + ":" + check,
  };
}

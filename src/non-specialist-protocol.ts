/** Resume a proven paused format-only response. This adapter reuses the
 * existing Pi budget, pinned model and response-contract receipt; it cannot
 * run the original planning prompt or expose any tools. */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { JobStartResult } from "./job.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { guardPiBudget, inspectPiPolicy, recordPiSession, registerPendingPiSession, resolvePiModel } from "./job-pi-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { inspectSealedInvalidProtocolResponse, recoverResponseContract,
  inspectCompletedProtocolResponse, inspectCompletedProtocolReads, ProtocolIntegrityBlockedError, type ResponseContractFailure } from "./response-contract-recovery.js";

export async function reconcileReadOnlyProtocol<T>(job: JobStartResult, protocol: {
  receiptFile: string; sourceDigest: string; contract: string; sessionRoots: string[];
  validate: (text: string) => ResponseContractFailure[]; parse: (text: string) => T;
}, profile: { provider: string; model: string; thinking?: "low" | "high" },
step: string, assertSource: () => Promise<void>, expectedSessionFile?: string): Promise<T> {
  await assertSource();
  const original = await inspectSealedInvalidProtocolResponse(protocol);
  const { resolved: pinned } = await inspectPiPolicy(job);
  const authenticate = (file: string, id?: string) => {
    if (!pinned || expectedSessionFile && file !== expectedSessionFile)
      throw new ProtocolIntegrityBlockedError("Original read-only session or model pin changed");
    const manager = SessionManager.open(file, dirname(file), job.worktreeStoryRoot);
    const assistants = manager.buildSessionContext().messages.filter(m => m.role === "assistant");
    if (id && manager.getSessionId() !== id || manager.getHeader()?.cwd !== job.worktreeStoryRoot ||
        !assistants.length || assistants.some(m => m.provider !== pinned.selected.provider || m.model !== pinned.selected.model))
      throw new ProtocolIntegrityBlockedError("Original read-only report model or source changed");
    return manager;
  };
  if (!original) {
    const result = await inspectCompletedProtocolResponse({ ...protocol, requireSealedTranscript: true });
    const proof = await inspectCompletedProtocolReads(protocol);
    authenticate(proof.sessionFile);
    return result;
  }
  // Validate the original invocation before charging its usage or reopening
  // the conversation. An uncertain dispatched correction never reaches here.
  const manager = authenticate(original.file, original.id);
  await recordPiSession(job, original.file);
  await guardPiBudget(job, step, original.file);
  const runtime = await createJobModelRuntime();
  const resolved = await resolvePiModel(job, runtime, profile.provider, profile.model, profile.thinking);
  const { session } = await createAgentSession({
    cwd: job.worktreeStoryRoot, modelRuntime: runtime, model: resolved.model,
    thinkingLevel: resolved.resolution.thinking, sessionManager: manager, noTools: "all", tools: [],
  });
  try {
    if (session.getActiveToolNames().length || session.sessionId !== original.id)
      throw new ProtocolIntegrityBlockedError("Original format correction lost its session or read-only policy");
    return await recoverResponseContract({ ...protocol, session, sealTranscript: true,
      receiptFile: protocol.receiptFile + ".initial.json",
      resumeOriginal: { base: protocol.receiptFile, sessionRoots: protocol.sessionRoots },
      beforeCorrection: async () => {
        await assertSource();
        await guardPiBudget(job, step, original.file);
      },
      prompt: async feedback => {
        await registerPendingPiSession(job, original.file);
        await promptStorySpecialist(session, feedback);
        const last = session.messages.at(-1);
        if (last?.role !== "assistant" || last.stopReason !== "stop")
          throw new ProtocolIntegrityBlockedError("Original format correction did not finish");
        await recordPiSession(job, original.file);
        await assertSource();
      },
      feedback: failures => "Correct only the format of the original report in this same conversation. " +
        "Preserve its actual verdict, proposed scope and source evidence. No tools or new planning. " +
        failures.map(f => f.path + ": " + f.expected).join("; "),
    });
  } finally { session.dispose(); }
}

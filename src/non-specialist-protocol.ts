/** Resume a proven paused format-only response. This adapter reuses the
 * existing Pi budget, pinned model and response-contract receipt; it cannot
 * run the original planning prompt or expose any tools. */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { JobStartResult } from "./job.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { guardPiBudget, recordPiSession, registerPendingPiSession, resolvePiModel } from "./job-pi-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { inspectSealedInvalidProtocolResponse, recoverResponseContract,
  inspectCompletedProtocolResponse, ProtocolIntegrityBlockedError, type ResponseContractFailure } from "./response-contract-recovery.js";

export async function reconcileReadOnlyProtocol<T>(job: JobStartResult, protocol: {
  receiptFile: string; sourceDigest: string; contract: string; sessionRoots: string[];
  validate: (text: string) => ResponseContractFailure[]; parse: (text: string) => T;
}, profile: { provider: string; model: string; thinking?: "low" | "high" },
step: string, assertSource: () => Promise<void>): Promise<T> {
  await assertSource();
  const original = await inspectSealedInvalidProtocolResponse(protocol);
  if (!original)
    return inspectCompletedProtocolResponse({ ...protocol, requireSealedTranscript: true });
  // The invalid response itself is complete, so settle its original usage.
  // An uncertain dispatched correction never reaches this branch.
  await recordPiSession(job, original.file);
  await guardPiBudget(job, step, original.file);
  const runtime = await createJobModelRuntime();
  const resolved = await resolvePiModel(job, runtime, profile.provider, profile.model, profile.thinking);
  const manager = SessionManager.open(original.file, dirname(original.file), job.worktreeStoryRoot);
  const assistants = manager.buildSessionContext().messages.filter(m => m.role === "assistant");
  if (manager.getSessionId() !== original.id || manager.getHeader()?.cwd !== job.worktreeStoryRoot ||
      !assistants.length || assistants.some(m => m.provider !== resolved.model.provider || m.model !== resolved.model.id))
    throw new ProtocolIntegrityBlockedError("Original format correction model or source changed");
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

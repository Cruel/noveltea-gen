import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginProtocolInvocation, recoverResponseContract, type ResponseContractSession } from "../../src/response-contract-recovery.js";

/** Construct the real protocol admission and settlement around a synthetic
 * completed reviewer transcript. No production verification bypass. */
export async function sealCompositionReviewFixture(directory: string, receipt: {
  cycleId: string; round: number; writer: { id: string; file: string };
  reviewer: { id: string; file: string }; previousDigest: string | null;
  sourceText: Record<string, string>; verdict: unknown;
}) {
  const { cycleId, round, writer, reviewer, previousDigest, sourceText } = receipt;
  const sourceDigest = createHash("sha256").update(JSON.stringify({
    cycleId, round, writer, reviewer, previousDigest, sources: sourceText,
  })).digest("hex");
  const contract = "composition.draft-review.v2";
  const receiptFile = join(directory, "round-" + round + ".protocol");
  const full = readFileSync(reviewer.file, "utf8");
  const lines = full.trimEnd().split("\n");
  const messages = lines.slice(1).map(line => JSON.parse(line).message);
  const session: ResponseContractSession = {
    sessionId: reviewer.id, sessionManager: { getSessionFile: () => reviewer.file },
    messages, getActiveToolNames: () => [], setActiveToolsByName: () => {},
  };
  writeFileSync(reviewer.file, lines.slice(0, -1).join("\n") + "\n");
  try { await beginProtocolInvocation({ receiptFile, sourceDigest, contract, session }); }
  finally { writeFileSync(reviewer.file, full); }
  await recoverResponseContract({ session, contract, sourceDigest, receiptFile: receiptFile + ".initial.json",
    sealTranscript: true, validate: () => [], parse: JSON.parse,
    prompt: async () => { throw Error("Fixture must never invoke protocol correction"); } });
}

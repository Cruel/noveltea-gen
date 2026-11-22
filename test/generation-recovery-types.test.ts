import assert from "node:assert/strict";
import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript";
import type { CompilerOptions } from "typescript";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** Use TypeScript itself, not text matching, to prove that deeply nested
 * provenance cannot be modified or converted from an inspection fence into
 * a trusted admitted case. The virtual file is never written to the repo. */
test("C01 nested identity/evidence and unsafe-admission types are immutable", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const path = resolve(root, "test/.recovery-contract-immutability.virtual.ts");
  const snippet = `
import type {
  RecoveryAdmission, RecoveryCase, RecoveryDecision, RecoveryInspectionFence,
  RecoveryLifecycle, RecoveryFailureAnchor,
} from "../src/generation-recovery-contract.js";

declare const c: RecoveryCase;
declare const d: Extract<RecoveryDecision, { action: "known-correction" }>;
declare const f: RecoveryInspectionFence;
declare const a: RecoveryAdmission;
declare const l: RecoveryLifecycle;
declare const anchor: RecoveryFailureAnchor;

if (false) {
  // @ts-expect-error canonical original HEAD is immutable
  c.origin.sourceHeadSha = "changed";
  // @ts-expect-error original failed-check pointer cannot be swapped
  c.origin.failureAnchor.ref = "other";
  // @ts-expect-error original failed-check instance cannot be changed
  anchor.failedCheckInstanceId = "other";
  // @ts-expect-error old admission evidence cannot be rewritten
  c.evidence[0]!.ref = "other";
  // @ts-expect-error existing decision evidence cannot be rewritten
  d.evidence[0]!.digest = "other";
  // @ts-expect-error adapter receipt is immutable
  d.receipt.ref = "other";
  // @ts-expect-error source of an inspected but untrusted origin is also immutable
  f.observedOrigin.sourceHeadSha = "fabricated";
  // @ts-expect-error inspection evidence cannot be rewritten
  f.evidence[0]!.ref = "fabricated";
  // @ts-expect-error inspection fence is not an authenticated case
  f.caseId;
  // @ts-expect-error no case key can be supplied for untrusted admission
  a.outcome === "fenced" && a.case;
  // @ts-expect-error inspection fences cannot be dropped by mutating array
  l.inspectionFences.pop();
  // @ts-expect-error missing original head belongs in a fence, not an admitted case
  c.origin.sourceHeadSha = null;
}
`;
  const options: CompilerOptions = {
    target: ScriptTarget.ES2022,
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    types: ["node"],
  };
  const host = createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (name) => name === path || fileExists(name);
  host.readFile = (name) => (name === path ? snippet : readFile(name));
  host.getSourceFile = (name, language, onError, shouldCreateNewSourceFile) =>
    name === path
      ? createSourceFile(name, snippet, language, true)
      : getSourceFile(name, language, onError, shouldCreateNewSourceFile);
  const program = createProgram([path], options, host);
  assert.deepEqual(
    getPreEmitDiagnostics(program).map(
      (d) =>
        `${d.file?.fileName ?? "program"}:${d.start ?? "?"} ${flattenDiagnosticMessageText(d.messageText, "\n")}`,
    ),
    [],
    "Unmet @ts-expect-error means a required readonly boundary was weakened",
  );
});

// Behavioral negative controls at the existing production Generation/SQLite/native/Git seam.
// Never mutate the checkout or reuse a Story, job, or checkpoint between runs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skills = realpathSync(process.env.NT_SKILLS_CHECKOUT ?? resolve(root, "../noveltea-skills"));
const controls = [
  {
    scenario: "prospective-refused",
    file: "src/generation-operation-strategy.ts",
    before: 'if (unresolved?.action === "strategy-unresolved") return stop(unresolved,',
    after: 'if (unresolved?.action === "strategy-unresolved") return stop({ ...base(c), action: "integrity-fence", reason: "untrusted-receipt", requiredInspection: "Inspect prerequisite." },',
    assertion: "Authenticated prerequisite ambiguity or refusal must remain unresolved",
  },
  {
    scenario: "source-recovery",
    file: "src/milestone-blueprint.ts",
    before: 'raw => parseMilestoneBlueprint(raw, assignment, "review-draft"),',
    after: 'raw => parseMilestoneBlueprint(raw, assignment, "admission"),',
    assertion: "Well-formed witness/source defects must reach substantive recovery",
  },
  {
    scenario: "prospective-review-native-diagnosis",
    file: "src/generation-operation-strategy.ts",
    before: 'if (native) return native;',
    after: 'if (native) return null;',
    assertion: "A supported native Review diagnosis must admit the original repair",
  },
  {
    scenario: "prospective-writer-native-diagnosis",
    file: "src/generation-recovery-resolution.ts",
    before: 'await verifyPublishedSupportDiagnostics(job, original, completed.entries) &&',
    after: 'true &&',
    assertion: "Historical discharge cannot waive its original diagnosis transcript",
  },
  {
    scenario: "prospective-review-stalled-continue",
    file: "src/generation-operation-strategy.ts",
    before: 'return { recoveryLifecycle: { ...decideRecovery(settled, ordinary), assessorPending: true },\n          reason: null, status: "running" };',
    after: 'return { recoveryLifecycle: { ...decideRecovery(settled, ordinary), assessorPending: false },\n          reason: "Read-only advice retained; no correction scheduled.", status: "blocked" };',
    assertion: "Supported diagnostic continuation must verify and discharge the original Case",
  },
];

const scratch = mkdtempSync(join(tmpdir(), "nt-recovery-mutations-"));
const env = { ...process.env, NT_SKILLS_CHECKOUT: skills,
  LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false", TRACE_TO_LANGSMITH: "false" };
for (const key of Object.keys(env)) {
  if (key.startsWith("NT_LIVE_") || key === "NT_GENERATION_TEST_SHARD" || key === "NT_TEST_KEEP_GENERATION") delete env[key];
}

function run(control, mutation) {
  const label = (mutation ? "mutated-" : "baseline-") + control.scenario;
  const cwd = join(scratch, label);
  for (const path of ["src", "test", "package.json", "tsconfig.json", "web/src", "web/test", "web/package.json"])
    cpSync(join(root, path), join(cwd, path), { recursive: true });
  for (const path of ["node_modules", "web/node_modules"])
    symlinkSync(join(root, path), join(cwd, path), "dir");
  if (mutation) {
    const file = join(cwd, control.file);
    const text = readFileSync(file, "utf8");
    if (text.split(control.before).length !== 2) throw Error("Mutation site changed: " + control.file);
    writeFileSync(file, text.replace(control.before, control.after));
  }
  const testName = "R14D Event native correction and negative Review recover in the original SQLite assignment " + control.scenario;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap",
    "--test-name-pattern=^" + testName + "$", "test/generation.test.ts"],
  { cwd, env, encoding: "utf8", timeout: 540_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  const correctlyFailed = mutation && result.status === 1 &&
    result.stdout.includes("not ok 1 - " + testName) &&
    result.stdout.includes(control.assertion) && /^# fail 1$/m.test(result.stdout);
  const passedBaseline = !mutation && result.status === 0 &&
    result.stdout.includes("\nok 1 - " + testName + "\n") && /^# skipped 0$/m.test(result.stdout);
  if (!correctlyFailed && !passedBaseline) throw Error(label + " did not reach the intended behavioral result:\n" + output);
  console.log(mutation ? "Killed " + control.scenario + " at: " + control.assertion : "Production baseline passed: " + control.scenario);
}

try {
  for (const control of controls) {
    run(control, false);
    run(control, true);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

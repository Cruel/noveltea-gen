// Explicit native-CLI certification: never report success if the required
// executable or canonical fixture was unavailable and a test silently skipped.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const cli = process.env.NT_NATIVE_CLI;
const checkout = process.env.NT_SKILLS_CHECKOUT;
const fixture = resolve(process.env.NT_STORY_FIXTURE_ROOT ??
  join(checkout ?? "../noveltea-skills", "fixtures/reference-story"));

if (!cli || !isAbsolute(cli) || !existsSync(cli)) {
  console.error("Story certification requires NT_NATIVE_CLI=<absolute installed native noveltea executable>.");
  process.exit(2);
}
if (!checkout || !existsSync(join(checkout, "src/cli.ts")) ||
    !existsSync(join(fixture, "creative-direction/last-bell.md"))) {
  console.error("Story certification requires NT_SKILLS_CHECKOUT with the canonical source and reference Story (optionally override NT_STORY_FIXTURE_ROOT).");
  process.exit(2);
}
const tests = [
  "test/story-generator-certification.test.ts",
  "test/validator.test.ts",
  "test/story-context.test.ts",
  "test/certification.test.ts",
];
const outcome = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  cwd: resolve("."), env: { ...process.env, NT_STORY_FIXTURE_ROOT: fixture },
  stdio: "inherit",
});
if (outcome.error) {
  console.error("Unable to execute Story certification:", outcome.error.message);
  process.exit(2);
}
process.exit(outcome.status ?? 2);

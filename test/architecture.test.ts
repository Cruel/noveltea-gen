import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { architectureMilestoneOrder, unapprovedArchitectureDecisionIds } from "../src/architecture-specialist.js";
import { verifiedArchitectureMilestoneOrder, verifyArchitectureAssignmentResult } from "../src/architecture.js";
import { authorizedArchitectureRecordPath } from "../src/architecture-record-path.js";

test("Architecture's sealed causal order names exactly its canonical Milestones", () => {
  const ids = ["milestone.discovery", "milestone.evidence", "milestone.resolution"];
  assert.deepEqual(architectureMilestoneOrder(
    "The route follows the evidence.\nCAUSAL_MILESTONE_ORDER: " + ids.join(',') + "\n"), ids);
  assert.deepEqual(verifiedArchitectureMilestoneOrder(ids,
    ["milestone.resolution", "milestone.discovery", "milestone.evidence"]), ids);
  assert.equal(architectureMilestoneOrder("I cannot choose a causal order."), null);
  assert.equal(architectureMilestoneOrder("CAUSAL_MILESTONE_ORDER: milestone.discovery,milestone.discovery"), null);
  assert.equal(architectureMilestoneOrder("CAUSAL_MILESTONE_ORDER: milestone.discovery\n" +
    "CAUSAL_MILESTONE_ORDER: milestone.evidence"), null);
  assert.throws(() => verifiedArchitectureMilestoneOrder(ids.slice(0, 2), ids), /canonical scope/);
  assert.throws(() => verifiedArchitectureMilestoneOrder([...ids.slice(0, 2), "milestone.unknown"], ids),
    /canonical scope/);
});

test("Architecture accepts native-valid dot-separated filenames without deriving typed IDs from filenames", () => {
  for (const path of [
    "arcs/last-passenger.md", "arcs/arc.last-passenger.md",
    "milestones/disappearance-established.md",
    "milestones/milestone.disappearance-established.md",
    "milestones/safe.part.one.md",
  ]) assert.equal(authorizedArchitectureRecordPath(path), true, path);
  for (const path of [
    "characters/character.ada.md", "creative-direction/foundation.md",
    "arcs/.private.md", "arcs/arc..bad.md", "arcs/arc.foo/bar.md",
    "arcs/../characters/ada.md", "milestones/../secrets.md",
    "milestones/milestone..md", "milestones/x.json",
    "milestones/Some Item.md", "/arcs/arc.safe.md",
  ]) assert.equal(authorizedArchitectureRecordPath(path), false, path);
});

test("Architecture cannot invent author-protected decisions during initial authoring or a correction", () => {
  const record = (origin: string, authority: string, statement = "Fair clues are mandatory") =>
    `---\nschema: '0.1'\ntype: milestone\nid: milestone.evidence\ndecisions:\n  - id: fair-play\n    statement: "${statement}"\n    origin: ${origin}\n    authority: ${authority}\nchange: "The evidence is disclosed"\n---\n\nThe mystery has fair clues.\n`;
  assert.deepEqual(unapprovedArchitectureDecisionIds(record("agent", "user-protected")), ["fair-play"]);
  assert.deepEqual(unapprovedArchitectureDecisionIds(record("user", "user-protected")), ["fair-play"]);
  assert.deepEqual(unapprovedArchitectureDecisionIds(record("agent", "delegated")), []);
  assert.deepEqual(unapprovedArchitectureDecisionIds(record("user", "user-protected"),
    record("user", "user-protected")), [], "Existing exact author protection remains intact");
  assert.deepEqual(unapprovedArchitectureDecisionIds(record("user", "user-protected", "Changed"),
    record("user", "user-protected")), ["fair-play"],
    "A changed protected statement is not grandfathered in");
  const body = "---\ndecisions: []\n---\n\nA character says origin: agent and authority: user-protected.\n";
  assert.deepEqual(unapprovedArchitectureDecisionIds(body), [], "Narrative text is not a decision grant");
});

const root = mkdtempSync(join(tmpdir(), "nt-architecture-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(name: string, protectedDecision = false, planning = '') {
  const repo = join(root, name);
  mkdirSync(join(repo, "story/creative-direction"), { recursive: true });
  const story = join(repo, "story");
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: ${planning ? 'approved' : 'draft'}
${protectedDecision ? 'decisions:\n  - id: loyalty\n    statement: "Loyalty must matter"\n    origin: user\n    authority: user-protected' : "decisions: []"}
premise: "A witness disappears before an inquiry"
central_conflict: "Expose the truth or preserve a friendship"
genre: "Mystery"
tone: "Intimate"
player_experience: "Consequential conversations"
scope: "A compact dialogue-led story"
${planning}---

An investigator must decide what loyalty costs when a friend conceals evidence.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Foundation");
  const baseline = git(repo, "rev-parse", "HEAD");
  function cli(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
        NT_CONFIG_FILE: join(root, "absent.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
         },
    });
  }
  const started = cli("start"); assert.equal(started.status, 0, started.stderr);
  function signEvidence(payload: Record<string, unknown>) {
    return authorApproval(story, "draft", { ...process.env, NT_STATE_DIR: join(root, name + "-state") }, root, payload).file;
  }
  return { repo, story, baseline, cli, job: JSON.parse(started.stdout), signEvidence };
}
function contract(name: string, kind = "partial", depth = "architecture") {
  const path = join(root, name + ".json");
  writeFileSync(path, JSON.stringify({ scope: { kind, depth, targets: [], branches: [] },
    constraints: ["Preserve the investigator's choice of loyalty"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: ["Reuse the inquiry room"], preferences: ["Small cast"] } }));
  return path;
}

function scopedContract(name: string, scope: { kind: string; depth: string; targets: string[]; branches: string[] }) {
  const path = join(root, name + "-scope.json");
  writeFileSync(path, JSON.stringify({ scope,
    constraints: ["Keep the player free to challenge the investigator"],
    envelope: { presentation: "Dialogue-first", hardLimits: ["One inquiry setting"],
      preferences: ["Reused backgrounds", "Sparse new character art"] } }));
  return path;
}

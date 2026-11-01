import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Exercise the real trusted CLI in a separate OS terminal, never forge ledger rows. */
export function authorApproval(story: string, job: string, env: NodeJS.ProcessEnv,
  directory: string, payload: any) {
  const id = "author-" + randomUUID();
  const file = join(directory, id + ".json");
  writeFileSync(file, JSON.stringify(payload));
  const args = ["--import", "tsx", resolve("src/cli.ts"), "job", "approval"];
  const requested = spawnSync(process.execPath, [...args, "request", "--story", story,
    "--job", job, "--id", id, "--file", file], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(requested.status, 0, requested.stderr);
  const request = JSON.parse(requested.stdout);
  const decision = payload.action === "rejected" || payload.verdict === "block" ? "REJECT" : "APPROVE";
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const decided = spawnSync("script", ["-q", "-e", "-c",
    [process.execPath, ...args, "decide", "--story", story, "--job", job, "--id", id].map(quote).join(" "), "/dev/null"],
  { env, encoding: "utf8", input: decision + " " + request.proposalSha256 + "\n", timeout: 30000 });
  assert.equal(decided.status, 0, decided.stdout + decided.stderr);
  const reference = { receiptId: id, nonce: request.nonce };
  writeFileSync(file, JSON.stringify(reference));
  return { file, reference };
}

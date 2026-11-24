#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { startStoryJob } from "./job.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { parseGenerationContract, requireGenerationTurn, type GenerationRequest } from "./generation.js";

/** Prepare production Studio input without invoking a writer or creating a job. */
async function main(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (values.has(name)) throw new Error("Duplicate option: " + name);
    if (name === "--fixture") { values.set(name, "true"); continue; }
    const value = args[++i];
    if (!value || value.startsWith("--") || !["--story", "--job", "--task", "--contract",
      "--provider", "--model", "--skills-source"].includes(name)) {
      throw new Error("Usage: pnpm studio:input --story <existing-story> --job <id> --task <objective> --contract <json-file> [--fixture] [--skills-source <path>]");
    }
    values.set(name, value);
  }
  const story = values.get("--story"), job = values.get("--job"), task = values.get("--task"), file = values.get("--contract");
  if (!story || !job || !task?.trim() || !file) throw new Error("Studio input requires --story, --job, --task and --contract.");
  const selected = await startStoryJob({ story, job }, false);
  const contract = parseGenerationContract(JSON.parse(await readFile(file, "utf8")));
  const turn = await readTurnEvidence(selected, contract, task);
  if (!turn?.objective)
    throw Error("Studio input requires an authenticated current-format Turn plan already prepared for this Job.");
  const request: GenerationRequest = { story: selected.storyRoot, job, task, contract,
    fixture: values.has("--fixture"), provider: values.get("--provider"), model: values.get("--model"),
    skillsSource: values.get("--skills-source"), turnPlanDigest: turn.digest,
    orchestrationPolicy: "explicit" };
  await requireGenerationTurn(selected, request);
  process.stdout.write(JSON.stringify({ request }, null, 2) + "\n");
}
main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`noveltea-gen studio input: ${error instanceof Error ? error.message : "error"}\n`);
  process.exitCode = 1;
});

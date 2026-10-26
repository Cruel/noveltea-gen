#!/usr/bin/env node
import { showLocalTrace } from "./local-trace.js";

showLocalTrace(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`noveltea-gen: ${error instanceof Error ? error.message : "Unable to read local trace"}\n`);
  process.exitCode = 1;
});

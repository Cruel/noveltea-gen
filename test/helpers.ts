import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Only for disposable test roots; production pinned snapshots remain sealed. */
export function makeTestTreeWritable(root: string) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) makeTestTreeWritable(join(root, entry.name));
  }
  chmodSync(root, 0o755);
}

export function removeTestTree(root: string) {
  makeTestTreeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

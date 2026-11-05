import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** The deployed CLI does not change during a worker lifetime. Cache its version
 * per selected executable so normal validation performs no version subprocess
 * or executable-content verification. New processes check again on resume. */
const versions = new Map<string, string>();

export function nativeExecutable(): string {
  const selected = process.env.NT_NATIVE_CLI;
  const name = process.platform === "win32" ? "noveltea.exe" : "noveltea";
  if (selected) {
    if (!isAbsolute(selected)) throw new Error("NT_NATIVE_CLI must be an absolute executable path.");
    return selected;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The native 'noveltea' executable is required for Story validation (set NT_NATIVE_CLI or PATH).");
}

export function nativeVersion(): string {
  const executable = nativeExecutable();
  const cached = versions.get(executable);
  if (cached !== undefined) return cached;
  let version: string;
  try {
    version = execFileSync(executable, ["--version"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Unable to read the native NovelTea CLI version. Verify NT_NATIVE_CLI and executable permissions.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Native NovelTea CLI returned an invalid --version response.");
  versions.set(executable, version);
  return version;
}

export function assertNativeVersion(expected: string): void {
  const current = nativeVersion();
  if (current !== expected)
    throw new Error(`Story job requires NovelTea CLI version ${expected}, but installed version is ${current}. Restore that version or start a new Thread.`);
}

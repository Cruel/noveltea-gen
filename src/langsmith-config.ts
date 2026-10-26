import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Optional, gitignored local developer credentials. This function must only
 * be called after an explicit --trace / NT_STUDIO_TRACE=1 selection.
 *
 * Node's env-file loader does not override existing environment variables:
 * explicit CI/shell credentials retain precedence over local settings.
 */
export function loadLocalLangSmithCredentials(
  path = fileURLToPath(new URL("../.local/langsmith.env", import.meta.url)),
): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

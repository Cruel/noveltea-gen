import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDirectories = ["src", "web/src", "test", "web/test", "scripts"];
const errors = [];
const extensions = /\.(?:[cm]?[jt]s|tsx)$/;

/** General source hygiene lint, independent of the DB-specific boundary lint.
 * The repo has mixed legacy formatting styles, so no automatic reformat is
 * performed by the test/build pipeline. See the root format command.
 */
function inspect(file) {
  const content = readFileSync(file, "utf8");
  const path = relative(root, file).split(sep).join("/");
  if (path === "web/src/routeTree.gen.ts") return; // TanStack-generated, not authored source
  const fail = (reason) => errors.push(path + ": " + reason);
  if (content.includes("\r")) fail("CRLF/CR line endings are prohibited");
  if (!content.endsWith("\n")) fail("missing final newline");
  if (/[ \t]+$/m.test(content)) fail("trailing whitespace");
  if (/^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(content)) fail("unresolved merge conflict");
  if (/\/\/\s*@ts-(?:ignore|nocheck)\b/.test(content)) fail("unchecked TypeScript suppression");
  const scriptKind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".mjs") || file.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  for (const diagnostic of parsed.parseDiagnostics) {
    const { line, character } = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    fail("TypeScript/JavaScript parse error at " + (line + 1) + ":" + (character + 1));
  }
  function walk(node) {
    // Test files must use the same persistence ports as application code and
    // backend-neutral testing operations. SQLite-specific implementation
    // belongs only in the test SQLite adapter, not in feature tests.
    if (
      path.startsWith("web/test/") &&
      path !== "web/test/support/sqlite-test-records.ts" &&
      path !== "web/test/support/sqlite-controller-fixture.ts" &&
      path !== "web/test/support/sqlite-oauth-source.ts"
    ) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "sqlite")
        fail("direct SQLite driver access in test: use store.testing or StudioPersistence");
      if (ts.isIdentifier(node) && ["studioSqliteDriver", "studioDrizzleForMigrations"].includes(node.text))
        fail("internal SQLite driver/Drizzle accessor in test");
      if (
        ts.isStringLiteral(node) &&
        ts.isImportDeclaration(node.parent) &&
        (/^better-sqlite3$/.test(node.text) || node.text.includes("drizzle-orm/better-sqlite3"))
      )
        fail("SQLite import in test outside isolated backend test adapter");
    }
    if (node.kind === ts.SyntaxKind.DebuggerStatement) fail("debugger statement");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")
      fail("dynamic eval() call");
    ts.forEachChild(node, walk);
  }
  walk(parsed);
}

function walkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walkDirectory(full);
    else if (entry.isFile() && extensions.test(entry.name)) inspect(full);
  }
}
for (const dir of sourceDirectories) walkDirectory(join(root, dir));
assert.deepEqual(errors, [], "Source lint errors:\n" + errors.join("\n"));
console.log("Source hygiene lint: passed");

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

/** Keep implementation-specific agent/runtime terminology out of visible Studio
 * controls. Internal file names, imports and SDK status identifiers are allowed. */
test('Studio JSX labels and messages do not expose the internal agent runtime name', () => {
  const sources = [resolve(import.meta.dirname, '../src/components'),
    resolve(import.meta.dirname, '../src/routes')]
  const failures: string[] = []
  const inspect = (file: string) => {
    const text = readFileSync(file, 'utf8')
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const check = (value: string, node: ts.Node) => {
      if (/\bPi\b/.test(value)) {
        const position = ast.getLineAndCharacterOfPosition(node.getStart(ast))
        failures.push(file + ':' + (position.line + 1) + ': ' + value.trim().slice(0, 120))
      }
    }
    const stringExpressions = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        check(node.text, node)
      ts.forEachChild(node, stringExpressions)
    }
    const traverse = (node: ts.Node) => {
      if (ts.isJsxText(node)) check(node.getText(ast), node)
      if (ts.isJsxAttribute(node) && node.initializer &&
          ts.isStringLiteral(node.initializer)) check(node.initializer.text, node)
      if (ts.isJsxExpression(node) && node.expression) stringExpressions(node.expression)
      ts.forEachChild(node, traverse)
    }
    traverse(ast)
  }
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && path.endsWith('.tsx')) inspect(path)
    }
  }
  sources.forEach(visit)
  assert.deepEqual(failures, [], failures.join('\n'))
})

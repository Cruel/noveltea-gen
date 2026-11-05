import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web/src')
const driverExempt = new Set([
  'db/connection.ts', // owns the driver and lifecycle
  'db/migrations.ts', // PRAGMAs and Drizzle migration history
  'db/migrate-cli.ts', // offline operator migration command
  'db/trusted-catalog.ts', // isolated, read-only sandbox authorization
])

const driverPatterns = [
  { pattern: /['"](?:better-sqlite3|drizzle-orm\/better-sqlite3|node:sqlite)(?:\/[^'"]*)?['"]/,
    reason: 'raw SQLite module import' },
  { pattern: /\b(?:store|database|connection|db)\s*(?:(?:\?\.|\.)\s*sqlite\b|\[\s*['"]sqlite['"]\s*\])/,
    reason: 'raw SQLite handle access' },
  { pattern: /\.sqlite\.(?:prepare|exec|pragma|transaction|close)\s*\(/,
    reason: 'raw SQLite driver call' },
  { pattern: /\.prepare\s*\(|\.pragma\s*\(/,
    reason: 'raw SQLite statement or PRAGMA' },
  { pattern: /\bstudioDrizzleForMigrations\b/,
    reason: 'Drizzle migration handle outside infrastructure' },
  { pattern: /from\s*['"][^'"]*\/persistence\/[^'"]+-sqlite['"]/,
    reason: 'direct SQLite persistence implementation import' },
]

/** Run on every Studio source file, including routes and server functions.
 * The only auth exception is its required Better Auth embedded-driver config.
 * App logic must use StudioDatabase.persistence ports instead.
 */
export function sourceViolations(path, source) {
  if (path.startsWith('persistence/') || driverExempt.has(path)) return []
  const errors = driverPatterns.filter(({ pattern }) => pattern.test(source)).map(x => x.reason)
  if (path !== 'lib/auth.ts' && /\bstudioSqliteDriver\b/.test(source)) {
    errors.push('raw SQLite accessor outside Better Auth adapter')
  }
  if (/from\s*['"][^'"]*\/db\/trusted-catalog['"]/.test(source) &&
      path !== 'sandbox-controller.ts') {
    errors.push('trusted controller adapter accessed outside sandbox controller')
  }
  return errors
}

export function assertPersistenceBoundary(root = sourceRoot) {
  const failures = []
  const scan = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) { scan(absolute); continue }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue
      const name = relative(root, absolute).split(sep).join('/')
      const violations = sourceViolations(name, readFileSync(absolute, 'utf8'))
      if (violations.length) failures.push(`${name}: ${violations.join('; ')}`)
    }
  }
  scan(root)
  assert.deepEqual(failures, [], 'Studio persistence boundary violations:\n' + failures.join('\n'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertPersistenceBoundary()
  console.log('Studio persistence boundary: enforced')
}

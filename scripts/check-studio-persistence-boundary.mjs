import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web/src')
const driverExempt = new Set([
  'db/connection.ts', // owns the legacy driver and lifecycle
  'db/kysely-connection.ts', // owns both shared drivers and guarded transaction lifecycle
  'db/kysely-baseline.ts', // isolated SQLite parity reference for cross-engine schema migration
  'db/kysely-migrations.ts', // explicit Kysely migration and read-only schema introspection
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
  { pattern: /\b(?:sqliteBridge|sqliteTransactionBridge|studioDrizzleForMigrations)\b/,
    reason: 'Drizzle migration handle outside infrastructure' },
  { pattern: /from\s*['"][^'"]*\/db\/migrations['"]/, reason: 'schema maintenance import outside database adapter' },
  { pattern: /from\s*['"][^'"]*\/persistence\/[^'"]+-sqlite['"]/,
    reason: 'direct SQLite persistence implementation import' },
]

/** Run on every Studio source file, including routes and server functions.
 * Auth storage, schema verification and driver access stay behind backend
 * infrastructure. App logic must use StudioStore persistence ports and its
 * asynchronous schema-readiness method.
 */
export function sourceViolations(path, source) {
  if ((path.startsWith('persistence/') && (path.endsWith('-sqlite.ts') || path === 'persistence/sqlite.ts')) || driverExempt.has(path)) return []
  const errors = driverPatterns.filter(({ pattern }) => pattern.test(source)).map(x => x.reason)
  const databaseAdapter = path.startsWith('db/')
  const sharedRepository = path.startsWith('persistence/') && path.endsWith('-kysely.ts')
  if (!databaseAdapter && !sharedRepository &&
      /(?:['"](?:pg|kysely(?:\/[^'"]*)?)['"]|from\s*['"][^'"]*\/db\/kysely-connection['"])/.test(source)) {
    errors.push('shared database infrastructure outside persistence adapter')
  }
  if (!databaseAdapter &&
      /(?:from\s*|require\(\s*|import\(\s*)['"]pg['"]/.test(source)) {
    errors.push('PostgreSQL driver outside database infrastructure')
  }
  if (!databaseAdapter && !path.startsWith('persistence/') &&
      /from\s*['"][^'"]*\/persistence\/[^'"]+-kysely['"]/.test(source)) {
    errors.push('Kysely repository imported by application caller')
  }
  if (/\bstudioSqliteDriver\b/.test(source)) {
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

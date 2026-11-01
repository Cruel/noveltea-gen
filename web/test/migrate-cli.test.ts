import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'

const webRoot = fileURLToPath(new URL('..', import.meta.url))

test('migration command initializes, verifies and repeats on a durable SQLite database without background schema errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-migrate-'))
  const filename = join(directory, 'studio.sqlite')
  const env = {
    ...process.env,
    NT_STUDIO_DB_PATH: filename,
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'stable-migration-test-secret-012345678901234567890',
    GITHUB_CLIENT_ID: 'test-gh',
    GITHUB_CLIENT_SECRET: 'test-gh-secret',
    GITLAB_CLIENT_ID: 'test-gl',
    GITLAB_CLIENT_SECRET: 'test-gl-secret',
  }
  try {
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('pnpm', ['exec', 'tsx', 'src/db/migrate-cli.ts'], {
        cwd: webRoot, encoding: 'utf8', env, timeout: 20_000,
      })
      assert.equal(result.status, 0, `Migration run ${run + 1} failed: ${result.stderr}`)
      assert.match(result.stdout, /NovelTea Studio SQLite migrations applied/)
      assert.doesNotMatch(result.stderr, /ERROR \[Better Auth\]|schema mismatch|Could not validate the database schema/i)
    }
    const store = openStudioDatabase(filename)
    try {
      const tables = (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>).map(row => row.name)
      for (const name of ['user', 'session', 'account', 'verification', 'rateLimit', 'repositories', 'stories', 'studio_sessions', 'github_install_flows']) {
        assert.ok(tables.includes(name), `Missing ${name}`)
      }
      assert.deepEqual(store.sqlite.prepare('SELECT version FROM studio_schema_migrations ORDER BY version').all(), [
        { version: 1 }, { version: 2 }, { version: 3 },
      ])
      assert.ok((store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).some(column => column.name === 'source_commit_sha'))
      assert.deepEqual(store.sqlite.pragma('integrity_check'), [{ integrity_check: 'ok' }])
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      // Simulate an upgrade to a future Studio version: downgrades must fail,
      // never claim success or rewrite a schema owned by newer code.
      store.sqlite.prepare('INSERT INTO studio_schema_migrations (version) VALUES (999)').run()
    } finally { store.sqlite.close() }
    const rejected = spawnSync('pnpm', ['exec', 'tsx', 'src/db/migrate-cli.ts'], {
      cwd: webRoot, encoding: 'utf8', env, timeout: 20_000,
    })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /newer application/)
    assert.doesNotMatch(rejected.stdout, /SQLite migrations applied/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

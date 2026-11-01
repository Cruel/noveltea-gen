import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    for (let run = 0; run < 3; run++) {
      if (run === 1) {
        // Model a user's persisted pre-#43 database, rather than only testing
        // fresh installations and already-current databases.
        const oldStore = openStudioDatabase(filename)
        try {
          oldStore.sqlite.exec('ALTER TABLE stories DROP COLUMN source_commit_sha')
          oldStore.sqlite.prepare('DELETE FROM studio_schema_migrations WHERE version=3').run()
        } finally { oldStore.sqlite.close() }
      }
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
      for (const name of ['user', 'session', 'account', 'verification', 'rateLimit', 'repositories', 'stories', 'studio_sessions', 'github_install_flows', 'story_onboarding_drafts', 'pi_credentials']) {
        assert.ok(tables.includes(name), `Missing ${name}`)
      }
      assert.deepEqual(store.sqlite.prepare('SELECT version FROM studio_schema_migrations ORDER BY version').all(), [
        { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 },
      ])
      assert.ok((store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).some(column => column.name === 'source_commit_sha'))
      assert.ok((store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).some(column => column.name === 'initial_content_sha256'))
      const sessionColumns = (store.sqlite.pragma('table_info(studio_sessions)') as Array<{ name: string }>).map(column => column.name)
      for (const column of ['source_commit_sha', 'generation_request_json', 'generation_thread_id', 'generation_config_json']) {
        assert.ok(sessionColumns.includes(column), 'Missing session column ' + column)
      }
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

test('migration CLI loads the Vite development environment including local overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-migrate-env-'))
  const ignoredPath = join(directory, 'ignored.sqlite')
  const databasePath = join(directory, 'from-env-local.sqlite')
  // Simulate Vite's env files without reading or changing real OAuth secrets.
  writeFileSync(join(directory, '.env'), [
    'BETTER_AUTH_URL=http://localhost:3000',
    'BETTER_AUTH_SECRET=local-cli-env-test-secret-012345678901234567890',
    'GITHUB_CLIENT_ID=local-github',
    'GITHUB_CLIENT_SECRET=local-github-secret',
    'GITLAB_CLIENT_ID=local-gitlab',
    'GITLAB_CLIENT_SECRET=local-gitlab-secret',
    `NT_STUDIO_DB_PATH=${ignoredPath}`,
  ].join('\n') + '\n')
  writeFileSync(join(directory, '.env.local'), `NT_STUDIO_DB_PATH=${databasePath}\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' }
  for (const key of [
    'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET',
    'NT_STUDIO_DB_PATH',
  ]) delete env[key]
  try {
    const result = spawnSync(join(webRoot, 'node_modules/.bin/tsx'),
      [join(webRoot, 'src/db/migrate-cli.ts')], {
        cwd: directory, env, encoding: 'utf8', timeout: 20_000,
      })
    assert.equal(result.status, 0, `Migration without exported .env failed: ${result.stderr}`)
    assert.match(result.stdout, /NovelTea Studio SQLite migrations applied/)
    assert.ok(existsSync(databasePath), 'Vite .env.local DB path was not used')
    assert.equal(existsSync(ignoredPath), false, 'Base .env DB path unexpectedly won')
    const store = openStudioDatabase(databasePath)
    try {
      assert.deepEqual(store.sqlite.prepare('SELECT version FROM studio_schema_migrations ORDER BY version').all(),
        [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }])
    } finally { store.sqlite.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

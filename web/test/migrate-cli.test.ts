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
      for (const name of ['user', 'session', 'account', 'verification', 'rateLimit', 'repositories', 'stories', 'studio_sessions', 'github_install_flows', 'story_onboarding_drafts', 'story_onboarding_conversations', 'pi_credentials', 'generation_events', 'generation_run_queue', 'github_publications', 'gitlab_publications', 'user_preferences', 'git_connections', 'git_connection_flows', 'story_conversations', 'story_threads', 'story_thread_runs', 'story_thread_preferences', 'story_thread_messages', 'checkpoint_forks', 'thread_restarts', 'thread_protected_decisions', 'thread_live_inputs', 'thread_active_pi_turns',
        'thread_queued_message_edits', 'thread_live_effect_reviews',
        'thread_steering_intents', 'thread_steering_checkpoint_links']) {
        assert.ok(tables.includes(name), `Missing ${name}`)
      }
      const history = store.sqlite.prepare('SELECT hash,created_at AS createdAt FROM __drizzle_migrations').all() as Array<{ hash: string; createdAt: number }>
      assert.equal(history.length, 1, 'Fresh Studio database has one generated Drizzle baseline')
      assert.match(history[0]!.hash, /^[a-f0-9]{64}$/)
      assert.ok(history[0]!.createdAt > 0)
      for (const column of ['source_thread_id', 'proof_digest', 'guidance', 'history_json', 'edited_message_id', 'edited_body']) {
        assert.ok((store.sqlite.pragma('table_info(checkpoint_forks)') as Array<{ name: string }>)
          .some(entry => entry.name === column), 'Missing fork column ' + column)
      }
      assert.ok((store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).some(column => column.name === 'source_commit_sha'))
      assert.ok((store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>).some(column => column.name === 'initial_content_sha256'))
      assert.ok((store.sqlite.pragma('table_info(story_thread_messages)') as Array<{ name: string }>)
        .some(column => column.name === 'revision_scope_json'))
      assert.ok(tables.includes('story_thread_message_cancellations'),
        'Cancellation audit table must be present after migration')
      const sessionColumns = (store.sqlite.pragma('table_info(studio_sessions)') as Array<{ name: string }>).map(column => column.name)
      for (const column of ['source_commit_sha', 'generation_request_json', 'generation_thread_id', 'generation_config_json']) {
        assert.ok(sessionColumns.includes(column), 'Missing session column ' + column)
      }
      assert.deepEqual(store.sqlite.pragma('integrity_check'), [{ integrity_check: 'ok' }])
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      // Simulate an upgrade to a future Studio version: downgrades must fail,
      // never claim success or rewrite a schema owned by newer code.
      store.sqlite.prepare("INSERT INTO __drizzle_migrations (hash,created_at) VALUES ('future-version', 9999999999999)").run()
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
      assert.equal((store.sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number }).count, 1)
    } finally { store.sqlite.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

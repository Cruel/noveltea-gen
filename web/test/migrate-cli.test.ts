import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openSharedStudioStore } from '../src/db/shared-studio-store'
import { openStudioSchemaConnection, inspectStudioMigrationHistory,
  studioMigrationNames } from '../src/db/kysely-migrations'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const authEnv = {
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'stable-migration-test-secret-012345678901234567890',
  GITHUB_CLIENT_ID: 'test-gh',
  GITHUB_CLIENT_SECRET: 'test-gh-secret',
  GITLAB_CLIENT_ID: 'test-gl',
  GITLAB_CLIENT_SECRET: 'test-gl-secret',
}

function migrate(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(join(webRoot, 'node_modules/.bin/tsx'), [join(webRoot, 'src/db/migrate-cli.ts')], {
    cwd, encoding: 'utf8', env, timeout: 20_000,
  })
}

test('default migration command is idempotent Kysely on a durable SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-migrate-'))
  const filename = join(directory, 'studio.sqlite')
  const env = { ...process.env, ...authEnv, NT_STUDIO_DB_BACKEND: 'sqlite', NT_STUDIO_DB_PATH: filename }
  try {
    for (let run = 0; run < 3; run++) {
      const result = migrate(webRoot, env)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Kysely migration up completed/)
    }
    const maintenance = openStudioSchemaConnection({ backend: 'sqlite', path: filename }, 'read')
    try {
      assert.equal(await inspectStudioMigrationHistory(maintenance), studioMigrationNames().length)
    } finally {
      await maintenance.close()
    }
    const store = openSharedStudioStore({ backend: 'sqlite', path: filename })
    try {
      await store.assertReady()
      assert.deepEqual(await store.persistence.settings.listRepositories('owner'), [])
    } finally {
      await store.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('migration CLI loads Vite local overrides rather than creating the base DB', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-migrate-env-'))
  const ignoredPath = join(directory, 'ignored.sqlite')
  const databasePath = join(directory, 'from-env-local.sqlite')
  writeFileSync(join(directory, '.env'), [
    ...Object.entries(authEnv).map(([name, value]) => name + '=' + value),
    `NT_STUDIO_DB_PATH=${ignoredPath}`,
  ].join('\n') + '\n')
  writeFileSync(join(directory, '.env.local'), `NT_STUDIO_DB_PATH=${databasePath}\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', NT_STUDIO_DB_BACKEND: 'sqlite' }
  for (const key of [...Object.keys(authEnv), 'NT_STUDIO_DB_PATH']) delete env[key]
  try {
    const result = migrate(directory, env)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(databasePath))
    assert.equal(existsSync(ignoredPath), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

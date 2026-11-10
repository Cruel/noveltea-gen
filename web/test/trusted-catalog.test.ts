import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createControllerFixtureDatabase, createEmptyControllerFixtureDatabase,
  changeControllerFixtureStoryOwner, changeControllerFixtureRepositoryOwner,
  unpinControllerFixtureJob, deleteControllerFixtureJob,
} from './support/sqlite-controller-fixture'
import { openTrustedCatalog, readTrustedControllerJob } from '../src/db/trusted-catalog'

const jobId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('trusted catalog reads the owner-scoped job projection and never creates an absent database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-trusted-catalog-'))
  try {
    const path = join(directory, 'missing.sqlite')
    assert.throws(() => openTrustedCatalog({ backend: 'sqlite', path }), /open database|unable to open database/i)
    assert.equal(existsSync(path), false)
    createControllerFixtureDatabase(directory, jobId, 'story', null)
    const reader = openTrustedCatalog({ backend: 'sqlite', path: join(directory, 'studio.sqlite') })
    try {
      assert.deepEqual(await reader.readJob(jobId), {
        ownerId: 'owner-1', provider: 'github', providerId: '987',
        directory: 'story', pin: 'a'.repeat(40), configJson: null,
      })
      assert.equal(await reader.readJob('ffffffff-ffff-4fff-8fff-ffffffffffff'), null)
      assert.equal(await reader.readJob(jobId + "' OR 1=1 --"), null)
      assert.equal('withWriteTransaction' in reader, false)
      assert.equal('db' in reader, false)
    } finally { await reader.close() }
    await assert.rejects(reader.readJob(jobId), /closed/)
    assert.equal((await readTrustedControllerJob({ backend: 'sqlite', path: join(directory, 'studio.sqlite') }, jobId))?.ownerId, 'owner-1')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('trusted catalog rejects partial schemas, cross-owner joins and stale registrations without DDL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-trusted-catalog-'))
  const path = join(directory, 'studio.sqlite')
  try {
    createEmptyControllerFixtureDatabase(directory)
    await assert.rejects(
      readTrustedControllerJob({ backend: 'sqlite', path }, jobId),
      /no such table: studio_sessions/,
    )
    rmSync(path)
    createControllerFixtureDatabase(directory, jobId, 'story')
    changeControllerFixtureStoryOwner(directory, 'owner-2')
    assert.equal(await readTrustedControllerJob({ backend: 'sqlite', path }, jobId), null)
    changeControllerFixtureStoryOwner(directory, 'owner-1')
    changeControllerFixtureRepositoryOwner(directory, 'owner-2')
    assert.equal(await readTrustedControllerJob({ backend: 'sqlite', path }, jobId), null)
    changeControllerFixtureRepositoryOwner(directory, 'owner-1')
    unpinControllerFixtureJob(directory)
    await assert.rejects(
      readTrustedControllerJob({ backend: 'sqlite', path }, jobId),
      /pinned source SHA/,
    )
    deleteControllerFixtureJob(directory)
    assert.equal(await readTrustedControllerJob({ backend: 'sqlite', path }, jobId), null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('PostgreSQL trusted reader refuses an elevated or incomplete connection before using the network', () => {
  assert.throws(() => openTrustedCatalog({
    backend: 'postgres', connection: {
      host: 'postgres', database: 'noveltea', user: 'noveltea_app', password: 'test',
    },
  }), /restricted controller role/)
  assert.throws(() => openTrustedCatalog({
    backend: 'postgres', connection: {
      host: 'postgres', database: 'noveltea', user: 'noveltea_controller',
    },
  }), /restricted controller role/)
})

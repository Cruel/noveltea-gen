import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory, continueCachedStory } from '../src/lib/git-cache.server'
import { checkpointContinueRequest, checkpointForkRequest } from '../src/lib/checkpoint-fork.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { generationConfigurationRequest } from '../src/lib/generation-config.server'
import { generationJobRequest } from '../src/lib/fixture-jobs.server'
import { authorizedStoryJob, inspectRegisteredJob, selectedJob } from '../src/lib/fixture-jobs.server'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { sendAuthorUpdate } from '../../src/author-updates'
import { previewThreadMessageEdit, branchEditedThreadMessage, syncAppliedAuthorMessages } from '../src/lib/thread-message-edit.server'
import { startStoryJob } from '../../src/job'
import { readRecoveryFork } from '../../src/recovery-fork-state'
import { verifyCertifiedRecoveryLineage } from '../../src/certification-lineage'
import { inspectPreservedCheckpointRetry } from './support/preserved-checkpoint-retry'
import { specialistAuthorInstruction } from '../../src/specialist-author-instruction'
import { validateStoryJob } from '../../src/validator'

const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills')
const native = process.env.NT_NATIVE_CLI ?? '/home/thomas/dev/nt/build/cli/linux/noveltea'
const available = existsSync(native) && existsSync(join(skills, 'skills'))
const config = { baseURL: 'http://localhost:3000', secret: 'checkpoint-fork-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = { scope: { kind: 'partial' as const, depth: 'composition' as const,
  targets: ['arc.truth', 'milestone.disclosure'], branches: ['protect', 'challenge'] },
  constraints: ['The player can protect or challenge the witness'],
  envelope: { presentation: 'Dialogue-led visual novel', hardLimits: [], preferences: [] } }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('authenticated finalized World fork is isolated from a running dirty parent and continues with Character using native validation',
  { skip: !available, timeout: 240_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nt-checkpoint-fork-'))
    const keys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_SKILL_CACHE_DIR', 'NT_CONFIG_FILE',
      'NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE', 'NT_LIVE_GENERATION_IDEA']
    const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    Object.assign(process.env, { NT_STATE_DIR: join(root, 'state'), NT_GIT_CACHE_DIR: join(root, 'cache'),
      NT_SKILL_CACHE_DIR: join(root, 'skills'), NT_CONFIG_FILE: join(root, 'config.json'),
      NT_NATIVE_CLI: native, NT_STUDIO_SKILLS_SOURCE: skills })
    writeFileSync(process.env.NT_CONFIG_FILE!, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
    const store = openStudioDatabase(join(root, 'studio.sqlite'))
    try {
      await migrateStudio(store, config)
      const auth = createStudioAuth(store, config), ctx = await auth.$context
      const user = await ctx.internalAdapter.createUser({ name: 'Author', email: 'fork@example.test', emailVerified: true }, { method: 'test' })
      const session = await ctx.internalAdapter.createSession(user.id)
      const cookie = 'better-auth.session_token=' + session.token + '.' + createHmac('sha256', config.secret).update(session.token).digest('base64')
      const repo = join(root, 'remote'), storyId = randomUUID(), parentId = randomUUID(), childId = randomUUID(), repoId = randomUUID()
      mkdirSync(join(repo, 'story'), { recursive: true }); writeFileSync(join(repo, 'story', '.gitkeep'), '')
      git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Author'); git(repo, 'config', 'user.email', 'author@example.test')
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Initial Story')
      const initial = git(repo, 'rev-parse', 'HEAD')
      let parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: user.id,
        repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story', commit: initial, jobId: parentId })
      const seed = studioSeed(store)
      ;(await seed.repository({ id: repoId, ownerUserId: user.id, provider: 'github',
        providerRepositoryId: '123', name: 'Acme/Private', createdAt: '2026-01-01' }))
      ;(await seed.story({ id: storyId, ownerUserId: user.id, repositoryId: repoId,
        directory: 'story', title: 'Fork Story', createdAt: '2026-01-01',
        sourceCommitSha: initial }))
      const request = { story: parent.storyRoot, job: parentId, task: 'A missing archive witness; invent unspecified details', contract, fixture: true, skillsSource: skills }
      const draft = { version: 1, headSha: initial, task: request.task, contract, limits: { steps: 100 }, model: null }
      ;(await seed.job({ id: parentId, ownerUserId: user.id, storyId, title: 'Fork Story',
        sourceCommitSha: initial, status: 'running',
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
        generationRequestJson: JSON.stringify(request),
        generationThreadId: parent.threadId + ':generation:web',
        generationConfigJson: JSON.stringify(draft) }))
      const runtime = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
      process.env.NT_FOUNDATIONS_FIXTURE_CASE = 'dangling'
      try {
        const cfg = { configurable: { thread_id: parent.threadId + ':generation:web' }, recursionLimit: 1000 }
        await runtime.graph.updateState(cfg, { request, pauseAfter: 'foundations' })
        const result = await runtime.graph.invoke(null, cfg)
        assert.equal(result.status, 'blocked', 'Character must actually fail inside the unfinished foundations stage')
        assert.ok(result.completedStages.some(item => item.stage === 'architecture'))
        assert.ok(!result.completedStages.some(item => item.stage === 'foundations'))
      } finally {
        delete process.env.NT_FOUNDATIONS_FIXTURE_CASE
        runtime.saver.db.close()
      }
      parent = await startStoryJob({ story: parent.storyRoot, job: parentId }, false)
      const world = (await inspectRecoveryCheckpoints(parent)).find(p => p.eligible && p.workItem === 'world-foundations')!
      assert.ok(world)
      assert.equal(world.nextWorkItem, 'character-foundations')
      assert.deepEqual(world.dependencies['character-foundations'], ['world-foundations'])
      assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), world.commitSha)
      const failedFoundations = JSON.parse(readFileSync(join(parent.stateDir, 'character-world.json'), 'utf8'))
      assert.equal(failedFoundations.units[0].phase, 'committed')
      assert.equal(failedFoundations.units[1].phase, 'authored')
      assert.equal(failedFoundations.units[1].commitSha, undefined)
      assert.equal(git(parent.worktreeRoot, 'status', '--porcelain') !== '', true,
        'failed Character draft must remain uncommitted on the parent')
      assert.equal(JSON.parse(readFileSync(join(parent.stateDir, 'job.json'), 'utf8')).validatorVersion, parent.validatorVersion)
      mkdirSync(join(parent.stateDir, '.story-job-running'))
      writeFileSync(join(parent.stateDir, '.story-job-running', 'owner.json'), 'live parent lock evidence')
      writeFileSync(join(parent.stateDir, 'pi-budget.json'), 'parent budget evidence')
      await ensureRootThreads(store, user.id, storyId)
      const sourceThreadId = 'root:' + parentId
      // Simulate a new test process reopening the actual source database and
      // choosing an exact historical World checkpoint before invoking any Pi.
      writeFileSync(join(root, 'certification-source.json'), JSON.stringify({
        version: 1, mode: 'collaborative', jobId: parentId, storyId,
        ownerId: user.id, repositoryId: repoId, sourceSha: initial,
        storyRoot: parent.storyRoot, nativeCli: native, skillsSource: skills,
      }))
      const reopenedStore = openStudioDatabase(join(root, 'studio.sqlite'))
      try {
        const selection = { root, store: reopenedStore, skills, mode: 'collaborative',
          nativeCli: native, checkpointSha: world.commitSha }
        const verified = await inspectPreservedCheckpointRetry(selection)
        assert.equal(verified.parent.jobId, parentId)
        assert.equal(verified.checkpoint.nextWorkItem, 'character-foundations')
        assert.deepEqual(verified.checkpoint.completedWorkItems, world.completedWorkItems)
        assert.equal(verified.latest.jobId, parentId)
        const earlier = (await inspectRecoveryCheckpoints(parent)).find(point =>
          point.eligible && point.commitSha !== world.commitSha)
        assert.ok(earlier, 'Certification must permit choosing an earlier verified checkpoint')
        const rewind = await inspectPreservedCheckpointRetry({
          ...selection, checkpointSha: earlier.commitSha,
        })
        assert.equal(rewind.checkpoint.commitSha, earlier.commitSha)
        assert.notEqual(rewind.checkpoint.commitSha, verified.checkpoint.commitSha)
        assert.ok(rewind.checkpoint.completedWorkItems.length < verified.checkpoint.completedWorkItems.length)
        await assert.rejects(() => inspectPreservedCheckpointRetry({
          ...selection, checkpointSha: initial,
        }), /finalized and eligible/)
        await assert.rejects(() => inspectPreservedCheckpointRetry({
          ...selection, mode: 'autonomous',
        }), /creative mode/)
        await assert.rejects(() => inspectPreservedCheckpointRetry({
          ...selection, nativeCli: join(root, 'other-cli'),
        }), /validator executable/)
      } finally { await reopenedStore.close() }
      const insertMessage = async (id: string, ownerUserId: string, threadId: string,
        sequence: number, status: string, body: string, verifiedCommitSha: string | null) => {
        ;(await store.testing.records.insert('story_thread_messages', { id, ownerUserId, threadId,
          sequence, role: 'user', status, body, verifiedCommitSha, createdAt: '2026-01-01' }))
      }
      await insertMessage(randomUUID(), user.id, sourceThreadId, 0, 'delivered', 'Keep the witness uncertain', initial)
      await insertMessage(randomUUID(), user.id, sourceThreadId, 1, 'delivered', 'Future change after World', 'f'.repeat(40))
      await insertMessage(randomUUID(), user.id, sourceThreadId, 2, 'queued', 'Do not inherit active steering', null)
      const parentMessages = async () => (await store.testing.records.all<{
        body: string; status: string; verifiedCommitSha: string | null
      }>('story_thread_messages', { threadId: sourceThreadId }, { by: 'sequence' }))
        .map(row => ({ body: row.body, status: row.status, verifiedCommitSha: row.verifiedCommitSha }))
      const originalMessages = await parentMessages()
      const before = { head: git(parent.worktreeRoot, 'rev-parse', 'HEAD'), dirty: git(parent.worktreeRoot, 'status', '--porcelain'),
        database: readFileSync(join(parent.stateDir, 'web-generation.sqlite')) }
      const fork = async (body: unknown, authenticated = true) => {
        const response = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
          method: 'POST', headers: { origin: config.baseURL, ...(authenticated ? { cookie } : {}), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), parentId, config.baseURL)
        return { status: response.status, body: await response.json() as any }
      }
      const input = { childId, commitSha: world.commitSha, sourceBaseSha: initial,
        sourceThreadId, proofDigest: world.proofDigest, guidance: 'Focus on the witness and avoid new Character IDs.' }
      const forkCount = async () => (await store.testing.records.count('checkpoint_forks'))
      assert.equal(await forkCount(), 0)
      assert.equal((await fork(input, false)).status, 401)
      assert.equal((await fork({ ...input, sourceBaseSha: world.commitSha })).status, 409)
      assert.equal((await fork({ ...input, sourceThreadId: 'root:invalid' })).status, 409)
      assert.equal((await fork({ ...input, proofDigest: 'a'.repeat(64) })).status, 409)
      assert.equal((await fork({ ...input, commitSha: initial })).status, 409)
      assert.equal(await forkCount(), 0)
      const checkpointPath = join(parent.stateDir, 'recovery-checkpoints', world.commitSha + '.json')
      const authentic = readFileSync(checkpointPath, 'utf8')
      try {
        const forged = JSON.parse(authentic)
        forged.completedWorkItems.push('event-fabricated')
        writeFileSync(checkpointPath, JSON.stringify(forged))
        assert.equal((await fork({ ...input, childId: randomUUID() })).status, 409)
        assert.equal(await forkCount(), 0)
      } finally { writeFileSync(checkpointPath, authentic) }
      try {
        const obsolete = JSON.parse(authentic)
        obsolete.compatibility.graphSchema = 'noveltea-generation/v0'
        writeFileSync(checkpointPath, JSON.stringify(obsolete))
        const inspected = (await inspectRecoveryCheckpoints(parent)).find(p => p.commitSha === world.commitSha)
        assert.ok(inspected, 'unsupported layouts remain inspectable')
        assert.equal(inspected.eligible, false)
        assert.equal((await fork({ ...input, childId: randomUUID() })).status, 409)
      } finally { writeFileSync(checkpointPath, authentic) }
      const worldReceiptPath = join(parent.stateDir, 'character-world.json')
      const originalWorldReceipt = readFileSync(worldReceiptPath, 'utf8')
      try {
        const obsolete = JSON.parse(originalWorldReceipt)
        obsolete.version = 0
        writeFileSync(worldReceiptPath, JSON.stringify(obsolete))
        const failed = await fork({ ...input, childId: randomUUID() })
        assert.equal(failed.status, 409)
        assert.equal(failed.body.code, 'obsolete-checkpoint')
        assert.equal(await forkCount(), 0)
      } finally { writeFileSync(worldReceiptPath, originalWorldReceipt) }
      process.env.NT_STUDIO_SKILLS_SOURCE = join(root, 'missing-skills')
      try {
        const failure = await fork({ ...input, childId: randomUUID() })
        assert.equal(failure.status, 409)
        assert.equal(failure.body.code, 'missing-tooling')
        assert.equal(await forkCount(), 0)
      } finally { process.env.NT_STUDIO_SKILLS_SOURCE = skills }
      process.env.NT_NATIVE_CLI = join(root, 'missing-native-validator')
      try {
        assert.equal((await fork({ ...input, childId: randomUUID() })).status, 409)
        assert.equal(await forkCount(), 0)
      } finally { process.env.NT_NATIVE_CLI = native }
      const stranger = await ctx.internalAdapter.createUser({ name: 'Other', email: 'fork-other@example.test', emailVerified: true }, { method: 'test' })
      const strangerSession = await ctx.internalAdapter.createSession(stranger.id)
      const strangerCookie = 'better-auth.session_token=' + strangerSession.token + '.' + createHmac('sha256', config.secret).update(strangerSession.token).digest('base64')
      const foreign = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie: strangerCookie, 'content-type': 'application/json' }, body: JSON.stringify(input),
      }), parentId, config.baseURL)
      assert.equal(foreign.status, 404)
      assert.equal(await forkCount(), 0)
      // A newly installed, byte-different but protocol-compatible executable
      // must be re-pinned for the child. The source's original pin stays intact.
      const upgraded = join(root, 'compatible-current-noveltea')
      writeFileSync(upgraded, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.0.1\\n"; else exec "' +
        native + '" "$@"; fi\n')
      chmodSync(upgraded, 0o755)
      const sourceVersion = parent.validatorVersion
      const currentVersion = '1.0.1'
      assert.notEqual(currentVersion, sourceVersion)
      process.env.NT_NATIVE_CLI = upgraded
      // Old authored skill files are source evidence, not the child's runtime.
      // A current skill snapshot is freshly verified even if its historical
      // cached directory was removed after the source checkpoint finalized.
      const historicalSkillId = JSON.parse(originalWorldReceipt).snapshot.id as string
      const historicalSkillCache = join(process.env.NT_SKILL_CACHE_DIR!, historicalSkillId)
      assert.equal(existsSync(historicalSkillCache), true)
      renameSync(historicalSkillCache, historicalSkillCache + '.historical-unavailable')
      assert.equal(existsSync(historicalSkillCache), false)
      const made = await fork(input)
      assert.equal(existsSync(historicalSkillCache), true, 'current skills re-pin independently')
      assert.equal(made.status, 200, JSON.stringify(made.body))
      const child = await authorizedStoryJob(store, user.id, childId)
      assert.equal(child.headSha, world.commitSha)
      assert.equal(child.validatorVersion, currentVersion)
      assert.equal(JSON.parse(readFileSync(join(child.stateDir, 'job.json'), 'utf8')).validatorVersion, currentVersion)
      assert.equal(parent.validatorVersion, sourceVersion)
      assert.equal(readRecoveryFork(child)?.toolchain.validator.version, currentVersion)
      const certifiedLineage = await verifyCertifiedRecoveryLineage(parent, child)
      assert.equal(certifiedLineage?.originalJobId, parent.jobId)
      assert.equal(certifiedLineage?.originalSourceSha, parent.baseSha)
      assert.equal(certifiedLineage?.terminalJobId, child.jobId)
      assert.deepEqual(certifiedLineage?.hops.map(hop => hop.checkpointSha), [world.commitSha])
      assert.notEqual(child.threadId, parent.threadId); assert.notEqual(child.branch, parent.branch)
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal(existsSync(join(child.worktreeStoryRoot, 'characters', 'ada.md')), false,
        'failed Character bytes must not leak into the child')
      const inheritedFoundations = JSON.parse(readFileSync(join(child.stateDir, 'character-world.json'), 'utf8'))
      assert.equal(inheritedFoundations.units[0].commitSha, world.commitSha)
      assert.equal(inheritedFoundations.units[1].phase, 'pending')
      assert.equal(inheritedFoundations.units[1].beforeHead, undefined)
      assert.equal(inheritedFoundations.units[1].piSessionId, undefined)
      assert.equal(existsSync(join(child.stateDir, 'web-generation.sqlite')), false)
      assert.equal(existsSync(join(child.stateDir, 'pi-budget.json')), false)
      const bundleFile = join(child.stateDir, 'recovery-fork.json')
      const bundleBytes = readFileSync(bundleFile, 'utf8')
      try {
        const tampered = JSON.parse(bundleBytes)
        tampered.completedStages.push({ stage: 'event', milestone: 'milestone.fabricated', status: 'committed', headSha: world.commitSha })
        writeFileSync(bundleFile, JSON.stringify(tampered))
        assert.throws(() => readRecoveryFork(child), /immutable job pin/)
        await assert.rejects(() => verifyCertifiedRecoveryLineage(parent, child), /immutable job pin/)
      } finally { writeFileSync(bundleFile, bundleBytes) }
      assert.equal((await fork(input)).body.id, childId)
      assert.equal((await fork({ ...input, guidance: 'Changed after submission' })).status, 409,
        'the same child UUID cannot silently change the author message')
      assert.equal((await fork({ ...input, commitSha: initial })).status, 409)
      const inspected = await inspectRegisteredJob(store, await selectedJob(store, user.id, childId), user.id)
      assert.equal(inspected.status, 'prepared')
      assert.equal(inspected.storyThreadId, 'fork:' + childId)
      assert.deepEqual(inspected.threadMessages.map(message => message.body),
        ['Keep the witness uncertain', input.guidance], 'the child displays only inherited and new guidance history')
      const childMessages = (await store.testing.records.all<{
        role: string; status: string; body: string; originMessageId: string | null;
        verifiedCommitSha: string | null
      }>('story_thread_messages', { threadId: 'fork:' + childId }, { by: 'sequence' }))
        .map(row => ({ ...row, origin: row.originMessageId, verifiedSha: row.verifiedCommitSha }))
      assert.equal(childMessages.length, 2)
      assert.equal(childMessages[0]?.body, 'Keep the witness uncertain')
      assert.equal(childMessages[0]?.verifiedSha, initial)
      assert.ok(childMessages[0]?.origin)
      assert.equal(childMessages[1]?.status, 'queued')
      assert.equal(childMessages[1]?.body, input.guidance)
      assert.equal(childMessages[1]?.verifiedSha, null)
      assert.deepEqual(await parentMessages(), originalMessages,
        'a live parent\'s delivered, future and queued messages must remain untouched')
      assert.match((await selectedJob(store, user.id, childId)).configJson!, /Focus on the witness/)
      assert.equal(inspected.forkSource?.nextWorkItem, 'character-foundations')
      assert.deepEqual(inspected.forkSource?.dependencies['character-foundations'], ['world-foundations'])
      assert.ok(inspected.forkSource?.completedWorkItems.includes('world-foundations'))
      assert.ok(!inspected.forkSource?.completedWorkItems.includes('character-foundations'))
      // Reopen the prepared child as another process would after a restart.
      const reopened = await startStoryJob({ story: child.storyRoot, job: childId }, false)
      assert.equal(reopened.headSha, world.commitSha)
      assert.equal(readRecoveryFork(reopened)?.checkpoint.nextWorkItem, 'character-foundations')
      const browser = (method: 'GET' | 'PUT' | 'POST', body?: unknown) => new Request(config.baseURL + '/jobs/' + childId, {
        method, headers: { origin: config.baseURL, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const configuration = await generationConfigurationRequest(auth, store, browser('GET'), childId, config.baseURL)
      assert.equal(configuration.status, 200)
      const saved = (await configuration.json() as { saved: any }).saved
      assert.equal(saved.headSha, world.commitSha)
      assert.match(saved.task, /Corrective guidance for this branch:/)
      assert.match(saved.task, /Focus on the witness and avoid new Character IDs/)
      const invalid = await generationConfigurationRequest(auth, store, browser('PUT', {
        ...saved, contract: { ...saved.contract, constraints: ['Changed without plan authorization'] },
      }), childId, config.baseURL)
      assert.equal(invalid.status, 409)
      const updated = { ...saved, limits: { steps: 28 }, model: null }
      const childManifestFile = join(child.stateDir, 'job.json')
      const childManifestBytes = readFileSync(childManifestFile, 'utf8')
      try {
        writeFileSync(childManifestFile, JSON.stringify({ ...JSON.parse(childManifestBytes), validatorVersion: '9.9.9' }))
        const refused = await generationJobRequest(auth, store, browser('POST', {
          task: saved.task, contract: saved.contract,
        }), childId, config.baseURL)
        assert.equal(refused.status, 409, 'changed child tool identity blocks queue admission')
      } finally { writeFileSync(childManifestFile, childManifestBytes) }
      const update = await generationConfigurationRequest(auth, store, browser('PUT', updated), childId, config.baseURL)
      assert.equal(update.status, 200, JSON.stringify(await update.clone().json()))
      const started = await generationJobRequest(auth, store, browser('POST', {
        task: updated.task, contract: updated.contract,
      }), childId, config.baseURL)
      assert.equal(started.status, 202, JSON.stringify(await started.clone().json()))
      const childRequest = JSON.parse((await selectedJob(store, user.id, childId)).requestJson!)
      const delivered = (await store.testing.records.first<{ status: string }>('story_thread_messages', {
        ownerUserId: user.id, threadId: 'fork:' + childId, body: input.guidance,
      }))
      assert.equal(delivered?.status, 'delivered', 'queued branch guidance is delivered with the admitted run')
      // A sibling retry from the exact same World point must reject duplicate
      // Character IDs during native validation, with no fabricated commit.
      const invalidId = randomUUID()
      assert.equal((await fork({ ...input, childId: invalidId })).status, 200)
      const invalidChild = await authorizedStoryJob(store, user.id, invalidId)
      const invalidStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + invalidId, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: updated.task, contract: request.contract }),
      }), invalidId, config.baseURL)
      assert.equal(invalidStart.status, 202)
      const invalidRequest = JSON.parse((await selectedJob(store, user.id, invalidId)).requestJson!)
      const badRuntime = openWebGenerationGraph(join(invalidChild.stateDir, 'web-generation.sqlite'))
      process.env.NT_FOUNDATIONS_FIXTURE_CASE = 'duplicate-id'
      try {
        const cfg = { configurable: { thread_id: invalidChild.threadId + ':generation:web' }, recursionLimit: 1000 }
        await badRuntime.graph.updateState(cfg, { request: invalidRequest })
        const rejected = await badRuntime.graph.invoke(null, cfg)
        assert.equal(rejected.status, 'blocked', 'native validation must reject duplicate Character IDs')
      } finally {
        delete process.env.NT_FOUNDATIONS_FIXTURE_CASE
        badRuntime.saver.db.close()
      }
      assert.equal(git(invalidChild.worktreeRoot, 'rev-parse', 'HEAD'), world.commitSha)
      assert.notEqual(git(invalidChild.worktreeRoot, 'status', '--porcelain'), '')
      assert.ok(!(await inspectRecoveryCheckpoints(invalidChild)).some(p => p.workItem === 'character-foundations' && p.eligible))
      const invalidValidation = await validateStoryJob(invalidChild)
      assert.equal(invalidValidation.status, 'rejected')
      assert.match(JSON.stringify(invalidValidation.report?.diagnostics), /duplicate/i)

      const childCfg = { configurable: { thread_id: child.threadId + ':generation:web' }, recursionLimit: 1000 }
      const initialized = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
      try {
        await initialized.graph.updateState(childCfg, { request: childRequest, pauseAfter: 'foundations' })
        const pending = await initialized.graph.getState(childCfg)
        assert.equal(pending.values.request.job, childId)
      } finally { initialized.saver.db.close() }
      // The graph is reopened from its persisted initialization, not replayed as a new Thread.
      const childRuntime = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
      try {
        const result = await childRuntime.graph.invoke(null, childCfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const messages = git(child.worktreeRoot, 'log', '--format=%B', world.commitSha + '..HEAD')
        assert.match(messages, /NovelTea-Work-Item: character-foundations/)
        assert.doesNotMatch(messages, /NovelTea-Work-Item: (world-foundations|global-architecture|foundation)\n/)
      } finally { childRuntime.saver.db.close() }
      const advancedChild = await startStoryJob({ story: child.storyRoot, job: childId }, false)
      const character = (await inspectRecoveryCheckpoints(advancedChild))
        .find(point => point.eligible && point.workItem === 'character-foundations')
      assert.ok(character, 'the child publishes its own eligible character checkpoint')
      assert.equal(character.parentSha, world.commitSha)
      assert.equal(character.commitSha, advancedChild.headSha)
      const characterReceipt = JSON.parse(readFileSync(join(child.stateDir, 'character-world.json'), 'utf8'))
      assert.equal(characterReceipt.units[1].assignment.authorTask, childRequest.task,
        'the actual Character assignment must carry the edited branch instruction')
      assert.match(specialistAuthorInstruction(characterReceipt.units[1].assignment.authorTask),
        /Focus on the witness and avoid new Character IDs/)
      assert.match(specialistAuthorInstruction(characterReceipt.units[1].assignment.authorTask),
        /not additional write authority/)
      assert.ok(character.completedWorkItems.includes('character-foundations'))
      assert.equal(character.validation.validatorVersion, child.validatorVersion,
        'a resumed child specialist must use the child’s independently pinned current validator')
      assert.notEqual(character.validation.validatorVersion, world.validation.validatorVersion,
        'historical parent validator identity is preserved, not copied into child execution')
      assert.match(git(child.worktreeRoot, 'log', '-1', '--format=%B'), new RegExp('NovelTea-Job: ' + childId))
      const validated = await validateStoryJob(advancedChild)
      assert.equal(validated.status, 'passed', JSON.stringify(validated.report?.diagnostics))
      const records = (validated.report as { records?: Array<{ metadata: { id: string } }> }).records ?? []
      assert.equal(new Set(records.map(record => record.metadata.id)).size, records.length,
        'native catalog must contain exactly one record per Character/Story ID')
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      const grandId = randomUUID()
      const grandResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: grandId, commitSha: character.commitSha, sourceBaseSha: child.baseSha,
          sourceThreadId: 'fork:' + childId, proofDigest: character.proofDigest, guidance: '' }),
      }), childId, config.baseURL)
      assert.equal(grandResponse.status, 200, JSON.stringify(await grandResponse.clone().json()))
      const grand = await authorizedStoryJob(store, user.id, grandId)
      assert.equal(grand.baseSha, character.commitSha)
      assert.equal(git(grand.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal(existsSync(join(grand.stateDir, 'web-generation.sqlite')), false)
      const grandStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + grandId, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: childRequest.task, contract: childRequest.contract }),
      }), grandId, config.baseURL)
      assert.equal(grandStart.status, 202, JSON.stringify(await grandStart.clone().json()))
      const grandRequest = JSON.parse((await selectedJob(store, user.id, grandId)).requestJson!)
      const grandRuntime = openWebGenerationGraph(join(grand.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: grand.threadId + ':generation:web' }, recursionLimit: 1000 }
        await grandRuntime.graph.updateState(cfg, { request: grandRequest, pauseAfter: 'event' })
        const result = await grandRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(grand.worktreeRoot, 'log', '--format=%B', character.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: event-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (world-foundations|character-foundations)/)
      } finally { grandRuntime.saver.db.close() }
      const advancedGrand = await startStoryJob({ story: grand.storyRoot, job: grandId }, false)
      const event = (await inspectRecoveryCheckpoints(advancedGrand))
        .find(point => point.eligible && point.workItem.startsWith('event-'))
      assert.ok(event, 'the grandchild publishes an independently branchable Event checkpoint')
      const fourthId = randomUUID()
      const fourthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: fourthId, commitSha: event.commitSha, sourceBaseSha: grand.baseSha,
          sourceThreadId: 'fork:' + grandId, proofDigest: event.proofDigest, guidance: '' }),
      }), grandId, config.baseURL)
      assert.equal(fourthResponse.status, 200, JSON.stringify(await fourthResponse.clone().json()))
      const fourth = await authorizedStoryJob(store, user.id, fourthId)
      assert.equal(fourth.baseSha, event.commitSha)
      const fourthStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + fourthId, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: grandRequest.task, contract: grandRequest.contract }),
      }), fourthId, config.baseURL)
      assert.equal(fourthStart.status, 202, JSON.stringify(await fourthStart.clone().json()))
      const fourthRequest = JSON.parse((await selectedJob(store, user.id, fourthId)).requestJson!)
      const fourthRuntime = openWebGenerationGraph(join(fourth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: fourth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await fourthRuntime.graph.updateState(cfg, { request: fourthRequest, pauseAfter: 'interactive' })
        const result = await fourthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(fourth.worktreeRoot, 'log', '--format=%B', event.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: interactive-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (world-foundations|character-foundations|event-)/)
      } finally { fourthRuntime.saver.db.close() }
      const advancedFourth = await startStoryJob({ story: fourth.storyRoot, job: fourthId }, false)
      const interactivePoints = await inspectRecoveryCheckpoints(advancedFourth)
      const choice = interactivePoints.find(point => point.eligible && point.workItem.startsWith('interactive-choice-'))
      const puzzle = interactivePoints.find(point => point.eligible && point.workItem.startsWith('interactive-puzzle-'))
      assert.ok(choice, 'Choice remains branchable after Puzzle has committed')
      assert.ok(puzzle, 'Puzzle is finalized for a Composition continuation')
      const fifthId = randomUUID()
      const fifthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: fifthId, commitSha: choice.commitSha, sourceBaseSha: fourth.baseSha,
          sourceThreadId: 'fork:' + fourthId, proofDigest: choice.proofDigest, guidance: '' }),
      }), fourthId, config.baseURL)
      assert.equal(fifthResponse.status, 200, JSON.stringify(await fifthResponse.clone().json()))
      const fifth = await authorizedStoryJob(store, user.id, fifthId)
      assert.equal(fifth.baseSha, choice.commitSha)
      const fifthRuntime = openWebGenerationGraph(join(fifth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: fifth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await fifthRuntime.graph.updateState(cfg, { request: { ...fourthRequest, job: fifthId }, pauseAfter: 'interactive' })
        const result = await fifthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(fifth.worktreeRoot, 'log', '--format=%B', choice.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: interactive-puzzle-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (interactive-choice-|event-|character-foundations|world-foundations)/)
      } finally { fifthRuntime.saver.db.close() }
      const sixthId = randomUUID()
      const sixthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: sixthId, commitSha: puzzle.commitSha, sourceBaseSha: fourth.baseSha,
          sourceThreadId: 'fork:' + fourthId, proofDigest: puzzle.proofDigest, guidance: '' }),
      }), fourthId, config.baseURL)
      assert.equal(sixthResponse.status, 200, JSON.stringify(await sixthResponse.clone().json()))
      const sixth = await authorizedStoryJob(store, user.id, sixthId)
      assert.equal(sixth.baseSha, puzzle.commitSha)
      const sixthRuntime = openWebGenerationGraph(join(sixth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: sixth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await sixthRuntime.graph.updateState(cfg, { request: { ...fourthRequest, job: sixthId }, pauseAfter: 'composition' })
        const result = await sixthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(sixth.worktreeRoot, 'log', '--format=%B', puzzle.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: composition-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (interactive-|event-|character-foundations|world-foundations)/)
      } finally { sixthRuntime.saver.db.close() }
      // #82: simulate a persisted live steering acknowledgement that landed
      // after World but before Character finalized. Editing it must fork from
      // World, excluding future instructions and retaining the dirty parent.
      const steeringId = 'between-specialists'
      const steeringBody = 'Give the witness a false alibi'
      const submitted = await sendAuthorUpdate(parent, {
        id: steeringId, kind: 'idea', payload: { original: steeringBody },
      })
      mkdirSync(join(parent.stateDir, 'author-updates', 'receipts'), { recursive: true })
      writeFileSync(join(parent.stateDir, 'author-updates', 'receipts', steeringId + '.json'),
        JSON.stringify({ ...submitted, phase: 'applied', pinned: {
          jobId: parentId, threadId: parent.threadId, branch: parent.branch,
          baseSha: initial, headSha: world.commitSha,
          planVersion: null, skillSnapshot: null, piSessions: {},
        } }))
      await syncAppliedAuthorMessages(store, user.id, sourceThreadId)
      const steeringMessage = (await store.testing.records.first<{ id: string }>('story_thread_messages', {
        ownerUserId: user.id, threadId: sourceThreadId,
        originMessageId: 'author-update:' + steeringId,
      }))!
      assert.ok(steeringMessage?.id)
      const editedTask = 'The witness has a truthful alibi instead'
      const editPreview = await previewThreadMessageEdit(store, user.id, sourceThreadId,
        steeringMessage.id, editedTask)
      assert.equal(editPreview.appliedBeforeSha, world.commitSha)
      assert.equal(editPreview.checkpoint?.commitSha, world.commitSha)
      assert.equal(editPreview.checkpoint?.workItem, 'world-foundations')
      const editSourceMessages = await parentMessages()
      const editChildId = randomUUID()
      const edited = await branchEditedThreadMessage(store, user.id, {
        threadId: sourceThreadId, messageId: steeringMessage.id, edited: editedTask,
        childId: editChildId, commitSha: world.commitSha, proofDigest: world.proofDigest,
      })
      assert.equal(edited.checkpoint.commitSha, world.commitSha)
      assert.equal((await branchEditedThreadMessage(store, user.id, {
        threadId: sourceThreadId, messageId: steeringMessage.id, edited: editedTask,
        childId: editChildId, commitSha: world.commitSha, proofDigest: world.proofDigest,
      })).id, editChildId, 'a duplicate child UUID is idempotent')
      await assert.rejects(() => branchEditedThreadMessage(store, user.id, {
        threadId: sourceThreadId, messageId: steeringMessage.id, edited: 'Change the edit',
        childId: editChildId, commitSha: world.commitSha, proofDigest: world.proofDigest,
      }), /already reserved|different edit|different operation/i)
      const editedJob = await authorizedStoryJob(store, user.id, editChildId)
      assert.equal(editedJob.baseSha, world.commitSha)
      const savedEdit = (await store.testing.records.first<{ generationConfigJson: string }>(
        'studio_sessions', { id: editChildId }))!
      assert.equal(JSON.parse(savedEdit.generationConfigJson).task, editedTask)
      const editedHistory = (await store.testing.records.all<{ body: string; status: string }>(
        'story_thread_messages', { ownerUserId: user.id, threadId: 'fork:' + editChildId }, { by: 'sequence' }))
      assert.deepEqual(editedHistory.map(message => message.body),
        ['Keep the witness uncertain', editedTask])
      assert.deepEqual(editedHistory.map(message => message.status), ['delivered', 'queued'])
      // The prepared edit remains an independent runnable recovery fork. Its
      // Character stage uses the corrected task and publishes its own proof.
      const editedRuntime = openWebGenerationGraph(join(editedJob.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: editedJob.threadId + ':generation:web' }, recursionLimit: 1000 }
        await editedRuntime.graph.updateState(cfg, { request: {
          story: editedJob.storyRoot, job: editChildId, task: editedTask,
          contract: JSON.parse(savedEdit.generationConfigJson).contract, fixture: true, skillsSource: skills,
        }, pauseAfter: 'foundations' })
        const result = await editedRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
      } finally { editedRuntime.saver.db.close() }
      const verifiedEdited = await startStoryJob({ story: editedJob.storyRoot, job: editChildId }, false)
      const editedCharacter = (await inspectRecoveryCheckpoints(verifiedEdited))
        .find(point => point.eligible && point.workItem === 'character-foundations')
      assert.ok(editedCharacter, 'edited child independently verifies its continuation')
      assert.equal(editedCharacter.parentSha, world.commitSha)
      assert.deepEqual(await parentMessages(), editSourceMessages)
      assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), before.head)
      assert.equal(git(parent.worktreeRoot, 'status', '--porcelain'), before.dirty)
      assert.deepEqual(readFileSync(join(parent.stateDir, 'web-generation.sqlite')), before.database)
      assert.equal(readFileSync(join(parent.stateDir, '.story-job-running', 'owner.json'), 'utf8'), 'live parent lock evidence')
      assert.equal(readFileSync(join(parent.stateDir, 'pi-budget.json'), 'utf8'), 'parent budget evidence')

      // #82/#84 regression: a corrected *sequential follow-up* is NOT the
      // previous full/partial Story plan with already-verified stages. The
      // preceding verified HEAD supplies content only; the edited instruction
      // must receive a fresh focused execution contract and empty receipts.
      const sourceGraph = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
      try {
        await sourceGraph.graph.updateState(childCfg, { status: 'completed', reason: null }, 'completion_decision')
      } finally { sourceGraph.saver.db.close() }
      ;(await store.testing.records.update('studio_sessions', { id: childId }, { status: 'completed' }))
      ;(await store.testing.records.update('generation_run_queue', { jobId: childId }, { phase: 'finished' }))
      assert.equal((await inspectRegisteredJob(store, await selectedJob(store, user.id, childId), user.id)).status,
        'completed', 'source must have a verified, settled run before follow-up scope inference')
      const priorId = randomUUID()
      const prior = await continueCachedStory(advancedChild, priorId, character.commitSha)
      const previousInstruction = 'Make character.ada more confrontational'
      const priorRequest = { story: prior.storyRoot, job: prior.jobId, task: previousInstruction,
        contract: childRequest.contract, fixture: true, skillsSource: skills }
      ;(await store.testing.records.insert('studio_sessions', { id: priorId, ownerUserId: user.id,
        storyId: (await selectedJob(store, user.id, childId)).storyId,
        title: 'Previous follow-up', sourceCommitSha: character.commitSha, status: 'completed',
        createdAt: 'now', updatedAt: 'now', generationRequestJson: JSON.stringify(priorRequest),
        generationThreadId: prior.threadId + ':generation:web' }))
      ;(await store.testing.records.insert('story_thread_runs', { jobId: priorId,
        ownerUserId: user.id, threadId: 'fork:' + childId, runOrder: 1 }))
      const originalEditMessage = randomUUID()
      const nextSeq = Math.max(-1, ...(await store.testing.records.all<{ sequence: number }>(
        'story_thread_messages', { threadId: 'fork:' + childId })).map(row => row.sequence)) + 1
      ;(await store.testing.records.insert('story_thread_messages', { id: originalEditMessage,
        ownerUserId: user.id, threadId: 'fork:' + childId, sequence: nextSeq,
        role: 'user', status: 'delivered', body: previousInstruction,
        phase: 'finished', jobId: priorId, sourceJobId: childId, createdAt: 'now' }))
      const better = 'Make character.ada less confrontational'
      const focusedPreview = await previewThreadMessageEdit(store, user.id, 'fork:' + childId,
        originalEditMessage, better)
      assert.equal(focusedPreview.checkpoint?.commitSha, character.commitSha)
      assert.deepEqual(focusedPreview.revision?.targets, ['character.ada'])
      assert.equal(focusedPreview.revision?.reviewRequired, false)
      const focusedChildId = randomUUID()
      const focusedBranch = await branchEditedThreadMessage(store, user.id, {
        threadId: 'fork:' + childId, messageId: originalEditMessage, edited: better,
        childId: focusedChildId, commitSha: character.commitSha,
        proofDigest: character.proofDigest,
      })
      assert.equal(focusedBranch.id, focusedChildId)
      const focusedJob = await authorizedStoryJob(store, user.id, focusedChildId)
      assert.equal(focusedJob.baseSha, character.commitSha)
      assert.equal(readRecoveryFork(focusedJob), null, 'no prior plan/completed stages can be inherited')
      assert.equal(existsSync(join(focusedJob.stateDir, 'character-world.json')), false)
      assert.equal(existsSync(join(focusedJob.stateDir, 'architecture.json')), false)
      const focusedConfig = JSON.parse((await selectedJob(store, user.id, focusedChildId)).configJson!)
      assert.deepEqual(focusedConfig.contract.scope.targets, ['character.ada'])
      assert.equal(focusedConfig.contract.scope.kind, 'partial')
      assert.equal(focusedConfig.task, better)
      const forbiddenExpansion = await generationConfigurationRequest(auth, store,
        new Request(config.baseURL + '/jobs/' + focusedChildId + '/configuration', {
          method: 'PUT', headers: { origin: config.baseURL, cookie,
            'content-type': 'application/json' },
          body: JSON.stringify({ ...focusedConfig, contract: childRequest.contract }),
        }), focusedChildId, config.baseURL)
      assert.equal(forbiddenExpansion.status, 409,
        'an edited follow-up must not use pre-run settings to reauthorize the previous broad scope')
      const focusedStart = await generationJobRequest(auth, store,
        new Request(config.baseURL + '/jobs/' + focusedChildId, {
          method: 'POST', headers: { origin: config.baseURL, cookie,
            'content-type': 'application/json' },
          body: JSON.stringify({ task: better, contract: focusedConfig.contract }),
        }), focusedChildId, config.baseURL)
      assert.equal(focusedStart.status, 202, JSON.stringify(await focusedStart.clone().json()))
      const focusedRequest = JSON.parse((await selectedJob(store, user.id, focusedChildId)).requestJson!)
      const focusedRuntime = openWebGenerationGraph(join(focusedJob.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: focusedJob.threadId + ':generation:web' },
          recursionLimit: 1000 }
        await focusedRuntime.graph.updateState(cfg, { request: focusedRequest, pauseAfter: 'focus' })
        const result = await focusedRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        assert.ok(result.completedStages.some((stage: { stage: string; milestone?: string }) =>
          stage.stage === 'focus' && stage.milestone === 'character.ada'))
      } finally { focusedRuntime.saver.db.close() }
      assert.deepEqual(git(focusedJob.worktreeRoot, 'diff', '--name-only',
        character.commitSha + '..HEAD').split('\n'), ['story/characters/ada.md'],
        'only the independently authorized Character is rewritten')
      assert.equal(readRecoveryFork(focusedJob), null)
      assert.deepEqual(await parentMessages(), editSourceMessages)

      // A terminal failure recovers in the same visible Thread. The new job
      // is a separate isolated writer, but it starts using the pinned prior
      // model/budget without requiring a second Job configuration page.
      await store.testing.records.update('studio_sessions', { id: parentId }, { status: 'blocked' })
      await store.testing.records.insert('generation_run_queue', {
        jobId: parentId, ownerUserId: user.id, intent: 'start',
        phase: 'finished', createdAt: '2026-01-01', updatedAt: '2026-01-01',
      })
      const oldMessages = await store.testing.records.all<{
        id: string; status: string; phase: string | null
      }>('story_thread_messages', { threadId: sourceThreadId })
      for (const message of oldMessages) {
        if (message.status === 'queued')
          await store.testing.records.delete('story_thread_messages', { id: message.id })
        else if (['queued', 'preparing', 'running'].includes(message.phase ?? ''))
          await store.testing.records.update('story_thread_messages', { id: message.id }, { phase: 'finished' })
      }
      const continuationId = randomUUID()
      const continuationRequest = () => new Request(config.baseURL + '/continue', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, childId: continuationId,
          guidance: 'Finish character foundations before producing the dialogue.' }),
      })
      // Model/preflight refusal must leave a prepared continuation IN the
      // original Thread, with a task the inline retry can use after repair.
      process.env.NT_LIVE_GENERATION_IDEA = '1'
      let preparedResponse: Response
      try {
        preparedResponse = await checkpointContinueRequest(auth, store, continuationRequest(),
          parentId, config.baseURL)
      } finally { delete process.env.NT_LIVE_GENERATION_IDEA }
      const preparedBody = await preparedResponse.json() as {
        id?: string; started?: boolean; warning?: string
      }
      assert.equal(preparedResponse.status, 202)
      assert.equal(preparedBody.started, false)
      assert.match(preparedBody.warning ?? '', /Fixture execution refuses live/)
      const paused = await inspectRegisteredJob(store, await selectedJob(store, user.id, continuationId),
        user.id)
      assert.equal(paused.status, 'prepared')
      assert.match(paused.task ?? '', /Corrective guidance for this continuation:/)
      assert.match(paused.task ?? '', /Finish character foundations before producing the dialogue/)
      assert.ok(paused.contract, 'inline recovery can retry using the pinned contract')
      const recovered = await checkpointContinueRequest(auth, store, continuationRequest(),
        parentId, config.baseURL)
      const recoveryBody = await recovered.json() as { id?: string; started?: boolean; warning?: string }
      assert.equal(recovered.status, 202, JSON.stringify(recoveryBody))
      assert.equal(recoveryBody.id, continuationId)
      assert.equal(recoveryBody.started, true, recoveryBody.warning)
      assert.equal(await store.persistence.advancedThreads.runOrder(user.id, sourceThreadId, continuationId), 1)
      assert.equal((await store.persistence.advancedThreads.run(user.id, sourceThreadId, 'first'))?.jobId, parentId)
      assert.equal((await store.persistence.advancedThreads.run(user.id, sourceThreadId, 'last'))?.jobId, continuationId)
      assert.equal(await store.persistence.advancedThreads.identity(user.id, 'fork:' + continuationId), null)
      assert.equal((await store.persistence.generation.queue.record(continuationId))?.phase, 'queued')
      const continuation = await authorizedStoryJob(store, user.id, continuationId)
      assert.equal(continuation.baseSha, world.commitSha)
      assert.deepEqual(readRecoveryFork(continuation)?.checkpoint.completedWorkItems,
        world.completedWorkItems)
      assert.equal(git(continuation.worktreeRoot, 'status', '--porcelain'), '')
      const guidanceRecord = await store.testing.records.first<{ status: string; phase: string }>(
        'story_thread_messages', { id: 'guidance:fork:' + continuationId })
      assert.equal(guidanceRecord?.status, 'delivered')
      assert.equal(guidanceRecord?.phase, 'running')
      const dashboard = await store.persistence.dashboard.forOwner(user.id)
      assert.equal(dashboard.recentSessions.filter(session =>
        session.threadId === sourceThreadId).length, 1,
        'the dashboard must show only the latest run of a recovered Thread')
      assert.equal(dashboard.recentSessions.find(session =>
        session.threadId === sourceThreadId)?.id, continuationId)
      const retry = await checkpointContinueRequest(auth, store, continuationRequest(),
        parentId, config.baseURL)
      assert.equal(retry.status, 202)
      assert.equal((await retry.json() as { id: string }).id, continuationId)
      assert.equal(await store.persistence.advancedThreads.runOrder(user.id, sourceThreadId, continuationId), 1)

      // A toolchain refusal on the first continuation must not force a new
      // visible Thread or skip immutable checkpoint verification. A new
      // isolated execution from the original source can follow after review.
      await store.testing.records.update('studio_sessions',
        { id: continuationId }, { status: 'blocked' })
      await store.testing.records.update('generation_run_queue',
        { jobId: continuationId }, { phase: 'finished' })
      await store.testing.records.update('story_thread_messages',
        { id: 'guidance:fork:' + continuationId }, { phase: 'blocked' })
      const repairedId = randomUUID()
      const repairInput = { ...input, childId: repairedId, expectedLatestJobId: continuationId,
        guidance: 'Finish character foundations before producing the dialogue.' }
      const repairRequest = (data: unknown) => new Request(config.baseURL + '/continue', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(data),
      })
      const staleRepair = await checkpointContinueRequest(auth, store,
        repairRequest({ ...repairInput, expectedLatestJobId: randomUUID() }),
        parentId, config.baseURL)
      assert.equal(staleRepair.status, 409)
      assert.equal(await store.persistence.advancedThreads.jobClaimed(repairedId), false)
      const repaired = await checkpointContinueRequest(auth, store,
        repairRequest(repairInput), parentId, config.baseURL)
      const repairedBody = await repaired.json() as { started?: boolean; warning?: string }
      assert.equal(repaired.status, 202, JSON.stringify(repairedBody))
      assert.equal(repairedBody.started, true, repairedBody.warning)
      assert.equal(await store.persistence.advancedThreads.runOrder(user.id, sourceThreadId, repairedId), 2)
      assert.equal(await store.persistence.advancedThreads.identity(user.id, 'fork:' + repairedId), null)
      const replacement = await authorizedStoryJob(store, user.id, repairedId)
      assert.equal(replacement.baseSha, world.commitSha)
      assert.deepEqual(readRecoveryFork(replacement)?.checkpoint.completedWorkItems,
        world.completedWorkItems)
      assert.equal((await store.persistence.dashboard.forOwner(user.id)).recentSessions
        .filter(item => item.threadId === sourceThreadId).length, 1)
      assert.equal((await store.persistence.generation.queue.record(repairedId))?.phase, 'queued')
      const duplicateGuidance = await store.testing.records.first(
        'story_thread_messages', { id: 'guidance:fork:' + repairedId })
      assert.equal(duplicateGuidance, undefined,
        'retrying unchanged guidance must not create a second copy of the author message')
      const originalGuidance = await store.testing.records.first<{ body: string }>(
        'story_thread_messages', { id: 'guidance:fork:' + continuationId })
      assert.equal(originalGuidance?.body, repairInput.guidance,
        'retry must preserve the author instruction already present in chat')
      const repairedChat = await readThreadChat(store, user.id, sourceThreadId)
      assert.ok(!repairedChat.messages.some(message => message.id === 'initial:' + repairedId),
        'same-Thread retry must not synthesize a long task as a second user message')

      // Existing deployments may already have synthesized a duplicate before
      // the fix. Keep the receipt for audit, but exclude it from chat.
      await store.testing.records.insert('story_thread_messages', {
        id: 'initial:' + repairedId, ownerUserId: user.id,
        threadId: sourceThreadId,
        sequence: Math.max(...repairedChat.messages.map(item => item.sequence)) + 1,
        role: 'user', status: 'delivered', phase: 'finished',
        body: 'Original request\n\nCorrective guidance for this continuation:\nRepeated text',
        jobId: repairedId, createdAt: '2026-01-01',
      })
      const afterReopen = await readThreadChat(store, user.id, sourceThreadId)
      assert.deepEqual(afterReopen.messages.map(item => item.id),
        repairedChat.messages.map(item => item.id),
        'a historical synthetic task must stay hidden without deleting the receipt')
      assert.deepEqual(afterReopen.turnReceipts, repairedChat.turnReceipts,
        'a hidden synthetic recovery task must not become a second author Turn receipt')
      assert.ok(await store.testing.records.first('story_thread_messages',
        { id: 'initial:' + repairedId }), 'historical receipt remains stored')

      // The source run's checkpoint predates later same-Thread executions.
      // Even a later message tagged with that same validated input SHA must
      // not enter a new fork of the older source run.
      await store.testing.records.insert('story_thread_messages', {
        id: randomUUID(), ownerUserId: user.id, threadId: sourceThreadId,
        sequence: Math.max(...afterReopen.messages.map(item => item.sequence)) + 2,
        role: 'user', status: 'delivered', phase: 'finished',
        body: 'Later Turn intent must not enter an older checkpoint',
        jobId: repairedId, verifiedCommitSha: world.commitSha, createdAt: '2026-01-02',
      })
      const laterForkId = randomUUID()
      const forkedOld = await fork({ ...input, childId: laterForkId })
      assert.equal(forkedOld.status, 200, JSON.stringify(forkedOld.body))
      const olderFork = await readThreadChat(store, user.id, 'fork:' + laterForkId)
      assert.ok(!olderFork.messages.some(item =>
        item.content === 'Later Turn intent must not enter an older checkpoint'),
      'the HTTP fork must restrict source messages to its source execution run order')
    } finally {
      store.close()
      for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]
      removeTestTree(root)
    }
  })

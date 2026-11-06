import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { approvalRequest } from '../src/lib/approval.server'
import { fixtureJobRequest } from '../src/lib/fixture-jobs.server'
import { availableUserPiModels, userPiCredentials } from '../src/lib/pi-credentials.server'
import { authorInteractionRequest } from '../src/lib/author-interactions.server'
import { startAgentServer } from '../src/agent-service'
import { runAuthorAction } from '../../src/author-updates'
import { runArchitectureJob } from '../../src/architecture'
import { verifyAuthorEvidence } from '../../src/author-evidence'

const config = { baseURL: 'http://localhost:3000', secret: 'approval-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'github', clientSecret: 'secret' }, gitlab: { clientId: 'gitlab', clientSecret: 'secret' } }

test('authenticated owner records an exact durable decision; foreign users, inline claims and nonce replay cannot approve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-approval-'))
  const previous = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR,
    key: process.env.NT_PI_CREDENTIAL_KEY, strict: process.env.NT_REQUIRE_USER_PI_RUNTIME,
    socket: process.env.NT_SANDBOX_SOCKET, token: process.env.NT_SANDBOX_TOKEN_FILE,
    rpcUrl: process.env.NT_AGENT_RPC_URL, rpcToken: process.env.NT_AGENT_RPC_TOKEN }
  let agent: Awaited<ReturnType<typeof startAgentServer>> | undefined
  delete process.env.NT_AGENT_RPC_URL
  delete process.env.NT_AGENT_RPC_TOKEN
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@test.example', emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@test.example', emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const s = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + s.token + '.' + createHmac('sha256', config.secret).update(s.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id), bobCookie = await cookie(bob.id)
    const repo = join(root, 'source'); mkdirSync(join(repo, 'story'), { recursive: true })
    writeFileSync(join(repo, 'story/README.md'), 'Approval fixture\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q'); git('config', 'user.name', 'Author'); git('config', 'user.email', 'author@test.example')
    git('add', '.'); git('commit', '-qm', 'baseline')
    const commit = git('rev-parse', 'HEAD'), jobId = randomUUID(), storyId = randomUUID(), repositoryId = randomUUID()
    const job = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story', commit, jobId })
    await store.persistence.repositories.upsert(alice.id, 'github', '123',
      'Author/Story', null, repositoryId, '2026-10-31')
    await store.persistence.onboarding.importStory({
      id: storyId, owner: alice.id, repositoryId, directory: 'story', title: 'Story',
      createdAt: '2026-10-31', commitSha: commit,
    })
    await store.persistence.generation.jobs.register(alice.id, jobId, storyId,
      'Job', commit, '2026-10-31')
    const firstContract = { scope: { kind: 'partial', depth: 'architecture', targets: [], branches: [] },
      constraints: ['Preserve the original mystery'],
      envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    const contract = { ...firstContract, constraints: [...firstContract.constraints, 'Reveal the witness'] }
    // Real model selection must not admit a host Pi fallback, missing rootless
    // controller or unauthorized credentials before recording server ownership.
    process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
    process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'
    delete process.env.NT_SANDBOX_SOCKET
    delete process.env.NT_SANDBOX_TOKEN_FILE
    await userPiCredentials(store, alice.id).modify('openai', async () =>
      ({ type: 'api_key', key: 'ISOLATED-TEST-KEY-NOT-FOR-NETWORK' }))
    const models = await availableUserPiModels(store, alice.id)
    assert.ok(models.length > 0)
    const realContract = { scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
      constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    const requestBody = { task: 'Generate a mystery', contract: realContract }
    await store.persistence.generation.jobs.saveConfiguration(alice.id, jobId,
      JSON.stringify({ version: 1, headSha: commit, ...requestBody, limits: { modelCalls: 1 },
        model: { provider: models[0]!.provider, id: models[0]!.id } }), new Date().toISOString())
    const realStart = await fixtureJobRequest(auth, store, new Request(config.baseURL + '/api/jobs/' + jobId, {
      method: 'POST', headers: { origin: config.baseURL, cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }), jobId, config.baseURL)
    assert.equal(realStart.status, 503, await realStart.clone().text())
    assert.equal((await store.persistence.generation.jobs.state(alice.id, jobId))?.requestJson, null)
    assert.equal(existsSync(join(job.stateDir, 'generation-server-owner.json')), false)
    assert.equal(existsSync(join(job.stateDir, 'pi-policy.json')), false,
      'failed sandbox admission must not lock a draft to an unstarted model')
    assert.equal(existsSync(join(job.stateDir, 'pi-resolution.json')), false)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { generationConfigJson: null }))
    const plan = { version: 1, contract: firstContract, items: [] }
    const digest = createHash('sha256').update(JSON.stringify({ plan, head: commit, contract })).digest('hex')
    writeFileSync(join(job.stateDir, 'architecture.json'), JSON.stringify({ format: 1,
      jobId, threadId: job.threadId, branch: job.branch, worktreeRoot: job.worktreeRoot,
      baseSha: commit, expectedHead: commit, phase: 'ready', mode: 'autonomous',
      worker: 'fixture', provider: 'openai', model: 'gpt-6-luna', history: [], plan,
      proposal: { version: 2, digest, baselineHead: commit, contract } }))
    const post = (body: unknown, session = aliceCookie, origin = config.baseURL) => approvalRequest(auth, store,
      new Request(config.baseURL + '/api/approvals', { method: 'POST', headers: {
        origin, cookie: session, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config.baseURL)
    const request = { action: 'request', jobId, id: 'plan-one', kind: 'plan' }
    assert.equal((await post(request, '')).status, 401)
    assert.equal((await post(request, bobCookie)).status, 404)
    assert.equal((await post(request, aliceCookie, 'https://evil.example')).status, 403)
    const staged = await post(request); assert.equal(staged.status, 200, await staged.clone().text())
    const pending = await staged.json()
    assert.equal(pending.phase, 'awaiting-controller')
    const decide = { action: 'decide', jobId, id: pending.id, nonce: pending.nonce, proposalSha256: digest, decision: 'approved' }
    assert.equal((await post({ ...decide, principal: 'user:' + alice.id })).status, 400)
    assert.equal((await post(decide, bobCookie)).status, 404)
    assert.equal((await post({ ...decide, nonce: randomUUID() })).status, 409)
    const approved = await post(decide); assert.equal(approved.status, 200, await approved.clone().text())
    const saved = await approved.json()
    assert.equal(saved.principal, 'user:' + alice.id)
    assert.equal(saved.source, 'trusted-web')
    assert.deepEqual(await (await post(decide)).json(), saved)
    assert.equal((await post({ ...decide, decision: 'rejected' })).status, 409)
    assert.equal(verifyAuthorEvidence(job, { receiptId: pending.id, nonce: pending.nonce }).payload.proposalSha256, digest)
    assert.equal(git('rev-parse', 'HEAD'), commit)

    const token = randomBytes(48).toString('hex')
    agent = await startAgentServer(store, token, 0, '127.0.0.1')
    process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:' + agent.port
    process.env.NT_AGENT_RPC_TOKEN = token
    assert.equal((await fetch(process.env.NT_AGENT_RPC_URL + '/v1/author', {
      method: 'POST', body: '{}',
    })).status, 401, 'agent RPC must reject unauthenticated commands')
    const author = (body: unknown, session = aliceCookie, origin = config.baseURL) =>
      authorInteractionRequest(auth, store, new Request(config.baseURL + '/api/jobs/' + jobId + '/author', {
        method: 'POST', headers: { origin, cookie: session, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), jobId, config.baseURL)
    const inspectAuthor = (session = aliceCookie) => authorInteractionRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/author', {
        method: 'GET', headers: { cookie: session },
      }), jobId, config.baseURL)
    const sendMessage = async (message: unknown) => {
      const file = join(root, 'author-' + randomUUID() + '.json')
      writeFileSync(file, JSON.stringify(message))
      return runAuthorAction({ story: job.storyRoot, job: jobId, action: 'send', file })
    }
    const processUpdates = () => runAuthorAction({ story: job.storyRoot, job: jobId, action: 'process' })
    await sendMessage({ id: 'question-review', kind: 'question', payload: { question: 'Who sees the reveal?' } })
    assert.equal((await processUpdates() as any).status, 'blocked')
    assert.equal((await inspectAuthor('')).status, 401)
    assert.equal((await inspectAuthor(bobCookie)).status, 404)
    assert.equal((await author({ action: 'answer', messageId: 'question-review', answer: 'Only the author' },
      aliceCookie, 'https://evil.test')).status, 403)
    assert.equal((await author({ action: 'answer', messageId: 'question-review', answer: 'Only the author',
      principal: 'user:' + alice.id })).status, 400)
    assert.equal((await author({ action: 'answer', messageId: 'question-review',
      answer: 'x'.repeat(9000) })).status, 413, 'oversized payload is refused before buffering')
    assert.equal((await author({ action: 'answer', messageId: 'question-review', answer: 'Only the author' },
      bobCookie)).status, 404)
    const answer = { action: 'answer', messageId: 'question-review', answer: 'Only the author' }
    const answered = await author(answer)
    assert.equal(answered.status, 200, await answered.clone().text())
    const applied = (await answered.json() as any).acknowledgement
    assert.equal(applied.phase, 'applied')
    assert.equal(applied.webController.principal, 'user:' + alice.id)
    assert.equal(applied.webController.headSha, commit)
    assert.equal((await author(answer)).status, 200, 'exact replay is idempotent')
    assert.equal((await author({ ...answer, answer: 'Someone else' })).status, 409)
    const authorView = await (await inspectAuthor()).json() as any
    assert.equal(authorView.items[0].answer, 'Only the author')

    await sendMessage({ id: 'plan-message', kind: 'approval', payload: {
      requestType: 'plan', proposalSha256: digest,
    } })
    assert.equal((await processUpdates() as any).status, 'blocked')
    const stagedWeb = await author({ action: 'prepare', messageId: 'plan-message' })
    assert.equal(stagedWeb.status, 200, await stagedWeb.clone().text())
    const exact = (await stagedWeb.json() as any).approval
    assert.equal(exact.phase, 'awaiting-controller')
    assert.equal(exact.proposalSha256, digest)
    assert.equal(exact.verifiedHead, commit)
    assert.deepEqual(exact.review.proposed.contract, contract)
    const decision = { action: 'decide', messageId: 'plan-message', receiptId: exact.id,
      nonce: exact.nonce, proposalSha256: digest, decision: 'approved' }
    assert.equal((await author({ ...decision, receiptId: 'plan-one' })).status, 409)
    assert.equal((await author(decision, bobCookie)).status, 404)
    assert.equal((await author({ ...decision, nonce: randomUUID() })).status, 409)
    const accepted = await author(decision)
    assert.equal(accepted.status, 200, await accepted.clone().text())
    const resolved = await accepted.json() as any
    assert.equal(resolved.approval.principal, 'user:' + alice.id)
    assert.equal(resolved.acknowledgement.phase, 'applied')
    assert.equal(resolved.acknowledgement.webController.principal, 'user:' + alice.id)
    assert.equal((await author(decision)).status, 200, 'exact accepted approval replay is idempotent')
    assert.equal((await author({ ...decision, decision: 'rejected' })).status, 409)
    const inspected = await (await inspectAuthor()).json() as any
    assert.equal(inspected.items[1].approval.decision, 'approved')
    assert.equal(inspected.items[1].phase, 'applied')
    const architectureFile = join(job.stateDir, 'architecture.json')
    const approvedPlan = JSON.parse(readFileSync(architectureFile, 'utf8'))
    assert.equal(approvedPlan.plan.version, 2)
    assert.equal(approvedPlan.history[0].signed.receiptId, exact.id)
    assert.equal(git('rev-parse', 'HEAD'), commit)

    const revised = { ...contract, constraints: [...contract.constraints, 'A second proposed path'] }
    const proposal = await runArchitectureJob({ story: job.storyRoot, job: jobId,
      action: 'propose', contract: revised })
    await sendMessage({ id: 'plan-denial', kind: 'approval', payload: {
      requestType: 'plan', proposalSha256: proposal.proposal!.digest,
    } })
    assert.equal((await processUpdates() as any).status, 'blocked')
    const pendingDenial = await (await author({ action: 'prepare', messageId: 'plan-denial' })).json() as any
    const denial = { action: 'decide', messageId: 'plan-denial', receiptId: pendingDenial.approval.id,
      nonce: pendingDenial.approval.nonce, proposalSha256: proposal.proposal!.digest, decision: 'rejected' }
    const savedBeforeTampering = readFileSync(architectureFile, 'utf8')
    const tampered = JSON.parse(savedBeforeTampering)
    tampered.proposal.digest = 'f'.repeat(64)
    writeFileSync(architectureFile, JSON.stringify(tampered))
    assert.equal((await author(denial)).status, 409, 'stale proposal cannot consume consent')
    writeFileSync(architectureFile, savedBeforeTampering)
    const rejected = await author(denial)
    assert.equal(rejected.status, 200, await rejected.clone().text())
    assert.equal((await rejected.json() as any).approval.decision, 'rejected')
    assert.equal((await author(denial)).status, 200, 'exact denial replay is idempotent')
    assert.equal((await author({ ...denial, decision: 'approved' })).status, 409)
    const pendingView = await (await inspectAuthor()).json() as any
    assert.equal(pendingView.items[2].phase, 'awaiting-author', 'denial does not resume the protected writer')
    assert.equal(pendingView.items[2].approval.decision, 'rejected')
    assert.equal(JSON.parse(readFileSync(architectureFile, 'utf8')).plan.version, 2)
    // New author messages are admitted through the agent without processing
    // an in-progress writer or changing the canonical Git revision.
    const sent = await author({ action: 'send', message: { id: 'change-after-review',
      kind: 'change', payload: { text: 'Revisit the second witness', affectedIds: ['arc.truth'] },
    } })
    assert.equal(sent.status, 202, await sent.clone().text())
    assert.equal((await sent.json() as any).acknowledgement.phase, 'queued')
    assert.equal(git('rev-parse', 'HEAD'), commit)
    assert.equal((await author({ action: 'send', message: { kind: 'change', payload: { text: '' } } })).status,
      409, 'invalid author message cannot enter the durable inbox')
    const unicode = 'A hidden witness speaks: 証言と秘密'
    const bytes = Buffer.from(JSON.stringify({ ownerId: alice.id, jobId, command: {
      action: 'send', message: { id: 'unicode-author-update', kind: 'change',
        payload: { text: unicode, affectedIds: ['arc.truth'] } },
    } }))
    const fragment = Buffer.from('証')
    const split = bytes.indexOf(fragment) + 1
    assert.ok(split > 1, 'expected a multibyte character')
    const unicodeStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(process.env.NT_AGENT_RPC_URL! + '/v1/author', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)) })
      req.on('error', reject)
      req.write(bytes.subarray(0, split))
      setTimeout(() => req.end(bytes.subarray(split)), 10)
    })
    assert.equal(unicodeStatus, 202)
    const inbox = await runAuthorAction({ story: job.storyRoot, job: jobId, action: 'inspect' }) as any
    assert.equal(inbox.records.find((record: any) => record.message.id === 'unicode-author-update')?.message.payload.text,
      unicode, 'split UTF-8 must preserve the exact author message')
  } finally {
    if (agent) await agent.close()
    store.close()
    for (const [key, value] of [['NT_STATE_DIR', previous.state], ['NT_GIT_CACHE_DIR', previous.cache],
      ['NT_PI_CREDENTIAL_KEY', previous.key], ['NT_REQUIRE_USER_PI_RUNTIME', previous.strict],
      ['NT_SANDBOX_SOCKET', previous.socket], ['NT_SANDBOX_TOKEN_FILE', previous.token],
      ['NT_AGENT_RPC_URL', previous.rpcUrl], ['NT_AGENT_RPC_TOKEN', previous.rpcToken]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

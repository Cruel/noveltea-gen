import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { submitFirstStoryTurn } from '../../src/lib/story-first-chat.server'
import { storyChatDiscoveryRequest } from '../../src/lib/story-chat-discovery.server'
import { onboardingPiRequest, type ChatDiscoveryBinding } from '../../src/lib/onboarding-pi.server'
import { authorInteractionRequest } from '../../src/lib/author-interactions.server'
import { generationControlRequest } from '../../src/lib/generation-controls.server'
import { listGenerationEvents } from '../../src/lib/generation-progress.server'
import { queueRecord } from '../../src/lib/generation-queue.server'
import type { StudioAuth } from '../../src/lib/auth'
import type { TestStudioDatabase } from './studio-database'
import type { JobStartResult } from '../../../src/job'
import { validateStoryJob } from '../../../src/validator'
import { inspectRecoveryCheckpoints, type RecoveryInspection } from '../../../src/recovery-checkpoints'
import { readRecoveryFork } from '../../../src/recovery-fork-state'
import { readReviewTurnEvidence } from '../../../src/fork-review-turn'
import { readAdaptiveState } from '../../../src/adaptive-state'
import { inspectJobReport } from '../../../src/job-report'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'
import { readChatApprovedFoundation } from '../../../src/chat-approved-foundation'
import { fullStoryTimeouts } from '../../../scripts/live-new-story-timeout.mjs'

type Mode = 'autonomous' | 'collaborative'
type Discovery = {
  phase: string
  revision: number
  digest?: string
  questions?: string
  chat?: { sourceSha: string; originalObjective: string }
}
type ChatCase = {
  auth: StudioAuth
  store: TestStudioDatabase
  headers: Headers
  baseURL: string
  ownerId: string
  storyId: string
  jobId: string
  repositoryId: string
  sourceSha: string
  mode: Mode
}
const prompt = 'Make me a mystery game'
const adaptiveShape = process.env.NT_TEST_WEB_PI_ADAPTIVE_SHAPE
const adaptiveBrief = adaptiveShape === 'narrative-led'
  ? 'Make this a compact, dialogue-led mystery with observational exploration, credible clues, and at least one consequential choice. Some Milestones should be Event-only: do not invent a formal Puzzle or force a Choice at every Milestone. The ending must honor the original mystery promise and the effects of the actual player decisions. I delegate all unprotected creative details; propose the complete playable baseline.'
  : adaptiveShape === 'choice-heavy'
    ? 'Make a compact, Choice-heavy mystery with several justified player decisions distributed nonuniformly across Milestones, including a decision-rich confrontation and an observation-only Event. The Architecture Arc trajectory must explicitly name each major player decision, its causal prerequisites, and how knowledge or relationships remain different after routes reconverge. Include independent causal support for extra Events, and only a genuinely warranted formal Puzzle. Avoid uniform Milestone quotas. I delegate unprotected creative details; propose a complete playable baseline with these constraints.'
    : null

/** The only #158-specific preparation. Reuses normal Studio's real Chat and
 * discovery handlers; the common live runner owns auth, Docker and agent. */
export async function beginLiveNewStoryChat(args: ChatCase) {
  const { auth, store, headers, baseURL, storyId, jobId, mode, sourceSha } = args
  const first = await submitFirstStoryTurn(auth, store, headers, baseURL, {
    storyId,
    jobId,
    prompt,
    creativeMode: mode,
  })
  assert.equal(first.state, 'discovery', JSON.stringify(first))
  assert.equal(first.threadId, 'root:' + jobId)
  const request = async (method: 'GET' | 'POST', body?: unknown) => {
    const response = await storyChatDiscoveryRequest(
      auth,
      store,
      new Request(baseURL + '/api/story-chat-discovery', {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
      baseURL,
      storyId,
      jobId,
    )
    const parsed = (await response.json()) as { session?: Discovery; error?: string }
    assert.ok(response.ok, JSON.stringify({ status: response.status, error: parsed.error }))
    assert.ok(parsed.session)
    return parsed.session
  }
  let discovery = await request('GET')
  assert.equal(discovery.phase, 'questions', 'Sparse Story prompt must ask for author baseline preferences')
  assert.match(discovery.questions ?? '', /recommend|suggest/i)
  for (let i = 0; i < 4 && discovery.phase === 'questions'; i++) {
    const answer =
      i === 0
        ? adaptiveBrief ?? 'A compact atmospheric mystery on a stranded overnight train. Include fair-play clues, an enacted player choice and meaningfully different endings. I delegate unprotected creative details; propose the baseline.'
        : adaptiveBrief
          ? 'I delegate the remaining unprotected decisions while retaining the requested Story-wide Interaction profile and causal consequences. Propose the complete playable mystery baseline.'
          : 'I delegate the rest of the unprotected choices. Propose the complete playable mystery baseline.'
    discovery = await request('POST', { action: 'answer', revision: discovery.revision, text: answer })
  }
  assert.equal(discovery.phase, 'proposed')
  assert.ok(discovery.digest)
  assert.equal(discovery.chat?.sourceSha, sourceSha)
  assert.equal(discovery.chat?.originalObjective, prompt)
  // A browser disconnect/reconnect reloads this exact proposed author Turn.
  // GET must not trigger a second Pi interview, revision or foundation digest.
  const reconnected = await request('GET')
  assert.equal(reconnected.phase, discovery.phase)
  assert.equal(reconnected.revision, discovery.revision)
  assert.equal(reconnected.digest, discovery.digest)
  assert.deepEqual(reconnected.chat, discovery.chat)
  return discovery
}

/** The source Git repo is real; only remote provider acquisition is replaced
 * with the already verified local worktree. All Studio validation, planning,
 * source pinning, worker execution, and actual Pi remain real. */
export async function approveLiveNewStoryChat(args: ChatCase, proposed: Discovery, job: JobStartResult) {
  const { auth, store, headers, baseURL, storyId, jobId, sourceSha, repositoryId, mode } = args
  const binding: ChatDiscoveryBinding = {
    storyId,
    firstTurnId: jobId,
    repositoryId,
    directory: 'story',
    sourceSha,
    originalObjective: prompt,
  }
  const response = await onboardingPiRequest(
    auth,
    store,
    new Request(baseURL + '/api/story-chat-discovery', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'approve', revision: proposed.revision, digest: proposed.digest }),
    }),
    baseURL,
    undefined,
    binding,
    {
      github: async (_auth, _store, request) => {
        const value = (await request.json()) as { storyId: string; jobId: string; commit: string }
        assert.deepEqual(value, { storyId, jobId, commit: sourceSha })
        return Response.json({ job: { headSha: sourceSha } })
      },
    },
  )
  const parsed = (await response.json()) as {
    session?: Discovery
    continuation?: { state: string; message?: string }
  }
  assert.ok(response.ok, JSON.stringify({ status: response.status, parsed }))
  assert.equal(parsed.session?.phase, 'approved')
  assert.equal(
    parsed.continuation?.state,
    'queued',
    'Exact approval must automatically continue the original Turn: ' + JSON.stringify(parsed.continuation),
  )
  const receipt = await readChatApprovedFoundation(job)
  assert.equal(receipt?.scope, 'whole-story')
  assert.equal(receipt?.proposalDigest, proposed.digest)
  assert.equal(receipt?.creativeMode, mode)
  console.log('Live ' + mode + ' Chat: exact approval continued the original Turn')
}

/** Full-Story variant of the existing real-Pi integration runner. No new
 * controller, agent, auth provider, Docker service or harness is constructed. */
export async function verifyLiveNewStory(
  args: ChatCase & {
    job: JobStartResult
    root: string
    skills: string
    model: string
  },
) {
  const { auth, store, headers, baseURL, ownerId, jobId, mode, job, sourceSha, root, skills } = args
  const deadline = Date.now() + fullStoryTimeouts(process.env.NT_TEST_WEB_PI_TIMEOUT_MINUTES).monitorMs
  let terminal = '',
    finishedCount = 0,
    authorChoices = 0,
    priorStage = ''
  while (Date.now() < deadline) {
    const events = await listGenerationEvents(store, ownerId, jobId, 0)
    const working = events.filter((event) => event.kind === 'working').at(-1)
    if (working?.stage && working.stage !== priorStage) {
      priorStage = working.stage
      console.log('Live ' + mode + ' stage: ' + priorStage)
    }
    if (events.some((event) => event.kind === 'interrupted')) {
      terminal = 'interrupted'
      break
    }
    const finished = events.filter((event) => event.kind === 'finished')
    if (finished.length > finishedCount) {
      finishedCount = finished.length
      terminal = finished.at(-1)?.status ?? 'unknown'
      if (['completed', 'blocked', 'cancelled'].includes(terminal)) break
      if (terminal === 'paused') {
        const response = await authorInteractionRequest(
          auth,
          store,
          new Request(baseURL + '/api/jobs/' + jobId + '/author', { headers }),
          jobId,
          baseURL,
        )
        const parsed = (await response.json()) as {
          choice?: {
            id: string
            proposalSha256: string
            phase: string
            question: { question: string }
          }
        }
        if (!response.ok || parsed.choice?.phase !== 'awaiting-author') break
        authorChoices++
        assert.ok(authorChoices <= 8, 'Excessive author choices require separate inspection')
        const choice = parsed.choice
        const answer = await authorInteractionRequest(
          auth,
          store,
          new Request(baseURL + '/api/jobs/' + jobId + '/author', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              action: 'choice',
              id: choice.id,
              proposalSha256: choice.proposalSha256,
              draftRevision: 1, kind: 'custom',
              text: 'Use the recommended dramatic approach while preserving fair clues, choices, and distinct consequences. I delegate wording, not protected canon.',
            }),
          }),
          jobId,
          baseURL,
        )
        assert.equal(answer.status, 200, await answer.clone().text())
        const resume = await generationControlRequest(
          auth,
          store,
          new Request(baseURL + '/api/jobs/' + jobId + '/control', {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'resume' }),
          }),
          jobId,
          baseURL,
        )
        assert.equal(resume.status, 202, await resume.clone().text())
        terminal = ''
      }
    }
    await new Promise((done) => setTimeout(done, 1500))
  }
  const git = (cwd: string, ...argv: string[]) =>
    execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const finalHead = git(job.worktreeRoot, 'rev-parse', 'HEAD')
  const changed = git(job.worktreeRoot, 'diff', '--name-only', sourceSha, finalHead)
    .split('\n')
    .filter(Boolean)
  let validationStatus = 'not-checked'
  let validationError: string | null = null
  try {
    validationStatus = (await validateStoryJob(job, skills, { ...job, baseSha: sourceSha })).status
  } catch (error) {
    validationStatus = 'error'
    validationError = error instanceof Error ? error.message : 'Native validation could not be read'
  }
  const events = await listGenerationEvents(store, ownerId, jobId, 0)
  const queuePhase = (await queueRecord(store, jobId))?.phase
  // Each attempt owns immutable evidence. Source worktrees, original Pi sessions
  // and receipts remain at their original absolute paths; no moving or replay.
  const attempts = join(root, 'attempts', jobId)
  mkdirSync(attempts, { recursive: true, mode: 0o700 })
  let checkpointState: unknown = null
  const graphFile = join(job.stateDir, 'web-generation.sqlite')
  if (existsSync(graphFile) && queuePhase !== 'running') {
    try {
      const runtime = openWebGenerationGraph(graphFile)
      try {
        const execution = await store.persistence.generation.jobs.state(ownerId, jobId)
        if (execution?.threadId) {
          const saved = await runtime.graph.getState({ configurable: { thread_id: execution.threadId } })
          const state = saved.values as { status?: string; reason?: string; active?: unknown;
            failures?: unknown; inventory?: { items?: unknown[] } }
          checkpointState = { status: state.status, reason: state.reason,
            active: state.active, failures: state.failures,
            inventory: state.inventory?.items, pendingNodes: saved.next }
        }
      } finally { runtime.saver.db.close() }
    } catch (error) {
      checkpointState = { inspectionError: error instanceof Error ? error.message : 'Graph checkpoint unreadable' }
    }
  }
  let recoveryPoints: RecoveryInspection[] = []
  let recoveryError: string | null = null
  try { recoveryPoints = await inspectRecoveryCheckpoints(job) }
  catch (error) { recoveryError = error instanceof Error ? error.message : 'Recovery checkpoints unreadable' }
  let fork: ReturnType<typeof readRecoveryFork> = null
  try { fork = readRecoveryFork(job) }
  catch (error) { recoveryError = error instanceof Error ? error.message : 'Recovery bundle unreadable' }
  // This is an opt-in production graph certification, NOT the fixture admission
  // tests. Authenticate the original Turn, current Architecture, private Pi
  // planning ledger and separate final independent review before counting any
  // authored Story as certified. Keep model transcripts in their original
  // private paths and summarize only receipt identities here.
  const recoveryOnly = Boolean(process.env.NT_TEST_WEB_PI_RETRY_ROOT)
  let adaptiveEvidence: { version: number; digest: string; amendments: Array<{
    digest: string; actions: string[]; omissions: number }> } | null = null
  let adaptiveFailure: string | null = null
  let finalGoal: { status: string; assurance: string } | null = null
  if (adaptiveShape) {
    try {
      const turn = await readReviewTurnEvidence(job)
      assert.ok(turn, 'The independent review must retain the authenticated original Author Turn')
      assert.equal(turn.originalRequest, prompt)
      const architecture = JSON.parse(readFileSync(join(job.stateDir, 'architecture.json'), 'utf8')) as {
        plan: { version: number } }
      const adaptive = await readAdaptiveState(job, turn.digest, architecture.plan.version)
      if (adaptive) adaptiveEvidence = { version: adaptive.version, digest: adaptive.digest,
        amendments: adaptive.entries.map(entry => ({ digest: entry.digest,
          actions: entry.actions.map(action => action.kind), omissions: entry.omissions.length })) }
      const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId })
      finalGoal = { status: report.generation.planFulfillment.status,
        assurance: report.generation.planFulfillment.assurance }
    } catch (error) {
      adaptiveFailure = error instanceof Error ? error.message : 'Adaptive source identity could not be authenticated'
    }
  }
  // Store a content-addressed inventory of exact saved controller receipts.
  // No Pi transcripts or credential-bearing files are duplicated into this index.
  const receiptPaths = ['foundation.json', 'architecture.json', 'character-world.json',
    'turn-plan.json', 'objective-planning.json', 'orchestrator-selection.json',
    'adaptive-plan.json']
  for (const folder of ['event-items', 'interactive-items', 'composition-items',
    'review-repairs', 'review-repairs/proofs', 'assignment-reviews', 'review-items']) {
    const dir = join(job.stateDir, folder)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) receiptPaths.push(folder + '/' + entry.name)
    }
  }
  assert.ok(receiptPaths.length <= 512, 'Certification receipt inventory exceeds its safety limit')
  const receipts = receiptPaths.filter(path => existsSync(join(job.stateDir, path)))
    .map(path => ({ path, sha256: createHash('sha256')
      .update(readFileSync(join(job.stateDir, path))).digest('hex') }))
  const evidence = {
    mode,
    provider: args.model,
    jobId,
    sourceSha,
    finalHead,
    terminal,
    queuePhase,
    changed,
    nativeValidation: validationStatus,
    validationError,
    recoveryError,
    authorChoices,
    ...(adaptiveShape ? { adaptiveShape, recoveryOnly, adaptiveEvidence, adaptiveFailure, finalGoal } : {}),
    finished: events.filter((event) => event.kind === 'finished').map((event) => event.status),
    checkpointState,
    selectedFork: fork ? { sourceJobId: fork.sourceJobId,
      commitSha: fork.checkpoint.commitSha, completed: fork.checkpoint.completedWorkItems } : null,
    recoveryCheckpoints: recoveryPoints.map(point => ({ commitSha: point.commitSha,
      workItem: point.workItem, eligible: point.eligible, reason: point.reason,
      completed: point.completedWorkItems, nextWorkItem: point.nextWorkItem,
      proofDigest: point.proofDigest, semanticReview: point.semanticReview })),
    receipts,
  }
  writeFileSync(join(attempts, 'observation.json'), JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  if (!existsSync(join(root, 'certification-observation.json')))
    writeFileSync(join(root, 'certification-observation.json'), JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  // The full diagnostic (including reviewer reason) remains private in the
  // owner-only observation file; console output contains no raw model context.
  console.log('Live ' + mode + ' final:', JSON.stringify({ mode, jobId, finalHead,
    terminal, nativeValidation: validationStatus,
    eligibleCheckpoints: recoveryPoints.filter(point => point.eligible).length,
  }))
  assert.equal(terminal, 'completed', 'The complete Story is required; Foundation alone is insufficient')
  assert.equal(validationStatus, 'passed')
  if (adaptiveShape) {
    assert.equal(process.env.NT_ADAPTIVE_PLANNING, '1', 'Adaptive certification must run the enabled production scheduler')
    assert.equal(adaptiveFailure, null, 'Adaptive inspection and final author-goal evidence must be independently readable')
    assert.equal(finalGoal?.status, 'passed', 'Original Author goal must pass final independent Turn review')
    assert.equal(finalGoal.assurance, 'semantic', 'Fixture checks cannot substitute for real-Pi final review')
    if (recoveryOnly) {
      console.log('The original approved Story goal survived an independent checkpoint continuation; ' +
        'this is recovery evidence, not fresh amended-plan admission certification.')
    } else {
      assert.ok(adaptiveEvidence && adaptiveEvidence.amendments.length > 0,
        'A fixed Architecture inventory without a real admitted adaptive Pi amendment is not certification')
      if (adaptiveShape === 'narrative-led') {
        assert.ok(adaptiveEvidence.amendments.some(entry => entry.omissions > 0),
          'Event-only no-Puzzle path requires independently reviewed omission provenance')
      } else if (adaptiveShape === 'choice-heavy') {
        assert.ok(adaptiveEvidence.amendments.some(entry => entry.actions.some(action =>
          ['add', 'split', 'narrow', 'depend'].includes(action))),
        'Choice-heavy Story must exercise genuine adaptive executable assignment changes')
      }
    }
  }
  assert.ok(changed.some((path) => path.startsWith('story/authored-content/')))
  assert.ok(changed.some((path) => path.startsWith('story/events/')))
  assert.ok(
    changed.some((path) => path.startsWith('story/choice-points/') || path.startsWith('story/puzzles/')),
  )
  assert.equal(git(job.worktreeRoot, 'status', '--porcelain'), '')
}

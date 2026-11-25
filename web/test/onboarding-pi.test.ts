import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { removeTestTree } from '../../test/helpers'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { onboardingPiRequest, DiscoveryInvocationNotStarted, type DiscoveryInference } from '../src/lib/onboarding-pi.server'
import { userPiCredentials, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { candidate } from '../src/lib/story-foundation.server'
import { hasUserProtectedDecision } from '../../src/foundation-record'
import { withFixtureSemanticReview } from './support/discovery-semantic-fixture'
import { readDiscoveryResponse, type DiscoveryAttempt } from '../src/lib/discovery-evidence.server'

const url = 'http://localhost:3000'
const structuredQuestions = (questions: unknown[]) => JSON.stringify({
  phase: 'questions', questions: { questions },
})
const config = {
  baseURL: url, secret: 'pi-onboarding-test-secret-0123456789abcdefghijklmnop',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const repo = '11111111-1111-4111-8111-111111111111'
const proposed = JSON.stringify({ phase: 'proposal', task: 'Expand the branching mystery',
  foundation: { id: 'foundation', title: 'The Last Bell', premise: 'A bell disappears',
    central_conflict: 'The town hides the truth', genre: 'Mystery', tone: 'Somber',
    player_experience: 'Question evidence and choose loyalties', scope: 'One town, two outcomes',
    body: 'The player investigates a bell that was heard after it vanished. The cause remains grounded in personal loyalty.',
    decisions: [{ statement: 'No fixed heroic ending', authority: 'delegated' }] } })

function makeSkills(root: string) {
  const source = join(root, 'skills-checkout')
  const discovery = join(source, 'skills', 'nt-story-discovery')
  const catalog = join(source, 'skills', 'nt-catalog')
  mkdirSync(discovery, { recursive: true })
  mkdirSync(join(catalog, 'references'), { recursive: true })
  execFileSync('git', ['init', '-q', source])
  writeFileSync(join(discovery, 'SKILL.md'),
    '---\nname: nt-story-discovery\ndescription: Collaborate creatively\n---\nAsk all currently answerable creative questions.\n')
  writeFileSync(join(catalog, 'SKILL.md'),
    '---\nname: nt-catalog\ndescription: Canonical records\n---\nPreserve decision authority.\n')
  for (const file of ['records.md', 'authority-and-validation.md', 'glossary.md'])
    writeFileSync(join(catalog, 'references', file), 'Canonical Story guidance: ' + file + '\n')
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Pinned skill fixture'])
  return source
}
test('Pi discovery is multi-round, owner-scoped, restart-safe and exact-proposal bound before Git', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-pi-onboard-'))
  const env = { key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR, evidence: process.env.NT_DISCOVERY_EVIDENCE_DIR }
  process.env.NT_DISCOVERY_EVIDENCE_DIR = join(root, 'private-evidence')
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = makeSkills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshot-cache')
  const db = join(root, 'studio.sqlite')
  let store = openStudioDatabase(db)
  try {
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@pi-onboard.test',
      emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@pi-onboard.test',
      emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const own = await cookie(alice.id), foreign = await cookie(bob.id)
    await store.persistence.repositories.upsert(alice.id, 'github', '1',
      'test/repo', null, repo, '2026-11-01')
    await userPiCredentials(store, alice.id).modify('openai',
      async () => ({ type: 'api_key', key: 'TEST-USER-ONLY-KEY' }))
    const models = await availableUserPiModels(store, alice.id)
    assert.ok(models.length, 'the user must have an actual selectable Pi model')
    const model = {provider: models[0]!.provider, id: models[0]!.id }
    const calls: string[] = []
    const infer: DiscoveryInference = async (state, prompt) => {
      calls.push(state.phase + ':' + state.turns.length)
      assert.match(prompt, /nt-story-discovery\/SKILL.md/)
      assert.match(prompt, /nt-catalog\/SKILL.md/)
      assert.match(prompt, /Ask all currently answerable creative questions/)
      return state.turns.length === 1
        ? structuredQuestions([{ id: 'feeling', kind: 'free-text',
          question: 'How should players feel while investigating?',
          placeholder: 'For example, wary and curious', allowStudioDecision: false }])
        : state.turns.length === 3
          ? structuredQuestions([{ id: 'ending', kind: 'yes-no',
            question: 'Should the ending always be fixed?', allowStudioDecision: true },
            { id: 'direction', kind: 'free-text',
              question: 'What creative guidance should shape the ending?',
              allowStudioDecision: false }])
          : '```json\n' + JSON.stringify({ ...JSON.parse(proposed), foundation: {
            ...JSON.parse(proposed).foundation, decisions: [
              { statement: 'No fixed heroic ending', authority: 'delegated',
                source: { kind: 'answer', setId: state.accepted![1]!.setId, questionId: 'ending' } },
            ],
          } }) + '\n```'
    }
    const request = async (method: 'GET' | 'POST', value?: unknown, who = own, origin = url,
      inferStep = infer, workspace = 'projects/demo',
      review?: Parameters<typeof withFixtureSemanticReview>[1],
      disputes?: Parameters<typeof withFixtureSemanticReview>[2],
      continuation?: Parameters<typeof withFixtureSemanticReview>[3]) => {
      const response = await onboardingPiRequest(auth, store,
        new Request(url + '/api/onboarding/pi?' + new URLSearchParams({
          repositoryId: repo, workspace,
        }), { method, headers: {cookie: who, origin},
          ...(method === 'POST' ? {body: JSON.stringify(value)} : {}) }), url,
        withFixtureSemanticReview(inferStep, review, disputes, continuation))
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await request('GET', undefined, '')).status, 401)
    assert.equal((await request('GET', undefined, foreign)).status, 404)
    assert.equal((await request('POST', {action: 'start', model, text: 'A missing bell'},
      own, 'https://other.test')).status, 403)
    assert.equal((await request('GET')).body.session, null)
    const first = await request('POST', { action: 'start', model, text: 'A missing bell in a small town' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.session.phase, 'questions')
    assert.equal(first.body.session.questions.questions[0].id, 'feeling')
    const firstRevision = first.body.session.revision
    assert.ok(firstRevision > 0)
    assert.equal((await request('POST', { action: 'start', model, text: 'Duplicate' })).status, 409)
    assert.equal((await request('POST', { action: 'answer', revision: firstRevision, text: 'wary' },
      foreign)).status, 404)
    assert.equal((await request('POST', { action: 'answer', revision: firstRevision - 1, text: 'wary' })).status, 409)
    const firstSet = first.body.session.questions
    const second = await request('POST', { action: 'answer', revision: firstRevision,
      setId: firstSet.id, setRevision: firstSet.revision,
      responses: [{ questionId: 'feeling', answer: { kind: 'custom',
        text: 'The player should feel wary, and always have a choice.', note: '' } }],
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.session.phase, 'questions')
    store.close()
    store = openStudioDatabase(db)
    auth = createStudioAuth(store, config)
    const reopened = await request('GET')
    assert.equal(reopened.body.session.phase, 'questions')
    assert.equal(reopened.body.session.turns.length, 4)
    const secondSet = reopened.body.session.questions
    const secondRevision = reopened.body.session.revision
    assert.ok(secondRevision > firstRevision)
    assert.equal(secondSet.questions.length, 2)
    const validResponses = [
      { questionId: 'ending', answer: { kind: 'delegate', note: '' } },
      { questionId: 'direction', answer: { kind: 'custom',
        text: 'Please choose the ending structure; preserve player choice.', note: '' } },
    ]
    assert.equal((await request('POST', { action: 'answer', revision: secondRevision,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: validResponses.slice(0, 1),
    })).status, 422, 'missing mandatory answers cannot partially commit')
    assert.equal((await request('POST', { action: 'answer', revision: secondRevision,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: [{ questionId: 'ending', answer: { kind: 'option', optionId: 'yes', note: '' } },
        { questionId: 'direction', answer: { kind: 'delegate', note: '' } }],
    })).status, 422, 'agent cannot delegate an author-controlled item')
    const draft = { direction: { selection: '__answer__', selectedIds: [],
      multiCustom: false, customAnswer: 'Please choose the ending structure; preserve player choice.',
      note: '' } }
    const savedDraft = await request('POST', { action: 'draft', revision: secondRevision,
      setId: secondSet.id, setRevision: secondSet.revision, drafts: draft })
    assert.equal(savedDraft.status, 200)
    assert.ok(savedDraft.body.session.revision > secondRevision)
    assert.deepEqual(savedDraft.body.session.drafts, draft)
    assert.equal((await request('POST', { action: 'draft', revision: secondRevision,
      setId: secondSet.id, setRevision: secondSet.revision, drafts: {} })).status, 409,
      'second-tab stale draft must not overwrite newer input')
    store.close()
    store = openStudioDatabase(db)
    auth = createStudioAuth(store, config)
    assert.deepEqual((await request('GET')).body.session.drafts, draft,
      'unsubmitted input survives server restart')
    const third = await request('POST', { action: 'answer', revision: savedDraft.body.session.revision,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: validResponses,
    })
    assert.equal(third.status, 200, JSON.stringify(third.body))
    assert.equal(third.body.session.phase, 'proposed')
    assert.equal(third.body.session.proposal.foundation.decisions.length, 5)
    assert.equal(third.body.session.proposal.foundation.decisions[0].origin, 'user')
    assert.equal(third.body.session.proposal.foundation.decisions[2].origin, 'user')
    assert.equal(third.body.session.proposal.foundation.decisions[4].origin, 'agent')
    assert.equal(third.body.session.proposal.foundation.decisions[4].authority, 'delegated')
    assert.match(third.body.session.proposal.foundation.decisions[3].statement, /Please choose/)
    const foundation = third.body.session.proposal.foundation
    assert.equal((await request('POST', {action: 'approve', revision: third.body.session.revision,
      digest: 'f'.repeat(64)})).status, 409)
    assert.equal((await request('POST', {action: 'approve', revision: secondRevision,
      digest: third.body.session.digest})).status, 409)
    assert.equal((await request('POST', {action: 'revise', revision: secondRevision,
      text: 'Unapproved edit'})).status, 409)
    const accepted = await request('POST', {action: 'approve', revision: third.body.session.revision,
      digest: third.body.session.digest})
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.equal(accepted.body.session.phase, 'approved')
    assert.ok(hasUserProtectedDecision(candidate(foundation).file))
    const ref = { revision: accepted.body.session.revision, digest: accepted.body.session.digest }
    // Even a valid saved approval in the retired workspace namespace cannot
    // execute without an explicit isolated fixture transport or a Chat Turn.
    const savedBefore = await store.persistence.onboarding.conversation(alice.id, repo, 'projects/demo')
    for (const data of [{ action: 'start', model, text: 'New Story' },
      { action: 'approve', ...ref }, { action: 'retry', revision: ref.revision }]) {
      const refused = await onboardingPiRequest(auth, store,
        new Request(url + '/api/onboarding/pi?' + new URLSearchParams({
          repositoryId: repo, workspace: 'projects/demo',
        }), { method: 'POST', headers: { cookie: own, origin: url }, body: JSON.stringify(data) }), url)
      assert.equal(refused.status, 410)
    }
    assert.deepEqual(await store.persistence.onboarding.conversation(alice.id, repo, 'projects/demo'), savedBefore)
    assert.equal((await request('POST', {action: 'answer', revision: ref.revision, text: 'Late'})).status, 409)
    assert.equal((await request('GET', undefined, foreign)).status, 404)
    assert.equal(calls.length, 3)

    // A delegated ending cannot be used to create an unrelated artwork
    // budget. Independent review rejects three non-improving proposals.
    const previousEvidenceRoot = process.env.NT_DISCOVERY_EVIDENCE_DIR
    process.env.NT_DISCOVERY_EVIDENCE_DIR = join(root, 'semantic-rejection-evidence')
    try {
      let writerCalls = 0, reviewCalls = 0
      const writer: DiscoveryInference = async (state, prompt) => {
        writerCalls++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no', question: 'Should the ending be hopeful?',
            allowStudioDecision: true },
        ])
        if (writerCalls === 3) assert.match(prompt, /Independent read-only scope review rejected/)
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation,
          decisions: [{ statement: writerCalls >= 5
            ? 'Allow an ending that may be hopeful.' : 'Use twelve expensive character portraits.',
            authority: 'delegated', source: { kind: 'answer',
              setId: state.accepted![0]!.setId, questionId: 'ending' } }],
        } })
      }
      const reject: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = packet => {
        reviewCalls++
        assert.equal(packet.claims.length, 1)
        return packet.claims.map(c => ({ claimId: c.id,
          verdict: c.statement.includes('portraits') ? 'unsupported' as const : 'supported' as const,
          reason: c.statement.includes('portraits')
            ? 'A question about endings does not authorize an artwork budget.'
            : 'The delegated question concerns the ending.' }))
      }
      const workspace = 'projects/semantic-scope-rejection'
      const start = await request('POST', { action: 'start', model,
        text: 'A short mystery.' }, own, url, writer, workspace, reject)
      assert.equal(start.status, 200)
      const rejected = await request('POST', {
        action: 'answer', revision: start.body.session.revision,
        setId: start.body.session.questions.id,
        setRevision: start.body.session.questions.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, reject)
      assert.equal(rejected.status, 503)
      assert.equal(writerCalls, 4)
      assert.equal(reviewCalls, 4, 'Two nonproductive semantic corrections trigger independent diagnosis')
      const saved = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(saved.phase, 'blocked')
      assert.equal(saved.accepted[0].responses[0].answer.kind, 'delegate')
      assert.equal(saved.proposal, undefined)
      assert.equal(saved.semanticReview, undefined)
      assert.equal(saved.pendingDiscovery.kind, 'correction')
      assert.equal(saved.pendingDiscovery.reviewHistory.length, 3)
      assert.equal(saved.pendingDiscovery.nonprogress, 2)
      const reviews = saved.discoveryEvidencePaths.filter((path: string) =>
        path.includes('-semantic-review-'))
      assert.equal(reviews.length, 3)
      assert.ok(reviews.every((path: string) =>
        JSON.parse(readFileSync(join(path, 'validation.json'), 'utf8')).status === 'rejected'))
      const resumed = await request('POST', { action: 'retry', revision: saved.revision },
        own, url, writer, workspace, reject)
      assert.equal(resumed.status, 409, 'An exhausted correction cannot mint a new allowance')
      assert.equal(writerCalls, 4)
      assert.equal(reviewCalls, 4)
      assert.equal(saved.recovery.status, 'unresolved')
      assert.equal(saved.recovery.reason, 'nonconverging')
    } finally {
      if (previousEvidenceRoot === undefined) delete process.env.NT_DISCOVERY_EVIDENCE_DIR
      else process.env.NT_DISCOVERY_EVIDENCE_DIR = previousEvidenceRoot
    }

    // The same diagnosed source cannot mint another diagnosis, even when
    // the writer changes wording on every response.
    for (const repeated of [false, true]) {
      const workspace = repeated ? 'projects/provenance-repeated-source' : 'projects/provenance-assessment'
      let writers = 0, diagnoses = 0, reviews = 0
      const writer: DiscoveryInference = async (state, prompt, role) => {
        if (role === 'provenance-diagnostic') {
          diagnoses++
          assert.match(prompt, /Independent, read-only Discovery provenance diagnosis/)
          return JSON.stringify({ action: 'continue', reason: 'Remove the fabricated author citation.' })
        }
        writers++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no', question: 'Should the ending be hopeful?', allowStudioDecision: true },
        ])
        if ([5, 7, 9].includes(writers)) assert.match(prompt, /Remove the fabricated author citation/)
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation, decisions: [{
            statement: repeated ? 'A hopeful ending, unchanged invalid draft' :
              writers < 9 ? 'A hopeful ending, draft ' + writers : 'A hopeful ending',
            authority: writers < 9 ? 'user-protected' : 'delegated',
            source: { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'ending' },
          }] } })
      }
      const review: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = packet => {
        reviews++
        return packet.claims.map(claim => ({ claimId: claim.id,
          verdict: 'supported' as const, reason: 'Exact submitted ending delegation.' }))
      }
      const start = await request('POST', { action: 'start', model, text: 'A short mystery' },
        own, url, writer, workspace, review)
      assert.equal(start.status, 200)
      const qs = start.body.session.questions
      const result = await request('POST', { action: 'answer', revision: start.body.session.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, review)
      assert.equal(result.status, 503, JSON.stringify(result.body))
      assert.equal(writers, 6)
      assert.equal(diagnoses, 1, 'changing wording cannot mint another diagnosis of the same source defect')
      assert.equal(reviews, 0)
      const saved = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(saved.recovery.reason, 'nonconverging')
    }
    // A reviewer flipping its verdict for unchanged source evidence cannot
    // manufacture a passing proposal, even if a diagnostic agrees with it.
    {
      const workspace = 'projects/reviewer-drift'
      let writers = 0, reviews = 0
      const writer: DiscoveryInference = async state => {
        writers++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no', question: 'Should the ending be hopeful?', allowStudioDecision: true },
        ])
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation, decisions: [{
            statement: 'A hopeful ending', authority: 'delegated',
            source: { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'ending' },
          }] } })
      }
      const review: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = packet => {
        reviews++
        return packet.claims.map(claim => ({ claimId: claim.id,
          verdict: reviews === 1 ? 'unsupported' as const : 'supported' as const,
          reason: 'Fixture changes the verdict without changing the source.' }))
      }
      const start = await request('POST', { action: 'start', model, text: 'A short mystery' },
        own, url, writer, workspace, review)
      const qs = start.body.session.questions
      const result = await request('POST', { action: 'answer', revision: start.body.session.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, review)
      assert.equal(result.status, 503)
      assert.equal(writers, 3)
      assert.equal(reviews, 3)
      const saved = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(saved.recovery.status, 'fenced')
      assert.equal(saved.recovery.reason, 'reviewer-drift')
      assert.equal(saved.proposal, undefined)
      assert.equal(saved.semanticReview, undefined)
      assert.equal((await request('POST', { action: 'retry', revision: saved.revision },
        own, url, writer, workspace, review)).status, 409)
      assert.equal(writers, 3)
    }

    // Exact source-backed disagreement permits a fresh replacement, not
    // acceptance of the diagnostic verdict. An adverse replacement still fences.
    for (const replacementPasses of [true, false]) {
      const workspace = 'projects/reviewer-replacement-' + replacementPasses
      let writers = 0
      const roles: string[] = []
      const writer: DiscoveryInference = async state => {
        writers++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no', question: 'Should the ending be hopeful?', allowStudioDecision: true },
        ])
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation, decisions: [{
            statement: 'A hopeful ending', authority: 'delegated',
            source: { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'ending' },
          }] } })
      }
      const review: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = (packet, role) => {
        roles.push(role!)
        return packet.claims.map(claim => ({
          claimId: claim.id,
          verdict: roles.length === 1 || role === 'semantic-replacement' && !replacementPasses
            ? 'unsupported' : 'supported',
          reason: 'The disputed claim concerns the exact delegated ending.',
        }))
      }
      const disputes: NonNullable<Parameters<typeof withFixtureSemanticReview>[2]> = packet =>
        packet.claims.map(claim => ({ claimId: claim.id, claimQuote: claim.statement, sourceQuote: claim.question }))
      const start = await request('POST', { action: 'start', model, text: 'A short mystery' },
        own, url, writer, workspace, review, disputes)
      const qs = start.body.session.questions
      const result = await request('POST', { action: 'answer', revision: start.body.session.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, review, disputes)
      assert.equal(result.status, replacementPasses ? 200 : 503, JSON.stringify(result.body))
      assert.equal(writers, 3)
      assert.deepEqual(roles, ['semantic-review', 'semantic-review', 'semantic-diagnostic', 'semantic-replacement'])
      const saved = JSON.parse((await store.persistence.onboarding.conversation(alice.id, repo, workspace))!.state)
      assert.equal(saved.phase, replacementPasses ? 'proposed' : 'blocked')
      assert.equal(saved.approval, undefined)
      const negative = saved.discoveryEvidencePaths.find((path: string) => path.includes('-semantic-review-'))
      assert.equal(JSON.parse(readFileSync(join(negative, 'validation.json'), 'utf8')).status, 'rejected')
      const replacement = saved.discoveryEvidencePaths.find((path: string) => path.includes('-semantic-replacement-'))
      const requestReceipt = JSON.parse(readFileSync(join(replacement, 'request.json'), 'utf8'))
      assert.match(requestReceipt.instructions, /Authenticated negative predecessor and assessment receipt/)
      assert.equal(JSON.parse(readFileSync(join(replacement, 'validation.json'), 'utf8')).status,
        replacementPasses ? 'accepted' : 'rejected')
      assert.equal(!!saved.semanticReview, replacementPasses)
      if (!replacementPasses) assert.equal(saved.recovery.reason, 'reviewer-drift')
    }

    // An independent diagnosis can agree with the original rejected claim
    // and still identify a safe correction. It cannot itself approve the draft.
    for (const mode of ['continue', 'stop', 'stalled'] as const) {
      const workspace = 'projects/semantic-continuation-' + mode
      let writers = 0, diagnoses = 0
      const roles: string[] = []
      const correctionText = 'Narrow the delegated assertion to a hopeful ending.'
      const writer: DiscoveryInference = async (state, instructions) => {
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no', question: 'Should the ending be hopeful?', allowStudioDecision: true },
        ])
        writers++
        const diagnosed = instructions.includes(correctionText)
        if (mode === 'continue' && diagnoses) assert.equal(diagnosed, true)
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation, decisions: [{
            statement: mode === 'continue' && diagnosed ? 'A hopeful ending' : 'A hopeful ending and expensive illustrated backgrounds',
            authority: 'delegated',
            source: { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'ending' },
          }] } })
      }
      const review: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = (packet, role) => {
        roles.push(role!)
        if (role === 'semantic-diagnostic') diagnoses++
        return packet.claims.map(claim => ({ claimId: claim.id,
          verdict: claim.statement === 'A hopeful ending' ? 'supported' : 'unsupported',
          reason: 'The submitted question authorizes the ending, not the art budget.' }))
      }
      const continuation: NonNullable<Parameters<typeof withFixtureSemanticReview>[3]> = packet =>
        mode === 'stop' ? { action: 'stop', reason: 'No safe correction established from the available author source.' } :
          { action: 'continue', corrections: packet.claims.map(claim => ({
            claimId: claim.id, claimQuote: claim.statement, sourceQuote: claim.question, correction: correctionText })) }
      const start = await request('POST', { action: 'start', model, text: 'A short mystery' },
        own, url, writer, workspace, review, undefined, continuation)
      const qs = start.body.session.questions
      const result = await request('POST', { action: 'answer', revision: start.body.session.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, review, undefined, continuation)
      assert.equal(result.status, mode === 'continue' ? 200 : 503, JSON.stringify(result.body))
      const saved = JSON.parse((await store.persistence.onboarding.conversation(alice.id, repo, workspace))!.state)
      assert.equal(saved.phase, mode === 'continue' ? 'proposed' : 'blocked')
      assert.equal(!!saved.semanticReview, mode === 'continue')
      assert.equal(saved.approval, undefined)
      assert.equal(diagnoses, 1)
      if (mode === 'continue') {
        assert.equal(roles.at(-1), 'semantic-review')
        assert.ok(writers > 3)
        const paths = saved.discoveryEvidencePaths as string[]
        const negative = paths.find(path => path.includes('-semantic-review-'))!
        assert.equal(JSON.parse(readFileSync(join(negative, 'validation.json'), 'utf8')).status, 'rejected')
        const attempts: DiscoveryAttempt[] = saved.settledAttempts.filter((attempt: DiscoveryAttempt) =>
          attempt.status === 'started' && attempt.sourceDigest === saved.settledAttempts.at(-1).sourceDigest)
        const receipts = await Promise.all(attempts.map(attempt =>
          readDiscoveryResponse(attempt, attempt.sourceDigest!, attempt.role, true)))
        const writerReceipts = receipts.filter(receipt => receipt.reference!.role === 'writer')
        const reviewers = receipts.filter(receipt => receipt.reference!.role === 'reviewer')
        const diagnostic = receipts.find(receipt => receipt.reference!.role === 'diagnostic')!
        assert.equal(new Set(writerReceipts.map(receipt => receipt.reference!.id)).size, 1)
        assert.equal(new Set(reviewers.map(receipt => receipt.reference!.id)).size, 1)
        assert.equal(new Set([writerReceipts[0]!.reference!.id, reviewers[0]!.reference!.id, diagnostic.reference!.id]).size, 3)
      } else assert.equal(saved.recovery.reason, 'nonconverging')
    }

    // Structural correction must not consume subsequent independent semantic review.
    {
      let calls = 0, reviews = 0
      const workspace = 'projects/structural-then-semantic'
      const writer: DiscoveryInference = async state => {
        calls++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'tone', kind: 'yes-no', question: 'Should the tone be unsettling?', allowStudioDecision: true },
          { id: 'experience', kind: 'yes-no', question: 'Should choices be consequential?', allowStudioDecision: true },
        ])
        const source = (questionId: string) => ({ kind: 'answer' as const,
          setId: state.accepted![0]!.setId, questionId })
        const decisions = calls === 2
          ? [{ statement: 'Keep a tense experience.', authority: 'delegated', source: source('missing') }]
          : calls === 3
            ? [{ statement: 'Uneasy tone and a consequential player experience.',
              authority: 'delegated', source: source('tone') }]
            : [{ statement: 'Uneasy tone.', authority: 'delegated', source: source('tone') },
              { statement: 'Consequential choices.', authority: 'delegated', source: source('experience') }]
        return JSON.stringify({ ...JSON.parse(proposed),
          foundation: { ...JSON.parse(proposed).foundation, decisions } })
      }
      const reviewer: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = packet => {
        reviews++
        return packet.claims.map(claim => ({
          claimId: claim.id,
          verdict: claim.source.kind === 'answer' && claim.source.questionId === 'tone' &&
            claim.statement.includes('player experience') ? 'unsupported' as const : 'supported' as const,
          reason: 'This assessment is limited to the exact delegated question.',
        }))
      }
      const started = await request('POST', { action: 'start', model, text: 'A short mystery.' },
        own, url, writer, workspace, reviewer)
      assert.equal(started.status, 200)
      const qs = started.body.session.questions
      const revised = await request('POST', { action: 'answer', revision: started.body.session.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'tone', answer: { kind: 'delegate', note: '' } },
          { questionId: 'experience', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, reviewer)
      assert.equal(revised.status, 200, JSON.stringify(revised.body))
      assert.equal(revised.body.session.phase, 'proposed')
      assert.equal(calls, 4)
      assert.equal(reviews, 2)
      const persisted = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(persisted.semanticReview.proposalDigest, persisted.digest)
      assert.equal((await request('GET', undefined, own, url, writer, workspace, reviewer))
        .body.session.phase, 'proposed')
      assert.equal(calls, 4, 'Reload must never replay an accepted writer')
    }

    // A completed writer response survives a proven unstarted independent
    // reviewer; explicit retry re-reviews exact evidence without calling the writer.
    {
      const workspace = 'projects/reviewer-retry'
      let writers = 0, reviews = 0, reviewerAvailable = false
      const writer: DiscoveryInference = async state => {
        writers++
        if (state.turns.length === 1) return structuredQuestions([
          { id: 'ending', kind: 'yes-no',
            question: 'Should the story allow different endings?', allowStudioDecision: true },
        ])
        return JSON.stringify({ ...JSON.parse(proposed), foundation: {
          ...JSON.parse(proposed).foundation,
          decisions: [{ statement: 'Allow multiple endings.', authority: 'delegated',
            source: { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'ending' } }],
        } })
      }
      const review: NonNullable<Parameters<typeof withFixtureSemanticReview>[1]> = packet => {
        reviews++
        if (!reviewerAvailable) throw new DiscoveryInvocationNotStarted('Reviewer admission unavailable')
        return packet.claims.map(c => ({
          claimId: c.id, verdict: 'supported' as const, reason: 'Exact author delegation.',
        }))
      }
      const started = await request('POST', { action: 'start', model,
        text: 'A short mystery' }, own, url, writer, workspace, review)
      assert.equal(started.status, 200)
      const qs = started.body.session.questions
      const failed = await request('POST', { action: 'answer',
        revision: started.body.session.revision, setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace, review)
      assert.equal(failed.status, 503)
      assert.equal(writers, 2)
      assert.equal(reviews, 1)
      const blocked = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(blocked.phase, 'blocked')
      assert.equal(blocked.pendingDiscovery.kind, 'review')
      assert.deepEqual(blocked.activeAttempts?.map((attempt: {status: string}) => attempt.status), ['started', 'not-started'])
      assert.ok(!JSON.stringify(failed.body).includes(blocked.pendingDiscovery.raw),
        'Private draft cannot leak to public error responses')
      reviewerAvailable = true
      const resumed = await request('POST', { action: 'retry', revision: blocked.revision },
        own, url, writer, workspace, review)
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
      assert.equal(resumed.body.session.phase, 'proposed')
      assert.equal(writers, 2, 'Never re-run an already-completed discovery writer')
      assert.equal(reviews, 2)
      const accepted = JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      assert.equal(accepted.pendingDiscovery, undefined)
      assert.equal(accepted.semanticReview.proposalDigest, accepted.digest)
    }

    // #258: the original Turn budget meters actual execution across author
    // rounds, not elapsed wall time while the author or provider is idle.
    // Exhaust the first model-call allowance through a real settled response.
    {
      const workspace = 'projects/cumulative-original-budget'
      let calls = 0
      const writer: DiscoveryInference = async state => {
        calls++
        return state.turns.length === 1
          ? structuredQuestions([{ id: 'ending', kind: 'yes-no',
              question: 'Should there be multiple endings?', allowStudioDecision: true }])
          : structuredQuestions([{ id: 'tone', kind: 'free-text',
              question: 'What tone should the mystery use?' }])
      }
      const readSaved = async () => JSON.parse((await store.persistence.onboarding.conversation(
        alice.id, repo, workspace))!.state)
      const started = await request('POST', { action: 'start', model, text: 'A short mystery',
        limits: { modelCalls: 1, activeSeconds: 5400 } }, own, url, writer, workspace)
      assert.equal(started.status, 200, JSON.stringify(started.body))
      assert.equal(calls, 1)
      const initial = await readSaved()
      assert.equal(initial.settledAttempts.length, 1)
      const qs = started.body.session.questions
      const answered = await request('POST', { action: 'answer', revision: initial.revision,
        setId: qs.id, setRevision: qs.revision,
        responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } }],
      }, own, url, writer, workspace)
      assert.equal(answered.status, 503, JSON.stringify(answered.body))
      const blocked = await readSaved()
      assert.equal(blocked.phase, 'blocked')
      assert.equal(blocked.recovery.status, 'paused')
      assert.equal(blocked.recovery.reason, 'budget')
      assert.deepEqual(blocked.settledAttempts, initial.settledAttempts)
      assert.deepEqual(blocked.activeAttempts, [], 'Budget admission precedes any new invocation')
      assert.equal(blocked.proposal, undefined)
      assert.equal(calls, 1)
      for (const limits of [undefined, { modelCalls: 1 }, { modelCalls: 2, activeSeconds: 5399 }]) {
        const denied = await request('POST', { action: 'retry', revision: blocked.revision, limits },
          own, url, writer, workspace)
        assert.equal(denied.status, 422, JSON.stringify(denied.body))
        assert.equal((await readSaved()).revision, blocked.revision)
        assert.equal(calls, 1)
      }
      const resumed = await request('POST', { action: 'retry', revision: blocked.revision,
        limits: { modelCalls: 2 } }, own, url, writer, workspace)
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
      assert.equal(resumed.body.session.phase, 'questions')
      assert.equal(resumed.body.session.questions.questions[0].id, 'tone')
      const settled = await readSaved()
      assert.equal(settled.startedAt, blocked.startedAt)
      assert.deepEqual(settled.limits, { modelCalls: 2, activeSeconds: 5400 })
      assert.deepEqual(settled.settledAttempts.slice(0, 1), initial.settledAttempts)
      assert.equal(settled.settledAttempts.length, 2)
      assert.deepEqual(settled.accepted, blocked.accepted)
      assert.equal(settled.recovery, undefined)
      assert.equal(calls, 2, 'Replenishment must invoke only the unfinished author round')
    }

    // The shared contract permits 16 typed questions, each with 4,000 custom
    // text and 1,000 note characters. Both the autosave and final-answer
    // transport must accept every validated combination, including CJK UTF-8.
    const bulkRequest = (body: unknown, inferStep: DiscoveryInference = async () =>
      structuredQuestions([{ id: 'follow-up', kind: 'free-text',
        question: 'What should happen next after the accepted answers?' }])) =>
      request('POST', body, own, url, inferStep, 'projects/bulk')
    const bulkStart = await bulkRequest({ action: 'start', model,
      text: 'A mystery about a vanished bell' }, async () => structuredQuestions(
      Array.from({ length: 16 }, (_, i) => ({ id: 'direction-' + i,
        kind: 'free-text', question: 'What should the author decide for part ' + (i + 1) + '?' }))))
    assert.equal(bulkStart.status, 200, JSON.stringify(bulkStart.body))
    assert.equal(bulkStart.body.session.questions.questions.length, 16)
    const set = bulkStart.body.session.questions
    const text = '界'.repeat(4000), note = '界'.repeat(1000)
    const drafts = Object.fromEntries(set.questions.map((q: { id: string }) =>
      [q.id, { selection: '__answer__', selectedIds: [], multiCustom: false,
        customAnswer: text, note }]))
    const responses = set.questions.map((q: { id: string }) => ({
      questionId: q.id, answer: { kind: 'custom', text, note },
    }))
    // Nine full CJK answers already breached the previous 100 KB cap.
    const nine = Object.fromEntries(Object.entries(drafts).slice(0, 9))
    const ninePayload = { action: 'draft', revision: bulkStart.body.session.revision,
      setId: set.id, setRevision: set.revision, drafts: nine }
    assert.ok(Buffer.byteLength(JSON.stringify(ninePayload), 'utf8') > 100_000)
    const nineSaved = await bulkRequest(ninePayload)
    assert.equal(nineSaved.status, 200, JSON.stringify(nineSaved.body))
    assert.equal(Object.keys(nineSaved.body.session.drafts).length, 9)
    const fullPayload = { ...ninePayload, revision: nineSaved.body.session.revision, drafts }
    const fullBytes = Buffer.byteLength(JSON.stringify(fullPayload), 'utf8')
    assert.ok(fullBytes > 200_000 && fullBytes < 512_000, String(fullBytes))
    const fullSaved = await bulkRequest(fullPayload)
    assert.equal(fullSaved.status, 200, JSON.stringify(fullSaved.body))
    assert.equal(Object.keys(fullSaved.body.session.drafts).length, 16)
    const control = String.fromCharCode(0)
    const escapedDrafts = Object.fromEntries(set.questions.map((q: { id: string }) =>
      [q.id, { selection: '__answer__', selectedIds: [], multiCustom: false,
        customAnswer: control.repeat(4000), note: control.repeat(1000) }]))
    const escapedPayload = { ...fullPayload, revision: fullSaved.body.session.revision,
      drafts: escapedDrafts }
    const escapedBytes = Buffer.byteLength(JSON.stringify(escapedPayload), 'utf8')
    assert.ok(escapedBytes > 480_000 && escapedBytes < 512_000, String(escapedBytes))
    const escapedSaved = await bulkRequest(escapedPayload)
    assert.equal(escapedSaved.status, 200, JSON.stringify(escapedSaved.body))
    const oversized = await bulkRequest({ action: 'draft',
      revision: escapedSaved.body.session.revision, setId: set.id,
      setRevision: set.revision, drafts, padding: 'a'.repeat(512_000) })
    assert.equal(oversized.status, 413, 'request reader must remain bounded')
    const acceptedBatch = { action: 'answer', revision: escapedSaved.body.session.revision,
      setId: set.id, setRevision: set.revision, responses }
    assert.ok(Buffer.byteLength(JSON.stringify(acceptedBatch), 'utf8') > 200_000)
    const acceptedBulk = await bulkRequest(acceptedBatch)
    assert.equal(acceptedBulk.status, 200, JSON.stringify(acceptedBulk.body))
    assert.equal(acceptedBulk.body.session.accepted[0].responses.length, 16)
    assert.equal(acceptedBulk.body.session.accepted[0].responses[0].answer.text, text)
    assert.equal(acceptedBulk.body.session.phase, 'questions')
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 0,
      'discovery and approval cannot write canonical Story before provider initialization')
  } finally {
    store.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', env.key], ['NT_STUDIO_SKILLS_SOURCE', env.source],
      ['NT_SKILL_CACHE_DIR', env.cache], ['NT_DISCOVERY_EVIDENCE_DIR', env.evidence]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})

test('unstarted Pi turns may retry; uncertain started turns remain fenced', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-pi-retry-'))
  const prev = {key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR, evidence: process.env.NT_DISCOVERY_EVIDENCE_DIR}
  process.env.NT_DISCOVERY_EVIDENCE_DIR = join(root, 'private-evidence')
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = makeSkills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshot-cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice2', email: 'alice2@pi-onboard.test',
      emailVerified: true }, {method:'test'})
    const sess = await ctx.internalAdapter.createSession(alice.id)
    const cookie = 'better-auth.session_token=' + sess.token + '.' +
      createHmac('sha256', config.secret).update(sess.token).digest('base64')
    await store.persistence.repositories.upsert(alice.id, 'github', '1',
      'test/repo', null, repo, '2026-11-01')
    await userPiCredentials(store, alice.id).modify('openai', async () =>
      ({type:'api_key', key:'TEST-USER-ONLY-KEY'}))
    const model = (await availableUserPiModels(store, alice.id))[0]!
    const req = async (data: unknown, infer: DiscoveryInference) => {
      const response = await onboardingPiRequest(auth, store,
        new Request(url + '/api/onboarding/pi?' + new URLSearchParams({ repositoryId: repo, workspace: '' }),
          {method:'POST', headers:{origin:url, cookie}, body: JSON.stringify(data)}), url, infer)
      return {status: response.status, body: await response.json() as any}
    }
    const fail = await req({action:'start', model:{provider:model.provider, id:model.id},
      text:'A small-town mystery'}, async () => { throw new DiscoveryInvocationNotStarted('provider secret: NOT-FOR-UI') })
    assert.equal(fail.status, 503)
    assert.doesNotMatch(JSON.stringify(fail.body), /NOT-FOR-UI/)
    const resubmit = await req({action:'start', model:{provider:model.provider, id:model.id},
      text:'A small-town mystery'}, async () => { throw new Error('should never be called') })
    assert.equal(resubmit.status, 409)
    const revision = (await store.persistence.onboarding.conversation(alice.id, repo, ''))!.revision
    let calls = 0
    const retry = await req({action:'retry', revision}, async (state, instructions) => {
      calls++
      assert.equal(state.turns.length, 1)
      if (calls === 1) return structuredQuestions([{ id: 'conflict', kind: 'free-text',
        question: 'What is the main dramatic conflict?', allowStudioDecision: true,
        recommendationReason: 'Prefer a strong personal stake' }])
      assert.match(instructions, /Invalid Question Set recommendation/)
      assert.match(instructions, /free-text question omit recommendedId and recommendationReason/)
      assert.doesNotMatch(instructions, /provider secret: NOT-FOR-UI/)
      return structuredQuestions([{ id: 'conflict', kind: 'free-text',
        question: 'What is the main dramatic conflict?', allowStudioDecision: true,
        placeholder: 'A conflict with a personal stake' }])
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.body.session.phase, 'questions')
    assert.equal(calls, 2)
    const scopedRoots = readdirSync(join(root, 'private-evidence', 'discovery-sessions'))
    assert.equal(scopedRoots.length, 1, 'Only this owner and discovery identity has evidence')
    const privateScope = join(root, 'private-evidence', 'discovery-sessions', scopedRoots[0]!)
    assert.equal(statSync(privateScope).mode & 0o777, 0o700)
    const attempts = readdirSync(privateScope).map(name => join(privateScope, name))
    assert.equal(attempts.length, 2, 'Format-only correction stays within the original Pi invocation')
    const privatelySaved = JSON.parse((await store.persistence.onboarding.conversation(
      alice.id, repo, ''))!.state)
    assert.deepEqual(new Set(privatelySaved.discoveryEvidencePaths), new Set(attempts))
    assert.equal(retry.body.session.discoveryEvidencePaths, undefined,
      'Private transcript paths must not appear in the API session')
    const initial = attempts.find(dir => dir.includes('-initial-') &&
      readdirSync(dir).includes('inference-error.json'))!
    const accepted = attempts.find(dir => dir.includes('-initial-') && dir !== initial)!
    const failedCall = JSON.parse(readFileSync(join(initial, 'inference-error.json'), 'utf8'))
    assert.equal(failedCall.message, 'provider secret: NOT-FOR-UI')
    assert.equal(statSync(join(initial, 'inference-error.json')).mode & 0o777, 0o600)
    const acceptedRaw = JSON.parse(readFileSync(join(accepted, 'response.json'), 'utf8'))
    const protocol = JSON.parse(readFileSync(join(accepted, 'protocol.initial.json'), 'utf8'))
    assert.equal(protocol.attempts, 2)
    assert.equal(protocol.status, 'accepted')
    const transcript = readFileSync(acceptedRaw.piSessionFile, 'utf8')
    assert.match(transcript, /Prefer a strong personal stake/)
    assert.match(transcript, /free-text question omit recommendedId and recommendationReason/)
    assert.equal(JSON.parse(readFileSync(join(accepted, 'validation.json'), 'utf8')).status,
      'accepted')
    assert.doesNotMatch(JSON.stringify(retry.body), /NOT-FOR-UI|Prefer a strong personal stake/)
    assert.equal((await req({action:'retry', revision}, async () => { throw new Error('unexpected') })).status, 409)
    // Simulate a worker dying after reserving an expensive Pi turn. Recovery
    // must require an explicit acknowledgement, with no automatic model call.
    let entered!: () => void
    let release!: () => void
    const began = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const set = retry.body.session.questions
    const running = req({ action: 'answer', revision: retry.body.session.revision,
      setId: set.id, setRevision: set.revision,
      responses: [{ questionId: 'conflict', answer: { kind: 'custom',
        text: 'A conflict with a personal stake', note: '' } }],
    }, async () => {
      entered()
      await held
      return structuredQuestions([{ id: 'late', kind: 'free-text',
        question: 'Late result from the former worker' }])
    })
    try {
      await Promise.race([began, running.then(() => { throw Error('Writer did not start') })])
      const existing = (await store.persistence.onboarding.conversation(alice.id, repo, ''))!
      const hanging = {...JSON.parse(existing.state), revision: existing.revision + 1,
        startedAt: Date.now() - 11 * 60_000 }
      assert.equal(hanging.phase, 'running')
      assert.equal(hanging.graphOperation.status, 'claimed')
      assert.equal(await store.persistence.onboarding.saveConversation(alice.id, repo, '',
        hanging.revision, JSON.stringify(hanging), existing.revision, new Date().toISOString()), true)
      const recovered = await req({action:'reconcile',revision:hanging.revision}, async () => {
        throw new Error('reconcile must not call Pi')
      })
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
      assert.equal(recovered.body.session.phase, 'blocked')
      assert.equal(calls, 2)
      const blockedRevision = recovered.body.session.revision
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await req({action:'retry', revision: blockedRevision}, async () => {
          assert.fail('An uncertain started writer must not be replayed')
        })).status, 409)
      }
      assert.equal((await req({action:'reconcile',revision:hanging.revision}, async () => {
        throw new Error('duplicate reconcile must not call Pi')
      })).status, 409)
    } finally {
      release()
      const late = await running
      assert.notEqual(late.status, 200, 'Late worker may not overwrite the reconciled checkpoint')
    }
  } finally {
    store.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', prev.key], ['NT_STUDIO_SKILLS_SOURCE', prev.source],
      ['NT_SKILL_CACHE_DIR', prev.cache], ['NT_DISCOVERY_EVIDENCE_DIR', prev.evidence]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})

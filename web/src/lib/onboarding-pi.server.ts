import { createHash } from 'node:crypto'
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { onboardingWorkspace } from './onboarding.server'
import { createUserPiRuntime, assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import { createSkillSnapshot, openSkillSnapshot } from '../../../src/snapshot'
import { candidate, validateNewStory } from './story-foundation.server'
import { parseGenerationContract } from '../../../src/generation'
import { continueApprovedStoryChat, type ContinuationStatus } from './story-approved-continuation.server'

type Turn = { role: 'user' | 'assistant'; text: string }
type Foundation = {
  id: string; title: string; premise: string; central_conflict: string; genre: string
  tone: string; player_experience: string; scope: string; body: string
  decisions: Array<{ id: string; statement: string; origin: 'user' | 'agent'; authority: 'user-protected' | 'delegated' }>
}
type Proposal = { foundation: Foundation; task: string; contract: ReturnType<typeof parseGenerationContract> }
/** A sparse objective is not an authorization to invent all of its missing
 * foundations. Even Autonomous mode must ask before advancing to a proposal.
 * A deliberate instruction to choose everything without questions is different. */
function needsOpeningQuestions(brief: string): boolean {
  const sparse = brief.trim().split(/\s+/).length <= 18
  const allDelegated = /\b(?:decide|choose|invent|make up|delegate|leave)\b[\s\S]{0,90}\b(?:everything|all|remaining|the rest|every detail|every choice|every decision)\b/i.test(brief)
  const noQuestions = /\b(?:do not ask|don't ask|no questions|without questions|no need to ask)\b/i.test(brief)
  return sparse && !(allDelegated && noQuestions)
}
type Phase = 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'
/** Trusted Story Chat identity. The reserved persistence namespace is inaccessible
 * to the legacy repository onboarding endpoint. No client may supply this binding. */
export type ChatDiscoveryBinding = {
  storyId: string; firstTurnId: string; repositoryId: string; directory: string
  sourceSha: string; originalObjective: string
}
type Session = { phase: Phase; revision: number; model: PiSelection; skillId: string; brief: string;
  turns: Turn[]; questions?: string; proposal?: Proposal; digest?: string; startedAt?: number;
  chat?: ChatDiscoveryBinding }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reply = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
class DiscoveryError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
function scope(input: Session) {
  return { phase: input.phase, revision: input.revision, model: input.model,
    turns: input.turns, questions: input.questions ?? null, proposal: input.proposal ?? null,
    digest: input.digest ?? null, skillId: input.skillId, startedAt: input.startedAt ?? null,
    ...(input.chat ? { chat: input.chat } : {}) }
}
export type DiscoverySessionView = ReturnType<typeof scope>
function expectedProposal(value: unknown, authorMessages: string[]): Proposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed discovery reply')
  const output = value as Record<string, unknown>
  if (!output.foundation || typeof output.foundation !== 'object' || Array.isArray(output.foundation) ||
      typeof output.task !== 'string' || !output.task.trim() || output.task.length > 4000) {
    throw new Error('Missing proposed foundation or task')
  }
  const input = output.foundation as Record<string, unknown>
  const fields = ['id', 'title', 'premise', 'central_conflict', 'genre', 'tone', 'player_experience', 'scope', 'body']
  if (fields.some(field => typeof input[field] !== 'string' || !(input[field] as string).trim() ||
      (input[field] as string).length > (field === 'body' ? 12000 : field === 'title' ? 120 : 4000)) ||
      !Array.isArray(input.decisions) || input.decisions.length > 12 ||
      input.decisions.some(d => !d || typeof d !== 'object' || typeof d.statement !== 'string' ||
        !d.statement.trim() || d.statement.length > 1000 ||
        !['user-protected', 'delegated'].includes(String(d.authority)))) {
    throw new Error('Invalid Creative Direction proposal')
  }
  // Never rely on the model to label the author's words correctly. Preserve
  // the exact supplied brief/answers as protected canon, separately from the
  // model's own recommendations and delegated creative selections.
  const origin: Foundation['decisions'] = authorMessages.map((statement, index) => ({
    id: index === 0 ? 'author-brief' : 'author-answer-' + index,
    statement, origin: 'user', authority: 'user-protected',
  }))
  const selections: Foundation['decisions'] = input.decisions.map((d, i) => ({
    id: 'discovery-' + (i + 1), statement: d.statement.trim(), origin: 'agent',
    authority: d.authority === 'delegated' ? 'delegated' : 'user-protected',
  }))
  const foundation = { ...Object.fromEntries(fields.map(field => [field, (input[field] as string).trim()])),
    decisions: [...origin, ...selections] } as Foundation
  candidate(foundation)
  const contract = parseGenerationContract({
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
  })
  return { foundation, task: output.task.trim(), contract }
}
function parseResponse(text: string, authorMessages: string[]):
  { questions: string; proposal?: never } | { questions?: never; proposal: Proposal } {
  if (text.length > 24_000) throw new Error('Discovery reply exceeds the bounded conversation size')
  const clean = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')
  const output = JSON.parse(clean) as Record<string, unknown>
  if (output.phase === 'questions' && typeof output.questions === 'string' &&
      output.questions.trim().length > 5 && output.questions.length <= 6000) {
    return { questions: output.questions.trim() }
  }
  if (output.phase === 'proposal') return { proposal: expectedProposal(output, authorMessages) }
  throw new Error('Pi discovery did not produce questions or a valid proposal')
}
export type DiscoveryInference = (session: Session, instructions: string) => Promise<string>
async function realInference(store: StudioDatabase, owner: string, session: Session,
  instructions: string): Promise<string> {
  await assertUserPiSelection(store, owner, session.model)
  const runtime = await createUserPiRuntime(store, owner)
  const model = runtime.getModel(session.model.provider, session.model.id)
  if (!model) throw new Error('Selected model is unavailable')
  // The durable transcript is the conversation authority. A fresh, tool-less
  // Pi AgentSession receives that exact role-labelled transcript without a
  // host session directory, host settings, or a second mutable transcript.
  const settingsManager = SettingsManager.inMemory()
  const loader = new DefaultResourceLoader({ cwd: '/', agentDir: '/', settingsManager,
    systemPrompt: instructions, noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true })
  await loader.reload()
  const { session: agent } = await createAgentSession({ cwd: '/', agentDir: '/',
    modelRuntime: runtime, model, thinkingLevel: session.model.thinking,
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory('/'),
    noTools: 'all', tools: [] })
  const timer = setTimeout(() => { void agent.abort().catch(() => {}) }, 4 * 60_000)
  try {
    await agent.prompt(JSON.stringify({ conversation: session.turns }), { expandPromptTemplates: false })
    const last = [...agent.messages].reverse().find(item => item.role === 'assistant')
    if (!last || last.role !== 'assistant' || last.stopReason !== 'stop')
      throw new Error('Pi specialist did not finish')
    return agent.getLastAssistantText() ?? ''
  } finally { clearTimeout(timer); agent.dispose() }
}
async function skillInstructions(id: string) {
  const root = await openSkillSnapshot(id)
  const docs = ['nt-story-discovery/SKILL.md', 'nt-catalog/SKILL.md',
    'nt-catalog/references/records.md', 'nt-catalog/references/authority-and-validation.md',
    'nt-catalog/references/glossary.md']
  const sections = await Promise.all(docs.map(async path => {
    const content = await readFile(join(root, 'skills', path), 'utf8')
    if (content.length > 35000) throw new Error('Pinned discovery skill reference is too long')
    return '\n### ' + path + '\n' + content
  }))
  return `You are the NovelTea collaborative Story discovery specialist. Apply these exact, pinned
NovelTea skill instructions as your governing method. All skill reference material
was read by the trusted controller from a verified immutable snapshot. No file,
network, shell, or writable tool is available to this pre-bootstrap model.
Only create a minimum coherent Creative Direction, never a full Story.
Ask all currently answerable essential creative questions in a round, with numbered
recommendations and reasons. Both Autonomous and Collaborative authors need a coherent
initial baseline. If (and ONLY if) the author explicitly delegates all remaining
choices and asks not to be questioned, propose the minimum baseline immediately.
Respect partially answered questions and explicit delegations; never ask for facts already provided. Do not invent user approvals.
Use the user's full conversation to decide missing prerequisites.
When decisions are ready, return a proposed foundation and task for explicit
human review, not an approval. Never assume user approval in your output.
Respond ONLY as valid JSON, either:
{"phase":"questions","questions":"numbered questions and recommendations"}
or {"phase":"proposal","task":"brief generation objective","foundation":{
"id":"lowercase-slug","title":"...","premise":"...","central_conflict":"...",
"genre":"...","tone":"...","player_experience":"...","scope":"...",
"body":"meaningful coherent narrative and production prose",
"decisions":[{"statement":"significant creative choice","authority":"user-protected"}]}}
Use authority 'delegated' ONLY for choices the author explicitly delegated.
All model-origin proposals remain subject to author approval; the controller
will preserve the author's exact messages as a separate protected decision.
A model suggestion is not the author's original decision.
Do not use Markdown fences or extra text.
\nPINNED SKILLS:\n${sections.join('\n')}`
}
async function load(store: StudioDatabase, owner: string, repo: string, workspace: string): Promise<Session | null> {
  const row = await store.persistence.onboarding.conversation(owner, repo, workspace)
  if (!row) return null
  const state = JSON.parse(row.state) as Session
  if (row.revision !== state.revision) throw new DiscoveryError(409, 'Discovery revision is inconsistent')
  return state
}
async function save(store: StudioDatabase, owner: string, repo: string, workspace: string,
  state: Session, previous: number | null): Promise<void> {
  const changed = await store.persistence.onboarding.saveConversation(
    owner, repo, workspace, state.revision, JSON.stringify(state), previous, new Date().toISOString())
  if (!changed) throw new DiscoveryError(409, 'Discovery changed concurrently. Reload the conversation.')
}
function authorMessages(state: Session) {
  return state.turns.filter(turn => turn.role === 'user').map(turn => turn.text)
}
async function input(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (!reader) throw new DiscoveryError(400, 'Missing discovery input')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 20_000) throw new DiscoveryError(413, 'Discovery input too long')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new DiscoveryError(400, 'Invalid discovery request') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError(400, 'Invalid discovery request')
  return value as Record<string, unknown>
}
export async function onboardingPiRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, baseURL: string, infer?: DiscoveryInference,
  chat?: ChatDiscoveryBinding): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    await store.assertReady()
    const actor = await requireUser(auth, request.headers)
    if (!actor) throw new DiscoveryError(401, 'Sign in required')
    const params = new URL(request.url).searchParams
    if (!chat && ([...params.keys()].some(key => !['repositoryId', 'workspace'].includes(key)) ||
        params.getAll('repositoryId').length !== 1 || params.getAll('workspace').length > 1 ||
        !UUID.test(params.get('repositoryId') ?? ''))) throw new DiscoveryError(400, 'Invalid repository/workspace')
    const repo = chat?.repositoryId ?? params.get('repositoryId')!
    // Commas are rejected by onboardingWorkspace, so external onboarding
    // cannot inspect or mutate the internal Story/Thread discovery namespace.
    const workspace = chat ? 'story-chat,' + chat.storyId + ',' + chat.firstTurnId :
      onboardingWorkspace(params.get('workspace') ?? '')
    const own = await store.persistence.repositories.get(actor.id, repo)
    if (!own) throw new DiscoveryError(404, 'Repository is not connected to this account')
    if (chat) {
      const story = await store.persistence.naturalStory.story(actor.id, chat.storyId)
      const message = await store.persistence.messages.owned(actor.id,
        'root:' + chat.firstTurnId, chat.firstTurnId)
      const membership = message ? await store.persistence.messages.membership(actor.id,
        'root:' + chat.firstTurnId) : null
      if (!story || membership?.storyId !== chat.storyId ||
          story.repositoryId !== repo || story.directory !== chat.directory ||
          story.headSha !== chat.sourceSha || !message ||
          message.content !== chat.originalObjective ||
          message.role !== 'user' || (message.jobId && message.jobId !== chat.firstTurnId) ||
          message.phase === 'cancelled')
        throw new DiscoveryError(409, 'Saved Story discovery identity or source revision changed')
    }
    const saved = await load(store, actor.id, repo, workspace)
    if (saved && (chat
      ? JSON.stringify(saved.chat) !== JSON.stringify(chat)
      : !!saved.chat))
      throw new DiscoveryError(409, 'Discovery is bound to another Story or source revision')
    const continuation = async (): Promise<ContinuationStatus | undefined> => {
      if (!chat || saved?.phase !== 'approved') return undefined
      const message = await store.persistence.messages.owned(actor.id,
        'root:' + chat.firstTurnId, chat.firstTurnId)
      const queue = await store.persistence.generation.queue.record(chat.firstTurnId)
      return queue?.phase === 'interrupted' ? { state: 'blocked',
        message: 'The original writer was interrupted. Inspect its saved execution.' } :
        queue ? { state: 'queued' } :
        message?.phase === 'finished' ? { state: 'completed' } :
        message?.phase === 'preparing' ? { state: 'pending' } :
        { state: 'blocked', message: 'Approved baseline is saved but execution is not admitted. Check Settings and continue.' }
    }
    if (request.method === 'GET')
      return reply({ session: saved ? scope(saved) : null, continuation: await continuation() })
    const data = await input(request)
    const action = data.action
    if (action === 'reconcile') {
      if (!saved || saved.phase !== 'running' || data.revision !== saved.revision ||
          !saved.startedAt || Date.now() - saved.startedAt < 10 * 60_000) {
        throw new DiscoveryError(409, 'Only a running turn older than ten minutes may be reconciled; refresh first')
      }
      // This is an explicit operator/author decision after the previous worker
      // may have died. It does not run any model or mutate a Story file. A
      // late former worker response cannot overwrite this CAS revision.
      const blocked: Session = { ...saved, phase: 'blocked', revision: saved.revision + 1 }
      await save(store, actor.id, repo, workspace, blocked, saved.revision)
      return reply({ session: scope(blocked) })
    }
    if (action === 'approve') {
      if (!saved || saved.phase !== 'proposed' || data.revision !== saved.revision ||
          data.digest !== saved.digest) throw new DiscoveryError(409, 'Proposal is stale or unavailable')
      const approved: Session = { ...saved, phase: 'approved', revision: saved.revision + 1,
        proposal: { ...saved.proposal!, foundation: {
          ...saved.proposal!.foundation, decisions: saved.proposal!.foundation.decisions.map(d =>
            d.origin === 'agent' && d.authority !== 'delegated'
              ? { ...d, authority: 'user-protected' as const } : d),
        } } }
      approved.digest = sha(approved.proposal)
      // Exact review is durable before any provider, worktree or queue effect.
      if (chat) await validateNewStory(candidate(approved.proposal!.foundation).file)
      await save(store, actor.id, repo, workspace, approved, saved.revision)
      const handoff = chat ? await continueApprovedStoryChat(auth, store,
        request.headers, baseURL, {
          chat, digest: approved.digest!, skillId: approved.skillId,
          model: approved.model, foundation: approved.proposal!.foundation,
        }) : undefined
      return reply({ session: scope(approved), continuation: handoff })
    }
    if (action === 'continue') {
      if (!chat || !saved || saved.phase !== 'approved' ||
          data.revision !== saved.revision || data.digest !== saved.digest)
        throw new DiscoveryError(409, 'Approved foundation continuation is stale or unavailable')
      const handoff = await continueApprovedStoryChat(auth, store, request.headers, baseURL, {
        chat, digest: saved.digest!, skillId: saved.skillId,
        model: saved.model, foundation: saved.proposal!.foundation,
      })
      return reply({ session: scope(saved), continuation: handoff })
    }
    if (!['start', 'answer', 'revise', 'retry'].includes(String(action))) throw new DiscoveryError(400, 'Invalid discovery action')
    if (action === 'start' && saved) throw new DiscoveryError(409, 'Discovery already exists. Resume it.')
    if (action === 'answer' && (!saved || saved.phase !== 'questions' ||
        data.revision !== saved.revision)) throw new DiscoveryError(409, 'Question round is stale or unavailable')
    if (action === 'revise' && (!saved || saved.phase !== 'proposed' ||
        data.revision !== saved.revision)) throw new DiscoveryError(409, 'Proposal is stale or unavailable')
    if (action === 'retry' && (!saved || saved.phase !== 'blocked' ||
        data.revision !== saved.revision)) throw new DiscoveryError(409, 'Blocked discovery revision has changed')
    if (action !== 'retry' && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000))
      throw new DiscoveryError(422, 'Provide a brief or answer (up to 4000 characters)')
    if (chat && action === 'start' && data.text !== chat.originalObjective)
      throw new DiscoveryError(409, 'First Story discovery must use the saved original author objective')
    if (action !== 'retry' && saved && saved.turns.length >= 16)
      throw new DiscoveryError(422, 'Discovery reached its safe turn limit')
    let session: Session
    if (action === 'start') {
      if (!validPiSelection(data.model)) throw new DiscoveryError(422, 'Select an available Pi model')
      await assertUserPiSelection(store, actor.id, data.model)
      const source = process.env.NT_STUDIO_SKILLS_SOURCE
      if (!source) throw new DiscoveryError(503, 'Configure NT_STUDIO_SKILLS_SOURCE for pinned NovelTea discovery')
      const snapshot = await createSkillSnapshot({
        discovery: 'explicit-only', novelteaSkills: source, requiredSkills: ['nt-story-discovery', 'nt-catalog'],
        skillDirs: [],
      })
      if (!snapshot) throw new DiscoveryError(503, 'NovelTea discovery skills are unavailable')
      session = { phase: 'running', revision: 1, model: data.model, skillId: snapshot.id,
        startedAt: Date.now(), brief: (data.text as string).trim(),
        turns: [{ role: 'user', text: (data.text as string).trim() }],
        ...(chat ? { chat } : {}) }
    } else {
      session = { ...saved!, phase: 'running', startedAt: Date.now(), revision: saved!.revision + 1,
        questions: undefined, proposal: undefined, digest: undefined,
        turns: action === 'retry' ? saved!.turns :
          [...saved!.turns, { role: 'user', text: (data.text as string).trim() }] }
    }
    // Durable in-flight reservation precedes provider invocation, preventing
    // duplicated model calls on concurrent requests and unsafe automatic replay
    // after a worker dies during a provider turn.
    await save(store, actor.id, repo, workspace, session, saved?.revision ?? null)
    try {
      const instructions = await skillInstructions(session.skillId)
      const invoke = infer ?? ((s: Session, i: string) => realInference(store, actor.id, s, i))
      let raw = await invoke(session, instructions)
      let outcome = parseResponse(raw, authorMessages(session))
      // A sparse initial author objective must solicit baseline questions even
      // in Autonomous mode. Give one bounded corrective model pass if it skipped
      // discovery; never fabricate questions or accept an unreviewed proposal.
      if (chat && session.turns.length === 1 && needsOpeningQuestions(session.brief) &&
          outcome.proposal) {
        raw = await invoke(session, instructions + '\nController requirement: the author has only ' +
          'supplied a sparse objective without comprehensive delegation. Your previous proposal ' +
          'skipped the required first baseline discovery questions. Return ONLY a questions ' +
          'response with the minimum necessary recommended questions, not a proposal.')
        outcome = parseResponse(raw, authorMessages(session))
        if (outcome.proposal) throw new Error('Required opening discovery questions were not supplied')
      }
      // The model proposes creative details, never replaces the original Turn's
      // objective or silently changes its requested scope.
      if (chat && outcome.proposal) outcome.proposal.task = chat.originalObjective
      const next: Session = { ...session, phase: outcome.proposal ? 'proposed' : 'questions',
        revision: session.revision + 1, turns: [...session.turns, { role: 'assistant', text: raw }],
        ...(outcome.questions ? { questions: outcome.questions } : {}),
        ...(outcome.proposal ? { proposal: outcome.proposal, digest: sha(outcome.proposal) } : {}),
      }
      await save(store, actor.id, repo, workspace, next, session.revision)
      return reply({ session: scope(next) })
    } catch {
      // Never repeat an uncertain provider turn automatically or expose raw
      // model errors/credentials. Saved author input survives for inspection.
      const blocked = { ...session, phase: 'blocked' as const, revision: session.revision + 1 }
      try { await save(store, actor.id, repo, workspace, blocked, session.revision) } catch { /* preserve races */ }
      throw new DiscoveryError(503, 'Discovery turn did not complete. State preserved; inspect it before choosing a new conversation.')
    }
  } catch (error) {
    if (error instanceof DiscoveryError) return reply({ error: error.message }, error.status)
    return reply({ error: 'Pi discovery is unavailable. Verify the connected model, skills, native validator and application configuration.' }, 503)
  }
}

/** Server-side approval binding checked immediately before either provider's Git
 * mutation. The browser cannot replace a model-reviewed proposal with a forged
 * canonical record merely by submitting a different foundation object. */
export async function assertApprovedPiFoundation(store: StudioDatabase, owner: string, repo: string,
  workspace: string, reference: unknown, foundation: unknown): Promise<void> {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference))
    throw new DiscoveryError(409, 'Missing reviewed discovery approval')
  const ref = reference as Record<string, unknown>
  const session = await load(store, owner, repo, onboardingWorkspace(workspace))
  if (!session || session.phase !== 'approved' || session.revision !== ref.revision ||
      session.digest !== ref.digest || JSON.stringify(session.proposal?.foundation) !== JSON.stringify(foundation)) {
    throw new DiscoveryError(409, 'Approved Pi proposal does not match the selected repository, workspace or exact foundation')
  }
}

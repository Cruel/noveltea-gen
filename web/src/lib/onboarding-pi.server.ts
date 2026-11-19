import { createHash } from 'node:crypto'
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { onboardingWorkspace } from './onboarding.server'
import { createUserPiRuntime, assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import { createSkillSnapshot, openSkillSnapshot } from '../../../src/snapshot'
import { candidate, validateNewStory } from './story-foundation.server'
import { validStoryTitle } from './story-initialization-contract'
import { parseGenerationContract } from '../../../src/generation'
import { parseStoryPlanning, type StoryPlanning } from '../../../src/story-planning'
import { parsePlanningInterpretations, renderPlanningInterpretations,
  PlanningClarificationRequired, resolveDelegatedDecision,
  type PlanningEvidence, type PlanningInterpretation } from '../../../src/planning-interpretation'
import { authorQuestionDirection, authorQuestionOptions } from '../../../src/author-question'
import { parseProposedQuestionSet, parseQuestionDrafts, parseQuestionResponses,
  type QuestionSet, type QuestionResponse, type QuestionDraft } from '../../../src/author-question-set'
import { continueApprovedStoryChat, type ContinuationStatus, type ProviderJobGateways } from './story-approved-continuation.server'
import { createDiscoveryEvidence, type DiscoveryEvidence } from './discovery-evidence.server'
import { discoverySemanticPacket, discoverySemanticReviewInstructions,
  parseDiscoverySemanticVerdict, discoverySemanticFailures, discoverySemanticDigest,
  discoverySemanticCorrection } from '../../../src/discovery-semantic-review'

type Turn = { role: 'user' | 'assistant'; text: string; source?: 'question-set' }
type Foundation = {
  id: string; title: string; premise: string; central_conflict: string; genre: string
  tone: string; player_experience: string; scope: string; body: string
  planning?: StoryPlanning
  decisions: Array<{ id: string; statement: string; origin: 'user' | 'agent'; authority: 'user-protected' | 'delegated' }>
}
type Proposal = { foundation: Foundation; task: string; contract: ReturnType<typeof parseGenerationContract>;
  interpretations: PlanningInterpretation[] }
/** A sparse objective is not an authorization to invent all of its missing
 * foundations. Even Autonomous mode must ask before advancing to a proposal.
 * A deliberate instruction to choose everything without questions is different. */
function explicitFullDelegation(brief: string): boolean {
  return /\b(?:decide|choose|invent|make up|delegate|leave)\b[\s\S]{0,90}\b(?:everything|all|remaining|the rest|every detail|every choice|every decision)\b/i.test(brief) &&
    /\b(?:do not ask|don't ask|no questions|without questions|no need to ask)\b/i.test(brief)
}
function needsOpeningQuestions(brief: string): boolean {
  // A long plot synopsis can still omit the player-experience and production
  // baseline. Length alone is not evidence that these requirements were settled.
  const dimensions = [
    /\b(choice|decision|interactive|no choices|dialogue.only|linear)\b/i,
    /\b(branch|divergen|exclusive|route|ending|linear)\w*/i,
    /\b(puzzle|investigat|explorat|no puzzles)\w*/i,
    /\b(pacing|dialogue.led|narrative.led|exploration.led|balanced)\b/i,
    /\b(\d+\s*(minute|hour|min|hr)s?|playtime|playthrough|duration)\b/i,
    /\b(art|artwork|budget|illustrat|background|variant|reuse)\w*/i,
  ]
  const missing = dimensions.some(dimension => !dimension.test(brief))
  return missing && !explicitFullDelegation(brief)
}
type Phase = 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'
/** Trusted Story Chat identity. The reserved persistence namespace is inaccessible
 * to the legacy repository onboarding endpoint. No client may supply this binding. */
export type ChatDiscoveryBinding = {
  storyId: string; firstTurnId: string; repositoryId: string; directory: string
  sourceSha: string; originalObjective: string
}
type Session = { phase: Phase; revision: number; model: PiSelection; skillId: string; brief: string;
  questionContract?: 'structured-v1';
  turns: Turn[]; questions?: string | QuestionSet; proposal?: Proposal; digest?: string; startedAt?: number;
  drafts?: Record<string, QuestionDraft>;
  accepted?: Array<{ setId: string; setRevision: number; principal: string;
    submittedAt: string; questions: QuestionSet['questions']; responses: QuestionResponse[] }>;
  chat?: ChatDiscoveryBinding;
  /** Private controller evidence pointers; deliberately excluded from scope(). */
  discoveryEvidencePaths?: string[];
  /** Exact proposal/reviewer digest binding, never included in API projection. */
  semanticReview?: { proposalDigest: string; packetDigest: string; verdictDigest: string } }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reply = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
class DiscoveryError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
class DiscoverySemanticRejection extends Error {
  constructor(readonly correction: string) {
    super('Independent discovery review found unsupported or uncertain source scope.')
  }
}
function scope(input: Session) {
  return { phase: input.phase, revision: input.revision, model: input.model,
    turns: input.turns, questions: input.questionContract === 'structured-v1' &&
      input.questions && typeof input.questions !== 'string' ? input.questions : null,
    legacyQuestions: input.questionContract !== 'structured-v1' && input.phase !== 'approved',
    drafts: input.drafts ?? {}, accepted: input.accepted ?? [], proposal: input.proposal ?? null,
    digest: input.digest ?? null, skillId: input.skillId, startedAt: input.startedAt ?? null,
    ...(input.chat ? { chat: input.chat } : {}) }
}
export type DiscoverySessionView = ReturnType<typeof scope>
function expectedProposal(value: unknown, evidence: PlanningEvidence[], newStoryChat: boolean,
  delegationAuthorized: boolean): Proposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed discovery reply')
  const output = value as Record<string, unknown>
  if (!output.foundation || typeof output.foundation !== 'object' || Array.isArray(output.foundation) ||
      typeof output.task !== 'string' || !output.task.trim() || output.task.length > 4000) {
    throw new Error('Missing proposed foundation or task')
  }
  const input = output.foundation as Record<string, unknown>
  if (!validStoryTitle(input.title)) throw new Error('Invalid proposed Story title')
  const fields = ['id', 'title', 'premise', 'central_conflict', 'genre', 'tone', 'player_experience', 'scope', 'body']
  if (fields.some(field => typeof input[field] !== 'string' || !(input[field] as string).trim() ||
      (input[field] as string).length > (field === 'body' ? 12000 : field === 'title' ? 120 : 4000)) ||
      !Array.isArray(input.decisions) || input.decisions.length > 12 ||
      input.decisions.some(d => !d || typeof d !== 'object' || typeof d.statement !== 'string' ||
        !d.statement.trim() || d.statement.length > 1000 ||
        !['user-protected', 'delegated'].includes(String(d.authority)))) {
    throw new Error('Invalid Creative Direction proposal')
  }
  if (!delegationAuthorized &&
      input.decisions.some(d => d.authority === 'delegated'))
    throw new Error('Proposed Studio decisions lack an author delegation')
  // Never rely on the model to label the author's words correctly. Preserve
  // the exact supplied brief/answers as protected canon, separately from the
  // model's own recommendations and delegated creative selections.
  const origin: Foundation['decisions'] = evidence.map(item => ({
    id: item.decisionId, statement: item.statement,
    origin: 'user', authority: 'user-protected',
  }))
  const selections: Foundation['decisions'] = input.decisions.map((d, i) => {
    if (d.authority !== 'delegated' && d.source !== undefined)
      throw Error('An un-delegated Studio suggestion cannot claim author-source authority.')
    const source = d.authority === 'delegated'
      ? resolveDelegatedDecision(d.source, evidence, d.statement) : null
    return { id: 'discovery-' + (i + 1),
      statement: d.statement.trim() + (source
        ? ' (Studio choice authorized by Creative Decision ' + source.decisionId + ')' : ''),
      origin: 'agent', authority: d.authority === 'delegated' ? 'delegated' : 'user-protected' }
  })
  if (newStoryChat && input.planning === undefined)
    throw Error('New Story discovery requires a complete, source-backed planning baseline.')
  const planning = input.planning === undefined ? undefined : parseStoryPlanning(input.planning, newStoryChat)
  const interpretations = planning ? parsePlanningInterpretations(output.interpretations,
    planning, evidence, newStoryChat) : []
  if (!planning && output.interpretations !== undefined)
    throw Error('Planning interpretations require actual Story planning metadata.')
  const foundation = { ...Object.fromEntries(fields.map(field => [field, (input[field] as string).trim()])),
    ...(planning ? { planning } : {}),
    body: (input.body as string).trim() + renderPlanningInterpretations(interpretations, evidence),
    decisions: [...origin, ...selections] } as Foundation
  candidate(foundation)
  const contract = parseGenerationContract({
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
  })
  return { foundation, task: output.task.trim(), contract, interpretations }
}
function parseResponse(text: string, evidence: PlanningEvidence[], newStoryChat: boolean,
  delegationAuthorized = false):
  { questions: { questions: unknown }; proposal?: never } | { questions?: never; proposal: Proposal } {
  if (text.length > 24_000) throw new Error('Discovery reply exceeds the bounded conversation size')
  const clean = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')
  const output = JSON.parse(clean) as Record<string, unknown>
  if (output.phase === 'questions') {
    if (Object.keys(output).some(key => !['phase', 'questions'].includes(key)))
      throw new Error('Question proposal contains unsupported authority fields')
    if (output.questions && typeof output.questions === 'object' &&
        !Array.isArray(output.questions)) return { questions: output.questions as { questions: unknown } }
  }
  if (output.phase === 'proposal') return { proposal: expectedProposal(output, evidence,
    newStoryChat, delegationAuthorized) }
  throw new Error('Story discovery did not produce questions or a valid proposal')
}
/** Model-visible feedback must come from the trusted schema validator, never
 * include arbitrary provider errors, private session text or exception stacks. */
function discoveryCorrectionFeedback(error: unknown): string {
  if (error instanceof DiscoverySemanticRejection) return error.correction
  const reason = error instanceof Error ? error.message : ''
  if (reason === 'Invalid author-question recommendation.' ||
      reason === 'A free-text question cannot force suggested alternatives.') {
    return 'Invalid Question Set recommendation: for a free-text question omit ' +
      'recommendedId and recommendationReason; use only an optional placeholder. ' +
      'For alternatives/multiple-choice, include a recommendedId matching one of ' +
      'the offered option IDs before adding recommendationReason. For yes-no, ' +
      'recommendedId may only be yes or no. Never supply recommendationReason alone.'
  }
  if (reason === 'Recommended solution must be one of the offered alternatives.')
    return 'Each recommendedId must exactly match an option ID within that question.'
  if (reason === 'Discovery questions cannot request protected authority')
    return 'Only request creative preferences, not approval, permission, authorization or protected-canon changes.'
  if (reason === 'An author question requires 2–8 valid alternatives.' ||
      reason === 'Author alternatives need unique IDs, concise titles and bounded optional detail.')
    return 'Alternatives and multiple-choice questions require 2–8 options with unique lowercase-dash IDs and concise titles.'
  return 'The structured response did not satisfy the required Question Set, Creative Direction JSON or source-grounded planning contract.'
}
export type DiscoveryInference = (session: Session, instructions: string,
  kind?: 'discovery' | 'semantic-review') => Promise<string>
async function realInference(store: StudioDatabase, owner: string, session: Session,
  instructions: string, evidence: DiscoveryEvidence,
  payload?: object, validateReviewFormat?: (raw: string) => void):
  Promise<{ text: string; piSessionFile?: string }> {
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
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.create('/', evidence.piDirectory),
    noTools: 'all', tools: [] })
  const timer = setTimeout(() => { void agent.abort().catch(() => {}) }, 4 * 60_000)
  try {
    await agent.prompt(JSON.stringify(payload ?? { conversation: session.turns,
      planningSources: authorEvidence(session).map(({ source, decisionId, statement, authorText, selectedOption, delegated }) =>
        ({ source, decisionId, statement, authorText, selectedOption, delegated })) }), { expandPromptTemplates: false })
    for (let attempt = 0; attempt < (validateReviewFormat ? 3 : 1); attempt++) {
      const last = [...agent.messages].reverse().find(item => item.role === 'assistant')
      if (!last || last.role !== 'assistant' || last.stopReason !== 'stop')
        throw new Error('Pi specialist did not finish')
      const text = agent.getLastAssistantText() ?? ''
      try {
        validateReviewFormat?.(text)
        return { text, piSessionFile: agent.sessionManager.getSessionFile() ?? undefined }
      } catch (error) {
        if (attempt === 2) throw error
        // Protocol-format repair stays in the same independent, read-only Pi
        // conversation. Never retry the original creative assignment here.
        await agent.prompt('Independent read-only review FORMAT correction: your previous ' +
          'JSON assessments were invalid. Keep the exact review packet and unchanged ' +
          'review criteria. Return only one complete JSON object with assessments ' +
          'for EVERY claim ID and exact keys claimId, verdict, reason. Verdict is ' +
          'supported, unsupported or uncertain; no omitted or invented IDs.',
        { expandPromptTemplates: false })
      }
    }
    throw Error('Independent discovery review format exhausted')
  } finally {
    clearTimeout(timer)
    try {
      const piSessionFile = agent.sessionManager.getSessionFile()
      if (piSessionFile) {
        try { await chmod(piSessionFile, 0o600) }
        catch (error) {
          // Pi allocates a path before the first prompt has been persisted.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } finally { agent.dispose() }
  }
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
For a NEW Story, elicit a compact set of genuinely missing requirements: Choice frequency/impact,
branch depth and amount of route-exclusive content, adventure vs custom Puzzle emphasis,
Narrative vs Exploration pacing, single-route first-playthrough minute range, and
production limits for distinct illustration concepts/variants and Character art tiers.
Distinguish hard limits from soft preferences, never invent author numeric demands,
and include a recommendation for each missing choice. A no-Puzzle dialogue-led VN
is fully valid; neither 3 Acts nor uniform Milestone Choice/Puzzle counts are required.
Ask all currently answerable essential creative questions in a round, with recommendations
and reasons. Questions in one batch MUST be independently answerable; ask dependent
questions only in a subsequent round. Both Autonomous and Collaborative authors need a coherent
initial baseline. If (and ONLY if) the author explicitly delegates all remaining
choices and asks not to be questioned, propose the minimum baseline immediately.
Interpret natural preferences using the existing categorical StoryPlanning fields, not invented
numeric preferences: for example 'somewhat linear, but not too much' implies shallow
branching and limited route exclusivity, not a choice frequency. Preserve the exact
wording as an author source. If author requirements contradict, or credible competing
interpretations would materially change the Story, return a focused follow-up Question
Set rather than proposing an arbitrary resolution. Do not invent author hard budgets.
Respect partially answered questions and explicit delegations; never ask for facts already provided. Do not invent user approvals.
Use the user's full conversation to decide missing prerequisites.
When decisions are ready, return a proposed foundation and task for explicit
human review, not an approval. Never assume user approval in your output.
Respond ONLY as valid JSON, either:
{"phase":"questions","questions":{"questions":[{"id":"story-tone","kind":"alternatives","question":"Which tone should shape the story?","options":[{"id":"uneasy","title":"Uneasy"},{"id":"hopeful","title":"Hopeful"}],"recommendedId":"uneasy","recommendationReason":"Supports the mystery","allowStudioDecision":true},{"id":"duration","kind":"free-text","question":"How long should one playthrough take?","placeholder":"For example, 90–120 minutes","allowStudioDecision":true}]}}
or {"phase":"proposal","task":"brief generation objective","interpretations":[{"path":"branching.depth","source":{"kind":"answer","setId":"the trusted set id from planningSources","questionId":"branching"},"basis":"inferred","rationale":"A modest branch structure reflects the stated preference"}],"foundation":{
"id":"lowercase-slug","title":"...","premise":"...","central_conflict":"...",
"genre":"...","tone":"...","player_experience":"...","scope":"...",
"planning":{"choice_frequency":"occasional","choice_impact":"lasting",
"branching":{"depth":"shallow","route_exclusivity":"limited"},
"puzzle_emphasis":"adventure","pacing":"balanced",
"first_playthrough":{"min_minutes":90,"max_minutes":120},
"production":{"illustrated_backgrounds":{"count":{"max":6},"firmness":"soft"},
"background_variants":{"count":{"max":2},"firmness":"soft"},
"character_artwork":{"main":{"count":{"max":3},"firmness":"soft"}}}},
"body":"meaningful coherent narrative and production prose",
"decisions":[{"statement":"significant creative choice","authority":"delegated","source":{"kind":"answer","setId":"exact trusted set id","questionId":"exact delegated question id"}}]}}
The interpretations array above is also ILLUSTRATIVE: include EXACTLY ONE entry for EVERY
populated planning dimension (choice_frequency, choice_impact, branching.depth,
branching.route_exclusivity, puzzle_emphasis, pacing, first_playthrough, each
production budget, and any optional counts/concepts). A dimension's numeric/range
value comes exclusively from foundation.planning, not an extra value field in
interpretations. Each entry has ONLY path, source, basis ('explicit' only for a selected option with the literal
category value, 'inferred' for a normalized author preference, 'delegated' for an
explicitly delegated question), and a short concrete rationale. Source must be an
EXACT kind/index or kind/setId/questionId from the trusted planningSources input.
Never cite a sibling answer, missing question, or unsubmitted default. If the brief
explicitly delegated everything, its 'turn' source can support delegated values;
otherwise solicit missing baseline requirements instead of fabricating sources.
Store the final interpretation in the proposed Creative Direction for author review;
a model inference is not a verbatim protected instruction, and approval is separate.
The planning block is an ILLUSTRATIVE JSON SHAPE, not default numbers: use source-specific
approved/delegated values; new-Story proposals MUST include the complete planning core
and at least one hard/soft production bound. Optional counts/illustration concepts may
be omitted, but missing author requirements cannot be silently filled as protected facts.
For model-origin decisions with authority 'delegated', source is REQUIRED and must
identify the exact trusted delegated turn or Question Set answer. An ordinary
Studio proposal not based on delegation has authority 'user-protected' and NO
source; it remains visibly agent-origin until the author approves the exact proposal.
A narrowly delegated ending question cannot authorize unrelated Story details.
Use authority 'delegated' ONLY for choices the author explicitly delegated.
All model-origin proposals remain subject to author approval; the controller
will preserve the author's exact messages as a separate protected decision.
A model suggestion is not the author's original decision.
For questions: emit a JSON object with ONLY a questions array of 1–16
questions. Each question has a unique stable lowercase-dash ID; supported kinds
are alternatives, multiple-choice, yes-no, free-text. Choice kinds need 2–8
options with unique lowercase-dash IDs and concise titles; yes-no uses fixed
Yes/No options. A free-text question may provide a placeholder instead of options.
Include a recommendedId for option questions and a recommendationReason where
relevant. allowStudioDecision is only a request, NOT permission or authorization.
Never ask for approval of Creative Direction or permission to change protected
canon inside a Question Set; only the trusted exact approval gate can do that.
Structured author answers may be delegated; do not attribute a Studio decision
or inferred planning interpretation to the author as their exact words.
Do not depend on unanswered sibling questions.
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
/** The controller, not the model, owns stable source identities and verbatim
 * submitted author evidence (including explicit, authorized delegations). */
function authorEvidence(state: Session): PlanningEvidence[] {
  const messages = state.turns.filter(turn => turn.role === 'user' && turn.source !== 'question-set')
  const sources: PlanningEvidence[] = messages.map((turn, index) => ({
    source: { kind: 'turn', index }, decisionId: index === 0 ? 'author-brief' : 'author-answer-' + index,
    statement: turn.text, authorText: turn.text, selectedOption: false,
    delegated: index === 0 && explicitFullDelegation(turn.text),
  }))
  let index = sources.length
  for (const batch of state.accepted ?? []) for (const response of batch.responses) {
    const question = batch.questions.find(q => q.id === response.questionId)!
    const answer = response.answer
    const options = authorQuestionOptions(question)
    const selected = answer.kind === 'option'
      ? options.find(o => o.id === answer.optionId)?.title
      : answer.kind === 'multiple'
        ? [...answer.optionIds.map(id => options.find(o => o.id === id)?.title ?? id),
          ...(answer.text !== undefined ? [answer.text] : [])].join('; ')
        : answer.kind === 'custom' ? answer.text : 'Delegated to NovelTea Studio'
    sources.push({ source: { kind: 'answer', setId: batch.setId, questionId: response.questionId },
      decisionId: 'author-answer-' + index++, delegated: answer.kind === 'delegate',
      selectedOption: answer.kind === 'option', authorText: answer.kind === 'delegate' ? '' : selected + (answer.note ? ' — ' + answer.note : ''),
      statement: question.question + ' — Author ' + (answer.kind === 'delegate'
        ? 'explicitly delegated this question' : 'selected/wrote: ' + selected) +
        (answer.note ? ' — Additional instructions: ' + answer.note : ''),
    })
  }
  return sources
}
// A discovery Question Set accepts up to 16 independently bounded answers.
// Each answer may contain 4,000 UTF-16 code units of text and 1,000 of notes.
// JSON-escaped controls can consume six bytes per code unit: 16 * 5,000 * 6
// = 480,000 bytes before bounded identifiers and JSON metadata. Accommodate
// the maximum valid draft or response batch while rejecting excessive input
// before decoding, parsing or loading the entire request into memory.
const MAX_DISCOVERY_REQUEST_BYTES = 512_000
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
      if (bytes > MAX_DISCOVERY_REQUEST_BYTES)
        throw new DiscoveryError(413, 'Discovery input too long')
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
  chat?: ChatDiscoveryBinding, gateways: ProviderJobGateways = {}): Promise<Response> {
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
    if (action === 'draft') {
      if (!saved || saved.questionContract !== 'structured-v1' ||
          saved.phase !== 'questions' || !saved.questions || typeof saved.questions === 'string' ||
          data.revision !== saved.revision || data.setId !== saved.questions.id ||
          data.setRevision !== saved.questions.revision)
        throw new DiscoveryError(409, 'Question draft is stale. Reload before updating.')
      let drafts: Record<string, QuestionDraft>
      try { drafts = parseQuestionDrafts(saved.questions, data.drafts) }
      catch { throw new DiscoveryError(422, 'Invalid bounded Question Set draft.') }
      if (JSON.stringify(saved.drafts ?? {}) === JSON.stringify(drafts))
        return reply({ session: scope(saved) })
      const updated: Session = { ...saved, revision: saved.revision + 1, drafts }
      await save(store, actor.id, repo, workspace, updated, saved.revision)
      return reply({ session: scope(updated) })
    }
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
      if (!saved || saved.questionContract !== 'structured-v1' ||
          saved.phase !== 'proposed' || data.revision !== saved.revision ||
          !saved.digest || !/^[a-f0-9]{64}$/.test(saved.digest) ||
          data.digest !== saved.digest || !saved.semanticReview ||
          saved.semanticReview.proposalDigest !== saved.digest)
        throw new DiscoveryError(409, 'Proposal is stale or unavailable')
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
        }, gateways) : undefined
      return reply({ session: scope(approved), continuation: handoff })
    }
    if (action === 'continue') {
      if (!chat || !saved || saved.phase !== 'approved' ||
          data.revision !== saved.revision || data.digest !== saved.digest)
        throw new DiscoveryError(409, 'Approved foundation continuation is stale or unavailable')
      const handoff = await continueApprovedStoryChat(auth, store, request.headers, baseURL, {
        chat, digest: saved.digest!, skillId: saved.skillId,
        model: saved.model, foundation: saved.proposal!.foundation,
      }, gateways)
      return reply({ session: scope(saved), continuation: handoff })
    }
    if (!['start', 'answer', 'revise', 'retry', 'restart'].includes(String(action))) throw new DiscoveryError(400, 'Invalid discovery action')
    if (action === 'restart' && (!saved || data.revision !== saved.revision ||
        saved.questionContract === 'structured-v1' ||
        !['questions', 'blocked', 'proposed'].includes(saved.phase)))
      throw new DiscoveryError(409, 'Only an unsupported textual discovery session may be restarted.')
    if (action === 'start' && saved) throw new DiscoveryError(409, 'Discovery already exists. Resume it.')
    if (action === 'answer' && (!saved || saved.phase !== 'questions' ||
        data.revision !== saved.revision)) throw new DiscoveryError(409, 'Question round is stale or unavailable')
    if (action === 'revise' && (!saved || saved.questionContract !== 'structured-v1' ||
        saved.phase !== 'proposed' || data.revision !== saved.revision))
      throw new DiscoveryError(409, 'Proposal is stale or unavailable')
    if (action === 'retry' && (!saved || saved.questionContract !== 'structured-v1' ||
        saved.phase !== 'blocked' || data.revision !== saved.revision))
      throw new DiscoveryError(409, 'Blocked discovery revision changed or requires explicit restart')
    if (action === 'answer' && saved?.questionContract !== 'structured-v1')
      throw new DiscoveryError(409, 'Unsupported old question format. Restart discovery explicitly.')
    if (action !== 'retry' && action !== 'restart' && action !== 'answer' &&
        (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000))
      throw new DiscoveryError(422, 'Provide a brief or answer (up to 4000 characters)')
    if (chat && action === 'start' && data.text !== chat.originalObjective)
      throw new DiscoveryError(409, 'First Story discovery must use the saved original author objective')
    if (action !== 'retry' && action !== 'restart' && saved && saved.turns.length >= 16)
      throw new DiscoveryError(422, 'Discovery reached its safe turn limit')
    let session: Session
    if (action === 'start') {
      if (!validPiSelection(data.model)) throw new DiscoveryError(422, 'Select an available model')
      await assertUserPiSelection(store, actor.id, data.model)
      const source = process.env.NT_STUDIO_SKILLS_SOURCE
      if (!source) throw new DiscoveryError(503, 'Configure NT_STUDIO_SKILLS_SOURCE for pinned NovelTea discovery')
      const snapshot = await createSkillSnapshot({
        discovery: 'explicit-only', novelteaSkills: source, requiredSkills: ['nt-story-discovery', 'nt-catalog'],
        skillDirs: [],
      })
      if (!snapshot) throw new DiscoveryError(503, 'NovelTea discovery skills are unavailable')
      session = { phase: 'running', revision: 1, model: data.model, skillId: snapshot.id,
        questionContract: 'structured-v1',
        startedAt: Date.now(), brief: (data.text as string).trim(),
        turns: [{ role: 'user', text: chat?.originalObjective ?? (data.text as string).trim() }],
        ...(chat ? { chat } : {}) }
    } else if (action === 'restart') {
      session = { ...saved!, phase: 'running', startedAt: Date.now(),
        questionContract: 'structured-v1',
        revision: saved!.revision + 1, questions: undefined, drafts: undefined,
        accepted: undefined, proposal: undefined, digest: undefined,
        turns: [{ role: 'user', text: saved!.chat?.originalObjective ?? saved!.brief }] }
    } else {
      let userTurn: Turn | undefined
      let accepted = saved!.accepted
      if (action === 'answer') {
        const set = saved!.questions
        if (!set || typeof set === 'string' || data.setId !== set.id ||
            data.setRevision !== set.revision || data.text !== undefined)
          throw new DiscoveryError(409, 'Question Set identity or revision is stale.')
        let responses: QuestionResponse[]
        try { responses = parseQuestionResponses(set, data.responses) }
        catch { throw new DiscoveryError(422, 'Incomplete or invalid Question Set responses.') }
        accepted = [...(saved!.accepted ?? []), { setId: set.id, setRevision: set.revision,
          principal: 'user:' + actor.id, submittedAt: new Date().toISOString(),
          questions: set.questions, responses }]
        userTurn = { role: 'user', source: 'question-set', text: JSON.stringify({
          setId: set.id, responses: responses.map(response => ({
            questionId: response.questionId, kind: response.answer.kind,
            direction: authorQuestionDirection(set.questions.find(q => q.id === response.questionId)!,
              response.answer, set.questions.find(q => q.id === response.questionId)!.delegationAllowed === true),
              answer: response.answer,
          })) }) }
      } else if (action !== 'retry') userTurn = { role: 'user', text: (data.text as string).trim() }
      session = { ...saved!, phase: 'running', startedAt: Date.now(), revision: saved!.revision + 1,
        questions: undefined, drafts: undefined, proposal: undefined, digest: undefined,
        ...(accepted ? { accepted } : {}),
        turns: userTurn ? [...saved!.turns, userTurn] : saved!.turns }
    }
    // Durable in-flight reservation precedes provider invocation, preventing
    // duplicated model calls on concurrent requests and unsafe automatic replay
    // after a worker dies during a provider turn.
    await save(store, actor.id, repo, workspace, session, saved?.revision ?? null)
    let diagnosticStage = 'load-skills'
    let evidence: DiscoveryEvidence | null = null
    const evidencePaths: string[] = []
    try {
      const instructions = await skillInstructions(session.skillId)
      const invoke = async (prompt: string, stage: 'initial' | 'corrective' | 'opening-questions') => {
        // Production always records private evidence. Injected fixture replies
        // do so only when the test supplies an isolated evidence root.
        evidence = !infer || process.env.NT_DISCOVERY_EVIDENCE_DIR
          ? await createDiscoveryEvidence({ owner: actor.id, repositoryId: repo,
            workspace, revision: session.revision, stage, model: session.model,
            skillId: session.skillId, instructions: prompt }) : null
        if (evidence) evidencePaths.push(evidence.dir)
        try {
          const result = infer ? { text: await infer(session, prompt) } :
            await realInference(store, actor.id, session, prompt, evidence!)
          await evidence?.response(result.text, 'piSessionFile' in result ? result.piSessionFile : undefined)
          return result.text
        } catch (error) {
          await evidence?.inferenceError(error)
          throw error
        }
      }
      let lastSemanticReview: { packetDigest: string; verdictDigest: string } | undefined
      const reviewSemantics = async (raw: string, proposal: Proposal) => {
        // Exact identity and submission permission have already been checked
        // by expectedProposal()/parsePlanningInterpretations(). The independent
        // reviewer can only veto meaning; it cannot invent an author grant.
        const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')) as {
            foundation: { decisions: Array<{
              statement: string; authority: string; source?: import('../../../src/planning-interpretation').PlanningSource
            }> }
          }
        const packet = discoverySemanticPacket(session.brief, parsed.foundation.decisions,
          proposal.interpretations, authorEvidence(session), proposal.foundation)
        if (!packet.claims.length) {
          // No delegated or source-bound model assertions to assess. The author
          // still has to approve unbound proposals through the exact gate.
          lastSemanticReview = discoverySemanticDigest(packet, { assessments: [] })
          return
        }
        const instructions = discoverySemanticReviewInstructions
        const reviewerEvidence = !infer || process.env.NT_DISCOVERY_EVIDENCE_DIR
          ? await createDiscoveryEvidence({ owner: actor.id, repositoryId: repo, workspace,
            revision: session.revision, stage: 'semantic-review', model: session.model,
            skillId: session.skillId, instructions }) : null
        if (reviewerEvidence) evidencePaths.push(reviewerEvidence.dir)
        let output: string
        try {
          // A fresh Pi AgentSession and no tools; never the creative writer's
          // conversation, its tool state or a model-selected review packet.
          const result = infer ? { text: await infer(session,
            instructions + '\nREVIEW_PACKET_JSON:\n' + JSON.stringify(packet), 'semantic-review') } :
            await realInference(store, actor.id, session, instructions, reviewerEvidence!,
              { reviewPacket: packet }, raw => { parseDiscoverySemanticVerdict(raw, packet) })
          output = result.text
          await reviewerEvidence?.response(output,
            'piSessionFile' in result ? result.piSessionFile : undefined)
        } catch (error) {
          await reviewerEvidence?.inferenceError(error)
          throw error
        }
        try {
          const verdict = parseDiscoverySemanticVerdict(output, packet)
          if (discoverySemanticFailures(verdict).length)
            throw new DiscoverySemanticRejection(discoverySemanticCorrection(verdict))
          await reviewerEvidence?.validation('accepted')
          lastSemanticReview = discoverySemanticDigest(packet, verdict)
        } catch (error) {
          await reviewerEvidence?.validation('rejected', error)
          throw error
        }
      }
      const interpret = (raw: string, mandatoryClarification = false) => {
        const delegationAuthorized = explicitFullDelegation(session.brief) ||
          !!session.accepted?.some(batch => batch.responses.some(r => r.answer.kind === 'delegate'))
        const result = parseResponse(raw, authorEvidence(session), Boolean(chat), delegationAuthorized)
        if (result.questions) {
          const set = parseProposedQuestionSet(result.questions,
            sha({ binding: chat ? chat.firstTurnId : { repo, workspace },
              revision: session.revision + 1, proposal: result.questions }),
            session.revision + 1)
          // This trusted adapter authorizes delegation only for baseline creative
          // direction questions. It rejects authority/approval requests rather
          // than allowing a model to define its own approval workflow.
          if (set.questions.some(q => /\b(?:approve|approval|publish|consent|authorize|authorization|permission|protected canon|expand scope)\b/i
            .test([q.question, ...(q.options ?? []).map(o => o.title)].join(' '))))
            throw new Error('Discovery questions cannot request protected authority')
          return { questions: { ...set, questions: set.questions.map(q => ({ ...q,
            ...(q.allowStudioDecision === true && !mandatoryClarification
              ? { delegationAllowed: true as const } : {}),
          })) } }
        }
        return { proposal: result.proposal! }
      }
      const validateWithEvidence = async (raw: string, mandatoryClarification = false) => {
        try {
          const checked = interpret(raw, mandatoryClarification)
          if (checked.proposal) {
            diagnosticStage = 'semantic-review'
            await reviewSemantics(raw, checked.proposal)
          }
          await evidence?.validation('accepted')
          return checked
        } catch (error) {
          await evidence?.validation('rejected', error)
          throw error
        }
      }
      diagnosticStage = 'initial-inference'
      let raw = await invoke(instructions, 'initial')
      diagnosticStage = 'initial-response-validation'
      let corrected = false
      let outcome: ReturnType<typeof interpret>
      try { outcome = await validateWithEvidence(raw) }
      catch (error) {
        corrected = true
        const clarification = error instanceof PlanningClarificationRequired
        // Exactly one bounded correction. If the author has contradictory or
        // materially incompatible requirements, demand an actual new question,
        // not another unsupported proposal or an invented decision.
        diagnosticStage = 'corrective-inference'
        raw = await invoke(instructions + (clarification
          ? '\nController clarification required: ' + error.message +
            ' Return ONLY a focused structured Question Set requesting author direction. ' +
            'Do not choose for the author.'
          : '\nController correction: ' + discoveryCorrectionFeedback(error) +
            ' Return one complete valid structured Question Set or Creative Direction ' +
            'proposal with source-backed interpretations. Do not invent approvals ' +
            'or substitute prose questions.'), 'corrective')
        diagnosticStage = 'corrective-response-validation'
        outcome = await validateWithEvidence(raw, clarification)
        if (clarification && outcome.proposal)
          throw Error('A material planning contradiction requires a new author question.')
      }
      // A sparse initial author objective must solicit baseline questions even
      // in Autonomous mode. Give one bounded corrective model pass if it skipped
      // discovery; never fabricate questions or accept an unreviewed proposal.
      diagnosticStage = 'opening-question-requirement'
      if (chat && session.turns.length === 1 && needsOpeningQuestions(session.brief) &&
          outcome.proposal) {
        if (corrected) throw new Error('Discovery already exhausted its corrective model attempt')
        diagnosticStage = 'opening-question-inference'
        raw = await invoke(instructions + '\nController requirement: the author has only ' +
          'supplied a sparse objective without comprehensive delegation. Your previous proposal ' +
          'skipped the required first baseline discovery questions. Return ONLY a questions ' +
          'response with the minimum necessary recommended questions, not a proposal.', 'opening-questions')
        diagnosticStage = 'opening-question-validation'
        outcome = await validateWithEvidence(raw)
        if (outcome.proposal) throw new Error('Required opening discovery questions were not supplied')
      }
      // The model proposes creative details, never replaces the original Turn's
      // objective or silently changes its requested scope.
      if (chat && outcome.proposal) outcome.proposal.task = chat.originalObjective
      const next: Session = { ...session, phase: outcome.proposal ? 'proposed' : 'questions',
        revision: session.revision + 1, turns: [...session.turns, { role: 'assistant', text: raw }],
        ...(outcome.questions ? { questions: outcome.questions } : {}),
        ...(outcome.proposal ? { proposal: outcome.proposal, digest: sha(outcome.proposal),
          ...(lastSemanticReview ? { semanticReview: {
            proposalDigest: sha(outcome.proposal), ...lastSemanticReview } } : {}) } : {}),
        discoveryEvidencePaths: [...(session.discoveryEvidencePaths ?? []), ...evidencePaths],
      }
      diagnosticStage = 'persist-valid-response'
      await save(store, actor.id, repo, workspace, next, session.revision)
      return reply({ session: scope(next) })
    } catch (error) {
      // Explicit trusted local certification may classify a failing provider
      // turn without revealing error messages, transcript text or credentials.
      // The public response and durable ambiguity fence remain unchanged.
      if (process.env.NT_TEST_WEB_PI_DIAGNOSTIC === '1') {
        const name = error instanceof Error ? error.name : 'unknown'
        const message = error instanceof Error ? error.message : ''
        const cause = /429|rate.limit|quota/i.test(message) ? 'rate-limit'
          : /\b(?:401|403|unauthorized|forbidden|authentication|oauth|access.token|refresh.token|credential)\b/i.test(message) ? 'authentication'
          : /aborted|timeout/i.test(message) ? 'aborted'
          : /Pi specialist did not finish/i.test(message) ? 'incomplete-model-turn'
          : /JSON|proposal|discovery reply|questions|foundation/i.test(message) ? 'invalid-model-output'
          : /model|provider|api/i.test(message) ? 'provider'
          : 'other'
        const knownValidation = [
          'Discovery questions cannot request protected authority',
          'Invalid bounded discovery Question Set.',
          'Question IDs must be stable, unique and bounded.',
          'Invalid author-question request.',
          'Invalid bounded author question.',
          'Invalid requested Studio-decision policy.',
          'Author question context references must be bounded canonical Story locations.',
          'Invalid author-question placeholder.',
          'Invalid author-question recommendation.',
          'A free-text question cannot force suggested alternatives.',
          'A Yes/No question has fixed Yes/No/Other choices.',
          'An author question requires 2–8 valid alternatives.',
          'Author alternatives need unique IDs, concise titles and bounded optional detail.',
          'Recommended solution must be one of the offered alternatives.',
          'Question proposal contains unsupported authority fields',
          'Story discovery did not produce questions or a valid proposal',
          'Discovery already exhausted its corrective model attempt',
          'Required opening discovery questions were not supplied',
          'Pi specialist did not finish',
        ].find(value => message === value)
        console.error('Trusted local Story discovery failure:', JSON.stringify({
          name, cause: knownValidation ? 'invalid-model-output' : cause,
          stage: diagnosticStage,
          ...(evidencePaths.length ? { evidenceDirectory: evidencePaths.at(-1) } : {}),
          ...(knownValidation ? { validation: knownValidation } : {}),
        }))
      }
      // Never repeat an uncertain provider turn automatically or expose raw
      // model errors/credentials. Saved author input survives for inspection.
      const blocked: Session = { ...session, phase: 'blocked', revision: session.revision + 1,
        discoveryEvidencePaths: [...(session.discoveryEvidencePaths ?? []), ...evidencePaths] }
      try { await save(store, actor.id, repo, workspace, blocked, session.revision) } catch { /* preserve races */ }
      throw new DiscoveryError(503, 'Discovery turn did not complete. State preserved; inspect it before choosing a new conversation.')
    }
  } catch (error) {
    if (error instanceof DiscoveryError) return reply({ error: error.message }, error.status)
    return reply({ error: 'Story discovery is unavailable. Verify the connected model, discovery skills, validator and application configuration.' }, 503)
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
    throw new DiscoveryError(409, 'Approved discovery proposal does not match the selected repository, workspace or exact foundation')
  }
}

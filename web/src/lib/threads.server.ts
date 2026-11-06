import { randomUUID } from 'node:crypto'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import type { NavigationThreadRecord } from '../persistence/conversation-contracts'
import { compareActivity, latestActivity } from './thread-navigation'

export type ThreadStatus = 'prepared' | 'queued' | 'running' | 'paused' | 'needs-author' |
  'blocked' | 'completed' | 'cancelled' | 'archived'
export type StoryThread = {
  id: string; conversationId: string; parentThreadId: string | null; title: string
  activityAt: string; createdAt: string; archivedAt: string | null
  status: ThreadStatus; currentWork: string | null; jobId: string | null
}
export type StoryConversation = {
  id: string; title: string; createdAt: string; updatedAt: string; activityAt: string
  threads: StoryThread[]
}
export type ThreadPreferences = { view: 'tree' | 'flat'; expandedIds: string[] }
export type StoryNavigation = {
  story: { id: string; title: string }
  conversations: StoryConversation[]
  preferences: ThreadPreferences
}

const MAX_TITLE = 120
const ID = /^[a-zA-Z0-9:_-]{1,128}$/
function titleValue(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid title.')
  const title = value.trim()
  if (!title || title.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title))
    throw new Error('Title must be 1–120 printable characters.')
  return title
}
async function selectedStory(store: StudioDatabase, owner: string, storyId: string) {
  const story = await store.persistence.conversations.story(owner, storyId)
  if (!story) throw new Error('Story not found.')
  return story
}

/** Backfill or reconcile jobs created before the Conversation registration hook.
 * Stable IDs and transactionally linked rows make GET idempotent across workers,
 * and never infer branchable historical checkpoints from those jobs. */
export async function ensureRootThreads(store: StudioDatabase, owner: string, storyId: string) {
  await store.persistence.conversations.reconcileRoots(owner, storyId)
}

type ThreadRow = NavigationThreadRecord
function threadStatus(row: ThreadRow): ThreadStatus {
  if (row.archivedAt) return 'archived'
  if (row.queuePhase === 'queued') return 'queued'
  if (row.queuePhase === 'running') return 'running'
  if (row.queuePhase === 'interrupted') return 'blocked'
  if (row.needsAuthor && (row.jobStatus === 'paused' || row.jobStatus === 'blocked')) return 'needs-author'
  if (row.jobStatus === 'paused') return row.requestJson ? 'paused' : 'prepared'
  if (row.jobStatus === 'running') return 'running'
  if (row.jobStatus === 'blocked') return 'blocked'
  if (row.jobStatus === 'completed') return 'completed'
  if (row.jobStatus === 'cancelled') return 'cancelled'
  return 'prepared'
}

export async function listStoryConversations(store: StudioDatabase, owner: string, storyId: string): Promise<StoryNavigation> {
  const story = await selectedStory(store, owner, storyId)
  await ensureRootThreads(store, owner, storyId)
  const { conversations: rows, threads: threadRows } =
    await store.persistence.conversations.navigation(owner, storyId)
  const grouped = new Map<string, StoryThread[]>()
  for (const row of threadRows) {
    const status = threadStatus(row)
    const activityAt = latestActivity([row.activityAt, row.queueAt, row.queueUpdatedAt, row.lastEventAt]
      .filter((value): value is string => !!value))
    const work = status === 'running' && row.workingStage
      ? row.workingStage.replaceAll('-', ' ').replace(/\b\w/g, char => char.toUpperCase()) +
        (row.workingMilestone ? ' · ' + row.workingMilestone : '') : null
    const threads = grouped.get(row.conversationId) ?? []
    threads.push({ id: row.id, conversationId: row.conversationId,
      parentThreadId: row.parentThreadId, title: row.title, activityAt,
      createdAt: row.createdAt, archivedAt: row.archivedAt, status,
      currentWork: work, jobId: row.jobId })
    grouped.set(row.conversationId, threads)
  }
  const conversations = rows.map(row => {
    const threads = grouped.get(row.id) ?? []
    const activityAt = latestActivity([row.createdAt, ...threads.map(thread => thread.activityAt)])
    return { ...row, activityAt, threads }
  }).sort((a, b) => compareActivity(b.activityAt, a.activityAt) || a.id.localeCompare(b.id))
  const prefs = await store.persistence.settings.getThreadPreferences(owner, storyId)
  return { story, conversations, preferences: prefs ?? { view: 'tree', expandedIds: [] } }
}

export async function createConversation(store: StudioDatabase, owner: string, storyId: string) {
  await selectedStory(store, owner, storyId)
  return store.persistence.conversations.create(owner, storyId, randomUUID(), new Date().toISOString())
}
export async function renameConversation(store: StudioDatabase, owner: string, conversationId: string, title: string) {
  const valid = titleValue(title)
  if (!await store.persistence.conversations.renameConversation(owner, conversationId, valid, new Date().toISOString()))
    throw new Error('Conversation not found.')
}
export async function renameThread(store: StudioDatabase, owner: string, threadId: string, title: string) {
  const valid = titleValue(title)
  if (!await store.persistence.conversations.renameThread(owner, threadId, valid))
    throw new Error('Thread not found.')
}
/** Archive remains only a reversible catalog flag: never touch writer state. */
async function setThreadArchive(store: StudioDatabase, owner: string, id: string, archived: boolean): Promise<void> {
  if (!await store.persistence.conversations.archiveThread(owner, id, archived, new Date().toISOString()))
    throw new Error('Thread not found.')
}

export async function archiveThread(store: StudioDatabase, owner: string, id: string): Promise<void> {
  await setThreadArchive(store, owner, id, true)
}

export async function restoreThread(store: StudioDatabase, owner: string, id: string): Promise<void> {
  await setThreadArchive(store, owner, id, false)
}

export async function saveThreadPreferences(store: StudioDatabase, owner: string, storyId: string,
  view: 'tree' | 'flat', expandedIds: string[]) {
  await selectedStory(store, owner, storyId)
  if (!['tree', 'flat'].includes(view) || !Array.isArray(expandedIds) || expandedIds.length > 200 ||
      expandedIds.some(id => typeof id !== 'string' || !ID.test(id)))
    throw new Error('Invalid Thread preferences.')
  const unique = [...new Set(expandedIds)]
  await store.persistence.settings.putThreadPreferences(owner, storyId, view, unique, new Date().toISOString())
}

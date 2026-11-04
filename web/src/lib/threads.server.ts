import { randomUUID } from 'node:crypto'
import type { StudioDatabase } from '../db/connection'
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
function selectedStory(store: StudioDatabase, owner: string, storyId: string) {
  const story = store.sqlite.prepare(`SELECT id,title FROM stories WHERE id=? AND owner_user_id=?`)
    .get(storyId, owner) as { id: string; title: string } | undefined
  if (!story) throw new Error('Story not found.')
  return story
}

/** Backfill or reconcile jobs created before the Conversation registration hook.
 * Stable IDs and transactionally linked rows make GET idempotent across workers,
 * and never infer branchable historical checkpoints from those jobs. */
export function ensureRootThreads(store: StudioDatabase, owner: string, storyId: string) {
  store.sqlite.transaction(() => {
    store.sqlite.prepare(`INSERT OR IGNORE INTO story_conversations
      (id,owner_user_id,story_id,title,created_at,updated_at)
      SELECT 'legacy:' || j.id,j.owner_user_id,j.story_id,j.title,j.created_at,j.created_at
      FROM studio_sessions j
      WHERE j.owner_user_id=? AND j.story_id=? AND NOT EXISTS
        (SELECT 1 FROM story_thread_runs r WHERE r.job_id=j.id)`).run(owner, storyId)
    store.sqlite.prepare(`INSERT OR IGNORE INTO story_threads
      (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
      SELECT 'root:' || j.id,j.owner_user_id,'legacy:' || j.id,NULL,j.title,j.created_at,j.created_at
      FROM studio_sessions j
      WHERE j.owner_user_id=? AND j.story_id=? AND NOT EXISTS
        (SELECT 1 FROM story_thread_runs r WHERE r.job_id=j.id)`).run(owner, storyId)
    store.sqlite.prepare(`INSERT OR IGNORE INTO story_thread_runs
      (job_id,owner_user_id,thread_id,run_order)
      SELECT j.id,j.owner_user_id,'root:' || j.id,0
      FROM studio_sessions j
      WHERE j.owner_user_id=? AND j.story_id=? AND NOT EXISTS
        (SELECT 1 FROM story_thread_runs r WHERE r.job_id=j.id)`).run(owner, storyId)
  })()
}

type ThreadRow = {
  id: string; conversationId: string; parentThreadId: string | null; title: string
  activityAt: string; archivedAt: string | null; createdAt: string
  jobId: string | null; jobStatus: string | null; requestJson: string | null
  queuePhase: string | null; queueAt: string | null; queueUpdatedAt: string | null
  lastEventAt: string | null; workingStage: string | null; workingMilestone: string | null
  needsAuthor: number | null
}
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

export function listStoryConversations(store: StudioDatabase, owner: string, storyId: string): StoryNavigation {
  const story = selectedStory(store, owner, storyId)
  ensureRootThreads(store, owner, storyId)
  const rows = store.sqlite.prepare(`SELECT id,title,created_at AS createdAt,updated_at AS updatedAt
    FROM story_conversations WHERE owner_user_id=? AND story_id=?`).all(owner, storyId) as
    Array<Omit<StoryConversation, 'threads' | 'activityAt'>>
  const threadRows = store.sqlite.prepare(`SELECT
    t.id,t.conversation_id AS conversationId,t.parent_thread_id AS parentThreadId,
    t.title,t.activity_at AS activityAt,t.archived_at AS archivedAt,t.created_at AS createdAt,
    run.job_id AS jobId,run.needs_author AS needsAuthor,
    j.status AS jobStatus,j.generation_request_json AS requestJson,
    q.phase AS queuePhase,q.created_at AS queueAt,q.updated_at AS queueUpdatedAt,
    (SELECT MAX(e.created_at) FROM generation_events e
      WHERE e.job_id=run.job_id AND e.owner_user_id=t.owner_user_id) AS lastEventAt,
    (SELECT e.stage FROM generation_events e WHERE e.job_id=run.job_id
      AND e.owner_user_id=t.owner_user_id AND e.kind='working'
      AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
        WHERE started.job_id=run.job_id AND started.owner_user_id=t.owner_user_id
          AND started.kind='started'), 0)
      ORDER BY e.id DESC LIMIT 1) AS workingStage,
    (SELECT e.milestone FROM generation_events e WHERE e.job_id=run.job_id
      AND e.owner_user_id=t.owner_user_id AND e.kind='working'
      AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
        WHERE started.job_id=run.job_id AND started.owner_user_id=t.owner_user_id
          AND started.kind='started'), 0)
      ORDER BY e.id DESC LIMIT 1) AS workingMilestone
    FROM story_threads t
    JOIN story_conversations c ON c.id=t.conversation_id AND c.owner_user_id=t.owner_user_id
    LEFT JOIN story_thread_runs run ON run.thread_id=t.id AND run.owner_user_id=t.owner_user_id
      AND run.run_order=(SELECT MAX(r2.run_order) FROM story_thread_runs r2
        WHERE r2.thread_id=t.id AND r2.owner_user_id=t.owner_user_id)
    LEFT JOIN studio_sessions j ON j.id=run.job_id AND j.owner_user_id=t.owner_user_id
    LEFT JOIN generation_run_queue q ON q.job_id=run.job_id AND q.owner_user_id=t.owner_user_id
    WHERE t.owner_user_id=? AND c.story_id=?`).all(owner, storyId) as ThreadRow[]
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
  const prefs = store.sqlite.prepare(`SELECT view_mode AS view,expanded_ids_json AS expanded
    FROM story_thread_preferences WHERE owner_user_id=? AND story_id=?`)
    .get(owner, storyId) as { view: 'tree' | 'flat'; expanded: string } | undefined
  return { story, conversations, preferences: prefs
    ? { view: prefs.view, expandedIds: JSON.parse(prefs.expanded) as string[] }
    : { view: 'tree', expandedIds: [] } }
}

export function createConversation(store: StudioDatabase, owner: string, storyId: string) {
  selectedStory(store, owner, storyId)
  const id = randomUUID(), now = new Date().toISOString()
  const count = (store.sqlite.prepare(`SELECT count(*) AS total FROM story_conversations
    WHERE owner_user_id=? AND story_id=?`).get(owner, storyId) as { total: number }).total
  const title = 'New conversation' + (count ? ' ' + (count + 1) : '')
  store.sqlite.prepare(`INSERT INTO story_conversations
    (id,owner_user_id,story_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, owner, storyId, title, now, now)
  return { id, title }
}
export function renameConversation(store: StudioDatabase, owner: string, conversationId: string, title: string) {
  const valid = titleValue(title)
  if (store.sqlite.prepare(`UPDATE story_conversations SET title=?,updated_at=?
    WHERE id=? AND owner_user_id=?`).run(valid, new Date().toISOString(), conversationId, owner).changes !== 1)
    throw new Error('Conversation not found.')
}
export function renameThread(store: StudioDatabase, owner: string, threadId: string, title: string) {
  const valid = titleValue(title)
  if (store.sqlite.prepare(`UPDATE story_threads SET title=?
    WHERE id=? AND owner_user_id=?`).run(valid, threadId, owner).changes !== 1)
    throw new Error('Thread not found.')
}
export function saveThreadPreferences(store: StudioDatabase, owner: string, storyId: string,
  view: 'tree' | 'flat', expandedIds: string[]) {
  selectedStory(store, owner, storyId)
  if (!['tree', 'flat'].includes(view) || !Array.isArray(expandedIds) || expandedIds.length > 200 ||
      expandedIds.some(id => typeof id !== 'string' || !ID.test(id)))
    throw new Error('Invalid Thread preferences.')
  const unique = [...new Set(expandedIds)]
  store.sqlite.prepare(`INSERT INTO story_thread_preferences
    (owner_user_id,story_id,view_mode,expanded_ids_json,updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT(owner_user_id,story_id) DO UPDATE SET
    view_mode=excluded.view_mode,expanded_ids_json=excluded.expanded_ids_json,
    updated_at=excluded.updated_at`)
    .run(owner, storyId, view, JSON.stringify(unique), new Date().toISOString())
}

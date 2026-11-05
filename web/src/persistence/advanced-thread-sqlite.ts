import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { checkpointForks as forks, repositories, sessions, stories, storyConversations as conversations,
  storyThreadMessages as messages, storyThreadRuns as runs, storyThreads as threads,
  threadRestarts as restarts } from '../db/schema'
import type { AdvancedThreadPersistence, ForkInheritedMessage, ForkIntent,
  ForkReservation, NewThreadChild, RestartIntent, RestartReservation, ThreadIdentity } from './advanced-thread-contracts'
type Db = BetterSQLite3Database<typeof schema>
const conflict = (message: string): never => { throw new Error(message) }
const requireOwner = (owner: string) => {
  if (!owner) conflict('Authenticated owner required.')
}
const identityFields = {
  id: threads.id, parent: threads.parentThreadId, conversation: threads.conversationId,
  story: conversations.storyId, title: threads.title,
}
const editableFields = {
  id: messages.id, threadId: messages.threadId, sequence: messages.sequence,
  role: messages.role, status: messages.status, body: messages.body, phase: messages.phase,
  jobId: messages.jobId, sourceJobId: messages.sourceJobId, origin: messages.originMessageId,
}
const forkFields = {
  owner: forks.ownerUserId, source: forks.sourceJobId, base: forks.sourceBaseSha,
  commitSha: forks.commitSha, bundle: forks.bundleJson, draft: forks.draftJson,
  sourceThreadId: forks.sourceThreadId, proofDigest: forks.proofDigest,
  guidance: forks.guidance, history: forks.historyJson,
  editedMessageId: forks.editedMessageId, editedBody: forks.editedBody,
}
const restartFields = {
  owner: restarts.ownerUserId, sourceThread: restarts.sourceThreadId,
  sourceJob: restarts.sourceJobId, rootJob: restarts.rootJobId,
  original: restarts.originalSha, mode: restarts.mode, selected: restarts.selectedSha,
  branch: restarts.targetBranch, draft: restarts.draftJson, preparedAt: restarts.preparedAt,
}
export function createSqliteAdvancedThreads(db: Db): AdvancedThreadPersistence {
  const identity = (owner: string, id: string): ThreadIdentity | null => {
    requireOwner(owner)
    return db.select(identityFields).from(threads).innerJoin(conversations, and(
      eq(conversations.id, threads.conversationId),
      eq(conversations.ownerUserId, threads.ownerUserId),
    )).where(and(eq(threads.id, id), eq(threads.ownerUserId, owner))).get() ?? null
  }
  const ancestor = (owner: string, id: string): ThreadIdentity | null => {
    const visited = new Set<string>()
    let row = identity(owner, id)
    for (let n = 0; n < 64; n++) {
      if (!row) return null
      if (visited.has(row.id)) conflict('Thread ancestry contains a cycle.')
      visited.add(row.id)
      if (!row.parent) return row
      row = identity(owner, row.parent)
    }
    throw new Error('Thread ancestry is too deep.')
  }
  const forkIntent = (id: string): ForkIntent | null =>
    db.select(forkFields).from(forks).where(eq(forks.childId, id)).get() ?? null
  const restartIntent = (id: string): RestartIntent | null =>
    db.select(restartFields).from(restarts).where(eq(restarts.childId, id)).get() ?? null
  const jobClaimed = (id: string) =>
    !!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get()
  const nextSequence = (threadId: string): number =>
    db.select({ next: sql<number>`COALESCE(MAX(${messages.sequence}),-1)+1` }).from(messages)
      .where(eq(messages.threadId, threadId)).get()!.next
  const writeHistory = (owner: string, threadId: string,
    inherited: ForkInheritedMessage[], guidance: string, at: string) => {
    let sequence = 0
    for (const row of inherited) {
      db.insert(messages).values({
        id: randomUUID(), ownerUserId: owner, threadId, sequence: sequence++,
        role: row.role, status: 'delivered', body: row.body, originMessageId: row.originId,
        verifiedCommitSha: row.verifiedSha, createdAt: row.createdAt,
      }).run()
    }
    if (guidance) db.insert(messages).values({
      id: 'guidance:' + threadId, ownerUserId: owner, threadId, sequence,
      role: 'user', status: 'queued', body: guidance, createdAt: at,
    }).run()
  }
  return {
    async importHistory(owner, threadId, history, guidance, at) {
      requireOwner(owner)
      db.transaction(() => {
        if (!identity(owner, threadId)) throw new Error('Thread not found.')
        if (nextSequence(threadId) !== 0)
          throw new Error('Fork history was already imported; do not rewrite immutable lineage.')
        writeHistory(owner, threadId, history, guidance, at)
      }, { behavior: 'immediate' })
    },
    async identity(owner, id) { return identity(owner, id) },
    async ancestor(owner, id) { return ancestor(owner, id) },
    async run(owner, threadId, position) {
      requireOwner(owner)
      return db.select({ jobId: runs.jobId }).from(runs).where(and(
        eq(runs.ownerUserId, owner), eq(runs.threadId, threadId),
      )).orderBy(position === 'first' ? asc(runs.runOrder) : desc(runs.runOrder)).limit(1).get() ?? null
    },
    async runOrder(owner, threadId, jobId) {
      requireOwner(owner)
      return db.select({ order: runs.runOrder }).from(runs).where(and(
        eq(runs.jobId, jobId), eq(runs.ownerUserId, owner), eq(runs.threadId, threadId),
      )).get()?.order ?? null
    },
    async repository(owner, storyId) {
      requireOwner(owner)
      return db.select({
        repositoryId: repositories.id, provider: repositories.provider,
        providerId: repositories.providerRepositoryId, repository: repositories.name,
        directory: stories.directory,
      }).from(stories).innerJoin(repositories, and(
        eq(stories.repositoryId, repositories.id), eq(stories.ownerUserId, repositories.ownerUserId),
      )).where(and(eq(stories.id, storyId), eq(stories.ownerUserId, owner))).get() ?? null
    },
    async sourceThread(owner, jobId) {
      requireOwner(owner)
      return db.select({ id: runs.threadId, conversation: threads.conversationId })
        .from(runs).innerJoin(threads, and(eq(threads.id, runs.threadId),
          eq(threads.ownerUserId, runs.ownerUserId)))
        .where(and(eq(runs.jobId, jobId), eq(runs.ownerUserId, owner))).get() ?? null
    },
    async jobClaimed(id) { return jobClaimed(id) },
    async forkIntent(id) { return forkIntent(id) },
    async reserveFork(data: ForkReservation) {
      requireOwner(data.owner)
      return db.transaction(() => {
        if (jobClaimed(data.childId) || restartIntent(data.childId))
          conflict('Child identity was assigned concurrently.')
        const source = db.select({ storyId: sessions.storyId, sha: sessions.sourceCommitSha })
          .from(sessions).where(and(eq(sessions.id, data.sourceJobId),
            eq(sessions.ownerUserId, data.owner))).get()
        const parent = identity(data.owner, data.sourceThreadId)
        if (!source || source.sha !== data.sourceBaseSha ||
            !parent || parent.story !== source.storyId)
          conflict('Checkpoint source Story, owner, or pinned baseline changed.')
        db.insert(forks).values({
          childId: data.childId, ownerUserId: data.owner, sourceJobId: data.sourceJobId,
          sourceBaseSha: data.sourceBaseSha, commitSha: data.commitSha,
          bundleJson: data.bundle, draftJson: data.draft, createdAt: data.at,
          sourceThreadId: data.sourceThreadId, proofDigest: data.proofDigest,
          guidance: data.guidance, historyJson: data.history,
          editedMessageId: data.editedMessageId ?? null, editedBody: data.editedBody ?? null,
        }).onConflictDoNothing().run()
        const receipt = forkIntent(data.childId)
        if (!receipt || receipt.owner !== data.owner || receipt.source !== data.sourceJobId ||
            receipt.base !== data.sourceBaseSha || receipt.commitSha !== data.commitSha ||
            receipt.sourceThreadId !== data.sourceThreadId ||
            receipt.proofDigest !== data.proofDigest || receipt.guidance !== data.guidance ||
            receipt.editedMessageId !== (data.editedMessageId ?? null) ||
            receipt.editedBody !== (data.editedBody ?? null) ||
            receipt.bundle !== data.bundle || receipt.draft !== data.draft ||
            receipt.history !== data.history)
          conflict('Child ID was reserved for a different checkpoint or edit.')
        return receipt!
      }, { behavior: 'immediate' })
    },
    async restartIntent(id) { return restartIntent(id) },
    async reserveRestart(data: RestartReservation) {
      requireOwner(data.owner)
      return db.transaction(() => {
        if (jobClaimed(data.childId) || forkIntent(data.childId))
          conflict('Child ID is already assigned to another operation.')
        const parent = identity(data.owner, data.sourceThread)
        const current = db.select({ storyId: sessions.storyId }).from(sessions).where(and(
          eq(sessions.id, data.sourceJob), eq(sessions.ownerUserId, data.owner))).get()
        const original = db.select({ storyId: sessions.storyId, sha: sessions.sourceCommitSha })
          .from(sessions).where(and(eq(sessions.id, data.rootJob),
            eq(sessions.ownerUserId, data.owner))).get()
        if (!parent || !current || !original || current.storyId !== parent.story ||
            original.storyId !== parent.story || original.sha !== data.original)
          throw new Error('Restart source Story or original pinned baseline changed.')
        const root = ancestor(data.owner, data.sourceThread)
        if (!root || root.conversation !== parent.conversation || root.story !== parent.story)
          throw new Error('Restart Thread ancestry changed.')
        const first = db.select({ id: runs.jobId }).from(runs).where(and(
          eq(runs.ownerUserId, data.owner), eq(runs.threadId, root.id),
        )).orderBy(asc(runs.runOrder)).limit(1).get()
        const latest = db.select({ id: runs.jobId }).from(runs).where(and(
          eq(runs.ownerUserId, data.owner), eq(runs.threadId, data.sourceThread),
        )).orderBy(desc(runs.runOrder)).limit(1).get()
        if (first?.id !== data.rootJob || latest?.id !== data.sourceJob)
          conflict('Restart pinned root or latest source run changed.')
        db.insert(restarts).values({
          childId: data.childId, ownerUserId: data.owner, sourceThreadId: data.sourceThread,
          sourceJobId: data.sourceJob, rootJobId: data.rootJob, originalSha: data.original,
          mode: data.mode, selectedSha: data.selected, targetBranch: data.branch,
          draftJson: data.draft, createdAt: data.at,
        }).onConflictDoNothing().run()
        const receipt = restartIntent(data.childId)
        if (!receipt || receipt.owner !== data.owner ||
            receipt.sourceThread !== data.sourceThread || receipt.sourceJob !== data.sourceJob ||
            receipt.rootJob !== data.rootJob || receipt.original !== data.original ||
            receipt.mode !== data.mode || receipt.selected !== data.selected ||
            receipt.branch !== data.branch || receipt.draft !== data.draft)
          conflict('Restart reservation changed concurrently.')
        return receipt!
      }, { behavior: 'immediate' })
    },
    async preparedRestart(owner, childId, threadId) {
      requireOwner(owner)
      return !!db.select({ id: runs.jobId }).from(runs).where(and(
        eq(runs.jobId, childId), eq(runs.ownerUserId, owner), eq(runs.threadId, threadId),
      )).get()
    },
    async registerChild(data: NewThreadChild) {
      requireOwner(data.owner)
      return db.transaction(() => {
        const parent = identity(data.owner, data.parentThreadId)
        if (!parent || parent.story !== data.storyId || parent.conversation !== data.conversationId)
          conflict('Child parent Story or Conversation identity changed.')
        const current = db.select({ storyId: sessions.storyId, owner: sessions.ownerUserId,
          commitSha: sessions.sourceCommitSha }).from(sessions)
          .where(eq(sessions.id, data.childId)).get()
        if (current) {
          if (current.owner !== data.owner || current.storyId !== data.storyId ||
              current.commitSha !== data.baseSha)
            conflict('Previously prepared child differs from the saved source.')
          const registration = db.select({ id: runs.jobId }).from(runs).where(and(
            eq(runs.jobId, data.childId), eq(runs.ownerUserId, data.owner),
            eq(runs.threadId, data.threadId),
          )).get()
          const registeredThread = identity(data.owner, data.threadId)
          if (!registration || !registeredThread ||
              registeredThread.parent !== data.parentThreadId ||
              registeredThread.story !== data.storyId ||
              registeredThread.conversation !== data.conversationId)
            conflict('Existing child has incomplete or changed lineage registration.')
          // Repeat requests are read-only: preserve the original preparedAt receipt.
          return { inserted: false, storyId: current.storyId, commitSha: current.commitSha }
        }
        if (data.kind === 'restart') {
          const saved = restartIntent(data.childId)
          if (!saved) throw new Error('Restart intent changed during preparation.')
          if (saved.owner !== data.owner || saved.selected !== data.baseSha ||
              saved.sourceThread !== data.parentThreadId || saved.preparedAt)
            conflict('Restart intent changed during preparation.')
          const latest = db.select({ id: runs.jobId }).from(runs).where(and(
            eq(runs.ownerUserId, data.owner), eq(runs.threadId, data.parentThreadId),
          )).orderBy(desc(runs.runOrder)).limit(1).get()
          const root = ancestor(data.owner, data.parentThreadId)
          const first = root && db.select({ id: runs.jobId }).from(runs).where(and(
            eq(runs.ownerUserId, data.owner), eq(runs.threadId, root.id),
          )).orderBy(asc(runs.runOrder)).limit(1).get()
          if (!root || root.story !== data.storyId || root.conversation !== data.conversationId ||
              first?.id !== saved.rootJob || latest?.id !== saved.sourceJob ||
              db.select({ sha: sessions.sourceCommitSha }).from(sessions).where(and(
                eq(sessions.id, saved.rootJob), eq(sessions.ownerUserId, data.owner),
              )).get()?.sha !== saved.original)
            conflict('Thread advanced during restart preparation. Refresh before restarting.')
        } else {
          const saved = forkIntent(data.childId)
          if (!saved) throw new Error('Fork intent changed during preparation.')
          if (saved.owner !== data.owner || saved.commitSha !== data.baseSha ||
              saved.sourceThreadId !== data.parentThreadId)
            conflict('Fork intent changed during preparation.')
          const source = db.select({ storyId: sessions.storyId, sha: sessions.sourceCommitSha })
            .from(sessions).where(and(eq(sessions.id, saved.source),
              eq(sessions.ownerUserId, data.owner))).get()
          if (!source || source.storyId !== data.storyId || source.sha !== saved.base)
            conflict('Fork source job changed before child registration.')
        }
        db.insert(sessions).values({
          id: data.childId, ownerUserId: data.owner, storyId: data.storyId, title: data.title,
          sourceCommitSha: data.baseSha, status: 'paused', createdAt: data.at,
          updatedAt: data.at, generationConfigJson: data.draft,
        }).run()
        db.insert(threads).values({
          id: data.threadId, ownerUserId: data.owner, conversationId: data.conversationId,
          parentThreadId: data.parentThreadId, title: data.title, activityAt: data.at,
          createdAt: data.at,
        }).run()
        db.insert(runs).values({
          jobId: data.childId, ownerUserId: data.owner, threadId: data.threadId, runOrder: 0,
        }).run()
        if (data.kind === 'fork' || data.kind === 'edit') {
          if (!data.history) conflict('Fork history snapshot is missing.')
          writeHistory(data.owner, data.threadId, data.history!, data.guidance ?? '', data.at)
          if (data.kind === 'edit') {
            if (!data.editedMessageId || !data.editedBody) conflict('Edited message receipt missing.')
            db.insert(messages).values({
              id: 'edit:' + data.childId, ownerUserId: data.owner, threadId: data.threadId,
              sequence: nextSequence(data.threadId), role: 'user', status: 'queued',
              body: data.editedBody!, originMessageId: data.editedMessageId,
              phase: 'queued', jobId: data.childId, createdAt: data.at,
            }).run()
          }
        }
        if (data.kind === 'restart') db.update(restarts).set({ preparedAt: data.at })
          .where(and(eq(restarts.childId, data.childId), eq(restarts.ownerUserId, data.owner),
            sql`${restarts.preparedAt} IS NULL`)).run()
        return { inserted: true, storyId: data.storyId, commitSha: data.baseSha }
      }, { behavior: 'immediate' })
    },
    async history(owner, threadId, beforeSequence, beforeRunOrder) {
      requireOwner(owner)
      return db.select({
        id: messages.id, role: messages.role, status: messages.status, body: messages.body,
        origin: messages.originMessageId, verifiedSha: messages.verifiedCommitSha,
        createdAt: messages.createdAt,
      }).from(messages).where(and(eq(messages.ownerUserId, owner),
        eq(messages.threadId, threadId),
        beforeSequence === undefined ? undefined : lt(messages.sequence, beforeSequence),
        beforeRunOrder === undefined ? undefined : sql`NOT EXISTS (
          SELECT 1 FROM story_thread_runs r WHERE r.job_id=${messages.jobId}
            AND r.owner_user_id=${messages.ownerUserId}
            AND r.thread_id=${messages.threadId} AND r.run_order > ${beforeRunOrder}
          )`,
      )).orderBy(asc(messages.sequence)).all()
    },
    async editable(owner, threadId, messageId) {
      requireOwner(owner)
      return db.select(editableFields).from(messages).innerJoin(threads, and(
        eq(threads.id, messages.threadId), eq(threads.ownerUserId, messages.ownerUserId),
      )).where(and(eq(messages.ownerUserId, owner), eq(messages.threadId, threadId),
        eq(messages.id, messageId))).get() ?? null
    },
    async origin(owner, messageId) {
      requireOwner(owner)
      return db.select(editableFields).from(messages).where(and(
        eq(messages.id, messageId), eq(messages.ownerUserId, owner),
      )).get() ?? null
    },
    async inheritedCount(owner, threadId, beforeSequence) {
      requireOwner(owner)
      return db.select({ total: count() }).from(messages).where(and(
        eq(messages.ownerUserId, owner), eq(messages.threadId, threadId),
        lt(messages.sequence, beforeSequence), eq(messages.status, 'delivered'),
        isNotNull(messages.verifiedCommitSha),
      )).get()?.total ?? 0
    },
    async runJobs(owner, threadId) {
      requireOwner(owner)
      return db.select({ jobId: runs.jobId }).from(runs).innerJoin(threads, and(
        eq(threads.id, runs.threadId), eq(threads.ownerUserId, runs.ownerUserId),
      )).where(and(eq(runs.ownerUserId, owner), eq(runs.threadId, threadId)))
        .orderBy(asc(runs.runOrder)).all().map(row => row.jobId)
    },
    async importAppliedMessage(owner, threadId, messageId, body, originalId, jobId, at) {
      requireOwner(owner)
      db.transaction(() => {
        if (db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).get()) return
        if (!identity(owner, threadId)) conflict('Thread not found.')
        db.insert(messages).values({
          id: messageId, ownerUserId: owner, threadId, sequence: nextSequence(threadId),
          role: 'user', status: 'delivered', body, originMessageId: 'author-update:' + originalId,
          phase: 'finished', jobId, createdAt: at,
        }).run()
      }, { behavior: 'immediate' })
    },
  }
}

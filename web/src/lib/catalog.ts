import { desc, eq } from 'drizzle-orm'
import type { StudioDatabase } from '../db/connection'
import { repositories, sessions, stories } from '../db/schema'

export function readUserDashboard(store: StudioDatabase, userId: string) {
  if (!userId) throw new Error('Authenticated actor required')
  const repoRows = store.db.select({
    id: repositories.id, name: repositories.name, provider: repositories.provider,
  }).from(repositories).where(eq(repositories.ownerUserId, userId)).all()
  const storyRows = store.db.select({
    id: stories.id, title: stories.title, repositoryId: stories.repositoryId,
  }).from(stories).where(eq(stories.ownerUserId, userId)).all()
  const sessionRows = store.db.select({
    id: sessions.id, storyId: sessions.storyId, title: sessions.title,
    status: sessions.status, updatedAt: sessions.updatedAt,
  }).from(sessions).where(eq(sessions.ownerUserId, userId))
    .orderBy(desc(sessions.updatedAt)).limit(20).all()
  return {
    repositories: repoRows,
    stories: storyRows,
    activeJobs: sessionRows.filter(row => row.status === 'running' || row.status === 'paused' || row.status === 'blocked'),
    recentSessions: sessionRows,
  }
}

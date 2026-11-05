/** Owner-scoped Studio persistence ports. Consumers await every operation so
 * a future remote PostgreSQL implementation can replace the local adapter.
 * The owner is always derived from the authenticated session, never input JSON.
 */
export type CatalogProvider = 'github' | 'gitlab'
export type DefaultModelPreference = {
  provider: string
  id: string
  thinking?: 'low' | 'medium' | 'high'
}
export type DashboardSnapshot = {
  repositories: Array<{ id: string; name: string; provider: CatalogProvider }>
  stories: Array<{ id: string; title: string; repositoryId: string;
    directory: string; commitSha: string | null }>
  activeJobs: DashboardJob[]
  recentSessions: DashboardJob[]
}
export type DashboardJob = {
  id: string; storyId: string; title: string
  status: 'running' | 'paused' | 'blocked' | 'completed' | 'cancelled'
  updatedAt: string
}
export interface DashboardCatalog {
  forOwner(ownerUserId: string): Promise<DashboardSnapshot>
}
export interface SettingsPreferences {
  /** Distinguish absent/SQL NULL from a corrupt JSON literal such as 'null'.
   * The caller validates the stored selection before using it. */
  getDefaultModel(ownerUserId: string): Promise<{ selection: unknown } | null>
  putDefaultModel(ownerUserId: string, model: DefaultModelPreference | null, updatedAt: string): Promise<void>
  listRepositories(ownerUserId: string): Promise<Array<{
    id: string; provider: CatalogProvider; name: string; connectionId: string | null
  }>>
  hasLegacyRepositories(ownerUserId: string, provider: CatalogProvider): Promise<boolean>
  getThreadPreferences(ownerUserId: string, storyId: string): Promise<{
    view: 'tree' | 'flat'; expandedIds: string[]
  } | null>
  putThreadPreferences(ownerUserId: string, storyId: string, view: 'tree' | 'flat',
    expandedIds: string[], updatedAt: string): Promise<void>
}
import type { GitIdentities, RepositoryCatalogWrites, StoryOnboarding, PiCredentialVault } from './git-contracts'
import type { GenerationPersistence } from './generation-contracts'
import type { ConversationCatalog } from './conversation-contracts'
import type { ThreadMessagePersistence } from './thread-message-contracts'
import type { AdvancedThreadPersistence } from './advanced-thread-contracts'
import type { SteeringPersistence } from './steering-contracts'
import type { ContinuationPersistence } from './continuation-contracts'
import type { ApprovalJobCatalog, ProtectedDecisionRecords, PublicationRecords,
  RevisionRecords } from './publication-contracts'

export interface StudioPersistence {
  dashboard: DashboardCatalog
  settings: SettingsPreferences
  git: GitIdentities
  repositories: RepositoryCatalogWrites
  onboarding: StoryOnboarding
  piCredentials: PiCredentialVault
  generation: GenerationPersistence
  conversations: ConversationCatalog
  messages: ThreadMessagePersistence
  advancedThreads: AdvancedThreadPersistence
  steering: SteeringPersistence
  continuation: ContinuationPersistence
  publications: PublicationRecords
  approvalJobs: ApprovalJobCatalog
  protectedDecisions: ProtectedDecisionRecords
  revisions: RevisionRecords
}

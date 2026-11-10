import type { SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import type { StudioPersistence } from './contracts'
import { createKyselyGitPersistence } from './git-kysely'
import { createKyselyNaturalStoryPersistence } from './natural-story-kysely'
import { createKyselyCollectionCatalog } from './collection-kysely'
import { createKyselyGenerationPersistence } from './generation-kysely'
import { createKyselyConversationCatalog } from './conversation-kysely'
import { createKyselyThreadMessages } from './thread-message-kysely'
import { createKyselyAdvancedThreads } from './advanced-thread-kysely'
import { createKyselySteeringPersistence } from './steering-kysely'
import { createKyselyContinuationPersistence } from './continuation-kysely'
import { createKyselyPublicationRecords } from './publication-kysely'
import { createKyselyApprovalRevisionPersistence } from './approval-revision-kysely'
import { createKyselyCatalogPersistence } from './catalog-kysely'

/** The sole Studio domain composition, independent of the selected SQL engine. */
export function createKyselyPersistence(db: SharedDatabase<StudioDb>): StudioPersistence {
  return {
    ...createKyselyGitPersistence(db),
    naturalStory: createKyselyNaturalStoryPersistence(db),
    collections: createKyselyCollectionCatalog(db),
    generation: createKyselyGenerationPersistence(db),
    conversations: createKyselyConversationCatalog(db),
    messages: createKyselyThreadMessages(db),
    advancedThreads: createKyselyAdvancedThreads(db),
    steering: createKyselySteeringPersistence(db),
    continuation: createKyselyContinuationPersistence(db),
    publications: createKyselyPublicationRecords(db),
    ...createKyselyApprovalRevisionPersistence(db),
    ...createKyselyCatalogPersistence(db),
  }
}

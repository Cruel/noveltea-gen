import { serialize, deserialize } from 'node:v8'
import { MemorySaver, type Checkpoint, type CheckpointMetadata,
  type PendingWrite } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { StoryOnboarding } from './git-contracts'

/** Studio-backed LangGraph saver for a bounded Discovery execution. The
 * reserved namespace is inaccessible to repository-workspace endpoints.
 * Persist both checkpoint bytes and pending writes, not author evidence.
 * All writes use the same cross-backend CAS port as Studio author records. */
export class StudioDiscoveryCheckpoints extends MemorySaver {
  private revision: number | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private readonly namespace: string

  private constructor(private readonly persistence: StoryOnboarding,
    private readonly owner: string, private readonly repository: string,
    private readonly identity: string) {
    super()
    if (!/^[a-f0-9]{64}$/.test(identity)) throw Error('Invalid Discovery checkpoint identity')
    this.namespace = 'story-discovery-graph,' + identity
  }

  static async open(persistence: StoryOnboarding, owner: string, repository: string, identity: string) {
    const saver = new StudioDiscoveryCheckpoints(persistence, owner, repository, identity)
    const row = await persistence.conversation(owner, repository, saver.namespace)
    if (row) {
      const decoded = deserialize(Buffer.from(row.state, 'base64'))
      if (decoded.schema !== 'discovery-checkpoints/v1' || decoded.identity !== identity ||
          !decoded.storage || !decoded.writes ||
          Object.keys(decoded.storage).some(thread => thread !== identity))
        throw Error('Invalid or unsupported Discovery checkpoints')
      saver.storage = decoded.storage
      saver.writes = decoded.writes
      saver.revision = row.revision
    }
    return saver
  }

  private assertIdentity(config: RunnableConfig) {
    if (config.configurable?.thread_id !== this.identity)
      throw Error('Discovery checkpoint belongs to another execution')
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    // LangGraph may persist a superstep and pending writes concurrently.
    // Serialize mutations locally; CAS fences independent worker instances.
    const next = this.tail.then(async () => {
      const result = await operation()
      const revision = (this.revision ?? 0) + 1
      const data = serialize({ schema: 'discovery-checkpoints/v1', identity: this.identity,
        storage: this.storage, writes: this.writes }).toString('base64')
      if (!await this.persistence.saveConversation(this.owner, this.repository, this.namespace,
        revision, data, this.revision, new Date().toISOString()))
        throw Error('Discovery checkpoints changed concurrently')
      this.revision = revision
      return result
    })
    this.tail = next
    return next
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    this.assertIdentity(config)
    return this.mutate(() => super.put(config, checkpoint, metadata))
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string) {
    this.assertIdentity(config)
    return this.mutate(() => super.putWrites(config, writes, taskId, taskPath))
  }

  override async getTuple(config: RunnableConfig) {
    this.assertIdentity(config)
    await this.tail
    return super.getTuple(config)
  }

  override async deleteThread(): Promise<void> {
    throw Error('Discovery checkpoint history is retained; explicitly restart with a new identity')
  }
}

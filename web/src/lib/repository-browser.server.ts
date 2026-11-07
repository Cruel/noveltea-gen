import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { requireUser } from './session.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** Resolve the provider from the owner's catalog, never from a client path or input. */
export async function resolveRepositoryForBrowser(
  auth: StudioAuth, store: StudioStore, headers: Headers, repositoryId: string,
) {
  const user = await requireUser(auth, headers)
  if (!user) throw new Error('Sign in required.')
  if (!UUID.test(repositoryId)) throw new Error('Repository not found.')
  const repository = await store.persistence.repositories.get(user.id, repositoryId)
  if (!repository) throw new Error('Repository not found.')
  return { id: repository.id, provider: repository.provider }
}

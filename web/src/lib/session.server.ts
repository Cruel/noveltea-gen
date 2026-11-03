import type { StudioAuth } from './auth'

export async function requireUser(auth: StudioAuth, headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session?.user?.id) return null
  return { id: session.user.id, name: session.user.name, email: session.user.email }
}

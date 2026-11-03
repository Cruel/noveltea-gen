import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { lastLoginMethod } from 'better-auth/plugins'
import type { StudioDatabase } from '../db/connection'

type OAuthCredentials = { clientId: string; clientSecret: string }

export type StudioAuthConfig = {
  baseURL: string
  secret: string
  github: OAuthCredentials
  gitlab: OAuthCredentials
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): StudioAuthConfig {
  const required = ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET'] as const
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing ${key}; configure the studio OAuth application before starting`)
  }
  if (env.BETTER_AUTH_SECRET!.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  const url = new URL(env.BETTER_AUTH_URL!)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) {
    throw new Error('BETTER_AUTH_URL must be HTTPS except on local loopback')
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('BETTER_AUTH_URL must be an origin')
  return {
    baseURL: url.origin,
    secret: env.BETTER_AUTH_SECRET!,
    github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! },
    gitlab: { clientId: env.GITLAB_CLIENT_ID!, clientSecret: env.GITLAB_CLIENT_SECRET! },
  }
}

// Use one option source for the migration planner and runtime authentication.
// Constructing Better Auth itself triggers an asynchronous schema check, so
// the migrator must access these options without starting the auth runtime.
export function studioAuthOptions(store: StudioDatabase, config: StudioAuthConfig) {
  return {
    appName: 'NovelTea Studio',
    database: store.sqlite,
    baseURL: config.baseURL,
    secret: config.secret,
    emailAndPassword: { enabled: false },
    socialProviders: {
      // GitHub App user authorization uses registered fine-grained permissions,
      // not OAuth App's repo/read:user/user:email scopes. offline_access is
      // the only supported scope, for expiring user tokens and refresh.
      github: { ...config.github, disableDefaultScope: true, scope: ['offline_access'] },
      // GitLab's write_repository covers Git-over-HTTP but not the API used
      // for project discovery and draft merge requests; those need api.
      gitlab: { ...config.gitlab, scope: ['api', 'write_repository'] },
    },
    account: {
      encryptOAuthTokens: true,
      updateAccountOnSignIn: true,
      storeStateStrategy: 'database',
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ['github', 'gitlab'],
        // Explicit linking must support a user's different personal/work emails.
        allowDifferentEmails: true,
      },
    },
    rateLimit: { enabled: true, storage: 'database' },
    plugins: [lastLoginMethod(), tanstackStartCookies()],
  } satisfies BetterAuthOptions
}

export function createStudioAuth(store: StudioDatabase, config: StudioAuthConfig) {
  return betterAuth(studioAuthOptions(store, config))
}

export type StudioAuth = ReturnType<typeof createStudioAuth>

import type { GitProvider, StudioSettings } from './settings.functions'

export type GitAccount = {
  key: string
  provider: GitProvider
  accountId: string
  login: string | null
  loginMethod: boolean
  connection: StudioSettings['gitConnections'][number] | null
}

// The login and repository-authorization records may represent the same provider
// identity. Display one account without conflating their credential lifecycles.
export function gitAccounts(settings: Pick<StudioSettings, 'loginMethods' | 'gitConnections'>): GitAccount[] {
  const accounts = new Map<string, GitAccount>()
  const keyFor = (provider: GitProvider, accountId: string) => provider + ':' + accountId
  for (const login of settings.loginMethods) {
    const key = keyFor(login.provider, login.accountId)
    accounts.set(key, { key, provider: login.provider, accountId: login.accountId,
      login: login.login ?? null, loginMethod: true, connection: null })
  }
  for (const connection of settings.gitConnections) {
    const key = keyFor(connection.provider, connection.accountId)
    const prior = accounts.get(key)
    accounts.set(key, { key, provider: connection.provider, accountId: connection.accountId,
      login: connection.login, loginMethod: prior?.loginMethod ?? false, connection })
  }
  return [...accounts.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) ||
    (a.login ?? a.accountId).localeCompare(b.login ?? b.accountId))
}

export function accountForRepository(
  repo: StudioSettings['repositories'][number], accounts: GitAccount[],
): GitAccount | null {
  if (repo.connectionId) return accounts.find(a => a.connection?.id === repo.connectionId) ?? null
  const logins = accounts.filter(a => a.provider === repo.provider && a.loginMethod)
  return logins.length === 1 ? logins[0]! : null
}

// Binding preference is an implementation detail, not a user-facing "upgrade".
// A dedicated credential is preferred only for a newly chosen account.
export function credentialForAccount(account: GitAccount, loginCount: number): string | null | undefined {
  if (account.connection?.status === 'connected') return account.connection.id
  return account.loginMethod && loginCount === 1 ? null : undefined
}

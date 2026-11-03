const callbackErrors: Record<string, string> = {
  account_not_linked: 'Email already in use. Sign in with your existing provider, then link this provider in Settings.',
  social_account_already_linked: 'This login identity belongs to another Studio user.',
  access_denied: 'Authorization was cancelled or denied by the provider.',
  oauth_provider_not_found: 'This login provider is not configured on Studio.',
  unable_to_create_user: 'Studio could not create an account using that provider.',
}

export function oauthLoginError(query: URLSearchParams, lastUsed: string | null = null): string | null {
  const code = query.get('error')?.toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (!code) return null
  // The OAuth callback does not reveal the conflicting user's linked providers.
  // Last-used is a browser-local hint, never proof of which account owns the email.
  if (code === 'account_not_linked' && (lastUsed === 'github' || lastUsed === 'gitlab')) {
    const provider = lastUsed === 'github' ? 'GitHub' : 'GitLab'
    return `Email already in use. You last signed in here with ${provider}. Try ${provider}, then link this provider in Settings.`
  }
  return callbackErrors[code] ?? 'Provider sign-in did not complete (' + code.slice(0, 60) + '). Try again or check the Studio server logs.'
}

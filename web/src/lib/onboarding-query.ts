/** The onboarding URL identifies only the owning repository and Story folder.
 * Private author briefs, decisions and Pi requests belong in the POST body. */
export function onboardingQuery({ repositoryId, workspace }: {
  repositoryId: string; workspace: string
}): string {
  return new URLSearchParams({ repositoryId, workspace }).toString()
}

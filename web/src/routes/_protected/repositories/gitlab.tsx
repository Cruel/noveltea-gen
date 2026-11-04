import { Navigate, Outlet, createFileRoute, useLocation } from '@tanstack/react-router'

/** This is also the parent route for GitLab Story inspection. Only the
 * /repositories/gitlab index redirects; its repository children stay intact. */
export const Route = createFileRoute('/_protected/repositories/gitlab')({
  component: LegacyGitLabRepositoryPicker,
})

function LegacyGitLabRepositoryPicker() {
  const pathname = useLocation({ select: location => location.pathname })
  if (pathname.replace(/\/+$/, '') === '/repositories/gitlab') {
    return <Navigate to="/dashboard" search={{ addRepository: 'open' }} replace />
  }
  return <Outlet />
}

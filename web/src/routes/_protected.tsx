import { Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { getViewer } from '../lib/dashboard.functions'
import { StudioHeader } from '@/components/studio-header'

export const Route = createFileRoute('/_protected')({
  beforeLoad: async ({ location }) => {
    const user = await getViewer()
    if (!user) throw redirect({ to: '/login', search: { from: location.href } })
    return { user }
  },
  component: ProtectedLayout,
})

function ProtectedLayout() {
  const { user } = Route.useRouteContext()
  const conversations = useLocation({ select: location =>
    /^\/stories\/[^/]+\/conversations\/?$/.test(location.pathname) })
  // Chat owns the viewport at every width. On narrow screens its navigation
  // moves into a Sheet instead of stacking above the conversation. Other
  // routes retain ordinary document scrolling.
  return <div className={conversations ? 'flex h-dvh min-h-0 flex-col overflow-hidden' : ''}>
    <StudioHeader user={user} />
    <Outlet />
  </div>
}

import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
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
  return <>
    <StudioHeader user={user} />
    <Outlet />
  </>
}

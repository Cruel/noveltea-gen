import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { getViewer } from '../lib/dashboard.functions'

export const Route = createFileRoute('/_protected')({
  beforeLoad: async ({ location }) => {
    const user = await getViewer()
    if (!user) throw redirect({ to: '/login', search: { from: location.href } })
    return { user }
  },
  component: () => <Outlet />,
})

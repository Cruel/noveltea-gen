import { createFileRoute, redirect } from '@tanstack/react-router'
import { getViewer } from '../lib/dashboard.functions'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const viewer = await getViewer()
    throw redirect({ to: viewer ? '/dashboard' : '/login' })
  },
})

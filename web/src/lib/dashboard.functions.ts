import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { getDashboardData, requireUser } from './access.server'

export const getViewer = createServerFn({ method: 'GET' }).handler(async () => {
  return requireUser(auth, getRequestHeaders())
})

export const getDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  const dashboard = await getDashboardData(auth, database, getRequestHeaders())
  if (!dashboard) throw new Error('Unauthorized')
  return dashboard
})

import type { DashboardCatalog } from '../persistence/contracts'

/** Dashboard consumers depend on an owner-scoped port, not a local driver. */
export function readUserDashboard(catalog: DashboardCatalog, userId: string) {
  return catalog.forOwner(userId)
}

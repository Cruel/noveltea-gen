import { createFileRoute } from '@tanstack/react-router'
// Legacy route deliberately cannot approve anything. Use /author.
const gone = () => Response.json(
  { error: 'Legacy approval endpoint retired; use the shared author-decision workflow.' },
  { status: 410, headers: { 'Cache-Control': 'private, no-store' } })
export const Route = createFileRoute('/api/jobs/$jobId/foundation-review')({
  server: { handlers: { GET: gone, POST: gone } },
})

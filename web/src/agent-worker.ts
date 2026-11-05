import { openStudioDatabase } from './db/connection'
import { startAgentServer } from './agent-service'

process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'

const token = process.env.NT_AGENT_RPC_TOKEN
if (!token || token.length < 32) throw new Error('Agent requires NT_AGENT_RPC_TOKEN (at least 32 characters).')
if (!process.env.NT_SANDBOX_SOCKET?.startsWith('/') ||
    !process.env.NT_SANDBOX_TOKEN_FILE?.startsWith('/') ||
    process.env.NT_REQUIRE_SANDBOX_TOOLS !== '1') {
  throw new Error('Agent requires its private rootless sandbox controller and sandbox tool policy.')
}
const port = Number(process.env.NT_AGENT_PORT ?? '7001')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid agent port.')
const database = openStudioDatabase()
const service = await startAgentServer(database, token, port)
console.log('NovelTea agent queue and private command endpoint ready.')
let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  // Shutdown is intentionally fail-closed. The queue records remain durable;
  // unfinished writers are fenced on restart rather than blindly replayed.
  await service.close()
  database.close()
}
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })

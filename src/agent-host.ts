/**
 * Compose-private single-process Skein host. The web/API admission bridge,
 * per-user credentials and authenticated web admission are delivered in
 * subsequent tickets. The #52 Pi sandbox gate is mandatory for this server.
 * Never publish this raw Agent Protocol API.
 */
import { isAbsolute, resolve } from 'node:path'
import { embedSqliteGraphs } from '@skein-js/local'
import { createExpressServer } from '@skein-js/express'
import { createGenerationGraph } from './generation.js'

// Do not allow an accidentally deployed graph worker to expose Pi's legacy
// CLI-local filesystem/shell tools if its sandbox configuration was omitted.
if (process.env.NT_REQUIRE_SANDBOX_TOOLS !== '1' ||
    !process.env.NT_SANDBOX_SOCKET || !isAbsolute(process.env.NT_SANDBOX_SOCKET) ||
    !process.env.NT_SANDBOX_TOKEN_FILE || !isAbsolute(process.env.NT_SANDBOX_TOKEN_FILE)) {
  throw new Error('Hosted agent requires the private sandbox socket/token and NT_REQUIRE_SANDBOX_TOOLS=1.')
}

const sqlitePath = process.env.NT_GRAPH_DB
if (!sqlitePath || !isAbsolute(sqlitePath)) throw new Error('NT_GRAPH_DB must be an absolute durable graph path.')
const local = await embedSqliteGraphs({ story_generation: createGenerationGraph() }, {
  sqlitePath: resolve(sqlitePath),
})
const server = await createExpressServer({ deps: local.deps, requestLog: false })
const port = Number(process.env.NT_GRAPH_PORT ?? 7001)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid graph listener port.')
await server.listen(port, '0.0.0.0')
console.log('Private NovelTea graph server ready.')
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  void server.close().then(() => local.dispose()).then(
    () => process.exit(0),
    error => { console.error(error); process.exit(1) },
  )
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

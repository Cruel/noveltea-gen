import { loadControllerConfig, serveController } from './sandbox-controller'

const controller = await serveController(loadControllerConfig())
console.log('NovelTea sandbox controller listening on its private Unix socket.')
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  controller.close(error => {
    if (error) console.error('Sandbox controller shutdown failed:', error.message)
    // Socket is deliberately left for explicit recovery after an unclean stop.
    process.exit(error ? 1 : 0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

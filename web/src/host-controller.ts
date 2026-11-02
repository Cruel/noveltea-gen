import { connect } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { loadControllerConfig, serveController } from './sandbox-controller'

const config = loadControllerConfig()
if (process.env.NT_CONTROLLER_IN_COMPOSE === '1' && existsSync(config.socket)) {
  // A prior Compose controller container may have exited without unlinking its
  // socket on the durable IPC volume. Reconcile only a proven dead endpoint;
  // never unlink a live controller or apply this to operator-managed host mode.
  const result = await new Promise<'alive' | 'stale'>((resolve, reject) => {
    const client = connect({ path: config.socket })
    client.once('connect', () => { client.destroy(); resolve('alive') })
    client.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve('stale')
      else reject(error)
    })
  })
  if (result === 'alive') throw new Error('Another controller already owns the private socket.')
  if (existsSync(config.socket)) unlinkSync(config.socket)
}
const controller = await serveController(config)
console.log('NovelTea sandbox controller listening on its private Unix socket.')
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  controller.close(error => {
    if (error) console.error('Sandbox controller shutdown failed:', error.message)
    // Host mode retains its explicit recovery policy; Compose startup only
    // reconciles a proven dead socket on its private IPC volume.
    process.exit(error ? 1 : 0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

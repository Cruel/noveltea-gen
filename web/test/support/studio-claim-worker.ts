import { openSharedStudioStore } from '../../src/db/shared-studio-store'

const [path, workerId] = process.argv.slice(2)
if (!path || !workerId) throw new Error('Missing isolated claim-worker arguments')

const store = openSharedStudioStore({ backend: 'sqlite', path })
const claimed: string[] = []
const now = '2026-11-05T00:00:00Z'
try {
  // The parent releases all workers together, forcing actual OS-process
  // contention instead of accidentally starting them sequentially.
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message !== 'go') return
      process.off('message', onMessage)
      resolve()
    }
    process.on('message', onMessage)
    if (!process.send) reject(new Error('Certification worker requires an IPC parent'))
    else process.send('ready')
  })
  let emptyPolls = 0
  while (emptyPolls < 30) {
    const next = await store.persistence.generation.queue.claim(workerId, 3, now)
    if (!next) {
      emptyPolls++
      await new Promise(resolve => setTimeout(resolve, 10))
      continue
    }
    emptyPolls = 0
    claimed.push(next.jobId)
    // Leave claims in flight so another process must actually compete for slots.
    await new Promise(resolve => setTimeout(resolve, 3))
    if (!await store.persistence.generation.queue.finish(next.jobId, workerId, true, now))
      throw new Error('Worker lease changed during multi-process certification')
  }
} finally {
  await store.close()
}
process.send?.({ claimed })

/** Linux Unix-domain sockets have a short sun_path limit (usually 107 bytes).
 * Keep ephemeral transport outside durable, deeply nested certification roots.
 * The socket directory is private; controller authentication remains required.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createLiveCertificationIpc() {
  const directory = mkdtempSync(join(tmpdir(), 'nt-story-ipc-'))
  const socket = join(directory, 'sandbox.sock')
  if (Buffer.byteLength(socket) >= 104) {
    rmSync(directory, { recursive: true })
    throw new Error('Certification controller socket path exceeds the Linux Unix-domain path limit')
  }
  return {
    socket,
    directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

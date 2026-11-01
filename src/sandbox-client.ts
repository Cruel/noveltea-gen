/** Trusted agent-worker client for the private host-managed sandbox service.
 * The caller may select ONLY the registered job UUID. No Docker options, host
 * mounts, or credentials are ever forwarded from model-selected tool requests.
 */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type SandboxResult = { jobId: string; status: string }

export class SandboxClient {
  constructor(
    private readonly socket: string = process.env.NT_SANDBOX_SOCKET ?? '',
    private readonly tokenFile: string = process.env.NT_SANDBOX_TOKEN_FILE ?? '',
  ) {
    if (!socket.startsWith('/') || !tokenFile.startsWith('/')) {
      throw new Error('Private sandbox socket and token file are required.')
    }
  }

  private call(method: string, path: string, payload?: object): Promise<string> {
    const token = readFileSync(this.tokenFile, 'utf8').trim()
    const body = payload ? JSON.stringify(payload) : ''
    return new Promise((yes, no) => {
      const req = request({
        socketPath: this.socket, path, method,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 35000,
      }, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > 128 * 1024) { res.destroy(new Error('Sandbox response exceeded limit.')); return }
          chunks.push(chunk)
        })
        res.on('error', no)
        res.on('end', () => {
          const content = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 500) >= 400) {
            no(new Error('Sandbox controller refused request (HTTP ' + res.statusCode + ').'))
          } else yes(content)
        })
      })
      req.on('timeout', () => req.destroy(new Error('Sandbox controller request timed out.')))
      req.on('error', no)
      req.end(body)
    })
  }

  private id(id: string) {
    if (!UUID.test(id)) throw new Error('Expected a registered UUID job ID.')
    // Job UUID casing is part of its existing durable Git/job identity.
    return id
  }

  async acquire(jobId: string): Promise<SandboxResult> {
    const id = this.id(jobId)
    return JSON.parse(await this.call('POST', '/v1/sandboxes', { jobId: id })) as SandboxResult
  }
  async inspect(jobId: string): Promise<SandboxResult> {
    return JSON.parse(await this.call('GET', '/v1/sandboxes/' + this.id(jobId))) as SandboxResult
  }
  async dispose(jobId: string): Promise<SandboxResult> {
    return JSON.parse(await this.call('DELETE', '/v1/sandboxes/' + this.id(jobId))) as SandboxResult
  }
  execute(jobId: string, argv: string[], output: (stream: 'stdout' | 'stderr', text: string) => void): Promise<number> {
    const id = this.id(jobId)
    const body = JSON.stringify({ argv })
    const token = readFileSync(this.tokenFile, 'utf8').trim()
    return new Promise((yes, no) => {
      const req = request({
        socketPath: this.socket, path: '/v1/sandboxes/' + id + '/exec', method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 35000,
      }, res => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume()
          no(new Error('Sandbox controller refused execution (HTTP ' + res.statusCode + ').'))
          return
        }
        let text = ''
        let size = 0
        let code: number | undefined
        let failed = false
        res.on('data', (part: Buffer) => {
          if (failed) return
          size += part.byteLength
          if (size > 128 * 1024) {
            failed = true
            res.destroy(new Error('Sandbox output exceeded the client limit.'))
            return
          }
          text += part.toString('utf8')
          try {
            while (text.includes('\n')) {
              const end = text.indexOf('\n')
              const line = text.slice(0, end)
              text = text.slice(end + 1)
              if (!line) continue
              const entry = JSON.parse(line) as {
                stream?: 'stdout' | 'stderr'; data?: string; exitCode?: number; error?: string
              }
              if (entry.error) throw new Error('Sandbox command failed: ' + entry.error)
              if (entry.stream && entry.data) output(entry.stream, entry.data)
              if (typeof entry.exitCode === 'number') code = entry.exitCode
            }
          } catch (error) {
            failed = true
            res.destroy(error as Error)
          }
        })
        res.on('error', no)
        res.on('end', () => {
          if (failed) return
          if (code === undefined || text.trim()) no(new Error('Sandbox ended without a complete execution status.'))
          else yes(code)
        })
      })
      req.on('timeout', () => req.destroy(new Error('Sandbox command request timed out.')))
      req.on('error', no)
      req.end(body)
    })
  }
}

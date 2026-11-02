import { randomBytes } from 'node:crypto'
import { existsSync, chmodSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

/** One-shot Compose prerequisite: initialize a durable controller secret and
 * migrate the app catalog before independent web/agent/controller processes.
 * No host Docker socket is mounted into this service. */
// Fail at deployment startup, not halfway through a paid generation job,
// when a bind mount is missing or the native CLI cannot run in this image.
const binary = '/opt/noveltea/noveltea'
const skills = '/opt/noveltea-skills/skills'
if (!statSync(binary).isFile() || !statSync(skills).isDirectory())
  throw new Error('Native NovelTea CLI and skills checkout must be mounted before startup.')
const cli = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 })
if (cli.error || cli.status !== 0)
  throw new Error('Mounted native NovelTea CLI cannot execute in the trusted image.')
if (!process.env.NT_AGENT_RPC_TOKEN || process.env.NT_AGENT_RPC_TOKEN.length < 32)
  throw new Error('Set NT_AGENT_RPC_TOKEN in web/.env (at least 32 characters).')
if (!process.env.NT_PI_CREDENTIAL_KEY)
  throw new Error('Set NT_PI_CREDENTIAL_KEY in web/.env to enable encrypted ChatGPT OAuth.')
const token = '/run/noveltea-controller/token'
mkdirSync(dirname(token), { recursive: true, mode: 0o700 })
chmodSync(dirname(token), 0o700)
if (!existsSync(token)) {
  writeFileSync(token, randomBytes(48).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
}
const info = lstatSync(token)
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    readFileSync(token, 'utf8').trim().length < 48) {
  throw new Error('Controller credential volume is unsafe; reconcile it before startup.')
}
const migrated = spawnSync('pnpm', ['--filter', '@noveltea/studio', 'migrate'],
  { cwd: '/app', env: process.env, stdio: 'inherit', timeout: 120_000 })
if (migrated.error || migrated.status !== 0) {
  throw new Error('Studio migration failed; refusing to start Compose services.')
}
console.log('Compose bootstrap: controller credentials and database migrations ready.')

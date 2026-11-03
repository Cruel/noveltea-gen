import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { OAuthAuthorization } from '@earendil-works/pi-ai'
import type { StudioDatabase } from '../db/connection'

type Status = 'pending' | 'completing' | 'connected' | 'failed'
type RecordRow = { owner_user_id: string; provider: string; state: string;
  ciphertext: string | null; status: Status; expires_at: number; reason: string | null }
type PrivateFlow = { authorization: OAuthAuthorization }
export type BrowserFlow = { provider: string; status: Status; url?: string; reason?: string; interactive: false }

function key() {
  const encoded = process.env.NT_PI_CREDENTIAL_KEY
  const raw = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
  if (!encoded || raw.length !== 32 || raw.toString('base64') !== encoded)
    throw new Error('NT_PI_CREDENTIAL_KEY must be a base64-encoded 32-byte key')
  return createHmac('sha256', raw).update('studio-pi-oauth-pending-v1').digest()
}
function encrypt(owner: string, state: string, value: PrivateFlow) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  cipher.setAAD(Buffer.from(owner + '\0' + state))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [nonce, cipher.getAuthTag(), body].map(part => part.toString('base64')).join('.')
}
function decrypt(row: RecordRow): PrivateFlow {
  if (!row.ciphertext) throw new Error('OAuth authorization context has been consumed')
  const parts = row.ciphertext.split('.')
  if (parts.length !== 3) throw new Error('Invalid stored OAuth authorization')
  const [nonce, tag, body] = parts.map(part => Buffer.from(part, 'base64'))
  if (nonce!.length !== 12 || tag!.length !== 16) throw new Error('Invalid OAuth context ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce!)
  decipher.setAAD(Buffer.from(row.owner_user_id + '\0' + row.state))
  decipher.setAuthTag(tag!)
  const value = JSON.parse(Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')) as PrivateFlow
  if (value?.authorization?.state !== row.state ||
      typeof value.authorization.url !== 'string' || typeof value.authorization.context !== 'string')
    throw new Error('Invalid stored OAuth authorization context')
  return value
}
function byOwner(store: StudioDatabase, owner: string) {
  return store.sqlite.prepare('SELECT * FROM pi_oauth_pending WHERE owner_user_id=?')
    .get(owner) as RecordRow | undefined
}
function toPublic(row: RecordRow): BrowserFlow {
  return { provider: row.provider, status: row.status, interactive: false,
    ...(row.status === 'pending' ? { url: decrypt(row).authorization.url } : {}),
    ...(row.reason ? { reason: row.reason } : {}) }
}
export function ownerBrowserFlow(store: StudioDatabase, owner: string): BrowserFlow | null {
  const row = byOwner(store, owner)
  if (!row || row.expires_at < Date.now()) return null
  return toPublic(row)
}
export function saveBrowserAuthorization(store: StudioDatabase, owner: string,
  provider: string, authorization: OAuthAuthorization, expires: number) {
  const ciphertext = encrypt(owner, authorization.state, { authorization })
  store.sqlite.transaction(() => {
    store.sqlite.prepare('DELETE FROM pi_oauth_pending WHERE owner_user_id=?').run(owner)
    store.sqlite.prepare(`INSERT INTO pi_oauth_pending
      (owner_user_id, provider, state, ciphertext, status, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?)`).run(owner, provider, authorization.state, ciphertext, expires)
  })()
}
export function pendingByState(store: StudioDatabase, state: string) {
  const row = store.sqlite.prepare(`SELECT * FROM pi_oauth_pending
    WHERE state=? AND status='pending' AND expires_at>=?`).get(state, Date.now()) as RecordRow | undefined
  return row ? { provider: row.provider, owner: row.owner_user_id,
    authorization: decrypt(row).authorization } : null
}
export function claimBrowserAuthorization(store: StudioDatabase, owner: string, state: string) {
  const changed = store.sqlite.prepare(`UPDATE pi_oauth_pending SET status='completing'
    WHERE owner_user_id=? AND state=? AND status='pending' AND expires_at>=?`)
    .run(owner, state, Date.now()).changes
  return changed === 1
}
export function finishBrowserAuthorization(store: StudioDatabase, owner: string, state: string,
  status: 'connected' | 'failed', reason?: string) {
  store.sqlite.prepare(`UPDATE pi_oauth_pending SET status=?, ciphertext=NULL, reason=?
    WHERE owner_user_id=? AND state=? AND status IN ('pending','completing')`)
    .run(status, reason ?? null, owner, state)
}
export function cancelBrowserAuthorization(store: StudioDatabase, owner: string) {
  store.sqlite.prepare('DELETE FROM pi_oauth_pending WHERE owner_user_id=?').run(owner)
}

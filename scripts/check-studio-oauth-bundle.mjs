/** Verify bundled Pi device-code OAuth without external network or local callback servers. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server } from 'node:net'

const root = resolve(import.meta.dirname, '../web/.output/server')
const router = readdirSync(resolve(root, '_ssr')).find(name => /^router-.*\.mjs$/.test(name))
assert.ok(router, 'Built Studio router is missing')
const source = readFileSync(resolve(root, '_ssr', router), 'utf8')
assert.match(source, /registerBunOAuthFlows\(\)/,
  'Compiled Studio must register the official static Pi OAuth providers')

const ai = await import(pathToFileURL(resolve(root, '_libs/@earendil-works/pi-ai.mjs')).href)
const agent = await import(pathToFileURL(resolve(root, '_libs/@earendil-works/pi-coding-agent+[...].mjs')).href)
assert.equal(typeof ai.registerBunOAuthFlows, 'function')
ai.registerBunOAuthFlows()

const runtime = await agent.ModelRuntime.create({
  modelsPath: null, allowModelNetwork: false,
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
})
for (const provider of ['openai-codex', 'github-copilot', 'kimi-coding', 'meta', 'radius', 'xai'])
  assert.ok(runtime.getProvider(provider)?.auth.oauth, 'Missing bundled device provider ' + provider)

const originalFetch = globalThis.fetch
const originalListen = Server.prototype.listen
let deviceCodeSeen = false
const controller = new AbortController()
try {
  Server.prototype.listen = function () { throw new Error('Unexpected local OAuth callback listener') }
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://auth.x.ai/oauth2/device/code')
    return Response.json({ device_code: 'private-fixture-code', user_code: 'XXXX-1234',
      verification_uri: 'https://auth.x.ai/activate', interval: 10, expires_in: 900 })
  }
  await runtime.login('xai', 'oauth', {
    signal: controller.signal,
    prompt: async () => { throw new Error('Unexpected device-code login prompt') },
    notify: event => {
      if (event.type === 'auth_url') throw new Error('Browser callback OAuth is forbidden')
      if (event.type === 'device_code') {
        assert.equal(event.userCode, 'XXXX-1234')
        deviceCodeSeen = true
        controller.abort()
      }
    },
  }, { agentName: 'NovelTea Studio' }).catch(error => {
    if (!deviceCodeSeen) throw error
  })
  assert.ok(deviceCodeSeen, 'Bundled Pi did not emit a device authorization code')
} finally {
  globalThis.fetch = originalFetch
  Server.prototype.listen = originalListen
}
console.log('PASS compiled Studio uses upstream Pi device-code OAuth without callback server')

/**
 * Production-bundle regression: Pi's Node-only OAuth modules use variable
 * imports which Nitro cannot discover. Assert the built Studio registers the
 * SDK static OAuth loaders, then start a real bundled OpenAI flow without
 * authenticating, exchanging codes, or writing credentials.
 *
 * Run after pnpm --filter @noveltea/studio build.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../web/.output/server')
const router = readdirSync(resolve(root, '_ssr')).find(name => /^router-.*\.mjs$/.test(name))
assert.ok(router, 'Built Studio router is missing')
const serverSource = readFileSync(resolve(root, '_ssr', router), 'utf8')
assert.match(serverSource, /registerBunOAuthFlows\(\)/,
  'Compiled Studio must register static Pi OAuth flows before handling requests')

const ai = await import(pathToFileURL(resolve(root, '_libs/@earendil-works/pi-ai.mjs')).href)
const agent = await import(pathToFileURL(resolve(root, '_libs/@earendil-works/pi-coding-agent+[...].mjs')).href)
assert.equal(typeof ai.registerBunOAuthFlows, 'function')
ai.registerBunOAuthFlows()
const runtime = await agent.ModelRuntime.create({
  modelsPath: null,
  allowModelNetwork: false,
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
})
let receivedAuthUrl = false
const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(), 12_000)
try {
  await runtime.login('openai', 'oauth', {
    signal: abort.signal,
    prompt: async () => { throw Error('Unexpected manual code prompt in authorization-start test') },
    notify: event => {
      if (event.type !== 'auth_url') return
      assert.match(event.url, /^https:\/\//)
      receivedAuthUrl = true
      abort.abort()
    },
  }, { agentName: 'NovelTea Studio', callback: { mode: 'external' },
    getDeviceId: () => 'abcdef01-1234-4567-8abc-123456789abc' })
} catch (error) {
  if (!receivedAuthUrl) throw error
} finally {
  clearTimeout(timeout)
}
assert.ok(receivedAuthUrl, 'Bundled Pi failed before emitting a ChatGPT authorization URL')
console.log('PASS compiled Studio registers and loads ChatGPT OAuth, no credentials exchanged')

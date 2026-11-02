/**
 * Test the actual browser -> host loopback 1455 -> Compose -> Pi SDK callback.
 * No real OpenAI login, network exchange or persistent credentials. The SDK's
 * grant exchange is intercepted with synthetic response data inside a separate
 * trusted test process. Do not run during a real in-progress ChatGPT login.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const callbackOrigin = 'http://127.0.0.1:1455'
const testCode = 'noveltea-local-callback-probe'

async function inside() {
  assert.equal(process.env.PI_OAUTH_CALLBACK_HOST, '0.0.0.0',
    'Compose must bind Pi callback on container interface')
  const libs = resolve('/app/web/.output/server/_libs')
  const ai = await import(pathToFileURL(resolve(libs, '@earendil-works/pi-ai.mjs')).href)
  const { ModelRuntime } = await import(pathToFileURL(resolve(libs, '@earendil-works/pi-coding-agent+[...].mjs')).href)
  ai.registerBunOAuthFlows()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://auth.openai.com/api/accounts/oauth/token',
      'OAuth test must not make any real outbound HTTP requests')
    const form = new URLSearchParams(String(init?.body))
    assert.equal(form.get('code'), testCode)
    assert.ok(form.get('code_verifier'), 'SDK must supply PKCE verifier')
    assert.equal(form.get('redirect_uri'), callbackOrigin + '/auth/callback')
    return new Response(JSON.stringify({
      access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
      id_token: 'synthetic-id', expires_in: 3600,
      scope: 'openid chatgpt.tokens.use.direct',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const credentials = {
    read: async () => undefined, list: async () => [],
    modify: async (_provider, modify) => modify(undefined),
    delete: async () => {},
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const credential = await runtime.login('openai', 'oauth', {
      signal: controller.signal,
      prompt: async () => new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(Error('OAuth callback probe timed out')), { once: true })
      }),
      notify: event => {
        if (event.type === 'auth_url') {
          const url = new URL(event.url)
          assert.equal(url.searchParams.get('redirect_uri'), callbackOrigin + '/auth/callback')
          const state = url.searchParams.get('state')
          assert.ok(state)
          // Synthetic, short-lived PKCE test state, never real user credentials.
          process.stdout.write('CALLBACK_READY ' + state + '\n')
        }
      },
    }, { agentName: 'NovelTea Studio', getDeviceId: () => 'abcdef01-1234-4567-8abc-123456789abc' })
    assert.equal(credential?.access, 'synthetic-access')
    assert.equal(credential?.refresh, 'synthetic-refresh')
    process.stdout.write('CALLBACK_EXCHANGED\n')
  } finally {
    clearTimeout(timeout)
    globalThis.fetch = originalFetch
  }
}

async function host() {
  const child = spawn('docker', ['compose', 'exec', '-T', 'web', 'node',
    'scripts/check-compose-oauth-loopback.mjs', '--inside'],
  { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => { output += chunk })
  const deadline = setTimeout(() => child.kill('SIGTERM'), 18_000)
  try {
    let state
    for (let i = 0; i < 120; i++) {
      const match = output.match(/^CALLBACK_READY ([a-zA-Z0-9_-]+)$/m)
      if (match) { state = match[1]; break }
      if (child.exitCode !== null) break
      await new Promise(done => setTimeout(done, 50))
    }
    assert.ok(state, 'Isolated Pi callback did not start: ' + stderr.slice(0, 450))
    const request = (v) => fetch(callbackOrigin + '/auth/callback?' +
      new URLSearchParams({ state: v, code: testCode, client_id: 'synthetic-client' }),
      { signal: AbortSignal.timeout(3500) })
    const rejected = await request('mismatched-state')
    assert.equal(rejected.status, 400, 'SDK must reject mismatched OAuth state')
    const accepted = await request(state)
    assert.equal(accepted.status, 200, 'Host loopback must reach trusted Pi callback')
    await accepted.arrayBuffer()
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    assert.equal(child.exitCode, 0, 'Isolated Pi callback failed: ' + stderr.slice(0, 450))
    assert.match(output, /CALLBACK_EXCHANGED/, 'Pi did not exchange callback code')
    console.log('PASS host 127.0.0.1:1455 -> Compose -> Pi state validation -> synthetic token exchange')
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

if (process.argv.includes('--inside')) await inside()
else await host()

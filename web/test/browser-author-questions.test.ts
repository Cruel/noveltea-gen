import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'

const storyId = '11111111-1111-4111-8111-111111111111'
const firstTurnId = '22222222-2222-4222-8222-222222222222'
const setId = 'd'.repeat(64)
const digest = 'c'.repeat(64)
const originalAnswer = 'The original answer'
const draft = (text: string) => ({
  selection: '', selectedIds: [], multiCustom: false, customAnswer: text, note: '',
})
const foundation = {
  id: 'foundation', title: 'The Last Bell', premise: 'A missing bell',
  central_conflict: 'The village conceals the truth', genre: 'Mystery',
  tone: 'Uneasy', player_experience: 'Find the evidence', scope: 'One village',
  body: 'Follow the clues to the bell.', decisions: [],
}
type Session = {
  phase: 'questions' | 'proposed' | 'approved' | 'blocked' | 'running'
  revision: number; legacyQuestions?: boolean; startedAt: number
  questions: null | { id: string; revision: number; questions: Array<{
    id: string; kind: string; question: string
  }> }
  drafts: Record<string, ReturnType<typeof draft>>
  proposal: null | { foundation: typeof foundation; task: string }
  digest: string | null
  skillId: string; turns: Array<{ role: string; text: string }>
  chat: { storyId: string; firstTurnId: string; sourceSha: string; directory: string }
}
const makeSession = (phase: Session['phase'], revision: number, legacyQuestions = false): Session => ({
  phase, revision, legacyQuestions, startedAt: Date.now() - 60 * 60 * 1000,
  questions: phase === 'questions' ? { id: setId, revision, questions: [{
    id: 'direction', kind: 'free-text', question: 'What should the mystery reveal?',
  }] } : null,
  drafts: phase === 'questions' ? { direction: draft(originalAnswer) } : {},
  proposal: ['proposed', 'approved'].includes(phase) ? {
    foundation, task: 'Make a mystery Story',
  } : null,
  digest: phase === 'proposed' || phase === 'approved' ? digest : null,
  skillId: 'a'.repeat(64), turns: [{ role: 'user', text: 'Make a mystery Story' }],
  chat: { storyId, firstTurnId, sourceSha: 'b'.repeat(40), directory: 'story' },
})
function chromeBinary(): string | null {
  const own = process.env.NT_BROWSER_CHROME
  if (own) return existsSync(own) ? own : null
  const parent = join(homedir(), '.cache/puppeteer/chrome')
  if (existsSync(parent)) for (const version of readdirSync(parent).sort().reverse()) {
    const path = join(parent, version, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}
type CDP = {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  close(): void
}
async function connect(webSocketDebuggerUrl: string): Promise<CDP> {
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', () => fail(Error('Chrome DevTools websocket failed')), { once: true })
  })
  let nextId = 0
  const pending = new Map<number, { ok: (result: unknown) => void; fail: (e: Error) => void }>()
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (!message.id || !pending.has(message.id)) return
    const current = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error) current.fail(Error(String(message.error.message)))
    else current.ok(message.result)
  })
  return {
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { ws.close() },
  }
}
async function evaluate(page: CDP, script: string): Promise<any> {
  const result = await page.send('Runtime.evaluate', {
    expression: script, returnByValue: true, awaitPromise: true,
  })
  if (result.exceptionDetails) throw Error('Browser execution error: ' +
    (result.exceptionDetails.text ?? 'unknown'))
  return result.result?.value
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(page: CDP, script: string, label: string) {
  for (let i = 0; i < 200; i++) {
    if (await evaluate(page, script)) return
    await delay(100)
  }
  const state = await evaluate(page, '({url:location.href, ready:document.readyState, body:document.body?.innerText?.slice(0,300)})')
  throw Error('Timed out waiting for ' + label + ': ' + JSON.stringify(state))
}
async function untilRecorded(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await delay(25)
  }
  throw Error('Timed out waiting for server action ' + label)
}
function buttonScript(label: string): string {
  return 'Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes(' +
    JSON.stringify(label) + '))'
}
async function click(page: CDP, label: string) {
  const found = await evaluate(page,
    '(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent?.includes(' +
    JSON.stringify(label) + '));if(!b || b.disabled) return false;b.click();return true})()')
  assert.equal(found, true, 'Expected enabled button ' + label)
}

test('browser: reloaded Story Chat actions and two-tab unsent answers remain operable', {
  skip: process.env.NT_BROWSER_TEST !== '1',
  timeout: 90_000,
}, async () => {
  const binary = chromeBinary()
  assert.ok(binary, 'Set NT_BROWSER_CHROME to a headless Chrome executable')
  const fakeModules = new Map([
    ['@/lib/story-chat-discovery.functions', [
      'export async function readStoryChatDiscovery() {',
      '  const r = await fetch("/__test/state"); return r.json();',
      '}',
      'export async function actStoryChatDiscovery({data}) {',
      '  const r = await fetch("/__test/action", {method:"POST",',
      '    headers:{"content-type":"application/json"}, body:JSON.stringify(data)});',
      '  const body = await r.json(); if(!r.ok) throw Error(body.error); return body;',
      '}',
    ].join('\n')],
    ['@/lib/threads.queries', 'export const storyNavigationKey = id => ["story-nav", id];'],
    ['@/lib/pi.functions', 'export async function getPiCatalog() { return JSON.stringify({models:[]}); }'],
    ['@/lib/author.functions', [
      'export async function sendAuthorCommand({data}) {',
      '  const r = await fetch("/__test/specialist-command", {method:"POST",',
      '    headers:{"content-type":"application/json"}, body:JSON.stringify(data)});',
      '  const body = await r.text(); if(!r.ok) throw Error(JSON.parse(body).error); return body;',
      '}',
    ].join('\n')],
    ['@/lib/author.queries', [
      'export function authorInteractionsQuery(id) { return {',
      '  queryKey: ["author-interactions", id],',
      '  queryFn: async () => (await fetch("/__test/specialist")).json(),',
      '  refetchInterval: 5000,',
      '}; }',
    ].join('\n')],
    ['@/lib/jobs.queries', [
      'export function jobQuery(id) { return {',
      '  queryKey: ["job", id], queryFn: async () => ({storyId: null}),',
      '}; }',
    ].join('\n')],
  ])
  const compiled = await build({
    entryPoints: [resolve('test/browser-author-questions-harness.tsx')],
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': resolve('src') },
    plugins: [{
      name: 'author-question-browser-boundary',
      setup(plugin) {
        plugin.onResolve({ filter: /(?:^@\/lib\/|\/)(?:story-chat-discovery\.functions|story-workflows\.functions|pi\.functions|threads\.queries|author\.functions|author\.queries|jobs\.queries)$/ },
          args => ({ path: '@/lib/' + args.path.split('/').at(-1),
            namespace: 'author-question-test' }))
        plugin.onLoad({ filter: /.*/, namespace: 'author-question-test' },
          args => ({ contents: fakeModules.get(args.path)!, loader: 'js' }))
      },
    }],
  })
  const bundle = compiled.outputFiles![0]!.text
  let session: Session = makeSession('proposed', 5)
  const actions: Array<Record<string, any>> = []
  const specialistQuestionId = '33333333-3333-4333-8333-333333333333'
  const specialistProposal = 'e'.repeat(64)
  const freshSpecialist = () => ({
    status: 'paused', items: [], decisions: [], choice: {
      id: specialistQuestionId, phase: 'awaiting-author',
      workItem: 'character-foundations', proposalSha256: specialistProposal,
      delegationAllowed: false,
      question: { kind: 'free-text', question: 'How should this Character respond to the clue?' },
      draft: { revision: 1, drafts: { answer: draft('Initial specialist direction') } },
    },
  })
  type SpecialistState = Omit<ReturnType<typeof freshSpecialist>, 'choice'> & {
    choice: ReturnType<typeof freshSpecialist>['choice'] & {
      answer?: { kind: string; text: string; note: string }
    }
  }
  let specialistState: SpecialistState = freshSpecialist()
  const specialistActions: Array<Record<string, any>> = []
  const server = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(bundle); return
    }
    if (req.url === '/__test/specialist') { json(specialistState); return }
    if (req.url === '/__test/specialist-command' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const input = JSON.parse(request.commandJson) as Record<string, any>
      specialistActions.push(input)
      const choice = specialistState.choice
      if (choice.phase !== 'awaiting-author' || input.id !== choice.id ||
          input.proposalSha256 !== choice.proposalSha256 ||
          input.draftRevision !== choice.draft.revision) {
        json({ error: 'Stale specialist answer' }, 409); return
      }
      if (input.action === 'choice-draft') {
        specialistState = { ...specialistState, choice: { ...choice,
          draft: { revision: choice.draft.revision + 1, drafts: input.drafts },
        } }
        json({ draft: specialistState.choice.draft }); return
      }
      if (input.action === 'choice' && input.kind === 'custom') {
        specialistState = { ...specialistState, choice: { ...choice,
          phase: 'answered', answer: { kind: 'custom', text: input.text, note: input.note },
        } }
        json({ choice: { id: choice.id, phase: 'answered', proposalSha256: specialistProposal },
          continuation: 'queued' }); return
      }
      json({ error: 'Invalid specialist command' }, 422); return
    }
    if (req.url === '/__test/state') {
      json({ session, ...(session.phase === 'approved' ? {
        continuation: { state: 'blocked', message: 'Recover saved execution.' },
      } : {}) })
      return
    }
    if (req.url === '/__test/action' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
      actions.push(input)
      if (input.revision !== session.revision) {
        json({ error: 'Stale discovery revision' }, 409); return
      }
      if (input.action === 'draft' && session.phase === 'questions') {
        session = { ...session, revision: session.revision + 1, drafts: input.drafts }
      } else if (input.action === 'answer' && session.phase === 'questions') {
        session = makeSession('proposed', session.revision + 1)
      } else if (input.action === 'approve' && session.phase === 'proposed') {
        session = makeSession('approved', session.revision + 1)
      } else if (input.action === 'retry' || input.action === 'restart') {
        session = makeSession('questions', session.revision + 1)
      } else if (input.action === 'reconcile') {
        session = makeSession('blocked', session.revision + 1)
      } else if (input.action !== 'continue') {
        json({ error: 'Unsupported test action' }, 409); return
      }
      json({ session, ...(session.phase === 'approved' ? {
        continuation: { state: 'blocked', message: 'Recover saved execution.' },
      } : {}) })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><meta charset="UTF-8"></head>' +
      '<body><main id="root"></main><script src="/bundle.js"></script></body></html>')
  })
  const profile = mkdtempSync(join(tmpdir(), 'nt-author-questions-browser-'))
  let chrome: ReturnType<typeof spawn> | undefined
  const pages: CDP[] = []
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = 'http://127.0.0.1:' + address.port
    chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
    const portPath = join(profile, 'DevToolsActivePort')
    for (let i = 0; !existsSync(portPath) && i < 120; i++) await delay(100)
    assert.ok(existsSync(portPath), 'Chrome did not expose DevTools')
    const chromePort = readFileSync(portPath, 'utf8').split('\n')[0]
    const tab = async (suffix = '') => {
      const response = await fetch('http://127.0.0.1:' + chromePort +
        '/json/new?' + encodeURIComponent(url + suffix), { method: 'PUT' })
      assert.equal(response.status, 200)
      const target = await response.json() as { webSocketDebuggerUrl: string }
      const page = await connect(target.webSocketDebuggerUrl)
      pages.push(page)
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      // Chrome can return a target still on about:blank even when /json/new
      // was given a URL. Navigate explicitly and wait for the real origin.
      const navigation = await page.send('Page.navigate', { url: url + suffix })
      assert.equal(navigation.errorText, undefined, 'Chrome navigation failed')
      await until(page, 'location.origin === ' + JSON.stringify(url), 'browser navigation')
      return page
    }
    const first = await tab()
    await until(first, buttonScript('Approve baseline'), 'proposed session after reload')
    await click(first, 'Approve baseline')
    await until(first, buttonScript('Continue'), 'approved recovery')
    assert.equal(actions.at(-1)?.action, 'approve')
    assert.equal(actions.at(-1)?.revision, 5)

    await first.send('Page.reload', { ignoreCache: true })
    await until(first, buttonScript('Continue'), 'Continue after approved reload')
    await click(first, 'Continue')
    await untilRecorded(() => actions.at(-1)?.action === 'continue', 'continue')
    assert.equal(actions.at(-1)?.action, 'continue')
    assert.equal(actions.at(-1)?.revision, 6)

    session = makeSession('blocked', 10)
    await first.send('Page.reload', { ignoreCache: true })
    await until(first, buttonScript('Retry discovery'), 'Retry after blocked reload')
    await click(first, 'Retry discovery')
    await untilRecorded(() => actions.at(-1)?.action === 'retry', 'retry')
    assert.equal(actions.at(-1)?.action, 'retry')
    assert.equal(actions.at(-1)?.revision, 10)

    session = makeSession('proposed', 13, true)
    await first.send('Page.reload', { ignoreCache: true })
    await until(first, buttonScript('Restart discovery questions'), 'legacy restart')
    await click(first, 'Restart discovery questions')
    await untilRecorded(() => actions.at(-1)?.action === 'restart', 'restart')
    assert.equal(actions.at(-1)?.action, 'restart')
    assert.equal(actions.at(-1)?.revision, 13)

    session = makeSession('questions', 20)
    await first.send('Page.reload', { ignoreCache: true })
    const second = await tab()
    await until(first, buttonScript('Submit 1 answer'), 'first-tab questions')
    await until(second, buttonScript('Submit 1 answer'), 'second-tab questions')
    assert.equal(await evaluate(first, 'document.querySelector("textarea")?.value'),
      originalAnswer)
    await evaluate(first, '(()=>{const t=document.querySelector("textarea");' +
      't.focus();t.setSelectionRange(t.value.length,t.value.length);return true})()')
    await first.send('Input.insertText', { text: ' — unsent edit from first tab' })
    await until(first, 'document.querySelector("textarea")?.value.includes("unsent edit")',
      'keyboard input in first tab')

    await click(second, 'Submit 1 answer')
    await until(second, buttonScript('Approve baseline'), 'second-tab submission')
    assert.equal(actions.at(-1)?.action, 'answer')
    await evaluate(first, 'window.refreshQuestionSession()')
    await until(first, '!!document.querySelector("[aria-label=\\"Unsaved Question Set recovery\\"]")',
      'copyable first-tab input after replacement')
    const copies = await evaluate(first,
      'Array.from(document.querySelectorAll("textarea[readonly]")).map(t=>t.value)')
    assert.ok(copies.some((value: string) => value.includes('unsent edit from first tab')))
    assert.equal(actions.filter(action => action.action === 'answer').length, 1,
      'stale first-tab input must never be submitted to the new set')

    const specialist = await tab('?mode=specialist')
    await until(specialist, buttonScript('Submit 1 answer'), 'paused specialist question')
    await click(specialist, 'Submit 1 answer')
    await until(specialist, 'document.body.textContent.includes("Saved response")',
      'answered specialist receipt')
    assert.equal(specialistActions.at(-1)?.action, 'choice')
    assert.equal(specialistActions.at(-1)?.text, 'Initial specialist direction')
    assert.equal(specialistState.choice.phase, 'answered')
    await specialist.send('Page.reload', { ignoreCache: true })
    await until(specialist, 'document.body.textContent.includes("Saved response")',
      'read-only specialist answer after reload')
    assert.equal(await evaluate(specialist, buttonScript('Submit 1 answer')), false)

    specialistState = freshSpecialist()
    await specialist.send('Page.reload', { ignoreCache: true })
    const specialistOther = await tab('?mode=specialist')
    await until(specialist, buttonScript('Submit 1 answer'), 'first specialist tab')
    await until(specialistOther, buttonScript('Submit 1 answer'), 'second specialist tab')
    await evaluate(specialist, '(()=>{const t=document.querySelector("textarea");' +
      't.focus();t.setSelectionRange(t.value.length,t.value.length);return true})()')
    await specialist.send('Input.insertText', { text: ' — unsent specialist edit' })
    await until(specialist, 'document.querySelector("textarea")?.value.includes("unsent specialist edit")',
      'specialist keyboard change')
    await click(specialistOther, 'Submit 1 answer')
    await until(specialistOther, 'document.body.textContent.includes("Saved response")',
      'specialist answered in the second tab')
    // The next specialist may already be awaiting the author when the first
    // tab polls; the prior editable component must not be remounted and lost.
    specialistState = { ...freshSpecialist(), choice: { ...freshSpecialist().choice,
      id: '44444444-4444-4444-8444-444444444444',
      proposalSha256: 'f'.repeat(64),
    } }
    await evaluate(specialist, 'window.refreshSpecialist()')
    await until(specialist, '!!document.querySelector("[aria-label=\\"Unsaved Question Set recovery\\"]")',
      'copy of unsent specialist answer after another tab submits')
    const specialistCopies = await evaluate(specialist,
      'Array.from(document.querySelectorAll("textarea[readonly]")).map(t=>t.value)')
    assert.ok(specialistCopies.some((value: string) => value.includes('unsent specialist edit')))
    assert.equal(await evaluate(specialist, buttonScript('Submit 1 answer')), true,
      'new Question Set remains usable while the previous unsent words are visible')
    assert.equal(specialistActions.filter(action => action.action === 'choice').length, 2,
      'one accepted specialist answer per fresh question; no stale replay')

    // The real Thread removes its interactive panel when the Job becomes
    // queued/running. The emergency copy must survive that unmount too.
    specialistState = freshSpecialist()
    await specialist.send('Page.reload', { ignoreCache: true })
    await until(specialist, buttonScript('Submit 1 answer'), 'pending specialist before Job transition')
    await evaluate(specialist, '(()=>{const t=document.querySelector("textarea");' +
      't.focus();t.setSelectionRange(t.value.length,t.value.length);return true})()')
    await specialist.send('Input.insertText', { text: ' — lost if Job panel unmounts' })
    await until(specialist, 'document.querySelector("textarea")?.value.includes("lost if Job")',
      'unsent typed specialist input')
    await evaluate(specialist, 'window.setSpecialistRunStatus("running")')
    await until(specialist, '!!document.querySelector("[aria-label=\\"Unsaved Question Set recovery\\"]")',
      'copyable specialist input after interactive panel unmount')
    const unmountedCopy = await evaluate(specialist,
      'Array.from(document.querySelectorAll("textarea[readonly]")).map(t=>t.value)')
    assert.ok(unmountedCopy.some((value: string) => value.includes('lost if Job panel unmounts')))
    assert.equal(await evaluate(specialist, buttonScript('Submit 1 answer')), false,
      'no stale specialist submission action is retained in the running Job')
  } finally {
    for (const page of pages) page.close()
    if (chrome && chrome.exitCode === null) {
      chrome.kill()
      await Promise.race([new Promise<void>(resolve => chrome!.once('exit', () => resolve())), delay(2000)])
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
    catch { /* Chrome may still be releasing its temporary browser profile. */ }
  }
})

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// Route/UI boundary proof without starting the authenticated Studio server.
const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')

test('Story workspace is the sole authoring route without a legacy Conversation alias', () => {
  const workspace = source('routes/_protected/stories/$storyId/index.tsx')
  const legacy = new URL('../src/routes/_protected/stories/$storyId/conversations.tsx', import.meta.url)
  assert.match(workspace, /createFileRoute\('\/_protected\/stories\/\$storyId\/'\)/)
  assert.match(workspace, /<StoryDesktopWorkspace/)
  assert.match(workspace, /<StoryMobileWorkspace/)
  assert.equal(existsSync(legacy), false)
})

test('opening a verified repository Story does not require preparing an execution', () => {
  const browser = source('routes/_protected/repositories/-RepositoryStoryBrowser.tsx')
  assert.doesNotMatch(browser, /prepareRepositoryJob|Create isolated job worktree|Open job/)
  assert.match(browser, /Open Story/)
})

test('Thread navigation never falls back to the legacy execution page', () => {
  const list = source('components/thread-list.tsx')
  const collections = source('components/story-collections-panel.tsx')
  assert.doesNotMatch(list, /href=\{'\/jobs\/|to="\/jobs\/\$jobId"/)
  assert.match(collections, /onOpen=\{props\.onOpen\}/)
  assert.match(list, /onOpen: \(thread: StoryThread\) => void/)
})

test('Thread fork and restart return to the Story workspace', () => {
  for (const path of ['components/thread-message-edit.tsx', 'components/thread-restart-preview.tsx']) {
    const component = source(path)
    assert.match(component, /to: '\/stories\/\$storyId'/)
    assert.doesNotMatch(component, /navigate\(\{ to: '\/jobs\/\$jobId'/)
  }
})

test('dashboard and protected viewport do not use Conversation navigation', () => {
  const dashboard = source('routes/_protected/dashboard.tsx')
  const layout = source('routes/_protected.tsx')
  assert.doesNotMatch(dashboard, /\/conversations/)
  assert.match(layout, /storyWorkspace = useLocation/)
  assert.doesNotMatch(layout, /\/conversations/)
})


test('advanced saved execution stays diagnostic without a duplicate primary Story UI', () => {
  const details = source('routes/_protected/jobs/$jobId.tsx')
  assert.match(details, /Advanced Execution Details/)
  assert.match(details, /storyThreadHref\(job\)/)
  assert.match(details, /<AuthorInteractions/)
  assert.match(details, /<CheckpointTimeline/)
  assert.match(details, /<GenerationConfiguration/)
  assert.doesNotMatch(details, /<StoryExplorer|<GitChanges|<PublishDraft/)
  assert.doesNotMatch(details, /<TabsTrigger value="story"/)
  const onboarding = source('routes/_protected/repositories/-NewStoryOnboarding.tsx')
  assert.match(onboarding, /Open Story Chat/)
})

test('prepared restart and fork can start within the same Thread instead of a Job wizard', () => {
  const status = source('components/thread-run-attention.tsx')
  assert.match(status, /job.status === 'prepared' && \(job.task && job.contract/)
  assert.match(status, /Start prepared restart/)
  assert.match(status, /startConfiguredGeneration/)
})

test('retired Job-only explorer, diff and publish adapters contain no live implementation', () => {
  for (const path of ['-StoryExplorer.tsx', '-GitChanges.tsx', '-PublishDraft.tsx']) {
    const retired = source('routes/_protected/jobs/' + path)
    assert.match(retired, /^\/\/ Retired:/)
    assert.doesNotMatch(retired, /export function|import\s+|createServerFn/)
  }
})

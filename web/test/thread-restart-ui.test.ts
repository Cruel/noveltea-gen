import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (path: string) => readFileSync(new URL('../src/components/' + path, import.meta.url), 'utf8')

test('restart dialog has a compact request, contextual scope help, and one primary action', () => {
  const preview = source('thread-restart-preview.tsx')
  const wrapper = source('thread-restart-control.tsx')
  assert.match(preview, /font-semibold uppercase tracking-wide text-muted-foreground/)
  assert.match(preview, /flex min-w-0 items-center justify-between gap-2/)
  assert.match(preview, /mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words font-medium/)
  assert.ok(preview.indexOf('Scope: </span>') < preview.indexOf('{data.task}'),
    'Request label and scope share a header row above the request text')
  assert.doesNotMatch(preview, /truncate font-medium" title={data\.task}/)
  assert.match(preview, /Scope: <\/span>/)
  assert.match(preview, /data\.scopeKind === 'full-story' \? 'Entire Story'/)
  assert.match(preview, /<HelpTip label="About restart scope">/)
  assert.match(preview, /Restart repeats this request and its original scope/)
  assert.match(preview, /\{newer && <fieldset/)
  assert.match(preview, /const effectiveMode = newer \? mode : 'original'/)
  assert.match(preview, /checked={mode === 'original'}/)
  assert.match(preview, /checked={mode === 'newer'}/)
  assert.match(preview, /<span>Delete Old Thread<\/span>/)
  assert.match(preview, /<HelpTip label="About deleting the old Thread">/)
  assert.match(preview, /By default, the original Thread stays in the list/)
  assert.match(preview, /preparedCleanup \? 'Retry cleanup' : 'Restart'/)
  assert.doesNotMatch(preview, /Check for updates|Refresh upstream|No newer version available/)
  assert.doesNotMatch(preview, /<details|Advanced: remove old Thread|Create restart Thread/)
  assert.match(wrapper, /<DialogTitle>Restart Thread<\/DialogTitle>/)
  assert.doesNotMatch(preview, /onClose|>Close<\/Button>/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPiStatusTool, parsePiWorkStatus, withPiStatusReporter } from '../src/pi-work-status'

test('status reports accept short prose and canonical proposed Markdown paths only', () => {
  assert.deepEqual(parsePiWorkStatus({
    summary: 'Working on the opening scene',
    proposedPaths: ['events/opening.md', 'events/opening.md'],
  }), { summary: 'Working on the opening scene', proposedPaths: ['events/opening.md'] })
  for (const input of [
    { summary: '' }, { summary: 'a'.repeat(241) },
    { summary: 'An untrusted newline\nclaims validation' },
    { summary: 'Editing', proposedPaths: ['../secrets.md'] },
    { summary: 'Editing', proposedPaths: ['/etc/passwd'] },
    { summary: 'Editing', proposedPaths: ['.story-inbox/data.md'] },
    { summary: 'Editing', proposedPaths: ['events/x.txt'] },
    { summary: 'Editing', proposedPaths: ['events/secret\\private.md'] },
    { summary: 'Editing', proposedPaths: Array.from({ length: 13 }, () => 'events/x.md') },
  ]) assert.throws(() => parsePiWorkStatus(input))
})

test('Pi report tool emits only to its own async runner and claims no verification', async () => {
  const tool = createPiStatusTool()
  const calls: string[] = []
  const invoke = async (summary: string) => tool.execute('call-' + summary,
    { summary, proposedPaths: ['events/example.md'] }, undefined as never,
    undefined as never, undefined as never)
  const [left, right] = await Promise.all([
    withPiStatusReporter(async report => {
      await Promise.resolve()
      calls.push('first:' + report.summary)
    }, () => invoke('first')),
    withPiStatusReporter(async report => {
      await Promise.resolve()
      calls.push('second:' + report.summary)
    }, () => invoke('second')),
  ])
  assert.deepEqual(calls.sort(), ['first:first', 'second:second'])
  assert.match(JSON.stringify(left), /not verified Story evidence/)
  assert.match(JSON.stringify(right), /not verified Story evidence/)
  const noChannel = await invoke('outside')
  assert.match(JSON.stringify(noChannel), /No live Studio status channel/)
})

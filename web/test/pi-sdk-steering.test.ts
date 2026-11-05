import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgentSession, ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { removeTestTree } from '../../test/helpers'

const transcriptText = (context: TranscriptContext): string[] =>
  context.messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content :
      message.content.filter(block => block.type === 'text').map(block => block.text).join(''))

test('real Pi SDK delivers steer after a running tool and followUp after the current task', {
  timeout: 30000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-real-pi-sdk-'))
  const faux = fauxProvider({ provider: 'noveltea-steering-test' })
  let releaseTool: (() => void) | undefined
  let toolStarted: (() => void) | undefined
  const toolReady = new Promise<void>(resolve => { toolStarted = resolve })
  const toolGate = new Promise<void>(resolve => { releaseTool = resolve })
  let completedTool = false
  const seen: string[][] = []
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
  try {
    const runtime = await ModelRuntime.create({
      refreshOnCreate: false, allowModelNetwork: false,
      authPath: join(root, 'auth.json'), modelsPath: null,
    })
    runtime.registerNativeProvider(faux.provider)
    const response = (context: TranscriptContext, ordinal: number) => {
      seen.push(transcriptText(context))
      if (ordinal === 0) return fauxAssistantMessage(
        fauxToolCall('gate', {}, { id: 'gate-1' }), { stopReason: 'toolUse' })
      const inputs = transcriptText(context)
      if (ordinal === 1) return fauxAssistantMessage(inputs.includes('AUTHOR_STEER_86')
        ? 'Steering changed this response' : 'Missing steering')
      return fauxAssistantMessage(inputs.includes('AUTHOR_FOLLOWUP_86')
        ? 'Follow-up changed this response' : 'Missing follow-up')
    }
    let ordinal = 0
    faux.setResponses([
      context => response(context, ordinal++),
      context => response(context, ordinal++),
      context => response(context, ordinal++),
    ])
    const created = await createAgentSession({
      cwd: root, agentDir: join(root, 'agent'),
      modelRuntime: runtime, model: faux.getModel() as unknown as NonNullable<Parameters<typeof createAgentSession>[0]>['model'],
      noTools: 'all', tools: ['gate'],
      customTools: [{
        name: 'gate', label: 'Hold a tool call', description: 'Deterministic test tool',
        parameters: { type: 'object', properties: {}, additionalProperties: false } as ToolDefinition['parameters'],
        async execute() {
          toolStarted!()
          await toolGate
          completedTool = true
          return { content: [{ type: 'text' as const, text: 'completed safely' }], details: undefined }
        },
      }],
    })
    session = created.session
    const running = session.prompt('Original specialist task')
    await toolReady
    assert.equal(completedTool, false)
    assert.equal(session.isStreaming, true)
    assert.equal(await session.steer('AUTHOR_STEER_86'), 'queued')
    assert.equal(await session.followUp('AUTHOR_FOLLOWUP_86'), 'queued')
    assert.equal(seen.length, 1, 'no model request may start before active tool completes')
    releaseTool!()
    await running
    await session.waitForIdle()
    assert.equal(completedTool, true)
    assert.equal(seen.length, 3, 'original, steered continuation and deferred follow-up are separate model turns')
    assert.ok(seen[1]?.includes('AUTHOR_STEER_86'), 'steer must be in the first post-tool prompt')
    assert.ok(!seen[1]?.includes('AUTHOR_FOLLOWUP_86'), 'followUp must wait until current run settles')
    assert.ok(seen[2]?.includes('AUTHOR_FOLLOWUP_86'), 'followUp must enter the later turn')
    const replies = session.messages.filter(message => message.role === 'assistant')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    assert.ok(replies.includes('Steering changed this response'),
      'the actual Pi model continuation must react to the steered author constraint')
    assert.ok(replies.includes('Follow-up changed this response'),
      'the actual Pi follow-up turn must react to its separate queued input')
    assert.equal(session.isStreaming, false)
  } finally {
    releaseTool?.()
    session?.dispose()
    removeTestTree(root)
  }
})

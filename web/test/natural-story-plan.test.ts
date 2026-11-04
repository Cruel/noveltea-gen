import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGenerationContract } from '../../src/generation'
import { interpretNaturalStoryPrompt } from '../src/lib/natural-story-plan'

test('a natural creative brief creates a canonical inspectable full-Story plan without invented limits', () => {
  const brief = 'Write a mystery visual novel on a stranded train. The player may trust or challenge the conductor.'
  const plan = interpretNaturalStoryPrompt(brief)
  assert.equal(plan.task, brief)
  assert.deepEqual(plan.contract, parseGenerationContract(plan.contract))
  assert.deepEqual(plan.contract.scope, { kind: 'full-story', depth: 'composition',
    targets: [], branches: [] })
  assert.match(plan.contract.constraints.join(' '), /trust or challenge the conductor/)
  assert.deepEqual(plan.contract.envelope.hardLimits, [])
  assert.deepEqual(plan.contract.envelope.preferences, [])
  assert.deepEqual(plan.stages.map(stage => stage.id),
    ['foundation', 'architecture', 'foundations', 'event', 'interactive', 'composition', 'review'])
  assert.deepEqual(plan.stages.map(stage => stage.dependsOn),
    [[], ['foundation'], ['architecture'], ['foundations'], ['event'], ['interactive'], ['composition']])
  assert.equal(plan.reviewRequired, false)
  assert.equal(plan.clarification, null)
  assert.equal(interpretNaturalStoryPrompt(brief).digest, plan.digest)
})

test('materially ambiguous or outline-only prompts require author plan confirmation', () => {
  assert.equal(interpretNaturalStoryPrompt(
    'Write a story where the player can either protect or confront a witness.').reviewRequired, false)
  for (const brief of ['Brainstorm ideas for a mystery', 'Could this be an interesting novel?',
    'Write a mystery, or perhaps a romance instead', 'Only plan the plot outline']) {
    const plan = interpretNaturalStoryPrompt(brief)
    assert.equal(plan.reviewRequired, true, brief)
    assert.ok(plan.clarification)
    assert.equal(plan.contract.scope.kind, 'full-story')
  }
})

test('advanced edits preserve full scope and cannot smuggle arbitrary write permissions', () => {
  const brief = 'Write a branching fantasy tale.'
  const edited = interpretNaturalStoryPrompt(brief, {
    presentation: 'Dialogue-led visual novel', hardLimits: ['Under 20 scenes'],
    preferences: ['Quiet atmosphere'], constraints: ['No gratuitous violence'],
  })
  assert.deepEqual(edited.contract.scope.targets, [])
  assert.deepEqual(edited.contract.envelope.hardLimits, ['Under 20 scenes'])
  assert.deepEqual(edited.contract.constraints, ['No gratuitous violence'])
  assert.notEqual(edited.digest, interpretNaturalStoryPrompt(brief).digest)
  assert.throws(() => interpretNaturalStoryPrompt(brief, { scope: { kind: 'partial' } } as never),
    /Unknown plan edits/)
  assert.throws(() => interpretNaturalStoryPrompt('a'.repeat(4001)), /1–4000/)
  assert.throws(() => interpretNaturalStoryPrompt('A story\u0000'), /printable/)
  assert.throws(() => interpretNaturalStoryPrompt(brief, { hardLimits: ['x'.repeat(1001)] }),
    /Hard limits/)
})

test('long briefs remain complete and bounded in the contract without silent truncation', () => {
  const brief = 'A journey of discovery. '.repeat(160)
  const plan = interpretNaturalStoryPrompt(brief)
  assert.equal(plan.contract.constraints.map(text => text.replace(/^Honor this author brief: /, '')).join(''), brief.trim())
  assert.ok(plan.contract.constraints.every(text => text.length <= 1000))
})

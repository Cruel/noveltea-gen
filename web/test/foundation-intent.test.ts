import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foundationOnlyObjective } from '../src/lib/foundation-intent'

test('only author-bounded foundation requests stop before full Story generation', () => {
  for (const task of [
    'Please write only a creative direction',
    'Just give me the premise, stop there',
    'Draft a story foundation only',
    'A concept pitch and nothing more',
    'Generate just the creative direction for a mystery game',
    'Only the premise for a visual novel, please',
  ]) assert.equal(foundationOnlyObjective(task), true, task)
  for (const task of [
    'Make me a mystery game',
    'Make me a mystery game using only a premise as inspiration',
    'Write a complete visual novel',
    'Create a mystery story',
    'Give me a premise and then write a complete story',
  ]) assert.equal(foundationOnlyObjective(task), false, task)
})

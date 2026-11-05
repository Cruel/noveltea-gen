import assert from 'node:assert/strict'
import { test } from 'node:test'
import { specialistAuthorInstruction } from '../src/specialist-author-instruction'

test('controller-pinned corrections become bounded specialist instructions, not write grants', () => {
  const correction = 'Original brief\n\nCorrective guidance for this branch:\nMake the witness truthful'
  const instruction = specialistAuthorInstruction(correction)
  assert.match(instruction, /CURRENT AUTHOR INSTRUCTION/)
  assert.match(instruction, /Make the witness truthful/)
  assert.match(instruction, /not additional write authority/)
  assert.match(instruction, /protected retcon/)
  assert.equal(specialistAuthorInstruction(), '')
  assert.throws(() => specialistAuthorInstruction('x'.repeat(4001)), /bounded/)
  assert.throws(() => specialistAuthorInstruction('unclean\u0000message'), /printable/)
})

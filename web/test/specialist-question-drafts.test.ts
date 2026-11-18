import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JobStartResult } from '../../src/job'
import type { SpecialistChoiceReceipt } from '../../src/specialist-choice'
import { readSpecialistQuestionDraft, saveSpecialistQuestionDraft,
  specialistQuestionSet } from '../src/lib/specialist-question-drafts.server'

test('single-question draft is durable, deduplicated, identity-bound and CAS fenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-question-draft-'))
  try {
    const job = { stateDir: root } as JobStartResult
    const owner = 'alice'
    const choice = {
      id: randomUUID(), proposalSha256: 'a'.repeat(64), delegationAllowed: true,
      question: { kind: 'alternatives' as const,
        question: 'How should the witness react to the revelation?',
        options: [{ id: 'trust', title: 'Trust' }, { id: 'doubt', title: 'Doubt' }] },
    } as SpecialistChoiceReceipt
    assert.deepEqual(await readSpecialistQuestionDraft(job, choice, owner),
      { revision: 1, drafts: {} })
    const draft = { answer: { selection: '__custom__', selectedIds: [],
      multiCustom: false, customAnswer: 'The witness should be wary of the new evidence.',
      note: 'Do not rewrite the earlier scene.' } }
    assert.equal(specialistQuestionSet(choice).questions.length, 1)
    const first = await saveSpecialistQuestionDraft(job, choice, owner, 1, draft)
    assert.equal(first.revision, 2)
    assert.deepEqual(first.drafts, draft)
    assert.deepEqual(await saveSpecialistQuestionDraft(job, choice, owner, 2, draft),
      first, 'an unchanged autosave must not advance the revision')
    assert.deepEqual(await readSpecialistQuestionDraft(job, choice, owner), first,
      'a fresh process with the same Job state restores the exact typed draft')
    await assert.rejects(() => saveSpecialistQuestionDraft(job, choice, owner, 1, {}),
      /another browser/, 'a stale tab cannot silently replace newer data')
    await assert.rejects(() => readSpecialistQuestionDraft(job, choice, 'bob'),
      /not bound/, 'another account cannot load the saved author draft')
    await assert.rejects(() => readSpecialistQuestionDraft(job,
      { ...choice, proposalSha256: 'b'.repeat(64) }, owner), /not bound/)
    await assert.rejects(() => saveSpecialistQuestionDraft(job, choice, owner, 2,
      { answer: { ...draft.answer, selection: 'invented' } }), /Invalid/)
    await assert.rejects(() => saveSpecialistQuestionDraft(job,
      { ...choice, delegationAllowed: undefined }, owner, 2,
      { answer: { ...draft.answer, selection: '__delegate__' } }), /Invalid/)
    const second = await saveSpecialistQuestionDraft(job, choice, owner, 2, {
      answer: { ...draft.answer, selection: 'trust' },
    })
    assert.equal(second.revision, 3)
    assert.equal(second.drafts.answer?.note, draft.answer.note)
    const disk = JSON.parse(await readFile(join(root, 'author-question-drafts',
      choice.id + '.json'), 'utf8'))
    assert.equal(disk.owner, owner)
    assert.equal(disk.proposalSha256, choice.proposalSha256)
    assert.deepEqual(await readdir(root), ['author-question-drafts'],
      'autosaving a question must not mutate the Story or original specialist receipt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a symlinked draft directory cannot redirect autosave into canonical Story paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-question-draft-'))
  try {
    const job = { stateDir: root } as JobStartResult
    const choice = { id: randomUUID(), proposalSha256: 'd'.repeat(64),
      question: { kind: 'free-text' as const,
        question: 'How should the witness react?' },
    } as SpecialistChoiceReceipt
    await symlink(root, join(root, 'author-question-drafts'))
    await assert.rejects(() => readSpecialistQuestionDraft(job, choice, 'alice'), /Unsafe/)
    await assert.rejects(() => saveSpecialistQuestionDraft(job, choice, 'alice', 1, {}), /Unsafe/)
    assert.deepEqual(await readdir(root), ['author-question-drafts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mixed multi-choice drafts remain unaccepted and never manufacture a delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-question-draft-'))
  try {
    const job = { stateDir: root } as JobStartResult
    const choice = { id: randomUUID(), proposalSha256: 'c'.repeat(64),
      question: { kind: 'multiple-choice' as const,
        question: 'Which two clues should the writer keep?',
        options: [{ id: 'archive', title: 'Archive' }, { id: 'letter', title: 'Letter' }] },
    } as SpecialistChoiceReceipt
    const draft = { answer: { selection: '', selectedIds: ['archive'],
      multiCustom: true, customAnswer: 'Also retain the broken clock.', note: '' } }
    const saved = await saveSpecialistQuestionDraft(job, choice, 'alice', 1, draft)
    assert.deepEqual(saved.drafts, draft)
    assert.equal(saved.revision, 2)
    await assert.rejects(() => saveSpecialistQuestionDraft(job, choice, 'alice', 2,
      { answer: { ...draft.answer, selection: '__delegate__' } }), /Invalid/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
